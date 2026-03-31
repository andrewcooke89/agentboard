import { beforeEach, describe, expect, test } from 'bun:test'

// localStorage mock (must precede store import for consistent behavior)
import { storage } from './localStorageMock'

import type { AgentSession, Session } from '@shared/types'
import { useSessionStore } from '../sessionStore'
import { useSettingsStore } from '../settingsStore'

// ─── Mock Session Factory ──────────────────────────────────────────────────

function mockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'test-session',
    tmuxWindow: 'agentboard:1',
    projectPath: '/tmp/test',
    status: 'working',
    lastActivity: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    source: 'managed',
    ...overrides,
  }
}

function mockAgentSession(
  overrides: Partial<AgentSession> = {}
): AgentSession {
  return {
    sessionId: 'agent-sess-1',
    logFilePath: '/tmp/agent-log.txt',
    projectPath: '/tmp/test',
    agentType: 'claude',
    displayName: 'Agent 1',
    createdAt: '2026-01-01T00:00:00Z',
    lastActivityAt: '2026-01-01T00:00:00Z',
    isActive: true,
    ...overrides,
  }
}

beforeEach(() => {
  storage.clear()
  useSessionStore.setState({
    sessions: [],
    agentSessions: { active: [], inactive: [] },
    exitingSessions: new Map(),
    selectedSessionId: null,
    hasLoaded: false,
    connectionStatus: 'connecting',
    connectionError: null,
  })
})

// ─── 1. Default State Tests ────────────────────────────────────────────────

