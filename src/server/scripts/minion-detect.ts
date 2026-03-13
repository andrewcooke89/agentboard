/**
 * minion-detect.ts -- Deterministic detector runner that creates tickets for findings
 *
 * Runs oxlint, tsc, clippy, and cargo-check on configured projects,
 * deduplicates against existing tickets, and creates new ones for fresh findings.
 *
 * Usage:
 *   bun run src/server/scripts/minion-detect.ts \
 *     [--project /path/to/project] \
 *     [--config ~/.agentboard/minion-projects.yaml]
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import yaml from 'js-yaml'
import { FileStorage } from '/home/andrew-cooke/tools/mcp-servers/ticket-system/src/storage/file-storage'
import { checkDuplicate } from '/home/andrew-cooke/tools/mcp-servers/ticket-system/src/utils/dedup'
import type { Ticket, TicketCategory } from '/home/andrew-cooke/tools/mcp-servers/ticket-system/src/storage/schemas'

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProjectConfig {
  path: string
  language: string
  detectors: string[]
  lint_cmd?: string
  typecheck_cmd?: string
  test_cmd?: string
  fix_model?: string
}

interface MinionConfig {
  projects: ProjectConfig[]
}

interface Finding {
  file: string
  line_start: number
  line_end?: number
  message: string
  code: string
  severity: 'error' | 'warning'
  code_snippet?: string
}

// ─── CLI Arg Parsing ─────────────────────────────────────────────────────────

function parseArgs(): { project?: string; config: string; skipSweep: boolean } {
  const args = process.argv.slice(2)
  let project: string | undefined
  let config = path.join(os.homedir(), '.agentboard', 'minion-projects.yaml')
  let skipSweep = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) {
      project = args[++i]
    } else if (args[i] === '--config' && args[i + 1]) {
      config = args[++i]
    } else if (args[i] === '--skip-sweep') {
      skipSweep = true
    }
  }

  return { project, config, skipSweep }
}

// ─── Config Loading ───────────────────────────────────────────────────────────

function loadConfig(configPath: string): MinionConfig {
  const resolved = configPath.startsWith('~')
    ? path.join(os.homedir(), configPath.slice(1))
    : configPath

  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`)
  }

  const content = fs.readFileSync(resolved, 'utf-8')
  return yaml.load(content) as MinionConfig
}

// ─── Output Parsers ───────────────────────────────────────────────────────────

/** Extract rule code from oxlint message like "eslint(no-unused-vars): ..." */
function extractOxlintCode(message: string): string {
  const match = message.match(/^(\S+?\([^)]+\)):/)
  return match ? match[1] : 'oxlint'
}

