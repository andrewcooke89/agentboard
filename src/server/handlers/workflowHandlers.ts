// workflowHandlers.ts - REST API handlers for workflow management (WO-007)
import type { Hono } from 'hono'
import fs from 'node:fs/promises'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ServerContext } from '../serverContext'
import { parseWorkflowYAML, validateVariables } from '../workflowSchema'
import type { StepRunState } from '../../shared/types'
import { sanitizeForLog } from '../validators'
import { loadProjectProfile } from '../projectProfile'
import { expandPerWorkUnit, type ExpansionContext } from '../perWorkUnitEngine'
import yaml from 'js-yaml'

/** Kebab-case: lowercase letters, digits, and hyphens only. No path separators. */
const KEBAB_CASE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Input size limits */
const MAX_YAML_SIZE = 1024 * 1024 // 1MB
const MAX_DESCRIPTION_LENGTH = 10000
const MAX_NAME_LENGTH = 100

export function createWorkflowHandlers(ctx: ServerContext, pool?: import('../sessionPool').SessionPool | null) {
  const { workflowStore, config, broadcast, logger } = ctx

  function registerRoutes(app: Hono): void {
    // ─── Workflow CRUD ────────────────────────────────────────────────

    app.get('/api/workflows', (c) => {
      const status = c.req.query('status') as 'valid' | 'invalid' | undefined
      const validStatus = status === 'valid' || status === 'invalid' ? status : undefined
      const workflows = workflowStore.listWorkflows(validStatus ? { status: validStatus } : undefined)
      return c.json({ workflows })
    })

    app.get('/api/workflows/:id', (c) => {
      const id = c.req.param('id')
      const workflow = workflowStore.getWorkflow(id)
      if (!workflow) return c.json({ error: 'Workflow not found' }, 404)
      return c.json(workflow)
    })

    // Body field is 'yaml_content' (not 'yaml' per original spec — more descriptive)
    app.post('/api/workflows', async (c) => {
      let body: Record<string, unknown>
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400)
      }

      const { yaml_content, name, description } = body as {
        yaml_content?: string
        name?: string
        description?: string
      }

      if (!yaml_content || typeof yaml_content !== 'string') {
        return c.json({ error: 'yaml_content is required' }, 400)
      }

      if (!name || typeof name !== 'string') {
        return c.json({ error: 'name is required' }, 400)
      }

      if (!KEBAB_CASE_RE.test(name)) {
        return c.json({ error: `name must be kebab-case (lowercase letters, digits, hyphens): ${sanitizeForLog(name)}` }, 400)
      }

      // Input size limits
      if (yaml_content.length > MAX_YAML_SIZE) {
        return c.json({ error: `yaml_content exceeds maximum size (${MAX_YAML_SIZE} bytes)` }, 400)
      }
      if (name && name.length > MAX_NAME_LENGTH) {
        return c.json({ error: `name exceeds maximum length (${MAX_NAME_LENGTH} chars)` }, 400)
      }
      if (description && description.length > MAX_DESCRIPTION_LENGTH) {
        return c.json({ error: `description exceeds maximum length (${MAX_DESCRIPTION_LENGTH} chars)` }, 400)
      }

      // Parse and validate YAML
      const result = parseWorkflowYAML(yaml_content)
      const isValid = result.valid
      const validationErrors = result.errors

      // Check name uniqueness
      const existing = workflowStore.getWorkflowByName(name)
      if (existing) {
        return c.json({ error: `Workflow with name "${sanitizeForLog(name)}" already exists` }, 409)
      }

      // Path traversal defense-in-depth
      const filePath = path.join(config.workflowDir, `${name}.yaml`)
      const normalizedPath = path.resolve(filePath)
      if (!normalizedPath.startsWith(path.resolve(config.workflowDir) + path.sep)) {
        return c.json({ error: 'Invalid workflow name' }, 400)
      }

      // Write YAML file
      try {
        await fs.mkdir(config.workflowDir, { recursive: true })
        await fs.writeFile(filePath, yaml_content, 'utf8')
      } catch (err) {
        logger.error('workflow_file_write_failed', { name: sanitizeForLog(name), error: String(err) })
        return c.json({ error: 'Failed to write workflow file' }, 500)
      }

      // Create in DB
      const workflow = workflowStore.createWorkflow({
        name,
        description: description ? String(description) : null,
        yaml_content,
        file_path: filePath,
        is_valid: isValid,
        validation_errors: validationErrors,
        step_count: result.workflow?.steps.length ?? 0,
      })

      logger.info('workflow_created', { id: workflow.id, name: sanitizeForLog(name) })
      return c.json(workflow, 201)
    })

    app.put('/api/workflows/:id', async (c) => {
      const id = c.req.param('id')
      const workflow = workflowStore.getWorkflow(id)
      if (!workflow) return c.json({ error: 'Workflow not found' }, 404)

      let body: Record<string, unknown>
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400)
      }

      // Input size limits
      if (body.yaml_content !== undefined && String(body.yaml_content).length > MAX_YAML_SIZE) {
        return c.json({ error: `yaml_content exceeds maximum size (${MAX_YAML_SIZE} bytes)` }, 400)
      }
      if (body.name !== undefined && String(body.name).length > MAX_NAME_LENGTH) {
        return c.json({ error: `name exceeds maximum length (${MAX_NAME_LENGTH} chars)` }, 400)
      }
      if (body.description !== undefined && String(body.description).length > MAX_DESCRIPTION_LENGTH) {
        return c.json({ error: `description exceeds maximum length (${MAX_DESCRIPTION_LENGTH} chars)` }, 400)
      }

      const updates: Record<string, unknown> = {}

      if (body.yaml_content !== undefined) {
        const yamlContent = String(body.yaml_content)
        const result = parseWorkflowYAML(yamlContent)
        updates.yaml_content = yamlContent
        updates.is_valid = result.valid
        updates.validation_errors = result.errors
        updates.step_count = result.workflow?.steps.length ?? 0
      }

      if (body.name !== undefined) {
        updates.name = String(body.name)
      }

      if (body.description !== undefined) {
        updates.description = body.description ? String(body.description) : null
      }

      const updated = workflowStore.updateWorkflow(id, updates)

      // Write updated YAML to file if yaml_content changed and file_path exists
      if (body.yaml_content !== undefined && workflow.file_path) {
        try {
          await fs.writeFile(workflow.file_path, String(body.yaml_content), 'utf8')
        } catch (err) {
          logger.error('workflow_file_update_failed', { id, error: String(err) })
        }
      }

      return c.json(updated)
    })

    app.delete('/api/workflows/:id', async (c) => {
      const id = c.req.param('id')
      const workflow = workflowStore.getWorkflow(id)
      if (!workflow) return c.json({ error: 'Workflow not found' }, 404)

      // Check for active runs before deletion
      if (workflowStore.hasActiveRunsForWorkflow(id)) {
        return c.json({ error: 'Cannot delete workflow with active runs (running or pending)' }, 409)
      }

      // Delete file if it exists
      if (workflow.file_path) {
        try {
          await fs.unlink(workflow.file_path)
        } catch (err) {
          logger.warn('workflow_file_delete_failed', { id, filePath: sanitizeForLog(workflow.file_path), error: String(err) })
        }
      }

      workflowStore.deleteWorkflow(id)
      broadcast({ type: 'workflow-removed', workflowId: id })
      logger.info('workflow_deleted', { id, name: sanitizeForLog(workflow.name) })
      return c.json({ ok: true })
    })

    // ─── Workflow Runs ────────────────────────────────────────────────

    app.get('/api/workflows/:id/runs', (c) => {
      const id = c.req.param('id')
      const workflow = workflowStore.getWorkflow(id)
      if (!workflow) return c.json({ error: 'Workflow not found' }, 404)
      const runs = workflowStore.listRunsByWorkflow(id)
      return c.json({ runs })
    })

    app.post('/api/workflows/:id/run', async (c) => {
      const id = c.req.param('id')
      const workflow = workflowStore.getWorkflow(id)
      if (!workflow) return c.json({ error: 'Workflow not found' }, 404)

      if (!workflow.is_valid) {
        return c.json({ error: 'Workflow is not valid' }, 400)
      }

      // Parse workflow to get steps and variable definitions
      const parsed = parseWorkflowYAML(workflow.yaml_content)
      if (!parsed.valid || !parsed.workflow) {
        return c.json({ error: 'Workflow YAML is invalid' }, 400)
      }

      // Parse optional variables from request body
      let providedVars: Record<string, string> = {}
      try {
        const body = await c.req.json()
        if (body && typeof body === 'object' && body.variables && typeof body.variables === 'object') {
          const vars = body.variables as Record<string, unknown>
          for (const [key, value] of Object.entries(vars)) {
            // Reject prototype pollution keys
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
              return c.json({ error: `Invalid variable name: "${sanitizeForLog(key)}"` }, 400)
            }
            if (typeof value !== 'string') {
              return c.json({ error: `Variable "${sanitizeForLog(key)}" must be a string` }, 400)
            }
            if (key.length > 128) {
              return c.json({ error: `Variable name "${sanitizeForLog(key.slice(0, 50))}" exceeds 128 chars` }, 400)
            }
            if (value.length > 50000) {
              return c.json({ error: `Variable "${sanitizeForLog(key)}" value exceeds 50KB` }, 400)
            }
            providedVars[key] = value
          }
        }
      } catch {
        // No body or invalid JSON — that's fine, variables are optional
      }

      // Auto-detect tier from spec file count when tier is absent, "auto", or "1" (default)
      if (providedVars.spec_path && (!providedVars.tier || providedVars.tier === 'auto' || providedVars.tier === '1')) {
        try {
          const specContent = readFileSync(providedVars.spec_path, 'utf8')
          const specDoc = yaml.load(specContent) as Record<string, unknown>
          // Collect files from common spec fields: scope.included, affected_files, files, changes[].file
          const fileSet = new Set<string>()
          const scopeIncluded = (specDoc?.scope as Record<string, unknown>)?.included
          if (Array.isArray(scopeIncluded)) {
            for (const f of scopeIncluded) { if (typeof f === 'string') fileSet.add(f) }
          }
          for (const field of ['affected_files', 'files'] as const) {
            const val = specDoc?.[field]
            if (Array.isArray(val)) {
              for (const f of val) { if (typeof f === 'string') fileSet.add(f) }
            }
          }
          const changes = specDoc?.changes
          if (Array.isArray(changes)) {
            for (const c of changes) {
              if (c && typeof c === 'object' && typeof (c as Record<string, unknown>).file === 'string') {
                fileSet.add((c as Record<string, unknown>).file as string)
              }
            }
          }
          if (fileSet.size > 0) {
            const fileCount = fileSet.size
            const detectedTier = fileCount <= 2 ? '1' : fileCount <= 5 ? '2' : '3'
            logger.info('tier_auto_detected', { specPath: sanitizeForLog(providedVars.spec_path), fileCount, tier: detectedTier })
            providedVars.tier = detectedTier
          }
        } catch (err) {
          logger.warn('tier_auto_detect_failed', { specPath: sanitizeForLog(providedVars.spec_path), error: String(err) })
        }
      }

      // Validate declared variables
      let mergedVars: Record<string, string> | null = null
      if (parsed.workflow.variables.length > 0) {
        const { errors: varErrors, merged } = validateVariables(parsed.workflow.variables, providedVars)
        if (varErrors.length > 0) {
          return c.json({ error: 'Variable validation failed', details: varErrors }, 400)
        }
        mergedVars = merged
      }

      // Phase 9: Load project_profile and merge into variables
      // Priority: builtins < env (AGENTBOARD_*) < profile < pipeline vars < run-time vars
      {
        // Collect AGENTBOARD_* env vars
        const envVars: Record<string, string> = {}
        for (const [key, value] of Object.entries(process.env)) {
          if (key.startsWith('AGENTBOARD_') && value !== undefined) {
            envVars[key] = value
          }
        }

        // Load project profile (if any project path is available)
        let profileVars: Record<string, string> = {}
        const projectPath = providedVars.project_path || process.env.AGENTBOARD_PROJECT_PATH
        if (projectPath) {
          profileVars = loadProjectProfile(projectPath)
        }

        // Merge with correct priority: env < profile < declared/provided vars
        if (Object.keys(envVars).length > 0 || Object.keys(profileVars).length > 0) {
          const base = { ...envVars, ...profileVars }
          if (mergedVars) {
            mergedVars = { ...base, ...mergedVars }
          } else if (Object.keys(providedVars).length > 0) {
            mergedVars = { ...base, ...providedVars }
          } else if (Object.keys(base).length > 0) {
            mergedVars = base
          }
        }

        // Add builtins (lowest priority — only set if not already present)
        if (mergedVars) {
          if (!('output_dir' in mergedVars)) {
            // output_dir will be set after run creation, but provide a placeholder
          }
        }
      }

      // Phase 5: Queue depth limit (REQ-24) -- only when session_pool enabled (REQ-37).
      // CF-02 Clarification:
      //   "Pool full" = all active slots occupied (steps queue waiting for a slot).
      //   "Queue full" = the waiting queue itself has reached max depth (backpressure).
      // This run-submission check is a FIRST LINE of defense. The authoritative
      // queue depth enforcement is inside sessionPool.requestSlot() (CF-01), which
      // rejects individual slot requests when the queue is at capacity.
      // REQ-37: Legacy (non-pool) workflows bypass this entirely and use
      // TASK_MAX_CONCURRENT instead.
      if (parsed.workflow.system?.session_pool && pool) {
        const maxDepth = pool.getMaxQueueDepth()
        const poolStatus = pool.getStatus()
        if (poolStatus.queue.length >= maxDepth) {
          return c.json({
            error: `Pool queue full (${poolStatus.queue.length} pending). Wait for current runs to complete or increase pool size.`,
            code: 'POOL_QUEUE_FULL',
            queueDepth: poolStatus.queue.length,
            maxDepth,
          }, 429)
        }
      }

      const stepsState: StepRunState[] = []
      // Use a single run output directory for both expansion context and persisted run state.
      const runOutputDir = path.join(config.workflowDir, 'runs', `${workflow.name}-${Date.now()}`)

      for (const step of parsed.workflow.steps) {
        // P1-2: Expand per_work_unit steps into sub-steps
        if (step.per_work_unit) {
          const expansionCtx: ExpansionContext = {
            runId: 'pending', // Will be set after run creation
            outputDir: runOutputDir,
            defaultAgent: step.agent,
            variables: mergedVars,
          }
          try {
            const expandedSteps = expandPerWorkUnit(step, expansionCtx)
            for (const expanded of expandedSteps) {
              stepsState.push({
                name: expanded.name,
                type: expanded.step.type,
                status: 'pending' as const,
                taskId: null,
                startedAt: null,
                completedAt: null,
                errorMessage: null,
                retryCount: 0,
                skippedReason: null,
                resultFile: expanded.step.result_file ?? null,
                resultCollected: false,
                resultContent: null,
                parentGroup: step.name, // Track parent step for per_work_unit
                ...(expanded.step.tier_min != null ? { tier_min: expanded.step.tier_min } : {}),
                ...(expanded.step.tier_max != null ? { tier_max: expanded.step.tier_max } : {}),
              })
            }
            // Also add the parent step as a container (completed immediately)
            stepsState.push({
              name: step.name,
              type: step.type,
              status: 'pending' as const,
              taskId: null,
              startedAt: null,
              completedAt: null,
              errorMessage: null,
              retryCount: 0,
              skippedReason: null,
              resultFile: step.result_file ?? null,
              resultCollected: false,
              resultContent: null,
              isPerWorkUnitContainer: true,
              ...(step.tier_min != null ? { tier_min: step.tier_min } : {}),
              ...(step.tier_max != null ? { tier_max: step.tier_max } : {}),
            })
          } catch (expansionError) {
            // If expansion fails, add the step as-is with an error marker
            logger.warn('per_work_unit_expansion_failed', {
              step: step.name,
              error: String(expansionError),
            })
            stepsState.push({
              name: step.name,
              type: step.type,
              status: 'pending' as const,
              taskId: null,
              startedAt: null,
              completedAt: null,
              errorMessage: `per_work_unit expansion failed: ${expansionError}`,
              retryCount: 0,
              skippedReason: null,
              resultFile: step.result_file ?? null,
              resultCollected: false,
              resultContent: null,
              ...(step.tier_min != null ? { tier_min: step.tier_min } : {}),
              ...(step.tier_max != null ? { tier_max: step.tier_max } : {}),
            })
          }
          continue
        }

        stepsState.push({
          name: step.name,
          type: step.type,
          status: 'pending' as const,
          taskId: null,
          startedAt: null,
          completedAt: null,
          errorMessage: null,
          retryCount: 0,
          skippedReason: null,
          resultFile: step.result_file ?? null,
          resultCollected: false,
          resultContent: null,
          ...(step.tier_min != null ? { tier_min: step.tier_min } : {}),
          ...(step.tier_max != null ? { tier_max: step.tier_max } : {}),
        })
        // Phase 5: Flatten parallel_group children into steps_state
        if (step.type === 'parallel_group' && step.steps) {
          for (const child of step.steps) {
            stepsState.push({
              name: child.name,
              type: child.type,
              status: 'pending' as const,
              taskId: null,
              startedAt: null,
              completedAt: null,
              errorMessage: null,
              retryCount: 0,
              skippedReason: null,
              resultFile: child.result_file ?? null,
              resultCollected: false,
              resultContent: null,
              parentGroup: step.name,
              ...(child.tier_min != null ? { tier_min: child.tier_min } : {}),
              ...(child.tier_max != null ? { tier_max: child.tier_max } : {}),
            })
          }
        }
      }

      // Atomic check-and-create: prevents TOCTOU race on concurrent run limit
      const run = workflowStore.createRunIfUnderLimit({
        workflow_id: id,
        workflow_name: workflow.name,
        status: 'running',
        current_step_index: 0,
        steps_state: stepsState,
        output_dir: runOutputDir,
        started_at: new Date().toISOString(),
        completed_at: null,
        error_message: null,
        variables: mergedVars,
      }, config.workflowMaxConcurrentRuns)

      if (!run) {
        return c.json({
          error: 'Concurrent workflow run limit reached',
          code: 'RATE_LIMIT_EXCEEDED',
          limit: config.workflowMaxConcurrentRuns,
        }, 429)
      }

      // Create the output directory on disk so downstream steps can write to it
      try {
        mkdirSync(run.output_dir, { recursive: true })
      } catch (err) {
        logger.error('workflow_output_dir_creation_failed', {
          runId: run.id,
          outputDir: sanitizeForLog(run.output_dir),
          error: String(err),
        })
        // Don't fail the request — engine will create it if needed
      }

      // Phase 10: Initialize amendment budgets for the run
      const budgetConfig: { quality?: { per_run?: number }; reconciliation?: { per_run?: number } } = {}

      const pipelineDefaults = parsed.workflow?.defaults ?? {}
      if (pipelineDefaults.amendment_budget) {
        const ab = pipelineDefaults.amendment_budget as Record<string, unknown>
        if (ab.quality && typeof ab.quality === 'object') {
          budgetConfig.quality = ab.quality as { per_run?: number }
        }
        if (ab.reconciliation && typeof ab.reconciliation === 'object') {
          budgetConfig.reconciliation = ab.reconciliation as { per_run?: number }
        }
      }

      for (const step of parsed.workflow.steps) {
        if (step.amendment_budget) {
          if (step.amendment_budget.quality?.per_work_unit !== undefined ||
              step.amendment_budget.reconciliation?.per_work_unit !== undefined) {
            workflowStore.initWorkUnitBudgets(run.id, step.name, step.amendment_budget)
          }
        }
      }

      workflowStore.initRunBudgets(run.id, budgetConfig)

      broadcast({ type: 'workflow-run-update', run })
      logger.info('workflow_run_triggered', { runId: run.id, workflowId: id, name: sanitizeForLog(workflow.name) })
      return c.json(run, 201)
    })

    // ─── Run Operations ───────────────────────────────────────────────

    app.get('/api/workflow-runs/:runId', (c) => {
      const runId = c.req.param('runId')
      const run = workflowStore.getRun(runId)
      if (!run) return c.json({ error: 'Workflow run not found' }, 404)
      return c.json(run)
    })

    app.post('/api/workflow-runs/:runId/resume', (c) => {
      const runId = c.req.param('runId')
      const run = workflowStore.getRun(runId)
      if (!run) return c.json({ error: 'Workflow run not found' }, 404)

      if (run.status !== 'failed') {
        return c.json({ error: `Cannot resume run with status: ${run.status}` }, 400)
      }

      // Reset current failed step to pending and set run status to running
      const updatedSteps = [...run.steps_state]
      const currentStep = updatedSteps[run.current_step_index]
      if (currentStep && currentStep.status === 'failed') {
        updatedSteps[run.current_step_index] = {
          ...currentStep,
          status: 'pending',
          errorMessage: null,
        }
      }

      const updated = workflowStore.updateRun(runId, {
        status: 'running',
        steps_state: updatedSteps,
      })

      if (updated) {
        broadcast({ type: 'workflow-run-update', run: updated })
      }

      return c.json(updated)
    })

    app.post('/api/workflow-runs/:runId/cancel', (c) => {
      const runId = c.req.param('runId')
      const run = workflowStore.getRun(runId)
      if (!run) return c.json({ error: 'Workflow run not found' }, 404)

      if (run.status !== 'running') {
        return c.json({ error: `Cannot cancel run with status: ${run.status}` }, 400)
      }

      // Cancel current step's task if it's a spawn_session with a taskId
      const currentStep = run.steps_state[run.current_step_index]
      if (currentStep?.type === 'spawn_session' && currentStep.taskId) {
        const task = ctx.taskStore.getTask(currentStep.taskId)
        if (task && task.status === 'running' && task.tmuxWindow) {
          try {
            const result = Bun.spawnSync(['tmux', 'kill-window', '-t', task.tmuxWindow], {
              stdout: 'pipe',
              stderr: 'pipe',
            })
            if (result.exitCode !== 0) {
              logger.warn('tmux_kill_window_failed', {
                runId,
                taskId: currentStep.taskId,
                tmuxWindow: task.tmuxWindow,
                exitCode: result.exitCode,
                stderr: result.stderr?.toString() ?? '',
              })
            }
          } catch (err) {
            logger.warn('tmux_kill_window_error', {
              runId,
              taskId: currentStep.taskId,
              tmuxWindow: task.tmuxWindow,
              error: String(err),
            })
          }
          // Always mark the task as cancelled regardless of tmux kill outcome
          ctx.taskStore.updateTask(currentStep.taskId, { status: 'cancelled' })
        }
      }

      const updated = workflowStore.updateRun(runId, {
        status: 'cancelled',
        completed_at: new Date().toISOString(),
      })

      if (updated) {
        broadcast({ type: 'workflow-run-update', run: updated })
      }

      logger.info('workflow_run_cancelled', { runId })
      return c.json(updated)
    })

    // ─── Run Result Endpoints ─────────────────────────────────────────

    app.get('/api/workflow-runs/:runId/steps/:stepIndex/result', (c) => {
      const { runId, stepIndex: stepIndexStr } = c.req.param()
      const stepIndex = Number(stepIndexStr)
      if (!Number.isInteger(stepIndex) || stepIndex < 0) {
        return c.json({ error: 'Invalid stepIndex' }, 400)
      }

      const run = ctx.workflowStore.getRun(runId)
      if (!run) return c.json({ error: 'Run not found' }, 404)

      const stepState = run.steps_state[stepIndex]
      if (!stepState) return c.json({ error: 'Invalid stepIndex' }, 400)

      if (!stepState.resultFile) {
        return c.json({ error: 'Step does not declare a result_file' }, 404)
      }
      if (!stepState.resultCollected || stepState.resultContent == null) {
        return c.json({ error: 'Result not collected' }, 404)
      }

      // Try to parse as JSON; fall back to raw text
      let content: unknown
      let contentType: 'json' | 'text' = 'text'
      try {
        content = JSON.parse(stepState.resultContent)
        contentType = 'json'
      } catch {
        content = stepState.resultContent
      }

      return c.json({
        stepName: stepState.name,
        stepIndex,
        resultFile: stepState.resultFile,
        contentType,
        content,
      })
    })

    app.get('/api/workflow-runs/:runId/results', (c) => {
      const { runId } = c.req.param()
      const run = ctx.workflowStore.getRun(runId)
      if (!run) return c.json({ error: 'Run not found' }, 404)

      const results = run.steps_state
        .map((step, idx) => ({
          stepIndex: idx,
          stepName: step.name,
          status: step.status,
          resultFile: step.resultFile ?? null,
          resultCollected: step.resultCollected ?? false,
          hasContent: step.resultContent != null,
        }))
        .filter(r => r.resultFile != null)

      return c.json({ runId, results })
    })

    // Phase 8: Review loop iterations endpoint
    app.get('/api/workflow-runs/:runId/review-loops/:stepName/iterations', (c) => {
      const { runId, stepName } = c.req.param()
      const run = workflowStore.getRun(runId)
      if (!run) return c.json({ error: 'Run not found' }, 404)
      const iterations = workflowStore.getIterationsByStep(runId, stepName)
      return c.json({ iterations })
    })

    // Phase 8 REQ-10: Human concern resolution endpoint
    app.post('/api/workflow-runs/:runId/steps/:stepName/concern-response', async (c) => {
      const { runId, stepName } = c.req.param()

      const run = workflowStore.getRun(runId)
      if (!run) return c.json({ error: 'Run not found' }, 404)

      const stepIndex = run.steps_state.findIndex(s => s.name === stepName)
      if (stepIndex === -1) return c.json({ error: 'Step not found' }, 404)

      const stepState = run.steps_state[stepIndex]
      if (!stepState.concernWaitingSince) {
        return c.json({ error: 'Step is not waiting for concern resolution' }, 400)
      }

      let body: Record<string, unknown>
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400)
      }

      const action = body.action
      if (action !== 'accept' && action !== 'reject') {
        return c.json({ error: 'action must be "accept" or "reject"' }, 400)
      }

      // Set concern resolution on the step state
      const updatedSteps = [...run.steps_state]
      updatedSteps[stepIndex] = { ...updatedSteps[stepIndex], concernResolution: action }
      const updated = workflowStore.updateRun(runId, { steps_state: updatedSteps })

      if (updated) {
        broadcast({ type: 'workflow-run-update', run: updated })
      }

      logger.info('workflow_concern_response', {
        runId,
        stepName: sanitizeForLog(stepName),
        action,
      })

      return c.json({ success: true })
    })

    // Phase 10: Human amendment resolution endpoint
    app.post('/api/workflow-runs/:runId/signals/:signalId/resolve', async (c) => {
      // SEC-2: Authentication check - verify Bearer token is present
      const authorization = c.req.header('Authorization')
      if (!authorization || !authorization.startsWith('Bearer ')) {
        return c.json({
          error: 'Unauthorized',
          message: 'Missing or invalid Authorization header',
          code: 'AUTH_001'
        }, 401)
      }

      // SEC-2: Authorization check - verify caller has admin/human authority
      // Check for X-User-Role header to distinguish human/admin from automated systems
      const userRole = c.req.header('X-User-Role')
      if (userRole && userRole !== 'human' && userRole !== 'admin') {
        return c.json({
          error: 'Forbidden',
          message: 'Only human or admin users can resolve amendments',
          code: 'AUTH_003'
        }, 403)
      }

      const { runId, signalId } = c.req.param()

      const run = workflowStore.getRun(runId)
      if (!run) return c.json({ error: 'Run not found' }, 404)

      const signals = workflowStore.getUnresolvedSignals(runId)
      const signal = signals.find(s => s.id === signalId)
      if (!signal) return c.json({ error: 'Unresolved signal not found' }, 404)

      const stepState = run.steps_state.find(
        s => s.status === 'paused_escalated' && s.amendmentPhase === 'awaiting_human'
      )
      if (!stepState) return c.json({ error: 'No escalated step found for this signal' }, 404)

      let body: { action: string; reason?: string }
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400)
      }

      const { action, reason } = body
      if (!action || !['approve', 'reject', 'defer'].includes(action)) {
        return c.json({ error: "action must be 'approve', 'reject', or 'defer'" }, 400)
      }

      workflowStore.resolveSignal(signalId, action, null)

      if (stepState.amendmentSignalId) {
        workflowStore.resolveAmendment(stepState.amendmentSignalId, action, 'human')
      }

      if (action === 'approve') {
        stepState.status = 'paused_amendment'
        stepState.amendmentPhase = 'handler_complete'
      } else if (action === 'reject') {
        stepState.status = 'paused_amendment'
        stepState.amendmentPhase = 'handler_complete'
      } else {
        stepState.status = 'running'
        stepState.amendmentPhase = null
        stepState.amendmentHandlerTaskId = null
      }

      workflowStore.updateRun(runId, { steps_state: run.steps_state })

      broadcast({
        type: 'amendment_resolved',
        runId,
        stepName: stepState.name,
        resolution: action,
      })

      logger.info('amendment_resolved_by_human', {
        runId,
        signalId,
        stepName: stepState.name,
        action,
        reason: reason ?? '',
      })

      return c.json({ success: true, action, stepName: stepState.name })
    })

    // Phase 10: Budget override endpoint
    app.post('/api/workflow-runs/:runId/budget-override', async (c) => {
      const { runId } = c.req.param()

      const run = workflowStore.getRun(runId)
      if (!run) return c.json({ error: 'Run not found' }, 404)

      let body: { category: string; new_max: number; work_unit?: string; reason?: string }
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400)
      }

      const { category, new_max, work_unit, reason } = body
      if (!category || !['quality', 'reconciliation'].includes(category)) {
        return c.json({ error: "category must be 'quality' or 'reconciliation'" }, 400)
      }
      if (typeof new_max !== 'number' || new_max <= 0 || !Number.isInteger(new_max)) {
        return c.json({ error: 'new_max must be a positive integer' }, 400)
      }

      // SEC-4: Enforce upper bound on budget overrides
      const MAX_BUDGET_OVERRIDE = 1000
      if (new_max > MAX_BUDGET_OVERRIDE) {
        return c.json({
          error: 'Budget override too large',
          max_allowed: MAX_BUDGET_OVERRIDE,
          requested: new_max,
        }, 400)
      }

      // SEC-4: Log large overrides to audit trail
      if (new_max > 100) {
        logger.warn('large_budget_override', {
          runId,
          category,
          new_max,
          work_unit: work_unit ?? 'run-level',
          reason: reason ?? '',
        })
      }

      workflowStore.overrideBudget(runId, category, new_max, work_unit)

      const escalatedStep = run.steps_state.find(
        s => s.status === 'paused_escalated' &&
             s.amendmentPhase === 'awaiting_human' &&
             s.amendmentCategory === category
      )
      if (escalatedStep) {
        escalatedStep.status = 'paused_amendment'
        escalatedStep.amendmentPhase = 'detected'
        workflowStore.updateRun(runId, { steps_state: run.steps_state })
      }

      broadcast({
        type: 'budget_updated',
        runId,
        category,
        used: 0,
        max: new_max,
      })

      logger.info('amendment_budget_override', {
        runId,
        category,
        newMax: new_max,
        workUnit: work_unit ?? 'run-level',
        reason: reason ?? '',
      })

      return c.json({ success: true, category, new_max })
    })

    // Phase 15: PATCH amendment-budget endpoint (REQ-22)
    app.patch('/api/workflow-runs/:runId/amendment-budget', async (c) => {
      const runId = c.req.param('runId')
      if (!runId) return c.json({ error: 'Missing run ID' }, 400)

      const run = workflowStore.getRun(runId)
      if (!run) return c.json({ error: 'Run not found' }, 404)

      let body: { category?: string; new_max?: number }
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400)
      }

      const { category, new_max: newMax } = body
      if (!category || (category !== 'quality' && category !== 'reconciliation')) {
        return c.json({ error: 'category must be "quality" or "reconciliation"' }, 400)
      }
      if (typeof newMax !== 'number' || newMax <= 0 || !Number.isFinite(newMax)) {
        return c.json({ error: 'new_max must be a positive number' }, 400)
      }

      try {
        workflowStore.overrideBudget(runId, category, newMax)

        // Resume any escalated step waiting on this budget category
        const escalatedStep = run.steps_state.find(
          s => s.status === 'paused_escalated' &&
               s.amendmentPhase === 'awaiting_human' &&
               s.amendmentCategory === category
        )

        if (escalatedStep) {
          escalatedStep.status = 'paused_amendment'
          escalatedStep.amendmentPhase = 'detected'
          workflowStore.updateRun(run.id, { steps_state: run.steps_state })
        }

        logger.info('amendment_budget_extended', {
          runId,
          category,
          newMax,
          hadEscalatedStep: !!escalatedStep,
        })

        return c.json({
          ok: true,
          category,
          new_max: newMax,
          resumed_step: escalatedStep?.name ?? null,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return c.json({ error: msg }, 500)
      }
    })

    // Long-poll: wait for run status or step change
    app.get('/api/workflow-runs/:runId/wait', async (c) => {
      const runId = c.req.param('runId')
      const currentStatus = c.req.query('current_status')
      const currentStep = c.req.query('current_step')
      const timeout = Math.min(Number(c.req.query('timeout') || 600), 600)

      if (!currentStatus) {
        return c.json({ error: 'current_status query param is required' }, 400)
      }

      function stripRun(run: ReturnType<typeof workflowStore.getRun>) {
        if (!run) return null
        return {
          ...run,
          steps_state: run.steps_state.map(
            ({ resultContent: _resultContent, reviewFeedback: _reviewFeedback, reviewIterations: _reviewIterations, detectedSignals: _detectedSignals, childSteps: _childSteps, ...rest }: StepRunState) => rest
          ),
        }
      }

      const deadline = Date.now() + timeout * 1000

      while (Date.now() < deadline) {
        const run = workflowStore.getRun(runId)
        if (!run) return c.json({ error: 'Run not found' }, 404)

        const changed =
          run.status !== currentStatus ||
          (currentStep !== undefined && String(run.current_step_index) !== currentStep)

        if (changed) {
          return c.json({ timeout: false, run: stripRun(run) })
        }

        // Sleep in small increments so we can detect deadline expiry accurately
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        await Bun.sleep(Math.min(3000, remaining))
      }

      const run = workflowStore.getRun(runId)
      return c.json({ timeout: true, run: run ? stripRun(run) : null })
    })

    // Phase 10: Amendment history endpoint
    app.get('/api/workflow-runs/:runId/amendments', (c) => {
      const { runId } = c.req.param()

      const run = workflowStore.getRun(runId)
      if (!run) return c.json({ error: 'Run not found' }, 404)

      const amendments = workflowStore.getAmendmentsByRun(runId)

      const qualityBudget = workflowStore.getBudget(runId, null, 'quality')
      const reconBudget = workflowStore.getBudget(runId, null, 'reconciliation')

      return c.json({
        amendments,
        budget: {
          quality: qualityBudget ? { used: qualityBudget.used, max: qualityBudget.max_allowed } : null,
          reconciliation: reconBudget ? { used: reconBudget.used, max: reconBudget.max_allowed } : null,
        },
      })
    })
  }

  return { registerRoutes }
}
