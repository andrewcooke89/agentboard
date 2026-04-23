import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ServerMessage, Session } from '@shared/types'

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
  document?: Document
  navigator?: Navigator
  ResizeObserver?: typeof ResizeObserver
  localStorage?: Storage
}

// Install safe stubs at module scope so that framer-motion frame callbacks leaked
// from prior test files (e.g. renderComponents.test.tsx) don't crash when accessing
// document.documentElement or window.innerWidth between afterAll and beforeEach.
if (!globalAny.document) {
  globalAny.document = {
    documentElement: { scrollLeft: 0, scrollTop: 0, setAttribute: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    body: { scrollLeft: 0, scrollTop: 0 },
  } as unknown as Document
}
if (!globalAny.window) {
  globalAny.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    innerWidth: 1024,
    innerHeight: 768,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  } as unknown as Window & typeof globalThis
}

// Mock fetch to prevent "URL is invalid" errors when App calls authFetch('/api/server-info')
const originalFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  // Return a mock response for any API calls
  if (url.includes('/api/')) {
    return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  }
  // Fall through to original fetch for other requests (shouldn't happen in tests)
  return originalFetch(input, init)
}) as typeof fetch

const originalWindow = globalAny.window
const originalDocument = globalAny.document
const originalNavigator = globalAny.navigator
const originalResizeObserver = globalAny.ResizeObserver
const originalLocalStorage = globalAny.localStorage

let sendCalls: Array<Record<string, unknown>> = []
let subscribeListener: ((message: ServerMessage) => void) | null = null
let keyHandlers = new Map<string, EventListener>()
let activeRenderer: TestRenderer.ReactTestRenderer | null = null

class TerminalMock {
  cols = 80
  rows = 24
  options: Record<string, unknown> = {}
  buffer = { active: { viewportY: 0, baseY: 0 } }
  element: HTMLElement | null = null

  loadAddon() {}
  open(container: HTMLElement) { this.element = container }
  reset() {}
  onData() {}
  onScroll() {}
  attachCustomKeyEventHandler() { return true }
  attachCustomWheelEventHandler() { return true }
  write() {}
  scrollToBottom() {}
  focus() {}
  hasSelection() { return false }
  getSelection() { return '' }
  dispose() {}
  refresh() {}
}

// Undo mock.module('../stores/workflowStore', ...) pollution from workflowEditor.test.tsx.
// bun's mock.module replaces the module globally and the poisoned version is already
// in the module cache before this file runs.  We re-register a complete enough stub
// that satisfies App's usage: useWorkflowStore(selector) and useWorkflowStore.getState().
const _workflowState = {
  workflows: [],
  workflowRuns: [],
  activeWorkflowId: null,
  loadingWorkflows: false,
  loadingRuns: false,
}
const _useWorkflowStore = Object.assign(
  (selector?: (s: typeof _workflowState) => unknown) =>
    typeof selector === 'function' ? selector(_workflowState) : _workflowState,
  { getState: () => _workflowState }
)
mock.module('../stores/workflowStore', () => ({
  useWorkflowStore: _useWorkflowStore,
  useActiveRuns: () => [],
  useRunsByWorkflow: () => [],
  useValidWorkflows: () => [],
  getActiveRuns: () => [],
  getRunsByWorkflow: () => [],
  getValidWorkflows: () => [],
}))

