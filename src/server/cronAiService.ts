// WU-003: CronAiService Core
// Central coordinator between MCP server, agentboard server, and UI.
// Manages proposal queue, UI context, MCP WS connection, HTTP handlers,
// config/skill generation, and session lifecycle.

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ─── tmux helper (module-level, not exported from SessionManager) ─────────────
function tmuxSendKeys(target: string, keys: string): void {
  Bun.spawnSync(['tmux', 'send-keys', '-t', target, keys, 'Enter'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

import type {
  CronAiProposal,
  CronAiProposalOperation,
  UiContext,
  ProposalResult,
  ScheduleConflict,
  ScheduleLoadAnalysis,
  DurationTrendData,
  CronJob,
  CronJobDetail,
  JobRunRecord,
  Session,
} from '@shared/types'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CronAiServiceConfig {
  port: number
  authToken?: string // AGENTBOARD_AUTH_TOKEN
  proposalTimeoutMs?: number // default: 300_000 (5 min)
}

export interface CronAiServiceDeps {
  cronManager: unknown       // CronManager from Phase 26
  historyService: unknown    // CronHistoryService
  logService: unknown        // CronLogService
  sessionManager: unknown    // SessionManager
}

interface PendingProposal {
  proposal: CronAiProposal
  resolve: (result: ProposalResult) => void
  timer: ReturnType<typeof setTimeout>
  details?: Record<string, unknown>
}

const VALID_OPERATIONS: CronAiProposalOperation[] = [
  'create', 'edit_frequency', 'pause', 'resume',
  'delete', 'run_now', 'set_tags', 'link_session',
]

const OPERATIONS_REQUIRING_JOB_ID: CronAiProposalOperation[] = [
  'pause', 'resume', 'delete', 'edit_frequency',
  'run_now', 'set_tags', 'link_session',
]

const DEFAULT_TIMEOUT_MS = 300_000 // 5 minutes

// ─── Service ─────────────────────────────────────────────────────────────────

export class CronAiService {
  private proposals = new Map<string, PendingProposal>()
  private context: UiContext | null = null
  private mcpWs: { send: (data: string) => void; close: (code: number, reason: string) => void } | null = null
  private config: CronAiServiceConfig
  private deps: CronAiServiceDeps

  constructor(deps: CronAiServiceDeps, config: CronAiServiceConfig) {
    this.deps = deps
    this.config = config
  }

  // ── Proposal Queue ───────────────────────────────────────────────────────

  /** Create a proposal and return a Promise that resolves on user accept/reject/timeout */
  async createProposal(payload: {
    operation: CronAiProposalOperation
    jobId?: string | null
    jobName?: string | null
    description: string
    diff: string
    details?: Record<string, unknown>
  }): Promise<ProposalResult> {
    const { operation, jobId, jobName, description, diff, details } = payload
    const cm = this.deps.cronManager as any

    // Validate operation
    if (!VALID_OPERATIONS.includes(operation)) {
      throw new Error(`Unknown operation: ${operation}`)
    }

    // Validate description
    if (!description || !description.trim()) {
      throw new Error('Description is required and cannot be empty')
    }

    // Validate jobId requirements
    if (operation === 'create' && jobId != null) {
      throw new Error('create operation must not specify a jobId')
    }
    if (OPERATIONS_REQUIRING_JOB_ID.includes(operation) && !jobId) {
      throw new Error(`${operation} operation requires a jobId`)
    }

    // Validate jobId exists in cache (for non-create operations)
    if (jobId && !cm.jobCache.has(jobId)) {
      throw new Error(`Job not found: ${jobId}`)
    }

    // Validate operation-specific required details
    if (operation === 'edit_frequency' && !details?.newSchedule) {
      throw new Error('edit_frequency requires details.newSchedule')
    }
    if (operation === 'create' && (!details?.schedule || !details?.command)) {
      throw new Error('create requires details.schedule and details.command')
    }
    if (operation === 'set_tags' && !details?.tags) {
      throw new Error('set_tags requires details.tags')
    }
    if (operation === 'link_session' && !details?.sessionId) {
      throw new Error('link_session requires details.sessionId')
    }

    // Strip sensitive fields from details
    const safeDetails = details ? { ...details } : undefined
    if (safeDetails) {
      delete safeDetails.sudoPassword
    }

    const job = jobId ? cm.jobCache.get(jobId) : null

    const proposal: CronAiProposal = {
      id: randomUUID(),
      operation,
      jobId: jobId ?? null,
      jobName: jobName ?? job?.name ?? null,
      jobAvatarUrl: job?.avatarUrl ?? null,
      description,
      diff,
      status: 'pending',
      feedback: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    }

    const timeoutMs = this.config.proposalTimeoutMs ?? DEFAULT_TIMEOUT_MS

    return new Promise<ProposalResult>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.proposals.get(proposal.id)
        if (pending && pending.proposal.status === 'pending') {
          pending.proposal.status = 'expired'
          pending.proposal.resolvedAt = new Date().toISOString()
          this.proposals.delete(proposal.id)
          resolve({ success: false, expired: true })
        }
      }, timeoutMs)

      this.proposals.set(proposal.id, {
        proposal,
        resolve,
        timer,
        details: safeDetails,
      })
    })
  }

  /** Resolve a pending proposal (accept or reject) */
  resolveProposal(id: string, approved: boolean, feedback?: string): ProposalResult {
    const pending = this.proposals.get(id)
    if (!pending || pending.proposal.status !== 'pending') {
      return { success: false, error: `Proposal not found or not pending: ${id}` }
    }

    clearTimeout(pending.timer)
    pending.proposal.resolvedAt = new Date().toISOString()

    if (approved) {
      pending.proposal.status = 'accepted'
      this.executeMutation(pending)
      const result: ProposalResult = { success: true }
      pending.resolve(result)
      return result
    }

    pending.proposal.status = 'rejected'
    pending.proposal.feedback = feedback ?? null
    const result: ProposalResult = { success: false, rejected: true, feedback }
    pending.resolve(result)
    return result
  }

  /** Get a proposal by ID */
  getProposal(id: string): CronAiProposal | undefined {
    const pending = this.proposals.get(id)
    return pending?.proposal
  }

  /** Get all pending proposals */
  getPendingProposals(): CronAiProposal[] {
    const result: CronAiProposal[] = []
    for (const entry of this.proposals.values()) {
      if (entry.proposal.status === 'pending') {
        result.push(entry.proposal)
      }
    }
    return result
  }

  /** Execute the mutation for an accepted proposal */
  private executeMutation(pending: PendingProposal): void {
    const cm = this.deps.cronManager as any
    const { proposal, details } = pending
    const { operation, jobId } = proposal

    switch (operation) {
      case 'pause':
        cm.pauseJob(jobId)
        break
      case 'resume':
        cm.resumeJob(jobId)
        break
      case 'delete':
        cm.deleteJob(jobId)
        break
      case 'edit_frequency':
        cm.editFrequency(jobId, details?.newSchedule)
        break
      case 'create':
        cm.createCronJob(details)
        break
      case 'run_now':
        cm.runJobNow(jobId)
        break
      case 'set_tags':
        // Delegate to cronManager if available
        if (cm.setTags) cm.setTags(jobId, details?.tags)
        break
      case 'link_session':
        if (cm.linkSession) cm.linkSession(jobId, details?.sessionId)
        break
    }
  }

  // ── UI Context ───────────────────────────────────────────────────────────

  /** Update stored UI context and forward to MCP WS if connected */
  updateContext(context: UiContext): void {
    this.context = context
    this.forwardToMcp({ type: 'context_update', ...context })
  }

  /** Get current UI context snapshot */
  getContext(): UiContext | null {
    return this.context
  }

  // ── MCP Server WS ───────────────────────────────────────────────────────

  /** Register MCP client WebSocket connection (validates auth) */
  registerMcpClient(ws: unknown, authToken?: string): boolean {
    if (this.config.authToken) {
      if (!authToken || authToken !== this.config.authToken) {
        (ws as any).close(4001, 'Invalid or missing auth token')
        return false
      }
    }
    this.mcpWs = ws as any
    return true
  }

  /** Unregister MCP client (on disconnect) */
  unregisterMcpClient(): void {
    this.mcpWs = null
  }

  /** Forward a message to the MCP WS client */
  forwardToMcp(message: Record<string, unknown>): void {
    if (this.mcpWs) {
      this.mcpWs.send(JSON.stringify(message))
    }
  }

  /** Handle navigation request from MCP and forward to UI clients */
  handleMcpNavigate(_action: string, _payload: Record<string, unknown>): void {
    // Broadcast to UI clients — no-op if none connected.
    // WU-004 wires actual WS broadcasting.
  }

  // ── HTTP Route Handlers ────────────────────────────────────────────────
  // These methods handle business logic; actual Hono routes are wired in WU-004.

  async handleGetJobs(query?: { group?: string }): Promise<CronJob[]> {
    const cm = this.deps.cronManager as any
    const jobs: CronJob[] = await cm.discoverAllJobs()
    if (query?.group) {
      return jobs.filter((j: CronJob) => j.projectGroup === query.group)
    }
    return jobs
  }

  async handleSearchJobs(query: string): Promise<CronJob[]> {
    const cm = this.deps.cronManager as any
    const jobs: CronJob[] = await cm.discoverAllJobs()
    const q = query.toLowerCase()
    return jobs.filter((j: CronJob) =>
      j.name.toLowerCase().includes(q) ||
      j.command.toLowerCase().includes(q) ||
      j.tags.some((t: string) => t.toLowerCase().includes(q))
    )
  }

  async handleGetJobDetail(jobId: string): Promise<CronJobDetail> {
    const cm = this.deps.cronManager as any
    const hs = this.deps.historyService as any
    const ls = this.deps.logService as any

    const jobs: CronJob[] = await cm.discoverAllJobs()
    const job = jobs.find((j: CronJob) => j.id === jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)

    const [runHistory, recentLogs] = await Promise.all([
      hs.getRunHistory(jobId, 10),
      ls.getLogs(jobId, 50),
    ])

    return {
      ...job,
      scriptContent: null,
      scriptLanguage: null,
      timerConfig: null,
      serviceConfig: null,
      crontabLine: null,
      runHistory,
      recentLogs,
    } as CronJobDetail
  }

  async handleGetJobHistory(jobId: string, limit: number, before?: string): Promise<JobRunRecord[]> {
    const hs = this.deps.historyService as any
    return hs.getRunHistory(jobId, limit, before)
  }

  async handleGetJobLogs(jobId: string, lines: number, offset?: number): Promise<string[]> {
    const ls = this.deps.logService as any
    return ls.getLogs(jobId, lines, offset)
  }

  async handleGetHealth(): Promise<{ healthy: number; warning: number; critical: number }> {
    const cm = this.deps.cronManager as any
    const jobs: CronJob[] = cm.jobCache.size > 0
      ? Array.from(cm.jobCache.values())
      : await cm.discoverAllJobs()
    const counts = { healthy: 0, warning: 0, critical: 0 }
    for (const job of jobs) {
      if (job.health === 'healthy') counts.healthy++
      else if (job.health === 'warning') counts.warning++
      else if (job.health === 'critical') counts.critical++
    }
    return counts
  }

  async handleGetFailingJobs(): Promise<CronJob[]> {
    const cm = this.deps.cronManager as any
    const jobs: CronJob[] = cm.jobCache.size > 0
      ? Array.from(cm.jobCache.values())
      : await cm.discoverAllJobs()
    return jobs.filter((j: CronJob) => j.health === 'warning' || j.health === 'critical')
  }

  async handleGetScheduleConflicts(): Promise<ScheduleConflict[]> {
    const cm = this.deps.cronManager as any
    const jobs: CronJob[] = cm.jobCache.size > 0
      ? Array.from(cm.jobCache.values())
      : await cm.discoverAllJobs()

    // Group jobs by schedule
    const bySchedule = new Map<string, CronJob[]>()
    for (const job of jobs) {
      const group = bySchedule.get(job.schedule) ?? []
      group.push(job)
      bySchedule.set(job.schedule, group)
    }

    const conflicts: ScheduleConflict[] = []
    for (const [schedule, group] of bySchedule) {
      if (group.length > 1) {
        conflicts.push({
          jobIds: group.map(j => j.id),
          schedule,
          description: `${group.length} jobs share schedule "${schedule}"`,
        })
      }
    }
    return conflicts
  }

  async handleGetScheduleLoad(): Promise<ScheduleLoadAnalysis> {
    const cm = this.deps.cronManager as any
    const jobs: CronJob[] = cm.jobCache.size > 0
      ? Array.from(cm.jobCache.values())
      : await cm.discoverAllJobs()

    // Parse cron schedules to estimate hourly load
    const hourlyLoad: Record<number, number> = {}
    for (let h = 0; h < 24; h++) hourlyLoad[h] = 0

    for (const job of jobs) {
      const parts = job.schedule.split(/\s+/)
      const hourPart = parts[1]

      if (hourPart === '*') {
        // Runs every hour
        for (let h = 0; h < 24; h++) hourlyLoad[h]++
      } else if (/^\d+$/.test(hourPart)) {
        hourlyLoad[parseInt(hourPart, 10)]++
      } else if (hourPart.includes(',')) {
        for (const h of hourPart.split(',')) {
          const num = parseInt(h, 10)
          if (!isNaN(num) && num >= 0 && num < 24) hourlyLoad[num]++
        }
      } else if (hourPart.startsWith('*/')) {
        const interval = parseInt(hourPart.slice(2), 10)
        if (interval > 0) {
          for (let h = 0; h < 24; h += interval) hourlyLoad[h]++
        }
      }
    }

    // Find peak hours (above average)
    const values = Object.values(hourlyLoad)
    const avg = values.reduce((a, b) => a + b, 0) / 24
    const peakHours = Object.entries(hourlyLoad)
      .filter(([_, count]) => count > avg && count > 0)
      .map(([hour]) => parseInt(hour, 10))

    const recommendations: string[] = []
    if (peakHours.length > 0) {
      recommendations.push(`Consider spreading load from peak hours: ${peakHours.join(', ')}`)
    }

    return { hourlyLoad, peakHours, recommendations }
  }

  async handleGetDurationTrends(jobId: string): Promise<DurationTrendData> {
    const hs = this.deps.historyService as any
    const durations: number[] = await hs.getRecentDurations(jobId, 20)
    const average = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0

    // Determine trend by comparing first and second halves
    let trend = 'stable'
    if (durations.length >= 4) {
      const mid = Math.floor(durations.length / 2)
      const firstHalf = durations.slice(0, mid)
      const secondHalf = durations.slice(mid)
      const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length
      const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length
      const threshold = firstAvg * 0.1 // 10% change threshold
      if (secondAvg > firstAvg + threshold) trend = 'increasing'
      else if (secondAvg < firstAvg - threshold) trend = 'decreasing'
    }

    return { jobId, durations, average, trend }
  }

  async handleGetContext(): Promise<UiContext | null> {
    return this.getContext()
  }

  async handleGetSessions(): Promise<Session[]> {
    const sm = this.deps.sessionManager as any
    const sessions: Session[] = sm.listWindows()
    return sessions.filter((s: Session) => !this.isAiSession(s.name))
  }

  async handlePostProposal(payload: Record<string, unknown>): Promise<ProposalResult> {
    return this.createProposal({
      operation: payload.operation as CronAiProposalOperation,
      jobId: payload.jobId as string | null | undefined,
      description: payload.description as string,
      diff: (payload.diff as string) ?? '',
      details: payload.details as Record<string, unknown> | undefined,
    })
  }

  async handleGetAiHealth(): Promise<{ status: 'ok'; mcpConnected: boolean; pendingProposals: number }> {
    return {
      status: 'ok',
      mcpConnected: this.mcpWs !== null,
      pendingProposals: this.getPendingProposals().length,
    }
  }

  // ── Auth Middleware ───────────────────────────────────────────────────────

  /** Validate auth header. Returns true if no token configured or valid Bearer token. */
  validateAuth(authHeader?: string): boolean {
    if (!this.config.authToken) return true
    if (!authHeader) return false
    const parts = authHeader.split(' ')
    if (parts.length !== 2 || parts[0] !== 'Bearer') return false
    const token = parts[1]
    if (!token) return false
    return token === this.config.authToken
  }

  // ── Config Generation ────────────────────────────────────────────────────

  /** Write MCP config JSON to ~/.agentboard/mcp/cron-manager.json (0600 perms) */
  async generateMcpConfig(port: number): Promise<void> {
    const home = process.env.HOME ?? homedir()
    const mcpDir = join(home, '.agentboard', 'mcp')
    await mkdir(mcpDir, { recursive: true })

    const config: Record<string, unknown> = {
      mcpServers: {
        'cron-manager': {
          url: `http://localhost:${port}/api/cron-ai`,
          ws: `ws://localhost:${port}/ws/cron-ai`,
        },
      },
    }

    if (this.config.authToken) {
      (config.mcpServers as any)['cron-manager'].authToken = this.config.authToken
    }

    const configPath = join(mcpDir, 'cron-manager.json')
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
    await chmod(configPath, 0o600)
  }

  /** Write skill file to ~/.agentboard/skills/cron-manager.md */
  async generateSkillFile(): Promise<void> {
    const home = process.env.HOME ?? homedir()
    const skillsDir = join(home, '.agentboard', 'skills')
    await mkdir(skillsDir, { recursive: true })

    const content = `# Cron Manager AI Skill

## Role

You are a cron job management assistant. You help users monitor, diagnose, and manage
their cron jobs and systemd timers through the agentboard interface.

## Available Tools

- get_jobs: List all cron jobs with optional group filter
- get_job_detail: Get detailed information about a specific job
- get_job_history: View run history for a job
- get_job_logs: View recent log output for a job
- get_health: Get health summary across all jobs
- get_failing_jobs: List jobs with warning or critical health status
- get_schedule_conflicts: Find overlapping schedules
- get_schedule_load: Analyze hourly schedule density
- get_duration_trends: View duration trends for a job
- propose_change: Submit a change proposal for user approval
- get_context: Get current UI context (what the user is looking at)

## Approval Workflow

All mutations MUST go through the proposal system. Never execute direct mutations.
Use the propose_change tool to submit proposals. Each proposal includes:
- Operation type (create, edit_frequency, pause, resume, delete, run_now, set_tags)
- A human-readable description of the change
- A diff showing what will change

The user will review and approve or reject each proposal in the UI.

## Safety Guidelines

- Never store or log sudo credentials
- Always validate job existence before proposing changes
- Provide clear descriptions of what each change will do
- Warn about potentially dangerous operations (delete, schedule changes)
- Do not propose multiple changes simultaneously — submit one proposal at a time

## Proactive Behaviors

- On startup, check health status and greet the user with a summary
- If failing jobs are detected, proactively suggest diagnosis steps
- Monitor for schedule conflicts and suggest optimizations
- Track duration trends and warn about degrading performance

## Greeting Protocol

When first activated, perform a health check and greet the user with:
- Overall health summary (healthy/warning/critical counts)
- Any immediate issues requiring attention
- This is a one-time greeting per session — do not repeat

## Proposal Rules

- Submit one proposal at a time — wait for resolution before submitting another
- Include context about why the change is recommended
- If the user asks clarifying questions, answer before proposing
`

    const skillPath = join(skillsDir, 'cron-manager.md')
    await writeFile(skillPath, content, 'utf-8')
  }

  // ── Session Lifecycle (WU-013 completes implementation) ──────────────────

  /** Create AI tmux window with Claude Code startup command */
  async createAiSession(): Promise<{ sessionId: string; tmuxTarget: string }> {
    const sm = this.deps.sessionManager as any
    const session = sm.createWindow('.', 'agentboard-cron-ai')

    // Build job summary for the initial prompt (single line — tmux send-keys
    // treats literal newlines as Enter keypresses, which would break the prompt)
    let jobSummary = '(no jobs found)'
    try {
      const cm = this.deps.cronManager as any
      const jobs: CronJob[] = cm.jobCache.size > 0
        ? Array.from(cm.jobCache.values())
        : await cm.discoverAllJobs()
      if (jobs.length > 0) {
        jobSummary = jobs
          .map((j: CronJob) => `${j.name}[${j.schedule}]=${j.health ?? 'unknown'}`)
          .join(', ')
      }
    } catch (err) {
      console.error('[cron-ai] Failed to build job summary:', err)
    }

    // Inline role description instead of /skill cron-manager (not a valid Claude Code slash command).
    // Keep to a single line — no literal newlines since tmux send-keys would interpret them as Enter.
    // Avoid special shell characters ($, backticks) that tmux might expand.
    const initialPrompt =
      `You are a cron job management AI assistant. ` +
      `Tools available via MCP: get_jobs, get_job_detail, get_job_history, get_job_logs, ` +
      `get_health, get_failing_jobs, get_schedule_conflicts, get_schedule_load, ` +
      `get_duration_trends, propose_change, get_context. ` +
      `All mutations MUST use propose_change for user approval — never mutate directly. ` +
      `On startup: check health and greet the user with a summary of healthy/warning/critical counts and any issues. ` +
      `Current cron jobs: ${jobSummary}`

    // Send the initial prompt after a short delay so claude has time to start
    setTimeout(() => {
      try {
        tmuxSendKeys(session.tmuxWindow, initialPrompt)
      } catch (err) {
        console.error('[cron-ai] Failed to send initial prompt:', err)
      }
    }, 2000)

    return { sessionId: session.id, tmuxTarget: session.tmuxWindow }
  }

  /** Kill the AI tmux window */
  async killAiSession(): Promise<void> {
    const sm = this.deps.sessionManager as any
    sm.killWindow('agentboard-cron-ai')
  }

  /** Get current AI session status */
  getAiSessionStatus(): 'offline' | 'starting' | 'working' | 'waiting' {
    const sm = this.deps.sessionManager as any
    const sessions: Session[] = sm.listWindows()
    const exists = sessions.some((s) => s.name === 'agentboard-cron-ai' || s.tmuxWindow?.includes('agentboard-cron-ai'))
    return exists ? 'waiting' : 'offline'
  }

  /** Check if a session name is an internal AI session (for filtering) */
  isAiSession(name: string): boolean {
    return name.startsWith('agentboard-cron-ai')
  }
}
