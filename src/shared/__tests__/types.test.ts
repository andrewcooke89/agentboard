// WO-nightly-TKT-0696-2026-03-29-001: Type-level test coverage for src/shared/types.ts
// Tests compile-time contracts: exhaustiveness of discriminated unions, type assignability,
// and structural correctness for core types.
// Does NOT duplicate tests already in cronAiTypes.test.ts.

import { describe, it, expect } from 'bun:test'
import type {
  ServerMessage,
  ClientMessage,
  StepRunStatus,
  WorkflowStepType,
  Session,
  Task,
  WorkflowRun,
  CronJob,
  StepRunState,
} from '../types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${x}`)
}

// ─── ServerMessage exhaustive discriminant ───────────────────────────────────

describe('ServerMessage', () => {
  it('has exhaustive type handling', () => {
    function exhaustiveServerMessage(msg: ServerMessage): string {
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
        case 'cron-ai-proposal': return msg.type
        case 'cron-ai-navigate': return msg.type
        case 'cron-ai-session-status': return msg.type
        case 'cron-ai-mcp-status': return msg.type
        case 'cron-ai-context-update': return msg.type
        case 'cron-ai-proposal-resolved': return msg.type
        case 'cron-ai-mcp-register': return msg.type
        case 'stats-update': return msg.type
        case 'nightly-report': return msg.type
        case 'ticket-update': return msg.type
        default:
          return assertNever(msg)
      }
    }
    // The function existing and compiling IS the test
    expect(typeof exhaustiveServerMessage).toBe('function')
  })
})

// ─── ClientMessage exhaustive discriminant ───────────────────────────────────

describe('ClientMessage', () => {
  it('has exhaustive type handling', () => {
    function exhaustiveClientMessage(msg: ClientMessage): string {
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
        case 'cron-ai-drawer-open': return msg.type
        case 'cron-ai-drawer-close': return msg.type
        case 'cron-ai-new-conversation': return msg.type
        case 'cron-ai-proposal-response': return msg.type
        case 'cron-ai-context-update': return msg.type
        case 'cron-ai-mcp-register': return msg.type
        case 'cron-ai-navigate': return msg.type
        default:
          return assertNever(msg)
      }
    }
    expect(typeof exhaustiveClientMessage).toBe('function')
  })
})

// ─── StepRunStatus exhaustive ────────────────────────────────────────────────

describe('StepRunStatus', () => {
  it('has exhaustive type handling', () => {
    function exhaustiveStepRunStatus(status: StepRunStatus): string {
      switch (status) {
        case 'pending': return status
        case 'running': return status
        case 'completed': return status
        case 'failed': return status
        case 'skipped': return status
        case 'queued': return status
        case 'cancelled': return status
        case 'partial': return status
        case 'waiting_signal': return status
        case 'signal_received': return status
        case 'signal_timeout': return status
        case 'signal_error': return status
        case 'signal_resolved': return status
        case 'paused_amendment': return status
        case 'paused_escalated': return status
        case 'paused_human': return status
        case 'paused_starvation': return status
        case 'paused_exploration': return status
        case 'invalidated': return status
        default:
          return assertNever(status)
      }
    }
    expect(typeof exhaustiveStepRunStatus).toBe('function')
  })
})

// ─── WorkflowStepType exhaustive ─────────────────────────────────────────────

describe('WorkflowStepType', () => {
  it('has exhaustive type handling', () => {
    function exhaustiveWorkflowStepType(type: WorkflowStepType): string {
      switch (type) {
        case 'spawn_session': return type
        case 'check_file': return type
        case 'delay': return type
        case 'check_output': return type
        case 'native_step': return type
        case 'parallel_group': return type
        case 'review_loop': return type
        case 'spec_validate': return type
        case 'amendment_check': return type
        case 'reconcile-spec': return type
        case 'gemini_offload': return type
        case 'aggregator': return type
        case 'human_gate': return type
        case 'review': return type
        default:
          return assertNever(type)
      }
    }
    expect(typeof exhaustiveWorkflowStepType).toBe('function')
  })
})

