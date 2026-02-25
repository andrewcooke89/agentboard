/**
 * Regression tests for GAP-04, GAP-08
 *
 * GAP-04: No cron component imports framer-motion or motion/react.
 *   All cron UI transitions are abrupt mount/unmount. REQ-10, REQ-49 require
 *   smooth animations matching the SessionList.tsx AnimatePresence pattern.
 *
 * GAP-08: CronSessionLink dropdown is hardcoded to "No active sessions".
 *   The component never imports useSessionStore and has no session navigation.
 *   CronJobDetail's managed toggle is a static icon with no click handler.
 *   REQ-73, REQ-74, REQ-76 require functional session linking.
 *
 * These tests MUST FAIL until the fixes are applied.
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const cronDir = resolve(import.meta.dir, '..', 'components', 'cron')

// ── GAP-04: Animations ──────────────────────────────────────────────────────

describe('GAP-04: framer-motion animations in cron components', () => {
  const motionImportPattern = /from ['"]motion\/react['"]|from ['"]framer-motion['"]/

  const componentsRequiringMotion = [
    'CronJobList.tsx',
    'CronManager.tsx',
    'CronJobDetail.tsx',
    'CronRunNowOutput.tsx',
    'CronTimeline.tsx',
    'CronEmptyState.tsx',
  ]

  for (const file of componentsRequiringMotion) {
    test(`${file} imports motion/react for animations`, () => {
      const src = readFileSync(resolve(cronDir, file), 'utf-8')
      // After fix: each component should import from 'motion/react'
      // BUG (current code): zero cron components import motion
      expect(src).toMatch(motionImportPattern)
    })
  }
})

// ── GAP-08: Session linking ─────────────────────────────────────────────────

describe('GAP-08: CronSessionLink session store integration', () => {
  test('CronSessionLink imports session store for real session data', () => {
    const src = readFileSync(resolve(cronDir, 'CronSessionLink.tsx'), 'utf-8')
    // After fix: should import useSessionStore or equivalent session data hook
    // BUG (current code): no session store import; dropdown is hardcoded
    expect(src).toMatch(/useSessionStore|useSessions|sessionStore/)
  })

  test('CronSessionLink does not hardcode "No active sessions"', () => {
    const src = readFileSync(resolve(cronDir, 'CronSessionLink.tsx'), 'utf-8')
    // After fix: the hardcoded text is replaced by dynamic session list
    // BUG (current code): line 58 contains 'No active sessions' literal
    expect(src).not.toContain('No active sessions')
  })
})
