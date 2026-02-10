// HistoryService.ts - Chat history service for browsing past sessions
import type { HistorySession } from '../shared/types'
import { searchSessions, getRecentSessions, type SearchOptions, type ScanOptions } from './BasicSearchScanner'

export interface HistoryConfig {
  enabled: boolean
  claudeConfigDir: string
  codexHomeDir: string
  maxFiles: number
  maxResults: number
  readMaxBytes: number
  readMaxLines: number
  countsTtlMs: number
  resumeTimeoutMs: number
}

// Rate limiting: in-memory per-request counter
const requestTimes: number[] = []
const RATE_LIMIT_WINDOW_MS = 1000
const RATE_LIMIT_MAX = 5

function checkRateLimit(): boolean {
  const now = Date.now()
  // Remove expired entries
  while (requestTimes.length > 0 && requestTimes[0] < now - RATE_LIMIT_WINDOW_MS) {
    requestTimes.shift()
  }
  if (requestTimes.length >= RATE_LIMIT_MAX) return false
  requestTimes.push(now)
  return true
}

export class HistoryService {
  private config: HistoryConfig
  private cachedCounts: { claude: number; codex: number; timestamp: number } | null = null

  constructor(config: HistoryConfig) {
    this.config = config
  }

  get enabled(): boolean {
    return this.config.enabled
  }

  private getScanOptions(): ScanOptions {
    return {
      claudeConfigDir: this.config.claudeConfigDir,
      codexHomeDir: this.config.codexHomeDir,
      maxFiles: this.config.maxFiles,
      readMaxBytes: this.config.readMaxBytes,
      readMaxLines: this.config.readMaxLines,
    }
  }

  async search(query: string, limit?: number, agentType?: 'claude' | 'codex'): Promise<HistorySession[]> {
    if (!this.config.enabled) return []
    if (!checkRateLimit()) throw new Error('Rate limit exceeded')

    const opts: SearchOptions = {
      ...this.getScanOptions(),
      query,
      limit: Math.min(limit ?? 50, this.config.maxResults),
      agentType,
    }
    return searchSessions(opts)
  }

  async getRecent(limit?: number, agentType?: 'claude' | 'codex'): Promise<HistorySession[]> {
    if (!this.config.enabled) return []
    if (!checkRateLimit()) throw new Error('Rate limit exceeded')

    const opts: SearchOptions = {
      ...this.getScanOptions(),
      limit: Math.min(limit ?? 50, this.config.maxResults),
      agentType,
    }
    return getRecentSessions(opts)
  }

  getStatus(): { enabled: boolean; mode: 'basic' } {
    return {
      enabled: this.config.enabled,
      mode: 'basic',
    }
  }
}
