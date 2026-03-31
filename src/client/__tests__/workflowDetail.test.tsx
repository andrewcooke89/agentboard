// workflowDetail.test.tsx - Unit tests for WorkflowDetail component
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { WorkflowDefinition, WorkflowRun, StepRunState } from '@shared/types'

// ─── Mock store ──────────────────────────────────────────────────────────────

let mockState: Record<string, unknown> = {}

mock.module('../stores/workflowStore', () => ({
  useWorkflowStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    if (typeof selector === 'function') return selector(mockState)
    return mockState
  },
}))

// Import AFTER mocks
import WorkflowDetail from '../components/WorkflowDetail'

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'wf-1',
    name: 'Test Workflow',
    description: 'A test description',
    yaml_content: 'steps:\n  - name: step1',
    file_path: null,
    is_valid: true,
    validation_errors: [],
    step_count: 3,
    created_at: '2026-01-29T00:00:00Z',
    updated_at: '2026-01-29T01:00:00Z',
    ...overrides,
  }
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    workflow_id: 'wf-1',
    workflow_name: 'Test Workflow',
    status: 'completed',
    current_step_index: 2,
    steps_state: [
      makeStep({ name: 'Step 1', status: 'completed' }),
      makeStep({ name: 'Step 2', status: 'completed' }),
    ],
    output_dir: '/tmp/test',
    started_at: '2026-01-29T00:00:00Z',
    completed_at: '2026-01-29T00:05:00Z',
    error_message: null,
    created_at: '2026-01-29T00:00:00Z',
    variables: null,
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

