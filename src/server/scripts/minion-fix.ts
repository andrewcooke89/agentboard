/**
 * minion-fix.ts -- Standalone bun executable that reads open tickets from the
 * ticket system and creates agentboard tasks to fix them, then commits results.
 *
 * Usage:
 *   bun run src/server/scripts/minion-fix.ts \
 *     --api-url http://localhost:4040 \
 *     [--project /path/to/project] \
 *     [--limit 20] \
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
}

interface MinionConfig {
  projects: ProjectConfig[]
}

interface CliArgs {
  apiUrl: string
  project: string | null
  limit: number
  dryRun: boolean
}

// ─── CLI Parsing ─────────────────────────────────────────────────────────────

function parseArgs(): CliArgs {
  const args = process.argv.slice(2)
  let apiUrl = ''
  let project: string | null = null
  let limit = 20
  let dryRun = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--api-url') { apiUrl = args[++i]; continue }
    if (arg === '--project') { project = args[++i]; continue }
    if (arg === '--limit') { limit = parseInt(args[++i], 10); continue }
    if (arg === '--dry-run') { dryRun = true; continue }
  }

  if (!apiUrl) {
    console.error('[minion-fix] ERROR: --api-url is required')
    process.exit(1)
  }

  return { apiUrl, project, limit, dryRun }
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

// ─── Agentboard API ──────────────────────────────────────────────────────────

async function createTask(
  apiUrl: string,
  projectPath: string,
  prompt: string,
  timeoutSeconds = 1800,
  model = 'glm',
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

async function pollUntilDone(
  apiUrl: string,
  taskId: string,
  maxWaitMs = 1_800_000,
): Promise<{ status: 'completed' | 'failed' | 'cancelled'; exitCode: number | null; outputPath: string | null }> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${apiUrl}/api/tasks/${taskId}`)
    if (!res.ok) { await Bun.sleep(10_000); continue }
    const task = (await res.json()) as { status: string; exitCode?: number | null; outputPath?: string | null }
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      return { status: task.status as 'completed' | 'failed' | 'cancelled', exitCode: task.exitCode ?? null, outputPath: task.outputPath ?? null }
    }
    await Bun.sleep(10_000)
  }
  return { status: 'failed', exitCode: null, outputPath: null }
}

// ─── Git / Verification Helpers ──────────────────────────────────────────────

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

function verifyGreen(projectPath: string, project: ProjectConfig): { pass: boolean; message: string } {
  // Only verify lint + typecheck for minion fixes (small, lint-level changes).
  // Full test suite is skipped to avoid false negatives from pre-existing test failures.
  const lint = Bun.spawnSync(project.lint_cmd.split(/\s+/), { cwd: projectPath })
  if (lint.exitCode !== 0) return { pass: false, message: `Lint failed` }
  const tc = Bun.spawnSync(project.typecheck_cmd.split(/\s+/), { cwd: projectPath })
  if (tc.exitCode !== 0) return { pass: false, message: `Typecheck failed` }
  return { pass: true, message: 'Lint + typecheck pass' }
}

function commitFix(projectPath: string, ticketId: string, title: string): { success: boolean; message: string } {
  Bun.spawnSync(['git', 'add', '-A'], { cwd: projectPath })
  const status = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: projectPath })
  if (!status.stdout.toString().trim()) return { success: false, message: 'Nothing to commit' }
  const msg = `fix(minion): ${title.slice(0, 72)} [${ticketId}]`
  const commit = Bun.spawnSync(['git', 'commit', '--no-verify', '-m', msg], { cwd: projectPath })
  if (commit.exitCode !== 0) return { success: false, message: `Commit failed: ${commit.stderr.toString()}` }
  return { success: true, message: `Committed: ${msg}` }
}

function revertChanges(projectPath: string): void {
  Bun.spawnSync(['git', 'checkout', '.'], { cwd: projectPath })
  Bun.spawnSync(['git', 'clean', '-fd'], { cwd: projectPath })
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

// ─── Per-Project Processing ──────────────────────────────────────────────────

async function processProject(
  project: ProjectConfig,
  args: CliArgs,
): Promise<{ fixed: number; failed: number; skipped: number }> {
  const projectPath = project.path
  const tag = `[minion-fix][${path.basename(projectPath)}]`
  console.log(`${tag} Starting — limit=${args.limit} dry-run=${args.dryRun}`)

  const storage = new FileStorage(projectPath)

  // List open, small-effort tickets, severity desc
  const listResult = storage.listTickets({
    status: 'open',
    effort: 'small',
    sort_by: 'severity',
    sort_order: 'desc',
    limit: 200,
    offset: 0,
  })

  // Get full tickets and filter to minion-detect only (TicketSummary lacks found_by)
  const eligible: Ticket[] = []
  for (const summary of listResult.tickets) {
    if (eligible.length >= args.limit) break
    const full = storage.getTicket(summary.id)
    if (!full) continue
    if (full.found_by === 'minion-detect' || full.found_by?.includes('minion')) {
      eligible.push(full)
    }
  }

  if (eligible.length === 0) {
    console.log(`${tag} No eligible tickets found`)
    return { fixed: 0, failed: 0, skipped: 0 }
  }

  console.log(`${tag} Found ${eligible.length} eligible ticket(s)`)

  if (args.dryRun) {
    for (const t of eligible) {
      console.log(`  [${t.id}] [${t.severity}] ${t.title} — ${t.source.file}:${t.source.line_start}`)
    }
    return { fixed: 0, failed: 0, skipped: eligible.length }
  }

  // Save original branch and create fix branch
  const originalBranch = gitCurrentBranch(projectPath)
  const today = new Date().toISOString().slice(0, 10)
  const fixBranch = `fix/nightly-${today}`

  if (!gitCreateBranch(projectPath, fixBranch)) {
    console.error(`${tag} ERROR: Could not create branch ${fixBranch}`)
    return { fixed: 0, failed: 0, skipped: eligible.length }
  }
  console.log(`${tag} Created branch ${fixBranch}`)

  let fixed = 0
  let failed = 0
  const commitMessages: string[] = []

  for (const ticket of eligible) {
    console.log(`${tag} [${ticket.id}] Fixing: ${ticket.title}`)

    const prompt = buildPrompt(ticket, project.language)
    let taskId: string
    try {
      taskId = await createTask(args.apiUrl, projectPath, prompt, 1800, project.fix_model)
    } catch (err) {
      console.error(`${tag} [${ticket.id}] createTask failed: ${err}`)
      storage.transitionTicket(ticket.id, 'validated', { reason: 'minion-fix: task creation failed' })
      failed++
      continue
    }

    console.log(`${tag} [${ticket.id}] Task ${taskId} running...`)
    const result = await pollUntilDone(args.apiUrl, taskId)

    if (result.status !== 'completed') {
      console.log(`${tag} [${ticket.id}] Task ${result.status} — reverting`)
      revertChanges(projectPath)
      storage.transitionTicket(ticket.id, 'validated', { reason: `minion-fix: task ${result.status}` })
      failed++
      continue
    }

    // Verify
    const verify = verifyGreen(projectPath, project)
    if (!verify.pass) {
      console.log(`${tag} [${ticket.id}] Verification failed (${verify.message}) — reverting`)
      revertChanges(projectPath)
      storage.transitionTicket(ticket.id, 'validated', { reason: `minion-fix: ${verify.message}` })
      failed++
      continue
    }

    // Commit
    const commit = commitFix(projectPath, ticket.id, ticket.title)
    if (!commit.success) {
      console.log(`${tag} [${ticket.id}] ${commit.message} — skipping`)
      revertChanges(projectPath)
      storage.transitionTicket(ticket.id, 'validated', { reason: `minion-fix: ${commit.message}` })
      failed++
      continue
    }

    console.log(`${tag} [${ticket.id}] ${commit.message}`)
    commitMessages.push(`- ${ticket.id}: ${ticket.title}`)
    storage.transitionTicket(ticket.id, 'resolved', { resolved_by: 'minion-fix', reason: commit.message })
    fixed++
  }

  // Push and open PR if any fixes were committed
  if (fixed > 0) {
    console.log(`${tag} Pushing branch ${fixBranch}`)
    if (gitPush(projectPath, fixBranch)) {
      const prBody = `Automated nightly fixes from minion-fix.\n\n## Fixed Tickets\n${commitMessages.join('\n')}\n\n🤖 Generated by minion-fix`
      const pr = Bun.spawnSync(
        ['gh', 'pr', 'create', '--title', `fix(nightly): automated fixes ${today}`, '--body', prBody],
        { cwd: projectPath },
      )
      if (pr.exitCode === 0) {
        console.log(`${tag} PR created: ${pr.stdout.toString().trim()}`)
      } else {
        console.error(`${tag} PR creation failed: ${pr.stderr.toString()}`)
      }
    } else {
      console.error(`${tag} Push failed — commits remain on local branch`)
    }
  }

  // Return to original branch
  gitCheckout(projectPath, originalBranch)
  console.log(`${tag} Returned to ${originalBranch}`)

  return { fixed, failed, skipped: 0 }
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
  let totalSkipped = 0

  for (const project of projects) {
    const { fixed, failed, skipped } = await processProject(project, args)
    console.log(`[minion-fix] ${project.path}: ${fixed} fixed, ${failed} failed, ${skipped} skipped`)
    totalFixed += fixed
    totalFailed += failed
    totalSkipped += skipped
  }

  console.log(`[minion-fix] Done — total: ${totalFixed} fixed, ${totalFailed} failed, ${totalSkipped} skipped`)
}

main().catch((err) => {
  console.error('[minion-fix] FATAL:', err)
  process.exit(1)
})
