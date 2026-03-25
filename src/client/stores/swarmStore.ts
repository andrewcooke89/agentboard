// swarmStore.ts - Zustand store for swarm state
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type {
  SwarmGroupState,
  SwarmEvent,
  SwarmWoState,
} from '@shared/swarmTypes'
import { safeStorage } from '../utils/storage'
import { authFetch } from '../utils/api'

interface SwarmStore {
  groups: SwarmGroupState[]
  selectedGroupId: string | null
  selectedWoId: string | null
  eventLog: SwarmEvent[]

  selectedGroup: () => SwarmGroupState | null
  selectedWo: () => SwarmWoState | null

  setGroups: (groups: SwarmGroupState[]) => void
  selectGroup: (groupId: string | null) => void
  selectWo: (woId: string | null) => void
  handleSwarmUpdate: (event: SwarmEvent) => void
  handleSwarmState: (groups: SwarmGroupState[]) => void

  fetchGroups: () => Promise<void>
}

function createInitialWoState(woId: string): SwarmWoState {
  return {
    woId,
    title: woId,
    status: 'pending',
    model: '',
    attempt: 0,
    maxRetries: 0,
    escalationTier: 0,
    escalationChain: [],
    dependsOn: [],
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    gateResults: null,
    errorHistory: [],
    filesChanged: [],
    startedAt: null,
    completedAt: null,
    durationSeconds: null,
  }
}

function createInitialGroupState(groupId: string, timestamp: string): SwarmGroupState {
  return {
    groupId,
    status: 'running',
    totalWos: 0,
    completedWos: 0,
    failedWos: 0,
    edges: [],
    wos: {},
    startedAt: timestamp,
    totalDurationSeconds: null,
    totalTokens: { inputTokens: 0, outputTokens: 0 },
  }
}

function cloneGroup(group: SwarmGroupState): SwarmGroupState {
  return {
    ...group,
    edges: group.edges.map((edge) => ({ ...edge })),
    totalTokens: { ...group.totalTokens },
    wos: Object.fromEntries(
      Object.entries(group.wos).map(([woId, wo]) => [
        woId,
        {
          ...wo,
          dependsOn: [...wo.dependsOn],
          escalationChain: wo.escalationChain.map((entry) => ({ ...entry })),
          tokenUsage: { ...wo.tokenUsage },
          gateResults: wo.gateResults
            ? {
                ...wo.gateResults,
                gates: wo.gateResults.gates.map((gate) => ({ ...gate })),
              }
            : null,
          errorHistory: wo.errorHistory.map((entry) => ({ ...entry })),
          filesChanged: [...wo.filesChanged],
        },
      ])
    ),
  }
}

function isActiveGroup(group: SwarmGroupState): boolean {
  return group.status === 'pending' || group.status === 'running'
}

function getValidSelectedGroupId(
  groups: SwarmGroupState[],
  selectedGroupId: string | null
): string | null {
  if (!selectedGroupId) {
    return null
  }

  return groups.some((group) => group.groupId === selectedGroupId) ? selectedGroupId : null
}

function getAutoSelectedGroupId(
  groups: SwarmGroupState[],
  selectedGroupId: string | null
): string | null {
  const validSelectedGroupId = getValidSelectedGroupId(groups, selectedGroupId)
  if (validSelectedGroupId) {
    const selectedGroup = groups.find((group) => group.groupId === validSelectedGroupId)
    if (selectedGroup && isActiveGroup(selectedGroup)) {
      return validSelectedGroupId
    }
  }

  const firstActiveGroupId = groups.find(isActiveGroup)?.groupId
  if (firstActiveGroupId) {
    return firstActiveGroupId
  }

  if (validSelectedGroupId) {
    return validSelectedGroupId
  }

  return groups[0]?.groupId ?? null
}