function findByType(root: TestRenderer.ReactTestInstance, type: string) {
  return findAll(root, (n) => n.type === type)
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

// ─── Tests ────────────────────────────────────────────────────────────────────

const mockGetWorkflow = mock(() => Promise.resolve({ ok: true }))
const mockFetchRuns = mock(() => Promise.resolve({ ok: true }))
const mockTriggerRun = mock(() => Promise.resolve({ ok: true }))
const mockDeleteWorkflow = mock(() => Promise.resolve({ ok: true }))
const mockResumeRun = mock(() => Promise.resolve({ ok: true }))
const mockCancelRun = mock(() => Promise.resolve({ ok: true }))

beforeEach(() => {
  mockGetWorkflow.mockClear()
  mockFetchRuns.mockClear()
  mockTriggerRun.mockClear()
  mockDeleteWorkflow.mockClear()
  mockResumeRun.mockClear()
  mockCancelRun.mockClear()

  mockState = {
    workflows: [makeWorkflow()],
    workflowRuns: [],
    loadingRuns: false,
    getWorkflow: mockGetWorkflow,
    fetchRuns: mockFetchRuns,
    triggerRun: mockTriggerRun,
    deleteWorkflow: mockDeleteWorkflow,
    resumeRun: mockResumeRun,
    cancelRun: mockCancelRun,
  }
})

describe('WorkflowDetail', () => {
  test('renders workflow name and description', () => {
    const renderer = TestRenderer.create(
      <WorkflowDetail workflowId="wf-1" onBack={() => {}} onEdit={() => {}} />,
    )
    const text = getTextContent(renderer.root)
    expect(text).toContain('Test Workflow')
    expect(text).toContain('A test description')
  })

  test('renders YAML content in code block', () => {
    const renderer = TestRenderer.create(
      <WorkflowDetail workflowId="wf-1" onBack={() => {}} onEdit={() => {}} />,
    )
    const codeElements = findAll(renderer.root, (n) => n.type === 'code')
    expect(codeElements.length).toBeGreaterThan(0)
    const yamlText = getTextContent(codeElements[0])
    expect(yamlText).toContain('steps:')
  })

  test('renders step count and validity', () => {
    const renderer = TestRenderer.create(
      <WorkflowDetail workflowId="wf-1" onBack={() => {}} onEdit={() => {}} />,
    )
    const text = getTextContent(renderer.root)
    expect(text).toContain('3 steps')
    expect(text).toContain('Valid')
  })

  test('shows validation errors for invalid workflow', () => {
    mockState = {
      ...mockState,
      workflows: [
        makeWorkflow({
          is_valid: false,
          validation_errors: ['Missing step name', 'Invalid type'],
        }),
      ],
    }
    const renderer = TestRenderer.create(
      <WorkflowDetail workflowId="wf-1" onBack={() => {}} onEdit={() => {}} />,
    )
    const text = getTextContent(renderer.root)
    expect(text).toContain('Missing step name')
    expect(text).toContain('Invalid type')
    expect(text).toContain('Invalid')
  })

  test('Run button calls triggerRun', () => {
    const renderer = TestRenderer.create(
      <WorkflowDetail workflowId="wf-1" onBack={() => {}} onEdit={() => {}} />,
    )
    const buttons = findByType(renderer.root, 'button')
    const runBtn = buttons.find((b) => getTextContent(b) === 'Run')
    expect(runBtn).toBeDefined()
    act(() => {
      runBtn!.props.onClick()
    })
    expect(mockTriggerRun).toHaveBeenCalledWith('wf-1')
  })

  test('Run button is disabled when workflow is invalid', () => {
    mockState = {
      ...mockState,
      workflows: [makeWorkflow({ is_valid: false })],
    }
    const renderer = TestRenderer.create(
      <WorkflowDetail workflowId="wf-1" onBack={() => {}} onEdit={() => {}} />,
    )
    const buttons = findByType(renderer.root, 'button')
    const runBtn = buttons.find((b) => getTextContent(b) === 'Run')
    expect(runBtn).toBeDefined()
    expect(runBtn!.props.disabled).toBe(true)
  })

  test('Edit button calls onEdit', () => {
    const onEdit = mock(() => {})
    const renderer = TestRenderer.create(
      <WorkflowDetail workflowId="wf-1" onBack={() => {}} onEdit={onEdit} />,
    )
    const buttons = findByType(renderer.root, 'button')
    const editBtn = buttons.find((b) => getTextContent(b) === 'Edit')
    expect(editBtn).toBeDefined()
    act(() => {
      editBtn!.props.onClick()
    })
    expect(onEdit).toHaveBeenCalledWith('wf-1')
  })

  test('Delete button with confirmation calls deleteWorkflow', () => {
    // Mock window.confirm to return true
    const originalConfirm = globalThis.window?.confirm
    globalThis.window = globalThis.window || ({} as Window & typeof globalThis)
    globalThis.window.confirm = mock(() => true) as unknown as (message?: string) => boolean

    const onBack = mock(() => {})
    const renderer = TestRenderer.create(
      <WorkflowDetail workflowId="wf-1" onBack={onBack} onEdit={() => {}} />,
    )
    const buttons = findByType(renderer.root, 'button')
    const deleteBtn = buttons.find((b) => getTextContent(b) === 'Delete')
    expect(deleteBtn).toBeDefined()
    act(() => {
      deleteBtn!.props.onClick()
    })
    expect(globalThis.window.confirm).toHaveBeenCalled()
    expect(mockDeleteWorkflow).toHaveBeenCalledWith('wf-1')

    // Restore
    if (originalConfirm) globalThis.window.confirm = originalConfirm
  })

  test('Back button calls onBack', () => {
    const onBack = mock(() => {})
    const renderer = TestRenderer.create(
      <WorkflowDetail workflowId="wf-1" onBack={onBack} onEdit={() => {}} />,
    )
    const buttons = findByType(renderer.root, 'button')
    // The back button contains the arrow character
    const backBtn = buttons.find((b) => getTextContent(b).includes('Back to workflows'))
    expect(backBtn).toBeDefined()
    act(() => {
      backBtn!.props.onClick()
    })
    expect(onBack).toHaveBeenCalled()
  })

  test('shows empty run state', () => {
    const renderer = TestRenderer.create(
      <WorkflowDetail workflowId="wf-1" onBack={() => {}} onEdit={() => {}} />,
    )
    const text = getTextContent(renderer.root)
    expect(text).toContain('No runs yet')
  })

  test('renders run history table', () => {
    mockState = {
      ...mockState,
      workflowRuns: [
        makeRun({ id: 'run-1', status: 'completed' }),
        makeRun({ id: 'run-2', status: 'failed' }),
      ],
    }
    const renderer = TestRenderer.create(
      <WorkflowDetail workflowId="wf-1" onBack={() => {}} onEdit={() => {}} />,
    )
    const text = getTextContent(renderer.root)
    expect(text).toContain('run-1'.slice(0, 8))
    expect(text).toContain('run-2'.slice(0, 8))
    expect(text).toContain('completed')
    expect(text).toContain('failed')
  })

  test('shows Resume button for failed runs', () => {
    mockState = {
      ...mockState,
      workflowRuns: [makeRun({ id: 'run-fail', status: 'failed' })],
    }
    const renderer = TestRenderer.create(
      <WorkflowDetail workflowId="wf-1" onBack={() => {}} onEdit={() => {}} />,
    )
    const buttons = findByType(renderer.root, 'button')
    const resumeBtn = buttons.find((b) => getTextContent(b) === 'Resume')
    expect(resumeBtn).toBeDefined()
    act(() => {
      resumeBtn!.props.onClick()
    })
    expect(mockResumeRun).toHaveBeenCalledWith('run-fail')
  })

  test('shows Cancel button for running runs', () => {
    mockState = {
      ...mockState,
      workflowRuns: [makeRun({ id: 'run-active', status: 'running' })],
    }
    const renderer = TestRenderer.create(
      <WorkflowDetail workflowId="wf-1" onBack={() => {}} onEdit={() => {}} />,
    )
    const buttons = findByType(renderer.root, 'button')
    const cancelBtn = buttons.find((b) => getTextContent(b) === 'Cancel')
    expect(cancelBtn).toBeDefined()
    act(() => {
      cancelBtn!.props.onClick()
    })
    expect(mockCancelRun).toHaveBeenCalledWith('run-active')
  })

  test('fetches workflow and runs on mount', () => {
    TestRenderer.create(
      <WorkflowDetail workflowId="wf-1" onBack={() => {}} onEdit={() => {}} />,
    )
    expect(mockGetWorkflow).toHaveBeenCalledWith('wf-1')
    expect(mockFetchRuns).toHaveBeenCalledWith('wf-1')
  })

  test('loading state when workflow not found', () => {
    mockState = {
      ...mockState,
      workflows: [],
    }
    const renderer = TestRenderer.create(
      <WorkflowDetail workflowId="wf-missing" onBack={() => {}} onEdit={() => {}} />,
    )
    const text = getTextContent(renderer.root)
    expect(text).toContain('Loading workflow')
  })
})
