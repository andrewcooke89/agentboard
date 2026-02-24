// CronScheduleEditor.tsx — Reusable schedule editor with live preview
// WU-015: Job Creation Modal
//
// Text input with live human-readable preview (REQ-44).
// Green/red validation indicator.
// Used in CronCreateModal (WU-015) and inline edit in CronJobControls (WU-014).

import React, { useMemo } from 'react'

interface CronScheduleEditorProps {
  value: string
  onChange: (value: string) => void
  mode: 'cron' | 'systemd'
}

// ── Cron validation & preview ─────────────────────────────────────────────────

const CRON_FIELD_RE = /^(\*|[0-9,\-*/]+)$/

function validateCronField(field: string, min: number, max: number): boolean {
  if (!CRON_FIELD_RE.test(field)) return false
  if (field === '*') return true
  // Check ranges and values
  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [range, step] = part.split('/')
      const stepN = parseInt(step, 10)
      if (isNaN(stepN) || stepN < 1) return false
      if (range !== '*') {
        const n = parseInt(range, 10)
        if (isNaN(n) || n < min || n > max) return false
      }
    } else if (part.includes('-')) {
      const [a, b] = part.split('-').map((x) => parseInt(x, 10))
      if (isNaN(a) || isNaN(b) || a < min || b > max || a > b) return false
    } else {
      const n = parseInt(part, 10)
      if (isNaN(n) || n < min || n > max) return false
    }
  }
  return true
}

function parseCronPreview(expr: string): { valid: boolean; preview: string } {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    return { valid: false, preview: 'Must have 5 fields: minute hour day month weekday' }
  }
  const [minute, hour, dom, month, dow] = parts
  if (
    !validateCronField(minute, 0, 59) ||
    !validateCronField(hour, 0, 23) ||
    !validateCronField(dom, 1, 31) ||
    !validateCronField(month, 1, 12) ||
    !validateCronField(dow, 0, 7)
  ) {
    return { valid: false, preview: 'Invalid cron expression' }
  }

  // Build human-readable description
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  let desc = 'Every'

  // Minute
  if (minute === '*') {
    desc += ' minute'
  } else if (minute.startsWith('*/')) {
    desc += ` ${minute.slice(2)} minutes`
  } else {
    desc += ` minute ${minute}`
  }

  // Hour
  if (hour !== '*') {
    if (hour.startsWith('*/')) {
      desc += ` every ${hour.slice(2)} hours`
    } else {
      const h = parseInt(hour, 10)
      const ampm = h < 12 ? 'AM' : 'PM'
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
      desc += ` at ${h12}:${minute === '*' ? '00' : minute.padStart(2, '0')} ${ampm}`
    }
  }

  // Day of month
  if (dom !== '*') {
    desc += ` on day ${dom}`
  }

  // Month
  if (month !== '*') {
    const mNum = parseInt(month, 10)
    desc += ` in ${!isNaN(mNum) && mNum >= 1 && mNum <= 12 ? MONTHS[mNum - 1] : month}`
  }

  // Day of week
  if (dow !== '*') {
    const dNum = parseInt(dow, 10)
    desc += ` on ${!isNaN(dNum) && dNum >= 0 && dNum <= 7 ? DAYS[dNum % 7] : dow}`
  }

  return { valid: true, preview: desc }
}

// ── Systemd validation & preview ──────────────────────────────────────────────

const SYSTEMD_SHORTCUTS: Record<string, string> = {
  hourly: 'Every hour at minute 0',
  daily: 'Every day at midnight',
  weekly: 'Every Monday at midnight',
  monthly: 'First day of every month at midnight',
  yearly: 'Every January 1st at midnight',
  annually: 'Every January 1st at midnight',
  quarterly: 'Every quarter (Jan, Apr, Jul, Oct 1st)',
  'semi-annually': 'Every 6 months',
}

function parseSystemdPreview(expr: string): { valid: boolean; preview: string } {
  const trimmed = expr.trim()
  if (!trimmed) {
    return { valid: false, preview: 'Schedule expression required' }
  }
  const lower = trimmed.toLowerCase()
  if (SYSTEMD_SHORTCUTS[lower]) {
    return { valid: true, preview: SYSTEMD_SHORTCUTS[lower] }
  }
  // Basic check: contains at least one colon or dash (typical systemd calendar format)
  if (trimmed.length > 0) {
    return { valid: true, preview: `Systemd calendar: ${trimmed}` }
  }
  return { valid: false, preview: 'Invalid systemd calendar expression' }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CronScheduleEditor({ value, onChange, mode }: CronScheduleEditorProps) {
  const { valid, preview } = useMemo(() => {
    if (!value.trim()) return { valid: null, preview: '' }
    return mode === 'cron' ? parseCronPreview(value) : parseSystemdPreview(value)
  }, [value, mode])

  const borderClass =
    valid === null
      ? 'border-zinc-600'
      : valid
        ? 'border-green-500'
        : 'border-red-500'

  const previewClass = valid ? 'text-green-400' : 'text-red-400'

  return (
    <div className="space-y-1">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={mode === 'cron' ? '*/5 * * * *' : '*-*-* *:00:00'}
        className={`w-full px-3 py-2 bg-zinc-900 border rounded text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500 ${borderClass}`}
        spellCheck={false}
      />
      {preview && (
        <p className={`text-xs ${previewClass}`}>{preview}</p>
      )}
      {!preview && (
        <p className="text-xs text-zinc-500">
          {mode === 'cron'
            ? 'Format: minute hour day month weekday (e.g. 0 3 * * *)'
            : 'Format: *-*-* *:00:00 or shortcuts like daily, hourly'}
        </p>
      )}
    </div>
  )
}
