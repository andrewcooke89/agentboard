import type { Stats } from './types'

export interface StatsUpdateMessage {
  type: 'stats-update'
  stats: Stats
}
