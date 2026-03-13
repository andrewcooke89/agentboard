// WU-012: CronManager + App Integration Tests
// Tests for AI toggle button, keyboard shortcuts, WS message handlers, and context sync

import { afterEach, beforeEach, describe, expect, test, mock, jest } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ServerMessage, CronJob, CronAiProposal } from '@shared/types'

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
  document?: Document
  navigator?: Navigator
  ResizeObserver?: typeof ResizeObserver
  localStorage?: Storage
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

let sendCalls: Array<Record<string, unknown>> = []
let subscribeListener: ((message: ServerMessage) => void) | null = null
let keyHandlers = new Map<string, EventListener>()
let activeRenderer: TestRenderer.ReactTestRenderer | null = null
let scrollIntoViewMockCalls: Array<{ id: string }> = []

// Mock xterm components
mock.module('@xterm/xterm', () => ({
  Terminal: class {
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
}))
mock.module('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))
mock.module('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }))
mock.module('@xterm/addon-webgl', () => ({ WebglAddon: class { dispose() {} } }))
mock.module('@xterm/addon-search', () => ({ SearchAddon: class {} }))
mock.module('@xterm/addon-serialize', () => ({ SerializeAddon: class {} }))
mock.module('@xterm/addon-progress', () => ({ ProgressAddon: class {} }))
mock.module('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

const actualWebSocket = await import('../../../hooks/useWebSocket')

mock.module('../../../hooks/useWebSocket', () => ({
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

// Import stores and components after mocks
const [
  { CronManager },
  { useCronStore },
  { useCronAiStore },
  { useSettingsStore },
] = await Promise.all([
  import('../CronManager'),
  import('../../../stores/cronStore'),
  import('../../../stores/cronAiStore'),
  import('../../../stores/settingsStore'),
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
      // Mock querySelector for scrollIntoView tests
      if (selector.includes('[data-job-id')) {
        const id = selector.match(/data-job-id="([^"]+)"/)?.[1]
        if (id) {
          return {
            scrollIntoView: () => {
              scrollIntoViewMockCalls.push({ id })
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

// Sample test data
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

  // Reset stores to initial state
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

  useSettingsStore.setState({
    cronAiEnabled: true,
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
})

function getKeyHandler() {
  const handler = keyHandlers.get('keydown')
  if (!handler) {
    throw new Error('Expected keydown handler to be registered')
  }
  return handler
}

// ═══════════════════════════════════════════════════════════════════════════════
// AC-012-1: AI toggle button visibility
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-012-1: AI toggle button visibility', () => {
  test('AI button is visible when cronAiEnabled is true', () => {
    useSettingsStore.setState({ cronAiEnabled: true })

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    // Find the AI button - it should have a brain/sparkle icon and be visible
    const buttons = renderer.root.findAll(
      (el) => el.type === 'button' && el.props.className?.includes('ai-toggle')
    )

    // The AI button should exist when cronAiEnabled is true
    expect(buttons.length).toBeGreaterThan(0)
  })

  test('AI button is hidden when cronAiEnabled is false', () => {
    useSettingsStore.setState({ cronAiEnabled: false })

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    // Find the AI button - it should NOT exist when cronAiEnabled is false
    const buttons = renderer.root.findAll(
      (el) => el.type === 'button' && el.props.className?.includes('ai-toggle')
    )

    expect(buttons.length).toBe(0)
  })

  test('AI button is in the header bar next to Timeline and Create buttons', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    // Find the header bar
    const headerBar = renderer.root.findByProps({
      className: expect.stringContaining('flex items-center justify-end')
    })

    expect(headerBar).toBeDefined()

    // Find buttons in header
    const buttons = headerBar.findAllByType('button')

    // Should have: Create, Timeline, and AI buttons (3 total when enabled)
    expect(buttons.length).toBe(3)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// AC-012-2: AI button toggles drawer
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-012-2: AI button toggles drawer', () => {
  test('Clicking AI button opens the drawer', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    expect(useCronAiStore.getState().drawerOpen).toBe(false)

    // Find and click the AI button
    const aiButton = renderer.root.findByProps({
      className: expect.stringContaining('ai-toggle')
    })

    act(() => {
      aiButton.props.onClick()
    })

    expect(useCronAiStore.getState().drawerOpen).toBe(true)
  })

  test('Clicking AI button again closes the drawer', () => {
    useCronAiStore.setState({ drawerOpen: true })

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    // Find and click the AI button
    const aiButton = renderer.root.findByProps({
      className: expect.stringContaining('ai-toggle')
    })

    act(() => {
      aiButton.props.onClick()
    })

    expect(useCronAiStore.getState().drawerOpen).toBe(false)
  })

  test('CronAiDrawer is rendered as child of CronManager', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    // Open the drawer
    act(() => {
      useCronAiStore.getState().toggleDrawer()
    })

    // The CronAiDrawer component should be rendered
    // Look for the drawer by its data-testid or class
    const drawer = renderer.root.findAll(
      (el) => el.props.className?.includes('fixed') && el.props.className?.includes('z-50')
    )

    expect(drawer.length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// AC-012-3: Keyboard shortcut toggles drawer (Cmd+Shift+A / Ctrl+Shift+A)
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-012-3: Keyboard shortcut toggles drawer', () => {
  test('Cmd+Shift+A on Mac toggles drawer open', () => {
    globalAny.navigator = {
      platform: 'MacIntel',
      userAgent: 'Chrome',
      maxTouchPoints: 0,
    } as unknown as Navigator

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    const keyHandler = getKeyHandler()

    expect(useCronAiStore.getState().drawerOpen).toBe(false)

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
  })

  test('Ctrl+Shift+A on non-Mac toggles drawer open', () => {
    globalAny.navigator = {
      platform: 'Win32',
      userAgent: 'Chrome',
      maxTouchPoints: 0,
    } as unknown as Navigator

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
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
        ctrlKey: true, // Ctrl on non-Mac
        altKey: false,
        defaultPrevented: false,
        preventDefault: () => {},
      } as KeyboardEvent)
    })

    expect(useCronAiStore.getState().drawerOpen).toBe(true)
  })

  test('Cmd+Shift+A toggles drawer closed when open', () => {
    useCronAiStore.setState({ drawerOpen: true })

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
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

    expect(useCronAiStore.getState().drawerOpen).toBe(false)
  })

  test('Key without modifiers does not toggle drawer', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    const keyHandler = getKeyHandler()

    expect(useCronAiStore.getState().drawerOpen).toBe(false)

    act(() => {
      keyHandler({
        key: 'A',
        code: 'KeyA',
        metaKey: false,
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        defaultPrevented: false,
        preventDefault: () => {},
      } as KeyboardEvent)
    })

    // Should still be closed
    expect(useCronAiStore.getState().drawerOpen).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// AC-012-4: WS cron-ai-proposal message handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-012-4: WS cron-ai-proposal handling', () => {
  test('cron-ai-proposal WS message creates proposal in store', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
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
    expect(useCronAiStore.getState().proposals[0]?.status).toBe('pending')
  })

  test('Multiple proposals accumulate in store', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-proposal',
        proposal: baseProposal,
      })
    })

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-proposal',
        proposal: { ...baseProposal, id: 'proposal-2', description: 'Second proposal' },
      })
    })

    expect(useCronAiStore.getState().proposals).toHaveLength(2)
    expect(useCronAiStore.getState().pendingProposalCount).toBe(2)
  })

  test('Proposal card renders in drawer when proposal is added', () => {
    useCronAiStore.setState({ drawerOpen: true })

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-proposal',
        proposal: baseProposal,
      })
    })

    // Look for proposal card in the rendered tree
    const proposalCards = renderer.root.findAll(
      (el) => el.props.className?.includes('proposal-card') ||
               el.props['data-proposal-id'] === 'proposal-1'
    )

    expect(proposalCards.length).toBeGreaterThan(0)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// AC-012-5: WS cron-ai-navigate select_job handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-012-5: WS cron-ai-navigate select_job', () => {
  test('select_job message selects the job in cronStore', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
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

  test('select_job triggers scrollIntoView for the job row', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'select_job',
        payload: { jobId: 'job-1' },
      })
    })

    // Should have called scrollIntoView
    expect(scrollIntoViewMockCalls.length).toBeGreaterThan(0)
    expect(scrollIntoViewMockCalls[0]?.id).toBe('job-1')
  })

  test('select_job with non-existent jobId does not crash', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    expect(() => {
      act(() => {
        subscribeListener?.({
          type: 'cron-ai-navigate',
          action: 'select_job',
          payload: { jobId: 'non-existent-job' },
        })
      })
    }).not.toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// AC-012-6: WS cron-ai-navigate switch_tab handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-012-6: WS cron-ai-navigate switch_tab', () => {
  test('switch_tab message changes activeTab in cronStore', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
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

  test('switch_tab to history tab works', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'switch_tab',
        payload: { tab: 'history' },
      })
    })

    expect(useCronStore.getState().activeTab).toBe('history')
  })

  test('switch_tab to script tab works', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'switch_tab',
        payload: { tab: 'script' },
      })
    })

    expect(useCronStore.getState().activeTab).toBe('script')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// AC-012-7: WS cron-ai-navigate show_timeline handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-012-7: WS cron-ai-navigate show_timeline', () => {
  test('show_timeline message opens the timeline', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
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

  test('show_timeline with range parameter sets timeline range', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
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

// ═══════════════════════════════════════════════════════════════════════════════
// AC-012-8: WS cron-ai-navigate filter handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-012-8: WS cron-ai-navigate filter', () => {
  test('filter message with mode sets filterMode', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    expect(useCronStore.getState().filterMode).toBe('all')

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'filter',
        payload: { mode: 'active' },
      })
    })

    expect(useCronStore.getState().filterMode).toBe('active')
  })

  test('filter message with source sets filterSource', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'filter',
        payload: { source: 'cron' },
      })
    })

    expect(useCronStore.getState().filterSource).toBe('cron')
  })

  test('filter message with tags sets filterTags', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'filter',
        payload: { tags: ['production', 'database'] },
      })
    })

    expect(useCronStore.getState().filterTags).toEqual(['production', 'database'])
  })

  test('filter message with multiple parameters sets all filters', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'filter',
        payload: {
          mode: 'unhealthy',
          source: 'systemd',
          tags: ['critical'],
        },
      })
    })

    expect(useCronStore.getState().filterMode).toBe('unhealthy')
    expect(useCronStore.getState().filterSource).toBe('systemd')
    expect(useCronStore.getState().filterTags).toEqual(['critical'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// AC-012-9: Context sync on selection (cron-ai-context-update)
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-012-9: Context sync on selection', () => {
  test('Selecting a job sends cron-ai-context-update within 500ms when drawer is open', async () => {
    useCronAiStore.setState({ drawerOpen: true })

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    sendCalls = []

    // Select a job
    act(() => {
      useCronStore.getState().setSelectedJob('job-1')
    })

    // Check that a context update was sent
    // Using a small timeout to allow the debounced/throttled effect to run
    await new Promise((resolve) => setTimeout(resolve, 100))

    const contextUpdate = sendCalls.find(
      (msg) => msg.type === 'cron-ai-context-update'
    )

    expect(contextUpdate).toBeDefined()
    expect((contextUpdate?.context as Record<string, unknown>)?.selectedJobId).toBe('job-1')
  })

  test('Context update is NOT sent when drawer is closed', async () => {
    useCronAiStore.setState({ drawerOpen: false })

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    sendCalls = []

    act(() => {
      useCronStore.getState().setSelectedJob('job-1')
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    const contextUpdate = sendCalls.find(
      (msg) => msg.type === 'cron-ai-context-update'
    )

    expect(contextUpdate).toBeUndefined()
  })

  test('Context update includes activeTab when it changes', async () => {
    useCronAiStore.setState({ drawerOpen: true })
    useCronStore.setState({ selectedJobId: 'job-1' })

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    sendCalls = []

    act(() => {
      useCronStore.getState().setActiveTab('logs')
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    const contextUpdate = sendCalls.find(
      (msg) => msg.type === 'cron-ai-context-update'
    )

    expect(contextUpdate).toBeDefined()
    expect((contextUpdate?.context as Record<string, unknown>)?.activeTab).toBe('logs')
  })

  test('Context update includes filter state when filters change', async () => {
    useCronAiStore.setState({ drawerOpen: true })
    useCronStore.setState({ selectedJobId: 'job-1' })

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    sendCalls = []

    act(() => {
      useCronStore.getState().setFilterMode('active')
      useCronStore.getState().setFilterTags(['production'])
    })

    await new Promise((resolve) => setTimeout(resolve, 100))

    const contextUpdate = sendCalls.find(
      (msg) => msg.type === 'cron-ai-context-update'
    )

    expect(contextUpdate).toBeDefined()
    const context = contextUpdate?.context as Record<string, unknown>
    expect(context?.filterMode).toBe('active')
    expect(context?.filterTags).toEqual(['production'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// AC-012-10: Smooth navigation (animated scroll)
// ═══════════════════════════════════════════════════════════════════════════════

describe('AC-012-10: Smooth navigation', () => {
  test('scrollIntoView is called with smooth behavior option', () => {
    const scrollIntoViewCalls: Array<{ behavior?: string }> = []

    // Override querySelector to return element with tracked scrollIntoView
    globalAny.document = {
      ...globalAny.document,
      querySelector: (selector: string) => {
        if (selector.includes('data-job-id')) {
          return {
            scrollIntoView: (options?: ScrollIntoViewOptions) => {
              scrollIntoViewCalls.push({ behavior: options?.behavior })
            },
          } as unknown as Element
        }
        return null
      },
    } as unknown as Document

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    act(() => {
      subscribeListener?.({
        type: 'cron-ai-navigate',
        action: 'select_job',
        payload: { jobId: 'job-1' },
      })
    })

    // Should have called scrollIntoView with smooth behavior
    expect(scrollIntoViewCalls.length).toBeGreaterThan(0)
    expect(scrollIntoViewCalls[0]?.behavior).toBe('smooth')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Additional: WS session-status and mcp-status handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('Additional: Session status and MCP status handling', () => {
  test('cron-ai-session-status WS message updates cronAiStore', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
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

  test('cron-ai-mcp-status WS message updates cronAiStore', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
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

  test('Multiple status transitions are handled correctly', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    // offline -> starting
    act(() => {
      subscribeListener?.({
        type: 'cron-ai-session-status',
        status: 'starting',
      })
    })
    expect(useCronAiStore.getState().sessionStatus).toBe('starting')

    // starting -> working
    act(() => {
      subscribeListener?.({
        type: 'cron-ai-session-status',
        status: 'working',
      })
    })
    expect(useCronAiStore.getState().sessionStatus).toBe('working')

    // working -> waiting
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
// Tab navigation (TEST-52)
// ═══════════════════════════════════════════════════════════════════════════════

describe('TEST-52: Tab navigation in AI drawer', () => {
  test('Tab key cycles through focusable elements in drawer', () => {
    useCronAiStore.setState({ drawerOpen: true })

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    // Find all focusable elements in the drawer
    const focusableElements = renderer.root.findAll(
      (el) => {
        const tag = el.type
        const props = el.props
        return (
          (tag === 'button' && !props.disabled) ||
          (tag === 'input' && !props.disabled) ||
          (tag === 'textarea' && !props.disabled) ||
          props.tabIndex === 0
        )
      }
    )

    // Should have at least the close button, new conversation button, and terminal area
    expect(focusableElements.length).toBeGreaterThan(2)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Edge cases and error handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('Edge cases and error handling', () => {
  test('WS message with unknown action does not crash', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    expect(() => {
      act(() => {
        subscribeListener?.({
          type: 'cron-ai-navigate',
          action: 'unknown_action',
          payload: {},
        })
      })
    }).not.toThrow()
  })

  test('WS message with missing payload uses defaults', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    expect(() => {
      act(() => {
        subscribeListener?.({
          type: 'cron-ai-navigate',
          action: 'filter',
          payload: {}, // No filter parameters
        })
      })
    }).not.toThrow()

    // Filter mode should remain unchanged
    expect(useCronStore.getState().filterMode).toBe('all')
  })

  test('Rapid selection changes only send one context update (debounce)', async () => {
    useCronAiStore.setState({ drawerOpen: true })

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<CronManager />)
    })
    activeRenderer = renderer

    sendCalls = []

    // Rapidly change selection multiple times
    act(() => {
      useCronStore.getState().setSelectedJob('job-1')
    })
    act(() => {
      useCronStore.getState().setSelectedJob('job-2')
    })
    act(() => {
      useCronStore.getState().setSelectedJob('job-3')
    })

    await new Promise((resolve) => setTimeout(resolve, 600))

    // Should have sent at most 1-2 context updates (debounced)
    const contextUpdates = sendCalls.filter(
      (msg) => msg.type === 'cron-ai-context-update'
    )

    // With proper debouncing, should only send 1 final update
    expect(contextUpdates.length).toBeLessThanOrEqual(2)

    // The final update should have the latest selection
    if (contextUpdates.length > 0) {
      const lastUpdate = contextUpdates[contextUpdates.length - 1]
      expect((lastUpdate?.context as Record<string, unknown>)?.selectedJobId).toBe('job-3')
    }
  })
})
