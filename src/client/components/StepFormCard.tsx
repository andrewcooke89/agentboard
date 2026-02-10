import { useState } from 'react'
import type { WorkflowStep, WorkflowStepType, StepCondition } from '@shared/types'
import { ProjectPathPicker } from './ProjectPathPicker'
import { AgentTypePicker } from './AgentTypePicker'

interface StepFormCardProps {
  step: WorkflowStep
  index: number
  totalSteps: number
  priorStepNames: string[]
  onChange: (step: WorkflowStep) => void
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}

const INPUT_CLASS =
  'px-3 py-2 bg-gray-800 text-white border border-gray-700 rounded focus:outline-none focus:border-blue-500'
const LABEL_CLASS = 'text-sm text-gray-400'

const STEP_TYPES: WorkflowStepType[] = ['spawn_session', 'check_file', 'delay', 'check_output']

const TIMEOUT_OPTIONS = [
  { label: '5 min', value: 300 },
  { label: '15 min', value: 900 },
  { label: '30 min', value: 1800 },
  { label: '1 hr', value: 3600 },
  { label: '2 hr', value: 7200 },
]

const RETRY_OPTIONS = [0, 1, 2, 3]

export function StepFormCard({
  step,
  index,
  totalSteps,
  priorStepNames,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: StepFormCardProps) {
  const [showCondition, setShowCondition] = useState(!!step.condition)

  function updateField<K extends keyof WorkflowStep>(field: K, value: WorkflowStep[K]) {
    onChange({ ...step, [field]: value })
  }

  function handleTypeChange(newType: WorkflowStepType) {
    const updated: WorkflowStep = {
      name: step.name,
      type: newType,
      condition: step.condition,
    }
    onChange(updated)
  }

  function updateCondition(condition: StepCondition | undefined) {
    onChange({ ...step, condition })
  }

  function handleAddCondition() {
    setShowCondition(true)
    if (!step.condition) {
      updateCondition({ type: 'file_exists', path: '' })
    }
  }

  function handleRemoveCondition() {
    setShowCondition(false)
    updateCondition(undefined)
  }

  function handleConditionTypeChange(condType: 'file_exists' | 'output_contains') {
    if (condType === 'file_exists') {
      updateCondition({ type: 'file_exists', path: '' })
    } else {
      updateCondition({ type: 'output_contains', step: '', contains: '' })
    }
  }

  return (
    <div className="border border-gray-700 rounded-lg p-4 bg-gray-800/50">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <span className="text-white font-medium">Step {index + 1}</span>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={index === 0}
            className="px-2 py-1 text-xs text-gray-400 hover:text-white border border-gray-700 rounded disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Move up"
          >
            Up
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={index === totalSteps - 1}
            className="px-2 py-1 text-xs text-gray-400 hover:text-white border border-gray-700 rounded disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Move down"
          >
            Down
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="px-2 py-1 text-xs text-red-400 hover:text-red-300 border border-gray-700 rounded"
            aria-label="Remove step"
          >
            Remove
          </button>
        </div>
      </div>

      {/* Name input */}
      <div className="flex flex-col gap-1 mb-3">
        <label className={LABEL_CLASS}>Name</label>
        <input
          type="text"
          value={step.name}
          onChange={(e) => updateField('name', e.target.value)}
          placeholder="Step name"
          required
          className={INPUT_CLASS}
        />
      </div>

      {/* Type dropdown */}
      <div className="flex flex-col gap-1 mb-3">
        <label className={LABEL_CLASS}>Type</label>
        <select
          value={step.type}
          onChange={(e) => handleTypeChange(e.target.value as WorkflowStepType)}
          className={INPUT_CLASS}
        >
          {STEP_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {/* Conditional fields by type */}
      {step.type === 'spawn_session' && (
        <div className="flex flex-col gap-3 mb-3">
          <ProjectPathPicker
            value={step.projectPath || ''}
            onChange={(v) => updateField('projectPath', v)}
            label="Project Path"
          />
          <AgentTypePicker
            value={step.agentType}
            onChange={(v) => updateField('agentType', v)}
            label="Agent Type"
            allowNone
          />
          <div className="flex flex-col gap-1">
            <label className={LABEL_CLASS}>Prompt</label>
            <textarea
              value={step.prompt || ''}
              onChange={(e) => updateField('prompt', e.target.value)}
              placeholder="Agent prompt"
              rows={3}
              className={`${INPUT_CLASS} resize-y`}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className={LABEL_CLASS}>Output Path (optional)</label>
            <input
              type="text"
              value={step.output_path || ''}
              onChange={(e) => updateField('output_path', e.target.value)}
              placeholder="/path/to/output"
              className={INPUT_CLASS}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className={LABEL_CLASS}>Timeout</label>
            <select
              value={step.timeoutSeconds ?? 1800}
              onChange={(e) => updateField('timeoutSeconds', Number(e.target.value))}
              className={INPUT_CLASS}
            >
              {TIMEOUT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className={LABEL_CLASS}>Retries</label>
            <select
              value={step.maxRetries ?? 0}
              onChange={(e) => updateField('maxRetries', Number(e.target.value))}
              className={INPUT_CLASS}
            >
              {RETRY_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {step.type === 'check_file' && (
        <div className="flex flex-col gap-3 mb-3">
          <div className="flex flex-col gap-1">
            <label className={LABEL_CLASS}>Path</label>
            <input
              type="text"
              value={step.path || ''}
              onChange={(e) => updateField('path', e.target.value)}
              placeholder="/path/to/file"
              required
              className={INPUT_CLASS}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className={LABEL_CLASS}>Max Age (seconds, optional)</label>
            <input
              type="number"
              value={step.max_age_seconds ?? ''}
              onChange={(e) =>
                updateField('max_age_seconds', e.target.value ? Number(e.target.value) : undefined)
              }
              placeholder="e.g. 3600"
              className={INPUT_CLASS}
            />
          </div>
        </div>
      )}

      {step.type === 'delay' && (
        <div className="flex flex-col gap-3 mb-3">
          <div className="flex flex-col gap-1">
            <label className={LABEL_CLASS}>Seconds</label>
            <input
              type="number"
              value={step.seconds ?? ''}
              onChange={(e) => updateField('seconds', e.target.value ? Number(e.target.value) : undefined)}
              placeholder="e.g. 60"
              required
              className={INPUT_CLASS}
            />
          </div>
        </div>
      )}

      {step.type === 'check_output' && (
        <div className="flex flex-col gap-3 mb-3">
          <div className="flex flex-col gap-1">
            <label className={LABEL_CLASS}>Step Reference</label>
            <select
              value={step.step || ''}
              onChange={(e) => updateField('step', e.target.value)}
              className={INPUT_CLASS}
            >
              <option value="">Select a step...</option>
              {priorStepNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className={LABEL_CLASS}>Contains</label>
            <input
              type="text"
              value={step.contains || ''}
              onChange={(e) => updateField('contains', e.target.value)}
              placeholder="Expected text in output"
              required
              className={INPUT_CLASS}
            />
          </div>
        </div>
      )}

      {/* Condition section */}
      <div className="border-t border-gray-700 pt-3 mt-3">
        {!showCondition ? (
          <button
            type="button"
            onClick={handleAddCondition}
            className="text-sm text-blue-400 hover:text-blue-300"
          >
            Add Condition
          </button>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-400 font-medium">Condition</span>
              <button
                type="button"
                onClick={handleRemoveCondition}
                className="text-xs text-red-400 hover:text-red-300"
              >
                Remove Condition
              </button>
            </div>
            <div className="flex flex-col gap-1">
              <label className={LABEL_CLASS}>Condition Type</label>
              <select
                value={step.condition?.type || 'file_exists'}
                onChange={(e) =>
                  handleConditionTypeChange(e.target.value as 'file_exists' | 'output_contains')
                }
                className={INPUT_CLASS}
              >
                <option value="file_exists">file_exists</option>
                <option value="output_contains">output_contains</option>
              </select>
            </div>
            {step.condition?.type === 'file_exists' && (
              <div className="flex flex-col gap-1">
                <label className={LABEL_CLASS}>Path</label>
                <input
                  type="text"
                  value={step.condition.path}
                  onChange={(e) => updateCondition({ type: 'file_exists', path: e.target.value })}
                  placeholder="/path/to/check"
                  className={INPUT_CLASS}
                />
              </div>
            )}
            {step.condition?.type === 'output_contains' && (
              <>
                <div className="flex flex-col gap-1">
                  <label className={LABEL_CLASS}>Step</label>
                  <select
                    value={step.condition.step}
                    onChange={(e) =>
                      updateCondition({
                        type: 'output_contains',
                        step: e.target.value,
                        contains: step.condition?.type === 'output_contains' ? step.condition.contains : '',
                      })
                    }
                    className={INPUT_CLASS}
                  >
                    <option value="">Select a step...</option>
                    {priorStepNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className={LABEL_CLASS}>Contains</label>
                  <input
                    type="text"
                    value={step.condition.contains}
                    onChange={(e) =>
                      updateCondition({
                        type: 'output_contains',
                        step: step.condition?.type === 'output_contains' ? step.condition.step : '',
                        contains: e.target.value,
                      })
                    }
                    placeholder="Expected text"
                    className={INPUT_CLASS}
                  />
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
