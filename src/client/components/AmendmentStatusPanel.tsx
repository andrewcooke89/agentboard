import React, { useState } from 'react'
import type { AmendmentBudgetStatus, AmendmentDetail } from '@shared/types'
import ExtendBudgetDialog from './ExtendBudgetDialog'
import { AutoApprovalBanner, AmendmentDetails, BudgetStatusSection } from './AmendmentSubSections'

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

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <h3 className="text-lg font-semibold text-white mb-4">
        {isPausedEscalated ? 'Budget Exhausted - Amendment Escalated' : 'Pending Amendment Review'}
      </h3>

      <AutoApprovalBanner
        amendment={amendment}
        onOverrideAutoApproval={onOverrideAutoApproval}
      />

      <AmendmentDetails amendment={amendment} />

      {budget && <BudgetStatusSection budget={budget} />}

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

      {showExtendDialog && (
        <ExtendBudgetDialog
          runId={runId}
          budget={budget}
          onExtendBudget={onExtendBudget}
          onClose={() => setShowExtendDialog(false)}
        />
      )}
    </div>
  )
}
