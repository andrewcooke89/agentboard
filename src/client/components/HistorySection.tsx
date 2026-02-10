// HistorySection.tsx - Chat history search and browse panel
import { useState, useCallback, useEffect, useRef } from 'react'
import { useHistoryStore } from '../stores/historyStore'
import HistoryList from './HistoryList'
import type { HistorySession } from '@shared/types'

interface HistorySectionProps {
  onResumed?: () => void
}

export default function HistorySection({ onResumed }: HistorySectionProps) {
  const sessions = useHistoryStore((s) => s.sessions)
  const isLoading = useHistoryStore((s) => s.isLoading)
  const error = useHistoryStore((s) => s.error)
  const searchQuery = useHistoryStore((s) => s.searchQuery)
  const search = useHistoryStore((s) => s.search)
  const loadRecent = useHistoryStore((s) => s.loadRecent)
  const resumeSession = useHistoryStore((s) => s.resumeSession)
  const setSearchQuery = useHistoryStore((s) => s.setSearchQuery)

  const [resumeError, setResumeError] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  // Load recent on mount
  useEffect(() => {
    void loadRecent()
  }, [loadRecent])

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      if (value.trim()) {
        void search(value.trim())
      } else {
        void loadRecent()
      }
    }, 300)
  }, [search, loadRecent, setSearchQuery])

  const handleResume = useCallback(async (session: HistorySession) => {
    setResumeError(null)
    const result = await resumeSession(session.id, session.agentType)
    if (!result.ok) {
      setResumeError(result.error || 'Resume failed')
      setTimeout(() => setResumeError(null), 5000)
    } else {
      onResumed?.()
    }
  }, [resumeSession, onResumed])

  return (
    <div className="flex flex-col border-t border-white/10">
      <div className="px-3 py-2 border-b border-white/10">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs font-medium text-white/70">Chat History</span>
          {isLoading && (
            <span className="text-[10px] text-white/30 animate-pulse">loading...</span>
          )}
        </div>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search past sessions..."
          className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white/80 focus:outline-none focus:border-white/30"
        />
      </div>

      {error && (
        <div className="px-3 py-1.5 text-[10px] text-red-300 bg-red-500/10">
          {error}
        </div>
      )}
      {resumeError && (
        <div className="px-3 py-1.5 text-[10px] text-red-300 bg-red-500/10">
          {resumeError}
        </div>
      )}

      <div className="flex-1 overflow-y-auto max-h-64">
        <HistoryList sessions={sessions} onResume={handleResume} />
      </div>
    </div>
  )
}
