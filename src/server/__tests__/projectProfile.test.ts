/**
 * projectProfile.test.ts — Tests for project profile loading (Phase 9)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { loadProjectProfile, extractTestContext } from '../projectProfile'

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

describe('extractTestContext', () => {
  test('extracts full test context from profile', () => {
    const profile = {
      test_context: {
        runner: 'bun test',
        import_style: "import { describe, test, expect } from 'bun:test'",
        file_pattern: 'src/**/__tests__/*.test.ts',
        constraints: ['No database', 'No network calls'],
        mock_patterns: ['Use mock() from bun:test'],
        reference_tests: ['src/server/__tests__/specValidator.test.ts'],
      },
    }

    const result = extractTestContext(profile)
    expect(result).not.toBeNull()
    expect(result!.runner).toBe('bun test')
    expect(result!.import_style).toContain('bun:test')
    expect(result!.file_pattern).toBe('src/**/__tests__/*.test.ts')
    expect(result!.constraints).toHaveLength(2)
    expect(result!.constraints[0]).toBe('No database')
    expect(result!.mock_patterns).toHaveLength(1)
    expect(result!.reference_tests).toHaveLength(1)
  })

  test('returns null when test_context is missing', () => {
    const result = extractTestContext({})
    expect(result).toBeNull()
  })

  test('returns null when test_context is not an object', () => {
    const result = extractTestContext({ test_context: 'invalid' })
    expect(result).toBeNull()
  })

  test('provides defaults for missing fields', () => {
    const profile = {
      test_context: {
        // Only runner specified, everything else should get defaults
        runner: 'jest',
      },
    }

    const result = extractTestContext(profile)
    expect(result).not.toBeNull()
    expect(result!.runner).toBe('jest')
    expect(result!.import_style).toContain('bun:test') // default
    expect(result!.file_pattern).toBe('src/**/__tests__/*.test.ts') // default
    expect(result!.constraints).toEqual([])
    expect(result!.mock_patterns).toEqual([])
    expect(result!.reference_tests).toEqual([])
  })

  test('handles non-array constraints gracefully', () => {
    const profile = {
      test_context: {
        runner: 'bun test',
        constraints: 'not an array',
        mock_patterns: 42,
        reference_tests: null,
      },
    }

    const result = extractTestContext(profile)
    expect(result).not.toBeNull()
    expect(result!.constraints).toEqual([])
    expect(result!.mock_patterns).toEqual([])
    expect(result!.reference_tests).toEqual([])
  })
})
