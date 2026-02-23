/**
 * complexityClassifier.ts - Classifies work orders by complexity for model routing
 *
 * Complexity levels:
 * - simple: Single file, <50 LOC, no unsafe code
 * - medium: 2-5 files, <200 LOC, minimal complexity
 * - complex: 6+ files, cross-module changes, external dependencies
 * - atomic: Multi-file with critical safety requirements (unsafe, crypto, auth)
 */

export type ComplexityLevel = 'simple' | 'medium' | 'complex' | 'atomic'

export interface ComplexityClassification {
  complexity: ComplexityLevel
  confidence: number  // 0.0 - 1.0
  reason?: string
}

export interface WorkOrderAnalysis {
  files: string[]
  modules: number
  unsafe_blocks: number
  estimated_loc: number
  external_dependencies: string[]
  has_critical_sections: boolean
}

/**
 * Check spec metadata first (explicit classification).
 * Falls back to heuristics if not explicitly specified.
 *
 * MED-005: Function is synchronous - no await calls, so removed async keyword.
 */
export function classifyWorkOrder(
  work_order: { complexity?: ComplexityLevel; estimated_complexity?: string } | null,
  project_profile?: { complexity?: string } | null
): ComplexityClassification {
  // Priority 1: Explicit classification in work order
  if (work_order?.complexity) {
    return {
      complexity: work_order.complexity,
      confidence: 1.0,
      reason: 'Explicit classification in work order',
    }
  }

  // Priority 2: Estimated complexity string in work order
  if (work_order?.estimated_complexity) {
    const normalized = normalizeComplexityString(work_order.estimated_complexity)
    if (normalized) {
      return {
        complexity: normalized,
        confidence: 0.9,
        reason: `Estimated complexity: ${work_order.estimated_complexity}`,
      }
    }
  }

  // Priority 3: Project profile default complexity
  if (project_profile?.complexity) {
    const normalized = normalizeComplexityString(project_profile.complexity)
    if (normalized) {
      return {
        complexity: normalized,
        confidence: 0.7,
        reason: `Project profile default: ${project_profile.complexity}`,
      }
    }
  }

  // No explicit classification - return with low confidence, caller should use heuristics
  return {
    complexity: 'medium',  // Safe default
    confidence: 0.3,
    reason: 'No explicit classification, defaulting to medium',
  }
}

/**
 * Heuristic classification based on file count, module count, and unsafe blocks.
 */
export function heuristicClassification(
  files: string[],
  modules: number,
  unsafe_blocks: number,
  estimated_loc?: number
): ComplexityClassification {
  const fileCount = files.length
  const loc = estimated_loc ?? 0

  // Atomic: Any unsafe blocks or critical file patterns
  if (unsafe_blocks > 0) {
    return {
      complexity: 'atomic',
      confidence: 0.9,
      reason: `Contains ${unsafe_blocks} unsafe block(s)`,
    }
  }

  // Check for critical file patterns
  const criticalPatterns = [
    /auth/i, /crypt/i, /security/i, /password/i, /secret/i,
    /token/i, /key/i, /permission/i, /validate/i,
  ]
  for (const file of files) {
    for (const pattern of criticalPatterns) {
      if (pattern.test(file)) {
        return {
          complexity: 'atomic',
          confidence: 0.8,
          reason: `Critical file pattern detected: ${file}`,
        }
      }
    }
  }

  // Complex: 6+ files, 3+ modules, or 200+ LOC
  if (fileCount >= 6 || modules >= 3 || loc >= 200) {
    return {
      complexity: 'complex',
      confidence: 0.85,
      reason: `Large scope: ${fileCount} files, ${modules} modules, ~${loc} LOC`,
    }
  }

  // Medium: 2-5 files (single file is simple regardless of inferred modules)
  if (fileCount >= 2) {
    return {
      complexity: 'medium',
      confidence: 0.8,
      reason: `Moderate scope: ${fileCount} files, ${modules} modules`,
    }
  }

  // Simple: Single file, minimal complexity
  return {
    complexity: 'simple',
    confidence: 0.85,
    reason: `Simple scope: ${fileCount} file(s), ${modules} module(s)`,
  }
}

