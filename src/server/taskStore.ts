// taskStore.ts - SQLite CRUD for task queue and prompt templates
import { Database as SQLiteDatabase } from 'bun:sqlite'
import type { Task, TaskTemplate, TaskStatus, TaskQueueStats } from '../shared/types'

export interface TaskStore {
  createTask: (task: Omit<Task, 'id' | 'createdAt' | 'startedAt' | 'completedAt' | 'outputPath' | 'sessionName' | 'tmuxWindow' | 'errorMessage' | 'completionMethod' | 'retryCount' | 'parentTaskId' | 'followUpPrompt' | 'metadata'> & { parentTaskId?: string | null; followUpPrompt?: string | null; metadata?: string | null }) => Task
  getTask: (id: string) => Task | null
  updateTask: (id: string, fields: Partial<Omit<Task, 'id'>>) => Task | null
  deleteTask: (id: string) => boolean
  listTasks: (filters?: { status?: TaskStatus; limit?: number; offset?: number }) => Task[]
  getNextQueued: () => Task | null
  getRunningCount: () => number
  getStartedInLastHour: () => number
  getStats: () => TaskQueueStats
  listTasksByParent: (parentId: string) => Task[]
  markOrphanedTasksFailed: () => number

  createTemplate: (template: Omit<TaskTemplate, 'id' | 'createdAt' | 'updatedAt'>) => TaskTemplate
  getTemplate: (id: string) => TaskTemplate | null
  updateTemplate: (id: string, fields: Partial<Omit<TaskTemplate, 'id' | 'createdAt' | 'updatedAt'>>) => TaskTemplate | null
  deleteTemplate: (id: string) => boolean
  listTemplates: () => TaskTemplate[]

