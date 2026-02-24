// CronJobControls.tsx — Job control strip: Run Now, Pause/Resume, Edit, Delete
// WU-014: Script Tab & Job Controls
//
// Run Now with spinner and lock icon (REQ-37, REQ-38, REQ-40).
// Pause/Resume toggle (REQ-41, REQ-42).
// Edit Frequency inline editor (REQ-43, REQ-44).
// Delete button styled destructive red (REQ-46).
// Lock icon on sudo-requiring buttons.

import React, { useState } from 'react'
import { useCronStore } from '../../stores/cronStore'
import type { CronJob, ClientMessage } from '../../../shared/types'
import { CronScheduleEditor } from './CronScheduleEditor'
import { CronDeleteConfirm } from './CronDeleteConfirm'
import { CronRunNowOutput } from './CronRunNowOutput'

type SendMessage = (message: ClientMessage) => void

interface CronJobControlsProps {
  job: CronJob
  sendMessage: SendMessage
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <span
      className="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin"
      aria-hidden="true"
    />
  )
}

// ── Lock icon ─────────────────────────────────────────────────────────────────

function LockIcon() {
  return <span className="text-xs leading-none" title="Requires sudo">🔒</span>
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CronJobControls({ job, sendMessage }: CronJobControlsProps) {
  const { runningJobs, runOutput } = useCronStore()
  const [editingFrequency, setEditingFrequency] = useState(false)
  const [pendingSchedule, setPendingSchedule] = useState(job.schedule)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  const isRunning = runningJobs.has(job.id)
  const hasOutput = (runOutput[job.id]?.length ?? 0) > 0

  function handleRunNow() {
    sendMessage({ type: 'cron-job-run-now', jobId: job.id })
  }

  function handlePauseResume() {
    if (job.status === 'paused') {
      sendMessage({ type: 'cron-job-resume', jobId: job.id })
    } else {
      sendMessage({ type: 'cron-job-pause', jobId: job.id })
    }
  }

  function handleSaveFrequency() {
    if (pendingSchedule && pendingSchedule !== job.schedule) {
      sendMessage({ type: 'cron-job-edit-frequency', jobId: job.id, schedule: pendingSchedule })
    }
    setEditingFrequency(false)
  }

  function handleDelete() {
    sendMessage({ type: 'cron-job-delete', jobId: job.id })
    setShowDeleteConfirm(false)
  }

  const isSystemd = job.source === 'systemd-user' || job.source === 'systemd-system'
  const scheduleMode: 'cron' | 'systemd' = isSystemd ? 'systemd' : 'cron'

  return (
    <div className="space-y-2">
      {/* Button row */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Run Now */}
        <button
          onClick={handleRunNow}
          disabled={isRunning}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-60 disabled:cursor-not-allowed text-white transition-colors"
        >
          {isRunning ? <Spinner /> : null}
          {isRunning ? 'Running…' : 'Run Now'}
          {job.requiresSudo && <LockIcon />}
        </button>

        {/* Pause / Resume */}
        <button
          onClick={handlePauseResume}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-zinc-600 hover:bg-zinc-500 text-white transition-colors"
        >
          {job.status === 'paused' ? 'Resume' : 'Pause'}
          {job.requiresSudo && <LockIcon />}
        </button>

        {/* Edit Frequency */}
        <button
          onClick={() => {
            setPendingSchedule(job.schedule)
            setEditingFrequency((v) => !v)
          }}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
            editingFrequency
              ? 'bg-zinc-500 text-white'
              : 'bg-zinc-600 hover:bg-zinc-500 text-white'
          }`}
        >
          Edit Frequency
          {job.requiresSudo && <LockIcon />}
        </button>

        {/* Delete */}
        <button
          onClick={() => setShowDeleteConfirm(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded bg-red-700 hover:bg-red-600 text-white transition-colors ml-auto"
        >
          Delete
          {job.requiresSudo && <LockIcon />}
        </button>
      </div>

      {/* Inline schedule editor */}
      {editingFrequency && (
        <div className="bg-zinc-800 border border-zinc-700 rounded p-3 space-y-2">
          <div className="text-xs text-zinc-400 font-medium">Edit Schedule</div>
          <CronScheduleEditor
            value={pendingSchedule}
            onChange={setPendingSchedule}
            mode={scheduleMode}
          />
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleSaveFrequency}
              className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
            >
              Save
            </button>
            <button
              onClick={() => setEditingFrequency(false)}
              className="px-3 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-300 rounded transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Run Now output */}
      {(isRunning || hasOutput) && (
        <CronRunNowOutput jobId={job.id} />
      )}

      {/* Delete confirm dialog */}
      <CronDeleteConfirm
        job={job}
        isOpen={showDeleteConfirm}
        onConfirm={handleDelete}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  )
}
