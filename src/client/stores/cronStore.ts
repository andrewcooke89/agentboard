// WU-008: Frontend Zustand Store

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { CronJob, CronJobDetail } from '@shared/types'

// ─── State Types ─────────────────────────────────────────────────────────────

const DESKTOP_NOTIF_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes per job

interface CronState {
  // Data
  jobs: CronJob[]
  selectedJobId: string | null
  selectedJobDetail: CronJobDetail | null
  loading: boolean
  hasLoaded: boolean
  systemdAvailable: boolean

  // Search / filter / sort
  searchQuery: string
  sortMode: string
  filterMode: string
  filterSource: string | null
  filterTags: string[]

  // UI state
  collapsedGroups: Set<string>
  activeTab: string
  timelineVisible: boolean
  timelineRange: string

  // Bulk selection
  selectedJobIds: Set<string>
  bulkSelectMode: boolean

  // Active runs
  runningJobs: Set<string>

  // Run output accumulator (keyed by jobId)
  runOutputs: Record<string, string>

  // Bulk operation progress
  bulkProgress: { completed: number; total: number; failures: string[] } | null

  // Notification feed
  notifications: Array<{
    id: string
    jobId: string
    event: string
    message: string
    severity: string
    timestamp: number
  }>

  // Desktop notification rate limiting (not persisted)
  desktopNotifTimestamps: Record<string, number>

  // Sudo prompt state
  sudoPromptVisible: boolean
  sudoPromptOperation: string | null
  sudoPromptJobId: string | null
}

interface CronActions {
  // WS handlers
  handleCronJobs: (jobs: CronJob[], systemdAvailable: boolean) => void
  handleCronJobUpdate: (job: CronJob) => void
  handleCronJobRemoved: (jobId: string) => void
  handleCronJobDetail: (detail: CronJobDetail) => void
  handleCronOperationResult: (jobId: string, operation: string, success: boolean, error?: string) => void
  handleCronRunStarted: (jobId: string, runId: string) => void
  handleCronRunOutput: (jobId: string, runId: string, chunk: string) => void
  handleCronRunCompleted: (jobId: string, runId: string, exitCode: number, duration: number) => void
  handleCronBulkProgress: (completed: number, total: number, failures: string[]) => void
  handleCronNotification: (jobId: string, event: string, message: string, severity: string) => void

  // Actions
  setSelectedJob: (id: string | null) => void
  setSearchQuery: (q: string) => void
  setSortMode: (mode: string) => void
  setFilterMode: (mode: string) => void
  setFilterSource: (source: string | null) => void
  setFilterTags: (tags: string[]) => void
  toggleGroupCollapse: (group: string) => void
  setActiveTab: (tab: string) => void
  toggleTimeline: () => void
  setTimelineRange: (range: string) => void
  toggleBulkSelect: (jobId: string) => void
  selectRange: (fromId: string, toId: string) => void
  clearSelection: () => void
  toggleBulkSelectMode: () => void

  // Optimistic updates
  setJobManaged: (jobId: string, managed: boolean) => void
  setJobLinkedSession: (jobId: string, sessionId: string | null) => void

  // Sudo prompt
  showSudoPrompt: (jobId: string, operation: string) => void
  hideSudoPrompt: () => void

  // Derived selectors
  filteredJobs: () => CronJob[]
  groupedJobs: () => Record<string, CronJob[]>
  allTags: () => string[]
  selectedJobs: () => CronJob[]
}

type CronStore = CronState & CronActions

// ─── Health severity ordering (for sort) ────────────────────────────────────

