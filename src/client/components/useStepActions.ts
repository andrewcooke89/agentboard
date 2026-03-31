import { useCallback } from 'react'
import type { WorkflowStep, WorkflowStepType } from '@shared/types'
import type { FormState } from './WorkflowFormBuilder'

function useStepActions(setFormState: React.Dispatch<React.SetStateAction<FormState>>) {
  const updateStep = useCallback((index: number, updated: WorkflowStep) => {
    setFormState(prev => {
      const steps = [...prev.steps]
      steps[index] = updated
      return { ...prev, steps }
    })
  }, [setFormState])

  const removeStep = useCallback((index: number) => {
    setFormState(prev => {
      const steps = [...prev.steps]
      steps.splice(index, 1)
      return { ...prev, steps }
    })
  }, [setFormState])

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
  }, [setFormState])

  const addStep = useCallback(() => {
    setFormState(prev => {
      const newStep: WorkflowStep = {
        name: `step-${prev.steps.length + 1}`,
        type: 'spawn_session' as WorkflowStepType,
      }
      return { ...prev, steps: [...prev.steps, newStep] }
    })
  }, [setFormState])

  return { updateStep, removeStep, moveStep, addStep }
}

export default useStepActions
