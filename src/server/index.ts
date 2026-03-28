import path from 'node:path'
import type { ServerWebSocket } from 'bun'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { config } from './config'
import { loadModelEnvs } from './modelEnvLoader'
import { ensureTmux } from './prerequisites'
import { SessionManager } from './SessionManager'
import { SessionRegistry } from './SessionRegistry'
import { initDatabase, initPoolTables } from './db'
import { LogPoller } from './logPoller'
import { toAgentSession } from './agentSessions'
import { resolveTerminalMode } from './terminal'
import { logger } from './logger'
import { SessionRefreshWorkerClient } from './sessionRefreshWorkerClient'
import type { ServerContext, WSData } from './serverContext'

// Extracted modules
import { checkPortAvailable, getTailscaleIp, pruneOrphanedWsSessions, createConnectionId } from './startup'
import { registerHttpRoutes } from './httpRoutes'
import { registerWoRoutes } from './woRoutes'
import { SwarmManager } from './SwarmManager'
import { registerSwarmRoutes } from './swarmRoutes'
import { registerStatsRoutes } from './statsRoutes'
import { registerTicketRoutes } from './ticketRoutes'
import { MetricsStore } from './metricsStore'
import type { DashboardStats } from '../shared/dashboardTypes'
import { broadcast as broadcastToSockets, send as sendToSocket, handleMessage, wireRegistryEvents } from './wsRouter'
import { createTerminalHandlers } from './handlers/terminalHandlers'
import { createSessionHandlers } from './handlers/sessionHandlers'
import { resurrectPinnedSessions } from './sessionResurrection'
import { createRefreshOrchestrator } from './sessionRefresh'
import { updateAgentSessions, hydrateSessionsWithAgentSessions } from './sessionHydration'
import { createSessionPool } from './sessionPool'
import { initTaskStore } from './taskStore'
import { initWorkflowStore } from './workflowStore'
import { createTaskWorker } from './taskWorker'
import { createTaskHandlers } from './handlers/taskHandlers'
import { createWorkflowWsHandlers } from './handlers/workflowWsHandlers'
import { createWorkflowEngine } from './workflowEngine'
import { createWorkflowFileWatcher } from './workflowFileWatcher'
import type { WorkflowEngine } from './workflowEngine'
import type { WorkflowFileWatcher } from './workflowFileWatcher'
import { parseWorkflowYAML } from './workflowSchema'
import type { StepRunState } from '../shared/types'
import { HistoryService } from './HistoryService'
import { CronManager } from './cronManager'
import { CronHistoryService } from './cronHistoryService'
import { CronLogService } from './cronLogService'
import { createCronHandlers } from './handlers/cronHandlers'
import { CronAiService } from './cronAiService'
import type { SwarmEvent, SwarmGroupState } from '../shared/swarmTypes'

// --- Startup checks ---
checkPortAvailable(config.port, logger)
ensureTmux()
pruneOrphanedWsSessions(config, logger)
loadModelEnvs(config.modelEnvsPath)
const resolvedTerminalMode = resolveTerminalMode()
logger.info('terminal_mode_resolved', {
  configured: config.terminalMode,
  resolved: resolvedTerminalMode,
})

// --- Singletons ---
const app = new Hono()
const db = initDatabase()
const sessionManager = new SessionManager(undefined, {
  displayNameExists: (name, excludeSessionId) => db.displayNameExists(name, excludeSessionId),
})
const registry = new SessionRegistry()
const swarmManager = SwarmManager.getInstance()
const sockets = new Set<ServerWebSocket<WSData>>()

// Lock map for Enter-key lastUserMessage capture: tmuxWindow -> expiry timestamp
// Prevents stale log data from overwriting fresh terminal captures
const lastUserMessageLocks = new Map<string, number>()
const LAST_USER_MESSAGE_LOCK_MS = 60_000 // 60 seconds

