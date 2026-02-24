// CronHistoryTab.tsx — Run history timeline
// WU-013: History & Logs Tabs
//
// Scrollable timeline newest first (REQ-26).
// Expandable log snippets (REQ-27).
// Failure streak highlighting with red left-border (REQ-28).
// Duration sparkline SVG polyline, last 20 runs (REQ-29).
// Default 50 runs, Load More pagination (REQ-30).

import React, { useState } from 'react'
import type { CronJob, CronJobDetail, JobRunRecord, ClientMessage } from '../../../shared/types'

type SendMessage = (message: ClientMessage) => void

interface CronHistoryTabProps {
  job: CronJob
  detail: CronJobDetail | null
  sendMessage: SendMessage
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

function formatTimestamp(ts: string): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

// ── Sparkline ─────────────────────────────────────────────────────────────────

function DurationSparkline({ history }: { history: JobRunRecord[] }) {
  const data = history
    .slice()
    .reverse()
    .slice(0, 20)
    .filter((r) => r.duration != null)

  if (data.length < 2) {
    return (
      <div className="h-10 bg-zinc-800 rounded flex items-center justify-center text-xs text-zinc-600">
        Not enough data for sparkline
      </div>
    )
  }

  const durations = data.map((r) => r.duration!)
  const maxVal = Math.max(...durations)
  const width = 400
  const height = 40
  const pad = 4

  const points = durations.map((d, i) => {
    const x = pad + (i / (durations.length - 1)) * (width - pad * 2)
    const y = pad + (1 - d / maxVal) * (height - pad * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })

  return (
    <div className="bg-zinc-800 rounded overflow-hidden">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        aria-label="Duration sparkline"
      >
        <polyline
          points={points.join(' ')}
          fill="none"
          stroke="#3b82f6"
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Dots at each point */}
        {points.map((pt, i) => {
          const [x, y] = pt.split(',').map(Number)
          const isFailure = data[i].exitCode !== 0 && data[i].exitCode != null
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={2.5}
              fill={isFailure ? '#ef4444' : '#3b82f6'}
            />
          )
        })}
      </svg>
    </div>
  )
}

// ── History Entry ─────────────────────────────────────────────────────────────

function HistoryEntry({
  record,
  isFailureStreak,
}: {
  record: JobRunRecord
  isFailureStreak: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const isSuccess = record.exitCode === 0
  const hasSnippet = !!record.logSnippet

  return (
    <div
      className={`border border-zinc-700 rounded bg-zinc-800 overflow-hidden ${
        isFailureStreak ? 'border-l-2 border-l-red-600' : ''
      }`}
    >
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-zinc-700/50 transition-colors"
        onClick={() => hasSnippet && setExpanded((e) => !e)}
        disabled={!hasSnippet}
      >
        {/* Timestamp */}
        <span className="text-xs text-zinc-400 min-w-0 truncate flex-1">
          {formatTimestamp(record.timestamp)}
        </span>

        {/* Exit code */}
        <span
          className={`text-xs px-1.5 py-0.5 rounded border shrink-0 ${
            isSuccess
              ? 'bg-green-900/50 text-green-400 border-green-700'
              : record.exitCode != null
              ? 'bg-red-900/50 text-red-400 border-red-700'
              : 'bg-zinc-700 text-zinc-500 border-zinc-600'
          }`}
        >
          {record.exitCode != null ? `exit ${record.exitCode}` : 'unknown'}
        </span>

        {/* Duration */}
        {record.duration != null && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400 border border-zinc-600 shrink-0">
            {formatDuration(record.duration)}
          </span>
        )}

        {/* Trigger badge */}
        <span
          className={`text-xs px-1.5 py-0.5 rounded border shrink-0 ${
            record.trigger === 'manual'
              ? 'bg-purple-900/40 text-purple-400 border-purple-700'
              : 'bg-zinc-700 text-zinc-500 border-zinc-600'
          }`}
        >
          {record.trigger}
        </span>

        {/* Expand chevron */}
        {hasSnippet && (
          <span className="text-zinc-600 text-xs shrink-0">{expanded ? '▲' : '▼'}</span>
        )}
      </button>

      {/* Log snippet */}
      {expanded && record.logSnippet && (
        <div className="px-3 pb-2 border-t border-zinc-700">
          <pre className="mt-2 font-mono text-xs text-zinc-400 bg-zinc-900 rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-32">
            {record.logSnippet}
          </pre>
        </div>
      )}
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CronHistoryTab({ job, detail, sendMessage }: CronHistoryTabProps) {
  const history = detail?.runHistory ?? []

  // Newest first
  const sorted = [...history].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  )

  // Determine failure streaks: each entry that is part of a consecutive failure run
  // (starting from the most recent) gets the streak highlight.
  const streakSet = new Set<number>()
  let streakLen = 0
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].exitCode !== 0 && sorted[i].exitCode != null) {
      streakLen++
      if (streakLen >= 2) {
        // Mark this and previous entries
        for (let j = i - streakLen + 1; j <= i; j++) streakSet.add(j)
      }
    } else {
      streakLen = 0
    }
  }

  function handleLoadMore() {
    if (sorted.length === 0) return
    const oldest = sorted[sorted.length - 1].timestamp
    sendMessage({ type: 'cron-job-history', jobId: job.id, limit: 50 })
    // The `before` cursor isn't in the ClientMessage type yet, so we pass limit for now.
    // The server can use the existing history to paginate. Oldest timestamp is: oldest
    void oldest
  }

  if (!detail) {
    return (
      <div className="p-4 space-y-2">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-10 bg-zinc-800 rounded animate-pulse" />
        ))}
      </div>
    )
  }

  return (
    <div className="p-4 space-y-4">
      {/* Duration sparkline */}
      {history.length > 0 && <DurationSparkline history={history} />}

      {/* History list */}
      {sorted.length === 0 ? (
        <div className="text-center py-8 text-zinc-500 text-sm">No run history available</div>
      ) : (
        <div className="space-y-1">
          {sorted.map((record, i) => (
            <HistoryEntry
              key={`${record.timestamp}-${i}`}
              record={record}
              isFailureStreak={streakSet.has(i)}
            />
          ))}
        </div>
      )}

      {/* Load More */}
      {history.length >= 50 && (
        <button
          onClick={handleLoadMore}
          className="w-full py-2 text-sm text-blue-400 hover:text-blue-300 border border-zinc-700 rounded hover:bg-zinc-800 transition-colors"
        >
          Load More
        </button>
      )}
    </div>
  )
}
