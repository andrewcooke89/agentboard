// workflowWsHandlers.test.ts - Tests for WebSocket workflow handler functions
import { describe, it, expect, mock } from 'bun:test'
import { createWorkflowWsHandlers } from './workflowWsHandlers'
import type { WorkflowStoreAdapter, WorkflowEngineAdapter } from './workflowWsHandlers'
import type { ServerContext, WSData } from '../serverContext'
import type { ServerWebSocket } from 'bun'
import type { WorkflowDefinition, WorkflowRun, ServerMessage } from '../../shared/types'

// --- Test helpers ---

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'wf-001',
    name: 'Test Workflow',
    description: 'A test workflow',
    yaml_content: 'steps: []',
    file_path: '/tmp/test.yaml',
    is_valid: true,
    validation_errors: [],
    step_count: 2,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-001',
    workflow_id: 'wf-001',
    workflow_name: 'Test Workflow',
    status: 'running',
    current_step_index: 0,
    steps_state: [
      {
        name: 'step-1',
        type: 'spawn_session',
        status: 'running',
        taskId: null,
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: null,
        errorMessage: null,
        retryCount: 0,
        skippedReason: null,
        resultFile: null,
        resultCollected: false,
        resultContent: null,
      },
    ],
    output_dir: '/tmp/output',
    started_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    error_message: null,
    created_at: '2026-01-01T00:00:00Z',
    variables: null,
    ...overrides,
  } as WorkflowRun
}

function createMockContext() {
  const sent: { ws: 'target' | 'broadcast'; msg: ServerMessage }[] = []

  const ctx = {
    config: {
      workflowMaxConcurrentRuns: 5,
    },
    logger: {
      debug: mock(() => {}),
      info: mock(() => {}),
      error: mock(() => {}),
    },
    send: mock((ws: ServerWebSocket<WSData>, msg: ServerMessage) => {
      sent.push({ ws: 'target', msg })
    }),
    broadcast: mock((msg: ServerMessage) => {
      sent.push({ ws: 'broadcast', msg })
    }),
  } as unknown as ServerContext

  return { ctx, sent }
}

function createMockStore(overrides: Partial<WorkflowStoreAdapter> = {}): WorkflowStoreAdapter {
  return {
    listWorkflows: mock(() => []),
    getWorkflow: mock(() => null),
    listRuns: mock(() => []),
    listRunsByWorkflow: mock(() => []),
    getRun: mock(() => null),
    createRun: mock(() => makeRun()),
    updateRun: mock((_id: string, updates: Partial<WorkflowRun>) => makeRun(updates)),
    countActiveRuns: mock(() => 0),
    ...overrides,
  }
}

function createMockEngine(overrides: Partial<WorkflowEngineAdapter> = {}): WorkflowEngineAdapter {
  return {
    cancelRun: mock(() => {}),
    ...overrides,
  }
}

const mockWs = {} as ServerWebSocket<WSData>

// --- Tests ---

