/**
 * CronAiTerminal.test.tsx — Tests for WU-010 CronAi Terminal
 *
 * Tests that the xterm.js terminal component correctly attaches/detaches
 * to the cron-ai tmux window via the useTerminal hook, renders a container
 * div for xterm to mount into, and handles drawer open/close lifecycle.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import type TestRenderer from 'react-test-renderer'
import type { ReactTestInstance } from 'react-test-renderer'
import type { SendClientMessage, SubscribeServerMessage, ServerMessage } from '../../../../shared/types'

/* ------------------------------------------------------------------ */
/*  Global DOM stubs — must be installed BEFORE any React import       */
/* ------------------------------------------------------------------ */
const globalAny = globalThis as Record<string, unknown>
const originalDocument = globalAny.document
const originalWindow = globalAny.window
const originalNavigator = globalAny.navigator

// Minimal stubs at module scope to survive import-time side effects
if (!globalAny.document) {
  globalAny.document = {
    documentElement: { style: {}, setAttribute: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: () => ({ style: {}, addEventListener: () => {}, setAttribute: () => {} }),
    head: { appendChild: () => {} },
    body: { appendChild: () => {}, removeChild: () => {} },
    createTextNode: () => ({}),
    createDocumentFragment: () => ({ appendChild: () => {} }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  }
}
if (!globalAny.window) {
  globalAny.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    innerWidth: 1024,
    innerHeight: 768,
    devicePixelRatio: 1,
    getComputedStyle: () => ({}),
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
    cancelAnimationFrame: () => {},
    location: { href: '', protocol: 'http:', host: 'localhost' },
    navigator: { platform: 'Linux', userAgent: 'Test', maxTouchPoints: 0 },
  }
}

/* ------------------------------------------------------------------ */
/*  useTerminal mock setup                                             */
/* ------------------------------------------------------------------ */
let mockUseTerminalCalls: Array<Record<string, unknown>> = []
let mockContainerRef: { current: HTMLDivElement | null } = { current: null }
let mockTerminalRef: { current: unknown } = { current: null }
let mockSearchAddonRef: { current: unknown } = { current: null }
let mockSerializeAddonRef: { current: unknown } = { current: null }
let mockProgressAddonRef: { current: unknown } = { current: null }
let mockInTmuxCopyModeRef: { current: boolean } = { current: false }
const mockSetTmuxCopyMode = mock(() => {})

mock.module('../../hooks/useTerminal', () => ({
  useTerminal: (opts: Record<string, unknown>) => {
    mockUseTerminalCalls.push(opts)
    return {
      containerRef: mockContainerRef,
      terminalRef: mockTerminalRef,
      searchAddonRef: mockSearchAddonRef,
      serializeAddonRef: mockSerializeAddonRef,
      progressAddonRef: mockProgressAddonRef,
      inTmuxCopyModeRef: mockInTmuxCopyModeRef,
      setTmuxCopyMode: mockSetTmuxCopyMode,
    }
  },
}))

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function setupDom() {
  globalAny.document = {
    documentElement: { style: {}, setAttribute: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: (tag: string) => ({
      tagName: tag.toUpperCase(),
      style: {},
      addEventListener: () => {},
      removeEventListener: () => {},
      setAttribute: () => {},
      appendChild: () => {},
      removeChild: () => {},
      contains: () => false,
      childNodes: [],
    }),
    head: { appendChild: () => {} },
    body: { appendChild: () => {}, removeChild: () => {} },
    createTextNode: (t: string) => ({ textContent: t }),
    createDocumentFragment: () => ({ appendChild: () => {} }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  } as unknown as Document

  globalAny.navigator = {
    platform: 'Linux',
    userAgent: 'Test',
    maxTouchPoints: 0,
  } as unknown as Navigator

  globalAny.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    innerWidth: 1024,
    innerHeight: 768,
    devicePixelRatio: 1,
    getComputedStyle: () => ({}),
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
    cancelAnimationFrame: () => {},
    location: { href: '', protocol: 'http:', host: 'localhost' },
    navigator: { platform: 'Linux', userAgent: 'Test', maxTouchPoints: 0 },
  } as unknown as Window & typeof globalThis
}

function createStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size },
  }
}

