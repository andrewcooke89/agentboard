import React, { useState, useEffect, useRef } from 'react'
import type { StepRunStatus } from '@shared/types'

interface RunningSession {
  stepName: string
  status: StepRunStatus
  taskId: string | null
  startedAt: string | null
  output: string
}

export interface TerminalTabsProps {
  sessions: RunningSession[]
  activeTabId?: string
  onSelectTab: (stepName: string) => void
  autoFocusOnError?: boolean
}

type TabStatus = 'active' | 'idle' | 'error' | 'completed'

interface TabInfo {
  stepName: string
  status: TabStatus
  session: RunningSession
}

const MAX_VISIBLE_TABS = 4

function getTabStatus(session: RunningSession): TabStatus {
  // Completed states
  if (session.status === 'completed' || session.status === 'skipped') {
    return 'completed'
  }

  // Error states
  if (session.status === 'failed' || session.status === 'cancelled' || session.status === 'signal_error') {
    return 'error'
  }

  // Active (running with output)
  if ((session.status === 'running' || session.status === 'waiting_signal' || session.status === 'signal_received') && session.output.length > 0) {
    return 'active'
  }

  // Idle (running but no output yet)
  if (session.status === 'running' || session.status === 'waiting_signal' || session.status === 'signal_received') {
    return 'idle'
  }

  return 'idle'
}

function getStatusDotColor(status: TabStatus): string {
  switch (status) {
    case 'active':
      return 'bg-green-500'
    case 'idle':
      return 'bg-yellow-500'
    case 'error':
      return 'bg-red-500'
    case 'completed':
      return 'bg-gray-500'
  }
}

function getStatusDotLabel(status: TabStatus): string {
  switch (status) {
    case 'active':
      return 'Active'
    case 'idle':
      return 'Idle'
    case 'error':
      return 'Error'
    case 'completed':
      return 'Completed'
  }
}

