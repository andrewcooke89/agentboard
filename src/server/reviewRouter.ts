/**
 * reviewRouter.ts - Routes review requests to L1 or L2 reviewers based on complexity
 *
 * Routing rules:
 * - simple/medium -> L1 only (cheap model)
 * - complex/atomic -> L1 then L2 if L1 passes
 *
 * L1 produces structured YAML with 7 binary checks.
 * L2 produces judgment proofs with 4 criteria.
 */

import type { ComplexityClassification, ComplexityLevel } from './complexityClassifier'
import { getEnvForModel } from './modelEnvLoader'
import { logger } from './logger'
import { DEFAULT_L1_MODEL, DEFAULT_L2_MODEL } from './config'

export interface ReviewRouting {
  complexity: ComplexityLevel
  l1_required: boolean
  l2_required: boolean
  l1_model?: string
  l2_model?: string
  l1_env: Record<string, string>
  l2_env: Record<string, string>
}

export interface ReviewResult {
  passed: boolean
  verdict: 'PASS' | 'FAIL' | 'NEEDS_FIX' | 'CONCERN'
  checks?: L1CheckResults
  proof?: L2JudgmentProof
  feedback: string
  model_used: string
}

export interface L1CheckResults {
  // 7 binary checks for L1 review
  builds_successfully: boolean
  tests_pass: boolean
  no_new_warnings: boolean
  follows_coding_standards: boolean
  handles_errors: boolean
  no_security_issues: boolean
  documentation_complete: boolean
}

export interface L2JudgmentProof {
  // 4 criteria for L2 judgment
  correctness: { score: number; reasoning: string }
  completeness: { score: number; reasoning: string }
  consistency: { score: number; reasoning: string }
  quality: { score: number; reasoning: string }
  overall_verdict: 'PASS' | 'FAIL' | 'NEEDS_FIX'
}

export interface ReviewRoutingConfig {
  enabled?: boolean
  l1_model?: string
  l2_model?: string
  complexity_routing?: {
    simple?: 'l1' | 'l2' | 'both'
    medium?: 'l1' | 'l2' | 'both'
    complex?: 'l1' | 'l2' | 'both'
    atomic?: 'l1' | 'l2' | 'both'
  }
}

/**
 * Determine review routing based on complexity classification.
 */
export function determineReviewRouting(
  classification: ComplexityClassification,
  config?: ReviewRoutingConfig | null
): ReviewRouting {
  const complexity = classification.complexity
  const l1Model = config?.l1_model ?? DEFAULT_L1_MODEL
  const l2Model = config?.l2_model ?? DEFAULT_L2_MODEL

  // Default routing: simple/medium -> L1 only, complex/atomic -> both
  let l1Required = true
  let l2Required = false

  // Check custom routing from config
  const routingMap = config?.complexity_routing
  if (routingMap) {
    const routing = routingMap[complexity]
    if (routing === 'l1') {
      l1Required = true
      l2Required = false
    } else if (routing === 'l2') {
      l1Required = false
      l2Required = true
    } else if (routing === 'both') {
      l1Required = true
      l2Required = true
    }
  } else {
    // Default logic
    switch (complexity) {
      case 'simple':
      case 'medium':
        l1Required = true
        l2Required = false
        break
      case 'complex':
      case 'atomic':
        l1Required = true
        l2Required = true
        break
    }
  }

  return {
    complexity,
    l1_required: l1Required,
    l2_required: l2Required,
    l1_model: l1Model,
    l2_model: l2Model,
    l1_env: getEnvForModel(l1Model),
    l2_env: getEnvForModel(l2Model),
  }
}

/**
 * Execute L1 review (cheap model, structured checks).
 * HIGH-006: Throws "not implemented" error - this is a placeholder that must be
 * implemented before production use. Returning hardcoded passing results is unsafe.
 */
export async function executeL1Review(reviewConfig: {
  target_path: string
  spec_path?: string
  changes_summary?: string
  run_dir: string
  env?: Record<string, string>
}): Promise<ReviewResult> {
  const model = reviewConfig.env?.ANTHROPIC_MODEL ?? DEFAULT_L1_MODEL

  logger.info('l1_review_starting', {
    target: reviewConfig.target_path,
    model,
  })

  // HIGH-006: This placeholder implementation throws an error.
  // Production deployments must implement actual model calls.
  throw new Error(
    'L1 review not implemented: executeL1Review requires integration with actual model API. ' +
    'Returning hardcoded passing results in production is unsafe and not supported.'
  )
}

/**
 * Execute L2 review (expensive model, judgment proofs).
 * HIGH-006: Throws "not implemented" error - this is a placeholder that must be
 * implemented before production use. Returning hardcoded passing results is unsafe.
 */
