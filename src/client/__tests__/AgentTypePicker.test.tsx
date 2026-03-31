import { describe, expect, mock, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'

const mockPresets = [
  { id: 'claude', label: 'Claude', baseCommand: 'claude', modifiers: '', isBuiltIn: true, agentType: 'claude' as const },
  { id: 'codex', label: 'Codex', baseCommand: 'codex', modifiers: '', isBuiltIn: true, agentType: 'codex' as const },
  { id: 'custom-1', label: 'Custom', baseCommand: 'custom', modifiers: '', isBuiltIn: false },
]

const realSettingsStore = await import('../stores/settingsStore')
realSettingsStore.useSettingsStore.setState({ commandPresets: mockPresets })

mock.module('../stores/settingsStore', () => realSettingsStore)

import { AgentTypePicker } from '../components/AgentTypePicker'

describe('AgentTypePicker', () => {
  test('renders buttons for each preset with agentType', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <AgentTypePicker value="claude" onChange={() => {}} />
      )
    })

    const buttons = renderer.root.findAllByType('button')
    // Only presets with agentType (claude, codex) - not custom-1
    expect(buttons).toHaveLength(2)
    expect(buttons[0].props.children).toBe('Claude')
    expect(buttons[1].props.children).toBe('Codex')
  })

  test('active button gets btn-primary class', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <AgentTypePicker value="codex" onChange={() => {}} />
      )
    })

    const buttons = renderer.root.findAllByType('button')
    // Claude button should NOT have btn-primary
    expect(buttons[0].props.className).not.toContain('btn-primary')
    // Codex button should have btn-primary
    expect(buttons[1].props.className).toContain('btn-primary')
  })

  test('clicking a button calls onChange', () => {
    const changes: Array<'claude' | 'codex' | undefined> = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <AgentTypePicker value="claude" onChange={(v) => changes.push(v)} />
      )
    })

    const buttons = renderer.root.findAllByType('button')
    act(() => {
      buttons[1].props.onClick()
    })

    expect(changes).toEqual(['codex'])
  })

  test('allowNone shows Default button', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <AgentTypePicker value="claude" onChange={() => {}} allowNone />
      )
    })

    const buttons = renderer.root.findAllByType('button')
    // Default + Claude + Codex = 3
    expect(buttons).toHaveLength(3)
    expect(buttons[0].props.children).toBe('Default')
    // Default should NOT have btn-primary (value is 'claude')
    expect(buttons[0].props.className).not.toContain('btn-primary')
  })

  test('Default button calls onChange(undefined)', () => {
    const changes: Array<'claude' | 'codex' | undefined> = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <AgentTypePicker value="claude" onChange={(v) => changes.push(v)} allowNone />
      )
    })

    const buttons = renderer.root.findAllByType('button')
    act(() => {
      buttons[0].props.onClick()
    })

    expect(changes).toEqual([undefined])
  })
})
