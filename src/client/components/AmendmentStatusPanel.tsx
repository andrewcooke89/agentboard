import React, { useState } from 'react'
import type { AmendmentBudgetStatus, AmendmentDetail } from '@shared/types'
import { authFetch } from '../utils/api'

export interface AmendmentStatusPanelProps {
  runId: string
  amendment: AmendmentDetail | null
  budget: AmendmentBudgetStatus | null
  isPausedEscalated: boolean
  onApprove: () => void
  onReject: () => void
  onDefer: () => void
  onOverrideAutoApproval: () => void
  onExtendBudget: (category: string, newMax: number) => void
}

export default function AmendmentStatusPanel({
  runId,
  amendment,
  budget,
  isPausedEscalated,
  onApprove,
  onReject,
  onDefer,
  onOverrideAutoApproval,
  onExtendBudget,
}: AmendmentStatusPanelProps) {
  const [showExtendDialog, setShowExtendDialog] = useState(false)
  const [extendCategory, setExtendCategory] = useState<'quality' | 'reconciliation'>('quality')
  const [extendNewMax, setExtendNewMax] = useState<string>('')
  const [extendError, setExtendError] = useState<string | null>(null)
  const [isExtending, setIsExtending] = useState(false)

  if (!amendment) {
    return null
  }

  const handleExtendBudget = async () => {
    setExtendError(null)
    const newMaxValue = parseInt(extendNewMax, 10)

    if (!extendNewMax || isNaN(newMaxValue) || newMaxValue < 1) {
      setExtendError('Please enter a valid positive number')
      return
    }

    if (newMaxValue > 10000) {
      setExtendError('Maximum allowed value is 10000')
      return
    }

    if (!budget) {
      setExtendError('Budget information not available')
      return
    }

    const currentUsed = budget[extendCategory].used
    if (newMaxValue <= currentUsed) {
      setExtendError(`New max must be greater than current used count (${currentUsed})`)
      return
    }

    setIsExtending(true)
    try {
      const response = await authFetch(`/api/workflow-runs/${runId}/amendment-budget`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: extendCategory, new_max: newMaxValue }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.error || 'Failed to extend budget')
      }

      onExtendBudget(extendCategory, newMaxValue)
      setShowExtendDialog(false)
      setExtendNewMax('')
      setExtendError(null)
    } catch (error) {
      setExtendError(error instanceof Error ? error.message : 'Unknown error occurred')
    } finally {
      setIsExtending(false)
    }
  }

  const renderBudgetBar = (category: 'quality' | 'reconciliation') => {
    if (!budget) return null

    const { used, max } = budget[category]
    const percentage = max > 0 ? (used / max) * 100 : 0
    const isExhausted = used >= max

    return (
      <div className="mb-3">
        <div className="flex justify-between text-sm mb-1">
          <span className="text-gray-300 capitalize">{category}</span>
          <span className={isExhausted ? 'text-red-400 font-semibold' : 'text-gray-400'}>
            {used} / {max}
          </span>
        </div>
        <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
          <div
            className={`h-full transition-all ${
              isExhausted
                ? 'bg-red-500'
                : percentage > 80
                ? 'bg-yellow-500'
                : 'bg-blue-500'
            }`}
            style={{ width: `${Math.min(percentage, 100)}%` }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <h3 className="text-lg font-semibold text-white mb-4">
        {isPausedEscalated ? 'Budget Exhausted - Amendment Escalated' : 'Pending Amendment Review'}
      </h3>

      {/* Auto-approval banner */}
      {amendment.autoApproved && (
        <div className="bg-yellow-900 border border-yellow-700 rounded-lg p-3 mb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <svg
                className="w-5 h-5 text-yellow-400"
                fill="currentColor"
                viewBox="0 0 20 20"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
                  clipRule="evenodd"
                />
              </svg>
              <span className="text-yellow-200 font-medium">
                Auto-approved by {amendment.autoApprovedBy || 'spec-reviewer'}
              </span>
            </div>
            <button
              onClick={onOverrideAutoApproval}
              className="px-3 py-1 bg-yellow-700 hover:bg-yellow-600 text-white text-sm rounded transition-colors focus:outline-none focus:ring-2 focus:ring-yellow-500"
              aria-label="Override auto-approval"
            >
              Override
            </button>
          </div>
        </div>
      )}

      {/* Amendment details */}
      <div className="space-y-3 mb-4">
        <div>
          <label className="block text-sm font-medium text-gray-400 mb-1">
            Spec Section
          </label>
          <div className="text-white bg-gray-700 rounded px-3 py-2 font-mono text-sm">
            {amendment.specSection}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-400 mb-1">
            Issue
          </label>
          <div className="text-white bg-gray-700 rounded px-3 py-2 text-sm whitespace-pre-wrap">
            {amendment.issue}
          </div>
        </div>

        {amendment.proposedChange && (
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">
              Proposed Change
            </label>
            <div className="text-white bg-gray-700 rounded px-3 py-2 text-sm whitespace-pre-wrap">
              {amendment.proposedChange}
            </div>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-400 mb-1">
            Category
          </label>
          <div className="inline-block px-2 py-1 bg-blue-900 text-blue-200 rounded text-xs font-medium">
            {amendment.category}
          </div>
        </div>
      </div>

      {/* Budget status */}
      {budget && (
        <div className="mb-4 bg-gray-750 rounded-lg p-3 border border-gray-600">
          <h4 className="text-sm font-semibold text-gray-300 mb-3">Amendment Budget</h4>
          {renderBudgetBar('quality')}
          {renderBudgetBar('reconciliation')}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={onApprove}
          className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded transition-colors focus:outline-none focus:ring-2 focus:ring-green-500"
          aria-label="Approve amendment"
        >
          Approve
        </button>
        <button
          onClick={onReject}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded transition-colors focus:outline-none focus:ring-2 focus:ring-red-500"
          aria-label="Reject amendment"
        >
          Reject
        </button>
        <button
          onClick={onDefer}
          className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded transition-colors focus:outline-none focus:ring-2 focus:ring-gray-500"
          aria-label="Defer amendment decision"
        >
          Defer
        </button>
        {isPausedEscalated && (
          <button
            onClick={() => setShowExtendDialog(true)}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded transition-colors focus:outline-none focus:ring-2 focus:ring-purple-500"
          >
            Extend Budget
          </button>
        )}
      </div>

      {/* Extend Budget Dialog */}
      {showExtendDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div
            className="bg-gray-800 border border-gray-700 rounded-lg p-6 max-w-md w-full mx-4"
            role="dialog"
            aria-labelledby="extend-budget-title"
            aria-modal="true"
          >
            <h3 id="extend-budget-title" className="text-lg font-semibold text-white mb-4">
              Extend Amendment Budget
            </h3>

            <div className="space-y-4 mb-6">
              <div>
                <label htmlFor="budget-category" className="block text-sm font-medium text-gray-300 mb-2">
                  Category
                </label>
                <select
                  id="budget-category"
                  value={extendCategory}
                  onChange={(e) => setExtendCategory(e.target.value as 'quality' | 'reconciliation')}
                  className="w-full bg-gray-700 text-white border border-gray-600 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="quality">Quality</option>
                  <option value="reconciliation">Reconciliation</option>
                </select>
              </div>

              <div>
                <label htmlFor="new-max" className="block text-sm font-medium text-gray-300 mb-2">
                  New Maximum
                  {budget && (
                    <span className="ml-2 text-gray-400 text-xs">
                      (current: {budget[extendCategory].used} used / {budget[extendCategory].max} max)
                    </span>
                  )}
                </label>
                <input
                  id="new-max"
                  type="number"
                  min="1"
                  max="10000"
                  value={extendNewMax}
                  onChange={(e) => {
                    setExtendNewMax(e.target.value)
                    setExtendError(null)
                  }}
                  className="w-full bg-gray-700 text-white border border-gray-600 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Enter new maximum (max: 10000)"
                  autoFocus
                />
              </div>

              {extendError && (
                <div className="text-red-400 text-sm bg-red-900 bg-opacity-20 border border-red-800 rounded px-3 py-2">
                  {extendError}
                </div>
              )}
            </div>

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  setShowExtendDialog(false)
                  setExtendNewMax('')
                  setExtendError(null)
                }}
                disabled={isExtending}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded transition-colors focus:outline-none focus:ring-2 focus:ring-gray-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                onClick={handleExtendBudget}
                disabled={isExtending}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isExtending ? 'Extending...' : 'Extend'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
