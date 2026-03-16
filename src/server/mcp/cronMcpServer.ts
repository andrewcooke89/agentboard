// WU-005/006/007/008: Cron MCP Server
// Standalone MCP server process using stdio transport.
// Provides 14 read tools, 1 write tool (propose_change), 4 navigation tools,
// 2 MCP resources, and WebSocket connectivity to agentboard.

// ─── Env Config ──────────────────────────────────────────────────────────────

const _AGENTBOARD_URL = process.env.AGENTBOARD_URL || 'http://localhost:4040'
const AGENTBOARD_WS = process.env.AGENTBOARD_WS || 'ws://localhost:4040/ws'
const AGENTBOARD_AUTH_TOKEN = process.env.AGENTBOARD_AUTH_TOKEN || ''

// ─── Types ───────────────────────────────────────────────────────────────────

import type {
  CronJob,
  CronJobDetail,
  JobRunRecord,
  UiContext,
  ProposalResult,
  ScheduleConflict,
  ScheduleLoadAnalysis,
  DurationTrendData,
  CronAiProposalOperation,
  Session,
} from '@shared/types'

interface HttpClientOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  retries?: number
}

// ─── HTTP Client ─────────────────────────────────────────────────────────────

/**
 * HTTP client for communicating with agentboard /api/cron-ai/* endpoints.
 * Includes auth header and 3-retry logic with structured error on failure.
 */
async function fetchFromAgentboard<T>(path: string, options?: HttpClientOptions): Promise<T> {
  const baseUrl = process.env.AGENTBOARD_URL || 'http://localhost:4040'
  const token = process.env.AGENTBOARD_AUTH_TOKEN || ''
  const method = options?.method ?? 'GET'
  const maxAttempts = options?.retries ?? 3

  const headers: Record<string, string> = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  if (options?.body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  const init: RequestInit = { method, headers }
  if (options?.body !== undefined) {
    init.body = JSON.stringify(options.body)
  }

  const url = `${baseUrl}${path}`

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, init)

      // 4xx client errors — don't retry
      if (response.status >= 400 && response.status < 500) {
        return { error: `agentboard server unavailable (HTTP ${response.status})` } as T
      }

      // 5xx server errors — retry if attempts remain
      if (response.status >= 500) {
        if (attempt < maxAttempts) continue
        return { error: `agentboard server unavailable (HTTP ${response.status})` } as T
      }

      // Success — parse JSON
      try {
        return (await response.json()) as T
      } catch {
        return { error: 'agentboard server unavailable (invalid JSON response)' } as T
      }
    } catch {
      // Network error — retry if attempts remain
      if (attempt >= maxAttempts) {
        return { error: 'agentboard server unavailable' } as T
      }
    }
  }

  return { error: 'agentboard server unavailable' } as T
}

// ─── MCP Server Setup ────────────────────────────────────────────────────────

/** MCP JSON-RPC message shape */
interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string | null
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** Write a single JSON-RPC response to stdout */
function writeResponse(resp: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(resp) + '\n')
}

/** Dispatch a tools/call to the correct exported function */
async function dispatchTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'list_jobs':
      return listJobs()
    case 'list_jobs_by_group':
      return listJobsByGroup(args.group as string)
    case 'search_jobs':
      return searchJobs(args.query as string)
    case 'get_job_detail':
      return getJobDetail(args.jobId as string)
    case 'get_run_history':
      return getRunHistory(args.jobId as string, args.limit as number | undefined)
    case 'get_job_logs':
      return getJobLogs(args.jobId as string, args.lines as number | undefined)
    case 'get_log_snippet':
      return getLogSnippet(args.jobId as string, args.runTimestamp as string)
    case 'get_health_summary':
      return getHealthSummary()
    case 'get_failing_jobs':
      return getFailingJobs()
    case 'get_schedule_conflicts':
      return getScheduleConflicts()
    case 'get_duration_trends':
      return getDurationTrends(args.jobId as string)
    case 'analyze_schedule_load':
      return analyzeScheduleLoad()
    case 'get_ui_context':
      return getUiContext()
    case 'get_available_sessions':
      return getAvailableSessions()
    case 'propose_change':
      return proposeChange({
        operation: args.operation as CronAiProposalOperation,
        jobId: args.jobId as string | null | undefined,
        description: args.description as string,
        details: args.details as Record<string, unknown> | undefined,
      })
    case 'select_job':
      return selectJob(args.jobId as string)
    case 'navigate_to_tab':
      return navigateToTab(args.tab as 'overview' | 'history' | 'logs' | 'script')
    case 'show_timeline':
      return showTimeline()
    case 'filter_jobs':
      return filterJobs(args.filter as Record<string, unknown>)
    default:
      throw { code: -32601, message: `Unknown tool: ${name}` }
  }
}

