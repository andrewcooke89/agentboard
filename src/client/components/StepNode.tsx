// StepNode.tsx - Individual pipeline step node with status visualization
import type { StepRunState, StepRunStatus } from '@shared/types'

/** Status-to-Tailwind background + text classes */
export const STATUS_CLASSES: Record<StepRunStatus, string> = {
  pending: 'bg-gray-700 text-gray-300 border-gray-600',
  running: 'bg-blue-600 text-white border-blue-400 animate-pulse',
  completed: 'bg-green-600 text-white border-green-400',
  failed: 'bg-red-600 text-white border-red-400',
  skipped: 'bg-yellow-500 text-gray-900 border-yellow-400',
  queued: 'bg-yellow-500 text-gray-900 border-yellow-400',
  cancelled: 'bg-gray-500 text-white border-gray-400',
  partial: 'bg-orange-500 text-white border-orange-400',
  // Phase 7: Signal statuses
  waiting_signal: 'bg-blue-600 text-white border-blue-400 animate-pulse',
  signal_received: 'bg-blue-500 text-white border-blue-400',
  signal_timeout: 'bg-red-500 text-white border-red-400',
  signal_error: 'bg-red-600 text-white border-red-400',
  signal_resolved: 'bg-green-600 text-white border-green-400',
  // Phase 15: New step statuses (REQ-18)
  paused_amendment: 'bg-orange-500 text-white border-orange-400',
  paused_escalated: 'bg-orange-500 text-white border-orange-400',
  paused_human: 'bg-orange-500 text-white border-orange-400',
  paused_starvation: 'bg-yellow-500 text-gray-900 border-yellow-400',
  paused_exploration: 'bg-blue-500 text-white border-blue-400',
  invalidated: 'bg-gray-600 text-white border-gray-500 step-invalidated',
}

/** Human-readable status labels */
export const STATUS_LABELS: Record<StepRunStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  skipped: 'Skipped',
  queued: 'Queued',
  cancelled: 'Cancelled',
  partial: 'Partial',
  // Phase 7
  waiting_signal: 'Waiting Signal',
  signal_received: 'Signal Received',
  signal_timeout: 'Signal Timeout',
  signal_error: 'Signal Error',
  signal_resolved: 'Signal Resolved',
  // Phase 15 (REQ-18)
  paused_amendment: 'Paused (Amendment)',
  paused_escalated: 'Paused (Escalated)',
  paused_human: 'Paused (Human)',
  paused_starvation: 'Paused (Starvation)',
  paused_exploration: 'Paused (Exploration)',
  invalidated: 'Invalidated',
}

/** SVG icons per status (16x16 viewBox) */
function StatusIcon({ status }: { status: StepRunStatus }) {
  const cls = 'w-4 h-4 shrink-0'
  switch (status) {
    case 'pending':
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 4.5V8L10.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'running':
    case 'waiting_signal':
      return (
        <svg className={`${cls} animate-spin`} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
          <path d="M14.5 8a6.5 6.5 0 0 0-6.5-6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    case 'completed':
    case 'signal_resolved':
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'failed':
    case 'signal_error':
    case 'signal_timeout':
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4.5 4.5L11.5 11.5M11.5 4.5L4.5 11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    case 'skipped':
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 8H10M10 8L7 5M10 8L7 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          <line x1="12.5" y1="4" x2="12.5" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    case 'queued':
    case 'paused_starvation':
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="5" cy="8" r="1" fill="currentColor" />
          <circle cx="8" cy="8" r="1" fill="currentColor" />
          <circle cx="11" cy="8" r="1" fill="currentColor" />
        </svg>
      )
    case 'paused_amendment':
    case 'paused_escalated':
    case 'paused_human':
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="4" y="3" width="3" height="10" rx="0.5" fill="currentColor" />
          <rect x="9" y="3" width="3" height="10" rx="0.5" fill="currentColor" />
        </svg>
      )
    case 'paused_exploration':
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    case 'invalidated':
      return (
        <svg className={cls} viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2L14 13H2L8 2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M8 6V9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="11" r="0.75" fill="currentColor" />
        </svg>
      )
    default:
      return null
  }
}

/** Short label for step type */
function typeLabel(type: string): string {
  switch (type) {
    case 'spawn_session': return 'session'
    case 'check_file': return 'file'
    case 'check_output': return 'output'
    case 'delay': return 'delay'
    case 'parallel_group': return 'parallel'
    case 'review_loop': return 'review'
    case 'native_step': return 'command'
    case 'spec_validate': return 'validate'
    case 'amendment_check': return 'amendment'
    case 'reconcile-spec': return 'reconcile'
    default: return type
  }
}

export interface StepNodeProps {
  step: StepRunState
  index: number
  isSelected: boolean
  isFocused: boolean
  onClick: (index: number) => void
  compact?: boolean
}

export default function StepNode({ step, index, isSelected, isFocused, onClick, compact = false }: StepNodeProps) {
  const status = step.status || 'pending'
  const classes = STATUS_CLASSES[status] || STATUS_CLASSES.pending

  return (
    <button
      type="button"
      className={`
        flex flex-col items-center gap-1 rounded-lg border-2
        transition-all duration-200 cursor-pointer select-none
        ${compact ? 'px-2 py-1 min-w-[80px]' : 'px-3 py-2 min-w-[120px]'}
        ${classes}
        ${isSelected ? 'ring-2 ring-white ring-offset-2 ring-offset-gray-900' : ''}
        ${isFocused ? 'outline outline-2 outline-offset-2 outline-blue-300' : ''}
      `}
      data-step-index={index}
      aria-label={`Step ${step.name}, status ${STATUS_LABELS[status]}`}
      tabIndex={0}
      onClick={() => onClick(index)}
    >
      <StatusIcon status={status} />
      <span className={`font-medium truncate ${compact ? 'text-[10px] max-w-[70px]' : 'text-xs max-w-[100px]'}`} title={step.name}>
        {step.name}
      </span>
      {!compact && <span className="text-[10px] opacity-70">{typeLabel(step.type)}</span>}
    </button>
  )
}