export default function TerminalTabs({
  sessions,
  activeTabId,
  onSelectTab,
  autoFocusOnError = true
}: TerminalTabsProps) {
  const [selectedTab, setSelectedTab] = useState<string | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const previousSessionsRef = useRef<RunningSession[]>([])

  // Filter out queued/pending sessions (they don't get tabs)
  const visibleSessions = sessions.filter(
    s => s.status !== 'queued' && s.status !== 'pending'
  )

  const queuedSessions = sessions.filter(
    s => s.status === 'queued' || s.status === 'pending'
  )

  const tabs: TabInfo[] = visibleSessions.map(session => ({
    stepName: session.stepName,
    status: getTabStatus(session),
    session
  }))

  // Auto-focus on error ONLY
  useEffect(() => {
    if (!autoFocusOnError) return

    const previousSessions = previousSessionsRef.current
    const newErrorSession = tabs.find(tab => {
      const previous = previousSessions.find(s => s.stepName === tab.stepName)
      const previousStatus = previous ? getTabStatus(previous) : null
      return tab.status === 'error' && previousStatus !== 'error'
    })

    if (newErrorSession) {
      setSelectedTab(newErrorSession.stepName)
      onSelectTab(newErrorSession.stepName)
    }

    previousSessionsRef.current = visibleSessions
  }, [visibleSessions, tabs, autoFocusOnError, onSelectTab])

  // Default to first tab when no selection exists (no auto-switch on new sessions)
  useEffect(() => {
    if (selectedTab === null && tabs.length > 0) {
      setSelectedTab(tabs[0].stepName)
    }
  }, [tabs, selectedTab])

  // Handle external activeTabId changes
  useEffect(() => {
    if (activeTabId && activeTabId !== selectedTab) {
      setSelectedTab(activeTabId)
    }
  }, [activeTabId])

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false)
      }
    }

    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [dropdownOpen])

  // Keyboard navigation (arrow keys + Escape)
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && dropdownOpen) {
        setDropdownOpen(false)
        event.preventDefault()
        return
      }

      // Arrow key navigation (only when focused on tab bar)
      if (!selectedTab || tabs.length === 0) return

      const currentIndex = tabs.findIndex(t => t.stepName === selectedTab)
      if (currentIndex === -1) return

      let newIndex = currentIndex
      if (event.key === 'ArrowRight') {
        newIndex = Math.min(currentIndex + 1, tabs.length - 1)
        event.preventDefault()
      } else if (event.key === 'ArrowLeft') {
        newIndex = Math.max(currentIndex - 1, 0)
        event.preventDefault()
      } else if (event.key === 'Home') {
        newIndex = 0
        event.preventDefault()
      } else if (event.key === 'End') {
        newIndex = tabs.length - 1
        event.preventDefault()
      }

      if (newIndex !== currentIndex) {
        const newTab = tabs[newIndex]
        setSelectedTab(newTab.stepName)
        onSelectTab(newTab.stepName)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [dropdownOpen, selectedTab, tabs, onSelectTab])

  function handleTabClick(stepName: string) {
    setSelectedTab(stepName)
    onSelectTab(stepName)
    setDropdownOpen(false)
  }

  function handleTabKeyDown(event: React.KeyboardEvent, stepName: string) {
    if (event.key === 'Enter') {
      handleTabClick(stepName)
    }
  }

  const visibleTabs = tabs.slice(0, MAX_VISIBLE_TABS)
  const overflowTabs = tabs.slice(MAX_VISIBLE_TABS)
  const hasOverflow = overflowTabs.length > 0

  const selectedSession = tabs.find(t => t.stepName === selectedTab)?.session

  // No sessions at all
  if (tabs.length === 0 && queuedSessions.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        No active sessions
      </div>
    )
  }

  // Only queued sessions
  if (tabs.length === 0 && queuedSessions.length > 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        <div className="text-center">
          <div className="mb-2">Waiting for pool slot...</div>
          <div className="text-xs text-gray-500">
            {queuedSessions.length} {queuedSessions.length === 1 ? 'step' : 'steps'} queued
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col">
      {/* Tab bar */}
      <div className="bg-gray-900 border-b border-gray-700 flex items-center">
        {/* Visible tabs */}
        {visibleTabs.map(tab => {
          const isActive = tab.stepName === selectedTab
          return (
            <button
              key={tab.stepName}
              className={`
                px-3 py-2 text-sm flex items-center gap-2 border-r border-gray-700
                hover:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-blue-500
                transition-colors
                ${isActive ? 'border-b-2 border-b-blue-400 bg-gray-800' : ''}
                ${tab.status === 'completed' ? 'text-gray-500' : 'text-gray-200'}
              `}
              onClick={() => handleTabClick(tab.stepName)}
              onKeyDown={(e) => handleTabKeyDown(e, tab.stepName)}
              tabIndex={0}
              role="tab"
              aria-selected={isActive}
              title={tab.stepName}
            >
              <span
                className={`w-2 h-2 rounded-full ${getStatusDotColor(tab.status)}`}
                title={getStatusDotLabel(tab.status)}
              />
              <span className="truncate max-w-[120px]">{tab.stepName}</span>
            </button>
          )
        })}

        {/* Overflow dropdown */}
        {hasOverflow && (
          <div className="relative" ref={dropdownRef}>
            <button
              className={`
                px-3 py-2 text-sm flex items-center gap-1 border-r border-gray-700
                hover:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-blue-500
                text-gray-200 transition-colors
                ${dropdownOpen ? 'bg-gray-800' : ''}
              `}
              onClick={() => setDropdownOpen(!dropdownOpen)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setDropdownOpen(!dropdownOpen)
                }
              }}
              tabIndex={0}
              aria-haspopup="true"
              aria-expanded={dropdownOpen}
            >
              <span>+{overflowTabs.length}</span>
              <svg
                className={`w-4 h-4 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {/* Dropdown menu */}
            {dropdownOpen && (
              <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-700 rounded shadow-lg min-w-[200px] max-h-[400px] overflow-y-auto z-50">
                {overflowTabs.map(tab => {
                  const isActive = tab.stepName === selectedTab
                  return (
                    <button
                      key={tab.stepName}
                      className={`
                        w-full px-3 py-2 text-sm flex items-center gap-2 text-left
                        hover:bg-gray-700 focus:outline-none focus:bg-gray-700
                        transition-colors
                        ${isActive ? 'bg-gray-700' : ''}
                        ${tab.status === 'completed' ? 'text-gray-500' : 'text-gray-200'}
                      `}
                      onClick={() => handleTabClick(tab.stepName)}
                      onKeyDown={(e) => handleTabKeyDown(e, tab.stepName)}
                      tabIndex={0}
                    >
                      <span
                        className={`w-2 h-2 rounded-full ${getStatusDotColor(tab.status)}`}
                        title={getStatusDotLabel(tab.status)}
                      />
                      <span className="truncate">{tab.stepName}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Queued indicator */}
        {queuedSessions.length > 0 && (
          <div className="ml-auto px-3 py-2 text-xs text-gray-500 flex items-center gap-2">
            <svg className="w-3 h-3 animate-pulse" fill="currentColor" viewBox="0 0 20 20">
              <path d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" />
            </svg>
            {queuedSessions.length} queued
          </div>
        )}
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-auto bg-black p-4">
        {selectedSession ? (
          <pre className="font-mono text-sm text-gray-100 whitespace-pre-wrap break-words">
            {selectedSession.output || '(no output yet)'}
          </pre>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-500 text-sm">
            Select a tab to view output
          </div>
        )}
      </div>
    </div>
  )
}
