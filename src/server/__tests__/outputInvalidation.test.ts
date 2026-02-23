import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import {
  createOutputInvalidationStore,
  computeHash,
  checkOutputInvalidation,
  invalidateDownstream,
  trackOutputHash,
  checkCircuitBreaker,
  incrementInvalidationAndCheck,
  buildDependencyGraph,
} from '../outputInvalidation'

describe('outputInvalidation', () => {
  let db: SQLiteDatabase
  let store: ReturnType<typeof createOutputInvalidationStore>

  beforeEach(() => {
    db = new SQLiteDatabase(':memory:')
    store = createOutputInvalidationStore(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('createOutputInvalidationStore', () => {
    test('creates step_outputs table', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='step_outputs'")
        .all() as Array<{ name: string }>
      expect(tables.length).toBe(1)
    })

    test('upsertStepOutput and getStepOutput', () => {
      store.upsertStepOutput({
        run_id: 'run-123',
        step_name: 'build',
        input_hash: 'input-abc',  // HIGH-007: Now required
        output_hash: 'abc123',
        valid: true,
      })

      const record = store.getStepOutput('run-123', 'build')
      expect(record).not.toBeNull()
      expect(record?.run_id).toBe('run-123')
      expect(record?.step_name).toBe('build')
      expect(record?.input_hash).toBe('input-abc')  // HIGH-007
      expect(record?.output_hash).toBe('abc123')
      expect(record?.valid).toBe(true)
    })

    test('upsert updates existing record', () => {
      store.upsertStepOutput({
        run_id: 'run-123',
        step_name: 'build',
        input_hash: 'input-1',
        output_hash: 'hash1',
        valid: true,
      })

      store.upsertStepOutput({
        run_id: 'run-123',
        step_name: 'build',
        input_hash: 'input-2',
        output_hash: 'hash2',
        valid: false,
      })

      const record = store.getStepOutput('run-123', 'build')
      expect(record?.input_hash).toBe('input-2')  // HIGH-007
      expect(record?.output_hash).toBe('hash2')
      expect(record?.valid).toBe(false)
    })

    test('invalidateStep', () => {
      store.upsertStepOutput({
        run_id: 'run-123',
        step_name: 'test',
        input_hash: 'test-input',
        output_hash: 'test-hash',
        valid: true,
      })

      store.invalidateStep('run-123', 'test')

      const record = store.getStepOutput('run-123', 'test')
      expect(record?.valid).toBe(false)
    })

    test('getValidSteps and getInvalidatedSteps', () => {
      store.upsertStepOutput({ run_id: 'run-1', step_name: 'step-a', input_hash: 'ia', output_hash: 'a', valid: true })
      store.upsertStepOutput({ run_id: 'run-1', step_name: 'step-b', input_hash: 'ib', output_hash: 'b', valid: false })
      store.upsertStepOutput({ run_id: 'run-1', step_name: 'step-c', input_hash: 'ic', output_hash: 'c', valid: true })

      const valid = store.getValidSteps('run-1')
      expect(valid).toContain('step-a')
      expect(valid).toContain('step-c')
      expect(valid).not.toContain('step-b')

      const invalidated = store.getInvalidatedSteps('run-1')
      expect(invalidated).toContain('step-b')
      expect(invalidated).not.toContain('step-a')
    })

    test('getInvalidationCount', () => {
      store.upsertStepOutput({ run_id: 'run-1', step_name: 'a', input_hash: 'ia', output_hash: 'a', valid: false })
      store.upsertStepOutput({ run_id: 'run-1', step_name: 'b', input_hash: 'ib', output_hash: 'b', valid: false })
      store.upsertStepOutput({ run_id: 'run-1', step_name: 'c', input_hash: 'ic', output_hash: 'c', valid: true })

      expect(store.getInvalidationCount('run-1')).toBe(2)
    })
  })

  describe('computeHash', () => {
    test('produces consistent hash', () => {
      const hash1 = computeHash('test content')
      const hash2 = computeHash('test content')
      expect(hash1).toBe(hash2)
    })

    test('produces different hashes for different content', () => {
      const hash1 = computeHash('content 1')
      const hash2 = computeHash('content 2')
      expect(hash1).not.toBe(hash2)
    })

    test('returns 16-character hash', () => {
      const hash = computeHash('any content')
      expect(hash.length).toBe(16)
    })
  })

  describe('checkOutputInvalidation', () => {
    const mockCtx = {
      runId: 'run-1',
      outputDir: '/tmp/run-1',
      logger: { warn: () => {} },
    }

    test('returns false when no previous output', async () => {
      const shouldInvalidate = await checkOutputInvalidation(
        'new-step',
        'hash1',
        mockCtx,
        store
      )
      expect(shouldInvalidate).toBe(false)
    })

    test('returns true when already invalidated', async () => {
      store.upsertStepOutput({
        run_id: 'run-1',
        step_name: 'existing-step',
        input_hash: 'old-input-hash',
        output_hash: 'old-hash',
        valid: false,
      })

      const shouldInvalidate = await checkOutputInvalidation(
        'existing-step',
        'old-input-hash',
        mockCtx,
        store
      )
      expect(shouldInvalidate).toBe(true)
    })

    // HIGH-007: Updated test - now compares input_hash, not output_hash
    test('returns true when input hash differs', async () => {
      store.upsertStepOutput({
        run_id: 'run-1',
        step_name: 'step-with-changed-input',
        input_hash: 'old-input-hash',  // Different from new-hash
        output_hash: 'old-output-hash',
        valid: true,
      })

      const shouldInvalidate = await checkOutputInvalidation(
        'step-with-changed-input',
        'new-hash',  // Different input hash triggers invalidation
        mockCtx,
        store
      )
      expect(shouldInvalidate).toBe(true)
    })

    // HIGH-007: Updated test - compares input_hash for equality
    test('returns false when input hashes match', async () => {
      store.upsertStepOutput({
        run_id: 'run-1',
        step_name: 'step-same-input',
        input_hash: 'same-input-hash',
        output_hash: 'output-hash',  // Output hash can differ
        valid: true,
      })

      const shouldInvalidate = await checkOutputInvalidation(
        'step-same-input',
        'same-input-hash',  // Same input hash - no invalidation
        mockCtx,
        store
      )
      expect(shouldInvalidate).toBe(false)
    })
  })

  describe('invalidateDownstream', () => {
    const mockCtx = {
      runId: 'run-1',
      outputDir: '/tmp/run-1',
      logger: { warn: () => {} },
    }

    test('invalidates transitive dependencies', async () => {
      // Build graph: A -> B -> C (A depends on B, B depends on C)
      const graph = new Map<string, string[]>()
      graph.set('C', ['B'])
      graph.set('B', ['A'])

      // Set up valid outputs
      store.upsertStepOutput({ run_id: 'run-1', step_name: 'A', input_hash: 'ia', output_hash: 'a', valid: true })
      store.upsertStepOutput({ run_id: 'run-1', step_name: 'B', input_hash: 'ib', output_hash: 'b', valid: true })
      store.upsertStepOutput({ run_id: 'run-1', step_name: 'C', input_hash: 'ic', output_hash: 'c', valid: true })

      // Invalidate from C
      const invalidated = await invalidateDownstream('C', mockCtx, store, graph)

      expect(invalidated).toContain('B')
      expect(invalidated).toContain('A')
      expect(store.getValidSteps('run-1')).not.toContain('A')
      expect(store.getValidSteps('run-1')).not.toContain('B')
    })

    test('handles empty graph', async () => {
      const graph = new Map<string, string[]>()
      const invalidated = await invalidateDownstream('X', mockCtx, store, graph)
      expect(invalidated).toEqual([])
    })
  })

  describe('trackOutputHash', () => {
    const mockCtx = {
      runId: 'run-1',
      outputDir: '/tmp/run-1',
      logger: { warn: () => {} },
    }

    test('stores output hash with valid status', async () => {
      await trackOutputHash('step-1', 'hash-abc', true, mockCtx, store, 'input-hash-abc')

      const record = store.getStepOutput('run-1', 'step-1')
      expect(record?.input_hash).toBe('input-hash-abc')  // HIGH-007
      expect(record?.output_hash).toBe('hash-abc')
      expect(record?.valid).toBe(true)
    })

    test('stores output hash with invalid status', async () => {
      await trackOutputHash('step-2', 'hash-def', false, mockCtx, store, 'input-hash-def')

      const record = store.getStepOutput('run-1', 'step-2')
      expect(record?.input_hash).toBe('input-hash-def')  // HIGH-007
      expect(record?.valid).toBe(false)
    })

    // HIGH-007: Test with default empty input_hash
    test('stores output hash without input hash (uses empty default)', async () => {
      await trackOutputHash('step-3', 'hash-ghi', true, mockCtx, store)

      const record = store.getStepOutput('run-1', 'step-3')
      expect(record?.input_hash).toBe('')  // HIGH-007: Empty default
      expect(record?.output_hash).toBe('hash-ghi')
      expect(record?.valid).toBe(true)
    })
  })

  describe('checkCircuitBreaker', () => {
    test('returns false under threshold', () => {
      store.upsertStepOutput({ run_id: 'run-1', step_name: 'a', input_hash: 'ia', output_hash: 'a', valid: false })
      store.upsertStepOutput({ run_id: 'run-1', step_name: 'b', input_hash: 'ib', output_hash: 'b', valid: false })

      const result = checkCircuitBreaker('run-1', store)
      expect(result.shouldPause).toBe(false)
      expect(result.invalidationCount).toBe(2)
    })

    test('returns true at threshold', () => {
      store.upsertStepOutput({ run_id: 'run-1', step_name: 'a', input_hash: 'ia', output_hash: 'a', valid: false })
      store.upsertStepOutput({ run_id: 'run-1', step_name: 'b', input_hash: 'ib', output_hash: 'b', valid: false })
      store.upsertStepOutput({ run_id: 'run-1', step_name: 'c', input_hash: 'ic', output_hash: 'c', valid: false })

      const result = checkCircuitBreaker('run-1', store)
      expect(result.shouldPause).toBe(true)
      expect(result.invalidationCount).toBe(3)
    })
  })

  describe('incrementInvalidationAndCheck', () => {
    const mockCtx = {
      runId: 'run-1',
      outputDir: '/tmp/run-1',
      logger: { warn: () => {} },
    }

    test('increments and checks threshold', () => {
      // Start with 2 invalidations
      store.upsertStepOutput({ run_id: 'run-1', step_name: 'a', input_hash: 'ia', output_hash: 'a', valid: false })
      store.upsertStepOutput({ run_id: 'run-1', step_name: 'b', input_hash: 'ib', output_hash: 'b', valid: false })

      // Add a valid step to be invalidated
      store.upsertStepOutput({ run_id: 'run-1', step_name: 'c', input_hash: 'ic', output_hash: 'c', valid: true })

      const result = incrementInvalidationAndCheck('c', mockCtx, store)
      expect(result.shouldPause).toBe(true)
      expect(result.invalidationCount).toBe(3)
    })
  })

  describe('buildDependencyGraph', () => {
    test('builds graph from steps', () => {
      const steps = [
        { name: 'A', depends_on: ['B'] },
        { name: 'B', depends_on: ['C'] },
        { name: 'C' },
        { name: 'D', depends_on: ['A', 'C'] },
      ]

      const graph = buildDependencyGraph(steps)

      // B -> A (B has A as downstream)
      expect(graph.get('B')).toContain('A')
      // C -> B, C -> D
      expect(graph.get('C')).toContain('B')
      expect(graph.get('C')).toContain('D')
      // A -> D
      expect(graph.get('A')).toContain('D')
    })

    test('handles steps without dependencies', () => {
      const steps = [
        { name: 'standalone' },
      ]

      const graph = buildDependencyGraph(steps)
      expect(graph.size).toBe(0)
    })
  })
})
