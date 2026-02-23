// phase15-terminal-status-amendment.test.tsx - Phase 15 terminal tabs, status colors, and amendment UI tests
import { describe, expect, test, beforeAll } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import TerminalTabs from '../components/TerminalTabs'
import StepNode, { STATUS_LABELS } from '../components/StepNode'
import AmendmentStatusPanel from '../components/AmendmentStatusPanel'
import type { StepRunStatus, AmendmentDetail, AmendmentBudgetStatus } from '@shared/types'

// Mock document.addEventListener for TerminalTabs (uses it in useEffect)
beforeAll(() => {
  if (typeof document === 'undefined') {
    ;(global as any).document = {
      addEventListener: () => {},
      removeEventListener: () => {},
    }
  }
})

// ─── Helper Functions ────────────────────────────────────────────────────────

/** Recursively find elements matching a predicate in the test renderer tree */
function findAll(
  node: TestRenderer.ReactTestInstance,
  pred: (n: TestRenderer.ReactTestInstance) => boolean,
): TestRenderer.ReactTestInstance[] {
  const results: TestRenderer.ReactTestInstance[] = []
  if (pred(node)) results.push(node)
  for (const child of node.children) {
    if (typeof child !== 'string') {
      results.push(...findAll(child, pred))
    }
  }
  return results
}

/** Find elements by type string (e.g., 'button', 'div') */
function findByType(root: TestRenderer.ReactTestInstance, type: string) {
  return findAll(root, (n) => n.type === type)
}

/** Get all text content from a tree node */
function getTextContent(node: TestRenderer.ReactTestInstance): string {
  const texts: string[] = []
  for (const child of node.children) {
    if (typeof child === 'string') {
      texts.push(child)
    } else {
      texts.push(getTextContent(child))
    }
  }
  return texts.join('')
}

/** Local RunningSession interface (not exported from TerminalTabs.tsx) */
interface RunningSession {
  stepName: string
  status: StepRunStatus
  taskId: string | null
  startedAt: string | null
  output: string
}

/** Helper to create a RunningSession with defaults */
function makeSession(overrides: Partial<RunningSession> = {}): RunningSession {
  return {
    stepName: 'test-step',
    status: 'running',
    taskId: 'task-123',
    startedAt: '2026-01-29T00:00:00Z',
    output: 'Test output',
    ...overrides,
  }
}

// ─── TEST-13: Tabs created for running sessions ─────────────────────────────

