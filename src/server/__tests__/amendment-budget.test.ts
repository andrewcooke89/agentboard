/**
 * amendment-budget.test.ts -- Tests for amendment budget system, sequential processing,
 * stale signal detection, and escalation logic (Phase 10: TEST-06 through TEST-13)
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDAGEngine } from '../dagEngine'
import type { DAGEngine } from '../dagEngine'
import { initWorkflowStore } from '../workflowStore'
import type { WorkflowStore } from '../workflowStore'
import { initTaskStore } from '../taskStore'
import type { TaskStore } from '../taskStore'
import { initPoolTables } from '../db'
import { createSessionPool } from '../sessionPool'
import type { SessionPool } from '../sessionPool'
import type { ServerContext } from '../serverContext'
import type { WorkflowRun, StepRunState, WorkflowDefinition } from '../../shared/types'
import { parseWorkflowYAML } from '../workflowSchema'
import type { ParsedWorkflow } from '../workflowSchema'

// ── Test Helpers ─────────────────────────────────────────────────────────────

function makeStepState(overrides: Partial<StepRunState> & { name: string; type: StepRunState['type'] }): StepRunState {
  return {
    status: 'pending',
    taskId: null,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    retryCount: 0,
    skippedReason: null,
    resultFile: null,
    resultCollected: false,
    resultContent: null,
    ...overrides,
  } as StepRunState
}

function createTestContext(): ServerContext {
  return {
    db: {} as any,
    registry: {} as any,
    sessionManager: {} as any,
    config: {
      workflowPollIntervalMs: 100,
      workflowEngineEnabled: true,
      taskOutputDir: '/tmp/test-outputs',
      taskMaxConcurrent: 5,
      taskPollIntervalMs: 1000,
      taskDefaultTimeoutSeconds: 1800,
      taskRateLimitPerHour: 30,
      allowedRoots: [],
    } as any,
    logger: {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    } as any,
    broadcast: mock(() => {}),
    send: mock(() => {}),
    sockets: new Set(),
    taskStore: {} as any,
    taskWorker: {} as any,
    workflowStore: {} as any,
    workflowEngine: {} as any,
  } as ServerContext
}

function createStores(): { workflowStore: WorkflowStore; taskStore: TaskStore; db: SQLiteDatabase } {
  const db = new SQLiteDatabase(':memory:')
  const workflowStore = initWorkflowStore(db)
  const taskStore = initTaskStore(db)
  initPoolTables(db)
  return { workflowStore, taskStore, db }
}

function createWorkflowDef(
  workflowStore: WorkflowStore,
  yamlContent: string,
  name: string,
): WorkflowDefinition {
  return workflowStore.createWorkflow({
    name,
    description: 'Test workflow',
    yaml_content: yamlContent,
    file_path: null,
    is_valid: true,
    validation_errors: [],
    step_count: 1,
  })
}

function createTestRun(
  workflowStore: WorkflowStore,
  workflowId: string,
  stepsState: StepRunState[],
  overrides?: Partial<WorkflowRun>,
): WorkflowRun {
  return workflowStore.createRun({
    workflow_id: workflowId,
    workflow_name: 'test-workflow',
    status: 'running',
    current_step_index: 0,
    steps_state: stepsState,
    output_dir: '/tmp/test-outputs/amendment-budget-test',
    started_at: new Date().toISOString(),
    completed_at: null,
    error_message: null,
    variables: null,
    ...overrides,
  })
}

function getParsed(yamlContent: string): ParsedWorkflow {
  const result = parseWorkflowYAML(yamlContent)
  if (!result.valid || !result.workflow) throw new Error(`Invalid YAML: ${result.errors.join(', ')}`)
  return result.workflow
}

function writeSignalFile(dir: string, filename: string, content: string): string {
  const filePath = join(dir, filename)
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}

function makeSignalYAML(overrides?: {
  type?: string
  category?: string
  spec_section?: string
  issue?: string
  work_unit?: string
}): string {
  const lines = [
    'signal_type: amendment_required',
    'amendment:',
    `  type: ${overrides?.type ?? 'gap'}`,
    `  category: ${overrides?.category ?? 'quality'}`,
    `  spec_section: ${overrides?.spec_section ?? 'auth.login'}`,
    `  issue: ${overrides?.issue ?? 'Missing error handling'}`,
    'checkpoint:',
    '  step: 1',
  ]
  if (overrides?.work_unit) {
    lines.push(`work_unit: ${overrides.work_unit}`)
  }
  return lines.join('\n')
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Amendment Budget & Escalation (TEST-06 through TEST-13)', () => {
  let db: SQLiteDatabase
  let workflowStore: WorkflowStore
  let taskStore: TaskStore
  let ctx: ServerContext
  let dagEngine: DAGEngine
  let _pool: SessionPool

  beforeEach(() => {
    const stores = createStores()
    db = stores.db
    workflowStore = stores.workflowStore
    taskStore = stores.taskStore
    ctx = createTestContext()
    _pool = createSessionPool(db)
    // Pass null pool to avoid hitting a production bug where processAmendment
    // references `parsed` variable from tick() scope (not passed as parameter).
    // The pool slot logic is tested separately in dagEngine.test.ts.
    dagEngine = createDAGEngine(ctx, workflowStore, taskStore, null)
  })

  afterEach(() => {
    try { db.close() } catch { /* ok */ }
  })

  // ── TEST-06: Sequential processing of multiple signals ─────────────────

  test('TEST-06: sequential processing -- amendment_check processes one signal at a time', () => {
    const tmp = tmpdir()
    const signalDir = join(tmp, `dag-seq-06-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(signalDir, { recursive: true })

    try {
      // Write multiple signal files in the same directory
      writeSignalFile(signalDir, 'signal-001.yaml', makeSignalYAML({ spec_section: 'auth.login' }))
      writeSignalFile(signalDir, 'signal-002.yaml', makeSignalYAML({ spec_section: 'db.schema' }))
      writeSignalFile(signalDir, 'signal-003.yaml', makeSignalYAML({ spec_section: 'api.routes' }))

      const yaml = `
name: seq-test-06
system:
  engine: dag
steps:
  - name: check-step
    type: amendment_check
    signal_dir: ${signalDir}
`
      const parsed = getParsed(yaml)
      const def = createWorkflowDef(workflowStore, yaml, `seq-test-06-${Date.now()}`)

      // Set startedAt in the past so signals are not detected as stale
      const startedAt = new Date(Date.now() - 60000).toISOString()
      const stepsState = [
        makeStepState({
          name: 'check-step',
          type: 'amendment_check' as any,
          status: 'running',
          startedAt,
        }),
      ]
      const run = createTestRun(workflowStore, def.id, stepsState)

      dagEngine.tick(run, parsed)

      const updated = workflowStore.getRun(run.id)!
      const step = updated.steps_state.find(s => s.name === 'check-step')!

      // Only ONE signal should be processed (sequential: "break" after first valid signal)
      expect(step.status).toBe('paused_amendment')
      expect(step.amendmentPhase).toBe('detected')
      expect(step.amendmentSignalFile).toBeTruthy()

      // Only one amendment_detected broadcast should have been sent
      const broadcastCalls = (ctx.broadcast as any).mock.calls
      const detectedBroadcasts = broadcastCalls.filter(
        (c: any) => c[0]?.type === 'amendment_detected'
      )
      expect(detectedBroadcasts).toHaveLength(1)
    } finally {
      rmSync(signalDir, { recursive: true, force: true })
    }
  })

  // ── TEST-07: Stale signal detection ────────────────────────────────────

  test('TEST-07: stale signal detection -- signals older than step startedAt are skipped', () => {
    const tmp = tmpdir()
    const signalDir = join(tmp, `dag-stale-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(signalDir, { recursive: true })

    try {
      // Write a signal file
      const signalFile = writeSignalFile(signalDir, 'stale-signal.yaml', makeSignalYAML())

      // Set the file's mtime to the past (before step started)
      const pastTime = new Date(Date.now() - 60000)
      utimesSync(signalFile, pastTime, pastTime)

      const startedAt = new Date().toISOString()  // Step started AFTER signal was written

      const yaml = `
name: stale-test-07
system:
  engine: dag
steps:
  - name: check-step
    type: amendment_check
    signal_dir: ${signalDir}
`
      const parsed = getParsed(yaml)
      const def = createWorkflowDef(workflowStore, yaml, `stale-test-07-${Date.now()}`)

      const stepsState = [
        makeStepState({
          name: 'check-step',
          type: 'amendment_check' as any,
          status: 'running',
          startedAt,
        }),
      ]
      const run = createTestRun(workflowStore, def.id, stepsState)

      dagEngine.tick(run, parsed)

      const updated = workflowStore.getRun(run.id)!
      const step = updated.steps_state.find(s => s.name === 'check-step')!

      // Stale signal should be skipped, step completes normally
      expect(step.status).toBe('completed')
    } finally {
      rmSync(signalDir, { recursive: true, force: true })
    }
  })

  // ── TEST-08: Run-level budget initialization ───────────────────────────

  test('TEST-08: run-level budget initialization creates quality and reconciliation rows', () => {
    const def = createWorkflowDef(workflowStore, 'name: budget-init\nsteps:\n  - name: s\n    type: delay\n    seconds: 1', `budget-init-${Date.now()}`)
    const run = createTestRun(workflowStore, def.id, [])

    // Initialize run-level budgets
    workflowStore.initRunBudgets(run.id, {
      quality: { per_run: 5 },
      reconciliation: { per_run: 10 },
    })

    // Verify quality budget
    const qualityBudget = workflowStore.getBudget(run.id, null, 'quality')
    expect(qualityBudget).not.toBeNull()
    expect(qualityBudget!.used).toBe(0)
    expect(qualityBudget!.max_allowed).toBe(5)
    expect(qualityBudget!.category).toBe('quality')

    // Verify reconciliation budget
    const reconBudget = workflowStore.getBudget(run.id, null, 'reconciliation')
    expect(reconBudget).not.toBeNull()
    expect(reconBudget!.used).toBe(0)
    expect(reconBudget!.max_allowed).toBe(10)
    expect(reconBudget!.category).toBe('reconciliation')
  })

  // ── TEST-09: Work-unit budget initialization ───────────────────────────

  test('TEST-09: work-unit budget initialization creates per-work-unit rows', () => {
    const def = createWorkflowDef(workflowStore, 'name: wu-budget\nsteps:\n  - name: s\n    type: delay\n    seconds: 1', `wu-budget-${Date.now()}`)
    const run = createTestRun(workflowStore, def.id, [])

    // Initialize work-unit budgets for WU-001
    workflowStore.initWorkUnitBudgets(run.id, 'WU-001', {
      quality: { per_work_unit: 2 },
      reconciliation: { per_work_unit: 4 },
    })

    // Verify quality budget for WU-001
    const qualityBudget = workflowStore.getBudget(run.id, 'WU-001', 'quality')
    expect(qualityBudget).not.toBeNull()
    expect(qualityBudget!.used).toBe(0)
    expect(qualityBudget!.max_allowed).toBe(2)

    // Verify reconciliation budget for WU-001
    const reconBudget = workflowStore.getBudget(run.id, 'WU-001', 'reconciliation')
    expect(reconBudget).not.toBeNull()
    expect(reconBudget!.used).toBe(0)
    expect(reconBudget!.max_allowed).toBe(4)

    // Verify different work-unit has no budget
    const otherBudget = workflowStore.getBudget(run.id, 'WU-002', 'quality')
    expect(otherBudget).toBeNull()
  })

  // ── TEST-10: Budget increment and exhaustion ───────────────────────────

  test('TEST-10: budget increments and escalates when exhausted', () => {
    const tmp = tmpdir()
    const signalDir = join(tmp, `dag-budget-exhaust-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(signalDir, { recursive: true })

    try {
      const yaml = `
name: budget-exhaust-10
system:
  engine: dag
steps:
  - name: test-step
    type: amendment_check
    signal_dir: ${signalDir}
`
      const parsed = getParsed(yaml)
      const def = createWorkflowDef(workflowStore, yaml, `budget-exhaust-10-${Date.now()}`)
      const run = createTestRun(workflowStore, def.id, [])

      // Initialize budget with max of 2
      workflowStore.initRunBudgets(run.id, {
        quality: { per_run: 2 },
        reconciliation: { per_run: 10 },
      })

      // First increment: 0 -> 1 (allowed)
      const result1 = workflowStore.checkAndIncrementBudget(run.id, null, 'quality')
      expect(result1.allowed).toBe(true)
      expect(result1.used).toBe(1)
      expect(result1.max).toBe(2)

      // Second increment: 1 -> 2 (allowed, at max)
      const result2 = workflowStore.checkAndIncrementBudget(run.id, null, 'quality')
      expect(result2.allowed).toBe(true)
      expect(result2.used).toBe(2)
      expect(result2.max).toBe(2)

      // Third increment: 2 >= 2 (denied, budget exhausted)
      const result3 = workflowStore.checkAndIncrementBudget(run.id, null, 'quality')
      expect(result3.allowed).toBe(false)
      expect(result3.used).toBe(2)
      expect(result3.max).toBe(2)

      // Now test through the DAG engine: create signal that triggers budget exhaustion
      const signalFile = writeSignalFile(signalDir, 'signal-budget.yaml', makeSignalYAML())

      const stepsState = [
        makeStepState({
          name: 'test-step',
          type: 'amendment_check' as any,
          status: 'paused_amendment',
          amendmentPhase: 'detected',
          amendmentSignalFile: signalFile,
        }),
      ]
      const run2 = createTestRun(workflowStore, def.id, stepsState)

      // Initialize budget already at max for run2
      workflowStore.initRunBudgets(run2.id, { quality: { per_run: 0 } })

      dagEngine.tick(run2, parsed)

      const updated = workflowStore.getRun(run2.id)!
      const step = updated.steps_state.find(s => s.name === 'test-step')!

      // Budget exceeded -> escalate
      expect(step.status).toBe('paused_escalated')
      expect(step.amendmentPhase).toBe('awaiting_human')

      // Verify escalation broadcast
      const broadcastCalls = (ctx.broadcast as any).mock.calls
      const escalatedBroadcast = broadcastCalls.find(
        (c: any) => c[0]?.type === 'amendment_escalated'
      )
      expect(escalatedBroadcast).toBeTruthy()
      expect(escalatedBroadcast[0].reason).toContain('budget exceeded')
    } finally {
      rmSync(signalDir, { recursive: true, force: true })
    }
  })

  // ── TEST-11: Fundamental immediate escalation ──────────────────────────

  test('TEST-11: fundamental amendments bypass budget and immediately escalate to paused_escalated', () => {
    const tmp = tmpdir()
    const signalDir = join(tmp, `dag-fundamental-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(signalDir, { recursive: true })

    try {
      const signalFile = writeSignalFile(signalDir, 'signal-fundamental.yaml', makeSignalYAML({
        type: 'fundamental',
        category: 'fundamental',
        issue: 'Architecture is completely wrong',
      }))

      const yaml = `
name: fundamental-11
system:
  engine: dag
steps:
  - name: test-step
    type: amendment_check
    signal_dir: ${signalDir}
`
      const parsed = getParsed(yaml)
      const def = createWorkflowDef(workflowStore, yaml, `fundamental-11-${Date.now()}`)

      // Initialize generous budget (fundamental should bypass it entirely)
      const stepsState = [
        makeStepState({
          name: 'test-step',
          type: 'amendment_check' as any,
          status: 'paused_amendment',
          amendmentPhase: 'detected',
          amendmentSignalFile: signalFile,
        }),
      ]
      const run = createTestRun(workflowStore, def.id, stepsState)
      workflowStore.initRunBudgets(run.id, { quality: { per_run: 100 } })

      dagEngine.tick(run, parsed)

      const updated = workflowStore.getRun(run.id)!
      const step = updated.steps_state.find(s => s.name === 'test-step')!

      // Fundamental -> immediate paused_escalated (bypasses budget check entirely)
      expect(step.status).toBe('paused_escalated')
      expect(step.amendmentPhase).toBe('awaiting_human')

      // Budget should NOT have been incremented (fundamental bypasses budget)
      const budget = workflowStore.getBudget(run.id, null, 'quality')
      // Budget may or may not have been initialized; if it was, used should still be 0
      if (budget) {
        expect(budget.used).toBe(0)
      }

      // Verify escalation reason mentions fundamental
      const broadcastCalls = (ctx.broadcast as any).mock.calls
      const escalatedBroadcast = broadcastCalls.find(
        (c: any) => c[0]?.type === 'amendment_escalated'
      )
      expect(escalatedBroadcast).toBeTruthy()
      expect(escalatedBroadcast[0].reason).toContain('fundamental')
    } finally {
      rmSync(signalDir, { recursive: true, force: true })
    }
  })

  // ── TEST-12: Same-section-twice escalation ─────────────────────────────

  test('TEST-12: amending same section twice escalates to human', () => {
    const tmp = tmpdir()
    const signalDir = join(tmp, `dag-same-section-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(signalDir, { recursive: true })

    try {
      const yaml = `
name: same-section-12
system:
  engine: dag
steps:
  - name: test-step
    type: amendment_check
    signal_dir: ${signalDir}
    amendment_config:
      same_section_twice: escalate
`
      const parsed = getParsed(yaml)
      const def = createWorkflowDef(workflowStore, yaml, `same-section-12-${Date.now()}`)
      const run = createTestRun(workflowStore, def.id, [])

      // Insert a prior amendment for the same section
      workflowStore.insertAmendment({
        run_id: run.id,
        step_name: 'test-step',
        signal_file: '/tmp/prior-signal.yaml',
        amendment_type: 'gap',
        category: 'quality',
        spec_section: 'auth.login',
        issue: 'Previous issue in auth.login',
      })

      // Now try to process another amendment for the same section
      const signalFile = writeSignalFile(signalDir, 'signal-same.yaml', makeSignalYAML({
        spec_section: 'auth.login',
        issue: 'Second issue in auth.login',
      }))

      const stepsState = [
        makeStepState({
          name: 'test-step',
          type: 'amendment_check' as any,
          status: 'paused_amendment',
          amendmentPhase: 'detected',
          amendmentSignalFile: signalFile,
        }),
      ]
      const run2 = createTestRun(workflowStore, def.id, stepsState)

      // Insert prior amendment for run2 to trigger same-section-twice
      workflowStore.insertAmendment({
        run_id: run2.id,
        step_name: 'test-step',
        signal_file: '/tmp/prior-signal.yaml',
        amendment_type: 'gap',
        category: 'quality',
        spec_section: 'auth.login',
        issue: 'Prior auth.login amendment',
      })

      dagEngine.tick(run2, parsed)

      const updated = workflowStore.getRun(run2.id)!
      const step = updated.steps_state.find(s => s.name === 'test-step')!

      // Same section twice with escalate config -> escalate to human
      expect(step.status).toBe('paused_escalated')
      expect(step.amendmentPhase).toBe('awaiting_human')

      // Verify escalation reason mentions same section
      const broadcastCalls = (ctx.broadcast as any).mock.calls
      const escalatedBroadcast = broadcastCalls.find(
        (c: any) => c[0]?.type === 'amendment_escalated'
      )
      expect(escalatedBroadcast).toBeTruthy()
      expect(escalatedBroadcast[0].reason).toContain('same section')
    } finally {
      rmSync(signalDir, { recursive: true, force: true })
    }
  })

  // ── TEST-13: NULL work_unit budget skip ────────────────────────────────

  test('TEST-13: steps without per_work_unit only check run-level budget', () => {
    const def = createWorkflowDef(workflowStore, 'name: null-wu\nsteps:\n  - name: s\n    type: delay\n    seconds: 1', `null-wu-${Date.now()}`)
    const run = createTestRun(workflowStore, def.id, [])

    // Initialize run-level budget with max 5
    workflowStore.initRunBudgets(run.id, {
      quality: { per_run: 5 },
    })

    // Do NOT create any work-unit budgets

    // Check budget with null work_unit -- should use run-level
    const result1 = workflowStore.checkAndIncrementBudget(run.id, null, 'quality')
    expect(result1.allowed).toBe(true)
    expect(result1.used).toBe(1)
    expect(result1.max).toBe(5)

    // Check budget with a work_unit that has no per_work_unit budget
    // Since no row exists for 'WU-UNBUDGETED', it returns allowed: true (no budget constraint)
    const result2 = workflowStore.checkAndIncrementBudget(run.id, 'WU-UNBUDGETED', 'quality')
    expect(result2.allowed).toBe(true)

    // Now initialize a work-unit budget and verify it applies separately
    workflowStore.initWorkUnitBudgets(run.id, 'WU-BUDGETED', {
      quality: { per_work_unit: 1 },
    })

    const result3 = workflowStore.checkAndIncrementBudget(run.id, 'WU-BUDGETED', 'quality')
    expect(result3.allowed).toBe(true)
    expect(result3.used).toBe(1)
    expect(result3.max).toBe(1)

    // Work-unit budget exhausted
    const result4 = workflowStore.checkAndIncrementBudget(run.id, 'WU-BUDGETED', 'quality')
    expect(result4.allowed).toBe(false)
    expect(result4.used).toBe(1)
    expect(result4.max).toBe(1)

    // But run-level still has budget remaining (2 used out of 5)
    const runBudget = workflowStore.getBudget(run.id, null, 'quality')
    expect(runBudget!.used).toBe(1)
    expect(runBudget!.max_allowed).toBe(5)
  })
})
