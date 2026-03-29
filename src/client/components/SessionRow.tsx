import { useState, useRef, useEffect } from 'react'
import { HandIcon, XCloseIcon } from '@untitledui-icons/react/line'
import Copy01Icon from '@untitledui-icons/react/line/esm/Copy01Icon'
import Edit05Icon from '@untitledui-icons/react/line/esm/Edit05Icon'
import Pin02Icon from '@untitledui-icons/react/line/esm/Pin02Icon'
import type { Session } from '@shared/types'
import { formatRelativeTime } from '../utils/time'
import { getPathLeaf } from '../utils/sessionLabel'
import { getSessionIdShort } from '../utils/sessionId'
import { useTaskStore } from '../stores/taskStore'
import { useWorkflowStore } from '../stores/workflowStore'
import { useCronStore } from '../stores/cronStore'
import AgentIcon from './AgentIcon'
import ProjectBadge from './ProjectBadge'

export const statusBarClass: Record<Session['status'], string> = {
  working: 'status-bar-working',
  waiting: 'status-bar-waiting',
  permission: 'status-bar-approval pulse-approval',
  unknown: 'status-bar-waiting',
}

export interface SessionRowProps {
  session: Session
  isSelected: boolean
  isEditing: boolean
  showSessionIdPrefix: boolean
  showProjectName: boolean
  showLastUserMessage: boolean
  isDragging?: boolean
  onSelect: () => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onRename: (newName: string) => void
  onKill?: () => void
  onDuplicate?: () => void
  onSetPinned?: (isPinned: boolean) => void
  onNavigateToWorkflow?: (workflowId: string) => void
  onNavigateToCronManager?: (sessionId: string) => void
}

