import path from 'node:path'

const terminalModeRaw = process.env.TERMINAL_MODE
const terminalMode =
  terminalModeRaw === 'pty' ||
  terminalModeRaw === 'pipe-pane' ||
  terminalModeRaw === 'auto'
    ? terminalModeRaw
    : 'pty'

const homeDir = process.env.HOME || process.env.USERPROFILE || ''

const logPollIntervalMsRaw = Number(process.env.AGENTBOARD_LOG_POLL_MS)
const logPollIntervalMs = Number.isFinite(logPollIntervalMsRaw)
  ? logPollIntervalMsRaw
  : 5000
const logPollMaxRaw = Number(process.env.AGENTBOARD_LOG_POLL_MAX)
const logPollMax = Number.isFinite(logPollMaxRaw) ? logPollMaxRaw : 25
const rgThreadsRaw = Number(process.env.AGENTBOARD_RG_THREADS)
const rgThreads = Number.isFinite(rgThreadsRaw) && rgThreadsRaw > 0
  ? Math.floor(rgThreadsRaw)
  : 1
const logMatchWorkerRaw = process.env.AGENTBOARD_LOG_MATCH_WORKER
const logMatchWorker =
  logMatchWorkerRaw === 'false' || logMatchWorkerRaw === '0' ? false : true
const logMatchProfile =
  process.env.AGENTBOARD_LOG_MATCH_PROFILE === 'true' ||
  process.env.AGENTBOARD_LOG_MATCH_PROFILE === '1'

const enterRefreshDelayMsRaw = Number(process.env.AGENTBOARD_ENTER_REFRESH_MS)
const enterRefreshDelayMs = Number.isFinite(enterRefreshDelayMsRaw)
  ? enterRefreshDelayMsRaw
  : 1000

const workingGracePeriodMsRaw = Number(process.env.AGENTBOARD_WORKING_GRACE_MS)
const workingGracePeriodMs = Number.isFinite(workingGracePeriodMsRaw)
  ? workingGracePeriodMsRaw
  : 4000

// Max age for inactive sessions shown in UI (hours)
// Sessions older than this are not sent to frontend or processed for orphan rematch
const inactiveSessionMaxAgeHoursRaw = Number(process.env.AGENTBOARD_INACTIVE_MAX_AGE_HOURS)
const inactiveSessionMaxAgeHours = Number.isFinite(inactiveSessionMaxAgeHoursRaw)
  ? inactiveSessionMaxAgeHoursRaw
  : 24

// Exclude sessions from certain project directories (comma-separated paths)
// Sessions with projectPath starting with any of these will be filtered out
// Example: AGENTBOARD_EXCLUDE_PROJECTS="/,/tmp" to exclude root and /tmp sessions
const excludeProjects = (process.env.AGENTBOARD_EXCLUDE_PROJECTS || '')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean)

// Default patterns for sessions that should skip window matching when orphaned.
// These sessions are still tracked in the DB but won't trigger expensive
// ripgrep scans trying to match them to tmux windows.
// Special markers:
//   <codex-exec> - Codex sessions started via `codex exec` (headless)
// Path patterns support trailing * for prefix matching.
const defaultSkipMatchingPatterns = [
  '<codex-exec>',
  '/private/tmp/*',
  '/private/var/folders/*',
  '/var/folders/*',
  '/tmp/*',
]

// Allow override via env var (comma-separated). If set (even empty), replaces defaults.
// Set to empty string to disable skip matching entirely.
const skipMatchingPatternsRaw = process.env.AGENTBOARD_SKIP_MATCHING_PATTERNS
const skipMatchingPatterns = skipMatchingPatternsRaw !== undefined
  ? skipMatchingPatternsRaw.split(',').map((p) => p.trim()).filter(Boolean)
  : defaultSkipMatchingPatterns

// Logging config
const logLevelRaw = process.env.LOG_LEVEL?.toLowerCase()
const logLevel = ['debug', 'info', 'warn', 'error'].includes(logLevelRaw || '')
  ? (logLevelRaw as 'debug' | 'info' | 'warn' | 'error')
  : 'info'
const defaultLogFile = path.join(homeDir, '.agentboard', 'agentboard.log')
const logFile = process.env.LOG_FILE ?? defaultLogFile

// Authentication token for remote access (static bearer token)
// If not set, auth is disabled (dev mode - no auth required)
const authToken = process.env.AUTH_TOKEN || ''

