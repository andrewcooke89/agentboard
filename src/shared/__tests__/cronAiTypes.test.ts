// WU-001: Shared Types & Interfaces — Cron AI Orchestrator types
// Tests compile-time contracts and runtime shape validation for all cron-ai types.

import { describe, test, expect } from 'bun:test'
import type {
  CronAiProposal,
  CronAiProposalOperation,
  UiContext,
  ProposalResult,
  ScheduleConflict,
  ScheduleLoadAnalysis,
  DurationTrendData,
  ServerMessage,
  ClientMessage,
  CronJobDetail,
} from '../types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal valid CronAiProposal */
function makeProposal(overrides: Partial<CronAiProposal> = {}): CronAiProposal {
  return {
    id: 'prop-001',
    operation: 'create',
    jobId: null,
    jobName: null,
    jobAvatarUrl: null,
    description: 'Create a backup job',
    diff: '+ 0 3 * * * /usr/bin/backup.sh',
    status: 'pending',
    feedback: null,
    createdAt: '2026-02-25T00:00:00Z',
    resolvedAt: null,
    ...overrides,
  }
}

/** Build a minimal valid UiContext */
function makeUiContext(overrides: Partial<UiContext> = {}): UiContext {
  return {
    selectedJobId: null,
    selectedJobDetail: null,
    activeTab: 'overview',
    visibleJobCount: 0,
    filterState: { mode: 'all', source: null, tags: [] },
    healthSummary: { healthy: 0, warning: 0, critical: 0 },
    ...overrides,
  }
}

// ─── AC-001-3: CronAiProposal interface ──────────────────────────────────────

describe('CronAiProposal', () => {
  test('has all required fields with correct types', () => {
    const proposal = makeProposal()

    // Every field must exist (even if null)
    expect(proposal).toHaveProperty('id')
    expect(proposal).toHaveProperty('operation')
    expect(proposal).toHaveProperty('jobId')
    expect(proposal).toHaveProperty('jobName')
    expect(proposal).toHaveProperty('jobAvatarUrl')
    expect(proposal).toHaveProperty('description')
    expect(proposal).toHaveProperty('diff')
    expect(proposal).toHaveProperty('status')
    expect(proposal).toHaveProperty('feedback')
    expect(proposal).toHaveProperty('createdAt')
    expect(proposal).toHaveProperty('resolvedAt')

    // Verify runtime types
    expect(typeof proposal.id).toBe('string')
    expect(typeof proposal.operation).toBe('string')
    expect(typeof proposal.description).toBe('string')
    expect(typeof proposal.diff).toBe('string')
    expect(typeof proposal.status).toBe('string')
    expect(typeof proposal.createdAt).toBe('string')
  })

  test('id field is a string', () => {
    const p = makeProposal({ id: 'abc-123' })
    expect(typeof p.id).toBe('string')
  })

  test('operation field accepts all CronAiProposalOperation values', () => {
    const ops: CronAiProposalOperation[] = [
      'create',
      'edit_frequency',
      'pause',
      'resume',
      'delete',
      'run_now',
      'set_tags',
      'link_session',
    ]
    for (const op of ops) {
      const p = makeProposal({ operation: op })
      expect(p.operation).toBe(op)
    }
  })

  test('jobId is string | null', () => {
    expect(makeProposal({ jobId: null }).jobId).toBeNull()
    expect(makeProposal({ jobId: 'job-42' }).jobId).toBe('job-42')
  })

  test('jobName is string | null', () => {
    expect(makeProposal({ jobName: null }).jobName).toBeNull()
    expect(makeProposal({ jobName: 'backup' }).jobName).toBe('backup')
  })

  test('jobAvatarUrl is string | null', () => {
    expect(makeProposal({ jobAvatarUrl: null }).jobAvatarUrl).toBeNull()
    expect(makeProposal({ jobAvatarUrl: '/img/a.png' }).jobAvatarUrl).toBe('/img/a.png')
  })

  test('status accepts all valid values', () => {
    const statuses: CronAiProposal['status'][] = ['pending', 'accepted', 'rejected', 'expired']
    for (const s of statuses) {
      expect(makeProposal({ status: s }).status).toBe(s)
    }
  })

  test('feedback is string | null', () => {
    expect(makeProposal({ feedback: null }).feedback).toBeNull()
    expect(makeProposal({ feedback: 'Looks good' }).feedback).toBe('Looks good')
  })

  test('resolvedAt is string | null', () => {
    expect(makeProposal({ resolvedAt: null }).resolvedAt).toBeNull()
    expect(makeProposal({ resolvedAt: '2026-02-25T01:00:00Z' }).resolvedAt).toBe('2026-02-25T01:00:00Z')
  })

  test('exactly 11 fields — no more, no less', () => {
    const p = makeProposal()
    expect(Object.keys(p).sort()).toEqual([
      'createdAt',
      'description',
      'diff',
      'feedback',
      'id',
      'jobAvatarUrl',
      'jobId',
      'jobName',
      'operation',
      'resolvedAt',
      'status',
    ])
  })
})

