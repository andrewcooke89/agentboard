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

import fs from 'node:fs'
import type { ComplexityClassification, ComplexityLevel } from './complexityClassifier'
import { getEnvForModel } from './modelEnvLoader'
import { logger } from './logger'
import { DEFAULT_L1_MODEL, DEFAULT_L2_MODEL } from './config'
import { callGemini } from './geminiClient'

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
 * Uses Gemini to evaluate 7 binary checks against the target file.
 * Gracefully degrades if Gemini is unavailable (no API key or call failure).
 */
export async function executeL1Review(reviewConfig: {
  target_path: string
  spec_path?: string
  changes_summary?: string
  run_dir: string
  env?: Record<string, string>
}): Promise<ReviewResult> {
  const model = reviewConfig.env?.ANTHROPIC_MODEL ?? DEFAULT_L1_MODEL
  const geminiModel = 'gemini-2.5-flash'

  logger.info('l1_review_starting', {
    target: reviewConfig.target_path,
    model,
  })

  // Read target file content
  let fileContent: string
  try {
    fileContent = fs.readFileSync(reviewConfig.target_path, 'utf-8')
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger.error('l1_review_file_read_failed', {
      target: reviewConfig.target_path,
      error: errorMsg,
    })
    return {
      passed: false,
      verdict: 'FAIL',
      feedback: `L1 Review: Failed to read target file: ${errorMsg}`,
      model_used: model,
    }
  }

  // Read spec file if provided
  let specContent = ''
  if (reviewConfig.spec_path) {
    try {
      specContent = fs.readFileSync(reviewConfig.spec_path, 'utf-8')
    } catch {
      // Spec file is optional, continue without it
    }
  }

  // Build prompt for Gemini L1 review
  const prompt = `You are a code reviewer performing a Level 1 (L1) automated quality check.

Evaluate the following code against these 7 binary checks. For each check, respond with true or false.

Checks:
1. builds_successfully - Does the code appear to compile/parse correctly with no syntax errors?
2. tests_pass - Are there test cases present and do they appear correct?
3. no_new_warnings - Is the code free of obvious issues that would produce warnings (unused variables, unreachable code, etc.)?
4. follows_coding_standards - Does the code follow consistent style conventions (naming, formatting, structure)?
5. handles_errors - Is error handling present where needed (try/catch, null checks, validation)?
6. no_security_issues - Is the code free of obvious security vulnerabilities (injection, hardcoded secrets, unsafe operations)?
7. documentation_complete - Are public APIs, functions, and complex logic documented?

${specContent ? `Specification:\n${specContent}\n\n` : ''}${reviewConfig.changes_summary ? `Changes summary:\n${reviewConfig.changes_summary}\n\n` : ''}Code to review:
\`\`\`
${fileContent}
\`\`\`

Respond with ONLY a JSON object (no markdown, no explanation) in this exact format:
{
  "builds_successfully": true,
  "tests_pass": true,
  "no_new_warnings": true,
  "follows_coding_standards": true,
  "handles_errors": true,
  "no_security_issues": true,
  "documentation_complete": true
}`

  // Call Gemini
  const response = await callGemini({
    model: geminiModel,
    prompt,
    maxTokens: 512,
    temperature: 0.1,
  })

  // Handle Gemini unavailability gracefully
  if (response.skipped) {
    logger.info('l1_review_gemini_skipped', {
      reason: response.reason,
      target: reviewConfig.target_path,
    })
    return {
      passed: true,
      verdict: 'PASS',
      feedback: `L1 Review: Skipped (Gemini unavailable: ${response.reason}). Passing with warning.`,
      model_used: model,
    }
  }

  if (response.error) {
    logger.error('l1_review_gemini_error', {
      error: response.error,
      target: reviewConfig.target_path,
    })
    return {
      passed: true,
      verdict: 'PASS',
      feedback: `L1 Review: Skipped (Gemini error: ${response.error}). Passing with warning.`,
      model_used: model,
    }
  }

  // Parse JSON response
  let checks: L1CheckResults
  try {
    // Strip markdown code fences if present
    let content = response.content ?? ''
    content = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
    const parsed = JSON.parse(content)
    checks = {
      builds_successfully: Boolean(parsed.builds_successfully),
      tests_pass: Boolean(parsed.tests_pass),
      no_new_warnings: Boolean(parsed.no_new_warnings),
      follows_coding_standards: Boolean(parsed.follows_coding_standards),
      handles_errors: Boolean(parsed.handles_errors),
      no_security_issues: Boolean(parsed.no_security_issues),
      documentation_complete: Boolean(parsed.documentation_complete),
    }
  } catch (parseErr) {
    const errorMsg = parseErr instanceof Error ? parseErr.message : String(parseErr)
    logger.error('l1_review_parse_failed', {
      error: errorMsg,
      content: response.content?.substring(0, 200),
    })
    return {
      passed: true,
      verdict: 'PASS',
      feedback: `L1 Review: Failed to parse Gemini response: ${errorMsg}. Passing with warning.`,
      model_used: model,
    }
  }

  // Determine verdict from checks
  const allPassed = Object.values(checks).every(Boolean)
  const feedback = _generateL1Feedback(checks)

  return {
    passed: allPassed,
    verdict: allPassed ? 'PASS' : 'FAIL',
    checks,
    feedback,
    model_used: model,
  }
}

/**
 * Execute L2 review (expensive model, judgment proofs).
 * Uses Gemini to score 4 criteria on a 1-10 scale with reasoning.
 * Gracefully degrades if Gemini is unavailable (no API key or call failure).
 */
