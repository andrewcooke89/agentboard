/**
 * Regression tests for bugs:
 * - Bug 1: createCronJob() missing duplicate detection
 * - Bug 2: handleCronOperationResult() missing 'create' handler
 *
 * These tests call the ACTUAL implementations (CronManager, cronStore),
 * NOT inline mock reimplementations. They MUST FAIL with current buggy code
 * and PASS after the fix is applied.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { CronManager } from '../cronManager'

// ── Bug 1: createCronJob() missing duplicate detection ──────────────────────────

describe('Bug 1: createCronJob() should detect duplicates (real implementation)', () => {
  let cronManager: CronManager
  let crontabContent: string

  beforeEach(() => {
    cronManager = new CronManager()
    crontabContent = ''

    // Mock only the I/O methods, keep the actual business logic
    ;(cronManager as unknown as { readCrontab: () => Promise<string> }).readCrontab = async () => crontabContent
    ;(cronManager as unknown as { writeCrontab: (c: string) => Promise<void> }).writeCrontab = async (content: string) => {
      crontabContent = content
    }
  })

  afterEach(() => {
    cronManager = undefined as unknown as CronManager
  })

  test('createCronJob throws error when identical schedule+command already exists', async () => {
    const config = {
      command: '/usr/bin/echo hello',
      schedule: '0 * * * *',
      comment: 'test job',
      tags: [] as string[],
    }

    // First call should succeed
    await cronManager.createCronJob(config)

    // Second call with IDENTICAL schedule+command should throw
    // BUG (current code): does NOT throw, silently creates duplicate
    // FIX: should throw error matching /duplicate/i
    await expect(cronManager.createCronJob(config)).rejects.toThrow(/duplicate/i)
  })

  test('createCronJob allows jobs with same command but different schedule', async () => {
    // Create first job
    await cronManager.createCronJob({
      command: '/usr/bin/backup',
      schedule: '0 2 * * *',
      comment: 'daily backup',
      tags: [],
    })

    // Second job with SAME command but DIFFERENT schedule should be allowed
    // Both buggy and fixed code should allow this
    await expect(
      cronManager.createCronJob({
        command: '/usr/bin/backup',
        schedule: '0 4 * * *',
        comment: 'second daily backup',
        tags: [],
      })
    ).resolves.toBeDefined()
  })

  test('createCronJob allows jobs with same schedule but different command', async () => {
    // Create first job
    await cronManager.createCronJob({
      command: '/usr/bin/task1',
      schedule: '0 * * * *',
      comment: 'hourly task 1',
      tags: [],
    })

    // Second job with SAME schedule but DIFFERENT command should be allowed
    await expect(
      cronManager.createCronJob({
        command: '/usr/bin/task2',
        schedule: '0 * * * *',
        comment: 'hourly task 2',
        tags: [],
      })
    ).resolves.toBeDefined()
  })

  test('createCronJob detects duplicates even when existing entry is paused', async () => {
    // Pre-populate crontab with a paused entry (prefixed with #AGENTBOARD_PAUSED:)
    crontabContent = '#AGENTBOARD_PAUSED:0 * * * * /usr/bin/paused-task # paused job\n'

    // Try to create a new job with same schedule+command
    // FIX: should detect duplicate even from paused entries
    await expect(
      cronManager.createCronJob({
        command: '/usr/bin/paused-task',
        schedule: '0 * * * *',
        comment: '',
        tags: [],
      })
    ).rejects.toThrow(/duplicate/i)
  })

  test('createCronJob strips trailing comments before comparing commands', async () => {
    // Pre-populate crontab with entry that has a comment
    crontabContent = '0 * * * * /usr/bin/mytask # original comment\n'

    // Try to create a new job with same schedule+command but different comment
    // The trailing comment should be stripped before comparison
    // So this SHOULD be detected as duplicate
    await expect(
      cronManager.createCronJob({
        command: '/usr/bin/mytask',
        schedule: '0 * * * *',
        comment: 'different comment',
        tags: [],
      })
    ).rejects.toThrow(/duplicate/i)
  })
})

// ── Bug 2: handleCronOperationResult() missing 'create' handler ──────────────────
// Note: This tests the client cronStore, but we import it from client directory
// Bun can handle this for unit tests

describe('Bug 2: handleCronOperationResult should handle create operation (real implementation)', () => {
  // We need to dynamically import the client store
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useCronStore } = require('../../client/stores/cronStore') as typeof import('../../client/stores/cronStore')

  beforeEach(() => {
    // Reset the store state before each test
    useCronStore.setState({
      notifications: [],
      jobs: [],
    })
  })

  test("handleCronOperationResult handles 'create' operation with success feedback", () => {
    const store = useCronStore.getState()

    // Call the real handleCronOperationResult with 'create' operation
    store.handleCronOperationResult('job-123', 'create', true)

    // BUG (current code): 'create' operation is ignored - no notification added
    // FIX: should add a notification with message matching /created/i
    const notifications = useCronStore.getState().notifications
    expect(notifications.length).toBeGreaterThan(0)
    expect(notifications[0]?.message).toMatch(/created/i)
    expect(notifications[0]?.severity).toBe('success')
  })

  test("handleCronOperationResult handles 'create' operation with error feedback", () => {
    const store = useCronStore.getState()

    // Call with error - simulating duplicate detection failure
    store.handleCronOperationResult(
      'job-123',
      'create',
      false,
      'Duplicate cron entry: identical schedule and command already exists'
    )

    // BUG (current code): error case only logs warning, no notification
    // FIX: should add a notification with the error message
    const notifications = useCronStore.getState().notifications
    expect(notifications.length).toBeGreaterThan(0)
    expect(notifications[0]?.message).toMatch(/duplicate/i)
    expect(notifications[0]?.severity).toBe('error')
  })

  test('existing pause/resume handling in handleCronOperationResult is unchanged', () => {
    const store = useCronStore.getState()

    // Set up a job that can be paused
    useCronStore.setState({
      jobs: [{ id: 'job-123', name: 'Test', status: 'active' } as never],
    })

    // Test pause operation still works
    store.handleCronOperationResult('job-123', 'pause', true)
    const pausedJob = useCronStore.getState().jobs.find((j: { id: string }) => j.id === 'job-123')
    expect((pausedJob as { status: string })?.status).toBe('paused')

    // Test resume operation still works
    store.handleCronOperationResult('job-123', 'resume', true)
    const resumedJob = useCronStore.getState().jobs.find((j: { id: string }) => j.id === 'job-123')
    expect((resumedJob as { status: string })?.status).toBe('active')
  })

  test('notifications array is capped at 50 entries', () => {
    const store = useCronStore.getState()

    // Add 55 notifications by calling handleCronOperationResult multiple times
    for (let i = 0; i < 55; i++) {
      store.handleCronOperationResult(`job-${i}`, 'create', true)
    }

    // Verify array is capped at 50
    const notifications = useCronStore.getState().notifications
    expect(notifications.length).toBeLessThanOrEqual(50)
  })
})