// ─── CronAiProposalOperation type union ──────────────────────────────────────

describe('CronAiProposalOperation', () => {
  test('has exactly 8 variants', () => {
    // This array must be kept in sync with the type.
    // A compile error here means the type changed.
    const all: CronAiProposalOperation[] = [
      'create',
      'edit_frequency',
      'pause',
      'resume',
      'delete',
      'run_now',
      'set_tags',
      'link_session',
    ]
    expect(all).toHaveLength(8)
    // All are unique
    expect(new Set(all).size).toBe(8)
  })

  // Compile-time exhaustiveness: if a variant is added to the union but not
  // listed here, TypeScript will error on the `satisfies` assertion.
  test('exhaustive switch compiles', () => {
    function describe(op: CronAiProposalOperation): string {
      switch (op) {
        case 'create': return 'create'
        case 'edit_frequency': return 'edit_frequency'
        case 'pause': return 'pause'
        case 'resume': return 'resume'
        case 'delete': return 'delete'
        case 'run_now': return 'run_now'
        case 'set_tags': return 'set_tags'
        case 'link_session': return 'link_session'
        default: {
          const _exhaustive: never = op
          throw new Error(`Unknown operation: ${_exhaustive}`)
        }
      }
    }
    expect(describe('create')).toBe('create')
    expect(describe('link_session')).toBe('link_session')
  })
})

// ─── AC-001-4: UiContext interface ───────────────────────────────────────────

describe('UiContext', () => {
  test('has all required fields with correct types', () => {
    const ctx = makeUiContext()

    expect(ctx).toHaveProperty('selectedJobId')
    expect(ctx).toHaveProperty('selectedJobDetail')
    expect(ctx).toHaveProperty('activeTab')
    expect(ctx).toHaveProperty('visibleJobCount')
    expect(ctx).toHaveProperty('filterState')
    expect(ctx).toHaveProperty('healthSummary')
  })

  test('selectedJobId is string | null', () => {
    expect(makeUiContext({ selectedJobId: null }).selectedJobId).toBeNull()
    expect(makeUiContext({ selectedJobId: 'job-1' }).selectedJobId).toBe('job-1')
  })

  test('selectedJobDetail is CronJobDetail | null', () => {
    expect(makeUiContext({ selectedJobDetail: null }).selectedJobDetail).toBeNull()

    // With a full CronJobDetail
    const detail = {
      id: 'job-1', name: 'backup', source: 'user-crontab' as const,
      schedule: '0 3 * * *', scheduleHuman: 'Daily at 3 AM',
      command: '/usr/bin/backup', scriptPath: null, projectGroup: 'infra',
      status: 'active' as const, health: 'healthy' as const,
      healthReason: null, lastRun: null, lastRunDuration: null,
      nextRun: null, lastExitCode: null, consecutiveFailures: 0,
      avgDuration: null, user: 'root', requiresSudo: false,
      avatarUrl: null, unitFile: null, description: null,
      tags: [], isManagedByAgentboard: false, linkedSessionId: null,
      // CronJobDetail extensions
      scriptContent: null, scriptLanguage: null, timerConfig: null,
      serviceConfig: null, crontabLine: '0 3 * * * /usr/bin/backup',
      runHistory: [], recentLogs: [],
    } satisfies CronJobDetail
    const ctx = makeUiContext({ selectedJobDetail: detail })
    expect(ctx.selectedJobDetail?.id).toBe('job-1')
  })

  test('activeTab is a string', () => {
    expect(typeof makeUiContext({ activeTab: 'logs' }).activeTab).toBe('string')
  })

  test('visibleJobCount is a number', () => {
    expect(typeof makeUiContext({ visibleJobCount: 42 }).visibleJobCount).toBe('number')
  })

  test('filterState has mode, source, tags', () => {
    const fs = makeUiContext().filterState
    expect(fs).toHaveProperty('mode')
    expect(fs).toHaveProperty('source')
    expect(fs).toHaveProperty('tags')
    expect(typeof fs.mode).toBe('string')
    expect(Array.isArray(fs.tags)).toBe(true)
  })

  test('filterState.source is string | null', () => {
    const a = makeUiContext({ filterState: { mode: 'all', source: null, tags: [] } })
    expect(a.filterState.source).toBeNull()
    const b = makeUiContext({ filterState: { mode: 'filter', source: 'user-crontab', tags: ['backup'] } })
    expect(b.filterState.source).toBe('user-crontab')
  })

  test('healthSummary has healthy, warning, critical (all numbers)', () => {
    const hs = makeUiContext({ healthSummary: { healthy: 5, warning: 2, critical: 1 } }).healthSummary
    expect(typeof hs.healthy).toBe('number')
    expect(typeof hs.warning).toBe('number')
    expect(typeof hs.critical).toBe('number')
    expect(hs.healthy).toBe(5)
    expect(hs.warning).toBe(2)
    expect(hs.critical).toBe(1)
  })

  test('exactly 6 top-level fields', () => {
    expect(Object.keys(makeUiContext()).sort()).toEqual([
      'activeTab',
      'filterState',
      'healthSummary',
      'selectedJobDetail',
      'selectedJobId',
      'visibleJobCount',
    ])
  })
})

