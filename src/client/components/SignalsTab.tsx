// SignalsTab.tsx - Signals tab content for run detail page, showing detected signals
import { useState } from 'react'
import type { DetectedSignal } from '@shared/types'

export interface SignalsTabProps {
  signals: DetectedSignal[]
}

/** Resolution status badge colors */
const RESOLUTION_CLASSES = {
  pending: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
  resolved: 'bg-green-500/20 text-green-400 border-green-500/50',
  timeout: 'bg-red-500/20 text-red-400 border-red-500/50',
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

/** Signal type icon */
function SignalIcon() {
  return (
    <svg className="w-4 h-4 shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2" fill="currentColor" />
      <path
        d="M4 8a4 4 0 0 1 4-4m0 8a4 4 0 0 0 4-4m-4-4a4 4 0 0 1 4 4m-8 0a4 4 0 0 1 4-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Format timestamp for display */
function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/** Single signal row component */
function SignalRow({ signal }: { signal: DetectedSignal }) {
  const [expanded, setExpanded] = useState(false)
  const resolutionClasses = RESOLUTION_CLASSES[signal.resolutionStatus] || RESOLUTION_CLASSES.pending

  const hasContent = signal.content !== null && signal.content !== ''
  const hasCheckpointData = signal.checkpointData !== null

  return (
    <div className="border border-gray-700 rounded bg-gray-800/50">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 p-3 hover:bg-gray-700/30 transition-colors text-left"
        aria-expanded={expanded}
        aria-label={`Signal ${signal.type}. Status: ${signal.resolutionStatus}. Click to ${expanded ? 'collapse' : 'expand'}`}
      >
        <ChevronIcon expanded={expanded} />
        <SignalIcon />
        <span className="px-2 py-0.5 text-xs font-mono bg-gray-700 text-gray-300 rounded border border-gray-600">
          {signal.type}
        </span>
        <span className="text-xs text-gray-400">
          {formatTimestamp(signal.timestamp)}
        </span>
        <span className={`ml-auto px-2 py-0.5 text-xs font-semibold rounded border ${resolutionClasses}`}>
          {signal.resolutionStatus}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-gray-700 bg-gray-900/30">
          {hasContent && (
            <div className="mt-3">
              <div className="text-xs text-gray-400 font-semibold mb-1">Content:</div>
              <pre className="text-xs text-gray-300 bg-gray-900 p-2 rounded border border-gray-700 overflow-x-auto whitespace-pre-wrap">
                {signal.content}
              </pre>
            </div>
          )}

          {hasCheckpointData && signal.checkpointData && (
            <div>
              <div className="text-xs text-gray-400 font-semibold mb-2">Checkpoint Data:</div>
              <div className="bg-gray-900 p-3 rounded border border-gray-700 space-y-2 text-xs">
                {signal.checkpointData.completedSubtasks && signal.checkpointData.completedSubtasks.length > 0 && (
                  <div>
                    <div className="text-gray-400 font-semibold mb-1">Completed Subtasks:</div>
                    <ul className="space-y-0.5 ml-3">
                      {signal.checkpointData.completedSubtasks.map((task, idx) => (
                        <li key={idx} className="text-gray-300">
                          • {task}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {signal.checkpointData.filesModified && signal.checkpointData.filesModified.length > 0 && (
                  <div>
                    <div className="text-gray-400 font-semibold mb-1">Files Modified:</div>
                    <ul className="space-y-0.5 ml-3">
                      {signal.checkpointData.filesModified.map((file, idx) => (
                        <li key={idx} className="text-gray-300 font-mono text-[11px]">
                          • {file}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {signal.checkpointData.buildStatus && (
                  <div>
                    <div className="text-gray-400 font-semibold mb-1">Build Status:</div>
                    <span className="text-gray-300">{signal.checkpointData.buildStatus}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Signals tab content showing all detected signals during a workflow run.
 * Each signal displays type, timestamp, resolution status, and expandable details.
 * REQ-30 to REQ-31
 */
export default function SignalsTab({ signals }: SignalsTabProps) {
  if (!signals || signals.length === 0) {
    return (
      <div className="flex items-center justify-center p-12 text-gray-500">
        No signals detected
      </div>
    )
  }

  return (
    <div className="space-y-2 p-4">
      {signals.map((signal) => (
        <SignalRow key={signal.id} signal={signal} />
      ))}
    </div>
  )
}
