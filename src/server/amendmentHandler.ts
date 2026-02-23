/**
 * amendmentHandler.ts — Amendment signal parsing, routing, and resolution (Phase 8)
 *
 * Pure utility module with NO engine dependencies. Handles amendment signal
 * parsing, routing logic, prompt building, and resolution file I/O.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'

// ─── Public Types ───────────────────────────────────────────────────────────

export interface AmendmentSignal {
  signal_type: string
  amendment: {
    type: string          // gap | correction | reconciliation | scope_change | fundamental
    category: string      // quality | reconciliation | fundamental
    spec_section: string
    issue: string
    proposed_addition?: string
    target?: 'spec' | 'constitution'
  }
  checkpoint: Record<string, unknown>
  additional_issues?: Array<Record<string, unknown>>
}

export interface AmendmentResolution {
  signal_file: string
  resolution: 'approved' | 'rejected' | 'deferred'
  amendment_id: string
  resolved_at: string
  resolved_by: string
  checkpoint_to_resume?: Record<string, unknown>
  spec_changes?: string
}

export interface AmendmentConfig {
  auto_review_types?: string[]
  human_required_types?: string[]
  human_required_tiers?: number[]
  same_section_twice?: 'escalate' | 'ignore'
  handler_timeout_seconds?: number
}

// ─── Signal Parsing ─────────────────────────────────────────────────────────

/**
 * Parse an amendment payload from a signal file's content (already parsed YAML object).
 * Returns null if the signal doesn't contain a valid amendment block.
 */
export function parseAmendmentSignal(signalContent: Record<string, unknown>): AmendmentSignal | null {
  if (!signalContent || typeof signalContent !== 'object') return null

  const amendment = signalContent.amendment
  if (!amendment || typeof amendment !== 'object') return null

  const amend = amendment as Record<string, unknown>
  if (!amend.type || !amend.category || !amend.spec_section || !amend.issue) return null

  // SEC-1: Validate field lengths to prevent memory exhaustion
  const MAX_FIELD_LENGTH = 100 * 1024 // 100KB

  const issue = String(amend.issue)
  if (issue.length > MAX_FIELD_LENGTH) {
    console.warn(`[SEC-1] amendment_signal_field_too_large: issue field ${issue.length} bytes exceeds max ${MAX_FIELD_LENGTH}`)
    return null
  }

  const proposedAddition = amend.proposed_addition ? String(amend.proposed_addition) : undefined
  if (proposedAddition && proposedAddition.length > MAX_FIELD_LENGTH) {
    console.warn(`[SEC-1] amendment_signal_field_too_large: proposed_addition field ${proposedAddition.length} bytes exceeds max ${MAX_FIELD_LENGTH}`)
    return null
  }

  return {
    signal_type: String(signalContent.signal_type ?? 'amendment_required'),
    amendment: {
      type: String(amend.type),
      category: String(amend.category),
      spec_section: String(amend.spec_section),
      issue,
      proposed_addition: proposedAddition,
      target: amend.target === 'constitution' ? 'constitution' : 'spec',
    },
    checkpoint: (signalContent.checkpoint as Record<string, unknown>) ?? {},
    additional_issues: Array.isArray(signalContent.additional_issues)
      ? signalContent.additional_issues
      : undefined,
  }
}

// ─── Routing Logic ──────────────────────────────────────────────────────────

/**
 * Check if this amendment type can be auto-reviewed (no human needed).
 * Default auto-reviewable: gap, correction, reconciliation
 */
export function shouldAutoReview(amendment: AmendmentSignal, config: AmendmentConfig): boolean {
  // Fundamental amendments always require human
  if (isFundamental(amendment)) return false

  const autoTypes = config.auto_review_types ?? ['gap', 'correction', 'reconciliation']
  return autoTypes.includes(amendment.amendment.type)
}

/**
 * Check if this amendment must be escalated to a human reviewer.
 * Based on human_required_types, human_required_tiers, and target.
 */
export function shouldEscalateToHuman(
  amendment: AmendmentSignal,
  config: AmendmentConfig,
  runTier?: number,
): boolean {
  // Fundamental always escalates
  if (isFundamental(amendment)) return true

  // Constitution changes always require human
  if (amendment.amendment.target === 'constitution') return true

  // Check type-based escalation
  const humanTypes = config.human_required_types ?? ['fundamental', 'scope_change']
  if (humanTypes.includes(amendment.amendment.type)) return true

  // Check tier-based escalation
  if (runTier !== undefined && config.human_required_tiers?.includes(runTier)) return true

  return false
}

/**
 * Fundamental amendments always escalate — they indicate the spec is fundamentally wrong.
 */
export function isFundamental(amendment: AmendmentSignal): boolean {
  return amendment.amendment.type === 'fundamental' || amendment.amendment.category === 'fundamental'
}

// ─── Prompt Building ────────────────────────────────────────────────────────

/**
 * Build the prompt for the amendment-handler agent session.
 */