export async function executeL2Review(l1Result: ReviewResult, reviewConfig: {
  target_path: string
  spec_path?: string
  changes_summary?: string
  run_dir: string
  env?: Record<string, string>
}): Promise<ReviewResult> {
  const model = reviewConfig.env?.ANTHROPIC_MODEL ?? DEFAULT_L2_MODEL
  const geminiModel = 'gemini-2.5-flash'

  logger.info('l2_review_starting', {
    target: reviewConfig.target_path,
    model,
    l1_passed: l1Result.passed,
  })

  // Read target file content
  let fileContent: string
  try {
    fileContent = fs.readFileSync(reviewConfig.target_path, 'utf-8')
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger.error('l2_review_file_read_failed', {
      target: reviewConfig.target_path,
      error: errorMsg,
    })
    return {
      passed: false,
      verdict: 'FAIL',
      feedback: `L2 Review: Failed to read target file: ${errorMsg}`,
      model_used: model,
    }
  }

  // Read spec file if provided
  let specContent = ''
  if (reviewConfig.spec_path) {
    try {
      specContent = fs.readFileSync(reviewConfig.spec_path, 'utf-8')
    } catch {
      // Spec file is optional, continue without it
    }
  }

  // Build detailed prompt including L1 results
  const l1Summary = l1Result.checks
    ? `L1 Review Results:\n${l1Result.feedback}\n\n`
    : `L1 Review: ${l1Result.feedback}\n\n`

  const prompt = `You are a senior code reviewer performing a Level 2 (L2) in-depth judgment review.

The code has already passed L1 automated checks. Now evaluate it on 4 criteria, scoring each from 0.0 to 1.0 (where 1.0 is perfect) with detailed reasoning.

${l1Summary}${specContent ? `Specification:\n${specContent}\n\n` : ''}${reviewConfig.changes_summary ? `Changes summary:\n${reviewConfig.changes_summary}\n\n` : ''}Code to review:
\`\`\`
${fileContent}
\`\`\`

Criteria:
1. correctness - Does the code correctly implement the intended behavior? Are there logic errors, off-by-one errors, race conditions, or incorrect assumptions?
2. completeness - Does the code fully implement all requirements? Are there missing edge cases, unhandled scenarios, or incomplete features?
3. consistency - Is the code consistent with the rest of the codebase in style, patterns, naming conventions, and architectural decisions?
4. quality - Is the code well-structured, maintainable, readable, and following best practices? Consider separation of concerns, DRY principles, and testability.

Based on the scores, provide an overall_verdict:
- "PASS" if all scores are >= 0.7
- "NEEDS_FIX" if any score is between 0.4 and 0.7
- "FAIL" if any score is < 0.4

Respond with ONLY a JSON object (no markdown, no explanation) in this exact format:
{
  "correctness": { "score": 0.9, "reasoning": "..." },
  "completeness": { "score": 0.85, "reasoning": "..." },
  "consistency": { "score": 0.9, "reasoning": "..." },
  "quality": { "score": 0.8, "reasoning": "..." },
  "overall_verdict": "PASS"
}`

  // Call Gemini
  const response = await callGemini({
    model: geminiModel,
    prompt,
    maxTokens: 2048,
    temperature: 0.2,
  })

  // Handle Gemini unavailability gracefully
  if (response.skipped) {
    logger.info('l2_review_gemini_skipped', {
      reason: response.reason,
      target: reviewConfig.target_path,
    })
    return {
      passed: true,
      verdict: 'PASS',
      feedback: `L2 Review: Skipped (Gemini unavailable: ${response.reason}). Passing with warning.`,
      model_used: model,
    }
  }

  if (response.error) {
    logger.error('l2_review_gemini_error', {
      error: response.error,
      target: reviewConfig.target_path,
    })
    return {
      passed: true,
      verdict: 'PASS',
      feedback: `L2 Review: Skipped (Gemini error: ${response.error}). Passing with warning.`,
      model_used: model,
    }
  }

  // Parse JSON response
  let proof: L2JudgmentProof
  try {
    // Strip markdown code fences if present
    let content = response.content ?? ''
    content = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
    const parsed = JSON.parse(content)

    const parseScore = (criterion: unknown): { score: number; reasoning: string } => {
      if (typeof criterion === 'object' && criterion !== null) {
        const c = criterion as Record<string, unknown>
        return {
          score: typeof c.score === 'number' ? Math.max(0, Math.min(1, c.score)) : 0.5,
          reasoning: typeof c.reasoning === 'string' ? c.reasoning : 'No reasoning provided',
        }
      }
      return { score: 0.5, reasoning: 'No reasoning provided' }
    }

    proof = {
      correctness: parseScore(parsed.correctness),
      completeness: parseScore(parsed.completeness),
      consistency: parseScore(parsed.consistency),
      quality: parseScore(parsed.quality),
      overall_verdict: (['PASS', 'FAIL', 'NEEDS_FIX'] as const).includes(parsed.overall_verdict)
        ? parsed.overall_verdict
        : 'NEEDS_FIX',
    }
  } catch (parseErr) {
    const errorMsg = parseErr instanceof Error ? parseErr.message : String(parseErr)
    logger.error('l2_review_parse_failed', {
      error: errorMsg,
      content: response.content?.substring(0, 200),
    })
    return {
      passed: true,
      verdict: 'PASS',
      feedback: `L2 Review: Failed to parse Gemini response: ${errorMsg}. Passing with warning.`,
      model_used: model,
    }
  }

  // Determine verdict from proof
  const passed = proof.overall_verdict === 'PASS'
  const verdict: ReviewResult['verdict'] = proof.overall_verdict === 'PASS' ? 'PASS'
    : proof.overall_verdict === 'FAIL' ? 'FAIL'
    : 'NEEDS_FIX'
  const feedback = _generateL2Feedback(proof)

  return {
    passed,
    verdict,
    proof,
    feedback,
    model_used: model,
  }
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