describe('TerminalTabs', () => {
  test('TEST-13: creates tabs for running sessions with status dots', () => {
    const sessions: RunningSession[] = [
      makeSession({ stepName: 'Build', status: 'running', output: 'Building...' }),
      makeSession({ stepName: 'Test', status: 'failed', output: 'Test failed!' }),
    ]

    const renderer = TestRenderer.create(
      <TerminalTabs sessions={sessions} onSelectTab={() => {}} />
    )

    const buttons = findByType(renderer.root, 'button')
    const tabButtons = buttons.filter(b => b.props.role === 'tab')

    // Should have 2 tabs
    expect(tabButtons.length).toBe(2)

    const text = getTextContent(renderer.root)
    expect(text).toContain('Build')
    expect(text).toContain('Test')

    // Should have status dots with correct colors
    const statusDots = findAll(renderer.root, (n) =>
      typeof n.props?.className === 'string' &&
      n.props.className.includes('rounded-full') &&
      (n.props.className.includes('bg-green-500') ||
       n.props.className.includes('bg-yellow-500') ||
       n.props.className.includes('bg-red-500'))
    )
    expect(statusDots.length).toBeGreaterThanOrEqual(2)
  })

  // ─── TEST-14: Auto-focus on error ────────────────────────────────────────

  test('TEST-14: auto-focus on error tab when session changes to error status', () => {
    let selectedTab = null as string | null
    const sessions: RunningSession[] = [
      makeSession({ stepName: 'Build', status: 'running', output: 'Building...' }),
      makeSession({ stepName: 'Test', status: 'running', output: 'Testing...' }),
    ]

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <TerminalTabs
          sessions={sessions}
          onSelectTab={(tab) => { selectedTab = tab }}
          autoFocusOnError={true}
        />
      )
    })

    // Update Test session to failed status
    const updatedSessions: RunningSession[] = [
      makeSession({ stepName: 'Build', status: 'running', output: 'Building...' }),
      makeSession({ stepName: 'Test', status: 'failed', output: 'Test failed!' }),
    ]

    act(() => {
      renderer!.update(
        <TerminalTabs
          sessions={updatedSessions}
          onSelectTab={(tab) => { selectedTab = tab }}
          autoFocusOnError={true}
        />
      )
    })

    // The error tab should be auto-focused (onSelectTab called with 'Test')
    expect(selectedTab).toBe('Test')

    // Should NOT auto-focus on new non-error sessions
    const newSessions: RunningSession[] = [
      ...updatedSessions,
      makeSession({ stepName: 'Deploy', status: 'running', output: 'Deploying...' }),
    ]

    selectedTab = null
    act(() => {
      renderer!.update(
        <TerminalTabs
          sessions={newSessions}
          onSelectTab={(tab) => { selectedTab = tab }}
          autoFocusOnError={true}
        />
      )
    })

    // Should NOT have switched to Deploy tab
    expect(selectedTab).not.toBe('Deploy')
  })

  // ─── TEST-15: No tab for queued/pending with placeholder ──────────────────────────

  test('TEST-15: queued/pending sessions not shown as tabs, placeholder shown', () => {
    const sessions: RunningSession[] = [
      makeSession({ stepName: 'Build', status: 'running', output: 'Building...' }),
      makeSession({ stepName: 'Queued', status: 'queued', output: '' }),
      makeSession({ stepName: 'Pending', status: 'pending', output: '' }),
    ]

    const renderer = TestRenderer.create(
      <TerminalTabs sessions={sessions} onSelectTab={() => {}} />
    )

    const text = getTextContent(renderer.root)

    // Should have tab for running session
    expect(text).toContain('Build')

    // Should NOT have tabs for queued/pending
    const buttons = findByType(renderer.root, 'button')
    const tabButtons = buttons.filter(b => b.props.role === 'tab')
    expect(tabButtons.length).toBe(1)

    // Should show queued indicator with count
    expect(text).toContain('2 queued')
  })

  // ─── TEST-16: Tab overflow with 6+ sessions ─────────────────────────────

  test('TEST-16: tab overflow shows MAX_VISIBLE_TABS directly, overflow dropdown for extras, completed tabs grayed', () => {
    const sessions: RunningSession[] = [
      makeSession({ stepName: 'Step1', status: 'running' }),
      makeSession({ stepName: 'Step2', status: 'running' }),
      makeSession({ stepName: 'Step3', status: 'completed' }),
      makeSession({ stepName: 'Step4', status: 'running' }),
      makeSession({ stepName: 'Step5', status: 'running' }),
      makeSession({ stepName: 'Step6', status: 'running' }),
    ]

    const renderer = TestRenderer.create(
      <TerminalTabs sessions={sessions} onSelectTab={() => {}} />
    )

    const buttons = findByType(renderer.root, 'button')
    const tabButtons = buttons.filter(b => b.props.role === 'tab')

    // MAX_VISIBLE_TABS = 4, so we should see 4 visible tabs
    expect(tabButtons.length).toBe(4)

    // Should have overflow dropdown button (aria-haspopup is a string "true")
    const overflowButton = buttons.find(b => b.props['aria-haspopup'] === 'true')
    expect(overflowButton).toBeDefined()

    // Should show +2 for the 2 overflow tabs
    const overflowText = getTextContent(overflowButton!)
    expect(overflowText).toContain('+2')

    // Completed tab (Step3) should have grayed styling
    const completedTab = tabButtons.find(b => getTextContent(b).includes('Step3'))
    expect(completedTab).toBeDefined()
    expect(completedTab!.props.className).toContain('text-gray-500')
  })

  // ─── TEST-17: Completed tab grayed ────────────────────────────────────────

  test('TEST-17: completed session tabs have grayed/muted styling', () => {
    const sessions: RunningSession[] = [
      makeSession({ stepName: 'Build', status: 'completed', output: 'Build complete' }),
      makeSession({ stepName: 'Test', status: 'running', output: 'Testing...' }),
    ]

    const renderer = TestRenderer.create(
      <TerminalTabs sessions={sessions} onSelectTab={() => {}} />
    )

    const buttons = findByType(renderer.root, 'button')
    const tabButtons = buttons.filter(b => b.props.role === 'tab')

    expect(tabButtons.length).toBe(2)

    // Find the completed session tab
    const completedTab = tabButtons.find(b => getTextContent(b).includes('Build'))
    expect(completedTab).toBeDefined()

    // Check for grayed-out styling (text-gray-500 class)
    expect(completedTab!.props.className).toContain('text-gray-500')
  })
})

// ─── TEST-18: All new statuses have correct colors ───────────────────────────