const logPoller = new LogPoller(db, registry, {
  onSessionOrphaned: (sessionId) => {
    const session = db.getSessionById(sessionId)
    if (session) {
      broadcast({ type: 'session-orphaned', session: toAgentSession(session) })
    }
  },
  onSessionActivated: (sessionId, window) => {
    const session = db.getSessionById(sessionId)
    if (session) {
      broadcast({
        type: 'session-activated',
        session: toAgentSession(session),
        window,
      })
    }
  },
  isLastUserMessageLocked: (tmuxWindow) =>
    (lastUserMessageLocks.get(tmuxWindow) ?? 0) > Date.now(),
  maxLogsPerPoll: config.logPollMax,
  rgThreads: config.rgThreads,
  matchProfile: config.logMatchProfile,
  matchWorker: config.logMatchWorker,
})
const sessionRefreshWorker = new SessionRefreshWorkerClient()

// --- Task queue ---
const taskStore = initTaskStore(db.db)

// --- Workflow store ---
const workflowStore = initWorkflowStore(db.db)

// --- Chat history ---
const historyService = new HistoryService({
  enabled: config.historyEnabled,
  claudeConfigDir: config.claudeConfigDir,
  codexHomeDir: config.codexHomeDir,
  maxFiles: config.historyMaxFiles,
  maxResults: config.historyMaxResults,
  readMaxBytes: config.historyReadMaxBytes,
  readMaxLines: config.historyReadMaxLines,
  countsTtlMs: config.historyCountsTtlMs,
  resumeTimeoutMs: config.historyResumeTimeoutMs,
})

// --- Cron Manager ---
const cronManager = new CronManager()
cronManager.setDb(db.db) // Set db immediately so cleanup/prune timers have a valid reference
const cronHistoryService = new CronHistoryService(db.db)
const cronLogService = new CronLogService(db.db)

// --- Cron AI Service (WU-004) ---
const cronAiService = new CronAiService(
  {
    cronManager,
    historyService: cronHistoryService,
    logService: cronLogService,
    sessionManager,
  },
  { port: config.port, authToken: config.authToken }
)

// --- Context wiring ---
function broadcast(msg: import('../shared/types').ServerMessage) {
  broadcastToSockets(sockets, msg)
}

function send(ws: ServerWebSocket<WSData>, msg: import('../shared/types').ServerMessage) {
  sendToSocket(ws, msg)
}

function broadcastSwarmEvent(event: SwarmEvent) {
  const payload = JSON.stringify({ type: 'swarm-update', event })
  for (const socket of sockets) {
    socket.send(payload)
  }
}

function sendSwarmState(ws: ServerWebSocket<WSData>, groups: SwarmGroupState[]) {
  ws.send(JSON.stringify({ type: 'swarm-state', groups }))
}

function sendInitialWsState(ws: ServerWebSocket<WSData>) {
  send(ws, { type: 'sessions', sessions: registry.getAll() })
  const agentSessions = registry.getAgentSessions()
  send(ws, {
    type: 'agent-sessions',
    active: agentSessions.active,
    inactive: agentSessions.inactive,
  })
  send(ws, { type: 'task-list', tasks: taskStore.listTasks({ limit: 100 }), stats: taskStore.getStats() })
  send(ws, { type: 'template-list', templates: taskStore.listTemplates() })
  sendSwarmState(ws, swarmManager.getGroups())
  terminalHandlers.initializePersistentTerminal(ws)
  cronHandlers.onClientConnect(ws)
}

// TaskWorker and WorkflowEngine are created after ctx, assigned below
let taskWorker: import('./taskWorker').TaskWorker
let workflowEngineInstance: WorkflowEngine | null = null
let sessionPoolInstance: import('./sessionPool').SessionPool | null = null

const ctx: ServerContext = {
  db,
  registry,
  sessionManager,
  config,
  logger,
  broadcast,
  send,
  sockets,
  taskStore,
  get taskWorker() { return taskWorker },
  workflowStore,
  get workflowEngine() {
    if (!workflowEngineInstance) {
      throw new Error('WorkflowEngine not initialized')
    }
    return workflowEngineInstance
  },
}

// Expose cronAiService on ctx for httpRoutes (WU-004)
;(ctx as any)._cronAiService = cronAiService