// ─── ProposalResult ──────────────────────────────────────────────────────────

describe('ProposalResult', () => {
  test('minimal success result', () => {
    const r: ProposalResult = { success: true }
    expect(r.success).toBe(true)
    expect(r.rejected).toBeUndefined()
    expect(r.expired).toBeUndefined()
  })

  test('success with result payload', () => {
    const r: ProposalResult = { success: true, result: { jobId: 'new-1' } }
    expect(r.success).toBe(true)
    expect(r.result).toEqual({ jobId: 'new-1' })
  })

  test('rejected proposal', () => {
    const r: ProposalResult = { success: false, rejected: true, feedback: 'Too risky' }
    expect(r.success).toBe(false)
    expect(r.rejected).toBe(true)
    expect(r.feedback).toBe('Too risky')
  })

  test('expired proposal', () => {
    const r: ProposalResult = { success: false, expired: true }
    expect(r.success).toBe(false)
    expect(r.expired).toBe(true)
  })

  test('error result', () => {
    const r: ProposalResult = { success: false, error: 'MCP connection lost' }
    expect(r.success).toBe(false)
    expect(r.error).toBe('MCP connection lost')
  })

  test('all optional fields present simultaneously', () => {
    const r: ProposalResult = {
      success: false,
      result: null,
      rejected: true,
      expired: false,
      feedback: 'nope',
      error: 'also broke',
    }
    expect(r).toHaveProperty('success')
    expect(r).toHaveProperty('result')
    expect(r).toHaveProperty('rejected')
    expect(r).toHaveProperty('expired')
    expect(r).toHaveProperty('feedback')
    expect(r).toHaveProperty('error')
  })
})

// ─── ScheduleConflict ────────────────────────────────────────────────────────

describe('ScheduleConflict', () => {
  test('has jobIds, schedule, description', () => {
    const c: ScheduleConflict = {
      jobIds: ['job-1', 'job-2'],
      schedule: '0 * * * *',
      description: 'Both run hourly on the hour',
    }
    expect(c.jobIds).toEqual(['job-1', 'job-2'])
    expect(c.schedule).toBe('0 * * * *')
    expect(c.description).toBe('Both run hourly on the hour')
  })

  test('jobIds is a string array', () => {
    const c: ScheduleConflict = { jobIds: [], schedule: '', description: '' }
    expect(Array.isArray(c.jobIds)).toBe(true)
  })

  test('exactly 3 fields', () => {
    const c: ScheduleConflict = { jobIds: ['a'], schedule: 's', description: 'd' }
    expect(Object.keys(c).sort()).toEqual(['description', 'jobIds', 'schedule'])
  })
})

// ─── ScheduleLoadAnalysis ────────────────────────────────────────────────────

