// CronManager.tsx — Master-detail shell for the Cron Manager view
// WU-009: App Integration & CronManager Shell

import React, { useState, useCallback, useRef, useEffect } from 'react'
import { useCronStore } from '../../stores/cronStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { ClientMessage } from '../../../shared/types'
import type { CronSortMode, CronFilterMode, CronFilterSource } from '../../stores/cronStore'
import { CronJobList } from './CronJobList'
import { CronJobDetail } from './CronJobDetail'
import { CronTimeline } from './CronTimeline'
import { CronCreateModal } from './CronCreateModal'
import { CronEmptyState } from './CronEmptyState'

interface CronManagerProps {
  sendMessage: (msg: ClientMessage) => void
  onNavigateToSession?: (sessionId: string) => void
}

const SORT_OPTIONS: { value: CronSortMode; label: string }[] = [
  { value: 'name',     label: 'Name' },
  { value: 'next-run', label: 'Next Run' },
  { value: 'last-run', label: 'Last Run' },
  { value: 'status',   label: 'Status' },
  { value: 'health',   label: 'Health' },
]

const FILTER_OPTIONS: { value: CronFilterMode; label: string }[] = [
  { value: 'all',       label: 'All Jobs' },
  { value: 'active',    label: 'Active' },
  { value: 'paused',    label: 'Paused' },
  { value: 'errors',    label: 'Errors' },
  { value: 'unhealthy', label: 'Unhealthy' },
  { value: 'managed',   label: 'Managed' },
]

const SOURCE_OPTIONS: { value: CronFilterSource; label: string }[] = [
  { value: 'all',            label: 'All Sources' },
  { value: 'user-crontab',   label: 'User Crontab' },
  { value: 'system-crontab', label: 'System Crontab' },
  { value: 'systemd-user',   label: 'Systemd User' },
  { value: 'systemd-system', label: 'Systemd System' },
]

const CRON_LIST_MIN = 180
const CRON_LIST_MAX = 500

export function CronManager({ sendMessage, onNavigateToSession }: CronManagerProps) {
  const cronListWidth = useSettingsStore((s) => s.cronListWidth)
  const setCronListWidth = useSettingsStore((s) => s.setCronListWidth)

  const searchQuery = useCronStore((s) => s.searchQuery)
  const sortMode = useCronStore((s) => s.sortMode)
  const filterMode = useCronStore((s) => s.filterMode)
  const filterSource = useCronStore((s) => s.filterSource)
  const timelineVisible = useCronStore((s) => s.timelineVisible)
  const selectedJobId = useCronStore((s) => s.selectedJobId)
  const systemdAvailable = useCronStore((s) => s.systemdAvailable)
  const jobs = useCronStore((s) => s.jobs)
  const setSelectedJobId = useCronStore((s) => s.setSelectedJobId)
  const setSearchQuery = useCronStore((s) => s.setSearchQuery)
  const setSortMode = useCronStore((s) => s.setSortMode)
  const setFilterMode = useCronStore((s) => s.setFilterMode)
  const setFilterSource = useCronStore((s) => s.setFilterSource)
  const setTimelineVisible = useCronStore((s) => s.setTimelineVisible)

  const [listWidth, setListWidth] = useState(cronListWidth)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const isResizing = useRef(false)

  // Sync listWidth from settings on mount
  useEffect(() => {
    setListWidth(cronListWidth)
  }, [cronListWidth])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return
      const container = document.getElementById('cron-manager-container')
      const containerLeft = container?.getBoundingClientRect().left ?? 0
      const newWidth = Math.max(CRON_LIST_MIN, Math.min(CRON_LIST_MAX, e.clientX - containerLeft))
      setListWidth(newWidth)
    }
    const handleMouseUp = () => {
      if (isResizing.current) {
        isResizing.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        setCronListWidth(listWidth)
      }
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [listWidth, setCronListWidth])

  return (
    <div id="cron-manager-container" className="flex flex-col h-full bg-[var(--bg-primary)] overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-700 shrink-0 bg-[var(--bg-secondary)] flex-wrap">
        {/* Search */}
        <div className="flex items-center gap-1.5 flex-1 min-w-[140px]">
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-zinc-500 shrink-0"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Search jobs…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 bg-transparent text-sm text-zinc-200 placeholder-zinc-600 outline-none min-w-0"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="text-zinc-500 hover:text-zinc-300 text-xs leading-none"
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>

        {/* Sort */}
        <select
          value={sortMode}
          onChange={(e) => setSortMode(e.target.value as CronSortMode)}
          className="text-xs bg-zinc-800 border border-zinc-700 text-zinc-300 rounded px-2 py-1 outline-none hover:border-zinc-600 cursor-pointer"
          aria-label="Sort by"
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* Filter */}
        <select
          value={filterMode}
          onChange={(e) => setFilterMode(e.target.value as CronFilterMode)}
          className="text-xs bg-zinc-800 border border-zinc-700 text-zinc-300 rounded px-2 py-1 outline-none hover:border-zinc-600 cursor-pointer"
          aria-label="Filter by status"
        >
          {FILTER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* Source filter */}
        <select
          value={filterSource}
          onChange={(e) => setFilterSource(e.target.value as CronFilterSource)}
          className="text-xs bg-zinc-800 border border-zinc-700 text-zinc-300 rounded px-2 py-1 outline-none hover:border-zinc-600 cursor-pointer"
          aria-label="Filter by source"
        >
          {SOURCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* Timeline toggle */}
        <button
          onClick={() => setTimelineVisible(!timelineVisible)}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded border transition-colors ${
            timelineVisible
              ? 'border-blue-500/50 bg-blue-500/10 text-blue-400'
              : 'border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-300'
          }`}
          aria-label="Toggle timeline"
          title="Toggle timeline"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="12" x2="21" y2="12" />
            <polyline points="8,8 3,12 8,16" />
            <polyline points="16,8 21,12 16,16" />
          </svg>
          Timeline
        </button>

        {/* Create job */}
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
          aria-label="Create new cron job"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Create Job
        </button>
      </div>

      {/* Timeline (optional) */}
      {timelineVisible && (
        <div className="border-b border-zinc-700 shrink-0">
          <CronTimeline
            jobs={jobs}
            onSelectJob={(id) => {
              setSelectedJobId(id)
              sendMessage({ type: 'cron-job-select', jobId: id })
            }}
          />
        </div>
      )}

      {/* Master-detail split */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* List pane */}
        <div
          className="flex-shrink-0 border-r border-zinc-700 overflow-hidden flex flex-col"
          style={{ width: listWidth }}
        >
          <CronJobList
            onCreateJob={() => setShowCreateModal(true)}
            sendMessage={sendMessage}
          />
        </div>

        {/* Resize handle */}
        <div
          className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-blue-500/40 active:bg-blue-500/60 transition-colors"
          onMouseDown={handleResizeStart}
          role="separator"
          aria-label="Resize list pane"
        />

        {/* Detail pane */}
        <div className="flex-1 min-w-0 overflow-hidden">
          {selectedJobId ? (
            <CronJobDetail
              sendMessage={sendMessage}
              onNavigateToSession={onNavigateToSession}
            />
          ) : (
            <CronEmptyState onCreateJob={() => setShowCreateModal(true)} />
          )}
        </div>
      </div>

      {/* Create modal */}
      {showCreateModal && (
        <CronCreateModal
          isOpen={showCreateModal}
          sendMessage={sendMessage}
          onClose={() => setShowCreateModal(false)}
          systemdAvailable={systemdAvailable}
        />
      )}
    </div>
  )
}
