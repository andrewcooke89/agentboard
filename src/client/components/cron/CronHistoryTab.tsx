// WU-013: History & Logs Tabs — CronHistoryTab

import React, { useState } from 'react'
import { useCronStore } from '../../stores/cronStore'
import type { JobRunRecord } from '@shared/types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

function formatTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return ts
  }
}

// ─── Duration Sparkline ───────────────────────────────────────────────────────

function DurationSparkline({ records }: { records: JobRunRecord[] }): React.ReactElement {
  const recent = records.slice(0, 20)
  const durations = recent.map((r) => r.duration ?? 0)
  const max = Math.max(...durations, 1)

  const width = 300
  const height = 40
  const barWidth = width / Math.max(durations.length, 1)

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="overflow-visible"
    >
      {durations.map((d, i) => {
        const barH = Math.max(2, (d / max) * (height - 4))
        const x = i * barWidth + 1
        const y = height - barH
        const record = recent[i]
        const isFailure = record.exitCode !== 0 && record.exitCode !== null
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={Math.max(1, barWidth - 2)}
            height={barH}
            className={isFailure ? 'fill-red-500/60' : 'fill-[var(--accent)]/60'}
          />
        )
      })}
    </svg>
  )
}

// ─── Failure streak detection ─────────────────────────────────────────────────

function countLeadingFailures(records: JobRunRecord[]): number {
  let count = 0
  for (const r of records) {
    if (r.exitCode !== 0 && r.exitCode !== null) {
      count++
    } else {
      break
    }
  }
  return count
}

// ─── Single history entry ─────────────────────────────────────────────────────

function HistoryEntry({
  record,
  isFailureStreak,
}: {
  record: JobRunRecord
  isFailureStreak: boolean
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const isFailure = record.exitCode !== 0 && record.exitCode !== null

  return (
    <div
      className={`border-b border-[var(--border)] ${isFailureStreak ? 'border-l-2 border-l-red-500' : ''}`}
    >
      <button
        className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-white/5 cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-xs text-[var(--text-muted)] shrink-0 tabular-nums">
          {formatTimestamp(record.timestamp)}
        </span>

        <span
          className={`text-xs px-1.5 py-0.5 rounded font-mono shrink-0 ${
            isFailure ? 'bg-red-900/40 text-red-400' : 'bg-green-900/40 text-green-400'
          }`}
        >
          {record.exitCode ?? '?'}
        </span>

        {record.duration != null && (
          <span className="text-xs text-[var(--text-muted)] shrink-0">
            {formatDuration(record.duration)}
          </span>
        )}

        <span className="text-xs text-[var(--text-muted)] capitalize px-1.5 py-0.5 rounded bg-[var(--bg-surface)] shrink-0">
          {record.trigger}
        </span>

        {record.logSnippet && (
          <span className="ml-auto text-xs text-[var(--text-muted)]">
            {expanded ? '▲' : '▼'}
          </span>
        )}
      </button>

      {expanded && record.logSnippet && (
        <pre className="px-4 pb-3 text-xs font-mono text-[var(--text-muted)] bg-[var(--bg-surface)] whitespace-pre-wrap overflow-x-auto">
          {record.logSnippet}
        </pre>
      )}
    </div>
  )
}

// ─── CronHistoryTab ───────────────────────────────────────────────────────────

export default function CronHistoryTab(): React.ReactElement {
  const { selectedJobId, selectedJobDetail } = useCronStore()

  const detail = selectedJobDetail?.id === selectedJobId ? selectedJobDetail : null
  const records = detail?.runHistory ?? []

  // newest first
  const sorted = [...records].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  )

  const streakCount = countLeadingFailures(sorted)

  function handleLoadMore() {
    if (sorted.length === 0 || !selectedJobId) return
    const oldest = sorted[sorted.length - 1].timestamp
    // Send WS message via global placeholder
    const send = (window as unknown as Record<string, unknown>).__cronWsSend as
      | ((msg: unknown) => void)
      | undefined
    send?.({ type: 'cron-job-history', jobId: selectedJobId, limit: 50, before: oldest })
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Sparkline */}
      <div className="px-4 pt-3 pb-2 border-b border-[var(--border)] shrink-0">
        <div className="text-xs text-[var(--text-muted)] mb-1">Duration (last {Math.min(sorted.length, 20)} runs)</div>
        {sorted.length > 0 ? (
          <DurationSparkline records={sorted} />
        ) : (
          <div className="h-10 flex items-center text-xs text-[var(--text-muted)] italic">No data</div>
        )}
      </div>

      {/* Streak warning */}
      {streakCount >= 2 && (
        <div className="flex items-center gap-2 px-4 py-2 bg-red-900/20 border-b border-red-500/30 shrink-0 text-xs text-red-400">
          <span className="font-semibold">⚠ {streakCount} consecutive failures</span>
        </div>
      )}

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="flex items-center justify-center h-full text-xs text-[var(--text-muted)]">
            No run history
          </div>
        ) : (
          sorted.map((record, i) => (
            <HistoryEntry
              key={`${record.timestamp}-${i}`}
              record={record}
              isFailureStreak={i < streakCount && streakCount >= 2}
            />
          ))
        )}
      </div>

      {/* Load more */}
      {sorted.length > 0 && (
        <div className="border-t border-[var(--border)] px-4 py-2 shrink-0">
          <button
            onClick={handleLoadMore}
            className="text-xs text-[var(--accent)] hover:underline"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  )
}
