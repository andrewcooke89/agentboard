/**
 * Regression tests for health computation gaps (Bug 1)
 *
 * BUG 1: Health computation unwired from polling loop; health endpoint bypasses enriched cache
 *
 * Two separate wiring gaps prevent health data from reaching consumers:
 * (a) startPolling() never enriches jobs with health - computeHealth() is never called
 * (b) handleGetHealth() calls discoverAllJobs() directly, bypassing the enriched jobCache
 *
 * These tests MUST FAIL until the fix is applied.
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const serverDir = resolve(import.meta.dir, '..')

describe('BUG-1: Health computation unwired', () => {
  describe('startPolling health enrichment', () => {
    test('startPolling() should call enrichAllJobsWithHealth or computeHealth on discovered jobs', () => {
      const src = readFileSync(resolve(serverDir, 'cronManager.ts'), 'utf-8')

      // Find the startPolling method and extract its body
      const startPollingMatch = src.match(/startPolling\s*\([^)]*\)\s*:\s*void\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/s)

      // BUG: Currently startPolling() only calls discoverAllJobs() then computeDiff()
      // It never enriches jobs with health data
      expect(startPollingMatch).not.toBeNull()

      const methodBody = startPollingMatch![1]

      // After fix: the method should enrich jobs with health before computing diff
      // This will FAIL with current code because neither computeHealth nor enrichAllJobsWithHealth
      // is called within startPolling
      const callsHealthEnrichment =
        methodBody.includes('computeHealth') ||
        methodBody.includes('enrichAllJobsWithHealth') ||
        methodBody.includes('enrichJobsWithHealth')

      expect(callsHealthEnrichment).toBe(true)
    })

    test('computeDiff should compare enriched jobs against enriched cache (no spurious diffs)', () => {
      const src = readFileSync(resolve(serverDir, 'cronManager.ts'), 'utf-8')

      // BUG: computeDiff compares enriched cached jobs against raw discovered jobs
      // using JSON.stringify, causing spurious diffs every tick because enriched
      // jobs have extra fields (health, avgDuration, etc.)

      // After fix: computeDiff should receive already-enriched jobs
      // Check that startPolling enriches before calling computeDiff

      const startPollingMatch = src.match(
        /startPolling\s*\([^)]*\)\s*:\s*void\s*\{[\s\S]*?computeDiff\s*\(/s
      )

      // Currently there's no enrichment between discoverAllJobs() and computeDiff()
      expect(startPollingMatch).not.toBeNull()

      const pollingBlock = startPollingMatch![0]

      // Check for enrichment between discoverAllJobs and computeDiff
      const discoverIdx = pollingBlock.indexOf('discoverAllJobs')
      const diffIdx = pollingBlock.indexOf('computeDiff')

      const betweenCalls = pollingBlock.slice(discoverIdx, diffIdx)

      // Should have health enrichment between discover and diff
      const hasEnrichment =
        betweenCalls.includes('enrich') ||
        betweenCalls.includes('Health')

      expect(hasEnrichment).toBe(true)
    })
  })

  describe('handleGetHealth cache usage', () => {
    test('handleGetHealth should read from jobCache instead of discoverAllJobs()', () => {
      const src = readFileSync(resolve(serverDir, 'cronAiService.ts'), 'utf-8')

      // Find handleGetHealth method
      const healthMatch = src.match(
        /handleGetHealth\s*\([^)]*\)[^{]*\{[\s\S]*?^  \}/m
      )

      expect(healthMatch).not.toBeNull()

      const methodBody = healthMatch![0]

      // BUG: Currently calls cm.discoverAllJobs() directly
      // After fix: Should read from cm.jobCache first
      const readsFromCache = methodBody.includes('jobCache')
      const callsDiscoverAllJobs = methodBody.includes('discoverAllJobs')

      // Should NOT call discoverAllJobs as primary source
      // Should read from jobCache instead
      expect(readsFromCache || !callsDiscoverAllJobs).toBe(true)
    })

    test('handleGetFailingJobs should read from jobCache', () => {
      const src = readFileSync(resolve(serverDir, 'cronAiService.ts'), 'utf-8')

      const methodMatch = src.match(
        /handleGetFailingJobs\s*\([^)]*\)[^{]*\{[\s\S]*?^  \}/m
      )

      expect(methodMatch).not.toBeNull()

      const methodBody = methodMatch![0]

      // BUG: Currently calls discoverAllJobs() directly
      const readsFromCache = methodBody.includes('jobCache')
      const callsDiscoverAllJobs = methodBody.includes('discoverAllJobs')

      expect(readsFromCache || !callsDiscoverAllJobs).toBe(true)
    })

    test('handleGetScheduleConflicts should read from jobCache', () => {
      const src = readFileSync(resolve(serverDir, 'cronAiService.ts'), 'utf-8')

      const methodMatch = src.match(
        /handleGetScheduleConflicts\s*\([^)]*\)[^{]*\{[\s\S]*?^  \}/m
      )

      expect(methodMatch).not.toBeNull()

      const methodBody = methodMatch![0]

      // BUG: Currently calls discoverAllJobs() directly
      const readsFromCache = methodBody.includes('jobCache')
      const callsDiscoverAllJobs = methodBody.includes('discoverAllJobs')

      expect(readsFromCache || !callsDiscoverAllJobs).toBe(true)
    })

    test('handleGetScheduleLoad should read from jobCache', () => {
      const src = readFileSync(resolve(serverDir, 'cronAiService.ts'), 'utf-8')

      const methodMatch = src.match(
        /handleGetScheduleLoad\s*\([^)]*\)[^{]*\{[\s\S]*?^  \}/m
      )

      expect(methodMatch).not.toBeNull()

      const methodBody = methodMatch![0]

      // BUG: Currently calls discoverAllJobs() directly
      const readsFromCache = methodBody.includes('jobCache')
      const callsDiscoverAllJobs = methodBody.includes('discoverAllJobs')

      expect(readsFromCache || !callsDiscoverAllJobs).toBe(true)
    })
  })
})
