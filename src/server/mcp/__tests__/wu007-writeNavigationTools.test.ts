// WU-007: MCP Server Write & Navigation Tools Tests
// Tests propose_change (HTTP long-poll write tool) and 4 navigation tools (WS messages).
//
// AC-007-1: propose_change sends HTTP POST to /api/cron-ai/proposals, blocks until response
// AC-007-2: On accept → {success: true, result}. On reject → {success: false, rejected, feedback}. On timeout → {success: false, expired}
// AC-007-3: select_job sends correct navigation WS message
// AC-007-4: navigate_to_tab accepts 'overview'|'history'|'logs'|'script', sends correct WS message
// AC-007-5: show_timeline sends navigation WS message to open the timeline
// AC-007-6: filter_jobs sends navigation WS message with filter object
// AC-007-7: propose_change tool schema validates operation enum, requires description, correct details schema
//
// Strategy: Mock globalThis.fetch for proposeChange HTTP calls. For navigation tools,
// we test both the success case (with mocked WS) and failure case (disconnected WS).
// Tests MUST fail against stub implementation.

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import type { ProposalResult, CronAiProposalOperation } from '@shared/types'

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

// ─── WebSocket Mock Infrastructure ─────────────────────────────────────────────

interface MockWebSocket {
  send: ReturnType<typeof mock>
  close: ReturnType<typeof mock>
  readyState: number
  onopen: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: Event) => void) | null
}

let mockWsInstances: MockWebSocket[] = []
let originalWebSocket: typeof globalThis.WebSocket
let capturedWsMessages: unknown[] = []

