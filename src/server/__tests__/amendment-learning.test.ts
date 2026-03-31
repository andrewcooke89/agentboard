/**
 * amendment-learning.test.ts -- Tests for amendment history API and learning observer
 * (Phase 10: TEST-33 and TEST-34)
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
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
import yaml from 'js-yaml'

// ── Test Helpers ─────────────────────────────────────────────────────────────

function makeStepState(overrides: Partial<StepRunState> & { name: string; type: StepRunState['type'] }): StepRunState {
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
    output_dir: '/tmp/test-outputs/learning',
    started_at: new Date().toISOString(),
    completed_at: null, error_message: null, variables: null,
    ...overrides,
  })
}

function getParsed(yamlStr: string): ParsedWorkflow {
  const result = parseWorkflowYAML(yamlStr)
  if (!result.valid || !result.workflow) throw new Error(`Invalid YAML: ${result.errors.join(', ')}`)
  return result.workflow
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Amendment Learning & History (TEST-33 and TEST-34)', () => {
  let db: SQLiteDatabase
  let workflowStore: WorkflowStore
  let taskStore: TaskStore
  let ctx: ServerContext
  let dagEngine: DAGEngine
  let pool: SessionPool

  beforeEach(() => {
    const stores = createStores()
    db = stores.db
    workflowStore = stores.workflowStore
    taskStore = stores.taskStore
    ctx = createTestContext()
    pool = createSessionPool(db)
    dagEngine = createDAGEngine(ctx, workflowStore, taskStore, pool)
  })

  afterEach(() => {
    try { db.close() } catch { /* ok */ }
  })

  // ── TEST-33: Amendment history API ─────────────────────────────────────

  test('TEST-33: getAmendmentsByRun returns all amendments for a workflow run', () => {
    const def = createWorkflowDef(workflowStore,
      'name: history-33\nsteps:\n  - name: s\n    type: delay\n    seconds: 1',
      `history-33-${Date.now()}`)
    const run = createTestRun(workflowStore, def.id, [])

    // Insert multiple amendments with different types
    const id1 = workflowStore.insertAmendment({
      run_id: run.id,
      step_name: 'step-1',
      signal_file: '/signals/signal-1.yaml',
      amendment_type: 'gap',
      category: 'quality',
      spec_section: 'auth.login',
      issue: 'Missing token validation',
      proposed_change: 'Add JWT validation',
      proposed_by: 'agent-producer',
      target: 'spec',
    })

    const id2 = workflowStore.insertAmendment({
      run_id: run.id,
      step_name: 'step-2',
      work_unit: 'WU-001',
      signal_file: '/signals/signal-2.yaml',
      amendment_type: 'correction',
      category: 'quality',
      spec_section: 'db.schema',
      issue: 'Wrong column type for timestamps',
      proposed_change: 'Change to TIMESTAMPTZ',
      proposed_by: 'agent-reviewer',
      target: 'spec',
    })

    const id3 = workflowStore.insertAmendment({
      run_id: run.id,
      step_name: 'step-3',
      signal_file: '/signals/signal-3.yaml',
      amendment_type: 'reconciliation',
      category: 'reconciliation',
      spec_section: 'api.endpoints',
      issue: 'Missing pagination parameters',
    })

    // Resolve one amendment
    workflowStore.resolveAmendment(id1, 'approved', 'spec-reviewer')

    // Query all amendments for this run
    const amendments = workflowStore.getAmendmentsByRun(run.id)

    expect(amendments).toHaveLength(3)

    // Verify first amendment (resolved)
    const amend1 = amendments.find(a => a.id === id1)!
    expect(amend1.step_name).toBe('step-1')
    expect(amend1.amendment_type).toBe('gap')
    expect(amend1.category).toBe('quality')
    expect(amend1.spec_section).toBe('auth.login')
    expect(amend1.issue).toBe('Missing token validation')
    expect(amend1.proposed_change).toBe('Add JWT validation')
    expect(amend1.proposed_by).toBe('agent-producer')
    expect(amend1.target).toBe('spec')
    expect(amend1.resolution).toBe('approved')
    expect(amend1.resolved_by).toBe('spec-reviewer')
    expect(amend1.resolved_at).not.toBeNull()

    // Verify second amendment (with work_unit)
    const amend2 = amendments.find(a => a.id === id2)!
    expect(amend2.work_unit).toBe('WU-001')
    expect(amend2.amendment_type).toBe('correction')
    expect(amend2.resolution).toBeNull()  // Not yet resolved

    // Verify third amendment (reconciliation)
    const amend3 = amendments.find(a => a.id === id3)!
    expect(amend3.category).toBe('reconciliation')
    expect(amend3.proposed_change).toBeNull()  // No proposed change

    // Verify section-based query
    const authAmendments = workflowStore.getAmendmentsBySection(run.id, 'auth.login')
    expect(authAmendments).toHaveLength(1)
    expect(authAmendments[0].id).toBe(id1)

    // Verify empty query for different run
    const otherRunAmendments = workflowStore.getAmendmentsByRun('nonexistent-run')
    expect(otherRunAmendments).toHaveLength(0)
  })

  // ── TEST-34: Learning observer integration ─────────────────────────────

  test('TEST-34: quality budget exhaustion writes SCHEMA_GAP to schema_gaps/ directory', () => {
    const tmp = tmpdir()
    const signalDir = join(tmp, `dag-learning-34-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const outputDir = join(tmp, `dag-learning-34-out-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(signalDir, { recursive: true })
    mkdirSync(outputDir, { recursive: true })

    try {
      const signalFile = join(signalDir, 'signal-learning.yaml')
      writeFileSync(signalFile, [
        'signal_type: amendment_required',
        'amendment:',
        '  type: gap',
        '  category: quality',
        '  spec_section: auth.tokens',
        '  issue: Missing refresh token flow',
        'checkpoint:',
        '  step: 5',
      ].join('\n'))

      const yamlStr = `
name: learning-34
system:
  engine: dag
steps:
  - name: test-step
    type: amendment_check
    signal_dir: ${signalDir}
`
      const parsed = getParsed(yamlStr)
      const def = createWorkflowDef(workflowStore, yamlStr, `learning-34-${Date.now()}`)

      const stepsState = [
        makeStepState({
          name: 'test-step',
          type: 'amendment_check' as any,
          status: 'paused_amendment',
          amendmentPhase: 'detected',
          amendmentSignalFile: signalFile,
          amendmentType: 'gap',
          amendmentCategory: 'quality',
          amendmentSpecSection: 'auth.tokens',
        }),
      ]
      const run = createTestRun(workflowStore, def.id, stepsState, { output_dir: outputDir })

      // Initialize budget already exhausted (max 0)
      workflowStore.initRunBudgets(run.id, { quality: { per_run: 0 } })

      dagEngine.tick(run, parsed)

      const updated = workflowStore.getRun(run.id)!
      const step = updated.steps_state.find(s => s.name === 'test-step')!

      // Budget exhausted -> escalate
      expect(step.status).toBe('paused_escalated')
      expect(step.amendmentPhase).toBe('awaiting_human')

      // Verify SCHEMA_GAP file was written to schema_gaps/ directory
      const gapDir = join(outputDir, 'schema_gaps')
      expect(existsSync(gapDir)).toBe(true)

      const gapFiles = readdirSync(gapDir).filter(f => f.startsWith('SCHEMA_GAP_'))
      expect(gapFiles.length).toBeGreaterThanOrEqual(1)

      // Read and verify the gap file content
      const gapContent = readFileSync(join(gapDir, gapFiles[0]), 'utf-8')
      const gapRecord = yaml.load(gapContent) as Record<string, unknown>

      expect(gapRecord.run_id).toBe(run.id)
      expect(gapRecord.step).toBe('test-step')
      expect(gapRecord.category).toBe('quality_budget_exhausted')
      expect(gapRecord.amendment_type).toBe('gap')
      expect(gapRecord.spec_section).toBe('auth.tokens')
      expect(gapRecord.timestamp).toBeTruthy()
    } finally {
      rmSync(signalDir, { recursive: true, force: true })
      rmSync(outputDir, { recursive: true, force: true })
    }
  })
})
