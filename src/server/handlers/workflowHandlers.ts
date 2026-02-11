// workflowHandlers.ts - REST API handlers for workflow management (WO-007)
import type { Hono } from 'hono'
import fs from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { ServerContext } from '../serverContext'
import { parseWorkflowYAML, validateVariables } from '../workflowSchema'
import type { StepRunState } from '../../shared/types'
import { sanitizeForLog } from '../validators'

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
        } catch {
          // File may already be gone
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

      // Validate variables if the workflow defines any
      let mergedVars: Record<string, string> | null = null
      if (parsed.workflow.variables.length > 0) {
        const { errors: varErrors, merged } = validateVariables(parsed.workflow.variables, providedVars)
        if (varErrors.length > 0) {
          return c.json({ error: 'Variable validation failed', details: varErrors }, 400)
        }
        mergedVars = merged
      }

      // Phase 5: Queue depth limit (REQ-24) — only when session_pool enabled (REQ-37)
      if (parsed.workflow.system?.session_pool && pool) {
        const maxDepth = Number(process.env.AGENTBOARD_MAX_POOL_QUEUE_DEPTH) || 50
        const poolStatus = pool.getStatus()
        if (poolStatus.queue.length >= maxDepth) {
          return c.json({
            error: `Pool queue full (${poolStatus.queue.length} pending). Try again later.`,
            code: 'POOL_QUEUE_FULL',
            queueDepth: poolStatus.queue.length,
            maxDepth,
          }, 429)
        }
      }

      const stepsState: StepRunState[] = []
      for (const step of parsed.workflow.steps) {
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
        if (step.type === 'parallel_group' && step.children) {
          for (const child of step.children) {
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
        output_dir: path.join(config.workflowDir, 'runs', `${workflow.name}-${Date.now()}`),
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
  }

  return { registerRoutes }
}