mock.module('@xterm/xterm', () => ({ Terminal: TerminalMock }))
mock.module('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
mock.module('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }))
mock.module('@xterm/addon-webgl', () => ({ WebglAddon: class { dispose() {} } }))
mock.module('@xterm/addon-search', () => ({ SearchAddon: class {} }))
mock.module('@xterm/addon-serialize', () => ({ SerializeAddon: class {} }))
mock.module('@xterm/addon-progress', () => ({ ProgressAddon: class {} }))
mock.module('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

const actualWebSocket = await import('../hooks/useWebSocket')

mock.module('../hooks/useWebSocket', () => ({
  ...actualWebSocket,
  useWebSocket: () => ({
    sendMessage: (message: Record<string, unknown>) => {
      sendCalls.push(message)
    },
    subscribe: (listener: (message: ServerMessage) => void) => {
      subscribeListener = listener
      return () => {
        subscribeListener = null
      }
    },
  }),
}))

// Import stores and components after mocks to ensure they use the mocked module context
const [{ default: App }, { default: SessionList }, { default: NewSessionModal }, { useSessionStore }, { useSettingsStore }, { useThemeStore }] =
  await Promise.all([
    import('../App'),
    import('../components/SessionList'),
    import('../components/NewSessionModal'),
    import('../stores/sessionStore'),
    import('../stores/settingsStore'),
    import('../stores/themeStore'),
  ])

function createStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

function setupDom() {
  keyHandlers = new Map()

  globalAny.localStorage = createStorage()
  globalAny.navigator = {
    platform: 'Win32',
    userAgent: 'Chrome',
    maxTouchPoints: 0,
    clipboard: { writeText: () => Promise.resolve() },
    vibrate: () => true,
  } as unknown as Navigator

  globalAny.document = {
    documentElement: {
      setAttribute: () => {},
      scrollLeft: 0,
      scrollTop: 0,
    },
    // framer-motion's DocumentProjectionNode reads document.body.scrollLeft/scrollTop
    body: { scrollLeft: 0, scrollTop: 0 },
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Document

  globalAny.window = {
    addEventListener: (event: string, handler: EventListener) => {
      keyHandlers.set(event, handler)
    },
    removeEventListener: (event: string) => {
      keyHandlers.delete(event)
    },
    innerWidth: 1024,
    innerHeight: 768,
    setTimeout: (() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as typeof clearTimeout,
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    devicePixelRatio: 1,
  } as unknown as Window & typeof globalThis

  globalAny.ResizeObserver = class ResizeObserverMock {
    private callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
    }
    observe() {
      this.callback([], this as unknown as ResizeObserver)
    }
    unobserve() {}
    disconnect() {}
  }
}

beforeEach(() => {
  sendCalls = []
  subscribeListener = null
  setupDom()
  activeRenderer = null

  useSessionStore.setState({
    sessions: [],
    agentSessions: { active: [], inactive: [] },
    selectedSessionId: null,
    hasLoaded: false,
    connectionStatus: 'connected',
    connectionError: null,
  })

  useSettingsStore.setState({
    sessionSortMode: 'created',
    sessionSortDirection: 'asc',
    showProjectName: true,
    showLastUserMessage: true,
    showSessionIdPrefix: false,
  })

  useThemeStore.setState({ theme: 'dark' })
})

afterEach(() => {
  if (activeRenderer) {
    act(() => {
      activeRenderer?.unmount()
    })
  }
  globalAny.window = originalWindow
  globalAny.document = originalDocument
  globalAny.navigator = originalNavigator
  globalAny.ResizeObserver = originalResizeObserver
  globalAny.localStorage = originalLocalStorage
  useSettingsStore.setState({
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
    showProjectName: true,
    showLastUserMessage: true,
    showSessionIdPrefix: false,
  })
})

const baseSession: Session = {
  id: 'session-1',
  name: 'alpha',
  tmuxWindow: 'agentboard:1',
  projectPath: '/tmp/alpha',
  status: 'working',
  lastActivity: '2024-01-01T00:00:00.000Z',
  createdAt: '2024-01-01T00:00:00.000Z',
  source: 'managed',
}

function getKeyHandler() {
  const handler = keyHandlers.get('keydown')
  if (!handler) {
    throw new Error('Expected keydown handler')
  }
  return handler
}

describe('App', () => {
  test('handles websocket messages and errors', () => {
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    if (!subscribeListener) {
      throw new Error('Expected websocket subscription')
    }

    const updated = { ...baseSession, status: 'waiting' as const }
    const created = { ...baseSession, id: 'session-2', name: 'beta' }

    act(() => {
      subscribeListener?.({ type: 'sessions', sessions: [baseSession] })
    })

    expect(useSessionStore.getState().sessions).toHaveLength(1)

    act(() => {
      subscribeListener?.({ type: 'session-update', session: updated })
    })

    expect(useSessionStore.getState().sessions[0]?.status).toBe('waiting')

    act(() => {
      subscribeListener?.({ type: 'session-created', session: created })
    })

    expect(useSessionStore.getState().selectedSessionId).toBe('session-2')

    act(() => {
      subscribeListener?.({ type: 'error', message: 'Boom' })
    })

    // Find the desktop sidebar SessionList (first one) - drawer also has one
    const sessionLists = renderer.root.findAllByType(SessionList)
    expect(sessionLists.length).toBeGreaterThan(0)
    expect(sessionLists[0].props.error).toBe('Boom')

  })

  test('handles keyboard shortcuts for navigation and actions', () => {
    const sessionB = {
      ...baseSession,
      id: 'session-2',
      name: 'beta',
      createdAt: '2024-01-02T00:00:00.000Z',
    }

    useSessionStore.setState({
      sessions: [baseSession, sessionB],
      selectedSessionId: baseSession.id,
      hasLoaded: true,
    })

    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    let keyHandler = getKeyHandler()

    act(() => {
      keyHandler({
        key: ']',
        code: 'BracketRight',
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        defaultPrevented: false,
        preventDefault: () => {},
      } as KeyboardEvent)
    })

    expect(useSessionStore.getState().selectedSessionId).toBe('session-2')

    keyHandler = getKeyHandler()

    act(() => {
      keyHandler({
        key: '[',
        code: 'BracketLeft',
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        defaultPrevented: false,
        preventDefault: () => {},
      } as KeyboardEvent)
    })

    expect(useSessionStore.getState().selectedSessionId).toBe('session-1')

    act(() => {
      keyHandler({
        key: 'n',
        code: 'KeyN',
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        defaultPrevented: false,
        preventDefault: () => {},
      } as KeyboardEvent)
    })

    const modal = renderer.root.findByType(NewSessionModal)
    expect(modal.props.isOpen).toBe(true)

    act(() => {
      modal.props.onClose()
    })

    keyHandler = getKeyHandler()

    act(() => {
      keyHandler({
        key: 'x',
        code: 'KeyX',
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
        metaKey: false,
        defaultPrevented: false,
        preventDefault: () => {},
      } as KeyboardEvent)
    })

    expect(sendCalls).toContainEqual({
      type: 'session-kill',
      sessionId: 'session-1',
    })

  })
})
