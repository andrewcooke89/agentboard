/**
 * litellmProxy.ts - Manages LiteLLM proxy for multi-model operation
 *
 * Starts on pipeline start, provides health check endpoint,
 * and handles graceful shutdown on pipeline complete.
 */

import { spawn, ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { logger } from './logger'

export interface LiteLLMConfig {
  base_url: string
  config_path: string
  enabled: boolean
  port?: number
  startup_timeout_ms?: number
}

interface LiteLLMProxyState {
  process: ChildProcess | null
  config: LiteLLMConfig | null
  healthy: boolean
  startedAt: number | null
}

const state: LiteLLMProxyState = {
  process: null,
  config: null,
  healthy: false,
  startedAt: null,
}

const DEFAULT_PORT = 4000
const DEFAULT_STARTUP_TIMEOUT_MS = 30000
const HEALTH_CHECK_INTERVAL_MS = 5000
const SHUTDOWN_TIMEOUT_MS = 10000

let healthCheckInterval: ReturnType<typeof setInterval> | null = null

/**
 * Start the LiteLLM proxy.
 * Returns true if started successfully or already running.
 */
export async function startLiteLLMProxy(config: LiteLLMConfig): Promise<boolean> {
  if (!config.enabled) {
    logger.info('litellm_proxy_disabled', { reason: 'Not enabled in config' })
    return false
  }

  // Check if already running with same config
  if (state.process && state.config?.config_path === config.config_path) {
    logger.info('litellm_proxy_already_running', { config_path: config.config_path })
    return state.healthy
  }

  // Stop existing process if different config
  if (state.process) {
    await stopLiteLLMProxy()
  }

  // MED-007: Validate config_path for safe characters only
  const configPath = config.config_path
  if (!configPath || !/^[a-zA-Z0-9_\-./]+$/.test(configPath)) {
    logger.error('litellm_proxy_invalid_config_path', {
      config_path: configPath ? '[INVALID_PATH]' : '[EMPTY]',
      reason: 'Path contains unsafe characters',
    })
    return false
  }

  // Validate config file exists
  if (!existsSync(configPath)) {
    // MED-007: Escape path in error log
    logger.error('litellm_proxy_config_missing', { config_path: '[REDACTED_PATH]' })
    return false
  }

  const port = config.port ?? DEFAULT_PORT
  const startupTimeout = config.startup_timeout_ms ?? DEFAULT_STARTUP_TIMEOUT_MS

  // MED-007: Log config_path as [CONFIG_SET] to avoid path injection in logs
  logger.info('litellm_proxy_starting', {
    config_path: '[CONFIG_SET]',
    port,
    base_url: config.base_url,
  })

  try {
    // Spawn LiteLLM proxy process
    const proc = spawn('litellm', [
      '--config', config.config_path,
      '--port', String(port),
      '--detailed_debug',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })

    state.process = proc
    state.config = config
    state.healthy = false
    state.startedAt = Date.now()

    // Handle process output
    proc.stdout?.on('data', (data: Buffer) => {
      const output = data.toString().trim()
      if (output) {
        logger.debug('litellm_proxy_stdout', { output })
      }
    })

    proc.stderr?.on('data', (data: Buffer) => {
      const output = data.toString().trim()
      if (output.includes('Uvicorn running') || output.includes('Application startup complete')) {
        state.healthy = true
        logger.info('litellm_proxy_healthy', { port })
      } else if (output) {
        logger.debug('litellm_proxy_stderr', { output })
      }
    })

    proc.on('error', (err) => {
      logger.error('litellm_proxy_error', { error: err.message })
      state.healthy = false
      // HIGH-002: Ensure process is killed on error
      if (state.process === proc) {
        try {
          proc.kill('SIGKILL')
        } catch {
          // Ignore kill errors
        }
        state.process = null
      }
    })

    proc.on('exit', (code, signal) => {
      logger.info('litellm_proxy_exit', { code, signal })
      state.healthy = false
      if (state.process === proc) {
        state.process = null
      }
    })

    // Wait for health check to pass
    const startTime = Date.now()
    while (!state.healthy && Date.now() - startTime < startupTimeout) {
      await sleep(500)
      // Try manual health check
      const healthy = await healthCheckLiteLLM(config.base_url)
      if (healthy) {
        state.healthy = true
        break
      }
    }

    if (!state.healthy) {
      logger.error('litellm_proxy_startup_timeout', { timeout_ms: startupTimeout })
      // HIGH-002: Ensure process is killed on startup failure
      if (state.process === proc) {
        try {
          proc.kill('SIGKILL')
        } catch {
          // Ignore kill errors
        }
        state.process = null
      }
      state.healthy = false
      return false
    }

    // Start periodic health checks
    startHealthChecks(config.base_url)

    // MED-007: Escape path in logs
    logger.info('litellm_proxy_started', { port, config_path: '[CONFIG_SET]' })
    return true

  } catch (err) {
    const error = err as Error
    logger.error('litellm_proxy_spawn_failed', { error: error.message })
    // HIGH-002: Ensure process is killed on spawn failure
    if (state.process) {
      try {
        state.process.kill('SIGKILL')
      } catch {
        // Ignore kill errors
      }
    }
    state.process = null
    state.healthy = false
    return false
  }
}

/**
 * Stop the LiteLLM proxy gracefully.
 */
export async function stopLiteLLMProxy(): Promise<void> {
  // Stop health checks
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval)
    healthCheckInterval = null
  }

  if (!state.process) {
    return
  }

  logger.info('litellm_proxy_stopping', {})

  return new Promise((resolve) => {
    const proc = state.process!
    let resolved = false

    const cleanup = () => {
      if (!resolved) {
        resolved = true
        state.process = null
        state.healthy = false
        state.config = null
        state.startedAt = null
        resolve()
      }
    }

    // Set hard timeout
    const timeout = setTimeout(() => {
      logger.warn('litellm_proxy_force_kill', {})
      proc.kill('SIGKILL')
      cleanup()
    }, SHUTDOWN_TIMEOUT_MS)

    proc.on('exit', () => {
      clearTimeout(timeout)
      cleanup()
    })

    // Send SIGTERM for graceful shutdown
    proc.kill('SIGTERM')
  })
}

