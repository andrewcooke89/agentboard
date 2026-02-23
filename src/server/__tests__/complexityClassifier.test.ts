/**
 * complexityClassifier.test.ts - Tests for complexity classification (Phase 25)
 */

import { describe, test, expect } from 'bun:test'
import {
  classifyWorkOrder,
  heuristicClassification,
  analyzeWorkOrder,
  classifyWithAnalysis,

} from '../complexityClassifier'
import type { ComplexityLevel } from '../../shared/types'

describe('complexityClassifier', () => {
  describe('classifyWorkOrder', () => {
    test('returns explicit complexity with high confidence', async () => {
      const workOrder = { complexity: 'complex' as ComplexityLevel }
      const result = await classifyWorkOrder(workOrder)

      expect(result.complexity).toBe('complex')
      expect(result.confidence).toBe(1.0)
      expect(result.reason).toContain('Explicit classification')
    })

    test('normalizes estimated_complexity strings', async () => {
      const workOrder = { estimated_complexity: 'high' }
      const result = await classifyWorkOrder(workOrder)

      expect(result.complexity).toBe('complex')
      expect(result.confidence).toBe(0.9)
    })

    test('uses project profile default when no work order classification', async () => {
      const workOrder = null
      const profile = { complexity: 'atomic' }
      const result = await classifyWorkOrder(workOrder, profile)

      expect(result.complexity).toBe('atomic')
      expect(result.confidence).toBe(0.7)
    })

    test('returns medium default with low confidence when no classification', async () => {
      const result = await classifyWorkOrder(null, null)

      expect(result.complexity).toBe('medium')
      expect(result.confidence).toBe(0.3)
    })
  })

  describe('heuristicClassification', () => {
    test('classifies as atomic when unsafe blocks present', () => {
      const result = heuristicClassification(['src/lib.rs'], 1, 2)

      expect(result.complexity).toBe('atomic')
      expect(result.confidence).toBe(0.9)
      expect(result.reason).toContain('unsafe')
    })

    test('classifies as atomic for critical file patterns', () => {
      const result = heuristicClassification(['src/auth/login.ts'], 1, 0)

      expect(result.complexity).toBe('atomic')
      expect(result.reason).toContain('Critical file pattern')
    })

    test('classifies as complex for 6+ files', () => {
      const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts']
      const result = heuristicClassification(files, 1, 0)

      expect(result.complexity).toBe('complex')
      expect(result.reason).toContain('Large scope')
    })

    test('classifies as complex for 200+ LOC', () => {
      const result = heuristicClassification(['a.ts'], 1, 0, 250)

      expect(result.complexity).toBe('complex')
      expect(result.reason).toContain('Large scope')
    })

    test('classifies as medium for 2-5 files', () => {
      const files = ['a.ts', 'b.ts', 'c.ts']
      const result = heuristicClassification(files, 1, 0)

      expect(result.complexity).toBe('medium')
      expect(result.reason).toContain('Moderate scope')
    })

    test('classifies as simple for single file', () => {
      const result = heuristicClassification(['a.ts'], 0, 0)

      expect(result.complexity).toBe('simple')
      expect(result.reason).toContain('Simple scope')
    })
  })

  describe('analyzeWorkOrder', () => {
    test('extracts file count', () => {
      const analysis = analyzeWorkOrder({ files: ['a.ts', 'b.ts'] })

      expect(analysis.files).toHaveLength(2)
      expect(analysis.modules).toBe(1) // Default when files present
    })

    test('detects critical sections from file names', () => {
      const analysis = analyzeWorkOrder({ files: ['src/crypto/hash.rs'] })

      expect(analysis.has_critical_sections).toBe(true)
    })

    test('detects critical sections from unsafe blocks', () => {
      const analysis = analyzeWorkOrder({ unsafe_blocks: 1 })

      expect(analysis.has_critical_sections).toBe(true)
    })

    test('estimates LOC from files', () => {
      const analysis = analyzeWorkOrder({ files: ['main.ts', 'utils.ts'] })

      expect(analysis.estimated_loc).toBeGreaterThan(0)
    })
  })

  describe('classifyWithAnalysis', () => {
    test('uses explicit classification when high confidence', async () => {
      const workOrder = {
        complexity: 'simple' as ComplexityLevel,
        files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
      }

      const result = await classifyWithAnalysis(workOrder, null)

      expect(result.complexity).toBe('simple')
      expect(result.confidence).toBe(1.0)
    })

    test('uses heuristic when explicit is low confidence', async () => {
      const workOrder = {
        files: ['auth.ts', 'crypto.ts'],
        unsafe_blocks: 1,
      }

      const result = await classifyWithAnalysis(workOrder, null)

      expect(result.complexity).toBe('atomic')
      expect(result.confidence).toBe(0.9)
    })

    test('prefers heuristic over default when files available', async () => {
      const workOrder = {
        files: ['single.ts'],
      }

      const result = await classifyWithAnalysis(workOrder, null)

      expect(result.complexity).toBe('simple')
    })
  })

  describe('normalization', () => {
    test('normalizes "low" to "simple"', async () => {
      const result = await classifyWorkOrder({ estimated_complexity: 'low' })
      expect(result.complexity).toBe('simple')
    })

    test('normalizes "moderate" to "medium"', async () => {
      const result = await classifyWorkOrder({ estimated_complexity: 'moderate' })
      expect(result.complexity).toBe('medium')
    })

    test('normalizes "high" to "complex"', async () => {
      const result = await classifyWorkOrder({ estimated_complexity: 'high' })
      expect(result.complexity).toBe('complex')
    })

    test('normalizes "critical" to "atomic"', async () => {
      const result = await classifyWorkOrder({ estimated_complexity: 'critical' })
      expect(result.complexity).toBe('atomic')
    })
  })
})
