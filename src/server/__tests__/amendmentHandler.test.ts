/**
 * amendmentHandler.test.ts -- Tests for amendment signal parsing, routing, and I/O (Phase 10)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseAmendmentSignal,
  shouldAutoReview,
  shouldEscalateToHuman,
  isFundamental,
  buildHandlerPrompt,
  buildResumePrompt,
  writeAmendmentRecord,
  readResolutionFile,
  type AmendmentSignal,
  type AmendmentConfig,
  type AmendmentResolution,
} from '../amendmentHandler'

const tmpDir = join(import.meta.dir, '.tmp-amendment-test')

beforeEach(() => {
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
})

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
})

describe('parseAmendmentSignal', () => {
  it('parses valid amendment signal', () => {
    const input = {
      signal_type: 'amendment_required',
      amendment: {
        type: 'gap',
        category: 'quality',
        spec_section: 'auth.login',
        issue: 'Missing error handling for expired tokens',
        proposed_addition: 'Add token refresh flow',
        target: 'spec',
      },
      checkpoint: { step: 3, progress: 'partial' },
    }
    const result = parseAmendmentSignal(input)
    expect(result).not.toBeNull()
    expect(result!.amendment.type).toBe('gap')
    expect(result!.amendment.category).toBe('quality')
    expect(result!.amendment.spec_section).toBe('auth.login')
    expect(result!.amendment.issue).toBe('Missing error handling for expired tokens')
    expect(result!.amendment.proposed_addition).toBe('Add token refresh flow')
    expect(result!.amendment.target).toBe('spec')
    expect(result!.checkpoint).toEqual({ step: 3, progress: 'partial' })
  })

  it('returns null for missing amendment block', () => {
    expect(parseAmendmentSignal({ signal_type: 'other' })).toBeNull()
  })

  it('returns null for incomplete amendment', () => {
    expect(parseAmendmentSignal({
      amendment: { type: 'gap' },  // missing category, spec_section, issue
    })).toBeNull()
  })

  it('returns null for null/undefined input', () => {
    expect(parseAmendmentSignal(null as any)).toBeNull()
    expect(parseAmendmentSignal(undefined as any)).toBeNull()
  })

  // SEC-1: Input sanitization tests
  it('rejects oversized issue field (SEC-1)', () => {
    const MAX_FIELD_LENGTH = 100 * 1024 // 100KB
    const oversizedIssue = 'x'.repeat(MAX_FIELD_LENGTH + 1)
    const input = {
      signal_type: 'amendment_required',
      amendment: {
        type: 'gap',
        category: 'quality',
        spec_section: 'auth.login',
        issue: oversizedIssue,
        proposed_addition: 'Normal size',
      },
      checkpoint: {},
    }
    const result = parseAmendmentSignal(input)
    expect(result).toBeNull()
  })

  it('rejects oversized proposed_addition field (SEC-1)', () => {
    const MAX_FIELD_LENGTH = 100 * 1024 // 100KB
    const oversizedProposal = 'y'.repeat(MAX_FIELD_LENGTH + 1)
    const input = {
      signal_type: 'amendment_required',
      amendment: {
        type: 'gap',
        category: 'quality',
        spec_section: 'auth.login',
        issue: 'Normal issue',
        proposed_addition: oversizedProposal,
      },
      checkpoint: {},
    }
    const result = parseAmendmentSignal(input)
    expect(result).toBeNull()
  })

  it('accepts fields at exactly max size (SEC-1)', () => {
    const MAX_FIELD_LENGTH = 100 * 1024 // 100KB
    const maxSizeIssue = 'x'.repeat(MAX_FIELD_LENGTH)
    const input = {
      signal_type: 'amendment_required',
      amendment: {
        type: 'gap',
        category: 'quality',
        spec_section: 'auth.login',
        issue: maxSizeIssue,
        proposed_addition: 'Normal size',
      },
      checkpoint: {},
    }
    const result = parseAmendmentSignal(input)
    expect(result).not.toBeNull()
    expect(result!.amendment.issue.length).toBe(MAX_FIELD_LENGTH)
  })
})

describe('isFundamental', () => {
  it('detects fundamental by type', () => {
    const signal: AmendmentSignal = {
      signal_type: 'amendment_required',
      amendment: { type: 'fundamental', category: 'quality', spec_section: 'x', issue: 'y' },
      checkpoint: {},
    }
    expect(isFundamental(signal)).toBe(true)
  })

  it('detects fundamental by category', () => {
    const signal: AmendmentSignal = {
      signal_type: 'amendment_required',
      amendment: { type: 'gap', category: 'fundamental', spec_section: 'x', issue: 'y' },
      checkpoint: {},
    }
    expect(isFundamental(signal)).toBe(true)
  })

  it('returns false for non-fundamental', () => {
    const signal: AmendmentSignal = {
      signal_type: 'amendment_required',
      amendment: { type: 'gap', category: 'quality', spec_section: 'x', issue: 'y' },
      checkpoint: {},
    }
    expect(isFundamental(signal)).toBe(false)
  })
})

describe('shouldAutoReview', () => {
  const config: AmendmentConfig = {
    auto_review_types: ['gap', 'correction', 'reconciliation'],
  }

  it('allows auto-review for gap type', () => {
    const signal: AmendmentSignal = {
      signal_type: 'amendment_required',
      amendment: { type: 'gap', category: 'quality', spec_section: 'x', issue: 'y' },
      checkpoint: {},
    }
    expect(shouldAutoReview(signal, config)).toBe(true)
  })

  it('rejects auto-review for scope_change', () => {
    const signal: AmendmentSignal = {
      signal_type: 'amendment_required',
      amendment: { type: 'scope_change', category: 'quality', spec_section: 'x', issue: 'y' },
      checkpoint: {},
    }
    expect(shouldAutoReview(signal, config)).toBe(false)
  })

  it('rejects auto-review for fundamental', () => {
    const signal: AmendmentSignal = {
      signal_type: 'amendment_required',
      amendment: { type: 'fundamental', category: 'fundamental', spec_section: 'x', issue: 'y' },
      checkpoint: {},
    }
    expect(shouldAutoReview(signal, config)).toBe(false)
  })
})

describe('shouldEscalateToHuman', () => {
  const config: AmendmentConfig = {
    human_required_types: ['fundamental', 'scope_change'],
    human_required_tiers: [0],
  }

  it('escalates fundamental amendments', () => {
    const signal: AmendmentSignal = {
      signal_type: 'amendment_required',
      amendment: { type: 'fundamental', category: 'fundamental', spec_section: 'x', issue: 'y' },
      checkpoint: {},
    }
    expect(shouldEscalateToHuman(signal, config)).toBe(true)
  })

  it('escalates constitution targets', () => {
    const signal: AmendmentSignal = {
      signal_type: 'amendment_required',
      amendment: { type: 'gap', category: 'quality', spec_section: 'x', issue: 'y', target: 'constitution' },
      checkpoint: {},
    }
    expect(shouldEscalateToHuman(signal, config)).toBe(true)
  })

  it('escalates scope_change type', () => {
    const signal: AmendmentSignal = {
      signal_type: 'amendment_required',
      amendment: { type: 'scope_change', category: 'quality', spec_section: 'x', issue: 'y' },
      checkpoint: {},
    }
    expect(shouldEscalateToHuman(signal, config)).toBe(true)
  })

  it('escalates based on tier', () => {
    const signal: AmendmentSignal = {
      signal_type: 'amendment_required',
      amendment: { type: 'gap', category: 'quality', spec_section: 'x', issue: 'y' },
      checkpoint: {},
    }
    expect(shouldEscalateToHuman(signal, config, 0)).toBe(true)
    expect(shouldEscalateToHuman(signal, config, 1)).toBe(false)
  })

  it('does not escalate normal auto-reviewable types', () => {
    const signal: AmendmentSignal = {
      signal_type: 'amendment_required',
      amendment: { type: 'gap', category: 'quality', spec_section: 'x', issue: 'y' },
      checkpoint: {},
    }
    expect(shouldEscalateToHuman(signal, config)).toBe(false)
  })
})

describe('buildHandlerPrompt', () => {
  it('includes amendment details and checkpoint', () => {
    const signal: AmendmentSignal = {
      signal_type: 'amendment_required',
      amendment: { type: 'gap', category: 'quality', spec_section: 'auth.login', issue: 'Missing error handling' },
      checkpoint: { step: 3 },
    }
    const prompt = buildHandlerPrompt(signal, '/path/to/spec.md', ['security', 'auth'], { step: 3 })
    expect(prompt).toContain('gap')
    expect(prompt).toContain('quality')
    expect(prompt).toContain('auth.login')
    expect(prompt).toContain('Missing error handling')
    expect(prompt).toContain('/path/to/spec.md')
    expect(prompt).toContain('security, auth')
    expect(prompt).toContain('"step": 3')
  })
})

describe('buildResumePrompt', () => {
  it('includes resolution and checkpoint for approved', () => {
    const prompt = buildResumePrompt(
      { step: 3, progress: 'partial' },
      { type: 'gap', spec_section: 'auth', issue: 'Missing handler' },
      'approved',
    )
    expect(prompt).toContain('approved')
    expect(prompt).toContain('gap')
    expect(prompt).toContain('auth')
    expect(prompt).toContain('Missing handler')
    expect(prompt).toContain('"step": 3')
    expect(prompt).toContain('re-read the relevant spec section')
  })

  it('includes rejection note for rejected', () => {
    const prompt = buildResumePrompt(
      {},
      { type: 'correction', spec_section: 'db', issue: 'Wrong schema' },
      'rejected',
    )
    expect(prompt).toContain('rejected')
    expect(prompt).toContain('Continue with the original spec as-is')
  })

  it('includes deferred note for deferred', () => {
    const prompt = buildResumePrompt(
      {},
      { type: 'gap', spec_section: 'api', issue: 'Missing endpoint' },
      'deferred',
    )
    expect(prompt).toContain('deferred')
    expect(prompt).toContain('tracked for later resolution')
  })
})

describe('writeAmendmentRecord + readResolutionFile', () => {
  it('writes and reads amendment records', () => {
    const signal: AmendmentSignal = {
      signal_type: 'amendment_required',
      amendment: { type: 'gap', category: 'quality', spec_section: 'auth', issue: 'test issue' },
      checkpoint: { step: 1 },
    }
    const resolution: AmendmentResolution = {
      signal_file: '/tmp/signal.yaml',
      resolution: 'approved',
      amendment_id: 'amend-001',
      resolved_at: '2026-01-01T00:00:00Z',
      resolved_by: 'amendment-handler',
      spec_changes: 'Updated auth section',
    }

    const filePath = writeAmendmentRecord(tmpDir, signal, resolution)
    expect(existsSync(filePath)).toBe(true)

    // Read it back as a resolution file
    const read = readResolutionFile(filePath)
    expect(read).not.toBeNull()
    expect(read!.resolution).toBe('approved')
    expect(read!.amendment_id).toBe('amend-001')
    expect(read!.resolved_by).toBe('amendment-handler')
  })

  it('returns null for non-existent file', () => {
    expect(readResolutionFile('/nonexistent/path.yaml')).toBeNull()
  })
})
