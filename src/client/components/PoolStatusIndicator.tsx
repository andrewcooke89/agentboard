// PoolStatusIndicator.tsx - Phase 15: Pool status indicator (REQ-10 to REQ-13)
import { useState, useEffect } from 'react'
import type { PoolStatus, PoolSlot, PoolQueueEntry } from '@shared/types'

export interface PoolStatusIndicatorProps {
  poolStatus: PoolStatus | null
}

/** Format duration in seconds to human-readable string */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const secs = seconds % 60
  if (minutes < 60) return `${minutes}m ${secs}s`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return `${hours}h ${mins}m`
}

/** Calculate elapsed seconds from ISO timestamp to now (guards against negative values) */
function getElapsedSeconds(startTime: string): number {
  const start = new Date(startTime).getTime()
  const now = Date.now()
  return Math.max(0, Math.floor((now - start) / 1000))
}

/** Tier badge component */
function TierBadge({ tier }: { tier: number }) {
  const colorMap: Record<number, string> = {
    1: 'bg-blue-900/50 text-blue-400 border-blue-700',
    2: 'bg-yellow-900/50 text-yellow-400 border-yellow-700',
    3: 'bg-red-900/50 text-red-400 border-red-700',
  }
  const color = colorMap[tier] ?? 'bg-gray-800 text-gray-400 border-gray-700'

  return (
    <span className={`inline-block px-1.5 py-0.5 text-[10px] rounded border ${color}`}>
      T{tier}
    </span>
  )
}

export default function PoolStatusIndicator({ poolStatus }: PoolStatusIndicatorProps) {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(Date.now())

  // Update timer every second when expanded AND poolStatus exists to refresh duration displays
  useEffect(() => {
    if (!expanded || !poolStatus) return
    const interval = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => clearInterval(interval)
  }, [expanded, poolStatus])

  // Pool inactive state
  if (!poolStatus) {
    return (
      <div className="bg-gray-800 border border-gray-700 rounded px-3 py-2">
        <div className="text-xs text-gray-500">Pool: inactive</div>
      </div>
    )
  }

  const activeCount = poolStatus.activeSlots.length
  const queuedCount = poolStatus.queue.length
  const maxSlots = poolStatus.maxSlots
  const utilization = maxSlots > 0 ? (activeCount / maxSlots) * 100 : 0

  const handleToggle = () => {
    setExpanded(!expanded)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      handleToggle()
    }
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded overflow-hidden">
      {/* Compact indicator bar */}
      <div
        className="px-3 py-2 cursor-pointer hover:bg-gray-700/50 transition-colors"
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`Pool status: ${activeCount} of ${maxSlots} active, ${queuedCount} queued. Click to ${expanded ? 'collapse' : 'expand'} details.`}
      >
        {/* Progress bar */}
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <div className="h-2 bg-gray-900 rounded-full overflow-hidden">
              <div
                className="h-full bg-green-500 transition-all duration-300"
                style={{ width: `${utilization}%` }}
              />
            </div>
          </div>
          <div className="text-xs text-white/70 whitespace-nowrap">
            {activeCount}/{maxSlots} active
            {queuedCount > 0 && (
              <span className="text-white/50"> | {queuedCount} queued</span>
            )}
          </div>
        </div>
      </div>

      {/* Detail panel */}
      {expanded && (
        <div className="border-t border-gray-700 p-3">
          {/* Active Sessions section */}
          {activeCount > 0 && (
            <div className="mb-4">
              <h4 className="text-[10px] text-white/40 uppercase tracking-wider mb-2">
                Active Sessions
              </h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-white/40 text-[10px] uppercase tracking-wider">
                      <th className="text-left py-1 px-2 font-medium">Run ID</th>
                      <th className="text-left py-1 px-2 font-medium">Step</th>
                      <th className="text-left py-1 px-2 font-medium">Tier</th>
                      <th className="text-right py-1 px-2 font-medium">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {poolStatus.activeSlots.map((slot) => (
                      <ActiveSlotRow key={slot.slotId} slot={slot} now={now} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Queue section */}
          {queuedCount > 0 && (
            <div>
              <h4 className="text-[10px] text-white/40 uppercase tracking-wider mb-2">
                Queue
              </h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-white/40 text-[10px] uppercase tracking-wider">
                      <th className="text-left py-1 px-2 font-medium">Pos</th>
                      <th className="text-left py-1 px-2 font-medium">Run ID</th>
                      <th className="text-left py-1 px-2 font-medium">Step</th>
                      <th className="text-left py-1 px-2 font-medium">Tier</th>
                      <th className="text-right py-1 px-2 font-medium">Wait Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {poolStatus.queue.map((entry) => (
                      <QueueEntryRow key={`${entry.runId}-${entry.stepName}`} entry={entry} now={now} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Empty state */}
          {activeCount === 0 && queuedCount === 0 && (
            <div className="text-xs text-white/30 text-center py-4">
              No active sessions or queued steps
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Active slot row component */
function ActiveSlotRow({ slot, now: _now }: { slot: PoolSlot; now: number }) {
  const duration = getElapsedSeconds(slot.startedAt)

  return (
    <tr className="border-b border-gray-700/50">
      <td className="py-2 px-2 text-white/60 font-mono">{slot.runId.slice(0, 8)}</td>
      <td className="py-2 px-2 text-white/80">{slot.stepName}</td>
      <td className="py-2 px-2">
        <TierBadge tier={slot.tier} />
      </td>
      <td className="py-2 px-2 text-right text-white/60">{formatDuration(duration)}</td>
    </tr>
  )
}

/** Queue entry row component */
function QueueEntryRow({ entry, now: _now }: { entry: PoolQueueEntry; now: number }) {
  const waitTime = getElapsedSeconds(entry.requestedAt)

  return (
    <tr className="border-b border-gray-700/50">
      <td className="py-2 px-2 text-white/40">#{entry.position}</td>
      <td className="py-2 px-2 text-white/60 font-mono">{entry.runId.slice(0, 8)}</td>
      <td className="py-2 px-2 text-white/80">{entry.stepName}</td>
      <td className="py-2 px-2">
        <TierBadge tier={entry.tier} />
      </td>
      <td className="py-2 px-2 text-right text-white/60">{formatDuration(waitTime)}</td>
    </tr>
  )
}
