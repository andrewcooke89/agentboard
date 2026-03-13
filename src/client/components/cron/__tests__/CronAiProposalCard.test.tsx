// WU-011 Tests: CronAiProposalCard
// Tests for AC-011-1 through AC-011-7: card content, diff formatting per operation,
// four visual states with color coding, reject feedback flow, scroll persistence,
// ARIA accessibility, and async rendering behavior.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { CronAiProposal, CronAiProposalOperation } from '@shared/types'

const globalAny = globalThis as typeof globalThis & {
  document?: Document
  navigator?: Navigator
  window?: Window & typeof globalThis
  localStorage?: Storage
}

// Install safe stubs at module scope so React doesn't crash on import
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

// ─── DOM Setup ──────────────────────────────────────────────────────────────

function setupDom() {
  globalAny.document = {
    documentElement: { scrollLeft: 0, scrollTop: 0, setAttribute: () => {} },
    body: { scrollLeft: 0, scrollTop: 0 },
    activeElement: null,
    addEventListener: () => {},
    removeEventListener: () => {},
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
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  } as unknown as Window & typeof globalThis
}

// ─── localStorage mock ──────────────────────────────────────────────────────

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

// ─── Import after globals ───────────────────────────────────────────────────

const { CronAiProposalCard } = await import('../CronAiProposalCard')

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeProposal(overrides: Partial<CronAiProposal> = {}): CronAiProposal {
  return {
    id: 'prop-1',
    operation: 'create',
    jobId: null,
    jobName: 'Test Job',
    jobAvatarUrl: null,
    description: 'Create a test cron job',
    diff: '+ * * * * * echo test',
    status: 'pending',
    feedback: null,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    ...overrides,
  }
}

function findTextContent(
  root: TestRenderer.ReactTestInstance,
  text: string,
): TestRenderer.ReactTestInstance | undefined {
  return root.findAll((el) => {
    const joined = el.children
      .filter((c): c is string => typeof c === 'string')
      .join('')
      .trim()
    return joined.includes(text)
  })[0]
}

function findAllTextContent(
  root: TestRenderer.ReactTestInstance,
  text: string,
): TestRenderer.ReactTestInstance[] {
  return root.findAll((el) => {
    const joined = el.children
      .filter((c): c is string => typeof c === 'string')
      .join('')
      .trim()
    return joined.includes(text)
  })
}

