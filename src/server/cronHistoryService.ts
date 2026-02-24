// cronHistoryService.ts — Run history collection and aggregation
// WU-006: History & Log Services
//
// Collects run history from journalctl/syslog and database.
// Provides unified API abstracting platform differences.

import type { CronJob, JobRunRecord } from '../shared/types'
import type { CronPrefsStore } from './db'
import { logger } from './logger'

const HISTORY_TIMEOUT_MS = 5000

export class CronHistoryService {
  private db: CronPrefsStore
  private getJob: (id: string) => CronJob | undefined

  constructor(db: CronPrefsStore, getJob: (id: string) => CronJob | undefined) {
    this.db = db
    this.getJob = getJob
  }

  /**
   * Get run history for a job (REQ-30: last 50 by default, pagination via `before`)
   * Merges manual runs from DB with system log data.
   */
  async getRunHistory(
    jobId: string,
    limit = 50,
    before?: string,
  ): Promise<JobRunRecord[]> {
    const dbRecords = this.db.getRunHistory(jobId, limit, before)
    const dbRuns: JobRunRecord[] = dbRecords.map((r) => ({
      timestamp: r.timestamp,
      endTimestamp: r.endTimestamp ?? undefined,
      duration: r.duration ?? undefined,
      exitCode: r.exitCode ?? undefined,
      trigger: r.trigger === 'manual' ? 'manual' : 'scheduled',
      logSnippet: r.logSnippet ?? undefined,
    }))

    const job = this.getJob(jobId)
    let systemRuns: JobRunRecord[] = []

    if (job) {
      if (job.source === 'systemd-user' || job.source === 'systemd-system') {
        systemRuns = await this.fetchSystemdHistory(job, limit)
      } else if (job.source === 'user-crontab' || job.source === 'system-crontab') {
        systemRuns = await this.fetchCronSyslogHistory(job, limit)
      }
    }

    // Merge: prefer DB records (they have more detail), deduplicate by timestamp
    const seen = new Set<string>(dbRuns.map((r) => r.timestamp))
    const merged: JobRunRecord[] = [...dbRuns]
    for (const run of systemRuns) {
      if (!seen.has(run.timestamp)) {
        seen.add(run.timestamp)
        merged.push(run)
      }
    }

    // Sort descending by timestamp
    merged.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))

    // Apply cursor pagination
    const filtered = before ? merged.filter((r) => r.timestamp < before) : merged

    return filtered.slice(0, limit)
  }

  /**
   * Record a manual run result in the database (REQ-39)
   */
  recordManualRun(
    jobId: string,
    result: { exitCode: number; duration: number; output: string; trigger: 'manual' },
  ): void {
    const now = new Date()
    const endTimestamp = now.toISOString()
    const startTimestamp = new Date(now.getTime() - result.duration).toISOString()
    const logSnippet = result.output.slice(-500) || null

    this.db.insertRunHistory({
      jobId,
      timestamp: startTimestamp,
      endTimestamp,
      duration: result.duration,
      exitCode: result.exitCode,
      trigger: 'manual',
      logSnippet,
    })
  }

  /**
   * Get recent durations for computing averages (REQ-62)
   * Returns last N durations for rolling average calculation.
   */
  async getRecentDurations(
    jobId: string,
    count = 10,
  ): Promise<number[]> {
    return this.db.getRecentDurations(jobId, count)
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Parse journalctl JSON output for a systemd unit to extract start/stop pairs.
   */
  private async fetchSystemdHistory(job: CronJob, limit: number): Promise<JobRunRecord[]> {
    // Derive unit name: strip .timer suffix and look for .service, or use name directly
    const unitName = job.name.endsWith('.timer')
      ? job.name.replace(/\.timer$/, '.service')
      : job.name.includes('.')
        ? job.name
        : `${job.name}.service`

    try {
      const proc = Bun.spawn(
        ['journalctl', '-u', unitName, '--output=json', '-n', String(limit * 4), '--no-pager'],
        { stdout: 'pipe', stderr: 'pipe' },
      )

      const stdout = await withTimeout(
        readStream(proc.stdout),
        HISTORY_TIMEOUT_MS,
        '',
      )

      return parseJournalctlStartStop(stdout)
    } catch (err) {
      logger.warn('cronHistoryService: journalctl history fetch failed', { err, jobId: job.id })
      return []
    }
  }

  /**
   * Parse syslog for cron job entries matching the command.
   */
  private async fetchCronSyslogHistory(job: CronJob, limit: number): Promise<JobRunRecord[]> {
    const syslogPaths = ['/var/log/syslog', '/var/log/cron', '/var/log/cron.log']

    for (const syslogPath of syslogPaths) {
      try {
        const proc = Bun.spawn(
          ['grep', 'CRON', syslogPath],
          { stdout: 'pipe', stderr: 'pipe' },
        )

        const stdout = await withTimeout(
          readStream(proc.stdout),
          HISTORY_TIMEOUT_MS,
          '',
        )

        if (!stdout) continue

        const cmdFragment = job.command.split(/\s+/)[0] ?? ''
        const runs = parseSyslogCronEntries(stdout, cmdFragment, limit)
        if (runs.length > 0) return runs
      } catch {
        // try next path
      }
    }

    return []
  }
}

