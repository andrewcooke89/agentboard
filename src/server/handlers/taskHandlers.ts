// taskHandlers.ts - WebSocket message handlers for task queue operations
import fs from 'node:fs'
import path from 'node:path'
import type { ServerWebSocket } from 'bun'
import type { ClientMessage } from '../../shared/types'
import type { ServerContext, WSData } from '../serverContext'
import type { TaskStore } from '../taskStore'
import { isValidTaskId, MAX_FIELD_LENGTH } from '../validators'

function cleanupTaskFiles(taskId: string, outputDir: string): void {
  const safeName = taskId.replace(/[^A-Za-z0-9_-]/g, '_')
  for (const file of [
    `/tmp/agentboard-task-${safeName}.txt`,
    path.join(outputDir, `${safeName}.done`),
  ]) {
    try { fs.unlinkSync(file) } catch { /* may not exist */ }
  }
}

export function createTaskHandlers(ctx: ServerContext, taskStore: TaskStore) {
  function handleTaskCreate(
    ws: ServerWebSocket<WSData>,
    message: Extract<ClientMessage, { type: 'task-create' }>
  ): void {
    const { projectPath, prompt, templateId, variables, priority, timeoutSeconds, maxRetries, followUpPrompt, metadata } = message

    if (!projectPath || projectPath.length > MAX_FIELD_LENGTH) {
      ctx.send(ws, { type: 'error', message: 'Invalid project path' })
      return
    }

    let finalPrompt = prompt
    if (!finalPrompt && !templateId) {
      ctx.send(ws, { type: 'error', message: 'Prompt or template is required' })
      return
    }

    // Validate variables input
    if (variables) {
      if (typeof variables !== 'object' || Array.isArray(variables)) {
        ctx.send(ws, { type: 'error', message: 'Variables must be an object' })
        return
      }
      for (const [key, value] of Object.entries(variables)) {
        if (typeof key !== 'string' || typeof value !== 'string') {
          ctx.send(ws, { type: 'error', message: 'Variable keys and values must be strings' })
          return
        }
        if (key.length > 256 || value.length > MAX_FIELD_LENGTH) {
          ctx.send(ws, { type: 'error', message: 'Variable key or value too long' })
          return
        }
      }
    }

    // Validate follow-up prompt
    if (followUpPrompt != null && (typeof followUpPrompt !== 'string' || followUpPrompt.length > 100_000)) {
      ctx.send(ws, { type: 'error', message: 'Follow-up prompt too long (max 100,000 chars)' })
      return
    }

    // Validate metadata
    if (metadata != null && (typeof metadata !== 'string' || metadata.length > 10_000)) {
      ctx.send(ws, { type: 'error', message: 'Metadata too long (max 10,000 chars)' })
      return
    }

    // Template variable injection
    if (templateId) {
      const template = taskStore.getTemplate(templateId)
      if (!template) {
        ctx.send(ws, { type: 'error', message: 'Template not found' })
        return
      }

      if (!finalPrompt) {
        finalPrompt = template.promptTemplate
      }

      // Substitute {{variable}} placeholders with provided values
      if (variables) {
        for (const [key, value] of Object.entries(variables)) {
          const safeValue = String(value).slice(0, MAX_FIELD_LENGTH)
          finalPrompt = finalPrompt.replace(
            new RegExp(`\\{\\{${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`, 'g'),
            safeValue
          )
          // Early size check to prevent prompt explosion from variable substitution
          if (finalPrompt.length > 100_000) {
            ctx.send(ws, { type: 'error', message: 'Prompt too large after variable substitution' })
            return
          }
        }
      }
    }

    if (!finalPrompt || finalPrompt.length > 100_000) {
      ctx.send(ws, { type: 'error', message: 'Invalid prompt (empty or too long)' })
      return
    }

    const task = taskStore.createTask({
      projectPath,
      prompt: finalPrompt,
      templateId: templateId ?? null,
      priority: priority ?? 5,
      status: 'queued',
      maxRetries: maxRetries ?? 0,
      timeoutSeconds: timeoutSeconds ?? ctx.config.taskDefaultTimeoutSeconds,
      parentTaskId: null,
      followUpPrompt: followUpPrompt ?? null,
      metadata: metadata ?? null,
    })

    ctx.broadcast({ type: 'task-created', task })
    ctx.logger.info('task_created', { taskId: task.id, projectPath, priority: task.priority })
  }

  function handleTaskCancel(
    ws: ServerWebSocket<WSData>,
    message: Extract<ClientMessage, { type: 'task-cancel' }>
  ): void {
    const { taskId } = message
    if (!isValidTaskId(taskId)) {
      ctx.send(ws, { type: 'error', message: 'Invalid task ID' })
      return
    }

    const task = taskStore.getTask(taskId)
    if (!task) {
      ctx.send(ws, { type: 'error', message: 'Task not found' })
      return
    }

    if (task.status !== 'queued' && task.status !== 'running') {
      ctx.send(ws, { type: 'error', message: `Cannot cancel task with status: ${task.status}` })
      return
    }

    // Kill tmux window if running
    if (task.status === 'running' && task.tmuxWindow) {
      try {
        Bun.spawnSync(['tmux', 'kill-window', '-t', task.tmuxWindow], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
      } catch {
        // Window may already be gone
      }
    }

    const updated = taskStore.updateTask(taskId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      completionMethod: 'manual',
    })

    if (updated) {
      cleanupTaskFiles(taskId, ctx.config.taskOutputDir)
      // Also clean up the output file if one exists
      if (task.outputPath) {
        try { fs.unlinkSync(task.outputPath) } catch { /* may not exist */ }
      }
      ctx.broadcast({ type: 'task-updated', task: updated })
      ctx.logger.info('task_cancelled', { taskId })
    }
  }

  function handleTaskRetry(
    ws: ServerWebSocket<WSData>,
    message: Extract<ClientMessage, { type: 'task-retry' }>
  ): void {
    const { taskId } = message
    if (!isValidTaskId(taskId)) {
      ctx.send(ws, { type: 'error', message: 'Invalid task ID' })
      return
    }

    const task = taskStore.getTask(taskId)
    if (!task) {
      ctx.send(ws, { type: 'error', message: 'Task not found' })
      return
    }

    if (task.status !== 'failed' && task.status !== 'cancelled') {
      ctx.send(ws, { type: 'error', message: `Cannot retry task with status: ${task.status}` })
      return
    }

    const updated = taskStore.updateTask(taskId, {
      status: 'queued',
      retryCount: task.retryCount + 1,
      errorMessage: null,
      completionMethod: null,
      startedAt: null,
      completedAt: null,
      tmuxWindow: null,
      sessionName: null,
      outputPath: null,
    })

    if (updated) {
      ctx.broadcast({ type: 'task-updated', task: updated })
      ctx.logger.info('task_retried', { taskId, retryCount: updated.retryCount })
    }
  }

  function handleTaskListRequest(ws: ServerWebSocket<WSData>): void {
    const tasks = taskStore.listTasks({ limit: 100 })
    const stats = taskStore.getStats()
    ctx.send(ws, { type: 'task-list', tasks, stats })
  }

  function handleTemplateListRequest(ws: ServerWebSocket<WSData>): void {
    const templates = taskStore.listTemplates()
    ctx.send(ws, { type: 'template-list', templates })
  }

  return {
    handleTaskCreate,
    handleTaskCancel,
    handleTaskRetry,
    handleTaskListRequest,
    handleTemplateListRequest,
  }
}
