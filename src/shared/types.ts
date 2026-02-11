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
  | { type: 'workflow-run'; workflowId: string }
  | { type: 'workflow-run-resume'; runId: string }
  | { type: 'workflow-run-cancel'; runId: string }

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
export type SendClientMessage = (message: ClientMessage) => void
export type SubscribeServerMessage = (listener: (message: ServerMessage) => void) => () => void

// ─── Workflow Engine Types (WO-001) ─────────────────────────────────────────

// ST-001-01: Step type and workflow status enums
export type WorkflowStepType = 'spawn_session' | 'check_file' | 'delay' | 'check_output' | 'native_step'

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

// ST-001-03: Workflow step definition (maps to YAML step schema)
export interface WorkflowStep {
  name: string
  type: WorkflowStepType
  condition?: StepCondition
  // spawn_session fields
  projectPath?: string
  prompt?: string
  agentType?: 'claude' | 'codex'
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
  // tier fields (all step types)
  tier_min?: number
  tier_max?: number
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
}

// ST-001-05: Per-step execution state (JSON within workflow_runs.steps_state)
export type StepRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

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
