// CleanupStatusDisplay.tsx - Shows cleanup execution status under failed steps (REQ-26)
import type { CleanupState } from '@shared/types'

export interface CleanupStatusDisplayProps {
  cleanupState: CleanupState
  label?: string // "Cleanup" for step-level, "Pipeline Cleanup" for pipeline-level
}

const STATUS_ICONS: Record<string, string> = {
  pending: '○',
  running: '◌',
  completed: '✓',
  failed: '✗',
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'text-gray-400',
  running: 'text-blue-400 animate-pulse',
  completed: 'text-green-400',
  failed: 'text-red-400',
}

const STATUS_TEXT: Record<string, string> = {
  pending: 'pending',
  running: 'running...',
  completed: 'completed',
  failed: 'failed',
}

export default function CleanupStatusDisplay({ cleanupState, label = 'Cleanup' }: CleanupStatusDisplayProps) {
  const { status, errorMessage } = cleanupState
  const icon = STATUS_ICONS[status] ?? '○'
  const color = STATUS_COLORS[status] ?? 'text-gray-400'
  const text = STATUS_TEXT[status] ?? status

  return (
    <div className="flex flex-col gap-1 ml-4 mt-1" role="status" aria-label={`${label}: ${text}`}>
      <div className={`flex items-center gap-1.5 text-xs ${color}`}>
        <span aria-hidden="true">{icon}</span>
        <span className="font-medium">{label}:</span>
        <span>{text}</span>
      </div>
      {errorMessage && status === 'failed' && (
        <div className="text-xs text-red-300 ml-5 opacity-75">{errorMessage}</div>
      )}
    </div>
  )
}
