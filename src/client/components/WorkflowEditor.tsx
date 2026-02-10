import { useCallback, useEffect, useRef, useState } from 'react'
import * as yaml from 'js-yaml'
import { useWorkflowStore } from '../stores/workflowStore'
import type { WorkflowStepType } from '@shared/types'
import WorkflowFormBuilder, { yamlToForm } from './WorkflowFormBuilder'

const VALID_STEP_TYPES: WorkflowStepType[] = ['spawn_session', 'check_file', 'delay', 'check_output']

const DEFAULT_YAML = `name: my-workflow
description: A workflow description
steps:
  - name: step-1
    type: spawn_session
    projectPath: /path/to/project
    prompt: "Do something"
`

interface ValidationResult {
  valid: boolean
  stepCount: number
  errors: string[]
}

function validateWorkflowYaml(yamlContent: string): ValidationResult {
  const errors: string[] = []

  let parsed: unknown
  try {
    parsed = yaml.load(yamlContent)
  } catch (e) {
    return {
      valid: false,
      stepCount: 0,
      errors: [`YAML parse error: ${e instanceof Error ? e.message : String(e)}`],
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, stepCount: 0, errors: ['YAML must be an object'] }
  }

  const doc = parsed as Record<string, unknown>

  if (typeof doc.name !== 'string' || doc.name.trim() === '') {
    errors.push('Workflow must have a "name" field (string)')
  }

  if (!Array.isArray(doc.steps)) {
    errors.push('Workflow must have a "steps" field (array)')
    return { valid: false, stepCount: 0, errors }
  }

  if (doc.steps.length === 0) {
    errors.push('Workflow must have at least one step')
    return { valid: false, stepCount: 0, errors }
  }

  for (let i = 0; i < doc.steps.length; i++) {
    const step = doc.steps[i] as Record<string, unknown>
    if (!step || typeof step !== 'object') {
      errors.push(`Step ${i + 1}: must be an object`)
      continue
    }
    if (typeof step.name !== 'string' || step.name.trim() === '') {
      errors.push(`Step ${i + 1}: must have a "name" field (string)`)
    }
    if (typeof step.type !== 'string' || !VALID_STEP_TYPES.includes(step.type as WorkflowStepType)) {
      errors.push(`Step ${i + 1}: "type" must be one of: ${VALID_STEP_TYPES.join(', ')}`)
    }
  }

  return {
    valid: errors.length === 0,
    stepCount: doc.steps.length,
    errors,
  }
}

interface WorkflowEditorProps {
  workflowId?: string
  onSave: () => void
  onCancel: () => void
}

