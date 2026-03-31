// WU-011: CronAi Proposal Card
// Inline proposal card rendered as overlay in the AI drawer terminal area.
// Shows operation type, job info, diff preview, reasoning, Accept/Reject buttons.
// Four visual states: pending (blue), accepted (green), rejected (red), expired (gray).

import { useState, useCallback } from 'react'
import type { CronAiProposal } from '@shared/types'

interface CronAiProposalCardProps {
  proposal: CronAiProposal
  onAccept: (id: string) => void
  onReject: (feedback?: string) => void
}

// ─── Operation badge colors ──────────────────────────────────────────────────

const OPERATION_COLORS: Record<string, string> = {
  create: 'bg-green-600',
  edit_frequency: 'bg-blue-600',
  pause: 'bg-yellow-600',
  resume: 'bg-green-600',
  delete: 'bg-red-600',
  run_now: 'bg-orange-600',
  set_tags: 'bg-purple-600',
  link_session: 'bg-cyan-600',
}

// ─── Card state styles ───────────────────────────────────────────────────────

const STATE_STYLES: Record<CronAiProposal['status'], { border: string; badge?: string; badgeText?: string }> = {
  pending: { border: 'border-blue-500' },
  accepted: { border: 'border-green-500', badge: 'bg-green-600', badgeText: 'Approved' },
  rejected: { border: 'border-red-500', badge: 'bg-red-600', badgeText: 'Rejected' },
  expired: { border: 'border-gray-500', badge: 'bg-gray-600', badgeText: 'Expired (no response)' },
}

// ─── Diff formatting per operation type (REQ-24) ─────────────────────────────

function formatDiff(proposal: CronAiProposal): string {
  const { operation, diff } = proposal

  switch (operation) {
    case 'create':
      return `New job:\n${diff}`

    case 'edit_frequency': {
      // diff may be "old_schedule → new_schedule" or contain separate lines
      // Attempt to parse "old\nnew" or "old → new" formats; fall back to prefixed raw
      const arrowMatch = diff.match(/^(.+?)\s*→\s*(.+)$/s)
      if (arrowMatch) {
        return `Schedule: ${arrowMatch[1].trim()} → ${arrowMatch[2].trim()}`
      }
      const lines = diff.split('\n').map(l => l.trim()).filter(Boolean)
      if (lines.length === 2) {
        return `Schedule: ${lines[0]} → ${lines[1]}`
      }
      return `Schedule: ${diff}`
    }

    case 'pause':
      return 'Status: active → paused'

    case 'resume':
      return 'Status: paused → active'

    case 'delete':
      return `Remove job:\n${diff}`

    case 'set_tags': {
      const arrowMatch = diff.match(/^(.+?)\s*→\s*(.+)$/s)
      if (arrowMatch) {
        return `Tags: ${arrowMatch[1].trim()} → ${arrowMatch[2].trim()}`
      }
      const lines = diff.split('\n').map(l => l.trim()).filter(Boolean)
      if (lines.length === 2) {
        return `Tags: ${lines[0]} → ${lines[1]}`
      }
      return `Tags: ${diff}`
    }

    case 'run_now':
      return `Execute: ${diff}`

    case 'link_session':
      return `Link session: ${diff}`

    default:
      return diff
  }
}

// ─── Relative timestamp ──────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  if (diffMs < 0) return 'just now'

  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return `${seconds}s ago`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CronAiProposalCard({ proposal, onAccept, onReject }: CronAiProposalCardProps) {
  const [showRejectInput, setShowRejectInput] = useState(false)
  const [feedback, setFeedback] = useState('')

  const stateStyle = STATE_STYLES[proposal.status]
  const isResolved = proposal.status !== 'pending'

  const handleRejectSubmit = useCallback(() => {
    onReject(feedback || undefined)
    setShowRejectInput(false)
    setFeedback('')
  }, [feedback, onReject])

  return (
    <div
      role="article"
      aria-label={`Proposal: ${proposal.operation} ${proposal.jobName || 'new job'}`}
      className={`absolute rounded-lg border ${stateStyle.border} bg-zinc-800 p-3 my-2 mx-2 shadow-lg`}
    >
      {/* Header: operation badge + job name + timestamp */}
      <div className="flex items-center gap-2 mb-2">
        {/* Operation badge */}
        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded text-white ${OPERATION_COLORS[proposal.operation] || 'bg-zinc-600'}`}>
          {proposal.operation.replace('_', ' ')}
        </span>

        {/* Job avatar */}
        {proposal.jobAvatarUrl ? (
          <img
            src={proposal.jobAvatarUrl}
            alt={proposal.jobName || 'job avatar'}
            className="w-5 h-5 rounded-full"
          />
        ) : null}

        {/* Job name */}
        {proposal.jobName ? (
          <span className="text-sm text-zinc-200 truncate">
            {proposal.jobName}
          </span>
        ) : null}

        <div className="flex-1" />

        {/* Resolved badge */}
        {stateStyle.badge ? (
          <span className={`text-[10px] px-1.5 py-0.5 rounded text-white ${stateStyle.badge}`}>
            {stateStyle.badgeText}
          </span>
        ) : null}

        {/* Timestamp */}
        <span className="text-[10px] text-zinc-500">
          {relativeTime(proposal.createdAt)}
        </span>
      </div>

      {/* Description / reasoning */}
      <p className="text-xs text-zinc-300 mb-2">{proposal.description}</p>

      {/* Diff preview */}
      <pre className="text-[11px] text-zinc-400 bg-zinc-900 rounded p-2 mb-2 overflow-x-auto whitespace-pre-wrap">
        {formatDiff(proposal)}
      </pre>

      {/* Rejected feedback display */}
      {proposal.status === 'rejected' && proposal.feedback ? (
        <p className="text-xs text-red-400 italic mb-2">Feedback: {proposal.feedback}</p>
      ) : null}

      {/* Action buttons — always rendered, disabled when resolved */}
      <div className="flex items-center gap-2">
        <button
          className="text-xs px-3 py-1 rounded bg-green-600 hover:bg-green-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => onAccept(proposal.id)}
          disabled={isResolved}
          aria-label="Accept proposal"
        >
          Accept
        </button>

        {!isResolved && showRejectInput ? (
          <div className="flex items-center gap-1 flex-1">
            <input
              type="text"
              className="flex-1 text-xs px-2 py-1 rounded bg-zinc-700 border border-zinc-600 text-zinc-200 placeholder-zinc-500"
              placeholder="Feedback (optional)..."
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleRejectSubmit()}
              autoFocus
            />
            <button
              className="text-xs px-2 py-1 rounded bg-red-600 text-white"
              onClick={handleRejectSubmit}
              aria-label="Submit feedback"
            >
              Submit
            </button>
          </div>
        ) : (
          <button
            className="text-xs px-3 py-1 rounded border border-red-600 text-red-400 hover:bg-red-600/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => setShowRejectInput(true)}
            disabled={isResolved}
            aria-label="Reject proposal"
          >
            Reject
          </button>
        )}
      </div>
    </div>
  )
}

export default CronAiProposalCard
