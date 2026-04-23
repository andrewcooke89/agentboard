// WorkflowDetail.tsx - Workflow detail view with run history and pipeline diagram
import { useEffect, useState } from 'react'
import yaml from 'js-yaml'
import { useWorkflowStore } from '../stores/workflowStore'
import type { WorkflowRun, WorkflowStatus, WorkflowVariable } from '@shared/types'
import PipelineDiagram from './PipelineDiagram'
import WorkflowRunDialog from './WorkflowRunDialog'
import TierBadge from './TierBadge'
import SignalsTab from './SignalsTab'
import AmendmentStatusPanel from './AmendmentStatusPanel'


export interface WorkflowDetailProps {
  workflowId: string
  onBack: () => void
  onEdit: (id: string) => void
  onNavigateToSession?: (sessionName: string) => void
}

/** Format ISO timestamp to readable string */
function formatDate(iso: string | null): string {
  if (!iso) return '-'
  try {
    return new Date(iso).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return 'N/A'
  }
}

/** Status badge color map */
function statusColor(status: WorkflowStatus): string {
  switch (status) {
    case 'completed':
      return 'bg-green-900/50 text-green-400 border-green-700'
    case 'running':
      return 'bg-blue-900/50 text-blue-400 border-blue-700'
    case 'failed':
      return 'bg-red-900/50 text-red-400 border-red-700'
    case 'cancelled':
      return 'bg-yellow-900/50 text-yellow-400 border-yellow-700'
    case 'pending':
    default:
      return 'bg-gray-800 text-gray-400 border-gray-700'
  }
}

