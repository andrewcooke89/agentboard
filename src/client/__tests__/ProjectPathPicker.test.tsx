import { describe, expect, mock, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'

mock.module('../stores/settingsStore', () => ({
  useSettingsStore: (selector?: Function) => {
    const state = { projectPathPresets: ['/path/a', '/path/b'] }
    return typeof selector === 'function' ? selector(state) : state
  },
}))

mock.module('../components/DirectoryBrowser', () => ({
  DirectoryBrowser: (props: { onSelect: (p: string) => void; onCancel: () => void; initialPath?: string }) => (
    <div data-testid="directory-browser">
      <button data-testid="mock-select" onClick={() => props.onSelect('/selected/path')}>Select</button>
      <button data-testid="mock-cancel" onClick={() => props.onCancel()}>Cancel</button>
    </div>
  ),
}))

import { ProjectPathPicker } from '../components/ProjectPathPicker'

describe('ProjectPathPicker', () => {
  test('renders input with value', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <ProjectPathPicker value="/my/project" onChange={() => {}} />
      )
    })

    const input = renderer.root.findByType('input')
    expect(input.props.value).toBe('/my/project')
  })

  test('renders preset buttons from store', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <ProjectPathPicker value="" onChange={() => {}} />
      )
    })

    const buttons = renderer.root.findAllByType('button')
    // 2 preset buttons + 1 Browse button = 3
    const presetButtons = buttons.filter((b) => b.props.title)
    expect(presetButtons).toHaveLength(2)
    // Labels are derived from last path segment
    expect(presetButtons[0].props.children).toBe('a')
    expect(presetButtons[1].props.children).toBe('b')
  })

  test('clicking preset calls onChange with that path', () => {
    const changes: string[] = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <ProjectPathPicker value="" onChange={(p) => changes.push(p)} />
      )
    })

    const presetButtons = renderer.root
      .findAllByType('button')
      .filter((b) => b.props.title)

    act(() => {
      presetButtons[0].props.onClick()
    })

    expect(changes).toEqual(['/path/a'])
  })

  test('browse button opens DirectoryBrowser', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <ProjectPathPicker value="/start" onChange={() => {}} />
      )
    })

    // DirectoryBrowser should not be rendered initially
    const browsersBefore = renderer.root.findAllByProps({ 'data-testid': 'directory-browser' })
    expect(browsersBefore).toHaveLength(0)

    // Click Browse button
    const browseButton = renderer.root
      .findAllByType('button')
      .find((b) => b.props.children === 'Browse')!

    act(() => {
      browseButton.props.onClick()
    })

    // DirectoryBrowser should now be rendered
    const browsersAfter = renderer.root.findAllByProps({ 'data-testid': 'directory-browser' })
    expect(browsersAfter).toHaveLength(1)
  })

  test('onChange fires when input changes', () => {
    const changes: string[] = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <ProjectPathPicker value="" onChange={(p) => changes.push(p)} />
      )
    })

    const input = renderer.root.findByType('input')
    act(() => {
      input.props.onChange({ target: { value: '/new/path' } })
    })

    expect(changes).toEqual(['/new/path'])
  })
})
