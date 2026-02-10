// WorkflowPanel.tsx - Right-side monitoring panel for active workflow runs
import { useActiveRuns } from '../stores/workflowStore'
import type { WorkflowRun, WorkflowStatus } from '@shared/types'
import PipelineDiagram from './PipelineDiagram'

/** Status badge color classes */
const STATUS_BADGE: Record<WorkflowStatus, string> = {
  pending: 'bg-gray-500/20 text-gray-300',
  running: 'bg-blue-500/20 text-blue-300',
  completed: 'bg-green-500/20 text-green-300',
  failed: 'bg-red-500/20 text-red-300',
  cancelled: 'bg-gray-500/20 text-gray-400',
}

function RunStatusBadge({ status }: { status: WorkflowStatus }) {
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_BADGE[status] || STATUS_BADGE.pending}`}>
      {status}
    </span>
  )
}

function ActiveRunCard({ run }: { run: WorkflowRun }) {
  const stepCount = run.steps_state.length
  const currentStep = run.current_step_index + 1

  return (
    <div className="p-3 bg-gray-800 border border-gray-700 rounded-lg mb-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-bold text-white truncate" title={run.workflow_name}>
          {run.workflow_name}
        </span>
        <RunStatusBadge status={run.status} />
      </div>
      <div className="text-xs text-gray-400 mb-2">
        Step {currentStep} of {stepCount}
      </div>
      <PipelineDiagram run={run} compact />
    </div>
  )
}

export interface WorkflowPanelProps {
  isOpen: boolean
  onClose: () => void
}

export default function WorkflowPanel({ isOpen, onClose }: WorkflowPanelProps) {
  const activeRuns = useActiveRuns()

  return (
    <div
      className={`fixed top-0 right-0 h-full w-80 bg-gray-900 border-l border-gray-700 z-50 flex flex-col transition-transform duration-300 ease-in-out ${
        isOpen ? 'translate-x-0' : 'translate-x-full'
      }`}
      aria-label="Workflow monitoring panel"
      role="complementary"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h2 className="text-sm font-semibold text-white">Active Workflows</h2>
        <button
          type="button"
          className="text-gray-400 hover:text-white text-xs px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 transition-colors"
          onClick={onClose}
          aria-label="Close workflow panel"
        >
          Close
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3">
        {activeRuns.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-gray-500 text-sm" role="status">
            No active workflow runs
          </div>
        ) : (
          activeRuns.map((run) => (
            <ActiveRunCard key={run.id} run={run} />
          ))
        )}
      </div>
    </div>
  )
}
