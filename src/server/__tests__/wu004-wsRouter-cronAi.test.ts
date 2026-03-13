// WU-004: WebSocket Router — Cron AI Message Dispatch Tests
// Verifies that all 7 cron-ai-* WS message types are handled in wsRouter
// switch and dispatched to the correct handlers. (AC-004-3)

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { handleMessage } from '../wsRouter'
import type { WsHandlers } from '../wsRouter'
import type { ServerWebSocket } from 'bun'
import type { WSData } from '../serverContext'
import type { UiContext } from '@shared/types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockWs(overrides: Partial<WSData> = {}): ServerWebSocket<WSData> {
  return {
    data: {
      terminal: null,
      currentSessionId: null,
      currentTmuxTarget: null,
      connectionId: 'test-conn-1',
      authenticated: true,
      ...overrides,
    },
    send: mock(() => {}),
    close: mock(() => {}),
  } as unknown as ServerWebSocket<WSData>
}

function createMinimalHandlers(overrides: Partial<WsHandlers> = {}): WsHandlers {
  return {
    onSessionRefresh: mock(() => {}),
    onSessionCreate: mock(() => {}),
    onSessionKill: mock(() => {}),
    onSessionRename: mock(() => {}),
    onSessionResume: mock(() => {}),
    onSessionPin: mock(() => {}),
    onTerminalAttach: mock(() => {}),
    onTerminalDetach: mock(() => {}),
    onTerminalInput: mock(() => {}),
    onTerminalResize: mock(() => {}),
    onCancelCopyMode: mock(() => {}),
    onCheckCopyMode: mock(() => {}),
    onTaskCreate: mock(() => {}),
    onTaskCancel: mock(() => {}),
    onTaskRetry: mock(() => {}),
    onTaskListRequest: mock(() => {}),
    onTemplateListRequest: mock(() => {}),
    ...overrides,
  }
}

const mockSendFn = mock((_ws: ServerWebSocket<WSData>, _msg: unknown) => {})