/**
 * Initialize MCP server with stdio transport.
 * Implements JSON-RPC 2.0 over stdin/stdout (line-delimited).
 * Handles: initialize, tools/list, tools/call, resources/list, resources/read.
 */
async function createMcpServer(): Promise<void> {
  // Buffer for partial lines from stdin
  let inputBuffer = ''

  async function handleRequest(req: JsonRpcRequest): Promise<void> {
    const { id, method, params = {} } = req

    try {
      switch (method) {
        case 'initialize': {
          writeResponse({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {}, resources: {} },
              serverInfo: { name: 'cron-mcp', version: '1.0.0' },
            },
          })
          break
        }

        case 'initialized': {
          // Notification — no response needed
          break
        }

        case 'tools/list': {
          const tools = Object.values(toolRegistry).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          }))
          writeResponse({ jsonrpc: '2.0', id, result: { tools } })
          break
        }

        case 'tools/call': {
          const toolName = params.name as string
          const toolArgs = (params.arguments as Record<string, unknown>) ?? {}
          let toolResult: unknown
          try {
            toolResult = await dispatchTool(toolName, toolArgs)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            writeResponse({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: `Error: ${msg}` }],
                isError: true,
              },
            })
            break
          }
          writeResponse({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }],
            },
          })
          break
        }

        case 'resources/list': {
          writeResponse({
            jsonrpc: '2.0',
            id,
            result: {
              resources: [
                {
                  uri: 'cron://ui/context',
                  name: 'UI Context',
                  description: 'Current UI context snapshot including selected job and active tab.',
                  mimeType: 'application/json',
                },
                {
                  uri: 'cron://skill/guidelines',
                  name: 'Skill Guidelines',
                  description: 'Guidelines for using the Cron AI assistant.',
                  mimeType: 'text/markdown',
                },
              ],
            },
          })
          break
        }

        case 'resources/read': {
          const uri = params.uri as string
          if (uri === 'cron://ui/context') {
            const ctx = getContextResource()
            writeResponse({
              jsonrpc: '2.0',
              id,
              result: {
                contents: [
                  {
                    uri,
                    mimeType: 'application/json',
                    text: JSON.stringify(ctx, null, 2),
                  },
                ],
              },
            })
          } else if (uri === 'cron://skill/guidelines') {
            writeResponse({
              jsonrpc: '2.0',
              id,
              result: {
                contents: [
                  {
                    uri,
                    mimeType: 'text/markdown',
                    text: getSkillGuidelinesResource(),
                  },
                ],
              },
            })
          } else {
            writeResponse({
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: `Unknown resource URI: ${uri}` },
            })
          }
          break
        }

        default: {
          // Unknown method — only send error if this has an id (i.e., not a notification)
          if (id !== null && id !== undefined) {
            writeResponse({
              jsonrpc: '2.0',
              id,
              error: { code: -32601, message: `Method not found: ${method}` },
            })
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (id !== null && id !== undefined) {
        writeResponse({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: `Internal error: ${msg}` },
        })
      }
    }
  }

  // Read line-delimited JSON from stdin
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    inputBuffer += chunk
    const lines = inputBuffer.split('\n')
    // Keep the last (possibly incomplete) segment in the buffer
    inputBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let req: JsonRpcRequest
      try {
        req = JSON.parse(trimmed) as JsonRpcRequest
      } catch {
        writeResponse({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        })
        continue
      }
      // Fire-and-forget; errors handled inside
      handleRequest(req).catch((err) => {
        process.stderr.write(`[cron-mcp] Unhandled error: ${err}\n`)
      })
    }
  })

  process.stdin.on('end', () => {
    // Process any remaining buffered content
    const trimmed = inputBuffer.trim()
    if (trimmed) {
      try {
        const req = JSON.parse(trimmed) as JsonRpcRequest
        handleRequest(req).catch(() => {})
      } catch {
        // ignore parse errors at EOF
      }
    }
    process.exit(0)
  })
}

