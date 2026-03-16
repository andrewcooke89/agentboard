// healthEndpoint.test.ts - Tests for /api/health endpoint
import { describe, test, expect, beforeAll } from 'bun:test'
import { Hono } from 'hono'
import { registerHttpRoutes } from '../httpRoutes'
import type { ServerContext } from '../serverContext'
import type { HealthResponse } from '../../shared/types'

describe('GET /api/health', () => {
  let app: Hono

  beforeAll(() => {
    app = new Hono()
    // Minimal mock context - health endpoint only uses config.authToken
    const ctx = {
      config: { authToken: null },
    } as unknown as ServerContext
    registerHttpRoutes(app, ctx, false, undefined, undefined)
  })

  test('returns status ok', async () => {
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)

    const body = (await res.json()) as HealthResponse
    expect(body.status).toBe('ok')
  })

  test('returns uptime as number', async () => {
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)

    const body = (await res.json()) as HealthResponse
    expect(typeof body.uptime).toBe('number')
    expect(body.uptime).toBeGreaterThanOrEqual(0)
  })

  test('returns timestamp as ISO 8601 string', async () => {
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)

    const body = (await res.json()) as HealthResponse
    expect(typeof body.timestamp).toBe('string')
    // ISO 8601 format check
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    // Should be parseable as a date
    expect(() => new Date(body.timestamp)).not.toThrow()
  })

  test('returns tmux as boolean', async () => {
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)

    const body = (await res.json()) as HealthResponse
    expect(typeof body.tmux).toBe('boolean')
  })

  test('matches HealthResponse interface', async () => {
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)

    const body = (await res.json()) as HealthResponse

    // Verify all required fields are present
    expect(body).toHaveProperty('status')
    expect(body).toHaveProperty('uptime')
    expect(body).toHaveProperty('timestamp')
    expect(body).toHaveProperty('tmux')

    // Verify types
    expect(body.status).toBe('ok')
    expect(typeof body.uptime).toBe('number')
    expect(typeof body.timestamp).toBe('string')
    expect(typeof body.tmux).toBe('boolean')
  })
})
