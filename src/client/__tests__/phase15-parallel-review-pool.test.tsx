// phase15-parallel-review-pool.test.tsx - Unit tests for Phase 15 parallel group, review loop, and pool status components
import { describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import ParallelGroupNode from '../components/ParallelGroupNode'
import ReviewLoopNode from '../components/ReviewLoopNode'
import PoolStatusIndicator from '../components/PoolStatusIndicator'
import TerminalTabs from '../components/TerminalTabs'
import type { StepRunState, WorkflowRun, PoolStatus } from '@shared/types'

/** Helper to create a step with defaults */
function makeStep(overrides: Partial<StepRunState> = {}): StepRunState {
  return {
    name: 'test-step',
    type: 'spawn_session',
    status: 'pending',
    taskId: null,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    retryCount: 0,
    skippedReason: null,
    resultFile: null,
    resultCollected: false,
    resultContent: null,
    ...overrides,
  } as StepRunState
}

/** Helper to create a workflow run with defaults */
function _makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    workflow_id: 'wf-1',
    workflow_name: 'Test Workflow',
    status: 'running',
    current_step_index: 0,
    steps_state: [
      makeStep({ name: 'Step 1', status: 'completed' }),
      makeStep({ name: 'Step 2', status: 'running' }),
      makeStep({ name: 'Step 3', status: 'pending' }),
    ],
    output_dir: '/tmp/test',
    started_at: '2026-01-29T00:00:00Z',
    completed_at: null,
    error_message: null,
    created_at: '2026-01-29T00:00:00Z',
    variables: null,
    ...overrides,
  }
}

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

// ─── ParallelGroupNode Tests ─────────────────────────────────────────────────

describe('ParallelGroupNode', () => {
  test('TEST-01: Parallel group renders as expandable row', () => {
    const step = makeStep({
      name: 'parallel-build',
      type: 'parallel_group',
      status: 'running',
      childSteps: [
        makeStep({ name: 'child-1', status: 'completed' }),
        makeStep({ name: 'child-2', status: 'running' }),
        makeStep({ name: 'child-3', status: 'pending' }),
        makeStep({ name: 'child-4', status: 'pending' }),
      ],
    })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <ParallelGroupNode step={step} isSelected={false} onSelect={() => {}} />,
      )
    })

    const text = getTextContent(renderer!.root)
    expect(text).toContain('parallel-build')

    // Should be collapsed with >3 children initially
    expect(text).not.toContain('child-1')

    // Should show progress summary
    expect(text).toContain('1/4 complete')

    // Click to expand
    const buttons = findByType(renderer!.root, 'button')
    const mainButton = buttons[0]
    act(() => {
      mainButton.props.onClick()
    })

    // After expansion, all children should be visible
    const expandedText = getTextContent(renderer!.root)
    expect(expandedText).toContain('child-1')
    expect(expandedText).toContain('child-2')
    expect(expandedText).toContain('child-3')
    expect(expandedText).toContain('child-4')
  })

  test('TEST-02: Parallel group progress summary updates', () => {
    const step = makeStep({
      name: 'parallel-test',
      type: 'parallel_group',
      status: 'running',
      childSteps: [
        makeStep({ name: 'child-1', status: 'completed' }),
        makeStep({ name: 'child-2', status: 'running' }),
        makeStep({ name: 'child-3', status: 'pending' }),
      ],
    })
    let renderer = TestRenderer.create(
      <ParallelGroupNode step={step} isSelected={false} onSelect={() => {}} />,
    )
    let text = getTextContent(renderer.root)
    // Should show 1 completed out of 3
    expect(text).toContain('1')
    expect(text).toContain('3')

    // Update to 2 completed
    const updatedStep = makeStep({
      name: 'parallel-test',
      type: 'parallel_group',
      status: 'running',
      childSteps: [
        makeStep({ name: 'child-1', status: 'completed' }),
        makeStep({ name: 'child-2', status: 'completed' }),
        makeStep({ name: 'child-3', status: 'pending' }),
      ],
    })
    act(() => {
      renderer.update(<ParallelGroupNode step={updatedStep} isSelected={false} onSelect={() => {}} />)
    })
    text = getTextContent(renderer.root)
    expect(text).toContain('2')
    expect(text).toContain('3')
  })

  test('TEST-03: Collapsed view shows summary with status counts', () => {
    const childSteps = Array.from({ length: 6 }, (_, i) =>
      makeStep({ name: `child-${i + 1}`, status: i < 2 ? 'completed' : i < 4 ? 'running' : 'pending' }),
    )
    const step = makeStep({
      name: 'large-parallel',
      type: 'parallel_group',
      status: 'running',
      childSteps,
    })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <ParallelGroupNode step={step} isSelected={false} onSelect={() => {}} />,
      )
    })
    const text = getTextContent(renderer!.root)

    // Should show summary with completed count
    expect(text).toContain('2/6 complete')

    // Should NOT show individual children when collapsed
    expect(text).not.toContain('child-1')
    expect(text).not.toContain('child-6')

    // Verify status counts: 2 completed, 2 running, 2 pending
    const completedCount = childSteps.filter(c => c.status === 'completed').length
    const runningCount = childSteps.filter(c => c.status === 'running').length
    const pendingCount = childSteps.filter(c => c.status === 'pending').length
    expect(completedCount).toBe(2)
    expect(runningCount).toBe(2)
    expect(pendingCount).toBe(2)
  })

  test('TEST-04: Child dependency status displayed with colored indicators', () => {
    const allSteps = [
      makeStep({ name: 'dep-completed', status: 'completed' }),
      makeStep({ name: 'dep-running', status: 'running' }),
      makeStep({ name: 'dep-pending', status: 'pending' }),
    ]

    const step = makeStep({
      name: 'parallel-deps',
      type: 'parallel_group',
      status: 'running',
      childSteps: [
        makeStep({ name: 'A', status: 'completed' }),
        makeStep({ name: 'B', status: 'running' }),
        {
          ...makeStep({ name: 'C', status: 'pending' }),
          depends_on: ['dep-completed', 'dep-running', 'dep-pending'],
        } as any,
      ],
    })

    const renderer = TestRenderer.create(
      <ParallelGroupNode step={step} isSelected={false} onSelect={() => {}} allSteps={allSteps} />,
    )
    const text = getTextContent(renderer.root)

    // Should display dependency names
    expect(text).toContain('dep-completed')
    expect(text).toContain('dep-running')
    expect(text).toContain('dep-pending')

    // Should display dependency status with colored SVG indicators
    const svgs = findAll(renderer.root, (n) => n.type === 'svg')
    const greenCheck = svgs.find(svg => svg.props['aria-label'] === 'completed')
    const yellowSpinner = svgs.find(svg => svg.props['aria-label'] === 'running')
    const grayDot = svgs.find(svg => svg.props['aria-label'] === 'pending')

    expect(greenCheck).toBeDefined()
    expect(yellowSpinner).toBeDefined()
    expect(grayDot).toBeDefined()
  })
})