describe('workflowWsHandlers', () => {
  describe('handleWorkflowListRequest', () => {
    it('sends workflow-list with workflows from store', () => {
      const workflows = [makeWorkflow(), makeWorkflow({ id: 'wf-002', name: 'Second' })]
      const { ctx, sent } = createMockContext()
      const store = createMockStore({ listWorkflows: () => workflows })
      const handlers = createWorkflowWsHandlers(ctx, store, createMockEngine())

      handlers.handleWorkflowListRequest(mockWs, { type: 'workflow-list-request' })

      expect(sent).toHaveLength(1)
      expect(sent[0].ws).toBe('target')
      expect(sent[0].msg).toEqual({ type: 'workflow-list', workflows })
    })

    it('sends empty array on store error', () => {
      const { ctx, sent } = createMockContext()
      const store = createMockStore({
        listWorkflows: () => { throw new Error('DB error') },
      })
      const handlers = createWorkflowWsHandlers(ctx, store, createMockEngine())

      handlers.handleWorkflowListRequest(mockWs, { type: 'workflow-list-request' })

      expect(sent).toHaveLength(1)
      expect(sent[0].msg).toEqual({ type: 'workflow-list', workflows: [] })
      expect(ctx.logger.error).toHaveBeenCalled()
    })
  })

  describe('handleWorkflowRunListRequest', () => {
    it('sends all runs when no workflowId provided', () => {
      const runs = [makeRun()]
      const { ctx, sent } = createMockContext()
      const listRuns = mock(() => runs)
      const store = createMockStore({ listRuns })
      const handlers = createWorkflowWsHandlers(ctx, store, createMockEngine())

      handlers.handleWorkflowRunListRequest(mockWs, { type: 'workflow-run-list-request' })

      expect(sent).toHaveLength(1)
      expect(sent[0].msg).toEqual({ type: 'workflow-run-list', runs })
      expect(listRuns).toHaveBeenCalled()
    })

    it('sends filtered runs when workflowId provided', () => {
      const runs = [makeRun()]
      const { ctx, sent } = createMockContext()
      const listRunsByWorkflow = mock(() => runs)
      const store = createMockStore({ listRunsByWorkflow })
      const handlers = createWorkflowWsHandlers(ctx, store, createMockEngine())

      handlers.handleWorkflowRunListRequest(mockWs, {
        type: 'workflow-run-list-request',
        workflowId: 'wf-001',
      })

      expect(sent).toHaveLength(1)
      expect(sent[0].msg).toEqual({ type: 'workflow-run-list', runs })
      expect(listRunsByWorkflow).toHaveBeenCalledWith('wf-001')
    })

    it('sends empty array on store error', () => {
      const { ctx, sent } = createMockContext()
      const store = createMockStore({
        listRuns: () => { throw new Error('DB error') },
      })
      const handlers = createWorkflowWsHandlers(ctx, store, createMockEngine())

      handlers.handleWorkflowRunListRequest(mockWs, { type: 'workflow-run-list-request' })

      expect(sent).toHaveLength(1)
      expect(sent[0].msg).toEqual({ type: 'workflow-run-list', runs: [] })
    })
  })

  describe('handleWorkflowRun', () => {
    it('creates a run and broadcasts update', () => {
      const workflow = makeWorkflow()
      const run = makeRun()
      const { ctx, sent } = createMockContext()
      const store = createMockStore({
        getWorkflow: () => workflow,
        createRun: () => run,
        countActiveRuns: () => 0,
      })
      const handlers = createWorkflowWsHandlers(ctx, store, createMockEngine())

      handlers.handleWorkflowRun(mockWs, { type: 'workflow-run', workflowId: 'wf-001' })

      expect(sent).toHaveLength(1)
      expect(sent[0].ws).toBe('broadcast')
      expect(sent[0].msg).toEqual({ type: 'workflow-run-update', run })
      expect(ctx.logger.info).toHaveBeenCalled()
    })

    it('sends error when workflow not found', () => {
      const { ctx, sent } = createMockContext()
      const store = createMockStore({ getWorkflow: () => null })
      const handlers = createWorkflowWsHandlers(ctx, store, createMockEngine())

      handlers.handleWorkflowRun(mockWs, { type: 'workflow-run', workflowId: 'missing' })

      expect(sent).toHaveLength(1)
      expect(sent[0].ws).toBe('target')
      expect(sent[0].msg).toEqual({ type: 'error', message: 'Workflow not found: missing' })
    })

    it('sends error when workflow is invalid', () => {
      const { ctx, sent } = createMockContext()
      const store = createMockStore({
        getWorkflow: () => makeWorkflow({ is_valid: false, validation_errors: ['bad step'] }),
      })
      const handlers = createWorkflowWsHandlers(ctx, store, createMockEngine())

      handlers.handleWorkflowRun(mockWs, { type: 'workflow-run', workflowId: 'wf-001' })

      expect(sent).toHaveLength(1)
      expect(sent[0].msg).toEqual({ type: 'error', message: 'Workflow is invalid: bad step' })
    })

    it('sends error when concurrent run limit reached', () => {
      const { ctx, sent } = createMockContext()
      const store = createMockStore({
        getWorkflow: () => makeWorkflow(),
        countActiveRuns: () => 5,
      })
      const handlers = createWorkflowWsHandlers(ctx, store, createMockEngine())

      handlers.handleWorkflowRun(mockWs, { type: 'workflow-run', workflowId: 'wf-001' })

      expect(sent).toHaveLength(1)
      expect(sent[0].msg).toEqual({ type: 'error', message: 'Concurrent run limit reached' })
    })

    it('sends error on createRun failure', () => {
      const { ctx, sent } = createMockContext()
      const store = createMockStore({
        getWorkflow: () => makeWorkflow(),
        countActiveRuns: () => 0,
        createRun: () => { throw new Error('DB write failed') },
      })
      const handlers = createWorkflowWsHandlers(ctx, store, createMockEngine())

      handlers.handleWorkflowRun(mockWs, { type: 'workflow-run', workflowId: 'wf-001' })

      expect(sent).toHaveLength(1)
      expect(sent[0].ws).toBe('target')
      expect((sent[0].msg as any).message).toContain('Failed to create workflow run')
    })
  })

  describe('handleWorkflowRunResume', () => {
    it('resumes a failed run and broadcasts update', () => {
      const failedRun = makeRun({
        status: 'failed',
        steps_state: [{
          name: 'step-1',
          type: 'spawn_session',
          status: 'failed',
          taskId: null,
          startedAt: '2026-01-01T00:00:00Z',
          completedAt: '2026-01-01T00:01:00Z',
          errorMessage: 'timeout',
          retryCount: 1,
          resultFile: null,
          resultCollected: false,
          resultContent: null,
          skippedReason: null,
        }],
      })
      const { ctx, sent } = createMockContext()
      const updateRun = mock((_id: string, updates: Partial<WorkflowRun>) => makeRun({ ...failedRun, ...updates, status: 'running' }))
      const store = createMockStore({
        getRun: () => failedRun,
        updateRun,
      })
      const handlers = createWorkflowWsHandlers(ctx, store, createMockEngine())

      handlers.handleWorkflowRunResume(mockWs, { type: 'workflow-run-resume', runId: 'run-001' })

      expect(sent).toHaveLength(1)
      expect(sent[0].ws).toBe('broadcast')
      expect((sent[0].msg as any).type).toBe('workflow-run-update')
      expect(updateRun).toHaveBeenCalled()
      // Verify the step was reset to pending
      const updateCall = updateRun.mock.calls[0]!
      const updates = updateCall[1] as Partial<WorkflowRun>
      expect(updates.status).toBe('running')
      expect(updates.steps_state![0].status).toBe('pending')
      expect(updates.steps_state![0].errorMessage).toBeNull()
    })

    it('sends error when run not found', () => {
      const { ctx, sent } = createMockContext()
      const store = createMockStore({ getRun: () => null })
      const handlers = createWorkflowWsHandlers(ctx, store, createMockEngine())

      handlers.handleWorkflowRunResume(mockWs, { type: 'workflow-run-resume', runId: 'missing' })

      expect(sent).toHaveLength(1)
      expect(sent[0].msg).toEqual({ type: 'error', message: 'Workflow run not found: missing' })
    })

    it('sends error when run is not in failed state', () => {
      const { ctx, sent } = createMockContext()
      const store = createMockStore({
        getRun: () => makeRun({ status: 'running' }),
      })
      const handlers = createWorkflowWsHandlers(ctx, store, createMockEngine())

      handlers.handleWorkflowRunResume(mockWs, { type: 'workflow-run-resume', runId: 'run-001' })

      expect(sent).toHaveLength(1)
      expect(sent[0].msg).toEqual({
        type: 'error',
        message: 'Cannot resume run with status: running',
      })
    })
  })

  describe('handleWorkflowRunCancel', () => {
    it('cancels a running run and broadcasts update', () => {
      const run = makeRun({ status: 'running' })
      const { ctx, sent } = createMockContext()
      const engine = createMockEngine()
      const store = createMockStore({
        getRun: () => run,
        updateRun: (_id, updates) => makeRun({ ...run, ...updates }),
      })
      const handlers = createWorkflowWsHandlers(ctx, store, engine)

      handlers.handleWorkflowRunCancel(mockWs, { type: 'workflow-run-cancel', runId: 'run-001' })

      expect(engine.cancelRun).toHaveBeenCalledWith('run-001')
      expect(sent).toHaveLength(1)
      expect(sent[0].ws).toBe('broadcast')
      expect((sent[0].msg as any).type).toBe('workflow-run-update')
      expect(ctx.logger.info).toHaveBeenCalled()
    })

    it('sends error when run not found', () => {
      const { ctx, sent } = createMockContext()
      const store = createMockStore({ getRun: () => null })
      const handlers = createWorkflowWsHandlers(ctx, store, createMockEngine())

      handlers.handleWorkflowRunCancel(mockWs, { type: 'workflow-run-cancel', runId: 'missing' })

      expect(sent).toHaveLength(1)
      expect(sent[0].msg).toEqual({ type: 'error', message: 'Workflow run not found: missing' })
    })

    it('sends error when run is not running', () => {
      const { ctx, sent } = createMockContext()
      const store = createMockStore({
        getRun: () => makeRun({ status: 'completed' }),
      })
      const handlers = createWorkflowWsHandlers(ctx, store, createMockEngine())

      handlers.handleWorkflowRunCancel(mockWs, { type: 'workflow-run-cancel', runId: 'run-001' })

      expect(sent).toHaveLength(1)
      expect(sent[0].msg).toEqual({
        type: 'error',
        message: 'Cannot cancel run with status: completed',
      })
    })

    it('sends error on engine cancel failure', () => {
      const { ctx, sent } = createMockContext()
      const engine = createMockEngine({
        cancelRun: () => { throw new Error('Engine error') },
      })
      const store = createMockStore({
        getRun: () => makeRun({ status: 'running' }),
      })
      const handlers = createWorkflowWsHandlers(ctx, store, engine)

      handlers.handleWorkflowRunCancel(mockWs, { type: 'workflow-run-cancel', runId: 'run-001' })

      expect(sent).toHaveLength(1)
      expect(sent[0].ws).toBe('target')
      expect((sent[0].msg as any).message).toContain('Failed to cancel workflow run')
    })
  })
})
