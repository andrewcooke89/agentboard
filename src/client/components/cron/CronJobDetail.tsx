// WU-011: Detail Pane Shell — CronJobDetail

import { useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useCronStore } from '../../stores/cronStore'
import { CronHealthBadge } from './CronHealthBadge'
import { CronTagInput } from './CronTagInput'
import { CronSessionLink } from './CronSessionLink'
import CronOverviewTab from './CronOverviewTab'
import CronHistoryTab from './CronHistoryTab'
import CronLogsTab from './CronLogsTab'
import CronScriptTab from './CronScriptTab'
import { CronJobControls } from './CronJobControls'
import { CronRunNowOutput } from './CronRunNowOutput'
import { CronDeleteConfirm } from './CronDeleteConfirm'
import type { CronJob } from '@shared/types'

// ─── CronJobDetail ────────────────────────────────────────────────────────────
// Persistent header (avatar 48x48, name, source/status/health badges, tag pills,
// managed toggle, linked session chip) + tabbed interface (Overview, History, Logs, Script).
// Active tab state from cronStore.activeTab (persisted); tab persists across job changes.

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-500',
  paused: 'bg-yellow-500',
  error: 'bg-red-500',
  unknown: 'bg-gray-500',
}

const SOURCE_LABELS: Record<string, string> = {
  'user-crontab': 'User Cron',
  'system-crontab': 'System Cron',
  'user-systemd': 'User Timer',
  'systemd-system': 'System Timer',
}

const TABS = ['overview', 'history', 'logs', 'script'] as const

// ─── CronJobDetailHeader ──────────────────────────────────────────────────────

interface CronJobDetailHeaderProps {
  job: CronJob
  setJobManaged: (id: string, managed: boolean) => void
}

function CronJobDetailHeader({ job, setJobManaged }: CronJobDetailHeaderProps) {
  return (
    <div className="p-4 border-b border-[var(--border)] space-y-3 shrink-0">
      <div className="flex items-center gap-3">
        <img
          src={
            job.avatarUrl ||
            `https://api.dicebear.com/9.x/bottts/svg?seed=${encodeURIComponent(job.name)}&size=48`
          }
          alt=""
          width={48}
          height={48}
          className="rounded shrink-0"
          onError={(e) => {
            ;(e.target as HTMLImageElement).style.display = 'none'
          }}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-[var(--text-primary)] truncate">{job.name}</h2>
            <span
              className={`w-2.5 h-2.5 rounded-full shrink-0 ${STATUS_COLORS[job.status] ?? 'bg-gray-500'}`}
              aria-label={`Status: ${job.status}`}
            />
            <CronHealthBadge health={job.health} reason={job.healthReason} />
          </div>
          <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <span className="px-1.5 py-0.5 rounded bg-[var(--bg-hover)]">
              {SOURCE_LABELS[job.source] || job.source}
            </span>
            {job.user && <span>User: {job.user}</span>}
            {job.requiresSudo && (
              <span className="text-yellow-500" title="Requires sudo">
                🔒
              </span>
            )}
            <button
              onClick={() => {
                setJobManaged(job.id, !job.isManagedByAgentboard)
                const ws = (window as unknown as { __cronWsSend?: (msg: unknown) => void }).__cronWsSend
                if (ws) ws({ type: 'cron-job-set-managed', jobId: job.id, managed: !job.isManagedByAgentboard })
              }}
              className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer ${
                job.isManagedByAgentboard
                  ? 'bg-blue-900/40 text-blue-400 hover:bg-blue-900/60'
                  : 'bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
              title={job.isManagedByAgentboard ? 'Managed by Agentboard — click to unmanage' : 'Not managed — click to manage'}
            >
              ⚙ {job.isManagedByAgentboard ? 'Managed' : 'Unmanaged'}
            </button>
          </div>
        </div>
        <CronSessionLink jobId={job.id} linkedSessionId={job.linkedSessionId} />
      </div>
      {/* Tags */}
      <CronTagInput jobId={job.id} tags={job.tags} />
    </div>
  )
}

// ─── CronJobDetail (main export) ──────────────────────────────────────────────

export function CronJobDetail() {
  const { selectedJobId, jobs, activeTab, setActiveTab, runOutputs, runningJobs, setJobManaged } = useCronStore()
  const job = jobs.find((j) => j.id === selectedJobId)

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [runOutputDismissed, setRunOutputDismissed] = useState<Record<string, boolean>>({})

  if (!job) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
        No job selected
      </div>
    )
  }

  const hasRunOutput = Boolean(runOutputs[job.id]) || runningJobs.has(job.id)
  const dismissed = runOutputDismissed[job.id] ?? false
  const showOutput = hasRunOutput && !dismissed

  function handleDismissOutput() {
    setRunOutputDismissed((prev) => ({ ...prev, [job!.id]: true }))
  }

  // Reset dismiss state when a new run starts
  if (runningJobs.has(job.id) && runOutputDismissed[job.id]) {
    setRunOutputDismissed((prev) => {
      const next = { ...prev }
      delete next[job.id]
      return next
    })
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <CronJobDetailHeader job={job} setJobManaged={setJobManaged} />

      {/* Controls strip */}
      <CronJobControls onDelete={() => setShowDeleteConfirm(true)} />

      {/* Run Now output panel */}
      <AnimatePresence>
        {showOutput && (
          <CronRunNowOutput jobId={job.id} onDismiss={handleDismissOutput} />
        )}
      </AnimatePresence>

      {/* Tab bar */}
      <div className="flex border-b border-[var(--border)] shrink-0">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm capitalize ${
              activeTab === tab
                ? 'text-[var(--text-primary)] border-b-2 border-blue-500'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            className="h-full"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
          >
            {activeTab === 'overview' && <CronOverviewTab />}
            {activeTab === 'history' && <CronHistoryTab />}
            {activeTab === 'logs' && <CronLogsTab />}
            {activeTab === 'script' && <CronScriptTab />}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Delete confirmation modal */}
      <CronDeleteConfirm
        isOpen={showDeleteConfirm}
        job={job}
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={() => {
          const ws = (window as unknown as { __cronWsSend?: (msg: unknown) => void }).__cronWsSend
          if (ws) ws({ type: 'cron-job-delete', jobId: job.id })
          setShowDeleteConfirm(false)
        }}
      />
    </div>
  )
}

export default CronJobDetail
