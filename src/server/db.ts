import fs from 'node:fs'
import path from 'node:path'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import type { AgentType } from '../shared/types'
import { resolveProjectPath } from './paths'
import { createPoolStore } from './poolStore'

export interface AgentSessionRecord {
  id: number
  sessionId: string
  logFilePath: string
  projectPath: string
  agentType: AgentType
  displayName: string
  createdAt: string
  lastActivityAt: string
  lastUserMessage: string | null
  currentWindow: string | null
  isPinned: boolean
  lastResumeError: string | null
}

export interface SessionDatabase {
  db: SQLiteDatabase
  insertSession: (session: Omit<AgentSessionRecord, 'id'>) => AgentSessionRecord
  updateSession: (
    sessionId: string,
    patch: Partial<Omit<AgentSessionRecord, 'id' | 'sessionId'>>
  ) => AgentSessionRecord | null
  getSessionById: (sessionId: string) => AgentSessionRecord | null
  getSessionByLogPath: (logPath: string) => AgentSessionRecord | null
  getSessionByWindow: (tmuxWindow: string) => AgentSessionRecord | null
  getActiveSessions: () => AgentSessionRecord[]
  getInactiveSessions: (options?: { maxAgeHours?: number }) => AgentSessionRecord[]
  orphanSession: (sessionId: string) => AgentSessionRecord | null
  displayNameExists: (displayName: string, excludeSessionId?: string) => boolean
  setPinned: (sessionId: string, isPinned: boolean) => AgentSessionRecord | null
  getPinnedOrphaned: () => AgentSessionRecord[]
  deleteInactiveSession: (sessionId: string) => boolean
  deleteOldInactiveSessions: (retentionDays: number) => number
  close: () => void
}

const DEFAULT_DATA_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.agentboard'
)
const DEFAULT_DB_PATH = path.join(DEFAULT_DATA_DIR, 'agentboard.db')
const DB_PATH_ENV = 'AGENTBOARD_DB_PATH'

const AGENT_SESSIONS_COLUMNS_SQL = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE,
  log_file_path TEXT NOT NULL UNIQUE,
  project_path TEXT,
  agent_type TEXT NOT NULL CHECK (agent_type IN ('claude', 'codex')),
  display_name TEXT,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  last_user_message TEXT,
  current_window TEXT,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  last_resume_error TEXT
`

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS agent_sessions (
${AGENT_SESSIONS_COLUMNS_SQL}
);
`

const CREATE_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_session_id
  ON agent_sessions (session_id);
CREATE INDEX IF NOT EXISTS idx_log_file_path
  ON agent_sessions (log_file_path);
CREATE INDEX IF NOT EXISTS idx_current_window
  ON agent_sessions (current_window);