// ── Parsing utilities ─────────────────────────────────────────────────────────

interface JournalEntry {
  __REALTIME_TIMESTAMP?: string
  MESSAGE?: string
  _SYSTEMD_UNIT?: string
}

/**
 * Parse journalctl --output=json lines and pair start/stop events.
 * journalctl emits one JSON object per line (NDJSON).
 */
function parseJournalctlStartStop(raw: string): JobRunRecord[] {
  const lines = raw.split('\n').filter(Boolean)
  const entries: Array<{ timestamp: string; message: string }> = []

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as JournalEntry
      const usec = obj.__REALTIME_TIMESTAMP
      const msg = obj.MESSAGE ?? ''
      if (!usec) continue
      const ts = new Date(Number(usec) / 1000).toISOString()
      entries.push({ timestamp: ts, message: String(msg) })
    } catch {
      // skip malformed lines
    }
  }

  // Pair Started/Finished entries
  const runs: JobRunRecord[] = []
  const starts: Array<{ timestamp: string }> = []

  for (const entry of entries) {
    const msg = entry.message.toLowerCase()
    if (msg.includes('started') || msg.includes('starting')) {
      starts.push({ timestamp: entry.timestamp })
    } else if (msg.includes('succeeded') || msg.includes('failed') || msg.includes('finished')) {
      const start = starts.pop()
      const exitCode = msg.includes('failed') ? 1 : 0
      if (start) {
        const startMs = new Date(start.timestamp).getTime()
        const endMs = new Date(entry.timestamp).getTime()
        runs.push({
          timestamp: start.timestamp,
          endTimestamp: entry.timestamp,
          duration: Math.max(0, endMs - startMs),
          exitCode,
          trigger: 'scheduled',
        })
      } else {
        // No paired start — emit end-only record
        runs.push({
          timestamp: entry.timestamp,
          exitCode,
          trigger: 'scheduled',
        })
      }
    }
  }

  return runs.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
}

/**
 * Parse /var/log/syslog CRON entries for a given command fragment.
 * Syslog lines look like: "Jan 15 03:00:01 host CRON[1234]: (user) CMD (command)"
 */
function parseSyslogCronEntries(raw: string, cmdFragment: string, limit: number): JobRunRecord[] {
  const lines = raw.split('\n').filter(Boolean)
  const runs: JobRunRecord[] = []
  const year = new Date().getFullYear()

  for (const line of lines) {
    if (!line.includes('CMD') || !line.includes(cmdFragment)) continue

    // Parse syslog timestamp: "Jan 15 03:00:01"
    const tsMatch = line.match(/^(\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})/)
    if (!tsMatch) continue

    try {
      const ts = new Date(`${tsMatch[1]} ${year}`).toISOString()
      runs.push({ timestamp: ts, trigger: 'scheduled' })
      if (runs.length >= limit) break
    } catch {
      // skip unparseable timestamps
    }
  }

  return runs
}

// ── Stream helpers ────────────────────────────────────────────────────────────

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ''
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}