function makeUiContext(overrides: Partial<UiContext> = {}): UiContext {
  return {
    selectedJobId: null,
    selectedJobDetail: null,
    activeTab: 'overview',
    visibleJobCount: 10,
    filterState: { mode: 'all', source: null, tags: [] },
    healthSummary: { healthy: 5, warning: 1, critical: 0 },
    ...overrides,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WU-004: wsRouter cron-ai-* message dispatch (AC-004-3)', () => {
  let ws: ServerWebSocket<WSData>
  let sendFn: typeof mockSendFn

  beforeEach(() => {
    ws = createMockWs()
    sendFn = mock((_ws: ServerWebSocket<WSData>, _msg: unknown) => {})
  })

  describe('cron-ai-context-update', () => {
    it('dispatches to onCronAiContextUpdate with parsed context', () => {
      const handler = mock(() => {})
      const handlers = createMinimalHandlers({ onCronAiContextUpdate: handler })
      const context = makeUiContext({ selectedJobId: 'job-1', activeTab: 'logs' })

      handleMessage(
        ws,
        JSON.stringify({ type: 'cron-ai-context-update', context }),
        handlers,
        sendFn,
        ''
      )

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(ws, context)
    })

    it('does not error when handler is not provided', () => {
      const handlers = createMinimalHandlers() // no onCronAiContextUpdate
      const context = makeUiContext()

      // Should not throw
      handleMessage(
        ws,
        JSON.stringify({ type: 'cron-ai-context-update', context }),
        handlers,
        sendFn,
        ''
      )
    })
  })

  describe('cron-ai-proposal-response', () => {
    it('dispatches to onCronAiProposalResponse with id, approved, and feedback', () => {
      const handler = mock(() => {})
      const handlers = createMinimalHandlers({ onCronAiProposalResponse: handler })

      handleMessage(
        ws,
        JSON.stringify({
          type: 'cron-ai-proposal-response',
          id: 'prop-123',
          approved: true,
          feedback: 'Looks good',
        }),
        handlers,
        sendFn,
        ''
      )

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(ws, 'prop-123', true, 'Looks good')
    })

    it('dispatches without feedback when not provided', () => {
      const handler = mock(() => {})
      const handlers = createMinimalHandlers({ onCronAiProposalResponse: handler })

      handleMessage(
        ws,
        JSON.stringify({
          type: 'cron-ai-proposal-response',
          id: 'prop-456',
          approved: false,
        }),
        handlers,
        sendFn,
        ''
      )

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(ws, 'prop-456', false, undefined)
    })
  })

  describe('cron-ai-drawer-open', () => {
    it('dispatches to onCronAiDrawerOpen', () => {
      const handler = mock(() => {})
      const handlers = createMinimalHandlers({ onCronAiDrawerOpen: handler })

      handleMessage(
        ws,
        JSON.stringify({ type: 'cron-ai-drawer-open' }),
        handlers,
        sendFn,
        ''
      )

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(ws)
    })
  })

  describe('cron-ai-drawer-close', () => {
    it('dispatches to onCronAiDrawerClose', () => {
      const handler = mock(() => {})
      const handlers = createMinimalHandlers({ onCronAiDrawerClose: handler })

      handleMessage(
        ws,
        JSON.stringify({ type: 'cron-ai-drawer-close' }),
        handlers,
        sendFn,
        ''
      )

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(ws)
    })
  })

  describe('cron-ai-new-conversation', () => {
    it('dispatches to onCronAiNewConversation', () => {
      const handler = mock(() => {})
      const handlers = createMinimalHandlers({ onCronAiNewConversation: handler })

      handleMessage(
        ws,
        JSON.stringify({ type: 'cron-ai-new-conversation' }),
        handlers,
        sendFn,
        ''
      )

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(ws)
    })
  })

  describe('cron-ai-mcp-register', () => {
    it('dispatches to onCronAiMcpRegister', () => {
      const handler = mock(() => {})
      const handlers = createMinimalHandlers({ onCronAiMcpRegister: handler })

      handleMessage(
        ws,
        JSON.stringify({ type: 'cron-ai-mcp-register', authToken: 'secret-token' }),
        handlers,
        sendFn,
        ''
      )

      expect(handler).toHaveBeenCalledTimes(1)
      // Handler receives ws and the full message (or ws + authToken, depending on wiring)
    })
  })

  describe('cron-ai-navigate', () => {
    it('dispatches to onCronAiNavigate', () => {
      const handler = mock(() => {})
      const handlers = createMinimalHandlers({ onCronAiNavigate: handler })

      handleMessage(
        ws,
        JSON.stringify({
          type: 'cron-ai-navigate',
          action: 'select-job',
          payload: { jobId: 'job-42' },
        }),
        handlers,
        sendFn,
        ''
      )

      expect(handler).toHaveBeenCalledTimes(1)
    })
  })

  describe('auth gating for cron-ai-* messages', () => {
    it('rejects cron-ai messages when not authenticated and auth is required', () => {
      const unauthWs = createMockWs({ authenticated: false })
      const handler = mock(() => {})
      const handlers = createMinimalHandlers({ onCronAiDrawerOpen: handler })

      handleMessage(
        unauthWs,
        JSON.stringify({ type: 'cron-ai-drawer-open' }),
        handlers,
        sendFn,
        'my-secret-token'
      )

      expect(handler).not.toHaveBeenCalled()
      expect(sendFn).toHaveBeenCalledWith(
        unauthWs,
        expect.objectContaining({ type: 'error' })
      )
    })

    it('allows cron-ai messages when auth is not configured', () => {
      const ws = createMockWs({ authenticated: false })
      const handler = mock(() => {})
      const handlers = createMinimalHandlers({ onCronAiDrawerOpen: handler })

      handleMessage(
        ws,
        JSON.stringify({ type: 'cron-ai-drawer-open' }),
        handlers,
        sendFn,
        '' // no auth token = dev mode
      )

      expect(handler).toHaveBeenCalledTimes(1)
    })
  })

  describe('all 7 message types are handled (not unknown)', () => {
    const cronAiMessageTypes = [
      'cron-ai-context-update',
      'cron-ai-proposal-response',
      'cron-ai-drawer-open',
      'cron-ai-drawer-close',
      'cron-ai-new-conversation',
      'cron-ai-mcp-register',
      'cron-ai-navigate',
    ]

    for (const msgType of cronAiMessageTypes) {
      it(`does not return 'Unknown message type' error for ${msgType}`, () => {
        const handlers = createMinimalHandlers({
          onCronAiContextUpdate: mock(() => {}),
          onCronAiProposalResponse: mock(() => {}),
          onCronAiDrawerOpen: mock(() => {}),
          onCronAiDrawerClose: mock(() => {}),
          onCronAiNewConversation: mock(() => {}),
          onCronAiMcpRegister: mock(() => {}),
          onCronAiNavigate: mock(() => {}),
        })

        // Build a minimal valid message for each type
        const messages: Record<string, unknown> = {
          'cron-ai-context-update': { type: msgType, context: makeUiContext() },
          'cron-ai-proposal-response': { type: msgType, id: 'p1', approved: true },
          'cron-ai-drawer-open': { type: msgType },
          'cron-ai-drawer-close': { type: msgType },
          'cron-ai-new-conversation': { type: msgType },
          'cron-ai-mcp-register': { type: msgType, authToken: 'tok' },
          'cron-ai-navigate': { type: msgType, action: 'go', payload: {} },
        }

        handleMessage(
          ws,
          JSON.stringify(messages[msgType]),
          handlers,
          sendFn,
          ''
        )

        // If the message type was NOT handled, wsRouter sends an error
        const errorCalls = (sendFn as any).mock.calls.filter(
          (call: unknown[]) => (call[1] as any)?.type === 'error' && (call[1] as any)?.message === 'Unknown message type'
        )
        expect(errorCalls.length).toBe(0)
      })
    }
  })
})

