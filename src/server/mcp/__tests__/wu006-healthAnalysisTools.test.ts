// WU-006: MCP Server Health & Analysis Tools — Unit Tests
// Tests 7 health/analysis tools: getHealthSummary, getFailingJobs, getScheduleConflicts,
// getDurationTrends, analyzeScheduleLoad, getUiContext, getAvailableSessions.
// Covers AC-006-1 through AC-006-6 plus error handling and edge cases.

import { describe, it, expect, afterEach, mock } from 'bun:test'
import type {
  CronJob,
  CronJobDetail,
  UiContext,
  ScheduleConflict,
  ScheduleLoadAnalysis,
  DurationTrendData,
  Session,
} from '@shared/types'

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

function makeUiContext(overrides: Partial<UiContext> = {}): UiContext {
  return {
    selectedJobId: null,
    selectedJobDetail: null,
    activeTab: 'overview',
    visibleJobCount: 5,
    filterState: { mode: 'all', source: null, tags: [] },
    healthSummary: { healthy: 3, warning: 1, critical: 0 },
    ...overrides,
  }
}

function makeScheduleConflict(overrides: Partial<ScheduleConflict> = {}): ScheduleConflict {
  return {
    jobIds: ['job-1', 'job-2'],
    schedule: '0 * * * *',
    description: 'Jobs job-1 and job-2 both run at the same time',
    ...overrides,
  }
}

function makeScheduleLoadAnalysis(
  overrides: Partial<ScheduleLoadAnalysis> = {},
): ScheduleLoadAnalysis {
  const hourlyLoad: Record<number, number> = {}
  for (let h = 0; h < 24; h++) hourlyLoad[h] = 0
  return {
    hourlyLoad,
    peakHours: [],
    recommendations: [],
    ...overrides,
  }
}

function makeDurationTrendData(overrides: Partial<DurationTrendData> = {}): DurationTrendData {
  return {
    jobId: 'job-1',
    durations: [30, 32, 35, 28, 31],
    average: 31.2,
    trend: 'stable',
    ...overrides,
  }
}

// ─── Mock Setup ───────────────────────────────────────────────────────────────

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

import {
  getHealthSummary,
  getFailingJobs,
  getScheduleConflicts,
  getDurationTrends,
  analyzeScheduleLoad,
  getUiContext,
  getAvailableSessions,
  getRegisteredToolNames,
  getToolSchema,
} from '../cronMcpServer'

// ─── Test Suites ──────────────────────────────────────────────────────────────