function getValidSelectedWoId(
  groups: SwarmGroupState[],
  selectedGroupId: string | null,
  selectedWoId: string | null
): string | null {
  if (!selectedGroupId || !selectedWoId) {
    return null
  }

  const selectedGroup = groups.find((group) => group.groupId === selectedGroupId)
  if (!selectedGroup) {
    return null
  }

  return selectedGroup.wos[selectedWoId] ? selectedWoId : null
}

function applySwarmEvent(group: SwarmGroupState, event: SwarmEvent): SwarmGroupState {
  const nextGroup = cloneGroup(group)

  switch (event.type) {
    case 'group_started': {
      nextGroup.status = 'running'
      nextGroup.totalWos = event.totalWos
      nextGroup.completedWos = 0
      nextGroup.failedWos = 0
      nextGroup.edges = event.edges.map((edge) => ({ ...edge }))
      nextGroup.wos = Object.fromEntries(
        event.woIds.map((woId) => [woId, createInitialWoState(woId)])
      )
      nextGroup.startedAt = event.timestamp
      nextGroup.totalDurationSeconds = null
      nextGroup.totalTokens = { inputTokens: 0, outputTokens: 0 }
      return nextGroup
    }

    case 'wo_status_changed': {
      const current = nextGroup.wos[event.woId] ?? createInitialWoState(event.woId)
      nextGroup.wos[event.woId] = {
        ...current,
        status: event.newStatus,
        model: event.model,
        attempt: event.attempt,
        escalationTier: event.tier,
        startedAt: current.startedAt ?? (event.newStatus === 'running' ? event.timestamp : null),
      }
      nextGroup.totalWos = Math.max(nextGroup.totalWos, Object.keys(nextGroup.wos).length)
      return nextGroup
    }

    case 'wo_completed': {
      const current = nextGroup.wos[event.woId] ?? createInitialWoState(event.woId)
      const wasCompleted = current.completedAt !== null || current.status === 'completed'
      nextGroup.wos[event.woId] = {
        ...current,
        status: 'completed',
        tokenUsage: { ...event.tokenUsage },
        gateResults: event.gateResults
          ? {
              ...event.gateResults,
              gates: event.gateResults.gates.map((gate) => ({ ...gate })),
            }
          : null,
        filesChanged: [...event.filesChanged],
        durationSeconds: event.durationSeconds,
        completedAt: event.timestamp,
        startedAt: current.startedAt ?? event.timestamp,
      }
      if (!wasCompleted) {
        nextGroup.completedWos += 1
      }
      nextGroup.totalWos = Math.max(nextGroup.totalWos, Object.keys(nextGroup.wos).length)
      return nextGroup
    }

    case 'wo_failed': {
      const current = nextGroup.wos[event.woId] ?? createInitialWoState(event.woId)
      const wasFailed = current.status === 'failed'
      nextGroup.wos[event.woId] = {
        ...current,
        status: 'failed',
        model: event.model,
        attempt: event.attempt,
        escalationTier: event.tier,
        errorHistory: [
          ...current.errorHistory,
          {
            tier: event.tier,
            model: event.model,
            attempt: event.attempt,
            error: event.error,
            gateDetail: event.gateDetail,
          },
        ],
        completedAt: event.timestamp,
        startedAt: current.startedAt ?? event.timestamp,
      }
      if (!wasFailed) {
        nextGroup.failedWos += 1
      }
      nextGroup.totalWos = Math.max(nextGroup.totalWos, Object.keys(nextGroup.wos).length)
      return nextGroup
    }

    case 'wo_escalated': {
      const current = nextGroup.wos[event.woId] ?? createInitialWoState(event.woId)
      nextGroup.wos[event.woId] = {
        ...current,
        status: 'escalated',
        model: event.toModel,
        escalationTier: event.toTier,
        errorHistory: [
          ...current.errorHistory,
          ...event.errorHistory.map((entry) => ({ ...entry })),
        ],
      }
      nextGroup.totalWos = Math.max(nextGroup.totalWos, Object.keys(nextGroup.wos).length)
      return nextGroup
    }

    case 'group_completed': {
      nextGroup.status = event.status
      nextGroup.totalDurationSeconds = event.totalDurationSeconds
      nextGroup.completedWos = event.completedWos
      nextGroup.failedWos = event.failedWos
      nextGroup.totalTokens = { ...event.totalTokens }
      return nextGroup
    }
  }
}

