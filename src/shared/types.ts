export type SessionStatus = 'working' | 'waiting' | 'permission' | 'unknown'

export type SessionSource = 'managed' | 'external'
export type AgentType = 'claude' | 'codex'
export type TerminalErrorCode =
  | 'ERR_INVALID_WINDOW'
  | 'ERR_SESSION_CREATE_FAILED'
  | 'ERR_TMUX_ATTACH_FAILED'
  | 'ERR_TMUX_SWITCH_FAILED'
  | 'ERR_TTY_DISCOVERY_TIMEOUT'
  | 'ERR_NOT_READY'

export interface Session {
  id: string
  name: string
  tmuxWindow: string
  projectPath: string
  status: SessionStatus
  lastActivity: string
  createdAt: string
  agentType?: AgentType
  source: SessionSource
  command?: string
  agentSessionId?: string
  agentSessionName?: string
  lastUserMessage?: string
  isPinned?: boolean
}

export interface AgentSession {
  sessionId: string
  logFilePath: string
  projectPath: string
  agentType: AgentType
  displayName: string
  createdAt: string
  lastActivityAt: string
  isActive: boolean
  lastUserMessage?: string
  isPinned?: boolean
  lastResumeError?: string
}

// Directory browser types
export interface DirectoryEntry {
  name: string
  path: string
}

export interface DirectoryListing {
  path: string
  parent: string | null
  directories: DirectoryEntry[]
  truncated: boolean
}

export interface DirectoryErrorResponse {
  error: 'invalid_path' | 'forbidden' | 'not_found' | 'internal_error'
  message: string
}

