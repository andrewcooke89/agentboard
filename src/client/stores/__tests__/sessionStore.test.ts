import { beforeEach, describe, expect, test } from 'bun:test'
import { storage } from './localStorageMock'
import { useSessionStore } from '../sessionStore'
import type { AgentSession, Session } from '@shared/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'test',
    tmuxWindow: 'win-1',
    projectPath: '/tmp',
    status: 'unknown',
    lastActivity: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    source: 'managed',
    ...overrides,
  }
}

function makeAgentSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId: 'agent-1',
    logFilePath: '/tmp/log.txt',
    projectPath: '/tmp',
    agentType: 'claude',
    displayName: 'Agent 1',
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
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

// ─── Initial State ────────────────────────────────────────────────────────────

describe('Initial state defaults', () => {
  test('sessions is empty array', () => {
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  test('agentSessions is { active: [], inactive: [] }', () => {
    expect(useSessionStore.getState().agentSessions).toEqual({
      active: [],
      inactive: [],
    })
  })

  test('exitingSessions is empty Map', () => {
    expect(useSessionStore.getState().exitingSessions.size).toBe(0)
  })

  test('selectedSessionId is null', () => {
    expect(useSessionStore.getState().selectedSessionId).toBeNull()
  })

  test('hasLoaded is false', () => {
    expect(useSessionStore.getState().hasLoaded).toBe(false)
  })

  test('connectionStatus is connecting', () => {
    expect(useSessionStore.getState().connectionStatus).toBe('connecting')
  })

  test('connectionError is null', () => {
    expect(useSessionStore.getState().connectionError).toBeNull()
  })
})

// ─── setSessions ──────────────────────────────────────────────────────────────

describe('setSessions', () => {
  test('sets sessions and marks hasLoaded true', () => {
    const sessions = [makeSession()]
    useSessionStore.getState().setSessions(sessions)

    const state = useSessionStore.getState()
    expect(state.sessions).toEqual(sessions)
    expect(state.hasLoaded).toBe(true)
  })

  test('preserves selectedSessionId when it still exists in new sessions', () => {
    const s1 = makeSession({ id: 'sess-1' })
    const s2 = makeSession({ id: 'sess-2' })
    useSessionStore.getState().setSessions([s1, s2])
    useSessionStore.getState().setSelectedSessionId('sess-1')

    const updated = makeSession({ id: 'sess-1', name: 'updated' })
    useSessionStore.getState().setSessions([updated, s2])

    expect(useSessionStore.getState().selectedSessionId).toBe('sess-1')
  })

  test('clears selectedSessionId (auto-selects first) when selected session is removed', () => {
    const s1 = makeSession({ id: 'sess-1' })
    const s2 = makeSession({ id: 'sess-2' })
    useSessionStore.getState().setSessions([s1, s2])
    useSessionStore.getState().setSelectedSessionId('sess-1')

    // Remove sess-1, keep sess-2
    useSessionStore.getState().setSessions([s2])

    expect(useSessionStore.getState().selectedSessionId).toBe('sess-2')
  })

  test('detects removed sessions and adds them to exitingSessions', () => {
    const s1 = makeSession({ id: 'sess-1' })
    const s2 = makeSession({ id: 'sess-2' })
    useSessionStore.getState().setSessions([s1, s2])

    // Remove sess-1
    useSessionStore.getState().setSessions([s2])

    const exiting = useSessionStore.getState().exitingSessions
    expect(exiting.size).toBe(1)
    expect(exiting.get('sess-1')).toEqual(s1)
  })

  test('does not duplicate sessions already in exitingSessions', () => {
    const s1 = makeSession({ id: 'sess-1' })
    const s2 = makeSession({ id: 'sess-2' })
    const s3 = makeSession({ id: 'sess-3' })
    useSessionStore.getState().setSessions([s1, s2, s3])

    // Remove sess-1
    useSessionStore.getState().setSessions([s2, s3])
    expect(useSessionStore.getState().exitingSessions.size).toBe(1)

    // Remove sess-2 as well — sess-1 should not be duplicated
    useSessionStore.getState().setSessions([s3])
    const exiting = useSessionStore.getState().exitingSessions
    expect(exiting.size).toBe(2)
    expect(exiting.has('sess-1')).toBe(true)
    expect(exiting.has('sess-2')).toBe(true)
  })
})

// ─── setAgentSessions ─────────────────────────────────────────────────────────

describe('setAgentSessions', () => {
  test('sets active and inactive arrays', () => {
    const active = [makeAgentSession({ sessionId: 'a-1', isActive: true })]
    const inactive = [makeAgentSession({ sessionId: 'a-2', isActive: false })]

    useSessionStore.getState().setAgentSessions(active, inactive)

    const { agentSessions } = useSessionStore.getState()
    expect(agentSessions.active).toEqual(active)
    expect(agentSessions.inactive).toEqual(inactive)
  })
})

// ─── updateSession ────────────────────────────────────────────────────────────

describe('updateSession', () => {
  test('updates matching session by id, leaves others unchanged', () => {
    const s1 = makeSession({ id: 'sess-1', name: 'original' })
    const s2 = makeSession({ id: 'sess-2', name: 'other' })
    useSessionStore.getState().setSessions([s1, s2])

    const updated = makeSession({ id: 'sess-1', name: 'updated' })
    useSessionStore.getState().updateSession(updated)

    const { sessions } = useSessionStore.getState()
    expect(sessions).toHaveLength(2)
    expect(sessions.find((s) => s.id === 'sess-1')?.name).toBe('updated')
    expect(sessions.find((s) => s.id === 'sess-2')?.name).toBe('other')
  })

  test('does not crash if session id not found (returns unchanged array)', () => {
    const s1 = makeSession({ id: 'sess-1' })
    useSessionStore.getState().setSessions([s1])

    const ghost = makeSession({ id: 'ghost' })
    useSessionStore.getState().updateSession(ghost)

    const { sessions } = useSessionStore.getState()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].id).toBe('sess-1')
  })
})

