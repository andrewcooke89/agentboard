// workflowTestUtils.ts - Shared test helpers for workflow tests
import type { StepRunState, WorkflowStepType } from '../../../shared/types'

export function makeStepsState(count = 1, type: WorkflowStepType = 'delay'): StepRunState[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `step-${i + 1}`,
    type,
    status: 'pending' as const,
    taskId: null,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    retryCount: 0,
    skippedReason: null,
    resultFile: null,
    resultCollected: false,
    resultContent: null,
  }))
}
