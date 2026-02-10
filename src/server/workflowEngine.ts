// workflowEngine.ts - Core workflow execution engine: poll running workflows, process steps, advance state
import fs from 'node:fs'
import path from 'node:path'
import type { ServerContext } from './serverContext'
import type { WorkflowStore } from './workflowStore'
import type { TaskStore } from './taskStore'
import type {
  WorkflowRun,
  WorkflowStep,
  StepRunState,
  WorkflowStatus,
} from '../shared/types'
import { parseWorkflowYAML, substituteVariables } from './workflowSchema'
import { sanitizeForLog } from './validators'

const MAX_RESULT_FILE_SIZE = 1024 * 1024 // 1 MB

export interface WorkflowEngine {
  start: () => void
  stop: () => void
  recoverRunningWorkflows: () => void
  wakeUpPoller: () => void
}

export function createWorkflowEngine(
  ctx: ServerContext,
  workflowStore: WorkflowStore,
  taskStore: TaskStore,
): WorkflowEngine {
  let pollIntervalId: ReturnType<typeof setInterval> | null = null
  let currentPollInterval = ctx.config.workflowPollIntervalMs
  const MAX_IDLE_INTERVAL = 10000 // 10s when no active runs

  function stop(): void {
    if (pollIntervalId) {
      clearInterval(pollIntervalId)
      pollIntervalId = null
    }
    ctx.logger.info('workflow_engine_stopped')
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  function broadcastRunUpdate(run: WorkflowRun): void {
    ctx.broadcast({ type: 'workflow-run-update', run })
  }

  /** Resolve a relative path against the run's output_dir (with traversal protection) */
  function resolveOutputPath(run: WorkflowRun, relPath: string): string {
    const resolved = path.resolve(run.output_dir, relPath)
    const normalizedBase = path.resolve(run.output_dir)
    if (!resolved.startsWith(normalizedBase)) {
      throw new Error(`Path traversal detected: ${relPath} escapes output directory`)
    }
    return resolved
  }

  /** Get parsed workflow steps from the workflow definition YAML */
  function getWorkflowSteps(run: WorkflowRun): WorkflowStep[] | null {
    const workflow = workflowStore.getWorkflow(run.workflow_id)
    if (!workflow) return null
    const result = parseWorkflowYAML(workflow.yaml_content)
    if (!result.valid || !result.workflow) return null
    // Apply variable substitution if the run has variables
    if (run.variables && Object.keys(run.variables).length > 0) {
      try {
        return substituteVariables(result.workflow.steps, run.variables)
      } catch {
        return null // Substitution failed (e.g., path traversal) — treated as unparseable
      }
    }
    return result.workflow.steps
  }

  /** Persist updated run state to the DB and broadcast */
  function saveAndBroadcast(run: WorkflowRun): void {
    const updated = workflowStore.updateRun(run.id, {
      status: run.status,
      current_step_index: run.current_step_index,
      steps_state: run.steps_state,
      completed_at: run.completed_at,
      error_message: run.error_message,
    })
    if (updated) broadcastRunUpdate(updated)
  }

  /** Mark a workflow as failed with an error message */
  function failWorkflow(run: WorkflowRun, errorMessage: string): void {
    run.status = 'failed' as WorkflowStatus
    run.error_message = errorMessage
    run.completed_at = new Date().toISOString()
    saveAndBroadcast(run)
    ctx.logger.info('workflow_failed', { runId: run.id, error: sanitizeForLog(errorMessage) })
  }

  /** Mark a workflow as completed */
  function completeWorkflow(run: WorkflowRun): void {
    run.status = 'completed' as WorkflowStatus
    run.completed_at = new Date().toISOString()
    saveAndBroadcast(run)
    ctx.logger.info('workflow_completed', { runId: run.id })
    cleanupOutputDir(run)
  }

  /** Clean up a run's output directory (best-effort, log warning on failure) */
  function cleanupOutputDir(run: WorkflowRun): void {
    if (!run.output_dir) return
    try {
      fs.rmSync(run.output_dir, { recursive: true, force: true })
      ctx.logger.info('workflow_output_dir_cleaned', { runId: run.id, dir: run.output_dir })
    } catch (err) {
      ctx.logger.warn('workflow_output_dir_cleanup_failed', {
        runId: run.id,
        dir: run.output_dir,
        error: String(err),
      })
    }
  }

  /** Collect structured result file from a completed step */
  function collectStepResult(run: WorkflowRun, stepDef: WorkflowStep, stepState: StepRunState): void {
    if (!stepDef.result_file) return

    stepState.resultFile = stepDef.result_file
    stepState.resultCollected = false
    stepState.resultContent = null

    try {
      const fullPath = resolveOutputPath(run, stepDef.result_file)
      if (!fs.existsSync(fullPath)) {
        ctx.logger.warn('result_file_missing', {
          runId: run.id,
          step: stepDef.name,
          path: stepDef.result_file,
        })
        return
      }

      const stat = fs.statSync(fullPath)
      if (stat.size > MAX_RESULT_FILE_SIZE) {
        ctx.logger.warn('result_file_too_large', {
          runId: run.id,
          step: stepDef.name,
          path: stepDef.result_file,
          size: stat.size,
          maxSize: MAX_RESULT_FILE_SIZE,
        })
        return
      }

      stepState.resultContent = fs.readFileSync(fullPath, 'utf-8')
      stepState.resultCollected = true
      ctx.logger.info('result_file_collected', {
        runId: run.id,
        step: stepDef.name,
        path: stepDef.result_file,
        size: stat.size,
      })
    } catch (err) {
      ctx.logger.warn('result_file_error', {
        runId: run.id,
        step: stepDef.name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Advance to the next step or complete the workflow */
  function advanceWorkflow(run: WorkflowRun, steps: WorkflowStep[]): void {
    // Collect result from just-completed step BEFORE advancing index
    const idx = run.current_step_index
    const stepDef = steps[idx]
    const stepState = run.steps_state[idx]
    if (stepDef && stepState?.status === 'completed') {
      collectStepResult(run, stepDef, stepState)
    }

    run.current_step_index += 1
    if (run.current_step_index >= steps.length) {
      completeWorkflow(run)
    } else {
      saveAndBroadcast(run)
    }
  }

  // ── Condition Evaluation ──────────────────────────────────────────────

  function evaluateCondition(
    run: WorkflowRun,
    condition: WorkflowStep['condition'],
  ): { met: boolean; reason?: string } {
    if (!condition) return { met: true }

    switch (condition.type) {
      case 'file_exists': {
        const filePath = resolveOutputPath(run, condition.path)
        if (!fs.existsSync(filePath)) {
          return { met: false, reason: `file not found: ${condition.path}` }
        }
        return { met: true }
      }
      case 'output_contains': {
        const refStep = run.steps_state.find((s) => s.name === condition.step)
        if (!refStep) {
          return { met: false, reason: `referenced step "${condition.step}" not found` }
        }
        // Find the output_path from the workflow step definition
        const outputPath = findStepOutputPath(run, condition.step)
        if (!outputPath) {
          return { met: false, reason: `no output_path for step "${condition.step}"` }
        }
        const fullPath = resolveOutputPath(run, outputPath)
        try {
          const contents = fs.readFileSync(fullPath, 'utf-8')
          if (!contents.includes(condition.contains)) {
            return { met: false, reason: `output of "${condition.step}" does not contain "${condition.contains}"` }
          }
          return { met: true }
        } catch {
          return { met: false, reason: `cannot read output of step "${condition.step}"` }
        }
      }
      default:
        return { met: false, reason: `unknown condition type` }
    }
  }

  /**
   * Read a file in chunks, searching for `needle` string.
   * Keeps overlap from previous chunk to handle boundary matches.
   * Throws if file exceeds maxBytes during read (TOCTOU-safe).
   */
  function readFileChunkedContains(
    filePath: string,
    needle: string,
    maxBytes: number,
    chunkSize: number,
  ): boolean {
    if (needle === '') return true // empty string is always contained

    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(chunkSize)
      let totalBytesRead = 0
      let overlap = '' // tail of previous chunk for boundary matching
      const overlapSize = Math.max(needle.length - 1, 0)

      while (true) {
        const bytesRead = fs.readSync(fd, buf, 0, chunkSize, null)
        if (bytesRead === 0) break

        totalBytesRead += bytesRead
        if (totalBytesRead > maxBytes) {
          throw new Error(`Output file too large: read ${totalBytesRead} bytes (max ${maxBytes})`)
        }

        const chunk = buf.toString('utf-8', 0, bytesRead)
        const searchStr = overlap + chunk
        if (searchStr.includes(needle)) {
          return true
        }

        // Keep tail for next iteration to catch boundary matches
        overlap = overlapSize > 0 ? chunk.slice(-overlapSize) : ''
      }

      return false
    } finally {
      fs.closeSync(fd)
    }
  }

  /** Find the output_path for a named step from the workflow definition */
  function findStepOutputPath(run: WorkflowRun, stepName: string): string | null {
    const steps = getWorkflowSteps(run)
    if (!steps) return null
    const step = steps.find((s) => s.name === stepName)
    return step?.output_path ?? null
  }

  // ── Step Processing ──────────────────────────────────────────────────

  function processSpawnSession(
    run: WorkflowRun,
    step: WorkflowStep,
    stepState: StepRunState,
    steps: WorkflowStep[],
  ): void {
    if (stepState.status === 'pending') {
      // Validate projectPath against allowed roots
      const projectPath = step.projectPath ?? run.output_dir
      const allowedRoots = ctx.config.allowedRoots ?? []
      if (allowedRoots.length > 0 && projectPath) {
        const resolved = path.resolve(projectPath)
        const isAllowed = allowedRoots.some((root) => resolved.startsWith(root + path.sep) || resolved === root)
        if (!isAllowed) {
          stepState.status = 'failed'
          stepState.errorMessage = `projectPath "${projectPath}" is not under any allowed root`
          stepState.completedAt = new Date().toISOString()
          failWorkflow(run, `Step "${step.name}": ${stepState.errorMessage}`)
          return
        }
      }

      // Create task in the task queue
      const prompt = run.output_dir
        ? `Working directory: ${run.output_dir}\n\n${step.prompt ?? ''}`
        : (step.prompt ?? '')

      const task = taskStore.createTask({
        projectPath: step.projectPath ?? run.output_dir,
        prompt,
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: step.maxRetries ?? 0,
        timeoutSeconds: step.timeoutSeconds ?? 1800,
      })

      // Set workflow metadata on the task
      const metadataObj: Record<string, string> = {
        workflow_run_id: run.id,
        workflow_step_name: step.name,
      }
      if (step.agentType) {
        metadataObj.agent_type = step.agentType
      }

      taskStore.updateTask(task.id, {
        metadata: JSON.stringify(metadataObj),
      })

      stepState.status = 'running'
      stepState.taskId = task.id
      stepState.startedAt = new Date().toISOString()
      saveAndBroadcast(run)

      ctx.logger.info('workflow_step_spawned', {
        runId: run.id,
        step: sanitizeForLog(step.name),
        taskId: task.id,
      })
      return
    }

    if (stepState.status === 'running' && stepState.taskId) {
      // Monitor task status
      const task = taskStore.getTask(stepState.taskId)
      if (!task) {
        stepState.status = 'failed'
        stepState.errorMessage = 'task disappeared'
        stepState.completedAt = new Date().toISOString()
        failWorkflow(run, `Step "${sanitizeForLog(step.name)}": task disappeared`)
        return
      }

      if (task.status === 'completed') {
        stepState.status = 'completed'
        stepState.completedAt = new Date().toISOString()
        saveAndBroadcast(run)
        advanceWorkflow(run, steps)
        return
      }

      if (task.status === 'failed') {
        const maxRetries = step.maxRetries ?? 0
        if (stepState.retryCount < maxRetries) {
          // Retry: re-queue the task
          stepState.retryCount += 1
          stepState.taskId = null
          stepState.status = 'pending'
          saveAndBroadcast(run)
          ctx.logger.info('workflow_step_retry', {
            runId: run.id,
            step: sanitizeForLog(step.name),
            retryCount: stepState.retryCount,
          })
          return
        }

        stepState.status = 'failed'
        stepState.errorMessage = task.errorMessage ?? 'task failed'
        stepState.completedAt = new Date().toISOString()
        failWorkflow(run, `Step "${sanitizeForLog(step.name)}" failed: ${sanitizeForLog(task.errorMessage ?? 'task failed')}`)
        return
      }

      // Task still running - nothing to do, will check again next poll
    }
  }

  function processCheckFile(
    run: WorkflowRun,
    step: WorkflowStep,
    stepState: StepRunState,
    steps: WorkflowStep[],
  ): void {
    if (stepState.status === 'pending') {
      stepState.status = 'running'
      stepState.startedAt = new Date().toISOString()
      saveAndBroadcast(run)
    }

    const filePath = resolveOutputPath(run, step.path ?? '')
    const exists = fs.existsSync(filePath)

    if (exists) {
      // Check max_age_seconds if set
      if (step.max_age_seconds != null) {
        try {
          const stat = fs.statSync(filePath)
          const ageSec = (Date.now() - stat.mtimeMs) / 1000
          if (ageSec > step.max_age_seconds) {
            // File too old, keep waiting (or timeout below)
          } else {
            stepState.status = 'completed'
            stepState.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
            advanceWorkflow(run, steps)
            return
          }
        } catch {
          // Can't stat - keep waiting
        }
      } else {
        stepState.status = 'completed'
        stepState.completedAt = new Date().toISOString()
        saveAndBroadcast(run)
        advanceWorkflow(run, steps)
        return
      }
    }

    // Check timeout
    if (stepState.startedAt && step.timeoutSeconds) {
      const elapsed = (Date.now() - new Date(stepState.startedAt).getTime()) / 1000
      if (elapsed > step.timeoutSeconds) {
        stepState.status = 'failed'
        stepState.errorMessage = `file not found within ${step.timeoutSeconds}s: ${step.path}`
        stepState.completedAt = new Date().toISOString()
        failWorkflow(run, `Step "${sanitizeForLog(step.name)}": ${sanitizeForLog(stepState.errorMessage)}`)
      }
    }
  }

  function processDelay(
    run: WorkflowRun,
    step: WorkflowStep,
    stepState: StepRunState,
    steps: WorkflowStep[],
  ): void {
    if (stepState.status === 'pending') {
      stepState.status = 'running'
      stepState.startedAt = new Date().toISOString()
      saveAndBroadcast(run)
      return // Wait until next poll to check elapsed time
    }

    if (stepState.status === 'running' && stepState.startedAt) {
      const elapsed = (Date.now() - new Date(stepState.startedAt).getTime()) / 1000
      const delaySeconds = step.seconds ?? 0
      if (elapsed >= delaySeconds) {
        stepState.status = 'completed'
        stepState.completedAt = new Date().toISOString()
        saveAndBroadcast(run)
        advanceWorkflow(run, steps)
      }
      // Otherwise keep waiting - wall-clock based for restart safety
    }
  }

  function processCheckOutput(
    run: WorkflowRun,
    step: WorkflowStep,
    stepState: StepRunState,
    steps: WorkflowStep[],
  ): void {
    if (stepState.status === 'pending') {
      stepState.status = 'running'
      stepState.startedAt = new Date().toISOString()
      saveAndBroadcast(run)
    }

    const refStepName = step.step ?? ''
    const refStep = run.steps_state.find((s) => s.name === refStepName)
    if (!refStep) {
      stepState.status = 'failed'
      stepState.errorMessage = `referenced step "${refStepName}" not found`
      stepState.completedAt = new Date().toISOString()
      failWorkflow(run, `Step "${sanitizeForLog(step.name)}": ${sanitizeForLog(stepState.errorMessage)}`)
      return
    }

    // Find output_path from step definition
    const outputPath = findStepOutputPath(run, refStepName)
    if (!outputPath) {
      stepState.status = 'failed'
      stepState.errorMessage = `no output_path for referenced step "${refStepName}"`
      stepState.completedAt = new Date().toISOString()
      failWorkflow(run, `Step "${sanitizeForLog(step.name)}": ${sanitizeForLog(stepState.errorMessage)}`)
      return
    }

    const fullPath = resolveOutputPath(run, outputPath)
    const MAX_OUTPUT_FILE_SIZE = 10 * 1024 * 1024 // 10MB
    const CHUNK_SIZE = 64 * 1024 // 64KB
    try {
      const needle = step.contains ?? ''
      const found = readFileChunkedContains(fullPath, needle, MAX_OUTPUT_FILE_SIZE, CHUNK_SIZE)
      if (found) {
        stepState.status = 'completed'
        stepState.completedAt = new Date().toISOString()
        saveAndBroadcast(run)
        advanceWorkflow(run, steps)
        return
      }
    } catch (err) {
      // File doesn't exist yet, can't be read, or exceeded size limit
      if (err instanceof Error && err.message.startsWith('Output file too large')) {
        stepState.status = 'failed'
        stepState.errorMessage = err.message
        stepState.completedAt = new Date().toISOString()
        failWorkflow(run, `Step "${sanitizeForLog(step.name)}": ${sanitizeForLog(stepState.errorMessage)}`)
        return
      }
      // Otherwise file doesn't exist yet or can't be read - keep waiting
    }

    // Check timeout
    if (stepState.startedAt && step.timeoutSeconds) {
      const elapsed = (Date.now() - new Date(stepState.startedAt).getTime()) / 1000
      if (elapsed > step.timeoutSeconds) {
        stepState.status = 'failed'
        stepState.errorMessage = `output check timed out after ${step.timeoutSeconds}s`
        stepState.completedAt = new Date().toISOString()
        failWorkflow(run, `Step "${sanitizeForLog(step.name)}": ${sanitizeForLog(stepState.errorMessage)}`)
      }
    }
  }

  // ── Main Processing ──────────────────────────────────────────────────

  function processRun(run: WorkflowRun): void {
    const steps = getWorkflowSteps(run)
    if (!steps) {
      failWorkflow(run, 'Cannot parse workflow definition')
      return
    }

    if (run.current_step_index >= steps.length) {
      completeWorkflow(run)
      return
    }

    const stepDef = steps[run.current_step_index]
    const stepState = run.steps_state[run.current_step_index]
    if (!stepDef || !stepState) {
      failWorkflow(run, `Missing step definition or state at index ${run.current_step_index}`)
      return
    }

    // Evaluate condition before processing
    if (stepState.status === 'pending' && stepDef.condition) {
      const condResult = evaluateCondition(run, stepDef.condition)
      if (!condResult.met) {
        stepState.status = 'skipped'
        stepState.skippedReason = condResult.reason ?? 'condition not met'
        stepState.completedAt = new Date().toISOString()
        saveAndBroadcast(run)
        advanceWorkflow(run, steps)
        return
      }
    }

    // Process based on step type
    switch (stepDef.type) {
      case 'spawn_session':
        processSpawnSession(run, stepDef, stepState, steps)
        break
      case 'check_file':
        processCheckFile(run, stepDef, stepState, steps)
        break
      case 'delay':
        processDelay(run, stepDef, stepState, steps)
        break
      case 'check_output':
        processCheckOutput(run, stepDef, stepState, steps)
        break
      default:
        failWorkflow(run, `Unknown step type: ${stepDef.type}`)
    }
  }

  function poll(): void {
    try {
      const runs = workflowStore.getRunningRuns()

      // Adaptive polling: slow down when idle, speed up when active
      if (runs.length === 0 && currentPollInterval < MAX_IDLE_INTERVAL) {
        currentPollInterval = Math.min(currentPollInterval * 2, MAX_IDLE_INTERVAL)
        if (pollIntervalId) {
          clearInterval(pollIntervalId)
          pollIntervalId = setInterval(poll, currentPollInterval)
        }
      } else if (runs.length > 0 && currentPollInterval !== ctx.config.workflowPollIntervalMs) {
        currentPollInterval = ctx.config.workflowPollIntervalMs
        if (pollIntervalId) {
          clearInterval(pollIntervalId)
          pollIntervalId = setInterval(poll, currentPollInterval)
        }
      }

      for (const run of runs) {
        try {
          processRun(run)
        } catch (err) {
          ctx.logger.error('workflow_engine_run_error', {
            runId: run.id,
            error: String(err),
          })
        }
      }
    } catch (err) {
      ctx.logger.error('workflow_engine_poll_fatal', { error: String(err) })
      stop()
    }
  }

  // ── Recovery ──────────────────────────────────────────────────────────

  function recoverRunningWorkflows(): void {
    const runs = workflowStore.getRunningRuns()
    ctx.logger.info('workflow_engine_recovery', { runCount: runs.length })

    for (const run of runs) {
      try {
        const steps = getWorkflowSteps(run)
        if (!steps) {
          failWorkflow(run, 'Cannot parse workflow definition during recovery')
          continue
        }

        if (run.current_step_index >= steps.length) {
          completeWorkflow(run)
          continue
        }

        const stepState = run.steps_state[run.current_step_index]
        if (!stepState) {
          failWorkflow(run, `Missing step state at index ${run.current_step_index}`)
          continue
        }

        // For spawn_session with a taskId, check task status
        if (stepState.type === 'spawn_session' && stepState.taskId && stepState.status === 'running') {
          const task = taskStore.getTask(stepState.taskId)
          if (!task) {
            stepState.status = 'failed'
            stepState.errorMessage = 'task not found during recovery'
            stepState.completedAt = new Date().toISOString()
            failWorkflow(run, `Step "${stepState.name}": task not found during recovery`)
            continue
          }
          if (task.status === 'completed') {
            stepState.status = 'completed'
            stepState.completedAt = new Date().toISOString()
            advanceWorkflow(run, steps)
            continue
          }
          if (task.status === 'failed') {
            stepState.status = 'failed'
            stepState.errorMessage = task.errorMessage ?? 'task failed'
            stepState.completedAt = new Date().toISOString()
            failWorkflow(run, `Step "${stepState.name}" failed during recovery`)
            continue
          }
          // Task still running - will be picked up by next poll
        }

        // check_file, delay, check_output: re-evaluated on next poll cycle
        // No special recovery needed - they are wall-clock/fs based

        ctx.logger.info('workflow_engine_recovered_run', {
          runId: run.id,
          stepIndex: run.current_step_index,
          stepType: sanitizeForLog(stepState.type),
        })
      } catch (err) {
        ctx.logger.error('workflow_engine_recovery_error', {
          runId: run.id,
          error: String(err),
        })
      }
    }
  }

  // ── Public API ────────────────────────────────────────────────────────

  return {
    start() {
      if (pollIntervalId) return
      const intervalMs = ctx.config.workflowPollIntervalMs
      currentPollInterval = intervalMs
      ctx.logger.info('workflow_engine_started', { pollIntervalMs: intervalMs })
      recoverRunningWorkflows()
      pollIntervalId = setInterval(poll, intervalMs)
    },

    stop,

    recoverRunningWorkflows,

    /** Reset poll interval to base rate and trigger an immediate poll. */
    wakeUpPoller() {
      if (!pollIntervalId) return // Engine not started
      currentPollInterval = ctx.config.workflowPollIntervalMs
      clearInterval(pollIntervalId)
      pollIntervalId = setInterval(poll, currentPollInterval)
      poll() // Immediate poll
    },
  }
}
