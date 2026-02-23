/**
 * branchIsolation.ts - Git worktree management for concurrent pipeline runs
 *
 * Manages git worktrees for concurrent pipeline runs with overlapping file scopes.
 * Lower-tier runs NEVER blocked by higher-tier runs (create worktree instead).
 */

import { Database as SQLiteDatabase } from 'bun:sqlite'
import path from 'node:path'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'

export interface ScopeConflict {
  run_id: string
  worktree_path: string
  conflicting_files: string[]
}

export interface RunBranchRecord {
  run_id: string
  worktree_path: string
  branch_name: string
  created_at: number
  cleanup_after: number
}

export interface BranchIsolationStore {
  insertRunBranch: (record: Omit<RunBranchRecord, 'created_at'>) => void
  getRunBranch: (runId: string) => RunBranchRecord | null
  deleteRunBranch: (runId: string) => boolean
  updateRunBranchStatus: (runId: string, status: string) => boolean
  listExpiredBranches: (now: number) => RunBranchRecord[]
}

// Constants
const WORKTREE_BASE_DIR = '/tmp/agentboard-worktrees'
const BRANCH_PREFIX = 'ab-isolated'
const CLEANUP_DELAY_MS = 24 * 60 * 60 * 1000 // 24 hours

/**
 * Create the branch isolation store with database operations.
 *
 * @param db - SQLite database instance for persisting branch records
 * @returns Store interface for managing run branch records and worktree lifecycle
 *
 * @example
 * ```ts
 * const db = new Database('agentboard.db');
 * const store = createBranchIsolationStore(db);
 * store.insertRunBranch({ run_id: 'run-1', worktree_path: '/tmp/wt', branch_name: 'ab-xxx', cleanup_after: Date.now() + 86400000 });
 * ```
 */
