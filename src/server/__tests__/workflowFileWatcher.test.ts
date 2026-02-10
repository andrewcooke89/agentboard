import { describe, expect, test, afterEach, beforeEach } from 'bun:test'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createWorkflowFileWatcher } from '../workflowFileWatcher'
import { initWorkflowStore } from '../workflowStore'
import type { WorkflowStore } from '../workflowStore'
import type { ServerContext } from '../serverContext'

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTestStore(): { store: WorkflowStore; db: SQLiteDatabase } {
  const db = new SQLiteDatabase(':memory:')
  const store = initWorkflowStore(db)
  return { store, db }
}

function validYaml(name = 'test-workflow'): string {
  return [
    `name: ${name}`,
    'steps:',
    '  - name: step-1',
    '    type: spawn_session',
    '    projectPath: /tmp/test',
    '    prompt: do something',
  ].join('\n')
}

function yamlMissingSteps(): string {
  return 'name: bad-workflow\n'
}

interface MockContext {
  broadcasts: Array<{ type: string; [key: string]: unknown }>
  logs: Array<{ level: string; event: string; data?: Record<string, unknown> }>
  config: { workflowDir: string }
  broadcast: (msg: Record<string, unknown>) => void
  logger: {
    info: (event: string, data?: Record<string, unknown>) => void
    warn: (event: string, data?: Record<string, unknown>) => void
    error: (event: string, data?: Record<string, unknown>) => void
    debug: (event: string, data?: Record<string, unknown>) => void
  }
}