// --- Module instantiation ---
const refreshOrchestrator = createRefreshOrchestrator(ctx, {
  sessionManager,
  sessionRefreshWorker,
  hydrateSessionsWithAgentSessions: (sessions, opts) =>
    hydrateSessionsWithAgentSessions(ctx, sessions, opts),
})

const sessionHandlers = createSessionHandlers(ctx, {
  updateAgentSessions: () => updateAgentSessions(ctx),
  refreshSessions: refreshOrchestrator.refreshSessions,
  refreshSessionsSync: refreshOrchestrator.refreshSessionsSync,
})

const terminalHandlers = createTerminalHandlers(ctx, {
  scheduleEnterRefresh: refreshOrchestrator.scheduleEnterRefresh,
  setForceWorking: refreshOrchestrator.setForceWorking,
  scheduleLastUserMessageCapture: (sessionId: string) =>
    refreshOrchestrator.scheduleLastUserMessageCapture(sessionId, lastUserMessageLocks, LAST_USER_MESSAGE_LOCK_MS),
})

taskWorker = createTaskWorker(ctx, taskStore)
const taskHandlers = createTaskHandlers(ctx, taskStore)

// --- Workflow engine (WO-009) ---
// Variables declared in outer scope for shutdown cleanup access
let workflowFileWatcher: WorkflowFileWatcher | null = null
let workflowCleanupInterval: ReturnType<typeof setInterval> | null = null
let sessionCleanupInterval: ReturnType<typeof setInterval> | null = null
let cronCleanupInterval: ReturnType<typeof setInterval> | null = null

if (config.workflowEngineEnabled) {
  // Start file watcher — scans workflow YAML dir and watches for changes
  workflowFileWatcher = createWorkflowFileWatcher(ctx, workflowStore)
  workflowFileWatcher.start()

  // Create session pool and workflow engine
  initPoolTables(db.db)
  sessionPoolInstance = createSessionPool(db.db)
  workflowEngineInstance = createWorkflowEngine(ctx, workflowStore, taskStore, sessionPoolInstance)
  workflowEngineInstance.recoverRunningWorkflows()
  workflowEngineInstance.start()

  logger.info('workflow_engine_started', {
    dir: config.workflowDir,
    maxConcurrentRuns: config.workflowMaxConcurrentRuns,
    pollIntervalMs: config.workflowPollIntervalMs,
    retentionDays: config.workflowRunRetentionDays,
  })

  // Schedule periodic run cleanup (every 24h)
  const cleanupIntervalMs = 24 * 60 * 60 * 1000
  const deleted = workflowStore.deleteOldRuns(config.workflowRunRetentionDays)
  if (deleted > 0) logger.info('workflow_cleanup', { deleted })
  workflowCleanupInterval = setInterval(() => {
    const d = workflowStore.deleteOldRuns(config.workflowRunRetentionDays)
    if (d > 0) logger.info('workflow_cleanup', { deleted: d })
  }, cleanupIntervalMs)
}

// --- Session cleanup (every 24h) ---
const cleanupIntervalMs = 24 * 60 * 60 * 1000
const deletedSessions = db.deleteOldInactiveSessions(config.sessionRetentionDays)
if (deletedSessions > 0) {
  logger.info('session_cleanup', {
    deleted: deletedSessions,
    retentionDays: config.sessionRetentionDays,
  })
}
sessionCleanupInterval = setInterval(() => {
  const d = db.deleteOldInactiveSessions(config.sessionRetentionDays)
  if (d > 0) {
    logger.info('session_cleanup', {
      deleted: d,
      retentionDays: config.sessionRetentionDays,
    })
  }
}, cleanupIntervalMs)

