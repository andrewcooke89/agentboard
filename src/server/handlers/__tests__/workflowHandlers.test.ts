// workflowHandlers.test.ts - Tests for REST API workflow endpoints (WO-007)
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { initWorkflowStore } from '../../workflowStore'
import type { WorkflowStore } from '../../workflowStore'
import { createWorkflowHandlers } from '../workflowHandlers'
import type { ServerContext } from '../../serverContext'
import type { ServerMessage, WorkflowDefinition, WorkflowRun, StepRunState } from '../../../shared/types'
import type { TaskStore } from '../../taskStore'

// ─── Test Helpers ─────────────────────────────────────────────────────────

const VALID_YAML = `name: test-flow
steps:
  - name: build
    type: spawn_session
    projectPath: /tmp/project
    prompt: "Run build"
  - name: verify
    type: check_file
    path: /tmp/project/dist/index.js
`

function createTestDb(): { db: SQLiteDatabase; workflowStore: WorkflowStore } {
  const db = new SQLiteDatabase(':memory:')
  // Create the tasks table so workflow store migration doesn't fail
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'queued'
  )`)
  const workflowStore = initWorkflowStore(db)
  return { db, workflowStore }
}

function createMockContext(workflowStore: WorkflowStore): {
  ctx: ServerContext
  broadcasts: ServerMessage[]
} {
  const broadcasts: ServerMessage[] = []
  const ctx = {
    workflowStore,
    config: {
      workflowDir: '/tmp/test-workflows',
      workflowMaxConcurrentRuns: 2,
      workflowEngineEnabled: true,
    },
    broadcast: (msg: ServerMessage) => {
      broadcasts.push(msg)
    },
    logger: {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    },
    taskStore: {
      getTask: () => null,
    } as unknown as TaskStore,
  } as unknown as ServerContext
  return { ctx, broadcasts }
}

function createApp(ctx: ServerContext): Hono {
  const app = new Hono()
  const handlers = createWorkflowHandlers(ctx)
  handlers.registerRoutes(app)
  return app
}

function makeWorkflow(store: WorkflowStore, overrides: Partial<Parameters<WorkflowStore['createWorkflow']>[0]> = {}): WorkflowDefinition {
  return store.createWorkflow({
    name: overrides.name ?? 'test-flow',
    description: overrides.description ?? 'A test workflow',
    yaml_content: overrides.yaml_content ?? VALID_YAML,
    file_path: overrides.file_path ?? null,
    is_valid: overrides.is_valid ?? true,
    validation_errors: overrides.validation_errors ?? [],
    step_count: overrides.step_count ?? 2,
  })
}

function makeRunForWorkflow(store: WorkflowStore, workflow: WorkflowDefinition, overrides: Partial<Omit<WorkflowRun, 'id' | 'created_at'>> = {}): WorkflowRun {
  const stepsState = (overrides.steps_state ?? [
    {
      name: 'build',
      type: 'spawn_session',
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
    },
  ]) as StepRunState[]
  return store.createRun({
    workflow_id: overrides.workflow_id ?? workflow.id,
    workflow_name: overrides.workflow_name ?? workflow.name,
    status: overrides.status ?? 'running',
    current_step_index: overrides.current_step_index ?? 0,
    steps_state: stepsState,
    output_dir: overrides.output_dir ?? '/tmp/output',
    started_at: overrides.started_at ?? new Date().toISOString(),
    completed_at: overrides.completed_at ?? null,
    error_message: overrides.error_message ?? null,
    variables: overrides.variables ?? null,
  })
}

async function req(app: Hono, method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return app.request(path, init)
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('workflowHandlers REST API', () => {
  let db: SQLiteDatabase
  let workflowStore: WorkflowStore
  let ctx: ServerContext
  let broadcasts: ServerMessage[]
  let app: Hono

  beforeEach(() => {
    const testDb = createTestDb()
    db = testDb.db
    workflowStore = testDb.workflowStore
    const mock = createMockContext(workflowStore)
    ctx = mock.ctx
    broadcasts = mock.broadcasts
    app = createApp(ctx)
  })

  afterEach(() => {
    try { db.close() } catch { /* ignore */ }
  })

  // ── GET /api/workflows ──────────────────────────────────────────────

  describe('GET /api/workflows', () => {
    it('returns empty array when no workflows exist', async () => {
      const res = await req(app, 'GET', '/api/workflows')
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toEqual({ workflows: [] })
    })

    it('returns all workflows', async () => {
      makeWorkflow(workflowStore, { name: 'flow-a' })
      makeWorkflow(workflowStore, { name: 'flow-b' })
      const res = await req(app, 'GET', '/api/workflows')
      expect(res.status).toBe(200)
      const data = await res.json() as { workflows: WorkflowDefinition[] }
      expect(data.workflows.length).toBe(2)
    })

    it('filters by status=valid', async () => {
      makeWorkflow(workflowStore, { name: 'valid-flow', is_valid: true })
      makeWorkflow(workflowStore, { name: 'invalid-flow', is_valid: false })
      const res = await req(app, 'GET', '/api/workflows?status=valid')
      const data = await res.json() as { workflows: WorkflowDefinition[] }
      expect(data.workflows.length).toBe(1)
      expect(data.workflows[0].name).toBe('valid-flow')
    })

    it('filters by status=invalid', async () => {
      makeWorkflow(workflowStore, { name: 'valid-flow', is_valid: true })
      makeWorkflow(workflowStore, { name: 'invalid-flow', is_valid: false })
      const res = await req(app, 'GET', '/api/workflows?status=invalid')
      const data = await res.json() as { workflows: WorkflowDefinition[] }
      expect(data.workflows.length).toBe(1)
      expect(data.workflows[0].name).toBe('invalid-flow')
    })
  })

  // ── GET /api/workflows/:id ──────────────────────────────────────────

  describe('GET /api/workflows/:id', () => {
    it('returns a workflow by id', async () => {
      const wf = makeWorkflow(workflowStore)
      const res = await req(app, 'GET', `/api/workflows/${wf.id}`)
      expect(res.status).toBe(200)
      const data = await res.json() as WorkflowDefinition
      expect(data.id).toBe(wf.id)
      expect(data.name).toBe('test-flow')
    })

    it('returns 404 for unknown id', async () => {
      const res = await req(app, 'GET', '/api/workflows/nonexistent')
      expect(res.status).toBe(404)
    })
  })

  // ── POST /api/workflows ─────────────────────────────────────────────

  describe('POST /api/workflows', () => {
    it('creates a workflow with valid input', async () => {
      const res = await req(app, 'POST', '/api/workflows', {
        name: 'my-flow',
        yaml_content: VALID_YAML,
        description: 'Test description',
      })
      expect(res.status).toBe(201)
      const data = await res.json() as WorkflowDefinition
      expect(data.name).toBe('my-flow')
      expect(data.is_valid).toBe(true)
      expect(data.step_count).toBe(2)
    })

    it('returns 400 for missing yaml_content', async () => {
      const res = await req(app, 'POST', '/api/workflows', {
        name: 'my-flow',
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 for missing name', async () => {
      const res = await req(app, 'POST', '/api/workflows', {
        yaml_content: VALID_YAML,
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 for non-kebab-case name', async () => {
      const res = await req(app, 'POST', '/api/workflows', {
        name: 'My Flow',
        yaml_content: VALID_YAML,
      })
      expect(res.status).toBe(400)
      const data = await res.json() as { error: string }
      expect(data.error).toContain('kebab-case')
    })

    it('returns 400 for name with path separators', async () => {
      const res = await req(app, 'POST', '/api/workflows', {
        name: '../evil',
        yaml_content: VALID_YAML,
      })
      expect(res.status).toBe(400)
    })

    it('returns 400 for uppercase name', async () => {
      const res = await req(app, 'POST', '/api/workflows', {
        name: 'MyFlow',
        yaml_content: VALID_YAML,
      })
      expect(res.status).toBe(400)
    })

    it('accepts kebab-case names with digits', async () => {
      const res = await req(app, 'POST', '/api/workflows', {
        name: 'flow-v2',
        yaml_content: VALID_YAML,
      })
      expect(res.status).toBe(201)
    })

    it('returns 409 for duplicate name', async () => {
      makeWorkflow(workflowStore, { name: 'existing-flow' })
      const res = await req(app, 'POST', '/api/workflows', {
        name: 'existing-flow',
        yaml_content: VALID_YAML,
      })
      expect(res.status).toBe(409)
    })

    it('stores invalid YAML with is_valid=false', async () => {
      const res = await req(app, 'POST', '/api/workflows', {
        name: 'bad-yaml',
        yaml_content: 'not: valid: yaml: [',
      })
      // Should still create (stores validation errors)
      expect(res.status).toBe(201)
      const data = await res.json() as WorkflowDefinition
      expect(data.is_valid).toBe(false)
    })

    it('returns 400 for invalid JSON body', async () => {
      const res = await app.request('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      })
      expect(res.status).toBe(400)
    })
  })

  // ── PUT /api/workflows/:id ──────────────────────────────────────────

  describe('PUT /api/workflows/:id', () => {
    it('updates a workflow', async () => {
      const wf = makeWorkflow(workflowStore)
      const res = await req(app, 'PUT', `/api/workflows/${wf.id}`, {
        description: 'Updated description',
      })
      expect(res.status).toBe(200)
      const data = await res.json() as WorkflowDefinition
      expect(data.description).toBe('Updated description')
    })

    it('re-validates when yaml_content is updated', async () => {
      const wf = makeWorkflow(workflowStore)
      const res = await req(app, 'PUT', `/api/workflows/${wf.id}`, {
        yaml_content: 'not: a: valid: workflow',
      })
      expect(res.status).toBe(200)
      const data = await res.json() as WorkflowDefinition
      expect(data.is_valid).toBe(false)
    })

    it('returns 404 for unknown id', async () => {
      const res = await req(app, 'PUT', '/api/workflows/nonexistent', {
        description: 'x',
      })
      expect(res.status).toBe(404)
    })
  })

  // ── DELETE /api/workflows/:id ───────────────────────────────────────

  describe('DELETE /api/workflows/:id', () => {
    it('deletes a workflow and broadcasts removal', async () => {
      const wf = makeWorkflow(workflowStore)
      const res = await req(app, 'DELETE', `/api/workflows/${wf.id}`)
      expect(res.status).toBe(200)
      const data = await res.json() as { ok: boolean }
      expect(data.ok).toBe(true)

      // Verify deleted
      expect(workflowStore.getWorkflow(wf.id)).toBeNull()

      // Verify broadcast
      const removal = broadcasts.find(b => b.type === 'workflow-removed')
      expect(removal).toBeTruthy()
    })

    it('returns 404 for unknown id', async () => {
      const res = await req(app, 'DELETE', '/api/workflows/nonexistent')
      expect(res.status).toBe(404)
    })
  })

  // ── GET /api/workflows/:id/runs ─────────────────────────────────────

  describe('GET /api/workflows/:id/runs', () => {
    it('returns runs for a workflow', async () => {
      const wf = makeWorkflow(workflowStore)
      makeRunForWorkflow(workflowStore, wf)
      const res = await req(app, 'GET', `/api/workflows/${wf.id}/runs`)
      expect(res.status).toBe(200)
      const data = await res.json() as { runs: WorkflowRun[] }
      expect(data.runs.length).toBe(1)
    })

    it('returns 404 if workflow not found', async () => {
      const res = await req(app, 'GET', '/api/workflows/nonexistent/runs')
      expect(res.status).toBe(404)
    })
  })

  // ── POST /api/workflows/:id/run ─────────────────────────────────────

  describe('POST /api/workflows/:id/run', () => {
    it('triggers a new run for a valid workflow', async () => {
      const wf = makeWorkflow(workflowStore)
      const res = await req(app, 'POST', `/api/workflows/${wf.id}/run`)
      expect(res.status).toBe(201)
      const data = await res.json() as WorkflowRun
      expect(data.workflow_id).toBe(wf.id)
      expect(data.status).toBe('running')
      expect(data.steps_state.length).toBe(2)
      expect(data.steps_state[0].status).toBe('pending')
      expect(data.steps_state[0].name).toBe('build')

      // Verify broadcast
      const update = broadcasts.find(b => b.type === 'workflow-run-update')
      expect(update).toBeTruthy()
    })

    it('returns 404 if workflow not found', async () => {
      const res = await req(app, 'POST', '/api/workflows/nonexistent/run')
      expect(res.status).toBe(404)
    })

    it('returns 400 if workflow is not valid', async () => {
      const wf = makeWorkflow(workflowStore, { is_valid: false })
      const res = await req(app, 'POST', `/api/workflows/${wf.id}/run`)
      expect(res.status).toBe(400)
    })

    it('returns 429 when too many concurrent runs', async () => {
      const wf = makeWorkflow(workflowStore)
      // Create runs up to the limit (2 in test config)
      makeRunForWorkflow(workflowStore, wf, { status: 'running' })
      makeRunForWorkflow(workflowStore, wf, { status: 'running' })

      const res = await req(app, 'POST', `/api/workflows/${wf.id}/run`)
      expect(res.status).toBe(429)
    })
  })

  // ── GET /api/workflow-runs/:runId ───────────────────────────────────

  describe('GET /api/workflow-runs/:runId', () => {
    it('returns a run by id', async () => {
      const wf = makeWorkflow(workflowStore)
      const run = makeRunForWorkflow(workflowStore, wf)
      const res = await req(app, 'GET', `/api/workflow-runs/${run.id}`)
      expect(res.status).toBe(200)
      const data = await res.json() as WorkflowRun
      expect(data.id).toBe(run.id)
    })

    it('returns 404 for unknown run id', async () => {
      const res = await req(app, 'GET', '/api/workflow-runs/nonexistent')
      expect(res.status).toBe(404)
    })
  })

  // ── POST /api/workflow-runs/:runId/resume ───────────────────────────

  describe('POST /api/workflow-runs/:runId/resume', () => {
    it('resumes a failed run', async () => {
      const wf = makeWorkflow(workflowStore)
      const failedSteps: StepRunState[] = [{
        name: 'build',
        type: 'spawn_session',
        status: 'failed',
        taskId: null,
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:01:00Z',
        errorMessage: 'Build failed',
        retryCount: 0,
        skippedReason: null,
        resultFile: null,
        resultCollected: false,
        resultContent: null,
      }]
      const run = makeRunForWorkflow(workflowStore, wf, {
        status: 'failed',
        steps_state: failedSteps,
        current_step_index: 0,
      })

      const res = await req(app, 'POST', `/api/workflow-runs/${run.id}/resume`)
      expect(res.status).toBe(200)
      const data = await res.json() as WorkflowRun
      expect(data.status).toBe('running')
      expect(data.steps_state[0].status).toBe('pending')
      expect(data.steps_state[0].errorMessage).toBeNull()
    })

    it('returns 400 if run is not failed', async () => {
      const wf = makeWorkflow(workflowStore)
      const run = makeRunForWorkflow(workflowStore, wf, { status: 'running' })
      const res = await req(app, 'POST', `/api/workflow-runs/${run.id}/resume`)
      expect(res.status).toBe(400)
    })

    it('returns 404 for unknown run id', async () => {
      const res = await req(app, 'POST', '/api/workflow-runs/nonexistent/resume')
      expect(res.status).toBe(404)
    })
  })

  // ── GET /api/workflow-runs/:runId/steps/:stepIndex/result ───────────

  describe('GET /api/workflow-runs/:runId/steps/:stepIndex/result', () => {
    it('returns parsed JSON content when resultCollected is true', async () => {
      const wf = makeWorkflow(workflowStore)
      const resultData = { status: 'success', findings: ['issue1', 'issue2'] }
      const run = makeRunForWorkflow(workflowStore, wf, {
        steps_state: [{
          name: 'analyze',
          type: 'spawn_session',
          status: 'completed',
          taskId: null,
          startedAt: '2026-01-01T00:00:00Z',
          completedAt: '2026-01-01T00:01:00Z',
          errorMessage: null,
          retryCount: 0,
          skippedReason: null,
          resultFile: 'analysis.json',
          resultCollected: true,
          resultContent: JSON.stringify(resultData),
        }],
      })

      const res = await req(app, 'GET', `/api/workflow-runs/${run.id}/steps/0/result`)
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toMatchObject({
        stepIndex: 0,
        stepName: 'analyze',
        resultFile: 'analysis.json',
        contentType: 'json',
        content: resultData,
      })
    })

    it('returns 404 when no result_file declared', async () => {
      const wf = makeWorkflow(workflowStore)
      const run = makeRunForWorkflow(workflowStore, wf, {
        steps_state: [{
          name: 'build',
          type: 'spawn_session',
          status: 'completed',
          taskId: null,
          startedAt: '2026-01-01T00:00:00Z',
          completedAt: '2026-01-01T00:01:00Z',
          errorMessage: null,
          retryCount: 0,
          skippedReason: null,
          resultFile: null,
          resultCollected: false,
          resultContent: null,
        }],
      })

      const res = await req(app, 'GET', `/api/workflow-runs/${run.id}/steps/0/result`)
      expect(res.status).toBe(404)
      const data = await res.json() as { error: string }
      expect(data.error).toContain('result_file')
    })

    it('returns 404 when result not collected', async () => {
      const wf = makeWorkflow(workflowStore)
      const run = makeRunForWorkflow(workflowStore, wf, {
        steps_state: [{
          name: 'analyze',
          type: 'spawn_session',
          status: 'completed',
          taskId: null,
          startedAt: '2026-01-01T00:00:00Z',
          completedAt: '2026-01-01T00:01:00Z',
          errorMessage: null,
          retryCount: 0,
          skippedReason: null,
          resultFile: 'analysis.json',
          resultCollected: false,
          resultContent: null,
        }],
      })

      const res = await req(app, 'GET', `/api/workflow-runs/${run.id}/steps/0/result`)
      expect(res.status).toBe(404)
      const data = await res.json() as { error: string }
      expect(data.error).toContain('not collected')
    })

    it('returns 400 for invalid stepIndex', async () => {
      const wf = makeWorkflow(workflowStore)
      const run = makeRunForWorkflow(workflowStore, wf)

      const res = await req(app, 'GET', `/api/workflow-runs/${run.id}/steps/999/result`)
      expect(res.status).toBe(400)
    })

    it('returns 400 for non-integer stepIndex', async () => {
      const wf = makeWorkflow(workflowStore)
      const run = makeRunForWorkflow(workflowStore, wf)

      const res = await req(app, 'GET', `/api/workflow-runs/${run.id}/steps/abc/result`)
      expect(res.status).toBe(400)
    })

    it('returns 404 for unknown runId', async () => {
      const res = await req(app, 'GET', '/api/workflow-runs/nonexistent/steps/0/result')
      expect(res.status).toBe(404)
    })
  })

  // ── GET /api/workflow-runs/:runId/results ────────────────────────────

  describe('GET /api/workflow-runs/:runId/results', () => {
    it('returns filtered summary of steps with result_file', async () => {
      const wf = makeWorkflow(workflowStore)
      const run = makeRunForWorkflow(workflowStore, wf, {
        steps_state: [
          {
            name: 'analyze',
            type: 'spawn_session',
            status: 'completed',
            taskId: null,
            startedAt: '2026-01-01T00:00:00Z',
            completedAt: '2026-01-01T00:01:00Z',
            errorMessage: null,
            retryCount: 0,
            skippedReason: null,
            resultFile: 'analysis.json',
            resultCollected: true,
            resultContent: '{"status":"ok"}',
          },
          {
            name: 'build',
            type: 'spawn_session',
            status: 'completed',
            taskId: null,
            startedAt: '2026-01-01T00:01:00Z',
            completedAt: '2026-01-01T00:02:00Z',
            errorMessage: null,
            retryCount: 0,
            skippedReason: null,
            resultFile: null,
            resultCollected: false,
            resultContent: null,
          },
          {
            name: 'review',
            type: 'spawn_session',
            status: 'completed',
            taskId: null,
            startedAt: '2026-01-01T00:02:00Z',
            completedAt: '2026-01-01T00:03:00Z',
            errorMessage: null,
            retryCount: 0,
            skippedReason: null,
            resultFile: 'review.json',
            resultCollected: false,
            resultContent: null,
          },
        ],
      })

      const res = await req(app, 'GET', `/api/workflow-runs/${run.id}/results`)
      expect(res.status).toBe(200)
      const data = await res.json() as { results: unknown[] }

      // Only steps with result_file should be included
      expect(data.results.length).toBe(2)
      expect(data.results[0]).toMatchObject({
        stepIndex: 0,
        stepName: 'analyze',
        resultFile: 'analysis.json',
        resultCollected: true,
      })
      expect(data.results[1]).toMatchObject({
        stepIndex: 2,
        stepName: 'review',
        resultFile: 'review.json',
        resultCollected: false,
      })
    })

    it('returns empty results array when no steps have result_file', async () => {
      const wf = makeWorkflow(workflowStore)
      const run = makeRunForWorkflow(workflowStore, wf, {
        steps_state: [{
          name: 'build',
          type: 'spawn_session',
          status: 'completed',
          taskId: null,
          startedAt: '2026-01-01T00:00:00Z',
          completedAt: '2026-01-01T00:01:00Z',
          errorMessage: null,
          retryCount: 0,
          skippedReason: null,
          resultFile: null,
          resultCollected: false,
          resultContent: null,
        }],
      })

      const res = await req(app, 'GET', `/api/workflow-runs/${run.id}/results`)
      expect(res.status).toBe(200)
      const data = await res.json() as { results: unknown[] }
      expect(data.results).toEqual([])
    })

    it('returns 404 for unknown runId', async () => {
      const res = await req(app, 'GET', '/api/workflow-runs/nonexistent/results')
      expect(res.status).toBe(404)
    })
  })

  // ── POST /api/workflow-runs/:runId/cancel ───────────────────────────

  describe('POST /api/workflow-runs/:runId/cancel', () => {
    it('cancels a running run', async () => {
      const wf = makeWorkflow(workflowStore)
      const run = makeRunForWorkflow(workflowStore, wf, { status: 'running' })
      const res = await req(app, 'POST', `/api/workflow-runs/${run.id}/cancel`)
      expect(res.status).toBe(200)
      const data = await res.json() as WorkflowRun
      expect(data.status).toBe('cancelled')
      expect(data.completed_at).toBeTruthy()
    })

    it('returns 400 if run is not running', async () => {
      const wf = makeWorkflow(workflowStore)
      const run = makeRunForWorkflow(workflowStore, wf, { status: 'completed' })
      const res = await req(app, 'POST', `/api/workflow-runs/${run.id}/cancel`)
      expect(res.status).toBe(400)
    })

    it('returns 404 for unknown run id', async () => {
      const res = await req(app, 'POST', '/api/workflow-runs/nonexistent/cancel')
      expect(res.status).toBe(404)
    })
  })
})
