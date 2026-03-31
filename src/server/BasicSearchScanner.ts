// BasicSearchScanner.ts - Enumerate and search JSONL log files
import fs from 'node:fs'
import path from 'node:path'
import { Glob } from 'bun'
import { extractLogMetadata } from './LogMetadataExtractor'
import type { HistorySession } from '../shared/types'

export interface ScanOptions {
  claudeConfigDir: string
  codexHomeDir: string
  maxFiles: number
  readMaxBytes: number
  readMaxLines: number
}

export interface SearchOptions extends ScanOptions {
  query?: string
  limit: number
  agentType?: 'claude' | 'codex'
}

/** Validate that a scanned log path stays within the expected base directory (path traversal defense) */
function validateLogPath(filePath: string, baseDir: string): boolean {
  const resolved = path.resolve(filePath)
  const base = path.resolve(baseDir)
  return resolved.startsWith(base + path.sep) && filePath.endsWith('.jsonl')
}

function extractProjectPath(filePath: string, configDir: string): string {
  // Claude logs: ~/.claude/projects/<encoded-path>/sessions/<id>.jsonl
  // Extract the encoded path and decode it
  const projectsDir = path.join(configDir, 'projects')
  if (filePath.startsWith(projectsDir)) {
    const relative = filePath.slice(projectsDir.length + 1)
    const parts = relative.split(path.sep)
    if (parts.length >= 1) {
      // The first part is the encoded project path
      return decodeURIComponent(parts[0]).replace(/-/g, '/')
    }
  }
  return path.dirname(filePath)
}

function extractProjectName(projectPath: string): string {
  const parts = projectPath.split('/')
  return parts[parts.length - 1] || projectPath
}

function getSessionIdFromFile(filePath: string): string {
  return path.basename(filePath, '.jsonl')
}

async function enumerateLogFiles(opts: ScanOptions): Promise<{ path: string; agentType: 'claude' | 'codex'; mtime: Date }[]> {
  const files: { path: string; agentType: 'claude' | 'codex'; mtime: Date }[] = []

  // Claude logs
  const claudePattern = new Glob('projects/**/sessions/*.jsonl')
  try {
    for await (const match of claudePattern.scan({ cwd: opts.claudeConfigDir, absolute: true })) {
      if (!validateLogPath(match, opts.claudeConfigDir)) continue
      try {
        const stat = fs.statSync(match)
        files.push({ path: match, agentType: 'claude', mtime: stat.mtime })
      } catch { /* skip unreadable */ }
    }
  } catch { /* directory may not exist */ }

  // Codex logs
  const codexPattern = new Glob('sessions/**/*.jsonl')
  try {
    for await (const match of codexPattern.scan({ cwd: opts.codexHomeDir, absolute: true })) {
      if (!validateLogPath(match, opts.codexHomeDir)) continue
      try {
        const stat = fs.statSync(match)
        files.push({ path: match, agentType: 'codex', mtime: stat.mtime })
      } catch { /* skip unreadable */ }
    }
  } catch { /* directory may not exist */ }

  // Sort by mtime descending (most recent first)
  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

  return files.slice(0, opts.maxFiles)
}

export async function searchSessions(opts: SearchOptions): Promise<HistorySession[]> {
  const files = await enumerateLogFiles(opts)
  const results: HistorySession[] = []
  const query = opts.query?.toLowerCase().trim()

  for (const file of files) {
    if (results.length >= opts.limit) break
    if (opts.agentType && file.agentType !== opts.agentType) continue

    const projectPath = file.agentType === 'claude'
      ? extractProjectPath(file.path, opts.claudeConfigDir)
      : path.dirname(file.path)
    const projectName = extractProjectName(projectPath)
    const sessionId = getSessionIdFromFile(file.path)

    // Quick filter by path/name before expensive metadata extraction
    if (query) {
      const pathMatch = projectPath.toLowerCase().includes(query) ||
        projectName.toLowerCase().includes(query)
      if (!pathMatch) {
        // Need to check firstMessage — extract metadata
        const meta = await extractLogMetadata(file.path, opts.readMaxBytes, opts.readMaxLines)
        const msgMatch = meta.firstMessage?.toLowerCase().includes(query)
        if (!msgMatch) continue

        results.push({
          id: sessionId,
          projectPath,
          projectName,
          agentType: file.agentType,
          lastModified: file.mtime.toISOString(),
          sessionType: meta.sessionType,
          messageCount: meta.messageCount,
          firstMessage: meta.firstMessage,
          matchSnippet: meta.firstMessage,
        })
        continue
      }
    }

    const meta = await extractLogMetadata(file.path, opts.readMaxBytes, opts.readMaxLines)

    results.push({
      id: sessionId,
      projectPath,
      projectName,
      agentType: file.agentType,
      lastModified: file.mtime.toISOString(),
      sessionType: meta.sessionType,
      messageCount: meta.messageCount,
      firstMessage: meta.firstMessage,
      matchSnippet: query ? (meta.firstMessage || projectPath) : undefined,
    })
  }

  return results
}

export async function getRecentSessions(opts: SearchOptions): Promise<HistorySession[]> {
  return searchSessions({ ...opts, query: undefined })
}