// ─── Tool Registry (for testing) ─────────────────────────────────────────────

interface ToolSchema {
  name: string
  description: string
  properties: Record<string, { type: string; description?: string; enum?: string[] }>
  required?: string[]
  inputSchema: {
    type: string
    properties: Record<string, { type: string; description?: string; enum?: string[] }>
    required?: string[]
  }
}

const toolRegistry: Record<string, ToolSchema> = {
  // ─── WU-005: Read Tools ────────────────────────────────────────────────────
  list_jobs: {
    name: 'list_jobs',
    description: 'List all cron jobs.',
    properties: {},
    inputSchema: { type: 'object', properties: {} },
  },
  list_jobs_by_group: {
    name: 'list_jobs_by_group',
    description: 'List cron jobs filtered by project group.',
    properties: { group: { type: 'string' } },
    required: ['group'],
    inputSchema: { type: 'object', properties: { group: { type: 'string' } }, required: ['group'] },
  },
  search_jobs: {
    name: 'search_jobs',
    description: 'Search cron jobs by name, command, or description.',
    properties: { query: { type: 'string' } },
    required: ['query'],
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  get_job_detail: {
    name: 'get_job_detail',
    description: 'Get detailed information about a specific cron job.',
    properties: { jobId: { type: 'string' } },
    required: ['jobId'],
    inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
  },
  get_run_history: {
    name: 'get_run_history',
    description: 'Get run history for a specific cron job.',
    properties: { jobId: { type: 'string' }, limit: { type: 'number' } },
    required: ['jobId'],
    inputSchema: { type: 'object', properties: { jobId: { type: 'string' }, limit: { type: 'number' } }, required: ['jobId'] },
  },
  get_job_logs: {
    name: 'get_job_logs',
    description: 'Get recent log output for a specific cron job.',
    properties: { jobId: { type: 'string' }, lines: { type: 'number' } },
    required: ['jobId'],
    inputSchema: { type: 'object', properties: { jobId: { type: 'string' }, lines: { type: 'number' } }, required: ['jobId'] },
  },
  get_log_snippet: {
    name: 'get_log_snippet',
    description: 'Get log output for a specific run of a cron job.',
    properties: { jobId: { type: 'string' }, runTimestamp: { type: 'string' } },
    required: ['jobId', 'runTimestamp'],
    inputSchema: { type: 'object', properties: { jobId: { type: 'string' }, runTimestamp: { type: 'string' } }, required: ['jobId', 'runTimestamp'] },
  },
  // ─── WU-006: Health & Analysis Tools ───────────────────────────────────────
  get_health_summary: {
    name: 'get_health_summary',
    description: 'Get health summary counts (healthy, warning, critical) across all cron jobs.',
    properties: {},
    inputSchema: { type: 'object', properties: {} },
  },
  get_failing_jobs: {
    name: 'get_failing_jobs',
    description: 'Get all cron jobs with warning or critical health status, including failure reasons.',
    properties: {},
    inputSchema: { type: 'object', properties: {} },
  },
  get_schedule_conflicts: {
    name: 'get_schedule_conflicts',
    description: 'Detect cron jobs with overlapping schedules that may cause resource contention.',
    properties: {},
    inputSchema: { type: 'object', properties: {} },
  },
  get_duration_trends: {
    name: 'get_duration_trends',
    description: 'Get duration trend analysis for a specific cron job, including average and trend direction.',
    properties: { jobId: { type: 'string', description: 'The ID of the cron job to analyze.' } },
    required: ['jobId'],
    inputSchema: { type: 'object', properties: { jobId: { type: 'string', description: 'The ID of the cron job to analyze.' } }, required: ['jobId'] },
  },
  analyze_schedule_load: {
    name: 'analyze_schedule_load',
    description: 'Analyze per-hour job density for the next 24 hours, identifying peak hours and recommendations.',
    properties: {},
    inputSchema: { type: 'object', properties: {} },
  },
  get_ui_context: {
    name: 'get_ui_context',
    description: 'Get the current UI context snapshot including selected job, active tab, and filter state.',
    properties: {},
    inputSchema: { type: 'object', properties: {} },
  },
  get_available_sessions: {
    name: 'get_available_sessions',
    description: 'Get all available agentboard sessions for session discovery and linking.',
    properties: {},
    inputSchema: { type: 'object', properties: {} },
  },
  // ─── WU-007: Write & Navigation Tools ───────────────────────────────────────
  propose_change: {
    name: 'propose_change',
    description: 'Propose a change to a cron job for user approval. Blocks until user accepts, rejects, or timeout expires.',
    properties: {
      operation: { type: 'string', description: 'The type of change to propose.' },
      jobId: { type: 'string', description: 'The ID of the job to modify (optional for create).' },
      description: { type: 'string', description: 'Human-readable description of the proposed change.' },
      details: { type: 'object', description: 'Additional details for the proposal.' },
    },
    required: ['operation', 'description'],
    inputSchema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['create', 'edit_frequency', 'pause', 'resume', 'delete', 'run_now', 'set_tags', 'link_session'],
        },
        jobId: { type: 'string' },
        description: { type: 'string' },
        details: { type: 'object' },
      },
      required: ['operation', 'description'],
    },
  },
  select_job: {
    name: 'select_job',
    description: 'Select a cron job in the UI job list.',
    properties: { jobId: { type: 'string', description: 'The ID of the job to select.' } },
    required: ['jobId'],
    inputSchema: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
  },
  navigate_to_tab: {
    name: 'navigate_to_tab',
    description: 'Switch the active tab in the cron job detail view.',
    properties: { tab: { type: 'string', description: 'The tab to switch to.', enum: ['overview', 'history', 'logs', 'script'] } },
    required: ['tab'],
    inputSchema: { type: 'object', properties: { tab: { type: 'string', enum: ['overview', 'history', 'logs', 'script'] } }, required: ['tab'] },
  },
  show_timeline: {
    name: 'show_timeline',
    description: 'Open the cron job timeline view.',
    properties: {},
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  filter_jobs: {
    name: 'filter_jobs',
    description: 'Apply a filter to the cron job list.',
    properties: { filter: { type: 'object', description: 'Filter criteria to apply.' } },
    required: ['filter'],
    inputSchema: { type: 'object', properties: { filter: { type: 'object' } }, required: ['filter'] },
  },
}