export function buildHandlerPrompt(
  amendment: AmendmentSignal,
  specPath: string,
  constitutionSections: string[],
  checkpoint: Record<string, unknown>,
): string {
  const lines: string[] = [
    '# Amendment Handler Task',
    '',
    '## Amendment Details',
    `- **Type**: ${amendment.amendment.type}`,
    `- **Category**: ${amendment.amendment.category}`,
    `- **Spec Section**: ${amendment.amendment.spec_section}`,
    `- **Target**: ${amendment.amendment.target ?? 'spec'}`,
    '',
    '## Issue',
    amendment.amendment.issue,
    '',
  ]

  if (amendment.amendment.proposed_addition) {
    lines.push('## Proposed Change', amendment.amendment.proposed_addition, '')
  }

  lines.push(
    '## Spec Path',
    specPath,
    '',
    '## Constitution Sections',
    constitutionSections.length > 0 ? constitutionSections.join(', ') : '(none)',
    '',
    '## Checkpoint State',
    '```json',
    JSON.stringify(checkpoint, null, 2),
    '```',
    '',
    '## Instructions',
    '1. Review the amendment against the current spec and constitution',
    '2. Determine if the proposed change is valid and consistent',
    '3. If approved: write the updated spec section content',
    '4. If rejected: explain why the amendment is not appropriate',
    '5. Write a resolution file with your decision',
  )

  if (amendment.additional_issues?.length) {
    lines.push('', '## Additional Issues', '')
    for (const issue of amendment.additional_issues) {
      lines.push(`- ${JSON.stringify(issue)}`)
    }
  }

  return lines.join('\n')
}

/**
 * Build prompt for resuming the original step after amendment resolution.
 */
export function buildResumePrompt(
  checkpoint: Record<string, unknown>,
  amendmentDetails: { type: string; spec_section: string; issue: string },
  resolution: 'approved' | 'rejected' | 'deferred',
): string {
  const lines: string[] = [
    '# Resume After Amendment',
    '',
    `## Resolution: ${resolution}`,
    '',
    '## Amendment That Was Processed',
    `- **Type**: ${amendmentDetails.type}`,
    `- **Section**: ${amendmentDetails.spec_section}`,
    `- **Issue**: ${amendmentDetails.issue}`,
    '',
    '## Checkpoint State',
    'Resume from the following checkpoint:',
    '```json',
    JSON.stringify(checkpoint, null, 2),
    '```',
    '',
  ]

  if (resolution === 'approved') {
    lines.push(
      '## Note',
      'The spec has been updated with the amendment. Please re-read the relevant spec section before continuing.',
    )
  } else if (resolution === 'rejected') {
    lines.push(
      '## Note',
      'The amendment was rejected. Continue with the original spec as-is.',
    )
  } else {
    lines.push(
      '## Note',
      'The amendment was deferred. Continue with the original spec. The issue will be tracked for later resolution.',
    )
  }

  return lines.join('\n')
}

// ─── File I/O ───────────────────────────────────────────────────────────────

/**
 * Write an amendment record YAML to the output directory.
 * Creates {outputDir}/amendments/AMEND-{timestamp}.yaml
 * Returns the file path.
 */
export function writeAmendmentRecord(
  outputDir: string,
  amendment: AmendmentSignal,
  resolution: AmendmentResolution,
): string {
  const amendDir = join(outputDir, 'amendments')
  if (!existsSync(amendDir)) {
    mkdirSync(amendDir, { recursive: true })
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `AMEND-${timestamp}.yaml`
  const filePath = join(amendDir, filename)

  const record = {
    amendment_id: resolution.amendment_id,
    type: amendment.amendment.type,
    category: amendment.amendment.category,
    spec_section: amendment.amendment.spec_section,
    issue: amendment.amendment.issue,
    proposed_change: amendment.amendment.proposed_addition ?? null,
    resolution: resolution.resolution,
    resolved_by: resolution.resolved_by,
    resolved_at: resolution.resolved_at,
    spec_changes: resolution.spec_changes ?? null,
    checkpoint: amendment.checkpoint,
  }

  writeFileSync(filePath, yaml.dump(record), 'utf-8')
  return filePath
}

/**
 * Read and parse a resolution file written by the amendment handler.
 * Returns null if file doesn't exist or is malformed.
 */
export function readResolutionFile(resolutionPath: string): AmendmentResolution | null {
  try {
    if (!existsSync(resolutionPath)) return null
    const content = readFileSync(resolutionPath, 'utf-8')
    const parsed = yaml.load(content) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return null

    const resolution = parsed.resolution as string
    if (!['approved', 'rejected', 'deferred'].includes(resolution)) return null

    return {
      signal_file: String(parsed.signal_file ?? ''),
      resolution: resolution as 'approved' | 'rejected' | 'deferred',
      amendment_id: String(parsed.amendment_id ?? ''),
      resolved_at: String(parsed.resolved_at ?? new Date().toISOString()),
      resolved_by: String(parsed.resolved_by ?? 'unknown'),
      checkpoint_to_resume: (parsed.checkpoint_to_resume as Record<string, unknown>) ?? undefined,
      spec_changes: parsed.spec_changes ? String(parsed.spec_changes) : undefined,
    }
  } catch {
    return null
  }
}
