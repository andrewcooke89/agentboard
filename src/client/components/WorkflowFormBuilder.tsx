// WorkflowFormBuilder.tsx — Form-based workflow builder using StepFormCard
// Created: 2026-01-29

import { useState, useEffect, useCallback } from 'react'
import * as yaml from 'js-yaml'
import type { WorkflowStep, WorkflowStepType, WorkflowVariable } from '@shared/types'
import { StepFormCard } from './StepFormCard'

export interface FormState {
  name: string
  description: string
  steps: WorkflowStep[]
  variables: WorkflowVariable[]
}

interface WorkflowFormBuilderProps {
  initialYaml?: string
  onChange: (yaml: string, valid: boolean) => void
  onValidationChange: (errors: string[]) => void
}

function formToYaml(state: FormState): string {
  const doc: Record<string, unknown> = { name: state.name }
  if (state.description) doc.description = state.description
  if (state.variables.length > 0) {
    doc.variables = state.variables.map(v => {
      const entry: Record<string, unknown> = { name: v.name, type: v.type }
      if (v.description) entry.description = v.description
      if (!v.required) entry.required = false
      if (v.default !== undefined && v.default !== '') entry.default = v.default
      return entry
    })
  }
  doc.steps = state.steps.map(step => {
    const s: Record<string, unknown> = { name: step.name, type: step.type }
    // Only include fields relevant to the step type
    if (step.type === 'spawn_session') {
      if (step.projectPath) s.projectPath = step.projectPath
      if (step.prompt) s.prompt = step.prompt
      if (step.agentType) s.agentType = step.agentType
      if (step.output_path) s.output_path = step.output_path
      if (step.timeoutSeconds) s.timeoutSeconds = step.timeoutSeconds
      if (step.maxRetries) s.maxRetries = step.maxRetries
    } else if (step.type === 'check_file') {
      if (step.path) s.path = step.path
      if (step.max_age_seconds) s.max_age_seconds = step.max_age_seconds
    } else if (step.type === 'delay') {
      if (step.seconds) s.seconds = step.seconds
    } else if (step.type === 'check_output') {
      if (step.step) s.step = step.step
      if (step.contains) s.contains = step.contains
    }
    if (step.condition) s.condition = step.condition
    return s
  })
  return yaml.dump(doc, { lineWidth: -1, noRefs: true })
}

function yamlToForm(yamlStr: string): FormState | null {
  try {
    const doc = yaml.load(yamlStr) as Record<string, unknown>
    if (!doc || typeof doc !== 'object') return null
    const name = typeof doc.name === 'string' ? doc.name : ''
    const description = typeof doc.description === 'string' ? doc.description : ''
    const variables: WorkflowVariable[] = Array.isArray(doc.variables)
      ? doc.variables.map((v: any) => ({
          name: String(v.name ?? ''),
          type: (v.type === 'path' ? 'path' : 'string') as 'string' | 'path',
          description: String(v.description ?? ''),
          required: v.required === false || v.required === 'false' ? false : true,
          default: v.default !== undefined ? String(v.default) : undefined,
        }))
      : []
    if (!Array.isArray(doc.steps)) return null
    const steps: WorkflowStep[] = doc.steps.map((s: any) => ({
      name: s.name || '',
      type: s.type || 'spawn_session',
      projectPath: s.projectPath,
      prompt: s.prompt,
      agentType: s.agentType,
      output_path: s.output_path,
      timeoutSeconds: s.timeoutSeconds ? Number(s.timeoutSeconds) : undefined,
      maxRetries: s.maxRetries ? Number(s.maxRetries) : undefined,
      path: s.path,
      max_age_seconds: s.max_age_seconds ? Number(s.max_age_seconds) : undefined,
      seconds: s.seconds ? Number(s.seconds) : undefined,
      step: s.step,
      contains: s.contains,
      condition: s.condition,
    }))
    return { name, description, steps, variables }
  } catch {
    return null
  }
}

