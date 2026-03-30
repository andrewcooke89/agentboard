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
  StepCondition,
  WorkflowStatus,
  CleanupAction,
  CleanupState,
} from '../shared/types'
import { substituteVariables, shellEscape, applyDefaults, parseWorkflowYAML } from './workflowSchema'
import type { ParsedWorkflow } from './workflowSchema'
import { sanitizeForLog } from './validators'
import { validateSpec } from './specValidator'
import {
  ensureSignalDir,
  checkStepSignals,
  createSyntheticSignal,
  writeResolutionFile,
  validateSignalAuthority,
  readSignalFile,
  archiveStaleSignals,
  archiveConsumedSignal,
} from './signalProtocol'
import type { SignalFile, SignalMatch } from './signalProtocol'
import {
  readReviewerVerdict,
  writeReviewLoopSummary,
  normalizeVerdict,
} from './reviewLoopProtocol'
import type { ReviewLoopSummary, IterationSummary } from './reviewLoopProtocol'
import yaml from 'js-yaml'
import {
  parseAmendmentSignal,
  shouldAutoReview,
  shouldEscalateToHuman,
  isFundamental,
  buildHandlerPrompt,
  buildResumePrompt,
  readResolutionFile,
  type AmendmentConfig,
  type AmendmentSignal,
} from './amendmentHandler'
import { callGemini, type GeminiRequest, type GeminiResponse, type BackoffConfig } from './geminiClient'
import { processAggregatorStep } from './aggregatorHandler'
import { executeReview } from './reviewRouter'
import type { ReviewResult, ReviewRoutingConfig } from './reviewRouter'
import { classifyWorkOrder } from './complexityClassifier'
import { extractReviewRoutingConfig } from './projectProfile'
import { evaluateCondition as evaluateConditionExpr, evaluateExpression, type ConditionContext } from './conditionEvaluator'
import { expandPerWorkUnit, type ExpansionContext } from './perWorkUnitEngine'
import { prepareContextBriefing, createDefaultBriefingConfig } from './contextLibrarian'
import type { ConsumerProfile } from './contextLibrarian'
import { loadProjectProfileRaw } from './projectProfile'
import {
  createBranchIsolationStore,
  initBranchIsolation,
  cleanupWorktree,
  cleanupExpiredWorktrees,
} from './branchIsolation'
import {
  createOutputInvalidationStore,
  trackOutputHash,
  invalidateDownstream,
  buildDependencyGraph,
  checkCircuitBreaker,
  computeHash,
} from './outputInvalidation'
import type { OutputInvalidationStore } from './outputInvalidation'

// Steps that bypass the session pool (they don't need a tmux session)
const POOL_BYPASS_TYPES = new Set([
  'native_step', 'check_file', 'check_output', 'delay',
  'gemini_offload', 'spec_validate', 'aggregator', 'amendment_check',
  'reconcile-spec', 'review',
])

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'skipped', 'cancelled', 'partial', 'signal_timeout', 'signal_error', 'paused_escalated', 'paused_human', 'paused_starvation'])

const MAX_NATIVE_STDOUT = 1024 * 1024 // 1 MB

