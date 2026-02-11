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

export interface SessionPool {
  requestSlot(request: { runId: string; stepName: string; tier: number }): PoolSlotRequest
  releaseSlot(slotId: string): PoolSlotRequest | null
  getStatus(): { config: PoolConfig; active: PoolSlotRequest[]; queue: PoolSlotRequest[] }
  updateConfig(maxSlots: number): void
  getSlot(id: string): PoolSlotRequest | null
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

  return {
    /**
     * Request a pool slot. Uses BEGIN IMMEDIATE transaction for safety.
     * If capacity available: inserts as 'active' with granted_at.
     * If full: inserts as 'queued'.
     */
    requestSlot(request) {
      const txn = db.transaction(() => {
        const config = store.getPoolConfig()
        const activeCount = store.getActiveCount()
        if (activeCount < config.maxSlots) {
          return store.insertSlot({
            ...request,
            status: 'active',
            grantedAt: new Date().toISOString(),
          })
        } else {
          return store.insertSlot({
            ...request,
            status: 'queued',
          })
        }
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
  }
}
