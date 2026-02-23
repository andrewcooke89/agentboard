/**
 * projectProfile.test.ts — Tests for project profile loading (Phase 9)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { loadProjectProfile } from '../projectProfile'

describe('projectProfile', () => {
  let testDir: string

  beforeEach(() => {
    testDir = path.join(tmpdir(), `profile-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(path.join(testDir, '.workflow'), { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('flattens nested objects to dot-notation keys', () => {
    const profile = {
      source_layout: {
        handlers: 'src/handlers/',
        models: 'src/models/',
      },
      project_name: 'my-project',
    }
    writeFileSync(
      path.join(testDir, '.workflow', 'project_profile.yaml'),
      yaml.dump(profile),
    )

    const result = loadProjectProfile(testDir)
    expect(result['source_layout.handlers']).toBe('src/handlers/')
    expect(result['source_layout.models']).toBe('src/models/')
    expect(result['project_name']).toBe('my-project')
  })

  test('handles deeply nested objects', () => {
    const profile = {
      targets: {
        languages: {
          primary: 'typescript',
          secondary: 'rust',
        },
      },
    }
    writeFileSync(
      path.join(testDir, '.workflow', 'project_profile.yaml'),
      yaml.dump(profile),
    )

    const result = loadProjectProfile(testDir)
    expect(result['targets.languages.primary']).toBe('typescript')
    expect(result['targets.languages.secondary']).toBe('rust')
  })

  test('serializes arrays as YAML strings', () => {
    const profile = {
      tags: ['web', 'api', 'backend'],
    }
    writeFileSync(
      path.join(testDir, '.workflow', 'project_profile.yaml'),
      yaml.dump(profile),
    )

    const result = loadProjectProfile(testDir)
    expect(result['tags']).toContain('web')
    expect(result['tags']).toContain('api')
  })

  test('returns empty record if file missing', () => {
    const result = loadProjectProfile('/nonexistent/path')
    expect(result).toEqual({})
  })

  test('returns empty record for non-object YAML', () => {
    writeFileSync(
      path.join(testDir, '.workflow', 'project_profile.yaml'),
      'just a string',
    )

    const result = loadProjectProfile(testDir)
    expect(result).toEqual({})
  })

  // ─── Variable interpolation tests (Phase 9) ──────────────────────────────

  test('TEST-14: Simple variable resolution from project profile', () => {
    const profile = {
      language: 'rust',
      framework: 'axum',
      test_framework: 'cargo-test',
    }
    writeFileSync(
      path.join(testDir, '.workflow', 'project_profile.yaml'),
      yaml.dump(profile),
    )

    const result = loadProjectProfile(testDir)

    expect(result['language']).toBe('rust')
    expect(result['framework']).toBe('axum')
    expect(result['test_framework']).toBe('cargo-test')
  })

  test('TEST-15: Nested variable resolution from project profile', () => {
    const profile = {
      source_layout: {
        handlers: 'src/handlers/',
        models: 'src/models/',
        tests: 'tests/',
      },
      deep: {
        nested: {
          value: 'found-it',
        },
      },
    }
    writeFileSync(
      path.join(testDir, '.workflow', 'project_profile.yaml'),
      yaml.dump(profile),
    )

    const result = loadProjectProfile(testDir)

    // Verify nested access via dot notation
    expect(result['source_layout.handlers']).toBe('src/handlers/')
    expect(result['source_layout.models']).toBe('src/models/')
    expect(result['source_layout.tests']).toBe('tests/')
    expect(result['deep.nested.value']).toBe('found-it')
  })

  test('TEST-18: Missing project_profile.yaml returns empty', () => {
    // No profile file created
    const result = loadProjectProfile('/nonexistent/path/to/project')

    expect(result).toEqual({})
  })

  test('handles mixed types (numbers, booleans)', () => {
    const profile = {
      settings: {
        port: 3000,
        debug: true,
      },
    }
    writeFileSync(
      path.join(testDir, '.workflow', 'project_profile.yaml'),
      yaml.dump(profile),
    )

    const result = loadProjectProfile(testDir)
    // FAILSAFE_SCHEMA means everything comes back as strings
    expect(result['settings.port']).toBe('3000')
    expect(result['settings.debug']).toBe('true')
  })
})