export type ServerMessage =
  | { type: 'auth-failed' }
  | { type: 'auth-success' }
  | { type: 'sessions'; sessions: Session[] }
  | { type: 'session-update'; session: Session }
  | { type: 'session-created'; session: Session }
  | { type: 'session-removed'; sessionId: string }
  | { type: 'agent-sessions'; active: AgentSession[]; inactive: AgentSession[] }
  | { type: 'session-orphaned'; session: AgentSession }
  | { type: 'session-activated'; session: AgentSession; window: string }
  | { type: 'session-resume-result'; sessionId: string; ok: boolean; session?: Session; error?: ResumeError }
  | { type: 'session-pin-result'; sessionId: string; ok: boolean; error?: string }
  | { type: 'session-resurrection-failed'; sessionId: string; displayName: string; error: string }
  | { type: 'terminal-output'; sessionId: string; data: string }
  | {
      type: 'terminal-error'
      sessionId: string | null
      code: TerminalErrorCode
      message: string
      retryable: boolean
    }
  | { type: 'terminal-ready'; sessionId: string }
  | { type: 'tmux-copy-mode-status'; sessionId: string; inCopyMode: boolean }
  | { type: 'error'; message: string }
  | { type: 'kill-failed'; sessionId: string; message: string }
  | { type: 'task-created'; task: Task }
  | { type: 'task-updated'; task: Task }
  | { type: 'task-list'; tasks: Task[]; stats: TaskQueueStats }
  | { type: 'template-list'; templates: TaskTemplate[] }
  // Workflow engine messages (ST-001-06)
  | { type: 'workflow-list'; workflows: WorkflowDefinition[] }
  | { type: 'workflow-updated'; workflow: WorkflowDefinition }
  | { type: 'workflow-removed'; workflowId: string }
  | { type: 'workflow-run-update'; run: WorkflowRun }
  | { type: 'workflow-run-list'; runs: WorkflowRun[] }
  // Phase 5: Session pool messages
  | { type: 'pool_status_update'; active: number; queued: number; max: number }
  | { type: 'pool_slot_granted'; runId: string; stepName: string; slotId: string; poolStatus?: PoolStatus }
  | { type: 'step_queued'; runId: string; stepName: string; queuePosition: number; poolStatus?: PoolStatus }
  | { type: 'review_iteration'; runId: string; stepName: string; iteration: number; verdict: string; run: WorkflowRun }
  | { type: 'step_starvation'; runId: string; stepName: string; waitSeconds: number }
  // Phase 10: Amendment messages
  | { type: 'amendment_detected'; runId: string; stepName: string; amendmentType: string; category: string }
  | { type: 'amendment_escalated'; runId: string; stepName: string; reason: string }
  | { type: 'amendment_resolved'; runId: string; stepName: string; resolution: string }
  | { type: 'budget_updated'; runId: string; category: string; used: number; max: number }
  // P-8: Batch reconciliation messages
  | { type: 'batch_reconciliation_threshold'; runId: string; stepName: string; sections: number; threshold: number }
  | { type: 'batch_reconciliation_complete'; runId: string; stepName: string; sectionsProcessed: number }
  // Phase 15: UI enhancement messages
  | { type: 'signal_detected'; runId: string; stepName: string; signalType: string; details: Record<string, unknown> }
  | { type: 'amendment_filed'; runId: string; stepName: string; amendmentId: string; amendmentType: string }
  | { type: 'step_paused'; runId: string; stepName: string; reason: string }
  | { type: 'branch_created'; runId: string; branchName: string }
  | { type: 'cleanup_started'; runId: string; stepName: string; level: 'step' | 'pipeline' }
  | { type: 'cleanup_completed'; runId: string; stepName: string; level: 'step' | 'pipeline'; success: boolean }
  // Cron Manager messages (WU-001)
  | { type: 'cron-jobs'; jobs: CronJob[]; systemdAvailable: boolean }
  | { type: 'cron-job-update'; job: CronJob }
  | { type: 'cron-job-removed'; jobId: string }
  | { type: 'cron-job-detail'; detail: CronJobDetail }
  | { type: 'cron-operation-result'; jobId: string; operation: string; success: boolean; error?: string }
  | { type: 'cron-sudo-required'; jobId: string; operation: string }
  | { type: 'cron-run-started'; jobId: string; runId: string }
  | { type: 'cron-run-output'; jobId: string; runId: string; chunk: string }
  | { type: 'cron-run-completed'; jobId: string; runId: string; exitCode: number; duration: number }
  | { type: 'cron-bulk-operation-progress'; completed: number; total: number; failures: string[] }
  | { type: 'cron-notification'; jobId: string; event: string; message: string; severity: 'info' | 'warning' | 'critical' }
  // Cron AI Orchestrator messages (WU-001)
  | { type: 'cron-ai-proposal'; proposal: CronAiProposal }
  | { type: 'cron-ai-navigate'; action: string; payload: Record<string, unknown> }
  | { type: 'cron-ai-session-status'; status: 'offline' | 'starting' | 'working' | 'waiting'; windowId?: string; sessionId?: string }
  | { type: 'cron-ai-mcp-status'; connected: boolean }
  | { type: 'cron-ai-context-update'; context: UiContext }
  | { type: 'cron-ai-proposal-resolved'; id: string; status: CronAiProposal['status']; feedback?: string }
  | { type: 'cron-ai-mcp-register'; success: boolean }
  | { type: 'stats-update'; stats: import('./dashboardTypes').DashboardStats }
  | { type: 'nightly-report'; report: Record<string, unknown> }
  | { type: 'ticket-update'; ticket: { id: string; status: string }; action: string }

export interface ResumeError {
  code: 'NOT_FOUND' | 'ALREADY_ACTIVE' | 'RESUME_FAILED'
  message: string
}

