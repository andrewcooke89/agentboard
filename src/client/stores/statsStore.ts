import { create } from 'zustand'
import type { Stats } from '@shared/types'
import { authFetch } from '../utils/api'

interface StatsStore {
  stats: Stats | null
  setStats: (stats: Stats) => void
  fetchStats: () => Promise<void>
}

export const useStatsStore = create<StatsStore>((set) => ({
  stats: null,
  setStats: (stats) => set({ stats }),
  fetchStats: async () => {
    try {
      const response = await authFetch('/api/stats')
      if (response.ok) {
        const stats = await response.json()
        set({ stats })
      }
    } catch (error) {
      console.error('Failed to fetch stats:', error)
    }
  },
}))
