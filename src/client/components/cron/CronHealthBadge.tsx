// WU-010: List Pane Core — CronHealthBadge

import type { HealthStatus } from '@shared/types'

const HEALTH_CONFIG: Record<HealthStatus, { color: string; icon: string; label: string }> = {
  healthy: { color: 'text-green-500', icon: '●', label: 'Healthy' },
  warning: { color: 'text-yellow-500', icon: '▲', label: 'Warning' },
  critical: { color: 'text-red-500', icon: '✖', label: 'Critical' },
  unknown: { color: 'text-gray-500', icon: '?', label: 'Unknown' },
}

export function CronHealthBadge({ health, reason }: { health: HealthStatus; reason?: string | null }) {
  const cfg = HEALTH_CONFIG[health] || HEALTH_CONFIG.unknown
  return (
    <span
      className={`shrink-0 text-xs ${cfg.color}`}
      title={reason || cfg.label}
      aria-label={`Health: ${cfg.label}${reason ? ` - ${reason}` : ''}`}
    >
      {cfg.icon}
    </span>
  )
}

export default CronHealthBadge
