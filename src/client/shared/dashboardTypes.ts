export interface EventLogEntry {
  timestamp: string | Date
  severity: 'info' | 'success' | 'warning' | 'error'
  message: string
  woId?: string
  modelName?: string
}
