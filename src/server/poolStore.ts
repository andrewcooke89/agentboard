/**
 * poolStore.ts -- Session pool database operations layer (Phase 5)
 *
 * Manages pool slot requests for the DAG engine's session pool.
 * All functions operate on prepared statements for performance.
 */

import { Database as SQLiteDatabase } from 'bun:sqlite'

export interface PoolSlotRequest {
  id: string
  runId: string
  stepName: string
  tier: number
  status: 'queued' | 'active' | 'released'
  requestedAt: string
  grantedAt: string | null
  releasedAt: string | null
}

export interface PoolConfig {
  maxSlots: number
  updatedAt: string
}

function generateSlotId(): string {
  return `slot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function mapSlotRow(row: Record<string, unknown>): PoolSlotRequest {
  return {
    id: String(row.id ?? ''),
    runId: String(row.run_id ?? ''),
    stepName: String(row.step_name ?? ''),
    tier: Number(row.tier ?? 1),
    status: String(row.status ?? 'queued') as PoolSlotRequest['status'],
    requestedAt: String(row.requested_at ?? ''),
    grantedAt: row.granted_at ? String(row.granted_at) : null,
    releasedAt: row.released_at ? String(row.released_at) : null,
  }
}

export function createPoolStore(db: SQLiteDatabase) {
  // Prepared statements
  const getConfigStmt = db.prepare(
    'SELECT max_slots, updated_at FROM session_pool_config WHERE id = 1',
  )
  const updateConfigStmt = db.prepare(
    "UPDATE session_pool_config SET max_slots = $maxSlots, updated_at = datetime('now') WHERE id = 1",
  )
  const insertSlotStmt = db.prepare(
    `INSERT INTO pool_slot_requests (id, run_id, step_name, tier, status, requested_at, granted_at)
     VALUES ($id, $runId, $stepName, $tier, $status, datetime('now'), $grantedAt)`,
  )
  const updateSlotStatusStmt = db.prepare(
    'UPDATE pool_slot_requests SET status = $status, granted_at = $grantedAt, released_at = $releasedAt WHERE id = $id',
  )
  const countActiveStmt = db.prepare(
    "SELECT COUNT(*) as cnt FROM pool_slot_requests WHERE status = 'active'",
  )
  const nextQueuedStmt = db.prepare(
    "SELECT * FROM pool_slot_requests WHERE status = 'queued' ORDER BY tier DESC, requested_at ASC LIMIT 1",
  )
  const listActiveStmt = db.prepare(
    "SELECT * FROM pool_slot_requests WHERE status = 'active' ORDER BY granted_at ASC",
  )
  const listQueuedStmt = db.prepare(
    "SELECT * FROM pool_slot_requests WHERE status = 'queued' ORDER BY tier DESC, requested_at ASC",
  )
  const getSlotStmt = db.prepare('SELECT * FROM pool_slot_requests WHERE id = $id')

  return {
    getPoolConfig(): PoolConfig {
      const row = getConfigStmt.get() as Record<string, unknown> | undefined
      if (!row) return { maxSlots: 2, updatedAt: new Date().toISOString() }
      return {
        maxSlots: Number(row.max_slots ?? 2),
        updatedAt: String(row.updated_at ?? ''),
      }
    },

    updatePoolConfig(maxSlots: number): void {
      updateConfigStmt.run({ $maxSlots: maxSlots })
    },

    insertSlot(request: {
      runId: string
      stepName: string
      tier: number
      status: 'queued' | 'active'
      grantedAt?: string | null
    }): PoolSlotRequest {
      const id = generateSlotId()
      insertSlotStmt.run({
        $id: id,
        $runId: request.runId,
        $stepName: request.stepName,
        $tier: request.tier,
        $status: request.status,
        $grantedAt: request.grantedAt ?? null,
      })
      const row = getSlotStmt.get({ $id: id }) as Record<string, unknown>
      return mapSlotRow(row)
    },

    updateSlotStatus(
      id: string,
      status: string,
      extra?: { grantedAt?: string; releasedAt?: string },
    ): void {
      updateSlotStatusStmt.run({
        $id: id,
        $status: status,
        $grantedAt: extra?.grantedAt ?? null,
        $releasedAt: extra?.releasedAt ?? null,
      })
    },

    getSlot(id: string): PoolSlotRequest | null {
      const row = getSlotStmt.get({ $id: id }) as Record<string, unknown> | undefined
      return row ? mapSlotRow(row) : null
    },

    getActiveCount(): number {
      const row = countActiveStmt.get() as { cnt: number }
      return row.cnt
    },

    getNextQueued(): PoolSlotRequest | null {
      const row = nextQueuedStmt.get() as Record<string, unknown> | undefined
      return row ? mapSlotRow(row) : null
    },

    listActiveSlots(): PoolSlotRequest[] {
      return (listActiveStmt.all() as Record<string, unknown>[]).map(mapSlotRow)
    },

    listQueuedSlots(): PoolSlotRequest[] {
      return (listQueuedStmt.all() as Record<string, unknown>[]).map(mapSlotRow)
    },

    reconcileOrphanedSlots(): number {
      const result = db
        .prepare(
          "UPDATE pool_slot_requests SET status = 'released', released_at = datetime('now') WHERE status IN ('active', 'queued')",
        )
        .run()
      return result.changes
    },
  }
}