// Predefined action registry (mirrors workflowEngine REQ-16)
const PREDEFINED_ACTIONS: Record<string, string> = {
  git_rebase_from_main: 'git fetch origin main && git rebase origin/main',
  run_tests: 'bun test',
  'prepare-context': '__handled_internally__',  // Phase 20: handled by contextLibrarian
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

  // Branch isolation store for git worktree management (lazy-initialized to avoid
  // requiring a real DB at construction time — tests mock ctx.db as empty object)
  let _branchIsolationStore: ReturnType<typeof createBranchIsolationStore> | null = null
  function getBranchIsolationStore() {
    if (!_branchIsolationStore) {
      _branchIsolationStore = createBranchIsolationStore(ctx.db.db)
    }
    return _branchIsolationStore
  }

  // Output invalidation store (lazy-initialized, same pattern as branch isolation)
  let _outputInvalidationStore: OutputInvalidationStore | null = null
  function getOutputInvalidationStore(): OutputInvalidationStore {
    if (!_outputInvalidationStore) {
      _outputInvalidationStore = createOutputInvalidationStore(ctx.db.db)
    }
    return _outputInvalidationStore
  }

  // Cache dependency graphs per run ID (step name -> downstream step names)
  const depGraphCache = new Map<string, Map<string, string[]>>()

  // Tick counter for periodic expired-worktree cleanup (A4)
  let tickCount = 0
  const CLEANUP_TICK_INTERVAL = 100

  // Track project paths seen for periodic worktree cleanup
  const seenProjectPaths = new Set<string>()

  // REQ-14/REQ-44: Track processed signal files per step to prevent re-processing.
  // Key: "{runId}:{stepName}", Value: Set of processed file paths.
  const processedSignalFiles = new Map<string, Set<string>>()

  // ROBUSTNESS-2 (REQ-37): In-memory re-entrance guard for processReviewLoop.
  // Key: "{runId}:{stepName}". NOT persisted to DB to avoid stale locks.
  const reviewLoopProcessing = new Set<string>()

  // P1-13: Re-entrancy guard for tick() — prevents overlapping executions.
  let tickInProgress = false

  // P0-4: Track consecutive tick exceptions per run to detect stuck runs.
  const tickExceptionCounts = new Map<string, number>()

  function getProcessedSignals(runId: string, stepName: string): Set<string> {
    const key = `${runId}:${stepName}`
    let set = processedSignalFiles.get(key)
    if (!set) {
      set = new Set<string>()
      processedSignalFiles.set(key, set)
    }
    return set
  }

  function generateIterationId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * P-1 (REQ-25): Load review_loop checkpoint extensions from signal-checkpoint files.
   * Scans the run's signal directory for checkpoint files containing review_loop extensions
   * (iteration count, previous feedback) for crash recovery.
   */
  function loadCheckpointExtensions(runDir: string, _stepName: string): { iteration?: number; previous_feedback?: string } | null {
    try {
      const signalDir = path.join(runDir, 'signals')
      if (!fs.existsSync(signalDir)) return null
      const files = fs.readdirSync(signalDir).filter(f => f.startsWith('checkpoint-') && (f.endsWith('.yaml') || f.endsWith('.yml')))
      for (const file of files) {
        const filePath = path.join(signalDir, file)
        const signal = readSignalFile(filePath)
        if (signal?.checkpoint?.extensions?.review_loop) {
          const ext = signal.checkpoint.extensions.review_loop as { iteration?: number; previous_feedback?: string }
          if (ext && typeof ext === 'object') {
            return ext
          }
        }
      }
      return null
    } catch {
      return null
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  function broadcastRunUpdate(run: WorkflowRun): void {
    ctx.broadcast({ type: 'workflow-run-update', run })
  }

  function resolveOutputPath(run: WorkflowRun, relPath: string): string {
    // Template-resolve the path first (e.g. {{ output_dir }}/file.yaml)
    const templateResolved = resolveTemplateVars(relPath, run)

    // If the resolved path is absolute, use it directly (user-specified output_dir)
    if (path.isAbsolute(templateResolved)) {
      return templateResolved
    }

    // Relative paths resolve against run.output_dir with traversal check
    const resolved = path.resolve(run.output_dir, templateResolved)
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
      pipelineCleanupState: run.pipelineCleanupState,
    })
    if (updated) broadcastRunUpdate(updated)
  }

  function failWorkflow(run: WorkflowRun, errorMessage: string, parsed?: ParsedWorkflow): void {
    run.status = 'failed' as WorkflowStatus
    run.error_message = errorMessage
    run.completed_at = new Date().toISOString()
    saveAndBroadcast(run)
    ctx.logger.info('dag_workflow_failed', { runId: run.id, error: sanitizeForLog(errorMessage) })

    // A3: Clean up worktree on failure
    if (run.variables?._worktree_path) {
      const origPath = run.variables._original_project_path || run.variables.project_path || ''
      cleanupWorktree(run.id, getBranchIsolationStore(), origPath, false).catch(err => {
        ctx.logger.warn('worktree_cleanup_error', { runId: run.id, error: String(err) })
      })
    }

    // Phase 15: Pipeline-level on_error cleanup (REQ-27)
    if (parsed?.on_error && parsed.on_error.length > 0) {
      runCleanupActions(run, parsed.on_error, 'pipeline').catch(err => {
        ctx.logger.warn('pipeline_cleanup_error', { runId: run.id, error: String(err) })
      })
    }
  }

  function completeWorkflow(run: WorkflowRun): void {
    // A3: Clean up worktree on successful completion
    if (run.variables?._worktree_path) {
      const origPath = run.variables._original_project_path || run.variables.project_path || ''
      cleanupWorktree(run.id, getBranchIsolationStore(), origPath, true).catch(err => {
        ctx.logger.warn('worktree_cleanup_error', { runId: run.id, error: String(err) })
      })
    }

    run.status = 'completed' as WorkflowStatus
    run.completed_at = new Date().toISOString()
    saveAndBroadcast(run)
    ctx.logger.info('dag_workflow_completed', { runId: run.id })
  }

  // Phase 15: Run cleanup actions for a step or pipeline (REQ-24, REQ-27)
  async function runCleanupActions(
    run: WorkflowRun,
    actions: CleanupAction[],
    level: 'step' | 'pipeline',
    stepState?: StepRunState,
  ): Promise<void> {
    const cleanupState: CleanupState = {
      level,
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
      errorMessage: null,
    }

    if (level === 'step' && stepState) {
      stepState.cleanupState = cleanupState
    } else {
      run.pipelineCleanupState = cleanupState
    }

    saveAndBroadcast(run)
    ctx.broadcast({
      type: 'cleanup_started',
      runId: run.id,
      stepName: stepState?.name ?? '',
      level,
    })

    // Simple string-level variable substitution for cleanup commands
    const subst = (template: string): string => {
      const vars = run.variables ?? {}
      return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => vars[key] ?? '')
    }

    let hasError = false
    for (const action of actions) {
      try {
        const workDir = action.working_dir
          ? subst(action.working_dir)
          : run.output_dir
        const cmd = subst(action.command)
        const timeout = (action.timeoutSeconds ?? 30) * 1000

        const proc = Bun.spawn(['sh', '-c', cmd], {
          cwd: workDir,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env },
        })

        const timer = setTimeout(() => proc.kill(), timeout)
        await proc.exited
        clearTimeout(timer)

        if (proc.exitCode !== 0) {
          ctx.logger.warn('cleanup_action_failed', {
            runId: run.id,
            stepName: stepState?.name,
            level,
            command: cmd.slice(0, 200),
            exitCode: proc.exitCode,
          })
          hasError = true
        }
      } catch (err) {
        ctx.logger.warn('cleanup_action_error', {
          runId: run.id,
          stepName: stepState?.name,
          level,
          error: err instanceof Error ? err.message : String(err),
        })
        hasError = true
      }
    }

    cleanupState.status = hasError ? 'failed' : 'completed'
    cleanupState.completedAt = new Date().toISOString()
    if (hasError) {
      cleanupState.errorMessage = 'One or more cleanup actions failed (see logs)'
    }

    ctx.broadcast({
      type: 'cleanup_completed',
      runId: run.id,
      stepName: stepState?.name ?? '',
      level,
      success: !hasError,
    })

    saveAndBroadcast(run)
  }

  function getRunTier(run: WorkflowRun, parsed: ParsedWorkflow): number {
    if (run.variables && 'tier' in run.variables) {
      const val = parseInt(run.variables.tier, 10)
      if (!isNaN(val)) return val
    }
    if (parsed.defaults?.tier !== undefined) return parsed.defaults.tier
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
    parsed: ParsedWorkflow,
  ): { met: boolean; reason?: string } {
    if (!condition) return { met: true }
    switch (condition.type) {
      case 'file_exists': {
        // file_exists conditions may reference absolute paths outside the output dir
        const rawCondPath = condition.path
        const filePath = path.isAbsolute(rawCondPath) ? rawCondPath : resolveOutputPath(run, rawCondPath)
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
      case 'expression': {
        // P1-1: Wire conditionEvaluator for expression-type conditions
        const runTier = getRunTier(run, parsed)
        const stepOutputs: Record<string, Record<string, unknown>> = {}
        for (const ss of run.steps_state) {
          // Always expose step status so expressions like "step_name.status == 'completed'" work
          const base: Record<string, unknown> = { status: ss.status }
          if (ss.resultContent) {
            try {
              Object.assign(base, { _raw: ss.resultContent, ...JSON.parse(ss.resultContent) })
            } catch {
              base._raw = ss.resultContent
            }
          }
          stepOutputs[ss.name] = base
        }
        // Phase 25: Load project profile for expression condition evaluation
        let projectProfile: Record<string, unknown> | undefined
        const projectPath = run.variables?.project_path
        if (projectPath) {
          try {
            projectProfile = loadProjectProfileRaw(projectPath)
          } catch (e) { void e; }
        }
        const condCtx: ConditionContext = {
          tier: runTier,
          stepOutputs,
          variables: run.variables ?? {},
          projectProfile,
        }
        // Phase 25: Resolve template variables in condition expression before evaluation
        // e.g. file_exists("{{ run_dir }}/compiler-analysis/pre-impl-ref.txt")
        const resolvedExpr = resolveTemplateVarsInExpr(condition.expr, run, projectProfile)
        const resolvedCondition: StepCondition = { type: 'expression', expr: resolvedExpr }
        const result = evaluateConditionExpr(resolvedCondition, condCtx)
        return { met: result, reason: result ? undefined : `expression "${condition.expr}" evaluated to false` }
      }
      default:
        return { met: false, reason: 'unknown condition type' }
    }
  }

  /** Get effective steps with variable substitution */
  function getEffectiveSteps(run: WorkflowRun, parsed: ParsedWorkflow): WorkflowStep[] | null {
    let steps = parsed.steps
    if (parsed.defaults) {
      steps = applyDefaults(steps, parsed.defaults)
    }
    if (run.variables && Object.keys(run.variables).length > 0) {
      try {
        return substituteVariables(steps, run.variables)
      } catch {
        return null
      }
    }
    return steps
  }

  /**
   * Build a lookup from step name -> step definition, including parallel_group children.
   * Top-level steps + all children from all groups.
   */
  function buildStepDefMap(steps: WorkflowStep[]): Map<string, WorkflowStep> {
    const map = new Map<string, WorkflowStep>()
    for (const step of steps) {
      map.set(step.name, step)
      if (step.type === 'parallel_group' && step.steps) {
        for (const child of step.steps) {
          map.set(child.name, child)
        }
      }
    }
    return map
  }

  /**
   * CRITICAL #1: Ensure per_work_unit children exist in runtime stepDefMap.
   * Child states are pre-expanded at run creation, but parsed YAML does not include
   * those synthetic child names. Rebuild child definitions from parent config here.
   */
  function hydratePerWorkUnitChildDefs(run: WorkflowRun, stepDefMap: Map<string, WorkflowStep>): void {
    const seenContainers = new Set<string>()
    for (const state of run.steps_state) {
      if (state.parentGroup) seenContainers.add(state.parentGroup)
    }

    for (const containerName of seenContainers) {
      const containerState = run.steps_state.find((s) => s.name === containerName)
      if (!containerState?.isPerWorkUnitContainer) continue

      const containerDef = stepDefMap.get(containerName)
      if (!containerDef?.per_work_unit) continue

      const expansionCtx: ExpansionContext = {
        runId: run.id,
        outputDir: run.output_dir,
        defaultAgent: containerDef.agent,
        variables: run.variables,
      }

      let expanded: ReturnType<typeof expandPerWorkUnit>
      try {
        expanded = expandPerWorkUnit(containerDef, expansionCtx)
      } catch (err) {
        // parsed is not in scope here (hydratePerWorkUnitChildDefs is called before tick parsing).
        // Pass undefined — failWorkflow will skip pipeline-level cleanup hooks gracefully.
        failWorkflow(run, `Failed to parse work unit manifest: ${err instanceof Error ? err.message : String(err)}`, undefined)
        return
      }
      for (const item of expanded) {
        if (!stepDefMap.has(item.name)) {
          stepDefMap.set(item.name, {
            ...item.step,
            name: item.name,
            ...(item.dependsOnExpanded && item.dependsOnExpanded.length > 0
              ? { depends_on: item.dependsOnExpanded }
              : {}),
          })
        }
      }
    }
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
    stateIndexMap: Map<string, number>,
    stepDefMap?: Map<string, WorkflowStep>,
  ): boolean {
    const stepState = run.steps_state[stepIndex]
    const stepDef = stepDefMap?.get(stepState.name)

    // Phase 25: If step has explicit depends_on, use those instead of positional ordering
    if (stepDef?.depends_on && stepDef.depends_on.length > 0) {
      for (const depName of stepDef.depends_on) {
        const depIdx = stateIndexMap.get(depName)
        if (depIdx === undefined) continue // Unknown dep — skip (may be optional)
        const depState = run.steps_state[depIdx]
        // Completed, skipped, or partial = satisfied (P1-17: partial counts as done)
        if (depState.status === 'completed' || depState.status === 'skipped' || depState.status === 'partial') continue
        // Paused statuses block dependents — these require human intervention or resolution
        // before the pipeline can proceed. paused_human (review escalation), paused_starvation
        // (pool exhaustion), paused_amendment (spec concern), paused_exploration (needs input),
        // and paused_escalated all mean the step has NOT successfully completed.
        // Failed/terminal-error dependency blocks this step
        if (depState.status === 'failed' || depState.status === 'cancelled' || depState.status === 'signal_timeout' || depState.status === 'signal_error') return false
        // Any other status (pending, running, queued) = not yet satisfied
        return false
      }
      return true
    }

    // No explicit depends_on: fall back to positional (previous top-level step must be terminal)
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
      // Completed, skipped, or cancelled = satisfied (P1-18: cancelled unblocks under continue_others)
      if (depState.status === 'completed' || depState.status === 'skipped' || depState.status === 'cancelled') continue
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
   * Build a prompt for a spawn_session step from its agent/description/inputs/outputs fields.
   * Resolution order: 1) stepDef.prompt  2) agent definition file  3) synthesized from fields
   */
  function buildAgentPrompt(stepDef: WorkflowStep, run: WorkflowRun): string {
    // 1. If step has explicit prompt field, use it directly
    if (stepDef.prompt) return stepDef.prompt

    // 2. Try loading agent definition file from project .workflow/agents/{agent}.md
    const projectPath = stepDef.projectPath ?? run.variables?.project_path ?? run.output_dir
    if (stepDef.agent && projectPath) {
      const agentFile = path.join(projectPath, '.workflow', 'agents', `${stepDef.agent}.md`)
      try {
        if (fs.existsSync(agentFile)) {
          const agentDef = fs.readFileSync(agentFile, 'utf-8')
          if (agentDef.trim()) {
            // Append agent_prompt_override if present
            if (stepDef.agent_prompt_override) {
              return `${agentDef}\n\n${stepDef.agent_prompt_override}`
            }
            return agentDef
          }
        }
      } catch { /* fall through to synthesized prompt */ }
    }

    // 3. Synthesize prompt from agent name + description + inputs/outputs
    const parts: string[] = []

    if (stepDef.agent) {
      parts.push(`You are the "${stepDef.agent}" agent.`)
    }

    if (stepDef.description) {
      parts.push(`\nTask: ${stepDef.description}`)
    }

    if (stepDef.agent_prompt_override) {
      parts.push(`\n${stepDef.agent_prompt_override}`)
    }

    if (stepDef.posture) {
      parts.push(`\nPosture: ${stepDef.posture}`)
    }

    // Include inputs by type: context/spec (content injected), reference (paths only)
    if (stepDef.inputs && Array.isArray(stepDef.inputs)) {
      const contentInputs: string[] = []
      const referenceInputs: string[] = []

      for (const inp of stepDef.inputs) {
        if (typeof inp === 'string') {
          // String inputs default to reference type (backward compatible)
          referenceInputs.push(inp)
          continue
        }

        if (inp && typeof inp === 'object') {
          const inputObj = inp as Record<string, unknown>
          const path = inputObj.path ? String(inputObj.path) : null
          const type = String(inputObj.type ?? 'reference')
          const label = inputObj.label ? String(inputObj.label) : null

          if (!path) continue

          if (type === 'context' || type === 'spec') {
            // Read and inject content
            const resolvedPath = resolveOutputPath(run, path)
            if (fs.existsSync(resolvedPath)) {
              const content = fs.readFileSync(resolvedPath, 'utf-8')
              const header = label || type
              contentInputs.push(`## ${header}\n${content}`)
            } else {
              // File doesn't exist, note it in references
              referenceInputs.push(`${path} (not found)`)
            }
          } else {
            // reference type (default) - just list the path
            referenceInputs.push(path)
          }
        }
      }

      // Inject content inputs first (more important context)
      if (contentInputs.length > 0) {
        parts.push(`\n${contentInputs.join('\n\n')}`)
      }

      // Finally reference inputs (just paths)
      if (referenceInputs.length > 0) {
        parts.push(`\nInput files:\n${referenceInputs.map(p => `- ${p}`).join('\n')}`)
      }
    }

    // Include expected output paths
    if (stepDef.outputs && Array.isArray(stepDef.outputs)) {
      const outputPaths = stepDef.outputs.map(o => String(o))
      parts.push(`\nExpected outputs:\n${outputPaths.map(p => `- ${p}`).join('\n')}`)
    }

    return parts.join('\n') || stepDef.name
  }

  /**
   * Release pool slot for a step if it holds one.
   */
  function releasePoolSlotIfHeld(stepState: StepRunState, run: WorkflowRun): void {
    if (stepState.poolSlotId && pool) {
      const promoted = pool.releaseSlot(stepState.poolSlotId)
      stepState.poolSlotId = null // P0-7: clear to prevent double-release
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
        const projectPath = stepDef.projectPath ?? run.variables?.project_path ?? run.output_dir
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
            releasePoolSlotIfHeld(stepState, run) // P1-10: release slot on security check failure
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

        // Phase 7: Signal directory setup
        if (stepDef.signal_protocol && stepDef.signal_dir) {
          try {
            const rawSignalDir = stepDef.signal_dir
            const signalDir = resolveTemplateVars(stepDef.signal_dir, run)
            ctx.logger.info('dag_signal_dir_resolve', {
              runId: run.id,
              step: sanitizeForLog(stepDef.name),
              rawSignalDir,
              resolvedSignalDir: signalDir,
            })
            ensureSignalDir(signalDir)
            // Archive stale signals from previous cancelled/failed runs
            const archived = archiveStaleSignals(signalDir)
            if (archived > 0) {
              ctx.logger.info('dag_stale_signals_archived', {
                runId: run.id,
                step: sanitizeForLog(stepDef.name),
                signalDir,
                archivedCount: archived,
              })
            }
            ctx.logger.info('dag_signal_dir_created', {
              runId: run.id,
              step: sanitizeForLog(stepDef.name),
              signalDir,
            })
          } catch (err) {
            stepState.status = 'failed'
            stepState.errorMessage = `Failed to create signal directory: ${err instanceof Error ? err.message : String(err)}`
            stepState.completedAt = new Date().toISOString()
            releasePoolSlotIfHeld(stepState, run)
            saveAndBroadcast(run)
            return
          }
        }
        const rawPrompt = buildAgentPrompt(stepDef, run)
        let prompt = outputDir
          ? `Working directory: ${outputDir}\n\n${rawPrompt}`
          : rawPrompt

        // Inject signal-writing instructions for non-command steps with signal_protocol
        if (stepDef.signal_protocol && stepDef.signal_dir && !stepDef.command) {
          const signalDir = resolveTemplateVars(stepDef.signal_dir, run)
          prompt += `\n\n## Signal Protocol — IMPORTANT\nWhen you have completed your task, you MUST write a YAML signal file to indicate completion.\n\nWrite this file: ${signalDir}/${stepDef.name}_completed.yaml\n\nUse atomic write (write to a temp file in ${signalDir}/.tmp/ then rename).\n\nThe file MUST contain exactly:\n\`\`\`yaml\nversion: 1\nsignal_type: completed\ntimestamp: "${new Date().toISOString()}"\nagent: claude\nstep_name: "${stepDef.name}"\nrun_id: "${run.id}"\ncheckpoint: null\n\`\`\`\n\nIf you encounter an error and cannot complete, write the same file but with \`signal_type: error\` instead.\n`
        }

        const task = taskStore.createTask({
          projectPath: stepDef.projectPath ?? run.variables?.project_path ?? run.output_dir,
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
        if (stepDef.model) {
          metadataObj.model = stepDef.model
        }
        if (stepDef.command) {
          metadataObj.command = stepDef.command
        }
        taskStore.updateTask(task.id, { metadata: JSON.stringify(metadataObj) })

        stepState.status = 'running'
        stepState.taskId = task.id
        stepState.startedAt = new Date().toISOString()

        // Phase 7: Initialize signal protocol state
        if (stepDef.signal_protocol) {
          stepState.signalProtocol = true
          stepState.signalDir = (stepDef.signal_dir ? resolveTemplateVars(stepDef.signal_dir, run) : null)
          stepState.signalTimeoutSeconds = stepDef.signal_timeout_seconds ?? (stepDef.timeoutSeconds ?? 300) + 60
          stepState.verifiedCompletion = true // default, set false if synthetic later
          stepState.status = 'waiting_signal'
        }

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

      case 'spec_validate': {
        stepState.status = 'running'
        stepState.startedAt = new Date().toISOString()
        saveAndBroadcast(run)
        break
      }

      case 'amendment_check': {
        stepState.status = 'running'
        stepState.startedAt = new Date().toISOString()
        saveAndBroadcast(run)
        break
      }

      case 'reconcile-spec': {
        stepState.status = 'running'
        stepState.startedAt = new Date().toISOString()
        saveAndBroadcast(run)
        break
      }

      // Phase 22: gemini_offload — no pool slot, completes via geminiClient
      case 'gemini_offload': {
        stepState.status = 'running'
        stepState.startedAt = new Date().toISOString()
        saveAndBroadcast(run)

        // Execute Gemini call asynchronously — attach .catch() to prevent silent failures
        executeGeminiOffload(run, stepDef, stepState).catch(err => {
          const errorMsg = err instanceof Error ? err.message : String(err)
          stepState.status = 'failed'
          stepState.errorMessage = `gemini_offload uncaught: ${errorMsg}`
          stepState.completedAt = new Date().toISOString()
          saveAndBroadcast(run)
        })
        break
      }

      // Phase 23: aggregator — collects findings from multiple input steps
      case 'aggregator': {
        stepState.status = 'running'
        stepState.startedAt = new Date().toISOString()
        saveAndBroadcast(run)

        // Build step definition map from run's steps_state (which contains all step definitions)
        const stepDefMap = new Map<string, WorkflowStep>()
        // Use the workflow definition to get step definitions
        const workflow = workflowStore.getWorkflow(run.workflow_id)
        if (workflow) {
          const parsedWorkflow = parseWorkflowYAML(workflow.yaml_content)
          if (parsedWorkflow.valid && parsedWorkflow.workflow) {
            const steps = getEffectiveSteps(run, parsedWorkflow.workflow) ?? []
            for (const s of steps) {
              stepDefMap.set(s.name, s)
              // Also include parallel_group children
              if (s.type === 'parallel_group' && s.steps) {
                for (const child of s.steps) {
                  stepDefMap.set(child.name, child)
                }
              }
            }
          }
        }

        // Execute aggregation
        const result = processAggregatorStep(run, stepDef, stepState, stepDefMap)

        if (result.complete) {
          stepState.status = 'completed'
          stepState.completedAt = new Date().toISOString()
          if (result.result) {
            stepState.resultContent = JSON.stringify(result.result)
            stepState.resultCollected = true
            trackStepOutputHash(run, stepState)
          }
          saveAndBroadcast(run)
          ctx.logger.info('dag_aggregator_completed', {
            runId: run.id,
            step: sanitizeForLog(stepDef.name),
            verdict: result.result?.verdict,
            findingsCount: result.result?.stats.after_evidence_filter,
          })
        } else {
          stepState.status = 'failed'
          stepState.errorMessage = result.error ?? 'aggregation failed'
          stepState.completedAt = new Date().toISOString()
          saveAndBroadcast(run)
          ctx.logger.error('dag_aggregator_failed', {
            runId: run.id,
            step: sanitizeForLog(stepDef.name),
            error: sanitizeForLog(result.error ?? 'unknown'),
          })
        }
        break
      }

      // Phase 21: human_gate — pause for human approval
      case 'human_gate': {
        stepState.status = 'paused_human'
        stepState.startedAt = new Date().toISOString()
        saveAndBroadcast(run)
        ctx.broadcast({
          type: 'step_paused',
          runId: run.id,
          stepName: stepDef.name,
          reason: 'human_gate: explicit human approval required',
        })
        break
      }

      // Phase 26: review — automated code review via Gemini L1/L2 pipeline
      case 'review': {
        stepState.status = 'running'
        stepState.startedAt = new Date().toISOString()
        saveAndBroadcast(run)

        // Execute review asynchronously — attach .catch() to prevent silent failures
        executeReviewStep(run, stepDef, stepState).catch(err => {
          const errorMsg = err instanceof Error ? err.message : String(err)
          stepState.status = 'failed'
          stepState.errorMessage = `review uncaught: ${errorMsg}`
          stepState.completedAt = new Date().toISOString()
          saveAndBroadcast(run)
        })
        break
      }

      default: {
        stepState.status = 'failed'
        stepState.errorMessage = `Unknown step type: ${stepDef.type}`
        stepState.completedAt = new Date().toISOString()
        releasePoolSlotIfHeld(stepState, run) // P1-16: release slot on unknown step type
        saveAndBroadcast(run)
      }
    }
  }

  /**
   * Execute a gemini_offload step asynchronously.
   * Phase 22: Calls Gemini API and writes output to file.
   */
  async function executeGeminiOffload(
    run: WorkflowRun,
    stepDef: WorkflowStep,
    stepState: StepRunState,
  ): Promise<void> {
    try {
      // Build prompt from template and input files
      let prompt = stepDef.prompt_template ?? ''

      // First, handle label-based substitution from inputs array (if present)
      // This supports the format: inputs: [{ path: "...", label: "name" }]
      if (stepDef.inputs && Array.isArray(stepDef.inputs)) {
        for (const inp of stepDef.inputs) {
          if (inp && typeof inp === 'object' && 'path' in inp && 'label' in inp) {
            const inputObj = inp as Record<string, unknown>
            const inputPath = resolveOutputPath(run, String(inputObj.path))
            const label = String(inputObj.label)
            if (fs.existsSync(inputPath) && label) {
              const content = fs.readFileSync(inputPath, 'utf-8')
              prompt = prompt.replace(`{{${label}}}`, content)
            }
          }
        }
      }

      // Then, handle direct input_files (basename substitution for backward compatibility)
      if (stepDef.input_files && stepDef.input_files.length > 0) {
        for (const inputFile of stepDef.input_files) {
          const inputPath = resolveOutputPath(run, inputFile)
          if (fs.existsSync(inputPath)) {
            const content = fs.readFileSync(inputPath, 'utf-8')
            prompt = prompt.replace(`{{${inputFile}}}`, content)
            // Also support basename without path
            const basename = path.basename(inputFile)
            prompt = prompt.replace(`{{${basename}}}`, content)
          }
        }
      }

      // Substitute workflow variables
      if (run.variables) {
        for (const [key, value] of Object.entries(run.variables)) {
          prompt = prompt.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), value)
        }
      }

      // Call Gemini API
      const geminiRequest: GeminiRequest = {
        model: stepDef.model ?? 'gemini-1.5-flash',
        prompt,
        maxTokens: stepDef.max_tokens,
        temperature: stepDef.temperature,
      }

      // P1-3: Pass retry_backoff from step config to geminiClient
      const backoffConfig: BackoffConfig | undefined = stepDef.retry_backoff
      const response: GeminiResponse = await callGemini(geminiRequest, { backoff: backoffConfig })

      // Handle skipped (no API key or rate limited)
      if (response.skipped) {
        stepState.status = 'skipped'
        stepState.skippedReason = response.reason ?? 'gemini_offload skipped'
        stepState.completedAt = new Date().toISOString()
        stepState.resultContent = `gemini_offload skipped: ${response.reason}`
        stepState.resultCollected = true
        trackStepOutputHash(run, stepState)
        saveAndBroadcast(run)
        ctx.logger.info('dag_gemini_offload_skipped', {
          runId: run.id,
          step: sanitizeForLog(stepDef.name),
          reason: response.reason,
        })
        return
      }

      // Handle error
      if (response.error) {
        stepState.status = 'failed'
        stepState.errorMessage = response.error
        stepState.completedAt = new Date().toISOString()
        saveAndBroadcast(run)
        ctx.logger.error('dag_gemini_offload_error', {
          runId: run.id,
          step: sanitizeForLog(stepDef.name),
          error: sanitizeForLog(response.error),
        })
        return
      }

      // Write output to file if specified
      if (stepDef.output_file && response.content) {
        const outputPath = resolveOutputPath(run, stepDef.output_file)
        const outputDir = path.dirname(outputPath)
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true })
        }
        fs.writeFileSync(outputPath, response.content, 'utf-8')
      }

      // Mark step as completed
      stepState.status = 'completed'
      stepState.completedAt = new Date().toISOString()
      stepState.resultContent = response.content ?? null
      stepState.resultFile = stepDef.output_file ?? null
      stepState.resultCollected = true
      trackStepOutputHash(run, stepState)
      saveAndBroadcast(run)

      ctx.logger.info('dag_gemini_offload_completed', {
        runId: run.id,
        step: sanitizeForLog(stepDef.name),
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        latencyMs: response.latencyMs,
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      stepState.status = 'failed'
      stepState.errorMessage = errorMsg
      stepState.completedAt = new Date().toISOString()
      saveAndBroadcast(run)
      ctx.logger.error('dag_gemini_offload_exception', {
        runId: run.id,
        step: sanitizeForLog(stepDef.name),
        error: sanitizeForLog(errorMsg),
      })
    }
  }

  /**
   * Execute a review step asynchronously.
   * Phase 26: Runs L1/L2 review pipeline via Gemini based on complexity classification.
   */
  async function executeReviewStep(
    run: WorkflowRun,
    stepDef: WorkflowStep,
    stepState: StepRunState,
  ): Promise<void> {
    try {
      // Resolve target_path from step definition or variables
      let targetPath = stepDef.target_path ?? ''
      if (!targetPath && run.variables?.target_path) {
        targetPath = run.variables.target_path
      }
      // Resolve template variables (e.g. {{ spec_path }})
      if (targetPath.includes('{{')) {
        targetPath = resolveTemplateVars(targetPath, run)
      }
      if (!targetPath) {
        stepState.status = 'failed'
        stepState.errorMessage = 'review step requires target_path'
        stepState.completedAt = new Date().toISOString()
        saveAndBroadcast(run)
        return
      }

      // Resolve work_order from step definition or variables
      let workOrder: Record<string, unknown> | null = stepDef.work_order ?? null
      if (!workOrder && run.variables?.work_order) {
        try {
          workOrder = JSON.parse(run.variables.work_order)
        } catch {
          workOrder = null
        }
      }

      // Classify complexity
      const classification = classifyWorkOrder(
        workOrder as { complexity?: 'simple' | 'medium' | 'complex' | 'atomic'; estimated_complexity?: string } | null,
      )

      // Load review routing config from project profile or step definition
      let reviewRoutingConfig: ReviewRoutingConfig | null = null
      if (stepDef.review_config) {
        reviewRoutingConfig = stepDef.review_config as ReviewRoutingConfig
      } else {
        const profilePath = run.variables?.project_path || run.output_dir
        if (profilePath) {
          try {
            const profile = loadProjectProfileRaw(profilePath)
            reviewRoutingConfig = extractReviewRoutingConfig(profile)
          } catch {
            // No profile — use defaults
          }
        }
      }

      ctx.logger.info('dag_review_starting', {
        runId: run.id,
        step: sanitizeForLog(stepDef.name),
        targetPath,
        complexity: classification.complexity,
      })

      // Execute the review pipeline
      const reviewResult: ReviewResult = await executeReview(
        classification,
        reviewRoutingConfig,
        {
          target_path: targetPath,
          spec_path: stepDef.spec_path,
          changes_summary: workOrder?.changes_summary as string | undefined,
          run_dir: run.output_dir,
        },
      )

      // Store result
      stepState.resultContent = JSON.stringify(reviewResult)
      stepState.resultCollected = true
      trackStepOutputHash(run, stepState)

      // Set status based on verdict
      switch (reviewResult.verdict) {
        case 'PASS':
          stepState.status = 'completed'
          break
        case 'FAIL':
          stepState.status = 'failed'
          stepState.errorMessage = reviewResult.feedback
          break
        case 'NEEDS_FIX':
        case 'CONCERN':
          stepState.status = 'completed'
          stepState.completedWithWarning = true
          break
      }

      stepState.completedAt = new Date().toISOString()
      saveAndBroadcast(run)

      ctx.logger.info('dag_review_completed', {
        runId: run.id,
        step: sanitizeForLog(stepDef.name),
        verdict: reviewResult.verdict,
        passed: reviewResult.passed,
        model: reviewResult.model_used,
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)

      // Graceful degradation: if Gemini is unavailable, complete with warning
      if (errorMsg.includes('no_api_key') || errorMsg.includes('rate_limit')) {
        stepState.status = 'completed'
        stepState.completedWithWarning = true
        stepState.resultContent = JSON.stringify({
          passed: true,
          verdict: 'PASS',
          feedback: `Review skipped: ${errorMsg}`,
          model_used: 'none',
        })
        stepState.resultCollected = true
        stepState.completedAt = new Date().toISOString()
        saveAndBroadcast(run)
        ctx.logger.info('dag_review_skipped', {
          runId: run.id,
          step: sanitizeForLog(stepDef.name),
          reason: sanitizeForLog(errorMsg),
        })
        return
      }

      stepState.status = 'failed'
      stepState.errorMessage = errorMsg
      stepState.completedAt = new Date().toISOString()
      saveAndBroadcast(run)
      ctx.logger.error('dag_review_exception', {
        runId: run.id,
        step: sanitizeForLog(stepDef.name),
        error: sanitizeForLog(errorMsg),
      })
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

        // Phase 7: Signal protocol path
        if (stepState.signalProtocol && stepState.signalDir) {
          monitorSignalProtocolStep(run, stepDef, stepState)
          return
        }

        // Legacy path (existing code from lines 550-639, unchanged)
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
        // check_file allows absolute paths (e.g. spec files outside output dir)
        const rawPath = stepDef.path ?? ''
        const filePath = path.isAbsolute(rawPath) ? rawPath : resolveOutputPath(run, rawPath)
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
        // If referenced step was skipped or failed, fail this check immediately
        if (refState.status === 'skipped' || refState.status === 'failed') {
          stepState.status = 'failed'
          stepState.errorMessage = `referenced step "${refStepName}" ${refState.status}: ${refState.skippedReason ?? refState.errorMessage ?? ''}`
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
        if (stepDef.action === 'prepare-context') {
          // Phase 20: Context librarian integration (REQ-01..REQ-26)
          stepState.status = 'running'
          stepState.startedAt = stepState.startedAt ?? new Date().toISOString()
          saveAndBroadcast(run)
          const profile = (stepDef.env?.CONSUMER_PROFILE ?? 'implementor') as ConsumerProfile
          const config = {
            ...createDefaultBriefingConfig(profile),
            token_budget: parseInt(stepDef.env?.TOKEN_BUDGET ?? '8000', 10),
            sources: (stepDef.env?.CONTEXT_SOURCES ?? 'codebase,project_facts').split(','),
          }
          // working_dir and PROJECT_PATH may be absolute paths outside the output dir
          const rawOutputDir = stepDef.working_dir ?? run.output_dir
          const outputDir = path.isAbsolute(rawOutputDir) ? rawOutputDir : resolveOutputPath(run, rawOutputDir)
          const rawProjectDir = stepDef.env?.PROJECT_PATH ?? run.output_dir
          const projectDir = path.isAbsolute(rawProjectDir) ? rawProjectDir : resolveOutputPath(run, rawProjectDir)
          prepareContextBriefing(config, outputDir, projectDir).then(briefingPath => {
            stepState.status = 'completed'
            stepState.resultContent = briefingPath
            stepState.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
          }).catch(err => {
            stepState.status = 'failed'
            stepState.errorMessage = err instanceof Error ? err.message : String(err)
            stepState.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
          })
          break
        }
        // Phase 25: checks array support — run multiple sub-checks with pause/fail policies
        if (stepDef.checks && stepDef.checks.length > 0) {
          stepState.status = 'running'
          stepState.startedAt = stepState.startedAt ?? new Date().toISOString()
          saveAndBroadcast(run)

          const checkResults: Array<{ name: string; passed: boolean; message?: string }> = []
          let paused = false

          // Build condition context for check condition evaluation
          const condCtx = buildCheckConditionContext(run)
          // Load project profile for template variable resolution in check commands
          const checksProjectProfile = condCtx.projectProfile

          for (const check of stepDef.checks) {
            // Evaluate check-level condition (skip if condition is false)
            if (check.condition) {
              const condMet = evaluateExpressionForChecks(check.condition, condCtx)
              if (!condMet) {
                checkResults.push({ name: check.name, passed: true, message: 'skipped (condition not met)' })
                ctx.logger.info('dag_check_skipped', {
                  runId: run.id,
                  step: sanitizeForLog(stepDef.name),
                  check: check.name,
                  condition: check.condition,
                })
                continue
              }
            }

            // Expression-only checks (check: field, no command) — evaluate inline
            if (check.check && !check.command) {
              const exprResult = evaluateExpressionForChecks(check.check, condCtx)
              if (!exprResult) {
                const failAction = check.on_failure?.action ?? 'fail'
                const failMsg = check.on_failure?.message ?? `check "${check.name}" expression failed: ${check.check}`
                checkResults.push({ name: check.name, passed: false, message: failMsg })
                ctx.logger.warn('dag_check_expr_failed', {
                  runId: run.id,
                  step: sanitizeForLog(stepDef.name),
                  check: check.name,
                  expression: check.check,
                })
                if (failAction === 'pause') {
                  paused = true
                  continue // pause collects all failures, doesn't stop
                } else {
                  // fail — stop immediately
                  stepState.status = 'failed'
                  stepState.errorMessage = failMsg
                  stepState.completedAt = new Date().toISOString()
                  saveAndBroadcast(run)
                  break
                }
              } else {
                checkResults.push({ name: check.name, passed: true })
              }
              continue
            }

            // Command-based check — run the command
            if (!check.command) {
              checkResults.push({ name: check.name, passed: true, message: 'no command or check expression' })
              continue
            }

            const rawCwd = stepDef.working_dir || run.variables?.project_path || run.output_dir
            const checkCwd = resolveTemplateVars(rawCwd, run, checksProjectProfile)
            try {
              if (!fs.existsSync(checkCwd)) {
                fs.mkdirSync(checkCwd, { recursive: true })
              }
            } catch { /* best-effort */ }

            const checkEnv: Record<string, string> = { ...process.env as Record<string, string> }
            if (stepDef.env) {
              for (const [k, v] of Object.entries(stepDef.env)) {
                checkEnv[k] = resolveTemplateVars(v, run, checksProjectProfile)
              }
            }

            // Phase 25: Resolve template variables in check command
            const resolvedCheckCmd = resolveTemplateVars(check.command, run, checksProjectProfile)
            try {
              const checkResult = Bun.spawnSync(['sh', '-c', resolvedCheckCmd], {
                cwd: checkCwd,
                env: checkEnv,
                stdout: 'pipe',
                stderr: 'pipe',
                timeout: (stepDef.timeoutSeconds ?? 300) * 1000,
              })

              const exitCode = checkResult.exitCode ?? -1
              if (exitCode === 0) {
                checkResults.push({ name: check.name, passed: true })
                ctx.logger.info('dag_check_passed', {
                  runId: run.id,
                  step: sanitizeForLog(stepDef.name),
                  check: check.name,
                })
              } else {
                const failAction = check.on_failure?.action ?? 'fail'
                const failMsg = check.on_failure?.message ?? `check "${check.name}" failed (exit ${exitCode})`
                const stderr = checkResult.stderr ? Buffer.from(checkResult.stderr).toString('utf-8').slice(0, 500) : ''
                checkResults.push({ name: check.name, passed: false, message: `${failMsg}${stderr ? '\n' + stderr : ''}` })
                ctx.logger.warn('dag_check_failed', {
                  runId: run.id,
                  step: sanitizeForLog(stepDef.name),
                  check: check.name,
                  exitCode,
                  action: failAction,
                })

                if (failAction === 'pause') {
                  paused = true
                  continue // collect remaining check results
                } else {
                  // fail — stop immediately
                  stepState.status = 'failed'
                  stepState.errorMessage = failMsg
                  stepState.completedAt = new Date().toISOString()
                  saveAndBroadcast(run)
                  break
                }
              }
            } catch (err) {
              const failAction = check.on_failure?.action ?? 'fail'
              const failMsg = check.on_failure?.message ?? `check "${check.name}" error: ${String(err)}`
              checkResults.push({ name: check.name, passed: false, message: failMsg })
              if (failAction === 'fail') {
                stepState.status = 'failed'
                stepState.errorMessage = failMsg
                stepState.completedAt = new Date().toISOString()
                saveAndBroadcast(run)
                break
              }
              paused = true
            }
          }

          // Process review_routing_validation if present
          if (stepDef.review_routing_validation && !stepState.status?.startsWith('failed')) {
            const rrv = stepDef.review_routing_validation
            let rrvEnabled = true
            if (rrv.when) {
              rrvEnabled = evaluateExpressionForChecks(rrv.when, condCtx)
            }
            if (rrvEnabled && rrv.checks) {
              for (const rrvCheck of rrv.checks) {
                if (rrvCheck.check) {
                  const exprResult = evaluateExpressionForChecks(rrvCheck.check, condCtx)
                  if (!exprResult) {
                    const failAction = rrvCheck.on_failure?.action ?? 'pause'
                    const failMsg = rrvCheck.on_failure?.message ?? `review routing check "${rrvCheck.name}" failed`
                    checkResults.push({ name: rrvCheck.name, passed: false, message: failMsg })
                    if (failAction === 'fail') {
                      stepState.status = 'failed'
                      stepState.errorMessage = failMsg
                      stepState.completedAt = new Date().toISOString()
                      saveAndBroadcast(run)
                      break
                    }
                    paused = true
                  } else {
                    checkResults.push({ name: rrvCheck.name, passed: true })
                  }
                }
              }
            }
          }

          // If step wasn't already failed by a check, finalize
          if (stepState.status !== 'failed') {
            const passed = checkResults.filter(c => c.passed).length
            const failed = checkResults.filter(c => !c.passed).length
            stepState.resultContent = JSON.stringify({ checks: checkResults, passed, failed, paused })
            stepState.resultCollected = true
            trackStepOutputHash(run, stepState)

            if (paused) {
              stepState.status = 'paused_escalated'
              stepState.errorMessage = `${failed} check(s) failed with pause policy — pipeline paused for operator acknowledgement`
              ctx.logger.warn('dag_native_step_paused', {
                runId: run.id,
                step: sanitizeForLog(stepDef.name),
                passed,
                failed,
              })
            } else {
              stepState.status = 'completed'
              stepState.completedAt = new Date().toISOString()
              ctx.logger.info('dag_native_step_checks_completed', {
                runId: run.id,
                step: sanitizeForLog(stepDef.name),
                passed,
                failed,
              })
            }
            saveAndBroadcast(run)
          }
          break
        }

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
          // MEDIUM #4: native_step without command/action/checks must fail (not no-op)
          // This matches the expected test behavior and legacy engine behavior
          stepState.status = 'failed'
          stepState.errorMessage = 'native_step requires command, action, or checks'
          stepState.completedAt = new Date().toISOString()
          saveAndBroadcast(run)
          break
        }

        // Phase 25: Resolve template variables in command and args
        let nativeProjectProfile: Record<string, unknown> | undefined
        const nativeProjectPath = run.variables?.project_path
        if (nativeProjectPath) {
          try { nativeProjectProfile = loadProjectProfileRaw(nativeProjectPath) } catch { /* ok */ }
        }
        cmd = resolveTemplateVars(cmd, run, nativeProjectProfile)

        // Append shell-escaped args
        if (stepDef.args && stepDef.args.length > 0) {
          cmd = cmd + ' ' + stepDef.args.map(a => shellEscape(resolveTemplateVars(a, run, nativeProjectProfile))).join(' ')
        }

        // Build env
        const spawnEnv: Record<string, string> = { ...process.env as Record<string, string> }
        if (stepDef.env) {
          for (const [k, v] of Object.entries(stepDef.env)) {
            spawnEnv[k] = resolveTemplateVars(v, run, nativeProjectProfile)
          }
        }

        // Determine cwd (REQ-02 parity: project_path fallback)
        const rawCwdNative = stepDef.working_dir || run.variables?.project_path || run.output_dir
        const cwd = resolveTemplateVars(rawCwdNative, run, nativeProjectProfile)
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
            trackStepOutputHash(run, stepState)

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

          // Phase 21: expect:fail inverts success/failure semantics (TDD red verification)
          if (stepDef.expect === 'fail') {
            if (stepState.status === 'completed') {
              // Expected failure but got success — that's a failure
              stepState.status = 'failed'
              stepState.errorMessage = 'expect:fail — command succeeded but was expected to fail'
              ctx.logger.info('dag_native_step_expect_fail_inverted', {
                runId: run.id,
                step: sanitizeForLog(stepDef.name),
                actual: 'success',
              })
            } else if (stepState.status === 'failed' && stepState.errorMessage?.startsWith('exit code')) {
              // Expected failure and got failure — that's success
              stepState.status = 'completed'
              stepState.errorMessage = null
              stepState.resultContent = stepResult || 'expect:fail — command failed as expected'
              stepState.resultCollected = true
              trackStepOutputHash(run, stepState)
              ctx.logger.info('dag_native_step_expect_fail_inverted', {
                runId: run.id,
                step: sanitizeForLog(stepDef.name),
                actual: 'failure_as_expected',
              })
            }
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

          // Phase 25: on_step_failure policy — convert failure to completion/skip
          if (stepState.status === 'failed' && stepDef.on_step_failure) {
            if (stepDef.on_step_failure === 'completed_with_warnings') {
              const warning = stepState.errorMessage
              stepState.status = 'completed'
              stepState.resultContent = `completed_with_warnings: ${warning}`
              stepState.resultCollected = true
              trackStepOutputHash(run, stepState)
              ctx.logger.info('dag_native_step_completed_with_warnings', {
                runId: run.id,
                step: sanitizeForLog(stepDef.name),
                warning: sanitizeForLog(warning ?? ''),
              })
            } else if (stepDef.on_step_failure === 'skip') {
              stepState.status = 'skipped'
              stepState.skippedReason = `on_step_failure: skip — ${stepState.errorMessage}`
              ctx.logger.info('dag_native_step_skipped_on_failure', {
                runId: run.id,
                step: sanitizeForLog(stepDef.name),
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

      case 'spec_validate': {
        // Synchronous execution — no pool slot consumed (in POOL_BYPASS_TYPES)
        try {
          const specPath = path.resolve(run.output_dir, stepDef.spec_path ?? '')
          const schemaPath = path.resolve(run.output_dir, stepDef.schema_path ?? '')
          const constitutionSections = stepDef.constitution_sections ?? []
          const strict = stepDef.strict ?? false

          const constitutionPath = stepDef.constitution_path
            ? resolveTemplateVars(String(stepDef.constitution_path), run)
            : undefined
          const report = validateSpec(specPath, schemaPath, constitutionSections, strict, constitutionPath)

          // Write report to output dir
          const reportPath = path.join(getChildOutputDir(run, stepState), `${stepDef.name}_report.json`)
          fs.mkdirSync(path.dirname(reportPath), { recursive: true })
          fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))

          // Set result content for downstream steps
          stepState.resultContent = JSON.stringify(report)
          stepState.resultCollected = true
          trackStepOutputHash(run, stepState)

          if (report.valid) {
            stepState.status = 'completed'
            ctx.logger.info('dag_spec_validate_passed', {
              runId: run.id,
              step: sanitizeForLog(stepDef.name),
            })
          } else {
            stepState.status = 'failed'
            stepState.errorMessage = `Spec validation failed: ${report.errors.map(e => e.message).join('; ')}`
            ctx.logger.info('dag_spec_validate_failed', {
              runId: run.id,
              step: sanitizeForLog(stepDef.name),
              errorCount: report.errors.length,
            })
          }
          stepState.completedAt = new Date().toISOString()
        } catch (err) {
          stepState.status = 'failed'
          stepState.errorMessage = `spec_validate error: ${String(err)}`
          stepState.completedAt = new Date().toISOString()
          ctx.logger.error('dag_spec_validate_error', {
            runId: run.id,
            step: sanitizeForLog(stepDef.name),
            error: String(err),
          })
        }

        saveAndBroadcast(run)
        break
      }

      case 'amendment_check': {
        // Synchronous execution -- scan signal_dir for amendment signals
        try {
          const signalDir = resolveTemplateVars(stepDef.signal_dir ?? '', run)
          if (!signalDir || !fs.existsSync(signalDir)) {
            stepState.status = 'completed'
            stepState.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
            break
          }

          const signalTypes = stepDef.signal_types ?? ['amendment_required']
          const files = fs.readdirSync(signalDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))

          let foundSignal = false
          for (const file of files) {
            const filePath = path.join(signalDir, file)
            try {
              // SEC-3: Skip symlinks to prevent path traversal
              const lstat = fs.lstatSync(filePath)
              if (lstat.isSymbolicLink()) {
                ctx.logger.warn('dag_amendment_symlink_rejected', {
                  runId: run.id,
                  step: sanitizeForLog(stepState.name),
                  file: sanitizeForLog(file),
                })
                continue
              }

              // Stale signal detection (REQ-07): skip files older than step start
              const stat = fs.statSync(filePath)
              if (stepState.startedAt && stat.mtimeMs < new Date(stepState.startedAt).getTime()) {
                continue
              }

              const content = fs.readFileSync(filePath, 'utf-8')
              let parsed: Record<string, unknown>
              try {
                parsed = yaml.load(content) as Record<string, unknown>
              } catch (yamlErr) {
                ctx.logger.warn('dag_amendment_yaml_parse_error', { runId: run.id, step: sanitizeForLog(stepState.name), file: sanitizeForLog(file), error: String(yamlErr) })
                continue
              }
              if (!parsed || typeof parsed !== 'object') continue

              const signalType = String(parsed.signal_type ?? '')
              if (!signalTypes.includes(signalType)) continue

              const amendment = parseAmendmentSignal(parsed)
              if (!amendment) {
                ctx.logger.warn('dag_amendment_malformed', {
                  runId: run.id,
                  step: sanitizeForLog(stepState.name),
                  file: sanitizeForLog(file),
                })
                continue
              }

              // Valid amendment found -- transition to paused_amendment
              stepState.status = 'paused_amendment'
              stepState.amendmentPhase = 'detected'
              stepState.amendmentSignalFile = filePath
              stepState.amendmentType = amendment.amendment.type
              stepState.amendmentCategory = amendment.amendment.category
              stepState.amendmentSpecSection = amendment.amendment.spec_section

              // Store signal in DB
              workflowStore.insertSignal({
                id: `${run.id}_${stepState.name}_amendment_${Date.now()}`,
                run_id: run.id,
                step_name: stepState.name,
                signal_type: signalType,
                signal_file_path: filePath,
                resolution: null,
                resolution_file_path: null,
                resolved_at: null,
                synthetic: 0,
              })

              ctx.broadcast({
                type: 'amendment_detected',
                runId: run.id,
                stepName: stepState.name,
                amendmentType: amendment.amendment.type,
                category: amendment.amendment.category,
              })

              ctx.logger.info('dag_amendment_detected', {
                runId: run.id,
                step: sanitizeForLog(stepState.name),
                type: amendment.amendment.type,
                category: amendment.amendment.category,
                section: sanitizeForLog(amendment.amendment.spec_section),
              })

              foundSignal = true
              break  // Process one amendment at a time
            } catch (fileErr) {
              ctx.logger.warn('dag_amendment_file_error', {
                runId: run.id,
                step: sanitizeForLog(stepState.name),
                file: sanitizeForLog(file),
                error: String(fileErr),
              })
            }
          }

          if (!foundSignal) {
            // No signals found -- complete normally
            stepState.status = 'completed'
            stepState.completedAt = new Date().toISOString()
          }
        } catch (err) {
          stepState.status = 'failed'
          stepState.errorMessage = `Amendment check failed: ${String(err)}`
          stepState.completedAt = new Date().toISOString()
          ctx.logger.error('dag_amendment_check_error', {
            runId: run.id,
            step: sanitizeForLog(stepState.name),
            error: String(err),
          })
        }
        saveAndBroadcast(run)
        break
      }

      case 'reconcile-spec': {
        // P-8 (REQ-36, REQ-37): Batch reconciliation — scan signal_dir for reconciliation amendments
        try {
          const signalDir = resolveTemplateVars(stepDef.signal_dir ?? '', run)
          if (!signalDir || !fs.existsSync(signalDir)) {
            stepState.status = 'completed'
            stepState.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
            break
          }

          const signalTypes = stepDef.signal_types ?? ['reconciliation']
          const files = fs.readdirSync(signalDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))

          // Collect all reconciliation signals, grouped by spec_section
          const bySection = new Map<string, Array<{ filePath: string; amendment: AmendmentSignal }>>()

          for (const file of files) {
            const filePath = path.join(signalDir, file)
            try {
              // SEC-3: Skip symlinks to prevent path traversal
              const lstat = fs.lstatSync(filePath)
              if (lstat.isSymbolicLink()) {
                ctx.logger.warn('dag_reconcile_symlink_rejected', {
                  runId: run.id,
                  step: sanitizeForLog(stepState.name),
                  file: sanitizeForLog(file),
                })
                continue
              }

              // Stale signal detection: skip files older than step start
              const stat = fs.statSync(filePath)
              if (stepState.startedAt && stat.mtimeMs < new Date(stepState.startedAt).getTime()) {
                continue
              }

              const content = fs.readFileSync(filePath, 'utf-8')
              let parsed: Record<string, unknown>
              try {
                parsed = yaml.load(content) as Record<string, unknown>
              } catch (yamlErr) {
                ctx.logger.warn('dag_reconcile_yaml_parse_error', { runId: run.id, step: sanitizeForLog(stepState.name), file: sanitizeForLog(file), error: String(yamlErr) })
                continue
              }
              if (!parsed || typeof parsed !== 'object') continue

              const signalType = String(parsed.signal_type ?? '')
              if (!signalTypes.includes(signalType)) continue

              const amendment = parseAmendmentSignal(parsed)
              if (!amendment) {
                ctx.logger.warn('dag_reconcile_malformed', {
                  runId: run.id,
                  step: sanitizeForLog(stepState.name),
                  file: sanitizeForLog(file),
                })
                continue
              }

              // Group by spec_section
              const section = amendment.amendment.spec_section
              if (!bySection.has(section)) {
                bySection.set(section, [])
              }
              bySection.get(section)!.push({ filePath, amendment })
            } catch (fileErr) {
              ctx.logger.warn('dag_reconcile_file_error', {
                runId: run.id,
                step: sanitizeForLog(stepState.name),
                file: sanitizeForLog(file),
                error: String(fileErr),
              })
            }
          }

          const affectedSections = bySection.size
          const threshold = stepDef.batch_threshold ?? 3

          if (affectedSections === 0) {
            // No reconciliation signals — complete normally
            stepState.status = 'completed'
            stepState.completedAt = new Date().toISOString()
          } else if (affectedSections >= threshold) {
            // REQ-37: Escalate to human for batch approval
            stepState.status = 'paused_human'
            stepState.batchAmendmentCount = affectedSections
            ctx.broadcast({
              type: 'batch_reconciliation_threshold',
              runId: run.id,
              stepName: stepState.name,
              sections: affectedSections,
              threshold,
            })
            ctx.logger.info('dag_reconcile_threshold_exceeded', {
              runId: run.id,
              step: sanitizeForLog(stepState.name),
              sections: affectedSections,
              threshold,
            })
          } else {
            // Process batch amendments below threshold
            for (const [section, signals] of bySection) {
              for (const { filePath, amendment } of signals) {
                // Store each signal in DB
                workflowStore.insertSignal({
                  id: `${run.id}_${stepState.name}_reconcile_${section}_${Date.now()}`,
                  run_id: run.id,
                  step_name: stepState.name,
                  signal_type: 'reconciliation',
                  signal_file_path: filePath,
                  resolution: 'approved',
                  resolution_file_path: null,
                  resolved_at: new Date().toISOString(),
                  synthetic: 0,
                })

                // Record amendment in DB and auto-resolve
                const amendmentId = workflowStore.insertAmendment({
                  run_id: run.id,
                  step_name: stepState.name,
                  signal_file: filePath,
                  amendment_type: amendment.amendment.type,
                  category: 'reconciliation',
                  spec_section: amendment.amendment.spec_section,
                  issue: amendment.amendment.issue,
                  proposed_change: amendment.amendment.proposed_addition,
                  approval_timestamp: Date.now(),
                  rationale: 'Auto-approved: below batch threshold',
                  target: amendment.amendment.target,
                })
                workflowStore.resolveAmendment(amendmentId, 'approved', 'batch_reconciliation')
              }
            }

            stepState.batchAmendmentCount = affectedSections
            stepState.status = 'completed'
            stepState.completedAt = new Date().toISOString()

            ctx.broadcast({
              type: 'batch_reconciliation_complete',
              runId: run.id,
              stepName: stepState.name,
              sectionsProcessed: affectedSections,
            })

            ctx.logger.info('dag_reconcile_batch_processed', {
              runId: run.id,
              step: sanitizeForLog(stepState.name),
              sections: affectedSections,
            })
          }
        } catch (err) {
          stepState.status = 'failed'
          stepState.errorMessage = `Reconciliation check failed: ${String(err)}`
          stepState.completedAt = new Date().toISOString()
          ctx.logger.error('dag_reconcile_error', {
            runId: run.id,
            step: sanitizeForLog(stepState.name),
            error: String(err),
          })
        }
        saveAndBroadcast(run)
        break
      }
    }
  }

  /**
   * Monitor a step using the signal protocol (Phase 7).
   * Checks for signal files, handles synthetic signals for fallback, and processes signal types.
   */
  function monitorSignalProtocolStep(
    run: WorkflowRun,
    stepDef: WorkflowStep,
    stepState: StepRunState,
  ): void {
    // REQ-14/REQ-44: Pass processed signal files set for deduplication
    const processed = getProcessedSignals(run.id, stepState.name)
    const match: SignalMatch | null = checkStepSignals(
      stepState.signalDir!,
      stepState.name,
      stepState.startedAt!,
      processed,
      run.id,
    )

    if (match) {
      const { signal, filePath: signalFilePath } = match
      // Validate signal authority
      const loggerAdapter = { warn: (...args: unknown[]) => ctx.logger.warn(String(args[0]), typeof args[1] === 'object' ? args[1] as Record<string, unknown> : {}) }
      if (!validateSignalAuthority(signal, loggerAdapter)) {
        ctx.logger.warn('dag_signal_authority_rejected', {
          runId: run.id,
          step: sanitizeForLog(stepState.name),
          agent: signal.agent,
        })
        return // Ignore unauthorized signals
      }

      // Insert DB record
      workflowStore.insertSignal({
        id: `${run.id}_${stepState.name}_${Date.now()}`,
        run_id: run.id,
        step_name: stepState.name,
        signal_type: signal.signal_type,
        signal_file_path: signalFilePath,
        resolution: null,
        resolution_file_path: null,
        resolved_at: null,
        synthetic: signal.synthetic ? 1 : 0,
      })

      stepState.lastSignalType = signal.signal_type
      stepState.verifiedCompletion = !signal.synthetic
      processSignal(run, stepDef, stepState, signal)
      return
    }

    // No signal found — check for task completion as fallback (synthetic signal)
    const task = taskStore.getTask(stepState.taskId!)
    if (!task) {
      // Task disappeared — generate synthetic error
      const _synthetic = createSyntheticSignal(stepState.name, run.id, 'error', 'task_disappeared')
      stepState.lastSignalType = 'error'
      stepState.verifiedCompletion = false
      stepState.status = 'failed'
      stepState.errorMessage = 'task disappeared (synthetic signal)'
      stepState.completedAt = new Date().toISOString()
      releasePoolSlotIfHeld(stepState, run)
      saveAndBroadcast(run)
      ctx.logger.warn('dag_synthetic_signal', {
        runId: run.id,
        step: sanitizeForLog(stepState.name),
        source: 'task_disappeared',
      })
      return
    }

    if (task.status === 'completed' || task.status === 'failed') {
      // Task ended without writing a signal file — generate synthetic signal
      const signalType = task.status === 'completed' ? 'completed' : 'error'
      const synthetic = createSyntheticSignal(stepState.name, run.id, signalType as any, 'task_status_fallback')

      workflowStore.insertSignal({
        id: `${run.id}_${stepState.name}_synthetic_${Date.now()}`,
        run_id: run.id,
        step_name: stepState.name,
        signal_type: signalType,
        signal_file_path: '',
        resolution: null,
        resolution_file_path: null,
        resolved_at: null,
        synthetic: 1,
      })

      stepState.lastSignalType = signalType
      stepState.verifiedCompletion = false
      ctx.logger.warn('dag_synthetic_signal', {
        runId: run.id,
        step: sanitizeForLog(stepState.name),
        source: 'task_status_fallback',
        taskStatus: task.status,
      })
      processSignal(run, stepDef, stepState, synthetic)
      return
    }

    // Check if tmux window is still alive (task.status === 'running' but tmux died)
    if (task.status === 'running' && task.tmuxWindow) {
      const sessionName = task.tmuxWindow.includes(':') ? task.tmuxWindow.split(':')[0] : task.tmuxWindow
      const expectedName = task.tmuxWindow.includes(':') ? task.tmuxWindow.split(':').pop()! : task.tmuxWindow
      const tmuxResult = Bun.spawnSync(
        ['tmux', 'list-windows', '-t', sessionName, '-F', '#{window_name}'],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      const tmuxAlive =
        tmuxResult.exitCode === 0 &&
        tmuxResult.stdout.toString().trim().split('\n').includes(expectedName)

      if (!tmuxAlive) {
        taskStore.updateTask(task.id, { status: 'failed', errorMessage: 'tmux_window_disappeared' })

        workflowStore.insertSignal({
          id: `${run.id}_${stepState.name}_tmux_died_${Date.now()}`,
          run_id: run.id,
          step_name: stepState.name,
          signal_type: 'error',
          signal_file_path: '',
          resolution: null,
          resolution_file_path: null,
          resolved_at: null,
          synthetic: 1,
        })

        stepState.lastSignalType = 'error'
        stepState.verifiedCompletion = false
        stepState.status = 'failed'
        stepState.errorMessage = 'tmux window disappeared'
        stepState.completedAt = new Date().toISOString()
        releasePoolSlotIfHeld(stepState, run)
        saveAndBroadcast(run)
        ctx.logger.warn('dag_tmux_window_disappeared', {
          runId: run.id,
          step: sanitizeForLog(stepState.name),
          tmuxWindow: task.tmuxWindow,
        })
        return
      }
    }

    // Check signal timeout (REQ-21/REQ-26)
    if (stepState.startedAt && stepState.signalTimeoutSeconds) {
      const elapsed = (Date.now() - new Date(stepState.startedAt).getTime()) / 1000
      if (elapsed > stepState.signalTimeoutSeconds) {
        // REQ-21/REQ-26: Generate synthetic error signal and insert to DB
        const _synthetic = createSyntheticSignal(stepState.name, run.id, 'error', 'signal_timeout')

        workflowStore.insertSignal({
          id: `${run.id}_${stepState.name}_timeout_${Date.now()}`,
          run_id: run.id,
          step_name: stepState.name,
          signal_type: 'error',
          signal_file_path: '',
          resolution: null,
          resolution_file_path: null,
          resolved_at: null,
          synthetic: 1,
        })

        stepState.lastSignalType = 'error'
        stepState.verifiedCompletion = false
        stepState.status = 'signal_timeout'
        stepState.errorMessage = `Signal timeout after ${stepState.signalTimeoutSeconds}s`
        stepState.completedAt = new Date().toISOString()
        releasePoolSlotIfHeld(stepState, run)
        saveAndBroadcast(run)
        ctx.logger.warn('dag_signal_timeout', {
          runId: run.id,
          step: sanitizeForLog(stepState.name),
          timeout: stepState.signalTimeoutSeconds,
          synthetic: true,
          source: 'signal_timeout',
        })
        // signal_timeout is treated as failure for workflow completion
        return
      }
    }

    // Still waiting for signal — no action
  }

  /**
   * Process a parsed signal and update step state accordingly (Phase 7).
   */
  function processSignal(
    run: WorkflowRun,
    stepDef: WorkflowStep,
    stepState: StepRunState,
    signal: SignalFile,
  ): void {
    switch (signal.signal_type) {
      case 'completed': {
        stepState.status = 'completed'
        stepState.completedAt = new Date().toISOString()
        collectStepResult(run, stepDef, stepState)
        releasePoolSlotIfHeld(stepState, run)
        saveAndBroadcast(run)
        ctx.logger.info('dag_step_completed_via_signal', {
          runId: run.id,
          step: sanitizeForLog(stepState.name),
          verified: stepState.verifiedCompletion,
          synthetic: signal.synthetic ?? false,
        })
        break
      }

      case 'error': {
        const maxRetries = stepDef.maxRetries ?? 0
        if (stepState.retryCount < maxRetries) {
          stepState.retryCount += 1
          stepState.taskId = null
          stepState.status = 'pending'
          stepState.lastSignalType = undefined
          saveAndBroadcast(run)
          return
        }
        stepState.status = 'failed'
        stepState.errorMessage = signal.checkpoint?.extensions?.error as string
          ?? 'failed via signal'
        stepState.completedAt = new Date().toISOString()
        releasePoolSlotIfHeld(stepState, run)
        saveAndBroadcast(run)
        ctx.logger.info('dag_step_failed_via_signal', {
          runId: run.id,
          step: sanitizeForLog(stepState.name),
          verified: stepState.verifiedCompletion,
        })
        break
      }

      case 'amendment_required': {
        // Phase 10: Check if step is configured for amendments
        if (!stepDef.can_request_amendment) {
          ctx.logger.warn('dag_amendment_not_configured', {
            runId: run.id,
            step: sanitizeForLog(stepState.name),
            reason: 'step does not have can_request_amendment enabled',
          })
          stepState.status = 'failed'
          stepState.errorMessage = 'Amendment requested but step does not have can_request_amendment enabled'
          stepState.completedAt = new Date().toISOString()
          releasePoolSlotIfHeld(stepState, run)
          saveAndBroadcast(run)
          break
        }

        stepState.status = 'paused_amendment'
        stepState.amendmentPhase = 'detected'
        // Store signal file path for processing
        if (stepState.signalDir) {
          stepState.amendmentSignalFile = path.join(
            stepState.signalDir,
            `${stepState.name}_amendment_required.yaml`,
          )
        }
        releasePoolSlotIfHeld(stepState, run)
        // Write resolution file placeholder
        if (stepState.signalDir) {
          try {
            writeResolutionFile(
              stepState.signalDir,
              `${stepState.name}_amendment_required.yaml`,
              'pending_amendment',
              'agentboard',
              signal.checkpoint,
            )
          } catch { /* best effort */ }
        }
        saveAndBroadcast(run)
        ctx.logger.info('dag_step_paused', {
          runId: run.id,
          step: sanitizeForLog(stepState.name),
          reason: 'amendment_required',
        })
        break
      }

      case 'human_required': {
        stepState.status = 'paused_human'
        releasePoolSlotIfHeld(stepState, run)
        if (stepState.signalDir) {
          try {
            writeResolutionFile(
              stepState.signalDir,
              `${stepState.name}_human_required.yaml`,
              'pending_human',
              'agentboard',
              signal.checkpoint,
            )
          } catch { /* best effort */ }
        }
        saveAndBroadcast(run)
        ctx.logger.info('dag_step_paused', {
          runId: run.id,
          step: sanitizeForLog(stepState.name),
          reason: 'human_required',
        })
        break
      }

      case 'blocked': {
        stepState.status = 'paused_amendment'  // blocked treated like amendment
        releasePoolSlotIfHeld(stepState, run)
        if (stepState.signalDir) {
          try {
            writeResolutionFile(
              stepState.signalDir,
              `${stepState.name}_blocked.yaml`,
              'pending_resolution',
              'agentboard',
              signal.checkpoint,
            )
          } catch { /* best effort */ }
        }
        saveAndBroadcast(run)
        ctx.logger.info('dag_step_paused', {
          runId: run.id,
          step: sanitizeForLog(stepState.name),
          reason: 'blocked',
        })
        break
      }

      case 'progress': {
        // Progress signals update checkpoint but don't change step status
        // Step remains in waiting_signal state
        saveAndBroadcast(run)
        ctx.logger.info('dag_signal_progress', {
          runId: run.id,
          step: sanitizeForLog(stepState.name),
          subtask: signal.checkpoint?.last_completed_subtask,
        })
        break
      }

      default: {
        // Unknown signal type — treat as error
        stepState.status = 'signal_error'
        stepState.errorMessage = `Unknown signal type: ${signal.signal_type}`
        stepState.completedAt = new Date().toISOString()
        releasePoolSlotIfHeld(stepState, run)
        saveAndBroadcast(run)
        break
      }
    }
  }

  /** Collect structured result file from a completed step */
  function collectStepResult(run: WorkflowRun, stepDef: WorkflowStep, stepState: StepRunState): void {
    if (!stepDef.result_file) return
    // Template-resolve the display path stored in step state
    stepState.resultFile = resolveTemplateVars(stepDef.result_file, run)
    stepState.resultCollected = false
    stepState.resultContent = null

    try {
      const fullPath = resolveOutputPath(run, stepDef.result_file)
      if (!fs.existsSync(fullPath)) {
        // P1-32: log warning; fail step if verdict enforcement is required
        if (stepDef.enforce_verdict) {
          ctx.logger.warn('collect_result_missing_file', { runId: run.id, step: stepDef.name, path: fullPath })
          stepState.status = 'failed'
          stepState.errorMessage = `Result file not found (required for verdict enforcement): ${fullPath}`
          stepState.completedAt = new Date().toISOString()
          releasePoolSlotIfHeld(stepState, run)
          saveAndBroadcast(run)
        }
        return
      }
      const stat = fs.statSync(fullPath)
      if (stat.size > 1024 * 1024) {
        ctx.logger.warn('collect_result_oversized', { runId: run.id, step: stepDef.name, sizeBytes: stat.size })
        return // 1MB limit — still treat as missing (no fail on oversize)
      }
      stepState.resultContent = fs.readFileSync(fullPath, 'utf-8')
      stepState.resultCollected = true
      trackStepOutputHash(run, stepState)
    } catch {
      // Best effort
    }

    // Verdict enforcement: gate on result file content
    if (stepDef.enforce_verdict && stepState.resultContent) {
      try {
        const parsed = yaml.load(stepState.resultContent)
        if (parsed && typeof parsed === 'object') {
          const verdictField = stepDef.enforce_verdict.field || 'overall_verdict'
          const verdict = (parsed as Record<string, unknown>)[verdictField]
          const allowed = stepDef.enforce_verdict.allowed || ['pass']
          if (verdict && typeof verdict === 'string' && !allowed.includes(verdict)) {
            const failMsg = (stepDef.enforce_verdict.fail_message || `Verdict '${verdict}' not in allowed set [${allowed.join(', ')}]`)
              .replace(/\{\{\s*verdict\s*\}\}/g, verdict)
            stepState.status = 'failed'
            stepState.errorMessage = failMsg
            stepState.completedAt = new Date().toISOString()
            releasePoolSlotIfHeld(stepState, run)
            saveAndBroadcast(run)
            return
          }
        }
      } catch {
        // If YAML parsing fails, don't block — just log
        ctx.logger.warn('enforce_verdict_parse_error', { step: stepDef.name, runId: run.id })
      }
    }
  }

  /**
   * Track output hash for a completed step's result content.
   * Called after a step completes successfully and has resultContent.
   */
  function trackStepOutputHash(run: WorkflowRun, stepState: StepRunState): void {
    if (!stepState.resultContent) return
    try {
      const store = getOutputInvalidationStore()
      const hash = computeHash(stepState.resultContent)
      const execCtx = { runId: run.id, outputDir: run.output_dir || '', logger: ctx.logger }
      // trackOutputHash is async in signature but performs sync SQLite ops; fire-and-forget
      trackOutputHash(stepState.name, hash, true, execCtx, store).catch(() => {})
    } catch {
      // Best effort -- output hash tracking should not break step completion
    }
  }

  // ── Review Loop Processing (Phase 8) ─────────────────────────────────

  /**
   * Process a review_loop step. Handles pool slot cycling between producer
   * and reviewer sub-steps, YAML-based verdict parsing, exhaustion policies,
   * CONCERN handling, DB iteration tracking, and crash recovery.
   *
   * State machine using reviewSubStep:
   * - null → initialize, request producer pool slot
   * - 'producer' → monitor producer task
   * - 'between' → producer done, slot released, request reviewer pool slot
   * - 'reviewer' → monitor reviewer task, extract verdict, decide
   */
  function processReviewLoop(
    run: WorkflowRun,
    stepDef: WorkflowStep,
    stepState: StepRunState,
    runTier: number,
    parsed: ParsedWorkflow,
  ): void {
    // ROBUSTNESS-2 (REQ-37): Re-entrance guard -- prevents concurrent processReviewLoop calls
    // Uses in-memory Set (not serialized state) to avoid stale locks after crash/reload
    const guardKey = `${run.id}:${stepDef.name}`
    if (reviewLoopProcessing.has(guardKey)) {
      return
    }
    reviewLoopProcessing.add(guardKey)

    try {
    // SECURITY-2 (REQ-35): Runtime ceiling enforcement -- prevents bypass via tier_override or mutation
    const ceiling = parseInt(process.env.AGENTBOARD_MAX_REVIEW_ITERATIONS ?? '10', 10)
    const maxIter = Math.min(stepDef.max_iterations ?? 3, ceiling)
    const onMaxIterations = stepDef.on_max_iterations ?? 'escalate'

    if (stepDef.max_iterations && stepDef.max_iterations > ceiling) {
      ctx.logger.warn('dag_review_loop_ceiling_enforced', {
        runId: run.id,
        step: sanitizeForLog(stepDef.name),
        requested: stepDef.max_iterations,
        clamped: maxIter,
        ceiling,
      })
    }

    // ── P-2 (REQ-24): Crash recovery -- detect interrupted iterations on first call ──
    if (!stepState.crashRecoveryChecked) {
      const lastIteration = workflowStore.getLastIteration(run.id, stepDef.name)

      if (lastIteration && lastIteration.started_at && !lastIteration.completed_at) {
        // Iteration was interrupted -- determine which sub-step to resume
        if (!lastIteration.producer_task_id) {
          // Producer never started -- restart iteration
          stepState.reviewIteration = lastIteration.iteration
          stepState.reviewSubStep = 'producer'
          stepState.currentIterationId = lastIteration.id
          stepState.status = 'running'
          ctx.logger.info('dag_review_loop_crash_recovery', {
            runId: run.id,
            step: sanitizeForLog(stepDef.name),
            iteration: lastIteration.iteration,
            resumeAt: 'producer',
          })
        } else if (!lastIteration.reviewer_task_id) {
          // Producer may have completed -- check for output file
          const hasProducerOutput = stepDef.producer?.result_file
            ? fs.existsSync(path.resolve(run.output_dir, stepDef.producer.result_file))
            : false
          if (hasProducerOutput) {
            // Producer completed, start reviewer
            stepState.reviewIteration = lastIteration.iteration
            stepState.reviewSubStep = 'between'
            stepState.currentIterationId = lastIteration.id
            stepState.status = 'running'
            ctx.logger.info('dag_review_loop_crash_recovery', {
              runId: run.id,
              step: sanitizeForLog(stepDef.name),
              iteration: lastIteration.iteration,
              resumeAt: 'reviewer',
            })
          } else {
            // Producer didn't complete -- restart it
            stepState.reviewIteration = lastIteration.iteration
            stepState.reviewSubStep = 'producer'
            stepState.currentIterationId = lastIteration.id
            stepState.status = 'running'
            ctx.logger.info('dag_review_loop_crash_recovery', {
              runId: run.id,
              step: sanitizeForLog(stepDef.name),
              iteration: lastIteration.iteration,
              resumeAt: 'producer_restart',
            })
          }
        } else {
          // Both started -- check if reviewer output exists
          const hasReviewerOutput = stepDef.reviewer?.result_file
            ? fs.existsSync(path.resolve(run.output_dir, stepDef.reviewer.result_file))
            : false
          if (hasReviewerOutput) {
            // Reviewer output exists -- process verdict
            stepState.reviewIteration = lastIteration.iteration
            stepState.reviewSubStep = 'reviewer'
            stepState.currentIterationId = lastIteration.id
            stepState.status = 'running'
            // Set taskId to reviewer task so the verdict processing path picks it up
            stepState.taskId = lastIteration.reviewer_task_id
            ctx.logger.info('dag_review_loop_crash_recovery', {
              runId: run.id,
              step: sanitizeForLog(stepDef.name),
              iteration: lastIteration.iteration,
              resumeAt: 'verdict',
            })
          } else {
            // Re-run reviewer
            stepState.reviewIteration = lastIteration.iteration
            stepState.reviewSubStep = 'between'
            stepState.currentIterationId = lastIteration.id
            stepState.status = 'running'
            ctx.logger.info('dag_review_loop_crash_recovery', {
              runId: run.id,
              step: sanitizeForLog(stepDef.name),
              iteration: lastIteration.iteration,
              resumeAt: 'reviewer_restart',
            })
          }
        }

        // P-1 (REQ-25): Load checkpoint extensions for review_loop state
        const extensions = loadCheckpointExtensions(run.output_dir, stepDef.name)
        if (extensions) {
          if (extensions.iteration !== undefined) {
            stepState.reviewIteration = extensions.iteration
          }
          if (extensions.previous_feedback) {
            stepState.reviewFeedback = extensions.previous_feedback
          }
          ctx.logger.info('dag_review_loop_checkpoint_extensions_loaded', {
            runId: run.id,
            step: sanitizeForLog(stepDef.name),
            extensionIteration: extensions.iteration,
            hasFeedback: !!extensions.previous_feedback,
          })
        }
      } else if (lastIteration && lastIteration.verdict === 'PASS') {
        // Last completed iteration was PASS -- mark step complete
        stepState.status = 'completed'
        stepState.completedAt = new Date().toISOString()
        stepState.crashRecoveryChecked = true
        saveAndBroadcast(run)
        return
      }

      stepState.crashRecoveryChecked = true
      if (stepState.status === 'running') {
        stepState.startedAt = stepState.startedAt ?? new Date().toISOString()
        saveAndBroadcast(run)
      }
    }

    // Helper: Build and write summary file
    function buildAndWriteSummary(finalOutcome: string): void {
      try {
        const iterations = workflowStore.getIterationsByStep(run.id, stepDef.name)
        const iterationSummaries: IterationSummary[] = iterations.map((iter) => {
          // P-5: Calculate producer/reviewer durations using producer_completed_at timestamp
          const producerDuration = iter.producer_completed_at && iter.started_at
            ? (new Date(iter.producer_completed_at).getTime() - new Date(iter.started_at).getTime()) / 1000
            : 0
          const reviewerDuration = iter.completed_at && iter.producer_completed_at
            ? (new Date(iter.completed_at).getTime() - new Date(iter.producer_completed_at).getTime()) / 1000
            : 0

          return {
            iteration: iter.iteration,
            verdict: iter.verdict ?? 'UNKNOWN',
            feedback: iter.feedback,
            producer_duration_seconds: producerDuration,
            reviewer_duration_seconds: reviewerDuration,
          }
        })

        const summary: ReviewLoopSummary = {
          step_name: stepDef.name,
          total_iterations: iterations.length,
          final_outcome: finalOutcome,
          iterations: iterationSummaries,
        }

        const summaryDir = path.join(run.output_dir, 'review-loop-summaries')
        writeReviewLoopSummary(summaryDir, stepDef.name, summary)
      } catch (err) {
        ctx.logger.warn('dag_review_loop_summary_write_failed', {
          runId: run.id,
          step: sanitizeForLog(stepDef.name),
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // ── Pending: initialize and request producer pool slot ──
    if (stepState.status === 'pending') {
      if (stepState.reviewIteration === undefined) {
        stepState.reviewIteration = 0
      }
      stepState.reviewSubStep = null
      stepState.reviewVerdict = null
      stepState.reviewFeedback = null

      // Request pool slot for producer
      if (pool && parsed.system?.session_pool) {
        const result = pool.requestSlot({
          runId: run.id,
          stepName: stepDef.name,
          tier: runTier,
        })
        if (result.rejected || !result.slot) {
          ctx.logger.warn('dag_pool_queue_full', {
            runId: run.id,
            step: sanitizeForLog(stepDef.name),
            reason: result.reason,
          })
          return
        }
        stepState.poolSlotId = result.slot.id
        if (result.slot.status === 'queued') {
          stepState.status = 'queued'
          saveAndBroadcast(run)
          ctx.broadcast({
            type: 'step_queued',
            runId: run.id,
            stepName: stepDef.name,
            queuePosition: pool.getStatus().queue.length,
          })
          return
        }
        ctx.broadcast({
          type: 'pool_slot_granted',
          runId: run.id,
          stepName: stepDef.name,
          slotId: result.slot.id,
        })
      }

      // Start first iteration's producer
      stepState.status = 'running'
      stepState.startedAt = new Date().toISOString()
      stepState.reviewSubStep = 'producer'
      stepState.reviewIteration = 1

      // DB: insert iteration record
      const iterationId = generateIterationId()
      stepState.currentIterationId = iterationId
      workflowStore.insertIteration({
        id: iterationId,
        run_id: run.id,
        step_name: stepDef.name,
        iteration: 1,
        producer_task_id: null,
        reviewer_task_id: null,
        verdict: null,
        feedback: null,
        started_at: new Date().toISOString(),
        completed_at: null,
        producer_completed_at: null,
      })

      startStep(run, stepDef.producer!, stepState)

      // DB: update with producer task ID
      if (stepState.taskId) {
        workflowStore.updateIteration(iterationId, { producer_task_id: stepState.taskId })
      }

      ctx.logger.info('dag_review_loop_started', {
        runId: run.id,
        step: sanitizeForLog(stepDef.name),
        iteration: 1,
        subStep: 'producer',
      })
      return
    }

    // ── Queued: waiting for pool slot ──
    if (stepState.status === 'queued' && stepState.poolSlotId) {
      // P1-12: producer starvation detection — mirrors reviewer starvation check
      if (!stepState.producerQueuedAt) {
        stepState.producerQueuedAt = new Date().toISOString()
      }
      const producerElapsed = (Date.now() - new Date(stepState.producerQueuedAt).getTime()) / 1000
      if (producerElapsed > 300) {
        ctx.logger.warn('dag_review_loop_producer_starvation', {
          runId: run.id,
          step: sanitizeForLog(stepDef.name),
          waitSeconds: Math.round(producerElapsed),
        })
        stepState.status = 'paused_starvation' as any
        stepState.errorMessage = `Pool starvation: producer queued for ${Math.round(producerElapsed)}s, exceeds 300s timeout`
        releasePoolSlotIfHeld(stepState, run)
        saveAndBroadcast(run)
        ctx.broadcast({
          type: 'step_starvation',
          runId: run.id,
          stepName: stepDef.name,
          waitSeconds: Math.round(producerElapsed),
        })
        return
      }

      const slot = pool?.getSlot(stepState.poolSlotId)
      if (slot && slot.status === 'active') {
        ctx.broadcast({
          type: 'pool_slot_granted',
          runId: run.id,
          stepName: stepDef.name,
          slotId: slot.id,
        })
        stepState.status = 'running'
        stepState.startedAt = new Date().toISOString()
        stepState.reviewSubStep = 'producer'
        stepState.reviewIteration = 1

        const iterationId = generateIterationId()
        stepState.currentIterationId = iterationId
        workflowStore.insertIteration({
          id: iterationId,
          run_id: run.id,
          step_name: stepDef.name,
          iteration: 1,
          producer_task_id: null,
          reviewer_task_id: null,
          verdict: null,
          feedback: null,
          started_at: new Date().toISOString(),
          completed_at: null,
          producer_completed_at: null,
        })

        startStep(run, stepDef.producer!, stepState)
        if (stepState.taskId) {
          workflowStore.updateIteration(iterationId, { producer_task_id: stepState.taskId })
        }
        ctx.logger.info('dag_review_loop_started', {
          runId: run.id,
          step: sanitizeForLog(stepDef.name),
          iteration: 1,
          subStep: 'producer',
        })
      }
      return
    }

    // ── Running / waiting_signal: monitor current sub-step ──
    // Review loop sub-steps (producer/reviewer) may use signal_protocol, which sets
    // status to 'waiting_signal'. Check for completion signals first, then fall
    // through to task-based monitoring as synthetic fallback.
    if (stepState.status === 'waiting_signal') {
      // Check for completed/error signals from the sub-step's signal protocol
      if (stepState.signalDir) {
        const processed = getProcessedSignals(run.id, stepState.name)
        const match: SignalMatch | null = checkStepSignals(
          stepState.signalDir, stepState.name,
          stepState.startedAt ?? new Date().toISOString(),
          processed, run.id,
        )
        const signal = match?.signal ?? null
        if (signal && (signal.signal_type === 'completed' || signal.signal_type === 'error')) {
          // Signal found — for error, archive and terminate immediately.
          // For completed, defer archive until task completion is confirmed (BUG-1b fix:
          // archiving before task completion could lose the signal if the task hasn't
          // actually finished yet). Store the path for deferred archival.
          stepState.verifiedCompletion = !signal.synthetic
          if (signal.signal_type === 'error') {
            archiveConsumedSignal(stepState.signalDir, match!.filePath)
            stepState.status = 'failed'
            stepState.errorMessage = `${stepState.reviewSubStep} failed via signal`
            stepState.completedAt = new Date().toISOString()
            releasePoolSlotIfHeld(stepState, run)
            saveAndBroadcast(run)
            return
          }
          // completed signal — stash file path for deferred archive after task confirms done
          stepState.pendingSignalArchivePath = match!.filePath
          // fall through to task completion handling
          stepState.status = 'running'
        } else if (signal && signal.signal_type === 'amendment_required') {
          stepState.status = 'paused_amendment'
          releasePoolSlotIfHeld(stepState, run)
          saveAndBroadcast(run)
          return
        } else {
          // No signal yet — also fall through to check task status as synthetic fallback
          stepState.status = 'running'
        }
      } else {
        stepState.status = 'running'
      }
    }
    if (stepState.status !== 'running') return

    // Handle 'between' state: producer done, need reviewer slot
    if (stepState.reviewSubStep === 'between') {
      // REQ-17: One-tick gap — on the first tick after entering 'between',
      // clear the flag and return without requesting a slot. This gives
      // other steps a chance to acquire the slot that was just released.
      if (stepState.needsReviewerSlot) {
        stepState.needsReviewerSlot = false
        saveAndBroadcast(run)
        return
      }

      if (pool && parsed.system?.session_pool) {
        const result = pool.requestSlot({
          runId: run.id,
          stepName: stepDef.name,
          tier: runTier,
        })
        if (result.rejected || !result.slot) {
          // Pool starvation check
          if (stepState.reviewerQueuedAt) {
            const elapsed = (Date.now() - new Date(stepState.reviewerQueuedAt).getTime()) / 1000
            if (elapsed > 300) {
              ctx.logger.warn('dag_review_loop_pool_starvation', {
                runId: run.id,
                step: sanitizeForLog(stepDef.name),
                waitSeconds: Math.round(elapsed),
              })

              // P-3: Escalate to paused_starvation
              stepState.status = 'paused_starvation' as any
              stepState.errorMessage = `Pool starvation: reviewer queued for ${Math.round(elapsed)}s, exceeds 300s timeout`
              saveAndBroadcast(run)

              ctx.broadcast({
                type: 'step_starvation',
                runId: run.id,
                stepName: stepDef.name,
                waitSeconds: Math.round(elapsed),
              })
              return
            }
          }
          return
        }
        stepState.poolSlotId = result.slot.id
        if (result.slot.status === 'queued') {
          if (!stepState.reviewerQueuedAt) {
            stepState.reviewerQueuedAt = new Date().toISOString()
          }
          saveAndBroadcast(run)
          return
        }
        ctx.broadcast({
          type: 'pool_slot_granted',
          runId: run.id,
          stepName: stepDef.name,
          slotId: result.slot.id,
        })
      }

      // Start reviewer
      stepState.reviewSubStep = 'reviewer'
      stepState.reviewerQueuedAt = null
      stepState.taskId = null

      // Inject feedback into reviewer prompt if available
      const reviewerDef = { ...stepDef.reviewer! }
      if (stepState.reviewFeedback) {
        reviewerDef.prompt = `${reviewerDef.prompt ?? ''}\n\nPrevious iteration feedback:\n${stepState.reviewFeedback}`
      }

      startStep(run, reviewerDef, stepState)

      // DB: update with reviewer task ID
      if (stepState.currentIterationId && stepState.taskId) {
        workflowStore.updateIteration(stepState.currentIterationId, { reviewer_task_id: stepState.taskId })
      }

      ctx.logger.info('dag_review_loop_transition', {
        runId: run.id,
        step: sanitizeForLog(stepDef.name),
        iteration: stepState.reviewIteration,
        from: 'producer',
        to: 'reviewer',
      })
      saveAndBroadcast(run)
      return
    }

    // Monitor running task
    if (!stepState.taskId) return

    const task = taskStore.getTask(stepState.taskId)
    if (!task) {
      stepState.status = 'failed'
      stepState.errorMessage = 'task disappeared'
      stepState.completedAt = new Date().toISOString()
      releasePoolSlotIfHeld(stepState, run)
      saveAndBroadcast(run)
      return
    }

    // Still running - wait
    if (task.status !== 'completed' && task.status !== 'failed') return

    // Task failed
    if (task.status === 'failed') {
      stepState.status = 'failed'
      stepState.errorMessage = `${stepState.reviewSubStep} failed: ${task.errorMessage ?? 'unknown error'}`
      stepState.completedAt = new Date().toISOString()

      // DB: update iteration
      if (stepState.currentIterationId) {
        workflowStore.updateIteration(stepState.currentIterationId, {
          verdict: 'TASK_FAILED',
          completed_at: new Date().toISOString(),
        })
      }

      releasePoolSlotIfHeld(stepState, run)
      saveAndBroadcast(run)
      ctx.logger.info('dag_review_loop_failed', {
        runId: run.id,
        step: sanitizeForLog(stepDef.name),
        iteration: stepState.reviewIteration,
        subStep: stepState.reviewSubStep,
        error: sanitizeForLog(task.errorMessage ?? 'unknown'),
      })
      return
    }

    // Task completed — now safe to archive any deferred signal (BUG-1b: deferred from waiting_signal handler)
    if (stepState.pendingSignalArchivePath && stepState.signalDir) {
      archiveConsumedSignal(stepState.signalDir, stepState.pendingSignalArchivePath)
      stepState.pendingSignalArchivePath = undefined
    }

    // Task completed
    if (stepState.reviewSubStep === 'producer') {
      collectStepResult(run, stepDef.producer!, stepState)

      // Check for amendment signal
      if (stepState.signalDir) {
        const processed = getProcessedSignals(run.id, stepDef.name)
        const match: SignalMatch | null = checkStepSignals(stepState.signalDir, stepDef.name, stepState.startedAt ?? new Date().toISOString(), processed, run.id)
        if (match?.signal.signal_type === 'amendment_required') {
          stepState.status = 'paused_amendment'
          releasePoolSlotIfHeld(stepState, run)
          saveAndBroadcast(run)
          ctx.logger.info('dag_review_loop_amendment', {
            runId: run.id,
            step: sanitizeForLog(stepDef.name),
            iteration: stepState.reviewIteration,
            subStep: 'producer',
          })
          return
        }
      }

      // P-5 (REQ-28): Record producer completion timestamp for duration tracking
      if (stepState.currentIterationId) {
        const producerCompletedAt = new Date().toISOString()
        workflowStore.updateIteration(stepState.currentIterationId, {
          producer_completed_at: producerCompletedAt,
        })
      }

      // Release pool slot before requesting reviewer slot
      releasePoolSlotIfHeld(stepState, run)

      // Transition to 'between' state — set needsReviewerSlot flag
      // so the actual slot request happens on the NEXT tick,
      // giving other steps a chance to acquire the released slot (REQ-17)
      stepState.reviewSubStep = 'between'
      stepState.needsReviewerSlot = true
      stepState.taskId = null
      saveAndBroadcast(run)
      ctx.logger.info('dag_review_loop_producer_done', {
        runId: run.id,
        step: sanitizeForLog(stepDef.name),
        iteration: stepState.reviewIteration,
      })
      return
    }

    if (stepState.reviewSubStep === 'reviewer') {
      collectStepResult(run, stepDef.reviewer!, stepState)

      // Check for amendment signal
      if (stepState.signalDir) {
        const processed = getProcessedSignals(run.id, stepDef.name)
        const match: SignalMatch | null = checkStepSignals(stepState.signalDir, stepDef.name, stepState.startedAt ?? new Date().toISOString(), processed, run.id)
        if (match?.signal.signal_type === 'amendment_required') {
          stepState.status = 'paused_amendment'
          releasePoolSlotIfHeld(stepState, run)
          saveAndBroadcast(run)
          ctx.logger.info('dag_review_loop_amendment', {
            runId: run.id,
            step: sanitizeForLog(stepDef.name),
            iteration: stepState.reviewIteration,
            subStep: 'reviewer',
          })
          return
        }
      }

      // Extract verdict from reviewer output using YAML parsing
      const verdictField = stepDef.reviewer?.verdict_field ?? 'verdict'
      const feedbackField = stepDef.reviewer?.feedback_field
      let verdictResult = null as ReturnType<typeof readReviewerVerdict>

      // Try reading from reviewer's output file
      if (stepDef.reviewer?.result_file) {
        const outputPath = path.resolve(
          getChildOutputDir(run, stepState),
          stepDef.reviewer.result_file,
        )
        verdictResult = readReviewerVerdict(outputPath, verdictField, feedbackField)
      }

      // Fallback: try resultContent
      if (!verdictResult && stepState.resultContent) {
        const { verdict, warning } = normalizeVerdict(
          stepState.resultContent.match(new RegExp(`${verdictField}\\s*:\\s*(.+)`, 'i'))?.[1]?.trim() ?? 'FAIL'
        )
        verdictResult = {
          verdict,
          raw: stepState.resultContent.slice(0, 100),
          feedback: null,
          warning,
        }
      }

      // Fallback: extract verdict from task stdout (the tee'd output file)
      // Agents don't always write to the expected result_file path, but they
      // typically include the verdict in their stdout output.
      if (!verdictResult && stepState.taskId) {
        const reviewerTask = taskStore.getTask(stepState.taskId)
        if (reviewerTask?.outputPath && fs.existsSync(reviewerTask.outputPath)) {
          try {
            const taskOutput = fs.readFileSync(reviewerTask.outputPath, 'utf-8')
            // Look for verdict pattern in stdout
            const verdictMatch = taskOutput.match(new RegExp(`${verdictField}\\s*[:=]\\s*(.+)`, 'im'))
            if (verdictMatch) {
              const { verdict, warning } = normalizeVerdict(verdictMatch[1].trim())
              verdictResult = {
                verdict,
                raw: verdictMatch[1].trim(),
                feedback: null,
                warning: (warning ? warning + ' ' : '') + '(extracted from task stdout)',
              }
            }
            // Also try "Overall: PASS/FAIL" pattern common in reviewer output
            if (!verdictResult) {
              const overallMatch = taskOutput.match(/\bOverall\s*[:=]\s*(PASS|FAIL|APPROVE|APPROVED|REJECT|NEEDS_FIX)\b/i)
              if (overallMatch) {
                const { verdict, warning } = normalizeVerdict(overallMatch[1].trim())
                verdictResult = {
                  verdict,
                  raw: overallMatch[1].trim(),
                  feedback: null,
                  warning: (warning ? warning + ' ' : '') + '(extracted from "Overall:" in task stdout)',
                }
              }
            }
          } catch {
            // Ignore read errors
          }
        }
      }

      // Default to FAIL if no verdict found
      if (!verdictResult) {
        verdictResult = {
          verdict: 'FAIL',
          raw: 'no_verdict_found',
          feedback: null,
          warning: 'No verdict found in reviewer output, treating as FAIL.',
        }
      }

      const verdict = verdictResult.verdict
      const feedback = verdictResult.feedback
      stepState.reviewVerdict = verdict
      stepState.reviewFeedback = feedback

      if (verdictResult.warning) {
        ctx.logger.warn('dag_review_loop_verdict_warning', {
          runId: run.id,
          step: sanitizeForLog(stepDef.name),
          warning: verdictResult.warning,
        })
      }

      // DB: update iteration with verdict
      if (stepState.currentIterationId) {
        workflowStore.updateIteration(stepState.currentIterationId, {
          verdict,
          feedback,
          completed_at: new Date().toISOString(),
        })
      }

      // Release reviewer pool slot
      releasePoolSlotIfHeld(stepState, run)

      // Broadcast review iteration event
      ctx.broadcast({
        type: 'review_iteration',
        runId: run.id,
        stepName: stepDef.name,
        iteration: stepState.reviewIteration ?? 1,
        verdict,
      } as any)

      ctx.logger.info('dag_review_loop_verdict', {
        runId: run.id,
        step: sanitizeForLog(stepDef.name),
        iteration: stepState.reviewIteration,
        verdict,
      })

      // ── Verdict decision ──

      if (verdict === 'PASS') {
        buildAndWriteSummary('PASS')
        stepState.status = 'completed'
        stepState.completedAt = new Date().toISOString()
        saveAndBroadcast(run)
        return
      }

      if (verdict === 'CONCERN') {
        const onConcern = stepDef.on_concern ?? { timeout_minutes: 30, default_action: 'reject' }
        const timeoutMinutes = onConcern.timeout_minutes ?? 30
        const defaultAction = onConcern.default_action ?? 'reject'

        if (!stepState.concernWaitingSince) {
          stepState.concernWaitingSince = new Date().toISOString()
          stepState.concernResolution = null
          saveAndBroadcast(run)
          ctx.logger.info('dag_review_loop_concern', {
            runId: run.id,
            step: sanitizeForLog(stepDef.name),
            iteration: stepState.reviewIteration,
            timeoutMinutes,
            defaultAction,
          })
          return
        }

        // REQ-10: Check for human resolution before applying timeout default
        if (stepState.concernResolution === 'accept') {
          stepState.concernWaitingSince = null
          stepState.concernResolution = null
          ctx.logger.info('dag_review_loop_concern_human_accept', {
            runId: run.id,
            step: sanitizeForLog(stepDef.name),
            iteration: stepState.reviewIteration,
          })
          buildAndWriteSummary('accepted_with_warning')
          stepState.status = 'completed'
          stepState.completedWithWarning = true
          stepState.completedAt = new Date().toISOString()
          saveAndBroadcast(run)
          return
        }

        if (stepState.concernResolution === 'reject') {
          stepState.concernWaitingSince = null
          stepState.concernResolution = null
          ctx.logger.info('dag_review_loop_concern_human_reject', {
            runId: run.id,
            step: sanitizeForLog(stepDef.name),
            iteration: stepState.reviewIteration,
          })
          // reject → treat as FAIL, fall through to max_iterations check
        } else {
          // No human resolution yet — check timeout
          const elapsed = (Date.now() - new Date(stepState.concernWaitingSince).getTime()) / (1000 * 60)
          if (elapsed < timeoutMinutes) {
            return // Still waiting for human response or timeout
          }

          // Timeout reached without human response
          stepState.concernWaitingSince = null
          stepState.concernResolution = null
          ctx.logger.info('dag_review_loop_concern_timeout', {
            runId: run.id,
            step: sanitizeForLog(stepDef.name),
            iteration: stepState.reviewIteration,
            defaultAction,
          })

          if (defaultAction === 'accept') {
            buildAndWriteSummary('accepted_with_warning')
            stepState.status = 'completed'
            stepState.completedWithWarning = true
            stepState.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
            return
          }
          // reject → treat as FAIL, fall through to max_iterations check
        }
      }

      // FAIL/NEEDS_FIX: check if iterations remain
      if ((stepState.reviewIteration ?? 0) >= maxIter) {
        // Max iterations reached -- apply policy
        switch (onMaxIterations) {
          case 'accept_last':
            buildAndWriteSummary('accepted_with_warning')
            stepState.status = 'completed'
            stepState.completedWithWarning = true
            stepState.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
            ctx.logger.info('dag_review_loop_max_iterations', {
              runId: run.id,
              step: sanitizeForLog(stepDef.name),
              iterations: stepState.reviewIteration,
              policy: 'accept_last',
            })
            return

          case 'fail':
            buildAndWriteSummary('FAIL')
            stepState.status = 'failed'
            stepState.errorMessage = `review_loop '${stepDef.name}' exhausted ${maxIter} iterations with verdict: ${verdict}`
            stepState.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
            ctx.logger.info('dag_review_loop_max_iterations', {
              runId: run.id,
              step: sanitizeForLog(stepDef.name),
              iterations: stepState.reviewIteration,
              policy: 'fail',
            })
            return

          case 'escalate':
          default:
            buildAndWriteSummary('escalated')
            stepState.status = 'paused_human'
            saveAndBroadcast(run)
            ctx.logger.info('dag_review_loop_max_iterations', {
              runId: run.id,
              step: sanitizeForLog(stepDef.name),
              iterations: stepState.reviewIteration,
              policy: 'escalate',
            })
            return
        }
      }

      // Loop back to producer for next iteration
      // ROBUSTNESS-1 (REQ-36): DB-first iteration increment -- DB insert before memory update
      const { nextIteration, iterationId: newIterationId } = workflowStore.incrementAndInsertIteration(
        run.id,
        stepDef.name,
        stepState.reviewIteration ?? 0,
      )
      stepState.reviewIteration = nextIteration
      stepState.currentIterationId = newIterationId
      stepState.reviewSubStep = 'producer'
      stepState.taskId = null
      stepState.resultContent = null
      stepState.resultCollected = false
      stepState.status = 'running'

      // Inject feedback into producer prompt for next iteration
      const producerDef = { ...stepDef.producer! }
      if (feedback) {
        producerDef.prompt = `${producerDef.prompt ?? ''}\n\nReviewer feedback from iteration ${nextIteration - 1}:\n${feedback}`
      }

      // Request new pool slot for producer
      if (pool && parsed.system?.session_pool) {
        const result = pool.requestSlot({
          runId: run.id,
          stepName: stepDef.name,
          tier: runTier,
        })
        if (result.rejected || !result.slot) {
          return // Will retry on next tick
        }
        stepState.poolSlotId = result.slot.id
        if (result.slot.status === 'queued') {
          saveAndBroadcast(run)
          return
        }
      }

      startStep(run, producerDef, stepState)
      if (stepState.taskId) {
        workflowStore.updateIteration(newIterationId, { producer_task_id: stepState.taskId })
      }

      ctx.logger.info('dag_review_loop_iteration', {
        runId: run.id,
        step: sanitizeForLog(stepDef.name),
        iteration: nextIteration,
        subStep: 'producer',
      })
      saveAndBroadcast(run)
      return
    }
    } finally {
      reviewLoopProcessing.delete(guardKey)
    }
  }

  // ── Per-Work-Unit Container Processing (CRITICAL #1) ────────────────────

  /**
   * CRITICAL #1: Process per_work_unit container steps.
   * These expand into multiple children with parentGroup set.
   * Unlike parallel_group, children execute sequentially (no depends_on, no on_failure).
   */
  function processPerWorkUnitContainer(
    run: WorkflowRun,
    containerDef: WorkflowStep,
    containerState: StepRunState,
    stepDefMap: Map<string, WorkflowStep>,
    stateIndexMap: Map<string, number>,
    runTier: number,
    parsed: ParsedWorkflow,
  ): void {
    // Find all children in steps_state
    const childStates: { state: StepRunState; index: number; def: WorkflowStep }[] = []
    for (let i = 0; i < run.steps_state.length; i++) {
      const s = run.steps_state[i]
      if (s.parentGroup === containerDef.name) {
        const def = stepDefMap.get(s.name)
        if (def) childStates.push({ state: s, index: i, def })
      }
    }

    if (childStates.length === 0) {
      // No children found - mark container as completed
      containerState.status = 'completed'
      containerState.completedAt = new Date().toISOString()
      saveAndBroadcast(run)
      return
    }

    // Check if all children are terminal
    const allTerminal = childStates.every(c => TERMINAL_STATUSES.has(c.state.status))
    if (allTerminal) {
      const anyFailed = childStates.some(c => c.state.status === 'failed')
      if (anyFailed) {
        containerState.status = 'failed'
        const failedNames = childStates.filter(c => c.state.status === 'failed').map(c => c.state.name)
        containerState.errorMessage = `per_work_unit '${containerDef.name}': ${failedNames.length} of ${childStates.length} children failed. Failed: [${failedNames.join(', ')}].`
        containerState.completedAt = new Date().toISOString()
      } else {
        containerState.status = 'completed'
        containerState.completedAt = new Date().toISOString()
      }
      saveAndBroadcast(run)
      return
    }

    // Mark container as running if still pending
    if (containerState.status === 'pending') {
      containerState.status = 'running'
      containerState.startedAt = new Date().toISOString()
      saveAndBroadcast(run)
    }

    // Process children sequentially (find first non-terminal child and process it)
    for (const child of childStates) {
      if (TERMINAL_STATUSES.has(child.state.status)) continue

      // REQ-40: review_loop children manage their own pool slot and sub-step lifecycle
      if (child.def.type === 'review_loop') {
        if (child.state.status === 'pending') {
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
            const condResult = evaluateCondition(run, child.def.condition, parsed)
            if (!condResult.met) {
              child.state.status = 'skipped'
              child.state.skippedReason = condResult.reason ?? 'condition not met'
              child.state.completedAt = new Date().toISOString()
              saveAndBroadcast(run)
              continue
            }
          }
        }
        processReviewLoop(run, child.def, child.state, runTier, parsed)
        continue
      }

      if (child.state.status === 'pending') {
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
          const condResult = evaluateCondition(run, child.def.condition, parsed)
          if (!condResult.met) {
            child.state.status = 'skipped'
            child.state.skippedReason = condResult.reason ?? 'condition not met'
            child.state.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
            continue
          }
        }

        // Pool slot for spawn_session within per_work_unit
        if (child.def.type === 'spawn_session' && pool && parsed.system?.session_pool) {
          const result = pool.requestSlot({
            runId: run.id,
            stepName: child.def.name,
            tier: runTier,
          })
          if (result.rejected || !result.slot) {
            ctx.logger.warn('dag_pool_queue_full', {
              runId: run.id,
              step: sanitizeForLog(child.def.name),
              reason: result.reason,
            })
            continue
          }
          child.state.poolSlotId = result.slot.id
          if (result.slot.status === 'queued') {
            child.state.status = 'queued'
            saveAndBroadcast(run)
            ctx.broadcast({
              type: 'step_queued',
              runId: run.id,
              stepName: child.def.name,
              queuePosition: pool.getStatus().queue.length,
            })
            continue
          }
          ctx.broadcast({
            type: 'pool_slot_granted',
            runId: run.id,
            stepName: child.def.name,
            slotId: result.slot.id,
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
      if (child.state.status === 'running' || child.state.status === 'waiting_signal') {
        monitorStep(run, child.def, child.state)
      }

      // Only process one non-terminal child at a time (sequential execution)
      break
    }
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
    // P1-23: treat signal_error, signal_timeout, paused_starvation, paused_escalated as failures
    const CHILD_FAIL_TRIGGER = new Set(['failed', 'signal_error', 'signal_timeout', 'paused_starvation', 'paused_escalated'])
    const failedChildren = childStates.filter(c => CHILD_FAIL_TRIGGER.has(c.state.status))
    if (failedChildren.length > 0 && (onFailure === 'fail_fast' || onFailure === 'cancel_all')) {
      // M-02: Termination state machine -- advance in-progress terminations and initiate new ones
      let terminationsInProgress = false
      for (const child of childStates) {
        if (TERMINAL_STATUSES.has(child.state.status)) continue

        // REQ-39: For running spawn_session tasks under cancel_all, use termination state machine
        // Phase 7: Also handle waiting_signal status (signal protocol steps)
        if (onFailure === 'cancel_all' && (child.state.status === 'running' || child.state.status === 'waiting_signal') && child.def.type === 'spawn_session') {
          const done = terminateRunningChild(child.state, run, 'cancel_all')
          if (!done) {
            terminationsInProgress = true
            continue // Don't mark as cancelled yet -- state machine still in progress
          }
        } else if (onFailure === 'fail_fast' && (child.state.status === 'running' || child.state.status === 'waiting_signal') && child.def.type === 'spawn_session') {
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
      // P1-23: include signal_error, signal_timeout, paused_starvation, paused_escalated as failure
      const CHILD_FAILURE_STATUSES = new Set(['failed', 'signal_error', 'signal_timeout', 'paused_starvation', 'paused_escalated'])
      const anyFailed = childStates.some(c => CHILD_FAILURE_STATUSES.has(c.state.status))
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
      } else if (childStates.every(c => c.state.status === 'skipped')) {
        groupState.status = 'skipped'
        groupState.skippedReason = 'All children were skipped'
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
        const childTimeouts = (groupDef.steps ?? [])
          .map(c => c.timeoutSeconds).filter((t): t is number => t !== undefined)
        if (childTimeouts.length > 0) {
          effectiveTimeout = childTimeouts.reduce((sum, t) => sum + t, 0)
        }
      }
      if (effectiveTimeout !== undefined) {
        const elapsed = (Date.now() - new Date(groupState.startedAt).getTime()) / 1000
        if (elapsed > effectiveTimeout) {
          // Timeout: cancel pending, terminate running, fail group
          // P1-11: check terminateRunningChild return; if not done, wait for next tick
          let terminationsInProgress = false
          for (const child of childStates) {
            if (TERMINAL_STATUSES.has(child.state.status)) continue
            if (child.state.status === 'pending' || child.state.status === 'queued') {
              child.state.status = 'cancelled'
              child.state.completedAt = new Date().toISOString()
              releasePoolSlotIfHeld(child.state, run)
            } else if ((child.state.status === 'running' || child.state.status === 'waiting_signal') && child.def.type === 'spawn_session') {
              const done = terminateRunningChild(child.state, run, 'cancel_all')
              if (!done) {
                terminationsInProgress = true
                continue
              }
              child.state.status = 'cancelled'
              child.state.completedAt = new Date().toISOString()
              releasePoolSlotIfHeld(child.state, run)
            } else if (child.state.status === 'running') {
              child.state.status = 'cancelled'
              child.state.completedAt = new Date().toISOString()
            }
          }
          if (terminationsInProgress) {
            saveAndBroadcast(run)
            return
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
            const condResult = evaluateCondition(run, child.def.condition, parsed)
            if (!condResult.met) {
              child.state.status = 'skipped'
              child.state.skippedReason = condResult.reason ?? 'condition not met'
              child.state.completedAt = new Date().toISOString()
              saveAndBroadcast(run)
              continue
            }
          }
        }
        processReviewLoop(run, child.def, child.state, runTier, parsed)
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
          const condResult = evaluateCondition(run, child.def.condition, parsed)
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

          const result = pool.requestSlot({
            runId: run.id,
            stepName: child.def.name,
            tier: runTier,
          })
          // REQ-24: Queue full -- reject at slot-request level
          if (result.rejected || !result.slot) {
            ctx.logger.warn('dag_pool_queue_full', {
              runId: run.id,
              step: sanitizeForLog(child.def.name),
              reason: result.reason,
            })
            // Leave as pending; will retry on next tick when queue has room
            continue
          }
          child.state.poolSlotId = result.slot.id
          if (result.slot.status === 'queued') {
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
            slotId: result.slot.id,
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
      if (child.state.status === 'running' || child.state.status === 'waiting_signal') {
        monitorStep(run, child.def, child.state)
      }
    }
  }

  // ── Amendment Processing (Phase 10) ──────────────────────────────────

  function processAmendment(
    run: WorkflowRun,
    stepDef: WorkflowStep,
    stepState: StepRunState,
    runTier: number,
    parsed: ParsedWorkflow,
  ): void {
    const phase = stepState.amendmentPhase

    switch (phase) {
      case 'detected': {
        // Parse amendment from stored signal file
        if (!stepState.amendmentSignalFile) {
          stepState.status = 'failed'
          stepState.errorMessage = 'Amendment detected but no signal file recorded'
          stepState.completedAt = new Date().toISOString()
          saveAndBroadcast(run)
          return
        }

        let signalContent: Record<string, unknown>
        try {
          const raw = fs.readFileSync(stepState.amendmentSignalFile, 'utf-8')
          signalContent = yaml.load(raw) as Record<string, unknown>
        } catch {
          stepState.status = 'failed'
          stepState.errorMessage = 'Failed to read amendment signal file'
          stepState.completedAt = new Date().toISOString()
          saveAndBroadcast(run)
          return
        }

        const amendment = parseAmendmentSignal(signalContent)
        if (!amendment) {
          stepState.status = 'failed'
          stepState.errorMessage = 'Failed to parse amendment from signal file'
          stepState.completedAt = new Date().toISOString()
          saveAndBroadcast(run)
          return
        }

        // REQ-15: Fundamental amendments always escalate immediately
        if (isFundamental(amendment)) {
          stepState.status = 'paused_escalated'
          stepState.amendmentPhase = 'awaiting_human'
          ctx.broadcast({
            type: 'amendment_escalated',
            runId: run.id,
            stepName: stepState.name,
            reason: 'fundamental amendment requires human review',
          })
          ctx.logger.info('dag_amendment_escalated', {
            runId: run.id,
            step: sanitizeForLog(stepState.name),
            reason: 'fundamental',
          })
          saveAndBroadcast(run)
          return
        }

        // REQ-14: Same-section-twice check
        const config: AmendmentConfig = stepDef.amendment_config ?? {}
        if (config.same_section_twice === 'escalate' && amendment.amendment.spec_section) {
          const priorAmendments = workflowStore.getAmendmentsBySection(run.id, amendment.amendment.spec_section)
          if (priorAmendments.length > 0) {
            stepState.status = 'paused_escalated'
            stepState.amendmentPhase = 'awaiting_human'
            ctx.broadcast({
              type: 'amendment_escalated',
              runId: run.id,
              stepName: stepState.name,
              reason: `same section amended twice: ${amendment.amendment.spec_section}`,
            })
            ctx.logger.info('dag_amendment_escalated', {
              runId: run.id,
              step: sanitizeForLog(stepState.name),
              reason: 'same_section_twice',
              section: sanitizeForLog(amendment.amendment.spec_section),
            })
            saveAndBroadcast(run)
            return
          }
        }

        // REQ-10, REQ-11: Budget check with BEGIN IMMEDIATE transaction
        const category = amendment.amendment.category
        const workUnit = signalContent.work_unit ? String(signalContent.work_unit) : null
        const budgetResult = workflowStore.checkAndIncrementBudget(run.id, workUnit, category)

        if (!budgetResult.allowed) {
          // REQ-13: Budget exceeded -> escalate
          stepState.status = 'paused_escalated'
          stepState.amendmentPhase = 'awaiting_human'
          ctx.broadcast({
            type: 'amendment_escalated',
            runId: run.id,
            stepName: stepState.name,
            reason: `${category} budget exceeded (${budgetResult.used}/${budgetResult.max})`,
          })
          ctx.broadcast({
            type: 'budget_updated',
            runId: run.id,
            category,
            used: budgetResult.used,
            max: budgetResult.max,
          })
          ctx.logger.info('dag_amendment_budget_exceeded', {
            runId: run.id,
            step: sanitizeForLog(stepState.name),
            category,
            used: budgetResult.used,
            max: budgetResult.max,
          })

          // REQ-30: Log SCHEMA_GAP when quality budget exhausted
          if (category === 'quality') {
            const outputDir = run.output_dir
            if (outputDir) {
              try {
                const gapDir = path.join(outputDir, 'schema_gaps')
                if (!fs.existsSync(gapDir)) fs.mkdirSync(gapDir, { recursive: true })
                const gapFile = path.join(gapDir, `SCHEMA_GAP_${Date.now()}.yaml`)
                const gapRecord = {
                  run_id: run.id,
                  step: stepState.name,
                  category: 'quality_budget_exhausted',
                  amendment_type: stepState.amendmentType,
                  spec_section: stepState.amendmentSpecSection,
                  timestamp: new Date().toISOString(),
                }
                fs.writeFileSync(gapFile, yaml.dump(gapRecord), 'utf-8')
              } catch { /* best effort */ }
            }
          }

          saveAndBroadcast(run)
          return
        }

        // Record amendment in DB
        const amendmentId = workflowStore.insertAmendment({
          run_id: run.id,
          step_name: stepState.name,
          work_unit: workUnit ?? undefined,
          signal_file: stepState.amendmentSignalFile,
          amendment_type: amendment.amendment.type,
          category: amendment.amendment.category,
          spec_section: amendment.amendment.spec_section,
          issue: amendment.amendment.issue,
          proposed_change: amendment.amendment.proposed_addition,
        })
        stepState.amendmentSignalId = amendmentId

        // REQ-18: Check if human escalation needed
        if (shouldEscalateToHuman(amendment, config, runTier)) {
          stepState.status = 'paused_escalated'
          stepState.amendmentPhase = 'awaiting_human'
          ctx.broadcast({
            type: 'amendment_escalated',
            runId: run.id,
            stepName: stepState.name,
            reason: 'amendment requires human review',
          })
          saveAndBroadcast(run)
          return
        }

        // Auto-review: advance to handler_running
        if (shouldAutoReview(amendment, config)) {
          stepState.amendmentPhase = 'handler_running'
          stepState.amendmentRetryCount = 0
          ctx.logger.info('dag_amendment_auto_review', {
            runId: run.id,
            step: sanitizeForLog(stepState.name),
            type: amendment.amendment.type,
          })
          // Actual handler spawning happens on next tick when phase is handler_running
        } else {
          // Not auto-reviewable and not human-required = shouldn't happen, but escalate to be safe
          stepState.status = 'paused_escalated'
          stepState.amendmentPhase = 'awaiting_human'
        }

        saveAndBroadcast(run)
        return
      }

      case 'handler_running': {
        // REQ-06: Sequential amendment processing -- only one handler can be active at a time
        // Check if another step already has an active handler (hashandlerTaskId)
        const otherHandlerActive = run.steps_state.some(
          s => s.name !== stepState.name &&
               s.status === 'paused_amendment' &&
               s.amendmentPhase === 'handler_running' &&
               s.amendmentHandlerTaskId
        )

        // CF-1: Spawn real amendment handler session
        if (!stepState.amendmentHandlerTaskId) {
          // If another handler is active, wait for it to complete before spawning
          if (otherHandlerActive) {
            return  // Wait for the other handler to complete
          }
          // Parse the amendment signal to build handler prompt
          if (!stepState.amendmentSignalFile) {
            stepState.status = 'failed'
            stepState.errorMessage = 'Handler running but no signal file recorded'
            stepState.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
            return
          }

          let signalContent: Record<string, unknown>
          let amendment: AmendmentSignal | null
          try {
            const raw = fs.readFileSync(stepState.amendmentSignalFile, 'utf-8')
            signalContent = yaml.load(raw) as Record<string, unknown>
            amendment = parseAmendmentSignal(signalContent)
          } catch {
            stepState.status = 'failed'
            stepState.errorMessage = 'Failed to read amendment signal file for handler'
            stepState.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
            return
          }

          if (!amendment) {
            stepState.status = 'failed'
            stepState.errorMessage = 'Failed to parse amendment signal for handler'
            stepState.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
            return
          }

          // Request a pool slot for the handler session
          if (pool && parsed.system?.session_pool) {
            const result = pool.requestSlot({
              runId: run.id,
              stepName: `${stepState.name}:amendment-handler`,
              tier: runTier,
            })
            if (result.rejected || !result.slot) {
              // Pool full -- wait for slot
              return
            }
            stepState.poolSlotId = result.slot.id
            if (result.slot.status === 'queued') {
              saveAndBroadcast(run)
              return
            }
            ctx.broadcast({
              type: 'pool_slot_granted',
              runId: run.id,
              stepName: stepState.name,
              slotId: result.slot.id,
            })
          }

          // Build the handler prompt
          const specPath = stepDef.spec_path ?? path.join(run.output_dir, 'spec.md')
          const constitutionSections = stepDef.constitution_sections ?? []
          const checkpoint = amendment.checkpoint ?? {}

          const handlerPrompt = buildHandlerPrompt(
            amendment,
            specPath,
            constitutionSections,
            checkpoint,
          )

          // Build the resolution output path for the handler to write its result
          const outputDir = getChildOutputDir(run, stepState)
          try {
            if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })
          } catch { /* best effort */ }

          const resolutionPath = path.join(outputDir, `amendment-resolution-${stepState.name}.yaml`)

          // Create a task for the amendment handler agent
          const handlerTask = taskStore.createTask({
            projectPath: stepDef.projectPath ?? run.variables?.project_path ?? run.output_dir,
            prompt: `${handlerPrompt}\n\n## Resolution Output Path\nWrite your resolution to: ${resolutionPath}\n`,
            templateId: null,
            priority: 7, // Higher priority than normal tasks
            status: 'queued',
            maxRetries: 0,
            timeoutSeconds: (stepDef.amendment_config?.handler_timeout_seconds ?? 300),
          })

          // Set agent type metadata
          const metadataObj: Record<string, string> = {
            workflow_run_id: run.id,
            workflow_step_name: stepState.name,
            agent_type: 'amendment-handler',
            amendment_type: amendment.amendment.type,
            amendment_section: amendment.amendment.spec_section,
            resolution_path: resolutionPath,
          }
          taskStore.updateTask(handlerTask.id, { metadata: JSON.stringify(metadataObj) })

          stepState.amendmentHandlerTaskId = handlerTask.id
          stepState.amendmentHandlerStartedAt = new Date().toISOString() // P1-33: record handler spawn time
          stepState.startedAt = new Date().toISOString()

          ctx.logger.info('dag_amendment_handler_spawned', {
            runId: run.id,
            step: sanitizeForLog(stepState.name),
            taskId: handlerTask.id,
            amendmentType: amendment.amendment.type,
            specSection: sanitizeForLog(amendment.amendment.spec_section),
          })
          saveAndBroadcast(run)
          return
        }

        // Monitor running handler task for completion
        const handlerTask = taskStore.getTask(stepState.amendmentHandlerTaskId)
        if (!handlerTask) {
          // Task disappeared -- treat as failure, retry
          stepState.amendmentRetryCount = (stepState.amendmentRetryCount ?? 0) + 1
          if (stepState.amendmentRetryCount >= 2) {
            stepState.status = 'paused_escalated'
            stepState.amendmentPhase = 'awaiting_human'
            ctx.broadcast({
              type: 'amendment_escalated',
              runId: run.id,
              stepName: stepState.name,
              reason: 'handler task disappeared after max retries',
            })
          } else {
            stepState.amendmentHandlerTaskId = null  // Reset for retry
            releasePoolSlotIfHeld(stepState, run)
          }
          saveAndBroadcast(run)
          return
        }

        // Task still running -- check timeout then wait
        if (handlerTask.status !== 'completed' && handlerTask.status !== 'failed') {
          // Fall through to timeout check below
        } else if (handlerTask.status === 'failed') {
          // Handler task failed
          stepState.amendmentRetryCount = (stepState.amendmentRetryCount ?? 0) + 1
          releasePoolSlotIfHeld(stepState, run)
          if (stepState.amendmentRetryCount >= 2) {
            stepState.status = 'paused_escalated'
            stepState.amendmentPhase = 'awaiting_human'
            ctx.broadcast({
              type: 'amendment_escalated',
              runId: run.id,
              stepName: stepState.name,
              reason: `handler failed: ${handlerTask.errorMessage ?? 'unknown error'}`,
            })
            ctx.logger.warn('dag_amendment_handler_failed', {
              runId: run.id,
              step: sanitizeForLog(stepState.name),
              error: handlerTask.errorMessage ?? 'unknown',
              retries: stepState.amendmentRetryCount,
            })
          } else {
            stepState.amendmentHandlerTaskId = null  // Reset for retry
            ctx.logger.info('dag_amendment_handler_retry', {
              runId: run.id,
              step: sanitizeForLog(stepState.name),
              retry: stepState.amendmentRetryCount,
              reason: 'task_failed',
            })
          }
          saveAndBroadcast(run)
          return
        } else {
          // Handler completed -- check for resolution file and advance
          const outputDir = getChildOutputDir(run, stepState)
          const resolutionPath = path.join(outputDir, `amendment-resolution-${stepState.name}.yaml`)
          const resolution = readResolutionFile(resolutionPath)

          if (resolution) {
            // Store resolution info for handler_complete phase
            stepState.amendmentPhase = 'handler_complete'
            releasePoolSlotIfHeld(stepState, run)
            ctx.logger.info('dag_amendment_handler_complete', {
              runId: run.id,
              step: sanitizeForLog(stepState.name),
              resolution: resolution.resolution,
            })
          } else {
            // Handler completed but no valid resolution file -- auto-approve for gap/correction
            // (handler may have written output differently)
            stepState.amendmentPhase = 'handler_complete'
            releasePoolSlotIfHeld(stepState, run)
            ctx.logger.warn('dag_amendment_handler_no_resolution', {
              runId: run.id,
              step: sanitizeForLog(stepState.name),
              note: 'handler completed without resolution file, advancing to handler_complete',
            })
          }
          saveAndBroadcast(run)
          return
        }

        // Check handler timeout (REQ-19)
        // P1-33: use amendmentHandlerStartedAt (handler spawn time) not stepState.startedAt
        const handlerConfig: AmendmentConfig = stepDef.amendment_config ?? {}
        const timeoutMs = (handlerConfig.handler_timeout_seconds ?? 300) * 1000
        const handlerStartTime = stepState.amendmentHandlerStartedAt ?? stepState.startedAt
        if (handlerStartTime) {
          const elapsed = Date.now() - new Date(handlerStartTime).getTime()
          if (elapsed > timeoutMs) {
            stepState.amendmentRetryCount = (stepState.amendmentRetryCount ?? 0) + 1
            // REQ-20: Max retries (default 2)
            if (stepState.amendmentRetryCount >= 2) {
              stepState.status = 'paused_escalated'
              stepState.amendmentPhase = 'awaiting_human'
              ctx.broadcast({
                type: 'amendment_escalated',
                runId: run.id,
                stepName: stepState.name,
                reason: 'handler timeout after max retries',
              })
              ctx.logger.warn('dag_amendment_handler_timeout', {
                runId: run.id,
                step: sanitizeForLog(stepState.name),
                retries: stepState.amendmentRetryCount,
              })
            } else {
              // Retry: reset handler task
              stepState.amendmentHandlerTaskId = null
              ctx.logger.info('dag_amendment_handler_retry', {
                runId: run.id,
                step: sanitizeForLog(stepState.name),
                retry: stepState.amendmentRetryCount,
              })
            }
            saveAndBroadcast(run)
            return
          }
        }
        return
      }

      case 'handler_complete': {
        // REQ-47: Invalidation cycle detection
        stepState.invalidationCount = (stepState.invalidationCount ?? 0) + 1
        if (stepState.invalidationCount >= 3) {
          stepState.status = 'paused_escalated'
          stepState.amendmentPhase = 'awaiting_human'
          ctx.logger.warn('dag_amendment_invalidation_cycle', {
            runId: run.id,
            step: sanitizeForLog(stepState.name),
            invalidationCount: stepState.invalidationCount,
          })
          ctx.broadcast({
            type: 'amendment_escalated',
            runId: run.id,
            stepName: stepState.name,
            reason: `invalidation cycle detected (${stepState.invalidationCount} amendments on same step)`,
          })
          saveAndBroadcast(run)
          return
        }

        // CF-1/P-3: Read actual resolution from handler output file
        const outputDir = getChildOutputDir(run, stepState)
        const resolutionPath = path.join(outputDir, `amendment-resolution-${stepState.name}.yaml`)
        const handlerResolution = readResolutionFile(resolutionPath)

        // Determine resolution: read from file, or default to 'approved' if no file
        const actualResolution = handlerResolution?.resolution ?? 'approved'
        const resolvedBy = handlerResolution?.resolved_by ?? 'amendment-handler'

        // REQ-21/22: Resolution processing - support both approved and rejected
        if (stepState.amendmentSignalId) {
          workflowStore.resolveAmendment(stepState.amendmentSignalId, actualResolution, resolvedBy)
        }

        // CF-7/REQ-23/REQ-43/REQ-44: Write resolution file to disk for crash recovery
        if (stepState.signalDir && stepState.amendmentSignalFile) {
          try {
            // Read original signal to extract checkpoint
            const signalContent = readSignalFile(stepState.amendmentSignalFile)
            const checkpoint = signalContent?.checkpoint ?? null
            const signalFileName = path.basename(stepState.amendmentSignalFile)

            writeResolutionFile(
              stepState.signalDir,
              signalFileName,
              actualResolution,
              resolvedBy,
              checkpoint
            )
          } catch (err) {
            // Best effort - log but don't fail the resolution
            ctx.logger.warn('dag_resolution_file_write_failed', {
              runId: run.id,
              step: sanitizeForLog(stepState.name),
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }

        // P-3: Handle rejected amendments -- skip spec changes, resume with rejection note
        if (actualResolution === 'rejected') {
          // No spec changes for rejected amendments
          ctx.logger.info('dag_amendment_rejected', {
            runId: run.id,
            step: sanitizeForLog(stepState.name),
            reason: handlerResolution?.spec_changes ?? 'rejected by handler',
          })
        }

        // Build resume prompt for the paused step using checkpoint data
        let resumePrompt: string | null = null
        if (stepState.amendmentSignalFile) {
          try {
            const raw = fs.readFileSync(stepState.amendmentSignalFile, 'utf-8')
            const signalObj = yaml.load(raw) as Record<string, unknown>
            const amendment = parseAmendmentSignal(signalObj)
            if (amendment) {
              resumePrompt = buildResumePrompt(
                amendment.checkpoint ?? {},
                {
                  type: amendment.amendment.type,
                  spec_section: amendment.amendment.spec_section,
                  issue: amendment.amendment.issue,
                },
                actualResolution as 'approved' | 'rejected' | 'deferred',
              )
            }
          } catch {
            // Best effort -- resume without prompt if parsing fails
            ctx.logger.warn('dag_amendment_resume_prompt_failed', {
              runId: run.id,
              step: sanitizeForLog(stepState.name),
            })
          }
        }

        // Transition step back to running (resumed from checkpoint)
        stepState.status = 'running'
        stepState.amendmentPhase = null
        stepState.amendmentHandlerTaskId = null

        // CF-1: Spawn a resume session with checkpoint context if we have a resume prompt
        if (resumePrompt && stepDef.type === 'spawn_session') {
          // Create a new task for the resumed step with checkpoint context
          const resumeTask = taskStore.createTask({
            projectPath: stepDef.projectPath ?? run.variables?.project_path ?? run.output_dir,
            prompt: `${resumePrompt}\n\nOriginal task prompt:\n${stepDef.prompt ?? ''}`,
            templateId: null,
            priority: 5,
            status: 'queued',
            maxRetries: stepDef.maxRetries ?? 0,
            timeoutSeconds: stepDef.timeoutSeconds ?? 1800,
          })
          const metadataObj: Record<string, string> = {
            workflow_run_id: run.id,
            workflow_step_name: stepState.name,
            resume_after_amendment: 'true',
            amendment_resolution: actualResolution,
          }
          if (stepDef.agentType) {
            metadataObj.agent_type = stepDef.agentType
          }
          taskStore.updateTask(resumeTask.id, { metadata: JSON.stringify(metadataObj) })
          stepState.taskId = resumeTask.id
          stepState.startedAt = new Date().toISOString()

          ctx.logger.info('dag_amendment_resume_spawned', {
            runId: run.id,
            step: sanitizeForLog(stepState.name),
            taskId: resumeTask.id,
            resolution: actualResolution,
          })
        }

        // Output invalidation: amendment resolved — invalidate downstream steps
        // so they re-execute with the amended upstream output
        try {
          const oiStore = getOutputInvalidationStore()
          const depGraph = depGraphCache.get(run.id) ?? new Map<string, string[]>()
          const execCtx = { runId: run.id, outputDir: run.output_dir || '', logger: ctx.logger }
          invalidateDownstream(stepState.name, execCtx, oiStore, depGraph).catch(() => {})
        } catch {
          // Best effort
        }

        ctx.broadcast({
          type: 'amendment_resolved',
          runId: run.id,
          stepName: stepState.name,
          resolution: actualResolution,
        })

        ctx.logger.info('dag_amendment_resolved', {
          runId: run.id,
          step: sanitizeForLog(stepState.name),
          resolution: actualResolution,
        })

        saveAndBroadcast(run)
        return
      }

      case 'awaiting_human': {
        // REQ-46: State machine enforcement for paused_escalated
        // paused_escalated can only transition to 'running' (human resolution via API) or 'cancelled'
        // Guard: if somehow status drifted, force it back
        if (stepState.status !== 'paused_escalated' && stepState.status !== 'cancelled') {
          ctx.logger.warn('dag_amendment_invalid_state', {
            runId: run.id,
            step: sanitizeForLog(stepState.name),
            expectedStatus: 'paused_escalated',
            actualStatus: stepState.status,
          })
          stepState.status = 'paused_escalated'
          saveAndBroadcast(run)
        }
        // Human resolution comes through the REST API (WU-5)
        // Nothing else to do here in tick() -- wait for API call
        return
      }

      default: {
        // Unknown phase -- log and skip
        ctx.logger.warn('dag_amendment_unknown_phase', {
          runId: run.id,
          step: sanitizeForLog(stepState.name),
          phase: String(phase),
        })
        return
      }
    }
  }

  // ── Amendment Crash Recovery (Phase 10) ──────────────────────────────

  /**
   * Check if a tmux session exists.
   */
  function checkTmuxSession(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false
    try {
      const result = Bun.spawnSync(['tmux', 'has-session', '-t', sessionId], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      return result.exitCode === 0
    } catch {
      return false
    }
  }

  /**
   * Kill a tmux session if it exists.
   */
  function killTmuxSession(sessionId: string): void {
    try {
      Bun.spawnSync(['tmux', 'kill-session', '-t', sessionId], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
    } catch (err) {
      ctx.logger.warn('tmux_kill_session_failed', {
        sessionId,
        error: String(err),
      })
    }
  }

  /**
   * Recover amendment processing state after engine restart.
   * Called at start of tick() before the main step loop.
   */
  function recoverAmendments(run: WorkflowRun): void {
    for (const stepState of run.steps_state) {
      if (stepState.status !== 'paused_amendment') continue

      const phase = stepState.amendmentPhase

      // Scenario 1 (REQ-41): Mid-detect -- phase is 'detected' or null
      // Re-process from the beginning
      if (!phase || phase === 'detected') {
        if (stepState.amendmentSignalFile && fs.existsSync(stepState.amendmentSignalFile)) {
          // Signal file still exists, re-process from budget check
          ctx.logger.info('dag_amendment_recover', {
            runId: run.id,
            step: sanitizeForLog(stepState.name),
            scenario: 'mid_detect',
            action: 'reprocess',
          })
          stepState.amendmentPhase = 'detected'  // Ensure phase is set
          // processAmendment will handle it on next tick
        } else {
          // Signal file gone -- can't recover, fail the step
          stepState.status = 'failed'
          stepState.errorMessage = 'Amendment signal file missing after crash recovery'
          stepState.completedAt = new Date().toISOString()
          ctx.logger.warn('dag_amendment_recover', {
            runId: run.id,
            step: sanitizeForLog(stepState.name),
            scenario: 'mid_detect',
            action: 'failed_missing_signal',
          })
          saveAndBroadcast(run)
        }
      }

      // Scenario 2 (REQ-42): Mid-handler -- phase is 'handler_running'
      else if (phase === 'handler_running') {
        if (stepState.amendmentHandlerTaskId) {
          // If the task still exists in the store AND there's no signalDir to check,
          // skip recovery — processAmendment will handle it normally.
          // When signalDir IS set, recovery checks for resolution files and handles retries.
          const existingTask = taskStore.getTask(stepState.amendmentHandlerTaskId)
          if (existingTask && !stepState.signalDir) {
            // Task still tracked, no signal dir to check -- skip recovery
            continue
          }

          // Task has vanished -- genuine crash recovery
          ctx.logger.info('dag_amendment_recover', {
            runId: run.id,
            step: sanitizeForLog(stepState.name),
            scenario: 'mid_handler',
            action: 'check_handler',
          })

          // REQ-42: Check if tmux session exists and kill orphaned sessions
          const sessionExists = checkTmuxSession(stepState.amendmentHandlerTaskId)
          if (sessionExists) {
            killTmuxSession(stepState.amendmentHandlerTaskId)
            ctx.logger.info('dag_amendment_recover_killed_session', {
              runId: run.id,
              step: sanitizeForLog(stepState.name),
              sessionId: stepState.amendmentHandlerTaskId,
            })
          }

          // REQ-42: Release pool slot if held
          if (pool && stepState.amendmentHandlerTaskId) {
            pool.releaseSlot(stepState.amendmentHandlerTaskId)
            ctx.logger.info('dag_amendment_recover_released_slot', {
              runId: run.id,
              step: sanitizeForLog(stepState.name),
              slotId: stepState.amendmentHandlerTaskId,
            })
          }

          // Check for resolution file in signal dir
          const signalDir = stepState.signalDir
          if (signalDir && fs.existsSync(signalDir)) {
            const resolvedFiles = fs.readdirSync(signalDir).filter(f => f.includes('_resolved'))
            if (resolvedFiles.length > 0) {
              // Resolution found -- advance to handler_complete
              stepState.amendmentPhase = 'handler_complete'
              stepState.amendmentHandlerTaskId = null  // Clear handler task ID
              ctx.logger.info('dag_amendment_recover', {
                runId: run.id,
                step: sanitizeForLog(stepState.name),
                scenario: 'mid_handler',
                action: 'found_resolution',
              })
            } else {
              // No resolution -- clear handler task ID so processAmendment
              // re-spawns on the main loop (counts as implicit retry)
              stepState.amendmentHandlerTaskId = null  // Reset for retry
              stepState.amendmentRetryCount = (stepState.amendmentRetryCount ?? 0) + 1
              if (stepState.amendmentRetryCount >= 2) {
                stepState.status = 'paused_escalated'
                stepState.amendmentPhase = 'awaiting_human'
                ctx.logger.warn('dag_amendment_recover', {
                  runId: run.id,
                  step: sanitizeForLog(stepState.name),
                  scenario: 'mid_handler',
                  action: 'max_retries_escalated',
                })
              } else {
                ctx.logger.info('dag_amendment_recover', {
                  runId: run.id,
                  step: sanitizeForLog(stepState.name),
                  scenario: 'mid_handler',
                  action: 'retry',
                  retryCount: stepState.amendmentRetryCount,
                })
              }
            }
          } else {
            // No signal dir and task vanished -- clear handler task ID
            // and let processAmendment re-evaluate on the main loop.
            // If signal file is still available, it will re-spawn a handler.
            // If not, processAmendment will fail the step gracefully.
            stepState.amendmentHandlerTaskId = null
            ctx.logger.info('dag_amendment_recover', {
              runId: run.id,
              step: sanitizeForLog(stepState.name),
              scenario: 'mid_handler',
              action: 'cleared_vanished_handler',
            })
          }
        }
        // No handler task ID -- let processAmendment handle spawning on next tick
      }

      // Scenario 3 (REQ-43/44): Mid-resume -- phase is 'handler_complete'
      else if (phase === 'handler_complete') {
        // Resolution is ready but step wasn't resumed yet
        // processAmendment will handle it on next tick
        ctx.logger.info('dag_amendment_recover', {
          runId: run.id,
          step: sanitizeForLog(stepState.name),
          scenario: 'mid_resume',
          action: 'will_resume_next_tick',
        })
      }

      // Scenario 4 (REQ-48): Mid-budget-check
      // SQLite handles this via transaction rollback -- unresolved signal + no budget increment
      // means we re-run from 'detected' phase (covered by Scenario 1)
    }
  }

  /**
   * Ensure standard pipeline variables are populated in run.variables.
   * Called at tick() start — lazy initialization so variables are set regardless of how the run was created.
   * Persists variables directly to DB without touching steps_state (avoids race with async handlers).
   */
  // ── tickInner Helper Functions ──────────────────────────────────────

  /**
   * A2: Initialize branch isolation if enabled and not yet done.
   * Returns true if tick should exit early (isolation started or pending).
   */
  function initBranchIsolationIfNeeded(run: WorkflowRun, parsed: ParsedWorkflow): boolean {
    // Guard: skip if already done OR if already pending
    if (run.variables?.branch_isolation !== 'true') return false
    if (run.variables?._branch_isolation_done) return false
    if (run.variables?._branch_isolation_pending === 'true') return false

    const projectPath = run.variables.project_path || run.output_dir
    const fileList = run.variables.file_list ? run.variables.file_list.split(',') : ['*']
    const tier = getRunTier(run, parsed)

    // Track project path for periodic cleanup
    if (projectPath) seenProjectPaths.add(projectPath)

    // Build active runs list from currently running workflows
    const runningRuns = workflowStore.getRunningRuns()
    const activeRuns = runningRuns
      .filter(r => r.id !== run.id)
      .map(r => {
        const rFileList = r.variables?.file_list ? r.variables.file_list.split(',') : ['*']
        // Parse tier from variables or default to 1
        const rTier = r.variables?.tier ? parseInt(r.variables.tier, 10) || 1 : 1
        return { run_id: r.id, file_list: rFileList, tier: rTier }
      })

    // P1-34: set pending flag before async call so subsequent ticks skip step processing
    if (!run.variables) run.variables = {}
    run.variables._branch_isolation_pending = 'true'
    workflowStore.updateRun(run.id, { variables: run.variables })

    initBranchIsolation(run.id, fileList, tier, activeRuns, getBranchIsolationStore(), projectPath, 'HEAD')
      .then(result => {
        if (!run.variables) run.variables = {}
        if (result.isolated === true && result.worktreePath) {
          run.variables._original_project_path = run.variables.project_path || ''
          run.variables.project_path = result.worktreePath
          run.variables._worktree_path = result.worktreePath
          ctx.logger.info('branch_isolation_created', { runId: run.id, worktreePath: result.worktreePath })
        } else if (result.error) {
          ctx.logger.warn('branch_isolation_error', { runId: run.id, error: result.error })
        }
        run.variables._branch_isolation_done = 'true'
        run.variables._branch_isolation_pending = 'false'
        workflowStore.updateRun(run.id, { variables: run.variables })
        broadcastRunUpdate(run)
      })
      .catch(err => {
        ctx.logger.warn('branch_isolation_init_failed', { runId: run.id, error: String(err) })
        if (!run.variables) run.variables = {}
        // P1-41: set _branch_isolation_failed so callers can detect failure
        run.variables._branch_isolation_failed = 'true'
        run.variables._branch_isolation_done = 'true'
        run.variables._branch_isolation_pending = 'false'
        workflowStore.updateRun(run.id, { variables: run.variables })
      })

    return true // P1-34: skip step processing this tick while isolation initializes
  }

  /**
   * Process a pending step: tier filtering, condition evaluation, pool slot, and output invalidation.
   * Returns 'started' if step was started, 'skipped'/'queued' if handled, 'continue' if should retry.
   */
  function processPendingStep(
    run: WorkflowRun,
    stepDef: WorkflowStep,
    stepState: StepRunState,
    runTier: number,
    parsed: ParsedWorkflow,
  ): 'started' | 'skipped' | 'queued' | 'continue' {
    // Tier filtering
    const tierSkip = evaluateTierFilter(stepDef, runTier)
    if (tierSkip) {
      stepState.status = 'skipped'
      stepState.skippedReason = tierSkip
      stepState.completedAt = new Date().toISOString()
      saveAndBroadcast(run)
      return 'skipped'
    }

    // Condition evaluation
    if (stepDef.condition) {
      const condResult = evaluateCondition(run, stepDef.condition, parsed)
      if (!condResult.met) {
        stepState.status = 'skipped'
        stepState.skippedReason = condResult.reason ?? 'condition not met'
        stepState.completedAt = new Date().toISOString()
        saveAndBroadcast(run)
        return 'skipped'
      }
    }

    // Pool slot for spawn_session
    if (stepDef.type === 'spawn_session' && pool && parsed.system?.session_pool) {
      if (!POOL_BYPASS_TYPES.has(stepDef.type)) {
        const result = pool.requestSlot({
          runId: run.id,
          stepName: stepDef.name,
          tier: runTier,
        })
        // REQ-24: Queue full -- reject at slot-request level
        if (result.rejected || !result.slot) {
          ctx.logger.warn('dag_pool_queue_full', {
            runId: run.id,
            step: sanitizeForLog(stepDef.name),
            reason: result.reason,
          })
          // Leave as pending; will retry on next tick when queue has room
          return 'continue'
        }
        stepState.poolSlotId = result.slot.id
        if (result.slot.status === 'queued') {
          stepState.status = 'queued'
          saveAndBroadcast(run)
          ctx.broadcast({
            type: 'step_queued',
            runId: run.id,
            stepName: stepDef.name,
            queuePosition: pool.getStatus().queue.length,
          })
          return 'queued'
        }
        ctx.broadcast({
          type: 'pool_slot_granted',
          runId: run.id,
          stepName: stepDef.name,
          slotId: result.slot.id,
        })
      }
    }

    // Output invalidation check: if this step has dependencies, compute input hash
    // from parent outputs and check if cached output is still valid.
    if (stepDef.depends_on && stepDef.depends_on.length > 0) {
      try {
        const store = getOutputInvalidationStore()
        const parentOutputs = stepDef.depends_on
          .map(depName => {
            const depState = run.steps_state.find(s => s.name === depName)
            return depState?.resultContent ?? ''
          })
          .join('|')
        const inputHash = computeHash(parentOutputs)
        const execCtx = { runId: run.id, outputDir: run.output_dir || '', logger: ctx.logger }

        // Synchronous check: look up existing record and compare input hash
        const existing = store.getStepOutput(run.id, stepState.name)
        const isInvalidated = existing
          ? (!existing.valid || (existing.input_hash !== '' && existing.input_hash !== inputHash))
          : false

        if (isInvalidated) {
          const depGraph = depGraphCache.get(run.id) ?? new Map<string, string[]>()
          // invalidateDownstream is async but performs sync SQLite ops -- fire and forget
          invalidateDownstream(stepState.name, execCtx, store, depGraph).catch(() => {})

          const breaker = checkCircuitBreaker(run.id, store)
          if (breaker.shouldPause) {
            stepState.status = 'paused_human' as StepRunState['status']
            stepState.errorMessage = `Circuit breaker: ${breaker.invalidationCount} invalidations in run`
            stepState.completedAt = new Date().toISOString()
            saveAndBroadcast(run)
            ctx.logger.warn('output_invalidation_circuit_breaker', {
              runId: run.id,
              step: sanitizeForLog(stepState.name),
              invalidationCount: breaker.invalidationCount,
            })
            return 'skipped'
          }
        }
      } catch {
        // Best effort -- invalidation check should not block step execution
      }
    }

    // Start the step
    startStep(run, stepDef, stepState)
    return 'started'
  }

  /**
   * Monitor a running or waiting_signal step with error handling.
   */
  function monitorRunningStep(run: WorkflowRun, stepDef: WorkflowStep, stepState: StepRunState): void {
    try {
      monitorStep(run, stepDef, stepState)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      stepState.status = 'failed'
      stepState.errorMessage = `monitor error: ${errorMsg}`
      stepState.completedAt = new Date().toISOString()
      releasePoolSlotIfHeld(stepState, run) // P0-8: release slot on monitor exception
      saveAndBroadcast(run)
      ctx.logger.error('dag_monitor_step_exception', {
        runId: run.id,
        step: sanitizeForLog(stepDef.name),
        error: sanitizeForLog(errorMsg),
      })
    }
  }

  /**
   * Ensure standard pipeline variables are populated in run.variables.
   * Called at tick() start — lazy initialization so variables are set regardless of how the run was created.
   * Persists variables directly to DB without touching steps_state (avoids race with async handlers).
   */
  function ensureStandardVariables(run: WorkflowRun): void {
    if (!run.variables) run.variables = {}
    let changed = false

    // run_dir = the run's output directory
    if (!run.variables.run_dir && run.output_dir) {
      run.variables.run_dir = run.output_dir
      changed = true
    }

    // output_dir = same as run.output_dir for top-level steps
    if (!run.variables.output_dir && run.output_dir) {
      run.variables.output_dir = run.output_dir
      changed = true
    }

    if (changed) {
      // Persist only variables — don't saveAndBroadcast which would overwrite steps_state
      workflowStore.updateRun(run.id, { variables: run.variables })

      // Ensure run directory exists
      if (run.output_dir) {
        try {
          if (!fs.existsSync(run.output_dir)) {
            fs.mkdirSync(run.output_dir, { recursive: true })
          }
        } catch { /* best effort */ }
      }
    }
  }

  // ── Main Tick ─────────────────────────────────────────────────────────

  function tick(run: WorkflowRun, parsed: ParsedWorkflow): void {
    // P1-13: Re-entrancy guard — skip if tick is already executing
    if (tickInProgress) {
      ctx.logger.warn('dag_tick_reentrant', { runId: run.id })
      return
    }
    tickInProgress = true
    try {
      tickInner(run, parsed)
    } catch (err) {
      // P0-4: Track consecutive exceptions; after 3, fail the run
      const key = run.id
      const count = (tickExceptionCounts.get(key) ?? 0) + 1
      tickExceptionCounts.set(key, count)
      const errorMsg = err instanceof Error ? err.message : String(err)
      ctx.logger.error('dag_tick_exception', { runId: run.id, count, error: sanitizeForLog(errorMsg) })
      if (count >= 3) {
        tickExceptionCounts.delete(key)
        run.status = 'failed'
        run.error_message = `tick() threw ${count} consecutive exceptions: ${errorMsg}`
        workflowStore.updateRun(run.id, { status: run.status, error_message: run.error_message })
        broadcastRunUpdate(run)
      }
    } finally {
      tickInProgress = false
    }
  }

  function tickInner(run: WorkflowRun, parsed: ParsedWorkflow): void {
    // Reset exception counter on successful tick entry
    tickExceptionCounts.delete(run.id)

    // P0-6: If run was cancelled externally, propagate cancellation to all running/pending steps
    if (run.status === 'cancelled') {
      let changed = false
      for (const stepState of run.steps_state) {
        if (!TERMINAL_STATUSES.has(stepState.status)) {
          stepState.status = 'cancelled'
          stepState.completedAt = new Date().toISOString()
          releasePoolSlotIfHeld(stepState, run)
          changed = true
        }
      }
      if (changed) saveAndBroadcast(run)
      return
    }

    // Auto-populate standard variables on first tick
    ensureStandardVariables(run)

    // A2: Branch isolation — create worktree on first tick if enabled
    if (initBranchIsolationIfNeeded(run, parsed)) return;

    // P1-34: if branch isolation is in progress, skip step processing
    if (run.variables?.branch_isolation === 'true' && run.variables?._branch_isolation_pending === 'true') {
      return;
    }

    // (branch isolation body extracted to initBranchIsolationIfNeeded helper)

    // P1-34: if branch isolation is in progress, skip step processing
    if (run.variables?.branch_isolation === 'true' && run.variables?._branch_isolation_pending === 'true') {
      return
    }

    // A4: Periodic expired worktree cleanup
    tickCount++
    if (tickCount % CLEANUP_TICK_INTERVAL === 0) {
      for (const pp of seenProjectPaths) {
        cleanupExpiredWorktrees(getBranchIsolationStore(), pp).catch(err => {
          ctx.logger.warn('expired_worktree_cleanup_error', { projectPath: pp, error: String(err) })
        })
      }
    }

    // Output invalidation: build dependency graph on first tick per run
    if (!run.variables?._dep_graph_built) {
      const effectiveStepsForGraph = getEffectiveSteps(run, parsed)
      if (effectiveStepsForGraph) {
        const depGraph = buildDependencyGraph(effectiveStepsForGraph)
        depGraphCache.set(run.id, depGraph)
        if (!run.variables) run.variables = {}
        run.variables._dep_graph_built = 'true'
        workflowStore.updateRun(run.id, { variables: run.variables })
      }
    }

    const steps = getEffectiveSteps(run, parsed)
    if (!steps) {
      failWorkflow(run, 'Cannot parse workflow steps', parsed) // P1-42: pass parsed for cleanup hooks
      return
    }

    const stepDefMap = buildStepDefMap(steps)
    hydratePerWorkUnitChildDefs(run, stepDefMap)
    const stateIndexMap = buildStateIndexMap(run.steps_state)
    const runTier = getRunTier(run, parsed)

    // Check for completion: all top-level steps + children in terminal state
    const allTerminal = run.steps_state.every(s => TERMINAL_STATUSES.has(s.status))
    if (allTerminal) {
      // Phase 15: Run step-level on_error cleanup for failed steps (REQ-24)
      for (const s of run.steps_state) {
        if (s.status === 'failed' && !s.cleanupState) {
          const def = stepDefMap.get(s.name)
          if (def?.on_error && def.on_error.length > 0) {
            runCleanupActions(run, def.on_error, 'step', s).catch(err => {
              ctx.logger.warn('step_cleanup_error', { runId: run.id, stepName: s.name, error: String(err) })
            })
          }
        }
      }

      // REQ-08: Only check top-level steps for workflow failure
      // Phase 7: signal_timeout and signal_error are also failure conditions
      // paused_starvation: pool exhaustion is treated as terminal failure. Operator must increase pool size and restart the run.
      const FAILURE_STATUSES = new Set(['failed', 'signal_timeout', 'signal_error', 'paused_escalated', 'paused_human', 'paused_starvation'])
      const anyFailed = run.steps_state.some(s => !s.parentGroup && FAILURE_STATUSES.has(s.status))
      if (anyFailed) {
        failWorkflow(run, 'One or more steps failed', parsed)
      } else {
        completeWorkflow(run)
      }
      return
    }

    // Phase 10: Recover amendment state after crash
    recoverAmendments(run)

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

      // Dependency check applies to ALL step types before they can start processing.
      // Steps already running/waiting_signal are not re-checked (they've already started).
      if (stepState.status === 'pending') {
        if (!areTopLevelDependenciesMet(run, i, stateIndexMap, stepDefMap)) continue
      }

      // Handle parallel_group
      if (stepDef.type === 'parallel_group') {
        processParallelGroup(run, stepDef, stepState, stepDefMap, stateIndexMap, runTier, parsed)
        continue
      }

      // CRITICAL #1: Handle per_work_unit container steps
      // These have children with parentGroup set, similar to parallel_group
      if (stepState.isPerWorkUnitContainer) {
        processPerWorkUnitContainer(run, stepDef, stepState, stepDefMap, stateIndexMap, runTier, parsed)
        continue
      }

      // Handle review_loop at top level
      if (stepDef.type === 'review_loop') {
        processReviewLoop(run, stepDef, stepState, runTier, parsed)
        continue
      }

      // Phase 10: Process amendment steps
      if (stepState.status === 'paused_amendment') {
        processAmendment(run, stepDef, stepState, runTier, parsed)
        continue
      }

      // For top-level non-group steps: tier filtering, condition, pool, and output invalidation
      if (stepState.status === 'pending') {
        const result = processPendingStep(run, stepDef, stepState, runTier, parsed);
        if (result !== 'started') continue;
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
      if (stepState.status === 'running' || stepState.status === 'waiting_signal') {
        try {
          monitorStep(run, stepDef, stepState)
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          stepState.status = 'failed'
          stepState.errorMessage = `monitor error: ${errorMsg}`
          stepState.completedAt = new Date().toISOString()
          releasePoolSlotIfHeld(stepState, run) // P0-8: release slot on monitor exception
          saveAndBroadcast(run)
          ctx.logger.error('dag_monitor_step_exception', {
            runId: run.id,
            step: sanitizeForLog(stepDef.name),
            error: sanitizeForLog(errorMsg),
          })
        }
      }
    }
  }

  // ── Phase 25: Check condition helpers ──────────────────────────────

  /**
   * Build a ConditionContext for evaluating check-level conditions.
   * Includes project_profile data so conditions like "model_routing.enabled == true"
   * and "compiler_ir.hir_enabled" resolve correctly.
   */
  function buildCheckConditionContext(run: WorkflowRun): ConditionContext {
    // Build step outputs from completed steps — always include status
    const stepOutputs: Record<string, Record<string, unknown>> = {}
    for (const ss of run.steps_state) {
      const base: Record<string, unknown> = { status: ss.status }
      if (ss.resultContent) {
        try {
          const obj = JSON.parse(ss.resultContent)
          if (typeof obj === 'object' && obj !== null) {
            Object.assign(base, obj)
          } else {
            base._raw = ss.resultContent
          }
        } catch {
          base._raw = ss.resultContent
        }
      }
      stepOutputs[ss.name] = base
    }

    // Load project profile if project_path is available
    let projectProfile: Record<string, unknown> | undefined
    const projectPath = run.variables?.project_path
    if (projectPath) {
      try {
        projectProfile = loadProjectProfileRaw(projectPath)
      } catch {
        // No profile available — conditions referencing it will resolve to unmatched strings
      }
    }

    // Determine tier from run variables or workflow definition
    let tier = 1
    if (run.variables?.tier) {
      const tierNum = parseInt(run.variables.tier, 10)
      if (!isNaN(tierNum)) tier = tierNum
    } else {
      // Try to get default_tier from the workflow definition
      const workflow = workflowStore.getWorkflow(run.workflow_id)
      if (workflow) {
        const result = parseWorkflowYAML(workflow.yaml_content)
        if (result.valid && result.workflow?.default_tier !== undefined) {
          tier = result.workflow.default_tier
        }
      }
    }

    return {
      tier,
      stepOutputs,
      variables: run.variables ?? {},
      projectProfile,
    }
  }

  /**
   * Evaluate a string condition expression for check-level conditions.
   * Wraps the conditionEvaluator's evaluateExpression with a ConditionContext.
   */
  function evaluateExpressionForChecks(expr: string, condCtx: ConditionContext): boolean {
    // Detect semantic English conditions that can't be parsed as expressions
    // e.g. "any model has invocation: proxy", "all values in X are valid"
    const SEMANTIC_KEYWORDS = /\b(any|all|every|has|are|valid|contains|each|must|should)\b/i
    if (SEMANTIC_KEYWORDS.test(expr) && !expr.includes('==') && !expr.includes('!=') && !expr.includes('>=')) {
      ctx.logger.info('dag_check_condition_semantic_skip', { expr })
      return false // Skip — can't evaluate semantic English conditions
    }

    try {
      return evaluateExpression(expr, condCtx)
    } catch {
      // If expression evaluation fails, skip the check (conservative)
      ctx.logger.warn('dag_check_condition_eval_error', { expr })
      return false
    }
  }

  /**
   * Resolve {{ variable }} template syntax in condition expression strings.
   * Lightweight wrapper — only resolves template vars, doesn't alter expression structure.
   */
  function resolveTemplateVarsInExpr(
    expr: string,
    run: WorkflowRun,
    projectProfile?: Record<string, unknown>,
  ): string {
    if (!expr.includes('{{')) return expr
    return resolveTemplateVars(expr, run, projectProfile)
  }

  /**
   * Phase 25: Resolve {{ variable }} template syntax in pipeline YAML strings.
   * Resolves from run.variables first, then project_profile dotted paths.
   */
  function resolveTemplateVars(
    template: string,
    run: WorkflowRun,
    projectProfile?: Record<string, unknown>,
  ): string {
    // Match {{ key }}, {{ key | filter('arg') }}, and {{ key | filter(arg) }}
    return template.replace(/\{\{\s*([\w./-]+)(?:\s*\|\s*(\w+)\(([^)]*)\))?\s*\}\}/g, (_m, key: string, filter?: string, filterArgs?: string) => {
      // Resolve variable value (raw, may be array/object)
      const vars = run.variables ?? {}
      let rawVal: unknown = undefined

      // Check run variables first (flat lookup)
      if (key in vars) {
        rawVal = vars[key]
      }

      // Check project profile for dotted paths
      if (rawVal === undefined && projectProfile && key.includes('.')) {
        rawVal = getNestedProfileValue(projectProfile, key)
      }

      // Check project profile for top-level keys
      if (rawVal === undefined && projectProfile && key in projectProfile) {
        rawVal = projectProfile[key]
      }

      // Apply filter if present
      if (filter && rawVal !== undefined) {
        const args = filterArgs ? filterArgs.split(',').map(a => a.trim().replace(/^['"]|['"]$/g, '')) : []
        switch (filter) {
          case 'join': {
            const sep = args[0] ?? ' '
            if (Array.isArray(rawVal)) return rawVal.join(sep)
            return String(rawVal)
          }
          case 'default': {
            const val = rawVal === undefined || rawVal === '' || rawVal === null ? args[0] ?? '' : rawVal
            return String(val)
          }
          default:
            return rawVal !== undefined ? String(rawVal) : ''
        }
      }

      // No filter — apply default filter for 'default' case
      if (filter === 'default' && rawVal === undefined) {
        const args = filterArgs ? filterArgs.split(',').map(a => a.trim().replace(/^['"]|['"]$/g, '')) : []
        return args[0] ?? ''
      }

      return rawVal !== undefined ? String(rawVal) : '' // Unresolved — empty string
    })
  }

  /** Traverse nested object by dotted path (e.g. "model_routing.litellm.base_url") */
  function getNestedProfileValue(obj: Record<string, unknown>, dotPath: string): unknown {
    const parts = dotPath.split('.')
    let current: unknown = obj
    for (const part of parts) {
      if (current && typeof current === 'object' && !Array.isArray(current) && part in (current as Record<string, unknown>)) {
        current = (current as Record<string, unknown>)[part]
      } else {
        return undefined
      }
    }
    return current
  }

  return { tick }
}
