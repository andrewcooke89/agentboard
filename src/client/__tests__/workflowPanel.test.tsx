// workflowPanel.test.tsx - Tests for WorkflowPanel, compact PipelineDiagram, and TaskItem workflow badge
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import PipelineDiagram from '../components/PipelineDiagram'
import StepNode from '../components/StepNode'
import TaskItem from '../components/TaskItem'
import type { StepRunState, Task, WorkflowRun } from '@shared/types'

// ─── Mock workflowStore ──────────────────────────────────────────────────────

let mockActiveRuns: WorkflowRun[] = []

mock.module('../stores/workflowStore', () => ({
  useWorkflowStore: Object.assign(() => ({ workflowRuns: mockActiveRuns }), {
    getState: () => ({ workflowRuns: mockActiveRuns }),
    subscribe: () => () => {},
    setState: () => {},
    destroy: () => {},
  }),
  useActiveRuns: () => mockActiveRuns,
  getActiveRuns: () => mockActiveRuns,
}))

// Import after mock setup
const { default: WorkflowPanel } = await import('../components/WorkflowPanel')

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectPath: '/home/user/project',
    prompt: 'Test task prompt',
    templateId: null,
    priority: 5,
    status: 'queued',
    sessionName: null,
    tmuxWindow: null,
    createdAt: '2026-01-29T00:00:00Z',
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    completionMethod: null,
    retryCount: 0,
    maxRetries: 3,
    timeoutSeconds: 300,
    outputPath: null,
    parentTaskId: null,
    followUpPrompt: null,
    metadata: null,
    ...overrides,
  }
}

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

function findByType(root: TestRenderer.ReactTestInstance, type: string) {
  return findAll(root, (n) => n.type === type)
}

function findByTestId(root: TestRenderer.ReactTestInstance, testId: string) {
  return findAll(root, (n) => n.props?.['data-testid'] === testId)
}

// ─── WorkflowPanel Tests ────────────────────────────────────────────────────

describe('WorkflowPanel', () => {
  beforeEach(() => {
    mockActiveRuns = []
  })

  test('renders empty state when no active runs', () => {
    mockActiveRuns = []
    const renderer = TestRenderer.create(
      <WorkflowPanel isOpen={true} onClose={() => {}} />,
    )
    const text = getTextContent(renderer.root)
    expect(text).toContain('No active workflow runs')
  })

  test('renders active runs with workflow name and step count', () => {
    mockActiveRuns = [makeRun()]
    const renderer = TestRenderer.create(
      <WorkflowPanel isOpen={true} onClose={() => {}} />,
    )
    const text = getTextContent(renderer.root)
    expect(text).toContain('Test Workflow')
    expect(text).toContain('Step 1 of 3')
  })

  test('renders multiple active runs', () => {
    mockActiveRuns = [
      makeRun({ id: 'run-1', workflow_name: 'Build Pipeline' }),
      makeRun({ id: 'run-2', workflow_name: 'Deploy Pipeline' }),
    ]
    const renderer = TestRenderer.create(
      <WorkflowPanel isOpen={true} onClose={() => {}} />,
    )
    const text = getTextContent(renderer.root)
    expect(text).toContain('Build Pipeline')
    expect(text).toContain('Deploy Pipeline')
  })

  test('renders status badge for running workflow', () => {
    mockActiveRuns = [makeRun({ status: 'running' })]
    const renderer = TestRenderer.create(
      <WorkflowPanel isOpen={true} onClose={() => {}} />,
    )
    const text = getTextContent(renderer.root)
    expect(text).toContain('running')
  })

  test('applies translate-x-full when closed', () => {
    mockActiveRuns = []
    const renderer = TestRenderer.create(
      <WorkflowPanel isOpen={false} onClose={() => {}} />,
    )
    const panel = findAll(renderer.root, (n) =>
      typeof n.props?.className === 'string' && n.props.className.includes('translate-x-full'),
    )
    expect(panel.length).toBeGreaterThan(0)
  })

  test('applies translate-x-0 when open', () => {
    mockActiveRuns = []
    const renderer = TestRenderer.create(
      <WorkflowPanel isOpen={true} onClose={() => {}} />,
    )
    const panel = findAll(renderer.root, (n) =>
      typeof n.props?.className === 'string' && n.props.className.includes('translate-x-0'),
    )
    expect(panel.length).toBeGreaterThan(0)
  })

  test('calls onClose when close button clicked', () => {
    let closed = false
    mockActiveRuns = []
    const renderer = TestRenderer.create(
      <WorkflowPanel isOpen={true} onClose={() => { closed = true }} />,
    )
    const closeButton = findAll(renderer.root, (n) =>
      n.type === 'button' && n.props?.['aria-label'] === 'Close workflow panel',
    )
    expect(closeButton.length).toBe(1)
    act(() => {
      closeButton[0].props.onClick()
    })
    expect(closed).toBe(true)
  })

  test('has correct aria attributes', () => {
    mockActiveRuns = []
    const renderer = TestRenderer.create(
      <WorkflowPanel isOpen={true} onClose={() => {}} />,
    )
    const panel = findAll(renderer.root, (n) => n.props?.role === 'complementary')
    expect(panel.length).toBe(1)
    expect(panel[0].props['aria-label']).toBe('Workflow monitoring panel')
  })
})

