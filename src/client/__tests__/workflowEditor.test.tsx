import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import { validateWorkflowYaml } from '../components/WorkflowEditor'
import type { WorkflowDefinition } from '@shared/types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_YAML = `name: test-workflow
description: Test
steps:
  - name: step-1
    type: spawn_session
    projectPath: /tmp
    prompt: "hello"
`

const INVALID_YAML_NO_STEPS = `name: bad-workflow
`

const INVALID_YAML_PARSE = `name: [
invalid yaml`

const INVALID_YAML_BAD_STEP = `name: test
steps:
  - name: step-1
    type: invalid_type
`

const fakeWorkflow: WorkflowDefinition = {
  id: 'wf-123',
  name: 'Existing Workflow',
  description: 'Existing description',
  yaml_content: VALID_YAML,
  file_path: null,
  is_valid: true,
  validation_errors: [],
  step_count: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

// ─── Mock stores ─────────────────────────────────────────────────────────────

let mockWorkflows: WorkflowDefinition[] = []
let createWorkflowMock = mock(() => Promise.resolve({ ok: true }))
let updateWorkflowMock = mock(() => Promise.resolve({ ok: true }))

const mockStoreState = () => ({
  workflows: mockWorkflows,
  createWorkflow: createWorkflowMock,
  updateWorkflow: updateWorkflowMock,
  getWorkflow: mock(() => Promise.resolve({ ok: true })),
})

mock.module('../stores/workflowStore', () => ({
  useWorkflowStore: (selector?: (s: ReturnType<typeof mockStoreState>) => unknown) => {
    const state = mockStoreState()
    if (typeof selector === 'function') return selector(state)
    return state
  },
}))

// Mock settingsStore for AgentTypePicker
const realSettingsStore = await import('../stores/settingsStore')
realSettingsStore.useSettingsStore.setState({
  commandPresets: [
    { id: 'claude', label: 'Claude', baseCommand: 'claude', modifiers: '', isBuiltIn: true, agentType: 'claude' as const },
    { id: 'codex', label: 'Codex', baseCommand: 'codex', modifiers: '', isBuiltIn: true, agentType: 'codex' as const },
  ],
})

mock.module('../stores/settingsStore', () => realSettingsStore)

const { default: WorkflowEditor } = await import('../components/WorkflowEditor')

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  mockWorkflows = []
  createWorkflowMock = mock(() => Promise.resolve({ ok: true }))
  updateWorkflowMock = mock(() => Promise.resolve({ ok: true }))
})

afterEach(() => {
  mockWorkflows = []
})

// ─── Pure validation function tests ─────────────────────────────────────────

describe('validateWorkflowYaml', () => {
  test('returns valid for correct YAML', () => {
    const result = validateWorkflowYaml(VALID_YAML)
    expect(result.valid).toBe(true)
    expect(result.stepCount).toBe(1)
    expect(result.errors).toEqual([])
  })

  test('returns errors for invalid YAML parse', () => {
    const result = validateWorkflowYaml(INVALID_YAML_PARSE)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toContain('YAML parse error')
  })

  test('returns errors for missing steps', () => {
    const result = validateWorkflowYaml(INVALID_YAML_NO_STEPS)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Workflow must have a "steps" field (array)')
  })

  test('returns errors for empty steps array', () => {
    const result = validateWorkflowYaml('name: test\nsteps: []')
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Workflow must have at least one step')
  })

  test('returns errors for invalid step type', () => {
    const result = validateWorkflowYaml(INVALID_YAML_BAD_STEP)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('"type" must be one of'))).toBe(true)
  })

  test('returns errors for missing workflow name', () => {
    const result = validateWorkflowYaml('steps:\n  - name: s1\n    type: delay')
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Workflow must have a "name" field (string)')
  })

  test('returns errors for step missing name', () => {
    const result = validateWorkflowYaml('name: test\nsteps:\n  - type: delay')
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('must have a "name" field'))).toBe(true)
  })
})

// ─── Component tests ────────────────────────────────────────────────────────

describe('WorkflowEditor component', () => {
  test('renders textarea with default YAML content for new workflow', () => {
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <WorkflowEditor onSave={() => {}} onCancel={() => {}} />
      )
    })

    // New workflows default to form mode
    // Form mode has a textarea for the prompt field in spawn_session steps
    const textareasInFormMode = renderer.root.findAllByType('textarea')
    expect(textareasInFormMode.length).toBe(1) // prompt field

    // Click the YAML tab to switch to YAML mode
    const yamlTab = renderer.root.findAll((node) =>
      node.props['data-testid'] === 'tab-yaml'
    )[0]

    act(() => {
      yamlTab.props.onClick()
    })

    // Now the YAML editor textarea should be visible
    const textareasInYamlMode = renderer.root.findAllByType('textarea')
    expect(textareasInYamlMode.length).toBe(1) // YAML editor
    expect(textareasInYamlMode[0].props['aria-label']).toBe('Workflow YAML content')

    // The YAML content may be reformatted by form builder, but should contain the key structure
    const yamlValue = textareasInYamlMode[0].props.value
    expect(yamlValue).toContain('name: my-workflow')
    expect(yamlValue).toContain('description: A workflow description')
    expect(yamlValue).toContain('type: spawn_session')

    act(() => {
      renderer.unmount()
    })
  })

  test('renders name and description inputs', () => {
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <WorkflowEditor onSave={() => {}} onCancel={() => {}} />
      )
    })

    const inputs = renderer.root.findAllByType('input')
    // Form builder mode adds additional inputs (projectPath, prompt, etc.)
    // We only verify that the name and description inputs exist
    expect(inputs.length).toBeGreaterThanOrEqual(2)

    // Find the name and description inputs by their placeholder text
    const nameInput = inputs.find((i) => i.props.placeholder === 'Workflow name')
    const descInput = inputs.find((i) => i.props.placeholder === 'A brief description')

    expect(nameInput).toBeDefined()
    expect(descInput).toBeDefined()

    act(() => {
      renderer.unmount()
    })
  })

  test('loads existing workflow when workflowId provided', () => {
    mockWorkflows = [fakeWorkflow]

    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <WorkflowEditor workflowId="wf-123" onSave={() => {}} onCancel={() => {}} />
      )
    })

    const inputs = renderer.root.findAllByType('input')
    expect(inputs[0].props.value).toBe('Existing Workflow')
    expect(inputs[1].props.value).toBe('Existing description')

    const textarea = renderer.root.findByType('textarea')
    expect(textarea.props.value).toBe(VALID_YAML)

    act(() => {
      renderer.unmount()
    })
  })

  test('cancel calls onCancel', () => {
    let cancelled = 0
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <WorkflowEditor onSave={() => {}} onCancel={() => { cancelled += 1 }} />
      )
    })

    const cancelButton = renderer.root
      .findAllByType('button')
      .find((b) => b.children.includes('Cancel'))

    expect(cancelButton).toBeDefined()

    act(() => {
      cancelButton!.props.onClick()
    })

    expect(cancelled).toBe(1)

    act(() => {
      renderer.unmount()
    })
  })

  test('save calls createWorkflow for new workflow', async () => {
    // Use fake timers to control debounce
    const timeouts: Array<{ fn: () => void; ms: number }> = []
    const origST = globalThis.setTimeout
    ;(globalThis as unknown as Record<string, unknown>).setTimeout = (fn: () => void, ms: number) => {
      timeouts.push({ fn, ms })
      return timeouts.length as unknown as ReturnType<typeof setTimeout>
    }

    let saved = 0
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <WorkflowEditor onSave={() => { saved += 1 }} onCancel={() => {}} />
      )
    })

    // Set name
    const inputs = renderer.root.findAllByType('input')
    act(() => {
      inputs[0].props.onChange({ target: { value: 'My Workflow' } })
    })

    // Set valid YAML
    const textarea = renderer.root.findByType('textarea')
    act(() => {
      textarea.props.onChange({ target: { value: VALID_YAML } })
    })

    // Flush debounce timers to trigger validation
    act(() => {
      for (const t of timeouts) {
        t.fn()
      }
      timeouts.length = 0
    })

    // Click save
    const saveButton = renderer.root
      .findAllByType('button')
      .find((b) => {
        const children = Array.isArray(b.children) ? b.children : [b.children]
        return children.includes('Save')
      })

    expect(saveButton).toBeDefined()

    await act(async () => {
      saveButton!.props.onClick()
    })

    expect(createWorkflowMock).toHaveBeenCalledTimes(1)
    expect(saved).toBe(1)

    // Restore
    ;(globalThis as unknown as Record<string, unknown>).setTimeout = origST

    act(() => {
      renderer.unmount()
    })
  })

  test('save calls updateWorkflow for existing workflow', async () => {
    const timeouts: Array<{ fn: () => void; ms: number }> = []
    const origST = globalThis.setTimeout
    ;(globalThis as unknown as Record<string, unknown>).setTimeout = (fn: () => void, ms: number) => {
      timeouts.push({ fn, ms })
      return timeouts.length as unknown as ReturnType<typeof setTimeout>
    }

    mockWorkflows = [fakeWorkflow]

    let saved = 0
    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(
        <WorkflowEditor workflowId="wf-123" onSave={() => { saved += 1 }} onCancel={() => {}} />
      )
    })

    // Flush debounce so validation passes for the loaded YAML
    act(() => {
      for (const t of timeouts) {
        t.fn()
      }
      timeouts.length = 0
    })

    // Click save
    const saveButton = renderer.root
      .findAllByType('button')
      .find((b) => {
        const children = Array.isArray(b.children) ? b.children : [b.children]
        return children.includes('Save')
      })

    expect(saveButton).toBeDefined()

    await act(async () => {
      saveButton!.props.onClick()
    })

    expect(updateWorkflowMock).toHaveBeenCalledTimes(1)
    expect(saved).toBe(1)

    // Restore
    ;(globalThis as unknown as Record<string, unknown>).setTimeout = origST

    act(() => {
      renderer.unmount()
    })
  })
})