function setupWsMock(): void {
  capturedWsMessages = []
  mockWsInstances = []
  originalWebSocket = globalThis.WebSocket

  class MockWebSocketImpl {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    readyState = MockWebSocketImpl.OPEN
    onopen: ((event: Event) => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null

    send = mock((data: string) => {
      capturedWsMessages.push(JSON.parse(data))
    })

    close = mock(() => {
      this.readyState = MockWebSocketImpl.CLOSED
    })

    constructor(_url: string | URL) {
      mockWsInstances.push(this as unknown as MockWebSocket)
      // Simulate immediate connection
      setTimeout(() => {
        this.readyState = MockWebSocketImpl.OPEN
        this.onopen?.(new Event('open'))
      }, 0)
    }
  }

  globalThis.WebSocket = MockWebSocketImpl as unknown as typeof globalThis.WebSocket
}

function teardownWsMock(): void {
  globalThis.WebSocket = originalWebSocket
  capturedWsMessages = []
  mockWsInstances = []
}

/**
 * Simulates a connected WebSocket by triggering the onopen callback.
 * Returns the captured messages for verification.
 */
async function simulateConnectedWs(): Promise<void> {
  // Wait for mock WS to "connect"
  await new Promise((resolve) => setTimeout(resolve, 10))
}

function getLastWsMessage(): unknown {
  return capturedWsMessages[capturedWsMessages.length - 1]
}

// ─── Module Under Test ──────────────────────────────────────────────────────

import {
  getRegisteredToolNames,
  getToolSchema,
  proposeChange,
  selectJob,
  navigateToTab,
  showTimeline,
  filterJobs,
  sendWsMessage,
  connectWebSocket,
} from '../cronMcpServer'

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('WU-007: MCP Server Write & Navigation Tools', () => {
  beforeEach(() => {
    setupFetchMock()
    process.env.AGENTBOARD_URL = 'http://test-host:4040'
    process.env.AGENTBOARD_AUTH_TOKEN = 'test-token-abc'
  })

  afterEach(() => {
    teardownFetchMock()
    teardownWsMock()
    delete process.env.AGENTBOARD_AUTH_TOKEN
    delete process.env.AGENTBOARD_URL
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-007-7: propose_change tool schema validates operation enum, requires
  //           description, and has correct details schema
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Tool Registry — schema validation (AC-007-7)', () => {
    it('registers propose_change tool in the tool registry', () => {
      const names = getRegisteredToolNames()
      expect(names).toContain('propose_change')
    })

    it('propose_change schema requires "description" field', () => {
      const schema = getToolSchema('propose_change')
      expect(schema.inputSchema.required).toContain('description')
    })

    it('propose_change schema requires "operation" field', () => {
      const schema = getToolSchema('propose_change')
      expect(schema.inputSchema.required).toContain('operation')
    })

    it('propose_change schema has operation property with enum of valid operations', () => {
      const schema = getToolSchema('propose_change')
      const opProp = schema.inputSchema.properties['operation'] as Record<string, unknown>
      expect(opProp).toBeDefined()
      const validOps: CronAiProposalOperation[] = [
        'create', 'edit_frequency', 'pause', 'resume',
        'delete', 'run_now', 'set_tags', 'link_session',
      ]
      expect(opProp.enum).toBeDefined()
      for (const op of validOps) {
        expect((opProp.enum as string[])).toContain(op)
      }
    })

    it('propose_change schema has description property of type string', () => {
      const schema = getToolSchema('propose_change')
      const descProp = schema.inputSchema.properties['description']
      expect(descProp).toBeDefined()
      expect(descProp.type).toBe('string')
    })

    it('propose_change schema has optional jobId property', () => {
      const schema = getToolSchema('propose_change')
      const jobIdProp = schema.inputSchema.properties['jobId']
      expect(jobIdProp).toBeDefined()
      // jobId should not be in required (it's optional for 'create' operations)
      if (schema.inputSchema.required) {
        expect(schema.inputSchema.required).not.toContain('jobId')
      }
    })

    it('propose_change schema has optional details property', () => {
      const schema = getToolSchema('propose_change')
      const detailsProp = schema.inputSchema.properties['details']
      expect(detailsProp).toBeDefined()
      expect(detailsProp.type).toBe('object')
    })

    it('registers select_job tool with jobId required', () => {
      const schema = getToolSchema('select_job')
      expect(schema.inputSchema.required).toContain('jobId')
      expect(schema.inputSchema.properties['jobId']).toBeDefined()
    })

    it('registers navigate_to_tab tool with tab required', () => {
      const schema = getToolSchema('navigate_to_tab')
      expect(schema.inputSchema.required).toContain('tab')
      expect(schema.inputSchema.properties['tab']).toBeDefined()
    })

    it('registers show_timeline tool with no required params', () => {
      const schema = getToolSchema('show_timeline')
      expect(schema.inputSchema.properties).toBeDefined()
      // No required fields — it's a zero-arg tool
      if (schema.inputSchema.required) {
        expect(schema.inputSchema.required.length).toBe(0)
      }
    })

    it('registers filter_jobs tool with filter required', () => {
      const schema = getToolSchema('filter_jobs')
      expect(schema.inputSchema.required).toContain('filter')
      expect(schema.inputSchema.properties['filter']).toBeDefined()
    })

    it('all 5 WU-007 tools are registered', () => {
      const names = getRegisteredToolNames()
      expect(names).toContain('propose_change')
      expect(names).toContain('select_job')
      expect(names).toContain('navigate_to_tab')
      expect(names).toContain('show_timeline')
      expect(names).toContain('filter_jobs')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-007-1: propose_change sends HTTP POST to /api/cron-ai/proposals
  //           with {operation, jobId?, description, details}. Does NOT return
  //           until HTTP response is received.
  // ═══════════════════════════════════════════════════════════════════════════

  describe('proposeChange — HTTP POST & blocking (AC-007-1)', () => {
    it('sends POST to /api/cron-ai/proposals', async () => {
      const acceptResult: ProposalResult = { success: true, result: { id: 'prop-1' } }
      queueSuccess(acceptResult)

      await proposeChange({
        operation: 'pause',
        jobId: 'job-1',
        description: 'Pause the backup job',
      })

      expect(capturedFetches.length).toBeGreaterThanOrEqual(1)
      const req = capturedFetches[0]
      expect(req.method).toBe('POST')
      expect(req.url).toContain('/api/cron-ai/proposals')
    })

    it('sends correct proposal body with operation, jobId, and description', async () => {
      const acceptResult: ProposalResult = { success: true }
      queueSuccess(acceptResult)

      await proposeChange({
        operation: 'pause',
        jobId: 'job-1',
        description: 'Pause the backup job',
      })

      const req = capturedFetches[0]
      expect(req.body).toBeDefined()
      expect(req.body).toHaveProperty('operation', 'pause')
      expect(req.body).toHaveProperty('jobId', 'job-1')
      expect(req.body).toHaveProperty('description', 'Pause the backup job')
    })

    it('sends details in the proposal body when provided', async () => {
      const acceptResult: ProposalResult = { success: true }
      queueSuccess(acceptResult)

      await proposeChange({
        operation: 'edit_frequency',
        jobId: 'job-2',
        description: 'Change frequency to daily',
        details: { newSchedule: '0 0 * * *' },
      })

      const req = capturedFetches[0]
      expect(req.body).toHaveProperty('details')
      expect((req.body as Record<string, unknown>).details).toEqual({ newSchedule: '0 0 * * *' })
    })

    it('includes Authorization header when token is set', async () => {
      queueSuccess({ success: true })

      await proposeChange({
        operation: 'resume',
        jobId: 'job-1',
        description: 'Resume the job',
      })

      const req = capturedFetches[0]
      const auth = req.headers['Authorization'] || req.headers['authorization']
      expect(auth).toBe('Bearer test-token-abc')
    })

    it('blocks until the HTTP response is received — does not resolve early', async () => {
      // Simulate a delayed response by using a promise-based fetch mock
      let resolveResponse!: (value: unknown) => void
      const delayedPromise = new Promise((resolve) => { resolveResponse = resolve })

      // Replace the fetch mock with a delayed version for this test
      const prevFetch = globalThis.fetch
      let fetchCalled = false
      globalThis.fetch = (async () => {
        fetchCalled = true
        await delayedPromise
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof globalThis.fetch

      let proposeResolved = false
      const promise = proposeChange({
        operation: 'pause',
        jobId: 'job-1',
        description: 'Pause job',
      }).then((result) => {
        proposeResolved = true
        return result
      })

      // Give microtasks a chance to settle
      await new Promise((r) => setTimeout(r, 10))

      // fetch should have been called, but proposeChange should NOT have resolved yet
      expect(fetchCalled).toBe(true)
      expect(proposeResolved).toBe(false)

      // Now resolve the HTTP response
      resolveResponse(undefined)
      const result = await promise
      expect(proposeResolved).toBe(true)
      expect(result).toBeDefined()

      globalThis.fetch = prevFetch
    })

    it('sends Content-Type: application/json header', async () => {
      queueSuccess({ success: true })

      await proposeChange({
        operation: 'delete',
        jobId: 'job-3',
        description: 'Delete unused job',
      })

      const req = capturedFetches[0]
      const contentType = req.headers['Content-Type'] || req.headers['content-type']
      expect(contentType).toBe('application/json')
    })

    it('sends jobId as undefined when not provided (create operation)', async () => {
      queueSuccess({ success: true, result: { id: 'new-job' } })

      await proposeChange({
        operation: 'create',
        description: 'Create a new nightly backup job',
        details: { schedule: '0 2 * * *', command: '/usr/bin/backup.sh' },
      })

      const req = capturedFetches[0]
      const body = req.body as Record<string, unknown>
      // jobId should be undefined for create operations (not sent in body)
      expect(body.jobId).toBeUndefined()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-007-2: Response shapes for accept, reject, timeout
  // ═══════════════════════════════════════════════════════════════════════════

  describe('proposeChange — accept response (AC-007-2)', () => {
    it('returns {success: true, result: ...} on accept', async () => {
      queueSuccess({ success: true, result: { id: 'prop-42', mutationApplied: true } })

      const result = await proposeChange({
        operation: 'pause',
        jobId: 'job-1',
        description: 'Pause the backup job',
      })

      expect(result.success).toBe(true)
      expect(result.result).toBeDefined()
      expect(result.rejected).toBeUndefined()
      expect(result.expired).toBeUndefined()
    })

    it('returns result payload from the server on accept', async () => {
      const serverResult = { id: 'prop-99', mutationApplied: true, newSchedule: '0 0 * * *' }
      queueSuccess({ success: true, result: serverResult })

      const result = await proposeChange({
        operation: 'edit_frequency',
        jobId: 'job-2',
        description: 'Change to daily',
        details: { newSchedule: '0 0 * * *' },
      })

      expect(result.success).toBe(true)
      expect(result.result).toEqual(serverResult)
    })
  })

  describe('proposeChange — reject response (AC-007-2)', () => {
    it('returns {success: false, rejected: true, feedback: string} on reject', async () => {
      queueSuccess({
        success: false,
        rejected: true,
        feedback: 'This job is critical, do not pause it',
      })

      const result = await proposeChange({
        operation: 'pause',
        jobId: 'job-1',
        description: 'Pause the backup job',
      })

      expect(result.success).toBe(false)
      expect(result.rejected).toBe(true)
      expect(result.feedback).toBe('This job is critical, do not pause it')
      expect(result.expired).toBeUndefined()
    })

    it('returns feedback string so the agent can adjust its approach', async () => {
      queueSuccess({
        success: false,
        rejected: true,
        feedback: 'Change the schedule to every 6 hours instead',
      })

      const result = await proposeChange({
        operation: 'edit_frequency',
        jobId: 'job-2',
        description: 'Change to daily',
      })

      expect(typeof result.feedback).toBe('string')
      expect(result.feedback!.length).toBeGreaterThan(0)
    })
  })

  describe('proposeChange — timeout response (AC-007-2)', () => {
    it('returns {success: false, expired: true} on timeout', async () => {
      queueSuccess({ success: false, expired: true })

      const result = await proposeChange({
        operation: 'run_now',
        jobId: 'job-1',
        description: 'Run the backup job immediately',
      })

      expect(result.success).toBe(false)
      expect(result.expired).toBe(true)
      expect(result.rejected).toBeUndefined()
    })

    it('does not include feedback on timeout', async () => {
      queueSuccess({ success: false, expired: true })

      const result = await proposeChange({
        operation: 'delete',
        jobId: 'job-3',
        description: 'Delete old job',
      })

      expect(result.expired).toBe(true)
      expect(result.feedback).toBeUndefined()
    })
  })

  describe('proposeChange — error handling', () => {
    it('returns structured error when server returns 4xx', async () => {
      queueSuccess({ error: 'Invalid proposal: missing description' }, 400)

      const result = await proposeChange({
        operation: 'pause',
        jobId: 'job-1',
        description: '',
      })

      // Should return a structured error, not throw
      expect(result).toBeDefined()
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('returns structured error when server returns 500', async () => {
      // Queue 3 retries worth of 500 responses (retry logic from fetchFromAgentboard)
      queueSuccess({ error: 'Internal error' }, 500)
      queueSuccess({ error: 'Internal error' }, 500)
      queueSuccess({ error: 'Internal error' }, 500)

      const result = await proposeChange({
        operation: 'pause',
        jobId: 'job-1',
        description: 'Pause backup',
      })

      expect(result).toBeDefined()
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('returns structured error on network failure', async () => {
      queueNetworkError()
      queueNetworkError()
      queueNetworkError()

      const result = await proposeChange({
        operation: 'resume',
        jobId: 'job-1',
        description: 'Resume job',
      })

      expect(result).toBeDefined()
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-007-1 + TEST-ID: create-proposal
  // propose_change with operation 'create' includes full job config
  // ═══════════════════════════════════════════════════════════════════════════

  describe('proposeChange — create operation (create-proposal)', () => {
    it('sends create proposal with full job config in details', async () => {
      queueSuccess({ success: true, result: { id: 'new-job-1' } })

      const details = {
        schedule: '0 2 * * *',
        command: '/usr/local/bin/nightly-backup.sh',
        description: 'Nightly backup at 2 AM',
        projectGroup: 'backups',
        tags: ['backup', 'nightly'],
      }

      await proposeChange({
        operation: 'create',
        description: 'Create nightly backup job',
        details,
      })

      const req = capturedFetches[0]
      const body = req.body as Record<string, unknown>
      expect(body.operation).toBe('create')
      expect(body.details).toEqual(details)
      expect(body.description).toBe('Create nightly backup job')
    })

    it('create operation does not require jobId', async () => {
      queueSuccess({ success: true, result: { id: 'new-job-2' } })

      const result = await proposeChange({
        operation: 'create',
        description: 'Create a new monitoring job',
        details: { schedule: '*/5 * * * *', command: 'healthcheck.sh' },
      })

      // Should succeed without jobId
      expect(result.success).toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-007-3: select_job sends correct navigation WS message
  // ═══════════════════════════════════════════════════════════════════════════

  describe('selectJob — WS navigation (AC-007-3)', () => {
    describe('when WebSocket is connected', () => {
      beforeEach(async () => {
        setupWsMock()
        connectWebSocket()
        await simulateConnectedWs()
      })

      it('sends WS message with type cron-ai-navigate, action select_job, and jobId', async () => {
        const result = await selectJob('job-42')

        expect(result).toBeDefined()
        expect(result.success).toBe(true)

        const msg = getLastWsMessage() as Record<string, unknown>
        expect(msg.type).toBe('cron-ai-navigate')
        expect(msg.action).toBe('select_job')
        expect(msg.payload).toEqual({ jobId: 'job-42' })
      })

      it('returns {success: true} when message is sent successfully', async () => {
        const result = await selectJob('job-1')
        expect(result).toEqual({ success: true })
      })

      it('accepts various job ID formats', async () => {
        const result1 = await selectJob('job-1')
        expect(result1.success).toBe(true)

        const result2 = await selectJob('user-crontab-daily-backup-abc123')
        expect(result2.success).toBe(true)

        const result3 = await selectJob('timer://systemd/apt-daily.timer')
        expect(result3.success).toBe(true)

        // Verify the last message has the correct format
        const lastMsg = getLastWsMessage() as Record<string, unknown>
        expect(lastMsg.payload).toEqual({ jobId: 'timer://systemd/apt-daily.timer' })
      })
    })

    describe('when WebSocket is NOT connected', () => {
      it('returns {success: false, error: "WebSocket not connected"}', async () => {
        // Don't setup WS mock or connect - simulate disconnected state
        const result = await selectJob('job-1')

        expect(result.success).toBe(false)
        expect(result.error).toBe('WebSocket not connected')
      })
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-007-4: navigate_to_tab accepts specific tabs, sends correct WS message
  // ═══════════════════════════════════════════════════════════════════════════

  describe('navigateToTab — WS navigation (AC-007-4)', () => {
    describe('when WebSocket is connected', () => {
      beforeEach(async () => {
        setupWsMock()
        connectWebSocket()
        await simulateConnectedWs()
      })

      it('sends correct WS message for overview tab', async () => {
        const result = await navigateToTab('overview')

        expect(result.success).toBe(true)
        const msg = getLastWsMessage() as Record<string, unknown>
        expect(msg.type).toBe('cron-ai-navigate')
        expect(msg.action).toBe('switch_tab')
        expect(msg.payload).toEqual({ tab: 'overview' })
      })

      it('sends correct WS message for history tab', async () => {
        const result = await navigateToTab('history')

        expect(result.success).toBe(true)
        const msg = getLastWsMessage() as Record<string, unknown>
        expect(msg.payload).toEqual({ tab: 'history' })
      })

      it('sends correct WS message for logs tab', async () => {
        const result = await navigateToTab('logs')

        expect(result.success).toBe(true)
        const msg = getLastWsMessage() as Record<string, unknown>
        expect(msg.payload).toEqual({ tab: 'logs' })
      })

      it('sends correct WS message for script tab', async () => {
        const result = await navigateToTab('script')

        expect(result.success).toBe(true)
        const msg = getLastWsMessage() as Record<string, unknown>
        expect(msg.payload).toEqual({ tab: 'script' })
      })

      it('all four valid tabs return success', async () => {
        const validTabs = ['overview', 'history', 'logs', 'script'] as const
        for (const tab of validTabs) {
          const result = await navigateToTab(tab)
          expect(result.success).toBe(true)
        }
      })
    })

    describe('when WebSocket is NOT connected', () => {
      it('returns {success: false, error: "WebSocket not connected"}', async () => {
        const result = await navigateToTab('overview')

        expect(result.success).toBe(false)
        expect(result.error).toBe('WebSocket not connected')
      })
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-007-5: show_timeline sends WS message to open the timeline
  // ═══════════════════════════════════════════════════════════════════════════

  describe('showTimeline — WS navigation (AC-007-5)', () => {
    describe('when WebSocket is connected', () => {
      beforeEach(async () => {
        setupWsMock()
        connectWebSocket()
        await simulateConnectedWs()
      })

      it('sends WS message with action show_timeline', async () => {
        const result = await showTimeline()

        expect(result.success).toBe(true)
        const msg = getLastWsMessage() as Record<string, unknown>
        expect(msg.type).toBe('cron-ai-navigate')
        expect(msg.action).toBe('show_timeline')
        expect(msg.payload).toEqual({})
      })

      it('returns {success: true} on successful send', async () => {
        const result = await showTimeline()
        expect(result).toEqual({ success: true })
      })
    })

    describe('when WebSocket is NOT connected', () => {
      it('returns {success: false, error: "WebSocket not connected"}', async () => {
        const result = await showTimeline()

        expect(result.success).toBe(false)
        expect(result.error).toBe('WebSocket not connected')
      })
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-007-6: filter_jobs sends WS message with filter object
  // ═══════════════════════════════════════════════════════════════════════════

  describe('filterJobs — WS navigation (AC-007-6)', () => {
    describe('when WebSocket is connected', () => {
      beforeEach(async () => {
        setupWsMock()
        connectWebSocket()
        await simulateConnectedWs()
      })

      it('sends WS message with action filter and the filter object', async () => {
        const filter = { mode: 'failing', source: null, tags: [] }
        const result = await filterJobs(filter)

        expect(result.success).toBe(true)
        const msg = getLastWsMessage() as Record<string, unknown>
        expect(msg.type).toBe('cron-ai-navigate')
        expect(msg.action).toBe('filter')
        expect(msg.payload).toEqual({ filter })
      })

      it('supports filtering by source', async () => {
        const filter = { mode: 'all', source: 'user-crontab', tags: [] }
        const result = await filterJobs(filter)

        expect(result.success).toBe(true)
        const msg = getLastWsMessage() as Record<string, unknown>
        expect((msg.payload as Record<string, unknown>).filter).toEqual(filter)
      })

      it('supports filtering by tags', async () => {
        const filter = { mode: 'all', source: null, tags: ['backup', 'critical'] }
        const result = await filterJobs(filter)

        expect(result.success).toBe(true)
        const msg = getLastWsMessage() as Record<string, unknown>
        expect((msg.payload as Record<string, unknown>).filter).toEqual(filter)
      })

      it('supports complex filter with multiple criteria', async () => {
        const filter = {
          mode: 'active',
          source: 'systemd',
          tags: ['monitoring'],
          search: 'health',
        }
        const result = await filterJobs(filter)

        expect(result.success).toBe(true)
        const msg = getLastWsMessage() as Record<string, unknown>
        expect((msg.payload as Record<string, unknown>).filter).toEqual(filter)
      })

      it('passes the exact filter object to the WS message', async () => {
        const filter = { mode: 'failing', source: 'user-crontab', tags: ['backup'] }
        const result = await filterJobs(filter)

        expect(result.success).toBe(true)
        const msg = getLastWsMessage() as Record<string, unknown>
        // Verify the filter is passed through as-is
        expect((msg.payload as Record<string, unknown>).filter).toEqual(filter)
      })
    })

    describe('when WebSocket is NOT connected', () => {
      it('returns {success: false, error: "WebSocket not connected"}', async () => {
        const result = await filterJobs({ mode: 'all' })

        expect(result.success).toBe(false)
        expect(result.error).toBe('WebSocket not connected')
      })
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // sendWsMessage — direct behavior tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('sendWsMessage — direct behavior', () => {
    it('returns false when WebSocket is not connected', () => {
      // WS starts disconnected; sendWsMessage should indicate send failure
      const sent = sendWsMessage({ type: 'cron-ai-navigate', action: 'test', payload: {} })
      expect(sent).toBe(false)
    })

    it('accepts a properly shaped navigation message object', () => {
      // Should not throw even when WS is disconnected
      expect(() => {
        sendWsMessage({ type: 'cron-ai-navigate', action: 'select_job', payload: { jobId: 'j-1' } })
      }).not.toThrow()
    })

    describe('when WebSocket is connected', () => {
      beforeEach(async () => {
        setupWsMock()
        connectWebSocket()
        await simulateConnectedWs()
      })

      it('returns true when WebSocket IS connected and message is sent', () => {
        const sent = sendWsMessage({ type: 'cron-ai-navigate', action: 'test', payload: {} })
        expect(sent).toBe(true)
      })

      it('sends JSON-stringified message via WebSocket', () => {
        const msg = { type: 'test', data: { foo: 'bar' } }
        sendWsMessage(msg)

        expect(capturedWsMessages.length).toBeGreaterThan(0)
        expect(capturedWsMessages[capturedWsMessages.length - 1]).toEqual(msg)
      })
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // proposeChange — all valid operation types
  // ═══════════════════════════════════════════════════════════════════════════

  describe('proposeChange — all operation types', () => {
    const operations: Array<{ op: CronAiProposalOperation; needsJobId: boolean; details?: Record<string, unknown> }> = [
      { op: 'create', needsJobId: false, details: { schedule: '0 * * * *', command: 'echo test' } },
      { op: 'edit_frequency', needsJobId: true, details: { newSchedule: '0 0 * * *' } },
      { op: 'pause', needsJobId: true },
      { op: 'resume', needsJobId: true },
      { op: 'delete', needsJobId: true },
      { op: 'run_now', needsJobId: true },
      { op: 'set_tags', needsJobId: true, details: { tags: ['backup'] } },
      { op: 'link_session', needsJobId: true, details: { sessionId: 'sess-1' } },
    ]

    for (const { op, needsJobId, details } of operations) {
      it(`sends correct proposal for operation: ${op}`, async () => {
        queueSuccess({ success: true, result: { applied: true } })

        const result = await proposeChange({
          operation: op,
          jobId: needsJobId ? 'job-1' : undefined,
          description: `Test ${op} operation`,
          details,
        })

        expect(result.success).toBe(true)
        const req = capturedFetches[capturedFetches.length - 1]
        expect(req.body).toHaveProperty('operation', op)
        // Reset for next iteration
        capturedFetches.length = 0
      })
    }
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Edge cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Edge cases', () => {
    it('proposeChange handles empty details object', async () => {
      queueSuccess({ success: true })

      const result = await proposeChange({
        operation: 'pause',
        jobId: 'job-1',
        description: 'Pause job',
        details: {},
      })

      expect(result.success).toBe(true)
    })

    it('proposeChange handles special characters in description', async () => {
      queueSuccess({ success: true })

      const result = await proposeChange({
        operation: 'edit_frequency',
        jobId: 'job-1',
        description: 'Change schedule to "0 */6 * * *" for <backup> & restore',
      })

      expect(result.success).toBe(true)
      const body = capturedFetches[0].body as Record<string, unknown>
      expect(body.description).toBe('Change schedule to "0 */6 * * *" for <backup> & restore')
    })

    it('proposeChange handles special characters in jobId', async () => {
      queueSuccess({ success: true })

      await proposeChange({
        operation: 'pause',
        jobId: 'timer://systemd/apt-daily.timer',
        description: 'Pause apt timer',
      })

      const body = capturedFetches[0].body as Record<string, unknown>
      expect(body.jobId).toBe('timer://systemd/apt-daily.timer')
    })

    it('navigation tools do not make HTTP calls (WS only)', async () => {
      setupWsMock()
      connectWebSocket()
      await simulateConnectedWs()

      // Navigation tools should use WS, not HTTP
      await selectJob('job-1')
      expect(capturedFetches.length).toBe(0)

      await navigateToTab('overview')
      expect(capturedFetches.length).toBe(0)

      await showTimeline()
      expect(capturedFetches.length).toBe(0)

      await filterJobs({ mode: 'all' })
      expect(capturedFetches.length).toBe(0)
    })

    it('proposeChange uses POST method, not GET', async () => {
      queueSuccess({ success: true })

      await proposeChange({
        operation: 'pause',
        jobId: 'job-1',
        description: 'Pause',
      })

      expect(capturedFetches[0].method).toBe('POST')
    })

    it('proposeChange constructs URL from AGENTBOARD_URL env var', async () => {
      process.env.AGENTBOARD_URL = 'http://custom-host:9999'
      queueSuccess({ success: true })

      await proposeChange({
        operation: 'pause',
        jobId: 'job-1',
        description: 'Pause job',
      })

      const req = capturedFetches[0]
      expect(req.url).toContain('http://custom-host:9999')
      expect(req.url).toContain('/api/cron-ai/proposals')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // navigate_to_tab schema — tab enum validation (AC-007-4)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('navigate_to_tab schema — tab enum (AC-007-4)', () => {
    it('tab property has enum restricting to valid tab names', () => {
      const schema = getToolSchema('navigate_to_tab')
      const tabProp = schema.inputSchema.properties['tab'] as Record<string, unknown>
      expect(tabProp).toBeDefined()
      expect(tabProp.enum).toBeDefined()
      expect(tabProp.enum).toContain('overview')
      expect(tabProp.enum).toContain('history')
      expect(tabProp.enum).toContain('logs')
      expect(tabProp.enum).toContain('script')
    })

    it('tab enum has exactly 4 valid values', () => {
      const schema = getToolSchema('navigate_to_tab')
      const tabProp = schema.inputSchema.properties['tab'] as Record<string, unknown>
      expect(tabProp.enum).toBeDefined()
      expect((tabProp.enum as string[]).length).toBe(4)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // filter_jobs schema — filter property type (AC-007-6)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('filter_jobs schema — filter property (AC-007-6)', () => {
    it('filter property has type object', () => {
      const schema = getToolSchema('filter_jobs')
      const filterProp = schema.inputSchema.properties['filter'] as Record<string, unknown>
      expect(filterProp).toBeDefined()
      expect(filterProp.type).toBe('object')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // WS Connection Lifecycle Tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('WebSocket connection lifecycle', () => {
    it('connectWebSocket establishes a WebSocket connection', async () => {
      setupWsMock()
      connectWebSocket()
      await simulateConnectedWs()

      expect(mockWsInstances.length).toBe(1)
    })

    it('connectWebSocket sends cron-ai-mcp-register handshake on connect', async () => {
      setupWsMock()
      process.env.AGENTBOARD_AUTH_TOKEN = 'test-token-xyz'
      connectWebSocket()
      await simulateConnectedWs()

      // The handshake message should be sent on connect
      const handshakeMsg = capturedWsMessages[0] as Record<string, unknown>
      expect(handshakeMsg.type).toBe('cron-ai-mcp-register')
      expect(handshakeMsg.authToken).toBe('test-token-xyz')
    })

    it('connectWebSocket sends handshake without token when AUTH_TOKEN is not set', async () => {
      setupWsMock()
      delete process.env.AGENTBOARD_AUTH_TOKEN
      connectWebSocket()
      await simulateConnectedWs()

      const handshakeMsg = capturedWsMessages[0] as Record<string, unknown>
      expect(handshakeMsg.type).toBe('cron-ai-mcp-register')
      expect(handshakeMsg.authToken).toBeUndefined()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST-IDs from work unit spec
  // ═══════════════════════════════════════════════════════════════════════════

  describe('TEST-ID: propose-change-blocking (TEST-18, TEST-22)', () => {
    it('proposeChange blocks until HTTP response received (does not resolve early)', async () => {
      let resolveResponse!: (value: unknown) => void
      const delayedPromise = new Promise((resolve) => { resolveResponse = resolve })

      const prevFetch = globalThis.fetch
      let fetchCalled = false
      globalThis.fetch = (async () => {
        fetchCalled = true
        await delayedPromise
        return new Response(JSON.stringify({ success: true, result: { id: 'prop-1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof globalThis.fetch

      let proposeResolved = false
      const promise = proposeChange({
        operation: 'pause',
        jobId: 'job-1',
        description: 'Pause job',
      }).then((r) => {
        proposeResolved = true
        return r
      })

      await new Promise((r) => setTimeout(r, 10))
      expect(fetchCalled).toBe(true)
      expect(proposeResolved).toBe(false)

      resolveResponse(undefined)
      const result = await promise
      expect(proposeResolved).toBe(true)
      expect(result.success).toBe(true)

      globalThis.fetch = prevFetch
    })
  })

  describe('TEST-ID: propose-change-accept (TEST-19)', () => {
    it('on user accept, tool returns {success: true, result}', async () => {
      queueSuccess({ success: true, result: { id: 'prop-1', mutationApplied: true } })

      const result = await proposeChange({
        operation: 'pause',
        jobId: 'job-1',
        description: 'Pause job',
      })

      expect(result.success).toBe(true)
      expect(result.result).toBeDefined()
    })
  })

  describe('TEST-ID: propose-change-reject (TEST-20)', () => {
    it('on user reject with feedback, tool returns {success: false, rejected, feedback}', async () => {
      queueSuccess({
        success: false,
        rejected: true,
        feedback: 'This operation is not allowed',
      })

      const result = await proposeChange({
        operation: 'delete',
        jobId: 'job-1',
        description: 'Delete job',
      })

      expect(result.success).toBe(false)
      expect(result.rejected).toBe(true)
      expect(result.feedback).toBe('This operation is not allowed')
    })
  })

  describe('TEST-ID: propose-change-timeout (TEST-21)', () => {
    it('on timeout, tool returns {success: false, expired: true}', async () => {
      queueSuccess({ success: false, expired: true })

      const result = await proposeChange({
        operation: 'run_now',
        jobId: 'job-1',
        description: 'Run job now',
      })

      expect(result.success).toBe(false)
      expect(result.expired).toBe(true)
    })
  })

  describe('TEST-ID: select-job-navigation (TEST-26)', () => {
    it('selectJob sends correct WS navigation message', async () => {
      setupWsMock()
      connectWebSocket()
      await simulateConnectedWs()

      const result = await selectJob('job-123')

      expect(result.success).toBe(true)
      const msg = getLastWsMessage() as Record<string, unknown>
      expect(msg.type).toBe('cron-ai-navigate')
      expect(msg.action).toBe('select_job')
      expect((msg.payload as Record<string, unknown>).jobId).toBe('job-123')
    })
  })

  describe('TEST-ID: navigate-to-tab (TEST-27)', () => {
    it('navigateToTab sends correct WS message for each tab', async () => {
      setupWsMock()
      connectWebSocket()
      await simulateConnectedWs()

      for (const tab of ['overview', 'history', 'logs', 'script'] as const) {
        await navigateToTab(tab)
        const msg = capturedWsMessages[capturedWsMessages.length - 1] as Record<string, unknown>
        expect(msg.type).toBe('cron-ai-navigate')
        expect(msg.action).toBe('switch_tab')
        expect((msg.payload as Record<string, unknown>).tab).toBe(tab)
      }
    })
  })

  describe('TEST-ID: create-proposal (TEST-23, TEST-43)', () => {
    it('propose_change with operation create includes full job config in diff/details', async () => {
      queueSuccess({ success: true, result: { id: 'new-job-1', created: true } })

      const fullConfig = {
        schedule: '0 3 * * *',
        command: '/opt/scripts/nightly-backup.sh',
        description: 'Nightly backup at 3 AM',
        projectGroup: 'backups',
        tags: ['backup', 'nightly', 'critical'],
        env: { BUCKET: 'my-bucket' },
      }

      const result = await proposeChange({
        operation: 'create',
        description: 'Create new nightly backup job',
        details: fullConfig,
      })

      expect(result.success).toBe(true)
      const req = capturedFetches[0]
      const body = req.body as Record<string, unknown>
      expect(body.operation).toBe('create')
      expect(body.details).toEqual(fullConfig)
      // jobId should not be present for create operations
      expect(body.jobId).toBeUndefined()
    })
  })
})
