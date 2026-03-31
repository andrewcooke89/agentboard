/**
 * draftSwarm.ts - Speculative draft swarms for parallel API calls to cheap models
 *
 * Activation conditions:
 * - model_routing.enabled = true
 * - swarm.enabled = true
 * - complexity in trigger_complexity list
 * - tier >= min_tier
 */

import { logger } from './logger'
import type { ComplexityLevel } from './complexityClassifier'

// CRIT-002: Simple mutex for atomic counter operations
class AsyncMutex {
  private locked = false
  private queue: Array<() => void> = []

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return
    }
    return new Promise<void>(resolve => {
      this.queue.push(resolve)
    })
  }

  release(): void {
    const next = this.queue.shift()
    if (next) {
      next()
    } else {
      this.locked = false
    }
  }
}

const stateMutex = new AsyncMutex()

export interface DraftSwarmConfig {
  enabled: boolean
  models: string[]
  trigger_complexity: ComplexityLevel[]
  min_tier: number
  max_concurrent?: number
  timeout_ms?: number
  rate_limit_per_minute?: number
}

export interface DraftResult {
  model: string
  success: boolean
  content: string | null
  error?: string
  latency_ms: number
  tokens_used?: number
}

interface DraftSwarmState {
  activeRequests: number
  lastRequestTime: number
  minuteRequestCount: number
  minuteStartTime: number
}

const state: DraftSwarmState = {
  activeRequests: 0,
  lastRequestTime: 0,
  minuteRequestCount: 0,
  minuteStartTime: Date.now(),
}

const DEFAULT_MAX_CONCURRENT = 3
const DEFAULT_TIMEOUT_MS = 60000
const DEFAULT_RATE_LIMIT = 30

/**
 * Check if draft swarm should be activated for given parameters.
 */
export function shouldActivateDraftSwarm(
  config: DraftSwarmConfig | null | undefined,
  complexity: ComplexityLevel,
  tier: number
): boolean {
  if (!config?.enabled) {
    return false
  }

  if (!config.trigger_complexity.includes(complexity)) {
    return false
  }

  if (tier < config.min_tier) {
    return false
  }

  return true
}

/**
 * Generate drafts by firing parallel API calls to cheap models.
 */
export async function generateDrafts(
  prompt: string,
  config: DraftSwarmConfig,
  context?: {
    run_dir?: string
    project_path?: string
  }
): Promise<DraftResult[]> {
  if (!config.enabled || config.models.length === 0) {
    return []
  }

  const maxConcurrent = config.max_concurrent ?? DEFAULT_MAX_CONCURRENT
  const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS
  const rateLimit = config.rate_limit_per_minute ?? DEFAULT_RATE_LIMIT

  // Check rate limiting (CRIT-002: now async)
  if (!(await checkRateLimit(rateLimit))) {
    logger.warn('draft_swarm_rate_limited', {
      requests_this_minute: state.minuteRequestCount,
      limit: rateLimit,
    })
    return []
  }

  logger.info('draft_swarm_starting', {
    models: config.models,
    max_concurrent: maxConcurrent,
    complexity_trigger: config.trigger_complexity,
  })

  const results: DraftResult[] = []
  const models = config.models.slice(0, maxConcurrent)

  // Fire parallel requests
  const promises = models.map(model => generateSingleDraft(model, prompt, timeoutMs, context))
  const settled = await Promise.allSettled(promises)

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]
    if (result.status === 'fulfilled') {
      results.push(result.value)
    } else {
      results.push({
        model: models[i],
        success: false,
        content: null,
        error: result.reason?.message ?? 'Unknown error',
        latency_ms: 0,
      })
    }
  }

  logger.info('draft_swarm_completed', {
    total: results.length,
    successful: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
  })

  return results
}

/**
 * Generate a single draft from one model.
 * CRIT-002: Uses mutex for atomic state modifications.
 */
async function generateSingleDraft(
  model: string,
  prompt: string,
  timeoutMs: number,
  _context?: {
    run_dir?: string
    project_path?: string
  }
): Promise<DraftResult> {
  const startTime = Date.now()

  // CRIT-002: Atomic state update
  await stateMutex.acquire()
  try {
    state.activeRequests++
    state.minuteRequestCount++
    state.lastRequestTime = startTime
  } finally {
    stateMutex.release()
  }

  try {
    // Placeholder for actual model API call
    // In production, this would call the appropriate model API
    const content = await mockModelCall(model, prompt, timeoutMs)

    const latencyMs = Date.now() - startTime

    return {
      model,
      success: true,
      content,
      latency_ms: latencyMs,
      tokens_used: estimateTokens(prompt, content ?? ''),
    }
  } catch (err) {
    const error = err as Error
    const latencyMs = Date.now() - startTime

    return {
      model,
      success: false,
      content: null,
      error: error.message,
      latency_ms: latencyMs,
    }
  } finally {
    // CRIT-002: Atomic state update
    await stateMutex.acquire()
    try {
      state.activeRequests--
    } finally {
      stateMutex.release()
    }
  }
}

