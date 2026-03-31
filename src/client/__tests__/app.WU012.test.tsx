// WU-012: App.tsx Cron AI Integration Tests
// Tests for Cmd+Shift+A keyboard shortcut and cron-ai-* WS message handlers in App component

import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ServerMessage, Session, CronAiProposal, CronJob } from '@shared/types'

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
  document?: Document
  navigator?: Navigator
  ResizeObserver?: typeof ResizeObserver
  localStorage?: Storage
  HTMLElement?: typeof HTMLElement
  Element?: typeof Element
  Node?: typeof Node
}

// Install safe stubs at module scope
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

const originalWindow = globalAny.window
const originalDocument = globalAny.document
const originalNavigator = globalAny.navigator
const originalResizeObserver = globalAny.ResizeObserver
const originalLocalStorage = globalAny.localStorage
const originalHTMLElement = globalAny.HTMLElement
const originalElement = globalAny.Element
const originalNode = globalAny.Node

let sendCalls: Array<Record<string, unknown>> = []
let subscribeListener: ((message: ServerMessage) => void) | null = null
let keyHandlers = new Map<string, EventListener>()
let activeRenderer: TestRenderer.ReactTestRenderer | null = null
let scrollIntoViewMockCalls: Array<{ id: string; behavior?: string }> = []

// Mock xterm
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

// Undo any module pollution from other test files
// @ts-expect-error bun cache-bust query string not understood by tsc
const _realWorkflowStore = await import('../stores/workflowStore.ts?real')
mock.module('../stores/workflowStore', () => _realWorkflowStore)

// Import stores and components after mocks
const [
  { default: App },
  { useSessionStore },
  { useSettingsStore },
  { useThemeStore },
  { useCronStore },
  { useCronAiStore },
] = await Promise.all([
  import('../App'),
  import('../stores/sessionStore'),
  import('../stores/settingsStore'),
  import('../stores/themeStore'),
  import('../stores/cronStore'),
  import('../stores/cronAiStore'),
])

function createStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size },
  } as Storage
}

