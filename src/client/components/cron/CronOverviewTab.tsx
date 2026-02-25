// WU-012: Detail Pane & Overview Tab — CronOverviewTab

import React, { useEffect, useState } from 'react'
import { useCronStore } from '../../stores/cronStore'

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

function formatCountdown(targetTs: string): string {
  const diff = new Date(targetTs).getTime() - Date.now()
  if (diff <= 0) return 'now'
  const s = Math.floor(diff / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

function TrendArrow({ last, avg }: { last: number; avg: number }): React.ReactElement {
  if (last > avg * 1.2) return <span className="text-red-400" title="Slower than average">↑</span>
  if (last < avg * 0.8) return <span className="text-green-400" title="Faster than average">↓</span>
  return <span className="text-[var(--text-muted)]" title="Stable">→</span>
}

// ─── CronOverviewTab ─────────────────────────────────────────────────────────

export default function CronOverviewTab(): React.ReactElement {
  const { selectedJobId, selectedJobDetail, jobs } = useCronStore()
  const [, setTick] = useState(0)

  // Tick every second to update countdown
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const job = jobs.find((j) => j.id === selectedJobId)
  const detail = selectedJobDetail?.id === selectedJobId ? selectedJobDetail : null

  // Prefer detail fields, fall back to job
  const schedule = detail?.schedule ?? job?.schedule ?? ''
  const scheduleHuman = detail?.scheduleHuman ?? job?.scheduleHuman ?? ''
  const nextRun = detail?.nextRun ?? job?.nextRun ?? null
  const lastRun = detail?.lastRun ?? job?.lastRun ?? null
  const lastExitCode = detail?.lastExitCode ?? job?.lastExitCode ?? null
  const lastRunDuration = detail?.lastRunDuration ?? job?.lastRunDuration ?? null
  const avgDuration = detail?.avgDuration ?? job?.avgDuration ?? null
  const source = detail?.source ?? job?.source ?? ''
  const isCron = source === 'user-crontab' || source === 'system-crontab'

  const durationWarning =
    lastRunDuration != null && avgDuration != null && lastRunDuration > avgDuration * 2

  if (!job) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
        No job selected
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 p-4 overflow-y-auto">
      {/* ── Schedule ─────────────────────────────────────────────────────── */}
      <section>
        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-3">
          Schedule
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium">{scheduleHuman || 'Unknown'}</div>
          <div className="text-xs font-mono text-[var(--text-muted)] bg-[var(--bg-surface)] px-2 py-1 rounded inline-block">
            {schedule}
          </div>

          <div className="grid grid-cols-2 gap-3 mt-3 text-xs">
            <div className="bg-[var(--bg-surface)] rounded p-2">
              <div className="text-[var(--text-muted)] mb-1">Next run</div>
              <div className="font-medium">
                {nextRun ? (
                  <>
                    <span className="text-[var(--accent)]">{formatCountdown(nextRun)}</span>
                    <div className="text-[var(--text-muted)] mt-0.5 text-[10px]">
                      {formatTimestamp(nextRun)}
                    </div>
                  </>
                ) : (
                  <span className="text-[var(--text-muted)]">Unknown</span>
                )}
              </div>
            </div>

            <div className="bg-[var(--bg-surface)] rounded p-2">
              <div className="text-[var(--text-muted)] mb-1">Last run</div>
              <div className="font-medium">
                {lastRun ? (
                  <>
                    <div className="flex items-center gap-1.5">
                      {lastExitCode != null && (
                        <span
                          className={`px-1 rounded font-mono ${
                            lastExitCode === 0
                              ? 'bg-green-900/40 text-green-400'
                              : 'bg-red-900/40 text-red-400'
                          }`}
                        >
                          {lastExitCode}
                        </span>
                      )}
                      {lastRunDuration != null && (
                        <span className="text-[var(--text-muted)]">
                          {formatDuration(lastRunDuration)}
                        </span>
                      )}
                    </div>
                    <div className="text-[var(--text-muted)] mt-0.5 text-[10px]">
                      {formatTimestamp(lastRun)}
                    </div>
                  </>
                ) : (
                  <span className="text-[var(--text-muted)]">Never</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Duration Stats ───────────────────────────────────────────────── */}
      <section>
        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-3">
          Duration
        </div>
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div className="bg-[var(--bg-surface)] rounded p-2">
            <div className="text-[var(--text-muted)] mb-1">Last</div>
            <div className={`font-medium ${durationWarning ? 'text-yellow-400' : ''}`}>
              {lastRunDuration != null ? formatDuration(lastRunDuration) : '—'}
              {durationWarning && (
                <span className="ml-1 text-yellow-400" title="More than 2x average">⚠</span>
              )}
            </div>
          </div>
          <div className="bg-[var(--bg-surface)] rounded p-2">
            <div className="text-[var(--text-muted)] mb-1">Average</div>
            <div className="font-medium">
              {avgDuration != null ? formatDuration(avgDuration) : '—'}
            </div>
          </div>
          <div className="bg-[var(--bg-surface)] rounded p-2">
            <div className="text-[var(--text-muted)] mb-1">Trend</div>
            <div className="font-medium text-base">
              {lastRunDuration != null && avgDuration != null ? (
                <TrendArrow last={lastRunDuration} avg={avgDuration} />
              ) : (
                <span className="text-[var(--text-muted)]">—</span>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── Raw Config ───────────────────────────────────────────────────── */}
      <section>
        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-3">
          Config
        </div>
        {isCron ? (
          <div>
            <div className="text-xs text-[var(--text-muted)] mb-1">Crontab line</div>
            <pre className="text-xs font-mono bg-[var(--bg-surface)] rounded p-3 overflow-x-auto whitespace-pre-wrap break-all">
              {detail?.crontabLine ?? job.schedule + '  ' + job.command}
            </pre>
          </div>
        ) : (
          <div className="space-y-3">
            {detail?.timerConfig && (
              <div>
                <div className="text-xs text-[var(--text-muted)] mb-1">Timer unit</div>
                <pre className="text-xs font-mono bg-[var(--bg-surface)] rounded p-3 overflow-x-auto whitespace-pre-wrap">
                  {detail.timerConfig}
                </pre>
              </div>
            )}
            {detail?.serviceConfig && (
              <div>
                <div className="text-xs text-[var(--text-muted)] mb-1">Service unit</div>
                <pre className="text-xs font-mono bg-[var(--bg-surface)] rounded p-3 overflow-x-auto whitespace-pre-wrap">
                  {detail.serviceConfig}
                </pre>
              </div>
            )}
            {!detail?.timerConfig && !detail?.serviceConfig && (
              <pre className="text-xs font-mono bg-[var(--bg-surface)] rounded p-3 overflow-x-auto whitespace-pre-wrap break-all">
                {job.command}
              </pre>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
