// Work Order API routes for the minion swarm dispatcher.
//
// Endpoints:
//   POST   /api/wo              — Create a work order (validates schema)
//   GET    /api/wo              — List work orders (optionally filter by group)
//   GET    /api/wo/:id          — Get a single work order
//   DELETE /api/wo/:id          — Delete a work order
//   POST   /api/wo/dispatch     — Dispatch a group through the executor
//   GET    /api/wo/dispatch/:id — Get dispatch status
//
// WOs are stored as YAML files in ~/.agentboard/work-orders/{group_id}/

import { Hono } from 'hono'
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { fileLockRegistry } from './fileLockRegistry'

const homeDir = process.env.HOME || process.env.USERPROFILE || ''
const WO_BASE_DIR = process.env.WO_DIR || path.join(homeDir, '.agentboard', 'work-orders')
const DISPATCH_LOG_DIR = path.join(homeDir, '.agentboard', 'dispatch-logs')
const EXECUTOR_BINARY = process.env.MINION_EXECUTOR || path.join(homeDir, 'tools', 'agentboard', 'target', 'release', 'minion-executor')
const EXECUTOR_CONFIG = process.env.MINION_EXECUTOR_CONFIG || path.join(homeDir, '.agentboard', 'minion-executor.yaml')

// ── Required WO fields ──────────────────────────────────────────────────────

const REQUIRED_FIELDS = ['id', 'group_id', 'title', 'description', 'task'] as const
const VALID_TASKS = ['implement', 'test', 'fix', 'refactor', 'review']

interface WoFile {
  id: string
  group_id: string
  title: string
  description: string
  task: string
  scope?: string
  depends_on?: string[]
  [key: string]: unknown
}

// ── Active dispatches (in-memory) ────────────────────────────────────────────

interface DispatchRecord {
  id: string
  groupId: string
  status: 'running' | 'completed' | 'failed'
  pid?: number
  startedAt: string
  completedAt?: string
  result?: unknown
  error?: string
  logFile: string
}

const activeDispatches = new Map<string, DispatchRecord>()

// ── Helpers ──────────────────────────────────────────────────────────────────

function groupDir(groupId: string): string {
  return path.join(WO_BASE_DIR, groupId)
}

function woFilePath(groupId: string, woId: string): string {
  return path.join(groupDir(groupId), `${woId}.yaml`)
}

function generateDispatchId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function validateWo(body: Record<string, unknown>): string | null {
  for (const field of REQUIRED_FIELDS) {
    if (!body[field] || (typeof body[field] === 'string' && !String(body[field]).trim())) {
      return `Missing required field: ${field}`
    }
  }

  const task = String(body.task).toLowerCase()
  if (!VALID_TASKS.includes(task)) {
    return `Invalid task type: ${body.task}. Must be one of: ${VALID_TASKS.join(', ')}`
  }

  const id = String(body.id).trim()
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return 'id must contain only alphanumeric characters, hyphens, and underscores'
  }

  const groupId = String(body.group_id).trim()
  if (!/^[A-Za-z0-9_-]+$/.test(groupId)) {
    return 'group_id must contain only alphanumeric characters, hyphens, and underscores'
  }

  // Validate depends_on references are strings
  if (body.depends_on && !Array.isArray(body.depends_on)) {
    return 'depends_on must be an array'
  }

  return null
}

