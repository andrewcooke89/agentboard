// WU-007: WebSocket Handlers & Server Wiring

import type { ServerWebSocket } from 'bun'
import type { ServerContext } from '../serverContext'
import type { WSData } from '../serverContext'
import { CronManager } from '../cronManager'
import { CronHistoryService } from '../cronHistoryService'
import { CronLogService } from '../cronLogService'
import { upsertJobPrefs, getJobPrefs } from '../db'
import type { CronJob, CronJobDetail, CronCreateConfig, SystemdCreateConfig } from '../../shared/types'

// ─── CronHandlers ────────────────────────────────────────────────────────────

export interface CronHandlers {
  handleCronJobSelect: (ws: ServerWebSocket<WSData>, jobId: string) => Promise<void>
  handleCronJobRunNow: (ws: ServerWebSocket<WSData>, jobId: string) => Promise<void>
  handleCronJobPause: (ws: ServerWebSocket<WSData>, jobId: string) => Promise<void>
  handleCronJobResume: (ws: ServerWebSocket<WSData>, jobId: string) => Promise<void>
  handleCronJobEditFrequency: (ws: ServerWebSocket<WSData>, jobId: string, newSchedule: string) => Promise<void>
  handleCronJobDelete: (ws: ServerWebSocket<WSData>, jobId: string) => Promise<void>
  handleCronJobCreate: (ws: ServerWebSocket<WSData>, mode: 'cron' | 'systemd', config: unknown) => Promise<void>
  handleCronBulkPause: (ws: ServerWebSocket<WSData>, jobIds: string[]) => Promise<void>
  handleCronBulkResume: (ws: ServerWebSocket<WSData>, jobIds: string[]) => Promise<void>
  handleCronBulkDelete: (ws: ServerWebSocket<WSData>, jobIds: string[]) => Promise<void>
  handleCronJobSetTags: (ws: ServerWebSocket<WSData>, jobId: string, tags: string[]) => Promise<void>
  handleCronJobSetManaged: (ws: ServerWebSocket<WSData>, jobId: string, managed: boolean) => Promise<void>
  handleCronJobLinkSession: (ws: ServerWebSocket<WSData>, jobId: string, sessionId: string | null) => Promise<void>
  handleCronSudoAuth: (ws: ServerWebSocket<WSData>, sudoCredential: string) => Promise<void>
  handleCronJobLogs: (ws: ServerWebSocket<WSData>, jobId: string, lines: number) => Promise<void>
  handleCronJobHistory: (ws: ServerWebSocket<WSData>, jobId: string, limit: number, before?: string) => Promise<void>
  /** Called on each WS open: send full job list + increment client count */
  onClientConnect: (ws: ServerWebSocket<WSData>) => void
  /** Called on each WS close: decrement client count, stop polling if zero */
  onClientDisconnect: (ws: ServerWebSocket<WSData>) => void
}

// ─── Script language detection ────────────────────────────────────────────────

function detectScriptLanguage(scriptPath: string | null): string | null {
  if (!scriptPath) return null
  const ext = scriptPath.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'py': return 'python'
    case 'sh':
    case 'bash': return 'bash'
    case 'js': return 'javascript'
    case 'ts': return 'typescript'
    case 'rb': return 'ruby'
    case 'pl': return 'perl'
    default: return null
  }
}

/**
 * Factory function that creates all cron WS handlers.
 * Manages polling lifecycle: start on first client, pause on zero clients.
 * Registers onJobsChanged to broadcast diffs to all connected clients.
 */