export async function executeL2Review(l1Result: ReviewResult, reviewConfig: {
  target_path: string
  spec_path?: string
  changes_summary?: string
  run_dir: string
  env?: Record<string, string>
}): Promise<ReviewResult> {
  const model = reviewConfig.env?.ANTHROPIC_MODEL ?? DEFAULT_L2_MODEL

  logger.info('l2_review_starting', {
    target: reviewConfig.target_path,
    model,
    l1_passed: l1Result.passed,
  })

  // HIGH-006: This placeholder implementation throws an error.
  // Production deployments must implement actual model calls.
  throw new Error(
    'L2 review not implemented: executeL2Review requires integration with actual model API. ' +
    'Returning hardcoded passing results in production is unsafe and not supported.'
  )
}

/**
 * Execute full review pipeline based on routing.
 *
 * MED-009: L2 is skipped when L1 fails. This is intentional - L1 acts as a gatekeeper.
 * If you need L2 to run regardless of L1 result for audit purposes, configure
 * complexity_routing to use 'l2' only (bypassing L1 entirely).
 */
export async function executeReview(
  classification: ComplexityClassification,
  config: ReviewRoutingConfig | null | undefined,
  reviewConfig: {
    target_path: string
    spec_path?: string
    changes_summary?: string
    run_dir: string
  }
): Promise<ReviewResult> {
  const routing = determineReviewRouting(classification, config)

  logger.info('review_routing_determined', {
    complexity: routing.complexity,
    l1_required: routing.l1_required,
    l2_required: routing.l2_required,
    l1_model: routing.l1_model,
    l2_model: routing.l2_model,
  })

  // Execute L1 if required
  let l1Result: ReviewResult | null = null
  if (routing.l1_required) {
    l1Result = await executeL1Review({
      ...reviewConfig,
      env: routing.l1_env,
    })

    // MED-009: If L1 fails and L2 is required, still return L1 result (L2 is skipped)
    // This is intentional behavior - L1 acts as a gatekeeper for basic quality checks.
    // Rationale: Running L2 on code that fails basic checks wastes resources.
    if (!l1Result.passed) {
      logger.info('review_l1_failed_l2_skipped', {
        feedback: l1Result.feedback,
        l2_was_required: routing.l2_required,
      })
      return l1Result
    }
  }

  // Execute L2 if required
  if (routing.l2_required && l1Result) {
    const l2Result = await executeL2Review(l1Result, {
      ...reviewConfig,
      env: routing.l2_env,
    })
    return l2Result
  }

  // Return L1 result if only L1 was required
  if (l1Result) {
    return l1Result
  }

  // Edge case: only L2 required (rare but possible)
  return executeL2Review({
    passed: true,
    verdict: 'PASS',
    feedback: 'L1 skipped',
    model_used: 'none',
  }, {
    ...reviewConfig,
    env: routing.l2_env,
  })
}

/**
 * Generate human-readable feedback from L1 checks.
 */
function _generateL1Feedback(checks: L1CheckResults): string {
  const passed: string[] = []
  const failed: string[] = []

  const labels: Record<keyof L1CheckResults, string> = {
    builds_successfully: 'Builds successfully',
    tests_pass: 'Tests pass',
    no_new_warnings: 'No new warnings',
    follows_coding_standards: 'Follows coding standards',
    handles_errors: 'Handles errors properly',
    no_security_issues: 'No security issues',
    documentation_complete: 'Documentation complete',
  }

  for (const [key, value] of Object.entries(checks)) {
    const label = labels[key as keyof L1CheckResults]
    if (value) {
      passed.push(label)
    } else {
      failed.push(label)
    }
  }

  if (failed.length === 0) {
    return `L1 Review: All checks passed (${passed.length}/7)`
  }

  return `L1 Review: ${failed.length} check(s) failed\n` +
    `  Passed: ${passed.join(', ')}\n` +
    `  Failed: ${failed.join(', ')}`
}

/**
 * Generate human-readable feedback from L2 judgment proof.
 */
function _generateL2Feedback(proof: L2JudgmentProof): string {
  const scores = [
    `Correctness: ${(proof.correctness.score * 100).toFixed(0)}%`,
    `Completeness: ${(proof.completeness.score * 100).toFixed(0)}%`,
    `Consistency: ${(proof.consistency.score * 100).toFixed(0)}%`,
    `Quality: ${(proof.quality.score * 100).toFixed(0)}%`,
  ]

  return `L2 Judgment: ${proof.overall_verdict}\n` +
    `  Scores: ${scores.join(', ')}\n` +
    `  Reasoning: ${proof.correctness.reasoning}`
}
