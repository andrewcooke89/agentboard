// cronLogService.ts — Unified log viewer service
// WU-006: History & Log Services
//
// Collects logs from journalctl (systemd) and syslog/mail (cron).
// Provides unified viewer API abstracting platform differences.

import { existsSync } from 'fs'
import type { CronJob } from '../shared/types'
import { logger } from './logger'

export interface LogEntry {
  timestamp: string
  line: string
  lineNumber: number
}

const LOG_TIMEOUT_MS = 5000
const SYSLOG_PATHS = ['/var/log/syslog', '/var/log/cron', '/var/log/cron.log']

export class CronLogService {
  private getJob: (id: string) => CronJob | undefined

  constructor(getJob: (id: string) => CronJob | undefined) {
    this.getJob = getJob
  }

  /**
   * Get log lines for a job (REQ-31: journalctl for systemd, syslog for cron)
   */
  async getLogs(
    jobId: string,
    lines = 100,
    offset?: number,
  ): Promise<LogEntry[]> {
    const job = this.getJob(jobId)
    if (!job) {
      logger.warn('cronLogService: job not found', { jobId })
      return []
    }

    if (job.source === 'systemd-user' || job.source === 'systemd-system') {
      return this.getSystemdLogs(job, lines, offset)
    }

    return this.getCronLogs(job, lines, offset)
  }

  /**
   * Tail logs as an async generator for live streaming (REQ-32)
   */
  async *tailLogs(jobId: string): AsyncGenerator<LogEntry> {
    const job = this.getJob(jobId)
    if (!job) {
      logger.warn('cronLogService: tailLogs — job not found', { jobId })
      return
    }

    if (job.source === 'systemd-user' || job.source === 'systemd-system') {
      yield* this.tailSystemdLogs(job)
    } else {
      yield* this.tailCronLogs(job)
    }
  }

  // ── Systemd ───────────────────────────────────────────────────────────────

  private resolveUnitName(job: CronJob): string {
    if (job.name.includes('.')) return job.name
    return `${job.name}.service`
  }

  private async getSystemdLogs(job: CronJob, lines: number, offset?: number): Promise<LogEntry[]> {
    const unit = this.resolveUnitName(job)
    const args = ['journalctl', '-u', unit, '--no-pager', '--output=short-iso', `-n`, String(lines)]

    // journalctl supports --cursor for offset-based pagination
    if (offset !== undefined && offset > 0) {
      // Use --cursor-file is not practical without a cursor string;
      // fall back to skipping via line count arithmetic
      args.push('-n', String(lines + offset))
    }

    try {
      const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
      const raw = await withTimeout(readStream(proc.stdout), LOG_TIMEOUT_MS, '')
      const allLines = parseShortIsoLines(raw)

      if (offset !== undefined && offset > 0) {
        return allLines.slice(0, allLines.length - offset).slice(-lines)
      }

      return allLines
    } catch (err) {
      logger.warn('cronLogService: journalctl getLogs failed', { err, jobId: job.id })
      return []
    }
  }

