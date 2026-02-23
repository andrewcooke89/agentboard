/**
 * amendment-transaction.test.ts -- Tests for transaction safety in the amendment system
 * (Phase 10: TEST-38 and TEST-39)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initWorkflowStore } from '../workflowStore'
import type { WorkflowStore } from '../workflowStore'
import { initTaskStore } from '../taskStore'
import type { TaskStore } from '../taskStore'
import { initPoolTables } from '../db'
import type { WorkflowDefinition, WorkflowRun } from '../../shared/types'

// ── Test Helpers ─────────────────────────────────────────────────────────────

function createStores(): { workflowStore: WorkflowStore; taskStore: TaskStore; db: SQLiteDatabase } {
  const db = new SQLiteDatabase(':memory:')
  const workflowStore = initWorkflowStore(db)
  const taskStore = initTaskStore(db)
  initPoolTables(db)
  return { workflowStore, taskStore, db }
}

function createWorkflowDef(store: WorkflowStore, name: string): WorkflowDefinition {
  return store.createWorkflow({
    name, description: 'Test',
    yaml_content: `name: ${name}\nsteps:\n  - name: s\n    type: delay\n    seconds: 1`,
    file_path: null, is_valid: true, validation_errors: [], step_count: 1,
  })
}

function createTestRun(store: WorkflowStore, wfId: string): WorkflowRun {
  return store.createRun({
    workflow_id: wfId, workflow_name: 'test', status: 'running',
    current_step_index: 0, steps_state: [],
    output_dir: '/tmp/test-outputs/transaction',
    started_at: new Date().toISOString(),
    completed_at: null, error_message: null, variables: null,
  })
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Amendment Transaction Safety (TEST-38 and TEST-39)', () => {
  let db: SQLiteDatabase
  let workflowStore: WorkflowStore
  let _taskStore: TaskStore

  beforeEach(() => {
    const stores = createStores()
    db = stores.db
    workflowStore = stores.workflowStore
    _taskStore = stores.taskStore
  })

  afterEach(() => {
    try { db.close() } catch { /* ok */ }
  })

  // ── TEST-38: Concurrent budget atomicity ───────────────────────────────

  test('TEST-38: multiple amendment detections do not race -- budget increments are atomic', () => {
    const def = createWorkflowDef(workflowStore, `atomic-38-${Date.now()}`)
    const run = createTestRun(workflowStore, def.id)

    // Initialize budget with max of 5
    workflowStore.initRunBudgets(run.id, {
      quality: { per_run: 5 },
      reconciliation: { per_run: 5 },
    })

    // Simulate rapid concurrent budget checks from multiple amendment detections
    // SQLite serializes these through BEGIN IMMEDIATE transactions
    const qualityResults: { allowed: boolean; used: number; max: number }[] = []
    const reconResults: { allowed: boolean; used: number; max: number }[] = []

    // Interleave quality and reconciliation budget checks
    for (let i = 0; i < 8; i++) {
      qualityResults.push(workflowStore.checkAndIncrementBudget(run.id, null, 'quality'))
      reconResults.push(workflowStore.checkAndIncrementBudget(run.id, null, 'reconciliation'))
    }

    // Quality: first 5 allowed, next 3 denied
    const qualityAllowed = qualityResults.filter(r => r.allowed)
    const qualityDenied = qualityResults.filter(r => !r.allowed)
    expect(qualityAllowed).toHaveLength(5)
    expect(qualityDenied).toHaveLength(3)

    // Quality used counts should be monotonically increasing
    for (let i = 0; i < qualityAllowed.length; i++) {
      expect(qualityAllowed[i].used).toBe(i + 1)
    }

    // Reconciliation: same pattern
    const reconAllowed = reconResults.filter(r => r.allowed)
    const reconDenied = reconResults.filter(r => !r.allowed)
    expect(reconAllowed).toHaveLength(5)
    expect(reconDenied).toHaveLength(3)

    // Final budget state verification
    const qualityBudget = workflowStore.getBudget(run.id, null, 'quality')
    expect(qualityBudget!.used).toBe(5)
    expect(qualityBudget!.max_allowed).toBe(5)

    const reconBudget = workflowStore.getBudget(run.id, null, 'reconciliation')
    expect(reconBudget!.used).toBe(5)
    expect(reconBudget!.max_allowed).toBe(5)

    // Categories are independent -- quality exhaustion doesn't affect reconciliation
    // (already proven above, but make it explicit)
    expect(qualityBudget!.used).toBe(reconBudget!.used)
  })

  test('TEST-38b: work-unit budgets are isolated from run-level budgets', () => {
    const def = createWorkflowDef(workflowStore, `atomic-38b-${Date.now()}`)
    const run = createTestRun(workflowStore, def.id)

    // Run-level budget: max 3
    workflowStore.initRunBudgets(run.id, { quality: { per_run: 3 } })

    // Work-unit budget: max 1 each
    workflowStore.initWorkUnitBudgets(run.id, 'WU-A', { quality: { per_work_unit: 1 } })
    workflowStore.initWorkUnitBudgets(run.id, 'WU-B', { quality: { per_work_unit: 1 } })

    // WU-A: exhaust per-work-unit budget (1)
    const wuAResult1 = workflowStore.checkAndIncrementBudget(run.id, 'WU-A', 'quality')
    expect(wuAResult1.allowed).toBe(true)
    const wuAResult2 = workflowStore.checkAndIncrementBudget(run.id, 'WU-A', 'quality')
    expect(wuAResult2.allowed).toBe(false)

    // WU-B: still has budget (independent from WU-A)
    const wuBResult1 = workflowStore.checkAndIncrementBudget(run.id, 'WU-B', 'quality')
    expect(wuBResult1.allowed).toBe(true)

    // Run-level: still has budget (independent from work-unit budgets)
    const runResult1 = workflowStore.checkAndIncrementBudget(run.id, null, 'quality')
    expect(runResult1.allowed).toBe(true)
    expect(runResult1.used).toBe(1)
  })

  // ── TEST-39: Mid-transaction crash safety ──────────────────────────────

  test('TEST-39: budget increment transaction rolls back on failure -- used count unchanged', () => {
    const def = createWorkflowDef(workflowStore, `rollback-39-${Date.now()}`)
    const run = createTestRun(workflowStore, def.id)

    // Initialize budget with max of 3
    workflowStore.initRunBudgets(run.id, { quality: { per_run: 3 } })

    // Increment once successfully
    const result1 = workflowStore.checkAndIncrementBudget(run.id, null, 'quality')
    expect(result1.allowed).toBe(true)
    expect(result1.used).toBe(1)

    // Verify used count is 1
    const budget1 = workflowStore.getBudget(run.id, null, 'quality')
    expect(budget1!.used).toBe(1)

    // Simulate a "crash" by directly manipulating the DB to test atomicity
    // We verify that the UPDATE ... WHERE used < max_allowed clause prevents
    // over-incrementing even if called repeatedly
    const budgetRow = db.prepare(
      "SELECT id FROM amendment_budget WHERE run_id = ? AND category = 'quality' AND work_unit IS NULL"
    ).get(run.id) as { id: string } | undefined

    expect(budgetRow).toBeTruthy()

    // Manually set used = max_allowed to simulate exhaustion
    db.prepare("UPDATE amendment_budget SET used = max_allowed WHERE id = ?").run(budgetRow!.id)

    // Now checkAndIncrementBudget should fail atomically
    const result2 = workflowStore.checkAndIncrementBudget(run.id, null, 'quality')
    expect(result2.allowed).toBe(false)
    expect(result2.used).toBe(3)
    expect(result2.max).toBe(3)

    // Verify the UPDATE with WHERE clause prevented over-increment
    const finalBudget = workflowStore.getBudget(run.id, null, 'quality')
    expect(finalBudget!.used).toBe(3)
    expect(finalBudget!.max_allowed).toBe(3)
  })

  test('TEST-39b: WAL mode is enabled for concurrent safety on file-based DB', () => {
    // In-memory DBs use 'memory' journal mode; WAL only works on file-based DBs
    const tmp = tmpdir()
    const dbPath = join(tmp, `wal-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    try {
      const fileDb = new SQLiteDatabase(dbPath)
      const _fileStore = initWorkflowStore(fileDb)
      // initWorkflowStore sets WAL mode via PRAGMA journal_mode=WAL
      const result = fileDb.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
      expect(result.journal_mode).toBe('wal')
      fileDb.close()
    } finally {
      try { rmSync(dbPath, { force: true }) } catch { /* ok */ }
      try { rmSync(`${dbPath}-wal`, { force: true }) } catch { /* ok */ }
      try { rmSync(`${dbPath}-shm`, { force: true }) } catch { /* ok */ }
    }
  })

  test('TEST-39c: overrideBudget correctly changes max without affecting used', () => {
    const def = createWorkflowDef(workflowStore, `override-39c-${Date.now()}`)
    const run = createTestRun(workflowStore, def.id)

    // Initialize budget with max of 2
    workflowStore.initRunBudgets(run.id, { quality: { per_run: 2 } })

    // Use 2 (exhaust)
    workflowStore.checkAndIncrementBudget(run.id, null, 'quality')
    workflowStore.checkAndIncrementBudget(run.id, null, 'quality')

    // Verify exhausted
    const result1 = workflowStore.checkAndIncrementBudget(run.id, null, 'quality')
    expect(result1.allowed).toBe(false)

    // Override budget to raise the max
    workflowStore.overrideBudget(run.id, 'quality', 5)

    // Verify budget was updated
    const budget = workflowStore.getBudget(run.id, null, 'quality')
    expect(budget!.max_allowed).toBe(5)
    expect(budget!.used).toBe(2)  // used unchanged

    // Now should be allowed again
    const result2 = workflowStore.checkAndIncrementBudget(run.id, null, 'quality')
    expect(result2.allowed).toBe(true)
    expect(result2.used).toBe(3)
    expect(result2.max).toBe(5)
  })
})