// --- Workflow WebSocket handlers (WO-008/WO-009) ---
// Adapts real WorkflowStore to the simplified WorkflowStoreApi interface
const workflowHandlers = config.workflowEngineEnabled
  ? createWorkflowWsHandlers(ctx, {
      listWorkflows: () => workflowStore.listWorkflows(),
      getWorkflow: (id) => workflowStore.getWorkflow(id),
      listRuns: (limit) => workflowStore.listRuns(limit != null ? { limit } : undefined),
      listRunsByWorkflow: (workflowId) => workflowStore.listRunsByWorkflow(workflowId),
      getRun: (runId) => workflowStore.getRun(runId),
      createRun: (workflowId, variables, projectPath) => {
        const workflow = workflowStore.getWorkflow(workflowId)
        if (!workflow) throw new Error(`Workflow not found: ${workflowId}`)
        const parsed = parseWorkflowYAML(workflow.yaml_content)
        if (!parsed.valid || !parsed.workflow) {
          throw new Error('Workflow YAML is invalid')
        }
        const stepsState: StepRunState[] = parsed.workflow.steps.map(step => ({
          name: step.name,
          type: step.type,
          status: 'pending' as const,
          taskId: null,
          startedAt: null,
          completedAt: null,
          errorMessage: null,
          retryCount: 0,
          skippedReason: null,
          resultFile: step.result_file ?? null,
          resultCollected: false,
          resultContent: null,
        }))
        const outputDir = path.join(config.workflowDir, 'runs', `${workflow.name}-${Date.now()}`)
        // Build run variables: merge caller-provided variables with standard paths
        const runVars: Record<string, string> = {
          run_dir: outputDir,
          output_dir: outputDir,
          ...(projectPath ? { project_path: projectPath } : {}),
          ...variables,
        }
        return workflowStore.createRun({
          workflow_id: workflowId,
          workflow_name: workflow.name,
          status: 'running',
          current_step_index: 0,
          steps_state: stepsState,
          output_dir: outputDir,
          started_at: new Date().toISOString(),
          completed_at: null,
          error_message: null,
          variables: runVars,
        })
      },
      updateRun: (runId, updates) => workflowStore.updateRun(runId, updates),
      countActiveRuns: () => workflowStore.getRunningRuns().length,
    }, {
      cancelRun: (runId) => {
        const run = workflowStore.getRun(runId)
        if (run && (run.status === 'running' || run.status === 'pending')) {
          workflowStore.updateRun(runId, {
            status: 'cancelled',
            completed_at: new Date().toISOString(),
            error_message: 'Cancelled by user',
          })
        }
      },
    })
  : null

// --- Cron handlers (WU-002) ---
const cronHandlers = createCronHandlers(ctx, cronManager, cronHistoryService, cronLogService)

// --- Cron cleanup scheduling (REQ-98, REQ-101) ---
// Deferred initial cleanup: wait for first poll to populate jobCache
const cronCleanupDelayMs = 30_000
setTimeout(() => {
  if (cronManager.jobCache.size > 0) {
    cronManager.cleanOrphanedPrefs([...cronManager.jobCache.keys()])
    cronManager.pruneRunHistory()
    logger.info('cron_cleanup_initial', { jobCount: cronManager.jobCache.size })
  }
}, cronCleanupDelayMs)

// Periodic cleanup every 24h (same cadence as workflow/session cleanup)
const cronCleanupIntervalMs = 24 * 60 * 60 * 1000
cronCleanupInterval = setInterval(() => {
  if (cronManager.jobCache.size > 0) {
    cronManager.cleanOrphanedPrefs([...cronManager.jobCache.keys()])
    cronManager.pruneRunHistory()
    logger.info('cron_cleanup', { jobCount: cronManager.jobCache.size })
  }
}, cronCleanupIntervalMs)

// --- HTTP routes ---
const tlsEnabled = !!(config.tlsCert && config.tlsKey)
registerHttpRoutes(app, ctx, tlsEnabled, historyService, sessionPoolInstance)
registerWoRoutes(app)
registerSwarmRoutes(app, swarmManager)

