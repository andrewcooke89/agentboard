// cronStore.ts — Frontend Zustand store for Cron Manager
// WU-008: Frontend Zustand Store
//
// Manages all cron manager client-side state including jobs, selection,
// filters, UI state, and WS message handling.

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { safeStorage } from '../utils/storage'
import type {
  CronJob,
  CronJobDetail,
  ServerMessage,
  BulkProgress,
} from '../../shared/types'

// ── Types ────────────────────────────────────────────────────────────────────

export type CronSortMode = 'name' | 'next-run' | 'last-run' | 'status' | 'health'
export type CronFilterMode = 'all' | 'active' | 'paused' | 'errors' | 'unhealthy' | 'managed'
export type CronFilterSource = 'all' | 'user-crontab' | 'system-crontab' | 'systemd-user' | 'systemd-system'
export type CronDetailTab = 'overview' | 'history' | 'logs' | 'script'
export type TimelineRange = '24h' | '7d'

export interface CronJobGroup {
  name: string
  jobs: CronJob[]
  collapsed?: boolean
}

// ── Notification ─────────────────────────────────────────────────────────────

export interface CronNotification {
  id: string
  message: string
  jobId?: string
  type: string
  timestamp: number
}

// ── State Interface ──────────────────────────────────────────────────────────

interface CronState {
  // Data (from server)
  jobs: CronJob[]
  selectedJobDetail: CronJobDetail | null
  systemdAvailable: boolean
  runningJobs: Set<string>
  runOutput: Record<string, string[]>
  bulkProgress: BulkProgress | null
  notifications: CronNotification[]

  // Selection
  selectedJobId: string | null
  selectedJobIds: string[]
  bulkSelectMode: boolean

  // Filters & sort
  searchQuery: string
  sortMode: CronSortMode
  filterMode: CronFilterMode
  filterSource: CronFilterSource
  filterTags: string[]
  collapsedGroups: string[]

  // UI state
  activeTab: CronDetailTab
  timelineVisible: boolean
  timelineRange: TimelineRange

  // Setters
  setJobs: (jobs: CronJob[]) => void
  setSelectedJobId: (id: string | null) => void
  setSelectedJobDetail: (detail: CronJobDetail | null) => void
  setSystemdAvailable: (available: boolean) => void
  setSearchQuery: (query: string) => void
  setSortMode: (mode: CronSortMode) => void
  setFilterMode: (mode: CronFilterMode) => void
  setFilterSource: (source: CronFilterSource) => void
  setFilterTags: (tags: string[]) => void
  toggleCollapsedGroup: (group: string) => void
  setActiveTab: (tab: CronDetailTab) => void
  setTimelineVisible: (visible: boolean) => void
  setTimelineRange: (range: TimelineRange) => void
  setBulkSelectMode: (mode: boolean) => void
  toggleJobSelection: (jobId: string) => void
  selectJobRange: (fromId: string, toId: string) => void
  clearSelection: () => void
  addRunningJob: (jobId: string) => void
  removeRunningJob: (jobId: string) => void

  // WS message handlers
  handleServerMessage: (message: ServerMessage) => void

