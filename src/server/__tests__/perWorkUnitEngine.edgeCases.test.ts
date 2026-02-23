/**
 * perWorkUnitEngine.edgeCases.test.ts - Edge case tests for per-work-unit engine
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  parseManifest,
  detectWorkUnitCycle,
  topologicalSort,
  selectSpecialist,
  expandPerWorkUnit,
  generateSubsteps,
  type WorkUnit,

  type ExpansionContext,
} from '../perWorkUnitEngine'
import type { WorkflowStep } from '../../shared/types'

const TEMP_DIR = '/tmp/agentboard-pwu-edge-test-' + Date.now()

function setupTempDir(): void {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true })
  }
}

function cleanupTempDir(): void {
  try {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true })
  } catch { /* ignore */ }
}

function writeManifest(filename: string, content: string): string {
  const fullPath = path.join(TEMP_DIR, filename)
  fs.writeFileSync(fullPath, content, 'utf-8')
  return fullPath
}

function makeWorkUnit(overrides: Partial<WorkUnit>): WorkUnit {
  return {
    id: 'test-unit',
    scope: 'test scope',
    files: [],
    ...overrides,
  }
}

function makeExpansionCtx(): ExpansionContext {
  return {
    runId: 'test-run-123',
    outputDir: TEMP_DIR,
    defaultAgent: 'workhorse',
    variables: null,
  }
}

