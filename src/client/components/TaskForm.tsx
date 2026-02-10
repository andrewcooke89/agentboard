// TaskForm.tsx - Task submission form with template selection
import { useState, useEffect } from 'react'
import type { TaskTemplate, SendClientMessage } from '@shared/types'
import { ProjectPathPicker } from './ProjectPathPicker'
import { AgentTypePicker } from './AgentTypePicker'

const TIMEOUT_OPTIONS = [
  { label: '5 min', value: 300 },
  { label: '15 min', value: 900 },
  { label: '30 min', value: 1800 },
  { label: '1 hour', value: 3600 },
  { label: '2 hours', value: 7200 },
]

interface TemplateVariable {
  name: string
  description?: string
  defaultValue?: string
}

interface TaskFormProps {
  templates: TaskTemplate[]
  defaultProjectPath: string
  sendMessage: SendClientMessage
  onClose: () => void
}

export default function TaskForm({ templates, defaultProjectPath, sendMessage, onClose }: TaskFormProps) {
  const [projectPath, setProjectPath] = useState(defaultProjectPath)
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('')
  const [prompt, setPrompt] = useState('')
  const [priority, setPriority] = useState(5)
  const [timeoutSeconds, setTimeoutSeconds] = useState(1800)
  const [maxRetries, setMaxRetries] = useState(0)
  const [followUpPrompt, setFollowUpPrompt] = useState('')
  const [showFollowUp, setShowFollowUp] = useState(false)
  const [metadata, setMetadata] = useState('')
  const [variables, setVariables] = useState<Record<string, string>>({})
  const [agentType, setAgentType] = useState<'claude' | 'codex' | undefined>(undefined)
  const [templateVars, setTemplateVars] = useState<TemplateVariable[]>([])

  // When template changes, update prompt and parse variables
  useEffect(() => {
    if (!selectedTemplateId) {
      setTemplateVars([])
      return
    }

    const template = templates.find((t) => t.id === selectedTemplateId)
    if (!template) return

    setPrompt(template.promptTemplate)
    setPriority(template.priority)
    setTimeoutSeconds(template.timeoutSeconds)
    if (template.projectPath) setProjectPath(template.projectPath)

    try {
      const vars = JSON.parse(template.variables) as TemplateVariable[]
      setTemplateVars(Array.isArray(vars) ? vars : [])
      const defaults: Record<string, string> = {}
      for (const v of vars) {
        if (v.defaultValue) defaults[v.name] = v.defaultValue
      }
      setVariables(defaults)
    } catch {
      setTemplateVars([])
    }
  }, [selectedTemplateId, templates])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!projectPath.trim() || !prompt.trim()) return

    // Validate variable values (trim whitespace, enforce length limits)
    const cleanedVars: Record<string, string> = {}
    for (const [key, value] of Object.entries(variables)) {
      const trimmed = value.trim()
      if (trimmed.length > 4096) return // Silently reject overlong values
      if (trimmed) cleanedVars[key] = trimmed
    }

    // Build metadata with agentType if set
    let metadataStr = metadata.trim() || undefined
    if (agentType) {
      const metaObj = metadataStr ? { tags: metadataStr, agent_type: agentType } : { agent_type: agentType }
      metadataStr = JSON.stringify(metaObj)
    }

    sendMessage({
      type: 'task-create',
      projectPath: projectPath.trim(),
      prompt: prompt.trim(),
      templateId: selectedTemplateId || undefined,
      variables: Object.keys(cleanedVars).length > 0 ? cleanedVars : undefined,
      priority,
      timeoutSeconds,
      maxRetries,
      followUpPrompt: followUpPrompt.trim() || undefined,
      metadata: metadataStr,
    })
    onClose()
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 p-4">
      <h3 className="text-sm font-medium text-white/80">New Task</h3>

      {/* Template selector */}
      {templates.length > 0 && (
        <div>
          <label className="text-xs text-white/50 block mb-1">Template</label>
          <select
            value={selectedTemplateId}
            onChange={(e) => setSelectedTemplateId(e.target.value)}
            className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white/80 focus:outline-none focus:border-white/30"
          >
            <option value="">No template</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Template variables */}
      {templateVars.map((v) => (
        <div key={v.name}>
          <label className="text-xs text-white/50 block mb-1">
            {v.name}{v.description ? ` - ${v.description}` : ''}
          </label>
          <input
            type="text"
            value={variables[v.name] || ''}
            onChange={(e) => setVariables({ ...variables, [v.name]: e.target.value.slice(0, 4096) })}
            maxLength={4096}
            placeholder={v.defaultValue}
            className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white/80 focus:outline-none focus:border-white/30"
          />
        </div>
      ))}

      {/* Project path */}
      <ProjectPathPicker
        value={projectPath}
        onChange={setProjectPath}
        label="Project Path"
      />

      {/* Agent type */}
      <AgentTypePicker
        value={agentType}
        onChange={setAgentType}
        label="Agent Type"
        allowNone
      />

      {/* Prompt */}
      <div>
        <label className="text-xs text-white/50 block mb-1">Prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={6}
          className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white/80 focus:outline-none focus:border-white/30 resize-y"
          placeholder="Enter the task prompt..."
          required
        />
      </div>

      {/* Priority + Timeout + Retries row */}
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="text-xs text-white/50 block mb-1">Priority</label>
          <select
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
            className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white/80 focus:outline-none focus:border-white/30"
          >
            {Array.from({ length: 10 }, (_, i) => i + 1).map((p) => (
              <option key={p} value={p}>{p}{p === 1 ? ' (highest)' : p === 10 ? ' (lowest)' : ''}</option>
            ))}
          </select>
        </div>

        <div className="flex-1">
          <label className="text-xs text-white/50 block mb-1">Timeout</label>
          <select
            value={timeoutSeconds}
            onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
            className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white/80 focus:outline-none focus:border-white/30"
          >
            {TIMEOUT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div className="flex-1">
          <label className="text-xs text-white/50 block mb-1">Retries</label>
          <select
            value={maxRetries}
            onChange={(e) => setMaxRetries(Number(e.target.value))}
            className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white/80 focus:outline-none focus:border-white/30"
          >
            {[0, 1, 2, 3].map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Follow-up prompt (collapsible) */}
      <div>
        {!showFollowUp ? (
          <button
            type="button"
            onClick={() => setShowFollowUp(true)}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            + Add follow-up prompt
          </button>
        ) : (
          <div>
            <label className="text-xs text-white/50 block mb-1">Follow-up Prompt</label>
            <textarea
              value={followUpPrompt}
              onChange={(e) => setFollowUpPrompt(e.target.value)}
              rows={3}
              className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white/80 focus:outline-none focus:border-white/30 resize-y"
              placeholder="Auto-queued when this task completes..."
            />
          </div>
        )}
      </div>

      {/* Metadata / Tags */}
      <div>
        <label className="text-xs text-white/50 block mb-1">Metadata / Tags (optional)</label>
        <input
          type="text"
          value={metadata}
          onChange={(e) => setMetadata(e.target.value)}
          className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white/80 focus:outline-none focus:border-white/30"
          placeholder="e.g. deploy, hotfix, nightly"
        />
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-2 mt-1">
        <button
          type="button"
          onClick={onClose}
          className="text-xs px-3 py-1.5 rounded bg-white/5 text-white/60 hover:bg-white/10 transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors"
        >
          Queue Task
        </button>
      </div>
    </form>
  )
}
