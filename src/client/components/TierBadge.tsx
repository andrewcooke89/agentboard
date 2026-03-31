// TierBadge.tsx - Inline tier indicator with optional skipped steps list
import { useState } from 'react'

export interface TierBadgeProps {
  tier: number
  skippedSteps?: string[]
}

/** Chevron icon for expand/collapse */
function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path d="M6 4L10 8L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Tier color classes mapping */
const TIER_CLASSES = {
  1: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
  2: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
  3: 'bg-red-500/20 text-red-400 border-red-500/50',
}

/**
 * Small inline badge showing tier level (T1, T2, T3) with color coding.
 * Optionally shows skipped step count and expandable list of skipped steps.
 * REQ-28 to REQ-29
 */
export default function TierBadge({ tier, skippedSteps }: TierBadgeProps) {
  const [expanded, setExpanded] = useState(false)

  const tierClasses = TIER_CLASSES[tier as keyof typeof TIER_CLASSES] || TIER_CLASSES[1]
  const hasSkippedSteps = skippedSteps && skippedSteps.length > 0
  const skippedCount = skippedSteps?.length || 0

  const ariaLabel = `Tier ${tier}${hasSkippedSteps ? `, ${skippedCount} step${skippedCount > 1 ? 's' : ''} skipped` : ''}`

  return (
    <div className="inline-flex flex-col gap-1">
      <div className="inline-flex items-center gap-1">
        <span
          className={`inline-flex items-center px-1.5 py-0.5 text-xs font-semibold rounded border ${tierClasses}`}
          aria-label={ariaLabel}
        >
          T{tier}
        </span>
        {hasSkippedSteps && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs text-gray-400 hover:text-gray-300 hover:bg-gray-700/50 rounded transition-colors"
            aria-expanded={expanded}
            aria-label={`${skippedCount} step${skippedCount > 1 ? 's' : ''} skipped. Click to ${expanded ? 'collapse' : 'expand'}`}
          >
            <span>({skippedCount} skipped)</span>
            <ChevronIcon expanded={expanded} />
          </button>
        )}
      </div>
      {expanded && hasSkippedSteps && (
        <div className="ml-4 mt-1 p-2 bg-gray-800 border border-gray-700 rounded text-xs">
          <div className="text-gray-400 font-semibold mb-1">Skipped Steps:</div>
          <ul className="space-y-0.5">
            {skippedSteps.map((step, idx) => (
              <li key={idx} className="text-gray-300">
                • {step}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
