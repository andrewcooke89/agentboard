// WU-013: History & Logs Tabs — CronLogsTab

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useCronStore } from '../../stores/cronStore'

// ─── LogLine ─────────────────────────────────────────────────────────────────

function LogLine({ line, idx, showLineNumbers, searchRe, searchQuery }: {
  line: string; idx: number; showLineNumbers: boolean;
  searchRe: RegExp | null; searchQuery: string;
}): React.ReactElement {
  if (!searchRe || !searchQuery) {
    return (
      <div className="flex gap-0">
        {showLineNumbers && (
          <span className="select-none text-right pr-4 text-[var(--text-muted)] w-10 shrink-0 tabular-nums">
            {idx + 1}
          </span>
        )}
        <span className="whitespace-pre-wrap break-all flex-1">{line}</span>
      </div>
    )
  }

  // Reset lastIndex before use (global flag)
  searchRe.lastIndex = 0

  // Highlight search matches
  const parts = line.split(searchRe)
  return (
    <div className="flex gap-0">
      {showLineNumbers && (
        <span className="select-none text-right pr-4 text-[var(--text-muted)] w-10 shrink-0 tabular-nums">
          {idx + 1}
        </span>
      )}
      <span className="whitespace-pre-wrap break-all flex-1">
        {parts.map((part, pi) => {
          searchRe.lastIndex = 0
          return searchRe.test(part) ? (
            <mark key={pi} className="bg-yellow-400/40 text-inherit rounded-sm">
              {part}
            </mark>
          ) : (
            <span key={pi}>{part}</span>
          )
        })}
      </span>
    </div>
  )
}

// ─── LogToolbar ──────────────────────────────────────────────────────────────

function LogToolbar({ liveTail, setLiveTail, showLineNumbers, setShowLineNumbers,
  searchOpen, setSearchOpen, matchCount, copyAll }: {
  liveTail: boolean; setLiveTail: (fn: (v: boolean) => boolean) => void;
  showLineNumbers: boolean; setShowLineNumbers: (fn: (v: boolean) => boolean) => void;
  searchOpen: boolean; setSearchOpen: (fn: (v: boolean) => boolean) => void;
  matchCount: number; copyAll: () => void;
}): React.ReactElement {
  return (
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
  )
}

// ─── LogSearchBar ────────────────────────────────────────────────────────────

function LogSearchBar({ searchInputRef, searchQuery, setSearchQuery,
  setSearchOpen }: {
  searchInputRef: React.RefObject<HTMLInputElement>;
  searchQuery: string; setSearchQuery: (v: string) => void;
  setSearchOpen: (fn: (v: boolean) => boolean) => void;
}): React.ReactElement {
  return (
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
  )
}

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
        setSearchOpen(() => false)
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
      searchRe.lastIndex = 0
      const m = line.match(searchRe)
      if (m) matchCount += m.length
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <LogToolbar
        liveTail={liveTail}
        setLiveTail={setLiveTail}
        showLineNumbers={showLineNumbers}
        setShowLineNumbers={setShowLineNumbers}
        searchOpen={searchOpen}
        setSearchOpen={setSearchOpen}
        matchCount={matchCount}
        copyAll={copyAll}
      />

      {searchOpen && (
        <LogSearchBar
          searchInputRef={searchInputRef}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          setSearchOpen={setSearchOpen}
        />
      )}

      {/* Log output */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto font-mono text-xs p-4 bg-[var(--bg-elevated)] leading-5 space-y-0"
      >
        {lines.length === 0 ? (
          <span className="text-[var(--text-muted)] italic">No logs available</span>
        ) : (
          lines.map((line, i) => (
            <LogLine
              key={i}
              line={line}
              idx={i}
              showLineNumbers={showLineNumbers}
              searchRe={searchRe}
              searchQuery={searchQuery}
            />
          ))
        )}
      </div>
    </div>
  )
}
