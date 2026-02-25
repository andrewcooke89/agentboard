// WU-010: List Pane Core — CronJobRow

import type { CronJob } from '@shared/types'
import { useCronStore } from '../../stores/cronStore'
import { CronHealthBadge } from './CronHealthBadge'

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-500',
  paused: 'bg-yellow-500',
  error: 'bg-red-500',
  unknown: 'bg-gray-500',
}

export function CronJobRow({ job }: { job: CronJob }) {
  const { selectedJobId, setSelectedJob, bulkSelectMode, selectedJobIds, toggleBulkSelect } = useCronStore()
  const isSelected = selectedJobId === job.id
  const isBulkSelected = selectedJobIds.has(job.id)

  return (
    <div
      onClick={() => bulkSelectMode ? toggleBulkSelect(job.id) : setSelectedJob(job.id)}
      className={`group flex items-center gap-2 px-3 py-2 cursor-pointer border-b border-[var(--border)] hover:bg-[var(--bg-secondary)] ${isSelected ? 'bg-[var(--bg-secondary)]' : ''}`}
      role="option"
      aria-selected={isSelected}
      aria-label={`${job.name} - ${job.status} - ${job.health}`}
    >
      {/* Bulk checkbox */}
      <input
        type="checkbox"
        checked={isBulkSelected}
        onChange={() => toggleBulkSelect(job.id)}
        onClick={e => e.stopPropagation()}
        className={`shrink-0 ${bulkSelectMode ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
      />
      {/* Avatar */}
      <img
        src={job.avatarUrl || `https://api.dicebear.com/9.x/bottts/svg?seed=${encodeURIComponent(job.name)}&size=28`}
        alt=""
        width={28}
        height={28}
        className="shrink-0 rounded"
        onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
      />
      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[job.status] || STATUS_COLORS.unknown}`} aria-label={`Status: ${job.status}`} />
          <span className="text-sm font-medium text-[var(--fg-primary)] truncate">{job.name}</span>
          {job.isManagedByAgentboard && <span title="Managed by Agentboard" className="text-xs text-blue-400">⚙</span>}
        </div>
        <div className="text-xs text-[var(--fg-muted)] truncate">{job.scheduleHuman}</div>
      </div>
      {/* Tags */}
      {job.tags.length > 0 && (
        <div className="flex gap-0.5 shrink-0">
          {job.tags.slice(0, 2).map(tag => (
            <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--fg-muted)]">{tag}</span>
          ))}
          {job.tags.length > 2 && <span className="text-[10px] text-[var(--fg-muted)]">+{job.tags.length - 2}</span>}
        </div>
      )}
      {/* Health badge */}
      <CronHealthBadge health={job.health} reason={job.healthReason} />
    </div>
  )
}

export default CronJobRow