/**
 * Mock model call for testing.
 * LOW-004: Guarded with NODE_ENV check - should only run in test environment.
 * Replace with actual LiteLLM/gemini-offload calls in production.
 *
 * MED-003: Properly enforces timeoutMs using Promise.race.
 */
async function mockModelCall(model: string, prompt: string, timeoutMs: number): Promise<string> {
  // LOW-004: Only allow mock in test environment
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      'mockModelCall called in non-test environment. ' +
      'Integrate with actual model API (LiteLLM/gemini-offload) for production.'
    )
  }

  // Simulate API latency (500-1500ms)
  const simulatedDelay = 500 + Math.random() * 1000

  // MED-003: Use Promise.race to enforce timeout
  const workPromise = new Promise<string>(resolve => {
    setTimeout(() => {
      // Generate mock draft content
      resolve(`# Draft from ${model}\n\n` +
        `Based on the prompt:\n${prompt.slice(0, 200)}...\n\n` +
        `## Implementation\n\n` +
        `[Draft implementation content would appear here]\n\n` +
        `Generated by ${model} at ${new Date().toISOString()}`)
    }, simulatedDelay)
  })

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Request timed out')), timeoutMs)
  })

  return Promise.race([workPromise, timeoutPromise])
}

/**
 * Store drafts as reference files for implementor.
 */
export async function storeDrafts(
  drafts: DraftResult[],
  runDir: string,
  stepName: string
): Promise<string[]> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const storedPaths: string[] = []

  const draftsDir = path.join(runDir, 'drafts', stepName)
  await fs.mkdir(draftsDir, { recursive: true })

  for (const draft of drafts) {
    if (!draft.success || !draft.content) continue

    const filename = `draft-${draft.model}-${Date.now()}.md`
    const filePath = path.join(draftsDir, filename)

    await fs.writeFile(filePath, draft.content, 'utf-8')
    storedPaths.push(filePath)

    logger.info('draft_stored', {
      model: draft.model,
      path: filePath,
      latency_ms: draft.latency_ms,
    })
  }

  return storedPaths
}

/**
 * Get best draft based on quality heuristics.
 */
export function getBestDraft(drafts: DraftResult[]): DraftResult | null {
  const successful = drafts.filter(d => d.success && d.content)

  if (successful.length === 0) {
    return null
  }

  // Simple heuristic: prefer longer content, faster response
  successful.sort((a, b) => {
    // Prioritize completeness (content length)
    const aLen = a.content?.length ?? 0
    const bLen = b.content?.length ?? 0
    if (aLen !== bLen) return bLen - aLen

    // Then speed
    return a.latency_ms - b.latency_ms
  })

  return successful[0]
}

/**
 * Check rate limit.
 * CRIT-002: Uses mutex for atomic state access.
 */
async function checkRateLimit(limit: number): Promise<boolean> {
  const now = Date.now()
  const minuteMs = 60000

  await stateMutex.acquire()
  try {
    // Reset counter if minute has passed
    if (now - state.minuteStartTime >= minuteMs) {
      state.minuteRequestCount = 0
      state.minuteStartTime = now
    }

    return state.minuteRequestCount < limit
  } finally {
    stateMutex.release()
  }
}

/**
 * Estimate token count for logging.
 */
function estimateTokens(prompt: string, response: string): number {
  // Rough estimate: ~4 chars per token
  return Math.ceil((prompt.length + response.length) / 4)
}

/**
 * Get current swarm state for monitoring.
 * CRIT-002: Uses mutex for atomic state read.
 */
export async function getSwarmState(): Promise<{
  active_requests: number
  requests_this_minute: number
  last_request_ago_ms: number
}> {
  await stateMutex.acquire()
  try {
    return {
      active_requests: state.activeRequests,
      requests_this_minute: state.minuteRequestCount,
      last_request_ago_ms: state.lastRequestTime ? Date.now() - state.lastRequestTime : 0,
    }
  } finally {
    stateMutex.release()
  }
}

/**
 * Create default draft swarm config with sensible defaults.
 *
 * Returns a configuration object with:
 * - enabled: false (must be explicitly enabled)
 * - models: ['glm', 'gemini-flash'] (cheap models for drafts)
 * - trigger_complexity: ['simple', 'medium']
 * - min_tier: 2
 * - max_concurrent: 3
 * - timeout_ms: 60000
 * - rate_limit_per_minute: 30
 *
 * @returns Default DraftSwarmConfig object
 *
 * @example
 * ```ts
 * const config = createDefaultDraftSwarmConfig();
 * config.enabled = true; // Enable draft swarms
 * const shouldActivate = shouldActivateDraftSwarm(config, 'simple', 2);
 * ```
 */
export function createDefaultDraftSwarmConfig(): DraftSwarmConfig {
  return {
    enabled: false,
    models: ['glm', 'gemini-flash'],
    trigger_complexity: ['simple', 'medium'],
    min_tier: 2,
    max_concurrent: 3,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    rate_limit_per_minute: DEFAULT_RATE_LIMIT,
  }
}
