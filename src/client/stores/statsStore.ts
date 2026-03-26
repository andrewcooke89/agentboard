import { create } from 'zustand'
import type { DashboardStats } from '../../shared/dashboardTypes'

interface StatsStore {
  stats: DashboardStats | null
  setStats: (stats: DashboardStats) => void
  fetchStats: () => Promise<void>
}

export const useStatsStore = create<StatsStore>((set) => ({
  stats: null,
  
  setStats: (stats: DashboardStats) => {
    set({ stats })
  },
  
  fetchStats: async () => {
    const res = await fetch('/api/stats')
    if (res.ok) {
      const data = await res.json()
      set({ stats: data })
    }
  },
}))