function validateForm(state: FormState): string[] {
  const errors: string[] = []
  if (!state.name.trim()) errors.push('Workflow name is required')
  if (state.steps.length === 0) errors.push('At least one step is required')
  const seenNames = new Set<string>()
  state.steps.forEach((step, i) => {
    const prefix = `Step ${i + 1}`
    if (!step.name.trim()) errors.push(`${prefix}: name is required`)
    if (step.name && seenNames.has(step.name)) errors.push(`${prefix}: duplicate name "${step.name}"`)
    seenNames.add(step.name)
    if (step.type === 'spawn_session') {
      if (!step.projectPath?.trim()) errors.push(`${prefix}: project path is required`)
      if (!step.prompt?.trim()) errors.push(`${prefix}: prompt is required`)
    } else if (step.type === 'check_file') {
      if (!step.path?.trim()) errors.push(`${prefix}: path is required`)
    } else if (step.type === 'delay') {
      if (!step.seconds || step.seconds <= 0) errors.push(`${prefix}: seconds must be > 0`)
    } else if (step.type === 'check_output') {
      if (!step.step?.trim()) errors.push(`${prefix}: step reference is required`)
      if (!step.contains?.trim()) errors.push(`${prefix}: contains text is required`)
    }
  })
  return errors
}

const INPUT_CLASS =
  'px-3 py-2 bg-gray-800 text-white border border-gray-700 rounded focus:outline-none focus:border-blue-500'