// ─── Type assignability tests ────────────────────────────────────────────────

describe('Session interface', () => {
  it('accepts valid session objects', () => {
    const session: Session = {
      id: '1',
      name: 'test',
      tmuxWindow: 'w1',
      projectPath: '/tmp',
      status: 'working',
      lastActivity: '2026-01-01',
      createdAt: '2026-01-01',
      source: 'managed',
    }
    expect(session.id).toBe('1')
  })

  it('accepts session objects with optional fields', () => {
    const session: Session = {
      id: '2',
      name: 'full-session',
      tmuxWindow: 'w2',
      projectPath: '/home/user/project',
      status: 'waiting',
      lastActivity: '2026-03-01',
      createdAt: '2026-01-15',
      source: 'external',
      agentType: 'claude',
      command: 'claude --dangerously-skip-permissions',
      agentSessionId: 'agent-123',
      agentSessionName: 'my-agent',
      lastUserMessage: 'Fix the bug',
      isPinned: true,
    }
    expect(session.agentType).toBe('claude')
    expect(session.isPinned).toBe(true)
  })
})

describe('Task interface', () => {
  it('accepts valid task objects', () => {
    const task: Task = {
      id: 'task-1',
      projectPath: '/tmp/project',
      prompt: 'Fix all lint errors',
      templateId: null,
      priority: 5,
      status: 'queued',
      sessionName: null,
      tmuxWindow: null,
      createdAt: '2026-01-01T00:00:00Z',
      startedAt: null,
      completedAt: null,
      errorMessage: null,
      completionMethod: null,
      retryCount: 0,
      maxRetries: 3,
      timeoutSeconds: 300,
      outputPath: null,
      parentTaskId: null,
      followUpPrompt: null,
      metadata: null,
    }
    expect(task.id).toBe('task-1')
    expect(task.status).toBe('queued')
  })

  it('accepts task objects with all fields populated', () => {
    const task: Task = {
      id: 'task-2',
      projectPath: '/home/dev/app',
      prompt: 'Implement feature X',
      templateId: 'tmpl-42',
      priority: 10,
      status: 'running',
      sessionName: 'session-abc',
      tmuxWindow: 'win-3',
      createdAt: '2026-02-01T10:00:00Z',
      startedAt: '2026-02-01T10:01:00Z',
      completedAt: null,
      errorMessage: null,
      completionMethod: null,
      retryCount: 1,
      maxRetries: 3,
      timeoutSeconds: 600,
      outputPath: '/tmp/output.txt',
      parentTaskId: 'task-1',
      followUpPrompt: 'Run tests again',
      metadata: '{"key":"value"}',
    }
    expect(task.templateId).toBe('tmpl-42')
    expect(task.retryCount).toBe(1)
  })
})

describe('WorkflowRun interface', () => {
  it('accepts valid workflow run objects', () => {
    const run: WorkflowRun = {
      id: 'run-1',
      workflow_id: 'wf-1',
      workflow_name: 'Deploy Pipeline',
      status: 'pending',
      current_step_index: 0,
      steps_state: [],
      output_dir: '/tmp/output',
      started_at: null,
      completed_at: null,
      error_message: null,
      variables: null,
      created_at: '2026-01-01T00:00:00Z',
    }
    expect(run.id).toBe('run-1')
    expect(run.status).toBe('pending')
  })

  it('accepts workflow run with all optional fields', () => {
    const run: WorkflowRun = {
      id: 'run-2',
      workflow_id: 'wf-2',
      workflow_name: 'CI Pipeline',
      status: 'running',
      current_step_index: 3,
      steps_state: [],
      output_dir: '/tmp/ci-output',
      started_at: '2026-03-01T08:00:00Z',
      completed_at: null,
      error_message: null,
      variables: { ENV: 'staging', VERSION: '1.0.0' },
      created_at: '2026-03-01T07:59:00Z',
      pipelineCleanupState: null,
      tier: 2,
      amendmentBudget: {
        quality: { used: 0, max: 5 },
        reconciliation: { used: 0, max: 3 },
      },
      pendingAmendment: null,
    }
    expect(run.tier).toBe(2)
    expect(run.variables?.ENV).toBe('staging')
  })
})

