// taskWorker.ts - Background worker: dequeue tasks, spawn tmux windows, monitor completion
import fs from 'node:fs'
import path from 'node:path'
import type { ServerContext } from './serverContext'
import type { TaskStore } from './taskStore'
import type { Task } from '../shared/types'
import { escapeForDoubleQuotedShell } from './validators'
import { getEnvForModel } from './modelEnvLoader'

export interface TaskWorker {
  start: () => void
  stop: () => void
}

const AUTO_RETRY_COOLDOWN_MS = 30_000 // Wait 30s before auto-retrying
const OUTPUT_RETENTION_DAYS = 7
const OUTPUT_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000 // Every 6 hours

function ensureOutputDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    // Ignore — will surface when writing output
  }
}

function tmuxWindowExists(windowTarget: string): boolean {
  try {
    // Use list-windows with exact name matching to avoid tmux prefix-match bug.
    // tmux has-session and display-message both do prefix matching, returning
    // false positives for similarly-named windows.
    const sessionName = windowTarget.includes(':') ? windowTarget.split(':')[0] : windowTarget
    const expectedName = windowTarget.includes(':') ? windowTarget.split(':').pop()! : windowTarget
    const result = Bun.spawnSync(
      ['tmux', 'list-windows', '-t', sessionName, '-F', '#{window_name}'],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    if (result.exitCode !== 0) return false
    const names = result.stdout.toString().trim().split('\n')
    return names.includes(expectedName)
  } catch {
    return false
  }
}


function killTmuxWindow(windowTarget: string): void {
  try {
    Bun.spawnSync(['tmux', 'kill-window', '-t', windowTarget], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    // Ignore — window may already be gone
  }
}

function detectFailure(output: string): boolean {
  const errorPatterns = [
    /error:/i,
    /panic:/i,
    /fatal:/i,
    /TASK_EXIT_CODE=[^0]/,
  ]
  const tail = output.slice(-2000)
  return errorPatterns.some((pattern) => pattern.test(tail))
}

/** Sanitize task ID for use in file paths (defense in depth) */
function safeTaskFileName(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** Get the sentinel file path that signals task completion */
function doneFilePath(dir: string, taskId: string): string {
  return path.join(dir, `${safeTaskFileName(taskId)}.done`)
}

/** Clean up the temp prompt file and sentinel done file for a task */
function cleanupTaskFiles(taskId: string, outputDir: string): void {
  const safeName = safeTaskFileName(taskId)
  for (const file of [
    `/tmp/agentboard-task-${safeName}.txt`,
    doneFilePath(outputDir, taskId),
  ]) {
    try { fs.unlinkSync(file) } catch { /* may not exist */ }
  }
}

export function createTaskWorker(
  ctx: ServerContext,
  taskStore: TaskStore
): TaskWorker {
  let pollIntervalId: ReturnType<typeof setInterval> | null = null
  let cleanupIntervalId: ReturnType<typeof setInterval> | null = null
  const outputDir = ctx.config.taskOutputDir

  // Processing guard: tracks task IDs currently being spawned
  // Prevents double-processing if poll re-enters (future-proofing for async)
  const processingIds = new Set<string>()

  ensureOutputDir(outputDir)

  // Recover orphaned tasks on startup
  const orphanCount = taskStore.markOrphanedTasksFailed()
  if (orphanCount > 0) {
    ctx.logger.info('task_worker_orphan_recovery', { orphanedCount: orphanCount })
  }

  function broadcastTaskUpdate(task: Task): void {
    ctx.broadcast({ type: 'task-updated', task })
  }

  function checkRunningTasks(): void {
    const runningTasks = taskStore.listTasks({ status: 'running' })

    for (const task of runningTasks) {
      // Skip tasks currently being spawned
      if (processingIds.has(task.id)) continue

      if (!task.tmuxWindow) {
        const updated = taskStore.updateTask(task.id, {
          status: 'failed',
          errorMessage: 'no_tmux_window',
          completedAt: new Date().toISOString(),
          completionMethod: 'error',
        })
        cleanupTaskFiles(task.id, outputDir)
        if (updated) {
          broadcastTaskUpdate(updated)
          ctx.logger.info('task_completed', { taskId: task.id, status: 'failed', reason: 'no_tmux_window' })
        }
        continue
      }

      // Check if tmux window still exists
      if (!tmuxWindowExists(task.tmuxWindow)) {
        const updated = taskStore.updateTask(task.id, {
          status: 'failed',
          errorMessage: 'tmux_window_disappeared',
          completedAt: new Date().toISOString(),
          completionMethod: 'process_exit',
        })
        cleanupTaskFiles(task.id, outputDir)
        if (updated) {
          broadcastTaskUpdate(updated)
          ctx.logger.info('task_completed', { taskId: task.id, status: 'failed', reason: 'window_disappeared' })
        }
        continue
      }

      // Check if task finished via sentinel .done file
      // (pane_current_command is unreliable — on macOS /bin/sh is bash,
      // so it always reports 'bash' even while the pipeline is still running)
      const donePath = doneFilePath(outputDir, task.id)
      const taskFinished = fs.existsSync(donePath)

      if (taskFinished) {
        // Read output from tee'd file
        let output = ''
        if (task.outputPath) {
          try {
            output = fs.readFileSync(task.outputPath, 'utf-8')
          } catch {
            output = ''
          }
        }

        const failed = detectFailure(output)

        const updated = taskStore.updateTask(task.id, {
          status: failed ? 'failed' : 'completed',
          completedAt: new Date().toISOString(),
          completionMethod: 'process_exit',
        })

        killTmuxWindow(task.tmuxWindow)
        cleanupTaskFiles(task.id, outputDir)

        if (updated) {
          broadcastTaskUpdate(updated)
          ctx.logger.info('task_completed', {
            taskId: task.id,
            status: updated.status,
            completionMethod: 'process_exit',
          })
        }

        // Create follow-up task if parent completed successfully
        if (updated && updated.status === 'completed' && task.followUpPrompt?.trim()) {
          // Verify project path is still accessible before creating follow-up
          let pathOk = true
          try { fs.accessSync(task.projectPath, fs.constants.R_OK) } catch { pathOk = false }

          if (!pathOk) {
            ctx.logger.warn('task_follow_up_skipped', {
              parentId: task.id,
              reason: 'project_path_inaccessible',
            })
          } else {
            const childTask = taskStore.createTask({
              projectPath: task.projectPath,
              prompt: task.followUpPrompt.trim(),
              templateId: null,
              priority: task.priority,
              status: 'queued',
              maxRetries: task.maxRetries,
              timeoutSeconds: task.timeoutSeconds,
              parentTaskId: task.id,
              followUpPrompt: null,
              metadata: null,
            })
            ctx.broadcast({ type: 'task-created', task: childTask })
            ctx.logger.info('task_follow_up_created', {
              parentId: task.id,
              childId: childTask.id,
            })
          }
        }
        continue
      }

      // Check timeout
      if (task.startedAt) {
        const elapsed = (Date.now() - new Date(task.startedAt).getTime()) / 1000
        if (elapsed > task.timeoutSeconds) {
          // Output file already has partial content via tee — just kill and mark failed
          killTmuxWindow(task.tmuxWindow)
          cleanupTaskFiles(task.id, outputDir)

          const updated = taskStore.updateTask(task.id, {
            status: 'failed',
            errorMessage: `timeout after ${task.timeoutSeconds}s`,
            completedAt: new Date().toISOString(),
            completionMethod: 'timeout',
          })
          if (updated) {
            broadcastTaskUpdate(updated)
            ctx.logger.info('task_completed', {
              taskId: task.id,
              status: 'failed',
              completionMethod: 'timeout',
              timeoutSeconds: task.timeoutSeconds,
            })
          }
        }
      }
    }
  }

  // Errors that indicate permanent failures — retrying won't help
  const NON_RETRIABLE_ERRORS = [
    'no_tmux_window',
    'tmux window not found after spawn',
    'Failed to write prompt file',
  ]

  function isRetriable(errorMessage: string | null): boolean {
    if (!errorMessage) return true
    return !NON_RETRIABLE_ERRORS.some((pattern) => errorMessage.includes(pattern))
  }

  function autoRetryFailedTasks(): void {
    const failedTasks = taskStore.listTasks({ status: 'failed' })
    for (const task of failedTasks) {
      if (task.retryCount >= task.maxRetries) continue

      // Skip non-retriable errors (permanent failures)
      if (!isRetriable(task.errorMessage)) continue

      // Cooldown: don't retry tasks that failed recently
      if (task.completedAt) {
        const failedAt = new Date(task.completedAt).getTime()
        if (Date.now() - failedAt < AUTO_RETRY_COOLDOWN_MS) continue
      }

      const updated = taskStore.updateTask(task.id, {
        status: 'queued',
        retryCount: task.retryCount + 1,
        errorMessage: null,
        completionMethod: null,
        startedAt: null,
        completedAt: null,
        tmuxWindow: null,
        sessionName: null,
      })
      if (updated) {
        broadcastTaskUpdate(updated)
        ctx.logger.info('task_auto_retry', {
          taskId: task.id,
          retryCount: updated.retryCount,
          maxRetries: updated.maxRetries,
        })
      }
    }
  }

  function dequeueTasks(): void {
    const runningCount = taskStore.getRunningCount()
    if (runningCount >= ctx.config.taskMaxConcurrent) return

    // Rate limiting
    const startedLastHour = taskStore.getStartedInLastHour()
    if (startedLastHour >= ctx.config.taskRateLimitPerHour) return

    const slotsAvailable = ctx.config.taskMaxConcurrent - runningCount
    const rateRemaining = ctx.config.taskRateLimitPerHour - startedLastHour

    const toDequeue = Math.min(slotsAvailable, rateRemaining)

    for (let i = 0; i < toDequeue; i++) {
      const task = taskStore.getNextQueued()
      if (!task) break

      // Guard against double-processing (add BEFORE spawn to prevent race condition)
      if (processingIds.has(task.id)) continue
      processingIds.add(task.id)

      spawnTask(task)
    }
  }

  function spawnTask(task: Task): void {
    const shortId = task.id.slice(0, 12)
    const windowName = `task-${shortId}`
    const tmuxSession = ctx.config.tmuxSession

    // processingIds.add already called by dequeueTasks before spawnTask

    // Write prompt to temp file (avoids shell escaping issues with long prompts)
    const safeName = safeTaskFileName(task.id)
    const promptFile = `/tmp/agentboard-task-${safeName}.txt`
    try {
      fs.writeFileSync(promptFile, task.prompt, { mode: 0o600 })
    } catch (err) {
      processingIds.delete(task.id)
      const updated = taskStore.updateTask(task.id, {
        status: 'failed',
        errorMessage: `Failed to write prompt file: ${err}`,
        completedAt: new Date().toISOString(),
        completionMethod: 'error',
      })
      if (updated) broadcastTaskUpdate(updated)
      return
    }

    // Pre-compute output + sentinel file paths
    // tee writes output as Claude streams (tmux capture-pane fails due to alternate screen buffer)
    // .done sentinel signals the pipeline finished (pane_current_command is unreliable on macOS)
    const outputPath = path.join(outputDir, `${safeName}.txt`)
    const donePath = doneFilePath(outputDir, task.id)
    const escapedOutputPath = escapeForDoubleQuotedShell(outputPath)
    const escapedDonePath = escapeForDoubleQuotedShell(donePath)

    // Resolve model env vars
    const metadata = task.metadata ? JSON.parse(task.metadata) : {}
    const modelId = metadata.model || 'claude'
    const customCommand = metadata.command || null
    const modelEnvs = getEnvForModel(modelId)

    // Build env prefix for tmux command
    const envPrefix = Object.entries(modelEnvs)
      .map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}'`)
      .join(' ')

    // Unset CLAUDECODE to allow spawning Claude Code sessions from within an existing session.
    // Unset ANTHROPIC_API_KEY so Claude Code uses the user's subscription instead of
    // pay-as-you-go API auth (which may have insufficient credits).
    const envCmd = envPrefix
      ? `env -u CLAUDECODE -u ANTHROPIC_API_KEY ${envPrefix} `
      : 'env -u CLAUDECODE -u ANTHROPIC_API_KEY '

    // Use proper shell escaping for project path (prevents shell injection)
    const escapedPath = escapeForDoubleQuotedShell(task.projectPath)

    let shellCmd: string
    if (customCommand) {
      // Custom command mode: run the specified command with env vars
      // The command receives context via environment variables
      const taskEnvVars = `TASK_ID='${task.id}' PROMPT_FILE='${promptFile}' TASK_OUTPUT_DIR='${escapeForDoubleQuotedShell(outputDir)}'`
      shellCmd = `cd "${escapedPath}" && { ${taskEnvVars} ${customCommand} 2>&1; echo "===TASK_EXIT_CODE=$?==="; } | tee "${escapedOutputPath}"; touch "${escapedDonePath}"; exec sh`
    } else {
      // Default: Claude mode (existing behavior)
      shellCmd = `cd "${escapedPath}" && { ${envCmd}claude -p "$(cat ${promptFile})" --dangerously-skip-permissions 2>&1; echo "===TASK_EXIT_CODE=$?==="; } | tee "${escapedOutputPath}"; touch "${escapedDonePath}"; exec sh`
    }

    try {
      const result = Bun.spawnSync(
        ['tmux', 'new-window', '-t', tmuxSession, '-n', windowName, 'sh', '-c', shellCmd],
        { stdout: 'pipe', stderr: 'pipe' }
      )

      if (result.exitCode !== 0) {
        processingIds.delete(task.id)
        cleanupTaskFiles(task.id, outputDir)
        const stderr = result.stderr.toString()
        const updated = taskStore.updateTask(task.id, {
          status: 'failed',
          errorMessage: `tmux spawn failed: ${stderr}`,
          completedAt: new Date().toISOString(),
          completionMethod: 'error',
        })
        if (updated) broadcastTaskUpdate(updated)
        return
      }
    } catch (err) {
      processingIds.delete(task.id)
      cleanupTaskFiles(task.id, outputDir)
      const updated = taskStore.updateTask(task.id, {
        status: 'failed',
        errorMessage: `tmux spawn error: ${err}`,
        completedAt: new Date().toISOString(),
        completionMethod: 'error',
      })
      if (updated) broadcastTaskUpdate(updated)
      return
    }

    const tmuxWindow = `${tmuxSession}:${windowName}`

    // Verify the tmux window actually exists after spawn
    if (!tmuxWindowExists(tmuxWindow)) {
      processingIds.delete(task.id)
      cleanupTaskFiles(task.id, outputDir)
      const updated = taskStore.updateTask(task.id, {
        status: 'failed',
        errorMessage: 'tmux window not found after spawn',
        completedAt: new Date().toISOString(),
        completionMethod: 'error',
      })
      if (updated) broadcastTaskUpdate(updated)
      return
    }

    const updated = taskStore.updateTask(task.id, {
      status: 'running',
      sessionName: windowName,
      tmuxWindow: tmuxWindow,
      startedAt: new Date().toISOString(),
      outputPath,
    })

    processingIds.delete(task.id)

    if (updated) broadcastTaskUpdate(updated)

    ctx.logger.info('task_spawned', {
      taskId: task.id,
      window: tmuxWindow,
      projectPath: task.projectPath,
      priority: task.priority,
    })
  }

  /** Remove output files older than OUTPUT_RETENTION_DAYS */
  function cleanupOldOutputs(): void {
    try {
      const files = fs.readdirSync(outputDir)
      const cutoff = Date.now() - OUTPUT_RETENTION_DAYS * 24 * 60 * 60 * 1000
      let cleaned = 0

      for (const file of files) {
        if (!file.endsWith('.txt') && !file.endsWith('.done')) continue
        const filePath = path.join(outputDir, file)
        try {
          const stat = fs.statSync(filePath)
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(filePath)
            cleaned++
          }
        } catch {
          // Skip files we can't stat/delete
        }
      }

      if (cleaned > 0) {
        ctx.logger.info('task_output_cleanup', { filesRemoved: cleaned })
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  function poll(): void {
    // Execute each function independently so one failure doesn't block others
    try {
      checkRunningTasks()
    } catch (err) {
      ctx.logger.error('task_worker_check_running_error', { error: String(err) })
    }

    try {
      autoRetryFailedTasks()
    } catch (err) {
      ctx.logger.error('task_worker_auto_retry_error', { error: String(err) })
    }

    try {
      dequeueTasks()
    } catch (err) {
      ctx.logger.error('task_worker_dequeue_error', { error: String(err) })
    }
  }

  return {
    start() {
      if (pollIntervalId) return
      ctx.logger.info('task_worker_started', {
        pollIntervalMs: ctx.config.taskPollIntervalMs,
        maxConcurrent: ctx.config.taskMaxConcurrent,
        rateLimitPerHour: ctx.config.taskRateLimitPerHour,
      })
      pollIntervalId = setInterval(poll, ctx.config.taskPollIntervalMs)

      // Periodic output cleanup
      cleanupOldOutputs()
      cleanupIntervalId = setInterval(cleanupOldOutputs, OUTPUT_CLEANUP_INTERVAL_MS)
    },

    stop() {
      if (pollIntervalId) {
        clearInterval(pollIntervalId)
        pollIntervalId = null
      }
      if (cleanupIntervalId) {
        clearInterval(cleanupIntervalId)
        cleanupIntervalId = null
      }
      ctx.logger.info('task_worker_stopped')
    },
  }
}
