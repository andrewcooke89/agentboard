/**
 * Phase 21: Tests for conditionEvaluator
 */

import { describe, test, expect } from 'bun:test'
import { evaluateCondition, ConditionContext } from '../conditionEvaluator'

describe('conditionEvaluator', () => {
  const baseCtx: ConditionContext = {
    tier: 2,
    stepOutputs: {},
    variables: {}
  }

  describe('evaluateCondition', () => {
    test('file_exists condition returns true when file exists', () => {
      const result = evaluateCondition(
        { type: 'file_exists', path: '/tmp' },
        baseCtx
      )
      expect(result).toBe(true)
    })

    test('file_exists condition returns false when file does not exist', () => {
      const result = evaluateCondition(
        { type: 'file_exists', path: '/nonexistent-path-xyz-123' },
        baseCtx
      )
      expect(result).toBe(false)
    })

    test('expression condition evaluates simple tier comparison', () => {
      const result = evaluateCondition(
        { type: 'expression', expr: 'tier >= 2' },
        baseCtx
      )
      expect(result).toBe(true)
    })

    test('expression condition with tier < 2 returns false at tier 2', () => {
      const result = evaluateCondition(
        { type: 'expression', expr: 'tier < 2' },
        baseCtx
      )
      expect(result).toBe(false)
    })

    test('expression condition evaluates dotted path from step outputs', () => {
      const ctx: ConditionContext = {
        ...baseCtx,
        stepOutputs: {
          'classification': {
            _raw: 'some output',
            type: 'dependency_update',
            tier: 1
          }
        }
      }
      const result = evaluateCondition(
        { type: 'expression', expr: 'classification.type == dependency_update' },
        ctx
      )
      expect(result).toBe(true)
    })

    test('expression condition with AND operator', () => {
      const ctx: ConditionContext = {
        ...baseCtx,
        stepOutputs: {
          'classification': {
            _raw: 'output',
            type: 'feature',
            tier: 2
          }
        }
      }
      const result = evaluateCondition(
        { type: 'expression', expr: 'tier >= 2 AND classification.type == feature' },
        ctx
      )
      expect(result).toBe(true)
    })

    test('expression condition with OR operator', () => {
      const result = evaluateCondition(
        { type: 'expression', expr: 'tier == 1 OR tier == 2' },
        baseCtx
      )
      expect(result).toBe(true)
    })

    test('expression condition with quoted string comparison', () => {
      const ctx: ConditionContext = {
        ...baseCtx,
        stepOutputs: {
          'service-management': {
            _raw: 'output',
            status: 'service_available'
          }
        }
      }
      const result = evaluateCondition(
        { type: 'expression', expr: "service-management.status == 'service_available'" },
        ctx
      )
      expect(result).toBe(true)
    })

    test('expression condition with double-quoted string', () => {
      const ctx: ConditionContext = {
        ...baseCtx,
        stepOutputs: {
          'test': { _raw: '', value: 'active' }
        }
      }
      const result = evaluateCondition(
        { type: 'expression', expr: 'test.value == "active"' },
        ctx
      )
      expect(result).toBe(true)
    })

    test('expression condition with numeric comparison', () => {
      const result = evaluateCondition(
        { type: 'expression', expr: 'tier > 1' },
        baseCtx
      )
      expect(result).toBe(true)
    })

    test('expression condition with <= comparison', () => {
      const result = evaluateCondition(
        { type: 'expression', expr: 'tier <= 2' },
        baseCtx
      )
      expect(result).toBe(true)
    })

    test('expression condition with != operator', () => {
      const result = evaluateCondition(
        { type: 'expression', expr: 'tier != 1' },
        baseCtx
      )
      expect(result).toBe(true)
    })

    test('expression condition using variables', () => {
      const ctx: ConditionContext = {
        ...baseCtx,
        variables: {
          'model_routing.enabled': 'true'
        }
      }
      const result = evaluateCondition(
        { type: 'expression', expr: 'model_routing.enabled == true' },
        ctx
      )
      expect(result).toBe(true)
    })

    test('output_contains returns true when text is in output', () => {
      const ctx: ConditionContext = {
        ...baseCtx,
        stepOutputs: {
          'test-step': {
            _raw: 'This is a test output with KEYWORD inside'
          }
        }
      }
      const result = evaluateCondition(
        { type: 'output_contains', step: 'test-step', contains: 'KEYWORD' },
        ctx
      )
      expect(result).toBe(true)
    })

    test('output_contains returns false when text is not in output', () => {
      const ctx: ConditionContext = {
        ...baseCtx,
        stepOutputs: {
          'test-step': { _raw: 'This is output' }
        }
      }
      const result = evaluateCondition(
        { type: 'output_contains', step: 'test-step', contains: 'MISSING' },
        ctx
      )
      expect(result).toBe(false)
    })

    test('output_contains returns false when step has no output', () => {
      const result = evaluateCondition(
        { type: 'output_contains', step: 'nonexistent', contains: 'anything' },
        baseCtx
      )
      expect(result).toBe(false)
    })

    test('unknown condition type defaults to true (permissive)', () => {
      const result = evaluateCondition(
        { type: 'unknown_type', expr: '' } as any,
        baseCtx
      )
      expect(result).toBe(true)
    })

    test('file_exists function in expression', () => {
      const result = evaluateCondition(
        { type: 'expression', expr: 'file_exists(/tmp)' },
        baseCtx
      )
      expect(result).toBe(true)
    })

    test('file_exists function with non-existent path', () => {
      const result = evaluateCondition(
        { type: 'expression', expr: 'file_exists(/nonexistent-xyz-123)' },
        baseCtx
      )
      expect(result).toBe(false)
    })

    test('expression with && operator', () => {
      const result = evaluateCondition(
        { type: 'expression', expr: 'tier >= 1 && tier <= 3' },
        baseCtx
      )
      expect(result).toBe(true)
    })

    test('expression with || operator', () => {
      const result = evaluateCondition(
        { type: 'expression', expr: 'tier == 1 || tier == 2' },
        baseCtx
      )
      expect(result).toBe(true)
    })

    test('complex expression with nested conditions', () => {
      const ctx: ConditionContext = {
        tier: 2,
        stepOutputs: {
          'test': { _raw: '', value: 'active', count: 5 }
        },
        variables: {}
      }
      const result = evaluateCondition(
        { type: 'expression', expr: 'tier == 2 AND test.value == "active" AND test.count >= 3' },
        ctx
      )
      expect(result).toBe(true)
    })

    test('boolean literal true in expression', () => {
      const ctx: ConditionContext = {
        ...baseCtx,
        variables: { 'enabled': 'true' }
      }
      const result = evaluateCondition(
        { type: 'expression', expr: 'enabled == true' },
        ctx
      )
      expect(result).toBe(true)
    })

    test('boolean literal false in expression', () => {
      const result = evaluateCondition(
        { type: 'expression', expr: 'false == false' },
        baseCtx
      )
      expect(result).toBe(true)
    })
  })
})
