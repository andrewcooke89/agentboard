// WU-005: MCP Server Core & Read Tools Tests
// Tests fetchFromAgentboard HTTP client, 7 read tools, auth header, retry logic,
// and structured error handling when agentboard is unavailable.
//
// AC-005-1: MCP server starts on stdio transport and responds to handshake
// AC-005-2: 7 read tools registered with correct JSON schemas
// AC-005-3: Each tool calls the correct /api/cron-ai/* endpoint with correct params
// AC-005-4: HTTP client includes Authorization: Bearer header when token is set
// AC-005-5: When agentboard is unavailable, tools return structured error — not a crash
// AC-005-6: HTTP client retries failed requests up to 3 times before returning error
//
// Strategy: We mock globalThis.fetch to intercept HTTP calls from fetchFromAgentboard.
// Each test asserts the URL, method, headers, and response handling.
// Tests MUST fail against the current stub implementation (throw 'Not implemented').

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
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

// ─── Fetch Mock Infrastructure ────────────────────────────────────────────────

interface CapturedFetch {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

let capturedFetches: CapturedFetch[] = []
let fetchResponseQueue: Array<{ ok: boolean; status: number; body: unknown } | { error: Error }> = []
let originalFetch: typeof globalThis.fetch

function setupFetchMock() {
  capturedFetches = []
  fetchResponseQueue = []
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : (input as Request).url)
    const method = init?.method ?? 'GET'
    const rawHeaders = init?.headers
    const headers: Record<string, string> = {}
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((v, k) => { headers[k] = v })
    } else if (rawHeaders && typeof rawHeaders === 'object') {
      Object.assign(headers, rawHeaders)
    }
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    capturedFetches.push({ url, method, headers, body })

    const next = fetchResponseQueue.shift()
    if (!next) {
      throw new TypeError('fetch failed: no mock response queued')
    }
    if ('error' in next) {
      throw next.error
    }
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof globalThis.fetch
}

function teardownFetchMock() {
  globalThis.fetch = originalFetch
}

function queueSuccess(body: unknown, status = 200) {
  fetchResponseQueue.push({ ok: status >= 200 && status < 300, status, body })
}

function queueNetworkError() {
  fetchResponseQueue.push({ error: new TypeError('fetch failed') })
}

// ─── Module Under Test ────────────────────────────────────────────────────────
// We import the functions directly. They call fetchFromAgentboard internally,
// which uses globalThis.fetch. Our mock intercepts those calls.

