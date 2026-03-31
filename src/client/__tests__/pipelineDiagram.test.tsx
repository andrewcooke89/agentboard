// pipelineDiagram.test.tsx - Unit tests for PipelineDiagram and StepNode components
import { describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import PipelineDiagram from '../components/PipelineDiagram'
import StepNode from '../components/StepNode'
import type { StepRunState, StepRunStatus, WorkflowRun } from '@shared/types'

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
function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
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

// ─── StepNode Tests ──────────────────────────────────────────────────────────

describe('StepNode', () => {
  test('renders step name and type', () => {
    const step = makeStep({ name: 'Build', type: 'spawn_session' })
    const renderer = TestRenderer.create(
      <StepNode step={step} index={0} isSelected={false} isFocused={false} onClick={() => {}} />,
    )
    const text = getTextContent(renderer.root)
    expect(text).toContain('Build')
    expect(text).toContain('session')
  })

  test('renders correct aria-label with step name and status', () => {
    const step = makeStep({ name: 'Deploy', status: 'running' })
    const renderer = TestRenderer.create(
      <StepNode step={step} index={0} isSelected={false} isFocused={false} onClick={() => {}} />,
    )
    const button = findByType(renderer.root, 'button')[0]
    expect(button.props['aria-label']).toBe('Step Deploy, status Running')
  })

  test('has tabIndex 0 for keyboard focus', () => {
    const step = makeStep()
    const renderer = TestRenderer.create(
      <StepNode step={step} index={0} isSelected={false} isFocused={false} onClick={() => {}} />,
    )
    const button = findByType(renderer.root, 'button')[0]
    expect(button.props.tabIndex).toBe(0)
  })

  const statusTestCases: { status: StepRunStatus; expectedClass: string }[] = [
    { status: 'pending', expectedClass: 'bg-gray-700' },
    { status: 'running', expectedClass: 'bg-blue-600' },
    { status: 'completed', expectedClass: 'bg-green-600' },
    { status: 'failed', expectedClass: 'bg-red-600' },
    { status: 'skipped', expectedClass: 'bg-yellow-500' },
  ]

  for (const { status, expectedClass } of statusTestCases) {
    test(`applies ${expectedClass} for ${status} status`, () => {
      const step = makeStep({ status })
      const renderer = TestRenderer.create(
        <StepNode step={step} index={0} isSelected={false} isFocused={false} onClick={() => {}} />,
      )
      const button = findByType(renderer.root, 'button')[0]
      expect(button.props.className).toContain(expectedClass)
    })
  }

  test('applies ring classes when selected', () => {
    const step = makeStep()
    const renderer = TestRenderer.create(
      <StepNode step={step} index={0} isSelected={true} isFocused={false} onClick={() => {}} />,
    )
    const button = findByType(renderer.root, 'button')[0]
    expect(button.props.className).toContain('ring-2')
  })

  test('applies outline classes when focused', () => {
    const step = makeStep()
    const renderer = TestRenderer.create(
      <StepNode step={step} index={0} isSelected={false} isFocused={true} onClick={() => {}} />,
    )
    const button = findByType(renderer.root, 'button')[0]
    expect(button.props.className).toContain('outline')
  })

  test('calls onClick with index when clicked', () => {
    let clickedIndex = -1
    const step = makeStep()
    const renderer = TestRenderer.create(
      <StepNode step={step} index={3} isSelected={false} isFocused={false} onClick={(i) => { clickedIndex = i }} />,
    )
    const button = findByType(renderer.root, 'button')[0]
    act(() => {
      button.props.onClick()
    })
    expect(clickedIndex).toBe(3)
  })

  test('renders check_file type as "file"', () => {
    const step = makeStep({ name: 'Verify', type: 'check_file' })
    const renderer = TestRenderer.create(
      <StepNode step={step} index={0} isSelected={false} isFocused={false} onClick={() => {}} />,
    )
    const text = getTextContent(renderer.root)
    expect(text).toContain('file')
  })

  test('renders delay type label', () => {
    const step = makeStep({ name: 'Wait', type: 'delay' })
    const renderer = TestRenderer.create(
      <StepNode step={step} index={0} isSelected={false} isFocused={false} onClick={() => {}} />,
    )
    const text = getTextContent(renderer.root)
    expect(text).toContain('delay')
  })

  test('renders check_output type as "output"', () => {
    const step = makeStep({ name: 'Check', type: 'check_output' })
    const renderer = TestRenderer.create(
      <StepNode step={step} index={0} isSelected={false} isFocused={false} onClick={() => {}} />,
    )
    const text = getTextContent(renderer.root)
    expect(text).toContain('output')
  })

  test('has data-step-index attribute', () => {
    const step = makeStep()
    const renderer = TestRenderer.create(
      <StepNode step={step} index={5} isSelected={false} isFocused={false} onClick={() => {}} />,
    )
    const button = findByType(renderer.root, 'button')[0]
    expect(button.props['data-step-index']).toBe(5)
  })
})

// ─── PipelineDiagram Tests ───────────────────────────────────────────────────

describe('PipelineDiagram', () => {
  test('renders empty state when no run provided', () => {
    const renderer = TestRenderer.create(<PipelineDiagram run={null} />)
    const text = getTextContent(renderer.root)
    expect(text).toContain('No workflow run selected')
  })

  test('renders empty state when steps_state is empty', () => {
    const run = makeRun({ steps_state: [] })
    const renderer = TestRenderer.create(<PipelineDiagram run={run} />)
    const text = getTextContent(renderer.root)
    expect(text).toContain('No steps defined')
  })

  test('renders all step nodes', () => {
    const run = makeRun()
    const renderer = TestRenderer.create(<PipelineDiagram run={run} />)
    const buttons = findByType(renderer.root, 'button')
    // 3 step buttons (no close button when nothing selected)
    expect(buttons.length).toBe(3)
  })

  test('renders step names in order', () => {
    const run = makeRun()
    const renderer = TestRenderer.create(<PipelineDiagram run={run} />)
    const text = getTextContent(renderer.root)
    expect(text).toContain('Step 1')
    expect(text).toContain('Step 2')
    expect(text).toContain('Step 3')
  })

  test('renders connection lines between nodes', () => {
    const run = makeRun()
    const renderer = TestRenderer.create(<PipelineDiagram run={run} />)
    // Connection lines have w-8 h-0.5 classes
    const lines = findAll(renderer.root, (n) =>
      typeof n.props?.className === 'string' && n.props.className.includes('w-8') && n.props.className.includes('h-0.5'),
    )
    // 2 connection lines for 3 nodes (between 1-2 and 2-3)
    expect(lines.length).toBe(2)
  })

  test('shows detail panel when node is clicked', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<PipelineDiagram run={makeRun({
        steps_state: [
          makeStep({ name: 'Build', status: 'completed', startedAt: '2026-01-29T00:00:00Z', completedAt: '2026-01-29T00:01:00Z' }),
        ],
      })} />)
    })

    // Click the step node
    act(() => {
      const buttons = findByType(renderer!.root, 'button')
      buttons[0].props.onClick()
    })

    // Detail panel should now show
    const text = getTextContent(renderer!.root)
    expect(text).toContain('Build')
    expect(text).toContain('spawn_session')
    expect(text).toContain('completed')
    // Close button appears
    const allButtons = findByType(renderer!.root, 'button')
    const closeButton = allButtons.find((b) => getTextContent(b) === 'Close')
    expect(closeButton).toBeDefined()
  })

  test('closes detail panel when close button is clicked', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<PipelineDiagram run={makeRun({
        steps_state: [makeStep({ name: 'Build', status: 'completed' })],
      })} />)
    })

    // Click to open
    act(() => {
      findByType(renderer!.root, 'button')[0].props.onClick()
    })

    // Click close
    act(() => {
      const allButtons = findByType(renderer!.root, 'button')
      const closeButton = allButtons.find((b) => getTextContent(b) === 'Close')
      closeButton!.props.onClick()
    })

    // Detail panel should be gone - only 1 button (step node)
    const buttonsAfter = findByType(renderer!.root, 'button')
    expect(buttonsAfter.length).toBe(1)
  })

  test('shows error message in detail panel for failed step', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<PipelineDiagram run={makeRun({
        steps_state: [
          makeStep({ name: 'Deploy', status: 'failed', errorMessage: 'Connection refused' }),
        ],
      })} />)
    })

    act(() => {
      findByType(renderer!.root, 'button')[0].props.onClick()
    })

    const text = getTextContent(renderer!.root)
    expect(text).toContain('Connection refused')
  })

  test('shows skipped reason in detail panel', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<PipelineDiagram run={makeRun({
        steps_state: [
          makeStep({ name: 'Optional', status: 'skipped', skippedReason: 'Condition not met' }),
        ],
      })} />)
    })

    act(() => {
      findByType(renderer!.root, 'button')[0].props.onClick()
    })

    const text = getTextContent(renderer!.root)
    expect(text).toContain('Condition not met')
  })

  test('shows task ID in detail panel', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<PipelineDiagram run={makeRun({
        steps_state: [
          makeStep({ name: 'Build', status: 'completed', taskId: 'task-abc-123' }),
        ],
      })} />)
    })

    act(() => {
      findByType(renderer!.root, 'button')[0].props.onClick()
    })

    const text = getTextContent(renderer!.root)
    expect(text).toContain('task-abc-123')
  })

  test('toggles selection when same node clicked twice', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<PipelineDiagram run={makeRun({
        steps_state: [makeStep({ name: 'Build', status: 'completed' })],
      })} />)
    })

    // Click to open
    act(() => {
      findByType(renderer!.root, 'button')[0].props.onClick()
    })
    // Should have close button (panel open)
    let allButtons = findByType(renderer!.root, 'button')
    expect(allButtons.length).toBe(2)

    // Click same node to close
    act(() => {
      findByType(renderer!.root, 'button')[0].props.onClick()
    })
    // Panel should be closed
    allButtons = findByType(renderer!.root, 'button')
    expect(allButtons.length).toBe(1)
  })

  test('has aria-label on pipeline container', () => {
    const run = makeRun()
    const renderer = TestRenderer.create(<PipelineDiagram run={run} />)
    const toolbar = findAll(renderer.root, (n) => n.props?.role === 'toolbar')
    expect(toolbar.length).toBe(1)
    expect(toolbar[0].props['aria-label']).toBe('Pipeline steps')
  })

  test('handles missing step data gracefully', () => {
    const minimalStep: StepRunState = {
      name: 'Minimal',
      type: 'delay',
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
    }
    const run = makeRun({ steps_state: [minimalStep] })
    const renderer = TestRenderer.create(<PipelineDiagram run={run} />)
    const text = getTextContent(renderer.root)
    expect(text).toContain('Minimal')
    expect(text).toContain('delay')
  })

  test('renders overflow container for horizontal scroll', () => {
    const run = makeRun()
    const renderer = TestRenderer.create(<PipelineDiagram run={run} />)
    const scrollContainers = findAll(renderer.root, (n) =>
      typeof n.props?.className === 'string' && n.props.className.includes('overflow-x-auto'),
    )
    expect(scrollContainers.length).toBeGreaterThan(0)
  })

  test('connection line color reflects active state', () => {
    const run = makeRun({
      steps_state: [
        makeStep({ name: 'A', status: 'completed' }),
        makeStep({ name: 'B', status: 'running' }),
        makeStep({ name: 'C', status: 'pending' }),
      ],
    })
    const renderer = TestRenderer.create(<PipelineDiagram run={run} />)
    const lines = findAll(renderer.root, (n) =>
      typeof n.props?.className === 'string' && n.props.className.includes('w-8') && n.props.className.includes('h-0.5'),
    )
    // Line before B (running) should be active color
    expect(lines[0].props.className).toContain('bg-gray-400')
    // Line before C (pending) should be inactive color
    expect(lines[1].props.className).toContain('bg-gray-700')
  })
})

