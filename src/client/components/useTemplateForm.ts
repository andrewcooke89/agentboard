// useTemplateForm.ts - Hook for template form state and CRUD operations
import { useState, useCallback } from 'react'
import type { TaskTemplate } from '@shared/types'
import { authFetch } from '../utils/api'
import { toastManager } from './Toast'

export function useTemplateForm(
  templates: TaskTemplate[],
  setTemplates: (templates: TaskTemplate[]) => void
) {
  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [promptTemplate, setPromptTemplate] = useState('')
  const [variablesJson, setVariablesJson] = useState('[]')
  const [projectPath, setProjectPath] = useState('')

  const openAdd = useCallback(() => {
    setShowAdd(true)
    setEditing(null)
    setName('')
    setPromptTemplate('')
    setVariablesJson('[]')
    setProjectPath('')
  }, [])

  const startEdit = useCallback((id: string) => {
    const template = templates.find((t) => t.id === id)
    if (!template) return
    setEditing(id)
    setShowAdd(false)
    setName(template.name)
    setPromptTemplate(template.promptTemplate)
    setVariablesJson(template.variables)
    setProjectPath(template.projectPath ?? '')
  }, [templates])

  const cancelForm = useCallback(() => {
    setShowAdd(false)
    setEditing(null)
    setName('')
    setPromptTemplate('')
    setVariablesJson('[]')
    setProjectPath('')
  }, [])

  const handleCreate = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const res = await authFetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          promptTemplate,
          variables: variablesJson,
          projectPath: projectPath || null,
          priority: 0,
          timeoutSeconds: 300,
        }),
      })
      if (res.ok) {
        const created = await res.json()
        setTemplates([...templates, created])
        cancelForm()
      } else {
        const err = await res.json()
        toastManager.add({ title: 'Failed to create template', type: 'error', description: err.error ?? 'Unknown error' })
      }
    } catch (err) {
      toastManager.add({ title: 'Failed to create template', type: 'error', description: err instanceof Error ? err.message : 'Network error' })
    }
  }, [name, promptTemplate, variablesJson, projectPath, templates, setTemplates, cancelForm])

  const handleUpdate = useCallback(async (id: string) => {
    try {
      const res = await authFetch(`/api/templates/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          promptTemplate,
          variables: variablesJson,
          projectPath: projectPath || null,
        }),
      })
      if (res.ok) {
        const updated = await res.json()
        setTemplates(templates.map((t) => (t.id === id ? updated : t)))
        cancelForm()
      } else {
        const err = await res.json()
        toastManager.add({ title: 'Failed to update template', type: 'error', description: err.error ?? 'Unknown error' })
      }
    } catch (err) {
      toastManager.add({ title: 'Failed to update template', type: 'error', description: err instanceof Error ? err.message : 'Network error' })
    }
  }, [name, promptTemplate, variablesJson, projectPath, templates, setTemplates, cancelForm])

  const handleDelete = useCallback(async (id: string) => {
    try {
      const res = await authFetch(`/api/templates/${id}`, { method: 'DELETE' })
      if (res.ok) {
        setTemplates(templates.filter((t) => t.id !== id))
      } else {
        const err = await res.json()
        toastManager.add({ title: 'Failed to delete template', type: 'error', description: err.error ?? 'Unknown error' })
      }
    } catch (err) {
      toastManager.add({ title: 'Failed to delete template', type: 'error', description: err instanceof Error ? err.message : 'Network error' })
    }
  }, [templates, setTemplates])

  return {
    showAdd,
    editing,
    name,
    setName,
    promptTemplate,
    setPromptTemplate,
    variablesJson,
    setVariablesJson,
    projectPath,
    setProjectPath,
    openAdd,
    startEdit,
    cancelForm,
    handleCreate,
    handleUpdate,
    handleDelete,
  }
}
