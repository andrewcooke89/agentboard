// WU-014: Script Tab & Job Controls — CronRunNowOutput

import React, { useEffect, useRef } from 'react'
import { motion } from 'motion/react'
import { useCronStore } from '../../stores/cronStore'

// ─── CronRunNowOutput ─────────────────────────────────────────────────────────

interface CronRunNowOutputProps {
  jobId: string
  onDismiss: () => void
}

export function CronRunNowOutput({ jobId, onDismiss }: CronRunNowOutputProps): React.ReactElement | null {
  const { runningJobs, runOutputs } = useCronStore()

  const isRunning = runningJobs.has(jobId)
  const outputText = runOutputs[jobId] ?? ''

  // Parse exit code and duration from the last line of the output if the run completed.
  // The store's handleCronRunCompleted records these — read from a separate ref so we
  // can display them after the job leaves runningJobs.
  const exitCodeRef = useRef<number | null>(null)
  const durationRef = useRef<number | null>(null)

  // Track completion data via store subscription would require extra plumbing;
  // instead, we expose a simpler approach: show the output and isRunning state.
  // The parent (CronJobDetail) passes jobId and we read from store directly.

  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom as new output arrives
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [outputText])

  // Nothing to show if no output and not running
  if (!outputText && !isRunning) return null

  // Try to extract exit code from a sentinel line the backend may emit
  // e.g. "\n__EXIT:0:1.23__\n" — this is a convention used in cronManager
  const sentinelMatch = outputText.match(/__EXIT:(-?\d+):([\d.]+)__/)
  const exitCode =
    sentinelMatch ? parseInt(sentinelMatch[1], 10) : (exitCodeRef.current ?? null)
  const duration =
    sentinelMatch ? parseFloat(sentinelMatch[2]) : (durationRef.current ?? null)

  if (sentinelMatch) {
    exitCodeRef.current = exitCode
    durationRef.current = duration
  }

  // Strip sentinel line from displayed output
  const displayText = outputText.replace(/__EXIT:-?\d+:[\d.]+__\n?/g, '')

  return (
    <motion.div
      className="border-t border-[var(--border)] bg-black/30 shrink-0"
      style={{ maxHeight: 220 }}
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2 }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] text-xs">
        <span className="font-semibold text-[var(--text-primary)]">Run Output</span>

        {isRunning && (
          <span className="flex items-center gap-1 text-yellow-400">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
            Running…
          </span>
        )}

        {!isRunning && exitCode !== null && (
          <>
            <span
              className={`px-1.5 py-0.5 rounded font-mono ${
                exitCode === 0 ? 'bg-green-900/40 text-green-400' : 'bg-red-900/40 text-red-400'
              }`}
            >
              exit {exitCode}
            </span>
            {duration !== null && (
              <span className="text-[var(--text-muted)]">{duration.toFixed(2)}s</span>
            )}
          </>
        )}

        {!isRunning && (
          <button
            onClick={onDismiss}
            className="ml-auto text-[var(--text-muted)] hover:text-[var(--text-primary)] text-sm leading-none"
            title="Dismiss"
          >
            ✕
          </button>
        )}
      </div>

      {/* Output */}
      <div
        ref={scrollRef}
        className="overflow-y-auto font-mono text-xs p-3 leading-5 whitespace-pre-wrap break-all"
        style={{ maxHeight: 170 }}
      >
        {displayText || <span className="text-[var(--text-muted)] italic">Waiting for output…</span>}
        {isRunning && <span className="animate-pulse text-[var(--text-muted)]">▊</span>}
      </div>
    </motion.div>
  )
}

export default CronRunNowOutput
