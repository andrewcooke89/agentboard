/**
 * geminiClient.ts -- Gemini API client with exponential backoff and graceful degradation
 *
 * Phase 22: Enables Gemini API calls from pipeline steps via the `gemini_offload` step type.
 *
 * Features:
 * - Exponential backoff with jitter on 429/500/503 errors
 * - Max 3 retries
 * - Rate limit tracking: 60k tokens/minute budget (configurable)
 * - Graceful degradation: no API key -> skip (don't fail)
 */

import { GEMINI_API_KEY, GEMINI_RATE_LIMIT_TOKENS_PER_MINUTE } from './config'

// CRIT-001: Simple mutex for atomic rate limit state operations
class AsyncMutex {
  private locked = false
  private queue: Array<() => void> = []

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true
      return
    }
    return new Promise<void>(resolve => {
      this.queue.push(resolve)
    })
  }

  release(): void {
    const next = this.queue.shift()
    if (next) {
      next()
    } else {
      this.locked = false
    }
  }
}

const rateLimitMutex = new AsyncMutex()

// Allow API key override for testing
// _apiKeyOverrideActive tracks whether setApiKeyOverride has been called at all,
// so that setApiKeyOverride(undefined) means "no key" rather than "fall back to env config".
let _apiKeyOverride: string | undefined
let _apiKeyOverrideActive = false

/**
 * Set API key override (for testing).
 * Pass undefined to simulate a missing API key (disables env config fallback).
 * Pass a string to use that key instead of env config.
 */
export function setApiKeyOverride(key: string | undefined): void {
  _apiKeyOverride = key
  _apiKeyOverrideActive = true
}

/**
 * Get the effective API key (override or config).
 * If setApiKeyOverride was called, the override value is used exclusively
 * (even if it is undefined/empty), so tests can simulate a missing key
 * regardless of environment variables.
 */
function getApiKey(): string {
  if (_apiKeyOverrideActive) {
    return _apiKeyOverride ?? ''
  }
  return GEMINI_API_KEY
}

export interface GeminiRequest {
  model: string
  prompt: string
  maxTokens?: number
  temperature?: number
}

// P1-3: Per-step retry backoff configuration
export interface BackoffConfig {
  base_delay_seconds?: number
  multiplier?: number
  max_delay_seconds?: number
  jitter?: boolean // default true for backward compatibility
}

export interface GeminiResponse {
  skipped?: boolean
  reason?: string
  content?: string
  inputTokens?: number
  outputTokens?: number
  latencyMs?: number
  error?: string
}

interface GeminiAPIResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string
      }>
    }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
  error?: {
    code?: number
    message?: string
    status?: string
  }
}

// Rate limiting state
interface RateLimitState {
  tokensUsed: number
  windowStart: number // timestamp in ms
}

const rateLimitState: RateLimitState = {
  tokensUsed: 0,
  windowStart: Date.now(),
}

const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute

// Backoff configuration
const BACKOFF_BASE_MS = 2000 // 2 seconds
const BACKOFF_MULTIPLIER = 2
const BACKOFF_MAX_MS = 60000 // 60 seconds
const BACKOFF_JITTER = 0.25 // +/- 25%
const MAX_RETRIES = 3

// Allow backoff delay override for testing
let _backoffDelayOverride: number | undefined

/**
 * Set backoff delay override for testing (milliseconds)
 * Set to 0 to disable delays, or a specific value
 */
export function setBackoffDelayOverride(ms: number | undefined): void {
  _backoffDelayOverride = ms
}

/**
 * Check and update rate limit. Returns true if within budget, false if exceeded.
 * CRIT-001: Uses mutex to ensure atomic state operations.
 */
async function checkRateLimit(tokensNeeded: number): Promise<boolean> {
  await rateLimitMutex.acquire()
  try {
    const now = Date.now()

    // Reset window if expired (atomic with state update)
    if (now - rateLimitState.windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateLimitState.tokensUsed = 0
      rateLimitState.windowStart = now
    }

    if (rateLimitState.tokensUsed + tokensNeeded > GEMINI_RATE_LIMIT_TOKENS_PER_MINUTE) {
      return false
    }

    rateLimitState.tokensUsed += tokensNeeded
    return true
  } finally {
    rateLimitMutex.release()
  }
}

/**
 * Calculate backoff delay with jitter
 * P1-3: Now supports custom backoff config from step definition
 * MEDIUM #3: jitter can be disabled via config.jitter = false
 */
