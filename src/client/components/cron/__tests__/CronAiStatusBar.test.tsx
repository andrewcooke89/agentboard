// WU-009 Tests: CronAiStatusBar
// Tests for AC-009-8: Status bar shows MCP connection status, selected job name,
// and pending proposal count badge.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'

const globalAny = globalThis as typeof globalThis & {
  document?: Document
  navigator?: Navigator
  window?: Window & typeof globalThis
}

// Minimal stubs required for React rendering in Bun test environment
const originalDocument = globalAny.document
const originalNavigator = globalAny.navigator
const originalWindow = globalAny.window

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
  } as unknown as Window & typeof globalThis
}

const { CronAiStatusBar } = await import('../CronAiStatusBar')

beforeEach(() => {
  setupDom()
})

afterEach(() => {
  globalAny.document = originalDocument
  globalAny.navigator = originalNavigator
  globalAny.window = originalWindow
})

// ─── Helper ────────────────────────────────────────────────────────────────

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

function findDot(root: TestRenderer.ReactTestInstance, colorClass: string): TestRenderer.ReactTestInstance | undefined {
  return root.findAll((el) => {
    const cn = el.props.className
    return typeof cn === 'string' && cn.includes('rounded-full') && cn.includes(colorClass)
  })[0]
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('CronAiStatusBar', () => {
  // ── AC-009-8: MCP connection status ─────────────────────────────────────

  test('shows green dot and "Connected" when mcpConnected=true', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiStatusBar mcpConnected={true} selectedJobName={null} pendingCount={0} />
      )
    })

    const greenDot = findDot(renderer!.root, 'bg-green')
    expect(greenDot).toBeTruthy()

    const connectedText = findTextContent(renderer!.root, 'Connected')
    expect(connectedText).toBeTruthy()

    act(() => { renderer!.unmount() })
  })

  test('shows red dot and "Disconnected" when mcpConnected=false', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiStatusBar mcpConnected={false} selectedJobName={null} pendingCount={0} />
      )
    })

    const redDot = findDot(renderer!.root, 'bg-red')
    expect(redDot).toBeTruthy()

    const disconnectedText = findTextContent(renderer!.root, 'Disconnected')
    expect(disconnectedText).toBeTruthy()

    act(() => { renderer!.unmount() })
  })

  // ── AC-009-8: Selected job context ──────────────────────────────────────

  test('shows "No job selected" when selectedJobName is null', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiStatusBar mcpConnected={true} selectedJobName={null} pendingCount={0} />
      )
    })

    const noJob = findTextContent(renderer!.root, 'No job selected')
    expect(noJob).toBeTruthy()

    act(() => { renderer!.unmount() })
  })

  test('shows "Viewing: <jobname>" when selectedJobName is set', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiStatusBar mcpConnected={true} selectedJobName="daily-backup" pendingCount={0} />
      )
    })

    const jobText = findTextContent(renderer!.root, 'Viewing: daily-backup')
    expect(jobText).toBeTruthy()

    act(() => { renderer!.unmount() })
  })

  // ── AC-009-8: Pending proposal count badge ──────────────────────────────

  test('shows pending count badge when pendingCount > 0', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiStatusBar mcpConnected={true} selectedJobName={null} pendingCount={3} />
      )
    })

    const badge = findTextContent(renderer!.root, '3 pending')
    expect(badge).toBeTruthy()

    act(() => { renderer!.unmount() })
  })

  test('hides pending count badge when pendingCount is 0', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiStatusBar mcpConnected={true} selectedJobName={null} pendingCount={0} />
      )
    })

    const badge = findTextContent(renderer!.root, 'pending')
    expect(badge).toBeUndefined()

    act(() => { renderer!.unmount() })
  })

  test('shows correct count for single pending proposal', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiStatusBar mcpConnected={false} selectedJobName="log-rotate" pendingCount={1} />
      )
    })

    const badge = findTextContent(renderer!.root, '1 pending')
    expect(badge).toBeTruthy()

    act(() => { renderer!.unmount() })
  })

  // ── Combined state ──────────────────────────────────────────────────────

  test('renders all three indicators simultaneously', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <CronAiStatusBar mcpConnected={true} selectedJobName="hourly-sync" pendingCount={5} />
      )
    })

    // MCP connected
    expect(findTextContent(renderer!.root, 'Connected')).toBeTruthy()
    // Job selected
    expect(findTextContent(renderer!.root, 'Viewing: hourly-sync')).toBeTruthy()
    // Pending badge
    expect(findTextContent(renderer!.root, '5 pending')).toBeTruthy()

    act(() => { renderer!.unmount() })
  })
})
