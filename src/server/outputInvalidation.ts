/**
 * outputInvalidation.ts - Tracks step output validity across retries and amendments
 *
 * Invalidates downstream outputs transitively when upstream changes.
 * Implements circuit breaker: 3 invalidations in one run -> pause for human review.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite'
import crypto from 'node:crypto'

export interface InvalidationRule {
  step: string
  invalidates: string[]
}

export interface StepOutputRecord {
  run_id: string
  step_name: string
  input_hash: string  // HIGH-007: Separate input hash for comparison
  output_hash: string
  valid: boolean
  updated_at: number
}

export interface OutputInvalidationStore {
  upsertStepOutput: (record: Omit<StepOutputRecord, 'updated_at'>) => void
  getStepOutput: (runId: string, stepName: string) => StepOutputRecord | null
  invalidateStep: (runId: string, stepName: string) => void
  getValidSteps: (runId: string) => string[]
  getInvalidatedSteps: (runId: string) => string[]
  getInvalidationCount: (runId: string) => number
}

export interface ExecutionContext {
  runId: string
  outputDir: string
  logger: { warn: (event: string, data: Record<string, unknown>) => void }
}

// Circuit breaker threshold
const CIRCUIT_BREAKER_THRESHOLD = 3

/**
 * Create the output invalidation store with database operations.
 *
 * @param db - SQLite database instance for persisting step output records
 * @returns Store interface for tracking step output validity and invalidating downstream steps
 *
 * @example
 * ```ts
 * const db = new Database('agentboard.db');
 * const store = createOutputInvalidationStore(db);
 * store.upsertStepOutput({ run_id: 'run-1', step_name: 'classify', input_hash: 'abc123', output_hash: 'def456', valid: true });
 * ```
 */
export function createOutputInvalidationStore(db: SQLiteDatabase): OutputInvalidationStore {
  // Create tables - HIGH-007: Added input_hash column
  db.exec(`
    CREATE TABLE IF NOT EXISTS step_outputs (
      run_id TEXT NOT NULL,
      step_name TEXT NOT NULL,
      input_hash TEXT NOT NULL DEFAULT '',
      output_hash TEXT NOT NULL,
      valid INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, step_name)
    );
    CREATE INDEX IF NOT EXISTS idx_step_outputs_valid ON step_outputs(run_id, valid);
  `)

  const upsertStmt = db.prepare(
    `INSERT INTO step_outputs (run_id, step_name, input_hash, output_hash, valid, updated_at)
     VALUES ($runId, $stepName, $inputHash, $outputHash, $valid, $updatedAt)
     ON CONFLICT(run_id, step_name) DO UPDATE SET
       input_hash = excluded.input_hash,
       output_hash = excluded.output_hash,
       valid = excluded.valid,
       updated_at = excluded.updated_at`
  )
  const selectStmt = db.prepare(
    'SELECT * FROM step_outputs WHERE run_id = $runId AND step_name = $stepName'
  )
  const invalidateStmt = db.prepare(
    'UPDATE step_outputs SET valid = 0, updated_at = $updatedAt WHERE run_id = $runId AND step_name = $stepName'
  )
  const getValidStmt = db.prepare(
    'SELECT step_name FROM step_outputs WHERE run_id = $runId AND valid = 1'
  )
  const getInvalidatedStmt = db.prepare(
    'SELECT step_name FROM step_outputs WHERE run_id = $runId AND valid = 0'
  )
  const getCountStmt = db.prepare(
    'SELECT COUNT(*) as count FROM step_outputs WHERE run_id = $runId AND valid = 0'
  )

  return {
    upsertStepOutput: (record) => {
      upsertStmt.run({
        $runId: record.run_id,
        $stepName: record.step_name,
        $inputHash: record.input_hash ?? '',  // HIGH-007: Include input_hash
        $outputHash: record.output_hash,
        $valid: record.valid ? 1 : 0,
        $updatedAt: Date.now(),
      })
    },
    getStepOutput: (runId, stepName) => {
      const row = selectStmt.get({ $runId: runId, $stepName: stepName }) as Record<string, unknown> | undefined
      return row ? mapStepOutputRow(row) : null
    },
    invalidateStep: (runId, stepName) => {
      invalidateStmt.run({ $runId: runId, $stepName: stepName, $updatedAt: Date.now() })
    },
    getValidSteps: (runId) => {
      const rows = getValidStmt.all({ $runId: runId }) as Array<{ step_name: string }>
      return rows.map(r => r.step_name)
    },
    getInvalidatedSteps: (runId) => {
      const rows = getInvalidatedStmt.all({ $runId: runId }) as Array<{ step_name: string }>
      return rows.map(r => r.step_name)
    },
    getInvalidationCount: (runId) => {
      const row = getCountStmt.get({ $runId: runId }) as { count: number } | undefined
      return row?.count ?? 0
    },
  }
}

/**
 * Map a database row to StepOutputRecord.
 * LOW-002: Explicit boolean coercion validation for row.valid
 */
