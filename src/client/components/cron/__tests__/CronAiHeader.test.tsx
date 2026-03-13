// WU-009 Tests: CronAiHeader
// Tests for AC-009-5 (session status indicator), AC-009-6 (new conversation confirmation).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { CronAiSessionStatus } from '../../../stores/cronAiStore'

const globalAny = globalThis as typeof globalThis & {
  document?: Document
  navigator?: Navigator
  window?: Window & typeof globalThis
  confirm?: (message?: string) => boolean
}

const originalDocument = globalAny.document
const originalNavigator = globalAny.navigator
const originalWindow = globalAny.window
const originalConfirm = globalAny.confirm

function setupDom() {
  globalAny.document = {
    documentElement: { scrollLeft: 0, scrollTop: 0, setAttribute: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    body: { scrollLeft: 0, scrollTop: 0 },
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
    confirm: () => true,
  } as unknown as Window & typeof globalThis
}

const { CronAiHeader } = await import('../CronAiHeader')

beforeEach(() => {
  setupDom()
})

afterEach(() => {
  globalAny.document = originalDocument
  globalAny.navigator = originalNavigator
  globalAny.window = originalWindow
  globalAny.confirm = originalConfirm
})

// ─── Helpers ───────────────────────────────────────────────────────────────

function findTextContent(root: TestRenderer.ReactTestInstance, text: string): TestRenderer.ReactTestInstance | undefined {
  return root.findAll((el) => {
    if (typeof el.children[0] === 'string' && el.children[0].includes(text)) return true
    return false
  })[0]
}

function findDot(root: TestRenderer.ReactTestInstance, colorClass: string): TestRenderer.ReactTestInstance | undefined {
  return root.findAll((el) => {
    const cn = el.props.className
    return typeof cn === 'string' && cn.includes('rounded-full') && cn.includes(colorClass)
  })[0]
}

function findButton(root: TestRenderer.ReactTestInstance, match: string): TestRenderer.ReactTestInstance | undefined {
  return root.findAllByType('button').find((btn) => {
    const title = btn.props.title || ''
    const ariaLabel = btn.props['aria-label'] || ''
    const children = btn.props.children
    const text = typeof children === 'string' ? children : ''
    return title.includes(match) || ariaLabel.includes(match) || text.includes(match)
  })
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('CronAiHeader', () => {
  // ── Title ───────────────────────────────────────────────────────────────

  test('renders "AI Assistant" title', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiHeader sessionStatus="offline" onNewConversation={() => {}} onClose={() => {}} />
      )
    })

    const title = findTextContent(renderer!.root, 'AI Assistant')
    expect(title).toBeTruthy()

    act(() => { renderer!.unmount() })
  })

  // ── AC-009-5: Session status indicator ──────────────────────────────────

  test('shows gray dot and "Offline" for offline status', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiHeader sessionStatus="offline" onNewConversation={() => {}} onClose={() => {}} />
      )
    })

    const dot = findDot(renderer!.root, 'bg-zinc-500')
    expect(dot).toBeTruthy()
    expect(findTextContent(renderer!.root, 'Offline')).toBeTruthy()

    act(() => { renderer!.unmount() })
  })

  test('shows yellow pulsing dot and "Starting" for starting status', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiHeader sessionStatus="starting" onNewConversation={() => {}} onClose={() => {}} />
      )
    })

    const dot = findDot(renderer!.root, 'bg-yellow-400')
    expect(dot).toBeTruthy()
    expect(dot!.props.className).toContain('animate-pulse')
    expect(findTextContent(renderer!.root, 'Starting')).toBeTruthy()

    act(() => { renderer!.unmount() })
  })

  test('shows green pulsing dot and "Working" for working status', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiHeader sessionStatus="working" onNewConversation={() => {}} onClose={() => {}} />
      )
    })

    const dot = findDot(renderer!.root, 'bg-green-400')
    expect(dot).toBeTruthy()
    expect(dot!.props.className).toContain('animate-pulse')
    expect(findTextContent(renderer!.root, 'Working')).toBeTruthy()

    act(() => { renderer!.unmount() })
  })

  test('shows blue dot and "Waiting" for waiting status', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiHeader sessionStatus="waiting" onNewConversation={() => {}} onClose={() => {}} />
      )
    })

    const dot = findDot(renderer!.root, 'bg-blue-400')
    expect(dot).toBeTruthy()
    // Waiting should NOT pulse
    expect(dot!.props.className).not.toContain('animate-pulse')
    expect(findTextContent(renderer!.root, 'Waiting')).toBeTruthy()

    act(() => { renderer!.unmount() })
  })

  test('all four statuses produce different colored dots', () => {
    const statuses: CronAiSessionStatus[] = ['offline', 'starting', 'working', 'waiting']
    const expectedColors = ['bg-zinc-500', 'bg-yellow-400', 'bg-green-400', 'bg-blue-400']
    const expectedLabels = ['Offline', 'Starting', 'Working', 'Waiting']

    for (let i = 0; i < statuses.length; i++) {
      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiHeader sessionStatus={statuses[i]} onNewConversation={() => {}} onClose={() => {}} />
        )
      })

      const dot = findDot(renderer!.root, expectedColors[i])
      expect(dot).toBeTruthy()

      const label = findTextContent(renderer!.root, expectedLabels[i])
      expect(label).toBeTruthy()

      act(() => { renderer!.unmount() })
    }
  })

  // ── AC-009-6: New Conversation button ───────────────────────────────────

  test('has a "New Chat" / "New Conversation" button', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiHeader sessionStatus="working" onNewConversation={() => {}} onClose={() => {}} />
      )
    })

    const btn = findButton(renderer!.root, 'new conversation') ?? findButton(renderer!.root, 'New Chat')
    expect(btn).toBeTruthy()

    act(() => { renderer!.unmount() })
  })

  test('New Conversation button calls onNewConversation callback', () => {
    const calls: number[] = []
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiHeader sessionStatus="working" onNewConversation={() => calls.push(1)} onClose={() => {}} />
      )
    })

    const btn = findButton(renderer!.root, 'new conversation') ?? findButton(renderer!.root, 'New Chat')
    expect(btn).toBeTruthy()

    act(() => {
      btn!.props.onClick()
    })

    expect(calls).toHaveLength(1)

    act(() => { renderer!.unmount() })
  })

  // ── AC-009-6: Confirmation dialog ───────────────────────────────────────
  // The WU spec says: "New Conversation button shows confirmation dialog
  // before proceeding." The actual confirmation logic lives in CronAiDrawer's
  // handleNewConversation callback, but we still test the button triggers it.

  // ── Close button ────────────────────────────────────────────────────────

  test('has a close button with aria-label', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiHeader sessionStatus="offline" onNewConversation={() => {}} onClose={() => {}} />
      )
    })

    const closeBtn = findButton(renderer!.root, 'Close')
    expect(closeBtn).toBeTruthy()

    act(() => { renderer!.unmount() })
  })

  test('close button calls onClose callback', () => {
    const closeCalls: number[] = []
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiHeader sessionStatus="offline" onNewConversation={() => {}} onClose={() => closeCalls.push(1)} />
      )
    })

    const closeBtn = findButton(renderer!.root, 'Close')
    act(() => {
      closeBtn!.props.onClick()
    })

    expect(closeCalls).toHaveLength(1)

    act(() => { renderer!.unmount() })
  })
})
