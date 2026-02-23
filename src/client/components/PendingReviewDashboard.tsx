import { useState, useEffect, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import type { PendingReviewItem, PendingReviewType } from '@shared/types'
import { formatRelativeTime } from '../utils/time'

export interface PendingReviewDashboardProps {
  items: PendingReviewItem[]
  onResolve: (itemId: string, action: string) => void
  quickApproveEnabled?: boolean
  quickApproveDelayMs?: number
}

const ITEM_TYPE_COLORS: Record<PendingReviewType, string> = {
  amendment_approval: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
  concern_verdict: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  escalated_review_loop: 'bg-red-500/20 text-red-300 border-red-500/30',
  budget_exhaustion: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
}

const ITEM_TYPE_LABELS: Record<PendingReviewType, string> = {
  amendment_approval: 'Amendment Approval',
  concern_verdict: 'Concern Verdict',
  escalated_review_loop: 'Escalated Review',
  budget_exhaustion: 'Budget Exhaustion',
}

const ACTION_BUTTONS: Record<PendingReviewType, string[]> = {
  amendment_approval: ['Approve', 'Reject', 'Defer'],
  concern_verdict: ['Accept', 'Reject'],
  escalated_review_loop: ['Accept', 'Reject', 'Restart'],
  budget_exhaustion: ['Extend Budget', 'Reject'],
}

const TIER_COLORS: Record<number, string> = {
  1: 'bg-green-500/20 text-green-300 border-green-500/30',
  2: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  3: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
  4: 'bg-red-500/20 text-red-300 border-red-500/30',
}

function getTierColor(tier: number): string {
  return TIER_COLORS[tier] || 'bg-gray-500/20 text-gray-300 border-gray-500/30'
}

export default function PendingReviewDashboard({
  items,
  onResolve,
  quickApproveEnabled = false,
  quickApproveDelayMs = 300000, // 5 minutes default
}: PendingReviewDashboardProps) {
  const [currentTime, setCurrentTime] = useState(Date.now())
  const [quickApproveActive, setQuickApproveActive] = useState(quickApproveEnabled)
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null)
  const [autoApprovedItems, setAutoApprovedItems] = useState<Set<string>>(new Set())

  // Update current time every second for elapsed time calculations
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now())
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  // Sort items by wait time (longest first)
  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      const aTime = new Date(a.waitingSince).getTime()
      const bTime = new Date(b.waitingSince).getTime()
      return aTime - bTime // Older items first
    })
  }, [items])

  // Calculate which items are eligible for quick approve
  const quickApproveEligible = useMemo(() => {
    if (!quickApproveActive) return new Set<string>()

    const eligible = new Set<string>()
    for (const item of sortedItems) {
      // Only Tier 1 low-severity items are eligible
      if (item.tier === 1 && item.severity === 'low') {
        const waitTime = currentTime - new Date(item.waitingSince).getTime()
        if (waitTime >= quickApproveDelayMs) {
          eligible.add(item.id)
        }
      }
    }
    return eligible
  }, [sortedItems, quickApproveActive, currentTime, quickApproveDelayMs])

  // Auto-approve eligible items (with idempotency guard)
  useEffect(() => {
    for (const itemId of quickApproveEligible) {
      if (!autoApprovedItems.has(itemId)) {
        setAutoApprovedItems(prev => new Set(prev).add(itemId))
        onResolve(itemId, 'auto-approve')
      }
    }
  }, [quickApproveEligible, onResolve, autoApprovedItems])

  // Calculate countdown for quick approve items
  const getQuickApproveCountdown = useCallback((item: PendingReviewItem): number | null => {
    if (!quickApproveActive || item.tier !== 1 || item.severity !== 'low') {
      return null
    }
    const waitTime = currentTime - new Date(item.waitingSince).getTime()
    const remaining = quickApproveDelayMs - waitTime
    return Math.max(0, Math.ceil(remaining / 1000))
  }, [quickApproveActive, currentTime, quickApproveDelayMs])

  const handleKeyDown = useCallback((e: React.KeyboardEvent, itemId: string) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      setExpandedItemId(expandedItemId === itemId ? null : itemId)
    }
  }, [expandedItemId])

  const handleToggleQuickApprove = () => {
    setQuickApproveActive(!quickApproveActive)
  }

  return (
    <div className="flex h-full flex-col bg-gray-900">
      {/* Header */}
      <div className="shrink-0 border-b border-gray-700 bg-gray-800 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-white">Pending Reviews</h2>
            {items.length > 0 && (
              <span className="flex h-6 min-w-[24px] items-center justify-center rounded-full bg-orange-500/20 px-2 text-xs font-medium text-orange-300">
                {items.length}
              </span>
            )}
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={quickApproveActive}
              onChange={handleToggleQuickApprove}
              className="h-4 w-4 rounded border-gray-600 bg-gray-700 text-green-500 focus:ring-2 focus:ring-green-500 focus:ring-offset-0"
            />
            Quick Approve
          </label>
        </div>
      </div>

      {/* Items list */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {sortedItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <svg
              className="mb-3 h-12 w-12 text-green-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <p className="text-lg font-medium text-gray-300">No items pending review</p>
            <p className="mt-1 text-sm text-gray-500">All pipelines are running smoothly</p>
          </div>
        ) : (
          <div className="space-y-3">
            <AnimatePresence initial={false}>
              {sortedItems.map((item) => {
                const countdown = getQuickApproveCountdown(item)
                const elapsedTime = formatRelativeTime(item.waitingSince)
                const isExpanded = expandedItemId === item.id

                return (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.2 }}
                  >
                    <div
                      className="rounded-lg border border-gray-700 bg-gray-800 p-4 shadow-sm transition-colors hover:border-gray-600"
                      role="button"
                      tabIndex={0}
                      onClick={() => setExpandedItemId(isExpanded ? null : item.id)}
                      onKeyDown={(e) => handleKeyDown(e, item.id)}
                    >
                      {/* Item header */}
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 space-y-2">
                          {/* Pipeline name */}
                          <div className="font-medium text-white">
                            {item.pipelineName}
                          </div>

                          {/* Badges row */}
                          <div className="flex flex-wrap items-center gap-2">
                            {/* Item type badge */}
                            <span className={`rounded border px-2 py-0.5 text-xs font-medium ${ITEM_TYPE_COLORS[item.itemType]}`}>
                              {ITEM_TYPE_LABELS[item.itemType]}
                            </span>

                            {/* Tier badge */}
                            <span className={`rounded border px-2 py-0.5 text-xs font-medium ${getTierColor(item.tier)}`}>
                              Tier {item.tier}
                            </span>

                            {/* Step name */}
                            <span className="text-xs text-gray-400">
                              {item.stepName}
                            </span>
                          </div>

                          {/* Elapsed time / countdown */}
                          <div className="text-sm text-gray-400">
                            {countdown !== null ? (
                              <span className="text-yellow-300">
                                (auto-approving in {countdown}s)
                              </span>
                            ) : (
                              `Waiting for ${elapsedTime}`
                            )}
                          </div>

                          {/* Details (when expanded) */}
                          {isExpanded && Object.keys(item.details).length > 0 && (
                            <motion.div
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto' }}
                              exit={{ opacity: 0, height: 0 }}
                              className="mt-3 space-y-1 rounded bg-gray-900 p-3 text-xs"
                            >
                              {Object.entries(item.details).map(([key, value]) => (
                                <div key={key} className="flex gap-2">
                                  <span className="font-medium text-gray-400">{key}:</span>
                                  <span className="text-gray-300">
                                    {typeof value === 'string' ? value : JSON.stringify(value)}
                                  </span>
                                </div>
                              ))}
                            </motion.div>
                          )}
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div className="mt-3 flex flex-wrap gap-2">
                        {ACTION_BUTTONS[item.itemType].map((action) => (
                          <button
                            key={action}
                            onClick={(e) => {
                              e.stopPropagation()
                              onResolve(item.id, action.toLowerCase().replace(' ', '_'))
                            }}
                            className={`rounded px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 ${
                              action === 'Approve' || action === 'Accept' || action === 'Extend Budget'
                                ? 'bg-green-600 text-white hover:bg-green-700 focus:ring-green-500'
                                : action === 'Reject'
                                  ? 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500'
                                  : 'bg-gray-600 text-white hover:bg-gray-700 focus:ring-gray-500'
                            }`}
                          >
                            {action}
                          </button>
                        ))}
                      </div>
                    </div>
                  </motion.div>
                )
              })}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  )
}
