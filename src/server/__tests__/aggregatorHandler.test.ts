import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  executeAggregator,
  writeAggregatorOutput,

  type AggregatorResult,
  type Finding,
} from '../aggregatorHandler'
import type { WorkflowStep, WorkflowRun } from '../../shared/types'

// ── Test Fixtures ─────────────────────────────────────────────────────────────

const TEMP_DIR = '/tmp/agentboard-agg-test-' + Date.now()

function setupTempDir(): void {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true })
  }
}

function cleanupTempDir(): void {
  try {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true })
  } catch { /* ignore */ }
}

function writeJsonFile(filename: string, data: unknown): string {
  const fullPath = path.join(TEMP_DIR, filename)
  const dir = path.dirname(fullPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(fullPath, JSON.stringify(data, null, 2), 'utf-8')
  return fullPath
}

function makeRun(overrides?: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: 'test-run-123',
    workflow_id: 'wf-1',
    workflow_name: 'test-workflow',
    status: 'running',
    current_step_index: 0,
    steps_state: [],
    output_dir: TEMP_DIR,
    started_at: new Date().toISOString(),
    completed_at: null,
    error_message: null,
    variables: null,
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

function makeStep(overrides?: Partial<WorkflowStep>): WorkflowStep {
  return {
    name: 'aggregator-step',
    type: 'aggregator',
    input_steps: ['step1'],
    ...overrides,
  }
}

function _makeFinding(overrides?: Partial<Finding>): Finding {
  return {
    file_path: '/src/test.ts',
    line_number: 42,
    category: 'bug',
    severity: 'medium',
    message: 'Test finding',
    ...overrides,
  }
}

// ── Deduplication Tests ────────────────────────────────────────────────────────

describe('executeAggregator - deduplication', () => {
  beforeEach(setupTempDir)
  afterEach(cleanupTempDir)

  test('deduplicates by file+line', () => {
    // Create input step outputs
    writeJsonFile('step1/output.json', {
      findings: [
        { file_path: '/src/a.ts', line_number: 10, message: 'Issue 1' },
        { file_path: '/src/a.ts', line_number: 10, message: 'Duplicate' },
        { file_path: '/src/b.ts', line_number: 20, message: 'Issue 2' },
      ],
    })

    const step = makeStep({
      input_steps: ['step1'],
      dedup_key: 'file_path+line_number',
    })

    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)

    expect(result.stats.total_input_findings).toBe(3)
    expect(result.stats.after_dedup).toBe(2)
    expect(result.findings.length).toBe(2)
  })

  test('deduplicates by category', () => {
    writeJsonFile('step1/output.json', {
      findings: [
        { category: 'security', message: 'A' },
        { category: 'security', message: 'B' },
        { category: 'performance', message: 'C' },
      ],
    })

    const step = makeStep({
      input_steps: ['step1'],
      dedup_key: 'category',
    })

    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)

    expect(result.stats.after_dedup).toBe(2)
  })

  test('keeps highest severity on dedup', () => {
    writeJsonFile('step1/output.json', {
      findings: [
        { file_path: '/src/a.ts', line_number: 10, severity: 'low', message: 'A' },
        { file_path: '/src/a.ts', line_number: 10, severity: 'critical', message: 'B' },
        { file_path: '/src/a.ts', line_number: 10, severity: 'medium', message: 'C' },
      ],
    })

    const step = makeStep({
      input_steps: ['step1'],
      dedup_key: 'file_path+line_number',
    })

    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)

    expect(result.findings.length).toBe(1)
    expect(result.findings[0].severity).toBe('critical')
  })

  test('no deduplication when dedup_key not set', () => {
    writeJsonFile('step1/output.json', {
      findings: [
        { file_path: '/src/a.ts', line_number: 10, message: 'A' },
        { file_path: '/src/a.ts', line_number: 10, message: 'B' },
      ],
    })

    const step = makeStep({
      input_steps: ['step1'],
      // No dedup_key
    })

    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)

    expect(result.stats.after_dedup).toBe(2)
  })
})

// ── Evidence Filtering Tests ───────────────────────────────────────────────────