describe('sessionStore default state', () => {
  test('sessions defaults to empty array', () => {
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  test('agentSessions defaults to { active: [], inactive: [] }', () => {
    expect(useSessionStore.getState().agentSessions).toEqual({
      active: [],
      inactive: [],
    })
  })

  test('exitingSessions defaults to empty Map', () => {
    const map = useSessionStore.getState().exitingSessions
    expect(map).toBeInstanceOf(Map)
    expect(map.size).toBe(0)
  })

  test('selectedSessionId defaults to null', () => {
    expect(useSessionStore.getState().selectedSessionId).toBeNull()
  })

  test('hasLoaded defaults to false', () => {
    expect(useSessionStore.getState().hasLoaded).toBe(false)
  })

  test('connectionStatus defaults to connecting', () => {
    expect(useSessionStore.getState().connectionStatus).toBe('connecting')
  })

  test('connectionError defaults to null', () => {
    expect(useSessionStore.getState().connectionError).toBeNull()
  })
})

// ─── 2. setSessions Tests ──────────────────────────────────────────────────

describe('sessionStore setSessions', () => {
  test('setSessions updates sessions array and sets hasLoaded to true', () => {
    const sessions = [
      mockSession({ id: 's1' }),
      mockSession({ id: 's2', name: 'second' }),
    ]
    useSessionStore.getState().setSessions(sessions)

    const state = useSessionStore.getState()
    expect(state.sessions).toEqual(sessions)
    expect(state.hasLoaded).toBe(true)
  })

  test('setSessions with empty array clears sessions', () => {
    useSessionStore.setState({
      sessions: [mockSession()],
      hasLoaded: true,
    })

    useSessionStore.getState().setSessions([])
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(useSessionStore.getState().hasLoaded).toBe(true)
  })

  test('setSessions preserves selectedSessionId when selected session still exists', () => {
    useSessionStore.setState({ selectedSessionId: 's1' })

    const sessions = [
      mockSession({ id: 's1' }),
      mockSession({ id: 's2' }),
    ]
    useSessionStore.getState().setSessions(sessions)

    expect(useSessionStore.getState().selectedSessionId).toBe('s1')
  })

  test('setSessions resets selectedSessionId to first sorted session when selected session is removed', () => {
    // Set up two sessions with one selected
    useSessionStore.setState({
      sessions: [mockSession({ id: 's1' }), mockSession({ id: 's2' })],
      selectedSessionId: 's1',
    })

    // Update with only s2 remaining — s1 is removed
    useSessionStore.getState().setSessions([mockSession({ id: 's2' })])

    // Default sort is created desc, so s2 should be the only option
    expect(useSessionStore.getState().selectedSessionId).toBe('s2')
  })

  test('setSessions sets selectedSessionId to null when all sessions removed and one was selected', () => {
    useSessionStore.setState({
      sessions: [mockSession({ id: 's1' })],
      selectedSessionId: 's1',
    })

    useSessionStore.getState().setSessions([])
    expect(useSessionStore.getState().selectedSessionId).toBeNull()
  })
})

// ─── 3. Exit Animation Tests ───────────────────────────────────────────────

describe('sessionStore exit animation', () => {
  test('setSessions marks removed sessions as exiting', () => {
    const s1 = mockSession({ id: 's1' })
    const s2 = mockSession({ id: 's2' })

    // Start with two sessions
    useSessionStore.setState({ sessions: [s1, s2] })

    // Remove s1 by only providing s2
    useSessionStore.getState().setSessions([s2])

    const exiting = useSessionStore.getState().exitingSessions
    expect(exiting.has('s1')).toBe(true)
    expect(exiting.get('s1')).toEqual(s1)
    expect(exiting.has('s2')).toBe(false)
  })

  test('setSessions does not duplicate already-exiting sessions', () => {
    const s1 = mockSession({ id: 's1' })
    const s2 = mockSession({ id: 's2' })

    // Put s1 in exitingSessions already
    const existingMap = new Map<string, Session>()
    existingMap.set('s1', s1)

    useSessionStore.setState({
      sessions: [s2],
      exitingSessions: existingMap,
    })

    // Remove s2 — but s1 is already exiting, should not be added again
    useSessionStore.getState().setSessions([])

    const exiting = useSessionStore.getState().exitingSessions
    expect(exiting.has('s2')).toBe(true)
    // s1 was already in exitingSessions and should still be there
    expect(exiting.has('s1')).toBe(true)
    expect(exiting.size).toBe(2)
  })

  test('markSessionExiting adds a session to exitingSessions Map', () => {
    const s1 = mockSession({ id: 's1' })
    useSessionStore.setState({ sessions: [s1] })

    useSessionStore.getState().markSessionExiting('s1')

    const exiting = useSessionStore.getState().exitingSessions
    expect(exiting.has('s1')).toBe(true)
    expect(exiting.get('s1')).toEqual(s1)
  })

  test('markSessionExiting does nothing if session does not exist in sessions array', () => {
    useSessionStore.setState({ sessions: [mockSession({ id: 's1' })] })

    useSessionStore.getState().markSessionExiting('nonexistent')

    expect(useSessionStore.getState().exitingSessions.size).toBe(0)
  })

  test('clearExitingSession removes a session from exitingSessions Map', () => {
    const s1 = mockSession({ id: 's1' })
    const map = new Map<string, Session>()
    map.set('s1', s1)

    useSessionStore.setState({ exitingSessions: map })
    expect(useSessionStore.getState().exitingSessions.has('s1')).toBe(true)

    useSessionStore.getState().clearExitingSession('s1')
    expect(useSessionStore.getState().exitingSessions.has('s1')).toBe(false)
    expect(useSessionStore.getState().exitingSessions.size).toBe(0)
  })
})

// ─── 4. setAgentSessions Tests ─────────────────────────────────────────────

describe('sessionStore setAgentSessions', () => {
  test('setAgentSessions updates active and inactive arrays', () => {
    const active = [
      mockAgentSession({ sessionId: 'a1', isActive: true }),
    ]
    const inactive = [
      mockAgentSession({ sessionId: 'a2', isActive: false }),
    ]

    useSessionStore.getState().setAgentSessions(active, inactive)

    const state = useSessionStore.getState()
    expect(state.agentSessions.active).toEqual(active)
    expect(state.agentSessions.inactive).toEqual(inactive)
  })
})

// ─── 5. updateSession Tests ────────────────────────────────────────────────

describe('sessionStore updateSession', () => {
  test('updateSession replaces matching session by id', () => {
    const s1 = mockSession({ id: 's1', name: 'original' })
    const s2 = mockSession({ id: 's2', name: 'other' })
    useSessionStore.setState({ sessions: [s1, s2] })

    const updated = mockSession({ id: 's1', name: 'updated', status: 'waiting' })
    useSessionStore.getState().updateSession(updated)

    const sessions = useSessionStore.getState().sessions
    expect(sessions).toHaveLength(2)
    expect(sessions.find((s) => s.id === 's1')).toEqual(updated)
  })

  test('updateSession leaves other sessions unchanged', () => {
    const s1 = mockSession({ id: 's1', name: 'original' })
    const s2 = mockSession({ id: 's2', name: 'other' })
    useSessionStore.setState({ sessions: [s1, s2] })

    const updated = mockSession({ id: 's1', name: 'updated' })
    useSessionStore.getState().updateSession(updated)

    const sessions = useSessionStore.getState().sessions
    expect(sessions.find((s) => s.id === 's2')).toEqual(s2)
  })

  test('updateSession does nothing when session id not found', () => {
    const s1 = mockSession({ id: 's1' })
    const s2 = mockSession({ id: 's2' })
    useSessionStore.setState({ sessions: [s1, s2] })

    const unknown = mockSession({ id: 'unknown', name: 'nope' })
    useSessionStore.getState().updateSession(unknown)

    const sessions = useSessionStore.getState().sessions
    expect(sessions).toEqual([s1, s2])
  })
})

// ─── 6. Simple Setter Tests ────────────────────────────────────────────────

describe('sessionStore simple setters', () => {
  test('setSelectedSessionId updates selectedSessionId', () => {
    useSessionStore.getState().setSelectedSessionId('sess-42')
    expect(useSessionStore.getState().selectedSessionId).toBe('sess-42')
  })

  test('setSelectedSessionId can set to null', () => {
    useSessionStore.setState({ selectedSessionId: 'sess-42' })
    useSessionStore.getState().setSelectedSessionId(null)
    expect(useSessionStore.getState().selectedSessionId).toBeNull()
  })

  test('setConnectionStatus updates connectionStatus', () => {
    useSessionStore.getState().setConnectionStatus('connected')
    expect(useSessionStore.getState().connectionStatus).toBe('connected')
  })

  test('setConnectionStatus accepts all status values', () => {
    const statuses = [
      'connecting',
      'connected',
      'reconnecting',
      'disconnected',
      'error',
    ] as const
    for (const status of statuses) {
      useSessionStore.getState().setConnectionStatus(status)
      expect(useSessionStore.getState().connectionStatus).toBe(status)
    }
  })

  test('setConnectionError updates connectionError', () => {
    useSessionStore.getState().setConnectionError('Network timeout')
    expect(useSessionStore.getState().connectionError).toBe('Network timeout')
  })

  test('setConnectionError can clear error to null', () => {
    useSessionStore.setState({ connectionError: 'some error' })
    useSessionStore.getState().setConnectionError(null)
    expect(useSessionStore.getState().connectionError).toBeNull()
  })
})

// ─── 7. Persistence Tests ──────────────────────────────────────────────────

describe('sessionStore persistence', () => {
  test('Only selectedSessionId is persisted', () => {
    // Set all state fields
    useSessionStore.setState({
      sessions: [mockSession({ id: 's1' })],
      agentSessions: {
        active: [mockAgentSession()],
        inactive: [],
      },
      selectedSessionId: 's1',
      hasLoaded: true,
      connectionStatus: 'connected',
      connectionError: 'err',
    })

    // Read persisted storage — should only contain selectedSessionId
    const raw = storage.getItem('agentboard-session')
    expect(raw).not.toBeNull()

    const parsed = JSON.parse(raw!)
    // Zustand persist wraps state in an object with a "state" key and "version"
    const persistedState = parsed.state

    expect(persistedState.selectedSessionId).toBe('s1')
    expect(persistedState.sessions).toBeUndefined()
    expect(persistedState.agentSessions).toBeUndefined()
    expect(persistedState.exitingSessions).toBeUndefined()
    expect(persistedState.hasLoaded).toBeUndefined()
    expect(persistedState.connectionStatus).toBeUndefined()
    expect(persistedState.connectionError).toBeUndefined()
  })

  test('Storage key is agentboard-session', () => {
    useSessionStore.getState().setSelectedSessionId('test-key')

    const raw = storage.getItem('agentboard-session')
    expect(raw).not.toBeNull()

    const parsed = JSON.parse(raw!)
    expect(parsed.state.selectedSessionId).toBe('test-key')
  })
})
