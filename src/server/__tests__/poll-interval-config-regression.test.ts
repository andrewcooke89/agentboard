/**
 * Regression tests for poll interval hardcoding (Bug 2)
 *
 * BUG 2: Cron poll interval hardcoded to 5000ms with no env var configuration
 *
 * cronHandlers.ts:138 calls cronManager.startPolling(5000) with a hardcoded
 * integer literal. config.ts has no CRON_POLL_INTERVAL_MS entry.
 *
 * These tests MUST FAIL until the fix is applied.
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const serverDir = resolve(import.meta.dir, '..')

describe('BUG-2: Poll interval hardcoded', () => {
  test('config.ts should export cronPollIntervalMs', () => {
    const src = readFileSync(resolve(serverDir, 'config.ts'), 'utf-8')

    // BUG: config.ts has no cronPollIntervalMs entry
    // After fix: Should have cronPollIntervalMs following the same pattern
    // as taskPollIntervalMs and workflowPollIntervalMs

    const hasCronPollInterval =
      src.includes('cronPollIntervalMs') ||
      src.includes('CRON_POLL_INTERVAL_MS')

    expect(hasCronPollInterval).toBe(true)
  })

  test('config.ts should read CRON_POLL_INTERVAL_MS env var with default 5000', () => {
    const src = readFileSync(resolve(serverDir, 'config.ts'), 'utf-8')

    // Should have env var pattern like: process.env.CRON_POLL_INTERVAL_MS
    const hasEnvVar = src.includes('CRON_POLL_INTERVAL_MS')

    expect(hasEnvVar).toBe(true)
  })

  test('cronHandlers.ts should use config.cronPollIntervalMs instead of hardcoded 5000', () => {
    const src = readFileSync(resolve(serverDir, 'handlers/cronHandlers.ts'), 'utf-8')

    // Find the startPolling call
    const startPollingMatch = src.match(/startPolling\s*\(\s*(\d+)\s*\)/)

    // BUG: Currently startPolling(5000) with hardcoded literal
    // After fix: Should be startPolling(config.cronPollIntervalMs)

    if (startPollingMatch) {
      // If there's a numeric literal, that's the bug
      const argValue = startPollingMatch[1]

      // Should NOT be a bare number - should reference config
      expect(argValue).not.toBe('5000')
    } else {
      // If no numeric literal found, check for config reference
      const hasConfigReference = /startPolling\s*\(\s*config\./.test(src)
      expect(hasConfigReference).toBe(true)
    }
  })

  test('cronHandlers.ts should import config', () => {
    const src = readFileSync(resolve(serverDir, 'handlers/cronHandlers.ts'), 'utf-8')

    // After fix: should import config to use config.cronPollIntervalMs
    const importsConfig = src.includes("from '../config'") ||
                          src.includes('from "@server/config"') ||
                          /import\s+{[^}]*config[^}]*}\s+from/.test(src)

    expect(importsConfig).toBe(true)
  })
})
