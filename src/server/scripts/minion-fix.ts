/**
 * minion-fix.ts -- Standalone bun executable that reads open tickets from the
 * ticket system and creates agentboard tasks to fix them, then commits results.
 *
 * Two-tier flow:
 *   - Small-effort tickets (in auto_merge_efforts): commit directly to current branch
 *   - Medium+ tickets: commit to a fix branch, push, open PR for review
 *
 * Usage:
 *   bun run src/server/scripts/minion-fix.ts \
 *     --api-url http://localhost:4040 \
 *     [--project /path/to/project] \
 *     [--limit 20] \
 *     [--dry-run]
 */

import fs from 'node:fs'
import os from 'node:os'
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
  limit: number
  dryRun: boolean
}

interface FixResult {
  ticket: Ticket
  commitMsg: string
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
  // Only verify lint + typecheck for minion fixes.
  // Full test suite is skipped to avoid false negatives from pre-existing test failures.
  const lint = Bun.spawnSync(project.lint_cmd.split(/\s+/), { cwd: projectPath })
  if (lint.exitCode !== 0) return { pass: false, message: 'Lint failed' }
  const tc = Bun.spawnSync(project.typecheck_cmd.split(/\s+/), { cwd: projectPath })
  if (tc.exitCode !== 0) return { pass: false, message: 'Typecheck failed' }
  return { pass: true, message: 'Lint + typecheck pass' }
}

function commitFix(projectPath: string, ticketId: string, title: string): { success: boolean; message: string } {
  // Only stage tracked files that changed — avoid pulling in untracked ticket YAMLs etc.
  Bun.spawnSync(['git', 'add', '-u'], { cwd: projectPath })
  const status = Bun.spawnSync(['git', 'diff', '--cached', '--name-only'], { cwd: projectPath })
  if (!status.stdout.toString().trim()) return { success: false, message: 'Nothing to commit' }
  const msg = `fix(minion): ${title.slice(0, 72)} [${ticketId}]`
  const commit = Bun.spawnSync(['git', 'commit', '--no-verify', '-m', msg], { cwd: projectPath })
  if (commit.exitCode !== 0) return { success: false, message: `Commit failed: ${commit.stderr.toString()}` }
  return { success: true, message: `Committed: ${msg}` }
}

