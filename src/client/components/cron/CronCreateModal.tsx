// WU-015: Create, Delete & Sudo Modals — CronCreateModal

import { useState } from 'react'
import { useCronStore } from '../../stores/cronStore'
import type { CronCreateConfig, SystemdCreateConfig } from '@shared/types'

// ─── Module-level CSS class constants ─────────────────────────────────────────

const inputCls =
  'w-full mt-1 px-2 py-1.5 text-sm bg-[var(--bg-surface)] border border-[var(--border)] rounded text-[var(--text-primary)]'
const labelCls = 'block'
const labelTextCls = 'text-xs text-[var(--text-muted)]'

// ─── CronFormFields ───────────────────────────────────────────────────────────

interface CronFormFieldsProps {
  command: string
  setCommand: (v: string) => void
  schedule: string
  setSchedule: (v: string) => void
  comment: string
  setComment: (v: string) => void
  tags: string
  setTags: (v: string) => void
  setError: (e: string | null) => void
}

function CronFormFields({
  command, setCommand, schedule, setSchedule,
  comment, setComment, tags, setTags, setError,
}: CronFormFieldsProps) {
  return (
    <>
      <label className={labelCls}>
        <span className={labelTextCls}>Command</span>
        <input
          value={command}
          onChange={(e) => { setCommand(e.target.value); setError(null) }}
          className={inputCls}
          placeholder="/usr/bin/my-script.sh"
        />
      </label>

      <label className={labelCls}>
        <span className={labelTextCls}>Schedule (cron expression)</span>
        <input
          value={schedule}
          onChange={(e) => { setSchedule(e.target.value); setError(null) }}
          className={`${inputCls} font-mono`}
          placeholder="*/5 * * * *"
        />
      </label>

      <label className={labelCls}>
        <span className={labelTextCls}>Comment (optional)</span>
        <input
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          className={inputCls}
        />
      </label>

      <label className={labelCls}>
        <span className={labelTextCls}>Tags (comma-separated)</span>
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          className={inputCls}
          placeholder="backup, daily"
        />
      </label>
    </>
  )
}

// ─── SystemdFormFields ────────────────────────────────────────────────────────

interface SystemdFormFieldsProps {
  serviceName: string
  setServiceName: (v: string) => void
  command: string
  setCommand: (v: string) => void
  schedule: string
  setSchedule: (v: string) => void
  description: string
  setDescription: (v: string) => void
  workingDir: string
  setWorkingDir: (v: string) => void
  scope: 'user' | 'system'
  setScope: (v: 'user' | 'system') => void
  tags: string
  setTags: (v: string) => void
  setError: (e: string | null) => void
}

function SystemdFormFields({
  serviceName, setServiceName, command, setCommand,
  schedule, setSchedule, description, setDescription,
  workingDir, setWorkingDir, scope, setScope,
  tags, setTags, setError,
}: SystemdFormFieldsProps) {
  return (
    <>
      <label className={labelCls}>
        <span className={labelTextCls}>Service Name</span>
        <input
          value={serviceName}
          onChange={(e) => { setServiceName(e.target.value); setError(null) }}
          className={inputCls}
          placeholder="my-timer"
        />
      </label>

      <label className={labelCls}>
        <span className={labelTextCls}>Command</span>
        <input
          value={command}
          onChange={(e) => { setCommand(e.target.value); setError(null) }}
          className={inputCls}
          placeholder="/usr/bin/my-script.sh"
        />
      </label>

      <label className={labelCls}>
        <span className={labelTextCls}>Schedule (OnCalendar)</span>
        <input
          value={schedule}
          onChange={(e) => { setSchedule(e.target.value); setError(null) }}
          className={`${inputCls} font-mono`}
          placeholder="*-*-* 00:00:00"
        />
      </label>

      <label className={labelCls}>
        <span className={labelTextCls}>Description</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={inputCls}
        />
      </label>

      <label className={labelCls}>
        <span className={labelTextCls}>Working Directory</span>
        <input
          value={workingDir}
          onChange={(e) => setWorkingDir(e.target.value)}
          className={inputCls}
          placeholder="/home/user"
        />
      </label>

      <label className={labelCls}>
        <span className={labelTextCls}>Scope</span>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as 'user' | 'system')}
          className={inputCls}
        >
          <option value="user">User</option>
          <option value="system">System</option>
        </select>
      </label>

      <label className={labelCls}>
        <span className={labelTextCls}>Tags (comma-separated)</span>
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          className={inputCls}
          placeholder="backup, daily"
        />
      </label>
    </>
  )
}