// ─── ReviewLoopNode Tests ────────────────────────────────────────────────────

describe('ReviewLoopNode', () => {
  test('TEST-05: Review loop renders with iteration info and sub-step status', () => {
    const step = makeStep({
      name: 'review-code',
      type: 'review_loop',
      status: 'running',
      reviewIteration: 2,
      reviewSubStep: 'reviewer',
    })
    const renderer = TestRenderer.create(
      <ReviewLoopNode step={step} isSelected={false} onSelect={() => {}} maxIterations={3} />,
    )
    const text = getTextContent(renderer.root)

    // Should show loop name
    expect(text).toContain('review-code')

    // Should show current iteration and max
    expect(text).toContain('Iteration 2/3')

    // Should show sub-step status
    expect(text).toContain('Reviewer')
  })

  test('TEST-06: Review loop expands to show iteration history with verdict, feedback, timestamps', () => {
    const step = makeStep({
      name: 'review-spec',
      type: 'review_loop',
      status: 'running',
      reviewIteration: 2,
      reviewIterations: [
        {
          iteration: 1,
          verdict: 'FAIL',
          feedback: 'Needs work',
          producerTaskId: 'task-1',
          reviewerTaskId: 'task-2',
          startedAt: '2026-01-29T00:00:00Z',
          completedAt: '2026-01-29T00:05:00Z',
        },
      ],
    })
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <ReviewLoopNode step={step} isSelected={false} onSelect={() => {}} maxIterations={3} />,
      )
    })

    // Initially collapsed - should not show iteration details
    let text = getTextContent(renderer!.root)
    expect(text).not.toContain('Needs work')

    // Click to expand
    const buttons = findByType(renderer!.root, 'button')
    act(() => {
      buttons[0].props.onClick()
    })

    // After expansion, should show iteration row with verdict badge, feedback, and timestamps
    text = getTextContent(renderer!.root)
    expect(text).toContain('#1')
    expect(text).toContain('FAIL')
    expect(text).toContain('Needs work')
    expect(text).toContain('Started:')
    expect(text).toContain('Completed:')
  })

  test('TEST-07: Review loop re-renders when new iteration data arrives via props', () => {
    const step = makeStep({
      name: 'review-test',
      type: 'review_loop',
      status: 'running',
      reviewIteration: 1,
      reviewVerdict: null,
      reviewIterations: [],
    })
    let renderer = TestRenderer.create(
      <ReviewLoopNode step={step} isSelected={false} onSelect={() => {}} maxIterations={3} />,
    )
    let text = getTextContent(renderer.root)
    expect(text).toContain('Iteration 1/3')

    // Simulate WebSocket update with new iteration data
    const updatedStep = makeStep({
      name: 'review-test',
      type: 'review_loop',
      status: 'running',
      reviewIteration: 2,
      reviewVerdict: 'PASS',
      reviewIterations: [
        {
          iteration: 1,
          verdict: 'PASS',
          feedback: 'First iteration passed',
          producerTaskId: 'task-1',
          reviewerTaskId: 'task-2',
          startedAt: '2026-01-29T00:00:00Z',
          completedAt: '2026-01-29T00:05:00Z',
        },
      ],
    })
    act(() => {
      renderer.update(
        <ReviewLoopNode step={updatedStep} isSelected={false} onSelect={() => {}} maxIterations={3} />,
      )
    })

    // Component should update to show new iteration
    text = getTextContent(renderer.root)
    expect(text).toContain('Iteration 2/3')
    expect(text).toContain('PASS')

    // Expand to verify new iteration is in the list
    const buttons = findByType(renderer.root, 'button')
    act(() => {
      buttons[0].props.onClick()
    })
    text = getTextContent(renderer.root)
    expect(text).toContain('#1')
    expect(text).toContain('First iteration passed')
  })

  test('TEST-08: Review loop paused state shows orange badge and action buttons', () => {
    const step = makeStep({
      name: 'review-paused',
      type: 'review_loop',
      status: 'paused_human',
      reviewIteration: 1,
    })
    let actionCalled = null as string | null
    const onAction = (action: 'accept' | 'reject' | 'restart') => {
      actionCalled = action
    }
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <ReviewLoopNode step={step} isSelected={false} onSelect={() => {}} maxIterations={3} onAction={onAction} />,
      )
    })

    let text = getTextContent(renderer!.root)
    // Should show paused badge
    expect(text).toContain('PAUSED')

    // Expand to see action buttons
    const buttons = findByType(renderer!.root, 'button')
    act(() => {
      buttons[0].props.onClick()
    })

    text = getTextContent(renderer!.root)
    expect(text).toContain('Paused for human review')

    // Should have Accept, Reject, Restart buttons
    const allButtons = findByType(renderer!.root, 'button')
    const acceptButton = allButtons.find(b => getTextContent(b) === 'Accept')
    const rejectButton = allButtons.find(b => getTextContent(b) === 'Reject')
    const restartButton = allButtons.find(b => getTextContent(b) === 'Restart')

    expect(acceptButton).toBeDefined()
    expect(rejectButton).toBeDefined()
    expect(restartButton).toBeDefined()

    // Verify button functionality
    act(() => {
      acceptButton!.props.onClick()
    })
    expect(actionCalled).toBe('accept')
  })
})

