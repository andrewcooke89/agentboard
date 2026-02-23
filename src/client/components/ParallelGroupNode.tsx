// ParallelGroupNode.tsx - Expandable parallel group node with progress summary
import { useState, useEffect } from 'react'
import type { StepRunState, StepRunStatus } from '@shared/types'

/** Status-to-Tailwind background + text classes (matches StepNode.tsx) */
const STATUS_CLASSES: Record<StepRunStatus, string> = {
  pending: 'bg-gray-700 text-gray-300 border-gray-600',
  running: 'bg-blue-600 text-white border-blue-400 animate-pulse',
  completed: 'bg-green-600 text-white border-green-400',
  failed: 'bg-red-600 text-white border-red-400',
  skipped: 'bg-gray-500 text-gray-300 border-gray-400',
  queued: 'bg-yellow-500 text-gray-900 border-yellow-400',
  cancelled: 'bg-gray-500 text-white border-gray-400',
  partial: 'bg-orange-500 text-white border-orange-400',
  paused_amendment: 'bg-orange-500 text-white border-orange-400',
  paused_human: 'bg-orange-500 text-white border-orange-400',
  paused_exploration: 'bg-blue-500 text-white border-blue-400',
  invalidated: 'bg-gray-600 text-white border-gray-500 step-invalidated',
  paused_escalated: 'bg-orange-500 text-white border-orange-400',
  waiting_signal: 'bg-blue-600 text-white border-blue-400 animate-pulse',
  signal_received: 'bg-blue-500 text-white border-blue-400',
  signal_timeout: 'bg-red-500 text-white border-red-300',
  signal_error: 'bg-red-700 text-white border-red-500',
  signal_resolved: 'bg-green-500 text-white border-green-300',
  paused_starvation: 'bg-yellow-600 text-white border-yellow-400',
}

/** Human-readable status labels */
const STATUS_LABELS: Record<StepRunStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  skipped: 'Skipped',
  queued: 'Queued',
  cancelled: 'Cancelled',
  partial: 'Partial',
  paused_amendment: 'Paused (Amendment)',
  paused_human: 'Paused (Human)',
  paused_exploration: 'Paused (Exploration)',
  invalidated: 'Invalidated',
  paused_escalated: 'Paused (Escalated)',
  waiting_signal: 'Waiting Signal',
  signal_received: 'Signal Received',
  signal_timeout: 'Signal Timeout',
  signal_error: 'Signal Error',
  signal_resolved: 'Signal Resolved',
  paused_starvation: 'Paused (Starvation)',
}

