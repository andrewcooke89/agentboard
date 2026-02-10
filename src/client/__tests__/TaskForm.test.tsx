import { describe, expect, test, mock } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'

mock.module('../stores/settingsStore', () => ({
  useSettingsStore: (selector?: Function) => {
    const state = {
      projectPathPresets: ['/projects/a'],
      commandPresets: [
        { id: 'claude', label: 'Claude', baseCommand: 'claude', modifiers: '', isBuiltIn: true, agentType: 'claude' },
        { id: 'codex', label: 'Codex', baseCommand: 'codex', modifiers: '', isBuiltIn: true, agentType: 'codex' },
      ],
    }
    return typeof selector === 'function' ? selector(state) : state
  },
}))

const { default: TaskForm } = await import('../components/TaskForm')

function renderForm(overrides: Record<string, unknown> = {}) {
  const props = {
    templates: [],
    defaultProjectPath: '/test/path',
    sendMessage: () => {},
    onClose: () => {},
    ...overrides,
  }
  return TestRenderer.create(<TaskForm {...props} />)
}

describe('TaskForm', () => {
  test('renders ProjectPathPicker with preset button', () => {
    const tree = renderForm()
    const root = tree.root
    // ProjectPathPicker should render a button for the preset '/projects/a'
    // The preset button text is the last segment of the path
    const buttons = root.findAll((el) => el.type === 'button')
    const presetButton = buttons.find((b) => {
      try {
        return b.children.includes('a')
      } catch {
        return false
      }
    })
    expect(presetButton).toBeDefined()
  })

  test('renders AgentTypePicker with Default/Claude/Codex buttons', () => {
    const tree = renderForm()
    const root = tree.root
    const buttons = root.findAll((el) => el.type === 'button')
    const labels = buttons.map((b) => {
      try {
        return typeof b.children[0] === 'string' ? b.children[0] : ''
      } catch {
        return ''
      }
    })
    expect(labels).toContain('Default')
    expect(labels).toContain('Claude')
    expect(labels).toContain('Codex')
  })

  test('submit includes metadata with agent_type when agent selected', () => {
    let sentMessage: Record<string, unknown> | null = null
    const sendMessage = (msg: Record<string, unknown>) => { sentMessage = msg }
    const tree = renderForm({ sendMessage })
    const root = tree.root

    // Click 'Claude' agent type button
    const buttons = root.findAll((el) => el.type === 'button')
    const claudeBtn = buttons.find((b) => {
      try { return b.children.includes('Claude') } catch { return false }
    })
    act(() => { claudeBtn?.props.onClick?.() })

    // Fill in prompt (required)
    const textareas = root.findAllByType('textarea')
    const promptArea = textareas[0]
    act(() => { promptArea.props.onChange({ target: { value: 'test prompt' } }) })

    // Submit the form
    const form = root.findByType('form')
    act(() => { form.props.onSubmit({ preventDefault: () => {} }) })

    expect(sentMessage).toBeDefined()
    expect(sentMessage!.metadata).toBeDefined()
    const meta = JSON.parse(sentMessage!.metadata as string)
    expect(meta.agent_type).toBe('claude')
  })

  test('submit works without agent type selected', () => {
    let sentMessage: Record<string, unknown> | null = null
    const sendMessage = (msg: Record<string, unknown>) => { sentMessage = msg }
    const tree = renderForm({ sendMessage })
    const root = tree.root

    // Fill in prompt
    const textareas = root.findAllByType('textarea')
    act(() => { textareas[0].props.onChange({ target: { value: 'test prompt' } }) })

    // Submit
    const form = root.findByType('form')
    act(() => { form.props.onSubmit({ preventDefault: () => {} }) })

    expect(sentMessage).toBeDefined()
    // metadata should be undefined when no agent type and no tags
    expect(sentMessage!.metadata).toBeUndefined()
  })
})
