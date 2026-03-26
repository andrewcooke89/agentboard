import type {
  GroupCompletedEvent,
  GroupStartedEvent,
  SwarmEvent,
  SwarmGroupState,
  SwarmWoState,
  WoCompletedEvent,
  WoEscalatedEvent,
  WoFailedEvent,
  WoStatusChangedEvent,
} from '../shared/swarmTypes'

const MAX_EVENT_LOG_SIZE = 1000
const GROUP_RETENTION_MS = 24 * 60 * 60 * 1000

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
    unifiedDiff: null,
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

export class SwarmManager {
  private static instance: SwarmManager | null = null

  private groups: Map<string, SwarmGroupState> = new Map()
  private eventLog: SwarmEvent[] = []
  private listeners: Set<(event: SwarmEvent) => void> = new Set()

  static getInstance(): SwarmManager {
    if (!SwarmManager.instance) {
      SwarmManager.instance = new SwarmManager()
    }
    return SwarmManager.instance
  }

  private constructor() {}

  /** Process an incoming swarm event from the executor. */
  processEvent(event: SwarmEvent): void {
    this.pruneExpiredGroups(event.timestamp)

    switch (event.type) {
      case 'group_started':
        this.handleGroupStarted(event)
        break
      case 'wo_status_changed':
        this.handleWoStatusChanged(event)
        break
      case 'wo_completed':
        this.handleWoCompleted(event)
        break
      case 'wo_failed':
        this.handleWoFailed(event)
        break
      case 'wo_escalated':
        this.handleWoEscalated(event)
        break
      case 'group_completed':
        this.handleGroupCompleted(event)
        break
    }

    if (this.eventLog.length >= MAX_EVENT_LOG_SIZE) {
      this.eventLog.shift()
    }
    this.eventLog.push(event)

    for (const listener of this.listeners) {
      listener(event)
    }
  }

  /** Subscribe to real-time events (for WebSocket broadcast). */
  onEvent(listener: (event: SwarmEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Get all active groups (for initial state load). */
  getGroups(): SwarmGroupState[] {
    this.pruneExpiredGroups()
    return [...this.groups.values()].map(cloneGroup)
  }

  /** Get a single group by ID. */
  getGroup(groupId: string): SwarmGroupState | undefined {
    this.pruneExpiredGroups()
    const group = this.groups.get(groupId)
    return group ? cloneGroup(group) : undefined
  }

  /** Get recent events (for replay on reconnect). */
  getRecentEvents(limit = 100): SwarmEvent[] {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100
    return this.eventLog.slice(-safeLimit)
  }

  private handleGroupStarted(event: GroupStartedEvent): void {
    const wos = Object.fromEntries(
      event.woIds.map((woId) => [woId, createInitialWoState(woId)])
    )

    this.groups.set(event.groupId, {
      groupId: event.groupId,
      status: 'running',
      totalWos: event.totalWos,
      completedWos: 0,
      failedWos: 0,
      edges: event.edges.map((edge) => ({ ...edge })),
      wos,
      startedAt: event.timestamp,
      totalDurationSeconds: null,
      totalTokens: { inputTokens: 0, outputTokens: 0 },
    })
  }

  private handleWoStatusChanged(event: WoStatusChangedEvent): void {
    const group = this.groups.get(event.groupId)
    if (!group) return

    const current = group.wos[event.woId] ?? createInitialWoState(event.woId)
    group.wos[event.woId] = {
      ...current,
      status: event.newStatus,
      model: event.model,
      attempt: event.attempt,
      escalationTier: event.tier,
      startedAt: current.startedAt ?? (event.newStatus === 'running' ? event.timestamp : null),
    }
  }

  private handleWoCompleted(event: WoCompletedEvent): void {
    const group = this.groups.get(event.groupId)
    if (!group) return

    const current = group.wos[event.woId] ?? createInitialWoState(event.woId)
    const wasCompleted = current.completedAt !== null || current.status === 'completed'
    group.wos[event.woId] = {
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
      unifiedDiff: event.unifiedDiff ?? null,
    }

    if (!wasCompleted) {
      group.completedWos += 1
    }
  }

  private handleWoFailed(event: WoFailedEvent): void {
    const group = this.groups.get(event.groupId)
    if (!group) return

    const current = group.wos[event.woId] ?? createInitialWoState(event.woId)
    const wasFailed = current.status === 'failed'
    group.wos[event.woId] = {
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
      group.failedWos += 1
    }
  }

  private handleWoEscalated(event: WoEscalatedEvent): void {
    const group = this.groups.get(event.groupId)
    if (!group) return

    const current = group.wos[event.woId] ?? createInitialWoState(event.woId)
    group.wos[event.woId] = {
      ...current,
      status: 'escalated',
      model: event.toModel,
      escalationTier: event.toTier,
      errorHistory: [
        ...current.errorHistory,
        ...event.errorHistory.map((entry) => ({ ...entry })),
      ],
    }
  }

  private handleGroupCompleted(event: GroupCompletedEvent): void {
    const group = this.groups.get(event.groupId)
    if (!group) return

    group.status = event.status === 'partial' ? 'failed' : event.status
    group.totalDurationSeconds = event.totalDurationSeconds
    group.completedWos = event.completedWos
    group.failedWos = event.failedWos
  }

  private pruneExpiredGroups(referenceTimestamp?: string): void {
    const now = referenceTimestamp ? Date.parse(referenceTimestamp) : Date.now()
    if (Number.isNaN(now)) return

    for (const [groupId, group] of this.groups.entries()) {
      const startedAt = group.startedAt ? Date.parse(group.startedAt) : NaN
      if (!Number.isNaN(startedAt) && now - startedAt > GROUP_RETENTION_MS) {
        this.groups.delete(groupId)
      }
    }
  }
}
