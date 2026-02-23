/**
 * amendment-state-machine.test.ts -- Tests for state machine enforcement and
 * invalidation cycle detection (Phase 10: TEST-36 and TEST-37)
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
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
import type { StepRunState, WorkflowDefinition, WorkflowRun } from '../../shared/types'
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

function createWorkflowDef(store: WorkflowStore, yaml: string, name: string): WorkflowDefinition {
  return store.createWorkflow({
    name, description: 'Test', yaml_content: yaml, file_path: null,
    is_valid: true, validation_errors: [], step_count: 1,
  })
}

function createTestRun(store: WorkflowStore, wfId: string, steps: StepRunState[], overrides?: Partial<WorkflowRun>): WorkflowRun {
  return store.createRun({
    workflow_id: wfId, workflow_name: 'test', status: 'running',
    current_step_index: 0, steps_state: steps,
    output_dir: '/tmp/test-outputs/state-machine',
    started_at: new Date().toISOString(),
    completed_at: null, error_message: null, variables: null,
    ...overrides,
  })
}

function getParsed(yaml: string): ParsedWorkflow {
  const result = parseWorkflowYAML(yaml)
  if (!result.valid || !result.workflow) throw new Error(`Invalid YAML: ${result.errors.join(', ')}`)
  return result.workflow
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Amendment State Machine (TEST-36 and TEST-37)', () => {
  let db: SQLiteDatabase
  let workflowStore: WorkflowStore
  let taskStore: TaskStore
  let ctx: ServerContext
  let dagEngine: DAGEngine
  let pool: SessionPool

  beforeEach(() => {
    const stores = createStores()
    db = stores.db
    workflowStore = stores.workflowStore
    taskStore = stores.taskStore
    ctx = createTestContext()
    pool = createSessionPool(db)
    dagEngine = createDAGEngine(ctx, workflowStore, taskStore, pool)
  })

  afterEach(() => {
    try { db.close() } catch { /* ok */ }
  })

  // ── TEST-36: paused_escalated state machine enforcement ────────────────

  test('TEST-36: paused_escalated status locked during awaiting_human, only human can transition', () => {
    const yaml = `
name: state-36
system:
  engine: dag
steps:
  - name: test-step
    type: amendment_check
    signal_dir: /tmp/test
`
    const parsed = getParsed(yaml)
    const def = createWorkflowDef(workflowStore, yaml, `state-36-${Date.now()}`)

    // Step is in awaiting_human phase with paused_escalated status
    const stepsState = [
      makeStepState({
        name: 'test-step',
        type: 'amendment_check' as any,
        status: 'paused_escalated',
        amendmentPhase: 'awaiting_human',
        amendmentSignalFile: '/tmp/signal.yaml',
      }),
    ]
    const run = createTestRun(workflowStore, def.id, stepsState)

    // Multiple ticks should NOT change the status
    dagEngine.tick(run, parsed)
    let updated = workflowStore.getRun(run.id)!

    // paused_escalated is terminal, so the workflow fails
    expect(updated.status).toBe('failed')

    // Create a new run to test state locking within tick
    const stepsState2 = [
      makeStepState({
        name: 'test-step',
        type: 'amendment_check' as any,
        status: 'paused_escalated',
        amendmentPhase: 'awaiting_human',
        amendmentSignalFile: '/tmp/signal.yaml',
      }),
      makeStepState({
        name: 'step-2',
        type: 'delay',
        status: 'completed',
        completedAt: new Date().toISOString(),
      }),
    ]
    const run2 = createTestRun(workflowStore, def.id, stepsState2)

    dagEngine.tick(run2, parsed)
    updated = workflowStore.getRun(run2.id)!
    const step = updated.steps_state.find(s => s.name === 'test-step')!

    // Status should remain paused_escalated
    expect(step.status).toBe('paused_escalated')
    expect(step.amendmentPhase).toBe('awaiting_human')
  })

  test('TEST-36b: state drift is corrected -- if status drifts from paused_escalated during awaiting_human, it is forced back', () => {
    const yaml = `
name: state-36b
system:
  engine: dag
steps:
  - name: test-step
    type: amendment_check
    signal_dir: /tmp/test
  - name: running-step
    type: delay
    seconds: 1
`
    const parsed = getParsed(yaml)
    const def = createWorkflowDef(workflowStore, yaml, `state-36b-${Date.now()}`)

    // Simulate a state drift: awaiting_human phase but status is somehow 'running'
    const stepsState = [
      makeStepState({
        name: 'test-step',
        type: 'amendment_check' as any,
        status: 'paused_amendment',  // Drifted from paused_escalated
        amendmentPhase: 'awaiting_human',
        amendmentSignalFile: '/tmp/signal.yaml',
      }),
      makeStepState({
        name: 'running-step',
        type: 'delay',
        status: 'pending',
      }),
    ]
    const run = createTestRun(workflowStore, def.id, stepsState)

    dagEngine.tick(run, parsed)
    const updated = workflowStore.getRun(run.id)!
    const step = updated.steps_state.find(s => s.name === 'test-step')!

    // State should be forced back to paused_escalated
    expect(step.status).toBe('paused_escalated')
    expect(step.amendmentPhase).toBe('awaiting_human')

    // Verify warning was logged about state drift
    const warnCalls = (ctx.logger.warn as any).mock.calls
    const driftLog = warnCalls.find(
      (c: any) => c[0] === 'dag_amendment_invalid_state'
    )
    expect(driftLog).toBeTruthy()
  })

  // ── TEST-37: Invalidation cycle detection ──────────────────────────────

  test('TEST-37: 3+ handler_complete on same step escalates to human', () => {
    const tmp = tmpdir()
    const signalDir = join(tmp, `dag-inval-37-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const outputDir = join(tmp, `dag-inval-37-out-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(signalDir, { recursive: true })
    mkdirSync(outputDir, { recursive: true })

    try {
      const signalFile = join(signalDir, 'signal-inval.yaml')
      writeFileSync(signalFile, [
        'signal_type: amendment_required',
        'amendment:',
        '  type: correction',
        '  category: quality',
        '  spec_section: api.auth',
        '  issue: Auth spec keeps changing',
        'checkpoint:',
        '  step: 3',
      ].join('\n'))

      // Write resolution file
      writeFileSync(join(outputDir, 'amendment-resolution-test-step.yaml'), [
        'signal_file: signal-inval.yaml',
        'resolution: approved',
        'amendment_id: amend-inval',
        'resolved_at: "2026-01-01T00:00:00Z"',
        'resolved_by: auto-reviewer',
      ].join('\n'))

      const yaml = `
name: inval-37
system:
  engine: dag
steps:
  - name: test-step
    type: spawn_session
    projectPath: /tmp/test
    prompt: "implement"
`
      const parsed = getParsed(yaml)
      const def = createWorkflowDef(workflowStore, yaml, `inval-37-${Date.now()}`)

      // Step has already been through handler_complete twice (invalidationCount = 2)
      // Third handler_complete should trigger escalation
      const stepsState = [
        makeStepState({
          name: 'test-step',
          type: 'spawn_session',
          status: 'paused_amendment',
          amendmentPhase: 'handler_complete',
          amendmentSignalFile: signalFile,
          amendmentHandlerTaskId: 'handler-3',
          invalidationCount: 2,  // Already 2, next = 3 = escalate
        }),
      ]
      const run = createTestRun(workflowStore, def.id, stepsState, { output_dir: outputDir })

      dagEngine.tick(run, parsed)

      const updated = workflowStore.getRun(run.id)!
      const step = updated.steps_state.find(s => s.name === 'test-step')!

      // Invalidation cycle detected (3 completions) -> escalate
      expect(step.status).toBe('paused_escalated')
      expect(step.amendmentPhase).toBe('awaiting_human')
      expect(step.invalidationCount).toBe(3)

      // Verify escalation broadcast mentions invalidation cycle
      const broadcastCalls = (ctx.broadcast as any).mock.calls
      const escalatedBroadcast = broadcastCalls.find(
        (c: any) => c[0]?.type === 'amendment_escalated'
      )
      expect(escalatedBroadcast).toBeTruthy()
      expect(escalatedBroadcast[0].reason).toContain('invalidation cycle')

      // Verify warning logged
      const warnCalls = (ctx.logger.warn as any).mock.calls
      const invalidationLog = warnCalls.find(
        (c: any) => c[0] === 'dag_amendment_invalidation_cycle'
      )
      expect(invalidationLog).toBeTruthy()
    } finally {
      rmSync(signalDir, { recursive: true, force: true })
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  test('TEST-37b: fewer than 3 handler_complete does not escalate', () => {
    const tmp = tmpdir()
    const signalDir = join(tmp, `dag-inval-37b-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const outputDir = join(tmp, `dag-inval-37b-out-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(signalDir, { recursive: true })
    mkdirSync(outputDir, { recursive: true })

    try {
      const signalFile = join(signalDir, 'signal-inval.yaml')
      writeFileSync(signalFile, [
        'signal_type: amendment_required',
        'amendment:',
        '  type: correction',
        '  category: quality',
        '  spec_section: api.auth',
        '  issue: Auth needs update',
        'checkpoint:',
        '  step: 2',
      ].join('\n'))

      writeFileSync(join(outputDir, 'amendment-resolution-test-step.yaml'), [
        'signal_file: signal-inval.yaml',
        'resolution: approved',
        'amendment_id: amend-ok',
        'resolved_at: "2026-01-01T00:00:00Z"',
        'resolved_by: auto-reviewer',
      ].join('\n'))

      const yaml = `
name: inval-37b
system:
  engine: dag
steps:
  - name: test-step
    type: spawn_session
    projectPath: /tmp/test
    prompt: "implement"
`
      const parsed = getParsed(yaml)
      const def = createWorkflowDef(workflowStore, yaml, `inval-37b-${Date.now()}`)

      // Only 1 prior completion -- should NOT escalate
      const stepsState = [
        makeStepState({
          name: 'test-step',
          type: 'spawn_session',
          status: 'paused_amendment',
          amendmentPhase: 'handler_complete',
          amendmentSignalFile: signalFile,
          amendmentHandlerTaskId: 'handler-2',
          invalidationCount: 1,
        }),
      ]
      const run = createTestRun(workflowStore, def.id, stepsState, { output_dir: outputDir })

      dagEngine.tick(run, parsed)

      const updated = workflowStore.getRun(run.id)!
      const step = updated.steps_state.find(s => s.name === 'test-step')!

      // Should resume normally (invalidationCount = 2, below threshold of 3)
      expect(step.status).toBe('running')
      expect(step.amendmentPhase).toBeNull()
      expect(step.invalidationCount).toBe(2)
    } finally {
      rmSync(signalDir, { recursive: true, force: true })
      rmSync(outputDir, { recursive: true, force: true })
    }
  })
})
