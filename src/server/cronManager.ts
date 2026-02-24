// cronManager.ts — Cron & Systemd Timer Manager backend service
// WU-003: Discovery & Parsing | WU-004: Polling, Diff & Health | WU-005: Operations & Credential Cache
//
// Discovers cron jobs and systemd timers from 4 sources:
//   1. User crontab (crontab -l)
//   2. System crontab (/etc/crontab, /etc/cron.d/*)
//   3. User systemd timers (systemctl --user list-timers)
//   4. System systemd timers (systemctl list-timers)
//
// Provides polling with incremental diff, health computation,
// and all mutating operations (run/pause/resume/edit/delete/create).

import { createHash } from 'crypto'
import { readdir, readFile, writeFile, mkdir } from 'fs/promises'
import { join, dirname, basename } from 'path'
import { homedir } from 'os'
import cronstrue from 'cronstrue'
import { CronExpressionParser } from 'cron-parser'
import type {
  CronJob,
  CronJobSource,
  JobRunRecord,
  CronCreateConfig,
  SystemdCreateConfig,
  BulkProgress,
} from '../shared/types'
import type { SessionDatabase, CronPrefsStore } from './db'
import { logger } from './logger'

// ── Types ────────────────────────────────────────────────────────────────────

export type HealthStatus = 'healthy' | 'warning' | 'critical' | 'unknown'

export interface HealthResult {
  health: HealthStatus
  reason: string | null
}

export interface JobDiff {
  added: CronJob[]
  removed: string[]
  updated: CronJob[]
}

export type JobsChangedCallback = (diff: JobDiff) => void

// ── CronManager ──────────────────────────────────────────────────────────────

export class CronManager {
  private db: SessionDatabase
  private cronPrefs: CronPrefsStore
  private systemdAvailable = false
  private jobs: Map<string, CronJob> = new Map()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private changeCallbacks: JobsChangedCallback[] = []
  private sudoCredential: Uint8Array | null = null
  private sudoClearTimer: ReturnType<typeof setTimeout> | null = null
  private runningManualRuns: Set<string> = new Set()

  constructor(db: SessionDatabase, cronPrefs: CronPrefsStore) {
    this.db = db
    this.cronPrefs = cronPrefs
    this.systemdAvailable = this.detectSystemd()
  }

  // ── WU-003: Discovery & Parsing ──────────────────────────────────────────

