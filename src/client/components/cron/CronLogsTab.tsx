// CronLogsTab.tsx — Unified log viewer
// WU-013: History & Logs Tabs
//
// Line numbers default on, toggleable (REQ-33).
// Live tail toggle with green indicator and 2s auto-refresh (REQ-32).
// Cmd+F search with match highlighting (REQ-33).
// Copy All button, monospace dark background.

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useCronStore } from '../../stores/cronStore'
import type { CronJob, ClientMessage } from '../../../shared/types'

type SendMessage = (message: ClientMessage) => void

interface CronLogsTabProps {
  job: CronJob
  sendMessage: SendMessage
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function CronLogsTab({ job, sendMessage }: CronLogsTabProps) {
  const { selectedJobDetail } = useCronStore()
  const [showLineNumbers, setShowLineNumbers] = useState(true)
  const [liveTail, setLiveTail] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const logContainerRef = useRef<HTMLDivElement>(null)
  const tailIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Source logs from detail (recentLogs) — updated by the store on cron-job-detail
  const rawLines = selectedJobDetail?.recentLogs ?? []

  // Fetch logs on mount
  useEffect(() => {
    sendMessage({ type: 'cron-job-logs', jobId: job.id, lines: 200 })
  }, [job.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Live tail: poll every 2s
  useEffect(() => {
    if (liveTail) {
      tailIntervalRef.current = setInterval(() => {
        sendMessage({ type: 'cron-job-logs', jobId: job.id, lines: 200 })
      }, 2000)
    } else {
      if (tailIntervalRef.current != null) {
        clearInterval(tailIntervalRef.current)
        tailIntervalRef.current = null
      }
    }
    return () => {
      if (tailIntervalRef.current != null) clearInterval(tailIntervalRef.current)
    }
  }, [liveTail, job.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll on new lines when live tail is on
  useEffect(() => {
    if (liveTail && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
    }
  }, [rawLines.length, liveTail])

  // Filter lines by search query
  const filteredLines = searchQuery.trim()
    ? rawLines.filter((l) => l.toLowerCase().includes(searchQuery.toLowerCase()))
    : rawLines

  const matchCount = searchQuery.trim() ? filteredLines.length : null

  // Highlight matches within a line
  function highlightLine(line: string): React.ReactNode {
    if (!searchQuery.trim()) return line
    const regex = new RegExp(`(${escapeRegex(searchQuery)})`, 'gi')
    const parts = line.split(regex)
    return parts.map((part, i) =>
      regex.test(part) ? (
        <mark key={i} className="bg-yellow-500/40 text-yellow-200 rounded-sm">
          {part}
        </mark>
      ) : (
        part
      ),
    )
  }

  const handleCopyAll = useCallback(() => {
    const text = filteredLines.join('\n')
    navigator.clipboard.writeText(text).catch(() => {
      // Clipboard API not available — silently ignore
    })
  }, [filteredLines])

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-700 shrink-0 flex-wrap">
        {/* Live tail toggle */}
        <button
          onClick={() => setLiveTail((v) => !v)}
          className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors ${
            liveTail
              ? 'bg-green-700 text-white'
              : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
          }`}
          title={liveTail ? 'Stop live tail' : 'Start live tail (polls every 2s)'}
        >
          {liveTail && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-300 animate-pulse inline-block" />
          )}
          {liveTail ? 'Live' : 'Tail'}
        </button>

        {/* Line numbers toggle */}
        <button
          onClick={() => setShowLineNumbers((v) => !v)}
          className={`px-2 py-1 text-xs rounded transition-colors ${
            showLineNumbers
              ? 'bg-zinc-600 text-zinc-200'
              : 'bg-zinc-700 text-zinc-400 hover:bg-zinc-600'
          }`}
          title="Toggle line numbers"
        >
          #
        </button>

        {/* Search */}
        <div className="relative flex-1 min-w-0 max-w-xs">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter logs…"
            className="w-full pl-2 pr-6 py-1 text-xs bg-zinc-900 border border-zinc-600 rounded text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-500"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-1 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 text-xs leading-none"
            >
              ×
            </button>
          )}
        </div>

        {/* Match count */}
        {matchCount != null && (
          <span className="text-xs text-zinc-500 shrink-0">
            {matchCount} {matchCount === 1 ? 'match' : 'matches'}
          </span>
        )}

        {/* Copy All */}
        <button
          onClick={handleCopyAll}
          className="ml-auto px-2 py-1 text-xs bg-zinc-700 text-zinc-300 rounded hover:bg-zinc-600 transition-colors shrink-0"
          title="Copy all visible lines to clipboard"
        >
          Copy All
        </button>
      </div>

      {/* Log content */}
      <div
        ref={logContainerRef}
        className="flex-1 overflow-y-auto bg-zinc-900 font-mono text-xs text-zinc-300 min-h-0"
      >
        {filteredLines.length === 0 ? (
          <div className="flex items-center justify-center h-full text-zinc-600">
            {rawLines.length === 0 ? 'No logs available' : 'No lines match filter'}
          </div>
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {filteredLines.map((line, i) => (
                <tr key={i} className="hover:bg-zinc-800/50">
                  {showLineNumbers && (
                    <td className="text-right text-zinc-600 select-none pr-3 pl-3 py-0 w-10 align-top whitespace-nowrap">
                      {i + 1}
                    </td>
                  )}
                  <td className={`pr-3 py-0 align-top break-all whitespace-pre-wrap ${showLineNumbers ? '' : 'pl-3'}`}>
                    {highlightLine(line)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
