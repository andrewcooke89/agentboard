// WU-011: Detail Pane Shell — CronSessionLink

import { useState, useRef, useEffect } from 'react'
import { useSessionStore } from '../../stores/sessionStore'

// ─── CronSessionLink ──────────────────────────────────────────────────────────
// Session link indicator in the detail header.
// Shows linked session chip when a session is linked (with unlink button).
// Shows "Link Session" button with dropdown of active sessions.
// WS messages (cron-job-link-session) are sent via window.__cronWsSend.

interface CronSessionLinkProps {
  jobId: string
  linkedSessionId: string | null
}

export function CronSessionLink({ jobId, linkedSessionId }: CronSessionLinkProps) {
  const [showDropdown, setShowDropdown] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const sessions = useSessionStore((s) => s.sessions)
  const setSelectedSessionId = useSessionStore((s) => s.setSelectedSessionId)

  const sendWs = (msg: unknown) => {
    const ws = (window as unknown as { __cronWsSend?: (msg: unknown) => void }).__cronWsSend
    if (ws) ws(msg)
  }

  const handleUnlink = () => {
    sendWs({ type: 'cron-job-link-session', jobId, sessionId: null })
  }

  const handleLinkSession = (sessionId: string) => {
    sendWs({ type: 'cron-job-link-session', jobId, sessionId })
    setShowDropdown(false)
  }

  const handleNavigateToSession = () => {
    if (linkedSessionId) {
      setSelectedSessionId(linkedSessionId)
    }
  }

  // Close dropdown on outside click
  useEffect(() => {
    if (!showDropdown) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showDropdown])

  if (linkedSessionId) {
    const linkedSession = sessions.find((s) => s.id === linkedSessionId)
    const displayLabel = linkedSession
      ? linkedSession.name || linkedSessionId.slice(0, 8)
      : linkedSessionId.slice(0, 8)

    return (
      <div className="flex items-center gap-1 text-xs shrink-0">
        <button
          onClick={handleNavigateToSession}
          className="flex items-center gap-1 cursor-pointer hover:text-blue-400 transition-colors"
          title={`Navigate to session ${linkedSessionId}`}
        >
          <span className="text-blue-400">🔗</span>
          <span className="text-[var(--text-muted)] truncate max-w-[120px] hover:text-blue-400">
            {displayLabel}
          </span>
        </button>
        <button
          onClick={handleUnlink}
          className="text-[var(--text-muted)] hover:text-red-400"
          title="Unlink session"
        >
          &times;
        </button>
      </div>
    )
  }

  return (
    <div className="relative shrink-0" ref={dropdownRef}>
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] px-2 py-1 rounded border border-[var(--border)]"
      >
        Link Session
      </button>
      {showDropdown && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-[var(--bg-elevated)] border border-[var(--border)] rounded shadow-lg z-10 max-h-48 overflow-y-auto">
          {sessions.length === 0 ? (
            <div className="p-2 text-xs text-[var(--text-muted)]">No sessions available</div>
          ) : (
            sessions.map((session) => (
              <button
                key={session.id}
                onClick={() => handleLinkSession(session.id)}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--bg-surface)] flex items-center gap-2"
              >
                <span className="text-[var(--text-primary)] truncate">
                  {session.name || session.id.slice(0, 8)}
                </span>
                {session.projectPath && (
                  <span className="text-[var(--text-muted)] truncate text-[10px]">
                    {session.projectPath.split('/').pop()}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export default CronSessionLink