function findByClassName(
  root: TestRenderer.ReactTestInstance,
  partial: string,
): TestRenderer.ReactTestInstance[] {
  return root.findAll((el) => {
    const cn = el.props.className
    return typeof cn === 'string' && cn.includes(partial)
  })
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

beforeEach(() => {
  setupDom()
  storage.clear()
})

afterEach(() => {
  globalAny.document = originalDocument
  globalAny.navigator = originalNavigator
  globalAny.window = originalWindow
})

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('CronAiProposalCard', () => {
  // ── AC-011-1: Card shows all content fields for pending proposals ───────

  describe('card-pending-state (AC-011-1, AC-011-3)', () => {
    test('renders operation type badge for pending proposal', () => {
      const proposal = makeProposal({ operation: 'create', status: 'pending' })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      // Should display the operation type
      expect(findTextContent(renderer!.root, 'Create')).toBeTruthy()

      act(() => { renderer!.unmount() })
    })

    test('renders job name for pending proposal', () => {
      const proposal = makeProposal({ jobName: 'backup-db', status: 'pending' })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      expect(findTextContent(renderer!.root, 'backup-db')).toBeTruthy()

      act(() => { renderer!.unmount() })
    })

    test('renders diff preview for pending proposal', () => {
      const proposal = makeProposal({
        diff: '+ * * * * * echo test',
        status: 'pending',
      })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      expect(findTextContent(renderer!.root, '* * * * * echo test')).toBeTruthy()

      act(() => { renderer!.unmount() })
    })

    test('renders description/reasoning text for pending proposal', () => {
      const proposal = makeProposal({
        description: 'Run backup every minute for testing',
        status: 'pending',
      })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      expect(findTextContent(renderer!.root, 'Run backup every minute for testing')).toBeTruthy()

      act(() => { renderer!.unmount() })
    })

    test('renders Accept and Reject buttons for pending proposal', () => {
      const proposal = makeProposal({ status: 'pending' })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      const buttons = renderer!.root.findAllByType('button')
      const acceptBtn = buttons.find(
        (btn) => btn.props['aria-label']?.includes('Accept')
      )
      const rejectBtn = buttons.find(
        (btn) => btn.props['aria-label']?.includes('Reject')
      )

      expect(acceptBtn).toBeTruthy()
      expect(rejectBtn).toBeTruthy()

      act(() => { renderer!.unmount() })
    })

    test('pending card has blue border styling', () => {
      const proposal = makeProposal({ status: 'pending' })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      // Should have blue border class (border-blue-*)
      const blueElements = findByClassName(renderer!.root, 'border-blue')
      expect(blueElements.length).toBeGreaterThan(0)

      act(() => { renderer!.unmount() })
    })

    test('pending card buttons are enabled (not disabled)', () => {
      const proposal = makeProposal({ status: 'pending' })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      const buttons = renderer!.root.findAllByType('button')
      const actionButtons = buttons.filter(
        (btn) =>
          btn.props['aria-label']?.includes('Accept') ||
          btn.props['aria-label']?.includes('Reject')
      )
      for (const btn of actionButtons) {
        expect(btn.props.disabled).not.toBe(true)
      }

      act(() => { renderer!.unmount() })
    })

    test('renders job avatar when avatarUrl is provided', () => {
      const proposal = makeProposal({
        jobAvatarUrl: 'https://example.com/avatar.png',
        status: 'pending',
      })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      const imgs = renderer!.root.findAllByType('img')
      const avatar = imgs.find((img) => img.props.src === 'https://example.com/avatar.png')
      expect(avatar).toBeTruthy()

      act(() => { renderer!.unmount() })
    })

    test('renders fallback icon when avatarUrl is null', () => {
      const proposal = makeProposal({ jobAvatarUrl: null, status: 'pending' })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      // Should NOT have an img with avatar src
      const imgs = renderer!.root.findAllByType('img')
      const avatar = imgs.find((img) => img.props.src?.includes('avatar'))
      expect(avatar).toBeUndefined()

      act(() => { renderer!.unmount() })
    })
  })

  // ── AC-011-3: Accepted state ──────────────────────────────────────────────

  describe('card-accepted-state (AC-011-3)', () => {
    test('accepted card shows green border', () => {
      const proposal = makeProposal({ status: 'accepted', resolvedAt: new Date().toISOString() })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      const greenElements = findByClassName(renderer!.root, 'border-green')
      expect(greenElements.length).toBeGreaterThan(0)

      act(() => { renderer!.unmount() })
    })

    test('accepted card shows "Approved" badge', () => {
      const proposal = makeProposal({ status: 'accepted', resolvedAt: new Date().toISOString() })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      expect(findTextContent(renderer!.root, 'Approved')).toBeTruthy()

      act(() => { renderer!.unmount() })
    })

    test('accepted card has disabled buttons', () => {
      const proposal = makeProposal({ status: 'accepted', resolvedAt: new Date().toISOString() })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      const buttons = renderer!.root.findAllByType('button')
      const actionButtons = buttons.filter(
        (btn) =>
          btn.props['aria-label']?.includes('Accept') ||
          btn.props['aria-label']?.includes('Reject')
      )
      for (const btn of actionButtons) {
        expect(btn.props.disabled).toBe(true)
      }

      act(() => { renderer!.unmount() })
    })
  })

  // ── AC-011-3: Rejected state ──────────────────────────────────────────────

  describe('card-rejected-state (AC-011-3)', () => {
    test('rejected card shows red border', () => {
      const proposal = makeProposal({
        status: 'rejected',
        feedback: 'Schedule is too frequent',
        resolvedAt: new Date().toISOString(),
      })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      const redElements = findByClassName(renderer!.root, 'border-red')
      expect(redElements.length).toBeGreaterThan(0)

      act(() => { renderer!.unmount() })
    })

    test('rejected card shows "Rejected" badge', () => {
      const proposal = makeProposal({
        status: 'rejected',
        feedback: 'Too aggressive',
        resolvedAt: new Date().toISOString(),
      })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      expect(findTextContent(renderer!.root, 'Rejected')).toBeTruthy()

      act(() => { renderer!.unmount() })
    })

    test('rejected card shows feedback text', () => {
      const proposal = makeProposal({
        status: 'rejected',
        feedback: 'Schedule is too frequent',
        resolvedAt: new Date().toISOString(),
      })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      expect(findTextContent(renderer!.root, 'Schedule is too frequent')).toBeTruthy()

      act(() => { renderer!.unmount() })
    })

    test('rejected card has disabled buttons', () => {
      const proposal = makeProposal({
        status: 'rejected',
        feedback: 'Nope',
        resolvedAt: new Date().toISOString(),
      })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      const buttons = renderer!.root.findAllByType('button')
      const actionButtons = buttons.filter(
        (btn) =>
          btn.props['aria-label']?.includes('Accept') ||
          btn.props['aria-label']?.includes('Reject')
      )
      for (const btn of actionButtons) {
        expect(btn.props.disabled).toBe(true)
      }

      act(() => { renderer!.unmount() })
    })
  })

  // ── AC-011-3: Expired state ───────────────────────────────────────────────

  describe('card-expired-state (AC-011-3)', () => {
    test('expired card shows gray border', () => {
      const proposal = makeProposal({
        status: 'expired',
        resolvedAt: new Date().toISOString(),
      })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      const grayElements = findByClassName(renderer!.root, 'border-gray')
      expect(grayElements.length).toBeGreaterThan(0)

      act(() => { renderer!.unmount() })
    })

    test('expired card shows "Expired" badge', () => {
      const proposal = makeProposal({
        status: 'expired',
        resolvedAt: new Date().toISOString(),
      })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      expect(findTextContent(renderer!.root, 'Expired')).toBeTruthy()

      act(() => { renderer!.unmount() })
    })

    test('expired card has disabled buttons', () => {
      const proposal = makeProposal({
        status: 'expired',
        resolvedAt: new Date().toISOString(),
      })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      const buttons = renderer!.root.findAllByType('button')
      const actionButtons = buttons.filter(
        (btn) =>
          btn.props['aria-label']?.includes('Accept') ||
          btn.props['aria-label']?.includes('Reject')
      )
      for (const btn of actionButtons) {
        expect(btn.props.disabled).toBe(true)
      }

      act(() => { renderer!.unmount() })
    })
  })

  // ── AC-011-2: Diff formatting per operation type ──────────────────────────

  describe('card-diff-create (AC-011-2)', () => {
    test('create proposal shows full job config in diff (command, schedule, tags)', () => {
      const proposal = makeProposal({
        operation: 'create',
        diff: 'command: echo hello\nschedule: * * * * * (Every minute)\ntags: ["backup"]',
        status: 'pending',
      })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      expect(findTextContent(renderer!.root, 'echo hello')).toBeTruthy()
      expect(findTextContent(renderer!.root, '* * * * *')).toBeTruthy()

      act(() => { renderer!.unmount() })
    })
  })

  describe('card-diff-edit (AC-011-2)', () => {
    test('edit frequency shows old and new schedule with human-readable text', () => {
      const proposal = makeProposal({
        operation: 'edit_frequency',
        diff: '"0 3 * * *" (At 3 AM) \u2192 "0 4 * * *" (At 4 AM)',
        status: 'pending',
      })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      expect(findTextContent(renderer!.root, '0 3 * * *')).toBeTruthy()
      expect(findTextContent(renderer!.root, '0 4 * * *')).toBeTruthy()
      // Should show the arrow transition indicator
      expect(findTextContent(renderer!.root, '\u2192')).toBeTruthy()

      act(() => { renderer!.unmount() })
    })
  })

  describe('card-diff-delete (AC-011-2)', () => {
    test('delete proposal shows full job summary in diff', () => {
      const proposal = makeProposal({
        operation: 'delete',
        jobName: 'old-backup',
        diff: 'Job: old-backup\nCommand: /usr/bin/backup.sh\nSchedule: 0 2 * * *',
        status: 'pending',
      })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      expect(findTextContent(renderer!.root, 'old-backup')).toBeTruthy()
      expect(findTextContent(renderer!.root, '/usr/bin/backup.sh')).toBeTruthy()

      act(() => { renderer!.unmount() })
    })
  })

  describe('card-diff-pause-resume (AC-011-2)', () => {
    test('pause proposal shows "active \u2192 paused" state transition', () => {
      const proposal = makeProposal({
        operation: 'pause',
        diff: 'active \u2192 paused',
        status: 'pending',
      })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      expect(findTextContent(renderer!.root, 'active')).toBeTruthy()
      expect(findTextContent(renderer!.root, 'paused')).toBeTruthy()

      act(() => { renderer!.unmount() })
    })

    test('resume proposal shows "paused \u2192 active" state transition', () => {
      const proposal = makeProposal({
        operation: 'resume',
        diff: 'paused \u2192 active',
        status: 'pending',
      })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      expect(findTextContent(renderer!.root, 'paused')).toBeTruthy()
      expect(findTextContent(renderer!.root, 'active')).toBeTruthy()

      act(() => { renderer!.unmount() })
    })
  })

  describe('card-diff-set-tags (AC-011-2)', () => {
    test('set_tags proposal shows old and new tag arrays', () => {
      const proposal = makeProposal({
        operation: 'set_tags',
        diff: '["backup"] \u2192 ["backup", "critical"]',
        status: 'pending',
      })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      expect(findTextContent(renderer!.root, 'backup')).toBeTruthy()
      expect(findTextContent(renderer!.root, 'critical')).toBeTruthy()

      act(() => { renderer!.unmount() })
    })
  })

  describe('card-diff-run-now (AC-011-2)', () => {
    test('run_now proposal shows job name and command', () => {
      const proposal = makeProposal({
        operation: 'run_now',
        jobName: 'nightly-report',
        diff: 'Job: nightly-report\nCommand: /usr/bin/report.sh',
        status: 'pending',
      })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      expect(findTextContent(renderer!.root, 'nightly-report')).toBeTruthy()
      expect(findTextContent(renderer!.root, '/usr/bin/report.sh')).toBeTruthy()

      act(() => { renderer!.unmount() })
    })
  })

  // ── AC-011-1: Operation type badge color coding ───────────────────────────

  describe('operation type badge colors (AC-011-1)', () => {
    const operationColors: Array<{ operation: CronAiProposalOperation; colorClass: string }> = [
      { operation: 'create', colorClass: 'green' },
      { operation: 'edit_frequency', colorClass: 'blue' },
      { operation: 'pause', colorClass: 'yellow' },
      { operation: 'resume', colorClass: 'green' },
      { operation: 'delete', colorClass: 'red' },
      { operation: 'run_now', colorClass: 'orange' },
      { operation: 'set_tags', colorClass: 'purple' },
      { operation: 'link_session', colorClass: 'cyan' },
    ]

    for (const { operation, colorClass } of operationColors) {
      test(`${operation} operation badge uses ${colorClass} color`, () => {
        const proposal = makeProposal({ operation, status: 'pending' })
        const onAccept = () => {}
        const onReject = () => {}

        let renderer: TestRenderer.ReactTestRenderer
        act(() => {
          renderer = TestRenderer.create(
            <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
          )
        })

        // The operation badge should have the appropriate color class
        const colorElements = findByClassName(renderer!.root, colorClass)
        expect(colorElements.length).toBeGreaterThan(0)

        act(() => { renderer!.unmount() })
      })
    }
  })

  // ── AC-011-4: Reject feedback flow ────────────────────────────────────────

  describe('card-reject-feedback (AC-011-4)', () => {
    test('clicking Reject expands a feedback text input', () => {
      const proposal = makeProposal({ status: 'pending' })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      // Initially, no text input should be visible for feedback
      let inputs = renderer!.root.findAllByType('input').concat(
        renderer!.root.findAllByType('textarea')
      )
      const feedbackInputsBefore = inputs.filter(
        (el) => el.props.placeholder?.toLowerCase().includes('feedback') ||
                el.props['aria-label']?.toLowerCase().includes('feedback')
      )
      expect(feedbackInputsBefore).toHaveLength(0)

      // Click Reject button
      const rejectBtn = renderer!.root.findAllByType('button').find(
        (btn) => btn.props['aria-label']?.includes('Reject')
      )
      expect(rejectBtn).toBeTruthy()

      act(() => {
        rejectBtn!.props.onClick()
      })

      // After clicking Reject, a feedback input should appear
      inputs = renderer!.root.findAllByType('input').concat(
        renderer!.root.findAllByType('textarea')
      )
      const feedbackInputsAfter = inputs.filter(
        (el) => el.props.placeholder?.toLowerCase().includes('feedback') ||
                el.props['aria-label']?.toLowerCase().includes('feedback') ||
                el.props.type === 'text'
      )
      expect(feedbackInputsAfter.length).toBeGreaterThan(0)

      act(() => { renderer!.unmount() })
    })

    test('submitting feedback calls onReject with feedback text', () => {
      const proposal = makeProposal({ status: 'pending' })
      const onAccept = () => {}
      let rejectedWithFeedback: string | undefined
      const onReject = (feedback?: string) => {
        rejectedWithFeedback = feedback
      }

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      // Click Reject to expand feedback
      const rejectBtn = renderer!.root.findAllByType('button').find(
        (btn) => btn.props['aria-label']?.includes('Reject')
      )
      act(() => {
        rejectBtn!.props.onClick()
      })

      // Type into the feedback input
      const inputs = renderer!.root.findAllByType('input').concat(
        renderer!.root.findAllByType('textarea')
      )
      const feedbackInput = inputs.find(
        (el) => el.props.placeholder?.toLowerCase().includes('feedback') ||
                el.props['aria-label']?.toLowerCase().includes('feedback') ||
                el.props.type === 'text'
      )
      expect(feedbackInput).toBeTruthy()

      act(() => {
        feedbackInput!.props.onChange({ target: { value: 'Too frequent schedule' } })
      })

      // Submit feedback (look for a submit button or form submit)
      const submitBtn = renderer!.root.findAllByType('button').find(
        (btn) => btn.props['aria-label']?.toLowerCase().includes('submit') ||
                 btn.props.type === 'submit' ||
                 findTextContent(btn, 'Submit') !== undefined
      )

      if (submitBtn) {
        act(() => {
          submitBtn.props.onClick?.()
        })
      } else {
        // Might be form-based submission
        const forms = renderer!.root.findAllByType('form')
        if (forms.length > 0) {
          act(() => {
            forms[0].props.onSubmit?.({ preventDefault: () => {} })
          })
        }
      }

      expect(rejectedWithFeedback).toBe('Too frequent schedule')

      act(() => { renderer!.unmount() })
    })

    test('clicking Accept calls onAccept handler', () => {
      const proposal = makeProposal({ status: 'pending' })
      let accepted = false
      const onAccept = () => { accepted = true }
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      const acceptBtn = renderer!.root.findAllByType('button').find(
        (btn) => btn.props['aria-label']?.includes('Accept')
      )
      expect(acceptBtn).toBeTruthy()

      act(() => {
        acceptBtn!.props.onClick()
      })

      expect(accepted).toBe(true)

      act(() => { renderer!.unmount() })
    })
  })

  // ── AC-011-5: Card interactive when scrolled above viewport ───────────────

  describe('card-survives-scroll (AC-011-5)', () => {
    test('card uses absolute positioning for overlay within terminal container', () => {
      const proposal = makeProposal({ status: 'pending' })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      // Card should have absolute or sticky positioning to survive scroll
      const positioned = renderer!.root.findAll((el) => {
        const cn = el.props.className
        const style = el.props.style
        return (
          (typeof cn === 'string' && (cn.includes('absolute') || cn.includes('sticky'))) ||
          (style && (style.position === 'absolute' || style.position === 'sticky'))
        )
      })
      expect(positioned.length).toBeGreaterThan(0)

      act(() => { renderer!.unmount() })
    })

    test('card buttons remain interactive regardless of scroll position', () => {
      const proposal = makeProposal({ status: 'pending' })
      let accepted = false
      const onAccept = () => { accepted = true }
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      // Ensure pointer-events are not disabled on the card
      const card = renderer!.root.findAll((el) => {
        return el.props.role === 'article'
      })[0]

      if (card) {
        const style = card.props.style
        // pointer-events should not be 'none'
        if (style) {
          expect(style.pointerEvents).not.toBe('none')
        }
      }

      // Click Accept to verify interactive
      const acceptBtn = renderer!.root.findAllByType('button').find(
        (btn) => btn.props['aria-label']?.includes('Accept')
      )
      act(() => {
        acceptBtn!.props.onClick()
      })
      expect(accepted).toBe(true)

      act(() => { renderer!.unmount() })
    })
  })

  // ── AC-011-6: ARIA accessibility ──────────────────────────────────────────

  describe('card-aria (AC-011-6)', () => {
    test('card has role="article"', () => {
      const proposal = makeProposal({ operation: 'create', jobName: 'backup', status: 'pending' })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      const articles = renderer!.root.findAll((el) => el.props.role === 'article')
      expect(articles.length).toBeGreaterThan(0)

      act(() => { renderer!.unmount() })
    })

    test('card aria-label includes operation and job name', () => {
      const proposal = makeProposal({
        operation: 'delete',
        jobName: 'old-cleanup',
        status: 'pending',
      })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      const articles = renderer!.root.findAll((el) => el.props.role === 'article')
      expect(articles.length).toBeGreaterThan(0)
      const label = articles[0].props['aria-label']
      expect(label).toContain('delete')
      expect(label).toContain('old-cleanup')

      act(() => { renderer!.unmount() })
    })

    test('Accept button has aria-label "Accept proposal"', () => {
      const proposal = makeProposal({ status: 'pending' })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      const acceptBtn = renderer!.root.findAllByType('button').find(
        (btn) => btn.props['aria-label'] === 'Accept proposal'
      )
      expect(acceptBtn).toBeTruthy()

      act(() => { renderer!.unmount() })
    })

    test('Reject button has aria-label "Reject proposal"', () => {
      const proposal = makeProposal({ status: 'pending' })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      const rejectBtn = renderer!.root.findAllByType('button').find(
        (btn) => btn.props['aria-label'] === 'Reject proposal'
      )
      expect(rejectBtn).toBeTruthy()

      act(() => { renderer!.unmount() })
    })

    test('aria-label updates for different operations', () => {
      const operations: CronAiProposalOperation[] = [
        'create', 'edit_frequency', 'pause', 'resume', 'delete', 'run_now', 'set_tags', 'link_session',
      ]

      for (const operation of operations) {
        const proposal = makeProposal({ operation, jobName: 'test-job', status: 'pending' })
        const onAccept = () => {}
        const onReject = () => {}

        let renderer: TestRenderer.ReactTestRenderer
        act(() => {
          renderer = TestRenderer.create(
            <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
          )
        })

        const articles = renderer!.root.findAll((el) => el.props.role === 'article')
        expect(articles.length).toBeGreaterThan(0)
        const label = articles[0].props['aria-label']
        expect(label).toContain(operation)
        expect(label).toContain('test-job')

        act(() => { renderer!.unmount() })
      }
    })
  })

  // ── AC-011-7: Async rendering does not block terminal ─────────────────────

  describe('card-async-rendering (AC-011-7)', () => {
    test('card renders synchronously without errors (no blocking awaits)', () => {
      const proposal = makeProposal({ status: 'pending' })
      const onAccept = () => {}
      const onReject = () => {}

      // Measure that rendering completes without errors
      let renderer: TestRenderer.ReactTestRenderer
      let renderError: Error | null = null

      try {
        act(() => {
          renderer = TestRenderer.create(
            <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
          )
        })
      } catch (err) {
        renderError = err as Error
      }

      expect(renderError).toBeNull()
      expect(renderer!.toJSON()).not.toBeNull()

      act(() => { renderer!.unmount() })
    })

    test('multiple cards can render without blocking each other', () => {
      const proposals = [
        makeProposal({ id: 'p1', operation: 'create', status: 'pending' }),
        makeProposal({ id: 'p2', operation: 'delete', status: 'accepted' }),
        makeProposal({ id: 'p3', operation: 'pause', status: 'rejected', feedback: 'No' }),
      ]
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <>
            {proposals.map((p) => (
              <CronAiProposalCard key={p.id} proposal={p} onAccept={onAccept} onReject={onReject} />
            ))}
          </>
        )
      })

      // All three should render
      const articles = renderer!.root.findAll((el) => el.props.role === 'article')
      expect(articles).toHaveLength(3)

      act(() => { renderer!.unmount() })
    })
  })

  // ── card-persists-rerender: Cards survive re-renders ──────────────────────

  describe('card-persists-rerender (AC-011-7)', () => {
    test('card preserves state across re-renders with same proposal', () => {
      const proposal = makeProposal({ status: 'pending' })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      // Click Reject to expand feedback input
      const rejectBtn = renderer!.root.findAllByType('button').find(
        (btn) => btn.props['aria-label']?.includes('Reject')
      )
      act(() => {
        rejectBtn!.props.onClick()
      })

      // Verify feedback input appeared
      let feedbackInputs = renderer!.root.findAllByType('input').concat(
        renderer!.root.findAllByType('textarea')
      ).filter(
        (el) => el.props.placeholder?.toLowerCase().includes('feedback') ||
                el.props['aria-label']?.toLowerCase().includes('feedback') ||
                el.props.type === 'text'
      )
      expect(feedbackInputs.length).toBeGreaterThan(0)

      // Re-render with same proposal (simulates parent re-render)
      act(() => {
        renderer.update(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      // Feedback input should still be visible after re-render
      feedbackInputs = renderer!.root.findAllByType('input').concat(
        renderer!.root.findAllByType('textarea')
      ).filter(
        (el) => el.props.placeholder?.toLowerCase().includes('feedback') ||
                el.props['aria-label']?.toLowerCase().includes('feedback') ||
                el.props.type === 'text'
      )
      expect(feedbackInputs.length).toBeGreaterThan(0)

      act(() => { renderer!.unmount() })
    })

    test('card updates when proposal status changes from pending to accepted', () => {
      const proposal = makeProposal({ status: 'pending' })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      // Initially blue border (pending)
      expect(findByClassName(renderer!.root, 'border-blue').length).toBeGreaterThan(0)

      // Update to accepted
      const acceptedProposal = makeProposal({
        status: 'accepted',
        resolvedAt: new Date().toISOString(),
      })
      act(() => {
        renderer.update(
          <CronAiProposalCard proposal={acceptedProposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      // Should now show green border and "Approved" badge
      expect(findByClassName(renderer!.root, 'border-green').length).toBeGreaterThan(0)
      expect(findTextContent(renderer!.root, 'Approved')).toBeTruthy()

      act(() => { renderer!.unmount() })
    })
  })

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    test('card handles null jobName gracefully', () => {
      const proposal = makeProposal({ jobName: null, status: 'pending' })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      let renderError: Error | null = null

      try {
        act(() => {
          renderer = TestRenderer.create(
            <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
          )
        })
      } catch (err) {
        renderError = err as Error
      }

      expect(renderError).toBeNull()

      act(() => { renderer!.unmount() })
    })

    test('card handles null jobId gracefully', () => {
      const proposal = makeProposal({ jobId: null, status: 'pending' })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      let renderError: Error | null = null

      try {
        act(() => {
          renderer = TestRenderer.create(
            <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
          )
        })
      } catch (err) {
        renderError = err as Error
      }

      expect(renderError).toBeNull()

      act(() => { renderer!.unmount() })
    })

    test('card handles empty diff string', () => {
      const proposal = makeProposal({ diff: '', status: 'pending' })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      let renderError: Error | null = null

      try {
        act(() => {
          renderer = TestRenderer.create(
            <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
          )
        })
      } catch (err) {
        renderError = err as Error
      }

      expect(renderError).toBeNull()

      act(() => { renderer!.unmount() })
    })

    test('card handles empty description', () => {
      const proposal = makeProposal({ description: '', status: 'pending' })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      let renderError: Error | null = null

      try {
        act(() => {
          renderer = TestRenderer.create(
            <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
          )
        })
      } catch (err) {
        renderError = err as Error
      }

      expect(renderError).toBeNull()

      act(() => { renderer!.unmount() })
    })

    test('rejected card with null feedback shows no feedback text', () => {
      const proposal = makeProposal({
        status: 'rejected',
        feedback: null,
        resolvedAt: new Date().toISOString(),
      })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      // Should still show Rejected badge
      expect(findTextContent(renderer!.root, 'Rejected')).toBeTruthy()
      // Should not crash
      expect(renderer!.toJSON()).not.toBeNull()

      act(() => { renderer!.unmount() })
    })

    test('onReject can be called without feedback (empty reject)', () => {
      const proposal = makeProposal({ status: 'pending' })
      const onAccept = () => {}
      let rejectCalled = false
      const onReject = (feedback?: string) => {
        rejectCalled = true
        // feedback should be undefined or empty string
        expect(feedback === undefined || feedback === '').toBe(true)
      }

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      // Click Reject to expand feedback
      const rejectBtn = renderer!.root.findAllByType('button').find(
        (btn) => btn.props['aria-label']?.includes('Reject')
      )
      act(() => {
        rejectBtn!.props.onClick()
      })

      // Submit without typing anything
      const submitBtn = renderer!.root.findAllByType('button').find(
        (btn) => btn.props['aria-label']?.toLowerCase().includes('submit') ||
                 btn.props.type === 'submit' ||
                 findTextContent(btn, 'Submit') !== undefined
      )

      if (submitBtn) {
        act(() => {
          submitBtn.props.onClick?.()
        })
        expect(rejectCalled).toBe(true)
      } else {
        const forms = renderer!.root.findAllByType('form')
        if (forms.length > 0) {
          act(() => {
            forms[0].props.onSubmit?.({ preventDefault: () => {} })
          })
          expect(rejectCalled).toBe(true)
        }
      }

      act(() => { renderer!.unmount() })
    })
  })

  // ── Timestamp display ─────────────────────────────────────────────────────

  describe('timestamp display (REQ-19)', () => {
    test('card displays relative timestamp from createdAt', () => {
      // Set createdAt to 2 minutes ago
      const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString()
      const proposal = makeProposal({ createdAt: twoMinAgo, status: 'pending' })
      const onAccept = () => {}
      const onReject = () => {}

      let renderer: TestRenderer.ReactTestRenderer
      act(() => {
        renderer = TestRenderer.create(
          <CronAiProposalCard proposal={proposal} onAccept={onAccept} onReject={onReject} />
        )
      })

      // Should show relative time like "2m ago" or "2 min ago"
      const timeText = findTextContent(renderer!.root, 'ago')
      expect(timeText).toBeTruthy()

      act(() => { renderer!.unmount() })
    })
  })
})
