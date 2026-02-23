/**
 * sessionPool.ts -- Session pool manager for DAG engine (Phase 5)
 *
 * Wraps poolStore with transactional slot management using BEGIN IMMEDIATE
 * to prevent double-granting under concurrent access.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import yaml from 'js-yaml'
import { createPoolStore } from './poolStore'
import type { PoolSlotRequest, PoolConfig } from './poolStore'

export interface SlotRequestResult {
  slot: PoolSlotRequest | null
  rejected: boolean
  reason?: string
  queueDepth?: number
  maxDepth?: number
}

export interface SessionPool {
  /**
   * Request a pool slot for a step.
   *
   * Behavior:
   * - If pool capacity available: grants slot immediately (status = 'active').
   * - If pool is full but queue has room: queues the request (status = 'queued').
   *   This is "pool full" -- active slots are at max, but the queue can absorb more.
   * - If pool is full AND queue is at max depth: rejects the request entirely.
   *   This is "queue full" -- backpressure to prevent unbounded queue growth.
   *   (REQ-24: Queue depth enforcement at slot-request time, not just run submission.)
   *
   * @returns SlotRequestResult with the slot (or null if rejected), and rejection details.
   */
  requestSlot(request: { runId: string; stepName: string; tier: number }): SlotRequestResult
  releaseSlot(slotId: string): PoolSlotRequest | null
  getStatus(): { config: PoolConfig; active: PoolSlotRequest[]; queue: PoolSlotRequest[] }
  updateConfig(maxSlots: number): void
  getSlot(id: string): PoolSlotRequest | null
  /** Get the current max queue depth setting. */
  getMaxQueueDepth(): number
}

/**
 * REQ-17: Resolve pool size with cascade priority:
 * 1. project_profile.yaml -> machine_capacity.session_pool_size
 * 2. AGENTBOARD_SESSION_POOL_SIZE env var
 * 3. Default: 2
 */
export function resolvePoolSize(projectDir?: string): number {
  // Priority 1: Check project_profile.yaml if projectDir is provided
  if (projectDir) {
    try {
      const profilePath = path.join(projectDir, 'project_profile.yaml')
      if (fs.existsSync(profilePath)) {
        const content = fs.readFileSync(profilePath, 'utf-8')
        const profile = yaml.load(content) as any
        if (profile?.machine_capacity?.session_pool_size != null) {
          const size = Number(profile.machine_capacity.session_pool_size)
          if (Number.isFinite(size) && size > 0) {
            return Math.floor(size)
          }
        }
      }
    } catch {
      // File doesn't exist or parse error - fall through to next priority
    }
  }

  // Priority 2: Check environment variable
  const envSize = process.env.AGENTBOARD_SESSION_POOL_SIZE
  if (envSize != null) {
    const size = Number(envSize)
    if (Number.isFinite(size) && size > 0) {
      return Math.floor(size)
    }
  }

  // Priority 3: Default
  return 2
}

export function createSessionPool(db: SQLiteDatabase): SessionPool {
  const store = createPoolStore(db)

  // REQ-24: Queue depth limit resolved from env (default 50)
  const maxQueueDepth = Number(process.env.AGENTBOARD_MAX_POOL_QUEUE_DEPTH) || 50

  return {
    /**
     * Request a pool slot. Uses BEGIN IMMEDIATE transaction for safety.
     *
     * REQ-24: Queue depth is enforced HERE (at slot-request time), not just at
     * run submission. This prevents unbounded queue growth from steps within
     * already-running workflows.
     *
     * Three outcomes:
     * 1. Pool has capacity -> slot granted as 'active' (pool not full)
     * 2. Pool full, queue has room -> slot inserted as 'queued' (pool full, queue not full)
     * 3. Pool full, queue at max depth -> request REJECTED (queue full)
     */
    requestSlot(request) {
      const txn = db.transaction(() => {
        const config = store.getPoolConfig()
        const activeCount = store.getActiveCount()

        // Case 1: Capacity available -- grant immediately
        if (activeCount < config.maxSlots) {
          const slot = store.insertSlot({
            ...request,
            status: 'active',
            grantedAt: new Date().toISOString(),
          })
          return { slot, rejected: false } as SlotRequestResult
        }

        // Case 2 vs 3: Pool is full -- check queue depth before queuing
        // CF-01/REQ-24: Check queue length BEFORE adding to queue
        const currentQueueDepth = store.listQueuedSlots().length
        if (currentQueueDepth >= maxQueueDepth) {
          // Case 3: Queue full -- reject
          return {
            slot: null,
            rejected: true,
            reason: `Pool queue full (${currentQueueDepth} pending, max ${maxQueueDepth}). Wait for current steps to complete or increase pool size.`,
            queueDepth: currentQueueDepth,
            maxDepth: maxQueueDepth,
          } as SlotRequestResult
        }

        // Case 2: Queue has room -- insert as queued
        const slot = store.insertSlot({
          ...request,
          status: 'queued',
        })
        return { slot, rejected: false } as SlotRequestResult
      })
      return txn.immediate()
    },

    /**
     * Release a slot. Atomically promotes next queued slot if any.
     * Returns the promoted slot (or null if queue was empty).
     */
    releaseSlot(slotId) {
      const txn = db.transaction(() => {
        store.updateSlotStatus(slotId, 'released', {
          releasedAt: new Date().toISOString(),
        })
        // Promote next queued (highest tier, oldest request)
        const next = store.getNextQueued()
        if (next) {
          store.updateSlotStatus(next.id, 'active', {
            grantedAt: new Date().toISOString(),
          })
          return { ...next, status: 'active' as const, grantedAt: new Date().toISOString() }
        }
        return null
      })
      return txn.immediate()
    },

    getStatus() {
      return {
        config: store.getPoolConfig(),
        active: store.listActiveSlots(),
        queue: store.listQueuedSlots(),
      }
    },

    updateConfig(maxSlots) {
      store.updatePoolConfig(maxSlots)
    },

    getSlot(id) {
      return store.getSlot(id)
    },

    getMaxQueueDepth() {
      return maxQueueDepth
    },
  }
}
