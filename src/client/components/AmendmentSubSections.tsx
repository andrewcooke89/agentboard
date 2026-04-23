import React from 'react'
import type { AmendmentBudgetStatus, AmendmentDetail } from '@shared/types'

interface AutoApprovalBannerProps {
  amendment: AmendmentDetail
  onOverrideAutoApproval: () => void
}

export function AutoApprovalBanner({ amendment, onOverrideAutoApproval }: AutoApprovalBannerProps) {
  if (!amendment.autoApproved) {
    return null
  }

  return (
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
  )
}

interface AmendmentDetailsProps {
  amendment: AmendmentDetail
}

export function AmendmentDetails({ amendment }: AmendmentDetailsProps) {
  return (
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
  )
}

function BudgetBar({
  category,
  used,
  max,
}: {
  category: 'quality' | 'reconciliation'
  used: number
  max: number
}) {
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

interface BudgetStatusSectionProps {
  budget: AmendmentBudgetStatus
}

export function BudgetStatusSection({ budget }: BudgetStatusSectionProps) {
  return (
    <div className="mb-4 bg-gray-750 rounded-lg p-3 border border-gray-600">
      <h4 className="text-sm font-semibold text-gray-300 mb-3">Amendment Budget</h4>
      <BudgetBar category="quality" used={budget.quality.used} max={budget.quality.max} />
      <BudgetBar category="reconciliation" used={budget.reconciliation.used} max={budget.reconciliation.max} />
    </div>
  )
}
