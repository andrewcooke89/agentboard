/**
 * dagEngine.ts -- DAG-based workflow execution engine (Phase 5)
 *
 * Processes workflow runs with system.engine === 'dag'. Handles parallel_group
 * steps with intra-group dependency resolution, session pool integration,
 * and on_failure policies. Called via tick() from the main workflow engine poller.
 *
 * Key design:
 * - steps_state is a flat array: top-level steps + flattened parallel_group children
 * - Children are identified by parentGroup field matching the group step name
 * - The DAG engine skips parentGroup entries during top-level iteration
 * - parallel_group entries delegate to processParallelGroup()
 */

import fs from 'node:fs'
import path from 'node:path'
import type { ServerContext } from './serverContext'
import type { WorkflowStore } from './workflowStore'
import type { TaskStore } from './taskStore'
import type { SessionPool } from './sessionPool'
import type {
  WorkflowRun,
  WorkflowStep,
  StepRunState,
  WorkflowStatus,
} from '../shared/types'
import { substituteVariables, shellEscape } from './workflowSchema'
import type { ParsedWorkflow } from './workflowSchema'
import { sanitizeForLog } from './validators'

// Steps that bypass the session pool (they don't need a tmux session)
const POOL_BYPASS_TYPES = new Set([
  'native_step', 'check_file', 'check_output', 'delay',
  'gemini_offload', 'spec_validate', 'aggregator', 'amendment_check',
])

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'skipped', 'cancelled', 'partial'])

const MAX_NATIVE_STDOUT = 1024 * 1024 // 1 MB

// Predefined action registry (mirrors workflowEngine REQ-16)
const PREDEFINED_ACTIONS: Record<string, string> = {
  git_rebase_from_main: 'git fetch origin main && git rebase origin/main',
  run_tests: 'bun test',
}

// Grace period for termination state machine (M-02)
const TERMINATION_GRACE_MS = 5000

export interface DAGEngine {
  tick(run: WorkflowRun, parsed: ParsedWorkflow): void
}

