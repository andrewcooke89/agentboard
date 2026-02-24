// CronDeleteConfirm.tsx — Destructive operation confirmation dialog
// WU-016: Privilege Escalation & Destructive Confirms
//
// Simple confirm for cron/user jobs.
// Enhanced type-to-confirm for systemd-system source units (REQ-99).
// Explicit system impact warning for system-level units.
// Destructive red Delete button.

import React, { useState, useEffect, useCallback } from 'react'
import type { CronJob } from '../../../shared/types'

interface CronDeleteConfirmProps {
  job: CronJob
  isOpen?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function CronDeleteConfirm({ job, isOpen = true, onConfirm, onCancel }: CronDeleteConfirmProps) {
  const isSystemUnit = job.source === 'systemd-system'
  const [confirmText, setConfirmText] = useState('')

  const canConfirm = isSystemUnit ? confirmText === job.name : true

  // Reset on open
  useEffect(() => {
    if (isOpen) setConfirmText('')
  }, [isOpen])

  // Escape key cancels
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, onCancel])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && canConfirm) onConfirm()
    },
    [canConfirm, onConfirm],
  )

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="bg-zinc-800 rounded-lg border border-zinc-600 w-full max-w-sm shadow-xl p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <span className="text-red-400 text-xl">&#9888;</span>
          <h3 className="text-base font-semibold text-zinc-200">Delete Job</h3>
        </div>

        {/* Message */}
        <p className="text-sm text-zinc-400">
          Are you sure you want to delete{' '}
          <strong className="text-zinc-200">&ldquo;{job.name}&rdquo;</strong>? This action cannot
          be undone.
        </p>

        {/* System-level enhanced warning */}
        {isSystemUnit && (
          <>
            <div className="px-3 py-2 bg-red-900/30 border border-red-600/50 rounded text-xs text-red-300 flex items-start gap-2">
              <span className="flex-shrink-0 font-bold">!</span>
              <span>
                This is a system-level unit. Deletion will affect all users on this system.
              </span>
            </div>
            <div className="space-y-1">
              <label className="block text-xs text-zinc-400">
                Type <span className="text-zinc-200 font-mono">{job.name}</span> to confirm:
              </label>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={job.name}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-600 rounded text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-red-500"
                autoFocus
              />
            </div>
          </>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed rounded text-white transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
