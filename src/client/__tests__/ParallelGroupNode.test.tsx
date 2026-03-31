// ParallelGroupNode.test.tsx - Unit tests for ParallelGroupNode component
import { describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import ParallelGroupNode from '../components/ParallelGroupNode'
import type { StepRunState } from '@shared/types'

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
  test('REQ-01: renders group name and progress summary', () => {
    const group = makeStep({
      name: 'parallel-tests',
      type: 'parallel_group',
      status: 'running',
      childSteps: [
        makeStep({ name: 'test-1', status: 'completed' }),
        makeStep({ name: 'test-2', status: 'completed' }),
        makeStep({ name: 'test-3', status: 'running' }),
      ],
    })

    const renderer = TestRenderer.create(
      <ParallelGroupNode step={group} isSelected={false} onSelect={() => {}} />,
    )

    const text = getTextContent(renderer.root)
    expect(text).toContain('parallel-tests')
    expect(text).toContain('2/3 complete')
  })

  test('REQ-02: shows chevron icon and expands on click', () => {
    const group = makeStep({
      name: 'parallel-group',
      type: 'parallel_group',
      childSteps: [
        makeStep({ name: 'child-1', status: 'pending' }),
        makeStep({ name: 'child-2', status: 'pending' }),
        makeStep({ name: 'child-3', status: 'pending' }),
        makeStep({ name: 'child-4', status: 'pending' }),
      ],
    })

    const renderer = TestRenderer.create(
      <ParallelGroupNode step={group} isSelected={false} onSelect={() => {}} />,
    )

    // Should have a button with aria-expanded
    const buttons = findByType(renderer.root, 'button')
    const headerButton = buttons[0]
    expect(headerButton.props['aria-expanded']).toBeDefined()

    // Initially collapsed (>3 children)
    expect(headerButton.props['aria-expanded']).toBe(false)

    // Click to expand
    act(() => {
      headerButton.props.onClick()
    })

    expect(headerButton.props['aria-expanded']).toBe(true)
  })

  test('REQ-03: each child shows individual status with correct color', () => {
    const group = makeStep({
      name: 'parallel-group',
      type: 'parallel_group',
      childSteps: [
        makeStep({ name: 'child-completed', status: 'completed' }),
        makeStep({ name: 'child-failed', status: 'failed' }),
        makeStep({ name: 'child-running', status: 'running' }),
      ],
    })

    const renderer = TestRenderer.create(
      <ParallelGroupNode step={group} isSelected={false} onSelect={() => {}} />,
    )

    const text = getTextContent(renderer.root)
    expect(text).toContain('child-completed')
    expect(text).toContain('child-failed')
    expect(text).toContain('child-running')
    expect(text).toContain('Completed')
    expect(text).toContain('Failed')
    expect(text).toContain('Running')
  })

  test('REQ-04: collapsed by default for >3 children, expanded for <=3', () => {
    // >3 children: collapsed
    const largeGroup = makeStep({
      name: 'large-group',
      type: 'parallel_group',
      childSteps: [
        makeStep({ name: 'c1' }),
        makeStep({ name: 'c2' }),
        makeStep({ name: 'c3' }),
        makeStep({ name: 'c4' }),
      ],
    })

    const largeRenderer = TestRenderer.create(
      <ParallelGroupNode step={largeGroup} isSelected={false} onSelect={() => {}} />,
    )

    const largeButton = findByType(largeRenderer.root, 'button')[0]
    expect(largeButton.props['aria-expanded']).toBe(false)

    // <=3 children: expanded
    const smallGroup = makeStep({
      name: 'small-group',
      type: 'parallel_group',
      childSteps: [
        makeStep({ name: 'c1' }),
        makeStep({ name: 'c2' }),
        makeStep({ name: 'c3' }),
      ],
    })

    const smallRenderer = TestRenderer.create(
      <ParallelGroupNode step={smallGroup} isSelected={false} onSelect={() => {}} />,
    )

    const smallButton = findByType(smallRenderer.root, 'button')[0]
    expect(smallButton.props['aria-expanded']).toBe(true)
  })

  test('REQ-05: shows dependency info for pending child steps', () => {
    const group = makeStep({
      name: 'dep-group',
      type: 'parallel_group',
      childSteps: [
        makeStep({ name: 'independent', status: 'completed' }),
        {
          ...makeStep({ name: 'dependent', status: 'pending' }),
          depends_on: ['independent'],
        } as any,
      ],
    })

    const renderer = TestRenderer.create(
      <ParallelGroupNode step={group} isSelected={false} onSelect={() => {}} />,
    )

    const text = getTextContent(renderer.root)
    expect(text).toContain('depends_on: independent')
  })

  test('progress summary shows 0/N for all pending', () => {
    const group = makeStep({
      name: 'pending-group',
      type: 'parallel_group',
      childSteps: [
        makeStep({ name: 'p1', status: 'pending' }),
        makeStep({ name: 'p2', status: 'pending' }),
      ],
    })

    const renderer = TestRenderer.create(
      <ParallelGroupNode step={group} isSelected={false} onSelect={() => {}} />,
    )

    const text = getTextContent(renderer.root)
    expect(text).toContain('0/2 complete')
  })

  test('progress summary shows N/N for all completed', () => {
    const group = makeStep({
      name: 'done-group',
      type: 'parallel_group',
      childSteps: [
        makeStep({ name: 'd1', status: 'completed' }),
        makeStep({ name: 'd2', status: 'completed' }),
        makeStep({ name: 'd3', status: 'completed' }),
      ],
    })

    const renderer = TestRenderer.create(
      <ParallelGroupNode step={group} isSelected={false} onSelect={() => {}} />,
    )

    const text = getTextContent(renderer.root)
    expect(text).toContain('3/3 complete')
  })

  test('group status reflects children: completed when all completed', () => {
    const group = makeStep({
      name: 'all-done',
      type: 'parallel_group',
      childSteps: [
        makeStep({ name: 'c1', status: 'completed' }),
        makeStep({ name: 'c2', status: 'completed' }),
      ],
    })

    const renderer = TestRenderer.create(
      <ParallelGroupNode step={group} isSelected={false} onSelect={() => {}} />,
    )

    const button = findByType(renderer.root, 'button')[0]
    expect(button.props.className).toContain('bg-green-600')
  })

  test('group status reflects children: failed when any failed', () => {
    const group = makeStep({
      name: 'has-failure',
      type: 'parallel_group',
      childSteps: [
        makeStep({ name: 'c1', status: 'completed' }),
        makeStep({ name: 'c2', status: 'failed' }),
      ],
    })

    const renderer = TestRenderer.create(
      <ParallelGroupNode step={group} isSelected={false} onSelect={() => {}} />,
    )

    const button = findByType(renderer.root, 'button')[0]
    expect(button.props.className).toContain('bg-red-600')
  })

  test('group status reflects children: running when any running', () => {
    const group = makeStep({
      name: 'in-progress',
      type: 'parallel_group',
      childSteps: [
        makeStep({ name: 'c1', status: 'completed' }),
        makeStep({ name: 'c2', status: 'running' }),
        makeStep({ name: 'c3', status: 'pending' }),
      ],
    })

    const renderer = TestRenderer.create(
      <ParallelGroupNode step={group} isSelected={false} onSelect={() => {}} />,
    )

    const button = findByType(renderer.root, 'button')[0]
    expect(button.props.className).toContain('bg-blue-600')
  })

  test('keyboard navigation: Enter/Space toggles expand', () => {
    const group = makeStep({
      name: 'keyboard-group',
      type: 'parallel_group',
      childSteps: [
        makeStep({ name: 'c1' }),
        makeStep({ name: 'c2' }),
        makeStep({ name: 'c3' }),
        makeStep({ name: 'c4' }),
      ],
    })

    const renderer = TestRenderer.create(
      <ParallelGroupNode step={group} isSelected={false} onSelect={() => {}} />,
    )

    const button = findByType(renderer.root, 'button')[0]
    expect(button.props['aria-expanded']).toBe(false)

    // Press Enter
    act(() => {
      button.props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
    })

    expect(button.props['aria-expanded']).toBe(true)

    // Press Space
    act(() => {
      button.props.onKeyDown({ key: ' ', preventDefault: () => {} })
    })

    expect(button.props['aria-expanded']).toBe(false)
  })

  test('accessibility: has role=group and aria-label', () => {
    const group = makeStep({
      name: 'accessible-group',
      type: 'parallel_group',
      childSteps: [makeStep({ name: 'c1' })],
    })

    const renderer = TestRenderer.create(
      <ParallelGroupNode step={group} isSelected={false} onSelect={() => {}} />,
    )

    const divs = findByType(renderer.root, 'div')
    const groupDiv = divs.find((d) => d.props.role === 'group')
    expect(groupDiv).toBeDefined()
    expect(groupDiv?.props['aria-label']).toContain('accessible-group')
  })

  test('calls onSelect when header is clicked', () => {
    let selectCalled = false
    const group = makeStep({
      name: 'selectable',
      type: 'parallel_group',
      childSteps: [makeStep({ name: 'c1' })],
    })

    const renderer = TestRenderer.create(
      <ParallelGroupNode
        step={group}
        isSelected={false}
        onSelect={() => {
          selectCalled = true
        }}
      />,
    )

    const button = findByType(renderer.root, 'button')[0]
    act(() => {
      button.props.onClick()
    })

    expect(selectCalled).toBe(true)
  })

  test('shows selected state with ring styling', () => {
    const group = makeStep({
      name: 'selected-group',
      type: 'parallel_group',
      childSteps: [makeStep({ name: 'c1' })],
    })

    const renderer = TestRenderer.create(
      <ParallelGroupNode step={group} isSelected={true} onSelect={() => {}} />,
    )

    const button = findByType(renderer.root, 'button')[0]
    expect(button.props.className).toContain('ring-2')
    expect(button.props.className).toContain('ring-white')
  })

  test('handles empty childSteps array', () => {
    const group = makeStep({
      name: 'empty-group',
      type: 'parallel_group',
      childSteps: [],
    })

    const renderer = TestRenderer.create(
      <ParallelGroupNode step={group} isSelected={false} onSelect={() => {}} />,
    )

    const text = getTextContent(renderer.root)
    expect(text).toContain('0/0 complete')
  })

  test('handles undefined childSteps', () => {
    const group = makeStep({
      name: 'no-children',
      type: 'parallel_group',
    })

    const renderer = TestRenderer.create(
      <ParallelGroupNode step={group} isSelected={false} onSelect={() => {}} />,
    )

    const text = getTextContent(renderer.root)
    expect(text).toContain('0/0 complete')
  })
})