export default function WorkflowDetail({ workflowId, onBack, onEdit, onNavigateToSession }: WorkflowDetailProps) {
  const { workflows, workflowRuns, loadingRuns, getWorkflow, fetchRuns, triggerRun, deleteWorkflow, resumeRun, cancelRun } =
    useWorkflowStore()

  const workflow = workflows.find((w) => w.id === workflowId) ?? null

  useEffect(() => {
    getWorkflow(workflowId)
    fetchRuns(workflowId)
  }, [workflowId, getWorkflow, fetchRuns])

  const runs = workflowRuns.filter((r) => r.workflow_id === workflowId)

  // Find the most recent or active run for the pipeline diagram
  const activeRun = runs.find((r) => r.status === 'running') ?? runs[0] ?? null

  const [showRunDialog, setShowRunDialog] = useState(false)
  const [runDetailTab, setRunDetailTab] = useState<'pipeline' | 'signals' | 'amendments' | 'terminals'>('pipeline')

  // Parse variables from YAML for the run dialog
  const workflowVariables: WorkflowVariable[] = (() => {
    if (!workflow?.yaml_content) return []
    try {
      const doc = yaml.load(workflow.yaml_content) as Record<string, unknown>
      if (!doc || !Array.isArray(doc.variables)) return []
      return doc.variables.map((v: any) => ({
        name: String(v.name ?? ''),
        type: (v.type === 'path' ? 'path' : 'string') as 'string' | 'path',
        description: String(v.description ?? ''),
        required: v.required === false || v.required === 'false' ? false : true,
        default: v.default !== undefined ? String(v.default) : undefined,
      }))
    } catch (err) {
      console.warn('Failed to parse workflow variables from YAML:', err)
      return []
    }
  })()

  const handleDelete = async () => {
    const confirmed = window.confirm(`Delete workflow "${workflow?.name ?? workflowId}"? This cannot be undone.`)
    if (confirmed) {
      await deleteWorkflow(workflowId)
      onBack()
    }
  }

  const handleRun = async () => {
    if (workflowVariables.length > 0) {
      setShowRunDialog(true)
    } else {
      await triggerRun(workflowId)
    }
  }

  const handleRunWithVariables = async (variables: Record<string, string>) => {
    setShowRunDialog(false)
    await triggerRun(workflowId, variables)
  }

  const handleResume = async (runId: string) => {
    await resumeRun(runId)
  }

  const handleCancel = async (runId: string) => {
    await cancelRun(runId)
  }

  // Loading state while workflow is being fetched
  if (!workflow) {
    return (
      <div className="flex flex-col gap-4">
        <button
          type="button"
          onClick={onBack}
          className="text-gray-400 hover:text-white text-sm self-start transition-colors"
        >
          &larr; Back to workflows
        </button>
        <div className="flex items-center justify-center p-12 text-gray-500 text-sm" role="status">
          Loading workflow...
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Back button */}
      <button
        type="button"
        onClick={onBack}
        className="text-gray-400 hover:text-white text-sm self-start transition-colors"
      >
        &larr; Back to workflows
      </button>

      {/* Workflow header */}
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold text-white">{workflow.name}</h2>
          {workflow.description && (
            <p className="text-gray-400 text-sm">{workflow.description}</p>
          )}
          <div className="flex items-center gap-3 text-xs text-gray-500 mt-1">
            <span>{workflow.step_count} step{workflow.step_count !== 1 ? 's' : ''}</span>
            <span>
              {workflow.is_valid ? (
                <span className="text-green-400">Valid</span>
              ) : (
                <span className="text-red-400">Invalid</span>
              )}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRun}
            disabled={!workflow.is_valid}
            aria-label="Run workflow"
            className="px-3 py-1.5 text-sm font-medium text-white bg-green-600 hover:bg-green-500 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed rounded transition-colors"
          >
            Run
          </button>
          <button
            type="button"
            onClick={() => onEdit(workflowId)}
            aria-label="Edit workflow"
            className="px-3 py-1.5 text-sm font-medium text-white bg-gray-700 hover:bg-gray-600 rounded transition-colors"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={handleDelete}
            aria-label="Delete workflow"
            className="px-3 py-1.5 text-sm font-medium text-red-400 bg-gray-700 hover:bg-red-900/50 rounded transition-colors"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Validation errors */}
      {!workflow.is_valid && workflow.validation_errors.length > 0 && (
        <div className="p-3 bg-red-900/20 border border-red-800 rounded text-sm">
          <h3 className="text-red-400 font-medium mb-2">Validation Errors</h3>
          <ul className="list-disc list-inside text-red-300 text-xs space-y-1">
            {workflow.validation_errors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
      )}

      {/* YAML content */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-gray-400">YAML Definition</h3>
        <pre className="bg-gray-800 border border-gray-700 rounded p-4 overflow-x-auto text-xs text-gray-300 font-mono">
          <code>{workflow.yaml_content}</code>
        </pre>
      </div>

      {/* Run detail tabs (REQ-28 through REQ-31) */}
      {activeRun && (
        <div className="flex flex-col gap-2">
          {/* Tab bar */}
          <div className="flex items-center gap-1 border-b border-gray-700">
            {(['pipeline', 'signals', 'amendments', 'terminals'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setRunDetailTab(tab)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors border-b-2 ${
                  runDetailTab === tab
                    ? 'text-white border-blue-400'
                    : 'text-gray-400 border-transparent hover:text-gray-300'
                }`}
                aria-selected={runDetailTab === tab}
                role="tab"
              >
                {tab === 'pipeline' ? 'Pipeline' : tab === 'signals' ? 'Signals' : tab === 'amendments' ? 'Amendments' : 'Terminals'}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="bg-gray-800 border border-gray-700 rounded p-2" role="tabpanel">
            {runDetailTab === 'pipeline' && (
              <PipelineDiagram run={activeRun} onNavigateToSession={onNavigateToSession} />
            )}
            {runDetailTab === 'signals' && (
              <SignalsTab signals={activeRun.steps_state.flatMap(s => s.detectedSignals ?? [])} />
            )}
            {runDetailTab === 'amendments' && (
              <AmendmentStatusPanel
                runId={activeRun.id}
                amendment={activeRun.pendingAmendment ?? null}
                budget={activeRun.amendmentBudget ?? null}
                isPausedEscalated={activeRun.status === 'failed' && activeRun.steps_state.some(s => s.status === 'paused_escalated')}
                onApprove={() => {}}
                onReject={() => {}}
                onDefer={() => {}}
                onOverrideAutoApproval={() => {}}
                onExtendBudget={() => {}}
              />
            )}
            {runDetailTab === 'terminals' && (
              <div className="text-gray-400 text-sm p-4">No terminal sessions available</div>
            )}
          </div>
        </div>
      )}

      {/* Run history */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-gray-400">Run History</h3>
        {loadingRuns && runs.length === 0 && (
          <div className="text-gray-500 text-sm p-4 text-center" role="status">
            Loading runs...
          </div>
        )}
        {!loadingRuns && runs.length === 0 && (
          <div className="text-gray-500 text-sm p-4 text-center" role="status">
            No runs yet
          </div>
        )}
        {runs.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="text-gray-400 border-b border-gray-700 text-xs uppercase tracking-wider">
                  <th className="px-4 py-2 font-medium">Run ID</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Started</th>
                  <th className="px-4 py-2 font-medium">Completed</th>
                  <th className="px-4 py-2 font-medium">Step</th>
                  <th className="px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    onResume={handleResume}
                    onCancel={handleCancel}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Run dialog */}
      {showRunDialog && workflow && (
        <WorkflowRunDialog
          variables={workflowVariables}
          workflowName={workflow.name}
          onRun={handleRunWithVariables}
          onCancel={() => setShowRunDialog(false)}
        />
      )}
    </div>
  )
}

/** Individual run row component */
function RunRow({
  run,
  onResume,
  onCancel,
}: {
  run: WorkflowRun
  onResume: (id: string) => void
  onCancel: (id: string) => void
}) {
  const totalSteps = run.steps_state.length
  const currentLabel =
    run.current_step_index < totalSteps
      ? `${run.current_step_index + 1}/${totalSteps}`
      : `${totalSteps}/${totalSteps}`

  return (
    <tr className="border-b border-gray-700/50">
      <td className="px-4 py-3 text-gray-300 font-mono text-xs">{run.id.slice(0, 8)}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={`inline-block px-2 py-0.5 text-xs rounded border ${statusColor(run.status)}`}>
            {run.status}
          </span>
          {run.tier && <TierBadge tier={run.tier} skippedSteps={run.steps_state.filter(s => s.status === 'skipped' && s.skippedReason === 'tier_filtered').map(s => s.name)} />}
        </div>
      </td>
      <td className="px-4 py-3 text-gray-400 text-xs">{formatDate(run.started_at)}</td>
      <td className="px-4 py-3 text-gray-400 text-xs">{formatDate(run.completed_at)}</td>
      <td className="px-4 py-3 text-gray-300 text-xs">{currentLabel}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {run.status === 'failed' && (
            <button
              type="button"
              onClick={() => onResume(run.id)}
              aria-label="Resume run"
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              Resume
            </button>
          )}
          {run.status === 'running' && (
            <button
              type="button"
              onClick={() => onCancel(run.id)}
              aria-label="Cancel run"
              className="text-xs text-red-400 hover:text-red-300 transition-colors"
            >
              Cancel
            </button>
          )}
        </div>
      </td>
    </tr>
  )
}
