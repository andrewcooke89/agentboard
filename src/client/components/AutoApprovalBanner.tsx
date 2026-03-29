import React from 'react'

interface AutoApprovalBannerProps {
  autoApprovedBy: string | undefined
  onOverride: () => void
}

export default function AutoApprovalBanner({ autoApprovedBy, onOverride }: AutoApprovalBannerProps) {
  return (
    <div className="bg-yellow-900 border border-yellow-700 rounded-lg p-3 mb-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
          </svg>
          <span className="text-yellow-200 font-medium">
            Auto-approved by {autoApprovedBy || 'spec-reviewer'}
          </span>
        </div>
        <button
          className="px-3 py-1 bg-yellow-700 hover:bg-yellow-600 text-white text-sm rounded transition-colors focus:outline-none focus:ring-2 focus:ring-yellow-500"
          aria-label="Override auto-approval"
          onClick={onOverride}
        >
          Override
        </button>
      </div>
    </div>
  )
}
