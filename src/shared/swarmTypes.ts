// SwarmEvent types for tracking group and work order lifecycle

export type SwarmEventType = 
  | 'group_started'
  | 'wo_status_changed'
  | 'wo_completed'
  | 'wo_failed'
  | 'wo_escalated'
  | 'group_completed'

export interface GroupStartedEvent {
  type: 'group_started'
  groupId: string
  timestamp: string
  totalWos: number
  woIds: string[]
  edges: Array<{ from: string; to: string }>
}

export interface WoStatusChangedEvent {
  type: 'wo_status_changed'
  groupId: string
  timestamp: string
  woId: string
  model: string
  tier: number
  oldStatus: WoStatus
  newStatus: WoStatus
  attempt: number
}

export interface WoCompletedEvent {
  type: 'wo_completed'
  groupId: string
  timestamp: string
  woId: string
  durationSeconds: number
  tokenUsage: {
    inputTokens: number
    outputTokens: number
  }
  gateResults?: GateResultSummary | null
  filesChanged: string[]
  unifiedDiff?: string
}

export interface WoFailedEvent {
  type: 'wo_failed'
  groupId: string
  timestamp: string
  woId: string
  model: string
  tier: number
  error: string
  attempt: number
  gateDetail: string | null
}

export interface WoEscalatedEvent {
  type: 'wo_escalated'
  groupId: string
  timestamp: string
  woId: string
  fromTier: number
  toTier: number
  toModel: string
  errorHistory: ErrorHistoryEntry[]
}

export interface GroupCompletedEvent {
  type: 'group_completed'
  groupId: string
  timestamp: string
  status: 'completed' | 'failed' | 'partial'
  completedWos: number
  failedWos: number
  totalDurationSeconds: number
  totalTokens: { inputTokens: number; outputTokens: number }
}

export type SwarmEvent =
  | GroupStartedEvent
  | WoStatusChangedEvent
  | WoCompletedEvent
  | WoFailedEvent
  | WoEscalatedEvent
  | GroupCompletedEvent

// State types for frontend store and backend manager

export type WoStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'escalated'
export type GroupStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted'

export interface GateResultSummary {
  allPassed: boolean
  gates: Array<{ name: string; passed: boolean; output?: string }>
}

export interface ErrorHistoryEntry {
  tier: number
  model: string
  attempt: number
  error: string
  gateDetail: string | null
}

export interface SwarmWoState {
  woId: string
  title: string
  status: WoStatus
  model: string
  attempt: number
  maxRetries: number
  escalationTier: number
  escalationChain: Array<{ model: string; maxRetries: number }>
  dependsOn: string[]
  tokenUsage: { inputTokens: number; outputTokens: number }
  gateResults: GateResultSummary | null
  errorHistory: ErrorHistoryEntry[]
  filesChanged: string[]
  startedAt: string | null
  completedAt: string | null
  durationSeconds: number | null
  unifiedDiff: string | null
}

export interface SwarmGroupState {
  groupId: string
  status: GroupStatus
  totalWos: number
  completedWos: number
  failedWos: number
  edges: Array<{ from: string; to: string }>
  wos: Record<string, SwarmWoState>
  startedAt: string | null
  totalDurationSeconds: number | null
  totalTokens: { inputTokens: number; outputTokens: number }
}

export interface SwarmUpdateMessage {
  type: 'swarm-update'
  event: SwarmEvent
}

export interface SwarmStateMessage {
  type: 'swarm-state'
  groups: SwarmGroupState[]
}
