// workflowList.test.tsx - Unit tests for WorkflowList component
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { WorkflowDefinition } from '@shared/types'

// ─── Mock store state ─────────────────────────────────────────────────────────

let mockState: Record<string, unknown> = {}

mock.module('../stores/workflowStore', () => ({
  useWorkflowStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    if (typeof selector === 'function') return selector(mockState)
    return mockState
  },
}))

// Import AFTER mock is set up
import WorkflowList from '../components/WorkflowList'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'wf-1',
    name: 'Test Workflow',
    description: 'A test workflow',
    yaml_content: 'steps: []',
    file_path: null,
    is_valid: true,
    validation_errors: [],
    step_count: 3,
    created_at: '2026-01-29T00:00:00Z',
    updated_at: '2026-01-29T01:00:00Z',
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

beforeEach(() => {
  mockState = {
    workflows: [],
    loadingWorkflows: false,
    hasLoaded: true,
    fetchWorkflows: mock(() => Promise.resolve({ ok: true })),
  }
})

describe('WorkflowList', () => {
  test('renders empty state when no workflows', () => {
    const renderer = TestRenderer.create(
      <WorkflowList onSelectWorkflow={() => {}} onCreateNew={() => {}} />,
    )
    const root = renderer.root
    const text = getTextContent(root)
    expect(text).toContain('No workflows yet')
  })

  test('renders loading state', () => {
    mockState = {
      ...mockState,
      loadingWorkflows: true,
      hasLoaded: false,
    }
    const renderer = TestRenderer.create(
      <WorkflowList onSelectWorkflow={() => {}} onCreateNew={() => {}} />,
    )
    const text = getTextContent(renderer.root)
    expect(text).toContain('Loading workflows')
  })

  test('renders workflow list with names', () => {
    mockState = {
      ...mockState,
      workflows: [
        makeWorkflow({ id: 'wf-1', name: 'Deploy Pipeline' }),
        makeWorkflow({ id: 'wf-2', name: 'Test Suite', is_valid: false }),
      ],
    }
    const renderer = TestRenderer.create(
      <WorkflowList onSelectWorkflow={() => {}} onCreateNew={() => {}} />,
    )
    const text = getTextContent(renderer.root)
    expect(text).toContain('Deploy Pipeline')
    expect(text).toContain('Test Suite')
  })

  test('renders step count and validity', () => {
    mockState = {
      ...mockState,
      workflows: [
        makeWorkflow({ id: 'wf-1', name: 'Valid WF', is_valid: true, step_count: 5 }),
        makeWorkflow({ id: 'wf-2', name: 'Invalid WF', is_valid: false, step_count: 2 }),
      ],
    }
    const renderer = TestRenderer.create(
      <WorkflowList onSelectWorkflow={() => {}} onCreateNew={() => {}} />,
    )
    const text = getTextContent(renderer.root)
    expect(text).toContain('5')
    expect(text).toContain('2')
  })

  test('calls onSelectWorkflow when workflow name clicked', () => {
    const onSelect = mock(() => {})
    mockState = {
      ...mockState,
      workflows: [makeWorkflow({ id: 'wf-42', name: 'Clickable WF' })],
    }
    const renderer = TestRenderer.create(
      <WorkflowList onSelectWorkflow={onSelect} onCreateNew={() => {}} />,
    )
    // Find the button inside the table that contains the workflow name
    const buttons = findByType(renderer.root, 'button')
    const nameButton = buttons.find((b) => getTextContent(b) === 'Clickable WF')
    expect(nameButton).toBeDefined()
    act(() => {
      nameButton!.props.onClick()
    })
    expect(onSelect).toHaveBeenCalledWith('wf-42')
  })

  test('calls onCreateNew when Create New button clicked', () => {
    const onCreate = mock(() => {})
    const renderer = TestRenderer.create(
      <WorkflowList onSelectWorkflow={() => {}} onCreateNew={onCreate} />,
    )
    const buttons = findByType(renderer.root, 'button')
    const createBtn = buttons.find((b) => getTextContent(b) === 'Create New')
    expect(createBtn).toBeDefined()
    act(() => {
      createBtn!.props.onClick()
    })
    expect(onCreate).toHaveBeenCalled()
  })

  test('fetches workflows on mount when not loaded', () => {
    const fetchFn = mock(() => Promise.resolve({ ok: true }))
    mockState = {
      ...mockState,
      hasLoaded: false,
      fetchWorkflows: fetchFn,
    }
    act(() => {
      TestRenderer.create(
        <WorkflowList onSelectWorkflow={() => {}} onCreateNew={() => {}} />,
      )
    })
    expect(fetchFn).toHaveBeenCalled()
  })
})
