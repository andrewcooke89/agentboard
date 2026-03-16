// WU-005: MCP Server Core & Read Tools — Unit Tests
// Tests fetchFromAgentboard HTTP client, 7 read tools, auth headers, retry logic,
// structured error handling, and MCP tool registration.

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import type { CronJob, CronJobDetail, JobRunRecord } from '@shared/types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCronJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'job-1',
    name: 'test-backup',
    source: 'user-crontab',
    schedule: '0 * * * *',
    scheduleHuman: 'Every hour',
    command: '/usr/bin/backup.sh',
    scriptPath: '/usr/bin/backup.sh',
    projectGroup: 'default',
    status: 'active',
    health: 'healthy',
    healthReason: null,
    lastRun: '2026-02-25T10:00:00Z',
    lastRunDuration: 45,
    nextRun: '2026-02-25T11:00:00Z',
    lastExitCode: 0,
    consecutiveFailures: 0,
    avgDuration: 42,
    user: 'andrew',
    requiresSudo: false,
    avatarUrl: null,
    unitFile: null,
    description: 'Hourly backup',
    tags: ['backup'],
    isManagedByAgentboard: false,
    linkedSessionId: null,
    ...overrides,
  }
}

function makeJobDetail(overrides: Partial<CronJobDetail> = {}): CronJobDetail {
  return {
    ...makeCronJob(),
    scriptContent: '#!/bin/bash\necho backup',
    scriptLanguage: 'bash',
    timerConfig: null,
    serviceConfig: null,
    crontabLine: '0 * * * * /usr/bin/backup.sh',
    runHistory: [],
    recentLogs: [],
    ...overrides,
  }
}

function makeRunRecord(overrides: Partial<JobRunRecord> = {}): JobRunRecord {
  return {
    timestamp: '2026-02-25T10:00:00Z',
    endTimestamp: '2026-02-25T10:00:45Z',
    duration: 45,
    exitCode: 0,
    trigger: 'scheduled',
    logSnippet: 'backup complete',
    ...overrides,
  }
}

// ─── Mock Setup ───────────────────────────────────────────────────────────────

// We intercept global fetch to simulate agentboard HTTP responses.
// Each test sets up its own fetch mock via mockFetchResponses().

const originalFetch = globalThis.fetch
let fetchCallLog: Array<{ url: string; init?: RequestInit }> = []

function mockFetchResponses(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  fetchCallLog = []
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    fetchCallLog.push({ url, init })
    return handler(url, init)
  }) as unknown as typeof fetch
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ─── Module Import ────────────────────────────────────────────────────────────

// We import the functions under test. In the real implementation these will
// use global fetch to talk to agentboard.
import {
  fetchFromAgentboard,
  createMcpServer,
  getRegisteredToolNames,
  listJobs,
  listJobsByGroup,
  searchJobs,
  getJobDetail,
  getRunHistory,
  getJobLogs,
  getLogSnippet,
} from '../cronMcpServer'

// ─── Test Suites ──────────────────────────────────────────────────────────────

