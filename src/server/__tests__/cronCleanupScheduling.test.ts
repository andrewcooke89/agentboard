/**
 * Regression test for GAP-06: Orphan cleanup and history pruning never scheduled
 *
 * cleanOrphanedPrefs() and pruneRunHistory() in cronManager.ts are fully
 * implemented but never called from any code path. No setInterval, no
 * post-poll hook, and no startup call invokes either method.
 *
 * This test MUST FAIL until the fix wires setInterval calls in index.ts.
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const serverDir = resolve(import.meta.dir, '..')

describe('GAP-06: cleanup scheduling for cron orphan prefs and history pruning', () => {
  test('index.ts references cleanOrphanedPrefs in cron cleanup scheduling', () => {
    const src = readFileSync(resolve(serverDir, 'index.ts'), 'utf-8')
    // After fix: index.ts should wire cleanOrphanedPrefs to a setInterval
    // BUG (current code): index.ts never mentions cleanOrphanedPrefs
    expect(src).toContain('cleanOrphanedPrefs')
  })

  test('index.ts references pruneRunHistory in cron cleanup scheduling', () => {
    const src = readFileSync(resolve(serverDir, 'index.ts'), 'utf-8')
    // After fix: index.ts should wire pruneRunHistory to a setInterval
    // BUG (current code): index.ts never mentions pruneRunHistory
    expect(src).toContain('pruneRunHistory')
  })
})
