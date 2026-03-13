// httpRoutes.ts - All HTTP route handlers
import type { Hono } from 'hono'
import path from 'node:path'
import fs from 'node:fs/promises'
import { resolveProjectPath } from './paths'
import { getTailscaleIp } from './startup'
import { isValidSessionId, isValidTaskId, MAX_FIELD_LENGTH } from './validators'
import type { ServerContext } from './serverContext'
import type {
  DirectoryListing,
  DirectoryErrorResponse,
} from '../shared/types'
import { createWorkflowHandlers } from './handlers/workflowHandlers'
import { createPoolHandlers } from './handlers/poolHandlers'
import type { SessionPool } from './sessionPool'
import { toAgentSession } from './agentSessions'
import { CronAiService } from './cronAiService'

const MAX_DIRECTORY_ENTRIES = 200

// Sensitive path segments that should always be blocked in directory browsing
const SENSITIVE_PATH_SEGMENTS = ['.ssh', '.env', '.claude/settings', 'credentials']

/**
 * Check if a resolved path is under any of the allowed roots.
 * Returns true if allowed (or if no roots are configured).
 */
function isPathAllowed(resolved: string, allowedRoots: string[]): boolean {
  if (allowedRoots.length === 0) return true
  const normalizedPath = resolved.endsWith('/') ? resolved : resolved + '/'
  return allowedRoots.some((root) => {
    const normalizedRoot = root.endsWith('/') ? root : root + '/'
    return resolved === root || normalizedPath.startsWith(normalizedRoot)
  })
}

/**
 * Check if a path contains any sensitive directory segments.
 */
function containsSensitiveSegment(resolved: string): boolean {
  return SENSITIVE_PATH_SEGMENTS.some((segment) => resolved.includes(segment))
}

