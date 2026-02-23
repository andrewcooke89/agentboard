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
    test('initWorkflowStore enables WAL mode', () => {
      // WAL mode requires a file-based database (not :memory:)
      const tmpPath = `/tmp/test-wal-${Date.now()}.db`
      const testDb = new SQLiteDatabase(tmpPath)

      try {
        initWorkflowStore(testDb)

        // Verify WAL mode is active
        const result = testDb.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
        expect(result.journal_mode).toBe('wal')
      } finally {
        testDb.close()
        // Clean up test database
        try {
          const fs = require('fs')
          fs.unlinkSync(tmpPath)
          fs.unlinkSync(`${tmpPath}-shm`)
          fs.unlinkSync(`${tmpPath}-wal`)
        } catch {
          // Ignore cleanup errors
        }
      }
    })

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

  describe('signals table', () => {
    setup()

    test('TEST-31: insertSignal and getSignalsByRun', () => {
      // Create a workflow and run first (signals have FK to workflow_runs)
      const workflow = store.createWorkflow({
        name: 'signal-test',
        description: null,
        yaml_content: 'name: signal-test',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 2,
      })

      const run = store.createRun({
        workflow_id: workflow.id,
        workflow_name: workflow.name,
        status: 'running',
        current_step_index: 0,
        steps_state: sampleStepsState(),
        output_dir: '/tmp/workflow-output/signal-test',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      // Insert a signal
      store.insertSignal({
        id: 'signal-1',
        run_id: run.id,
        step_name: 'step-1',
        signal_type: 'approval_required',
        signal_file_path: '/tmp/signals/signal-1.json',
        resolution: null,
        resolution_file_path: null,
        resolved_at: null,
        synthetic: 0,
      })

      // Retrieve signals for the run
      const signals = store.getSignalsByRun(run.id)
      expect(signals).toHaveLength(1)
      expect(signals[0].id).toBe('signal-1')
      expect(signals[0].run_id).toBe(run.id)
      expect(signals[0].step_name).toBe('step-1')
      expect(signals[0].signal_type).toBe('approval_required')
      expect(signals[0].signal_file_path).toBe('/tmp/signals/signal-1.json')
      expect(signals[0].resolution).toBeNull()
      expect(signals[0].resolution_file_path).toBeNull()
      expect(signals[0].detected_at).toBeTruthy()
      expect(signals[0].resolved_at).toBeNull()
      expect(signals[0].synthetic).toBe(0)
    })

    test('TEST-32: getUnresolvedSignals', () => {
      const workflow = store.createWorkflow({
        name: 'unresolved-test',
        description: null,
        yaml_content: 'name: unresolved-test',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 2,
      })

      const run = store.createRun({
        workflow_id: workflow.id,
        workflow_name: workflow.name,
        status: 'running',
        current_step_index: 0,
        steps_state: sampleStepsState(),
        output_dir: '/tmp/workflow-output/unresolved-test',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      // Insert two signals
      store.insertSignal({
        id: 'signal-unres-1',
        run_id: run.id,
        step_name: 'step-1',
        signal_type: 'approval_required',
        signal_file_path: '/tmp/signals/signal-1.json',
        resolution: null,
        resolution_file_path: null,
        resolved_at: null,
        synthetic: 0,
      })

      store.insertSignal({
        id: 'signal-unres-2',
        run_id: run.id,
        step_name: 'step-2',
        signal_type: 'input_needed',
        signal_file_path: '/tmp/signals/signal-2.json',
        resolution: null,
        resolution_file_path: null,
        resolved_at: null,
        synthetic: 1,
      })

      // Resolve one signal
      store.resolveSignal('signal-unres-1', 'approved', '/tmp/signals/signal-1-resolution.json')

      // Get unresolved signals - should only return signal-unres-2
      const unresolvedSignals = store.getUnresolvedSignals(run.id)
      expect(unresolvedSignals).toHaveLength(1)
      expect(unresolvedSignals[0].id).toBe('signal-unres-2')
      expect(unresolvedSignals[0].resolved_at).toBeNull()
    })

    test('TEST-33: resolveSignal', () => {
      const workflow = store.createWorkflow({
        name: 'resolve-test',
        description: null,
        yaml_content: 'name: resolve-test',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 1,
      })

      const run = store.createRun({
        workflow_id: workflow.id,
        workflow_name: workflow.name,
        status: 'running',
        current_step_index: 0,
        steps_state: sampleStepsState(),
        output_dir: '/tmp/workflow-output/resolve-test',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      store.insertSignal({
        id: 'signal-resolve',
        run_id: run.id,
        step_name: 'step-1',
        signal_type: 'approval_required',
        signal_file_path: '/tmp/signals/signal-resolve.json',
        resolution: null,
        resolution_file_path: null,
        resolved_at: null,
        synthetic: 0,
      })

      // Resolve the signal
      store.resolveSignal('signal-resolve', 'approved', '/tmp/signals/resolution.json')

      // Verify resolution was set
      const signals = store.getSignalsByRun(run.id)
      expect(signals).toHaveLength(1)
      expect(signals[0].resolution).toBe('approved')
      expect(signals[0].resolution_file_path).toBe('/tmp/signals/resolution.json')
      expect(signals[0].resolved_at).toBeTruthy()
    })

    test('TEST-34: getSignalsByRun returns empty array for no signals', () => {
      const workflow = store.createWorkflow({
        name: 'no-signals-test',
        description: null,
        yaml_content: 'name: no-signals-test',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 1,
      })

      const run = store.createRun({
        workflow_id: workflow.id,
        workflow_name: workflow.name,
        status: 'running',
        current_step_index: 0,
        steps_state: sampleStepsState(),
        output_dir: '/tmp/workflow-output/no-signals',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      const signals = store.getSignalsByRun(run.id)
      expect(signals).toEqual([])
    })

    test('TEST-35: Multiple signals ordered by detected_at', () => {
      const workflow = store.createWorkflow({
        name: 'order-test',
        description: null,
        yaml_content: 'name: order-test',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 3,
      })

      const run = store.createRun({
        workflow_id: workflow.id,
        workflow_name: workflow.name,
        status: 'running',
        current_step_index: 0,
        steps_state: sampleStepsState(),
        output_dir: '/tmp/workflow-output/order-test',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      // Insert signals in order (they'll get detected_at timestamps)
      store.insertSignal({
        id: 'signal-first',
        run_id: run.id,
        step_name: 'step-1',
        signal_type: 'type-a',
        signal_file_path: '/tmp/signals/first.json',
        resolution: null,
        resolution_file_path: null,
        resolved_at: null,
        synthetic: 0,
      })

      store.insertSignal({
        id: 'signal-second',
        run_id: run.id,
        step_name: 'step-2',
        signal_type: 'type-b',
        signal_file_path: '/tmp/signals/second.json',
        resolution: null,
        resolution_file_path: null,
        resolved_at: null,
        synthetic: 0,
      })

      store.insertSignal({
        id: 'signal-third',
        run_id: run.id,
        step_name: 'step-3',
        signal_type: 'type-c',
        signal_file_path: '/tmp/signals/third.json',
        resolution: null,
        resolution_file_path: null,
        resolved_at: null,
        synthetic: 0,
      })

      // Get all signals - should be ordered by detected_at
      const signals = store.getSignalsByRun(run.id)
      expect(signals).toHaveLength(3)
      expect(signals[0].id).toBe('signal-first')
      expect(signals[1].id).toBe('signal-second')
      expect(signals[2].id).toBe('signal-third')

      // Verify detected_at is sequential (later entries should have later or equal timestamps)
      expect(signals[0].detected_at <= signals[1].detected_at).toBe(true)
      expect(signals[1].detected_at <= signals[2].detected_at).toBe(true)
    })
  })

  // ─── Phase 8: review_loop_iterations ──────────────────────────────────────

  describe('Phase 8: review_loop_iterations', () => {
    setup()

    test('Insert iteration and retrieve by step', () => {
      // Create workflow and run first (foreign key constraint)
      const workflow = store.createWorkflow({
        name: 'iteration-test',
        description: null,
        yaml_content: 'name: iteration-test',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 1,
      })

      const run = store.createRun({
        workflow_id: workflow.id,
        workflow_name: workflow.name,
        status: 'running',
        current_step_index: 0,
        steps_state: sampleStepsState(),
        output_dir: '/tmp/out',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      // Insert iteration
      store.insertIteration({
        id: 'iter-1',
        run_id: run.id,
        step_name: 'review-step',
        iteration: 1,
        producer_task_id: 'task-prod-1',
        reviewer_task_id: 'task-rev-1',
        verdict: 'NEEDS_FIX',
        feedback: 'Issues found',
        started_at: '2026-01-01T00:00:00Z',
        completed_at: '2026-01-01T00:05:00Z',
      })

      // Retrieve iterations
      const iterations = store.getIterationsByStep(run.id, 'review-step')
      expect(iterations).toHaveLength(1)
      expect(iterations[0].id).toBe('iter-1')
      expect(iterations[0].iteration).toBe(1)
      expect(iterations[0].producer_task_id).toBe('task-prod-1')
      expect(iterations[0].reviewer_task_id).toBe('task-rev-1')
      expect(iterations[0].verdict).toBe('NEEDS_FIX')
      expect(iterations[0].feedback).toBe('Issues found')
      expect(iterations[0].started_at).toBe('2026-01-01T00:00:00Z')
      expect(iterations[0].completed_at).toBe('2026-01-01T00:05:00Z')
    })

    test('Update iteration fields', () => {
      const workflow = store.createWorkflow({
        name: 'update-iter-test',
        description: null,
        yaml_content: 'name: update-iter-test',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 1,
      })

      const run = store.createRun({
        workflow_id: workflow.id,
        workflow_name: workflow.name,
        status: 'running',
        current_step_index: 0,
        steps_state: sampleStepsState(),
        output_dir: '/tmp/out',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      // Insert iteration with partial data
      store.insertIteration({
        id: 'iter-2',
        run_id: run.id,
        step_name: 'review-step',
        iteration: 1,
        producer_task_id: 'task-prod-2',
        reviewer_task_id: null,
        verdict: null,
        feedback: null,
        started_at: '2026-01-01T00:00:00Z',
        completed_at: null,
      })

      // Update iteration with verdict and feedback
      store.updateIteration('iter-2', {
        reviewer_task_id: 'task-rev-2',
        verdict: 'PASS',
        feedback: 'Looks good',
        completed_at: '2026-01-01T00:10:00Z',
      })

      // Verify update
      const iterations = store.getIterationsByStep(run.id, 'review-step')
      expect(iterations).toHaveLength(1)
      expect(iterations[0].reviewer_task_id).toBe('task-rev-2')
      expect(iterations[0].verdict).toBe('PASS')
      expect(iterations[0].feedback).toBe('Looks good')
      expect(iterations[0].completed_at).toBe('2026-01-01T00:10:00Z')
    })

    test('getLastCompletedIteration returns correct record', () => {
      const workflow = store.createWorkflow({
        name: 'last-iter-test',
        description: null,
        yaml_content: 'name: last-iter-test',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 1,
      })

      const run = store.createRun({
        workflow_id: workflow.id,
        workflow_name: workflow.name,
        status: 'running',
        current_step_index: 0,
        steps_state: sampleStepsState(),
        output_dir: '/tmp/out',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      // Insert multiple iterations
      store.insertIteration({
        id: 'iter-3a',
        run_id: run.id,
        step_name: 'review-step',
        iteration: 1,
        producer_task_id: 'task-p-1',
        reviewer_task_id: 'task-r-1',
        verdict: 'NEEDS_FIX',
        feedback: 'First attempt',
        started_at: '2026-01-01T00:00:00Z',
        completed_at: '2026-01-01T00:05:00Z',
      })

      store.insertIteration({
        id: 'iter-3b',
        run_id: run.id,
        step_name: 'review-step',
        iteration: 2,
        producer_task_id: 'task-p-2',
        reviewer_task_id: 'task-r-2',
        verdict: 'PASS',
        feedback: 'Second attempt',
        started_at: '2026-01-01T00:10:00Z',
        completed_at: '2026-01-01T00:15:00Z',
      })

      // Insert incomplete iteration
      store.insertIteration({
        id: 'iter-3c',
        run_id: run.id,
        step_name: 'review-step',
        iteration: 3,
        producer_task_id: 'task-p-3',
        reviewer_task_id: null,
        verdict: null,
        feedback: null,
        started_at: '2026-01-01T00:20:00Z',
        completed_at: null,
      })

      // Get last completed - should be iteration 2
      const lastCompleted = store.getLastCompletedIteration(run.id, 'review-step')
      expect(lastCompleted).not.toBeNull()
      expect(lastCompleted!.iteration).toBe(2)
      expect(lastCompleted!.verdict).toBe('PASS')
      expect(lastCompleted!.completed_at).toBe('2026-01-01T00:15:00Z')
    })

    test('getIterationsByStep returns ordered by iteration ASC', () => {
      const workflow = store.createWorkflow({
        name: 'order-iter-test',
        description: null,
        yaml_content: 'name: order-iter-test',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 1,
      })

      const run = store.createRun({
        workflow_id: workflow.id,
        workflow_name: workflow.name,
        status: 'running',
        current_step_index: 0,
        steps_state: sampleStepsState(),
        output_dir: '/tmp/out',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      // Insert iterations out of order
      store.insertIteration({
        id: 'iter-4c',
        run_id: run.id,
        step_name: 'review-step',
        iteration: 3,
        producer_task_id: 'task-p-3',
        reviewer_task_id: 'task-r-3',
        verdict: 'PASS',
        feedback: null,
        started_at: '2026-01-01T00:20:00Z',
        completed_at: '2026-01-01T00:25:00Z',
      })

      store.insertIteration({
        id: 'iter-4a',
        run_id: run.id,
        step_name: 'review-step',
        iteration: 1,
        producer_task_id: 'task-p-1',
        reviewer_task_id: 'task-r-1',
        verdict: 'NEEDS_FIX',
        feedback: null,
        started_at: '2026-01-01T00:00:00Z',
        completed_at: '2026-01-01T00:05:00Z',
      })

      store.insertIteration({
        id: 'iter-4b',
        run_id: run.id,
        step_name: 'review-step',
        iteration: 2,
        producer_task_id: 'task-p-2',
        reviewer_task_id: 'task-r-2',
        verdict: 'NEEDS_FIX',
        feedback: null,
        started_at: '2026-01-01T00:10:00Z',
        completed_at: '2026-01-01T00:15:00Z',
      })

      // Get iterations - should be ordered by iteration number
      const iterations = store.getIterationsByStep(run.id, 'review-step')
      expect(iterations).toHaveLength(3)
      expect(iterations[0].iteration).toBe(1)
      expect(iterations[1].iteration).toBe(2)
      expect(iterations[2].iteration).toBe(3)
    })

    test('Multiple iterations for same step', () => {
      const workflow = store.createWorkflow({
        name: 'multi-iter-test',
        description: null,
        yaml_content: 'name: multi-iter-test',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 1,
      })

      const run = store.createRun({
        workflow_id: workflow.id,
        workflow_name: workflow.name,
        status: 'running',
        current_step_index: 0,
        steps_state: sampleStepsState(),
        output_dir: '/tmp/out',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      // Insert 5 iterations
      for (let i = 1; i <= 5; i++) {
        store.insertIteration({
          id: `iter-5-${i}`,
          run_id: run.id,
          step_name: 'review-step',
          iteration: i,
          producer_task_id: `task-p-${i}`,
          reviewer_task_id: `task-r-${i}`,
          verdict: i === 5 ? 'PASS' : 'NEEDS_FIX',
          feedback: `Iteration ${i}`,
          started_at: `2026-01-01T00:${String(i * 10).padStart(2, '0')}:00Z`,
          completed_at: `2026-01-01T00:${String(i * 10 + 5).padStart(2, '0')}:00Z`,
        })
      }

      const iterations = store.getIterationsByStep(run.id, 'review-step')
      expect(iterations).toHaveLength(5)
      expect(iterations[4].verdict).toBe('PASS')

      const lastCompleted = store.getLastCompletedIteration(run.id, 'review-step')
      expect(lastCompleted!.iteration).toBe(5)
    })

    test('getIterationsByStep returns empty array for no iterations', () => {
      const workflow = store.createWorkflow({
        name: 'no-iter-test',
        description: null,
        yaml_content: 'name: no-iter-test',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 1,
      })

      const run = store.createRun({
        workflow_id: workflow.id,
        workflow_name: workflow.name,
        status: 'running',
        current_step_index: 0,
        steps_state: sampleStepsState(),
        output_dir: '/tmp/out',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      const iterations = store.getIterationsByStep(run.id, 'nonexistent-step')
      expect(iterations).toEqual([])
    })

    test('getLastCompletedIteration returns null when no completed iterations', () => {
      const workflow = store.createWorkflow({
        name: 'incomplete-iter-test',
        description: null,
        yaml_content: 'name: incomplete-iter-test',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 1,
      })

      const run = store.createRun({
        workflow_id: workflow.id,
        workflow_name: workflow.name,
        status: 'running',
        current_step_index: 0,
        steps_state: sampleStepsState(),
        output_dir: '/tmp/out',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      // Insert incomplete iteration
      store.insertIteration({
        id: 'iter-7',
        run_id: run.id,
        step_name: 'review-step',
        iteration: 1,
        producer_task_id: 'task-p-1',
        reviewer_task_id: null,
        verdict: null,
        feedback: null,
        started_at: '2026-01-01T00:00:00Z',
        completed_at: null,
      })

      const lastCompleted = store.getLastCompletedIteration(run.id, 'review-step')
      expect(lastCompleted).toBeNull()
    })

    test('Partial update preserves existing fields', () => {
      const workflow = store.createWorkflow({
        name: 'partial-update-test',
        description: null,
        yaml_content: 'name: partial-update-test',
        file_path: null,
        is_valid: true,
        validation_errors: [],
        step_count: 1,
      })

      const run = store.createRun({
        workflow_id: workflow.id,
        workflow_name: workflow.name,
        status: 'running',
        current_step_index: 0,
        steps_state: sampleStepsState(),
        output_dir: '/tmp/out',
        started_at: null,
        completed_at: null,
        error_message: null,
        variables: null,
      })

      store.insertIteration({
        id: 'iter-8',
        run_id: run.id,
        step_name: 'review-step',
        iteration: 1,
        producer_task_id: 'original-producer',
        reviewer_task_id: 'original-reviewer',
        verdict: 'NEEDS_FIX',
        feedback: 'Original feedback',
        started_at: '2026-01-01T00:00:00Z',
        completed_at: null,
      })

      // Update only verdict
      store.updateIteration('iter-8', {
        verdict: 'PASS',
      })

      const iterations = store.getIterationsByStep(run.id, 'review-step')
      expect(iterations[0].verdict).toBe('PASS')
      expect(iterations[0].producer_task_id).toBe('original-producer')
      expect(iterations[0].reviewer_task_id).toBe('original-reviewer')
      expect(iterations[0].feedback).toBe('Original feedback')
    })
  })
})
