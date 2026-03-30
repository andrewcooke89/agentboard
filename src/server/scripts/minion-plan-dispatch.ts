/**
 * minion-plan-dispatch.ts -- Standalone bun script that takes a ticket, creates a
 * Claude planning task (via agentboard API), and monitors the resulting swarm dispatch.
 *
 * Flow:
 *   1. Load ticket from FileStorage
 *   2. Build planner prompt (WO YAML format + dispatch instructions)
 *   3. Create agentboard task (POST /api/tasks) — Claude runs as planning agent
 *   4. Poll task until complete, extract DISPATCH_ID from output
 *   5. Poll dispatch until complete (GET /api/wo/dispatch/:id)
 *   6. Resolve or requeue ticket based on result
 *
 * Usage:
 *   bun run src/server/scripts/minion-plan-dispatch.ts \
 *     --ticket-id TKT-xxxx \
 *     --project /path/to/project \
 *     --api-url http://localhost:4040
 */

import os from 'node:os'
import path from 'node:path'
import { FileStorage } from '/home/andrew-cooke/tools/mcp-servers/ticket-system/src/storage/file-storage'
import type { Ticket } from '/home/andrew-cooke/tools/mcp-servers/ticket-system/src/storage/schemas'

// ─── Types ───────────────────────────────────────────────────────────────────

interface CliArgs {
  ticketId: string
  project: string
  apiUrl: string
  model: string
}

interface TaskStatus {
  status: string
  exitCode?: number | null
  outputPath?: string | null
}

interface DispatchStatus {
  status: string
  result?: Record<string, unknown>
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`[plan-dispatch] ${new Date().toISOString()} ${msg}`)
}

// ─── CLI Parsing ─────────────────────────────────────────────────────────────

function parseArgs(): CliArgs {
  const args = process.argv.slice(2)
  let ticketId = ''
  let project = ''
  let apiUrl = ''
  let model = 'glm-5.1'

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--ticket-id') { ticketId = args[++i]; continue }
    if (arg === '--project') { project = args[++i]; continue }
    if (arg === '--api-url') { apiUrl = args[++i]; continue }
    if (arg === '--model') { model = args[++i]; continue }
  }

  const missing: string[] = []
  if (!ticketId) missing.push('--ticket-id')
  if (!project) missing.push('--project')
  if (!apiUrl) missing.push('--api-url')

  if (missing.length > 0) {
    console.error(`[plan-dispatch] ERROR: Missing required args: ${missing.join(', ')}`)
    process.exit(1)
  }

  return { ticketId, project, apiUrl, model }
}

// ─── Agentboard API Helpers ──────────────────────────────────────────────────

