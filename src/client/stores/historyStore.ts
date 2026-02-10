// historyStore.ts - Zustand store for chat history state
import { create } from 'zustand'
import type { HistorySession } from '@shared/types'
import { authFetch } from '../utils/api'

const DEFAULT_HISTORY_LIMIT = 50

interface HistoryState {
  sessions: HistorySession[]
  searchQuery: string
  isLoading: boolean
  error: string | null
  mode: 'basic' | null
  showHistory: boolean
  resumeInProgress: boolean

  search: (query: string) => Promise<void>
  loadRecent: () => Promise<void>
  resumeSession: (sessionId: string, agentType: string) => Promise<{ ok: boolean; error?: string }>
  setShowHistory: (show: boolean) => void
  setSearchQuery: (query: string) => void
}

export const useHistoryStore = create<HistoryState>()((set, get) => ({
  sessions: [],
  searchQuery: '',
  isLoading: false,
  error: null,
  mode: null,
  showHistory: false,
  resumeInProgress: false,

  search: async (query: string) => {
    set({ isLoading: true, error: null, searchQuery: query })
    try {
      const params = new URLSearchParams({ q: query, limit: String(DEFAULT_HISTORY_LIMIT) })
      const res = await authFetch(`/api/history/search?${params}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Search failed' }))
        set({ error: data.error || 'Search failed', isLoading: false })
        return
      }
      const data = await res.json()
      set({ sessions: data.sessions, isLoading: false })
    } catch {
      set({ error: 'Failed to search history', isLoading: false })
    }
  },

  loadRecent: async () => {
    set({ isLoading: true, error: null })
    try {
      const res = await authFetch(`/api/history/recent?limit=${DEFAULT_HISTORY_LIMIT}`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to load' }))
        set({ error: data.error || 'Failed to load', isLoading: false })
        return
      }
      const data = await res.json()
      set({ sessions: data.sessions, isLoading: false })

      // Also check status for mode
      const statusRes = await authFetch('/api/history/status')
      if (statusRes.ok) {
        const status = await statusRes.json()
        set({ mode: status.mode || null })
      }
    } catch {
      set({ error: 'Failed to load recent sessions', isLoading: false })
    }
  },

  resumeSession: async (sessionId: string, agentType: string) => {
    if (get().resumeInProgress) return { ok: false, error: 'Resume already in progress' }
    set({ resumeInProgress: true })
    try {
      const res = await authFetch('/api/history/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, agentType }),
      })
      const data = await res.json()
      if (!res.ok) {
        return { ok: false, error: data.error || 'Resume failed' }
      }
      return { ok: true }
    } catch {
      return { ok: false, error: 'Network error' }
    } finally {
      set({ resumeInProgress: false })
    }
  },

  setShowHistory: (show) => set({ showHistory: show }),
  setSearchQuery: (query) => set({ searchQuery: query }),
}))