// ─── setSelectedSessionId ────────────────────────────────────────────────────

describe('setSelectedSessionId', () => {
  test('sets to a string value', () => {
    useSessionStore.getState().setSelectedSessionId('sess-42')
    expect(useSessionStore.getState().selectedSessionId).toBe('sess-42')
  })

  test('sets to null', () => {
    useSessionStore.getState().setSelectedSessionId('sess-42')
    useSessionStore.getState().setSelectedSessionId(null)
    expect(useSessionStore.getState().selectedSessionId).toBeNull()
  })
})

// ─── setConnectionStatus ─────────────────────────────────────────────────────

describe('setConnectionStatus', () => {
  test.each([
    ['connecting'],
    ['connected'],
    ['reconnecting'],
    ['disconnected'],
    ['error'],
  ] as const)('sets status to %s', (status) => {
    useSessionStore.getState().setConnectionStatus(status)
    expect(useSessionStore.getState().connectionStatus).toBe(status)
  })
})

// ─── setConnectionError ──────────────────────────────────────────────────────

describe('setConnectionError', () => {
  test('sets to a string error message', () => {
    useSessionStore.getState().setConnectionError('Connection refused')
    expect(useSessionStore.getState().connectionError).toBe('Connection refused')
  })

  test('sets to null', () => {
    useSessionStore.getState().setConnectionError('some error')
    useSessionStore.getState().setConnectionError(null)
    expect(useSessionStore.getState().connectionError).toBeNull()
  })
})

// ─── markSessionExiting ──────────────────────────────────────────────────────

describe('markSessionExiting', () => {
  test('adds a session from sessions list to exitingSessions map', () => {
    const s1 = makeSession({ id: 'sess-1' })
    useSessionStore.getState().setSessions([s1])

    useSessionStore.getState().markSessionExiting('sess-1')

    const exiting = useSessionStore.getState().exitingSessions
    expect(exiting.size).toBe(1)
    expect(exiting.get('sess-1')).toEqual(s1)
  })

  test('does nothing if sessionId not found in sessions', () => {
    const s1 = makeSession({ id: 'sess-1' })
    useSessionStore.getState().setSessions([s1])

    useSessionStore.getState().markSessionExiting('non-existent')

    expect(useSessionStore.getState().exitingSessions.size).toBe(0)
  })
})

// ─── clearExitingSession ─────────────────────────────────────────────────────

describe('clearExitingSession', () => {
  test('removes a session from exitingSessions', () => {
    const s1 = makeSession({ id: 'sess-1' })
    useSessionStore.getState().setSessions([s1])
    useSessionStore.getState().markSessionExiting('sess-1')
    expect(useSessionStore.getState().exitingSessions.size).toBe(1)

    useSessionStore.getState().clearExitingSession('sess-1')

    expect(useSessionStore.getState().exitingSessions.size).toBe(0)
  })

  test('does nothing if sessionId not in exitingSessions', () => {
    const s1 = makeSession({ id: 'sess-1' })
    useSessionStore.getState().setSessions([s1])
    useSessionStore.getState().markSessionExiting('sess-1')

    useSessionStore.getState().clearExitingSession('non-existent')

    expect(useSessionStore.getState().exitingSessions.size).toBe(1)
  })
})