function woToYaml(wo: Record<string, unknown>): string {
  // Simple YAML serializer for WO objects.
  // Uses serde_yaml-compatible output format.
  const lines: string[] = []

  const scalarFields = ['id', 'group_id', 'title', 'task', 'scope']
  for (const field of scalarFields) {
    if (wo[field] !== undefined && wo[field] !== null) {
      const val = String(wo[field])
      // Escape internal quotes and backslashes for valid YAML double-quoted strings
      const escaped = val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      lines.push(`${field}: "${escaped}"`)
    }
  }

  // Description as block scalar
  if (wo.description) {
    lines.push('description: |')
    for (const line of String(wo.description).split('\n')) {
      lines.push(`  ${line}`)
    }
  }

  // Array fields
  const arrayFields = ['full_context_files', 'interface_files', 'reference_files', 'input_files', 'depends_on', 'prefer_after']
  for (const field of arrayFields) {
    const val = wo[field]
    if (Array.isArray(val) && val.length > 0) {
      lines.push(`${field}:`)
      for (const item of val) {
        lines.push(`  - ${item}`)
      }
    } else {
      lines.push(`${field}: []`)
    }
  }

  // Nested objects — intern_context
  const ic = (wo.intern_context || {}) as Record<string, unknown>
  lines.push('intern_context:')
  lines.push(`  enabled: ${ic.enabled ?? true}`)
  lines.push(`  search_depth: ${ic.search_depth ?? 1}`)
  const icTools = Array.isArray(ic.tools) ? ic.tools : ['file_dependencies']
  lines.push('  tools:')
  for (const t of icTools) lines.push(`    - ${t}`)

  // Gates
  const gates = (wo.gates || {}) as Record<string, unknown>
  lines.push('gates:')
  lines.push(`  compile: ${gates.compile ?? true}`)
  lines.push(`  lint: ${gates.lint ?? true}`)
  lines.push(`  typecheck: ${gates.typecheck ?? true}`)
  const tests = (gates.tests || {}) as Record<string, unknown>
  lines.push('  tests:')
  lines.push(`    run: ${tests.run ?? false}`)
  lines.push(`    scope: ${tests.scope ?? 'relevant'}`)
  const specific = Array.isArray(tests.specific) ? tests.specific : []
  lines.push(`    specific: [${specific.join(', ')}]`)
  lines.push(`    expect: ${tests.expect ?? 'pass'}`)

  // Execution
  const exec = (wo.execution || {}) as Record<string, unknown>
  lines.push('execution:')
  lines.push(`  mode: ${exec.mode ?? 'unattended'}`)
  lines.push(`  model: ${exec.model ?? 'glm-5'}`)
  lines.push(`  max_retries: ${exec.max_retries ?? 2}`)
  lines.push(`  timeout_minutes: ${exec.timeout_minutes ?? 5}`)

  // Escalation
  const esc = (wo.escalation || {}) as Record<string, unknown>
  lines.push('escalation:')
  lines.push(`  enabled: ${esc.enabled ?? false}`)
  lines.push(`  after_retries: ${esc.after_retries ?? 2}`)
  lines.push(`  to: ${esc.to ?? 'opus'}`)
  lines.push(`  mode: ${esc.mode ?? 'attended'}`)
  lines.push(`  include_error_context: ${esc.include_error_context ?? true}`)

  // Isolation
  const iso = (wo.isolation || {}) as Record<string, unknown>
  lines.push('isolation:')
  lines.push(`  type: ${iso.type ?? 'none'}`)
  lines.push(`  base: ${iso.base ?? 'HEAD'}`)

  // Output
  const out = (wo.output || {}) as Record<string, unknown>
  lines.push('output:')
  lines.push(`  commit: ${out.commit ?? true}`)
  lines.push(`  commit_prefix: "${out.commit_prefix ?? 'feat'}"`)

  return lines.join('\n') + '\n'
}

function parseYamlFile(filePath: string): WoFile | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    // Simple YAML parsing — extract key fields. For full fidelity the executor
    // parses with serde_yaml, so we just need enough for the API response.
    const lines = content.split('\n')
    const result: Record<string, unknown> = {}

    for (const line of lines) {
      const match = line.match(/^(\w[\w_]*)\s*:\s*"?([^"]*)"?\s*$/)
      if (match) {
        const [, key, value] = match
        result[key] = value
      }
      // Parse depends_on array
      if (line.trim() === 'depends_on:') {
        const deps: string[] = []
        const idx = lines.indexOf(line)
        for (let i = idx + 1; i < lines.length; i++) {
          const depMatch = lines[i].match(/^\s+-\s+(.+)$/)
          if (depMatch) deps.push(depMatch[1].trim())
          else break
        }
        result.depends_on = deps
      }
      // Parse full_context_files array
      if (line.trim() === 'full_context_files:') {
        const files: string[] = []
        const idx = lines.indexOf(line)
        for (let i = idx + 1; i < lines.length; i++) {
          const fileMatch = lines[i].match(/^\s+-\s+(.+)$/)
          if (fileMatch) files.push(fileMatch[1].trim())
          else break
        }
        result.full_context_files = files
      }
    }

    if (result.id && result.group_id && result.title) {
      return result as unknown as WoFile
    }
    return null
  } catch (e) {
    console.error('Error parsing YAML file:', e)
    return null
  }
}