function setupDom() {
  keyHandlers = new Map()
  scrollIntoViewMockCalls = []

  globalAny.localStorage = createStorage()
  globalAny.navigator = {
    platform: 'MacIntel',
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
    body: { scrollLeft: 0, scrollTop: 0 },
    querySelector: (selector: string) => {
      if (selector.includes('data-job-id')) {
        const id = selector.match(/data-job-id="([^"]+)"/)?.[1]
        if (id) {
          return {
            scrollIntoView: (options?: ScrollIntoViewOptions) => {
              scrollIntoViewMockCalls.push({ id, behavior: options?.behavior })
            },
          } as unknown as Element
        }
      }
      return null
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    getElementById: () => null,
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

const _baseSession: Session = {
  id: 'session-1',
  name: 'alpha',
  tmuxWindow: 'agentboard:1',
  projectPath: '/tmp/alpha',
  status: 'working',
  lastActivity: '2024-01-01T00:00:00.000Z',
  createdAt: '2024-01-01T00:00:00.000Z',
  source: 'managed',
}

const baseCronJob: CronJob = {
  id: 'job-1',
  name: 'backup-db',
  command: '/usr/local/bin/backup.sh',
  schedule: '0 2 * * *',
  scheduleHuman: 'At 02:00',
  scriptPath: null,
  source: 'user-crontab',
  status: 'active',
  health: 'healthy',
  healthReason: null,
  nextRun: '2024-01-02T02:00:00.000Z',
  lastRun: '2024-01-01T02:00:00.000Z',
  lastRunDuration: null,
  lastExitCode: null,
  consecutiveFailures: 0,
  avgDuration: null,
  user: 'andrew',
  requiresSudo: false,
  avatarUrl: null,
  unitFile: null,
  description: null,
  projectGroup: 'Backups',
  tags: ['production'],
  isManagedByAgentboard: true,
  linkedSessionId: null,
}

const baseProposal: CronAiProposal = {
  id: 'proposal-1',
  operation: 'create',
  jobId: null,
  jobName: 'backup-prod',
  jobAvatarUrl: null,
  description: 'Add a daily backup for the production database',
  diff: '+ 0 3 * * * /usr/local/bin/backup-prod.sh',
  status: 'pending',
  feedback: null,
  createdAt: '2024-01-01T12:00:00.000Z',
  resolvedAt: null,
}

beforeEach(() => {
  sendCalls = []
  subscribeListener = null
  scrollIntoViewMockCalls = []
  setupDom()
  activeRenderer = null

  useSessionStore.setState({
    sessions: [],
    agentSessions: { active: [], inactive: [] },
    selectedSessionId: null,
    hasLoaded: true,
    connectionStatus: 'connected',
    connectionError: null,
  })

  useSettingsStore.setState({
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
    showProjectName: true,
    showLastUserMessage: true,
    showSessionIdPrefix: false,
    shortcutModifier: 'auto',
    cronAiEnabled: true,
  })

  useThemeStore.setState({ theme: 'dark' })

  useCronStore.setState({
    jobs: [baseCronJob],
    selectedJobId: null,
    selectedJobDetail: null,
    loading: false,
    hasLoaded: true,
    systemdAvailable: true,
    searchQuery: '',
    sortMode: 'name',
    filterMode: 'all',
    filterSource: null,
    filterTags: [],
    collapsedGroups: new Set(),
    activeTab: 'overview',
    timelineVisible: false,
    timelineRange: '24h',
    selectedJobIds: new Set(),
    bulkSelectMode: false,
    runningJobs: new Set(),
    runOutputs: {},
    bulkProgress: null,
    notifications: [],
    desktopNotifTimestamps: {},
    sudoPromptVisible: false,
    sudoPromptOperation: null,
    sudoPromptJobId: null,
  })

  useCronAiStore.setState({
    drawerOpen: false,
    drawerWidth: 480,
    sessionStatus: 'offline',
    sessionWindowId: null,
    mcpConnected: false,
    proposals: [],
    pendingProposalCount: 0,
    autoStartSession: true,
  })
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
  globalAny.HTMLElement = originalHTMLElement
  globalAny.Element = originalElement
  globalAny.Node = originalNode

  // Ensure DOM constructor stubs are present on both globalAny and
  // globalAny.window after restore. floating-ui's isNode/isElement/isHTMLElement
  // check `value instanceof getWindow(node).Node`, where getWindow() falls back
  // to globalThis.window. If window.Node is undefined the instanceof throws
  // "Right hand side of instanceof is not an object", crashing SwitchRoot in
  // subsequent test files (e.g. settingsModal.test.tsx).
  if (!globalAny.Node) {
    class NodeStub {}
    class ElementStub extends NodeStub {}
    class HTMLElementStub extends ElementStub {}
    globalAny.Node = NodeStub as unknown as typeof Node
    globalAny.Element = ElementStub as unknown as typeof Element
    globalAny.HTMLElement = HTMLElementStub as unknown as typeof HTMLElement
  }
  if (globalAny.window) {
    const win = globalAny.window as unknown as Record<string, unknown>
    win.Node = globalAny.Node
    win.Element = globalAny.Element
    win.HTMLElement = globalAny.HTMLElement
  }
})

function getKeyHandler() {
  const handler = keyHandlers.get('keydown')
  if (!handler) {
    throw new Error('Expected keydown handler to be registered')
  }
  return handler
}

// ═══════════════════════════════════════════════════════════════════════════════
// AC-012-3: Cmd+Shift+A / Ctrl+Shift+A keyboard shortcut in App
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-012-3: Cmd+Shift+A keyboard shortcut in App', () => {
  test('Cmd+Shift+A toggles AI drawer from anywhere in app', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    const keyHandler = getKeyHandler()

    expect(useCronAiStore.getState().drawerOpen).toBe(false)

    // Simulate Cmd+Shift+A on Mac
    act(() => {
      keyHandler({
        key: 'A',
        code: 'KeyA',
        metaKey: true, // Cmd on Mac
        shiftKey: true,
        ctrlKey: false,
        altKey: false,
        defaultPrevented: false,
        preventDefault: () => {},
      } as KeyboardEvent)
    })

    expect(useCronAiStore.getState().drawerOpen).toBe(true)

    // Press again to close
    act(() => {
      keyHandler({
        key: 'A',
        code: 'KeyA',
        metaKey: true,
        shiftKey: true,
        ctrlKey: false,
        altKey: false,
        defaultPrevented: false,
        preventDefault: () => {},
      } as KeyboardEvent)
    })

    expect(useCronAiStore.getState().drawerOpen).toBe(false)
  })

  test('Ctrl+Shift+A toggles drawer on non-Mac platforms', () => {
    // Simulate Windows platform
    globalAny.navigator = {
      platform: 'Win32',
      userAgent: 'Chrome',
      maxTouchPoints: 0,
    } as unknown as Navigator

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    const keyHandler = getKeyHandler()

    expect(useCronAiStore.getState().drawerOpen).toBe(false)

    act(() => {
      keyHandler({
        key: 'A',
        code: 'KeyA',
        metaKey: false,
        shiftKey: true,
        ctrlKey: true,
        altKey: false,
        defaultPrevented: false,
        preventDefault: () => {},
      } as KeyboardEvent)
    })

    expect(useCronAiStore.getState().drawerOpen).toBe(true)
  })

  test('Shortcut does not work when cronAiEnabled is false', () => {
    useSettingsStore.setState({ cronAiEnabled: false })

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    const keyHandler = getKeyHandler()

    act(() => {
      keyHandler({
        key: 'A',
        code: 'KeyA',
        metaKey: true,
        shiftKey: true,
        ctrlKey: false,
        altKey: false,
        defaultPrevented: false,
        preventDefault: () => {},
      } as KeyboardEvent)
    })

    // Drawer should remain closed when feature is disabled
    expect(useCronAiStore.getState().drawerOpen).toBe(false)
  })

  test('Shortcut does not conflict with other Cmd+Shift+A handlers', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    const keyHandler = getKeyHandler()

    // preventDefault should be called
    let preventDefaultCalled = false
    act(() => {
      keyHandler({
        key: 'A',
        code: 'KeyA',
        metaKey: true,
        shiftKey: true,
        ctrlKey: false,
        altKey: false,
        defaultPrevented: false,
        preventDefault: () => { preventDefaultCalled = true },
      } as KeyboardEvent)
    })

    expect(preventDefaultCalled).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// AC-012-4: WS cron-ai-proposal handling in App
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-012-4: WS cron-ai-proposal handling in App', () => {
  test('cron-ai-proposal message is dispatched to cronAiStore.handleCronAiProposal', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    expect(useCronAiStore.getState().proposals).toHaveLength(0)

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-proposal',
        proposal: baseProposal,
      })
    })

    expect(useCronAiStore.getState().proposals).toHaveLength(1)
    expect(useCronAiStore.getState().proposals[0]?.id).toBe('proposal-1')
    expect(useCronAiStore.getState().pendingProposalCount).toBe(1)
  })

  test('proposal with different types are handled correctly', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    const editProposal: CronAiProposal = {
      ...baseProposal,
      id: 'proposal-edit',
      operation: 'edit_frequency',
      jobId: 'job-1',
      diff: '- 0 2 * * *\n+ 0 4 * * *',
    }

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-proposal',
        proposal: editProposal,
      })
    })

    expect(useCronAiStore.getState().proposals).toHaveLength(1)
    expect(useCronAiStore.getState().proposals[0]?.operation).toBe('edit_frequency')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// AC-012-5 through AC-012-8: WS cron-ai-navigate handling in App
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-012-5: WS cron-ai-navigate select_job in App', () => {
  test('select_job action updates cronStore.selectedJobId', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    expect(useCronStore.getState().selectedJobId).toBe(null)

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'select_job',
        payload: { jobId: 'job-1' },
      })
    })

    expect(useCronStore.getState().selectedJobId).toBe('job-1')
  })

  test('select_job scrolls job into view', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'select_job',
        payload: { jobId: 'job-1' },
      })
    })

    expect(scrollIntoViewMockCalls.length).toBeGreaterThan(0)
    expect(scrollIntoViewMockCalls[0]?.id).toBe('job-1')
    expect(scrollIntoViewMockCalls[0]?.behavior).toBe('smooth')
  })
})

