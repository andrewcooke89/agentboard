// useTemplateForm.ts - Form state and CRUD handlers for TemplateManager
import { useState } from 'react'
import { authFetch } from '../utils/api'
import { toastManager } from './Toast'

interface Template {
  id: string
  name: string
  promptTemplate: string
  variables: string
  projectPath: string | null
  priority: number
  timeoutSeconds: number
  isDefault: boolean
}

export function useTemplateForm(templates: Template[], setTemplates: (t: Template[]) => void) {
  const [editing, setEditing] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
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

  function openAdd() {
    setShowAdd(true)
    setEditing(null)
    resetForm()
  }

  function cancelForm() {
    setShowAdd(false)
    setEditing(null)
    resetForm()
  }

  return {
    editing, showAdd,
    name, setName,
    promptTemplate, setPromptTemplate,
    variablesJson, setVariablesJson,
    projectPath, setProjectPath,
    priority, setPriority,
    timeoutSeconds, setTimeoutSeconds,
    resetForm, handleCreate, handleDelete, handleUpdate, startEdit,
    openAdd, cancelForm,
  }
}