describe('WU-005: MCP Server Core & Read Tools', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    fetchCallLog = []
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-005-1: MCP server starts on stdio transport and responds to handshake
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-005-1: MCP server startup', () => {
    it('createMcpServer returns without throwing', async () => {
      // The MCP server should initialize and be ready to serve.
      // We test that createMcpServer() resolves (does not reject).
      const result = createMcpServer()
      await expect(result).resolves.toBeUndefined()
    })

    it('createMcpServer registers tools that are discoverable', async () => {
      // After creation, the server should have tools registered and discoverable.
      await createMcpServer()
      const toolNames = getRegisteredToolNames()
      expect(toolNames.length).toBeGreaterThanOrEqual(7)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-005-2: 7 read tools registered with correct JSON schemas
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-005-2: MCP tool registration', () => {
    it('registers exactly 7 read tools with correct MCP names', async () => {
      // createMcpServer should return a server with tools registered.
      // We import the tool definitions to verify names match the spec.
      const expectedToolNames = [
        'list_jobs',
        'list_jobs_by_group',
        'search_jobs',
        'get_job_detail',
        'get_run_history',
        'get_job_logs',
        'get_log_snippet',
      ]

      // The implementation should expose registered tool names for verification
      const { getRegisteredToolNames } = await import('../cronMcpServer')
      const toolNames = getRegisteredToolNames()
      for (const name of expectedToolNames) {
        expect(toolNames).toContain(name)
      }
    })

    it('list_jobs_by_group schema requires group as string', async () => {
      const { getToolSchema } = await import('../cronMcpServer')
      const schema = getToolSchema('list_jobs_by_group')
      expect(schema).toBeDefined()
      expect(schema.properties).toHaveProperty('group')
      expect(schema.properties.group.type).toBe('string')
      expect(schema.required).toContain('group')
    })

    it('search_jobs schema requires query as string', async () => {
      const { getToolSchema } = await import('../cronMcpServer')
      const schema = getToolSchema('search_jobs')
      expect(schema).toBeDefined()
      expect(schema.properties).toHaveProperty('query')
      expect(schema.properties.query.type).toBe('string')
      expect(schema.required).toContain('query')
    })

    it('get_job_detail schema requires jobId as string', async () => {
      const { getToolSchema } = await import('../cronMcpServer')
      const schema = getToolSchema('get_job_detail')
      expect(schema).toBeDefined()
      expect(schema.properties).toHaveProperty('jobId')
      expect(schema.properties.jobId.type).toBe('string')
      expect(schema.required).toContain('jobId')
    })

    it('get_run_history schema requires jobId, has optional limit (number)', async () => {
      const { getToolSchema } = await import('../cronMcpServer')
      const schema = getToolSchema('get_run_history')
      expect(schema).toBeDefined()
      expect(schema.properties).toHaveProperty('jobId')
      expect(schema.required).toContain('jobId')
      expect(schema.properties).toHaveProperty('limit')
      expect(schema.properties.limit.type).toBe('number')
      // limit is optional — should NOT be in required
      expect(schema.required).not.toContain('limit')
    })

    it('get_job_logs schema requires jobId, has optional lines (number)', async () => {
      const { getToolSchema } = await import('../cronMcpServer')
      const schema = getToolSchema('get_job_logs')
      expect(schema).toBeDefined()
      expect(schema.properties).toHaveProperty('jobId')
      expect(schema.required).toContain('jobId')
      expect(schema.properties).toHaveProperty('lines')
      expect(schema.properties.lines.type).toBe('number')
      expect(schema.required).not.toContain('lines')
    })

    it('get_log_snippet schema requires jobId and runTimestamp as strings', async () => {
      const { getToolSchema } = await import('../cronMcpServer')
      const schema = getToolSchema('get_log_snippet')
      expect(schema).toBeDefined()
      expect(schema.properties).toHaveProperty('jobId')
      expect(schema.properties).toHaveProperty('runTimestamp')
      expect(schema.properties.jobId.type).toBe('string')
      expect(schema.properties.runTimestamp.type).toBe('string')
      expect(schema.required).toContain('jobId')
      expect(schema.required).toContain('runTimestamp')
    })

    it('list_jobs schema has no required parameters', async () => {
      const { getToolSchema } = await import('../cronMcpServer')
      const schema = getToolSchema('list_jobs')
      expect(schema).toBeDefined()
      // list_jobs takes no arguments — required should be empty or absent
      expect(!schema.required || schema.required.length === 0).toBe(true)
    })
  })

  describe('AC-005-2: Read tool signatures', () => {
    it('listJobs accepts no arguments', async () => {
      const jobs = [makeCronJob()]
      mockFetchResponses(() => jsonResponse(jobs))
      // listJobs() should work with zero arguments
      const result = await listJobs()
      expect(result).toEqual(jobs)
    })

    it('listJobsByGroup requires a group string parameter', async () => {
      mockFetchResponses(() => jsonResponse([]))
      // Must accept a string argument
      const result = await listJobsByGroup('backups')
      expect(Array.isArray(result)).toBe(true)
    })

    it('searchJobs requires a query string parameter', async () => {
      mockFetchResponses(() => jsonResponse([]))
      const result = await searchJobs('backup')
      expect(Array.isArray(result)).toBe(true)
    })

    it('getJobDetail requires a jobId string parameter', async () => {
      const detail = makeJobDetail()
      mockFetchResponses(() => jsonResponse(detail))
      const result = await getJobDetail('job-1')
      expect(result).toHaveProperty('id')
    })

    it('getRunHistory requires jobId, accepts optional limit', async () => {
      mockFetchResponses(() => jsonResponse([]))
      // With limit
      const r1 = await getRunHistory('job-1', 10)
      expect(Array.isArray(r1)).toBe(true)
      // Without limit
      const r2 = await getRunHistory('job-1')
      expect(Array.isArray(r2)).toBe(true)
    })

    it('getJobLogs requires jobId, accepts optional lines', async () => {
      mockFetchResponses(() => jsonResponse(['line1', 'line2']))
      const r1 = await getJobLogs('job-1', 100)
      expect(Array.isArray(r1)).toBe(true)
      const r2 = await getJobLogs('job-1')
      expect(Array.isArray(r2)).toBe(true)
    })

    it('getLogSnippet requires jobId and runTimestamp', async () => {
      mockFetchResponses(() => jsonResponse(['snippet line']))
      const result = await getLogSnippet('job-1', '2026-02-25T10:00:00Z')
      expect(Array.isArray(result)).toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-005-3: Each tool calls correct HTTP endpoint with correct query params
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-005-3: Correct HTTP endpoints', () => {
    it('listJobs calls GET /api/cron-ai/jobs', async () => {
      mockFetchResponses(() => jsonResponse([]))
      await listJobs()

      expect(fetchCallLog.length).toBeGreaterThanOrEqual(1)
      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/jobs')
      // Should NOT have query params for the plain list
      expect(lastCall.url).not.toContain('?')
      expect(lastCall.init?.method ?? 'GET').toBe('GET')
    })

    it('listJobsByGroup calls GET /api/cron-ai/jobs?group=backups', async () => {
      mockFetchResponses(() => jsonResponse([]))
      await listJobsByGroup('backups')

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/jobs')
      expect(lastCall.url).toContain('group=backups')
    })

    it('searchJobs calls GET /api/cron-ai/jobs/search?q=backup', async () => {
      mockFetchResponses(() => jsonResponse([]))
      await searchJobs('backup')

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/jobs/search')
      expect(lastCall.url).toContain('q=backup')
    })

    it('searchJobs URL-encodes special characters in query', async () => {
      mockFetchResponses(() => jsonResponse([]))
      await searchJobs('my backup & restore')

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/jobs/search')
      // Should be URL-encoded, not contain raw '&'
      expect(lastCall.url).not.toMatch(/q=my backup & restore/)
      expect(lastCall.url).toContain('q=')
    })

    it('listJobsByGroup URL-encodes group names with spaces', async () => {
      mockFetchResponses(() => jsonResponse([]))
      await listJobsByGroup('my backups')

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/jobs')
      // Should not contain raw space in the URL
      expect(lastCall.url).not.toMatch(/group=my backups/)
      expect(lastCall.url).toContain('group=')
    })

    it('getJobDetail calls GET /api/cron-ai/jobs/:id', async () => {
      mockFetchResponses(() => jsonResponse(makeJobDetail()))
      await getJobDetail('job-42')

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/jobs/job-42')
      // Should NOT contain /history or /logs
      expect(lastCall.url).not.toContain('/history')
      expect(lastCall.url).not.toContain('/logs')
    })

    it('getRunHistory calls GET /api/cron-ai/jobs/:id/history with limit', async () => {
      mockFetchResponses(() => jsonResponse([]))
      await getRunHistory('job-7', 25)

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/jobs/job-7/history')
      expect(lastCall.url).toContain('limit=25')
    })

    it('getRunHistory omits limit param when not provided', async () => {
      mockFetchResponses(() => jsonResponse([]))
      await getRunHistory('job-7')

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/jobs/job-7/history')
      expect(lastCall.url).not.toContain('limit=')
    })

    it('getJobLogs calls GET /api/cron-ai/jobs/:id/logs with lines', async () => {
      mockFetchResponses(() => jsonResponse([]))
      await getJobLogs('job-3', 100)

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/jobs/job-3/logs')
      expect(lastCall.url).toContain('lines=100')
    })

    it('getJobLogs omits lines param when not provided', async () => {
      mockFetchResponses(() => jsonResponse([]))
      await getJobLogs('job-3')

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/jobs/job-3/logs')
      expect(lastCall.url).not.toContain('lines=')
    })

    it('getLogSnippet calls GET /api/cron-ai/jobs/:id/logs?run=:ts', async () => {
      mockFetchResponses(() => jsonResponse([]))
      await getLogSnippet('job-5', '2026-02-25T10:00:00Z')

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/jobs/job-5/logs')
      expect(lastCall.url).toContain('run=')
      expect(lastCall.url).toContain('2026-02-25')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-005-4: Auth header when AGENTBOARD_AUTH_TOKEN is set
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-005-4: Authorization header', () => {
    it('includes Authorization: Bearer header when token is set', async () => {
      // Set the env var before calling
      const origToken = process.env.AGENTBOARD_AUTH_TOKEN
      process.env.AGENTBOARD_AUTH_TOKEN = 'test-secret-token'

      mockFetchResponses(() => jsonResponse([]))

      try {
        await fetchFromAgentboard('/api/cron-ai/jobs')

        expect(fetchCallLog.length).toBeGreaterThanOrEqual(1)
        const lastCall = fetchCallLog[fetchCallLog.length - 1]
        const authHeader =
          lastCall.init?.headers instanceof Headers
            ? lastCall.init.headers.get('Authorization')
            : (lastCall.init?.headers as Record<string, string>)?.['Authorization'] ??
              (lastCall.init?.headers as Record<string, string>)?.['authorization']
        expect(authHeader).toBe('Bearer test-secret-token')
      } finally {
        if (origToken !== undefined) {
          process.env.AGENTBOARD_AUTH_TOKEN = origToken
        } else {
          delete process.env.AGENTBOARD_AUTH_TOKEN
        }
      }
    })

    it('omits Authorization header when token is empty', async () => {
      const origToken = process.env.AGENTBOARD_AUTH_TOKEN
      process.env.AGENTBOARD_AUTH_TOKEN = ''

      mockFetchResponses(() => jsonResponse([]))

      try {
        await fetchFromAgentboard('/api/cron-ai/jobs')

        const lastCall = fetchCallLog[fetchCallLog.length - 1]
        const authHeader =
          lastCall.init?.headers instanceof Headers
            ? lastCall.init.headers.get('Authorization')
            : (lastCall.init?.headers as Record<string, string>)?.['Authorization']
        // Should be absent or empty when no token is configured
        expect(!authHeader || authHeader === '').toBe(true)
      } finally {
        if (origToken !== undefined) {
          process.env.AGENTBOARD_AUTH_TOKEN = origToken
        } else {
          delete process.env.AGENTBOARD_AUTH_TOKEN
        }
      }
    })

    it('omits Authorization header when env var is completely unset', async () => {
      const origToken = process.env.AGENTBOARD_AUTH_TOKEN
      delete process.env.AGENTBOARD_AUTH_TOKEN

      mockFetchResponses(() => jsonResponse([]))

      try {
        await fetchFromAgentboard('/api/cron-ai/jobs')

        const lastCall = fetchCallLog[fetchCallLog.length - 1]
        const authHeader =
          lastCall.init?.headers instanceof Headers
            ? lastCall.init.headers.get('Authorization')
            : (lastCall.init?.headers as Record<string, string>)?.['Authorization']
        expect(!authHeader || authHeader === '').toBe(true)
      } finally {
        if (origToken !== undefined) {
          process.env.AGENTBOARD_AUTH_TOKEN = origToken
        } else {
          delete process.env.AGENTBOARD_AUTH_TOKEN
        }
      }
    })

    it('read tools pass auth header through to HTTP client', async () => {
      const origToken = process.env.AGENTBOARD_AUTH_TOKEN
      process.env.AGENTBOARD_AUTH_TOKEN = 'tool-token'

      mockFetchResponses(() => jsonResponse([]))

      try {
        await listJobs()

        expect(fetchCallLog.length).toBeGreaterThanOrEqual(1)
        const lastCall = fetchCallLog[fetchCallLog.length - 1]
        const authHeader =
          lastCall.init?.headers instanceof Headers
            ? lastCall.init.headers.get('Authorization')
            : (lastCall.init?.headers as Record<string, string>)?.['Authorization'] ??
              (lastCall.init?.headers as Record<string, string>)?.['authorization']
        expect(authHeader).toBe('Bearer tool-token')
      } finally {
        if (origToken !== undefined) {
          process.env.AGENTBOARD_AUTH_TOKEN = origToken
        } else {
          delete process.env.AGENTBOARD_AUTH_TOKEN
        }
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-005-5: Structured error on agentboard unavailability (no crash)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-005-5: Graceful error handling', () => {
    it('fetchFromAgentboard returns structured error when fetch throws', async () => {
      mockFetchResponses(() => {
        throw new Error('ECONNREFUSED')
      })

      const result = await fetchFromAgentboard('/api/cron-ai/jobs')
      // Should NOT throw — returns structured error object
      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('unavailable')
    })

    it('listJobs returns structured error when server is down', async () => {
      mockFetchResponses(() => {
        throw new Error('ECONNREFUSED')
      })

      const result = await listJobs()
      expect(result).toHaveProperty('error')
      expect((result as unknown as { error: string }).error).toContain('unavailable')
    })

    it('searchJobs returns structured error when server is down', async () => {
      mockFetchResponses(() => {
        throw new Error('fetch failed')
      })

      const result = await searchJobs('anything')
      expect(result).toHaveProperty('error')
    })

    it('getJobDetail returns structured error when server is down', async () => {
      mockFetchResponses(() => {
        throw new Error('ECONNREFUSED')
      })

      const result = await getJobDetail('job-1')
      expect(result).toHaveProperty('error')
    })

    it('getRunHistory returns structured error when server is down', async () => {
      mockFetchResponses(() => {
        throw new Error('ECONNREFUSED')
      })

      const result = await getRunHistory('job-1')
      expect(result).toHaveProperty('error')
    })

    it('getJobLogs returns structured error when server is down', async () => {
      mockFetchResponses(() => {
        throw new Error('ECONNREFUSED')
      })

      const result = await getJobLogs('job-1')
      expect(result).toHaveProperty('error')
    })

    it('getLogSnippet returns structured error when server is down', async () => {
      mockFetchResponses(() => {
        throw new Error('ECONNREFUSED')
      })

      const result = await getLogSnippet('job-1', '2026-02-25T10:00:00Z')
      expect(result).toHaveProperty('error')
    })

    it('returns structured error on HTTP 500 response', async () => {
      mockFetchResponses(() => jsonResponse({ message: 'Internal Server Error' }, 500))

      const result = await fetchFromAgentboard('/api/cron-ai/jobs')
      expect(result).toHaveProperty('error')
    })

    it('returns structured error on HTTP 502 Bad Gateway', async () => {
      mockFetchResponses(() => new Response('Bad Gateway', { status: 502 }))

      const result = await fetchFromAgentboard('/api/cron-ai/jobs')
      expect(result).toHaveProperty('error')
    })

    it('tools never throw — they return error objects', async () => {
      mockFetchResponses(() => {
        throw new TypeError('Failed to fetch')
      })

      // None of these should throw
      const results = await Promise.allSettled([
        listJobs(),
        listJobsByGroup('g'),
        searchJobs('q'),
        getJobDetail('id'),
        getRunHistory('id'),
        getJobLogs('id'),
        getLogSnippet('id', 'ts'),
      ])

      for (const r of results) {
        expect(r.status).toBe('fulfilled')
        if (r.status === 'fulfilled') {
          expect(r.value).toHaveProperty('error')
        }
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-005-6: HTTP client retries 3 times before returning error
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-005-6: Retry logic', () => {
    it('retries exactly 3 times on network failure then returns error', async () => {
      let callCount = 0
      mockFetchResponses(() => {
        callCount++
        throw new Error('ECONNREFUSED')
      })

      const result = await fetchFromAgentboard('/api/cron-ai/jobs')

      expect(callCount).toBe(3)
      expect(result).toHaveProperty('error')
    })

    it('succeeds on second attempt after first failure', async () => {
      let callCount = 0
      const jobs = [makeCronJob()]
      mockFetchResponses(() => {
        callCount++
        if (callCount === 1) throw new Error('ECONNREFUSED')
        return jsonResponse(jobs)
      })

      const result = await fetchFromAgentboard<CronJob[]>('/api/cron-ai/jobs')

      expect(callCount).toBe(2)
      expect(Array.isArray(result)).toBe(true)
      expect(result).toEqual(jobs)
    })

    it('succeeds on third attempt after two failures', async () => {
      let callCount = 0
      const jobs = [makeCronJob({ id: 'job-retry' })]
      mockFetchResponses(() => {
        callCount++
        if (callCount <= 2) throw new Error('ECONNREFUSED')
        return jsonResponse(jobs)
      })

      const result = await fetchFromAgentboard<CronJob[]>('/api/cron-ai/jobs')

      expect(callCount).toBe(3)
      expect(Array.isArray(result)).toBe(true)
      expect((result as CronJob[])[0].id).toBe('job-retry')
    })

    it('retries on 5xx responses', async () => {
      let callCount = 0
      mockFetchResponses(() => {
        callCount++
        if (callCount < 3) return jsonResponse({ error: 'server error' }, 503)
        return jsonResponse([makeCronJob()])
      })

      const result = await fetchFromAgentboard<CronJob[]>('/api/cron-ai/jobs')

      expect(callCount).toBe(3)
      expect(Array.isArray(result)).toBe(true)
    })

    it('does NOT retry on 4xx client errors', async () => {
      let callCount = 0
      mockFetchResponses(() => {
        callCount++
        return jsonResponse({ error: 'not found' }, 404)
      })

      const result = await fetchFromAgentboard('/api/cron-ai/jobs/nonexistent')

      // 4xx errors should not be retried — they are client errors
      expect(callCount).toBe(1)
      expect(result).toHaveProperty('error')
    })

    it('does NOT retry on 401 Unauthorized', async () => {
      let callCount = 0
      mockFetchResponses(() => {
        callCount++
        return jsonResponse({ error: 'unauthorized' }, 401)
      })

      const result = await fetchFromAgentboard('/api/cron-ai/jobs')

      expect(callCount).toBe(1)
      expect(result).toHaveProperty('error')
    })

    it('does NOT retry on 403 Forbidden', async () => {
      let callCount = 0
      mockFetchResponses(() => {
        callCount++
        return jsonResponse({ error: 'forbidden' }, 403)
      })

      const result = await fetchFromAgentboard('/api/cron-ai/jobs')

      expect(callCount).toBe(1)
      expect(result).toHaveProperty('error')
    })

    it('does NOT retry on 400 Bad Request', async () => {
      let callCount = 0
      mockFetchResponses(() => {
        callCount++
        return jsonResponse({ error: 'bad request' }, 400)
      })

      const result = await fetchFromAgentboard('/api/cron-ai/jobs')

      expect(callCount).toBe(1)
      expect(result).toHaveProperty('error')
    })

    it('custom retry count is respected via options', async () => {
      let callCount = 0
      mockFetchResponses(() => {
        callCount++
        throw new Error('ECONNREFUSED')
      })

      await fetchFromAgentboard('/api/cron-ai/jobs', { retries: 1 })

      expect(callCount).toBe(1)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Data integrity: tools return correctly typed data
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Data integrity: typed responses', () => {
    it('listJobs returns CronJob[]', async () => {
      const jobs = [
        makeCronJob({ id: 'job-1', name: 'backup' }),
        makeCronJob({ id: 'job-2', name: 'cleanup', health: 'warning' }),
      ]
      mockFetchResponses(() => jsonResponse(jobs))

      const result = await listJobs()

      expect(Array.isArray(result)).toBe(true)
      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('job-1')
      expect(result[1].health).toBe('warning')
    })

    it('listJobsByGroup returns only jobs in the given group', async () => {
      const jobs = [makeCronJob({ projectGroup: 'infra' })]
      mockFetchResponses(() => jsonResponse(jobs))

      const result = await listJobsByGroup('infra')

      expect(result).toHaveLength(1)
      expect(result[0].projectGroup).toBe('infra')
    })

    it('searchJobs returns matching CronJob[]', async () => {
      const jobs = [makeCronJob({ name: 'daily-backup' })]
      mockFetchResponses(() => jsonResponse(jobs))

      const result = await searchJobs('backup')

      expect(result).toHaveLength(1)
      expect(result[0].name).toContain('backup')
    })

    it('getJobDetail returns CronJobDetail with extended fields', async () => {
      const detail = makeJobDetail({
        id: 'job-42',
        scriptContent: '#!/bin/bash\nrsync ...',
        runHistory: [makeRunRecord()],
        recentLogs: ['2026-02-25 backup started', '2026-02-25 backup done'],
      })
      mockFetchResponses(() => jsonResponse(detail))

      const result = await getJobDetail('job-42')

      expect(result.id).toBe('job-42')
      expect(result.scriptContent).toContain('rsync')
      expect(result.runHistory).toHaveLength(1)
      expect(result.recentLogs).toHaveLength(2)
    })

    it('getRunHistory returns JobRunRecord[] with exit codes and durations', async () => {
      const records = [
        makeRunRecord({ exitCode: 0, duration: 30 }),
        makeRunRecord({ exitCode: 1, duration: 120, trigger: 'manual' }),
      ]
      mockFetchResponses(() => jsonResponse(records))

      const result = await getRunHistory('job-1', 10)

      expect(result).toHaveLength(2)
      expect(result[0].exitCode).toBe(0)
      expect(result[0].duration).toBe(30)
      expect(result[1].exitCode).toBe(1)
      expect(result[1].trigger).toBe('manual')
    })

    it('getJobLogs returns string[]', async () => {
      const logs = [
        '2026-02-25 10:00:00 Starting backup',
        '2026-02-25 10:00:30 Syncing files',
        '2026-02-25 10:00:45 Backup complete',
      ]
      mockFetchResponses(() => jsonResponse(logs))

      const result = await getJobLogs('job-1', 100)

      expect(result).toHaveLength(3)
      expect(result[0]).toContain('Starting backup')
      expect(result[2]).toContain('complete')
    })

    it('getLogSnippet returns string[] for a specific run', async () => {
      const snippet = ['run started', 'processing...', 'run finished with exit 0']
      mockFetchResponses(() => jsonResponse(snippet))

      const result = await getLogSnippet('job-1', '2026-02-25T10:00:00Z')

      expect(result).toHaveLength(3)
      expect(result[2]).toContain('exit 0')
    })

    it('listJobs returns empty array when no jobs exist', async () => {
      mockFetchResponses(() => jsonResponse([]))

      const result = await listJobs()

      expect(result).toEqual([])
    })

    it('getRunHistory returns empty array for job with no history', async () => {
      mockFetchResponses(() => jsonResponse([]))

      const result = await getRunHistory('new-job')

      expect(result).toEqual([])
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // fetchFromAgentboard: HTTP client internals
  // ═══════════════════════════════════════════════════════════════════════════

  describe('fetchFromAgentboard: HTTP client', () => {
    it('uses AGENTBOARD_URL as base URL', async () => {
      const origUrl = process.env.AGENTBOARD_URL
      process.env.AGENTBOARD_URL = 'http://custom-host:9999'

      mockFetchResponses(() => jsonResponse({ ok: true }))

      try {
        await fetchFromAgentboard('/api/cron-ai/jobs')

        const lastCall = fetchCallLog[fetchCallLog.length - 1]
        expect(lastCall.url).toContain('http://custom-host:9999')
      } finally {
        if (origUrl !== undefined) {
          process.env.AGENTBOARD_URL = origUrl
        } else {
          delete process.env.AGENTBOARD_URL
        }
      }
    })

    it('defaults to http://localhost:4040 when AGENTBOARD_URL not set', async () => {
      const origUrl = process.env.AGENTBOARD_URL
      delete process.env.AGENTBOARD_URL

      mockFetchResponses(() => jsonResponse({ ok: true }))

      try {
        await fetchFromAgentboard('/api/cron-ai/jobs')

        const lastCall = fetchCallLog[fetchCallLog.length - 1]
        expect(lastCall.url).toContain('localhost:4040')
      } finally {
        if (origUrl !== undefined) {
          process.env.AGENTBOARD_URL = origUrl
        }
      }
    })

    it('supports POST method via options', async () => {
      mockFetchResponses(() => jsonResponse({ success: true }))

      await fetchFromAgentboard('/api/cron-ai/proposals', {
        method: 'POST',
        body: { operation: 'create', description: 'test' },
      })

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.init?.method).toBe('POST')
    })

    it('serializes body as JSON for POST requests', async () => {
      mockFetchResponses(() => jsonResponse({ success: true }))

      const body = { operation: 'create', description: 'New backup job' }
      await fetchFromAgentboard('/api/cron-ai/proposals', {
        method: 'POST',
        body,
      })

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      const sentBody = lastCall.init?.body
      expect(typeof sentBody).toBe('string')
      expect(JSON.parse(sentBody as string)).toEqual(body)
    })

    it('defaults to GET when method not specified', async () => {
      mockFetchResponses(() => jsonResponse([]))

      await fetchFromAgentboard('/api/cron-ai/jobs')

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      // Either 'GET' explicitly or undefined (fetch defaults to GET)
      const method = lastCall.init?.method ?? 'GET'
      expect(method).toBe('GET')
    })

    it('sets Content-Type: application/json for POST requests', async () => {
      mockFetchResponses(() => jsonResponse({ success: true }))

      await fetchFromAgentboard('/api/cron-ai/proposals', {
        method: 'POST',
        body: { operation: 'create' },
      })

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      const contentType =
        lastCall.init?.headers instanceof Headers
          ? lastCall.init.headers.get('Content-Type')
          : (lastCall.init?.headers as Record<string, string>)?.['Content-Type'] ??
            (lastCall.init?.headers as Record<string, string>)?.['content-type']
      expect(contentType).toBe('application/json')
    })

    it('returns parsed JSON, not raw Response object', async () => {
      const data = [makeCronJob({ id: 'parsed-check' })]
      mockFetchResponses(() => jsonResponse(data))

      const result = await fetchFromAgentboard<CronJob[]>('/api/cron-ai/jobs')

      // Should be parsed JSON, not a Response
      expect(result).not.toBeInstanceOf(Response)
      expect(Array.isArray(result)).toBe(true)
      expect((result as CronJob[])[0].id).toBe('parsed-check')
    })

    it('handles empty 204 No Content response', async () => {
      mockFetchResponses(() => new Response(null, { status: 204 }))

      // Should not crash when body is empty/null
      const result = await fetchFromAgentboard('/api/cron-ai/jobs')
      // Implementation may return null, empty array, or structured result — should not throw
      expect(result).toBeDefined()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Edge cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Edge cases', () => {
    it('handles job IDs with special characters', async () => {
      mockFetchResponses(() => jsonResponse(makeJobDetail({ id: 'user@host/backup' })))

      await getJobDetail('user@host/backup')

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      // The job ID should be URL-encoded in the path
      expect(lastCall.url).toContain('/api/cron-ai/jobs/')
    })

    it('handles empty search query', async () => {
      mockFetchResponses(() => jsonResponse([]))

      const result = await searchJobs('')

      expect(Array.isArray(result)).toBe(true)
      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/jobs/search')
    })

    it('handles very large limit values for getRunHistory', async () => {
      mockFetchResponses(() => jsonResponse([]))

      await getRunHistory('job-1', 10000)

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('limit=10000')
    })

    it('handles concurrent tool calls without interference', async () => {
      const job1 = makeCronJob({ id: 'job-1' })
      const job2 = makeCronJob({ id: 'job-2' })

      mockFetchResponses((url) => {
        if (url.includes('job-1')) return jsonResponse(makeJobDetail({ id: 'job-1' }))
        if (url.includes('job-2')) return jsonResponse(makeJobDetail({ id: 'job-2' }))
        return jsonResponse([job1, job2])
      })

      const [detail1, detail2, allJobs] = await Promise.all([
        getJobDetail('job-1'),
        getJobDetail('job-2'),
        listJobs(),
      ])

      expect(detail1.id).toBe('job-1')
      expect(detail2.id).toBe('job-2')
      expect(allJobs).toHaveLength(2)
    })

    it('handles server returning non-JSON response gracefully', async () => {
      mockFetchResponses(
        () => new Response('<!DOCTYPE html><html>not json</html>', { status: 200 }),
      )

      const result = await fetchFromAgentboard('/api/cron-ai/jobs')

      // Should return an error, not crash on JSON parse failure
      expect(result).toHaveProperty('error')
    })

    it('handles timeout/abort scenarios', async () => {
      mockFetchResponses(() => {
        throw new DOMException('The operation was aborted', 'AbortError')
      })

      const result = await fetchFromAgentboard('/api/cron-ai/jobs')

      expect(result).toHaveProperty('error')
    })
  })
})