function createMockContext(workflowDir: string): MockContext {
  const broadcasts: MockContext['broadcasts'] = []
  const logs: MockContext['logs'] = []

  return {
    broadcasts,
    logs,
    config: { workflowDir },
    broadcast: (msg: Record<string, unknown>) => broadcasts.push(msg as MockContext['broadcasts'][0]),
    logger: {
      info: (event: string, data?: Record<string, unknown>) => logs.push({ level: 'info', event, data }),
      warn: (event: string, data?: Record<string, unknown>) => logs.push({ level: 'warn', event, data }),
      error: (event: string, data?: Record<string, unknown>) => logs.push({ level: 'error', event, data }),
      debug: (event: string, data?: Record<string, unknown>) => logs.push({ level: 'debug', event, data }),
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('workflowFileWatcher', () => {
  let tmpDir: string
  let store: WorkflowStore
  let db: SQLiteDatabase
  let mockCtx: MockContext
  let watcher: ReturnType<typeof createWorkflowFileWatcher>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfw-test-'))
    const result = createTestStore()
    store = result.store
    db = result.db
    mockCtx = createMockContext(tmpDir)
  })

  afterEach(() => {
    if (watcher) {
      watcher.stop()
    }
    try {
      db.close()
    } catch { /* ignore */ }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch { /* ignore */ }
  })

  describe('initial scan', () => {
    test('finds and parses YAML files on start', () => {
      // Write YAML files before starting watcher
      fs.writeFileSync(path.join(tmpDir, 'alpha.yaml'), validYaml('alpha'))
      fs.writeFileSync(path.join(tmpDir, 'beta.yml'), validYaml('beta'))
      fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'not a yaml file')

      watcher = createWorkflowFileWatcher(mockCtx as unknown as ServerContext, store)
      watcher.start()

      const workflows = store.listWorkflows()
      expect(workflows.length).toBe(2)

      const names = workflows.map((w) => w.name).sort()
      expect(names).toEqual(['alpha', 'beta'])

      // Should have broadcast workflow-updated for each
      const updates = mockCtx.broadcasts.filter((b) => b.type === 'workflow-updated')
      expect(updates.length).toBe(2)
    })

    test('creates workflow dir if it does not exist', () => {
      const nestedDir = path.join(tmpDir, 'nested', 'workflows')
      mockCtx.config.workflowDir = nestedDir

      watcher = createWorkflowFileWatcher(mockCtx as unknown as ServerContext, store)
      watcher.start()

      expect(fs.existsSync(nestedDir)).toBe(true)
    })

    test('ignores non-YAML files', () => {
      fs.writeFileSync(path.join(tmpDir, 'data.json'), '{}')
      fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'hello')

      watcher = createWorkflowFileWatcher(mockCtx as unknown as ServerContext, store)
      watcher.start()

      expect(store.listWorkflows().length).toBe(0)
    })
  })

  describe('file change handling', () => {
    test('parses and upserts valid YAML on file change', async () => {
      watcher = createWorkflowFileWatcher(mockCtx as unknown as ServerContext, store)
      watcher.start()

      // Write a new YAML file after watcher started
      fs.writeFileSync(path.join(tmpDir, 'new.yaml'), validYaml('new-workflow'))

      // Wait for debounce + processing
      await sleep(800)

      const workflows = store.listWorkflows()
      expect(workflows.length).toBe(1)
      expect(workflows[0].name).toBe('new-workflow')
      expect(workflows[0].is_valid).toBe(true)
      expect(workflows[0].step_count).toBe(1)
      expect(workflows[0].file_path).toBe(path.join(tmpDir, 'new.yaml'))
    })

    test('updates existing workflow on file change', async () => {
      // Pre-populate with initial version
      fs.writeFileSync(path.join(tmpDir, 'existing.yaml'), validYaml('existing'))

      watcher = createWorkflowFileWatcher(mockCtx as unknown as ServerContext, store)
      watcher.start()

      const initial = store.getWorkflowByName('existing')
      expect(initial).not.toBeNull()
      const initialId = initial!.id

      // Update the file
      const updatedContent = [
        'name: existing',
        'description: updated version',
        'steps:',
        '  - name: step-1',
        '    type: spawn_session',
        '    projectPath: /tmp/test',
        '    prompt: updated prompt',
        '  - name: step-2',
        '    type: delay',
        '    seconds: 5',
      ].join('\n')
      fs.writeFileSync(path.join(tmpDir, 'existing.yaml'), updatedContent)

      await sleep(800)

      const updated = store.getWorkflowByName('existing')
      expect(updated).not.toBeNull()
      // Same ID (upsert, not duplicate)
      expect(updated!.id).toBe(initialId)
      expect(updated!.step_count).toBe(2)
    })

    test('stores invalid YAML with is_valid=false', async () => {
      watcher = createWorkflowFileWatcher(mockCtx as unknown as ServerContext, store)
      watcher.start()

      fs.writeFileSync(path.join(tmpDir, 'broken.yaml'), yamlMissingSteps())

      await sleep(800)

      const workflows = store.listWorkflows()
      expect(workflows.length).toBe(1)
      expect(workflows[0].is_valid).toBe(false)
      expect(workflows[0].validation_errors.length).toBeGreaterThan(0)
    })
  })

  describe('file deletion', () => {
    test('removes workflow when file is deleted', async () => {
      fs.writeFileSync(path.join(tmpDir, 'to-delete.yaml'), validYaml('to-delete'))

      watcher = createWorkflowFileWatcher(mockCtx as unknown as ServerContext, store)
      watcher.start()

      expect(store.getWorkflowByName('to-delete')).not.toBeNull()

      // Delete the file
      fs.unlinkSync(path.join(tmpDir, 'to-delete.yaml'))

      await sleep(1500)

      expect(store.getWorkflowByName('to-delete')).toBeNull()

      const removals = mockCtx.broadcasts.filter((b) => b.type === 'workflow-removed')
      expect(removals.length).toBe(1)
    })
  })

  describe('debounce', () => {
    test('rapid changes only trigger one parse', async () => {
      watcher = createWorkflowFileWatcher(mockCtx as unknown as ServerContext, store)
      watcher.start()

      // Reset broadcasts from initial scan
      mockCtx.broadcasts.length = 0

      const filePath = path.join(tmpDir, 'rapid.yaml')

      // Write rapidly 5 times
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(filePath, validYaml(`rapid-v${i}`))
        await sleep(50) // Much less than debounce
      }

      // Wait for debounce to fire
      await sleep(800)

      // Should have exactly 1 workflow-updated broadcast (debounced)
      const updates = mockCtx.broadcasts.filter((b) => b.type === 'workflow-updated')
      expect(updates.length).toBe(1)

      // The final version should be the one persisted
      const workflows = store.listWorkflows()
      expect(workflows.length).toBe(1)
      expect(workflows[0].name).toBe('rapid-v4')
    })
  })

  describe('stop', () => {
    test('clears watcher and timers on stop', () => {
      watcher = createWorkflowFileWatcher(mockCtx as unknown as ServerContext, store)
      watcher.start()
      watcher.stop()

      const stopLog = mockCtx.logs.find((l) => l.event === 'workflow_file_watcher_stopped')
      expect(stopLog).toBeDefined()
    })
  })
})
