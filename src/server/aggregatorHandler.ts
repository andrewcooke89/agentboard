/**
 * aggregatorHandler.ts -- Aggregator Step Handler (Phase 23)
 *
 * Aggregates findings from multiple prior steps into a single merged output.
 * Supports:
 * - Deduplication by composite key (e.g., "file+line+category")
 * - Evidence filtering (require file_path + line_number)
 * - Verdict computation from configurable rules
 */

import fs from 'node:fs'
import path from 'node:path'
import type { WorkflowStep, StepRunState, WorkflowRun } from '../shared/types'

// ─── Public Types ───────────────────────────────────────────────────────────

export interface Finding {
  id?: string
  file_path?: string
  line_number?: number
  category?: string
  severity?: 'low' | 'medium' | 'high' | 'critical'
  message?: string
  details?: Record<string, unknown>
  source_step?: string
  [key: string]: unknown
}

export interface AggregatorConfig {
  input_steps: string[]
  dedup_key?: string
  require_evidence?: boolean
  verdict_rules?: Array<{
    condition: string
    verdict: 'PASS' | 'WARN' | 'FAIL'
  }>
  output_file: string
}

export interface AggregatorResult {
  findings: Finding[]
  verdict: 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN'
  stats: {
    total_input_findings: number
    after_dedup: number
    after_evidence_filter: number
  }
}

// ─── Finding Loading ──────────────────────────────────────────────────────────

/**
 * Load findings from a step's output file.
 * Supports JSON arrays and YAML lists of findings.
 * HIGH-008: Fixed path traversal check to include path separator.
 */
function loadFindingsFromStep(
  run: WorkflowRun,
  stepName: string,
  stepDef: WorkflowStep | undefined,
): Finding[] {
  if (!stepDef) return []

  const outputPath = stepDef.output_path ?? stepDef.result_file
  if (!outputPath) return []

  const fullPath = path.resolve(run.output_dir, outputPath)

  // HIGH-008: Fixed path traversal check - must include path separator or exact match
  if (fullPath !== run.output_dir && !fullPath.startsWith(run.output_dir + path.sep)) {
    return []
  }

  if (!fs.existsSync(fullPath)) {
    return []
  }

  try {
    const content = fs.readFileSync(fullPath, 'utf-8')
    const parsed = JSON.parse(content)

    if (Array.isArray(parsed)) {
      return parsed.map(f => ({
        ...f,
        source_step: stepName,
      }))
    }

    // Handle object with findings array
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.findings)) {
      return parsed.findings.map((f: unknown) => ({
        ...(f as Record<string, unknown>),
        source_step: stepName,
      }))
    }

    // Handle object with issues array (alternative naming)
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.issues)) {
      return parsed.issues.map((f: unknown) => ({
        ...(f as Record<string, unknown>),
        source_step: stepName,
      }))
    }

    // Single finding object
    if (parsed && typeof parsed === 'object') {
      return [{ ...parsed, source_step: stepName }]
    }

    return []
  } catch {
    return []
  }
}

// ─── Deduplication ────────────────────────────────────────────────────────────

/**
 * Build composite deduplication key for a finding.
 * Supports keys like "file+line+category" or single field names.
 */
function buildDedupKey(finding: Finding, keySpec: string): string {
  const fields = keySpec.split('+').map(f => f.trim())

  const parts = fields.map(field => {
    const value = finding[field as keyof Finding]
    if (value === undefined || value === null) {
      return ''
    }
    if (typeof value === 'object') {
      return JSON.stringify(value)
    }
    return String(value)
  })

  return parts.join('|')
}

/**
 * Deduplicate findings by composite key.
 * Keeps the first occurrence and merges severities (keeps highest).
 */
function deduplicateFindings(findings: Finding[], dedupKey?: string): Finding[] {
  if (!dedupKey) {
    return [...findings]
  }

  const severityRank: Record<string, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  }

  const seen = new Map<string, Finding>()

  for (const finding of findings) {
    const key = buildDedupKey(finding, dedupKey)

    if (!seen.has(key)) {
      seen.set(key, { ...finding })
    } else {
      // Merge: keep highest severity
      const existing = seen.get(key)!
      const existingRank = severityRank[existing.severity ?? 'low'] ?? 0
      const newRank = severityRank[finding.severity ?? 'low'] ?? 0

      if (newRank > existingRank) {
        seen.set(key, { ...existing, severity: finding.severity })
      }
    }
  }

  return [...seen.values()]
}

// ─── Evidence Filtering ───────────────────────────────────────────────────────

/**
 * Filter findings to only those with evidence (file_path + line_number).
 */
function filterByEvidence(findings: Finding[]): Finding[] {
  return findings.filter(f => {
    const hasFilePath = f.file_path && typeof f.file_path === 'string' && f.file_path.length > 0
    const hasLineNumber = f.line_number !== undefined && f.line_number !== null
    return hasFilePath && hasLineNumber
  })
}

// ─── Verdict Computation ──────────────────────────────────────────────────────

const SEVERITY_RANK: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
}

/**
 * Evaluate a verdict condition against findings.
 * Supports simple expressions like "severity >= high" or "count > 5".
 */
