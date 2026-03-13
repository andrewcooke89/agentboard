/**
 * specValidator.test.ts — Tests for spec validation utility
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { validateSpec, loadConstitution } from '../specValidator'

// ─── Test Helpers ───────────────────────────────────────────────────────────

function writeTestFile(dir: string, filename: string, data: Record<string, unknown>, useDefaultSchema = false): string {
  const filePath = path.join(dir, filename)
  const opts = useDefaultSchema ? {} : { schema: yaml.FAILSAFE_SCHEMA }
  writeFileSync(filePath, yaml.dump(data, opts))
  return filePath
}

const BASE_SCHEMA = {
  version: 'feature_spec_v1.0',
  required_fields: {
    title: { type: 'string' },
    acceptance: { type: 'array' },
    scope: { type: 'object' },
  },
  optional_fields: {
    description: { type: 'string' },
    schema_version: { type: 'string' },
  },
  valid_acceptance_types: ['contract', 'property', 'benchmark', 'invariant', 'behavioral'],
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('specValidator', () => {
  let testDir: string

  beforeEach(() => {
    // Create unique temp directory for each test
    testDir = path.join(tmpdir(), `spec-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  // ─── Valid spec tests ─────────────────────────────────────────────────────

  describe('Valid specs', () => {
    test('TEST-01: Valid spec passes validation', () => {
      const spec = {
        schema_version: 'feature_spec_v1.0',
        title: 'Test Feature',
        description: 'A test feature',
        acceptance: [
          { type: 'contract', criterion: 'Must handle errors' },
          { type: 'property', criterion: 'Response time < 100ms' },
        ],
        scope: {
          files: ['src/test.ts'],
        },
      }

      const specPath = writeTestFile(testDir, 'spec.yaml', spec)
      const schemaPath = writeTestFile(testDir, 'schema.yaml', BASE_SCHEMA)

      const report = validateSpec(specPath, schemaPath, [], false)

      expect(report.valid).toBe(true)
      expect(report.errors).toHaveLength(0)
      expect(report.warnings).toHaveLength(0)
    })
  })

  // ─── Missing required fields ──────────────────────────────────────────────

  describe('Missing required fields', () => {
    test('TEST-02: Missing required field (title) produces missing_required error', () => {
      const spec = {
        acceptance: [{ type: 'contract', criterion: 'Test' }],
        scope: { files: ['src/test.ts'] },
      }

      const specPath = writeTestFile(testDir, 'spec.yaml', spec)
      const schemaPath = writeTestFile(testDir, 'schema.yaml', BASE_SCHEMA)

      const report = validateSpec(specPath, schemaPath, [], false)

      expect(report.valid).toBe(false)
      expect(report.errors).toHaveLength(1)
      expect(report.errors[0].field).toBe('title')
      expect(report.errors[0].type).toBe('missing_required')
      expect(report.errors[0].message).toContain('missing')
    })
  })

  // ─── Wrong type tests ─────────────────────────────────────────────────────

  describe('Wrong types', () => {
    test('TEST-03: Wrong type (acceptance as string instead of array) produces wrong_type error', () => {
      const spec = {
        title: 'Test Feature',
        acceptance: 'not an array',
        scope: { files: ['src/test.ts'] },
      }

      const specPath = writeTestFile(testDir, 'spec.yaml', spec)
      const schemaPath = writeTestFile(testDir, 'schema.yaml', BASE_SCHEMA)

      const report = validateSpec(specPath, schemaPath, [], false)

      expect(report.valid).toBe(false)
      expect(report.errors.length).toBeGreaterThan(0)
      const typeError = report.errors.find(e => e.field === 'acceptance')
      expect(typeError).toBeDefined()
      expect(typeError?.type).toBe('wrong_type')
    })
  })

  // ─── Untyped acceptance criteria ──────────────────────────────────────────

  describe('Untyped acceptance criteria', () => {
    test('TEST-04: Untyped acceptance criteria produces untyped_criterion warning', () => {
      const spec = {
        title: 'Test Feature',
        acceptance: [
          { criterion: 'No type field here' },
        ],
        scope: { files: ['src/test.ts'] },
      }

      const specPath = writeTestFile(testDir, 'spec.yaml', spec)
      const schemaPath = writeTestFile(testDir, 'schema.yaml', BASE_SCHEMA)

      const report = validateSpec(specPath, schemaPath, [], false)

      expect(report.valid).toBe(true) // Warnings don't fail validation
      expect(report.warnings).toHaveLength(1)
      expect(report.warnings[0].field).toBe('acceptance[0]')
      expect(report.warnings[0].type).toBe('untyped_criterion')
    })

    test('TEST-34: Mixed typed/untyped criteria - typed ones pass, untyped ones warn', () => {
      const spec = {
        title: 'Test Feature',
        acceptance: [
          { type: 'contract', criterion: 'Has type' },
          { criterion: 'No type' },
          { type: 'property', criterion: 'Also has type' },
        ],
        scope: { files: ['src/test.ts'] },
      }

      const specPath = writeTestFile(testDir, 'spec.yaml', spec)
      const schemaPath = writeTestFile(testDir, 'schema.yaml', BASE_SCHEMA)

      const report = validateSpec(specPath, schemaPath, [], false)

      expect(report.valid).toBe(true)
      expect(report.warnings).toHaveLength(1)
      expect(report.warnings[0].field).toBe('acceptance[1]')
      expect(report.warnings[0].type).toBe('untyped_criterion')
    })
  })

  // ─── Constitution checks ──────────────────────────────────────────────────

  describe('Constitution checks', () => {
    test('TEST-05: Secrets detection (AWS key) fails security constitution check', () => {
      const spec = {
        title: 'Test Feature',
        acceptance: [{ type: 'contract', criterion: 'Test' }],
        scope: { files: ['src/test.ts'] },
        notes: 'My AWS key is AKIAIOSFODNN7EXAMPLE',
      }

      const specPath = writeTestFile(testDir, 'spec.yaml', spec)
      const schemaPath = writeTestFile(testDir, 'schema.yaml', BASE_SCHEMA)

      const report = validateSpec(specPath, schemaPath, ['security'], false)

      expect(report.valid).toBe(true) // Constitution checks don't affect valid field directly
      expect(report.constitution_checks).toHaveLength(1)
      expect(report.constitution_checks[0].section).toBe('security')
      expect(report.constitution_checks[0].result).toBe('fail')
      expect(report.constitution_checks[0].findings.length).toBeGreaterThan(0)
    })

    test('TEST-06: Wildcard scope (**/*) fails architecture constitution check', () => {
      const spec = {
        title: 'Test Feature',
        acceptance: [{ type: 'contract', criterion: 'Test' }],
        scope: {
          files: ['**/*'],
        },
      }

      const specPath = writeTestFile(testDir, 'spec.yaml', spec)
      const schemaPath = writeTestFile(testDir, 'schema.yaml', BASE_SCHEMA)

      const report = validateSpec(specPath, schemaPath, ['architecture'], false)

      expect(report.valid).toBe(true)
      expect(report.constitution_checks).toHaveLength(1)
      expect(report.constitution_checks[0].section).toBe('architecture')
      expect(report.constitution_checks[0].result).toBe('fail')
      expect(report.constitution_checks[0].findings.length).toBeGreaterThan(0)
    })

    test('TEST-05b: Quality check detects untyped acceptance criteria', () => {
      const spec = {
        title: 'Test Feature',
        acceptance: [
          { criterion: 'No type field' },
        ],
        scope: { files: ['src/test.ts'] },
      }

      const specPath = writeTestFile(testDir, 'spec.yaml', spec)
      const schemaPath = writeTestFile(testDir, 'schema.yaml', BASE_SCHEMA)

      const report = validateSpec(specPath, schemaPath, ['quality'], false)

      expect(report.valid).toBe(true)
      expect(report.constitution_checks).toHaveLength(1)
      expect(report.constitution_checks[0].section).toBe('quality')
      expect(report.constitution_checks[0].result).toBe('fail')
      expect(report.constitution_checks[0].findings).toContain('acceptance[0]: missing type field')
    })
  })

  // ─── Strict mode tests ────────────────────────────────────────────────────

  describe('Strict mode', () => {
    test('TEST-07: Strict mode promotes warnings to errors (causes failure)', () => {
      const spec = {
        title: 'Test Feature',
        acceptance: [
          { criterion: 'No type field' },
        ],
        scope: { files: ['src/test.ts'] },
      }

      const specPath = writeTestFile(testDir, 'spec.yaml', spec)
      const schemaPath = writeTestFile(testDir, 'schema.yaml', BASE_SCHEMA)

      const report = validateSpec(specPath, schemaPath, [], true)

      expect(report.valid).toBe(false) // Strict mode makes warnings into errors
      expect(report.errors).toHaveLength(1)
      expect(report.warnings).toHaveLength(0) // Warnings moved to errors
      expect(report.errors[0].type).toBe('untyped_criterion')
    })
  })

  // ─── Pool bypass and output tests ────────────────────────────────────────

  describe('spec_validate pool and output tests', () => {
    test('TEST-08: spec_validate does not consume pool slot', () => {
      // This is verified by POOL_BYPASS_TYPES in dagEngine.ts
      // We can test indirectly by checking the constant exists
      // In actual integration test, verify pool count doesn't change

      // For unit test, just verify the validator function works without pool
      const spec = {
        title: 'Test Feature',
        acceptance: [{ type: 'contract', criterion: 'Test' }],
        scope: { files: ['src/test.ts'] },
      }

      const specPath = writeTestFile(testDir, 'spec.yaml', spec)
      const schemaPath = writeTestFile(testDir, 'schema.yaml', BASE_SCHEMA)

      // Should execute without requiring any pool context
      const report = validateSpec(specPath, schemaPath, [], false)

      expect(report.valid).toBe(true)
      // No pool interaction - executes synchronously
    })

    test('TEST-09: Validation report has all required fields', () => {
      const spec = {
        title: 'Test Feature',
        acceptance: [{ type: 'contract', criterion: 'Test' }],
        scope: { files: ['src/test.ts'] },
      }

      const specPath = writeTestFile(testDir, 'spec.yaml', spec)
      const schemaPath = writeTestFile(testDir, 'schema.yaml', BASE_SCHEMA)

      const report = validateSpec(specPath, schemaPath, ['security'], false)

      // Verify all required fields exist (REQ-10)
      expect(report).toHaveProperty('spec_path')
      expect(report).toHaveProperty('schema')
      expect(report).toHaveProperty('valid')
      expect(report).toHaveProperty('errors')
      expect(report).toHaveProperty('warnings')
      expect(report).toHaveProperty('constitution_checks')

      expect(Array.isArray(report.errors)).toBe(true)
      expect(Array.isArray(report.warnings)).toBe(true)
      expect(Array.isArray(report.constitution_checks)).toBe(true)
    })
  })

  // ─── Constitution file loading ────────────────────────────────────────────

  describe('Constitution file loading', () => {
    test('loadConstitution returns null for missing file', () => {
      const result = loadConstitution(path.join(testDir, 'nonexistent.yaml'))
      expect(result).toBeNull()
    })

    test('loadConstitution parses valid constitution file', () => {
      const constitution = {
        version: 1,
        sections: {
          security: {
            description: 'Custom security checks',
            severity: 'fail',
            patterns: [
              { regex: 'SECRET_[A-Z]+', description: 'Custom secret pattern' },
            ],
          },
        },
      }
      const constitutionPath = writeTestFile(testDir, 'constitution.yaml', constitution, true)
      const result = loadConstitution(constitutionPath)

      expect(result).not.toBeNull()
      expect(result!.security).toBeDefined()
      expect(result!.security.patterns).toHaveLength(1)
      expect(result!.security.description).toBe('Custom security checks')
      expect(result!.security.severity).toBe('fail')
    })

    test('loadConstitution handles regex flags', () => {
      const constitution = {
        version: 1,
        sections: {
          custom: {
            description: 'Case insensitive check',
            severity: 'warn',
            patterns: [
              { regex: 'todo', flags: 'i', description: 'TODO comments' },
            ],
          },
        },
      }
      const constitutionPath = writeTestFile(testDir, 'constitution.yaml', constitution, true)
      const result = loadConstitution(constitutionPath)

      expect(result).not.toBeNull()
      expect(result!.custom.patterns[0].flags).toBe('i')
      expect(result!.custom.patterns[0].test('TODO')).toBe(true)
      expect(result!.custom.patterns[0].test('todo')).toBe(true)
    })

    test('loadConstitution returns null for invalid YAML', () => {
      writeFileSync(path.join(testDir, 'bad.yaml'), '{{invalid yaml')
      const result = loadConstitution(path.join(testDir, 'bad.yaml'))
      expect(result).toBeNull()
    })

    test('validateSpec falls back to defaults when constitution file missing', () => {
      const spec = {
        title: 'Test Feature',
        acceptance: [{ type: 'contract', criterion: 'Test' }],
        scope: { files: ['src/test.ts'] },
        notes: 'My AWS key is AKIAIOSFODNN7EXAMPLE',
      }

      const specPath = writeTestFile(testDir, 'spec.yaml', spec)
      const schemaPath = writeTestFile(testDir, 'schema.yaml', BASE_SCHEMA)

      // Pass nonexistent constitution path — should fall back to hardcoded defaults
      const report = validateSpec(specPath, schemaPath, ['security'], false, path.join(testDir, 'nonexistent.yaml'))

      expect(report.constitution_checks).toHaveLength(1)
      expect(report.constitution_checks[0].section).toBe('security')
      expect(report.constitution_checks[0].result).toBe('fail')
    })

    test('validateSpec uses custom patterns from constitution file', () => {
      const constitution = {
        version: 1,
        sections: {
          custom_check: {
            description: 'Detects TODO markers',
            severity: 'warn',
            patterns: [
              { regex: 'TODO', description: 'TODO found in spec' },
            ],
          },
        },
      }
      const constitutionPath = writeTestFile(testDir, 'constitution.yaml', constitution, true)

      const spec = {
        title: 'Test Feature',
        acceptance: [{ type: 'contract', criterion: 'Test' }],
        scope: { files: ['src/test.ts'] },
        notes: 'TODO: finish this later',
      }

      const specPath = writeTestFile(testDir, 'spec.yaml', spec)
      const schemaPath = writeTestFile(testDir, 'schema.yaml', BASE_SCHEMA)

      const report = validateSpec(specPath, schemaPath, ['custom_check'], false, constitutionPath)

      expect(report.constitution_checks).toHaveLength(1)
      expect(report.constitution_checks[0].section).toBe('custom_check')
      expect(report.constitution_checks[0].result).toBe('fail')
      expect(report.constitution_checks[0].findings.length).toBeGreaterThan(0)
    })

    test('validateSpec with constitution file special: acceptance_typing', () => {
      const constitution = {
        version: 1,
        sections: {
          my_quality: {
            description: 'Quality via constitution',
            severity: 'warn',
            special: 'acceptance_typing',
          },
        },
      }
      const constitutionPath = writeTestFile(testDir, 'constitution.yaml', constitution, true)

      const spec = {
        title: 'Test Feature',
        acceptance: [
          { criterion: 'No type field here' },
        ],
        scope: { files: ['src/test.ts'] },
      }

      const specPath = writeTestFile(testDir, 'spec.yaml', spec)
      const schemaPath = writeTestFile(testDir, 'schema.yaml', BASE_SCHEMA)

      const report = validateSpec(specPath, schemaPath, ['my_quality'], false, constitutionPath)

      expect(report.constitution_checks).toHaveLength(1)
      expect(report.constitution_checks[0].section).toBe('my_quality')
      expect(report.constitution_checks[0].result).toBe('fail')
      expect(report.constitution_checks[0].findings).toContain('acceptance[0]: missing type field')
    })
  })

  // ─── Schema version mismatch ──────────────────────────────────────────────

  describe('Schema version mismatch', () => {
    test('TEST-41: Schema version mismatch between spec and schema', () => {
      const spec = {
        schema_version: 'feature_spec_v2.0',
        title: 'Test Feature',
        acceptance: [{ type: 'contract', criterion: 'Test' }],
        scope: { files: ['src/test.ts'] },
      }

      const specPath = writeTestFile(testDir, 'spec.yaml', spec)
      const schemaPath = writeTestFile(testDir, 'schema.yaml', BASE_SCHEMA)

      const report = validateSpec(specPath, schemaPath, [], false)

      expect(report.valid).toBe(false)
      expect(report.errors.length).toBeGreaterThan(0)
      const versionError = report.errors.find(e => e.type === 'schema_version_mismatch')
      expect(versionError).toBeDefined()
      expect(versionError?.field).toBe('schema_version')
    })
  })
})
