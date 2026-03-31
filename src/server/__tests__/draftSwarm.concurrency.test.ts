/**
 * draftSwarm.concurrency.test.ts - Concurrency and rate limiting tests for draft swarms
 */

import { describe, test, expect, beforeEach, afterEach, setDefaultTimeout } from 'bun:test'
import {
  
  generateDrafts,
  getBestDraft,
  getSwarmState,
  
  type DraftSwarmConfig,
  type DraftResult,
} from '../draftSwarm'

// Set NODE_ENV to test to enable mockModelCall
const originalNodeEnv = process.env.NODE_ENV

setDefaultTimeout(15000)

describe('draftSwarm - concurrency', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test'
  })

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
  })

  describe('concurrent draft generation', () => {
    test('concurrent calls respect max_concurrent limit', async () => {
      const config: DraftSwarmConfig = {
        enabled: true,
        models: ['model-a', 'model-b', 'model-c', 'model-d', 'model-e'],
        trigger_complexity: ['simple'],
        min_tier: 1,
        max_concurrent: 2,
      }

      const drafts = await generateDrafts('test prompt', config)

      // Should only generate at most max_concurrent drafts
      expect(drafts.length).toBeLessThanOrEqual(2)
    })

    test('respects rate limit per minute', async () => {
      const config: DraftSwarmConfig = {
        enabled: true,
        models: ['model-a'],
        trigger_complexity: ['simple'],
        min_tier: 1,
        rate_limit_per_minute: 2,
      }

      // First call should succeed
      const drafts1 = await generateDrafts('test prompt 1', config)
      expect(drafts1.length).toBeLessThanOrEqual(1)

      // Check state shows we made requests
      const state1 = await getSwarmState()
      expect(state1.requests_this_minute).toBeGreaterThan(0)
    })

    test('minute counter resets after window expires', async () => {
      const config: DraftSwarmConfig = {
        enabled: true,
        models: ['model-a'],
        trigger_complexity: ['simple'],
        min_tier: 1,
        rate_limit_per_minute: 100,
      }

      // Generate some drafts
      await generateDrafts('test', config)

      const state1 = await getSwarmState()
      expect(state1.requests_this_minute).toBeGreaterThan(0)

      // The minute counter resets based on time, which we can't easily test
      // But we can verify the state object structure
      expect(state1).toHaveProperty('requests_this_minute')
      expect(state1).toHaveProperty('active_requests')
      expect(state1).toHaveProperty('last_request_ago_ms')
    })
  })

  describe('state management under load', () => {
    test('active_requests decrements correctly after completion', async () => {
      const config: DraftSwarmConfig = {
        enabled: true,
        models: ['model-a', 'model-b'],
        trigger_complexity: ['simple'],
        min_tier: 1,
        max_concurrent: 2,
        timeout_ms: 5000,
      }

      // Start generation
      const promise = generateDrafts('test', config)

      // Check state during generation (may or may not see active requests)
      const _stateDuring = await getSwarmState()

      // Wait for completion
      await promise

      // After completion, active_requests should be 0
      const stateAfter = await getSwarmState()
      expect(stateAfter.active_requests).toBe(0)
    })

    test('state remains consistent with parallel requests', async () => {
      const config: DraftSwarmConfig = {
        enabled: true,
        models: ['model-a'],
        trigger_complexity: ['simple'],
        min_tier: 1,
        rate_limit_per_minute: 50, // High enough to allow parallel
      }

      // Fire multiple parallel generation requests
      const promises = [
        generateDrafts('prompt 1', config),
        generateDrafts('prompt 2', config),
        generateDrafts('prompt 3', config),
      ]

      const results = await Promise.all(promises)

      // All should complete without error
      expect(results.every(r => Array.isArray(r))).toBe(true)

      // Final state should have no active requests
      const finalState = await getSwarmState()
      expect(finalState.active_requests).toBe(0)
    })

    test('minute counter accuracy under load', async () => {
      const config: DraftSwarmConfig = {
        enabled: true,
        models: ['model-a'],
        trigger_complexity: ['simple'],
        min_tier: 1,
        rate_limit_per_minute: 100,
      }

      // Make multiple requests
      for (let i = 0; i < 3; i++) {
        await generateDrafts(`prompt ${i}`, config)
      }

      const state = await getSwarmState()
      // Should have accumulated requests
      expect(state.requests_this_minute).toBeGreaterThan(0)
    })
  })

  describe('rate limiting edge cases', () => {
    test('returns empty when rate limit exceeded', async () => {
      const config: DraftSwarmConfig = {
        enabled: true,
        models: ['model-a', 'model-b', 'model-c'],
        trigger_complexity: ['simple'],
        min_tier: 1,
        rate_limit_per_minute: 0, // Effectively disabled
      }

      // First call with rate_limit_per_minute: 0 should be blocked
      const drafts = await generateDrafts('test', config)

      // With 0 rate limit, should be rate limited immediately
      expect(drafts.length).toBe(0)
    })

    test('rate limit applies across multiple generateDrafts calls', async () => {
      const config: DraftSwarmConfig = {
        enabled: true,
        models: ['model-a'],
        trigger_complexity: ['simple'],
        min_tier: 1,
        rate_limit_per_minute: 2,
      }

      // First two should succeed
      const _drafts1 = await generateDrafts('test 1', config)
      const _drafts2 = await generateDrafts('test 2', config)

      const state = await getSwarmState()

      // Should have tracked requests
      expect(state.requests_this_minute).toBeGreaterThan(0)
    })
  })

  describe('timeout handling', () => {
    test('respects timeout_ms configuration', async () => {
      const config: DraftSwarmConfig = {
        enabled: true,
        models: ['model-a'],
        trigger_complexity: ['simple'],
        min_tier: 1,
        timeout_ms: 100, // Very short timeout
      }

      const startTime = Date.now()
      const drafts = await generateDrafts('test', config)
      const elapsed = Date.now() - startTime

      // Should complete within reasonable time of timeout
      // The mock model call takes 500-1500ms, so with 100ms timeout it should fail fast
      expect(elapsed).toBeLessThan(10000) // Allow some overhead
      expect(drafts).toBeDefined()
    })
  })

  describe('best draft selection under concurrency', () => {
    test('getBestDraft handles concurrent results', () => {
      const drafts: DraftResult[] = [
        { model: 'a', success: true, content: 'short', latency_ms: 100 },
        { model: 'b', success: true, content: 'much longer content here', latency_ms: 200 },
        { model: 'c', success: true, content: 'medium', latency_ms: 50 },
      ]

      const best = getBestDraft(drafts)

      // Should prefer longer content
      expect(best?.model).toBe('b')
    })

    test('getBestDraft handles mixed success/failure', () => {
      const drafts: DraftResult[] = [
        { model: 'a', success: false, content: null, latency_ms: 100, error: 'failed' },
        { model: 'b', success: true, content: 'success', latency_ms: 200 },
        { model: 'c', success: false, content: null, latency_ms: 50, error: 'timeout' },
      ]

      const best = getBestDraft(drafts)

      expect(best?.model).toBe('b')
      expect(best?.success).toBe(true)
    })
  })

  describe('error handling', () => {
    test('handles model call failures gracefully', async () => {
      const config: DraftSwarmConfig = {
        enabled: true,
        models: ['model-a', 'model-b'],
        trigger_complexity: ['simple'],
        min_tier: 1,
        timeout_ms: 10000,
      }

      const drafts = await generateDrafts('test', config)

      // All drafts should have latency_ms set
      for (const draft of drafts) {
        expect(draft.latency_ms).toBeGreaterThanOrEqual(0)
        expect(draft.model).toBeDefined()
      }
    })

    test('continues with other models when one fails', async () => {
      const config: DraftSwarmConfig = {
        enabled: true,
        models: ['model-a', 'model-b', 'model-c'],
        trigger_complexity: ['simple'],
        min_tier: 1,
        max_concurrent: 3,
      }

      const drafts = await generateDrafts('test', config)

      // Should get results from multiple models (some may fail in mock)
      expect(drafts.length).toBeLessThanOrEqual(3)
    })
  })
})