export function createCronHandlers(
  ctx: ServerContext,
  cronManager: CronManager,
  historyService: CronHistoryService,
  logService: CronLogService
): CronHandlers {
  let clientCount = 0
  let pollingStarted = false
  const activeManualRuns = new Set<string>()

  // Register the onJobsChanged callback once at creation time
  cronManager.onJobsChanged((added, removed, updated) => {
    // Enrich added/updated jobs with health data asynchronously
    ;(async () => {
      const enrichedAdded = await enrichJobsWithHealth(added)
      for (const job of enrichedAdded) {
        cronManager.jobCache.set(job.id, job)
        ctx.broadcast({ type: 'cron-job-update', job })
      }
      for (const jobId of removed) {
        ctx.broadcast({ type: 'cron-job-removed', jobId })
      }
      const enrichedUpdated = await enrichJobsWithHealth(updated)
      for (const job of enrichedUpdated) {
        cronManager.jobCache.set(job.id, job)
        ctx.broadcast({ type: 'cron-job-update', job })
      }
    })().catch((err: unknown) => {
      console.error('[CronHandlers] enrichJobsWithHealth error in onJobsChanged:', err)
    })
  })

  // ─── Polling lifecycle ────────────────────────────────────────────────────

  /** Enrich jobs with health status, avgDuration, and lastRunDuration from run history */
  async function enrichJobsWithHealth(jobs: CronJob[]): Promise<CronJob[]> {
    const enriched: CronJob[] = []
    for (const job of jobs) {
      const history = await historyService.getRunHistory(job.id, 20)
      const { health, reason } = cronManager.computeHealth(job, history)
      const durations = await historyService.getRecentDurations(job.id, 10)
      const avgDuration = durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : null
      const lastRunDuration = history.length > 0 ? (history[0].duration ?? null) : null
      const lastRun = history.length > 0 ? history[0].timestamp : job.lastRun
      const lastExitCode = history.length > 0 ? (history[0].exitCode ?? null) : job.lastExitCode
      let consecutiveFailures = 0
      for (const record of history) {
        if (record.exitCode !== 0) consecutiveFailures++
        else break
      }
      enriched.push({
        ...job,
        health,
        healthReason: reason,
        avgDuration,
        lastRunDuration,
        lastRun,
        lastExitCode,
        consecutiveFailures,
      })
    }
    return enriched
  }

  async function startPollingLifecycle(): Promise<void> {
    cronManager.setDb(ctx.db.db)
    const jobs = await cronManager.discoverAllJobs()
    const enrichedJobs = await enrichJobsWithHealth(jobs)
    // Update cache with enriched data
    for (const job of enrichedJobs) {
      cronManager.jobCache.set(job.id, job)
    }
    ctx.broadcast({
      type: 'cron-jobs',
      jobs: enrichedJobs,
      systemdAvailable: cronManager.systemdAvailable,
    })
    cronManager.startPolling(5000)
    pollingStarted = true
  }

  async function triggerRediscovery(): Promise<void> {
    const jobs = await cronManager.discoverAllJobs()
    const enrichedJobs = await enrichJobsWithHealth(jobs)
    for (const job of enrichedJobs) {
      cronManager.jobCache.set(job.id, job)
    }
    ctx.broadcast({
      type: 'cron-jobs',
      jobs: enrichedJobs,
      systemdAvailable: cronManager.systemdAvailable,
    })
  }

  // ─── onClientConnect ──────────────────────────────────────────────────────

  function onClientConnect(ws: ServerWebSocket<WSData>): void {
    clientCount++

    if (!pollingStarted) {
      // First client — start polling lifecycle asynchronously
      startPollingLifecycle()
        .then(() => {
          // After initial discovery, send the now-populated cache to this client
          ctx.send(ws, {
            type: 'cron-jobs',
            jobs: [...cronManager.jobCache.values()],
            systemdAvailable: cronManager.systemdAvailable,
          })
        })
        .catch((err: unknown) => {
          console.error('[CronHandlers] startPollingLifecycle error:', err)
        })
    } else {
      // Subsequent client — send current cache immediately
      ctx.send(ws, {
        type: 'cron-jobs',
        jobs: [...cronManager.jobCache.values()],
        systemdAvailable: cronManager.systemdAvailable,
      })
    }
  }

  // ─── onClientDisconnect ───────────────────────────────────────────────────

  function onClientDisconnect(_ws: ServerWebSocket<WSData>): void {
    clientCount = Math.max(0, clientCount - 1)
    if (clientCount === 0) {
      cronManager.stopPolling()
      pollingStarted = false
    }
  }

  // ─── handleCronJobSelect ──────────────────────────────────────────────────

  async function handleCronJobSelect(ws: ServerWebSocket<WSData>, jobId: string): Promise<void> {
    const job = cronManager.jobCache.get(jobId)
    if (!job) {
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'select', success: false, error: 'Job not found' })
      return
    }

    // Script content
    let scriptContent: string | null = null
    if (job.scriptPath) {
      try {
        scriptContent = await Bun.file(job.scriptPath).text()
      } catch {
        scriptContent = null
      }
    }

    const scriptLanguage = detectScriptLanguage(job.scriptPath)

    // Systemd unit file contents
    let timerConfig: string | null = null
    let serviceConfig: string | null = null
    if (job.unitFile) {
      try {
        timerConfig = await Bun.file(job.unitFile).text()
      } catch {
        timerConfig = null
      }
      const servicePath = job.unitFile.replace(/\.timer$/, '.service')
      try {
        serviceConfig = await Bun.file(servicePath).text()
      } catch {
        serviceConfig = null
      }
    }

    // crontabLine only relevant for cron sources
    const crontabLine: string | null = null

    // Run history and logs
    const [runHistory, recentLogs] = await Promise.all([
      historyService.getRunHistory(jobId, 20),
      logService.getLogs(jobId, 100),
    ])

    // Merge DB prefs
    const prefs = getJobPrefs(ctx.db.db, jobId)

    const detail: CronJobDetail = {
      ...job,
      tags: prefs?.tags ?? job.tags,
      isManagedByAgentboard: prefs?.isManaged ?? job.isManagedByAgentboard,
      linkedSessionId: prefs?.linkedSessionId ?? job.linkedSessionId,
      scriptContent,
      scriptLanguage,
      timerConfig,
      serviceConfig,
      crontabLine,
      runHistory,
      recentLogs,
    }

    ctx.send(ws, { type: 'cron-job-detail', detail })
  }

  // ─── handleCronJobRunNow ──────────────────────────────────────────────────

  async function handleCronJobRunNow(ws: ServerWebSocket<WSData>, jobId: string): Promise<void> {
    // Concurrent-run guard: prevent duplicate manual runs of the same job
    if (activeManualRuns.has(jobId)) {
      ctx.send(ws, { type: 'error', message: `Job ${jobId} is already running` })
      return
    }
    activeManualRuns.add(jobId)

    const runId = Date.now().toString(36)
    const startTime = Date.now()
    const logChunks: string[] = []

    ctx.send(ws, { type: 'cron-run-started', jobId, runId })

    // Fire-and-forget: run the job without blocking the WS handler
    ;(async () => {
      let exitCode = 0
      try {
        for await (const chunk of cronManager.runJobNow(jobId)) {
          logChunks.push(chunk)
          ctx.send(ws, { type: 'cron-run-output', jobId, runId, chunk })
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('Sudo credential required')) {
          ctx.send(ws, { type: 'cron-sudo-required', jobId, operation: 'run-now' })
          return
        }
        ctx.send(ws, { type: 'cron-run-output', jobId, runId, chunk: `Error: ${msg}\n` })
        exitCode = 1
      } finally {
        activeManualRuns.delete(jobId)
      }

      const duration = Date.now() - startTime
      ctx.send(ws, { type: 'cron-run-completed', jobId, runId, exitCode, duration })

      // Record the manual run
      const timestamp = new Date(startTime).toISOString()
      const endTimestamp = new Date().toISOString()
      await historyService.recordManualRun(jobId, {
        timestamp,
        endTimestamp,
        duration,
        exitCode,
        logSnippet: logChunks.join('').slice(-500) || null,
      })
    })().catch((err: unknown) => {
      console.error('[CronHandlers] runJobNow background error:', err)
      activeManualRuns.delete(jobId)
    })
  }

  // ─── handleCronJobPause ───────────────────────────────────────────────────

  async function handleCronJobPause(ws: ServerWebSocket<WSData>, jobId: string): Promise<void> {
    try {
      await cronManager.pauseJob(jobId)
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'pause', success: true })
      await triggerRediscovery()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Sudo credential required')) {
        ctx.send(ws, { type: 'cron-sudo-required', jobId, operation: 'pause' })
        return
      }
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'pause', success: false, error: msg })
    }
  }

  // ─── handleCronJobResume ──────────────────────────────────────────────────

  async function handleCronJobResume(ws: ServerWebSocket<WSData>, jobId: string): Promise<void> {
    try {
      await cronManager.resumeJob(jobId)
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'resume', success: true })
      await triggerRediscovery()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Sudo credential required')) {
        ctx.send(ws, { type: 'cron-sudo-required', jobId, operation: 'resume' })
        return
      }
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'resume', success: false, error: msg })
    }
  }

  // ─── handleCronJobEditFrequency ───────────────────────────────────────────

  async function handleCronJobEditFrequency(ws: ServerWebSocket<WSData>, jobId: string, newSchedule: string): Promise<void> {
    try {
      await cronManager.editFrequency(jobId, newSchedule)
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'edit-frequency', success: true })
      await triggerRediscovery()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Sudo credential required')) {
        ctx.send(ws, { type: 'cron-sudo-required', jobId, operation: 'edit-frequency' })
        return
      }
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'edit-frequency', success: false, error: msg })
    }
  }

  // ─── handleCronJobDelete ──────────────────────────────────────────────────

  async function handleCronJobDelete(ws: ServerWebSocket<WSData>, jobId: string): Promise<void> {
    try {
      await cronManager.deleteJob(jobId)
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'delete', success: true })
      await triggerRediscovery()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Sudo credential required')) {
        ctx.send(ws, { type: 'cron-sudo-required', jobId, operation: 'delete' })
        return
      }
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'delete', success: false, error: msg })
    }
  }

  // ─── handleCronJobCreate ──────────────────────────────────────────────────

  async function handleCronJobCreate(ws: ServerWebSocket<WSData>, mode: 'cron' | 'systemd', config: unknown): Promise<void> {
    // Use a placeholder jobId for the result (real ID comes from cronManager)
    const placeholderJobId = ''
    try {
      if (mode === 'cron') {
        await cronManager.createCronJob(config as CronCreateConfig)
      } else {
        await cronManager.createSystemdTimer(config as SystemdCreateConfig)
      }
      ctx.send(ws, { type: 'cron-operation-result', jobId: placeholderJobId, operation: 'create', success: true })
      await triggerRediscovery()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Sudo credential required')) {
        ctx.send(ws, { type: 'cron-sudo-required', jobId: placeholderJobId, operation: 'create' })
        return
      }
      ctx.send(ws, { type: 'cron-operation-result', jobId: placeholderJobId, operation: 'create', success: false, error: msg })
    }
  }

  // ─── handleCronBulkPause ─────────────────────────────────────────────────

  async function handleCronBulkPause(ws: ServerWebSocket<WSData>, jobIds: string[]): Promise<void> {
    for await (const progress of cronManager.bulkPause(jobIds)) {
      ctx.send(ws, {
        type: 'cron-bulk-operation-progress',
        completed: progress.completed,
        total: progress.total,
        failures: progress.failures,
      })
    }
    await triggerRediscovery()
  }

  // ─── handleCronBulkResume ─────────────────────────────────────────────────

  async function handleCronBulkResume(ws: ServerWebSocket<WSData>, jobIds: string[]): Promise<void> {
    for await (const progress of cronManager.bulkResume(jobIds)) {
      ctx.send(ws, {
        type: 'cron-bulk-operation-progress',
        completed: progress.completed,
        total: progress.total,
        failures: progress.failures,
      })
    }
    await triggerRediscovery()
  }

  // ─── handleCronBulkDelete ─────────────────────────────────────────────────

  async function handleCronBulkDelete(ws: ServerWebSocket<WSData>, jobIds: string[]): Promise<void> {
    for await (const progress of cronManager.bulkDelete(jobIds)) {
      ctx.send(ws, {
        type: 'cron-bulk-operation-progress',
        completed: progress.completed,
        total: progress.total,
        failures: progress.failures,
      })
    }
    await triggerRediscovery()
  }

  // ─── handleCronJobSetTags ─────────────────────────────────────────────────

  async function handleCronJobSetTags(ws: ServerWebSocket<WSData>, jobId: string, tags: string[]): Promise<void> {
    upsertJobPrefs(ctx.db.db, jobId, { tags })
    const cached = cronManager.jobCache.get(jobId)
    if (cached) {
      const updated: CronJob = { ...cached, tags }
      cronManager.jobCache.set(jobId, updated)
      ctx.broadcast({ type: 'cron-job-update', job: updated })
    }
  }

  // ─── handleCronJobSetManaged ──────────────────────────────────────────────

  async function handleCronJobSetManaged(ws: ServerWebSocket<WSData>, jobId: string, managed: boolean): Promise<void> {
    upsertJobPrefs(ctx.db.db, jobId, { isManaged: managed })
    const cached = cronManager.jobCache.get(jobId)
    if (cached) {
      const updated: CronJob = { ...cached, isManagedByAgentboard: managed }
      cronManager.jobCache.set(jobId, updated)
      ctx.broadcast({ type: 'cron-job-update', job: updated })
    }
  }

  // ─── handleCronJobLinkSession ─────────────────────────────────────────────

  async function handleCronJobLinkSession(ws: ServerWebSocket<WSData>, jobId: string, sessionId: string | null): Promise<void> {
    upsertJobPrefs(ctx.db.db, jobId, { linkedSessionId: sessionId })
    const cached = cronManager.jobCache.get(jobId)
    if (cached) {
      const updated: CronJob = { ...cached, linkedSessionId: sessionId }
      cronManager.jobCache.set(jobId, updated)
      ctx.broadcast({ type: 'cron-job-update', job: updated })
    }
  }

  // ─── handleCronSudoAuth ───────────────────────────────────────────────────

  async function handleCronSudoAuth(ws: ServerWebSocket<WSData>, sudoCredential: string): Promise<void> {
    const credential = new TextEncoder().encode(sudoCredential)
    cronManager.cacheSudoCredential(credential, 15 * 60 * 1000)
    ctx.send(ws, { type: 'cron-operation-result', jobId: '', operation: 'sudo-auth', success: true })
  }

  // ─── handleCronJobLogs ────────────────────────────────────────────────────

  async function handleCronJobLogs(ws: ServerWebSocket<WSData>, jobId: string, lines: number): Promise<void> {
    const job = cronManager.jobCache.get(jobId)
    if (!job) return

    const recentLogs = await logService.getLogs(jobId, lines)

    // Build a minimal detail update with the refreshed logs
    const prefs = getJobPrefs(ctx.db.db, jobId)
    const [runHistory] = await Promise.all([historyService.getRunHistory(jobId, 20)])

    let scriptContent: string | null = null
    if (job.scriptPath) {
      try { scriptContent = await Bun.file(job.scriptPath).text() } catch { /* ignore */ }
    }
    let timerConfig: string | null = null
    let serviceConfig: string | null = null
    if (job.unitFile) {
      try { timerConfig = await Bun.file(job.unitFile).text() } catch { /* ignore */ }
      try { serviceConfig = await Bun.file(job.unitFile.replace(/\.timer$/, '.service')).text() } catch { /* ignore */ }
    }

    const detail: CronJobDetail = {
      ...job,
      tags: prefs?.tags ?? job.tags,
      isManagedByAgentboard: prefs?.isManaged ?? job.isManagedByAgentboard,
      linkedSessionId: prefs?.linkedSessionId ?? job.linkedSessionId,
      scriptContent,
      scriptLanguage: detectScriptLanguage(job.scriptPath),
      timerConfig,
      serviceConfig,
      crontabLine: null,
      runHistory,
      recentLogs,
    }

    ctx.send(ws, { type: 'cron-job-detail', detail })
  }

  // ─── handleCronJobHistory ─────────────────────────────────────────────────

  async function handleCronJobHistory(ws: ServerWebSocket<WSData>, jobId: string, limit: number, before?: string): Promise<void> {
    const job = cronManager.jobCache.get(jobId)
    if (!job) return

    const runHistory = await historyService.getRunHistory(jobId, limit, before)

    const prefs = getJobPrefs(ctx.db.db, jobId)
    const recentLogs = await logService.getLogs(jobId, 100)

    let scriptContent: string | null = null
    if (job.scriptPath) {
      try { scriptContent = await Bun.file(job.scriptPath).text() } catch { /* ignore */ }
    }
    let timerConfig: string | null = null
    let serviceConfig: string | null = null
    if (job.unitFile) {
      try { timerConfig = await Bun.file(job.unitFile).text() } catch { /* ignore */ }
      try { serviceConfig = await Bun.file(job.unitFile.replace(/\.timer$/, '.service')).text() } catch { /* ignore */ }
    }

    const detail: CronJobDetail = {
      ...job,
      tags: prefs?.tags ?? job.tags,
      isManagedByAgentboard: prefs?.isManaged ?? job.isManagedByAgentboard,
      linkedSessionId: prefs?.linkedSessionId ?? job.linkedSessionId,
      scriptContent,
      scriptLanguage: detectScriptLanguage(job.scriptPath),
      timerConfig,
      serviceConfig,
      crontabLine: null,
      runHistory,
      recentLogs,
    }

    ctx.send(ws, { type: 'cron-job-detail', detail })
  }

  // ─── Return the CronHandlers object ──────────────────────────────────────

  return {
    handleCronJobSelect,
    handleCronJobRunNow,
    handleCronJobPause,
    handleCronJobResume,
    handleCronJobEditFrequency,
    handleCronJobDelete,
    handleCronJobCreate,
    handleCronBulkPause,
    handleCronBulkResume,
    handleCronBulkDelete,
    handleCronJobSetTags,
    handleCronJobSetManaged,
    handleCronJobLinkSession,
    handleCronSudoAuth,
    handleCronJobLogs,
    handleCronJobHistory,
    onClientConnect,
    onClientDisconnect,
  }
}