  close: () => void
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function nullableString(val: unknown): string | null {
  return val === null || val === undefined ? null : String(val)
}

function mapTaskRow(row: Record<string, unknown>): Task {
  return {
    id: String(row.id ?? ''),
    projectPath: String(row.project_path ?? ''),
    prompt: String(row.prompt ?? ''),
    templateId: nullableString(row.template_id),
    priority: Number(row.priority ?? 5),
    status: String(row.status ?? 'queued') as TaskStatus,
    sessionName: nullableString(row.session_name),
    tmuxWindow: nullableString(row.tmux_window),
    createdAt: String(row.created_at ?? ''),
    startedAt: nullableString(row.started_at),
    completedAt: nullableString(row.completed_at),
    errorMessage: nullableString(row.error_message),
    completionMethod: nullableString(row.completion_method),
    retryCount: Number(row.retry_count ?? 0),
    maxRetries: Number(row.max_retries ?? 0),
    timeoutSeconds: Number(row.timeout_seconds ?? 1800),
    outputPath: nullableString(row.output_path),
    parentTaskId: nullableString(row.parent_task_id),
    followUpPrompt: nullableString(row.follow_up_prompt),
    metadata: nullableString(row.metadata),
  }
}

function mapTemplateRow(row: Record<string, unknown>): TaskTemplate {
  return {
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    promptTemplate: String(row.prompt_template ?? ''),
    variables: String(row.variables ?? '[]'),
    projectPath: nullableString(row.project_path),
    priority: Number(row.priority ?? 5),
    timeoutSeconds: Number(row.timeout_seconds ?? 1800),
    isDefault: Number(row.is_default) === 1,
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  }
}

export function initTaskStore(db: SQLiteDatabase): TaskStore {
  // Create tables (additive — safe to run multiple times)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      prompt TEXT NOT NULL,
      template_id TEXT,
      priority INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'queued',
      session_name TEXT,
      tmux_window TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      error_message TEXT,
      completion_method TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 0,
      timeout_seconds INTEGER NOT NULL DEFAULT 1800,
      output_path TEXT
    );
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt_template TEXT NOT NULL,
      variables TEXT NOT NULL DEFAULT '[]',
      project_path TEXT,
      priority INTEGER NOT NULL DEFAULT 5,
      timeout_seconds INTEGER NOT NULL DEFAULT 1800,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority_created ON tasks (priority ASC, created_at ASC);
  `)

  // Additive migration: add task chaining columns
  try { db.exec('ALTER TABLE tasks ADD COLUMN parent_task_id TEXT') } catch { /* column may already exist */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN follow_up_prompt TEXT') } catch { /* column may already exist */ }
  try { db.exec('ALTER TABLE tasks ADD COLUMN metadata TEXT') } catch { /* column may already exist */ }

  // Prepared statements
  const insertTask = db.prepare(
    `INSERT INTO tasks (id, project_path, prompt, template_id, priority, status, max_retries, timeout_seconds, parent_task_id, follow_up_prompt, metadata)
     VALUES ($id, $projectPath, $prompt, $templateId, $priority, 'queued', $maxRetries, $timeoutSeconds, $parentTaskId, $followUpPrompt, $metadata)`
  )
  const selectTaskById = db.prepare('SELECT * FROM tasks WHERE id = $id')
  const deleteTaskById = db.prepare('DELETE FROM tasks WHERE id = $id')
  const selectNextQueued = db.prepare(
    `SELECT * FROM tasks WHERE status = 'queued' ORDER BY priority ASC, created_at ASC LIMIT 1`
  )
  const selectRunningCount = db.prepare(
    `SELECT COUNT(*) as count FROM tasks WHERE status = 'running'`
  )
  const selectStartedInLastHour = db.prepare(
    `SELECT COUNT(*) as count FROM tasks WHERE started_at > datetime('now', '-1 hour')`
  )
  const selectStats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM tasks WHERE status = 'queued') as queued,
      (SELECT COUNT(*) FROM tasks WHERE status = 'running') as running,
      (SELECT COUNT(*) FROM tasks WHERE status = 'completed' AND completed_at > datetime('now', 'start of day')) as completed_today,
      (SELECT COUNT(*) FROM tasks WHERE status = 'failed' AND completed_at > datetime('now', 'start of day')) as failed_today
  `)
  const selectByParent = db.prepare('SELECT * FROM tasks WHERE parent_task_id = $parentId ORDER BY created_at ASC')
  const markOrphaned = db.prepare(
    `UPDATE tasks SET status = 'failed', error_message = 'server_restart', completed_at = datetime('now'), completion_method = 'server_restart'
     WHERE status = 'running'`
  )

  const insertTemplate = db.prepare(
    `INSERT INTO task_templates (id, name, prompt_template, variables, project_path, priority, timeout_seconds, is_default)
     VALUES ($id, $name, $promptTemplate, $variables, $projectPath, $priority, $timeoutSeconds, $isDefault)`
  )
  const selectTemplateById = db.prepare('SELECT * FROM task_templates WHERE id = $id')
  const deleteTemplateById = db.prepare('DELETE FROM task_templates WHERE id = $id')
  const selectAllTemplates = db.prepare('SELECT * FROM task_templates ORDER BY name ASC')

  return {
    createTask: (task) => {
      const id = generateId()
      insertTask.run({
        $id: id,
        $projectPath: task.projectPath,
        $prompt: task.prompt,
        $templateId: task.templateId ?? null,
        $priority: task.priority,
        $maxRetries: task.maxRetries,
        $timeoutSeconds: task.timeoutSeconds,
        $parentTaskId: task.parentTaskId ?? null,
        $followUpPrompt: task.followUpPrompt ?? null,
        $metadata: task.metadata ?? null,
      })
      const row = selectTaskById.get({ $id: id }) as Record<string, unknown> | undefined
      if (!row) throw new Error('Failed to insert task')
      return mapTaskRow(row)
    },

    getTask: (id) => {
      const row = selectTaskById.get({ $id: id }) as Record<string, unknown> | undefined
      return row ? mapTaskRow(row) : null
    },

    updateTask: (id, fields) => {
      const fieldMap: Record<string, string> = {
        projectPath: 'project_path',
        prompt: 'prompt',
        templateId: 'template_id',
        priority: 'priority',
        status: 'status',
        sessionName: 'session_name',
        tmuxWindow: 'tmux_window',
        startedAt: 'started_at',
        completedAt: 'completed_at',
        errorMessage: 'error_message',
        completionMethod: 'completion_method',
        retryCount: 'retry_count',
        maxRetries: 'max_retries',
        timeoutSeconds: 'timeout_seconds',
        outputPath: 'output_path',
        parentTaskId: 'parent_task_id',
        followUpPrompt: 'follow_up_prompt',
        metadata: 'metadata',
      }

      const entries = Object.entries(fields).filter(([, v]) => v !== undefined) as [string, unknown][]
      if (entries.length === 0) {
        const row = selectTaskById.get({ $id: id }) as Record<string, unknown> | undefined
        return row ? mapTaskRow(row) : null
      }

      const setClauses: string[] = []
      const params: Record<string, unknown> = { $id: id }
      for (const [key, value] of entries) {
        const col = fieldMap[key]
        if (!col) continue
        setClauses.push(`${col} = $${col}`)
        params[`$${col}`] = value
      }

      if (setClauses.length === 0) return null

      db.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = $id`).run(params as any)
      const row = selectTaskById.get({ $id: id }) as Record<string, unknown> | undefined
      return row ? mapTaskRow(row) : null
    },

    deleteTask: (id) => {
      const result = deleteTaskById.run({ $id: id })
      return result.changes > 0
    },

    listTasks: (filters) => {
      let sql = 'SELECT * FROM tasks'
      const conditions: string[] = []
      const params: Record<string, unknown> = {}

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

      const rows = db.prepare(sql).all(params as any) as Record<string, unknown>[]
      return rows.map(mapTaskRow)
    },

    getNextQueued: () => {
      const row = selectNextQueued.get() as Record<string, unknown> | undefined
      return row ? mapTaskRow(row) : null
    },

    getRunningCount: () => {
      const row = selectRunningCount.get() as Record<string, unknown>
      return Number(row.count)
    },

    getStartedInLastHour: () => {
      const row = selectStartedInLastHour.get() as Record<string, unknown>
      return Number(row.count)
    },

    getStats: () => {
      const row = selectStats.get() as Record<string, unknown>
      return {
        queued: Number(row.queued),
        running: Number(row.running),
        completedToday: Number(row.completed_today),
        failedToday: Number(row.failed_today),
      }
    },

    listTasksByParent: (parentId) => {
      const rows = selectByParent.all({ $parentId: parentId }) as Record<string, unknown>[]
      return rows.map(mapTaskRow)
    },

    markOrphanedTasksFailed: () => {
      const result = markOrphaned.run()
      return result.changes
    },

    createTemplate: (template) => {
      const id = generateId()
      insertTemplate.run({
        $id: id,
        $name: template.name,
        $promptTemplate: template.promptTemplate,
        $variables: template.variables,
        $projectPath: template.projectPath ?? null,
        $priority: template.priority,
        $timeoutSeconds: template.timeoutSeconds,
        $isDefault: template.isDefault ? 1 : 0,
      })
      const row = selectTemplateById.get({ $id: id }) as Record<string, unknown> | undefined
      if (!row) throw new Error('Failed to insert template')
      return mapTemplateRow(row)
    },

    getTemplate: (id) => {
      const row = selectTemplateById.get({ $id: id }) as Record<string, unknown> | undefined
      return row ? mapTemplateRow(row) : null
    },

    updateTemplate: (id, fields) => {
      const fieldMap: Record<string, string> = {
        name: 'name',
        promptTemplate: 'prompt_template',
        variables: 'variables',
        projectPath: 'project_path',
        priority: 'priority',
        timeoutSeconds: 'timeout_seconds',
        isDefault: 'is_default',
      }

      const entries = Object.entries(fields).filter(([, v]) => v !== undefined) as [string, unknown][]
      if (entries.length === 0) {
        const row = selectTemplateById.get({ $id: id }) as Record<string, unknown> | undefined
        return row ? mapTemplateRow(row) : null
      }

      const setClauses: string[] = ['updated_at = datetime(\'now\')']
      const params: Record<string, unknown> = { $id: id }
      for (const [key, value] of entries) {
        const col = fieldMap[key]
        if (!col) continue
        setClauses.push(`${col} = $${col}`)
        if (key === 'isDefault') {
          params[`$${col}`] = value ? 1 : 0
        } else {
          params[`$${col}`] = value
        }
      }

      db.prepare(`UPDATE task_templates SET ${setClauses.join(', ')} WHERE id = $id`).run(params as any)
      const row = selectTemplateById.get({ $id: id }) as Record<string, unknown> | undefined
      return row ? mapTemplateRow(row) : null
    },

    deleteTemplate: (id) => {
      const result = deleteTemplateById.run({ $id: id })
      return result.changes > 0
    },

    listTemplates: () => {
      const rows = selectAllTemplates.all() as Record<string, unknown>[]
      return rows.map(mapTemplateRow)
    },

    close: () => {
      // No-op: the main db handle is closed by initDatabase
    },
  }
}