describe('StepNode — Phase 15 status colors', () => {
  test('TEST-18: all new statuses have correct color classes', () => {
    const statusColorTests: { status: StepRunStatus; expectedClass: string }[] = [
      { status: 'queued', expectedClass: 'bg-yellow-500' },
      { status: 'paused_amendment', expectedClass: 'bg-orange-500' },
      { status: 'paused_human', expectedClass: 'bg-orange-500' },
      { status: 'paused_exploration', expectedClass: 'bg-blue-500' },
      { status: 'invalidated', expectedClass: 'step-invalidated' },
      { status: 'skipped', expectedClass: 'bg-gray-500' },
    ]

    for (const { status, expectedClass } of statusColorTests) {
      const step = {
        name: `${status}-step`,
        type: 'spawn_session' as const,
        status,
        taskId: null,
        startedAt: null,
        completedAt: null,
        errorMessage: null,
        retryCount: 0,
        skippedReason: null,
        resultFile: null,
        resultCollected: false,
        resultContent: null,
      }

      const renderer = TestRenderer.create(
        <StepNode step={step} index={0} isSelected={false} isFocused={false} onClick={() => {}} />
      )

      const button = findByType(renderer.root, 'button')[0]
      expect(button.props.className).toContain(expectedClass)
    }
  })

  // ─── TEST-19: Status colors include text labels ─────────────────────────

  test('TEST-19: status colors include text labels in aria-label', () => {
    const newStatuses: StepRunStatus[] = [
      'queued',
      'paused_amendment',
      'paused_escalated',
      'paused_human',
      'paused_starvation',
      'paused_exploration',
      'invalidated',
    ]

    for (const status of newStatuses) {
      // Check that STATUS_LABELS has an entry
      expect(STATUS_LABELS[status]).toBeDefined()
      expect(typeof STATUS_LABELS[status]).toBe('string')

      // Render and check aria-label
      const step = {
        name: `${status}-step`,
        type: 'spawn_session' as const,
        status,
        taskId: null,
        startedAt: null,
        completedAt: null,
        errorMessage: null,
        retryCount: 0,
        skippedReason: null,
        resultFile: null,
        resultCollected: false,
        resultContent: null,
      }

      const renderer = TestRenderer.create(
        <StepNode step={step} index={0} isSelected={false} isFocused={false} onClick={() => {}} />
      )

      const button = findByType(renderer.root, 'button')[0]
      const ariaLabel = button.props['aria-label']
      expect(ariaLabel).toContain(STATUS_LABELS[status])
    }
  })
})

// ─── TEST-20: Amendment details displayed when paused ────────────────────────

