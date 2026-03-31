/**
 * aggregatorHandler.edgeCases.test.ts - Edge case tests for aggregator handler
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  executeAggregator,
  writeAggregatorOutput,
  type AggregatorResult,

} from '../aggregatorHandler'
import type { WorkflowStep, WorkflowRun } from '../../shared/types'

const TEMP_DIR = '/tmp/agentboard-agg-edge-test-' + Date.now()

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

describe('aggregatorHandler - edge cases', () => {
  beforeEach(setupTempDir)
  afterEach(cleanupTempDir)

  describe('malformed input file handling', () => {
    test('handles completely empty file', () => {
      const fullPath = path.join(TEMP_DIR, 'step1/output.json')
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, '', 'utf-8')

      const step = makeStep({ input_steps: ['step1'] })
      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      expect(result.stats.total_input_findings).toBe(0)
      expect(result.findings).toEqual([])
    })

    test('handles file with only whitespace', () => {
      const fullPath = path.join(TEMP_DIR, 'step1/output.json')
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, '   \n\n   ', 'utf-8')

      const step = makeStep({ input_steps: ['step1'] })
      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      expect(result.stats.total_input_findings).toBe(0)
    })

    test('handles file with only null', () => {
      writeJsonFile('step1/output.json', null)

      const step = makeStep({ input_steps: ['step1'] })
      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      expect(result.stats.total_input_findings).toBe(0)
    })

    test('handles truncated JSON', () => {
      const fullPath = path.join(TEMP_DIR, 'step1/output.json')
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, '{"findings": [{"message": "incomplete', 'utf-8')

      const step = makeStep({ input_steps: ['step1'] })
      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      expect(result.stats.total_input_findings).toBe(0)
    })

    test('handles JSON with embedded null bytes', () => {
      const fullPath = path.join(TEMP_DIR, 'step1/output.json')
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      // Null bytes in JSON may cause parse failures
      fs.writeFileSync(fullPath, '{"findings": [{"message": "test\u0000embedded"}]}', 'utf-8')

      const step = makeStep({ input_steps: ['step1'] })
      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

      // Should not crash - may return 0 if JSON.parse fails, or 1 if it succeeds
      const result = executeAggregator(step, makeRun(), stepDefMap)
      // The result depends on whether JSON.parse handles the null byte
      expect(result.stats.total_input_findings).toBeGreaterThanOrEqual(0)
    })

    test('handles non-JSON file (plain text)', () => {
      const fullPath = path.join(TEMP_DIR, 'step1/output.json')
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, 'This is just plain text, not JSON', 'utf-8')

      const step = makeStep({ input_steps: ['step1'] })
      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      expect(result.stats.total_input_findings).toBe(0)
    })

    test('handles deeply nested JSON structure', () => {
      const deeplyNested = {
        findings: [{
          data: {
            level1: {
              level2: {
                level3: {
                  level4: {
                    level5: {
                      message: 'deep finding',
                    },
                  },
                },
              },
            },
          },
        }],
      }
      writeJsonFile('step1/output.json', deeplyNested)

      const step = makeStep({ input_steps: ['step1'] })
      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      expect(result.stats.total_input_findings).toBe(1)
      expect(result.findings[0].data).toBeDefined()
    })
  })

  describe('memory limits (large inputs)', () => {
    test('handles 1000 findings from single step', () => {
      const findings = Array.from({ length: 1000 }, (_, i) => ({
        file_path: `/src/file-${i}.ts`,
        line_number: i,
        message: `Finding ${i}`,
        severity: 'low',
      }))

      writeJsonFile('step1/output.json', { findings })

      const step = makeStep({ input_steps: ['step1'] })
      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      expect(result.stats.total_input_findings).toBe(1000)
    })

    test('handles findings with very long messages', () => {
      const longMessage = 'x'.repeat(100000)
      writeJsonFile('step1/output.json', {
        findings: [
          { file_path: '/src/test.ts', line_number: 1, message: longMessage },
        ],
      })

      const step = makeStep({ input_steps: ['step1'] })
      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      expect(result.stats.total_input_findings).toBe(1)
      expect(result.findings[0].message?.length).toBe(100000)
    })

    test('handles findings with very long file paths', () => {
      const longPath = '/src/' + 'a'.repeat(500) + '/file.ts'
      writeJsonFile('step1/output.json', {
        findings: [
          { file_path: longPath, line_number: 1, message: 'test' },
        ],
      })

      const step = makeStep({ input_steps: ['step1'] })
      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      expect(result.stats.total_input_findings).toBe(1)
    })

    test('handles 10 input steps', () => {
      // Create 10 input steps, each with 10 findings
      for (let i = 0; i < 10; i++) {
        writeJsonFile(`step${i}/output.json`, {
          findings: Array.from({ length: 10 }, (_, j) => ({
            file_path: `/src/file-${i}-${j}.ts`,
            line_number: j,
            message: `Finding from step ${i}`,
          })),
        })
      }

      const step = makeStep({
        input_steps: Array.from({ length: 10 }, (_, i) => `step${i}`),
      })

      const stepDefMap = new Map<string, WorkflowStep>()
      for (let i = 0; i < 10; i++) {
        stepDefMap.set(`step${i}`, {
          name: `step${i}`,
          type: 'spawn_session',
          output_path: `step${i}/output.json`,
        })
      }

      const result = executeAggregator(step, makeRun(), stepDefMap)

      expect(result.stats.total_input_findings).toBe(100)
    })
  })

  describe('empty finding sets', () => {
    test('handles empty findings array', () => {
      writeJsonFile('step1/output.json', { findings: [] })

      const step = makeStep({ input_steps: ['step1'] })
      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      expect(result.stats.total_input_findings).toBe(0)
      expect(result.findings).toEqual([])
      expect(result.verdict).toBe('PASS')
    })

    test('handles missing findings key', () => {
      // When there's no findings/issues array, the entire object is treated as a single finding
      writeJsonFile('step1/output.json', { other_data: 'value' })

      const step = makeStep({ input_steps: ['step1'] })
      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      // The object itself is treated as a single finding
      expect(result.stats.total_input_findings).toBe(1)
      expect(result.findings[0].other_data).toBe('value')
    })

    test('handles all input steps with no findings', () => {
      writeJsonFile('step1/output.json', { findings: [] })
      writeJsonFile('step2/output.json', { findings: [] })
      writeJsonFile('step3/output.json', { findings: [] })

      const step = makeStep({ input_steps: ['step1', 'step2', 'step3'] })
      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })
      stepDefMap.set('step2', { name: 'step2', type: 'spawn_session', output_path: 'step2/output.json' })
      stepDefMap.set('step3', { name: 'step3', type: 'spawn_session', output_path: 'step3/output.json' })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      expect(result.stats.total_input_findings).toBe(0)
      expect(result.verdict).toBe('PASS')
    })
  })

  describe('deduplication edge cases', () => {
    test('deduplicates 100 identical findings', () => {
      const identicalFindings = Array.from({ length: 100 }, () => ({
        file_path: '/src/same.ts',
        line_number: 42,
        message: 'Same issue',
        severity: 'low',
      }))

      writeJsonFile('step1/output.json', { findings: identicalFindings })

      const step = makeStep({
        input_steps: ['step1'],
        dedup_key: 'file_path+line_number',
      })

      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      expect(result.stats.total_input_findings).toBe(100)
      expect(result.stats.after_dedup).toBe(1)
    })

    test('handles findings with null values in dedup key', () => {
      writeJsonFile('step1/output.json', {
        findings: [
          { file_path: null, line_number: 1, message: 'A' },
          { file_path: '/src/test.ts', line_number: 2, message: 'B' },
        ],
      })

      const step = makeStep({
        input_steps: ['step1'],
        dedup_key: 'file_path+line_number',
      })

      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      expect(result.stats.after_dedup).toBe(2)
    })

    test('deduplicates by complex composite key', () => {
      writeJsonFile('step1/output.json', {
        findings: [
          { file_path: '/src/a.ts', line_number: 1, category: 'security', message: 'X' },
          { file_path: '/src/a.ts', line_number: 1, category: 'security', message: 'Y' },
          { file_path: '/src/a.ts', line_number: 1, category: 'performance', message: 'Z' },
        ],
      })

      const step = makeStep({
        input_steps: ['step1'],
        dedup_key: 'file_path+line_number+category',
      })

      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      // First two should dedupe (same file+line+category), third is different category
      expect(result.stats.after_dedup).toBe(2)
    })

    test('keeps highest severity across severities from low to critical', () => {
      writeJsonFile('step1/output.json', {
        findings: [
          { file_path: '/src/a.ts', line_number: 1, severity: 'low', message: '1' },
          { file_path: '/src/a.ts', line_number: 1, severity: 'critical', message: '2' },
          { file_path: '/src/a.ts', line_number: 1, severity: 'high', message: '3' },
          { file_path: '/src/a.ts', line_number: 1, severity: 'medium', message: '4' },
        ],
      })

      const step = makeStep({
        input_steps: ['step1'],
        dedup_key: 'file_path+line_number',
      })

      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      expect(result.stats.after_dedup).toBe(1)
      expect(result.findings[0].severity).toBe('critical')
    })
  })

  describe('path traversal protection', () => {
    test('blocks input file outside output directory', () => {
      const step = makeStep({ input_steps: ['step1'] })
      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', {
        name: 'step1',
        type: 'spawn_session',
        output_path: '../../../etc/passwd', // Path traversal attempt
      })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      // Should return 0 findings (path blocked)
      expect(result.stats.total_input_findings).toBe(0)
    })

    test('writeAggregatorOutput blocks path traversal', () => {
      const result: AggregatorResult = {
        findings: [],
        verdict: 'PASS',
        stats: { total_input_findings: 0, after_dedup: 0, after_evidence_filter: 0 },
      }

      expect(() => {
        writeAggregatorOutput(makeRun(), '../../../etc/passwd', result)
      }).toThrow(/Path traversal/)
    })

    test('allows subdirectory paths within output directory', () => {
      const result: AggregatorResult = {
        findings: [],
        verdict: 'PASS',
        stats: { total_input_findings: 0, after_dedup: 0, after_evidence_filter: 0 },
      }

      // Should not throw
      writeAggregatorOutput(makeRun(), 'subdir/nested/output.json', result)

      const outputPath = path.join(TEMP_DIR, 'subdir/nested/output.json')
      expect(fs.existsSync(outputPath)).toBe(true)
    })
  })

  describe('verdict computation edge cases', () => {
    test('handles custom verdict with unknown condition', () => {
      writeJsonFile('step1/output.json', {
        findings: [{ severity: 'high', message: 'test' }],
      })

      const step = makeStep({
        input_steps: ['step1'],
        verdict_rules: [
          { condition: 'unknown_condition_type', verdict: 'FAIL' },
        ],
      })

      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      // Unknown condition doesn't match, defaults to PASS
      expect(result.verdict).toBe('PASS')
    })

    test('handles findings without severity', () => {
      writeJsonFile('step1/output.json', {
        findings: [{ message: 'no severity' }],
      })

      const step = makeStep({ input_steps: ['step1'] })
      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      // Default rules: findings with no severity -> WARN
      expect(result.verdict).toBe('WARN')
    })

    test('handles invalid severity values', () => {
      writeJsonFile('step1/output.json', {
        findings: [{ severity: 'invalid-severity', message: 'test' }],
      })

      const step = makeStep({ input_steps: ['step1'] })
      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      // Invalid severity treated as lowest
      expect(result.verdict).toBe('WARN')
    })
  })

  describe('missing step handling', () => {
    test('handles input step not in stepDefMap', () => {
      writeJsonFile('step1/output.json', { findings: [{ message: 'test' }] })

      const step = makeStep({
        input_steps: ['step1', 'nonexistent-step'],
      })

      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session', output_path: 'step1/output.json' })
      // nonexistent-step not in map

      const result = executeAggregator(step, makeRun(), stepDefMap)

      expect(result.stats.total_input_findings).toBe(1)
    })

    test('handles input step with no output_path', () => {
      const step = makeStep({ input_steps: ['step1'] })
      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', { name: 'step1', type: 'spawn_session' }) // No output_path

      const result = executeAggregator(step, makeRun(), stepDefMap)

      expect(result.stats.total_input_findings).toBe(0)
    })

    test('handles input step with nonexistent output file', () => {
      const step = makeStep({ input_steps: ['step1'] })
      const stepDefMap = new Map<string, WorkflowStep>()
      stepDefMap.set('step1', {
        name: 'step1',
        type: 'spawn_session',
        output_path: 'nonexistent/file.json',
      })

      const result = executeAggregator(step, makeRun(), stepDefMap)

      expect(result.stats.total_input_findings).toBe(0)
    })
  })
})
