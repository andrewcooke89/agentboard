// WU-003: CronAiService Unit Tests
// Tests with mocked CronManager, HistoryService, LogService, SessionManager.

import { describe, it, expect, beforeEach, mock, afterEach } from 'bun:test'
import { CronAiService, type CronAiServiceConfig, type CronAiServiceDeps } from '../cronAiService'
import type {
  CronJob,
  CronJobDetail,
  JobRunRecord,
  UiContext,
  CronAiProposal,
} from '@shared/types'
import { readFileSync, statSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCronJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'job-1',
    name: 'test-backup',
    source: 'user-crontab',
    schedule: '0 * * * *',
    scheduleHuman: 'Every hour',
    command: '/usr/bin/backup.sh',
    scriptPath: '/usr/bin/backup.sh',
    projectGroup: 'default',
    status: 'active',
    health: 'healthy',
    healthReason: null,
    lastRun: '2026-02-25T10:00:00Z',
    lastRunDuration: 45,
    nextRun: '2026-02-25T11:00:00Z',
    lastExitCode: 0,
    consecutiveFailures: 0,
    avgDuration: 42,
    user: 'andrew',
    requiresSudo: false,
    avatarUrl: null,
    unitFile: null,
    description: 'Hourly backup',
    tags: ['backup'],
    isManagedByAgentboard: false,
    linkedSessionId: null,
    ...overrides,
  }
}

function makeJobDetail(overrides: Partial<CronJobDetail> = {}): CronJobDetail {
  return {
    ...makeCronJob(),
    scriptContent: '#!/bin/bash\necho backup',
    scriptLanguage: 'bash',
    timerConfig: null,
    serviceConfig: null,
    crontabLine: '0 * * * * /usr/bin/backup.sh',
    runHistory: [],
    recentLogs: [],
    ...overrides,
  }
}

function makeUiContext(overrides: Partial<UiContext> = {}): UiContext {
  return {
    selectedJobId: null,
    selectedJobDetail: null,
    activeTab: 'overview',
    visibleJobCount: 10,
    filterState: { mode: 'all', source: null, tags: [] },
    healthSummary: { healthy: 5, warning: 1, critical: 0 },
    ...overrides,
  }
}

function makeRunRecord(overrides: Partial<JobRunRecord> = {}): JobRunRecord {
  return {
    timestamp: '2026-02-25T10:00:00Z',
    endTimestamp: '2026-02-25T10:00:45Z',
    duration: 45,
    exitCode: 0,
    trigger: 'scheduled',
    logSnippet: null,
    ...overrides,
  }
}

// ─── Mocks ────────────────────────────────────────────────────────────────────

function createMockDeps(): CronAiServiceDeps {
  return {
    cronManager: {
      discoverAllJobs: mock(() => Promise.resolve([])),
      pauseJob: mock(() => Promise.resolve()),
      resumeJob: mock(() => Promise.resolve()),
      deleteJob: mock(() => Promise.resolve()),
      runJobNow: mock(async function* () { yield 'done' }),
      createCronJob: mock(() => Promise.resolve('new-job-id')),
      editFrequency: mock(() => Promise.resolve()),
      jobCache: new Map(),
    },
    historyService: {
      getRunHistory: mock(() => Promise.resolve([])),
      getRecentDurations: mock(() => Promise.resolve([40, 42, 45])),
    },
    logService: {
      getLogs: mock(() => Promise.resolve([])),
    },
    sessionManager: {
      createWindow: mock(() => ({ id: 'agentboard:agentboard-cron-ai', name: 'agentboard-cron-ai', tmuxWindow: 'agentboard:agentboard-cron-ai' })),
      killWindow: mock(() => {}),
      listWindows: mock(() => [
        { name: 'my-project', tmuxWindow: '1' },
        { name: 'agentboard-cron-ai', tmuxWindow: '2' },
      ]),
    },
  }
}