function evaluateCondition(findings: Finding[], condition: string): boolean {
  // Parse condition
  const severityMatch = condition.match(/severity\s*(>=|>|==|<=|<)\s*(critical|high|medium|low)/i)
  if (severityMatch) {
    const op = severityMatch[1]
    const threshold = severityMatch[2].toLowerCase()
    const thresholdRank = SEVERITY_RANK[threshold] ?? 0

    const matchingFindings = findings.filter(f => {
      const findingRank = SEVERITY_RANK[f.severity ?? 'low'] ?? 0
      switch (op) {
        case '>=': return findingRank >= thresholdRank
        case '>': return findingRank > thresholdRank
        case '==': return findingRank === thresholdRank
        case '<=': return findingRank <= thresholdRank
        case '<': return findingRank < thresholdRank
        default: return false
      }
    })

    return matchingFindings.length > 0
  }

  // Count conditions
  const countMatch = condition.match(/count\s*(>=|>|==|<=|<)\s*(\d+)/i)
  if (countMatch) {
    const op = countMatch[1]
    const threshold = parseInt(countMatch[2], 10)
    const count = findings.length

    switch (op) {
      case '>=': return count >= threshold
      case '>': return count > threshold
      case '==': return count === threshold
      case '<=': return count <= threshold
      case '<': return count < threshold
      default: return false
    }
  }

  // Category conditions
  const categoryMatch = condition.match(/category\s*==\s*['"]?(\w+)['"]?/i)
  if (categoryMatch) {
    const targetCategory = categoryMatch[1].toLowerCase()
    return findings.some(f => (f.category ?? '').toLowerCase() === targetCategory)
  }

  // Default: unknown condition, return false
  return false
}

/**
 * Compute verdict from findings using configurable rules.
 * Rules are evaluated in order; first matching rule wins.
 */
function computeVerdict(
  findings: Finding[],
  rules: Array<{ condition: string; verdict: 'PASS' | 'WARN' | 'FAIL' }> | undefined,
): 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN' {
  if (!rules || rules.length === 0) {
    // Default rules if none specified
    if (findings.some(f => f.severity === 'critical')) return 'FAIL'
    if (findings.some(f => f.severity === 'high')) return 'FAIL'
    if (findings.some(f => f.severity === 'medium')) return 'WARN'
    if (findings.length > 0) return 'WARN'
    return 'PASS'
  }

  // Evaluate rules in order
  for (const rule of rules) {
    if (evaluateCondition(findings, rule.condition)) {
      return rule.verdict
    }
  }

  // Default to PASS if no rules matched
  return 'PASS'
}

// ─── Main Aggregator Function ─────────────────────────────────────────────────

/**
 * Execute aggregator step: collect findings from input steps, dedupe, filter, compute verdict.
 */
export function executeAggregator(
  step: WorkflowStep,
  run: WorkflowRun,
  stepDefMap: Map<string, WorkflowStep>,
): AggregatorResult {
  const config: AggregatorConfig = {
    input_steps: step.input_steps ?? [],
    dedup_key: step.dedup_key,
    require_evidence: step.evidence_required ?? false,
    verdict_rules: (step.verdict_rules as AggregatorConfig['verdict_rules']) ?? undefined,
    output_file: step.output_file ?? 'aggregated.yaml',
  }

  // 1. Load findings from all input steps
  let allFindings: Finding[] = []
  for (const inputStepName of config.input_steps) {
    const inputStepDef = stepDefMap.get(inputStepName)
    const findings = loadFindingsFromStep(run, inputStepName, inputStepDef)
    allFindings = allFindings.concat(findings)
  }

  const totalInput = allFindings.length

  // 2. Deduplicate
  const dedupedFindings = deduplicateFindings(allFindings, config.dedup_key)
  const afterDedup = dedupedFindings.length

  // 3. Filter by evidence if required
  const filteredFindings = config.require_evidence
    ? filterByEvidence(dedupedFindings)
    : dedupedFindings
  const afterEvidenceFilter = filteredFindings.length

  // 4. Compute verdict
  const verdict = computeVerdict(filteredFindings, config.verdict_rules)

  return {
    findings: filteredFindings,
    verdict,
    stats: {
      total_input_findings: totalInput,
      after_dedup: afterDedup,
      after_evidence_filter: afterEvidenceFilter,
    },
  }
}

/**
 * Write aggregator result to output file.
 * HIGH-008: Fixed path traversal check to include path separator.
 */
export function writeAggregatorOutput(
  run: WorkflowRun,
  outputFile: string,
  result: AggregatorResult,
): void {
  const fullPath = path.resolve(run.output_dir, outputFile)

  // HIGH-008: Fixed path traversal check - must include path separator or exact match
  if (fullPath !== run.output_dir && !fullPath.startsWith(run.output_dir + path.sep)) {
    throw new Error(`Path traversal detected: ${outputFile}`)
  }

  // Ensure directory exists
  const dir = path.dirname(fullPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  // Write as JSON
  const output = {
    verdict: result.verdict,
    stats: result.stats,
    findings: result.findings,
    generated_at: new Date().toISOString(),
  }

  fs.writeFileSync(fullPath, JSON.stringify(output, null, 2), 'utf-8')
}

/**
 * Process aggregator step in DAG engine.
 * Returns true if step should complete, false if still processing.
 */
export function processAggregatorStep(
  run: WorkflowRun,
  stepDef: WorkflowStep,
  stepState: StepRunState,
  stepDefMap: Map<string, WorkflowStep>,
): { complete: boolean; result?: AggregatorResult; error?: string } {
  try {
    const result = executeAggregator(stepDef, run, stepDefMap)

    // Write output
    const outputFile = stepDef.output_file ?? 'aggregated.json'
    writeAggregatorOutput(run, outputFile, result)

    // Update step state
    stepState.resultContent = JSON.stringify(result)
    stepState.resultFile = outputFile
    stepState.resultCollected = true

    return { complete: true, result }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return { complete: false, error: errorMsg }
  }
}
