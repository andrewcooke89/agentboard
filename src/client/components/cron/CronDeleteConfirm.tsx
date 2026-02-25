// WU-015: Create, Delete & Sudo Modals — CronDeleteConfirm

import { useState } from 'react'
import type { CronJob } from '@shared/types'

// ─── CronDeleteConfirm ────────────────────────────────────────────────────────
// Confirmation dialog for job deletion.
// Standard jobs: simple Delete / Cancel buttons.
// System-level systemd units (source: 'systemd-system'): enhanced dialog with
// explicit warning + type-to-confirm (must type unit name to enable Delete button).
// Delete button styled as destructive (red).

interface CronDeleteConfirmProps {
  isOpen: boolean
  job: CronJob | null
  onConfirm: () => void
  onCancel: () => void
}

export function CronDeleteConfirm({ isOpen, job, onConfirm, onCancel }: CronDeleteConfirmProps) {
  const [confirmText, setConfirmText] = useState('')

  if (!isOpen || !job) return null

  const isSystemLevel = job.source === 'systemd-system'
  const canConfirm = isSystemLevel ? confirmText === job.name : true

  const handleConfirm = () => {
    if (canConfirm) {
      onConfirm()
      setConfirmText('')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg shadow-xl w-[400px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 space-y-3">
          <h3 className="text-lg font-semibold text-[var(--fg-primary)]">Delete Job</h3>

          {isSystemLevel && (
            <div className="text-sm text-yellow-500 p-2 bg-yellow-500/10 rounded border border-yellow-500/20">
              Warning: This is a system-level unit. Deletion may affect services for all users on
              this system.
            </div>
          )}

          <p className="text-sm text-[var(--fg-muted)]">
            Are you sure you want to delete{' '}
            <strong className="text-[var(--fg-primary)]">{job.name}</strong>? This action cannot be
            undone.
          </p>

          {isSystemLevel && (
            <label className="block">
              <span className="text-xs text-[var(--fg-muted)]">
                Type &ldquo;{job.name}&rdquo; to confirm
              </span>
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleConfirm()}
                autoFocus
                className="w-full mt-1 px-2 py-1.5 text-sm bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-[var(--fg-primary)] font-mono"
              />
            </label>
          )}
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-[var(--border)]">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-[var(--fg-muted)] hover:text-[var(--fg-primary)]"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="px-4 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

export default CronDeleteConfirm
