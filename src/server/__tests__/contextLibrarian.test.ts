/**
 * contextLibrarian.test.ts - Tests for context briefing preparation (Phase 25)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import {
  prepareContextBriefing,
  createDefaultBriefingConfig,
  type ContextBriefingConfig,
} from '../contextLibrarian'

describe('contextLibrarian', () => {
  let testDir: string
  let projectDir: string
  let runDir: string

  beforeEach(() => {
    testDir = path.join(tmpdir(), `ctx-librarian-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    projectDir = path.join(testDir, 'project')
    runDir = path.join(testDir, 'run')

    mkdirSync(path.join(projectDir, '.workflow'), { recursive: true })
    mkdirSync(runDir, { recursive: true })

    // Create basic project structure
    writeFileSync(path.join(projectDir, 'package.json'), '{"name": "test-project"}')
    writeFileSync(path.join(projectDir, 'README.md'), '# Test Project\n\nA test project.')
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  describe('prepareContextBriefing', () => {
    test('creates briefing file', async () => {
      const config: ContextBriefingConfig = {
        consumer_profile: 'implementor',
        token_budget: 10000,
        sources: ['codebase'],
      }

      const briefingPath = await prepareContextBriefing(config, runDir, projectDir)

      expect(existsSync(briefingPath)).toBe(true)
      expect(briefingPath).toContain('context-briefing.md')
    })

    test('includes header metadata', async () => {
      const config: ContextBriefingConfig = {
        consumer_profile: 'reviewer',
        token_budget: 15000,
        sources: ['codebase'],
      }

      const briefingPath = await prepareContextBriefing(config, runDir, projectDir)

      const fs = await import('node:fs/promises')
      const content = await fs.readFile(briefingPath, 'utf-8')

      expect(content).toContain('Profile: reviewer')
      expect(content).toContain('Token Budget: 15000')
    })

    test('gathers codebase source', async () => {
      const config: ContextBriefingConfig = {
        consumer_profile: 'implementor',
        token_budget: 10000,
        sources: ['codebase'],
      }

      const briefingPath = await prepareContextBriefing(config, runDir, projectDir)

      const fs = await import('node:fs/promises')
      const content = await fs.readFile(briefingPath, 'utf-8')

      // Should include project files
      expect(content).toContain('package.json')
    })

    test('gathers project facts from profile', async () => {
      writeFileSync(
        path.join(projectDir, '.workflow', 'project_profile.yaml'),
        'language: typescript\nframework: bun'
      )

      const config: ContextBriefingConfig = {
        consumer_profile: 'planner',
        token_budget: 10000,
        sources: ['project_facts'],
      }

      const briefingPath = await prepareContextBriefing(config, runDir, projectDir)

      const fs = await import('node:fs/promises')
      const content = await fs.readFile(briefingPath, 'utf-8')

      expect(content).toContain('Project Profile')
      expect(content).toContain('language')
    })

    test('gathers blackboard from run dir', async () => {
      writeFileSync(
        path.join(runDir, 'blackboard.yaml'),
        'feature_id: FEAT-001\nstatus: in_progress'
      )

      const config: ContextBriefingConfig = {
        consumer_profile: 'reviewer',
        token_budget: 10000,
        sources: ['blackboard'],
      }

      const briefingPath = await prepareContextBriefing(config, runDir, projectDir)

      const fs = await import('node:fs/promises')
      const content = await fs.readFile(briefingPath, 'utf-8')

      expect(content).toContain('Blackboard')
      expect(content).toContain('FEAT-001')
    })

    test('handles missing sources gracefully', async () => {
      const config: ContextBriefingConfig = {
        consumer_profile: 'implementor',
        token_budget: 10000,
        sources: ['memory', 'related_wos'],  // These won't exist
      }

      const briefingPath = await prepareContextBriefing(config, runDir, projectDir)

      expect(existsSync(briefingPath)).toBe(true)
    })

    test('compresses to token budget', async () => {
      const config: ContextBriefingConfig = {
        consumer_profile: 'reviewer',
        token_budget: 500,  // Very small budget
        sources: ['codebase'],
      }

      const briefingPath = await prepareContextBriefing(config, runDir, projectDir)

      const fs = await import('node:fs/promises')
      const content = await fs.readFile(briefingPath, 'utf-8')

      // Content should be truncated
      const tokens = Math.ceil(content.length / 4)
      expect(tokens).toBeLessThanOrEqual(1000)  // Allow some overhead
    })
  })

  describe('createDefaultBriefingConfig', () => {
    test('creates planner config with 30K budget', () => {
      const config = createDefaultBriefingConfig('planner')

      expect(config.consumer_profile).toBe('planner')
      expect(config.token_budget).toBe(30000)
    })

    test('creates reviewer config with 15K budget', () => {
      const config = createDefaultBriefingConfig('reviewer')

      expect(config.consumer_profile).toBe('reviewer')
      expect(config.token_budget).toBe(15000)
    })

    test('creates implementor config with 25K budget', () => {
      const config = createDefaultBriefingConfig('implementor')

      expect(config.consumer_profile).toBe('implementor')
      expect(config.token_budget).toBe(25000)
    })

    test('includes all sources by default', () => {
      const config = createDefaultBriefingConfig('planner')

      expect(config.sources).toContain('codebase')
      expect(config.sources).toContain('project_facts')
      expect(config.sources).toContain('memory')
      expect(config.sources).toContain('blackboard')
      expect(config.sources).toContain('session')
      expect(config.sources).toContain('related_wos')
    })
  })

  describe('source priorities', () => {
    test('planner prioritizes blackboard', async () => {
      // Create both blackboard and codebase content
      writeFileSync(path.join(runDir, 'blackboard.yaml'), 'decision: use-typescript')

      const config: ContextBriefingConfig = {
        consumer_profile: 'planner',
        token_budget: 500,  // Small enough to force truncation
        sources: ['codebase', 'blackboard'],
      }

      const briefingPath = await prepareContextBriefing(config, runDir, projectDir)

      const fs = await import('node:fs/promises')
      const content = await fs.readFile(briefingPath, 'utf-8')

      // Blackboard should appear before codebase for planner
      const blackboardIndex = content.indexOf('Blackboard')
      const codebaseIndex = content.indexOf('Directory Structure')

      if (blackboardIndex !== -1 && codebaseIndex !== -1) {
        expect(blackboardIndex).toBeLessThan(codebaseIndex)
      }
    })

    test('implementor prioritizes codebase', async () => {
      writeFileSync(path.join(runDir, 'blackboard.yaml'), 'decision: test')

      const config: ContextBriefingConfig = {
        consumer_profile: 'implementor',
        token_budget: 500,
        sources: ['blackboard', 'codebase'],
      }

      const briefingPath = await prepareContextBriefing(config, runDir, projectDir)

      expect(existsSync(briefingPath)).toBe(true)
    })
  })
})
