// poolStore.ts - Zustand store for pool status (REQ-10 to REQ-13)
import { create } from 'zustand'
import type { PoolStatus, PoolSlot, PoolQueueEntry } from '@shared/types'
import { authFetch } from '../utils/api'

interface PoolState {
  poolStatus: PoolStatus | null
  loading: boolean

  // REST
  fetchPoolStatus: () => Promise<void>

  // WebSocket handlers
  handlePoolSlotGranted: (slot: PoolSlot) => void
  handleStepQueued: (entry: PoolQueueEntry) => void
  handlePoolSlotReleased: (slotId: string) => void
  handlePoolStatusUpdate: (status: PoolStatus) => void
}

export const usePoolStore = create<PoolState>()((set) => ({
  poolStatus: null,
  loading: false,

  fetchPoolStatus: async () => {
    set({ loading: true })
    try {
      const res = await authFetch('/api/pool/status')
      if (res.ok) {
        const status: PoolStatus = await res.json()
        set({ poolStatus: status, loading: false })
      } else {
        set({ loading: false })
      }
    } catch {
      set({ loading: false })
    }
  },

  handlePoolSlotGranted: (slot) => {
    set((state) => {
      if (!state.poolStatus) return state
      const activeSlots = [...state.poolStatus.activeSlots.filter(s => s.slotId !== slot.slotId), slot]
      const queue = state.poolStatus.queue.filter(q => q.stepName !== slot.stepName || q.runId !== slot.runId)
      return {
        poolStatus: { ...state.poolStatus, activeSlots, queue },
      }
    })
  },

  handleStepQueued: (entry) => {
    set((state) => {
      if (!state.poolStatus) return state
      const queue = [...state.poolStatus.queue.filter(q => !(q.runId === entry.runId && q.stepName === entry.stepName)), entry]
      return {
        poolStatus: { ...state.poolStatus, queue },
      }
    })
  },

  handlePoolSlotReleased: (slotId) => {
    set((state) => {
      if (!state.poolStatus) return state
      return {
        poolStatus: {
          ...state.poolStatus,
          activeSlots: state.poolStatus.activeSlots.filter(s => s.slotId !== slotId),
        },
      }
    })
  },

  handlePoolStatusUpdate: (status) => {
    set({ poolStatus: status })
  },
}))