/** Returns the names of all registered MCP tools. */
function getRegisteredToolNames(): string[] {
  return Object.keys(toolRegistry)
}

/** Returns the JSON schema for a registered MCP tool by name. */
function getToolSchema(toolName: string): ToolSchema {
  const schema = toolRegistry[toolName]
  if (!schema) throw new Error(`Unknown tool: ${toolName}`)
  return schema
}

// ─── WU-005: Read Tools (7) ─────────────────────────────────────────────────

/** list_jobs(): GET /api/cron-ai/jobs → CronJob[] */
async function listJobs(): Promise<CronJob[]> {
  return fetchFromAgentboard<CronJob[]>('/api/cron-ai/jobs')
}

/** list_jobs_by_group(group): GET /api/cron-ai/jobs?group=:group → CronJob[] */
async function listJobsByGroup(group: string): Promise<CronJob[]> {
  return fetchFromAgentboard<CronJob[]>(`/api/cron-ai/jobs?group=${encodeURIComponent(group)}`)
}

/** search_jobs(query): GET /api/cron-ai/jobs/search?q=:query → CronJob[] */
async function searchJobs(query: string): Promise<CronJob[]> {
  return fetchFromAgentboard<CronJob[]>(`/api/cron-ai/jobs/search?q=${encodeURIComponent(query)}`)
}

