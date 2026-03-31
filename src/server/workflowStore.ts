// workflowStore.ts - SQLite CRUD for workflow definitions and workflow runs
import { Database as SQLiteDatabase } from 'bun:sqlite'
import type { WorkflowDefinition, WorkflowRun, WorkflowStatus, StepRunState } from '../shared/types'

export interface SignalRecord {
  id: string
  run_id: string
  step_name: string
  signal_type: string
  signal_file_path: string
  resolution: string | null
  resolution_file_path: string | null
  detected_at: string
  resolved_at: string | null
  synthetic: number  // SQLite integer boolean: 0 or 1
}

export interface ReviewLoopIterationRecord {
  id: string
  run_id: string
  step_name: string
  iteration: number
  producer_task_id: string | null
  reviewer_task_id: string | null
  verdict: string | null
  feedback: string | null
  started_at: string
  completed_at: string | null
  producer_completed_at?: string | null
}

export interface WorkflowStore {
  createWorkflow: (workflow: Omit<WorkflowDefinition, 'id' | 'created_at' | 'updated_at'>) => WorkflowDefinition
  getWorkflow: (id: string) => WorkflowDefinition | null
  getWorkflowByName: (name: string) => WorkflowDefinition | null
  updateWorkflow: (id: string, fields: Partial<Omit<WorkflowDefinition, 'id' | 'created_at'>>) => WorkflowDefinition | null
  deleteWorkflow: (id: string) => boolean
  listWorkflows: (filters?: { status?: 'valid' | 'invalid' }) => WorkflowDefinition[]

  createRun: (run: Omit<WorkflowRun, 'id' | 'created_at'>) => WorkflowRun
  getRun: (id: string) => WorkflowRun | null
  updateRun: (id: string, fields: Partial<Omit<WorkflowRun, 'id' | 'workflow_id' | 'workflow_name' | 'created_at'>>) => WorkflowRun | null
  listRuns: (filters?: { status?: WorkflowStatus; limit?: number; offset?: number }) => WorkflowRun[]
  listRunsByWorkflow: (workflowId: string) => WorkflowRun[]
  getRunningRuns: () => WorkflowRun[]
  hasActiveRunsForWorkflow: (workflowId: string) => boolean
  createRunIfUnderLimit: (run: Omit<WorkflowRun, 'id' | 'created_at'>, maxConcurrent: number) => WorkflowRun | null
  deleteOldRuns: (olderThanDays: number) => number

  insertSignal: (record: Omit<SignalRecord, 'detected_at'>) => void
  getSignalsByRun: (runId: string) => SignalRecord[]
  getUnresolvedSignals: (runId: string) => SignalRecord[]
  resolveSignal: (signalId: string, resolution: string, resolutionFilePath: string | null) => void

  // Phase 10: Amendment budget methods
  initRunBudgets: (runId: string, budgetConfig: { quality?: { per_run?: number }; reconciliation?: { per_run?: number } }) => void
  initWorkUnitBudgets: (runId: string, workUnit: string, budgetConfig: { quality?: { per_work_unit?: number }; reconciliation?: { per_work_unit?: number } }) => void
  getBudget: (runId: string, workUnit: string | null, category: string) => { id: string; used: number; max_allowed: number; category: string } | null
  checkAndIncrementBudget: (runId: string, workUnit: string | null, category: string) => { allowed: boolean; used: number; max: number }
  overrideBudget: (runId: string, category: string, newMax: number, workUnit?: string | null) => void
  getAmendmentsByRun: (runId: string) => ReturnType<typeof mapAmendmentRow>[]
  getAmendmentsBySection: (runId: string, specSection: string) => ReturnType<typeof mapAmendmentRow>[]
  insertAmendment: (record: { run_id: string; step_name: string; work_unit?: string; signal_file: string; amendment_type: string; category: string; spec_section: string; issue: string; proposed_change?: string; proposed_by?: string; proposal_timestamp?: number; approval_timestamp?: number; rationale?: string; target?: string }) => string
  resolveAmendment: (id: string, resolution: string, resolvedBy: string) => void

  insertIteration: (record: ReviewLoopIterationRecord) => void
  updateIteration: (id: string, fields: Partial<Pick<ReviewLoopIterationRecord, 'producer_task_id' | 'reviewer_task_id' | 'verdict' | 'feedback' | 'completed_at' | 'producer_completed_at'>>) => void
  // ROBUSTNESS-1 (REQ-36): Atomic DB-first iteration increment -- prevents desync on crash
  incrementAndInsertIteration: (runId: string, stepName: string, currentIteration: number) => { nextIteration: number; iterationId: string }
  getIterationsByStep: (runId: string, stepName: string) => ReviewLoopIterationRecord[]
  getLastCompletedIteration: (runId: string, stepName: string) => ReviewLoopIterationRecord | null
  getLastIteration: (runId: string, stepName: string) => ReviewLoopIterationRecord | null
  updateIterationProducerCompleted: (runId: string, stepName: string, iteration: number, timestamp: string) => void

