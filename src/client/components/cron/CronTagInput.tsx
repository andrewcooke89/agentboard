// CronTagInput.tsx — Tag input with autocomplete and auto-suggestions
// WU-017: Tags & Avatars
//
// Autocomplete dropdown from allTags prop (REQ-65).
// Free-text entry for new tags.
// Tag pill rendering with deterministic color from name hash (REQ-64).
// Backspace on empty input removes last tag.

import React, { useState, useRef, useCallback } from 'react'

interface CronTagInputProps {
  tags: string[]
  onChange: (tags: string[]) => void
  allTags: string[]
}

// ── Color palette ─────────────────────────────────────────────────────────────

const TAG_PALETTE = [
  'bg-blue-600',
  'bg-green-600',
  'bg-yellow-600',
  'bg-orange-600',
  'bg-purple-600',
  'bg-pink-600',
  'bg-teal-600',
  'bg-indigo-600',
  'bg-red-600',
  'bg-cyan-600',
]

function tagColorClass(name: string): string {
  let sum = 0
  for (let i = 0; i < name.length; i++) {
    sum += name.charCodeAt(i)
  }
  return TAG_PALETTE[sum % TAG_PALETTE.length]
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CronTagInput({ tags, onChange, allTags }: CronTagInputProps) {
  const [input, setInput] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const [isAdding, setIsAdding] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const suggestions = allTags.filter(
    (t) => t.toLowerCase().includes(input.toLowerCase()) && !tags.includes(t),
  )

  const addTag = useCallback(
    (tag: string) => {
      const trimmed = tag.trim()
      if (trimmed && !tags.includes(trimmed)) {
        onChange([...tags, trimmed])
      }
      setInput('')
      setShowDropdown(false)
      setIsAdding(false)
    },
    [tags, onChange],
  )

  const removeTag = useCallback(
    (tag: string) => {
      onChange(tags.filter((t) => t !== tag))
    },
    [tags, onChange],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (input.trim()) {
          addTag(input)
        } else if (suggestions.length > 0) {
          addTag(suggestions[0])
        }
      } else if (e.key === 'Backspace' && !input && tags.length > 0) {
        removeTag(tags[tags.length - 1])
      } else if (e.key === 'Escape') {
        setInput('')
        setShowDropdown(false)
        setIsAdding(false)
      }
    },
    [input, tags, suggestions, addTag, removeTag],
  )

  const handleBlur = useCallback(() => {
    // Delay so click on dropdown item registers first
    setTimeout(() => {
      setShowDropdown(false)
      if (!input.trim()) {
        setIsAdding(false)
      }
    }, 150)
  }, [input])

  return (
    <div className="flex flex-wrap items-center gap-1 min-h-[28px]">
      {tags.map((tag) => (
        <span
          key={tag}
          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs text-white ${tagColorClass(tag)}`}
        >
          {tag}
          <button
            type="button"
            onClick={() => removeTag(tag)}
            className="hover:text-zinc-200 leading-none ml-0.5"
            aria-label={`Remove tag ${tag}`}
          >
            &times;
          </button>
        </span>
      ))}

      {isAdding ? (
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              setShowDropdown(true)
            }}
            onFocus={() => setShowDropdown(true)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            placeholder="Type a tag..."
            className="bg-zinc-900 border border-zinc-600 rounded px-2 py-0.5 text-xs text-zinc-200 outline-none focus:border-blue-500 min-w-[100px]"
            autoFocus
          />

          {showDropdown && suggestions.length > 0 && (
            <div className="absolute top-full left-0 mt-1 z-50 bg-zinc-800 border border-zinc-600 rounded shadow-lg min-w-[140px] max-h-40 overflow-y-auto">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    addTag(suggestion)
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 flex items-center gap-2"
                >
                  <span
                    className={`w-2 h-2 rounded-full inline-block ${tagColorClass(suggestion)}`}
                  />
                  {suggestion}
                </button>
              ))}
              {input.trim() && !allTags.includes(input.trim()) && (
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    addTag(input)
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs text-blue-400 hover:bg-zinc-700 border-t border-zinc-700"
                >
                  Create "{input.trim()}"
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setIsAdding(true)
            setShowDropdown(true)
          }}
          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-zinc-700 hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 text-xs leading-none"
          aria-label="Add tag"
        >
          +
        </button>
      )}
    </div>
  )
}
