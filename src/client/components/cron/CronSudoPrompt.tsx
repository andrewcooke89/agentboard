// WU-015: Create, Delete & Sudo Modals — CronSudoPrompt

import { useState, useRef, useEffect } from 'react'

// ─── CronSudoPrompt ───────────────────────────────────────────────────────────
// Modal dialog for sudo credential entry.
// Password input (type="password"), auto-focused on open.
// Warns when connection is plain WS (not WSS).
// Grace period note shown below input.
// Credential is never logged or displayed.
// On submit: calls onSubmit(password) and clears the field.

interface CronSudoPromptProps {
  isOpen: boolean
  operation?: string
  gracePeriodMinutes?: number
  isPlainWs?: boolean
  onSubmit: (credential: string) => void
  onCancel: () => void
}

export function CronSudoPrompt({
  isOpen,
  operation,
  gracePeriodMinutes = 5,
  isPlainWs = false,
  onSubmit,
  onCancel,
}: CronSudoPromptProps) {
  const [password, setPassword] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen && inputRef.current) inputRef.current.focus()
  }, [isOpen])

  if (!isOpen) return null

  const handleSubmit = () => {
    if (password) {
      onSubmit(password)
      setPassword('')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg shadow-xl w-[380px]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Plain WS security warning */}
        {isPlainWs && (
          <div className="px-4 py-2 bg-yellow-900/30 border-b border-yellow-700/50 text-yellow-400 text-xs rounded-t-lg">
            Warning: Connection is not encrypted (plain WebSocket). Credentials may be exposed in
            transit.
          </div>
        )}

        <div className="flex items-center justify-between p-4 border-b border-[var(--border)]">
          <h3 className="text-lg font-semibold text-[var(--fg-primary)]">Authentication Required</h3>
          <button
            onClick={onCancel}
            className="text-[var(--fg-muted)] hover:text-[var(--fg-primary)] text-xl leading-none"
          >
            &times;
          </button>
        </div>

        <div className="p-4 space-y-3">
          {operation && (
            <p className="text-sm text-[var(--fg-muted)]">
              The operation{' '}
              <strong className="text-[var(--fg-primary)]">{operation}</strong> requires elevated
              privileges.
            </p>
          )}
          {!operation && (
            <p className="text-sm text-[var(--fg-muted)]">
              This operation requires administrator privileges.
            </p>
          )}

          <label className="block">
            <span className="text-xs text-[var(--fg-muted)]">Password</span>
            <input
              ref={inputRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSubmit()
                if (e.key === 'Escape') onCancel()
              }}
              className="w-full mt-1 px-2 py-1.5 text-sm bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-[var(--fg-primary)]"
              autoComplete="off"
            />
          </label>

          <p className="text-xs text-[var(--fg-muted)]">
            Credentials are cached in memory for {gracePeriodMinutes} minute
            {gracePeriodMinutes !== 1 ? 's' : ''}, then securely zeroed.
          </p>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-[var(--border)]">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-[var(--fg-muted)] hover:text-[var(--fg-primary)]"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!password}
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Authenticate
          </button>
        </div>
      </div>
    </div>
  )
}

export default CronSudoPrompt