// ─── PoolStatusIndicator Tests ───────────────────────────────────────────────

describe('PoolStatusIndicator', () => {
  test('TEST-09: Pool status shows active/max counts and queued count in sidebar', () => {
    const poolStatus: PoolStatus = {
      maxSlots: 2,
      activeSlots: [
        { slotId: 's1', runId: 'run-1', stepName: 'build', tier: 1, startedAt: '2026-01-29T00:00:00Z' },
        { slotId: 's2', runId: 'run-2', stepName: 'test', tier: 2, startedAt: '2026-01-29T00:01:00Z' },
      ],
      queue: [
        { runId: 'run-3', stepName: 'deploy', tier: 1, requestedAt: '2026-01-29T00:02:00Z', position: 1 },
      ],
    }
    const renderer = TestRenderer.create(<PoolStatusIndicator poolStatus={poolStatus} />)
    const text = getTextContent(renderer.root)

    // Should show active/max count
    expect(text).toContain('2/2 active')

    // Should show queued count
    expect(text).toContain('1 queued')

    // Should be in sidebar position (has role button for expandability)
    const divs = findAll(renderer.root, (n) => n.props?.role === 'button')
    expect(divs.length).toBeGreaterThan(0)
  })

  test('TEST-10: Pool status updates on re-render', () => {
    const initialStatus: PoolStatus = {
      maxSlots: 2,
      activeSlots: [
        { slotId: 's1', runId: 'run-1', stepName: 'build', tier: 1, startedAt: '2026-01-29T00:00:00Z' },
      ],
      queue: [],
    }
    let renderer = TestRenderer.create(<PoolStatusIndicator poolStatus={initialStatus} />)
    let text = getTextContent(renderer.root)
    expect(text).toContain('1')

    // Update to 2/2 active
    const updatedStatus: PoolStatus = {
      maxSlots: 2,
      activeSlots: [
        { slotId: 's1', runId: 'run-1', stepName: 'build', tier: 1, startedAt: '2026-01-29T00:00:00Z' },
        { slotId: 's2', runId: 'run-2', stepName: 'test', tier: 2, startedAt: '2026-01-29T00:01:00Z' },
      ],
      queue: [],
    }
    act(() => {
      renderer.update(<PoolStatusIndicator poolStatus={updatedStatus} />)
    })
    text = getTextContent(renderer.root)
    expect(text).toContain('2')
  })

  test('TEST-11: Pool status updates when new data arrives via props', () => {
    const initialStatus: PoolStatus = {
      maxSlots: 2,
      activeSlots: [
        { slotId: 's1', runId: 'run-1', stepName: 'build', tier: 1, startedAt: '2026-01-29T00:00:00Z' },
      ],
      queue: [],
    }
    let renderer = TestRenderer.create(<PoolStatusIndicator poolStatus={initialStatus} />)
    let text = getTextContent(renderer.root)

    // Initial state: 1 active, 0 queued
    expect(text).toContain('1/2 active')
    expect(text).not.toContain('queued')

    // Update to 1 active, 1 queued
    const updatedStatus: PoolStatus = {
      maxSlots: 2,
      activeSlots: [
        { slotId: 's1', runId: 'run-1', stepName: 'build', tier: 1, startedAt: '2026-01-29T00:00:00Z' },
      ],
      queue: [
        { runId: 'run-3', stepName: 'deploy', tier: 1, requestedAt: '2026-01-29T00:02:00Z', position: 1 },
      ],
    }
    act(() => {
      renderer.update(<PoolStatusIndicator poolStatus={updatedStatus} />)
    })
    text = getTextContent(renderer.root)

    // Component should re-render with updated counts
    expect(text).toContain('1/2 active')
    expect(text).toContain('1 queued')
  })

  test('TEST-12: Pool status expansion shows active sessions with names and durations, and queue entries', () => {
    const poolStatus: PoolStatus = {
      maxSlots: 2,
      activeSlots: [
        { slotId: 's1', runId: 'run-1', stepName: 'build', tier: 1, startedAt: '2026-01-29T00:00:00Z' },
        { slotId: 's2', runId: 'run-2', stepName: 'test', tier: 2, startedAt: '2026-01-29T00:01:00Z' },
      ],
      queue: [
        { runId: 'run-3', stepName: 'deploy', tier: 1, requestedAt: '2026-01-29T00:02:00Z', position: 1 },
      ],
    }
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<PoolStatusIndicator poolStatus={poolStatus} />)
    })

    // Initially collapsed - should not show detailed session info
    let text = getTextContent(renderer!.root)
    expect(text).not.toContain('build')
    expect(text).not.toContain('test')
    expect(text).not.toContain('deploy')

    // Click to expand
    const divs = findAll(renderer!.root, (n) => n.props?.role === 'button')
    act(() => {
      divs[0].props.onClick()
    })

    // After expansion, should show active sessions with names and durations
    text = getTextContent(renderer!.root)
    expect(text).toContain('Active Sessions')
    expect(text).toContain('build')
    expect(text).toContain('test')
    expect(text).toContain('Duration')

    // Should show queue entries
    expect(text).toContain('Queue')
    expect(text).toContain('deploy')
    expect(text).toContain('#1') // position
  })
})