  /** Detect whether systemd is available on this system (REQ-97) */
  private detectSystemd(): boolean {
    try {
      const result = Bun.spawnSync(['systemctl', '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      return result.exitCode === 0
    } catch {
      return false
    }
  }

  /** Discover jobs from all available sources (REQ-04, REQ-91: 2s timeout per source) */
  async discoverAllJobs(): Promise<CronJob[]> {
    const TIMEOUT_MS = 2000

    /** Wrap a source fn with a 2-second AbortController timeout */
    const withTimeout = (fn: () => Promise<CronJob[]>): Promise<CronJob[]> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      return fn().finally(() => clearTimeout(timer))
    }

    const sources: Array<() => Promise<CronJob[]>> = [
      () => this.discoverUserCrontab(),
      () => this.discoverSystemCrontab(),
      () => this.discoverUserTimers(),
      () => this.discoverSystemTimers(),
    ]

    const results = await Promise.allSettled(sources.map(fn => withTimeout(fn)))
    const jobs: CronJob[] = []

    for (const result of results) {
      if (result.status === 'fulfilled') {
        jobs.push(...result.value)
      } else {
        logger.warn('CronManager: source discovery failed', { err: result.reason })
      }
    }

    return jobs
  }

  /** Discover user crontab entries (source 1) */
  async discoverUserCrontab(): Promise<CronJob[]> {
    const proc = Bun.spawn(['crontab', '-l'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    // exit code 1 with "no crontab for user" is normal — not an error
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      if (stderr.includes('no crontab for')) return []
      throw new Error(`crontab -l failed (exit ${exitCode}): ${stderr.trim()}`)
    }

    const output = await new Response(proc.stdout).text()
    const source: CronJobSource = 'user-crontab'
    const jobs: CronJob[] = []

    for (const rawLine of output.split('\n')) {
      const line = rawLine.trim()
      // skip comments and empty lines
      if (!line || line.startsWith('#')) continue
      // skip environment variable assignments (KEY=value)
      if (/^[A-Z_]+=/.test(line)) continue

      const parsed = this.parseCrontabLine(line, source, false)
      if (parsed) jobs.push(parsed)
    }

    return jobs
  }

  /** Discover system crontab entries (source 2, requiresSudo: true) (REQ-81) */
  async discoverSystemCrontab(): Promise<CronJob[]> {
    const jobs: CronJob[] = []
    const source: CronJobSource = 'system-crontab'

    // Parse /etc/crontab
    try {
      const content = await readFile('/etc/crontab', 'utf8')
      for (const rawLine of content.split('\n')) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        if (/^[A-Z_]+=/.test(line)) continue
        const parsed = this.parseCrontabLine(line, source, true)
        if (parsed) jobs.push(parsed)
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('CronManager: failed to read /etc/crontab', { err })
      }
    }

    // Parse /etc/cron.d/*
    try {
      const entries = await readdir('/etc/cron.d')
      for (const entry of entries) {
        // skip editor backup files and package manager temp files
        if (entry.endsWith('~') || entry.startsWith('.')) continue
        const filePath = join('/etc/cron.d', entry)
        try {
          const content = await readFile(filePath, 'utf8')
          for (const rawLine of content.split('\n')) {
            const line = rawLine.trim()
            if (!line || line.startsWith('#')) continue
            if (/^[A-Z_]+=/.test(line)) continue
            const parsed = this.parseCrontabLine(line, source, true)
            if (parsed) jobs.push(parsed)
          }
        } catch (err) {
          logger.warn('CronManager: failed to read cron.d file', { err, filePath })
        }
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('CronManager: failed to read /etc/cron.d', { err })
      }
    }

    return jobs
  }

  /** Discover user systemd timers (source 3) */
  async discoverUserTimers(): Promise<CronJob[]> {
    if (!this.systemdAvailable) return []
    return this.discoverSystemdTimers('systemd-user', false)
  }

  /** Discover system systemd timers (source 4, requiresSudo: true) (REQ-81) */
  async discoverSystemTimers(): Promise<CronJob[]> {
    if (!this.systemdAvailable) return []
    return this.discoverSystemdTimers('systemd-system', true)
  }

  /** Shared systemd timer discovery logic for user and system scopes */
  private async discoverSystemdTimers(
    source: CronJobSource,
    isSystem: boolean,
  ): Promise<CronJob[]> {
    const scopeFlag = isSystem ? [] : ['--user']
    const listArgs = ['systemctl', ...scopeFlag, 'list-timers', '--all', '--output=json', '--no-pager']

    const listProc = Bun.spawn(listArgs, { stdout: 'pipe', stderr: 'pipe' })
    const listExit = await listProc.exited
    if (listExit !== 0) {
      const stderr = await new Response(listProc.stderr).text()
      throw new Error(`systemctl list-timers failed (exit ${listExit}): ${stderr.trim()}`)
    }

    const raw = await new Response(listProc.stdout).text()
    let timerList: Array<Record<string, unknown>>
    try {
      timerList = JSON.parse(raw)
    } catch {
      // empty or non-JSON output means no timers
      return []
    }

    const jobs: CronJob[] = []

    for (const entry of timerList) {
      const unitName = String(entry.unit ?? entry.timer ?? '')
      if (!unitName) continue

      // Fetch unit properties
      const showArgs = ['systemctl', ...scopeFlag, 'show', unitName, '--no-pager']
      let props: Record<string, string> = {}
      try {
        const showProc = Bun.spawn(showArgs, { stdout: 'pipe', stderr: 'pipe' })
        await showProc.exited
        const showOut = await new Response(showProc.stdout).text()
        for (const line of showOut.split('\n')) {
          const eq = line.indexOf('=')
          if (eq > 0) {
            props[line.slice(0, eq)] = line.slice(eq + 1)
          }
        }
      } catch {
        // proceed with partial props
      }

      const onCalendar = props['OnCalendarSpec'] ?? props['OnCalendar'] ?? ''
      const execStart = props['ExecStart'] ?? ''
      const description = props['Description'] ?? ''
      const unitFile = props['FragmentPath'] ?? undefined
      const activeState = props['ActiveState'] ?? 'active'
      const lastTrigger = entry.last ?? props['LastTriggerUSec'] ?? undefined

      // Derive command: ExecStart may look like "{ path=/usr/bin/foo ; argv[]=foo bar ; ... }"
      const command = this.parseSystemdExecStart(execStart) || unitName

      const schedule = onCalendar
      const scheduleHuman = onCalendar ? this.parseSystemdCalendar(onCalendar) : unitName
      const scriptPath = this.resolveScriptPath(command)
      const projectGroup = this.inferProjectGroup(scriptPath)
      const id = CronManager.generateJobId(source, unitName, command)
      const status = activeState === 'active' ? 'active' : 'paused'

      const nextRunRaw = entry.next ?? props['NextElapseUSecRealtime'] ?? undefined
      const nextRun = nextRunRaw ? this.parseSystemdTimestamp(String(nextRunRaw)) : undefined
      const lastRun = lastTrigger ? this.parseSystemdTimestamp(String(lastTrigger)) : undefined

      jobs.push({
        id,
        name: unitName,
        source,
        schedule,
        scheduleHuman,
        command,
        scriptPath: scriptPath ?? undefined,
        projectGroup,
        status,
        health: 'unknown',
        lastRun,
        nextRun,
        consecutiveFailures: 0,
        requiresSudo: isSystem,
        unitFile,
        description: description || undefined,
        tags: [],
        isManagedByAgentboard: false,
      })
    }

    return jobs
  }

  /** Extract command string from systemd ExecStart property value */
  private parseSystemdExecStart(execStart: string): string {
    // systemd show format: "{ path=/usr/bin/foo ; argv[]=foo bar baz ; ... }"
    const pathMatch = execStart.match(/path=([^;}\s]+)/)
    const argvMatch = execStart.match(/argv\[\]=([^;}\n]+)/)
    if (argvMatch) return argvMatch[1].trim()
    if (pathMatch) return pathMatch[1].trim()
    // Plain format
    return execStart.trim()
  }

  /** Parse systemd timestamp string to ISO string, returns undefined if unparseable */
  private parseSystemdTimestamp(raw: string): string | undefined {
    if (!raw || raw === 'n/a' || raw === '0') return undefined
    // systemd outputs human timestamps like "Mon 2024-01-15 03:00:00 UTC"
    // Try direct Date parse first
    const d = new Date(raw)
    if (!isNaN(d.getTime())) return d.toISOString()
    // Try stripping weekday prefix
    const stripped = raw.replace(/^\w+\s+/, '')
    const d2 = new Date(stripped)
    if (!isNaN(d2.getTime())) return d2.toISOString()
    return undefined
  }

  /**
   * Generate deterministic job ID from source+name+command (NOT schedule) (REQ-05)
   * ID is a hex hash string.
   */
  static generateJobId(source: string, name: string, command: string): string {
    return createHash('sha256')
      .update(`${source}:${name}:${command}`)
      .digest('hex')
      .slice(0, 12)
  }

  /** Parse cron expression to human-readable via cronstrue (REQ-85) */
  parseCronSchedule(expression: string): string {
    try {
      return cronstrue.toString(expression, { throwExceptionOnParseError: true })
    } catch {
      return expression
    }
  }

  /** Parse systemd calendar spec to human-readable (REQ-86) */
  parseSystemdCalendar(calendarSpec: string): string {
    const spec = calendarSpec.trim().toLowerCase()

    // Named shortcuts
    const shortcuts: Record<string, string> = {
      daily: 'Every day at midnight',
      weekly: 'Every week on Monday at midnight',
      monthly: 'Every month on the 1st at midnight',
      hourly: 'Every hour',
      minutely: 'Every minute',
      quarterly: 'Every quarter (Jan, Apr, Jul, Oct) at midnight',
      'semi-annually': 'Every 6 months at midnight',
      yearly: 'Every year on January 1st at midnight',
      annually: 'Every year on January 1st at midnight',
    }
    if (shortcuts[spec]) return shortcuts[spec]

    // *:0/N — every N minutes
    const everyNMinutes = spec.match(/^\*:0\/(\d+)$/)
    if (everyNMinutes) return `Every ${everyNMinutes[1]} minutes`

    // *:00/N or *:0/N with full form
    const minuteInterval = spec.match(/^\*-\*-\*\s+\*:0\/(\d+)(?::00)?$/)
    if (minuteInterval) return `Every ${minuteInterval[1]} minutes`

    // *-*-* HH:MM:SS — daily at specific time
    const dailyTime = spec.match(/^\*-\*-\*\s+(\d{1,2}):(\d{2})(?::\d{2})?$/)
    if (dailyTime) {
      const h = parseInt(dailyTime[1], 10)
      const m = parseInt(dailyTime[2], 10)
      const ampm = h < 12 ? 'AM' : 'PM'
      const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h
      const minStr = m === 0 ? '' : `:${String(m).padStart(2, '0')}`
      return `Every day at ${hour12}${minStr} ${ampm}`
    }

    // Mon..Fri *:MM — weekdays at specific minute
    const weekdayMinute = spec.match(/^mon\.\.fri\s+\*:(\d{2})$/)
    if (weekdayMinute) return `Every weekday at minute :${weekdayMinute[1]}`

    // OnCalendar=Sat *-*-* — weekly on specific day
    const weeklyDay = spec.match(/^(mon|tue|wed|thu|fri|sat|sun)\s+\*-\*-\*\s+(\d{1,2}):(\d{2})/)
    if (weeklyDay) {
      const days: Record<string, string> = {
        mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
        fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
      }
      const h = parseInt(weeklyDay[2], 10)
      const m = parseInt(weeklyDay[3], 10)
      const ampm = h < 12 ? 'AM' : 'PM'
      const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h
      const minStr = m === 0 ? '' : `:${String(m).padStart(2, '0')}`
      return `Every ${days[weeklyDay[1]]} at ${hour12}${minStr} ${ampm}`
    }

    // *-*-1 HH:MM — monthly on the 1st
    const monthlyFirst = spec.match(/^\*-\*-(\d{1,2})\s+(\d{1,2}):(\d{2})/)
    if (monthlyFirst) {
      const day = parseInt(monthlyFirst[1], 10)
      const h = parseInt(monthlyFirst[2], 10)
      const m = parseInt(monthlyFirst[3], 10)
      const ampm = h < 12 ? 'AM' : 'PM'
      const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h
      const minStr = m === 0 ? '' : `:${String(m).padStart(2, '0')}`
      const suffix = day === 1 ? 'st' : day === 2 ? 'nd' : day === 3 ? 'rd' : 'th'
      return `Every month on the ${day}${suffix} at ${hour12}${minStr} ${ampm}`
    }

    // Unrecognised — return raw spec
    return calendarSpec
  }

  /** Resolve script path from cron command or systemd ExecStart (REQ-06) */
  resolveScriptPath(command: string): string | null {
    if (!command) return null

    // Skip pipelines and shell inline commands — no single script path
    if (command.includes('|') || command.includes(';')) return null

    // Interpreters that are followed by a file path argument
    const interpreterMatch = command.match(
      /^(?:bash|sh|zsh|fish|python3?|python|ruby|perl|node|bun|php|env\s+\S+)\s+([^\s]+)/
    )
    if (interpreterMatch) {
      const candidate = interpreterMatch[1]
      if (candidate.startsWith('/') || candidate.startsWith('./') || candidate.startsWith('~/')) {
        return candidate
      }
    }

    // Absolute path as the first token
    const tokens = command.split(/\s+/)
    const first = tokens[0]
    if (first && first.startsWith('/')) return first

    return null
  }

  /** Infer project group from script path directory (REQ-07) */
  inferProjectGroup(scriptPath: string | null, _command?: string): string {
    if (!scriptPath) return 'System'
    const dir = dirname(scriptPath)
    if (!dir || dir === '.' || dir === '/') return 'System'
    // Use the last meaningful directory segment
    return basename(dir) || 'System'
  }

  /** Generate a DiceBear avatar URL for a job (stable per job name + style) */
  generateAvatarUrl(jobName: string, style = 'identicon'): string {
    const seed = encodeURIComponent(jobName)
    return `https://api.dicebear.com/7.x/${style}/svg?seed=${seed}`
  }

  /** Project next N run times for a job schedule */
  projectNextRuns(schedule: string, source: string, count = 5): Date[] {
    const isCron = source === 'user-crontab' || source === 'system-crontab'
    if (isCron && schedule) {
      try {
        const interval = CronExpressionParser.parse(schedule)
        const dates: Date[] = []
        for (let i = 0; i < count; i++) {
          dates.push(interval.next().toDate())
        }
        return dates
      } catch {
        return []
      }
    }

    // Systemd: basic projection for common named specs
    const spec = schedule.trim().toLowerCase()
    const now = new Date()
    const dates: Date[] = []

    let intervalMs: number | null = null
    if (spec === 'hourly') intervalMs = 60 * 60 * 1000
    else if (spec === 'daily') intervalMs = 24 * 60 * 60 * 1000
    else if (spec === 'weekly') intervalMs = 7 * 24 * 60 * 60 * 1000
    else if (spec === 'monthly') intervalMs = 30 * 24 * 60 * 60 * 1000

    if (intervalMs) {
      for (let i = 1; i <= count; i++) {
        dates.push(new Date(now.getTime() + i * intervalMs))
      }
    }

    return dates
  }

  // ── Private parsing helpers ───────────────────────────────────────────────

  /**
   * Parse a single crontab line into a CronJob.
   * For system crontab (hasUserField=true), the 6th field is the username
   * and the command starts at field 7.
   */
  private parseCrontabLine(
    line: string,
    source: CronJobSource,
    hasUserField: boolean,
  ): CronJob | null {
    const parts = line.split(/\s+/)
    // Need at least 5 schedule fields + command (+ user field for system crontab)
    const minFields = hasUserField ? 7 : 6
    if (parts.length < minFields) return null

    const schedule = parts.slice(0, 5).join(' ')
    const user = hasUserField ? parts[5] : undefined
    const command = parts.slice(hasUserField ? 6 : 5).join(' ')

    if (!command) return null

    const scriptPath = this.resolveScriptPath(command)
    const projectGroup = this.inferProjectGroup(scriptPath)
    const name = scriptPath ? basename(scriptPath) : command.slice(0, 40)
    const id = CronManager.generateJobId(source, name, command)
    const scheduleHuman = this.parseCronSchedule(schedule)
    const nextRuns = this.projectNextRuns(schedule, source, 3)

    const job: CronJob = {
      id,
      name,
      source,
      schedule,
      scheduleHuman,
      command,
      scriptPath: scriptPath ?? undefined,
      projectGroup,
      status: 'active',
      health: 'unknown',
      nextRun: nextRuns[0]?.toISOString(),
      nextRuns: nextRuns.map(d => d.toISOString()),
      consecutiveFailures: 0,
      requiresSudo: source === 'system-crontab',
      user,
      tags: [],
      isManagedByAgentboard: false,
    }

    return job
  }

  get isSystemdAvailable(): boolean {
    return this.systemdAvailable
  }

  // ── WU-004: Polling, Diff & Health ───────────────────────────────────────

  /** Start polling at configurable interval (REQ-08: default 5s, min 2s, max 30s) */
  startPolling(intervalMs: number): void {
    // Clamp interval to [2000, 30000]
    const clampedMs = Math.max(2000, Math.min(30000, intervalMs))

    // If already polling, stop first
    if (this.pollTimer) {
      this.stopPolling()
    }

    const tick = async () => {
      try {
        const newJobs = await this.discoverAllJobs()

        // Enrich each job with health derived from DB run history
        for (const job of newJobs) {
          const dbRecords = this.cronPrefs.getRunHistory(job.id, 10)
          const history: JobRunRecord[] = dbRecords.map(r => ({
            timestamp: r.timestamp,
            endTimestamp: r.endTimestamp ?? undefined,
            duration: r.duration ?? undefined,
            exitCode: r.exitCode ?? undefined,
            trigger: (r.trigger === 'manual' ? 'manual' : 'scheduled') as 'manual' | 'scheduled',
            logSnippet: r.logSnippet ?? undefined,
          }))
          const { health, reason } = this.computeHealth(job, history)
          job.health = health
          if (reason) job.healthReason = reason
        }

        const diff = this.computeDiff(newJobs)

        // Only notify if something actually changed
        if (diff.added.length > 0 || diff.removed.length > 0 || diff.updated.length > 0) {
          for (const cb of this.changeCallbacks) {
            try {
              cb(diff)
            } catch (err) {
              logger.warn('CronManager: change callback threw', { err })
            }
          }
        }
      } catch (err) {
        logger.warn('CronManager: poll tick failed', { err })
      }
    }

    // Fire immediately, then on interval
    void tick()
    this.pollTimer = setInterval(tick, clampedMs)
  }

  /** Stop the polling loop */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /** Register callback for job changes (REQ-09: only diffs after initial) */
  onJobsChanged(callback: JobsChangedCallback): void {
    this.changeCallbacks.push(callback)
  }

  /** Compute health status from run history (REQ-58: 4 levels) */
  computeHealth(job: CronJob, history: JobRunRecord[]): HealthResult {
    // No history — unknown
    if (history.length === 0) {
      return { health: 'unknown', reason: null }
    }

    // critical: 2+ consecutive failures (check from most-recent first)
    let consecutiveFails = 0
    for (const run of history) {
      if (run.exitCode !== undefined && run.exitCode !== 0) {
        consecutiveFails++
      } else {
        break
      }
    }
    if (consecutiveFails >= 2) {
      return {
        health: 'critical',
        reason: `${consecutiveFails} consecutive failure${consecutiveFails > 2 ? 's' : ''}`,
      }
    }

    // warning: last run failed
    const lastRun = history[0]
    if (lastRun.exitCode !== undefined && lastRun.exitCode !== 0) {
      return {
        health: 'warning',
        reason: `Last run failed with exit code ${lastRun.exitCode}`,
      }
    }

    // warning: last run duration > 2x rolling average of last 10
    const last10 = history.slice(0, 10)
    const durations = last10
      .map(r => r.duration)
      .filter((d): d is number => d !== undefined && d > 0)
    if (durations.length >= 2 && lastRun.duration !== undefined && lastRun.duration > 0) {
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length
      if (lastRun.duration > avg * 2) {
        return {
          health: 'warning',
          reason: `Last run duration (${Math.round(lastRun.duration / 1000)}s) exceeded 2× average (${Math.round(avg / 1000)}s)`,
        }
      }
    }

    // warning: possible missed run — last run predates the previous scheduled tick
    if (job.schedule && job.lastRun) {
      const isCron = job.source === 'user-crontab' || job.source === 'system-crontab'
      if (isCron) {
        try {
          const interval = CronExpressionParser.parse(job.schedule)
          const prev = interval.prev().toDate()
          const lastRunMs = new Date(job.lastRun).getTime()
          if (lastRunMs < prev.getTime()) {
            return { health: 'warning', reason: 'Possible missed run detected' }
          }
        } catch {
          // ignore parse errors — leave health as healthy
        }
      }
    }

    // healthy: all last 10 runs exited 0 (or have no exit code recorded)
    return { health: 'healthy', reason: null }
  }

  /** Clean up orphaned prefs with last_seen > 24h (REQ-98) */
  cleanupOrphanedPrefs(): void {
    // Refresh last_seen for all currently-known jobs so they are not pruned
    const currentIds = Array.from(this.jobs.keys())
    if (currentIds.length > 0) {
      this.cronPrefs.updateLastSeen(currentIds)
    }
    // Delete prefs rows whose last_seen is older than 24 hours and are no
    // longer in the current discovered set (the DB method prunes by age).
    this.cronPrefs.deleteOrphanedPrefs(24)
  }

  /** Get current snapshot of all discovered jobs */
  getAllJobs(): CronJob[] {
    return Array.from(this.jobs.values())
  }

  /**
   * Compare newJobs against this.jobs, update the map, and return the diff.
   * Fields checked for updates: schedule, status, command.
   */
  private computeDiff(newJobs: CronJob[]): JobDiff {
    const newMap = new Map<string, CronJob>(newJobs.map(j => [j.id, j]))

    const added: CronJob[] = []
    const removed: string[] = []
    const updated: CronJob[] = []

    for (const [id, newJob] of newMap) {
      const existing = this.jobs.get(id)
      if (!existing) {
        added.push(newJob)
      } else if (
        existing.schedule !== newJob.schedule ||
        existing.status !== newJob.status ||
        existing.command !== newJob.command
      ) {
        updated.push(newJob)
      }
    }

    for (const id of this.jobs.keys()) {
      if (!newMap.has(id)) {
        removed.push(id)
      }
    }

    // Replace internal map atomically
    this.jobs = newMap

    return { added, removed, updated }
  }

  // ── WU-005: Operations & Credential Cache ────────────────────────────────

  /** Run a job immediately (REQ-37); yields streaming output lines */
  async *runJobNow(jobId: string, sudoCredential?: Uint8Array): AsyncGenerator<string> {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)

    if (this.runningManualRuns.has(jobId)) {
      throw new Error(`Job ${jobId} is already running manually`)
    }
    this.runningManualRuns.add(jobId)

    const startMs = Date.now()
    const credential = sudoCredential ?? this.sudoCredential ?? null
    const collectedLines: string[] = []

    try {
      const isSystemd = job.source === 'systemd-user' || job.source === 'systemd-system'
      const isSystem = job.source === 'systemd-system' || job.source === 'system-crontab'
      const needsSudo = isSystem && !!credential

      let args: string[]
      let stdinPayload: Uint8Array | null = null

      if (needsSudo) {
        const credStr = new TextDecoder().decode(credential!)
        stdinPayload = new TextEncoder().encode(credStr + '\n')
      }

      if (isSystemd) {
        const scopeFlag = job.source === 'systemd-user' ? ['--user'] : []
        args = needsSudo
          ? ['sudo', '-S', 'systemctl', ...scopeFlag, 'start', job.name]
          : ['systemctl', ...scopeFlag, 'start', job.name]
      } else {
        args = needsSudo
          ? ['sudo', '-S', 'sh', '-c', job.command]
          : ['sh', '-c', job.command]
      }

      const proc = Bun.spawn(args, {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: stdinPayload ? 'pipe' : undefined,
      })

      if (stdinPayload && proc.stdin) {
        proc.stdin.write(stdinPayload)
        proc.stdin.end()
      }

      // Drain stdout and stderr concurrently into line buffers
      const decoder = new TextDecoder()

      const drainLines = async (
        stream: ReadableStream<Uint8Array>,
        prefix: string,
      ): Promise<void> => {
        const reader = stream.getReader()
        let buf = ''
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            const lines = buf.split('\n')
            buf = lines.pop() ?? ''
            for (const l of lines) collectedLines.push(prefix + l)
          }
          if (buf) collectedLines.push(prefix + buf)
        } finally {
          reader.releaseLock()
        }
      }

      await Promise.all([
        drainLines(proc.stdout, ''),
        drainLines(proc.stderr, '[stderr] '),
      ])

      for (const line of collectedLines) yield line

      const exitCode = await proc.exited
      const duration = Date.now() - startMs
      yield `[exit: ${exitCode}]`

      // Record manual run in DB (REQ-39)
      try {
        this.cronPrefs.insertRunHistory({
          jobId,
          timestamp: new Date(startMs).toISOString(),
          endTimestamp: new Date().toISOString(),
          duration,
          exitCode,
          trigger: 'manual',
          logSnippet: collectedLines.slice(-20).join('\n').slice(-500) || null,
        })
      } catch (err) {
        logger.warn('CronManager: failed to record manual run history', { err, jobId })
      }
    } finally {
      this.runningManualRuns.delete(jobId)
    }
  }

  /** Pause a job (REQ-41: cron=#AGENTBOARD_PAUSED: prefix; systemd=stop+disable) */
  async pauseJob(jobId: string, sudoCredential?: Uint8Array): Promise<void> {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)
    const credential = sudoCredential ?? this.sudoCredential ?? null
    const isSystemd = job.source === 'systemd-user' || job.source === 'systemd-system'

    if (isSystemd) {
      const isUser = job.source === 'systemd-user'
      await this.runSystemctl(isUser, job.requiresSudo, credential, 'stop', job.name)
      await this.runSystemctl(isUser, job.requiresSudo, credential, 'disable', job.name)
    } else {
      const crontab = await this.readUserCrontab()
      const updated = crontab.split('\n').map(line => {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) return line
        if (trimmed.includes(job.command)) return `#AGENTBOARD_PAUSED:${line}`
        return line
      }).join('\n')
      await this.writeUserCrontab(updated)
    }

    this.jobs.set(jobId, { ...job, status: 'paused' })
  }

  /** Resume a paused job (REQ-41: inverse of pause) */
  async resumeJob(jobId: string, sudoCredential?: Uint8Array): Promise<void> {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)
    const credential = sudoCredential ?? this.sudoCredential ?? null
    const isSystemd = job.source === 'systemd-user' || job.source === 'systemd-system'

    if (isSystemd) {
      const isUser = job.source === 'systemd-user'
      await this.runSystemctl(isUser, job.requiresSudo, credential, 'enable', job.name)
      await this.runSystemctl(isUser, job.requiresSudo, credential, 'start', job.name)
    } else {
      const crontab = await this.readUserCrontab()
      const PAUSE_PREFIX = '#AGENTBOARD_PAUSED:'
      const updated = crontab.split('\n').map(line => {
        if (line.startsWith(PAUSE_PREFIX)) {
          const unprefixed = line.slice(PAUSE_PREFIX.length)
          if (unprefixed.includes(job.command)) return unprefixed
        }
        return line
      }).join('\n')
      await this.writeUserCrontab(updated)
    }

    this.jobs.set(jobId, { ...job, status: 'active' })
  }

  /** Edit job frequency (REQ-45: cron=replace schedule; systemd=OnCalendar+reload) */
  async editFrequency(jobId: string, newSchedule: string, sudoCredential?: Uint8Array): Promise<void> {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)
    const credential = sudoCredential ?? this.sudoCredential ?? null
    const isSystemd = job.source === 'systemd-user' || job.source === 'systemd-system'

    await this.backupCrontab()

    if (isSystemd) {
      if (!job.unitFile) throw new Error(`No unit file path for job ${jobId}`)
      const unitContent = await readFile(job.unitFile, 'utf8')
      const updated = unitContent.replace(/^OnCalendar=.+$/m, `OnCalendar=${newSchedule}`)
      await this.writeFileWithSudo(job.unitFile, updated, job.requiresSudo, credential)
      const isUser = job.source === 'systemd-user'
      await this.runSystemctl(isUser, job.requiresSudo, credential, 'daemon-reload')
    } else {
      const crontab = await this.readUserCrontab()
      const newScheduleParts = newSchedule.split(/\s+/)
      if (newScheduleParts.length !== 5) throw new Error(`Invalid cron schedule: ${newSchedule}`)
      const updated = crontab.split('\n').map(line => {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) return line
        if (trimmed.includes(job.command)) {
          const parts = trimmed.split(/\s+/)
          // Replace the 5 schedule fields, keep the rest (command, comment)
          return [...newScheduleParts, ...parts.slice(5)].join(' ')
        }
        return line
      }).join('\n')
      await this.writeUserCrontab(updated)
    }

    this.jobs.set(jobId, {
      ...job,
      schedule: newSchedule,
      scheduleHuman: this.parseCronSchedule(newSchedule),
    })
  }

  /** Delete a job (REQ-47: cron=remove line; systemd=stop+disable+remove) */
  async deleteJob(jobId: string, sudoCredential?: Uint8Array): Promise<void> {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)
    const credential = sudoCredential ?? this.sudoCredential ?? null
    const isSystemd = job.source === 'systemd-user' || job.source === 'systemd-system'

    await this.backupCrontab()

    if (isSystemd) {
      const isUser = job.source === 'systemd-user'
      await this.runSystemctl(isUser, job.requiresSudo, credential, 'stop', job.name)
      await this.runSystemctl(isUser, job.requiresSudo, credential, 'disable', job.name)
      if (job.unitFile) {
        const timerFile = job.unitFile
        const serviceFile = timerFile.replace(/\.timer$/, '.service')
        await this.removeFileWithSudo(timerFile, job.requiresSudo, credential)
        await this.removeFileWithSudo(serviceFile, job.requiresSudo, credential)
      }
      await this.runSystemctl(isUser, job.requiresSudo, credential, 'daemon-reload')
    } else {
      const PAUSE_PREFIX = '#AGENTBOARD_PAUSED:'
      const crontab = await this.readUserCrontab()
      const updated = crontab.split('\n').filter(line => {
        const trimmed = line.trim()
        if (trimmed.startsWith(PAUSE_PREFIX)) {
          return !trimmed.slice(PAUSE_PREFIX.length).includes(job.command)
        }
        return !trimmed.includes(job.command)
      }).join('\n')
      await this.writeUserCrontab(updated)
    }

    this.jobs.delete(jobId)
  }

  /** Create a new cron job via user crontab (REQ-51: Quick mode) */
  async createCronJob(config: CronCreateConfig): Promise<CronJob> {
    if (!CronManager.validateCommand(config.command)) {
      throw new Error('Invalid command: contains newlines or null bytes')
    }

    const comment = config.comment ? ` # ${config.comment}` : ''
    const newLine = `${config.schedule} ${config.command}${comment}`

    let existing = ''
    try { existing = await this.readUserCrontab() } catch { /* empty crontab */ }

    const separator = existing && !existing.endsWith('\n') ? '\n' : ''
    await this.writeUserCrontab(`${existing}${separator}${newLine}\n`)

    const scriptPath = this.resolveScriptPath(config.command)
    const projectGroup = this.inferProjectGroup(scriptPath)
    const name = scriptPath ? basename(scriptPath) : config.command.slice(0, 40)
    const id = CronManager.generateJobId('user-crontab', name, config.command)
    const scheduleHuman = this.parseCronSchedule(config.schedule)
    const nextRuns = this.projectNextRuns(config.schedule, 'user-crontab', 3)

    const newJob: CronJob = {
      id,
      name,
      source: 'user-crontab',
      schedule: config.schedule,
      scheduleHuman,
      command: config.command,
      scriptPath: scriptPath ?? undefined,
      projectGroup,
      status: 'active',
      health: 'unknown',
      nextRun: nextRuns[0]?.toISOString(),
      nextRuns: nextRuns.map(d => d.toISOString()),
      consecutiveFailures: 0,
      requiresSudo: false,
      tags: config.tags ?? [],
      isManagedByAgentboard: true,
    }

    this.jobs.set(id, newJob)
    return newJob
  }

  /** Create a new systemd timer+service (REQ-52: Advanced mode) */
  async createSystemdTimer(config: SystemdCreateConfig): Promise<CronJob> {
    if (!CronManager.validateSystemdName(config.serviceName)) {
      throw new Error(`Invalid systemd unit name: ${config.serviceName}`)
    }
    if (!CronManager.validateCommand(config.command)) {
      throw new Error('Invalid command: contains newlines or null bytes')
    }

    const isUser = config.scope === 'user'
    const unitDir = isUser
      ? join(homedir(), '.config', 'systemd', 'user')
      : '/etc/systemd/system'

    const timerUnitName = `${config.serviceName}.timer`
    const serviceUnitName = `${config.serviceName}.service`
    const timerFile = join(unitDir, timerUnitName)
    const serviceFile = join(unitDir, serviceUnitName)
    const description = config.description ?? config.serviceName

    const timerContent = [
      '[Unit]',
      `Description=${description} timer`,
      '',
      '[Timer]',
      `OnCalendar=${config.schedule}`,
      'Persistent=true',
      '',
      '[Install]',
      'WantedBy=timers.target',
      '',
    ].join('\n')

    const serviceLines = [
      '[Unit]',
      `Description=${description}`,
      '',
      '[Service]',
      `ExecStart=${config.command}`,
      config.workingDirectory ? `WorkingDirectory=${config.workingDirectory}` : null,
      'Type=oneshot',
      '',
    ]
    const serviceContent = serviceLines.filter((l): l is string => l !== null).join('\n')

    // Ensure unit directory exists
    await mkdir(unitDir, { recursive: true })

    await this.writeFileWithSudo(timerFile, timerContent, !isUser, null)
    await this.writeFileWithSudo(serviceFile, serviceContent, !isUser, null)

    await this.runSystemctl(isUser, !isUser, null, 'daemon-reload')
    await this.runSystemctl(isUser, !isUser, null, 'enable', timerUnitName)
    await this.runSystemctl(isUser, !isUser, null, 'start', timerUnitName)

    const source: CronJobSource = isUser ? 'systemd-user' : 'systemd-system'
    const id = CronManager.generateJobId(source, timerUnitName, config.command)
    const scheduleHuman = this.parseSystemdCalendar(config.schedule)

    const newJob: CronJob = {
      id,
      name: timerUnitName,
      source,
      schedule: config.schedule,
      scheduleHuman,
      command: config.command,
      projectGroup: config.workingDirectory ? basename(config.workingDirectory) : 'System',
      status: 'active',
      health: 'unknown',
      consecutiveFailures: 0,
      requiresSudo: !isUser,
      unitFile: timerFile,
      description,
      tags: config.tags ?? [],
      isManagedByAgentboard: true,
    }

    this.jobs.set(id, newJob)
    return newJob
  }

  /** Bulk pause jobs (REQ-55: sequential, single sudo prompt) */
  async *bulkPause(jobIds: string[], sudoCredential?: Uint8Array): AsyncGenerator<BulkProgress> {
    const failures: BulkProgress['failures'] = []
    for (let i = 0; i < jobIds.length; i++) {
      const jobId = jobIds[i]
      const job = this.jobs.get(jobId)
      try {
        await this.pauseJob(jobId, sudoCredential)
      } catch (err) {
        failures.push({
          jobId,
          jobName: job?.name ?? jobId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      yield { completed: i + 1, total: jobIds.length, failures: [...failures] }
    }
  }

  /** Bulk resume jobs (REQ-55) */
  async *bulkResume(jobIds: string[], sudoCredential?: Uint8Array): AsyncGenerator<BulkProgress> {
    const failures: BulkProgress['failures'] = []
    for (let i = 0; i < jobIds.length; i++) {
      const jobId = jobIds[i]
      const job = this.jobs.get(jobId)
      try {
        await this.resumeJob(jobId, sudoCredential)
      } catch (err) {
        failures.push({
          jobId,
          jobName: job?.name ?? jobId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      yield { completed: i + 1, total: jobIds.length, failures: [...failures] }
    }
  }

  /** Bulk delete jobs (REQ-55) */
  async *bulkDelete(jobIds: string[], sudoCredential?: Uint8Array): AsyncGenerator<BulkProgress> {
    const failures: BulkProgress['failures'] = []
    for (let i = 0; i < jobIds.length; i++) {
      const jobId = jobIds[i]
      const job = this.jobs.get(jobId)
      try {
        await this.deleteJob(jobId, sudoCredential)
      } catch (err) {
        failures.push({
          jobId,
          jobName: job?.name ?? jobId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      yield { completed: i + 1, total: jobIds.length, failures: [...failures] }
    }
  }

  /** Cache sudo credential as Uint8Array (REQ-83: auto-clear after grace period) */
  cacheSudoCredential(credential: Uint8Array, gracePeriodMs: number): void {
    // Clear any existing credential and timer before storing the new one
    this.clearSudoCredential()
    this.sudoCredential = credential
    this.sudoClearTimer = setTimeout(() => this.clearSudoCredential(), gracePeriodMs)
  }

  /** Clear cached sudo credential, zeroing the buffer (REQ-83) */
  clearSudoCredential(): void {
    if (this.sudoCredential) {
      this.sudoCredential.fill(0)
      this.sudoCredential = null
    }
    if (this.sudoClearTimer) {
      clearTimeout(this.sudoClearTimer)
      this.sudoClearTimer = null
    }
  }

  /** Validate command input (REQ-96: reject newlines/null bytes) */
  static validateCommand(command: string): boolean {
    return !command.includes('\n') && !command.includes('\0')
  }

  /** Validate systemd unit name (REQ-96) */
  static validateSystemdName(name: string): boolean {
    return /^[a-zA-Z0-9_.-]+$/.test(name)
  }

  // ── Private subprocess / file helpers ────────────────────────────────────

  /** Read current user crontab; returns empty string when no crontab is installed */
  private async readUserCrontab(): Promise<string> {
    const proc = Bun.spawn(['crontab', '-l'], { stdout: 'pipe', stderr: 'pipe' })
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      if (stderr.includes('no crontab for')) return ''
      throw new Error(`crontab -l failed: ${stderr.trim()}`)
    }
    return new Response(proc.stdout).text()
  }

  /** Write content to the user crontab via `crontab -` */
  private async writeUserCrontab(content: string): Promise<void> {
    const proc = Bun.spawn(['crontab', '-'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    proc.stdin.write(new TextEncoder().encode(content))
    proc.stdin.end()
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`crontab write failed: ${stderr.trim()}`)
    }
  }

  /** Run a systemctl subcommand, piping sudo credential to stdin when required */
  private async runSystemctl(
    isUser: boolean,
    requiresSudo: boolean,
    credential: Uint8Array | null,
    ...args: string[]
  ): Promise<void> {
    const scopeFlag = isUser ? ['--user'] : []
    const needsSudo = requiresSudo && !!credential
    let stdinPayload: Uint8Array | null = null
    let cmd: string[]

    if (needsSudo) {
      const credStr = new TextDecoder().decode(credential!)
      stdinPayload = new TextEncoder().encode(credStr + '\n')
      cmd = ['sudo', '-S', 'systemctl', ...scopeFlag, ...args]
    } else {
      cmd = ['systemctl', ...scopeFlag, ...args]
    }

    const proc = Bun.spawn(cmd, {
      stdin: stdinPayload ? 'pipe' : undefined,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    if (stdinPayload && proc.stdin) {
      proc.stdin.write(stdinPayload)
      proc.stdin.end()
    }

    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`systemctl ${args.join(' ')} failed (exit ${exitCode}): ${stderr.trim()}`)
    }
  }

  /** Create a timestamped backup of the user crontab in ~/.agentboard/backups/ */
  private async backupCrontab(): Promise<void> {
    try {
      const backupDir = join(homedir(), '.agentboard', 'backups')
      await mkdir(backupDir, { recursive: true })
      const crontab = await this.readUserCrontab()
      if (!crontab) return
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      await writeFile(join(backupDir, `crontab-${timestamp}`), crontab, 'utf8')
    } catch (err) {
      logger.warn('CronManager: failed to create crontab backup', { err })
    }
  }

  /** Write a file, using `sudo tee` when root access is required */
  private async writeFileWithSudo(
    filePath: string,
    content: string,
    requiresSudo: boolean,
    credential: Uint8Array | null,
  ): Promise<void> {
    if (requiresSudo && credential) {
      const credStr = new TextDecoder().decode(credential)
      // Pipe: sudo password on first line, then file content
      const proc = Bun.spawn(['sudo', '-S', 'tee', filePath], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      proc.stdin.write(new TextEncoder().encode(credStr + '\n' + content))
      proc.stdin.end()
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text()
        throw new Error(`Failed to write ${filePath}: ${stderr.trim()}`)
      }
    } else {
      await writeFile(filePath, content, 'utf8')
    }
  }

  /** Remove a file, using sudo when required; silently ignores not-found errors */
  private async removeFileWithSudo(
    filePath: string,
    requiresSudo: boolean,
    credential: Uint8Array | null,
  ): Promise<void> {
    const needsSudo = requiresSudo && !!credential
    let stdinPayload: Uint8Array | null = null
    let cmd: string[]

    if (needsSudo) {
      const credStr = new TextDecoder().decode(credential!)
      stdinPayload = new TextEncoder().encode(credStr + '\n')
      cmd = ['sudo', '-S', 'rm', '-f', filePath]
    } else {
      cmd = ['rm', '-f', filePath]
    }

    const proc = Bun.spawn(cmd, {
      stdin: stdinPayload ? 'pipe' : undefined,
      stdout: 'pipe',
      stderr: 'pipe',
    })

    if (stdinPayload && proc.stdin) {
      proc.stdin.write(stdinPayload)
      proc.stdin.end()
    }

    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      if (!stderr.includes('No such file')) {
        throw new Error(`Failed to remove ${filePath}: ${stderr.trim()}`)
      }
    }
  }

  /** Cleanup: stop polling, clear credentials */
  destroy(): void {
    this.stopPolling()
    this.clearSudoCredential()
    this.changeCallbacks = []
    this.jobs.clear()
  }
}
