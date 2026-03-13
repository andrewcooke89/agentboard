// WU-009: CronAi Header
// Drawer header with AI Assistant title, session status indicator,
// New Conversation button (with confirmation), and close button.

import type { CronAiSessionStatus } from '../../stores/cronAiStore'

interface CronAiHeaderProps {
  sessionStatus: CronAiSessionStatus
  onNewConversation: () => void
  onClose: () => void
}

/** Status color mapping */
const STATUS_COLORS: Record<CronAiSessionStatus, { dot: string; label: string }> = {
  offline: { dot: 'bg-zinc-500', label: 'Offline' },
  starting: { dot: 'bg-yellow-400 animate-pulse', label: 'Starting' },
  working: { dot: 'bg-green-400 animate-pulse', label: 'Working' },
  waiting: { dot: 'bg-blue-400', label: 'Waiting' },
}

export function CronAiHeader({ sessionStatus, onNewConversation, onClose }: CronAiHeaderProps) {
  const statusInfo = STATUS_COLORS[sessionStatus]

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-700 bg-zinc-800/50">
      {/* Title */}
      <span className="text-sm font-medium text-zinc-200">AI Assistant</span>

      {/* Session status indicator */}
      <div className="flex items-center gap-1.5 ml-2">
        <div className={`w-2 h-2 rounded-full ${statusInfo.dot}`} />
        <span className="text-xs text-zinc-400">{statusInfo.label}</span>
      </div>

      <div className="flex-1" />

      {/* New Conversation button */}
      <button
        className="text-xs text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded hover:bg-zinc-700 transition-colors"
        onClick={onNewConversation}
        title="Start a new conversation"
      >
        New Chat
      </button>

      {/* Close button */}
      <button
        className="text-zinc-400 hover:text-zinc-200 p-1 rounded hover:bg-zinc-700 transition-colors"
        onClick={onClose}
        title="Close AI drawer"
        aria-label="Close AI drawer"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}

export default CronAiHeader
