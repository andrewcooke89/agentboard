// WU-009: App Integration & CronManager Shell — Empty State

import { useCronStore } from '../../stores/cronStore'

export function CronEmptyState({ onCreateJob }: { onCreateJob?: () => void }) {
  const jobs = useCronStore(s => s.jobs)
  const active = jobs.filter(j => j.status === 'active').length
  const paused = jobs.filter(j => j.status === 'paused').length
  const errors = jobs.filter(j => j.status === 'error').length
  const unhealthy = jobs.filter(j => j.health === 'warning' || j.health === 'critical').length

  if (jobs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-[var(--fg-muted)]">
        <div className="text-4xl mb-4">⏰</div>
        <div className="text-lg font-medium mb-2">No Cron Jobs Found</div>
        <div className="text-sm mb-6">No cron jobs or systemd timers discovered on this system.</div>
        {onCreateJob && (
          <button onClick={onCreateJob} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
            Create Job
          </button>
        )}
      </div>
    )
  }

  // Dashboard view with stats
  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 p-8">
      <div className="text-lg font-medium text-[var(--fg-primary)]">Cron Manager</div>
      <div className="grid grid-cols-4 gap-4 w-full max-w-lg">
        <StatCard label="Total" value={jobs.length} />
        <StatCard label="Active" value={active} color="text-green-500" />
        <StatCard label="Paused" value={paused} color="text-yellow-500" />
        <StatCard label="Errors" value={errors} color="text-red-500" />
      </div>
      {unhealthy > 0 && (
        <div className="text-sm text-yellow-500">{unhealthy} unhealthy job{unhealthy !== 1 ? 's' : ''}</div>
      )}
      <div className="text-sm text-[var(--fg-muted)]">Select a job from the list to view details</div>
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="flex flex-col items-center p-3 rounded bg-[var(--bg-secondary)] border border-[var(--border)]">
      <div className={`text-2xl font-bold ${color || 'text-[var(--fg-primary)]'}`}>{value}</div>
      <div className="text-xs text-[var(--fg-muted)]">{label}</div>
    </div>
  )
}

export default CronEmptyState
