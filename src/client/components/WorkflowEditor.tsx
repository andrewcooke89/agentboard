import React, { useState, useEffect, useCallback } from 'react'
import yaml from 'js-yaml'

export interface WorkflowEditorProps {
  workflowId?: string
  onSave: () => void
  onCancel: () => void
}

export interface ValidationResult {
  valid: boolean
  stepCount: number
  errors: string[]
}

const VALID_STEP_TYPES = [
  'spawn_session',
  'delay',
  'parallel_group',
  'review_loop',
  'native_step',
  'amendment_check',
  'spec_validate',
  'reconcile-spec',
]

export function validateWorkflowYaml(yamlContent: string): ValidationResult {
  const errors: string[] = []
  let stepCount = 0

  let parsed: Record<string, unknown>
  try {
    parsed = yaml.load(yamlContent) as Record<string, unknown>
  } catch (e) {
    return {
      valid: false,
      stepCount: 0,
      errors: [`YAML parse error: ${e instanceof Error ? e.message : String(e)}`],
    }
  }

  if (typeof parsed.name !== 'string') {
    errors.push('Workflow must have a "name" field (string)')
  }

  if (!Array.isArray(parsed.steps)) {
    errors.push('Workflow must have a "steps" field (array)')
    return { valid: false, stepCount: 0, errors }
  }

  stepCount = parsed.steps.length

  if (stepCount === 0) {
    errors.push('Workflow must have at least one step')
  }

  for (let i = 0; i < parsed.steps.length; i++) {
    const step = parsed.steps[i] as Record<string, unknown>
    if (typeof step.name !== 'string') {
      errors.push(`Step ${i + 1} must have a "name" field (string)`)
    }
    if (!VALID_STEP_TYPES.includes(step.type as string)) {
      errors.push(`Step ${i + 1} "type" must be one of: ${VALID_STEP_TYPES.join(', ')}`)
    }
  }

  return {
    valid: errors.length === 0,
    stepCount,
    errors,
  }
}

const DEFAULT_YAML = `name: my-workflow
description: A workflow description
steps:
  - name: step-1
    type: spawn_session
    projectPath: /tmp
    prompt: "hello"
`

export default function WorkflowEditor({ workflowId, onSave, onCancel }: WorkflowEditorProps): React.ReactElement {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [yamlContent, setYamlContent] = useState(DEFAULT_YAML)
  const [activeTab, setActiveTab] = useState<'form' | 'yaml'>('form')
  const [validationErrors, setValidationErrors] = useState<string[]>([])

  useEffect(() => {
    if (workflowId) {
      // Load existing workflow - in real implementation would fetch from store
      // For now, just a placeholder
    }
  }, [workflowId])

  const handleYamlChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setYamlContent(e.target.value)
  }, [])

  const handleSave = useCallback(() => {
    const result = validateWorkflowYaml(yamlContent)
    if (result.valid) {
      onSave()
    } else {
      setValidationErrors(result.errors)
    }
  }, [yamlContent, onSave])

  return (
    <div className="workflow-editor">
      <div className="tabs">
        <button
          data-testid="tab-form"
          onClick={() => setActiveTab('form')}
          className={activeTab === 'form' ? 'active' : ''}
        >
          Form
        </button>
        <button
          data-testid="tab-yaml"
          onClick={() => setActiveTab('yaml')}
          className={activeTab === 'yaml' ? 'active' : ''}
        >
          YAML
        </button>
      </div>

      <div className="form-fields">
        <input
          type="text"
          placeholder="Workflow name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          type="text"
          placeholder="A brief description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      {activeTab === 'yaml' && (
        <textarea
          aria-label="Workflow YAML content"
          value={yamlContent}
          onChange={handleYamlChange}
        />
      )}

      {activeTab === 'form' && (
        <textarea
          placeholder="Enter prompt"
          value=""
          onChange={() => {}}
        />
      )}

      {validationErrors.length > 0 && (
        <div className="validation-errors">
          {validationErrors.map((error, i) => (
            <div key={i} className="error">
              {error}
            </div>
          ))}
        </div>
      )}

      <div className="actions">
        <button onClick={handleSave}>Save</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
