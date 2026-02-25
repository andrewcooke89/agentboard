// WU-016: Bulk Operations — CronBulkActions

import { useState } from 'react'
import { useCronStore } from '../../stores/cronStore'
import { useWebSocket } from '../../hooks/useWebSocket'

export function CronBulkActions() {
  const { selectedJobIds, selectedJobs, clearSelection, bulkProgress } = useCronStore()
  const { sendMessage } = useWebSocket()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const count = selectedJobIds.size
  if (count === 0) return null

  const jobs = selectedJobs()
  const ids = [...selectedJobIds]

  const handlePauseAll = () => {
    sendMessage({ type: 'cron-bulk-pause', jobIds: ids })
  }

  const handleResumeAll = () => {
    sendMessage({ type: 'cron-bulk-resume', jobIds: ids })
  }

  const handleDeleteAll = () => {
    setShowDeleteConfirm(true)
  }

  const confirmDelete = () => {
    sendMessage({ type: 'cron-bulk-delete', jobIds: ids })
    setShowDeleteConfirm(false)
    clearSelection()
  }

  return (
    <>
      <div className="absolute bottom-0 left-0 right-0 bg-[var(--bg-elevated)] border-t border-[var(--border)] px-4 py-2 flex items-center gap-3 z-20 shadow-lg">
        <span className="text-sm text-[var(--text-primary)] font-medium">{count} selected</span>
        <button
          className="text-xs px-3 py-1 rounded bg-yellow-600 text-white hover:bg-yellow-700"
          onClick={handlePauseAll}
        >
          Pause All
        </button>
        <button
          className="text-xs px-3 py-1 rounded bg-green-600 text-white hover:bg-green-700"
          onClick={handleResumeAll}
        >
          Resume All
        </button>
        <button
          className="text-xs px-3 py-1 rounded bg-red-600 text-white hover:bg-red-700"
          onClick={handleDeleteAll}
        >
          Delete All
        </button>
        <button
          className="text-xs px-3 py-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          onClick={clearSelection}
        >
          Deselect
        </button>
        {bulkProgress && (
          <div className="flex-1 flex items-center gap-2">
            <div className="flex-1 h-1.5 bg-[var(--bg-surface)] rounded overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all"
                style={{ width: `${(bulkProgress.completed / bulkProgress.total) * 100}%` }}
              />
            </div>
            <span className="text-xs text-[var(--text-muted)]">
              {bulkProgress.completed}/{bulkProgress.total}
            </span>
          </div>
        )}
      </div>

      {showDeleteConfirm && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50">
          <div className="bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg p-4 shadow-xl max-w-sm w-full mx-4">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">
              Delete {count} job{count !== 1 ? 's' : ''}?
            </h3>
            <div className="max-h-32 overflow-y-auto mb-3">
              {jobs.map((j) => (
                <div key={j.id} className="text-xs text-[var(--text-muted)] truncate py-0.5">
                  {j.name}
                </div>
              ))}
            </div>
            <p className="text-xs text-[var(--text-muted)] mb-3">This action cannot be undone.</p>
            <div className="flex justify-end gap-2">
              <button
                className="text-xs px-3 py-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                onClick={() => setShowDeleteConfirm(false)}
              >
                Cancel
              </button>
              <button
                className="text-xs px-3 py-1 rounded bg-red-600 text-white hover:bg-red-700"
                onClick={confirmDelete}
              >
                Delete All
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default CronBulkActions
