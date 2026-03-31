// WU-002: CronAi Store & Settings Extensions
// Zustand store for AI drawer state, proposals, and session status.

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { CronAiProposal } from '@shared/types'

// ─── State Types ─────────────────────────────────────────────────────────────

export type CronAiSessionStatus = 'offline' | 'starting' | 'working' | 'waiting'

interface CronAiState {
  // Drawer UI
  drawerOpen: boolean
  drawerWidth: number // default 480, range 360-640

  // Session
  sessionStatus: CronAiSessionStatus
  sessionWindowId: string | null  // tmux window path (tmuxTarget)
  sessionId: string | null        // registry session id (for terminal-attach)

  // MCP connection
  mcpConnected: boolean

  // Proposals
  proposals: CronAiProposal[]
  pendingProposalCount: number // derived

  // Preferences
  autoStartSession: boolean
}

interface CronAiActions {
  // Drawer
  toggleDrawer: () => void
  setDrawerWidth: (width: number) => void

  // Session
  setSessionStatus: (status: CronAiSessionStatus) => void
  setSessionWindowId: (windowId: string | null) => void
  setSessionId: (sessionId: string | null) => void

  // MCP
  setMcpConnected: (connected: boolean) => void

  // Preferences
  setAutoStartSession: (enabled: boolean) => void

  // Proposals
  addProposal: (proposal: CronAiProposal) => void
  resolveProposal: (id: string, status: CronAiProposal['status'], feedback?: string) => void
  expireProposal: (id: string) => void
  clearProposals: () => void

  // WS message handlers (called from App.tsx WS dispatch)
  handleCronAiProposal: (proposal: CronAiProposal) => void
  handleCronAiProposalResolved: (id: string, status: CronAiProposal['status'], feedback?: string) => void
  handleCronAiSessionStatus: (status: CronAiSessionStatus) => void
  handleCronAiMcpStatus: (connected: boolean) => void
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DRAWER_MIN_WIDTH = 360
const DRAWER_MAX_WIDTH = 640
const DRAWER_DEFAULT_WIDTH = 480

// ─── Store ───────────────────────────────────────────────────────────────────

export const useCronAiStore = create<CronAiState & CronAiActions>()(
  persist(
    (set, get) => ({
      // ── Initial State ──────────────────────────────────────────────────
      drawerOpen: false,
      drawerWidth: DRAWER_DEFAULT_WIDTH,
      sessionStatus: 'offline' as CronAiSessionStatus,
      sessionWindowId: null,
      sessionId: null,
      mcpConnected: false,
      proposals: [],
      pendingProposalCount: 0,
      autoStartSession: true,

      // ── Drawer ─────────────────────────────────────────────────────────
      toggleDrawer: () => {
        set((state) => ({ drawerOpen: !state.drawerOpen }))
      },

      setDrawerWidth: (width: number) => {
        set({ drawerWidth: Math.max(DRAWER_MIN_WIDTH, Math.min(DRAWER_MAX_WIDTH, width)) })
      },

      // ── Session ────────────────────────────────────────────────────────
      setSessionStatus: (status: CronAiSessionStatus) => {
        set({ sessionStatus: status })
      },

      setSessionWindowId: (windowId: string | null) => {
        set({ sessionWindowId: windowId })
      },

      setSessionId: (sessionId: string | null) => {
        set({ sessionId })
      },

      // ── MCP ────────────────────────────────────────────────────────────
      setMcpConnected: (connected: boolean) => {
        set({ mcpConnected: connected })
      },

      // ── Preferences ──────────────────────────────────────────────────
      setAutoStartSession: (enabled: boolean) => {
        set({ autoStartSession: enabled })
      },

      // ── Proposals ──────────────────────────────────────────────────────
      addProposal: (proposal: CronAiProposal) => {
        set((state) => {
          const proposals = [...state.proposals, proposal]
          return {
            proposals,
            pendingProposalCount: proposals.filter((p) => p.status === 'pending').length,
          }
        })
      },

      resolveProposal: (id: string, status: CronAiProposal['status'], feedback?: string) => {
        set((state) => {
          const proposals = state.proposals.map((p) =>
            p.id === id
              ? { ...p, status, resolvedAt: new Date().toISOString(), ...(feedback !== undefined ? { feedback } : {}) }
              : p
          )
          return {
            proposals,
            pendingProposalCount: proposals.filter((p) => p.status === 'pending').length,
          }
        })
      },

      expireProposal: (id: string) => {
        get().resolveProposal(id, 'expired')
      },

      clearProposals: () => {
        set({ proposals: [], pendingProposalCount: 0 })
      },

      // ── WS Message Handlers ────────────────────────────────────────────
      handleCronAiProposal: (proposal: CronAiProposal) => {
        get().addProposal(proposal)
      },

      handleCronAiProposalResolved: (id: string, status: CronAiProposal['status'], feedback?: string) => {
        get().resolveProposal(id, status, feedback)
      },

      handleCronAiSessionStatus: (status: CronAiSessionStatus) => {
        get().setSessionStatus(status)
      },

      handleCronAiMcpStatus: (connected: boolean) => {
        get().setMcpConnected(connected)
      },
    }),
    {
      name: 'agentboard-cron-ai',
      storage: createJSONStorage(() => localStorage),
      // Only persist UI preferences, not runtime state
      partialize: (state) => ({
        drawerWidth: state.drawerWidth,
        autoStartSession: state.autoStartSession,
      }),
    }
  )
)

export { DRAWER_MIN_WIDTH, DRAWER_MAX_WIDTH, DRAWER_DEFAULT_WIDTH }
