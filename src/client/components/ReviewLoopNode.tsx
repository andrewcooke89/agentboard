// ReviewLoopNode.tsx - Review loop step with iteration history and human review actions
import { useState } from 'react'
import type { StepRunState, ReviewIteration } from '@shared/types'

/** Verdict badge colors */
const VERDICT_CLASSES = {
  PASS: 'text-green-400 bg-green-900/30 border-green-700',
  FAIL: 'text-red-400 bg-red-900/30 border-red-700',
  NEEDS_FIX: 'text-yellow-400 bg-yellow-900/30 border-yellow-700',
  CONCERN: 'text-orange-400 bg-orange-900/30 border-orange-700',
}

/** Sub-step status label */
function subStepLabel(subStep: 'producer' | 'reviewer' | 'between' | null, status: string): string {
  if (!subStep) return status
  if (subStep === 'producer') return 'Producer: running...'
  if (subStep === 'reviewer') return 'Reviewer: running...'
  if (subStep === 'between') return 'Between iterations'
  return status
}

/** Format timestamp for display */
function formatTime(iso: string | null): string {
  if (!iso) return 'N/A'
  const date = new Date(iso)
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** Chevron icon for expand/collapse */
function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`w-4 h-4 transition-transform ${expanded ? 'rotate-90' : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Verdict badge component */
function VerdictBadge({ verdict }: { verdict: 'PASS' | 'FAIL' | 'NEEDS_FIX' | 'CONCERN' | null }) {
  if (!verdict) return <span className="text-xs text-gray-500">pending</span>
  const classes = VERDICT_CLASSES[verdict] || 'text-gray-400 bg-gray-900/30 border-gray-700'
  return (
    <span className={`text-xs px-2 py-0.5 rounded border ${classes} font-semibold`}>
      {verdict}
    </span>
  )
}

/** Single iteration row in history */
function IterationRow({ iter, isCurrent }: { iter: ReviewIteration; isCurrent: boolean }) {
  const duration = iter.startedAt && iter.completedAt
    ? `${Math.round((new Date(iter.completedAt).getTime() - new Date(iter.startedAt).getTime()) / 1000)}s`
    : 'in progress'

  return (
    <div className={`flex items-start gap-3 p-3 rounded border ${isCurrent ? 'bg-blue-900/20 border-blue-700' : 'bg-gray-800 border-gray-700'}`}>
      <div className="flex-shrink-0 w-12 text-sm font-mono text-gray-400">
        #{iter.iteration}
      </div>
      <div className="flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <VerdictBadge verdict={iter.verdict} />
          <span className="text-xs text-gray-500">{duration}</span>
          {isCurrent && <span className="text-xs text-blue-400 font-medium">current</span>}
        </div>
        {iter.feedback && (
          <p className="text-sm text-gray-300 bg-gray-900/50 p-2 rounded border border-gray-700">
            {iter.feedback}
          </p>
        )}
        <div className="flex gap-4 text-xs text-gray-500">
          {iter.startedAt && <span>Started: {formatTime(iter.startedAt)}</span>}
          {iter.completedAt && <span>Completed: {formatTime(iter.completedAt)}</span>}
        </div>
      </div>
    </div>
  )
}

export interface ReviewLoopNodeProps {
  step: StepRunState
  maxIterations: number
  isSelected: boolean
  onSelect: () => void
  onAction?: (action: 'accept' | 'reject' | 'restart') => void
}

export default function ReviewLoopNode({ step, maxIterations, isSelected, onSelect, onAction }: ReviewLoopNodeProps) {
  const [expanded, setExpanded] = useState(false)

  const currentIteration = step.reviewIteration || 0
  const subStep = step.reviewSubStep || null
  const verdict = step.reviewVerdict || null
  const iterations = step.reviewIterations || []

  // Determine if paused for human review
  const isPaused = step.status === 'paused_human' || step.status === 'paused_escalated'
  const pauseReason = isPaused
    ? step.status === 'paused_escalated'
      ? `Escalated after ${maxIterations} iterations`
      : 'CONCERN verdict - needs human review'
    : null

  // Status summary for collapsed view
  const statusSummary = isPaused
    ? `Paused: ${pauseReason}`
    : subStepLabel(subStep, step.status)

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setExpanded(!expanded)
    }
  }

  const handleActionClick = (action: 'accept' | 'reject' | 'restart') => {
    onAction?.(action)
  }

  return (
    <div
      className={`
        border-2 rounded-lg transition-all duration-200
        ${isSelected ? 'ring-2 ring-white ring-offset-2 ring-offset-gray-900 border-blue-500' : 'border-gray-700'}
        ${isPaused ? 'bg-orange-900/10 border-orange-700' : 'bg-gray-800'}
      `}
    >
      {/* Collapsed summary row */}
      <button
        type="button"
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-700/30 transition-colors rounded-lg"
        onClick={() => {
          onSelect()
          setExpanded(!expanded)
        }}
        onKeyDown={handleKeyDown}
        aria-expanded={expanded}
        aria-label={`Review loop ${step.name}, iteration ${currentIteration} of ${maxIterations}, ${statusSummary}`}
      >
        <ChevronIcon expanded={expanded} />
        <div className="flex-1 flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm text-white">[{step.name}: Iteration {currentIteration}/{maxIterations}]</span>
          <span className="text-sm text-gray-400">{statusSummary}</span>
          {verdict && !isPaused && (
            <VerdictBadge verdict={verdict as 'PASS' | 'FAIL' | 'NEEDS_FIX' | 'CONCERN'} />
          )}
          {isPaused && (
            <span className="text-xs px-2 py-0.5 rounded bg-orange-600 text-white font-semibold">
              PAUSED
            </span>
          )}
        </div>
      </button>

      {/* Expanded view: iteration history + actions */}
      {expanded && (
        <div className="border-t border-gray-700 p-4 space-y-4">
          {/* Pause message + action buttons */}
          {isPaused && (
            <div className="bg-orange-900/20 border border-orange-700 rounded-lg p-4 space-y-3">
              <div className="flex items-center gap-2">
                <svg className="w-5 h-5 text-orange-400" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M8 1L15 14H1L8 1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                  <path d="M8 6V9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <circle cx="8" cy="11.5" r="0.5" fill="currentColor" />
                </svg>
                <span className="text-orange-300 font-medium">Paused for human review</span>
              </div>
              <p className="text-sm text-gray-300">{pauseReason}</p>
              {onAction && (
                <div className="flex gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => handleActionClick('accept')}
                    className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded font-medium text-sm transition-colors"
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => handleActionClick('reject')}
                    className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded font-medium text-sm transition-colors"
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    onClick={() => handleActionClick('restart')}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded font-medium text-sm transition-colors"
                  >
                    Restart
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Iteration history */}
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Iteration History</h3>
            {iterations.length === 0 ? (
              <p className="text-sm text-gray-500">No iterations yet</p>
            ) : (
              <div className="space-y-2">
                {iterations.map((iter) => (
                  <IterationRow
                    key={iter.iteration}
                    iter={iter}
                    isCurrent={iter.iteration === currentIteration}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Current sub-step details */}
          {subStep && !isPaused && (
            <div className="bg-blue-900/20 border border-blue-700 rounded-lg p-3">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-blue-400 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
                  <path d="M14.5 8a6.5 6.5 0 0 0-6.5-6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <span className="text-sm text-blue-300">
                  {subStep === 'producer' && 'Producer task is running...'}
                  {subStep === 'reviewer' && 'Reviewer task is running...'}
                  {subStep === 'between' && 'Transitioning between iterations...'}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
