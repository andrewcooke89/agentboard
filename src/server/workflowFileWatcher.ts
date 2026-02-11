/**
 * workflowFileWatcher.ts — Watches YAML workflow directory for file changes (WO-006)
 *
 * Factory function pattern (like taskWorker.ts): createWorkflowFileWatcher(ctx, workflowStore) => { start, stop }
 *
 * On start():
 *   - Creates config.workflowDir if not exists
 *   - Initial scan: reads all .yaml/.yml files, parses and upserts each
 *   - Starts fs.watch on the directory
 *
 * File changes are debounced per-file at 500ms to avoid redundant re-parses.
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseWorkflowYAML } from './workflowSchema'
import type { ServerContext } from './serverContext'
import type { WorkflowStore } from './workflowStore'
import { sanitizeForLog } from './validators'

export interface WorkflowFileWatcher {
  start: () => void
  stop: () => void
  /** Check tracked workflows for deleted source files and remove them. */
  reconcile: () => void
}

const DEBOUNCE_MS = 500
const MAX_YAML_FILE_SIZE = 1024 * 1024 // 1MB

function isYamlFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return ext === '.yaml' || ext === '.yml'
}

export function createWorkflowFileWatcher(
  ctx: ServerContext,
  workflowStore: WorkflowStore,
): WorkflowFileWatcher {
  let watcher: fs.FSWatcher | null = null
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function handleFileChange(filePath: string): void {
    // Guard against oversized files that could stall the event loop on network filesystems
    try {
      const stat = fs.lstatSync(filePath)
      if (stat.isSymbolicLink()) {
        ctx.logger.warn('workflow_symlink_ignored', { filePath: sanitizeForLog(filePath) })
        return
      }
      if (stat.size > MAX_YAML_FILE_SIZE) {
        ctx.logger.warn('workflow_file_too_large', { filePath: sanitizeForLog(filePath), size: stat.size })
        return
      }
    } catch (err) {
      ctx.logger.warn('workflow_file_stat_error', { filePath: sanitizeForLog(filePath), error: String(err) })
      return
    }

    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf-8')
    } catch (err) {
      ctx.logger.warn('workflow_file_read_error', { filePath: sanitizeForLog(filePath), error: String(err) })
      return
    }

    const result = parseWorkflowYAML(content)

    const name = result.valid && result.workflow
      ? result.workflow.name
      : path.basename(filePath, path.extname(filePath))

    const stepCount = result.valid && result.workflow
      ? result.workflow.steps.length
      : 0

    const existing = workflowStore.getWorkflowByName(name)

    let workflow
    if (existing) {
      workflow = workflowStore.updateWorkflow(existing.id, {
        yaml_content: content,
        file_path: filePath,
        is_valid: result.valid,
        validation_errors: result.errors,
        step_count: stepCount,
        description: result.workflow?.description ?? null,
      })
    } else {
      workflow = workflowStore.createWorkflow({
        name,
        yaml_content: content,
        file_path: filePath,
        is_valid: result.valid,
        validation_errors: result.errors,
        step_count: stepCount,
        description: result.workflow?.description ?? null,
      })
    }

    if (workflow) {
      ctx.broadcast({ type: 'workflow-updated', workflow })
      ctx.logger.info('workflow_file_synced', {
        name: sanitizeForLog(name),
        filePath: sanitizeForLog(filePath),
        valid: result.valid,
        action: existing ? 'updated' : 'created',
      })
    }
  }

  function handleFileDelete(filePath: string): void {
    const allWorkflows = workflowStore.listWorkflows()
    const match = allWorkflows.find((w) => w.file_path === filePath)
    if (!match) return

    workflowStore.deleteWorkflow(match.id)
    ctx.broadcast({ type: 'workflow-removed', workflowId: match.id })
    ctx.logger.info('workflow_file_removed', { workflowId: match.id, filePath: sanitizeForLog(filePath) })
  }

  function initialScan(dir: string): void {
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch (err) {
      ctx.logger.warn('workflow_dir_read_error', { dir, error: String(err) })
      return
    }

    for (const entry of entries) {
      if (!isYamlFile(entry)) continue
      const filePath = path.join(dir, entry)
      try {
        const stat = fs.lstatSync(filePath)
        if (stat.isSymbolicLink()) {
          ctx.logger.warn('workflow_symlink_ignored', { filePath })
          continue
        }
        if (stat.isFile()) {
          handleFileChange(filePath)
        }
      } catch {
        // Skip files we can't stat
      }
    }
  }

  function reconcileDeletedFiles(): void {
    const allWorkflows = workflowStore.listWorkflows()
    for (const workflow of allWorkflows) {
      if (!workflow.file_path) continue
      try {
        fs.accessSync(workflow.file_path, fs.constants.R_OK)
      } catch {
        handleFileDelete(workflow.file_path)
      }
    }
  }

  function onWatchEvent(eventType: string, filename: string | null): void {
    if (!filename) return
    if (!isYamlFile(filename)) return

    const filePath = path.join(ctx.config.workflowDir, filename)

    // Clear existing debounce timer for this file
    const existing = debounceTimers.get(filePath)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      debounceTimers.delete(filePath)

      // Check file state AFTER debounce to handle create/delete/recreate races.
      // The file's current state (exists or not) determines the action, not the original event.
      try {
        fs.accessSync(filePath, fs.constants.R_OK)
        handleFileChange(filePath)
      } catch {
        handleFileDelete(filePath)
      }
    }, DEBOUNCE_MS)

    debounceTimers.set(filePath, timer)
  }

  return {
    start() {
      const dir = ctx.config.workflowDir

      // Ensure directory exists
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch {
        // May already exist
      }

      // Initial scan
      initialScan(dir)

      // Start watching
      try {
        watcher = fs.watch(dir, onWatchEvent)
        watcher.on('error', (err) => {
          ctx.logger.warn('workflow_file_watcher_error', { dir, error: String(err) })
        })
        ctx.logger.info('workflow_file_watcher_started', { dir })
      } catch (err) {
        ctx.logger.error('workflow_file_watcher_start_error', { dir, error: String(err) })
      }
    },

    reconcile() {
      reconcileDeletedFiles()
    },

    stop() {
      if (watcher) {
        watcher.close()
        watcher = null
      }

      // Clear all debounce timers
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer)
      }
      debounceTimers.clear()

      ctx.logger.info('workflow_file_watcher_stopped')
    },
  }
}