// ─── Result File Indicator Tests (WO-008) ───────────────────────────────────
// TODO: Uncomment these tests once result file indicators are implemented in StepNode.tsx

describe.skip('StepNode — result file indicators', () => {
  test('shows green indicator when resultCollected is true and resultFile set', () => {
    const step = makeStep({
      name: 'Analyze',
      status: 'completed',
      resultFile: 'analysis.json',
      resultCollected: true,
      resultContent: '{"status":"ok"}',
    })
    const renderer = TestRenderer.create(
      <StepNode step={step} index={0} isSelected={false} isFocused={false} onClick={() => {}} />,
    )

    // Look for success indicator (green checkmark or similar)
    const svgs = findAll(renderer.root, (n) => n.type === 'svg')
    const hasSuccessIndicator = svgs.some(svg => {
      const className = svg.props?.className || ''
      return typeof className === 'string' && className.includes('text-green')
    })
    expect(hasSuccessIndicator).toBe(true)
  })

  test('shows yellow warning when resultFile is set but not collected and status is completed', () => {
    const step = makeStep({
      name: 'Analyze',
      status: 'completed',
      resultFile: 'analysis.json',
      resultCollected: false,
      resultContent: null,
    })
    const renderer = TestRenderer.create(
      <StepNode step={step} index={0} isSelected={false} isFocused={false} onClick={() => {}} />,
    )

    // Look for warning indicator (yellow icon)
    const svgs = findAll(renderer.root, (n) => n.type === 'svg')
    const hasWarningIndicator = svgs.some(svg => {
      const className = svg.props?.className || ''
      return typeof className === 'string' && className.includes('text-yellow')
    })
    expect(hasWarningIndicator).toBe(true)
  })

  test('no result indicator when resultFile is null', () => {
    const step = makeStep({
      name: 'Build',
      status: 'completed',
      resultFile: null,
      resultCollected: false,
      resultContent: null,
    })
    const renderer = TestRenderer.create(
      <StepNode step={step} index={0} isSelected={false} isFocused={false} onClick={() => {}} />,
    )

    // Look for result indicators - should not find any
    const svgs = findAll(renderer.root, (n) => n.type === 'svg')
    const hasResultIndicator = svgs.some(svg => {
      const className = svg.props?.className || ''
      if (typeof className !== 'string') return false
      return className.includes('text-green') || className.includes('text-yellow')
    })
    expect(hasResultIndicator).toBe(false)
  })

  test('no warning when resultFile set but step is still running', () => {
    const step = makeStep({
      name: 'Analyze',
      status: 'running',
      resultFile: 'analysis.json',
      resultCollected: false,
      resultContent: null,
    })
    const renderer = TestRenderer.create(
      <StepNode step={step} index={0} isSelected={false} isFocused={false} onClick={() => {}} />,
    )

    // Warning should only appear for completed steps with uncollected results
    const svgs = findAll(renderer.root, (n) => n.type === 'svg')
    const hasWarningIndicator = svgs.some(svg => {
      const className = svg.props?.className || ''
      return typeof className === 'string' && className.includes('text-yellow')
    })
    expect(hasWarningIndicator).toBe(false)
  })
})
