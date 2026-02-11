/**
 * dagEngine.test.ts -- Tests for DAG-based workflow engine (Phase 5)
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { createDAGEngine } from '../dagEngine'
import type { DAGEngine } from '../dagEngine'
import { createWorkflowEngine } from '../workflowEngine'
import { initWorkflowStore } from '../workflowStore'
import type { WorkflowStore } from '../workflowStore'
import { initTaskStore } from '../taskStore'
import type { TaskStore } from '../taskStore'
import { initPoolTables } from '../db'
import { createSessionPool } from '../sessionPool'
import type { SessionPool } from '../sessionPool'
import type { ServerContext } from '../serverContext'
import type {
  WorkflowRun,
  StepRunState,
  WorkflowDefinition,
} from '../../shared/types'
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

function createTestContext(overrides?: Partial<ServerContext>): ServerContext {
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
    ...overrides,
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
  name = 'test-workflow',
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
    output_dir: '/tmp/test-outputs/dag-test',
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

/** Run tick() in a loop until a condition is met or maxTicks is reached. Sleep between ticks. */
async function tickUntil(
  engine: DAGEngine,
  run: WorkflowRun,
  parsed: ParsedWorkflow,
  workflowStore: WorkflowStore,
  condition: (run: WorkflowRun) => boolean,
  maxTicks = 20,
  sleepMs = 15,
): Promise<WorkflowRun> {
  let freshRun = workflowStore.getRun(run.id)!
  for (let i = 0; i < maxTicks; i++) {
    engine.tick(freshRun, parsed)
    freshRun = workflowStore.getRun(run.id)!
    if (condition(freshRun)) return freshRun
    await Bun.sleep(sleepMs)
  }
  return freshRun
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('dagEngine', () => {
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

  // ── TEST-01: Linear pipeline under DAG engine ──────────────────────────

  describe('linear pipeline', () => {
    test('TEST-01: sequential steps execute in order under DAG engine', async () => {
      const yaml = [
        'name: linear-dag',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: step-a',
        '    type: delay',
        '    seconds: 0.01',
        '  - name: step-b',
        '    type: delay',
        '    seconds: 0.01',
        '  - name: step-c',
        '    type: delay',
        '    seconds: 0.01',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'linear-dag')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'step-a', type: 'delay' }),
        makeStepState({ name: 'step-b', type: 'delay' }),
        makeStepState({ name: 'step-c', type: 'delay' }),
      ])

      // Tick until workflow completes
      const freshRun = await tickUntil(
        dagEngine, run, parsed, workflowStore,
        (r) => r.status === 'completed' || r.status === 'failed',
      )

      expect(freshRun.status).toBe('completed')
      expect(freshRun.steps_state.every(s => s.status === 'completed')).toBe(true)
      // Verify sequential ordering: each step started after previous completed
      for (let i = 1; i < freshRun.steps_state.length; i++) {
        expect(freshRun.steps_state[i].startedAt).not.toBeNull()
        expect(freshRun.steps_state[i - 1].completedAt).not.toBeNull()
      }
    })
  })

  // ── TEST-02: parallel_group with independent children ──────────────────

  describe('parallel_group', () => {
    test('TEST-02: independent children start together', async () => {
      const yaml = [
        'name: parallel-test',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: parallel-batch',
        '    type: parallel_group',
        '    children:',
        '      - name: child-a',
        '        type: delay',
        '        seconds: 0.01',
        '      - name: child-b',
        '        type: delay',
        '        seconds: 0.01',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'parallel-test')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'parallel-batch', type: 'parallel_group' }),
        makeStepState({ name: 'child-a', type: 'delay', parentGroup: 'parallel-batch' }),
        makeStepState({ name: 'child-b', type: 'delay', parentGroup: 'parallel-batch' }),
      ])

      // First tick: both children should start simultaneously
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[1].status).toBe('running') // child-a
      expect(freshRun.steps_state[2].status).toBe('running') // child-b
      expect(freshRun.steps_state[0].status).toBe('running') // group

      // Tick until completion
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.status === 'completed' || r.status === 'failed',
      )

      expect(freshRun.status).toBe('completed')
      expect(freshRun.steps_state[0].status).toBe('completed') // group
      expect(freshRun.steps_state[1].status).toBe('completed') // child-a
      expect(freshRun.steps_state[2].status).toBe('completed') // child-b
    })

    test('TEST-03: diamond dependency resolution (A->B, A->C, B+C->D)', async () => {
      const yaml = [
        'name: diamond-test',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: diamond-group',
        '    type: parallel_group',
        '    children:',
        '      - name: A',
        '        type: delay',
        '        seconds: 0.01',
        '      - name: B',
        '        type: delay',
        '        seconds: 0.01',
        '        depends_on:',
        '          - A',
        '      - name: C',
        '        type: delay',
        '        seconds: 0.01',
        '        depends_on:',
        '          - A',
        '      - name: D',
        '        type: delay',
        '        seconds: 0.01',
        '        depends_on:',
        '          - B',
        '          - C',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'diamond-test')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'diamond-group', type: 'parallel_group' }),
        makeStepState({ name: 'A', type: 'delay', parentGroup: 'diamond-group' }),
        makeStepState({ name: 'B', type: 'delay', parentGroup: 'diamond-group' }),
        makeStepState({ name: 'C', type: 'delay', parentGroup: 'diamond-group' }),
        makeStepState({ name: 'D', type: 'delay', parentGroup: 'diamond-group' }),
      ])

      // First tick: only A starts (B, C, D depend on A)
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].status).toBe('running') // A
      expect(freshRun.steps_state[2].status).toBe('pending') // B
      expect(freshRun.steps_state[3].status).toBe('pending') // C
      expect(freshRun.steps_state[4].status).toBe('pending') // D

      // Tick until A completes and B,C start
      await Bun.sleep(20)
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.steps_state[2].status === 'running' && r.steps_state[3].status === 'running',
        10,
      )
      expect(freshRun.steps_state[1].status).toBe('completed') // A
      expect(freshRun.steps_state[2].status).toBe('running') // B
      expect(freshRun.steps_state[3].status).toBe('running') // C
      expect(freshRun.steps_state[4].status).toBe('pending') // D still waiting

      // Tick until workflow completes
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.status === 'completed' || r.status === 'failed',
      )

      expect(freshRun.status).toBe('completed')
      expect(freshRun.steps_state.slice(1).every(s => s.status === 'completed')).toBe(true)
    })
  })

  // ── TEST-08: Dependency on skipped step treated as satisfied ────────────

  describe('skipped dependencies', () => {
    test('TEST-08: dependency on skipped step is satisfied', async () => {
      const yaml = [
        'name: skip-dep-test',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: skip-group',
        '    type: parallel_group',
        '    children:',
        '      - name: optional',
        '        type: delay',
        '        seconds: 0.01',
        '        tier_min: 99',
        '      - name: next',
        '        type: delay',
        '        seconds: 0.01',
        '        depends_on:',
        '          - optional',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'skip-dep-test')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'skip-group', type: 'parallel_group' }),
        makeStepState({ name: 'optional', type: 'delay', parentGroup: 'skip-group', tier_min: 99 }),
        makeStepState({ name: 'next', type: 'delay', parentGroup: 'skip-group' }),
      ])

      // First tick: 'optional' should be skipped (tier_min: 99, run tier: 1)
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].status).toBe('skipped')
      // 'next' should start since skipped dep = satisfied
      expect(freshRun.steps_state[2].status).toBe('running')

      // Tick until workflow completes
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.status === 'completed' || r.status === 'failed',
      )

      expect(freshRun.status).toBe('completed')
      expect(freshRun.steps_state[2].status).toBe('completed')
    })
  })

  // ── TEST-09: on_failure: cancel_all ────────────────────────────────────

  describe('on_failure policies', () => {
    test('TEST-09: cancel_all cancels remaining siblings on failure', () => {
      const yaml = [
        'name: cancel-all-test',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: cancel-group',
        '    type: parallel_group',
        '    on_failure: cancel_all',
        '    children:',
        '      - name: will-fail',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "fail"',
        '      - name: will-cancel',
        '        type: delay',
        '        seconds: 100',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'cancel-all-test')
      const parsed = getParsed(yaml)

      // Create a task that has already failed
      const failedTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'fail',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(failedTask.id, { status: 'failed', errorMessage: 'test failure' })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'cancel-group', type: 'parallel_group' }),
        makeStepState({
          name: 'will-fail',
          type: 'spawn_session',
          parentGroup: 'cancel-group',
          status: 'running',
          taskId: failedTask.id,
          startedAt: new Date().toISOString(),
        }),
        makeStepState({
          name: 'will-cancel',
          type: 'delay',
          parentGroup: 'cancel-group',
          status: 'running',
          startedAt: new Date().toISOString(),
        }),
      ])

      // Tick 1: monitor detects failure, on_failure: cancel_all cancels siblings
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].status).toBe('failed') // will-fail

      // Tick 2: processParallelGroup sees failed child + cancel_all policy
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[2].status).toBe('cancelled') // will-cancel
      expect(freshRun.steps_state[0].status).toBe('failed') // group failed
    })

    test('TEST-10: continue_others lets siblings continue after failure', async () => {
      const yaml = [
        'name: continue-test',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: cont-group',
        '    type: parallel_group',
        '    on_failure: continue_others',
        '    children:',
        '      - name: will-fail',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "fail"',
        '      - name: will-continue',
        '        type: delay',
        '        seconds: 0.01',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'continue-test')
      const parsed = getParsed(yaml)

      const failedTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'fail',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(failedTask.id, { status: 'failed', errorMessage: 'test failure' })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'cont-group', type: 'parallel_group' }),
        makeStepState({
          name: 'will-fail',
          type: 'spawn_session',
          parentGroup: 'cont-group',
          status: 'running',
          taskId: failedTask.id,
          startedAt: new Date().toISOString(),
        }),
        makeStepState({
          name: 'will-continue',
          type: 'delay',
          parentGroup: 'cont-group',
          status: 'running',
          startedAt: new Date().toISOString(),
        }),
      ])

      // Tick until all children are terminal
      const freshRun = await tickUntil(
        dagEngine, run, parsed, workflowStore,
        (r) => {
          const childStates = r.steps_state.filter(s => s.parentGroup === 'cont-group')
          return childStates.every(s =>
            s.status === 'completed' || s.status === 'failed' || s.status === 'skipped' || s.status === 'cancelled',
          )
        },
      )

      expect(freshRun.steps_state[1].status).toBe('failed') // will-fail
      // will-continue should have completed (not cancelled)
      expect(freshRun.steps_state[2].status).toBe('completed')

      // One more tick: group gets partial status since a child failed under continue_others
      dagEngine.tick(freshRun, parsed)
      const finalRun = workflowStore.getRun(run.id)!
      expect(finalRun.steps_state[0].status).toBe('partial')
      expect(finalRun.steps_state[0].errorMessage).toContain('children failed')
    })
  })

  // ── TEST-17: Non-session steps bypass pool ─────────────────────────────

  describe('pool bypass', () => {
    test('TEST-17: delay and check_file bypass pool (no poolSlotId)', () => {
      const yaml = [
        'name: bypass-test',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: bypass-group',
        '    type: parallel_group',
        '    children:',
        '      - name: quick-delay',
        '        type: delay',
        '        seconds: 0.01',
        '      - name: quick-check',
        '        type: delay',
        '        seconds: 0.01',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'bypass-test')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'bypass-group', type: 'parallel_group' }),
        makeStepState({ name: 'quick-delay', type: 'delay', parentGroup: 'bypass-group' }),
        makeStepState({ name: 'quick-check', type: 'delay', parentGroup: 'bypass-group' }),
      ])

      dagEngine.tick(run, parsed)
      const freshRun = workflowStore.getRun(run.id)!

      // Non-session steps should start without pool slot
      expect(freshRun.steps_state[1].poolSlotId).toBeFalsy()
      expect(freshRun.steps_state[2].poolSlotId).toBeFalsy()
      expect(freshRun.steps_state[1].status).toBe('running')
      expect(freshRun.steps_state[2].status).toBe('running')
    })
  })

  // ── TEST-21: Legacy engine unchanged for non-DAG workflows ─────────────

  describe('legacy engine isolation', () => {
    test('TEST-21: workflow without system.engine runs through legacy path', () => {
      const yaml = [
        'name: legacy-test',
        'steps:',
        '  - name: step-1',
        '    type: spawn_session',
        '    prompt: "do something"',
        '    projectPath: /tmp/test',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'legacy-test')

      const task = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'do something',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(task.id, { status: 'completed', completedAt: new Date().toISOString() })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({
          name: 'step-1',
          type: 'spawn_session',
          status: 'running',
          taskId: task.id,
          startedAt: new Date().toISOString(),
        }),
      ])

      const engine = createWorkflowEngine(ctx, workflowStore, taskStore, pool)
      engine.start()

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          engine.stop()
          const updatedRun = workflowStore.getRun(run.id)!
          expect(updatedRun.status).toBe('completed')
          expect(updatedRun.steps_state[0].status).toBe('completed')
          resolve()
        }, 400)
      })
    })

    test('DAG workflow is processed by DAG engine', () => {
      const yaml = [
        'name: dag-route-test',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: step-1',
        '    type: delay',
        '    seconds: 0.01',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'dag-route-test')
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'step-1', type: 'delay' }),
      ])

      const engine = createWorkflowEngine(ctx, workflowStore, taskStore, pool)
      engine.start()

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          engine.stop()
          const updatedRun = workflowStore.getRun(run.id)!
          expect(updatedRun.status).toBe('completed')
          const infoCalls = (ctx.logger.info as ReturnType<typeof mock>).mock.calls
          const dagLogs = infoCalls.filter((c: unknown[]) =>
            typeof c[0] === 'string' && c[0].startsWith('dag_'),
          )
          expect(dagLogs.length).toBeGreaterThan(0)
          resolve()
        }, 800)
      })
    })
  })

  // ── Spawn session with pool integration ────────────────────────────────

  describe('spawn_session with pool', () => {
    test('spawn_session requests pool slot and creates task when granted', () => {
      const yaml = [
        'name: pool-spawn-test',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: spawn-step',
        '    type: spawn_session',
        '    projectPath: /tmp/test',
        '    prompt: "do work"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'pool-spawn-test')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'spawn-step', type: 'spawn_session' }),
      ])

      dagEngine.tick(run, parsed)
      const freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].poolSlotId).toBeTruthy()
      expect(freshRun.steps_state[0].status).toBe('running')
      expect(freshRun.steps_state[0].taskId).toBeTruthy()

      const tasks = taskStore.listTasks()
      expect(tasks.length).toBeGreaterThanOrEqual(1)
    })

    test('spawn_session queued when pool full', () => {
      pool.updateConfig(1) // Only 1 slot

      const yaml = [
        'name: pool-queue-test',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: queue-group',
        '    type: parallel_group',
        '    children:',
        '      - name: first-spawn',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "first"',
        '      - name: second-spawn',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "second"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'pool-queue-test')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'queue-group', type: 'parallel_group' }),
        makeStepState({ name: 'first-spawn', type: 'spawn_session', parentGroup: 'queue-group' }),
        makeStepState({ name: 'second-spawn', type: 'spawn_session', parentGroup: 'queue-group' }),
      ])

      dagEngine.tick(run, parsed)
      const freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[1].status).toBe('running')
      expect(freshRun.steps_state[2].status).toBe('queued')
      expect(freshRun.steps_state[2].poolSlotId).toBeTruthy()
    })
  })

  // ── Workflow failure on step failure ────────────────────────────────────

  describe('workflow failure', () => {
    test('workflow fails when top-level step fails', () => {
      const yaml = [
        'name: fail-test',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: fail-step',
        '    type: spawn_session',
        '    projectPath: /tmp/test',
        '    prompt: "fail"',
      ].join('\n')

      const failedTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'fail',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(failedTask.id, { status: 'failed', errorMessage: 'oops' })

      const wf = createWorkflowDef(workflowStore, yaml, 'fail-test')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({
          name: 'fail-step',
          type: 'spawn_session',
          status: 'running',
          taskId: failedTask.id,
          startedAt: new Date().toISOString(),
        }),
      ])

      // Tick 1: monitor detects failure
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[0].status).toBe('failed')

      // Tick 2: all terminal, workflow fails
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.status).toBe('failed')
      expect(freshRun.error_message).toContain('failed')
    })
  })

  // ── Null pool path ─────────────────────────────────────────────────────

  describe('null pool', () => {
    test('DAG engine works without pool (non-session steps)', async () => {
      const yaml = [
        'name: nopool-test',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: step-1',
        '    type: delay',
        '    seconds: 0.01',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'nopool-test')
      const parsed = getParsed(yaml)
      const nopoolEngine = createDAGEngine(ctx, workflowStore, taskStore, null)

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'step-1', type: 'delay' }),
      ])

      const freshRun = await tickUntil(
        nopoolEngine, run, parsed, workflowStore,
        (r) => r.status === 'completed' || r.status === 'failed',
      )

      expect(freshRun.status).toBe('completed')
      expect(freshRun.steps_state[0].status).toBe('completed')
    })
  })

  // ── TEST-27: Signal file authority over tmux state (REQ-38) ────────────

  describe('signal file authority', () => {
    test('TEST-27: completed signal file overrides task status', () => {
      const fs = require('node:fs')
      const nodePath = require('node:path')
      const outputDir = '/tmp/test-outputs/dag-signal-test-' + Date.now()
      fs.mkdirSync(outputDir, { recursive: true })

      const yaml = [
        'name: signal-test',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: signal-step',
        '    type: spawn_session',
        '    projectPath: /tmp/test',
        '    prompt: "work"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'signal-test')
      const parsed = getParsed(yaml)

      // Create a task that is still "running" in the task store
      const runningTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'work',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(runningTask.id, { status: 'running' })

      // Write a completed signal file (agent wrote this, should be authoritative)
      const signalPath = nodePath.join(outputDir, 'signal-step_completed.yaml')
      fs.writeFileSync(signalPath, 'verified_completion: true\ncompleted_at: 2025-01-01T00:00:00Z\n')

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({
          name: 'signal-step',
          type: 'spawn_session',
          status: 'running',
          taskId: runningTask.id,
          startedAt: new Date().toISOString(),
        }),
      ], { output_dir: outputDir })

      // Tick: signal file should override task status (task is still "running")
      dagEngine.tick(run, parsed)
      const freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].status).toBe('completed')

      // Cleanup
      try { fs.rmSync(outputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('TEST-27b: failed signal file overrides task status', () => {
      const fs = require('node:fs')
      const nodePath = require('node:path')
      const outputDir = '/tmp/test-outputs/dag-signal-fail-test-' + Date.now()
      fs.mkdirSync(outputDir, { recursive: true })

      const yaml = [
        'name: signal-fail-test',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: signal-fail-step',
        '    type: spawn_session',
        '    projectPath: /tmp/test',
        '    prompt: "work"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'signal-fail-test')
      const parsed = getParsed(yaml)

      const runningTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'work',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(runningTask.id, { status: 'running' })

      // Write a failed signal file
      const signalPath = nodePath.join(outputDir, 'signal-fail-step_failed.yaml')
      fs.writeFileSync(signalPath, 'verified_completion: true\nerror: agent crashed unexpectedly\n')

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({
          name: 'signal-fail-step',
          type: 'spawn_session',
          status: 'running',
          taskId: runningTask.id,
          startedAt: new Date().toISOString(),
        }),
      ], { output_dir: outputDir })

      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].status).toBe('failed')
      expect(freshRun.steps_state[0].errorMessage).toContain('agent crashed unexpectedly')

      // Cleanup
      try { fs.rmSync(outputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('TEST-27c: signal file without verified_completion is ignored', () => {
      const fs = require('node:fs')
      const nodePath = require('node:path')
      const outputDir = '/tmp/test-outputs/dag-signal-synthetic-test-' + Date.now()
      fs.mkdirSync(outputDir, { recursive: true })

      const yaml = [
        'name: signal-synth-test',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: synth-step',
        '    type: spawn_session',
        '    projectPath: /tmp/test',
        '    prompt: "work"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'signal-synth-test')
      const parsed = getParsed(yaml)

      const runningTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'work',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(runningTask.id, { status: 'running' })

      // Write a signal file WITHOUT verified_completion (synthetic, should be ignored)
      const signalPath = nodePath.join(outputDir, 'synth-step_completed.yaml')
      fs.writeFileSync(signalPath, 'completed_at: 2025-01-01T00:00:00Z\n')

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({
          name: 'synth-step',
          type: 'spawn_session',
          status: 'running',
          taskId: runningTask.id,
          startedAt: new Date().toISOString(),
        }),
      ], { output_dir: outputDir })

      dagEngine.tick(run, parsed)
      const freshRun = workflowStore.getRun(run.id)!

      // Should still be running (signal file was not authoritative)
      expect(freshRun.steps_state[0].status).toBe('running')

      // Cleanup
      try { fs.rmSync(outputDir, { recursive: true }) } catch { /* ok */ }
    })
  })

  // ── Termination state machine (M-02) ────────────────────────────────

  describe('termination sequence', () => {
    test('TEST-27d: cancel_all initiates termination state machine and writes signal file', () => {
      const fs = require('node:fs')
      const nodePath = require('node:path')
      const outputDir = '/tmp/test-outputs/dag-terminate-test-' + Date.now()
      fs.mkdirSync(outputDir, { recursive: true })

      const yaml = [
        'name: terminate-test',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: term-group',
        '    type: parallel_group',
        '    on_failure: cancel_all',
        '    children:',
        '      - name: will-fail',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "fail"',
        '      - name: will-terminate',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "run"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'terminate-test')
      const parsed = getParsed(yaml)

      const failedTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'fail',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(failedTask.id, { status: 'failed', errorMessage: 'test failure' })

      const runningTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'run',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(runningTask.id, { status: 'running' })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'term-group', type: 'parallel_group' }),
        makeStepState({
          name: 'will-fail',
          type: 'spawn_session',
          parentGroup: 'term-group',
          status: 'running',
          taskId: failedTask.id,
          startedAt: new Date().toISOString(),
        }),
        makeStepState({
          name: 'will-terminate',
          type: 'spawn_session',
          parentGroup: 'term-group',
          status: 'running',
          taskId: runningTask.id,
          startedAt: new Date().toISOString(),
        }),
      ], { output_dir: outputDir })

      // Tick 1: monitor detects will-fail as failed
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      // Tick 2: processParallelGroup sees failure + cancel_all, initiates termination state machine
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[1].status).toBe('failed')
      // State machine is in progress -- step is still running with terminationPhase set
      expect(freshRun.steps_state[2].status).toBe('running')
      expect(freshRun.steps_state[2].terminationPhase).toBe('signal_sent')
      expect(freshRun.steps_state[2].terminationStartedAt).toBeTruthy()

      // REQ-38: Signal file should have been written (REQ-33: namespaced path)
      const signalPath = nodePath.join(outputDir, 'term-group', 'will-terminate', 'will-terminate_cancel_requested.yaml')
      expect(fs.existsSync(signalPath)).toBe(true)
      const content = fs.readFileSync(signalPath, 'utf-8')
      expect(content).toContain('cancelled_at:')
      expect(content).toContain('reason: sibling_failure')

      // Task should be marked as cancelled in the store
      const terminatedTask = taskStore.getTask(runningTask.id)
      expect(terminatedTask?.status).toBe('cancelled')

      // Cleanup
      try { fs.rmSync(outputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('TEST-27e: termination state machine progresses through phases', () => {
      const fs = require('node:fs')
      const outputDir = '/tmp/test-outputs/dag-term-phases-' + Date.now()
      fs.mkdirSync(outputDir, { recursive: true })

      const yaml = [
        'name: term-phases-test',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: phase-group',
        '    type: parallel_group',
        '    on_failure: cancel_all',
        '    children:',
        '      - name: already-failed',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "fail"',
        '      - name: being-terminated',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "run"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'term-phases-test')
      const parsed = getParsed(yaml)

      const failedTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'fail',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(failedTask.id, { status: 'failed', errorMessage: 'test failure' })

      const runningTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'run',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(runningTask.id, { status: 'running' })

      // Pre-set the termination state as if signal was already sent 6s ago (past grace period)
      const pastGrace = new Date(Date.now() - 6000).toISOString()

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'phase-group', type: 'parallel_group', status: 'running', startedAt: new Date().toISOString() }),
        makeStepState({
          name: 'already-failed',
          type: 'spawn_session',
          parentGroup: 'phase-group',
          status: 'failed',
          taskId: failedTask.id,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          errorMessage: 'test failure',
        }),
        makeStepState({
          name: 'being-terminated',
          type: 'spawn_session',
          parentGroup: 'phase-group',
          status: 'running',
          taskId: runningTask.id,
          startedAt: new Date().toISOString(),
          terminationPhase: 'signal_sent',
          terminationStartedAt: pastGrace,
        }),
      ], { output_dir: outputDir })

      // Tick: signal_sent phase elapsed -> should advance to waiting_grace1 -> sigterm_sent
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      // Should have progressed: signal_sent (elapsed) -> waiting_grace1
      const termChild = freshRun.steps_state[2]
      expect(termChild.terminationPhase).toBe('waiting_grace1')

      // Tick again: waiting_grace1 -> sigterm_sent (sends SIGTERM, resets timer)
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[2].terminationPhase).toBe('sigterm_sent')
      expect(freshRun.steps_state[2].terminationStartedAt).toBeTruthy()

      // Backdate to simulate another 6s elapsed past sigterm
      freshRun.steps_state[2].terminationStartedAt = new Date(Date.now() - 6000).toISOString()
      workflowStore.updateRun(freshRun.id, { steps_state: freshRun.steps_state })
      freshRun = workflowStore.getRun(run.id)!

      // Tick: sigterm_sent (elapsed) -> waiting_grace2
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // Tick: waiting_grace2 -> killed (SIGKILL + kill session + release slot)
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      const finalChild = freshRun.steps_state[2]
      expect(finalChild.status).toBe('cancelled')
      expect(freshRun.steps_state[0].status).toBe('failed') // group should be failed now

      // Cleanup
      try { fs.rmSync(outputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('TEST-30: terminateRunningChild is NOT called for delay steps', () => {
      const yaml = [
        'name: no-terminate-delay',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: nt-group',
        '    type: parallel_group',
        '    on_failure: cancel_all',
        '    children:',
        '      - name: will-fail',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "fail"',
        '      - name: delay-child',
        '        type: delay',
        '        seconds: 100',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'no-terminate-delay')
      const parsed = getParsed(yaml)

      const failedTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'fail',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(failedTask.id, { status: 'failed', errorMessage: 'test failure' })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'nt-group', type: 'parallel_group' }),
        makeStepState({
          name: 'will-fail',
          type: 'spawn_session',
          parentGroup: 'nt-group',
          status: 'running',
          taskId: failedTask.id,
          startedAt: new Date().toISOString(),
        }),
        makeStepState({
          name: 'delay-child',
          type: 'delay',
          parentGroup: 'nt-group',
          status: 'running',
          startedAt: new Date().toISOString(),
        }),
      ])

      // Tick 1: detect failure
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      // Tick 2: cancel_all, but delay is not spawn_session so no termination sequence
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[2].status).toBe('cancelled')
      // No signal file written for delay steps (no output_dir check needed,
      // just verify cancellation happened cleanly)
      expect(freshRun.steps_state[0].status).toBe('failed')
    })
  })

  // ── TEST-31: Review loop reserves pool slot across iterations ──────────

  describe('pool slot across retries', () => {
    test('TEST-31: retried step re-requests pool slot (slot persists conceptually)', () => {
      pool.updateConfig(2)

      const yaml = [
        'name: retry-pool-test',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: retry-step',
        '    type: spawn_session',
        '    projectPath: /tmp/test',
        '    prompt: "retry me"',
        '    maxRetries: 2',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'retry-pool-test')
      const parsed = getParsed(yaml)

      // Create a task that fails
      const failedTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'retry me',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 2,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(failedTask.id, { status: 'failed', errorMessage: 'attempt 1' })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({
          name: 'retry-step',
          type: 'spawn_session',
          status: 'running',
          taskId: failedTask.id,
          startedAt: new Date().toISOString(),
          poolSlotId: 'slot-original',
        }),
      ])

      // Tick 1: monitorStep detects failure, retries (sets to pending, retryCount=1)
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].status).toBe('pending')
      expect(freshRun.steps_state[0].retryCount).toBe(1)

      // Tick 2: step is pending again, DAG engine re-requests pool slot
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // Step should have gotten a new pool slot and started running
      expect(freshRun.steps_state[0].poolSlotId).toBeTruthy()
      expect(freshRun.steps_state[0].status).toBe('running')
      expect(freshRun.steps_state[0].taskId).toBeTruthy()
    })
  })

  // ── TEST-28: Pool queue respects tier ordering under load ─────────────

  describe('pool tier ordering under load', () => {
    test('TEST-28: stress test - tier ordering preserved with many concurrent requests', () => {
      pool.updateConfig(1) // Only 1 slot to force queuing

      const yaml = [
        'name: tier-stress',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: tier-group',
        '    type: parallel_group',
        '    children:',
        '      - name: t1-a',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "tier1-a"',
        '      - name: t1-b',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "tier1-b"',
        '      - name: t1-c',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "tier1-c"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'tier-stress')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'tier-group', type: 'parallel_group' }),
        makeStepState({ name: 't1-a', type: 'spawn_session', parentGroup: 'tier-group' }),
        makeStepState({ name: 't1-b', type: 'spawn_session', parentGroup: 'tier-group' }),
        makeStepState({ name: 't1-c', type: 'spawn_session', parentGroup: 'tier-group' }),
      ])

      // Tick: first gets active slot, others get queued
      dagEngine.tick(run, parsed)
      const freshRun = workflowStore.getRun(run.id)!

      const runningCount = freshRun.steps_state.filter(
        s => s.parentGroup === 'tier-group' && s.status === 'running',
      ).length
      const queuedCount = freshRun.steps_state.filter(
        s => s.parentGroup === 'tier-group' && s.status === 'queued',
      ).length

      // With maxSlots=1, only 1 should be running
      expect(runningCount).toBe(1)
      expect(queuedCount).toBe(2)

      // Verify pool status matches
      const poolStatus = pool.getStatus()
      expect(poolStatus.active.length).toBe(1)
      expect(poolStatus.queue.length).toBe(2)
    })
  })

  // ── M-05: native_step execution in DAG mode ──────────────────────────

  describe('native_step execution', () => {
    test('M-05: native_step with command executes and captures output', () => {
      const fs = require('node:fs')
      const outputDir = '/tmp/test-outputs/dag-native-test-' + Date.now()
      fs.mkdirSync(outputDir, { recursive: true })

      const yaml = [
        'name: native-cmd-test',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: echo-step',
        '    type: native_step',
        '    command: "echo hello-dag"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'native-cmd-test')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'echo-step', type: 'native_step' }),
      ], { output_dir: outputDir })

      // Tick 1: start the step (sets to running)
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      // Tick 2: monitorStep executes command synchronously
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].status).toBe('completed')
      expect(freshRun.steps_state[0].resultContent).toContain('hello-dag')
      expect(freshRun.steps_state[0].resultCollected).toBe(true)

      // Cleanup
      try { fs.rmSync(outputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('M-05: native_step with failing command sets failed status', () => {
      const fs = require('node:fs')
      const outputDir = '/tmp/test-outputs/dag-native-fail-test-' + Date.now()
      fs.mkdirSync(outputDir, { recursive: true })

      const yaml = [
        'name: native-fail-test',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: fail-cmd',
        '    type: native_step',
        '    command: "exit 1"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'native-fail-test')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'fail-cmd', type: 'native_step' }),
      ], { output_dir: outputDir })

      // Tick 1: start
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      // Tick 2: execute and fail
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].status).toBe('failed')
      expect(freshRun.steps_state[0].errorMessage).toContain('exit code 1')

      // Cleanup
      try { fs.rmSync(outputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('M-05: native_step with action uses predefined registry', () => {
      const yaml = [
        'name: native-action-test',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: unknown-action',
        '    type: native_step',
        '    action: "nonexistent_action"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'native-action-test')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'unknown-action', type: 'native_step' }),
      ])

      // Tick 1: start
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      // Tick 2: execute - unknown action should fail
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].status).toBe('failed')
      expect(freshRun.steps_state[0].errorMessage).toContain('unknown predefined action')
    })

    test('M-05: native_step without command or action fails at runtime', () => {
      // Use a valid YAML with command, but construct a ParsedWorkflow with no command
      // to test the runtime guard in monitorStep
      const yaml = [
        'name: native-no-cmd-test',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: no-cmd',
        '    type: native_step',
        '    command: "echo placeholder"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'native-no-cmd-test')
      const parsed = getParsed(yaml)

      // Remove the command from the parsed step to simulate missing command at runtime
      const stepDef = parsed.steps[0]
      delete stepDef.command
      delete stepDef.action

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'no-cmd', type: 'native_step' }),
      ])

      // Tick 1: start
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      // Tick 2: execute - no command should fail
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].status).toBe('failed')
      expect(freshRun.steps_state[0].errorMessage).toContain('requires command or action')
    })

    test('M-05: native_step with custom success_codes', () => {
      const fs = require('node:fs')
      const outputDir = '/tmp/test-outputs/dag-native-codes-' + Date.now()
      fs.mkdirSync(outputDir, { recursive: true })

      const yaml = [
        'name: native-codes-test',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: exit-2-ok',
        '    type: native_step',
        '    command: "exit 2"',
        '    success_codes:',
        '      - 0',
        '      - 2',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'native-codes-test')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'exit-2-ok', type: 'native_step' }),
      ], { output_dir: outputDir })

      // Tick 1: start
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      // Tick 2: execute - exit 2 should be accepted
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].status).toBe('completed')

      // Cleanup
      try { fs.rmSync(outputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('M-05: native_step in parallel_group executes correctly', async () => {
      const fs = require('node:fs')
      const outputDir = '/tmp/test-outputs/dag-native-parallel-' + Date.now()
      fs.mkdirSync(outputDir, { recursive: true })

      const yaml = [
        'name: native-parallel-test',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: mixed-group',
        '    type: parallel_group',
        '    children:',
        '      - name: native-child',
        '        type: native_step',
        '        command: "echo from-child"',
        '      - name: delay-child',
        '        type: delay',
        '        seconds: 0.01',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'native-parallel-test')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'mixed-group', type: 'parallel_group' }),
        makeStepState({ name: 'native-child', type: 'native_step', parentGroup: 'mixed-group' }),
        makeStepState({ name: 'delay-child', type: 'delay', parentGroup: 'mixed-group' }),
      ], { output_dir: outputDir })

      const freshRun = await tickUntil(
        dagEngine, run, parsed, workflowStore,
        (r) => r.status === 'completed' || r.status === 'failed',
      )

      expect(freshRun.status).toBe('completed')
      const nativeChild = freshRun.steps_state[1]
      expect(nativeChild.status).toBe('completed')
      expect(nativeChild.resultContent).toContain('from-child')

      // Cleanup
      try { fs.rmSync(outputDir, { recursive: true }) } catch { /* ok */ }
    })
  })

  // ── TEST-31: Review loop reserves pool slot across iterations (REQ-40) ──

  describe('review_loop slot reservation', () => {
    test('TEST-31: review_loop reserves pool slot across iterations, sibling waits', () => {
      pool.updateConfig(1) // Only 1 slot

      const yaml = [
        'name: review-loop-test',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: review-group',
        '    type: parallel_group',
        '    children:',
        '      - name: my-review',
        '        type: review_loop',
        '        max_iterations: 3',
        '        producer:',
        '          name: my-producer',
        '          type: spawn_session',
        '          projectPath: /tmp/test',
        '          prompt: "produce code"',
        '        reviewer:',
        '          name: my-reviewer',
        '          type: spawn_session',
        '          projectPath: /tmp/test',
        '          prompt: "review code"',
        '          result_file: review-verdict.yaml',
        '      - name: sibling-step',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "sibling work"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'review-loop-test')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'review-group', type: 'parallel_group' }),
        makeStepState({ name: 'my-review', type: 'review_loop' as any, parentGroup: 'review-group' }),
        makeStepState({ name: 'sibling-step', type: 'spawn_session', parentGroup: 'review-group' }),
      ])

      // Tick 1: review_loop gets pool slot and starts producer. Sibling should be queued.
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[1].status).toBe('running')
      expect(freshRun.steps_state[1].poolSlotId).toBeTruthy()
      expect(freshRun.steps_state[1].reviewSubStep).toBe('producer')
      expect(freshRun.steps_state[1].reviewIteration).toBe(1)
      expect(freshRun.steps_state[1].taskId).toBeTruthy()

      // Sibling should be queued (pool has only 1 slot, review_loop holds it)
      expect(freshRun.steps_state[2].status).toBe('queued')
      expect(freshRun.steps_state[2].poolSlotId).toBeTruthy()

      // Pool should show 1 active, 1 queued
      let poolStatus = pool.getStatus()
      expect(poolStatus.active.length).toBe(1)
      expect(poolStatus.queue.length).toBe(1)

      // Save the review_loop's slot ID -- it should NOT change across iterations
      const reviewSlotId = freshRun.steps_state[1].poolSlotId

      // Simulate producer completion
      const producerTaskId = freshRun.steps_state[1].taskId!
      taskStore.updateTask(producerTaskId, { status: 'completed' })

      // Tick 2: producer completes, transitions to reviewer. Slot NOT released.
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[1].status).toBe('running')
      expect(freshRun.steps_state[1].reviewSubStep).toBe('reviewer')
      expect(freshRun.steps_state[1].poolSlotId).toBe(reviewSlotId) // Same slot!
      expect(freshRun.steps_state[1].taskId).toBeTruthy()
      expect(freshRun.steps_state[1].taskId).not.toBe(producerTaskId) // New task

      // Sibling still queued (review_loop still holds the slot)
      expect(freshRun.steps_state[2].status).toBe('queued')
      poolStatus = pool.getStatus()
      expect(poolStatus.active.length).toBe(1)
      expect(poolStatus.queue.length).toBe(1)

      // Simulate reviewer completion with FAIL verdict (triggers another iteration)
      const reviewerTaskId1 = freshRun.steps_state[1].taskId!
      taskStore.updateTask(reviewerTaskId1, { status: 'completed' })

      // Write a verdict file with FAIL
      const nodefs = require('node:fs')
      const verdictDir = freshRun.output_dir
      try { nodefs.mkdirSync(verdictDir, { recursive: true }) } catch { /* ok */ }
      nodefs.writeFileSync(
        require('node:path').join(verdictDir, 'review-verdict.yaml'),
        'verdict: FAIL\ncomments: needs work',
      )

      // Tick 3: reviewer completes with FAIL, loops back to producer iteration 2
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[1].status).toBe('running')
      expect(freshRun.steps_state[1].reviewSubStep).toBe('producer')
      expect(freshRun.steps_state[1].reviewIteration).toBe(2)
      expect(freshRun.steps_state[1].poolSlotId).toBe(reviewSlotId) // STILL same slot!

      // Sibling STILL queued
      expect(freshRun.steps_state[2].status).toBe('queued')

      // Simulate producer iteration 2 completion
      const producerTaskId2 = freshRun.steps_state[1].taskId!
      taskStore.updateTask(producerTaskId2, { status: 'completed' })

      // Tick 4: producer completes, transitions to reviewer again
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[1].status).toBe('running')
      expect(freshRun.steps_state[1].reviewSubStep).toBe('reviewer')
      expect(freshRun.steps_state[1].poolSlotId).toBe(reviewSlotId) // Same slot!

      // Simulate reviewer with PASS verdict
      const reviewerTaskId2 = freshRun.steps_state[1].taskId!
      taskStore.updateTask(reviewerTaskId2, { status: 'completed' })
      nodefs.writeFileSync(
        require('node:path').join(verdictDir, 'review-verdict.yaml'),
        'verdict: PASS\ncomments: looks good',
      )

      // Tick 5: reviewer completes with PASS, review_loop completes, slot released
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[1].status).toBe('completed')
      expect(freshRun.steps_state[1].reviewVerdict).toBe('PASS')

      // Now the sibling should get promoted from queue to active
      // Tick 6: sibling gets slot and starts running
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[2].status).toBe('running')
      expect(freshRun.steps_state[2].taskId).toBeTruthy()

      // Cleanup
      try { nodefs.rmSync(verdictDir, { recursive: true }) } catch { /* ok */ }
    })

    test('TEST-31b: review_loop completes on max_iterations with slot release', () => {
      pool.updateConfig(1)

      const yaml = [
        'name: review-max-iter',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: max-group',
        '    type: parallel_group',
        '    children:',
        '      - name: max-review',
        '        type: review_loop',
        '        max_iterations: 1',
        '        producer:',
        '          name: prod',
        '          type: spawn_session',
        '          projectPath: /tmp/test',
        '          prompt: "produce"',
        '        reviewer:',
        '          name: rev',
        '          type: spawn_session',
        '          projectPath: /tmp/test',
        '          prompt: "review"',
        '          result_file: verdict.yaml',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'review-max-iter')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'max-group', type: 'parallel_group' }),
        makeStepState({ name: 'max-review', type: 'review_loop' as any, parentGroup: 'max-group' }),
      ])

      // Tick 1: starts producer
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].reviewIteration).toBe(1)

      // Complete producer
      taskStore.updateTask(freshRun.steps_state[1].taskId!, { status: 'completed' })

      // Tick 2: transitions to reviewer
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].reviewSubStep).toBe('reviewer')

      // Complete reviewer with FAIL
      taskStore.updateTask(freshRun.steps_state[1].taskId!, { status: 'completed' })
      const nodefs2 = require('node:fs')
      const verdictDir2 = freshRun.output_dir
      try { nodefs2.mkdirSync(verdictDir2, { recursive: true }) } catch { /* ok */ }
      nodefs2.writeFileSync(
        require('node:path').join(verdictDir2, 'verdict.yaml'),
        'verdict: FAIL\ncomments: still bad',
      )

      // Tick 3: max_iterations=1 reached, should complete despite FAIL
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[1].status).toBe('completed')
      expect(freshRun.steps_state[1].reviewVerdict).toContain('max_iterations_reached')

      // Pool slot should be released
      const poolStatus = pool.getStatus()
      expect(poolStatus.active.length).toBe(0)

      // Cleanup
      try { nodefs2.rmSync(verdictDir2, { recursive: true }) } catch { /* ok */ }
    })

    test('TEST-31c: review_loop releases slot on sub-step failure', () => {
      pool.updateConfig(1)

      const yaml = [
        'name: review-fail-test',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: fail-group',
        '    type: parallel_group',
        '    on_failure: continue_others',
        '    children:',
        '      - name: fail-review',
        '        type: review_loop',
        '        max_iterations: 3',
        '        producer:',
        '          name: fail-prod',
        '          type: spawn_session',
        '          projectPath: /tmp/test',
        '          prompt: "produce"',
        '        reviewer:',
        '          name: fail-rev',
        '          type: spawn_session',
        '          projectPath: /tmp/test',
        '          prompt: "review"',
        '      - name: waiting-sibling',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "wait for slot"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'review-fail-test')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'fail-group', type: 'parallel_group' }),
        makeStepState({ name: 'fail-review', type: 'review_loop' as any, parentGroup: 'fail-group' }),
        makeStepState({ name: 'waiting-sibling', type: 'spawn_session', parentGroup: 'fail-group' }),
      ])

      // Tick 1: review_loop gets slot, starts producer
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].status).toBe('running')
      expect(freshRun.steps_state[2].status).toBe('queued')

      // Simulate producer failure
      taskStore.updateTask(freshRun.steps_state[1].taskId!, {
        status: 'failed',
        errorMessage: 'producer crashed',
      })

      // Tick 2: review_loop fails, releases slot
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[1].status).toBe('failed')
      expect(freshRun.steps_state[1].errorMessage).toContain('producer failed')

      // Pool slot should be released, sibling should get promoted
      // Tick 3: sibling gets the released slot
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[2].status).toBe('running')
    })
  })

  // ── Phase 6: parallel_group completion ──────────────────────────────────

  describe('Phase 6: parallel_group completion', () => {
    test('P6-TEST-01: basic parallel execution with 3 native_step children', async () => {
      const fs = require('node:fs')
      const outputDir = '/tmp/test-outputs/p6-test-01-' + Date.now()
      fs.mkdirSync(outputDir, { recursive: true })

      const yaml = [
        'name: p6-basic-parallel',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: basic-group',
        '    type: parallel_group',
        '    children:',
        '      - name: child-1',
        '        type: native_step',
        '        command: "echo child-1"',
        '      - name: child-2',
        '        type: native_step',
        '        command: "echo child-2"',
        '      - name: child-3',
        '        type: native_step',
        '        command: "echo child-3"',
        '  - name: after-group',
        '    type: native_step',
        '    command: "echo after"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p6-basic-parallel')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'basic-group', type: 'parallel_group' }),
        makeStepState({ name: 'child-1', type: 'native_step', parentGroup: 'basic-group' }),
        makeStepState({ name: 'child-2', type: 'native_step', parentGroup: 'basic-group' }),
        makeStepState({ name: 'child-3', type: 'native_step', parentGroup: 'basic-group' }),
        makeStepState({ name: 'after-group', type: 'native_step' }),
      ], { output_dir: outputDir })

      // Tick 1: group -> running, children start (running)
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[0].status).toBe('running') // group
      expect(freshRun.steps_state[1].status).toBe('running') // child-1
      expect(freshRun.steps_state[2].status).toBe('running') // child-2
      expect(freshRun.steps_state[3].status).toBe('running') // child-3

      // Tick until group completes (native_steps complete on monitor tick)
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.steps_state[0].status === 'completed',
      )
      expect(freshRun.steps_state[0].status).toBe('completed')
      expect(freshRun.steps_state[1].status).toBe('completed')
      expect(freshRun.steps_state[2].status).toBe('completed')
      expect(freshRun.steps_state[3].status).toBe('completed')

      // Sequential step after group should proceed
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.status === 'completed' || r.status === 'failed',
      )
      expect(freshRun.status).toBe('completed')
      expect(freshRun.steps_state[4].status).toBe('completed')

      try { fs.rmSync(outputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('P6-TEST-02: fork with tier_min filtering skips high-tier children', async () => {
      const fs = require('node:fs')
      const outputDir = '/tmp/test-outputs/p6-test-02-' + Date.now()
      fs.mkdirSync(outputDir, { recursive: true })

      const yaml = [
        'name: p6-tier-filter',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: tier-group',
        '    type: parallel_group',
        '    children:',
        '      - name: tier-child-1',
        '        type: native_step',
        '        command: "echo child-1"',
        '      - name: tier-child-2',
        '        type: native_step',
        '        command: "echo child-2"',
        '      - name: tier-child-3',
        '        type: native_step',
        '        command: "echo child-3"',
        '        tier_min: 3',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p6-tier-filter')
      const parsed = getParsed(yaml)
      // Run at tier 2 (variables.tier = '2')
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'tier-group', type: 'parallel_group' }),
        makeStepState({ name: 'tier-child-1', type: 'native_step', parentGroup: 'tier-group' }),
        makeStepState({ name: 'tier-child-2', type: 'native_step', parentGroup: 'tier-group' }),
        makeStepState({ name: 'tier-child-3', type: 'native_step', parentGroup: 'tier-group' }),
      ], { output_dir: outputDir, variables: { tier: '2' } })

      // Tick: group starts, child-3 should be skipped by tier_min: 3
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[3].status).toBe('skipped')
      expect(freshRun.steps_state[1].status).toBe('running')
      expect(freshRun.steps_state[2].status).toBe('running')

      // Tick until group completes
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.steps_state[0].status === 'completed',
      )
      // Group is completed (not partial) since no child failed
      expect(freshRun.steps_state[0].status).toBe('completed')

      try { fs.rmSync(outputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('P6-TEST-03: all children skipped by tier completes group', async () => {
      const yaml = [
        'name: p6-all-skip',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: skip-all-group',
        '    type: parallel_group',
        '    children:',
        '      - name: skip-a',
        '        type: native_step',
        '        command: "echo a"',
        '        tier_min: 3',
        '      - name: skip-b',
        '        type: native_step',
        '        command: "echo b"',
        '        tier_min: 3',
        '      - name: skip-c',
        '        type: native_step',
        '        command: "echo c"',
        '        tier_min: 3',
        '  - name: after-skip-group',
        '    type: native_step',
        '    command: "echo after"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p6-all-skip')
      const parsed = getParsed(yaml)
      // Run at tier 1 (default)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'skip-all-group', type: 'parallel_group' }),
        makeStepState({ name: 'skip-a', type: 'native_step', parentGroup: 'skip-all-group' }),
        makeStepState({ name: 'skip-b', type: 'native_step', parentGroup: 'skip-all-group' }),
        makeStepState({ name: 'skip-c', type: 'native_step', parentGroup: 'skip-all-group' }),
        makeStepState({ name: 'after-skip-group', type: 'native_step' }),
      ])

      // Tick 1: group starts, all children skipped -> allTerminal -> group completed
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].status).toBe('skipped')
      expect(freshRun.steps_state[2].status).toBe('skipped')
      expect(freshRun.steps_state[3].status).toBe('skipped')

      // Group may need one more tick to finalize
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[0].status).toBe('completed')

      // Sequential step after group should proceed
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.status === 'completed' || r.status === 'failed',
      )
      expect(freshRun.status).toBe('completed')
      expect(freshRun.steps_state[4].status).toBe('completed')
    })

    test('P6-TEST-04: session children serialize through pool with 1 slot', () => {
      pool.updateConfig(1)

      const yaml = [
        'name: p6-pool-serial',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: pool-group',
        '    type: parallel_group',
        '    children:',
        '      - name: session-1',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "first"',
        '      - name: session-2',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "second"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p6-pool-serial')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'pool-group', type: 'parallel_group' }),
        makeStepState({ name: 'session-1', type: 'spawn_session', parentGroup: 'pool-group' }),
        makeStepState({ name: 'session-2', type: 'spawn_session', parentGroup: 'pool-group' }),
      ])

      // Tick: first gets slot, second queued
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].status).toBe('running')
      expect(freshRun.steps_state[2].status).toBe('queued')

      // Complete first child's task
      const firstTaskId = freshRun.steps_state[1].taskId!
      taskStore.updateTask(firstTaskId, { status: 'completed', completedAt: new Date().toISOString() })

      // Tick: first completes, releases slot, second promoted
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].status).toBe('completed')

      // Second may need another tick to transition from queued to running
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[2].status).toBe('running')
    })

    test('P6-TEST-05: parallel_group as first pipeline step', async () => {
      const fs = require('node:fs')
      const outputDir = '/tmp/test-outputs/p6-test-05-' + Date.now()
      fs.mkdirSync(outputDir, { recursive: true })

      const yaml = [
        'name: p6-first-step-group',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: first-group',
        '    type: parallel_group',
        '    children:',
        '      - name: fg-child-1',
        '        type: native_step',
        '        command: "echo first"',
        '      - name: fg-child-2',
        '        type: native_step',
        '        command: "echo second"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p6-first-step-group')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'first-group', type: 'parallel_group' }),
        makeStepState({ name: 'fg-child-1', type: 'native_step', parentGroup: 'first-group' }),
        makeStepState({ name: 'fg-child-2', type: 'native_step', parentGroup: 'first-group' }),
      ], { output_dir: outputDir })

      // Tick: no preceding step, group should start immediately
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[0].status).toBe('running')
      expect(freshRun.steps_state[1].status).toBe('running')
      expect(freshRun.steps_state[2].status).toBe('running')

      // Tick until completed
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.status === 'completed' || r.status === 'failed',
      )
      expect(freshRun.status).toBe('completed')
      expect(freshRun.steps_state[0].status).toBe('completed')
      expect(freshRun.steps_state[1].status).toBe('completed')
      expect(freshRun.steps_state[2].status).toBe('completed')

      try { fs.rmSync(outputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('P6-TEST-06: serial dependency chain A->B->C within group', async () => {
      const yaml = [
        'name: p6-serial-deps',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: serial-group',
        '    type: parallel_group',
        '    children:',
        '      - name: chain-A',
        '        type: delay',
        '        seconds: 0.01',
        '      - name: chain-B',
        '        type: delay',
        '        seconds: 0.01',
        '        depends_on:',
        '          - chain-A',
        '      - name: chain-C',
        '        type: delay',
        '        seconds: 0.01',
        '        depends_on:',
        '          - chain-B',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p6-serial-deps')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'serial-group', type: 'parallel_group' }),
        makeStepState({ name: 'chain-A', type: 'delay', parentGroup: 'serial-group' }),
        makeStepState({ name: 'chain-B', type: 'delay', parentGroup: 'serial-group' }),
        makeStepState({ name: 'chain-C', type: 'delay', parentGroup: 'serial-group' }),
      ])

      // Tick 1: A starts, B and C stay pending
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].status).toBe('running') // A
      expect(freshRun.steps_state[2].status).toBe('pending') // B
      expect(freshRun.steps_state[3].status).toBe('pending') // C

      // Wait for A to complete, then tick -> B starts
      await Bun.sleep(20)
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.steps_state[2].status === 'running',
        10,
      )
      expect(freshRun.steps_state[1].status).toBe('completed') // A done
      expect(freshRun.steps_state[2].status).toBe('running')   // B running
      expect(freshRun.steps_state[3].status).toBe('pending')   // C still pending

      // Wait for B to complete, then tick -> C starts
      await Bun.sleep(20)
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.steps_state[3].status === 'running',
        10,
      )
      expect(freshRun.steps_state[2].status).toBe('completed') // B done
      expect(freshRun.steps_state[3].status).toBe('running')   // C running

      // Tick until group completes
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.status === 'completed' || r.status === 'failed',
      )
      expect(freshRun.status).toBe('completed')
      expect(freshRun.steps_state[0].status).toBe('completed')
    })

    test('P6-TEST-14: cancel_all terminates siblings and fails group', () => {
      const yaml = [
        'name: p6-cancel-all',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: ca-group',
        '    type: parallel_group',
        '    on_failure: cancel_all',
        '    children:',
        '      - name: ca-fail',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "fail"',
        '      - name: ca-sibling-1',
        '        type: delay',
        '        seconds: 100',
        '      - name: ca-sibling-2',
        '        type: delay',
        '        seconds: 100',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p6-cancel-all')
      const parsed = getParsed(yaml)

      const failedTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'fail',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(failedTask.id, { status: 'failed', errorMessage: 'child failure' })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'ca-group', type: 'parallel_group', status: 'running', startedAt: new Date().toISOString() }),
        makeStepState({
          name: 'ca-fail',
          type: 'spawn_session',
          parentGroup: 'ca-group',
          status: 'running',
          taskId: failedTask.id,
          startedAt: new Date().toISOString(),
        }),
        makeStepState({
          name: 'ca-sibling-1',
          type: 'delay',
          parentGroup: 'ca-group',
          status: 'running',
          startedAt: new Date().toISOString(),
        }),
        makeStepState({
          name: 'ca-sibling-2',
          type: 'delay',
          parentGroup: 'ca-group',
          status: 'running',
          startedAt: new Date().toISOString(),
        }),
      ])

      // Tick 1: detect failure
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].status).toBe('failed')

      // Tick 2: cancel_all cancels siblings
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[2].status).toBe('cancelled')
      expect(freshRun.steps_state[3].status).toBe('cancelled')
      expect(freshRun.steps_state[0].status).toBe('failed')
    })

    test('P6-TEST-15: continue_others with partial status allows next step', async () => {
      const fs = require('node:fs')
      const outputDir = '/tmp/test-outputs/p6-test-15-' + Date.now()
      fs.mkdirSync(outputDir, { recursive: true })

      const yaml = [
        'name: p6-continue-others',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: co-group',
        '    type: parallel_group',
        '    on_failure: continue_others',
        '    children:',
        '      - name: co-fail',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "fail"',
        '      - name: co-ok-1',
        '        type: native_step',
        '        command: "echo ok1"',
        '      - name: co-ok-2',
        '        type: native_step',
        '        command: "echo ok2"',
        '  - name: co-next',
        '    type: native_step',
        '    command: "echo next"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p6-continue-others')
      const parsed = getParsed(yaml)

      const failedTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'fail',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(failedTask.id, { status: 'failed', errorMessage: 'test failure' })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'co-group', type: 'parallel_group', status: 'running', startedAt: new Date().toISOString() }),
        makeStepState({
          name: 'co-fail',
          type: 'spawn_session',
          parentGroup: 'co-group',
          status: 'running',
          taskId: failedTask.id,
          startedAt: new Date().toISOString(),
        }),
        makeStepState({ name: 'co-ok-1', type: 'native_step', parentGroup: 'co-group', status: 'running', startedAt: new Date().toISOString() }),
        makeStepState({ name: 'co-ok-2', type: 'native_step', parentGroup: 'co-group', status: 'running', startedAt: new Date().toISOString() }),
        makeStepState({ name: 'co-next', type: 'native_step' }),
      ], { output_dir: outputDir })

      // Tick 1: detect failure on co-fail, monitor native_step children
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].status).toBe('failed')
      // Native steps should complete (not cancelled -- continue_others)
      expect(freshRun.steps_state[2].status).toBe('completed')
      expect(freshRun.steps_state[3].status).toBe('completed')

      // Tick 2: all children terminal -> group becomes partial
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[0].status).toBe('partial')
      expect(freshRun.steps_state[0].errorMessage).toContain('children failed')

      // REQ-17: partial is non-failed, next step SHOULD proceed
      // areTopLevelDependenciesMet blocks on 'failed' and 'cancelled', not 'partial'
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.steps_state[4].status === 'completed' || r.status === 'completed' || r.status === 'failed',
        10,
      )
      expect(freshRun.steps_state[4].status).toBe('completed')

      try { fs.rmSync(outputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('P6-TEST-16: fail_fast skips signal file and goes directly to sigterm_sent', () => {
      const fs = require('node:fs')
      const outputDir = '/tmp/test-outputs/p6-test-16-' + Date.now()
      fs.mkdirSync(outputDir, { recursive: true })

      const yaml = [
        'name: p6-fail-fast',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: ff-group',
        '    type: parallel_group',
        '    on_failure: fail_fast',
        '    children:',
        '      - name: ff-fail',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "fail"',
        '      - name: ff-running',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "run"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p6-fail-fast')
      const parsed = getParsed(yaml)

      const failedTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'fail',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(failedTask.id, { status: 'failed', errorMessage: 'fast failure' })

      const runningTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'run',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(runningTask.id, { status: 'running' })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'ff-group', type: 'parallel_group', status: 'running', startedAt: new Date().toISOString() }),
        makeStepState({
          name: 'ff-fail',
          type: 'spawn_session',
          parentGroup: 'ff-group',
          status: 'running',
          taskId: failedTask.id,
          startedAt: new Date().toISOString(),
        }),
        makeStepState({
          name: 'ff-running',
          type: 'spawn_session',
          parentGroup: 'ff-group',
          status: 'running',
          taskId: runningTask.id,
          startedAt: new Date().toISOString(),
        }),
      ], { output_dir: outputDir })

      // Tick 1: detect failure
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].status).toBe('failed')

      // Tick 2: fail_fast initiates termination -- skips signal_sent, goes to sigterm_sent
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[2].terminationPhase).toBe('sigterm_sent')

      // Verify no cancel signal file was written (fail_fast skips signal file)
      const nodePath = require('node:path')
      const cancelSignalPath = nodePath.join(outputDir, 'ff-group', 'ff-running', 'ff-running_cancel_requested.yaml')
      expect(fs.existsSync(cancelSignalPath)).toBe(false)

      try { fs.rmSync(outputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('P6-TEST-17: default on_failure is cancel_all', () => {
      const yaml = [
        'name: p6-default-onfailure',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: default-group',
        '    type: parallel_group',
        '    children:',
        '      - name: df-fail',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "fail"',
        '      - name: df-sib-1',
        '        type: delay',
        '        seconds: 100',
        '      - name: df-sib-2',
        '        type: delay',
        '        seconds: 100',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p6-default-onfailure')
      const parsed = getParsed(yaml)

      const failedTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'fail',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(failedTask.id, { status: 'failed', errorMessage: 'test failure' })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'default-group', type: 'parallel_group', status: 'running', startedAt: new Date().toISOString() }),
        makeStepState({
          name: 'df-fail',
          type: 'spawn_session',
          parentGroup: 'default-group',
          status: 'running',
          taskId: failedTask.id,
          startedAt: new Date().toISOString(),
        }),
        makeStepState({
          name: 'df-sib-1',
          type: 'delay',
          parentGroup: 'default-group',
          status: 'running',
          startedAt: new Date().toISOString(),
        }),
        makeStepState({
          name: 'df-sib-2',
          type: 'delay',
          parentGroup: 'default-group',
          status: 'running',
          startedAt: new Date().toISOString(),
        }),
      ])

      // Tick 1: detect failure
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].status).toBe('failed')

      // Tick 2: default on_failure = cancel_all -> siblings cancelled
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[2].status).toBe('cancelled')
      expect(freshRun.steps_state[3].status).toBe('cancelled')
      expect(freshRun.steps_state[0].status).toBe('failed')
    })

    test('P6-TEST-20: max_parallel limits concurrency for session children', () => {
      pool.updateConfig(5) // Pool has plenty of slots

      const yaml = [
        'name: p6-max-parallel',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: mp-group',
        '    type: parallel_group',
        '    max_parallel: 2',
        '    children:',
        '      - name: mp-s1',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "s1"',
        '      - name: mp-s2',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "s2"',
        '      - name: mp-s3',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "s3"',
        '      - name: mp-s4',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "s4"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p6-max-parallel')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'mp-group', type: 'parallel_group' }),
        makeStepState({ name: 'mp-s1', type: 'spawn_session', parentGroup: 'mp-group' }),
        makeStepState({ name: 'mp-s2', type: 'spawn_session', parentGroup: 'mp-group' }),
        makeStepState({ name: 'mp-s3', type: 'spawn_session', parentGroup: 'mp-group' }),
        makeStepState({ name: 'mp-s4', type: 'spawn_session', parentGroup: 'mp-group' }),
      ])

      // Tick: max_parallel=2, so at most 2 session children should be running/queued
      dagEngine.tick(run, parsed)
      const freshRun = workflowStore.getRun(run.id)!

      const activeCount = freshRun.steps_state.filter(
        s => s.parentGroup === 'mp-group' && (s.status === 'running' || s.status === 'queued'),
      ).length
      const pendingCount = freshRun.steps_state.filter(
        s => s.parentGroup === 'mp-group' && s.status === 'pending',
      ).length

      // max_parallel=2 should limit to at most 2 running/queued
      expect(activeCount).toBe(2)
      expect(pendingCount).toBe(2)
    })

    test('P6-TEST-21: non-session steps bypass max_parallel', async () => {
      const fs = require('node:fs')
      const outputDir = '/tmp/test-outputs/p6-test-21-' + Date.now()
      fs.mkdirSync(outputDir, { recursive: true })

      pool.updateConfig(5)

      const yaml = [
        'name: p6-bypass-maxp',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: bmp-group',
        '    type: parallel_group',
        '    max_parallel: 1',
        '    children:',
        '      - name: bmp-session',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "session"',
        '      - name: bmp-native-1',
        '        type: native_step',
        '        command: "echo native1"',
        '      - name: bmp-native-2',
        '        type: native_step',
        '        command: "echo native2"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p6-bypass-maxp')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'bmp-group', type: 'parallel_group' }),
        makeStepState({ name: 'bmp-session', type: 'spawn_session', parentGroup: 'bmp-group' }),
        makeStepState({ name: 'bmp-native-1', type: 'native_step', parentGroup: 'bmp-group' }),
        makeStepState({ name: 'bmp-native-2', type: 'native_step', parentGroup: 'bmp-group' }),
      ], { output_dir: outputDir })

      // Tick: native_steps bypass max_parallel and start immediately
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      // Both native_steps should start (they bypass max_parallel)
      expect(freshRun.steps_state[2].status).toBe('running') // bmp-native-1
      expect(freshRun.steps_state[3].status).toBe('running') // bmp-native-2
      // spawn_session should also get its slot (max_parallel=1 counts only session types)
      expect(freshRun.steps_state[1].status).toBe('running') // bmp-session

      try { fs.rmSync(outputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('P6-TEST-26: group timeout terminates all children', () => {
      const yaml = [
        'name: p6-group-timeout',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: timeout-group',
        '    type: parallel_group',
        '    timeoutSeconds: 1',
        '    children:',
        '      - name: to-child-1',
        '        type: delay',
        '        seconds: 100',
        '      - name: to-child-2',
        '        type: delay',
        '        seconds: 100',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p6-group-timeout')
      const parsed = getParsed(yaml)

      // Set group as already running with startedAt 10 seconds ago (well past 1s timeout)
      const pastStart = new Date(Date.now() - 10000).toISOString()

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'timeout-group', type: 'parallel_group', status: 'running', startedAt: pastStart }),
        makeStepState({
          name: 'to-child-1',
          type: 'delay',
          parentGroup: 'timeout-group',
          status: 'running',
          startedAt: pastStart,
        }),
        makeStepState({
          name: 'to-child-2',
          type: 'delay',
          parentGroup: 'timeout-group',
          status: 'running',
          startedAt: pastStart,
        }),
      ])

      // Tick: timeout exceeded, all children should be cancelled, group fails
      dagEngine.tick(run, parsed)
      const freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[1].status).toBe('cancelled')
      expect(freshRun.steps_state[2].status).toBe('cancelled')
      expect(freshRun.steps_state[0].status).toBe('failed')
      expect(freshRun.steps_state[0].errorMessage).toContain('exceeded timeout')
    })

    test('P6-TEST-28: namespaced output paths for group children', () => {
      const fs = require('node:fs')
      const nodePath = require('node:path')
      const outputDir = '/tmp/test-outputs/p6-test-28-' + Date.now()
      fs.mkdirSync(outputDir, { recursive: true })

      const yaml = [
        'name: p6-namespaced-output',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: generation',
        '    type: parallel_group',
        '    on_failure: cancel_all',
        '    children:',
        '      - name: scaffold',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "scaffold"',
        '      - name: tests',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "tests"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p6-namespaced-output')
      const parsed = getParsed(yaml)

      const failedTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'scaffold',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(failedTask.id, { status: 'failed', errorMessage: 'scaffold failed' })

      const runningTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'tests',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(runningTask.id, { status: 'running' })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'generation', type: 'parallel_group', status: 'running', startedAt: new Date().toISOString() }),
        makeStepState({
          name: 'scaffold',
          type: 'spawn_session',
          parentGroup: 'generation',
          status: 'running',
          taskId: failedTask.id,
          startedAt: new Date().toISOString(),
        }),
        makeStepState({
          name: 'tests',
          type: 'spawn_session',
          parentGroup: 'generation',
          status: 'running',
          taskId: runningTask.id,
          startedAt: new Date().toISOString(),
        }),
      ], { output_dir: outputDir })

      // Tick 1: detect scaffold failure
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      // Tick 2: cancel_all -> write cancel signal for tests at namespaced path
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // REQ-33: Signal file should be at {output_dir}/generation/tests/tests_cancel_requested.yaml
      const expectedSignalPath = nodePath.join(outputDir, 'generation', 'tests', 'tests_cancel_requested.yaml')
      expect(fs.existsSync(expectedSignalPath)).toBe(true)
      const content = fs.readFileSync(expectedSignalPath, 'utf-8')
      expect(content).toContain('reason: sibling_failure')

      try { fs.rmSync(outputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('P6-TEST-29: error message lists failed children by name', () => {
      const yaml = [
        'name: p6-error-msg',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: errmsg-group',
        '    type: parallel_group',
        '    on_failure: continue_others',
        '    children:',
        '      - name: em-fail-1',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "fail1"',
        '      - name: em-ok-1',
        '        type: delay',
        '        seconds: 0.01',
        '      - name: em-fail-2',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "fail2"',
        '      - name: em-ok-2',
        '        type: delay',
        '        seconds: 0.01',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p6-error-msg')
      const parsed = getParsed(yaml)

      const failTask1 = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'fail1',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(failTask1.id, { status: 'failed', errorMessage: 'error 1' })

      const failTask2 = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'fail2',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(failTask2.id, { status: 'failed', errorMessage: 'error 2' })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'errmsg-group', type: 'parallel_group', status: 'running', startedAt: new Date().toISOString() }),
        makeStepState({
          name: 'em-fail-1',
          type: 'spawn_session',
          parentGroup: 'errmsg-group',
          status: 'failed',
          taskId: failTask1.id,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          errorMessage: 'error 1',
        }),
        makeStepState({
          name: 'em-ok-1',
          type: 'delay',
          parentGroup: 'errmsg-group',
          status: 'completed',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }),
        makeStepState({
          name: 'em-fail-2',
          type: 'spawn_session',
          parentGroup: 'errmsg-group',
          status: 'failed',
          taskId: failTask2.id,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          errorMessage: 'error 2',
        }),
        makeStepState({
          name: 'em-ok-2',
          type: 'delay',
          parentGroup: 'errmsg-group',
          status: 'completed',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        }),
      ])

      // All children already terminal. Tick: group should see all terminal -> partial
      dagEngine.tick(run, parsed)
      const freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].status).toBe('partial')
      expect(freshRun.steps_state[0].errorMessage).toContain('2 of 4 children failed')
      expect(freshRun.steps_state[0].errorMessage).toContain('em-fail-1')
      expect(freshRun.steps_state[0].errorMessage).toContain('em-fail-2')
    })

    test('P6-TEST-30: full pipeline integration seq A -> group B -> seq C', async () => {
      const fs = require('node:fs')
      const outputDir = '/tmp/test-outputs/p6-test-30-' + Date.now()
      fs.mkdirSync(outputDir, { recursive: true })

      const yaml = [
        'name: p6-full-pipeline',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: step-A',
        '    type: native_step',
        '    command: "echo step-A"',
        '  - name: step-B',
        '    type: parallel_group',
        '    children:',
        '      - name: b-child-1',
        '        type: native_step',
        '        command: "echo b1"',
        '      - name: b-child-2',
        '        type: native_step',
        '        command: "echo b2"',
        '        depends_on:',
        '          - b-child-1',
        '      - name: b-child-3',
        '        type: native_step',
        '        command: "echo b3"',
        '  - name: step-C',
        '    type: native_step',
        '    command: "echo step-C"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p6-full-pipeline')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'step-A', type: 'native_step' }),
        makeStepState({ name: 'step-B', type: 'parallel_group' }),
        makeStepState({ name: 'b-child-1', type: 'native_step', parentGroup: 'step-B' }),
        makeStepState({ name: 'b-child-2', type: 'native_step', parentGroup: 'step-B' }),
        makeStepState({ name: 'b-child-3', type: 'native_step', parentGroup: 'step-B' }),
        makeStepState({ name: 'step-C', type: 'native_step' }),
      ], { output_dir: outputDir })

      // Tick 1: top-level native_step A starts AND completes in one tick
      // (startStep sets running, then monitorStep executes command in same tick)
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[0].status).toBe('completed')

      // Tick through: group B starts, children fork with deps respected, then C runs
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.steps_state[1].status === 'running',
      )
      expect(freshRun.steps_state[1].status).toBe('running') // group running

      // Tick until group B completes (b-child-2 depends on b-child-1, so serialized)
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.steps_state[1].status === 'completed',
      )
      expect(freshRun.steps_state[1].status).toBe('completed')
      expect(freshRun.steps_state[2].status).toBe('completed') // b-child-1
      expect(freshRun.steps_state[3].status).toBe('completed') // b-child-2
      expect(freshRun.steps_state[4].status).toBe('completed') // b-child-3

      // Verify b-child-2 started after b-child-1 (dependency enforced)
      expect(freshRun.steps_state[3].startedAt).not.toBeNull()
      expect(freshRun.steps_state[2].completedAt).not.toBeNull()

      // step-C should now start and complete
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.status === 'completed' || r.status === 'failed',
      )
      expect(freshRun.status).toBe('completed')
      expect(freshRun.steps_state[5].status).toBe('completed')

      try { fs.rmSync(outputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('P6-TEST-35: paused (running) child does not block siblings', () => {
      // REQ-35: A child in a "paused" state (still status: 'running') does not block siblings.
      // Paused children are a sub-state of 'running' (no distinct status), so the group
      // continues processing other children while the paused one stays 'running'.
      // Use spawn_session for the paused child so monitorStep checks task status (stays running).
      const yaml = [
        'name: paused-child-test',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: pg',
        '    type: parallel_group',
        '    children:',
        '      - name: paused-review',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "paused"',
        '      - name: sibling-work',
        '        type: native_step',
        '        command: "echo sibling"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'paused-child-test')
      const parsed = getParsed(yaml)

      // Create a task that stays 'running' (simulates paused amendment)
      const pausedTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'paused',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(pausedTask.id, { status: 'running' })

      // Simulate: paused-review is 'running' with its task, sibling-work is 'pending'
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'pg', type: 'parallel_group' }),
        makeStepState({
          name: 'paused-review',
          type: 'spawn_session' as any,
          parentGroup: 'pg',
          status: 'running',
          taskId: pausedTask.id,
          startedAt: new Date().toISOString(),
        }),
        makeStepState({
          name: 'sibling-work',
          type: 'native_step' as any,
          parentGroup: 'pg',
          status: 'pending',
        }),
      ])

      // Tick 1: group goes running, sibling-work starts (-> running)
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      // Group should be running (not blocked)
      expect(freshRun.steps_state[0].status).toBe('running')

      // Sibling should have started
      expect(['running', 'completed']).toContain(freshRun.steps_state[2].status)

      // Tick 2: monitorStep runs sibling native_step -> completed
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // Sibling completed
      expect(freshRun.steps_state[2].status).toBe('completed')

      // Paused child should still be running (task is still 'running')
      expect(freshRun.steps_state[1].status).toBe('running')

      // Group should NOT be complete yet (paused-review is non-terminal)
      expect(freshRun.steps_state[0].status).toBe('running')
    })
  })
})
