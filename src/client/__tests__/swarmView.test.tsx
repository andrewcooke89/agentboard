import { beforeEach, describe, expect, mock, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { SwarmEvent, SwarmGroupState } from '../../shared/swarmTypes'

// ---------- mock store ----------

const mockFetchGroups = mock(() => Promise.resolve())
const mockSelectGroup = mock(() => {})
const mockSelectWo = mock(() => {})

const mockStore: Record<string, unknown> = {
  fetchGroups: mockFetchGroups,
  groups: [] as SwarmGroupState[],
  selectedGroupId: null as string | null,
  selectedWoId: null as string | null,
  selectGroup: mockSelectGroup,
  selectWo: mockSelectWo,
  eventLog: [] as SwarmEvent[],
}

mock.module('../../stores/swarmStore', () => ({
  useSwarmStore: (selector: (s: typeof mockStore) => unknown) => selector(mockStore),
}))

// ---------- mock child components ----------

mock.module('../components/swarm/DagGraph', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="dag-graph" data-selected={String(props.selectedWoId ?? '')} />
  ),
}))
mock.module('../components/swarm/GroupProgress', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="group-progress" data-group={props.group ? 'present' : 'null'} />
  ),
}))
mock.module('../components/swarm/WoDetail', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="wo-detail" data-wo={props.wo ? 'present' : 'null'} />
  ),
}))
mock.module('../components/swarm/EventLog', () => ({
  default: (props: { events: Array<Record<string, unknown>>; maxHeight?: string }) => (
    <div
      data-testid="event-log"
      data-count={String(props.events?.length ?? 0)}
      data-events={JSON.stringify(props.events ?? [])}
    />
  ),
}))

// ---------- helpers ----------

function makeGroup(overrides: Partial<SwarmGroupState> = {}): SwarmGroupState {
  return {
    groupId: 'grp-1',
    status: 'running',
    totalWos: 1,
    completedWos: 0,
    failedWos: 0,
    edges: [],
    wos: {
      w1: {
        woId: 'w1',
        title: 'Test WO',
        status: 'running',
        model: 'glm-5',
        attempt: 1,
        maxRetries: 2,
        escalationTier: 1,
        escalationChain: [],
        dependsOn: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        gateResults: null,
        errorHistory: [],
        filesChanged: [],
        startedAt: null,
        completedAt: null,
        durationSeconds: null,
        unifiedDiff: null,
      },
    },
    startedAt: null,
    totalDurationSeconds: null,
    totalTokens: { inputTokens: 0, outputTokens: 0 },
    ...overrides,
  }
}

// Import must happen after mock.module calls
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SwarmView = require('../components/swarm/SwarmView').default

beforeEach(() => {
  mockFetchGroups.mockClear()
  mockSelectGroup.mockClear()
  mockSelectWo.mockClear()
  mockStore.groups = []
  mockStore.selectedGroupId = null
  mockStore.selectedWoId = null
  mockStore.eventLog = []
})

