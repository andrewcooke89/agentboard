/**
 * reviewRouter.test.ts - Tests for L1/L2 review routing (Phase 25)
 *
 * HIGH-006: executeL1Review and executeL2Review now throw "not implemented" errors
 * because returning hardcoded passing results in production is unsafe.
 */

import { describe, test, expect } from 'bun:test'
import {
  determineReviewRouting,
  executeL1Review,
  executeL2Review,

  type ReviewRoutingConfig,
} from '../reviewRouter'
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

  // HIGH-006: Tests now expect errors to be thrown
  describe('executeL1Review', () => {
    test('throws not implemented error (HIGH-006)', async () => {
      await expect(executeL1Review({
        target_path: '/test/path',
        run_dir: '/test/run',
      })).rejects.toThrow('L1 review not implemented')
    })

    test('error mentions production unsafety (HIGH-006)', async () => {
      try {
        await executeL1Review({
          target_path: '/test/path',
          run_dir: '/test/run',
        })
        expect.unreachable('Should have thrown')
      } catch (err) {
        expect((err as Error).message).toContain('unsafe')
      }
    })
  })

  describe('executeL2Review', () => {
    test('throws not implemented error (HIGH-006)', async () => {
      const l1Result = {
        passed: true,
        verdict: 'PASS' as const,
        feedback: 'L1 passed',
        model_used: 'glm',
      }

      await expect(executeL2Review(l1Result, {
        target_path: '/test/path',
        run_dir: '/test/run',
      })).rejects.toThrow('L2 review not implemented')
    })

    test('error mentions production unsafety (HIGH-006)', async () => {
      const l1Result = {
        passed: true,
        verdict: 'PASS' as const,
        feedback: 'L1 passed',
        model_used: 'glm',
      }

      try {
        await executeL2Review(l1Result, {
          target_path: '/test/path',
          run_dir: '/test/run',
        })
        expect.unreachable('Should have thrown')
      } catch (err) {
        expect((err as Error).message).toContain('unsafe')
      }
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
