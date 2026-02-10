// workflowStore.ts - SQLite CRUD for workflow definitions and workflow runs
import { Database as SQLiteDatabase } from 'bun:sqlite'
import type { WorkflowDefinition, WorkflowRun, WorkflowStatus, StepRunState } from '../shared/types'

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

export function initWorkflowStore(db: SQLiteDatabase): WorkflowStore {
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
    CREATE INDEX IF NOT EXISTS idx_workflows_name ON workflows(name);
    CREATE INDEX IF NOT EXISTS idx_workflows_valid ON workflows(is_valid);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
  `)

  // Additive migration: add workflow columns to tasks table
  try { db.exec('ALTER TABLE tasks ADD COLUMN workflow_run_id TEXT') } catch { /* column may already exist */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN workflow_step_name TEXT') } catch { /* column may already exist */ }
  try { db.exec('ALTER TABLE workflow_runs ADD COLUMN variables TEXT') } catch { /* column may already exist */ }

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

    close: () => {
      // No-op: the main db handle is closed by initDatabase
    },
  }
}