export function createBranchIsolationStore(db: SQLiteDatabase): BranchIsolationStore {
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_branches (
      run_id TEXT PRIMARY KEY,
      worktree_path TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      cleanup_after INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_branches_cleanup ON run_branches(cleanup_after);
    CREATE INDEX IF NOT EXISTS idx_run_branches_status ON run_branches(status);
  `)

  const insertStmt = db.prepare(
    `INSERT INTO run_branches (run_id, worktree_path, branch_name, status, created_at, cleanup_after)
     VALUES ($runId, $worktreePath, $branchName, $status, $createdAt, $cleanupAfter)`
  )
  const selectStmt = db.prepare('SELECT * FROM run_branches WHERE run_id = $runId')
  const deleteStmt = db.prepare('DELETE FROM run_branches WHERE run_id = $runId')
  const updateStatusStmt = db.prepare('UPDATE run_branches SET status = $status WHERE run_id = $runId')
  const listExpiredStmt = db.prepare('SELECT * FROM run_branches WHERE cleanup_after <= $now')

  return {
    insertRunBranch: (record) => {
      insertStmt.run({
        $runId: record.run_id,
        $worktreePath: record.worktree_path,
        $branchName: record.branch_name,
        $status: 'pending',
        $createdAt: Date.now(),
        $cleanupAfter: record.cleanup_after,
      })
    },
    getRunBranch: (runId) => {
      const row = selectStmt.get({ $runId: runId }) as Record<string, unknown> | undefined
      return row ? mapRunBranchRow(row) : null
    },
    deleteRunBranch: (runId) => {
      const result = deleteStmt.run({ $runId: runId })
      return result.changes > 0
    },
    updateRunBranchStatus: (runId, status) => {
      const result = updateStatusStmt.run({ $runId: runId, $status: status })
      return result.changes > 0
    },
    listExpiredBranches: (now) => {
      const rows = listExpiredStmt.all({ $now: now }) as Record<string, unknown>[]
      return rows.map(mapRunBranchRow)
    },
  }
}

function mapRunBranchRow(row: Record<string, unknown>): RunBranchRecord {
  return {
    run_id: String(row.run_id ?? ''),
    worktree_path: String(row.worktree_path ?? ''),
    branch_name: String(row.branch_name ?? ''),
    created_at: Number(row.created_at ?? 0),
    cleanup_after: Number(row.cleanup_after ?? 0),
  }
}

/**
 * Detect if a new run conflicts with active runs based on file scope overlap
 */
export async function detectScopeConflict(
  run_id: string,
  file_list: string[],
  active_runs: Array<{ run_id: string; file_list: string[]; tier: number }>,
  current_tier: number
): Promise<ScopeConflict | null> {
  // Normalize file paths for comparison
  const normalizedNewFiles = file_list.map(f => path.normalize(f))

  for (const activeRun of active_runs) {
    if (activeRun.run_id === run_id) continue

    // Lower-tier runs get worktrees, never block
    // Only check for conflicts with same-tier or higher-tier runs
    if (activeRun.tier > current_tier) continue

    const normalizedActiveFiles = activeRun.file_list.map(f => path.normalize(f))

    // Find overlapping files
    const conflictingFiles = normalizedNewFiles.filter(newFile =>
      normalizedActiveFiles.some(activeFile => {
        // Check if paths overlap (one is prefix of other, or they match)
        const relNewToActive = path.relative(activeFile, newFile)
        const relActiveToNew = path.relative(newFile, activeFile)
        return !relNewToActive.startsWith('..') || !relActiveToNew.startsWith('..')
      })
    )

    if (conflictingFiles.length > 0) {
      return {
        run_id: activeRun.run_id,
        worktree_path: '', // Will be set when worktree is created
        conflicting_files: conflictingFiles,
      }
    }
  }

  return null
}

/**
 * Create a git worktree for isolated execution
 */
export async function createWorktree(
  run_id: string,
  base_branch: string,
  projectPath: string
): Promise<string> {
  // Ensure worktree base directory exists
  if (!fs.existsSync(WORKTREE_BASE_DIR)) {
    fs.mkdirSync(WORKTREE_BASE_DIR, { recursive: true, mode: 0o700 })
  }

  // MED-006: Generate unique worktree path and branch name with random suffix to prevent collisions
  const timestamp = Date.now().toString(36)
  const shortId = run_id.slice(0, 8)
  const randomSuffix = randomBytes(4).toString('hex')
  const branchName = `${BRANCH_PREFIX}-${shortId}-${timestamp}-${randomSuffix}`
  const worktreePath = path.join(WORKTREE_BASE_DIR, branchName)

  // Check if project is a git repository
  const gitDir = path.join(projectPath, '.git')
  if (!fs.existsSync(gitDir)) {
    throw new Error(`Project path is not a git repository: ${projectPath}`)
  }

  // Create the worktree with a new branch
  const result = Bun.spawnSync(
    ['git', 'worktree', 'add', '-b', branchName, worktreePath, base_branch],
    {
      cwd: projectPath,
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString()
    throw new Error(`Failed to create worktree: ${stderr}`)
  }

  return worktreePath
}

/**
 * Clean up a worktree after run completion
 * CRIT-003: Atomic cleanup with compensation - worktree remove first, then branch delete,
 * then directory, then DB. Only delete DB record on full success.
 */
export async function cleanupWorktree(
  run_id: string,
  store: BranchIsolationStore,
  projectPath: string,
  success: boolean
): Promise<{ success: boolean; errors: string[] }> {
  const errors: string[] = []
  const record = store.getRunBranch(run_id)
  if (!record) {
    return { success: true, errors: [] } // No worktree for this run
  }

  const { worktree_path, branch_name } = record

  // On success: immediate cleanup
  // On failure: mark for delayed cleanup (already set via cleanup_after)
  if (!success && Date.now() < record.cleanup_after) {
    // Keep the worktree for debugging
    return { success: false, errors: ['Worktree kept for debugging due to failure'] }
  }

  // CRIT-003: Step 1 - Remove worktree from git FIRST (idempotent operation)
  const _worktreeResult = Bun.spawnSync(
    ['git', 'worktree', 'remove', '--force', worktree_path],
    {
      cwd: projectPath,
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )
  // Note: worktree remove may fail if already removed (idempotent - ignore error)

  // CRIT-003: Step 2 - Delete branch
  const branchResult = Bun.spawnSync(
    ['git', 'branch', '-D', branch_name],
    {
      cwd: projectPath,
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )
  if (branchResult.exitCode !== 0) {
    const stderr = branchResult.stderr.toString()
    // Branch may not exist if worktree creation failed - only error if branch existed
    if (!stderr.includes('not found') && !stderr.includes('does not exist')) {
      errors.push(`Failed to delete branch ${branch_name}: ${stderr}`)
    }
  }

  // CRIT-003: Step 3 - Remove worktree directory
  try {
    if (fs.existsSync(worktree_path)) {
      fs.rmSync(worktree_path, { recursive: true, force: true })
    }
  } catch (err) {
    errors.push(`Failed to remove worktree directory ${worktree_path}: ${err}`)
  }

  // CRIT-003: Step 4 - Only delete DB record on full success
  if (errors.length === 0) {
    store.deleteRunBranch(run_id)
    return { success: true, errors: [] }
  } else {
    // Keep DB record for retry/debugging
    return { success: false, errors }
  }
}

/**
 * Clean up expired worktrees (called periodically)
 */
export async function cleanupExpiredWorktrees(
  store: BranchIsolationStore,
  projectPath: string
): Promise<number> {
  const expired = store.listExpiredBranches(Date.now())
  let cleaned = 0

  for (const record of expired) {
    try {
      // Remove worktree directory
      if (fs.existsSync(record.worktree_path)) {
        fs.rmSync(record.worktree_path, { recursive: true, force: true })
      }

      // Remove from git
      Bun.spawnSync(
        ['git', 'worktree', 'remove', '--force', record.worktree_path],
        { cwd: projectPath, stdout: 'pipe', stderr: 'pipe' }
      )

      // Delete branch
      Bun.spawnSync(
        ['git', 'branch', '-D', record.branch_name],
        { cwd: projectPath, stdout: 'pipe', stderr: 'pipe' }
      )

      store.deleteRunBranch(record.run_id)
      cleaned++
    } catch (err) {
      console.error(`Failed to cleanup expired worktree ${record.run_id}:`, err)
    }
  }

  return cleaned
}

/**
 * Initialize branch isolation for a run (creates worktree if needed)
 * HIGH-005: Uses transaction pattern - DB record first with "pending" status,
 * then worktree creation, then update to "active". Compensates on failure.
 */
export async function initBranchIsolation(
  run_id: string,
  file_list: string[],
  tier: number,
  activeRuns: Array<{ run_id: string; file_list: string[]; tier: number }>,
  store: BranchIsolationStore,
  projectPath: string,
  baseBranch: string
): Promise<{ isolated: boolean; worktreePath?: string; error?: string }> {
  // Check for conflicts
  const conflict = await detectScopeConflict(run_id, file_list, activeRuns, tier)

  if (!conflict) {
    return { isolated: false }
  }

  // HIGH-005: Step 1 - Generate branch name first
  // MED-006: Add random suffix to prevent branch name collisions
  const timestamp = Date.now().toString(36)
  const shortId = run_id.slice(0, 8)
  const randomSuffix = randomBytes(4).toString('hex')
  const branchName = `${BRANCH_PREFIX}-${shortId}-${timestamp}-${randomSuffix}`
  const worktreePath = path.join(WORKTREE_BASE_DIR, branchName)

  // HIGH-005: Step 2 - Create DB record first with "pending" status
  store.insertRunBranch({
    run_id,
    worktree_path: worktreePath,
    branch_name: branchName,
    cleanup_after: Date.now() + CLEANUP_DELAY_MS,
  })

  // HIGH-005: Step 3 - Create worktree
  try {
    // Ensure worktree base directory exists
    if (!fs.existsSync(WORKTREE_BASE_DIR)) {
      fs.mkdirSync(WORKTREE_BASE_DIR, { recursive: true, mode: 0o700 })
    }

    // Check if project is a git repository
    const gitDir = path.join(projectPath, '.git')
    if (!fs.existsSync(gitDir)) {
      throw new Error(`Project path is not a git repository: ${projectPath}`)
    }

    // Create the worktree with a new branch
    const result = Bun.spawnSync(
      ['git', 'worktree', 'add', '-b', branchName, worktreePath, baseBranch],
      {
        cwd: projectPath,
        stdout: 'pipe',
        stderr: 'pipe',
      }
    )

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString()
      throw new Error(`Failed to create worktree: ${stderr}`)
    }

    // HIGH-005: Step 4 - Update DB record to "active" status
    store.updateRunBranchStatus(run_id, 'active')

    return { isolated: true, worktreePath }
  } catch (err) {
    // HIGH-005: Compensation - Delete DB record on failure
    store.deleteRunBranch(run_id)

    const error = err instanceof Error ? err.message : String(err)
    return { isolated: false, error }
  }
}
