/**
 * sessionPool.test.ts -- Tests for SessionPool transactional slot management (Phase 5)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { initPoolTables } from '../db'
import { createSessionPool, resolvePoolSize } from '../sessionPool'
import type { SessionPool } from '../sessionPool'

function createTestDb(): SQLiteDatabase {
  const db = new SQLiteDatabase(':memory:')
  initPoolTables(db)
  return db
}

describe('sessionPool', () => {
  let db: SQLiteDatabase
  let pool: SessionPool

  beforeEach(() => {
    db = createTestDb()
    pool = createSessionPool(db)
  })

  // ── TEST-11: Pool grants slot when capacity available ──────────────────

  describe('requestSlot - capacity available', () => {
    test('TEST-11: grants slot as active when under capacity', () => {
      const slot = pool.requestSlot({ runId: 'run-1', stepName: 'step-a', tier: 1 })
      expect(slot.status).toBe('active')
      expect(slot.runId).toBe('run-1')
      expect(slot.stepName).toBe('step-a')
      expect(slot.grantedAt).not.toBeNull()
    })

    test('grants multiple slots up to max capacity', () => {
      // Default maxSlots is 2
      const slot1 = pool.requestSlot({ runId: 'r1', stepName: 's1', tier: 1 })
      const slot2 = pool.requestSlot({ runId: 'r2', stepName: 's2', tier: 1 })
      expect(slot1.status).toBe('active')
      expect(slot2.status).toBe('active')
    })
  })

  // ── TEST-12: Pool queues step when full ────────────────────────────────

  describe('requestSlot - at capacity', () => {
    test('TEST-12: queues slot when pool is full', () => {
      pool.requestSlot({ runId: 'r1', stepName: 's1', tier: 1 })
      pool.requestSlot({ runId: 'r2', stepName: 's2', tier: 1 })
      // Pool is now full (default maxSlots = 2)
      const slot3 = pool.requestSlot({ runId: 'r3', stepName: 's3', tier: 1 })
      expect(slot3.status).toBe('queued')
      expect(slot3.grantedAt).toBeNull()
    })

    test('queues multiple when at capacity', () => {
      pool.requestSlot({ runId: 'r1', stepName: 's1', tier: 1 })
      pool.requestSlot({ runId: 'r2', stepName: 's2', tier: 1 })
      const q1 = pool.requestSlot({ runId: 'r3', stepName: 's3', tier: 1 })
      const q2 = pool.requestSlot({ runId: 'r4', stepName: 's4', tier: 1 })
      expect(q1.status).toBe('queued')
      expect(q2.status).toBe('queued')
    })
  })

  // ── TEST-13: Priority ordering (higher tier granted first) ─────────────

  describe('priority ordering', () => {
    test('TEST-13: higher tier is promoted first on release', () => {
      // Fill pool
      const active1 = pool.requestSlot({ runId: 'r1', stepName: 's1', tier: 1 })
      pool.requestSlot({ runId: 'r2', stepName: 's2', tier: 1 })
      // Queue two with different tiers
      pool.requestSlot({ runId: 'r3', stepName: 'low-tier', tier: 1 })
      pool.requestSlot({ runId: 'r4', stepName: 'high-tier', tier: 5 })

      // Release a slot - should promote high-tier first
      const promoted = pool.releaseSlot(active1.id)
      expect(promoted).not.toBeNull()
      expect(promoted!.stepName).toBe('high-tier')
      expect(promoted!.status).toBe('active')
    })
  })

  // ── TEST-14: FIFO within same tier ─────────────────────────────────────

  describe('FIFO ordering', () => {
    test('TEST-14: FIFO within same tier (oldest first)', () => {
      const a1 = pool.requestSlot({ runId: 'r1', stepName: 's1', tier: 1 })
      pool.requestSlot({ runId: 'r2', stepName: 's2', tier: 1 })
      // Queue same tier
      pool.requestSlot({ runId: 'r3', stepName: 'first-queued', tier: 2 })
      pool.requestSlot({ runId: 'r4', stepName: 'second-queued', tier: 2 })

      const promoted = pool.releaseSlot(a1.id)
      expect(promoted).not.toBeNull()
      expect(promoted!.stepName).toBe('first-queued')
    })
  })

  // ── TEST-15: Concurrent slot requests safe ─────────────────────────────

  describe('concurrent safety', () => {
    test('TEST-15: N requests in tight loop never exceed maxSlots active', () => {
      const N = 20
      const slots = []
      for (let i = 0; i < N; i++) {
        slots.push(pool.requestSlot({ runId: `r-${i}`, stepName: `s-${i}`, tier: 1 }))
      }

      const activeCount = slots.filter(s => s.status === 'active').length
      const queuedCount = slots.filter(s => s.status === 'queued').length

      // Default maxSlots = 2, so only 2 should be active
      expect(activeCount).toBe(2)
      expect(queuedCount).toBe(N - 2)

      // Verify via getStatus
      const status = pool.getStatus()
      expect(status.active.length).toBe(2)
      expect(status.queue.length).toBe(N - 2)
    })

    test('active count matches config after many operations', () => {
      pool.updateConfig(3)
      const slots = []
      for (let i = 0; i < 10; i++) {
        slots.push(pool.requestSlot({ runId: `r-${i}`, stepName: `s-${i}`, tier: 1 }))
      }

      const activeCount = slots.filter(s => s.status === 'active').length
      expect(activeCount).toBe(3)
    })
  })

  // ── TEST-16: releaseSlot promotes next queued atomically ───────────────

  describe('releaseSlot', () => {
    test('TEST-16: release promotes next queued atomically', () => {
      const a1 = pool.requestSlot({ runId: 'r1', stepName: 's1', tier: 1 })
      pool.requestSlot({ runId: 'r2', stepName: 's2', tier: 1 })
      const q1 = pool.requestSlot({ runId: 'r3', stepName: 's3', tier: 1 })

      expect(q1.status).toBe('queued')

      const promoted = pool.releaseSlot(a1.id)
      expect(promoted).not.toBeNull()
      expect(promoted!.status).toBe('active')
      expect(promoted!.stepName).toBe('s3')

      // Verify the slot is now active in the DB
      const slotInDb = pool.getSlot(q1.id)
      expect(slotInDb).not.toBeNull()
      expect(slotInDb!.status).toBe('active')
    })

    test('release returns null when no queue', () => {
      const a1 = pool.requestSlot({ runId: 'r1', stepName: 's1', tier: 1 })
      const promoted = pool.releaseSlot(a1.id)
      expect(promoted).toBeNull()
    })

    test('release opens capacity for next request', () => {
      const a1 = pool.requestSlot({ runId: 'r1', stepName: 's1', tier: 1 })
      pool.requestSlot({ runId: 'r2', stepName: 's2', tier: 1 })

      // Pool full, release one
      pool.releaseSlot(a1.id)

      // Next request should be active (not queued)
      const next = pool.requestSlot({ runId: 'r3', stepName: 's3', tier: 1 })
      expect(next.status).toBe('active')
    })
  })

  // ── TEST-20: BEGIN IMMEDIATE prevents interleaving ─────────────────────

  describe('transaction isolation', () => {
    test('TEST-20: sequential request+release never double-grants', () => {
      // Simulate rapid request-release cycles
      pool.updateConfig(1) // Only 1 slot

      const a1 = pool.requestSlot({ runId: 'r1', stepName: 's1', tier: 1 })
      expect(a1.status).toBe('active')

      const q1 = pool.requestSlot({ runId: 'r2', stepName: 's2', tier: 1 })
      expect(q1.status).toBe('queued')

      const q2 = pool.requestSlot({ runId: 'r3', stepName: 's3', tier: 1 })
      expect(q2.status).toBe('queued')

      // Release a1 -> promotes q1
      const promoted1 = pool.releaseSlot(a1.id)
      expect(promoted1).not.toBeNull()
      expect(promoted1!.stepName).toBe('s2')

      // Only 1 should be active
      const status = pool.getStatus()
      expect(status.active.length).toBe(1)
      expect(status.queue.length).toBe(1) // q2 still queued
    })

    test('multiple release cycles maintain correct counts', () => {
      pool.updateConfig(1)

      const a1 = pool.requestSlot({ runId: 'r1', stepName: 's1', tier: 1 })
      pool.requestSlot({ runId: 'r2', stepName: 's2', tier: 2 })
      pool.requestSlot({ runId: 'r3', stepName: 's3', tier: 3 })
      pool.requestSlot({ runId: 'r4', stepName: 's4', tier: 1 })

      // Release and check: tier 3 should be promoted first
      const p1 = pool.releaseSlot(a1.id)
      expect(p1!.stepName).toBe('s3') // highest tier

      let status = pool.getStatus()
      expect(status.active.length).toBe(1)
      expect(status.queue.length).toBe(2)

      // Release again: tier 2 next
      const p2 = pool.releaseSlot(p1!.id)
      expect(p2!.stepName).toBe('s2')

      status = pool.getStatus()
      expect(status.active.length).toBe(1)
      expect(status.queue.length).toBe(1)
    })
  })

  // ── getStatus ──────────────────────────────────────────────────────────

  describe('getStatus', () => {
    test('returns accurate config, active, and queue', () => {
      pool.updateConfig(3)
      pool.requestSlot({ runId: 'r1', stepName: 's1', tier: 1 })
      pool.requestSlot({ runId: 'r2', stepName: 's2', tier: 1 })
      pool.requestSlot({ runId: 'r3', stepName: 's3', tier: 1 })
      pool.requestSlot({ runId: 'r4', stepName: 's4', tier: 1 })

      const status = pool.getStatus()
      expect(status.config.maxSlots).toBe(3)
      expect(status.active.length).toBe(3)
      expect(status.queue.length).toBe(1)
    })
  })

  // ── updateConfig ───────────────────────────────────────────────────────

  describe('updateConfig', () => {
    test('changes max slots', () => {
      pool.updateConfig(5)
      const status = pool.getStatus()
      expect(status.config.maxSlots).toBe(5)
    })

    test('increased config allows more active slots', () => {
      // Fill default (2)
      pool.requestSlot({ runId: 'r1', stepName: 's1', tier: 1 })
      pool.requestSlot({ runId: 'r2', stepName: 's2', tier: 1 })
      const q = pool.requestSlot({ runId: 'r3', stepName: 's3', tier: 1 })
      expect(q.status).toBe('queued')

      // Increase config
      pool.updateConfig(5)

      // Next request should now be active
      const next = pool.requestSlot({ runId: 'r4', stepName: 's4', tier: 1 })
      expect(next.status).toBe('active')
    })
  })

  // ── getSlot ────────────────────────────────────────────────────────────

  describe('getSlot', () => {
    test('returns slot by id', () => {
      const slot = pool.requestSlot({ runId: 'r1', stepName: 's1', tier: 2 })
      const found = pool.getSlot(slot.id)
      expect(found).not.toBeNull()
      expect(found!.runId).toBe('r1')
      expect(found!.tier).toBe(2)
    })

    test('returns null for non-existent slot', () => {
      expect(pool.getSlot('nonexistent')).toBeNull()
    })
  })
})

// ── REQ-17: Pool Size Config Cascade Tests ────────────────────────────

describe('resolvePoolSize', () => {
  const testDir = '/tmp/agentboard-pool-size-test'
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.AGENTBOARD_SESSION_POOL_SIZE
    delete process.env.AGENTBOARD_SESSION_POOL_SIZE

    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    // Restore env var
    if (originalEnv !== undefined) {
      process.env.AGENTBOARD_SESSION_POOL_SIZE = originalEnv
    } else {
      delete process.env.AGENTBOARD_SESSION_POOL_SIZE
    }

    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('returns default 2 when no config or env var', () => {
    expect(resolvePoolSize()).toBe(2)
  })

  test('returns env var value when set', () => {
    process.env.AGENTBOARD_SESSION_POOL_SIZE = '5'
    expect(resolvePoolSize()).toBe(5)
  })

  test('returns project_profile.yaml value when present', () => {
    const profileContent = `
machine_capacity:
  session_pool_size: 10
`
    fs.writeFileSync(path.join(testDir, 'project_profile.yaml'), profileContent)
    expect(resolvePoolSize(testDir)).toBe(10)
  })

  test('project_profile.yaml overrides env var (highest priority)', () => {
    process.env.AGENTBOARD_SESSION_POOL_SIZE = '5'
    const profileContent = `
machine_capacity:
  session_pool_size: 8
`
    fs.writeFileSync(path.join(testDir, 'project_profile.yaml'), profileContent)
    expect(resolvePoolSize(testDir)).toBe(8)
  })

  test('falls back to env var when project_profile.yaml missing', () => {
    process.env.AGENTBOARD_SESSION_POOL_SIZE = '7'
    expect(resolvePoolSize(testDir)).toBe(7)
  })

  test('falls back to default when project_profile.yaml has no session_pool_size', () => {
    const profileContent = `
machine_capacity:
  other_setting: 123
`
    fs.writeFileSync(path.join(testDir, 'project_profile.yaml'), profileContent)
    expect(resolvePoolSize(testDir)).toBe(2)
  })

  test('ignores invalid values and falls through cascade', () => {
    // Invalid in project profile
    const profileContent = `
machine_capacity:
  session_pool_size: "not-a-number"
`
    fs.writeFileSync(path.join(testDir, 'project_profile.yaml'), profileContent)
    process.env.AGENTBOARD_SESSION_POOL_SIZE = '6'
    expect(resolvePoolSize(testDir)).toBe(6)
  })

  test('ignores negative values', () => {
    process.env.AGENTBOARD_SESSION_POOL_SIZE = '-3'
    expect(resolvePoolSize()).toBe(2)
  })

  test('floors decimal values', () => {
    process.env.AGENTBOARD_SESSION_POOL_SIZE = '4.7'
    expect(resolvePoolSize()).toBe(4)
  })
})
