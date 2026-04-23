/**
 * minion-fix-workflow.ts -- Lightweight analyze→fix→verify pipeline for failing
 * tests. Unlike minion-workflow (TDD from scratch), this reads existing test
 * failures and makes targeted fixes with retries + escalation.
 *
 * Usage:
 *   bun run src/server/scripts/minion-fix-workflow.ts \
 *     --ticket-id TKT-0083 \
 *     --project /path/to/project \
 *     --api-url http://localhost:4040 \
 *     [--config ~/.agentboard/minion-projects.yaml]
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import type { Ticket } from '/home/andrew-cooke/tools/mcp-servers/ticket-system/src/storage/schemas'
import { FileStorage } from '/home/andrew-cooke/tools/mcp-servers/ticket-system/src/storage/file-storage'

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProjectConfig {
  path: string
  language: string
  detectors: string[]
  lint_cmd: string
  typecheck_cmd: string
  test_cmd: string
  fix_model: string
  auto_merge_efforts?: string[]
  // See minion-fix.ts — high-cascade tags forced out of auto-fix lane.
  skip_auto_fix_tags?: string[]
  plan_model?: string
  impl_model?: string
}

interface MinionConfig {
  projects: ProjectConfig[]
}

interface FixWorkCard {
  run_id: string
  ticket_id: string
  status: 'analyzing' | 'fixing' | 'verifying' | 'complete' | 'failed'
  project: string
  branch: string
  phases: {
    analyze: { status: string }
    fix: { status: string; task_ids: string[]; files_changed: string[] }
    verify: { status: string }
  }
  gates: {
    lint: boolean | null
    typecheck: boolean | null
    tests_pass: boolean | null
  }
  error: string | null
  retries: number
}

interface CliArgs {
  apiUrl: string
  ticketId: string
  project: string | null
  configPath: string
}

interface TaskResult {
  status: 'completed' | 'failed' | 'cancelled'
  exitCode: number | null
  outputPath: string | null
}

// ─── CLI Parsing ─────────────────────────────────────────────────────────────

function parseArgs(): CliArgs {
  const args = process.argv.slice(2)
  let apiUrl = ''
  let ticketId = ''
  let project: string | null = null
  let configPath = path.join(process.env.HOME ?? '/root', '.agentboard', 'minion-projects.yaml')

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--api-url') { apiUrl = args[++i]; continue }
    if (arg === '--ticket-id') { ticketId = args[++i]; continue }
    if (arg === '--project') { project = args[++i]; continue }
    if (arg === '--config') { configPath = args[++i]; continue }
  }

  if (!apiUrl) {
    console.error('[fix-workflow] ERROR: --api-url is required')
    process.exit(1)
  }
  if (!ticketId) {
    console.error('[fix-workflow] ERROR: --ticket-id is required')
    process.exit(1)
  }

  return { apiUrl, ticketId, project, configPath }
}

// ─── Config ──────────────────────────────────────────────────────────────────

function loadConfig(configPath: string): MinionConfig {
  if (!fs.existsSync(configPath)) {
    console.error(`[fix-workflow] ERROR: Config not found at ${configPath}`)
    process.exit(1)
  }
  return yaml.load(fs.readFileSync(configPath, 'utf8')) as MinionConfig
}

function findProjectConfig(config: MinionConfig, projectPath: string): ProjectConfig {
  const found = config.projects.find((p) => p.path === projectPath)
  if (!found) {
    console.error(`[fix-workflow] ERROR: No project config found for path ${projectPath}`)
    process.exit(1)
  }
  return found
}

// ─── Agentboard API ──────────────────────────────────────────────────────────

async function createTask(
  apiUrl: string,
  projectPath: string,
  prompt: string,
  timeoutSeconds = 600,
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
): Promise<TaskResult> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${apiUrl}/api/tasks/${taskId}`)
    if (!res.ok) { await Bun.sleep(10_000); continue }
    const task = (await res.json()) as { status: string; exitCode?: number | null; outputPath?: string | null }
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      return {
        status: task.status as TaskResult['status'],
        exitCode: task.exitCode ?? null,
        outputPath: task.outputPath ?? null,
      }
    }
    await Bun.sleep(10_000)
  }
  return { status: 'failed', exitCode: null, outputPath: null }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function runDir(runId: string): string {
  return path.join(process.env.HOME ?? '/root', '.agentboard', 'minion-runs', runId)
}

function saveWorkCard(wc: FixWorkCard): void {
  const dir = runDir(wc.run_id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'work-card.yaml'), yaml.dump(wc), 'utf8')
}

function generateRunId(): string {
  const today = new Date().toISOString().slice(0, 10)
  const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')
  return `fw-${today}-${hex}`
}

function revertChanges(projectPath: string): void {
  Bun.spawnSync(['git', 'checkout', '.'], { cwd: projectPath })
}

function getFileContent(filePath: string): string {
  if (!fs.existsSync(filePath)) return '(file not found)'
  return fs.readFileSync(filePath, 'utf8')
}

function shiftLeftLint(
  projectPath: string,
  tag: string,
  typecheckCmd: string,
): { pass: boolean; autoFixed: boolean; message: string } {
  let autoFixed = false

  Bun.spawnSync(['oxlint', '--fix', '.'], { cwd: projectPath })
  const status = Bun.spawnSync(['git', 'status', '--porcelain'], { cwd: projectPath })
  if (status.stdout.toString().trim()) {
    autoFixed = true
    console.log(`[${tag}] Auto-fixed lint issues`)
  }

  const lint = Bun.spawnSync(['oxlint', '.'], { cwd: projectPath })
  if (lint.exitCode !== 0) {
    const stdout = lint.stdout.toString().trim()
    const stderr = lint.stderr.toString().trim()
    const output = (stdout || stderr).slice(-1000)
    return { pass: false, autoFixed, message: `Lint failed: ${output}` }
  }

  const tsc = Bun.spawnSync(['sh', '-c', typecheckCmd], { cwd: projectPath })
  if (tsc.exitCode !== 0) {
    const output = (tsc.stdout.toString().trim() || tsc.stderr.toString().trim()).slice(0, 2000)
    return { pass: false, autoFixed, message: `Typecheck failed: ${output}` }
  }

  return { pass: true, autoFixed, message: 'Lint + typecheck pass' }
}

// ─── Phase 1: Analyze ────────────────────────────────────────────────────────

function analyzePhase(
  wc: FixWorkCard,
  ticket: Ticket,
  _projectConfig: ProjectConfig,
): { testOutput: string; fileContents: string; testFile: string } {
  const tag = `[analyze][${wc.run_id}]`
  console.log(`${tag} Running failing tests...`)

  const testFile = ticket.source.file
  const testRun = Bun.spawnSync(['bun', 'test', testFile], { cwd: wc.project })
  const testOutput = (testRun.stdout.toString() + testRun.stderr.toString()).slice(0, 8000)

  console.log(`${tag} Test exit code: ${testRun.exitCode}`)

  // Collect relevant files: the test file + any source files it imports
  const testContent = getFileContent(testFile)
  const imports = testContent.match(/from ['"]([^'"]+)['"]/g) ?? []
  const sourceFiles: string[] = [testFile]

  for (const imp of imports) {
    const match = imp.match(/from ['"]([^'"]+)['"]/)
    if (!match) continue
    const importPath = match[1]
    if (importPath.startsWith('.')) {
      // Resolve relative to test file directory
      const dir = path.dirname(testFile)
      const resolved = path.resolve(dir, importPath)
      // Try with common extensions
      for (const ext of ['', '.ts', '.tsx', '.js', '/index.ts', '/index.js']) {
        const candidate = resolved + ext
        if (fs.existsSync(candidate)) {
          sourceFiles.push(candidate)
          break
        }
      }
    }
  }

  // Deduplicate and build file contents string
  const uniqueFiles = [...new Set(sourceFiles)]
  const fileContents = uniqueFiles.map((f) => {
    const content = getFileContent(f)
    const relPath = path.relative(wc.project, f)
    return `### ${relPath}\n\`\`\`typescript\n${content}\n\`\`\`\n`
  }).join('\n')

  console.log(`${tag} Collected ${uniqueFiles.length} file(s) for context`)

  wc.phases.analyze.status = 'complete'
  wc.status = 'fixing'
  saveWorkCard(wc)

  return { testOutput, fileContents, testFile }
}

// ─── Phase 2: Fix (with retry + escalation) ─────────────────────────────────

const MAX_RETRIES = 2

async function fixPhase(
  wc: FixWorkCard,
  ticket: Ticket,
  apiUrl: string,
  projectConfig: ProjectConfig,
  context: { testOutput: string; fileContents: string; testFile: string },
): Promise<void> {
  const tag = `[fix][${wc.run_id}]`
  const model = projectConfig.impl_model ?? projectConfig.fix_model

  function buildPrompt(extraContext: string, modelName: string): string {
    return `Fix the failing tests described below.

## Ticket
Title: ${ticket.title}
Description: ${ticket.description}

## Failing Test Output
\`\`\`
${context.testOutput}
\`\`\`

## Source Files
${context.fileContents}

${extraContext}

Rules:
- Make the minimal change needed to fix the failing tests
- Do not refactor or restructure code
- Do not modify the test assertions — fix the source code or test setup
- Use your Edit tool to make targeted changes to the relevant files${modelName === 'claude' ? '\n- You are the escalation model — previous cheaper models failed. Be thorough.' : ''}`
  }

  // Run gates: lint + typecheck + tests
  const runGates = (): { pass: boolean; error: string } => {
    const lintResult = shiftLeftLint(wc.project, tag, projectConfig.typecheck_cmd)
    wc.gates.lint = lintResult.pass
    wc.gates.typecheck = lintResult.pass
    console.log(`${tag} ${lintResult.message}`)
    if (!lintResult.pass) {
      saveWorkCard(wc)
      return { pass: false, error: lintResult.message }
    }

    const testRun = Bun.spawnSync(['bun', 'test', context.testFile], { cwd: wc.project })
    wc.gates.tests_pass = testRun.exitCode === 0
    if (!wc.gates.tests_pass) {
      const testOut = (testRun.stdout.toString() + testRun.stderr.toString()).slice(0, 3000)
      saveWorkCard(wc)
      return { pass: false, error: `Tests failed:\n${testOut}` }
    }

    return { pass: true, error: '' }
  }

  // Attempt loop: initial + retries with GLM, then escalation with claude
  let lastError = ''
  let passed = false

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`${tag} Retry ${attempt}/${MAX_RETRIES} after: ${lastError.slice(0, 200)}`)
      revertChanges(wc.project)
    }

    wc.retries = attempt
    const extra = attempt > 0
      ? `## Previous Attempt Failed (attempt ${attempt}/${MAX_RETRIES})\n${lastError}`
      : ''

    const prompt = buildPrompt(extra, model)
    const taskId = await createTask(apiUrl, wc.project, prompt, 900, model)
    wc.phases.fix.task_ids.push(taskId)
    saveWorkCard(wc)

    console.log(`${tag} Task ${taskId} (attempt ${attempt + 1}, model=${model})...`)
    const result = await pollUntilDone(apiUrl, taskId, 1_200_000)

    if (result.status !== 'completed') {
      lastError = `Task ${result.status}`
      console.log(`${tag} Task ${result.status} — ${attempt < MAX_RETRIES ? 'will retry' : 'retries exhausted'}`)
      continue
    }

    // Check gates
    const gateResult = runGates()
    if (gateResult.pass) {
      passed = true
      break
    }
    lastError = gateResult.error
  }

  // Escalation: one attempt with claude
  if (!passed) {
    console.log(`${tag} Escalating to 'claude' after ${MAX_RETRIES + 1} failed attempts`)
    revertChanges(wc.project)

    const extra = `## Escalation Context\nPrevious ${MAX_RETRIES + 1} attempt(s) with '${model}' failed.\nLast error: ${lastError}`
    const prompt = buildPrompt(extra, 'claude')
    const taskId = await createTask(apiUrl, wc.project, prompt, 900, 'claude')
    wc.phases.fix.task_ids.push(taskId)
    saveWorkCard(wc)

    console.log(`${tag} Escalation task ${taskId} (model=claude)...`)
    const result = await pollUntilDone(apiUrl, taskId, 1_200_000)

    if (result.status === 'completed') {
      const gateResult = runGates()
      if (gateResult.pass) {
        passed = true
      } else {
        lastError = gateResult.error
      }
    } else {
      lastError = `Escalation task ${result.status}`
    }
  }

  if (!passed) {
    revertChanges(wc.project)
    wc.status = 'failed'
    wc.error = `Fix failed after ${MAX_RETRIES + 1} attempts + escalation: ${lastError.slice(0, 500)}`
    wc.phases.fix.status = 'failed'
    saveWorkCard(wc)
    throw new Error(wc.error)
  }

  // Record changed files
  const diffResult = Bun.spawnSync(['git', 'diff', '--name-only'], { cwd: wc.project })
  wc.phases.fix.files_changed = diffResult.stdout.toString().trim().split('\n').filter(Boolean)

  wc.phases.fix.status = 'complete'
  wc.status = 'verifying'
  saveWorkCard(wc)
  console.log(`${tag} Fix complete — ${wc.phases.fix.files_changed.length} file(s) changed`)
}

// ─── Phase 3: Verify ─────────────────────────────────────────────────────────

function verifyPhase(wc: FixWorkCard, testFile: string, projectConfig: ProjectConfig): void {
  const tag = `[verify][${wc.run_id}]`
  console.log(`${tag} Final verification...`)

  const lintResult = shiftLeftLint(wc.project, tag, projectConfig.typecheck_cmd)
  wc.gates.lint = lintResult.pass
  wc.gates.typecheck = lintResult.pass
  console.log(`${tag} ${lintResult.message}`)

  if (!lintResult.pass) {
    wc.status = 'failed'
    wc.error = `Final verify failed: ${lintResult.message}`
    wc.phases.verify.status = 'failed'
    saveWorkCard(wc)
    throw new Error(wc.error)
  }

  const testRun = Bun.spawnSync(['bun', 'test', testFile], { cwd: wc.project })
  wc.gates.tests_pass = testRun.exitCode === 0

  if (!wc.gates.tests_pass) {
    const testOut = (testRun.stdout.toString() + testRun.stderr.toString()).slice(0, 2000)
    wc.status = 'failed'
    wc.error = `Final verify: tests still failing:\n${testOut}`
    wc.phases.verify.status = 'failed'
    saveWorkCard(wc)
    throw new Error(wc.error)
  }

  wc.phases.verify.status = 'complete'
  wc.status = 'complete'
  saveWorkCard(wc)
  console.log(`${tag} All gates pass`)
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs()
  const config = loadConfig(args.configPath)

  let projectPath = args.project
  if (!projectPath) {
    console.error('[fix-workflow] ERROR: --project is required')
    process.exit(1)
  }

  const projectConfig = findProjectConfig(config, projectPath)

  // Load ticket
  const storage = new FileStorage(projectPath)
  const ticket = storage.getTicket(args.ticketId)
  if (!ticket) {
    console.error(`[fix-workflow] ERROR: Ticket ${args.ticketId} not found`)
    process.exit(1)
  }

  const runId = generateRunId()
  const branch = Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath })
    .stdout.toString().trim() || 'main'

  const wc: FixWorkCard = {
    run_id: runId,
    ticket_id: args.ticketId,
    status: 'analyzing',
    project: projectPath,
    branch,
    phases: {
      analyze: { status: 'pending' },
      fix: { status: 'pending', task_ids: [], files_changed: [] },
      verify: { status: 'pending' },
    },
    gates: { lint: null, typecheck: null, tests_pass: null },
    error: null,
    retries: 0,
  }
  saveWorkCard(wc)

  console.log(`[fix-workflow] Starting run ${runId}`)
  console.log(`[fix-workflow] Ticket: ${ticket.id} — ${ticket.title}`)
  console.log(`[fix-workflow] Project: ${projectPath}`)
  console.log(`[fix-workflow] Branch: ${branch}`)

  // Phase 1: Analyze
  const context = analyzePhase(wc, ticket, projectConfig)

  // Phase 2: Fix
  await fixPhase(wc, ticket, args.apiUrl, projectConfig, context)

  // Phase 3: Verify
  verifyPhase(wc, context.testFile, projectConfig)

  console.log(`\n[fix-workflow] Run ${runId} complete`)
  console.log(`[fix-workflow] Work card: ${path.join(runDir(runId), 'work-card.yaml')}`)
  console.log(`[fix-workflow] Gates:`)
  for (const [gate, val] of Object.entries(wc.gates)) {
    console.log(`  ${gate}: ${val === null ? 'n/a' : val ? 'PASS' : 'FAIL'}`)
  }
}

main().catch((err) => {
  console.error('[fix-workflow] FATAL:', err)
  process.exit(1)
})