function parseOxlint(stdout: string, projectPath: string): Finding[] {
  const findings: Finding[] = []
  const lines = stdout.split('\n')

  let currentSeverity: 'error' | 'warning' | null = null
  let currentMessage = ''
  let currentCode = 'oxlint'
  let currentFile = ''
  let currentLine = 0
  let currentSnippet = ''

  for (const line of lines) {
    // Error indicator: "  x  message" or "  × message"
    const errorMatch = line.match(/^\s+[x×]\s+(.+)$/)
    if (errorMatch) {
      currentSeverity = 'error'
      currentMessage = errorMatch[1].trim()
      currentCode = extractOxlintCode(currentMessage)
      currentFile = ''
      currentLine = 0
      currentSnippet = ''
      continue
    }

    // Warning indicator: "  !  message" or "  ⚠  message"
    const warnMatch = line.match(/^\s+[!⚠]\s+(.+)$/)
    if (warnMatch) {
      currentSeverity = 'warning'
      currentMessage = warnMatch[1].trim()
      currentCode = extractOxlintCode(currentMessage)
      currentFile = ''
      currentLine = 0
      currentSnippet = ''
      continue
    }

    // Location: "  ,-[src/file.ts:42:1]"
    const locMatch = line.match(/,-\[(.+?):(\d+):\d+\]/)
    if (locMatch && currentSeverity) {
      const rawFile = locMatch[1]
      currentFile = path.isAbsolute(rawFile) ? rawFile : path.join(projectPath, rawFile)
      currentLine = parseInt(locMatch[2], 10)
      continue
    }

    // Code snippet line: " 42 |   code here"
    const snippetMatch = line.match(/^\s+\d+\s+\|\s+(.+)$/)
    if (snippetMatch && currentSeverity && !currentSnippet) {
      currentSnippet = snippetMatch[1]
      continue
    }

    // End of block: "`----"
    if (line.match(/`----/) && currentSeverity && currentFile && currentLine) {
      findings.push({
        file: currentFile,
        line_start: currentLine,
        message: currentMessage,
        code: currentCode,
        severity: currentSeverity,
        code_snippet: currentSnippet || undefined,
      })
      currentSeverity = null
      currentMessage = ''
      currentCode = 'oxlint'
      currentFile = ''
      currentLine = 0
      currentSnippet = ''
    }
  }

  return findings
}

function parseTsc(stdout: string): Finding[] {
  const findings: Finding[] = []
  const regex = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/

  for (const line of stdout.split('\n')) {
    const match = line.match(regex)
    if (match) {
      findings.push({
        file: match[1],
        line_start: parseInt(match[2], 10),
        message: match[6].trim(),
        code: match[5],
        severity: 'error',
      })
    }
  }

  return findings
}

function parseClippy(stdout: string): Finding[] {
  return parseCargoJson(stdout)
}

function parseCargoCheck(stdout: string): Finding[] {
  return parseCargoJson(stdout)
}

function parseCargoJson(stdout: string): Finding[] {
  const findings: Finding[] = []

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }

    if (parsed.reason !== 'compiler-message') continue

    const msg = parsed.message as Record<string, unknown> | undefined
    if (!msg) continue

    const level = msg.level as string | undefined
    if (level !== 'warning' && level !== 'error') continue

    const codeObj = msg.code as Record<string, unknown> | null | undefined
    const code = (codeObj?.code as string) ?? 'cargo'
    const message = (msg.message as string) ?? ''
    const spans = (msg.spans as Array<Record<string, unknown>>) ?? []
    const span = spans[0]

    if (!span) continue

    const file = span.file_name as string
    const lineStart = span.line_start as number
    const lineEnd = span.line_end as number | undefined
    const textArr = (span.text as Array<Record<string, unknown>>) ?? []
    const snippet = textArr[0]?.text as string | undefined

    findings.push({
      file,
      line_start: lineStart,
      line_end: lineEnd !== lineStart ? lineEnd : undefined,
      message,
      code,
      severity: level === 'error' ? 'error' : 'warning',
      code_snippet: snippet,
    })
  }

  return findings
}

// ─── Detector Runner ──────────────────────────────────────────────────────────

function runDetector(
  detector: string,
  project: ProjectConfig
): Finding[] {
  const cmdStr = detector === 'oxlint' || detector === 'clippy'
    ? project.lint_cmd
    : project.typecheck_cmd

  if (!cmdStr) {
    console.log(`  [skip] No command configured for detector: ${detector}`)
    return []
  }

  console.log(`  [run] ${detector}: ${cmdStr}`)

  const [cmd, ...args] = cmdStr.split(/\s+/)
  const extraArgs = (detector === 'clippy' || detector === 'cargo-check')
    ? ['--message-format=json']
    : []

  const result = Bun.spawnSync([cmd, ...args, ...extraArgs], {
    cwd: project.path,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdout = new TextDecoder().decode(result.stdout)
  const stderr = new TextDecoder().decode(result.stderr)
  const combined = stdout + (stderr ? '\n' + stderr : '')

  switch (detector) {
    case 'oxlint':
      return parseOxlint(combined, project.path)
    case 'tsc':
      return parseTsc(combined)
    case 'clippy':
      return parseClippy(combined)
    case 'cargo-check':
      return parseCargoCheck(combined)
    default:
      console.log(`  [skip] Unknown detector: ${detector}`)
      return []
  }
}

// ─── Staleness Sweep ─────────────────────────────────────────────────────────

function sweepStaleTickets(storage: FileStorage, projectPath: string, tag: string): void {
  const listResult = storage.listTickets({ status: 'open', limit: 1000, offset: 0, sort_by: 'created', sort_order: 'desc' })

  let removedCount = 0
  let modifiedCount = 0

  for (const summary of listResult.tickets) {
    const ticket = storage.getTicket(summary.id)
    if (!ticket) continue
    if (!ticket.source?.file) continue

    const sourceFile = ticket.source.file

    // Check 1: source file no longer exists
    if (!fs.existsSync(sourceFile)) {
      storage.transitionTicket(ticket.id, 'resolved', {
        reason: 'source file removed',
        resolved_by: 'sweep',
      })
      removedCount++
      continue
    }

    // Check 2: lines were modified after ticket creation
    const lineStart = ticket.source.line_start
    const lineEnd = ticket.source.line_end ?? lineStart
    const createdAt = ticket.created_at

    // Try line-level git log first (-L flag)
    const lineLog = Bun.spawnSync(
      ['git', 'log', '--format=%aI', `-L${lineStart},${lineEnd}:${sourceFile}`],
      { cwd: projectPath },
    )

    let lastModified: string | null = null

    if (lineLog.exitCode === 0) {
      const output = lineLog.stdout.toString().trim()
      // git log -L output has commit info interspersed; find the first ISO date line
      for (const line of output.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.match(/^\d{4}-\d{2}-\d{2}T/)) {
          lastModified = trimmed
          break
        }
      }
    }

    // Fallback: file-level log
    if (!lastModified) {
      const fileLog = Bun.spawnSync(
        ['git', 'log', '-1', '--format=%aI', '--', sourceFile],
        { cwd: projectPath },
      )
      if (fileLog.exitCode === 0) {
        lastModified = fileLog.stdout.toString().trim() || null
      }
    }

    if (lastModified && lastModified > createdAt) {
      storage.transitionTicket(ticket.id, 'resolved', {
        reason: 'source code modified since ticket creation',
        resolved_by: 'sweep',
      })
      modifiedCount++
    }
  }

  const total = removedCount + modifiedCount
  console.log(`${tag} Sweep: ${total} tickets closed (${removedCount} file removed, ${modifiedCount} code modified)`)
}

// ─── Ticket Creation ──────────────────────────────────────────────────────────

function findingToCategory(detector: string): TicketCategory {
  if (detector === 'oxlint' || detector === 'clippy') return 'style'
  return 'error-handling'
}

async function processProject(project: ProjectConfig, skipSweep: boolean): Promise<void> {
  console.log(`\nProject: ${project.path}`)
  const tag = `[minion-detect][${path.basename(project.path)}]`

  const storage = new FileStorage(project.path)

  // Run staleness sweep before detection
  if (!skipSweep) {
    sweepStaleTickets(storage, project.path, tag)
  }

  // Load all existing open tickets for dedup
  const listResult = storage.listTickets({ status: 'open', limit: 1000, offset: 0, sort_by: 'created', sort_order: 'desc' })
  const existingTickets: Ticket[] = []
  for (const summary of listResult.tickets) {
    const ticket = storage.getTicket(summary.id)
    if (ticket) existingTickets.push(ticket)
  }
  console.log(`  Loaded ${existingTickets.length} existing open tickets for dedup`)

  let totalFindings = 0
  let totalCreated = 0
  let totalDupes = 0

  for (const detector of project.detectors) {
    const findings = runDetector(detector, project)
    console.log(`  [${detector}] ${findings.length} findings`)
    totalFindings += findings.length

    const category = findingToCategory(detector)

    for (const finding of findings) {
      const dupResult = checkDuplicate(
        finding.file,
        finding.line_start,
        finding.line_end,
        category,
        finding.code_snippet,
        existingTickets,
        storage.getConfig()
      )

      if (dupResult.is_duplicate) {
        totalDupes++
        continue
      }

      const rawTitle = `[${finding.code}] ${finding.message}`
      const title = rawTitle.length > 120 ? rawTitle.slice(0, 117) + '...' : rawTitle

      const ticket = storage.createTicket({
        category,
        severity: finding.severity === 'error' ? 'high' : 'medium',
        status: 'open',
        source: {
          file: finding.file,
          line_start: finding.line_start,
          line_end: finding.line_end,
          code_snippet: finding.code_snippet ?? '',
        },
        related_locations: [],
        title,
        description: finding.message,
        suggestion: `Fix the ${finding.code} issue`,
        auto_fixable: finding.severity === 'warning',
        effort: 'small',
        found_by: 'minion-detect',
        related_tickets: [],
        tags: ['nightly', detector],
        notes: [],
      })

      existingTickets.push(ticket)
      totalCreated++
    }
  }

  console.log(
    `  Summary: ${totalFindings} findings, ${totalCreated} tickets created, ${totalDupes} duplicates skipped`
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { project: projectFilter, config: configPath, skipSweep } = parseArgs()

  console.log(`minion-detect: loading config from ${configPath}`)
  const config = loadConfig(configPath)

  let projects = config.projects
  if (projectFilter) {
    const resolved = path.resolve(projectFilter)
    projects = projects.filter(p => path.resolve(p.path) === resolved)
    if (projects.length === 0) {
      console.error(`No project matching --project ${projectFilter} found in config`)
      process.exit(1)
    }
  }

  console.log(`Running detectors for ${projects.length} project(s)...`)

  for (const project of projects) {
    await processProject(project, skipSweep)
  }

  console.log('\nDone.')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