describe('executeAggregator - evidence filtering', () => {
  beforeEach(setupTempDir)
  afterEach(cleanupTempDir)

  test('filters out findings without file_path', () => {
    writeJsonFile('step1/output.json', {
      findings: [
        { file_path: '/src/a.ts', line_number: 10, message: 'Has evidence' },
        { line_number: 20, message: 'No file path' },
        { message: 'No evidence at all' },
      ],
    })

    const step = makeStep({
      input_steps: ['step1'],
      evidence_required: true,
    })

    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)

    expect(result.stats.after_evidence_filter).toBe(1)
    expect(result.findings[0].file_path).toBe('/src/a.ts')
  })

  test('filters out findings without line_number', () => {
    writeJsonFile('step1/output.json', {
      findings: [
        { file_path: '/src/a.ts', line_number: 10, message: 'Complete' },
        { file_path: '/src/b.ts', message: 'No line number' },
      ],
    })

    const step = makeStep({
      input_steps: ['step1'],
      evidence_required: true,
    })

    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)

    expect(result.stats.after_evidence_filter).toBe(1)
  })

  test('does not filter when evidence_required is false', () => {
    writeJsonFile('step1/output.json', {
      findings: [
        { message: 'No evidence' },
        { file_path: '/src/a.ts', line_number: 10, message: 'Has evidence' },
      ],
    })

    const step = makeStep({
      input_steps: ['step1'],
      evidence_required: false,
    })

    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)

    expect(result.stats.after_evidence_filter).toBe(2)
  })
})

// ── Verdict Computation Tests ──────────────────────────────────────────────────

describe('executeAggregator - verdict computation', () => {
  beforeEach(setupTempDir)
  afterEach(cleanupTempDir)

  test('default: PASS when no findings', () => {
    writeJsonFile('step1/output.json', { findings: [] })

    const step = makeStep({ input_steps: ['step1'] })
    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)
    expect(result.verdict).toBe('PASS')
  })

  test('default: FAIL when critical severity', () => {
    writeJsonFile('step1/output.json', {
      findings: [{ severity: 'critical' }],
    })

    const step = makeStep({ input_steps: ['step1'] })
    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)
    expect(result.verdict).toBe('FAIL')
  })

  test('default: FAIL when high severity', () => {
    writeJsonFile('step1/output.json', {
      findings: [{ severity: 'high' }],
    })

    const step = makeStep({ input_steps: ['step1'] })
    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)
    expect(result.verdict).toBe('FAIL')
  })

  test('default: WARN when medium severity', () => {
    writeJsonFile('step1/output.json', {
      findings: [{ severity: 'medium' }],
    })

    const step = makeStep({ input_steps: ['step1'] })
    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)
    expect(result.verdict).toBe('WARN')
  })

  test('default: WARN when low severity with findings', () => {
    writeJsonFile('step1/output.json', {
      findings: [{ severity: 'low' }],
    })

    const step = makeStep({ input_steps: ['step1'] })
    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)
    expect(result.verdict).toBe('WARN')
  })

  test('custom rules: severity >= high triggers FAIL', () => {
    writeJsonFile('step1/output.json', {
      findings: [{ severity: 'high' }],
    })

    const step = makeStep({
      input_steps: ['step1'],
      verdict_rules: [
        { condition: 'severity >= high', verdict: 'FAIL' },
      ],
    })

    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)
    expect(result.verdict).toBe('FAIL')
  })

  test('custom rules: count > 5 triggers WARN', () => {
    writeJsonFile('step1/output.json', {
      findings: [
        { severity: 'low' },
        { severity: 'low' },
        { severity: 'low' },
        { severity: 'low' },
        { severity: 'low' },
        { severity: 'low' },
      ],
    })

    const step = makeStep({
      input_steps: ['step1'],
      verdict_rules: [
        { condition: 'count > 5', verdict: 'WARN' },
      ],
    })

    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)
    expect(result.verdict).toBe('WARN')
  })

  test('custom rules: category match triggers FAIL', () => {
    writeJsonFile('step1/output.json', {
      findings: [{ category: 'security', severity: 'low' }],
    })

    const step = makeStep({
      input_steps: ['step1'],
      verdict_rules: [
        { condition: 'category == security', verdict: 'FAIL' },
      ],
    })

    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)
    expect(result.verdict).toBe('FAIL')
  })

  test('rules evaluated in order, first match wins', () => {
    writeJsonFile('step1/output.json', {
      findings: [{ severity: 'critical' }],
    })

    const step = makeStep({
      input_steps: ['step1'],
      verdict_rules: [
        { condition: 'severity >= medium', verdict: 'WARN' }, // Should match first
        { condition: 'severity >= high', verdict: 'FAIL' },
      ],
    })

    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)
    expect(result.verdict).toBe('WARN') // First matching rule
  })
})

// ── Multi-Step Input Tests ─────────────────────────────────────────────────────