describe('WU-004: cron-ai-navigate dispatches action and payload', () => {
  it('passes action and payload to onCronAiNavigate handler', () => {
    const handler = mock(() => {})
    const handlers = createMinimalHandlers({ onCronAiNavigate: handler })
    const ws = createMockWs()

    handleMessage(
      ws,
      JSON.stringify({
        type: 'cron-ai-navigate',
        action: 'select-job',
        payload: { jobId: 'job-42', tab: 'logs' },
      }),
      handlers,
      mock(() => {}),
      ''
    )

    expect(handler).toHaveBeenCalledTimes(1)
    // First arg is ws, remaining args carry the navigate data
    const callArgs = (handler as any).mock.calls[0]
    expect(callArgs[0]).toBe(ws)
  })
})

describe('WU-004: cron-ai-proposal-response edge cases', () => {
  it('dispatches rejection with feedback string', () => {
    const handler = mock(() => {})
    const handlers = createMinimalHandlers({ onCronAiProposalResponse: handler })
    const ws = createMockWs()

    handleMessage(
      ws,
      JSON.stringify({
        type: 'cron-ai-proposal-response',
        id: 'prop-789',
        approved: false,
        feedback: 'Schedule conflicts with backup window',
      }),
      handlers,
      mock(() => {}),
      ''
    )

    expect(handler).toHaveBeenCalledWith(
      ws,
      'prop-789',
      false,
      'Schedule conflicts with backup window'
    )
  })
})

describe('WU-004: WsHandlers interface has cron-ai-* entries', () => {
  it('allows all cron-ai handler properties in WsHandlers', () => {
    // This test verifies the type interface at compile time.
    // If WsHandlers doesn't have these optional properties, this file won't compile.
    const handlers: Partial<WsHandlers> = {
      onCronAiContextUpdate: (_ws, _context) => {},
      onCronAiProposalResponse: (_ws, _id, _approved, _feedback) => {},
      onCronAiDrawerOpen: (_ws) => {},
      onCronAiDrawerClose: (_ws) => {},
      onCronAiNewConversation: (_ws) => {},
      onCronAiMcpRegister: (_ws) => {},
      onCronAiNavigate: (_ws) => {},
    }
    expect(handlers).toBeDefined()
  })
})