export const useSwarmStore = create<SwarmStore>()(
  persist(
    (set, get) => ({
      groups: [],
      selectedGroupId: null,
      selectedWoId: null,
      eventLog: [],

      selectedGroup: () => {
        const { groups, selectedGroupId } = get()
        return groups.find((group) => group.groupId === selectedGroupId) ?? null
      },

      selectedWo: () => {
        const group = get().selectedGroup()
        if (!group) {
          return null
        }
        return group.wos[get().selectedWoId ?? ''] ?? null
      },

      setGroups: (groups) => {
        const nextGroups = groups.map(cloneGroup)
        set((state) => {
          const selectedGroupId = getAutoSelectedGroupId(nextGroups, state.selectedGroupId)
          return {
            groups: nextGroups,
            selectedGroupId,
            selectedWoId: getValidSelectedWoId(nextGroups, selectedGroupId, state.selectedWoId),
            eventLog: [],
          }
        })
      },

      selectGroup: (groupId) => {
        const selectedGroupId = getValidSelectedGroupId(get().groups, groupId)
        set({ selectedGroupId, selectedWoId: null, eventLog: [] })
      },

      selectWo: (woId) => {
        const group = get().selectedGroup()
        const selectedWoId = group && woId && group.wos[woId] ? woId : null
        set({ selectedWoId })
      },

      handleSwarmUpdate: (event) => {
        set((state) => {
          const groups = state.groups.map(cloneGroup)
          const groupIndex = groups.findIndex((group) => group.groupId === event.groupId)
          const baseGroup =
            groupIndex === -1
              ? createInitialGroupState(event.groupId, event.timestamp)
              : groups[groupIndex]
          const nextGroup = applySwarmEvent(baseGroup, event)

          if (groupIndex === -1) {
            groups.push(nextGroup)
          } else {
            groups[groupIndex] = nextGroup
          }

          const selectedGroupId = getAutoSelectedGroupId(groups, state.selectedGroupId)
          const selectedWoId = getValidSelectedWoId(groups, selectedGroupId, state.selectedWoId)
          const selectedGroupChanged = selectedGroupId !== state.selectedGroupId
          const eventLog =
            selectedGroupId === event.groupId
              ? [...(selectedGroupChanged ? [] : state.eventLog), event].slice(-200)
              : selectedGroupChanged
                ? []
                : state.eventLog

          return {
            groups,
            selectedGroupId,
            selectedWoId,
            eventLog,
          }
        })
      },

      handleSwarmState: (groups) => {
        set((state) => {
          const nextGroups = groups.map(cloneGroup)
          const selectedGroupId = getAutoSelectedGroupId(nextGroups, state.selectedGroupId)
          return {
            groups: nextGroups,
            selectedGroupId,
            selectedWoId: getValidSelectedWoId(nextGroups, selectedGroupId, state.selectedWoId),
            eventLog: [],
          }
        })
      },

      fetchGroups: async () => {
        try {
          const res = await authFetch('/api/swarm/groups')
          if (!res.ok) {
            const text = await res.text()
            console.error('Failed to fetch swarm groups:', text || `HTTP ${res.status}`)
            return
          }
          const groups: SwarmGroupState[] = await res.json()
          get().handleSwarmState(groups)
        } catch (err) {
          console.error('Failed to fetch swarm groups:', err)
        }
      },
    }),
    {
      name: 'agentboard-swarm',
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({
        selectedGroupId: state.selectedGroupId,
      }),
    }
  )
)