/** get_job_detail(jobId): GET /api/cron-ai/jobs/:id → CronJobDetail */
async function getJobDetail(jobId: string): Promise<CronJobDetail> {
  return fetchFromAgentboard<CronJobDetail>(`/api/cron-ai/jobs/${encodeURIComponent(jobId)}`)
}

/** get_run_history(jobId, limit?): GET /api/cron-ai/jobs/:id/history?limit=:n → JobRunRecord[] */
async function getRunHistory(jobId: string, limit?: number): Promise<JobRunRecord[]> {
  const params = limit !== undefined ? `?limit=${limit}` : ''
  return fetchFromAgentboard<JobRunRecord[]>(`/api/cron-ai/jobs/${encodeURIComponent(jobId)}/history${params}`)
}

/** get_job_logs(jobId, lines?): GET /api/cron-ai/jobs/:id/logs?lines=:n → string[] */
async function getJobLogs(jobId: string, lines?: number): Promise<string[]> {
  const params = lines !== undefined ? `?lines=${lines}` : ''
  return fetchFromAgentboard<string[]>(`/api/cron-ai/jobs/${encodeURIComponent(jobId)}/logs${params}`)
}

/** get_log_snippet(jobId, runTimestamp): GET /api/cron-ai/jobs/:id/logs?run=:ts → string[] */
async function getLogSnippet(jobId: string, runTimestamp: string): Promise<string[]> {
  return fetchFromAgentboard<string[]>(`/api/cron-ai/jobs/${encodeURIComponent(jobId)}/logs?run=${encodeURIComponent(runTimestamp)}`)
}

// ─── WU-006: Health & Analysis Tools (7) ────────────────────────────────────

/** get_health_summary(): GET /api/cron-ai/health → {healthy, warning, critical} */
async function getHealthSummary(): Promise<{ healthy: number; warning: number; critical: number }> {
  return fetchFromAgentboard<{ healthy: number; warning: number; critical: number }>('/api/cron-ai/health')
}

/** get_failing_jobs(): GET /api/cron-ai/health/failing → CronJob[] */
async function getFailingJobs(): Promise<CronJob[]> {
  return fetchFromAgentboard<CronJob[]>('/api/cron-ai/health/failing')
}

/** get_schedule_conflicts(): GET /api/cron-ai/schedule/conflicts → ScheduleConflict[] */
async function getScheduleConflicts(): Promise<ScheduleConflict[]> {
  return fetchFromAgentboard<ScheduleConflict[]>('/api/cron-ai/schedule/conflicts')
}

/** get_duration_trends(jobId): GET /api/cron-ai/jobs/:id/duration-trends → DurationTrendData */
async function getDurationTrends(jobId: string): Promise<DurationTrendData> {
  return fetchFromAgentboard<DurationTrendData>(`/api/cron-ai/jobs/${encodeURIComponent(jobId)}/duration-trends`)
}

/** analyze_schedule_load(): GET /api/cron-ai/schedule/load → ScheduleLoadAnalysis */
async function analyzeScheduleLoad(): Promise<ScheduleLoadAnalysis> {
  return fetchFromAgentboard<ScheduleLoadAnalysis>('/api/cron-ai/schedule/load')
}

/** get_ui_context(): GET /api/cron-ai/context → UiContext */
async function getUiContext(): Promise<UiContext> {
  return fetchFromAgentboard<UiContext>('/api/cron-ai/context')
}

/** get_available_sessions(): GET /api/cron-ai/sessions → Session[] */
async function getAvailableSessions(): Promise<Session[]> {
  return fetchFromAgentboard<Session[]>('/api/cron-ai/sessions')
}

// ─── WU-007: Write & Navigation Tools (5) ───────────────────────────────────

/**
 * propose_change(proposal): POST /api/cron-ai/proposals
 * Blocks until user accepts/rejects or timeout expires (HTTP long-poll).
 */
