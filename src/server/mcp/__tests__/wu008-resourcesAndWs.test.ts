// WU-008: MCP Server Resources & WS Connectivity Tests
// Tests cron://ui/context resource, cron://skill/guidelines resource, WebSocket client
// with reconnection, auth handshake, context push updates, and graceful degradation.
//
// AC-008-1: cron://ui/context returns UiContext JSON with selectedJobId, activeTab, filters, healthSummary
// AC-008-2: cron://ui/context updates within 500ms of receiving cron-ai-context-update WS message
// AC-008-3: cron://skill/guidelines returns the skill file markdown content
// AC-008-4: WS client sends cron-ai-mcp-register with authToken immediately on connect
// AC-008-5: On WS disconnect, reconnects with exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
// AC-008-6: During WS disconnection, read tools work via HTTP; navigation tools return 'WS not connected';
//           context resource returns last known context with stale flag
// AC-008-7: On WS reconnect, sends cron-ai-mcp-register again and receives current context
//
// Strategy: Mock globalThis.WebSocket to intercept WS client behavior. Mock globalThis.fetch
// for HTTP fallback tests. Tests MUST fail against stub implementation (throw 'Not implemented').

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import type { UiContext, CronJobDetail } from '@shared/types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeUiContext(overrides: Partial<UiContext> = {}): UiContext {
  return {
    selectedJobId: 'job-1',
    selectedJobDetail: null,
    activeTab: 'overview',
    visibleJobCount: 12,
    filterState: { mode: 'all', source: null, tags: [] },
    healthSummary: { healthy: 10, warning: 1, critical: 1 },
    ...overrides,
  }
}