// ─── CronCreateModal ──────────────────────────────────────────────────────────
// Modal with Quick (cron) and Advanced (systemd) tabs.
// Advanced tab hidden if !systemdAvailable (from cronStore).
// Validates required fields and service name format before submit.
// On success: calls onCreate and closes.

interface CronCreateModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (mode: 'cron' | 'systemd', config: CronCreateConfig | SystemdCreateConfig) => void
}

export function CronCreateModal({ isOpen, onClose, onCreate }: CronCreateModalProps) {
  const systemdAvailable = useCronStore((s) => s.systemdAvailable)
  const [mode, setMode] = useState<'cron' | 'systemd'>('cron')
  const [command, setCommand] = useState('')
  const [schedule, setSchedule] = useState('')
  const [comment, setComment] = useState('')
  const [tags, setTags] = useState('')
  const [serviceName, setServiceName] = useState('')
  const [description, setDescription] = useState('')
  const [workingDir, setWorkingDir] = useState('')
  const [scope, setScope] = useState<'user' | 'system'>('user')
  const [error, setError] = useState<string | null>(null)

  if (!isOpen) return null

  const validateCommand = (cmd: string): string | null => {
    if (!cmd.trim()) return 'Command is required'
    if (cmd.includes('\n') || cmd.includes('\r') || cmd.includes('\0'))
      return 'Command contains invalid characters'
    return null
  }

  const parseTags = (raw: string): string[] =>
    raw.split(',').map((t) => t.trim()).filter(Boolean)

  const handleSubmit = () => {
    const cmdErr = validateCommand(command)
    if (cmdErr) { setError(cmdErr); return }
    if (!schedule.trim()) { setError('Schedule is required'); return }

    if (mode === 'cron') {
      onCreate('cron', { command, schedule, comment, tags: parseTags(tags) })
    } else {
      if (!serviceName.trim()) { setError('Service name is required'); return }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(serviceName)) {
        setError('Invalid service name — use letters, digits, hyphens, underscores only')
        return
      }
      onCreate('systemd', {
        serviceName, command, schedule, description,
        workingDirectory: workingDir, scope, tags: parseTags(tags),
      })
    }
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg shadow-xl w-[480px] max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--border)]">
          <h3 className="text-lg font-semibold text-[var(--text-primary)]">Create Job</h3>
          <button
            onClick={onClose}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-xl leading-none"
          >
            &times;
          </button>
        </div>

        {/* Mode tabs */}
        <div className="flex border-b border-[var(--border)]">
          <button
            onClick={() => { setMode('cron'); setError(null) }}
            className={`flex-1 py-2 text-sm ${
              mode === 'cron'
                ? 'text-[var(--text-primary)] border-b-2 border-blue-500'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}
          >
            Quick (Cron)
          </button>
          {systemdAvailable && (
            <button
              onClick={() => { setMode('systemd'); setError(null) }}
              className={`flex-1 py-2 text-sm ${
                mode === 'systemd'
                  ? 'text-[var(--text-primary)] border-b-2 border-blue-500'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              Advanced (Systemd)
            </button>
          )}
        </div>

        {/* Form */}
        <div className="p-4 space-y-3">
          {error && (
            <div className="text-sm text-red-500 p-2 bg-red-500/10 rounded">{error}</div>
          )}

          {mode === 'cron' ? (
            <CronFormFields
              command={command} setCommand={setCommand}
              schedule={schedule} setSchedule={setSchedule}
              comment={comment} setComment={setComment}
              tags={tags} setTags={setTags}
              setError={setError}
            />
          ) : (
            <SystemdFormFields
              serviceName={serviceName} setServiceName={setServiceName}
              command={command} setCommand={setCommand}
              schedule={schedule} setSchedule={setSchedule}
              description={description} setDescription={setDescription}
              workingDir={workingDir} setWorkingDir={setWorkingDir}
              scope={scope} setScope={setScope}
              tags={tags} setTags={setTags}
              setError={setError}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-4 border-t border-[var(--border)]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  )
}

export default CronCreateModal
