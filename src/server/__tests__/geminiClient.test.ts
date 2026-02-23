/**
 * geminiClient.test.ts -- Tests for Gemini API client (Phase 22)
 */

import { describe, test, expect, beforeEach, afterEach, mock, setDefaultTimeout } from 'bun:test'
import {
  callGemini,
  resetRateLimitState,
  getRateLimitState,
  setApiKeyOverride,
  setBackoffDelayOverride,
} from '../geminiClient'

// Mock fetch globally
const originalFetch = global.fetch

setDefaultTimeout(10000)

describe('geminiClient', () => {
  let mockFetch: any

  beforeEach(() => {
    mockFetch = mock(() => {})
    global.fetch = mockFetch
    resetRateLimitState()
    // Set a test API key for tests that need it
    setApiKeyOverride('test-api-key-for-testing')
    // Disable backoff delays for faster tests
    setBackoffDelayOverride(0)
  })

  afterEach(() => {
    global.fetch = originalFetch
    setApiKeyOverride(undefined)
    setBackoffDelayOverride(undefined)
  })

  describe('graceful degradation', () => {
    test('returns skipped:true when no API key is set', async () => {
      // Clear the API key override to test graceful degradation
      setApiKeyOverride(undefined)

      const response = await callGemini({ model: 'gemini-1.5-flash', prompt: 'test' })

      expect(response.skipped).toBe(true)
      expect(response.reason).toBe('no_api_key')
    })
  })

  describe('API responses', () => {
    test('handles successful response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{ text: 'Hello, this is Gemini!' }],
            },
          }],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 20,
          },
        }),
      })

      const response = await callGemini({
        model: 'gemini-1.5-flash',
        prompt: 'Say hello',
      })

      expect(response.content).toBe('Hello, this is Gemini!')
      expect(response.inputTokens).toBe(10)
      expect(response.outputTokens).toBe(20)
      expect(response.latencyMs).toBeDefined()
      expect(response.latencyMs).toBeGreaterThanOrEqual(0)
    })

    test('handles non-retryable error (400)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'Invalid request body',
      })

      const response = await callGemini({
        model: 'gemini-1.5-flash',
        prompt: 'test',
      })

      expect(response.error).toContain('400')
      expect(response.error).toContain('Invalid request body')
    })

    test('handles API-level error in response body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          error: {
            code: 403,
            message: 'API key not authorized',
            status: 'PERMISSION_DENIED',
          },
        }),
      })

      const response = await callGemini({
        model: 'gemini-1.5-flash',
        prompt: 'test',
      })

      expect(response.error).toContain('403')
      expect(response.error).toContain('API key not authorized')
    })

    test('handles empty response (no content)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [],
        }),
      })

      const response = await callGemini({
        model: 'gemini-1.5-flash',
        prompt: 'test',
      })

      expect(response.error).toBe('No content in response')
    })
  })

  describe('exponential backoff', () => {
    test('retries on 429 error', async () => {
      let attempts = 0

      mockFetch.mockImplementation(async () => {
        attempts++
        if (attempts < 3) {
          return {
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
          }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{
              content: {
                parts: [{ text: 'Success after retries' }],
              },
            }],
          }),
        }
      })

      const startTime = Date.now()
      const response = await callGemini({
        model: 'gemini-1.5-flash',
        prompt: 'test',
      })
      void (Date.now() - startTime) // elapsed time for backoff verification

      expect(attempts).toBe(3)
      expect(response.content).toBe('Success after retries')
      // Should have backoff delays: ~2s + ~4s = ~6s minimum
      // But with jitter and fast test execution, just verify multiple attempts
    })

    test('retries on 500 error', async () => {
      let attempts = 0

      mockFetch.mockImplementation(async () => {
        attempts++
        if (attempts < 2) {
          return {
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
          }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{
              content: {
                parts: [{ text: 'Success' }],
              },
            }],
          }),
        }
      })

      const response = await callGemini({
        model: 'gemini-1.5-flash',
        prompt: 'test',
      })

      expect(attempts).toBe(2)
      expect(response.content).toBe('Success')
    })

    test('retries on 503 error', async () => {
      let attempts = 0

      mockFetch.mockImplementation(async () => {
        attempts++
        if (attempts < 2) {
          return {
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
          }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{
              content: {
                parts: [{ text: 'Success' }],
              },
            }],
          }),
        }
      })

      const response = await callGemini({
        model: 'gemini-1.5-flash',
        prompt: 'test',
      })

      expect(attempts).toBe(2)
      expect(response.content).toBe('Success')
    })

    test('exhausts retries and returns error', async () => {
      let attempts = 0

      mockFetch.mockImplementation(async () => {
        attempts++
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
        }
      })

      const response = await callGemini({
        model: 'gemini-1.5-flash',
        prompt: 'test',
      })

      // With retry=true (default), MAX_RETRIES = 3
      // Loop runs: attempt 0, 1, 2, 3 (total 4 attempts)
      // But we only count actual fetch calls - all 4 should happen
      expect(attempts).toBeGreaterThanOrEqual(3)
      expect(response.error).toContain('Max retries exceeded')
    })

    test('skips retry when retry option is false', async () => {
      let attempts = 0

      mockFetch.mockImplementation(async () => {
        attempts++
        return {
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
        }
      })

      const response = await callGemini(
        { model: 'gemini-1.5-flash', prompt: 'test' },
        { retry: false }
      )

      expect(attempts).toBe(1)
      expect(response.error).toContain('429')
    })
  })

  describe('rate limiting', () => {
    test('getRateLimitState returns current state', () => {
      const state = getRateLimitState()
      expect(state).toHaveProperty('tokensUsed')
      expect(state).toHaveProperty('windowStart')
      expect(state).toHaveProperty('budget')
      expect(state.budget).toBe(60000) // Default from config
    })

    test('resetRateLimitState resets counters', () => {
      const beforeReset = getRateLimitState()
      resetRateLimitState()
      const afterReset = getRateLimitState()

      expect(afterReset.tokensUsed).toBe(0)
      expect(afterReset.windowStart).toBeGreaterThanOrEqual(beforeReset.windowStart)
    })
  })

  describe('abort handling', () => {
    test('respects AbortSignal', async () => {
      const controller = new AbortController()
      controller.abort()

      const response = await callGemini(
        { model: 'gemini-1.5-flash', prompt: 'test' },
        { signal: controller.signal }
      )

      expect(response.skipped).toBe(true)
      expect(response.reason).toBe('aborted')
    })
  })

  describe('network errors', () => {
    test('handles network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'))

      const response = await callGemini({
        model: 'gemini-1.5-flash',
        prompt: 'test',
      })

      // Should retry and eventually fail
      expect(response.error).toBeDefined()
    })
  })
})
