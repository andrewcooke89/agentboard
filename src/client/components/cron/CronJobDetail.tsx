// CronJobDetail.tsx — Detail pane with persistent header and tabbed content
// WU-012: Detail Pane & Overview Tab
//
// Persistent header: avatar 48x48, name, source/status/health badges,
// tag pills, managed toggle, linked session chip (REQ-21).
// 4 tabs: Overview / History / Logs / Script.
// Tab state persisted via cronStore (REQ-89).
// CronJobControls strip below header (WU-014).

import React, { useState } from 'react'
import { useCronStore } from '../../stores/cronStore'
import type { ClientMessage } from '../../../shared/types'
import { CronHealthBadge } from './CronHealthBadge'
import { CronOverviewTab } from './CronOverviewTab'
import { CronHistoryTab } from './CronHistoryTab'
import { CronLogsTab } from './CronLogsTab'
import { CronScriptTab } from './CronScriptTab'
import { CronJobControls } from './CronJobControls'

type SendMessage = (message: ClientMessage) => void

interface CronJobDetailProps {
  sendMessage: SendMessage
  onNavigateToSession?: (sessionId: string) => void
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  active:   { label: 'Active',   className: 'bg-green-900/50 text-green-400 border border-green-700' },
  paused:   { label: 'Paused',   className: 'bg-zinc-700 text-zinc-400 border border-zinc-600' },
  disabled: { label: 'Disabled', className: 'bg-zinc-700 text-zinc-500 border border-zinc-600' },
  error:    { label: 'Error',    className: 'bg-red-900/50 text-red-400 border border-red-700' },
  unknown:  { label: 'Unknown',  className: 'bg-zinc-700 text-zinc-500 border border-zinc-600' },
}

const TABS = ['overview', 'history', 'logs', 'script'] as const

export function CronJobDetail({ sendMessage, onNavigateToSession }: CronJobDetailProps) {
  const { selectedJobDetail, activeTab, setActiveTab } = useCronStore()
  const [removingTag, setRemovingTag] = useState<string | null>(null)

  if (!selectedJobDetail) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
        Select a job to view details
      </div>
    )
  }

  const job = selectedJobDetail
  const statusConfig = STATUS_BADGE[job.status] ?? STATUS_BADGE.unknown

  function handleRemoveTag(tag: string) {
    setRemovingTag(tag)
    const newTags = job.tags.filter((t) => t !== tag)
    sendMessage({ type: 'cron-job-set-tags', jobId: job.id, tags: newTags })
    setRemovingTag(null)
  }

  function handleToggleManaged() {
    sendMessage({ type: 'cron-job-set-managed', jobId: job.id, isManaged: !job.isManagedByAgentboard })
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-zinc-700 shrink-0">
        <div className="flex items-start gap-3">
          {/* Avatar */}
          <div className="shrink-0">
            {job.avatarUrl ? (
              <img
                src={job.avatarUrl}
                alt={job.name}
                className="w-12 h-12 rounded-lg object-cover border border-zinc-600"
              />
            ) : (
              <div className="w-12 h-12 rounded-lg bg-zinc-700 border border-zinc-600 flex items-center justify-center text-xl font-bold text-zinc-400 select-none">
                {job.name.charAt(0).toUpperCase()}
              </div>
            )}
          </div>

          {/* Name + badges */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold text-zinc-100 truncate">{job.name}</h2>

              {/* Managed toggle icon */}
              <button
                onClick={handleToggleManaged}
                title={job.isManagedByAgentboard ? 'Managed by agentboard — click to unmanage' : 'Not managed — click to manage'}
                className={`text-xs px-1.5 py-0.5 rounded border transition-colors ${
                  job.isManagedByAgentboard
                    ? 'bg-blue-900/50 text-blue-400 border-blue-700 hover:bg-blue-800/50'
                    : 'bg-zinc-700 text-zinc-500 border-zinc-600 hover:bg-zinc-600'
                }`}
              >
                {job.isManagedByAgentboard ? '⚙ Managed' : '⚙'}
              </button>
            </div>

            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {/* Source badge */}
              <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400 border border-zinc-600 font-mono">
                {job.source}
              </span>

              {/* Status badge */}
              <span className={`text-xs px-1.5 py-0.5 rounded ${statusConfig.className}`}>
                {statusConfig.label}
              </span>

              {/* Health badge */}
              <CronHealthBadge health={job.health} reason={job.healthReason} size="sm" />

              {/* User */}
              {job.user && (
                <span className="text-xs text-zinc-500">@{job.user}</span>
              )}
            </div>

            {/* Tag pills */}
            {job.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {job.tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-300 border border-zinc-600"
                  >
                    {tag}
                    <button
                      onClick={() => handleRemoveTag(tag)}
                      disabled={removingTag === tag}
                      className="text-zinc-500 hover:text-zinc-200 leading-none"
                      title={`Remove tag "${tag}"`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Linked session chip */}
            {job.linkedSessionId && (
              <div className="mt-2">
                <button
                  onClick={() => onNavigateToSession?.(job.linkedSessionId!)}
                  className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-purple-900/40 text-purple-400 border border-purple-700 hover:bg-purple-800/40 transition-colors"
                >
                  <span>⬡</span>
                  <span>Session: {job.linkedSessionId.slice(0, 8)}…</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-zinc-700 shrink-0">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm capitalize transition-colors ${
              activeTab === tab
                ? 'text-blue-400 border-b-2 border-blue-400 -mb-px'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {activeTab === 'overview' && (
          <CronOverviewTab job={job} detail={job} />
        )}
        {activeTab === 'history' && (
          <CronHistoryTab job={job} detail={job} sendMessage={sendMessage} />
        )}
        {activeTab === 'logs' && (
          <CronLogsTab job={job} sendMessage={sendMessage} />
        )}
        {activeTab === 'script' && (
          <CronScriptTab job={job} detail={job} />
        )}
      </div>

      {/* Controls strip */}
      <div className="shrink-0 border-t border-zinc-700 px-4 py-3">
        <CronJobControls job={job} sendMessage={sendMessage} />
      </div>
    </div>
  )
}