const healthOrder: Record<string, number> = {
  critical: 0,
  warning: 1,
  healthy: 2,
  unknown: 3,
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useCronStore = create<CronStore>()(
  persist(
    (set, get) => ({
      // Initial state
      jobs: [],
      selectedJobId: null,
      selectedJobDetail: null,
      loading: false,
      hasLoaded: false,
      systemdAvailable: false,
      searchQuery: '',
      sortMode: 'name',
      filterMode: 'all',
      filterSource: null,
      filterTags: [],
      collapsedGroups: new Set<string>(),
      activeTab: 'overview',
      timelineVisible: false,
      timelineRange: '24h',
      selectedJobIds: new Set<string>(),
      bulkSelectMode: false,
      runningJobs: new Set<string>(),
      runOutputs: {},
      bulkProgress: null,
      notifications: [],
      desktopNotifTimestamps: {},
      sudoPromptVisible: false,
      sudoPromptOperation: null,
      sudoPromptJobId: null,

      // ── WS Handlers ────────────────────────────────────────────────────────

      handleCronJobs: (jobs, systemdAvailable) => {
        const { selectedJobId } = get()
        const ids = new Set(jobs.map((j) => j.id))
        set({
          jobs,
          systemdAvailable,
          hasLoaded: true,
          loading: false,
          selectedJobId: selectedJobId && ids.has(selectedJobId) ? selectedJobId : null,
          selectedJobDetail: selectedJobId && ids.has(selectedJobId) ? get().selectedJobDetail : null,
        })
      },

      handleCronJobUpdate: (job) => {
        const jobs = get().jobs
        const idx = jobs.findIndex((j) => j.id === job.id)
        if (idx === -1) {
          set({ jobs: [...jobs, job] })
        } else {
          const updated = [...jobs]
          updated[idx] = job
          set({ jobs: updated })
        }
      },

      handleCronJobRemoved: (jobId) => {
        const { selectedJobId, selectedJobIds } = get()
        const jobs = get().jobs.filter((j) => j.id !== jobId)
        const newSelectedJobIds = new Set(selectedJobIds)
        newSelectedJobIds.delete(jobId)
        set({
          jobs,
          selectedJobIds: newSelectedJobIds,
          selectedJobId: selectedJobId === jobId ? null : selectedJobId,
          selectedJobDetail: selectedJobId === jobId ? null : get().selectedJobDetail,
        })
      },

      handleCronJobDetail: (detail) => {
        set({ selectedJobDetail: detail })
      },

      handleCronOperationResult: (jobId, operation, success, error) => {
        if (error) {
          console.warn(`cron-operation-result: ${operation} on ${jobId} failed — ${error}`)
        }
        if (operation === 'create') {
          const prev = get().notifications
          const entry = {
            id: Date.now().toString(36),
            jobId,
            event: 'create',
            message: success ? 'Job created' : (error ?? 'Failed to create job'),
            severity: success ? 'success' : 'error',
            timestamp: Date.now(),
          }
          set({ notifications: [entry, ...prev].slice(0, 50) })
          return
        }
        if (success) {
          if (operation === 'pause') {
            const jobs = get().jobs.map((j) =>
              j.id === jobId ? { ...j, status: 'paused' as const } : j
            )
            set({ jobs })
          } else if (operation === 'resume') {
            const jobs = get().jobs.map((j) =>
              j.id === jobId ? { ...j, status: 'active' as const } : j
            )
            set({ jobs })
          }
        }
      },

      handleCronRunStarted: (jobId, _runId) => {
        const runningJobs = new Set(get().runningJobs)
        runningJobs.add(jobId)
        set({ runningJobs })
      },

      handleCronRunOutput: (jobId, _runId, chunk) => {
        const prev = get().runOutputs[jobId] ?? ''
        set({ runOutputs: { ...get().runOutputs, [jobId]: prev + chunk } })
      },

      handleCronRunCompleted: (jobId, _runId, _exitCode, _duration) => {
        const runningJobs = new Set(get().runningJobs)
        runningJobs.delete(jobId)
        set({ runningJobs })
      },

      handleCronBulkProgress: (completed, total, failures) => {
        set({ bulkProgress: { completed, total, failures } })
      },

      handleCronNotification: (jobId, event, message, severity) => {
        const prev = get().notifications
        const entry = {
          id: Date.now().toString(36),
          jobId,
          event,
          message,
          severity,
          timestamp: Date.now(),
        }
        const next = [entry, ...prev].slice(0, 50)
        set({ notifications: next })

        // Desktop notification with per-job rate limiting (max 1 per 5 min per job)
        try {
          // Dynamically check settings to avoid circular dep
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { useSettingsStore } = require('./settingsStore') as typeof import('./settingsStore')
          const settings = useSettingsStore.getState()
          if (!settings.cronDesktopNotifications) return
          
          // Check which event categories are enabled
          let shouldNotify = false
          if (event === 'first-failure' || event === 'consecutive-failures') {
            shouldNotify = settings.cronNotifyFailure
          } else if (event === 'missed-run') {
            shouldNotify = settings.cronNotifyMissedRun
          } else if (event === 'manual-run-completed') {
            shouldNotify = settings.cronNotifyManualRun
          }
          if (!shouldNotify) return
          if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return

          const now = Date.now()
          const { desktopNotifTimestamps } = get()
          const lastSent = desktopNotifTimestamps[jobId] ?? 0
          if (now - lastSent < DESKTOP_NOTIF_COOLDOWN_MS) return

          const job = get().jobs.find((j) => j.id === jobId)
          const title = job ? `Cron: ${job.name}` : 'Cron Job'
          // eslint-disable-next-line no-new
          new Notification(title, { body: message, tag: `cron-${jobId}` })
          set({
            desktopNotifTimestamps: {
              ...get().desktopNotifTimestamps,
              [jobId]: now,
            },
          })
        } catch (e) {
          console.error('Failed to send desktop notification:', e)
        }
      },

      // ── Actions ────────────────────────────────────────────────────────────

      setSelectedJob: (id) => {
        const { selectedJobId, runOutputs } = get()
        // Clear run output for previous job
        const newRunOutputs = { ...runOutputs }
        if (selectedJobId && selectedJobId !== id) {
          delete newRunOutputs[selectedJobId]
        }
        set({ selectedJobId: id, selectedJobDetail: null, runOutputs: newRunOutputs })
      },

      setSearchQuery: (q) => set({ searchQuery: q }),

      setSortMode: (mode) => set({ sortMode: mode }),

      setFilterMode: (mode) => set({ filterMode: mode }),

      setFilterSource: (source) => set({ filterSource: source }),

      setFilterTags: (tags) => set({ filterTags: tags }),

      toggleGroupCollapse: (group) => {
        const prev = get().collapsedGroups
        const next = new Set(prev)
        if (next.has(group)) {
          next.delete(group)
        } else {
          next.add(group)
        }
        set({ collapsedGroups: next })
      },

      setActiveTab: (tab) => set({ activeTab: tab }),

      toggleTimeline: () => set({ timelineVisible: !get().timelineVisible }),

      setTimelineRange: (range) => set({ timelineRange: range }),

      toggleBulkSelect: (jobId) => {
        const prev = get().selectedJobIds
        const next = new Set(prev)
        if (next.has(jobId)) {
          next.delete(jobId)
        } else {
          next.add(jobId)
        }
        set({ selectedJobIds: next, bulkSelectMode: next.size > 0 })
      },

      selectRange: (fromId, toId) => {
        const jobs = get().filteredJobs()
        const fromIdx = jobs.findIndex((j) => j.id === fromId)
        const toIdx = jobs.findIndex((j) => j.id === toId)
        if (fromIdx === -1 || toIdx === -1) return
        const lo = Math.min(fromIdx, toIdx)
        const hi = Math.max(fromIdx, toIdx)
        const next = new Set(get().selectedJobIds)
        for (let i = lo; i <= hi; i++) {
          next.add(jobs[i].id)
        }
        set({ selectedJobIds: next })
      },

      clearSelection: () => {
        set({ selectedJobIds: new Set<string>(), bulkSelectMode: false, bulkProgress: null })
      },

      toggleBulkSelectMode: () => {
        const { bulkSelectMode } = get()
        if (bulkSelectMode) {
          set({ bulkSelectMode: false, selectedJobIds: new Set<string>() })
        } else {
          set({ bulkSelectMode: true })
        }
      },

      // ── Sudo Prompt ───────────────────────────────────────────────────────

      showSudoPrompt: (jobId, operation) => set({
        sudoPromptVisible: true,
        sudoPromptJobId: jobId,
        sudoPromptOperation: operation,
      }),

      hideSudoPrompt: () => set({
        sudoPromptVisible: false,
        sudoPromptJobId: null,
        sudoPromptOperation: null,
      }),

      // ── Optimistic Updates ─────────────────────────────────────────────────

      setJobManaged: (jobId, managed) => {
        const jobs = get().jobs.map((j) =>
          j.id === jobId ? { ...j, isManagedByAgentboard: managed } : j
        )
        set({ jobs })
      },

      setJobLinkedSession: (jobId, sessionId) => {
        const jobs = get().jobs.map((j) =>
          j.id === jobId ? { ...j, linkedSessionId: sessionId } : j
        )
        set({ jobs })
      },

      // ── Derived Selectors ──────────────────────────────────────────────────

      filteredJobs: () => {
        const { jobs, searchQuery, filterMode, filterSource, filterTags, sortMode } = get()

        let result = jobs

        // Text search across name, command, projectGroup, tags
        if (searchQuery) {
          const q = searchQuery.toLowerCase()
          result = result.filter(
            (j) =>
              j.name.toLowerCase().includes(q) ||
              j.command.toLowerCase().includes(q) ||
              j.projectGroup.toLowerCase().includes(q) ||
              j.tags.some((t) => t.toLowerCase().includes(q))
          )
        }

        // Status / health filter
        if (filterMode !== 'all') {
          result = result.filter((j) => {
            switch (filterMode) {
              case 'active':    return j.status === 'active'
              case 'paused':    return j.status === 'paused'
              case 'errors':    return j.status === 'error'
              case 'unhealthy': return j.health === 'warning' || j.health === 'critical'
              case 'managed':   return j.isManagedByAgentboard
              default:          return true
            }
          })
        }

        // Source filter
        if (filterSource) {
          result = result.filter((j) => j.source === filterSource)
        }

        // Tag filter (AND — job must have ALL specified tags)
        if (filterTags.length > 0) {
          result = result.filter((j) => filterTags.every((t) => j.tags.includes(t)))
        }

        // Sort
        result = [...result].sort((a, b) => {
          switch (sortMode) {
            case 'name':
              return a.name.localeCompare(b.name)
            case 'next-run': {
              if (!a.nextRun && !b.nextRun) return 0
              if (!a.nextRun) return 1
              if (!b.nextRun) return -1
              return new Date(a.nextRun).getTime() - new Date(b.nextRun).getTime()
            }
            case 'last-run': {
              if (!a.lastRun && !b.lastRun) return 0
              if (!a.lastRun) return 1
              if (!b.lastRun) return -1
              return new Date(b.lastRun).getTime() - new Date(a.lastRun).getTime()
            }
            case 'status':
              return a.status.localeCompare(b.status)
            case 'health': {
              const ha = healthOrder[a.health] ?? 99
              const hb = healthOrder[b.health] ?? 99
              return ha - hb
            }
            default:
              return 0
          }
        })

        return result
      },

      groupedJobs: () => {
        const jobs = get().filteredJobs()
        const groups: Record<string, CronJob[]> = {}
        for (const job of jobs) {
          const g = job.projectGroup || 'System'
          if (!groups[g]) groups[g] = []
          groups[g].push(job)
        }
        // Sort keys so "System" is always last
        const sorted: Record<string, CronJob[]> = {}
        const keys = Object.keys(groups).sort((a, b) => {
          if (a === 'System') return 1
          if (b === 'System') return -1
          return a.localeCompare(b)
        })
        for (const k of keys) sorted[k] = groups[k]
        return sorted
      },

      allTags: () => {
        const tags = new Set<string>()
        for (const job of get().jobs) {
          for (const t of job.tags) tags.add(t)
        }
        return [...tags].sort()
      },

      selectedJobs: () => {
        const { jobs, selectedJobIds } = get()
        return jobs.filter((j) => selectedJobIds.has(j.id))
      },
    }),
    {
      name: 'cron-store',
      storage: createJSONStorage(() => localStorage, {
        replacer: (_key, value) => {
          if (value instanceof Set) return { __type: 'Set', values: [...value] }
          return value
        },
        reviver: (_key, value) => {
          if (value && typeof value === 'object' && '__type' in value && (value as { __type: unknown }).__type === 'Set')
            return new Set((value as unknown as { values: unknown[] }).values)
          return value
        },
      }),
      // Only persist UI preferences, not data
      partialize: (state) => ({
        selectedJobId: state.selectedJobId,
        sortMode: state.sortMode,
        filterMode: state.filterMode,
        filterSource: state.filterSource,
        filterTags: state.filterTags,
        collapsedGroups: state.collapsedGroups,
        activeTab: state.activeTab,
        timelineVisible: state.timelineVisible,
        timelineRange: state.timelineRange,
      }),
    }
  )
)
