/**
 * minion-fix.ts -- Iterative nightly fix pipeline that trickles work through
 * the swarm executor until a deadline.
 *
 * Runs in cycles from cron start (02:00) until soft deadline (08:30):
 *   1. Fetch next batch of small tickets → dispatch as swarm group → wait
 *   2. Run ONE medium ticket via plan-dispatch → wait
 *   3. Loop back if time remaining
 *
 * Small tickets commit directly via the executor (baseline-diffed gates).
 * Medium tickets run on a fix branch with a PR opened at the end.
 *
 * Usage:
 *   bun run src/server/scripts/minion-fix.ts \
 *     --api-url http://localhost:4040 \
 *     [--project /path/to/project] \
 *     [--small-batch 8] \
 *     [--deadline 08:30] \
 *     [--dry-run]
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { FileStorage } from '/home/andrew-cooke/tools/mcp-servers/ticket-system/src/storage/file-storage'
import type { Ticket } from '/home/andrew-cooke/tools/mcp-servers/ticket-system/src/storage/schemas'

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProjectConfig {
  path: string
  language: string
  detectors: string[]
  lint_cmd: string
  typecheck_cmd: string
  test_cmd: string
  fix_model: string
  auto_merge_efforts?: string[]  // efforts that get auto-merged (default: ['small'])
}

interface MinionConfig {
  projects: ProjectConfig[]
}

interface CliArgs {
  apiUrl: string
  project: string | null
  smallBatch: number       // max small tickets per swarm dispatch cycle
  deadlineHour: number     // soft deadline hour (stop dispatching new work)
  deadlineMinute: number
  dryRun: boolean
}

// ─── CLI Parsing ─────────────────────────────────────────────────────────────

function parseArgs(): CliArgs {
  const args = process.argv.slice(2)
  let apiUrl = ''
  let project: string | null = null
  let smallBatch = 8
  let deadlineHour = 8
  let deadlineMinute = 30
  let dryRun = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--api-url') { apiUrl = args[++i]; continue }
    if (arg === '--project') { project = args[++i]; continue }
    if (arg === '--small-batch') { smallBatch = parseInt(args[++i], 10); continue }
    if (arg === '--deadline') {
      const [h, m] = args[++i].split(':').map(Number)
      deadlineHour = h; deadlineMinute = m ?? 30
      continue
    }
    if (arg === '--dry-run') { dryRun = true; continue }
  }

  if (!apiUrl) {
    console.error('[minion-fix] ERROR: --api-url is required')
    process.exit(1)
  }

  return { apiUrl, project, smallBatch, deadlineHour, deadlineMinute, dryRun }
}

/** Check if we're past the soft deadline */
function pastDeadline(args: CliArgs): boolean {
  const now = new Date()
  const h = now.getHours()
  const m = now.getMinutes()
  if (h > args.deadlineHour) return true
  if (h === args.deadlineHour && m >= args.deadlineMinute) return true
  return false
}

// ─── Config ──────────────────────────────────────────────────────────────────

function loadConfig(): MinionConfig {
  const configPath = path.join(process.env.HOME ?? '/root', '.agentboard', 'minion-projects.yaml')
  if (!fs.existsSync(configPath)) {
    console.error(`[minion-fix] ERROR: Config not found at ${configPath}`)
    process.exit(1)
  }
  return yaml.load(fs.readFileSync(configPath, 'utf8')) as MinionConfig
}

// ─── Git Helpers ─────────────────────────────────────────────────────────────

function gitCurrentBranch(projectPath: string): string {
  const result = Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath })
  const branch = result.stdout.toString().trim()
  if (result.exitCode !== 0 || !branch) return 'main'
  return branch
}

function gitCreateBranch(projectPath: string, branchName: string): boolean {
  const result = Bun.spawnSync(['git', 'checkout', '-b', branchName], { cwd: projectPath })
  return result.exitCode === 0
}

function gitCheckout(projectPath: string, branch: string): boolean {
  const result = Bun.spawnSync(['git', 'checkout', branch], { cwd: projectPath })
  return result.exitCode === 0
}

function gitPush(projectPath: string, branchName: string): boolean {
  const result = Bun.spawnSync(['git', 'push', '-u', 'origin', branchName], { cwd: projectPath })
  return result.exitCode === 0
}

// ─── Prompt Builder ──────────────────────────────────────────────────────────