async function proposeChange(proposal: {
  operation: CronAiProposalOperation
  jobId?: string | null
  description: string
  details?: Record<string, unknown>
}): Promise<ProposalResult> {
  const body: Record<string, unknown> = {
    operation: proposal.operation,
    description: proposal.description,
  }
  // Include jobId in body (null when not provided, preserving exact value when provided)
  if (proposal.jobId !== undefined) {
    body.jobId = proposal.jobId
  }
  if (proposal.details !== undefined) {
    body.details = proposal.details
  }

  const result = await fetchFromAgentboard<ProposalResult>('/api/cron-ai/proposals', {
    method: 'POST',
    body,
  })

  // Ensure error responses have success: false (fetchFromAgentboard returns {error} without success)
  if ((result as { error?: string }).error && result.success === undefined) {
    return { ...result, success: false }
  }

  return result
}

/** select_job(jobId): WS message {type: 'cron-ai-navigate', action: 'select_job', jobId} */
async function selectJob(jobId: string): Promise<{ success: boolean; error?: string }> {
  const sent = sendWsMessage({ type: 'cron-ai-navigate', action: 'select_job', payload: { jobId } })
  if (!sent) return { success: false, error: 'WebSocket not connected' }
  return { success: true }
}

/** navigate_to_tab(tab): WS message {type: 'cron-ai-navigate', action: 'switch_tab', tab} */
async function navigateToTab(tab: 'overview' | 'history' | 'logs' | 'script'): Promise<{ success: boolean; error?: string }> {
  const sent = sendWsMessage({ type: 'cron-ai-navigate', action: 'switch_tab', payload: { tab } })
  if (!sent) return { success: false, error: 'WebSocket not connected' }
  return { success: true }
}

/** show_timeline(): WS message {type: 'cron-ai-navigate', action: 'show_timeline'} */
async function showTimeline(): Promise<{ success: boolean; error?: string }> {
  const sent = sendWsMessage({ type: 'cron-ai-navigate', action: 'show_timeline', payload: {} })
  if (!sent) return { success: false, error: 'WebSocket not connected' }
  return { success: true }
}

/** filter_jobs(filter): WS message {type: 'cron-ai-navigate', action: 'filter', filter} */
async function filterJobs(filter: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  const sent = sendWsMessage({ type: 'cron-ai-navigate', action: 'filter', payload: { filter } })
  if (!sent) return { success: false, error: 'WebSocket not connected' }
  return { success: true }
}

// ─── WU-008: Resources ──────────────────────────────────────────────────────

/** Local context cache, updated via WS push from agentboard */
let localContextCache: UiContext | null = null
let contextStale = false

/**
 * cron://ui/context MCP resource
 * Returns latest UiContext (updated via WS push). Includes stale flag during disconnection.
 */
function getContextResource(): { context: UiContext | null; stale: boolean } {
  invalidateStaleWsState()
  return { context: localContextCache, stale: contextStale }
}

/** Static skill guidelines content for cron://skill/guidelines MCP resource */
const SKILL_GUIDELINES = `# Cron AI Skill Guidelines

## Overview
The Cron AI assistant helps manage cron jobs and systemd timers through the agentboard interface.

## Capabilities
- List and search cron jobs
- View job details, run history, and logs
- Analyze schedule conflicts and load distribution
- Monitor job health status
- Propose changes (create, edit, pause, resume, delete jobs)
- Navigate the UI (select jobs, switch tabs, apply filters)

## Proposal Flow
All mutations go through a propose-and-approve workflow:
1. Use propose_change to submit a proposal
2. The user reviews the proposal card in the UI
3. The proposal is accepted, rejected, or expires after timeout

## Guidelines
- Always check job health before proposing schedule changes
- Use get_ui_context to understand what the user is looking at
- Provide clear descriptions in proposals
- Check for schedule conflicts before proposing new schedules
- Use natural language for schedule descriptions
`

/**
 * cron://skill/guidelines MCP resource
 * Returns static skill file content.
 */
function getSkillGuidelinesResource(): string {
  return SKILL_GUIDELINES
}

// ─── WU-008: WebSocket Client ───────────────────────────────────────────────

let wsConnected = false
let wsReconnectDelay = 1000 // exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
const WS_MAX_RECONNECT_DELAY = 30_000
let wsSocket: WebSocket | null = null
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null
let wsConstructorRef: typeof WebSocket | null = null

/**
 * Detect when the WebSocket constructor has been replaced (e.g., test mock reset)
 * and invalidate stale module state. No-op in production where the constructor never changes.
 */