  close: () => void
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function nullableString(val: unknown): string | null {
  return val === null || val === undefined ? null : String(val)
}

function parseJsonArray(val: unknown): string[] {
  if (val === null || val === undefined || val === '') return []
  try {
    const parsed = JSON.parse(String(val))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseStepsState(val: unknown): StepRunState[] {
  if (val === null || val === undefined || val === '') return []
  try {
    const parsed = JSON.parse(String(val))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseJsonObject(val: unknown): Record<string, string> | null {
  if (val === null || val === undefined || val === '') return null
  try {
    const parsed = JSON.parse(String(val))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function mapWorkflowRow(row: Record<string, unknown>): WorkflowDefinition {
  return {
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    description: nullableString(row.description),
    yaml_content: String(row.yaml_content ?? ''),
    file_path: nullableString(row.file_path),
    is_valid: Number(row.is_valid) === 1,
    validation_errors: parseJsonArray(row.validation_errors),
    step_count: Number(row.step_count ?? 0),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  }
}

function mapRunRow(row: Record<string, unknown>): WorkflowRun {
  return {
    id: String(row.id ?? ''),
    workflow_id: String(row.workflow_id ?? ''),
    workflow_name: String(row.workflow_name ?? ''),
    status: String(row.status ?? 'pending') as WorkflowStatus,
    current_step_index: Number(row.current_step_index ?? 0),
    steps_state: parseStepsState(row.steps_state),
    output_dir: String(row.output_dir ?? ''),
    started_at: nullableString(row.started_at),
    completed_at: nullableString(row.completed_at),
    error_message: nullableString(row.error_message),
    variables: parseJsonObject(row.variables),
    created_at: String(row.created_at ?? ''),
  }
}

function mapSignalRow(row: Record<string, unknown>): SignalRecord {
  return {
    id: String(row.id ?? ''),
    run_id: String(row.run_id ?? ''),
    step_name: String(row.step_name ?? ''),
    signal_type: String(row.signal_type ?? ''),
    signal_file_path: String(row.signal_file_path ?? ''),
    resolution: nullableString(row.resolution),
    resolution_file_path: nullableString(row.resolution_file_path),
    detected_at: String(row.detected_at ?? ''),
    resolved_at: nullableString(row.resolved_at),
    synthetic: Number(row.synthetic ?? 0),
  }
}

function mapReviewIterationRow(row: Record<string, unknown>): ReviewLoopIterationRecord {
  return {
    id: String(row.id),
    run_id: String(row.run_id),
    step_name: String(row.step_name),
    iteration: Number(row.iteration),
    producer_task_id: row.producer_task_id ? String(row.producer_task_id) : null,
    reviewer_task_id: row.reviewer_task_id ? String(row.reviewer_task_id) : null,
    verdict: row.verdict ? String(row.verdict) : null,
    feedback: row.feedback ? String(row.feedback) : null,
    started_at: String(row.started_at),
    completed_at: row.completed_at ? String(row.completed_at) : null,
    producer_completed_at: row.producer_completed_at ? String(row.producer_completed_at) : null,
  }
}

function mapAmendmentRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    run_id: String(row.run_id),
    step_name: String(row.step_name),
    work_unit: row.work_unit ? String(row.work_unit) : null,
    signal_file: String(row.signal_file),
    amendment_type: String(row.amendment_type),
    category: String(row.category),
    spec_section: String(row.spec_section),
    issue: String(row.issue),
    proposed_change: row.proposed_change ? String(row.proposed_change) : null,
    resolution: row.resolution ? String(row.resolution) : null,
    resolved_by: row.resolved_by ? String(row.resolved_by) : null,
    resolved_at: row.resolved_at ? String(row.resolved_at) : null,
    created_at: String(row.created_at),
    proposed_by: row.proposed_by ? String(row.proposed_by) : null,
    proposal_timestamp: row.proposal_timestamp ? Number(row.proposal_timestamp) : null,
    approval_timestamp: row.approval_timestamp ? Number(row.approval_timestamp) : null,
    rationale: row.rationale ? String(row.rationale) : null,
    target: row.target ? String(row.target) : null,
  }
}

// Whitelists for dynamic UPDATE queries (SQL injection prevention)
const ALLOWED_WORKFLOW_COLUMNS = new Set([
  'name',
  'description',
  'yaml_content',
  'file_path',
  'is_valid',
  'validation_errors',
  'step_count',
  'updated_at',
])

const ALLOWED_RUN_COLUMNS = new Set([
  'status',
  'current_step_index',
  'steps_state',
  'output_dir',
  'started_at',
  'completed_at',
  'error_message',
  'variables',
])

const _ALLOWED_SIGNAL_COLUMNS = new Set([
  'id', 'run_id', 'step_name', 'signal_type', 'signal_file_path',
  'resolution', 'resolution_file_path', 'detected_at', 'resolved_at', 'synthetic'
])

export function initWorkflowStore(db: SQLiteDatabase): WorkflowStore {
  // Enable WAL mode for concurrent reads (REQ-50)
  db.exec('PRAGMA journal_mode = WAL')

  // Create tables (additive -- safe to run multiple times)
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      yaml_content TEXT NOT NULL,
      file_path TEXT,
      is_valid INTEGER NOT NULL DEFAULT 1,
      validation_errors TEXT,
      step_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      workflow_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      current_step_index INTEGER NOT NULL DEFAULT 0,
      steps_state TEXT NOT NULL,
      output_dir TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_name TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      signal_file_path TEXT NOT NULL,
      resolution TEXT,
      resolution_file_path TEXT,
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      synthetic INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
    );
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_workflows_name ON workflows(name);
    CREATE INDEX IF NOT EXISTS idx_workflows_valid ON workflows(is_valid);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
    CREATE INDEX IF NOT EXISTS idx_signals_run ON signals(run_id);
    CREATE INDEX IF NOT EXISTS idx_signals_unresolved ON signals(run_id, resolved_at) WHERE resolved_at IS NULL;
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS amendment_budget (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      work_unit TEXT,
      category TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      max_allowed INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_amendment_budget_run ON amendment_budget(run_id);

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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      proposed_by TEXT,
      proposal_timestamp INTEGER,
      approval_timestamp INTEGER,
      rationale TEXT,
      target TEXT,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_amendments_run ON amendments(run_id);
    CREATE INDEX IF NOT EXISTS idx_amendments_section ON amendments(run_id, spec_section);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS review_loop_iterations (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_name TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      producer_task_id TEXT,
      reviewer_task_id TEXT,
      verdict TEXT,
      feedback TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
    );
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_review_iterations ON review_loop_iterations(run_id, step_name, iteration);
  `)

  // Phase 24: Branch isolation, output invalidation, and telemetry tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_branches (
      run_id TEXT PRIMARY KEY,
      worktree_path TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      cleanup_after INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_branches_cleanup ON run_branches(cleanup_after);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS step_outputs (
      run_id TEXT NOT NULL,
      step_name TEXT NOT NULL,
      output_hash TEXT NOT NULL,
      valid INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, step_name)
    );
    CREATE INDEX IF NOT EXISTS idx_step_outputs_valid ON step_outputs(run_id, valid);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_runs (
      run_id TEXT PRIMARY KEY,
      pipeline_type TEXT NOT NULL,
      tier INTEGER NOT NULL,
      total_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL DEFAULT 0,
      wall_clock_ms INTEGER,
      quality_score REAL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_runs_date ON telemetry_runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_telemetry_runs_pipeline ON telemetry_runs(pipeline_type);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      step_name TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      duration_ms INTEGER,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_steps_run ON telemetry_steps(run_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_steps_run_time ON telemetry_steps(run_id, started_at);
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_daily (
      date TEXT PRIMARY KEY,
      total_runs INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      total_cost_usd REAL DEFAULT 0,
      avg_wall_clock_ms REAL,
      avg_quality_score REAL
    );
  `)

  // Additive migration: add workflow columns to tasks table
  try { db.exec('ALTER TABLE tasks ADD COLUMN workflow_run_id TEXT') } catch { /* column may already exist */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN workflow_step_name TEXT') } catch { /* column may already exist */ }
  try { db.exec('ALTER TABLE workflow_runs ADD COLUMN variables TEXT') } catch { /* column may already exist */ }
  // P-5: Additive migration for producer duration tracking
  try { db.exec('ALTER TABLE review_loop_iterations ADD COLUMN producer_completed_at TEXT') } catch { /* column may already exist */ }
  // CF-4: Additive migration for amendment audit columns (REQ-26, REQ-38)
  try { db.exec('ALTER TABLE amendments ADD COLUMN proposed_by TEXT') } catch { /* column may already exist */ }
  try { db.exec('ALTER TABLE amendments ADD COLUMN proposal_timestamp INTEGER') } catch { /* column may already exist */ }
  try { db.exec('ALTER TABLE amendments ADD COLUMN approval_timestamp INTEGER') } catch { /* column may already exist */ }
  try { db.exec('ALTER TABLE amendments ADD COLUMN rationale TEXT') } catch { /* column may already exist */ }
  try { db.exec('ALTER TABLE amendments ADD COLUMN target TEXT') } catch { /* column may already exist */ }

  // Prepared statements - workflows
  const insertWorkflow = db.prepare(
    `INSERT INTO workflows (id, name, description, yaml_content, file_path, is_valid, validation_errors, step_count)
     VALUES ($id, $name, $description, $yamlContent, $filePath, $isValid, $validationErrors, $stepCount)`
  )
  const selectWorkflowById = db.prepare('SELECT * FROM workflows WHERE id = $id')
  const selectWorkflowByName = db.prepare('SELECT * FROM workflows WHERE name = $name')
  const deleteWorkflowById = db.prepare('DELETE FROM workflows WHERE id = $id')

  // Prepared statements - runs
  const insertRun = db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, workflow_name, status, current_step_index, steps_state, output_dir, started_at, completed_at, error_message, variables)
     VALUES ($id, $workflowId, $workflowName, $status, $currentStepIndex, $stepsState, $outputDir, $startedAt, $completedAt, $errorMessage, $variables)`
  )
  const selectRunById = db.prepare('SELECT * FROM workflow_runs WHERE id = $id')
  const selectRunsByWorkflow = db.prepare('SELECT * FROM workflow_runs WHERE workflow_id = $workflowId ORDER BY created_at DESC')
  const selectRunningRuns = db.prepare("SELECT * FROM workflow_runs WHERE status = 'running'")
  const deleteOldRunsStmt = db.prepare(
    `DELETE FROM workflow_runs
     WHERE status IN ('completed', 'failed', 'cancelled')
       AND created_at < datetime('now', $olderThan)
     RETURNING id`
  )

  // Prepared statements - signals
  const insertSignal = db.prepare(
    `INSERT INTO signals (id, run_id, step_name, signal_type, signal_file_path, resolution, resolution_file_path, resolved_at, synthetic)
     VALUES ($id, $runId, $stepName, $signalType, $signalFilePath, $resolution, $resolutionFilePath, $resolvedAt, $synthetic)`
  )
  const selectSignalsByRun = db.prepare('SELECT * FROM signals WHERE run_id = $runId ORDER BY detected_at ASC')
  const selectUnresolvedSignals = db.prepare('SELECT * FROM signals WHERE run_id = $runId AND resolved_at IS NULL ORDER BY detected_at ASC')
  const updateResolveSignal = db.prepare(
    `UPDATE signals SET resolution = $resolution, resolution_file_path = $resolutionFilePath, resolved_at = datetime('now') WHERE id = $id`
  )

  // Phase 10: Amendment budget statements
  const insertBudget = db.prepare(
    `INSERT INTO amendment_budget (id, run_id, work_unit, category, used, max_allowed)
     VALUES ($id, $runId, $workUnit, $category, $used, $maxAllowed)`
  )
  const selectBudget = db.prepare(
    `SELECT * FROM amendment_budget WHERE run_id = $runId AND category = $category AND (work_unit = $workUnit OR ($workUnit IS NULL AND work_unit IS NULL))`
  )
  const updateBudgetUsed = db.prepare(
    `UPDATE amendment_budget SET used = used + 1 WHERE id = $id AND used < max_allowed`
  )
  const updateBudgetMax = db.prepare(
    `UPDATE amendment_budget SET max_allowed = $newMax WHERE run_id = $runId AND category = $category AND (work_unit = $workUnit OR ($workUnit IS NULL AND work_unit IS NULL))`
  )

  // Phase 10: Amendment record statements
  const insertAmendment = db.prepare(
    `INSERT INTO amendments (id, run_id, step_name, work_unit, signal_file, amendment_type, category, spec_section, issue, proposed_change, created_at, proposed_by, proposal_timestamp, approval_timestamp, rationale, target)
     VALUES ($id, $runId, $stepName, $workUnit, $signalFile, $amendmentType, $category, $specSection, $issue, $proposedChange, $createdAt, $proposedBy, $proposalTimestamp, $approvalTimestamp, $rationale, $target)`
  )
  const selectAmendmentsByRun = db.prepare('SELECT * FROM amendments WHERE run_id = $runId ORDER BY created_at')
  const selectAmendmentsBySection = db.prepare('SELECT * FROM amendments WHERE run_id = $runId AND spec_section = $specSection ORDER BY created_at')
  const updateAmendmentResolution = db.prepare(
    `UPDATE amendments SET resolution = $resolution, resolved_by = $resolvedBy, resolved_at = $resolvedAt WHERE id = $id`
  )

  // Prepared statements - review loop iterations
  const insertReviewIteration = db.prepare(
    `INSERT INTO review_loop_iterations (id, run_id, step_name, iteration, producer_task_id, reviewer_task_id, verdict, feedback, started_at, completed_at, producer_completed_at)
     VALUES ($id, $runId, $stepName, $iteration, $producerTaskId, $reviewerTaskId, $verdict, $feedback, $startedAt, $completedAt, $producerCompletedAt)`
  )
  const updateReviewIteration = db.prepare(
    `UPDATE review_loop_iterations SET producer_task_id = COALESCE($producerTaskId, producer_task_id), reviewer_task_id = COALESCE($reviewerTaskId, reviewer_task_id), verdict = COALESCE($verdict, verdict), feedback = COALESCE($feedback, feedback), completed_at = COALESCE($completedAt, completed_at), producer_completed_at = COALESCE($producerCompletedAt, producer_completed_at) WHERE id = $id`
  )
  const selectIterationsByStep = db.prepare(
    'SELECT * FROM review_loop_iterations WHERE run_id = $runId AND step_name = $stepName ORDER BY iteration ASC'
  )
  const selectLastCompletedIteration = db.prepare(
    'SELECT * FROM review_loop_iterations WHERE run_id = $runId AND step_name = $stepName AND completed_at IS NOT NULL ORDER BY iteration DESC LIMIT 1'
  )
  // P-2: Select the most recent iteration (completed or not) for crash recovery
  const selectLastIteration = db.prepare(
    'SELECT * FROM review_loop_iterations WHERE run_id = $runId AND step_name = $stepName ORDER BY iteration DESC LIMIT 1'
  )
  // P-5: Update producer_completed_at by composite key
  const updateProducerCompleted = db.prepare(
    `UPDATE review_loop_iterations SET producer_completed_at = $timestamp WHERE run_id = $runId AND step_name = $stepName AND iteration = $iteration`
  )

  return {
    createWorkflow: (workflow) => {
      const id = generateId()
      insertWorkflow.run({
        $id: id,
        $name: workflow.name,
        $description: workflow.description ?? null,
        $yamlContent: workflow.yaml_content,
        $filePath: workflow.file_path ?? null,
        $isValid: workflow.is_valid ? 1 : 0,
        $validationErrors: Array.isArray(workflow.validation_errors) && workflow.validation_errors.length > 0
          ? JSON.stringify(workflow.validation_errors.map(e => String(e).slice(0, 1000)))
          : null,
        $stepCount: workflow.step_count,
      })
      const row = selectWorkflowById.get({ $id: id }) as Record<string, unknown> | undefined
      if (!row) throw new Error('Failed to insert workflow')
      return mapWorkflowRow(row)
    },

    getWorkflow: (id) => {
      const row = selectWorkflowById.get({ $id: id }) as Record<string, unknown> | undefined
      return row ? mapWorkflowRow(row) : null
    },

    getWorkflowByName: (name) => {
      const row = selectWorkflowByName.get({ $name: name }) as Record<string, unknown> | undefined
      return row ? mapWorkflowRow(row) : null
    },

    updateWorkflow: (id, fields) => {
      const fieldMap: Record<string, string> = {
        name: 'name',
        description: 'description',
        yaml_content: 'yaml_content',
        file_path: 'file_path',
        is_valid: 'is_valid',
        validation_errors: 'validation_errors',
        step_count: 'step_count',
        updated_at: 'updated_at',
      }

      // Filter to only allowed columns (SQL injection prevention)
      const entries = Object.entries(fields)
        .filter(([key, v]) => v !== undefined && ALLOWED_WORKFLOW_COLUMNS.has(key)) as [string, unknown][]

      if (entries.length === 0) {
        const row = selectWorkflowById.get({ $id: id }) as Record<string, unknown> | undefined
        return row ? mapWorkflowRow(row) : null
      }

      const setClauses: string[] = ["updated_at = datetime('now')"]
      const params: Record<string, string | number | null> = { $id: id }
      for (const [key, value] of entries) {
        const col = fieldMap[key]
        if (!col) continue
        if (col === 'updated_at') continue // already handled above
        setClauses.push(`${col} = $${col}`)
        if (key === 'is_valid') {
          params[`$${col}`] = value ? 1 : 0
        } else if (key === 'validation_errors') {
          params[`$${col}`] = Array.isArray(value) && value.length > 0
            ? JSON.stringify((value as string[]).map(e => String(e).slice(0, 1000)))
            : null
        } else {
          params[`$${col}`] = value as string | number | null
        }
      }

      db.prepare(`UPDATE workflows SET ${setClauses.join(', ')} WHERE id = $id`).run(params)
      const row = selectWorkflowById.get({ $id: id }) as Record<string, unknown> | undefined
      return row ? mapWorkflowRow(row) : null
    },

    deleteWorkflow: (id) => {
      const result = deleteWorkflowById.run({ $id: id })
      return result.changes > 0
    },

    listWorkflows: (filters) => {
      let sql = 'SELECT * FROM workflows'
      const conditions: string[] = []

      if (filters?.status === 'valid') {
        conditions.push('is_valid = 1')
      } else if (filters?.status === 'invalid') {
        conditions.push('is_valid = 0')
      }

      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`
      }

      sql += ' ORDER BY name ASC'

      const rows = db.prepare(sql).all() as Record<string, unknown>[]
      return rows.map(mapWorkflowRow)
    },

    createRun: (run) => {
      const id = generateId()
      insertRun.run({
        $id: id,
        $workflowId: run.workflow_id,
        $workflowName: run.workflow_name,
        $status: run.status,
        $currentStepIndex: run.current_step_index,
        $stepsState: JSON.stringify(run.steps_state),
        $outputDir: run.output_dir,
        $startedAt: run.started_at ?? null,
        $completedAt: run.completed_at ?? null,
        $errorMessage: run.error_message ?? null,
        $variables: run.variables ? JSON.stringify(run.variables) : null,
      })
      const row = selectRunById.get({ $id: id }) as Record<string, unknown> | undefined
      if (!row) throw new Error('Failed to insert workflow run')
      return mapRunRow(row)
    },

    getRun: (id) => {
      const row = selectRunById.get({ $id: id }) as Record<string, unknown> | undefined
      return row ? mapRunRow(row) : null
    },

    updateRun: (id, fields) => {
      const fieldMap: Record<string, string> = {
        status: 'status',
        current_step_index: 'current_step_index',
        steps_state: 'steps_state',
        output_dir: 'output_dir',
        started_at: 'started_at',
        completed_at: 'completed_at',
        error_message: 'error_message',
        variables: 'variables',
      }

      // Filter to only allowed columns (SQL injection prevention)
      const entries = Object.entries(fields)
        .filter(([key, v]) => v !== undefined && ALLOWED_RUN_COLUMNS.has(key)) as [string, unknown][]

      if (entries.length === 0) {
        const row = selectRunById.get({ $id: id }) as Record<string, unknown> | undefined
        return row ? mapRunRow(row) : null
      }

      const setClauses: string[] = []
      const params: Record<string, string | number | null> = { $id: id }
      for (const [key, value] of entries) {
        const col = fieldMap[key]
        if (!col) continue
        setClauses.push(`${col} = $${col}`)
        if (key === 'steps_state') {
          params[`$${col}`] = JSON.stringify(value)
        } else if (key === 'variables') {
          params[`$${col}`] = value ? JSON.stringify(value) : null
        } else {
          params[`$${col}`] = value as string | number | null
        }
      }

      if (setClauses.length === 0) return null

      db.prepare(`UPDATE workflow_runs SET ${setClauses.join(', ')} WHERE id = $id`).run(params)
      const row = selectRunById.get({ $id: id }) as Record<string, unknown> | undefined
      return row ? mapRunRow(row) : null
    },

    listRuns: (filters) => {
      let sql = 'SELECT * FROM workflow_runs'
      const conditions: string[] = []
      const params: Record<string, string | number> = {}

      if (filters?.status) {
        conditions.push('status = $status')
        params.$status = filters.status
      }

      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`
      }

      sql += ' ORDER BY created_at DESC'

      if (filters?.limit) {
        sql += ' LIMIT $limit'
        params.$limit = filters.limit
      }
      if (filters?.offset) {
        sql += ' OFFSET $offset'
        params.$offset = filters.offset
      }

      const stmt = db.prepare(sql)
      const rows = (Object.keys(params).length > 0 ? stmt.all(params) : stmt.all()) as Record<string, unknown>[]
      return rows.map(mapRunRow)
    },

    listRunsByWorkflow: (workflowId) => {
      const rows = selectRunsByWorkflow.all({ $workflowId: workflowId }) as Record<string, unknown>[]
      return rows.map(mapRunRow)
    },

    getRunningRuns: () => {
      const rows = selectRunningRuns.all() as Record<string, unknown>[]
      return rows.map(mapRunRow)
    },

    hasActiveRunsForWorkflow: (workflowId) => {
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM workflow_runs WHERE workflow_id = $workflowId AND status IN ('running', 'pending')`
      ).get({ $workflowId: workflowId }) as { cnt: number } | undefined
      return (row?.cnt ?? 0) > 0
    },

    createRunIfUnderLimit: (run, maxConcurrent) => {
      // Atomic check-and-create inside a SQLite transaction to prevent TOCTOU races.
      const txn = db.transaction(() => {
        const countRow = db.prepare(
          `SELECT COUNT(*) as cnt FROM workflow_runs WHERE status IN ('running', 'pending')`
        ).get() as { cnt: number }
        if (countRow.cnt >= maxConcurrent) {
          return null
        }
        const id = generateId()
        insertRun.run({
          $id: id,
          $workflowId: run.workflow_id,
          $workflowName: run.workflow_name,
          $status: run.status,
          $currentStepIndex: run.current_step_index,
          $stepsState: JSON.stringify(run.steps_state),
          $outputDir: run.output_dir,
          $startedAt: run.started_at ?? null,
          $completedAt: run.completed_at ?? null,
          $errorMessage: run.error_message ?? null,
          $variables: run.variables ? JSON.stringify(run.variables) : null,
        })
        const row = selectRunById.get({ $id: id }) as Record<string, unknown> | undefined
        if (!row) throw new Error('Failed to insert workflow run')
        return mapRunRow(row)
      })
      return txn()
    },

    deleteOldRuns: (olderThanDays) => {
      const rows = deleteOldRunsStmt.all({ $olderThan: `-${olderThanDays} days` }) as Record<string, unknown>[]
      return rows.length
    },

    insertSignal: (record) => {
      const id = record.id || generateId()
      insertSignal.run({
        $id: id,
        $runId: record.run_id,
        $stepName: record.step_name,
        $signalType: record.signal_type,
        $signalFilePath: record.signal_file_path,
        $resolution: record.resolution ?? null,
        $resolutionFilePath: record.resolution_file_path ?? null,
        $resolvedAt: record.resolved_at ?? null,
        $synthetic: record.synthetic ?? 0,
      })
    },

    getSignalsByRun: (runId) => {
      const rows = selectSignalsByRun.all({ $runId: runId }) as Record<string, unknown>[]
      return rows.map(mapSignalRow)
    },

    getUnresolvedSignals: (runId) => {
      const rows = selectUnresolvedSignals.all({ $runId: runId }) as Record<string, unknown>[]
      return rows.map(mapSignalRow)
    },

    resolveSignal: (signalId, resolution, resolutionFilePath) => {
      updateResolveSignal.run({
        $id: signalId,
        $resolution: resolution,
        $resolutionFilePath: resolutionFilePath ?? null,
      })
    },

    // Phase 10: Amendment budget methods
    initRunBudgets: (runId: string, budgetConfig: { quality?: { per_run?: number }; reconciliation?: { per_run?: number } }) => {
      const qualityMax = budgetConfig.quality?.per_run ?? parseInt(process.env.AGENTBOARD_AMENDMENT_QUALITY_BUDGET ?? '3', 10)
      const reconMax = budgetConfig.reconciliation?.per_run ?? parseInt(process.env.AGENTBOARD_AMENDMENT_RECONCILIATION_BUDGET ?? '8', 10)
      insertBudget.run({ $id: generateId(), $runId: runId, $workUnit: null, $category: 'quality', $used: 0, $maxAllowed: qualityMax })
      insertBudget.run({ $id: generateId(), $runId: runId, $workUnit: null, $category: 'reconciliation', $used: 0, $maxAllowed: reconMax })
    },

    initWorkUnitBudgets: (runId: string, workUnit: string, budgetConfig: { quality?: { per_work_unit?: number }; reconciliation?: { per_work_unit?: number } }) => {
      if (budgetConfig.quality?.per_work_unit !== undefined) {
        insertBudget.run({ $id: generateId(), $runId: runId, $workUnit: workUnit, $category: 'quality', $used: 0, $maxAllowed: budgetConfig.quality.per_work_unit })
      }
      if (budgetConfig.reconciliation?.per_work_unit !== undefined) {
        insertBudget.run({ $id: generateId(), $runId: runId, $workUnit: workUnit, $category: 'reconciliation', $used: 0, $maxAllowed: budgetConfig.reconciliation.per_work_unit })
      }
    },

    getBudget: (runId: string, workUnit: string | null, category: string) => {
      const row = selectBudget.get({ $runId: runId, $category: category, $workUnit: workUnit }) as Record<string, unknown> | undefined
      if (!row) return null
      return { id: String(row.id), used: Number(row.used), max_allowed: Number(row.max_allowed), category: String(row.category) }
    },

    checkAndIncrementBudget: (runId: string, workUnit: string | null, category: string): { allowed: boolean; used: number; max: number } => {
      const txn = db.transaction(() => {
        const row = selectBudget.get({ $runId: runId, $category: category, $workUnit: workUnit }) as Record<string, unknown> | undefined
        if (!row) return { allowed: true, used: 0, max: Infinity }
        const used = Number(row.used)
        const maxAllowed = Number(row.max_allowed)
        if (used >= maxAllowed) return { allowed: false, used, max: maxAllowed }
        updateBudgetUsed.run({ $id: String(row.id) })
        return { allowed: true, used: used + 1, max: maxAllowed }
      })
      return txn.immediate()
    },

    overrideBudget: (runId: string, category: string, newMax: number, workUnit?: string | null) => {
      updateBudgetMax.run({ $runId: runId, $category: category, $newMax: newMax, $workUnit: workUnit ?? null })
    },

    getAmendmentsByRun: (runId: string) => {
      return (selectAmendmentsByRun.all({ $runId: runId }) as Record<string, unknown>[]).map(mapAmendmentRow)
    },

    getAmendmentsBySection: (runId: string, specSection: string) => {
      return (selectAmendmentsBySection.all({ $runId: runId, $specSection: specSection }) as Record<string, unknown>[]).map(mapAmendmentRow)
    },

    insertAmendment: (record: { run_id: string; step_name: string; work_unit?: string; signal_file: string; amendment_type: string; category: string; spec_section: string; issue: string; proposed_change?: string; proposed_by?: string; proposal_timestamp?: number; approval_timestamp?: number; rationale?: string; target?: string }) => {
      const id = generateId()
      insertAmendment.run({
        $id: id,
        $runId: record.run_id,
        $stepName: record.step_name,
        $workUnit: record.work_unit ?? null,
        $signalFile: record.signal_file,
        $amendmentType: record.amendment_type,
        $category: record.category,
        $specSection: record.spec_section,
        $issue: record.issue,
        $proposedChange: record.proposed_change ?? null,
        $createdAt: new Date().toISOString(),
        $proposedBy: record.proposed_by ?? null,
        $proposalTimestamp: record.proposal_timestamp ?? null,
        $approvalTimestamp: record.approval_timestamp ?? null,
        $rationale: record.rationale ?? null,
        $target: record.target ?? null,
      })
      return id
    },

    resolveAmendment: (id: string, resolution: string, resolvedBy: string) => {
      updateAmendmentResolution.run({
        $id: id,
        $resolution: resolution,
        $resolvedBy: resolvedBy,
        $resolvedAt: new Date().toISOString(),
      })
    },

    insertIteration: (record: ReviewLoopIterationRecord) => {
      insertReviewIteration.run({
        $id: record.id,
        $runId: record.run_id,
        $stepName: record.step_name,
        $iteration: record.iteration,
        $producerTaskId: record.producer_task_id,
        $reviewerTaskId: record.reviewer_task_id,
        $verdict: record.verdict,
        $feedback: record.feedback,
        $startedAt: record.started_at,
        $completedAt: record.completed_at,
        $producerCompletedAt: record.producer_completed_at ?? null,
      })
    },

    updateIteration: (id: string, fields: Partial<Pick<ReviewLoopIterationRecord, 'producer_task_id' | 'reviewer_task_id' | 'verdict' | 'feedback' | 'completed_at' | 'producer_completed_at'>>) => {
      updateReviewIteration.run({
        $id: id,
        $producerTaskId: fields.producer_task_id ?? null,
        $reviewerTaskId: fields.reviewer_task_id ?? null,
        $verdict: fields.verdict ?? null,
        $feedback: fields.feedback ?? null,
        $completedAt: fields.completed_at ?? null,
        $producerCompletedAt: fields.producer_completed_at ?? null,
      })
    },

    // ROBUSTNESS-1 (REQ-36): Atomic DB-first iteration increment
    // DB insert happens BEFORE memory update to prevent desync on crash
    incrementAndInsertIteration: (runId: string, stepName: string, currentIteration: number) => {
      const nextIteration = currentIteration + 1
      const iterationId = generateId()

      insertReviewIteration.run({
        $id: iterationId,
        $runId: runId,
        $stepName: stepName,
        $iteration: nextIteration,
        $producerTaskId: null,
        $reviewerTaskId: null,
        $verdict: null,
        $feedback: null,
        $startedAt: new Date().toISOString(),
        $completedAt: null,
        $producerCompletedAt: null,
      })

      return { nextIteration, iterationId }
    },

    getIterationsByStep: (runId: string, stepName: string): ReviewLoopIterationRecord[] => {
      const rows = selectIterationsByStep.all({ $runId: runId, $stepName: stepName }) as Record<string, unknown>[]
      return rows.map(mapReviewIterationRow)
    },

    getLastCompletedIteration: (runId: string, stepName: string): ReviewLoopIterationRecord | null => {
      const row = selectLastCompletedIteration.get({ $runId: runId, $stepName: stepName }) as Record<string, unknown> | undefined
      return row ? mapReviewIterationRow(row) : null
    },

    getLastIteration: (runId: string, stepName: string): ReviewLoopIterationRecord | null => {
      const row = selectLastIteration.get({ $runId: runId, $stepName: stepName }) as Record<string, unknown> | undefined
      return row ? mapReviewIterationRow(row) : null
    },

    updateIterationProducerCompleted: (runId: string, stepName: string, iteration: number, timestamp: string) => {
      updateProducerCompleted.run({
        $runId: runId,
        $stepName: stepName,
        $iteration: iteration,
        $timestamp: timestamp,
      })
    },

    close: () => {
      // No-op: the main db handle is closed by initDatabase
    },
  }
}
