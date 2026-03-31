/**
 * queueDepth.test.ts -- Tests for pool queue depth limit (Phase 5, Batch 3)
 * REQ-24: Queue depth limit on new run submissions AND at slot-request time (CF-01)
 * REQ-29: Queue overflow rejects only new run submissions
 * REQ-37: Queue depth only when session_pool: true (CF-04)
 * REQ-41: Steps already queued within active runs are NOT affected
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { initWorkflowStore } from '../workflowStore'
import type { WorkflowStore } from '../workflowStore'
import { initPoolTables } from '../db'
import { createSessionPool } from '../sessionPool'
import type { SessionPool } from '../sessionPool'
import { createWorkflowHandlers } from '../handlers/workflowHandlers'
import type { ServerContext } from '../serverContext'
import type { ServerMessage } from '../../shared/types'

// ── Test Helpers ─────────────────────────────────────────────────────────────

const POOL_YAML = `name: pool-workflow
system:
  engine: dag
  session_pool: true
steps:
  - name: build
    type: spawn_session
    projectPath: /tmp/project
    prompt: "Run build"
`

const LEGACY_YAML = `name: legacy-workflow
steps:
  - name: build
    type: spawn_session
    projectPath: /tmp/project
    prompt: "Run build"
`

function createTestDb(): { db: SQLiteDatabase; workflowStore: WorkflowStore } {
  const db = new SQLiteDatabase(':memory:')
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'queued'
  )`)
  const workflowStore = initWorkflowStore(db)
  initPoolTables(db)
  return { db, workflowStore }
}

function createMockContext(workflowStore: WorkflowStore): {
  ctx: ServerContext
  broadcasts: ServerMessage[]
} {
  const broadcasts: ServerMessage[] = []
  const ctx = {
    workflowStore,
    config: {
      workflowDir: '/tmp/test-workflows',
      workflowMaxConcurrentRuns: 10,
      workflowEngineEnabled: true,
    },
    broadcast: (msg: ServerMessage) => {
      broadcasts.push(msg)
    },
    logger: {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    },
    taskStore: {
      getTask: () => null,
    },
  } as unknown as ServerContext
  return { ctx, broadcasts }
}

/**
 * Helper: creates a pool + app with the given queue depth env var already set.
 * This ensures the pool picks up the correct max depth at construction time.
 */