// --- Stats ---
function getStats(): DashboardStats {
  const sessions = registry.getAll?.() ?? []
  const activeSessions = Array.isArray(sessions) ? sessions.length : 0
  const tasks = taskStore.listTasks({ limit: 1000 })
  const totalTasks = tasks.length
  const runningTasks = tasks.filter((t: { status: string }) => t.status === 'running').length
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const completedTasksToday = tasks.filter((t: { status: string; completedAt?: string }) => {
    if (t.status !== 'completed' || !t.completedAt) return false
    return new Date(t.completedAt).getTime() >= today.getTime()
  }).length
  const groups = swarmManager.getGroups()
  let activeDispatches = 0
  let completedDispatches = 0
  let totalWosCompleted = 0
  let totalWosFailed = 0
  for (const group of groups) {
    if (group.status === 'running' || group.status === 'pending') activeDispatches++
    else completedDispatches++
    totalWosCompleted += group.completedWos
    totalWosFailed += group.failedWos
  }
  return {
    activeSessions, totalTasks, runningTasks, completedTasksToday,
    activeDispatches, completedDispatches, totalWosCompleted, totalWosFailed,
    uptimeSeconds: Math.floor(process.uptime()),
    lastUpdated: new Date().toISOString(),
  }
}
registerStatsRoutes(app, getStats)
const metricsStore = new MetricsStore(db.db)
swarmManager.setMetricsStore(metricsStore)
registerTicketRoutes(app, (msg) => broadcast(msg as import('../shared/types').ServerMessage), `http://localhost:${config.port}`, metricsStore)

app.use('/*', serveStatic({ root: './dist/client' }))

// --- Registry event wiring ---
wireRegistryEvents(registry, broadcast)
const unsubscribeSwarmEvents = swarmManager.onEvent((event) => {
  broadcastSwarmEvent(event)
})

// Broadcast stats every 5 seconds
setInterval(() => {
  broadcast({ type: 'stats-update', stats: getStats() })
}, 5000)

// --- Startup state logging ---
const startupActiveSessions = db.getActiveSessions()
const startupWindows = sessionManager.listWindows()
logger.info('startup_state', {
  activeSessionCount: startupActiveSessions.length,
  windowCount: startupWindows.length,
  activeWindows: startupActiveSessions.map((s) => ({
    sessionId: s.sessionId.slice(0, 8),
    name: s.displayName,
    window: s.currentWindow,
  })),
  tmuxWindows: startupWindows.map((w) => ({
    tmuxWindow: w.tmuxWindow,
    name: w.name,
  })),
})

// Detect systemd availability for cron manager
cronManager.detectSystemd().catch(() => {})

// Cron AI: generate MCP config and skill file at startup (WU-004, REQ-15/REQ-16)
cronAiService.generateMcpConfig(config.port).catch((err) => {
  logger.warn('cron_ai_mcp_config_failed', { error: String(err) })
})
cronAiService.generateSkillFile().catch((err) => {
  logger.warn('cron_ai_skill_file_failed', { error: String(err) })
})

// --- Initial data load ---
refreshOrchestrator.refreshSessionsSync({ verifyAssociations: true })
resurrectPinnedSessions(ctx)
refreshOrchestrator.refreshSessionsSync()
setInterval(refreshOrchestrator.refreshSessions, config.refreshIntervalMs)
if (config.logPollIntervalMs > 0) {
  logPoller.start(config.logPollIntervalMs)
}
taskWorker.start()

