import React, { useState } from 'react'
import type { AmendmentBudgetStatus, AmendmentDetail } from '@shared/types'
import ExtendBudgetDialog from './ExtendBudgetDialog'
import AutoApprovalBanner from './AutoApprovalBanner'

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

  if (!amendment) {
    return null
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

      {amendment.autoApproved && (
        <AutoApprovalBanner
          autoApprovedBy={amendment.autoApprovedBy ?? undefined}
          onOverride={onOverrideAutoApproval}
        />
      )}

      <div className="space-y-3 mb-4">
        <div>
          <label className="block text-sm font-medium text-gray-400 mb-1">Spec Section</label>
          <div className="text-white bg-gray-700 rounded px-3 py-2 font-mono text-sm">
            {amendment.specSection}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-400 mb-1">Issue</label>
          <div className="text-white bg-gray-700 rounded px-3 py-2 text-sm whitespace-pre-wrap">
            {amendment.issue}
          </div>
        </div>

        {amendment.proposedChange && (
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Proposed Change</label>
            <div className="text-white bg-gray-700 rounded px-3 py-2 text-sm whitespace-pre-wrap">
              {amendment.proposedChange}
            </div>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-400 mb-1">Category</label>
          <div className="inline-block px-2 py-1 bg-blue-900 text-blue-200 rounded text-xs font-medium">
            {amendment.category}
          </div>
        </div>
      </div>

      {budget && (
        <div className="mb-4 bg-gray-750 rounded-lg p-3 border border-gray-600">
          <h4 className="text-sm font-semibold text-gray-300 mb-3">Amendment Budget</h4>
          {renderBudgetBar('quality')}
          {renderBudgetBar('reconciliation')}
        </div>
      )}

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

      <ExtendBudgetDialog
        open={showExtendDialog}
        onClose={() => setShowExtendDialog(false)}
        runId={runId}
        budget={budget}
        onExtendBudget={onExtendBudget}
      />
    </div>
  )
}