describe('WU-006: MCP Server Health & Analysis Tools', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
    fetchCallLog = []
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-006-1: get_health_summary() returns {healthy, warning, critical}
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-006-1: get_health_summary returns health counts', () => {
    it('returns correct counts from mocked data', async () => {
      const summary = { healthy: 5, warning: 2, critical: 1 }
      mockFetchResponses(() => jsonResponse(summary))

      const result = await getHealthSummary()

      expect(result).toEqual({ healthy: 5, warning: 2, critical: 1 })
    })

    it('returns all zeros when no jobs exist', async () => {
      const summary = { healthy: 0, warning: 0, critical: 0 }
      mockFetchResponses(() => jsonResponse(summary))

      const result = await getHealthSummary()

      expect(result.healthy).toBe(0)
      expect(result.warning).toBe(0)
      expect(result.critical).toBe(0)
    })

    it('calls GET /api/cron-ai/health', async () => {
      mockFetchResponses(() => jsonResponse({ healthy: 0, warning: 0, critical: 0 }))

      await getHealthSummary()

      expect(fetchCallLog.length).toBeGreaterThanOrEqual(1)
      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/health')
      // Should not hit sub-paths like /health/failing
      expect(lastCall.url).not.toContain('/health/')
      expect(lastCall.init?.method ?? 'GET').toBe('GET')
    })

    it('returns structured error when server is down', async () => {
      mockFetchResponses(() => {
        throw new Error('ECONNREFUSED')
      })

      const result = await getHealthSummary()

      expect(result).toHaveProperty('error')
      expect((result as unknown as { error: string }).error).toContain('unavailable')
    })

    it('has all three required numeric fields', async () => {
      const summary = { healthy: 10, warning: 3, critical: 2 }
      mockFetchResponses(() => jsonResponse(summary))

      const result = await getHealthSummary()

      expect(typeof result.healthy).toBe('number')
      expect(typeof result.warning).toBe('number')
      expect(typeof result.critical).toBe('number')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-006-2: get_failing_jobs() returns only warning/critical jobs
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-006-2: get_failing_jobs returns unhealthy jobs', () => {
    it('returns only jobs with warning or critical health', async () => {
      const failingJobs = [
        makeCronJob({ id: 'job-warn', health: 'warning', healthReason: 'High failure rate' }),
        makeCronJob({ id: 'job-crit', health: 'critical', healthReason: '5 consecutive failures' }),
      ]
      mockFetchResponses(() => jsonResponse(failingJobs))

      const result = await getFailingJobs()

      expect(Array.isArray(result)).toBe(true)
      expect(result).toHaveLength(2)
      for (const job of result) {
        expect(['warning', 'critical']).toContain(job.health)
      }
    })

    it('includes healthReason on returned jobs', async () => {
      const failingJobs = [
        makeCronJob({
          id: 'job-fail',
          health: 'critical',
          healthReason: 'Exit code 137 (OOM killed)',
        }),
      ]
      mockFetchResponses(() => jsonResponse(failingJobs))

      const result = await getFailingJobs()

      expect(result).toHaveLength(1)
      expect(result[0].healthReason).toBe('Exit code 137 (OOM killed)')
    })

    it('returns empty array when all jobs are healthy', async () => {
      mockFetchResponses(() => jsonResponse([]))

      const result = await getFailingJobs()

      expect(result).toEqual([])
    })

    it('calls GET /api/cron-ai/health/failing', async () => {
      mockFetchResponses(() => jsonResponse([]))

      await getFailingJobs()

      expect(fetchCallLog.length).toBeGreaterThanOrEqual(1)
      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/health/failing')
      expect(lastCall.init?.method ?? 'GET').toBe('GET')
    })

    it('returns structured error when server is down', async () => {
      mockFetchResponses(() => {
        throw new Error('ECONNREFUSED')
      })

      const result = await getFailingJobs()

      expect(result).toHaveProperty('error')
    })

    it('returns full CronJob objects with all fields', async () => {
      const job = makeCronJob({
        id: 'job-fail',
        health: 'warning',
        healthReason: 'Slow',
        consecutiveFailures: 3,
        lastExitCode: 1,
      })
      mockFetchResponses(() => jsonResponse([job]))

      const result = await getFailingJobs()

      expect(result[0].id).toBe('job-fail')
      expect(result[0].consecutiveFailures).toBe(3)
      expect(result[0].lastExitCode).toBe(1)
      expect(result[0].schedule).toBe('0 * * * *')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-006-3: get_schedule_conflicts() detects overlapping schedules
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-006-3: get_schedule_conflicts detects overlaps', () => {
    it('detects two jobs running at the same time', async () => {
      const conflicts = [
        makeScheduleConflict({
          jobIds: ['job-a', 'job-b'],
          schedule: '0 3 * * *',
          description: 'Jobs job-a and job-b both run at 03:00 daily',
        }),
      ]
      mockFetchResponses(() => jsonResponse(conflicts))

      const result = await getScheduleConflicts()

      expect(Array.isArray(result)).toBe(true)
      expect(result).toHaveLength(1)
      expect(result[0].jobIds).toContain('job-a')
      expect(result[0].jobIds).toContain('job-b')
      expect(result[0].schedule).toBe('0 3 * * *')
      expect(result[0].description).toContain('job-a')
    })

    it('returns multiple conflicts when several exist', async () => {
      const conflicts = [
        makeScheduleConflict({
          jobIds: ['job-1', 'job-2'],
          schedule: '0 * * * *',
          description: 'Hourly overlap',
        }),
        makeScheduleConflict({
          jobIds: ['job-3', 'job-4', 'job-5'],
          schedule: '0 0 * * *',
          description: 'Midnight overlap (3 jobs)',
        }),
      ]
      mockFetchResponses(() => jsonResponse(conflicts))

      const result = await getScheduleConflicts()

      expect(result).toHaveLength(2)
      expect(result[1].jobIds).toHaveLength(3)
    })

    it('returns empty array when no conflicts exist', async () => {
      mockFetchResponses(() => jsonResponse([]))

      const result = await getScheduleConflicts()

      expect(result).toEqual([])
    })

    it('calls GET /api/cron-ai/schedule/conflicts', async () => {
      mockFetchResponses(() => jsonResponse([]))

      await getScheduleConflicts()

      expect(fetchCallLog.length).toBeGreaterThanOrEqual(1)
      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/schedule/conflicts')
      expect(lastCall.init?.method ?? 'GET').toBe('GET')
    })

    it('returns structured error when server is down', async () => {
      mockFetchResponses(() => {
        throw new Error('ECONNREFUSED')
      })

      const result = await getScheduleConflicts()

      expect(result).toHaveProperty('error')
    })

    it('conflict objects have required fields: jobIds, schedule, description', async () => {
      const conflict = makeScheduleConflict()
      mockFetchResponses(() => jsonResponse([conflict]))

      const result = await getScheduleConflicts()

      expect(result[0]).toHaveProperty('jobIds')
      expect(result[0]).toHaveProperty('schedule')
      expect(result[0]).toHaveProperty('description')
      expect(Array.isArray(result[0].jobIds)).toBe(true)
      expect(typeof result[0].schedule).toBe('string')
      expect(typeof result[0].description).toBe('string')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-006-4: analyze_schedule_load() returns per-hour density for 24h
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-006-4: analyze_schedule_load returns per-hour density', () => {
    it('returns hourly load for all 24 hours', async () => {
      const load = makeScheduleLoadAnalysis({
        hourlyLoad: Object.fromEntries(
          Array.from({ length: 24 }, (_, h) => [h, h === 3 ? 5 : h === 0 ? 3 : 1]),
        ),
        peakHours: [3, 0],
        recommendations: ['Consider spreading midnight jobs across 00:00-01:00'],
      })
      mockFetchResponses(() => jsonResponse(load))

      const result = await analyzeScheduleLoad()

      expect(result.hourlyLoad).toBeDefined()
      // Should have entries for hours 0-23
      const hours = Object.keys(result.hourlyLoad).map(Number)
      expect(hours.length).toBe(24)
      expect(Math.min(...hours)).toBe(0)
      expect(Math.max(...hours)).toBe(23)
    })

    it('identifies peak hours correctly', async () => {
      const load = makeScheduleLoadAnalysis({
        peakHours: [0, 3, 12],
      })
      mockFetchResponses(() => jsonResponse(load))

      const result = await analyzeScheduleLoad()

      expect(Array.isArray(result.peakHours)).toBe(true)
      expect(result.peakHours).toContain(0)
      expect(result.peakHours).toContain(3)
      expect(result.peakHours).toContain(12)
    })

    it('returns recommendations array', async () => {
      const load = makeScheduleLoadAnalysis({
        recommendations: [
          'Hour 0 has 8 jobs — consider staggering',
          'No jobs scheduled between 04:00-06:00 — good maintenance window',
        ],
      })
      mockFetchResponses(() => jsonResponse(load))

      const result = await analyzeScheduleLoad()

      expect(Array.isArray(result.recommendations)).toBe(true)
      expect(result.recommendations).toHaveLength(2)
      expect(result.recommendations[0]).toContain('staggering')
    })

    it('returns empty recommendations when load is balanced', async () => {
      const load = makeScheduleLoadAnalysis({
        peakHours: [],
        recommendations: [],
      })
      mockFetchResponses(() => jsonResponse(load))

      const result = await analyzeScheduleLoad()

      expect(result.recommendations).toEqual([])
      expect(result.peakHours).toEqual([])
    })

    it('calls GET /api/cron-ai/schedule/load', async () => {
      mockFetchResponses(() => jsonResponse(makeScheduleLoadAnalysis()))

      await analyzeScheduleLoad()

      expect(fetchCallLog.length).toBeGreaterThanOrEqual(1)
      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/schedule/load')
      expect(lastCall.init?.method ?? 'GET').toBe('GET')
    })

    it('returns structured error when server is down', async () => {
      mockFetchResponses(() => {
        throw new Error('ECONNREFUSED')
      })

      const result = await analyzeScheduleLoad()

      expect(result).toHaveProperty('error')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-006-5: get_ui_context() returns current UiContext snapshot
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-006-5: get_ui_context returns UiContext snapshot', () => {
    it('returns context with selectedJobId, activeTab, and filters', async () => {
      const ctx = makeUiContext({
        selectedJobId: 'job-42',
        activeTab: 'history',
        filterState: { mode: 'source', source: 'user-crontab', tags: ['backup'] },
      })
      mockFetchResponses(() => jsonResponse(ctx))

      const result = await getUiContext()

      expect(result.selectedJobId).toBe('job-42')
      expect(result.activeTab).toBe('history')
      expect(result.filterState.mode).toBe('source')
      expect(result.filterState.source).toBe('user-crontab')
      expect(result.filterState.tags).toContain('backup')
    })

    it('returns null selectedJobId when nothing selected', async () => {
      const ctx = makeUiContext({ selectedJobId: null, selectedJobDetail: null })
      mockFetchResponses(() => jsonResponse(ctx))

      const result = await getUiContext()

      expect(result.selectedJobId).toBeNull()
      expect(result.selectedJobDetail).toBeNull()
    })

    it('includes healthSummary in context', async () => {
      const ctx = makeUiContext({
        healthSummary: { healthy: 10, warning: 2, critical: 1 },
      })
      mockFetchResponses(() => jsonResponse(ctx))

      const result = await getUiContext()

      expect(result.healthSummary).toEqual({ healthy: 10, warning: 2, critical: 1 })
    })

    it('includes visibleJobCount', async () => {
      const ctx = makeUiContext({ visibleJobCount: 42 })
      mockFetchResponses(() => jsonResponse(ctx))

      const result = await getUiContext()

      expect(result.visibleJobCount).toBe(42)
    })

    it('calls GET /api/cron-ai/context', async () => {
      mockFetchResponses(() => jsonResponse(makeUiContext()))

      await getUiContext()

      expect(fetchCallLog.length).toBeGreaterThanOrEqual(1)
      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/context')
      expect(lastCall.init?.method ?? 'GET').toBe('GET')
    })

    it('returns structured error when server is down', async () => {
      mockFetchResponses(() => {
        throw new Error('ECONNREFUSED')
      })

      const result = await getUiContext()

      expect(result).toHaveProperty('error')
    })

    it('includes all UiContext fields in response', async () => {
      const ctx = makeUiContext()
      mockFetchResponses(() => jsonResponse(ctx))

      const result = await getUiContext()

      expect(result).toHaveProperty('selectedJobId')
      expect(result).toHaveProperty('selectedJobDetail')
      expect(result).toHaveProperty('activeTab')
      expect(result).toHaveProperty('visibleJobCount')
      expect(result).toHaveProperty('filterState')
      expect(result).toHaveProperty('healthSummary')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-006-6: All 7 tools have correct JSON schemas
  // ═══════════════════════════════════════════════════════════════════════════

  describe('AC-006-6: Tool signatures and parameter types', () => {
    it('getHealthSummary accepts no arguments', async () => {
      mockFetchResponses(() => jsonResponse({ healthy: 0, warning: 0, critical: 0 }))

      const result = await getHealthSummary()

      expect(result).toHaveProperty('healthy')
    })

    it('getFailingJobs accepts no arguments', async () => {
      mockFetchResponses(() => jsonResponse([]))

      const result = await getFailingJobs()

      expect(Array.isArray(result)).toBe(true)
    })

    it('getScheduleConflicts accepts no arguments', async () => {
      mockFetchResponses(() => jsonResponse([]))

      const result = await getScheduleConflicts()

      expect(Array.isArray(result)).toBe(true)
    })

    it('getDurationTrends requires a jobId string parameter', async () => {
      mockFetchResponses(() => jsonResponse(makeDurationTrendData()))

      const result = await getDurationTrends('job-1')

      expect(result).toHaveProperty('jobId')
      expect(result).toHaveProperty('durations')
    })

    it('analyzeScheduleLoad accepts no arguments', async () => {
      mockFetchResponses(() => jsonResponse(makeScheduleLoadAnalysis()))

      const result = await analyzeScheduleLoad()

      expect(result).toHaveProperty('hourlyLoad')
    })

    it('getUiContext accepts no arguments', async () => {
      mockFetchResponses(() => jsonResponse(makeUiContext()))

      const result = await getUiContext()

      expect(result).toHaveProperty('activeTab')
    })

    it('getAvailableSessions accepts no arguments', async () => {
      mockFetchResponses(() => jsonResponse([]))

      const result = await getAvailableSessions()

      expect(Array.isArray(result)).toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-006-6 (cont): Tool registry JSON schemas for WU-006 tools
  // ═══════════════════════════════════════════════════════════════════════════

  // Expected MCP tool definition shape after WU-006 expands the registry.
  // Cast via `unknown` since current ToolSchema is narrower — tests fail at
  // runtime (tools not yet registered) which is the desired red-test behavior.
  interface McpToolDef {
    name: string
    description: string
    inputSchema: {
      type: string
      properties?: Record<string, { type: string; description?: string }>
      required?: string[]
    }
  }
  const getToolDef = (name: string): McpToolDef => getToolSchema(name) as unknown as McpToolDef

  describe('AC-006-6: Tool registry schemas for health/analysis tools', () => {
    it('getRegisteredToolNames includes all 7 WU-006 tools', () => {
      const names = getRegisteredToolNames()

      expect(names).toContain('get_health_summary')
      expect(names).toContain('get_failing_jobs')
      expect(names).toContain('get_schedule_conflicts')
      expect(names).toContain('get_duration_trends')
      expect(names).toContain('analyze_schedule_load')
      expect(names).toContain('get_ui_context')
      expect(names).toContain('get_available_sessions')
    })

    it('get_health_summary schema has no required parameters', () => {
      const schema = getToolDef('get_health_summary')

      expect(schema).toBeDefined()
      expect(schema.name).toBe('get_health_summary')
      expect(schema.description).toBeTruthy()
      const required = schema.inputSchema?.required ?? []
      expect(required).toHaveLength(0)
    })

    it('get_failing_jobs schema has no required parameters', () => {
      const schema = getToolDef('get_failing_jobs')

      expect(schema).toBeDefined()
      expect(schema.name).toBe('get_failing_jobs')
      expect(schema.description).toBeTruthy()
      const required = schema.inputSchema?.required ?? []
      expect(required).toHaveLength(0)
    })

    it('get_schedule_conflicts schema has no required parameters', () => {
      const schema = getToolDef('get_schedule_conflicts')

      expect(schema).toBeDefined()
      expect(schema.name).toBe('get_schedule_conflicts')
      expect(schema.description).toBeTruthy()
      const required = schema.inputSchema?.required ?? []
      expect(required).toHaveLength(0)
    })

    it('get_duration_trends schema requires jobId string parameter', () => {
      const schema = getToolDef('get_duration_trends')

      expect(schema).toBeDefined()
      expect(schema.name).toBe('get_duration_trends')
      expect(schema.description).toBeTruthy()
      expect(schema.inputSchema?.required).toContain('jobId')
      expect(schema.inputSchema?.properties?.jobId?.type).toBe('string')
    })

    it('analyze_schedule_load schema has no required parameters', () => {
      const schema = getToolDef('analyze_schedule_load')

      expect(schema).toBeDefined()
      expect(schema.name).toBe('analyze_schedule_load')
      expect(schema.description).toBeTruthy()
      const required = schema.inputSchema?.required ?? []
      expect(required).toHaveLength(0)
    })

    it('get_ui_context schema has no required parameters', () => {
      const schema = getToolDef('get_ui_context')

      expect(schema).toBeDefined()
      expect(schema.name).toBe('get_ui_context')
      expect(schema.description).toBeTruthy()
      const required = schema.inputSchema?.required ?? []
      expect(required).toHaveLength(0)
    })

    it('get_available_sessions schema has no required parameters', () => {
      const schema = getToolDef('get_available_sessions')

      expect(schema).toBeDefined()
      expect(schema.name).toBe('get_available_sessions')
      expect(schema.description).toBeTruthy()
      const required = schema.inputSchema?.required ?? []
      expect(required).toHaveLength(0)
    })

    it('all 7 WU-006 tool schemas have description fields', () => {
      const toolNames = [
        'get_health_summary',
        'get_failing_jobs',
        'get_schedule_conflicts',
        'get_duration_trends',
        'analyze_schedule_load',
        'get_ui_context',
        'get_available_sessions',
      ]
      for (const name of toolNames) {
        const schema = getToolDef(name)
        expect(schema).toBeDefined()
        expect(typeof schema.description).toBe('string')
        expect(schema.description.length).toBeGreaterThan(10)
      }
    })

    it('all 7 WU-006 tool schemas have valid inputSchema with type "object"', () => {
      const toolNames = [
        'get_health_summary',
        'get_failing_jobs',
        'get_schedule_conflicts',
        'get_duration_trends',
        'analyze_schedule_load',
        'get_ui_context',
        'get_available_sessions',
      ]
      for (const name of toolNames) {
        const schema = getToolDef(name)
        expect(schema.inputSchema).toBeDefined()
        expect(schema.inputSchema.type).toBe('object')
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // getDurationTrends: detailed tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getDurationTrends: duration trend analysis', () => {
    it('returns stats for a given job', async () => {
      const trends = makeDurationTrendData({
        jobId: 'job-42',
        durations: [10, 12, 15, 11, 13],
        average: 12.2,
        trend: 'stable',
      })
      mockFetchResponses(() => jsonResponse(trends))

      const result = await getDurationTrends('job-42')

      expect(result.jobId).toBe('job-42')
      expect(result.durations).toHaveLength(5)
      expect(result.average).toBe(12.2)
      expect(result.trend).toBe('stable')
    })

    it('returns increasing trend when durations grow', async () => {
      const trends = makeDurationTrendData({
        jobId: 'job-slow',
        durations: [10, 20, 30, 40, 50],
        average: 30,
        trend: 'increasing',
      })
      mockFetchResponses(() => jsonResponse(trends))

      const result = await getDurationTrends('job-slow')

      expect(result.trend).toBe('increasing')
    })

    it('returns decreasing trend when durations shrink', async () => {
      const trends = makeDurationTrendData({
        jobId: 'job-fast',
        durations: [50, 40, 30, 20, 10],
        average: 30,
        trend: 'decreasing',
      })
      mockFetchResponses(() => jsonResponse(trends))

      const result = await getDurationTrends('job-fast')

      expect(result.trend).toBe('decreasing')
    })

    it('calls GET /api/cron-ai/jobs/:id/duration-trends', async () => {
      mockFetchResponses(() => jsonResponse(makeDurationTrendData()))

      await getDurationTrends('job-99')

      expect(fetchCallLog.length).toBeGreaterThanOrEqual(1)
      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/jobs/job-99/duration-trends')
      expect(lastCall.init?.method ?? 'GET').toBe('GET')
    })

    it('returns structured error when server is down', async () => {
      mockFetchResponses(() => {
        throw new Error('ECONNREFUSED')
      })

      const result = await getDurationTrends('job-1')

      expect(result).toHaveProperty('error')
    })

    it('handles job with empty duration history', async () => {
      const trends = makeDurationTrendData({
        jobId: 'job-new',
        durations: [],
        average: 0,
        trend: 'stable',
      })
      mockFetchResponses(() => jsonResponse(trends))

      const result = await getDurationTrends('job-new')

      expect(result.durations).toEqual([])
      expect(result.average).toBe(0)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // getAvailableSessions: session discovery
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getAvailableSessions: session discovery', () => {
    it('returns list of sessions', async () => {
      const sessions = [
        { id: 'sess-1', name: 'project-alpha', status: 'active' },
        { id: 'sess-2', name: 'project-beta', status: 'idle' },
      ]
      mockFetchResponses(() => jsonResponse(sessions))

      const result = await getAvailableSessions()

      expect(Array.isArray(result)).toBe(true)
      expect(result).toHaveLength(2)
    })

    it('returns empty array when no sessions exist', async () => {
      mockFetchResponses(() => jsonResponse([]))

      const result = await getAvailableSessions()

      expect(result).toEqual([])
    })

    it('calls GET /api/cron-ai/sessions', async () => {
      mockFetchResponses(() => jsonResponse([]))

      await getAvailableSessions()

      expect(fetchCallLog.length).toBeGreaterThanOrEqual(1)
      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/sessions')
      expect(lastCall.init?.method ?? 'GET').toBe('GET')
    })

    it('returns structured error when server is down', async () => {
      mockFetchResponses(() => {
        throw new Error('ECONNREFUSED')
      })

      const result = await getAvailableSessions()

      expect(result).toHaveProperty('error')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Correct HTTP endpoints for all 7 tools
  // ═══════════════════════════════════════════════════════════════════════════

  describe('HTTP endpoint correctness', () => {
    it('getHealthSummary → GET /api/cron-ai/health (no trailing slash)', async () => {
      mockFetchResponses(() => jsonResponse({ healthy: 0, warning: 0, critical: 0 }))
      await getHealthSummary()

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toMatch(/\/api\/cron-ai\/health$/)
    })

    it('getFailingJobs → GET /api/cron-ai/health/failing', async () => {
      mockFetchResponses(() => jsonResponse([]))
      await getFailingJobs()

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/health/failing')
    })

    it('getScheduleConflicts → GET /api/cron-ai/schedule/conflicts', async () => {
      mockFetchResponses(() => jsonResponse([]))
      await getScheduleConflicts()

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/schedule/conflicts')
    })

    it('getDurationTrends → GET /api/cron-ai/jobs/:id/duration-trends', async () => {
      mockFetchResponses(() => jsonResponse(makeDurationTrendData({ jobId: 'job-5' })))
      await getDurationTrends('job-5')

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/jobs/job-5/duration-trends')
    })

    it('analyzeScheduleLoad → GET /api/cron-ai/schedule/load', async () => {
      mockFetchResponses(() => jsonResponse(makeScheduleLoadAnalysis()))
      await analyzeScheduleLoad()

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/schedule/load')
    })

    it('getUiContext → GET /api/cron-ai/context', async () => {
      mockFetchResponses(() => jsonResponse(makeUiContext()))
      await getUiContext()

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/context')
    })

    it('getAvailableSessions → GET /api/cron-ai/sessions', async () => {
      mockFetchResponses(() => jsonResponse([]))
      await getAvailableSessions()

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/sessions')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Auth header propagation for WU-006 tools
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Authorization header on health/analysis tools', () => {
    it('all 7 tools pass auth header through to HTTP client', async () => {
      const origToken = process.env.AGENTBOARD_AUTH_TOKEN
      process.env.AGENTBOARD_AUTH_TOKEN = 'wu006-token'

      mockFetchResponses((url) => {
        if (url.includes('/health/failing')) return jsonResponse([])
        if (url.includes('/health')) return jsonResponse({ healthy: 0, warning: 0, critical: 0 })
        if (url.includes('/schedule/conflicts')) return jsonResponse([])
        if (url.includes('/schedule/load')) return jsonResponse(makeScheduleLoadAnalysis())
        if (url.includes('/duration-trends')) return jsonResponse(makeDurationTrendData())
        if (url.includes('/context')) return jsonResponse(makeUiContext())
        if (url.includes('/sessions')) return jsonResponse([])
        return jsonResponse({})
      })

      try {
        // Call all 7 tools sequentially, checking auth on each
        await getHealthSummary()
        expect(fetchCallLog.length).toBeGreaterThanOrEqual(1)
        let lastCall = fetchCallLog[fetchCallLog.length - 1]
        let authHeader =
          lastCall.init?.headers instanceof Headers
            ? lastCall.init.headers.get('Authorization')
            : (lastCall.init?.headers as Record<string, string>)?.['Authorization'] ??
              (lastCall.init?.headers as Record<string, string>)?.['authorization']
        expect(authHeader).toBe('Bearer wu006-token')

        await getFailingJobs()
        lastCall = fetchCallLog[fetchCallLog.length - 1]
        authHeader =
          lastCall.init?.headers instanceof Headers
            ? lastCall.init.headers.get('Authorization')
            : (lastCall.init?.headers as Record<string, string>)?.['Authorization'] ??
              (lastCall.init?.headers as Record<string, string>)?.['authorization']
        expect(authHeader).toBe('Bearer wu006-token')

        await getScheduleConflicts()
        lastCall = fetchCallLog[fetchCallLog.length - 1]
        authHeader =
          lastCall.init?.headers instanceof Headers
            ? lastCall.init.headers.get('Authorization')
            : (lastCall.init?.headers as Record<string, string>)?.['Authorization'] ??
              (lastCall.init?.headers as Record<string, string>)?.['authorization']
        expect(authHeader).toBe('Bearer wu006-token')

        await getDurationTrends('job-1')
        lastCall = fetchCallLog[fetchCallLog.length - 1]
        authHeader =
          lastCall.init?.headers instanceof Headers
            ? lastCall.init.headers.get('Authorization')
            : (lastCall.init?.headers as Record<string, string>)?.['Authorization'] ??
              (lastCall.init?.headers as Record<string, string>)?.['authorization']
        expect(authHeader).toBe('Bearer wu006-token')

        await analyzeScheduleLoad()
        lastCall = fetchCallLog[fetchCallLog.length - 1]
        authHeader =
          lastCall.init?.headers instanceof Headers
            ? lastCall.init.headers.get('Authorization')
            : (lastCall.init?.headers as Record<string, string>)?.['Authorization'] ??
              (lastCall.init?.headers as Record<string, string>)?.['authorization']
        expect(authHeader).toBe('Bearer wu006-token')

        await getUiContext()
        lastCall = fetchCallLog[fetchCallLog.length - 1]
        authHeader =
          lastCall.init?.headers instanceof Headers
            ? lastCall.init.headers.get('Authorization')
            : (lastCall.init?.headers as Record<string, string>)?.['Authorization'] ??
              (lastCall.init?.headers as Record<string, string>)?.['authorization']
        expect(authHeader).toBe('Bearer wu006-token')

        await getAvailableSessions()
        lastCall = fetchCallLog[fetchCallLog.length - 1]
        authHeader =
          lastCall.init?.headers instanceof Headers
            ? lastCall.init.headers.get('Authorization')
            : (lastCall.init?.headers as Record<string, string>)?.['Authorization'] ??
              (lastCall.init?.headers as Record<string, string>)?.['authorization']
        expect(authHeader).toBe('Bearer wu006-token')
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
  // Graceful error handling: none of the 7 tools should ever throw
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Graceful error handling: tools never throw', () => {
    it('all 7 tools return error objects instead of throwing', async () => {
      mockFetchResponses(() => {
        throw new TypeError('Failed to fetch')
      })

      const results = await Promise.allSettled([
        getHealthSummary(),
        getFailingJobs(),
        getScheduleConflicts(),
        getDurationTrends('job-1'),
        analyzeScheduleLoad(),
        getUiContext(),
        getAvailableSessions(),
      ])

      for (const r of results) {
        expect(r.status).toBe('fulfilled')
        if (r.status === 'fulfilled') {
          expect(r.value).toHaveProperty('error')
        }
      }
    })

    it('returns error on HTTP 500 for health summary', async () => {
      mockFetchResponses(() => jsonResponse({ message: 'Internal Server Error' }, 500))

      const result = await getHealthSummary()

      expect(result).toHaveProperty('error')
    })

    it('returns error on HTTP 502 for schedule conflicts', async () => {
      mockFetchResponses(() => new Response('Bad Gateway', { status: 502 }))

      const result = await getScheduleConflicts()

      expect(result).toHaveProperty('error')
    })

    it('returns error on non-JSON response for ui context', async () => {
      mockFetchResponses(
        () => new Response('<!DOCTYPE html><html>not json</html>', { status: 200 }),
      )

      const result = await getUiContext()

      expect(result).toHaveProperty('error')
    })

    it('returns error on abort for duration trends', async () => {
      mockFetchResponses(() => {
        throw new DOMException('The operation was aborted', 'AbortError')
      })

      const result = await getDurationTrends('job-1')

      expect(result).toHaveProperty('error')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Edge cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Edge cases', () => {
    it('getDurationTrends handles job IDs with special characters', async () => {
      mockFetchResponses(() => jsonResponse(makeDurationTrendData({ jobId: 'user@host/backup' })))

      await getDurationTrends('user@host/backup')

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      expect(lastCall.url).toContain('/api/cron-ai/jobs/')
      expect(lastCall.url).toContain('/duration-trends')
    })

    it('handles concurrent health tool calls without interference', async () => {
      mockFetchResponses((url) => {
        if (url.includes('/health/failing'))
          return jsonResponse([makeCronJob({ health: 'critical' })])
        if (url.includes('/health'))
          return jsonResponse({ healthy: 5, warning: 1, critical: 1 })
        if (url.includes('/schedule/conflicts'))
          return jsonResponse([makeScheduleConflict()])
        return jsonResponse({})
      })

      const [summary, failing, conflicts] = await Promise.all([
        getHealthSummary(),
        getFailingJobs(),
        getScheduleConflicts(),
      ])

      expect(summary.healthy).toBe(5)
      expect(failing).toHaveLength(1)
      expect(conflicts).toHaveLength(1)
    })

    it('schedule load handles high job density at peak hour', async () => {
      const hourlyLoad: Record<number, number> = {}
      for (let h = 0; h < 24; h++) hourlyLoad[h] = h === 0 ? 50 : 1
      const load = makeScheduleLoadAnalysis({
        hourlyLoad,
        peakHours: [0],
        recommendations: ['Hour 0 has 50 jobs — critical overload'],
      })
      mockFetchResponses(() => jsonResponse(load))

      const result = await analyzeScheduleLoad()

      expect(result.hourlyLoad[0]).toBe(50)
      expect(result.peakHours).toEqual([0])
      expect(result.recommendations[0]).toContain('50 jobs')
    })

    it('ui context with all filters active', async () => {
      const ctx = makeUiContext({
        selectedJobId: 'job-1',
        activeTab: 'logs',
        visibleJobCount: 3,
        filterState: {
          mode: 'tag',
          source: 'user-systemd',
          tags: ['backup', 'critical', 'production'],
        },
      })
      mockFetchResponses(() => jsonResponse(ctx))

      const result = await getUiContext()

      expect(result.filterState.tags).toHaveLength(3)
      expect(result.filterState.mode).toBe('tag')
      expect(result.visibleJobCount).toBe(3)
    })

    it('getHealthSummary handles large job counts', async () => {
      const summary = { healthy: 9999, warning: 500, critical: 1 }
      mockFetchResponses(() => jsonResponse(summary))

      const result = await getHealthSummary()

      expect(result.healthy).toBe(9999)
      expect(result.warning).toBe(500)
      expect(result.critical).toBe(1)
    })

    it('getDurationTrends handles single data point', async () => {
      const trends = makeDurationTrendData({
        jobId: 'job-new',
        durations: [42],
        average: 42,
        trend: 'stable',
      })
      mockFetchResponses(() => jsonResponse(trends))

      const result = await getDurationTrends('job-new')

      expect(result.durations).toHaveLength(1)
      expect(result.average).toBe(42)
    })

    it('retries on 5xx for health tools', async () => {
      let callCount = 0
      mockFetchResponses(() => {
        callCount++
        if (callCount < 3) return jsonResponse({ error: 'server error' }, 503)
        return jsonResponse({ healthy: 1, warning: 0, critical: 0 })
      })

      const result = await getHealthSummary()

      expect(callCount).toBe(3)
      expect(result.healthy).toBe(1)
    })

    it('does NOT retry on 404 for getDurationTrends', async () => {
      let callCount = 0
      mockFetchResponses(() => {
        callCount++
        return jsonResponse({ error: 'not found' }, 404)
      })

      const result = await getDurationTrends('nonexistent-job')

      expect(callCount).toBe(1)
      expect(result).toHaveProperty('error')
    })

    it('getDurationTrends URL-encodes special characters in jobId', async () => {
      mockFetchResponses(() => jsonResponse(makeDurationTrendData({ jobId: 'user@host/backup' })))

      await getDurationTrends('user@host/backup')

      const lastCall = fetchCallLog[fetchCallLog.length - 1]
      // The raw slash and @ should be encoded in the URL path
      expect(lastCall.url).toContain(encodeURIComponent('user@host/backup'))
      expect(lastCall.url).toContain('/duration-trends')
    })

    it('getAvailableSessions returns realistic Session objects', async () => {
      const sessions: Partial<Session>[] = [
        {
          id: 'sess-1',
          name: 'project-alpha',
          tmuxWindow: 'agentboard:1',
          projectPath: '/home/user/projects/alpha',
          status: 'working',
          lastActivity: '2026-02-25T10:00:00Z',
          createdAt: '2026-02-25T09:00:00Z',
          source: 'external',
        },
        {
          id: 'sess-2',
          name: 'project-beta',
          tmuxWindow: 'agentboard:2',
          projectPath: '/home/user/projects/beta',
          status: 'waiting',
          lastActivity: '2026-02-25T10:30:00Z',
          createdAt: '2026-02-25T08:00:00Z',
          source: 'external',
        },
      ]
      mockFetchResponses(() => jsonResponse(sessions))

      const result = await getAvailableSessions()

      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('sess-1')
      expect(result[0].name).toBe('project-alpha')
      expect(result[1].status).toBe('waiting')
    })

    it('no auth header sent when AGENTBOARD_AUTH_TOKEN is empty', async () => {
      const origToken = process.env.AGENTBOARD_AUTH_TOKEN
      process.env.AGENTBOARD_AUTH_TOKEN = ''

      mockFetchResponses(() => jsonResponse({ healthy: 1, warning: 0, critical: 0 }))

      try {
        await getHealthSummary()

        const lastCall = fetchCallLog[fetchCallLog.length - 1]
        const headers = lastCall.init?.headers as Record<string, string> | undefined
        expect(headers?.['Authorization']).toBeUndefined()
      } finally {
        if (origToken !== undefined) {
          process.env.AGENTBOARD_AUTH_TOKEN = origToken
        } else {
          delete process.env.AGENTBOARD_AUTH_TOKEN
        }
      }
    })

    it('getFailingJobs does not include healthy or unknown jobs', async () => {
      // Server should filter, but verify the contract: only warning/critical
      const jobs = [
        makeCronJob({ id: 'j1', health: 'warning', healthReason: 'Slow' }),
        makeCronJob({ id: 'j2', health: 'critical', healthReason: 'Down' }),
      ]
      mockFetchResponses(() => jsonResponse(jobs))

      const result = await getFailingJobs()

      for (const job of result) {
        expect(job.health).not.toBe('healthy')
        expect(job.health).not.toBe('unknown')
      }
    })

    it('getScheduleConflicts handles conflict with >2 jobs', async () => {
      const conflict = makeScheduleConflict({
        jobIds: ['a', 'b', 'c', 'd'],
        schedule: '*/5 * * * *',
        description: '4 jobs all run every 5 minutes',
      })
      mockFetchResponses(() => jsonResponse([conflict]))

      const result = await getScheduleConflicts()

      expect(result[0].jobIds).toHaveLength(4)
      expect(result[0].description).toContain('4 jobs')
    })

    it('analyzeScheduleLoad with all hours at zero', async () => {
      const load = makeScheduleLoadAnalysis()
      // default fixture has all hours = 0
      mockFetchResponses(() => jsonResponse(load))

      const result = await analyzeScheduleLoad()

      const totalJobs = (Object.values(result.hourlyLoad) as number[]).reduce((a, b) => a + b, 0)
      expect(totalJobs).toBe(0)
      expect(result.peakHours).toEqual([])
    })
  })
})