export type ClientMessage =
  | {
      type: 'terminal-attach'
      sessionId: string
      tmuxTarget?: string
      cols?: number
      rows?: number
    }
  | { type: 'terminal-detach'; sessionId: string }
  | { type: 'terminal-input'; sessionId: string; data: string }
  | { type: 'terminal-resize'; sessionId: string; cols: number; rows: number }
  | { type: 'session-create'; projectPath: string; name?: string; command?: string; prompt?: string }
  | { type: 'session-kill'; sessionId: string }
  | { type: 'session-rename'; sessionId: string; newName: string }
  | { type: 'session-refresh' }
  | { type: 'tmux-cancel-copy-mode'; sessionId: string }
  | { type: 'tmux-check-copy-mode'; sessionId: string }
  | { type: 'session-resume'; sessionId: string; name?: string }
  | { type: 'session-pin'; sessionId: string; isPinned: boolean }
  | { type: 'auth'; token: string }
  | { type: 'task-create'; projectPath: string; prompt: string; templateId?: string; variables?: Record<string, string>; priority?: number; timeoutSeconds?: number; maxRetries?: number; followUpPrompt?: string; metadata?: string }
  | { type: 'task-cancel'; taskId: string }
  | { type: 'task-retry'; taskId: string }
  | { type: 'task-list-request' }
  | { type: 'template-list-request' }
  // Workflow engine messages (ST-001-06)
  | { type: 'workflow-list-request' }
  | { type: 'workflow-run-list-request'; workflowId?: string }
  | { type: 'workflow-run'; workflowId: string; variables?: Record<string, string>; projectPath?: string }
  | { type: 'workflow-run-resume'; runId: string }
  | { type: 'workflow-run-cancel'; runId: string }
  | { type: 'workflow-step-action'; runId: string; stepName: string; action: string }
  // Cron Manager messages (WU-001)
  | { type: 'cron-job-select'; jobId: string }
  | { type: 'cron-job-run-now'; jobId: string }
  | { type: 'cron-job-pause'; jobId: string }
  | { type: 'cron-job-resume'; jobId: string }
  | { type: 'cron-job-edit-frequency'; jobId: string; newSchedule: string }
  | { type: 'cron-job-delete'; jobId: string }
  | { type: 'cron-job-create'; mode: 'cron' | 'systemd'; config: CronCreateConfig | SystemdCreateConfig }
  | { type: 'cron-bulk-pause'; jobIds: string[] }
  | { type: 'cron-bulk-resume'; jobIds: string[] }
  | { type: 'cron-bulk-delete'; jobIds: string[] }
  | { type: 'cron-job-set-tags'; jobId: string; tags: string[] }
  | { type: 'cron-job-set-managed'; jobId: string; managed: boolean }
  | { type: 'cron-job-link-session'; jobId: string; sessionId: string | null }
  | { type: 'cron-sudo-auth'; sudoCredential: string }
  | { type: 'cron-job-logs'; jobId: string; lines: number; offset?: number }
  | { type: 'cron-job-history'; jobId: string; limit: number; before?: string }
  // Cron AI Orchestrator messages (WU-001)
  | { type: 'cron-ai-drawer-open' }
  | { type: 'cron-ai-drawer-close' }
  | { type: 'cron-ai-new-conversation' }
  | { type: 'cron-ai-proposal-response'; id: string; approved: boolean; feedback?: string }
  | { type: 'cron-ai-context-update'; context: UiContext }
  | { type: 'cron-ai-mcp-register'; authToken?: string }
  | { type: 'cron-ai-navigate'; action: string; payload: Record<string, unknown> }

// Task queue types
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Task {
  id: string
  projectPath: string
  prompt: string
  templateId: string | null
  priority: number
  status: TaskStatus
  sessionName: string | null
  tmuxWindow: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  errorMessage: string | null
  completionMethod: string | null
  retryCount: number
  maxRetries: number
  timeoutSeconds: number
  outputPath: string | null
  parentTaskId: string | null
  followUpPrompt: string | null
  metadata: string | null
}

