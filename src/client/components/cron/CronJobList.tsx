// WU-010: List Pane Core — CronJobList

import { useState, useCallback, useEffect, useRef } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import { useCronStore } from '../../stores/cronStore'
import { CronJobRow } from './CronJobRow'
import { CronBulkActions } from './CronBulkActions'

const SORT_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'next-run', label: 'Next Run' },
  { value: 'last-run', label: 'Last Run' },
  { value: 'status', label: 'Status' },
  { value: 'health', label: 'Health' },
]

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'errors', label: 'Errors' },
  { value: 'unhealthy', label: 'Unhealthy' },
]

export function CronJobList() {
  const { setSearchQuery, setSortMode, setFilterMode, toggleGroupCollapse, setSelectedJob,
          sortMode, filterMode, collapsedGroups, selectedJobId, searchQuery, groupedJobs, filteredJobs } = useCronStore()
  const prefersReducedMotion = useReducedMotion()
  const [localSearch, setLocalSearch] = useState(searchQuery)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  const listRef = useRef<HTMLDivElement>(null)

  // Debounced search
  const onSearchChange = useCallback((value: string) => {
    setLocalSearch(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setSearchQuery(value), 150)
  }, [setSearchQuery])

  // Keyboard navigation
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const handler = (e: KeyboardEvent) => {
      const flat = filteredJobs()
      const idx = flat.findIndex(j => j.id === selectedJobId)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const next = Math.min(idx + 1, flat.length - 1)
        if (flat[next]) setSelectedJob(flat[next].id)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const prev = Math.max(idx - 1, 0)
        if (flat[prev]) setSelectedJob(flat[prev].id)
      } else if (e.key === 'Enter' && idx >= 0) {
        setSelectedJob(flat[idx].id)
      }
    }
    list.addEventListener('keydown', handler)
    return () => list.removeEventListener('keydown', handler)
  }, [selectedJobId, filteredJobs, setSelectedJob])

  const groups = groupedJobs()
  const groupNames = Object.keys(groups)

  return (
    <div className="flex flex-col h-full relative">
      {/* Search */}
      <div className="p-2 border-b border-[var(--border)]">
        <input
          type="text"
          placeholder="Search jobs..."
          value={localSearch}
          onChange={e => onSearchChange(e.target.value)}
          className="w-full px-2 py-1 text-sm bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-[var(--fg-primary)] placeholder:text-[var(--fg-muted)]"
        />
      </div>
      {/* Sort + Filter */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-[var(--border)] flex-wrap">
        <select
          value={sortMode}
          onChange={e => setSortMode(e.target.value)}
          className="text-xs bg-[var(--bg-secondary)] border border-[var(--border)] rounded px-1 py-0.5 text-[var(--fg-primary)]"
        >
          {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {FILTER_OPTIONS.map(o => (
          <button
            key={o.value}
            onClick={() => setFilterMode(o.value)}
            className={`text-xs px-2 py-0.5 rounded ${filterMode === o.value ? 'bg-blue-600 text-white' : 'bg-[var(--bg-secondary)] text-[var(--fg-muted)] hover:text-[var(--fg-primary)]'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {/* Job List */}
      <div ref={listRef} className="flex-1 overflow-y-auto" tabIndex={0}>
        {groupNames.map(group => {
          const jobs = groups[group]
          const collapsed = collapsedGroups.has(group)
          return (
            <div key={group}>
              <button
                onClick={() => toggleGroupCollapse(group)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-[var(--fg-muted)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] border-b border-[var(--border)]"
              >
                <span className={`transition-transform ${collapsed ? '' : 'rotate-90'}`}>▶</span>
                <span>{group}</span>
                <span className="ml-auto text-[var(--fg-muted)]">{jobs.length}</span>
              </button>
              {!collapsed && (
                <AnimatePresence initial={false}>
                  {jobs.map(job => (
                    <motion.div
                      key={job.id}
                      initial={prefersReducedMotion ? false : { opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                      transition={{ duration: 0.2 }}
                    >
                      <CronJobRow job={job} />
                    </motion.div>
                  ))}
                </AnimatePresence>
              )}
            </div>
          )
        })}
      </div>
      <CronBulkActions />
    </div>
  )
}

export default CronJobList