export function registerHttpRoutes(app: Hono, ctx: ServerContext, tlsEnabled: boolean, historyService?: import('./HistoryService').HistoryService, pool?: SessionPool | null): void {
  const authToken = ctx.config.authToken

  // Auth middleware for /api/* routes
  // If AUTH_TOKEN is not configured, skip auth (dev mode)
  app.use('/api/*', async (c, next) => {
    // No auth configured = dev mode, skip
    if (!authToken) {
      return next()
    }

    // Health endpoint is always public (for monitoring)
    if (c.req.path === '/api/health') {
      return next()
    }

    // Auth check endpoint is always public (client uses it to test token validity)
    if (c.req.path === '/api/auth-check') {
      return next()
    }

    const authorization = c.req.header('Authorization')
    if (!authorization) {
      return c.json({ error: 'Unauthorized', message: 'Missing Authorization header' }, 401)
    }

    const parts = authorization.split(' ')
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return c.json({ error: 'Unauthorized', message: 'Invalid Authorization format' }, 401)
    }

    if (parts[1] !== authToken) {
      return c.json({ error: 'Unauthorized', message: 'Invalid token' }, 401)
    }

    return next()
  })

  app.get('/api/health', (c) => c.json({ ok: true }))

  // Auth check endpoint - validates the token and returns auth status
  app.get('/api/auth-check', (c) => {
    if (!authToken) {
      return c.json({ authenticated: true, authRequired: false })
    }

    const authorization = c.req.header('Authorization')
    if (!authorization) {
      return c.json({ authenticated: false, authRequired: true })
    }

    const parts = authorization.split(' ')
    if (parts.length !== 2 || parts[0] !== 'Bearer' || parts[1] !== authToken) {
      return c.json({ authenticated: false, authRequired: true })
    }

    return c.json({ authenticated: true, authRequired: true })
  })

  app.get('/api/sessions', (c) => c.json(ctx.registry.getAll()))

  app.delete('/api/sessions/:sessionId', (c) => {
    const sessionId = c.req.param('sessionId')
    if (!isValidSessionId(sessionId)) {
      return c.json({ error: 'Invalid session id' }, 400)
    }

    const session = ctx.db.getSessionById(sessionId)
    if (!session) {
      return c.json({ error: 'Session not found' }, 404)
    }

    // Only allow deleting inactive sessions (safety check)
    if (session.currentWindow !== null) {
      return c.json({ error: 'Cannot delete active session' }, 400)
    }

    const deleted = ctx.db.deleteInactiveSession(sessionId)
    if (!deleted) {
      return c.json({ error: 'Failed to delete session' }, 500)
    }

    // Broadcast update to all clients
    ctx.broadcast({
      type: 'agent-sessions',
      active: ctx.db.getActiveSessions().map(toAgentSession),
      inactive: ctx.db
        .getInactiveSessions({ maxAgeHours: ctx.config.inactiveSessionMaxAgeHours })
        .map(toAgentSession),
    })

    return c.json({ ok: true })
  })

  app.delete('/api/sessions/inactive/all', (c) => {
    const deleted = ctx.db.deleteOldInactiveSessions(0) // Delete all inactive sessions
    ctx.logger.info('session_manual_cleanup', { deleted })

    // Broadcast update to all clients
    ctx.broadcast({
      type: 'agent-sessions',
      active: ctx.db.getActiveSessions().map(toAgentSession),
      inactive: ctx.db
        .getInactiveSessions({ maxAgeHours: ctx.config.inactiveSessionMaxAgeHours })
        .map(toAgentSession),
    })

    return c.json({ ok: true, deleted })
  })

  app.get('/api/session-preview/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId')
    if (!isValidSessionId(sessionId)) {
      return c.json({ error: 'Invalid session id' }, 400)
    }

    const record = ctx.db.getSessionById(sessionId)
    if (!record) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const logPath = record.logFilePath
    if (!logPath) {
      return c.json({ error: 'No log file for session' }, 404)
    }

    try {
      const stats = await fs.stat(logPath)
      if (!stats.isFile()) {
        return c.json({ error: 'Log file not found' }, 404)
      }

      // Read last 64KB of the file
      const TAIL_BYTES = 64 * 1024
      const fileSize = stats.size
      const offset = Math.max(0, fileSize - TAIL_BYTES)
      const fd = await fs.open(logPath, 'r')
      const buffer = Buffer.alloc(Math.min(TAIL_BYTES, fileSize))
      await fd.read(buffer, 0, buffer.length, offset)
      await fd.close()

      const content = buffer.toString('utf8')
      // Take last 100 lines
      const lines = content.split('\n').slice(-100)

      return c.json({
        sessionId,
        displayName: record.displayName,
        projectPath: record.projectPath,
        agentType: record.agentType,
        lastActivityAt: record.lastActivityAt,
        lines,
      })
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        return c.json({ error: 'Log file not found' }, 404)
      }
      return c.json({ error: 'Unable to read log file' }, 500)
    }
  })

  app.get('/api/directories', async (c) => {
    const requestedPath = c.req.query('path') ?? '~'

    if (requestedPath.length > MAX_FIELD_LENGTH) {
      const payload: DirectoryErrorResponse = {
        error: 'invalid_path',
        message: 'Path too long',
      }
      return c.json(payload, 400)
    }

    const trimmedPath = requestedPath.trim()
    if (!trimmedPath) {
      const payload: DirectoryErrorResponse = {
        error: 'invalid_path',
        message: 'Path is required',
      }
      return c.json(payload, 400)
    }

    const start = Date.now()
    const resolved = resolveProjectPath(trimmedPath)

    // Filesystem restriction: check allowed roots
    if (!isPathAllowed(resolved, ctx.config.allowedRoots)) {
      const payload: DirectoryErrorResponse = {
        error: 'forbidden',
        message: 'Path is outside allowed directories',
      }
      return c.json(payload, 403)
    }

    // Block sensitive directories
    if (containsSensitiveSegment(resolved)) {
      const payload: DirectoryErrorResponse = {
        error: 'forbidden',
        message: 'Access to sensitive directories is not allowed',
      }
      return c.json(payload, 403)
    }

    let stats: Awaited<ReturnType<typeof fs.stat>>
    try {
      stats = await fs.stat(resolved)
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        const payload: DirectoryErrorResponse = {
          error: 'not_found',
          message: 'Path does not exist',
        }
        return c.json(payload, 404)
      }
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        const payload: DirectoryErrorResponse = {
          error: 'forbidden',
          message: 'Permission denied',
        }
        return c.json(payload, 403)
      }
      const payload: DirectoryErrorResponse = {
        error: 'internal_error',
        message: 'Unable to read directory',
      }
      return c.json(payload, 500)
    }

    if (!stats.isDirectory()) {
      const payload: DirectoryErrorResponse = {
        error: 'not_found',
        message: 'Path is not a directory',
      }
      return c.json(payload, 404)
    }

    let directories: DirectoryListing['directories'] = []
    try {
      const entries = await fs.readdir(resolved, {
        withFileTypes: true,
        encoding: 'utf8',
      })
      directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const name = entry.name.toString()
          return {
            name,
            path: path.join(resolved, name),
          }
        })
        .sort((a, b) => {
          const aDot = a.name.startsWith('.')
          const bDot = b.name.startsWith('.')
          if (aDot !== bDot) {
            return aDot ? -1 : 1
          }
          const aLower = a.name.toLowerCase()
          const bLower = b.name.toLowerCase()
          if (aLower < bLower) {
            return -1
          }
          if (aLower > bLower) {
            return 1
          }
          return a.name.localeCompare(b.name)
        })
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        const payload: DirectoryErrorResponse = {
          error: 'forbidden',
          message: 'Permission denied',
        }
        return c.json(payload, 403)
      }
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        const payload: DirectoryErrorResponse = {
          error: 'not_found',
          message: 'Path does not exist',
        }
        return c.json(payload, 404)
      }
      const payload: DirectoryErrorResponse = {
        error: 'internal_error',
        message: 'Unable to list directory',
      }
      return c.json(payload, 500)
    }

    const truncated = directories.length > MAX_DIRECTORY_ENTRIES
    const limitedDirectories = truncated
      ? directories.slice(0, MAX_DIRECTORY_ENTRIES)
      : directories

    const root = path.parse(resolved).root
    const parent = resolved === root ? null : path.dirname(resolved)
    const response: DirectoryListing = {
      path: resolved,
      parent,
      directories: limitedDirectories,
      truncated,
    }

    const durationMs = Date.now() - start
    ctx.logger.debug('directories_request', {
      path: resolved,
      count: limitedDirectories.length,
      truncated,
      durationMs,
    })

    return c.json(response)
  })

  app.get('/api/server-info', (c) => {
    const tailscaleIp = getTailscaleIp()
    return c.json({
      port: ctx.config.port,
      tailscaleIp,
      protocol: tlsEnabled ? 'https' : 'http',
      authEnabled: !!authToken,
    })
  })

  // --- Task queue REST endpoints ---
  app.get('/api/tasks', (c) => {
    const status = c.req.query('status') as import('../shared/types').TaskStatus | undefined
    const limit = Number(c.req.query('limit')) || 100
    const offset = Number(c.req.query('offset')) || 0
    const tasks = ctx.taskStore.listTasks({ status, limit, offset })
    const stats = ctx.taskStore.getStats()
    return c.json({ tasks, stats })
  })

  app.post('/api/tasks', async (c) => {
    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const projectPath = body.projectPath ? String(body.projectPath).trim() : ''
    const prompt = body.prompt ? String(body.prompt).trim() : ''

    if (!projectPath) return c.json({ error: 'projectPath is required' }, 400)
    if (!prompt) return c.json({ error: 'prompt is required' }, 400)
    if (projectPath.length > MAX_FIELD_LENGTH) return c.json({ error: 'projectPath too long' }, 400)
    if (prompt.length > 100_000) return c.json({ error: 'prompt too long' }, 400)

    const priority = body.priority !== undefined ? Number(body.priority) : 5
    const timeoutSeconds = body.timeoutSeconds !== undefined ? Number(body.timeoutSeconds) : 1800
    const maxRetries = body.maxRetries !== undefined ? Number(body.maxRetries) : 0

    const metadata = (body.metadata && typeof body.metadata === 'object')
      ? JSON.stringify(body.metadata)
      : null

    const task = ctx.taskStore.createTask({
      projectPath,
      prompt,
      templateId: null,
      priority,
      status: 'queued',
      maxRetries,
      timeoutSeconds,
      parentTaskId: null,
      followUpPrompt: null,
      metadata,
    })

    ctx.broadcast({ type: 'task-created', task })
    return c.json(task, 201)
  })

  app.get('/api/tasks/:id', (c) => {
    const id = c.req.param('id')
    if (!isValidTaskId(id)) return c.json({ error: 'Invalid task ID' }, 400)
    const task = ctx.taskStore.getTask(id)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    return c.json(task)
  })

  app.get('/api/tasks/:id/output', async (c) => {
    const id = c.req.param('id')
    if (!isValidTaskId(id)) return c.json({ error: 'Invalid task ID' }, 400)
    const task = ctx.taskStore.getTask(id)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    if (!task.outputPath) return c.json({ error: 'No output available' }, 404)

    // Verify output path is within expected directory (defense in depth)
    const resolvedOutput = path.resolve(task.outputPath)
    const resolvedDir = path.resolve(ctx.config.taskOutputDir)
    if (!resolvedOutput.startsWith(resolvedDir + path.sep)) {
      return c.json({ error: 'Invalid output path' }, 403)
    }

    try {
      const content = await fs.readFile(task.outputPath, 'utf8')
      return c.json({ taskId: id, output: content, status: task.status })
    } catch {
      return c.json({ error: 'Output file not found' }, 404)
    }
  })

  app.post('/api/tasks/:id/cancel', async (c) => {
    const id = c.req.param('id')
    if (!isValidTaskId(id)) return c.json({ error: 'Invalid task ID' }, 400)
    const task = ctx.taskStore.getTask(id)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    if (task.status !== 'queued' && task.status !== 'running') {
      return c.json({ error: `Cannot cancel task with status: ${task.status}` }, 400)
    }

    if (task.status === 'running' && task.tmuxWindow) {
      try {
        Bun.spawnSync(['tmux', 'kill-window', '-t', task.tmuxWindow], { stdout: 'pipe', stderr: 'pipe' })
      } catch { /* window may be gone */ }
    }

    // Clean up temp prompt file and sentinel done file
    const safeName = id.replace(/[^A-Za-z0-9_-]/g, '_')
    try { await fs.unlink(`/tmp/agentboard-task-${safeName}.txt`) } catch { /* may not exist */ }
    try { await fs.unlink(path.join(ctx.config.taskOutputDir, `${safeName}.done`)) } catch { /* may not exist */ }

    const updated = ctx.taskStore.updateTask(id, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      completionMethod: 'manual',
    })
    if (updated) ctx.broadcast({ type: 'task-updated', task: updated })
    return c.json(updated)
  })

  app.post('/api/tasks/:id/retry', (c) => {
    const id = c.req.param('id')
    if (!isValidTaskId(id)) return c.json({ error: 'Invalid task ID' }, 400)
    const task = ctx.taskStore.getTask(id)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    if (task.status !== 'failed' && task.status !== 'cancelled') {
      return c.json({ error: `Cannot retry task with status: ${task.status}` }, 400)
    }

    const updated = ctx.taskStore.updateTask(id, {
      status: 'queued',
      retryCount: task.retryCount + 1,
      errorMessage: null,
      completionMethod: null,
      startedAt: null,
      completedAt: null,
      tmuxWindow: null,
      sessionName: null,
      outputPath: null,
    })
    if (updated) ctx.broadcast({ type: 'task-updated', task: updated })
    return c.json(updated)
  })

  app.get('/api/templates', (c) => {
    return c.json(ctx.taskStore.listTemplates())
  })

  app.post('/api/templates', async (c) => {
    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    if (!body.name || !body.promptTemplate) {
      return c.json({ error: 'name and promptTemplate are required' }, 400)
    }
    // Validate variables is valid JSON array
    if (body.variables) {
      try {
        const parsed = JSON.parse(String(body.variables))
        if (!Array.isArray(parsed)) {
          return c.json({ error: 'variables must be a JSON array' }, 400)
        }
      } catch {
        return c.json({ error: 'variables must be valid JSON' }, 400)
      }
    }
    const template = ctx.taskStore.createTemplate({
      name: String(body.name).slice(0, 256),
      promptTemplate: String(body.promptTemplate).slice(0, 100_000),
      variables: String(body.variables ?? '[]').slice(0, 10_000),
      projectPath: body.projectPath ? String(body.projectPath).slice(0, MAX_FIELD_LENGTH) : null,
      priority: Number(body.priority) || 5,
      timeoutSeconds: Number(body.timeoutSeconds) || ctx.config.taskDefaultTimeoutSeconds,
      isDefault: !!body.isDefault,
    })
    ctx.broadcast({ type: 'template-list', templates: ctx.taskStore.listTemplates() })
    return c.json(template, 201)
  })

  app.put('/api/templates/:id', async (c) => {
    const id = c.req.param('id')
    const template = ctx.taskStore.getTemplate(id)
    if (!template) return c.json({ error: 'Template not found' }, 404)

    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    // Validate variables is valid JSON array if provided
    if (body.variables !== undefined && body.variables !== null) {
      try {
        const parsed = JSON.parse(String(body.variables))
        if (!Array.isArray(parsed)) {
          return c.json({ error: 'variables must be a JSON array' }, 400)
        }
      } catch {
        return c.json({ error: 'variables must be valid JSON' }, 400)
      }
    }
    const updated = ctx.taskStore.updateTemplate(id, {
      name: body.name ? String(body.name).slice(0, 256) : undefined,
      promptTemplate: body.promptTemplate ? String(body.promptTemplate).slice(0, 100_000) : undefined,
      variables: body.variables !== undefined ? String(body.variables).slice(0, 10_000) : undefined,
      projectPath: body.projectPath !== undefined ? (body.projectPath ? String(body.projectPath).slice(0, MAX_FIELD_LENGTH) : null) : undefined,
      priority: body.priority !== undefined ? Number(body.priority) : undefined,
      timeoutSeconds: body.timeoutSeconds !== undefined ? Number(body.timeoutSeconds) : undefined,
      isDefault: body.isDefault !== undefined ? !!body.isDefault : undefined,
    })
    ctx.broadcast({ type: 'template-list', templates: ctx.taskStore.listTemplates() })
    return c.json(updated)
  })

  app.delete('/api/templates/:id', (c) => {
    const id = c.req.param('id')
    const deleted = ctx.taskStore.deleteTemplate(id)
    if (!deleted) return c.json({ error: 'Template not found' }, 404)
    ctx.broadcast({ type: 'template-list', templates: ctx.taskStore.listTemplates() })
    return c.json({ ok: true })
  })

  // Image upload endpoint for iOS clipboard paste
  app.post('/api/paste-image', async (c) => {
    try {
      const formData = await c.req.formData()
      const file = formData.get('image') as File | null
      if (!file) {
        return c.json({ error: 'No image provided' }, 400)
      }

      // Generate unique filename in temp directory
      const ext = file.type.split('/')[1] || 'png'
      const filename = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const filepath = `/tmp/${filename}`

      // Write file
      const buffer = await file.arrayBuffer()
      await Bun.write(filepath, buffer)

      return c.json({ path: filepath })
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Upload failed' },
        500
      )
    }
  })

  // --- Chat History API ---
  app.get('/api/history/status', (c) => {
    if (!historyService) {
      return c.json({ enabled: false, mode: null })
    }
    return c.json(historyService.getStatus())
  })

  app.get('/api/history/search', async (c) => {
    if (!historyService?.enabled) {
      return c.json({ error: 'History not enabled' }, 404)
    }
    const q = c.req.query('q') || ''
    const limit = Math.min(Number(c.req.query('limit')) || 50, 200)
    const agent = c.req.query('agent') as 'claude' | 'codex' | undefined
    const validAgent = agent === 'claude' || agent === 'codex' ? agent : undefined

    try {
      const sessions = await historyService.search(q, limit, validAgent)
      return c.json({ sessions })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Search failed'
      if (message === 'Rate limit exceeded') {
        return c.json({ error: message }, 429)
      }
      return c.json({ error: message }, 500)
    }
  })

  app.get('/api/history/recent', async (c) => {
    if (!historyService?.enabled) {
      return c.json({ error: 'History not enabled' }, 404)
    }
    const limit = Math.min(Number(c.req.query('limit')) || 50, 200)
    const agent = c.req.query('agent') as 'claude' | 'codex' | undefined
    const validAgent = agent === 'claude' || agent === 'codex' ? agent : undefined

    try {
      const sessions = await historyService.getRecent(limit, validAgent)
      return c.json({ sessions })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load recent sessions'
      if (message === 'Rate limit exceeded') {
        return c.json({ error: message }, 429)
      }
      return c.json({ error: message }, 500)
    }
  })

  // --- Workflow REST endpoints (conditionally enabled) ---
  if (ctx.config.workflowEngineEnabled) {
    const workflowHandlers = createWorkflowHandlers(ctx, pool)
    workflowHandlers.registerRoutes(app)
    // Phase 5: Pool API (only when pool is available)
    if (pool) {
      const poolHandlers = createPoolHandlers(ctx, pool)
      poolHandlers.registerRoutes(app)
    }
  }

  // --- Phase 24: Telemetry API endpoints ---
  app.get('/api/telemetry/runs/:runId', (c) => {
    const runId = c.req.param('runId')
    if (!runId || runId.length > 64) {
      return c.json({ error: 'Invalid run ID' }, 400)
    }

    try {
      const stmt = ctx.db.db.prepare('SELECT * FROM telemetry_runs WHERE run_id = $runId')
      const runRow = stmt.get({ $runId: runId }) as Record<string, unknown> | undefined

      if (!runRow) {
        return c.json({ error: 'Telemetry not found for run' }, 404)
      }

      // Get step telemetry
      const stepsStmt = ctx.db.db.prepare('SELECT * FROM telemetry_steps WHERE run_id = $runId ORDER BY started_at')
      const stepRows = stepsStmt.all({ $runId: runId }) as Record<string, unknown>[]

      return c.json({
        run: {
          run_id: String(runRow.run_id),
          pipeline_type: String(runRow.pipeline_type ?? 'unknown'),
          tier: Number(runRow.tier ?? 1),
          total_tokens: Number(runRow.total_tokens ?? 0),
          estimated_cost_usd: Number(runRow.estimated_cost_usd ?? 0),
          wall_clock_ms: runRow.wall_clock_ms != null ? Number(runRow.wall_clock_ms) : null,
          quality_score: runRow.quality_score != null ? Number(runRow.quality_score) : null,
          started_at: Number(runRow.started_at ?? 0),
          completed_at: runRow.completed_at != null ? Number(runRow.completed_at) : null,
        },
        steps: stepRows.map(row => ({
          id: Number(row.id),
          step_name: String(row.step_name ?? ''),
          model: row.model != null ? String(row.model) : null,
          input_tokens: Number(row.input_tokens ?? 0),
          output_tokens: Number(row.output_tokens ?? 0),
          duration_ms: row.duration_ms != null ? Number(row.duration_ms) : null,
          status: String(row.status ?? 'completed'),
          started_at: Number(row.started_at ?? 0),
          completed_at: row.completed_at != null ? Number(row.completed_at) : null,
        })),
      })
    } catch {
      return c.json({ error: 'Failed to fetch telemetry' }, 500)
    }
  })

  app.get('/api/telemetry/daily', (c) => {
    const days = Math.min(Number(c.req.query('days')) || 7, 30)
    const endDate = new Date().toISOString().split('T')[0]
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

    try {
      const stmt = ctx.db.db.prepare(
        'SELECT * FROM telemetry_daily WHERE date >= $startDate AND date <= $endDate ORDER BY date'
      )
      const rows = stmt.all({ $startDate: startDate, $endDate: endDate }) as Record<string, unknown>[]

      return c.json({
        days: rows.map(row => ({
          date: String(row.date ?? ''),
          total_runs: Number(row.total_runs ?? 0),
          total_tokens: Number(row.total_tokens ?? 0),
          total_cost_usd: Number(row.total_cost_usd ?? 0),
          avg_wall_clock_ms: row.avg_wall_clock_ms != null ? Number(row.avg_wall_clock_ms) : null,
          avg_quality_score: row.avg_quality_score != null ? Number(row.avg_quality_score) : null,
        })),
      })
    } catch {
      return c.json({ error: 'Failed to fetch daily aggregates' }, 500)
    }
  })

  app.get('/api/telemetry/cost-summary', (c) => {
    try {
      // Cost by model
      const byModelStmt = ctx.db.db.prepare(`
        SELECT
          COALESCE(model, 'unknown') as model,
          COUNT(*) as runs,
          SUM(input_tokens + output_tokens) as tokens,
          SUM(input_tokens) as input_tokens,
          SUM(output_tokens) as output_tokens
        FROM telemetry_steps
        GROUP BY model
        ORDER BY tokens DESC
      `)
      const byModelRows = byModelStmt.all() as Array<{
        model: string
        runs: number
        tokens: number
        input_tokens: number
        output_tokens: number
      }>

      // Cost by pipeline
      const byPipelineStmt = ctx.db.db.prepare(`
        SELECT
          pipeline_type as pipeline,
          COUNT(*) as runs,
          SUM(total_tokens) as tokens,
          SUM(estimated_cost_usd) as cost
        FROM telemetry_runs
        GROUP BY pipeline_type
        ORDER BY cost DESC
      `)
      const byPipelineRows = byPipelineStmt.all() as Array<{
        pipeline: string
        runs: number
        tokens: number
        cost: number
      }>

      // Total summary
      const totalStmt = ctx.db.db.prepare(`
        SELECT
          COUNT(*) as total_runs,
          SUM(total_tokens) as total_tokens,
          SUM(estimated_cost_usd) as total_cost
        FROM telemetry_runs
        WHERE completed_at IS NOT NULL
      `)
      const totalRow = totalStmt.get() as {
        total_runs: number
        total_tokens: number
        total_cost: number
      } | undefined

      return c.json({
        summary: {
          total_runs: totalRow?.total_runs ?? 0,
          total_tokens: totalRow?.total_tokens ?? 0,
          total_cost_usd: totalRow?.total_cost ?? 0,
        },
        by_model: byModelRows.map(r => ({
          model: r.model,
          runs: r.runs,
          tokens: r.tokens,
          input_tokens: r.input_tokens,
          output_tokens: r.output_tokens,
        })),
        by_pipeline: byPipelineRows.map(r => ({
          pipeline: r.pipeline,
          runs: r.runs,
          tokens: r.tokens,
          cost_usd: r.cost,
        })),
      })
    } catch {
      return c.json({ error: 'Failed to fetch cost summary' }, 500)
    }
  })

  // --- Cron AI Orchestrator REST endpoints (WU-004) ---
  // CronAiService can be pre-created (index.ts) or auto-created with fallback deps
  const cronAiService: CronAiService = (ctx as any)._cronAiService ?? (() => {
    // Lightweight stub for test/dev — no real CronManager available
    const stubJob = {
      id: 'job-1', name: 'stub-job', command: 'echo ok', schedule: '* * * * *',
      source: 'cron' as const, user: 'test', enabled: true, nextRun: null, lastRun: null,
      health: 'healthy' as const, tags: [], projectGroup: null, managed: false,
      linkedSessionId: null, avatarUrl: null,
    }
    const cache = new Map([[stubJob.id, stubJob]])
    return new CronAiService(
      {
        cronManager: { discoverAllJobs: async () => [stubJob], jobCache: cache },
        historyService: { getRunHistory: async () => [], getRecentDurations: async () => [] },
        logService: { getLogs: async () => [] },
        sessionManager: ctx.sessionManager,
      },
      { port: ctx.config.port, authToken: ctx.config.authToken }
    )
  })()

  // Auth middleware specific to cron-ai routes (uses CronAiService.validateAuth)
  app.use('/api/cron-ai/*', async (c, next) => {
    if (!ctx.config.authToken) return next()
    const authHeader = c.req.header('Authorization')
    if (!cronAiService.validateAuth(authHeader)) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    return next()
  })

  app.get('/api/cron-ai/jobs', async (c) => {
    try {
      const group = c.req.query('group')
      const jobs = await cronAiService.handleGetJobs(group ? { group } : undefined)
      return c.json(jobs)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to get jobs' }, 500)
    }
  })

  app.get('/api/cron-ai/jobs/search', async (c) => {
    try {
      const q = c.req.query('q') || ''
      const jobs = await cronAiService.handleSearchJobs(q)
      return c.json(jobs)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Search failed' }, 500)
    }
  })

  app.get('/api/cron-ai/jobs/:id/history', async (c) => {
    try {
      const jobId = c.req.param('id')
      const limit = Number(c.req.query('limit')) || 20
      const before = c.req.query('before')
      const history = await cronAiService.handleGetJobHistory(jobId, limit, before ?? undefined)
      return c.json(history)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to get history' }, 500)
    }
  })

  app.get('/api/cron-ai/jobs/:id/logs', async (c) => {
    try {
      const jobId = c.req.param('id')
      const lines = Number(c.req.query('lines')) || 50
      const offset = c.req.query('offset') ? Number(c.req.query('offset')) : undefined
      const logs = await cronAiService.handleGetJobLogs(jobId, lines, offset)
      return c.json(logs)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to get logs' }, 500)
    }
  })

  app.get('/api/cron-ai/jobs/:id/duration-trends', async (c) => {
    try {
      const jobId = c.req.param('id')
      const trends = await cronAiService.handleGetDurationTrends(jobId)
      return c.json(trends)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to get trends' }, 500)
    }
  })

  app.get('/api/cron-ai/jobs/:id', async (c) => {
    try {
      const jobId = c.req.param('id')
      const detail = await cronAiService.handleGetJobDetail(jobId)
      return c.json(detail)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get job'
      return c.json({ error: message }, message.startsWith('Job not found') ? 404 : 500)
    }
  })

  app.get('/api/cron-ai/health', async (c) => {
    try {
      const health = await cronAiService.handleGetHealth()
      return c.json(health)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to get health' }, 500)
    }
  })

  app.get('/api/cron-ai/health/failing', async (c) => {
    try {
      const failing = await cronAiService.handleGetFailingJobs()
      return c.json(failing)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to get failing jobs' }, 500)
    }
  })

  app.get('/api/cron-ai/schedule/conflicts', async (c) => {
    try {
      const conflicts = await cronAiService.handleGetScheduleConflicts()
      return c.json(conflicts)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to get conflicts' }, 500)
    }
  })

  app.get('/api/cron-ai/schedule/load', async (c) => {
    try {
      const load = await cronAiService.handleGetScheduleLoad()
      return c.json(load)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to get load' }, 500)
    }
  })

  app.get('/api/cron-ai/context', async (c) => {
    try {
      const context = await cronAiService.handleGetContext()
      return c.json(context ?? {})
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to get context' }, 500)
    }
  })

  app.get('/api/cron-ai/sessions', async (c) => {
    try {
      const sessions = await cronAiService.handleGetSessions()
      return c.json(sessions)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to get sessions' }, 500)
    }
  })

  app.get('/api/cron-ai/ai-health', async (c) => {
    try {
      const health = await cronAiService.handleGetAiHealth()
      return c.json(health)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to get AI health' }, 500)
    }
  })

  app.post('/api/cron-ai/proposals', async (c) => {
    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }
    try {
      // createProposal returns a Promise that resolves on user accept/reject/timeout.
      // Don't await the full resolution — respond with 201 once queued.
      const proposalPromise = cronAiService.handlePostProposal(body)
      // Race against a short timer: if the promise hasn't resolved/rejected
      // synchronously, the proposal was queued successfully.
      const raceResult = await Promise.race([
        proposalPromise.then((r) => ({ type: 'resolved' as const, result: r })),
        new Promise<{ type: 'queued' }>((resolve) => setTimeout(() => resolve({ type: 'queued' }), 50)),
      ])
      if (raceResult.type === 'queued') {
        return c.json({ status: 'pending' }, 201)
      }
      return c.json(raceResult.result, 201)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Failed to create proposal' }, 400)
    }
  })

  app.post('/api/history/resume', async (c) => {
    if (!historyService?.enabled) {
      return c.json({ error: 'History not enabled' }, 404)
    }

    try {
      const body = await c.req.json()
      const { sessionId, agentType } = body as { sessionId?: string; agentType?: string }

      if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 256) {
        return c.json({ error: 'Invalid session ID' }, 400)
      }
      if (agentType !== 'claude' && agentType !== 'codex') {
        return c.json({ error: 'Invalid agent type' }, 400)
      }

      const resumeCmd = agentType === 'claude'
        ? ctx.config.claudeResumeCmd.replace('{sessionId}', sessionId)
        : ctx.config.codexResumeCmd.replace('{sessionId}', sessionId)

      const windowName = `resume-${sessionId.slice(0, 8)}`
      const tmuxSession = ctx.config.tmuxSession
      const result = Bun.spawnSync(
        ['tmux', 'new-window', '-t', tmuxSession, '-n', windowName, 'sh', '-c', resumeCmd],
        { stdout: 'pipe', stderr: 'pipe' }
      )

      if (result.exitCode !== 0) {
        return c.json({ error: `Failed to resume: ${result.stderr.toString()}` }, 500)
      }

      return c.json({ ok: true, window: `${tmuxSession}:${windowName}` })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Resume failed' }, 500)
    }
  })
}
