/**
 * telemetryCollector.ts - Collects metrics at pipeline lifecycle points
 *
 * Three DB tables: telemetry_runs, telemetry_steps, telemetry_daily
 * Write-through: SQLite + {run_dir}/telemetry.yaml
 */

import { Database as SQLiteDatabase } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

export interface RunMetrics {
  run_id: string
  pipeline_type: string
  tier: number
  total_tokens: number
  estimated_cost_usd: number
  wall_clock_ms: number
  quality_score?: number
}

export interface StepMetrics {
  step_name: string
  model?: string
  input_tokens: number
  output_tokens: number
  duration_ms: number
  status: 'completed' | 'failed' | 'skipped'
}

export interface DailyAggregate {
  date: string
  total_runs: number
  total_tokens: number
  total_cost_usd: number
  avg_wall_clock_ms: number | null
  avg_quality_score: number | null
}

export interface TelemetryRunRecord {
  run_id: string
  pipeline_type: string
  tier: number
  total_tokens: number
  estimated_cost_usd: number
  wall_clock_ms: number | null
  quality_score: number | null
  started_at: number
  completed_at: number | null
}

export interface TelemetryStepRecord {
  id: number
  run_id: string
  step_name: string
  model: string | null
  input_tokens: number
  output_tokens: number
  duration_ms: number | null
  status: string
  started_at: number
  completed_at: number | null
}

export interface TelemetryDailyRecord {
  date: string
  total_runs: number
  total_tokens: number
  total_cost_usd: number
  avg_wall_clock_ms: number | null
  avg_quality_score: number | null
}

export interface TelemetryStore {
  insertRun: (record: Omit<TelemetryRunRecord, 'started_at'>) => void
  updateRun: (runId: string, fields: Partial<Pick<TelemetryRunRecord, 'total_tokens' | 'estimated_cost_usd' | 'wall_clock_ms' | 'quality_score' | 'completed_at'>>) => void
  getRun: (runId: string) => TelemetryRunRecord | null
  getRunsByDateRange: (startMs: number, endMs: number) => TelemetryRunRecord[]

  insertStep: (record: Omit<TelemetryStepRecord, 'id' | 'started_at'>) => number
  updateStep: (stepId: number, fields: Partial<Pick<TelemetryStepRecord, 'duration_ms' | 'status' | 'completed_at'>>) => void
  getStepsByRun: (runId: string) => TelemetryStepRecord[]

  upsertDaily: (record: TelemetryDailyRecord) => void
  getDaily: (date: string) => TelemetryDailyRecord | null
  getDailyRange: (startDate: string, endDate: string) => TelemetryDailyRecord[]
}

// Cost per 1M tokens (approximate, varies by model)
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'glm-4': { input: 0.5, output: 0.5 },
}

const DEFAULT_MODEL_COST = { input: 1, output: 2 }

// Track active step timings
const activeSteps = new Map<string, { startedAt: number; runId: string; stepName: string }>()

// HIGH-001: Staleness cleanup threshold (1 hour)
const ACTIVE_STEPS_STALENESS_MS = 60 * 60 * 1000 // 1 hour

/**
 * HIGH-001: Cleanup stale entries from activeSteps map.
 * Removes entries older than 1 hour.
 */
function cleanupStaleActiveSteps(): void {
  const now = Date.now()
  for (const [key, value] of activeSteps.entries()) {
    if (now - value.startedAt > ACTIVE_STEPS_STALENESS_MS) {
      activeSteps.delete(key)
    }
  }
}

// HIGH-001: Periodic cleanup counter
let stepsSinceLastCleanup = 0
const CLEANUP_THRESHOLD = 100 // Cleanup every 100 step operations

/**
 * Create the telemetry store with database operations.
 *
 * @param db - SQLite database instance for persisting telemetry data
 * @returns Store interface for recording pipeline runs, steps, and daily aggregates
 *
 * @example
 * ```ts
 * const db = new Database('agentboard.db');
 * const store = createTelemetryStore(db);
 * await recordPipelineStart('run-123', { pipeline_type: 'spec', tier: 2 }, store, '/output');
 * ```
 */
