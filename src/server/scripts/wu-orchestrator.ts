/**
 * wu-orchestrator.ts -- Standalone TDD orchestrator for per-work-unit implementation
 *
 * Deterministically walks sorted work units, creating Claude sub-tasks via
 * HTTP API for test-writing and implementation, then verifying RED/GREEN
 * locally with `bun test`.
 *
 * Usage:
 *   bun run src/server/scripts/wu-orchestrator.ts \
 *     --manifest '/path/to/decomposition/manifest.yaml' \
 *     --spec '/path/to/refined-spec.yaml' \
 *     --project-path '/path/to/project' \
 *     --output-dir '/path/to/run/output' \
 *     --api-url 'http://localhost:4040' \
 *     --tier '2'
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { parseManifest, topologicalSort } from '../perWorkUnitEngine'
import type { WorkUnit } from '../perWorkUnitEngine'

// ─── Types ──────────────────────────────────────────────────────────────────

interface Config {
  manifest: string
  spec: string
  projectPath: string
  outputDir: string
  apiUrl: string
  tier: string
  testDir: string
  testCommand: string
  language: string
  framework: string
  model: string
  runId: string
}

interface TestBaseline {
  totalTests: number
  passing: number
  failing: number
  skipped: number
  errors: number
  exitCode: number
  timestamp: string
}

interface TaskResult {
  status: 'completed' | 'failed' | 'cancelled'
  exitCode: number | null
  outputPath: string | null
}

interface WUResult {
  id: string
  status: 'pass' | 'fail' | 'skipped'
  testTaskId: string | null
  implTaskId: string | null
  retries: number
  message: string
}

interface VerifyResult {
  pass: boolean
  message: string
}

// ─── CLI Argument Parsing ───────────────────────────────────────────────────

function parseArgs(): Config {
  const args = process.argv.slice(2)
  const config: Partial<Config> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const next = args[i + 1]
    switch (arg) {
      case '--manifest':
        config.manifest = next; i++; break
      case '--spec':
        config.spec = next; i++; break
      case '--project-path':
        config.projectPath = next; i++; break
      case '--output-dir':
        config.outputDir = next; i++; break
      case '--api-url':
        config.apiUrl = next; i++; break
      case '--tier':
        config.tier = next; i++; break
      case '--test-dir':
        config.testDir = next; i++; break
      case '--test-command':
        config.testCommand = next; i++; break
      case '--language':
        config.language = next; i++; break
      case '--framework':
        config.framework = next; i++; break
      case '--model':
        config.model = next; i++; break
      case '--run-id':
        config.runId = next; i++; break
    }
  }

  const required: (keyof Config)[] = ['manifest', 'spec', 'projectPath', 'outputDir', 'apiUrl']
  for (const key of required) {
    if (!config[key]) {
      console.error(`Missing required argument: --${key.replace(/([A-Z])/g, '-$1').toLowerCase()}`)
      process.exit(1)
    }
  }

  config.tier = config.tier ?? '2'
  config.testDir = config.testDir ?? config.projectPath
  config.testCommand = config.testCommand ?? 'bun test'
  config.language = config.language ?? 'typescript'
  config.framework = config.framework ?? ''
  config.model = config.model ?? 'glm'
  config.runId = config.runId ?? ''
  return config as Config
}

// ─── Test Baseline ──────────────────────────────────────────────────────────

async function captureTestBaseline(testDir: string, testCommand: string): Promise<TestBaseline> {
  const now = new Date().toISOString()
  const [cmd, ...cmdArgs] = testCommand.split(/\s+/)
  try {
    const proc = Bun.spawn([cmd, ...cmdArgs], {
      cwd: testDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    })

    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    await proc.exited
    const exitCode = proc.exitCode ?? 1

    // bun test summary line: "1772 pass | 9 fail | 5 skip"
    const combined = stdout + '\n' + stderr
    const passMatch = combined.match(/(\d+)\s+pass/)
    const failMatch = combined.match(/(\d+)\s+fail/)
    const skipMatch = combined.match(/(\d+)\s+skip/)
    const errorMatch = combined.match(/(\d+)\s+error/)

    const passing = passMatch ? parseInt(passMatch[1], 10) : 0
    const failing = failMatch ? parseInt(failMatch[1], 10) : 0
    const skipped = skipMatch ? parseInt(skipMatch[1], 10) : 0
    const errors = errorMatch ? parseInt(errorMatch[1], 10) : 0

    return {
      totalTests: passing + failing + skipped,
      passing,
      failing,
      skipped,
      errors,
      exitCode,
      timestamp: now,
    }
  } catch (err) {
    console.warn(`[baseline] ${testCommand} failed to run: ${err}`)
    return { totalTests: 0, passing: 0, failing: 0, skipped: 0, errors: 0, exitCode: -1, timestamp: now }
  }
}

// ─── RED / GREEN Verification ───────────────────────────────────────────────

async function verifyRed(testDir: string, testCommand: string, baseline: TestBaseline): Promise<VerifyResult> {
  const current = await captureTestBaseline(testDir, testCommand)
  const newFailures = current.failing - baseline.failing
  const newErrors = current.errors - baseline.errors

  if (newFailures > 0 || newErrors > 0) {
    const parts: string[] = []
    if (newFailures > 0) parts.push(`${newFailures} new failure(s)`)
    if (newErrors > 0) parts.push(`${newErrors} new error(s)`)
    return {
      pass: true,
      message: `RED OK: ${parts.join(', ')} (baseline: ${baseline.failing} fail/${baseline.errors} err, current: ${current.failing} fail/${current.errors} err)`,
    }
  }
  return {
    pass: false,
    message: `RED FAIL: No new test failures or errors (baseline: ${baseline.failing} fail/${baseline.errors} err, current: ${current.failing} fail/${current.errors} err). Tests may be trivially passing.`,
  }
}

async function verifyGreen(testDir: string, testCommand: string, baseline: TestBaseline): Promise<VerifyResult> {
  const current = await captureTestBaseline(testDir, testCommand)
  const newErrors = current.errors - baseline.errors
  const newFailures = current.failing - baseline.failing

  if (newErrors > 0) {
    return {
      pass: false,
      message: `GREEN FAIL: ${newErrors} new import/parse error(s) detected (baseline: ${baseline.errors} err, current: ${current.errors} err)`,
    }
  }
  if (newFailures > 0) {
    return {
      pass: false,
      message: `GREEN FAIL: ${newFailures} new failure(s) remain (baseline: ${baseline.failing} fail, current: ${current.failing} fail)`,
    }
  }
  return {
    pass: true,
    message: `GREEN OK: No new failures or errors (baseline: ${baseline.failing} fail/${baseline.errors} err, current: ${current.failing} fail/${current.errors} err)`,
  }
}

// ─── Task API ───────────────────────────────────────────────────────────────

async function createTask(
  apiUrl: string,
  projectPath: string,
  prompt: string,
  timeoutSeconds = 3600,
  model = 'glm',
): Promise<string> {
  const res = await fetch(`${apiUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath, prompt, timeoutSeconds, metadata: { model } }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to create task: ${res.status} ${text}`)
  }

  const data = (await res.json()) as { id: string }
  return data.id
}

async function pollUntilDone(
  apiUrl: string,
  taskId: string,
  maxWaitMs = 3_600_000,
): Promise<TaskResult> {
  const start = Date.now()
  const pollIntervalMs = 10_000

  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${apiUrl}/api/tasks/${taskId}`)
    if (!res.ok) {
      console.warn(`[poll] GET /api/tasks/${taskId} returned ${res.status}`)
      await Bun.sleep(pollIntervalMs)
      continue
    }

    const task = (await res.json()) as {
      status: string
      exitCode?: number | null
      outputPath?: string | null
    }

    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return {
        status: task.status as TaskResult['status'],
        exitCode: task.exitCode ?? null,
        outputPath: task.outputPath ?? null,
      }
    }

    await Bun.sleep(pollIntervalMs)
  }

  // Timeout: attempt to cancel the task
  console.warn(`[poll] Task ${taskId} timed out after ${maxWaitMs}ms, cancelling...`)
  try {
    await fetch(`${apiUrl}/api/tasks/${taskId}/cancel`, { method: 'POST' })
  } catch {
    // best-effort cancel
  }

  return { status: 'failed', exitCode: null, outputPath: null }
}

// ─── Work Unit File ─────────────────────────────────────────────────────────

function readWorkUnitFile(outputDir: string, wuId: string): string {
  const filePath = path.join(outputDir, 'decomposition', `${wuId}.yaml`)
  if (!fs.existsSync(filePath)) {
    console.warn(`[wu] Work unit file not found: ${filePath}`)
    return ''
  }
  return fs.readFileSync(filePath, 'utf-8')
}

// ─── Prompt Builders ────────────────────────────────────────────────────────

function buildTestPrompt(
  wu: WorkUnit,
  wuYaml: string,
  specExcerpt: string,
  projectPath: string,
  language: string,
  framework: string,
): string {
  return `You are a test writer for a ${framework ? `${framework} ` : ''}${language} project.

## Rules
- Write tests ONLY. Never write implementation code.
- Place test files adjacent to the files they test, using __tests__/ directory convention.
- Use \`import { describe, test, expect } from 'bun:test'\`
- Tests MUST fail initially (they test functionality not yet implemented).
- Cover happy path, error cases, and edge cases from the acceptance criteria.

## Work Unit: ${wu.id}
Scope: ${wu.scope}
Files to test:
${wu.files.join('\n')}

## Work Unit Details
${wuYaml}

## Relevant Spec Excerpt
${specExcerpt}

## Project Path
${projectPath}

Write comprehensive tests for this work unit now.`
}

function buildImplPrompt(
  wu: WorkUnit,
  wuYaml: string,
  specExcerpt: string,
  projectPath: string,
  language: string,
  framework: string,
): string {
  return `You are an implementor for a ${framework ? `${framework} ` : ''}${language} project.

## Rules
- Implement ONLY the files listed in this work unit. Do not modify test files.
- Follow existing code patterns and conventions in the project.
- All tests for this work unit must pass after your implementation.
- Keep implementations simple and focused -- no over-engineering.

## Work Unit: ${wu.id}
Scope: ${wu.scope}
Files to implement:
${wu.files.join('\n')}

## Work Unit Details
${wuYaml}

## Relevant Spec Excerpt
${specExcerpt}

## Project Path
${projectPath}

Implement this work unit now. Make all existing tests pass.`
}

// ─── Result Writers ─────────────────────────────────────────────────────────

function writeResultYaml(outputDir: string, results: WUResult[]): void {
  const passed = results.filter(r => r.status === 'pass').length
  const failed = results.filter(r => r.status === 'fail').length
  const skipped = results.filter(r => r.status === 'skipped').length

  let verdict: string
  if (failed === 0) {
    verdict = 'pass'
  } else if (passed > 0) {
    verdict = 'partial'
  } else {
    verdict = 'fail'
  }

  const report = {
    overall_verdict: verdict,
    completed_at: new Date().toISOString(),
    work_units: results.map(r => ({
      id: r.id,
      status: r.status,
      test_task_id: r.testTaskId,
      impl_task_id: r.implTaskId,
      retries: r.retries,
      message: r.message,
    })),
    statistics: {
      total: results.length,
      passed,
      failed,
      skipped,
    },
  }

  const dir = path.join(outputDir, 'implementation')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'implementation-report.yaml'),
    yaml.dump(report, { lineWidth: 120, noRefs: true }),
    'utf-8',
  )
  console.log(`[report] Wrote implementation-report.yaml (verdict=${verdict})`)
}

function writeSignalFile(outputDir: string, verdict: string, runId: string): void {
  const signal = {
    version: 1,
    signal_type: verdict === 'pass' ? 'completed' : 'error',
    timestamp: new Date().toISOString(),
    agent: 'wu-orchestrator',
    step_name: 'implement',
    run_id: runId,
    checkpoint: {
      last_build_status: verdict === 'pass' ? 'pass' : 'fail',
    },
  }

  const dir = path.join(outputDir, 'signals')
  fs.mkdirSync(dir, { recursive: true })

  // Atomic write: temp file then rename
  const tmpPath = path.join(dir, `.tmp-implement-${Date.now()}.yaml`)
  const finalPath = path.join(dir, 'implement_completed.yaml')
  fs.writeFileSync(tmpPath, yaml.dump(signal, { lineWidth: 120, noRefs: true }), 'utf-8')
  fs.renameSync(tmpPath, finalPath)
  console.log(`[signal] Wrote implement_completed.yaml (signal_type=${signal.signal_type})`)
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = parseArgs()

  console.log('=== WU Orchestrator ===')
  console.log(`  manifest:     ${config.manifest}`)
  console.log(`  spec:         ${config.spec}`)
  console.log(`  project-path: ${config.projectPath}`)
  console.log(`  output-dir:   ${config.outputDir}`)
  console.log(`  api-url:      ${config.apiUrl}`)
  console.log(`  tier:         ${config.tier}`)
  console.log(`  test-dir:     ${config.testDir}`)
  console.log(`  test-command: ${config.testCommand}`)
  console.log(`  language:     ${config.language}`)
  console.log(`  framework:    ${config.framework}`)
  console.log()

  // 1. Load manifest
  const manifestDir = path.dirname(config.manifest)
  const manifestFile = path.basename(config.manifest)
  const manifest = parseManifest(manifestFile, manifestDir)
  if (!manifest || manifest.work_units.length === 0) {
    console.error(`[error] Failed to parse manifest or no work units: ${config.manifest}`)
    process.exit(1)
  }
  console.log(`[manifest] Loaded ${manifest.work_units.length} work units`)

  // 2. Topological sort
  const sorted = topologicalSort(manifest.work_units)
  console.log(`[sort] Execution order: ${sorted.map(wu => wu.id).join(', ')}`)
  console.log()

  // 3. Read refined spec (first 5000 chars as excerpt)
  let specExcerpt = ''
  try {
    const specContent = fs.readFileSync(config.spec, 'utf-8')
    specExcerpt = specContent.slice(0, 5000)
    console.log(`[spec] Loaded refined spec (${specContent.length} chars, using first 5000)`)
  } catch (err) {
    console.warn(`[spec] Failed to read spec: ${err}`)
  }

  // 4. Capture global test baseline
  console.log('[baseline] Capturing initial test baseline...')
  let baseline = await captureTestBaseline(config.testDir, config.testCommand)
  console.log(
    `[baseline] ${baseline.totalTests} tests: ${baseline.passing} pass, ${baseline.failing} fail, ${baseline.skipped} skip, ${baseline.errors} error(s) [exit=${baseline.exitCode}]`,
  )
  if (baseline.exitCode !== 0 && baseline.totalTests === 0) {
    console.warn(`[baseline] WARNING: Test runner exited with code ${baseline.exitCode} and found 0 tests`)
    console.warn(`[baseline] Check --test-dir (${config.testDir}) and --test-command (${config.testCommand})`)
  }
  if (baseline.errors > 0) {
    console.warn(`[baseline] WARNING: Baseline has ${baseline.errors} import/parse error(s)`)
  }
  console.log()

  // 5. Process each WU in sorted order
  const results: WUResult[] = []
  const MAX_IMPL_RETRIES = 2

  for (const wu of sorted) {
    console.log(`=== WU ${wu.id}: ${wu.scope} ===`)

    const wuYaml = readWorkUnitFile(config.outputDir, wu.id)
    if (!wuYaml) {
      console.warn(`[${wu.id}] Skipping: no work unit file found`)
      results.push({
        id: wu.id,
        status: 'skipped',
        testTaskId: null,
        implTaskId: null,
        retries: 0,
        message: 'Work unit file not found',
      })
      continue
    }

    // ── Step A: Test Writer ──────────────────────────────────────────────
    console.log(`[${wu.id}] Creating test-writer task...`)
    let testTaskId: string
    try {
      const testPrompt = buildTestPrompt(wu, wuYaml, specExcerpt, config.projectPath, config.language, config.framework)
      testTaskId = await createTask(config.apiUrl, config.projectPath, testPrompt, 3600, config.model)
      console.log(`[${wu.id}] Test task created: ${testTaskId}`)
    } catch (err) {
      console.error(`[${wu.id}] Failed to create test task: ${err}`)
      results.push({
        id: wu.id,
        status: 'fail',
        testTaskId: null,
        implTaskId: null,
        retries: 0,
        message: `Test task creation failed: ${err}`,
      })
      continue
    }

    console.log(`[${wu.id}] Waiting for test-writer task to complete...`)
    const testResult = await pollUntilDone(config.apiUrl, testTaskId)
    if (testResult.status !== 'completed') {
      console.error(`[${wu.id}] Test task ${testResult.status}: ${testTaskId}`)
      results.push({
        id: wu.id,
        status: 'fail',
        testTaskId,
        implTaskId: null,
        retries: 0,
        message: `Test task ${testResult.status}`,
      })
      continue
    }
    console.log(`[${wu.id}] Test-writer task completed`)

    // ── Step B: Verify RED ───────────────────────────────────────────────
    console.log(`[${wu.id}] Verifying RED (new test failures expected)...`)
    const redResult = await verifyRed(config.testDir, config.testCommand, baseline)
    console.log(`[${wu.id}] ${redResult.message}`)
    if (!redResult.pass) {
      console.warn(`[${wu.id}] RED verification failed, continuing anyway`)
    }

    // ── Step C+D: Implementor with retries ───────────────────────────────
    let implTaskId: string | null = null
    let greenPassed = false
    let retries = 0
    let greenMessage = ''

    for (let attempt = 0; attempt <= MAX_IMPL_RETRIES; attempt++) {
      if (attempt > 0) {
        console.log(`[${wu.id}] Retry ${attempt}/${MAX_IMPL_RETRIES}...`)
        retries = attempt
      }

      // Create implementor task
      console.log(`[${wu.id}] Creating implementor task (attempt ${attempt + 1})...`)
      try {
        const implPrompt = buildImplPrompt(wu, wuYaml, specExcerpt, config.projectPath, config.language, config.framework)
        implTaskId = await createTask(config.apiUrl, config.projectPath, implPrompt, 3600, config.model)
        console.log(`[${wu.id}] Impl task created: ${implTaskId}`)
      } catch (err) {
        console.error(`[${wu.id}] Failed to create impl task: ${err}`)
        greenMessage = `Impl task creation failed: ${err}`
        continue
      }

      console.log(`[${wu.id}] Waiting for implementor task to complete...`)
      const implResult = await pollUntilDone(config.apiUrl, implTaskId)
      if (implResult.status !== 'completed') {
        console.error(`[${wu.id}] Impl task ${implResult.status}: ${implTaskId}`)
        greenMessage = `Impl task ${implResult.status}`
        continue
      }
      console.log(`[${wu.id}] Implementor task completed`)

      // Verify GREEN
      console.log(`[${wu.id}] Verifying GREEN (no new failures expected)...`)
      const greenResult = await verifyGreen(config.testDir, config.testCommand, baseline)
      console.log(`[${wu.id}] ${greenResult.message}`)
      greenMessage = greenResult.message

      if (greenResult.pass) {
        greenPassed = true
        break
      }
    }

    if (greenPassed) {
      console.log(`[${wu.id}] PASS`)
      results.push({
        id: wu.id,
        status: 'pass',
        testTaskId,
        implTaskId,
        retries,
        message: greenMessage,
      })
      // Update baseline to incorporate new tests
      console.log(`[${wu.id}] Updating baseline...`)
      baseline = await captureTestBaseline(config.testDir, config.testCommand)
      console.log(
        `[${wu.id}] New baseline: ${baseline.totalTests} tests, ${baseline.passing} pass, ${baseline.failing} fail`,
      )
    } else {
      console.error(`[${wu.id}] FAIL after ${retries + 1} attempt(s): ${greenMessage}`)
      results.push({
        id: wu.id,
        status: 'fail',
        testTaskId,
        implTaskId,
        retries,
        message: greenMessage,
      })
    }

    console.log()
  }

  // 6. Write report and signal
  const passed = results.filter(r => r.status === 'pass').length
  const failed = results.filter(r => r.status === 'fail').length
  const skipped = results.filter(r => r.status === 'skipped').length

  let verdict: string
  if (failed === 0) {
    verdict = 'pass'
  } else if (passed > 0) {
    verdict = 'partial'
  } else {
    verdict = 'fail'
  }

  writeResultYaml(config.outputDir, results)
  writeSignalFile(config.outputDir, verdict, config.runId)

  console.log('=== Summary ===')
  console.log(`  Total: ${results.length}  Passed: ${passed}  Failed: ${failed}  Skipped: ${skipped}`)
  console.log(`  Verdict: ${verdict}`)

  if (failed > 0) {
    process.exit(1)
  }
}

// ─── Entry ──────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(`[fatal] ${err}`)
  process.exit(1)
})