// --- WebSocket handler map ---
const wsHandlers = {
  onSessionRefresh: refreshOrchestrator.refreshSessions,
  onSessionCreate: sessionHandlers.handleCreate,
  onSessionKill: sessionHandlers.handleKill,
  onSessionRename: (ws: ServerWebSocket<WSData>, sessionId: string, newName: string) =>
    sessionHandlers.handleRename(ws, sessionId, newName),
  onSessionResume: sessionHandlers.handleSessionResume,
  onSessionPin: sessionHandlers.handleSessionPin,
  onTerminalAttach: (ws: ServerWebSocket<WSData>, message: any) =>
    void terminalHandlers.attachTerminalPersistent(ws, message),
  onTerminalDetach: terminalHandlers.detachTerminalPersistent,
  onTerminalInput: terminalHandlers.handleTerminalInputPersistent,
  onTerminalResize: terminalHandlers.handleTerminalResizePersistent,
  onCancelCopyMode: terminalHandlers.handleCancelCopyMode,
  onCheckCopyMode: terminalHandlers.handleCheckCopyMode,
  onTaskCreate: taskHandlers.handleTaskCreate,
  onTaskCancel: taskHandlers.handleTaskCancel,
  onTaskRetry: taskHandlers.handleTaskRetry,
  onTaskListRequest: taskHandlers.handleTaskListRequest,
  onTemplateListRequest: taskHandlers.handleTemplateListRequest,
  // Workflow engine handlers (WO-008) - only wired when engine is enabled
  ...(workflowHandlers && {
    onWorkflowListRequest: workflowHandlers.handleWorkflowListRequest,
    onWorkflowRunListRequest: workflowHandlers.handleWorkflowRunListRequest,
    onWorkflowRun: workflowHandlers.handleWorkflowRun,
    onWorkflowRunResume: workflowHandlers.handleWorkflowRunResume,
    onWorkflowRunCancel: workflowHandlers.handleWorkflowRunCancel,
  }),
  // Cron Manager handlers (WU-002)
  onCronJobSelect: cronHandlers.handleCronJobSelect.bind(cronHandlers),
  onCronJobRunNow: cronHandlers.handleCronJobRunNow.bind(cronHandlers),
  onCronJobPause: cronHandlers.handleCronJobPause.bind(cronHandlers),
  onCronJobResume: cronHandlers.handleCronJobResume.bind(cronHandlers),
  onCronJobEditFrequency: cronHandlers.handleCronJobEditFrequency.bind(cronHandlers),
  onCronJobDelete: cronHandlers.handleCronJobDelete.bind(cronHandlers),
  onCronJobCreate: (ws: ServerWebSocket<WSData>, mode: string, cfg: unknown) =>
    cronHandlers.handleCronJobCreate(ws, mode as 'cron' | 'systemd', cfg),
  onCronBulkPause: cronHandlers.handleCronBulkPause.bind(cronHandlers),
  onCronBulkResume: cronHandlers.handleCronBulkResume.bind(cronHandlers),
  onCronBulkDelete: cronHandlers.handleCronBulkDelete.bind(cronHandlers),
  onCronJobSetTags: cronHandlers.handleCronJobSetTags.bind(cronHandlers),
  onCronJobSetManaged: cronHandlers.handleCronJobSetManaged.bind(cronHandlers),
  onCronJobLinkSession: cronHandlers.handleCronJobLinkSession.bind(cronHandlers),
  onCronSudoAuth: cronHandlers.handleCronSudoAuth.bind(cronHandlers),
  onCronJobLogs: cronHandlers.handleCronJobLogs.bind(cronHandlers),
  onCronJobHistory: cronHandlers.handleCronJobHistory.bind(cronHandlers),
  // Cron AI Orchestrator handlers (WU-004)
  onCronAiContextUpdate: (_ws: ServerWebSocket<WSData>, context: import('../shared/types').UiContext) => {
    cronAiService.updateContext(context)
  },
  onCronAiProposalResponse: (_ws: ServerWebSocket<WSData>, id: string, approved: boolean, feedback?: string) => {
    const result = cronAiService.resolveProposal(id, approved, feedback)
    broadcast({ type: 'cron-ai-proposal-resolved', id, status: approved ? 'accepted' : 'rejected', feedback })
    cronAiService.forwardToMcp({ type: 'proposal_resolved', id, ...result })
  },
  onCronAiDrawerOpen: (_ws: ServerWebSocket<WSData>) => {
    broadcast({ type: 'cron-ai-session-status', status: 'starting' })
    cronAiService.createAiSession().then(({ sessionId, tmuxTarget }) => {
      refreshOrchestrator.refreshSessionsSync()
      broadcast({ type: 'cron-ai-session-status', status: 'waiting', windowId: tmuxTarget, sessionId })
    }).catch((err) => {
      console.error('[cron-ai] Failed to create AI session on drawer open:', err)
      broadcast({ type: 'cron-ai-session-status', status: 'offline' })
    })
  },
  onCronAiDrawerClose: (_ws: ServerWebSocket<WSData>) => {
    // Session persists after drawer close — no action needed
  },
  onCronAiNewConversation: (_ws: ServerWebSocket<WSData>) => {
    broadcast({ type: 'cron-ai-session-status', status: 'starting' })
    cronAiService.killAiSession().catch((err) => {
      console.error('[cron-ai] Failed to kill AI session for new conversation:', err)
    }).finally(() => {
      cronAiService.createAiSession().then(({ sessionId, tmuxTarget }) => {
        refreshOrchestrator.refreshSessionsSync()
        broadcast({ type: 'cron-ai-session-status', status: 'waiting', windowId: tmuxTarget, sessionId })
      }).catch((err) => {
        console.error('[cron-ai] Failed to create AI session for new conversation:', err)
        broadcast({ type: 'cron-ai-session-status', status: 'offline' })
      })
    })
  },
  onCronAiMcpRegister: (ws: ServerWebSocket<WSData>) => {
    const success = cronAiService.registerMcpClient(ws)
    send(ws, { type: 'cron-ai-mcp-register', success })
  },
  onCronAiNavigate: (_ws: ServerWebSocket<WSData>, action: string, payload: Record<string, unknown>) => {
    broadcast({ type: 'cron-ai-navigate', action, payload })
  },
}

