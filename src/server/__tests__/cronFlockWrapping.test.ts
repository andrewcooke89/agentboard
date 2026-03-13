/**
 * Regression test for BUG-3: No concurrent-run guard for scheduled runs
 *
 * The activeManualRuns Set in cronHandlers.ts only guards manual "Run Now"
 * WebSocket requests. Scheduled runs are triggered by the OS cron daemon
 * entirely outside the agentboard process, bypassing all concurrency guards.
 *
 * Fix: Wrap crontab commands with flock(1) for OS-level mutual exclusion:
 *   flock -n /tmp/agentboard-cron-<jobId>.lock <original-command>
 *
 * This ensures that:
 *   - Scheduled runs cannot overlap with each other
 *   - Manual "Run Now" runs cannot overlap with scheduled runs
 *   - Manual runs use the same lock file path
 *
 * This test MUST FAIL until the fix is applied.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { CronManager } from '../cronManager'
import type { CronCreateConfig } from '../../shared/types'

// ─── TestableCronManager: exposes crontab read/write for testing ───────────────

class TestableCronManager extends CronManager {
  private mockCrontab: string = ''
  private writeLog: string[] = []

  /** Set the mock crontab content for readCrontab() */
  setMockCrontab(content: string): void {
    this.mockCrontab = content
  }

  /** Get all writeCrontab() calls made during the test */
  getWriteLog(): string[] {
    return this.writeLog
  }

  /** Override to return mock crontab instead of calling `crontab -l` */
  protected async readCrontab(): Promise<string> {
    return this.mockCrontab
  }

  /** Override to capture writes instead of calling `crontab -` */
  protected async writeCrontab(content: string): Promise<void> {
    this.writeLog.push(content)
    this.mockCrontab = content
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BUG-3: flock wrapping for OS-level concurrent-run guard', () => {
  let manager: TestableCronManager

  beforeEach(() => {
    manager = new TestableCronManager()
    manager.setMockCrontab('')
  })

  test('createCronJob wraps command with flock for mutual exclusion', async () => {
    const config: CronCreateConfig = {
      schedule: '0 9 * * *',
      command: '/usr/local/bin/backup.sh',
      comment: 'daily backup',
      tags: [],
    }

    await manager.createCronJob(config)

    const writtenCrontab = manager.getWriteLog()[0]
    expect(writtenCrontab).toBeDefined()

    // After fix: the command should be wrapped with flock
    // Pattern: flock -n /tmp/agentboard-cron-<something>.lock /usr/local/bin/backup.sh
    // BUG (current code): command is appended directly without flock
    expect(writtenCrontab).toMatch(/flock\s+-n\s+\/tmp\/agentboard-cron-[\w-]+\.lock/)
    expect(writtenCrontab).toContain('/usr/local/bin/backup.sh')
  })

  test('flock lock file uses consistent jobId-based naming', async () => {
    const config: CronCreateConfig = {
      schedule: '0 9 * * *',
      command: '/usr/local/bin/backup.sh',
      comment: 'daily backup',
      tags: [],
    }

    const jobId = await manager.createCronJob(config)
    const writtenCrontab = manager.getWriteLog()[0]

    // After fix: the lock file path should contain the jobId
    // This allows runJobNow to use the same lock file
    // BUG (current code): no flock wrapping at all
    expect(writtenCrontab).toContain(jobId)
    expect(writtenCrontab).toMatch(new RegExp(`/tmp/agentboard-cron-${jobId}\\.lock`))
  })

  test('flock uses non-blocking mode (-n flag)', async () => {
    const config: CronCreateConfig = {
      schedule: '*/5 * * * *',
      command: '/usr/local/bin/check-health.sh',
      comment: 'health check',
      tags: [],
    }

    await manager.createCronJob(config)

    const writtenCrontab = manager.getWriteLog()[0]

    // After fix: must use -n (non-blocking) so overlapping runs fail fast
    // BUG (current code): no flock wrapping at all
    expect(writtenCrontab).toMatch(/flock\s+-n\b/)
  })

  test('flock wrapping preserves original command as the wrapped target', async () => {
    const config: CronCreateConfig = {
      schedule: '0 0 * * *',
      command: '/usr/bin/docker run --rm my-backup-image',
      comment: 'docker backup',
      tags: [],
    }

    await manager.createCronJob(config)

    const writtenCrontab = manager.getWriteLog()[0]

    // After fix: the full original command (including args) should be wrapped
    // BUG (current code): command is not wrapped at all
    expect(writtenCrontab).toContain('/usr/bin/docker run --rm my-backup-image')
    // Verify it's flock <lockfile> <command> pattern, not flock somewhere else
    expect(writtenCrontab).toMatch(/flock\s+-n\s+\/tmp\/[\w.-]+\s+\/usr\/bin\/docker/)
  })

  test('flock lock files use /tmp directory for cross-process visibility', async () => {
    const config: CronCreateConfig = {
      schedule: '@hourly',
      command: '/usr/local/bin/hourly-task.sh',
      comment: '',
      tags: [],
    }

    await manager.createCronJob(config)

    const writtenCrontab = manager.getWriteLog()[0]

    // After fix: lock files in /tmp are visible to both cron daemon and agentboard
    // BUG (current code): no flock, no lock file
    expect(writtenCrontab).toContain('/tmp/agentboard-cron-')
    expect(writtenCrontab).toContain('.lock')
  })

  test('multiple jobs get different lock files', async () => {
    const config1: CronCreateConfig = {
      schedule: '0 9 * * *',
      command: '/usr/local/bin/backup.sh',
      comment: 'backup job',
      tags: [],
    }
    const config2: CronCreateConfig = {
      schedule: '0 12 * * *',
      command: '/usr/local/bin/report.sh',
      comment: 'report job',
      tags: [],
    }

    await manager.createCronJob(config1)
    await manager.createCronJob(config2)

    const writes = manager.getWriteLog()
    expect(writes).toHaveLength(2)

    // After fix: each job should have a unique lock file path
    // BUG (current code): no flock wrapping at all
    const lockPaths = writes.map(w => {
      const match = w.match(/\/tmp\/agentboard-cron-[\w-]+\.lock/)
      return match ? match[0] : null
    })

    expect(lockPaths[0]).toBeDefined()
    expect(lockPaths[1]).toBeDefined()
    expect(lockPaths[0]).not.toBe(lockPaths[1])
  })

  test('jobId is computed from ORIGINAL command, not flock-wrapped version', async () => {
    const originalCommand = '/usr/local/bin/my-task.sh --arg1 --arg2'
    const config: CronCreateConfig = {
      schedule: '0 * * * *',
      command: originalCommand,
      comment: 'hourly task',
      tags: [],
    }

    const returnedJobId = await manager.createCronJob(config)
    const writtenCrontab = manager.getWriteLog()[0]

    // CRITICAL: The jobId must be computed from the ORIGINAL command,
    // not from "flock -n /tmp/... /usr/local/bin/my-task.sh --arg1 --arg2"
    // If the fix accidentally computes jobId from the wrapped command,
    // the lock file path would be based on a different hash.

    // After fix: jobId should NOT contain 'flock' anywhere
    // BUG (current code): no flock wrapping, so this passes trivially
    // After fix: if jobId is wrongly computed from wrapped command, this fails
    expect(returnedJobId).not.toContain('flock')
    expect(returnedJobId).not.toContain('/tmp/agentboard-cron-')

    // The jobId should be deterministic and based on the original command
    // Create a new manager and create the same job - jobId should be the same
    const manager2 = new TestableCronManager()
    manager2.setMockCrontab('')
    const returnedJobId2 = await manager2.createCronJob(config)

    // Same command should produce same jobId (deterministic)
    expect(returnedJobId).toBe(returnedJobId2)

    // After fix: verify the lock file in crontab contains this jobId
    // BUG (current code): no flock at all
    expect(writtenCrontab).toContain(returnedJobId)
    expect(writtenCrontab).toMatch(new RegExp(`/tmp/agentboard-cron-${returnedJobId}\\.lock`))
  })
})