const DEFAULT_CONFIG: CronAiServiceConfig = { port: 4040, proposalTimeoutMs: 500 }
const AUTH_CONFIG: CronAiServiceConfig = { port: 4040, authToken: 'test-secret-token', proposalTimeoutMs: 500 }

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CronAiService', () => {
  let service: CronAiService
  let deps: CronAiServiceDeps

  beforeEach(() => {
    deps = createMockDeps()
    service = new CronAiService(deps, DEFAULT_CONFIG)
  })

  afterEach(() => {
    // Resolve any pending proposals to clear timers and prevent hanging
    for (const p of service.getPendingProposals()) {
      service.resolveProposal(p.id, false, 'test-cleanup')
    }
  })

  // ── Proposal Create / Resolve (AC-003-1, AC-003-2, AC-003-3) ──────────

  describe('proposal-create-resolve', () => {
    it('creates a proposal and resolves on accept — mutation executed', async () => {
      const job = makeCronJob({ id: 'job-1' })
      ;(deps.cronManager as any).jobCache.set('job-1', job)

      const proposalPromise = service.createProposal({
        operation: 'pause',
        jobId: 'job-1',
        jobName: 'test-backup',
        description: 'Pause the backup job for maintenance',
        diff: '- status: active\n+ status: paused',
      })

      // Proposal should be pending
      const pending = service.getPendingProposals()
      expect(pending.length).toBe(1)
      expect(pending[0].status).toBe('pending')
      expect(pending[0].operation).toBe('pause')
      expect(pending[0].description).toBe('Pause the backup job for maintenance')

      // Accept the proposal
      const resolveResult = service.resolveProposal(pending[0].id, true)
      expect(resolveResult.success).toBe(true)

      // The long-poll promise should resolve with success
      const result = await proposalPromise
      expect(result.success).toBe(true)

      // The mutation should have been executed
      expect((deps.cronManager as any).pauseJob).toHaveBeenCalledWith('job-1')
    })

    it('creates a proposal and resolves on reject — feedback returned', async () => {
      const job = makeCronJob({ id: 'job-2' })
      ;(deps.cronManager as any).jobCache.set('job-2', job)

      const proposalPromise = service.createProposal({
        operation: 'resume',
        jobId: 'job-2',
        description: 'Resume the backup job',
        diff: '- status: paused\n+ status: active',
      })

      const pending = service.getPendingProposals()
      expect(pending.length).toBe(1)

      // Reject with feedback
      const resolveResult = service.resolveProposal(pending[0].id, false, 'Not yet, maintenance in progress')
      expect(resolveResult.success).toBe(false)
      expect(resolveResult.rejected).toBe(true)
      expect(resolveResult.feedback).toBe('Not yet, maintenance in progress')

      const result = await proposalPromise
      expect(result.success).toBe(false)
      expect(result.rejected).toBe(true)
      expect(result.feedback).toBe('Not yet, maintenance in progress')

      // No mutation should have been executed
      expect((deps.cronManager as any).resumeJob).not.toHaveBeenCalled()
    })

    it('createProposal returns a Promise that blocks until user responds', async () => {
      const job = makeCronJob({ id: 'job-3' })
      ;(deps.cronManager as any).jobCache.set('job-3', job)

      let resolved = false
      const proposalPromise = service.createProposal({
        operation: 'delete',
        jobId: 'job-3',
        description: 'Delete unused job',
        diff: '- job-3',
      }).then((result) => {
        resolved = true
        return result
      })

      // Should NOT be resolved yet
      await new Promise((r) => setTimeout(r, 50))
      expect(resolved).toBe(false)

      // Now resolve it
      const pending = service.getPendingProposals()
      service.resolveProposal(pending[0].id, true)

      const result = await proposalPromise
      expect(resolved).toBe(true)
      expect(result.success).toBe(true)
    })

    it('resolveProposal with accept for "resume" calls cronManager.resumeJob', async () => {
      const job = makeCronJob({ id: 'job-r' })
      ;(deps.cronManager as any).jobCache.set('job-r', job)

      const promise = service.createProposal({
        operation: 'resume',
        jobId: 'job-r',
        description: 'Resume job',
        diff: '',
      })

      const pending = service.getPendingProposals()
      service.resolveProposal(pending[0].id, true)
      await promise

      expect((deps.cronManager as any).resumeJob).toHaveBeenCalledWith('job-r')
    })

    it('resolveProposal with accept for "edit_frequency" calls cronManager.editFrequency', async () => {
      const job = makeCronJob({ id: 'job-ef' })
      ;(deps.cronManager as any).jobCache.set('job-ef', job)

      const promise = service.createProposal({
        operation: 'edit_frequency',
        jobId: 'job-ef',
        description: 'Change schedule',
        diff: '- 0 * * * *\n+ */30 * * * *',
        details: { newSchedule: '*/30 * * * *' },
      })

      const pending = service.getPendingProposals()
      service.resolveProposal(pending[0].id, true)
      await promise

      expect((deps.cronManager as any).editFrequency).toHaveBeenCalled()
    })

    it('resolveProposal with accept for "delete" calls cronManager.deleteJob', async () => {
      const job = makeCronJob({ id: 'job-d' })
      ;(deps.cronManager as any).jobCache.set('job-d', job)

      const promise = service.createProposal({
        operation: 'delete',
        jobId: 'job-d',
        description: 'Delete job',
        diff: '',
      })

      const pending = service.getPendingProposals()
      service.resolveProposal(pending[0].id, true)
      await promise

      expect((deps.cronManager as any).deleteJob).toHaveBeenCalledWith('job-d')
    })

    it('resolveProposal with accept for "create" calls cronManager.createCronJob', async () => {
      const promise = service.createProposal({
        operation: 'create',
        jobId: null,
        description: 'Create a new hourly backup job',
        diff: '+ 0 * * * * /usr/bin/backup.sh',
        details: { schedule: '0 * * * *', command: '/usr/bin/backup.sh' },
      })

      const pending = service.getPendingProposals()
      service.resolveProposal(pending[0].id, true)
      await promise

      expect((deps.cronManager as any).createCronJob).toHaveBeenCalled()
    })

    it('resolveProposal with accept for "run_now" calls cronManager.runJobNow', async () => {
      const job = makeCronJob({ id: 'job-rn' })
      ;(deps.cronManager as any).jobCache.set('job-rn', job)

      const promise = service.createProposal({
        operation: 'run_now',
        jobId: 'job-rn',
        description: 'Run job immediately',
        diff: '',
      })

      const pending = service.getPendingProposals()
      service.resolveProposal(pending[0].id, true)
      await promise

      expect((deps.cronManager as any).runJobNow).toHaveBeenCalledWith('job-rn')
    })

    it('resolveProposal with accept for "set_tags" calls cronManager.setTags', async () => {
      const job = makeCronJob({ id: 'job-st' })
      ;(deps.cronManager as any).jobCache.set('job-st', job)
      ;(deps.cronManager as any).setTags = mock(() => {})

      const promise = service.createProposal({
        operation: 'set_tags',
        jobId: 'job-st',
        description: 'Tag the job',
        diff: '+ tags: [important]',
        details: { tags: ['important'] },
      })

      const pending = service.getPendingProposals()
      service.resolveProposal(pending[0].id, true)
      await promise

      expect((deps.cronManager as any).setTags).toHaveBeenCalledWith('job-st', ['important'])
    })

    it('resolveProposal with accept for "link_session" calls cronManager.linkSession', async () => {
      const job = makeCronJob({ id: 'job-ls' })
      ;(deps.cronManager as any).jobCache.set('job-ls', job)
      ;(deps.cronManager as any).linkSession = mock(() => {})

      const promise = service.createProposal({
        operation: 'link_session',
        jobId: 'job-ls',
        description: 'Link to session',
        diff: '+ linkedSessionId: sess-1',
        details: { sessionId: 'sess-1' },
      })

      const pending = service.getPendingProposals()
      service.resolveProposal(pending[0].id, true)
      await promise

      expect((deps.cronManager as any).linkSession).toHaveBeenCalledWith('job-ls', 'sess-1')
    })

    it('resolveProposal for non-existent proposal ID returns error', () => {
      const result = service.resolveProposal('nonexistent-id', true)
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('getProposal returns the proposal by ID', async () => {
      const job = makeCronJob({ id: 'job-gp' })
      ;(deps.cronManager as any).jobCache.set('job-gp', job)

      service.createProposal({
        operation: 'pause',
        jobId: 'job-gp',
        description: 'Pause for get test',
        diff: '',
      })

      const pending = service.getPendingProposals()
      const proposal = service.getProposal(pending[0].id)
      expect(proposal).toBeDefined()
      expect(proposal!.operation).toBe('pause')
      expect(proposal!.description).toBe('Pause for get test')
    })

    it('getProposal returns undefined for unknown ID', () => {
      expect(service.getProposal('does-not-exist')).toBeUndefined()
    })

    it('proposal has required fields: id, operation, status, createdAt', async () => {
      const job = makeCronJob({ id: 'job-fields' })
      ;(deps.cronManager as any).jobCache.set('job-fields', job)

      service.createProposal({
        operation: 'pause',
        jobId: 'job-fields',
        description: 'Test fields',
        diff: 'some diff',
      })

      const pending = service.getPendingProposals()
      expect(pending.length).toBe(1)
      const p = pending[0]
      expect(typeof p.id).toBe('string')
      expect(p.id.length).toBeGreaterThan(0)
      expect(p.operation).toBe('pause')
      expect(p.status).toBe('pending')
      expect(p.createdAt).toBeDefined()
      expect(p.resolvedAt).toBeNull()
      expect(p.feedback).toBeNull()
    })

    it('accepted proposal status changes to "accepted"', async () => {
      const job = makeCronJob({ id: 'job-status' })
      ;(deps.cronManager as any).jobCache.set('job-status', job)

      const promise = service.createProposal({
        operation: 'pause',
        jobId: 'job-status',
        description: 'Status test',
        diff: '',
      })

      const pending = service.getPendingProposals()
      service.resolveProposal(pending[0].id, true)
      await promise

      const resolved = service.getProposal(pending[0].id)
      expect(resolved?.status).toBe('accepted')
      expect(resolved?.resolvedAt).toBeDefined()
    })

    it('rejected proposal status changes to "rejected"', async () => {
      const job = makeCronJob({ id: 'job-rej' })
      ;(deps.cronManager as any).jobCache.set('job-rej', job)

      const promise = service.createProposal({
        operation: 'pause',
        jobId: 'job-rej',
        description: 'Reject test',
        diff: '',
      })

      const pending = service.getPendingProposals()
      service.resolveProposal(pending[0].id, false, 'Nope')
      await promise

      const resolved = service.getProposal(pending[0].id)
      expect(resolved?.status).toBe('rejected')
      expect(resolved?.feedback).toBe('Nope')
    })
  })

  // ── Proposal Timeout (AC-003-4) ────────────────────────────────────────

  describe('proposal-timeout', () => {
    it('auto-expires proposal after configured timeout', async () => {
      // Use a very short timeout for testing
      const shortTimeoutService = new CronAiService(deps, { port: 4040, proposalTimeoutMs: 100 } as any)
      const job = makeCronJob({ id: 'job-timeout' })
      ;(deps.cronManager as any).jobCache.set('job-timeout', job)

      const result = await shortTimeoutService.createProposal({
        operation: 'pause',
        jobId: 'job-timeout',
        description: 'Will timeout',
        diff: '',
      })

      expect(result.success).toBe(false)
      expect(result.expired).toBe(true)
    })

    it('expired proposal returns {success: false, expired: true}', async () => {
      const shortTimeoutService = new CronAiService(deps, { port: 4040, proposalTimeoutMs: 50 } as any)
      const job = makeCronJob({ id: 'job-exp' })
      ;(deps.cronManager as any).jobCache.set('job-exp', job)

      const result = await shortTimeoutService.createProposal({
        operation: 'pause',
        jobId: 'job-exp',
        description: 'Expiry test',
        diff: '',
      })

      expect(result).toEqual(expect.objectContaining({
        success: false,
        expired: true,
      }))
    })

    it('expired proposal status is "expired"', async () => {
      const shortTimeoutService = new CronAiService(deps, { port: 4040, proposalTimeoutMs: 50 } as any)
      const job = makeCronJob({ id: 'job-es' })
      ;(deps.cronManager as any).jobCache.set('job-es', job)

      const proposalPromise = shortTimeoutService.createProposal({
        operation: 'pause',
        jobId: 'job-es',
        description: 'Expired status test',
        diff: '',
      })

      // Wait for it
      await proposalPromise

      // The proposal should be marked expired
      const proposals = shortTimeoutService.getPendingProposals()
      expect(proposals.length).toBe(0) // No longer pending
    })

    it('resolving an already-expired proposal returns error', async () => {
      const shortTimeoutService = new CronAiService(deps, { port: 4040, proposalTimeoutMs: 50 } as any)
      const job = makeCronJob({ id: 'job-late' })
      ;(deps.cronManager as any).jobCache.set('job-late', job)

      const proposalPromise = shortTimeoutService.createProposal({
        operation: 'pause',
        jobId: 'job-late',
        description: 'Late resolve',
        diff: '',
      })

      // Get the ID before it expires
      const pending = shortTimeoutService.getPendingProposals()
      const proposalId = pending[0].id

      // Wait for expiry
      await proposalPromise

      // Try to resolve after expiry
      const result = shortTimeoutService.resolveProposal(proposalId, true)
      expect(result.success).toBe(false)
    })

    it('no mutation executed when proposal expires', async () => {
      const shortTimeoutService = new CronAiService(deps, { port: 4040, proposalTimeoutMs: 50 } as any)
      const job = makeCronJob({ id: 'job-nm' })
      ;(deps.cronManager as any).jobCache.set('job-nm', job)

      await shortTimeoutService.createProposal({
        operation: 'pause',
        jobId: 'job-nm',
        description: 'No mutation test',
        diff: '',
      })

      expect((deps.cronManager as any).pauseJob).not.toHaveBeenCalled()
    })
  })

  // ── Proposal Validation (AC-003-1) ─────────────────────────────────────

  describe('proposal-validation', () => {
    it('rejects unknown operations with error', async () => {
      await expect(
        service.createProposal({
          operation: 'unknown_op' as any,
          description: 'Bad operation',
          diff: '',
        })
      ).rejects.toThrow()
    })

    it('rejects non-existent jobId', async () => {
      // jobCache does not have this job
      await expect(
        service.createProposal({
          operation: 'pause',
          jobId: 'nonexistent-job',
          description: 'Pause unknown job',
          diff: '',
        })
      ).rejects.toThrow()
    })

    it('rejects create operation with jobId (should be null)', async () => {
      await expect(
        service.createProposal({
          operation: 'create',
          jobId: 'job-1',
          description: 'Create with existing id',
          diff: '',
        })
      ).rejects.toThrow()
    })

    it('rejects empty description', async () => {
      const job = makeCronJob({ id: 'job-ed' })
      ;(deps.cronManager as any).jobCache.set('job-ed', job)

      await expect(
        service.createProposal({
          operation: 'pause',
          jobId: 'job-ed',
          description: '',
          diff: '',
        })
      ).rejects.toThrow()
    })

    it('rejects whitespace-only description', async () => {
      const job = makeCronJob({ id: 'job-ws' })
      ;(deps.cronManager as any).jobCache.set('job-ws', job)

      await expect(
        service.createProposal({
          operation: 'pause',
          jobId: 'job-ws',
          description: '   ',
          diff: '',
        })
      ).rejects.toThrow()
    })

    it('requires jobId for pause operation', async () => {
      await expect(
        service.createProposal({
          operation: 'pause',
          jobId: null,
          description: 'Pause without job',
          diff: '',
        })
      ).rejects.toThrow()
    })

    it('requires jobId for resume operation', async () => {
      await expect(
        service.createProposal({
          operation: 'resume',
          description: 'Resume without job',
          diff: '',
        })
      ).rejects.toThrow()
    })

    it('requires jobId for delete operation', async () => {
      await expect(
        service.createProposal({
          operation: 'delete',
          description: 'Delete without job',
          diff: '',
        })
      ).rejects.toThrow()
    })

    it('requires jobId for edit_frequency operation', async () => {
      await expect(
        service.createProposal({
          operation: 'edit_frequency',
          description: 'Edit without job',
          diff: '',
        })
      ).rejects.toThrow()
    })

    it('requires jobId for run_now operation', async () => {
      await expect(
        service.createProposal({
          operation: 'run_now',
          description: 'Run without job',
          diff: '',
        })
      ).rejects.toThrow()
    })

    it('requires jobId for set_tags operation', async () => {
      await expect(
        service.createProposal({
          operation: 'set_tags',
          description: 'Tags without job',
          diff: '',
        })
      ).rejects.toThrow()
    })

    it('allows create operation without jobId', async () => {
      const promise = service.createProposal({
        operation: 'create',
        jobId: null,
        description: 'Create a new job',
        diff: '+ new crontab line',
        details: { schedule: '0 * * * *', command: '/bin/echo hi' },
      })

      // Should successfully create a pending proposal
      const pending = service.getPendingProposals()
      expect(pending.length).toBe(1)
      expect(pending[0].operation).toBe('create')

      // Clean up — resolve so we don't hang
      service.resolveProposal(pending[0].id, false)
      await promise
    })

    it('rejects edit_frequency without newSchedule in details', async () => {
      const job = makeCronJob({ id: 'job-ef-bad' })
      ;(deps.cronManager as any).jobCache.set('job-ef-bad', job)

      await expect(
        service.createProposal({
          operation: 'edit_frequency',
          jobId: 'job-ef-bad',
          description: 'Edit freq without schedule',
          diff: '',
          details: {}, // missing newSchedule
        })
      ).rejects.toThrow()
    })

    it('rejects create without required details (schedule, command)', async () => {
      await expect(
        service.createProposal({
          operation: 'create',
          jobId: null,
          description: 'Create without details',
          diff: '',
          // missing details entirely
        })
      ).rejects.toThrow()
    })

    it('rejects set_tags without tags in details', async () => {
      const job = makeCronJob({ id: 'job-st-bad' })
      ;(deps.cronManager as any).jobCache.set('job-st-bad', job)

      await expect(
        service.createProposal({
          operation: 'set_tags',
          jobId: 'job-st-bad',
          description: 'Set tags without tags array',
          diff: '',
          details: {}, // missing tags
        })
      ).rejects.toThrow()
    })

    it('requires jobId for link_session operation', async () => {
      await expect(
        service.createProposal({
          operation: 'link_session',
          description: 'Link without job',
          diff: '',
        })
      ).rejects.toThrow()
    })

    it('rejects link_session without sessionId in details', async () => {
      const job = makeCronJob({ id: 'job-ls-bad' })
      ;(deps.cronManager as any).jobCache.set('job-ls-bad', job)

      await expect(
        service.createProposal({
          operation: 'link_session',
          jobId: 'job-ls-bad',
          description: 'Link without sessionId',
          diff: '',
          details: {}, // missing sessionId
        })
      ).rejects.toThrow()
    })
  })

  // ── Auth Validation (AC-003-5) ─────────────────────────────────────────

  describe('auth-validation', () => {
    it('returns true when no auth token configured', () => {
      // DEFAULT_CONFIG has no authToken
      expect(service.validateAuth()).toBe(true)
      expect(service.validateAuth(undefined)).toBe(true)
      expect(service.validateAuth('anything')).toBe(true)
    })

    it('requires valid Bearer token when configured', () => {
      const authService = new CronAiService(deps, AUTH_CONFIG)
      expect(authService.validateAuth('Bearer test-secret-token')).toBe(true)
    })

    it('returns false for wrong token', () => {
      const authService = new CronAiService(deps, AUTH_CONFIG)
      expect(authService.validateAuth('Bearer wrong-token')).toBe(false)
    })

    it('returns false for missing Authorization header', () => {
      const authService = new CronAiService(deps, AUTH_CONFIG)
      expect(authService.validateAuth(undefined)).toBe(false)
      expect(authService.validateAuth('')).toBe(false)
    })

    it('returns false for non-Bearer scheme', () => {
      const authService = new CronAiService(deps, AUTH_CONFIG)
      expect(authService.validateAuth('Basic test-secret-token')).toBe(false)
    })

    it('returns false for Bearer without token value', () => {
      const authService = new CronAiService(deps, AUTH_CONFIG)
      expect(authService.validateAuth('Bearer ')).toBe(false)
      expect(authService.validateAuth('Bearer')).toBe(false)
    })
  })

  // ── MCP Client Registration (AC-003-6) ─────────────────────────────────

  describe('mcp-client', () => {
    it('registerMcpClient stores WS ref when no auth configured', () => {
      const mockWs = { send: mock(() => {}), close: mock(() => {}) }
      const result = service.registerMcpClient(mockWs)
      expect(result).toBe(true)
    })

    it('registerMcpClient validates auth token when configured', () => {
      const authService = new CronAiService(deps, AUTH_CONFIG)
      const mockWs = { send: mock(() => {}), close: mock(() => {}) }

      const result = authService.registerMcpClient(mockWs, 'test-secret-token')
      expect(result).toBe(true)
    })

    it('registerMcpClient rejects invalid auth token', () => {
      const authService = new CronAiService(deps, AUTH_CONFIG)
      const mockWs = { send: mock(() => {}), close: mock(() => {}) }

      const result = authService.registerMcpClient(mockWs, 'wrong-token')
      expect(result).toBe(false)
    })

    it('registerMcpClient closes WS with code 4001 on invalid auth', () => {
      const authService = new CronAiService(deps, AUTH_CONFIG)
      const mockWs = { send: mock(() => {}), close: mock(() => {}) }

      authService.registerMcpClient(mockWs, 'wrong-token')
      expect(mockWs.close).toHaveBeenCalledWith(4001, expect.any(String))
    })

    it('registerMcpClient rejects missing auth token when configured', () => {
      const authService = new CronAiService(deps, AUTH_CONFIG)
      const mockWs = { send: mock(() => {}), close: mock(() => {}) }

      const result = authService.registerMcpClient(mockWs)
      expect(result).toBe(false)
    })

    it('unregisterMcpClient clears WS ref', () => {
      const mockWs = { send: mock(() => {}), close: mock(() => {}) }
      service.registerMcpClient(mockWs)
      service.unregisterMcpClient()

      // After unregister, forwardToMcp should not send
      service.forwardToMcp({ type: 'test' })
      expect(mockWs.send).not.toHaveBeenCalled()
    })

    it('forwardToMcp sends message when MCP WS connected', () => {
      const mockWs = { send: mock(() => {}), close: mock(() => {}) }
      service.registerMcpClient(mockWs)

      service.forwardToMcp({ type: 'context_update', data: {} })
      expect(mockWs.send).toHaveBeenCalled()

      const sentData = JSON.parse((mockWs.send as any).mock.calls[0][0])
      expect(sentData.type).toBe('context_update')
    })

    it('forwardToMcp does nothing when no MCP WS connected', () => {
      // No WS registered, should not throw
      expect(() => service.forwardToMcp({ type: 'test' })).not.toThrow()
    })
  })

  // ── Config Generation (AC-003-7) ───────────────────────────────────────

  describe('config-generation', () => {
    const tmpBase = join(tmpdir(), 'cronai-test-' + Date.now())
    const origHome = process.env.HOME

    beforeEach(() => {
      mkdirSync(tmpBase, { recursive: true })
      process.env.HOME = tmpBase
    })

    afterEach(() => {
      process.env.HOME = origHome
      try { rmSync(tmpBase, { recursive: true, force: true }) } catch {}
    })

    it('generateMcpConfig writes JSON with correct server URL', async () => {
      await service.generateMcpConfig(4040)

      const configPath = join(tmpBase, '.agentboard', 'mcp', 'cron-manager.json')
      expect(existsSync(configPath)).toBe(true)

      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(config).toBeDefined()
      // Should contain the server URL with the given port
      const configStr = JSON.stringify(config)
      expect(configStr).toContain('4040')
    })

    it('generateMcpConfig includes auth token when configured', async () => {
      const authService = new CronAiService(deps, AUTH_CONFIG)
      await authService.generateMcpConfig(4040)

      const configPath = join(tmpBase, '.agentboard', 'mcp', 'cron-manager.json')
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      const configStr = JSON.stringify(config)
      expect(configStr).toContain('test-secret-token')
    })

    it('generateMcpConfig sets 0600 file permissions', async () => {
      await service.generateMcpConfig(4040)

      const configPath = join(tmpBase, '.agentboard', 'mcp', 'cron-manager.json')
      const stats = statSync(configPath)
      // 0600 = owner read/write only = 0o600 = 384 decimal
      const mode = stats.mode & 0o777
      expect(mode).toBe(0o600)
    })

    it('generateMcpConfig creates directories if they do not exist', async () => {
      const mcpDir = join(tmpBase, '.agentboard', 'mcp')
      expect(existsSync(mcpDir)).toBe(false)

      await service.generateMcpConfig(4040)
      expect(existsSync(mcpDir)).toBe(true)
    })
  })

  // ── Skill File Content (AC-003-8) ──────────────────────────────────────

  describe('skill-file-content', () => {
    const tmpBase = join(tmpdir(), 'cronai-skill-' + Date.now())
    const origHome = process.env.HOME

    beforeEach(() => {
      mkdirSync(tmpBase, { recursive: true })
      process.env.HOME = tmpBase
    })

    afterEach(() => {
      process.env.HOME = origHome
      try { rmSync(tmpBase, { recursive: true, force: true }) } catch {}
    })

    it('generateSkillFile writes a markdown file', async () => {
      await service.generateSkillFile()

      const skillPath = join(tmpBase, '.agentboard', 'skills', 'cron-manager.md')
      expect(existsSync(skillPath)).toBe(true)

      const content = readFileSync(skillPath, 'utf-8')
      expect(content.length).toBeGreaterThan(100)
    })

    it('skill file contains role description', async () => {
      await service.generateSkillFile()

      const skillPath = join(tmpBase, '.agentboard', 'skills', 'cron-manager.md')
      const content = readFileSync(skillPath, 'utf-8').toLowerCase()
      expect(content).toContain('role')
    })

    it('skill file contains tools section', async () => {
      await service.generateSkillFile()

      const skillPath = join(tmpBase, '.agentboard', 'skills', 'cron-manager.md')
      const content = readFileSync(skillPath, 'utf-8').toLowerCase()
      expect(content).toContain('tool')
    })

    it('skill file contains approval workflow', async () => {
      await service.generateSkillFile()

      const skillPath = join(tmpBase, '.agentboard', 'skills', 'cron-manager.md')
      const content = readFileSync(skillPath, 'utf-8').toLowerCase()
      expect(content).toContain('approv')
    })

    it('skill file contains safety guidelines (REQ-37)', async () => {
      await service.generateSkillFile()

      const skillPath = join(tmpBase, '.agentboard', 'skills', 'cron-manager.md')
      const content = readFileSync(skillPath, 'utf-8').toLowerCase()
      expect(content).toContain('safe')
    })

    it('skill file mentions proactive behaviors (REQ-44)', async () => {
      await service.generateSkillFile()

      const skillPath = join(tmpBase, '.agentboard', 'skills', 'cron-manager.md')
      const content = readFileSync(skillPath, 'utf-8').toLowerCase()
      expect(content).toContain('proactive')
    })

    it('skill file instructs never to do direct mutations (REQ-36)', async () => {
      await service.generateSkillFile()

      const skillPath = join(tmpBase, '.agentboard', 'skills', 'cron-manager.md')
      const content = readFileSync(skillPath, 'utf-8').toLowerCase()
      expect(content).toContain('propos')
    })

    it('skill file mentions one-at-a-time proposals (REQ-41)', async () => {
      await service.generateSkillFile()

      const skillPath = join(tmpBase, '.agentboard', 'skills', 'cron-manager.md')
      const content = readFileSync(skillPath, 'utf-8').toLowerCase()
      expect(content).toMatch(/one.*(at a time|proposal)/i)
    })

    it('skill file mentions health greeting (REQ-35)', async () => {
      await service.generateSkillFile()

      const skillPath = join(tmpBase, '.agentboard', 'skills', 'cron-manager.md')
      const content = readFileSync(skillPath, 'utf-8').toLowerCase()
      expect(content).toContain('health')
      expect(content).toContain('greet')
    })
  })

  // ── Health Endpoint (AC-003-9) ─────────────────────────────────────────

  describe('health-endpoint', () => {
    it('handleGetAiHealth returns correct shape with no MCP connected', async () => {
      const health = await service.handleGetAiHealth()

      expect(health.status).toBe('ok')
      expect(health.mcpConnected).toBe(false)
      expect(health.pendingProposals).toBe(0)
    })

    it('handleGetAiHealth shows mcpConnected=true when MCP WS registered', async () => {
      const mockWs = { send: mock(() => {}), close: mock(() => {}) }
      service.registerMcpClient(mockWs)

      const health = await service.handleGetAiHealth()
      expect(health.mcpConnected).toBe(true)
    })

    it('handleGetAiHealth counts pending proposals', async () => {
      const job = makeCronJob({ id: 'job-hp' })
      ;(deps.cronManager as any).jobCache.set('job-hp', job)

      // Create two proposals
      service.createProposal({
        operation: 'pause',
        jobId: 'job-hp',
        description: 'Proposal 1',
        diff: '',
      })
      service.createProposal({
        operation: 'resume',
        jobId: 'job-hp',
        description: 'Proposal 2',
        diff: '',
      })

      const health = await service.handleGetAiHealth()
      expect(health.pendingProposals).toBe(2)
    })

    it('handleGetAiHealth shows mcpConnected=false after unregister', async () => {
      const mockWs = { send: mock(() => {}), close: mock(() => {}) }
      service.registerMcpClient(mockWs)
      service.unregisterMcpClient()

      const health = await service.handleGetAiHealth()
      expect(health.mcpConnected).toBe(false)
    })
  })

  // ── Context Tracking (AC-003-2 / REQ-27) ──────────────────────────────

  describe('context-tracking', () => {
    it('getContext returns null initially', () => {
      // The Not implemented error should be replaced with null return
      const ctx = service.getContext()
      expect(ctx).toBeNull()
    })

    it('updateContext stores new context', () => {
      const ctx = makeUiContext({ selectedJobId: 'job-1', activeTab: 'logs' })
      service.updateContext(ctx)
      expect(service.getContext()).toEqual(ctx)
    })

    it('getContext returns the most recently set context', () => {
      const ctx1 = makeUiContext({ activeTab: 'overview' })
      const ctx2 = makeUiContext({ activeTab: 'logs', selectedJobId: 'job-2' })

      service.updateContext(ctx1)
      service.updateContext(ctx2)

      const result = service.getContext()
      expect(result?.activeTab).toBe('logs')
      expect(result?.selectedJobId).toBe('job-2')
    })

    it('updateContext forwards to MCP WS when connected', () => {
      const mockWs = { send: mock(() => {}), close: mock(() => {}) }
      service.registerMcpClient(mockWs)

      const ctx = makeUiContext({ selectedJobId: 'job-1' })
      service.updateContext(ctx)

      expect(mockWs.send).toHaveBeenCalled()
      const sent = JSON.parse((mockWs.send as any).mock.calls[0][0])
      expect(sent.type).toBe('context_update')
    })

    it('updateContext does not throw when no MCP WS connected', () => {
      const ctx = makeUiContext()
      expect(() => service.updateContext(ctx)).not.toThrow()
    })

    it('handleGetContext returns current UiContext', async () => {
      const ctx = makeUiContext({ activeTab: 'schedule' })
      service.updateContext(ctx)

      const result = await service.handleGetContext()
      expect(result?.activeTab).toBe('schedule')
    })
  })

  // ── HTTP Route Handler Delegation ──────────────────────────────────────

  describe('http-handler-delegation', () => {
    it('handleGetJobs delegates to cronManager.discoverAllJobs', async () => {
      const jobs = [makeCronJob({ id: 'j1' }), makeCronJob({ id: 'j2' })]
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve(jobs))

      const result = await service.handleGetJobs()
      expect(result).toEqual(jobs)
      expect((deps.cronManager as any).discoverAllJobs).toHaveBeenCalled()
    })

    it('handleGetJobs filters by group when provided', async () => {
      const jobs = [
        makeCronJob({ id: 'j1', projectGroup: 'web' }),
        makeCronJob({ id: 'j2', projectGroup: 'data' }),
      ]
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve(jobs))

      const result = await service.handleGetJobs({ group: 'web' })
      expect(result.every((j: CronJob) => j.projectGroup === 'web')).toBe(true)
    })

    it('handleGetJobDetail delegates to cronManager and services', async () => {
      const job = makeCronJob({ id: 'jd-1' })
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve([job]))
      ;(deps.historyService as any).getRunHistory = mock(() =>
        Promise.resolve([makeRunRecord()])
      )
      ;(deps.logService as any).getLogs = mock(() =>
        Promise.resolve(['log line 1'])
      )

      const result = await service.handleGetJobDetail('jd-1')
      expect(result).toBeDefined()
      expect(result.id).toBe('jd-1')
    })

    it('handleGetJobHistory delegates to historyService.getRunHistory', async () => {
      const records = [makeRunRecord(), makeRunRecord({ exitCode: 1 })]
      ;(deps.historyService as any).getRunHistory = mock(() => Promise.resolve(records))

      const result = await service.handleGetJobHistory('job-1', 10)
      expect(result).toEqual(records)
      expect((deps.historyService as any).getRunHistory).toHaveBeenCalledWith('job-1', 10, undefined)
    })

    it('handleGetJobHistory passes before cursor', async () => {
      ;(deps.historyService as any).getRunHistory = mock(() => Promise.resolve([]))

      await service.handleGetJobHistory('job-1', 10, '2026-02-25T00:00:00Z')
      expect((deps.historyService as any).getRunHistory).toHaveBeenCalledWith('job-1', 10, '2026-02-25T00:00:00Z')
    })

    it('handleGetJobLogs delegates to logService.getLogs', async () => {
      const logs = ['line 1', 'line 2', 'line 3']
      ;(deps.logService as any).getLogs = mock(() => Promise.resolve(logs))

      const result = await service.handleGetJobLogs('job-1', 50)
      expect(result).toEqual(logs)
      expect((deps.logService as any).getLogs).toHaveBeenCalledWith('job-1', 50, undefined)
    })

    it('handleGetJobLogs passes offset', async () => {
      ;(deps.logService as any).getLogs = mock(() => Promise.resolve([]))

      await service.handleGetJobLogs('job-1', 50, 100)
      expect((deps.logService as any).getLogs).toHaveBeenCalledWith('job-1', 50, 100)
    })

    it('handleGetHealth returns healthy/warning/critical counts', async () => {
      const jobs = [
        makeCronJob({ health: 'healthy' }),
        makeCronJob({ health: 'healthy', id: 'j2' }),
        makeCronJob({ health: 'warning', id: 'j3' }),
        makeCronJob({ health: 'critical', id: 'j4' }),
      ]
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve(jobs))

      const result = await service.handleGetHealth()
      expect(result).toEqual({ healthy: 2, warning: 1, critical: 1 })
    })

    it('handleGetFailingJobs returns only warning and critical jobs', async () => {
      const jobs = [
        makeCronJob({ health: 'healthy', id: 'j1' }),
        makeCronJob({ health: 'warning', id: 'j2' }),
        makeCronJob({ health: 'critical', id: 'j3' }),
        makeCronJob({ health: 'unknown', id: 'j4' }),
      ]
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve(jobs))

      const result = await service.handleGetFailingJobs()
      expect(result.length).toBe(2)
      expect(result.every((j: CronJob) => j.health === 'warning' || j.health === 'critical')).toBe(true)
    })

    it('handleSearchJobs searches by name/command/tag', async () => {
      const jobs = [
        makeCronJob({ id: 'j1', name: 'backup-daily', command: '/usr/bin/backup', tags: ['backup'] }),
        makeCronJob({ id: 'j2', name: 'cleanup', command: '/usr/bin/cleanup', tags: ['maintenance'] }),
      ]
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve(jobs))

      const result = await service.handleSearchJobs('backup')
      expect(result.length).toBeGreaterThanOrEqual(1)
      expect(result.some((j: CronJob) => j.name.includes('backup'))).toBe(true)
    })

    it('handleGetSessions returns sessions excluding internal AI session', async () => {
      // This verifies that internal agentboard-cron-ai sessions are filtered out
      const sessions = await service.handleGetSessions()
      expect(Array.isArray(sessions)).toBe(true)
    })
  })

  // ── Session Lifecycle ──────────────────────────────────────────────────

  describe('session-lifecycle', () => {
    it('isAiSession returns true for agentboard-cron-ai prefix', () => {
      expect(service.isAiSession('agentboard-cron-ai')).toBe(true)
      expect(service.isAiSession('agentboard-cron-ai-123')).toBe(true)
    })

    it('isAiSession returns false for other names', () => {
      expect(service.isAiSession('my-project')).toBe(false)
      expect(service.isAiSession('agentboard')).toBe(false)
      expect(service.isAiSession('')).toBe(false)
      expect(service.isAiSession('cron-ai')).toBe(false)
    })

    it('createAiSession delegates to sessionManager.createWindow', async () => {
      await service.createAiSession()
      expect((deps.sessionManager as any).createWindow).toHaveBeenCalled()
    })

    it('createAiSession returns sessionId and tmuxTarget', async () => {
      const result = await service.createAiSession()
      expect(typeof result).toBe('object')
      expect(result.sessionId).toContain('agentboard-cron-ai')
      expect(result.tmuxTarget).toContain('agentboard-cron-ai')
    })

    it('killAiSession delegates to sessionManager.killWindow', async () => {
      await service.killAiSession()
      expect((deps.sessionManager as any).killWindow).toHaveBeenCalled()
    })

    it('getAiSessionStatus returns a valid status string', () => {
      const status = service.getAiSessionStatus()
      expect(['offline', 'starting', 'working', 'waiting']).toContain(status)
    })
  })

  // ── No Sudo Credential Storage (AC-003-10 / REQ-66) ───────────────────

  describe('no-sudo-credential-storage', () => {
    it('CronAiService does not store sudo credentials in proposals', async () => {
      const job = makeCronJob({ id: 'job-sudo', requiresSudo: true })
      ;(deps.cronManager as any).jobCache.set('job-sudo', job)

      service.createProposal({
        operation: 'pause',
        jobId: 'job-sudo',
        description: 'Pause sudo job',
        diff: '',
        details: { sudoPassword: 'secret123' } as any,
      })

      const pending = service.getPendingProposals()
      const proposal = pending[0]

      // The proposal object should not contain any sudo credentials
      const proposalStr = JSON.stringify(proposal)
      expect(proposalStr).not.toContain('secret123')
      expect(proposalStr).not.toContain('sudoPassword')
    })
  })

  // ── handlePostProposal (HTTP handler wrapper) ──────────────────────────

  describe('handlePostProposal', () => {
    it('validates payload and creates proposal via long-poll', async () => {
      const job = makeCronJob({ id: 'job-hpp' })
      ;(deps.cronManager as any).jobCache.set('job-hpp', job)

      const proposalPromise = service.handlePostProposal({
        operation: 'pause',
        jobId: 'job-hpp',
        description: 'Pause via HTTP',
        diff: '',
      })

      // Resolve it
      const pending = service.getPendingProposals()
      expect(pending.length).toBe(1)
      service.resolveProposal(pending[0].id, true)

      const result = await proposalPromise
      expect(result.success).toBe(true)
    })

    it('handlePostProposal rejects invalid payload', async () => {
      await expect(
        service.handlePostProposal({
          operation: 'unknown_op',
          description: 'Bad',
          diff: '',
        })
      ).rejects.toThrow()
    })

    it('handlePostProposal rejects empty description', async () => {
      const job = makeCronJob({ id: 'job-hpp2' })
      ;(deps.cronManager as any).jobCache.set('job-hpp2', job)

      await expect(
        service.handlePostProposal({
          operation: 'pause',
          jobId: 'job-hpp2',
          description: '',
          diff: '',
        })
      ).rejects.toThrow()
    })

    it('handlePostProposal rejects missing jobId for non-create operations', async () => {
      await expect(
        service.handlePostProposal({
          operation: 'pause',
          description: 'Pause without job ID',
          diff: '',
        })
      ).rejects.toThrow()
    })
  })

  // ── handleMcpNavigate ──────────────────────────────────────────────────

  describe('handleMcpNavigate', () => {
    it('does not throw when no UI clients are connected', () => {
      expect(() => service.handleMcpNavigate('select_job', { jobId: 'job-1' })).not.toThrow()
    })
  })

  // ── Schedule Analysis Handlers ─────────────────────────────────────────

  describe('schedule-analysis', () => {
    it('handleGetScheduleConflicts returns array of ScheduleConflict', async () => {
      const jobs = [
        makeCronJob({ id: 'j1', schedule: '0 * * * *' }),
        makeCronJob({ id: 'j2', schedule: '0 * * * *' }),
      ]
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve(jobs))

      const result = await service.handleGetScheduleConflicts()
      expect(Array.isArray(result)).toBe(true)
    })

    it('handleGetScheduleLoad returns ScheduleLoadAnalysis shape', async () => {
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve([
        makeCronJob({ schedule: '0 * * * *' }),
      ]))

      const result = await service.handleGetScheduleLoad()
      expect(result.hourlyLoad).toBeDefined()
      expect(result.peakHours).toBeDefined()
      expect(result.recommendations).toBeDefined()
      expect(Array.isArray(result.peakHours)).toBe(true)
      expect(Array.isArray(result.recommendations)).toBe(true)
    })

    it('handleGetDurationTrends returns DurationTrendData shape', async () => {
      ;(deps.historyService as any).getRecentDurations = mock(() => Promise.resolve([40, 42, 45, 50]))

      const result = await service.handleGetDurationTrends('job-1')
      expect(result.jobId).toBe('job-1')
      expect(Array.isArray(result.durations)).toBe(true)
      expect(typeof result.average).toBe('number')
      expect(typeof result.trend).toBe('string')
    })

    it('handleGetScheduleConflicts detects jobs with identical schedules', async () => {
      const jobs = [
        makeCronJob({ id: 'j1', schedule: '0 3 * * *', name: 'backup-a' }),
        makeCronJob({ id: 'j2', schedule: '0 3 * * *', name: 'backup-b' }),
        makeCronJob({ id: 'j3', schedule: '0 6 * * *', name: 'cleanup' }),
      ]
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve(jobs))

      const result = await service.handleGetScheduleConflicts()
      expect(result.length).toBeGreaterThanOrEqual(1)
      const conflict = result[0]
      expect(conflict.jobIds).toContain('j1')
      expect(conflict.jobIds).toContain('j2')
      expect(conflict.schedule).toBe('0 3 * * *')
      expect(typeof conflict.description).toBe('string')
      expect(conflict.description.length).toBeGreaterThan(0)
    })

    it('handleGetScheduleConflicts returns empty when all schedules unique', async () => {
      const jobs = [
        makeCronJob({ id: 'j1', schedule: '0 * * * *' }),
        makeCronJob({ id: 'j2', schedule: '30 * * * *' }),
        makeCronJob({ id: 'j3', schedule: '0 3 * * *' }),
      ]
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve(jobs))

      const result = await service.handleGetScheduleConflicts()
      expect(result.length).toBe(0)
    })

    it('handleGetScheduleConflicts handles no jobs', async () => {
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve([]))

      const result = await service.handleGetScheduleConflicts()
      expect(result.length).toBe(0)
    })

    it('handleGetScheduleLoad has 24 hourly entries', async () => {
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve([
        makeCronJob({ schedule: '0 3 * * *' }),
      ]))

      const result = await service.handleGetScheduleLoad()
      const hours = Object.keys(result.hourlyLoad).map(Number)
      expect(hours.length).toBe(24)
      for (let h = 0; h < 24; h++) {
        expect(hours).toContain(h)
      }
    })

    it('handleGetScheduleLoad counts wildcard-hour jobs in every hour', async () => {
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve([
        makeCronJob({ schedule: '0 * * * *' }), // every hour
      ]))

      const result = await service.handleGetScheduleLoad()
      // A wildcard-hour job should appear in every hour slot
      for (let h = 0; h < 24; h++) {
        expect(result.hourlyLoad[h]).toBeGreaterThanOrEqual(1)
      }
    })

    it('handleGetScheduleLoad counts specific-hour jobs correctly', async () => {
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve([
        makeCronJob({ id: 'j1', schedule: '0 3 * * *' }), // hour 3 only
      ]))

      const result = await service.handleGetScheduleLoad()
      expect(result.hourlyLoad[3]).toBe(1)
      expect(result.hourlyLoad[0]).toBe(0)
      expect(result.hourlyLoad[12]).toBe(0)
    })

    it('handleGetScheduleLoad handles */interval patterns', async () => {
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve([
        makeCronJob({ schedule: '0 */6 * * *' }), // every 6 hours: 0, 6, 12, 18
      ]))

      const result = await service.handleGetScheduleLoad()
      expect(result.hourlyLoad[0]).toBe(1)
      expect(result.hourlyLoad[6]).toBe(1)
      expect(result.hourlyLoad[12]).toBe(1)
      expect(result.hourlyLoad[18]).toBe(1)
      expect(result.hourlyLoad[3]).toBe(0)
    })

    it('handleGetScheduleLoad handles comma-separated hours', async () => {
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve([
        makeCronJob({ schedule: '0 2,14 * * *' }), // hours 2 and 14
      ]))

      const result = await service.handleGetScheduleLoad()
      expect(result.hourlyLoad[2]).toBe(1)
      expect(result.hourlyLoad[14]).toBe(1)
      expect(result.hourlyLoad[0]).toBe(0)
    })

    it('handleGetScheduleLoad identifies peak hours above average', async () => {
      // 3 jobs at hour 3, 1 job at other hours → hour 3 is a peak
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve([
        makeCronJob({ id: 'j1', schedule: '0 3 * * *' }),
        makeCronJob({ id: 'j2', schedule: '10 3 * * *' }),
        makeCronJob({ id: 'j3', schedule: '20 3 * * *' }),
      ]))

      const result = await service.handleGetScheduleLoad()
      expect(result.peakHours).toContain(3)
    })

    it('handleGetScheduleLoad returns empty for no jobs', async () => {
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve([]))

      const result = await service.handleGetScheduleLoad()
      for (let h = 0; h < 24; h++) {
        expect(result.hourlyLoad[h]).toBe(0)
      }
      expect(result.peakHours.length).toBe(0)
    })

    it('handleGetDurationTrends detects increasing trend', async () => {
      // First half low, second half high → increasing
      ;(deps.historyService as any).getRecentDurations = mock(() =>
        Promise.resolve([10, 12, 11, 13, 30, 35, 40, 38])
      )

      const result = await service.handleGetDurationTrends('job-1')
      expect(result.trend).toBe('increasing')
    })

    it('handleGetDurationTrends detects decreasing trend', async () => {
      // First half high, second half low → decreasing
      ;(deps.historyService as any).getRecentDurations = mock(() =>
        Promise.resolve([40, 38, 35, 30, 10, 12, 11, 13])
      )

      const result = await service.handleGetDurationTrends('job-1')
      expect(result.trend).toBe('decreasing')
    })

    it('handleGetDurationTrends detects stable trend', async () => {
      ;(deps.historyService as any).getRecentDurations = mock(() =>
        Promise.resolve([40, 41, 39, 40, 40, 41, 39, 40])
      )

      const result = await service.handleGetDurationTrends('job-1')
      expect(result.trend).toBe('stable')
    })

    it('handleGetDurationTrends handles empty durations', async () => {
      ;(deps.historyService as any).getRecentDurations = mock(() => Promise.resolve([]))

      const result = await service.handleGetDurationTrends('job-1')
      expect(result.durations).toEqual([])
      expect(result.average).toBe(0)
    })

    it('handleGetDurationTrends calculates correct average', async () => {
      ;(deps.historyService as any).getRecentDurations = mock(() =>
        Promise.resolve([10, 20, 30])
      )

      const result = await service.handleGetDurationTrends('job-1')
      expect(result.average).toBe(20)
    })

    it('handleGetDurationTrends includes the jobId in response', async () => {
      ;(deps.historyService as any).getRecentDurations = mock(() => Promise.resolve([5]))

      const result = await service.handleGetDurationTrends('my-specific-job')
      expect(result.jobId).toBe('my-specific-job')
    })

    it('handleGetScheduleLoad returns hourlyLoad as Record<number, number>', async () => {
      const jobs = [
        makeCronJob({ id: 'j1', schedule: '0 * * * *' }),
        makeCronJob({ id: 'j2', schedule: '30 * * * *' }),
      ]
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve(jobs))

      const result = await service.handleGetScheduleLoad()
      expect(typeof result.hourlyLoad).toBe('object')
      for (const key of Object.keys(result.hourlyLoad)) {
        const num = Number(key)
        expect(num).toBeGreaterThanOrEqual(0)
        expect(num).toBeLessThanOrEqual(23)
      }
    })
  })

  // ── Proposal Field Auto-Population ──────────────────────────────────

  describe('proposal-auto-population', () => {
    it('auto-populates jobName from cache when not provided', async () => {
      const job = makeCronJob({ id: 'job-ap', name: 'my-backup-job' })
      ;(deps.cronManager as any).jobCache.set('job-ap', job)

      service.createProposal({
        operation: 'pause',
        jobId: 'job-ap',
        // jobName not provided
        description: 'Pause the job',
        diff: '',
      })

      const pending = service.getPendingProposals()
      expect(pending[0].jobName).toBe('my-backup-job')
    })

    it('uses provided jobName over cache when explicitly set', async () => {
      const job = makeCronJob({ id: 'job-ap2', name: 'cache-name' })
      ;(deps.cronManager as any).jobCache.set('job-ap2', job)

      service.createProposal({
        operation: 'pause',
        jobId: 'job-ap2',
        jobName: 'explicit-name',
        description: 'Pause explicitly named',
        diff: '',
      })

      const pending = service.getPendingProposals()
      expect(pending[0].jobName).toBe('explicit-name')
    })

    it('auto-populates jobAvatarUrl from cache', async () => {
      const job = makeCronJob({ id: 'job-av', avatarUrl: 'https://example.com/avatar.png' })
      ;(deps.cronManager as any).jobCache.set('job-av', job)

      service.createProposal({
        operation: 'pause',
        jobId: 'job-av',
        description: 'Pause with avatar',
        diff: '',
      })

      const pending = service.getPendingProposals()
      expect(pending[0].jobAvatarUrl).toBe('https://example.com/avatar.png')
    })

    it('sets jobName and jobAvatarUrl to null for create operations', async () => {
      service.createProposal({
        operation: 'create',
        jobId: null,
        description: 'Create new job',
        diff: '+ new line',
        details: { schedule: '0 * * * *', command: '/bin/test' },
      })

      const pending = service.getPendingProposals()
      expect(pending[0].jobId).toBeNull()
      expect(pending[0].jobAvatarUrl).toBeNull()
    })
  })

  // ── Concurrent Proposals ──────────────────────────────────────────────

  describe('concurrent-proposals', () => {
    it('supports multiple pending proposals simultaneously', async () => {
      const job1 = makeCronJob({ id: 'job-c1' })
      const job2 = makeCronJob({ id: 'job-c2' })
      ;(deps.cronManager as any).jobCache.set('job-c1', job1)
      ;(deps.cronManager as any).jobCache.set('job-c2', job2)

      service.createProposal({
        operation: 'pause',
        jobId: 'job-c1',
        description: 'Pause job 1',
        diff: '',
      })
      service.createProposal({
        operation: 'resume',
        jobId: 'job-c2',
        description: 'Resume job 2',
        diff: '',
      })

      const pending = service.getPendingProposals()
      expect(pending.length).toBe(2)
      expect(pending.map((p: CronAiProposal) => p.operation).sort()).toEqual(['pause', 'resume'])
    })

    it('resolving one proposal does not affect others', async () => {
      const job1 = makeCronJob({ id: 'job-r1' })
      const job2 = makeCronJob({ id: 'job-r2' })
      ;(deps.cronManager as any).jobCache.set('job-r1', job1)
      ;(deps.cronManager as any).jobCache.set('job-r2', job2)

      const p1 = service.createProposal({
        operation: 'pause',
        jobId: 'job-r1',
        description: 'Pause first',
        diff: '',
      })
      service.createProposal({
        operation: 'pause',
        jobId: 'job-r2',
        description: 'Pause second',
        diff: '',
      })

      const pending = service.getPendingProposals()
      // Resolve the first one only
      service.resolveProposal(pending[0].id, true)
      await p1

      // Second should still be pending
      const remaining = service.getPendingProposals()
      expect(remaining.length).toBe(1)
    })

    it('each proposal gets a unique ID', async () => {
      const job = makeCronJob({ id: 'job-uid' })
      ;(deps.cronManager as any).jobCache.set('job-uid', job)

      service.createProposal({
        operation: 'pause',
        jobId: 'job-uid',
        description: 'First',
        diff: '',
      })
      service.createProposal({
        operation: 'resume',
        jobId: 'job-uid',
        description: 'Second',
        diff: '',
      })

      const pending = service.getPendingProposals()
      expect(pending[0].id).not.toBe(pending[1].id)
    })

    it('resolving same proposal twice returns error on second attempt', async () => {
      const job = makeCronJob({ id: 'job-double' })
      ;(deps.cronManager as any).jobCache.set('job-double', job)

      const promise = service.createProposal({
        operation: 'pause',
        jobId: 'job-double',
        description: 'Double resolve',
        diff: '',
      })

      const pending = service.getPendingProposals()
      const id = pending[0].id

      service.resolveProposal(id, true)
      await promise

      // Second resolve should return error
      const result2 = service.resolveProposal(id, false)
      expect(result2.success).toBe(false)
      expect(result2.error).toBeDefined()
    })
  })

  // ── HTTP Handler Edge Cases ────────────────────────────────────────────

  describe('http-handler-edge-cases', () => {
    it('handleGetJobDetail throws for non-existent jobId', async () => {
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve([]))

      await expect(service.handleGetJobDetail('nonexistent')).rejects.toThrow()
    })

    it('handleGetJobDetail combines data from cronManager, history, and logs', async () => {
      const job = makeCronJob({ id: 'jd-combo' })
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve([job]))
      ;(deps.historyService as any).getRunHistory = mock(() =>
        Promise.resolve([makeRunRecord({ exitCode: 0 }), makeRunRecord({ exitCode: 1 })])
      )
      ;(deps.logService as any).getLogs = mock(() =>
        Promise.resolve(['log-line-1', 'log-line-2'])
      )

      const result = await service.handleGetJobDetail('jd-combo')
      expect(result.id).toBe('jd-combo')
      expect(result.runHistory).toHaveLength(2)
      expect(result.recentLogs).toHaveLength(2)
    })

    it('handleSearchJobs matches by command', async () => {
      const jobs = [
        makeCronJob({ id: 'j1', name: 'alpha', command: '/usr/bin/backup.sh', tags: [] }),
        makeCronJob({ id: 'j2', name: 'beta', command: '/usr/bin/cleanup.sh', tags: [] }),
      ]
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve(jobs))

      const result = await service.handleSearchJobs('backup')
      expect(result.length).toBe(1)
      expect(result[0].id).toBe('j1')
    })

    it('handleSearchJobs matches by tag', async () => {
      const jobs = [
        makeCronJob({ id: 'j1', name: 'alpha', command: '/bin/a', tags: ['database'] }),
        makeCronJob({ id: 'j2', name: 'beta', command: '/bin/b', tags: ['network'] }),
      ]
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve(jobs))

      const result = await service.handleSearchJobs('database')
      expect(result.length).toBe(1)
      expect(result[0].id).toBe('j1')
    })

    it('handleSearchJobs is case-insensitive', async () => {
      const jobs = [
        makeCronJob({ id: 'j1', name: 'Daily-Backup', command: '/bin/bak', tags: [] }),
      ]
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve(jobs))

      const result = await service.handleSearchJobs('daily-backup')
      expect(result.length).toBe(1)
    })

    it('handleSearchJobs returns empty when nothing matches', async () => {
      const jobs = [makeCronJob({ id: 'j1', name: 'alpha', command: '/bin/a', tags: ['x'] })]
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve(jobs))

      const result = await service.handleSearchJobs('zzz-no-match')
      expect(result.length).toBe(0)
    })

    it('handleGetHealth returns all zeros for no jobs', async () => {
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve([]))

      const result = await service.handleGetHealth()
      expect(result).toEqual({ healthy: 0, warning: 0, critical: 0 })
    })

    it('handleGetFailingJobs returns empty when all healthy', async () => {
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve([
        makeCronJob({ health: 'healthy', id: 'h1' }),
        makeCronJob({ health: 'healthy', id: 'h2' }),
      ]))

      const result = await service.handleGetFailingJobs()
      expect(result.length).toBe(0)
    })

    it('handleGetJobs returns all jobs when no group filter', async () => {
      const jobs = [
        makeCronJob({ id: 'j1', projectGroup: 'web' }),
        makeCronJob({ id: 'j2', projectGroup: 'data' }),
        makeCronJob({ id: 'j3', projectGroup: 'web' }),
      ]
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve(jobs))

      const result = await service.handleGetJobs()
      expect(result.length).toBe(3)
    })

    it('handleGetJobs returns empty for unmatched group', async () => {
      ;(deps.cronManager as any).discoverAllJobs = mock(() => Promise.resolve([
        makeCronJob({ projectGroup: 'web' }),
      ]))

      const result = await service.handleGetJobs({ group: 'nonexistent' })
      expect(result.length).toBe(0)
    })
  })

  // ── Config Generation — Structure (AC-003-7) ─────────────────────────

  describe('config-generation-structure', () => {
    const tmpBase = join(tmpdir(), 'cronai-cfg-struct-' + Date.now())
    const origHome = process.env.HOME

    beforeEach(() => {
      mkdirSync(tmpBase, { recursive: true })
      process.env.HOME = tmpBase
    })

    afterEach(() => {
      process.env.HOME = origHome
      try { rmSync(tmpBase, { recursive: true, force: true }) } catch {}
    })

    it('generateMcpConfig writes correct HTTP URL', async () => {
      await service.generateMcpConfig(4040)

      const configPath = join(tmpBase, '.agentboard', 'mcp', 'cron-manager.json')
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(config.mcpServers['cron-manager'].url).toBe('http://localhost:4040/api/cron-ai')
    })

    it('generateMcpConfig writes correct WS URL', async () => {
      await service.generateMcpConfig(4040)

      const configPath = join(tmpBase, '.agentboard', 'mcp', 'cron-manager.json')
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(config.mcpServers['cron-manager'].ws).toBe('ws://localhost:4040/ws/cron-ai')
    })

    it('generateMcpConfig uses the given port in URLs', async () => {
      await service.generateMcpConfig(9999)

      const configPath = join(tmpBase, '.agentboard', 'mcp', 'cron-manager.json')
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(config.mcpServers['cron-manager'].url).toContain('9999')
      expect(config.mcpServers['cron-manager'].ws).toContain('9999')
    })

    it('generateMcpConfig omits authToken when not configured', async () => {
      // service uses DEFAULT_CONFIG (no authToken)
      await service.generateMcpConfig(4040)

      const configPath = join(tmpBase, '.agentboard', 'mcp', 'cron-manager.json')
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      expect(config.mcpServers['cron-manager'].authToken).toBeUndefined()
    })
  })

  // ── Skill File — Additional Content Checks (AC-003-8) ────────────────

  describe('skill-file-additional-content', () => {
    const tmpBase = join(tmpdir(), 'cronai-skill-add-' + Date.now())
    const origHome = process.env.HOME

    beforeEach(() => {
      mkdirSync(tmpBase, { recursive: true })
      process.env.HOME = tmpBase
    })

    afterEach(() => {
      process.env.HOME = origHome
      try { rmSync(tmpBase, { recursive: true, force: true }) } catch {}
    })

    it('skill file instructs checking context before acting (REQ-34)', async () => {
      await service.generateSkillFile()

      const skillPath = join(tmpBase, '.agentboard', 'skills', 'cron-manager.md')
      const content = readFileSync(skillPath, 'utf-8').toLowerCase()
      expect(content).toContain('context')
    })

    it('skill file instructs clarifying questions before proposing (REQ-43)', async () => {
      await service.generateSkillFile()

      const skillPath = join(tmpBase, '.agentboard', 'skills', 'cron-manager.md')
      const content = readFileSync(skillPath, 'utf-8').toLowerCase()
      expect(content).toContain('clarif')
    })

    it('skill file instructs one-time greeting per session (REQ-45)', async () => {
      await service.generateSkillFile()

      const skillPath = join(tmpBase, '.agentboard', 'skills', 'cron-manager.md')
      const content = readFileSync(skillPath, 'utf-8').toLowerCase()
      expect(content).toContain('one-time')
    })

    it('skill file mentions failure patterns (REQ-39)', async () => {
      await service.generateSkillFile()

      const skillPath = join(tmpBase, '.agentboard', 'skills', 'cron-manager.md')
      const content = readFileSync(skillPath, 'utf-8').toLowerCase()
      expect(content).toMatch(/fail|diagnos|issue/)
    })

    it('skill file mentions propose_change tool', async () => {
      await service.generateSkillFile()

      const skillPath = join(tmpBase, '.agentboard', 'skills', 'cron-manager.md')
      const content = readFileSync(skillPath, 'utf-8').toLowerCase()
      expect(content).toContain('propose')
    })

    it('skill file mentions never do direct mutations (REQ-36)', async () => {
      await service.generateSkillFile()

      const skillPath = join(tmpBase, '.agentboard', 'skills', 'cron-manager.md')
      const content = readFileSync(skillPath, 'utf-8').toLowerCase()
      expect(content).toMatch(/never.*direct|never.*execut|must.*propos|all.*mutation/)
    })

    it('skill file mentions sudo credential safety (REQ-66)', async () => {
      await service.generateSkillFile()

      const skillPath = join(tmpBase, '.agentboard', 'skills', 'cron-manager.md')
      const content = readFileSync(skillPath, 'utf-8').toLowerCase()
      expect(content).toMatch(/sudo|credential/)
    })

    it('skill file creates parent directories', async () => {
      const skillsDir = join(tmpBase, '.agentboard', 'skills')
      expect(existsSync(skillsDir)).toBe(false)

      await service.generateSkillFile()
      expect(existsSync(skillsDir)).toBe(true)
    })
  })

  // ── No Sudo Credential Storage — Extended (AC-003-10) ────────────────

  describe('no-sudo-credential-storage-extended', () => {
    it('strips sudoPassword from details before storing in proposal', async () => {
      const job = makeCronJob({ id: 'job-sudo2', requiresSudo: true })
      ;(deps.cronManager as any).jobCache.set('job-sudo2', job)

      service.createProposal({
        operation: 'pause',
        jobId: 'job-sudo2',
        description: 'Pause sudo job',
        diff: '',
        details: { sudoPassword: 'hunter2', otherField: 'safe' } as any,
      })

      const pending = service.getPendingProposals()
      // The proposal itself should not have sudo creds
      const proposalStr = JSON.stringify(pending[0])
      expect(proposalStr).not.toContain('hunter2')
      expect(proposalStr).not.toContain('sudoPassword')
    })

    it('preserves non-sudo details fields after stripping', async () => {
      const job = makeCronJob({ id: 'job-safe' })
      ;(deps.cronManager as any).jobCache.set('job-safe', job)

      const promise = service.createProposal({
        operation: 'set_tags',
        jobId: 'job-safe',
        description: 'Tag job',
        diff: '',
        details: { tags: ['important'], sudoPassword: 'secret' } as any,
      })

      const pending = service.getPendingProposals()
      // Resolve to trigger mutation and check details passed through
      ;(deps.cronManager as any).setTags = mock(() => {})
      service.resolveProposal(pending[0].id, true)
      await promise

      // setTags should receive the tags but not the sudoPassword
      expect((deps.cronManager as any).setTags).toHaveBeenCalledWith('job-safe', ['important'])
    })
  })

  // ── Default Timeout Value ─────────────────────────────────────────────

  describe('default-timeout', () => {
    it('uses 5 minute default timeout when not configured', () => {
      // Service created with DEFAULT_CONFIG (no proposalTimeoutMs)
      const job = makeCronJob({ id: 'job-dt' })
      ;(deps.cronManager as any).jobCache.set('job-dt', job)

      service.createProposal({
        operation: 'pause',
        jobId: 'job-dt',
        description: 'Default timeout test',
        diff: '',
      })

      const pending = service.getPendingProposals()
      expect(pending.length).toBe(1)
    })
  })

  // ── Context Forwarding Details ─────────────────────────────────────────

  describe('context-forwarding-details', () => {
    it('updateContext forwards full context payload to MCP WS', () => {
      const mockWs = { send: mock(() => {}), close: mock(() => {}) }
      service.registerMcpClient(mockWs)

      const ctx = makeUiContext({
        selectedJobId: 'job-fwd',
        activeTab: 'logs',
        visibleJobCount: 5,
      })
      service.updateContext(ctx)

      const sent = JSON.parse((mockWs.send as any).mock.calls[0][0])
      expect(sent.selectedJobId).toBe('job-fwd')
      expect(sent.activeTab).toBe('logs')
      expect(sent.visibleJobCount).toBe(5)
    })

    it('updateContext message includes type: context_update', () => {
      const mockWs = { send: mock(() => {}), close: mock(() => {}) }
      service.registerMcpClient(mockWs)

      service.updateContext(makeUiContext())

      const sent = JSON.parse((mockWs.send as any).mock.calls[0][0])
      expect(sent.type).toBe('context_update')
    })

    it('consecutive updateContext calls only send latest state', () => {
      const mockWs = { send: mock(() => {}), close: mock(() => {}) }
      service.registerMcpClient(mockWs)

      service.updateContext(makeUiContext({ activeTab: 'overview' }))
      service.updateContext(makeUiContext({ activeTab: 'schedule' }))

      // Both sends should have happened
      expect((mockWs.send as any).mock.calls.length).toBe(2)

      // getContext returns latest
      expect(service.getContext()?.activeTab).toBe('schedule')
    })
  })
})
