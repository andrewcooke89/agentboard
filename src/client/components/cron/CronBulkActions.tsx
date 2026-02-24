// CronBulkActions.tsx — Floating bulk action bar
// WU-011: Bulk Selection & Actions

import React from 'react'
import { useCronStore } from '../../stores/cronStore'
import type { ClientMessage } from '../../../shared/types'

interface CronBulkActionsProps {
  sendMessage: (msg: ClientMessage) => void
}

export function CronBulkActions({ sendMessage }: CronBulkActionsProps) {
  const selectedJobIds = useCronStore((s) => s.selectedJobIds)
  const clearSelection = useCronStore((s) => s.clearSelection)
  const bulkProgress = useCronStore((s) => s.bulkProgress)
  const getSelectedJobs = useCronStore((s) => s.getSelectedJobs)

  if (selectedJobIds.length === 0) return null

  const handlePauseAll = () => {
    sendMessage({ type: 'cron-bulk-pause', jobIds: selectedJobIds })
  }

  const handleResumeAll = () => {
    sendMessage({ type: 'cron-bulk-resume', jobIds: selectedJobIds })
  }

  const handleDeleteAll = () => {
    const selectedJobs = getSelectedJobs()
    const names = selectedJobs.map((j) => j.name).join(', ')
    const confirmed = window.confirm(
      `Delete ${selectedJobIds.length} job${selectedJobIds.length === 1 ? '' : 's'}?\n\n${names}\n\nThis cannot be undone.`
    )
    if (confirmed) {
      sendMessage({ type: 'cron-bulk-delete', jobIds: selectedJobIds })
      clearSelection()
    }
  }

  const progressPct = bulkProgress
    ? Math.round((bulkProgress.completed / bulkProgress.total) * 100)
    : null

  return (
    <div className="sticky bottom-0 z-10 border-t border-zinc-700 bg-zinc-900/95 backdrop-blur-sm px-3 py-2">
      {/* Progress bar */}
      {bulkProgress && (
        <div className="mb-2">
          <div className="flex justify-between text-xs text-zinc-500 mb-1">
            <span>Processing…</span>
            <span>{bulkProgress.completed}/{bulkProgress.total}</span>
          </div>
          <div className="h-1 bg-zinc-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-300"
              style={{ width: `${progressPct ?? 0}%` }}
            />
          </div>
          {bulkProgress.failures.length > 0 && (
            <p className="text-xs text-red-400 mt-1">
              {bulkProgress.failures.length} failure{bulkProgress.failures.length === 1 ? '' : 's'}
            </p>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-400 shrink-0">
          {selectedJobIds.length} selected
        </span>
        <div className="flex-1" />
        <button
          onClick={handlePauseAll}
          className="px-2.5 py-1 text-xs bg-yellow-600 hover:bg-yellow-500 text-white rounded transition-colors"
        >
          Pause All
        </button>
        <button
          onClick={handleResumeAll}
          className="px-2.5 py-1 text-xs bg-green-600 hover:bg-green-500 text-white rounded transition-colors"
        >
          Resume All
        </button>
        <button
          onClick={handleDeleteAll}
          className="px-2.5 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
        >
          Delete All
        </button>
        <button
          onClick={clearSelection}
          className="px-2.5 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded transition-colors"
        >
          Deselect
        </button>
      </div>
    </div>
  )
}
