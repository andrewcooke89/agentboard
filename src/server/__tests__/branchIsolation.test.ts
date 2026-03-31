import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import {
  createBranchIsolationStore,
  detectScopeConflict,
} from '../branchIsolation'

describe('branchIsolation', () => {
  let db: SQLiteDatabase
  let store: ReturnType<typeof createBranchIsolationStore>

  beforeEach(() => {
    db = new SQLiteDatabase(':memory:')
    store = createBranchIsolationStore(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('createBranchIsolationStore', () => {
    test('creates run_branches table', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='run_branches'")
        .all() as Array<{ name: string }>
      expect(tables.length).toBe(1)
    })

    test('insertRunBranch and getRunBranch', () => {
      store.insertRunBranch({
        run_id: 'run-123',
        worktree_path: '/tmp/worktree-run-123',
        branch_name: 'ab-isolated-run-123',
        cleanup_after: Date.now() + 86400000,
      })

      const record = store.getRunBranch('run-123')
      expect(record).not.toBeNull()
      expect(record?.run_id).toBe('run-123')
      expect(record?.worktree_path).toBe('/tmp/worktree-run-123')
      expect(record?.branch_name).toBe('ab-isolated-run-123')
      expect(record?.created_at).toBeGreaterThan(0)
    })

    test('deleteRunBranch', () => {
      store.insertRunBranch({
        run_id: 'run-456',
        worktree_path: '/tmp/worktree-run-456',
        branch_name: 'ab-isolated-run-456',
        cleanup_after: Date.now() + 86400000,
      })

      expect(store.deleteRunBranch('run-456')).toBe(true)
      expect(store.getRunBranch('run-456')).toBeNull()
      expect(store.deleteRunBranch('nonexistent')).toBe(false)
    })

    test('listExpiredBranches', () => {
      const now = Date.now()

      // Insert one expired and one active
      store.insertRunBranch({
        run_id: 'expired-run',
        worktree_path: '/tmp/worktree-expired',
        branch_name: 'ab-isolated-expired',
        cleanup_after: now - 1000, // Expired
      })

      store.insertRunBranch({
        run_id: 'active-run',
        worktree_path: '/tmp/worktree-active',
        branch_name: 'ab-isolated-active',
        cleanup_after: now + 86400000, // Not expired
      })

      const expired = store.listExpiredBranches(now)
      expect(expired.length).toBe(1)
      expect(expired[0].run_id).toBe('expired-run')
    })
  })

  describe('detectScopeConflict', () => {
    test('returns null when no conflicts', async () => {
      const conflict = await detectScopeConflict(
        'run-new',
        ['/src/file1.ts', '/src/file2.ts'],
        [
          { run_id: 'run-1', file_list: ['/src/other/file3.ts'], tier: 1 },
        ],
        1
      )
      expect(conflict).toBeNull()
    })

    test('detects file overlap conflict', async () => {
      const conflict = await detectScopeConflict(
        'run-new',
        ['/src/shared/utils.ts', '/src/feature/file.ts'],
        [
          { run_id: 'run-1', file_list: ['/src/shared/utils.ts', '/src/other/file.ts'], tier: 1 },
        ],
        1
      )
      expect(conflict).not.toBeNull()
      expect(conflict?.run_id).toBe('run-1')
      expect(conflict?.conflicting_files).toContain('/src/shared/utils.ts')
    })

    test('ignores higher-tier runs for lower-tier new run', async () => {
      // Lower-tier (1) run should not conflict with higher-tier (2) run
      const conflict = await detectScopeConflict(
        'run-low-tier',
        ['/src/shared/file.ts'],
        [
          { run_id: 'run-high-tier', file_list: ['/src/shared/file.ts'], tier: 2 },
        ],
        1 // Lower tier
      )
      expect(conflict).toBeNull()
    })

    test('detects conflict with same-tier run', async () => {
      const conflict = await detectScopeConflict(
        'run-new',
        ['/src/shared/file.ts'],
        [
          { run_id: 'run-same-tier', file_list: ['/src/shared/file.ts'], tier: 1 },
        ],
        1
      )
      expect(conflict).not.toBeNull()
    })

    test('ignores self in active runs', async () => {
      const conflict = await detectScopeConflict(
        'run-1',
        ['/src/file.ts'],
        [
          { run_id: 'run-1', file_list: ['/src/file.ts'], tier: 1 },
        ],
        1
      )
      expect(conflict).toBeNull()
    })

    test('detects path prefix overlap', async () => {
      const conflict = await detectScopeConflict(
        'run-new',
        ['/src/features/auth/login.ts'],
        [
          { run_id: 'run-1', file_list: ['/src/features/auth'], tier: 1 },
        ],
        1
      )
      expect(conflict).not.toBeNull()
    })
  })
})
