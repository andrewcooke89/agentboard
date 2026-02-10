// sessionHydration.ts - Agent session hydration (tmux <-> agent-session merge)
import { toAgentSession } from './agentSessions'
import { getLogSearchDirs } from './logDiscovery'
import { verifyWindowLogAssociationDetailed } from './logMatcher'
import type { ServerContext } from './serverContext'
import type { AgentSession, Session } from '../shared/types'

export function updateAgentSessions(ctx: ServerContext): void {
  const active = ctx.db.getActiveSessions().map(toAgentSession)
  let inactive = ctx.db.getInactiveSessions({ maxAgeHours: ctx.config.inactiveSessionMaxAgeHours }).map(toAgentSession)
  // Filter out sessions from excluded project directories
  // Use "<empty>" as a special marker to exclude sessions with no project path
  if (ctx.config.excludeProjects?.length > 0) {
    inactive = inactive.filter((session) => {
      const projectPath = session.projectPath || ''
      return !ctx.config.excludeProjects.some((excluded) => {
        if (excluded === '<empty>') return projectPath === ''
        return projectPath.startsWith(excluded)
      })
    })
  }
  ctx.registry.setAgentSessions(active, inactive)
}

export function hydrateSessionsWithAgentSessions(
  ctx: ServerContext,
  sessions: Session[],
  { verifyAssociations = false }: { verifyAssociations?: boolean } = {}
): Session[] {
  const activeSessions = ctx.db.getActiveSessions()
  const windowSet = new Set(sessions.map((session) => session.tmuxWindow))
  const activeMap = new Map<string, typeof activeSessions[number]>()
  const orphaned: AgentSession[] = []
  const logDirs = getLogSearchDirs()

  // Safeguard: don't mass-orphan if window list seems incomplete
  // This can happen if tmux commands fail temporarily on server restart
  const wouldOrphanCount = activeSessions.filter(
    (s) => s.currentWindow && !windowSet.has(s.currentWindow)
  ).length
  if (wouldOrphanCount > 0 && wouldOrphanCount === activeSessions.length) {
    ctx.logger.warn('hydrate_would_orphan_all', {
      activeSessionCount: activeSessions.length,
      windowCount: windowSet.size,
      wouldOrphanCount,
      message: 'Would orphan ALL active sessions - skipping to prevent data loss',
    })
    return sessions
  }

  for (const agentSession of activeSessions) {
    if (!agentSession.currentWindow || !windowSet.has(agentSession.currentWindow)) {
      ctx.logger.info('session_orphaned', {
        sessionId: agentSession.sessionId,
        displayName: agentSession.displayName,
        currentWindow: agentSession.currentWindow,
        windowSetSize: windowSet.size,
        windowSetSample: Array.from(windowSet).slice(0, 5),
      })
      const orphanedSession = ctx.db.orphanSession(agentSession.sessionId)
      if (orphanedSession) {
        orphaned.push(toAgentSession(orphanedSession))
      }
      continue
    }

    // Verify the association by checking terminal content matches the log
    // This catches stale associations from tmux restarts where window IDs changed
    // Only run on startup to avoid blocking periodic refreshes
    if (verifyAssociations) {
      // Exclude logs from other active sessions to prevent cross-session pollution
      // (e.g., discussing session A's content in session B causes B's log to match A's window)
      const otherSessionLogPaths = activeSessions
        .filter((s) => s.sessionId !== agentSession.sessionId && s.currentWindow)
        .map((s) => s.logFilePath)

      const verification = verifyWindowLogAssociationDetailed(
        agentSession.currentWindow,
        agentSession.logFilePath,
        logDirs,
        {
          context: { agentType: agentSession.agentType, projectPath: agentSession.projectPath },
          excludeLogPaths: otherSessionLogPaths,
        }
      )

      // Get the window to check name match for fallback
      const window = sessions.find((s) => s.tmuxWindow === agentSession.currentWindow)
      const nameMatches = Boolean(window && window.name === agentSession.displayName)

      // Decide whether to orphan based on verification status and name match
      let shouldOrphan = false
      let fallbackUsed = false

      if (verification.status === 'verified') {
        // Content confirms association - keep
        shouldOrphan = false
      } else if (nameMatches) {
        // Name matches - trust it over content mismatch/inconclusive
        // Window names are user-intentional signals, so honor them even if
        // content matching finds a "better" match in another log (which can
        // happen due to similar content across sessions or limited scrollback)
        shouldOrphan = false
        fallbackUsed = true
      } else {
        // No name match and content doesn't verify - orphan
        shouldOrphan = true
      }

      if (shouldOrphan) {
        ctx.logger.info('session_verification_failed', {
          sessionId: agentSession.sessionId,
          displayName: agentSession.displayName,
          currentWindow: agentSession.currentWindow,
          logFilePath: agentSession.logFilePath,
          verificationStatus: verification.status,
          verificationReason: verification.reason ?? null,
          nameMatches,
          bestMatchLog: verification.bestMatch?.logPath ?? null,
        })
        const orphanedSession = ctx.db.orphanSession(agentSession.sessionId)
        if (orphanedSession) {
          orphaned.push(toAgentSession(orphanedSession))
        }
        continue
      }

      if (fallbackUsed) {
        ctx.logger.info('session_verification_name_fallback', {
          sessionId: agentSession.sessionId,
          displayName: agentSession.displayName,
          currentWindow: agentSession.currentWindow,
          verificationStatus: verification.status,
        })
      }
    }

    activeMap.set(agentSession.currentWindow, agentSession)
  }

  const hydrated = sessions.map((session) => {
    const agentSession = activeMap.get(session.tmuxWindow)
    if (!agentSession) {
      return session
    }
    if (agentSession.displayName !== session.name) {
      ctx.db.updateSession(agentSession.sessionId, { displayName: session.name })
      agentSession.displayName = session.name
    }
    return {
      ...session,
      // Use log-based agentType if command-based detection failed
      agentType: session.agentType ?? agentSession.agentType,
      agentSessionId: agentSession.sessionId,
      agentSessionName: agentSession.displayName,
      lastUserMessage: agentSession.lastUserMessage ?? session.lastUserMessage,
      // Use persisted log times (survives server restarts, works when tmux lacks creation time)
      lastActivity: agentSession.lastActivityAt,
      createdAt: agentSession.createdAt,
      isPinned: agentSession.isPinned,
    }
  })

  if (orphaned.length > 0) {
    for (const session of orphaned) {
      ctx.broadcast({ type: 'session-orphaned', session })
    }
  }

  updateAgentSessions(ctx)
  return hydrated
}
