// poolHandlers.ts - REST API handlers for session pool management (Phase 5)
import type { Hono } from 'hono'
import type { ServerContext } from '../serverContext'
import type { SessionPool } from '../sessionPool'

export function createPoolHandlers(ctx: ServerContext, pool: SessionPool) {
  function registerRoutes(app: Hono): void {
    // GET /api/pool/status — returns pool status with active, queued, max, and slots
    app.get('/api/pool/status', (c) => {
      const status = pool.getStatus()
      return c.json({
        maxSlots: status.config.maxSlots,
        activeSlots: status.active.map(s => ({
          slotId: s.id,
          runId: s.runId,
          stepName: s.stepName,
          tier: s.tier,
          startedAt: s.grantedAt,
        })),
        queue: status.queue.map((s, idx) => ({
          runId: s.runId,
          stepName: s.stepName,
          tier: s.tier,
          requestedAt: s.requestedAt,
          position: idx + 1,
        })),
      })
    })

    // POST /api/pool/config — updates pool config { maxSlots: number }
    app.post('/api/pool/config', async (c) => {
      let body: Record<string, unknown>
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400)
      }
      const maxSlots = Number(body.maxSlots)
      if (!Number.isInteger(maxSlots) || maxSlots < 1 || maxSlots > 100) {
        return c.json({ error: 'maxSlots must be an integer between 1 and 100' }, 400)
      }
      const currentStatus = pool.getStatus()
      if (currentStatus.active.length > maxSlots) {
        return c.json({
          error: `Cannot reduce maxSlots to ${maxSlots}: ${currentStatus.active.length} slots currently active`,
        }, 400)
      }
      pool.updateConfig(maxSlots)
      const status = pool.getStatus()
      ctx.broadcast({
        type: 'pool_status_update',
        active: status.active.length,
        queued: status.queue.length,
        max: status.config.maxSlots,
      })
      return c.json({ ok: true, maxSlots })
    })

    // POST /api/pool/release — force-release a slot by ID
    app.post('/api/pool/release', async (c) => {
      let body: Record<string, unknown>
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400)
      }
      const slotId = body.slot_id
      if (!slotId || typeof slotId !== 'string') {
        return c.json({ error: 'slot_id is required (string)' }, 400)
      }
      const slot = pool.getSlot(slotId)
      if (!slot) {
        return c.json({ error: `Slot not found: ${slotId}` }, 404)
      }
      if (slot.status === 'released') {
        return c.json({ error: `Slot already released: ${slotId}` }, 400)
      }
      const promoted = pool.releaseSlot(slotId)
      const status = pool.getStatus()
      ctx.broadcast({
        type: 'pool_status_update',
        active: status.active.length,
        queued: status.queue.length,
        max: status.config.maxSlots,
      })
      return c.json({ ok: true, released: slotId, promoted: promoted?.id ?? null })
    })
  }

  return { registerRoutes }
}
