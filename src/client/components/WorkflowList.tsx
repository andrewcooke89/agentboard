// WorkflowList.tsx - Workflow list with filtering, loading, and empty states
import { useEffect, useState } from 'react'
import { useWorkflowStore } from '../stores/workflowStore'
import type { WorkflowDefinition } from '@shared/types'

type FilterValue = 'all' | 'valid' | 'invalid'

export interface WorkflowListProps {
  onSelectWorkflow: (id: string) => void
  onCreateNew: () => void
}

/** Format ISO timestamp to readable date string */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return 'N/A'
  }
}

export default function WorkflowList({ onSelectWorkflow, onCreateNew }: WorkflowListProps) {
  const { workflows, loadingWorkflows, fetchWorkflows, hasLoaded, fetchError } = useWorkflowStore()
  const [filter, setFilter] = useState<FilterValue>('all')

  useEffect(() => {
    if (!hasLoaded) {
      fetchWorkflows()
    }
  }, [hasLoaded, fetchWorkflows])

  const filtered: WorkflowDefinition[] = workflows.filter((w) => {
    if (filter === 'valid') return w.is_valid
    if (filter === 'invalid') return !w.is_valid
    return true
  })

  // Error state
  if (fetchError && !hasLoaded) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="flex flex-col items-center gap-3 text-red-400">
          <span className="text-sm">Failed to load workflows</span>
          <span className="text-xs text-gray-500">{fetchError}</span>
          <button
            type="button"
            onClick={() => fetchWorkflows()}
            className="px-3 py-1.5 text-xs font-medium text-white bg-gray-700 hover:bg-gray-600 rounded transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  // Loading state
  if (loadingWorkflows && !hasLoaded) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="flex items-center gap-3 text-gray-400">
          <svg
            className="animate-spin h-5 w-5"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          <span>Loading workflows...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-white">Workflows</h2>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as FilterValue)}
            className="bg-gray-800 text-gray-300 text-sm border border-gray-700 rounded px-2 py-1 focus:outline-none focus:border-gray-500"
            aria-label="Filter workflows by status"
          >
            <option value="all">All</option>
            <option value="valid">Valid</option>
            <option value="invalid">Invalid</option>
          </select>
        </div>
        <button
          type="button"
          onClick={onCreateNew}
          className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded transition-colors"
        >
          Create New
        </button>
      </div>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="flex items-center justify-center p-12 text-gray-500 text-sm" role="status">
          {workflows.length === 0
            ? 'No workflows yet. Create your first workflow.'
            : 'No workflows match the current filter.'}
        </div>
      )}

      {/* Workflow table */}
      {filtered.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="text-gray-400 border-b border-gray-700 text-xs uppercase tracking-wider">
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Description</th>
                <th className="px-4 py-2 font-medium">Steps</th>
                <th className="px-4 py-2 font-medium">Valid</th>
                <th className="px-4 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((wf) => (
                <tr
                  key={wf.id}
                  className="border-b border-gray-700/50 hover:bg-gray-800/50 transition-colors"
                >
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => onSelectWorkflow(wf.id)}
                      className="text-blue-400 hover:text-blue-300 font-medium transition-colors text-left"
                    >
                      {wf.name}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-gray-400 max-w-xs truncate">
                    {wf.description || '-'}
                  </td>
                  <td className="px-4 py-3 text-gray-300">{wf.step_count}</td>
                  <td className="px-4 py-3">
                    {wf.is_valid ? (
                      <span className="text-green-400" title="Valid" aria-label="Valid">
                        &#10003;
                      </span>
                    ) : (
                      <span className="text-red-400" title="Invalid" aria-label="Invalid">
                        &#9888;
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {formatDate(wf.updated_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
