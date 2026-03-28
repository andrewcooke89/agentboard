/**
 * ticketRoutes.ts — Ticket and nightly report API routes.
 * Proxies the FileStorage ticket system to the frontend dashboard.
 */

import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { FileStorage } from '/home/andrew-cooke/tools/mcp-servers/ticket-system/src/storage/file-storage'
import { MetricsStore, type NightlyReport } from './metricsStore'
import { fileLockRegistry } from './fileLockRegistry'

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProjectConfig {
  path: string
  language: string
  fix_model: string
  fix_model_medium?: string
  auto_merge_efforts?: string[]
}

interface MinionConfig {
  projects: ProjectConfig[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadMinionConfig(): MinionConfig {
  const configPath = path.join(process.env.HOME ?? '/root', '.agentboard', 'minion-projects.yaml')
  if (!fs.existsSync(configPath)) return { projects: [] }
  try {
    const raw = yaml.load(fs.readFileSync(configPath, 'utf8')) as any
    if (!raw?.projects || !Array.isArray(raw.projects)) return { projects: [] }
    return raw as MinionConfig
  } catch {
    return { projects: [] }
  }
}

function getStorageForProject(projectPath: string): FileStorage {
  return new FileStorage(projectPath)
}

function getReportDir(): string {
  return path.join(process.env.HOME ?? '/root', '.agentboard', 'reports')
}

// ─── Route Registration ─────────────────────────────────────────────────────

export function registerTicketRoutes(
  app: Hono,
  broadcastFn: (message: Record<string, unknown>) => void,
  baseUrl: string = 'http://localhost:4040',
  metricsStore?: MetricsStore,
): void {
  // ── Ticket Routes ──────────────────────────────────────────────────────

  // GET /api/tickets — list tickets with optional filters
  app.get('/api/tickets', (c) => {
    const projectPath = c.req.query('project')
    if (!projectPath) {
      // Default to first project in config
      const config = loadMinionConfig()
      if (config.projects.length === 0) return c.json({ error: 'No projects configured' }, 400)
      const storage = getStorageForProject(config.projects[0].path)
      return listTickets(c, storage)
    }
    const storage = getStorageForProject(projectPath)
    return listTickets(c, storage)
  })

  function listTickets(c: any, storage: FileStorage) {
    const status = c.req.query('status') || undefined
    const sort_by = c.req.query('sort_by') || 'created'
    const sort_order = c.req.query('sort_order') || 'desc'
    const limit = parseInt(c.req.query('limit') || '100', 10)
    const offset = parseInt(c.req.query('offset') || '0', 10)

    const result = storage.listTickets({
      status: status as any,
      sort_by: sort_by as any,
      sort_order: sort_order as any,
      limit,
      offset,
    })

    // Enrich with full ticket data for effort/category/notes
    const enriched = result.tickets.map(summary => {
      const full = storage.getTicket(summary.id)
      return full ? {
        id: full.id,
        title: full.title,
        status: full.status,
        severity: full.severity,
        category: full.category,
        effort: full.effort,
        source: { file: full.source.file, line_start: full.source.line_start },
        found_by: full.found_by,
        tags: full.tags,
        created_at: full.created_at,
        updated_at: full.updated_at,
        notes_count: full.notes?.length ?? 0,
        is_blocked: full.notes?.some((n: any) => n.content.includes('Auto-blocked')) ?? false,
      } : summary
    })

    return c.json({ tickets: enriched, total: result.total })
  }

  // GET /api/tickets/stats — ticket statistics
  app.get('/api/tickets/stats', (c) => {
    const config = loadMinionConfig()
    if (config.projects.length === 0) return c.json({ error: 'No projects configured' }, 400)
    const projectPath = c.req.query('project') || config.projects[0].path
    const storage = getStorageForProject(projectPath)
    const stats = storage.getStats()
    return c.json(stats)
  })

  // GET /api/tickets/:id — single ticket detail
  app.get('/api/tickets/:id', (c) => {
    const config = loadMinionConfig()
    if (config.projects.length === 0) return c.json({ error: 'No projects configured' }, 400)
    const projectPath = c.req.query('project') || config.projects[0].path
    const storage = getStorageForProject(projectPath)
    const ticket = storage.getTicket(c.req.param('id'))
    if (!ticket) return c.json({ error: 'Ticket not found' }, 404)
    return c.json(ticket)
  })

  // POST /api/tickets/:id/transition — change ticket status
  app.post('/api/tickets/:id/transition', async (c) => {
    const config = loadMinionConfig()
    if (config.projects.length === 0) return c.json({ error: 'No projects configured' }, 400)
    const body = await c.req.json() as { project?: string; status: string; metadata?: Record<string, string> }
    const projectPath = body.project || config.projects[0].path
    const storage = getStorageForProject(projectPath)
    const ticketId = c.req.param('id')

    try {
      const before = storage.getTicket(ticketId)
      const fromStatus = before?.status ?? undefined
      storage.transitionTicket(ticketId, body.status as any, body.metadata)
      const ticket = storage.getTicket(ticketId)
      broadcastFn({ type: 'ticket-update', ticket: { id: ticketId, status: body.status }, action: 'transition' })
      if (metricsStore) {
        try {
          metricsStore.recordTicketEvent({
            ticketId,
            action: 'transitioned',
            fromStatus,
            toStatus: body.status,
            source: 'manual',
          })
        } catch { /* non-fatal */ }
      }
      return c.json({ ok: true, ticket })
    } catch (err: any) {
      return c.json({ error: err.message }, 400)
    }
  })

  // POST /api/tickets/:id/fix — on-demand dispatch
  app.post('/api/tickets/:id/fix', async (c) => {
    const ticketId = c.req.param('id')
    const config = loadMinionConfig()
    if (config.projects.length === 0) return c.json({ error: 'No projects configured' }, 400)

    const projectPath = (await c.req.json() as any).project || config.projects[0].path
    const project = config.projects.find(p => p.path === projectPath)
    if (!project) return c.json({ error: 'Project not found in config' }, 400)

    const storage = getStorageForProject(projectPath)
    const ticket = storage.getTicket(ticketId)
    if (!ticket) return c.json({ error: 'Ticket not found' }, 404)

    const effort = ticket.effort || 'small'
    const relPath = ticket.source?.file ? path.relative(projectPath, ticket.source.file) : ''
    const scope = relPath ? path.dirname(relPath) : ''

    // Check file lock before doing anything irreversible
    if (!relPath || !fileLockRegistry.isLocked(relPath)) {
      // File not locked - continue with dispatch
    } else {
      const lock = fileLockRegistry.getLock(relPath)
      return c.json({ ok: false, skipped: true, reason: 'File is locked by another dispatch', locked_by: lock }, 409)
    }

    // Transition to in-progress
    try {
      storage.transitionTicket(ticketId, 'in-progress', { reason: 'On-demand fix dispatch' })
    } catch { /* may already be in-progress */ }

    if (effort === 'small' || (project.auto_merge_efforts ?? ['small']).includes(effort)) {
      // Direct WO dispatch
      const groupId = `ondemand-${ticketId}-${Date.now()}`
      const woId = `WO-${ticketId}`

      const wo = {
        id: woId,
        group_id: groupId,
        title: ticket.title,
        description: `Fix the following issue in ${ticket.source.file}:${ticket.source.line_start}\n\n**Issue:** ${ticket.title}\n**Details:** ${ticket.description}\n**Suggested fix:** ${ticket.suggestion ?? 'No suggestion'}\n\nRules:\n- Make the minimal change needed\n- Do not refactor surrounding code\n- Do not add comments or documentation`,
        task: 'fix',
        scope: scope || undefined,
        full_context_files: relPath ? [relPath] : [],
        gates: { compile: true, lint: true, typecheck: true, tests: { run: false } },
        execution: { model: (effort === 'small' ? project.fix_model : project.fix_model_medium) || project.fix_model || 'glm-5', max_retries: 2, timeout_minutes: effort === 'small' ? 5 : 10 },
        isolation: { type: 'none' },
        output: { commit: true, commit_prefix: 'fix' },
      }

      // Create WO
      const woResp = await fetch(`${baseUrl}/api/wo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wo),
      })
      if (!woResp.ok) return c.json({ error: `Failed to create WO: ${woResp.status}` }, 500)

      // Dispatch
      const dispResp = await fetch(`${baseUrl}/api/wo/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_id: groupId, working_dir: projectPath, concurrency: 1, max_failures: 1 }),
      })
      if (!dispResp.ok) return c.json({ error: `Failed to dispatch: ${dispResp.status}` }, 500)

      const { dispatch_id } = await dispResp.json() as { dispatch_id: string }
      broadcastFn({ type: 'ticket-update', ticket: { id: ticketId, status: 'in-progress' }, action: 'fix-dispatched' })
      try {
        metricsStore?.recordTicketEvent({
          ticketId,
          action: 'fix-dispatched',
          source: 'on-demand',
          metadata: { group_id: groupId, wo_id: woId, effort: 'small' },
        })
      } catch { /* non-fatal */ }
      return c.json({ ok: true, dispatch_id, group_id: groupId, effort: 'small' }, 202)

    } else {
      // Medium ticket — spawn plan-dispatch as a task
      const scriptDir = path.join(import.meta.dir, 'scripts')
      const scriptPath = path.join(scriptDir, 'minion-plan-dispatch.ts')

      // Use the task API to create a planning task
      const taskResp = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath,
          prompt: `Run the plan-dispatch script for ticket ${ticketId}:\nbun run ${scriptPath} --ticket-id ${ticketId} --project ${projectPath} --api-url ${baseUrl}`,
          timeoutSeconds: 2700, // 45 min
          metadata: { source: 'minion-ondemand', ticket_id: ticketId },
        }),
      })
      if (!taskResp.ok) return c.json({ error: `Failed to create task: ${taskResp.status}` }, 500)

      const { id: taskId } = await taskResp.json() as { id: string }
      broadcastFn({ type: 'ticket-update', ticket: { id: ticketId, status: 'in-progress' }, action: 'fix-dispatched' })
      try {
        metricsStore?.recordTicketEvent({
          ticketId,
          action: 'fix-dispatched',
          source: 'on-demand',
          metadata: { task_id: taskId, effort: 'medium' },
        })
      } catch { /* non-fatal */ }
      return c.json({ ok: true, task_id: taskId, effort: 'medium' }, 202)
    }
  })

  // ── Nightly Report Routes ──────────────────────────────────────────────

  // GET /api/nightly/reports — list reports
  app.get('/api/nightly/reports', (c) => {
    const reportDir = getReportDir()
    if (!fs.existsSync(reportDir)) return c.json({ reports: [] })

    const files = fs.readdirSync(reportDir)
      .filter(f => f.startsWith('nightly-') && f.endsWith('.json'))
      .sort()
      .reverse()

    const limit = parseInt(c.req.query('limit') || '30', 10)
    const reports = files.slice(0, limit).map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(reportDir, f), 'utf8'))
      } catch { return null }
    }).filter(Boolean)

    return c.json({ reports })
  })

  // GET /api/nightly/reports/:date — single report
  app.get('/api/nightly/reports/:date', (c) => {
    const date = c.req.param('date')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json({ error: 'Invalid date format' }, 400)
    }
    const reportDir = getReportDir()
    const filePath = path.join(reportDir, `nightly-${date}.json`)
    if (!fs.existsSync(filePath)) return c.json({ error: 'Report not found' }, 404)

    try {
      const report = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      return c.json(report)
    } catch {
      return c.json({ error: 'Failed to parse report' }, 500)
    }
  })

  // POST /api/nightly/reports — ingest from pipeline + broadcast
  app.post('/api/nightly/reports', async (c) => {
    const report = await c.req.json() as Record<string, unknown>
    if (typeof report.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(report.date)) {
      return c.json({ error: 'Invalid or missing date field' }, 400)
    }

    // Save to disk (in case it wasn't already)
    const reportDir = getReportDir()
    fs.mkdirSync(reportDir, { recursive: true })
    const filePath = path.join(reportDir, `nightly-${report.date}.json`)
    fs.writeFileSync(filePath, JSON.stringify(report, null, 2))

    // Persist to DB metrics table
    if (metricsStore) {
      try {
        metricsStore.upsertReport(report as unknown as NightlyReport)
      } catch (err) {
        // Non-fatal — metrics storage failure shouldn't fail the report ingestion
        console.warn('[metricsStore] upsertReport failed:', err)
      }
    }

    // Broadcast to all connected WS clients
    broadcastFn({ type: 'nightly-report', report })

    return c.json({ ok: true })
  })

  // ── Metrics Routes ─────────────────────────────────────────────────────

  // GET /api/metrics/daily?days=30 — array of daily metrics rows
  app.get('/api/metrics/daily', (c) => {
    if (!metricsStore) return c.json({ error: 'Metrics store not initialized' }, 503)
    const days = Math.min(parseInt(c.req.query('days') || '30', 10), 365)
    const rows = metricsStore.getLatest(days)
    return c.json({ metrics: rows, count: rows.length })
  })

  // GET /api/metrics/daily/:date — single day metrics
  app.get('/api/metrics/daily/:date', (c) => {
    if (!metricsStore) return c.json({ error: 'Metrics store not initialized' }, 503)
    const date = c.req.param('date')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json({ error: 'Invalid date format, expected YYYY-MM-DD' }, 400)
    }
    const row = metricsStore.getReport(date)
    if (!row) return c.json({ error: 'No metrics found for date' }, 404)
    return c.json(row)
  })

  // GET /api/metrics/summary?days=30 — aggregated summary with trend
  app.get('/api/metrics/summary', (c) => {
    if (!metricsStore) return c.json({ error: 'Metrics store not initialized' }, 503)
    const days = Math.min(parseInt(c.req.query('days') || '30', 10), 365)
    const summary = metricsStore.getSummary(days)
    return c.json(summary)
  })

  // GET /api/metrics/activity?days=30 — daily activity from ticket + dispatch events
  app.get('/api/metrics/activity', (c) => {
    if (!metricsStore) return c.json({ error: 'Metrics store not initialized' }, 503)
    const days = Math.min(parseInt(c.req.query('days') || '30', 10), 365)
    const activity = metricsStore.getDailyActivity(days)
    return c.json({ activity, count: activity.length })
  })

  // GET /api/metrics/ticket-events?days=7&ticket_id=X — raw ticket events
  app.get('/api/metrics/ticket-events', (c) => {
    if (!metricsStore) return c.json({ error: 'Metrics store not initialized' }, 503)
    const days = Math.min(parseInt(c.req.query('days') || '7', 10), 365)
    const ticketId = c.req.query('ticket_id') || undefined
    const events = metricsStore.getTicketEvents(days, ticketId)
    return c.json({ events, count: events.length })
  })

  // GET /api/metrics/dispatch-events?days=7&group_id=X — raw dispatch events
  app.get('/api/metrics/dispatch-events', (c) => {
    if (!metricsStore) return c.json({ error: 'Metrics store not initialized' }, 503)
    const days = Math.min(parseInt(c.req.query('days') || '7', 10), 365)
    const groupId = c.req.query('group_id') || undefined
    const events = metricsStore.getDispatchEvents(days, groupId)
    return c.json({ events, count: events.length })
  })
}
