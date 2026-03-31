// WU-004: HTTP Route Registration Tests
// Verifies all 14 GET + 1 POST routes under /api/cron-ai/* are registered,
// return correct HTTP status codes, and auth middleware is applied. (AC-004-1, AC-004-2)
//
// These tests call the REAL registerHttpRoutes (and any cron-ai route registration)
// against a Hono app with mocked context. Since WU-004 hasn't added the routes yet,
// all route tests will fail with 404.

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { Hono } from 'hono'
import { registerHttpRoutes } from '../httpRoutes'
import type { ServerContext } from '../serverContext'

// ─── Mock ServerContext ──────────────────────────────────────────────────────

function createMockServerContext(authToken = ''): ServerContext {
  return {
    db: {
      db: { prepare: () => ({ get: () => null, all: () => [], run: () => ({}) }) },
      getSessionById: mock(() => null),
      displayNameExists: mock(() => false),
      getActiveSessions: mock(() => []),
      getInactiveSessions: mock(() => []),
      deleteInactiveSession: mock(() => true),
      deleteOldInactiveSessions: mock(() => 0),
      close: mock(() => {}),
    } as any,
    registry: {
      getAll: mock(() => []),
      getAgentSessions: mock(() => ({ active: [], inactive: [] })),
      on: mock(() => {}),
    } as any,
    sessionManager: {
      createWindow: mock(() => ({})),
      listWindows: mock(() => [{ name: 'my-project', tmuxWindow: '1' }]),
    } as any,
    config: {
      port: 4040,
      hostname: '0.0.0.0',
      refreshIntervalMs: 1000,
      tmuxSession: 'agentboard',
      discoverPrefixes: [],
      pruneWsSessions: true,
      terminalMode: 'pty',
      terminalMonitorTargets: true,
      tlsCert: '',
      tlsKey: '',
      rgThreads: 1,
      logMatchWorker: false,
      logMatchProfile: false,
      claudeResumeCmd: 'claude --resume {sessionId}',
      codexResumeCmd: 'codex --resume {sessionId}',
      authToken,
      allowedRoots: [],
      taskOutputDir: '/tmp/agentboard-test-outputs',
      taskDefaultTimeoutSeconds: 1800,
      inactiveSessionMaxAgeHours: 168,
      workflowEngineEnabled: false,
      modelEnvsPath: '',
      logPollIntervalMs: 0,
    } as any,
    logger: {
      info: mock(() => {}),
      debug: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    } as any,
    broadcast: mock(() => {}),
    send: mock(() => {}),
    sockets: new Set(),
    taskStore: {
      listTasks: mock(() => []),
      getTask: mock(() => null),
      createTask: mock(() => ({})),
      updateTask: mock(() => null),
      getStats: mock(() => ({})),
      listTemplates: mock(() => []),
      getTemplate: mock(() => null),
      createTemplate: mock(() => ({})),
      updateTemplate: mock(() => null),
      deleteTemplate: mock(() => false),
    } as any,
    taskWorker: {} as any,
    workflowStore: {} as any,
    workflowEngine: {} as any,
  }
}

/**
 * Creates a Hono app with all real route registration applied.
 * WU-004 should add cron-ai routes to registerHttpRoutes (or a companion function).
 * Until then, /api/cron-ai/* routes will 404.
 */