describe('executeAggregator - multiple input steps', () => {
  beforeEach(setupTempDir)
  afterEach(cleanupTempDir)

  test('combines findings from multiple steps', () => {
    writeJsonFile('step1/output.json', {
      findings: [{ file_path: '/a.ts', line_number: 1, message: 'From step1' }],
    })

    writeJsonFile('step2/output.json', {
      findings: [{ file_path: '/b.ts', line_number: 2, message: 'From step2' }],
    })

    const step = makeStep({
      input_steps: ['step1', 'step2'],
    })

    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })
    stepDefMap.set('step2', { name: 'step2', type: 'spawn_session', output_path: 'step2/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)

    expect(result.stats.total_input_findings).toBe(2)
    expect(result.findings.length).toBe(2)
  })

  test('handles missing step output gracefully', () => {
    writeJsonFile('step1/output.json', {
      findings: [{ message: 'Only finding' }],
    })
    // step2 has no output file

    const step = makeStep({
      input_steps: ['step1', 'step2'],
    })

    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })
    stepDefMap.set('step2', { name: 'step2', type: 'spawn_session', output_path: 'step2/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)

    expect(result.stats.total_input_findings).toBe(1)
  })

  test('handles step not in map gracefully', () => {
    writeJsonFile('step1/output.json', {
      findings: [{ message: 'Finding' }],
    })

    const step = makeStep({
      input_steps: ['step1', 'unknown-step'],
    })

    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })
    // unknown-step not in map

    const result = executeAggregator(step, makeRun(), stepDefMap)

    expect(result.stats.total_input_findings).toBe(1)
  })
})

// ── Output Format Tests ────────────────────────────────────────────────────────

describe('writeAggregatorOutput', () => {
  beforeEach(setupTempDir)
  afterEach(cleanupTempDir)

  test('writes JSON output file', () => {
    const result: AggregatorResult = {
      findings: [{ file_path: '/test.ts', line_number: 1, message: 'Test' }],
      verdict: 'PASS',
      stats: { total_input_findings: 1, after_dedup: 1, after_evidence_filter: 1 },
    }

    writeAggregatorOutput(makeRun(), 'output/aggregated.json', result)

    const outputPath = path.join(TEMP_DIR, 'output/aggregated.json')
    expect(fs.existsSync(outputPath)).toBe(true)

    const content = JSON.parse(fs.readFileSync(outputPath, 'utf-8'))
    expect(content.verdict).toBe('PASS')
    expect(content.findings.length).toBe(1)
    expect(content.stats.total_input_findings).toBe(1)
    expect(content.generated_at).toBeDefined()
  })

  test('creates output directory if needed', () => {
    const result: AggregatorResult = {
      findings: [],
      verdict: 'PASS',
      stats: { total_input_findings: 0, after_dedup: 0, after_evidence_filter: 0 },
    }

    writeAggregatorOutput(makeRun(), 'deep/nested/path/output.json', result)

    const outputPath = path.join(TEMP_DIR, 'deep/nested/path/output.json')
    expect(fs.existsSync(outputPath)).toBe(true)
  })

  test('rejects path traversal attempts', () => {
    const result: AggregatorResult = {
      findings: [],
      verdict: 'PASS',
      stats: { total_input_findings: 0, after_dedup: 0, after_evidence_filter: 0 },
    }

    expect(() => {
      writeAggregatorOutput(makeRun(), '../../../etc/passwd', result)
    }).toThrow(/Path traversal/)
  })
})

// ── Input Format Variants Tests ────────────────────────────────────────────────

describe('executeAggregator - input format variants', () => {
  beforeEach(setupTempDir)
  afterEach(cleanupTempDir)

  test('accepts issues array instead of findings', () => {
    writeJsonFile('step1/output.json', {
      issues: [{ message: 'Issue 1' }, { message: 'Issue 2' }],
    })

    const step = makeStep({ input_steps: ['step1'] })
    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)
    expect(result.stats.total_input_findings).toBe(2)
  })

  test('accepts single object as finding', () => {
    writeJsonFile('step1/output.json', {
      message: 'Single finding',
      file_path: '/test.ts',
      line_number: 1,
    })

    const step = makeStep({ input_steps: ['step1'] })
    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)
    expect(result.stats.total_input_findings).toBe(1)
  })

  test('handles malformed JSON gracefully', () => {
    const fullPath = path.join(TEMP_DIR, 'step1/output.json')
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, 'not valid json {', 'utf-8')

    const step = makeStep({ input_steps: ['step1'] })
    const stepDefMap = new Map<string, WorkflowStep>()
    stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

    const result = executeAggregator(step, makeRun(), stepDefMap)
    expect(result.stats.total_input_findings).toBe(0)
  })
})
