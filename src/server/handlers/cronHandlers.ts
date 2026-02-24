// cronHandlers.ts — WebSocket handlers for cron manager messages
// WU-007: WebSocket Handlers & Server Wiring
//
// Factory function following the createXxxHandlers(ctx) pattern.
// Handles all cron-* WS messages, broadcasts diffs to all clients,
// tracks client count for polling lifecycle management.

import { readFile } from 'fs/promises'
import type { ServerWebSocket } from 'bun'
import type { ServerContext, WSData } from '../serverContext'
import type { CronManager } from '../cronManager'
import type { CronHistoryService } from '../cronHistoryService'
import type { CronLogService } from '../cronLogService'
import type { CronPrefsStore } from '../db'
import type { ClientMessage, CronJob, CronJobDetail } from '../../shared/types'
import { logger } from '../logger'

export interface CronHandlerDeps {
  cronManager: CronManager
  historyService: CronHistoryService
  logService: CronLogService
  prefsStore: CronPrefsStore
}

const POLL_INTERVAL_MS = 5_000
const SUDO_GRACE_PERIOD_MS = 300_000 // 5 minutes

export function createCronHandlers(ctx: ServerContext, deps: CronHandlerDeps) {
  const { cronManager, historyService, logService, prefsStore } = deps

  let clientCount = 0

  // Per-connection sudo credentials: connectionId → { credential, clearTimer }
  const sudoCache = new Map<string, { credential: Uint8Array; clearTimer: ReturnType<typeof setTimeout> }>()

  // ── Polling lifecycle ──────────────────────────────────────────────────────

  // Register diff callback once — broadcasts job adds/updates/removes to all clients
  cronManager.onJobsChanged((diff) => {
    for (const job of diff.added) {
      ctx.broadcast({ type: 'cron-job-update', job })
    }
    for (const job of diff.updated) {
      ctx.broadcast({ type: 'cron-job-update', job })
    }
    for (const jobId of diff.removed) {
      ctx.broadcast({ type: 'cron-job-removed', jobId })
    }
  })

  function onClientConnected(ws: ServerWebSocket<WSData>): void {
    clientCount++
    if (clientCount === 1) {
      // First client: start polling (fires first tick immediately, then sends list)
      cronManager.startPolling(POLL_INTERVAL_MS)
    }
    // Send current snapshot to this client (may be empty before first poll tick completes)
    ctx.send(ws, {
      type: 'cron-jobs',
      jobs: cronManager.getAllJobs(),
      systemdAvailable: cronManager.isSystemdAvailable,
    })
  }

  function onClientDisconnected(ws: ServerWebSocket<WSData>): void {
    clientCount = Math.max(0, clientCount - 1)
    if (clientCount === 0) {
      cronManager.stopPolling()
    }
    // Zero out and remove any cached credential for this connection
    const entry = sudoCache.get(ws.data.connectionId)
    if (entry) {
      clearTimeout(entry.clearTimer)
      entry.credential.fill(0)
      sudoCache.delete(ws.data.connectionId)
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  function getSudoCredential(connectionId: string): Uint8Array | undefined {
    return sudoCache.get(connectionId)?.credential
  }

  // ── Message handlers ───────────────────────────────────────────────────────

  /** cron-job-select: send full detail for the selected job */
  async function handleCronJobSelect(
    ws: ServerWebSocket<WSData>,
    msg: Extract<ClientMessage, { type: 'cron-job-select' }>,
  ): Promise<void> {
    const job = cronManager.getAllJobs().find(j => j.id === msg.jobId)
    if (!job) {
      ctx.send(ws, { type: 'error', message: `Cron job not found: ${msg.jobId}` })
      return
    }

    const [runHistory, logEntries] = await Promise.all([
      historyService.getRunHistory(msg.jobId, 50),
      logService.getLogs(msg.jobId, 50),
    ])

    let scriptContent: string | undefined
    if (job.scriptPath) {
      try {
        scriptContent = await readFile(job.scriptPath, 'utf8')
      } catch {
        // Not readable — leave undefined
      }
    }

    const detail: CronJobDetail = {
      ...job,
      scriptContent,
      runHistory,
      recentLogs: logEntries.map(e => e.line),
    }

    ctx.send(ws, { type: 'cron-job-detail', job: detail })
  }

  /** cron-job-run-now: run the job and stream output lines */
  async function handleCronRunNow(
    ws: ServerWebSocket<WSData>,
    msg: Extract<ClientMessage, { type: 'cron-job-run-now' }>,
  ): Promise<void> {
    const { jobId } = msg
    const credential = getSudoCredential(ws.data.connectionId)
    const runId = `run-${jobId}-${Date.now()}`
    const startMs = Date.now()

    ctx.send(ws, { type: 'cron-run-started', jobId, runId })

    let exitCode = 0
    const outputLines: string[] = []

    try {
      for await (const line of cronManager.runJobNow(jobId, credential)) {
        outputLines.push(line)
        ctx.send(ws, { type: 'cron-run-output', jobId, runId, data: line })
      }
    } catch (err) {
      exitCode = 1
      const errMsg = err instanceof Error ? err.message : String(err)
      ctx.send(ws, { type: 'cron-run-output', jobId, runId, data: `Error: ${errMsg}` })
    }

    const duration = Date.now() - startMs
    ctx.send(ws, { type: 'cron-run-completed', jobId, runId, exitCode, duration })

    try {
      historyService.recordManualRun(jobId, {
        exitCode,
        duration,
        output: outputLines.join('\n'),
        trigger: 'manual',
      })
    } catch (err) {
      logger.warn('cronHandlers: failed to record manual run', { err, jobId })
    }
  }

  /** cron-job-pause */
  async function handleCronPause(
    ws: ServerWebSocket<WSData>,
    msg: Extract<ClientMessage, { type: 'cron-job-pause' }>,
  ): Promise<void> {
    const { jobId } = msg
    const credential = getSudoCredential(ws.data.connectionId)
    try {
      await cronManager.pauseJob(jobId, credential)
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'pause', ok: true })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'pause', ok: false, error })
    }
  }

  /** cron-job-resume */
  async function handleCronResume(
    ws: ServerWebSocket<WSData>,
    msg: Extract<ClientMessage, { type: 'cron-job-resume' }>,
  ): Promise<void> {
    const { jobId } = msg
    const credential = getSudoCredential(ws.data.connectionId)
    try {
      await cronManager.resumeJob(jobId, credential)
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'resume', ok: true })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'resume', ok: false, error })
    }
  }

  /** cron-job-edit-frequency */
  async function handleCronEditFrequency(
    ws: ServerWebSocket<WSData>,
    msg: Extract<ClientMessage, { type: 'cron-job-edit-frequency' }>,
  ): Promise<void> {
    const { jobId, schedule } = msg
    const credential = getSudoCredential(ws.data.connectionId)
    try {
      await cronManager.editFrequency(jobId, schedule, credential)
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'edit-frequency', ok: true })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'edit-frequency', ok: false, error })
    }
  }

  /** cron-job-delete */
  async function handleCronDelete(
    ws: ServerWebSocket<WSData>,
    msg: Extract<ClientMessage, { type: 'cron-job-delete' }>,
  ): Promise<void> {
    const { jobId } = msg
    const credential = getSudoCredential(ws.data.connectionId)
    try {
      await cronManager.deleteJob(jobId, credential)
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'delete', ok: true })
      ctx.broadcast({ type: 'cron-job-removed', jobId })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'delete', ok: false, error })
    }
  }

  /** cron-job-create */
  async function handleCronCreate(
    ws: ServerWebSocket<WSData>,
    msg: Extract<ClientMessage, { type: 'cron-job-create' }>,
  ): Promise<void> {
    try {
      let newJob: CronJob
      if (msg.mode === 'cron') {
        newJob = await cronManager.createCronJob(msg.config as import('../../shared/types').CronCreateConfig)
      } else {
        newJob = await cronManager.createSystemdTimer(msg.config as import('../../shared/types').SystemdCreateConfig)
      }
      ctx.send(ws, { type: 'cron-operation-result', jobId: newJob.id, operation: 'create', ok: true })
      ctx.broadcast({ type: 'cron-job-update', job: newJob })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      ctx.send(ws, { type: 'cron-operation-result', jobId: '', operation: 'create', ok: false, error })
    }
  }

  /** cron-bulk-pause */
  async function handleCronBulkPause(
    ws: ServerWebSocket<WSData>,
    msg: Extract<ClientMessage, { type: 'cron-bulk-pause' }>,
  ): Promise<void> {
    const credential = getSudoCredential(ws.data.connectionId)
    try {
      for await (const progress of cronManager.bulkPause(msg.jobIds, credential)) {
        ctx.send(ws, { type: 'cron-bulk-operation-progress', operation: 'pause', progress })
      }
    } catch (err) {
      logger.warn('cronHandlers: bulkPause error', { err })
    }
  }

  /** cron-bulk-resume */
  async function handleCronBulkResume(
    ws: ServerWebSocket<WSData>,
    msg: Extract<ClientMessage, { type: 'cron-bulk-resume' }>,
  ): Promise<void> {
    const credential = getSudoCredential(ws.data.connectionId)
    try {
      for await (const progress of cronManager.bulkResume(msg.jobIds, credential)) {
        ctx.send(ws, { type: 'cron-bulk-operation-progress', operation: 'resume', progress })
      }
    } catch (err) {
      logger.warn('cronHandlers: bulkResume error', { err })
    }
  }

  /** cron-bulk-delete */
  async function handleCronBulkDelete(
    ws: ServerWebSocket<WSData>,
    msg: Extract<ClientMessage, { type: 'cron-bulk-delete' }>,
  ): Promise<void> {
    const credential = getSudoCredential(ws.data.connectionId)
    try {
      for await (const progress of cronManager.bulkDelete(msg.jobIds, credential)) {
        ctx.send(ws, { type: 'cron-bulk-operation-progress', operation: 'delete', progress })
      }
    } catch (err) {
      logger.warn('cronHandlers: bulkDelete error', { err })
    }
  }

  /** cron-job-history: send run history wrapped in cron-job-detail */
  async function handleCronHistory(
    ws: ServerWebSocket<WSData>,
    msg: Extract<ClientMessage, { type: 'cron-job-history' }>,
  ): Promise<void> {
    const job = cronManager.getAllJobs().find(j => j.id === msg.jobId)
    if (!job) {
      ctx.send(ws, { type: 'error', message: `Cron job not found: ${msg.jobId}` })
      return
    }
    try {
      const runHistory = await historyService.getRunHistory(msg.jobId, msg.limit ?? 50)
      const detail: CronJobDetail = { ...job, runHistory, recentLogs: [] }
      ctx.send(ws, { type: 'cron-job-detail', job: detail })
    } catch (err) {
      logger.warn('cronHandlers: getRunHistory error', { err, jobId: msg.jobId })
    }
  }

  /** cron-job-logs: send log lines wrapped in cron-job-detail */
  async function handleCronLogs(
    ws: ServerWebSocket<WSData>,
    msg: Extract<ClientMessage, { type: 'cron-job-logs' }>,
  ): Promise<void> {
    const job = cronManager.getAllJobs().find(j => j.id === msg.jobId)
    if (!job) {
      ctx.send(ws, { type: 'error', message: `Cron job not found: ${msg.jobId}` })
      return
    }
    try {
      const logEntries = await logService.getLogs(msg.jobId, msg.lines ?? 100)
      const detail: CronJobDetail = {
        ...job,
        runHistory: [],
        recentLogs: logEntries.map(e => e.line),
      }
      ctx.send(ws, { type: 'cron-job-detail', job: detail })
    } catch (err) {
      logger.warn('cronHandlers: getLogs error', { err, jobId: msg.jobId })
    }
  }

  /** cron-sudo-auth: cache credential as Uint8Array, warn if not TLS (REQ-84) */
  function handleCronSudoAuth(
    ws: ServerWebSocket<WSData>,
    msg: Extract<ClientMessage, { type: 'cron-sudo-auth' }>,
    isTls: boolean,
  ): void {
    if (!isTls) {
      logger.warn('cronHandlers: sudo credential received over plain WS (REQ-84)', {
        connectionId: ws.data.connectionId,
      })
    }

    const buf = Buffer.from(msg.sudoCredential, 'base64')
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)

    const existing = sudoCache.get(ws.data.connectionId)
    if (existing) {
      clearTimeout(existing.clearTimer)
      existing.credential.fill(0)
    }

    const clearTimer = setTimeout(() => {
      const entry = sudoCache.get(ws.data.connectionId)
      if (entry) {
        entry.credential.fill(0)
        sudoCache.delete(ws.data.connectionId)
      }
    }, SUDO_GRACE_PERIOD_MS)

    sudoCache.set(ws.data.connectionId, { credential: bytes, clearTimer })
  }

  /** cron-job-set-tags: persist tags, broadcast update */
  async function handleCronSetTags(
    ws: ServerWebSocket<WSData>,
    msg: Extract<ClientMessage, { type: 'cron-job-set-tags' }>,
  ): Promise<void> {
    const { jobId, tags } = msg
    try {
      prefsStore.setTags(jobId, tags)
      const job = cronManager.getAllJobs().find(j => j.id === jobId)
      if (job) {
        const updated: CronJob = { ...job, tags }
        ctx.broadcast({ type: 'cron-job-update', job: updated })
      }
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'set-tags', ok: true })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'set-tags', ok: false, error })
    }
  }

  /** cron-job-link-session: persist linked session, broadcast update */
  async function handleCronLinkSession(
    ws: ServerWebSocket<WSData>,
    msg: Extract<ClientMessage, { type: 'cron-job-link-session' }>,
  ): Promise<void> {
    const { jobId, sessionId } = msg
    try {
      prefsStore.setLinkedSession(jobId, sessionId)
      const job = cronManager.getAllJobs().find(j => j.id === jobId)
      if (job) {
        const updated: CronJob = { ...job, linkedSessionId: sessionId ?? undefined }
        ctx.broadcast({ type: 'cron-job-update', job: updated })
      }
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'link-session', ok: true })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'link-session', ok: false, error })
    }
  }

  /** cron-job-set-managed: persist managed flag, broadcast update */
  async function handleCronSetManaged(
    ws: ServerWebSocket<WSData>,
    msg: Extract<ClientMessage, { type: 'cron-job-set-managed' }>,
  ): Promise<void> {
    const { jobId, isManaged } = msg
    try {
      prefsStore.setManaged(jobId, isManaged)
      const job = cronManager.getAllJobs().find(j => j.id === jobId)
      if (job) {
        const updated: CronJob = { ...job, isManagedByAgentboard: isManaged }
        ctx.broadcast({ type: 'cron-job-update', job: updated })
      }
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'set-managed', ok: true })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      ctx.send(ws, { type: 'cron-operation-result', jobId, operation: 'set-managed', ok: false, error })
    }
  }

  return {
    onClientConnected,
    onClientDisconnected,
    handleCronJobSelect,
    handleCronRunNow,
    handleCronPause,
    handleCronResume,
    handleCronEditFrequency,
    handleCronDelete,
    handleCronCreate,
    handleCronBulkPause,
    handleCronBulkResume,
    handleCronBulkDelete,
    handleCronHistory,
    handleCronLogs,
    handleCronSudoAuth,
    handleCronSetTags,
    handleCronLinkSession,
    handleCronSetManaged,
  }
}

export type CronHandlers = ReturnType<typeof createCronHandlers>
