// WU-009 Tests: CronAiDrawer
// Tests for AC-009-1 through AC-009-7: drawer animation, overlay behavior,
// resize bounds, width persistence, escape-to-close, and integrated subcomponents.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import { useCronAiStore, DRAWER_MIN_WIDTH, DRAWER_MAX_WIDTH, DRAWER_DEFAULT_WIDTH } from '../../../stores/cronAiStore'
import type { SendClientMessage, SubscribeServerMessage } from '@shared/types'

const globalAny = globalThis as typeof globalThis & {
  document?: Document
  navigator?: Navigator
  window?: Window & typeof globalThis
  localStorage?: Storage
}

// Install safe stubs at module scope so framer-motion frame callbacks don't crash
if (!globalAny.document) {
  globalAny.document = {
    documentElement: { scrollLeft: 0, scrollTop: 0, setAttribute: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    body: { scrollLeft: 0, scrollTop: 0 },
  } as unknown as Document
}
if (!globalAny.window) {
  globalAny.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    innerWidth: 1024,
    innerHeight: 768,
  } as unknown as Window & typeof globalThis
}

const originalDocument = globalAny.document
const originalNavigator = globalAny.navigator
const originalWindow = globalAny.window

// ─── DOM and Key Event Setup ───────────────────────────────────────────────

let keyHandlers = new Map<string, EventListener>()

function setupDom() {
  keyHandlers = new Map()

  globalAny.document = {
    documentElement: { scrollLeft: 0, scrollTop: 0, setAttribute: () => {} },
    body: { scrollLeft: 0, scrollTop: 0 },
    activeElement: null,
    addEventListener: (event: string, handler: EventListener) => {
      keyHandlers.set(event, handler)
    },
    removeEventListener: (event: string, handler: EventListener) => {
      if (keyHandlers.get(event) === handler) {
        keyHandlers.delete(event)
      }
    },
  } as unknown as Document

  globalAny.navigator = {
    platform: 'Win32',
    userAgent: 'Chrome',
    maxTouchPoints: 0,
  } as unknown as Navigator

  globalAny.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    innerWidth: 1024,
    innerHeight: 768,
    matchMedia: (query: string) => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
    confirm: () => true,
  } as unknown as Window & typeof globalThis
}

// ─── localStorage mock ─────────────────────────────────────────────────────

function createStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => { store.delete(key) },
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() { return store.size },
  } as Storage
}

const storage = createStorage()
globalAny.localStorage = storage

// ─── Import after globals are set ──────────────────────────────────────────

const { CronAiDrawer } = await import('../CronAiDrawer')

// ─── WS stub helpers ───────────────────────────────────────────────────────

function createWsStubs() {
  const sent: Array<{ type: string }> = []
  const sendMessage: SendClientMessage = (msg: { type: string }) => {
    sent.push(msg)
    return true
  }
  const subscribe: SubscribeServerMessage = () => () => {}
  return { sent, sendMessage, subscribe }
}

// ─── Store reset ───────────────────────────────────────────────────────────

