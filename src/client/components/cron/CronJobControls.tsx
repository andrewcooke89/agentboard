// WU-014: Script Tab & Job Controls — CronJobControls

import React, { useState } from 'react'
import { useCronStore } from '../../stores/cronStore'
import { CronScheduleEditor } from './CronScheduleEditor'

// ─── CronJobControls ──────────────────────────────────────────────────────────

function LockIcon(): React.ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-yellow-500 shrink-0"
      aria-label="Requires sudo"
    >
      <title>Requires sudo</title>
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}

function send(msg: unknown) {
  const wsSend = (window as unknown as Record<string, unknown>).__cronWsSend as
    | ((m: unknown) => void)
    | undefined
  wsSend?.(msg)
}

interface CronJobControlsProps {
  onDelete?: () => void
}

export function CronJobControls({ onDelete }: CronJobControlsProps): React.ReactElement | null {
  const { selectedJobId, jobs, runningJobs } = useCronStore()
  const job = jobs.find((j) => j.id === selectedJobId)

  const [editingFrequency, setEditingFrequency] = useState(false)

  if (!job) return null

  const isRunning = runningJobs.has(job.id)
  const isPaused = job.status === 'paused'

  function handleRunNow() {
    send({ type: 'cron-job-run-now', jobId: job!.id })
  }

  function handlePauseResume() {
    if (isPaused) {
      send({ type: 'cron-job-resume', jobId: job!.id })
    } else {
      send({ type: 'cron-job-pause', jobId: job!.id })
    }
  }

  function handleSaveFrequency(newSchedule: string) {
    send({ type: 'cron-job-edit-frequency', jobId: job!.id, newSchedule })
    setEditingFrequency(false)
  }

  return (
    <div className="border-t border-[var(--border)] shrink-0">
      <div className="flex items-center gap-2 px-4 py-2">
        {/* Run Now */}
        <button
          onClick={handleRunNow}
          disabled={isRunning}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-[var(--accent)] text-white disabled:opacity-50 hover:opacity-90 shrink-0"
        >
          {isRunning ? (
            <>
              <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
              Running…
            </>
          ) : (
            <>
              {job.requiresSudo && <LockIcon />}
              Run Now
            </>
          )}
        </button>

        {/* Pause / Resume */}
        <button
          onClick={handlePauseResume}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded hover:bg-white/10 shrink-0"
        >
          {job.requiresSudo && <LockIcon />}
          {isPaused ? 'Resume' : 'Pause'}
        </button>

        {/* Edit Frequency */}
        <button
          onClick={() => setEditingFrequency((v) => !v)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded hover:bg-white/10 shrink-0 ${
            editingFrequency ? 'bg-white/10' : ''
          }`}
        >
          {job.requiresSudo && <LockIcon />}
          Edit Frequency
        </button>

        {/* Delete */}
        <button
          onClick={onDelete}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded text-red-500 hover:bg-red-500/10 ml-auto shrink-0"
        >
          {job.requiresSudo && <LockIcon />}
          Delete
        </button>
      </div>

      {/* Inline schedule editor */}
      {editingFrequency && (
        <div className="px-4 pb-3">
          <CronScheduleEditor
            schedule={job.schedule}
            onSave={handleSaveFrequency}
            onCancel={() => setEditingFrequency(false)}
          />
        </div>
      )}
    </div>
  )
}

export default CronJobControls
