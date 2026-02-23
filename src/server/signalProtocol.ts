/**
 * signalProtocol.ts — Signal file parsing, validation, and writing (Phase 7)
 *
 * This is a pure utility module with NO engine dependencies. It handles signal
 * file parsing, validation, and writing for the signal-checkpoint protocol.
 */

import { readFileSync, writeFileSync, renameSync, readdirSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import yaml from 'js-yaml'

// ─── Public Types ───────────────────────────────────────────────────────────

export interface SignalCheckpoint {
  last_completed_subtask: string | null
  completed_subtasks: string[]
  files_modified: string[]
  last_build_status: 'pass' | 'fail' | 'unknown' | null
  extensions: Record<string, unknown>
}

export type SignalType = 'completed' | 'error' | 'amendment_required' | 'human_required' | 'blocked' | 'progress'

export const VALID_SIGNAL_TYPES = new Set<string>([
  'completed', 'error', 'amendment_required', 'human_required', 'blocked', 'progress'
])

export const PAUSE_SIGNAL_TYPES = new Set<string>([
  'amendment_required', 'human_required', 'blocked'
])

export interface SignalFile {
  version: number
  signal_type: SignalType
  timestamp: string
  agent: string
  step_name: string
  run_id: string
  checkpoint: SignalCheckpoint | null
  synthetic?: boolean
  verified_completion?: boolean
  source?: string
}

export interface ResolutionFile {
  signal_file: string
  resolution: string
  resolved_at: string
  resolved_by: string
  checkpoint_to_resume: SignalCheckpoint | null
}

export const CURRENT_SIGNAL_VERSION = 1

// ─── Core Functions ─────────────────────────────────────────────────────────

/**
 * Ensure signal directory exists and is ready for atomic operations.
 * Creates signalDir and signalDir/.tmp/ subdirectory.
 * Validates same-filesystem to prevent rename atomicity issues.
 */
export function ensureSignalDir(signalDir: string): void {
  // Create signal directory recursively
  mkdirSync(signalDir, { recursive: true })

  // Create .tmp subdirectory for atomic writes
  const tmpDir = path.join(signalDir, '.tmp')
  mkdirSync(tmpDir, { recursive: true })

  // Validate same-filesystem (prevents rename atomicity issues)
  const signalDirStat = statSync(signalDir)
  const parentDirStat = statSync(path.dirname(signalDir))

  if (signalDirStat.dev !== parentDirStat.dev) {
    throw new Error(`Signal directory ${signalDir} is on a different filesystem than its parent (rename atomicity not guaranteed)`)
  }
}

/**
 * Read and parse a signal file from disk.
 * Returns null on ENOENT (file not found).
 * Retries 3x with 500ms delay on transient read errors.
 * Applies version compatibility and type validation.
 */
export function readSignalFile(filePath: string): SignalFile | null {
  const MAX_RETRIES = 3
  const RETRY_DELAY_MS = 500

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const content = readFileSync(filePath, 'utf-8')
      const raw = yaml.load(content)

      if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
        console.warn(`Signal file ${filePath} did not parse to an object`)
        return null
      }

      const doc = raw as Record<string, unknown>

      // Version compatibility (REQ-40/41/42)
      let version = CURRENT_SIGNAL_VERSION
      if ('version' in doc && doc.version !== undefined && doc.version !== null) {
        version = Number(doc.version)
        if (isNaN(version)) {
          console.warn(`Signal file ${filePath} has invalid version, defaulting to ${CURRENT_SIGNAL_VERSION}`)
          version = CURRENT_SIGNAL_VERSION
        } else if (version > CURRENT_SIGNAL_VERSION) {
          console.warn(`Signal file ${filePath} has version ${version} > current ${CURRENT_SIGNAL_VERSION}, attempting best-effort parse`)
        }
      }

      // Signal type validation (REQ-17)
      let signalType: SignalType = 'error'
      if (typeof doc.signal_type === 'string' && doc.signal_type.length > 0) {
        const rawType = String(doc.signal_type)
        if (VALID_SIGNAL_TYPES.has(rawType)) {
          signalType = rawType as SignalType
        } else {
          console.warn(`Signal file ${filePath} has unknown signal_type "${rawType}", mapping to "error"`)
        }
      }

      // Parse checkpoint if present
      let checkpoint: SignalCheckpoint | null = null
      if ('checkpoint' in doc && doc.checkpoint !== null && doc.checkpoint !== undefined &&
          typeof doc.checkpoint === 'object' && !Array.isArray(doc.checkpoint)) {
        const cp = doc.checkpoint as Record<string, unknown>
        checkpoint = {
          last_completed_subtask: typeof cp.last_completed_subtask === 'string' ? cp.last_completed_subtask : null,
          completed_subtasks: Array.isArray(cp.completed_subtasks)
            ? cp.completed_subtasks.map(s => String(s))
            : [],
          files_modified: Array.isArray(cp.files_modified)
            ? cp.files_modified.map(s => String(s))
            : [],
          last_build_status: (typeof cp.last_build_status === 'string' &&
                             (cp.last_build_status === 'pass' || cp.last_build_status === 'fail' || cp.last_build_status === 'unknown'))
            ? cp.last_build_status as 'pass' | 'fail' | 'unknown'
            : null,
          extensions: (cp.extensions && typeof cp.extensions === 'object' && !Array.isArray(cp.extensions))
            ? cp.extensions as Record<string, unknown>
            : {}
        }
      }

      const signal: SignalFile = {
        version,
        signal_type: signalType,
        timestamp: typeof doc.timestamp === 'string' ? doc.timestamp : new Date().toISOString(),
        agent: typeof doc.agent === 'string' ? doc.agent : '',
        step_name: typeof doc.step_name === 'string' ? doc.step_name : '',
        run_id: typeof doc.run_id === 'string' ? doc.run_id : '',
        checkpoint,
        synthetic: typeof doc.synthetic === 'boolean' ? doc.synthetic : undefined,
        verified_completion: typeof doc.verified_completion === 'boolean' ? doc.verified_completion : undefined,
        source: typeof doc.source === 'string' ? doc.source : undefined,
      }

      return signal

    } catch (err: unknown) {
      // ENOENT returns null immediately (no retry)
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return null
      }

      // Retry on transient errors
      if (attempt < MAX_RETRIES) {
        console.warn(`Failed to read signal file ${filePath} (attempt ${attempt}/${MAX_RETRIES}): ${err}`)
        Bun.sleepSync(RETRY_DELAY_MS)
        continue
      }

      // Give up after retries
      console.warn(`Failed to read signal file ${filePath} after ${MAX_RETRIES} attempts: ${err}`)
      return null
    }
  }

  return null
}