  private async *tailSystemdLogs(job: CronJob): AsyncGenerator<LogEntry> {
    const unit = this.resolveUnitName(job)
    let lineNumber = 0

    try {
      const proc = Bun.spawn(
        ['journalctl', '-u', unit, '-f', '--output=short-iso', '--no-pager'],
        { stdout: 'pipe', stderr: 'pipe' },
      )

      const reader = proc.stdout.getReader()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += new TextDecoder().decode(value)
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            lineNumber++
            yield parseShortIsoLine(line, lineNumber)
          }
        }
      } finally {
        reader.releaseLock()
      }
    } catch (err) {
      logger.warn('cronLogService: journalctl tail failed', { err, jobId: job.id })
    }
  }

  // ── Cron / syslog ─────────────────────────────────────────────────────────

  private async getCronLogs(job: CronJob, lines: number, offset?: number): Promise<LogEntry[]> {
    // Check for log file redirection in the command (e.g. >> /some/file.log)
    const redirectMatch = job.command.match(/>>?\s*([^\s|&;]+\.log\b)/)
    if (redirectMatch) {
      const logFile = redirectMatch[1]
      if (existsSync(logFile)) {
        return this.readTailLines(logFile, lines, offset)
      }
    }

    // Fall back to syslog, grep for command fragment
    const cmdFragment = job.command.split(/\s+/)[0] ?? ''

    for (const syslogPath of SYSLOG_PATHS) {
      if (!existsSync(syslogPath)) continue
      try {
        const proc = Bun.spawn(
          ['grep', `CRON.*${cmdFragment}`, syslogPath],
          { stdout: 'pipe', stderr: 'pipe' },
        )
        const raw = await withTimeout(readStream(proc.stdout), LOG_TIMEOUT_MS, '')
        if (!raw.trim()) continue
        const allLines = parseSyslogLines(raw)
        const sliced = offset !== undefined ? allLines.slice(offset) : allLines
        return sliced.slice(-lines)
      } catch {
        // try next
      }
    }

    return []
  }

  private async *tailCronLogs(job: CronJob): AsyncGenerator<LogEntry> {
    // Prefer explicit log file redirect
    const redirectMatch = job.command.match(/>>?\s*([^\s|&;]+\.log\b)/)
    const logFile = redirectMatch?.[1]

    if (logFile && existsSync(logFile)) {
      yield* this.tailFile(logFile)
      return
    }

    // Fall back to tailing syslog with grep
    const syslogPath = SYSLOG_PATHS.find((p) => existsSync(p))
    if (!syslogPath) return

    const cmdFragment = job.command.split(/\s+/)[0] ?? ''
    yield* this.tailFileGrep(syslogPath, cmdFragment)
  }

  private async *tailFile(filePath: string): AsyncGenerator<LogEntry> {
    let lineNumber = 0
    try {
      const proc = Bun.spawn(['tail', '-f', filePath], { stdout: 'pipe', stderr: 'pipe' })
      const reader = proc.stdout.getReader()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += new TextDecoder().decode(value)
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            lineNumber++
            yield { timestamp: new Date().toISOString(), line, lineNumber }
          }
        }
      } finally {
        reader.releaseLock()
      }
    } catch (err) {
      logger.warn('cronLogService: tail -f failed', { err, filePath })
    }
  }

  private async *tailFileGrep(filePath: string, pattern: string): AsyncGenerator<LogEntry> {
    let lineNumber = 0
    try {
      const proc = Bun.spawn(
        ['tail', '-f', filePath],
        { stdout: 'pipe', stderr: 'pipe' },
      )

      const reader = proc.stdout.getReader()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += new TextDecoder().decode(value)
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim() || !line.includes(pattern)) continue
            lineNumber++
            const entry = parseSyslogLine(line, lineNumber)
            yield entry
          }
        }
      } finally {
        reader.releaseLock()
      }
    } catch (err) {
      logger.warn('cronLogService: tail syslog grep failed', { err, filePath, pattern })
    }
  }

  private async readTailLines(filePath: string, lines: number, offset?: number): Promise<LogEntry[]> {
    try {
      const count = lines + (offset ?? 0)
      const proc = Bun.spawn(['tail', '-n', String(count), filePath], { stdout: 'pipe', stderr: 'pipe' })
      const raw = await withTimeout(readStream(proc.stdout), LOG_TIMEOUT_MS, '')
      const allLines = raw.split('\n').filter(Boolean)
      const sliced = offset !== undefined ? allLines.slice(offset) : allLines
      return sliced.slice(-lines).map((line, i) => ({
        timestamp: new Date().toISOString(),
        line,
        lineNumber: (offset ?? 0) + i + 1,
      }))
    } catch (err) {
      logger.warn('cronLogService: readTailLines failed', { err, filePath })
      return []
    }
  }
}

// ── Parsing utilities ─────────────────────────────────────────────────────────

/**
 * Parse journalctl --output=short-iso lines.
 * Format: "2024-01-15T03:00:01+0000 hostname unit[pid]: MESSAGE"
 */
function parseShortIsoLines(raw: string): LogEntry[] {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line, i) => parseShortIsoLine(line, i + 1))
}

function parseShortIsoLine(line: string, lineNumber: number): LogEntry {
  // Attempt to parse ISO timestamp at line start
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4})/)
  if (match) {
    return {
      timestamp: new Date(match[1]).toISOString(),
      line,
      lineNumber,
    }
  }
  return { timestamp: new Date().toISOString(), line, lineNumber }
}

/**
 * Parse /var/log/syslog lines.
 * Format: "Jan 15 03:00:01 host CRON[1234]: (user) CMD (command)"
 */
function parseSyslogLines(raw: string): LogEntry[] {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line, i) => parseSyslogLine(line, i + 1))
}

function parseSyslogLine(line: string, lineNumber: number): LogEntry {
  const match = line.match(/^(\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})/)
  if (match) {
    const year = new Date().getFullYear()
    try {
      return {
        timestamp: new Date(`${match[1]} ${year}`).toISOString(),
        line,
        lineNumber,
      }
    } catch {
      // fall through
    }
  }
  return { timestamp: new Date().toISOString(), line, lineNumber }
}

// ── Stream helpers ────────────────────────────────────────────────────────────

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ''
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}