describe('perWorkUnitEngine - edge cases', () => {
  beforeEach(setupTempDir)
  afterEach(cleanupTempDir)

  describe('large manifests', () => {
    test('handles 100+ work units', () => {
      // Generate a manifest with 150 work units
      const units = Array.from({ length: 150 }, (_, i) => `
  - id: unit-${i}
    scope: Unit ${i}
    files:
      - src/unit-${i}.ts
`).join('')

      writeManifest('large.yaml', `
version: "1.0"
work_units:
${units}
`)

      const result = parseManifest('large.yaml', TEMP_DIR)

      expect(result).not.toBeNull()
      expect(result!.work_units.length).toBe(150)
    })

    test('handles 100+ work units with dependencies', () => {
      // Generate chain of dependencies: unit-0 -> unit-1 -> unit-2 -> ...
      const units = Array.from({ length: 100 }, (_, i) => {
        const deps = i > 0 ? `\n    depends_on:\n      - unit-${i - 1}` : ''
        return `  - id: unit-${i}\n    scope: Unit ${i}\n    files:\n      - src/unit-${i}.ts${deps}`
      }).join('\n')

      writeManifest('large-chain.yaml', `
version: "1.0"
work_units:
${units}
`)

      const result = parseManifest('large-chain.yaml', TEMP_DIR)

      expect(result).not.toBeNull()
      expect(result!.work_units.length).toBe(100)

      // Verify dependencies are parsed
      expect(result!.work_units[50].depends_on).toEqual(['unit-49'])
    })

    test('handles work units with many files', () => {
      const files = Array.from({ length: 100 }, (_, i) => `      - src/file-${i}.ts`).join('\n')

      writeManifest('many-files.yaml', `
version: "1.0"
work_units:
  - id: unit-many-files
    scope: Unit with many files
    files:
${files}
`)

      const result = parseManifest('many-files.yaml', TEMP_DIR)

      expect(result).not.toBeNull()
      expect(result!.work_units[0].files.length).toBe(100)
    })

    test('topological sort handles 100+ units efficiently', () => {
      const units: WorkUnit[] = Array.from({ length: 100 }, (_, i) => ({
        id: `unit-${i}`,
        scope: `Unit ${i}`,
        files: [`src/unit-${i}.ts`],
        depends_on: i > 0 ? [`unit-${i - 1}`] : undefined,
      }))

      const startTime = Date.now()
      const sorted = topologicalSort(units)
      const elapsed = Date.now() - startTime

      expect(sorted.length).toBe(100)
      // Should complete quickly (< 100ms for 100 units)
      expect(elapsed).toBeLessThan(100)
    })
  })

  describe('malformed manifest handling', () => {
    test('handles completely empty file', () => {
      writeManifest('empty-file.yaml', '')

      const result = parseManifest('empty-file.yaml', TEMP_DIR)
      expect(result).toBeNull()
    })

    test('handles file with only whitespace', () => {
      writeManifest('whitespace.yaml', '   \n\n   \n')

      const result = parseManifest('whitespace.yaml', TEMP_DIR)
      expect(result).toBeNull()
    })

    test('handles manifest with only version', () => {
      writeManifest('version-only.yaml', 'version: "1.0"')

      const result = parseManifest('version-only.yaml', TEMP_DIR)
      expect(result).toBeNull()
    })

    test('handles work_unit with missing id', () => {
      writeManifest('no-id.yaml', `
version: "1.0"
work_units:
  - scope: Unit without id
    files:
      - src/test.ts
`)

      const result = parseManifest('no-id.yaml', TEMP_DIR)

      // Should skip units without id
      expect(result).not.toBeNull()
      expect(result!.work_units.length).toBe(0)
    })

    test('handles work_unit with missing scope', () => {
      writeManifest('no-scope.yaml', `
version: "1.0"
work_units:
  - id: unit-no-scope
    files:
      - src/test.ts
`)

      const result = parseManifest('no-scope.yaml', TEMP_DIR)

      // Should skip units without scope
      expect(result).not.toBeNull()
      expect(result!.work_units.length).toBe(0)
    })

    test('handles work_unit with empty files array', () => {
      writeManifest('empty-files.yaml', `
version: "1.0"
work_units:
  - id: unit-empty
    scope: Unit with empty files
    files: []
`)

      const result = parseManifest('empty-files.yaml', TEMP_DIR)

      expect(result).not.toBeNull()
      expect(result!.work_units.length).toBe(1)
      expect(result!.work_units[0].files).toEqual([])
    })

    test('handles work_unit with non-array files', () => {
      writeManifest('bad-files.yaml', `
version: "1.0"
work_units:
  - id: unit-bad
    scope: Unit with bad files
    files: "not-an-array"
`)

      const result = parseManifest('bad-files.yaml', TEMP_DIR)

      expect(result).not.toBeNull()
      expect(result!.work_units[0].files).toEqual([])
    })

    test('handles duplicate work unit ids', () => {
      writeManifest('duplicate-ids.yaml', `
version: "1.0"
work_units:
  - id: duplicate
    scope: First duplicate
    files: [a.ts]
  - id: duplicate
    scope: Second duplicate
    files: [b.ts]
`)

      const result = parseManifest('duplicate-ids.yaml', TEMP_DIR)

      // Should parse both (deduplication not handled at parse level)
      expect(result).not.toBeNull()
      expect(result!.work_units.length).toBe(2)
    })

    test('handles invalid YAML syntax', () => {
      writeManifest('invalid-yaml.yaml', `
version: "1.0"
work_units:
  - id: valid
    scope: Valid unit
  - invalid yaml here: [
    broken
`)

      const result = parseManifest('invalid-yaml.yaml', TEMP_DIR)
      expect(result).toBeNull()
    })

    test('handles JSON instead of YAML', () => {
      writeManifest('json.json', JSON.stringify({
        version: '1.0',
        work_units: [
          { id: 'json-unit', scope: 'JSON unit', files: ['test.ts'] },
        ],
      }))

      const result = parseManifest('json.json', TEMP_DIR)

      // YAML parser can usually handle JSON
      expect(result).not.toBeNull()
    })
  })

  describe('cycle detection with complex graphs', () => {
    test('detects cycle in complex dependency graph', () => {
      // Create a complex graph with a hidden cycle
      // a -> b -> c -> d -> e -> c (cycle)
      const units: WorkUnit[] = [
        makeWorkUnit({ id: 'a', depends_on: [] }),
        makeWorkUnit({ id: 'b', depends_on: ['a'] }),
        makeWorkUnit({ id: 'c', depends_on: ['b'] }),
        makeWorkUnit({ id: 'd', depends_on: ['c'] }),
        makeWorkUnit({ id: 'e', depends_on: ['d'] }),
        makeWorkUnit({ id: 'c-extra', depends_on: ['e', 'c'] }), // Creates cycle
      ]

      // Update c to also depend on c-extra to create the cycle
      units[2].depends_on = ['b', 'c-extra']

      const cycle = detectWorkUnitCycle(units)
      expect(cycle).not.toBeNull()
    })

    test('handles self-referential dependency', () => {
      const units: WorkUnit[] = [
        makeWorkUnit({ id: 'self', depends_on: ['self'] }),
      ]

      const cycle = detectWorkUnitCycle(units)
      expect(cycle).not.toBeNull()
    })

    test('handles diamond dependency without cycle', () => {
      //     a
      //    / \
      //   b   c
      //    \ /
      //     d
      const units: WorkUnit[] = [
        makeWorkUnit({ id: 'a', depends_on: [] }),
        makeWorkUnit({ id: 'b', depends_on: ['a'] }),
        makeWorkUnit({ id: 'c', depends_on: ['a'] }),
        makeWorkUnit({ id: 'd', depends_on: ['b', 'c'] }),
      ]

      const cycle = detectWorkUnitCycle(units)
      expect(cycle).toBeNull()
    })

    test('handles multiple disconnected components', () => {
      // Component 1: a -> b
      // Component 2: c -> d -> e
      // Component 3: f (isolated)
      const units: WorkUnit[] = [
        makeWorkUnit({ id: 'a' }),
        makeWorkUnit({ id: 'b', depends_on: ['a'] }),
        makeWorkUnit({ id: 'c' }),
        makeWorkUnit({ id: 'd', depends_on: ['c'] }),
        makeWorkUnit({ id: 'e', depends_on: ['d'] }),
        makeWorkUnit({ id: 'f' }),
      ]

      const cycle = detectWorkUnitCycle(units)
      expect(cycle).toBeNull()
    })

    test('detects cycle in one component of disconnected graph', () => {
      // Component 1: a -> b (no cycle)
      // Component 2: c -> d -> c (cycle!)
      const units: WorkUnit[] = [
        makeWorkUnit({ id: 'a' }),
        makeWorkUnit({ id: 'b', depends_on: ['a'] }),
        makeWorkUnit({ id: 'c', depends_on: ['d'] }),
        makeWorkUnit({ id: 'd', depends_on: ['c'] }),
      ]

      const cycle = detectWorkUnitCycle(units)
      expect(cycle).not.toBeNull()
    })
  })

  describe('missing dependency handling', () => {
    test('topological sort ignores missing dependencies', () => {
      const units: WorkUnit[] = [
        makeWorkUnit({ id: 'a', depends_on: ['nonexistent'] }),
        makeWorkUnit({ id: 'b', depends_on: ['a'] }),
      ]

      // Should not throw, just ignore missing deps
      const sorted = topologicalSort(units)
      expect(sorted.length).toBe(2)
    })

    test('cycle detection ignores missing dependencies', () => {
      const units: WorkUnit[] = [
        makeWorkUnit({ id: 'a', depends_on: ['nonexistent'] }),
      ]

      const cycle = detectWorkUnitCycle(units)
      expect(cycle).toBeNull()
    })

    test('expandPerWorkUnit handles missing dependency gracefully', () => {
      writeManifest('missing-dep.yaml', `
version: "1.0"
work_units:
  - id: unit-a
    scope: Unit A
    files: [a.ts]
    depends_on:
      - nonexistent-unit
`)

      const step: WorkflowStep = {
        name: 'test-step',
        type: 'spawn_session',
        prompt: 'Process {{ work_unit.id }}',
        projectPath: '/tmp/test',
        per_work_unit: {
          manifest_path: 'missing-dep.yaml',
          execution_mode: 'parallel',
        },
      }

      // Should not throw, missing deps are ignored
      const result = expandPerWorkUnit(step, makeExpansionCtx())
      expect(result.length).toBe(1)
    })
  })

  describe('path traversal protection', () => {
    test('blocks manifest path outside base directory', () => {
      const result = parseManifest('../../../etc/passwd', TEMP_DIR)
      expect(result).toBeNull()
    })

    test('blocks absolute path outside base directory', () => {
      const result = parseManifest('/etc/passwd', TEMP_DIR)
      expect(result).toBeNull()
    })

    test('allows relative path within base directory', () => {
      fs.mkdirSync(path.join(TEMP_DIR, 'subdir'), { recursive: true })
      writeManifest('subdir/valid.yaml', `
version: "1.0"
work_units:
  - id: unit-subdir
    scope: Subdir unit
    files: [test.ts]
`)

      const result = parseManifest('subdir/valid.yaml', TEMP_DIR)
      expect(result).not.toBeNull()
    })
  })

  describe('specialist selection edge cases', () => {
    test('handles work unit with many tags', () => {
      const wu = makeWorkUnit({
        tags: ['rust', 'security', 'async', 'networking', 'crypto'],
      })

      const result = selectSpecialist(wu, 'workhorse', { enabled: true })

      // Should use first tag
      expect(result).toBe('workhorse-rust')
    })

    test('handles tags with special characters', () => {
      const wu = makeWorkUnit({
        tags: ['c++', 'node.js', 'go-lang'],
      })

      const result = selectSpecialist(wu, 'workhorse', { enabled: true })

      expect(result).toBe('workhorse-c++')
    })

    test('handles empty tag string', () => {
      const wu = makeWorkUnit({
        tags: ['', 'valid-tag'],
      })

      const result = selectSpecialist(wu, 'workhorse', { enabled: true })

      // First tag is empty string
      expect(result).toBe('workhorse-')
    })
  })

  describe('substep generation edge cases', () => {
    test('handles empty substeps array', () => {
      const substeps = generateSubsteps(
        'parent-step',
        'unit-1',
        [],
        TEMP_DIR,
        makeWorkUnit({ id: 'unit-1', scope: 'Test', files: [] })
      )

      expect(substeps).toEqual([])
    })

    test('handles substeps with missing prompts', () => {
      const substepConfig: WorkflowStep[] = [
        { name: 'no-prompt', type: 'native_step' },
      ]

      const substeps = generateSubsteps(
        'parent-step',
        'unit-1',
        substepConfig,
        TEMP_DIR,
        makeWorkUnit({ id: 'unit-1', scope: 'Test', files: [] })
      )

      expect(substeps.length).toBe(1)
      expect(substeps[0].prompt).toBeUndefined()
    })

    test('sanitizes special characters in work unit id for substeps', () => {
      const substepConfig: WorkflowStep[] = [
        { name: 'sub', type: 'spawn_session', prompt: 'test' },
      ]

      const substeps = generateSubsteps(
        'parent-step',
        'unit/with/special:chars',
        substepConfig,
        TEMP_DIR,
        makeWorkUnit({ id: 'unit/with/special:chars', scope: 'Test', files: [] })
      )

      // Special characters should be sanitized
      expect(substeps[0].name).not.toContain('/')
      expect(substeps[0].name).not.toContain(':')
    })
  })

  describe('prompt substitution edge cases', () => {
    test('handles missing work_unit placeholders gracefully', () => {
      writeManifest('substitution.yaml', `
version: "1.0"
work_units:
  - id: unit-test
    scope: Test Scope
    files: [test.ts]
`)

      const step: WorkflowStep = {
        name: 'test-step',
        type: 'spawn_session',
        prompt: 'Process: {{ work_unit.id }}, {{ work_unit.missing_field }}',
        projectPath: '/tmp/test',
        per_work_unit: {
          manifest_path: 'substitution.yaml',
        },
      }

      const result = expandPerWorkUnit(step, makeExpansionCtx())

      expect(result.length).toBe(1)
      // Missing field placeholder should remain unsubstituted
      expect(result[0].step.prompt).toContain('unit-test')
    })

    test('handles empty scope', () => {
      writeManifest('empty-scope.yaml', `
version: "1.0"
work_units:
  - id: unit-empty
    scope: ""
    files: [test.ts]
`)

      // Parser should skip units with empty scope
      const result = parseManifest('empty-scope.yaml', TEMP_DIR)
      expect(result!.work_units.length).toBe(0)
    })

    test('handles very long scope string', () => {
      const longScope = 'x'.repeat(10000)
      writeManifest('long-scope.yaml', `
version: "1.0"
work_units:
  - id: unit-long
    scope: "${longScope}"
    files: [test.ts]
`)

      const manifest = parseManifest('long-scope.yaml', TEMP_DIR)
      expect(manifest).not.toBeNull()
      expect(manifest!.work_units[0].scope.length).toBe(10000)
    })
  })
})
