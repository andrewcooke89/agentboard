import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import {
  createTelemetryStore,
  recordPipelineStart,
  recordStepStart,
  recordStepComplete,
  recordPipelineComplete,
  getDailyAggregates,
  estimateStepCost,
} from '../telemetryCollector'
import type { StepMetrics } from '../telemetryCollector'

describe('telemetryCollector', () => {
  let db: SQLiteDatabase
  let store: ReturnType<typeof createTelemetryStore>
  let tempDir: string

  beforeEach(() => {
    db = new SQLiteDatabase(':memory:')
    store = createTelemetryStore(db)
    tempDir = fs.mkdtempSync('/tmp/telemetry-test-')
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('createTelemetryStore', () => {
    test('creates telemetry tables', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'telemetry%'")
        .all() as Array<{ name: string }>
      const names = tables.map(t => t.name).sort()
      expect(names).toContain('telemetry_runs')
      expect(names).toContain('telemetry_steps')
      expect(names).toContain('telemetry_daily')
    })

    test('insertRun and getRun', () => {
      store.insertRun({
        run_id: 'run-123',
        pipeline_type: 'change-pipeline',
        tier: 2,
        total_tokens: 0,
        estimated_cost_usd: 0,
        wall_clock_ms: null,
        quality_score: null,
        completed_at: null,
      })

      const record = store.getRun('run-123')
      expect(record).not.toBeNull()
      expect(record?.run_id).toBe('run-123')
      expect(record?.pipeline_type).toBe('change-pipeline')
      expect(record?.tier).toBe(2)
      expect(record?.started_at).toBeGreaterThan(0)
    })

    test('updateRun', () => {
      store.insertRun({
        run_id: 'run-456',
        pipeline_type: 'test',
        tier: 1,
        total_tokens: 0,
        estimated_cost_usd: 0,
        wall_clock_ms: null,
        quality_score: null,
        completed_at: null,
      })

      store.updateRun('run-456', {
        total_tokens: 1000,
        estimated_cost_usd: 0.05,
        wall_clock_ms: 5000,
        quality_score: 0.85,
        completed_at: Date.now(),
      })

      const record = store.getRun('run-456')
      expect(record?.total_tokens).toBe(1000)
      expect(record?.estimated_cost_usd).toBe(0.05)
      expect(record?.wall_clock_ms).toBe(5000)
      expect(record?.quality_score).toBe(0.85)
    })

    test('insertStep and getStepsByRun', () => {
      store.insertRun({
        run_id: 'run-steps',
        pipeline_type: 'test',
        tier: 1,
        total_tokens: 0,
        estimated_cost_usd: 0,
        wall_clock_ms: null,
        quality_score: null,
        completed_at: null,
      })

      const stepId = store.insertStep({
        run_id: 'run-steps',
        step_name: 'build',
        model: 'claude-3-5-sonnet',
        input_tokens: 500,
        output_tokens: 200,
        duration_ms: 3000,
        status: 'completed',
        completed_at: Date.now(),
      })

      expect(stepId).toBeGreaterThan(0)

      const steps = store.getStepsByRun('run-steps')
      expect(steps.length).toBe(1)
      expect(steps[0].step_name).toBe('build')
      expect(steps[0].input_tokens).toBe(500)
      expect(steps[0].output_tokens).toBe(200)
    })

    test('updateStep', () => {
      store.insertRun({
        run_id: 'run-update-step',
        pipeline_type: 'test',
        tier: 1,
        total_tokens: 0,
        estimated_cost_usd: 0,
        wall_clock_ms: null,
        quality_score: null,
        completed_at: null,
      })

      const stepId = store.insertStep({
        run_id: 'run-update-step',
        step_name: 'test',
        model: 'claude-3-5-sonnet',
        input_tokens: 100,
        output_tokens: 50,
        duration_ms: null,
        status: 'running',
        completed_at: null,
      })

      store.updateStep(stepId, {
        duration_ms: 2000,
        status: 'completed',
        completed_at: Date.now(),
      })

      const steps = store.getStepsByRun('run-update-step')
      expect(steps[0].duration_ms).toBe(2000)
      expect(steps[0].status).toBe('completed')
    })

    test('upsertDaily and getDaily', () => {
      const date = '2024-01-15'
      store.upsertDaily({
        date,
        total_runs: 5,
        total_tokens: 10000,
        total_cost_usd: 0.50,
        avg_wall_clock_ms: 30000,
        avg_quality_score: 0.9,
      })

      const record = store.getDaily(date)
      expect(record).not.toBeNull()
      expect(record?.total_runs).toBe(5)
      expect(record?.total_tokens).toBe(10000)
    })

    test('getDailyRange', () => {
      store.upsertDaily({ date: '2024-01-10', total_runs: 1, total_tokens: 100, total_cost_usd: 0.01, avg_wall_clock_ms: 1000, avg_quality_score: 0.8 })
      store.upsertDaily({ date: '2024-01-12', total_runs: 2, total_tokens: 200, total_cost_usd: 0.02, avg_wall_clock_ms: 2000, avg_quality_score: 0.85 })
      store.upsertDaily({ date: '2024-01-14', total_runs: 3, total_tokens: 300, total_cost_usd: 0.03, avg_wall_clock_ms: 3000, avg_quality_score: 0.9 })

      const records = store.getDailyRange('2024-01-10', '2024-01-14')
      expect(records.length).toBe(3)
    })
  })

  describe('recordPipelineStart', () => {
    test('records pipeline start', async () => {
      await recordPipelineStart('run-start', {
        pipeline_type: 'feature-branch',
        tier: 2,
      }, store, tempDir)

      const record = store.getRun('run-start')
      expect(record).not.toBeNull()
      expect(record?.pipeline_type).toBe('feature-branch')
      expect(record?.tier).toBe(2)
    })

    test('writes telemetry.yaml', async () => {
      await recordPipelineStart('run-yaml', {
        pipeline_type: 'yaml-test',
        tier: 1,
      }, store, tempDir)

      const yamlPath = path.join(tempDir, 'telemetry.yaml')
      expect(fs.existsSync(yamlPath)).toBe(true)

      const content = fs.readFileSync(yamlPath, 'utf-8')
      expect(content).toContain('run_id: run-yaml')
      expect(content).toContain('pipeline_type: yaml-test')
    })
  })

  describe('recordStepComplete', () => {
    test('records step completion', async () => {
      // Set up run first
      await recordPipelineStart('run-step-complete', {
        pipeline_type: 'test',
        tier: 1,
      }, store, tempDir)

      const metrics: StepMetrics = {
        step_name: 'build',
        model: 'claude-3-5-sonnet',
        input_tokens: 500,
        output_tokens: 200,
        duration_ms: 3000,
        status: 'completed',
      }

      await recordStepStart('build', 'run-step-complete')
      await recordStepComplete('build', metrics, store, tempDir)

      const steps = store.getStepsByRun('run-step-complete')
      expect(steps.length).toBe(1)
      expect(steps[0].step_name).toBe('build')
      expect(steps[0].model).toBe('claude-3-5-sonnet')
    })
  })

  describe('recordPipelineComplete', () => {
    test('records pipeline completion', async () => {
      await recordPipelineStart('run-complete', {
        pipeline_type: 'test',
        tier: 1,
      }, store, tempDir)

      // Add small delay to ensure wall_clock_ms > 0
      await new Promise(resolve => setTimeout(resolve, 10))

      await recordPipelineComplete('run-complete', {
        total_tokens: 1500,
        estimated_cost_usd: 0.10,
        quality_score: 0.95,
      }, store, tempDir)

      const record = store.getRun('run-complete')
      expect(record?.completed_at).not.toBeNull()
      expect(record?.wall_clock_ms).toBeGreaterThanOrEqual(0)
      expect(record?.quality_score).toBe(0.95)
    })
  })

  describe('getDailyAggregates', () => {
    test('returns daily aggregates', async () => {
      // Insert some daily data within the last 7 days
      const today = new Date().toISOString().split('T')[0]
      store.upsertDaily({
        date: today,
        total_runs: 3,
        total_tokens: 5000,
        total_cost_usd: 0.25,
        avg_wall_clock_ms: 15000,
        avg_quality_score: 0.88,
      })

      const aggregates = await getDailyAggregates(7, store)
      expect(aggregates.length).toBeGreaterThanOrEqual(1)
      expect(aggregates.find(a => a.date === today)).toBeDefined()
    })
  })

  describe('estimateStepCost', () => {
    test('estimates cost for claude-3-5-sonnet', () => {
      const cost = estimateStepCost({
        step_name: 'test',
        model: 'claude-3-5-sonnet',
        input_tokens: 1000000, // 1M tokens
        output_tokens: 1000000,
        duration_ms: 1000,
        status: 'completed',
      })

      // Input: $3/1M, Output: $15/1M = $3 + $15 = $18
      expect(cost).toBeCloseTo(18, 1)
    })

    test('estimates cost for gemini-2.0-flash', () => {
      const cost = estimateStepCost({
        step_name: 'test',
        model: 'gemini-2.0-flash',
        input_tokens: 1000000,
        output_tokens: 1000000,
        duration_ms: 1000,
        status: 'completed',
      })

      // Input: $0.1/1M, Output: $0.4/1M = $0.1 + $0.4 = $0.5
      expect(cost).toBeCloseTo(0.5, 2)
    })

    test('uses default cost for unknown model', () => {
      const cost = estimateStepCost({
        step_name: 'test',
        model: 'unknown-model',
        input_tokens: 1000000,
        output_tokens: 1000000,
        duration_ms: 1000,
        status: 'completed',
      })

      // Default: Input: $1/1M, Output: $2/1M = $1 + $2 = $3
      expect(cost).toBeCloseTo(3, 1)
    })
  })
})
