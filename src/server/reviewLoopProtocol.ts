/**
 * reviewLoopProtocol.ts — Verdict parsing, normalization, and summary writing (Phase 8)
 *
 * This is a pure utility module with NO engine dependencies. It handles verdict
 * extraction from reviewer output files and summary file generation.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

// ─── Public Types ───────────────────────────────────────────────────────────

export type ReviewVerdict = 'PASS' | 'FAIL' | 'NEEDS_FIX' | 'CONCERN'

export interface VerdictResult {
  verdict: ReviewVerdict
  raw: string
  feedback: string | null
  warning?: string
}

export interface IterationSummary {
  iteration: number
  verdict: string
  feedback: string | null
  producer_duration_seconds: number
  reviewer_duration_seconds: number
}

export interface ReviewLoopSummary {
  step_name: string
  total_iterations: number
  final_outcome: string
  iterations: IterationSummary[]
}

// ─── Verdict Normalization ──────────────────────────────────────────────────

const KNOWN_VERDICTS = new Set<string>(['PASS', 'FAIL', 'NEEDS_FIX', 'CONCERN'])

/**
 * Normalize a raw verdict string to a known ReviewVerdict.
 * - Trims whitespace, uppercases
 * - PASS, FAIL, NEEDS_FIX, CONCERN are recognized
 * - Unknown values map to FAIL with a warning
 */
export function normalizeVerdict(raw: string): { verdict: ReviewVerdict; warning?: string } {
  const normalized = raw.trim().toUpperCase()

  if (KNOWN_VERDICTS.has(normalized)) {
    return { verdict: normalized as ReviewVerdict }
  }

  // Common aliases
  if (normalized === 'APPROVE' || normalized === 'APPROVED' || normalized === 'LGTM' || normalized === 'OK') {
    return { verdict: 'PASS', warning: `Verdict '${raw.trim()}' treated as PASS.` }
  }
  if (normalized === 'REJECT' || normalized === 'REJECTED') {
    return { verdict: 'FAIL', warning: `Verdict '${raw.trim()}' treated as FAIL.` }
  }
  if (normalized === 'REVISE') {
    return { verdict: 'NEEDS_FIX', warning: `Verdict 'REVISE' treated as NEEDS_FIX.` }
  }

  return {
    verdict: 'FAIL',
    warning: `Unknown verdict '${raw.trim()}' from reviewer, treating as FAIL.`,
  }
}

// ─── Verdict Reading ────────────────────────────────────────────────────────

/**
 * Read and parse the reviewer's verdict from a YAML output file.
 *
 * @param outputPath - Path to the reviewer's output YAML file
 * @param verdictField - Field name to extract the verdict from (e.g. 'verdict')
 * @param feedbackField - Optional field name for feedback text
 * @returns VerdictResult or null if file missing / verdict field absent
 */
export function readReviewerVerdict(
  outputPath: string,
  verdictField: string,
  feedbackField?: string,
): VerdictResult | null {
  // Check file exists
  if (!existsSync(outputPath)) {
    return null
  }

  let content: string
  try {
    content = readFileSync(outputPath, 'utf-8')
  } catch {
    return null
  }

  if (!content.trim()) {
    return null
  }

  // Parse YAML
  let parsed: unknown
  try {
    parsed = yaml.load(content)
  } catch {
    // If YAML parse fails, try to extract verdict from raw text as fallback
    return extractVerdictFromText(content, verdictField, feedbackField)
  }

  if (!parsed || typeof parsed !== 'object') {
    return extractVerdictFromText(content, verdictField, feedbackField)
  }

  const doc = parsed as Record<string, unknown>

  // Extract verdict field
  const rawVerdict = doc[verdictField]
  if (rawVerdict === undefined || rawVerdict === null) {
    return null
  }

  const raw = String(rawVerdict)
  const { verdict, warning } = normalizeVerdict(raw)

  // Extract feedback
  let feedback: string | null = null
  if (feedbackField && doc[feedbackField] !== undefined && doc[feedbackField] !== null) {
    const feedbackValue = doc[feedbackField]
    feedback = typeof feedbackValue === 'string' ? feedbackValue : JSON.stringify(feedbackValue)
  }

  return { verdict, raw, feedback, warning }
}

/**
 * Fallback: extract verdict from raw text content when YAML parsing fails.
 * Looks for patterns like "verdict: PASS" or just "PASS" on its own line.
 */
function extractVerdictFromText(
  content: string,
  verdictField: string,
  feedbackField?: string,
): VerdictResult | null {
  // Try "field: VALUE" pattern (capture only the first word to avoid inline comments)
  const fieldPattern = new RegExp(`${escapeRegex(verdictField)}\\s*:\\s*(\\S+)`, 'im')
  const fieldMatch = content.match(fieldPattern)
  if (fieldMatch) {
    const raw = fieldMatch[1].trim()
    const { verdict, warning } = normalizeVerdict(raw)

    let feedback: string | null = null
    if (feedbackField) {
      const fbPattern = new RegExp(`${escapeRegex(feedbackField)}\\s*:\\s*(.+)`, 'im')
      const fbMatch = content.match(fbPattern)
      if (fbMatch) feedback = fbMatch[1].trim()
    }

    return { verdict, raw, feedback, warning }
  }

  return null
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ─── Summary Writing ────────────────────────────────────────────────────────

/**
 * Write a review loop summary YAML file.
 *
 * @param summaryDir - Directory to write the summary file into
 * @param stepName - Name of the review_loop step
 * @param summary - The summary data to write
 */
export function writeReviewLoopSummary(
  summaryDir: string,
  stepName: string,
  summary: ReviewLoopSummary,
): void {
  mkdirSync(summaryDir, { recursive: true })
  const filePath = path.join(summaryDir, `${stepName}.yaml`)
  const content = yaml.dump(summary, { lineWidth: 120, noRefs: true })
  writeFileSync(filePath, content, 'utf-8')
}
