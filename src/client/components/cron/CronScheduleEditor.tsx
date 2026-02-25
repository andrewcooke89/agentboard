// WU-012/015: Reusable schedule editor with live preview — CronScheduleEditor

import React, { useState, useMemo } from 'react'
import cronstrue from 'cronstrue'

// ─── CronScheduleEditor ───────────────────────────────────────────────────────
// Controlled component: caller owns the schedule string.
// Variant A (props: schedule / onSave / onCancel) — inline edit from CronJobControls.
// Variant B (props: value / onChange / mode / onValidityChange) — used by create modal.
// We unify both via optional props.

interface CronScheduleEditorInlineProps {
  schedule: string
  onSave: (newSchedule: string) => void
  onCancel: () => void
  // controlled mode (create modal) — if provided, skip save/cancel buttons
  value?: undefined
  onChange?: undefined
  mode?: undefined
  onValidityChange?: undefined
}

interface CronScheduleEditorControlledProps {
  value: string
  onChange: (value: string) => void
  mode: 'cron' | 'systemd'
  onValidityChange?: (isValid: boolean) => void
  // inline mode not used
  schedule?: undefined
  onSave?: undefined
  onCancel?: undefined
}

type CronScheduleEditorProps =
  | CronScheduleEditorInlineProps
  | CronScheduleEditorControlledProps

export function CronScheduleEditor(props: CronScheduleEditorProps): React.ReactElement {
  // Inline mode: manage local state; controlled mode: use props.value
  const isInline = props.schedule !== undefined
  const [localValue, setLocalValue] = useState(isInline ? props.schedule! : '')

  const currentValue = isInline ? localValue : (props.value ?? '')

  const preview = useMemo(() => {
    if (!currentValue.trim()) return { text: '', valid: false }
    try {
      const text = cronstrue.toString(currentValue)
      return { text, valid: true }
    } catch {
      return { text: 'Invalid expression', valid: false }
    }
  }, [currentValue])

  function handleChange(v: string) {
    if (isInline) {
      setLocalValue(v)
    } else {
      props.onChange?.(v)
      props.onValidityChange?.(preview.valid)
    }
  }

  const borderClass =
    currentValue.length === 0
      ? 'border-[var(--border)]'
      : preview.valid
        ? 'border-green-500'
        : 'border-red-500'

  return (
    <div className="flex flex-col gap-1">
      <input
        type="text"
        value={currentValue}
        onChange={(e) => handleChange(e.target.value)}
        className={`w-full bg-[var(--bg-primary)] border rounded px-2 py-1.5 text-sm font-mono focus:outline-none ${borderClass}`}
        placeholder={
          (!isInline && props.mode === 'systemd') ? 'daily' : '0 * * * *'
        }
        autoFocus
      />

      {currentValue.length > 0 && (
        <div className={`text-xs ${preview.valid ? 'text-green-400' : 'text-red-400'}`}>
          {preview.text}
        </div>
      )}

      {isInline && (
        <div className="flex gap-2 mt-1">
          <button
            onClick={() => preview.valid && props.onSave!(localValue)}
            disabled={!preview.valid}
            className="px-3 py-1 text-xs rounded bg-[var(--accent)] text-white disabled:opacity-40 hover:opacity-90"
          >
            Save
          </button>
          <button
            onClick={() => props.onCancel!()}
            className="px-3 py-1 text-xs rounded hover:bg-white/10"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

export default CronScheduleEditor
