// wsRouter.ts - WebSocket dispatch + broadcast/send + registry event wiring
import type { ServerWebSocket } from 'bun'
import type { ServerMessage, ClientMessage } from '../shared/types'
import type { SessionRegistry } from './SessionRegistry'
import type { WSData } from './serverContext'

export type BroadcastFn = (msg: ServerMessage) => void
export type SendFn = (ws: ServerWebSocket<WSData>, msg: ServerMessage) => void

export interface WsHandlers {
  onSessionRefresh: () => void
  onSessionCreate: (ws: ServerWebSocket<WSData>, message: Extract<ClientMessage, { type: 'session-create' }>) => void
  onSessionKill: (ws: ServerWebSocket<WSData>, sessionId: string) => void
  onSessionRename: (ws: ServerWebSocket<WSData>, sessionId: string, newName: string) => void
  onSessionResume: (ws: ServerWebSocket<WSData>, message: Extract<ClientMessage, { type: 'session-resume' }>) => void
  onSessionPin: (ws: ServerWebSocket<WSData>, sessionId: string, isPinned: unknown) => void
  onTerminalAttach: (ws: ServerWebSocket<WSData>, message: Extract<ClientMessage, { type: 'terminal-attach' }>) => void
  onTerminalDetach: (ws: ServerWebSocket<WSData>, sessionId: string) => void
  onTerminalInput: (ws: ServerWebSocket<WSData>, sessionId: string, data: string) => void
  onTerminalResize: (ws: ServerWebSocket<WSData>, sessionId: string, cols: number, rows: number) => void
  onCancelCopyMode: (ws: ServerWebSocket<WSData>, sessionId: string) => void
  onCheckCopyMode: (ws: ServerWebSocket<WSData>, sessionId: string) => void
  onTaskCreate: (ws: ServerWebSocket<WSData>, message: Extract<ClientMessage, { type: 'task-create' }>) => void
  onTaskCancel: (ws: ServerWebSocket<WSData>, message: Extract<ClientMessage, { type: 'task-cancel' }>) => void
  onTaskRetry: (ws: ServerWebSocket<WSData>, message: Extract<ClientMessage, { type: 'task-retry' }>) => void
  onTaskListRequest: (ws: ServerWebSocket<WSData>) => void
  onTemplateListRequest: (ws: ServerWebSocket<WSData>) => void
  // Workflow engine handlers (WO-008)
  onWorkflowListRequest?: (ws: ServerWebSocket<WSData>, message: Extract<ClientMessage, { type: 'workflow-list-request' }>) => void
  onWorkflowRunListRequest?: (ws: ServerWebSocket<WSData>, message: Extract<ClientMessage, { type: 'workflow-run-list-request' }>) => void
  onWorkflowRun?: (ws: ServerWebSocket<WSData>, message: Extract<ClientMessage, { type: 'workflow-run' }>) => void
  onWorkflowRunResume?: (ws: ServerWebSocket<WSData>, message: Extract<ClientMessage, { type: 'workflow-run-resume' }>) => void
  onWorkflowRunCancel?: (ws: ServerWebSocket<WSData>, message: Extract<ClientMessage, { type: 'workflow-run-cancel' }>) => void
}

export function broadcast(
  sockets: Set<ServerWebSocket<WSData>>,
  message: ServerMessage
): void {
  const payload = JSON.stringify(message)
  for (const socket of sockets) {
    socket.send(payload)
  }
}

export function send(
  ws: ServerWebSocket<WSData>,
  message: ServerMessage
): void {
  ws.send(JSON.stringify(message))
}

export function handleMessage(
  ws: ServerWebSocket<WSData>,
  rawMessage: string | BufferSource,
  handlers: WsHandlers,
  sendFn: SendFn,
  authToken: string
): void {
  const text =
    typeof rawMessage === 'string'
      ? rawMessage
      : new TextDecoder().decode(rawMessage)

  let message: ClientMessage
  try {
    message = JSON.parse(text) as ClientMessage
  } catch {
    sendFn(ws, { type: 'error', message: 'Invalid message payload' })
    return
  }

  // Handle auth message (always allowed, even before authentication)
  if (message.type === 'auth') {
    if (!authToken) {
      // No auth configured = dev mode, auto-authenticate
      ws.data.authenticated = true
      sendFn(ws, { type: 'auth-success' })
    } else if (message.token === authToken) {
      ws.data.authenticated = true
      sendFn(ws, { type: 'auth-success' })
    } else {
      sendFn(ws, { type: 'auth-failed' })
      ws.close(1008, 'Authentication failed')
    }
    return
  }

  // Reject all other messages if not authenticated (and auth is required)
  if (authToken && !ws.data.authenticated) {
    sendFn(ws, { type: 'error', message: 'Not authenticated. Send auth message first.' })
    return
  }

  switch (message.type) {
    case 'session-refresh':
      handlers.onSessionRefresh()
      return
    case 'session-create':
      handlers.onSessionCreate(ws, message)
      return
    case 'session-kill':
      handlers.onSessionKill(ws, message.sessionId)
      return
    case 'session-rename':
      handlers.onSessionRename(ws, message.sessionId, message.newName)
      return
    case 'terminal-attach':
      handlers.onTerminalAttach(ws, message)
      return
    case 'terminal-detach':
      handlers.onTerminalDetach(ws, message.sessionId)
      return
    case 'terminal-input':
      handlers.onTerminalInput(ws, message.sessionId, message.data)
      return
    case 'terminal-resize':
      handlers.onTerminalResize(ws, message.sessionId, message.cols, message.rows)
      return
    case 'tmux-cancel-copy-mode':
      handlers.onCancelCopyMode(ws, message.sessionId)
      return
    case 'tmux-check-copy-mode':
      handlers.onCheckCopyMode(ws, message.sessionId)
      return
    case 'session-resume':
      handlers.onSessionResume(ws, message)
      return
    case 'session-pin':
      handlers.onSessionPin(ws, message.sessionId, message.isPinned)
      return
    case 'task-create':
      handlers.onTaskCreate(ws, message)
      return
    case 'task-cancel':
      handlers.onTaskCancel(ws, message)
      return
    case 'task-retry':
      handlers.onTaskRetry(ws, message)
      return
    case 'task-list-request':
      handlers.onTaskListRequest(ws)
      return
    case 'template-list-request':
      handlers.onTemplateListRequest(ws)
      return
    // Workflow engine messages (WO-008)
    case 'workflow-list-request':
      handlers.onWorkflowListRequest?.(ws, message)
      return
    case 'workflow-run-list-request':
      handlers.onWorkflowRunListRequest?.(ws, message)
      return
    case 'workflow-run':
      handlers.onWorkflowRun?.(ws, message)
      return
    case 'workflow-run-resume':
      handlers.onWorkflowRunResume?.(ws, message)
      return
    case 'workflow-run-cancel':
      handlers.onWorkflowRunCancel?.(ws, message)
      return
    default:
      sendFn(ws, { type: 'error', message: 'Unknown message type' })
  }
}

export function wireRegistryEvents(
  registry: SessionRegistry,
  broadcastFn: BroadcastFn
): void {
  registry.on('session-update', (session) => {
    broadcastFn({ type: 'session-update', session })
  })

  registry.on('sessions', (sessions) => {
    broadcastFn({ type: 'sessions', sessions })
  })

  registry.on('session-removed', (sessionId) => {
    broadcastFn({ type: 'session-removed', sessionId })
  })

  registry.on('agent-sessions', ({ active, inactive }) => {
    broadcastFn({ type: 'agent-sessions', active, inactive })
  })
}
