import { describe, expect, test, afterEach } from 'bun:test'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { initWorkflowStore } from '../workflowStore'
import type { WorkflowStore } from '../workflowStore'
import type { StepRunState } from '../../shared/types'

function createTestStore(): { store: WorkflowStore; db: SQLiteDatabase } {
  const db = new SQLiteDatabase(':memory:')
  const store = initWorkflowStore(db)
  return { store, db }
}

function sampleStepsState(): StepRunState[] {
  return [
    {
      name: 'step-1',
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
    {
      name: 'step-2',
      type: 'check_file',
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

describe('workflowStore', () => {
  let store: WorkflowStore
  let db: SQLiteDatabase

  afterEach(() => {
    try {
      db.exec('DELETE FROM workflows')
      db.exec('DELETE FROM workflow_runs')
    } catch {
      // Tables may not exist if test failed during init
    }
  })

  function setup() {
    const result = createTestStore()
    store = result.store
    db = result.db
  }

  describe('workflow CRUD', () => {
    setup()

    test('createWorkflow returns a workflow with generated id', () => {
      const workflow = store.createWorkflow({
        name: 'my-pipeline',
        description: 'A test pipeline',
        yaml_content: 'name: my-pipeline\nsteps: []',
        file_path: '/tmp/my-pipeline.yaml',
        is_valid: true,
        validation_errors: [],
        step_count: 2,
      })

      expect(workflow.id).toBeTruthy()
      expect(workflow.name).toBe('my-pipeline')
      expect(workflow.description).toBe('A test pipeline')
      expect(workflow.yaml_content).toBe('name: my-pipeline\nsteps: []')
      expect(workflow.file_path).toBe('/tmp/my-pipeline.yaml')
      expect(workflow.is_valid).toBe(true)
      expect(workflow.validation_errors).toEqual([])
      expect(workflow.step_count).toBe(2)
      expect(workflow.created_at).toBeTruthy()
      expect(workflow.updated_at).toBeTruthy()
    })

    test('createWorkflow with validation errors', () => {
      const workflow = store.createWorkflow({
        name: 'invalid-pipeline',
        description: null,
        yaml_content: 'name: invalid\nsteps: bad',
        file_path: null,
        is_valid: false,
        validation_errors: ['Steps must be an array', 'Missing required field: type'],
        step_count: 0,
      })

      expect(workflow.is_valid).toBe(false)
      expect(workflow.validation_errors).toEqual(['Steps must be an array', 'Missing required field: type'])
      expect(workflow.description).toBeNull()
      expect(workflow.file_path).toBeNull()
    })

    test('getWorkflow returns workflow by id', () => {
      const created = store.createWorkflow({
        name: 'get-test',
        description: null,
        yaml_content: 'name: get-test',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 1,
      })

      const fetched = store.getWorkflow(created.id)
      expect(fetched).not.toBeNull()
      expect(fetched!.id).toBe(created.id)
      expect(fetched!.name).toBe('get-test')
    })

    test('getWorkflow returns null for non-existent id', () => {
      expect(store.getWorkflow('nonexistent')).toBeNull()
    })

    test('getWorkflowByName returns workflow by name', () => {
      store.createWorkflow({
        name: 'find-by-name',
        description: null,
        yaml_content: 'name: find-by-name',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 0,
      })

      const found = store.getWorkflowByName('find-by-name')
      expect(found).not.toBeNull()
      expect(found!.name).toBe('find-by-name')
    })

    test('getWorkflowByName returns null for unknown name', () => {
      expect(store.getWorkflowByName('unknown')).toBeNull()
    })

    test('updateWorkflow updates fields', () => {
      const workflow = store.createWorkflow({
        name: 'update-test',
        description: 'Original',
        yaml_content: 'name: update-test',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 1,
      })

      const updated = store.updateWorkflow(workflow.id, {
        description: 'Updated description',
        step_count: 3,
        is_valid: false,
        validation_errors: ['Some error'],
      })

      expect(updated).not.toBeNull()
      expect(updated!.description).toBe('Updated description')
      expect(updated!.step_count).toBe(3)
      expect(updated!.is_valid).toBe(false)
      expect(updated!.validation_errors).toEqual(['Some error'])
      // updated_at should be set
      expect(updated!.updated_at).toBeTruthy()
    })

    test('updateWorkflow with no fields returns current workflow', () => {
      const workflow = store.createWorkflow({
        name: 'no-update',
        description: null,
        yaml_content: 'name: no-update',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 0,
      })

      const same = store.updateWorkflow(workflow.id, {})
      expect(same).not.toBeNull()
      expect(same!.id).toBe(workflow.id)
    })

    test('deleteWorkflow removes workflow', () => {
      const workflow = store.createWorkflow({
        name: 'delete-me',
        description: null,
        yaml_content: 'name: delete-me',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 0,
      })

      expect(store.deleteWorkflow(workflow.id)).toBe(true)
      expect(store.getWorkflow(workflow.id)).toBeNull()
    })

    test('deleteWorkflow returns false for non-existent id', () => {
      expect(store.deleteWorkflow('nonexistent')).toBe(false)
    })

    test('workflow name uniqueness constraint', () => {
      store.createWorkflow({
        name: 'unique-name',
        description: null,
        yaml_content: 'name: unique-name',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 0,
      })

      expect(() => {
        store.createWorkflow({
          name: 'unique-name',
          description: null,
          yaml_content: 'name: unique-name',
          file_path: null,
          is_valid: true,
          validation_errors: [],
          step_count: 0,
        })
      }).toThrow()
    })
  })

  describe('listWorkflows', () => {
    setup()

    test('listWorkflows returns all workflows sorted by name', () => {
      store.createWorkflow({
        name: 'zebra-pipeline',
        description: null,
        yaml_content: 'name: zebra-pipeline',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 0,
      })
      store.createWorkflow({
        name: 'alpha-pipeline',
        description: null,
        yaml_content: 'name: alpha-pipeline',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 0,
      })

      const workflows = store.listWorkflows()
      expect(workflows).toHaveLength(2)
      expect(workflows[0].name).toBe('alpha-pipeline')
      expect(workflows[1].name).toBe('zebra-pipeline')
    })

    test('listWorkflows with valid filter', () => {
      store.createWorkflow({
        name: 'valid-one',
        description: null,
        yaml_content: 'name: valid-one',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 1,
      })
      store.createWorkflow({
        name: 'invalid-one',
        description: null,
        yaml_content: 'name: invalid-one',
        file_path: null,
        is_valid: false,
        validation_errors: ['error'],
        step_count: 0,
      })

      const valid = store.listWorkflows({ status: 'valid' })
      expect(valid).toHaveLength(1)
      expect(valid[0].name).toBe('valid-one')

      const invalid = store.listWorkflows({ status: 'invalid' })
      expect(invalid).toHaveLength(1)
      expect(invalid[0].name).toBe('invalid-one')
    })
  })

  describe('run CRUD', () => {
    setup()

    test('createRun returns a run with generated id', () => {
      const stepsState = sampleStepsState()
      const run = store.createRun({
        workflow_id: 'wf-123',
        workflow_name: 'my-pipeline',
        status: 'pending',
        current_step_index: 0,
        steps_state: stepsState,
        output_dir: '/tmp/workflow-output/run-1',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      expect(run.id).toBeTruthy()
      expect(run.workflow_id).toBe('wf-123')
      expect(run.workflow_name).toBe('my-pipeline')
      expect(run.status).toBe('pending')
      expect(run.current_step_index).toBe(0)
      expect(run.steps_state).toEqual(stepsState)
      expect(run.output_dir).toBe('/tmp/workflow-output/run-1')
      expect(run.started_at).toBeNull()
      expect(run.completed_at).toBeNull()
      expect(run.error_message).toBeNull()
      expect(run.created_at).toBeTruthy()
    })

    test('getRun returns run by id', () => {
      const run = store.createRun({
        workflow_id: 'wf-123',
        workflow_name: 'test',
        status: 'pending',
        current_step_index: 0,
        steps_state: sampleStepsState(),
        output_dir: '/tmp/out',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      const fetched = store.getRun(run.id)
      expect(fetched).not.toBeNull()
      expect(fetched!.id).toBe(run.id)
      expect(fetched!.steps_state).toHaveLength(2)
    })

    test('getRun returns null for non-existent id', () => {
      expect(store.getRun('nonexistent')).toBeNull()
    })

    test('updateRun updates fields', () => {
      const run = store.createRun({
        workflow_id: 'wf-123',
        workflow_name: 'test',
        status: 'pending',
        current_step_index: 0,
        steps_state: sampleStepsState(),
        output_dir: '/tmp/out',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      const updatedSteps = sampleStepsState()
      updatedSteps[0].status = 'running'
      updatedSteps[0].startedAt = '2026-01-01T00:00:00Z'

      const updated = store.updateRun(run.id, {
        status: 'running',
        current_step_index: 0,
        steps_state: updatedSteps,
        started_at: '2026-01-01T00:00:00Z',
      })

      expect(updated).not.toBeNull()
      expect(updated!.status).toBe('running')
      expect(updated!.started_at).toBe('2026-01-01T00:00:00Z')
      expect(updated!.steps_state[0].status).toBe('running')
    })

    test('updateRun with no fields returns current run', () => {
      const run = store.createRun({
        workflow_id: 'wf-123',
        workflow_name: 'test',
        status: 'pending',
        current_step_index: 0,
        steps_state: [],
        output_dir: '/tmp/out',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      const same = store.updateRun(run.id, {})
      expect(same).not.toBeNull()
      expect(same!.id).toBe(run.id)
    })

    test('run lifecycle: pending -> running -> completed', () => {
      const run = store.createRun({
        workflow_id: 'wf-123',
        workflow_name: 'lifecycle-test',
        status: 'pending',
        current_step_index: 0,
        steps_state: sampleStepsState(),
        output_dir: '/tmp/out',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })
      expect(run.status).toBe('pending')

      const running = store.updateRun(run.id, {
        status: 'running',
        started_at: '2026-01-01T00:00:00Z',
      })
      expect(running!.status).toBe('running')

      const completed = store.updateRun(run.id, {
        status: 'completed',
        completed_at: '2026-01-01T01:00:00Z',
        current_step_index: 2,
      })
      expect(completed!.status).toBe('completed')
      expect(completed!.completed_at).toBe('2026-01-01T01:00:00Z')
    })

    test('run lifecycle: pending -> running -> failed', () => {
      const run = store.createRun({
        workflow_id: 'wf-123',
        workflow_name: 'fail-test',
        status: 'pending',
        current_step_index: 0,
        steps_state: sampleStepsState(),
        output_dir: '/tmp/out',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      store.updateRun(run.id, { status: 'running', started_at: '2026-01-01T00:00:00Z' })

      const failed = store.updateRun(run.id, {
        status: 'failed',
        error_message: 'Step step-1 failed after 3 retries',
        completed_at: '2026-01-01T00:05:00Z',
      })
      expect(failed!.status).toBe('failed')
      expect(failed!.error_message).toBe('Step step-1 failed after 3 retries')
    })
  })

  describe('run queries', () => {
    setup()

    test('listRuns returns all runs', () => {
      store.createRun({
        workflow_id: 'wf-1',
        workflow_name: 'test-1',
        status: 'completed',
        current_step_index: 2,
        steps_state: [],
        output_dir: '/tmp/out-1',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })
      store.createRun({
        workflow_id: 'wf-2',
        workflow_name: 'test-2',
        status: 'pending',
        current_step_index: 0,
        steps_state: [],
        output_dir: '/tmp/out-2',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      const all = store.listRuns()
      expect(all).toHaveLength(2)
    })

    test('listRuns with status filter', () => {
      store.createRun({
        workflow_id: 'wf-1',
        workflow_name: 'test',
        status: 'running',
        current_step_index: 0,
        steps_state: [],
        output_dir: '/tmp/out-1',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })
      store.createRun({
        workflow_id: 'wf-2',
        workflow_name: 'test',
        status: 'completed',
        current_step_index: 0,
        steps_state: [],
        output_dir: '/tmp/out-2',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      const running = store.listRuns({ status: 'running' })
      expect(running).toHaveLength(1)
      expect(running[0].status).toBe('running')
    })

    test('listRuns with limit and offset', () => {
      for (let i = 0; i < 5; i++) {
        store.createRun({
          workflow_id: `wf-${i}`,
          workflow_name: `test-${i}`,
          status: 'completed',
          current_step_index: 0,
          steps_state: [],
          output_dir: `/tmp/out-${i}`,
          started_at: null,
          completed_at: null,
          error_message: null,
          variables: null,
        })
      }

      const page1 = store.listRuns({ limit: 2 })
      expect(page1).toHaveLength(2)

      const page2 = store.listRuns({ limit: 2, offset: 2 })
      expect(page2).toHaveLength(2)
    })

    test('listRunsByWorkflow returns runs for specific workflow', () => {
      store.createRun({
        workflow_id: 'wf-target',
        workflow_name: 'target',
        status: 'completed',
        current_step_index: 0,
        steps_state: [],
        output_dir: '/tmp/out-1',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })
      store.createRun({
        workflow_id: 'wf-other',
        workflow_name: 'other',
        status: 'completed',
        current_step_index: 0,
        steps_state: [],
        output_dir: '/tmp/out-2',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })
      store.createRun({
        workflow_id: 'wf-target',
        workflow_name: 'target',
        status: 'running',
        current_step_index: 1,
        steps_state: [],
        output_dir: '/tmp/out-3',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      const runs = store.listRunsByWorkflow('wf-target')
      expect(runs).toHaveLength(2)
      expect(runs.every(r => r.workflow_id === 'wf-target')).toBe(true)
    })

    test('getRunningRuns returns only running runs', () => {
      store.createRun({
        workflow_id: 'wf-1',
        workflow_name: 'test',
        status: 'running',
        current_step_index: 0,
        steps_state: [],
        output_dir: '/tmp/out-1',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })
      store.createRun({
        workflow_id: 'wf-2',
        workflow_name: 'test',
        status: 'completed',
        current_step_index: 0,
        steps_state: [],
        output_dir: '/tmp/out-2',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })
      store.createRun({
        workflow_id: 'wf-3',
        workflow_name: 'test',
        status: 'running',
        current_step_index: 1,
        steps_state: [],
        output_dir: '/tmp/out-3',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      const running = store.getRunningRuns()
      expect(running).toHaveLength(2)
      expect(running.every(r => r.status === 'running')).toBe(true)
    })
  })

  describe('deleteOldRuns', () => {
    setup()

    test('deleteOldRuns removes completed/failed/cancelled runs older than threshold', () => {
      // Insert a run with an old created_at directly via SQL
      db.exec(`
        INSERT INTO workflow_runs (id, workflow_id, workflow_name, status, current_step_index, steps_state, output_dir, created_at)
        VALUES ('old-run-1', 'wf-1', 'test', 'completed', 0, '[]', '/tmp/out', datetime('now', '-60 days'))
      `)
      db.exec(`
        INSERT INTO workflow_runs (id, workflow_id, workflow_name, status, current_step_index, steps_state, output_dir, created_at)
        VALUES ('old-run-2', 'wf-1', 'test', 'failed', 0, '[]', '/tmp/out', datetime('now', '-45 days'))
      `)
      // Recent run should not be deleted
      store.createRun({
        workflow_id: 'wf-1',
        workflow_name: 'test',
        status: 'completed',
        current_step_index: 0,
        steps_state: [],
        output_dir: '/tmp/out',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      const deleted = store.deleteOldRuns(30)
      expect(deleted).toBe(2)

      // Recent run should still exist
      const remaining = store.listRuns()
      expect(remaining).toHaveLength(1)
    })

    test('deleteOldRuns does not delete running runs', () => {
      db.exec(`
        INSERT INTO workflow_runs (id, workflow_id, workflow_name, status, current_step_index, steps_state, output_dir, created_at)
        VALUES ('old-running', 'wf-1', 'test', 'running', 0, '[]', '/tmp/out', datetime('now', '-60 days'))
      `)

      const deleted = store.deleteOldRuns(30)
      expect(deleted).toBe(0)

      const run = store.getRun('old-running')
      expect(run).not.toBeNull()
      expect(run!.status).toBe('running')
    })
  })

  describe('JSON handling', () => {
    setup()

    test('steps_state round-trips correctly through JSON', () => {
      const stepsState = sampleStepsState()
      stepsState[0].status = 'completed'
      stepsState[0].taskId = 'task-abc'
      stepsState[0].startedAt = '2026-01-01T00:00:00Z'
      stepsState[0].completedAt = '2026-01-01T00:05:00Z'

      const run = store.createRun({
        workflow_id: 'wf-json',
        workflow_name: 'json-test',
        status: 'running',
        current_step_index: 1,
        steps_state: stepsState,
        output_dir: '/tmp/out',
        started_at: '2026-01-01T00:00:00Z',
        completed_at: null,
        error_message: null,
        variables: null,
      })

      const fetched = store.getRun(run.id)
      expect(fetched!.steps_state).toHaveLength(2)
      expect(fetched!.steps_state[0].status).toBe('completed')
      expect(fetched!.steps_state[0].taskId).toBe('task-abc')
      expect(fetched!.steps_state[0].startedAt).toBe('2026-01-01T00:00:00Z')
      expect(fetched!.steps_state[1].status).toBe('pending')
    })

    test('validation_errors round-trips correctly through JSON', () => {
      const workflow = store.createWorkflow({
        name: 'json-errors-test',
        description: null,
        yaml_content: 'invalid yaml',
        file_path: null,
        is_valid: false,
        validation_errors: ['Error 1', 'Error 2', 'Error 3'],
        step_count: 0,
      })

      const fetched = store.getWorkflow(workflow.id)
      expect(fetched!.validation_errors).toEqual(['Error 1', 'Error 2', 'Error 3'])
    })

    test('empty validation_errors returns empty array', () => {
      const workflow = store.createWorkflow({
        name: 'no-errors',
        description: null,
        yaml_content: 'name: no-errors',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 0,
      })

      const fetched = store.getWorkflow(workflow.id)
      expect(fetched!.validation_errors).toEqual([])
    })
  })

  describe('NULL handling', () => {
    setup()

    test('workflow with all nullable fields as null', () => {
      const workflow = store.createWorkflow({
        name: 'minimal',
        description: null,
        yaml_content: 'name: minimal',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 0,
      })

      const fetched = store.getWorkflow(workflow.id)
      expect(fetched!.description).toBeNull()
      expect(fetched!.file_path).toBeNull()
    })

    test('run with all nullable fields as null', () => {
      const run = store.createRun({
        workflow_id: 'wf-1',
        workflow_name: 'test',
        status: 'pending',
        current_step_index: 0,
        steps_state: [],
        output_dir: '/tmp/out',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      const fetched = store.getRun(run.id)
      expect(fetched!.started_at).toBeNull()
      expect(fetched!.completed_at).toBeNull()
      expect(fetched!.error_message).toBeNull()
    })
  })

  describe('idempotent initialization', () => {
    test('initWorkflowStore can be called twice without error', () => {
      const testDb = new SQLiteDatabase(':memory:')
      initWorkflowStore(testDb)
      // Second call should not throw
      expect(() => initWorkflowStore(testDb)).not.toThrow()
    })

    test('additive migration works when tasks table exists', () => {
      const testDb = new SQLiteDatabase(':memory:')
      // Create tasks table first (simulating initTaskStore already ran)
      testDb.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          project_path TEXT NOT NULL,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `)

      // initWorkflowStore should add columns without error
      expect(() => initWorkflowStore(testDb)).not.toThrow()

      // Verify columns were added
      const columns = testDb.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]
      const colNames = columns.map(c => c.name)
      expect(colNames).toContain('workflow_run_id')
      expect(colNames).toContain('workflow_step_name')
    })

    test('additive migration is idempotent (columns already exist)', () => {
      const testDb = new SQLiteDatabase(':memory:')
      testDb.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          workflow_run_id TEXT,
          workflow_step_name TEXT
        );
      `)

      // Should not throw even though columns already exist
      expect(() => initWorkflowStore(testDb)).not.toThrow()
    })
  })
})