import {
  fetchFromAgentboard,
  createMcpServer,
  getRegisteredToolNames,
  getToolSchema,
  listJobs,
  listJobsByGroup,
  searchJobs,
  getJobDetail,
  getRunHistory,
  getJobLogs,
  getLogSnippet,
} from '../cronMcpServer'

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WU-005: MCP Server Core & Read Tools', () => {
  beforeEach(() => {
    setupFetchMock()
    process.env.AGENTBOARD_URL = 'http://test-host:4040'
    process.env.AGENTBOARD_AUTH_TOKEN = 'test-token-abc'
  })

  afterEach(() => {
    teardownFetchMock()
    delete process.env.AGENTBOARD_AUTH_TOKEN
    delete process.env.AGENTBOARD_URL
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-005-4: HTTP client includes Authorization: Bearer header
  // ═══════════════════════════════════════════════════════════════════════════

  describe('fetchFromAgentboard — auth header (AC-005-4)', () => {
    it('includes Authorization: Bearer header when AGENTBOARD_AUTH_TOKEN is set', async () => {
      queueSuccess([])
      await fetchFromAgentboard('/api/cron-ai/jobs')

      expect(capturedFetches.length).toBeGreaterThanOrEqual(1)
      const { headers } = capturedFetches[0]
      expect(headers['Authorization'] || headers['authorization']).toBe('Bearer test-token-abc')
    })

    it('omits Authorization header when AGENTBOARD_AUTH_TOKEN is empty', async () => {
      process.env.AGENTBOARD_AUTH_TOKEN = ''
      queueSuccess([])
      await fetchFromAgentboard('/api/cron-ai/jobs')

      expect(capturedFetches.length).toBeGreaterThanOrEqual(1)
      const { headers } = capturedFetches[0]
      const auth = headers['Authorization'] || headers['authorization']
      // Should be missing or falsy
      expect(!auth || auth === '').toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-005-6: HTTP client retries failed requests up to 3 times
  // ═══════════════════════════════════════════════════════════════════════════

  describe('fetchFromAgentboard — retry logic (AC-005-6)', () => {
    it('retries up to 3 times on network failure then returns structured error', async () => {
      queueNetworkError()
      queueNetworkError()
      queueNetworkError()

      const result = await fetchFromAgentboard('/api/cron-ai/jobs')

      // Must have attempted at least 3 fetches
      expect(capturedFetches.length).toBeGreaterThanOrEqual(3)
      // Must return structured error, not throw
      expect(result).toHaveProperty('error')
      expect((result as any).error).toMatch(/unavailable/i)
    })

    it('succeeds on second attempt after first failure', async () => {
      const jobs = [makeCronJob()]
      queueNetworkError()
      queueSuccess(jobs)

      const result = await fetchFromAgentboard<CronJob[]>('/api/cron-ai/jobs')

      expect(capturedFetches).toHaveLength(2)
      expect(result).toEqual(jobs)
    })

    it('succeeds on third attempt after two failures', async () => {
      const jobs = [makeCronJob()]
      queueNetworkError()
      queueNetworkError()
      queueSuccess(jobs)

      const result = await fetchFromAgentboard<CronJob[]>('/api/cron-ai/jobs')

      expect(capturedFetches).toHaveLength(3)
      expect(result).toEqual(jobs)
    })

    it('returns structured error on repeated HTTP 500', async () => {
      queueSuccess({ error: 'Internal Server Error' }, 500)
      queueSuccess({ error: 'Internal Server Error' }, 500)
      queueSuccess({ error: 'Internal Server Error' }, 500)

      const result = await fetchFromAgentboard('/api/cron-ai/jobs')

      expect(result).toHaveProperty('error')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-005-5: Structured error on unavailability — no crash
  // ═══════════════════════════════════════════════════════════════════════════

  describe('fetchFromAgentboard — structured error (AC-005-5)', () => {
    it('returns { error: "agentboard server unavailable" } on total failure', async () => {
      queueNetworkError()
      queueNetworkError()
      queueNetworkError()

      const result = await fetchFromAgentboard('/api/cron-ai/jobs')

      expect(result).toEqual(
        expect.objectContaining({ error: expect.stringContaining('unavailable') })
      )
    })

    it('does not throw — always returns a value', async () => {
      queueNetworkError()
      queueNetworkError()
      queueNetworkError()

      // Must not throw; if it does, this test fails
      let threw = false
      let result: unknown
      try {
        result = await fetchFromAgentboard('/api/cron-ai/jobs')
      } catch {
        threw = true
      }
      expect(threw).toBe(false)
      expect(result).toBeDefined()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-005-3: listJobs — GET /api/cron-ai/jobs
  // ═══════════════════════════════════════════════════════════════════════════

  describe('listJobs (AC-005-3)', () => {
    it('calls GET /api/cron-ai/jobs and returns CronJob[]', async () => {
      const jobs = [makeCronJob(), makeCronJob({ id: 'job-2', name: 'cleanup' })]
      queueSuccess(jobs)

      const result = await listJobs()

      expect(capturedFetches.length).toBeGreaterThanOrEqual(1)
      expect(capturedFetches[0].url).toContain('/api/cron-ai/jobs')
      expect(capturedFetches[0].method).toBe('GET')
      // Should not have query params for base list
      expect(capturedFetches[0].url).not.toContain('?')
      expect(result).toEqual(jobs)
    })

    it('returns empty array when no jobs exist', async () => {
      queueSuccess([])

      const result = await listJobs()

      expect(result).toEqual([])
    })

    it('returns structured error when agentboard is down', async () => {
      queueNetworkError()
      queueNetworkError()
      queueNetworkError()

      const result = await listJobs()

      expect(result).toHaveProperty('error')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-005-3: listJobsByGroup — GET /api/cron-ai/jobs?group=:group
  // ═══════════════════════════════════════════════════════════════════════════

  describe('listJobsByGroup (AC-005-3)', () => {
    it('calls GET /api/cron-ai/jobs?group=:group', async () => {
      const jobs = [makeCronJob({ projectGroup: 'backups' })]
      queueSuccess(jobs)

      const result = await listJobsByGroup('backups')

      expect(capturedFetches.length).toBeGreaterThanOrEqual(1)
      expect(capturedFetches[0].url).toContain('/api/cron-ai/jobs')
      expect(capturedFetches[0].url).toContain('group=backups')
      expect(capturedFetches[0].method).toBe('GET')
      expect(result).toEqual(jobs)
    })

    it('URL-encodes group names with special characters', async () => {
      queueSuccess([])

      await listJobsByGroup('my group/sub')

      expect(capturedFetches.length).toBeGreaterThanOrEqual(1)
      const url = capturedFetches[0].url
      // Must not contain raw spaces
      expect(url).not.toContain(' ')
      expect(url).toContain('group=')
    })

    it('returns empty array when no jobs in group', async () => {
      queueSuccess([])

      const result = await listJobsByGroup('nonexistent')

      expect(result).toEqual([])
    })

    it('returns structured error when agentboard is down', async () => {
      queueNetworkError()
      queueNetworkError()
      queueNetworkError()

      const result = await listJobsByGroup('any')

      expect(result).toHaveProperty('error')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-005-3: searchJobs — GET /api/cron-ai/jobs/search?q=:query
  // ═══════════════════════════════════════════════════════════════════════════

  describe('searchJobs (AC-005-3)', () => {
    it('calls GET /api/cron-ai/jobs/search?q=:query', async () => {
      const jobs = [makeCronJob({ name: 'daily-backup' })]
      queueSuccess(jobs)

      const result = await searchJobs('backup')

      expect(capturedFetches.length).toBeGreaterThanOrEqual(1)
      expect(capturedFetches[0].url).toContain('/api/cron-ai/jobs/search')
      expect(capturedFetches[0].url).toContain('q=backup')
      expect(capturedFetches[0].method).toBe('GET')
      expect(result).toEqual(jobs)
    })

    it('URL-encodes query with special characters', async () => {
      queueSuccess([])

      await searchJobs('backup & cleanup')

      const url = capturedFetches[0].url
      expect(url).toContain('q=')
      expect(url).not.toContain(' ')
    })

    it('returns empty array for no matches', async () => {
      queueSuccess([])

      const result = await searchJobs('nonexistent-xyz')

      expect(result).toEqual([])
    })

    it('returns structured error when agentboard is down', async () => {
      queueNetworkError()
      queueNetworkError()
      queueNetworkError()

      const result = await searchJobs('backup')

      expect(result).toHaveProperty('error')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-005-3: getJobDetail — GET /api/cron-ai/jobs/:id
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getJobDetail (AC-005-3)', () => {
    it('calls GET /api/cron-ai/jobs/:id and returns CronJobDetail', async () => {
      const detail = makeJobDetail({ id: 'job-42' })
      queueSuccess(detail)

      const result = await getJobDetail('job-42')

      expect(capturedFetches.length).toBeGreaterThanOrEqual(1)
      expect(capturedFetches[0].url).toContain('/api/cron-ai/jobs/job-42')
      expect(capturedFetches[0].method).toBe('GET')
      expect(result).toEqual(detail)
    })

    it('includes scriptContent and runHistory in response', async () => {
      const detail = makeJobDetail({
        scriptContent: '#!/bin/bash\nrsync -a /src /dst',
        runHistory: [makeRunRecord(), makeRunRecord({ exitCode: 1 })],
      })
      queueSuccess(detail)

      const result = await getJobDetail('job-1') as CronJobDetail

      expect(result.scriptContent).toContain('rsync')
      expect(result.runHistory).toHaveLength(2)
    })

    it('returns structured error for non-existent job (404)', async () => {
      queueSuccess({ error: 'Job not found' }, 404)
      queueSuccess({ error: 'Job not found' }, 404)
      queueSuccess({ error: 'Job not found' }, 404)

      const result = await getJobDetail('nonexistent')

      expect(result).toHaveProperty('error')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-005-3: getRunHistory — GET /api/cron-ai/jobs/:id/history?limit=:n
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getRunHistory (AC-005-3)', () => {
    it('calls GET /api/cron-ai/jobs/:id/history?limit=:n', async () => {
      const records = [makeRunRecord(), makeRunRecord({ exitCode: 1, duration: 120 })]
      queueSuccess(records)

      const result = await getRunHistory('job-1', 10)

      expect(capturedFetches.length).toBeGreaterThanOrEqual(1)
      expect(capturedFetches[0].url).toContain('/api/cron-ai/jobs/job-1/history')
      expect(capturedFetches[0].url).toContain('limit=10')
      expect(capturedFetches[0].method).toBe('GET')
      expect(result).toEqual(records)
    })

    it('returns exit codes and durations in each record', async () => {
      const records = [
        makeRunRecord({ exitCode: 0, duration: 30 }),
        makeRunRecord({ exitCode: 1, duration: 90 }),
      ]
      queueSuccess(records)

      const result = await getRunHistory('job-1', 5) as JobRunRecord[]

      expect(result[0].exitCode).toBe(0)
      expect(result[0].duration).toBe(30)
      expect(result[1].exitCode).toBe(1)
      expect(result[1].duration).toBe(90)
    })

    it('omits limit param when not provided', async () => {
      queueSuccess([])

      await getRunHistory('job-1')

      expect(capturedFetches.length).toBeGreaterThanOrEqual(1)
      expect(capturedFetches[0].url).toContain('/api/cron-ai/jobs/job-1/history')
      expect(capturedFetches[0].url).not.toContain('limit=')
    })

    it('returns structured error when agentboard is down', async () => {
      queueNetworkError()
      queueNetworkError()
      queueNetworkError()

      const result = await getRunHistory('job-1', 10)

      expect(result).toHaveProperty('error')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-005-3: getJobLogs — GET /api/cron-ai/jobs/:id/logs?lines=:n
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getJobLogs (AC-005-3)', () => {
    it('calls GET /api/cron-ai/jobs/:id/logs?lines=:n', async () => {
      const logLines = ['2026-02-25 backup started', '2026-02-25 backup complete']
      queueSuccess(logLines)

      const result = await getJobLogs('job-1', 100)

      expect(capturedFetches.length).toBeGreaterThanOrEqual(1)
      expect(capturedFetches[0].url).toContain('/api/cron-ai/jobs/job-1/logs')
      expect(capturedFetches[0].url).toContain('lines=100')
      expect(capturedFetches[0].method).toBe('GET')
      expect(result).toEqual(logLines)
    })

    it('returns string[] of log lines', async () => {
      const logLines = ['line 1', 'line 2', 'line 3']
      queueSuccess(logLines)

      const result = await getJobLogs('job-1', 50) as string[]

      expect(Array.isArray(result)).toBe(true)
      expect(result).toHaveLength(3)
      expect(result[0]).toBe('line 1')
    })

    it('omits lines param when not provided', async () => {
      queueSuccess([])

      await getJobLogs('job-1')

      expect(capturedFetches.length).toBeGreaterThanOrEqual(1)
      expect(capturedFetches[0].url).not.toContain('lines=')
    })

    it('returns structured error when agentboard is down', async () => {
      queueNetworkError()
      queueNetworkError()
      queueNetworkError()

      const result = await getJobLogs('job-1', 100)

      expect(result).toHaveProperty('error')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-005-3: getLogSnippet — GET /api/cron-ai/jobs/:id/logs?run=:ts
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getLogSnippet (AC-005-3)', () => {
    it('calls GET /api/cron-ai/jobs/:id/logs?run=:ts', async () => {
      const snippet = ['Starting backup...', 'Syncing files...', 'Done.']
      queueSuccess(snippet)

      const result = await getLogSnippet('job-1', '2026-02-25T10:00:00Z')

      expect(capturedFetches.length).toBeGreaterThanOrEqual(1)
      expect(capturedFetches[0].url).toContain('/api/cron-ai/jobs/job-1/logs')
      expect(capturedFetches[0].url).toContain('run=')
      expect(capturedFetches[0].url).toContain('2026-02-25')
      expect(capturedFetches[0].method).toBe('GET')
      expect(result).toEqual(snippet)
    })

    it('returns empty array when no logs for that run', async () => {
      queueSuccess([])

      const result = await getLogSnippet('job-1', '1970-01-01T00:00:00Z')

      expect(result).toEqual([])
    })

    it('returns structured error when agentboard is down', async () => {
      queueNetworkError()
      queueNetworkError()
      queueNetworkError()

      const result = await getLogSnippet('job-1', '2026-02-25T10:00:00Z')

      expect(result).toHaveProperty('error')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-005-4: Base URL from env
  // ═══════════════════════════════════════════════════════════════════════════

  describe('fetchFromAgentboard — base URL construction (AC-005-4)', () => {
    it('uses AGENTBOARD_URL as base for all requests', async () => {
      process.env.AGENTBOARD_URL = 'http://custom-host:9090'
      queueSuccess([])

      await fetchFromAgentboard('/api/cron-ai/jobs')

      expect(capturedFetches[0].url).toContain('http://custom-host:9090')
      expect(capturedFetches[0].url).toContain('/api/cron-ai/jobs')
    })

    it('constructs full URL without double slashes', async () => {
      queueSuccess([])

      await fetchFromAgentboard('/api/cron-ai/jobs')

      const url = capturedFetches[0].url
      // No double slashes except after protocol
      expect(url).not.toMatch(/[^:]\/\/api/)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-005-2: Tool Registration — Schema Contracts
  // ═══════════════════════════════════════════════════════════════════════════

  describe('tool registration — schema contracts (AC-005-2)', () => {
    it('listJobs takes no arguments', () => {
      expect(typeof listJobs).toBe('function')
      expect(listJobs.length).toBe(0)
    })

    it('listJobsByGroup takes group: string', () => {
      expect(typeof listJobsByGroup).toBe('function')
      expect(listJobsByGroup.length).toBe(1)
    })

    it('searchJobs takes query: string', () => {
      expect(typeof searchJobs).toBe('function')
      expect(searchJobs.length).toBe(1)
    })

    it('getJobDetail takes jobId: string', () => {
      expect(typeof getJobDetail).toBe('function')
      expect(getJobDetail.length).toBe(1)
    })

    it('getRunHistory takes jobId: string, limit?: number', () => {
      expect(typeof getRunHistory).toBe('function')
      // .length reports required params only
      expect(getRunHistory.length).toBeGreaterThanOrEqual(1)
    })

    it('getJobLogs takes jobId: string, lines?: number', () => {
      expect(typeof getJobLogs).toBe('function')
      expect(getJobLogs.length).toBeGreaterThanOrEqual(1)
    })

    it('getLogSnippet takes jobId: string, runTimestamp: string', () => {
      expect(typeof getLogSnippet).toBe('function')
      expect(getLogSnippet.length).toBe(2)
    })

    it('all 7 read tools are exported', () => {
      const readTools = [listJobs, listJobsByGroup, searchJobs, getJobDetail, getRunHistory, getJobLogs, getLogSnippet]
      for (const fn of readTools) {
        expect(typeof fn).toBe('function')
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-005-1: MCP Server Initialization
  // ═══════════════════════════════════════════════════════════════════════════

  describe('createMcpServer — initialization (AC-005-1)', () => {
    it('createMcpServer is exported and callable', () => {
      expect(typeof createMcpServer).toBe('function')
    })

    it('fetchFromAgentboard is exported for use by other WUs', () => {
      expect(typeof fetchFromAgentboard).toBe('function')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-005-2: MCP Tool Registration with JSON Schemas (NOT YET IMPLEMENTED)
  // These tests target getRegisteredToolNames() and getToolSchema() which
  // still throw 'Not implemented'. They verify the MCP server registers all
  // 7 read tools with correct parameter schemas.
  // ═══════════════════════════════════════════════════════════════════════════

  describe('MCP tool registration — JSON schemas (AC-005-2)', () => {
    it('getRegisteredToolNames returns all 7 read tool names', () => {
      const names = getRegisteredToolNames()

      expect(names).toContain('list_jobs')
      expect(names).toContain('list_jobs_by_group')
      expect(names).toContain('search_jobs')
      expect(names).toContain('get_job_detail')
      expect(names).toContain('get_run_history')
      expect(names).toContain('get_job_logs')
      expect(names).toContain('get_log_snippet')
    })

    it('list_jobs has no required parameters', () => {
      const schema = getToolSchema('list_jobs')

      expect(schema.required ?? []).toEqual([])
    })

    it('list_jobs_by_group requires group: string', () => {
      const schema = getToolSchema('list_jobs_by_group')

      expect(schema.required).toContain('group')
      expect(schema.properties.group.type).toBe('string')
    })

    it('search_jobs requires query: string', () => {
      const schema = getToolSchema('search_jobs')

      expect(schema.required).toContain('query')
      expect(schema.properties.query.type).toBe('string')
    })

    it('get_job_detail requires jobId: string', () => {
      const schema = getToolSchema('get_job_detail')

      expect(schema.required).toContain('jobId')
      expect(schema.properties.jobId.type).toBe('string')
    })

    it('get_run_history requires jobId: string, optional limit: number', () => {
      const schema = getToolSchema('get_run_history')

      expect(schema.required).toContain('jobId')
      expect(schema.properties.jobId.type).toBe('string')
      expect(schema.properties.limit.type).toBe('number')
      // limit is optional — not in required
      expect(schema.required).not.toContain('limit')
    })

    it('get_job_logs requires jobId: string, optional lines: number', () => {
      const schema = getToolSchema('get_job_logs')

      expect(schema.required).toContain('jobId')
      expect(schema.properties.jobId.type).toBe('string')
      expect(schema.properties.lines.type).toBe('number')
      expect(schema.required).not.toContain('lines')
    })

    it('get_log_snippet requires jobId: string and runTimestamp: string', () => {
      const schema = getToolSchema('get_log_snippet')

      expect(schema.required).toContain('jobId')
      expect(schema.required).toContain('runTimestamp')
      expect(schema.properties.jobId.type).toBe('string')
      expect(schema.properties.runTimestamp.type).toBe('string')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Edge Cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('edge cases', () => {
    it('handles large response payloads (500 jobs)', async () => {
      const manyJobs = Array.from({ length: 500 }, (_, i) =>
        makeCronJob({ id: `job-${i}`, name: `job-${i}` })
      )
      queueSuccess(manyJobs)

      const result = await listJobs()

      expect(result).toHaveLength(500)
    })

    it('handles job IDs with special characters in URL path', async () => {
      queueSuccess(makeJobDetail({ id: 'job/with/slashes' }))

      await getJobDetail('job/with/slashes')

      expect(capturedFetches.length).toBeGreaterThanOrEqual(1)
      expect(capturedFetches[0].url).toContain('/api/cron-ai/jobs/')
    })

    it('handles empty string query in search', async () => {
      queueSuccess([])

      const _result = await searchJobs('')

      expect(capturedFetches.length).toBeGreaterThanOrEqual(1)
      expect(capturedFetches[0].url).toContain('/api/cron-ai/jobs/search')
    })

    it('handles limit=0 in getRunHistory', async () => {
      queueSuccess([])

      await getRunHistory('job-1', 0)

      expect(capturedFetches.length).toBeGreaterThanOrEqual(1)
      expect(capturedFetches[0].url).toContain('/api/cron-ai/jobs/job-1/history')
    })

    it('handles lines=0 in getJobLogs', async () => {
      queueSuccess([])

      await getJobLogs('job-1', 0)

      expect(capturedFetches.length).toBeGreaterThanOrEqual(1)
      expect(capturedFetches[0].url).toContain('/api/cron-ai/jobs/job-1/logs')
    })
  })
})