function buildPrompt(ticket: Ticket, language: string): string {
  const src = ticket.source
  return `Fix the following issue in ${src.file}:${src.line_start}

**Issue:** ${ticket.title}
**Details:** ${ticket.description}
**Code:**
\`\`\`${language}
${src.code_snippet}
\`\`\`
**Suggested fix:** ${ticket.suggestion ?? 'No suggestion provided'}

Rules:
- Make the minimal change needed to fix this specific issue
- Do not refactor surrounding code
- Do not add comments or documentation
- If the fix is unclear, make no changes`
}

// ─── Swarm Dispatch (small tickets) ─────────────────────────────────────────

async function fixViaSwarm(
  tickets: Ticket[],
  project: ProjectConfig,
  apiUrl: string,
  groupId: string,
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>()
  if (tickets.length === 0) return results

  // Create one WO per ticket via API
  for (const ticket of tickets) {
    const woId = `WO-${ticket.id}`
    const prompt = buildPrompt(ticket, project.language)
    const relPath = ticket.source?.file
      ? path.relative(project.path, ticket.source.file)
      : ''
    const scope = relPath ? path.dirname(relPath) : ''

    const wo = {
      id: woId,
      group_id: groupId,
      title: ticket.title,
      description: prompt,
      task: 'fix',
      scope: scope || undefined,
      full_context_files: relPath ? [relPath] : [],
      gates: { compile: true, lint: true, typecheck: true, tests: { run: false } },
      execution: { model: 'glm-5', max_retries: 2, timeout_minutes: 5 },
      isolation: { type: 'none' },
      output: { commit: true, commit_prefix: 'fix' },
    }

    try {
      const resp = await fetch(`${apiUrl}/api/wo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wo),
      })
      if (!resp.ok) {
        console.log(`[minion-fix] Failed to create WO for ${ticket.id}: ${resp.status}`)
        results.set(ticket.id, false)
        continue
      }
      console.log(`[minion-fix] Created WO ${woId} for ticket ${ticket.id}`)
    } catch (err) {
      console.log(`[minion-fix] Error creating WO for ${ticket.id}: ${err}`)
      results.set(ticket.id, false)
    }
  }

  // Dispatch the group
  try {
    const dispatchResp = await fetch(`${apiUrl}/api/wo/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        group_id: groupId,
        working_dir: project.path,
        concurrency: 4,
        max_failures: Math.max(2, Math.ceil(tickets.length / 2)),
      }),
    })

    if (!dispatchResp.ok) {
      console.log(`[minion-fix] Failed to dispatch group ${groupId}: ${dispatchResp.status}`)
      for (const t of tickets) results.set(t.id, false)
      return results
    }

    const { dispatch_id } = await dispatchResp.json() as { dispatch_id: string }
    console.log(`[minion-fix] Dispatched group ${groupId} as ${dispatch_id}`)

    // Poll dispatch until complete (60 min timeout)
    const deadline = Date.now() + 60 * 60 * 1000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 15_000))
      const statusResp = await fetch(`${apiUrl}/api/wo/dispatch/${dispatch_id}`)
      if (!statusResp.ok) continue
      const record = await statusResp.json() as { status: string; result?: unknown }

      if (record.status === 'completed') {
        console.log(`[minion-fix] Dispatch ${dispatch_id} completed`)
        for (const t of tickets) {
          if (!results.has(t.id)) results.set(t.id, true)
        }
        return results
      }

      if (record.status === 'failed') {
        console.log(`[minion-fix] Dispatch ${dispatch_id} failed`)
        for (const t of tickets) {
          if (!results.has(t.id)) results.set(t.id, false)
        }
        return results
      }
    }

    console.log(`[minion-fix] Dispatch ${dispatch_id} timed out`)
    for (const t of tickets) {
      if (!results.has(t.id)) results.set(t.id, false)
    }
  } catch (err) {
    console.log(`[minion-fix] Dispatch error: ${err}`)
    for (const t of tickets) results.set(t.id, false)
  }

  return results
}

// ─── Plan-Dispatch (medium tickets) ──────────────────────────────────────────

