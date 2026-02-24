// CronJobRow.tsx — Single job row in the list pane
// WU-010: List Pane Core

import React, { useState } from 'react'
import type { CronJob } from '../../../shared/types'
import type { ClientMessage } from '../../../shared/types'
import { CronHealthBadge } from './CronHealthBadge'

interface CronJobRowProps {
  job: CronJob
  isSelected: boolean
  isBulkSelected: boolean
  bulkMode: boolean
  onSelect: (jobId: string) => void
  onBulkToggle: (jobId: string) => void
  onShiftClick: (jobId: string) => void
  sendMessage: (msg: ClientMessage) => void
}

// Deterministic color from tag name hash
function tagColor(tag: string): string {
  let hash = 0
  for (let i = 0; i < tag.length; i++) {
    hash = (hash << 5) - hash + tag.charCodeAt(i)
    hash |= 0
  }
  const colors = [
    'bg-blue-500/20 text-blue-300',
    'bg-purple-500/20 text-purple-300',
    'bg-green-500/20 text-green-300',
    'bg-yellow-500/20 text-yellow-300',
    'bg-pink-500/20 text-pink-300',
    'bg-cyan-500/20 text-cyan-300',
    'bg-orange-500/20 text-orange-300',
    'bg-teal-500/20 text-teal-300',
  ]
  return colors[Math.abs(hash) % colors.length]
}

const STATUS_DOT: Record<string, string> = {
  active:   'bg-green-400',
  paused:   'bg-zinc-500',
  disabled: 'bg-zinc-600',
  error:    'bg-red-400',
  unknown:  'bg-zinc-600',
}

// SVG icons as small inline components
function ManagedIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400 shrink-0" aria-label="Managed by Agentboard">
      <rect x="2" y="2" width="8" height="8" rx="1" />
      <rect x="14" y="2" width="8" height="8" rx="1" />
      <rect x="2" y="14" width="8" height="8" rx="1" />
      <path d="M18 14v4M16 16h4" />
    </svg>
  )
}

function LinkedSessionIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-cyan-400 shrink-0" aria-label="Linked to session">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  )
}

export function CronJobRow({
  job,
  isSelected,
  isBulkSelected,
  bulkMode,
  onSelect,
  onBulkToggle,
  onShiftClick,
  sendMessage,
}: CronJobRowProps) {
  const [avatarError, setAvatarError] = useState(false)
  const [isHovered, setIsHovered] = useState(false)

  const avatarUrl = `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(job.name)}`
  const statusDotColor = STATUS_DOT[job.status] ?? STATUS_DOT.unknown
  const showCheckbox = bulkMode || isHovered || isBulkSelected

  const handleClick = (e: React.MouseEvent) => {
    if (e.shiftKey) {
      onShiftClick(job.id)
      return
    }
    onSelect(job.id)
    sendMessage({ type: 'cron-job-select', jobId: job.id })
  }

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onBulkToggle(job.id)
  }

  return (
    <div
      role="option"
      aria-selected={isSelected}
      aria-label={`${job.name}, ${job.scheduleHuman}, health: ${job.health}, status: ${job.status}`}
      className={[
        'flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors select-none',
        isSelected
          ? 'bg-blue-500/20 border-l-2 border-blue-500'
          : 'border-l-2 border-transparent hover:bg-zinc-700/50',
      ].join(' ')}
      onClick={handleClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Bulk checkbox */}
      <div
        className={`shrink-0 transition-opacity ${showCheckbox ? 'opacity-100' : 'opacity-0'}`}
        style={{ width: 16 }}
        onClick={handleCheckboxClick}
      >
        <input
          type="checkbox"
          checked={isBulkSelected}
          onChange={() => onBulkToggle(job.id)}
          className="w-4 h-4 rounded accent-blue-500 cursor-pointer"
          aria-label={`Select ${job.name}`}
          tabIndex={-1}
        />
      </div>

      {/* Avatar */}
      <div className="shrink-0 w-7 h-7 rounded overflow-hidden">
        {!avatarError ? (
          <img
            src={avatarUrl}
            width={28}
            height={28}
            alt=""
            onError={() => setAvatarError(true)}
            className="w-7 h-7"
          />
        ) : (
          <div
            className="w-7 h-7 rounded flex items-center justify-center text-xs font-bold text-white"
            style={{ backgroundColor: `hsl(${Math.abs(job.name.charCodeAt(0) * 37) % 360}, 60%, 40%)` }}
          >
            {job.name[0]?.toUpperCase() ?? '?'}
          </div>
        )}
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm text-zinc-200 truncate font-medium" title={job.name}>
            {job.name}
          </span>
          {job.isManagedByAgentboard && <ManagedIcon />}
          {job.linkedSessionId && <LinkedSessionIcon />}
        </div>
        <div className="text-xs text-zinc-500 truncate">{job.scheduleHuman}</div>
      </div>

      {/* Right side: tags + health + status */}
      <div className="flex items-center gap-1.5 shrink-0">
        {/* Tag pills — show first 2 max */}
        {job.tags.slice(0, 2).map((tag) => (
          <span
            key={tag}
            className={`text-[10px] px-1.5 py-0.5 rounded font-medium leading-none ${tagColor(tag)}`}
          >
            {tag}
          </span>
        ))}

        <CronHealthBadge health={job.health} reason={job.healthReason} size="sm" />

        <span
          className={`w-2 h-2 rounded-full shrink-0 ${statusDotColor}`}
          aria-label={`Status: ${job.status}`}
          title={`Status: ${job.status}`}
        />
      </div>
    </div>
  )
}
