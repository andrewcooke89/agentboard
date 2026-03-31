/**
 * draftSwarm.test.ts - Tests for speculative draft swarms (Phase 25)
 */

import { describe, test, expect } from 'bun:test'
import {
  shouldActivateDraftSwarm,
  generateDrafts,
  getBestDraft,
  getSwarmState,
  createDefaultDraftSwarmConfig,
  type DraftSwarmConfig,
  type DraftResult,
} from '../draftSwarm'

describe('draftSwarm', () => {
  describe('shouldActivateDraftSwarm', () => {
    test('returns false when disabled', () => {
      const config: DraftSwarmConfig = {
        enabled: false,
        models: ['glm'],
        trigger_complexity: ['simple'],
        min_tier: 1,
      }

      expect(shouldActivateDraftSwarm(config, 'simple', 2)).toBe(false)
    })

    test('returns false when complexity not in trigger list', () => {
      const config: DraftSwarmConfig = {
        enabled: true,
        models: ['glm'],
        trigger_complexity: ['simple', 'medium'],
        min_tier: 1,
      }

      expect(shouldActivateDraftSwarm(config, 'complex', 2)).toBe(false)
    })

    test('returns false when tier below minimum', () => {
      const config: DraftSwarmConfig = {
        enabled: true,
        models: ['glm'],
        trigger_complexity: ['simple'],
        min_tier: 3,
      }

      expect(shouldActivateDraftSwarm(config, 'simple', 2)).toBe(false)
    })

    test('returns true when all conditions met', () => {
      const config: DraftSwarmConfig = {
        enabled: true,
        models: ['glm'],
        trigger_complexity: ['simple', 'medium'],
        min_tier: 2,
      }

      expect(shouldActivateDraftSwarm(config, 'simple', 2)).toBe(true)
      expect(shouldActivateDraftSwarm(config, 'medium', 3)).toBe(true)
    })

    test('returns false for null config', () => {
      expect(shouldActivateDraftSwarm(null, 'simple', 2)).toBe(false)
    })

    test('returns false for undefined config', () => {
      expect(shouldActivateDraftSwarm(undefined, 'simple', 2)).toBe(false)
    })
  })

  describe('generateDrafts', () => {
    test('returns empty array when disabled', async () => {
      const config: DraftSwarmConfig = {
        enabled: false,
        models: ['glm'],
        trigger_complexity: ['simple'],
        min_tier: 1,
      }

      const drafts = await generateDrafts('test prompt', config)
      expect(drafts).toHaveLength(0)
    })

    test('returns empty array when no models configured', async () => {
      const config: DraftSwarmConfig = {
        enabled: true,
        models: [],
        trigger_complexity: ['simple'],
        min_tier: 1,
      }

      const drafts = await generateDrafts('test prompt', config)
      expect(drafts).toHaveLength(0)
    })

    test('generates drafts for configured models', async () => {
      const config: DraftSwarmConfig = {
        enabled: true,
        models: ['glm', 'gemini-flash'],
        trigger_complexity: ['simple'],
        min_tier: 1,
        max_concurrent: 2,
      }

      const drafts = await generateDrafts('test prompt', config)

      expect(drafts.length).toBeLessThanOrEqual(2)
      expect(drafts.some(d => d.model === 'glm' || d.model === 'gemini-flash')).toBe(true)
    })

    test('includes latency in results', async () => {
      const config: DraftSwarmConfig = {
        enabled: true,
        models: ['glm'],
        trigger_complexity: ['simple'],
        min_tier: 1,
      }

      const drafts = await generateDrafts('test prompt', config)

      for (const draft of drafts) {
        expect(draft.latency_ms).toBeGreaterThanOrEqual(0)
      }
    })

    test('respects max_concurrent limit', async () => {
      const config: DraftSwarmConfig = {
        enabled: true,
        models: ['a', 'b', 'c', 'd', 'e'],
        trigger_complexity: ['simple'],
        min_tier: 1,
        max_concurrent: 2,
      }

      const drafts = await generateDrafts('test prompt', config)
      expect(drafts.length).toBeLessThanOrEqual(2)
    })
  })

  describe('getBestDraft', () => {
    test('returns null for empty array', () => {
      expect(getBestDraft([])).toBeNull()
    })

    test('returns null when all drafts failed', () => {
      const drafts: DraftResult[] = [
        { model: 'a', success: false, content: null, latency_ms: 100 },
        { model: 'b', success: false, content: null, latency_ms: 100 },
      ]

      expect(getBestDraft(drafts)).toBeNull()
    })

    test('prefers longer content', () => {
      const drafts: DraftResult[] = [
        { model: 'a', success: true, content: 'short', latency_ms: 500 },
        { model: 'b', success: true, content: 'this is much longer content', latency_ms: 100 },
      ]

      const best = getBestDraft(drafts)
      expect(best?.model).toBe('b')
    })

    test('prefers faster response when content equal', () => {
      const drafts: DraftResult[] = [
        { model: 'a', success: true, content: 'same', latency_ms: 500 },
        { model: 'b', success: true, content: 'same', latency_ms: 100 },
      ]

      const best = getBestDraft(drafts)
      expect(best?.model).toBe('b')
    })

    test('ignores failed drafts', () => {
      const drafts: DraftResult[] = [
        { model: 'a', success: false, content: null, latency_ms: 100, error: 'failed' },
        { model: 'b', success: true, content: 'success', latency_ms: 500 },
      ]

      const best = getBestDraft(drafts)
      expect(best?.model).toBe('b')
    })
  })

  describe('getSwarmState', () => {
    test('returns state object', async () => {
      const state = await getSwarmState()  // CRIT-002: Now async

      expect(state.active_requests).toBeDefined()
      expect(state.requests_this_minute).toBeDefined()
      expect(state.last_request_ago_ms).toBeDefined()
    })
  })

  describe('createDefaultDraftSwarmConfig', () => {
    test('returns disabled config by default', () => {
      const config = createDefaultDraftSwarmConfig()

      expect(config.enabled).toBe(false)
    })

    test('includes default models', () => {
      const config = createDefaultDraftSwarmConfig()

      expect(config.models).toContain('glm')
      expect(config.models.length).toBeGreaterThan(0)
    })

    test('sets reasonable defaults', () => {
      const config = createDefaultDraftSwarmConfig()

      expect(config.min_tier).toBe(2)
      expect(config.max_concurrent).toBe(3)
      expect(config.timeout_ms).toBe(60000)
      expect(config.rate_limit_per_minute).toBe(30)
    })
  })
})