/**
 * Check for signals matching a specific step, filtering by filesystem mtime.
 * Returns the oldest matching signal, or null if none found.
 *
 * REQ-13/REQ-45: Uses filesystem mtime (not YAML timestamp field) for stale
 * detection. This prevents agents from bypassing stale filtering by writing
 * future timestamps into signal files.
 *
 * REQ-14/REQ-44: Accepts an optional processedFiles set for deduplication.
 * Signals whose file paths are already in the set are skipped.
 */
export function checkStepSignals(
  signalDir: string,
  stepName: string,
  startedAt: string,
  processedFiles?: Set<string>,
): SignalFile | null {
  try {
    const files = readdirSync(signalDir)
    const startedAtMs = new Date(startedAt).getTime()

    // Filter to valid signal files
    const candidates: Array<{ path: string; signal: SignalFile; mtime: Date }> = []

    for (const file of files) {
      // Skip resolution files
      if (file.endsWith('_resolved.yaml') || file.endsWith('_resolved.yml')) {
        continue
      }

      // Skip .tmp directory
      if (file === '.tmp') {
        continue
      }

      // Only YAML files
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) {
        continue
      }

      const filePath = path.join(signalDir, file)

      // REQ-14/REQ-44: Skip already-processed signal files (deduplication)
      if (processedFiles && processedFiles.has(filePath)) {
        continue
      }

      // REQ-13/REQ-45: Use filesystem mtime for stale detection
      let mtime: Date
      try {
        const stat = statSync(filePath)
        mtime = stat.mtime
      } catch {
        continue // File may have been removed between readdir and stat
      }

      // Filter stale signals (only signals with mtime newer than step start)
      if (mtime.getTime() < startedAtMs) {
        continue
      }

      const signal = readSignalFile(filePath)

      if (!signal) {
        continue
      }

      // Filter by step name
      if (signal.step_name !== stepName) {
        continue
      }

      candidates.push({ path: filePath, signal, mtime })
    }

    // Sort oldest-first by mtime (filesystem time, not YAML timestamp)
    candidates.sort((a, b) => a.mtime.getTime() - b.mtime.getTime())

    // Return the first (oldest) matching signal
    if (candidates.length > 0) {
      const best = candidates[0]
      // If processedFiles set provided, mark this signal as processed
      if (processedFiles) {
        processedFiles.add(best.path)
      }
      return best.signal
    }

    return null

  } catch (err: unknown) {
    // Handle ENOENT (directory doesn't exist)
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return null
    }

    console.warn(`Failed to check step signals in ${signalDir}: ${err}`)
    return null
  }
}

