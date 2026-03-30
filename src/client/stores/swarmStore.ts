import { create } from 'zustand'
import type { SwarmEvent, SwarmGroupState, SwarmWoState } from '../../shared/swarmTypes'

interface SwarmStore {
  groups: SwarmGroupState[]
  selectedGroupId: string | null
  selectedWoId: string | null
  eventLog: SwarmEvent[]

  selectGroup: (groupId: string | null) => void
  selectWo: (woId: string | null) => void
  handleSwarmUpdate: (event: SwarmEvent) => void
  handleSwarmState: (groups: SwarmGroupState[]) => void
  fetchGroups: () => Promise<void>
}

export const useSwarmStore = create<SwarmStore>((set, get) => ({
  groups: [],
  selectedGroupId: null,
  selectedWoId: null,
  eventLog: [],

  selectGroup: (groupId) => set({ selectedGroupId: groupId }),
  selectWo: (woId) => set({ selectedWoId: woId }),

  handleSwarmState: (groups) => {
    set({ groups })
    // Auto-select first group if none selected
    if (!get().selectedGroupId && groups.length > 0) {
      set({ selectedGroupId: groups[0].groupId })
    }
  },

  handleSwarmUpdate: (event) => {
    const { groups, eventLog, selectedGroupId } = get()
    const newLog = [...eventLog.slice(-199), event]

    const groupIdx = groups.findIndex(g => g.groupId === event.groupId)

    if (event.type === 'group_started') {
      const wos: SwarmGroupState['wos'] = {}
      if ('woIds' in event) {
        for (const woId of (event as { woIds: string[] }).woIds) {
          const woState: SwarmWoState = {
            woId, title: woId, status: 'pending', model: '', attempt: 0,
            maxRetries: 0, escalationTier: 0, escalationChain: [], dependsOn: [],
            tokenUsage: { inputTokens: 0, outputTokens: 0 }, gateResults: null,
            errorHistory: [], filesChanged: [], unifiedDiff: null, startedAt: null, completedAt: null,
            durationSeconds: null,
          }
          wos[woId] = woState
        }
      }
      const newGroup: SwarmGroupState = {
        groupId: event.groupId,
        status: 'running',
        totalWos: event.totalWos,
        completedWos: 0,
        failedWos: 0,
        edges: 'edges' in event ? (event as { edges: Array<{ from: string; to: string }> }).edges : [],
        wos,
        startedAt: String(event.timestamp),
        totalDurationSeconds: null,
        totalTokens: { inputTokens: 0, outputTokens: 0 },
      }
      const newGroups = [...groups, newGroup]
      set({ groups: newGroups, eventLog: newLog, selectedGroupId: selectedGroupId || event.groupId })
      return
    }

    if (groupIdx === -1) { set({ eventLog: newLog }); return }

    const updated = [...groups]
    const group = { ...updated[groupIdx], wos: { ...updated[groupIdx].wos } }
    updated[groupIdx] = group

    if (event.type === 'wo_status_changed') {
      const wo = group.wos[event.woId]
      if (wo) {
        group.wos[event.woId] = { ...wo, status: event.newStatus as SwarmWoState['status'], model: event.model, attempt: wo.attempt, escalationTier: event.tier }
      }
    } else if (event.type === 'wo_completed') {
      const wo = group.wos[event.woId]
      if (wo) {
        group.wos[event.woId] = { ...wo, status: 'completed', tokenUsage: event.tokenUsage, durationSeconds: event.durationSeconds, completedAt: String(event.timestamp), unifiedDiff: event.unifiedDiff ?? null }
      }
      group.completedWos++
    } else if (event.type === 'wo_failed') {
      const wo = group.wos[event.woId]
      if (wo) {
        group.wos[event.woId] = { ...wo, status: 'failed', model: event.model, escalationTier: event.tier }
      }
      group.failedWos++
    } else if (event.type === 'wo_escalated') {
      const wo = group.wos[event.woId]
      if (wo) {
        group.wos[event.woId] = { ...wo, status: 'escalated', escalationTier: event.toTier }
      }
    } else if (event.type === 'group_completed') {
      group.status = event.status === 'partial' ? 'failed' : event.status
      group.completedWos = event.completedWos
      group.failedWos = event.failedWos
      group.totalDurationSeconds = event.totalDurationSeconds
    }

    set({ groups: updated, eventLog: newLog })
  },

  fetchGroups: async () => {
    try {
      const resp = await fetch('/api/swarm/groups')
      if (resp.ok) {
        const groups = await resp.json()
        get().handleSwarmState(groups)
      }
    } catch { /* ignore */ }
  },
}))
