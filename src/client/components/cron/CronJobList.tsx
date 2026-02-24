// CronJobList.tsx — Grouped list with keyboard nav and bulk selection
// WU-010: List Pane Core

import React, { useEffect, useRef } from 'react'
import { useCronStore } from '../../stores/cronStore'
import type { ClientMessage } from '../../../shared/types'
import { CronJobRow } from './CronJobRow'
import { CronBulkActions } from './CronBulkActions'

interface CronJobListProps {
  onCreateJob: () => void
  sendMessage: (msg: ClientMessage) => void
}

export function CronJobList({ onCreateJob, sendMessage }: CronJobListProps) {
  const groupedJobs = useCronStore((s) => s.getGroupedJobs())
  const filteredJobs = useCronStore((s) => s.getFilteredJobs())
  const selectedJobId = useCronStore((s) => s.selectedJobId)
  const selectedJobIds = useCronStore((s) => s.selectedJobIds)
  const bulkSelectMode = useCronStore((s) => s.bulkSelectMode)
  const setSelectedJobId = useCronStore((s) => s.setSelectedJobId)
  const toggleCollapsedGroup = useCronStore((s) => s.toggleCollapsedGroup)
  const toggleJobSelection = useCronStore((s) => s.toggleJobSelection)
  const selectJobRange = useCronStore((s) => s.selectJobRange)

  const listRef = useRef<HTMLDivElement>(null)
  const lastSelectedRef = useRef<string | null>(selectedJobId)

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle when list area is focused or no input focused
      const active = document.activeElement
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) return

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const jobs = useCronStore.getState().getFilteredJobs()
        if (jobs.length === 0) return
        const currentIdx = jobs.findIndex((j) => j.id === useCronStore.getState().selectedJobId)
        const delta = e.key === 'ArrowDown' ? 1 : -1
        const nextIdx = currentIdx === -1 ? 0 : Math.max(0, Math.min(jobs.length - 1, currentIdx + delta))
        const nextJob = jobs[nextIdx]
        if (nextJob) {
          setSelectedJobId(nextJob.id)
          lastSelectedRef.current = nextJob.id
        }
      }

      if (e.key === 'Enter') {
        const jobId = useCronStore.getState().selectedJobId
        if (jobId) {
          sendMessage({ type: 'cron-job-select', jobId })
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setSelectedJobId, sendMessage])

  const handleSelect = (jobId: string) => {
    setSelectedJobId(jobId)
    lastSelectedRef.current = jobId
  }

  const handleShiftClick = (jobId: string) => {
    if (lastSelectedRef.current) {
      selectJobRange(lastSelectedRef.current, jobId)
    } else {
      toggleJobSelection(jobId)
    }
  }

  if (filteredJobs.length === 0) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center px-4">
            <p className="text-zinc-500 text-sm mb-3">No jobs found</p>
            <button
              onClick={onCreateJob}
              className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
            >
              Create Job
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div ref={listRef} className="flex flex-col h-full relative">
      {/* Job groups */}
      <div className="flex-1 overflow-y-auto">
        {groupedJobs.map((group) => {
          const hasCritical = group.jobs.some((j) => j.health === 'critical')
          return (
            <div key={group.name}>
              {/* Group header */}
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-700/40 transition-colors border-b border-zinc-800 bg-zinc-800/60"
                onClick={() => toggleCollapsedGroup(group.name)}
                aria-expanded={!group.collapsed}
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  className={`shrink-0 text-zinc-500 transition-transform ${group.collapsed ? '-rotate-90' : ''}`}
                  fill="currentColor"
                >
                  <path d="M0 2.5L5 7.5L10 2.5H0Z" />
                </svg>
                <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide flex-1 truncate">
                  {group.name}
                </span>
                <span className="text-xs text-zinc-600">{group.jobs.length}</span>
                {hasCritical && (
                  <span
                    className="w-2 h-2 rounded-full bg-red-500 shrink-0"
                    aria-label="Has critical jobs"
                    title="Group has critical jobs"
                  />
                )}
              </button>

              {/* Group jobs */}
              {!group.collapsed &&
                group.jobs.map((job) => (
                  <CronJobRow
                    key={job.id}
                    job={job}
                    isSelected={selectedJobId === job.id}
                    isBulkSelected={selectedJobIds.includes(job.id)}
                    bulkMode={bulkSelectMode}
                    onSelect={handleSelect}
                    onBulkToggle={toggleJobSelection}
                    onShiftClick={handleShiftClick}
                    sendMessage={sendMessage}
                  />
                ))}
            </div>
          )
        })}
      </div>

      {/* Bulk actions bar */}
      <CronBulkActions sendMessage={sendMessage} />
    </div>
  )
}
