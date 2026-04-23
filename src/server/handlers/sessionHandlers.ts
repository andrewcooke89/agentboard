// handlers/sessionHandlers.ts - Session CRUD handlers (create, kill, rename, pin, resume)
import type { ServerWebSocket } from 'bun'
import { toAgentSession } from '../agentSessions'
import { isValidSessionId, escapeForDoubleQuotedShell } from '../validators'
import type { ServerContext, WSData } from '../serverContext'
import type {
  ClientMessage,
  AgentSession,
  ResumeError,
} from '../../shared/types'

export interface SessionHandlerDeps {
  updateAgentSessions: () => void
  refreshSessions: () => void
  refreshSessionsSync: (opts?: { verifyAssociations?: boolean }) => void
}

export function createSessionHandlers(
  ctx: ServerContext,
  deps: SessionHandlerDeps
) {
  return {
    handleCreate(
      ws: ServerWebSocket<WSData>,
      message: Extract<ClientMessage, { type: 'session-create' }>
    ) {
      try {
        // If a prompt is provided, append it as a quoted argument to the command
        let finalCommand = message.command
        const prompt = message.prompt?.trim()
        if (prompt) {
          const baseCmd = finalCommand?.trim() || 'claude'
          // Escape all shell-special characters for safe double-quoted inclusion
          // (tmux new-window passes the command through sh -c)
          const escapedPrompt = escapeForDoubleQuotedShell(prompt)
          finalCommand = `${baseCmd} "${escapedPrompt}"`
        }

        const created = ctx.sessionManager.createWindow(
          message.projectPath,
          message.name,
          finalCommand
        )
        // Add session to registry immediately so terminal can attach
        const currentSessions = ctx.registry.getAll()
        ctx.registry.replaceSessions([created, ...currentSessions])
        deps.refreshSessions()
        ctx.send(ws, { type: 'session-created', session: created })
      } catch (error) {
        ctx.send(ws, {
          type: 'error',
          message:
            error instanceof Error ? error.message : 'Unable to create session',
        })
      }
    },

    handleKill(ws: ServerWebSocket<WSData>, sessionId: string) {
      const session = ctx.registry.get(sessionId)
      if (!session) {
        ctx.send(ws, { type: 'kill-failed', sessionId, message: 'Session not found' })
        return
      }
      if (session.source !== 'managed' && !ctx.config.allowKillExternal) {
        ctx.send(ws, { type: 'kill-failed', sessionId, message: 'Cannot kill external sessions' })
        return
      }

      try {
        ctx.sessionManager.killWindow(session.tmuxWindow)
        const orphaned = new Map<string, AgentSession>()
        const orphanById = (agentSessionId?: string | null) => {
          if (!agentSessionId || orphaned.has(agentSessionId)) return
          const orphanedSession = ctx.db.orphanSession(agentSessionId)
          if (orphanedSession) {
            orphaned.set(agentSessionId, toAgentSession(orphanedSession))
          }
        }

        orphanById(session.agentSessionId)
        const recordByWindow = ctx.db.getSessionByWindow(session.tmuxWindow)
        if (recordByWindow) {
          orphanById(recordByWindow.sessionId)
        }
        if (orphaned.size > 0) {
          deps.updateAgentSessions()
          for (const orphanedSession of orphaned.values()) {
            ctx.broadcast({ type: 'session-orphaned', session: orphanedSession })
          }
        }
        const remaining = ctx.registry.getAll().filter((item) => item.id !== sessionId)
        ctx.registry.replaceSessions(remaining)
        deps.refreshSessions()
      } catch (error) {
        ctx.send(ws, {
          type: 'kill-failed',
          sessionId,
          message:
            error instanceof Error ? error.message : 'Unable to kill session',
        })
      }
    },

    handleRename(
      ws: ServerWebSocket<WSData>,
      sessionId: string,
      newName: string
    ) {
      let session = ctx.registry.get(sessionId)
      if (!session) {
        deps.refreshSessionsSync() // Use sync for inline operations needing immediate results
        session = ctx.registry.get(sessionId)
        if (!session) {
          ctx.send(ws, { type: 'error', message: 'Session not found' })
          return
        }
      }

      try {
        ctx.sessionManager.renameWindow(session.tmuxWindow, newName)
        deps.refreshSessions()
      } catch (error) {
        ctx.send(ws, {
          type: 'error',
          message:
            error instanceof Error ? error.message : 'Unable to rename session',
        })
      }
    },

    handleSessionPin(
      ws: ServerWebSocket<WSData>,
      sessionId: string,
      isPinned: unknown
    ) {
      // Validate isPinned is actually a boolean
      if (typeof isPinned !== 'boolean') {
        ctx.send(ws, { type: 'session-pin-result', sessionId, ok: false, error: 'isPinned must be a boolean' })
        return
      }

      if (!isValidSessionId(sessionId)) {
        ctx.send(ws, { type: 'session-pin-result', sessionId, ok: false, error: 'Invalid session id' })
        return
      }

      const record = ctx.db.getSessionById(sessionId)
      if (!record) {
        ctx.send(ws, { type: 'session-pin-result', sessionId, ok: false, error: 'Session not found' })
        return
      }

      // When pinning, also clear any previous resume error
      const updated = isPinned
        ? ctx.db.updateSession(sessionId, { isPinned: true, lastResumeError: null })
        : ctx.db.setPinned(sessionId, false)
      if (!updated) {
        ctx.send(ws, { type: 'session-pin-result', sessionId, ok: false, error: 'Failed to update pin state' })
        return
      }

      ctx.send(ws, { type: 'session-pin-result', sessionId, ok: true })

      // Update all active sessions that match (in case of edge cases with multiple windows)
      for (const session of ctx.registry.getAll()) {
        if (session.agentSessionId === sessionId) {
          ctx.registry.updateSession(session.id, { isPinned })
        }
      }

      deps.updateAgentSessions()
    },

    handleSessionResume(
      ws: ServerWebSocket<WSData>,
      message: Extract<ClientMessage, { type: 'session-resume' }>
    ) {
      const sessionId = message.sessionId
      if (!isValidSessionId(sessionId)) {
        const error: ResumeError = {
          code: 'NOT_FOUND',
          message: 'Invalid session id',
        }
        ctx.send(ws, { type: 'session-resume-result', sessionId, ok: false, error })
        return
      }

      const record = ctx.db.getSessionById(sessionId)
      if (!record) {
        const error: ResumeError = { code: 'NOT_FOUND', message: 'Session not found' }
        ctx.send(ws, { type: 'session-resume-result', sessionId, ok: false, error })
        return
      }

      if (record.currentWindow) {
        const error: ResumeError = {
          code: 'ALREADY_ACTIVE',
          message: 'Session is already active',
        }
        ctx.send(ws, { type: 'session-resume-result', sessionId, ok: false, error })
        return
      }

      const resumeTemplate =
        record.agentType === 'claude' ? ctx.config.claudeResumeCmd : ctx.config.codexResumeCmd

      // Validate template contains {sessionId} placeholder
      if (!resumeTemplate.includes('{sessionId}')) {
        const error: ResumeError = {
          code: 'RESUME_FAILED',
          message: `Resume command template missing {sessionId} placeholder`,
        }
        ctx.send(ws, { type: 'session-resume-result', sessionId, ok: false, error })
        return
      }

      const command = resumeTemplate.replace('{sessionId}', sessionId)
      const projectPath =
        record.projectPath ||
        process.env.HOME ||
        process.env.USERPROFILE ||
        '.'

      try {
        const created = ctx.sessionManager.createWindow(
          projectPath,
          message.name ?? record.displayName,
          command,
          { excludeSessionId: sessionId }
        )
        ctx.db.updateSession(sessionId, {
          currentWindow: created.tmuxWindow,
          displayName: created.name,
          lastResumeError: null, // Clear any previous error on success
        })
        // Add session to registry immediately so terminal can attach
        // (async refresh will update with any additional data later)
        const currentSessions = ctx.registry.getAll()
        ctx.registry.replaceSessions([created, ...currentSessions])
        deps.refreshSessions()
        ctx.send(ws, { type: 'session-resume-result', sessionId, ok: true, session: created })
        ctx.broadcast({
          type: 'session-activated',
          session: toAgentSession({
            ...record,
            currentWindow: created.tmuxWindow,
            displayName: created.name,
          }),
          window: created.tmuxWindow,
        })
      } catch (error) {
        const err: ResumeError = {
          code: 'RESUME_FAILED',
          message:
            error instanceof Error ? error.message : 'Unable to resume session',
        }
        ctx.send(ws, { type: 'session-resume-result', sessionId, ok: false, error: err })
      }
    },
  }
}
