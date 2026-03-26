import type { DashboardStats } from '../../shared/dashboardTypes'

interface StatsCardsProps {
  stats: DashboardStats | null
}

/**
 * Format uptime seconds as "Xh Ym"
 */
function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours}h ${minutes}m`
}

interface StatCardProps {
  value: string | number
  label: string
  accentColor: string
  textColor: string
}

function StatCard({ value, label, accentColor, textColor }: StatCardProps) {
  return (
    <div
      className={`
        flex flex-col justify-center
        w-[120px] h-[60px]
        bg-gray-800/60
        rounded-lg
        border border-gray-700/50
        border-l-2 ${accentColor}
        px-3 py-2
      `}
    >
      <div className={`text-lg font-semibold ${textColor}`}>
        {value}
      </div>
      <div className="text-xs text-gray-500">
        {label}
      </div>
    </div>
  )
}

function SkeletonCard() {
  return (
    <div
      className="
        w-[120px] h-[60px]
        bg-gray-700
        rounded-lg
        border border-gray-700/50
        animate-pulse
      "
    />
  )
}

export function StatsCards({ stats }: StatsCardsProps) {
  if (!stats) {
    return (
      <div className="flex flex-row gap-3 overflow-x-auto">
        {[...Array(6)].map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    )
  }

  const cards = [
    {
      value: stats.activeSessions,
      label: 'Active Sessions',
      accentColor: 'border-blue-500',
      textColor: 'text-blue-400',
    },
    {
      value: `${stats.runningTasks} / ${stats.totalTasks}`,
      label: 'Tasks',
      accentColor: 'border-green-500',
      textColor: 'text-green-400',
    },
    {
      value: stats.activeDispatches,
      label: 'Dispatches',
      accentColor: 'border-purple-500',
      textColor: 'text-purple-400',
    },
    {
      value: stats.totalWosCompleted,
      label: 'WOs Done',
      accentColor: 'border-green-500',
      textColor: 'text-green-400',
    },
    ...(stats.totalWosFailed > 0
      ? [
          {
            value: stats.totalWosFailed,
            label: 'WOs Failed',
            accentColor: 'border-red-500',
            textColor: 'text-red-500',
          },
        ]
      : []),
    {
      value: formatUptime(stats.uptimeSeconds),
      label: 'Uptime',
      accentColor: 'border-gray-500',
      textColor: 'text-gray-400',
    },
  ]

  return (
    <div className="flex flex-row gap-3 overflow-x-auto">
      {cards.map((card, i) => (
        <StatCard
          key={i}
          value={card.value}
          label={card.label}
          accentColor={card.accentColor}
          textColor={card.textColor}
        />
      ))}
    </div>
  )
}
