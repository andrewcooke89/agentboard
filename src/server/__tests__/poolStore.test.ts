/**
 * poolStore.test.ts -- Tests for session pool database operations (Phase 5)
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { initPoolTables, reconcilePoolSlots } from '../db'
import { createPoolStore } from '../poolStore'
import type { PoolSlotRequest } from '../poolStore'

function createTestDb(): SQLiteDatabase {
  const db = new SQLiteDatabase(':memory:')
  initPoolTables(db)
  return db
}

describe('poolStore', () => {
  let db: SQLiteDatabase
  let store: ReturnType<typeof createPoolStore>

  beforeEach(() => {
    db = createTestDb()
    store = createPoolStore(db)
  })

  // ─── Pool Config ─────────────────────────────────────────────────────────

  describe('getPoolConfig', () => {
    test('returns default config', () => {
      const config = store.getPoolConfig()
      expect(config.maxSlots).toBe(2)
      expect(config.updatedAt).toBeTruthy()
    })

    test('updatePoolConfig changes maxSlots', () => {
      store.updatePoolConfig(5)
      const config = store.getPoolConfig()
      expect(config.maxSlots).toBe(5)
    })
  })

  // ─── Insert Slot ─────────────────────────────────────────────────────────

  describe('insertSlot', () => {
    test('inserts slot with active status', () => {
      const slot = store.insertSlot({
        runId: 'run-1',
        stepName: 'step-a',
        tier: 2,
        status: 'active',
        grantedAt: '2025-01-01T00:00:00Z',
      })
      expect(slot.id).toMatch(/^slot-/)
      expect(slot.runId).toBe('run-1')
      expect(slot.stepName).toBe('step-a')
      expect(slot.tier).toBe(2)
      expect(slot.status).toBe('active')
      expect(slot.requestedAt).toBeTruthy()
    })

    test('inserts slot with queued status', () => {
      const slot = store.insertSlot({
        runId: 'run-2',
        stepName: 'step-b',
        tier: 1,
        status: 'queued',
      })
      expect(slot.id).toMatch(/^slot-/)
      expect(slot.status).toBe('queued')
      expect(slot.grantedAt).toBeNull()
    })
  })

  // ─── Active Count ────────────────────────────────────────────────────────

  describe('getActiveCount', () => {
    test('returns correct count of active slots', () => {
      expect(store.getActiveCount()).toBe(0)

      store.insertSlot({ runId: 'r1', stepName: 's1', tier: 1, status: 'active' })
      expect(store.getActiveCount()).toBe(1)

      store.insertSlot({ runId: 'r2', stepName: 's2', tier: 1, status: 'active' })
      expect(store.getActiveCount()).toBe(2)

      // Queued slots don't count as active
      store.insertSlot({ runId: 'r3', stepName: 's3', tier: 1, status: 'queued' })
      expect(store.getActiveCount()).toBe(2)
    })
  })

  // ─── Next Queued ─────────────────────────────────────────────────────────

  describe('getNextQueued', () => {
    test('returns null when no queued slots', () => {
      expect(store.getNextQueued()).toBeNull()
    })

    test('returns highest tier first', () => {
      store.insertSlot({ runId: 'r1', stepName: 's1', tier: 1, status: 'queued' })
      store.insertSlot({ runId: 'r2', stepName: 's2', tier: 3, status: 'queued' })
      store.insertSlot({ runId: 'r3', stepName: 's3', tier: 2, status: 'queued' })

      const next = store.getNextQueued()
      expect(next).not.toBeNull()
      expect(next!.tier).toBe(3)
      expect(next!.stepName).toBe('s2')
    })

    test('priority ordering: tier DESC, requested_at ASC', () => {
      // Same tier -- oldest request first
      store.insertSlot({ runId: 'r1', stepName: 'first', tier: 1, status: 'queued' })
      store.insertSlot({ runId: 'r2', stepName: 'second', tier: 1, status: 'queued' })

      const next = store.getNextQueued()
      expect(next).not.toBeNull()
      expect(next!.stepName).toBe('first')
    })

    test('does not return active slots', () => {
      store.insertSlot({ runId: 'r1', stepName: 's1', tier: 5, status: 'active' })
      store.insertSlot({ runId: 'r2', stepName: 's2', tier: 1, status: 'queued' })

      const next = store.getNextQueued()
      expect(next).not.toBeNull()
      expect(next!.stepName).toBe('s2')
    })
  })

  // ─── Update Slot Status ──────────────────────────────────────────────────

  describe('updateSlotStatus', () => {
    test('updates status from queued to active', () => {
      const slot = store.insertSlot({ runId: 'r1', stepName: 's1', tier: 1, status: 'queued' })
      store.updateSlotStatus(slot.id, 'active', { grantedAt: '2025-01-01T00:00:00Z' })

      const updated = store.getSlot(slot.id)
      expect(updated).not.toBeNull()
      expect(updated!.status).toBe('active')
    })

    test('updates status from active to released', () => {
      const slot = store.insertSlot({ runId: 'r1', stepName: 's1', tier: 1, status: 'active' })
      store.updateSlotStatus(slot.id, 'released', { releasedAt: '2025-01-01T01:00:00Z' })

      const updated = store.getSlot(slot.id)
      expect(updated).not.toBeNull()
      expect(updated!.status).toBe('released')
    })
  })

  // ─── Get Slot ────────────────────────────────────────────────────────────

  describe('getSlot', () => {
    test('returns null for non-existent slot', () => {
      expect(store.getSlot('nonexistent')).toBeNull()
    })

    test('returns slot by id', () => {
      const slot = store.insertSlot({ runId: 'r1', stepName: 's1', tier: 2, status: 'queued' })
      const found = store.getSlot(slot.id)
      expect(found).not.toBeNull()
      expect(found!.runId).toBe('r1')
      expect(found!.tier).toBe(2)
    })
  })

  // ─── List Slots ──────────────────────────────────────────────────────────

  describe('listActiveSlots', () => {
    test('returns only active slots', () => {
      store.insertSlot({ runId: 'r1', stepName: 's1', tier: 1, status: 'active' })
      store.insertSlot({ runId: 'r2', stepName: 's2', tier: 1, status: 'queued' })
      store.insertSlot({ runId: 'r3', stepName: 's3', tier: 1, status: 'active' })

      const active = store.listActiveSlots()
      expect(active).toHaveLength(2)
      expect(active.every((s: PoolSlotRequest) => s.status === 'active')).toBe(true)
    })
  })

  describe('listQueuedSlots', () => {
    test('returns only queued slots ordered by priority', () => {
      store.insertSlot({ runId: 'r1', stepName: 's1', tier: 1, status: 'queued' })
      store.insertSlot({ runId: 'r2', stepName: 's2', tier: 3, status: 'queued' })
      store.insertSlot({ runId: 'r3', stepName: 's3', tier: 1, status: 'active' })

      const queued = store.listQueuedSlots()
      expect(queued).toHaveLength(2)
      expect(queued[0].tier).toBe(3) // highest tier first
      expect(queued.every((s: PoolSlotRequest) => s.status === 'queued')).toBe(true)
    })
  })

  // ─── Reconcile Orphaned Slots ────────────────────────────────────────────

  describe('reconcileOrphanedSlots', () => {
    test('marks all active and queued slots as released (TEST-24)', () => {
      store.insertSlot({ runId: 'r1', stepName: 's1', tier: 1, status: 'active' })
      store.insertSlot({ runId: 'r2', stepName: 's2', tier: 1, status: 'queued' })
      store.insertSlot({ runId: 'r3', stepName: 's3', tier: 1, status: 'active' })

      const changed = store.reconcileOrphanedSlots()
      expect(changed).toBe(3)

      expect(store.getActiveCount()).toBe(0)
      expect(store.listQueuedSlots()).toHaveLength(0)
    })

    test('returns 0 when no orphaned slots', () => {
      const changed = store.reconcileOrphanedSlots()
      expect(changed).toBe(0)
    })
  })

  // ─── reconcilePoolSlots from db.ts (TEST-24) ────────────────────────────

  describe('reconcilePoolSlots (db.ts)', () => {
    test('marks active/queued as released on restart', () => {
      store.insertSlot({ runId: 'r1', stepName: 's1', tier: 1, status: 'active' })
      store.insertSlot({ runId: 'r2', stepName: 's2', tier: 1, status: 'queued' })

      reconcilePoolSlots(db)

      expect(store.getActiveCount()).toBe(0)
      expect(store.listQueuedSlots()).toHaveLength(0)
    })
  })

  // ─── WAL Mode (TEST-25) ──────────────────────────────────────────────────

  describe('WAL mode', () => {
    test('WAL mode is not set for :memory: databases', () => {
      // :memory: databases use 'memory' journal mode by default
      const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
      expect(row.journal_mode).toBe('memory')
    })
  })
})