describe('AC-012-6: WS cron-ai-navigate switch_tab in App', () => {
  test('switch_tab action updates cronStore.activeTab', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    expect(useCronStore.getState().activeTab).toBe('overview')

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'switch_tab',
        payload: { tab: 'logs' },
      })
    })

    expect(useCronStore.getState().activeTab).toBe('logs')
  })

  test('switch_tab handles all valid tabs', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    const tabs = ['overview', 'logs', 'history', 'script']

    for (const tab of tabs) {
      act(() => {
        subscribeListener?.({
          type: 'cron-ai-navigate',
          action: 'switch_tab',
          payload: { tab },
        })
      })

      expect(useCronStore.getState().activeTab).toBe(tab)
    }
  })
})

describe('AC-012-7: WS cron-ai-navigate show_timeline in App', () => {
  test('show_timeline action sets timelineVisible to true', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    expect(useCronStore.getState().timelineVisible).toBe(false)

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'show_timeline',
        payload: {},
      })
    })

    expect(useCronStore.getState().timelineVisible).toBe(true)
  })

  test('show_timeline with range updates timelineRange', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'show_timeline',
        payload: { range: '7d' },
      })
    })

    expect(useCronStore.getState().timelineVisible).toBe(true)
    expect(useCronStore.getState().timelineRange).toBe('7d')
  })
})

