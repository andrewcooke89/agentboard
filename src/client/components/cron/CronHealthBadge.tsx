// CronHealthBadge.tsx — Health status icon with color and tooltip
// WU-010: List Pane Core

import React from 'react'

type HealthStatus = 'healthy' | 'warning' | 'critical' | 'unknown'

interface CronHealthBadgeProps {
  health: HealthStatus
  reason?: string | null
  size?: 'sm' | 'md'
}

const HEALTH_CONFIG: Record<HealthStatus, { color: string; icon: string; label: string }> = {
  healthy:  { color: 'text-green-400',  icon: '✓', label: 'Healthy' },
  warning:  { color: 'text-yellow-400', icon: '⚠', label: 'Warning' },
  critical: { color: 'text-red-400',    icon: '✕', label: 'Critical' },
  unknown:  { color: 'text-zinc-500',   icon: '?', label: 'Unknown' },
}

export function CronHealthBadge({ health, reason, size = 'sm' }: CronHealthBadgeProps) {
  const config = HEALTH_CONFIG[health] ?? HEALTH_CONFIG.unknown
  const tooltip = reason ? `${config.label}: ${reason}` : config.label

  return (
    <span
      className={`${config.color} ${size === 'sm' ? 'text-xs' : 'text-sm'} font-bold leading-none select-none`}
      aria-label={`Health: ${config.label}${reason ? ` — ${reason}` : ''}`}
      title={tooltip}
      role="img"
    >
      {config.icon}
    </span>
  )
}
