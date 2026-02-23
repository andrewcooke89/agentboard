/**
 * amendment-authority.test.ts -- Tests for authority enforcement, review sequences,
 * and authorization policies (Phase 10: TEST-22 through TEST-29)
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
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
  
  shouldAutoReview,
  shouldEscalateToHuman,
  buildResumePrompt,
  buildHandlerPrompt,
  type AmendmentConfig,
  type AmendmentSignal,
} from '../amendmentHandler'

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

function createWorkflowDef(store: WorkflowStore, yaml: string, name: string): WorkflowDefinition {
  return store.createWorkflow({
    name, description: 'Test', yaml_content: yaml, file_path: null,
    is_valid: true, validation_errors: [], step_count: 1,
  })
}

function createTestRun(store: WorkflowStore, wfId: string, steps: StepRunState[], overrides?: Partial<WorkflowRun>): WorkflowRun {
  return store.createRun({
    workflow_id: wfId, workflow_name: 'test', status: 'running',
    current_step_index: 0, steps_state: steps,
    output_dir: '/tmp/test-outputs/authority',
    started_at: new Date().toISOString(),
    completed_at: null, error_message: null, variables: null,
    ...overrides,
  })
}

function getParsed(yaml: string): ParsedWorkflow {
  const result = parseWorkflowYAML(yaml)
  if (!result.valid || !result.workflow) throw new Error(`Invalid YAML: ${result.errors.join(', ')}`)
  return result.workflow
}

function makeSignal(overrides?: Partial<AmendmentSignal['amendment']>): AmendmentSignal {
  return {
    signal_type: 'amendment_required',
    amendment: {
      type: overrides?.type ?? 'gap',
      category: overrides?.category ?? 'quality',
      spec_section: overrides?.spec_section ?? 'auth.login',
      issue: overrides?.issue ?? 'Missing error handling',
      proposed_addition: overrides?.proposed_addition,
      target: overrides?.target ?? 'spec',
    },
    checkpoint: { step: 1 },
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Amendment Authority & Review (TEST-22 through TEST-29)', () => {
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

  // ── TEST-22: Resume from checkpoint ────────────────────────────────────

  test('TEST-22: buildResumePrompt is called with checkpoint data on resolution', () => {
    // Verify buildResumePrompt produces correct output with checkpoint data
    const checkpoint = {
      step: 7,
      progress: 'implementing',
      current_file: 'src/api/routes.ts',
      completed_sections: ['auth', 'users'],
    }
    const amendmentDetails = {
      type: 'gap',
      spec_section: 'api.endpoints',
      issue: 'Missing pagination support',
    }

    const prompt = buildResumePrompt(checkpoint, amendmentDetails, 'approved')

    // Verify checkpoint data is in the prompt
    expect(prompt).toContain('Resume After Amendment')
    expect(prompt).toContain('approved')
    expect(prompt).toContain('"step": 7')
    expect(prompt).toContain('"progress": "implementing"')
    expect(prompt).toContain('"current_file": "src/api/routes.ts"')
    expect(prompt).toContain('api.endpoints')
    expect(prompt).toContain('Missing pagination support')
    expect(prompt).toContain('re-read the relevant spec section')

    // Now test through the DAG engine
    const tmp = tmpdir()
    const signalDir = join(tmp, `dag-resume-22-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const outputDir = join(tmp, `dag-resume-22-out-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(signalDir, { recursive: true })
    mkdirSync(outputDir, { recursive: true })

    try {
      const signalFile = join(signalDir, 'signal-resume.yaml')
      writeFileSync(signalFile, [
        'signal_type: amendment_required',
        'amendment:',
        '  type: gap',
        '  category: quality',
        '  spec_section: api.endpoints',
        '  issue: Missing pagination',
        'checkpoint:',
        '  step: 7',
        '  progress: implementing',
      ].join('\n'))

      writeFileSync(join(outputDir, 'amendment-resolution-test-step.yaml'), [
        'signal_file: signal-resume.yaml',
        'resolution: approved',
        'amendment_id: amend-resume',
        'resolved_at: "2026-01-01T00:00:00Z"',
        'resolved_by: spec-reviewer',
      ].join('\n'))

      const yaml = `
name: resume-22
system:
  engine: dag
steps:
  - name: test-step
    type: spawn_session
    projectPath: /tmp/test
    prompt: "implement API"
`
      const parsed = getParsed(yaml)
      const def = createWorkflowDef(workflowStore, yaml, `resume-22-${Date.now()}`)

      const stepsState = [
        makeStepState({
          name: 'test-step',
          type: 'spawn_session',
          status: 'paused_amendment',
          amendmentPhase: 'handler_complete',
          amendmentSignalFile: signalFile,
          amendmentHandlerTaskId: 'handler-done',
        }),
      ]
      const run = createTestRun(workflowStore, def.id, stepsState, { output_dir: outputDir })

      dagEngine.tick(run, parsed)

      const updated = workflowStore.getRun(run.id)!
      const step = updated.steps_state.find(s => s.name === 'test-step')!

      // Resume task created with checkpoint
      expect(step.taskId).not.toBeNull()
      const resumeTask = taskStore.getTask(step.taskId!)!
      expect(resumeTask.prompt).toContain('Resume After Amendment')
      expect(resumeTask.prompt).toContain('"step": 7')
    } finally {
      rmSync(signalDir, { recursive: true, force: true })
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  // ── TEST-23: Spec authority enforcement ────────────────────────────────

  test('TEST-23: handler prompt includes spec path and amendment details for authority', () => {
    const signal = makeSignal({
      type: 'gap',
      spec_section: 'api.auth',
      issue: 'Missing refresh token endpoint',
      proposed_addition: 'Add POST /auth/refresh',
    })

    const specPath = '/project/spec.md'
    const constitutionSections = ['security', 'auth']
    const checkpoint = { step: 5, progress: 'implementing' }

    const prompt = buildHandlerPrompt(signal, specPath, constitutionSections, checkpoint)

    // Handler prompt should include spec path for authority enforcement
    expect(prompt).toContain(specPath)
    expect(prompt).toContain('api.auth')
    expect(prompt).toContain('Missing refresh token endpoint')
    expect(prompt).toContain('Add POST /auth/refresh')
    expect(prompt).toContain('security, auth')

    // Instructions should guide the handler to review against spec and constitution
    expect(prompt).toContain('Review the amendment against the current spec and constitution')
    expect(prompt).toContain('Write a resolution file with your decision')
  })

  // ── TEST-24: Review-before-write sequence ──────────────────────────────

  test('TEST-24: auto-review processes gap amendments before writing spec changes', () => {
    // Verify the flow: detected -> budget -> auto-review routing -> handler_running
    // The handler is responsible for review-before-write

    const config: AmendmentConfig = {
      auto_review_types: ['gap', 'correction', 'reconciliation'],
    }

    // Gap type should be auto-reviewable
    const gapSignal = makeSignal({ type: 'gap' })
    expect(shouldAutoReview(gapSignal, config)).toBe(true)
    expect(shouldEscalateToHuman(gapSignal, config)).toBe(false)

    // The handler prompt should instruct review before writing
    const prompt = buildHandlerPrompt(
      gapSignal,
      '/spec.md',
      ['quality'],
      { step: 1 },
    )

    // Verify ordering: review instructions come before write instructions
    const reviewIdx = prompt.indexOf('Review the amendment')
    const writeIdx = prompt.indexOf('Write a resolution file')
    expect(reviewIdx).toBeGreaterThan(-1)
    expect(writeIdx).toBeGreaterThan(-1)
    expect(reviewIdx).toBeLessThan(writeIdx)
  })

  // ── TEST-25: Adversarial review -- vague language rejection ────────────

  test('TEST-25: spec-reviewer rejects vague proposed changes via handler routing', () => {
    // The handler prompt instructs the reviewer to evaluate proposed changes.
    // This test verifies that the prompt includes instructions to check validity
    // and that rejected amendments properly mark the resolution.

    const signal = makeSignal({
      type: 'gap',
      spec_section: 'api.endpoints',
      issue: 'Might need something here',
      proposed_addition: 'Maybe add some stuff',
    })

    const prompt = buildHandlerPrompt(signal, '/spec.md', [], { step: 1 })

    // Handler prompt should include the vague proposal for review
    expect(prompt).toContain('Maybe add some stuff')
    expect(prompt).toContain('Determine if the proposed change is valid and consistent')
    expect(prompt).toContain('If rejected: explain why the amendment is not appropriate')

    // Test that rejected resolution is properly handled through DAG engine
    const tmp = tmpdir()
    const signalDir = join(tmp, `dag-reject-25-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const outputDir = join(tmp, `dag-reject-25-out-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(signalDir, { recursive: true })
    mkdirSync(outputDir, { recursive: true })

    try {
      const signalFile = join(signalDir, 'signal-vague.yaml')
      writeFileSync(signalFile, [
        'signal_type: amendment_required',
        'amendment:',
        '  type: gap',
        '  category: quality',
        '  spec_section: api.endpoints',
        '  issue: Might need something',
        '  proposed_addition: Maybe add stuff',
        'checkpoint:',
        '  step: 1',
      ].join('\n'))

      // Write rejected resolution (simulating spec-reviewer rejection)
      writeFileSync(join(outputDir, 'amendment-resolution-test-step.yaml'), [
        'signal_file: signal-vague.yaml',
        'resolution: rejected',
        'amendment_id: amend-reject',
        'resolved_at: "2026-01-01T00:00:00Z"',
        'resolved_by: spec-reviewer',
        'spec_changes: Rejected - proposal is too vague to implement',
      ].join('\n'))

      const yaml = `
name: reject-25
system:
  engine: dag
steps:
  - name: test-step
    type: spawn_session
    projectPath: /tmp/test
    prompt: "implement"
`
      const parsed = getParsed(yaml)
      const def = createWorkflowDef(workflowStore, yaml, `reject-25-${Date.now()}`)

      const stepsState = [
        makeStepState({
          name: 'test-step',
          type: 'spawn_session',
          status: 'paused_amendment',
          amendmentPhase: 'handler_complete',
          amendmentSignalFile: signalFile,
          amendmentHandlerTaskId: 'handler-reject',
        }),
      ]
      const run = createTestRun(workflowStore, def.id, stepsState, { output_dir: outputDir })

      dagEngine.tick(run, parsed)

      const updated = workflowStore.getRun(run.id)!
      const step = updated.steps_state.find(s => s.name === 'test-step')!

      // Step should resume with rejection note
      expect(step.status).toBe('running')

      // Resume prompt should contain rejection info
      const resumeTask = taskStore.getTask(step.taskId!)!
      expect(resumeTask.prompt).toContain('rejected')
      expect(resumeTask.prompt).toContain('Continue with the original spec as-is')

      // Verify resolved broadcast with rejection
      const broadcastCalls = (ctx.broadcast as any).mock.calls
      const resolvedBroadcast = broadcastCalls.find(
        (c: any) => c[0]?.type === 'amendment_resolved'
      )
      expect(resolvedBroadcast).toBeTruthy()
      expect(resolvedBroadcast[0].resolution).toBe('rejected')
    } finally {
      rmSync(signalDir, { recursive: true, force: true })
      rmSync(outputDir, { recursive: true, force: true })
    }
  })

  // ── TEST-26: Conflict detection ────────────────────────────────────────

  test('TEST-26: spec-reviewer rejects conflicting amendments via same-section-twice', () => {
    const tmp = tmpdir()
    const signalDir = join(tmp, `dag-conflict-26-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(signalDir, { recursive: true })

    try {
      const yaml = `
name: conflict-26
system:
  engine: dag
steps:
  - name: test-step
    type: amendment_check
    signal_dir: ${signalDir}
    amendment_config:
      same_section_twice: escalate
`
      const parsed = getParsed(yaml)
      const def = createWorkflowDef(workflowStore, yaml, `conflict-26-${Date.now()}`)

      const signalFile = join(signalDir, 'signal-conflict.yaml')
      writeFileSync(signalFile, [
        'signal_type: amendment_required',
        'amendment:',
        '  type: correction',
        '  category: quality',
        '  spec_section: db.schema',
        '  issue: Column type mismatch',
        'checkpoint:',
        '  step: 2',
      ].join('\n'))

      const stepsState = [
        makeStepState({
          name: 'test-step',
          type: 'amendment_check' as any,
          status: 'paused_amendment',
          amendmentPhase: 'detected',
          amendmentSignalFile: signalFile,
        }),
      ]
      const run = createTestRun(workflowStore, def.id, stepsState)

      // Insert a prior amendment for the SAME section (db.schema)
      workflowStore.insertAmendment({
        run_id: run.id,
        step_name: 'test-step',
        signal_file: '/prior-signal.yaml',
        amendment_type: 'gap',
        category: 'quality',
        spec_section: 'db.schema',
        issue: 'Earlier db.schema amendment',
      })

      dagEngine.tick(run, parsed)

      const updated = workflowStore.getRun(run.id)!
      const step = updated.steps_state.find(s => s.name === 'test-step')!

      // Conflict detected (same section twice) -> escalate
      expect(step.status).toBe('paused_escalated')
      expect(step.amendmentPhase).toBe('awaiting_human')

      const broadcastCalls = (ctx.broadcast as any).mock.calls
      const escalatedBroadcast = broadcastCalls.find(
        (c: any) => c[0]?.type === 'amendment_escalated'
      )
      expect(escalatedBroadcast).toBeTruthy()
      expect(escalatedBroadcast[0].reason).toContain('same section')
    } finally {
      rmSync(signalDir, { recursive: true, force: true })
    }
  })

  // ── TEST-27: Unified spec auto-review ──────────────────────────────────

  test('TEST-27: target spec with auto-reviewable types processes automatically', () => {
    const config: AmendmentConfig = {
      auto_review_types: ['gap', 'correction', 'reconciliation'],
    }

    // Spec-targeting gap amendment should be auto-reviewable
    const specGapSignal = makeSignal({ type: 'gap', target: 'spec' })
    expect(shouldAutoReview(specGapSignal, config)).toBe(true)
    expect(shouldEscalateToHuman(specGapSignal, config)).toBe(false)

    // Spec-targeting correction should also be auto-reviewable
    const specCorrectionSignal = makeSignal({ type: 'correction', target: 'spec' })
    expect(shouldAutoReview(specCorrectionSignal, config)).toBe(true)
    expect(shouldEscalateToHuman(specCorrectionSignal, config)).toBe(false)

    // Spec-targeting reconciliation should be auto-reviewable
    const specReconSignal = makeSignal({ type: 'reconciliation', target: 'spec' })
    expect(shouldAutoReview(specReconSignal, config)).toBe(true)
    expect(shouldEscalateToHuman(specReconSignal, config)).toBe(false)
  })

  // ── TEST-28: Constitution always requires human ────────────────────────

  test('TEST-28: constitution target always escalates to human regardless of type', () => {
    const config: AmendmentConfig = {
      auto_review_types: ['gap', 'correction', 'reconciliation'],
    }

    // Constitution-targeting gap should escalate even though gap is auto-reviewable
    const constitutionGap = makeSignal({ type: 'gap', target: 'constitution' })
    expect(shouldEscalateToHuman(constitutionGap, config)).toBe(true)

    // Constitution-targeting correction should also escalate
    const constitutionCorrection = makeSignal({ type: 'correction', target: 'constitution' })
    expect(shouldEscalateToHuman(constitutionCorrection, config)).toBe(true)

    // Now verify through DAG engine
    const tmp = tmpdir()
    const signalDir = join(tmp, `dag-const-28-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(signalDir, { recursive: true })

    try {
      const signalFile = join(signalDir, 'signal-constitution.yaml')
      writeFileSync(signalFile, [
        'signal_type: amendment_required',
        'amendment:',
        '  type: gap',
        '  category: quality',
        '  spec_section: naming-conventions',
        '  issue: Need new naming rule',
        '  target: constitution',
        'checkpoint:',
        '  step: 1',
      ].join('\n'))

      const yaml = `
name: const-28
system:
  engine: dag
steps:
  - name: test-step
    type: amendment_check
    signal_dir: ${signalDir}
    amendment_config:
      auto_review_types: [gap, correction]
`
      const parsed = getParsed(yaml)
      const def = createWorkflowDef(workflowStore, yaml, `const-28-${Date.now()}`)

      const stepsState = [
        makeStepState({
          name: 'test-step',
          type: 'amendment_check' as any,
          status: 'paused_amendment',
          amendmentPhase: 'detected',
          amendmentSignalFile: signalFile,
        }),
      ]
      const run = createTestRun(workflowStore, def.id, stepsState)
      workflowStore.initRunBudgets(run.id, { quality: { per_run: 10 } })

      dagEngine.tick(run, parsed)

      const updated = workflowStore.getRun(run.id)!
      const step = updated.steps_state.find(s => s.name === 'test-step')!

      // Constitution target -> always human escalation
      expect(step.status).toBe('paused_escalated')
      expect(step.amendmentPhase).toBe('awaiting_human')
    } finally {
      rmSync(signalDir, { recursive: true, force: true })
    }
  })

  // ── TEST-29: Custom authorization policy ───────────────────────────────

  test('TEST-29: per-target authorization config controls routing', () => {
    // Test custom auto_review_types and human_required_types
    const restrictiveConfig: AmendmentConfig = {
      auto_review_types: ['reconciliation'],  // Only reconciliation is auto-reviewable
      human_required_types: ['fundamental', 'scope_change', 'gap'],  // Gap requires human
    }

    // Gap should require human with this config
    const gapSignal = makeSignal({ type: 'gap' })
    expect(shouldAutoReview(gapSignal, restrictiveConfig)).toBe(false)
    expect(shouldEscalateToHuman(gapSignal, restrictiveConfig)).toBe(true)

    // Reconciliation should be auto-reviewable
    const reconSignal = makeSignal({ type: 'reconciliation' })
    expect(shouldAutoReview(reconSignal, restrictiveConfig)).toBe(true)
    expect(shouldEscalateToHuman(reconSignal, restrictiveConfig)).toBe(false)

    // Correction is not in auto_review_types nor human_required_types
    const correctionSignal = makeSignal({ type: 'correction' })
    expect(shouldAutoReview(correctionSignal, restrictiveConfig)).toBe(false)
    expect(shouldEscalateToHuman(correctionSignal, restrictiveConfig)).toBe(false)

    // Tier-based escalation
    const tierConfig: AmendmentConfig = {
      human_required_tiers: [0, 1],  // Tiers 0 and 1 require human
    }

    const normalSignal = makeSignal({ type: 'gap' })
    expect(shouldEscalateToHuman(normalSignal, tierConfig, 0)).toBe(true)
    expect(shouldEscalateToHuman(normalSignal, tierConfig, 1)).toBe(true)
    expect(shouldEscalateToHuman(normalSignal, tierConfig, 2)).toBe(false)
    expect(shouldEscalateToHuman(normalSignal, tierConfig, 3)).toBe(false)
  })
})