describe('SwarmView', () => {
  test('renders "No active swarm" when groups is empty', () => {
    const renderer = TestRenderer.create(<SwarmView />)
    expect(renderer.toJSON()).toMatch(/No active swarm/)
    act(() => { renderer.unmount() })
  })

  test('renders DagGraph when a group exists', () => {
    mockStore.groups = [makeGroup()]
    const renderer = TestRenderer.create(<SwarmView />)
    const dag = renderer.root.findByProps({ 'data-testid': 'dag-graph' })
    expect(dag).toBeDefined()
    act(() => { renderer.unmount() })
  })

  test('does not show group tabs when only one group', () => {
    mockStore.groups = [makeGroup()]
    const renderer = TestRenderer.create(<SwarmView />)
    const buttons = renderer.root.findAllByType('button')
    // No tab buttons for group selector
    expect(buttons.length).toBe(0)
    act(() => { renderer.unmount() })
  })

  test('shows group tabs when multiple groups', () => {
    mockStore.groups = [
      makeGroup({ groupId: 'grp-1' }),
      makeGroup({ groupId: 'grp-2' }),
    ]
    const renderer = TestRenderer.create(<SwarmView />)
    const buttons = renderer.root.findAllByType('button')
    expect(buttons.length).toBe(2)
    expect(buttons[0].props.children).toBe('grp-1')
    expect(buttons[1].props.children).toBe('grp-2')
    act(() => { renderer.unmount() })
  })

  test('calls fetchGroups on mount', () => {
    const renderer = TestRenderer.create(<SwarmView />)
    expect(mockFetchGroups).toBeCalled()
    act(() => { renderer.unmount() })
  })

  test('converts group_started event to log entry with severity info', () => {
    const event: SwarmEvent = {
      type: 'group_started',
      groupId: 'grp-1',
      timestamp: 1000,
      totalWos: 3,
      woIds: ['w1', 'w2', 'w3'],
      edges: [],
    } as SwarmEvent
    mockStore.groups = [makeGroup()]
    mockStore.eventLog = [event]

    const renderer = TestRenderer.create(<SwarmView />)
    const eventLogEl = renderer.root.findByProps({ 'data-testid': 'event-log' })
    const events = JSON.parse(eventLogEl.props['data-events'] as string)
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('group_started')
    expect(events[0].severity).toBe('info')
    expect(events[0].message).toContain('3 WOs')
    act(() => { renderer.unmount() })
  })

  test('converts wo_completed event with >1000 tokens to K format', () => {
    const event: SwarmEvent = {
      type: 'wo_completed',
      groupId: 'grp-1',
      timestamp: 1001,
      woId: 'w1',
      durationSeconds: 45.3,
      tokenUsage: { inputTokens: 1500, outputTokens: 500 },
      filesChanged: ['a.ts'],
    } as SwarmEvent
    mockStore.groups = [makeGroup()]
    mockStore.eventLog = [event]

    const renderer = TestRenderer.create(<SwarmView />)
    const eventLogEl = renderer.root.findByProps({ 'data-testid': 'event-log' })
    const events = JSON.parse(eventLogEl.props['data-events'] as string)
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('wo_completed')
    expect(events[0].severity).toBe('success')
    // 1500 + 500 = 2000 → "2.0K"
    expect(events[0].message).toContain('2.0K')
    expect(events[0].message).toContain('45s')
    act(() => { renderer.unmount() })
  })

  test('converts wo_failed event with severity error', () => {
    const event: SwarmEvent = {
      type: 'wo_failed',
      groupId: 'grp-1',
      timestamp: 1002,
      woId: 'w2',
      model: 'glm-5',
      tier: 1,
      error: 'Compile error in foo.ts',
      attempt: 1,
      gateDetail: null,
    } as SwarmEvent
    mockStore.groups = [makeGroup()]
    mockStore.eventLog = [event]

    const renderer = TestRenderer.create(<SwarmView />)
    const eventLogEl = renderer.root.findByProps({ 'data-testid': 'event-log' })
    const events = JSON.parse(eventLogEl.props['data-events'] as string)
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('wo_failed')
    expect(events[0].severity).toBe('error')
    expect(events[0].message).toContain('w2 failed')
    act(() => { renderer.unmount() })
  })

  test('converts group_completed with failed status to severity error', () => {
    const event: SwarmEvent = {
      type: 'group_completed',
      groupId: 'grp-1',
      timestamp: 1003,
      status: 'failed',
      completedWos: 2,
      failedWos: 1,
      totalDurationSeconds: 120.5,
    } as SwarmEvent
    mockStore.groups = [makeGroup()]
    mockStore.eventLog = [event]

    const renderer = TestRenderer.create(<SwarmView />)
    const eventLogEl = renderer.root.findByProps({ 'data-testid': 'event-log' })
    const events = JSON.parse(eventLogEl.props['data-events'] as string)
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('group_completed')
    expect(events[0].severity).toBe('error')
    act(() => { renderer.unmount() })
  })
})
