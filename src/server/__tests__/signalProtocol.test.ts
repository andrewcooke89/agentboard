/**
 * signalProtocol.test.ts — Tests for signal file parsing and validation
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, utimesSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import {
  ensureSignalDir,
  readSignalFile,
  checkStepSignals,
  createSyntheticSignal,
  writeResolutionFile,
  validateSignalAuthority,
  CURRENT_SIGNAL_VERSION,
  
  type SignalFile,
  type SignalCheckpoint,
} from '../signalProtocol'

// ─── Test Helpers ───────────────────────────────────────────────────────────

function writeTestSignal(dir: string, filename: string, data: Record<string, unknown>): string {
  const filePath = path.join(dir, filename)
  writeFileSync(filePath, yaml.dump(data))
  return filePath
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('signalProtocol', () => {
  let testDir: string

  beforeEach(() => {
    // Create unique temp directory for each test
    testDir = path.join(tmpdir(), `signal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  // ─── ensureSignalDir tests ────────────────────────────────────────────────

  describe('ensureSignalDir', () => {
    test('TEST-01: Creates signal dir and .tmp subdir', () => {
      const signalDir = path.join(testDir, 'signals')
      ensureSignalDir(signalDir)

      expect(existsSync(signalDir)).toBe(true)
      expect(existsSync(path.join(signalDir, '.tmp'))).toBe(true)
    })

    test('TEST-02: Idempotent (calling twice does not error)', () => {
      const signalDir = path.join(testDir, 'signals')
      ensureSignalDir(signalDir)
      ensureSignalDir(signalDir) // Should not throw

      expect(existsSync(signalDir)).toBe(true)
      expect(existsSync(path.join(signalDir, '.tmp'))).toBe(true)
    })

    test('TEST-03: Creates nested dirs (parents do not exist)', () => {
      const signalDir = path.join(testDir, 'a', 'b', 'c', 'signals')
      ensureSignalDir(signalDir)

      expect(existsSync(signalDir)).toBe(true)
      expect(existsSync(path.join(signalDir, '.tmp'))).toBe(true)
    })
  })

  // ─── readSignalFile tests ─────────────────────────────────────────────────

  describe('readSignalFile', () => {
    test('TEST-04: Reads valid signal YAML file', () => {
      const signalData = {
        version: 1,
        signal_type: 'completed',
        timestamp: '2026-02-12T10:00:00Z',
        agent: 'test-agent',
        step_name: 'build-step',
        run_id: 'run-123',
        checkpoint: {
          last_completed_subtask: 'subtask-1',
          completed_subtasks: ['subtask-1', 'subtask-2'],
          files_modified: ['src/main.ts'],
          last_build_status: 'pass',
          extensions: { custom: 'data' },
        },
      }

      const filePath = writeTestSignal(testDir, 'signal.yaml', signalData)
      const signal = readSignalFile(filePath)

      expect(signal).not.toBeNull()
      expect(signal?.version).toBe(1)
      expect(signal?.signal_type).toBe('completed')
      expect(signal?.agent).toBe('test-agent')
      expect(signal?.step_name).toBe('build-step')
      expect(signal?.checkpoint).not.toBeNull()
      expect(signal?.checkpoint?.last_completed_subtask).toBe('subtask-1')
      expect(signal?.checkpoint?.completed_subtasks).toEqual(['subtask-1', 'subtask-2'])
      expect(signal?.checkpoint?.files_modified).toEqual(['src/main.ts'])
      expect(signal?.checkpoint?.last_build_status).toBe('pass')
    })

    test('TEST-05: Returns null for non-existent file (ENOENT)', () => {
      const filePath = path.join(testDir, 'does-not-exist.yaml')
      const signal = readSignalFile(filePath)

      expect(signal).toBeNull()
    })

    test('TEST-06: Returns null for invalid YAML', () => {
      const filePath = path.join(testDir, 'invalid.yaml')
      writeFileSync(filePath, 'not: valid: yaml: {{{{')

      const signal = readSignalFile(filePath)

      expect(signal).toBeNull()
    })

    test('TEST-07: Maps unknown signal_type to "error"', () => {
      const signalData = {
        version: 1,
        signal_type: 'unknown_type',
        timestamp: '2026-02-12T10:00:00Z',
        agent: 'test-agent',
        step_name: 'build-step',
        run_id: 'run-123',
      }

      const filePath = writeTestSignal(testDir, 'signal.yaml', signalData)
      const signal = readSignalFile(filePath)

      expect(signal).not.toBeNull()
      expect(signal?.signal_type).toBe('error')
    })

    test('TEST-08: Defaults missing version to CURRENT_SIGNAL_VERSION', () => {
      const signalData = {
        signal_type: 'completed',
        timestamp: '2026-02-12T10:00:00Z',
        agent: 'test-agent',
        step_name: 'build-step',
        run_id: 'run-123',
      }

      const filePath = writeTestSignal(testDir, 'signal.yaml', signalData)
      const signal = readSignalFile(filePath)

      expect(signal).not.toBeNull()
      expect(signal?.version).toBe(CURRENT_SIGNAL_VERSION)
    })

    test('TEST-09: Handles version > current (best-effort parse)', () => {
      const signalData = {
        version: 99,
        signal_type: 'completed',
        timestamp: '2026-02-12T10:00:00Z',
        agent: 'test-agent',
        step_name: 'build-step',
        run_id: 'run-123',
      }

      const filePath = writeTestSignal(testDir, 'signal.yaml', signalData)
      const signal = readSignalFile(filePath)

      expect(signal).not.toBeNull()
      expect(signal?.version).toBe(99)
      expect(signal?.signal_type).toBe('completed')
    })

    test('TEST-10: Parses checkpoint fields correctly', () => {
      const signalData = {
        version: 1,
        signal_type: 'progress',
        timestamp: '2026-02-12T10:00:00Z',
        agent: 'test-agent',
        step_name: 'build-step',
        run_id: 'run-123',
        checkpoint: {
          last_completed_subtask: 'task-3',
          completed_subtasks: ['task-1', 'task-2', 'task-3'],
          files_modified: ['file1.ts', 'file2.ts'],
          last_build_status: 'fail',
          extensions: { build_logs: '/path/to/logs' },
        },
      }

      const filePath = writeTestSignal(testDir, 'signal.yaml', signalData)
      const signal = readSignalFile(filePath)

      expect(signal?.checkpoint).not.toBeNull()
      expect(signal?.checkpoint?.last_completed_subtask).toBe('task-3')
      expect(signal?.checkpoint?.completed_subtasks.length).toBe(3)
      expect(signal?.checkpoint?.files_modified.length).toBe(2)
      expect(signal?.checkpoint?.last_build_status).toBe('fail')
      expect(signal?.checkpoint?.extensions.build_logs).toBe('/path/to/logs')
    })
  })

  // ─── checkStepSignals tests ───────────────────────────────────────────────

  describe('checkStepSignals', () => {
    test('TEST-11: Returns matching signal for step', () => {
      const signalData = {
        version: 1,
        signal_type: 'completed',
        timestamp: '2026-02-12T10:00:00Z',
        agent: 'test-agent',
        step_name: 'target-step',
        run_id: 'run-123',
      }

      writeTestSignal(testDir, 'signal.yaml', signalData)
      // Use a startedAt well in the past so file mtime (now) is always newer
      const signal = checkStepSignals(testDir, 'target-step', '2020-01-01T00:00:00Z')

      expect(signal).not.toBeNull()
      expect(signal?.step_name).toBe('target-step')
    })

    test('TEST-12: Returns null when no signals exist', () => {
      const signal = checkStepSignals(testDir, 'target-step', '2026-02-12T09:00:00Z')

      expect(signal).toBeNull()
    })

    test('TEST-13: Filters out _resolved.yaml files', () => {
      const signalData = {
        version: 1,
        signal_type: 'completed',
        timestamp: '2026-02-12T10:00:00Z',
        agent: 'test-agent',
        step_name: 'target-step',
        run_id: 'run-123',
      }

      // Write a resolved signal file
      writeTestSignal(testDir, 'signal_resolved.yaml', signalData)

      const signal = checkStepSignals(testDir, 'target-step', '2020-01-01T00:00:00Z')

      expect(signal).toBeNull()
    })

    test('TEST-14: Filters stale signals by filesystem mtime (REQ-13/REQ-45)', () => {
      const signalData = {
        version: 1,
        signal_type: 'completed',
        timestamp: '2099-01-01T00:00:00Z', // Future YAML timestamp should NOT bypass mtime filter
        agent: 'test-agent',
        step_name: 'target-step',
        run_id: 'run-123',
      }

      const filePath = writeTestSignal(testDir, 'signal.yaml', signalData)
      // Set mtime to the past (before startedAt)
      const pastDate = new Date('2026-02-12T08:00:00Z')
      utimesSync(filePath, pastDate, pastDate)

      const signal = checkStepSignals(testDir, 'target-step', '2026-02-12T09:00:00Z')

      // Signal should be filtered out because filesystem mtime is before startedAt,
      // even though the YAML timestamp is in the future
      expect(signal).toBeNull()
    })

    test('TEST-15: Returns oldest-first by mtime when multiple signals exist', () => {
      const signal1 = {
        version: 1,
        signal_type: 'progress',
        timestamp: '2026-02-12T10:30:00Z',
        agent: 'test-agent',
        step_name: 'target-step',
        run_id: 'run-123',
      }

      const signal2 = {
        version: 1,
        signal_type: 'completed',
        timestamp: '2026-02-12T10:00:00Z',
        agent: 'test-agent',
        step_name: 'target-step',
        run_id: 'run-123',
      }

      // Write signal2 first, then signal1 -- mtime of signal2 is older
      const path2 = writeTestSignal(testDir, 'signal2.yaml', signal2)
      // Set signal2 mtime to an earlier time
      const earlierTime = new Date('2026-02-12T10:00:00Z')
      utimesSync(path2, earlierTime, earlierTime)

      const path1 = writeTestSignal(testDir, 'signal1.yaml', signal1)
      // Set signal1 mtime to a later time
      const laterTime = new Date('2026-02-12T10:30:00Z')
      utimesSync(path1, laterTime, laterTime)

      const signal = checkStepSignals(testDir, 'target-step', '2020-01-01T00:00:00Z')

      expect(signal).not.toBeNull()
      // Oldest by mtime is signal2 (completed)
      expect(signal?.signal_type).toBe('completed')
    })

    test('TEST-16: Returns null for non-existent signal dir (ENOENT)', () => {
      const nonExistentDir = path.join(testDir, 'does-not-exist')
      const signal = checkStepSignals(nonExistentDir, 'target-step', '2026-02-12T09:00:00Z')

      expect(signal).toBeNull()
    })

    test('TEST-26: Deduplication - skips already-processed signal files (REQ-14/REQ-44)', () => {
      const signalData = {
        version: 1,
        signal_type: 'completed',
        timestamp: '2026-02-12T10:00:00Z',
        agent: 'test-agent',
        step_name: 'target-step',
        run_id: 'run-123',
      }

      writeTestSignal(testDir, 'signal.yaml', signalData)
      const processedFiles = new Set<string>()

      // First call should return the signal and add it to processedFiles
      const signal1 = checkStepSignals(testDir, 'target-step', '2020-01-01T00:00:00Z', processedFiles)
      expect(signal1).not.toBeNull()
      expect(signal1?.signal_type).toBe('completed')
      expect(processedFiles.size).toBe(1)

      // Second call with same processedFiles should skip the already-processed signal
      const signal2 = checkStepSignals(testDir, 'target-step', '2020-01-01T00:00:00Z', processedFiles)
      expect(signal2).toBeNull()
    })

    test('TEST-27: Deduplication - new signal returned after previous one processed', () => {
      const signalData1 = {
        version: 1,
        signal_type: 'progress',
        timestamp: '2026-02-12T10:00:00Z',
        agent: 'test-agent',
        step_name: 'target-step',
        run_id: 'run-123',
      }

      writeTestSignal(testDir, 'signal1.yaml', signalData1)
      const processedFiles = new Set<string>()

      // First call returns signal1
      const result1 = checkStepSignals(testDir, 'target-step', '2020-01-01T00:00:00Z', processedFiles)
      expect(result1).not.toBeNull()
      expect(result1?.signal_type).toBe('progress')

      // Write a new signal file
      const signalData2 = {
        version: 1,
        signal_type: 'completed',
        timestamp: '2026-02-12T10:30:00Z',
        agent: 'test-agent',
        step_name: 'target-step',
        run_id: 'run-123',
      }
      writeTestSignal(testDir, 'signal2.yaml', signalData2)

      // Second call should skip signal1 but return signal2
      const result2 = checkStepSignals(testDir, 'target-step', '2020-01-01T00:00:00Z', processedFiles)
      expect(result2).not.toBeNull()
      expect(result2?.signal_type).toBe('completed')
    })

    test('TEST-28: mtime security - future YAML timestamp cannot bypass stale filter (REQ-45)', () => {
      const signalData = {
        version: 1,
        signal_type: 'completed',
        timestamp: '2099-12-31T23:59:59Z', // Far future YAML timestamp
        agent: 'malicious-agent',
        step_name: 'target-step',
        run_id: 'run-123',
      }

      const filePath = writeTestSignal(testDir, 'signal.yaml', signalData)
      // Set filesystem mtime to before the step started
      const pastDate = new Date('2026-02-11T00:00:00Z')
      utimesSync(filePath, pastDate, pastDate)

      // startedAt is 2026-02-12, mtime is 2026-02-11 => stale
      const signal = checkStepSignals(testDir, 'target-step', '2026-02-12T00:00:00Z')
      expect(signal).toBeNull()
    })
  })

  // ─── createSyntheticSignal tests ──────────────────────────────────────────

  describe('createSyntheticSignal', () => {
    test('TEST-17: Creates signal with synthetic=true, verified_completion=false', () => {
      const signal = createSyntheticSignal('test-step', 'run-456', 'completed')

      expect(signal.synthetic).toBe(true)
      expect(signal.verified_completion).toBe(false)
      expect(signal.agent).toBe('agentboard')
      expect(signal.step_name).toBe('test-step')
      expect(signal.run_id).toBe('run-456')
      expect(signal.signal_type).toBe('completed')
      expect(signal.checkpoint).toBeNull()
    })

    test('TEST-18: Uses provided source or defaults to "task_status_fallback"', () => {
      const signal1 = createSyntheticSignal('test-step', 'run-456', 'completed')
      expect(signal1.source).toBe('task_status_fallback')

      const signal2 = createSyntheticSignal('test-step', 'run-456', 'completed', 'custom_source')
      expect(signal2.source).toBe('custom_source')
    })
  })

  // ─── writeResolutionFile tests ────────────────────────────────────────────

  describe('writeResolutionFile', () => {
    test('TEST-19: Writes resolution file with correct name', () => {
      ensureSignalDir(testDir)

      const resolutionPath = writeResolutionFile(
        testDir,
        'signal.yaml',
        'resolved by human review',
        'user@example.com'
      )

      expect(resolutionPath).toBe(path.join(testDir, 'signal_resolved.yaml'))
      expect(existsSync(resolutionPath)).toBe(true)
    })

    test('TEST-20: Resolution file is valid YAML', async () => {
      ensureSignalDir(testDir)

      const checkpoint: SignalCheckpoint = {
        last_completed_subtask: 'task-1',
        completed_subtasks: ['task-1'],
        files_modified: ['file.ts'],
        last_build_status: 'pass',
        extensions: {},
      }

      const resolutionPath = writeResolutionFile(
        testDir,
        'signal.yaml',
        'approved',
        'reviewer@example.com',
        checkpoint
      )

      const content = await Bun.file(resolutionPath).text()
      const parsed = yaml.load(content) as Record<string, unknown>

      expect(parsed.signal_file).toBe('signal.yaml')
      expect(parsed.resolution).toBe('approved')
      expect(parsed.resolved_by).toBe('reviewer@example.com')
      expect(parsed.checkpoint_to_resume).not.toBeNull()
    })

    test('TEST-21: Uses write-then-rename (atomic via .tmp)', () => {
      ensureSignalDir(testDir)

      const resolutionPath = writeResolutionFile(
        testDir,
        'signal.yaml',
        'resolved',
        'user@example.com'
      )

      // Check that final file exists
      expect(existsSync(resolutionPath)).toBe(true)

      // Check that .tmp directory exists but is empty (temp file was renamed)
      const tmpDir = path.join(testDir, '.tmp')
      expect(existsSync(tmpDir)).toBe(true)
      const tmpFiles = readdirSync(tmpDir)
      expect(tmpFiles.length).toBe(0) // Temp file should be renamed away
    })
  })

  // ─── validateSignalAuthority tests ────────────────────────────────────────

  describe('validateSignalAuthority', () => {
    test('TEST-22: Synthetic signals are always valid', () => {
      const signal = createSyntheticSignal('test-step', 'run-123', 'completed')
      const isValid = validateSignalAuthority(signal)

      expect(isValid).toBe(true)
    })

    test('TEST-23: Empty agent returns false', () => {
      const signal: SignalFile = {
        version: 1,
        signal_type: 'completed',
        timestamp: '2026-02-12T10:00:00Z',
        agent: '',
        step_name: 'test-step',
        run_id: 'run-123',
        checkpoint: null,
      }

      const isValid = validateSignalAuthority(signal)

      expect(isValid).toBe(false)
    })

    test('TEST-24: Named agent returns true', () => {
      const signal: SignalFile = {
        version: 1,
        signal_type: 'completed',
        timestamp: '2026-02-12T10:00:00Z',
        agent: 'external-agent',
        step_name: 'test-step',
        run_id: 'run-123',
        checkpoint: null,
      }

      const isValid = validateSignalAuthority(signal)

      expect(isValid).toBe(true)
    })

    test('TEST-25: Non-synthetic agentboard signal warns but returns true', () => {
      const signal: SignalFile = {
        version: 1,
        signal_type: 'completed',
        timestamp: '2026-02-12T10:00:00Z',
        agent: 'agentboard',
        step_name: 'test-step',
        run_id: 'run-123',
        checkpoint: null,
        synthetic: false, // Explicitly not synthetic
      }

      let warnCalled = false
      const mockLogger = {
        warn: (..._args: unknown[]) => {
          warnCalled = true
        }
      }

      const isValid = validateSignalAuthority(signal, mockLogger)

      expect(isValid).toBe(true)
      expect(warnCalled).toBe(true)
    })
  })
})