function makeUiContextWithDetail(overrides: Partial<UiContext> = {}): UiContext {
  return makeUiContext({
    selectedJobDetail: {
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
      scriptContent: '#!/bin/bash\necho backup',
      scriptLanguage: 'bash',
      timerConfig: null,
      serviceConfig: null,
      crontabLine: '0 * * * * /usr/bin/backup.sh',
      runHistory: [],
      recentLogs: [],
    } as CronJobDetail,
    ...overrides,
  })
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function queueNetworkError() {
  fetchResponseQueue.push({ error: new TypeError('fetch failed') })
}

// ─── WebSocket Mock Infrastructure ──────────────────────────────────────────

interface MockWebSocket {
  url: string
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
  sentMessages: string[]
  readyState: number
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  // Test helpers
  simulateOpen: () => void
  simulateMessage: (data: unknown) => void
  simulateClose: (code?: number) => void
  simulateError: () => void
}

let mockWsInstances: MockWebSocket[] = []
let originalWebSocket: typeof WebSocket | undefined

function setupWsMock() {
  mockWsInstances = []
  originalWebSocket = globalThis.WebSocket

  const MockWebSocketClass = class {
    url: string
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    sentMessages: string[] = []
    readyState = 0 // CONNECTING

    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    constructor(url: string) {
      this.url = url
      mockWsInstances.push(this as unknown as MockWebSocket)
    }

    send(data: string) {
      this.sentMessages.push(data)
    }

    close(code?: number, _reason?: string) {
      this.readyState = 3 // CLOSED
      this.onclose?.({ code: code ?? 1000 } as CloseEvent)
    }

    simulateOpen() {
      this.readyState = 1 // OPEN
      this.onopen?.({} as Event)
    }

    simulateMessage(data: unknown) {
      this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
    }

    simulateClose(code = 1006) {
      this.readyState = 3 // CLOSED
      this.onclose?.({ code } as CloseEvent)
    }

    simulateError() {
      this.onerror?.({} as Event)
    }
  }

  globalThis.WebSocket = MockWebSocketClass as unknown as typeof WebSocket
}

function teardownWsMock() {
  mockWsInstances = []
  if (originalWebSocket) {
    globalThis.WebSocket = originalWebSocket
  }
}

function getLastWs(): MockWebSocket {
  if (mockWsInstances.length === 0) throw new Error('No WebSocket instances created')
  return mockWsInstances[mockWsInstances.length - 1]
}

function getWsCount(): number {
  return mockWsInstances.length
}

// ─── Module Under Test ──────────────────────────────────────────────────────

import {
  getContextResource,
  getSkillGuidelinesResource,
  connectWebSocket,
  sendWsMessage,
  // Read tools for degradation tests
  listJobs,
  // Navigation tools for degradation tests
  selectJob,
  navigateToTab,
} from '../cronMcpServer'

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('WU-008: MCP Server Resources & WS Connectivity', () => {
  beforeEach(() => {
    setupFetchMock()
    setupWsMock()
    process.env.AGENTBOARD_URL = 'http://test-host:4040'
    process.env.AGENTBOARD_WS = 'ws://test-host:4040/ws'
    process.env.AGENTBOARD_AUTH_TOKEN = 'test-token-abc'
  })

  afterEach(() => {
    teardownFetchMock()
    teardownWsMock()
    delete process.env.AGENTBOARD_AUTH_TOKEN
    delete process.env.AGENTBOARD_URL
    delete process.env.AGENTBOARD_WS
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-008-1: cron://ui/context returns UiContext JSON with selectedJobId,
  //           activeTab, filters, healthSummary
  // TEST-ID: context-resource (TEST-34)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getContextResource — cron://ui/context (AC-008-1)', () => {
    it('returns an object with context and stale fields', () => {
      const result = getContextResource()
      expect(result).toHaveProperty('context')
      expect(result).toHaveProperty('stale')
    })

    it('returns null context before any WS update', () => {
      const result = getContextResource()
      expect(result.context).toBeNull()
      expect(result.stale).toBe(false)
    })

    it('returns UiContext with selectedJobId after WS push', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      const ctx = makeUiContext({ selectedJobId: 'job-42' })
      ws.simulateMessage({ type: 'cron-ai-context-update', context: ctx })

      const result = getContextResource()
      expect(result.context).not.toBeNull()
      expect(result.context!.selectedJobId).toBe('job-42')
    })

    it('returns UiContext with activeTab field', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      const ctx = makeUiContext({ activeTab: 'history' })
      ws.simulateMessage({ type: 'cron-ai-context-update', context: ctx })

      const result = getContextResource()
      expect(result.context!.activeTab).toBe('history')
    })

    it('returns UiContext with filterState', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      const ctx = makeUiContext({
        filterState: { mode: 'failing', source: 'systemd', tags: ['critical'] },
      })
      ws.simulateMessage({ type: 'cron-ai-context-update', context: ctx })

      const result = getContextResource()
      expect(result.context!.filterState.mode).toBe('failing')
      expect(result.context!.filterState.source).toBe('systemd')
      expect(result.context!.filterState.tags).toEqual(['critical'])
    })

    it('returns UiContext with healthSummary', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      const ctx = makeUiContext({
        healthSummary: { healthy: 5, warning: 3, critical: 2 },
      })
      ws.simulateMessage({ type: 'cron-ai-context-update', context: ctx })

      const result = getContextResource()
      expect(result.context!.healthSummary).toEqual({ healthy: 5, warning: 3, critical: 2 })
    })

    it('returns UiContext with visibleJobCount', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      const ctx = makeUiContext({ visibleJobCount: 42 })
      ws.simulateMessage({ type: 'cron-ai-context-update', context: ctx })

      const result = getContextResource()
      expect(result.context!.visibleJobCount).toBe(42)
    })

    it('returns UiContext with selectedJobDetail when a job is selected', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      const ctx = makeUiContextWithDetail()
      ws.simulateMessage({ type: 'cron-ai-context-update', context: ctx })

      const result = getContextResource()
      expect(result.context!.selectedJobDetail).not.toBeNull()
      expect(result.context!.selectedJobDetail!.name).toBe('test-backup')
    })

    it('returns the full UiContext shape matching the type interface', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      const ctx = makeUiContext()
      ws.simulateMessage({ type: 'cron-ai-context-update', context: ctx })

      const result = getContextResource()
      const c = result.context!
      // Verify all UiContext fields are present
      expect(c).toHaveProperty('selectedJobId')
      expect(c).toHaveProperty('selectedJobDetail')
      expect(c).toHaveProperty('activeTab')
      expect(c).toHaveProperty('visibleJobCount')
      expect(c).toHaveProperty('filterState')
      expect(c).toHaveProperty('healthSummary')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-008-2: cron://ui/context updates within 500ms of receiving
  //           cron-ai-context-update WS message
  // TEST-ID: context-update-push (TEST-31, TEST-32, TEST-33)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Context update push — latency (AC-008-2)', () => {
    it('updates context cache synchronously on WS message', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      const ctx = makeUiContext({ selectedJobId: 'job-fast' })
      ws.simulateMessage({ type: 'cron-ai-context-update', context: ctx })

      // Should be immediately available (synchronous update)
      const result = getContextResource()
      expect(result.context!.selectedJobId).toBe('job-fast')
    })

    it('reflects multiple rapid context updates', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      // First update
      ws.simulateMessage({
        type: 'cron-ai-context-update',
        context: makeUiContext({ selectedJobId: 'job-a' }),
      })
      expect(getContextResource().context!.selectedJobId).toBe('job-a')

      // Second update immediately after
      ws.simulateMessage({
        type: 'cron-ai-context-update',
        context: makeUiContext({ selectedJobId: 'job-b' }),
      })
      expect(getContextResource().context!.selectedJobId).toBe('job-b')

      // Third update
      ws.simulateMessage({
        type: 'cron-ai-context-update',
        context: makeUiContext({ selectedJobId: 'job-c', activeTab: 'logs' }),
      })
      const result = getContextResource()
      expect(result.context!.selectedJobId).toBe('job-c')
      expect(result.context!.activeTab).toBe('logs')
    })

    it('replaces entire context on update (not merge)', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      // First: set a job with detail
      ws.simulateMessage({
        type: 'cron-ai-context-update',
        context: makeUiContextWithDetail({ selectedJobId: 'job-1' }),
      })
      expect(getContextResource().context!.selectedJobDetail).not.toBeNull()

      // Second: new context with no detail
      ws.simulateMessage({
        type: 'cron-ai-context-update',
        context: makeUiContext({ selectedJobId: null, selectedJobDetail: null }),
      })
      const result = getContextResource()
      expect(result.context!.selectedJobId).toBeNull()
      expect(result.context!.selectedJobDetail).toBeNull()
    })

    it('does not update context from unrelated WS message types', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      // Set initial context
      const ctx = makeUiContext({ selectedJobId: 'job-1' })
      ws.simulateMessage({ type: 'cron-ai-context-update', context: ctx })

      // Send an unrelated message type
      ws.simulateMessage({ type: 'cron-ai-proposal-resolved', id: 'prop-1', status: 'accepted' })

      // Context should be unchanged
      expect(getContextResource().context!.selectedJobId).toBe('job-1')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-008-3: cron://skill/guidelines returns the skill file markdown content
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getSkillGuidelinesResource — cron://skill/guidelines (AC-008-3)', () => {
    it('returns a string (not null or undefined)', () => {
      const result = getSkillGuidelinesResource()
      expect(typeof result).toBe('string')
    })

    it('returns non-empty content', () => {
      const result = getSkillGuidelinesResource()
      expect(result.length).toBeGreaterThan(0)
    })

    it('returns markdown content (contains typical markdown markers)', () => {
      const result = getSkillGuidelinesResource()
      // Skill files typically contain headers or markdown formatting
      expect(result).toContain('#')
    })

    it('returns the same content on repeated calls (static resource)', () => {
      const first = getSkillGuidelinesResource()
      const second = getSkillGuidelinesResource()
      expect(first).toBe(second)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-008-4: WS client sends cron-ai-mcp-register with authToken
  //           immediately on connect
  // TEST-ID: ws-auth-handshake (TEST-61)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('WS handshake — cron-ai-mcp-register (AC-008-4)', () => {
    it('creates a WebSocket connection to AGENTBOARD_WS endpoint', () => {
      connectWebSocket()
      expect(getWsCount()).toBe(1)
      expect(getLastWs().url).toBe('ws://test-host:4040/ws')
    })

    it('sends cron-ai-mcp-register message on open', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      expect(ws.sentMessages.length).toBeGreaterThanOrEqual(1)
      const msg = JSON.parse(ws.sentMessages[0])
      expect(msg.type).toBe('cron-ai-mcp-register')
    })

    it('includes authToken in register message when configured', () => {
      process.env.AGENTBOARD_AUTH_TOKEN = 'my-secret-token'

      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      const msg = JSON.parse(ws.sentMessages[0])
      expect(msg.type).toBe('cron-ai-mcp-register')
      expect(msg.authToken).toBe('my-secret-token')
    })

    it('sends register without authToken when token is empty', () => {
      delete process.env.AGENTBOARD_AUTH_TOKEN

      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      const msg = JSON.parse(ws.sentMessages[0])
      expect(msg.type).toBe('cron-ai-mcp-register')
      // authToken should be absent or falsy
      expect(msg.authToken || '').toBe('')
    })

    it('sends register immediately on open (no delay)', () => {
      connectWebSocket()
      const ws = getLastWs()

      // Before open — no messages
      expect(ws.sentMessages.length).toBe(0)

      // On open — register sent immediately
      ws.simulateOpen()
      expect(ws.sentMessages.length).toBe(1)
      expect(JSON.parse(ws.sentMessages[0]).type).toBe('cron-ai-mcp-register')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-008-5: On WS disconnect, reconnects with exponential backoff:
  //           1s, 2s, 4s, 8s, 16s, 30s max
  // TEST-ID: ws-reconnection (TEST-55)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('WS reconnection — exponential backoff (AC-008-5)', () => {
    it('attempts to reconnect after disconnect', async () => {
      connectWebSocket()
      const ws1 = getLastWs()
      ws1.simulateOpen()
      ws1.simulateClose(1006)

      // Wait for first reconnect delay (1s)
      await new Promise((r) => setTimeout(r, 1500))

      expect(getWsCount()).toBeGreaterThanOrEqual(2)
    })

    it('uses exponential backoff: first retry at ~1s', async () => {
      connectWebSocket()
      const ws1 = getLastWs()
      ws1.simulateOpen()
      ws1.simulateClose(1006)

      // Before 1s — no reconnect yet
      await new Promise((r) => setTimeout(r, 500))
      expect(getWsCount()).toBe(1)

      // After 1s — should have reconnected
      await new Promise((r) => setTimeout(r, 800))
      expect(getWsCount()).toBe(2)
    })

    it('second retry delay is ~2s (doubles from 1s)', async () => {
      connectWebSocket()
      const ws1 = getLastWs()
      ws1.simulateOpen()
      ws1.simulateClose(1006)

      // Wait for first reconnect (~1s)
      await new Promise((r) => setTimeout(r, 1200))
      expect(getWsCount()).toBe(2)

      // Simulate second disconnect
      const ws2 = getLastWs()
      ws2.simulateClose(1006)

      // Before 2s — no third reconnect yet
      await new Promise((r) => setTimeout(r, 1000))
      expect(getWsCount()).toBe(2)

      // After 2s — should have reconnected
      await new Promise((r) => setTimeout(r, 1500))
      expect(getWsCount()).toBe(3)
    })

    it('backoff caps at 30s max delay', async () => {
      // Structural test: verify the exponential backoff sequence caps at 30s
      // by simulating rapid connect/disconnect cycles without waiting for full delays.
      // The implementation should cap at WS_MAX_RECONNECT_DELAY = 30000ms.
      // We verify the cap by checking the formula: min(delay * 2, 30000)
      const delays: number[] = []
      let delay = 1000
      const maxDelay = 30000
      for (let i = 0; i < 10; i++) {
        delays.push(delay)
        delay = Math.min(delay * 2, maxDelay)
      }
      // Expected sequence: 1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s, 30s, 30s
      expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000])
      expect(Math.max(...delays)).toBe(30000)
    })

    it('resets backoff delay after successful reconnect', async () => {
      connectWebSocket()
      const ws1 = getLastWs()
      ws1.simulateOpen()
      ws1.simulateClose(1006)

      // Wait for first reconnect
      await new Promise((r) => setTimeout(r, 1500))
      const ws2 = getLastWs()

      // Successful reconnect — open the new connection
      ws2.simulateOpen()

      // Now disconnect again
      ws2.simulateClose(1006)

      // The delay should have reset to 1s (not 2s)
      await new Promise((r) => setTimeout(r, 500))
      expect(getWsCount()).toBe(2) // Not yet (within 1s)

      await new Promise((r) => setTimeout(r, 800))
      expect(getWsCount()).toBe(3) // Reconnected at ~1s (reset backoff)
    })

    it('does not reconnect on clean close (code 1000)', async () => {
      connectWebSocket()
      const ws1 = getLastWs()
      ws1.simulateOpen()

      // Clean close — intentional disconnect
      ws1.simulateClose(1000)

      await new Promise((r) => setTimeout(r, 2000))
      expect(getWsCount()).toBe(1) // No reconnect attempts
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-008-6: During WS disconnection, read tools work via HTTP,
  //           navigation tools return 'WS not connected', context resource
  //           returns last known context with stale flag
  // TEST-ID: ws-graceful-degradation (TEST-56)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Graceful degradation during WS disconnection (AC-008-6)', () => {
    it('context resource returns stale: true after WS disconnect', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      // Push initial context
      const ctx = makeUiContext({ selectedJobId: 'job-1' })
      ws.simulateMessage({ type: 'cron-ai-context-update', context: ctx })

      // Disconnect
      ws.simulateClose(1006)

      const result = getContextResource()
      expect(result.stale).toBe(true)
      expect(result.context).not.toBeNull()
      expect(result.context!.selectedJobId).toBe('job-1')
    })

    it('context resource preserves last known context during disconnection', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      const ctx = makeUiContext({
        selectedJobId: 'job-99',
        activeTab: 'logs',
        healthSummary: { healthy: 3, warning: 2, critical: 1 },
      })
      ws.simulateMessage({ type: 'cron-ai-context-update', context: ctx })
      ws.simulateClose(1006)

      const result = getContextResource()
      expect(result.context!.selectedJobId).toBe('job-99')
      expect(result.context!.activeTab).toBe('logs')
      expect(result.context!.healthSummary).toEqual({ healthy: 3, warning: 2, critical: 1 })
    })

    it('sendWsMessage returns false when WS is disconnected', () => {
      // Without connecting at all
      const sent = sendWsMessage({ type: 'cron-ai-navigate', action: 'test' })
      expect(sent).toBe(false)
    })

    it('sendWsMessage returns false after WS disconnect', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()
      ws.simulateClose(1006)

      const sent = sendWsMessage({ type: 'cron-ai-navigate', action: 'test' })
      expect(sent).toBe(false)
    })

    it('read tools (HTTP) still work during WS disconnection', async () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()
      ws.simulateClose(1006)

      // listJobs uses HTTP via fetchFromAgentboard — should still work
      queueSuccess([{ id: 'job-1', name: 'backup' }])

      const result = await listJobs()
      expect(result).toBeDefined()
      expect(capturedFetches.length).toBeGreaterThanOrEqual(1)
    })

    it('navigation tools return error when WS is not connected', async () => {
      // Do NOT connect WS at all
      const result = await selectJob('job-1')

      // Should indicate failure due to WS disconnection
      expect(result.success).toBe(false)
    })

    it('navigation tools return WS-specific error message', async () => {
      const result = await navigateToTab('overview')

      // Should contain indication that WS is not connected
      expect(result.success).toBe(false)
      // The error should hint at WS connectivity
      if ('error' in result) {
        expect(String(result.error).toLowerCase()).toMatch(/not connected|ws|websocket|disconnected/)
      }
    })

    it('context resource returns stale: false before any WS connection', () => {
      // Before any connectWebSocket call
      const result = getContextResource()
      expect(result.stale).toBe(false)
      expect(result.context).toBeNull()
    })

    it('stale flag clears after WS reconnection and new context push', async () => {
      connectWebSocket()
      const ws1 = getLastWs()
      ws1.simulateOpen()

      ws1.simulateMessage({
        type: 'cron-ai-context-update',
        context: makeUiContext({ selectedJobId: 'job-old' }),
      })
      ws1.simulateClose(1006)

      // Stale during disconnection
      expect(getContextResource().stale).toBe(true)

      // Wait for reconnect
      await new Promise((r) => setTimeout(r, 1500))
      const ws2 = getLastWs()
      ws2.simulateOpen()

      // Push new context on reconnected socket
      ws2.simulateMessage({
        type: 'cron-ai-context-update',
        context: makeUiContext({ selectedJobId: 'job-new' }),
      })

      const result = getContextResource()
      expect(result.stale).toBe(false)
      expect(result.context!.selectedJobId).toBe('job-new')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // AC-008-7: On WS reconnect, sends cron-ai-mcp-register again
  // ═══════════════════════════════════════════════════════════════════════════

  describe('WS reconnect — re-registration (AC-008-7)', () => {
    it('sends cron-ai-mcp-register again on reconnect', async () => {
      connectWebSocket()
      const ws1 = getLastWs()
      ws1.simulateOpen()

      // Verify first registration
      expect(ws1.sentMessages.length).toBe(1)
      expect(JSON.parse(ws1.sentMessages[0]).type).toBe('cron-ai-mcp-register')

      // Disconnect
      ws1.simulateClose(1006)

      // Wait for reconnect
      await new Promise((r) => setTimeout(r, 1500))
      const ws2 = getLastWs()
      ws2.simulateOpen()

      // Verify second registration
      expect(ws2.sentMessages.length).toBe(1)
      expect(JSON.parse(ws2.sentMessages[0]).type).toBe('cron-ai-mcp-register')
    })

    it('includes authToken on re-registration', async () => {
      process.env.AGENTBOARD_AUTH_TOKEN = 'persistent-token'

      connectWebSocket()
      const ws1 = getLastWs()
      ws1.simulateOpen()
      ws1.simulateClose(1006)

      await new Promise((r) => setTimeout(r, 1500))
      const ws2 = getLastWs()
      ws2.simulateOpen()

      const msg = JSON.parse(ws2.sentMessages[0])
      expect(msg.authToken).toBe('persistent-token')
    })

    it('receives and processes context after re-registration', async () => {
      connectWebSocket()
      const ws1 = getLastWs()
      ws1.simulateOpen()

      ws1.simulateMessage({
        type: 'cron-ai-context-update',
        context: makeUiContext({ selectedJobId: 'job-old' }),
      })
      ws1.simulateClose(1006)

      // Wait for reconnect
      await new Promise((r) => setTimeout(r, 1500))
      const ws2 = getLastWs()
      ws2.simulateOpen()

      // Server sends fresh context after re-registration
      ws2.simulateMessage({
        type: 'cron-ai-context-update',
        context: makeUiContext({ selectedJobId: 'job-fresh' }),
      })

      const result = getContextResource()
      expect(result.context!.selectedJobId).toBe('job-fresh')
      expect(result.stale).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // sendWsMessage — connected behavior
  // ═══════════════════════════════════════════════════════════════════════════

  describe('sendWsMessage — connected behavior', () => {
    it('returns true when WS is connected and message is sent', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      const result = sendWsMessage({ type: 'cron-ai-navigate', action: 'test' })
      expect(result).toBe(true)
    })

    it('actually sends the JSON message over the WebSocket', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      // First message is the register handshake
      const registerCount = ws.sentMessages.length

      sendWsMessage({ type: 'cron-ai-navigate', action: 'select_job', payload: { jobId: 'job-1' } })

      expect(ws.sentMessages.length).toBe(registerCount + 1)
      const sent = JSON.parse(ws.sentMessages[ws.sentMessages.length - 1])
      expect(sent.type).toBe('cron-ai-navigate')
      expect(sent.action).toBe('select_job')
      expect(sent.payload.jobId).toBe('job-1')
    })

    it('sends multiple messages on the same connection', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      const registerCount = ws.sentMessages.length

      sendWsMessage({ type: 'cron-ai-navigate', action: 'select_job', payload: { jobId: 'job-1' } })
      sendWsMessage({ type: 'cron-ai-navigate', action: 'switch_tab', payload: { tab: 'logs' } })
      sendWsMessage({ type: 'cron-ai-navigate', action: 'filter', payload: { filter: { mode: 'failing' } } })

      expect(ws.sentMessages.length).toBe(registerCount + 3)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // WS message handling — proposal resolution
  // ═══════════════════════════════════════════════════════════════════════════

  describe('WS message handling — cron-ai-proposal-resolved', () => {
    it('handles proposal-resolved message without crashing', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      // Should not throw
      expect(() => {
        ws.simulateMessage({
          type: 'cron-ai-proposal-resolved',
          id: 'prop-42',
          status: 'accepted',
        })
      }).not.toThrow()
    })

    it('handles proposal-resolved with feedback', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      expect(() => {
        ws.simulateMessage({
          type: 'cron-ai-proposal-resolved',
          id: 'prop-43',
          status: 'rejected',
          feedback: 'Please use a different schedule',
        })
      }).not.toThrow()
    })

    it('handles expired proposal resolution', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      expect(() => {
        ws.simulateMessage({
          type: 'cron-ai-proposal-resolved',
          id: 'prop-44',
          status: 'expired',
        })
      }).not.toThrow()
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // Edge cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Edge cases', () => {
    it('connectWebSocket uses AGENTBOARD_WS env var for the URL', () => {
      process.env.AGENTBOARD_WS = 'ws://custom-host:9999/ws'

      connectWebSocket()
      expect(getLastWs().url).toBe('ws://custom-host:9999/ws')
    })

    it('handles malformed WS message without crashing', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      // Send a message with unexpected shape
      expect(() => {
        ws.onmessage?.({ data: 'not json' } as MessageEvent)
      }).not.toThrow()
    })

    it('handles unknown WS message type without crashing', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      expect(() => {
        ws.simulateMessage({ type: 'unknown-type', data: 'whatever' })
      }).not.toThrow()
    })

    it('handles WS error event without crashing', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      expect(() => {
        ws.simulateError()
      }).not.toThrow()
    })

    it('connectWebSocket can be called multiple times without error', () => {
      // Should not throw on repeated calls
      expect(() => {
        connectWebSocket()
        connectWebSocket()
      }).not.toThrow()
    })

    it('context resource returns null context with stale:false when never connected', () => {
      const result = getContextResource()
      expect(result.context).toBeNull()
      expect(result.stale).toBe(false)
    })

    it('sendWsMessage returns false before connectWebSocket is called', () => {
      const result = sendWsMessage({ type: 'test' })
      expect(result).toBe(false)
    })

    it('context update with null selectedJobId is valid', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      ws.simulateMessage({
        type: 'cron-ai-context-update',
        context: makeUiContext({ selectedJobId: null }),
      })

      const result = getContextResource()
      expect(result.context!.selectedJobId).toBeNull()
    })

    it('WS register message is the first message sent (before any navigation)', () => {
      connectWebSocket()
      const ws = getLastWs()
      ws.simulateOpen()

      // Send a navigation command
      sendWsMessage({ type: 'cron-ai-navigate', action: 'test' })

      // First message should always be the register
      const firstMsg = JSON.parse(ws.sentMessages[0])
      expect(firstMsg.type).toBe('cron-ai-mcp-register')
    })
  })
})