describe('CronJob interface', () => {
  it('accepts valid cron job objects', () => {
    const job: CronJob = {
      id: 'job-1',
      name: 'Nightly Backup',
      source: 'user-crontab',
      schedule: '0 3 * * *',
      scheduleHuman: 'Daily at 3:00 AM',
      command: '/usr/bin/backup.sh',
      scriptPath: null,
      projectGroup: 'infra',
      status: 'active',
      health: 'healthy',
      healthReason: null,
      lastRun: null,
      lastRunDuration: null,
      nextRun: null,
      lastExitCode: null,
      consecutiveFailures: 0,
      avgDuration: null,
      user: 'root',
      requiresSudo: false,
      avatarUrl: null,
      unitFile: null,
      description: null,
      tags: ['backup'],
      isManagedByAgentboard: true,
      linkedSessionId: null,
    }
    expect(job.id).toBe('job-1')
    expect(job.status).toBe('active')
    expect(job.tags).toEqual(['backup'])
  })

  it('accepts cron job with all nullable fields set to values', () => {
    const job: CronJob = {
      id: 'job-2',
      name: 'Deploy Check',
      source: 'systemd-system',
      schedule: '*/15 * * * *',
      scheduleHuman: 'Every 15 minutes',
      command: '/opt/deploy/check.sh',
      scriptPath: '/opt/deploy/check.sh',
      projectGroup: 'deploy',
      status: 'active',
      health: 'warning',
      healthReason: 'Slow execution detected',
      lastRun: '2026-03-01T03:00:00Z',
      lastRunDuration: 120,
      nextRun: '2026-03-01T03:15:00Z',
      lastExitCode: 0,
      consecutiveFailures: 1,
      avgDuration: 95,
      user: 'deploy',
      requiresSudo: true,
      avatarUrl: '/avatars/deploy.png',
      unitFile: '/etc/systemd/system/deploy-check.service',
      description: 'Checks deployment health',
      tags: ['deploy', 'monitoring'],
      isManagedByAgentboard: false,
      linkedSessionId: 'session-99',
    }
    expect(job.health).toBe('warning')
    expect(job.requiresSudo).toBe(true)
  })
})

describe('StepRunState interface', () => {
  it('accepts minimal valid step run state objects', () => {
    const state: StepRunState = {
      name: 'step-1',
      type: 'spawn_session',
      status: 'pending',
      taskId: null,
      startedAt: null,
      completedAt: null,
      errorMessage: null,
      retryCount: 0,
      skippedReason: null,
      resultFile: null,
      resultCollected: false,
      resultContent: null,
    }
    expect(state.name).toBe('step-1')
    expect(state.status).toBe('pending')
  })

  it('accepts step run state with optional fields', () => {
    const state: StepRunState = {
      name: 'step-2',
      type: 'native_step',
      status: 'running',
      taskId: 'task-xyz',
      startedAt: '2026-03-01T10:00:00Z',
      completedAt: null,
      errorMessage: null,
      retryCount: 1,
      skippedReason: null,
      resultFile: null,
      resultCollected: false,
      resultContent: null,
      tier_min: 1,
      tier_max: 3,
      poolSlotId: 'slot-1',
      parentGroup: 'parallel-group-1',
      depends_on: ['step-1'],
      isPerWorkUnitContainer: false,
    }
    expect(state.taskId).toBe('task-xyz')
    expect(state.depends_on).toEqual(['step-1'])
  })
})
