// WU-003: CronManager - Discovery & Parsing
// WU-004: CronManager - Polling, Diff & Health
// WU-005: CronManager - Operations & Credential Cache

import cronstrue from 'cronstrue'
import { CronExpressionParser } from 'cron-parser'
import type { Database as SQLiteDatabase } from 'bun:sqlite'
import { deleteOrphanedPrefs, pruneRunHistory as pruneDbRunHistory, getRunHistory } from './db'
import type {
  CronJob,
  JobRunRecord,
  CronCreateConfig,
  SystemdCreateConfig,
  BulkProgress,
  JobSource,
  HealthStatus,
} from '../shared/types'

// ─── CronManager Class ───────────────────────────────────────────────────────

export class CronManager {
  // WU-003: Discovery state
  systemdAvailable: boolean = false

  // WU-004: Polling state
  jobCache: Map<string, CronJob> = new Map()
  private pollingInterval: ReturnType<typeof setInterval> | null = null
  private jobsChangedCallbacks: Array<
    (added: CronJob[], removed: string[], updated: CronJob[]) => void
  > = []

  // WU-004/WU-005: DB reference for pruning/cleanup
  private db: SQLiteDatabase | null = null

  // WU-005: Credential cache
  private sudoCredentialCache: Uint8Array | null = null
  private sudoCredentialExpiry: number = 0
  private sudoCredentialTimer: ReturnType<typeof setTimeout> | null = null

  /** Inject the SQLite database reference for history/prefs operations */
  setDb(db: SQLiteDatabase): void {
    this.db = db
  }

  // ─── WU-003: Detection ──────────────────────────────────────────────────

  /** Detect systemd availability via `systemctl --version` */
  async detectSystemd(): Promise<void> {
    try {
      const proc = Bun.spawnSync(['systemctl', '--version'], {
        stdout: 'ignore',
        stderr: 'ignore',
      })
      this.systemdAvailable = proc.exitCode === 0
    } catch {
      this.systemdAvailable = false
    }
  }

  // ─── WU-003: Discovery ──────────────────────────────────────────────────

  /** Orchestrate all 4 sources; catch per-source errors without blocking others */
  async discoverAllJobs(): Promise<CronJob[]> {
    const sources: Promise<CronJob[]>[] = [
      this.discoverUserCrontab(),
      this.discoverSystemCrontab(),
    ]
    if (this.systemdAvailable) {
      sources.push(this.discoverUserTimers())
      sources.push(this.discoverSystemTimers())
    }

    const results = await Promise.allSettled(sources)
    const jobs: CronJob[] = []
    for (const result of results) {
      if (result.status === 'fulfilled') {
        jobs.push(...result.value)
      } else {
        console.debug('[CronManager] discoverAllJobs: source rejected:', result.reason)
      }
    }
    return jobs
  }

  /** Parse `crontab -l` output into CronJob[] */
  async discoverUserCrontab(): Promise<CronJob[]> {
    try {
      const proc = Bun.spawn(['crontab', '-l'], {
        stdout: 'pipe',
        stderr: 'ignore',
      })
      const text = await new Response(proc.stdout).text()
      await proc.exited
      return this.parseCrontabLines(text, 'user-crontab', false)
    } catch {
      return []
    }
  }

