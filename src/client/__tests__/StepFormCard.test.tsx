import { describe, expect, test, mock } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { WorkflowStep } from '@shared/types'

// ─── Mock stores ─────────────────────────────────────────────────────────────

mock.module('../stores/settingsStore', () => ({
  useSettingsStore: (selector?: Function) => {
    const state = {
      projectPathPresets: [],
      commandPresets: [
        { id: 'claude', label: 'Claude', baseCommand: 'claude', modifiers: '', isBuiltIn: true, agentType: 'claude' },
        { id: 'codex', label: 'Codex', baseCommand: 'codex', modifiers: '', isBuiltIn: true, agentType: 'codex' },
      ],
    }
    return typeof selector === 'function' ? selector(state) : state
  },
}))

const { StepFormCard } = await import('../components/StepFormCard')

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name: 'test-step',
    type: 'spawn_session',
    ...overrides,
  }
}

const noOp = () => {}

function renderCard(
  stepOverrides: Partial<WorkflowStep> = {},
  props: Partial<{
    index: number
    totalSteps: number
    priorStepNames: string[]
    onChange: (step: WorkflowStep) => void
    onRemove: () => void
    onMoveUp: () => void
    onMoveDown: () => void
  }> = {}
) {
  const step = makeStep(stepOverrides)
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      <StepFormCard
        step={step}
        index={props.index ?? 0}
        totalSteps={props.totalSteps ?? 3}
        priorStepNames={props.priorStepNames ?? []}
        onChange={props.onChange ?? noOp}
        onRemove={props.onRemove ?? noOp}
        onMoveUp={props.onMoveUp ?? noOp}
        onMoveDown={props.onMoveDown ?? noOp}
      />
    )
  })
  return renderer
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('StepFormCard', () => {
  test('renders step name input with value', () => {
    const renderer = renderCard({ name: 'my-step' })
    const inputs = renderer.root.findAllByType('input')
    const nameInput = inputs.find((i) => i.props.value === 'my-step')
    expect(nameInput).toBeDefined()
    act(() => renderer.unmount())
  })

  test('renders type dropdown with all 4 options', () => {
    const renderer = renderCard()
    const selects = renderer.root.findAllByType('select')
    // First select is the type dropdown
    const typeSelect = selects[0]
    const options = typeSelect.findAllByType('option')
    const values = options.map((o) => o.props.value)
    expect(values).toContain('spawn_session')
    expect(values).toContain('check_file')
    expect(values).toContain('delay')
    expect(values).toContain('check_output')
    act(() => renderer.unmount())
  })

  test('shows spawn_session fields when type is spawn_session', () => {
    const renderer = renderCard({ type: 'spawn_session' })
    // Should have textarea for prompt
    const textareas = renderer.root.findAllByType('textarea')
    expect(textareas.length).toBeGreaterThan(0)
    // Should have timeout and retries selects (type select + timeout + retries = 3 selects)
    const selects = renderer.root.findAllByType('select')
    expect(selects.length).toBeGreaterThanOrEqual(3)
    act(() => renderer.unmount())
  })

  test('shows delay fields when type is delay', () => {
    const renderer = renderCard({ type: 'delay' })
    const inputs = renderer.root.findAllByType('input')
    const numberInput = inputs.find((i) => i.props.type === 'number')
    expect(numberInput).toBeDefined()
    expect(numberInput!.props.placeholder).toBe('e.g. 60')
    // No textarea for delay type
    const textareas = renderer.root.findAllByType('textarea')
    expect(textareas.length).toBe(0)
    act(() => renderer.unmount())
  })

  test('changing type calls onChange with updated step', () => {
    const onChangeMock = mock(() => {})
    const renderer = renderCard({ type: 'spawn_session' }, { onChange: onChangeMock })
    const selects = renderer.root.findAllByType('select')
    const typeSelect = selects[0]

    act(() => {
      typeSelect.props.onChange({ target: { value: 'delay' } })
    })

    expect(onChangeMock).toHaveBeenCalledTimes(1)
    const calledWith = (onChangeMock.mock.calls as unknown as WorkflowStep[][])[0][0]
    expect(calledWith.type).toBe('delay')
    expect(calledWith.name).toBe('test-step')
    // Type-specific fields should be cleared
    expect(calledWith.projectPath).toBeUndefined()
    expect(calledWith.prompt).toBeUndefined()
    act(() => renderer.unmount())
  })

  test('up/down buttons disabled at boundaries', () => {
    // First step: up disabled, down enabled
    const renderer1 = renderCard({}, { index: 0, totalSteps: 3 })
    const buttons1 = renderer1.root.findAllByType('button')
    const upBtn1 = buttons1.find((b) => b.props['aria-label'] === 'Move up')
    const downBtn1 = buttons1.find((b) => b.props['aria-label'] === 'Move down')
    expect(upBtn1!.props.disabled).toBe(true)
    expect(downBtn1!.props.disabled).toBe(false)
    act(() => renderer1.unmount())

    // Last step: up enabled, down disabled
    const renderer2 = renderCard({}, { index: 2, totalSteps: 3 })
    const buttons2 = renderer2.root.findAllByType('button')
    const upBtn2 = buttons2.find((b) => b.props['aria-label'] === 'Move up')
    const downBtn2 = buttons2.find((b) => b.props['aria-label'] === 'Move down')
    expect(upBtn2!.props.disabled).toBe(false)
    expect(downBtn2!.props.disabled).toBe(true)
    act(() => renderer2.unmount())
  })

  test('remove button calls onRemove', () => {
    const onRemoveMock = mock(() => {})
    const renderer = renderCard({}, { onRemove: onRemoveMock })
    const buttons = renderer.root.findAllByType('button')
    const removeBtn = buttons.find((b) => b.props['aria-label'] === 'Remove step')
    expect(removeBtn).toBeDefined()

    act(() => {
      removeBtn!.props.onClick()
    })

    expect(onRemoveMock).toHaveBeenCalledTimes(1)
    act(() => renderer.unmount())
  })
})
