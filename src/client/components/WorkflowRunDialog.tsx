// WorkflowRunDialog.tsx — Modal dialog for providing workflow variable values before running
import { useState, useEffect } from 'react'
import type { WorkflowVariable } from '@shared/types'

export interface WorkflowRunDialogProps {
  variables: WorkflowVariable[]
  workflowName: string
  onRun: (variables: Record<string, string>) => void
  onCancel: () => void
}

const INPUT_CLASS =
  'w-full px-3 py-2 bg-gray-800 text-white border border-gray-700 rounded focus:outline-none focus:border-blue-500 text-sm'

export default function WorkflowRunDialog({
  variables,
  workflowName,
  onRun,
  onCancel,
}: WorkflowRunDialogProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const v of variables) {
      initial[v.name] = v.default ?? ''
    }
    return initial
  })
  const [errors, setErrors] = useState<string[]>([])

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  const handleSubmit = () => {
    const errs: string[] = []
    for (const v of variables) {
      if (v.required && !values[v.name]?.trim()) {
        errs.push(`"${v.name}" is required`)
      }
    }
    if (errs.length > 0) {
      setErrors(errs)
      return
    }
    // Only pass non-empty values
    const result: Record<string, string> = {}
    for (const [key, val] of Object.entries(values)) {
      if (val.trim()) result[key] = val.trim()
    }
    onRun(result)
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
      role="dialog"
      aria-modal="true"
      aria-label={`Run ${workflowName}`}
    >
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 w-full max-w-lg max-h-[80vh] overflow-y-auto">
        <h2 className="text-lg font-semibold text-white mb-4">
          Run: {workflowName}
        </h2>

        <div className="flex flex-col gap-4">
          {variables.map((v) => (
            <div key={v.name} className="flex flex-col gap-1">
              <label className="text-sm text-gray-400" htmlFor={`var-${v.name}`}>
                {v.name}
                {v.required && <span className="text-red-400 ml-1">*</span>}
                {v.type === 'path' && (
                  <span className="text-gray-600 ml-1 text-xs">(path)</span>
                )}
              </label>
              {v.description && (
                <p className="text-xs text-gray-500">{v.description}</p>
              )}
              <input
                id={`var-${v.name}`}
                type="text"
                value={values[v.name] ?? ''}
                onChange={(e) =>
                  setValues((prev) => ({ ...prev, [v.name]: e.target.value }))
                }
                placeholder={v.default ?? ''}
                className={INPUT_CLASS}
              />
            </div>
          ))}
        </div>

        {errors.length > 0 && (
          <div className="mt-3 p-2 bg-red-900/20 border border-red-800 rounded text-xs text-red-300">
            {errors.map((e, i) => (
              <div key={i}>{e}</div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-400 bg-gray-800 hover:bg-gray-700 rounded transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            className="px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-500 rounded transition-colors"
          >
            Run
          </button>
        </div>
      </div>
    </div>
  )
}
