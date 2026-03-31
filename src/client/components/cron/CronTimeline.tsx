// WU-017: Schedule Timeline — CronTimeline

import { useState, useMemo } from 'react'
import { motion } from 'motion/react'
import { useCronStore } from '../../stores/cronStore'
import type { CronJob } from '@shared/types'

// cron-parser v4+ uses CronExpression.parse (named export)
// We import it lazily to avoid build issues if the package name differs.
// The spec says: import { CronExpressionParser } from 'cron-parser'
// Actual package may export differently — we use a try/catch per-job.

type TimeRange = '24h' | '7d'

interface BucketJob {
  id: string
  name: string
  health: string
}

interface Bucket {
  label: string
  jobs: BucketJob[]
}

function buildBuckets(
  jobs: CronJob[],
  range: TimeRange
): Bucket[] {
  const now = new Date()
  const bucketCount = range === '24h' ? 24 : 7
  const bucketMs = range === '24h' ? 3_600_000 : 86_400_000

  const result: Bucket[] = []
  for (let i = 0; i < bucketCount; i++) {
    const bucketStart = new Date(now.getTime() + i * bucketMs)
    result.push({
      label:
        range === '24h'
          ? bucketStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : bucketStart.toLocaleDateString([], { weekday: 'short' }),
      jobs: [],
    })
  }

  let dataPoints = 0
  for (const job of jobs) {
    if (dataPoints >= 500) break
    if (!job.schedule || job.source.includes('systemd')) continue
    try {
      // Dynamic import of cron-parser to avoid hard dep at module load
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const cronParser = require('cron-parser') as {
        CronExpressionParser?: { parse: (expr: string, opts?: object) => { next: () => { toDate: () => Date } } }
        parseExpression?: (expr: string, opts?: object) => { next: () => { toDate: () => Date } }
      }

      // Support both cron-parser v4 (CronExpressionParser) and v3 (parseExpression)
      let iter: { next: () => { toDate: () => Date } } | null = null
      if (cronParser.CronExpressionParser?.parse) {
        iter = cronParser.CronExpressionParser.parse(job.schedule, { currentDate: now })
      } else if (cronParser.parseExpression) {
        iter = cronParser.parseExpression(job.schedule, { currentDate: now })
      }
      if (!iter) continue

      for (let i = 0; i < 50 && dataPoints < 500; i++) {
        let next: Date
        try {
          next = iter.next().toDate()
        } catch {
          break // iterator exhausted
        }
        const offsetMs = next.getTime() - now.getTime()
        if (offsetMs < 0) continue
        const bucketIdx = Math.floor(offsetMs / bucketMs)
        if (bucketIdx >= bucketCount) break
        result[bucketIdx].jobs.push({ id: job.id, name: job.name, health: job.health })
        dataPoints++
      }
    } catch (e) {
      console.warn('Failed to parse cron schedule:', job.schedule, e)
    }
  }

  return result
}

export function CronTimeline() {
  const filteredJobs = useCronStore((s) => s.filteredJobs)
  const setSelectedJob = useCronStore((s) => s.setSelectedJob)
  const timelineRange = useCronStore((s) => s.timelineRange)
  const setTimelineRange = useCronStore((s) => s.setTimelineRange)
  const [hoveredBucket, setHoveredBucket] = useState<number | null>(null)

  const jobs = filteredJobs()
  const range = timelineRange as TimeRange

  const buckets = useMemo(() => buildBuckets(jobs, range), [jobs, range])

  const maxJobs = Math.max(1, ...buckets.map((b) => b.jobs.length))

  if (jobs.length === 0) {
    return (
      <div className="p-4 text-center text-sm text-[var(--text-muted)]">
        No jobs to display
      </div>
    )
  }

  return (
    <div className="border-b border-[var(--border)] p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-[var(--text-muted)]">Schedule Timeline</span>
        <div className="flex gap-1">
          {(['24h', '7d'] as TimeRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setTimelineRange(r)}
              className={`text-xs px-2 py-0.5 rounded ${
                range === r
                  ? 'bg-blue-600 text-white'
                  : 'bg-[var(--bg-surface)] text-[var(--text-muted)]'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <motion.div
        className="flex items-end gap-px h-16"
        initial="hidden"
        animate="visible"
        variants={{ visible: { transition: { staggerChildren: 0.02 } } }}
      >
        {buckets.map((bucket, i) => {
          const height = bucket.jobs.length
            ? Math.max(4, (bucket.jobs.length / maxJobs) * 100)
            : 0
          const hasC = bucket.jobs.some((j) => j.health === 'critical')
          const hasW = bucket.jobs.some((j) => j.health === 'warning')
          const color = hasC
            ? 'bg-red-500'
            : hasW
              ? 'bg-yellow-500'
              : bucket.jobs.length
                ? 'bg-green-500'
                : 'bg-[var(--bg-hover)]'

          return (
            <motion.div
              key={i}
              className="flex-1 flex flex-col items-center relative"
              variants={{ hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0 } }}
              onMouseEnter={() => setHoveredBucket(i)}
              onMouseLeave={() => setHoveredBucket(null)}
            >
              <div
                className={`w-full rounded-t ${color} transition-all`}
                style={{ height: `${height}%` }}
              />
              <span className="text-[9px] text-[var(--text-muted)] mt-0.5 truncate w-full text-center">
                {bucket.label}
              </span>
              {hoveredBucket === i && bucket.jobs.length > 0 && (
                <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-[var(--bg-elevated)] border border-[var(--border)] rounded shadow-lg p-2 z-30 whitespace-nowrap">
                  {bucket.jobs.slice(0, 10).map((j) => (
                    <button
                      key={j.id}
                      onClick={() => setSelectedJob(j.id)}
                      className="block text-xs text-[var(--text-primary)] hover:text-blue-400"
                    >
                      {j.name}
                    </button>
                  ))}
                  {bucket.jobs.length > 10 && (
                    <div className="text-xs text-[var(--text-muted)]">
                      +{bucket.jobs.length - 10} more
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          )
        })}
      </motion.div>
    </div>
  )
}

export default CronTimeline
