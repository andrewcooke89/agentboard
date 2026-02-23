/**
 * dualEngine.test.ts — Tests for AGENTBOARD_FORCE_LEGACY_ENGINE env var (P-12, REQ-60/REQ-61)
 *
 * Verifies that the dual-engine feature flag correctly overrides DAG engine selection
 * and forces sequential (legacy) engine for backward compatibility.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { parseWorkflowYAML } from '../workflowSchema'

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const SEQUENTIAL_PIPELINE = `
name: sequential-pipeline
steps:
  - name: step-a
    type: spawn_session
    projectPath: /tmp/a
    prompt: "Do A"
  - name: step-b
    type: spawn_session
    projectPath: /tmp/b
    prompt: "Do B"
`

const DAG_PIPELINE_EXPLICIT = `
name: dag-pipeline
system:
  engine: dag
  session_pool: true
steps:
  - name: pg
    type: parallel_group
    steps:
      - name: task-a
        type: spawn_session
        projectPath: /tmp/a
        prompt: "Do A"
      - name: task-b
        type: spawn_session
        projectPath: /tmp/b
        prompt: "Do B"
`

const DAG_PIPELINE_AUTO_DETECT = `
name: auto-dag-pipeline
steps:
  - name: pg
    type: parallel_group
    steps:
      - name: task-a
        type: spawn_session
        projectPath: /tmp/a
        prompt: "Do A"
      - name: task-b
        type: spawn_session
        projectPath: /tmp/b
        prompt: "Do B"
        depends_on:
          - task-a
`

// ─── Environment Variable Management ────────────────────────────────────────

describe('AGENTBOARD_FORCE_LEGACY_ENGINE feature flag (P-12)', () => {
  let originalEnvValue: string | undefined

  beforeEach(() => {
    originalEnvValue = process.env.AGENTBOARD_FORCE_LEGACY_ENGINE
  })

  afterEach(() => {
    if (originalEnvValue !== undefined) {
      process.env.AGENTBOARD_FORCE_LEGACY_ENGINE = originalEnvValue
    } else {
      delete process.env.AGENTBOARD_FORCE_LEGACY_ENGINE
    }
  })

  // ── TEST-40: Force sequential when env var is true ──────────────────────

  test('TEST-40: AGENTBOARD_FORCE_LEGACY_ENGINE=true forces sequential engine on explicit DAG pipeline', () => {
    process.env.AGENTBOARD_FORCE_LEGACY_ENGINE = 'true'

    const result = parseWorkflowYAML(DAG_PIPELINE_EXPLICIT)
    expect(result.valid).toBe(true)
    expect(result.workflow).toBeDefined()
    expect(result.workflow!.system).toBeDefined()
    expect(result.workflow!.system!.engine).toBe('legacy')
    expect(result.workflow!.system!.autoDetectedEngine).toBe(false)
  })

  test('TEST-40b: AGENTBOARD_FORCE_LEGACY_ENGINE=true forces sequential engine on auto-detected DAG pipeline', () => {
    process.env.AGENTBOARD_FORCE_LEGACY_ENGINE = 'true'

    const result = parseWorkflowYAML(DAG_PIPELINE_AUTO_DETECT)
    expect(result.valid).toBe(true)
    expect(result.workflow).toBeDefined()
    expect(result.workflow!.system).toBeDefined()
    expect(result.workflow!.system!.engine).toBe('legacy')
    expect(result.workflow!.system!.autoDetectedEngine).toBe(false)
  })

  test('TEST-40c: AGENTBOARD_FORCE_LEGACY_ENGINE=true on sequential pipeline sets legacy engine', () => {
    process.env.AGENTBOARD_FORCE_LEGACY_ENGINE = 'true'

    const result = parseWorkflowYAML(SEQUENTIAL_PIPELINE)
    expect(result.valid).toBe(true)
    expect(result.workflow).toBeDefined()
    expect(result.workflow!.system).toBeDefined()
    expect(result.workflow!.system!.engine).toBe('legacy')
  })

  // ── TEST-41: DAG is used when env var is unset/false ────────────────────

  test('TEST-41: DAG engine used when AGENTBOARD_FORCE_LEGACY_ENGINE is unset', () => {
    delete process.env.AGENTBOARD_FORCE_LEGACY_ENGINE

    const result = parseWorkflowYAML(DAG_PIPELINE_EXPLICIT)
    expect(result.valid).toBe(true)
    expect(result.workflow!.system!.engine).toBe('dag')
  })

  test('TEST-41b: DAG engine used when AGENTBOARD_FORCE_LEGACY_ENGINE is false', () => {
    process.env.AGENTBOARD_FORCE_LEGACY_ENGINE = 'false'

    const result = parseWorkflowYAML(DAG_PIPELINE_EXPLICIT)
    expect(result.valid).toBe(true)
    expect(result.workflow!.system!.engine).toBe('dag')
  })

  test('TEST-41c: DAG auto-detection works when env var is unset', () => {
    delete process.env.AGENTBOARD_FORCE_LEGACY_ENGINE

    const result = parseWorkflowYAML(DAG_PIPELINE_AUTO_DETECT)
    expect(result.valid).toBe(true)
    expect(result.workflow!.system!.engine).toBe('dag')
    expect(result.workflow!.system!.autoDetectedEngine).toBe(true)
  })

  test('TEST-41d: DAG auto-detection works when env var is empty string', () => {
    process.env.AGENTBOARD_FORCE_LEGACY_ENGINE = ''

    const result = parseWorkflowYAML(DAG_PIPELINE_AUTO_DETECT)
    expect(result.valid).toBe(true)
    expect(result.workflow!.system!.engine).toBe('dag')
    expect(result.workflow!.system!.autoDetectedEngine).toBe(true)
  })

  // ── TEST-42: Warning when pipeline and env var conflict ─────────────────

  test('TEST-42: Warning logged when pipeline declares engine:dag but env var forces sequential', () => {
    process.env.AGENTBOARD_FORCE_LEGACY_ENGINE = 'true'
    const warnSpy = spyOn(console, 'warn')

    const result = parseWorkflowYAML(DAG_PIPELINE_EXPLICIT)
    expect(result.valid).toBe(true)
    expect(result.workflow!.system!.engine).toBe('legacy')

    // Verify warning was logged about the conflict
    const warnCalls = warnSpy.mock.calls.map(c => c[0] as string)
    const conflictWarning = warnCalls.find(msg =>
      msg.includes('declares engine: dag') && msg.includes('AGENTBOARD_FORCE_LEGACY_ENGINE')
    )
    expect(conflictWarning).toBeDefined()

    warnSpy.mockRestore()
  })

  test('TEST-42b: Override warning always logged when AGENTBOARD_FORCE_LEGACY_ENGINE=true', () => {
    process.env.AGENTBOARD_FORCE_LEGACY_ENGINE = 'true'
    const warnSpy = spyOn(console, 'warn')

    parseWorkflowYAML(SEQUENTIAL_PIPELINE)

    const warnCalls = warnSpy.mock.calls.map(c => c[0] as string)
    const overrideWarning = warnCalls.find(msg =>
      msg.includes('Engine override active') && msg.includes('legacy')
    )
    expect(overrideWarning).toBeDefined()

    warnSpy.mockRestore()
  })

  test('TEST-42c: Warning includes pipeline name', () => {
    process.env.AGENTBOARD_FORCE_LEGACY_ENGINE = 'true'
    const warnSpy = spyOn(console, 'warn')

    parseWorkflowYAML(DAG_PIPELINE_EXPLICIT)

    const warnCalls = warnSpy.mock.calls.map(c => c[0] as string)
    const warningWithName = warnCalls.find(msg => msg.includes('dag-pipeline'))
    expect(warningWithName).toBeDefined()

    warnSpy.mockRestore()
  })

  // ── Edge Cases ──────────────────────────────────────────────────────────

  test('session_pool:false + engine:dag conflict is not triggered when env var forces legacy', () => {
    // When AGENTBOARD_FORCE_LEGACY_ENGINE=true, the engine becomes 'legacy',
    // so session_pool:false + engine:dag should NOT produce an error
    process.env.AGENTBOARD_FORCE_LEGACY_ENGINE = 'true'

    const yaml = `
name: edge-case
system:
  engine: dag
  session_pool: false
steps:
  - name: pg
    type: parallel_group
    steps:
      - name: c1
        type: delay
        seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    // With force legacy, engine becomes 'legacy', so session_pool:false is fine
    expect(result.valid).toBe(true)
    expect(result.workflow!.system!.engine).toBe('legacy')
  })

  test('env var only checked for exact string "true"', () => {
    // Values like "TRUE", "1", "yes" should NOT trigger the override
    const nonTrueValues = ['TRUE', '1', 'yes', 'True', 'on']

    for (const value of nonTrueValues) {
      process.env.AGENTBOARD_FORCE_LEGACY_ENGINE = value

      const result = parseWorkflowYAML(DAG_PIPELINE_AUTO_DETECT)
      expect(result.valid).toBe(true)
      // Auto-detection should still produce DAG for these non-'true' values
      expect(result.workflow!.system!.engine).toBe('dag')
    }
  })

  test('no system config pollution when env var not set and no DAG features', () => {
    delete process.env.AGENTBOARD_FORCE_LEGACY_ENGINE

    const result = parseWorkflowYAML(SEQUENTIAL_PIPELINE)
    expect(result.valid).toBe(true)
    // system should remain undefined for simple sequential pipelines
    expect(result.workflow!.system).toBeUndefined()
  })
})
