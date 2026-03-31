/**
 * amendment-audit.test.ts -- Tests for amendment audit trail, DB-file sync
 * (Phase 10: TEST-35)
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDAGEngine } from '../dagEngine'
import type { DAGEngine } from '../dagEngine'
import { initWorkflowStore } from '../workflowStore'
import type { WorkflowStore } from '../workflowStore'
import { initTaskStore } from '../taskStore'
import type { TaskStore } from '../taskStore'
import { initPoolTables } from '../db'
import { createSessionPool } from '../sessionPool'
import type { SessionPool } from '../sessionPool'
import type { ServerContext } from '../serverContext'
import type { StepRunState, WorkflowDefinition, WorkflowRun } from '../../shared/types'
import { parseWorkflowYAML } from '../workflowSchema'
import type { ParsedWorkflow } from '../workflowSchema'
import {
  writeAmendmentRecord,
  
  type AmendmentSignal,
  type AmendmentResolution,
} from '../amendmentHandler'
import yaml from 'js-yaml'

// ── Test Helpers ─────────────────────────────────────────────────────────────

function _makeStepState(overrides: Partial<StepRunState> & { name: string; type: StepRunState['type'] }): StepRunState {
  return {
    status: 'pending',
    taskId: null,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    retryCount: 0,
    skippedReason: null,
    resultFile: null,
    resultCollected: false,
    resultContent: null,
    ...overrides,
  } as StepRunState
}

function createTestContext(): ServerContext {
  return {
    db: {} as any,
    registry: {} as any,
    sessionManager: {} as any,
    config: {
      workflowPollIntervalMs: 100,
      workflowEngineEnabled: true,
      taskOutputDir: '/tmp/test-outputs',
      taskMaxConcurrent: 5,
      taskPollIntervalMs: 1000,
      taskDefaultTimeoutSeconds: 1800,
      taskRateLimitPerHour: 30,
      allowedRoots: [],
    } as any,
    logger: {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    } as any,
    broadcast: mock(() => {}),
    send: mock(() => {}),
    sockets: new Set(),
    taskStore: {} as any,
    taskWorker: {} as any,
    workflowStore: {} as any,
    workflowEngine: {} as any,
  } as ServerContext
}

function createStores(): { workflowStore: WorkflowStore; taskStore: TaskStore; db: SQLiteDatabase } {
  const db = new SQLiteDatabase(':memory:')
  const workflowStore = initWorkflowStore(db)
  const taskStore = initTaskStore(db)
  initPoolTables(db)
  return { workflowStore, taskStore, db }
}

function createWorkflowDef(store: WorkflowStore, yamlStr: string, name: string): WorkflowDefinition {
  return store.createWorkflow({
    name, description: 'Test', yaml_content: yamlStr, file_path: null,
    is_valid: true, validation_errors: [], step_count: 1,
  })
}

function createTestRun(store: WorkflowStore, wfId: string, steps: StepRunState[], overrides?: Partial<WorkflowRun>): WorkflowRun {
  return store.createRun({
    workflow_id: wfId, workflow_name: 'test', status: 'running',
    current_step_index: 0, steps_state: steps,
    output_dir: '/tmp/test-outputs/audit',
    started_at: new Date().toISOString(),
    completed_at: null, error_message: null, variables: null,
    ...overrides,
  })
}

function _getParsed(yamlStr: string): ParsedWorkflow {
  const result = parseWorkflowYAML(yamlStr)
  if (!result.valid || !result.workflow) throw new Error(`Invalid YAML: ${result.errors.join(', ')}`)
  return result.workflow
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Amendment Audit Trail (TEST-35)', () => {
  let db: SQLiteDatabase
  let workflowStore: WorkflowStore
  let taskStore: TaskStore
  let ctx: ServerContext
  let _dagEngine: DAGEngine
  let pool: SessionPool

  beforeEach(() => {
    const stores = createStores()
    db = stores.db
    workflowStore = stores.workflowStore
    taskStore = stores.taskStore
    ctx = createTestContext()
    pool = createSessionPool(db)
    _dagEngine = createDAGEngine(ctx, workflowStore, taskStore, pool)
  })

  afterEach(() => {
    try { db.close() } catch { /* ok */ }
  })

  // ── TEST-35: DB-file sync ──────────────────────────────────────────────

  test('TEST-35: amendment records exist in both DB and YAML files with matching content', () => {
    const tmp = tmpdir()
    const outputDir = join(tmp, `dag-audit-35-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(outputDir, { recursive: true })

    try {
      // Create a workflow and run
      const def = createWorkflowDef(workflowStore,
        'name: audit-35\nsteps:\n  - name: s\n    type: delay\n    seconds: 1',
        `audit-35-${Date.now()}`)
      const run = createTestRun(workflowStore, def.id, [], { output_dir: outputDir })

      // Insert amendment in DB
      const amendmentId = workflowStore.insertAmendment({
        run_id: run.id,
        step_name: 'test-step',
        signal_file: '/signals/signal-1.yaml',
        amendment_type: 'gap',
        category: 'quality',
        spec_section: 'auth.login',
        issue: 'Missing token validation',
        proposed_change: 'Add JWT validation',
        proposed_by: 'agent-producer',
        proposal_timestamp: 1700000000,
        target: 'spec',
      })

      // Resolve in DB
      workflowStore.resolveAmendment(amendmentId, 'approved', 'spec-reviewer')

      // Get DB record
      const dbAmendments = workflowStore.getAmendmentsByRun(run.id)
      expect(dbAmendments).toHaveLength(1)
      const dbRecord = dbAmendments[0]

      // Write YAML file using the handler utility
      const signal: AmendmentSignal = {
        signal_type: 'amendment_required',
        amendment: {
          type: 'gap',
          category: 'quality',
          spec_section: 'auth.login',
          issue: 'Missing token validation',
          proposed_addition: 'Add JWT validation',
          target: 'spec',
        },
        checkpoint: { step: 1 },
      }
      const resolution: AmendmentResolution = {
        signal_file: '/signals/signal-1.yaml',
        resolution: 'approved',
        amendment_id: amendmentId,
        resolved_at: dbRecord.resolved_at!,
        resolved_by: 'spec-reviewer',
        spec_changes: 'Added JWT validation to auth.login',
      }

      const yamlFilePath = writeAmendmentRecord(outputDir, signal, resolution)

      // Verify YAML file exists
      expect(existsSync(yamlFilePath)).toBe(true)

      // Read YAML file
      const yamlContent = readFileSync(yamlFilePath, 'utf-8')
      const yamlRecord = yaml.load(yamlContent) as Record<string, unknown>

      // Verify DB and YAML content match on key fields
      expect(yamlRecord.amendment_id).toBe(amendmentId)
      expect(yamlRecord.type).toBe(dbRecord.amendment_type)
      expect(yamlRecord.category).toBe(dbRecord.category)
      expect(yamlRecord.spec_section).toBe(dbRecord.spec_section)
      expect(yamlRecord.issue).toBe(dbRecord.issue)
      expect(yamlRecord.resolution).toBe(dbRecord.resolution)
      expect(yamlRecord.resolved_by).toBe(dbRecord.resolved_by)

      // Verify the amendments directory was created
      const amendDir = join(outputDir, 'amendments')
      expect(existsSync(amendDir)).toBe(true)

      // Verify file is in the amendments directory
      const files = readdirSync(amendDir)
      expect(files.length).toBe(1)
      expect(files[0]).toMatch(/^AMEND-.*\.yaml$/)
    } finally {
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  test('TEST-35b: DB amendment record includes all audit columns', () => {
    const def = createWorkflowDef(workflowStore,
      'name: audit-35b\nsteps:\n  - name: s\n    type: delay\n    seconds: 1',
      `audit-35b-${Date.now()}`)
    const run = createTestRun(workflowStore, def.id, [])

    const now = Date.now()
    const amendmentId = workflowStore.insertAmendment({
      run_id: run.id,
      step_name: 'test-step',
      work_unit: 'WU-001',
      signal_file: '/signals/signal-audit.yaml',
      amendment_type: 'correction',
      category: 'quality',
      spec_section: 'db.schema',
      issue: 'Wrong column type',
      proposed_change: 'Change to TEXT',
      proposed_by: 'agent-producer',
      proposal_timestamp: now,
      approval_timestamp: now + 5000,
      rationale: 'Type safety requirement',
      target: 'spec',
    })

    const amendments = workflowStore.getAmendmentsByRun(run.id)
    expect(amendments).toHaveLength(1)
    const a = amendments[0]

    // Verify all audit columns are stored and retrievable
    expect(a.id).toBe(amendmentId)
    expect(a.run_id).toBe(run.id)
    expect(a.step_name).toBe('test-step')
    expect(a.work_unit).toBe('WU-001')
    expect(a.signal_file).toBe('/signals/signal-audit.yaml')
    expect(a.amendment_type).toBe('correction')
    expect(a.category).toBe('quality')
    expect(a.spec_section).toBe('db.schema')
    expect(a.issue).toBe('Wrong column type')
    expect(a.proposed_change).toBe('Change to TEXT')
    expect(a.proposed_by).toBe('agent-producer')
    expect(a.proposal_timestamp).toBe(now)
    expect(a.approval_timestamp).toBe(now + 5000)
    expect(a.rationale).toBe('Type safety requirement')
    expect(a.target).toBe('spec')
    expect(a.created_at).toBeTruthy()
  })
})
