// TaskQueue.tsx - Main task queue panel component
import { useState, useCallback } from 'react'
import { AnimatePresence, useReducedMotion } from 'motion/react'
import type { Task, SendClientMessage } from '@shared/types'
import { useTaskStore } from '../stores/taskStore'
import TaskItem from './TaskItem'
import TaskForm from './TaskForm'
import TemplateManager from './TemplateManager'
import { authFetch } from '../utils/api'
import { toastManager } from './Toast'

interface TaskQueueProps {
  sendMessage: SendClientMessage
  defaultProjectPath: string
  onWatchTask?: (task: Task) => void
  onNavigateToWorkflow?: (workflowId: string) => void
}

function TaskOutputViewer({ isLoading, content, taskId, onClose }: {
  isLoading: boolean
  content: string | null
  taskId: string | null
  onClose: () => void
}) {
  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-center h-32 text-xs text-white/30 animate-pulse">
          Loading output...
        </div>
      </div>
    )
  }
  if (content !== null && taskId) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
          <span className="text-xs text-white/60">Output: {taskId.slice(0, 12)}</span>
          <button onClick={onClose} className="text-xs text-white/40 hover:text-white/60">Close</button>
        </div>
        <pre className="flex-1 overflow-auto p-3 text-xs text-white/70 font-mono whitespace-pre-wrap">
          {content}
        </pre>
      </div>
    )
  }
  return null
}

function TaskListSection({ label, tasks, selectedTaskId, onSelect, onCancel, onRetry, onViewOutput, onWatch, onNavigateToWorkflow }: {
  label: string
  tasks: Task[]
  selectedTaskId: string | null
  onSelect: (id: string) => void
  onCancel: (id: string) => void
  onRetry: (id: string) => void
  onViewOutput: (id: string) => void
  onWatch?: (task: Task) => void
  onNavigateToWorkflow?: (workflowId: string) => void
}) {
  if (tasks.length === 0) return null
  return (
    <div>
      <div className="px-3 py-1.5 text-[10px] text-white/40 uppercase tracking-wider">{label}</div>
      <AnimatePresence initial={false}>
        {tasks.map((task) => (
          <TaskItem
            key={task.id}
            task={task}
            isSelected={task.id === selectedTaskId}
            onSelect={onSelect}
            onCancel={onCancel}
            onRetry={onRetry}
            onViewOutput={onViewOutput}
            onWatch={onWatch}
            onNavigateToWorkflow={onNavigateToWorkflow}
          />
        ))}
      </AnimatePresence>
    </div>
  )
}

export default function TaskQueue({ sendMessage, defaultProjectPath, onWatchTask, onNavigateToWorkflow }: TaskQueueProps) {
  const _prefersReducedMotion = useReducedMotion()
  const tasks = useTaskStore((s) => s.tasks)
  const templates = useTaskStore((s) => s.templates)
  const stats = useTaskStore((s) => s.stats)
  const selectedTaskId = useTaskStore((s) => s.selectedTaskId)
  const setSelectedTaskId = useTaskStore((s) => s.setSelectedTaskId)
  const showTemplateManager = useTaskStore((s) => s.showTemplateManager)
  const setShowTemplateManager = useTaskStore((s) => s.setShowTemplateManager)

  const [showForm, setShowForm] = useState(false)
  const [outputContent, setOutputContent] = useState<string | null>(null)
  const [outputTaskId, setOutputTaskId] = useState<string | null>(null)
  const [isLoadingOutput, setIsLoadingOutput] = useState(false)

  const runningTasks = tasks.filter((t) => t.status === 'running')
  const queuedTasks = tasks.filter((t) => t.status === 'queued')
  const recentTasks = tasks.filter((t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled')

  const handleCancel = useCallback((taskId: string) => {
    sendMessage({ type: 'task-cancel', taskId })
  }, [sendMessage])

  const handleRetry = useCallback((taskId: string) => {
    sendMessage({ type: 'task-retry', taskId })
  }, [sendMessage])

  const handleViewOutput = useCallback(async (taskId: string) => {
    setIsLoadingOutput(true)
    try {
      const res = await authFetch(`/api/tasks/${taskId}/output`)
      if (res.ok) {
        const data = await res.json()
        setOutputContent(data.output)
        setOutputTaskId(taskId)
      }
    } catch (err) {
      toastManager.add({ title: 'Failed to load task output', type: 'error', description: err instanceof Error ? err.message : 'Network error' })
    } finally {
      setIsLoadingOutput(false)
    }
  }, [])

  if (showTemplateManager) {
    return <TemplateManager onClose={() => setShowTemplateManager(false)} />
  }

  if (showForm) {
    return (
      <TaskForm
        templates={templates}
        defaultProjectPath={defaultProjectPath}
        sendMessage={sendMessage}
        onClose={() => setShowForm(false)}
      />
    )
  }

  // Output viewer
  if (isLoadingOutput || (outputContent !== null && outputTaskId)) {
    return (
      <TaskOutputViewer
        isLoading={isLoadingOutput}
        content={outputContent}
        taskId={outputTaskId}
        onClose={() => { setOutputContent(null); setOutputTaskId(null) }}
      />
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-white/70">Task Queue</span>
          {(stats.running > 0 || stats.queued > 0) && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/20 text-blue-300">
              {stats.running} running{stats.queued > 0 ? ` / ${stats.queued} queued` : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowTemplateManager(true)}
            className="text-[10px] px-2 py-1 rounded bg-white/5 text-white/50 hover:bg-white/10 transition-colors"
            title="Manage templates"
          >
            Templates
          </button>
          <button
            onClick={() => setShowForm(true)}
            className="text-[10px] px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors"
          >
            + New Task
          </button>
        </div>
      </div>

      {/* Task lists */}
      <div className="flex-1 overflow-y-auto">
        {tasks.length === 0 && (
          <div className="flex items-center justify-center h-32 text-xs text-white/30">
            No tasks yet. Click "+ New Task" to queue one.
          </div>
        )}
        <TaskListSection label="Running" tasks={runningTasks} selectedTaskId={selectedTaskId}
          onSelect={setSelectedTaskId} onCancel={handleCancel} onRetry={handleRetry}
          onViewOutput={handleViewOutput} onWatch={onWatchTask} onNavigateToWorkflow={onNavigateToWorkflow} />
        <TaskListSection label="Queued" tasks={queuedTasks} selectedTaskId={selectedTaskId}
          onSelect={setSelectedTaskId} onCancel={handleCancel} onRetry={handleRetry}
          onViewOutput={handleViewOutput} onNavigateToWorkflow={onNavigateToWorkflow} />
        <TaskListSection label="Recent" tasks={recentTasks.slice(0, 20)} selectedTaskId={selectedTaskId}
          onSelect={setSelectedTaskId} onCancel={handleCancel} onRetry={handleRetry}
          onViewOutput={handleViewOutput} onNavigateToWorkflow={onNavigateToWorkflow} />
      </div>

      {/* Footer stats */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-white/10 text-[10px] text-white/30">
        <span>Today: {stats.completedToday} completed, {stats.failedToday} failed</span>
      </div>
    </div>
  )
}
