export interface EventLogEntry {
  id: string
  timestamp: string
  type:
    | 'wo_started'
    | 'wo_completed'
    | 'wo_failed'
    | 'wo_escalated'
    | 'group_started'
    | 'group_completed'
  groupId: string
  woId?: string
  model?: string
  tier?: number
  message: string
  severity: 'info' | 'success' | 'warning' | 'error'
}

export interface DashboardStats {
  activeSessions: number
  totalTasks: number
  runningTasks: number
  completedTasksToday: number
  activeDispatches: number
  completedDispatches: number
  totalWosCompleted: number
  totalWosFailed: number
  uptimeSeconds: number
  lastUpdated: string
}

export interface StatsUpdateMessage {
  type: 'stats-update'
  stats: DashboardStats
}