// --- Server ---
const serverOptions = {
  port: config.port,
  hostname: config.hostname,
  ...(tlsEnabled && {
    tls: {
      cert: Bun.file(config.tlsCert!),
      key: Bun.file(config.tlsKey!),
    },
  }),
  fetch(req, server: any) {
    const url = new URL(req.url)
    if (url.pathname === '/ws') {
      if (
        server.upgrade(req, {
          data: {
            terminal: null,
            currentSessionId: null,
            currentTmuxTarget: null,
            connectionId: createConnectionId(),
            authenticated: !config.authToken,
          },
        })
      ) {
        return
      }
      return new Response('WebSocket upgrade failed', { status: 400 })
    }

    return app.fetch(req)
  },
  websocket: {
    open(ws: any) {
      sockets.add(ws)
      // If no auth configured (dev mode), send initial data immediately
      // Otherwise, wait for auth message before sending session data
      if (!config.authToken) {
        sendInitialWsState(ws)
      }
    },
    message(ws: any, message: any) {
      const wasAuthenticated = ws.data.authenticated
      handleMessage(ws, message, wsHandlers, send, config.authToken)
      // If this message just authenticated the connection, send initial data now
      if (!wasAuthenticated && ws.data.authenticated) {
        sendInitialWsState(ws)
      }
    },
    close(ws: any) {
      cronHandlers.onClientDisconnect(ws)
      cronAiService.unregisterMcpClient()
      terminalHandlers.cleanupTerminals(ws)
      sockets.delete(ws)
    },
  },
}

Bun.serve<WSData>(serverOptions)

const protocol = tlsEnabled ? 'https' : 'http'
const displayHost = config.hostname === '0.0.0.0' ? 'localhost' : config.hostname
logger.info('server_started', {
  url: `${protocol}://${displayHost}:${config.port}`,
  tailscaleUrl: config.hostname === '0.0.0.0' ? (() => {
    const tsIp = getTailscaleIp()
    return tsIp ? `${protocol}://${tsIp}:${config.port}` : null
  })() : null,
})

// --- Cleanup ---
function cleanupAllTerminals() {
  // Kill AI session before shutdown (WU-004, REQ-70)
  cronAiService.killAiSession().catch(() => {})
  unsubscribeSwarmEvents()

  // Stop workflow engine and file watcher
  if (workflowEngineInstance) workflowEngineInstance.stop()
  if (workflowFileWatcher) workflowFileWatcher.stop()
  if (workflowCleanupInterval) clearInterval(workflowCleanupInterval)
  if (sessionCleanupInterval) clearInterval(sessionCleanupInterval)
  if (cronCleanupInterval) clearInterval(cronCleanupInterval)

  taskWorker.stop()
  for (const ws of sockets) {
    terminalHandlers.cleanupTerminals(ws)
  }
  logPoller.stop()
  cronManager.stopPolling()
  cronManager.clearSudoCredential()
  db.close()
}

process.on('SIGINT', () => {
  cleanupAllTerminals()
  process.exit(0)
})

process.on('SIGTERM', () => {
  cleanupAllTerminals()
  process.exit(0)
})