/** SVG status icon (simplified for child rows) */
function StatusIcon({ status }: { status: StepRunStatus }) {
  const cls = 'w-4 h-4 shrink-0'
  switch (status) {
    case 'completed':
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'failed':
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    case 'running':
    case 'queued':
      return (
        <svg className={`${cls} animate-spin`} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
          <path d="M14.5 8a6.5 6.5 0 0 0-6.5-6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    case 'skipped':
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 8H10M10 8L7 5M10 8L7 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <line x1="12.5" y1="4" x2="12.5" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    default:
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 4.5V8L10.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
  }
}

/** Calculate progress summary from child steps */
function calculateProgress(children: StepRunState[]): { completed: number; total: number } {
  const completed = children.filter(c => c.status === 'completed').length
  return { completed, total: children.length }
}

/** Get overall group status based on children */
function getGroupStatus(children: StepRunState[]): StepRunStatus {
  if (children.length === 0) return 'pending'
  const statuses = children.map(c => c.status)
  if (statuses.every(s => s === 'completed')) return 'completed'
  if (statuses.some(s => s === 'failed')) return 'failed'
  if (statuses.some(s => s === 'running')) return 'running'
  if (statuses.some(s => s === 'queued')) return 'queued'
  return 'pending'
}

export interface ParallelGroupNodeProps {
  step: StepRunState
  isSelected: boolean
  onSelect: () => void
  allSteps?: StepRunState[]
}

export default function ParallelGroupNode({ step, isSelected, onSelect, allSteps = [] }: ParallelGroupNodeProps) {
  const children = step.childSteps || []
  const { completed, total } = calculateProgress(children)
  const groupStatus = getGroupStatus(children)

  // Auto-expand if <=3 children, otherwise collapsed by default
  const [isExpanded, setIsExpanded] = useState(total <= 3)

  // Update expanded state if children count changes from >3 to <=3
  useEffect(() => {
    if (total <= 3 && !isExpanded) {
      setIsExpanded(true)
    }
  }, [total, isExpanded])

  const toggleExpand = () => setIsExpanded(prev => !prev)

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggleExpand()
    }
  }

  const groupClasses = STATUS_CLASSES[groupStatus] || STATUS_CLASSES.pending

  return (
    <div
      className="flex flex-col gap-1"
      role="group"
      aria-label={`Parallel group: ${step.name}`}
    >
      {/* Group header row */}
      <button
        type="button"
        className={`
          flex items-center gap-3 px-4 py-3 rounded-lg border-2
          transition-all duration-200 cursor-pointer select-none
          ${groupClasses}
          ${isSelected ? 'ring-2 ring-white ring-offset-2 ring-offset-gray-900' : ''}
          hover:brightness-110
        `}
        onClick={() => {
          onSelect()
          toggleExpand()
        }}
        onKeyDown={handleKeyDown}
        aria-expanded={isExpanded}
        aria-label={`${step.name}, ${completed} of ${total} complete, ${isExpanded ? 'expanded' : 'collapsed'}`}
        tabIndex={0}
      >
        {/* Chevron icon */}
        <svg
          className={`w-5 h-5 shrink-0 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>

        {/* Status icon */}
        <StatusIcon status={groupStatus} />

        {/* Group name */}
        <span className="font-semibold text-sm flex-1 text-left truncate" title={step.name}>
          {step.name}
        </span>

        {/* Progress summary */}
        <span className="text-xs font-medium opacity-90 shrink-0">
          {total === 0 ? 'No steps' : `${completed}/${total} complete`}
        </span>
      </button>

      {/* Expanded child steps */}
      {isExpanded && children.length > 0 && (
        <div className="flex flex-col gap-1 ml-8 pl-4 border-l-2 border-gray-700">
          {children.map((child, idx) => {
            const childStatus = child.status || 'pending'
            const childClasses = STATUS_CLASSES[childStatus] || STATUS_CLASSES.pending

            // Check for depends_on relationships
            const dependsOn = (child as any).depends_on as string[] | undefined
            const hasDependency = dependsOn && dependsOn.length > 0

            return (
              <div
                key={`${child.name}-${idx}`}
                className={`
                  flex items-center gap-3 px-3 py-2 rounded border
                  transition-colors duration-150
                  ${childClasses}
                `}
                role="listitem"
                aria-label={`Child step: ${child.name}, status ${STATUS_LABELS[childStatus]}`}
              >
                {/* Status icon */}
                <StatusIcon status={childStatus} />

                {/* Step name */}
                <span className="font-medium text-xs flex-1 truncate" title={child.name}>
                  {child.name}
                </span>

                {/* Status label */}
                <span className="text-[10px] opacity-80 shrink-0">
                  {STATUS_LABELS[childStatus]}
                </span>

                {/* Dependency info */}
                {hasDependency && childStatus === 'pending' && (
                  <span className="text-[10px] opacity-70 italic shrink-0 flex items-center gap-1" title={`Depends on: ${dependsOn.join(', ')}`}>
                    <span>(depends_on:</span>
                    {dependsOn.map((depName, depIdx) => {
                      const depStep = allSteps.find(s => s.name === depName)
                      const depStatus = depStep?.status || 'unknown'
                      const isDone = depStatus === 'completed'
                      const isRunning = depStatus === 'running'
                      return (
                        <span key={depIdx} className="inline-flex items-center gap-0.5">
                          {isDone ? (
                            <svg className="w-2.5 h-2.5 text-green-400" viewBox="0 0 16 16" fill="none" aria-label="completed">
                              <path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          ) : isRunning ? (
                            <svg className="w-2.5 h-2.5 text-yellow-400 animate-spin" viewBox="0 0 16 16" fill="none" aria-label="running">
                              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                              <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                            </svg>
                          ) : (
                            <svg className="w-2.5 h-2.5 text-gray-500" viewBox="0 0 16 16" fill="currentColor" aria-label="pending">
                              <circle cx="8" cy="8" r="2" />
                            </svg>
                          )}
                          <span>{depName}</span>
                          {depIdx < dependsOn.length - 1 && <span>,</span>}
                        </span>
                      )
                    })}
                    <span>)</span>
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
