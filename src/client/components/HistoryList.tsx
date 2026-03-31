// HistoryList.tsx - Renders list of history sessions
import type { HistorySession } from '@shared/types'

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
    if (diffHours < 1) return 'just now'
    if (diffHours < 24) return `${diffHours}h ago`
    const diffDays = Math.floor(diffHours / 24)
    if (diffDays < 7) return `${diffDays}d ago`
    return d.toLocaleDateString()
  } catch {
    return ''
  }
}

const agentIcons: Record<string, string> = {
  claude: 'C',
  codex: 'X',
}

interface HistoryListProps {
  sessions: HistorySession[]
  onResume: (session: HistorySession) => void
}

export default function HistoryList({ sessions, onResume }: HistoryListProps) {
  if (sessions.length === 0) {
    return (
      <div className="flex items-center justify-center h-20 text-xs text-white/30">
        No sessions found
      </div>
    )
  }

  return (
    <div className="divide-y divide-white/5">
      {sessions.map((session) => (
        <div
          key={`${session.agentType}-${session.id}`}
          className="px-3 py-2 hover:bg-white/5 cursor-pointer transition-colors group"
          onClick={() => onResume(session)}
        >
          <div className="flex items-center gap-2">
            <span className={`w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold shrink-0 ${
              session.agentType === 'claude' ? 'bg-orange-500/20 text-orange-300' : 'bg-emerald-500/20 text-emerald-300'
            }`}>
              {agentIcons[session.agentType] || '?'}
            </span>
            <span className="text-xs text-white/70 truncate flex-1">
              {session.projectName}
            </span>
            <span className="text-[10px] text-white/30 shrink-0">
              {formatDate(session.lastModified)}
            </span>
          </div>
          {session.firstMessage && (
            <div className="mt-1 text-[11px] text-white/40 truncate pl-7">
              {session.firstMessage.slice(0, 100)}
            </div>
          )}
          {session.matchSnippet && session.matchSnippet !== session.firstMessage && (
            <div className="mt-0.5 text-[10px] text-blue-300/50 truncate pl-7">
              Match: {session.matchSnippet.slice(0, 80)}
            </div>
          )}
          <div className="flex items-center gap-2 mt-1 pl-7">
            <span className="text-[9px] text-white/20">{session.messageCount} msgs</span>
            {session.sessionType !== 'original' && session.sessionType !== 'unknown' && (
              <span className="text-[9px] px-1 rounded bg-white/5 text-white/25">{session.sessionType}</span>
            )}
            <button
              className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 transition-colors opacity-0 group-hover:opacity-100"
              onClick={(e) => { e.stopPropagation(); onResume(session) }}
            >
              Resume
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
