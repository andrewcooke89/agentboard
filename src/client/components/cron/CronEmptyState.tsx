// CronEmptyState.tsx — Shown when no job is selected; displays summary counts
// WU-009: App Integration & CronManager Shell

import React from 'react'
import { useCronStore } from '../../stores/cronStore'

interface CronEmptyStateProps {
  onCreateJob: () => void
}

export function CronEmptyState({ onCreateJob }: CronEmptyStateProps) {
  const jobs = useCronStore((s) => s.jobs)

  const total = jobs.length
  const active = jobs.filter((j) => j.status === 'active').length
  const paused = jobs.filter((j) => j.status === 'paused').length
  const errors = jobs.filter((j) => j.status === 'error').length

  return (
    <div className="flex flex-col items-center justify-center h-full gap-5 text-zinc-400 px-8">
      {/* Clock icon */}
      <svg
        width="48"
        height="48"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-zinc-600"
      >
        <circle cx="12" cy="12" r="10" />
        <polyline points="12,6 12,12 16,14" />
      </svg>

      <div className="text-center">
        <h2 className="text-base font-semibold text-zinc-200 mb-1">No job selected</h2>
        <p className="text-sm text-zinc-500">Select a job from the list to view details</p>
      </div>

      {total > 0 && (
        <div className="flex items-center gap-4 text-xs">
          <div className="flex flex-col items-center gap-0.5">
            <span className="text-zinc-200 font-semibold text-base">{total}</span>
            <span className="text-zinc-500">Total</span>
          </div>
          <div className="w-px h-8 bg-zinc-700" />
          <div className="flex flex-col items-center gap-0.5">
            <span className="text-green-400 font-semibold text-base">{active}</span>
            <span className="text-zinc-500">Active</span>
          </div>
          <div className="w-px h-8 bg-zinc-700" />
          <div className="flex flex-col items-center gap-0.5">
            <span className="text-zinc-400 font-semibold text-base">{paused}</span>
            <span className="text-zinc-500">Paused</span>
          </div>
          {errors > 0 && (
            <>
              <div className="w-px h-8 bg-zinc-700" />
              <div className="flex flex-col items-center gap-0.5">
                <span className="text-red-400 font-semibold text-base">{errors}</span>
                <span className="text-zinc-500">Errors</span>
              </div>
            </>
          )}
        </div>
      )}

      <button
        onClick={onCreateJob}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-md text-sm font-medium transition-colors"
      >
        Create Job
      </button>
    </div>
  )
}