async function fixViaPlanDispatch(
  ticket: Ticket,
  project: ProjectConfig,
  apiUrl: string,
): Promise<boolean> {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname)
  const scriptPath = path.join(scriptDir, 'minion-plan-dispatch.ts')

  console.log(`[minion-fix] Running plan-dispatch for ticket ${ticket.id}`)

  const result = Bun.spawnSync(
    ['bun', 'run', scriptPath, '--ticket-id', ticket.id, '--project', project.path, '--api-url', apiUrl],
    { cwd: project.path, stdout: 'pipe', stderr: 'pipe', timeout: 3_600_000_000_000 },
  )

  if (result.exitCode === 0) {
    console.log(`[minion-fix] Plan-dispatch succeeded for ticket ${ticket.id}`)
    return true
  }

  const stderr = new TextDecoder().decode(result.stderr)
  console.log(`[minion-fix] Plan-dispatch failed for ticket ${ticket.id}: exit ${result.exitCode}`)
  if (stderr) console.error(`[minion-fix] stderr: ${stderr.slice(0, 500)}`)
  return false
}

// ─── Ticket Fetching ────────────────────────────────────────────────────────

/** Fetch the next batch of eligible tickets, split by effort */
function fetchTickets(
  storage: FileStorage,
  autoMergeEfforts: Set<string>,
  smallLimit: number,
): { small: Ticket[]; medium: Ticket[] } {
  const listResult = storage.listTickets({
    status: 'open',
    sort_by: 'severity',
    sort_order: 'desc',
    limit: 500,
    offset: 0,
  })

  const small: Ticket[] = []
  const medium: Ticket[] = []

  for (const summary of listResult.tickets) {
    const full = storage.getTicket(summary.id)
    if (!full) continue
    if (full.found_by !== 'minion-detect' && !full.found_by?.includes('minion')) continue

    if (autoMergeEfforts.has(full.effort)) {
      if (small.length < smallLimit) small.push(full)
    } else {
      medium.push(full)
    }
  }

  return { small, medium }
}

// ─── Iterative Processing Loop ──────────────────────────────────────────────

