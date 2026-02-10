// TemplateManager.tsx - Template CRUD UI
import { useState } from 'react'
import { useTaskStore } from '../stores/taskStore'
import { authFetch } from '../utils/api'
import { toastManager } from './Toast'

interface TemplateManagerProps {
  onClose: () => void
}

export default function TemplateManager({ onClose }: TemplateManagerProps) {
  const templates = useTaskStore((s) => s.templates)
  const setTemplates = useTaskStore((s) => s.setTemplates)
  const [editing, setEditing] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  // Add form state
  const [name, setName] = useState('')
  const [promptTemplate, setPromptTemplate] = useState('')
  const [variablesJson, setVariablesJson] = useState('[]')
  const [projectPath, setProjectPath] = useState('')
  const [priority, setPriority] = useState(5)
  const [timeoutSeconds, setTimeoutSeconds] = useState(1800)

  function resetForm() {
    setName('')
    setPromptTemplate('')
    setVariablesJson('[]')
    setProjectPath('')
    setPriority(5)
    setTimeoutSeconds(1800)
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !promptTemplate.trim()) return

    try {
      const res = await authFetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          promptTemplate: promptTemplate.trim(),
          variables: variablesJson,
          projectPath: projectPath.trim() || null,
          priority,
          timeoutSeconds,
          isDefault: false,
        }),
      })

      if (res.ok) {
        const template = await res.json()
        setTemplates([...templates, template])
        resetForm()
        setShowAdd(false)
      }
    } catch (err) {
      toastManager.add({ title: 'Failed to create template', type: 'error', description: err instanceof Error ? err.message : 'Network error' })
    }
  }

  async function handleDelete(id: string) {
    try {
      const res = await authFetch(`/api/templates/${id}`, { method: 'DELETE' })
      if (res.ok) {
        setTemplates(templates.filter((t) => t.id !== id))
      }
    } catch (err) {
      toastManager.add({ title: 'Failed to delete template', type: 'error', description: err instanceof Error ? err.message : 'Network error' })
    }
  }

  async function handleUpdate(id: string) {
    const template = templates.find((t) => t.id === id)
    if (!template) return

    try {
      const res = await authFetch(`/api/templates/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || template.name,
          promptTemplate: promptTemplate.trim() || template.promptTemplate,
          variables: variablesJson,
          projectPath: projectPath.trim() || template.projectPath,
          priority,
          timeoutSeconds,
        }),
      })

      if (res.ok) {
        const updated = await res.json()
        setTemplates(templates.map((t) => t.id === id ? updated : t))
        setEditing(null)
        resetForm()
      }
    } catch (err) {
      toastManager.add({ title: 'Failed to update template', type: 'error', description: err instanceof Error ? err.message : 'Network error' })
    }
  }

  function startEdit(id: string) {
    const template = templates.find((t) => t.id === id)
    if (!template) return
    setName(template.name)
    setPromptTemplate(template.promptTemplate)
    setVariablesJson(template.variables)
    setProjectPath(template.projectPath || '')
    setPriority(template.priority)
    setTimeoutSeconds(template.timeoutSeconds)
    setEditing(id)
    setShowAdd(false)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <span className="text-xs font-medium text-white/70">Templates</span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => { setShowAdd(true); setEditing(null); resetForm() }}
            className="text-[10px] px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors"
          >
            + New
          </button>
          <button
            onClick={onClose}
            className="text-[10px] px-2 py-1 rounded bg-white/5 text-white/50 hover:bg-white/10 transition-colors"
          >
            Back
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Add / Edit form */}
        {(showAdd || editing) && (
          <form onSubmit={editing ? (e) => { e.preventDefault(); handleUpdate(editing) } : handleCreate} className="p-3 border-b border-white/10 flex flex-col gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Template name"
              className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white/80 focus:outline-none focus:border-white/30"
              required
            />
            <textarea
              value={promptTemplate}
              onChange={(e) => setPromptTemplate(e.target.value)}
              placeholder="Prompt template (use {{variable}} for placeholders)"
              rows={4}
              className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white/80 focus:outline-none focus:border-white/30 resize-y"
              required
            />
            <input
              value={variablesJson}
              onChange={(e) => setVariablesJson(e.target.value)}
              placeholder='Variables JSON: [{"name":"x","description":"..."}]'
              className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white/80 focus:outline-none focus:border-white/30"
            />
            <input
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              placeholder="Default project path (optional)"
              className="w-full text-xs bg-white/5 border border-white/10 rounded px-2 py-1.5 text-white/80 focus:outline-none focus:border-white/30"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-500 transition-colors"
              >
                {editing ? 'Update' : 'Create'}
              </button>
              <button
                type="button"
                onClick={() => { setShowAdd(false); setEditing(null); resetForm() }}
                className="text-xs px-3 py-1.5 rounded bg-white/5 text-white/60 hover:bg-white/10 transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* Template list */}
        {templates.length === 0 && !showAdd && (
          <div className="flex items-center justify-center h-32 text-xs text-white/30">
            No templates. Click "+ New" to create one.
          </div>
        )}

        {templates.map((template) => (
          <div key={template.id} className="flex items-center gap-2 px-3 py-2 hover:bg-white/5 transition-colors">
            <div className="flex-1 min-w-0">
              <div className="text-xs text-white/70">{template.name}</div>
              <div className="text-[10px] text-white/40 truncate">{template.promptTemplate.slice(0, 60)}...</div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => startEdit(template.id)}
                className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/50 hover:bg-white/20 transition-colors"
              >
                Edit
              </button>
              <button
                onClick={() => handleDelete(template.id)}
                className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 hover:bg-red-500/30 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
