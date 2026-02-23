import { describe, expect, test, afterEach } from 'bun:test'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { initWorkflowStore } from '../workflowStore'
import type { WorkflowStore } from '../workflowStore'

describe('CF-4: Amendment audit columns', () => {
  let store: WorkflowStore
  let db: SQLiteDatabase

  function setup() {
    db = new SQLiteDatabase(':memory:')
    store = initWorkflowStore(db)
  }

  afterEach(() => {
    try {
      db.close()
    } catch {
      // Database may already be closed
    }
  })

  test('Schema includes all 5 new audit columns', () => {
    setup()

    // Query schema to verify columns exist
    const columns = db.prepare("PRAGMA table_info(amendments)").all() as { name: string }[]
    const columnNames = columns.map(c => c.name)

    expect(columnNames).toContain('proposed_by')
    expect(columnNames).toContain('proposal_timestamp')
    expect(columnNames).toContain('approval_timestamp')
    expect(columnNames).toContain('rationale')
    expect(columnNames).toContain('target')
  })

  test('Migration adds columns to existing database', () => {
    // Create database with old schema (no audit columns)
    db = new SQLiteDatabase(':memory:')

    db.exec(`
      CREATE TABLE IF NOT EXISTS amendments (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_name TEXT NOT NULL,
        work_unit TEXT,
        signal_file TEXT NOT NULL,
        amendment_type TEXT NOT NULL,
        category TEXT NOT NULL,
        spec_section TEXT NOT NULL,
        issue TEXT NOT NULL,
        proposed_change TEXT,
        resolution TEXT,
        resolved_by TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)

    // Verify old schema doesn't have new columns
    const oldColumns = db.prepare("PRAGMA table_info(amendments)").all() as { name: string }[]
    const oldColumnNames = oldColumns.map(c => c.name)
    expect(oldColumnNames).not.toContain('proposed_by')

    // Run migration
    store = initWorkflowStore(db)

    // Verify new columns were added
    const newColumns = db.prepare("PRAGMA table_info(amendments)").all() as { name: string }[]
    const newColumnNames = newColumns.map(c => c.name)

    expect(newColumnNames).toContain('proposed_by')
    expect(newColumnNames).toContain('proposal_timestamp')
    expect(newColumnNames).toContain('approval_timestamp')
    expect(newColumnNames).toContain('rationale')
    expect(newColumnNames).toContain('target')
  })

  test('insertAmendment accepts and stores new audit fields', () => {
    setup()

    // Create a workflow and run (foreign key requirement)
    const workflow = store.createWorkflow({
      name: 'test-workflow',
      description: null,
      yaml_content: 'name: test',
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
      steps_state: [],
      output_dir: '/tmp/test',
      started_at: null,
      completed_at: null,
      error_message: null,
      variables: null,
    })

    // Insert amendment with all new fields
    const amendmentId = store.insertAmendment({
      run_id: run.id,
      step_name: 'test-step',
      work_unit: 'WU-001',
      signal_file: '/tmp/signal.json',
      amendment_type: 'quality',
      category: 'quality',
      spec_section: 'REQ-001',
      issue: 'Missing validation',
      proposed_change: 'Add validation logic',
      proposed_by: 'agent-producer',
      proposal_timestamp: 1234567890,
      approval_timestamp: 1234567900,
      rationale: 'Critical security requirement',
      target: 'spec',
    })

    // Retrieve and verify all fields
    const amendments = store.getAmendmentsByRun(run.id)
    expect(amendments).toHaveLength(1)

    const amendment = amendments[0]
    expect(amendment.id).toBe(amendmentId)
    expect(amendment.proposed_by).toBe('agent-producer')
    expect(amendment.proposal_timestamp).toBe(1234567890)
    expect(amendment.approval_timestamp).toBe(1234567900)
    expect(amendment.rationale).toBe('Critical security requirement')
    expect(amendment.target).toBe('spec')
  })

  test('insertAmendment works with null audit fields', () => {
    setup()

    const workflow = store.createWorkflow({
      name: 'test-workflow-null',
      description: null,
      yaml_content: 'name: test',
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
      steps_state: [],
      output_dir: '/tmp/test',
      started_at: null,
      completed_at: null,
      error_message: null,
      variables: null,
    })

    // Insert amendment without new fields (should default to null)
    const amendmentId = store.insertAmendment({
      run_id: run.id,
      step_name: 'test-step',
      signal_file: '/tmp/signal.json',
      amendment_type: 'quality',
      category: 'quality',
      spec_section: 'REQ-002',
      issue: 'Missing test',
    })

    const amendments = store.getAmendmentsByRun(run.id)
    expect(amendments).toHaveLength(1)

    const amendment = amendments[0]
    expect(amendment.id).toBe(amendmentId)
    expect(amendment.proposed_by).toBeNull()
    expect(amendment.proposal_timestamp).toBeNull()
    expect(amendment.approval_timestamp).toBeNull()
    expect(amendment.rationale).toBeNull()
    expect(amendment.target).toBeNull()
  })

  test('All audit fields can be queried and filtered', () => {
    setup()

    const workflow = store.createWorkflow({
      name: 'test-workflow-query',
      description: null,
      yaml_content: 'name: test',
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
      steps_state: [],
      output_dir: '/tmp/test',
      started_at: null,
      completed_at: null,
      error_message: null,
      variables: null,
    })

    // Insert multiple amendments with different audit data
    store.insertAmendment({
      run_id: run.id,
      step_name: 'step-1',
      signal_file: '/tmp/signal1.json',
      amendment_type: 'quality',
      category: 'quality',
      spec_section: 'REQ-001',
      issue: 'Issue 1',
      proposed_by: 'agent-A',
      proposal_timestamp: 1000,
      target: 'spec',
    })

    store.insertAmendment({
      run_id: run.id,
      step_name: 'step-2',
      signal_file: '/tmp/signal2.json',
      amendment_type: 'reconciliation',
      category: 'reconciliation',
      spec_section: 'REQ-002',
      issue: 'Issue 2',
      proposed_by: 'agent-B',
      proposal_timestamp: 2000,
      target: 'constitution',
    })

    // Verify we can query by new fields
    const specAmendments = db.prepare(
      "SELECT * FROM amendments WHERE run_id = ? AND target = 'spec'"
    ).all(run.id) as Record<string, unknown>[]

    expect(specAmendments).toHaveLength(1)
    expect(specAmendments[0].proposed_by).toBe('agent-A')

    const constitutionAmendments = db.prepare(
      "SELECT * FROM amendments WHERE run_id = ? AND target = 'constitution'"
    ).all(run.id) as Record<string, unknown>[]

    expect(constitutionAmendments).toHaveLength(1)
    expect(constitutionAmendments[0].proposed_by).toBe('agent-B')
  })

  test('Timestamps stored as integers and retrieved correctly', () => {
    setup()

    const workflow = store.createWorkflow({
      name: 'test-workflow-timestamp',
      description: null,
      yaml_content: 'name: test',
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
      steps_state: [],
      output_dir: '/tmp/test',
      started_at: null,
      completed_at: null,
      error_message: null,
      variables: null,
    })

    const proposalTs = Date.now()
    const approvalTs = proposalTs + 5000

    store.insertAmendment({
      run_id: run.id,
      step_name: 'test-step',
      signal_file: '/tmp/signal.json',
      amendment_type: 'quality',
      category: 'quality',
      spec_section: 'REQ-003',
      issue: 'Timestamp test',
      proposal_timestamp: proposalTs,
      approval_timestamp: approvalTs,
    })

    const amendments = store.getAmendmentsByRun(run.id)
    expect(amendments[0].proposal_timestamp).toBe(proposalTs)
    expect(amendments[0].approval_timestamp).toBe(approvalTs)
    expect(typeof amendments[0].proposal_timestamp).toBe('number')
    expect(typeof amendments[0].approval_timestamp).toBe('number')
  })
})