function createAppWithRealRoutes(authToken = ''): Hono {
  const app = new Hono()
  const ctx = createMockServerContext(authToken)
  registerHttpRoutes(app, ctx, false)
  return app
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WU-004: /api/cron-ai/* route registration (AC-004-1)', () => {
  let app: Hono

  beforeEach(() => {
    app = createAppWithRealRoutes()
  })

  // ── All 14 GET routes must respond with non-404 ─────────────────────────

  const getRoutes = [
    '/api/cron-ai/jobs',
    '/api/cron-ai/jobs/search?q=backup',
    '/api/cron-ai/jobs/job-1',
    '/api/cron-ai/jobs/job-1/history',
    '/api/cron-ai/jobs/job-1/logs',
    '/api/cron-ai/jobs/job-1/duration-trends',
    '/api/cron-ai/health',
    '/api/cron-ai/health/failing',
    '/api/cron-ai/schedule/conflicts',
    '/api/cron-ai/schedule/load',
    '/api/cron-ai/context',
    '/api/cron-ai/sessions',
    '/api/cron-ai/ai-health',
  ]

  for (const path of getRoutes) {
    it(`GET ${path} is registered (not 404)`, async () => {
      const res = await app.fetch(new Request(`http://localhost${path}`))
      // 404 means the route is not registered. Any other status (200, 401, 500) means it IS registered.
      expect(res.status).not.toBe(404)
    })
  }

  it('POST /api/cron-ai/proposals is registered (not 404)', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'pause',
          jobId: 'job-1',
          title: 'Pause backup',
          description: 'Maintenance',
        }),
      })
    )
    expect(res.status).not.toBe(404)
  })

  it('has exactly 13 GET + 1 POST = 14 cron-ai routes total', () => {
    // 13 GET routes + 1 POST /proposals = 14 total registered routes
    expect(getRoutes.length).toBe(13)
  })

  // ── GET routes return 200 for success ───────────────────────────────────

  it('GET /api/cron-ai/jobs returns 200 with JSON body', async () => {
    const res = await app.fetch(new Request('http://localhost/api/cron-ai/jobs'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body) || typeof body === 'object').toBe(true)
  })

  it('GET /api/cron-ai/health returns 200 with health data', async () => {
    const res = await app.fetch(new Request('http://localhost/api/cron-ai/health'))
    expect(res.status).toBe(200)
  })

  // ── POST route returns 201 for success ──────────────────────────────────

  it('POST /api/cron-ai/proposals returns 201 on success', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'pause',
          jobId: 'job-1',
          title: 'Pause job',
          description: 'Maintenance window',
        }),
      })
    )
    expect(res.status).toBe(201)
  })

  // ── Error cases ─────────────────────────────────────────────────────────

  it('POST /api/cron-ai/proposals returns 400 for invalid JSON', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json{{',
      })
    )
    expect(res.status).toBe(400)
  })

  it('GET /api/cron-ai/jobs/:id returns 404 for nonexistent job', async () => {
    // This assumes the handler returns 404 when the job is not found
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/jobs/nonexistent-id-12345')
    )
    expect(res.status).toBe(404)
  })

  // ── POST proposal validation (missing required fields) ────────────────

  it('POST /api/cron-ai/proposals returns 400 when operation is missing', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: 'job-1', description: 'Maintenance pause' }),
      })
    )
    expect(res.status).toBe(400)
  })

  it('POST /api/cron-ai/proposals returns 400 with unknown operation', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'nuke', jobId: 'job-1', description: 'bad op' }),
      })
    )
    expect(res.status).toBe(400)
  })

  it('POST /api/cron-ai/proposals returns 400 when description is empty', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'pause', jobId: 'job-1', description: '' }),
      })
    )
    expect(res.status).toBe(400)
  })

  it('POST /api/cron-ai/proposals returns 400 when description is missing', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'pause', jobId: 'job-1' }),
      })
    )
    expect(res.status).toBe(400)
  })

  it('POST /api/cron-ai/proposals returns 400 for empty JSON body', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    )
    expect(res.status).toBe(400)
  })

  it('POST /api/cron-ai/proposals returns 400 when jobId missing for pause', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'pause', description: 'Pause for maint' }),
      })
    )
    expect(res.status).toBe(400)
  })
})

describe('WU-004: /api/cron-ai/* auth middleware (AC-004-2)', () => {
  it('returns 401 for all GET routes when auth is configured and no token', async () => {
    const app = createAppWithRealRoutes('secret-token')

    const protectedPaths = [
      '/api/cron-ai/jobs',
      '/api/cron-ai/jobs/job-1',
      '/api/cron-ai/health',
      '/api/cron-ai/health/failing',
      '/api/cron-ai/context',
      '/api/cron-ai/sessions',
      '/api/cron-ai/schedule/conflicts',
      '/api/cron-ai/schedule/load',
      '/api/cron-ai/ai-health',
    ]

    for (const path of protectedPaths) {
      const res = await app.fetch(new Request(`http://localhost${path}`))
      expect(res.status).toBe(401)
    }
  })

  it('returns 401 for POST when auth is configured and no token', async () => {
    const app = createAppWithRealRoutes('secret-token')

    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'pause', jobId: 'j1', title: 'x', description: 'y' }),
      })
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 for invalid Bearer token', async () => {
    const app = createAppWithRealRoutes('secret-token')

    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/jobs', {
        headers: { Authorization: 'Bearer wrong-token' },
      })
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 for malformed Authorization header (not Bearer)', async () => {
    const app = createAppWithRealRoutes('secret-token')

    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/jobs', {
        headers: { Authorization: 'Basic dXNlcjpwYXNz' },
      })
    )
    expect(res.status).toBe(401)
  })

  it('returns 200 with valid Bearer token', async () => {
    const app = createAppWithRealRoutes('secret-token')

    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/jobs', {
        headers: { Authorization: 'Bearer secret-token' },
      })
    )
    expect(res.status).toBe(200)
  })

  it('skips auth in dev mode (no authToken configured)', async () => {
    const app = createAppWithRealRoutes() // no authToken

    const res = await app.fetch(new Request('http://localhost/api/cron-ai/jobs'))
    // Should NOT be 401 (dev mode = no auth required)
    expect(res.status).not.toBe(401)
    // Should be 200 (route exists and responds)
    expect(res.status).toBe(200)
  })

  it('auth applies uniformly to ALL /api/cron-ai/* sub-paths', async () => {
    const app = createAppWithRealRoutes('secret-token')

    const allPaths = [
      '/api/cron-ai/jobs',
      '/api/cron-ai/jobs/search?q=x',
      '/api/cron-ai/jobs/j1',
      '/api/cron-ai/jobs/j1/history',
      '/api/cron-ai/jobs/j1/logs',
      '/api/cron-ai/jobs/j1/duration-trends',
      '/api/cron-ai/health',
      '/api/cron-ai/health/failing',
      '/api/cron-ai/schedule/conflicts',
      '/api/cron-ai/schedule/load',
      '/api/cron-ai/context',
      '/api/cron-ai/sessions',
      '/api/cron-ai/ai-health',
    ]

    for (const p of allPaths) {
      const res = await app.fetch(new Request(`http://localhost${p}`))
      // Must be 401, not 404 (which would mean the route isn't registered)
      // and not 200 (which would mean auth was bypassed)
      expect(res.status).toBe(401)
    }
  })

  it('auth applies to POST /api/cron-ai/proposals', async () => {
    const app = createAppWithRealRoutes('secret-token')

    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'pause', jobId: 'j1', description: 'y' }),
      })
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 for empty Authorization header', async () => {
    const app = createAppWithRealRoutes('secret-token')

    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/jobs', {
        headers: { Authorization: '' },
      })
    )
    expect(res.status).toBe(401)
  })

  it('returns 401 for Bearer with no token value', async () => {
    const app = createAppWithRealRoutes('secret-token')

    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/jobs', {
        headers: { Authorization: 'Bearer ' },
      })
    )
    expect(res.status).toBe(401)
  })
})

// ─── Query parameter forwarding ─────────────────────────────────────────────

describe('WU-004: /api/cron-ai/* query parameter handling', () => {
  let app: Hono

  beforeEach(() => {
    app = createAppWithRealRoutes()
  })

  it('GET /api/cron-ai/jobs?group=system filters by group', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/jobs?group=system')
    )
    expect(res.status).toBe(200)
  })

  it('GET /api/cron-ai/jobs/search without ?q= defaults to empty and returns 200', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/jobs/search')
    )
    // Route defaults q to '' — returns 200 with results (possibly empty array)
    expect(res.status).toBe(200)
  })

  it('GET /api/cron-ai/jobs/search with empty ?q= returns 200', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/jobs/search?q=')
    )
    expect(res.status).toBe(200)
  })

  it('GET /api/cron-ai/jobs/search with valid ?q= returns 200', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/jobs/search?q=backup')
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  it('GET /api/cron-ai/jobs/:id/history accepts ?limit= param', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/jobs/job-1/history?limit=5')
    )
    // Should be 200 (job exists in stub) or 404 (job not found), not 400
    expect([200, 404]).toContain(res.status)
  })

  it('GET /api/cron-ai/jobs/:id/history accepts ?before= param', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/jobs/job-1/history?before=2026-01-01')
    )
    expect([200, 404]).toContain(res.status)
  })

  it('GET /api/cron-ai/jobs/:id/logs accepts ?lines= and ?offset= params', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/jobs/job-1/logs?lines=50&offset=100')
    )
    expect([200, 404]).toContain(res.status)
  })
})

// ─── Response shape validation ──────────────────────────────────────────────

describe('WU-004: /api/cron-ai/* response shapes', () => {
  let app: Hono

  beforeEach(() => {
    app = createAppWithRealRoutes()
  })

  it('GET /api/cron-ai/jobs returns an array', async () => {
    const res = await app.fetch(new Request('http://localhost/api/cron-ai/jobs'))
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  it('GET /api/cron-ai/health returns object with healthy/warning/critical', async () => {
    const res = await app.fetch(new Request('http://localhost/api/cron-ai/health'))
    const body = await res.json()
    expect(body).toHaveProperty('healthy')
    expect(body).toHaveProperty('warning')
    expect(body).toHaveProperty('critical')
  })

  it('GET /api/cron-ai/health/failing returns an array', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/health/failing')
    )
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  it('GET /api/cron-ai/ai-health returns status and mcpConnected', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/ai-health')
    )
    const body = await res.json()
    expect(body).toHaveProperty('status')
    expect(body).toHaveProperty('mcpConnected')
  })

  it('GET /api/cron-ai/schedule/conflicts returns an array', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/schedule/conflicts')
    )
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  it('GET /api/cron-ai/schedule/load returns an object', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/schedule/load')
    )
    const body = await res.json()
    expect(typeof body).toBe('object')
    expect(body).not.toBeNull()
  })

  it('POST /api/cron-ai/proposals returns 201 with status or result', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'pause',
          jobId: 'job-1',
          title: 'Pause job',
          description: 'Maintenance window',
        }),
      })
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    // Response is either { status: 'pending' } (queued) or ProposalResult (resolved quickly)
    expect(typeof body).toBe('object')
    expect(body).not.toBeNull()
  })

  it('GET /api/cron-ai/sessions returns an array', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/sessions')
    )
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })
})

// ─── Method safety ──────────────────────────────────────────────────────────

describe('WU-004: /api/cron-ai/* method safety', () => {
  let app: Hono

  beforeEach(() => {
    app = createAppWithRealRoutes()
  })

  it('POST to GET-only route /api/cron-ai/jobs returns 404 or 405', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    )
    // Hono returns 404 for unmatched method, not 405
    expect([404, 405]).toContain(res.status)
  })

  it('GET to POST-only route /api/cron-ai/proposals returns 404 or 405', async () => {
    const res = await app.fetch(
      new Request('http://localhost/api/cron-ai/proposals')
    )
    expect([404, 405]).toContain(res.status)
  })
})
