// TaskItem.tsx - Individual task row component
import type { Task } from '@shared/types'
import { useWorkflowStore } from '../stores/workflowStore'

const STATUS_COLORS: Record<string, string> = {
  queued: 'bg-yellow-500',
  running: 'bg-blue-500 animate-pulse',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  cancelled: 'bg-gray-500',
}

const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return ''
  const start = new Date(startedAt).getTime()
  const end = completedAt ? new Date(completedAt).getTime() : Date.now()
  const seconds = Math.floor((end - start) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function truncatePath(p: string, maxLen = 30): string {
  if (p.length <= maxLen) return p
  const parts = p.split('/')
  return '.../' + parts.slice(-2).join('/')
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

interface TaskItemProps {
  task: Task
  isSelected: boolean
  onSelect: (id: string) => void
  onCancel: (id: string) => void
  onRetry: (id: string) => void
  onViewOutput: (id: string) => void
  onWatch?: (task: Task) => void
  onNavigateToWorkflow?: (workflowId: string) => void
}

/** Parse workflow metadata from task.metadata JSON string */
function getWorkflowMeta(metadata: string | null): { workflow_run_id: string; workflow_step_name: string } | null {
  if (!metadata) return null
  try {
    const parsed = JSON.parse(metadata)
    if (parsed && typeof parsed.workflow_run_id === 'string' && typeof parsed.workflow_step_name === 'string') {
      return { workflow_run_id: parsed.workflow_run_id, workflow_step_name: parsed.workflow_step_name }
    }
    return null
  } catch {
    return null
  }
}

export default function TaskItem({ task, isSelected, onSelect, onCancel, onRetry, onViewOutput, onWatch, onNavigateToWorkflow }: TaskItemProps) {
  const canCancel = task.status === 'queued' || task.status === 'running'
  const canRetry = task.status === 'failed' || task.status === 'cancelled'
  const hasOutput = task.status === 'completed' || (task.status === 'failed' && task.outputPath)
  const workflowMeta = getWorkflowMeta(task.metadata)

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 cursor-pointer rounded-md transition-colors ${
        isSelected ? 'bg-white/10' : 'hover:bg-white/5'
      }`}
      onClick={() => onSelect(task.id)}
    >
      {/* Status dot */}
      <div className={`w-2 h-2 rounded-full shrink-0 ${STATUS_COLORS[task.status] || 'bg-gray-500'}`} />

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs text-white/60 truncate">
            {truncatePath(task.projectPath)}
          </span>
          {task.priority !== 5 && (
            <span className="text-[10px] px-1 rounded bg-white/10 text-white/50">
              P{task.priority}
            </span>
          )}
          {task.parentTaskId && (
            <span className="text-[10px] px-1 rounded bg-purple-500/20 text-purple-300" title={`Child of ${task.parentTaskId.slice(0, 8)}`}>
              chain
            </span>
          )}
          {task.followUpPrompt && (
            <span className="text-[10px] px-1 rounded bg-cyan-500/20 text-cyan-300" title="Has follow-up prompt">
              follow-up
            </span>
          )}
          {workflowMeta && (
            <span
              className={`text-[10px] px-1.5 rounded-full bg-indigo-500/20 text-indigo-300${onNavigateToWorkflow ? ' cursor-pointer hover:bg-indigo-500/30 transition-colors' : ''}`}
              title={`Workflow run: ${workflowMeta.workflow_run_id}${onNavigateToWorkflow ? ' (click to open)' : ''}`}
              data-testid="workflow-badge"
              onClick={onNavigateToWorkflow ? (e) => {
                e.stopPropagation()
                // Look up workflow_id from the run
                const runs = useWorkflowStore.getState().workflowRuns
                const run = runs.find(r => r.id === workflowMeta.workflow_run_id)
                if (run) {
                  onNavigateToWorkflow(run.workflow_id)
                }
              } : undefined}
              role={onNavigateToWorkflow ? 'button' : undefined}
            >
              &#x1f504; {workflowMeta.workflow_step_name}
            </span>
          )}
        </div>
        <div className="text-xs text-white/40 truncate mt-0.5">
          {task.prompt.slice(0, 80)}{task.prompt.length > 80 ? '...' : ''}
        </div>
        {task.status === 'failed' && task.errorMessage && (
          <div className="text-[10px] text-red-400/80 truncate mt-0.5" title={task.errorMessage}>
            {task.errorMessage.slice(0, 120)}{task.errorMessage.length > 120 ? '...' : ''}
          </div>
        )}
      </div>

      {/* Time & status */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-[10px] text-white/40">
          {task.status === 'running'
            ? formatDuration(task.startedAt, null)
            : task.completedAt
              ? formatDuration(task.startedAt, task.completedAt)
              : formatTime(task.createdAt)}
        </span>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded ${
            task.status === 'running' ? 'bg-blue-500/20 text-blue-300'
            : task.status === 'failed' ? 'bg-red-500/20 text-red-300'
            : task.status === 'completed' ? 'bg-green-500/20 text-green-300'
            : 'bg-white/10 text-white/50'
          }`}
          title={task.status === 'failed' && task.errorMessage ? task.errorMessage : undefined}
        >
          {STATUS_LABELS[task.status]}
        </span>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
        {canCancel && (
          <button
            className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 hover:bg-red-500/30 transition-colors"
            onClick={() => onCancel(task.id)}
            title="Cancel task"
          >
            Cancel
          </button>
        )}
        {task.status === 'running' && onWatch && (
          <button
            className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 transition-colors"
            onClick={() => onWatch(task)}
            title="Watch live output"
          >
            Watch
          </button>
        )}
        {canRetry && (
          <button
            className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30 transition-colors"
            onClick={() => onRetry(task.id)}
            title="Retry task"
          >
            Retry
          </button>
        )}
        {hasOutput && (
          <button
            className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/60 hover:bg-white/20 transition-colors"
            onClick={() => onViewOutput(task.id)}
            title="View output"
          >
            Output
          </button>
        )}
      </div>
    </div>
  )
}
