import { beforeEach, describe, expect, test } from 'bun:test'
import { SessionRegistry } from '../SessionRegistry'
import type { AgentSession, Session } from '../../shared/types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 'default',
    tmuxWindow: 'agentboard:1',
    projectPath: '/tmp/project',
    status: 'working',
    lastActivity: '2025-01-01T00:00:00.000Z',
    createdAt: '2025-01-01T00:00:00.000Z',
    source: 'managed',
    ...overrides,
  }
}

function makeAgentSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId: 'agent-1',
    logFilePath: '/tmp/log.jsonl',
    projectPath: '/tmp/project',
    agentType: 'claude',
    displayName: 'Agent 1',
    createdAt: '2025-01-01T00:00:00.000Z',
    lastActivityAt: '2025-01-01T00:00:00.000Z',
    isActive: true,
    ...overrides,
  }
}

// ─── Constructor ──────────────────────────────────────────────────────────────

describe('SessionRegistry', () => {
  let registry: SessionRegistry

  beforeEach(() => {
    registry = new SessionRegistry()
  })

  describe('constructor', () => {
    test('starts with empty sessions', () => {
      expect(registry.getAll()).toEqual([])
    })

    test('get returns undefined for unknown session', () => {
      expect(registry.get('nonexistent')).toBeUndefined()
    })

    test('starts with empty agent sessions', () => {
      const { active, inactive } = registry.getAgentSessions()
      expect(active).toEqual([])
      expect(inactive).toEqual([])
    })
  })

  // ─── getAll / get ─────────────────────────────────────────────────────────

  describe('getAll', () => {
    test('returns all sessions as array', () => {
      const s1 = makeSession({ id: 's1' })
      const s2 = makeSession({ id: 's2' })
      registry.replaceSessions([s1, s2])

      const all = registry.getAll()
      expect(all).toHaveLength(2)
      const ids = all.map((s) => s.id).sort()
      expect(ids).toEqual(['s1', 's2'])
    })
  })

  describe('get', () => {
    test('returns session by ID', () => {
      const session = makeSession({ id: 's1', name: 'my-session' })
      registry.replaceSessions([session])

      const result = registry.get('s1')
      expect(result).toBeDefined()
      expect(result!.name).toBe('my-session')
    })

    test('returns undefined for unknown ID', () => {
      expect(registry.get('nope')).toBeUndefined()
    })
  })

  // ─── replaceSessions ────────────────────────────────────────────────────

  describe('replaceSessions', () => {
    test('sets sessions and emits sessions event', () => {
      const calls: Session[][] = []
      registry.on('sessions', (sessions: Session[]) => {
        calls.push(sessions)
      })

      const s1 = makeSession({ id: 's1' })
      registry.replaceSessions([s1])

      expect(calls).toHaveLength(1)
      expect(calls[0]).toHaveLength(1)
      expect(calls[0][0].id).toBe('s1')
    })

    test('emits session-removed for sessions no longer in the list', () => {
      const removedIds: string[] = []
      registry.on('session-removed', (id: string) => {
        removedIds.push(id)
      })

      registry.replaceSessions([makeSession({ id: 's1' }), makeSession({ id: 's2' })])
      expect(removedIds).toEqual([])

      // Replace with only s1 — s2 should be removed
      registry.replaceSessions([makeSession({ id: 's1' })])
      expect(removedIds).toEqual(['s2'])
    })

    test('does not emit sessions when nothing changed (equality check)', () => {
      const calls: Session[][] = []
      registry.on('sessions', (sessions: Session[]) => {
        calls.push(sessions)
      })

      const s1 = makeSession({ id: 's1' })
      registry.replaceSessions([s1])
      expect(calls).toHaveLength(1)

      // Replace with identical data — should NOT emit
      registry.replaceSessions([makeSession({ id: 's1' })])
      expect(calls).toHaveLength(1)
    })

    test('emits sessions when a field in sessionsEqual differs', () => {
      const calls: Session[][] = []
      registry.on('sessions', (sessions: Session[]) => {
        calls.push(sessions)
      })

      registry.replaceSessions([makeSession({ id: 's1', name: 'alpha' })])
      expect(calls).toHaveLength(1)

      // Change name — sessionsEqual should detect difference
      registry.replaceSessions([makeSession({ id: 's1', name: 'beta' })])
      expect(calls).toHaveLength(2)
    })

    // Test all fields compared by sessionsEqual — each test sets two
    // different values for a single field and verifies change detection.
    test('detects change in sessionsEqual field "name"', () => {
      const calls: Session[][] = []
      registry.on('sessions', (s) => calls.push(s))
      registry.replaceSessions([makeSession({ id: 's1', name: 'alpha' })])
      registry.replaceSessions([makeSession({ id: 's1', name: 'beta' })])
      expect(calls).toHaveLength(2)
    })

    test('detects change in sessionsEqual field "status"', () => {
      const calls: Session[][] = []
      registry.on('sessions', (s) => calls.push(s))
      registry.replaceSessions([makeSession({ id: 's1', status: 'working' })])
      registry.replaceSessions([makeSession({ id: 's1', status: 'waiting' })])
      expect(calls).toHaveLength(2)
    })

    test('detects change in sessionsEqual field "projectPath"', () => {
      const calls: Session[][] = []
      registry.on('sessions', (s) => calls.push(s))
      registry.replaceSessions([makeSession({ id: 's1', projectPath: '/a' })])
      registry.replaceSessions([makeSession({ id: 's1', projectPath: '/b' })])
      expect(calls).toHaveLength(2)
    })

    test('detects change in sessionsEqual field "agentType"', () => {
      const calls: Session[][] = []
      registry.on('sessions', (s) => calls.push(s))
      registry.replaceSessions([makeSession({ id: 's1', agentType: 'claude' })])
      registry.replaceSessions([makeSession({ id: 's1', agentType: 'codex' })])
      expect(calls).toHaveLength(2)
    })

    test('detects change in sessionsEqual field "command"', () => {
      const calls: Session[][] = []
      registry.on('sessions', (s) => calls.push(s))
      registry.replaceSessions([makeSession({ id: 's1', command: 'cmd-a' })])
      registry.replaceSessions([makeSession({ id: 's1', command: 'cmd-b' })])
      expect(calls).toHaveLength(2)
    })

    test('detects change in sessionsEqual field "agentSessionId"', () => {
      const calls: Session[][] = []
      registry.on('sessions', (s) => calls.push(s))
      registry.replaceSessions([makeSession({ id: 's1', agentSessionId: 'as-1' })])
      registry.replaceSessions([makeSession({ id: 's1', agentSessionId: 'as-2' })])
      expect(calls).toHaveLength(2)
    })

    test('detects change in sessionsEqual field "agentSessionName"', () => {
      const calls: Session[][] = []
      registry.on('sessions', (s) => calls.push(s))
      registry.replaceSessions([makeSession({ id: 's1', agentSessionName: 'asn-1' })])
      registry.replaceSessions([makeSession({ id: 's1', agentSessionName: 'asn-2' })])
      expect(calls).toHaveLength(2)
    })

    test('detects change in sessionsEqual field "lastUserMessage"', () => {
      const calls: Session[][] = []
      registry.on('sessions', (s) => calls.push(s))
      registry.replaceSessions([makeSession({ id: 's1', lastUserMessage: 'hello' })])
      registry.replaceSessions([makeSession({ id: 's1', lastUserMessage: 'world' })])
      expect(calls).toHaveLength(2)
    })

    test('detects change in sessionsEqual field "isPinned"', () => {
      const calls: Session[][] = []
      registry.on('sessions', (s) => calls.push(s))
      registry.replaceSessions([makeSession({ id: 's1', isPinned: false })])
      registry.replaceSessions([makeSession({ id: 's1', isPinned: true })])
      expect(calls).toHaveLength(2)
    })

    // ─── pickLatestActivity (tested via replaceSessions behavior) ────────

    describe('pickLatestActivity (via replaceSessions)', () => {
      test('preserves lastActivity from existing when it is newer', () => {
        registry.replaceSessions([
          makeSession({ id: 's1', lastActivity: '2025-06-01T00:00:00.000Z' }),
        ])

        // Incoming has older lastActivity — should keep existing's
        registry.replaceSessions([
          makeSession({ id: 's1', lastActivity: '2025-01-01T00:00:00.000Z' }),
        ])

        const session = registry.get('s1')!
        expect(session.lastActivity).toBe('2025-06-01T00:00:00.000Z')
      })

      test('uses incoming lastActivity when it is newer', () => {
        registry.replaceSessions([
          makeSession({ id: 's1', lastActivity: '2025-01-01T00:00:00.000Z' }),
        ])

        registry.replaceSessions([
          makeSession({ id: 's1', lastActivity: '2025-06-01T00:00:00.000Z' }),
        ])

        const session = registry.get('s1')!
        expect(session.lastActivity).toBe('2025-06-01T00:00:00.000Z')
      })

      test('uses incoming lastActivity when no existing session', () => {
        registry.replaceSessions([
          makeSession({ id: 's1', lastActivity: '2025-03-15T00:00:00.000Z' }),
        ])

        const session = registry.get('s1')!
        expect(session.lastActivity).toBe('2025-03-15T00:00:00.000Z')
      })

      test('uses incoming lastActivity when both are NaN', () => {
        registry.replaceSessions([
          makeSession({ id: 's1', lastActivity: 'not-a-date' }),
        ])

        // Existing has invalid date, incoming also has invalid date — picks incoming
        registry.replaceSessions([
          makeSession({ id: 's1', lastActivity: 'also-invalid' }),
        ])

        const session = registry.get('s1')!
        expect(session.lastActivity).toBe('also-invalid')
      })

      test('uses incoming lastActivity when existing is NaN', () => {
        registry.replaceSessions([
          makeSession({ id: 's1', lastActivity: 'not-a-date' }),
        ])

        registry.replaceSessions([
          makeSession({ id: 's1', lastActivity: '2025-06-01T00:00:00.000Z' }),
        ])

        const session = registry.get('s1')!
        expect(session.lastActivity).toBe('2025-06-01T00:00:00.000Z')
      })

      test('uses existing lastActivity when incoming is NaN', () => {
        registry.replaceSessions([
          makeSession({ id: 's1', lastActivity: '2025-06-01T00:00:00.000Z' }),
        ])

        registry.replaceSessions([
          makeSession({ id: 's1', lastActivity: 'not-a-date' }),
        ])

        const session = registry.get('s1')!
        expect(session.lastActivity).toBe('2025-06-01T00:00:00.000Z')
      })
    })

    // ─── createdAt preservation ─────────────────────────────────────────

    describe('createdAt preservation', () => {
      test('preserves createdAt from existing session', () => {
        registry.replaceSessions([
          makeSession({ id: 's1', createdAt: '2025-01-01T00:00:00.000Z' }),
        ])

        registry.replaceSessions([
          makeSession({ id: 's1', createdAt: '2025-06-01T00:00:00.000Z' }),
        ])

        // Existing createdAt should be preserved
        const session = registry.get('s1')!
        expect(session.createdAt).toBe('2025-01-01T00:00:00.000Z')
      })

      test('uses incoming createdAt when no existing session', () => {
        registry.replaceSessions([
          makeSession({ id: 's1', createdAt: '2025-03-15T00:00:00.000Z' }),
        ])

        const session = registry.get('s1')!
        expect(session.createdAt).toBe('2025-03-15T00:00:00.000Z')
      })

      test('falls back to current time when neither has createdAt', () => {
        const before = new Date().toISOString()
        registry.replaceSessions([
          makeSession({ id: 's1', createdAt: '' }),
        ])
        const after = new Date().toISOString()

        const session = registry.get('s1')!
        // Empty string is falsy, so falls back to new Date().toISOString()
        expect(session.createdAt >= before).toBe(true)
        expect(session.createdAt <= after).toBe(true)
      })
    })
  })

  // ─── updateSession ─────────────────────────────────────────────────────

  describe('updateSession', () => {
    test('merges updates and emits session-update event', () => {
      const updatedSessions: Session[] = []
      registry.on('session-update', (session: Session) => {
        updatedSessions.push(session)
      })

      registry.replaceSessions([makeSession({ id: 's1', name: 'alpha', status: 'working' })])

      const result = registry.updateSession('s1', { status: 'waiting' })

      expect(result).toBeDefined()
      expect(result!.name).toBe('alpha') // preserved
      expect(result!.status).toBe('waiting') // updated
      expect(updatedSessions).toHaveLength(1)
      expect(updatedSessions[0].status).toBe('waiting')
    })

    test('returns undefined for non-existent session', () => {
      const result = registry.updateSession('nonexistent', { status: 'waiting' })
      expect(result).toBeUndefined()
    })

    test('emits session-update with merged session', () => {
      const updatedSessions: Session[] = []
      registry.on('session-update', (session: Session) => {
        updatedSessions.push(session)
      })

      registry.replaceSessions([makeSession({ id: 's1' })])
      registry.updateSession('s1', { name: 'updated-name', isPinned: true })

      const emitted = updatedSessions[0]
      expect(emitted.name).toBe('updated-name')
      expect(emitted.isPinned).toBe(true)
      expect(emitted.id).toBe('s1')
    })
  })

  // ─── Agent Sessions ───────────────────────────────────────────────────

  describe('getAgentSessions', () => {
    test('returns current agent sessions', () => {
      const active = [makeAgentSession({ sessionId: 'a1', isActive: true })]
      const inactive = [makeAgentSession({ sessionId: 'i1', isActive: false })]
      registry.setAgentSessions(active, inactive)

      const result = registry.getAgentSessions()
      expect(result.active).toHaveLength(1)
      expect(result.inactive).toHaveLength(1)
      expect(result.active[0].sessionId).toBe('a1')
      expect(result.inactive[0].sessionId).toBe('i1')
    })
  })

  describe('setAgentSessions', () => {
    test('emits agent-sessions event on first set', () => {
      const emitted: Array<{ active: AgentSession[]; inactive: AgentSession[] }> = []
      registry.on('agent-sessions', (payload) => {
        emitted.push(payload)
      })

      const active = [makeAgentSession({ sessionId: 'a1' })]
      registry.setAgentSessions(active, [])

      expect(emitted).toHaveLength(1)
      expect(emitted[0].active).toHaveLength(1)
      expect(emitted[0].inactive).toHaveLength(0)
    })

    test('does not emit agent-sessions when snapshot is identical', () => {
      const emitted: Array<{ active: AgentSession[]; inactive: AgentSession[] }> = []
      registry.on('agent-sessions', (payload) => {
        emitted.push(payload)
      })

      const active = [makeAgentSession({ sessionId: 'a1' })]
      const inactive = [makeAgentSession({ sessionId: 'i1', isActive: false })]

      registry.setAgentSessions(active, inactive)
      expect(emitted).toHaveLength(1)

      // Set again with same data (different object identity, same JSON)
      const active2 = [makeAgentSession({ sessionId: 'a1' })]
      const inactive2 = [makeAgentSession({ sessionId: 'i1', isActive: false })]
      registry.setAgentSessions(active2, inactive2)
      expect(emitted).toHaveLength(1) // Still 1
    })

    test('emits agent-sessions when active list changes', () => {
      const emitted: Array<{ active: AgentSession[]; inactive: AgentSession[] }> = []
      registry.on('agent-sessions', (payload) => {
        emitted.push(payload)
      })

      registry.setAgentSessions([makeAgentSession({ sessionId: 'a1' })], [])
      expect(emitted).toHaveLength(1)

      registry.setAgentSessions(
        [makeAgentSession({ sessionId: 'a1' }), makeAgentSession({ sessionId: 'a2' })],
        []
      )
      expect(emitted).toHaveLength(2)
    })

    test('emits agent-sessions when inactive list changes', () => {
      const emitted: Array<{ active: AgentSession[]; inactive: AgentSession[] }> = []
      registry.on('agent-sessions', (payload) => {
        emitted.push(payload)
      })

      registry.setAgentSessions([], [])
      expect(emitted).toHaveLength(1)

      registry.setAgentSessions([], [makeAgentSession({ sessionId: 'i1', isActive: false })])
      expect(emitted).toHaveLength(2)
    })

    test('deduplicates via JSON snapshot (not object identity)', () => {
      const emitted: Array<{ active: AgentSession[]; inactive: AgentSession[] }> = []
      registry.on('agent-sessions', (payload) => {
        emitted.push(payload)
      })

      const a = makeAgentSession({ sessionId: 'a1', displayName: 'Agent' })
      registry.setAgentSessions([a], [])
      expect(emitted).toHaveLength(1)

      // Different object with same content — should NOT emit
      const b = makeAgentSession({ sessionId: 'a1', displayName: 'Agent' })
      registry.setAgentSessions([b], [])
      expect(emitted).toHaveLength(1)
    })

    test('stores agent sessions in { active, inactive } structure', () => {
      const active = [makeAgentSession({ sessionId: 'a1', isActive: true })]
      const inactive = [
        makeAgentSession({ sessionId: 'i1', isActive: false }),
        makeAgentSession({ sessionId: 'i2', isActive: false }),
      ]

      registry.setAgentSessions(active, inactive)

      const stored = registry.getAgentSessions()
      expect(stored.active).toHaveLength(1)
      expect(stored.inactive).toHaveLength(2)
    })
  })
})
