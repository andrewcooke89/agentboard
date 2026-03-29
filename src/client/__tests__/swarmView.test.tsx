import { describe, expect, test } from 'bun:test'
import { convertToLogEntry } from '../components/swarm/SwarmView'
import type { SwarmEvent, GroupStartedEvent, WoStatusChangedEvent, WoCompletedEvent, WoFailedEvent, WoEscalatedEvent, GroupCompletedEvent } from '../../shared/swarmTypes'

describe('convertToLogEntry', () => {
  test('group_started', () => {
    const event: GroupStartedEvent = {
      type: 'group_started',
      groupId: 'grp-1',
      timestamp: 1000,
      totalWos: 5,
    }
    const entry = convertToLogEntry(event)
    expect(entry.type).toBe('group_started')
    expect(entry.severity).toBe('info')
    expect(entry.message).toContain('Group grp-1 started (5 WOs)')
    expect(entry.groupId).toBe('grp-1')
    expect(entry.timestamp).toBe(1000)
    expect(entry.id).toBeTruthy()
    expect(entry.id.startsWith('grp-1')).toBe(true)
  })

  test('wo_status_changed', () => {
    const event: WoStatusChangedEvent = {
      type: 'wo_status_changed',
      groupId: 'grp-1',
      timestamp: 2000,
      woId: 'WO-001',
      model: 'glm-5',
      tier: 1,
      newStatus: 'running',
      attempt: 1,
    }
    const entry = convertToLogEntry(event)
    expect(entry.type).toBe('wo_started')
    expect(entry.severity).toBe('info')
    expect(entry.message).toContain('WO-001 → running (glm-5, tier 1)')
    expect(entry.woId).toBe('WO-001')
    expect(entry.model).toBe('glm-5')
    expect(entry.tier).toBe(1)
    expect(entry.timestamp).toBe(2000)
  })

  test('wo_completed (small tokens)', () => {
    const event: WoCompletedEvent = {
      type: 'wo_completed',
      groupId: 'grp-1',
      timestamp: 3000,
      woId: 'WO-001',
      durationSeconds: 45.678,
      tokenUsage: { inputTokens: 500, outputTokens: 300 },
      filesChanged: ['a.ts'],
    }
    const entry = convertToLogEntry(event)
    expect(entry.type).toBe('wo_completed')
    expect(entry.severity).toBe('success')
    expect(entry.message).toContain('WO-001 completed (800 tokens, 46s)')
    expect(entry.woId).toBe('WO-001')
    expect(entry.timestamp).toBe(3000)
  })

  test('wo_completed (large tokens >1000)', () => {
    const event: WoCompletedEvent = {
      type: 'wo_completed',
      groupId: 'grp-1',
      timestamp: 3000,
      woId: 'WO-003',
      durationSeconds: 120.5,
      tokenUsage: { inputTokens: 5000, outputTokens: 3000 },
      filesChanged: ['b.ts'],
    }
    const entry = convertToLogEntry(event)
    expect(entry.type).toBe('wo_completed')
    expect(entry.severity).toBe('success')
    expect(entry.message).toContain('8.0K tokens')
    expect(entry.woId).toBe('WO-003')
  })

  test('wo_failed', () => {
    const event: WoFailedEvent = {
      type: 'wo_failed',
      groupId: 'grp-1',
      timestamp: 4000,
      woId: 'WO-002',
      model: 'glm-5',
      tier: 1,
      error: 'Compile error in main.ts',
      attempt: 1,
      gateDetail: null,
    }
    const entry = convertToLogEntry(event)
    expect(entry.type).toBe('wo_failed')
    expect(entry.severity).toBe('error')
    expect(entry.message).toContain('WO-002 failed: Compile error')
    expect(entry.woId).toBe('WO-002')
    expect(entry.model).toBe('glm-5')
    expect(entry.tier).toBe(1)
    expect(entry.timestamp).toBe(4000)
  })

  test('wo_escalated', () => {
    const event: WoEscalatedEvent = {
      type: 'wo_escalated',
      groupId: 'grp-1',
      timestamp: 5000,
      woId: 'WO-002',
      fromTier: 1,
      toTier: 2,
      toModel: 'glm-5.1',
      errorHistory: [],
    }
    const entry = convertToLogEntry(event)
    expect(entry.type).toBe('wo_escalated')
    expect(entry.severity).toBe('warning')
    expect(entry.message).toContain('WO-002 escalated tier 1→2 (glm-5.1)')
    expect(entry.woId).toBe('WO-002')
    expect(entry.tier).toBe(2)
    expect(entry.timestamp).toBe(5000)
  })

  test('group_completed (success)', () => {
    const event: GroupCompletedEvent = {
      type: 'group_completed',
      groupId: 'grp-1',
      timestamp: 6000,
      status: 'completed',
      completedWos: 5,
      failedWos: 0,
      totalDurationSeconds: 120.5,
    }
    const entry = convertToLogEntry(event)
    expect(entry.type).toBe('group_completed')
    expect(entry.severity).toBe('success')
    expect(entry.message).toContain('Group grp-1 completed (5 done, 0 failed, 121s)')
    expect(entry.timestamp).toBe(6000)
  })

  test('group_completed (failed)', () => {
    const event: GroupCompletedEvent = {
      type: 'group_completed',
      groupId: 'grp-1',
      timestamp: 6000,
      status: 'failed',
      completedWos: 3,
      failedWos: 2,
      totalDurationSeconds: 90.1,
    }
    const entry = convertToLogEntry(event)
    expect(entry.type).toBe('group_completed')
    expect(entry.severity).toBe('error')
    expect(entry.message).toContain('failed')
  })
})