function calculateBackoff(attempt: number, config?: BackoffConfig): number {
  const baseMs = (config?.base_delay_seconds ?? BACKOFF_BASE_MS / 1000) * 1000
  const multiplier = config?.multiplier ?? BACKOFF_MULTIPLIER
  const maxMs = (config?.max_delay_seconds ?? BACKOFF_MAX_MS / 1000) * 1000
  // MEDIUM #3: Default jitter to true for backward compatibility
  const useJitter = config?.jitter !== false

  const baseDelay = Math.min(
    baseMs * Math.pow(multiplier, attempt),
    maxMs
  )
  // Apply +/- 25% jitter only if enabled (default true)
  if (useJitter) {
    const jitter = baseDelay * BACKOFF_JITTER * (Math.random() * 2 - 1)
    return Math.floor(baseDelay + jitter)
  }
  return Math.floor(baseDelay)
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Check if error is retryable (429, 500, 503)
 */
function isRetryableError(status: number): boolean {
  return status === 429 || status === 500 || status === 503
}

/**
 * Call the Gemini API with retry logic and graceful degradation.
 *
 * @param req - The Gemini request parameters
 * @param opts - Optional settings including AbortSignal, retry flag, and backoff config
 * @returns GeminiResponse with content or skip/error information
 *
 * MED-012: AbortSignal behavior - abort is only checked between retries, not mid-request.
 * If you need immediate cancellation, the underlying fetch will respect the signal,
 * but retry logic only checks abort before each attempt.
 */
export async function callGemini(
  req: GeminiRequest,
  opts?: { signal?: AbortSignal; retry?: boolean; backoff?: BackoffConfig }
): Promise<GeminiResponse> {
  const apiKey = getApiKey()

  // Graceful degradation: no API key -> skip
  if (!apiKey) {
    return {
      skipped: true,
      reason: 'no_api_key',
    }
  }

  const { signal, retry = true, backoff } = opts ?? {}

  // Estimate tokens for rate limiting (rough: 1 token ~= 4 chars)
  const estimatedTokens = Math.ceil(req.prompt.length / 4) + (req.maxTokens ?? 1024)

  // Check rate limit before making request (CRIT-001: now async)
  if (!(await checkRateLimit(estimatedTokens))) {
    return {
      skipped: true,
      reason: 'rate_limit_exceeded',
    }
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${req.model}:generateContent?key=${apiKey}`

  const requestBody = {
    contents: [
      {
        parts: [{ text: req.prompt }],
      },
    ],
    generationConfig: {
      maxOutputTokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0.7,
    },
  }

  let lastError: string | undefined

  for (let attempt = 0; attempt <= (retry ? MAX_RETRIES : 0); attempt++) {
    // Check for abort signal
    if (signal?.aborted) {
      return {
        skipped: true,
        reason: 'aborted',
      }
    }

    // Apply backoff delay for retry attempts
    if (attempt > 0) {
      const delay = _backoffDelayOverride ?? calculateBackoff(attempt - 1, backoff)
      await sleep(delay)
    }

    const startTime = Date.now()

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal,
      })

      const latencyMs = Date.now() - startTime

      // Handle retryable errors
      if (isRetryableError(response.status)) {
        lastError = `HTTP ${response.status}: ${response.statusText}`
        continue // Retry
      }

      // Handle non-retryable errors
      if (!response.ok) {
        const errorBody = await response.text()
        return {
          error: `HTTP ${response.status}: ${errorBody}`,
          latencyMs,
        }
      }

      const data: GeminiAPIResponse = await response.json()

      // Check for API-level errors
      if (data.error) {
        return {
          error: `API Error ${data.error.code}: ${data.error.message}`,
          latencyMs,
        }
      }

      // Extract content from response
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text
      if (content === undefined) {
        return {
          error: 'No content in response',
          latencyMs,
        }
      }

      return {
        content,
        inputTokens: data.usageMetadata?.promptTokenCount,
        outputTokens: data.usageMetadata?.candidatesTokenCount,
        latencyMs,
      }
    } catch (err) {
      // Handle abort
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          skipped: true,
          reason: 'aborted',
        }
      }

      // Network errors - retry
      lastError = err instanceof Error ? err.message : String(err)

      // Don't retry on the last attempt
      if (attempt === MAX_RETRIES || !retry) {
        return {
          error: lastError,
          latencyMs: Date.now() - startTime,
        }
      }
    }
  }

  // All retries exhausted
  return {
    error: `Max retries exceeded. Last error: ${lastError}`,
  }
}

/**
 * Reset rate limit state (useful for testing)
 * CRIT-001: Uses mutex for atomic reset
 */
export async function resetRateLimitState(): Promise<void> {
  await rateLimitMutex.acquire()
  try {
    rateLimitState.tokensUsed = 0
    rateLimitState.windowStart = Date.now()
  } finally {
    rateLimitMutex.release()
  }
}

/**
 * Get current rate limit state (useful for telemetry)
 */
export function getRateLimitState(): { tokensUsed: number; windowStart: number; budget: number } {
  return {
    tokensUsed: rateLimitState.tokensUsed,
    windowStart: rateLimitState.windowStart,
    budget: GEMINI_RATE_LIMIT_TOKENS_PER_MINUTE,
  }
}
