/**
 * Regression test for GAP-05: No server-side concurrent-run guard
 *
 * handleCronJobRunNow in cronHandlers.ts spawns a new run unconditionally.
 * There is no server-side check for whether the job is already running.
 * Sending two rapid cron-run-now requests for the same job spawns duplicates.
 *
 * This test MUST FAIL until the fix adds an activeManualRuns Set guard.
 */

import { describe, test, expect } from 'bun:test'
import { createCronHandlers } from '../handlers/cronHandlers'
import type { CronManager } from '../cronManager'
import type { CronHistoryService } from '../cronHistoryService'
import type { CronLogService } from '../cronLogService'
import type { ServerContext, WSData } from '../serverContext'
import type { ServerWebSocket } from 'bun'
import type { ServerMessage } from '../../shared/types'

// ── Mock helpers (following workflowWsHandlers.test.ts pattern) ──────────────

function createMockContext() {
  const sent: ServerMessage[] = []
  const ctx = {
    config: {},
    logger: { debug: () => {}, info: () => {}, error: () => {}, warn: () => {} },
    send: (_ws: unknown, msg: ServerMessage) => { sent.push(msg) },
    broadcast: (msg: ServerMessage) => { sent.push(msg) },
  } as unknown as ServerContext
  return { ctx, sent }
}

/** Creates a CronManager mock whose runJobNow blocks until unblock() is called */
function createBlockingCronManager() {
  let resolveBlock: () => void = () => {}
  const blockPromise = new Promise<void>(r => { resolveBlock = r })

  const manager = {
    jobCache: new Map(),
    onJobsChanged: () => {},
    runJobNow: async function* (_jobId: string) {
      yield 'running...\n'
      await blockPromise // blocks until unblock() — simulates a long-running job
    },
  } as unknown as CronManager

  return { manager, unblock: () => resolveBlock() }
}

function createMockHistoryService(): CronHistoryService {
  return {
    recordManualRun: async () => {},
    getRunHistory: async () => [],
  } as unknown as CronHistoryService
}

function createMockLogService(): CronLogService {
  return {
    getLogs: async () => [],
    tailLogs: async function* () {},
  } as unknown as CronLogService
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GAP-05: concurrent-run guard for handleCronJobRunNow', () => {
  test('second run-now for the same jobId while first is running sends error', async () => {
    const { ctx, sent } = createMockContext()
    const { manager, unblock } = createBlockingCronManager()
    const handlers = createCronHandlers(
      ctx, manager, createMockHistoryService(), createMockLogService()
    )
    const ws = {} as ServerWebSocket<WSData>

    // Trigger run-now twice in rapid succession for the same job
    await handlers.handleCronJobRunNow(ws, 'job-1')
    await handlers.handleCronJobRunNow(ws, 'job-1')

    const startMsgs = sent.filter((m: any) => m.type === 'cron-run-started')
    const errorMsgs = sent.filter((m: any) => m.type === 'error')

    // With fix: first call starts the job, second is rejected with error.
    // BUG (current code): both calls send cron-run-started, 0 errors.
    expect(startMsgs).toHaveLength(1)
    expect(errorMsgs).toHaveLength(1)
    expect((errorMsgs[0] as any)?.message).toMatch(/already running/i)

    // Cleanup: unblock the hanging generator to prevent test timeout
    unblock()
  })
})
