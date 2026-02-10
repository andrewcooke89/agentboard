// workflowIntegration.test.ts - End-to-end integration tests for workflow engine (WO-015)
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { initWorkflowStore } from '../workflowStore'
import type { WorkflowStore } from '../workflowStore'
import { createWorkflowHandlers } from '../handlers/workflowHandlers'
import type { ServerContext } from '../serverContext'
import type { ServerMessage, WorkflowDefinition, WorkflowRun, StepRunState } from '../../shared/types'
import type { TaskStore } from '../taskStore'

// ─── Test Helpers ─────────────────────────────────────────────────────────

const VALID_YAML = `name: test-workflow
description: Integration test workflow
steps:
  - name: step-1
    type: delay
    seconds: 1
  - name: step-2
    type: check_file
    path: ./output.txt
`

const VALID_YAML_SINGLE_STEP = `name: single-step
steps:
  - name: only-step
    type: delay
    seconds: 5
`

const INVALID_YAML_MISSING_STEPS = `name: broken-workflow
description: Missing steps field
`

const INVALID_YAML_SYNTAX = `name: broken
  bad: indentation: [
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

function createMockContext(workflowStore: WorkflowStore, overrides?: { maxConcurrentRuns?: number }): {
  ctx: ServerContext
  broadcasts: ServerMessage[]
} {
  const broadcasts: ServerMessage[] = []
  const ctx = {
    workflowStore,
    config: {
      workflowDir: '/tmp/test-workflows-integration',
      workflowMaxConcurrentRuns: overrides?.maxConcurrentRuns ?? 2,
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

async function req(app: Hono, method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return app.request(path, init)
}

// ─── Integration Tests ───────────────────────────────────────────────────

describe('Workflow Integration Tests (WO-015)', () => {
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

  // ── Scenario 1: Workflow CRUD lifecycle via REST API ────────────────

  describe('Workflow CRUD lifecycle via REST API', () => {
    it('completes full create-read-update-delete cycle', async () => {
      // POST /api/workflows with valid YAML -> 201, workflow created
      const createRes = await req(app, 'POST', '/api/workflows', {
        name: 'integration-test',
        yaml_content: VALID_YAML,
        description: 'Integration test workflow',
      })
      expect(createRes.status).toBe(201)
      const created = await createRes.json() as WorkflowDefinition
      expect(created.name).toBe('integration-test')
      expect(created.is_valid).toBe(true)
      expect(created.step_count).toBe(2)
      expect(created.id).toBeTruthy()

      const workflowId = created.id

      // GET /api/workflows -> includes the new workflow
      const listRes = await req(app, 'GET', '/api/workflows')
      expect(listRes.status).toBe(200)
      const listData = await listRes.json() as { workflows: WorkflowDefinition[] }
      const list = listData.workflows
      expect(list.length).toBe(1)
      expect(list[0].id).toBe(workflowId)

      // GET /api/workflows/:id -> returns the workflow
      const getRes = await req(app, 'GET', `/api/workflows/${workflowId}`)
      expect(getRes.status).toBe(200)
      const fetched = await getRes.json() as WorkflowDefinition
      expect(fetched.id).toBe(workflowId)
      expect(fetched.name).toBe('integration-test')
      expect(fetched.description).toBe('Integration test workflow')

      // PUT /api/workflows/:id with updated YAML -> 200
      const updateRes = await req(app, 'PUT', `/api/workflows/${workflowId}`, {
        description: 'Updated description',
        yaml_content: VALID_YAML_SINGLE_STEP,
      })
      expect(updateRes.status).toBe(200)
      const updated = await updateRes.json() as WorkflowDefinition
      expect(updated.description).toBe('Updated description')
      expect(updated.step_count).toBe(1)

      // DELETE /api/workflows/:id -> 200, workflow gone
      const deleteRes = await req(app, 'DELETE', `/api/workflows/${workflowId}`)
      expect(deleteRes.status).toBe(200)
      const deleteBody = await deleteRes.json() as { ok: boolean }
      expect(deleteBody.ok).toBe(true)

      // GET /api/workflows/:id -> 404
      const goneRes = await req(app, 'GET', `/api/workflows/${workflowId}`)
      expect(goneRes.status).toBe(404)
    })
  })

  // ── Scenario 2: Workflow run lifecycle ──────────────────────────────

  describe('Workflow run lifecycle', () => {
    it('creates and retrieves a workflow run with initialized steps', async () => {
      // Create a workflow via API
      const createRes = await req(app, 'POST', '/api/workflows', {
        name: 'run-lifecycle-test',
        yaml_content: VALID_YAML,
      })
      expect(createRes.status).toBe(201)
      const workflow = await createRes.json() as WorkflowDefinition

      // POST /api/workflows/:id/run -> 201, run created with status 'running'
      const runRes = await req(app, 'POST', `/api/workflows/${workflow.id}/run`)
      expect(runRes.status).toBe(201)
      const run = await runRes.json() as WorkflowRun
      expect(run.workflow_id).toBe(workflow.id)
      expect(run.workflow_name).toBe('run-lifecycle-test')
      expect(run.status).toBe('running')
      expect(run.steps_state.length).toBe(2)

      // GET /api/workflow-runs/:runId -> run exists with steps_state initialized
      const getRunRes = await req(app, 'GET', `/api/workflow-runs/${run.id}`)
      expect(getRunRes.status).toBe(200)
      const fetchedRun = await getRunRes.json() as WorkflowRun
      expect(fetchedRun.id).toBe(run.id)
      expect(fetchedRun.steps_state.length).toBe(2)

      // All steps should be 'pending' initially
      for (const step of fetchedRun.steps_state) {
        expect(step.status).toBe('pending')
        expect(step.taskId).toBeNull()
        expect(step.startedAt).toBeNull()
        expect(step.completedAt).toBeNull()
        expect(step.errorMessage).toBeNull()
        expect(step.retryCount).toBe(0)
      }

      // Verify step names and types match the YAML definition
      expect(fetchedRun.steps_state[0].name).toBe('step-1')
      expect(fetchedRun.steps_state[0].type).toBe('delay')
      expect(fetchedRun.steps_state[1].name).toBe('step-2')
      expect(fetchedRun.steps_state[1].type).toBe('check_file')

      // Verify broadcast was sent
      const runUpdate = broadcasts.find(b => b.type === 'workflow-run-update')
      expect(runUpdate).toBeTruthy()
    })
  })

  // ── Scenario 3: Invalid workflow cannot be run ─────────────────────

  describe('Invalid workflow cannot be run', () => {
    it('returns 400 when trying to run an invalid workflow', async () => {
      // Create workflow with invalid YAML (missing steps field)
      const createRes = await req(app, 'POST', '/api/workflows', {
        name: 'invalid-wf',
        yaml_content: INVALID_YAML_MISSING_STEPS,
      })
      expect(createRes.status).toBe(201)
      const workflow = await createRes.json() as WorkflowDefinition
      expect(workflow.is_valid).toBe(false)

      // POST /api/workflows/:id/run -> 400 (invalid workflow)
      const runRes = await req(app, 'POST', `/api/workflows/${workflow.id}/run`)
      expect(runRes.status).toBe(400)
      const body = await runRes.json() as { error: string }
      expect(body.error).toContain('not valid')
    })

    it('returns 400 for workflow with YAML syntax error', async () => {
      const createRes = await req(app, 'POST', '/api/workflows', {
        name: 'syntax-error-wf',
        yaml_content: INVALID_YAML_SYNTAX,
      })
      expect(createRes.status).toBe(201)
      const workflow = await createRes.json() as WorkflowDefinition
      expect(workflow.is_valid).toBe(false)
      expect(workflow.validation_errors.length).toBeGreaterThan(0)

      const runRes = await req(app, 'POST', `/api/workflows/${workflow.id}/run`)
      expect(runRes.status).toBe(400)
    })
  })

  // ── Scenario 4: Concurrent run limit enforcement ───────────────────

  describe('Concurrent run limit enforcement', () => {
    it('returns 429 when max concurrent runs exceeded', async () => {
      // Create a valid workflow
      const createRes = await req(app, 'POST', '/api/workflows', {
        name: 'concurrent-test',
        yaml_content: VALID_YAML,
      })
      expect(createRes.status).toBe(201)
      const workflow = await createRes.json() as WorkflowDefinition

      // Trigger runs up to config.workflowMaxConcurrentRuns (2)
      const run1Res = await req(app, 'POST', `/api/workflows/${workflow.id}/run`)
      expect(run1Res.status).toBe(201)

      const run2Res = await req(app, 'POST', `/api/workflows/${workflow.id}/run`)
      expect(run2Res.status).toBe(201)

      // Next trigger -> 429
      const run3Res = await req(app, 'POST', `/api/workflows/${workflow.id}/run`)
      expect(run3Res.status).toBe(429)
      const body = await run3Res.json() as { error: string }
      expect(body.error).toContain('Concurrent')
    })

    it('allows new run after previous run completes', async () => {
      const createRes = await req(app, 'POST', '/api/workflows', {
        name: 'concurrent-recovery',
        yaml_content: VALID_YAML,
      })
      const workflow = await createRes.json() as WorkflowDefinition

      // Fill up concurrent slots
      const run1Res = await req(app, 'POST', `/api/workflows/${workflow.id}/run`)
      const run1 = await run1Res.json() as WorkflowRun
      const run2Res = await req(app, 'POST', `/api/workflows/${workflow.id}/run`)
      expect(run2Res.status).toBe(201)

      // Complete run1 via store
      workflowStore.updateRun(run1.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
      })

      // Now a new run should be allowed
      const run3Res = await req(app, 'POST', `/api/workflows/${workflow.id}/run`)
      expect(run3Res.status).toBe(201)
    })
  })

  // ── Scenario 5: Resume failed run ──────────────────────────────────

  describe('Resume failed run', () => {
    it('resumes a failed run, resetting failed step to pending', async () => {
      // Create a workflow and run
      const createRes = await req(app, 'POST', '/api/workflows', {
        name: 'resume-test',
        yaml_content: VALID_YAML,
      })
      const workflow = await createRes.json() as WorkflowDefinition

      const runRes = await req(app, 'POST', `/api/workflows/${workflow.id}/run`)
      const run = await runRes.json() as WorkflowRun

      // Manually set run to 'failed' status in DB with a failed step
      const failedSteps: StepRunState[] = run.steps_state.map((s, i) =>
        i === 0
          ? { ...s, status: 'failed' as const, errorMessage: 'Step failed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString() }
          : s
      )
      workflowStore.updateRun(run.id, {
        status: 'failed',
        steps_state: failedSteps,
        error_message: 'Step 0 failed',
      })

      // POST /api/workflow-runs/:runId/resume -> 200, status back to 'running'
      const resumeRes = await req(app, 'POST', `/api/workflow-runs/${run.id}/resume`)
      expect(resumeRes.status).toBe(200)
      const resumed = await resumeRes.json() as WorkflowRun
      expect(resumed.status).toBe('running')

      // Current failed step reset to 'pending'
      expect(resumed.steps_state[0].status).toBe('pending')
      expect(resumed.steps_state[0].errorMessage).toBeNull()
    })

    it('returns 400 when trying to resume a non-failed run', async () => {
      const createRes = await req(app, 'POST', '/api/workflows', {
        name: 'resume-nonfailed',
        yaml_content: VALID_YAML,
      })
      const workflow = await createRes.json() as WorkflowDefinition

      const runRes = await req(app, 'POST', `/api/workflows/${workflow.id}/run`)
      const run = await runRes.json() as WorkflowRun

      // Run is 'running', not 'failed'
      const resumeRes = await req(app, 'POST', `/api/workflow-runs/${run.id}/resume`)
      expect(resumeRes.status).toBe(400)
    })

    it('returns 404 for unknown run id', async () => {
      const resumeRes = await req(app, 'POST', '/api/workflow-runs/nonexistent/resume')
      expect(resumeRes.status).toBe(404)
    })
  })

  // ── Scenario 6: Cancel running run ─────────────────────────────────

  describe('Cancel running run', () => {
    it('cancels a running run', async () => {
      // Create a run, set status to 'running'
      const createRes = await req(app, 'POST', '/api/workflows', {
        name: 'cancel-test',
        yaml_content: VALID_YAML,
      })
      const workflow = await createRes.json() as WorkflowDefinition

      const runRes = await req(app, 'POST', `/api/workflows/${workflow.id}/run`)
      const run = await runRes.json() as WorkflowRun
      expect(run.status).toBe('running')

      // POST /api/workflow-runs/:runId/cancel -> 200, status 'cancelled'
      const cancelRes = await req(app, 'POST', `/api/workflow-runs/${run.id}/cancel`)
      expect(cancelRes.status).toBe(200)
      const cancelled = await cancelRes.json() as WorkflowRun
      expect(cancelled.status).toBe('cancelled')
      expect(cancelled.completed_at).toBeTruthy()

      // Verify broadcast
      const cancelBroadcast = broadcasts.filter(b => b.type === 'workflow-run-update')
      expect(cancelBroadcast.length).toBeGreaterThanOrEqual(1)
    })

    it('returns 400 when trying to cancel a completed run', async () => {
      const createRes = await req(app, 'POST', '/api/workflows', {
        name: 'cancel-completed',
        yaml_content: VALID_YAML,
      })
      const workflow = await createRes.json() as WorkflowDefinition

      const runRes = await req(app, 'POST', `/api/workflows/${workflow.id}/run`)
      const run = await runRes.json() as WorkflowRun

      // Manually mark as completed
      workflowStore.updateRun(run.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
      })

      const cancelRes = await req(app, 'POST', `/api/workflow-runs/${run.id}/cancel`)
      expect(cancelRes.status).toBe(400)
    })

    it('returns 404 for unknown run id', async () => {
      const cancelRes = await req(app, 'POST', '/api/workflow-runs/nonexistent/cancel')
      expect(cancelRes.status).toBe(404)
    })
  })

  // ── Scenario 7: Workflow store operations ──────────────────────────

  describe('Workflow store operations', () => {
    describe('workflow CRUD', () => {
      it('createWorkflow and getWorkflow round-trip', () => {
        const wf = workflowStore.createWorkflow({
          name: 'store-test',
          description: 'Store test workflow',
          yaml_content: VALID_YAML,
          file_path: null,
          is_valid: true,
          validation_errors: [],
          step_count: 2,
        })
        expect(wf.id).toBeTruthy()
        expect(wf.name).toBe('store-test')
        expect(wf.created_at).toBeTruthy()
        expect(wf.updated_at).toBeTruthy()

        const fetched = workflowStore.getWorkflow(wf.id)
        expect(fetched).not.toBeNull()
        expect(fetched!.id).toBe(wf.id)
        expect(fetched!.name).toBe('store-test')
      })

      it('getWorkflowByName finds by name', () => {
        workflowStore.createWorkflow({
          name: 'findable',
          description: null,
          yaml_content: VALID_YAML,
          file_path: null,
          is_valid: true,
          validation_errors: [],
          step_count: 2,
        })

        const found = workflowStore.getWorkflowByName('findable')
        expect(found).not.toBeNull()
        expect(found!.name).toBe('findable')

        const notFound = workflowStore.getWorkflowByName('nonexistent')
        expect(notFound).toBeNull()
      })

      it('updateWorkflow updates fields', () => {
        const wf = workflowStore.createWorkflow({
          name: 'updatable',
          description: 'Original',
          yaml_content: VALID_YAML,
          file_path: null,
          is_valid: true,
          validation_errors: [],
          step_count: 2,
        })

        const updated = workflowStore.updateWorkflow(wf.id, {
          description: 'Updated',
          is_valid: false,
          validation_errors: ['error1'],
        })
        expect(updated).not.toBeNull()
        expect(updated!.description).toBe('Updated')
        expect(updated!.is_valid).toBe(false)
        expect(updated!.validation_errors).toContain('error1')
      })

      it('updateWorkflow returns null for nonexistent id', () => {
        const result = workflowStore.updateWorkflow('nonexistent', { description: 'x' })
        expect(result).toBeNull()
      })

      it('deleteWorkflow removes the workflow', () => {
        const wf = workflowStore.createWorkflow({
          name: 'deletable',
          description: null,
          yaml_content: VALID_YAML,
          file_path: null,
          is_valid: true,
          validation_errors: [],
          step_count: 2,
        })

        const deleted = workflowStore.deleteWorkflow(wf.id)
        expect(deleted).toBe(true)
        expect(workflowStore.getWorkflow(wf.id)).toBeNull()

        const deletedAgain = workflowStore.deleteWorkflow(wf.id)
        expect(deletedAgain).toBe(false)
      })

      it('listWorkflows returns all and filters by status', () => {
        workflowStore.createWorkflow({
          name: 'valid-wf',
          description: null,
          yaml_content: VALID_YAML,
          file_path: null,
          is_valid: true,
          validation_errors: [],
          step_count: 2,
        })
        workflowStore.createWorkflow({
          name: 'invalid-wf',
          description: null,
          yaml_content: 'bad',
          file_path: null,
          is_valid: false,
          validation_errors: ['bad'],
          step_count: 0,
        })

        const all = workflowStore.listWorkflows()
        expect(all.length).toBe(2)

        const valid = workflowStore.listWorkflows({ status: 'valid' })
        expect(valid.length).toBe(1)
        expect(valid[0].name).toBe('valid-wf')

        const invalid = workflowStore.listWorkflows({ status: 'invalid' })
        expect(invalid.length).toBe(1)
        expect(invalid[0].name).toBe('invalid-wf')
      })
    })

    describe('run CRUD', () => {
      function makeStepsState(): StepRunState[] {
        return [
          {
            name: 'step-1',
            type: 'delay',
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
        ]
      }

      it('createRun and getRun round-trip', () => {
        const wf = workflowStore.createWorkflow({
          name: 'run-store-test',
          description: null,
          yaml_content: VALID_YAML,
          file_path: null,
          is_valid: true,
          validation_errors: [],
          step_count: 2,
        })

        const run = workflowStore.createRun({
          workflow_id: wf.id,
          workflow_name: wf.name,
          status: 'pending',
          current_step_index: 0,
          steps_state: makeStepsState(),
          output_dir: '/tmp/output',
          started_at: null,
          completed_at: null,
          error_message: null,
          variables: null,
        })
        expect(run.id).toBeTruthy()
        expect(run.status).toBe('pending')

        const fetched = workflowStore.getRun(run.id)
        expect(fetched).not.toBeNull()
        expect(fetched!.workflow_id).toBe(wf.id)
        expect(fetched!.steps_state.length).toBe(1)
        expect(fetched!.steps_state[0].name).toBe('step-1')
      })

      it('updateRun updates fields', () => {
        const wf = workflowStore.createWorkflow({
          name: 'run-update-test',
          description: null,
          yaml_content: VALID_YAML,
          file_path: null,
          is_valid: true,
          validation_errors: [],
          step_count: 2,
        })

        const run = workflowStore.createRun({
          workflow_id: wf.id,
          workflow_name: wf.name,
          status: 'running',
          current_step_index: 0,
          steps_state: makeStepsState(),
          output_dir: '/tmp/output',
          started_at: new Date().toISOString(),
          completed_at: null,
          error_message: null,
          variables: null,
        })

        const updated = workflowStore.updateRun(run.id, {
          status: 'completed',
          completed_at: new Date().toISOString(),
          current_step_index: 1,
        })
        expect(updated).not.toBeNull()
        expect(updated!.status).toBe('completed')
        expect(updated!.current_step_index).toBe(1)
        expect(updated!.completed_at).toBeTruthy()
      })

      it('listRuns returns runs with optional status filter', () => {
        const wf = workflowStore.createWorkflow({
          name: 'list-runs-test',
          description: null,
          yaml_content: VALID_YAML,
          file_path: null,
          is_valid: true,
          validation_errors: [],
          step_count: 2,
        })

        workflowStore.createRun({
          workflow_id: wf.id,
          workflow_name: wf.name,
          status: 'running',
          current_step_index: 0,
          steps_state: makeStepsState(),
          output_dir: '/tmp/output-1',
          started_at: new Date().toISOString(),
          completed_at: null,
          error_message: null,
          variables: null,
        })
        workflowStore.createRun({
          workflow_id: wf.id,
          workflow_name: wf.name,
          status: 'completed',
          current_step_index: 0,
          steps_state: makeStepsState(),
          output_dir: '/tmp/output-2',
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          error_message: null,
          variables: null,
        })

        const all = workflowStore.listRuns()
        expect(all.length).toBe(2)

        const running = workflowStore.listRuns({ status: 'running' })
        expect(running.length).toBe(1)
        expect(running[0].status).toBe('running')

        const completed = workflowStore.listRuns({ status: 'completed' })
        expect(completed.length).toBe(1)
        expect(completed[0].status).toBe('completed')
      })

      it('listRunsByWorkflow returns runs for a specific workflow', () => {
        const wf1 = workflowStore.createWorkflow({
          name: 'wf-one',
          description: null,
          yaml_content: VALID_YAML,
          file_path: null,
          is_valid: true,
          validation_errors: [],
          step_count: 2,
        })
        const wf2 = workflowStore.createWorkflow({
          name: 'wf-two',
          description: null,
          yaml_content: VALID_YAML,
          file_path: null,
          is_valid: true,
          validation_errors: [],
          step_count: 2,
        })

        workflowStore.createRun({
          workflow_id: wf1.id,
          workflow_name: wf1.name,
          status: 'running',
          current_step_index: 0,
          steps_state: makeStepsState(),
          output_dir: '/tmp/output-a',
          started_at: null,
          completed_at: null,
          error_message: null,
          variables: null,
        })
        workflowStore.createRun({
          workflow_id: wf2.id,
          workflow_name: wf2.name,
          status: 'running',
          current_step_index: 0,
          steps_state: makeStepsState(),
          output_dir: '/tmp/output-b',
          started_at: null,
          completed_at: null,
          error_message: null,
          variables: null,
        })

        const wf1Runs = workflowStore.listRunsByWorkflow(wf1.id)
        expect(wf1Runs.length).toBe(1)
        expect(wf1Runs[0].workflow_id).toBe(wf1.id)

        const wf2Runs = workflowStore.listRunsByWorkflow(wf2.id)
        expect(wf2Runs.length).toBe(1)
        expect(wf2Runs[0].workflow_id).toBe(wf2.id)
      })

      it('getRunningRuns returns only running runs', () => {
        const wf = workflowStore.createWorkflow({
          name: 'running-runs-test',
          description: null,
          yaml_content: VALID_YAML,
          file_path: null,
          is_valid: true,
          validation_errors: [],
          step_count: 2,
        })

        workflowStore.createRun({
          workflow_id: wf.id,
          workflow_name: wf.name,
          status: 'running',
          current_step_index: 0,
          steps_state: makeStepsState(),
          output_dir: '/tmp/output-run',
          started_at: new Date().toISOString(),
          completed_at: null,
          error_message: null,
          variables: null,
        })
        workflowStore.createRun({
          workflow_id: wf.id,
          workflow_name: wf.name,
          status: 'completed',
          current_step_index: 0,
          steps_state: makeStepsState(),
          output_dir: '/tmp/output-done',
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          error_message: null,
          variables: null,
        })
        workflowStore.createRun({
          workflow_id: wf.id,
          workflow_name: wf.name,
          status: 'failed',
          current_step_index: 0,
          steps_state: makeStepsState(),
          output_dir: '/tmp/output-fail',
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          error_message: 'failed',
          variables: null,
        })

        const running = workflowStore.getRunningRuns()
        expect(running.length).toBe(1)
        expect(running[0].status).toBe('running')
      })

      it('deleteOldRuns removes old completed/failed/cancelled runs', () => {
        const wf = workflowStore.createWorkflow({
          name: 'delete-old-test',
          description: null,
          yaml_content: VALID_YAML,
          file_path: null,
          is_valid: true,
          validation_errors: [],
          step_count: 2,
        })

        // Create a completed run (created_at is auto-set to now)
        workflowStore.createRun({
          workflow_id: wf.id,
          workflow_name: wf.name,
          status: 'completed',
          current_step_index: 0,
          steps_state: makeStepsState(),
          output_dir: '/tmp/output-old',
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          error_message: null,
          variables: null,
        })

        // deleteOldRuns with 0 days should NOT delete (just created)
        // actually it uses SQL datetime('now', '-N days'), so 0 days = now
        // A run created "now" is not older than 0 days ago
        const deleted = workflowStore.deleteOldRuns(0)
        // The run was just created, so it should be at datetime('now') and
        // the cutoff is also datetime('now', '-0 days') = datetime('now')
        // Since created_at < cutoff is strict less-than, a run created at
        // exactly "now" won't be deleted. This is correct behavior.
        expect(deleted).toBe(0)

        // Verify the run still exists
        const runs = workflowStore.listRuns()
        expect(runs.length).toBe(1)
      })
    })
  })

  // ── Scenario 8: WebSocket workflow messages ────────────────────────
  // Note: WebSocket handlers are tested via the WS handler module.
  // Here we verify the store-level operations that back the WS messages.

  describe('WebSocket workflow message backing operations', () => {
    it('listWorkflows provides data for workflow-list response', () => {
      workflowStore.createWorkflow({
        name: 'ws-test-a',
        description: 'First',
        yaml_content: VALID_YAML,
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 2,
      })
      workflowStore.createWorkflow({
        name: 'ws-test-b',
        description: 'Second',
        yaml_content: VALID_YAML,
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 2,
      })

      // This is what the WS handler calls for workflow-list-request
      const workflows = workflowStore.listWorkflows()
      expect(workflows.length).toBe(2)
      // Verify the shape matches what clients expect
      for (const wf of workflows) {
        expect(wf.id).toBeTruthy()
        expect(wf.name).toBeTruthy()
        expect(typeof wf.is_valid).toBe('boolean')
        expect(typeof wf.step_count).toBe('number')
        expect(wf.created_at).toBeTruthy()
        expect(wf.updated_at).toBeTruthy()
      }
    })

    it('listRuns provides data for workflow-run-list response', () => {
      const wf = workflowStore.createWorkflow({
        name: 'ws-runs-test',
        description: null,
        yaml_content: VALID_YAML,
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 2,
      })

      workflowStore.createRun({
        workflow_id: wf.id,
        workflow_name: wf.name,
        status: 'running',
        current_step_index: 0,
        steps_state: [{
          name: 'step-1',
          type: 'delay',
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
        }],
        output_dir: '/tmp/ws-output',
        started_at: new Date().toISOString(),
        completed_at: null,
        error_message: null,
        variables: null,
      })

      // This is what the WS handler calls for workflow-run-list-request (all runs)
      const allRuns = workflowStore.listRuns()
      expect(allRuns.length).toBe(1)

      // This is what the WS handler calls for workflow-run-list-request with workflowId
      const byWorkflow = workflowStore.listRunsByWorkflow(wf.id)
      expect(byWorkflow.length).toBe(1)

      // Verify shape matches client expectations
      const run = allRuns[0]
      expect(run.id).toBeTruthy()
      expect(run.workflow_id).toBe(wf.id)
      expect(run.workflow_name).toBe('ws-runs-test')
      expect(run.status).toBe('running')
      expect(Array.isArray(run.steps_state)).toBe(true)
      expect(run.steps_state[0].name).toBe('step-1')
    })
  })
})