// ── Route registration ───────────────────────────────────────────────────────

export function registerWoRoutes(app: Hono): void {
  // Ensure base directories exist
  fs.mkdirSync(WO_BASE_DIR, { recursive: true, mode: 0o755 })
  fs.mkdirSync(DISPATCH_LOG_DIR, { recursive: true, mode: 0o755 })

  // --- Create a work order ---
  app.post('/api/wo', async (c) => {
    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const validationError = validateWo(body)
    if (validationError) {
      return c.json({ error: validationError }, 400)
    }

    const id = String(body.id).trim()
    const groupId = String(body.group_id).trim()
    const dir = groupDir(groupId)
    const filePath = woFilePath(groupId, id)

    // Check for duplicate
    if (fs.existsSync(filePath)) {
      return c.json({ error: `Work order ${id} already exists in group ${groupId}` }, 409)
    }

    // Write YAML
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
    const yaml = woToYaml(body)
    fs.writeFileSync(filePath, yaml, 'utf-8')

    return c.json({ id, group_id: groupId, path: filePath }, 201)
  })

  // --- List work orders ---
  app.get('/api/wo', (c) => {
    const groupFilter = c.req.query('group')
    const results: WoFile[] = []

    try {
      const groups = groupFilter ? [groupFilter] : fs.readdirSync(WO_BASE_DIR)
      for (const group of groups) {
        const dir = path.join(WO_BASE_DIR, group)
        if (!fs.statSync(dir).isDirectory()) continue

        for (const file of fs.readdirSync(dir)) {
          if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
          const wo = parseYamlFile(path.join(dir, file))
          if (wo) results.push(wo)
        }
      }
    } catch (e) {
      // Directory might not exist yet
      console.error('Error listing work orders:', e)
    }

    return c.json({ work_orders: results, count: results.length })
  })

  // --- Get locked files ---
  app.get('/api/wo/locks', (c) => {
    const lockedFiles = fileLockRegistry.getLockedFiles()
    const locks = Array.from(lockedFiles.entries()).map(([file, entry]) => ({
      file,
      dispatchId: entry.dispatchId,
      woId: entry.woId,
      ticketId: entry.ticketId,
      lockedAt: entry.lockedAt,
    }))
    return c.json({ locks, count: locks.length })
  })

  // --- Get a single work order ---
  app.get('/api/wo/:id', (c) => {
    const woId = c.req.param('id')

    // Search across all groups
    try {
      const groups = fs.readdirSync(WO_BASE_DIR)
      for (const group of groups) {
        const filePath = woFilePath(group, woId)
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf-8')
          const wo = parseYamlFile(filePath)
          return c.json({ ...wo, raw_yaml: content })
        }
      }
    } catch (e) {
      console.error('Error reading work order:', e)
    }

    return c.json({ error: `Work order ${woId} not found` }, 404)
  })

  // --- Delete a work order ---
  app.delete('/api/wo/:id', (c) => {
    const woId = c.req.param('id')

    try {
      const groups = fs.readdirSync(WO_BASE_DIR)
      for (const group of groups) {
        const filePath = woFilePath(group, woId)
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath)
          return c.json({ deleted: woId, group })
        }
      }
    } catch (e) {
      console.error('Error deleting work order:', e)
    }

    return c.json({ error: `Work order ${woId} not found` }, 404)
  })

  // --- Dispatch a group ---
  app.post('/api/wo/dispatch', async (c) => {
    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const groupId = body.group_id ? String(body.group_id).trim() : ''
    if (!groupId) {
      return c.json({ error: 'group_id is required' }, 400)
    }

    const dir = groupDir(groupId)
    if (!fs.existsSync(dir)) {
      return c.json({ error: `Group ${groupId} not found` }, 404)
    }

    // Check there are YAML files in the group
    const yamlFiles = fs.readdirSync(dir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    if (yamlFiles.length === 0) {
      return c.json({ error: `Group ${groupId} has no work orders` }, 400)
    }

    // Check for file conflicts — parse each WO and lock its full_context_files
    const dispatchId = generateDispatchId()
    const lockedForThisDispatch: string[] = []
    for (const yamlFile of yamlFiles) {
      const wo = parseYamlFile(path.join(dir, yamlFile))
      const contextFiles: string[] = Array.isArray((wo as any)?.full_context_files)
        ? (wo as any).full_context_files as string[]
        : []
      for (const file of contextFiles) {
        if (!file) continue
        if (!fileLockRegistry.tryLock(file, dispatchId, { woId: wo?.id })) {
          // Conflict — release all locks we just acquired and return 409
          fileLockRegistry.releaseByDispatch(dispatchId)
          const lock = fileLockRegistry.getLock(file)
          return c.json(
            { error: 'File conflict', locked_files: [file], locked_by: lock },
            409,
          )
        }
        lockedForThisDispatch.push(file)
      }
    }

    const workingDir = body.working_dir ? String(body.working_dir) : process.cwd()
    const concurrency = Number(body.concurrency) || 4
    const maxFailures = Number(body.max_failures) || 3

    const logFile = path.join(DISPATCH_LOG_DIR, `${dispatchId}.log`)
    const dbPath = path.join(DISPATCH_LOG_DIR, `${dispatchId}.db`)

    // Build executor command
    const args = [
      'dispatch',
      '--wos', dir,
      '--concurrency', String(concurrency),
      '--max-failures', String(maxFailures),
      '--db', dbPath,
      '--working-dir', workingDir,
    ]
    if (EXECUTOR_CONFIG) {
      args.push('--config', EXECUTOR_CONFIG)
    }

    const record: DispatchRecord = {
      id: dispatchId,
      groupId,
      status: 'running',
      startedAt: new Date().toISOString(),
      logFile,
    }

    // Spawn the dispatcher process
    try {
      const logStream = fs.createWriteStream(logFile, { flags: 'a' })

      const child = spawn(EXECUTOR_BINARY, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      })

      record.pid = child.pid

      // Capture stdout (JSON result) and stderr (logs)
      let stdout = ''
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
      child.stderr.pipe(logStream)

      child.on('close', (code) => {
        logStream.end()
        fileLockRegistry.releaseByDispatch(dispatchId)
        record.completedAt = new Date().toISOString()

        if (code === 0) {
          record.status = 'completed'
          try {
            record.result = JSON.parse(stdout)
          } catch {
            record.result = { raw_output: stdout }
          }
        } else {
          record.status = 'failed'
          record.error = stdout || `Process exited with code ${code}`
          try {
            record.result = JSON.parse(stdout)
          } catch {
            record.result = { raw_output: stdout }
          }
        }
      })

      child.on('error', (err) => {
        logStream.end()
        fileLockRegistry.releaseByDispatch(dispatchId)
        record.status = 'failed'
        record.error = err.message
        record.completedAt = new Date().toISOString()
      })
    } catch (err) {
      fileLockRegistry.releaseByDispatch(dispatchId)
      record.status = 'failed'
      record.error = err instanceof Error ? err.message : String(err)
      record.completedAt = new Date().toISOString()
    }

    activeDispatches.set(dispatchId, record)

    return c.json({
      dispatch_id: dispatchId,
      group_id: groupId,
      status: 'running',
      wo_count: yamlFiles.length,
      log_file: logFile,
    }, 202)
  })

  // --- Get dispatch status ---
  app.get('/api/wo/dispatch/:id', (c) => {
    const dispatchId = c.req.param('id')
    const record = activeDispatches.get(dispatchId)

    if (!record) {
      return c.json({ error: `Dispatch ${dispatchId} not found` }, 404)
    }

    return c.json(record)
  })

  // --- List dispatches ---
  app.get('/api/wo/dispatches', (c) => {
    const dispatches = Array.from(activeDispatches.values())
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))

    return c.json({ dispatches, count: dispatches.length })
  })
}
