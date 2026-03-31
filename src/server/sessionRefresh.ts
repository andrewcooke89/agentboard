// sessionRefresh.ts - Refresh orchestration with timers
import type { Session } from '../shared/types'
import type { ServerContext } from './serverContext'
import type { SessionManager } from './SessionManager'
import type { SessionRefreshWorkerClient } from './sessionRefreshWorkerClient'
import {
  setForceWorkingUntil,
  applyForceWorkingOverrides,
} from './forceWorkingStatus'

export type HydrationFn = (
  sessions: Session[],
  opts?: { verifyAssociations?: boolean }
) => Session[]

export function createRefreshOrchestrator(
  ctx: ServerContext,
  deps: {
    sessionManager: SessionManager
    sessionRefreshWorker: SessionRefreshWorkerClient
    hydrateSessionsWithAgentSessions: HydrationFn
  }
) {
  let refreshInFlight = false
  let enterRefreshTimer: Timer | null = null
  const lastUserMessageTimers = new Map<string, Timer>()

  async function refreshSessionsAsync(): Promise<void> {
    if (refreshInFlight) return
    refreshInFlight = true
    try {
      const sessions = await deps.sessionRefreshWorker.refresh(
        ctx.config.tmuxSession,
        ctx.config.discoverPrefixes
      )
      const hydrated = deps.hydrateSessionsWithAgentSessions(sessions)
      const withOverrides = applyForceWorkingOverrides(hydrated)
      ctx.registry.replaceSessions(withOverrides)
    } catch (error) {
      // Fallback to sync on worker failure
      ctx.logger.warn('session_refresh_worker_error', {
        message: error instanceof Error ? error.message : String(error),
      })
      const sessions = deps.sessionManager.listWindows()
      const hydrated = deps.hydrateSessionsWithAgentSessions(sessions)
      const withOverrides = applyForceWorkingOverrides(hydrated)
      ctx.registry.replaceSessions(withOverrides)
    } finally {
      refreshInFlight = false
    }
  }

  function refreshSessions() {
    void refreshSessionsAsync()
  }

  // Sync version for startup - ensures sessions are ready before server starts
  function refreshSessionsSync({ verifyAssociations = false } = {}) {
    const sessions = deps.sessionManager.listWindows()
    const hydrated = deps.hydrateSessionsWithAgentSessions(sessions, { verifyAssociations })
    ctx.registry.replaceSessions(hydrated)
  }

  function setForceWorking(sessionId: string) {
    setForceWorkingUntil(sessionId, Date.now() + ctx.config.workingGracePeriodMs)
    // Immediately update registry so UI shows "working" right away
    ctx.registry.updateSession(sessionId, { status: 'working' })
  }

  function scheduleEnterRefresh() {
    if (enterRefreshTimer) {
      clearTimeout(enterRefreshTimer)
    }
    enterRefreshTimer = setTimeout(() => {
      enterRefreshTimer = null
      refreshSessions()
    }, ctx.config.enterRefreshDelayMs)
  }

  async function captureLastUserMessage(tmuxWindow: string) {
    try {
      const message = await deps.sessionRefreshWorker.getLastUserMessage(tmuxWindow)
      if (!message || !message.trim()) return
      const record = ctx.db.getSessionByWindow(tmuxWindow)
      if (!record) return
      if (record.lastUserMessage === message) return
      const updated = ctx.db.updateSession(record.sessionId, { lastUserMessage: message })
      if (!updated) return
      ctx.registry.updateSession(tmuxWindow, { lastUserMessage: message })
      // Inline updateAgentSessions call to avoid circular dep
      // The caller provides this through the hydration function path
    } catch (error) {
      ctx.logger.warn('last_user_message_capture_error', {
        tmuxWindow,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  function scheduleLastUserMessageCapture(
    sessionId: string,
    lastUserMessageLocks: Map<string, number>,
    lockDurationMs: number
  ) {
    const session = ctx.registry.get(sessionId)
    if (!session) return
    const tmuxWindow = session.tmuxWindow

    // Set lock immediately to prevent log poller from overwriting with stale data
    // during the debounce delay (before capture completes)
    lastUserMessageLocks.set(tmuxWindow, Date.now() + lockDurationMs)

    const existing = lastUserMessageTimers.get(tmuxWindow)
    if (existing) {
      clearTimeout(existing)
    }
    const timer = setTimeout(() => {
      lastUserMessageTimers.delete(tmuxWindow)
      void captureLastUserMessage(tmuxWindow)
    }, ctx.config.enterRefreshDelayMs)
    lastUserMessageTimers.set(tmuxWindow, timer)
  }

  return {
    refreshSessions,
    refreshSessionsSync,
    setForceWorking,
    scheduleEnterRefresh,
    scheduleLastUserMessageCapture,
  }
}