/**
 * Create a synthetic signal (generated by agentboard, not external agent).
 * Used for fallback when task status indicates completion but no signal exists.
 */
export function createSyntheticSignal(
  stepName: string,
  runId: string,
  type: SignalType,
  source?: string
): SignalFile {
  return {
    version: CURRENT_SIGNAL_VERSION,
    signal_type: type,
    timestamp: new Date().toISOString(),
    agent: 'agentboard',
    step_name: stepName,
    run_id: runId,
    checkpoint: null,
    synthetic: true,
    verified_completion: false,
    source: source ?? 'task_status_fallback',
  }
}

/**
 * Write a resolution file for a signal (atomic write-then-rename).
 * Returns the path to the created resolution file.
 */
export function writeResolutionFile(
  signalDir: string,
  signalFileName: string,
  resolution: string,
  resolvedBy: string,
  checkpoint?: SignalCheckpoint | null
): string {
  const resolutionData: ResolutionFile = {
    signal_file: signalFileName,
    resolution,
    resolved_at: new Date().toISOString(),
    resolved_by: resolvedBy,
    checkpoint_to_resume: checkpoint ?? null,
  }

  // Generate final filename
  const baseName = signalFileName.replace(/\.(yaml|yml)$/, '')
  const finalName = `${baseName}_resolved.yaml`
  const finalPath = path.join(signalDir, finalName)

  // Write to temp file first (atomic)
  const tmpPath = path.join(signalDir, '.tmp', `${randomUUID()}.yaml`)
  const yamlContent = yaml.dump(resolutionData)
  writeFileSync(tmpPath, yamlContent, 'utf-8')

  // Rename to final location (atomic on same filesystem)
  renameSync(tmpPath, finalPath)

  return finalPath
}

/**
 * Validate that a signal has authority to control the workflow.
 * Synthetic signals (agentboard-generated) are always valid.
 * Signals with empty/missing agent are invalid.
 */
export function validateSignalAuthority(
  signal: SignalFile,
  logger?: { warn: (...args: unknown[]) => void }
): boolean {
  // Synthetic signals are always valid (REQ-36)
  if (signal.synthetic) {
    return true
  }

  // Non-synthetic agentboard signals: warn but allow (REQ-37/38)
  if (signal.agent === 'agentboard') {
    if (logger) {
      logger.warn(`Non-synthetic signal from agentboard agent (unusual): ${signal.step_name}`)
    }
    return true
  }

  // Empty/missing agent is invalid (REQ-39)
  if (!signal.agent || signal.agent.trim().length === 0) {
    if (logger) {
      logger.warn(`Signal has empty/missing agent field: ${signal.step_name}`)
    }
    return false
  }

  // Any named agent is authorized
  return true
}