/**
 * Check if LiteLLM proxy is healthy.
 */
export async function healthCheckLiteLLM(baseUrl?: string): Promise<boolean> {
  const url = baseUrl ?? state.config?.base_url ?? `http://localhost:${DEFAULT_PORT}`

  try {
    const response = await fetch(`${url}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Get current proxy status.
 */
export function getProxyStatus(): {
  running: boolean
  healthy: boolean
  uptime_ms: number | null
  config_path: string | null
} {
  return {
    running: state.process !== null,
    healthy: state.healthy,
    uptime_ms: state.startedAt ? Date.now() - state.startedAt : null,
    config_path: state.config?.config_path ?? null,
  }
}

/**
 * Start periodic health checks.
 */
function startHealthChecks(baseUrl: string): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval)
  }

  healthCheckInterval = setInterval(async () => {
    const healthy = await healthCheckLiteLLM(baseUrl)
    if (state.healthy !== healthy) {
      state.healthy = healthy
      logger.info('litellm_proxy_health_changed', { healthy })
    }
  }, HEALTH_CHECK_INTERVAL_MS)
}

/**
 * Sleep helper.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Check if LiteLLM is available (binary exists).
 */
export async function isLiteLLMAvailable(): Promise<boolean> {
  try {
    const result = await new Promise<boolean>((resolve) => {
      const proc = spawn('litellm', ['--version'], { stdio: 'ignore' })
      proc.on('error', () => resolve(false))
      proc.on('exit', (code) => resolve(code === 0))
    })
    return result
  } catch {
    return false
  }
}
