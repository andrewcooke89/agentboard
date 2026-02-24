// CronTimeline.tsx — Schedule timeline visualization
// WU-018: Schedule Timeline
//
// Collapsible horizontal bar chart above split pane (REQ-77).
// 24-hour (1h buckets, default) and 7-day (daily buckets) ranges (REQ-78).
// Stacked bars colored by health status.
// Hover tooltip lists job names; click selects job (REQ-79).
// Client-side projection capped at 500 data points (REQ-80).
// Renders within 100ms for 200 jobs (REQ-93).

import React, { useMemo } from 'react'
import { useCronStore, type TimelineRange } from '../../stores/cronStore'
import type { CronJob } from '../../../shared/types'

// ── Types ─────────────────────────────────────────────────────────────────────

interface BucketEntry {
  jobId: string
  jobName: string
  health: string
}

interface Bucket {
  label: string
  start: number
  end: number
  entries: BucketEntry[]
}

// ── Health colors ─────────────────────────────────────────────────────────────

const HEALTH_COLOR: Record<string, string> = {
  healthy: 'bg-green-500',
  warning: 'bg-yellow-500',
  critical: 'bg-red-500',
  unknown: 'bg-zinc-500',
}

const HEALTH_ORDER = ['critical', 'warning', 'unknown', 'healthy']

// ── Bucket helpers ────────────────────────────────────────────────────────────

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function buildBuckets(range: TimelineRange): Bucket[] {
  const now = Date.now()

  if (range === '24h') {
    // 24 hourly buckets starting from the current hour
    const hourStart = new Date(now)
    hourStart.setMinutes(0, 0, 0)
    const base = hourStart.getTime()

    return Array.from({ length: 24 }, (_, i) => {
      const start = base + i * 3600_000
      const label = i === 0 ? 'now' : `${new Date(start).getHours()}h`
      return { label, start, end: start + 3600_000, entries: [] }
    })
  } else {
    // 7 daily buckets starting today
    const dayStart = new Date(now)
    dayStart.setHours(0, 0, 0, 0)
    const base = dayStart.getTime()

    return Array.from({ length: 7 }, (_, i) => {
      const start = base + i * 86_400_000
      const label = i === 0 ? 'Today' : DAY_LABELS[new Date(start).getDay()]
      return { label, start, end: start + 86_400_000, entries: [] }
    })
  }
}

function fillBuckets(buckets: Bucket[], jobs: CronJob[]): Bucket[] {
  // Cap at 500 data points total
  let dataPoints = 0
  const MAX_POINTS = 500

  for (const job of jobs) {
    if (dataPoints >= MAX_POINTS) break

    // Use nextRun and nextRuns to place job in buckets
    const runTimes: number[] = []

    if (job.nextRun) {
      const t = new Date(job.nextRun).getTime()
      if (!isNaN(t)) runTimes.push(t)
    }

    if (job.nextRuns) {
      for (const r of job.nextRuns) {
        const t = new Date(r).getTime()
        if (!isNaN(t)) runTimes.push(t)
      }
    }

    for (const t of runTimes) {
      if (dataPoints >= MAX_POINTS) break
      for (const bucket of buckets) {
        if (t >= bucket.start && t < bucket.end) {
          bucket.entries.push({ jobId: job.id, jobName: job.name, health: job.health })
          dataPoints++
          break
        }
      }
    }
  }

  return buckets
}

// ── Bar column ────────────────────────────────────────────────────────────────

function BarColumn({
  bucket,
  maxCount,
  onSelectJob,
}: {
  bucket: Bucket
  maxCount: number
  onSelectJob: (id: string) => void
}) {
  const totalHeight = 64 // px — matches h-16 container

  // Group by health for stacking
  const byHealth = HEALTH_ORDER.reduce<Record<string, BucketEntry[]>>((acc, h) => {
    acc[h] = bucket.entries.filter((e) => e.health === h)
    return acc
  }, {})

  const tooltip = bucket.entries.length
    ? bucket.entries.map((e) => e.jobName).join('\n')
    : 'No runs'

  const barHeight = maxCount > 0 ? Math.round((bucket.entries.length / maxCount) * totalHeight) : 0

  return (
    <div className="flex flex-col items-center gap-0.5 flex-1 min-w-0">
      {/* Bar */}
      <div
        className="w-full flex flex-col-reverse items-stretch cursor-default"
        style={{ height: totalHeight }}
        title={tooltip}
        onClick={() => {
          if (bucket.entries.length > 0) {
            onSelectJob(bucket.entries[0].jobId)
          }
        }}
      >
        {barHeight > 0 && (
          <div
            className="w-full flex flex-col-reverse overflow-hidden rounded-sm"
            style={{ height: barHeight }}
          >
            {HEALTH_ORDER.map((h) => {
              const count = byHealth[h]?.length ?? 0
              if (count === 0) return null
              const segHeight = Math.round((count / bucket.entries.length) * barHeight)
              return (
                <div
                  key={h}
                  className={`w-full ${HEALTH_COLOR[h] ?? 'bg-zinc-500'} opacity-90`}
                  style={{ height: segHeight }}
                />
              )
            })}
          </div>
        )}
      </div>

      {/* Label */}
      <span className="text-[10px] text-zinc-500 truncate w-full text-center leading-tight">
        {bucket.label}
      </span>
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

interface CronTimelineProps {
  jobs?: CronJob[]
  onSelectJob?: (id: string) => void
}

export function CronTimeline({ jobs: jobsProp, onSelectJob: onSelectJobProp }: CronTimelineProps) {
  const { jobs: storeJobs, timelineRange, setTimelineRange, setSelectedJobId } = useCronStore()
  const jobs = jobsProp ?? storeJobs
  const onSelectJob = onSelectJobProp ?? setSelectedJobId

  const buckets = useMemo(() => {
    const empty = buildBuckets(timelineRange)
    return fillBuckets(empty, jobs)
  }, [jobs, timelineRange])

  const maxCount = useMemo(
    () => Math.max(1, ...buckets.map((b) => b.entries.length)),
    [buckets],
  )

  const totalRuns = buckets.reduce((s, b) => s + b.entries.length, 0)

  return (
    <div className="px-3 py-2">
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-400 font-medium">Timeline</span>
          <span className="text-xs text-zinc-600">({totalRuns} scheduled runs)</span>
        </div>

        {/* Range toggle */}
        <div className="flex gap-1">
          {(['24h', '7d'] as TimelineRange[]).map((range) => (
            <button
              key={range}
              onClick={() => setTimelineRange(range)}
              className={`px-2 py-0.5 text-xs rounded transition-colors ${
                timelineRange === range
                  ? 'bg-blue-600 text-white'
                  : 'bg-zinc-700 text-zinc-400 hover:bg-zinc-600'
              }`}
            >
              {range}
            </button>
          ))}
        </div>
      </div>

      {/* Bar chart */}
      <div className="flex items-end gap-px h-16">
        {buckets.map((bucket, i) => (
          <BarColumn
            key={i}
            bucket={bucket}
            maxCount={maxCount}
            onSelectJob={onSelectJob}
          />
        ))}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 mt-1">
        {Object.entries(HEALTH_COLOR).map(([health, color]) => (
          <div key={health} className="flex items-center gap-1">
            <div className={`w-2 h-2 rounded-sm ${color}`} />
            <span className="text-[10px] text-zinc-500 capitalize">{health}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
