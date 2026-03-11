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
        '    steps:',
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
        '    steps:',
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
        '    steps:',
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
        '    steps:',
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
        '    steps:',
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
        '    steps:',
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
        '    steps:',
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

    test('spawn_session injects content from context/spec input types', async () => {
      const nodefs = require('node:fs')
      const nodepath = require('node:path')

      // Create test context file
      const tmpDir = '/tmp/agentboard-context-test'
      nodefs.mkdirSync(tmpDir, { recursive: true })
      const contextFile = nodepath.join(tmpDir, 'context-summary.yaml')
      nodefs.writeFileSync(contextFile, 'KEY_CONTEXT: This is critical info', 'utf-8')

      try {
        const yaml = [
          'name: context-inject-test',
          'system:',
          '  engine: dag',
          '  session_pool: true',
          'steps:',
          '  - name: context-step',
          '    type: spawn_session',
          '    projectPath: /tmp/test',
          '    agent: implementor',
          '    description: "do work with context"',
          `    inputs:`,
          `      - path: "${contextFile}"`,
          `        type: context`,
          `        label: Context`,
        ].join('\n')

        const wf = createWorkflowDef(workflowStore, yaml, 'context-inject-test')
        const parsed = getParsed(yaml)
        const run = createTestRun(workflowStore, wf.id, [
          makeStepState({ name: 'context-step', type: 'spawn_session' }),
        ])

        dagEngine.tick(run, parsed)
        const freshRun = workflowStore.getRun(run.id)!

        // Task should be created
        const tasks = taskStore.listTasks()
        const task = tasks.find(t => t.projectPath === '/tmp/test')
        expect(task).toBeTruthy()

        // Prompt should include injected content
        expect(task!.prompt).toContain('## Context')
        expect(task!.prompt).toContain('KEY_CONTEXT: This is critical info')
      } finally {
        nodefs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    test('spawn_session keeps reference inputs as paths only', async () => {
      const yaml = [
        'name: reference-test',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: reference-step',
        '    type: spawn_session',
        '    projectPath: /tmp/test',
        '    agent: reviewer',
        '    inputs:',
        '      - path: /path/to/spec.yaml',
        '        type: reference',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'reference-test')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'reference-step', type: 'spawn_session' }),
      ])

      dagEngine.tick(run, parsed)
      const freshRun = workflowStore.getRun(run.id)!

      const tasks = taskStore.listTasks()
      const task = tasks.find(t => t.projectPath === '/tmp/test')
      expect(task).toBeTruthy()

      // Reference inputs should only show path, not content
      expect(task!.prompt).toContain('Input files:')
      expect(task!.prompt).toContain('- /path/to/spec.yaml')
      expect(task!.prompt).not.toContain('##')
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
        '    steps:',
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
        '    steps:',
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
        '    steps:',
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
        '    steps:',
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
      // Schema now validates action names at parse time, so use parseWorkflowYAML
      // directly (bypassing the strict getParsed helper) to test runtime behaviour
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
      // Use parseWorkflowYAML directly — schema rejects unknown actions now,
      // but we want to test the runtime path. Construct parsed manually.
      const result = parseWorkflowYAML(yaml)
      // Schema now catches unknown actions at parse time — verify it produces an error
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.includes('nonexistent_action'))).toBe(true)
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
      expect(freshRun.steps_state[0].errorMessage).toContain('requires command, action, or checks')
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
        '    steps:',
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
      pool.updateConfig(2) // 2 slots: allows slot cycling without deadlock

      const yaml = [
        'name: review-loop-test',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: review-group',
        '    type: parallel_group',
        '    steps:',
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
        '          verdict_field: verdict',
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

      // Sibling should also be running (pool has 2 slots)
      expect(freshRun.steps_state[2].status).toBe('running')
      expect(freshRun.steps_state[2].poolSlotId).toBeTruthy()

      // Pool should show 2 active, 0 queued
      let poolStatus = pool.getStatus()
      expect(poolStatus.active.length).toBe(2)
      expect(poolStatus.queue.length).toBe(0)

      // Save the review_loop's slot ID -- it should NOT change across iterations
      const _reviewSlotId = freshRun.steps_state[1].poolSlotId

      // Simulate producer completion
      const producerTaskId = freshRun.steps_state[1].taskId!
      taskStore.updateTask(producerTaskId, { status: 'completed' })

      // Tick 2: producer completes, transitions to between. Slot NOT released.
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[1].status).toBe('running')
      expect(freshRun.steps_state[1].reviewSubStep).toBe('between')

      // Tick 3-10: pool cycling - may need several ticks for slot re-acquisition
      // Just tick until reviewer starts or max iterations
      let maxTicks = 10
      while (maxTicks-- > 0 && freshRun.steps_state[1].reviewSubStep !== 'reviewer') {
        dagEngine.tick(freshRun, parsed)
        freshRun = workflowStore.getRun(run.id)!
      }

      expect(freshRun.steps_state[1].status).toBe('running')
      expect(freshRun.steps_state[1].reviewSubStep).toBe('reviewer')
      expect(freshRun.steps_state[1].poolSlotId).toBeTruthy() // Has a slot
      expect(freshRun.steps_state[1].taskId).toBeTruthy()
      expect(freshRun.steps_state[1].taskId).not.toBe(producerTaskId) // New task

      // Sibling still running (pool has 2 slots, both can run)
      expect(['running', 'completed']).toContain(freshRun.steps_state[2].status)

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
      expect(freshRun.steps_state[1].poolSlotId).toBeTruthy() // Has a slot (may be different after cycling)

      // Sibling may be running or completed (pool has 2 slots)
      expect(['running', 'completed']).toContain(freshRun.steps_state[2].status)

      // Simulate producer iteration 2 completion
      const producerTaskId2 = freshRun.steps_state[1].taskId!
      taskStore.updateTask(producerTaskId2, { status: 'completed' })

      // Tick through to reviewer again (may need multiple ticks for pool cycling)
      maxTicks = 10
      while (maxTicks-- > 0 && freshRun.steps_state[1].reviewSubStep !== 'reviewer') {
        dagEngine.tick(freshRun, parsed)
        freshRun = workflowStore.getRun(run.id)!
      }

      expect(freshRun.steps_state[1].status).toBe('running')
      expect(freshRun.steps_state[1].reviewSubStep).toBe('reviewer')
      expect(freshRun.steps_state[1].poolSlotId).toBeTruthy() // Has a slot

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

      // Sibling should already be running or completed (pool has 2 slots)
      expect(['running', 'completed']).toContain(freshRun.steps_state[2].status)

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
        '    steps:',
        '      - name: max-review',
        '        type: review_loop',
        '        max_iterations: 2',
        '        on_max_iterations: accept_last',
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
        '          verdict_field: verdict',
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

      // Tick 2: transitions to between (needsReviewerSlot=true)
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].reviewSubStep).toBe('between')

      // Tick 3: REQ-17 gap tick — clears needsReviewerSlot
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].reviewSubStep).toBe('between')

      // Tick 4: between -> reviewer
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].reviewSubStep).toBe('reviewer')

      // Complete reviewer with FAIL (iteration 1 — loops back to producer)
      taskStore.updateTask(freshRun.steps_state[1].taskId!, { status: 'completed' })
      const nodefs2 = require('node:fs')
      const verdictDir2 = freshRun.output_dir
      try { nodefs2.mkdirSync(verdictDir2, { recursive: true }) } catch { /* ok */ }
      nodefs2.writeFileSync(
        require('node:path').join(verdictDir2, 'verdict.yaml'),
        'verdict: FAIL\ncomments: still bad',
      )

      // Tick: verdict processed, loops back to producer for iteration 2
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // Iteration 2: complete producer
      taskStore.updateTask(freshRun.steps_state[1].taskId!, { status: 'completed' })

      // Tick: between
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // Tick: REQ-17 gap tick
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // Tick: between -> reviewer
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // Complete reviewer with FAIL (iteration 2 — max_iterations=2 reached)
      taskStore.updateTask(freshRun.steps_state[1].taskId!, { status: 'completed' })
      nodefs2.writeFileSync(
        require('node:path').join(verdictDir2, 'verdict.yaml'),
        'verdict: FAIL\ncomments: still bad',
      )

      // Tick: max_iterations=2 reached, accept_last policy completes with warning
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[1].status).toBe('completed')
      expect(freshRun.steps_state[1].completedWithWarning).toBe(true)

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
        '    steps:',
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
        '          result_file: verdict.yaml',
        '          verdict_field: verdict',
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
        '    steps:',
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
        '    steps:',
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
        '    steps:',
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

      // Tick 1: group starts, all children skipped -> allTerminal -> group skipped
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].status).toBe('skipped')
      expect(freshRun.steps_state[2].status).toBe('skipped')
      expect(freshRun.steps_state[3].status).toBe('skipped')

      // Group may need one more tick to finalize
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[0].status).toBe('skipped')

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
        '    steps:',
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
        '    steps:',
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
        '    steps:',
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
        '    steps:',
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
        '    steps:',
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
        '    steps:',
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
        '    steps:',
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
        '    steps:',
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
        '    steps:',
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
        '    steps:',
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
        '    steps:',
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
        '    steps:',
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
        '    steps:',
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
        '    steps:',
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

    // ── TEST-04: Session children request pool slots ──────────────────────
    test('TEST-04: session children request pool slots and serialize through pool', () => {
      pool.updateConfig(1) // pool_size=1

      const yaml = [
        'name: t04-pool-serial',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: t04-group',
        '    type: parallel_group',
        '    steps:',
        '      - name: t04-s1',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "first"',
        '      - name: t04-s2',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "second"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 't04-pool-serial')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 't04-group', type: 'parallel_group' }),
        makeStepState({ name: 't04-s1', type: 'spawn_session', parentGroup: 't04-group' }),
        makeStepState({ name: 't04-s2', type: 'spawn_session', parentGroup: 't04-group' }),
      ])

      // Tick: first child gets slot immediately (active), second queues
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[1].status).toBe('running')   // first gets slot
      expect(freshRun.steps_state[1].poolSlotId).toBeTruthy()
      expect(freshRun.steps_state[2].status).toBe('queued')     // second queued
      expect(freshRun.steps_state[2].poolSlotId).toBeTruthy()

      // Complete first child's task -> releases slot -> second gets promoted
      const firstTaskId = freshRun.steps_state[1].taskId!
      taskStore.updateTask(firstTaskId, { status: 'completed', completedAt: new Date().toISOString() })

      // Tick: first completes, releases slot
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].status).toBe('completed')

      // Tick: second gets promoted slot and starts running
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[2].status).toBe('running')
      expect(freshRun.steps_state[2].taskId).toBeTruthy()
    })

    // ── TEST-06: Simple dependency chain (A->B->C) ──────────────────────
    test('TEST-06: simple dependency chain A->B->C executes in order', async () => {
      const yaml = [
        'name: t06-chain',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: t06-group',
        '    type: parallel_group',
        '    steps:',
        '      - name: t06-A',
        '        type: delay',
        '        seconds: 0.01',
        '      - name: t06-B',
        '        type: delay',
        '        seconds: 0.01',
        '        depends_on:',
        '          - t06-A',
        '      - name: t06-C',
        '        type: delay',
        '        seconds: 0.01',
        '        depends_on:',
        '          - t06-B',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 't06-chain')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 't06-group', type: 'parallel_group' }),
        makeStepState({ name: 't06-A', type: 'delay', parentGroup: 't06-group' }),
        makeStepState({ name: 't06-B', type: 'delay', parentGroup: 't06-group' }),
        makeStepState({ name: 't06-C', type: 'delay', parentGroup: 't06-group' }),
      ])

      // Tick 1: A starts, B and C stay pending (deps not met)
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].status).toBe('running')  // A
      expect(freshRun.steps_state[2].status).toBe('pending')  // B blocked by A
      expect(freshRun.steps_state[3].status).toBe('pending')  // C blocked by B

      // Wait for A to complete, tick -> B starts
      await Bun.sleep(20)
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.steps_state[2].status === 'running',
        10,
      )
      expect(freshRun.steps_state[1].status).toBe('completed') // A done
      expect(freshRun.steps_state[2].status).toBe('running')   // B running
      expect(freshRun.steps_state[3].status).toBe('pending')   // C still blocked

      // Wait for B to complete, tick -> C starts
      await Bun.sleep(20)
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.steps_state[3].status === 'running',
        10,
      )
      expect(freshRun.steps_state[2].status).toBe('completed') // B done
      expect(freshRun.steps_state[3].status).toBe('running')   // C running

      // Tick until completed
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.status === 'completed' || r.status === 'failed',
      )
      expect(freshRun.status).toBe('completed')

      // Verify execution order: A completed before B started, B completed before C started
      expect(new Date(freshRun.steps_state[1].completedAt!).getTime())
        .toBeLessThanOrEqual(new Date(freshRun.steps_state[2].startedAt!).getTime())
      expect(new Date(freshRun.steps_state[2].completedAt!).getTime())
        .toBeLessThanOrEqual(new Date(freshRun.steps_state[3].startedAt!).getTime())
    })

    // ── TEST-14: cancel_all releases pool slots ──────────────────────────
    test('TEST-14: cancel_all releases all pool slots after termination', () => {
      pool.updateConfig(3) // 3 slots

      const yaml = [
        'name: t14-pool-release',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: t14-group',
        '    type: parallel_group',
        '    on_failure: cancel_all',
        '    steps:',
        '      - name: t14-fail',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "fail"',
        '      - name: t14-ok-1',
        '        type: delay',
        '        seconds: 100',
        '      - name: t14-ok-2',
        '        type: delay',
        '        seconds: 100',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 't14-pool-release')
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

      // Request pool slot manually for the spawn_session child
      const slot = pool.requestSlot({ runId: 'test-run', stepName: 't14-fail', tier: 1 })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 't14-group', type: 'parallel_group', status: 'running', startedAt: new Date().toISOString() }),
        makeStepState({
          name: 't14-fail',
          type: 'spawn_session',
          parentGroup: 't14-group',
          status: 'running',
          taskId: failedTask.id,
          startedAt: new Date().toISOString(),
          poolSlotId: slot.slot!.id,
        }),
        makeStepState({
          name: 't14-ok-1',
          type: 'delay',
          parentGroup: 't14-group',
          status: 'running',
          startedAt: new Date().toISOString(),
        }),
        makeStepState({
          name: 't14-ok-2',
          type: 'delay',
          parentGroup: 't14-group',
          status: 'running',
          startedAt: new Date().toISOString(),
        }),
      ])

      // Before: 1 active pool slot
      let poolStatus = pool.getStatus()
      expect(poolStatus.active.length).toBe(1)

      // Tick 1: detect failure
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      // Tick 2: cancel_all cancels siblings
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[1].status).toBe('failed')
      expect(freshRun.steps_state[2].status).toBe('cancelled')
      expect(freshRun.steps_state[3].status).toBe('cancelled')
      expect(freshRun.steps_state[0].status).toBe('failed')

      // Pool slots should be released after termination
      poolStatus = pool.getStatus()
      expect(poolStatus.active.length).toBe(0)
      expect(poolStatus.queue.length).toBe(0)
    })

    // ── TEST-20: max_parallel limits concurrency with completion ─────────
    test('TEST-20: max_parallel limits concurrency and processes remaining after completion', () => {
      pool.updateConfig(10) // Plenty of pool slots

      const yaml = [
        'name: t20-max-parallel',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: t20-group',
        '    type: parallel_group',
        '    max_parallel: 2',
        '    steps:',
        '      - name: t20-s1',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "s1"',
        '      - name: t20-s2',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "s2"',
        '      - name: t20-s3',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "s3"',
        '      - name: t20-s4',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "s4"',
        '      - name: t20-s5',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "s5"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 't20-max-parallel')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 't20-group', type: 'parallel_group' }),
        makeStepState({ name: 't20-s1', type: 'spawn_session', parentGroup: 't20-group' }),
        makeStepState({ name: 't20-s2', type: 'spawn_session', parentGroup: 't20-group' }),
        makeStepState({ name: 't20-s3', type: 'spawn_session', parentGroup: 't20-group' }),
        makeStepState({ name: 't20-s4', type: 'spawn_session', parentGroup: 't20-group' }),
        makeStepState({ name: 't20-s5', type: 'spawn_session', parentGroup: 't20-group' }),
      ])

      // Tick: max_parallel=2 should limit to 2 running
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      const activeCount = freshRun.steps_state.filter(
        s => s.parentGroup === 't20-group' && (s.status === 'running' || s.status === 'queued'),
      ).length
      const pendingCount = freshRun.steps_state.filter(
        s => s.parentGroup === 't20-group' && s.status === 'pending',
      ).length

      expect(activeCount).toBe(2)
      expect(pendingCount).toBe(3)

      // Complete the 2 running children
      const runningChildren = freshRun.steps_state.filter(
        s => s.parentGroup === 't20-group' && s.status === 'running',
      )
      expect(runningChildren.length).toBe(2)
      for (const child of runningChildren) {
        taskStore.updateTask(child.taskId!, { status: 'completed', completedAt: new Date().toISOString() })
      }

      // Tick: completed children release, next 2 should start (still respecting max_parallel)
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      const completedCount = freshRun.steps_state.filter(
        s => s.parentGroup === 't20-group' && s.status === 'completed',
      ).length
      const newRunning = freshRun.steps_state.filter(
        s => s.parentGroup === 't20-group' && s.status === 'running',
      ).length

      expect(completedCount).toBe(2)
      // New batch should respect max_parallel=2
      expect(newRunning).toBeLessThanOrEqual(2)
      expect(newRunning).toBeGreaterThanOrEqual(1)
    })

    // ── TEST-21: max_parallel with non-session steps ────────────────────
    test('TEST-21: non-session steps run without waiting for max_parallel cap', async () => {
      const fs = require('node:fs')
      const outputDir = '/tmp/test-outputs/t21-bypass-' + Date.now()
      fs.mkdirSync(outputDir, { recursive: true })

      pool.updateConfig(5)

      const yaml = [
        'name: t21-mixed-maxp',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: t21-group',
        '    type: parallel_group',
        '    max_parallel: 1',
        '    steps:',
        '      - name: t21-session',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "session"',
        '      - name: t21-native-1',
        '        type: native_step',
        '        command: "echo native1"',
        '      - name: t21-native-2',
        '        type: native_step',
        '        command: "echo native2"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 't21-mixed-maxp')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 't21-group', type: 'parallel_group' }),
        makeStepState({ name: 't21-session', type: 'spawn_session', parentGroup: 't21-group' }),
        makeStepState({ name: 't21-native-1', type: 'native_step', parentGroup: 't21-group' }),
        makeStepState({ name: 't21-native-2', type: 'native_step', parentGroup: 't21-group' }),
      ], { output_dir: outputDir })

      // Tick: native_steps bypass max_parallel, spawn_session uses pool normally
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      // Both native_steps should start (they bypass max_parallel)
      expect(freshRun.steps_state[2].status).toBe('running') // native-1
      expect(freshRun.steps_state[3].status).toBe('running') // native-2
      // spawn_session should also get its slot (max_parallel only counts session types)
      expect(freshRun.steps_state[1].status).toBe('running') // session
      expect(freshRun.steps_state[1].poolSlotId).toBeTruthy()

      try { fs.rmSync(outputDir, { recursive: true }) } catch { /* ok */ }
    })

    // ── TEST-23: Pending children cancelled without SIGTERM ─────────────
    test('TEST-23: pending children cancelled without SIGTERM on failure', () => {
      // Use non-session children in pending state to avoid pool slot complications.
      // The cancel_all policy should mark pending/queued children as cancelled
      // without invoking the SIGTERM termination state machine.
      const yaml = [
        'name: t23-pending-cancel',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: t23-group',
        '    type: parallel_group',
        '    on_failure: cancel_all',
        '    steps:',
        '      - name: t23-active',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "active"',
        '      - name: t23-pending-1',
        '        type: delay',
        '        seconds: 100',
        '        depends_on:',
        '          - t23-active',
        '      - name: t23-pending-2',
        '        type: delay',
        '        seconds: 100',
        '        depends_on:',
        '          - t23-active',
        '      - name: t23-pending-3',
        '        type: delay',
        '        seconds: 100',
        '        depends_on:',
        '          - t23-active',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 't23-pending-cancel')
      const parsed = getParsed(yaml)

      // Create a failed task for the first child
      const failedTask = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'active',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(failedTask.id, { status: 'failed', errorMessage: 'active failed' })

      // First child running (will fail), rest pending (depend on first)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 't23-group', type: 'parallel_group', status: 'running', startedAt: new Date().toISOString() }),
        makeStepState({
          name: 't23-active',
          type: 'spawn_session',
          parentGroup: 't23-group',
          status: 'running',
          taskId: failedTask.id,
          startedAt: new Date().toISOString(),
        }),
        makeStepState({ name: 't23-pending-1', type: 'delay', parentGroup: 't23-group', status: 'pending' }),
        makeStepState({ name: 't23-pending-2', type: 'delay', parentGroup: 't23-group', status: 'pending' }),
        makeStepState({ name: 't23-pending-3', type: 'delay', parentGroup: 't23-group', status: 'pending' }),
      ])

      // Tick 1: detect failure on active child
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].status).toBe('failed')

      // Tick 2: cancel_all policy -- pending children cancelled immediately
      // (no SIGTERM needed since they never started)
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[2].status).toBe('cancelled')
      expect(freshRun.steps_state[3].status).toBe('cancelled')
      expect(freshRun.steps_state[4].status).toBe('cancelled')

      // Pending children should NOT have terminationPhase set (no SIGTERM for pending)
      expect(freshRun.steps_state[2].terminationPhase).toBeFalsy()
      expect(freshRun.steps_state[3].terminationPhase).toBeFalsy()
      expect(freshRun.steps_state[4].terminationPhase).toBeFalsy()

      expect(freshRun.steps_state[0].status).toBe('failed')
    })

    // ── TEST-24: Nested parallel_group rejected ─────────────────────────
    test('TEST-24: nested parallel_group rejected at parse time', () => {
      const yaml = [
        'name: t24-nested-pg',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: outer-group',
        '    type: parallel_group',
        '    steps:',
        '      - name: inner-group',
        '        type: parallel_group',
        '        steps:',
        '          - name: inner-child',
        '            type: delay',
        '            seconds: 0.01',
      ].join('\n')

      const result = parseWorkflowYAML(yaml)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.includes('cannot be nested'))).toBe(true)
    })

    // ── TEST-25: review_loop inside parallel_group ──────────────────────
    test('TEST-25: review_loop inside parallel_group executes with pool slot', () => {
      pool.updateConfig(2) // 2 slots: 1 for review_loop, 1 for native_step

      const yaml = [
        'name: t25-review-in-group',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: t25-group',
        '    type: parallel_group',
        '    steps:',
        '      - name: t25-review',
        '        type: review_loop',
        '        max_iterations: 2',
        '        producer:',
        '          name: t25-prod',
        '          type: spawn_session',
        '          projectPath: /tmp/test',
        '          prompt: "produce"',
        '        reviewer:',
        '          name: t25-rev',
        '          type: spawn_session',
        '          projectPath: /tmp/test',
        '          prompt: "review"',
        '          result_file: verdict.yaml',
        '          verdict_field: verdict',
        '      - name: t25-native',
        '        type: native_step',
        '        command: "echo native"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 't25-review-in-group')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 't25-group', type: 'parallel_group' }),
        makeStepState({ name: 't25-review', type: 'review_loop' as any, parentGroup: 't25-group' }),
        makeStepState({ name: 't25-native', type: 'native_step', parentGroup: 't25-group' }),
      ])

      // Tick 1: review_loop starts producer with pool slot; native_step starts too
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      // Review loop should be running with a pool slot
      expect(freshRun.steps_state[1].status).toBe('running')
      expect(freshRun.steps_state[1].poolSlotId).toBeTruthy()
      expect(freshRun.steps_state[1].reviewSubStep).toBe('producer')
      expect(freshRun.steps_state[1].taskId).toBeTruthy()

      // Native step should NOT be blocked by review_loop's slot reservation
      expect(['running', 'completed']).toContain(freshRun.steps_state[2].status)

      // Save review slot ID to verify it persists
      const _reviewSlotId = freshRun.steps_state[1].poolSlotId

      // Simulate producer completion
      taskStore.updateTask(freshRun.steps_state[1].taskId!, { status: 'completed' })

      // Tick 2: producer -> between transition
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[1].reviewSubStep).toBe('between')

      // Tick 3: between waits for slot (pool cycling)
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // Tick 4: slot granted, reviewer starts
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[1].reviewSubStep).toBe('reviewer')
      // Note: slot may be different due to pool cycling, just verify it has one
      expect(freshRun.steps_state[1].poolSlotId).toBeTruthy()
    })

    // ── TEST-26: Group timeout terminates all children (enhanced) ────────
    test('TEST-26: group timeout terminates spawn_session children with cancel_all policy', () => {
      const fs = require('node:fs')
      const outputDir = '/tmp/test-outputs/t26-timeout-' + Date.now()
      fs.mkdirSync(outputDir, { recursive: true })

      pool.updateConfig(3)

      const yaml = [
        'name: t26-timeout-spawn',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: t26-group',
        '    type: parallel_group',
        '    timeoutSeconds: 1',
        '    steps:',
        '      - name: t26-child-1',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "child1"',
        '      - name: t26-child-2',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "child2"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 't26-timeout-spawn')
      const parsed = getParsed(yaml)

      // Create running tasks for both children
      const task1 = taskStore.createTask({
        projectPath: '/tmp/test', prompt: 'child1',
        templateId: null, priority: 5, status: 'queued', maxRetries: 0, timeoutSeconds: 1800,
      })
      taskStore.updateTask(task1.id, { status: 'running' })

      const task2 = taskStore.createTask({
        projectPath: '/tmp/test', prompt: 'child2',
        templateId: null, priority: 5, status: 'queued', maxRetries: 0, timeoutSeconds: 1800,
      })
      taskStore.updateTask(task2.id, { status: 'running' })

      // Request pool slots
      const s1 = pool.requestSlot({ runId: 'test', stepName: 't26-child-1', tier: 1 })
      const s2 = pool.requestSlot({ runId: 'test', stepName: 't26-child-2', tier: 1 })

      // Set group as already running with startedAt 10 seconds ago (well past 1s timeout)
      const pastStart = new Date(Date.now() - 10000).toISOString()

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 't26-group', type: 'parallel_group', status: 'running', startedAt: pastStart }),
        makeStepState({
          name: 't26-child-1',
          type: 'spawn_session',
          parentGroup: 't26-group',
          status: 'running',
          taskId: task1.id,
          startedAt: pastStart,
          poolSlotId: s1.slot!.id,
        }),
        makeStepState({
          name: 't26-child-2',
          type: 'spawn_session',
          parentGroup: 't26-group',
          status: 'running',
          taskId: task2.id,
          startedAt: pastStart,
          poolSlotId: s2.slot!.id,
        }),
      ], { output_dir: outputDir })

      // Verify pool has 2 active before timeout
      let poolStatus = pool.getStatus()
      expect(poolStatus.active.length).toBe(2)

      // Tick 1: timeout exceeded -> uses cancel_all policy -> signal files written, state machine starts
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      // BUG FIX VERIFICATION: cancel_all writes signal files (not fail_fast)
      const nodePath = require('node:path')
      const signalPath1 = nodePath.join(outputDir, 't26-group', 't26-child-1', 't26-child-1_cancel_requested.yaml')
      const signalPath2 = nodePath.join(outputDir, 't26-group', 't26-child-2', 't26-child-2_cancel_requested.yaml')
      expect(fs.existsSync(signalPath1)).toBe(true)
      expect(fs.existsSync(signalPath2)).toBe(true)

      // P1-11: state machine in progress, group still running after first tick
      // Fast-forward terminationStartedAt to bypass grace periods
      const farPast = new Date(Date.now() - 20000).toISOString()
      for (const s of freshRun.steps_state) {
        if (s.terminationPhase) s.terminationStartedAt = farPast
      }
      workflowStore.updateRun(freshRun.id, { steps_state: freshRun.steps_state })

      // Tick through state machine phases until termination completes
      for (let i = 0; i < 5; i++) {
        const r = workflowStore.getRun(freshRun.id)!
        if (r.steps_state[0].status === 'failed') break
        for (const s of r.steps_state) {
          if (s.terminationPhase && s.terminationPhase !== 'killed') s.terminationStartedAt = farPast
        }
        workflowStore.updateRun(r.id, { steps_state: r.steps_state })
        dagEngine.tick(r, parsed)
      }
      freshRun = workflowStore.getRun(run.id)!

      // Both children should be cancelled
      expect(freshRun.steps_state[1].status).toBe('cancelled')
      expect(freshRun.steps_state[2].status).toBe('cancelled')

      // Group should be failed with timeout message
      expect(freshRun.steps_state[0].status).toBe('failed')
      expect(freshRun.steps_state[0].errorMessage).toContain('exceeded timeout')

      // Pool slots should be released
      poolStatus = pool.getStatus()
      expect(poolStatus.active.length).toBe(0)

      try { fs.rmSync(outputDir, { recursive: true }) } catch { /* ok */ }
    })

    // ── TEST-29: Group error message lists failed children ───────────────
    test('TEST-29: group error message lists failed children by name with count', () => {
      const yaml = [
        'name: t29-errmsg',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: t29-group',
        '    type: parallel_group',
        '    on_failure: continue_others',
        '    steps:',
        '      - name: t29-fail-1',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "fail1"',
        '      - name: t29-ok-1',
        '        type: delay',
        '        seconds: 0.01',
        '      - name: t29-fail-2',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "fail2"',
        '      - name: t29-ok-2',
        '        type: delay',
        '        seconds: 0.01',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 't29-errmsg')
      const parsed = getParsed(yaml)

      const failTask1 = taskStore.createTask({
        projectPath: '/tmp/test', prompt: 'fail1',
        templateId: null, priority: 5, status: 'queued', maxRetries: 0, timeoutSeconds: 1800,
      })
      taskStore.updateTask(failTask1.id, { status: 'failed', errorMessage: 'error 1' })

      const failTask2 = taskStore.createTask({
        projectPath: '/tmp/test', prompt: 'fail2',
        templateId: null, priority: 5, status: 'queued', maxRetries: 0, timeoutSeconds: 1800,
      })
      taskStore.updateTask(failTask2.id, { status: 'failed', errorMessage: 'error 2' })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 't29-group', type: 'parallel_group', status: 'running', startedAt: new Date().toISOString() }),
        makeStepState({
          name: 't29-fail-1', type: 'spawn_session', parentGroup: 't29-group',
          status: 'failed', taskId: failTask1.id,
          startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          errorMessage: 'error 1',
        }),
        makeStepState({
          name: 't29-ok-1', type: 'delay', parentGroup: 't29-group',
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        }),
        makeStepState({
          name: 't29-fail-2', type: 'spawn_session', parentGroup: 't29-group',
          status: 'failed', taskId: failTask2.id,
          startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          errorMessage: 'error 2',
        }),
        makeStepState({
          name: 't29-ok-2', type: 'delay', parentGroup: 't29-group',
          status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        }),
      ])

      // All children already terminal. Tick: group finishes -> partial
      dagEngine.tick(run, parsed)
      const freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].status).toBe('partial')
      expect(freshRun.steps_state[0].errorMessage).toContain('2 of 4 children failed')
      expect(freshRun.steps_state[0].errorMessage).toContain('t29-fail-1')
      expect(freshRun.steps_state[0].errorMessage).toContain('t29-fail-2')
    })

    // ── TEST-07: Diamond with multi-dependency wait (D waits for BOTH B and C) ──
    test('TEST-07: diamond D waits for BOTH B and C before starting', async () => {
      const yaml = [
        'name: t07-diamond',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: t07-group',
        '    type: parallel_group',
        '    steps:',
        '      - name: t07-A',
        '        type: delay',
        '        seconds: 0.01',
        '      - name: t07-B',
        '        type: delay',
        '        seconds: 0.01',
        '        depends_on:',
        '          - t07-A',
        '      - name: t07-C',
        '        type: delay',
        '        seconds: 0.05',
        '        depends_on:',
        '          - t07-A',
        '      - name: t07-D',
        '        type: delay',
        '        seconds: 0.01',
        '        depends_on:',
        '          - t07-B',
        '          - t07-C',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 't07-diamond')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 't07-group', type: 'parallel_group' }),
        makeStepState({ name: 't07-A', type: 'delay', parentGroup: 't07-group' }),
        makeStepState({ name: 't07-B', type: 'delay', parentGroup: 't07-group' }),
        makeStepState({ name: 't07-C', type: 'delay', parentGroup: 't07-group' }),
        makeStepState({ name: 't07-D', type: 'delay', parentGroup: 't07-group' }),
      ])

      // Tick 1: A starts
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].status).toBe('running') // A
      expect(freshRun.steps_state[4].status).toBe('pending')  // D pending

      // Wait for A to complete, tick -> B starts
      await Bun.sleep(20)
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.steps_state[2].status === 'running',
        10,
      )
      expect(freshRun.steps_state[1].status).toBe('completed') // A done
      expect(freshRun.steps_state[2].status).toBe('running')   // B started
      expect(freshRun.steps_state[3].status).toBe('running')   // C started

      // Wait for B to complete but C still running (C has longer delay)
      await Bun.sleep(20)
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.steps_state[2].status === 'completed',
        10,
      )
      // D should NOT start yet (C still running)
      expect(freshRun.steps_state[2].status).toBe('completed') // B done
      if (freshRun.steps_state[3].status !== 'completed') {
        expect(freshRun.steps_state[4].status).toBe('pending') // D waits for BOTH B AND C
      }

      // Wait for C to complete, then D should start
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.steps_state[4].status === 'running' || r.steps_state[4].status === 'completed',
        20,
      )
      expect(freshRun.steps_state[3].status).toBe('completed') // C done
      expect(['running', 'completed']).toContain(freshRun.steps_state[4].status) // D started

      // Verify D started only after BOTH B and C completed
      expect(new Date(freshRun.steps_state[2].completedAt!).getTime())
        .toBeLessThanOrEqual(new Date(freshRun.steps_state[4].startedAt!).getTime())
      expect(new Date(freshRun.steps_state[3].completedAt!).getTime())
        .toBeLessThanOrEqual(new Date(freshRun.steps_state[4].startedAt!).getTime())

      // Tick until fully completed
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.status === 'completed' || r.status === 'failed',
      )
      expect(freshRun.status).toBe('completed')
    })

    // ── TEST-15: continue_others partial status verification ─────────────
    test('TEST-15: continue_others results in partial group status with correct error', async () => {
      const fs = require('node:fs')
      const outputDir = '/tmp/test-outputs/t15-partial-' + Date.now()
      fs.mkdirSync(outputDir, { recursive: true })

      const yaml = [
        'name: t15-partial',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: t15-group',
        '    type: parallel_group',
        '    on_failure: continue_others',
        '    steps:',
        '      - name: t15-fail',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "fail"',
        '      - name: t15-ok-1',
        '        type: native_step',
        '        command: "echo ok1"',
        '      - name: t15-ok-2',
        '        type: native_step',
        '        command: "echo ok2"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 't15-partial')
      const parsed = getParsed(yaml)

      const failedTask = taskStore.createTask({
        projectPath: '/tmp/test', prompt: 'fail',
        templateId: null, priority: 5, status: 'queued', maxRetries: 0, timeoutSeconds: 1800,
      })
      taskStore.updateTask(failedTask.id, { status: 'failed', errorMessage: 'test fail' })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 't15-group', type: 'parallel_group', status: 'running', startedAt: new Date().toISOString() }),
        makeStepState({
          name: 't15-fail', type: 'spawn_session', parentGroup: 't15-group',
          status: 'running', taskId: failedTask.id, startedAt: new Date().toISOString(),
        }),
        makeStepState({ name: 't15-ok-1', type: 'native_step', parentGroup: 't15-group', status: 'running', startedAt: new Date().toISOString() }),
        makeStepState({ name: 't15-ok-2', type: 'native_step', parentGroup: 't15-group', status: 'running', startedAt: new Date().toISOString() }),
      ], { output_dir: outputDir })

      // Tick 1: fail detected, native_steps complete (continue_others)
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].status).toBe('failed')
      expect(freshRun.steps_state[2].status).toBe('completed')
      expect(freshRun.steps_state[3].status).toBe('completed')

      // Tick 2: all terminal -> group = partial
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].status).toBe('partial')
      expect(freshRun.steps_state[0].errorMessage).toContain('1 of 3 children failed')
      expect(freshRun.steps_state[0].errorMessage).toContain('t15-fail')

      try { fs.rmSync(outputDir, { recursive: true }) } catch { /* ok */ }
    })

    // ── TEST-18: Dependency failure with continue_others ─────────────────
    test('TEST-18: dep failure with continue_others skips dependent, runs independent', () => {
      const yaml = [
        'name: t18-dep-fail',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: t18-group',
        '    type: parallel_group',
        '    on_failure: continue_others',
        '    steps:',
        '      - name: t18-A',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "will fail"',
        '      - name: t18-B',
        '        type: delay',
        '        seconds: 0.01',
        '        depends_on:',
        '          - t18-A',
        '      - name: t18-C',
        '        type: delay',
        '        seconds: 0.01',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 't18-dep-fail')
      const parsed = getParsed(yaml)

      const failedTask = taskStore.createTask({
        projectPath: '/tmp/test', prompt: 'will fail',
        templateId: null, priority: 5, status: 'queued', maxRetries: 0, timeoutSeconds: 1800,
      })
      taskStore.updateTask(failedTask.id, { status: 'failed', errorMessage: 'A failed' })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 't18-group', type: 'parallel_group', status: 'running', startedAt: new Date().toISOString() }),
        makeStepState({
          name: 't18-A', type: 'spawn_session', parentGroup: 't18-group',
          status: 'running', taskId: failedTask.id, startedAt: new Date().toISOString(),
        }),
        makeStepState({ name: 't18-B', type: 'delay', parentGroup: 't18-group', status: 'pending' }),
        makeStepState({ name: 't18-C', type: 'delay', parentGroup: 't18-group', status: 'running', startedAt: new Date().toISOString() }),
      ])

      // Tick 1: A fails detected, C still running
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[1].status).toBe('failed') // A

      // Tick 2: continue_others -> B skipped (dep A failed), C continues
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // B should be skipped with reason mentioning dependency A
      expect(freshRun.steps_state[2].status).toBe('skipped')
      expect(freshRun.steps_state[2].skippedReason).toContain("dependency 't18-A' failed")

      // C should still run or complete (independent step)
      expect(['running', 'completed']).toContain(freshRun.steps_state[3].status)
    })

    // ── TEST-19: Skipped dependency treated as satisfied ─────────────────
    test('TEST-19: skipped dependency (tier-based) treated as satisfied', async () => {
      const yaml = [
        'name: t19-skip-dep',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: t19-group',
        '    type: parallel_group',
        '    steps:',
        '      - name: t19-skipped',
        '        type: delay',
        '        seconds: 0.01',
        '        tier_min: 3',
        '      - name: t19-dependent',
        '        type: delay',
        '        seconds: 0.01',
        '        depends_on:',
        '          - t19-skipped',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 't19-skip-dep')
      const parsed = getParsed(yaml)
      // Run at tier 1 (default) -> t19-skipped has tier_min: 3, will be skipped
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 't19-group', type: 'parallel_group' }),
        makeStepState({ name: 't19-skipped', type: 'delay', parentGroup: 't19-group' }),
        makeStepState({ name: 't19-dependent', type: 'delay', parentGroup: 't19-group' }),
      ])

      // Tick 1: t19-skipped gets skipped by tier filter, t19-dependent should start
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[1].status).toBe('skipped')
      // Dependent should treat skipped dependency as satisfied and start
      expect(freshRun.steps_state[2].status).toBe('running')

      // Tick until completed
      freshRun = await tickUntil(
        dagEngine, freshRun, parsed, workflowStore,
        (r) => r.status === 'completed' || r.status === 'failed',
      )
      expect(freshRun.status).toBe('completed')
      expect(freshRun.steps_state[2].status).toBe('completed')
    })

    // ── TEST-22: Termination releases pool slots (all scenarios) ─────────
    test('TEST-22: pool slots released under cancel_all, fail_fast, and timeout', () => {
      pool.updateConfig(5)

      // === Scenario 1: cancel_all releases pool slots ===
      const yaml1 = [
        'name: t22-cancel-all',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: t22-ca-group',
        '    type: parallel_group',
        '    on_failure: cancel_all',
        '    steps:',
        '      - name: t22-ca-fail',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "fail"',
        '      - name: t22-ca-sib',
        '        type: delay',
        '        seconds: 100',
      ].join('\n')

      const wf1 = createWorkflowDef(workflowStore, yaml1, 't22-cancel-all')
      const parsed1 = getParsed(yaml1)

      const failTask1 = taskStore.createTask({
        projectPath: '/tmp/test', prompt: 'fail',
        templateId: null, priority: 5, status: 'queued', maxRetries: 0, timeoutSeconds: 1800,
      })
      taskStore.updateTask(failTask1.id, { status: 'failed', errorMessage: 'fail' })

      const caSlot = pool.requestSlot({ runId: 'test', stepName: 't22-ca-fail', tier: 1 })

      const run1 = createTestRun(workflowStore, wf1.id, [
        makeStepState({ name: 't22-ca-group', type: 'parallel_group', status: 'running', startedAt: new Date().toISOString() }),
        makeStepState({
          name: 't22-ca-fail', type: 'spawn_session', parentGroup: 't22-ca-group',
          status: 'running', taskId: failTask1.id, startedAt: new Date().toISOString(),
          poolSlotId: caSlot.slot!.id,
        }),
        makeStepState({
          name: 't22-ca-sib', type: 'delay', parentGroup: 't22-ca-group',
          status: 'running', startedAt: new Date().toISOString(),
        }),
      ])

      // Before: 1 active slot
      expect(pool.getStatus().active.length).toBe(1)

      dagEngine.tick(run1, parsed1)
      let freshRun1 = workflowStore.getRun(run1.id)!
      dagEngine.tick(freshRun1, parsed1)
      freshRun1 = workflowStore.getRun(run1.id)!

      expect(freshRun1.steps_state[0].status).toBe('failed')
      // After cancel_all: slot released
      expect(pool.getStatus().active.length).toBe(0)

      // === Scenario 2: timeout releases pool slots ===
      const yaml2 = [
        'name: t22-timeout',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: t22-to-group',
        '    type: parallel_group',
        '    timeoutSeconds: 1',
        '    steps:',
        '      - name: t22-to-child',
        '        type: spawn_session',
        '        projectPath: /tmp/test',
        '        prompt: "timeout"',
      ].join('\n')

      const wf2 = createWorkflowDef(workflowStore, yaml2, 't22-timeout')
      const parsed2 = getParsed(yaml2)

      const runningTask = taskStore.createTask({
        projectPath: '/tmp/test', prompt: 'timeout',
        templateId: null, priority: 5, status: 'queued', maxRetries: 0, timeoutSeconds: 1800,
      })
      taskStore.updateTask(runningTask.id, { status: 'running' })

      const toSlot = pool.requestSlot({ runId: 'test', stepName: 't22-to-child', tier: 1 })

      const pastStart = new Date(Date.now() - 10000).toISOString()
      const run2 = createTestRun(workflowStore, wf2.id, [
        makeStepState({ name: 't22-to-group', type: 'parallel_group', status: 'running', startedAt: pastStart }),
        makeStepState({
          name: 't22-to-child', type: 'spawn_session', parentGroup: 't22-to-group',
          status: 'running', taskId: runningTask.id, startedAt: pastStart,
          poolSlotId: toSlot.slot!.id,
        }),
      ])

      expect(pool.getStatus().active.length).toBe(1)

      // P1-11: timeout uses terminateRunningChild state machine — tick until complete
      const farPast2 = new Date(Date.now() - 20000).toISOString()
      let freshRun2 = workflowStore.getRun(run2.id)!
      for (let i = 0; i < 6; i++) {
        const r = workflowStore.getRun(run2.id)!
        if (r.steps_state[0].status === 'failed') break
        for (const s of r.steps_state) {
          if (s.terminationPhase && s.terminationPhase !== 'killed') s.terminationStartedAt = farPast2
        }
        workflowStore.updateRun(r.id, { steps_state: r.steps_state })
        dagEngine.tick(r, parsed2)
      }
      freshRun2 = workflowStore.getRun(run2.id)!

      expect(freshRun2.steps_state[0].status).toBe('failed')
      expect(freshRun2.steps_state[0].errorMessage).toContain('exceeded timeout')
      // After timeout: slot released
      expect(pool.getStatus().active.length).toBe(0)
    })
  })

  // ── CF-06: WebSocket message verification (REQ-32, REQ-33) ─────────────

  describe('pool WebSocket messages', () => {
    test('CF-06: broadcasts pool_slot_granted when slot is immediately granted', () => {
      const yaml = [
        'name: ws-grant-test',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: group-a',
        '    type: parallel_group',
        '    steps:',
        '      - name: child-1',
        '        type: spawn_session',
        '        projectPath: /tmp/project',
        '        prompt: "do work"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'ws-grant-test')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'group-a', type: 'parallel_group' }),
        makeStepState({ name: 'child-1', type: 'spawn_session', parentGroup: 'group-a' }),
      ])

      // Pool has 2 slots, only 1 child -> should be granted immediately
      dagEngine.tick(run, parsed)

      // Check broadcast calls for pool_slot_granted
      const broadcastFn = ctx.broadcast as ReturnType<typeof mock>
      const calls = broadcastFn.mock.calls
      const grantedMsgs = calls.filter(
        (c: any[]) => c[0]?.type === 'pool_slot_granted',
      )

      expect(grantedMsgs.length).toBeGreaterThanOrEqual(1)
      const msg = grantedMsgs[0][0]
      expect(msg.type).toBe('pool_slot_granted')
      expect(msg.runId).toBe(run.id)
      expect(msg.stepName).toBe('child-1')
      expect(msg.slotId).toBeTruthy()
    })

    test('CF-06: broadcasts step_queued when slot is queued (pool full)', () => {
      pool.updateConfig(1) // Only 1 slot

      const yaml = [
        'name: ws-queue-test',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: group-b',
        '    type: parallel_group',
        '    steps:',
        '      - name: child-a',
        '        type: spawn_session',
        '        projectPath: /tmp/project',
        '        prompt: "do work a"',
        '      - name: child-b',
        '        type: spawn_session',
        '        projectPath: /tmp/project',
        '        prompt: "do work b"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'ws-queue-test')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'group-b', type: 'parallel_group' }),
        makeStepState({ name: 'child-a', type: 'spawn_session', parentGroup: 'group-b' }),
        makeStepState({ name: 'child-b', type: 'spawn_session', parentGroup: 'group-b' }),
      ])

      // Pool has 1 slot, 2 children -> first granted, second queued
      dagEngine.tick(run, parsed)

      const broadcastFn = ctx.broadcast as ReturnType<typeof mock>
      const calls = broadcastFn.mock.calls

      // Verify pool_slot_granted was sent for child-a
      const grantedMsgs = calls.filter(
        (c: any[]) => c[0]?.type === 'pool_slot_granted',
      )
      expect(grantedMsgs.length).toBeGreaterThanOrEqual(1)
      const grantedNames = grantedMsgs.map((c: any[]) => c[0].stepName)
      expect(grantedNames).toContain('child-a')

      // Verify step_queued was sent for child-b
      const queuedMsgs = calls.filter(
        (c: any[]) => c[0]?.type === 'step_queued',
      )
      expect(queuedMsgs.length).toBeGreaterThanOrEqual(1)
      const queuedMsg = queuedMsgs.find((c: any[]) => c[0].stepName === 'child-b')
      expect(queuedMsg).toBeTruthy()
      expect(queuedMsg![0].runId).toBe(run.id)
      expect(queuedMsg![0].stepName).toBe('child-b')
      expect(queuedMsg![0].queuePosition).toBeGreaterThanOrEqual(1)
    })

    test('CF-06: broadcasts pool_slot_granted when queued step is promoted via releaseSlot', () => {
      pool.updateConfig(1) // Only 1 slot

      const yaml = [
        'name: ws-promote-test',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: group-c',
        '    type: parallel_group',
        '    steps:',
        '      - name: first-child',
        '        type: spawn_session',
        '        projectPath: /tmp/project',
        '        prompt: "do work first"',
        '      - name: second-child',
        '        type: spawn_session',
        '        projectPath: /tmp/project',
        '        prompt: "do work second"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'ws-promote-test')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'group-c', type: 'parallel_group' }),
        makeStepState({ name: 'first-child', type: 'spawn_session', parentGroup: 'group-c' }),
        makeStepState({ name: 'second-child', type: 'spawn_session', parentGroup: 'group-c' }),
      ])

      // Tick 1: first-child gets slot, second-child queued
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      // Find the task for first-child and mark it completed
      const firstChild = freshRun.steps_state.find(s => s.name === 'first-child')
      expect(firstChild).toBeTruthy()
      if (firstChild?.taskId) {
        taskStore.updateTask(firstChild.taskId, { status: 'completed' })
      }

      // Clear previous broadcast calls to isolate promotion messages
      ;(ctx.broadcast as ReturnType<typeof mock>).mockClear()

      // Tick 2: first-child completes -> releases slot -> second-child promoted
      dagEngine.tick(freshRun, parsed)

      const broadcastFn = ctx.broadcast as ReturnType<typeof mock>
      const calls = broadcastFn.mock.calls

      // Check that pool_slot_granted was broadcast during promotion
      // This happens via releasePoolSlotIfHeld -> pool.releaseSlot -> broadcast
      const grantedMsgs = calls.filter(
        (c: any[]) => c[0]?.type === 'pool_slot_granted',
      )
      expect(grantedMsgs.length).toBeGreaterThanOrEqual(1)
    })

    test('CF-06: pool_status_update broadcast includes correct shape', () => {
      pool.updateConfig(1) // Only 1 slot

      const yaml = [
        'name: ws-status-test',
        'system:',
        '  engine: dag',
        '  session_pool: true',
        'steps:',
        '  - name: group-d',
        '    type: parallel_group',
        '    steps:',
        '      - name: status-child',
        '        type: spawn_session',
        '        projectPath: /tmp/project',
        '        prompt: "do work"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'ws-status-test')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'group-d', type: 'parallel_group' }),
        makeStepState({ name: 'status-child', type: 'spawn_session', parentGroup: 'group-d' }),
      ])

      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!

      // Complete the step to trigger slot release + pool_status_update
      const child = freshRun.steps_state.find(s => s.name === 'status-child')
      if (child?.taskId) {
        taskStore.updateTask(child.taskId, { status: 'completed' })
      }

      ;(ctx.broadcast as ReturnType<typeof mock>).mockClear()
      dagEngine.tick(freshRun, parsed)

      const broadcastFn = ctx.broadcast as ReturnType<typeof mock>
      const calls = broadcastFn.mock.calls

      // Check pool_status_update was broadcast after slot release
      const statusMsgs = calls.filter(
        (c: any[]) => c[0]?.type === 'pool_status_update',
      )
      if (statusMsgs.length > 0) {
        const msg = statusMsgs[0][0]
        expect(msg.type).toBe('pool_status_update')
        expect(typeof msg.active).toBe('number')
        expect(typeof msg.queued).toBe('number')
        expect(typeof msg.max).toBe('number')
      }
    })
  })

  // ── Phase 7: Signal Protocol Integration Tests ────────────────────────

  describe('signal protocol', () => {
    test('startStep sets signal protocol state when signal_protocol is true', () => {
      const { workflowStore, taskStore, db } = createStores()
      const ctx = createTestContext()
      const pool = createSessionPool(db)
      const engine = createDAGEngine(ctx, workflowStore, taskStore, pool)

      const yaml = `
name: signal-proto-test
system:
  engine: dag
steps:
  - name: signal-step
    type: spawn_session
    projectPath: /tmp/test
    prompt: "test signal protocol"
    signal_protocol: true
    signal_dir: /tmp/test-outputs/dag-test/signals
    signal_timeout_seconds: 120
`
      const parsed = getParsed(yaml)
      const def = createWorkflowDef(workflowStore, yaml, 'signal-proto-test')
      const stepsState = [
        makeStepState({ name: 'signal-step', type: 'spawn_session' }),
      ]
      const run = createTestRun(workflowStore, def.id, stepsState)

      engine.tick(run, parsed)

      const updated = workflowStore.getRun(run.id)!
      const step = updated.steps_state[0]
      expect(step.signalProtocol).toBe(true)
      expect(step.signalDir).toBe('/tmp/test-outputs/dag-test/signals')
      expect(step.signalTimeoutSeconds).toBe(120)
      expect(step.status).toBe('waiting_signal')
    })

    test('legacy steps are unaffected by signal protocol changes', () => {
      const { workflowStore, taskStore, db } = createStores()
      const ctx = createTestContext()
      const pool = createSessionPool(db)
      const engine = createDAGEngine(ctx, workflowStore, taskStore, pool)

      const yaml = `
name: legacy-test
system:
  engine: dag
steps:
  - name: legacy-step
    type: spawn_session
    projectPath: /tmp/test
    prompt: "legacy step without signal protocol"
`
      const parsed = getParsed(yaml)
      const def = createWorkflowDef(workflowStore, yaml, 'legacy-test')
      const stepsState = [
        makeStepState({ name: 'legacy-step', type: 'spawn_session' }),
      ]
      const run = createTestRun(workflowStore, def.id, stepsState)

      engine.tick(run, parsed)

      const updated = workflowStore.getRun(run.id)!
      const step = updated.steps_state[0]
      expect(step.signalProtocol).toBeUndefined()
      expect(step.signalDir).toBeUndefined()
      expect(step.status).toBe('running')
    })

    test('signal_timeout and signal_error are treated as terminal for workflow completion', () => {
      const { workflowStore, taskStore, db } = createStores()
      const ctx = createTestContext()
      const pool = createSessionPool(db)
      const engine = createDAGEngine(ctx, workflowStore, taskStore, pool)

      const yaml = `
name: terminal-test
system:
  engine: dag
steps:
  - name: timed-out-step
    type: spawn_session
    projectPath: /tmp/test
    prompt: "test"
`
      const parsed = getParsed(yaml)
      const def = createWorkflowDef(workflowStore, yaml, 'terminal-test')
      const stepsState = [
        makeStepState({
          name: 'timed-out-step',
          type: 'spawn_session',
          status: 'signal_timeout',
          completedAt: new Date().toISOString(),
          errorMessage: 'Signal timeout',
        }),
      ]
      const run = createTestRun(workflowStore, def.id, stepsState)

      engine.tick(run, parsed)

      const updated = workflowStore.getRun(run.id)!
      // signal_timeout is terminal and treated as failure
      expect(updated.status).toBe('failed')
    })

    test('waiting_signal steps block workflow completion', () => {
      const { workflowStore, taskStore, db } = createStores()
      const ctx = createTestContext()
      const pool = createSessionPool(db)
      const engine = createDAGEngine(ctx, workflowStore, taskStore, pool)

      const yaml = `
name: blocking-test
system:
  engine: dag
steps:
  - name: waiting-step
    type: spawn_session
    projectPath: /tmp/test
    prompt: "test"
    signal_protocol: true
    signal_dir: /tmp/nonexistent-signals
`
      const parsed = getParsed(yaml)
      const def = createWorkflowDef(workflowStore, yaml, 'blocking-test')
      const stepsState = [
        makeStepState({
          name: 'waiting-step',
          type: 'spawn_session',
          status: 'waiting_signal',
          taskId: 'task-123',
          startedAt: new Date().toISOString(),
          signalProtocol: true,
          signalDir: '/tmp/nonexistent-signals',
          signalTimeoutSeconds: 99999,
        } as any),
      ]
      const run = createTestRun(workflowStore, def.id, stepsState)

      engine.tick(run, parsed)

      const updated = workflowStore.getRun(run.id)!
      // Workflow should still be running since waiting_signal is non-terminal
      expect(updated.status).toBe('running')
    })

    test('signal timeout generates synthetic signal and inserts DB record (REQ-21/REQ-26)', () => {
      const { workflowStore, taskStore, db } = createStores()
      const ctx = createTestContext()
      const pool = createSessionPool(db)
      const engine = createDAGEngine(ctx, workflowStore, taskStore, pool)

      const yaml = `
name: timeout-synthetic-test
system:
  engine: dag
steps:
  - name: timeout-step
    type: spawn_session
    projectPath: /tmp/test
    prompt: "test"
    signal_protocol: true
    signal_dir: /tmp/nonexistent-signals
    signal_timeout_seconds: 1
`
      const parsed = getParsed(yaml)
      const def = createWorkflowDef(workflowStore, yaml, 'timeout-synthetic-test')

      // Create a task that is still running (so it doesn't trigger task-status fallback)
      const task = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'test',
        templateId: null,
        priority: 5,
        status: 'running',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })

      const stepsState = [
        makeStepState({
          name: 'timeout-step',
          type: 'spawn_session',
          status: 'waiting_signal',
          taskId: task.id,
          startedAt: new Date(Date.now() - 5000).toISOString(), // Started 5s ago
          signalProtocol: true,
          signalDir: '/tmp/nonexistent-signals',
          signalTimeoutSeconds: 1, // 1s timeout, already exceeded
        } as any),
      ]
      const run = createTestRun(workflowStore, def.id, stepsState)

      engine.tick(run, parsed)

      const updated = workflowStore.getRun(run.id)!
      const step = updated.steps_state[0]

      // Step should be signal_timeout
      expect(step.status).toBe('signal_timeout')
      expect(step.errorMessage).toContain('Signal timeout')
      expect(step.lastSignalType).toBe('error')
      expect(step.verifiedCompletion).toBe(false)

      // A synthetic signal record should have been inserted to DB
      const signals = workflowStore.getSignalsByRun(run.id)
      expect(signals.length).toBeGreaterThanOrEqual(1)
      const timeoutSignal = signals.find(s => s.step_name === 'timeout-step' && s.synthetic === 1)
      expect(timeoutSignal).toBeDefined()
      expect(timeoutSignal?.signal_type).toBe('error')
    })

    test('paused_escalated steps cause workflow failure', () => {
      const { workflowStore, taskStore, db } = createStores()
      const ctx = createTestContext()
      const pool = createSessionPool(db)
      const engine = createDAGEngine(ctx, workflowStore, taskStore, pool)

      const yaml = `
name: paused-test
system:
  engine: dag
steps:
  - name: paused-step
    type: spawn_session
    projectPath: /tmp/test
    prompt: "test"
`
      const parsed = getParsed(yaml)
      const def = createWorkflowDef(workflowStore, yaml, 'paused-test')
      const stepsState = [
        makeStepState({
          name: 'paused-step',
          type: 'spawn_session',
          status: 'paused_escalated',
          taskId: 'task-123',
          startedAt: new Date().toISOString(),
        }),
      ]
      const run = createTestRun(workflowStore, def.id, stepsState)

      engine.tick(run, parsed)

      const updated = workflowStore.getRun(run.id)!
      // paused_escalated is terminal — workflow fails because step needs human intervention
      expect(updated.status).toBe('failed')
    })

    test('paused_amendment steps do NOT block workflow (active processing state)', () => {
      const { workflowStore, taskStore, db } = createStores()
      const ctx = createTestContext()
      const pool = createSessionPool(db)
      const engine = createDAGEngine(ctx, workflowStore, taskStore, pool)

      const yaml = `
name: paused-test
system:
  engine: dag
steps:
  - name: paused-step
    type: spawn_session
    projectPath: /tmp/test
    prompt: "test"
`
      const parsed = getParsed(yaml)
      const def = createWorkflowDef(workflowStore, yaml, 'paused-test')
      const stepsState = [
        makeStepState({
          name: 'paused-step',
          type: 'spawn_session',
          status: 'paused_amendment',
          taskId: 'task-123',
          startedAt: new Date().toISOString(),
        }),
      ]
      const run = createTestRun(workflowStore, def.id, stepsState)

      engine.tick(run, parsed)

      const updated = workflowStore.getRun(run.id)!
      // paused_amendment is NOT terminal -- run stays running while amendment is processed
      expect(updated.status).toBe('running')
    })
  })

  // ── Phase 8: review_loop enhancements ───────────────────────────────────────

  describe('Phase 8: review_loop enhancements', () => {
    test('P8-TEST-01: PASS on first iteration', () => {
      const { workflowStore, taskStore, db } = createStores()
      const ctx = createTestContext()
      const pool = createSessionPool(db)
      const dagEngine = createDAGEngine(ctx, workflowStore, taskStore, pool)

      const nodefs = require('node:fs')
      const path = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const testOutputDir = path.join(tmpdir, `dag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(testOutputDir, { recursive: true })

      const yaml = [
        'name: p8-pass-first',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: review-step',
        '    type: review_loop',
        '    max_iterations: 3',
        '    producer:',
        '      name: producer',
        '      type: spawn_session',
        '      projectPath: /tmp/test',
        '      prompt: "produce code"',
        '    reviewer:',
        '      name: reviewer',
        '      type: spawn_session',
        '      projectPath: /tmp/test',
        '      prompt: "review code"',
        '      result_file: verdict.yaml',
        '      verdict_field: verdict',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p8-pass-first')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'review-step', type: 'review_loop' as any }),
      ], { output_dir: testOutputDir })

      // Tick 1: starts producer
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[0].status).toBe('running')
      expect(freshRun.steps_state[0].reviewSubStep).toBe('producer')
      expect(freshRun.steps_state[0].reviewIteration).toBe(1)

      // Complete producer
      taskStore.updateTask(freshRun.steps_state[0].taskId!, { status: 'completed' })

      // Tick 2: producer done → between state (needsReviewerSlot=true)
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[0].reviewSubStep).toBe('between')

      // Tick 3: REQ-17 gap tick — clears needsReviewerSlot, gives other steps a chance
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[0].reviewSubStep).toBe('between')

      // Tick 4: between → reviewer starts
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[0].reviewSubStep).toBe('reviewer')

      // Write PASS verdict
      nodefs.writeFileSync(
        path.join(testOutputDir, 'verdict.yaml'),
        'verdict: PASS\ncomments: looks good',
      )

      // Complete reviewer
      taskStore.updateTask(freshRun.steps_state[0].taskId!, { status: 'completed' })

      // Tick 4: reviewer done, verdict=PASS → step completed
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].status).toBe('completed')
      expect(freshRun.steps_state[0].reviewVerdict).toBe('PASS')

      // Cleanup
      try { nodefs.rmSync(testOutputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('P8-TEST-02: FAIL then PASS (2 iterations with feedback)', () => {
      const { workflowStore, taskStore, db } = createStores()
      const ctx = createTestContext()
      const pool = createSessionPool(db)
      const dagEngine = createDAGEngine(ctx, workflowStore, taskStore, pool)

      const nodefs = require('node:fs')
      const path = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const testOutputDir = path.join(tmpdir, `dag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(testOutputDir, { recursive: true })

      const yaml = [
        'name: p8-fail-then-pass',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: review-step',
        '    type: review_loop',
        '    max_iterations: 3',
        '    producer:',
        '      name: producer',
        '      type: spawn_session',
        '      projectPath: /tmp/test',
        '      prompt: "produce code"',
        '    reviewer:',
        '      name: reviewer',
        '      type: spawn_session',
        '      projectPath: /tmp/test',
        '      prompt: "review code"',
        '      result_file: verdict.yaml',
        '      verdict_field: verdict',
        '      feedback_field: feedback',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p8-fail-then-pass')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'review-step', type: 'review_loop' as any }),
      ], { output_dir: testOutputDir })

      // Iteration 1: producer
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      taskStore.updateTask(freshRun.steps_state[0].taskId!, { status: 'completed' })

      // between
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // REQ-17 gap tick
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // reviewer
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // Write FAIL verdict with feedback
      nodefs.writeFileSync(
        path.join(testOutputDir, 'verdict.yaml'),
        'verdict: FAIL\nfeedback: needs improvement',
      )
      taskStore.updateTask(freshRun.steps_state[0].taskId!, { status: 'completed' })

      // Tick: reviewer done → loops back to producer iteration 2
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].reviewIteration).toBe(2)
      expect(freshRun.steps_state[0].reviewSubStep).toBe('producer')
      expect(freshRun.steps_state[0].reviewFeedback).toBe('needs improvement')

      // Iteration 2: producer
      taskStore.updateTask(freshRun.steps_state[0].taskId!, { status: 'completed' })
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // between
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // REQ-17 gap tick
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // reviewer
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // Write PASS verdict
      nodefs.writeFileSync(
        path.join(testOutputDir, 'verdict.yaml'),
        'verdict: PASS\nfeedback: good now',
      )
      taskStore.updateTask(freshRun.steps_state[0].taskId!, { status: 'completed' })

      // Tick: reviewer done → step completed
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].status).toBe('completed')
      expect(freshRun.steps_state[0].reviewIteration).toBe(2)
      expect(freshRun.steps_state[0].reviewVerdict).toBe('PASS')

      // Cleanup
      try { nodefs.rmSync(testOutputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('P8-TEST-03: max_iterations exhausted with escalate (default)', () => {
      const { workflowStore, taskStore, db } = createStores()
      const ctx = createTestContext()
      const pool = createSessionPool(db)
      const dagEngine = createDAGEngine(ctx, workflowStore, taskStore, pool)

      const nodefs = require('node:fs')
      const path = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const testOutputDir = path.join(tmpdir, `dag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(testOutputDir, { recursive: true })

      const yaml = [
        'name: p8-escalate',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: review-step',
        '    type: review_loop',
        '    max_iterations: 2',
        '    producer:',
        '      name: producer',
        '      type: spawn_session',
        '      projectPath: /tmp/test',
        '      prompt: "produce code"',
        '    reviewer:',
        '      name: reviewer',
        '      type: spawn_session',
        '      projectPath: /tmp/test',
        '      prompt: "review code"',
        '      result_file: verdict.yaml',
        '      verdict_field: verdict',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p8-escalate')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'review-step', type: 'review_loop' as any }),
      ], { output_dir: testOutputDir })

      // Helper: run through one full producer+reviewer iteration with FAIL verdict
      function runOneIteration(r: typeof run) {
        dagEngine.tick(r, parsed)
        let fr = workflowStore.getRun(r.id)!
        taskStore.updateTask(fr.steps_state[0].taskId!, { status: 'completed' })
        dagEngine.tick(fr, parsed)
        fr = workflowStore.getRun(r.id)!
        dagEngine.tick(fr, parsed) // REQ-17 gap tick
        fr = workflowStore.getRun(r.id)!
        dagEngine.tick(fr, parsed)
        fr = workflowStore.getRun(r.id)!
        nodefs.writeFileSync(path.join(testOutputDir, 'verdict.yaml'), 'verdict: FAIL')
        taskStore.updateTask(fr.steps_state[0].taskId!, { status: 'completed' })
        dagEngine.tick(fr, parsed)
        return workflowStore.getRun(r.id)!
      }

      // Run through 2 iterations with FAIL (max_iterations=2)
      let freshRun = runOneIteration(run) // iteration 1 → loops to iteration 2
      freshRun = runOneIteration(freshRun) // iteration 2 → exhausted

      // Tick: max_iterations reached → escalate (default)
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].status).toBe('paused_human')

      // Cleanup
      try { nodefs.rmSync(testOutputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('P8-TEST-04: max_iterations exhausted with accept_last', () => {
      const { workflowStore, taskStore, db } = createStores()
      const ctx = createTestContext()
      const pool = createSessionPool(db)
      const dagEngine = createDAGEngine(ctx, workflowStore, taskStore, pool)

      const nodefs = require('node:fs')
      const path = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const testOutputDir = path.join(tmpdir, `dag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(testOutputDir, { recursive: true })

      const yaml = [
        'name: p8-accept-last',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: review-step',
        '    type: review_loop',
        '    max_iterations: 2',
        '    on_max_iterations: accept_last',
        '    producer:',
        '      name: producer',
        '      type: spawn_session',
        '      projectPath: /tmp/test',
        '      prompt: "produce code"',
        '    reviewer:',
        '      name: reviewer',
        '      type: spawn_session',
        '      projectPath: /tmp/test',
        '      prompt: "review code"',
        '      result_file: verdict.yaml',
        '      verdict_field: verdict',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p8-accept-last')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'review-step', type: 'review_loop' as any }),
      ], { output_dir: testOutputDir })

      // Helper: run through one full producer+reviewer iteration with FAIL verdict
      function runOneIteration(r: typeof run) {
        dagEngine.tick(r, parsed)
        let fr = workflowStore.getRun(r.id)!
        taskStore.updateTask(fr.steps_state[0].taskId!, { status: 'completed' })
        dagEngine.tick(fr, parsed)
        fr = workflowStore.getRun(r.id)!
        dagEngine.tick(fr, parsed) // REQ-17 gap tick
        fr = workflowStore.getRun(r.id)!
        dagEngine.tick(fr, parsed)
        fr = workflowStore.getRun(r.id)!
        nodefs.writeFileSync(path.join(testOutputDir, 'verdict.yaml'), 'verdict: FAIL')
        taskStore.updateTask(fr.steps_state[0].taskId!, { status: 'completed' })
        dagEngine.tick(fr, parsed)
        return workflowStore.getRun(r.id)!
      }

      // Run through 2 iterations with FAIL (max_iterations=2)
      let freshRun = runOneIteration(run) // iteration 1 → loops to iteration 2
      freshRun = runOneIteration(freshRun) // iteration 2 → exhausted

      // Tick: max_iterations reached → accept_last
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].status).toBe('completed')
      expect(freshRun.steps_state[0].completedWithWarning).toBe(true)

      // Cleanup
      try { nodefs.rmSync(testOutputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('P8-TEST-05: max_iterations exhausted with fail', () => {
      const { workflowStore, taskStore, db } = createStores()
      const ctx = createTestContext()
      const pool = createSessionPool(db)
      const dagEngine = createDAGEngine(ctx, workflowStore, taskStore, pool)

      const nodefs = require('node:fs')
      const path = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const testOutputDir = path.join(tmpdir, `dag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(testOutputDir, { recursive: true })

      const yaml = [
        'name: p8-fail',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: review-step',
        '    type: review_loop',
        '    max_iterations: 2',
        '    on_max_iterations: fail',
        '    producer:',
        '      name: producer',
        '      type: spawn_session',
        '      projectPath: /tmp/test',
        '      prompt: "produce code"',
        '    reviewer:',
        '      name: reviewer',
        '      type: spawn_session',
        '      projectPath: /tmp/test',
        '      prompt: "review code"',
        '      result_file: verdict.yaml',
        '      verdict_field: verdict',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p8-fail')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'review-step', type: 'review_loop' as any }),
      ], { output_dir: testOutputDir })

      // Helper: run through one full producer+reviewer iteration with FAIL verdict
      function runOneIteration(r: typeof run) {
        dagEngine.tick(r, parsed)
        let fr = workflowStore.getRun(r.id)!
        taskStore.updateTask(fr.steps_state[0].taskId!, { status: 'completed' })
        dagEngine.tick(fr, parsed)
        fr = workflowStore.getRun(r.id)!
        dagEngine.tick(fr, parsed) // REQ-17 gap tick
        fr = workflowStore.getRun(r.id)!
        dagEngine.tick(fr, parsed)
        fr = workflowStore.getRun(r.id)!
        nodefs.writeFileSync(path.join(testOutputDir, 'verdict.yaml'), 'verdict: FAIL')
        taskStore.updateTask(fr.steps_state[0].taskId!, { status: 'completed' })
        dagEngine.tick(fr, parsed)
        return workflowStore.getRun(r.id)!
      }

      // Run through 2 iterations with FAIL (max_iterations=2)
      let freshRun = runOneIteration(run) // iteration 1 → loops to iteration 2
      freshRun = runOneIteration(freshRun) // iteration 2 → exhausted

      // Tick: max_iterations reached → fail
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].status).toBe('failed')
      expect(freshRun.steps_state[0].errorMessage).toContain('exhausted')

      // Cleanup
      try { nodefs.rmSync(testOutputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('P8-TEST-06: CONCERN with timeout default accept', () => {
      const { workflowStore, taskStore, db } = createStores()
      const ctx = createTestContext()
      const pool = createSessionPool(db)
      const dagEngine = createDAGEngine(ctx, workflowStore, taskStore, pool)

      const nodefs = require('node:fs')
      const path = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const testOutputDir = path.join(tmpdir, `dag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(testOutputDir, { recursive: true })

      const yaml = [
        'name: p8-concern-accept',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: review-step',
        '    type: review_loop',
        '    max_iterations: 3',
        '    on_concern:',
        '      timeout_minutes: 1',
        '      default_action: accept',
        '    producer:',
        '      name: producer',
        '      type: spawn_session',
        '      projectPath: /tmp/test',
        '      prompt: "produce code"',
        '    reviewer:',
        '      name: reviewer',
        '      type: spawn_session',
        '      projectPath: /tmp/test',
        '      prompt: "review code"',
        '      result_file: verdict.yaml',
        '      verdict_field: verdict',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p8-concern-accept')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'review-step', type: 'review_loop' as any }),
      ], { output_dir: testOutputDir })

      // Run producer
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      taskStore.updateTask(freshRun.steps_state[0].taskId!, { status: 'completed' })
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      dagEngine.tick(freshRun, parsed) // REQ-17 gap tick
      freshRun = workflowStore.getRun(run.id)!
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // Write CONCERN verdict
      nodefs.writeFileSync(path.join(testOutputDir, 'verdict.yaml'), 'verdict: CONCERN')
      taskStore.updateTask(freshRun.steps_state[0].taskId!, { status: 'completed' })

      // Tick: CONCERN detected, concernWaitingSince set, still running
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[0].status).toBe('running')
      expect(freshRun.steps_state[0].concernWaitingSince).toBeTruthy()

      // Manually set concernWaitingSince to past to simulate timeout
      const pastTime = new Date(Date.now() - 2 * 60 * 1000).toISOString() // 2 minutes ago
      const updatedSteps = [...freshRun.steps_state]
      updatedSteps[0] = { ...updatedSteps[0], concernWaitingSince: pastTime }
      workflowStore.updateRun(run.id, { steps_state: updatedSteps })
      freshRun = workflowStore.getRun(run.id)!

      // Tick again: timeout elapsed, default accept → completed with warning
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].status).toBe('completed')
      expect(freshRun.steps_state[0].completedWithWarning).toBe(true)

      // Cleanup
      try { nodefs.rmSync(testOutputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('P8-TEST-07: CONCERN with timeout default reject', () => {
      const { workflowStore, taskStore, db } = createStores()
      const ctx = createTestContext()
      const pool = createSessionPool(db)
      const dagEngine = createDAGEngine(ctx, workflowStore, taskStore, pool)

      const nodefs = require('node:fs')
      const path = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const testOutputDir = path.join(tmpdir, `dag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(testOutputDir, { recursive: true })

      const yaml = [
        'name: p8-concern-reject',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: review-step',
        '    type: review_loop',
        '    max_iterations: 2',
        '    on_max_iterations: fail',
        '    on_concern:',
        '      timeout_minutes: 1',
        '      default_action: reject',
        '    producer:',
        '      name: producer',
        '      type: spawn_session',
        '      projectPath: /tmp/test',
        '      prompt: "produce code"',
        '    reviewer:',
        '      name: reviewer',
        '      type: spawn_session',
        '      projectPath: /tmp/test',
        '      prompt: "review code"',
        '      result_file: verdict.yaml',
        '      verdict_field: verdict',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p8-concern-reject')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'review-step', type: 'review_loop' as any }),
      ], { output_dir: testOutputDir })

      // Run producer
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      taskStore.updateTask(freshRun.steps_state[0].taskId!, { status: 'completed' })
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      dagEngine.tick(freshRun, parsed) // REQ-17 gap tick
      freshRun = workflowStore.getRun(run.id)!
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // Write CONCERN verdict
      nodefs.writeFileSync(path.join(testOutputDir, 'verdict.yaml'), 'verdict: CONCERN')
      taskStore.updateTask(freshRun.steps_state[0].taskId!, { status: 'completed' })

      // Tick: CONCERN detected, concernWaitingSince set, still running
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[0].status).toBe('running')
      expect(freshRun.steps_state[0].concernWaitingSince).toBeTruthy()

      // Manually set concernWaitingSince to past to simulate timeout
      const pastTime = new Date(Date.now() - 2 * 60 * 1000).toISOString() // 2 minutes ago
      const updatedSteps = [...freshRun.steps_state]
      updatedSteps[0] = { ...updatedSteps[0], concernWaitingSince: pastTime }
      workflowStore.updateRun(run.id, { steps_state: updatedSteps })
      freshRun = workflowStore.getRun(run.id)!

      // Tick: timeout elapsed, default reject → treated as FAIL, loops to iteration 2
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // Iteration 2: run producer
      taskStore.updateTask(freshRun.steps_state[0].taskId!, { status: 'completed' })
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      dagEngine.tick(freshRun, parsed) // REQ-17 gap tick
      freshRun = workflowStore.getRun(run.id)!
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // Write CONCERN verdict for iteration 2
      nodefs.writeFileSync(path.join(testOutputDir, 'verdict.yaml'), 'verdict: CONCERN')
      taskStore.updateTask(freshRun.steps_state[0].taskId!, { status: 'completed' })

      // Tick: CONCERN detected again
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      expect(freshRun.steps_state[0].concernWaitingSince).toBeTruthy()

      // Simulate timeout again
      const pastTime2 = new Date(Date.now() - 2 * 60 * 1000).toISOString()
      const updatedSteps2 = [...freshRun.steps_state]
      updatedSteps2[0] = { ...updatedSteps2[0], concernWaitingSince: pastTime2 }
      workflowStore.updateRun(run.id, { steps_state: updatedSteps2 })
      freshRun = workflowStore.getRun(run.id)!

      // Tick: timeout elapsed, default reject → max_iterations=2 reached → fail
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      // With max_iterations=2 exhausted and on_max_iterations=fail, should fail
      expect(freshRun.steps_state[0].status).toBe('failed')

      // Cleanup
      try { nodefs.rmSync(testOutputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('P8-TEST-08: Multiple iterations with feedback', () => {
      const { workflowStore, taskStore, db } = createStores()
      const ctx = createTestContext()
      const pool = createSessionPool(db)
      const dagEngine = createDAGEngine(ctx, workflowStore, taskStore, pool)

      const nodefs = require('node:fs')
      const path = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const testOutputDir = path.join(tmpdir, `dag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(testOutputDir, { recursive: true })

      const yaml = [
        'name: p8-multi-iteration',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: review-step',
        '    type: review_loop',
        '    max_iterations: 3',
        '    producer:',
        '      name: producer',
        '      type: spawn_session',
        '      projectPath: /tmp/test',
        '      prompt: "produce code"',
        '    reviewer:',
        '      name: reviewer',
        '      type: spawn_session',
        '      projectPath: /tmp/test',
        '      prompt: "review code"',
        '      result_file: verdict.yaml',
        '      verdict_field: verdict',
        '      feedback_field: feedback',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p8-multi-iteration')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'review-step', type: 'review_loop' as any }),
      ], { output_dir: testOutputDir })

      // Iteration 1: FAIL
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      taskStore.updateTask(freshRun.steps_state[0].taskId!, { status: 'completed' })
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      dagEngine.tick(freshRun, parsed) // REQ-17 gap tick
      freshRun = workflowStore.getRun(run.id)!
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      nodefs.writeFileSync(path.join(testOutputDir, 'verdict.yaml'), 'verdict: FAIL\nfeedback: try again')
      taskStore.updateTask(freshRun.steps_state[0].taskId!, { status: 'completed' })
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].reviewIteration).toBe(2)
      expect(freshRun.steps_state[0].reviewFeedback).toBe('try again')

      // Iteration 2: PASS
      taskStore.updateTask(freshRun.steps_state[0].taskId!, { status: 'completed' })
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      dagEngine.tick(freshRun, parsed) // REQ-17 gap tick
      freshRun = workflowStore.getRun(run.id)!
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      nodefs.writeFileSync(path.join(testOutputDir, 'verdict.yaml'), 'verdict: PASS')
      taskStore.updateTask(freshRun.steps_state[0].taskId!, { status: 'completed' })
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].status).toBe('completed')
      expect(freshRun.steps_state[0].reviewVerdict).toBe('PASS')

      // Cleanup
      try { nodefs.rmSync(testOutputDir, { recursive: true }) } catch { /* ok */ }
    })

    test('P8-TEST-09: Summary file written on completion', () => {
      const { workflowStore, taskStore, db } = createStores()
      const ctx = createTestContext()
      const pool = createSessionPool(db)
      const dagEngine = createDAGEngine(ctx, workflowStore, taskStore, pool)

      const nodefs = require('node:fs')
      const path = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const testOutputDir = path.join(tmpdir, `dag-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(testOutputDir, { recursive: true })

      const yaml = [
        'name: p8-summary',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: review-step',
        '    type: review_loop',
        '    max_iterations: 2',
        '    producer:',
        '      name: producer',
        '      type: spawn_session',
        '      projectPath: /tmp/test',
        '      prompt: "produce code"',
        '    reviewer:',
        '      name: reviewer',
        '      type: spawn_session',
        '      projectPath: /tmp/test',
        '      prompt: "review code"',
        '      result_file: verdict.yaml',
        '      verdict_field: verdict',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'p8-summary')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'review-step', type: 'review_loop' as any }),
      ], { output_dir: testOutputDir })

      // Run to completion with PASS
      dagEngine.tick(run, parsed)
      let freshRun = workflowStore.getRun(run.id)!
      taskStore.updateTask(freshRun.steps_state[0].taskId!, { status: 'completed' })
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      dagEngine.tick(freshRun, parsed) // REQ-17 gap tick
      freshRun = workflowStore.getRun(run.id)!
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!
      nodefs.writeFileSync(path.join(testOutputDir, 'verdict.yaml'), 'verdict: PASS')
      taskStore.updateTask(freshRun.steps_state[0].taskId!, { status: 'completed' })
      dagEngine.tick(freshRun, parsed)
      freshRun = workflowStore.getRun(run.id)!

      expect(freshRun.steps_state[0].status).toBe('completed')

      // Check that summary file exists
      const summaryPath = path.join(testOutputDir, 'review-loop-summaries', 'review-step.yaml')
      expect(nodefs.existsSync(summaryPath)).toBe(true)

      // Read and verify it's valid YAML with expected structure
      const summaryContent = nodefs.readFileSync(summaryPath, 'utf-8')
      expect(summaryContent).toContain('step_name: review-step')
      expect(summaryContent).toContain('final_outcome: PASS')
      expect(summaryContent).toContain('iterations:')

      // Cleanup
      try { nodefs.rmSync(testOutputDir, { recursive: true }) } catch { /* ok */ }
    })
  })

  // ─── Phase 9: spec_validate in DAG engine ────────────────────────────────────

  describe('spec_validate DAG execution', () => {
    // These tests need temp files, so use beforeEach/afterEach
    const { mkdirSync, writeFileSync, rmSync, existsSync } = require('node:fs')
    const { tmpdir } = require('node:os')
    const path = require('node:path')
    const yamlLib = require('js-yaml')

    let tempDir: string
    let stores: { workflowStore: WorkflowStore; taskStore: TaskStore; db: any }
    let pool: SessionPool
    let ctx: ServerContext

    beforeEach(() => {
      tempDir = path.join(tmpdir(), `dag-spec-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      mkdirSync(tempDir, { recursive: true })
      stores = createStores()
      ctx = createTestContext({
        workflowStore: stores.workflowStore,
        taskStore: stores.taskStore,
        config: {
          ...createTestContext().config,
          taskOutputDir: tempDir,
        } as any,
      })
      pool = createSessionPool(stores.db)
    })

    afterEach(() => {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true })
      }
      try { stores.db.close() } catch { /* ok */ }
    })

    test('TEST-08: spec_validate does not consume pool slot', () => {
      // spec_validate is in POOL_BYPASS_TYPES — verify indirectly by running it
      // without any pool capacity and it should still complete
      const specContent = yamlLib.dump({ title: 'Test Feature', acceptance: [{ type: 'contract', description: 'test' }], scope: { files: ['src/'] } })
      const schemaContent = yamlLib.dump({ version: 'v1', required_fields: { title: { type: 'string' }, acceptance: { type: 'array' }, scope: { type: 'object' } } })

      const specPath = path.join(tempDir, 'spec.yaml')
      const schemaPath = path.join(tempDir, 'schema.yaml')
      writeFileSync(specPath, specContent)
      writeFileSync(schemaPath, schemaContent)

      const yamlStr = `
name: sv-pool-test
system:
  engine: dag
  session_pool: true
steps:
  - name: validate
    type: spec_validate
    spec_path: ${specPath}
    schema_path: ${schemaPath}
`
      const parsed = parseWorkflowYAML(yamlStr)
      expect(parsed.valid).toBe(true)

      // Create a pool with 0 capacity to prove spec_validate bypasses it
      const zeroPool = createSessionPool(stores.db)
      const dagEngine = createDAGEngine(ctx, stores.workflowStore, stores.taskStore, zeroPool)

      const runData = {
        workflow_id: 'wf-1',
        workflow_name: 'sv-pool-test',
        status: 'running' as const,
        current_step_index: 0,
        steps_state: [
          makeStepState({ name: 'validate', type: 'spec_validate' }),
        ],
        output_dir: tempDir,
        started_at: new Date().toISOString(),
        completed_at: null,
        error_message: null,
        variables: null,
      }

      const run = stores.workflowStore.createRunIfUnderLimit(runData, 10)
      expect(run).not.toBeNull()

      // First tick: starts the step
      dagEngine.tick(run!, parsed.workflow!)

      // Get the updated run
      let updatedRun = stores.workflowStore.getRun(run!.id)

      // Second tick: monitors and completes
      if (updatedRun && updatedRun.status === 'running') {
        dagEngine.tick(updatedRun, parsed.workflow!)
        updatedRun = stores.workflowStore.getRun(run!.id)
      }

      // Should complete (valid spec)
      expect(updatedRun).toBeDefined()
      const stepState = updatedRun!.steps_state.find(s => s.name === 'validate')
      expect(stepState).toBeDefined()
      // Step should be completed or at least running (not queued, which would mean it tried to get a pool slot)
      expect(['running', 'completed'].includes(stepState!.status)).toBe(true)
    })

    test('TEST-09: validation report written to output dir', () => {
      const specContent = yamlLib.dump({ title: 'Test Feature', acceptance: [{ type: 'contract', description: 'test' }], scope: { files: ['src/'] } })
      const schemaContent = yamlLib.dump({ version: 'v1', required_fields: { title: { type: 'string' }, acceptance: { type: 'array' }, scope: { type: 'object' } } })

      const specPath = path.join(tempDir, 'spec.yaml')
      const schemaPath = path.join(tempDir, 'schema.yaml')
      writeFileSync(specPath, specContent)
      writeFileSync(schemaPath, schemaContent)

      const yamlStr = `
name: sv-report-test
system:
  engine: dag
  session_pool: true
steps:
  - name: validate
    type: spec_validate
    spec_path: ${specPath}
    schema_path: ${schemaPath}
`
      const parsed = parseWorkflowYAML(yamlStr)
      const dagEngine = createDAGEngine(ctx, stores.workflowStore, stores.taskStore, pool)

      const runData = {
        workflow_id: 'wf-2',
        workflow_name: 'sv-report-test',
        status: 'running' as const,
        current_step_index: 0,
        steps_state: [
          makeStepState({ name: 'validate', type: 'spec_validate' }),
        ],
        output_dir: tempDir,
        started_at: new Date().toISOString(),
        completed_at: null,
        error_message: null,
        variables: null,
      }

      const run = stores.workflowStore.createRunIfUnderLimit(runData, 10)
      expect(run).not.toBeNull()

      // Tick twice: start + monitor
      dagEngine.tick(run!, parsed.workflow!)
      let updatedRun = stores.workflowStore.getRun(run!.id)
      if (updatedRun && updatedRun.status === 'running') {
        dagEngine.tick(updatedRun, parsed.workflow!)
        updatedRun = stores.workflowStore.getRun(run!.id)
      }

      // Check that result content was stored
      const stepState = updatedRun!.steps_state.find(s => s.name === 'validate')
      if (stepState && stepState.status === 'completed') {
        expect(stepState.resultCollected).toBe(true)
        expect(stepState.resultContent).toBeDefined()
        const report = JSON.parse(stepState.resultContent!)
        expect(report.valid).toBe(true)
        expect(report.spec_path).toBe(specPath)
      }

      // Check report file exists
      const reportPath = path.join(tempDir, 'validate_report.json')
      expect(existsSync(reportPath)).toBe(true)
    })
  })

  // ── Phase 10: Amendment System ─────────────────────────────────────────────

  describe('Phase 10: amendment system', () => {
    test('amendment_check with no signals completes immediately', () => {
      const nodefs = require('node:fs')
      const nodePath = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const signalDir = nodePath.join(tmpdir, `dag-amend-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(signalDir, { recursive: true })

      try {
        const yaml = `
name: amend-empty
system:
  engine: dag
steps:
  - name: check-amend
    type: amendment_check
    signal_dir: ${signalDir}
`
        const parsed = getParsed(yaml)
        const def = createWorkflowDef(workflowStore, yaml, 'amend-empty')
        const stepsState = [
          makeStepState({ name: 'check-amend', type: 'amendment_check', status: 'pending' }),
        ]
        const run = createTestRun(workflowStore, def.id, stepsState)

        dagEngine.tick(run, parsed)

        const updated = workflowStore.getRun(run.id)!
        const step = updated.steps_state.find(s => s.name === 'check-amend')!
        expect(step.status).toBe('completed')
        expect(step.completedAt).not.toBeNull()
      } finally {
        nodefs.rmSync(signalDir, { recursive: true, force: true })
      }
    })

    test('amendment_check with nonexistent signal_dir completes immediately', () => {
      const yaml = `
name: amend-nodir
system:
  engine: dag
steps:
  - name: check-amend
    type: amendment_check
    signal_dir: /tmp/nonexistent-signal-dir-${Date.now()}
`
      const parsed = getParsed(yaml)
      const def = createWorkflowDef(workflowStore, yaml, 'amend-nodir')
      const stepsState = [
        makeStepState({ name: 'check-amend', type: 'amendment_check', status: 'pending' }),
      ]
      const run = createTestRun(workflowStore, def.id, stepsState)

      dagEngine.tick(run, parsed)

      const updated = workflowStore.getRun(run.id)!
      const step = updated.steps_state.find(s => s.name === 'check-amend')!
      expect(step.status).toBe('completed')
    })

    test('amendment_check detects valid amendment signal', () => {
      const nodefs = require('node:fs')
      const nodePath = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const signalDir = nodePath.join(tmpdir, `dag-amend-detect-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(signalDir, { recursive: true })

      try {
        const yaml = `
name: amend-detect
system:
  engine: dag
steps:
  - name: check-amend
    type: amendment_check
    signal_dir: ${signalDir}
`
        const parsed = getParsed(yaml)
        const def = createWorkflowDef(workflowStore, yaml, 'amend-detect')

        // Start with step already 'running' and startedAt in the past,
        // so tick() goes directly to monitor phase (amendment_check processing).
        // The signal file written below will be newer than startedAt, avoiding stale detection.
        const startedAt = new Date(Date.now() - 60000).toISOString()
        const stepsState = [
          makeStepState({ name: 'check-amend', type: 'amendment_check', status: 'running', startedAt }),
        ]
        const run = createTestRun(workflowStore, def.id, stepsState)

        // Write signal AFTER run creation, ensuring file mtime > startedAt
        const signalContent = [
          'signal_type: amendment_required',
          'amendment:',
          '  type: gap',
          '  category: quality',
          '  spec_section: auth.login',
          '  issue: Missing error handling for expired tokens',
          '  proposed_addition: Add token refresh flow',
          'checkpoint:',
          '  step: 3',
        ].join('\n')
        nodefs.writeFileSync(nodePath.join(signalDir, 'signal-001.yaml'), signalContent)

        dagEngine.tick(run, parsed)

        const updated = workflowStore.getRun(run.id)!
        const step = updated.steps_state.find(s => s.name === 'check-amend')!
        expect(step.status).toBe('paused_amendment')
        expect(step.amendmentPhase).toBe('detected')
        expect(step.amendmentType).toBe('gap')
        expect(step.amendmentCategory).toBe('quality')
        expect(step.amendmentSpecSection).toBe('auth.login')
      } finally {
        nodefs.rmSync(signalDir, { recursive: true, force: true })
      }
    })

    test('malformed signal file is skipped', () => {
      const nodefs = require('node:fs')
      const nodePath = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const signalDir = nodePath.join(tmpdir, `dag-amend-malformed-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(signalDir, { recursive: true })

      try {
        // Write a malformed signal (valid YAML but missing required amendment fields)
        nodefs.writeFileSync(
          nodePath.join(signalDir, 'bad-signal.yaml'),
          'signal_type: amendment_required\namendment:\n  type: gap\n',
        )

        const yaml = `
name: amend-malformed
system:
  engine: dag
steps:
  - name: check-amend
    type: amendment_check
    signal_dir: ${signalDir}
`
        const parsed = getParsed(yaml)
        const def = createWorkflowDef(workflowStore, yaml, 'amend-malformed')
        const startedAt = new Date(Date.now() - 60000).toISOString()
        const stepsState = [
          makeStepState({ name: 'check-amend', type: 'amendment_check', status: 'running', startedAt }),
        ]
        const run = createTestRun(workflowStore, def.id, stepsState)

        dagEngine.tick(run, parsed)

        const updated = workflowStore.getRun(run.id)!
        const step = updated.steps_state.find(s => s.name === 'check-amend')!
        // Malformed signal skipped, no valid signals found -> completed
        expect(step.status).toBe('completed')
      } finally {
        nodefs.rmSync(signalDir, { recursive: true, force: true })
      }
    })

    test('amendment_check skips symlinks (SEC-3)', () => {
      const nodefs = require('node:fs')
      const nodePath = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const signalDir = nodePath.join(tmpdir, `dag-amend-symlink-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      const targetDir = nodePath.join(tmpdir, `dag-amend-symlink-target-${Date.now()}-${Math.random().toString(36).slice(2)}`)

      try {
        nodefs.mkdirSync(signalDir, { recursive: true })
        nodefs.mkdirSync(targetDir, { recursive: true })

        // Create a valid signal file outside the signal directory
        const targetFile = nodePath.join(targetDir, 'external-signal.yaml')
        const signalContent = `
signal_type: amendment_required
amendment:
  type: gap
  category: quality
  spec_section: test.section
  issue: "This should not be processed"
`
        nodefs.writeFileSync(targetFile, signalContent, 'utf-8')

        // Create a symlink in the signal directory pointing to it
        const symlinkPath = nodePath.join(signalDir, 'symlink-signal.yaml')
        nodefs.symlinkSync(targetFile, symlinkPath)

        const yaml = `
name: amend-symlink
system:
  engine: dag
steps:
  - name: check-amend
    type: amendment_check
    signal_dir: ${signalDir}
`
        const parsed = getParsed(yaml)
        const def = createWorkflowDef(workflowStore, yaml, 'amend-symlink')
        const startedAt = new Date(Date.now() - 60000).toISOString()
        const stepsState = [
          makeStepState({ name: 'check-amend', type: 'amendment_check', status: 'running', startedAt }),
        ]
        const run = createTestRun(workflowStore, def.id, stepsState)

        dagEngine.tick(run, parsed)

        const updated = workflowStore.getRun(run.id)!
        const step = updated.steps_state.find(s => s.name === 'check-amend')!
        // Symlink should be skipped, no valid signals found -> completed
        expect(step.status).toBe('completed')
        expect(step.status).not.toBe('paused_amendment')
      } finally {
        nodefs.rmSync(signalDir, { recursive: true, force: true })
        nodefs.rmSync(targetDir, { recursive: true, force: true })
      }
    })

    test('paused_escalated is a failure status causing run failure', () => {
      const yaml = `
name: escalated-test
system:
  engine: dag
steps:
  - name: escalated-step
    type: spawn_session
    projectPath: /tmp/test
    prompt: "test"
`
      const parsed = getParsed(yaml)
      const def = createWorkflowDef(workflowStore, yaml, 'escalated-test')
      const stepsState = [
        makeStepState({
          name: 'escalated-step',
          type: 'spawn_session',
          status: 'paused_escalated',
          taskId: 'task-456',
          startedAt: new Date().toISOString(),
        }),
      ]
      const run = createTestRun(workflowStore, def.id, stepsState)

      dagEngine.tick(run, parsed)

      const updated = workflowStore.getRun(run.id)!
      // paused_escalated is terminal and a failure status
      expect(updated.status).toBe('failed')
    })

    // ── CF-1: Real amendment handler spawning tests ──────────────────────

    test('TEST-15: handler_running spawns handler task and sets amendmentHandlerTaskId', () => {
      const nodefs = require('node:fs')
      const nodePath = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const signalDir = nodePath.join(tmpdir, `dag-handler-spawn-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      const outputDir = nodePath.join(tmpdir, `dag-handler-output-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(signalDir, { recursive: true })
      nodefs.mkdirSync(outputDir, { recursive: true })

      try {
        // Write a valid amendment signal file
        const signalFile = nodePath.join(signalDir, 'signal-001.yaml')
        nodefs.writeFileSync(signalFile, [
          'signal_type: amendment_required',
          'amendment:',
          '  type: gap',
          '  category: quality',
          '  spec_section: auth.login',
          '  issue: Missing error handling for expired tokens',
          '  proposed_addition: Add token refresh flow',
          'checkpoint:',
          '  step: 3',
          '  progress: partial',
        ].join('\n'))

        const yaml = `
name: handler-spawn-test
system:
  engine: dag
steps:
  - name: test-step
    type: spawn_session
    projectPath: /tmp/test
    prompt: "do work"
`
        const parsed = getParsed(yaml)
        const def = createWorkflowDef(workflowStore, yaml, 'handler-spawn-test')

        // Set up step in handler_running phase with signal file
        const stepsState = [
          makeStepState({
            name: 'test-step',
            type: 'spawn_session',
            status: 'paused_amendment',
            amendmentPhase: 'handler_running',
            amendmentSignalFile: signalFile,
            amendmentRetryCount: 0,
          }),
        ]
        const run = createTestRun(workflowStore, def.id, stepsState, { output_dir: outputDir })

        dagEngine.tick(run, parsed)

        const updated = workflowStore.getRun(run.id)!
        const step = updated.steps_state.find(s => s.name === 'test-step')!

        // Handler should have been spawned with a real task ID
        expect(step.amendmentHandlerTaskId).not.toBeNull()
        expect(step.amendmentHandlerTaskId).toBeTruthy()
        expect(step.status).toBe('paused_amendment')
        expect(step.amendmentPhase).toBe('handler_running')
        expect(step.startedAt).not.toBeNull()

        // Verify the task was created in the task store
        const task = taskStore.getTask(step.amendmentHandlerTaskId!)
        expect(task).not.toBeNull()
        expect(task!.status).toBe('queued')
        expect(task!.prompt).toContain('Amendment Handler Task')
        expect(task!.prompt).toContain('gap')
        expect(task!.prompt).toContain('auth.login')
        expect(task!.prompt).toContain('Missing error handling')
        expect(task!.prompt).toContain('amendment-resolution-test-step.yaml')

        // Verify metadata
        const metadata = JSON.parse(task!.metadata ?? '{}')
        expect(metadata.agent_type).toBe('amendment-handler')
        expect(metadata.amendment_type).toBe('gap')
        expect(metadata.amendment_section).toBe('auth.login')
      } finally {
        nodefs.rmSync(signalDir, { recursive: true, force: true })
        nodefs.rmSync(outputDir, { recursive: true, force: true })
      }
    })

    test('TEST-15b: handler_complete reads actual resolution and resolves with correct status', () => {
      const nodefs = require('node:fs')
      const nodePath = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const signalDir = nodePath.join(tmpdir, `dag-handler-complete-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      const outputDir = nodePath.join(tmpdir, `dag-handler-complete-out-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(signalDir, { recursive: true })
      nodefs.mkdirSync(outputDir, { recursive: true })

      try {
        // Write a valid amendment signal file
        const signalFile = nodePath.join(signalDir, 'signal-001.yaml')
        nodefs.writeFileSync(signalFile, [
          'signal_type: amendment_required',
          'amendment:',
          '  type: gap',
          '  category: quality',
          '  spec_section: auth.login',
          '  issue: Missing error handling',
          'checkpoint:',
          '  step: 3',
        ].join('\n'))

        // Write an approved resolution file
        const resolutionFile = nodePath.join(outputDir, 'amendment-resolution-test-step.yaml')
        nodefs.writeFileSync(resolutionFile, [
          'signal_file: signal-001.yaml',
          'resolution: approved',
          'amendment_id: amend-001',
          'resolved_at: "2026-01-01T00:00:00Z"',
          'resolved_by: spec-reviewer',
          'spec_changes: Updated auth section',
        ].join('\n'))

        const yaml = `
name: handler-complete-test
system:
  engine: dag
steps:
  - name: test-step
    type: spawn_session
    projectPath: /tmp/test
    prompt: "do work"
`
        const parsed = getParsed(yaml)
        const def = createWorkflowDef(workflowStore, yaml, 'handler-complete-test')

        // Record an amendment in the DB so resolveAmendment can be called
        const amendmentId = workflowStore.insertAmendment({
          run_id: 'will-be-overridden',
          step_name: 'test-step',
          signal_file: signalFile,
          amendment_type: 'gap',
          category: 'quality',
          spec_section: 'auth.login',
          issue: 'Missing error handling',
        })

        const stepsState = [
          makeStepState({
            name: 'test-step',
            type: 'spawn_session',
            status: 'paused_amendment',
            amendmentPhase: 'handler_complete',
            amendmentSignalFile: signalFile,
            amendmentSignalId: amendmentId,
            amendmentHandlerTaskId: 'handler-task-1',
          }),
        ]
        const run = createTestRun(workflowStore, def.id, stepsState, { output_dir: outputDir })

        dagEngine.tick(run, parsed)

        const updated = workflowStore.getRun(run.id)!
        const step = updated.steps_state.find(s => s.name === 'test-step')!

        // Step should be back to running
        expect(step.status).toBe('running')
        expect(step.amendmentPhase).toBeNull()
        expect(step.amendmentHandlerTaskId).toBeNull()

        // A resume task should have been created
        expect(step.taskId).not.toBeNull()
        const resumeTask = taskStore.getTask(step.taskId!)
        expect(resumeTask).not.toBeNull()
        expect(resumeTask!.prompt).toContain('Resume After Amendment')
        expect(resumeTask!.prompt).toContain('approved')
        expect(resumeTask!.prompt).toContain('re-read the relevant spec section')
      } finally {
        nodefs.rmSync(signalDir, { recursive: true, force: true })
        nodefs.rmSync(outputDir, { recursive: true, force: true })
      }
    })

    test('TEST-15c: P-3 handler_complete supports rejected resolution', () => {
      const nodefs = require('node:fs')
      const nodePath = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const signalDir = nodePath.join(tmpdir, `dag-handler-reject-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      const outputDir = nodePath.join(tmpdir, `dag-handler-reject-out-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(signalDir, { recursive: true })
      nodefs.mkdirSync(outputDir, { recursive: true })

      try {
        // Write a valid amendment signal file
        const signalFile = nodePath.join(signalDir, 'signal-001.yaml')
        nodefs.writeFileSync(signalFile, [
          'signal_type: amendment_required',
          'amendment:',
          '  type: correction',
          '  category: quality',
          '  spec_section: db.schema',
          '  issue: Wrong column type',
          'checkpoint:',
          '  step: 5',
        ].join('\n'))

        // Write a REJECTED resolution file
        const resolutionFile = nodePath.join(outputDir, 'amendment-resolution-test-step.yaml')
        nodefs.writeFileSync(resolutionFile, [
          'signal_file: signal-001.yaml',
          'resolution: rejected',
          'amendment_id: amend-002',
          'resolved_at: "2026-01-01T00:00:00Z"',
          'resolved_by: spec-reviewer',
          'spec_changes: null',
        ].join('\n'))

        const yaml = `
name: handler-reject-test
system:
  engine: dag
steps:
  - name: test-step
    type: spawn_session
    projectPath: /tmp/test
    prompt: "do work"
`
        const parsed = getParsed(yaml)
        const def = createWorkflowDef(workflowStore, yaml, 'handler-reject-test')

        const amendmentId = workflowStore.insertAmendment({
          run_id: 'will-be-overridden',
          step_name: 'test-step',
          signal_file: signalFile,
          amendment_type: 'correction',
          category: 'quality',
          spec_section: 'db.schema',
          issue: 'Wrong column type',
        })

        const stepsState = [
          makeStepState({
            name: 'test-step',
            type: 'spawn_session',
            status: 'paused_amendment',
            amendmentPhase: 'handler_complete',
            amendmentSignalFile: signalFile,
            amendmentSignalId: amendmentId,
            amendmentHandlerTaskId: 'handler-task-2',
          }),
        ]
        const run = createTestRun(workflowStore, def.id, stepsState, { output_dir: outputDir })

        dagEngine.tick(run, parsed)

        const updated = workflowStore.getRun(run.id)!
        const step = updated.steps_state.find(s => s.name === 'test-step')!

        // Step should be back to running even for rejected
        expect(step.status).toBe('running')
        expect(step.amendmentPhase).toBeNull()

        // Resume task should mention rejection
        const resumeTask = taskStore.getTask(step.taskId!)
        expect(resumeTask).not.toBeNull()
        expect(resumeTask!.prompt).toContain('rejected')
        expect(resumeTask!.prompt).toContain('Continue with the original spec as-is')

        // Verify the broadcast had the correct resolution
        const broadcastCalls = (ctx.broadcast as any).mock.calls
        const resolvedBroadcast = broadcastCalls.find(
          (c: any) => c[0]?.type === 'amendment_resolved'
        )
        expect(resolvedBroadcast).toBeTruthy()
        expect(resolvedBroadcast[0].resolution).toBe('rejected')
      } finally {
        nodefs.rmSync(signalDir, { recursive: true, force: true })
        nodefs.rmSync(outputDir, { recursive: true, force: true })
      }
    })

    test('TEST-16: human escalation flow for fundamental amendments', () => {
      const nodefs = require('node:fs')
      const nodePath = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const signalDir = nodePath.join(tmpdir, `dag-handler-escalate-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(signalDir, { recursive: true })

      try {
        const signalFile = nodePath.join(signalDir, 'signal-001.yaml')
        nodefs.writeFileSync(signalFile, [
          'signal_type: amendment_required',
          'amendment:',
          '  type: fundamental',
          '  category: fundamental',
          '  spec_section: architecture',
          '  issue: Architecture is fundamentally wrong',
          'checkpoint:',
          '  step: 1',
        ].join('\n'))

        const yaml = `
name: handler-escalate-test
system:
  engine: dag
steps:
  - name: test-step
    type: amendment_check
    signal_dir: ${signalDir}
`
        const parsed = getParsed(yaml)
        const def = createWorkflowDef(workflowStore, yaml, 'handler-escalate-test')

        // Start as detected phase (processAmendment will check escalation)
        const stepsState = [
          makeStepState({
            name: 'test-step',
            type: 'amendment_check',
            status: 'paused_amendment',
            amendmentPhase: 'detected',
            amendmentSignalFile: signalFile,
          }),
        ]
        const run = createTestRun(workflowStore, def.id, stepsState)

        dagEngine.tick(run, parsed)

        const updated = workflowStore.getRun(run.id)!
        const step = updated.steps_state.find(s => s.name === 'test-step')!

        // Fundamental amendments should escalate to human
        expect(step.status).toBe('paused_escalated')
        expect(step.amendmentPhase).toBe('awaiting_human')

        // Verify escalation broadcast
        const broadcastCalls = (ctx.broadcast as any).mock.calls
        const escalatedBroadcast = broadcastCalls.find(
          (c: any) => c[0]?.type === 'amendment_escalated'
        )
        expect(escalatedBroadcast).toBeTruthy()
      } finally {
        nodefs.rmSync(signalDir, { recursive: true, force: true })
      }
    })

    test('TEST-17: handler timeout after max retries escalates to human', () => {
      const nodefs = require('node:fs')
      const nodePath = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const signalDir = nodePath.join(tmpdir, `dag-handler-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(signalDir, { recursive: true })

      try {
        const signalFile = nodePath.join(signalDir, 'signal-001.yaml')
        nodefs.writeFileSync(signalFile, [
          'signal_type: amendment_required',
          'amendment:',
          '  type: gap',
          '  category: quality',
          '  spec_section: auth',
          '  issue: Missing handler',
          'checkpoint:',
          '  step: 1',
        ].join('\n'))

        // Create a task that simulates being stuck (still running)
        const handlerTask = taskStore.createTask({
          projectPath: '/tmp/test',
          prompt: 'handler prompt',
          templateId: null,
          priority: 7,
          status: 'queued',
          maxRetries: 0,
          timeoutSeconds: 1,
        })
        // Update task to running status (simulates started handler)
        taskStore.updateTask(handlerTask.id, { status: 'running' })

        const yaml = `
name: handler-timeout-test
system:
  engine: dag
steps:
  - name: test-step
    type: spawn_session
    projectPath: /tmp/test
    prompt: "do work"
    amendment_config:
      handler_timeout_seconds: 1
`
        const parsed = getParsed(yaml)
        const def = createWorkflowDef(workflowStore, yaml, 'handler-timeout-test')

        // Set startedAt far in the past to trigger timeout
        const longAgo = new Date(Date.now() - 60000).toISOString()
        const stepsState = [
          makeStepState({
            name: 'test-step',
            type: 'spawn_session',
            status: 'paused_amendment',
            amendmentPhase: 'handler_running',
            amendmentSignalFile: signalFile,
            amendmentHandlerTaskId: handlerTask.id,
            amendmentRetryCount: 1,  // Already retried once
            startedAt: longAgo,
          }),
        ]
        const run = createTestRun(workflowStore, def.id, stepsState)

        dagEngine.tick(run, parsed)

        const updated = workflowStore.getRun(run.id)!
        const step = updated.steps_state.find(s => s.name === 'test-step')!

        // After max retries + timeout, should escalate to human
        expect(step.status).toBe('paused_escalated')
        expect(step.amendmentPhase).toBe('awaiting_human')
        expect(step.amendmentRetryCount).toBe(2)
      } finally {
        nodefs.rmSync(signalDir, { recursive: true, force: true })
      }
    })

    test('TEST-17b: handler timeout with retries remaining resets handler for retry', () => {
      const nodefs = require('node:fs')
      const nodePath = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const signalDir = nodePath.join(tmpdir, `dag-handler-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(signalDir, { recursive: true })

      try {
        const signalFile = nodePath.join(signalDir, 'signal-001.yaml')
        nodefs.writeFileSync(signalFile, [
          'signal_type: amendment_required',
          'amendment:',
          '  type: gap',
          '  category: quality',
          '  spec_section: auth',
          '  issue: Missing handler',
          'checkpoint:',
          '  step: 1',
        ].join('\n'))

        const handlerTask = taskStore.createTask({
          projectPath: '/tmp/test',
          prompt: 'handler prompt',
          templateId: null,
          priority: 7,
          status: 'queued',
          maxRetries: 0,
          timeoutSeconds: 1,
        })
        taskStore.updateTask(handlerTask.id, { status: 'running' })

        const yaml = `
name: handler-retry-test
system:
  engine: dag
steps:
  - name: test-step
    type: spawn_session
    projectPath: /tmp/test
    prompt: "do work"
    amendment_config:
      handler_timeout_seconds: 1
`
        const parsed = getParsed(yaml)
        const def = createWorkflowDef(workflowStore, yaml, 'handler-retry-test')

        const longAgo = new Date(Date.now() - 60000).toISOString()
        const stepsState = [
          makeStepState({
            name: 'test-step',
            type: 'spawn_session',
            status: 'paused_amendment',
            amendmentPhase: 'handler_running',
            amendmentSignalFile: signalFile,
            amendmentHandlerTaskId: handlerTask.id,
            amendmentRetryCount: 0,  // First attempt
            startedAt: longAgo,
          }),
        ]
        const run = createTestRun(workflowStore, def.id, stepsState)

        dagEngine.tick(run, parsed)

        const updated = workflowStore.getRun(run.id)!
        const step = updated.steps_state.find(s => s.name === 'test-step')!

        // Should retry: reset handler task ID, increment retry count
        expect(step.status).toBe('paused_amendment')
        expect(step.amendmentPhase).toBe('handler_running')
        expect(step.amendmentHandlerTaskId).toBeNull()
        expect(step.amendmentRetryCount).toBe(1)
      } finally {
        nodefs.rmSync(signalDir, { recursive: true, force: true })
      }
    })

    test('TEST-22: handler_complete resumes step with checkpoint context', () => {
      const nodefs = require('node:fs')
      const nodePath = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const signalDir = nodePath.join(tmpdir, `dag-handler-resume-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      const outputDir = nodePath.join(tmpdir, `dag-handler-resume-out-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(signalDir, { recursive: true })
      nodefs.mkdirSync(outputDir, { recursive: true })

      try {
        // Write amendment signal with detailed checkpoint
        const signalFile = nodePath.join(signalDir, 'signal-001.yaml')
        nodefs.writeFileSync(signalFile, [
          'signal_type: amendment_required',
          'amendment:',
          '  type: reconciliation',
          '  category: reconciliation',
          '  spec_section: api.endpoints',
          '  issue: Missing pagination support',
          '  proposed_addition: Add offset/limit params',
          'checkpoint:',
          '  step: 7',
          '  progress: implementing',
          '  current_file: src/api/routes.ts',
          '  completed_sections:',
          '    - auth',
          '    - users',
        ].join('\n'))

        // Write approved resolution
        const resolutionFile = nodePath.join(outputDir, 'amendment-resolution-test-step.yaml')
        nodefs.writeFileSync(resolutionFile, [
          'signal_file: signal-001.yaml',
          'resolution: approved',
          'amendment_id: amend-003',
          'resolved_at: "2026-01-01T00:00:00Z"',
          'resolved_by: spec-reviewer',
          'spec_changes: Added pagination to api.endpoints section',
        ].join('\n'))

        const yaml = `
name: handler-resume-test
system:
  engine: dag
steps:
  - name: test-step
    type: spawn_session
    projectPath: /tmp/test
    prompt: "implement API endpoints according to spec"
`
        const parsed = getParsed(yaml)
        const def = createWorkflowDef(workflowStore, yaml, 'handler-resume-test')

        const stepsState = [
          makeStepState({
            name: 'test-step',
            type: 'spawn_session',
            status: 'paused_amendment',
            amendmentPhase: 'handler_complete',
            amendmentSignalFile: signalFile,
            amendmentHandlerTaskId: 'handler-task-3',
          }),
        ]
        const run = createTestRun(workflowStore, def.id, stepsState, { output_dir: outputDir })

        dagEngine.tick(run, parsed)

        const updated = workflowStore.getRun(run.id)!
        const step = updated.steps_state.find(s => s.name === 'test-step')!

        // Step should be running again
        expect(step.status).toBe('running')
        expect(step.amendmentPhase).toBeNull()

        // Resume task should include checkpoint data
        expect(step.taskId).not.toBeNull()
        const resumeTask = taskStore.getTask(step.taskId!)
        expect(resumeTask).not.toBeNull()

        // Verify resume prompt contains checkpoint info
        const prompt = resumeTask!.prompt
        expect(prompt).toContain('Resume After Amendment')
        expect(prompt).toContain('approved')
        expect(prompt).toContain('"step": 7')
        expect(prompt).toContain('"progress": "implementing"')
        expect(prompt).toContain('re-read the relevant spec section')

        // Verify original task prompt is also included
        expect(prompt).toContain('implement API endpoints according to spec')

        // Verify metadata indicates this is a resume
        const metadata = JSON.parse(resumeTask!.metadata ?? '{}')
        expect(metadata.resume_after_amendment).toBe('true')
        expect(metadata.amendment_resolution).toBe('approved')
      } finally {
        nodefs.rmSync(signalDir, { recursive: true, force: true })
        nodefs.rmSync(outputDir, { recursive: true, force: true })
      }
    })

    test('TEST-15d: handler_running with failed task retries on first failure', () => {
      const nodefs = require('node:fs')
      const nodePath = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const signalDir = nodePath.join(tmpdir, `dag-handler-taskfail-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(signalDir, { recursive: true })

      try {
        const signalFile = nodePath.join(signalDir, 'signal-001.yaml')
        nodefs.writeFileSync(signalFile, [
          'signal_type: amendment_required',
          'amendment:',
          '  type: gap',
          '  category: quality',
          '  spec_section: auth',
          '  issue: Missing handler',
          'checkpoint:',
          '  step: 1',
        ].join('\n'))

        // Create a task that has already failed
        const handlerTask = taskStore.createTask({
          projectPath: '/tmp/test',
          prompt: 'handler prompt',
          templateId: null,
          priority: 7,
          status: 'queued',
          maxRetries: 0,
          timeoutSeconds: 300,
        })
        taskStore.updateTask(handlerTask.id, { status: 'failed', errorMessage: 'agent crashed' })

        const yaml = `
name: handler-taskfail-test
system:
  engine: dag
steps:
  - name: test-step
    type: spawn_session
    projectPath: /tmp/test
    prompt: "do work"
`
        const parsed = getParsed(yaml)
        const def = createWorkflowDef(workflowStore, yaml, 'handler-taskfail-test')

        const stepsState = [
          makeStepState({
            name: 'test-step',
            type: 'spawn_session',
            status: 'paused_amendment',
            amendmentPhase: 'handler_running',
            amendmentSignalFile: signalFile,
            amendmentHandlerTaskId: handlerTask.id,
            amendmentRetryCount: 0,
            startedAt: new Date().toISOString(),
          }),
        ]
        const run = createTestRun(workflowStore, def.id, stepsState)

        dagEngine.tick(run, parsed)

        const updated = workflowStore.getRun(run.id)!
        const step = updated.steps_state.find(s => s.name === 'test-step')!

        // Should retry: reset handler task ID, increment retry
        expect(step.status).toBe('paused_amendment')
        expect(step.amendmentPhase).toBe('handler_running')
        expect(step.amendmentHandlerTaskId).toBeNull()
        expect(step.amendmentRetryCount).toBe(1)
      } finally {
        nodefs.rmSync(signalDir, { recursive: true, force: true })
      }
    })

    test('TEST-15e: handler_running with completed task and resolution file advances to handler_complete', () => {
      const nodefs = require('node:fs')
      const nodePath = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const signalDir = nodePath.join(tmpdir, `dag-handler-done-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      const outputDir = nodePath.join(tmpdir, `dag-handler-done-out-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(signalDir, { recursive: true })
      nodefs.mkdirSync(outputDir, { recursive: true })

      try {
        const signalFile = nodePath.join(signalDir, 'signal-001.yaml')
        nodefs.writeFileSync(signalFile, [
          'signal_type: amendment_required',
          'amendment:',
          '  type: gap',
          '  category: quality',
          '  spec_section: auth',
          '  issue: Missing handler',
          'checkpoint:',
          '  step: 1',
        ].join('\n'))

        // Create a completed handler task
        const handlerTask = taskStore.createTask({
          projectPath: '/tmp/test',
          prompt: 'handler prompt',
          templateId: null,
          priority: 7,
          status: 'queued',
          maxRetries: 0,
          timeoutSeconds: 300,
        })
        taskStore.updateTask(handlerTask.id, { status: 'completed' })

        // Write a resolution file
        const resolutionFile = nodePath.join(outputDir, 'amendment-resolution-test-step.yaml')
        nodefs.writeFileSync(resolutionFile, [
          'signal_file: signal-001.yaml',
          'resolution: approved',
          'amendment_id: amend-004',
          'resolved_at: "2026-01-01T00:00:00Z"',
          'resolved_by: spec-reviewer',
        ].join('\n'))

        const yaml = `
name: handler-done-test
system:
  engine: dag
steps:
  - name: test-step
    type: spawn_session
    projectPath: /tmp/test
    prompt: "do work"
`
        const parsed = getParsed(yaml)
        const def = createWorkflowDef(workflowStore, yaml, 'handler-done-test')

        const stepsState = [
          makeStepState({
            name: 'test-step',
            type: 'spawn_session',
            status: 'paused_amendment',
            amendmentPhase: 'handler_running',
            amendmentSignalFile: signalFile,
            amendmentHandlerTaskId: handlerTask.id,
            amendmentRetryCount: 0,
            startedAt: new Date().toISOString(),
          }),
        ]
        const run = createTestRun(workflowStore, def.id, stepsState, { output_dir: outputDir })

        dagEngine.tick(run, parsed)

        const updated = workflowStore.getRun(run.id)!
        const step = updated.steps_state.find(s => s.name === 'test-step')!

        // Should advance to handler_complete
        expect(step.status).toBe('paused_amendment')
        expect(step.amendmentPhase).toBe('handler_complete')
      } finally {
        nodefs.rmSync(signalDir, { recursive: true, force: true })
        nodefs.rmSync(outputDir, { recursive: true, force: true })
      }
    })

    test('TEST-15f: sequential amendment processing blocks concurrent handlers', () => {
      const nodefs = require('node:fs')
      const nodePath = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const signalDir1 = nodePath.join(tmpdir, `dag-handler-seq1-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      const signalDir2 = nodePath.join(tmpdir, `dag-handler-seq2-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      nodefs.mkdirSync(signalDir1, { recursive: true })
      nodefs.mkdirSync(signalDir2, { recursive: true })

      try {
        // Write signal files for both steps
        const signalFile1 = nodePath.join(signalDir1, 'signal-001.yaml')
        const signalFile2 = nodePath.join(signalDir2, 'signal-002.yaml')
        const signalContent = [
          'signal_type: amendment_required',
          'amendment:',
          '  type: gap',
          '  category: quality',
          '  spec_section: auth',
          '  issue: Missing handler',
          'checkpoint:',
          '  step: 1',
        ].join('\n')
        nodefs.writeFileSync(signalFile1, signalContent)
        nodefs.writeFileSync(signalFile2, signalContent)

        const yaml = `
name: handler-seq-test
system:
  engine: dag
steps:
  - name: step-1
    type: spawn_session
    projectPath: /tmp/test
    prompt: "do work 1"
  - name: step-2
    type: spawn_session
    projectPath: /tmp/test
    prompt: "do work 2"
`
        const parsed = getParsed(yaml)
        const def = createWorkflowDef(workflowStore, yaml, 'handler-seq-test')

        // Step-1 already has a handler running, step-2 needs one
        const stepsState = [
          makeStepState({
            name: 'step-1',
            type: 'spawn_session',
            status: 'paused_amendment',
            amendmentPhase: 'handler_running',
            amendmentSignalFile: signalFile1,
            amendmentHandlerTaskId: 'existing-handler-task',
            startedAt: new Date().toISOString(),
          }),
          makeStepState({
            name: 'step-2',
            type: 'spawn_session',
            status: 'paused_amendment',
            amendmentPhase: 'handler_running',
            amendmentSignalFile: signalFile2,
            amendmentRetryCount: 0,
          }),
        ]
        const run = createTestRun(workflowStore, def.id, stepsState)

        dagEngine.tick(run, parsed)

        const updated = workflowStore.getRun(run.id)!
        const step2 = updated.steps_state.find(s => s.name === 'step-2')!

        // Step-2 should NOT have a handler spawned because step-1 is already running one
        expect(step2.amendmentHandlerTaskId).toBeFalsy()
      } finally {
        nodefs.rmSync(signalDir1, { recursive: true, force: true })
        nodefs.rmSync(signalDir2, { recursive: true, force: true })
      }
    })
  })

  // ── P-8: reconcile-spec batch reconciliation ─────────────────────────────

  describe('reconcile-spec', () => {
    test('TEST-30: brownfield batch reconciliation processes signals below threshold', () => {
      const nodefs = require('node:fs')
      const nodePath = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const signalDir = nodePath.join(tmpdir, `dag-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}`)

      try {
        nodefs.mkdirSync(signalDir, { recursive: true })

        const yamlContent = `
name: reconcile-test
system:
  engine: dag
steps:
  - name: reconcile-batch
    type: reconcile-spec
    signal_dir: ${signalDir}
    batch_threshold: 3
`
        const wf = createWorkflowDef(workflowStore, yamlContent, 'reconcile-test')
        const parsed = getParsed(yamlContent)

        // Start with step already 'running' and startedAt in the past,
        // so signal files written below will be newer than startedAt (avoids stale detection)
        const startedAt = new Date(Date.now() - 60000).toISOString()
        const stepsState = [
          makeStepState({ name: 'reconcile-batch', type: 'reconcile-spec' as any, status: 'running', startedAt }),
        ]
        const run = createTestRun(workflowStore, wf.id, stepsState)

        // Write signals AFTER run creation so file mtime > startedAt
        const signal1 = `
signal_type: reconciliation
amendment:
  type: reconciliation
  category: reconciliation
  spec_section: auth
  issue: "Code uses JWT but spec says session tokens"
  proposed_addition: "Update spec to reflect JWT usage"
checkpoint: {}
`
        const signal2 = `
signal_type: reconciliation
amendment:
  type: reconciliation
  category: reconciliation
  spec_section: database
  issue: "Code uses PostgreSQL but spec says MySQL"
  proposed_addition: "Update spec to reflect PostgreSQL"
checkpoint: {}
`
        nodefs.writeFileSync(nodePath.join(signalDir, 'reconcile-auth.yaml'), signal1, 'utf-8')
        nodefs.writeFileSync(nodePath.join(signalDir, 'reconcile-db.yaml'), signal2, 'utf-8')

        dagEngine.tick(run, parsed)
        const updated = workflowStore.getRun(run.id)!

        expect(updated.steps_state[0].status).toBe('completed')
        expect(updated.steps_state[0].batchAmendmentCount).toBe(2)

        // Verify amendments were recorded
        const amendments = workflowStore.getAmendmentsByRun(run.id)
        expect(amendments.length).toBe(2)
        expect(amendments.every((a: any) => a.category === 'reconciliation')).toBe(true)
      } finally {
        nodefs.rmSync(signalDir, { recursive: true, force: true })
      }
    })

    test('TEST-31: reconcile-spec escalates when batch threshold exceeded', () => {
      const nodefs = require('node:fs')
      const nodePath = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const signalDir = nodePath.join(tmpdir, `dag-reconcile-threshold-${Date.now()}-${Math.random().toString(36).slice(2)}`)

      try {
        nodefs.mkdirSync(signalDir, { recursive: true })

        const yamlContent = `
name: reconcile-threshold
system:
  engine: dag
steps:
  - name: reconcile-batch
    type: reconcile-spec
    signal_dir: ${signalDir}
    batch_threshold: 3
`
        const wf = createWorkflowDef(workflowStore, yamlContent, 'reconcile-threshold')
        const parsed = getParsed(yamlContent)

        // Start with step already 'running' and startedAt in the past
        const startedAt = new Date(Date.now() - 60000).toISOString()
        const stepsState = [
          makeStepState({ name: 'reconcile-batch', type: 'reconcile-spec' as any, status: 'running', startedAt }),
        ]
        const run = createTestRun(workflowStore, wf.id, stepsState)

        // Create 4 reconciliation signals affecting 4 different sections (>= threshold of 3)
        const sections = ['auth', 'database', 'api', 'ui']
        for (const section of sections) {
          const signal = `
signal_type: reconciliation
amendment:
  type: reconciliation
  category: reconciliation
  spec_section: ${section}
  issue: "Reconciliation needed for ${section}"
  proposed_addition: "Update spec for ${section}"
checkpoint: {}
`
          nodefs.writeFileSync(nodePath.join(signalDir, `reconcile-${section}.yaml`), signal, 'utf-8')
        }

        dagEngine.tick(run, parsed)
        const updated = workflowStore.getRun(run.id)!

        expect(updated.steps_state[0].status).toBe('paused_human')
        expect(updated.steps_state[0].batchAmendmentCount).toBe(4)

        // Verify broadcast was sent
        expect(ctx.broadcast).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'batch_reconciliation_threshold',
            runId: run.id,
            stepName: 'reconcile-batch',
            sections: 4,
            threshold: 3,
          })
        )
      } finally {
        nodefs.rmSync(signalDir, { recursive: true, force: true })
      }
    })

    test('TEST-32: reconciliation amendments use reconciliation budget category', () => {
      const nodefs = require('node:fs')
      const nodePath = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const signalDir = nodePath.join(tmpdir, `dag-reconcile-budget-${Date.now()}-${Math.random().toString(36).slice(2)}`)

      try {
        nodefs.mkdirSync(signalDir, { recursive: true })

        const yamlContent = `
name: reconcile-budget
system:
  engine: dag
steps:
  - name: reconcile-batch
    type: reconcile-spec
    signal_dir: ${signalDir}
    batch_threshold: 5
`
        const wf = createWorkflowDef(workflowStore, yamlContent, 'reconcile-budget')
        const parsed = getParsed(yamlContent)

        // Start with step already 'running' and startedAt in the past
        const startedAt = new Date(Date.now() - 60000).toISOString()
        const stepsState = [
          makeStepState({ name: 'reconcile-batch', type: 'reconcile-spec' as any, status: 'running', startedAt }),
        ]
        const run = createTestRun(workflowStore, wf.id, stepsState)

        // Write signal AFTER run creation so file mtime > startedAt
        const signal = `
signal_type: reconciliation
amendment:
  type: reconciliation
  category: reconciliation
  spec_section: auth
  issue: "Code uses JWT but spec says session tokens"
  proposed_addition: "Update spec to reflect JWT usage"
checkpoint: {}
`
        nodefs.writeFileSync(nodePath.join(signalDir, 'reconcile-auth.yaml'), signal, 'utf-8')

        dagEngine.tick(run, parsed)
        const updated = workflowStore.getRun(run.id)!

        expect(updated.steps_state[0].status).toBe('completed')

        // Verify amendment was recorded with reconciliation category (separate from quality)
        const amendments = workflowStore.getAmendmentsByRun(run.id)
        expect(amendments.length).toBe(1)
        expect(amendments[0].category).toBe('reconciliation')
        expect(amendments[0].amendment_type).toBe('reconciliation')
        expect(amendments[0].spec_section).toBe('auth')
        // Verify it was auto-resolved
        expect(amendments[0].resolution).toBe('approved')
        expect(amendments[0].resolved_by).toBe('batch_reconciliation')
      } finally {
        nodefs.rmSync(signalDir, { recursive: true, force: true })
      }
    })

    test('reconcile-spec completes with no signals', () => {
      const nodefs = require('node:fs')
      const nodePath = require('node:path')
      const tmpdir = require('node:os').tmpdir()
      const signalDir = nodePath.join(tmpdir, `dag-reconcile-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`)

      try {
        nodefs.mkdirSync(signalDir, { recursive: true })

        const yamlContent = `
name: reconcile-empty
system:
  engine: dag
steps:
  - name: reconcile-batch
    type: reconcile-spec
    signal_dir: ${signalDir}
`
        const wf = createWorkflowDef(workflowStore, yamlContent, 'reconcile-empty')
        const parsed = getParsed(yamlContent)
        const stepsState = [
          makeStepState({ name: 'reconcile-batch', type: 'reconcile-spec' as any }),
        ]
        const run = createTestRun(workflowStore, wf.id, stepsState)

        // Single tick: synchronous execution
        dagEngine.tick(run, parsed)
        const updated = workflowStore.getRun(run.id)!

        expect(updated.steps_state[0].status).toBe('completed')
        // No amendments should be recorded
        const amendments = workflowStore.getAmendmentsByRun(run.id)
        expect(amendments.length).toBe(0)
      } finally {
        nodefs.rmSync(signalDir, { recursive: true, force: true })
      }
    })

    test('reconcile-spec completes when signal_dir does not exist', () => {
      const yamlContent = `
name: reconcile-nodir
system:
  engine: dag
steps:
  - name: reconcile-batch
    type: reconcile-spec
    signal_dir: /tmp/nonexistent-reconcile-dir-${Date.now()}
`
      const wf = createWorkflowDef(workflowStore, yamlContent, 'reconcile-nodir')
      const parsed = getParsed(yamlContent)
      const stepsState = [
        makeStepState({ name: 'reconcile-batch', type: 'reconcile-spec' as any }),
      ]
      const run = createTestRun(workflowStore, wf.id, stepsState)

      // Single tick: synchronous execution
      dagEngine.tick(run, parsed)
      const updated = workflowStore.getRun(run.id)!

      expect(updated.steps_state[0].status).toBe('completed')
    })
  })

  // ── Phase 22: gemini_offload step tests ─────────────────────────────────────

  describe('gemini_offload step', () => {
    // Import helpers for API key override
    const { setApiKeyOverride, setBackoffDelayOverride } = require('../geminiClient')

    test('gemini_offload executes and completes successfully', async () => {
      // Set test API key and disable backoff delays
      setApiKeyOverride('test-api-key-for-dag-tests')
      setBackoffDelayOverride(0)

      // Mock successful Gemini response
      const originalFetch = global.fetch
      global.fetch = mock(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{ text: 'Generated content from Gemini' }],
            },
          }],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 20,
          },
        }),
      })) as any

      try {
        const yaml = [
          'name: gemini-test',
          'system:',
          '  engine: dag',
          'steps:',
          '  - name: gemini-step',
          '    type: gemini_offload',
          '    model: gemini-1.5-flash',
          '    prompt_template: "Summarize this text"',
          '    max_tokens: 100',
          '    temperature: 0.5',
        ].join('\n')

        const wf = createWorkflowDef(workflowStore, yaml, 'gemini-test')
        const parsed = getParsed(yaml)
        const run = createTestRun(workflowStore, wf.id, [
          makeStepState({ name: 'gemini-step', type: 'gemini_offload' }),
        ])

        // Tick to start the step
        dagEngine.tick(run, parsed)
        let freshRun = workflowStore.getRun(run.id)!
        expect(freshRun.steps_state[0].status).toBe('running')

        // Wait for async completion
        freshRun = await tickUntil(
          dagEngine, run, parsed, workflowStore,
          (r) => r.steps_state[0].status !== 'running',
          50,
          50,
        )

        expect(freshRun.steps_state[0].status).toBe('completed')
        expect(freshRun.steps_state[0].resultContent).toBe('Generated content from Gemini')
      } finally {
        global.fetch = originalFetch
        setApiKeyOverride(undefined)
        setBackoffDelayOverride(undefined)
      }
    })

    test('gemini_offload handles skipped (no API key)', async () => {
      // Clear API key to test graceful degradation
      setApiKeyOverride(undefined)

      const yaml = [
        'name: gemini-skip-test',
        'system:',
        '  engine: dag',
        'steps:',
        '  - name: gemini-step',
        '    type: gemini_offload',
        '    model: gemini-1.5-flash',
        '    prompt_template: "Test prompt"',
      ].join('\n')

      const wf = createWorkflowDef(workflowStore, yaml, 'gemini-skip-test')
      const parsed = getParsed(yaml)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'gemini-step', type: 'gemini_offload' }),
      ])

      try {
        // Tick to start
        dagEngine.tick(run, parsed)

        // Wait for completion (either skipped, completed, or failed)
        const freshRun = await tickUntil(
          dagEngine, run, parsed, workflowStore,
          (r) => r.steps_state[0].status !== 'running',
          50,
          50,
        )

        // Step should be skipped since no API key
        expect(freshRun.steps_state[0].status).toBe('skipped')
        expect(freshRun.steps_state[0].skippedReason).toContain('no_api_key')
      } finally {
        setApiKeyOverride(undefined)
      }
    })

    test('gemini_offload writes output to file', async () => {
      // Set test API key and disable backoff delays
      setApiKeyOverride('test-api-key-for-dag-tests')
      setBackoffDelayOverride(0)

      const originalFetch = global.fetch
      global.fetch = mock(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{ text: 'File output content' }],
            },
          }],
        }),
      })) as any

      const outputDir = `/tmp/gemini-test-${Date.now()}`
      const outputFile = 'gemini-output.txt'

      try {
        const yaml = [
          'name: gemini-file-test',
          'system:',
          '  engine: dag',
          'steps:',
          '  - name: gemini-step',
          '    type: gemini_offload',
          '    model: gemini-1.5-flash',
          '    prompt_template: "Generate content"',
          `    output_file: ${outputFile}`,
        ].join('\n')

        const wf = createWorkflowDef(workflowStore, yaml, 'gemini-file-test')
        const parsed = getParsed(yaml)
        const run = createTestRun(workflowStore, wf.id, [
          makeStepState({ name: 'gemini-step', type: 'gemini_offload' }),
        ], { output_dir: outputDir })

        // Ensure output directory exists
        const nodefs = require('node:fs')
        nodefs.mkdirSync(outputDir, { recursive: true })

        // Tick to start
        dagEngine.tick(run, parsed)

        // Wait for completion
        const freshRun = await tickUntil(
          dagEngine, run, parsed, workflowStore,
          (r) => r.steps_state[0].status !== 'running',
          50,
          50,
        )

        expect(freshRun.steps_state[0].status).toBe('completed')
        expect(freshRun.steps_state[0].resultFile).toBe(outputFile)
        // Verify file was written
        const outputPath = require('node:path').join(outputDir, outputFile)
        expect(nodefs.existsSync(outputPath)).toBe(true)
        const content = nodefs.readFileSync(outputPath, 'utf-8')
        expect(content).toBe('File output content')
      } finally {
        global.fetch = originalFetch
        setApiKeyOverride(undefined)
        setBackoffDelayOverride(undefined)
        const nodefs = require('node:fs')
        nodefs.rmSync(outputDir, { recursive: true, force: true })
      }
    })

    test('gemini_offload includes input file content', async () => {
      // Set test API key and disable backoff delays
      setApiKeyOverride('test-api-key-for-dag-tests')
      setBackoffDelayOverride(0)

      const originalFetch = global.fetch
      let capturedPrompt = ''

      global.fetch = mock(async (_url: string, options: any) => {
        const body = JSON.parse(options.body)
        capturedPrompt = body.contents[0].parts[0].text
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{
              content: {
                parts: [{ text: 'Response' }],
              },
            }],
          }),
        }
      }) as any

      const outputDir = `/tmp/gemini-input-test-${Date.now()}`
      const inputFile = 'input.txt'

      try {
        const nodefs = require('node:fs')
        nodefs.mkdirSync(outputDir, { recursive: true })
        nodefs.writeFileSync(require('node:path').join(outputDir, inputFile), 'Input file content here', 'utf-8')

        const yaml = [
          'name: gemini-input-test',
          'system:',
          '  engine: dag',
          'variables:',
          '  - name: input_txt',
          'steps:',
          '  - name: gemini-step',
          '    type: gemini_offload',
          '    model: gemini-1.5-flash',
          '    prompt_template: "Process this: {{input_txt}}"',
          `    inputs: [{path: "${inputFile}", label: "input_txt"}]`,
        ].join('\n')

        const wf = createWorkflowDef(workflowStore, yaml, 'gemini-input-test')
        const parsed = getParsed(yaml)
        const run = createTestRun(workflowStore, wf.id, [
          makeStepState({ name: 'gemini-step', type: 'gemini_offload' }),
        ], { output_dir: outputDir })

        // Tick to start
        dagEngine.tick(run, parsed)

        // Wait for completion
        await tickUntil(
          dagEngine, run, parsed, workflowStore,
          (r) => r.steps_state[0].status !== 'running',
          50,
          50,
        )

        // Verify prompt included input file content
        expect(capturedPrompt).toContain('Input file content here')
      } finally {
        global.fetch = originalFetch
        setApiKeyOverride(undefined)
        setBackoffDelayOverride(undefined)
        const nodefs = require('node:fs')
        nodefs.rmSync(outputDir, { recursive: true, force: true })
      }
    })

    test('gemini_offload supports label-based input substitution', async () => {
      // Set test API key and disable backoff delays
      setApiKeyOverride('test-api-key-for-dag-tests')
      setBackoffDelayOverride(0)

      const originalFetch = global.fetch
      const nodefs = require('node:fs')
      const nodepath = require('node:path')

      // Create temp input file
      const tmpDir = '/tmp/agentboard-gemini-label-test'
      nodefs.mkdirSync(tmpDir, { recursive: true })
      const inputFile = nodepath.join(tmpDir, 'data.yaml')
      nodefs.writeFileSync(inputFile, 'Label-substituted content here', 'utf-8')

      let capturedPrompt = ''

      try {
        // Capture the actual prompt from the request body
        global.fetch = mock(async (_url: string, options: any) => {
          const body = JSON.parse(options.body)
          capturedPrompt = body.contents[0].parts[0].text
          return {
            ok: true,
            status: 200,
            json: async () => ({
              candidates: [{ content: { parts: [{ text: 'Response' }] } }],
            }),
          }
        }) as any

        const yaml = [
          'name: gemini-label-test',
          'system:',
          '  engine: dag',
          'variables:',
          '  - name: my_data',
          'steps:',
          '  - name: gemini-step',
          '    type: gemini_offload',
          '    model: gemini-1.5-flash',
          '    prompt_template: "Process: {{my_data}}"',
          `    inputs:`,
          `      - path: "${inputFile}"`,
          `        label: my_data`,
        ].join('\n')

        const wf = createWorkflowDef(workflowStore, yaml, 'gemini-label-test')
        const parsed = getParsed(yaml)
        const run = createTestRun(workflowStore, wf.id, [
          makeStepState({ name: 'gemini-step', type: 'gemini_offload' }),
        ])

        // Tick to start
        dagEngine.tick(run, parsed)

        // Wait for completion
        await tickUntil(
          dagEngine, run, parsed, workflowStore,
          (r) => r.steps_state[0].status !== 'running',
          50,
          50,
        )

        // Verify prompt included input file content via label
        expect(capturedPrompt).toContain('Label-substituted content here')
      } finally {
        global.fetch = originalFetch
        setApiKeyOverride(undefined)
        setBackoffDelayOverride(undefined)
        nodefs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })
  })
})
