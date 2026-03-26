// Shared type definitions for dashboard components

export type EventSeverity = 'info' | 'success' | 'warning' | 'error'

export type EventLogEntryType = 
  | 'group_started'
  | 'wo_started'
  | 'wo_completed'
  | 'wo_failed'
  | 'wo_escalated'
  | 'group_completed'

export interface BaseEventLogEntry {
  id: string
  timestamp: number
  groupId: string
  type: EventLogEntryType
  message: string
  severity: EventSeverity
  woId?: string
  model?: string
  tier?: number
}

export type EventLogEntry = BaseEventLogEntry
