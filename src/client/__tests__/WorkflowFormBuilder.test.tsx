// WorkflowFormBuilder.test.tsx — Unit tests for WorkflowFormBuilder
import { describe, expect, test, mock } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'

// ─── Mock stores ─────────────────────────────────────────────────────────────

const realSettingsStore = await import('../stores/settingsStore')
realSettingsStore.useSettingsStore.setState({
  projectPathPresets: [],
  commandPresets: [
    { id: 'claude', label: 'Claude', baseCommand: 'claude', modifiers: '', isBuiltIn: true, agentType: 'claude' },
    { id: 'codex', label: 'Codex', baseCommand: 'codex', modifiers: '', isBuiltIn: true, agentType: 'codex' },
  ],
})

mock.module('../stores/settingsStore', () => realSettingsStore)

const { default: WorkflowFormBuilder, formToYaml, yamlToForm, validateForm } = await import(
  '../components/WorkflowFormBuilder'
)
import type { FormState } from '../components/WorkflowFormBuilder'

// ─── Pure function tests ────────────────────────────────────────────────────

describe('formToYaml', () => {
  test('converts form state to valid YAML string', () => {
    const state: FormState = {
      name: 'test-workflow',
      description: 'A test',
      steps: [
        {
          name: 'step-1',
          type: 'spawn_session',
          projectPath: '/tmp/project',
          prompt: 'Do work',
        },
      ],
      variables: [],
    }
    const result = formToYaml(state)
    expect(result).toContain('name: test-workflow')
    expect(result).toContain('description: A test')
    expect(result).toContain('projectPath: /tmp/project')
    expect(result).toContain('prompt: Do work')
    expect(result).toContain('type: spawn_session')
  })
})

describe('yamlToForm', () => {
  test('parses YAML back to form state', () => {
    const yamlStr = `name: my-wf
description: desc
steps:
  - name: s1
    type: delay
    seconds: 30
`
    const result = yamlToForm(yamlStr)
    expect(result).not.toBeNull()
    expect(result!.name).toBe('my-wf')
    expect(result!.description).toBe('desc')
    expect(result!.steps).toHaveLength(1)
    expect(result!.steps[0].name).toBe('s1')
    expect(result!.steps[0].type).toBe('delay')
    expect(result!.steps[0].seconds).toBe(30)
  })

  test('returns null for invalid YAML', () => {
    expect(yamlToForm('{{{')).toBeNull()
    expect(yamlToForm('name: foo')).toBeNull() // no steps array
    expect(yamlToForm('')).toBeNull()
  })
})

describe('validateForm', () => {
  test('catches missing name, empty steps, missing required fields', () => {
    const errors = validateForm({ name: '', description: '', steps: [], variables: [] })
    expect(errors).toContain('Workflow name is required')
    expect(errors).toContain('At least one step is required')
  })

  test('validates spawn_session requires projectPath and prompt', () => {
    const errors = validateForm({
      name: 'wf',
      description: '',
      steps: [{ name: 'step-1', type: 'spawn_session' }],
      variables: [],
    })
    expect(errors).toContain('Step 1: project path is required')
    expect(errors).toContain('Step 1: prompt is required')
  })

  test('validates check_file requires path', () => {
    const errors = validateForm({
      name: 'wf',
      description: '',
      steps: [{ name: 'step-1', type: 'check_file' }],
      variables: [],
    })
    expect(errors).toContain('Step 1: path is required')
  })

  test('validates delay requires seconds > 0', () => {
    const errors = validateForm({
      name: 'wf',
      description: '',
      steps: [{ name: 'step-1', type: 'delay' }],
      variables: [],
    })
    expect(errors).toContain('Step 1: seconds must be > 0')
  })

  test('validates check_output requires step and contains', () => {
    const errors = validateForm({
      name: 'wf',
      description: '',
      steps: [{ name: 'step-1', type: 'check_output' }],
      variables: [],
    })
    expect(errors).toContain('Step 1: step reference is required')
    expect(errors).toContain('Step 1: contains text is required')
  })

  test('catches duplicate step names', () => {
    const errors = validateForm({
      name: 'wf',
      description: '',
      steps: [
        { name: 'dup', type: 'delay', seconds: 5 },
        { name: 'dup', type: 'delay', seconds: 10 },
      ],
      variables: [],
    })
    expect(errors).toContain('Step 2: duplicate name "dup"')
  })
})

// ─── Component rendering tests ──────────────────────────────────────────────

const noOp = () => {}

describe('WorkflowFormBuilder component', () => {
  test('renders name/description inputs and Add Step button', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <WorkflowFormBuilder onChange={noOp} onValidationChange={noOp} />
      )
    })
    const root = renderer.root

    // Name input
    const nameInput = root.findByProps({ id: 'form-workflow-name' })
    expect(nameInput.props.type).toBe('text')

    // Description input
    const descInput = root.findByProps({ id: 'form-workflow-description' })
    expect(descInput.props.type).toBe('text')

    // Add Step button
    const buttons = root.findAllByType('button')
    const addBtn = buttons.find(b => b.children.includes('Add Step'))
    expect(addBtn).toBeDefined()
  })

  test('clicking Add Step adds a new step card', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <WorkflowFormBuilder onChange={noOp} onValidationChange={noOp} />
      )
    })
    const root = renderer.root

    // Initially no StepFormCard
    const { StepFormCard } = require('../components/StepFormCard')
    expect(root.findAllByType(StepFormCard)).toHaveLength(0)

    // Click Add Step
    const buttons = root.findAllByType('button')
    const addBtn = buttons.find(b => b.children.includes('Add Step'))!
    act(() => {
      addBtn.props.onClick()
    })

    // Now should have 1 StepFormCard
    expect(root.findAllByType(StepFormCard)).toHaveLength(1)
  })

  test('onChange fires with YAML when form changes', () => {
    const onChangeCalls: Array<[string, boolean]> = []
    const handleChange = (yamlStr: string, valid: boolean) => {
      onChangeCalls.push([yamlStr, valid])
    }

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <WorkflowFormBuilder onChange={handleChange} onValidationChange={noOp} />
      )
    })

    // Initial render fires onChange
    expect(onChangeCalls.length).toBeGreaterThanOrEqual(1)

    // Type a name
    const nameInput = renderer.root.findByProps({ id: 'form-workflow-name' })
    act(() => {
      nameInput.props.onChange({ target: { value: 'new-wf' } })
    })

    // Should have more calls now
    const lastCall = onChangeCalls[onChangeCalls.length - 1]
    expect(lastCall[0]).toContain('name: new-wf')
  })
})
