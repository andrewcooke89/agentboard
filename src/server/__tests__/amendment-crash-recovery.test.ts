/**
 * Amendment Crash Recovery Tests (Phase 10)
 * Tests for REQ-42: Amendment crash recovery Scenario 2 - mid-handler cleanup
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createDAGEngine } from '../dagEngine'
import { initWorkflowStore } from '../workflowStore'
import type { WorkflowStore } from '../workflowStore'
import { initTaskStore } from '../taskStore'
import type { TaskStore } from '../taskStore'
import { createSessionPool } from '../sessionPool'
import type { SessionPool } from '../sessionPool'
import { initPoolTables } from '../db'
import type { WorkflowRun, StepRunState } from '../../shared/types'
import type { ServerContext } from '../serverContext'

describe('Amendment Crash Recovery - Scenario 2 (REQ-42)', () => {
  let db: Database
  let workflowStore: WorkflowStore
  let taskStore: TaskStore
  let pool: SessionPool
  let engine: ReturnType<typeof createDAGEngine>
  let ctx: ServerContext

  beforeEach(() => {
    db = new Database(':memory:')
    workflowStore = initWorkflowStore(db)
    taskStore = initTaskStore(db)
    initPoolTables(db)
    pool = createSessionPool(db)

    // Mock context
    ctx = {
      logger: {
        debug: mock(() => {}),
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
      },
      broadcast: mock(() => {}),
    } as unknown as ServerContext

    engine = createDAGEngine(ctx, workflowStore, taskStore, pool)
  })

  test('REQ-42: Releases pool slot on mid-handler crash recovery', () => {
    // Request a slot first
    const slotResult = pool.requestSlot({
      runId: 'test-run-1',
      stepName: 'step1',
      tier: 1,
    })
    expect(slotResult.rejected).toBe(false)
    expect(slotResult.slot).not.toBeNull()

    const slotId = slotResult.slot!.id

    // Create a workflow run with a step in handler_running phase
    // The slot is allocated to the handler task
    const run: WorkflowRun = {
      id: 'test-run-1',
      workflow_id: 'test-workflow',
      workflow_name: 'test-workflow',
      status: 'running',
      current_step_index: 0,
      output_dir: '/tmp/test-output',
      started_at: new Date().toISOString(),
      completed_at: null,
      error_message: null,
      variables: {},
      steps_state: [
        {
          name: 'step1',
          status: 'paused_amendment',
          amendmentPhase: 'handler_running',
          amendmentHandlerTaskId: slotId, // Use slot ID as handler task ID
          signalDir: '/tmp/test-signals-1',
          amendmentRetryCount: 0,
        } as StepRunState,
      ],
      created_at: new Date().toISOString(),
    }

    // Mock fs to simulate missing resolution files
    const fs = require('node:fs')
    const originalExistsSync = fs.existsSync
    const originalReaddirSync = fs.readdirSync

    fs.existsSync = mock((path: string) => path === '/tmp/test-signals-1')
    fs.readdirSync = mock(() => []) // No resolution files

    try {
      // Verify slot is active before recovery
      const statusBefore = pool.getStatus()
      expect(statusBefore.active.length).toBe(1)
      expect(statusBefore.active[0].id).toBe(slotId)

      // Run tick to trigger recovery
      engine.tick(run, {
        name: 'test-workflow',
        description: 'Test',
        variables: [],
        steps: [{ name: 'step1', type: 'spawn_session' } as any],
      })

      // Verify slot was released
      const statusAfter = pool.getStatus()
      expect(statusAfter.active.length).toBe(0)

      // Verify logging
      expect(ctx.logger.info).toHaveBeenCalledWith(
        'dag_amendment_recover_released_slot',
        expect.objectContaining({
          runId: 'test-run-1',
          slotId: slotId,
        })
      )

      // Verify handler task ID was cleared
      expect(run.steps_state[0].amendmentHandlerTaskId).toBeNull()
    } finally {
      fs.existsSync = originalExistsSync
      fs.readdirSync = originalReaddirSync
    }
  })

  test('REQ-42: Clears handler task ID on recovery', () => {
    const run: WorkflowRun = {
      id: 'test-run-2',
      workflow_id: 'test-workflow',
      workflow_name: 'test-workflow',
      status: 'running',
      current_step_index: 0,
      output_dir: '/tmp/test-output',
      started_at: new Date().toISOString(),
      completed_at: null,
      error_message: null,
      variables: {},
      steps_state: [
        {
          name: 'step1',
          status: 'paused_amendment',
          amendmentPhase: 'handler_running',
          amendmentHandlerTaskId: 'handler-task-123',
          signalDir: '/tmp/test-signals-2',
          amendmentRetryCount: 0,
        } as StepRunState,
      ],
      created_at: new Date().toISOString(),
    }

    // Mock fs
    const fs = require('node:fs')
    const originalExistsSync = fs.existsSync
    const originalReaddirSync = fs.readdirSync

    fs.existsSync = mock((path: string) => path === '/tmp/test-signals-2')
    fs.readdirSync = mock(() => [])

    try {
      // Run tick to trigger recovery
      engine.tick(run, {
        name: 'test-workflow',
        description: 'Test',
        variables: [],
        steps: [{ name: 'step1', type: 'spawn_session' } as any],
      })

      // Verify handler task ID was cleared (set to null for retry)
      expect(run.steps_state[0].amendmentHandlerTaskId).toBeNull()

      // Verify retry count was incremented
      expect(run.steps_state[0].amendmentRetryCount).toBe(1)

      // Verify logging
      expect(ctx.logger.info).toHaveBeenCalledWith(
        'dag_amendment_recover',
        expect.objectContaining({
          runId: 'test-run-2',
          scenario: 'mid_handler',
          action: 'retry',
          retryCount: 1,
        })
      )
    } finally {
      fs.existsSync = originalExistsSync
      fs.readdirSync = originalReaddirSync
    }
  })

  test('REQ-42: Escalates after max retries', () => {
    const run: WorkflowRun = {
      id: 'test-run-4',
      workflow_id: 'test-workflow',
      workflow_name: 'test-workflow',
      status: 'running',
      current_step_index: 0,
      output_dir: '/tmp/test-output',
      started_at: new Date().toISOString(),
      completed_at: null,
      error_message: null,
      variables: {},
      steps_state: [
        {
          name: 'step1',
          status: 'paused_amendment',
          amendmentPhase: 'handler_running',
          amendmentHandlerTaskId: 'handler-task-789',
          signalDir: '/tmp/test-signals-4',
          amendmentRetryCount: 1, // Already tried once
        } as StepRunState,
      ],
      created_at: new Date().toISOString(),
    }

    // Mock fs
    const fs = require('node:fs')
    const originalExistsSync = fs.existsSync
    const originalReaddirSync = fs.readdirSync

    fs.existsSync = mock((path: string) => path === '/tmp/test-signals-4')
    fs.readdirSync = mock(() => [])

    try {
      // Run tick to trigger recovery
      engine.tick(run, {
        name: 'test-workflow',
        description: 'Test',
        variables: [],
        steps: [{ name: 'step1', type: 'spawn_session' } as any],
      })

      // Verify status escalated to paused_escalated
      expect(run.steps_state[0].status).toBe('paused_escalated')

      // Verify phase changed to awaiting_human
      expect(run.steps_state[0].amendmentPhase).toBe('awaiting_human')

      // Verify handler task ID was cleared
      expect(run.steps_state[0].amendmentHandlerTaskId).toBeNull()

      // Verify retry count was incremented
      expect(run.steps_state[0].amendmentRetryCount).toBe(2)

      // Verify logging
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        'dag_amendment_recover',
        expect.objectContaining({
          runId: 'test-run-4',
          scenario: 'mid_handler',
          action: 'max_retries_escalated',
        })
      )
    } finally {
      fs.existsSync = originalExistsSync
      fs.readdirSync = originalReaddirSync
    }
  })
})