async function createTask(
  apiUrl: string,
  projectPath: string,
  prompt: string,
  model: string,
  timeoutSeconds: number,
): Promise<string> {
  const res = await fetch(`${apiUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath, prompt, timeoutSeconds, metadata: { model } }),
  })
  if (!res.ok) throw new Error(`Failed to create task: ${res.status} ${await res.text()}`)
  const data = (await res.json()) as { id: string }
  return data.id
}

async function pollTask(
  apiUrl: string,
  taskId: string,
  intervalMs: number,
  timeoutMs: number,
): Promise<{ status: string; output?: string }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    let task: TaskStatus
    try {
      const res = await fetch(`${apiUrl}/api/tasks/${taskId}`)
      if (!res.ok) { await Bun.sleep(intervalMs); continue }
      task = (await res.json()) as TaskStatus
    } catch {
      await Bun.sleep(intervalMs)
      continue
    }

    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      let output: string | undefined
      if (task.status === 'completed') {
        output = await fetchTaskOutput(apiUrl, taskId, task.outputPath ?? null)
      }
      return { status: task.status, output }
    }

    await Bun.sleep(intervalMs)
  }

  return { status: 'timeout' }
}

async function pollDispatch(
  apiUrl: string,
  dispatchId: string,
  intervalMs: number,
  timeoutMs: number,
): Promise<{ status: string; result?: Record<string, unknown> }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    let dispatch: DispatchStatus
    try {
      const res = await fetch(`${apiUrl}/api/wo/dispatch/${dispatchId}`)
      if (!res.ok) { await Bun.sleep(intervalMs); continue }
      dispatch = (await res.json()) as DispatchStatus
    } catch {
      await Bun.sleep(intervalMs)
      continue
    }

    if (['completed', 'failed'].includes(dispatch.status)) {
      return { status: dispatch.status, result: dispatch.result }
    }

    await Bun.sleep(intervalMs)
  }

  return { status: 'timeout' }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchTaskOutput(
  apiUrl: string,
  taskId: string,
  outputPath: string | null,
): Promise<string | undefined> {
  try {
    const outRes = await fetch(`${apiUrl}/api/tasks/${taskId}/output`)
    if (outRes.ok) {
      const json = (await outRes.json()) as { output?: string }
      return json.output
    }
    if (outputPath) {
      const f = Bun.file(outputPath)
      return await f.text()
    }
  } catch (err) {
    log(`WARN: Failed to read task output: ${err}`)
  }
  return undefined
}

function formatDate(): string {
  return new Date().toISOString().slice(0, 10)
}

function extractDispatchId(output: string): string | null {
  const match = output.match(/DISPATCH_ID=([^\s\n]+)/)
  return match ? match[1] : null
}

function extractDispatchFailed(output: string): string | null {
  const match = output.match(/DISPATCH_FAILED=(.+)/)
  return match ? match[1].trim() : null
}

// ─── Planner Prompt ──────────────────────────────────────────────────────────

function buildPlannerPrompt(
  ticket: Ticket,
  groupId: string,
  apiUrl: string,
  projectPath: string,
  model: string = 'glm-5.1',
): string {
  const src = ticket.source
  return `You are a planning agent. Analyze this ticket and dispatch work orders to fix it via the swarm system.

## Ticket
- **ID**: ${ticket.id}
- **Title**: ${ticket.title}
- **Description**: ${ticket.description}
- **File**: ${src?.file || 'unknown'}
- **Line**: ${src?.line_start || 'unknown'}
- **Code snippet**: \`\`\`
${src?.code_snippet || 'N/A'}
\`\`\`
- **Suggestion**: ${ticket.suggestion || 'N/A'}
- **Tags**: ${(ticket.tags || []).join(', ')}
- **Severity**: ${ticket.severity || 'unknown'}

## Your Task
1. Read the source file(s) related to this ticket to understand the issue
2. Determine which file(s) need to be modified to fix this issue
3. For each file that needs modification, create a Work Order YAML file
4. Dispatch the work orders as a swarm group

## Work Order Format
Each WO is a YAML file saved to ~/.agentboard/work-orders/${groupId}/.
Use this exact format for each WO file:

\`\`\`yaml
id: WO-${groupId}-001       # Sequential numbering
group_id: ${groupId}
title: "Short descriptive title of the fix for this specific file"
description: |
  Detailed description of what to change in this file.
  Include exact function names, line numbers, and code patterns.
  Be specific — the executor agent cannot read other files.
task: fix
scope: <directory containing the file>
input_files:
  - <path to the file being modified>
full_context_files:
  - <path to the file being modified>
depends_on: []               # Add dependencies between WOs if needed
gates:
  compile: true
  lint: true
  typecheck: true
  tests:
    run: false
execution:
  model: ${model}
  max_retries: 2
  timeout_minutes: 10
isolation:
  type: none
output:
  commit: true
  commit_prefix: "fix"
\`\`\`

## Rules
- Every WO modifies exactly ONE file
- Always use model: ${model} (never opus, never claude)
- Always set full_context_files to include the file being modified
- The WO description must be self-contained — include all context the agent needs
- If multiple files need changes, create multiple WOs with proper depends_on ordering
- Types/interfaces before implementations in the dependency chain

## Dispatch
After writing all WO YAML files, dispatch them:

\`\`\`bash
curl -s -X POST ${apiUrl}/api/wo/dispatch \\
  -H 'Content-Type: application/json' \\
  -d '{
    "group_id": "${groupId}",
    "working_dir": "${projectPath}",
    "concurrency": 4,
    "max_failures": 2
  }'
\`\`\`

## CRITICAL: Output
After dispatching, you MUST print this exact line so the parent script can monitor:
\`\`\`
DISPATCH_ID=<the dispatch_id from the response>
\`\`\`

If dispatch fails, print:
\`\`\`
DISPATCH_FAILED=<error message>
\`\`\`
`
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs()
  const { ticketId, project, apiUrl } = args

  log(`Starting — ticket=${ticketId} project=${project} api=${apiUrl}`)

  // ── 1. Load ticket ────────────────────────────────────────────────────────

  const storage = new FileStorage(project)
  const ticket = storage.getTicket(ticketId)
  if (!ticket) {
    log(`ERROR: Ticket ${ticketId} not found in ${project}`)
    process.exit(1)
  }

  log(`Loaded ticket: ${ticket.title} [${ticket.severity}]`)

  // ── 2. Generate group ID ──────────────────────────────────────────────────

  const groupId = `nightly-${ticketId}-${formatDate()}`
  log(`Group ID: ${groupId}`)

  // Ensure work-orders directory exists
  const woDir = path.join(os.homedir(), '.agentboard', 'work-orders', groupId)
  const { mkdirSync } = await import('node:fs')
  mkdirSync(woDir, { recursive: true })
  log(`WO directory: ${woDir}`)

  // ── 3. Build planner prompt ───────────────────────────────────────────────

  const prompt = buildPlannerPrompt(ticket, groupId, apiUrl, project, args.model)
  log(`Planner prompt built (${prompt.length} chars)`)

  // ── 4. Create agentboard task ─────────────────────────────────────────────

  let taskId: string
  try {
    taskId = await createTask(apiUrl, project, prompt, 'claude', 1800)
  } catch (err) {
    log(`ERROR: Task creation failed: ${err}`)
    storage.transitionTicket(ticketId, 'validated', { reason: 'minion-plan-dispatch: task creation failed' })
    process.exit(1)
  }

  log(`Task created: ${taskId}`)

  // ── 5. Poll task until complete ───────────────────────────────────────────

  log(`Polling task ${taskId} (timeout: 30min)...`)
  const taskResult = await pollTask(apiUrl, taskId, 15_000, 1_800_000)

  if (taskResult.status !== 'completed') {
    log(`ERROR: Task ${taskResult.status} — requeueing ticket`)
    storage.transitionTicket(ticketId, 'validated', {
      reason: `minion-plan-dispatch: planner task ${taskResult.status}`,
    })
    process.exit(1)
  }

  log(`Task completed. Output length: ${taskResult.output?.length ?? 0} chars`)

  if (!taskResult.output) {
    log('ERROR: No output from planner task')
    storage.transitionTicket(ticketId, 'validated', { reason: 'minion-plan-dispatch: empty planner output' })
    process.exit(1)
  }

  // ── 6. Extract DISPATCH_ID ────────────────────────────────────────────────

  const failureMsg = extractDispatchFailed(taskResult.output)
  if (failureMsg) {
    log(`ERROR: Planner reported dispatch failure: ${failureMsg}`)
    storage.transitionTicket(ticketId, 'validated', {
      reason: `minion-plan-dispatch: DISPATCH_FAILED=${failureMsg}`,
    })
    process.exit(1)
  }

  const dispatchId = extractDispatchId(taskResult.output)
  if (!dispatchId) {
    log('ERROR: No DISPATCH_ID found in planner output')
    log(`Output tail: ${taskResult.output.slice(-500)}`)
    storage.transitionTicket(ticketId, 'validated', { reason: 'minion-plan-dispatch: no DISPATCH_ID in output' })
    process.exit(1)
  }

  log(`Dispatch ID: ${dispatchId}`)

  // ── 7. Poll dispatch until complete ──────────────────────────────────────

  log(`Polling dispatch ${dispatchId} (interval: 15s, timeout: 60min)...`)
  const dispatchResult = await pollDispatch(apiUrl, dispatchId, 15_000, 3_600_000)

  if (dispatchResult.status === 'timeout') {
    log('ERROR: Dispatch timed out after 60 minutes')
    storage.transitionTicket(ticketId, 'validated', { reason: 'minion-plan-dispatch: dispatch timeout' })
    process.exit(1)
  }

  if (dispatchResult.status !== 'completed') {
    log(`ERROR: Dispatch ${dispatchResult.status}`)
    if (dispatchResult.result) {
      log(`Dispatch result: ${JSON.stringify(dispatchResult.result)}`)
    }
    storage.transitionTicket(ticketId, 'validated', {
      reason: `minion-plan-dispatch: dispatch ${dispatchResult.status}`,
    })
    process.exit(1)
  }

  // ── 8. Resolve ticket ─────────────────────────────────────────────────────

  log(`Dispatch completed successfully`)
  if (dispatchResult.result) {
    log(`Result: ${JSON.stringify(dispatchResult.result)}`)
  }

  storage.transitionTicket(ticketId, 'resolved', {
    resolved_by: 'minion-plan-dispatch',
    reason: `Dispatch ${dispatchId} completed`,
  })

  log(`Ticket ${ticketId} resolved`)
}

main().catch((err) => {
  console.error('[plan-dispatch] FATAL:', err)
  process.exit(1)
})