  // Derived (computed via get())
  getFilteredJobs: () => CronJob[]
  getGroupedJobs: () => CronJobGroup[]
  getAllTags: () => string[]
  getSelectedJobs: () => CronJob[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const HEALTH_ORDER: Record<string, number> = { critical: 0, warning: 1, unknown: 2, healthy: 3 }
const STATUS_ORDER: Record<string, number> = { error: 0, active: 1, paused: 2 }

function sortJobs(jobs: CronJob[], sortMode: CronSortMode): CronJob[] {
  const sorted = [...jobs]
  switch (sortMode) {
    case 'name':
      sorted.sort((a, b) => a.name.localeCompare(b.name))
      break
    case 'next-run':
      sorted.sort((a, b) => {
        if (!a.nextRun && !b.nextRun) return 0
        if (!a.nextRun) return 1
        if (!b.nextRun) return -1
        return new Date(a.nextRun).getTime() - new Date(b.nextRun).getTime()
      })
      break
    case 'last-run':
      sorted.sort((a, b) => {
        if (!a.lastRun && !b.lastRun) return 0
        if (!a.lastRun) return 1
        if (!b.lastRun) return -1
        // Most recent first
        return new Date(b.lastRun).getTime() - new Date(a.lastRun).getTime()
      })
      break
    case 'status':
      sorted.sort((a, b) => (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99))
      break
    case 'health':
      sorted.sort((a, b) => (HEALTH_ORDER[a.health] ?? 99) - (HEALTH_ORDER[b.health] ?? 99))
      break
  }
  return sorted
}

// ── Store ────────────────────────────────────────────────────────────────────

export const useCronStore = create<CronState>()(
  persist(
    (set, get) => ({
      // Data
      jobs: [],
      selectedJobDetail: null,
      systemdAvailable: false,
      runningJobs: new Set(),
      runOutput: {},
      bulkProgress: null,
      notifications: [],

      // Selection
      selectedJobId: null,
      selectedJobIds: [],
      bulkSelectMode: false,

      // Filters & sort
      searchQuery: '',
      sortMode: 'name' as CronSortMode,
      filterMode: 'all' as CronFilterMode,
      filterSource: 'all' as CronFilterSource,
      filterTags: [],
      collapsedGroups: [],

      // UI state
      activeTab: 'overview' as CronDetailTab,
      timelineVisible: false,
      timelineRange: '24h' as TimelineRange,

      // ── Setters ──────────────────────────────────────────────────────────

      setJobs: (jobs) => set({ jobs }),

      setSelectedJobId: (id) => set({ selectedJobId: id }),

      setSelectedJobDetail: (detail) => set({ selectedJobDetail: detail }),

      setSystemdAvailable: (available) => set({ systemdAvailable: available }),

      setSearchQuery: (query) => set({ searchQuery: query }),

      setSortMode: (mode) => set({ sortMode: mode }),

      setFilterMode: (mode) => set({ filterMode: mode }),

      setFilterSource: (source) => set({ filterSource: source }),

      setFilterTags: (tags) => set({ filterTags: tags }),

      toggleCollapsedGroup: (group) =>
        set((state) => ({
          collapsedGroups: state.collapsedGroups.includes(group)
            ? state.collapsedGroups.filter((g) => g !== group)
            : [...state.collapsedGroups, group],
        })),

      setActiveTab: (tab) => set({ activeTab: tab }),

      setTimelineVisible: (visible) => set({ timelineVisible: visible }),

      setTimelineRange: (range) => set({ timelineRange: range }),

      setBulkSelectMode: (mode) =>
        set({ bulkSelectMode: mode, selectedJobIds: mode ? get().selectedJobIds : [] }),

      toggleJobSelection: (jobId) =>
        set((state) => ({
          selectedJobIds: state.selectedJobIds.includes(jobId)
            ? state.selectedJobIds.filter((id) => id !== jobId)
            : [...state.selectedJobIds, jobId],
        })),

      selectJobRange: (fromId, toId) => {
        const filteredJobs = get().getFilteredJobs()
        const fromIdx = filteredJobs.findIndex((j) => j.id === fromId)
        const toIdx = filteredJobs.findIndex((j) => j.id === toId)
        if (fromIdx === -1 || toIdx === -1) return

        const start = Math.min(fromIdx, toIdx)
        const end = Math.max(fromIdx, toIdx)
        const rangeIds = filteredJobs.slice(start, end + 1).map((j) => j.id)

        set((state) => {
          // Merge with existing selection (union)
          const existing = new Set(state.selectedJobIds)
          rangeIds.forEach((id) => existing.add(id))
          return { selectedJobIds: Array.from(existing) }
        })
      },

      clearSelection: () => set({ selectedJobIds: [], bulkSelectMode: false }),

      addRunningJob: (jobId) =>
        set((state) => {
          const next = new Set(state.runningJobs)
          next.add(jobId)
          return { runningJobs: next }
        }),

      removeRunningJob: (jobId) =>
        set((state) => {
          const next = new Set(state.runningJobs)
          next.delete(jobId)
          return { runningJobs: next }
        }),

      // ── WS message handler (REQ-09) ─────────────────────────────────────

      handleServerMessage: (message) => {
        switch (message.type) {
          case 'cron-jobs': {
            set({ jobs: message.jobs })
            break
          }

          case 'cron-job-update': {
            set((state) => {
              const idx = state.jobs.findIndex((j) => j.id === message.job.id)
              if (idx === -1) {
                return { jobs: [...state.jobs, message.job] }
              }
              const next = [...state.jobs]
              next[idx] = message.job
              return { jobs: next }
            })
            break
          }

          case 'cron-job-removed': {
            set((state) => {
              const next = state.jobs.filter((j) => j.id !== message.jobId)
              const nextSelectedIds = state.selectedJobIds.filter((id) => id !== message.jobId)
              const nextSelectedId =
                state.selectedJobId === message.jobId ? null : state.selectedJobId
              return {
                jobs: next,
                selectedJobIds: nextSelectedIds,
                selectedJobId: nextSelectedId,
              }
            })
            break
          }

          case 'cron-job-detail': {
            set({ selectedJobDetail: message.job })
            break
          }

          case 'cron-operation-result': {
            if (message.ok) {
              // Remove from running jobs if it was there (manual run may have finished)
              set((state) => {
                const next = new Set(state.runningJobs)
                next.delete(message.jobId)
                return { runningJobs: next }
              })
            }
            break
          }

          case 'cron-run-started': {
            set((state) => {
              const next = new Set(state.runningJobs)
              next.add(message.jobId)
              return { runningJobs: next }
            })
            break
          }

          case 'cron-run-output': {
            set((state) => {
              const existing = state.runOutput[message.jobId] ?? []
              return {
                runOutput: {
                  ...state.runOutput,
                  [message.jobId]: [...existing, message.data],
                },
              }
            })
            break
          }

          case 'cron-run-completed': {
            set((state) => {
              const next = new Set(state.runningJobs)
              next.delete(message.jobId)
              return { runningJobs: next }
            })
            break
          }

          case 'cron-bulk-operation-progress': {
            set({ bulkProgress: message.progress })
            break
          }

          case 'cron-notification': {
            set((state) => {
              const notification: CronNotification = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                message: message.message,
                jobId: message.jobId,
                type: message.level,
                timestamp: Date.now(),
              }
              // Keep last 50 notifications
              const next = [notification, ...state.notifications].slice(0, 50)
              return { notifications: next }
            })
            break
          }

          default:
            break
        }
      },

      // ── Derived selectors ────────────────────────────────────────────────

      getFilteredJobs: () => {
        const { jobs, searchQuery, filterMode, filterSource, filterTags, sortMode } = get()

        let filtered = jobs

        // Search filter: name, command, projectGroup, tags (case-insensitive)
        if (searchQuery.trim()) {
          const q = searchQuery.trim().toLowerCase()
          filtered = filtered.filter(
            (j) =>
              j.name.toLowerCase().includes(q) ||
              j.command.toLowerCase().includes(q) ||
              (j.projectGroup ?? '').toLowerCase().includes(q) ||
              j.tags.some((t) => t.toLowerCase().includes(q)),
          )
        }

        // Filter mode
        switch (filterMode) {
          case 'active':
            filtered = filtered.filter((j) => j.status === 'active')
            break
          case 'paused':
            filtered = filtered.filter((j) => j.status === 'paused')
            break
          case 'errors':
            filtered = filtered.filter((j) => j.status === 'error')
            break
          case 'unhealthy':
            filtered = filtered.filter(
              (j) => j.health === 'warning' || j.health === 'critical',
            )
            break
          case 'managed':
            filtered = filtered.filter((j) => j.isManagedByAgentboard)
            break
          case 'all':
          default:
            break
        }

        // Filter source
        if (filterSource !== 'all') {
          filtered = filtered.filter((j) => j.source === filterSource)
        }

        // Filter tags (OR logic: job must have at least one of the filter tags)
        if (filterTags.length > 0) {
          filtered = filtered.filter((j) => filterTags.some((t) => j.tags.includes(t)))
        }

        // Sort
        return sortJobs(filtered, sortMode)
      },

      getGroupedJobs: () => {
        const { collapsedGroups } = get()
        const filteredJobs = get().getFilteredJobs()

        // Build groups map
        const groupMap = new Map<string, CronJob[]>()
        for (const job of filteredJobs) {
          const group = job.projectGroup ?? 'System'
          if (!groupMap.has(group)) {
            groupMap.set(group, [])
          }
          groupMap.get(group)!.push(job)
        }

        // Sort groups alphabetically, 'System' last
        const groupNames = Array.from(groupMap.keys()).sort((a, b) => {
          if (a === 'System' && b !== 'System') return 1
          if (b === 'System' && a !== 'System') return -1
          return a.localeCompare(b)
        })

        return groupNames.map((name) => ({
          name,
          jobs: groupMap.get(name)!,
          collapsed: collapsedGroups.includes(name),
        }))
      },

      getAllTags: () => {
        const { jobs } = get()
        const tagSet = new Set<string>()
        for (const job of jobs) {
          for (const tag of job.tags) {
            tagSet.add(tag)
          }
        }
        return Array.from(tagSet).sort()
      },

      getSelectedJobs: () => {
        const { jobs, selectedJobIds } = get()
        return jobs.filter((j) => selectedJobIds.includes(j.id))
      },
    }),
    {
      name: 'agentboard-cron',
      storage: createJSONStorage(() => safeStorage),
      version: 1,
      partialize: (state) => ({
        // REQ-89: Persist UI preferences only
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
    },
  ),
)
