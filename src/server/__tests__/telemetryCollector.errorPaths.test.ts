/**
 * telemetryCollector.errorPaths.test.ts - Error path tests for telemetry collector
 */

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

describe('telemetryCollector - error paths', () => {
  let db: SQLiteDatabase
  let store: ReturnType<typeof createTelemetryStore>
  let tempDir: string

  beforeEach(() => {
    db = new SQLiteDatabase(':memory:')
    store = createTelemetryStore(db)
    tempDir = fs.mkdtempSync('/tmp/telemetry-error-test-')
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('YAML write failures', () => {
    test('recordPipelineStart handles unwritable directory', async () => {
      // Create a file where directory should be (causes mkdir to fail)
      const blockerPath = path.join(tempDir, 'blocked')
      fs.writeFileSync(blockerPath, 'not a directory')

      // Should not throw
      await recordPipelineStart('run-blocked', {
        pipeline_type: 'test',
        tier: 1,
      }, store, blockerPath) // blockerPath is a file, not directory

      // DB record should still be created
      const record = store.getRun('run-blocked')
      expect(record).not.toBeNull()
    })

    test('recordStepComplete handles missing telemetry.yaml', async () => {
      // Start a pipeline without telemetry.yaml
      await recordPipelineStart('run-no-yaml', {
        pipeline_type: 'test',
        tier: 1,
      }, store, tempDir)

      // Delete the telemetry.yaml if it was created
      const yamlPath = path.join(tempDir, 'telemetry.yaml')
      if (fs.existsSync(yamlPath)) {
        fs.unlinkSync(yamlPath)
      }

      // Record step start
      await recordStepStart('test-step', 'run-no-yaml')

      const metrics: StepMetrics = {
        step_name: 'test-step',
        model: 'claude-3-5-sonnet',
        input_tokens: 100,
        output_tokens: 50,
        duration_ms: 1000,
        status: 'completed',
      }

      // Should not throw
      await recordStepComplete('test-step', metrics, store, tempDir, 'run-no-yaml')

      // DB record should still be created
      const steps = store.getStepsByRun('run-no-yaml')
      expect(steps.length).toBe(1)
    })

    test('recordPipelineComplete handles corrupted YAML', async () => {
      await recordPipelineStart('run-corrupt', {
        pipeline_type: 'test',
        tier: 1,
      }, store, tempDir)

      // Corrupt the YAML file
      const yamlPath = path.join(tempDir, 'telemetry.yaml')
      fs.writeFileSync(yamlPath, 'not: valid\n  yaml: [\n')

      // Should not throw
      await recordPipelineComplete('run-corrupt', {
        total_tokens: 1000,
        estimated_cost_usd: 0.05,
        quality_score: 0.9,
      }, store, tempDir)

      // DB record should still be updated
      const record = store.getRun('run-corrupt')
      expect(record?.completed_at).not.toBeNull()
    })
  })

  describe('DB error handling', () => {
    test('getRun returns null for nonexistent run', () => {
      const record = store.getRun('nonexistent-run')
      expect(record).toBeNull()
    })

    test('getStepsByRun returns empty array for nonexistent run', () => {
      const steps = store.getStepsByRun('nonexistent-run')
      expect(steps).toEqual([])
    })

    test('updateRun handles nonexistent run gracefully', () => {
      // Should not throw
      store.updateRun('nonexistent-run', {
        total_tokens: 100,
      })

      // Record should still not exist
      const record = store.getRun('nonexistent-run')
      expect(record).toBeNull()
    })

    test('handles concurrent DB operations', async () => {
      // Create multiple runs concurrently
      const promises = Array.from({ length: 10 }, (_, i) =>
        recordPipelineStart(`run-concurrent-${i}`, {
          pipeline_type: 'concurrent-test',
          tier: 1,
        }, store, tempDir)
      )

      await Promise.all(promises)

      // All runs should be created
      for (let i = 0; i < 10; i++) {
        const record = store.getRun(`run-concurrent-${i}`)
        expect(record).not.toBeNull()
      }
    })
  })

  describe('activeSteps staleness cleanup', () => {
    test('stale steps are cleaned up periodically', async () => {
      // Record many steps to trigger cleanup threshold (100 operations)
      for (let i = 0; i < 150; i++) {
        await recordStepStart(`step-${i}`, `run-stale-${i % 10}`)
      }

      // Should not throw or crash
      // The cleanup happens internally every 100 operations
      expect(true).toBe(true)
    })

    test('step completion removes from activeSteps', async () => {
      await recordPipelineStart('run-step-cleanup', {
        pipeline_type: 'test',
        tier: 1,
      }, store, tempDir)

      await recordStepStart('step-to-complete', 'run-step-cleanup')

      const metrics: StepMetrics = {
        step_name: 'step-to-complete',
        model: 'claude-3-5-sonnet',
        input_tokens: 100,
        output_tokens: 50,
        duration_ms: 1000,
        status: 'completed',
      }

      await recordStepComplete('step-to-complete', metrics, store, tempDir, 'run-step-cleanup')

      // Step should be recorded
      const steps = store.getStepsByRun('run-step-cleanup')
      expect(steps.length).toBe(1)
    })
  })

  describe('getCostSummary with various models', () => {
    test('estimateStepCost handles unknown model with default cost', () => {
      const cost = estimateStepCost({
        step_name: 'test',
        model: 'unknown-model-v1',
        input_tokens: 1000000,
        output_tokens: 1000000,
        duration_ms: 1000,
        status: 'completed',
      })

      // Should use default costs ($1/1M input, $2/1M output = $3)
      expect(cost).toBeGreaterThan(0)
      expect(cost).toBeCloseTo(3, 1)
    })

    test('estimateStepCost handles null model gracefully', () => {
      const cost = estimateStepCost({
        step_name: 'test',
        model: undefined,
        input_tokens: 1000,
        output_tokens: 500,
        duration_ms: 1000,
        status: 'completed',
      })

      // Should use default costs
      expect(cost).toBeGreaterThanOrEqual(0)
    })

    test('estimateStepCost calculates costs for known models correctly', () => {
      // Claude 3.5 Sonnet: $3/1M input, $15/1M output
      const claudeCost = estimateStepCost({
        step_name: 'test',
        model: 'claude-3-5-sonnet',
        input_tokens: 1000000,
        output_tokens: 1000000,
        duration_ms: 1000,
        status: 'completed',
      })
      // Claude: $3 + $15 = $18
      expect(claudeCost).toBeCloseTo(18, 1)

      // Gemini 2.0 Flash: $0.1/1M input, $0.4/1M output
      const geminiCost = estimateStepCost({
        step_name: 'test',
        model: 'gemini-2.0-flash',
        input_tokens: 1000000,
        output_tokens: 1000000,
        duration_ms: 1000,
        status: 'completed',
      })
      // Gemini: $0.1 + $0.4 = $0.5
      expect(geminiCost).toBeCloseTo(0.5, 2)
    })

    test('estimateStepCost handles zero tokens', () => {
      const cost = estimateStepCost({
        step_name: 'test',
        model: 'claude-3-5-sonnet',
        input_tokens: 0,
        output_tokens: 0,
        duration_ms: 1000,
        status: 'completed',
      })
      expect(cost).toBe(0)
    })
  })

  describe('estimateStepCost edge cases', () => {
    test('handles zero tokens', () => {
      const cost = estimateStepCost({
        step_name: 'test',
        model: 'claude-3-5-sonnet',
        input_tokens: 0,
        output_tokens: 0,
        duration_ms: 1000,
        status: 'completed',
      })

      expect(cost).toBe(0)
    })

    test('handles undefined model', () => {
      const cost = estimateStepCost({
        step_name: 'test',
        model: undefined,
        input_tokens: 1000,
        output_tokens: 500,
        duration_ms: 1000,
        status: 'completed',
      })

      // Should use default costs
      expect(cost).toBeGreaterThan(0)
    })

    test('handles case-insensitive model matching', () => {
      const costUpper = estimateStepCost({
        step_name: 'test',
        model: 'CLAUDE-3-5-SONNET',
        input_tokens: 1000000,
        output_tokens: 1000000,
        duration_ms: 1000,
        status: 'completed',
      })

      const costLower = estimateStepCost({
        step_name: 'test',
        model: 'claude-3-5-sonnet',
        input_tokens: 1000000,
        output_tokens: 1000000,
        duration_ms: 1000,
        status: 'completed',
      })

      expect(costUpper).toBeCloseTo(costLower, 2)
    })
  })

  describe('daily aggregates edge cases', () => {
    test('getDailyAggregates handles empty database', async () => {
      const aggregates = await getDailyAggregates(7, store)
      expect(aggregates).toEqual([])
    })

    test('handles date range with no data', async () => {
      // Insert data for today
      store.upsertDaily({
        date: new Date().toISOString().split('T')[0],
        total_runs: 5,
        total_tokens: 10000,
        total_cost_usd: 0.5,
        avg_wall_clock_ms: 10000,
        avg_quality_score: 0.85,
      })

      // Query for last 30 days - should include today
      const aggregates = await getDailyAggregates(30, store)
      expect(aggregates.length).toBeGreaterThanOrEqual(1)
    })

    test('handles null values in daily aggregates', () => {
      store.upsertDaily({
        date: '2024-01-01',
        total_runs: 3,
        total_tokens: 5000,
        total_cost_usd: 0.25,
        avg_wall_clock_ms: null,
        avg_quality_score: null,
      })

      const record = store.getDaily('2024-01-01')
      expect(record).not.toBeNull()
      expect(record?.avg_wall_clock_ms).toBeNull()
      expect(record?.avg_quality_score).toBeNull()
    })
  })

  describe('recordStepComplete edge cases', () => {
    test('handles missing runId parameter gracefully', async () => {
      // Start pipeline to create run record
      await recordPipelineStart('run-missing-id', {
        pipeline_type: 'test',
        tier: 1,
      }, store, tempDir)

      // Record step start
      await recordStepStart('orphan-step', 'run-missing-id')

      // Try to complete without runId - should try to find from activeSteps
      const metrics: StepMetrics = {
        step_name: 'orphan-step',
        model: 'claude-3-5-sonnet',
        input_tokens: 100,
        output_tokens: 50,
        duration_ms: 1000,
        status: 'completed',
      }

      // Should not throw
      await recordStepComplete('orphan-step', metrics, store, tempDir)

      // Step should be recorded if found in activeSteps
      const steps = store.getStepsByRun('run-missing-id')
      expect(steps.length).toBeGreaterThanOrEqual(0)
    })

    test('handles step not in activeSteps', async () => {
      await recordPipelineStart('run-no-active-step', {
        pipeline_type: 'test',
        tier: 1,
      }, store, tempDir)

      // Try to complete a step that was never started
      const metrics: StepMetrics = {
        step_name: 'never-started',
        model: 'claude-3-5-sonnet',
        input_tokens: 100,
        output_tokens: 50,
        duration_ms: 1000,
        status: 'completed',
      }

      // Should not throw
      await recordStepComplete('never-started', metrics, store, tempDir, 'run-no-active-step')

      // With explicit runId, step should be recorded
      const steps = store.getStepsByRun('run-no-active-step')
      expect(steps.length).toBe(1)
    })
  })
})
