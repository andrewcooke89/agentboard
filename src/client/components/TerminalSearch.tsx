import { useState, useEffect, useRef, useCallback } from 'react'
import type { SearchAddon } from '@xterm/addon-search'
import { XCloseIcon } from '@untitledui-icons/react/line'
import ChevronUpIcon from '@untitledui-icons/react/line/esm/ChevronUpIcon'
import ChevronDownIcon from '@untitledui-icons/react/line/esm/ChevronDownIcon'

interface TerminalSearchProps {
  searchAddon: SearchAddon | null
  onClose: () => void
}

export default function TerminalSearch({ searchAddon, onClose }: TerminalSearchProps) {
  const [query, setQuery] = useState('')
  const [matchCount, setMatchCount] = useState<{ current: number; total: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Handle Escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Clear decorations on unmount
  useEffect(() => {
    return () => {
      if (searchAddon) {
        searchAddon.clearDecorations()
      }
    }
  }, [searchAddon])

  const performSearch = useCallback((searchQuery: string, direction: 'next' | 'previous' = 'next') => {
    if (!searchAddon || !searchQuery.trim()) {
      setMatchCount(null)
      if (searchAddon) {
        searchAddon.clearDecorations()
      }
      return
    }

    const decorations = {
      matchOverviewRuler: '#3b82f6',
      activeMatchColorOverviewRuler: '#f59e0b'
    }

    const found = direction === 'next'
      ? searchAddon.findNext(searchQuery, { decorations })
      : searchAddon.findPrevious(searchQuery, { decorations })

    // Note: xterm.js SearchAddon doesn't provide match count API
    // We show a simple indicator if matches were found
    if (found) {
      setMatchCount({ current: 1, total: 1 }) // Simplified: just show "found"
    } else {
      setMatchCount({ current: 0, total: 0 })
    }
  }, [searchAddon])

  const handleQueryChange = (value: string) => {
    setQuery(value)

    // Debounce search to avoid excessive calls while typing
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current)
    }

    if (value.trim()) {
      searchTimeoutRef.current = setTimeout(() => {
        performSearch(value, 'next')
      }, 200)
    } else {
      setMatchCount(null)
      if (searchAddon) {
        searchAddon.clearDecorations()
      }
    }
  }

  const handleNext = () => {
    if (query.trim()) {
      performSearch(query, 'next')
    }
  }

  const handlePrevious = () => {
    if (query.trim()) {
      performSearch(query, 'previous')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.shiftKey) {
        handlePrevious()
      } else {
        handleNext()
      }
    }
  }

  return (
    <div className="absolute top-2 right-2 z-30 flex items-center gap-2 rounded border border-border bg-elevated px-3 py-2 shadow-lg">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => handleQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search terminal..."
        className="w-48 bg-surface border border-border rounded px-2 py-1 text-sm text-primary placeholder-muted outline-none focus:border-accent"
      />

      {matchCount !== null && (
        <span className="text-xs text-secondary whitespace-nowrap">
          {matchCount.total === 0 ? 'No matches' : 'Found'}
        </span>
      )}

      <div className="flex items-center gap-1">
        <button
          onClick={handlePrevious}
          disabled={!query.trim()}
          className="flex h-6 w-6 items-center justify-center rounded bg-surface border border-border text-secondary hover:bg-hover hover:text-primary active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          title="Previous match (Shift+Enter)"
          aria-label="Previous match"
        >
          <ChevronUpIcon width={14} height={14} />
        </button>

        <button
          onClick={handleNext}
          disabled={!query.trim()}
          className="flex h-6 w-6 items-center justify-center rounded bg-surface border border-border text-secondary hover:bg-hover hover:text-primary active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          title="Next match (Enter)"
          aria-label="Next match"
        >
          <ChevronDownIcon width={14} height={14} />
        </button>
      </div>

      <button
        onClick={onClose}
        className="flex h-6 w-6 items-center justify-center rounded bg-surface border border-border text-secondary hover:bg-hover hover:text-primary active:scale-95 transition-all"
        title="Close (Esc)"
        aria-label="Close search"
      >
        <XCloseIcon width={14} height={14} />
      </button>
    </div>
  )
}
