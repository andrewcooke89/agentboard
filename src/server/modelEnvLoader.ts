// modelEnvLoader.ts - Load and cache model environment configurations
// Phase 25: Added model routing support
import fs from 'node:fs'
import type { ComplexityLevel } from './complexityClassifier'

export interface ModelEnvConfig {
  description: string
  env: Record<string, string>
}

interface ModelEnvsFile {
  [modelId: string]: ModelEnvConfig
}

// Phase 25: Model routing configuration
export interface ModelRoutingConfig {
  enabled: boolean
  default_model: string
  complexity_routing: {
    simple: string
    medium: string
    complex: string
    atomic: string
  }
  escalation?: Array<{
    from: string
    to: string
    condition: string
  }>
}

let cachedConfigs: ModelEnvsFile = {
  claude: {
    description: 'Anthropic Opus (default)',
    env: {}
  }
}

let cachedRoutingConfig: ModelRoutingConfig | null = null

let configPath: string | null = null
let watcherActive = false

/**
 * Load model environment configurations from JSON file.
 * Falls back to default 'claude' config if file is missing or invalid.
 */
export function loadModelEnvs(path: string): void {
  configPath = path

  try {
    const content = fs.readFileSync(path, 'utf-8')
    const parsed = JSON.parse(content) as ModelEnvsFile

    // Validate structure
    for (const [modelId, config] of Object.entries(parsed)) {
      if (!config.description || typeof config.description !== 'string') {
        console.warn(`[modelEnvLoader] Invalid description for model '${modelId}', skipping`)
        continue
      }
      if (!config.env || typeof config.env !== 'object') {
        console.warn(`[modelEnvLoader] Invalid env for model '${modelId}', skipping`)
        continue
      }
    }

    cachedConfigs = parsed
    console.log(`[modelEnvLoader] Loaded ${Object.keys(cachedConfigs).length} model configs from ${path}`)

    // Set up file watcher for hot-reload
    if (!watcherActive) {
      setupWatcher()
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(`[modelEnvLoader] Config file not found at ${path}, using default 'claude' config`)
    } else {
      console.error(`[modelEnvLoader] Failed to load ${path}:`, err)
      console.log('[modelEnvLoader] Using default "claude" config')
    }
  }
}

/**
 * Set up file watcher for hot-reload when config file changes.
 */
function setupWatcher(): void {
  if (!configPath || watcherActive) return

  try {
    fs.watch(configPath, (eventType) => {
      if (eventType === 'change') {
        console.log(`[modelEnvLoader] Config file changed, reloading...`)
        if (configPath) {
          loadModelEnvs(configPath)
        }
      }
    })
    watcherActive = true
    console.log(`[modelEnvLoader] Watching ${configPath} for changes`)
  } catch (err) {
    console.warn(`[modelEnvLoader] Failed to set up file watcher:`, err)
  }
}

/**
 * Get environment variables for a specific model.
 * Returns empty object for unknown models or 'claude' default.
 */
export function getEnvForModel(modelId: string): Record<string, string> {
  const config = cachedConfigs[modelId]
  if (!config) {
    if (modelId !== 'claude') {
      console.warn(`[modelEnvLoader] Unknown model '${modelId}', using default (no env vars)`)
    }
    return {}
  }
  return config.env
}

/**
 * Get list of available model IDs.
 */
export function getAvailableModels(): string[] {
  return Object.keys(cachedConfigs)
}

/**
 * Get full config for a model (description + env).
 */
export function getModelConfig(modelId: string): ModelEnvConfig | null {
  return cachedConfigs[modelId] || null
}

// ── Phase 25: Model Routing ─────────────────────────────────────────────────

/**
 * Load model routing configuration from project profile.
 */
export function loadModelRoutingConfig(profile: Record<string, string>): ModelRoutingConfig | null {
  const enabled = profile['model_routing.enabled'] === 'true'

  if (!enabled) {
    return null
  }

  const defaultModel = profile['model_routing.default_model'] || 'claude'

  // Parse complexity routing from flattened keys
  const complexityRouting = {
    simple: profile['model_routing.complexity_routing.simple'] || defaultModel,
    medium: profile['model_routing.complexity_routing.medium'] || defaultModel,
    complex: profile['model_routing.complexity_routing.complex'] || defaultModel,
    atomic: profile['model_routing.complexity_routing.atomic'] || defaultModel,
  }

  // Parse escalation rules (simplified - would need YAML parsing for full support)
  const escalation: ModelRoutingConfig['escalation'] = []

  // Check for escalation config
  const escalationFrom = profile['model_routing.escalation.0.from']
  if (escalationFrom) {
    escalation.push({
      from: escalationFrom,
      to: profile['model_routing.escalation.0.to'] || 'claude',
      condition: profile['model_routing.escalation.0.condition'] || 'retry_count >= 2',
    })
  }

  cachedRoutingConfig = {
    enabled,
    default_model: defaultModel,
    complexity_routing: complexityRouting,
    escalation: escalation.length > 0 ? escalation : undefined,
  }

  return cachedRoutingConfig
}

/**
 * Get cached model routing config.
 */
export function getModelRoutingConfig(): ModelRoutingConfig | null {
  return cachedRoutingConfig
}

/**
 * Get model for complexity level based on routing config.
 */
export function getModelForComplexity(complexity: ComplexityLevel): string {
  if (!cachedRoutingConfig?.enabled) {
    return 'claude'
  }

  return cachedRoutingConfig.complexity_routing[complexity] || cachedRoutingConfig.default_model
}

/**
 * Get environment variables for complexity level.
 * Combines model env vars with routing decisions.
 */
export function getEnvForComplexity(complexity: ComplexityLevel): Record<string, string> {
  const model = getModelForComplexity(complexity)
  return getEnvForModel(model)
}

/**
 * Check if escalation should occur based on retry count.
 */
export function shouldEscalate(currentModel: string, retryCount: number): boolean {
  if (!cachedRoutingConfig?.escalation) {
    return false
  }

  for (const rule of cachedRoutingConfig.escalation) {
    if (rule.from === currentModel) {
      // Parse condition (simplified - only supports retry_count >= N)
      const match = rule.condition.match(/retry_count\s*>=\s*(\d+)/)
      if (match) {
        const threshold = parseInt(match[1], 10)
        return retryCount >= threshold
      }
    }
  }

  return false
}

/**
 * Get escalated model if applicable.
 */
export function getEscalatedModel(currentModel: string): string | null {
  if (!cachedRoutingConfig?.escalation) {
    return null
  }

  for (const rule of cachedRoutingConfig.escalation) {
    if (rule.from === currentModel) {
      return rule.to
    }
  }

  return null
}

/**
 * Get all model configuration info for debugging.
 */
export function getModelInfo(): {
  available_models: string[]
  routing_enabled: boolean
  routing_config: ModelRoutingConfig | null
} {
  return {
    available_models: getAvailableModels(),
    routing_enabled: cachedRoutingConfig?.enabled ?? false,
    routing_config: cachedRoutingConfig,
  }
}
