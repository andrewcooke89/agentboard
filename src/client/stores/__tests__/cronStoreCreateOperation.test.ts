/**
 * Regression test for BUG-1 (partial): cronStore missing 'create' operation handler
 *
 * cronStore.handleCronOperationResult (cronStore.ts:196-213) only handles
 * 'pause' and 'resume' operations. When the server sends a cron-operation-result
 * for 'create', the store silently ignores it, providing no user feedback.
 *
 * Fix: Add a 'create' case to handleCronOperationResult that:
 *   - On success: shows a success toast "Job created"
 *   - On error: shows an error toast with the server's error message
 *
 * This test MUST FAIL until the fix is applied.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { useCronStore } from '../cronStore'

// Mock zustand store reset
const originalState = useCronStore.getState()

beforeEach(() => {
  // Reset store to initial state before each test
  useCronStore.setState({
    jobs: [],
    selectedJobId: null,
    selectedJobDetail: null,
    loading: false,
    hasLoaded: false,
    systemdAvailable: false,
    searchQuery: '',
    sortMode: 'name',
    filterMode: 'all',
    filterSource: null,
    filterTags: [],
    collapsedGroups: new Set(),
    activeTab: 'jobs',
    timelineVisible: false,
    timelineRange: 'day',
    selectedJobIds: new Set(),
    bulkSelectMode: false,
    runningJobs: new Set(),
    runOutputs: {},
    bulkProgress: null,
    notifications: [],
  })
})

afterEach(() => {
  // Restore original state
  useCronStore.setState(originalState)
})

describe('BUG-1: handleCronOperationResult create operation', () => {
  test('handleCronOperationResult handles create success', () => {
    const store = useCronStore.getState()

    // Set up a spy on console.warn to detect missing handler
    const warnLogs: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnLogs.push(args.join(' '))
    }

    // Call handler with 'create' operation success
    store.handleCronOperationResult('job-123', 'create', true, undefined)

    console.warn = originalWarn

    // After fix: should not log warning (handler exists)
    // BUG (current code): 'create' case falls through, no feedback given
    // The fix should add a notification to the store
    const { notifications } = useCronStore.getState()

    // After fix: should have a success notification
    // BUG (current code): notifications array is empty
    expect(notifications.length).toBeGreaterThan(0)
    expect(notifications[0]?.event).toBe('create')
    expect(notifications[0]?.severity).toBe('success')
  })

  test('handleCronOperationResult handles create error', () => {
    const store = useCronStore.getState()

    // Call handler with 'create' operation error
    store.handleCronOperationResult(
      'job-123',
      'create',
      false,
      'Invalid cron schedule'
    )

    const { notifications } = useCronStore.getState()

    // After fix: should have an error notification
    // BUG (current code): notifications array is empty, no feedback
    expect(notifications.length).toBeGreaterThan(0)
    expect(notifications[0]?.event).toBe('create')
    expect(notifications[0]?.severity).toBe('error')
    expect(notifications[0]?.message).toContain('Invalid cron schedule')
  })

  test('handleCronOperationResult still handles pause operation', () => {
    const store = useCronStore.getState()

    // Set up a job that can be paused
    useCronStore.setState({
      jobs: [{ id: 'job-123', name: 'Test Job', status: 'active' } as any],
    })

    // Call handler with 'pause' operation success
    store.handleCronOperationResult('job-123', 'pause', true, undefined)

    const { jobs } = useCronStore.getState()

    // Existing behavior: pause should work
    expect(jobs[0]?.status).toBe('paused')
  })

  test('handleCronOperationResult still handles resume operation', () => {
    const store = useCronStore.getState()

    // Set up a job that can be resumed
    useCronStore.setState({
      jobs: [{ id: 'job-123', name: 'Test Job', status: 'paused' } as any],
    })

    // Call handler with 'resume' operation success
    store.handleCronOperationResult('job-123', 'resume', true, undefined)

    const { jobs } = useCronStore.getState()

    // Existing behavior: resume should work
    expect(jobs[0]?.status).toBe('active')
  })
})