describe('ScheduleLoadAnalysis', () => {
  test('has hourlyLoad, peakHours, recommendations', () => {
    const a: ScheduleLoadAnalysis = {
      hourlyLoad: { 0: 3, 3: 5, 12: 2 },
      peakHours: [3],
      recommendations: ['Spread backup jobs across midnight-4am'],
    }
    expect(a.hourlyLoad[3]).toBe(5)
    expect(a.peakHours).toEqual([3])
    expect(a.recommendations).toHaveLength(1)
  })

  test('hourlyLoad is Record<number, number>', () => {
    const a: ScheduleLoadAnalysis = { hourlyLoad: {}, peakHours: [], recommendations: [] }
    expect(typeof a.hourlyLoad).toBe('object')
  })

  test('peakHours is number array', () => {
    const a: ScheduleLoadAnalysis = { hourlyLoad: {}, peakHours: [0, 6, 12, 18], recommendations: [] }
    expect(Array.isArray(a.peakHours)).toBe(true)
    expect(a.peakHours.every((h) => typeof h === 'number')).toBe(true)
  })

  test('recommendations is string array', () => {
    const a: ScheduleLoadAnalysis = { hourlyLoad: {}, peakHours: [], recommendations: ['a', 'b'] }
    expect(a.recommendations.every((r) => typeof r === 'string')).toBe(true)
  })
})

// ─── DurationTrendData ───────────────────────────────────────────────────────

describe('DurationTrendData', () => {
  test('has jobId, durations, average, trend', () => {
    const d: DurationTrendData = {
      jobId: 'job-99',
      durations: [10, 12, 11, 15],
      average: 12,
      trend: 'increasing',
    }
    expect(d.jobId).toBe('job-99')
    expect(d.durations).toEqual([10, 12, 11, 15])
    expect(d.average).toBe(12)
    expect(d.trend).toBe('increasing')
  })

  test('durations is number array', () => {
    const d: DurationTrendData = { jobId: 'j', durations: [], average: 0, trend: 'stable' }
    expect(Array.isArray(d.durations)).toBe(true)
  })

  test('exactly 4 fields', () => {
    const d: DurationTrendData = { jobId: 'j', durations: [1], average: 1, trend: 'up' }
    expect(Object.keys(d).sort()).toEqual(['average', 'durations', 'jobId', 'trend'])
  })
})

// ─── AC-001-1: ServerMessage cron-ai variants ────────────────────────────────

