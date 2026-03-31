/**
 * Regression test for regex extraction bug in health-gaps-regression.test.ts
 *
 * BUG: The regex on line 25 of health-gaps-regression.test.ts uses a single-level
 * brace-matching pattern that fails to capture method bodies with nested braces.
 *
 * The startPolling() method has THREE levels of nested braces:
 *   - method body { ... }
 *   - if-block { ... }
 *   - setInterval callback { ... }
 *   - inner if-block { ... }
 *
 * The broken regex: /startPolling\s*\([^)]*\)\s*:\s*void\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/s
 * Only matches up to the first if-block's closing brace, never reaching the
 * enrichAllJobsWithHealth call inside the setInterval callback.
 *
 * The fix: /startPolling\s*\([^)]*\)\s*:\s*void\s*\{([\s\S]*?)\n  \}/m
 * Uses indentation-based boundary matching to capture the full method body.
 *
 * This test MUST FAIL with the broken regex and PASS with the fixed regex.
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const serverDir = resolve(import.meta.dir, '..')

describe('REGEX-BUG: startPolling method extraction', () => {
  const src = readFileSync(resolve(serverDir, 'cronManager.ts'), 'utf-8')

  describe('broken regex (single-level brace matching)', () => {
    // This is the BROKEN regex from health-gaps-regression.test.ts line 25
    const brokenRegex = /startPolling\s*\([^)]*\)\s*:\s*void\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/s

    test('broken regex fails to capture enrichAllJobsWithHealth in method body', () => {
      const match = src.match(brokenRegex)

      // The regex should match something
      expect(match).not.toBeNull()

      const methodBody = match![1]

      // BUG: The broken regex captures only up to the first if-block's closing brace
      // It does NOT include the setInterval callback body
      // So enrichAllJobsWithHealth is NOT in the captured body
      const callsEnrichment = methodBody.includes('enrichAllJobsWithHealth')

      // This assertion FAILS with the broken regex because the method body
      // is truncated at the first nested closing brace
      expect(callsEnrichment).toBe(true)
    })

    test('broken regex captures only partial method body', () => {
      const match = src.match(brokenRegex)

      expect(match).not.toBeNull()

      const methodBody = match![1]

      // The broken regex should NOT capture the setInterval callback
      // This demonstrates the bug - the method body is incomplete
      const hasSetInterval = methodBody.includes('setInterval')
      const hasDiscoverAllJobs = methodBody.includes('discoverAllJobs')
      const hasComputeDiff = methodBody.includes('computeDiff')

      // With broken regex: hasSetInterval, hasDiscoverAllJobs, hasComputeDiff are all false
      // because the regex terminates at the if-block's closing brace
      expect({
        hasSetInterval,
        hasDiscoverAllJobs,
        hasComputeDiff,
      }).toEqual({
        hasSetInterval: true,
        hasDiscoverAllJobs: true,
        hasComputeDiff: true,
      })
    })
  })

  describe('fixed regex (indentation-based boundary)', () => {
    // This is the FIXED regex using indentation-based boundary
    const fixedRegex = /startPolling\s*\([^)]*\)\s*:\s*void\s*\{([\s\S]*?)\n  \}/m

    test('fixed regex correctly captures enrichAllJobsWithHealth', () => {
      const match = src.match(fixedRegex)

      expect(match).not.toBeNull()

      const methodBody = match![1]

      // The fixed regex should capture the full method body including
      // the setInterval callback where enrichAllJobsWithHealth is called
      const callsEnrichment = methodBody.includes('enrichAllJobsWithHealth')

      // This assertion PASSES with the fixed regex
      expect(callsEnrichment).toBe(true)
    })

    test('fixed regex captures complete method body', () => {
      const match = src.match(fixedRegex)

      expect(match).not.toBeNull()

      const methodBody = match![1]

      // The fixed regex should capture the full method body
      const hasSetInterval = methodBody.includes('setInterval')
      const hasDiscoverAllJobs = methodBody.includes('discoverAllJobs')
      const hasEnrichAllJobsWithHealth = methodBody.includes('enrichAllJobsWithHealth')
      const hasComputeDiff = methodBody.includes('computeDiff')

      // With fixed regex: all should be true
      expect({
        hasSetInterval,
        hasDiscoverAllJobs,
        hasEnrichAllJobsWithHealth,
        hasComputeDiff,
      }).toEqual({
        hasSetInterval: true,
        hasDiscoverAllJobs: true,
        hasEnrichAllJobsWithHealth: true,
        hasComputeDiff: true,
      })
    })

    test('fixed regex captures correct enrichment ordering', () => {
      const match = src.match(fixedRegex)

      expect(match).not.toBeNull()

      const methodBody = match![1]

      // Verify the correct order: discoverAllJobs -> enrichAllJobsWithHealth -> computeDiff
      const discoverIdx = methodBody.indexOf('discoverAllJobs')
      const enrichIdx = methodBody.indexOf('enrichAllJobsWithHealth')
      const diffIdx = methodBody.indexOf('computeDiff')

      // All should be found
      expect(discoverIdx).toBeGreaterThanOrEqual(0)
      expect(enrichIdx).toBeGreaterThanOrEqual(0)
      expect(diffIdx).toBeGreaterThanOrEqual(0)

      // Verify ordering: discover < enrich < diff
      expect(discoverIdx).toBeLessThan(enrichIdx)
      expect(enrichIdx).toBeLessThan(diffIdx)
    })
  })
})

describe('REGEX-BUG: validation against known structure', () => {
  const src = readFileSync(resolve(serverDir, 'cronManager.ts'), 'utf-8')

  test('startPolling method exists with expected signature', () => {
    // First verify the method exists with the expected signature
    const hasMethod = src.includes('startPolling(intervalMs: number): void')
    expect(hasMethod).toBe(true)
  })

  test('production code calls enrichAllJobsWithHealth', () => {
    // Verify the production code IS correct
    // The bug is in the test regex, not in the production code
    const fixedRegex = /startPolling\s*\([^)]*\)\s*:\s*void\s*\{([\s\S]*?)\n  \}/m
    const match = src.match(fixedRegex)

    expect(match).not.toBeNull()

    // The production code DOES call enrichAllJobsWithHealth
    // Only the broken test regex fails to find it
    expect(match![1]).toContain('enrichAllJobsWithHealth')
  })
})
