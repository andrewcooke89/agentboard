// sessionResurrection.ts - Resurrect pinned sessions that lost their tmux windows
import { isValidSessionId } from './validators'
import type { ServerContext } from './serverContext'

export function resurrectPinnedSessions(ctx: ServerContext): void {
  const orphanedPinned = ctx.db.getPinnedOrphaned()
  if (orphanedPinned.length === 0) {
    return
  }

  ctx.logger.info('resurrect_pinned_sessions_start', { count: orphanedPinned.length })

  for (const record of orphanedPinned) {
    // Validate sessionId before using in command
    if (!isValidSessionId(record.sessionId)) {
      const errorMsg = 'Invalid session id format'
      ctx.db.updateSession(record.sessionId, { isPinned: false, lastResumeError: errorMsg })
      ctx.broadcast({
        type: 'session-resurrection-failed',
        sessionId: record.sessionId,
        displayName: record.displayName,
        error: errorMsg,
      })
      ctx.logger.error('resurrect_pinned_session_invalid_id', {
        sessionId: record.sessionId,
        displayName: record.displayName,
      })
      continue
    }

    const resumeTemplate =
      record.agentType === 'claude' ? ctx.config.claudeResumeCmd : ctx.config.codexResumeCmd

    // Validate template contains {sessionId} placeholder
    if (!resumeTemplate.includes('{sessionId}')) {
      const errorMsg = `Resume command template missing {sessionId} placeholder: ${resumeTemplate}`
      ctx.db.updateSession(record.sessionId, { isPinned: false, lastResumeError: errorMsg })
      ctx.broadcast({
        type: 'session-resurrection-failed',
        sessionId: record.sessionId,
        displayName: record.displayName,
        error: errorMsg,
      })
      ctx.logger.error('resurrect_pinned_session_invalid_template', {
        sessionId: record.sessionId,
        displayName: record.displayName,
        template: resumeTemplate,
      })
      continue
    }

    const command = resumeTemplate.replace('{sessionId}', record.sessionId)
    const projectPath =
      record.projectPath ||
      process.env.HOME ||
      process.env.USERPROFILE ||
      '.'

    try {
      const created = ctx.sessionManager.createWindow(
        projectPath,
        record.displayName,
        command,
        { excludeSessionId: record.sessionId }
      )
      ctx.db.updateSession(record.sessionId, {
        currentWindow: created.tmuxWindow,
        displayName: created.name,
        lastResumeError: null, // Clear any previous error on success
      })
      ctx.logger.info('resurrect_pinned_session_success', {
        sessionId: record.sessionId,
        displayName: record.displayName,
        tmuxWindow: created.tmuxWindow,
      })
    } catch (error) {
      // Resurrection failed - unpin the session and persist error
      const errorMsg = error instanceof Error ? error.message : String(error)
      ctx.db.updateSession(record.sessionId, { isPinned: false, lastResumeError: errorMsg })
      ctx.broadcast({
        type: 'session-resurrection-failed',
        sessionId: record.sessionId,
        displayName: record.displayName,
        error: errorMsg,
      })
      ctx.logger.error('resurrect_pinned_session_failed', {
        sessionId: record.sessionId,
        displayName: record.displayName,
        error: errorMsg,
      })
    }
  }
}