describe('ServerMessage cron-ai variants', () => {
  test('cron-ai-proposal variant carries a CronAiProposal', () => {
    const msg: ServerMessage = {
      type: 'cron-ai-proposal',
      proposal: makeProposal(),
    }
    expect(msg.type).toBe('cron-ai-proposal')
    if (msg.type === 'cron-ai-proposal') {
      expect(msg.proposal.id).toBe('prop-001')
      expect(msg.proposal.operation).toBe('create')
    }
  })

  test('cron-ai-navigate variant has action and payload', () => {
    const msg: ServerMessage = {
      type: 'cron-ai-navigate',
      action: 'select-job',
      payload: { jobId: 'job-1' },
    }
    expect(msg.type).toBe('cron-ai-navigate')
    if (msg.type === 'cron-ai-navigate') {
      expect(msg.action).toBe('select-job')
      expect(msg.payload).toEqual({ jobId: 'job-1' })
    }
  })

  test('cron-ai-session-status variant with offline status', () => {
    const msg: ServerMessage = { type: 'cron-ai-session-status', status: 'offline' }
    if (msg.type === 'cron-ai-session-status') {
      expect(msg.status).toBe('offline')
      expect(msg.windowId).toBeUndefined()
    }
  })

  test('cron-ai-session-status variant with working status and windowId', () => {
    const msg: ServerMessage = { type: 'cron-ai-session-status', status: 'working', windowId: 'win-3' }
    if (msg.type === 'cron-ai-session-status') {
      expect(msg.status).toBe('working')
      expect(msg.windowId).toBe('win-3')
    }
  })

  test('cron-ai-session-status accepts all valid statuses', () => {
    const statuses = ['offline', 'starting', 'working', 'waiting'] as const
    for (const status of statuses) {
      const msg: ServerMessage = { type: 'cron-ai-session-status', status }
      if (msg.type === 'cron-ai-session-status') {
        expect(msg.status).toBe(status)
      }
    }
  })

  test('cron-ai-mcp-status variant', () => {
    const msg: ServerMessage = { type: 'cron-ai-mcp-status', connected: true }
    if (msg.type === 'cron-ai-mcp-status') {
      expect(msg.connected).toBe(true)
    }
  })

  test('cron-ai-context-update variant carries UiContext', () => {
    const ctx = makeUiContext({ activeTab: 'logs', visibleJobCount: 5 })
    const msg: ServerMessage = { type: 'cron-ai-context-update', context: ctx }
    if (msg.type === 'cron-ai-context-update') {
      expect(msg.context.activeTab).toBe('logs')
      expect(msg.context.visibleJobCount).toBe(5)
    }
  })

  test('cron-ai-proposal-resolved variant', () => {
    const msg: ServerMessage = {
      type: 'cron-ai-proposal-resolved',
      id: 'prop-001',
      status: 'accepted',
      feedback: 'Ship it',
    }
    if (msg.type === 'cron-ai-proposal-resolved') {
      expect(msg.id).toBe('prop-001')
      expect(msg.status).toBe('accepted')
      expect(msg.feedback).toBe('Ship it')
    }
  })

  test('cron-ai-proposal-resolved without feedback', () => {
    const msg: ServerMessage = {
      type: 'cron-ai-proposal-resolved',
      id: 'prop-002',
      status: 'rejected',
    }
    if (msg.type === 'cron-ai-proposal-resolved') {
      expect(msg.feedback).toBeUndefined()
    }
  })

  test('cron-ai-mcp-register variant', () => {
    const msg: ServerMessage = { type: 'cron-ai-mcp-register', success: true }
    if (msg.type === 'cron-ai-mcp-register') {
      expect(msg.success).toBe(true)
    }
  })

  test('all 7 cron-ai ServerMessage variants are exhaustively matchable', () => {
    const variants: ServerMessage[] = [
      { type: 'cron-ai-proposal', proposal: makeProposal() },
      { type: 'cron-ai-navigate', action: 'go', payload: {} },
      { type: 'cron-ai-session-status', status: 'offline' },
      { type: 'cron-ai-mcp-status', connected: false },
      { type: 'cron-ai-context-update', context: makeUiContext() },
      { type: 'cron-ai-proposal-resolved', id: 'x', status: 'expired' },
      { type: 'cron-ai-mcp-register', success: true },
    ]

    function handleCronAi(msg: ServerMessage): string {
      switch (msg.type) {
        case 'cron-ai-proposal': return 'proposal'
        case 'cron-ai-navigate': return 'navigate'
        case 'cron-ai-session-status': return 'session-status'
        case 'cron-ai-mcp-status': return 'mcp-status'
        case 'cron-ai-context-update': return 'context-update'
        case 'cron-ai-proposal-resolved': return 'proposal-resolved'
        case 'cron-ai-mcp-register': return 'mcp-register'
        default: return 'other'
      }
    }

    const results = variants.map(handleCronAi)
    expect(results).toEqual([
      'proposal',
      'navigate',
      'session-status',
      'mcp-status',
      'context-update',
      'proposal-resolved',
      'mcp-register',
    ])
  })
})

// ─── AC-001-2: ClientMessage cron-ai variants ───────────────────────────────

