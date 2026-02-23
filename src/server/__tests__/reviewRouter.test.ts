/**
 * reviewRouter.test.ts - Tests for L1/L2 review routing (Phase 25/26)
 *
 * Phase 26: executeL1Review and executeL2Review are now implemented with Gemini.
 * Tests cover routing logic, graceful degradation (no API key / unreadable files),
 * and correct result structure.
 */

import { describe, test, expect } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  determineReviewRouting,
  executeL1Review,
  executeL2Review,

  type ReviewRoutingConfig,
} from '../reviewRouter'
import { setApiKeyOverride } from '../geminiClient'
import type { ComplexityClassification, ComplexityLevel } from '../../shared/types'

function makeClassification(complexity: ComplexityLevel, confidence = 0.9): ComplexityClassification {
  return { complexity, confidence, reason: 'Test classification' }
}

describe('reviewRouter', () => {
  describe('determineReviewRouting', () => {
    test('simple complexity routes to L1 only by default', () => {
      const classification = makeClassification('simple')
      const routing = determineReviewRouting(classification)

      expect(routing.l1_required).toBe(true)
      expect(routing.l2_required).toBe(false)
    })

    test('medium complexity routes to L1 only by default', () => {
      const classification = makeClassification('medium')
      const routing = determineReviewRouting(classification)

      expect(routing.l1_required).toBe(true)
      expect(routing.l2_required).toBe(false)
    })

    test('complex complexity routes to both L1 and L2 by default', () => {
      const classification = makeClassification('complex')
      const routing = determineReviewRouting(classification)

      expect(routing.l1_required).toBe(true)
      expect(routing.l2_required).toBe(true)
    })

    test('atomic complexity routes to both L1 and L2 by default', () => {
      const classification = makeClassification('atomic')
      const routing = determineReviewRouting(classification)

      expect(routing.l1_required).toBe(true)
      expect(routing.l2_required).toBe(true)
    })

    test('uses custom model from config', () => {
      const classification = makeClassification('simple')
      const config: ReviewRoutingConfig = {
        enabled: true,
        l1_model: 'gemini-flash',
        l2_model: 'claude-sonnet',
      }
      const routing = determineReviewRouting(classification, config)

      expect(routing.l1_model).toBe('gemini-flash')
      expect(routing.l2_model).toBe('claude-sonnet')
    })

    test('respects custom complexity routing', () => {
      const classification = makeClassification('simple')
      const config: ReviewRoutingConfig = {
        enabled: true,
        complexity_routing: {
          simple: 'l2',  // Override: simple goes to L2 only
        },
      }
      const routing = determineReviewRouting(classification, config)

      expect(routing.l1_required).toBe(false)
      expect(routing.l2_required).toBe(true)
    })

    test('includes environment variables for models', () => {
      const classification = makeClassification('complex')
      const routing = determineReviewRouting(classification)

      expect(routing.l1_env).toBeDefined()
      expect(routing.l2_env).toBeDefined()
    })
  })

  // Phase 26: executeL1Review is now implemented with Gemini
  describe('executeL1Review', () => {
    test('returns FAIL when target file does not exist', async () => {
      const result = await executeL1Review({
        target_path: '/nonexistent/path/file.ts',
        run_dir: '/test/run',
      })
      expect(result.passed).toBe(false)
      expect(result.verdict).toBe('FAIL')
      expect(result.feedback).toContain('Failed to read target file')
    })

    test('gracefully handles missing Gemini API key', async () => {
      // Create a temp file to read
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l1-review-'))
      const tmpFile = path.join(tmpDir, 'test.ts')
      fs.writeFileSync(tmpFile, 'export function hello() { return "world" }')

      // Override API key to empty so Gemini is skipped
      setApiKeyOverride('')

      try {
        const result = await executeL1Review({
          target_path: tmpFile,
          run_dir: tmpDir,
        })
        // With no API key, Gemini returns skipped -> PASS with warning
        expect(result.passed).toBe(true)
        expect(result.verdict).toBe('PASS')
        expect(result.feedback).toContain('Skipped')
      } finally {
        setApiKeyOverride(undefined)
        fs.rmSync(tmpDir, { recursive: true })
      }
    })

    test('returns ReviewResult structure with correct fields', async () => {
      const result = await executeL1Review({
        target_path: '/nonexistent/file.ts',
        run_dir: '/test/run',
      })
      expect(result).toHaveProperty('passed')
      expect(result).toHaveProperty('verdict')
      expect(result).toHaveProperty('feedback')
      expect(result).toHaveProperty('model_used')
    })
  })

  describe('executeL2Review', () => {
    test('returns FAIL when target file does not exist', async () => {
      const l1Result = {
        passed: true,
        verdict: 'PASS' as const,
        feedback: 'L1 passed',
        model_used: 'glm',
      }

      const result = await executeL2Review(l1Result, {
        target_path: '/nonexistent/path/file.ts',
        run_dir: '/test/run',
      })
      expect(result.passed).toBe(false)
      expect(result.verdict).toBe('FAIL')
      expect(result.feedback).toContain('Failed to read target file')
    })

    test('gracefully handles missing Gemini API key', async () => {
      const l1Result = {
        passed: true,
        verdict: 'PASS' as const,
        feedback: 'L1 passed',
        model_used: 'glm',
      }

      // Create a temp file to read
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-review-'))
      const tmpFile = path.join(tmpDir, 'test.ts')
      fs.writeFileSync(tmpFile, 'export function hello() { return "world" }')

      // Override API key to empty so Gemini is skipped
      setApiKeyOverride('')

      try {
        const result = await executeL2Review(l1Result, {
          target_path: tmpFile,
          run_dir: tmpDir,
        })
        // With no API key, Gemini returns skipped -> PASS with warning
        expect(result.passed).toBe(true)
        expect(result.verdict).toBe('PASS')
        expect(result.feedback).toContain('Skipped')
      } finally {
        setApiKeyOverride(undefined)
        fs.rmSync(tmpDir, { recursive: true })
      }
    })

    test('returns ReviewResult structure with correct fields', async () => {
      const l1Result = {
        passed: true,
        verdict: 'PASS' as const,
        feedback: 'L1 passed',
        model_used: 'glm',
      }

      const result = await executeL2Review(l1Result, {
        target_path: '/nonexistent/file.ts',
        run_dir: '/test/run',
      })
      expect(result).toHaveProperty('passed')
      expect(result).toHaveProperty('verdict')
      expect(result).toHaveProperty('feedback')
      expect(result).toHaveProperty('model_used')
    })
  })

  describe('routing edge cases', () => {
    test('handles null config', () => {
      const classification = makeClassification('medium')
      const routing = determineReviewRouting(classification, null)

      expect(routing.l1_required).toBe(true)
      expect(routing.l2_required).toBe(false)
    })

    test('handles undefined config', () => {
      const classification = makeClassification('complex')
      const routing = determineReviewRouting(classification, undefined)

      expect(routing.l1_required).toBe(true)
      expect(routing.l2_required).toBe(true)
    })

    test('returns complexity in routing result', () => {
      const classification = makeClassification('atomic')
      const routing = determineReviewRouting(classification)

      expect(routing.complexity).toBe('atomic')
    })
  })
})
