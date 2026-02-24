// CronSessionLink.tsx — Bidirectional session linking & notifications
// WU-019: Session Integration & Notifications
//
// Linked session chip with click navigation (REQ-74).
// Link to Session dropdown for manual linking (REQ-73).
// Sends cron-job-link-session WS message.

import React, { useCallback } from 'react'
import type { CronJob, ClientMessage } from '../../../shared/types'

interface CronSessionLinkProps {
  job: CronJob
  sendMessage: (msg: ClientMessage) => void
  onNavigateToSession?: (sessionId: string) => void
}

// ── Terminal icon (inline SVG) ────────────────────────────────────────────────

function TerminalIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1" y="2" width="14" height="12" rx="2" />
      <polyline points="4,6 7,9 4,12" />
      <line x1="9" y1="12" x2="13" y2="12" />
    </svg>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CronSessionLink({ job, sendMessage, onNavigateToSession }: CronSessionLinkProps) {
  const handleUnlink = useCallback(() => {
    sendMessage({ type: 'cron-job-link-session', jobId: job.id, sessionId: null })
  }, [job.id, sendMessage])

  const handleNavigate = useCallback(() => {
    if (job.linkedSessionId && onNavigateToSession) {
      onNavigateToSession(job.linkedSessionId)
    }
  }, [job.linkedSessionId, onNavigateToSession])

  if (job.linkedSessionId) {
    return (
      <div className="inline-flex items-center gap-1">
        {/* Session chip */}
        <button
          onClick={handleNavigate}
          className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-zinc-700 hover:bg-zinc-600 border border-zinc-600 rounded text-xs text-blue-400 hover:text-blue-300 transition-colors max-w-[160px]"
          title={`Go to session ${job.linkedSessionId}`}
        >
          <TerminalIcon />
          <span className="truncate">{job.linkedSessionId}</span>
        </button>

        {/* Unlink button */}
        <button
          onClick={handleUnlink}
          className="inline-flex items-center justify-center w-4 h-4 text-zinc-500 hover:text-zinc-200 transition-colors text-xs leading-none"
          title="Unlink session"
          aria-label="Unlink session"
        >
          &times;
        </button>
      </div>
    )
  }

  return (
    <button
      disabled
      className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-500 cursor-not-allowed"
      title="No active sessions available"
    >
      <TerminalIcon />
      Link to Session
    </button>
  )
}
