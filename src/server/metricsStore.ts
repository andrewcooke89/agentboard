/**
 * metricsStore.ts — Persistent storage for nightly pipeline metrics,
 * ticket events, and swarm dispatch events.
 *
 * Stores flattened NightlyReport data into `nightly_metrics` table,
 * ticket state changes into `ticket_events`, and WO dispatch lifecycle
 * into `dispatch_events` — all in the existing agentboard SQLite DB.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NightlyReport {
  date: string
  project: string
  startedAt: string
  completedAt: string
  durationMinutes: number
  detect: {
    detectors_run: string[]
    findings_total: number
    tickets_created: number
    tickets_stale_resolved: number
  }
  fix: {
    cycles: number
    fixed: number
    failed: number
    skipped_blocked: number
    small: { dispatched: number; succeeded: number; failed: number }
    medium: { dispatched: number; succeeded: number; failed: number }
    prs_opened: string[]
  }
  backlog: {
    total_open: number
    by_effort: Record<string, number>
    by_category: Record<string, number>
    blocked: number
  }
  notable_failures: Array<{ ticket_id: string; title: string; reason: string }>
}

export interface NightlyMetricsRow {
  date: string
  project: string
  started_at: string | null
  completed_at: string | null
  duration_minutes: number
  detectors_run: number
  findings_total: number
  tickets_created: number
  tickets_stale_resolved: number
  fix_cycles: number
  fix_fixed: number
  fix_failed: number
  fix_skipped_blocked: number
  small_dispatched: number
  small_succeeded: number
  small_failed: number
  medium_dispatched: number
  medium_succeeded: number
  medium_failed: number
  prs_opened: string[]
  backlog_total_open: number
  backlog_by_effort: Record<string, number>
  backlog_by_category: Record<string, number>
  backlog_blocked: number
  notable_failures: Array<{ ticket_id: string; title: string; reason: string }>
  raw_report: NightlyReport
}

export interface MetricsSummary {
  avg_fixed: number
  avg_created: number
  total_fixed: number
  total_created: number
  avg_duration: number
  trend: 'improving' | 'stable' | 'degrading'
}

export interface DailyActivity {
  date: string
  tickets: {
    created: number
    fixed: number
    failed: number
    dismissed: number
    reopened: number
  }
  dispatches: {
    started: number
    completed: number
    failed: number
    escalated: number
    total_tokens: number
    total_duration_seconds: number
  }
}

export interface TicketEventRow {
  id: number
  timestamp: string
  date: string
  ticket_id: string
  action: string
  from_status: string | null
  to_status: string | null
  source: string | null
  metadata: Record<string, unknown>
}

export interface DispatchEventRow {
  id: number
  timestamp: string
  date: string
  group_id: string
  wo_id: string
  action: string
  model: string | null
  duration_seconds: number | null
  input_tokens: number
  output_tokens: number
  files_changed: number
  error: string | null
  source: string | null
  metadata: Record<string, unknown>
}

// ─── Create table SQL ────────────────────────────────────────────────────────

const CREATE_TICKET_EVENTS_SQL = `
  CREATE TABLE IF NOT EXISTS ticket_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT NOT NULL,
    date        TEXT NOT NULL,
    ticket_id   TEXT NOT NULL,
    action      TEXT NOT NULL,
    from_status TEXT,
    to_status   TEXT,
    source      TEXT,
    metadata    TEXT DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_ticket_events_date   ON ticket_events(date);
  CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON ticket_events(ticket_id);
`

const CREATE_DISPATCH_EVENTS_SQL = `
  CREATE TABLE IF NOT EXISTS dispatch_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp        TEXT NOT NULL,
    date             TEXT NOT NULL,
    group_id         TEXT NOT NULL,
    wo_id            TEXT NOT NULL,
    action           TEXT NOT NULL,
    model            TEXT,
    duration_seconds REAL,
    input_tokens     INTEGER DEFAULT 0,
    output_tokens    INTEGER DEFAULT 0,
    files_changed    INTEGER DEFAULT 0,
    error            TEXT,
    source           TEXT,
    metadata         TEXT DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_dispatch_events_date  ON dispatch_events(date);
  CREATE INDEX IF NOT EXISTS idx_dispatch_events_group ON dispatch_events(group_id);
`

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS nightly_metrics (
    date                  TEXT PRIMARY KEY,
    project               TEXT NOT NULL,
    started_at            TEXT,
    completed_at          TEXT,
    duration_minutes      INTEGER DEFAULT 0,
    detectors_run         INTEGER DEFAULT 0,
    findings_total        INTEGER DEFAULT 0,
    tickets_created       INTEGER DEFAULT 0,
    tickets_stale_resolved INTEGER DEFAULT 0,
    fix_cycles            INTEGER DEFAULT 0,
    fix_fixed             INTEGER DEFAULT 0,
    fix_failed            INTEGER DEFAULT 0,
    fix_skipped_blocked   INTEGER DEFAULT 0,
    small_dispatched      INTEGER DEFAULT 0,
    small_succeeded       INTEGER DEFAULT 0,
    small_failed          INTEGER DEFAULT 0,
    medium_dispatched     INTEGER DEFAULT 0,
    medium_succeeded      INTEGER DEFAULT 0,
    medium_failed         INTEGER DEFAULT 0,
    prs_opened            TEXT DEFAULT '[]',
    backlog_total_open    INTEGER DEFAULT 0,
    backlog_by_effort     TEXT DEFAULT '{}',
    backlog_by_category   TEXT DEFAULT '{}',
    backlog_blocked       INTEGER DEFAULT 0,
    notable_failures      TEXT DEFAULT '[]',
    raw_report            TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_nightly_metrics_date ON nightly_metrics(date DESC);
`

// ─── Row mapping ─────────────────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): NightlyMetricsRow {
  return {
    date: String(row.date ?? ''),
    project: String(row.project ?? ''),
    started_at: row.started_at != null ? String(row.started_at) : null,
    completed_at: row.completed_at != null ? String(row.completed_at) : null,
    duration_minutes: Number(row.duration_minutes ?? 0),
    detectors_run: Number(row.detectors_run ?? 0),
    findings_total: Number(row.findings_total ?? 0),
    tickets_created: Number(row.tickets_created ?? 0),
    tickets_stale_resolved: Number(row.tickets_stale_resolved ?? 0),
    fix_cycles: Number(row.fix_cycles ?? 0),
    fix_fixed: Number(row.fix_fixed ?? 0),
    fix_failed: Number(row.fix_failed ?? 0),
    fix_skipped_blocked: Number(row.fix_skipped_blocked ?? 0),
    small_dispatched: Number(row.small_dispatched ?? 0),
    small_succeeded: Number(row.small_succeeded ?? 0),
    small_failed: Number(row.small_failed ?? 0),
    medium_dispatched: Number(row.medium_dispatched ?? 0),
    medium_succeeded: Number(row.medium_succeeded ?? 0),
    medium_failed: Number(row.medium_failed ?? 0),
    prs_opened: parseJsonArray(row.prs_opened),
    backlog_total_open: Number(row.backlog_total_open ?? 0),
    backlog_by_effort: parseJsonObject(row.backlog_by_effort),
    backlog_by_category: parseJsonObject(row.backlog_by_category),
    backlog_blocked: Number(row.backlog_blocked ?? 0),
    notable_failures: parseJsonArray(row.notable_failures),
    raw_report: parseJsonObject(row.raw_report) as unknown as NightlyReport,
  }
}

function parseJsonArray(value: unknown): any[] {
  if (typeof value !== 'string') return []
  try { return JSON.parse(value) } catch (e) { console.error('Failed to parse JSON array:', e); return [] }
}

function parseJsonObject(value: unknown): Record<string, any> {
  if (typeof value !== 'string') return {}
  try { return JSON.parse(value) } catch (e) { console.error('Failed to parse JSON object:', e); return {} }
}

// ─── MetricsStore class ───────────────────────────────────────────────────────

export class MetricsStore {
  private readonly db: SQLiteDatabase
  private readonly upsertStmt: ReturnType<SQLiteDatabase['prepare']>
  private readonly getReportStmt: ReturnType<SQLiteDatabase['prepare']>
  private readonly getRangeStmt: ReturnType<SQLiteDatabase['prepare']>
  private readonly getLatestStmt: ReturnType<SQLiteDatabase['prepare']>
  private readonly insertTicketEventStmt: ReturnType<SQLiteDatabase['prepare']>
  private readonly insertDispatchEventStmt: ReturnType<SQLiteDatabase['prepare']>
  private readonly getTicketEventsStmt: ReturnType<SQLiteDatabase['prepare']>
  private readonly getTicketEventsByTicketStmt: ReturnType<SQLiteDatabase['prepare']>
  private readonly getDispatchEventsStmt: ReturnType<SQLiteDatabase['prepare']>
  private readonly getDispatchEventsByGroupStmt: ReturnType<SQLiteDatabase['prepare']>

  constructor(db: SQLiteDatabase) {
    this.db = db

    // Create tables
    db.exec(CREATE_TABLE_SQL)
    db.exec(CREATE_TICKET_EVENTS_SQL)
    db.exec(CREATE_DISPATCH_EVENTS_SQL)

    // Prepare statements
    this.upsertStmt = db.prepare(`
      INSERT OR REPLACE INTO nightly_metrics (
        date, project, started_at, completed_at, duration_minutes,
        detectors_run, findings_total, tickets_created, tickets_stale_resolved,
        fix_cycles, fix_fixed, fix_failed, fix_skipped_blocked,
        small_dispatched, small_succeeded, small_failed,
        medium_dispatched, medium_succeeded, medium_failed,
        prs_opened, backlog_total_open, backlog_by_effort, backlog_by_category,
        backlog_blocked, notable_failures, raw_report
      ) VALUES (
        $date, $project, $started_at, $completed_at, $duration_minutes,
        $detectors_run, $findings_total, $tickets_created, $tickets_stale_resolved,
        $fix_cycles, $fix_fixed, $fix_failed, $fix_skipped_blocked,
        $small_dispatched, $small_succeeded, $small_failed,
        $medium_dispatched, $medium_succeeded, $medium_failed,
        $prs_opened, $backlog_total_open, $backlog_by_effort, $backlog_by_category,
        $backlog_blocked, $notable_failures, $raw_report
      )
    `)

    this.getReportStmt = db.prepare(
      'SELECT * FROM nightly_metrics WHERE date = $date'
    )

    this.getRangeStmt = db.prepare(
      'SELECT * FROM nightly_metrics WHERE date >= $startDate AND date <= $endDate ORDER BY date DESC'
    )

    this.getLatestStmt = db.prepare(
      'SELECT * FROM nightly_metrics ORDER BY date DESC LIMIT $limit'
    )

    this.insertTicketEventStmt = db.prepare(`
      INSERT INTO ticket_events (timestamp, date, ticket_id, action, from_status, to_status, source, metadata)
      VALUES ($timestamp, $date, $ticket_id, $action, $from_status, $to_status, $source, $metadata)
    `)

    this.insertDispatchEventStmt = db.prepare(`
      INSERT INTO dispatch_events (timestamp, date, group_id, wo_id, action, model, duration_seconds, input_tokens, output_tokens, files_changed, error, source, metadata)
      VALUES ($timestamp, $date, $group_id, $wo_id, $action, $model, $duration_seconds, $input_tokens, $output_tokens, $files_changed, $error, $source, $metadata)
    `)

    this.getTicketEventsStmt = db.prepare(
      'SELECT * FROM ticket_events WHERE date >= $startDate ORDER BY timestamp DESC'
    )

    this.getTicketEventsByTicketStmt = db.prepare(
      'SELECT * FROM ticket_events WHERE date >= $startDate AND ticket_id = $ticket_id ORDER BY timestamp DESC'
    )

    this.getDispatchEventsStmt = db.prepare(
      'SELECT * FROM dispatch_events WHERE date >= $startDate ORDER BY timestamp DESC'
    )

    this.getDispatchEventsByGroupStmt = db.prepare(
      'SELECT * FROM dispatch_events WHERE date >= $startDate AND group_id = $group_id ORDER BY timestamp DESC'
    )

    // Backfill from existing report files on startup
    this.backfillFromReportFiles(
      path.join(process.env.HOME ?? '/root', '.agentboard', 'reports')
    )
  }

  upsertReport(report: NightlyReport): void {
    this.upsertStmt.run({
      $date: report.date,
      $project: report.project,
      $started_at: report.startedAt ?? null,
      $completed_at: report.completedAt ?? null,
      $duration_minutes: Math.round(report.durationMinutes ?? 0),
      $detectors_run: report.detect?.detectors_run?.length ?? 0,
      $findings_total: report.detect?.findings_total ?? 0,
      $tickets_created: report.detect?.tickets_created ?? 0,
      $tickets_stale_resolved: report.detect?.tickets_stale_resolved ?? 0,
      $fix_cycles: report.fix?.cycles ?? 0,
      $fix_fixed: report.fix?.fixed ?? 0,
      $fix_failed: report.fix?.failed ?? 0,
      $fix_skipped_blocked: report.fix?.skipped_blocked ?? 0,
      $small_dispatched: report.fix?.small?.dispatched ?? 0,
      $small_succeeded: report.fix?.small?.succeeded ?? 0,
      $small_failed: report.fix?.small?.failed ?? 0,
      $medium_dispatched: report.fix?.medium?.dispatched ?? 0,
      $medium_succeeded: report.fix?.medium?.succeeded ?? 0,
      $medium_failed: report.fix?.medium?.failed ?? 0,
      $prs_opened: JSON.stringify(report.fix?.prs_opened ?? []),
      $backlog_total_open: report.backlog?.total_open ?? 0,
      $backlog_by_effort: JSON.stringify(report.backlog?.by_effort ?? {}),
      $backlog_by_category: JSON.stringify(report.backlog?.by_category ?? {}),
      $backlog_blocked: report.backlog?.blocked ?? 0,
      $notable_failures: JSON.stringify(report.notable_failures ?? []),
      $raw_report: JSON.stringify(report),
    })
  }

  getReport(date: string): NightlyMetricsRow | null {
    const row = this.getReportStmt.get({ $date: date }) as Record<string, unknown> | undefined
    return row ? mapRow(row) : null
  }

  getRange(startDate: string, endDate: string): NightlyMetricsRow[] {
    const rows = this.getRangeStmt.all({ $startDate: startDate, $endDate: endDate }) as Record<string, unknown>[]
    return rows.map(mapRow)
  }

  getLatest(limit: number): NightlyMetricsRow[] {
    const rows = this.getLatestStmt.all({ $limit: limit }) as Record<string, unknown>[]
    return rows.map(mapRow)
  }

  getSummary(days: number): MetricsSummary {
    const endDate = new Date().toISOString().split('T')[0]
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const rows = this.getRange(startDate, endDate)

    if (rows.length === 0) {
      return { avg_fixed: 0, avg_created: 0, total_fixed: 0, total_created: 0, avg_duration: 0, trend: 'stable' }
    }

    const total_fixed = rows.reduce((s, r) => s + r.fix_fixed, 0)
    const total_created = rows.reduce((s, r) => s + r.tickets_created, 0)
    const avg_fixed = total_fixed / rows.length
    const avg_created = total_created / rows.length
    const avg_duration = rows.reduce((s, r) => s + r.duration_minutes, 0) / rows.length

    // Trend: compare first half vs second half fix rate
    const trend = computeTrend(rows)

    return { avg_fixed, avg_created, total_fixed, total_created, avg_duration, trend }
  }

  recordTicketEvent(event: {
    ticketId: string
    action: string
    fromStatus?: string
    toStatus?: string
    source?: string
    metadata?: Record<string, unknown>
  }): void {
    const now = new Date().toISOString()
    this.insertTicketEventStmt.run({
      $timestamp: now,
      $date: now.split('T')[0],
      $ticket_id: event.ticketId,
      $action: event.action,
      $from_status: event.fromStatus ?? null,
      $to_status: event.toStatus ?? null,
      $source: event.source ?? null,
      $metadata: JSON.stringify(event.metadata ?? {}),
    })
  }

  recordDispatchEvent(event: {
    groupId: string
    woId: string
    action: string
    model?: string
    durationSeconds?: number
    inputTokens?: number
    outputTokens?: number
    filesChanged?: number
    error?: string
    source?: string
    metadata?: Record<string, unknown>
  }): void {
    const now = new Date().toISOString()
    this.insertDispatchEventStmt.run({
      $timestamp: now,
      $date: now.split('T')[0],
      $group_id: event.groupId,
      $wo_id: event.woId,
      $action: event.action,
      $model: event.model ?? null,
      $duration_seconds: event.durationSeconds ?? null,
      $input_tokens: event.inputTokens ?? 0,
      $output_tokens: event.outputTokens ?? 0,
      $files_changed: event.filesChanged ?? 0,
      $error: event.error ?? null,
      $source: event.source ?? null,
      $metadata: JSON.stringify(event.metadata ?? {}),
    })
  }

  getDailyActivity(days: number): DailyActivity[] {
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

    const ticketRows = this.getTicketEventsStmt.all({ $startDate: startDate }) as Record<string, unknown>[]
    const dispatchRows = this.getDispatchEventsStmt.all({ $startDate: startDate }) as Record<string, unknown>[]

    // Build a map of date -> DailyActivity
    const activityMap = new Map<string, DailyActivity>()

    const getOrCreate = (date: string): DailyActivity => {
      if (!activityMap.has(date)) {
        activityMap.set(date, {
          date,
          tickets: { created: 0, fixed: 0, failed: 0, dismissed: 0, reopened: 0 },
          dispatches: { started: 0, completed: 0, failed: 0, escalated: 0, total_tokens: 0, total_duration_seconds: 0 },
        })
      }
      return activityMap.get(date)!
    }

    for (const row of ticketRows) {
      const date = String(row.date ?? '')
      const action = String(row.action ?? '')
      const day = getOrCreate(date)
      if (action === 'created') day.tickets.created++
      else if (action === 'fixed') day.tickets.fixed++
      else if (action === 'failed') day.tickets.failed++
      else if (action === 'dismissed') day.tickets.dismissed++
      else if (action === 'reopened') day.tickets.reopened++
    }

    for (const row of dispatchRows) {
      const date = String(row.date ?? '')
      const action = String(row.action ?? '')
      const day = getOrCreate(date)
      const tokens = Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0)
      const duration = Number(row.duration_seconds ?? 0)
      if (action === 'started') day.dispatches.started++
      else if (action === 'completed') day.dispatches.completed++
      else if (action === 'failed') day.dispatches.failed++
      else if (action === 'escalated') day.dispatches.escalated++
      day.dispatches.total_tokens += tokens
      day.dispatches.total_duration_seconds += duration
    }

    return [...activityMap.values()].sort((a, b) => b.date.localeCompare(a.date))
  }

  getTicketEvents(days: number, ticketId?: string): TicketEventRow[] {
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const rows = ticketId
      ? this.getTicketEventsByTicketStmt.all({ $startDate: startDate, $ticket_id: ticketId })
      : this.getTicketEventsStmt.all({ $startDate: startDate })
    return (rows as Record<string, unknown>[]).map(row => ({
      id: Number(row.id ?? 0),
      timestamp: String(row.timestamp ?? ''),
      date: String(row.date ?? ''),
      ticket_id: String(row.ticket_id ?? ''),
      action: String(row.action ?? ''),
      from_status: row.from_status != null ? String(row.from_status) : null,
      to_status: row.to_status != null ? String(row.to_status) : null,
      source: row.source != null ? String(row.source) : null,
      metadata: parseJsonObject(row.metadata),
    }))
  }

  getDispatchEvents(days: number, groupId?: string): DispatchEventRow[] {
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const rows = groupId
      ? this.getDispatchEventsByGroupStmt.all({ $startDate: startDate, $group_id: groupId })
      : this.getDispatchEventsStmt.all({ $startDate: startDate })
    return (rows as Record<string, unknown>[]).map(row => ({
      id: Number(row.id ?? 0),
      timestamp: String(row.timestamp ?? ''),
      date: String(row.date ?? ''),
      group_id: String(row.group_id ?? ''),
      wo_id: String(row.wo_id ?? ''),
      action: String(row.action ?? ''),
      model: row.model != null ? String(row.model) : null,
      duration_seconds: row.duration_seconds != null ? Number(row.duration_seconds) : null,
      input_tokens: Number(row.input_tokens ?? 0),
      output_tokens: Number(row.output_tokens ?? 0),
      files_changed: Number(row.files_changed ?? 0),
      error: row.error != null ? String(row.error) : null,
      source: row.source != null ? String(row.source) : null,
      metadata: parseJsonObject(row.metadata),
    }))
  }

  /**
   * Read existing nightly-*.json files from reportDir and insert any that
   * are not already present in the DB. Called once at startup.
   */
  backfillFromReportFiles(reportDir: string): void {
    if (!fs.existsSync(reportDir)) return

    let files: string[]
    try {
      files = fs.readdirSync(reportDir)
        .filter(f => f.startsWith('nightly-') && f.endsWith('.json'))
    } catch (e) {
      console.error('Failed to read report directory:', e)
      return
    }

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(reportDir, file), 'utf8')
        const report = JSON.parse(raw) as NightlyReport
        if (!report.date || !/^\d{4}-\d{2}-\d{2}$/.test(report.date)) continue

        // Only insert if not already present
        const existing = this.getReport(report.date)
        if (!existing) {
          this.upsertReport(report)
        }
      } catch (e) {
        console.error(`Failed to process ${file}:`, e)
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeTrend(rows: NightlyMetricsRow[]): MetricsSummary['trend'] {
  if (rows.length < 4) return 'stable'

  // rows are sorted DESC (newest first) — reverse for chronological order
  const chronological = [...rows].reverse()
  const half = Math.floor(chronological.length / 2)
  const first = chronological.slice(0, half)
  const second = chronological.slice(half)

  const avgFixed = (slice: NightlyMetricsRow[]) =>
    slice.reduce((s, r) => s + r.fix_fixed, 0) / slice.length

  const firstAvg = avgFixed(first)
  const secondAvg = avgFixed(second)

  if (firstAvg === 0) return 'stable'
  const delta = (secondAvg - firstAvg) / firstAvg

  if (delta > 0.1) return 'improving'
  if (delta < -0.1) return 'degrading'
  return 'stable'
}