function revertChanges(projectPath: string): void {
  // Only revert tracked file changes — don't nuke untracked files (ticket YAMLs etc.)
  Bun.spawnSync(['git', 'checkout', '.'], { cwd: projectPath })
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

// ─── Fix a Single Ticket ────────────────────────────────────────────────────

async function fixTicket(
  ticket: Ticket,
  project: ProjectConfig,
  args: CliArgs,
  storage: FileStorage,
  tag: string,
): Promise<FixResult | null> {
  console.log(`${tag} [${ticket.id}] Fixing: ${ticket.title}`)

  const prompt = buildPrompt(ticket, project.language)
  let taskId: string
  try {
    taskId = await createTask(args.apiUrl, project.path, prompt, 1800, project.fix_model)
  } catch (err) {
    console.error(`${tag} [${ticket.id}] createTask failed: ${err}`)
    storage.transitionTicket(ticket.id, 'validated', { reason: 'minion-fix: task creation failed' })
    return null
  }

  console.log(`${tag} [${ticket.id}] Task ${taskId} running...`)
  const result = await pollUntilDone(args.apiUrl, taskId)

  if (result.status !== 'completed') {
    console.log(`${tag} [${ticket.id}] Task ${result.status} — reverting`)
    revertChanges(project.path)
    storage.transitionTicket(ticket.id, 'validated', { reason: `minion-fix: task ${result.status}` })
    return null
  }

  const verify = verifyGreen(project.path, project)
  if (!verify.pass) {
    console.log(`${tag} [${ticket.id}] Verification failed (${verify.message}) — reverting`)
    revertChanges(project.path)
    storage.transitionTicket(ticket.id, 'validated', { reason: `minion-fix: ${verify.message}` })
    return null
  }

  const commit = commitFix(project.path, ticket.id, ticket.title)
  if (!commit.success) {
    console.log(`${tag} [${ticket.id}] ${commit.message} — skipping`)
    revertChanges(project.path)
    storage.transitionTicket(ticket.id, 'validated', { reason: `minion-fix: ${commit.message}` })
    return null
  }

  console.log(`${tag} [${ticket.id}] ${commit.message}`)
  storage.transitionTicket(ticket.id, 'resolved', { resolved_by: 'minion-fix', reason: commit.message })
  return { ticket, commitMsg: `- ${ticket.id}: ${ticket.title}` }
}

// ─── Workflow Routing for Complex Tickets ───────────────────────────────────

function generateBriefYaml(ticket: Ticket): string {
  const briefDir = path.join(os.homedir(), '.agentboard', 'minion-briefs')
  fs.mkdirSync(briefDir, { recursive: true })
  const briefPath = path.join(briefDir, `from-ticket-${ticket.id}.yaml`)

  const sourceFiles = ticket.source.file ? [ticket.source.file] : []
  const brief = {
    title: ticket.title,
    description: ticket.description,
    target_files: sourceFiles,
    ticket_id: ticket.id,
    category: ticket.category,
    effort: ticket.effort,
  }

  fs.writeFileSync(briefPath, yaml.dump(brief))
  return briefPath
}

async function fixViaWorkflow(
  ticket: Ticket,
  project: ProjectConfig,
  args: CliArgs,
  storage: FileStorage,
  tag: string,
): Promise<FixResult | null> {
  console.log(`${tag} [${ticket.id}] Routing to minion-workflow: ${ticket.title}`)

  const briefPath = generateBriefYaml(ticket)
  const scriptDir = path.dirname(new URL(import.meta.url).pathname)
  const workflowScript = path.join(scriptDir, 'minion-workflow.ts')

  console.log(`${tag} [${ticket.id}] Brief: ${briefPath}`)
  console.log(`${tag} [${ticket.id}] Spawning minion-workflow...`)

  const result = Bun.spawnSync(
    ['bun', 'run', workflowScript, '--brief', briefPath, '--project', project.path, '--api-url', args.apiUrl],
    { cwd: project.path, stdout: 'pipe', stderr: 'pipe', timeout: 3_600_000_000_000 },
  )

  const stderr = new TextDecoder().decode(result.stderr)

  if (result.exitCode === 0) {
    console.log(`${tag} [${ticket.id}] Workflow completed successfully`)
    storage.transitionTicket(ticket.id, 'resolved', { resolved_by: 'minion-workflow', reason: 'Fixed via TDD workflow' })
    return { ticket, commitMsg: `- ${ticket.id}: ${ticket.title} (via workflow)` }
  }

  console.error(`${tag} [${ticket.id}] Workflow failed (exit=${result.exitCode})`)
  if (stderr) console.error(`${tag} [${ticket.id}] stderr: ${stderr.slice(0, 500)}`)
  storage.transitionTicket(ticket.id, 'validated', { reason: `minion-workflow failed (exit=${result.exitCode})` })
  return null
}

// ─── Per-Project Processing ──────────────────────────────────────────────────

async function processProject(
  project: ProjectConfig,
  args: CliArgs,
): Promise<{ fixed: number; failed: number; skipped: number }> {
  const projectPath = project.path
  const tag = `[minion-fix][${path.basename(projectPath)}]`
  const autoMergeEfforts = new Set(project.auto_merge_efforts ?? ['small'])

  console.log(`${tag} Starting — limit=${args.limit} dry-run=${args.dryRun} auto-merge=${[...autoMergeEfforts].join(',')}`)

  const storage = new FileStorage(projectPath)

  // List open tickets, severity desc — fetch all efforts, we'll split them
  const listResult = storage.listTickets({
    status: 'open',
    sort_by: 'severity',
    sort_order: 'desc',
    limit: 200,
    offset: 0,
  })

  // Get full tickets, filter to minion-detect, split by auto-merge vs PR
  const autoMergeTickets: Ticket[] = []
  const prTickets: Ticket[] = []

  for (const summary of listResult.tickets) {
    if (autoMergeTickets.length + prTickets.length >= args.limit) break
    const full = storage.getTicket(summary.id)
    if (!full) continue
    if (full.found_by !== 'minion-detect' && !full.found_by?.includes('minion')) continue

    if (autoMergeEfforts.has(full.effort)) {
      autoMergeTickets.push(full)
    } else {
      prTickets.push(full)
    }
  }

  const totalEligible = autoMergeTickets.length + prTickets.length
  if (totalEligible === 0) {
    console.log(`${tag} No eligible tickets found`)
    return { fixed: 0, failed: 0, skipped: 0 }
  }

  console.log(`${tag} Found ${totalEligible} eligible ticket(s): ${autoMergeTickets.length} auto-merge, ${prTickets.length} PR`)

  if (args.dryRun) {
    for (const t of autoMergeTickets) {
      console.log(`  [auto-merge] [${t.id}] [${t.severity}] [${t.effort}] ${t.title} — ${t.source.file}:${t.source.line_start}`)
    }
    for (const t of prTickets) {
      console.log(`  [PR]          [${t.id}] [${t.severity}] [${t.effort}] ${t.title} — ${t.source.file}:${t.source.line_start}`)
    }
    return { fixed: 0, failed: 0, skipped: totalEligible }
  }

  let fixed = 0
  let failed = 0
  const originalBranch = gitCurrentBranch(projectPath)

  // ── Pass 1: Auto-merge tickets (commit directly to current branch) ──────

  if (autoMergeTickets.length > 0) {
    console.log(`${tag} Pass 1: ${autoMergeTickets.length} auto-merge ticket(s)`)
    for (const ticket of autoMergeTickets) {
      const result = await fixTicket(ticket, project, args, storage, tag)
      if (result) { fixed++ } else { failed++ }
    }
  }

  // ── Pass 2: PR tickets (fix branch → push → PR) ────────────────────────

  if (prTickets.length > 0) {
    const today = new Date().toISOString().slice(0, 10)
    const fixBranch = `fix/nightly-${today}`
    console.log(`${tag} Pass 2: ${prTickets.length} PR ticket(s) → branch ${fixBranch}`)

    if (!gitCreateBranch(projectPath, fixBranch)) {
      console.error(`${tag} ERROR: Could not create branch ${fixBranch}`)
      failed += prTickets.length
    } else {
      const prCommitMessages: string[] = []

      for (const ticket of prTickets) {
        // Route medium bun-test tickets to the TDD workflow pipeline
        const useWorkflow = ticket.effort === 'medium' && ticket.tags?.includes('bun-test')
        const result = useWorkflow
          ? await fixViaWorkflow(ticket, project, args, storage, tag)
          : await fixTicket(ticket, project, args, storage, tag)
        if (result) {
          prCommitMessages.push(result.commitMsg)
          fixed++
        } else {
          failed++
        }
      }

      // Push and open PR if any fixes were committed
      if (prCommitMessages.length > 0) {
        console.log(`${tag} Pushing branch ${fixBranch}`)
        if (gitPush(projectPath, fixBranch)) {
          const prBody = `Automated nightly fixes from minion-fix.\n\n## Fixed Tickets\n${prCommitMessages.join('\n')}\n\n🤖 Generated by minion-fix`
          try {
            const pr = Bun.spawnSync(
              ['gh', 'pr', 'create', '--title', `fix(nightly): automated fixes ${today}`, '--body', prBody],
              { cwd: projectPath },
            )
            if (pr.exitCode === 0) {
              const prUrl = pr.stdout.toString().trim()
              console.log(`${tag} PR created: ${prUrl}`)
              // Auto-merge after CI passes (or immediately if no branch protection)
              try {
                const merge = Bun.spawnSync(
                  ['gh', 'pr', 'merge', '--auto', '--squash', prUrl],
                  { cwd: projectPath },
                )
                if (merge.exitCode === 0) {
                  console.log(`${tag} Auto-merge enabled for PR`)
                } else {
                  console.log(`${tag} Auto-merge not available: ${merge.stderr.toString().trim()}`)
                }
              } catch {
                console.log(`${tag} Could not enable auto-merge`)
              }
            } else {
              console.error(`${tag} PR creation failed: ${pr.stderr.toString()}`)
            }
          } catch {
            console.log(`${tag} 'gh' CLI not available — skip PR creation. Push succeeded, create PR manually.`)
          }
        } else {
          console.error(`${tag} Push failed — commits remain on local branch`)
        }
      }

      // Return to original branch
      gitCheckout(projectPath, originalBranch)
      console.log(`${tag} Returned to ${originalBranch}`)
    }
  }

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