function invalidateStaleWsState(): void {
  if (wsConstructorRef !== null && wsConstructorRef !== globalThis.WebSocket) {
    localContextCache = null
    contextStale = false
    wsConnected = false
    wsSocket = null
    wsReconnectDelay = 1000
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null }
    wsConstructorRef = null
  }
}

/**
 * Connect to agentboard WS endpoint.
 * - Sends cron-ai-mcp-register handshake on connect
 * - Handles cron-ai-context-update and cron-ai-proposal-resolved messages
 * - Reconnects with exponential backoff on disconnect
 */
function connectWebSocket(): void {
  // Clear any pending reconnect timer
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null }
  // Reset stale state if environment changed (e.g., test mock replacement)
  invalidateStaleWsState()
  wsConstructorRef = globalThis.WebSocket

  const url = process.env.AGENTBOARD_WS || 'ws://localhost:4040/ws'
  const ws = new WebSocket(url)
  wsSocket = ws

  ws.onopen = () => {
    wsConnected = true
    wsReconnectDelay = 1000 // reset backoff on successful connect
    const token = process.env.AGENTBOARD_AUTH_TOKEN || ''
    const msg: Record<string, unknown> = { type: 'cron-ai-mcp-register' }
    if (token) msg.authToken = token
    ws.send(JSON.stringify(msg))
  }

  ws.onmessage = (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data)
      if (data.type === 'cron-ai-context-update' && data.context) {
        localContextCache = data.context
        contextStale = false
      }
      // cron-ai-proposal-resolved and unknown types: handled silently
    } catch {
      // malformed JSON — ignore
    }
  }

  ws.onclose = (event: CloseEvent) => {
    wsConnected = false
    wsSocket = null
    if (event.code !== 1000) {
      // Abnormal close — mark stale and reconnect with backoff
      contextStale = true
      const delay = wsReconnectDelay
      wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_MAX_RECONNECT_DELAY)
      // Capture constructor ref so stale timers from replaced environments abort
      const capturedRef = wsConstructorRef
      wsReconnectTimer = setTimeout(() => {
        if (globalThis.WebSocket !== capturedRef) {
          // Environment changed — reset stale state and abort reconnect
          localContextCache = null
          contextStale = false
          wsConnected = false
          wsSocket = null
          wsReconnectDelay = 1000
          wsConstructorRef = null
          wsReconnectTimer = null
          return
        }
        connectWebSocket()
      }, delay)
    }
  }

  ws.onerror = () => {
    // Errors are followed by onclose; no additional handling needed
  }
}

/** Send a message via the WS connection. Returns false if not connected. */
function sendWsMessage(message: Record<string, unknown>): boolean {
  invalidateStaleWsState()
  if (!wsConnected || !wsSocket) return false
  wsSocket.send(JSON.stringify(message))
  return true
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

/** Main entry: called when this file is run as a standalone process via `bun run` */
async function main(): Promise<void> {
  connectWebSocket()
  await createMcpServer()
}

// Only run if this is the main module
if (import.meta.main) {
  main().catch((err) => {
    console.error('[cron-mcp] Fatal error:', err)
    process.exit(1)
  })
}

// ─── Exports (for testing) ──────────────────────────────────────────────────

export {
  fetchFromAgentboard,
  createMcpServer,
  getRegisteredToolNames,
  getToolSchema,
  // WU-005: Read tools
  listJobs,
  listJobsByGroup,
  searchJobs,
  getJobDetail,
  getRunHistory,
  getJobLogs,
  getLogSnippet,
  // WU-006: Health & Analysis tools
  getHealthSummary,
  getFailingJobs,
  getScheduleConflicts,
  getDurationTrends,
  analyzeScheduleLoad,
  getUiContext,
  getAvailableSessions,
  // WU-007: Write & Navigation tools
  proposeChange,
  selectJob,
  navigateToTab,
  showTimeline,
  filterJobs,
  // WU-008: Resources & WS
  getContextResource,
  getSkillGuidelinesResource,
  connectWebSocket,
  sendWsMessage,
  main,
}