export function createTelemetryStore(db: SQLiteDatabase): TelemetryStore {
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_runs (
      run_id TEXT PRIMARY KEY,
      pipeline_type TEXT NOT NULL,
      tier INTEGER NOT NULL,
      total_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL DEFAULT 0,
      wall_clock_ms INTEGER,
      quality_score REAL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_runs_date ON telemetry_runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_telemetry_runs_pipeline ON telemetry_runs(pipeline_type);

    CREATE TABLE IF NOT EXISTS telemetry_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      step_name TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      duration_ms INTEGER,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_steps_run ON telemetry_steps(run_id);

    CREATE TABLE IF NOT EXISTS telemetry_daily (
      date TEXT PRIMARY KEY,
      total_runs INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      total_cost_usd REAL DEFAULT 0,
      avg_wall_clock_ms REAL,
      avg_quality_score REAL
    );
  `)

  // Run statements
  const insertRunStmt = db.prepare(
    `INSERT INTO telemetry_runs (run_id, pipeline_type, tier, total_tokens, estimated_cost_usd, wall_clock_ms, quality_score, started_at, completed_at)
     VALUES ($runId, $pipelineType, $tier, $totalTokens, $estimatedCostUsd, $wallClockMs, $qualityScore, $startedAt, $completedAt)`
  )
  const updateRunStmt = db.prepare(
    `UPDATE telemetry_runs SET
      total_tokens = $totalTokens,
      estimated_cost_usd = $estimatedCostUsd,
      wall_clock_ms = $wallClockMs,
      quality_score = $qualityScore,
      completed_at = $completedAt
     WHERE run_id = $runId`
  )
  const getRunStmt = db.prepare('SELECT * FROM telemetry_runs WHERE run_id = $runId')
  const getRunsByDateRangeStmt = db.prepare(
    'SELECT * FROM telemetry_runs WHERE started_at >= $startMs AND started_at < $endMs'
  )

  // Step statements
  const insertStepStmt = db.prepare(
    `INSERT INTO telemetry_steps (run_id, step_name, model, input_tokens, output_tokens, duration_ms, status, started_at, completed_at)
     VALUES ($runId, $stepName, $model, $inputTokens, $outputTokens, $durationMs, $status, $startedAt, $completedAt)`
  )
  const updateStepStmt = db.prepare(
    `UPDATE telemetry_steps SET duration_ms = $durationMs, status = $status, completed_at = $completedAt WHERE id = $id`
  )
  const getStepsByRunStmt = db.prepare('SELECT * FROM telemetry_steps WHERE run_id = $runId ORDER BY started_at')

  // Daily statements
  const upsertDailyStmt = db.prepare(
    `INSERT INTO telemetry_daily (date, total_runs, total_tokens, total_cost_usd, avg_wall_clock_ms, avg_quality_score)
     VALUES ($date, $totalRuns, $totalTokens, $totalCostUsd, $avgWallClockMs, $avgQualityScore)
     ON CONFLICT(date) DO UPDATE SET
       total_runs = excluded.total_runs,
       total_tokens = excluded.total_tokens,
       total_cost_usd = excluded.total_cost_usd,
       avg_wall_clock_ms = excluded.avg_wall_clock_ms,
       avg_quality_score = excluded.avg_quality_score`
  )
  const getDailyStmt = db.prepare('SELECT * FROM telemetry_daily WHERE date = $date')
  const getDailyRangeStmt = db.prepare(
    'SELECT * FROM telemetry_daily WHERE date >= $startDate AND date <= $endDate ORDER BY date'
  )

  return {
    insertRun: (record) => {
      insertRunStmt.run({
        $runId: record.run_id,
        $pipelineType: record.pipeline_type,
        $tier: record.tier,
        $totalTokens: record.total_tokens ?? 0,
        $estimatedCostUsd: record.estimated_cost_usd ?? 0,
        $wallClockMs: record.wall_clock_ms !== undefined ? record.wall_clock_ms : null,
        $qualityScore: record.quality_score !== undefined ? record.quality_score : null,
        $startedAt: Date.now(),
        $completedAt: record.completed_at !== undefined ? record.completed_at : null,
      })
    },
    updateRun: (runId, fields) => {
      updateRunStmt.run({
        $runId: runId,
        $totalTokens: fields.total_tokens !== undefined ? fields.total_tokens : null,
        $estimatedCostUsd: fields.estimated_cost_usd !== undefined ? fields.estimated_cost_usd : null,
        $wallClockMs: fields.wall_clock_ms !== undefined ? fields.wall_clock_ms : null,
        $qualityScore: fields.quality_score !== undefined ? fields.quality_score : null,
        $completedAt: fields.completed_at !== undefined ? fields.completed_at : null,
      })
    },
    getRun: (runId) => {
      const row = getRunStmt.get({ $runId: runId }) as Record<string, unknown> | undefined
      return row ? mapTelemetryRunRow(row) : null
    },
    getRunsByDateRange: (startMs, endMs) => {
      const rows = getRunsByDateRangeStmt.all({ $startMs: startMs, $endMs: endMs }) as Record<string, unknown>[]
      return rows.map(mapTelemetryRunRow)
    },

    insertStep: (record) => {
      const result = insertStepStmt.run({
        $runId: record.run_id,
        $stepName: record.step_name,
        $model: record.model ?? null,
        $inputTokens: record.input_tokens ?? 0,
        $outputTokens: record.output_tokens ?? 0,
        $durationMs: record.duration_ms ?? null,
        $status: record.status,
        $startedAt: Date.now(),
        $completedAt: record.completed_at ?? null,
      })
      return Number(result.lastInsertRowid)
    },
    updateStep: (stepId, fields) => {
      updateStepStmt.run({
        $id: stepId,
        $durationMs: fields.duration_ms !== undefined ? fields.duration_ms : null,
        $status: fields.status ?? 'completed',
        $completedAt: fields.completed_at !== undefined ? fields.completed_at : null,
      } as { $id: number; $durationMs: number | null; $status: string; $completedAt: number | null })
    },
    getStepsByRun: (runId) => {
      const rows = getStepsByRunStmt.all({ $runId: runId }) as Record<string, unknown>[]
      return rows.map(mapTelemetryStepRow)
    },

    upsertDaily: (record) => {
      upsertDailyStmt.run({
        $date: record.date,
        $totalRuns: record.total_runs,
        $totalTokens: record.total_tokens,
        $totalCostUsd: record.total_cost_usd,
        $avgWallClockMs: record.avg_wall_clock_ms ?? null,
        $avgQualityScore: record.avg_quality_score ?? null,
      })
    },
    getDaily: (date) => {
      const row = getDailyStmt.get({ $date: date }) as Record<string, unknown> | undefined
      return row ? mapTelemetryDailyRow(row) : null
    },
    getDailyRange: (startDate, endDate) => {
      const rows = getDailyRangeStmt.all({ $startDate: startDate, $endDate: endDate }) as Record<string, unknown>[]
      return rows.map(mapTelemetryDailyRow)
    },
  }
}

function mapTelemetryRunRow(row: Record<string, unknown>): TelemetryRunRecord {
  return {
    run_id: String(row.run_id ?? ''),
    pipeline_type: String(row.pipeline_type ?? ''),
    tier: Number(row.tier ?? 1),
    total_tokens: Number(row.total_tokens ?? 0),
    estimated_cost_usd: Number(row.estimated_cost_usd ?? 0),
    wall_clock_ms: (row.wall_clock_ms ?? null) as number | null,
    quality_score: (row.quality_score ?? null) as number | null,
    started_at: Number(row.started_at ?? 0),
    completed_at: row.completed_at != null ? Number(row.completed_at) : null,
  }
}

function mapTelemetryStepRow(row: Record<string, unknown>): TelemetryStepRecord {
  return {
    id: Number(row.id),
    run_id: String(row.run_id ?? ''),
    step_name: String(row.step_name ?? ''),
    model: row.model != null ? String(row.model) : null,
    input_tokens: Number(row.input_tokens ?? 0),
    output_tokens: Number(row.output_tokens ?? 0),
    duration_ms: (row.duration_ms ?? null) as number | null,
    status: String(row.status ?? 'completed'),
    started_at: Number(row.started_at ?? 0),
    completed_at: (row.completed_at ?? null) as number | null,
  }
}

function mapTelemetryDailyRow(row: Record<string, unknown>): TelemetryDailyRecord {
  return {
    date: String(row.date ?? ''),
    total_runs: Number(row.total_runs ?? 0),
    total_tokens: Number(row.total_tokens ?? 0),
    total_cost_usd: Number(row.total_cost_usd ?? 0),
    avg_wall_clock_ms: (row.avg_wall_clock_ms ?? null) as number | null,
    avg_quality_score: (row.avg_quality_score ?? null) as number | null,
  }
}

/**
 * Record pipeline start
 */
export async function recordPipelineStart(
  run_id: string,
  metrics: Partial<RunMetrics>,
  store: TelemetryStore,
  outputDir: string
): Promise<void> {
  store.insertRun({
    run_id,
    pipeline_type: metrics.pipeline_type ?? 'unknown',
    tier: metrics.tier ?? 1,
    total_tokens: metrics.total_tokens ?? 0,
    estimated_cost_usd: metrics.estimated_cost_usd ?? 0,
    wall_clock_ms: metrics.wall_clock_ms !== undefined ? metrics.wall_clock_ms : null,
    quality_score: metrics.quality_score !== undefined ? metrics.quality_score : null,
    completed_at: null,
  })

  // Write telemetry.yaml
  writeTelemetryYaml(outputDir, {
    run_id,
    pipeline_type: metrics.pipeline_type ?? 'unknown',
    tier: metrics.tier ?? 1,
    started_at: new Date().toISOString(),
    steps: [],
  })
}

/**
 * Record step start
 * HIGH-001: Includes periodic staleness cleanup
 */
export async function recordStepStart(
  step_name: string,
  runId: string
): Promise<void> {
  // HIGH-001: Periodic cleanup
  stepsSinceLastCleanup++
  if (stepsSinceLastCleanup >= CLEANUP_THRESHOLD) {
    cleanupStaleActiveSteps()
    stepsSinceLastCleanup = 0
  }

  const key = `${runId}:${step_name}`
  activeSteps.set(key, {
    startedAt: Date.now(),
    runId,
    stepName: step_name,
  })
}

/**
 * Record step completion
 * HIGH-003: Now accepts runId parameter directly instead of fragile inference.
 */
export async function recordStepComplete(
  step_name: string,
  metrics: StepMetrics,
  store: TelemetryStore,
  outputDir: string,
  runId?: string // HIGH-003: Optional explicit runId parameter
): Promise<void> {
  // HIGH-001: Periodic cleanup
  stepsSinceLastCleanup++
  if (stepsSinceLastCleanup >= CLEANUP_THRESHOLD) {
    cleanupStaleActiveSteps()
    stepsSinceLastCleanup = 0
  }

  const _key = `${runId ?? ''}:${step_name}`

  // Find the active step - HIGH-003: Prefer explicit runId parameter
  let resolvedRunId: string | null = runId ?? null
  if (!resolvedRunId) {
    for (const [k, v] of activeSteps.entries()) {
      if (v.stepName === step_name) {
        resolvedRunId = v.runId
        activeSteps.delete(k)
        break
      }
    }
  }

  if (!resolvedRunId) {
    // Fallback: try to get run_id from outputDir
    const runRecord = store.getRun(outputDir.split('/').pop() ?? '')
    resolvedRunId = runRecord?.run_id ?? null
  }

  if (resolvedRunId) {
    store.insertStep({
      run_id: resolvedRunId,
      step_name,
      model: metrics.model ?? null,
      input_tokens: metrics.input_tokens ?? 0,
      output_tokens: metrics.output_tokens ?? 0,
      duration_ms: metrics.duration_ms,
      status: metrics.status,
      completed_at: Date.now(),
    })

    // Update run totals
    const run = store.getRun(resolvedRunId)
    if (run) {
      const newTokens = run.total_tokens + metrics.input_tokens + metrics.output_tokens
      const stepCost = estimateStepCost(metrics)
      const newCost = run.estimated_cost_usd + stepCost

      store.updateRun(resolvedRunId, {
        total_tokens: newTokens,
        estimated_cost_usd: newCost,
      })

      // Update telemetry.yaml
      appendStepToTelemetryYaml(outputDir, {
        step_name,
        model: metrics.model,
        input_tokens: metrics.input_tokens,
        output_tokens: metrics.output_tokens,
        duration_ms: metrics.duration_ms,
        status: metrics.status,
        completed_at: new Date().toISOString(),
      })
    }
  }
}

/**
 * Record pipeline completion
 */
export async function recordPipelineComplete(
  run_id: string,
  metrics: Partial<RunMetrics>,
  store: TelemetryStore,
  outputDir: string
): Promise<void> {
  const run = store.getRun(run_id)
  if (!run) return

  const wallClockMs = metrics.wall_clock_ms ?? (Date.now() - run.started_at)

  store.updateRun(run_id, {
    total_tokens: metrics.total_tokens ?? run.total_tokens,
    estimated_cost_usd: metrics.estimated_cost_usd ?? run.estimated_cost_usd,
    wall_clock_ms: wallClockMs,
    quality_score: metrics.quality_score,
    completed_at: Date.now(),
  })

  // Update daily aggregates
  const date = new Date().toISOString().split('T')[0]
  updateDailyAggregate(date, store)

  // Finalize telemetry.yaml
  finalizeTelemetryYaml(outputDir, {
    ...metrics,
    completed_at: new Date().toISOString(),
    wall_clock_ms: wallClockMs,
  })
}

/**
 * Get daily aggregates for the last N days
 */
export async function getDailyAggregates(
  days: number,
  store: TelemetryStore
): Promise<DailyAggregate[]> {
  const endDate = new Date().toISOString().split('T')[0]
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  return store.getDailyRange(startDate, endDate)
}

/**
 * Estimate cost for a step
 */
export function estimateStepCost(metrics: StepMetrics): number {
  const modelKey = metrics.model?.toLowerCase() ?? 'default'
  const costs = MODEL_COSTS[modelKey] ?? DEFAULT_MODEL_COST

  const inputCost = (metrics.input_tokens / 1_000_000) * costs.input
  const outputCost = (metrics.output_tokens / 1_000_000) * costs.output

  return inputCost + outputCost
}

/**
 * Update daily aggregate
 */
function updateDailyAggregate(date: string, store: TelemetryStore): void {
  // Get all runs for this date
  const startOfDay = new Date(date).getTime()
  const endOfDay = startOfDay + 24 * 60 * 60 * 1000

  // Query runs from telemetry_runs
  const runs = store.getRunsByDateRange(startOfDay, endOfDay)

  if (runs.length === 0) return

  const totalTokens = runs.reduce((sum, r) => sum + r.total_tokens, 0)
  const totalCost = runs.reduce((sum, r) => sum + r.estimated_cost_usd, 0)
  const runsWithWallClock = runs.filter(r => r.wall_clock_ms != null)
  const runsWithQuality = runs.filter(r => r.quality_score != null)
  const avgWallClock = runsWithWallClock.length > 0
    ? runsWithWallClock.reduce((sum, r) => sum + (r.wall_clock_ms ?? 0), 0) / runsWithWallClock.length
    : 0
  const avgQuality = runsWithQuality.length > 0
    ? runsWithQuality.reduce((sum, r) => sum + (r.quality_score ?? 0), 0) / runsWithQuality.length
    : 0

  store.upsertDaily({
    date,
    total_runs: runs.length,
    total_tokens: totalTokens,
    total_cost_usd: totalCost,
    avg_wall_clock_ms: avgWallClock || null,
    avg_quality_score: avgQuality || null,
  })
}

/**
 * Write telemetry.yaml
 */
function writeTelemetryYaml(outputDir: string, data: Record<string, unknown>): void {
  try {
    const yamlPath = path.join(outputDir, 'telemetry.yaml')
    fs.mkdirSync(outputDir, { recursive: true })
    fs.writeFileSync(yamlPath, yaml.dump(data))
  } catch {
    // Best-effort write
  }
}

/**
 * Append step to telemetry.yaml
 */
function appendStepToTelemetryYaml(outputDir: string, step: Record<string, unknown>): void {
  try {
    const yamlPath = path.join(outputDir, 'telemetry.yaml')
    if (!fs.existsSync(yamlPath)) return

    const content = fs.readFileSync(yamlPath, 'utf-8')
    const data = yaml.load(content) as Record<string, unknown>
    const steps = (data.steps as Array<Record<string, unknown>>) ?? []
    steps.push(step)
    data.steps = steps

    fs.writeFileSync(yamlPath, yaml.dump(data))
  } catch {
    // Best-effort write
  }
}

/**
 * Finalize telemetry.yaml
 */
function finalizeTelemetryYaml(outputDir: string, metrics: Record<string, unknown>): void {
  try {
    const yamlPath = path.join(outputDir, 'telemetry.yaml')
    if (!fs.existsSync(yamlPath)) return

    const content = fs.readFileSync(yamlPath, 'utf-8')
    const data = yaml.load(content) as Record<string, unknown>

    Object.assign(data, metrics)

    fs.writeFileSync(yamlPath, yaml.dump(data))
  } catch {
    // Best-effort write
  }
}

/**
 * Get cost summary by model and pipeline
 */
export function getCostSummary(store: TelemetryStore): {
  byModel: Array<{ model: string; runs: number; tokens: number; cost: number }>
  byPipeline: Array<{ pipeline: string; runs: number; tokens: number; cost: number }>
} {
  const db = (store as unknown as { db: SQLiteDatabase }).db

  // MED-011: Calculate cost from tokens using MODEL_COSTS instead of SQL placeholder
  // By model - calculate cost in JS after fetching tokens
  const byModelRows = db.prepare(`
    SELECT model, COUNT(*) as runs, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens
    FROM telemetry_steps
    WHERE model IS NOT NULL
    GROUP BY model
  `).all() as Array<{ model: string; runs: number; input_tokens: number; output_tokens: number }>

  const byModel = byModelRows.map(row => {
    const modelKey = row.model.toLowerCase()
    const costs = MODEL_COSTS[modelKey] ?? DEFAULT_MODEL_COST
    const inputCost = (row.input_tokens / 1_000_000) * costs.input
    const outputCost = (row.output_tokens / 1_000_000) * costs.output
    return {
      model: row.model,
      runs: row.runs,
      tokens: row.input_tokens + row.output_tokens,
      cost: inputCost + outputCost,
    }
  }).sort((a, b) => b.cost - a.cost)

  // By pipeline
  const byPipeline = db.prepare(`
    SELECT pipeline_type as pipeline, COUNT(*) as runs,
           SUM(total_tokens) as tokens, SUM(estimated_cost_usd) as cost
    FROM telemetry_runs
    GROUP BY pipeline_type
    ORDER BY cost DESC
  `).all() as Array<{ pipeline: string; runs: number; tokens: number; cost: number }>

  return { byModel, byPipeline }
}