function mapStepOutputRow(row: Record<string, unknown>): StepOutputRecord {
  // LOW-002: Ensure valid is explicitly 0 or 1 before boolean conversion
  const validValue = Number(row.valid)
  const isValid = validValue === 1
  if (validValue !== 0 && validValue !== 1) {
    console.warn(`[outputInvalidation] Unexpected valid value: ${row.valid}, coercing to ${isValid}`)
  }

  return {
    run_id: String(row.run_id ?? ''),
    step_name: String(row.step_name ?? ''),
    input_hash: String(row.input_hash ?? ''),  // HIGH-007: Include input_hash
    output_hash: String(row.output_hash ?? ''),
    valid: isValid,
    updated_at: Number(row.updated_at ?? 0),
  }
}

/**
 * Compute hash for content
 */
export function computeHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/**
 * Check if output should be invalidated based on input hash comparison
 * HIGH-007: Now compares input_hash separately from output_hash
 */
export async function checkOutputInvalidation(
  step_name: string,
  input_hash: string,
  ctx: ExecutionContext,
  store: OutputInvalidationStore
): Promise<boolean> {
  const existing = store.getStepOutput(ctx.runId, step_name)

  if (!existing) {
    // No previous output, not invalidated
    return false
  }

  // If the step was already invalidated, keep it invalidated
  if (!existing.valid) {
    return true
  }

  // HIGH-007: Compare input hashes (not output_hash) - if different, invalidate
  if (existing.input_hash && existing.input_hash !== input_hash) {
    ctx.logger.warn('output_invalidation_detected', {
      runId: ctx.runId,
      stepName: step_name,
      previousInputHash: existing.input_hash.slice(0, 8),
      newInputHash: input_hash.slice(0, 8),
    })
    return true
  }

  return false
}

/**
 * Invalidate downstream steps transitively through dependency graph
 */
export async function invalidateDownstream(
  step_name: string,
  ctx: ExecutionContext,
  store: OutputInvalidationStore,
  dependencyGraph: Map<string, string[]> // step -> steps that depend on it
): Promise<string[]> {
  const invalidated: string[] = []
  const toProcess = [step_name]
  const processed = new Set<string>()

  while (toProcess.length > 0) {
    const current = toProcess.shift()!
    if (processed.has(current)) continue
    processed.add(current)

    // Get downstream steps
    const downstream = dependencyGraph.get(current) || []
    for (const dep of downstream) {
      if (!processed.has(dep)) {
        // Invalidate this step
        store.invalidateStep(ctx.runId, dep)
        invalidated.push(dep)
        toProcess.push(dep)
      }
    }
  }

  if (invalidated.length > 0) {
    ctx.logger.warn('downstream_invalidation', {
      runId: ctx.runId,
      sourceStep: step_name,
      invalidatedSteps: invalidated,
    })
  }

  return invalidated
}

/**
 * Track output hash for a step
 * HIGH-007: Now accepts input_hash parameter separately
 */
export async function trackOutputHash(
  step_name: string,
  output_hash: string,
  valid: boolean,
  ctx: ExecutionContext,
  store: OutputInvalidationStore,
  input_hash?: string  // HIGH-007: Optional input_hash parameter
): Promise<void> {
  store.upsertStepOutput({
    run_id: ctx.runId,
    step_name,
    input_hash: input_hash ?? '',  // HIGH-007: Store input_hash
    output_hash,
    valid,
  })
}

/**
 * Check circuit breaker - returns true if should pause for human review
 */
export function checkCircuitBreaker(
  runId: string,
  store: OutputInvalidationStore
): { shouldPause: boolean; invalidationCount: number } {
  const count = store.getInvalidationCount(runId)
  return {
    shouldPause: count >= CIRCUIT_BREAKER_THRESHOLD,
    invalidationCount: count,
  }
}

/**
 * Increment invalidation count and check circuit breaker
 */
export function incrementInvalidationAndCheck(
  step_name: string,
  ctx: ExecutionContext,
  store: OutputInvalidationStore
): { shouldPause: boolean; invalidationCount: number } {
  // Invalidate the step
  store.invalidateStep(ctx.runId, step_name)

  // Check threshold
  const count = store.getInvalidationCount(ctx.runId)

  if (count >= CIRCUIT_BREAKER_THRESHOLD) {
    ctx.logger.warn('circuit_breaker_triggered', {
      runId: ctx.runId,
      invalidationCount: count,
      threshold: CIRCUIT_BREAKER_THRESHOLD,
      lastStep: step_name,
    })
  }

  return {
    shouldPause: count >= CIRCUIT_BREAKER_THRESHOLD,
    invalidationCount: count,
  }
}

/**
 * Build dependency graph from workflow steps
 */
export function buildDependencyGraph(
  steps: Array<{ name: string; depends_on?: string[] }>
): Map<string, string[]> {
  const graph = new Map<string, string[]>()

  for (const step of steps) {
    if (step.depends_on) {
      for (const dep of step.depends_on) {
        const downstream = graph.get(dep) || []
        downstream.push(step.name)
        graph.set(dep, downstream)
      }
    }
  }

  return graph
}

/**
 * Invalidation rules registry - maps step types to what they invalidate
 */
export const INVALIDATION_RULES: Map<string, InvalidationRule[]> = new Map([
  // Example: spec validation invalidates implementation steps
  // ['spec_validate', [{ step: 'spec_validate', invalidates: ['implement', 'test'] }]],
])

/**
 * Get invalidation rules for a step type
 */
export function getInvalidationRules(stepType: string): InvalidationRule[] {
  return INVALIDATION_RULES.get(stepType) || []
}
