export type SwarmEventType =
  | 'group_started'
  | 'wo_status_changed'
  | 'wo_completed'
  | 'wo_failed'
  | 'wo_escalated'
  | 'group_completed'

export type WoStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'escalated'

export type GroupStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted'

export interface SwarmEventBase {
  type: SwarmEventType
  groupId: string
  timestamp: string
}

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

export interface GroupStartedEvent extends SwarmEventBase {
  type: 'group_started'
  totalWos: number
  woIds: string[]
  edges: Array<{ from: string; to: string }>
}

export interface WoStatusChangedEvent extends SwarmEventBase {
  type: 'wo_status_changed'
  woId: string
  oldStatus: WoStatus
  newStatus: WoStatus
  model: string
  attempt: number
  tier: number
}

export interface WoCompletedEvent extends SwarmEventBase {
  type: 'wo_completed'
  woId: string
  tokenUsage: { inputTokens: number; outputTokens: number }
  gateResults: GateResultSummary | null
  filesChanged: string[]
  durationSeconds: number
}

export interface WoFailedEvent extends SwarmEventBase {
  type: 'wo_failed'
  woId: string
  error: string
  gateDetail: string | null
  model: string
  attempt: number
  tier: number
}

export interface WoEscalatedEvent extends SwarmEventBase {
  type: 'wo_escalated'
  woId: string
  fromTier: number
  toTier: number
  toModel: string
  errorHistory: ErrorHistoryEntry[]
}

export interface GroupCompletedEvent extends SwarmEventBase {
  type: 'group_completed'
  status: GroupStatus
  totalDurationSeconds: number
  completedWos: number
  failedWos: number
  totalTokens: { inputTokens: number; outputTokens: number }
}

export type SwarmEvent =
  | GroupStartedEvent
  | WoStatusChangedEvent
  | WoCompletedEvent
  | WoFailedEvent
  | WoEscalatedEvent
  | GroupCompletedEvent

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