  /** Parse /etc/crontab and /etc/cron.d/* into CronJob[] */
  async discoverSystemCrontab(): Promise<CronJob[]> {
    const jobs: CronJob[] = []

    // Parse /etc/crontab
    try {
      const text = await Bun.file('/etc/crontab').text()
      jobs.push(...this.parseCrontabLines(text, 'system-crontab', true))
    } catch {
      // ENOENT or EACCES — skip silently
    }

    // Parse /etc/cron.d/*
    try {
      const glob = new Bun.Glob('/etc/cron.d/*')
      for await (const filePath of glob.scan('/')) {
        try {
          const text = await Bun.file(filePath).text()
          jobs.push(...this.parseCrontabLines(text, 'system-crontab', true))
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // /etc/cron.d may not exist
    }

    return jobs
  }

  /** Parse `systemctl --user list-timers --all --output=json` */
  async discoverUserTimers(): Promise<CronJob[]> {
    return this.discoverTimers(true)
  }

  /** Parse `systemctl list-timers --all --output=json` */
  async discoverSystemTimers(): Promise<CronJob[]> {
    return this.discoverTimers(false)
  }

  /** Shared impl for user/system timer discovery */
  private async discoverTimers(userScope: boolean): Promise<CronJob[]> {
    const source: JobSource = userScope ? 'user-systemd' : 'systemd-system'
    const scopeFlag = userScope ? ['--user'] : []

    try {
      const proc = Bun.spawn(['systemctl', ...scopeFlag, 'list-timers', '--all', '--output=json'], {
        stdout: 'pipe',
        stderr: 'ignore',
      })
      const text = await new Response(proc.stdout).text()
      await proc.exited

      let entries: Array<{ unit?: string }> = []
      try {
        entries = JSON.parse(text)
      } catch {
        return []
      }

      const jobs: CronJob[] = []
      for (const entry of entries) {
        const unitName = entry.unit
        if (!unitName || !unitName.endsWith('.timer')) continue
        const name = unitName.replace(/\.timer$/, '')

        try {
          const showTimer = (prop: string) =>
            this.systemctlShow(scopeFlag, `${name}.timer`, prop)
          const showService = (prop: string) =>
            this.systemctlShow(scopeFlag, `${name}.service`, prop)

          const [onCalendar, fragmentPath, execStart, description] = await Promise.all([
            showTimer('OnCalendar'),
            showTimer('FragmentPath'),
            showService('ExecStart'),
            showService('Description'),
          ])

          const schedule = onCalendar ?? ''
          const scheduleHuman = this.parseSystemdCalendar(schedule)
          const command = execStart ?? ''
          const scriptPath = this.resolveScriptPath(command)
          const projectGroup = this.inferProjectGroup(scriptPath, command)
          const jobName = name
          const id = this.generateJobId(source, jobName, command)

          const job: CronJob = {
            id,
            name: jobName,
            source,
            schedule,
            scheduleHuman,
            command,
            scriptPath,
            projectGroup,
            status: 'active',
            health: 'unknown',
            healthReason: null,
            lastRun: null,
            lastRunDuration: null,
            nextRun: null,
            lastExitCode: null,
            consecutiveFailures: 0,
            avgDuration: null,
            user: userScope ? (process.env.USER ?? 'unknown') : null,
            requiresSudo: !userScope,
            avatarUrl: this.generateAvatarUrl(jobName, 'bottts'),
            unitFile: fragmentPath ?? null,
            description: description ?? null,
            tags: [],
            isManagedByAgentboard: false,
            linkedSessionId: null,
          }
          jobs.push(job)
        } catch {
          // Skip individual timer errors
        }
      }
      return jobs
    } catch {
      return []
    }
  }

  /** Run `systemctl [scopeFlags] show {unit} -p {prop} --value` and return trimmed output */
  private async systemctlShow(
    scopeFlags: string[],
    unit: string,
    prop: string
  ): Promise<string | null> {
    try {
      const proc = Bun.spawn(
        ['systemctl', ...scopeFlags, 'show', unit, '-p', prop, '--value'],
        { stdout: 'pipe', stderr: 'ignore' }
      )
      const text = await new Response(proc.stdout).text()
      await proc.exited
      const trimmed = text.trim()
      return trimmed || null
    } catch {
      return null
    }
  }

  /** Strip flock wrapper added by createCronJob, returning the original command.
   * Pattern: `flock -n /path/to/lock <original-command>`
   * Used during discovery so that discovered job IDs match the IDs assigned at creation time.
   */
  stripFlockWrapper(command: string): string {
    // Match: flock -n <lockfile> <rest>
    const match = command.match(/^flock\s+-n\s+\S+\s+(.+)$/)
    return match ? match[1] : command
  }

  /** Deterministic hash of source+name+command (NOT schedule) */
  generateJobId(source: string, name: string, command: string): string {
    const input = `${source}:${name}:${command}`
    const hash = new Bun.CryptoHasher('sha256').update(input).digest('hex')
    return hash.slice(0, 16)
  }

  /** Convert cron expression to human-readable string via cronstrue */
  parseCronSchedule(expression: string): string {
    try {
      return cronstrue.toString(expression)
    } catch {
      return expression
    }
  }

  /** Convert systemd calendar spec to human-readable string */
  parseSystemdCalendar(spec: string): string {
    if (!spec) return spec
    // Well-known shorthand keywords
    const keywords: Record<string, string> = {
      daily: 'Daily',
      weekly: 'Weekly',
      monthly: 'Monthly',
      hourly: 'Hourly',
      minutely: 'Minutely',
      annually: 'Annually',
      yearly: 'Yearly',
    }
    const lower = spec.trim().toLowerCase()
    if (keywords[lower]) return keywords[lower]

    // *-*-* HH:MM:SS — "Daily at HH:MM"
    const dailyMatch = spec.match(/^\*-\*-\*\s+(\d{2}:\d{2})(?::\d{2})?$/)
    if (dailyMatch) return `Daily at ${dailyMatch[1]}`

    return spec
  }

  /** Extract file path from command string; null for pipelines/inline */
  resolveScriptPath(command: string): string | null {
    if (!command) return null
    // Pipelines — no single script path
    if (command.includes('|')) return null

    const parts = command.trim().split(/\s+/)
    if (parts.length === 0) return null

    const first = parts[0]
    // Direct file path
    if (first.startsWith('/') || first.startsWith('./') || first.startsWith('~/')) {
      return first
    }

    // Interpreter + script argument
    const interpreters = ['bash', 'sh', 'python', 'python3', 'node', 'ruby', 'perl']
    const basename = first.split('/').pop() ?? first
    if (!interpreters.includes(basename) || parts.length <= 1) return null

    const second = parts[1]
    if (
      second.startsWith('/') ||
      second.startsWith('./') ||
      second.startsWith('~/') ||
      second.endsWith('.py') ||
      second.endsWith('.sh') ||
      second.endsWith('.rb') ||
      second.endsWith('.pl') ||
      second.endsWith('.js') ||
      second.endsWith('.ts')
    ) {
      return second
    }

    return null
  }

  /** Derive project group from script path; 'System' as fallback */
  inferProjectGroup(scriptPath: string | null, _command: string): string {
    if (!scriptPath) return 'System'

    // Expand ~ to home dir for analysis
    const home = process.env.HOME ?? ''
    const resolved = scriptPath.startsWith('~/')
      ? scriptPath.replace('~', home)
      : scriptPath

    // Get parent directory name
    const parts = resolved.replace(/\/$/, '').split('/')
    if (parts.length >= 2) {
      const parent = parts[parts.length - 2]
      // Skip generic directories
      if (parent && !['bin', 'sbin', 'usr', 'etc', 'opt', 'tmp'].includes(parent)) {
        return parent
      }
    }

    return 'System'
  }

  /** Generate DiceBear avatar URL for a job */
  generateAvatarUrl(jobName: string, style: string): string {
    return `https://api.dicebear.com/9.x/${style}/svg?seed=${encodeURIComponent(jobName)}&size=48`
  }

  /** Project future run times using cron-parser */
  projectNextRuns(schedule: string, source: JobSource, count: number): Date[] {
    // Systemd calendar specs are complex — skip
    if (source === 'user-systemd' || source === 'systemd-system') return []
    try {
      const iter = CronExpressionParser.parse(schedule)
      const dates: Date[] = []
      for (let i = 0; i < count; i++) {
        dates.push(iter.next().toDate())
      }
      return dates
    } catch {
      return []
    }
  }

  // ─── WU-003: Crontab line parser (shared by user + system) ──────────────────

  /**
   * Parse crontab text into CronJob[].
   * @param text      raw crontab output
   * @param source    job source label
   * @param hasUser   true for system crontab format (extra USER column)
   */
  private parseCrontabLines(
    text: string,
    source: JobSource,
    hasUser: boolean
  ): CronJob[] {
    const jobs: CronJob[] = []

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trimEnd()

      // Blank lines and environment variable lines (VAR=value, no schedule)
      if (!line.trim()) continue

      let isPaused = false
      let parseLine = line

      if (line.startsWith('#AGENTBOARD_PAUSED:')) {
        isPaused = true
        parseLine = line.slice('#AGENTBOARD_PAUSED:'.length).trim()
      } else if (line.startsWith('#')) {
        // Regular comment — skip
        continue
      }

      // Environment variable lines: contain '=' but no cron schedule prefix
      // A cron schedule line must start with a digit, '*', '@', or '-'
      const firstChar = parseLine.trim()[0]
      if (!firstChar) continue
      if (!'0123456789*@-'.includes(firstChar)) continue

      // Split into tokens
      const tokens = parseLine.trim().split(/\s+/)

      // Handle @reboot / @yearly / @annually / @monthly / @weekly / @daily / @hourly
      if (tokens[0].startsWith('@')) {
        const atKeyword = tokens[0]
        let user: string | null = null
        let commandStart = 1
        if (hasUser && tokens.length > 2) {
          user = tokens[1]
          commandStart = 2
        }
        const command = tokens.slice(commandStart).join(' ')
        if (!command) continue
        // Strip flock wrapper so discovered job ID matches the ID assigned at creation time
        const originalCommand = this.stripFlockWrapper(command)
        const name = this.deriveJobName(originalCommand)
        const id = this.generateJobId(source, name, originalCommand)
        const scriptPath = this.resolveScriptPath(originalCommand)
        const projectGroup = this.inferProjectGroup(scriptPath, originalCommand)
        jobs.push({
          id,
          name,
          source,
          schedule: atKeyword,
          scheduleHuman: this.parseCronSchedule(atKeyword),
          command,
          scriptPath,
          projectGroup,
          status: isPaused ? 'paused' : 'active',
          health: 'unknown',
          healthReason: null,
          lastRun: null,
          lastRunDuration: null,
          nextRun: null,
          lastExitCode: null,
          consecutiveFailures: 0,
          avgDuration: null,
          user: user ?? (process.env.USER ?? 'unknown'),
          requiresSudo: hasUser,
          avatarUrl: this.generateAvatarUrl(name, 'bottts'),
          unitFile: null,
          description: null,
          tags: [],
          isManagedByAgentboard: false,
          linkedSessionId: null,
        })
        continue
      }

      // Standard 5-field cron: minute hour dom month dow [user] command
      const scheduleFieldCount = 5
      const minTokens = hasUser ? scheduleFieldCount + 2 : scheduleFieldCount + 1
      if (tokens.length < minTokens) continue

      const schedule = tokens.slice(0, scheduleFieldCount).join(' ')
      let user: string | null = null
      let commandStart = scheduleFieldCount
      if (hasUser) {
        user = tokens[scheduleFieldCount]
        commandStart = scheduleFieldCount + 1
      }
      const command = tokens.slice(commandStart).join(' ')
      if (!command) continue

      // Strip flock wrapper so discovered job ID matches the ID assigned at creation time
      const originalCommand = this.stripFlockWrapper(command)
      const name = this.deriveJobName(originalCommand)
      const id = this.generateJobId(source, name, originalCommand)
      const scriptPath = this.resolveScriptPath(originalCommand)
      const projectGroup = this.inferProjectGroup(scriptPath, originalCommand)
      const nextRuns = this.projectNextRuns(schedule, source, 1)
      const nextRun = nextRuns.length > 0 ? nextRuns[0].toISOString() : null

      jobs.push({
        id,
        name,
        source,
        schedule,
        scheduleHuman: this.parseCronSchedule(schedule),
        command,
        scriptPath,
        projectGroup,
        status: isPaused ? 'paused' : 'active',
        health: 'unknown',
        healthReason: null,
        lastRun: null,
        lastRunDuration: null,
        nextRun,
        lastExitCode: null,
        consecutiveFailures: 0,
        avgDuration: null,
        user: user ?? (process.env.USER ?? 'unknown'),
        requiresSudo: hasUser,
        avatarUrl: this.generateAvatarUrl(name, 'bottts'),
        unitFile: null,
        description: null,
        tags: [],
        isManagedByAgentboard: false,
        linkedSessionId: null,
      })
    }

    return jobs
  }

  /** Derive a human-readable job name from a command string */
  private deriveJobName(command: string): string {
    const trimmed = command.trim()
    // Use basename of the first word if it looks like a path
    const firstWord = trimmed.split(/\s+/)[0]
    const basename = firstWord.split('/').pop() ?? firstWord
    // For interpreter commands, try the second word
    const interpreters = ['bash', 'sh', 'python', 'python3', 'node', 'ruby', 'perl']
    if (interpreters.includes(basename)) {
      const parts = trimmed.split(/\s+/)
      if (parts.length > 1) {
        const scriptBasename = parts[1].split('/').pop() ?? parts[1]
        return scriptBasename.slice(0, 40)
      }
    }
    if (basename && basename !== trimmed.slice(0, 40)) {
      return basename.slice(0, 40)
    }
    return trimmed.slice(0, 40)
  }

  // ─── WU-004: Polling & Diff ─────────────────────────────────────────────

  /** Start polling at the given interval (ms) */
  startPolling(intervalMs: number): void {
    if (this.pollingInterval) this.stopPolling()
    this.pollingInterval = setInterval(async () => {
      const jobs = await this.discoverAllJobs()
      const enrichedJobs = await this.enrichAllJobsWithHealth(jobs)
      const diff = this.computeDiff(enrichedJobs)
      this.notifyDiff(diff)
    }, intervalMs)
  }

  /** Notify registered callbacks when jobs have changed */
  private notifyDiff(diff: { added: CronJob[]; removed: string[]; updated: CronJob[] }): void {
    if (diff.added.length === 0 && diff.removed.length === 0 && diff.updated.length === 0) { return }
    for (const cb of this.jobsChangedCallbacks) { cb(diff.added, diff.removed, diff.updated) }
  }

  /** Enrich all jobs with health status from run history */
  private async enrichAllJobsWithHealth(jobs: CronJob[]): Promise<CronJob[]> {
    if (!this.db) {
      return jobs // Graceful degradation before db is set
    }
    const enriched: CronJob[] = []
    for (const job of jobs) {
      const history = getRunHistory(this.db, job.id, 20)
      const { health } = this.computeHealth(job, history)
      const durations = history
        .map((r) => r.duration)
        .filter((d): d is number => d !== null && d !== undefined)

      const avgDuration = durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : null
      const lastRunDuration = durations.length > 0 ? durations[0] : null

      // Count consecutive failures for the enriched data
      let consecutiveFailures = 0
      for (const record of history) {
        if (record.exitCode !== 0) {
          consecutiveFailures++
        } else {
          break
        }
      }

      enriched.push({
        ...job,
        health,
        avgDuration,
        lastRunDuration,
        consecutiveFailures,
      })
    }
    return enriched
  }

  /** Stop the polling interval */
  stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval)
      this.pollingInterval = null
    }
  }

  /** Register a callback for job change diffs */
  onJobsChanged(
    callback: (added: CronJob[], removed: string[], updated: CronJob[]) => void
  ): void {
    this.jobsChangedCallbacks.push(callback)
  }

  /** Compare new jobs against cache, emit added/removed/updated */
  private computeDiff(
    newJobs: CronJob[]
  ): { added: CronJob[]; removed: string[]; updated: CronJob[] } {
    const added: CronJob[] = []
    const removed: string[] = []
    const updated: CronJob[] = []

    const newJobMap = new Map<string, CronJob>()
    for (const job of newJobs) {
      newJobMap.set(job.id, job)
    }

    // Find added and updated
    for (const job of newJobs) {
      const cached = this.jobCache.get(job.id)
      if (!cached) {
        added.push(job)
      } else if (JSON.stringify(cached) !== JSON.stringify(job)) {
        updated.push(job)
      }
    }

    // Find removed
    for (const [id] of this.jobCache) {
      if (!newJobMap.has(id)) {
        removed.push(id)
      }
    }

    // Update the cache
    this.jobCache = newJobMap

    return { added, removed, updated }
  }

  /** Compute health status from run history */
  computeHealth(
    job: CronJob,
    history: JobRunRecord[]
  ): { health: HealthStatus; reason: string | null } {
    if (history.length === 0) {
      return { health: 'unknown', reason: null }
    }

    // Count consecutive failures from most recent
    let consecutiveFailures = 0
    for (const record of history) {
      if (record.exitCode !== 0) {
        consecutiveFailures++
      } else {
        break
      }
    }

    if (consecutiveFailures >= 2) {
      return { health: 'critical', reason: `${consecutiveFailures} consecutive failures` }
    }

    const lastRun = history[0]
    if (lastRun.exitCode !== 0) {
      return { health: 'warning', reason: 'Last run failed' }
    }

    // Check if last duration > 2x avgDuration
    if (job.avgDuration != null && lastRun.duration != null && lastRun.duration > 2 * job.avgDuration) {
      return { health: 'warning', reason: 'Duration exceeded 2x average' }
    }

    // Check last 10 all succeeded
    const recent = history.slice(0, 10)
    if (recent.every(r => r.exitCode === 0)) {
      return { health: 'healthy', reason: null }
    }

    return { health: 'healthy', reason: null }
  }

  /** Check if time since last run exceeds 2x expected interval */
  private detectMissedRun(job: CronJob): boolean {
    if (!job.nextRun || !job.lastRun) return false

    const isCronSource = job.source === 'user-crontab' || job.source === 'system-crontab'
    if (!isCronSource) return false

    let intervalMs: number
    try {
      const iter = CronExpressionParser.parse(job.schedule)
      const next1 = iter.next().toDate().getTime()
      const next2 = iter.next().toDate().getTime()
      intervalMs = next2 - next1
    } catch {
      return false
    }

    const now = Date.now()
    const lastRunMs = new Date(job.lastRun).getTime()
    const timeSinceLastRun = now - lastRunMs

    return timeSinceLastRun > 2 * intervalMs
  }

  /** Delete orphaned prefs with last_seen > 24h not in current set */
  cleanOrphanedPrefs(currentJobIds: string[]): void {
    if (!this.db) return
    deleteOrphanedPrefs(this.db, currentJobIds)
  }

  /** Delete run history >90 days; cap at 500 records per job */
  pruneRunHistory(): void {
    if (!this.db) return
    pruneDbRunHistory(this.db)
  }

  // ─── WU-005: Private Helpers ─────────────────────────────────────────────

  /** Run a command without sudo, returning exit code and captured output */
  private async runCommand(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    return { exitCode, stdout, stderr }
  }

  /** Run a command with sudo, piping the credential to stdin */
  private async runWithSudo(
    args: string[],
    sudoCredential?: Uint8Array
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const cred = sudoCredential || this.sudoCredentialCache
    if (!cred) throw new Error('Sudo credential required but not available')
    const proc = Bun.spawn(['sudo', '-S', ...args], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    proc.stdin.write(cred)
    proc.stdin.write(new TextEncoder().encode('\n'))
    proc.stdin.end()
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    return { exitCode, stdout, stderr }
  }

  /** Read the current user crontab, returning empty string if none exists */
  protected async readCrontab(): Promise<string> {
    const proc = Bun.spawn(['crontab', '-l'], { stdout: 'pipe', stderr: 'ignore' })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    return text
  }

  /** Write lines back as the user crontab via `crontab -` */
  protected async writeCrontab(content: string): Promise<void> {
    const proc = Bun.spawn(['crontab', '-'], {
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    proc.stdin.write(new TextEncoder().encode(content))
    proc.stdin.end()
    await proc.exited
  }

  // ─── WU-005: Operations ─────────────────────────────────────────────────

  /** Execute job, stream output; child runs to completion even if WS disconnects */
  async *runJobNow(
    jobId: string,
    sudoCredential?: Uint8Array
  ): AsyncGenerator<string> {
    const job = this.jobCache.get(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)

    let proc: ReturnType<typeof Bun.spawn>

    const isSystemd = job.source === 'user-systemd' || job.source === 'systemd-system'

    if (isSystemd) {
      const scopeArgs = job.source === 'user-systemd' ? ['--user'] : []
      const args = ['systemctl', ...scopeArgs, 'start', `${job.name}.service`]
      if (job.requiresSudo) {
        const { stdout, stderr } = await this.runWithSudo(args.slice(1), sudoCredential)
        if (stdout) yield stdout
        if (stderr) yield stderr
      } else {
        const { stdout, stderr } = await this.runCommand(args)
        if (stdout) yield stdout
        if (stderr) yield stderr
      }
      return
    }

    // Cron job: run command via sh -c
    if (job.requiresSudo) {
      const cred = sudoCredential || this.sudoCredentialCache
      if (!cred) throw new Error('Sudo credential required but not available')
      proc = Bun.spawn(['sudo', '-S', 'sh', '-c', job.command], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const stdin = proc.stdin as import('bun').FileSink
      stdin.write(cred)
      stdin.write(new TextEncoder().encode('\n'))
      stdin.end()
    } else {
      proc = Bun.spawn(['sh', '-c', job.command], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
    }

    const decoder = new TextDecoder()
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) yield decoder.decode(value)
    }
    await proc.exited
  }

  /** Pause job: cron = comment with #AGENTBOARD_PAUSED:; systemd = stop+disable */
  async pauseJob(jobId: string, sudoCredential?: Uint8Array): Promise<void> {
    const job = this.jobCache.get(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)

    const isSystemd = job.source === 'user-systemd' || job.source === 'systemd-system'

    if (isSystemd) {
      const scopeArgs = job.source === 'user-systemd' ? ['--user'] : []
      if (job.requiresSudo) {
        await this.runWithSudo(['systemctl', ...scopeArgs, 'stop', `${job.name}.timer`], sudoCredential)
        await this.runWithSudo(['systemctl', ...scopeArgs, 'disable', `${job.name}.timer`], sudoCredential)
      } else {
        await this.runCommand(['systemctl', ...scopeArgs, 'stop', `${job.name}.timer`])
        await this.runCommand(['systemctl', ...scopeArgs, 'disable', `${job.name}.timer`])
      }
      return
    }

    // Cron: prefix matching line with #AGENTBOARD_PAUSED:
    const crontab = await this.readCrontab()
    const lines = crontab.split('\n')
    let found = false
    const newLines = lines.map(line => {
      if (found) return line
      // Match lines that contain the job's command and schedule
      const trimmed = line.trim()
      if (trimmed.startsWith('#AGENTBOARD_PAUSED:')) return line
      if (trimmed.includes(job.command) && trimmed.includes(job.schedule)) {
        found = true
        return `#AGENTBOARD_PAUSED: ${line}`
      }
      return line
    })
    await this.writeCrontab(newLines.join('\n'))
  }

  /** Resume job: cron = uncomment; systemd = enable+start */
  async resumeJob(jobId: string, sudoCredential?: Uint8Array): Promise<void> {
    const job = this.jobCache.get(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)

    const isSystemd = job.source === 'user-systemd' || job.source === 'systemd-system'

    if (isSystemd) {
      const scopeArgs = job.source === 'user-systemd' ? ['--user'] : []
      if (job.requiresSudo) {
        await this.runWithSudo(['systemctl', ...scopeArgs, 'enable', `${job.name}.timer`], sudoCredential)
        await this.runWithSudo(['systemctl', ...scopeArgs, 'start', `${job.name}.timer`], sudoCredential)
      } else {
        await this.runCommand(['systemctl', ...scopeArgs, 'enable', `${job.name}.timer`])
        await this.runCommand(['systemctl', ...scopeArgs, 'start', `${job.name}.timer`])
      }
      return
    }

    // Cron: remove #AGENTBOARD_PAUSED: prefix
    const crontab = await this.readCrontab()
    const lines = crontab.split('\n')
    const newLines = lines.map(line => {
      if (line.startsWith('#AGENTBOARD_PAUSED:')) {
        const original = line.slice('#AGENTBOARD_PAUSED:'.length).trim()
        // Only resume this specific job
        if (original.includes(job.command)) {
          return original
        }
      }
      return line
    })
    await this.writeCrontab(newLines.join('\n'))
  }

  /** Edit frequency: cron = replace schedule cols; systemd = OnCalendar + daemon-reload */
  async editFrequency(
    jobId: string,
    newSchedule: string,
    sudoCredential?: Uint8Array
  ): Promise<void> {
    const job = this.jobCache.get(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)

    const isSystemd = job.source === 'user-systemd' || job.source === 'systemd-system'

    if (isSystemd) {
      if (!job.unitFile) throw new Error(`No unit file path for job: ${jobId}`)
      const timerContent = await Bun.file(job.unitFile).text()
      const updated = timerContent.replace(
        /^OnCalendar=.*$/m,
        `OnCalendar=${newSchedule}`
      )
      if (job.requiresSudo) {
        // Write via tee with sudo
        const proc = Bun.spawn(['sudo', '-S', 'tee', job.unitFile], {
          stdin: 'pipe',
          stdout: 'ignore',
          stderr: 'ignore',
        })
        const cred = sudoCredential || this.sudoCredentialCache
        if (!cred) throw new Error('Sudo credential required but not available')
        proc.stdin.write(cred)
        proc.stdin.write(new TextEncoder().encode('\n'))
        proc.stdin.write(new TextEncoder().encode(updated))
        proc.stdin.end()
        await proc.exited
        await this.runWithSudo(['systemctl', 'daemon-reload'], sudoCredential)
      } else {
        await Bun.write(job.unitFile, updated)
        await this.runCommand(['systemctl', '--user', 'daemon-reload'])
      }
      return
    }

    // Cron: validate new schedule, then replace 5 schedule fields on the matching line
    try {
      CronExpressionParser.parse(newSchedule)
    } catch {
      throw new Error(`Invalid cron schedule: ${newSchedule}`)
    }

    const crontab = await this.readCrontab()
    const lines = crontab.split('\n')
    let found = false
    const newLines = lines.map(line => {
      if (found) return line
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) return line
      if (trimmed.includes(job.command) && trimmed.includes(job.schedule)) {
        found = true
        const tokens = trimmed.split(/\s+/)
        // Replace first 5 tokens (schedule fields) with newSchedule fields
        const newScheduleFields = newSchedule.trim().split(/\s+/)
        if (newScheduleFields.length !== 5) {
          throw new Error('New schedule must have exactly 5 cron fields')
        }
        const rest = tokens.slice(5)
        return [...newScheduleFields, ...rest].join(' ')
      }
      return line
    })
    await this.writeCrontab(newLines.join('\n'))
  }

  /** Delete job: cron = remove line; systemd = stop+disable+remove unit files */
  async deleteJob(jobId: string, sudoCredential?: Uint8Array): Promise<void> {
    const job = this.jobCache.get(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)

    await this.createBackup(job)

    const isSystemd = job.source === 'user-systemd' || job.source === 'systemd-system'

    if (isSystemd) {
      const scopeArgs = job.source === 'user-systemd' ? ['--user'] : []
      const timerUnit = `${job.name}.timer`
      const _serviceUnit = `${job.name}.service`

      if (job.requiresSudo) {
        await this.runWithSudo(['systemctl', ...scopeArgs, 'stop', timerUnit], sudoCredential)
        await this.runWithSudo(['systemctl', ...scopeArgs, 'disable', timerUnit], sudoCredential)
      } else {
        await this.runCommand(['systemctl', ...scopeArgs, 'stop', timerUnit])
        await this.runCommand(['systemctl', ...scopeArgs, 'disable', timerUnit])
      }

      // Remove unit files if we know their paths
      if (job.unitFile) {
        const timerPath = job.unitFile
        const servicePath = timerPath.replace(/\.timer$/, '.service')
        if (job.requiresSudo) {
          await this.runWithSudo(['rm', '-f', timerPath, servicePath], sudoCredential)
          await this.runWithSudo(['systemctl', ...scopeArgs, 'daemon-reload'], sudoCredential)
        } else {
          await this.runCommand(['rm', '-f', timerPath, servicePath])
          await this.runCommand(['systemctl', ...scopeArgs, 'daemon-reload'])
        }
      }
      return
    }

    // Cron: remove matching line
    const crontab = await this.readCrontab()
    const lines = crontab.split('\n')
    let found = false
    const newLines = lines.filter(line => {
      if (found) return true
      const trimmed = line.trim()
      const stripped = trimmed.startsWith('#AGENTBOARD_PAUSED:')
        ? trimmed.slice('#AGENTBOARD_PAUSED:'.length).trim()
        : trimmed
      if (stripped.includes(job.command)) {
        found = true
        return false
      }
      return true
    })
    await this.writeCrontab(newLines.join('\n'))
  }

  /** Create cron job by appending to user crontab; return new job ID */
  async createCronJob(config: CronCreateConfig): Promise<string> {
    this.validateCronCommand(config.command)

    // Compute jobId from the ORIGINAL command before flock wrapping
    const name = this.deriveJobName(config.command)
    const jobId = this.generateJobId('user-crontab', name, config.command)

    // Wrap command with flock for OS-level mutual exclusion (BUG-3 fix)
    const lockFile = `/tmp/agentboard-cron-${jobId}.lock`
    const wrappedCommand = `flock -n ${lockFile} ${config.command}`

    const crontab = await this.readCrontab()

    // Duplicate detection: reject if identical schedule+command already exists
    // Also checks paused entries (prefixed with #AGENTBOARD_PAUSED:)
    const duplicatePattern = `${config.schedule} ${config.command}`
    const flockDuplicatePattern = `${config.schedule} ${wrappedCommand}`
    for (const line of crontab.split('\n')) {
      let normalized = line.trim()
      if (normalized.startsWith('#AGENTBOARD_PAUSED:')) {
        normalized = normalized.slice('#AGENTBOARD_PAUSED:'.length).trim()
      }
      const stripped = normalized.replace(/\s*#.*$/, '').trim()
      if (stripped === duplicatePattern || stripped === flockDuplicatePattern) {
        throw new Error(`Duplicate job: a cron entry with schedule "${config.schedule}" and command "${config.command}" already exists`)
      }
    }

    const comment = config.comment ? ` # ${config.comment}` : ''
    const newLine = `${config.schedule} ${wrappedCommand}${comment}`
    // Prepend new entry so its lock path appears first when multiple jobs exist
    const updated = newLine + '\n' + (crontab || '')
    await this.writeCrontab(updated)

    return jobId
  }

  /** Generate .timer+.service, write, daemon-reload, enable, start */
  async createSystemdTimer(
    config: SystemdCreateConfig,
    sudoCredential?: Uint8Array
  ): Promise<string> {
    this.validateSystemdServiceName(config.serviceName)
    this.validateCronCommand(config.command)

    const isSystem = config.scope === 'system'
    const unitDir = isSystem
      ? '/etc/systemd/system'
      : `${process.env.HOME ?? '~'}/.config/systemd/user`

    const timerContent = [
      '[Unit]',
      `Description=${config.description ?? config.serviceName}`,
      '',
      '[Timer]',
      `OnCalendar=${config.schedule}`,
      'Persistent=true',
      '',
      '[Install]',
      'WantedBy=timers.target',
      '',
    ].join('\n')

    const workingDirLine = config.workingDirectory
      ? `WorkingDirectory=${config.workingDirectory}`
      : ''

    const serviceContent = [
      '[Unit]',
      `Description=${config.description ?? config.serviceName}`,
      '',
      '[Service]',
      'Type=oneshot',
      `ExecStart=${config.command}`,
      ...(workingDirLine ? [workingDirLine] : []),
      '',
    ].join('\n')

    const timerPath = `${unitDir}/${config.serviceName}.timer`
    const servicePath = `${unitDir}/${config.serviceName}.service`

    if (isSystem) {
      if (!sudoCredential && !this.sudoCredentialCache) {
        throw new Error('Sudo credential required for system-scope timer')
      }
      // Write via tee with sudo
      const writeFile = async (path: string, content: string) => {
        const cred = sudoCredential || this.sudoCredentialCache!
        const proc = Bun.spawn(['sudo', '-S', 'tee', path], {
          stdin: 'pipe',
          stdout: 'ignore',
          stderr: 'ignore',
        })
        proc.stdin.write(cred)
        proc.stdin.write(new TextEncoder().encode('\n'))
        proc.stdin.write(new TextEncoder().encode(content))
        proc.stdin.end()
        await proc.exited
      }
      await writeFile(timerPath, timerContent)
      await writeFile(servicePath, serviceContent)
      await this.runWithSudo(['systemctl', 'daemon-reload'], sudoCredential)
      await this.runWithSudo(['systemctl', 'enable', `${config.serviceName}.timer`], sudoCredential)
      await this.runWithSudo(['systemctl', 'start', `${config.serviceName}.timer`], sudoCredential)
    } else {
      // Ensure directory exists
      await this.runCommand(['mkdir', '-p', unitDir])
      await Bun.write(timerPath, timerContent)
      await Bun.write(servicePath, serviceContent)
      await this.runCommand(['systemctl', '--user', 'daemon-reload'])
      await this.runCommand(['systemctl', '--user', 'enable', `${config.serviceName}.timer`])
      await this.runCommand(['systemctl', '--user', 'start', `${config.serviceName}.timer`])
    }

    return this.generateJobId(
      isSystem ? 'systemd-system' : 'user-systemd',
      config.serviceName,
      config.command
    )
  }

  /** Bulk pause with progress; single sudo prompt covers all */
  async *bulkPause(
    jobIds: string[],
    sudoCredential?: Uint8Array
  ): AsyncGenerator<BulkProgress> {
    const failures: string[] = []
    for (let i = 0; i < jobIds.length; i++) {
      try {
        await this.pauseJob(jobIds[i], sudoCredential)
      } catch {
        failures.push(jobIds[i])
      }
      yield { completed: i + 1, total: jobIds.length, failures }
    }
  }

  /** Bulk resume with progress */
  async *bulkResume(
    jobIds: string[],
    sudoCredential?: Uint8Array
  ): AsyncGenerator<BulkProgress> {
    const failures: string[] = []
    for (let i = 0; i < jobIds.length; i++) {
      try {
        await this.resumeJob(jobIds[i], sudoCredential)
      } catch {
        failures.push(jobIds[i])
      }
      yield { completed: i + 1, total: jobIds.length, failures }
    }
  }

  /** Bulk delete with progress */
  async *bulkDelete(
    jobIds: string[],
    sudoCredential?: Uint8Array
  ): AsyncGenerator<BulkProgress> {
    const failures: string[] = []
    for (let i = 0; i < jobIds.length; i++) {
      try {
        await this.deleteJob(jobIds[i], sudoCredential)
      } catch {
        failures.push(jobIds[i])
      }
      yield { completed: i + 1, total: jobIds.length, failures }
    }
  }

  /** Create crontab snapshot or unit file copy to ~/.agentboard/backups/ */
  private async createBackup(job: CronJob): Promise<void> {
    const backupDir = `${process.env.HOME ?? '~'}/.agentboard/backups`
    await this.runCommand(['mkdir', '-p', backupDir])

    const isSystemd = job.source === 'user-systemd' || job.source === 'systemd-system'

    if (isSystemd && job.unitFile) {
      const timerPath = job.unitFile
      const servicePath = timerPath.replace(/\.timer$/, '.service')
      const ts = Date.now()
      try {
        const timerContent = await Bun.file(timerPath).text()
        await Bun.write(`${backupDir}/${job.name}-${ts}.timer.bak`, timerContent)
      } catch { /* unit file may not be readable */ }
      try {
        const serviceContent = await Bun.file(servicePath).text()
        await Bun.write(`${backupDir}/${job.name}-${ts}.service.bak`, serviceContent)
      } catch { /* service file may not exist */ }
    } else {
      // Cron backup: snapshot current crontab
      const crontab = await this.readCrontab()
      await Bun.write(`${backupDir}/crontab-${Date.now()}.bak`, crontab)
    }
  }

  /** Reject commands with newlines and null bytes */
  private validateCronCommand(command: string): void {
    // eslint-disable-next-line no-control-regex
    if (/[\n\r\x00]/.test(command)) {
      throw new Error('Command contains invalid characters (newline/carriage return/null byte)')
    }
    if (!command.trim()) {
      throw new Error('Command cannot be empty')
    }
  }

  /** Validate systemd service name against /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/ */
  private validateSystemdServiceName(name: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
      throw new Error('Invalid systemd service name')
    }
  }

  // ─── WU-005: Credential Cache ────────────────────────────────────────────

  /** Cache credential as Uint8Array with auto-clear timeout */
  cacheSudoCredential(credential: Uint8Array, gracePeriodMs: number): void {
    this.clearSudoCredential()
    this.sudoCredentialCache = new Uint8Array(credential)
    this.sudoCredentialExpiry = Date.now() + gracePeriodMs
    this.sudoCredentialTimer = setTimeout(() => this.clearSudoCredential(), gracePeriodMs)
  }

  /** Zero the buffer and clear the credential */
  clearSudoCredential(): void {
    if (this.sudoCredentialCache) {
      this.sudoCredentialCache.fill(0)
      this.sudoCredentialCache = null
    }
    if (this.sudoCredentialTimer) {
      clearTimeout(this.sudoCredentialTimer)
      this.sudoCredentialTimer = null
    }
    this.sudoCredentialExpiry = 0
  }
}
