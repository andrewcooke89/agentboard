/**
 * poolHandlers.test.ts -- Tests for pool REST API endpoints (Phase 5, Batch 3)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { initPoolTables } from '../db'
import { createSessionPool } from '../sessionPool'
import type { SessionPool } from '../sessionPool'
import { createPoolHandlers } from '../handlers/poolHandlers'
import type { ServerContext } from '../serverContext'
import type { ServerMessage } from '../../shared/types'

// ── Test Helpers ─────────────────────────────────────────────────────────────

function createTestDb(): SQLiteDatabase {
  const db = new SQLiteDatabase(':memory:')
  initPoolTables(db)
  return db
}

function createMockContext(): { ctx: ServerContext; broadcasts: ServerMessage[] } {
  const broadcasts: ServerMessage[] = []
  const ctx = {
    config: {
      workflowEngineEnabled: true,
    },
    broadcast: (msg: ServerMessage) => {
      broadcasts.push(msg)
    },
    logger: {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    },
  } as unknown as ServerContext
  return { ctx, broadcasts }
}

function createApp(ctx: ServerContext, pool: SessionPool): Hono {
  const app = new Hono()
  const handlers = createPoolHandlers(ctx, pool)
  handlers.registerRoutes(app)
  return app
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('poolHandlers', () => {
  let db: SQLiteDatabase
  let pool: SessionPool
  let ctx: ServerContext
  let broadcasts: ServerMessage[]
  let app: Hono

  beforeEach(() => {
    db = createTestDb()
    pool = createSessionPool(db)
    const mock = createMockContext()
    ctx = mock.ctx
    broadcasts = mock.broadcasts
    app = createApp(ctx, pool)
  })

  afterEach(() => {
    try { db.close() } catch { /* ok */ }
  })

  // ── TEST-19: Pool status API returns correct counts ──────────────────────

  describe('GET /api/pool/status', () => {
    test('TEST-19: returns correct active, queued, max counts', async () => {
      // Default pool: maxSlots = 2
      pool.requestSlot({ runId: 'r1', stepName: 's1', tier: 1 })
      pool.requestSlot({ runId: 'r2', stepName: 's2', tier: 1 })
      pool.requestSlot({ runId: 'r3', stepName: 's3', tier: 1 }) // queued

      const res = await app.request('/api/pool/status')
      expect(res.status).toBe(200)

      const body = await res.json() as any
      expect(body.active).toBe(2)
      expect(body.queued).toBe(1)
      expect(body.max).toBe(2)
      expect(body.slots).toHaveLength(3)
    })

    test('returns empty pool status when no slots requested', async () => {
      const res = await app.request('/api/pool/status')
      expect(res.status).toBe(200)

      const body = await res.json() as any
      expect(body.active).toBe(0)
      expect(body.queued).toBe(0)
      expect(body.max).toBe(2) // default
      expect(body.slots).toHaveLength(0)
    })

    test('slots array contains both active and queued', async () => {
      pool.requestSlot({ runId: 'r1', stepName: 's1', tier: 1 })
      pool.requestSlot({ runId: 'r2', stepName: 's2', tier: 1 })
      pool.requestSlot({ runId: 'r3', stepName: 'queued-one', tier: 1 })

      const res = await app.request('/api/pool/status')
      const body = await res.json() as any

      const slotNames = body.slots.map((s: any) => s.stepName)
      expect(slotNames).toContain('s1')
      expect(slotNames).toContain('s2')
      expect(slotNames).toContain('queued-one')
    })
  })

  // ── REQ-30/REQ-31: Pool config API ──────────────────────────────────────

  describe('POST /api/pool/config', () => {
    test('updates maxSlots and returns ok', async () => {
      const res = await app.request('/api/pool/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxSlots: 5 }),
      })
      expect(res.status).toBe(200)

      const body = await res.json() as any
      expect(body.ok).toBe(true)
      expect(body.maxSlots).toBe(5)

      // Verify pool was updated
      const status = pool.getStatus()
      expect(status.config.maxSlots).toBe(5)
    })

    test('broadcasts pool-status-update on config change', async () => {
      await app.request('/api/pool/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxSlots: 8 }),
      })

      const statusMsgs = broadcasts.filter(
        (m) => m.type === 'pool-status-update',
      )
      expect(statusMsgs.length).toBe(1)
      const msg = statusMsgs[0] as any
      expect(msg.max).toBe(8)
    })

    test('rejects invalid JSON body', async () => {
      const res = await app.request('/api/pool/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json',
      })
      expect(res.status).toBe(400)
      const body = await res.json() as any
      expect(body.error).toContain('Invalid JSON')
    })

    test('rejects maxSlots < 1', async () => {
      const res = await app.request('/api/pool/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxSlots: 0 }),
      })
      expect(res.status).toBe(400)
      const body = await res.json() as any
      expect(body.error).toContain('maxSlots must be')
    })

    test('rejects maxSlots > 100', async () => {
      const res = await app.request('/api/pool/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxSlots: 101 }),
      })
      expect(res.status).toBe(400)
    })

    test('rejects non-integer maxSlots', async () => {
      const res = await app.request('/api/pool/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxSlots: 2.5 }),
      })
      expect(res.status).toBe(400)
    })

    test('rejects missing maxSlots', async () => {
      const res = await app.request('/api/pool/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })
  })
})
