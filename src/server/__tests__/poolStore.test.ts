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

  // ─── Reconcile Orphaned Slots (CF-03) ────────────────────────────────────

  describe('reconcileOrphanedSlots', () => {
    test('marks all active and queued slots as released when no checker provided (TEST-24, fallback)', () => {
      store.insertSlot({ runId: 'r1', stepName: 's1', tier: 1, status: 'active' })
      store.insertSlot({ runId: 'r2', stepName: 's2', tier: 1, status: 'queued' })
      store.insertSlot({ runId: 'r3', stepName: 's3', tier: 1, status: 'active' })

      // No checker = fallback behavior (release all)
      const changed = store.reconcileOrphanedSlots()
      expect(changed).toBe(3)

      expect(store.getActiveCount()).toBe(0)
      expect(store.listQueuedSlots()).toHaveLength(0)
    })

    test('returns 0 when no orphaned slots', () => {
      const changed = store.reconcileOrphanedSlots()
      expect(changed).toBe(0)
    })

    test('CF-03: only releases slots where tmux session is dead', () => {
      store.insertSlot({ runId: 'r1', stepName: 'alive-step', tier: 1, status: 'active' })
      store.insertSlot({ runId: 'r2', stepName: 'dead-step', tier: 1, status: 'active' })
      store.insertSlot({ runId: 'r3', stepName: 'another-alive', tier: 1, status: 'active' })

      // Mock tmux checker: only 'dead-step' is dead
      const released = store.reconcileOrphanedSlots(
        (_slotId, _runId, stepName) => stepName !== 'dead-step',
      )

      expect(released).toBe(1) // Only dead-step released
      expect(store.getActiveCount()).toBe(2) // alive-step + another-alive still active
      const active = store.listActiveSlots()
      const activeNames = active.map(s => s.stepName)
      expect(activeNames).toContain('alive-step')
      expect(activeNames).toContain('another-alive')
      expect(activeNames).not.toContain('dead-step')
    })

    test('CF-03: promotes queued entries after releasing orphaned slots', () => {
      // maxSlots = 2, fill to capacity + queue
      store.insertSlot({ runId: 'r1', stepName: 'active-alive', tier: 1, status: 'active' })
      store.insertSlot({ runId: 'r2', stepName: 'active-dead', tier: 1, status: 'active' })
      store.insertSlot({ runId: 'r3', stepName: 'queued-high', tier: 5, status: 'queued' })
      store.insertSlot({ runId: 'r4', stepName: 'queued-low', tier: 1, status: 'queued' })

      // Mock: active-dead is dead
      const released = store.reconcileOrphanedSlots(
        (_slotId, _runId, stepName) => stepName !== 'active-dead',
      )

      expect(released).toBe(1)
      // After release: 1 active slot (active-alive) + 1 newly promoted (queued-high, highest tier)
      expect(store.getActiveCount()).toBe(2)
      const active = store.listActiveSlots()
      const activeNames = active.map(s => s.stepName)
      expect(activeNames).toContain('active-alive')
      expect(activeNames).toContain('queued-high') // Promoted from queue (highest tier)

      // queued-low should still be in queue
      const queued = store.listQueuedSlots()
      expect(queued).toHaveLength(1)
      expect(queued[0].stepName).toBe('queued-low')
    })

    test('CF-03: all alive slots kept when all tmux sessions are alive', () => {
      store.insertSlot({ runId: 'r1', stepName: 's1', tier: 1, status: 'active' })
      store.insertSlot({ runId: 'r2', stepName: 's2', tier: 1, status: 'active' })

      // All alive
      const released = store.reconcileOrphanedSlots(() => true)
      expect(released).toBe(0)
      expect(store.getActiveCount()).toBe(2)
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