// ─── Compact PipelineDiagram Tests ──────────────────────────────────────────

describe('PipelineDiagram compact mode', () => {
  test('renders smaller padding in compact mode', () => {
    const run = makeRun()
    const renderer = TestRenderer.create(<PipelineDiagram run={run} compact />)
    const scrollContainer = findByTestId(renderer.root, 'pipeline-scroll')
    expect(scrollContainer.length).toBeGreaterThan(0)
    expect(scrollContainer[0].props.className).toContain('py-2')
    expect(scrollContainer[0].props.className).toContain('px-1')
  })

  test('renders normal padding when compact is false', () => {
    const run = makeRun()
    const renderer = TestRenderer.create(<PipelineDiagram run={run} compact={false} />)
    const scrollContainer = findByTestId(renderer.root, 'pipeline-scroll')
    expect(scrollContainer[0].props.className).toContain('py-4')
    expect(scrollContainer[0].props.className).toContain('px-2')
  })

  test('renders normal padding when compact is not specified', () => {
    const run = makeRun()
    const renderer = TestRenderer.create(<PipelineDiagram run={run} />)
    const scrollContainer = findByTestId(renderer.root, 'pipeline-scroll')
    expect(scrollContainer[0].props.className).toContain('py-4')
  })
})

describe('StepNode compact mode', () => {
  test('renders smaller min-width in compact mode', () => {
    const step = makeStep({ name: 'Build', type: 'spawn_session' })
    const renderer = TestRenderer.create(
      <StepNode step={step} index={0} isSelected={false} isFocused={false} onClick={() => {}} compact />,
    )
    const button = findByType(renderer.root, 'button')[0]
    expect(button.props.className).toContain('min-w-[80px]')
    expect(button.props.className).toContain('px-2')
    expect(button.props.className).toContain('py-1')
  })

  test('hides type label in compact mode', () => {
    const step = makeStep({ name: 'Build', type: 'spawn_session' })
    const renderer = TestRenderer.create(
      <StepNode step={step} index={0} isSelected={false} isFocused={false} onClick={() => {}} compact />,
    )
    const text = getTextContent(renderer.root)
    expect(text).toContain('Build')
    expect(text).not.toContain('session')
  })

  test('shows type label when not compact', () => {
    const step = makeStep({ name: 'Build', type: 'spawn_session' })
    const renderer = TestRenderer.create(
      <StepNode step={step} index={0} isSelected={false} isFocused={false} onClick={() => {}} compact={false} />,
    )
    const text = getTextContent(renderer.root)
    expect(text).toContain('Build')
    expect(text).toContain('session')
  })

  test('uses smaller text in compact mode', () => {
    const step = makeStep({ name: 'Build' })
    const renderer = TestRenderer.create(
      <StepNode step={step} index={0} isSelected={false} isFocused={false} onClick={() => {}} compact />,
    )
    const nameSpan = findAll(renderer.root, (n) =>
      typeof n.props?.className === 'string' && n.props.className.includes('font-medium'),
    )
    expect(nameSpan.length).toBeGreaterThan(0)
    expect(nameSpan[0].props.className).toContain('text-[10px]')
  })

  test('uses normal min-width when not compact', () => {
    const step = makeStep({ name: 'Build' })
    const renderer = TestRenderer.create(
      <StepNode step={step} index={0} isSelected={false} isFocused={false} onClick={() => {}} />,
    )
    const button = findByType(renderer.root, 'button')[0]
    expect(button.props.className).toContain('min-w-[120px]')
  })
})

