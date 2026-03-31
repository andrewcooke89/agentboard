// WU-013: History & Logs Tabs — CronLogsTab

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useCronStore } from '../../stores/cronStore'

// ─── CronLogsTab ─────────────────────────────────────────────────────────────

export default function CronLogsTab(): React.ReactElement {
  const { selectedJobId, selectedJobDetail } = useCronStore()
  const detail = selectedJobDetail?.id === selectedJobId ? selectedJobDetail : null
  const lines = detail?.recentLogs ?? []

  const [showLineNumbers, setShowLineNumbers] = useState(true)
  const [liveTail, setLiveTail] = useState(true)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const scrollRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Auto-scroll on new content when live tail is on
  useEffect(() => {
    if (liveTail && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [lines, liveTail])

  // Focus search when opened
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus()
    }
  }, [searchOpen])

  // Keyboard shortcut for search
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setSearchOpen((v) => !v)
      }
      if (e.key === 'Escape' && searchOpen) {
        setSearchOpen(false)
        setSearchQuery('')
      }
    },
    [searchOpen]
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  function copyAll() {
    navigator.clipboard.writeText(lines.join('\n')).catch(() => {})
  }

  // Simple match highlighting — escape for use in regex
  const searchRe = searchQuery
    ? (() => {
        try {
          return new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
        } catch {
          return null
        }
      })()
    : null

  let matchCount = 0
  if (searchRe) {
    for (const line of lines) {
      const m = line.match(searchRe)
      if (m) matchCount += m.length
    }
  }

  function renderLine(line: string, idx: number): React.ReactElement {
    if (!searchRe || !searchQuery) {
      return (
        <div key={idx} className="flex gap-0">
          {showLineNumbers && (
            <span className="select-none text-right pr-4 text-[var(--text-muted)] w-10 shrink-0 tabular-nums">
              {idx + 1}
            </span>
          )}
          <span className="whitespace-pre-wrap break-all flex-1">{line}</span>
        </div>
      )
    }

    // Highlight search matches
    const parts = line.split(searchRe)
    return (
      <div key={idx} className="flex gap-0">
        {showLineNumbers && (
          <span className="select-none text-right pr-4 text-[var(--text-muted)] w-10 shrink-0 tabular-nums">
            {idx + 1}
          </span>
        )}
        <span className="whitespace-pre-wrap break-all flex-1">
          {parts.map((part, pi) =>
            searchRe.test(part) ? (
              <mark key={pi} className="bg-yellow-400/40 text-inherit rounded-sm">
                {part}
              </mark>
            ) : (
              <span key={pi}>{part}</span>
            )
          )}
        </span>
      </div>
    )
  }

  // Reset regex lastIndex after each use (global flag)
  if (searchRe) searchRe.lastIndex = 0

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--border)] shrink-0 text-xs">
        {/* Live tail */}
        <button
          onClick={() => setLiveTail((v) => !v)}
          className={`flex items-center gap-1.5 px-2 py-1 rounded ${
            liveTail ? 'bg-green-900/40 text-green-400' : 'hover:bg-white/5 text-[var(--text-muted)]'
          }`}
          title="Toggle live tail"
        >
          {liveTail && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          )}
          Live
        </button>

        {/* Line numbers toggle */}
        <button
          onClick={() => setShowLineNumbers((v) => !v)}
          className={`px-2 py-1 rounded ${
            showLineNumbers ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
          } hover:bg-white/5`}
          title="Toggle line numbers"
        >
          #
        </button>

        {/* Search toggle */}
        <button
          onClick={() => setSearchOpen((v) => !v)}
          className={`px-2 py-1 rounded hover:bg-white/5 ${searchOpen ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}
          title="Search (Ctrl+F)"
        >
          ⌕
        </button>

        {searchOpen && matchCount > 0 && (
          <span className="text-[var(--text-muted)]">{matchCount} match{matchCount !== 1 ? 'es' : ''}</span>
        )}

        {/* Copy all */}
        <button
          onClick={copyAll}
          className="px-2 py-1 rounded hover:bg-white/5 text-[var(--text-muted)] ml-auto"
          title="Copy all"
        >
          Copy all
        </button>
      </div>

      {/* Search bar */}
      {searchOpen && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-[var(--border)] shrink-0">
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search logs..."
            className="flex-1 bg-[var(--bg-surface)] border border-[var(--border)] rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-[var(--accent)]"
          />
          <button
            onClick={() => { setSearchOpen(false); setSearchQuery('') }}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-xs"
          >
            ✕
          </button>
        </div>
      )}

      {/* Log output */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto font-mono text-xs p-4 bg-[var(--bg-elevated)] leading-5 space-y-0"
      >
        {lines.length === 0 ? (
          <span className="text-[var(--text-muted)] italic">No logs available</span>
        ) : (
          lines.map((line, i) => renderLine(line, i))
        )}
      </div>
    </div>
  )
}