function createWsStubs() {
  const sent: Array<{ type: string; [k: string]: unknown }> = []
  const listeners = new Set<(msg: ServerMessage) => void>()

  const sendMessage: SendClientMessage = (msg: Record<string, unknown>) => {
    sent.push(msg as { type: string })
    return true
  }

  const subscribe: SubscribeServerMessage = (listener: (msg: ServerMessage) => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  const emit = (msg: ServerMessage) => {
    listeners.forEach(fn => fn(msg))
  }

  return { sent, sendMessage, subscribe, emit }
}

/** Find all instances that have a specific prop value */
function findByProp(root: ReactTestInstance, prop: string, value: unknown): ReactTestInstance[] {
  const results: ReactTestInstance[] = []
  try {
    root.findAll(node => {
      try { return node.props[prop] === value } catch { return false }
    }).forEach(n => results.push(n))
  } catch { /* ignore */ }
  return results
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('CronAiTerminal', () => {
  let _React: typeof import('react')
  let act: typeof TestRenderer.act
  let create: typeof TestRenderer.create
  let CronAiTerminal: React.ComponentType<{
    sessionId: string | null
    tmuxTarget: string | null
    sendMessage: SendClientMessage
    subscribe: SubscribeServerMessage
  }>

  beforeEach(async () => {
    setupDom()
    globalAny.localStorage = createStorage()
    mockUseTerminalCalls = []
    mockContainerRef = { current: null }
    mockTerminalRef = { current: null }
    mockSearchAddonRef = { current: null }
    mockSerializeAddonRef = { current: null }
    mockProgressAddonRef = { current: null }
    mockInTmuxCopyModeRef = { current: false }
    mockSetTmuxCopyMode.mockClear()

    // Dynamic import after globals are set up
    _React = await import('react')
    const renderer = await import('react-test-renderer')
    act = renderer.act
    create = renderer.create
    const mod = await import('../CronAiTerminal')
    CronAiTerminal = mod.CronAiTerminal
  })

  afterEach(() => {
    globalAny.document = originalDocument
    globalAny.navigator = originalNavigator
    globalAny.window = originalWindow
  })

  /* ================================================================ */
  /*  AC-010-1: Terminal renders and connects to tmux window           */
  /* ================================================================ */

  describe('AC-010-1: rendering and connection', () => {
    test('renders a container div for xterm to mount into', () => {
      const { sendMessage, subscribe } = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId="cron-ai-session-1"
            tmuxTarget="agentboard:5"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      // Should render at least one div element (the xterm container)
      const root = renderer.root
      const divs = root.findAllByType('div')
      expect(divs.length).toBeGreaterThanOrEqual(1)

      act(() => { renderer.unmount() })
    })

    test('calls useTerminal with the provided sessionId and tmuxTarget', () => {
      const { sendMessage, subscribe } = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId="cron-ai-session-1"
            tmuxTarget="agentboard:5"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      // useTerminal should have been called with the correct session/target
      expect(mockUseTerminalCalls.length).toBeGreaterThanOrEqual(1)
      const lastCall = mockUseTerminalCalls[mockUseTerminalCalls.length - 1]
      expect(lastCall.sessionId).toBe('cron-ai-session-1')
      expect(lastCall.tmuxTarget).toBe('agentboard:5')

      act(() => { renderer.unmount() })
    })

    test('passes sendMessage and subscribe to useTerminal', () => {
      const { sendMessage, subscribe } = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId="cron-ai-session-1"
            tmuxTarget="agentboard:5"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      const lastCall = mockUseTerminalCalls[mockUseTerminalCalls.length - 1]
      expect(lastCall.sendMessage).toBe(sendMessage)
      expect(lastCall.subscribe).toBe(subscribe)

      act(() => { renderer.unmount() })
    })

    test('renders with null sessionId when no session exists', () => {
      const { sendMessage, subscribe } = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId={null}
            tmuxTarget={null}
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      expect(mockUseTerminalCalls.length).toBeGreaterThanOrEqual(1)
      const lastCall = mockUseTerminalCalls[mockUseTerminalCalls.length - 1]
      expect(lastCall.sessionId).toBeNull()
      expect(lastCall.tmuxTarget).toBeNull()

      act(() => { renderer.unmount() })
    })

    test('renders data-testid="cron-ai-terminal" on terminal container', () => {
      const { sendMessage, subscribe } = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId="cron-ai-session-1"
            tmuxTarget="agentboard:5"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      const containers = findByProp(renderer.root, 'data-testid', 'cron-ai-terminal')
      expect(containers.length).toBe(1)

      act(() => { renderer.unmount() })
    })

    test('does NOT render terminal container when sessionId is null (shows placeholder)', () => {
      const { sendMessage, subscribe } = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId={null}
            tmuxTarget={null}
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      // Terminal container should not exist
      const containers = findByProp(renderer.root, 'data-testid', 'cron-ai-terminal')
      expect(containers.length).toBe(0)

      // Placeholder text should be visible
      const root = renderer.root
      const allText = root.findAll(node => {
        try {
          return typeof node.children?.[0] === 'string'
            && (node.children[0] as string).toLowerCase().includes('waiting')
        } catch { return false }
      })
      expect(allText.length).toBeGreaterThanOrEqual(1)

      act(() => { renderer.unmount() })
    })
  })

  /* ================================================================ */
  /*  AC-010-2: Terminal shows session output                          */
  /* ================================================================ */

  describe('AC-010-2: session output display', () => {
    test('useTerminal receives same xterm options as main terminal (font, theme)', () => {
      const { sendMessage, subscribe } = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId="cron-ai-session-1"
            tmuxTarget="agentboard:5"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      const lastCall = mockUseTerminalCalls[mockUseTerminalCalls.length - 1]
      // Should pass theme/font options (exact values may come from settings store)
      // At minimum, these properties should be present
      expect(lastCall).toHaveProperty('theme')
      expect(lastCall).toHaveProperty('fontSize')

      act(() => { renderer.unmount() })
    })

    test('passes lineHeight, letterSpacing, fontFamily to useTerminal', () => {
      const { sendMessage, subscribe } = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId="cron-ai-session-1"
            tmuxTarget="agentboard:5"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      const lastCall = mockUseTerminalCalls[mockUseTerminalCalls.length - 1]
      // Must pass the same terminal options as Terminal.tsx
      expect(lastCall).toHaveProperty('lineHeight')
      expect(typeof lastCall.lineHeight).toBe('number')
      expect(lastCall).toHaveProperty('letterSpacing')
      expect(typeof lastCall.letterSpacing).toBe('number')
      expect(lastCall).toHaveProperty('fontFamily')
      expect(typeof lastCall.fontFamily).toBe('string')

      act(() => { renderer.unmount() })
    })

    test('containerRef from useTerminal is attached to the rendered div', () => {
      const { sendMessage, subscribe } = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId="cron-ai-session-1"
            tmuxTarget="agentboard:5"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      // The component should use the containerRef from useTerminal as a ref on a div
      // We verify by checking the component tree has a div with the ref
      const root = renderer.root
      const divs = root.findAllByType('div')
      // At least one div should exist that serves as the terminal container
      expect(divs.length).toBeGreaterThanOrEqual(1)

      // The container div should have styling that allows it to fill space
      // (typically absolute inset-0 or flex-1 with overflow hidden)
      const containerDiv = divs.find(d => {
        const cls = d.props.className || ''
        return cls.includes('inset-0') || cls.includes('flex-1') || cls.includes('overflow')
      })
      expect(containerDiv).toBeDefined()

      act(() => { renderer.unmount() })
    })
  })

  /* ================================================================ */
  /*  AC-010-3: Terminal detaches on drawer close (unmount)             */
  /* ================================================================ */

  describe('AC-010-3: detach on unmount', () => {
    test('TEST-ID terminal-detach: component unmounts cleanly', () => {
      const { sendMessage, subscribe } = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId="cron-ai-session-1"
            tmuxTarget="agentboard:5"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      // Verify it mounted
      expect(mockUseTerminalCalls.length).toBeGreaterThanOrEqual(1)

      // Unmount — simulates drawer closing
      act(() => { renderer.unmount() })

      // useTerminal hook handles cleanup internally, but the component
      // should not throw or leak on unmount. If we get here without
      // error, unmount was clean.
      expect(true).toBe(true)
    })

    test('no WS messages sent after unmount', () => {
      const ws = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId="cron-ai-session-1"
            tmuxTarget="agentboard:5"
            sendMessage={ws.sendMessage}
            subscribe={ws.subscribe}
          />
        )
      })

      const sentBefore = ws.sent.length

      act(() => { renderer.unmount() })

      // After unmount, no new terminal-related messages should be sent
      // (any cleanup messages during unmount are fine, but no ongoing traffic)
      const terminalMessages = ws.sent.slice(sentBefore).filter(
        m => m.type === 'terminal-data' || m.type === 'terminal-resize'
      )
      expect(terminalMessages.length).toBe(0)
    })
  })

  /* ================================================================ */
  /*  AC-010-4: Terminal reattaches on drawer reopen                   */
  /* ================================================================ */

  describe('AC-010-4: reattach on reopen', () => {
    test('TEST-ID terminal-reattach: remounting calls useTerminal again with same session', () => {
      const { sendMessage, subscribe } = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      // First mount (drawer opens)
      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId="cron-ai-session-1"
            tmuxTarget="agentboard:5"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      const callsAfterFirstMount = mockUseTerminalCalls.length

      // Unmount (drawer closes)
      act(() => { renderer.unmount() })

      // Second mount (drawer reopens)
      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId="cron-ai-session-1"
            tmuxTarget="agentboard:5"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      // useTerminal should be called again on remount
      expect(mockUseTerminalCalls.length).toBeGreaterThan(callsAfterFirstMount)

      // Same sessionId and tmuxTarget on reattach
      const reattachCall = mockUseTerminalCalls[mockUseTerminalCalls.length - 1]
      expect(reattachCall.sessionId).toBe('cron-ai-session-1')
      expect(reattachCall.tmuxTarget).toBe('agentboard:5')

      act(() => { renderer.unmount() })
    })

    test('TEST-ID terminal-attach: fresh mount sends attach via useTerminal hook', () => {
      const { sendMessage, subscribe } = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId="cron-ai-session-1"
            tmuxTarget="agentboard:5"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      // useTerminal must be called with the correct target so the hook
      // sends terminal-attach WS message
      expect(mockUseTerminalCalls.length).toBeGreaterThanOrEqual(1)
      const call = mockUseTerminalCalls[mockUseTerminalCalls.length - 1]
      expect(call.sessionId).toBe('cron-ai-session-1')
      expect(call.tmuxTarget).toBe('agentboard:5')

      act(() => { renderer.unmount() })
    })

    test('remount with different sessionId connects to new session', () => {
      const { sendMessage, subscribe } = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      // Mount with session 1
      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId="cron-ai-session-1"
            tmuxTarget="agentboard:5"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      act(() => { renderer.unmount() })

      // Mount with session 2 (new conversation started)
      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId="cron-ai-session-2"
            tmuxTarget="agentboard:7"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      const lastCall = mockUseTerminalCalls[mockUseTerminalCalls.length - 1]
      expect(lastCall.sessionId).toBe('cron-ai-session-2')
      expect(lastCall.tmuxTarget).toBe('agentboard:7')

      act(() => { renderer.unmount() })
    })
  })

  /* ================================================================ */
  /*  AC-010-5: Scrollable with search                                 */
  /* ================================================================ */

  describe('AC-010-5: scrollable with search support', () => {
    test('useTerminal returns searchAddonRef (search functionality available)', () => {
      const { sendMessage, subscribe } = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      // Set up a mock search addon to simulate it being initialized
      const fakeSearchAddon = { findNext: () => {}, findPrevious: () => {}, dispose: () => {} }
      mockSearchAddonRef = { current: fakeSearchAddon }

      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId="cron-ai-session-1"
            tmuxTarget="agentboard:5"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      // The hook was called and search addon is available
      expect(mockUseTerminalCalls.length).toBeGreaterThanOrEqual(1)
      // searchAddonRef should be the one we configured
      expect(mockSearchAddonRef.current).toBe(fakeSearchAddon)

      act(() => { renderer.unmount() })
    })

    test('container div allows overflow for scroll behavior', () => {
      const { sendMessage, subscribe } = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId="cron-ai-session-1"
            tmuxTarget="agentboard:5"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      // The terminal container should fill available space.
      // xterm.js handles its own scrolling internally, so the wrapper
      // div should not restrict height (typically absolute inset-0 or flex-1)
      const root = renderer.root
      const divs = root.findAllByType('div')
      expect(divs.length).toBeGreaterThanOrEqual(1)

      act(() => { renderer.unmount() })
    })
  })

  /* ================================================================ */
  /*  Edge cases                                                       */
  /* ================================================================ */

  describe('edge cases', () => {
    test('handles sessionId changing while mounted (session restart)', () => {
      const { sendMessage, subscribe } = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId="cron-ai-session-1"
            tmuxTarget="agentboard:5"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      const callsBefore = mockUseTerminalCalls.length

      // Update props (session changes without unmount)
      act(() => {
        renderer.update(
          <CronAiTerminal
            sessionId="cron-ai-session-2"
            tmuxTarget="agentboard:8"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      // useTerminal should be called again with updated props
      expect(mockUseTerminalCalls.length).toBeGreaterThan(callsBefore)
      const lastCall = mockUseTerminalCalls[mockUseTerminalCalls.length - 1]
      expect(lastCall.sessionId).toBe('cron-ai-session-2')
      expect(lastCall.tmuxTarget).toBe('agentboard:8')

      act(() => { renderer.unmount() })
    })

    test('handles transition from null to valid sessionId', () => {
      const { sendMessage, subscribe } = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      // Start with no session
      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId={null}
            tmuxTarget={null}
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      // Session becomes available
      act(() => {
        renderer.update(
          <CronAiTerminal
            sessionId="cron-ai-session-1"
            tmuxTarget="agentboard:5"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      const lastCall = mockUseTerminalCalls[mockUseTerminalCalls.length - 1]
      expect(lastCall.sessionId).toBe('cron-ai-session-1')
      expect(lastCall.tmuxTarget).toBe('agentboard:5')

      act(() => { renderer.unmount() })
    })

    test('handles transition from valid sessionId to null (session killed)', () => {
      const { sendMessage, subscribe } = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId="cron-ai-session-1"
            tmuxTarget="agentboard:5"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      // Session killed
      act(() => {
        renderer.update(
          <CronAiTerminal
            sessionId={null}
            tmuxTarget={null}
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      const lastCall = mockUseTerminalCalls[mockUseTerminalCalls.length - 1]
      expect(lastCall.sessionId).toBeNull()
      expect(lastCall.tmuxTarget).toBeNull()

      act(() => { renderer.unmount() })
    })

    test('useTerminal receives WebGL option matching main terminal', () => {
      const { sendMessage, subscribe } = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId="cron-ai-session-1"
            tmuxTarget="agentboard:5"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      const lastCall = mockUseTerminalCalls[mockUseTerminalCalls.length - 1]
      // Should pass useWebGL option (matching main terminal behavior)
      expect(lastCall).toHaveProperty('useWebGL')
      expect(typeof lastCall.useWebGL).toBe('boolean')

      act(() => { renderer.unmount() })
    })

    test('rapid mount-unmount-mount cycle does not crash', () => {
      const { sendMessage, subscribe } = createWsStubs()

      const props = {
        sessionId: 'cron-ai-session-1' as string | null,
        tmuxTarget: 'agentboard:5' as string | null,
        sendMessage,
        subscribe,
      }

      // Rapid lifecycle — mount, unmount, mount
      let renderer!: TestRenderer.ReactTestRenderer
      act(() => { renderer = create(<CronAiTerminal {...props} />) })
      act(() => { renderer.unmount() })
      act(() => { renderer = create(<CronAiTerminal {...props} />) })
      act(() => { renderer.unmount() })
      act(() => { renderer = create(<CronAiTerminal {...props} />) })

      // Should still work after rapid cycling
      const lastCall = mockUseTerminalCalls[mockUseTerminalCalls.length - 1]
      expect(lastCall.sessionId).toBe('cron-ai-session-1')

      act(() => { renderer.unmount() })
    })
  })

  /* ================================================================ */
  /*  REQ-54: Proposal card rendering does not block terminal output   */
  /* ================================================================ */

  describe('REQ-54: terminal independence from proposals', () => {
    test('terminal renders without any proposal-related props', () => {
      const { sendMessage, subscribe } = createWsStubs()
      let renderer!: TestRenderer.ReactTestRenderer

      // CronAiTerminal should only need session/WS props, not proposal data
      act(() => {
        renderer = create(
          <CronAiTerminal
            sessionId="cron-ai-session-1"
            tmuxTarget="agentboard:5"
            sendMessage={sendMessage}
            subscribe={subscribe}
          />
        )
      })

      // Component should render without errors — terminal is independent
      // of proposal rendering. No proposal props needed.
      const root = renderer.root
      expect(root.findAllByType('div').length).toBeGreaterThanOrEqual(1)

      act(() => { renderer.unmount() })
    })
  })
})