// ─── TaskItem Workflow Badge Tests ──────────────────────────────────────────

describe('TaskItem workflow badge', () => {
  const defaultProps = {
    isSelected: false,
    onSelect: () => {},
    onCancel: () => {},
    onRetry: () => {},
    onViewOutput: () => {},
  }

  test('shows workflow badge when metadata has workflow info', () => {
    const task = makeTask({
      metadata: JSON.stringify({
        workflow_run_id: 'run-abc-123',
        workflow_step_name: 'Build Step',
      }),
    })
    const renderer = TestRenderer.create(
      <TaskItem task={task} {...defaultProps} />,
    )
    const badges = findByTestId(renderer.root, 'workflow-badge')
    expect(badges.length).toBe(1)
    const text = getTextContent(badges[0])
    expect(text).toContain('Build Step')
  })

  test('does not show workflow badge when metadata is null', () => {
    const task = makeTask({ metadata: null })
    const renderer = TestRenderer.create(
      <TaskItem task={task} {...defaultProps} />,
    )
    const badges = findByTestId(renderer.root, 'workflow-badge')
    expect(badges.length).toBe(0)
  })

  test('does not show workflow badge when metadata has no workflow fields', () => {
    const task = makeTask({
      metadata: JSON.stringify({ some_other_field: 'value' }),
    })
    const renderer = TestRenderer.create(
      <TaskItem task={task} {...defaultProps} />,
    )
    const badges = findByTestId(renderer.root, 'workflow-badge')
    expect(badges.length).toBe(0)
  })

  test('does not show workflow badge when metadata is invalid JSON', () => {
    const task = makeTask({ metadata: 'not-json{' })
    const renderer = TestRenderer.create(
      <TaskItem task={task} {...defaultProps} />,
    )
    const badges = findByTestId(renderer.root, 'workflow-badge')
    expect(badges.length).toBe(0)
  })

  test('workflow badge has correct styling', () => {
    const task = makeTask({
      metadata: JSON.stringify({
        workflow_run_id: 'run-1',
        workflow_step_name: 'Deploy',
      }),
    })
    const renderer = TestRenderer.create(
      <TaskItem task={task} {...defaultProps} />,
    )
    const badges = findByTestId(renderer.root, 'workflow-badge')
    expect(badges[0].props.className).toContain('bg-indigo-500/20')
    expect(badges[0].props.className).toContain('text-indigo-300')
    expect(badges[0].props.className).toContain('rounded-full')
  })

  test('workflow badge has title with run ID', () => {
    const task = makeTask({
      metadata: JSON.stringify({
        workflow_run_id: 'run-abc-123',
        workflow_step_name: 'Deploy',
      }),
    })
    const renderer = TestRenderer.create(
      <TaskItem task={task} {...defaultProps} />,
    )
    const badges = findByTestId(renderer.root, 'workflow-badge')
    expect(badges[0].props.title).toBe('Workflow run: run-abc-123')
  })
})
