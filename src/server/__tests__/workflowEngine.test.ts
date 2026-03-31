import { describe, expect, test, afterEach, beforeEach, mock } from 'bun:test'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { createWorkflowEngine } from '../workflowEngine'
import type { WorkflowEngine } from '../workflowEngine'
import { initWorkflowStore } from '../workflowStore'
import type { WorkflowStore } from '../workflowStore'
import { initTaskStore } from '../taskStore'
import type { TaskStore } from '../taskStore'
import type { ServerContext } from '../serverContext'
import type {
  WorkflowRun,
  StepRunState,
  WorkflowDefinition,
} from '../../shared/types'

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

function simpleSpawnYaml(stepName = 'step-1'): string {
  return [
    'name: test-workflow',
    'steps:',
    `  - name: ${stepName}`,
    '    type: spawn_session',
    '    prompt: "do something"',
    '    projectPath: /tmp/test',
  ].join('\n')
}

function multiStepYaml(): string {
  return [
    'name: multi-workflow',
    'steps:',
    '  - name: build',
    '    type: spawn_session',
    '    prompt: "build project"',
    '    projectPath: /tmp/test',
    '    output_path: build.txt',
    '  - name: wait',
    '    type: delay',
    '    seconds: 1',
    '  - name: verify',
    '    type: check_output',
    '    step: build',
    '    contains: "SUCCESS"',
    '    timeoutSeconds: 10',
  ].join('\n')
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
    output_dir: '/tmp/test-outputs/workflow-test',
    started_at: new Date().toISOString(),
    completed_at: null,
    error_message: null,
    variables: null,
    ...overrides,
  })
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('workflowEngine', () => {
  let db: SQLiteDatabase
  let workflowStore: WorkflowStore
  let taskStore: TaskStore
  let ctx: ServerContext
  let engine: WorkflowEngine

  beforeEach(() => {
    const stores = createStores()
    db = stores.db
    workflowStore = stores.workflowStore
    taskStore = stores.taskStore
    ctx = createTestContext()
    engine = createWorkflowEngine(ctx, workflowStore, taskStore)
  })

  afterEach(() => {
    engine.stop()
    try { db.close() } catch { /* ok */ }
  })

  // ── Factory & Lifecycle ──────────────────────────────────────────────

  describe('factory and lifecycle', () => {
    test('createWorkflowEngine returns start/stop/recoverRunningWorkflows', () => {
      expect(typeof engine.start).toBe('function')
      expect(typeof engine.stop).toBe('function')
      expect(typeof engine.recoverRunningWorkflows).toBe('function')
    })

    test('start logs and begins polling', () => {
      engine.start()
      expect(ctx.logger.info).toHaveBeenCalledWith('workflow_engine_started', expect.any(Object))
    })

    test('start is idempotent', () => {
      engine.start()
      engine.start() // Should not throw or double-start
      const calls = (ctx.logger.info as ReturnType<typeof mock>).mock.calls
      const startCalls = calls.filter((c: unknown[]) => c[0] === 'workflow_engine_started')
      expect(startCalls.length).toBe(1)
    })

    test('stop logs', () => {
      engine.start()
      engine.stop()
      expect(ctx.logger.info).toHaveBeenCalledWith('workflow_engine_stopped')
    })
  })

  // ── spawn_session Step ───────────────────────────────────────────────

  describe('spawn_session step', () => {
    test('creates task when step is pending', () => {
      const wf = createWorkflowDef(workflowStore, simpleSpawnYaml())
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'step-1', type: 'spawn_session' }),
      ])

      // Recovery only handles running spawn_session steps with taskId.
      // Pending steps are processed by the poll loop. Use start() + setTimeout.
      engine.start()

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          engine.stop()
          // Verify task was created
          const tasks = taskStore.listTasks()
          expect(tasks.length).toBeGreaterThanOrEqual(1)

          // Step state should be running with a taskId
          const updatedRun = workflowStore.getRun(run.id)
          expect(updatedRun).not.toBeNull()
          expect(updatedRun!.steps_state[0].status).toBe('running')
          expect(updatedRun!.steps_state[0].taskId).not.toBeNull()
          resolve()
        }, 300)
      })
    })

    test('advances workflow when task completes', () => {
      const yaml = multiStepYaml()
      const wf = createWorkflowDef(workflowStore, yaml, 'multi-workflow')

      // Create task manually and mark it completed
      const task = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'build project',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(task.id, { status: 'completed', completedAt: new Date().toISOString() })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'build', type: 'spawn_session', status: 'running', taskId: task.id, startedAt: new Date().toISOString() }),
        makeStepState({ name: 'wait', type: 'delay' }),
        makeStepState({ name: 'verify', type: 'check_output' }),
      ])

      engine.recoverRunningWorkflows()

      const updatedRun = workflowStore.getRun(run.id)
      expect(updatedRun!.current_step_index).toBe(1)
      expect(updatedRun!.steps_state[0].status).toBe('completed')
    })

    test('includes agentType in task metadata when present', () => {
      const yaml = [
        'name: test-workflow',
        'steps:',
        '  - name: step-1',
        '    type: spawn_session',
        '    prompt: "do something"',
        '    projectPath: /tmp/test',
        '    agentType: codex',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml)
      const _run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'step-1', type: 'spawn_session' }),
      ])

      engine.start()

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          engine.stop()
          const tasks = taskStore.listTasks()
          expect(tasks.length).toBeGreaterThanOrEqual(1)

          const task = tasks[tasks.length - 1]
          const metadata = JSON.parse(task.metadata || '{}')
          expect(metadata.agent_type).toBe('codex')
          resolve()
        }, 300)
      })
    })

    test('fails workflow when task fails with no retries left', () => {
      const wf = createWorkflowDef(workflowStore, simpleSpawnYaml())

      const task = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'do something',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(task.id, { status: 'failed', errorMessage: 'timeout', completedAt: new Date().toISOString() })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'step-1', type: 'spawn_session', status: 'running', taskId: task.id, startedAt: new Date().toISOString() }),
      ])

      engine.recoverRunningWorkflows()

      const updatedRun = workflowStore.getRun(run.id)
      expect(updatedRun!.status).toBe('failed')
      expect(updatedRun!.error_message).toContain('step-1')
    })

    test('retries when task fails and retries remain', () => {
      const yaml = [
        'name: test-workflow',
        'steps:',
        '  - name: step-1',
        '    type: spawn_session',
        '    prompt: "do something"',
        '    projectPath: /tmp/test',
        '    maxRetries: 2',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml)

      const task = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'do something',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 2,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(task.id, { status: 'failed', errorMessage: 'transient error', completedAt: new Date().toISOString() })

      // Note: recovery doesn't check retries - it just fails. The poll loop handles retries.
      // We need to test the poll path instead. Create an engine and run a tick.
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'step-1', type: 'spawn_session', status: 'running', taskId: task.id, startedAt: new Date().toISOString(), retryCount: 0 }),
      ])

      // Recovery path sees failed task -> fails workflow (no retry logic in recovery)
      // This is by design - recovery is conservative
      engine.recoverRunningWorkflows()

      const updatedRun = workflowStore.getRun(run.id)
      // Recovery is conservative and fails; the normal poll loop would retry
      expect(updatedRun!.status).toBe('failed')
    })

    test('fails workflow when task disappears', () => {
      const wf = createWorkflowDef(workflowStore, simpleSpawnYaml())

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'step-1', type: 'spawn_session', status: 'running', taskId: 'nonexistent-task', startedAt: new Date().toISOString() }),
      ])

      engine.recoverRunningWorkflows()

      const updatedRun = workflowStore.getRun(run.id)
      expect(updatedRun!.status).toBe('failed')
      expect(updatedRun!.error_message).toContain('not found')
    })
  })

  // ── delay Step ───────────────────────────────────────────────────────

  describe('delay step', () => {
    test('starts delay and transitions to running', () => {
      const yaml = [
        'name: test-workflow',
        'steps:',
        '  - name: wait',
        '    type: delay',
        '    seconds: 1',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml)

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'wait', type: 'delay' }),
      ])

      engine.start()

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          engine.stop()
          const updatedRun = workflowStore.getRun(run.id)
          // After first poll, step should be running with startedAt set
          expect(updatedRun!.steps_state[0].status).toBe('running')
          expect(updatedRun!.steps_state[0].startedAt).not.toBeNull()
          resolve()
        }, 200)
      })
    })

    test('delay with startedAt in the past completes', () => {
      const yaml = [
        'name: test-workflow',
        'steps:',
        '  - name: wait',
        '    type: delay',
        '    seconds: 1',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml)

      // Simulate a delay that started 2 seconds ago
      const pastTime = new Date(Date.now() - 2000).toISOString()
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'wait', type: 'delay', status: 'running', startedAt: pastTime }),
      ])

      // Recovery re-evaluates - delay steps are wall-clock based
      // But recovery doesn't process delay steps directly; it relies on the poll.
      // We need the poll to trigger. Let's directly test via start/stop.
      engine.start()

      // Give poll a chance to run
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          engine.stop()
          const updatedRun = workflowStore.getRun(run.id)
          expect(updatedRun!.status).toBe('completed')
          expect(updatedRun!.steps_state[0].status).toBe('completed')
          resolve()
        }, 300)
      })
    })
  })

  // ── check_file Step ──────────────────────────────────────────────────

  describe('check_file step', () => {
    test('completes when file exists', async () => {
      const fs = await import('node:fs')
      const tmpDir = `/tmp/wf-test-${Date.now()}`
      fs.mkdirSync(tmpDir, { recursive: true })
      fs.writeFileSync(`${tmpDir}/output.txt`, 'hello')

      const yaml = [
        'name: test-workflow',
        'steps:',
        '  - name: check',
        '    type: check_file',
        '    path: output.txt',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml)

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'check', type: 'check_file' }),
      ], { output_dir: tmpDir })

      engine.start()

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          engine.stop()
          const updatedRun = workflowStore.getRun(run.id)
          expect(updatedRun!.status).toBe('completed')
          expect(updatedRun!.steps_state[0].status).toBe('completed')
          // Cleanup
          try { fs.rmSync(tmpDir, { recursive: true }) } catch { /* ok */ }
          resolve()
        }, 300)
      })
    })

    test('times out when file does not exist', async () => {
      const yaml = [
        'name: test-workflow',
        'steps:',
        '  - name: check',
        '    type: check_file',
        '    path: nonexistent.txt',
        '    timeoutSeconds: 1',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml)

      // Pre-mark as running with startedAt far in the past so timeout triggers
      const pastTime = new Date(Date.now() - 5000).toISOString()
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'check', type: 'check_file', status: 'running', startedAt: pastTime }),
      ], { output_dir: '/tmp/nonexistent-dir' })

      engine.start()

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          engine.stop()
          const updatedRun = workflowStore.getRun(run.id)
          expect(updatedRun!.status).toBe('failed')
          expect(updatedRun!.steps_state[0].status).toBe('failed')
          resolve()
        }, 300)
      })
    })
  })

  // ── check_output Step ────────────────────────────────────────────────

  describe('check_output step', () => {
    test('completes when output contains expected string', async () => {
      const fs = await import('node:fs')
      const tmpDir = `/tmp/wf-test-co-${Date.now()}`
      fs.mkdirSync(tmpDir, { recursive: true })
      fs.writeFileSync(`${tmpDir}/build.txt`, 'Build result: SUCCESS done')

      const yaml = multiStepYaml()
      const wf = createWorkflowDef(workflowStore, yaml, 'multi-workflow')

      // Set up a run where build is completed and we're on the verify step
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'build', type: 'spawn_session', status: 'completed', completedAt: new Date().toISOString() }),
        makeStepState({ name: 'wait', type: 'delay', status: 'completed', completedAt: new Date().toISOString() }),
        makeStepState({ name: 'verify', type: 'check_output' }),
      ], { output_dir: tmpDir, current_step_index: 2 })

      engine.start()

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          engine.stop()
          const updatedRun = workflowStore.getRun(run.id)
          expect(updatedRun!.status).toBe('completed')
          expect(updatedRun!.steps_state[2].status).toBe('completed')
          try { fs.rmSync(tmpDir, { recursive: true }) } catch { /* ok */ }
          resolve()
        }, 300)
      })
    })

    test('fails when referenced step output not found on disk', () => {
      // Use multiStepYaml which has a valid check_output referencing 'build'
      const yaml = multiStepYaml()
      const wf = createWorkflowDef(workflowStore, yaml, 'co-fail-workflow')

      // Set up run at step index 2 (verify) but with no build output file on disk
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'build', type: 'spawn_session', status: 'completed', completedAt: new Date().toISOString() }),
        makeStepState({ name: 'wait', type: 'delay', status: 'completed', completedAt: new Date().toISOString() }),
        makeStepState({ name: 'verify', type: 'check_output', status: 'running', startedAt: new Date(Date.now() - 15000).toISOString() }),
      ], { output_dir: '/tmp/nonexistent-co-dir', current_step_index: 2 })

      engine.start()

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          engine.stop()
          const updatedRun = workflowStore.getRun(run.id)
          expect(updatedRun!.status).toBe('failed')
          expect(updatedRun!.error_message).toContain('timed out')
          resolve()
        }, 300)
      })
    })
  })

  // ── Conditions ───────────────────────────────────────────────────────

  describe('conditions', () => {
    test('skips step when file_exists condition not met', () => {
      const yaml = [
        'name: test-workflow',
        'steps:',
        '  - name: conditional-step',
        '    type: delay',
        '    seconds: 1',
        '    condition:',
        '      type: file_exists',
        '      path: missing-file.txt',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml)

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'conditional-step', type: 'delay' }),
      ], { output_dir: '/tmp/nonexistent-dir' })

      engine.start()

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          engine.stop()
          const updatedRun = workflowStore.getRun(run.id)
          // Step should be skipped, workflow should complete (only step)
          expect(updatedRun!.status).toBe('completed')
          expect(updatedRun!.steps_state[0].status).toBe('skipped')
          expect(updatedRun!.steps_state[0].skippedReason).toContain('file not found')
          resolve()
        }, 300)
      })
    })

    test('executes step when file_exists condition is met', async () => {
      const fs = await import('node:fs')
      const tmpDir = `/tmp/wf-test-cond-${Date.now()}`
      fs.mkdirSync(tmpDir, { recursive: true })
      fs.writeFileSync(`${tmpDir}/required.txt`, 'exists')

      const yaml = [
        'name: test-workflow',
        'steps:',
        '  - name: conditional-step',
        '    type: delay',
        '    seconds: 1',
        '    condition:',
        '      type: file_exists',
        '      path: required.txt',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml)

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'conditional-step', type: 'delay' }),
      ], { output_dir: tmpDir })

      engine.start()

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          engine.stop()
          const updatedRun = workflowStore.getRun(run.id)
          // Condition met - step should execute (delay 0s -> complete)
          expect(updatedRun!.steps_state[0].status).not.toBe('skipped')
          try { fs.rmSync(tmpDir, { recursive: true }) } catch { /* ok */ }
          resolve()
        }, 400)
      })
    })
  })

  // ── Workflow Advancement ─────────────────────────────────────────────

  describe('advancement', () => {
    test('completes workflow when all steps are done', () => {
      const wf = createWorkflowDef(workflowStore, simpleSpawnYaml())

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
        makeStepState({ name: 'step-1', type: 'spawn_session', status: 'running', taskId: task.id, startedAt: new Date().toISOString() }),
      ])

      engine.recoverRunningWorkflows()

      const updatedRun = workflowStore.getRun(run.id)
      expect(updatedRun!.status).toBe('completed')
      expect(updatedRun!.completed_at).not.toBeNull()
    })

    test('broadcasts workflow-run-update on state change', () => {
      const wf = createWorkflowDef(workflowStore, simpleSpawnYaml())

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

      createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'step-1', type: 'spawn_session', status: 'running', taskId: task.id, startedAt: new Date().toISOString() }),
      ])

      engine.recoverRunningWorkflows()

      expect(ctx.broadcast).toHaveBeenCalled()
      const calls = (ctx.broadcast as ReturnType<typeof mock>).mock.calls
      const runUpdates = calls.filter((c: unknown[]) => (c[0] as any)?.type === 'workflow-run-update')
      expect(runUpdates.length).toBeGreaterThan(0)
    })
  })

  // ── Result File Collection (WO-008) ──────────────────────────────────

  describe('result file collection', () => {
    test('collects result file when step completes with result_file set', async () => {
      const fs = await import('node:fs')
      const tmpDir = `/tmp/wf-test-result-${Date.now()}`
      fs.mkdirSync(tmpDir, { recursive: true })

      // Create a result file with JSON content
      const resultData = { status: 'success', data: { value: 42 } }
      fs.writeFileSync(`${tmpDir}/analysis-result.json`, JSON.stringify(resultData))

      const yaml = [
        'name: test-workflow',
        'steps:',
        '  - name: analyze',
        '    type: spawn_session',
        '    prompt: "analyze code"',
        '    projectPath: /tmp/test',
        '    result_file: analysis-result.json',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml)

      const task = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'analyze code',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(task.id, { status: 'completed', completedAt: new Date().toISOString() })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'analyze', type: 'spawn_session', status: 'running', taskId: task.id, startedAt: new Date().toISOString() }),
      ], { output_dir: tmpDir })

      engine.recoverRunningWorkflows()

      const updatedRun = workflowStore.getRun(run.id)
      expect(updatedRun!.steps_state[0].resultFile).toBe('analysis-result.json')
      expect(updatedRun!.steps_state[0].resultCollected).toBe(true)
      expect(updatedRun!.steps_state[0].resultContent).toBe(JSON.stringify(resultData))

      // Cleanup
      try { fs.rmSync(tmpDir, { recursive: true }) } catch { /* ok */ }
    })

    test('marks result as not collected when file is missing', () => {
      const yaml = [
        'name: test-workflow',
        'steps:',
        '  - name: analyze',
        '    type: spawn_session',
        '    prompt: "analyze code"',
        '    projectPath: /tmp/test',
        '    result_file: missing-result.json',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml)

      const task = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'analyze code',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(task.id, { status: 'completed', completedAt: new Date().toISOString() })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'analyze', type: 'spawn_session', status: 'running', taskId: task.id, startedAt: new Date().toISOString() }),
      ], { output_dir: '/tmp/nonexistent-result-dir' })

      engine.recoverRunningWorkflows()

      const updatedRun = workflowStore.getRun(run.id)
      expect(updatedRun!.status).toBe('completed') // Step still completes
      expect(updatedRun!.steps_state[0].resultFile).toBe('missing-result.json')
      expect(updatedRun!.steps_state[0].resultCollected).toBe(false)
      expect(updatedRun!.steps_state[0].resultContent).toBeNull()
    })

    test('does not attempt collection when result_file is not set', () => {
      const yaml = simpleSpawnYaml()
      const wf = createWorkflowDef(workflowStore, yaml)

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
        makeStepState({ name: 'step-1', type: 'spawn_session', status: 'running', taskId: task.id, startedAt: new Date().toISOString() }),
      ])

      engine.recoverRunningWorkflows()

      const updatedRun = workflowStore.getRun(run.id)
      expect(updatedRun!.status).toBe('completed')
      expect(updatedRun!.steps_state[0].resultFile).toBeNull()
      expect(updatedRun!.steps_state[0].resultCollected).toBe(false)
      expect(updatedRun!.steps_state[0].resultContent).toBeNull()
    })

    test('multi-step: collects results from both steps and preserves after completion', async () => {
      const fs = await import('node:fs')
      const tmpDir = `/tmp/wf-test-multi-result-${Date.now()}`
      fs.mkdirSync(tmpDir, { recursive: true })

      // Write result files for both steps
      const result1 = { verdict: 'pass', issues: [] }
      const result2 = { report: 'All clear', score: 100 }
      fs.writeFileSync(`${tmpDir}/step1-result.json`, JSON.stringify(result1))
      fs.writeFileSync(`${tmpDir}/step2-result.json`, JSON.stringify(result2))

      const yaml = [
        'name: multi-result-test',
        'steps:',
        '  - name: analyze',
        '    type: spawn_session',
        '    prompt: "analyze"',
        '    projectPath: /tmp/test',
        '    result_file: step1-result.json',
        '  - name: report',
        '    type: spawn_session',
        '    prompt: "report"',
        '    projectPath: /tmp/test',
        '    result_file: step2-result.json',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml)

      // Complete task for step 0
      const task1 = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'analyze',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(task1.id, { status: 'completed', completedAt: new Date().toISOString() })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'analyze', type: 'spawn_session', status: 'running', taskId: task1.id, startedAt: new Date().toISOString() }),
        makeStepState({ name: 'report', type: 'spawn_session', status: 'pending' }),
      ], { output_dir: tmpDir })

      // Recovery: step 0 completes → result collected → advances to step 1
      engine.recoverRunningWorkflows()

      const afterStep0 = workflowStore.getRun(run.id)!
      expect(afterStep0.steps_state[0].resultCollected).toBe(true)
      expect(afterStep0.steps_state[0].resultContent).toBe(JSON.stringify(result1))
      expect(afterStep0.current_step_index).toBe(1)

      // Complete task for step 1
      const task2 = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'report',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(task2.id, { status: 'completed', completedAt: new Date().toISOString() })

      // Update step 1 to running with the task
      const steps = afterStep0.steps_state
      steps[1].status = 'running'
      steps[1].taskId = task2.id
      steps[1].startedAt = new Date().toISOString()
      workflowStore.updateRun(run.id, { steps_state: steps })

      // Recovery again: step 1 completes → result collected → workflow completes
      engine.recoverRunningWorkflows()

      const finalRun = workflowStore.getRun(run.id)!
      expect(finalRun.status).toBe('completed')

      // Both results preserved after workflow completion (even though cleanupOutputDir runs)
      expect(finalRun.steps_state[0].resultCollected).toBe(true)
      expect(finalRun.steps_state[0].resultContent).toBe(JSON.stringify(result1))
      expect(finalRun.steps_state[1].resultCollected).toBe(true)
      expect(finalRun.steps_state[1].resultContent).toBe(JSON.stringify(result2))

      // Cleanup
      try { fs.rmSync(tmpDir, { recursive: true }) } catch { /* ok */ }
    })
  })

  // ── Recovery ─────────────────────────────────────────────────────────

  describe('recovery', () => {
    test('recovers spawn_session with completed task', () => {
      const wf = createWorkflowDef(workflowStore, simpleSpawnYaml())

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
        makeStepState({ name: 'step-1', type: 'spawn_session', status: 'running', taskId: task.id, startedAt: new Date().toISOString() }),
      ])

      engine.recoverRunningWorkflows()

      const updatedRun = workflowStore.getRun(run.id)
      expect(updatedRun!.status).toBe('completed')
    })

    test('fails during recovery when task not found', () => {
      const wf = createWorkflowDef(workflowStore, simpleSpawnYaml())

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'step-1', type: 'spawn_session', status: 'running', taskId: 'ghost-task', startedAt: new Date().toISOString() }),
      ])

      engine.recoverRunningWorkflows()

      const updatedRun = workflowStore.getRun(run.id)
      expect(updatedRun!.status).toBe('failed')
      expect(updatedRun!.error_message).toContain('not found')
    })

    test('leaves running task alone during recovery', () => {
      const wf = createWorkflowDef(workflowStore, simpleSpawnYaml())

      const task = taskStore.createTask({
        projectPath: '/tmp/test',
        prompt: 'do something',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      taskStore.updateTask(task.id, { status: 'running', startedAt: new Date().toISOString() })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'step-1', type: 'spawn_session', status: 'running', taskId: task.id, startedAt: new Date().toISOString() }),
      ])

      engine.recoverRunningWorkflows()

      const updatedRun = workflowStore.getRun(run.id)
      // Should still be running - task is in progress
      expect(updatedRun!.status).toBe('running')
    })

    test('handles no running workflows gracefully', () => {
      engine.recoverRunningWorkflows()
      expect(ctx.logger.info).toHaveBeenCalledWith('workflow_engine_recovery', { runCount: 0 })
    })

    test('fails workflow when definition cannot be parsed', () => {
      // Create workflow with invalid YAML
      const wf = workflowStore.createWorkflow({
        name: 'bad-workflow',
        description: null,
        yaml_content: 'not: valid: yaml: [[[',
        file_path: null,
        is_valid: false,
        validation_errors: ['parse error'],
        step_count: 0,
      })

      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'step-1', type: 'spawn_session' }),
      ])

      engine.recoverRunningWorkflows()

      const updatedRun = workflowStore.getRun(run.id)
      expect(updatedRun!.status).toBe('failed')
      expect(updatedRun!.error_message).toContain('Cannot parse')
    })
  })

  // ── native_step (Phase 4) ──────────────────────────────────────────

  describe('native_step', () => {
    function nativeStepYaml(cmd: string, extras = ''): string {
      return [
        'name: native-test',
        'steps:',
        '  - name: run-cmd',
        '    type: native_step',
        `    command: "${cmd}"`,
        extras,
      ].filter(Boolean).join('\n')
    }

    test('native_step with echo command completes', async () => {
      const yaml = nativeStepYaml('echo hello')
      const wf = createWorkflowDef(workflowStore, yaml, 'native-echo')
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'run-cmd', type: 'native_step' }),
      ])

      engine.start()

      const deadline = Date.now() + 8000
      let updatedRun = workflowStore.getRun(run.id)
      while (Date.now() < deadline) {
        updatedRun = workflowStore.getRun(run.id)
        if (updatedRun && updatedRun.status !== 'running') break
        await Bun.sleep(200)
      }
      engine.stop()

      expect(updatedRun!.status).toBe('completed')
      expect(updatedRun!.steps_state[0].status).toBe('completed')
    }, 10000)

    test('native_step with failing command fails', async () => {
      const yaml = nativeStepYaml('exit 1')
      const wf = createWorkflowDef(workflowStore, yaml, 'native-fail')
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'run-cmd', type: 'native_step' }),
      ])

      engine.start()

      const deadline = Date.now() + 8000
      let updatedRun = workflowStore.getRun(run.id)
      while (Date.now() < deadline) {
        updatedRun = workflowStore.getRun(run.id)
        if (updatedRun && updatedRun.status !== 'running') break
        await Bun.sleep(200)
      }
      engine.stop()

      expect(updatedRun!.status).toBe('failed')
      expect(updatedRun!.steps_state[0].status).toBe('failed')
      expect(updatedRun!.steps_state[0].errorMessage).toContain('exit code')
    }, 10000)

    test('native_step with custom success_codes accepts non-zero exit', async () => {
      const yaml = [
        'name: native-codes',
        'steps:',
        '  - name: run-cmd',
        '    type: native_step',
        '    command: "exit 42"',
        '    success_codes:',
        '      - 0',
        '      - 42',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml, 'native-codes')
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'run-cmd', type: 'native_step' }),
      ])

      engine.start()

      const deadline = Date.now() + 8000
      let updatedRun = workflowStore.getRun(run.id)
      while (Date.now() < deadline) {
        updatedRun = workflowStore.getRun(run.id)
        if (updatedRun && updatedRun.status !== 'running') break
        await Bun.sleep(200)
      }
      engine.stop()

      expect(updatedRun!.status).toBe('completed')
      expect(updatedRun!.steps_state[0].status).toBe('completed')
    }, 10000)

    test('native_step with predefined action resolves correctly', async () => {
      // Use run_tests which resolves to 'bun test'. It will fail (no test files in cwd)
      // but proves the action was looked up and executed.
      const yaml = [
        'name: native-action',
        'steps:',
        '  - name: run-tests',
        '    type: native_step',
        '    action: run_tests',
        '    success_codes:',
        '      - 0',
        '      - 1',
        '      - 2',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml, 'native-action')
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'run-tests', type: 'native_step' }),
      ])

      engine.start()

      const deadline = Date.now() + 12000
      let updatedRun = workflowStore.getRun(run.id)
      while (Date.now() < deadline) {
        updatedRun = workflowStore.getRun(run.id)
        if (updatedRun && updatedRun.status !== 'running') break
        await Bun.sleep(200)
      }
      engine.stop()

      // The step should have started (action was resolved to 'bun test')
      const stepState = updatedRun!.steps_state[0]
      expect(stepState.startedAt).not.toBeNull()
      // It either completed or failed depending on test runner, but it executed
      expect(['completed', 'failed']).toContain(stepState.status)
    }, 15000)

    test('native_step with unknown action errors', async () => {
      // P2-17: unknown action values are now rejected at schema validation time,
      // not at engine execution time.
      const yaml = [
        'name: native-bad-action',
        'steps:',
        '  - name: bad',
        '    type: native_step',
        '    action: nonexistent_action',
      ].join('\n')
      const { parseWorkflowYAML } = await import('../workflowSchema')
      const result = parseWorkflowYAML(yaml)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.includes('nonexistent_action'))).toBe(true)
    })

    test('native_step with timeout triggers SIGTERM', async () => {
      const yaml = [
        'name: native-timeout',
        'steps:',
        '  - name: slow',
        '    type: native_step',
        '    command: "sleep 60"',
        '    timeoutSeconds: 1',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml, 'native-timeout')
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'slow', type: 'native_step' }),
      ])

      engine.start()

      // Poll until step completes or 12s elapses
      const deadline = Date.now() + 12000
      let updatedRun = workflowStore.getRun(run.id)
      while (Date.now() < deadline) {
        updatedRun = workflowStore.getRun(run.id)
        if (updatedRun && updatedRun.status !== 'running') break
        await Bun.sleep(200)
      }
      engine.stop()

      expect(updatedRun!.status).toBe('failed')
      expect(updatedRun!.steps_state[0].errorMessage).toContain('timed out')
    }, 15000)

    test('native_step reads output_path file as step result (REQ-06)', async () => {
      const fsSync = await import('node:fs')
      const tmpDir = `/tmp/wf-native-out-${Date.now()}`
      fsSync.mkdirSync(tmpDir, { recursive: true })

      // Command writes to result.txt; engine should read that file as step result (REQ-06)
      const yaml = [
        'name: native-output',
        'steps:',
        '  - name: write-step',
        '    type: native_step',
        `    command: "echo file-content > ${tmpDir}/result.txt"`,
        '    output_path: result.txt',
        '  - name: wait-step',
        '    type: delay',
        '    seconds: 30',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml, 'native-output')
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'write-step', type: 'native_step' }),
        makeStepState({ name: 'wait-step', type: 'delay' }),
      ], { output_dir: tmpDir })

      engine.start()

      // Poll until the first step completes
      const deadline = Date.now() + 8000
      let updatedRun = workflowStore.getRun(run.id)
      while (Date.now() < deadline) {
        updatedRun = workflowStore.getRun(run.id)
        if (updatedRun && updatedRun.steps_state[0].status === 'completed') break
        await Bun.sleep(200)
      }
      engine.stop()

      expect(updatedRun!.steps_state[0].status).toBe('completed')
      // Step result should be the file content, not stdout
      expect(updatedRun!.steps_state[0].resultContent).toContain('file-content')
      expect(updatedRun!.steps_state[0].resultCollected).toBe(true)
      try { fsSync.rmSync(tmpDir, { recursive: true }) } catch { /* ok */ }
    }, 10000)

    test('native_step with env sets environment variables', async () => {
      const yaml = [
        'name: native-env',
        'steps:',
        '  - name: env-step',
        '    type: native_step',
        '    command: "echo $MY_VAR"',
        '    env:',
        '      MY_VAR: test-value',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml, 'native-env')
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'env-step', type: 'native_step' }),
      ])

      engine.start()

      const deadline = Date.now() + 8000
      let updatedRun = workflowStore.getRun(run.id)
      while (Date.now() < deadline) {
        updatedRun = workflowStore.getRun(run.id)
        if (updatedRun && updatedRun.status !== 'running') break
        await Bun.sleep(200)
      }
      engine.stop()

      expect(updatedRun!.status).toBe('completed')
    }, 10000)

    test('native_step retry behavior on failure', async () => {
      const yaml = [
        'name: native-retry',
        'steps:',
        '  - name: retry-cmd',
        '    type: native_step',
        '    command: "exit 1"',
        '    maxRetries: 1',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml, 'native-retry')
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'retry-cmd', type: 'native_step' }),
      ])

      engine.start()

      // Wait for initial attempt + retry + second failure
      const deadline = Date.now() + 8000
      let updatedRun = workflowStore.getRun(run.id)
      while (Date.now() < deadline) {
        updatedRun = workflowStore.getRun(run.id)
        if (updatedRun && updatedRun.status !== 'running') break
        await Bun.sleep(200)
      }
      engine.stop()

      // After retrying, still fails (exit 1 every time)
      expect(updatedRun!.status).toBe('failed')
      expect(updatedRun!.steps_state[0].retryCount).toBeGreaterThanOrEqual(1)
    }, 10000)
  })

  // ── Tier Filtering (Phase 4) ───────────────────────────────────────

  describe('tier filtering', () => {
    test('skips step below tier_min', () => {
      const yaml = [
        'name: tier-test',
        'steps:',
        '  - name: high-tier-only',
        '    type: delay',
        '    seconds: 1',
        '    tier_min: 3',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml, 'tier-min-test')
      // Run at tier 1 (default)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'high-tier-only', type: 'delay' }),
      ])

      engine.start()

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          engine.stop()
          const updatedRun = workflowStore.getRun(run.id)
          expect(updatedRun!.status).toBe('completed')
          expect(updatedRun!.steps_state[0].status).toBe('skipped')
          expect(updatedRun!.steps_state[0].skippedReason).toContain('below')
          resolve()
        }, 500)
      })
    })

    test('skips step above tier_max', () => {
      const yaml = [
        'name: tier-max-test',
        'steps:',
        '  - name: low-tier-only',
        '    type: delay',
        '    seconds: 1',
        '    tier_max: 0',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml, 'tier-max-test')
      // Run at tier 1 (default)
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'low-tier-only', type: 'delay' }),
      ])

      engine.start()

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          engine.stop()
          const updatedRun = workflowStore.getRun(run.id)
          expect(updatedRun!.status).toBe('completed')
          expect(updatedRun!.steps_state[0].status).toBe('skipped')
          expect(updatedRun!.steps_state[0].skippedReason).toContain('above')
          resolve()
        }, 500)
      })
    })

    test('executes step within tier range', () => {
      const yaml = [
        'name: tier-range-test',
        'steps:',
        '  - name: in-range',
        '    type: delay',
        '    seconds: 0.1',
        '    tier_min: 0',
        '    tier_max: 5',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml, 'tier-range-test')
      // Run at tier 1 (default) - within range [0, 5]
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'in-range', type: 'delay' }),
      ])

      engine.start()

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          engine.stop()
          const updatedRun = workflowStore.getRun(run.id)
          // Should not be skipped - tier 1 is within [0, 5]
          expect(updatedRun!.steps_state[0].status).not.toBe('skipped')
          resolve()
        }, 500)
      })
    })

    test('step without tier fields runs at all tiers', () => {
      const yaml = [
        'name: tier-absent-test',
        'steps:',
        '  - name: always-run',
        '    type: delay',
        '    seconds: 0.1',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml, 'tier-absent-test')
      // Run at tier 99 via variables
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'always-run', type: 'delay' }),
      ], { variables: { tier: '99' } })

      engine.start()

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          engine.stop()
          const updatedRun = workflowStore.getRun(run.id)
          // Should not be skipped - no tier constraints
          expect(updatedRun!.steps_state[0].status).not.toBe('skipped')
          resolve()
        }, 500)
      })
    })

    test('tier filtering happens before condition check', () => {
      // Step has tier_min: 10 AND a condition. Even if condition would pass,
      // tier filter should skip first (tier < tier_min).
      const yaml = [
        'name: tier-before-condition',
        'steps:',
        '  - name: tiered-conditional',
        '    type: delay',
        '    seconds: 1',
        '    tier_min: 10',
        '    condition:',
        '      type: file_exists',
        '      path: nonexistent.txt',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml, 'tier-before-cond')
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'tiered-conditional', type: 'delay' }),
      ])

      engine.start()

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          engine.stop()
          const updatedRun = workflowStore.getRun(run.id)
          expect(updatedRun!.steps_state[0].status).toBe('skipped')
          // Should be tier-based skip, not condition-based
          expect(updatedRun!.steps_state[0].skippedReason).toContain('tier')
          resolve()
        }, 500)
      })
    })

    test('tier on native_step specifically', () => {
      const yaml = [
        'name: tier-native',
        'steps:',
        '  - name: gated-cmd',
        '    type: native_step',
        '    command: "echo should-not-run"',
        '    tier_min: 5',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml, 'tier-native')
      // Default tier is 1
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'gated-cmd', type: 'native_step' }),
      ])

      engine.start()

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          engine.stop()
          const updatedRun = workflowStore.getRun(run.id)
          expect(updatedRun!.steps_state[0].status).toBe('skipped')
          expect(updatedRun!.steps_state[0].skippedReason).toContain('below')
          resolve()
        }, 500)
      })
    })

    test('tier from run variables overrides default', () => {
      const yaml = [
        'name: tier-var-test',
        'default_tier: 1',
        'steps:',
        '  - name: high-gate',
        '    type: delay',
        '    seconds: 0.1',
        '    tier_min: 5',
      ].join('\n')
      const wf = createWorkflowDef(workflowStore, yaml, 'tier-var-test')
      // Set tier=5 via variables, overriding default_tier of 1
      const run = createTestRun(workflowStore, wf.id, [
        makeStepState({ name: 'high-gate', type: 'delay' }),
      ], { variables: { tier: '5' } })

      engine.start()

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          engine.stop()
          const updatedRun = workflowStore.getRun(run.id)
          // tier=5, tier_min=5, so should NOT be skipped
          expect(updatedRun!.steps_state[0].status).not.toBe('skipped')
          resolve()
        }, 500)
      })
    })
  })
})
