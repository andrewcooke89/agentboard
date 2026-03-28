// handlers/terminalHandlers.ts - Terminal proxy management (attach, detach, input, resize, copy-mode)
import type { ServerWebSocket } from 'bun'
import {
  createTerminalProxy,
  TerminalProxyError,
} from '../terminal'
import type { ITerminalProxy } from '../terminal'
import { isValidSessionId, isValidTmuxTarget } from '../validators'
import type { ServerContext, WSData } from '../serverContext'
import type { Session, TerminalErrorCode } from '../../shared/types'

export interface TerminalRefreshCallbacks {
  scheduleEnterRefresh: () => void
  setForceWorking: (sessionId: string) => void
  scheduleLastUserMessageCapture: (sessionId: string) => void
}

export function createTerminalHandlers(
  ctx: ServerContext,
  refreshCallbacks: TerminalRefreshCallbacks
) {
  function sendTerminalError(
    ws: ServerWebSocket<WSData>,
    sessionId: string | null,
    code: TerminalErrorCode,
    message: string,
    retryable: boolean
  ) {
    ctx.send(ws, {
      type: 'terminal-error',
      sessionId,
      code,
      message,
      retryable,
    })
  }

  function handleTerminalError(
    ws: ServerWebSocket<WSData>,
    sessionId: string | null,
    error: unknown,
    fallbackCode: TerminalErrorCode
  ) {
    if (error instanceof TerminalProxyError) {
      sendTerminalError(ws, sessionId, error.code, error.message, error.retryable)
      return
    }

    const message =
      error instanceof Error ? error.message : 'Terminal operation failed'
    sendTerminalError(ws, sessionId, fallbackCode, message, true)
  }

  function createPersistentTerminal(ws: ServerWebSocket<WSData>): ITerminalProxy {
    const sessionName = `${ctx.config.tmuxSession}-ws-${ws.data.connectionId}`

    const terminal = createTerminalProxy({
      connectionId: ws.data.connectionId,
      sessionName,
      baseSession: ctx.config.tmuxSession,
      monitorTargets: ctx.config.terminalMonitorTargets,
      onData: (data) => {
        const sessionId = ws.data.currentSessionId
        if (!sessionId) {
          return
        }
        ctx.send(ws, { type: 'terminal-output', sessionId, data })
      },
      onExit: () => {
        const sessionId = ws.data.currentSessionId
        ws.data.currentSessionId = null
        ws.data.currentTmuxTarget = null
        ws.data.terminal = null
        void terminal.dispose()
        if (!ctx.sockets.has(ws)) return
        sendTerminalError(
          ws,
          sessionId,
          'ERR_TMUX_ATTACH_FAILED',
          'tmux client exited',
          true
        )
      },
    })

    return terminal
  }

  async function ensurePersistentTerminal(
    ws: ServerWebSocket<WSData>
  ): Promise<ITerminalProxy | null> {
    if (!ws.data.terminal) {
      ws.data.terminal = createPersistentTerminal(ws)
    }

    try {
      await ws.data.terminal.start()
      return ws.data.terminal
    } catch (error) {
      handleTerminalError(ws, ws.data.currentSessionId, error, 'ERR_TMUX_ATTACH_FAILED')
      ws.data.terminal = null
      return null
    }
  }

  function captureTmuxHistory(target: string): string | null {
    try {
      // Capture full scrollback history (-S - means from start, -E - means to end, -J joins wrapped lines)
      const result = Bun.spawnSync(
        ['tmux', 'capture-pane', '-t', target, '-p', '-S', '-', '-E', '-', '-J'],
        { stdout: 'pipe', stderr: 'pipe' }
      )
      if (result.exitCode !== 0) {
        return null
      }
      const output = result.stdout.toString()
      // Only return if there's actual content
      if (output.trim().length === 0) {
        return null
      }
      return output
    } catch (e) {
      throw e
    }
  }

  function resolveCopyModeTarget(
    sessionId: string,
    ws: ServerWebSocket<WSData>,
    session: Session
  ): string {
    if (ws.data.currentSessionId === sessionId && ws.data.currentTmuxTarget) {
      return ws.data.currentTmuxTarget
    }
    return session.tmuxWindow
  }

  return {
    initializePersistentTerminal(ws: ServerWebSocket<WSData>) {
      if (ws.data.terminal) {
        return
      }

      const terminal = createPersistentTerminal(ws)
      ws.data.terminal = terminal

      void terminal.start().catch((error) => {
        ws.data.terminal = null
        handleTerminalError(ws, null, error, 'ERR_TMUX_ATTACH_FAILED')
      })
    },

    async attachTerminalPersistent(
      ws: ServerWebSocket<WSData>,
      message: { sessionId: string; tmuxTarget?: string; cols?: number; rows?: number }
    ) {
      const { sessionId, tmuxTarget, cols, rows } = message

      if (!isValidSessionId(sessionId)) {
        sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', 'Invalid session id', false)
        return
      }

      const session = ctx.registry.get(sessionId)
      if (!session) {
        sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', 'Session not found', false)
        return
      }

      const target = tmuxTarget ?? session.tmuxWindow
      if (!isValidTmuxTarget(target)) {
        sendTerminalError(ws, sessionId, 'ERR_INVALID_WINDOW', 'Invalid tmux target', false)
        return
      }

      const terminal = await ensurePersistentTerminal(ws)
      if (!terminal) {
        return
      }

      if (typeof cols === 'number' && typeof rows === 'number') {
        terminal.resize(cols, rows)
      }

      // Capture scrollback history BEFORE switching to avoid race with live output
      const history = captureTmuxHistory(target)

      try {
        await terminal.switchTo(target, () => {
          ws.data.currentSessionId = sessionId
          ws.data.currentTmuxTarget = target
          // Send history in onReady callback, before output suppression is lifted
          if (history) {
            ctx.send(ws, { type: 'terminal-output', sessionId, data: history })
          }
        })
        ws.data.currentSessionId = sessionId
        ws.data.currentTmuxTarget = target
        ctx.send(ws, { type: 'terminal-ready', sessionId })
      } catch (error) {
        handleTerminalError(ws, sessionId, error, 'ERR_TMUX_SWITCH_FAILED')
      }
    },

    detachTerminalPersistent(ws: ServerWebSocket<WSData>, sessionId: string) {
      if (ws.data.currentSessionId === sessionId) {
        ws.data.currentSessionId = null
        ws.data.currentTmuxTarget = null
      }
    },

    handleTerminalInputPersistent(
      ws: ServerWebSocket<WSData>,
      sessionId: string,
      data: string
    ) {
      if (sessionId !== ws.data.currentSessionId) {
        return
      }
      ws.data.terminal?.write(data)

      // On Enter key: immediately set "working" status and schedule refresh
      if (data.includes('\r') || data.includes('\n')) {
        refreshCallbacks.setForceWorking(sessionId)
        refreshCallbacks.scheduleEnterRefresh()
        refreshCallbacks.scheduleLastUserMessageCapture(sessionId)
      }
    },

    handleTerminalResizePersistent(
      ws: ServerWebSocket<WSData>,
      sessionId: string,
      cols: number,
      rows: number
    ) {
      if (sessionId !== ws.data.currentSessionId) {
        return
      }
      ws.data.terminal?.resize(cols, rows)
    },

    handleCancelCopyMode(ws: ServerWebSocket<WSData>, sessionId: string) {
      const session = ctx.registry.get(sessionId)
      if (!session) return

      try {
        // Exit tmux copy-mode quietly.
        const target = resolveCopyModeTarget(sessionId, ws, session)
        Bun.spawnSync(['tmux', 'send-keys', '-X', '-t', target, 'cancel'], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
      } catch (error) {
        console.error('Failed to cancel copy-mode:', error)
      }
    },

    handleCheckCopyMode(ws: ServerWebSocket<WSData>, sessionId: string) {
      const session = ctx.registry.get(sessionId)
      if (!session) return

      try {
        const target = resolveCopyModeTarget(sessionId, ws, session)
        // Query tmux for pane copy-mode status
        const result = Bun.spawnSync(
          ['tmux', 'display-message', '-p', '-t', target, '#{pane_in_mode}'],
          { stdout: 'pipe', stderr: 'pipe' }
        )
        const output = result.stdout.toString().trim()
        const inCopyMode = output === '1'
        ctx.send(ws, { type: 'tmux-copy-mode-status', sessionId, inCopyMode })
      } catch {
        // On error, assume not in copy mode
        ctx.send(ws, { type: 'tmux-copy-mode-status', sessionId, inCopyMode: false })
      }
    },

    cleanupTerminals(ws: ServerWebSocket<WSData>) {
      if (ws.data.terminal) {
        void ws.data.terminal.dispose()
        ws.data.terminal = null
      }
      ws.data.currentSessionId = null
      ws.data.currentTmuxTarget = null
    },
  }
}