export function createDAGEngine(
  ctx: ServerContext,
  workflowStore: WorkflowStore,
  taskStore: TaskStore,
  pool: SessionPool | null,
): DAGEngine {

  // ── Helpers ───────────────────────────────────────────────────────────

  function broadcastRunUpdate(run: WorkflowRun): void {
    ctx.broadcast({ type: 'workflow-run-update', run })
  }

  function resolveOutputPath(run: WorkflowRun, relPath: string): string {
    const resolved = path.resolve(run.output_dir, relPath)
    const normalizedBase = path.resolve(run.output_dir)
    if (!resolved.startsWith(normalizedBase)) {
      throw new Error(`Path traversal detected: ${relPath} escapes output directory`)
    }
    return resolved
  }

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

  function failWorkflow(run: WorkflowRun, errorMessage: string): void {
    run.status = 'failed' as WorkflowStatus
    run.error_message = errorMessage
    run.completed_at = new Date().toISOString()
    saveAndBroadcast(run)
    ctx.logger.info('dag_workflow_failed', { runId: run.id, error: sanitizeForLog(errorMessage) })
  }

  function completeWorkflow(run: WorkflowRun): void {
    run.status = 'completed' as WorkflowStatus
    run.completed_at = new Date().toISOString()
    saveAndBroadcast(run)
    ctx.logger.info('dag_workflow_completed', { runId: run.id })
  }

  function getRunTier(run: WorkflowRun, parsed: ParsedWorkflow): number {
    if (run.variables && 'tier' in run.variables) {
      const val = parseInt(run.variables.tier, 10)
      if (!isNaN(val)) return val
    }
    if (parsed.default_tier !== undefined) return parsed.default_tier
    return 1
  }

  function evaluateTierFilter(stepDef: WorkflowStep, runTier: number): string | null {
    if (stepDef.tier_min != null && runTier < stepDef.tier_min) {
      return `Run tier (${runTier}) below step tier_min (${stepDef.tier_min})`
    }
    if (stepDef.tier_max != null && runTier > stepDef.tier_max) {
      return `Run tier (${runTier}) above step tier_max (${stepDef.tier_max})`
    }
    return null
  }

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
        if (refStep.resultContent && refStep.resultContent.includes(condition.contains)) {
          return { met: true }
        }
        return { met: false, reason: `output of "${condition.step}" does not contain "${condition.contains}"` }
      }
      default:
        return { met: false, reason: 'unknown condition type' }
    }
  }

  /** Get effective steps with variable substitution */
  function getEffectiveSteps(run: WorkflowRun, parsed: ParsedWorkflow): WorkflowStep[] | null {
    if (run.variables && Object.keys(run.variables).length > 0) {
      try {
        return substituteVariables(parsed.steps, run.variables)
      } catch {
        return null
      }
    }
    return parsed.steps
  }

  /**
   * Build a lookup from step name -> step definition, including parallel_group children.
   * Top-level steps + all children from all groups.
   */
  function buildStepDefMap(steps: WorkflowStep[]): Map<string, WorkflowStep> {
    const map = new Map<string, WorkflowStep>()
    for (const step of steps) {
      map.set(step.name, step)
      if (step.type === 'parallel_group' && step.children) {
        for (const child of step.children) {
          map.set(child.name, child)
        }
      }
    }
    return map
  }

  /**
   * Build a lookup from step name -> StepRunState index in the flat array.
   */
  function buildStateIndexMap(stepsState: StepRunState[]): Map<string, number> {
    const map = new Map<string, number>()
    for (let i = 0; i < stepsState.length; i++) {
      map.set(stepsState[i].name, i)
    }
    return map
  }

  /**
   * Get the output directory for a child step within a parallel_group.
   * REQ-33: Child outputs use namespaced paths: {output_dir}/{group_name}/{child_name}/
   */
  function getChildOutputDir(run: WorkflowRun, stepState: StepRunState): string {
    if (stepState.parentGroup) {
      return path.join(run.output_dir, stepState.parentGroup, stepState.name)
    }
    return run.output_dir
  }

  /**
   * Check if dependencies of a top-level step (non-child) are met.
   * Top-level steps have implicit sequential dependency on previous top-level step.
   */
  function areTopLevelDependenciesMet(
    run: WorkflowRun,
    stepIndex: number,
    _stateIndexMap: Map<string, number>,
  ): boolean {
    // Find the previous top-level step (skip children with parentGroup)
    let prevTopLevelIndex = -1
    for (let i = stepIndex - 1; i >= 0; i--) {
      if (!run.steps_state[i].parentGroup) {
        prevTopLevelIndex = i
        break
      }
    }
    if (prevTopLevelIndex < 0) return true // First step, no dependencies

    const prevState = run.steps_state[prevTopLevelIndex]
    // REQ-08: Failed/cancelled groups block subsequent steps
    if (prevState.status === 'failed' || prevState.status === 'cancelled') return false
    return TERMINAL_STATUSES.has(prevState.status)
  }

  /**
   * Check if a child step's depends_on are satisfied within its parallel group.
   * Steps with no depends_on can start immediately.
   * Skipped/completed dependencies are satisfied. Failed depends on on_failure policy.
   */
  function areChildDependenciesMet(
    run: WorkflowRun,
    childDef: WorkflowStep,
    stateIndexMap: Map<string, number>,
  ): boolean {
    if (!childDef.depends_on || childDef.depends_on.length === 0) return true

    for (const depName of childDef.depends_on) {
      const depIdx = stateIndexMap.get(depName)
      if (depIdx === undefined) return false
      const depState = run.steps_state[depIdx]
      // Completed or skipped = satisfied
      if (depState.status === 'completed' || depState.status === 'skipped') continue
      // Any other status = not yet satisfied
      return false
    }
    return true
  }

  /**
   * Terminate a running spawn_session child with graceful termination.
   * REQ-39: 8-step termination sequence implemented as a state machine.
   * Each tick() call advances the state machine by checking elapsed time.
   *
   * Phases: signal_sent -> waiting_grace1 -> sigterm_sent -> waiting_grace2 -> killed
   *
   * For cancel_all: writes cancel_requested.yaml signal, then proceeds through grace periods.
   * For fail_fast: skips signal file, proceeds directly to task cancel + SIGTERM.
   *
   * Returns true if termination is complete (step can be marked cancelled).
   */
  function terminateRunningChild(
    childState: StepRunState,
    run: WorkflowRun,
    policy: 'cancel_all' | 'fail_fast' = 'cancel_all',
  ): boolean {
    if (!childState.taskId) return true

    const task = taskStore.getTask(childState.taskId)
    const now = Date.now()

    // Initialize termination if not started
    if (!childState.terminationPhase) {
      if (policy === 'fail_fast') {
        // REQ-22: Skip signal file, cancel API, and first grace period
        // Jump directly to SIGTERM
        if (task && (task as any).tmuxWindow) {
          try {
            const pidResult = Bun.spawnSync(
              ['tmux', 'display-message', '-t', (task as any).tmuxWindow, '-p', '#{pane_pid}'],
              { stdout: 'pipe', stderr: 'pipe' },
            )
            const pid = pidResult.stdout?.toString().trim()
            if (pid) {
              process.kill(parseInt(pid, 10), 'SIGTERM')
            }
          } catch (err) {
            ctx.logger.warn('fail_fast_sigterm_error', {
              runId: run.id,
              step: childState.name,
              error: String(err),
            })
          }
        }
        childState.terminationPhase = 'sigterm_sent'
        childState.terminationStartedAt = new Date().toISOString()
        return false
      }

      // cancel_all: write signal file + cancel API
      try {
        const outputDir = childState.parentGroup
          ? path.join(run.output_dir, childState.parentGroup, childState.name)
          : run.output_dir
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })
        const signalPath = path.join(outputDir, `${childState.name}_cancel_requested.yaml`)
        fs.writeFileSync(signalPath, `cancelled_at: ${new Date().toISOString()}\nreason: sibling_failure\n`)
        if (task && task.status === 'running') {
          taskStore.updateTask(childState.taskId, { status: 'cancelled' })
        }
      } catch (err) {
        ctx.logger.warn('terminate_child_signal_error', {
          runId: run.id,
          step: sanitizeForLog(childState.name),
          error: String(err),
        })
      }
      childState.terminationPhase = 'signal_sent'
      childState.terminationStartedAt = new Date().toISOString()
      return false
    }

    const elapsed = now - new Date(childState.terminationStartedAt!).getTime()

    switch (childState.terminationPhase) {
      case 'signal_sent': {
        // Step 3: Wait 5s grace period
        if (elapsed < TERMINATION_GRACE_MS) return false
        childState.terminationPhase = 'waiting_grace1'
        return false
      }

      case 'waiting_grace1': {
        // Step 4: Send SIGTERM to Claude Code process via tmux (REQ-39)
        if (task && (task as any).tmuxWindow) {
          try {
            const pidResult = Bun.spawnSync(
              ['tmux', 'display-message', '-t', (task as any).tmuxWindow, '-p', '#{pane_pid}'],
              { stdout: 'pipe', stderr: 'pipe' },
            )
            if (pidResult.exitCode === 0) {
              const pid = parseInt(Buffer.from(pidResult.stdout).toString().trim(), 10)
              if (pid > 0) {
                try { process.kill(pid, 'SIGTERM') } catch { /* process may be gone */ }
              }
            }
          } catch { /* best effort */ }
        }
        childState.terminationPhase = 'sigterm_sent'
        childState.terminationStartedAt = new Date().toISOString() // Reset timer for second grace
        return false
      }

      case 'sigterm_sent': {
        // Step 5: Wait 5s
        const elapsedSinceSigterm = now - new Date(childState.terminationStartedAt!).getTime()
        if (elapsedSinceSigterm < TERMINATION_GRACE_MS) return false
        childState.terminationPhase = 'waiting_grace2'
        return false
      }

      case 'waiting_grace2': {
        // Step 6: SIGKILL if still alive
        if (task && (task as any).tmuxWindow) {
          try {
            const pidResult = Bun.spawnSync(
              ['tmux', 'display-message', '-t', (task as any).tmuxWindow, '-p', '#{pane_pid}'],
              { stdout: 'pipe', stderr: 'pipe' },
            )
            if (pidResult.exitCode === 0) {
              const pid = parseInt(Buffer.from(pidResult.stdout).toString().trim(), 10)
              if (pid > 0) {
                try { process.kill(pid, 'SIGKILL') } catch { /* process may be gone */ }
              }
            }
          } catch { /* best effort */ }

          // Step 7: Kill tmux session
          try {
            const check = Bun.spawnSync(['tmux', 'has-session', '-t', (task as any).tmuxWindow], {
              stdout: 'pipe', stderr: 'pipe',
            })
            if (check.exitCode === 0) {
              Bun.spawnSync(['tmux', 'kill-session', '-t', (task as any).tmuxWindow], {
                stdout: 'pipe', stderr: 'pipe',
              })
            }
          } catch { /* session may be gone */ }
        }

        // Step 8: Release pool slot
        releasePoolSlotIfHeld(childState, run)
        childState.terminationPhase = 'killed'
        return true // Termination complete
      }

      case 'killed': {
        return true // Already done
      }

      default:
        return true
    }
  }

  /**
   * Release pool slot for a step if it holds one.
   */
  function releasePoolSlotIfHeld(stepState: StepRunState, run: WorkflowRun): void {
    if (stepState.poolSlotId && pool) {
      const promoted = pool.releaseSlot(stepState.poolSlotId)
      if (promoted) {
        ctx.broadcast({
          type: 'pool_slot_granted',
          runId: run.id,
          stepName: promoted.stepName,
          slotId: promoted.id,
        })
      }
      const status = pool.getStatus()
      ctx.broadcast({
        type: 'pool_status_update',
        active: status.active.length,
        queued: status.queue.length,
        max: status.config.maxSlots,
      })
    }
  }

  /**
   * Start a step: route to type-specific starter.
   * Sets status to 'running' and creates the appropriate task/timer.
   */
  function startStep(
    run: WorkflowRun,
    stepDef: WorkflowStep,
    stepState: StepRunState,
  ): void {
    switch (stepDef.type) {
      case 'spawn_session': {
        const projectPath = stepDef.projectPath ?? run.output_dir
        const allowedRoots = ctx.config.allowedRoots ?? []
        if (allowedRoots.length > 0 && projectPath) {
          const resolved = path.resolve(projectPath)
          const isAllowed = allowedRoots.some(
            (root: string) => resolved.startsWith(root + path.sep) || resolved === root,
          )
          if (!isAllowed) {
            stepState.status = 'failed'
            stepState.errorMessage = `projectPath "${projectPath}" is not under any allowed root`
            stepState.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
            return
          }
        }

        const outputDir = getChildOutputDir(run, stepState)
        if (outputDir !== run.output_dir) {
          try {
            if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })
          } catch { /* best effort */ }
        }
        const prompt = outputDir
          ? `Working directory: ${outputDir}\n\n${stepDef.prompt ?? ''}`
          : (stepDef.prompt ?? '')

        const task = taskStore.createTask({
          projectPath: stepDef.projectPath ?? run.output_dir,
          prompt,
          templateId: null,
          priority: 5,
          status: 'queued',
          maxRetries: stepDef.maxRetries ?? 0,
          timeoutSeconds: stepDef.timeoutSeconds ?? 1800,
        })

        const metadataObj: Record<string, string> = {
          workflow_run_id: run.id,
          workflow_step_name: stepDef.name,
        }
        if (stepDef.agentType) {
          metadataObj.agent_type = stepDef.agentType
        }
        taskStore.updateTask(task.id, { metadata: JSON.stringify(metadataObj) })

        stepState.status = 'running'
        stepState.taskId = task.id
        stepState.startedAt = new Date().toISOString()
        saveAndBroadcast(run)

        ctx.logger.info('dag_step_spawned', {
          runId: run.id,
          step: sanitizeForLog(stepDef.name),
          taskId: task.id,
        })
        break
      }

      case 'delay': {
        stepState.status = 'running'
        stepState.startedAt = new Date().toISOString()
        saveAndBroadcast(run)
        break
      }

      case 'check_file': {
        stepState.status = 'running'
        stepState.startedAt = new Date().toISOString()
        saveAndBroadcast(run)
        break
      }

      case 'check_output': {
        stepState.status = 'running'
        stepState.startedAt = new Date().toISOString()
        saveAndBroadcast(run)
        break
      }

      case 'native_step': {
        stepState.status = 'running'
        stepState.startedAt = new Date().toISOString()
        saveAndBroadcast(run)
        // Native step async execution is handled by monitorStep on next tick
        // For simplicity in DAG mode, native_step transitions to completed/failed synchronously
        // if command is simple. For now, mark as running; monitorStep handles completion.
        break
      }

      default: {
        stepState.status = 'failed'
        stepState.errorMessage = `Unknown step type: ${stepDef.type}`
        stepState.completedAt = new Date().toISOString()
        saveAndBroadcast(run)
      }
    }
  }

  /**
   * Monitor a running step for completion.
   */
  function monitorStep(
    run: WorkflowRun,
    stepDef: WorkflowStep,
    stepState: StepRunState,
  ): void {
    switch (stepDef.type) {
      case 'spawn_session': {
        if (!stepState.taskId) return

        // M-01 / REQ-38: Signal file authority -- check signal files BEFORE task status.
        // Signal files are authoritative over tmux/task state.
        try {
          const outputDir = getChildOutputDir(run, stepState)
          const completedSignalPath = path.join(outputDir, `${stepState.name}_completed.yaml`)
          if (fs.existsSync(completedSignalPath)) {
            const content = fs.readFileSync(completedSignalPath, 'utf-8')
            if (content.includes('verified_completion: true')) {
              stepState.status = 'completed'
              stepState.completedAt = new Date().toISOString()
              collectStepResult(run, stepDef, stepState)
              releasePoolSlotIfHeld(stepState, run)
              saveAndBroadcast(run)
              ctx.logger.info('dag_step_completed_via_signal', {
                runId: run.id,
                step: sanitizeForLog(stepState.name),
              })
              return
            }
          }

          const failedSignalPath = path.join(outputDir, `${stepState.name}_failed.yaml`)
          if (fs.existsSync(failedSignalPath)) {
            const content = fs.readFileSync(failedSignalPath, 'utf-8')
            if (content.includes('verified_completion: true')) {
              // Extract error message from signal file if available
              const errorMatch = content.match(/error:\s*(.+)/)
              const errorMsg = errorMatch ? errorMatch[1].trim() : 'failed via signal file'

              const maxRetries = stepDef.maxRetries ?? 0
              if (stepState.retryCount < maxRetries) {
                stepState.retryCount += 1
                stepState.taskId = null
                stepState.status = 'pending'
                saveAndBroadcast(run)
                return
              }
              stepState.status = 'failed'
              stepState.errorMessage = errorMsg
              stepState.completedAt = new Date().toISOString()
              releasePoolSlotIfHeld(stepState, run)
              saveAndBroadcast(run)
              ctx.logger.info('dag_step_failed_via_signal', {
                runId: run.id,
                step: sanitizeForLog(stepState.name),
              })
              return
            }
          }
        } catch {
          // Signal file read errors are non-fatal; fall through to task status check
        }

        // Fall through to task/tmux status check if no authoritative signal files found
        const task = taskStore.getTask(stepState.taskId!)
        if (!task) {
          stepState.status = 'failed'
          stepState.errorMessage = 'task disappeared'
          stepState.completedAt = new Date().toISOString()
          releasePoolSlotIfHeld(stepState, run)
          saveAndBroadcast(run)
          return
        }
        if (task.status === 'completed') {
          stepState.status = 'completed'
          stepState.completedAt = new Date().toISOString()
          // Collect result file if defined
          collectStepResult(run, stepDef, stepState)
          releasePoolSlotIfHeld(stepState, run)
          saveAndBroadcast(run)
          return
        }
        if (task.status === 'failed') {
          const maxRetries = stepDef.maxRetries ?? 0
          if (stepState.retryCount < maxRetries) {
            stepState.retryCount += 1
            stepState.taskId = null
            stepState.status = 'pending'
            saveAndBroadcast(run)
            return
          }
          stepState.status = 'failed'
          stepState.errorMessage = task.errorMessage ?? 'task failed'
          stepState.completedAt = new Date().toISOString()
          releasePoolSlotIfHeld(stepState, run)
          saveAndBroadcast(run)
          return
        }
        // Still running - wait
        break
      }

      case 'delay': {
        if (!stepState.startedAt) return
        const elapsed = (Date.now() - new Date(stepState.startedAt).getTime()) / 1000
        const delaySec = stepDef.seconds ?? 0
        if (elapsed >= delaySec) {
          stepState.status = 'completed'
          stepState.completedAt = new Date().toISOString()
          saveAndBroadcast(run)
        }
        break
      }

      case 'check_file': {
        const filePath = resolveOutputPath(run, stepDef.path ?? '')
        if (fs.existsSync(filePath)) {
          if (stepDef.max_age_seconds != null) {
            try {
              const stat = fs.statSync(filePath)
              const ageSec = (Date.now() - stat.mtimeMs) / 1000
              if (ageSec <= stepDef.max_age_seconds) {
                stepState.status = 'completed'
                stepState.completedAt = new Date().toISOString()
                saveAndBroadcast(run)
                return
              }
            } catch { /* keep waiting */ }
          } else {
            stepState.status = 'completed'
            stepState.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
            return
          }
        }
        // Check timeout
        if (stepState.startedAt && stepDef.timeoutSeconds) {
          const elapsed = (Date.now() - new Date(stepState.startedAt).getTime()) / 1000
          if (elapsed > stepDef.timeoutSeconds) {
            stepState.status = 'failed'
            stepState.errorMessage = `file not found within ${stepDef.timeoutSeconds}s: ${stepDef.path}`
            stepState.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
          }
        }
        break
      }

      case 'check_output': {
        const refStepName = stepDef.step ?? ''
        const refState = run.steps_state.find((s) => s.name === refStepName)
        if (!refState) {
          stepState.status = 'failed'
          stepState.errorMessage = `referenced step "${refStepName}" not found`
          stepState.completedAt = new Date().toISOString()
          saveAndBroadcast(run)
          return
        }
        // Check result content from the referenced step
        if (refState.resultContent && refState.resultContent.includes(stepDef.contains ?? '')) {
          stepState.status = 'completed'
          stepState.completedAt = new Date().toISOString()
          saveAndBroadcast(run)
          return
        }
        // Check timeout
        if (stepState.startedAt && stepDef.timeoutSeconds) {
          const elapsed = (Date.now() - new Date(stepState.startedAt).getTime()) / 1000
          if (elapsed > stepDef.timeoutSeconds) {
            stepState.status = 'failed'
            stepState.errorMessage = `output check timed out after ${stepDef.timeoutSeconds}s`
            stepState.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
          }
        }
        break
      }

      case 'native_step': {
        // M-05: Execute native_step synchronously using Bun.spawnSync
        // Mirrors legacy engine processNativeStep but synchronous for DAG tick()

        // Resolve command from action or command field
        let cmd: string | null = null
        if (stepDef.action) {
          const resolved = PREDEFINED_ACTIONS[stepDef.action]
          if (!resolved) {
            stepState.status = 'failed'
            stepState.errorMessage = `unknown predefined action: "${stepDef.action}"`
            stepState.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
            break
          }
          cmd = resolved
        } else if (stepDef.command) {
          cmd = stepDef.command
        } else {
          stepState.status = 'failed'
          stepState.errorMessage = 'native_step requires command or action'
          stepState.completedAt = new Date().toISOString()
          saveAndBroadcast(run)
          break
        }

        // Append shell-escaped args
        if (stepDef.args && stepDef.args.length > 0) {
          cmd = cmd + ' ' + stepDef.args.map(a => shellEscape(a)).join(' ')
        }

        // Build env
        const spawnEnv: Record<string, string> = { ...process.env as Record<string, string> }
        if (stepDef.env) {
          for (const [k, v] of Object.entries(stepDef.env)) {
            spawnEnv[k] = v
          }
        }

        // Determine cwd (REQ-02 parity: project_path fallback)
        const cwd = stepDef.working_dir || run.variables?.project_path || run.output_dir
        try {
          if (!fs.existsSync(cwd)) {
            fs.mkdirSync(cwd, { recursive: true })
          }
        } catch { /* best-effort */ }

        const captureStderr = stepDef.capture_stderr !== false
        const successCodes = stepDef.success_codes ?? [0]
        const timeoutMs = (stepDef.timeoutSeconds ?? 300) * 1000

        ctx.logger.info('dag_native_step_started', {
          runId: run.id,
          step: sanitizeForLog(stepDef.name),
          command: sanitizeForLog(cmd),
        })

        try {
          const result = Bun.spawnSync(['sh', '-c', cmd], {
            cwd,
            env: spawnEnv,
            stdout: 'pipe',
            stderr: captureStderr ? 'pipe' : 'ignore',
            timeout: timeoutMs,
          })

          const exitCode = result.exitCode ?? -1
          let stdout = result.stdout ? Buffer.from(result.stdout).toString('utf-8') : ''
          if (stdout.length > MAX_NATIVE_STDOUT) stdout = stdout.slice(0, MAX_NATIVE_STDOUT)

          let stderr = ''
          if (captureStderr && result.stderr) {
            stderr = Buffer.from(result.stderr).toString('utf-8')
          }

          // Read output_path file if specified (REQ-06 parity)
          let stepResult = stdout
          if (stepDef.output_path) {
            try {
              const outputFullPath = resolveOutputPath(run, stepDef.output_path)
              if (fs.existsSync(outputFullPath)) {
                const fileContent = fs.readFileSync(outputFullPath, 'utf-8')
                stepResult = fileContent.length > MAX_NATIVE_STDOUT
                  ? fileContent.slice(0, MAX_NATIVE_STDOUT)
                  : fileContent
              }
            } catch { /* fall through to stdout */ }
          }

          if (result.success === false && result.exitCode === undefined) {
            // Timeout / signal kill
            stepState.status = 'failed'
            stepState.errorMessage = `command timed out after ${stepDef.timeoutSeconds ?? 300}s`
            if (stderr) stepState.errorMessage += `\nstderr: ${stderr.slice(0, 500)}`
            stepState.completedAt = new Date().toISOString()
          } else if (successCodes.includes(exitCode)) {
            stepState.status = 'completed'
            stepState.completedAt = new Date().toISOString()
            stepState.resultContent = stepResult
            if (stderr) stepState.resultContent += '\nstderr: ' + stderr
            stepState.resultCollected = true

            ctx.logger.info('dag_native_step_completed', {
              runId: run.id,
              step: sanitizeForLog(stepDef.name),
              exitCode,
            })
          } else {
            stepState.status = 'failed'
            stepState.errorMessage = `exit code ${exitCode} not in success_codes [${successCodes.join(',')}]`
            if (stderr) stepState.errorMessage += `\nstderr: ${stderr.slice(0, 500)}`
            stepState.completedAt = new Date().toISOString()
          }

          // Handle retry on failure
          if (stepState.status === 'failed') {
            const maxRetries = stepDef.maxRetries ?? 0
            if (stepState.retryCount < maxRetries) {
              stepState.retryCount += 1
              stepState.status = 'pending'
              stepState.errorMessage = null
              stepState.completedAt = null
              ctx.logger.info('dag_native_step_retry', {
                runId: run.id,
                step: sanitizeForLog(stepDef.name),
                retryCount: stepState.retryCount,
              })
            }
          }
        } catch (err) {
          stepState.status = 'failed'
          stepState.errorMessage = `spawn error: ${String(err)}`
          stepState.completedAt = new Date().toISOString()
          ctx.logger.error('dag_native_step_error', {
            runId: run.id,
            step: sanitizeForLog(stepDef.name),
            error: String(err),
          })
        }

        saveAndBroadcast(run)
        break
      }
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
      if (!fs.existsSync(fullPath)) return
      const stat = fs.statSync(fullPath)
      if (stat.size > 1024 * 1024) return // 1MB limit
      stepState.resultContent = fs.readFileSync(fullPath, 'utf-8')
      stepState.resultCollected = true
    } catch {
      // Best effort
    }
  }

  // ── Review Loop Processing (REQ-40) ─────────────────────────────────

  /**
   * Process a review_loop child within a parallel_group.
   * Reserves ONE pool slot for the entire duration. Producer and reviewer
   * sub-steps share this single slot sequentially. The slot is only released
   * when the review_loop completes (PASS verdict, max_iterations, or failure).
   *
   * State machine per tick:
   * - pending → request pool slot, if granted start producer (reviewSubStep='producer')
   * - running + reviewSubStep='producer' → monitor producer task, on completion start reviewer
   * - running + reviewSubStep='reviewer' → monitor reviewer task, check verdict
   *   - PASS → complete review_loop, release slot
   *   - FAIL/REVISE + iterations remaining → loop back to producer
   *   - max_iterations reached → complete review_loop, release slot
   * - failed → release slot
   */
  function processReviewLoopChild(
    run: WorkflowRun,
    childState: StepRunState,
    childDef: WorkflowStep,
    runTier: number,
    parsed: ParsedWorkflow,
  ): void {
    const maxIter = childDef.max_iterations ?? 3

    // ── Pending: request pool slot and start producer ──
    if (childState.status === 'pending') {
      // Initialize review loop tracking
      if (childState.reviewIteration === undefined) {
        childState.reviewIteration = 0
      }
      childState.reviewSubStep = null
      childState.reviewVerdict = null

      // Request pool slot
      if (pool && parsed.system?.session_pool) {
        const slot = pool.requestSlot({
          runId: run.id,
          stepName: childDef.name,
          tier: runTier,
        })
        childState.poolSlotId = slot.id
        if (slot.status === 'queued') {
          childState.status = 'queued'
          saveAndBroadcast(run)
          ctx.broadcast({
            type: 'step_queued',
            runId: run.id,
            stepName: childDef.name,
            queuePosition: pool.getStatus().queue.length,
          })
          return
        }
        ctx.broadcast({
          type: 'pool_slot_granted',
          runId: run.id,
          stepName: childDef.name,
          slotId: slot.id,
        })
      }

      // Start producer
      childState.status = 'running'
      childState.startedAt = new Date().toISOString()
      childState.reviewSubStep = 'producer'
      childState.reviewIteration = 1
      startStep(run, childDef.producer!, childState)
      ctx.logger.info('dag_review_loop_started', {
        runId: run.id,
        step: sanitizeForLog(childDef.name),
        iteration: 1,
        subStep: 'producer',
      })
      return
    }

    // ── Queued: waiting for pool slot ──
    if (childState.status === 'queued' && childState.poolSlotId) {
      const slot = pool?.getSlot(childState.poolSlotId)
      if (slot && slot.status === 'active') {
        ctx.broadcast({
          type: 'pool_slot_granted',
          runId: run.id,
          stepName: childDef.name,
          slotId: slot.id,
        })
        // Start producer
        childState.status = 'running'
        childState.startedAt = new Date().toISOString()
        childState.reviewSubStep = 'producer'
        childState.reviewIteration = 1
        startStep(run, childDef.producer!, childState)
        ctx.logger.info('dag_review_loop_started', {
          runId: run.id,
          step: sanitizeForLog(childDef.name),
          iteration: 1,
          subStep: 'producer',
        })
      }
      return
    }

    // ── Running: monitor current sub-step ──
    if (childState.status === 'running') {
      if (!childState.taskId) return

      const task = taskStore.getTask(childState.taskId)
      if (!task) {
        childState.status = 'failed'
        childState.errorMessage = 'task disappeared'
        childState.completedAt = new Date().toISOString()
        releasePoolSlotIfHeld(childState, run)
        saveAndBroadcast(run)
        return
      }

      // Still running - wait
      if (task.status !== 'completed' && task.status !== 'failed') return

      // Task failed
      if (task.status === 'failed') {
        childState.status = 'failed'
        childState.errorMessage = `${childState.reviewSubStep} failed: ${task.errorMessage ?? 'unknown error'}`
        childState.completedAt = new Date().toISOString()
        releasePoolSlotIfHeld(childState, run)
        saveAndBroadcast(run)
        ctx.logger.info('dag_review_loop_failed', {
          runId: run.id,
          step: sanitizeForLog(childDef.name),
          iteration: childState.reviewIteration,
          subStep: childState.reviewSubStep,
          error: sanitizeForLog(task.errorMessage ?? 'unknown'),
        })
        return
      }

      // Task completed
      if (childState.reviewSubStep === 'producer') {
        // Collect result from producer
        collectStepResult(run, childDef.producer!, childState)

        // Transition to reviewer
        childState.reviewSubStep = 'reviewer'
        childState.taskId = null
        startStep(run, childDef.reviewer!, childState)
        ctx.logger.info('dag_review_loop_transition', {
          runId: run.id,
          step: sanitizeForLog(childDef.name),
          iteration: childState.reviewIteration,
          from: 'producer',
          to: 'reviewer',
        })
        return
      }

      if (childState.reviewSubStep === 'reviewer') {
        // Collect result from reviewer to check verdict
        collectStepResult(run, childDef.reviewer!, childState)

        // Determine verdict from result content
        const verdict = extractVerdict(childState.resultContent)
        childState.reviewVerdict = verdict

        ctx.logger.info('dag_review_loop_verdict', {
          runId: run.id,
          step: sanitizeForLog(childDef.name),
          iteration: childState.reviewIteration,
          verdict,
        })

        if (verdict === 'PASS') {
          // Review passed - complete the loop
          childState.status = 'completed'
          childState.completedAt = new Date().toISOString()
          releasePoolSlotIfHeld(childState, run)
          saveAndBroadcast(run)
          return
        }

        // Check if max iterations reached
        if ((childState.reviewIteration ?? 0) >= maxIter) {
          childState.status = 'completed'
          childState.completedAt = new Date().toISOString()
          childState.reviewVerdict = `max_iterations_reached (last: ${verdict})`
          releasePoolSlotIfHeld(childState, run)
          saveAndBroadcast(run)
          ctx.logger.info('dag_review_loop_max_iterations', {
            runId: run.id,
            step: sanitizeForLog(childDef.name),
            iterations: childState.reviewIteration,
          })
          return
        }

        // Loop back to producer for another iteration
        childState.reviewIteration = (childState.reviewIteration ?? 0) + 1
        childState.reviewSubStep = 'producer'
        childState.taskId = null
        childState.resultContent = null
        childState.resultCollected = false
        startStep(run, childDef.producer!, childState)
        ctx.logger.info('dag_review_loop_iteration', {
          runId: run.id,
          step: sanitizeForLog(childDef.name),
          iteration: childState.reviewIteration,
          subStep: 'producer',
        })
        return
      }
    }
  }

  /**
   * Extract verdict from reviewer result content.
   * Looks for "verdict: PASS" or "verdict: FAIL" or "verdict: REVISE" in result.
   * Defaults to 'FAIL' if no verdict found.
   */
  function extractVerdict(content: string | null): string {
    if (!content) return 'FAIL'
    const match = content.match(/verdict:\s*(PASS|FAIL|REVISE)/i)
    if (match) return match[1].toUpperCase()
    // Also check for just the word on its own line
    if (/^PASS$/m.test(content)) return 'PASS'
    return 'FAIL'
  }

  // ── Parallel Group Processing ────────────────────────────────────────

  function processParallelGroup(
    run: WorkflowRun,
    groupDef: WorkflowStep,
    groupState: StepRunState,
    stepDefMap: Map<string, WorkflowStep>,
    stateIndexMap: Map<string, number>,
    runTier: number,
    parsed: ParsedWorkflow,
  ): void {
    // Find all children in steps_state
    const childStates: { state: StepRunState; index: number; def: WorkflowStep }[] = []
    for (let i = 0; i < run.steps_state.length; i++) {
      const s = run.steps_state[i]
      if (s.parentGroup === groupDef.name) {
        const def = stepDefMap.get(s.name)
        if (def) childStates.push({ state: s, index: i, def })
      }
    }

    if (childStates.length === 0) {
      // No children found - mark group as completed
      groupState.status = 'completed'
      groupState.completedAt = new Date().toISOString()
      saveAndBroadcast(run)
      return
    }

    const onFailure = groupDef.on_failure ?? 'cancel_all'

    // Check if any child has failed and handle on_failure policy
    const failedChildren = childStates.filter(c => c.state.status === 'failed')
    if (failedChildren.length > 0 && (onFailure === 'fail_fast' || onFailure === 'cancel_all')) {
      // M-02: Termination state machine -- advance in-progress terminations and initiate new ones
      let terminationsInProgress = false
      for (const child of childStates) {
        if (TERMINAL_STATUSES.has(child.state.status)) continue

        // REQ-39: For running spawn_session tasks under cancel_all, use termination state machine
        if (onFailure === 'cancel_all' && child.state.status === 'running' && child.def.type === 'spawn_session') {
          const done = terminateRunningChild(child.state, run, 'cancel_all')
          if (!done) {
            terminationsInProgress = true
            continue // Don't mark as cancelled yet -- state machine still in progress
          }
        } else if (onFailure === 'fail_fast' && child.state.status === 'running' && child.def.type === 'spawn_session') {
          const done = terminateRunningChild(child.state, run, 'fail_fast')
          if (!done) {
            terminationsInProgress = true
            continue
          }
        }

        // For non-spawn_session or completed terminations, mark cancelled immediately
        child.state.status = 'cancelled'
        child.state.completedAt = new Date().toISOString()
        releasePoolSlotIfHeld(child.state, run)
      }

      // If terminations still in progress, save state and wait for next tick
      if (terminationsInProgress) {
        saveAndBroadcast(run)
        return
      }

      groupState.status = 'failed'
      const failedNames = failedChildren.map(c => c.state.name)
      groupState.errorMessage = `parallel_group '${groupDef.name}': ${failedNames.length} of ${childStates.length} children failed. Failed: [${failedNames.join(', ')}].`
      groupState.completedAt = new Date().toISOString()
      saveAndBroadcast(run)
      return
    }

    // REQ-15: continue_others -- skip dependent steps whose dependency failed
    if (failedChildren.length > 0 && onFailure === 'continue_others') {
      for (const child of childStates) {
        if (child.state.status !== 'pending') continue
        if (!child.def.depends_on || child.def.depends_on.length === 0) continue
        for (const depName of child.def.depends_on) {
          const depIdx = stateIndexMap.get(depName)
          if (depIdx === undefined) continue
          const depState = run.steps_state[depIdx]
          if (depState.status === 'failed') {
            child.state.status = 'skipped'
            child.state.skippedReason = `dependency '${depName}' failed`
            child.state.completedAt = new Date().toISOString()
            releasePoolSlotIfHeld(child.state, run)
            break
          }
        }
      }
      saveAndBroadcast(run)
    }

    // Check if all children are terminal
    const allTerminal = childStates.every(c => TERMINAL_STATUSES.has(c.state.status))
    if (allTerminal) {
      const anyFailed = childStates.some(c => c.state.status === 'failed')
      if (anyFailed && onFailure === 'continue_others') {
        // REQ-15: partial status when some failed under continue_others
        groupState.status = 'partial'
        const failedInGroup = childStates.filter(c => c.state.status === 'failed')
        const failedGroupNames = failedInGroup.map(c => c.state.name)
        groupState.errorMessage = `parallel_group '${groupDef.name}': ${failedGroupNames.length} of ${childStates.length} children failed. Failed: [${failedGroupNames.join(', ')}].`
        groupState.completedAt = new Date().toISOString()
      } else if (anyFailed) {
        groupState.status = 'failed'
        groupState.errorMessage = 'One or more child steps failed'
        groupState.completedAt = new Date().toISOString()
      } else {
        groupState.status = 'completed'
        groupState.completedAt = new Date().toISOString()
      }
      saveAndBroadcast(run)
      return
    }

    // Mark group as running if still pending
    if (groupState.status === 'pending') {
      groupState.status = 'running'
      groupState.startedAt = new Date().toISOString()
      saveAndBroadcast(run)
    }

    // Group timeout check (REQ-31/32)
    if (groupState.status === 'running' && groupState.startedAt) {
      let effectiveTimeout = groupDef.timeoutSeconds
      if (effectiveTimeout === undefined) {
        // REQ-32: default = sum of child timeouts
        const childTimeouts = (groupDef.children ?? [])
          .map(c => c.timeoutSeconds).filter((t): t is number => t !== undefined)
        if (childTimeouts.length > 0) {
          effectiveTimeout = childTimeouts.reduce((sum, t) => sum + t, 0)
        }
      }
      if (effectiveTimeout !== undefined) {
        const elapsed = (Date.now() - new Date(groupState.startedAt).getTime()) / 1000
        if (elapsed > effectiveTimeout) {
          // Timeout: cancel pending, terminate running, fail group
          for (const child of childStates) {
            if (child.state.status === 'pending' || child.state.status === 'queued') {
              child.state.status = 'cancelled'
              child.state.completedAt = new Date().toISOString()
              releasePoolSlotIfHeld(child.state, run)
            } else if (child.state.status === 'running' && child.def.type === 'spawn_session') {
              terminateRunningChild(child.state, run, 'fail_fast')
              child.state.status = 'cancelled'
              child.state.completedAt = new Date().toISOString()
              releasePoolSlotIfHeld(child.state, run)
            } else if (child.state.status === 'running') {
              child.state.status = 'cancelled'
              child.state.completedAt = new Date().toISOString()
            }
          }
          groupState.status = 'failed'
          groupState.errorMessage = `parallel_group '${groupDef.name}' exceeded timeout (${effectiveTimeout}s)`
          groupState.completedAt = new Date().toISOString()
          saveAndBroadcast(run)
          return
        }
      }
    }

    // Process each non-terminal child
    const maxParallel = groupDef.max_parallel ?? Infinity
    let runningSessionCount = childStates.filter(
      c => (c.state.status === 'running' || c.state.status === 'queued') && !POOL_BYPASS_TYPES.has(c.def.type)
    ).length

    for (const child of childStates) {
      if (TERMINAL_STATUSES.has(child.state.status)) continue

      // REQ-40: review_loop children manage their own pool slot and sub-step lifecycle
      if (child.def.type === 'review_loop') {
        // Check intra-group dependencies before starting
        if (child.state.status === 'pending') {
          if (!areChildDependenciesMet(run, child.def, stateIndexMap)) continue

          // Tier filtering
          const tierSkip = evaluateTierFilter(child.def, runTier)
          if (tierSkip) {
            child.state.status = 'skipped'
            child.state.skippedReason = tierSkip
            child.state.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
            continue
          }

          // Condition evaluation
          if (child.def.condition) {
            const condResult = evaluateCondition(run, child.def.condition)
            if (!condResult.met) {
              child.state.status = 'skipped'
              child.state.skippedReason = condResult.reason ?? 'condition not met'
              child.state.completedAt = new Date().toISOString()
              saveAndBroadcast(run)
              continue
            }
          }
        }
        processReviewLoopChild(run, child.state, child.def, runTier, parsed)
        continue
      }

      if (child.state.status === 'pending') {
        // Check intra-group dependencies
        if (!areChildDependenciesMet(run, child.def, stateIndexMap)) continue

        // Tier filtering
        const tierSkip = evaluateTierFilter(child.def, runTier)
        if (tierSkip) {
          child.state.status = 'skipped'
          child.state.skippedReason = tierSkip
          child.state.completedAt = new Date().toISOString()
          saveAndBroadcast(run)
          continue
        }

        // Condition evaluation
        if (child.def.condition) {
          const condResult = evaluateCondition(run, child.def.condition)
          if (!condResult.met) {
            child.state.status = 'skipped'
            child.state.skippedReason = condResult.reason ?? 'condition not met'
            child.state.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
            continue
          }
        }

        // Pool slot for spawn_session within a group
        if (child.def.type === 'spawn_session' && pool && parsed.system?.session_pool) {
          // REQ-25/26/27: max_parallel enforcement
          if (runningSessionCount >= maxParallel) continue

          const slot = pool.requestSlot({
            runId: run.id,
            stepName: child.def.name,
            tier: runTier,
          })
          child.state.poolSlotId = slot.id
          if (slot.status === 'queued') {
            child.state.status = 'queued'
            runningSessionCount++
            saveAndBroadcast(run)
            ctx.broadcast({
              type: 'step_queued',
              runId: run.id,
              stepName: child.def.name,
              queuePosition: pool.getStatus().queue.length,
            })
            continue
          }
          runningSessionCount++
          ctx.broadcast({
            type: 'pool_slot_granted',
            runId: run.id,
            stepName: child.def.name,
            slotId: slot.id,
          })
        }

        // Start the child step
        startStep(run, child.def, child.state)
        continue
      }

      // Handle queued children (waiting for pool slot)
      if (child.state.status === 'queued' && child.state.poolSlotId) {
        const slot = pool?.getSlot(child.state.poolSlotId)
        if (slot && slot.status === 'active') {
          ctx.broadcast({
            type: 'pool_slot_granted',
            runId: run.id,
            stepName: child.def.name,
            slotId: slot.id,
          })
          startStep(run, child.def, child.state)
        }
        continue
      }

      // Monitor running children
      if (child.state.status === 'running') {
        monitorStep(run, child.def, child.state)
      }
    }
  }

  // ── Main Tick ─────────────────────────────────────────────────────────

  function tick(run: WorkflowRun, parsed: ParsedWorkflow): void {
    const steps = getEffectiveSteps(run, parsed)
    if (!steps) {
      failWorkflow(run, 'Cannot parse workflow steps')
      return
    }

    const stepDefMap = buildStepDefMap(steps)
    const stateIndexMap = buildStateIndexMap(run.steps_state)
    const runTier = getRunTier(run, parsed)

    // Check for completion: all top-level steps + children in terminal state
    const allTerminal = run.steps_state.every(s => TERMINAL_STATUSES.has(s.status))
    if (allTerminal) {
      // REQ-08: Only check top-level steps for workflow failure
      const anyFailed = run.steps_state.some(s => !s.parentGroup && s.status === 'failed')
      if (anyFailed) {
        failWorkflow(run, 'One or more steps failed')
      } else {
        completeWorkflow(run)
      }
      return
    }

    // Process each top-level step (skip children -- they're handled by their group)
    for (let i = 0; i < run.steps_state.length; i++) {
      const stepState = run.steps_state[i]
      if (!stepState) continue

      // Skip children -- they're processed by processParallelGroup
      if (stepState.parentGroup) continue

      // Skip terminal states
      if (TERMINAL_STATUSES.has(stepState.status)) continue

      const stepDef = stepDefMap.get(stepState.name)
      if (!stepDef) continue

      // Handle parallel_group
      if (stepDef.type === 'parallel_group') {
        processParallelGroup(run, stepDef, stepState, stepDefMap, stateIndexMap, runTier, parsed)
        continue
      }

      // For top-level non-group steps: check implicit sequential dependency
      if (stepState.status === 'pending') {
        if (!areTopLevelDependenciesMet(run, i, stateIndexMap)) continue

        // Tier filtering
        const tierSkip = evaluateTierFilter(stepDef, runTier)
        if (tierSkip) {
          stepState.status = 'skipped'
          stepState.skippedReason = tierSkip
          stepState.completedAt = new Date().toISOString()
          saveAndBroadcast(run)
          continue
        }

        // Condition evaluation
        if (stepDef.condition) {
          const condResult = evaluateCondition(run, stepDef.condition)
          if (!condResult.met) {
            stepState.status = 'skipped'
            stepState.skippedReason = condResult.reason ?? 'condition not met'
            stepState.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
            continue
          }
        }

        // Pool slot for spawn_session
        if (stepDef.type === 'spawn_session' && pool && parsed.system?.session_pool) {
          if (!POOL_BYPASS_TYPES.has(stepDef.type)) {
            const slot = pool.requestSlot({
              runId: run.id,
              stepName: stepDef.name,
              tier: runTier,
            })
            stepState.poolSlotId = slot.id
            if (slot.status === 'queued') {
              stepState.status = 'queued'
              saveAndBroadcast(run)
              ctx.broadcast({
                type: 'step_queued',
                runId: run.id,
                stepName: stepDef.name,
                queuePosition: pool.getStatus().queue.length,
              })
              continue
            }
            ctx.broadcast({
              type: 'pool_slot_granted',
              runId: run.id,
              stepName: stepDef.name,
              slotId: slot.id,
            })
          }
        }

        // Start the step
        startStep(run, stepDef, stepState)
      }

      // Handle queued steps
      if (stepState.status === 'queued' && stepState.poolSlotId) {
        const slot = pool?.getSlot(stepState.poolSlotId)
        if (slot && slot.status === 'active') {
          ctx.broadcast({
            type: 'pool_slot_granted',
            runId: run.id,
            stepName: stepDef.name,
            slotId: slot.id,
          })
          startStep(run, stepDef, stepState)
        }
        continue
      }

      // Monitor running steps
      if (stepState.status === 'running') {
        monitorStep(run, stepDef, stepState)
      }
    }
  }

  return { tick }
}
