import { describe, expect, test, afterEach } from 'bun:test'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { initTaskStore } from '../taskStore'
import type { TaskStore } from '../taskStore'

function createTestStore(): { store: TaskStore; db: SQLiteDatabase } {
  const db = new SQLiteDatabase(':memory:')
  const store = initTaskStore(db)
  return { store, db }
}

describe('taskStore', () => {
  let store: TaskStore
  let db: SQLiteDatabase

  afterEach(() => {
    try {
      db.exec('DELETE FROM tasks')
      db.exec('DELETE FROM task_templates')
    } catch {
      // Tables may not exist if test failed during init
    }
  })

  // Re-create store for each describe block
  function setup() {
    const result = createTestStore()
    store = result.store
    db = result.db
  }

  describe('task CRUD', () => {
    setup()

    test('createTask returns a task with generated id', () => {
      const task = store.createTask({
        projectPath: '/tmp/myproject',
        prompt: 'Fix the bug',
        templateId: null,
        priority: 3,
        status: 'queued',
        maxRetries: 1,
        timeoutSeconds: 600,
      })

      expect(task.id).toBeTruthy()
      expect(task.projectPath).toBe('/tmp/myproject')
      expect(task.prompt).toBe('Fix the bug')
      expect(task.priority).toBe(3)
      expect(task.status).toBe('queued')
      expect(task.maxRetries).toBe(1)
      expect(task.timeoutSeconds).toBe(600)
      expect(task.retryCount).toBe(0)
      expect(task.createdAt).toBeTruthy()
      expect(task.startedAt).toBeNull()
      expect(task.completedAt).toBeNull()
      expect(task.errorMessage).toBeNull()
      expect(task.tmuxWindow).toBeNull()
    })

    test('getTask returns task by id', () => {
      const created = store.createTask({
        projectPath: '/tmp/p',
        prompt: 'Hello',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })

      const fetched = store.getTask(created.id)
      expect(fetched).not.toBeNull()
      expect(fetched!.id).toBe(created.id)
      expect(fetched!.prompt).toBe('Hello')
    })

    test('getTask returns null for non-existent id', () => {
      expect(store.getTask('nonexistent')).toBeNull()
    })

    test('updateTask updates fields', () => {
      const task = store.createTask({
        projectPath: '/tmp/p',
        prompt: 'Test',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })

      const updated = store.updateTask(task.id, {
        status: 'running',
        tmuxWindow: 'agentboard:task-abc',
        startedAt: '2026-01-01T00:00:00Z',
      })

      expect(updated).not.toBeNull()
      expect(updated!.status).toBe('running')
      expect(updated!.tmuxWindow).toBe('agentboard:task-abc')
      expect(updated!.startedAt).toBe('2026-01-01T00:00:00Z')
    })

    test('deleteTask removes task', () => {
      const task = store.createTask({
        projectPath: '/tmp/p',
        prompt: 'Delete me',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })

      expect(store.deleteTask(task.id)).toBe(true)
      expect(store.getTask(task.id)).toBeNull()
    })

    test('deleteTask returns false for non-existent id', () => {
      expect(store.deleteTask('nonexistent')).toBe(false)
    })
  })

  describe('task lifecycle', () => {
    setup()

    test('queued → running → completed', () => {
      const task = store.createTask({
        projectPath: '/tmp/p',
        prompt: 'Lifecycle test',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      expect(task.status).toBe('queued')

      const running = store.updateTask(task.id, {
        status: 'running',
        startedAt: new Date().toISOString(),
        tmuxWindow: 'agentboard:task-x',
      })
      expect(running!.status).toBe('running')

      const completed = store.updateTask(task.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        completionMethod: 'process_exit',
      })
      expect(completed!.status).toBe('completed')
      expect(completed!.completionMethod).toBe('process_exit')
    })

    test('queued → running → failed', () => {
      const task = store.createTask({
        projectPath: '/tmp/p',
        prompt: 'Fail test',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })

      store.updateTask(task.id, {
        status: 'running',
        startedAt: new Date().toISOString(),
      })

      const failed = store.updateTask(task.id, {
        status: 'failed',
        errorMessage: 'timeout after 1800s',
        completedAt: new Date().toISOString(),
        completionMethod: 'timeout',
      })
      expect(failed!.status).toBe('failed')
      expect(failed!.errorMessage).toBe('timeout after 1800s')
    })
  })

  describe('queue ordering', () => {
    setup()

    test('getNextQueued returns highest priority first', () => {
      store.createTask({
        projectPath: '/tmp/p',
        prompt: 'Low priority',
        templateId: null,
        priority: 10,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })

      store.createTask({
        projectPath: '/tmp/p',
        prompt: 'High priority',
        templateId: null,
        priority: 1,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })

      const next = store.getNextQueued()
      expect(next).not.toBeNull()
      expect(next!.prompt).toBe('High priority')
      expect(next!.priority).toBe(1)
    })

    test('getNextQueued returns null when no queued tasks', () => {
      expect(store.getNextQueued()).toBeNull()
    })

    test('getNextQueued respects FIFO within same priority', () => {
      const first = store.createTask({
        projectPath: '/tmp/p',
        prompt: 'First',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })

      store.createTask({
        projectPath: '/tmp/p',
        prompt: 'Second',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })

      const next = store.getNextQueued()
      expect(next!.id).toBe(first.id)
    })
  })

  describe('counts and stats', () => {
    setup()

    test('getRunningCount returns running task count', () => {
      expect(store.getRunningCount()).toBe(0)

      const task = store.createTask({
        projectPath: '/tmp/p',
        prompt: 'Running',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      store.updateTask(task.id, { status: 'running' })

      expect(store.getRunningCount()).toBe(1)
    })

    test('getStats returns correct counts', () => {
      const stats = store.getStats()
      expect(stats.queued).toBe(0)
      expect(stats.running).toBe(0)
      expect(stats.completedToday).toBe(0)
      expect(stats.failedToday).toBe(0)
    })

    test('listTasks with status filter', () => {
      store.createTask({
        projectPath: '/tmp/p',
        prompt: 'A',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })

      const task2 = store.createTask({
        projectPath: '/tmp/p',
        prompt: 'B',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      store.updateTask(task2.id, { status: 'running' })

      const queued = store.listTasks({ status: 'queued' })
      expect(queued).toHaveLength(1)
      expect(queued[0].prompt).toBe('A')

      const running = store.listTasks({ status: 'running' })
      expect(running).toHaveLength(1)
      expect(running[0].prompt).toBe('B')
    })

    test('listTasks with limit and offset', () => {
      for (let i = 0; i < 5; i++) {
        store.createTask({
          projectPath: '/tmp/p',
          prompt: `Task ${i}`,
          templateId: null,
          priority: 5,
          status: 'queued',
          maxRetries: 0,
          timeoutSeconds: 1800,
        })
      }

      const page1 = store.listTasks({ limit: 2 })
      expect(page1).toHaveLength(2)

      const page2 = store.listTasks({ limit: 2, offset: 2 })
      expect(page2).toHaveLength(2)
    })
  })

  describe('orphaned task recovery', () => {
    setup()

    test('markOrphanedTasksFailed marks running tasks as failed', () => {
      const task = store.createTask({
        projectPath: '/tmp/p',
        prompt: 'Orphan',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })
      store.updateTask(task.id, { status: 'running' })

      const count = store.markOrphanedTasksFailed()
      expect(count).toBe(1)

      const updated = store.getTask(task.id)
      expect(updated!.status).toBe('failed')
      expect(updated!.errorMessage).toBe('server_restart')
    })

    test('markOrphanedTasksFailed does not affect queued tasks', () => {
      store.createTask({
        projectPath: '/tmp/p',
        prompt: 'Still queued',
        templateId: null,
        priority: 5,
        status: 'queued',
        maxRetries: 0,
        timeoutSeconds: 1800,
      })

      const count = store.markOrphanedTasksFailed()
      expect(count).toBe(0)
    })
  })

  describe('template CRUD', () => {
    setup()

    test('createTemplate and getTemplate', () => {
      const template = store.createTemplate({
        name: 'Bug Fix',
        promptTemplate: 'Fix the bug in {{file}}',
        variables: JSON.stringify([{ name: 'file', description: 'File to fix' }]),
        projectPath: '/tmp/proj',
        priority: 3,
        timeoutSeconds: 900,
        isDefault: false,
      })

      expect(template.id).toBeTruthy()
      expect(template.name).toBe('Bug Fix')
      expect(template.promptTemplate).toBe('Fix the bug in {{file}}')
      expect(template.priority).toBe(3)

      const fetched = store.getTemplate(template.id)
      expect(fetched).not.toBeNull()
      expect(fetched!.name).toBe('Bug Fix')
    })

    test('updateTemplate updates fields', () => {
      const template = store.createTemplate({
        name: 'Original',
        promptTemplate: 'Original prompt',
        variables: '[]',
        projectPath: null,
        priority: 5,
        timeoutSeconds: 1800,
        isDefault: false,
      })

      const updated = store.updateTemplate(template.id, {
        name: 'Updated',
        priority: 1,
      })

      expect(updated).not.toBeNull()
      expect(updated!.name).toBe('Updated')
      expect(updated!.priority).toBe(1)
      expect(updated!.promptTemplate).toBe('Original prompt')
    })

    test('deleteTemplate removes template', () => {
      const template = store.createTemplate({
        name: 'To Delete',
        promptTemplate: 'Delete me',
        variables: '[]',
        projectPath: null,
        priority: 5,
        timeoutSeconds: 1800,
        isDefault: false,
      })

      expect(store.deleteTemplate(template.id)).toBe(true)
      expect(store.getTemplate(template.id)).toBeNull()
    })

    test('listTemplates returns all templates sorted by name', () => {
      store.createTemplate({
        name: 'Zebra',
        promptTemplate: 'Z',
        variables: '[]',
        projectPath: null,
        priority: 5,
        timeoutSeconds: 1800,
        isDefault: false,
      })
      store.createTemplate({
        name: 'Alpha',
        promptTemplate: 'A',
        variables: '[]',
        projectPath: null,
        priority: 5,
        timeoutSeconds: 1800,
        isDefault: false,
      })

      const templates = store.listTemplates()
      expect(templates).toHaveLength(2)
      expect(templates[0].name).toBe('Alpha')
      expect(templates[1].name).toBe('Zebra')
    })
  })
})