describe('ClientMessage cron-ai variants', () => {
  test('cron-ai-drawer-open has no extra fields', () => {
    const msg: ClientMessage = { type: 'cron-ai-drawer-open' }
    expect(msg.type).toBe('cron-ai-drawer-open')
    expect(Object.keys(msg)).toEqual(['type'])
  })

  test('cron-ai-drawer-close has no extra fields', () => {
    const msg: ClientMessage = { type: 'cron-ai-drawer-close' }
    expect(msg.type).toBe('cron-ai-drawer-close')
    expect(Object.keys(msg)).toEqual(['type'])
  })

  test('cron-ai-new-conversation has no extra fields', () => {
    const msg: ClientMessage = { type: 'cron-ai-new-conversation' }
    expect(msg.type).toBe('cron-ai-new-conversation')
    expect(Object.keys(msg)).toEqual(['type'])
  })

  test('cron-ai-proposal-response with approval', () => {
    const msg: ClientMessage = {
      type: 'cron-ai-proposal-response',
      id: 'prop-001',
      approved: true,
    }
    if (msg.type === 'cron-ai-proposal-response') {
      expect(msg.id).toBe('prop-001')
      expect(msg.approved).toBe(true)
      expect(msg.feedback).toBeUndefined()
    }
  })

  test('cron-ai-proposal-response with rejection and feedback', () => {
    const msg: ClientMessage = {
      type: 'cron-ai-proposal-response',
      id: 'prop-002',
      approved: false,
      feedback: 'Schedule conflicts with maintenance window',
    }
    if (msg.type === 'cron-ai-proposal-response') {
      expect(msg.approved).toBe(false)
      expect(msg.feedback).toBe('Schedule conflicts with maintenance window')
    }
  })

  test('cron-ai-context-update carries UiContext', () => {
    const ctx = makeUiContext({ selectedJobId: 'job-5' })
    const msg: ClientMessage = { type: 'cron-ai-context-update', context: ctx }
    if (msg.type === 'cron-ai-context-update') {
      expect(msg.context.selectedJobId).toBe('job-5')
    }
  })

  test('cron-ai-mcp-register with authToken', () => {
    const msg: ClientMessage = { type: 'cron-ai-mcp-register', authToken: 'secret-123' }
    if (msg.type === 'cron-ai-mcp-register') {
      expect(msg.authToken).toBe('secret-123')
    }
  })

  test('cron-ai-mcp-register without authToken', () => {
    const msg: ClientMessage = { type: 'cron-ai-mcp-register' }
    if (msg.type === 'cron-ai-mcp-register') {
      expect(msg.authToken).toBeUndefined()
    }
  })

  test('cron-ai-navigate has action and payload', () => {
    const msg: ClientMessage = {
      type: 'cron-ai-navigate',
      action: 'select-job',
      payload: { jobId: 'job-1' },
    }
    if (msg.type === 'cron-ai-navigate') {
      expect(msg.action).toBe('select-job')
      expect(msg.payload).toEqual({ jobId: 'job-1' })
    }
  })

  test('all 7 cron-ai ClientMessage variants are exhaustively matchable', () => {
    const variants: ClientMessage[] = [
      { type: 'cron-ai-drawer-open' },
      { type: 'cron-ai-drawer-close' },
      { type: 'cron-ai-new-conversation' },
      { type: 'cron-ai-proposal-response', id: 'p', approved: true },
      { type: 'cron-ai-context-update', context: makeUiContext() },
      { type: 'cron-ai-mcp-register' },
      { type: 'cron-ai-navigate', action: 'go', payload: {} },
    ]

    function handleCronAiClient(msg: ClientMessage): string {
      switch (msg.type) {
        case 'cron-ai-drawer-open': return 'drawer-open'
        case 'cron-ai-drawer-close': return 'drawer-close'
        case 'cron-ai-new-conversation': return 'new-conversation'
        case 'cron-ai-proposal-response': return 'proposal-response'
        case 'cron-ai-context-update': return 'context-update'
        case 'cron-ai-mcp-register': return 'mcp-register'
        case 'cron-ai-navigate': return 'navigate'
        default: return 'other'
      }
    }

    const results = variants.map(handleCronAiClient)
    expect(results).toEqual([
      'drawer-open',
      'drawer-close',
      'new-conversation',
      'proposal-response',
      'context-update',
      'mcp-register',
      'navigate',
    ])
  })
})

// ─── Compile-time exhaustiveness guard (AC-001-1 + AC-001-2) ─────────────────
// These functions exist purely for the type checker. If a variant is added to
// the union but not handled here, `bun run typecheck` will fail.

