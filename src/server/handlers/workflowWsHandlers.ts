// workflowWsHandlers.ts - WebSocket message handlers for workflow engine operations
import type { ServerWebSocket } from 'bun'
import type { ClientMessage } from '../../shared/types'
import type { ServerContext, WSData } from '../serverContext'
import type { WorkflowStore } from '../workflowStore'

/**
 * Simplified workflow store interface for handler operations.
 * Adapts the full WorkflowStore API to only the methods needed by WS handlers.
 */
export interface WorkflowStoreAdapter {
  listWorkflows: WorkflowStore['listWorkflows']
  getWorkflow: WorkflowStore['getWorkflow']
  listRuns(limit?: number): ReturnType<WorkflowStore['listRuns']>
  listRunsByWorkflow: WorkflowStore['listRunsByWorkflow']
  getRun: WorkflowStore['getRun']
  createRun(workflowId: string, variables?: Record<string, string>, projectPath?: string): ReturnType<WorkflowStore['createRun']>
  updateRun: WorkflowStore['updateRun']
  countActiveRuns(): number
}

/**
 * Simplified workflow engine interface for handler operations.
 * Adapts the full WorkflowEngine API to only the methods needed by WS handlers.
 */
export interface WorkflowEngineAdapter {
  cancelRun(runId: string): void
}

export function createWorkflowWsHandlers(
  ctx: ServerContext,
  workflowStore: WorkflowStoreAdapter,
  workflowEngine: WorkflowEngineAdapter
) {
  function handleWorkflowListRequest(
    ws: ServerWebSocket<WSData>,
    _message: Extract<ClientMessage, { type: 'workflow-list-request' }>
  ): void {
    ctx.logger.debug('workflow_list_request', {})
    try {
      const workflows = workflowStore.listWorkflows()
      ctx.send(ws, { type: 'workflow-list', workflows })
    } catch (err) {
      ctx.logger.error('workflow_list_error', { error: String(err) })
      ctx.send(ws, { type: 'workflow-list', workflows: [] })
    }
  }

  function handleWorkflowRunListRequest(
    ws: ServerWebSocket<WSData>,
    message: Extract<ClientMessage, { type: 'workflow-run-list-request' }>
  ): void {
    const { workflowId } = message
    ctx.logger.debug('workflow_run_list_request', { workflowId: workflowId ?? 'all' })
    try {
      const runs = workflowId
        ? workflowStore.listRunsByWorkflow(workflowId)
        : workflowStore.listRuns()
      ctx.send(ws, { type: 'workflow-run-list', runs })
    } catch (err) {
      ctx.logger.error('workflow_run_list_error', { error: String(err) })
      ctx.send(ws, { type: 'workflow-run-list', runs: [] })
    }
  }

  function handleWorkflowRun(
    ws: ServerWebSocket<WSData>,
    message: Extract<ClientMessage, { type: 'workflow-run' }>
  ): void {
    const { workflowId, variables, projectPath } = message

    // Validate workflow exists
    const workflow = workflowStore.getWorkflow(workflowId)
    if (!workflow) {
      ctx.send(ws, { type: 'error', message: `Workflow not found: ${workflowId}` })
      return
    }

    // Validate workflow is valid
    if (!workflow.is_valid) {
      ctx.send(ws, { type: 'error', message: `Workflow is invalid: ${workflow.validation_errors.join(', ')}` })
      return
    }

    // Check concurrent run limit
    const activeRunCount = workflowStore.countActiveRuns()
    if (activeRunCount >= ctx.config.workflowMaxConcurrentRuns) {
      ctx.send(ws, { type: 'error', message: 'Concurrent run limit reached' })
      return
    }

    try {
      const run = workflowStore.createRun(workflowId, variables, projectPath)
      ctx.broadcast({ type: 'workflow-run-update', run })
      ctx.logger.info('workflow_run_triggered', { workflowId, runId: run.id })
    } catch (err) {
      ctx.logger.error('workflow_run_error', { workflowId, error: String(err) })
      ctx.send(ws, { type: 'error', message: `Failed to create workflow run: ${String(err)}` })
    }
  }

  function handleWorkflowRunResume(
    ws: ServerWebSocket<WSData>,
    message: Extract<ClientMessage, { type: 'workflow-run-resume' }>
  ): void {
    const { runId } = message

    // Validate run exists
    const run = workflowStore.getRun(runId)
    if (!run) {
      ctx.send(ws, { type: 'error', message: `Workflow run not found: ${runId}` })
      return
    }

    // Validate run is in failed state
    if (run.status !== 'failed') {
      ctx.send(ws, { type: 'error', message: `Cannot resume run with status: ${run.status}` })
      return
    }

    try {
      // Reset current failed step to pending and set run to running
      const stepsState = [...run.steps_state]
      const currentStep = stepsState[run.current_step_index]
      if (currentStep && currentStep.status === 'failed') {
        stepsState[run.current_step_index] = {
          ...currentStep,
          status: 'pending',
          errorMessage: null,
          startedAt: null,
          completedAt: null,
        }
      }

      const updated = workflowStore.updateRun(runId, {
        status: 'running',
        steps_state: stepsState,
        error_message: null,
      })

      if (updated) {
        ctx.broadcast({ type: 'workflow-run-update', run: updated })
        ctx.logger.info('workflow_run_resumed', { runId })
      }
    } catch (err) {
      ctx.logger.error('workflow_run_resume_error', { runId, error: String(err) })
      ctx.send(ws, { type: 'error', message: `Failed to resume workflow run: ${String(err)}` })
    }
  }

  function handleWorkflowRunCancel(
    ws: ServerWebSocket<WSData>,
    message: Extract<ClientMessage, { type: 'workflow-run-cancel' }>
  ): void {
    const { runId } = message

    // Validate run exists
    const run = workflowStore.getRun(runId)
    if (!run) {
      ctx.send(ws, { type: 'error', message: `Workflow run not found: ${runId}` })
      return
    }

    // Validate run is in running state
    if (run.status !== 'running') {
      ctx.send(ws, { type: 'error', message: `Cannot cancel run with status: ${run.status}` })
      return
    }

    try {
      // Cancel via engine (handles task cleanup)
      workflowEngine.cancelRun(runId)

      const updated = workflowStore.updateRun(runId, {
        status: 'cancelled',
        completed_at: new Date().toISOString(),
      })

      if (updated) {
        ctx.broadcast({ type: 'workflow-run-update', run: updated })
        ctx.logger.info('workflow_run_cancelled', { runId })
      }
    } catch (err) {
      ctx.logger.error('workflow_run_cancel_error', { runId, error: String(err) })
      ctx.send(ws, { type: 'error', message: `Failed to cancel workflow run: ${String(err)}` })
    }
  }

  return {
    handleWorkflowListRequest,
    handleWorkflowRunListRequest,
    handleWorkflowRun,
    handleWorkflowRunResume,
    handleWorkflowRunCancel,
  }
}
