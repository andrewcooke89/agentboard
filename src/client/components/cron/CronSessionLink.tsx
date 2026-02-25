// WU-011: Detail Pane Shell — CronSessionLink

import { useState } from 'react'

// ─── CronSessionLink ──────────────────────────────────────────────────────────
// Session link indicator in the detail header.
// Shows linked session chip when a session is linked (with unlink button).
// Shows "Link Session" button with dropdown when no session is linked.
// WS messages (cron-job-link-session) are sent via window.__cronWsSend.

interface CronSessionLinkProps {
  jobId: string
  linkedSessionId: string | null
}

export function CronSessionLink({ jobId, linkedSessionId }: CronSessionLinkProps) {
  const [showDropdown, setShowDropdown] = useState(false)

  const sendWs = (msg: unknown) => {
    const ws = (window as unknown as { __cronWsSend?: (msg: unknown) => void }).__cronWsSend
    if (ws) ws(msg)
  }

  const handleUnlink = () => {
    sendWs({ type: 'cron-job-link-session', jobId, sessionId: null })
  }

  if (linkedSessionId) {
    return (
      <div className="flex items-center gap-1 text-xs shrink-0">
        <span className="text-blue-400" title={`Linked to session ${linkedSessionId}`}>
          🔗
        </span>
        <span className="text-[var(--fg-muted)] truncate max-w-[120px]">
          {linkedSessionId.slice(0, 8)}
        </span>
        <button
          onClick={handleUnlink}
          className="text-[var(--fg-muted)] hover:text-red-400"
          title="Unlink session"
        >
          &times;
        </button>
      </div>
    )
  }

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        className="text-xs text-[var(--fg-muted)] hover:text-[var(--fg-primary)] px-2 py-1 rounded border border-[var(--border)]"
      >
        Link Session
      </button>
      {showDropdown && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-[var(--bg-primary)] border border-[var(--border)] rounded shadow-lg z-10">
          <div className="p-2 text-xs text-[var(--fg-muted)]">No active sessions</div>
        </div>
      )}
    </div>
  )
}

export default CronSessionLink
