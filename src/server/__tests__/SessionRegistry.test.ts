import { describe, it, expect } from 'bun:test'
import { SessionRegistry } from '../SessionRegistry'
import type { AgentSession, Session } from '../../shared/types'

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'test-1',
    name: 'test',
    tmuxWindow: 'win-1',
    projectPath: '/tmp/test',
    status: 'unknown',
    lastActivity: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    source: 'managed',
    ...overrides,
  }
}

function makeAgentSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sessionId: 'agent-1',
    logFilePath: '/tmp/log.txt',
    projectPath: '/tmp/test',
    agentType: 'claude',
    displayName: 'Agent 1',
    createdAt: '2026-01-01T00:00:00Z',
    lastActivityAt: '2026-01-01T00:00:00Z',
    isActive: true,
    ...overrides,
  }
}

describe('SessionRegistry', () => {
  describe('constructor', () => {
    it('getAll() returns empty array initially', () => {
      const reg = new SessionRegistry()
      expect(reg.getAll()).toEqual([])
    })

    it('getAgentSessions() returns { active: [], inactive: [] } initially', () => {
      const reg = new SessionRegistry()
      expect(reg.getAgentSessions()).toStrictEqual({ active: [], inactive: [] })
    })
  })

  describe('get / getAll', () => {
    it('get() returns undefined for unknown id', () => {
      const reg = new SessionRegistry()
      expect(reg.get('nonexistent')).toBeUndefined()
    })

    it('after replaceSessions(), get() returns the session by id', () => {
      const reg = new SessionRegistry()
      const session = makeSession()
      reg.replaceSessions([session])
      expect(reg.get('test-1')).toStrictEqual(session)
    })

    it('getAll() returns all sessions added via replaceSessions()', () => {
      const reg = new SessionRegistry()
      const s1 = makeSession({ id: 'a' })
      const s2 = makeSession({ id: 'b' })
      reg.replaceSessions([s1, s2])
      const all = reg.getAll()
      expect(all).toHaveLength(2)
      expect(all.find((s) => s.id === 'a')).toBeDefined()
      expect(all.find((s) => s.id === 'b')).toBeDefined()
    })
  })

  describe('replaceSessions', () => {
    it('emits "sessions" event when sessions change', () => {
      const reg = new SessionRegistry()
      let emitted = false
      reg.on('sessions', () => {
        emitted = true
      })
      reg.replaceSessions([makeSession()])
      expect(emitted).toBe(true)
    })

    it('emits "session-removed" for sessions no longer present', () => {
      const reg = new SessionRegistry()
      reg.replaceSessions([makeSession({ id: 'a' }), makeSession({ id: 'b' })])

      const removed: string[] = []
      reg.on('session-removed', (id: string) => {
        removed.push(id)
      })
      reg.replaceSessions([makeSession({ id: 'a' })])
      expect(removed).toEqual(['b'])
    })

    it('does NOT emit "sessions" when called with identical data', () => {
      const reg = new SessionRegistry()
      const session = makeSession()
      reg.replaceSessions([session])

      let count = 0
      reg.on('sessions', () => {
        count++
      })
      reg.replaceSessions([session])
      expect(count).toBe(0)
    })

    it('preserves createdAt from existing session when replacing', () => {
      const reg = new SessionRegistry()
      reg.replaceSessions([makeSession({ createdAt: '2026-01-01T00:00:00Z' })])

      const emitted: Session[][] = []
      reg.on('sessions', (sessions: Session[]) => {
        emitted.push(sessions)
      })
      // Replace with a session that has a different createdAt — should be preserved
      reg.replaceSessions([makeSession({ createdAt: '2026-06-01T00:00:00Z' })])
      expect(reg.get('test-1')!.createdAt).toBe('2026-01-01T00:00:00Z')
    })

    it('falls back to incoming createdAt if no existing session', () => {
      const reg = new SessionRegistry()
      reg.replaceSessions([makeSession({ createdAt: '2026-03-15T00:00:00Z' })])
      expect(reg.get('test-1')!.createdAt).toBe('2026-03-15T00:00:00Z')
    })

    it('falls back to new Date().toISOString() when no existing and no incoming createdAt', () => {
      const reg = new SessionRegistry()
      const session = makeSession({ createdAt: '' as string })
      // Since existing is undefined and incoming createdAt is falsy, it falls back to new Date().toISOString()
      // But empty string is falsy, so it will use new Date().toISOString()
      reg.replaceSessions([session])
      const created = reg.get('test-1')!.createdAt
      // Should be a valid ISO string from current time
      expect(Date.parse(created)).not.toBeNaN()
    })

    it('uses pickLatestActivity: keeps the later of existing vs incoming lastActivity', () => {
      const reg = new SessionRegistry()
      reg.replaceSessions([makeSession({ lastActivity: '2026-01-01T00:00:00Z' })])
      reg.replaceSessions([makeSession({ lastActivity: '2026-06-01T00:00:00Z' })])
      expect(reg.get('test-1')!.lastActivity).toBe('2026-06-01T00:00:00Z')
    })

    it('uses pickLatestActivity: keeps existing when it is later than incoming', () => {
      const reg = new SessionRegistry()
      reg.replaceSessions([makeSession({ lastActivity: '2026-06-01T00:00:00Z' })])
      reg.replaceSessions([makeSession({ lastActivity: '2026-01-01T00:00:00Z' })])
      expect(reg.get('test-1')!.lastActivity).toBe('2026-06-01T00:00:00Z')
    })

    it('pickLatestActivity: if existing is undefined, returns incoming', () => {
      const reg = new SessionRegistry()
      const session = makeSession({ lastActivity: '2026-02-01T00:00:00Z' })
      reg.replaceSessions([session])
      expect(reg.get('test-1')!.lastActivity).toBe('2026-02-01T00:00:00Z')
    })

    it('pickLatestActivity: if both are NaN dates, returns incoming', () => {
      const reg = new SessionRegistry()
      reg.replaceSessions([makeSession({ lastActivity: 'not-a-date' })])
      reg.replaceSessions([makeSession({ lastActivity: 'also-not-a-date' })])
      expect(reg.get('test-1')!.lastActivity).toBe('also-not-a-date')
    })

    it('pickLatestActivity: if only existing is NaN, returns incoming', () => {
      const reg = new SessionRegistry()
      reg.replaceSessions([makeSession({ lastActivity: 'not-a-date' })])
      reg.replaceSessions([makeSession({ lastActivity: '2026-01-01T00:00:00Z' })])
      expect(reg.get('test-1')!.lastActivity).toBe('2026-01-01T00:00:00Z')
    })

    it('pickLatestActivity: if only incoming is NaN, returns existing', () => {
      const reg = new SessionRegistry()
      reg.replaceSessions([makeSession({ lastActivity: '2026-01-01T00:00:00Z' })])
      reg.replaceSessions([makeSession({ lastActivity: 'not-a-date' })])
      expect(reg.get('test-1')!.lastActivity).toBe('2026-01-01T00:00:00Z')
    })
  })

  describe('sessionsEqual (tested indirectly via replaceSessions)', () => {
    const fieldsToTest: Partial<Record<keyof Session, unknown>> = {
      id: 'changed-id',
      name: 'changed-name',
      status: 'working',
      lastActivity: '2026-12-31T00:00:00Z',
      projectPath: '/changed',
      agentType: 'codex',
      command: 'echo hello',
      agentSessionId: 'changed-agent-session',
      agentSessionName: 'changed-agent-name',
      lastUserMessage: 'changed message',
      isPinned: true,
    }

    for (const [field, value] of Object.entries(fieldsToTest)) {
      it(`changing "${field}" triggers a "sessions" event`, () => {
        const reg = new SessionRegistry()
        const session = makeSession()
        reg.replaceSessions([session])

        let count = 0
        reg.on('sessions', () => {
          count++
        })
        reg.replaceSessions([makeSession({ [field]: value })])
        expect(count).toBe(1)
      })
    }
  })

  describe('updateSession', () => {
    it('returns undefined if session does not exist', () => {
      const reg = new SessionRegistry()
      expect(reg.updateSession('nonexistent', { status: 'working' })).toBeUndefined()
    })

    it('merges updates into existing session', () => {
      const reg = new SessionRegistry()
      reg.replaceSessions([makeSession()])
      const result = reg.updateSession('test-1', { status: 'working', name: 'updated' })
      expect(result).toBeDefined()
      expect(result!.status).toBe('working')
      expect(result!.name).toBe('updated')
      // Other fields remain unchanged
      expect(result!.projectPath).toBe('/tmp/test')
    })

    it('emits "session-update" with the updated session', () => {
      const reg = new SessionRegistry()
      reg.replaceSessions([makeSession()])

      let emittedSession: Session | undefined
      reg.on('session-update', (session: Session) => {
        emittedSession = session
      })
      reg.updateSession('test-1', { status: 'waiting' })
      expect(emittedSession).toBeDefined()
      expect(emittedSession!.status).toBe('waiting')
      expect(emittedSession!.id).toBe('test-1')
    })

    it('returns the updated session', () => {
      const reg = new SessionRegistry()
      reg.replaceSessions([makeSession()])
      const result = reg.updateSession('test-1', { status: 'permission' })
      expect(result).toStrictEqual(reg.get('test-1'))
    })
  })

  describe('setAgentSessions', () => {
    it('emits "agent-sessions" when data changes', () => {
      const reg = new SessionRegistry()
      const active = [makeAgentSession({ sessionId: 'a1' })]
      const inactive = [makeAgentSession({ sessionId: 'i1', isActive: false })]

      let emitted = false
      reg.on('agent-sessions', () => {
        emitted = true
      })
      reg.setAgentSessions(active, inactive)
      expect(emitted).toBe(true)
    })

    it('does NOT emit when called with identical data', () => {
      const reg = new SessionRegistry()
      const active = [makeAgentSession({ sessionId: 'a1' })]
      const inactive = [makeAgentSession({ sessionId: 'i1', isActive: false })]
      reg.setAgentSessions(active, inactive)

      let count = 0
      reg.on('agent-sessions', () => {
        count++
      })
      reg.setAgentSessions(active, inactive)
      expect(count).toBe(0)
    })

    it('getAgentSessions() returns the latest data after set', () => {
      const reg = new SessionRegistry()
      const active = [makeAgentSession({ sessionId: 'a1' })]
      const inactive = [makeAgentSession({ sessionId: 'i1', isActive: false })]
      reg.setAgentSessions(active, inactive)

      const result = reg.getAgentSessions()
      expect(result.active).toStrictEqual(active)
      expect(result.inactive).toStrictEqual(inactive)
    })
  })
})