export default function WorkflowEditor({ workflowId, onSave, onCancel }: WorkflowEditorProps) {
  const { createWorkflow, updateWorkflow, workflows } = useWorkflowStore()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [yamlContent, setYamlContent] = useState(DEFAULT_YAML)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(!workflowId)
  const [activeTab, setActiveTab] = useState<'form' | 'yaml'>(workflowId ? 'yaml' : 'form')
  const [tabSwitchError, setTabSwitchError] = useState<string | null>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load existing workflow
  useEffect(() => {
    if (!workflowId) return
    const existing = workflows.find((w) => w.id === workflowId)
    if (existing) {
      setName(existing.name)
      setDescription(existing.description ?? '')
      setYamlContent(existing.yaml_content)
      setLoaded(true)
    }
  }, [workflowId, workflows])

  // Debounced validation
  const runValidation = useCallback((content: string) => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    debounceRef.current = setTimeout(() => {
      setValidation(validateWorkflowYaml(content))
    }, 500)
  }, [])

  // Validate on yamlContent change
  useEffect(() => {
    runValidation(yamlContent)
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [yamlContent, runValidation])

  const switchToForm = useCallback(() => {
    const parsed = yamlToForm(yamlContent)
    if (parsed === null) {
      setTabSwitchError('Cannot switch to Form: current YAML is invalid or unparseable.')
      return
    }
    setTabSwitchError(null)
    setActiveTab('form')
  }, [yamlContent])

  const handleFormChange = useCallback((newYaml: string, _valid: boolean) => {
    setYamlContent(newYaml)
    setSaveError(null)
  }, [])

  const handleFormValidationChange = useCallback((errors: string[]) => {
    setValidation({
      valid: errors.length === 0,
      stepCount: 0, // form builder manages step count internally
      errors,
    })
  }, [])

  const handleYamlChange = (value: string) => {
    setYamlContent(value)
    setSaveError(null)
  }

  const handleSave = async () => {
    if (!validation?.valid || saving) return

    setSaving(true)
    setSaveError(null)

    try {
      let result
      if (workflowId) {
        result = await updateWorkflow(workflowId, {
          yaml_content: yamlContent,
          name: name.trim(),
          description: description.trim() || undefined,
        })
      } else {
        result = await createWorkflow(
          yamlContent,
          name.trim(),
          description.trim() || undefined,
        )
      }

      if (result.ok) {
        onSave()
      } else {
        setSaveError(result.error ?? 'Save failed')
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) {
    return (
      <div className="flex items-center justify-center p-8 text-gray-400">
        Loading workflow...
      </div>
    )
  }

  const hasErrors = validation !== null && !validation.valid
  const saveDisabled = hasErrors || saving || !validation

  return (
    <div className="flex flex-col gap-4 p-4 bg-gray-900 rounded-lg">
      <h2 className="text-lg font-semibold text-white">
        {workflowId ? 'Edit Workflow' : 'New Workflow'}
      </h2>

      {/* Name field */}
      <div className="flex flex-col gap-1">
        <label className="text-sm text-gray-400" htmlFor="workflow-name">
          Name
        </label>
        <input
          id="workflow-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Workflow name"
          className="px-3 py-2 bg-gray-800 text-white border border-gray-700 rounded focus:outline-none focus:border-blue-500"
        />
      </div>

      {/* Description field */}
      <div className="flex flex-col gap-1">
        <label className="text-sm text-gray-400" htmlFor="workflow-description">
          Description (optional)
        </label>
        <input
          id="workflow-description"
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="A brief description"
          className="px-3 py-2 bg-gray-800 text-white border border-gray-700 rounded focus:outline-none focus:border-blue-500"
        />
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-gray-800 rounded p-1" data-testid="tab-bar">
        <button
          type="button"
          data-testid="tab-form"
          onClick={switchToForm}
          className={`px-3 py-1 text-sm rounded ${activeTab === 'form' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
        >
          Form
        </button>
        <button
          type="button"
          data-testid="tab-yaml"
          onClick={() => { setActiveTab('yaml'); setTabSwitchError(null) }}
          className={`px-3 py-1 text-sm rounded ${activeTab === 'yaml' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
        >
          YAML
        </button>
      </div>

      {/* Tab switch error */}
      {tabSwitchError && (
        <div className="text-red-400 text-sm" data-testid="tab-switch-error">
          {tabSwitchError}
        </div>
      )}

      {/* Editor area */}
      {activeTab === 'form' ? (
        <WorkflowFormBuilder
          initialYaml={yamlContent}
          onChange={handleFormChange}
          onValidationChange={handleFormValidationChange}
        />
      ) : (
        <div className="flex flex-col gap-1">
          <label className="text-sm text-gray-400" htmlFor="workflow-yaml">
            YAML Definition
          </label>
          <textarea
            id="workflow-yaml"
            value={yamlContent}
            onChange={(e) => handleYamlChange(e.target.value)}
            rows={16}
            spellCheck={false}
            aria-label="Workflow YAML content"
            className="px-3 py-2 font-mono text-sm bg-gray-800 text-gray-100 border border-gray-700 rounded resize-y focus:outline-none focus:border-blue-500"
          />
        </div>
      )}

      {/* Validation feedback */}
      {validation && (
        <div
          data-testid="validation-feedback"
          className={validation.valid ? 'text-green-400 text-sm' : 'text-red-400 text-sm'}
        >
          {validation.valid ? (
            <span>Valid workflow with {validation.stepCount} step{validation.stepCount !== 1 ? 's' : ''}</span>
          ) : (
            <ul className="list-disc list-inside space-y-1">
              {validation.errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Save error */}
      {saveError && (
        <div className="text-red-400 text-sm" data-testid="save-error">
          {saveError}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm text-gray-400 hover:text-white border border-gray-700 rounded"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saveDisabled}
          className="px-4 py-2 text-sm text-white bg-blue-600 hover:bg-blue-500 rounded disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// Export for testing
export { validateWorkflowYaml, DEFAULT_YAML }
export type { ValidationResult }