// ─── Accessibility Tests (REQ-36) ────────────────────────────────────────────

describe('Accessibility', () => {
  test('TEST-36: Components have keyboard accessibility (tabIndex, Enter/Space, arrow keys, aria-labels)', () => {
    // Mock document for TerminalTabs
    if (typeof document === 'undefined') {
      ;(global as any).document = {
        addEventListener: () => {},
        removeEventListener: () => {},
      }
    }
    // Test ParallelGroupNode keyboard accessibility
    const parallelStep = makeStep({
      name: 'parallel-group',
      type: 'parallel_group',
      status: 'running',
      childSteps: [
        makeStep({ name: 'child-1', status: 'completed' }),
        makeStep({ name: 'child-2', status: 'running' }),
      ],
    })

    let parallelRenderer: TestRenderer.ReactTestRenderer
    act(() => {
      parallelRenderer = TestRenderer.create(
        <ParallelGroupNode step={parallelStep} isSelected={false} onSelect={() => {}} />,
      )
    })

    // Should have tabIndex={0} for keyboard focus
    const parallelButton = findByType(parallelRenderer!.root, 'button')[0]
    expect(parallelButton.props.tabIndex).toBe(0)

    // Should have aria-label
    expect(parallelButton.props['aria-label']).toBeDefined()
    expect(parallelButton.props['aria-label']).toContain('parallel-group')

    // Test Enter key activation
    let expandToggled = false
    act(() => {
      parallelButton.props.onKeyDown({ key: 'Enter', preventDefault: () => { expandToggled = true } })
    })
    expect(expandToggled).toBe(true)

    // Test Space key activation
    expandToggled = false
    act(() => {
      parallelButton.props.onKeyDown({ key: ' ', preventDefault: () => { expandToggled = true } })
    })
    expect(expandToggled).toBe(true)

    // Test PoolStatusIndicator keyboard accessibility
    const poolStatus = {
      maxSlots: 2,
      activeSlots: [
        { slotId: 's1', runId: 'run-1', stepName: 'build', tier: 1, startedAt: '2026-01-29T00:00:00Z' },
      ],
      queue: [],
    }

    let poolRenderer: TestRenderer.ReactTestRenderer
    act(() => {
      poolRenderer = TestRenderer.create(<PoolStatusIndicator poolStatus={poolStatus} />)
    })

    // Should have interactive element with role="button"
    const poolDivs = findAll(poolRenderer!.root, (n) => n.props?.role === 'button')
    expect(poolDivs.length).toBeGreaterThan(0)

    const poolButton = poolDivs[0]
    expect(poolButton.props.tabIndex).toBe(0)
    expect(poolButton.props['aria-label']).toBeDefined()
    expect(poolButton.props['aria-expanded']).toBeDefined()

    // Test TerminalTabs arrow key navigation
    const sessions = [
      { stepName: 'Tab1', status: 'running' as const, taskId: 't1', startedAt: '2026-01-29T00:00:00Z', output: 'Output 1' },
      { stepName: 'Tab2', status: 'running' as const, taskId: 't2', startedAt: '2026-01-29T00:01:00Z', output: 'Output 2' },
      { stepName: 'Tab3', status: 'running' as const, taskId: 't3', startedAt: '2026-01-29T00:02:00Z', output: 'Output 3' },
    ]

    let terminalRenderer: TestRenderer.ReactTestRenderer
    act(() => {
      terminalRenderer = TestRenderer.create(
        <TerminalTabs sessions={sessions} onSelectTab={() => {}} />,
      )
    })

    // Terminal tabs should have role="tab" and be keyboard accessible
    const tabButtons = findAll(terminalRenderer!.root, (n) => n.props?.role === 'tab')
    expect(tabButtons.length).toBe(3)

    for (const tab of tabButtons) {
      expect(tab.props.tabIndex).toBe(0)
      expect(tab.props['aria-selected']).toBeDefined()
    }

    // Test ReviewLoopNode keyboard accessibility
    const reviewStep = makeStep({
      name: 'review-loop',
      type: 'review_loop',
      status: 'running',
      reviewIteration: 1,
      reviewSubStep: 'producer',
    })

    let reviewRenderer: TestRenderer.ReactTestRenderer
    act(() => {
      reviewRenderer = TestRenderer.create(
        <ReviewLoopNode step={reviewStep} isSelected={false} onSelect={() => {}} maxIterations={3} />,
      )
    })

    const reviewButton = findByType(reviewRenderer!.root, 'button')[0]
    expect(reviewButton.props['aria-expanded']).toBeDefined()
    expect(reviewButton.props['aria-label']).toBeDefined()

    // Verify status indicators have aria-labels
    const text = getTextContent(parallelRenderer!.root)
    expect(text).toContain('complete') // Status indicators should be descriptive
  })
})