// Comma-separated list of allowed filesystem roots for the directory browser
// If not set, no restrictions (dev mode)
const allowedRoots = (process.env.ALLOWED_ROOTS || '')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => path.resolve(p))

// Task queue configuration
const taskMaxConcurrentRaw = Number(process.env.TASK_MAX_CONCURRENT)
const taskMaxConcurrent = Number.isFinite(taskMaxConcurrentRaw) && taskMaxConcurrentRaw > 0
  ? Math.floor(taskMaxConcurrentRaw)
  : 5
const taskPollIntervalMsRaw = Number(process.env.TASK_POLL_INTERVAL_MS)
const taskPollIntervalMs = Number.isFinite(taskPollIntervalMsRaw) && taskPollIntervalMsRaw > 0
  ? taskPollIntervalMsRaw
  : 5000
const cronPollIntervalMsRaw = Number(process.env.CRON_POLL_INTERVAL_MS)
const cronPollIntervalMs = Number.isFinite(cronPollIntervalMsRaw) && cronPollIntervalMsRaw > 0
  ? cronPollIntervalMsRaw
  : 5000
const taskDefaultTimeoutSecondsRaw = Number(process.env.TASK_DEFAULT_TIMEOUT_SECONDS)
const taskDefaultTimeoutSeconds = Number.isFinite(taskDefaultTimeoutSecondsRaw) && taskDefaultTimeoutSecondsRaw > 0
  ? taskDefaultTimeoutSecondsRaw
  : 1800
const taskRateLimitPerHourRaw = Number(process.env.TASK_RATE_LIMIT_PER_HOUR)
const taskRateLimitPerHour = Number.isFinite(taskRateLimitPerHourRaw) && taskRateLimitPerHourRaw > 0
  ? Math.floor(taskRateLimitPerHourRaw)
  : 1000
const taskOutputDir = process.env.TASK_OUTPUT_DIR || path.join(homeDir, '.agentboard', 'task-outputs')

const claudeConfigDir =
  process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude')
const codexHomeDir =
  process.env.CODEX_HOME || path.join(homeDir, '.codex')
const modelEnvsPath = process.env.MODEL_ENVS_PATH
  || path.join(homeDir, '.workflow', 'model-envs.json')

// History configuration
const historyEnabledRaw = process.env.AGENTBOARD_HISTORY_ENABLED
const historyEnabled = historyEnabledRaw === 'false' || historyEnabledRaw === '0' ? false : true
const historyMaxFilesRaw = Number(process.env.HISTORY_MAX_FILES)
const historyMaxFiles = Number.isFinite(historyMaxFilesRaw) && historyMaxFilesRaw > 0
  ? Math.floor(historyMaxFilesRaw) : 20000
const historyMaxResultsRaw = Number(process.env.HISTORY_MAX_RESULTS)
const historyMaxResults = Number.isFinite(historyMaxResultsRaw) && historyMaxResultsRaw > 0
  ? Math.floor(historyMaxResultsRaw) : 200
const historyReadMaxBytesRaw = Number(process.env.HISTORY_READ_MAX_BYTES)
const historyReadMaxBytes = Number.isFinite(historyReadMaxBytesRaw) && historyReadMaxBytesRaw > 0
  ? Math.floor(historyReadMaxBytesRaw) : 65536
const historyReadMaxLinesRaw = Number(process.env.HISTORY_READ_MAX_LINES)
const historyReadMaxLines = Number.isFinite(historyReadMaxLinesRaw) && historyReadMaxLinesRaw > 0
  ? Math.floor(historyReadMaxLinesRaw) : 200
const historyCountsTtlMsRaw = Number(process.env.HISTORY_COUNTS_TTL_MS)
const historyCountsTtlMs = Number.isFinite(historyCountsTtlMsRaw) && historyCountsTtlMsRaw > 0
  ? historyCountsTtlMsRaw : 60000
const historyResumeTimeoutMsRaw = Number(process.env.HISTORY_RESUME_TIMEOUT_MS)
const historyResumeTimeoutMs = Number.isFinite(historyResumeTimeoutMsRaw) && historyResumeTimeoutMsRaw > 0
  ? historyResumeTimeoutMsRaw : 2000

