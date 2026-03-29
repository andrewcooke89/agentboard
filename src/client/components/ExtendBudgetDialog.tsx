import React, { useState } from 'react'
import type { AmendmentBudgetStatus } from '@shared/types'
import { authFetch } from '../utils/api'

interface ExtendBudgetDialogProps {
  open: boolean
  onClose: () => void
  runId: string
  budget: AmendmentBudgetStatus | null
  onExtendBudget: (category: string, newMax: number) => void
}

export default function ExtendBudgetDialog({
  open,
  onClose,
  runId,
  budget,
  onExtendBudget,
}: ExtendBudgetDialogProps) {
  const [extendCategory, setExtendCategory] = useState<'quality' | 'reconciliation'>('quality')
  const [extendNewMax, setExtendNewMax] = useState<string>('')
  const [extendError, setExtendError] = useState<string | null>(null)
  const [isExtending, setIsExtending] = useState(false)

  if (!open) {
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
      onClose()
    } catch (error) {
      setExtendError(error instanceof Error ? error.message : 'Unknown error occurred')
    } finally {
      setIsExtending(false)
    }
  }

  return (
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
            onClick={onClose}
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
  )
}