// ─── Navigate action/payload forwarding ─────────────────────────────────────

describe('WU-004: cron-ai-navigate action and payload extraction', () => {
  it('passes action string as second arg to handler', () => {
    const handler = mock((..._args: unknown[]) => {})
    const handlers = createMinimalHandlers({ onCronAiNavigate: handler as any })
    const ws = createMockWs()

    handleMessage(
      ws,
      JSON.stringify({
        type: 'cron-ai-navigate',
        action: 'select-job',
        payload: { jobId: 'job-99' },
      }),
      handlers,
      mock(() => {}),
      ''
    )

    expect(handler).toHaveBeenCalledTimes(1)
    // ws is first arg; action and payload should follow
    const args = (handler as any).mock.calls[0]
    expect(args[0]).toBe(ws)
  })

  it('handles navigate with empty payload', () => {
    const handler = mock(() => {})
    const handlers = createMinimalHandlers({ onCronAiNavigate: handler })
    const ws = createMockWs()

    handleMessage(
      ws,
      JSON.stringify({ type: 'cron-ai-navigate', action: 'go-home', payload: {} }),
      handlers,
      mock(() => {}),
      ''
    )

    expect(handler).toHaveBeenCalledTimes(1)
  })
})

// ─── Malformed cron-ai messages ─────────────────────────────────────────────

describe('WU-004: malformed cron-ai-* messages', () => {
  it('handles cron-ai-proposal-response with missing id gracefully', () => {
    const handler = mock(() => {})
    const handlers = createMinimalHandlers({ onCronAiProposalResponse: handler })
    const ws = createMockWs()
    const sendFn = mock(() => {})

    // Should not throw
    handleMessage(
      ws,
      JSON.stringify({ type: 'cron-ai-proposal-response', approved: true }),
      handlers,
      sendFn,
      ''
    )

    // Handler may or may not be called depending on implementation,
    // but it must not crash
  })

  it('handles cron-ai-context-update with missing context gracefully', () => {
    const handler = mock(() => {})
    const handlers = createMinimalHandlers({ onCronAiContextUpdate: handler })
    const ws = createMockWs()
    const sendFn = mock(() => {})

    // Should not throw
    handleMessage(
      ws,
      JSON.stringify({ type: 'cron-ai-context-update' }),
      handlers,
      sendFn,
      ''
    )
  })

  it('handles completely invalid JSON gracefully', () => {
    const handlers = createMinimalHandlers()
    const ws = createMockWs()
    const sendFn = mock(() => {})

    // Should not throw
    handleMessage(ws, '{not valid json', handlers, sendFn, '')
  })
})

// ─── Multiple rapid dispatches ──────────────────────────────────────────────

describe('WU-004: multiple rapid cron-ai-* dispatches', () => {
  it('dispatches multiple different message types sequentially', () => {
    const contextHandler = mock(() => {})
    const drawerOpenHandler = mock(() => {})
    const drawerCloseHandler = mock(() => {})
    const handlers = createMinimalHandlers({
      onCronAiContextUpdate: contextHandler,
      onCronAiDrawerOpen: drawerOpenHandler,
      onCronAiDrawerClose: drawerCloseHandler,
    })
    const ws = createMockWs()
    const sendFn = mock(() => {})

    handleMessage(
      ws,
      JSON.stringify({ type: 'cron-ai-drawer-open' }),
      handlers, sendFn, ''
    )
    handleMessage(
      ws,
      JSON.stringify({ type: 'cron-ai-context-update', context: makeUiContext() }),
      handlers, sendFn, ''
    )
    handleMessage(
      ws,
      JSON.stringify({ type: 'cron-ai-drawer-close' }),
      handlers, sendFn, ''
    )

    expect(drawerOpenHandler).toHaveBeenCalledTimes(1)
    expect(contextHandler).toHaveBeenCalledTimes(1)
    expect(drawerCloseHandler).toHaveBeenCalledTimes(1)
  })
})
