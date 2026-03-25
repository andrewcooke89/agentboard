import { Hono } from 'hono'
import type { GroupStatus, SwarmEvent, WoStatus } from '../shared/swarmTypes'
import type { SwarmManager } from './SwarmManager'

function isWoStatus(value: unknown): value is WoStatus {
  return typeof value === 'string'
    && ['pending', 'ready', 'running', 'completed', 'failed', 'escalated'].includes(value)
}

function isGroupStatus(value: unknown): value is GroupStatus {
  return typeof value === 'string'
    && ['pending', 'running', 'completed', 'failed', 'aborted'].includes(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isSwarmEvent(value: unknown): value is SwarmEvent {
  if (!isObject(value) || typeof value.type !== 'string' || typeof value.groupId !== 'string' || typeof value.timestamp !== 'string') {
    return false
  }

  switch (value.type) {
    case 'group_started':
      return typeof value.totalWos === 'number'
        && isStringArray(value.woIds)
        && Array.isArray(value.edges)
    case 'wo_status_changed':
      return typeof value.woId === 'string'
        && isWoStatus(value.oldStatus)
        && isWoStatus(value.newStatus)
        && typeof value.model === 'string'
        && typeof value.attempt === 'number'
        && typeof value.tier === 'number'
    case 'wo_completed':
      return typeof value.woId === 'string'
        && isObject(value.tokenUsage)
        && typeof value.tokenUsage.inputTokens === 'number'
        && typeof value.tokenUsage.outputTokens === 'number'
        && (value.gateResults === null || isObject(value.gateResults))
        && isStringArray(value.filesChanged)
        && typeof value.durationSeconds === 'number'
    case 'wo_failed':
      return typeof value.woId === 'string'
        && typeof value.error === 'string'
        && (typeof value.gateDetail === 'string' || value.gateDetail === null)
        && typeof value.model === 'string'
        && typeof value.attempt === 'number'
        && typeof value.tier === 'number'
    case 'wo_escalated':
      return typeof value.woId === 'string'
        && typeof value.fromTier === 'number'
        && typeof value.toTier === 'number'
        && typeof value.toModel === 'string'
        && Array.isArray(value.errorHistory)
    case 'group_completed':
      return isGroupStatus(value.status)
        && typeof value.totalDurationSeconds === 'number'
        && typeof value.completedWos === 'number'
        && typeof value.failedWos === 'number'
        && isObject(value.totalTokens)
        && typeof value.totalTokens.inputTokens === 'number'
        && typeof value.totalTokens.outputTokens === 'number'
    default:
      return false
  }
}

export function registerSwarmRoutes(app: Hono, swarmManager: SwarmManager): void {
  app.post('/api/swarm/events', async (c) => {
    let event: unknown
    try {
      event = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    if (!isSwarmEvent(event)) {
      return c.json({ error: 'Invalid swarm event payload' }, 400)
    }

    swarmManager.processEvent(event)
    return c.json({ ok: true })
  })

  app.get('/api/swarm/groups', (c) => {
    return c.json(swarmManager.getGroups())
  })

  app.get('/api/swarm/groups/:groupId', (c) => {
    const group = swarmManager.getGroup(c.req.param('groupId'))
    if (!group) return c.json({ error: 'not found' }, 404)
    return c.json(group)
  })

  app.get('/api/swarm/events', (c) => {
    const parsed = Number.parseInt(c.req.query('limit') || '', 10)
    const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 100
    return c.json(swarmManager.getRecentEvents(limit))
  })
}
