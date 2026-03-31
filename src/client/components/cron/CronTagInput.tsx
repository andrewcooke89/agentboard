// WU-011: Detail Pane Shell — CronTagInput

import { useState, useRef, useEffect } from 'react'
import { useCronStore } from '../../stores/cronStore'

// ─── CronTagInput ─────────────────────────────────────────────────────────────
// Tag input with autocomplete dropdown.
// "+" button to open input. Autocomplete from cronStore.allTags().
// Free-text entry allowed for new tags.
// Tag pills: colored (deterministic color from tag name hash), removable via "×".
// Tag mutations sent via cron-job-set-tags WS message through the store.

// Deterministic color from tag name hash
function tagColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 50%, 35%)`
}

interface CronTagInputProps {
  jobId: string
  tags: string[]
}

export function CronTagInput({ jobId, tags }: CronTagInputProps) {
  const allTags = useCronStore((s) => s.allTags)()
  const [editing, setEditing] = useState(false)
  const [input, setInput] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus()
  }, [editing])

  useEffect(() => {
    if (input) {
      const filtered = allTags.filter(
        (t) => t.toLowerCase().includes(input.toLowerCase()) && !tags.includes(t)
      )
      setSuggestions(filtered.slice(0, 5))
    } else {
      setSuggestions([])
    }
  }, [input, allTags, tags])

  const sendTagUpdate = (newTags: string[]) => {
    // Dispatch via the global WS send — accessed through the window object
    // populated by the WS layer in App.tsx / CronManager.tsx
    const ws = (window as unknown as { __cronWsSend?: (msg: unknown) => void }).__cronWsSend
    if (ws) {
      ws({ type: 'cron-job-set-tags', jobId, tags: newTags })
    }
  }

  const addTag = (tag: string) => {
    const trimmed = tag.trim()
    if (trimmed && !tags.includes(trimmed)) {
      sendTagUpdate([...tags, trimmed])
    }
    setInput('')
    setSuggestions([])
    setEditing(false)
  }

  const removeTag = (tag: string) => {
    sendTagUpdate(tags.filter((t) => t !== tag))
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setEditing(false)
      setInput('')
    } else if (e.key === 'Enter' && input.trim()) {
      addTag(input)
      e.preventDefault()
    }
  }

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-xs text-white"
          style={{ backgroundColor: tagColor(tag) }}
        >
          {tag}
          <button
            onClick={() => removeTag(tag)}
            className="ml-0.5 hover:text-red-300"
            aria-label={`Remove tag ${tag}`}
          >
            &times;
          </button>
        </span>
      ))}
      {editing ? (
        <div className="relative">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              if (!input) setEditing(false)
            }}
            placeholder="Add tag..."
            className="w-24 px-1.5 py-0.5 text-xs bg-[var(--bg-surface)] border border-[var(--border)] rounded text-[var(--text-primary)]"
          />
          {suggestions.length > 0 && (
            <div className="absolute z-10 top-full left-0 mt-1 w-32 bg-[var(--bg-elevated)] border border-[var(--border)] rounded shadow-lg">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onMouseDown={(e) => {
                    e.preventDefault() // prevent input blur before click fires
                    addTag(s)
                  }}
                  className="w-full text-left px-2 py-1 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-surface)]"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <button
          onClick={() => setEditing(true)}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] px-1"
        >
          + tag
        </button>
      )}
    </div>
  )
}

export default CronTagInput
