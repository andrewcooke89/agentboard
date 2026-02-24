// CronCreateModal.tsx — Job creation modal with Quick (cron) and Advanced (systemd) tabs
// WU-015: Job Creation Modal
//
// Quick mode: command + schedule + optional comment/tags (REQ-51).
// Advanced mode: hidden if !systemdAvailable (REQ-97); serviceName + command +
// OnCalendar + description + workingDir + scope toggle + tags (REQ-52).
// Duplicate detection warns (not blocks) (REQ-53).
// Auto-select new job on success (REQ-53).

import React, { useState, useEffect, useCallback } from 'react'
import { useCronStore } from '../../stores/cronStore'
import { CronScheduleEditor } from './CronScheduleEditor'
import { CronTagInput } from './CronTagInput'
import type { ClientMessage } from '../../../shared/types'

interface CronCreateModalProps {
  isOpen: boolean
  onClose: () => void
  sendMessage: (msg: ClientMessage) => void
  systemdAvailable: boolean
}

const SERVICE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

// ── Form field ────────────────────────────────────────────────────────────────

function Field({
  label,
  required,
  error,
  children,
}: {
  label: string
  required?: boolean
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-zinc-300">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CronCreateModal({
  isOpen,
  onClose,
  sendMessage,
  systemdAvailable,
}: CronCreateModalProps) {
  const { getAllTags, jobs } = useCronStore()
  const [mode, setMode] = useState<'quick' | 'advanced'>('quick')

  // Quick mode state
  const [command, setCommand] = useState('')
  const [schedule, setSchedule] = useState('')
  const [comment, setComment] = useState('')
  const [tags, setTags] = useState<string[]>([])

  // Advanced mode state
  const [serviceName, setServiceName] = useState('')
  const [advCommand, setAdvCommand] = useState('')
  const [calendarSpec, setCalendarSpec] = useState('')
  const [description, setDescription] = useState('')
  const [workingDir, setWorkingDir] = useState('')
  const [scope, setScope] = useState<'user' | 'system'>('user')
  const [advTags, setAdvTags] = useState<string[]>([])

  // Validation errors
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)

  const allTags = getAllTags()

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      setCommand('')
      setSchedule('')
      setComment('')
      setTags([])
      setServiceName('')
      setAdvCommand('')
      setCalendarSpec('')
      setDescription('')
      setWorkingDir('')
      setScope('user')
      setAdvTags([])
      setErrors({})
      setSubmitting(false)
      setMode('quick')
    }
  }, [isOpen])

  // Escape key to close
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  const validate = useCallback((): boolean => {
    const errs: Record<string, string> = {}

    if (mode === 'quick') {
      if (!command.trim()) errs.command = 'Command is required'
      if (!schedule.trim()) errs.schedule = 'Schedule is required'
      const parts = schedule.trim().split(/\s+/)
      if (schedule.trim() && parts.length !== 5) {
        errs.schedule = 'Cron schedule must have 5 fields'
      }
    } else {
      if (!serviceName.trim()) errs.serviceName = 'Service name is required'
      else if (!SERVICE_NAME_RE.test(serviceName.trim())) {
        errs.serviceName =
          'Service name must start with alphanumeric and contain only letters, digits, _ or -'
      }
      if (!advCommand.trim()) errs.advCommand = 'Command is required'
      if (!calendarSpec.trim()) errs.calendarSpec = 'Schedule is required'
    }

    setErrors(errs)
    return Object.keys(errs).length === 0
  }, [mode, command, schedule, serviceName, advCommand, calendarSpec])

  const handleSubmit = useCallback(() => {
    if (!validate()) return
    setSubmitting(true)

    if (mode === 'quick') {
      sendMessage({
        type: 'cron-job-create',
        mode: 'cron',
        config: {
          command: command.trim(),
          schedule: schedule.trim(),
          comment: comment.trim() || undefined,
          tags: tags.length > 0 ? tags : undefined,
        },
      })
    } else {
      sendMessage({
        type: 'cron-job-create',
        mode: 'systemd',
        config: {
          serviceName: serviceName.trim(),
          command: advCommand.trim(),
          schedule: calendarSpec.trim(),
          description: description.trim() || undefined,
          workingDirectory: workingDir.trim() || undefined,
          scope,
          tags: advTags.length > 0 ? advTags : undefined,
        },
      })
    }

    // Close after a short delay (server will push job update)
    setTimeout(() => {
      setSubmitting(false)
      onClose()
    }, 500)
  }, [
    validate,
    mode,
    sendMessage,
    command,
    schedule,
    comment,
    tags,
    serviceName,
    advCommand,
    calendarSpec,
    description,
    workingDir,
    scope,
    advTags,
    onClose,
  ])

  // Duplicate detection (warn only)
  const duplicateWarning = (() => {
    if (mode === 'quick' && command.trim()) {
      const dup = jobs.find((j) => j.command === command.trim())
      if (dup) return `Similar command already exists: "${dup.name}"`
    }
    if (mode === 'advanced' && serviceName.trim()) {
      const dup = jobs.find((j) => j.name === serviceName.trim())
      if (dup) return `A job named "${serviceName.trim()}" already exists`
    }
    return null
  })()

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="bg-zinc-800 rounded-lg border border-zinc-600 w-full max-w-lg shadow-xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700 flex-shrink-0">
          <h2 className="text-base font-semibold text-zinc-200">Create Scheduled Job</h2>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-200 text-lg leading-none"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Mode tabs */}
        <div className="flex border-b border-zinc-700 flex-shrink-0">
          <button
            className={`px-4 py-2 text-sm transition-colors ${
              mode === 'quick'
                ? 'text-blue-400 border-b-2 border-blue-400 -mb-px'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
            onClick={() => setMode('quick')}
          >
            Quick (Cron)
          </button>
          {systemdAvailable && (
            <button
              className={`px-4 py-2 text-sm transition-colors ${
                mode === 'advanced'
                  ? 'text-blue-400 border-b-2 border-blue-400 -mb-px'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              onClick={() => setMode('advanced')}
            >
              Advanced (Systemd)
            </button>
          )}
        </div>

        {/* Form body */}
        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          {duplicateWarning && (
            <div className="px-3 py-2 bg-yellow-900/30 border border-yellow-600/40 rounded text-xs text-yellow-300">
              {duplicateWarning}
            </div>
          )}

          {mode === 'quick' ? (
            <>
              <Field label="Command" required error={errors.command}>
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="/path/to/script.sh"
                  className={`w-full px-3 py-2 bg-zinc-900 border rounded text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                    errors.command ? 'border-red-500' : 'border-zinc-600'
                  }`}
                  spellCheck={false}
                />
              </Field>

              <Field label="Schedule" required error={errors.schedule}>
                <CronScheduleEditor value={schedule} onChange={setSchedule} mode="cron" />
              </Field>

              <Field label="Comment">
                <input
                  type="text"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Optional description"
                  className="w-full px-3 py-2 bg-zinc-900 border border-zinc-600 rounded text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </Field>

              <Field label="Tags">
                <div className="px-2 py-1.5 bg-zinc-900 border border-zinc-600 rounded min-h-[36px]">
                  <CronTagInput tags={tags} onChange={setTags} allTags={allTags} />
                </div>
              </Field>
            </>
          ) : (
            <>
              <Field label="Service Name" required error={errors.serviceName}>
                <input
                  type="text"
                  value={serviceName}
                  onChange={(e) => setServiceName(e.target.value)}
                  placeholder="my-backup-job"
                  className={`w-full px-3 py-2 bg-zinc-900 border rounded text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                    errors.serviceName ? 'border-red-500' : 'border-zinc-600'
                  }`}
                  spellCheck={false}
                />
                <p className="text-xs text-zinc-500 mt-0.5">
                  Alphanumeric, underscores, hyphens. First char must be alphanumeric.
                </p>
              </Field>

              <Field label="Command" required error={errors.advCommand}>
                <input
                  type="text"
                  value={advCommand}
                  onChange={(e) => setAdvCommand(e.target.value)}
                  placeholder="/usr/bin/backup.sh"
                  className={`w-full px-3 py-2 bg-zinc-900 border rounded text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                    errors.advCommand ? 'border-red-500' : 'border-zinc-600'
                  }`}
                  spellCheck={false}
                />
              </Field>

              <Field label="Schedule (OnCalendar)" required error={errors.calendarSpec}>
                <CronScheduleEditor
                  value={calendarSpec}
                  onChange={setCalendarSpec}
                  mode="systemd"
                />
              </Field>

              <Field label="Description">
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this job does"
                  className="w-full px-3 py-2 bg-zinc-900 border border-zinc-600 rounded text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </Field>

              <Field label="Working Directory">
                <input
                  type="text"
                  value={workingDir}
                  onChange={(e) => setWorkingDir(e.target.value)}
                  placeholder="/home/user/project"
                  className="w-full px-3 py-2 bg-zinc-900 border border-zinc-600 rounded text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  spellCheck={false}
                />
              </Field>

              <Field label="Scope">
                <div className="flex gap-2">
                  {(['user', 'system'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setScope(s)}
                      className={`px-3 py-1.5 text-sm rounded transition-colors ${
                        scope === s
                          ? 'bg-blue-600 text-white'
                          : 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                      }`}
                    >
                      {s === 'user' ? 'User' : 'System (requires sudo)'}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label="Tags">
                <div className="px-2 py-1.5 bg-zinc-900 border border-zinc-600 rounded min-h-[36px]">
                  <CronTagInput tags={advTags} onChange={setAdvTags} allTags={allTags} />
                </div>
              </Field>
            </>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-zinc-700 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-white transition-colors"
          >
            {submitting ? 'Creating...' : 'Create Job'}
          </button>
        </div>
      </div>
    </div>
  )
}