function WorkflowFormBuilder({ initialYaml, onChange, onValidationChange }: WorkflowFormBuilderProps) {
  const [formState, setFormState] = useState<FormState>(() => {
    if (initialYaml) {
      const parsed = yamlToForm(initialYaml)
      if (parsed) return parsed
    }
    return { name: '', description: '', steps: [], variables: [] }
  })

  // Notify parent on every state change
  useEffect(() => {
    const errors = validateForm(formState)
    onChange(formToYaml(formState), errors.length === 0)
    onValidationChange(errors)
  }, [formState]) // eslint-disable-line react-hooks/exhaustive-deps

  const updateStep = useCallback((index: number, updated: WorkflowStep) => {
    setFormState(prev => {
      const steps = [...prev.steps]
      steps[index] = updated
      return { ...prev, steps }
    })
  }, [])

  const removeStep = useCallback((index: number) => {
    setFormState(prev => {
      const steps = [...prev.steps]
      steps.splice(index, 1)
      return { ...prev, steps }
    })
  }, [])

  const moveStep = useCallback((index: number, direction: -1 | 1) => {
    setFormState(prev => {
      const target = index + direction
      if (target < 0 || target >= prev.steps.length) return prev
      const steps = [...prev.steps]
      const temp = steps[index]
      steps[index] = steps[target]
      steps[target] = temp
      return { ...prev, steps }
    })
  }, [])

  const addStep = useCallback(() => {
    setFormState(prev => {
      const newStep: WorkflowStep = {
        name: `step-${prev.steps.length + 1}`,
        type: 'spawn_session' as WorkflowStepType,
      }
      return { ...prev, steps: [...prev.steps, newStep] }
    })
  }, [])

  return (
    <div className="flex flex-col gap-4">
      {/* Name input */}
      <div className="flex flex-col gap-1">
        <label className="text-sm text-gray-400" htmlFor="form-workflow-name">
          Name
        </label>
        <input
          id="form-workflow-name"
          type="text"
          value={formState.name}
          onChange={e => setFormState(prev => ({ ...prev, name: e.target.value }))}
          placeholder="Workflow name"
          className={INPUT_CLASS}
        />
      </div>

      {/* Description input */}
      <div className="flex flex-col gap-1">
        <label className="text-sm text-gray-400" htmlFor="form-workflow-description">
          Description (optional)
        </label>
        <input
          id="form-workflow-description"
          type="text"
          value={formState.description}
          onChange={e => setFormState(prev => ({ ...prev, description: e.target.value }))}
          placeholder="A brief description"
          className={INPUT_CLASS}
        />
      </div>

      {/* Variables section */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <label className="text-sm text-gray-400">Variables</label>
          <button
            type="button"
            onClick={() => setFormState(prev => ({
              ...prev,
              variables: [...prev.variables, { name: '', type: 'string' as const, description: '', required: true }],
            }))}
            className="px-2 py-1 text-xs text-green-400 hover:text-green-300 bg-gray-800 hover:bg-gray-700 rounded transition-colors"
          >
            + Add Variable
          </button>
        </div>
        {formState.variables.map((v, i) => (
          <div key={i} className="flex gap-2 items-start p-2 bg-gray-800 border border-gray-700 rounded">
            <div className="flex flex-col gap-1 flex-1">
              <input
                type="text"
                value={v.name}
                onChange={e => {
                  const vars = [...formState.variables]
                  vars[i] = { ...vars[i], name: e.target.value }
                  setFormState(prev => ({ ...prev, variables: vars }))
                }}
                placeholder="Variable name"
                className={`${INPUT_CLASS} text-xs`}
              />
            </div>
            <select
              value={v.type}
              onChange={e => {
                const vars = [...formState.variables]
                vars[i] = { ...vars[i], type: e.target.value as 'string' | 'path' }
                setFormState(prev => ({ ...prev, variables: vars }))
              }}
              className="px-2 py-2 bg-gray-800 text-white border border-gray-700 rounded text-xs focus:outline-none focus:border-blue-500"
            >
              <option value="string">string</option>
              <option value="path">path</option>
            </select>
            <input
              type="text"
              value={v.description}
              onChange={e => {
                const vars = [...formState.variables]
                vars[i] = { ...vars[i], description: e.target.value }
                setFormState(prev => ({ ...prev, variables: vars }))
              }}
              placeholder="Description"
              className={`${INPUT_CLASS} text-xs flex-1`}
            />
            <input
              type="text"
              value={v.default ?? ''}
              onChange={e => {
                const vars = [...formState.variables]
                vars[i] = { ...vars[i], default: e.target.value || undefined }
                setFormState(prev => ({ ...prev, variables: vars }))
              }}
              placeholder="Default"
              className={`${INPUT_CLASS} text-xs w-24`}
            />
            <label className="flex items-center gap-1 text-xs text-gray-400 whitespace-nowrap">
              <input
                type="checkbox"
                checked={v.required}
                onChange={e => {
                  const vars = [...formState.variables]
                  vars[i] = { ...vars[i], required: e.target.checked }
                  setFormState(prev => ({ ...prev, variables: vars }))
                }}
                className="accent-blue-500"
              />
              Req
            </label>
            <button
              type="button"
              onClick={() => {
                const vars = [...formState.variables]
                vars.splice(i, 1)
                setFormState(prev => ({ ...prev, variables: vars }))
              }}
              className="px-2 py-1 text-xs text-red-400 hover:text-red-300"
              aria-label="Remove variable"
            >
              x
            </button>
          </div>
        ))}
      </div>

      {/* Steps list */}
      {formState.steps.map((step, i) => (
        <StepFormCard
          key={i}
          step={step}
          index={i}
          totalSteps={formState.steps.length}
          priorStepNames={formState.steps.slice(0, i).map(s => s.name)}
          onChange={updated => updateStep(i, updated)}
          onRemove={() => removeStep(i)}
          onMoveUp={() => moveStep(i, -1)}
          onMoveDown={() => moveStep(i, 1)}
        />
      ))}

      {/* Add Step button */}
      <button
        type="button"
        onClick={addStep}
        className="px-4 py-2 text-sm text-white bg-green-600 hover:bg-green-500 rounded"
      >
        Add Step
      </button>
    </div>
  )
}

export default WorkflowFormBuilder
export { formToYaml, yamlToForm, validateForm }
