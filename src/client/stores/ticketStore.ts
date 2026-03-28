import { create } from 'zustand'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TicketSummary {
  id: string
  title: string
  status: string
  severity: string
  category: string
  effort: string
  source: { file: string; line_start: number }
  found_by: string
  tags: string[]
  created_at: string
  updated_at: string
  notes_count: number
  is_blocked: boolean
}

export interface TicketDetail {
  id: string
  title: string
  description: string
  suggestion: string
  status: string
  severity: string
  category: string
  effort: string
  source: {
    file: string
    line_start: number
    line_end?: number
    code_snippet: string
  }
  found_by: string
  tags: string[]
  notes: Array<{ timestamp: string; author: string; content: string }>
  created_at: string
  updated_at: string
  resolution: {
    status: string | null
    resolved_at: string | null
    resolved_by: string | null
  }
}

export interface TicketStats {
  total: number
  by_status: Record<string, number>
  by_category: Record<string, number>
  by_severity: Record<string, number>
  auto_fixable: number
  created_today: number
  created_this_week: number
  resolved_this_week: number
  average_age_days: number
  oldest_open: { id: string; created_at: string; age_days: number } | null
}

export interface NightlyReport {
  date: string
  project: string
  startedAt: string
  completedAt: string
  durationMinutes: number
  detect: {
    detectors_run: string[]
    findings_total: number
    tickets_created: number
    tickets_stale_resolved: number
  }
  fix: {
    cycles: number
    fixed: number
    failed: number
    skipped_blocked: number
    small: { dispatched: number; succeeded: number; failed: number }
    medium: { dispatched: number; succeeded: number; failed: number }
    prs_opened: string[]
  }
  backlog: {
    total_open: number
    by_effort: Record<string, number>
    by_category: Record<string, number>
    blocked: number
  }
  notable_failures: Array<{ ticket_id: string; title: string; reason: string }>
}

export interface TicketFilters {
  status: string
  effort: string
  category: string
  severity: string
}

// ─── Store ───────────────────────────────────────────────────────────────────

interface TicketStore {
  // Ticket list
  tickets: TicketSummary[]
  totalCount: number
  filters: TicketFilters
  loading: boolean

  // Stats
  stats: TicketStats | null

  // Reports
  reports: NightlyReport[]
  latestReport: NightlyReport | null

  // Selected
  selectedTicketId: string | null
  selectedTicket: TicketDetail | null

  // Dispatch state
  dispatchingTicketId: string | null

  // Actions
  fetchTickets: () => Promise<void>
  fetchStats: () => Promise<void>
  fetchReports: () => Promise<void>
  fetchTicketDetail: (id: string) => Promise<void>
  setFilters: (filters: Partial<TicketFilters>) => void
  selectTicket: (id: string | null) => void
  dispatchFix: (ticketId: string) => Promise<void>
  transitionTicket: (id: string, status: string) => Promise<void>

  // WS handlers
  handleNightlyReport: (report: NightlyReport) => void
  handleTicketUpdate: (ticket: { id: string; status: string }, action: string) => void
}

const API_BASE = '' // relative to origin

export const useTicketStore = create<TicketStore>((set, get) => ({
  tickets: [],
  totalCount: 0,
  filters: { status: 'open', effort: '', category: '', severity: '' },
  loading: false,
  stats: null,
  reports: [],
  latestReport: null,
  selectedTicketId: null,
  selectedTicket: null,
  dispatchingTicketId: null,

  fetchTickets: async () => {
    set({ loading: true })
    try {
      const { filters } = get()
      const params = new URLSearchParams()
      if (filters.status) params.set('status', filters.status)
      params.set('limit', '200')
      const resp = await fetch(`${API_BASE}/api/tickets?${params}`)
      if (!resp.ok) throw new Error(`${resp.status}`)
      const data = await resp.json() as { tickets: TicketSummary[]; total: number }

      // Client-side filter for effort/category/severity (server may not support all filters)
      let filtered = data.tickets
      if (filters.effort) filtered = filtered.filter(t => t.effort === filters.effort)
      if (filters.category) filtered = filtered.filter(t => t.category === filters.category)
      if (filters.severity) filtered = filtered.filter(t => t.severity === filters.severity)

      set({ tickets: filtered, totalCount: filtered.length, loading: false })
    } catch (err) {
      console.error('[ticketStore] fetchTickets failed:', err)
      set({ loading: false })
    }
  },

  fetchStats: async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/tickets/stats`)
      if (!resp.ok) return
      const stats = await resp.json() as TicketStats
      set({ stats })
    } catch (err) {
      console.error('[ticketStore] fetchStats failed:', err)
    }
  },

  fetchReports: async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/nightly/reports?limit=14`)
      if (!resp.ok) return
      const data = await resp.json() as { reports: NightlyReport[] }
      set({
        reports: data.reports,
        latestReport: data.reports.length > 0 ? data.reports[0] : null,
      })
    } catch (err) {
      console.error('[ticketStore] fetchReports failed:', err)
    }
  },

  fetchTicketDetail: async (id: string) => {
    try {
      const resp = await fetch(`${API_BASE}/api/tickets/${id}`)
      if (!resp.ok) return
      const ticket = await resp.json() as TicketDetail
      set({ selectedTicket: ticket })
    } catch (err) {
      console.error('[ticketStore] fetchTicketDetail failed:', err)
    }
  },

  setFilters: (partial) => {
    const filters = { ...get().filters, ...partial }
    set({ filters })
    get().fetchTickets()
  },

  selectTicket: (id) => {
    set({ selectedTicketId: id, selectedTicket: null })
    if (id) get().fetchTicketDetail(id)
  },

  dispatchFix: async (ticketId: string) => {
    set({ dispatchingTicketId: ticketId })
    try {
      const resp = await fetch(`${API_BASE}/api/tickets/${ticketId}/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Unknown error' }))
        console.error('[ticketStore] dispatchFix failed:', err)
      }
      // Wait for backend to process, then refresh
      await new Promise(r => setTimeout(r, 1500))
      await get().fetchTickets()
    } catch (err) {
      console.error('[ticketStore] dispatchFix error:', err)
    } finally {
      set({ dispatchingTicketId: null })
    }
  },

  transitionTicket: async (id: string, status: string) => {
    try {
      const resp = await fetch(`${API_BASE}/api/tickets/${id}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!resp.ok) {
        console.error('[ticketStore] transitionTicket failed:', resp.status)
      }
      get().fetchTickets()
      get().fetchStats()
    } catch (err) {
      console.error('[ticketStore] transitionTicket error:', err)
    }
  },

  // WS handlers
  handleNightlyReport: (report) => {
    const { reports } = get()
    // Prepend new report, remove old duplicate for same date
    const filtered = reports.filter(r => r.date !== report.date)
    set({ reports: [report, ...filtered], latestReport: report })
    // Refresh tickets + stats since the nightly run likely changed things
    get().fetchTickets()
    get().fetchStats()
  },

  handleTicketUpdate: (_ticket, _action) => {
    // Refresh on any ticket change
    get().fetchTickets()
    get().fetchStats()
  },
}))
