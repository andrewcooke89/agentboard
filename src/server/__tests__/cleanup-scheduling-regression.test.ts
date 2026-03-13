/**
 * Regression tests for orphan cleanup and history pruning (Bugs 3 & 4)
 *
 * BUG 3 & 4: Orphan cleanup and history pruning silently no-op because
 * setDb() is deferred until first WS client connects
 *
 * CronManager is instantiated at index.ts:116 with this.db = null.
 * setDb() is only called in startPollingLifecycle() which triggers
 * when the first WebSocket client connects.
 *
 * The cleanup timers at index.ts:317-323 fire after 30 seconds.
 * If no WS client has connected by then, cronManager.db is still null,
 * and cleanOrphanedPrefs()/pruneRunHistory() silently return early.
 *
 * These tests MUST FAIL until the fix is applied.
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const serverDir = resolve(import.meta.dir, '..')

describe('BUG-3 & BUG-4: Cleanup/prune ineffective due to deferred setDb()', () => {
  test('index.ts should call cronManager.setDb() at server startup', () => {
    const src = readFileSync(resolve(serverDir, 'index.ts'), 'utf-8')

    // Find the CronManager instantiation
    const cronManagerMatch = src.match(/const\s+cronManager\s*=\s*new\s+CronManager\s*\(\s*\)/)
    expect(cronManagerMatch).not.toBeNull()

    // Find where setDb is called
    const setDbCalls = src.match(/cronManager\.setDb\s*\(/g) || []

    // After fix: setDb should be called immediately after CronManager instantiation
    // (not just inside startPollingLifecycle)

    // Check if there's a setDb call near the CronManager instantiation
    const instantiationIdx = src.indexOf('const cronManager = new CronManager()')
    const startPollingLifecycleIdx = src.indexOf('startPollingLifecycle')

    // Find setDb calls before startPollingLifecycle definition
    const earlySetDbMatch = src.slice(instantiationIdx, startPollingLifecycleIdx > instantiationIdx ? startPollingLifecycleIdx : src.length)
      .match(/cronManager\.setDb/)

    // After fix: should have setDb call between instantiation and startPollingLifecycle
    expect(earlySetDbMatch).not.toBeNull()
  })

  test('setDb should be called before cleanup setTimeout is scheduled', () => {
    const src = readFileSync(resolve(serverDir, 'index.ts'), 'utf-8')

    // The cleanup timer is scheduled at the bottom of index.ts
    // setDb should be called BEFORE that timer is set up

    const setDbCallIdx = src.indexOf('cronManager.setDb')
    const cleanupTimeoutIdx = src.indexOf('cronManager.cleanOrphanedPrefs')

    // First setDb call should be before cleanup timer
    expect(setDbCallIdx).toBeGreaterThan(0)
    expect(cleanupTimeoutIdx).toBeGreaterThan(0)

    // After fix: setDb should be called before the cleanup timer references cronManager
    expect(setDbCallIdx).toBeLessThan(cleanupTimeoutIdx)
  })

  test('CronManager instantiation block should include immediate setDb call', () => {
    const src = readFileSync(resolve(serverDir, 'index.ts'), 'utf-8')

    // Find the block where CronManager is instantiated
    // It should be followed by setDb call with the db instance

    const lines = src.split('\n')
    let cronManagerLineIdx = -1

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('const cronManager = new CronManager()')) {
        cronManagerLineIdx = i
        break
      }
    }

    expect(cronManagerLineIdx).toBeGreaterThan(-1)

    // Check the next few lines for setDb call
    const nextLines = lines.slice(cronManagerLineIdx + 1, cronManagerLineIdx + 6).join('\n')

    // After fix: should see cronManager.setDb(db.db) or similar
    const hasImmediateSetDb = nextLines.includes('cronManager.setDb')

    expect(hasImmediateSetDb).toBe(true)
  })

  test('db reference should be available at CronManager instantiation time', () => {
    const src = readFileSync(resolve(serverDir, 'index.ts'), 'utf-8')

    // Verify that db.db is available when cronManager is instantiated
    // (it's used for cronHistoryService and cronLogService on lines 117-118)

    const dbInitMatch = src.match(/const\s+db\s*=\s*(?:await\s+)?initDatabase/)
    expect(dbInitMatch).not.toBeNull()

    const cronManagerMatch = src.match(/const\s+cronManager\s*=\s*new\s+CronManager/)
    expect(cronManagerMatch).not.toBeNull()

    const dbInitIdx = src.indexOf('const db = await initDatabase')
    const cronManagerIdx = src.indexOf('const cronManager = new CronManager')

    // db should be initialized before CronManager is created
    expect(dbInitIdx).toBeLessThan(cronManagerIdx)
  })
})
