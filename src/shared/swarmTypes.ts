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
  timestamp: number
  totalWos: number
}

export interface WoStatusChangedEvent {
  type: 'wo_status_changed'
  groupId: string
  timestamp: number
  woId: string
  model: string
  tier: number
  newStatus: string
}

export interface WoCompletedEvent {
  type: 'wo_completed'
  groupId: string
  timestamp: number
  woId: string
  durationSeconds: number
  tokenUsage: {
    inputTokens: number
    outputTokens: number
  }
}

export interface WoFailedEvent {
  type: 'wo_failed'
  groupId: string
  timestamp: number
  woId: string
  model: string
  tier: number
  error: string
}

export interface WoEscalatedEvent {
  type: 'wo_escalated'
  groupId: string
  timestamp: number
  woId: string
  fromTier: number
  toTier: number
  toModel: string
}

export interface GroupCompletedEvent {
  type: 'group_completed'
  groupId: string
  timestamp: number
  status: 'completed' | 'failed' | 'partial'
  completedWos: number
  failedWos: number
  totalDurationSeconds: number
}

export type SwarmEvent = 
  | GroupStartedEvent
  | WoStatusChangedEvent
  | WoCompletedEvent
  | WoFailedEvent
  | WoEscalatedEvent
  | GroupCompletedEvent