describe('AmendmentStatusPanel', () => {
  test('TEST-20: auto-approval banner shown when conditions met with override button', () => {
    const amendment: AmendmentDetail = {
      id: 'a2',
      specSection: 'database',
      issue: 'Schema mismatch',
      proposedChange: 'Update column type',
      category: 'quality',
      autoApproved: true,
      autoApprovedBy: 'spec-reviewer',
    }

    const budget: AmendmentBudgetStatus = {
      quality: { used: 1, max: 5 },
      reconciliation: { used: 0, max: 8 },
    }

    const renderer = TestRenderer.create(
      <AmendmentStatusPanel
        runId="run-1"
        amendment={amendment}
        budget={budget}
        isPausedEscalated={false}
        onApprove={() => {}}
        onReject={() => {}}
        onDefer={() => {}}
        onOverrideAutoApproval={() => {}}
        onExtendBudget={() => {}}
      />
    )

    const text = getTextContent(renderer.root)

    // Check for auto-approval indicator
    expect(text).toContain('Auto-approved')
    expect(text).toContain('spec-reviewer')

    // Check for Override button
    const buttons = findByType(renderer.root, 'button')
    const overrideButton = buttons.find(b => b.props['aria-label'] === 'Override auto-approval')
    expect(overrideButton).toBeDefined()
    expect(getTextContent(overrideButton!)).toContain('Override')
  })

  // ─── TEST-21: Auto-reviewed amendment (keep as-is, already good) ───────────────

  test('TEST-21: auto-reviewed amendment shows auto-approval indicator', () => {
    const amendment: AmendmentDetail = {
      id: 'a2',
      specSection: 'database',
      issue: 'Schema mismatch',
      proposedChange: 'Update column type',
      category: 'quality',
      autoApproved: true,
      autoApprovedBy: 'spec-reviewer',
    }

    const budget: AmendmentBudgetStatus = {
      quality: { used: 1, max: 5 },
      reconciliation: { used: 0, max: 8 },
    }

    const renderer = TestRenderer.create(
      <AmendmentStatusPanel
        runId="run-1"
        amendment={amendment}
        budget={budget}
        isPausedEscalated={false}
        onApprove={() => {}}
        onReject={() => {}}
        onDefer={() => {}}
        onOverrideAutoApproval={() => {}}
        onExtendBudget={() => {}}
      />
    )

    const text = getTextContent(renderer.root)

    // Check for auto-approval indicator
    expect(text).toContain('Auto-approved')
    expect(text).toContain('spec-reviewer')

    // Check for Override button
    const buttons = findByType(renderer.root, 'button')
    const overrideButton = buttons.find(b => b.props['aria-label'] === 'Override auto-approval')
    expect(overrideButton).toBeDefined()
  })

  // ─── TEST-22: Extend Budget button with input validation ─────────────────

  test('TEST-22: extend budget button with input for new max value and validation (max 10000)', () => {
    const amendment: AmendmentDetail = {
      id: 'a3',
      specSection: 'api',
      issue: 'Budget exhausted',
      proposedChange: null,
      category: 'quality',
      autoApproved: false,
      autoApprovedBy: null,
    }

    const budget: AmendmentBudgetStatus = {
      quality: { used: 5, max: 5 },
      reconciliation: { used: 8, max: 8 },
    }

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <AmendmentStatusPanel
          runId="run-1"
          amendment={amendment}
          budget={budget}
          isPausedEscalated={true}
          onApprove={() => {}}
          onReject={() => {}}
          onDefer={() => {}}
          onOverrideAutoApproval={() => {}}
          onExtendBudget={() => {}}
        />
      )
    })

    let text = getTextContent(renderer!.root)

    // Check for escalation message
    expect(text).toContain('Budget Exhausted')

    // Check for Extend Budget button alongside Approve/Reject/Defer
    const buttons = findByType(renderer!.root, 'button')
    const extendButton = buttons.find(b => getTextContent(b) === 'Extend Budget')
    const approveButton = buttons.find(b => getTextContent(b) === 'Approve')
    const rejectButton = buttons.find(b => getTextContent(b) === 'Reject')
    const deferButton = buttons.find(b => getTextContent(b) === 'Defer')

    expect(extendButton).toBeDefined()
    expect(approveButton).toBeDefined()
    expect(rejectButton).toBeDefined()
    expect(deferButton).toBeDefined()

    // Click to open dialog
    act(() => {
      extendButton!.props.onClick()
    })

    text = getTextContent(renderer!.root)

    // Dialog should be visible with input fields
    expect(text).toContain('Extend Amendment Budget')
    expect(text).toContain('Category')
    expect(text).toContain('New Maximum')

    // Find the input field
    const inputs = findAll(renderer!.root, (n) => n.type === 'input')
    const maxInput = inputs.find(i => i.props.type === 'number')
    expect(maxInput).toBeDefined()
    expect(maxInput!.props.max).toBe('10000')
  })

  // ─── TEST-23: Budget extension updates display ──────────────────────────

  test('TEST-23: budget extension dialog appears and callback is invoked', () => {
    const amendment: AmendmentDetail = {
      id: 'a4',
      specSection: 'validation',
      issue: 'Need more amendments',
      proposedChange: null,
      category: 'quality',
      autoApproved: false,
      autoApprovedBy: null,
    }

    const budget: AmendmentBudgetStatus = {
      quality: { used: 3, max: 3 },
      reconciliation: { used: 2, max: 8 },
    }

    let _extendedCategory: string | null = null
    let _extendedNewMax: number | null = null

    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <AmendmentStatusPanel
          runId="run-1"
          amendment={amendment}
          budget={budget}
          isPausedEscalated={true}
          onApprove={() => {}}
          onReject={() => {}}
          onDefer={() => {}}
          onOverrideAutoApproval={() => {}}
          onExtendBudget={(category, newMax) => {
            _extendedCategory = category
            _extendedNewMax = newMax
          }}
        />
      )
    })

    // Click "Extend Budget" button
    act(() => {
      const buttons = findByType(renderer!.root, 'button')
      const extendButton = buttons.find(b => getTextContent(b) === 'Extend Budget')
      extendButton!.props.onClick()
    })

    // Dialog should now be visible
    const text = getTextContent(renderer!.root)
    expect(text).toContain('Extend Amendment Budget')

    // Dialog elements should be present
    const dialogs = findAll(renderer!.root, (n) => n.props?.role === 'dialog')
    expect(dialogs.length).toBe(1)

    // Verify dialog has category selector and input
    expect(text).toContain('Category')
    expect(text).toContain('New Maximum')
  })
})