/**
 * Analyze work order content to extract metrics for classification.
 */
export function analyzeWorkOrder(work_order: {
  files?: string[]
  modules?: number
  unsafe_blocks?: number
  estimated_loc?: number
}): WorkOrderAnalysis {
  const files = work_order.files ?? []
  const modules = work_order.modules ?? (files.length > 0 ? 1 : 0)
  const unsafe_blocks = work_order.unsafe_blocks ?? 0
  const estimated_loc = work_order.estimated_loc ?? estimateLOC(files)

  // Detect critical sections from file names
  const criticalPatterns = [
    /auth/i, /crypt/i, /security/i, /password/i, /secret/i,
  ]
  const has_critical_sections = unsafe_blocks > 0 ||
    files.some(f => criticalPatterns.some(p => p.test(f)))

  return {
    files,
    modules,
    unsafe_blocks,
    estimated_loc,
    external_dependencies: [],
    has_critical_sections,
  }
}

/**
 * Normalize a complexity string to a valid ComplexityLevel.
 * LOW-005: Logs warning when unrecognized complexity string is received.
 */
function normalizeComplexityString(value: string): ComplexityLevel | null {
  const normalized = value.toLowerCase().trim()

  switch (normalized) {
    case 'simple':
    case 'low':
    case 'trivial':
    case 'easy':
      return 'simple'
    case 'medium':
    case 'moderate':
    case 'normal':
    case 'average':
      return 'medium'
    case 'complex':
    case 'high':
    case 'difficult':
    case 'hard':
      return 'complex'
    case 'atomic':
    case 'critical':
    case 'sensitive':
    case 'security':
      return 'atomic'
    default:
      // LOW-005: Log warning for unrecognized complexity string
      console.warn(`[complexityClassifier] Unrecognized complexity string: "${value}", returning null`)
      return null
  }
}

/**
 * Rough LOC estimation based on file extensions.
 */
function estimateLOC(files: string[]): number {
  // Default estimates per file type
  const estimates: Record<string, number> = {
    '.ts': 80,
    '.tsx': 100,
    '.js': 70,
    '.jsx': 90,
    '.py': 60,
    '.rs': 100,
    '.go': 70,
    '.java': 100,
    '.yaml': 30,
    '.json': 20,
    '.md': 50,
  }

  let total = 0
  for (const file of files) {
    const ext = file.substring(file.lastIndexOf('.'))
    total += estimates[ext] ?? 50
  }

  return total
}

/**
 * Classify with full analysis combining explicit and heuristic methods.
 * MED-005: Updated to use synchronous classifyWorkOrder.
 */
export async function classifyWithAnalysis(
  work_order: {
    complexity?: ComplexityLevel
    estimated_complexity?: string
    files?: string[]
    modules?: number
    unsafe_blocks?: number
    estimated_loc?: number
  } | null,
  project_profile?: { complexity?: string } | null
): Promise<ComplexityClassification> {
  // Try explicit classification first (MED-005: no longer async)
  const explicit = classifyWorkOrder(work_order, project_profile)

  if (explicit.confidence >= 0.9) {
    return explicit
  }

  // Fall back to heuristic classification
  if (work_order?.files || work_order?.modules !== undefined) {
    const analysis = analyzeWorkOrder(work_order)
    const heuristic = heuristicClassification(
      analysis.files,
      analysis.modules,
      analysis.unsafe_blocks,
      analysis.estimated_loc
    )

    // Use heuristic if higher confidence or explicit was low confidence
    if (heuristic.confidence > explicit.confidence || explicit.confidence < 0.5) {
      return heuristic
    }
  }

  return explicit
}
