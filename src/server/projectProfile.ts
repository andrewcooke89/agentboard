/**
 * projectProfile.ts — Project profile loading and flattening (Phase 9)
 * Phase 25: Added support for model_routing and review_routing sections
 *
 * Loads a project_profile.yaml from a project's .workflow/ directory and
 * flattens nested objects into dot-notation keys for variable interpolation.
 */

import { readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import type { ModelRoutingConfig, ReviewRoutingConfig, DraftSwarmConfig, ComplexityLevel } from '../shared/types'

/**
 * Load project_profile.yaml and flatten nested objects to dot-notation keys.
 *
 * Example:
 *   { source_layout: { handlers: "src/h/" } }
 *   → { "source_layout.handlers": "src/h/" }
 *
 * Arrays are serialized as YAML strings.
 * Returns empty record if file doesn't exist.
 */
export function loadProjectProfile(projectPath: string): Record<string, string> {
  const profilePath = path.join(projectPath, '.workflow', 'project_profile.yaml')

  if (!existsSync(profilePath)) {
    return {}
  }

  // SECURITY-3: Validate profile file ownership/permissions
  try {
    const stats = statSync(profilePath)
    // Log warning if world-writable (potential security risk)
    if (stats.mode & 0o002) {
      console.warn(`[SECURITY] project_profile.yaml is world-writable: ${profilePath}`)
    }
  } catch {
    // Ignore stat errors, file will fail to read anyway
  }

  let raw: unknown
  try {
    const content = readFileSync(profilePath, 'utf-8')

    // SECURITY-3: Limit file size to prevent DoS
    if (content.length > 1_000_000) {
      console.error(`[SECURITY] project_profile.yaml exceeds 1MB limit: ${profilePath}`)
      return {}
    }

    raw = yaml.load(content, { schema: yaml.FAILSAFE_SCHEMA })
  } catch {
    return {}
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }

  return flattenObject(raw as Record<string, unknown>)
}

/**
 * Load raw project profile as nested object (for Phase 25 routing configs).
 */
export function loadProjectProfileRaw(projectPath: string): Record<string, unknown> {
  const profilePath = path.join(projectPath, '.workflow', 'project_profile.yaml')

  if (!existsSync(profilePath)) {
    return {}
  }

  try {
    const content = readFileSync(profilePath, 'utf-8')

    // SECURITY-3: Limit file size to prevent DoS
    if (content.length > 1_000_000) {
      console.error(`[SECURITY] project_profile.yaml exceeds 1MB limit: ${profilePath}`)
      return {}
    }

    const raw = yaml.load(content, { schema: yaml.FAILSAFE_SCHEMA })

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {}
    }

    return raw as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * Extract model_routing configuration from project profile.
 * Phase 25: Used by modelEnvLoader for complexity-based routing.
 */
export function extractModelRoutingConfig(profile: Record<string, unknown>): ModelRoutingConfig | null {
  const routing = profile.model_routing
  if (!routing || typeof routing !== 'object') {
    return null
  }

  const r = routing as Record<string, unknown>

  // Check if enabled
  const enabled = r.enabled === true || r.enabled === 'true'
  if (!enabled) {
    return null
  }

  const defaultModel = typeof r.default_model === 'string' ? r.default_model : 'claude'

  // Parse complexity routing
  const cr = r.complexity_routing as Record<string, unknown> | undefined
  const complexityRouting = {
    simple: (cr?.simple as string) ?? defaultModel,
    medium: (cr?.medium as string) ?? defaultModel,
    complex: (cr?.complex as string) ?? defaultModel,
    atomic: (cr?.atomic as string) ?? defaultModel,
  }

  // Parse escalation rules
  const escalation: ModelRoutingConfig['escalation'] = []
  const escalationRaw = r.escalation
  if (Array.isArray(escalationRaw)) {
    for (const rule of escalationRaw) {
      if (typeof rule === 'object' && rule !== null) {
        const r = rule as Record<string, unknown>
        if (typeof r.from === 'string' && typeof r.to === 'string') {
          escalation.push({
            from: r.from,
            to: r.to,
            condition: (r.condition as string) ?? 'retry_count >= 2',
          })
        }
      }
    }
  }

  return {
    enabled,
    default_model: defaultModel,
    complexity_routing: complexityRouting,
    escalation: escalation.length > 0 ? escalation : undefined,
  }
}

/**
 * Extract review_routing configuration from project profile.
 * Phase 25: Used by reviewRouter for L1/L2 routing.
 */
export function extractReviewRoutingConfig(profile: Record<string, unknown>): ReviewRoutingConfig | null {
  const routing = profile.review_routing
  if (!routing || typeof routing !== 'object') {
    return null
  }

  const r = routing as Record<string, unknown>

  return {
    enabled: r.enabled === true || r.enabled === 'true',
    l1_model: r.l1_model as string | undefined,
    l2_model: r.l2_model as string | undefined,
    complexity_routing: r.complexity_routing as ReviewRoutingConfig['complexity_routing'] | undefined,
  }
}

/**
 * Extract draft_swarm configuration from project profile.
 * Phase 25: Used by draftSwarm for speculative parallel drafts.
 */
export function extractDraftSwarmConfig(profile: Record<string, unknown>): DraftSwarmConfig | null {
  const swarm = profile.draft_swarm
  if (!swarm || typeof swarm !== 'object') {
    return null
  }

  const s = swarm as Record<string, unknown>

  const validLevels: ComplexityLevel[] = ['simple', 'medium', 'complex', 'atomic']
  const triggerComplexity: ComplexityLevel[] = Array.isArray(s.trigger_complexity)
    ? (s.trigger_complexity as string[]).filter((v): v is ComplexityLevel =>
        validLevels.includes(v as ComplexityLevel))
    : ['simple', 'medium']

  return {
    enabled: s.enabled === true || s.enabled === 'true',
    models: Array.isArray(s.models) ? (s.models as string[]) : ['glm'],
    trigger_complexity: triggerComplexity,
    min_tier: typeof s.min_tier === 'number' ? s.min_tier : 2,
    max_concurrent: typeof s.max_concurrent === 'number' ? s.max_concurrent : 3,
    timeout_ms: typeof s.timeout_ms === 'number' ? s.timeout_ms : 60000,
    rate_limit_per_minute: typeof s.rate_limit_per_minute === 'number' ? s.rate_limit_per_minute : 30,
  }
}

/**
 * Load all Phase 25 routing configurations at once.
 */
export function loadRoutingConfigs(projectPath: string): {
  modelRouting: ModelRoutingConfig | null
  reviewRouting: ReviewRoutingConfig | null
  draftSwarm: DraftSwarmConfig | null
} {
  const profile = loadProjectProfileRaw(projectPath)

  return {
    modelRouting: extractModelRoutingConfig(profile),
    reviewRouting: extractReviewRoutingConfig(profile),
    draftSwarm: extractDraftSwarmConfig(profile),
  }
}

/**
 * Flatten a nested object into dot-notation keys with string values.
 */
function flattenObject(
  obj: Record<string, unknown>,
  prefix: string = '',
): Record<string, string> {
  const result: Record<string, string> = {}

  for (const [key, value] of Object.entries(obj)) {
    // Skip prototype pollution keys
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue

    const fullKey = prefix ? `${prefix}.${key}` : key

    if (value === null || value === undefined) {
      result[fullKey] = ''
    } else if (typeof value === 'string') {
      result[fullKey] = value
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      result[fullKey] = String(value)
    } else if (Array.isArray(value)) {
      // Arrays serialized as YAML strings
      result[fullKey] = yaml.dump(value).trim()
    } else if (typeof value === 'object') {
      // Recurse into nested objects
      const nested = flattenObject(value as Record<string, unknown>, fullKey)
      Object.assign(result, nested)
    }
  }

  return result
}
