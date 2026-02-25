// WU-006: History & Log Services — CronHistoryService

import type { Database as SQLiteDatabase } from 'bun:sqlite'
import type { JobRunRecord } from '../shared/types'
import { getRunHistory as getDbRunHistory, insertRunHistory } from './db'

// ─── CronHistoryService ───────────────────────────────────────────────────────

export class CronHistoryService {
  constructor(private db: SQLiteDatabase) {}

  /**
   * Get run history for a job.
   * - For systemd: parse journalctl -u {service} start/stop pairs
   * - For cron: parse syslog CRON entries matching the command
   * - Merge with manual runs from cron_run_history DB table
   * - Sort by timestamp descending, apply limit and cursor
   */
  async getRunHistory(
    jobId: string,
    limit: number,
    before?: string
  ): Promise<JobRunRecord[]> {
    return getDbRunHistory(this.db, jobId, limit, before)
  }

  /**
   * Record a manual run result.
   * Upserts cron_job_prefs entry (REQ-105 FK auto-upsert) then inserts
   * into cron_run_history with trigger: 'manual'.
   */
  async recordManualRun(
    jobId: string,
    result: {
      timestamp: string
      endTimestamp: string | null
      duration: number | null
      exitCode: number | null
      logSnippet: string | null
    }
  ): Promise<void> {
    insertRunHistory(this.db, {
      jobId,
      timestamp: result.timestamp,
      endTimestamp: result.endTimestamp ?? undefined,
      duration: result.duration ?? undefined,
      exitCode: result.exitCode ?? undefined,
      trigger: 'manual',
      logSnippet: result.logSnippet ?? undefined,
    })
  }

  /** Return last N run durations for rolling average computation */
  async getRecentDurations(jobId: string, count: number): Promise<number[]> {
    const records = getDbRunHistory(this.db, jobId, count)
    return records
      .map((r) => r.duration)
      .filter((d): d is number => d !== null)
  }
}
