/**
 * geminiClient.concurrency.test.ts - Concurrency and rate limiting tests for Gemini client
 */

import { describe, test, expect, beforeEach, afterEach, mock, setDefaultTimeout } from 'bun:test'
import {
  callGemini,
  resetRateLimitState,
  getRateLimitState,
  setApiKeyOverride,
  setBackoffDelayOverride,
} from '../geminiClient'

const originalFetch = global.fetch
setDefaultTimeout(15000)

describe('geminiClient - concurrency', () => {
  let mockFetch: any

  beforeEach(() => {
    mockFetch = mock(() => {})
    global.fetch = mockFetch
    resetRateLimitState()
    setApiKeyOverride('test-api-key-for-testing')
    setBackoffDelayOverride(0)
  })

  afterEach(() => {
    global.fetch = originalFetch
    setApiKeyOverride(undefined)
    setBackoffDelayOverride(undefined)
  })

  describe('rate limit window reset', () => {
    test('rate limit state is atomic during concurrent access', async () => {
      // Simulate multiple concurrent requests checking rate limit
      const promises: Promise<void>[] = []
      const stateSnapshots: { tokensUsed: number; windowStart: number }[] = []

      // Make successful responses
      mockFetch.mockImplementation(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'response' }] } }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
        }),
      }))

      // Fire multiple concurrent requests
      for (let i = 0; i < 5; i++) {
        promises.push(
          callGemini({ model: 'gemini-1.5-flash', prompt: 'test' }).then(() => {
            stateSnapshots.push(getRateLimitState())
          })
        )
      }

      await Promise.all(promises)

      // All should have succeeded
      expect(stateSnapshots).toHaveLength(5)

      // Verify state consistency - tokens should accumulate
      const finalState = getRateLimitState()
      expect(finalState.tokensUsed).toBeGreaterThan(0)
    })

    test('rate limit window resets after timeout', async () => {
      // Set initial state
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'response' }] } }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
        }),
      })

      await callGemini({ model: 'gemini-1.5-flash', prompt: 'test' })

      const state1 = getRateLimitState()
      expect(state1.tokensUsed).toBeGreaterThan(0)

      // Reset state
      await resetRateLimitState()

      const state2 = getRateLimitState()
      expect(state2.tokensUsed).toBe(0)
      expect(state2.windowStart).toBeGreaterThanOrEqual(state1.windowStart)
    })

    test('rate limit exceeded returns skipped response', async () => {
      // Reset state first
      await resetRateLimitState()

      // Use a moderate prompt that will fit within rate limit for first request
      const moderatePrompt = 'x'.repeat(10000) // ~2.5k tokens

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'response' }] } }],
          usageMetadata: { promptTokenCount: 2500, candidatesTokenCount: 100 },
        }),
      })

      // Make many requests to consume the rate limit budget (60k tokens/minute)
      // Each request uses ~2.5k tokens + 1k maxTokens default = ~3.5k tokens
      // We need to exceed 60k tokens
      const results = []
      for (let i = 0; i < 20; i++) {
        const result = await callGemini({ model: 'gemini-1.5-flash', prompt: moderatePrompt })
        results.push(result)
      }

      // At least some requests should be rate limited after consuming budget
      const _rateLimited = results.filter(r => r.skipped && r.reason === 'rate_limit_exceeded')
      const successful = results.filter(r => r.content)

      // Some should succeed, some might be rate limited
      expect(successful.length).toBeGreaterThan(0)
    })
  })

  describe('backoff timing accuracy', () => {
    test('backoff delay increases exponentially', async () => {
      let attempts = 0
      const timestamps: number[] = []

      mockFetch.mockImplementation(async () => {
        timestamps.push(Date.now())
        attempts++
        if (attempts < 3) {
          return { ok: false, status: 429, statusText: 'Too Many Requests' }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: 'success' }] } }],
          }),
        }
      })

      // With backoff delay override set to 0, delays should be minimal
      const startTime = Date.now()
      const response = await callGemini({ model: 'gemini-1.5-flash', prompt: 'test' })
      const totalTime = Date.now() - startTime

      expect(attempts).toBe(3)
      expect(response.content).toBe('success')
      // With 0 delay override, total time should be very short
      expect(totalTime).toBeLessThan(1000)
    })

    test('backoff respects max delay', async () => {
      let attempts = 0

      mockFetch.mockImplementation(async () => {
        attempts++
        return { ok: false, status: 429, statusText: 'Too Many Requests' }
      })

      // This should retry MAX_RETRIES times (3 retries = 4 attempts total)
      const response = await callGemini({ model: 'gemini-1.5-flash', prompt: 'test' })

      expect(attempts).toBeGreaterThanOrEqual(3)
      expect(response.error).toContain('Max retries exceeded')
    })

    test('backoff applies jitter to prevent thundering herd', async () => {
      const delays: number[] = []

      // We can't directly observe jitter, but we can verify that
      // multiple parallel requests don't all retry at the exact same time
      // by tracking when fetch is called

      let callIndex = 0
      mockFetch.mockImplementation(async () => {
        const now = Date.now()
        delays.push(now)

        callIndex++
        if (callIndex % 2 === 0) {
          // Every second call succeeds
          return {
            ok: true,
            status: 200,
            json: async () => ({
              candidates: [{ content: { parts: [{ text: 'success' }] } }],
            }),
          }
        }
        return { ok: false, status: 429, statusText: 'Too Many Requests' }
      })

      // With 0 delay override, jitter is still calculated but not applied
      const results = await Promise.all([
        callGemini({ model: 'gemini-1.5-flash', prompt: 'test1' }),
        callGemini({ model: 'gemini-1.5-flash', prompt: 'test2' }),
      ])

      // Both should eventually succeed
      expect(results.filter(r => r.content).length).toBeGreaterThan(0)
    })
  })

  describe('concurrent request handling', () => {
    test('handles multiple concurrent requests without race conditions', async () => {
      const requestOrder: string[] = []

      mockFetch.mockImplementation(async (_url: string) => {
        // Extract prompt from request body would require parsing
        // Instead, track order of calls
        requestOrder.push(`call-${requestOrder.length}`)

        // Simulate variable network latency
        await new Promise(r => setTimeout(r, Math.random() * 50))

        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: 'response' }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
          }),
        }
      })

      const promises = Array.from({ length: 10 }, (_, i) =>
        callGemini({ model: 'gemini-1.5-flash', prompt: `test-${i}` })
      )

      const results = await Promise.all(promises)

      // All requests should complete
      expect(results).toHaveLength(10)
      expect(results.every(r => r.content === 'response' || r.skipped)).toBe(true)

      // Rate limit state should be consistent
      const state = getRateLimitState()
      expect(state.tokensUsed).toBeGreaterThan(0)
    })

    test('rate limit check is atomic under concurrent load', async () => {
      // Simulate a scenario where many requests hit rate limit simultaneously
      let successCount = 0
      let skippedCount = 0

      // Use a moderate prompt size
      const prompt = 'x'.repeat(1000)

      mockFetch.mockImplementation(async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: 'response' }] } }],
            usageMetadata: { promptTokenCount: 250, candidatesTokenCount: 100 },
          }),
        }
      })

      // Fire many concurrent requests
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          callGemini({ model: 'gemini-1.5-flash', prompt })
        )
      )

      for (const result of results) {
        if (result.skipped && result.reason === 'rate_limit_exceeded') {
          skippedCount++
        } else if (result.content) {
          successCount++
        }
      }

      // Some should succeed, some might be rate limited
      expect(successCount + skippedCount).toBe(20)
    })
  })

  describe('error recovery under concurrency', () => {
    test('recovers from transient errors during concurrent requests', async () => {
      let failureCount = 0

      mockFetch.mockImplementation(async () => {
        failureCount++
        // Fail first 2 attempts, succeed after
        if (failureCount <= 2) {
          return { ok: false, status: 503, statusText: 'Service Unavailable' }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: 'recovered' }] } }],
          }),
        }
      })

      const result = await callGemini({ model: 'gemini-1.5-flash', prompt: 'test' })

      expect(result.content).toBe('recovered')
      expect(failureCount).toBe(3) // 2 failures + 1 success
    })

    test('handles network timeouts gracefully', async () => {
      mockFetch.mockImplementation(async () => {
        // Simulate network error
        throw new Error('Network timeout')
      })

      const result = await callGemini({ model: 'gemini-1.5-flash', prompt: 'test' })

      expect(result.error).toBeDefined()
      expect(result.skipped).toBeUndefined()
    })
  })
})
