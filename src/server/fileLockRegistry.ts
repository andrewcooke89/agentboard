// fileLockRegistry.ts — In-memory file lock registry for concurrent dispatch protection.
//
// Tracks which files have active dispatches. When multiple tickets target the same
// file and are dispatched concurrently, the first one commits changes that invalidate
// anchors for subsequent ones. This registry prevents that race condition.
//
// The registry is in-memory only — server restart clears all locks (which is fine
// since executor processes also die on restart).

export interface LockEntry {
  dispatchId: string
  woId?: string
  ticketId?: string
  lockedAt: string
}

/** Normalize a file path to a consistent relative form (forward slashes, no leading slash). */
function normalizePath(filePath: string): string {
  // Strip leading slashes and normalize to forward slashes
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

class FileLockRegistry {
  private locks = new Map<string, LockEntry>()

  /** Try to lock a file for a dispatch. Returns true if lock acquired, false if already locked. */
  tryLock(file: string, dispatchId: string, meta?: { woId?: string; ticketId?: string }): boolean {
    const key = normalizePath(file)
    if (this.locks.has(key)) return false
    this.locks.set(key, {
      dispatchId,
      woId: meta?.woId,
      ticketId: meta?.ticketId,
      lockedAt: new Date().toISOString(),
    })
    return true
  }

  /** Check if a file is locked. */
  isLocked(file: string): boolean {
    return this.locks.has(normalizePath(file))
  }

  /** Get the lock entry for a file. */
  getLock(file: string): LockEntry | null {
    return this.locks.get(normalizePath(file)) ?? null
  }

  /** Release all locks held by a dispatch. Returns list of released files. */
  releaseByDispatch(dispatchId: string): string[] {
    const released: string[] = []
    for (const [file, entry] of this.locks) {
      if (entry.dispatchId === dispatchId) {
        this.locks.delete(file)
        released.push(file)
      }
    }
    return released
  }

  /** Get all currently locked files. */
  getLockedFiles(): Map<string, LockEntry> {
    return new Map(this.locks)
  }
}

export const fileLockRegistry = new FileLockRegistry()
