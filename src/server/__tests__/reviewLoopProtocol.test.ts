/**
 * reviewLoopProtocol.test.ts — Tests for review loop verdict parsing and summary writing (Phase 8)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import {
  normalizeVerdict,
  readReviewerVerdict,
  writeReviewLoopSummary,

  type ReviewLoopSummary,
} from '../reviewLoopProtocol'

// ─── Test Helpers ───────────────────────────────────────────────────────────

function writeTestYAML(dir: string, filename: string, data: Record<string, unknown>): string {
  const filePath = path.join(dir, filename)
  writeFileSync(filePath, yaml.dump(data))
  return filePath
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('reviewLoopProtocol', () => {
  let testDir: string

  beforeEach(() => {
    // Create unique temp directory for each test
    testDir = path.join(tmpdir(), `review-loop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  // ─── normalizeVerdict tests ────────────────────────────────────────────────

  describe('normalizeVerdict', () => {
    test('TEST-03a: PASS verdict normalized correctly', () => {
      const result = normalizeVerdict('PASS')
      expect(result.verdict).toBe('PASS')
      expect(result.warning).toBeUndefined()
    })

    test('TEST-03b: FAIL verdict normalized correctly', () => {
      const result = normalizeVerdict('FAIL')
      expect(result.verdict).toBe('FAIL')
      expect(result.warning).toBeUndefined()
    })

    test('TEST-03c: NEEDS_FIX verdict normalized correctly', () => {
      const result = normalizeVerdict('NEEDS_FIX')
      expect(result.verdict).toBe('NEEDS_FIX')
      expect(result.warning).toBeUndefined()
    })

    test('TEST-03d: CONCERN verdict normalized correctly', () => {
      const result = normalizeVerdict('CONCERN')
      expect(result.verdict).toBe('CONCERN')
      expect(result.warning).toBeUndefined()
    })

    test('TEST-07: Case insensitive - various cases normalize to PASS', () => {
      expect(normalizeVerdict('pass').verdict).toBe('PASS')
      expect(normalizeVerdict('Pass').verdict).toBe('PASS')
      expect(normalizeVerdict('pAsS').verdict).toBe('PASS')
      expect(normalizeVerdict('fail').verdict).toBe('FAIL')
      expect(normalizeVerdict('FaIl').verdict).toBe('FAIL')
    })

    test('TEST-08a: Unknown verdict maps to FAIL with warning', () => {
      const result = normalizeVerdict('GARBAGE')
      expect(result.verdict).toBe('FAIL')
      expect(result.warning).toBeDefined()
      expect(result.warning).toContain('Unknown verdict')
      expect(result.warning).toContain('GARBAGE')
    })

    test('TEST-08a2: APPROVE/APPROVED/LGTM/OK map to PASS with warning', () => {
      for (const alias of ['APPROVE', 'approve', 'Approved', 'LGTM', 'OK']) {
        const result = normalizeVerdict(alias)
        expect(result.verdict).toBe('PASS')
        expect(result.warning).toBeDefined()
        expect(result.warning).toContain('treated as PASS')
      }
    })

    test('TEST-08a3: REJECT/REJECTED maps to FAIL with warning', () => {
      for (const alias of ['REJECT', 'reject', 'Rejected']) {
        const result = normalizeVerdict(alias)
        expect(result.verdict).toBe('FAIL')
        expect(result.warning).toBeDefined()
        expect(result.warning).toContain('treated as FAIL')
      }
    })

    test('TEST-08b: REVISE maps to NEEDS_FIX with warning', () => {
      const result = normalizeVerdict('REVISE')
      expect(result.verdict).toBe('NEEDS_FIX')
      expect(result.warning).toBeDefined()
      expect(result.warning).toContain('REVISE')
    })

    test('Whitespace trimming: verdict with surrounding spaces', () => {
      const result = normalizeVerdict('  PASS  ')
      expect(result.verdict).toBe('PASS')
      expect(result.warning).toBeUndefined()
    })
  })

  // ─── readReviewerVerdict tests ─────────────────────────────────────────────

  describe('readReviewerVerdict', () => {
    test('TEST-01a: Read PASS verdict from YAML file', () => {
      const data = {
        verdict: 'PASS',
        comments: 'looks good',
      }
      const filePath = writeTestYAML(testDir, 'verdict-pass.yaml', data)

      const result = readReviewerVerdict(filePath, 'verdict', 'comments')

      expect(result).not.toBeNull()
      expect(result!.verdict).toBe('PASS')
      expect(result!.raw).toBe('PASS')
      expect(result!.feedback).toBe('looks good')
      expect(result!.warning).toBeUndefined()
    })

    test('TEST-01b: Read FAIL verdict with feedback', () => {
      const data = {
        verdict: 'FAIL',
        comments: 'major issues found',
      }
      const filePath = writeTestYAML(testDir, 'verdict-fail.yaml', data)

      const result = readReviewerVerdict(filePath, 'verdict', 'comments')

      expect(result).not.toBeNull()
      expect(result!.verdict).toBe('FAIL')
      expect(result!.raw).toBe('FAIL')
      expect(result!.feedback).toBe('major issues found')
    })

    test('TEST-01c: Returns null for nonexistent file', () => {
      const filePath = path.join(testDir, 'does-not-exist.yaml')
      const result = readReviewerVerdict(filePath, 'verdict', 'comments')

      expect(result).toBeNull()
    })

    test('TEST-01d: Returns null when verdict field is missing from YAML', () => {
      const data = {
        comments: 'some feedback',
        other_field: 'value',
      }
      const filePath = writeTestYAML(testDir, 'no-verdict.yaml', data)

      const result = readReviewerVerdict(filePath, 'verdict', 'comments')

      expect(result).toBeNull()
    })

    test('TEST-01e: Custom verdict_field name works correctly', () => {
      const data = {
        decision: 'PASS',
        notes: 'approved',
      }
      const filePath = writeTestYAML(testDir, 'custom-field.yaml', data)

      const result = readReviewerVerdict(filePath, 'decision', 'notes')

      expect(result).not.toBeNull()
      expect(result!.verdict).toBe('PASS')
      expect(result!.raw).toBe('PASS')
      expect(result!.feedback).toBe('approved')
    })

    test('TEST-01f: Fallback to text extraction when YAML parse fails', () => {
      const content = 'verdict: PASS\nsome other text\ncomments: looks good'
      const filePath = path.join(testDir, 'text-fallback.txt')
      writeFileSync(filePath, content)

      const result = readReviewerVerdict(filePath, 'verdict', 'comments')

      expect(result).not.toBeNull()
      expect(result!.verdict).toBe('PASS')
      expect(result!.raw).toBe('PASS')
      // Feedback extraction from text pattern
      expect(result!.feedback).toBe('looks good')
    })

    test('Reads NEEDS_FIX verdict correctly', () => {
      const data = {
        verdict: 'NEEDS_FIX',
        comments: 'please address these issues',
      }
      const filePath = writeTestYAML(testDir, 'needs-fix.yaml', data)

      const result = readReviewerVerdict(filePath, 'verdict', 'comments')

      expect(result).not.toBeNull()
      expect(result!.verdict).toBe('NEEDS_FIX')
      expect(result!.feedback).toBe('please address these issues')
    })

    test('Handles missing feedback field gracefully', () => {
      const data = {
        verdict: 'PASS',
      }
      const filePath = writeTestYAML(testDir, 'no-feedback.yaml', data)

      const result = readReviewerVerdict(filePath, 'verdict', 'comments')

      expect(result).not.toBeNull()
      expect(result!.verdict).toBe('PASS')
      expect(result!.feedback).toBeNull()
    })

    test('Handles unknown verdict with warning', () => {
      const data = {
        verdict: 'INVALID_VERDICT',
        comments: 'test',
      }
      const filePath = writeTestYAML(testDir, 'invalid-verdict.yaml', data)

      const result = readReviewerVerdict(filePath, 'verdict', 'comments')

      expect(result).not.toBeNull()
      expect(result!.verdict).toBe('FAIL')
      expect(result!.warning).toBeDefined()
      expect(result!.warning).toContain('Unknown verdict')
    })

    test('Empty file returns null', () => {
      const filePath = path.join(testDir, 'empty.yaml')
      writeFileSync(filePath, '')

      const result = readReviewerVerdict(filePath, 'verdict')

      expect(result).toBeNull()
    })
  })

  // ─── writeReviewLoopSummary tests ──────────────────────────────────────────

  describe('writeReviewLoopSummary', () => {
    test('TEST-27: Writes YAML file to correct path', () => {
      const summaryDir = path.join(testDir, 'summaries')
      const summary: ReviewLoopSummary = {
        step_name: 'code-review',
        total_iterations: 3,
        final_outcome: 'PASS',
        iterations: [
          {
            iteration: 1,
            verdict: 'NEEDS_FIX',
            feedback: 'issues found',
            producer_duration_seconds: 120,
            reviewer_duration_seconds: 30,
          },
          {
            iteration: 2,
            verdict: 'NEEDS_FIX',
            feedback: 'still some issues',
            producer_duration_seconds: 90,
            reviewer_duration_seconds: 25,
          },
          {
            iteration: 3,
            verdict: 'PASS',
            feedback: null,
            producer_duration_seconds: 60,
            reviewer_duration_seconds: 20,
          },
        ],
      }

      writeReviewLoopSummary(summaryDir, 'code-review', summary)

      const expectedPath = path.join(summaryDir, 'code-review.yaml')
      expect(existsSync(expectedPath)).toBe(true)
    })

    test('TEST-28: Written file contains correct structure and data', () => {
      const summaryDir = path.join(testDir, 'summaries')
      const summary: ReviewLoopSummary = {
        step_name: 'review-loop-1',
        total_iterations: 2,
        final_outcome: 'FAIL',
        iterations: [
          {
            iteration: 1,
            verdict: 'NEEDS_FIX',
            feedback: 'first attempt',
            producer_duration_seconds: 100,
            reviewer_duration_seconds: 20,
          },
          {
            iteration: 2,
            verdict: 'FAIL',
            feedback: 'max iterations reached',
            producer_duration_seconds: 110,
            reviewer_duration_seconds: 22,
          },
        ],
      }

      writeReviewLoopSummary(summaryDir, 'review-loop-1', summary)

      const filePath = path.join(summaryDir, 'review-loop-1.yaml')
      const content = readFileSync(filePath, 'utf-8')
      const parsed = yaml.load(content) as Record<string, unknown>

      expect(parsed.step_name).toBe('review-loop-1')
      expect(parsed.total_iterations).toBe(2)
      expect(parsed.final_outcome).toBe('FAIL')
      expect(Array.isArray(parsed.iterations)).toBe(true)
      expect((parsed.iterations as unknown[]).length).toBe(2)

      const iterations = parsed.iterations as Array<Record<string, unknown>>
      expect(iterations[0].iteration).toBe(1)
      expect(iterations[0].verdict).toBe('NEEDS_FIX')
      expect(iterations[0].feedback).toBe('first attempt')
      expect(iterations[1].iteration).toBe(2)
      expect(iterations[1].verdict).toBe('FAIL')
    })

    test('TEST-29: Creates directory if it does not exist', () => {
      const summaryDir = path.join(testDir, 'new', 'nested', 'path', 'summaries')
      expect(existsSync(summaryDir)).toBe(false)

      const summary: ReviewLoopSummary = {
        step_name: 'test-step',
        total_iterations: 1,
        final_outcome: 'PASS',
        iterations: [
          {
            iteration: 1,
            verdict: 'PASS',
            feedback: null,
            producer_duration_seconds: 50,
            reviewer_duration_seconds: 10,
          },
        ],
      }

      writeReviewLoopSummary(summaryDir, 'test-step', summary)

      expect(existsSync(summaryDir)).toBe(true)
      expect(existsSync(path.join(summaryDir, 'test-step.yaml'))).toBe(true)
    })

    test('Writes summary with null feedback correctly', () => {
      const summaryDir = path.join(testDir, 'summaries')
      const summary: ReviewLoopSummary = {
        step_name: 'minimal',
        total_iterations: 1,
        final_outcome: 'PASS',
        iterations: [
          {
            iteration: 1,
            verdict: 'PASS',
            feedback: null,
            producer_duration_seconds: 45,
            reviewer_duration_seconds: 15,
          },
        ],
      }

      writeReviewLoopSummary(summaryDir, 'minimal', summary)

      const filePath = path.join(summaryDir, 'minimal.yaml')
      const content = readFileSync(filePath, 'utf-8')
      const parsed = yaml.load(content) as Record<string, unknown>

      const iterations = parsed.iterations as Array<Record<string, unknown>>
      expect(iterations[0].feedback).toBeNull()
    })

    test('Overwrites existing summary file', () => {
      const summaryDir = path.join(testDir, 'summaries')
      mkdirSync(summaryDir, { recursive: true })

      // Write first summary
      const summary1: ReviewLoopSummary = {
        step_name: 'overwrite-test',
        total_iterations: 1,
        final_outcome: 'FAIL',
        iterations: [],
      }
      writeReviewLoopSummary(summaryDir, 'overwrite-test', summary1)

      // Write second summary with same name
      const summary2: ReviewLoopSummary = {
        step_name: 'overwrite-test',
        total_iterations: 2,
        final_outcome: 'PASS',
        iterations: [],
      }
      writeReviewLoopSummary(summaryDir, 'overwrite-test', summary2)

      const filePath = path.join(summaryDir, 'overwrite-test.yaml')
      const content = readFileSync(filePath, 'utf-8')
      const parsed = yaml.load(content) as Record<string, unknown>

      expect(parsed.total_iterations).toBe(2)
      expect(parsed.final_outcome).toBe('PASS')
    })
  })
})