`

export function initDatabase(options: { path?: string } = {}): SessionDatabase {
  const envPath = process.env[DB_PATH_ENV]?.trim()
  const resolvedEnvPath =
    envPath && envPath !== ':memory:' ? resolveProjectPath(envPath) : envPath
  const dbPath = options.path ?? resolvedEnvPath ?? DEFAULT_DB_PATH
  ensureDataDir(dbPath)

  const db = new SQLiteDatabase(dbPath)

  // Enable WAL mode for better concurrent read/write performance (Phase 5)
  if (dbPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
  }

  migrateDatabase(db)
  db.exec(CREATE_TABLE_SQL)
  db.exec(CREATE_INDEXES_SQL)
  migrateLastUserMessageColumn(db)
  migrateDeduplicateDisplayNames(db)
  migrateIsPinnedColumn(db)
  migrateLastResumeErrorColumn(db)

  const insertStmt = db.prepare(
    `INSERT INTO agent_sessions
      (session_id, log_file_path, project_path, agent_type, display_name, created_at, last_activity_at, last_user_message, current_window, is_pinned, last_resume_error)
     VALUES ($sessionId, $logFilePath, $projectPath, $agentType, $displayName, $createdAt, $lastActivityAt, $lastUserMessage, $currentWindow, $isPinned, $lastResumeError)`
  )

  const selectBySessionId = db.prepare(
    'SELECT * FROM agent_sessions WHERE session_id = $sessionId'
  )
  const selectByLogPath = db.prepare(
    'SELECT * FROM agent_sessions WHERE log_file_path = $logFilePath'
  )
  const selectByWindow = db.prepare(
    'SELECT * FROM agent_sessions WHERE current_window = $currentWindow'
  )
  const selectActive = db.prepare(
    'SELECT * FROM agent_sessions WHERE current_window IS NOT NULL'
  )
  const selectInactive = db.prepare(
    'SELECT * FROM agent_sessions WHERE current_window IS NULL ORDER BY last_activity_at DESC'
  )
  const selectInactiveRecent = db.prepare(
    'SELECT * FROM agent_sessions WHERE current_window IS NULL AND last_activity_at > $cutoff ORDER BY last_activity_at DESC'
  )
  const selectByDisplayName = db.prepare(
    'SELECT 1 FROM agent_sessions WHERE display_name = $displayName LIMIT 1'
  )
  const selectByDisplayNameExcluding = db.prepare(
    'SELECT 1 FROM agent_sessions WHERE display_name = $displayName AND session_id != $excludeSessionId LIMIT 1'
  )
  const deleteInactiveSessionStmt = db.prepare(
    'DELETE FROM agent_sessions WHERE session_id = $sessionId AND current_window IS NULL'
  )
  const deleteOldInactiveSessionsStmt = db.prepare(
    `DELETE FROM agent_sessions
     WHERE current_window IS NULL
       AND last_activity_at < datetime('now', $olderThan)
     RETURNING session_id`
  )

  const updateStmt = (fields: string[]) =>
    db.prepare(
      `UPDATE agent_sessions SET ${fields
        .map((field) => `${field} = $${field}`)
        .join(', ')} WHERE session_id = $sessionId`
    )

  return {
    db,
    insertSession: (session) => {
      insertStmt.run({
        $sessionId: session.sessionId,
        $logFilePath: session.logFilePath,
        $projectPath: session.projectPath,
        $agentType: session.agentType,
        $displayName: session.displayName,
        $createdAt: session.createdAt,
        $lastActivityAt: session.lastActivityAt,
        $lastUserMessage: session.lastUserMessage,
        $currentWindow: session.currentWindow,
        $isPinned: session.isPinned ? 1 : 0,
        $lastResumeError: session.lastResumeError,
      })
      const row = selectBySessionId.get({ $sessionId: session.sessionId }) as
        | Record<string, unknown>
        | undefined
      if (!row) {
        throw new Error('Failed to insert session')
      }
      return mapRow(row)
    },
    updateSession: (sessionId, patch) => {
      const entries = Object.entries(patch).filter(
        ([, value]) => value !== undefined
      ) as Array<[string, unknown]>
      if (entries.length === 0) {
        return (selectBySessionId.get({ $sessionId: sessionId }) as Record<string, unknown> | undefined)
          ? mapRow(selectBySessionId.get({ $sessionId: sessionId }) as Record<string, unknown>)
          : null
      }

      const fieldMap: Record<string, string> = {
        logFilePath: 'log_file_path',
        projectPath: 'project_path',
        agentType: 'agent_type',
        displayName: 'display_name',
        createdAt: 'created_at',
        lastActivityAt: 'last_activity_at',
        lastUserMessage: 'last_user_message',
        currentWindow: 'current_window',
        isPinned: 'is_pinned',
        lastResumeError: 'last_resume_error',
      }

      const fields: string[] = []
      const params: Record<string, string | number | null> = {
        $sessionId: sessionId,
      }
      for (const [key, value] of entries) {
        const field = fieldMap[key]
        if (!field) continue
        fields.push(field)
        // Normalize isPinned to 0/1 for SQLite
        if (key === 'isPinned') {
          params[`$${field}`] = value ? 1 : 0
        } else {
          params[`$${field}`] = value as string | number | null
        }
      }

      if (fields.length === 0) {
        return null
      }

      updateStmt(fields).run(params)
      const row = selectBySessionId.get({ $sessionId: sessionId }) as
        | Record<string, unknown>
        | undefined
      return row ? mapRow(row) : null
    },
    getSessionById: (sessionId) => {
      const row = selectBySessionId.get({ $sessionId: sessionId }) as
        | Record<string, unknown>
        | undefined
      return row ? mapRow(row) : null
    },
    getSessionByLogPath: (logPath) => {
      const row = selectByLogPath.get({ $logFilePath: logPath }) as
        | Record<string, unknown>
        | undefined
      return row ? mapRow(row) : null
    },
    getSessionByWindow: (tmuxWindow) => {
      const row = selectByWindow.get({ $currentWindow: tmuxWindow }) as
        | Record<string, unknown>
        | undefined
      return row ? mapRow(row) : null
    },
    getActiveSessions: () => {
      const rows = selectActive.all() as Record<string, unknown>[]
      return rows.map(mapRow)
    },
    getInactiveSessions: (options?: { maxAgeHours?: number }) => {
      if (options?.maxAgeHours) {
        const cutoff = new Date(Date.now() - options.maxAgeHours * 60 * 60 * 1000).toISOString()
        const rows = selectInactiveRecent.all({ $cutoff: cutoff }) as Record<string, unknown>[]
        return rows.map(mapRow)
      }
      const rows = selectInactive.all() as Record<string, unknown>[]
      return rows.map(mapRow)
    },
    orphanSession: (sessionId) => {
      updateStmt(['current_window']).run({
        $sessionId: sessionId,
        $current_window: null,
      })
      const row = selectBySessionId.get({ $sessionId: sessionId }) as
        | Record<string, unknown>
        | undefined
      return row ? mapRow(row) : null
    },
    displayNameExists: (displayName, excludeSessionId) => {
      const row = excludeSessionId
        ? selectByDisplayNameExcluding.get({
            $displayName: displayName,
            $excludeSessionId: excludeSessionId,
          })
        : selectByDisplayName.get({ $displayName: displayName })
      return row != null
    },
    setPinned: (sessionId, isPinned) => {
      updateStmt(['is_pinned']).run({
        $sessionId: sessionId,
        $is_pinned: isPinned ? 1 : 0,
      })
      const row = selectBySessionId.get({ $sessionId: sessionId }) as
        | Record<string, unknown>
        | undefined
      return row ? mapRow(row) : null
    },
    getPinnedOrphaned: () => {
      const rows = db
        .prepare(
          'SELECT * FROM agent_sessions WHERE is_pinned = 1 AND current_window IS NULL ORDER BY last_activity_at DESC'
        )
        .all() as Record<string, unknown>[]
      return rows.map(mapRow)
    },
    deleteInactiveSession: (sessionId) => {
      const result = deleteInactiveSessionStmt.run({ $sessionId: sessionId })
      return result.changes > 0
    },
    deleteOldInactiveSessions: (retentionDays) => {
      const rows = deleteOldInactiveSessionsStmt.all({ $olderThan: `-${retentionDays} days` }) as Record<string, unknown>[]
      return rows.length
    },
    close: () => {
      db.close()
    },
  }
}

function ensureDataDir(dbPath: string) {
  if (dbPath === ':memory:') {
    return
  }

  const dir = path.dirname(dbPath)
  if (!dir) return

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    // Ignore mkdir failures; SQLite will surface errors when opening
  }

  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    // Ignore chmod failures
  }
}

function mapRow(row: Record<string, unknown>): AgentSessionRecord {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id ?? ''),
    logFilePath: String(row.log_file_path ?? ''),
    projectPath: String(row.project_path ?? ''),
    agentType: row.agent_type as AgentType,
    displayName: String(row.display_name ?? ''),
    createdAt: String(row.created_at ?? ''),
    lastActivityAt: String(row.last_activity_at ?? ''),
    lastUserMessage:
      row.last_user_message === null || row.last_user_message === undefined
        ? null
        : String(row.last_user_message),
    currentWindow:
      row.current_window === null || row.current_window === undefined
        ? null
        : String(row.current_window),
    isPinned: Number(row.is_pinned) === 1,
    lastResumeError:
      row.last_resume_error === null || row.last_resume_error === undefined
        ? null
        : String(row.last_resume_error),
  }
}

function migrateDatabase(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (columns.length === 0 || !columns.includes('session_source')) {
    return
  }

  db.exec('BEGIN')
  try {
    db.exec('ALTER TABLE agent_sessions RENAME TO agent_sessions_old')
    createAgentSessionsTable(db, 'agent_sessions')
    db.exec(`
      INSERT INTO agent_sessions (
        id,
        session_id,
        log_file_path,
        project_path,
        agent_type,
        display_name,
        created_at,
        last_activity_at,
        last_user_message,
        current_window
      )
      SELECT
        id,
        session_id,
        log_file_path,
        project_path,
        agent_type,
        display_name,
        created_at,
        last_activity_at,
        NULL AS last_user_message,
        current_window
      FROM agent_sessions_old
      WHERE session_source = 'log'
    `)
    db.exec('DROP TABLE agent_sessions_old')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function createAgentSessionsTable(db: SQLiteDatabase, tableName: string) {
  db.exec(`
    CREATE TABLE ${tableName} (
${AGENT_SESSIONS_COLUMNS_SQL}
    );
  `)
}

function migrateLastUserMessageColumn(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (columns.length === 0 || columns.includes('last_user_message')) {
    return
  }
  db.exec('ALTER TABLE agent_sessions ADD COLUMN last_user_message TEXT')
}

function migrateIsPinnedColumn(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (columns.length === 0 || columns.includes('is_pinned')) {
    return
  }
  db.exec('ALTER TABLE agent_sessions ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0')
}

function migrateLastResumeErrorColumn(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (columns.length === 0 || columns.includes('last_resume_error')) {
    return
  }
  db.exec('ALTER TABLE agent_sessions ADD COLUMN last_resume_error TEXT')
}

function migrateDeduplicateDisplayNames(db: SQLiteDatabase) {
  // Find all display names that have duplicates
  const duplicates = db
    .prepare(
      `SELECT display_name, COUNT(*) as count
       FROM agent_sessions
       GROUP BY display_name
       HAVING count > 1`
    )
    .all() as Array<{ display_name: string; count: number }>

  if (duplicates.length === 0) {
    return
  }

  const updateStmt = db.prepare(
    'UPDATE agent_sessions SET display_name = $newName WHERE session_id = $sessionId'
  )

  for (const { display_name } of duplicates) {
    // Get all sessions with this name, ordered by created_at (oldest first)
    const sessions = db
      .prepare(
        `SELECT session_id, display_name
         FROM agent_sessions
         WHERE display_name = $displayName
         ORDER BY created_at ASC`
      )
      .all({ $displayName: display_name }) as Array<{
      session_id: string
      display_name: string
    }>

    // Keep first one as-is, rename the rest
    for (let i = 1; i < sessions.length; i++) {
      const suffix = i + 1
      let newName = `${display_name}-${suffix}`

      // Make sure the new name doesn't already exist
      while (
        db
          .prepare(
            'SELECT 1 FROM agent_sessions WHERE display_name = $name LIMIT 1'
          )
          .get({ $name: newName }) != null
      ) {
        newName = `${display_name}-${suffix}-${Date.now().toString(36).slice(-4)}`
      }

      updateStmt.run({ $newName: newName, $sessionId: sessions[i].session_id })
    }
  }
}

function getColumnNames(db: SQLiteDatabase, tableName: string): string[] {
  const rows = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name?: string }>
  return rows.map((row) => String(row.name ?? '')).filter(Boolean)
}

// ─── Cron Tables ─────────────────────────────────────────────────────────────

export interface CronJobPrefsRecord {
  jobId: string
  customAvatarStyle: string | null
  customName: string | null
  isFavorite: boolean
  isManaged: boolean
  linkedSessionId: string | null
  tags: string[] // stored as JSON
  notes: string | null
  lastSeen: string | null
  createdAt: string
  updatedAt: string
}

export interface CronRunHistoryRecord {
  id: number
  jobId: string
  timestamp: string
  endTimestamp: string | null
  duration: number | null
  exitCode: number | null
  trigger: string
  logSnippet: string | null
  createdAt: string
}

export interface CronPrefsStore {
  getPrefs: (jobId: string) => CronJobPrefsRecord
  upsertPrefs: (jobId: string, patch: Partial<Omit<CronJobPrefsRecord, 'jobId' | 'createdAt' | 'updatedAt'>>) => CronJobPrefsRecord
  setTags: (jobId: string, tags: string[]) => void
  setManaged: (jobId: string, isManaged: boolean) => void
  setLinkedSession: (jobId: string, sessionId: string | null) => void
  getFavorites: () => CronJobPrefsRecord[]
  getAllTags: () => string[]
  updateLastSeen: (jobIds: string[]) => void
  deleteOrphanedPrefs: (maxAgeHours: number) => number
  insertRunHistory: (record: Omit<CronRunHistoryRecord, 'id' | 'createdAt'>) => CronRunHistoryRecord
  getRunHistory: (jobId: string, limit: number, before?: string) => CronRunHistoryRecord[]
  getRecentDurations: (jobId: string, count: number) => number[]
  close: () => void
}

function mapCronPrefsRow(row: Record<string, unknown>): CronJobPrefsRecord {
  let tags: string[] = []
  try {
    tags = JSON.parse(String(row.tags ?? '[]'))
  } catch {
    tags = []
  }
  return {
    jobId: String(row.job_id ?? ''),
    customAvatarStyle: row.custom_avatar_style === null || row.custom_avatar_style === undefined ? null : String(row.custom_avatar_style),
    customName: row.custom_name === null || row.custom_name === undefined ? null : String(row.custom_name),
    isFavorite: Number(row.is_favorite) === 1,
    isManaged: Number(row.is_managed) === 1,
    linkedSessionId: row.linked_session_id === null || row.linked_session_id === undefined ? null : String(row.linked_session_id),
    tags,
    notes: row.notes === null || row.notes === undefined ? null : String(row.notes),
    lastSeen: row.last_seen === null || row.last_seen === undefined ? null : String(row.last_seen),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  }
}

function mapCronRunHistoryRow(row: Record<string, unknown>): CronRunHistoryRecord {
  return {
    id: Number(row.id),
    jobId: String(row.job_id ?? ''),
    timestamp: String(row.timestamp ?? ''),
    endTimestamp: row.end_timestamp === null || row.end_timestamp === undefined ? null : String(row.end_timestamp),
    duration: row.duration === null || row.duration === undefined ? null : Number(row.duration),
    exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
    trigger: String(row.trigger ?? 'scheduled'),
    logSnippet: row.log_snippet === null || row.log_snippet === undefined ? null : String(row.log_snippet),
    createdAt: String(row.created_at ?? ''),
  }
}

export function initCronTables(db: SQLiteDatabase): CronPrefsStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_job_prefs (
      job_id TEXT PRIMARY KEY,
      custom_avatar_style TEXT,
      custom_name TEXT,
      is_favorite INTEGER DEFAULT 0,
      is_managed INTEGER DEFAULT 0,
      linked_session_id TEXT,
      tags TEXT DEFAULT '[]',
      notes TEXT,
      last_seen TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cron_run_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES cron_job_prefs(job_id) ON DELETE CASCADE,
      timestamp TEXT NOT NULL,
      end_timestamp TEXT,
      duration INTEGER,
      exit_code INTEGER,
      trigger TEXT DEFAULT 'scheduled',
      log_snippet TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_cron_run_history_job_time
      ON cron_run_history (job_id, timestamp DESC);
  `)

  const selectPrefs = db.prepare(
    'SELECT * FROM cron_job_prefs WHERE job_id = $jobId'
  )
  const insertPrefs = db.prepare(
    `INSERT OR IGNORE INTO cron_job_prefs (job_id) VALUES ($jobId)`
  )
  const selectFavorites = db.prepare(
    "SELECT * FROM cron_job_prefs WHERE is_favorite = 1"
  )
  const insertRunHistoryStmt = db.prepare(
    `INSERT INTO cron_run_history
      (job_id, timestamp, end_timestamp, duration, exit_code, trigger, log_snippet)
     VALUES ($jobId, $timestamp, $endTimestamp, $duration, $exitCode, $trigger, $logSnippet)`
  )
  const selectRunHistory = db.prepare(
    `SELECT * FROM cron_run_history WHERE job_id = $jobId ORDER BY timestamp DESC LIMIT $limit`
  )
  const selectRunHistoryBefore = db.prepare(
    `SELECT * FROM cron_run_history WHERE job_id = $jobId AND timestamp < $before ORDER BY timestamp DESC LIMIT $limit`
  )
  const selectRecentDurations = db.prepare(
    `SELECT duration FROM cron_run_history WHERE job_id = $jobId AND duration IS NOT NULL ORDER BY timestamp DESC LIMIT $count`
  )

  return {
    getPrefs: (jobId) => {
      // Insert default row if not present, then return
      insertPrefs.run({ $jobId: jobId })
      const row = selectPrefs.get({ $jobId: jobId }) as Record<string, unknown> | undefined
      if (!row) throw new Error(`Failed to get/create cron prefs for job ${jobId}`)
      return mapCronPrefsRow(row)
    },

    upsertPrefs: (jobId, patch) => {
      insertPrefs.run({ $jobId: jobId })
      const fieldMap: Record<string, string> = {
        customAvatarStyle: 'custom_avatar_style',
        customName: 'custom_name',
        isFavorite: 'is_favorite',
        isManaged: 'is_managed',
        linkedSessionId: 'linked_session_id',
        tags: 'tags',
        notes: 'notes',
        lastSeen: 'last_seen',
      }
      const entries = Object.entries(patch).filter(([, v]) => v !== undefined)
      if (entries.length > 0) {
        const setClauses = entries.map(([key]) => {
          const col = fieldMap[key]
          return col ? `${col} = $${col}` : null
        }).filter(Boolean)
        setClauses.push(`updated_at = datetime('now')`)
        const params: Record<string, string | number | null> = { $job_id: jobId }
        for (const [key, value] of entries) {
          const col = fieldMap[key]
          if (!col) continue
          if (key === 'isFavorite' || key === 'isManaged') {
            params[`$${col}`] = value ? 1 : 0
          } else if (key === 'tags') {
            params[`$${col}`] = JSON.stringify(value)
          } else {
            params[`$${col}`] = value as string | number | null
          }
        }
        db.prepare(
          `UPDATE cron_job_prefs SET ${setClauses.join(', ')} WHERE job_id = $job_id`
        ).run(params)
      }
      const row = selectPrefs.get({ $jobId: jobId }) as Record<string, unknown> | undefined
      if (!row) throw new Error(`Failed to upsert cron prefs for job ${jobId}`)
      return mapCronPrefsRow(row)
    },

    setTags: (jobId, tags) => {
      insertPrefs.run({ $jobId: jobId })
      db.prepare(
        `UPDATE cron_job_prefs SET tags = $tags, updated_at = datetime('now') WHERE job_id = $jobId`
      ).run({ $jobId: jobId, $tags: JSON.stringify(tags) })
    },

    setManaged: (jobId, isManaged) => {
      insertPrefs.run({ $jobId: jobId })
      db.prepare(
        `UPDATE cron_job_prefs SET is_managed = $isManaged, updated_at = datetime('now') WHERE job_id = $jobId`
      ).run({ $jobId: jobId, $isManaged: isManaged ? 1 : 0 })
    },

    setLinkedSession: (jobId, sessionId) => {
      insertPrefs.run({ $jobId: jobId })
      db.prepare(
        `UPDATE cron_job_prefs SET linked_session_id = $sessionId, updated_at = datetime('now') WHERE job_id = $jobId`
      ).run({ $jobId: jobId, $sessionId: sessionId })
    },

    getFavorites: () => {
      const rows = selectFavorites.all() as Record<string, unknown>[]
      return rows.map(mapCronPrefsRow)
    },

    getAllTags: () => {
      const rows = db
        .prepare("SELECT tags FROM cron_job_prefs WHERE tags != '[]' AND tags IS NOT NULL")
        .all() as Array<{ tags: string }>
      const tagSet = new Set<string>()
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.tags) as string[]
          for (const tag of parsed) {
            if (tag) tagSet.add(tag)
          }
        } catch {
          // skip malformed
        }
      }
      return Array.from(tagSet).sort()
    },

    updateLastSeen: (jobIds) => {
      if (jobIds.length === 0) return
      const now = new Date().toISOString()
      const placeholders = jobIds.map((_, i) => `$id${i}`).join(', ')
      const params: Record<string, string> = { $now: now }
      jobIds.forEach((id, i) => { params[`$id${i}`] = id })
      db.prepare(
        `UPDATE cron_job_prefs SET last_seen = $now WHERE job_id IN (${placeholders})`
      ).run(params)
    },

    deleteOrphanedPrefs: (maxAgeHours) => {
      const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString()
      const result = db.prepare(
        `DELETE FROM cron_job_prefs
         WHERE last_seen IS NOT NULL AND last_seen < $cutoff`
      ).run({ $cutoff: cutoff })
      return result.changes
    },

    insertRunHistory: (record) => {
      insertPrefs.run({ $jobId: record.jobId })
      insertRunHistoryStmt.run({
        $jobId: record.jobId,
        $timestamp: record.timestamp,
        $endTimestamp: record.endTimestamp,
        $duration: record.duration,
        $exitCode: record.exitCode,
        $trigger: record.trigger ?? 'scheduled',
        $logSnippet: record.logSnippet,
      })
      const row = db.prepare(
        'SELECT * FROM cron_run_history WHERE rowid = last_insert_rowid()'
      ).get() as Record<string, unknown> | undefined
      if (!row) throw new Error('Failed to insert cron run history')
      return mapCronRunHistoryRow(row)
    },

    getRunHistory: (jobId, limit, before) => {
      const rows = before
        ? selectRunHistoryBefore.all({ $jobId: jobId, $before: before, $limit: limit }) as Record<string, unknown>[]
        : selectRunHistory.all({ $jobId: jobId, $limit: limit }) as Record<string, unknown>[]
      return rows.map(mapCronRunHistoryRow)
    },

    getRecentDurations: (jobId, count) => {
      const rows = selectRecentDurations.all({ $jobId: jobId, $count: count }) as Array<{ duration: number }>
      return rows.map(r => Number(r.duration))
    },

    close: () => {
      selectPrefs.finalize()
      insertPrefs.finalize()
      selectFavorites.finalize()
      insertRunHistoryStmt.finalize()
      selectRunHistory.finalize()
      selectRunHistoryBefore.finalize()
      selectRecentDurations.finalize()
    },
  }
}

