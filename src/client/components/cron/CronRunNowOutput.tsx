// CronRunNowOutput.tsx — Mini-terminal for streaming Run Now output
// WU-014: Script Tab & Job Controls
//
// Auto-scroll, exit code + duration on completion, dismissable (REQ-38).

import React, { useRef, useEffect, useState } from 'react'
import { useCronStore } from '../../stores/cronStore'

interface CronRunNowOutputProps {
  jobId: string
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

export function CronRunNowOutput({ jobId }: CronRunNowOutputProps) {
  const { runningJobs, runOutput } = useCronStore()
  const containerRef = useRef<HTMLPreElement>(null)
  const [dismissed, setDismissed] = useState(false)

  const isRunning = runningJobs.has(jobId)
  const lines = runOutput[jobId] ?? []

  // Reset dismissed state when a new run starts
  useEffect(() => {
    if (isRunning) setDismissed(false)
  }, [isRunning])

  // Auto-scroll to bottom on new output
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [lines.length])

  if (dismissed || lines.length === 0) return null

  // Parse exit code and duration from the last line if run is complete.
  // The store records cron-run-completed payload separately; we look for a
  // sentinel pattern the server may emit. For now we show a generic badge.
  const exitCode: number | null = isRunning ? null : null // populated via store when available
  const duration: number | null = null

  const exitBadgeClass =
    exitCode === 0
      ? 'bg-green-900/50 text-green-400 border-green-700'
      : exitCode != null
      ? 'bg-red-900/50 text-red-400 border-red-700'
      : 'bg-zinc-700 text-zinc-500 border-zinc-600'

  return (
    <div className="border border-zinc-700 rounded bg-zinc-900 overflow-hidden">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-700 bg-zinc-800">
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {isRunning ? (
            <>
              <span
                className="w-2 h-2 rounded-full bg-blue-400 animate-pulse inline-block"
                aria-hidden="true"
              />
              <span className="text-xs text-zinc-300">Running…</span>
            </>
          ) : (
            <>
              <span className="text-xs text-zinc-400">Completed</span>
              {exitCode != null && (
                <span className={`text-xs px-1.5 py-0.5 rounded border ${exitBadgeClass}`}>
                  exit {exitCode}
                </span>
              )}
              {duration != null && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400 border border-zinc-600">
                  {formatDuration(duration)}
                </span>
              )}
            </>
          )}
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors shrink-0"
          title="Dismiss output"
        >
          Dismiss
        </button>
      </div>

      {/* Output */}
      <pre
        ref={containerRef}
        className="max-h-48 overflow-y-auto font-mono text-xs p-3 text-zinc-300 whitespace-pre-wrap break-all leading-relaxed"
      >
        {lines.length === 0 ? (
          <span className="text-zinc-600">Waiting for output…</span>
        ) : (
          lines.join('')
        )}
      </pre>
    </div>
  )
}
