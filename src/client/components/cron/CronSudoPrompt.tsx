// CronSudoPrompt.tsx — Sudo credential prompt modal
// WU-016: Privilege Escalation & Destructive Confirms
//
// Password input, grace period note (REQ-82, REQ-83).
// Sends cron-sudo-auth WS message.
// Plain WS warning banner (REQ-84).
// Cancel aborts the pending operation.

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'

interface CronSudoPromptProps {
  isOpen: boolean
  onSubmit: (credential: string) => void
  onCancel: () => void
}

export function CronSudoPrompt({ isOpen, onSubmit, onCancel }: CronSudoPromptProps) {
  const [password, setPassword] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const cronSudoGracePeriod = useSettingsStore((s) => s.cronSudoGracePeriod)

  const gracePeriodMinutes = Math.round(cronSudoGracePeriod / 60000)
  const isPlainWs = window.location.protocol !== 'https:'

  // Reset and focus on open
  useEffect(() => {
    if (isOpen) {
      setPassword('')
      // Focus after mount
      setTimeout(() => inputRef.current?.focus(), 50)
    }
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

  const handleSubmit = useCallback(() => {
    if (password) onSubmit(password)
  }, [password, onSubmit])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') handleSubmit()
    },
    [handleSubmit],
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
          <span className="text-yellow-400 text-lg">&#128274;</span>
          <h3 className="text-base font-semibold text-zinc-200">Sudo Required</h3>
        </div>

        {/* Plain WS warning */}
        {isPlainWs && (
          <div className="px-3 py-2 bg-yellow-900/40 border border-yellow-600/50 rounded text-xs text-yellow-300 flex items-start gap-2">
            <span className="flex-shrink-0">&#9888;</span>
            <span>
              Warning: Connection is not encrypted (WSS). Your password will be transmitted in
              plaintext.
            </span>
          </div>
        )}

        <p className="text-sm text-zinc-400">
          This operation requires elevated privileges. Your credential will be remembered for{' '}
          <span className="text-zinc-200 font-medium">{gracePeriodMinutes} minutes</span>.
        </p>

        <input
          ref={inputRef}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Password"
          className="w-full px-3 py-2 bg-zinc-900 border border-zinc-600 rounded text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          autoComplete="current-password"
        />

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!password}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-white transition-colors"
          >
            Authenticate
          </button>
        </div>
      </div>
    </div>
  )
}