// Workflow engine configuration
const workflowEngineEnabledRaw = process.env.WORKFLOW_ENGINE_ENABLED
const workflowEngineEnabled = workflowEngineEnabledRaw === 'false' || workflowEngineEnabledRaw === '0' ? false : true
const workflowDir = process.env.WORKFLOW_DIR || path.join(homeDir, '.agentboard', 'workflows')
const workflowMaxConcurrentRunsRaw = Number(process.env.WORKFLOW_MAX_CONCURRENT_RUNS)
const workflowMaxConcurrentRuns = Number.isFinite(workflowMaxConcurrentRunsRaw) && workflowMaxConcurrentRunsRaw > 0
  ? Math.floor(workflowMaxConcurrentRunsRaw)
  : 20
const workflowRunRetentionDaysRaw = Number(process.env.WORKFLOW_RUN_RETENTION_DAYS)
const workflowRunRetentionDays = Number.isFinite(workflowRunRetentionDaysRaw) && workflowRunRetentionDaysRaw > 0
  ? Math.floor(workflowRunRetentionDaysRaw)
  : 30
const workflowPollIntervalMsRaw = Number(process.env.WORKFLOW_POLL_INTERVAL_MS)
const workflowPollIntervalMs = Number.isFinite(workflowPollIntervalMsRaw) && workflowPollIntervalMsRaw > 0
  ? workflowPollIntervalMsRaw
  : 2000

// Session retention configuration
const sessionRetentionDaysRaw = Number(process.env.AGENTBOARD_SESSION_RETENTION_DAYS)
const sessionRetentionDays = Number.isFinite(sessionRetentionDaysRaw) && sessionRetentionDaysRaw > 0
  ? Math.floor(sessionRetentionDaysRaw)
  : 30

// Gemini API configuration (Phase 22)
export const GEMINI_API_KEY = process.env.AGENTBOARD_GEMINI_API_KEY || process.env.GEMINI_API_KEY || ''
export const GEMINI_RATE_LIMIT_TOKENS_PER_MINUTE = parseInt(process.env.AGENTBOARD_GEMINI_RATE_LIMIT || '60000', 10)

// Review router model defaults (Phase 21)
// LOW-001: Moved hardcoded model defaults from reviewRouter.ts to config
export const DEFAULT_L1_MODEL = process.env.AGENTBOARD_L1_MODEL || 'glm'
export const DEFAULT_L2_MODEL = process.env.AGENTBOARD_L2_MODEL || 'claude'

export const config = {
  port: Number(process.env.PORT) || 4040,
  hostname: process.env.HOSTNAME || '0.0.0.0',
  tmuxSession: process.env.TMUX_SESSION || 'agentboard',
  refreshIntervalMs: Number(process.env.REFRESH_INTERVAL_MS) || 2000,
  discoverPrefixes: (process.env.DISCOVER_PREFIXES || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  pruneWsSessions: process.env.PRUNE_WS_SESSIONS !== 'false',
  terminalMode,
  terminalMonitorTargets: process.env.TERMINAL_MONITOR_TARGETS !== 'false',
  // Allow killing external (discovered) sessions from UI
  allowKillExternal: process.env.ALLOW_KILL_EXTERNAL === 'true',
  // TLS config - set both to enable HTTPS
  tlsCert: process.env.TLS_CERT || '',
  tlsKey: process.env.TLS_KEY || '',
  logPollIntervalMs,
  logPollMax,
  rgThreads,
  logMatchWorker,
  logMatchProfile,
  claudeConfigDir,
  codexHomeDir,
  modelEnvsPath,
  claudeResumeCmd: process.env.CLAUDE_RESUME_CMD || 'claude --resume {sessionId}',
  codexResumeCmd: process.env.CODEX_RESUME_CMD || 'codex resume {sessionId}',
  enterRefreshDelayMs,
  workingGracePeriodMs,
  inactiveSessionMaxAgeHours,
  excludeProjects,
  skipMatchingPatterns,
  logLevel,
  logFile,
  authToken,
  allowedRoots,
  taskMaxConcurrent,
  taskPollIntervalMs,
  cronPollIntervalMs,
  taskDefaultTimeoutSeconds,
  taskRateLimitPerHour,
  taskOutputDir,
  historyEnabled,
  historyMaxFiles,
  historyMaxResults,
  historyReadMaxBytes,
  historyReadMaxLines,
  historyCountsTtlMs,
  historyResumeTimeoutMs,
  // Workflow engine
  workflowEngineEnabled,
  workflowDir,
  workflowMaxConcurrentRuns,
  workflowPollIntervalMs,
  workflowRunRetentionDays,
  // Session retention
  sessionRetentionDays,
}
