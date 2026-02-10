// serverContext.ts - Shared dependency injection context for all server modules
import type { ServerWebSocket } from 'bun'
import type { ServerMessage } from '../shared/types'
import type { SessionDatabase } from './db'
import type { SessionRegistry } from './SessionRegistry'
import type { SessionManager } from './SessionManager'
import type { ITerminalProxy } from './terminal'
import type { TaskStore } from './taskStore'
import type { TaskWorker } from './taskWorker'
import type { WorkflowStore } from './workflowStore'
import type { WorkflowEngine } from './workflowEngine'

export interface WSData {
  terminal: ITerminalProxy | null
  currentSessionId: string | null
  currentTmuxTarget: string | null
  connectionId: string
  authenticated: boolean
}

export type Config = typeof import('./config').config

export type Logger = typeof import('./logger').logger

export interface ServerContext {
  db: SessionDatabase
  registry: SessionRegistry
  sessionManager: SessionManager
  config: Config
  logger: Logger
  broadcast: (msg: ServerMessage) => void
  send: (ws: ServerWebSocket<WSData>, msg: ServerMessage) => void
  sockets: Set<ServerWebSocket<WSData>>
  taskStore: TaskStore
  taskWorker: TaskWorker
  workflowStore: WorkflowStore
  workflowEngine: WorkflowEngine
}