function SessionRow({
  session,
  isSelected,
  isEditing,
  showSessionIdPrefix,
  showProjectName,
  showLastUserMessage,
  isDragging = false,
  onSelect,
  onStartEdit,
  onCancelEdit,
  onRename,
  onKill,
  onDuplicate,
  onSetPinned,
  onNavigateToWorkflow,
  onNavigateToCronManager,
}: SessionRowProps) {
  const lastActivity = formatRelativeTime(session.lastActivity)
  const inputRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const displayName =
    session.agentSessionName?.trim() ||
    session.name?.trim() ||
    session.id
  const [editValue, setEditValue] = useState(displayName)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const directoryLeaf = getPathLeaf(session.projectPath)

  // Check if this session was spawned by a workflow
  const workflowInfo = (() => {
    const tasks = useTaskStore.getState().tasks
    const task = tasks.find(t => t.sessionName === session.name && t.metadata)
    if (!task?.metadata) return null
    try {
      const meta = JSON.parse(task.metadata)
      if (meta.workflow_run_id && meta.workflow_step_name) {
        const runs = useWorkflowStore.getState().workflowRuns
        const run = runs.find(r => r.id === meta.workflow_run_id)
        return {
          workflowId: run?.workflow_id,
          workflowName: run?.workflow_name,
          stepName: meta.workflow_step_name as string,
        }
      }
    } catch { /* ignore parse errors */ }
    return null
  })()
  // Check if any cron job is linked to this session
  const hasLinkedCronJobs = (() => {
    const cronJobs = useCronStore.getState().jobs
    const agentId = session.agentSessionId?.trim()
    if (!agentId) return false
    return cronJobs.some((j) => j.linkedSessionId === agentId)
  })()

  const needsInput = session.status === 'permission'
  const agentSessionId = session.agentSessionId?.trim()
  const sessionIdPrefix =
    showSessionIdPrefix && agentSessionId
      ? getSessionIdShort(agentSessionId)
      : ''
  const showDirectory = showProjectName && Boolean(directoryLeaf)
  const showMessage = showLastUserMessage && Boolean(session.lastUserMessage)

  // Track previous status for transition animation
  const prevStatusRef = useRef<Session['status']>(session.status)
  const [isPulsingComplete, setIsPulsingComplete] = useState(false)

  useEffect(() => {
    const prevStatus = prevStatusRef.current
    const currentStatus = session.status

    // Detect transition from working → waiting (not permission, which needs immediate attention)
    if (prevStatus === 'working' && currentStatus === 'waiting') {
      setIsPulsingComplete(true)
      // Don't update ref yet - will update when animation ends
    } else {
      prevStatusRef.current = currentStatus
    }
  }, [session.status])

  const handlePulseAnimationEnd = () => {
    setIsPulsingComplete(false)
    prevStatusRef.current = session.status
  }

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  useEffect(() => {
    setEditValue(displayName)
  }, [displayName])

  const handleSubmit = () => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== displayName) {
      onRename(trimmed)
    } else {
      onCancelEdit()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditValue(displayName)
      onCancelEdit()
    }
  }

  const handleTouchStart = () => {
    if (isDragging) return
    longPressTimer.current = setTimeout(() => {
      onStartEdit()
    }, 500)
  }

  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  // Close context menu on click outside or escape
  useEffect(() => {
    if (!contextMenu) return

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('touchstart', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [contextMenu])

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  return (
    <div
      className={`session-row group cursor-pointer px-3 py-2 ${isSelected ? 'selected' : ''} ${isDragging ? 'cursor-grabbing shadow-lg ring-1 ring-accent/30 bg-elevated' : 'cursor-grab'}`}
      role="button"
      tabIndex={0}
      data-testid="session-card"
      data-session-id={session.id}
      onClick={isDragging ? undefined : onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect()
      }}
      onContextMenu={handleContextMenu}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <div
        className={`status-bar ${statusBarClass[session.status]}${isPulsingComplete ? ' pulse-complete' : ''}`}
        onAnimationEnd={handlePulseAnimationEnd}
      />

      <div className="flex flex-col gap-0.5 pl-2.5">
        {/* Line 1: Icon + Name + Time/Hand */}
        <div className="flex items-center gap-2">
          <AgentIcon
            agentType={session.agentType}
            command={session.command}
            className="h-3.5 w-3.5 shrink-0 text-muted"
          />
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSubmit}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              className="min-w-0 flex-1 rounded border border-border bg-surface px-1.5 py-0.5 text-sm font-medium text-primary outline-none focus:border-accent"
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
              {displayName}
            </span>
          )}
          {session.isPinned && (
            <Pin02Icon
              className="h-3 w-3 shrink-0 text-primary"
              aria-label="Pinned"
              title="Pinned - will auto-resume on server restart"
            />
          )}
          {sessionIdPrefix && (
            <span
              className="shrink-0 text-[11px] font-mono text-muted"
              title={agentSessionId}
            >
              {sessionIdPrefix}
            </span>
          )}
          {needsInput ? (
            <span className="ml-1 flex w-8 shrink-0 justify-end">
              <HandIcon className="h-4 w-4 text-approval" aria-label="Needs input" />
            </span>
          ) : (
            <span className="ml-1 w-8 shrink-0 text-right text-xs tabular-nums text-muted">{lastActivity}</span>
          )}
        </div>

        {/* Line 2: Project badge + workflow badge + cron badge + last user message (up to 2 lines total) */}
        {(showDirectory || showMessage || workflowInfo || hasLinkedCronJobs) && (
          <div className="flex flex-wrap items-center gap-1 pl-[1.375rem]">
            {showDirectory && (
              <ProjectBadge name={directoryLeaf!} fullPath={session.projectPath} />
            )}
            {workflowInfo && (
              <span
                className={`text-[10px] px-1.5 rounded-full bg-indigo-500/20 text-indigo-300 inline-flex items-center gap-0.5${onNavigateToWorkflow && workflowInfo.workflowId ? ' cursor-pointer hover:bg-indigo-500/30 transition-colors' : ''}`}
                title={workflowInfo.workflowName ? `Workflow: ${workflowInfo.workflowName} / ${workflowInfo.stepName}` : `Step: ${workflowInfo.stepName}`}
                onClick={onNavigateToWorkflow && workflowInfo.workflowId ? (e) => {
                  e.stopPropagation()
                  onNavigateToWorkflow(workflowInfo.workflowId!)
                } : undefined}
                role={onNavigateToWorkflow && workflowInfo.workflowId ? 'button' : undefined}
              >
                &#x1f504; {workflowInfo.stepName}
              </span>
            )}
            {hasLinkedCronJobs && (
              <span
                className={`text-[10px] px-1.5 rounded-full bg-emerald-500/20 text-emerald-300 inline-flex items-center gap-0.5${onNavigateToCronManager ? ' cursor-pointer hover:bg-emerald-500/30 transition-colors' : ''}`}
                title="Has linked cron jobs — click to view in Cron Manager"
                onClick={onNavigateToCronManager ? (e) => {
                  e.stopPropagation()
                  onNavigateToCronManager(session.agentSessionId!.trim())
                } : undefined}
                role={onNavigateToCronManager ? 'button' : undefined}
              >
                &#x1f551; cron
              </span>
            )}
            {showMessage && (
              <span className="line-clamp-2 text-xs italic text-muted">
                "{session.lastUserMessage!.length > 200
                  ? session.lastUserMessage!.slice(0, 200) + '…'
                  : session.lastUserMessage}"
              </span>
            )}
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[160px] rounded-md border border-border bg-elevated shadow-lg py-1"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          <button
            onClick={(e) => {
              e.stopPropagation()
              setContextMenu(null)
              onStartEdit()
            }}
            className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
            role="menuitem"
          >
            <Edit05Icon width={14} height={14} />
            Rename
          </button>
          {onDuplicate && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(null)
                onDuplicate()
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
              title="Create a copy in a new tmux window"
            >
              <Copy01Icon width={14} height={14} />
              Duplicate
            </button>
          )}
          {onSetPinned && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(null)
                onSetPinned(!session.isPinned)
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
              title={session.isPinned ? 'Remove from auto-resume list' : 'Auto-resume on server restart'}
            >
              <Pin02Icon width={14} height={14} />
              {session.isPinned ? 'Unpin' : 'Pin'}
            </button>
          )}
          {onKill && (
            <>
              <div className="my-1 border-t border-border" />
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setContextMenu(null)
                  onKill()
                }}
                className="w-full px-3 py-2 text-left text-sm text-danger hover:bg-danger/10 flex items-center gap-2"
                role="menuitem"
              >
                <XCloseIcon width={14} height={14} />
                Kill Session
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default SessionRow
