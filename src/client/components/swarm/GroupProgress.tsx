import { useEffect, useMemo, useState } from 'react'
import type { GroupStatus, SwarmGroupState, WoStatus } from '../../../shared/swarmTypes'

export interface GroupProgressProps {
  group: SwarmGroupState | null
}

const GROUP_STATUS_STYLES: Record<GroupStatus, string> = {
  pending: 'bg-gray-600/30 text-gray-200 border border-gray-500/40',
  running: 'bg-blue-500/20 text-blue-300 border border-blue-500/40',
  completed: 'bg-green-500/20 text-green-300 border border-green-500/40',
  failed: 'bg-red-500/20 text-red-300 border border-red-500/40',
  aborted: 'bg-red-500/20 text-red-300 border border-red-500/40',
}

function formatCount(value: number, label: string): string {
  return `${value} ${label}${value === 1 ? '' : 's'}`
}

function formatTokens(value: number | null | undefined): string {
  if (!Number.isFinite(value)) {
    return '0'
  }

  if ((value ?? 0) >= 1000) {
    return `${((value ?? 0) / 1000).toFixed(1)}K`
  }

  return String(value ?? 0)
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`
  }

  return `${seconds}s`
}

function getRunningCount(wos: Record<string, { status: WoStatus }>): number {
  return Object.values(wos).filter((wo) => wo.status === 'running' || wo.status === 'escalated').length
}

function getPendingCount(group: SwarmGroupState, runningCount: number): number {
  return Math.max(0, group.totalWos - group.completedWos - group.failedWos - runningCount)
}

export default function GroupProgress({ group }: GroupProgressProps) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!group?.startedAt || group.status !== 'running') {
      return
    }

    const intervalId = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)

    return () => window.clearInterval(intervalId)
  }, [group?.startedAt, group?.status])

  const progress = useMemo(() => {
    if (!group) {
      return null
    }

    const runningCount = getRunningCount(group.wos)
    const pendingCount = getPendingCount(group, runningCount)

    return {
      runningCount,
      pendingCount,
      segments: [
        {
          key: 'completed',
          count: group.completedWos,
          className: 'bg-green-500',
        },
        {
          key: 'running',
          count: runningCount,
          className: 'bg-blue-500 animate-pulse',
        },
        {
          key: 'failed',
          count: group.failedWos,
          className: 'bg-red-500',
        },
        {
          key: 'pending',
          count: pendingCount,
          className: 'bg-gray-700',
        },
      ].filter((segment) => segment.count > 0),
    }
  }, [group])

  if (!group) {
    return (
      <div className="rounded-lg border border-white/10 bg-[#1a1a2e] px-4 py-3 text-sm text-gray-500">
        No active dispatch
      </div>
    )
  }

  const durationText =
    group.startedAt && group.status === 'running'
      ? `Running for ${formatElapsed(now - new Date(group.startedAt).getTime())}`
      : group.totalDurationSeconds !== null
        ? `Completed in ${formatElapsed(group.totalDurationSeconds * 1000)}`
        : null

  return (
    <div className="rounded-lg border border-white/10 bg-[#1a1a2e] px-4 py-3 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-gray-500">Dispatch Group</div>
          <div className="mt-1 flex items-center gap-2">
            <h3 className="text-sm font-semibold text-white">{group.groupId}</h3>
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${GROUP_STATUS_STYLES[group.status]}`}>
              {group.status}
            </span>
          </div>
        </div>
        <div className="text-right text-[11px] text-gray-400">
          <div>{group.totalWos} work orders</div>
          {durationText && <div className="mt-1 text-gray-300">{durationText}</div>}
        </div>
      </div>

      <div className="mt-4">
        <div className="h-3 w-full overflow-hidden rounded-full bg-[#111827] ring-1 ring-white/5">
          <div className="flex h-full w-full">
            {progress?.segments.map((segment) => (
              <div
                key={segment.key}
                className={segment.className}
                style={{ width: `${(segment.count / Math.max(group.totalWos, 1)) * 100}%` }}
                title={`${segment.key}: ${segment.count}`}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="text-gray-300">
          {group.completedWos}/{group.totalWos} completed
          <span className="text-gray-500"> | </span>
          {formatCount(group.failedWos, 'failed')}
          <span className="text-gray-500"> | </span>
          {formatCount(progress?.runningCount ?? 0, 'running')}
        </div>
        <div className="text-gray-400">
          {formatTokens(group.totalTokens.inputTokens)} input / {formatTokens(group.totalTokens.outputTokens)} output tokens
        </div>
      </div>
    </div>
  )
}