export interface TaskTemplate {
  id: string
  name: string
  promptTemplate: string
  variables: string
  projectPath: string | null
  priority: number
  timeoutSeconds: number
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

export interface TaskQueueStats {
  queued: number
  running: number
  completedToday: number
  failedToday: number
}

// Typed function signatures for client-side messaging
export type SendClientMessage = (message: ClientMessage) => boolean
export type SubscribeServerMessage = (listener: (message: ServerMessage) => void) => () => void

// ─── Workflow Engine Types (WO-001) ─────────────────────────────────────────

// ST-001-01: Step type and workflow status enums
export type WorkflowStepType = 'spawn_session' | 'check_file' | 'delay' | 'check_output' | 'native_step' | 'parallel_group' | 'review_loop' | 'spec_validate' | 'amendment_check' | 'reconcile-spec' | 'gemini_offload' | 'aggregator' | 'human_gate' | 'review'

// Workflow variable definition (used in YAML variables section)
export type WorkflowVariableType = 'string' | 'path'

export interface WorkflowVariable {
  name: string
  type: WorkflowVariableType
  description: string
  required: boolean
  default?: string
}

export type WorkflowStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

// ST-001-02: Step conditions (discriminated union on 'type' field)
export type StepCondition =
  | { type: 'file_exists'; path: string }
  | { type: 'output_contains'; step: string; contains: string }
  | { type: 'expression'; expr: string }  // Phase 21: string condition expressions

// ST-001-03: Workflow step definition (maps to YAML step schema)
export interface WorkflowStep {
  name: string
  type: WorkflowStepType
  condition?: StepCondition
  // spawn_session fields
  projectPath?: string
  prompt?: string
  agentType?: 'claude' | 'codex'
  model?: string  // 'claude' | 'glm' — resolved to env vars at spawn time
  output_path?: string
  result_file?: string
  timeoutSeconds?: number
  maxRetries?: number
  // check_file fields
  path?: string
  max_age_seconds?: number
  // delay fields
  seconds?: number
  // check_output fields
  step?: string
  contains?: string
  // native_step fields
  command?: string
  action?: string
  args?: string[]
  working_dir?: string
  env?: Record<string, string>
  success_codes?: number[]
  capture_stderr?: boolean
  // Phase 25: checks array for multi-command verification with pause/fail support
  checks?: Check[]
  review_routing_validation?: ReviewRoutingValidation
  // tier fields (all step types)
  tier_min?: number
  tier_max?: number
  // parallel_group fields (Phase 5)
  depends_on?: string[]
  steps?: WorkflowStep[]
  on_failure?: 'fail_fast' | 'cancel_all' | 'continue_others'
  max_parallel?: number
  // review_loop fields (REQ-40)
  producer?: WorkflowStep
  reviewer?: WorkflowStep
  max_iterations?: number
  on_max_iterations?: 'escalate' | 'accept_last' | 'fail'
  on_concern?: { timeout_minutes?: number; default_action?: 'accept' | 'reject' }
  verdict_field?: string
  feedback_field?: string
  tier_override?: Record<string, Record<string, unknown>>
  // Phase 7: Signal-checkpoint protocol fields
  signal_protocol?: boolean
  signal_dir?: string
  signal_timeout_seconds?: number
  // Phase 9: spec_validate fields
  spec_path?: string
  schema_path?: string
  strict?: boolean
  constitution_sections?: string[]
  constitution_path?: string
  // Phase 10: Amendment system fields
  can_request_amendment?: boolean
  amendment_budget?: {
    quality?: { per_run?: number; per_work_unit?: number }
    reconciliation?: { per_run?: number; per_work_unit?: number }
  }
  amendment_config?: {
    auto_review_types?: string[]
    human_required_types?: string[]
    human_required_tiers?: number[]
    same_section_twice?: 'escalate' | 'ignore'
    handler_timeout_seconds?: number
  }
  // amendment_check-specific fields
  signal_types?: string[]
  on_amendment?: { handler?: string; resume_from_checkpoint?: boolean }
  on_human_required?: { action?: string }
  on_exploration_required?: { action?: string; resume_step?: string }
  // reconcile-spec fields (P-8)
  batch_threshold?: number
  // Phase 21: native_step expect field (invert exit code semantics for TDD red verification)
  expect?: 'pass' | 'fail'
  // Phase 21: gemini_offload fields
  prompt_template?: string
  input_files?: string[]
  output_file?: string
  max_tokens?: number
  temperature?: number
  // Phase 21: aggregator fields
  input_steps?: string[]
  dedup_key?: string
  evidence_required?: boolean
  verdict_rules?: Array<{ condition: string; verdict: 'PASS' | 'WARN' | 'FAIL' }>
  // Phase 22: Retry backoff configuration
  retry_backoff?: {
    base_delay_seconds?: number
    multiplier?: number
    max_delay_seconds?: number
    jitter?: boolean
  }
  // Phase 21: per_work_unit fields (on spawn_session)
  per_work_unit?: {
    manifest_path?: string
    execution_mode?: 'sequential' | 'parallel'
    substeps?: WorkflowStep[]
    specialist_selection?: {
      enabled: boolean
      tag_field?: string
      applies_to?: string
    }
  }
  // Phase 26: review step fields
  target_path?: string
  work_order?: Record<string, unknown>
  review_config?: Record<string, unknown>
  // Phase 21: Pipeline step fields (passthrough from pipeline YAMLs)
  agent?: string
  posture?: string
  description?: string
  inputs?: unknown[]
  outputs?: unknown[]
  soft_depends_on?: string[]
  optional?: boolean
  dependency_mode?: string
  fallback_agent?: string
  agent_prompt_override?: string
  timeout_seconds?: number
  // Phase 15: Error hooks / cleanup steps (REQ-23)
  on_error?: CleanupAction[]
  // Phase 25: Step-level failure policy (e.g. on_failure: completed_with_warnings)
  on_step_failure?: 'fail' | 'completed_with_warnings' | 'skip'
  // Verdict enforcement: gate step completion on a field in the result file
  enforce_verdict?: {
    field?: string        // default: 'overall_verdict'
    allowed?: string[]    // default: ['pass']
    fail_message?: string // supports {{ verdict }} placeholder
  }
}

// Phase 15: Cleanup action for on_error hooks (REQ-23-27)
export interface CleanupAction {
  type: 'native_step'
  command: string
  working_dir?: string
  timeoutSeconds?: number
}

// Phase 25: Check definition for checks: arrays in native_step
export interface Check {
  name: string
  description?: string
  command?: string
  check?: string  // Expression check (for review_routing_validation)
  condition?: string  // Condition to enable this check
  on_failure?: CheckFailure
}

export interface CheckFailure {
  action: 'pause' | 'fail'
  message: string
}

export interface ReviewRoutingValidation {
  when?: string  // Condition to enable this section
  checks?: Check[]
}

// Phase 15: Cleanup execution state (REQ-26)
export type CleanupStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface CleanupState {
  level: 'step' | 'pipeline'
  status: CleanupStatus
  startedAt: string | null
  completedAt: string | null
  errorMessage: string | null
}

// Phase 15: Pool status types (REQ-10-13)
export interface PoolSlot {
  slotId: string
  runId: string
  stepName: string
  tier: number
  startedAt: string
}

export interface PoolQueueEntry {
  runId: string
  stepName: string
  tier: number
  requestedAt: string
  position: number
}

export interface PoolStatus {
  maxSlots: number
  activeSlots: PoolSlot[]
  queue: PoolQueueEntry[]
}

// Phase 15: Review loop iteration history (REQ-06-09)
export interface ReviewIteration {
  iteration: number
  verdict: 'PASS' | 'FAIL' | 'NEEDS_FIX' | 'CONCERN' | null
  feedback: string | null
  producerTaskId: string | null
  reviewerTaskId: string | null
  startedAt: string | null
  completedAt: string | null
}

// Phase 15: Signal monitoring types (REQ-30-31)
export interface DetectedSignal {
  id: string
  type: string
  timestamp: string
  resolutionStatus: 'pending' | 'resolved' | 'timeout'
  content: string | null
  checkpointData: {
    completedSubtasks?: string[]
    filesModified?: string[]
    buildStatus?: string
  } | null
}

// Phase 15: Pending review item types (REQ-32-33)
export type PendingReviewType = 'amendment_approval' | 'concern_verdict' | 'escalated_review_loop' | 'budget_exhaustion'

export interface PendingReviewItem {
  id: string
  runId: string
  pipelineName: string
  itemType: PendingReviewType
  stepName: string
  tier: number
  waitingSince: string
  details: Record<string, unknown>
  severity?: 'low' | 'medium' | 'high'
}

// Phase 15: Amendment budget types (REQ-19-22)
export interface AmendmentBudgetStatus {
  quality: { used: number; max: number }
  reconciliation: { used: number; max: number }
}

export interface AmendmentDetail {
  id: string
  specSection: string
  issue: string
  proposedChange: string | null
  category: string
  autoApproved: boolean
  autoApprovedBy: string | null
}

// ST-001-04: Workflow definition (maps to workflows SQLite table)
export interface WorkflowDefinition {
  id: string
  name: string
  description: string | null
  yaml_content: string
  file_path: string | null
  is_valid: boolean
  validation_errors: string[]
  step_count: number
  created_at: string
  updated_at: string
}

// ST-001-04: Workflow run instance (maps to workflow_runs SQLite table)
export interface WorkflowRun {
  id: string
  workflow_id: string
  workflow_name: string
  status: WorkflowStatus
  current_step_index: number
  steps_state: StepRunState[]
  output_dir: string
  started_at: string | null
  completed_at: string | null
  error_message: string | null
  variables: Record<string, string> | null
  created_at: string
  // Phase 15: Pipeline-level cleanup state (REQ-27)
  pipelineCleanupState?: CleanupState | null
  // Phase 15: Tier level for tier indicator (REQ-28)
  tier?: number
  // Phase 15: Amendment budget tracking (REQ-19)
  amendmentBudget?: AmendmentBudgetStatus | null
  // Phase 15: Pending amendment details (REQ-19)
  pendingAmendment?: AmendmentDetail | null
}

// ST-001-05: Per-step execution state (JSON within workflow_runs.steps_state)
export type StepRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'queued' | 'cancelled' | 'partial' | 'waiting_signal' | 'signal_received' | 'signal_timeout' | 'signal_error' | 'signal_resolved' | 'paused_amendment' | 'paused_escalated' | 'paused_human' | 'paused_starvation' | 'paused_exploration' | 'invalidated'

export interface StepRunState {
  name: string
  type: WorkflowStepType
  status: StepRunStatus
  taskId: string | null
  startedAt: string | null
  completedAt: string | null
  errorMessage: string | null
  retryCount: number
  skippedReason: string | null
  resultFile: string | null
  resultCollected: boolean
  resultContent: string | null
  tier_min?: number
  tier_max?: number
  // Phase 5: DAG engine fields
  poolSlotId?: string | null
  parentGroup?: string | null
  depends_on?: string[]
  // P1-2: Per-work-unit container flag
  isPerWorkUnitContainer?: boolean
  // Phase 5: Termination state machine (M-02)
  terminationPhase?: 'signal_sent' | 'waiting_grace1' | 'sigterm_sent' | 'waiting_grace2' | 'killed' | null
  terminationStartedAt?: string | null
  // REQ-40: Review loop tracking
  reviewIteration?: number
  reviewSubStep?: 'producer' | 'reviewer' | 'between' | null
  reviewVerdict?: string | null
  completedWithWarning?: boolean
  reviewFeedback?: string | null
  concernWaitingSince?: string | null
  concernResolution?: 'accept' | 'reject' | null
  reviewerQueuedAt?: string | null
  producerQueuedAt?: string | null  // P1-12: starvation detection for producer slot
  needsReviewerSlot?: boolean
  currentIterationId?: string | null
  // Phase 7: Signal-checkpoint protocol state
  signalProtocol?: boolean
  signalDir?: string | null
  signalTimeoutSeconds?: number | null
  verifiedCompletion?: boolean
  lastSignalType?: string | null
  // BUG-1b fix: deferred signal archive path for review loop waiting_signal → running transition
  pendingSignalArchivePath?: string
  // Phase 8: Crash recovery flag
  crashRecoveryChecked?: boolean
  // Phase 10: Amendment tracking
  amendmentPhase?: 'detected' | 'budget_checked' | 'handler_running' | 'handler_complete' | 'awaiting_human' | null
  amendmentHandlerTaskId?: string | null
  amendmentHandlerStartedAt?: string | null  // P1-33: handler spawn time for timeout calculation
  amendmentSignalFile?: string | null
  amendmentSignalId?: string | null
  amendmentRetryCount?: number
  amendmentType?: string | null
  amendmentCategory?: string | null
  amendmentSpecSection?: string | null
  invalidationCount?: number
  // P-8: Batch reconciliation tracking
  batchAmendmentCount?: number
  // Phase 15: Cleanup state (REQ-26)
  cleanupState?: CleanupState | null
  // Phase 15: Child steps for parallel_group rendering
  childSteps?: StepRunState[]
  // Phase 15: Review iteration history for review_loop display
  reviewIterations?: ReviewIteration[]
  // Phase 15: Detected signals for monitoring view
  detectedSignals?: DetectedSignal[]
}

// Amendment record type (Phase 10)
export interface AmendmentRecord {
  id: string
  run_id: string
  step_name: string
  work_unit: string | null
  signal_file: string
  amendment_type: string
  category: string
  spec_section: string
  issue: string
  proposed_change: string | null
  resolution: string | null
  resolved_by: string | null
  resolved_at: string | null
  created_at: string
  proposed_by: string | null
  proposal_timestamp: number | null
  approval_timestamp: number | null
  rationale: string | null
  target: string | null
}

// Chat history types
export interface HistorySession {
  id: string
  projectPath: string
  projectName: string
  agentType: 'claude' | 'codex'
  lastModified: string
  sessionType: 'original' | 'trimmed' | 'rollover' | 'sub-agent' | 'unknown'
  messageCount: number
  firstMessage?: string
  matchSnippet?: string
}

// Phase 23: Per-Work-Unit types
export interface WorkUnit {
  id: string
  scope: string
  files: string[]
  tags?: string[]
  estimated_complexity?: string
  depends_on?: string[]
  interface_dependencies?: string[]
}

export interface WorkUnitManifest {
  version: string
  work_units: WorkUnit[]
}

// Phase 23: Per-work-unit expansion state (stored in StepRunState)
export interface PerWorkUnitState {
  work_unit_id: string
  substep_index: number
  substep_status: 'pending' | 'running' | 'completed' | 'failed'
  started_at?: string
  completed_at?: string
  error_message?: string
}

// ── Phase 25: Model Routing & Review Integration Types ───────────────────────

export type ComplexityLevel = 'simple' | 'medium' | 'complex' | 'atomic'

export interface ComplexityClassification {
  complexity: ComplexityLevel
  confidence: number
  reason?: string
}

export interface ModelRoutingConfig {
  enabled: boolean
  default_model: string
  complexity_routing: {
    simple: string
    medium: string
    complex: string
    atomic: string
  }
  escalation?: Array<{
    from: string
    to: string
    condition: string
  }>
}

export interface ReviewRoutingConfig {
  enabled?: boolean
  l1_model?: string
  l2_model?: string
  complexity_routing?: Record<ComplexityLevel, 'l1' | 'l2' | 'both'>
}

export interface DraftSwarmConfig {
  enabled: boolean
  models: string[]
  trigger_complexity: ComplexityLevel[]
  min_tier: number
  max_concurrent?: number
  timeout_ms?: number
  rate_limit_per_minute?: number
}

export interface TestContext {
  runner: string
  import_style: string
  file_pattern: string
  constraints: string[]
  mock_patterns: string[]
  reference_tests: string[]
}

export interface ContextBriefingConfig {
  consumer_profile: 'planner' | 'reviewer' | 'implementor'
  token_budget: number
  sources: string[]
  include_related_wos?: boolean
  max_files_per_source?: number
}

// Phase 25: Extended WorkUnit with complexity
export interface WorkUnitWithComplexity extends WorkUnit {
  complexity?: ComplexityLevel
  complexity_confidence?: number
  model_assigned?: string
}

// ─── Cron Manager Types (WU-001) ─────────────────────────────────────────────

export type JobSource = 'user-crontab' | 'system-crontab' | 'user-systemd' | 'systemd-system'
export type JobStatus = 'active' | 'paused' | 'error' | 'unknown'
export type HealthStatus = 'healthy' | 'warning' | 'critical' | 'unknown'

/**
 * CronJob — flat view of a discovered scheduled job.
 * ID is a deterministic hash of source+name+command (NOT schedule).
 * @see CronManager.generateJobId
 */
export interface CronJob {
  id: string
  name: string
  source: JobSource
  schedule: string
  scheduleHuman: string
  command: string
  scriptPath: string | null
  projectGroup: string
  status: JobStatus
  health: HealthStatus
  healthReason: string | null
  lastRun: string | null
  lastRunDuration: number | null
  nextRun: string | null
  lastExitCode: number | null
  consecutiveFailures: number
  avgDuration: number | null
  user: string | null
  /** true for system-crontab and systemd-system sources */
  requiresSudo: boolean
  avatarUrl: string | null
  unitFile: string | null
  description: string | null
  tags: string[]
  isManagedByAgentboard: boolean
  linkedSessionId: string | null
}

/** Extended job detail including script content and run history */
export interface CronJobDetail extends CronJob {
  scriptContent: string | null
  scriptLanguage: string | null
  timerConfig: string | null
  serviceConfig: string | null
  crontabLine: string | null
  runHistory: JobRunRecord[]
  recentLogs: string[]
}

/** A single job run record (manual or scheduled) */
export interface JobRunRecord {
  timestamp: string
  endTimestamp: string | null
  duration: number | null
  exitCode: number | null
  trigger: 'manual' | 'scheduled'
  logSnippet: string | null
}

/** Config for creating a quick cron job */
export interface CronCreateConfig {
  command: string
  schedule: string
  comment: string
  tags: string[]
}

/** Config for creating a systemd timer */
export interface SystemdCreateConfig {
  serviceName: string
  command: string
  schedule: string
  description: string
  workingDirectory: string
  scope: 'user' | 'system'
  tags: string[]
}

/** Progress for bulk operations */
export interface BulkProgress {
  completed: number
  total: number
  failures: string[]
}

// ─── Cron AI Orchestrator Types (WU-001) ─────────────────────────────────────

export type CronAiProposalOperation =
  | 'create'
  | 'edit_frequency'
  | 'pause'
  | 'resume'
  | 'delete'
  | 'run_now'
  | 'set_tags'
  | 'link_session'

export interface CronAiProposal {
  id: string
  operation: CronAiProposalOperation
  jobId: string | null
  jobName: string | null
  jobAvatarUrl: string | null
  description: string
  diff: string
  status: 'pending' | 'accepted' | 'rejected' | 'expired'
  feedback: string | null
  createdAt: string
  resolvedAt: string | null
}

export interface UiContext {
  selectedJobId: string | null
  selectedJobDetail: CronJobDetail | null
  activeTab: string
  visibleJobCount: number
  filterState: { mode: string; source: string | null; tags: string[] }
  healthSummary: { healthy: number; warning: number; critical: number }
}

export interface ProposalResult {
  success: boolean
  result?: unknown
  rejected?: boolean
  expired?: boolean
  feedback?: string
  error?: string
}

export interface ScheduleConflict {
  jobIds: string[]
  schedule: string
  description: string
}

export interface ScheduleLoadAnalysis {
  hourlyLoad: Record<number, number>
  peakHours: number[]
  recommendations: string[]
}

export interface DurationTrendData {
  jobId: string
  durations: number[]
  average: number
  trend: string
}

/**
 * Response shape for GET /api/health endpoint
 */
export interface HealthResponse {
  status: 'ok'
  uptime: number
  timestamp: string
  tmux: boolean
}
