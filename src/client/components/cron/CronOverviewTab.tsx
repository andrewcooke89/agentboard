// CronOverviewTab.tsx — Overview tab content for job detail pane
// WU-012: Detail Pane & Overview Tab
//
// Schedule section with live countdown (REQ-22).
// Duration stats: last/avg/trend indicator (REQ-23, REQ-63).
// Raw crontab line or systemd unit files with syntax highlighting (REQ-24, REQ-25).
// Yellow warning if latest duration > 2x average (REQ-23).

import React, { useState, useEffect } from 'react'
import type { CronJob, CronJobDetail } from '../../../shared/types'

interface CronOverviewTabProps {
  job: CronJob
  detail: CronJobDetail | null
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
  const d = new Date(ts)
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function formatCountdown(target: string): string {
  const diff = new Date(target).getTime() - Date.now()
  if (diff <= 0) return 'now'
  const totalSec = Math.floor(diff / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `in ${h}h ${m}m`
  if (m > 0) return `in ${m}m ${s}s`
  return `in ${s}s`
}

// Simple comment-line highlighter (lines starting with # or //)
function renderConfig(text: string): React.ReactNode {
  return text.split('\n').map((line, i) => {
    const isComment = /^\s*(#|\/\/)/.test(line)
    return (
      <div key={i} className={isComment ? 'text-zinc-500' : 'text-zinc-300'}>
        {line || '\u00A0'}
      </div>
    )
  })
}

// ── Skeleton ─────────────────────────────────────────────────────────────────

function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse bg-zinc-700 rounded ${className ?? ''}`} />
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CronOverviewTab({ job, detail }: CronOverviewTabProps) {
  const [countdown, setCountdown] = useState<string>(() =>
    job.nextRun ? formatCountdown(job.nextRun) : '—',
  )

  useEffect(() => {
    if (!job.nextRun) return
    const id = setInterval(() => {
      setCountdown(formatCountdown(job.nextRun!))
    }, 1000)
    return () => clearInterval(id)
  }, [job.nextRun])

  // Duration trend
  const last = job.lastRunDuration
  const avg = job.avgDuration
  let trendIcon = '→'
  let trendColor = 'text-zinc-400'
  if (last != null && avg != null && avg > 0) {
    if (last > avg * 1.1) { trendIcon = '↑'; trendColor = 'text-red-400' }
    else if (last < avg * 0.9) { trendIcon = '↓'; trendColor = 'text-green-400' }
  }
  const isSlowRun = last != null && avg != null && avg > 0 && last > avg * 2

  // Exit code badge
  const exitCode = job.lastExitCode
  const exitBadgeClass =
    exitCode === 0
      ? 'bg-green-900/50 text-green-400 border-green-700'
      : exitCode != null
      ? 'bg-red-900/50 text-red-400 border-red-700'
      : 'bg-zinc-700 text-zinc-500 border-zinc-600'

  if (!detail) {
    return (
      <div className="p-4 space-y-6">
        <section className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-40" />
        </section>
        <section className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-48" />
        </section>
        <section className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-20 w-full" />
        </section>
      </div>
    )
  }

  return (
    <div className="p-4 space-y-6 text-sm">
      {/* Schedule section */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">Schedule</h3>
        <div className="space-y-1">
          <p className="text-base text-zinc-200">{job.scheduleHuman || '—'}</p>
          <p className="font-mono text-xs text-zinc-500">{job.schedule}</p>
          {job.nextRun && (
            <p className="text-xs text-zinc-400">
              Next run: <span className="text-blue-400 font-medium">{countdown}</span>
              <span className="text-zinc-600 ml-1">({formatTimestamp(job.nextRun)})</span>
            </p>
          )}
        </div>
      </section>

      {/* Last Run section */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">Last Run</h3>
        {job.lastRun ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-zinc-300">{formatTimestamp(job.lastRun)}</span>
            {exitCode != null && (
              <span className={`text-xs px-1.5 py-0.5 rounded border ${exitBadgeClass}`}>
                exit {exitCode}
              </span>
            )}
            {job.lastRunDuration != null && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400 border border-zinc-600">
                {formatDuration(job.lastRunDuration)}
              </span>
            )}
          </div>
        ) : (
          <p className="text-zinc-500">No runs recorded</p>
        )}
      </section>

      {/* Duration Stats section */}
      {(last != null || avg != null) && (
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">Duration Stats</h3>

          {isSlowRun && (
            <div className="mb-2 px-3 py-2 bg-yellow-900/30 border border-yellow-700/50 rounded text-xs text-yellow-400">
              Last run took {formatDuration(last!)} — more than 2× the average ({avg != null ? formatDuration(avg) : '—'})
            </div>
          )}

          <div className="flex items-center gap-4">
            {last != null && (
              <div>
                <div className="text-xs text-zinc-500">Last</div>
                <div className="text-zinc-200">{formatDuration(last)}</div>
              </div>
            )}
            {avg != null && (
              <div>
                <div className="text-xs text-zinc-500">Average</div>
                <div className="text-zinc-200">{formatDuration(avg)}</div>
              </div>
            )}
            {last != null && avg != null && (
              <div className={`text-lg font-bold ${trendColor}`} title="Trend vs average">
                {trendIcon}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Raw config section */}
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 mb-2">Configuration</h3>

        {/* Cron sources: show raw crontab line */}
        {(job.source === 'user-crontab' || job.source === 'system-crontab') && detail.crontabLine && (
          <pre className="font-mono text-xs bg-zinc-900 border border-zinc-700 rounded p-3 overflow-x-auto whitespace-pre-wrap break-all">
            {renderConfig(detail.crontabLine)}
          </pre>
        )}

        {/* Systemd sources: show timer + service config */}
        {(job.source === 'systemd-user' || job.source === 'systemd-system') && (
          <div className="space-y-3">
            {detail.timerConfig && Object.keys(detail.timerConfig).length > 0 && (
              <div>
                <div className="text-xs text-zinc-500 mb-1">[Timer]</div>
                <pre className="font-mono text-xs bg-zinc-900 border border-zinc-700 rounded p-3 overflow-x-auto whitespace-pre-wrap">
                  {renderConfig(
                    Object.entries(detail.timerConfig)
                      .map(([k, v]) => `${k}=${v}`)
                      .join('\n'),
                  )}
                </pre>
              </div>
            )}
            {detail.serviceConfig && Object.keys(detail.serviceConfig).length > 0 && (
              <div>
                <div className="text-xs text-zinc-500 mb-1">[Service]</div>
                <pre className="font-mono text-xs bg-zinc-900 border border-zinc-700 rounded p-3 overflow-x-auto whitespace-pre-wrap">
                  {renderConfig(
                    Object.entries(detail.serviceConfig)
                      .map(([k, v]) => `${k}=${v}`)
                      .join('\n'),
                  )}
                </pre>
              </div>
            )}
            {/* Fallback: show raw command */}
            {(!detail.timerConfig || Object.keys(detail.timerConfig).length === 0) &&
              (!detail.serviceConfig || Object.keys(detail.serviceConfig).length === 0) && (
                <pre className="font-mono text-xs bg-zinc-900 border border-zinc-700 rounded p-3 overflow-x-auto">
                  {job.command}
                </pre>
              )}
          </div>
        )}

        {/* Fallback: raw command */}
        {job.source !== 'systemd-user' &&
          job.source !== 'systemd-system' &&
          !detail.crontabLine && (
            <pre className="font-mono text-xs bg-zinc-900 border border-zinc-700 rounded p-3 overflow-x-auto">
              {job.command}
            </pre>
          )}
      </section>
    </div>
  )
}