// ─── Session Pool Tables (Phase 5) ──────────────────────────────────────────

export function initPoolTables(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_pool_config (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      max_slots INTEGER NOT NULL DEFAULT 2,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO session_pool_config (id, max_slots) VALUES (1, 2);

    CREATE TABLE IF NOT EXISTS pool_slot_requests (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_name TEXT NOT NULL,
      tier INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'queued',
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      granted_at TEXT,
      released_at TEXT,
      FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_pool_requests_status ON pool_slot_requests(status);
    CREATE INDEX IF NOT EXISTS idx_pool_requests_priority ON pool_slot_requests(tier DESC, requested_at ASC);
  `)
}

export function reconcilePoolSlots(db: SQLiteDatabase): void {
  // Check if tmux is available
  let tmuxAvailable = false
  try {
    const result = Bun.spawnSync(['tmux', '-V'], { stdout: 'pipe', stderr: 'pipe' })
    tmuxAvailable = result.exitCode === 0
  } catch {
    tmuxAvailable = false
  }

  // If tmux not available, release all active and queued slots (safe fallback)
  if (!tmuxAvailable) {
    db.exec(`
      UPDATE pool_slot_requests
      SET status = 'released', released_at = datetime('now')
      WHERE status IN ('active', 'queued')
    `)
    return
  }

  // Check if required tables exist (handles test environment and partial initialization)
  let tablesExist = false
  try {
    const result = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tasks', 'workflow_runs')"
    ).all() as Array<{ name: string }>
    tablesExist = result.length === 2
  } catch {
    tablesExist = false
  }

  // If tables don't exist, release all active and queued slots (safe fallback)
  if (!tablesExist) {
    db.exec(`
      UPDATE pool_slot_requests
      SET status = 'released', released_at = datetime('now')
      WHERE status IN ('active', 'queued')
    `)
    return
  }

  // CF-03/REQ-29: Use poolStore.reconcileOrphanedSlots with a tmux session checker.
  // This checks each active slot's tmux session before releasing, and promotes
  // queued entries in priority order after releasing orphaned slots.
  const poolStore = createPoolStore(db)

  // Query directly to avoid circular dependencies
  const getTaskStmt = db.prepare('SELECT * FROM tasks WHERE id = $id')
  const getRunStmt = db.prepare('SELECT * FROM workflow_runs WHERE id = $id')

  poolStore.reconcileOrphanedSlots((_slotId, runId, stepName) => {
    // Returns true if tmux session is alive, false if dead/orphaned
    try {
      const runRow = getRunStmt.get({ $id: runId }) as Record<string, unknown> | undefined
      if (!runRow) return false

      const stepsStateStr = String(runRow.steps_state ?? '[]')
      const stepsState = JSON.parse(stepsStateStr) as Array<{ name: string; taskId: string | null }>

      const step = stepsState.find((s) => s.name === stepName)
      if (!step || !step.taskId) return false

      const taskRow = getTaskStmt.get({ $id: step.taskId }) as Record<string, unknown> | undefined
      if (!taskRow || !taskRow.tmux_window) return false

      const tmuxWindow = String(taskRow.tmux_window)
      const check = Bun.spawnSync(['tmux', 'has-session', '-t', tmuxWindow], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      return check.exitCode === 0
    } catch {
      return false // On any error, treat as dead (safe fallback)
    }
  })
}