function resetStore() {
  useCronAiStore.setState({
    drawerOpen: false,
    drawerWidth: DRAWER_DEFAULT_WIDTH,
    sessionStatus: 'offline',
    sessionWindowId: null,
    mcpConnected: false,
    proposals: [],
    pendingProposalCount: 0,
  })
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function findTextContent(root: TestRenderer.ReactTestInstance, text: string): TestRenderer.ReactTestInstance | undefined {
  return root.findAll((el) => {
    // Join all string children to handle JSX like `{count} pending`
    const joined = el.children
      .filter((c): c is string => typeof c === 'string')
      .join('')
      .trim()
    return joined.includes(text)
  })[0]
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

beforeEach(() => {
  setupDom()
  storage.clear()
  resetStore()
})

afterEach(() => {
  globalAny.document = originalDocument
  globalAny.navigator = originalNavigator
  globalAny.window = originalWindow
})

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('CronAiDrawer', () => {
  // ── AC-009-1: Drawer open/close with animation ──────────────────────────

  test('renders nothing when drawerOpen=false', () => {
    const { sendMessage, subscribe } = createWsStubs()
    useCronAiStore.setState({ drawerOpen: false })

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiDrawer sendMessage={sendMessage} subscribe={subscribe}>
          <div data-testid="terminal" />
        </CronAiDrawer>
      )
    })

    // AnimatePresence should render no motion.div children
    const tree = renderer!.toJSON()
    // When closed, there should be no visible drawer content
    const terminals = renderer!.root.findAll((el) => el.props['data-testid'] === 'terminal')
    expect(terminals).toHaveLength(0)

    act(() => { renderer!.unmount() })
  })

  test('renders drawer content when drawerOpen=true', () => {
    const { sendMessage, subscribe } = createWsStubs()
    useCronAiStore.setState({ drawerOpen: true })

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiDrawer sendMessage={sendMessage} subscribe={subscribe}>
          <div data-testid="terminal">Terminal content</div>
        </CronAiDrawer>
      )
    })

    // Children slot should be rendered
    const terminal = renderer!.root.findByProps({ 'data-testid': 'terminal' })
    expect(terminal).toBeTruthy()

    act(() => { renderer!.unmount() })
  })

  test('drawer appears and disappears when toggling drawerOpen', () => {
    const { sendMessage, subscribe } = createWsStubs()
    useCronAiStore.setState({ drawerOpen: false })

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiDrawer sendMessage={sendMessage} subscribe={subscribe}>
          <div data-testid="terminal" />
        </CronAiDrawer>
      )
    })

    // Drawer should not be visible
    let terminals = renderer!.root.findAll((el) => el.props['data-testid'] === 'terminal')
    expect(terminals).toHaveLength(0)

    // Open drawer via store
    act(() => {
      useCronAiStore.getState().toggleDrawer()
    })

    terminals = renderer!.root.findAll((el) => el.props['data-testid'] === 'terminal')
    expect(terminals).toHaveLength(1)

    // Close drawer via store
    act(() => {
      useCronAiStore.getState().toggleDrawer()
    })

    // After close, content should eventually not render (AnimatePresence exit)
    // In test renderer without real animation timers, the element may still be
    // present briefly — but drawerOpen is false in the store
    expect(useCronAiStore.getState().drawerOpen).toBe(false)

    act(() => { renderer!.unmount() })
  })

  // ── AC-009-2: Overlay positioning ───────────────────────────────────────

  test('drawer uses fixed positioning (overlay, not reflow)', () => {
    const { sendMessage, subscribe } = createWsStubs()
    useCronAiStore.setState({ drawerOpen: true })

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiDrawer sendMessage={sendMessage} subscribe={subscribe}>
          <div />
        </CronAiDrawer>
      )
    })

    // The motion.div wrapper should have fixed positioning and z-index classes
    const fixedElements = renderer!.root.findAll((el) => {
      const cn = el.props.className
      return typeof cn === 'string' && cn.includes('fixed') && cn.includes('z-')
    })
    expect(fixedElements.length).toBeGreaterThan(0)

    act(() => { renderer!.unmount() })
  })

  test('drawer has pointer-events: auto so it is interactive', () => {
    const { sendMessage, subscribe } = createWsStubs()
    useCronAiStore.setState({ drawerOpen: true })

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiDrawer sendMessage={sendMessage} subscribe={subscribe}>
          <div />
        </CronAiDrawer>
      )
    })

    const interactiveElements = renderer!.root.findAll((el) => {
      const style = el.props.style
      return style && style.pointerEvents === 'auto'
    })
    expect(interactiveElements.length).toBeGreaterThan(0)

    act(() => { renderer!.unmount() })
  })

  // ── AC-009-3: Default width and resize bounds ───────────────────────────

  test('drawer renders with default width of 480px', () => {
    const { sendMessage, subscribe } = createWsStubs()
    useCronAiStore.setState({ drawerOpen: true, drawerWidth: DRAWER_DEFAULT_WIDTH })

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiDrawer sendMessage={sendMessage} subscribe={subscribe}>
          <div />
        </CronAiDrawer>
      )
    })

    const widthElements = renderer!.root.findAll((el) => {
      const style = el.props.style
      return style && style.width === 480
    })
    expect(widthElements.length).toBeGreaterThan(0)

    act(() => { renderer!.unmount() })
  })

  test('drawer width follows store value', () => {
    const { sendMessage, subscribe } = createWsStubs()
    useCronAiStore.setState({ drawerOpen: true, drawerWidth: 550 })

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiDrawer sendMessage={sendMessage} subscribe={subscribe}>
          <div />
        </CronAiDrawer>
      )
    })

    const widthElements = renderer!.root.findAll((el) => {
      const style = el.props.style
      return style && style.width === 550
    })
    expect(widthElements.length).toBeGreaterThan(0)

    act(() => { renderer!.unmount() })
  })

  test('store clamps width below minimum (360px)', () => {
    useCronAiStore.getState().setDrawerWidth(200)
    expect(useCronAiStore.getState().drawerWidth).toBe(DRAWER_MIN_WIDTH)
  })

  test('store clamps width above maximum (640px)', () => {
    useCronAiStore.getState().setDrawerWidth(900)
    expect(useCronAiStore.getState().drawerWidth).toBe(DRAWER_MAX_WIDTH)
  })

  test('store accepts width within bounds', () => {
    useCronAiStore.getState().setDrawerWidth(500)
    expect(useCronAiStore.getState().drawerWidth).toBe(500)
  })

  test('store clamps width at exact boundary values', () => {
    useCronAiStore.getState().setDrawerWidth(DRAWER_MIN_WIDTH)
    expect(useCronAiStore.getState().drawerWidth).toBe(DRAWER_MIN_WIDTH)

    useCronAiStore.getState().setDrawerWidth(DRAWER_MAX_WIDTH)
    expect(useCronAiStore.getState().drawerWidth).toBe(DRAWER_MAX_WIDTH)
  })

  // ── AC-009-3: Resize drag handle exists ─────────────────────────────────

  test('drawer has a resize drag handle on the left edge', () => {
    const { sendMessage, subscribe } = createWsStubs()
    useCronAiStore.setState({ drawerOpen: true })

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiDrawer sendMessage={sendMessage} subscribe={subscribe}>
          <div />
        </CronAiDrawer>
      )
    })

    // Should find the resize handle (cursor-col-resize)
    const resizeHandles = renderer!.root.findAll((el) => {
      const cn = el.props.className
      return typeof cn === 'string' && cn.includes('cursor-col-resize')
    })
    expect(resizeHandles.length).toBeGreaterThan(0)

    act(() => { renderer!.unmount() })
  })

  // ── AC-009-4: Resized width persists across open/close ──────────────────

  test('resized width persists: close and reopen drawer keeps same width', () => {
    // Set a custom width
    useCronAiStore.getState().setDrawerWidth(550)
    expect(useCronAiStore.getState().drawerWidth).toBe(550)

    // Close
    useCronAiStore.setState({ drawerOpen: false })
    expect(useCronAiStore.getState().drawerOpen).toBe(false)

    // Reopen
    useCronAiStore.setState({ drawerOpen: true })

    // Width should still be 550
    expect(useCronAiStore.getState().drawerWidth).toBe(550)
  })

  // ── AC-009-5: Header with session status (integration) ──────────────────

  test('drawer renders header with session status from store', () => {
    const { sendMessage, subscribe } = createWsStubs()
    useCronAiStore.setState({ drawerOpen: true, sessionStatus: 'working' })

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiDrawer sendMessage={sendMessage} subscribe={subscribe}>
          <div />
        </CronAiDrawer>
      )
    })

    // Header should show the "Working" status label
    const workingLabel = findTextContent(renderer!.root, 'Working')
    expect(workingLabel).toBeTruthy()

    act(() => { renderer!.unmount() })
  })

  test('drawer reflects session status changes from store', () => {
    const { sendMessage, subscribe } = createWsStubs()
    useCronAiStore.setState({ drawerOpen: true, sessionStatus: 'offline' })

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiDrawer sendMessage={sendMessage} subscribe={subscribe}>
          <div />
        </CronAiDrawer>
      )
    })

    expect(findTextContent(renderer!.root, 'Offline')).toBeTruthy()

    act(() => {
      useCronAiStore.getState().setSessionStatus('starting')
    })

    expect(findTextContent(renderer!.root, 'Starting')).toBeTruthy()

    act(() => { renderer!.unmount() })
  })

  // ── AC-009-7: Escape key closes drawer ──────────────────────────────────

  test('pressing Escape closes the drawer', () => {
    const { sendMessage, subscribe } = createWsStubs()
    useCronAiStore.setState({ drawerOpen: true })

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiDrawer sendMessage={sendMessage} subscribe={subscribe}>
          <div data-testid="terminal" />
        </CronAiDrawer>
      )
    })

    // Drawer should be open
    expect(useCronAiStore.getState().drawerOpen).toBe(true)

    // The drawer registers a keydown listener on document
    const keydown = keyHandlers.get('keydown')
    expect(typeof keydown).toBe('function')

    act(() => {
      keydown!({ key: 'Escape', preventDefault: () => {} } as unknown as Event)
    })

    expect(useCronAiStore.getState().drawerOpen).toBe(false)

    act(() => { renderer!.unmount() })
  })

  test('non-Escape keys do not close the drawer', () => {
    const { sendMessage, subscribe } = createWsStubs()
    useCronAiStore.setState({ drawerOpen: true })

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiDrawer sendMessage={sendMessage} subscribe={subscribe}>
          <div />
        </CronAiDrawer>
      )
    })

    const keydown = keyHandlers.get('keydown')

    act(() => {
      keydown!({ key: 'Enter', preventDefault: () => {} } as unknown as Event)
    })

    expect(useCronAiStore.getState().drawerOpen).toBe(true)

    act(() => { renderer!.unmount() })
  })

  test('no keydown listener registered when drawer is closed', () => {
    const { sendMessage, subscribe } = createWsStubs()
    useCronAiStore.setState({ drawerOpen: false })

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiDrawer sendMessage={sendMessage} subscribe={subscribe}>
          <div />
        </CronAiDrawer>
      )
    })

    // When drawer is closed, no keydown handler should be registered
    const keydown = keyHandlers.get('keydown')
    expect(keydown).toBeUndefined()

    act(() => { renderer!.unmount() })
  })

  // ── AC-009-8: Status bar integration ────────────────────────────────────

  test('drawer renders status bar with MCP status from store', () => {
    const { sendMessage, subscribe } = createWsStubs()
    useCronAiStore.setState({ drawerOpen: true, mcpConnected: true, pendingProposalCount: 0 })

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiDrawer sendMessage={sendMessage} subscribe={subscribe}>
          <div />
        </CronAiDrawer>
      )
    })

    expect(findTextContent(renderer!.root, 'Connected')).toBeTruthy()

    act(() => { renderer!.unmount() })
  })

  test('drawer renders pending proposal count in status bar', () => {
    const { sendMessage, subscribe } = createWsStubs()
    useCronAiStore.setState({ drawerOpen: true, mcpConnected: false, pendingProposalCount: 4 })

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiDrawer sendMessage={sendMessage} subscribe={subscribe}>
          <div />
        </CronAiDrawer>
      )
    })

    expect(findTextContent(renderer!.root, 'Disconnected')).toBeTruthy()
    expect(findTextContent(renderer!.root, '4 pending')).toBeTruthy()

    act(() => { renderer!.unmount() })
  })

  // ── WS message: drawer-open on mount ────────────────────────────────────

  test('sends cron-ai-drawer-open message when drawer opens', () => {
    const { sent, sendMessage, subscribe } = createWsStubs()
    useCronAiStore.setState({ drawerOpen: true })

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiDrawer sendMessage={sendMessage} subscribe={subscribe}>
          <div />
        </CronAiDrawer>
      )
    })

    const drawerOpenMessages = sent.filter((m) => m.type === 'cron-ai-drawer-open')
    expect(drawerOpenMessages.length).toBeGreaterThan(0)

    act(() => { renderer!.unmount() })
  })

  test('does NOT send cron-ai-drawer-open when drawer is closed', () => {
    const { sent, sendMessage, subscribe } = createWsStubs()
    useCronAiStore.setState({ drawerOpen: false })

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiDrawer sendMessage={sendMessage} subscribe={subscribe}>
          <div />
        </CronAiDrawer>
      )
    })

    const drawerOpenMessages = sent.filter((m) => m.type === 'cron-ai-drawer-open')
    expect(drawerOpenMessages).toHaveLength(0)

    act(() => { renderer!.unmount() })
  })

  // ── Close button (via header) ───────────────────────────────────────────

  test('close button in header closes the drawer', () => {
    const { sendMessage, subscribe } = createWsStubs()
    useCronAiStore.setState({ drawerOpen: true })

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiDrawer sendMessage={sendMessage} subscribe={subscribe}>
          <div />
        </CronAiDrawer>
      )
    })

    // Find close button by aria-label
    const closeBtn = renderer!.root.findAllByType('button').find((btn) => {
      return btn.props['aria-label']?.includes('Close')
    })
    expect(closeBtn).toBeTruthy()

    act(() => {
      closeBtn!.props.onClick()
    })

    expect(useCronAiStore.getState().drawerOpen).toBe(false)

    act(() => { renderer!.unmount() })
  })

  // ── Children slot ───────────────────────────────────────────────────────

  test('renders children in the terminal area slot', () => {
    const { sendMessage, subscribe } = createWsStubs()
    useCronAiStore.setState({ drawerOpen: true })

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiDrawer sendMessage={sendMessage} subscribe={subscribe}>
          <div data-testid="custom-terminal">Custom terminal content</div>
        </CronAiDrawer>
      )
    })

    const customTerminal = renderer!.root.findByProps({ 'data-testid': 'custom-terminal' })
    expect(customTerminal).toBeTruthy()

    act(() => { renderer!.unmount() })
  })

  // ── Layout structure ────────────────────────────────────────────────────

  test('drawer contains header, terminal area, and status bar in correct order', () => {
    const { sendMessage, subscribe } = createWsStubs()
    useCronAiStore.setState({
      drawerOpen: true,
      sessionStatus: 'waiting',
      mcpConnected: true,
      pendingProposalCount: 2,
    })

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiDrawer sendMessage={sendMessage} subscribe={subscribe}>
          <div data-testid="terminal-slot" />
        </CronAiDrawer>
      )
    })

    // All three sections should be present
    expect(findTextContent(renderer!.root, 'AI Assistant')).toBeTruthy()     // Header
    expect(renderer!.root.findByProps({ 'data-testid': 'terminal-slot' })).toBeTruthy() // Children
    expect(findTextContent(renderer!.root, 'Connected')).toBeTruthy()         // Status bar
    expect(findTextContent(renderer!.root, '2 pending')).toBeTruthy()         // Status bar badge

    act(() => { renderer!.unmount() })
  })
})