describe('AC-012-8: WS cron-ai-navigate filter in App', () => {
  test('filter action updates filterMode', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'filter',
        payload: { mode: 'active' },
      })
    })

    expect(useCronStore.getState().filterMode).toBe('active')
  })

  test('filter action updates filterSource', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'filter',
        payload: { source: 'systemd' },
      })
    })

    expect(useCronStore.getState().filterSource).toBe('systemd')
  })

  test('filter action updates filterTags', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'filter',
        payload: { tags: ['critical', 'production'] },
      })
    })

    expect(useCronStore.getState().filterTags).toEqual(['critical', 'production'])
  })

  test('filter action handles all parameters together', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'filter',
        payload: {
          mode: 'errors',
          source: 'cron',
          tags: ['backup'],
        },
      })
    })

    expect(useCronStore.getState().filterMode).toBe('errors')
    expect(useCronStore.getState().filterSource).toBe('cron')
    expect(useCronStore.getState().filterTags).toEqual(['backup'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Session status and MCP status WS handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('cron-ai-session-status and cron-ai-mcp-status WS handling', () => {
  test('cron-ai-session-status updates cronAiStore.sessionStatus', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    expect(useCronAiStore.getState().sessionStatus).toBe('offline')

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-session-status',
        status: 'working',
        windowId: 'agentboard-cron-ai:0',
      })
    })

    expect(useCronAiStore.getState().sessionStatus).toBe('working')
    expect(useCronAiStore.getState().sessionWindowId).toBe('agentboard-cron-ai:0')
  })

  test('cron-ai-mcp-status updates cronAiStore.mcpConnected', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    expect(useCronAiStore.getState().mcpConnected).toBe(false)

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-mcp-status',
        connected: true,
      })
    })

    expect(useCronAiStore.getState().mcpConnected).toBe(true)
  })

  test('All session status transitions are handled', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    const statuses: Array<'offline' | 'starting' | 'working' | 'waiting'> = [
      'offline', 'starting', 'working', 'waiting'
    ]

    for (const status of statuses) {
      act(() => {
        subscribeListener?.({
          type: 'cron-ai-session-status',
          status,
        })
      })

      expect(useCronAiStore.getState().sessionStatus).toBe(status)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Integration: Full navigation flow
// ═══════════════════════════════════════════════════════════════════════════════

describe('Integration: Full navigation flow', () => {
  test('Complete AI-driven navigation flow', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    // 1. Agent starts working
    act(() => {
      subscribeListener?.({
        type: 'cron-ai-session-status',
        status: 'working',
      })
    })
    expect(useCronAiStore.getState().sessionStatus).toBe('working')

    // 2. MCP connects
    act(() => {
      subscribeListener?.({
        type: 'cron-ai-mcp-status',
        connected: true,
      })
    })
    expect(useCronAiStore.getState().mcpConnected).toBe(true)

    // 3. Agent selects a job
    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'select_job',
        payload: { jobId: 'job-1' },
      })
    })
    expect(useCronStore.getState().selectedJobId).toBe('job-1')

    // 4. Agent switches to logs tab
    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'switch_tab',
        payload: { tab: 'logs' },
      })
    })
    expect(useCronStore.getState().activeTab).toBe('logs')

    // 5. Agent shows timeline
    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'show_timeline',
        payload: { range: '24h' },
      })
    })
    expect(useCronStore.getState().timelineVisible).toBe(true)

    // 6. Agent applies a filter
    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'filter',
        payload: { mode: 'unhealthy' },
      })
    })
    expect(useCronStore.getState().filterMode).toBe('unhealthy')

    // 7. Agent creates a proposal
    act(() => {
      subscribeListener?.({
        type: 'cron-ai-proposal',
        proposal: baseProposal,
      })
    })
    expect(useCronAiStore.getState().proposals).toHaveLength(1)

    // 8. Agent finishes and waits
    act(() => {
      subscribeListener?.({
        type: 'cron-ai-session-status',
        status: 'waiting',
      })
    })
    expect(useCronAiStore.getState().sessionStatus).toBe('waiting')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('Edge cases in WS message handling', () => {
  test('Unknown navigate action does not crash', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    expect(() => {
      act(() => {
        subscribeListener?.({
          type: 'cron-ai-navigate',
          action: 'unknown_action',
          payload: { foo: 'bar' },
        })
      })
    }).not.toThrow()
  })

  test('Missing payload in navigate action does not crash', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    expect(() => {
      act(() => {
        subscribeListener?.({
          type: 'cron-ai-navigate',
          action: 'select_job',
          payload: {}, // Missing jobId
        })
      })
    }).not.toThrow()
  })

  test('Invalid tab name does not crash', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    expect(() => {
      act(() => {
        subscribeListener?.({
          type: 'cron-ai-navigate',
          action: 'switch_tab',
          payload: { tab: 'invalid_tab' },
        })
      })
    }).not.toThrow()
  })

  test('Select non-existent job does not crash', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<App />)
    })
    activeRenderer = renderer

    expect(() => {
      act(() => {
        subscribeListener?.({
          type: 'cron-ai-navigate',
          action: 'select_job',
          payload: { jobId: 'non-existent' },
        })
      })
    }).not.toThrow()

    // Store should still be updated (even if job doesn't exist)
    expect(useCronStore.getState().selectedJobId).toBe('non-existent')
  })
})