describe('compile-time exhaustiveness', () => {
  test('ServerMessage full switch compiles without default', () => {
    // This function handles EVERY ServerMessage variant.
    // Adding a new variant without a case here will cause a TS error.
    function exhaustiveServer(msg: ServerMessage): string {
      switch (msg.type) {
        case 'auth-failed': return msg.type
        case 'auth-success': return msg.type
        case 'sessions': return msg.type
        case 'session-update': return msg.type
        case 'session-created': return msg.type
        case 'session-removed': return msg.type
        case 'agent-sessions': return msg.type
        case 'session-orphaned': return msg.type
        case 'session-activated': return msg.type
        case 'session-resume-result': return msg.type
        case 'session-pin-result': return msg.type
        case 'session-resurrection-failed': return msg.type
        case 'terminal-output': return msg.type
        case 'terminal-error': return msg.type
        case 'terminal-ready': return msg.type
        case 'tmux-copy-mode-status': return msg.type
        case 'error': return msg.type
        case 'kill-failed': return msg.type
        case 'task-created': return msg.type
        case 'task-updated': return msg.type
        case 'task-list': return msg.type
        case 'template-list': return msg.type
        case 'workflow-list': return msg.type
        case 'workflow-updated': return msg.type
        case 'workflow-removed': return msg.type
        case 'workflow-run-update': return msg.type
        case 'workflow-run-list': return msg.type
        case 'pool_status_update': return msg.type
        case 'pool_slot_granted': return msg.type
        case 'step_queued': return msg.type
        case 'review_iteration': return msg.type
        case 'step_starvation': return msg.type
        case 'amendment_detected': return msg.type
        case 'amendment_escalated': return msg.type
        case 'amendment_resolved': return msg.type
        case 'budget_updated': return msg.type
        case 'batch_reconciliation_threshold': return msg.type
        case 'batch_reconciliation_complete': return msg.type
        case 'signal_detected': return msg.type
        case 'amendment_filed': return msg.type
        case 'step_paused': return msg.type
        case 'branch_created': return msg.type
        case 'cleanup_started': return msg.type
        case 'cleanup_completed': return msg.type
        // Cron Manager
        case 'cron-jobs': return msg.type
        case 'cron-job-update': return msg.type
        case 'cron-job-removed': return msg.type
        case 'cron-job-detail': return msg.type
        case 'cron-operation-result': return msg.type
        case 'cron-sudo-required': return msg.type
        case 'cron-run-started': return msg.type
        case 'cron-run-output': return msg.type
        case 'cron-run-completed': return msg.type
        case 'cron-bulk-operation-progress': return msg.type
        case 'cron-notification': return msg.type
        // Cron AI Orchestrator (7 new)
        case 'cron-ai-proposal': return msg.type
        case 'cron-ai-navigate': return msg.type
        case 'cron-ai-session-status': return msg.type
        case 'cron-ai-mcp-status': return msg.type
        case 'cron-ai-context-update': return msg.type
        case 'cron-ai-proposal-resolved': return msg.type
        case 'cron-ai-mcp-register': return msg.type
        // Stats and misc
        case 'stats-update': return msg.type
        case 'nightly-report': return msg.type
        case 'ticket-update': return msg.type
        default: {
          const _exhaustive: never = msg
          throw new Error(`Unhandled: ${(_exhaustive as ServerMessage).type}`)
        }
      }
    }

    // Smoke-test a few
    const result = exhaustiveServer({ type: 'cron-ai-mcp-status', connected: true })
    expect(result).toBe('cron-ai-mcp-status')
  })

  test('ClientMessage full switch compiles without default', () => {
    function exhaustiveClient(msg: ClientMessage): string {
      switch (msg.type) {
        case 'terminal-attach': return msg.type
        case 'terminal-detach': return msg.type
        case 'terminal-input': return msg.type
        case 'terminal-resize': return msg.type
        case 'session-create': return msg.type
        case 'session-kill': return msg.type
        case 'session-rename': return msg.type
        case 'session-refresh': return msg.type
        case 'tmux-cancel-copy-mode': return msg.type
        case 'tmux-check-copy-mode': return msg.type
        case 'session-resume': return msg.type
        case 'session-pin': return msg.type
        case 'auth': return msg.type
        case 'task-create': return msg.type
        case 'task-cancel': return msg.type
        case 'task-retry': return msg.type
        case 'task-list-request': return msg.type
        case 'template-list-request': return msg.type
        case 'workflow-list-request': return msg.type
        case 'workflow-run-list-request': return msg.type
        case 'workflow-run': return msg.type
        case 'workflow-run-resume': return msg.type
        case 'workflow-run-cancel': return msg.type
        case 'workflow-step-action': return msg.type
        // Cron Manager
        case 'cron-job-select': return msg.type
        case 'cron-job-run-now': return msg.type
        case 'cron-job-pause': return msg.type
        case 'cron-job-resume': return msg.type
        case 'cron-job-edit-frequency': return msg.type
        case 'cron-job-delete': return msg.type
        case 'cron-job-create': return msg.type
        case 'cron-bulk-pause': return msg.type
        case 'cron-bulk-resume': return msg.type
        case 'cron-bulk-delete': return msg.type
        case 'cron-job-set-tags': return msg.type
        case 'cron-job-set-managed': return msg.type
        case 'cron-job-link-session': return msg.type
        case 'cron-sudo-auth': return msg.type
        case 'cron-job-logs': return msg.type
        case 'cron-job-history': return msg.type
        // Cron AI Orchestrator (7 new)
        case 'cron-ai-drawer-open': return msg.type
        case 'cron-ai-drawer-close': return msg.type
        case 'cron-ai-new-conversation': return msg.type
        case 'cron-ai-proposal-response': return msg.type
        case 'cron-ai-context-update': return msg.type
        case 'cron-ai-mcp-register': return msg.type
        case 'cron-ai-navigate': return msg.type
        default: {
          const _exhaustive: never = msg
          throw new Error(`Unhandled: ${(_exhaustive as ClientMessage).type}`)
        }
      }
    }

    const result = exhaustiveClient({ type: 'cron-ai-drawer-open' })
    expect(result).toBe('cron-ai-drawer-open')
  })
})

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe('edge cases', () => {
  test('CronAiProposal with all nullable fields set to null', () => {
    const p = makeProposal({
      jobId: null,
      jobName: null,
      jobAvatarUrl: null,
      feedback: null,
      resolvedAt: null,
    })
    expect(p.jobId).toBeNull()
    expect(p.jobName).toBeNull()
    expect(p.jobAvatarUrl).toBeNull()
    expect(p.feedback).toBeNull()
    expect(p.resolvedAt).toBeNull()
  })

  test('CronAiProposal with all nullable fields set to values', () => {
    const p = makeProposal({
      jobId: 'job-1',
      jobName: 'nightly-backup',
      jobAvatarUrl: '/avatars/backup.png',
      feedback: 'Approved with note',
      resolvedAt: '2026-02-25T12:00:00Z',
    })
    expect(p.jobId).toBe('job-1')
    expect(p.jobName).toBe('nightly-backup')
    expect(p.jobAvatarUrl).toBe('/avatars/backup.png')
    expect(p.feedback).toBe('Approved with note')
    expect(p.resolvedAt).toBe('2026-02-25T12:00:00Z')
  })

  test('UiContext with zero counts', () => {
    const ctx = makeUiContext({
      visibleJobCount: 0,
      healthSummary: { healthy: 0, warning: 0, critical: 0 },
    })
    expect(ctx.visibleJobCount).toBe(0)
    expect(ctx.healthSummary.healthy).toBe(0)
  })

  test('UiContext with empty filter tags', () => {
    const ctx = makeUiContext({ filterState: { mode: 'all', source: null, tags: [] } })
    expect(ctx.filterState.tags).toEqual([])
  })

  test('UiContext with populated filter tags', () => {
    const ctx = makeUiContext({
      filterState: { mode: 'tagged', source: 'user-crontab', tags: ['backup', 'monitoring'] },
    })
    expect(ctx.filterState.tags).toEqual(['backup', 'monitoring'])
  })

  test('ScheduleLoadAnalysis with empty hourlyLoad', () => {
    const a: ScheduleLoadAnalysis = { hourlyLoad: {}, peakHours: [], recommendations: [] }
    expect(Object.keys(a.hourlyLoad)).toHaveLength(0)
  })

  test('ScheduleLoadAnalysis with all 24 hours', () => {
    const load: Record<number, number> = {}
    for (let h = 0; h < 24; h++) load[h] = h
    const a: ScheduleLoadAnalysis = { hourlyLoad: load, peakHours: [23], recommendations: [] }
    expect(Object.keys(a.hourlyLoad)).toHaveLength(24)
  })

  test('DurationTrendData with empty durations', () => {
    const d: DurationTrendData = { jobId: 'j', durations: [], average: 0, trend: 'stable' }
    expect(d.durations).toHaveLength(0)
  })

  test('ProposalResult with only success field', () => {
    const r: ProposalResult = { success: true }
    // All other fields should be undefined
    expect(r.result).toBeUndefined()
    expect(r.rejected).toBeUndefined()
    expect(r.expired).toBeUndefined()
    expect(r.feedback).toBeUndefined()
    expect(r.error).toBeUndefined()
  })

  test('cron-ai-navigate with empty payload', () => {
    const msg: ServerMessage = { type: 'cron-ai-navigate', action: 'reset', payload: {} }
    if (msg.type === 'cron-ai-navigate') {
      expect(msg.payload).toEqual({})
    }
  })

  test('cron-ai-proposal-resolved uses CronAiProposal status type', () => {
    // The status field on cron-ai-proposal-resolved is CronAiProposal['status'],
    // so it must accept all 4 proposal statuses.
    const statuses: CronAiProposal['status'][] = ['pending', 'accepted', 'rejected', 'expired']
    for (const status of statuses) {
      const msg: ServerMessage = { type: 'cron-ai-proposal-resolved', id: 'x', status }
      if (msg.type === 'cron-ai-proposal-resolved') {
        expect(msg.status).toBe(status)
      }
    }
  })
})