function createPoolAndApp(
  db: SQLiteDatabase,
  ctx: ServerContext,
): { pool: SessionPool; app: Hono } {
  const pool = createSessionPool(db)
  const app = new Hono()
  const handlers = createWorkflowHandlers(ctx, pool)
  handlers.registerRoutes(app)
  return { pool, app }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('queue depth limit', () => {
  let db: SQLiteDatabase
  let workflowStore: WorkflowStore
  let ctx: ServerContext
  let origDepthEnv: string | undefined

  beforeEach(() => {
    const stores = createTestDb()
    db = stores.db
    workflowStore = stores.workflowStore
    const mock = createMockContext(workflowStore)
    ctx = mock.ctx
    origDepthEnv = process.env.AGENTBOARD_MAX_POOL_QUEUE_DEPTH
  })

  afterEach(() => {
    try { db.close() } catch { /* ok */ }
    // Restore env var
    if (origDepthEnv !== undefined) {
      process.env.AGENTBOARD_MAX_POOL_QUEUE_DEPTH = origDepthEnv
    } else {
      delete process.env.AGENTBOARD_MAX_POOL_QUEUE_DEPTH
    }
  })

  // ── TEST-18: Queue depth limit enforcement ──────────────────────────────

  test('TEST-18: rejects new run when pool queue is at max depth', async () => {
    // Set env var for small max depth BEFORE creating pool
    process.env.AGENTBOARD_MAX_POOL_QUEUE_DEPTH = '3'
    const { pool, app } = createPoolAndApp(db, ctx)

    // Create workflow with session_pool: true
    const wf = workflowStore.createWorkflow({
      name: 'pool-workflow',
      description: 'Test',
      yaml_content: POOL_YAML,
      file_path: null,
      is_valid: true,
      validation_errors: [],
      step_count: 1,
    })

    // Fill pool to capacity (maxSlots = 2 default)
    pool.requestSlot({ runId: 'r1', stepName: 's1', tier: 1 })
    pool.requestSlot({ runId: 'r2', stepName: 's2', tier: 1 })

    // Queue up to max depth (3)
    pool.requestSlot({ runId: 'r3', stepName: 's3', tier: 1 })
    pool.requestSlot({ runId: 'r4', stepName: 's4', tier: 1 })
    pool.requestSlot({ runId: 'r5', stepName: 's5', tier: 1 })

    // New run should be rejected (queue depth = 3 >= max 3)
    const res = await app.request(`/api/workflows/${wf.id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(429)
    const body = await res.json() as any
    expect(body.code).toBe('POOL_QUEUE_FULL')
    expect(body.queueDepth).toBe(3)
    expect(body.maxDepth).toBe(3)
  })

  // ── TEST-29: Queue overflow rejects only new run submissions ────────────

  test('TEST-29: in-progress queued steps are NOT affected by queue depth limit', async () => {
    process.env.AGENTBOARD_MAX_POOL_QUEUE_DEPTH = '2'
    const { pool, app } = createPoolAndApp(db, ctx)

    const wf = workflowStore.createWorkflow({
      name: 'pool-workflow',
      description: 'Test',
      yaml_content: POOL_YAML,
      file_path: null,
      is_valid: true,
      validation_errors: [],
      step_count: 1,
    })

    // Fill pool + queue
    pool.requestSlot({ runId: 'r1', stepName: 's1', tier: 1 })
    pool.requestSlot({ runId: 'r2', stepName: 's2', tier: 1 })
    pool.requestSlot({ runId: 'existing-run', stepName: 'existing-queued', tier: 1 })
    pool.requestSlot({ runId: 'existing-run', stepName: 'existing-queued-2', tier: 1 })

    // Queue is full (2/2). New submissions rejected.
    const res = await app.request(`/api/workflows/${wf.id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(429)

    // But existing queued steps in pool are still queued (not cancelled)
    const status = pool.getStatus()
    expect(status.queue.length).toBe(2)
    expect(status.queue[0].stepName).toBe('existing-queued')
    expect(status.queue[1].stepName).toBe('existing-queued-2')
  })

  // ── REQ-37/CF-04: Queue depth only when session_pool: true ──────────────

  test('REQ-37: queue depth not enforced for non-pool workflows', async () => {
    process.env.AGENTBOARD_MAX_POOL_QUEUE_DEPTH = '1'
    const { pool, app } = createPoolAndApp(db, ctx)

    // Create legacy workflow (no session_pool)
    const wf = workflowStore.createWorkflow({
      name: 'legacy-workflow',
      description: 'Test',
      yaml_content: LEGACY_YAML,
      file_path: null,
      is_valid: true,
      validation_errors: [],
      step_count: 1,
    })

    // Fill pool queue beyond limit
    pool.requestSlot({ runId: 'r1', stepName: 's1', tier: 1 })
    pool.requestSlot({ runId: 'r2', stepName: 's2', tier: 1 })

    // Legacy workflow should NOT be rejected (no session_pool in YAML)
    // CF-04: Queue depth check only applies to pool-enabled workflows
    const res = await app.request(`/api/workflows/${wf.id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    // Should succeed (201) not be rejected
    expect(res.status).toBe(201)
  })

  // ── TEST-26: All existing tests pass under legacy engine (regression) ──

  test('TEST-26: non-pool workflow run creation works unchanged', async () => {
    // No queue depth env set - use default pool
    const { app } = createPoolAndApp(db, ctx)

    const wf = workflowStore.createWorkflow({
      name: 'legacy-test',
      description: 'Test',
      yaml_content: LEGACY_YAML,
      file_path: null,
      is_valid: true,
      validation_errors: [],
      step_count: 1,
    })

    const res = await app.request(`/api/workflows/${wf.id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.status).toBe('running')
    expect(body.steps_state).toHaveLength(1)
    expect(body.steps_state[0].name).toBe('build')
  })

  // ── Queue depth allows run when under limit ─────────────────────────────

  test('pool workflow accepted when queue depth is under limit', async () => {
    process.env.AGENTBOARD_MAX_POOL_QUEUE_DEPTH = '10'
    const { pool, app } = createPoolAndApp(db, ctx)

    const wf = workflowStore.createWorkflow({
      name: 'pool-workflow',
      description: 'Test',
      yaml_content: POOL_YAML,
      file_path: null,
      is_valid: true,
      validation_errors: [],
      step_count: 1,
    })

    // Queue only 2 items (under limit of 10)
    pool.requestSlot({ runId: 'r1', stepName: 's1', tier: 1 })
    pool.requestSlot({ runId: 'r2', stepName: 's2', tier: 1 })
    pool.requestSlot({ runId: 'r3', stepName: 's3', tier: 1 })

    const res = await app.request(`/api/workflows/${wf.id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(201)
  })

  // ── CF-04: Legacy 429 behavior preserved ────────────────────────────────

  test('CF-04: legacy workflows use TASK_MAX_CONCURRENT limit, not pool queue depth', async () => {
    // Set a very restrictive queue depth
    process.env.AGENTBOARD_MAX_POOL_QUEUE_DEPTH = '0'

    // Create context with very low concurrent run limit
    const lowLimitCtx = {
      ...ctx,
      config: {
        ...ctx.config,
        workflowMaxConcurrentRuns: 1,
      },
    } as ServerContext

    const { app: lowLimitApp } = createPoolAndApp(db, lowLimitCtx)

    const wf = workflowStore.createWorkflow({
      name: 'legacy-429',
      description: 'Test',
      yaml_content: LEGACY_YAML,
      file_path: null,
      is_valid: true,
      validation_errors: [],
      step_count: 1,
    })

    // First run succeeds (legacy, ignores pool queue depth)
    const res1 = await lowLimitApp.request(`/api/workflows/${wf.id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res1.status).toBe(201)

    // Second run hits TASK_MAX_CONCURRENT limit (legacy 429)
    const res2 = await lowLimitApp.request(`/api/workflows/${wf.id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res2.status).toBe(429)
    const body = await res2.json() as any
    expect(body.code).toBe('RATE_LIMIT_EXCEEDED')
    expect(body.limit).toBe(1)
  })
})