async function processProject(
  project: ProjectConfig,
  args: CliArgs,
): Promise<{ fixed: number; failed: number; cycles: number }> {
  const projectPath = project.path
  const tag = `[minion-fix][${path.basename(projectPath)}]`
  const autoMergeEfforts = new Set(project.auto_merge_efforts ?? ['small'])
  const storage = new FileStorage(projectPath)
  const today = new Date().toISOString().slice(0, 10)
  const originalBranch = gitCurrentBranch(projectPath)

  console.log(`${tag} Starting iterative loop — batch=${args.smallBatch} deadline=${String(args.deadlineHour).padStart(2, '0')}:${String(args.deadlineMinute).padStart(2, '0')} dry-run=${args.dryRun}`)

  let fixed = 0
  let failed = 0
  let cycle = 0
  let fixBranchCreated = false
  const prCommitMessages: string[] = []

  while (!pastDeadline(args)) {
    cycle++
    const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    console.log(`\n${tag} ── Cycle ${cycle} (${now}) ──`)

    // Re-fetch tickets each cycle (resolved ones disappear, new detections appear)
    const { small, medium } = fetchTickets(storage, autoMergeEfforts, args.smallBatch)
    const remaining = small.length + medium.length

    if (remaining === 0) {
      console.log(`${tag} No more eligible tickets — all done`)
      break
    }

    console.log(`${tag} Available: ${small.length} small, ${medium.length} medium`)

    if (args.dryRun) {
      for (const t of small) {
        console.log(`  [small]  [${t.id}] [${t.severity}] ${t.title.slice(0, 80)}`)
      }
      for (const t of medium.slice(0, 3)) {
        console.log(`  [medium] [${t.id}] [${t.severity}] ${t.title.slice(0, 80)}`)
      }
      break
    }

    // ── Step 1: Dispatch small batch via swarm ──────────────────────────

    if (small.length > 0) {
      const groupId = `nightly-${today}-c${cycle}`
      console.log(`${tag} Dispatching ${small.length} small ticket(s) as group ${groupId}`)

      const swarmResults = await fixViaSwarm(small, project, args.apiUrl, groupId)

      for (const ticket of small) {
        const success = swarmResults.get(ticket.id) ?? false
        if (success) {
          storage.transitionTicket(ticket.id, 'resolved', { resolved_by: 'minion-fix-swarm' })
          console.log(`${tag} Resolved ${ticket.id}`)
          fixed++
        } else {
          // Mark as in-progress so we don't retry it next cycle
          // (it'll get swept back to open by staleness sweep if the code changes)
          try { storage.transitionTicket(ticket.id, 'in-progress', { reason: 'swarm fix failed, skipping for tonight' }) } catch { /* already transitioned */ }
          console.log(`${tag} Failed ${ticket.id}, skipping for tonight`)
          failed++
        }
      }
    }

    // Check deadline before starting expensive medium ticket
    if (pastDeadline(args)) {
      console.log(`${tag} Deadline reached after small batch, stopping`)
      break
    }

    // ── Step 2: Run ONE medium ticket via plan-dispatch ─────────────────

    if (medium.length > 0) {
      const ticket = medium[0]

      // Create fix branch on first medium ticket
      if (!fixBranchCreated) {
        const fixBranch = `fix/nightly-${today}`
        if (!gitCreateBranch(projectPath, fixBranch)) {
          console.error(`${tag} Could not create branch ${fixBranch}, skipping medium tickets`)
        } else {
          fixBranchCreated = true
          console.log(`${tag} Created fix branch ${fixBranch}`)
        }
      }

      if (fixBranchCreated) {
        console.log(`${tag} Plan-dispatching medium ticket ${ticket.id}`)
        const success = await fixViaPlanDispatch(ticket, project, args.apiUrl)

        if (success) {
          storage.transitionTicket(ticket.id, 'resolved', { resolved_by: 'minion-plan-dispatch' })
          prCommitMessages.push(`- ${ticket.id}: ${ticket.title}`)
          console.log(`${tag} Resolved ${ticket.id} via plan-dispatch`)
          fixed++
        } else {
          try { storage.transitionTicket(ticket.id, 'in-progress', { reason: 'plan-dispatch failed, skipping for tonight' }) } catch { /* already transitioned */ }
          console.log(`${tag} Plan-dispatch failed for ${ticket.id}`)
          failed++
        }
      }
    }

    // Brief pause between cycles to avoid hammering the API
    if (!pastDeadline(args)) {
      console.log(`${tag} Cycle ${cycle} complete, pausing 30s before next cycle`)
      await new Promise(r => setTimeout(r, 30_000))
    }
  }

  // ── Wrap up: push fix branch + open PR if medium tickets were fixed ────

  if (fixBranchCreated && prCommitMessages.length > 0) {
    const fixBranch = `fix/nightly-${today}`
    console.log(`${tag} Pushing fix branch with ${prCommitMessages.length} fix(es)`)

    if (gitPush(projectPath, fixBranch)) {
      const prBody = `Automated nightly fixes from minion-fix.\n\n## Fixed Tickets\n${prCommitMessages.join('\n')}\n\nGenerated by minion-fix`
      try {
        const pr = Bun.spawnSync(
          ['gh', 'pr', 'create', '--title', `fix(nightly): automated fixes ${today}`, '--body', prBody],
          { cwd: projectPath },
        )
        if (pr.exitCode === 0) {
          const prUrl = pr.stdout.toString().trim()
          console.log(`${tag} PR created: ${prUrl}`)
          try {
            Bun.spawnSync(['gh', 'pr', 'merge', '--auto', '--squash', prUrl], { cwd: projectPath })
          } catch { /* auto-merge not available */ }
        } else {
          console.error(`${tag} PR creation failed: ${pr.stderr.toString().slice(0, 200)}`)
        }
      } catch {
        console.log(`${tag} 'gh' CLI not available — push succeeded, create PR manually`)
      }
    } else {
      console.error(`${tag} Push failed — commits remain on local branch`)
    }
  }

  // Return to original branch
  if (fixBranchCreated) {
    gitCheckout(projectPath, originalBranch)
    console.log(`${tag} Returned to ${originalBranch}`)
  }

  console.log(`\n${tag} Summary: ${fixed} fixed, ${failed} failed, ${cycle} cycles`)
  return { fixed, failed, cycles: cycle }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs()
  const config = loadConfig()

  let projects = config.projects
  if (args.project) {
    projects = projects.filter((p) => p.path === args.project)
    if (projects.length === 0) {
      console.error(`[minion-fix] ERROR: No project found for path ${args.project}`)
      process.exit(1)
    }
  }

  let totalFixed = 0
  let totalFailed = 0

  for (const project of projects) {
    const { fixed, failed, cycles } = await processProject(project, args)
    console.log(`[minion-fix] ${project.path}: ${fixed} fixed, ${failed} failed, ${cycles} cycles`)
    totalFixed += fixed
    totalFailed += failed
  }

  console.log(`[minion-fix] Done — total: ${totalFixed} fixed, ${totalFailed} failed`)
}

main().catch((err) => {
  console.error('[minion-fix] FATAL:', err)
  process.exit(1)
})
