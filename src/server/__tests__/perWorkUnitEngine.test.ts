import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  parseManifest,
  detectWorkUnitCycle,
  topologicalSort,
  selectSpecialist,
  expandPerWorkUnit,
  type WorkUnit,

  type ExpansionContext,
} from '../perWorkUnitEngine'
import type { WorkflowStep } from '../../shared/types'

// ── Test Fixtures ─────────────────────────────────────────────────────────────

const TEMP_DIR = '/tmp/agentboard-pwu-test-' + Date.now()

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

// ── Manifest Parsing Tests ────────────────────────────────────────────────────

describe('parseManifest', () => {
  beforeEach(setupTempDir)
  afterEach(cleanupTempDir)

  test('parses valid manifest with work_units', () => {
    const manifestPath = writeManifest('valid.yaml', `
version: "1.0"
work_units:
  - id: auth-module
    scope: Authentication module
    files:
      - src/auth/login.ts
      - src/auth/logout.ts
    tags:
      - rust
      - security
    estimated_complexity: medium
  - id: user-module
    scope: User management
    files:
      - src/users/service.ts
`)

    const result = parseManifest(manifestPath, TEMP_DIR)

    expect(result).not.toBeNull()
    expect(result!.version).toBe('1.0')
    expect(result!.work_units.length).toBe(2)
    expect(result!.work_units[0].id).toBe('auth-module')
    expect(result!.work_units[0].scope).toBe('Authentication module')
    expect(result!.work_units[0].files.length).toBe(2)
    expect(result!.work_units[0].tags).toEqual(['rust', 'security'])
    expect(result!.work_units[1].id).toBe('user-module')
  })

  test('parses manifest with depends_on', () => {
    const manifestPath = writeManifest('deps.yaml', `
version: "1.0"
work_units:
  - id: core
    scope: Core module
    files: [src/core.ts]
  - id: api
    scope: API layer
    files: [src/api.ts]
    depends_on:
      - core
  - id: ui
    scope: UI layer
    files: [src/ui.ts]
    depends_on:
      - api
`)

    const result = parseManifest(manifestPath, TEMP_DIR)

    expect(result).not.toBeNull()
    expect(result!.work_units[1].depends_on).toEqual(['core'])
    expect(result!.work_units[2].depends_on).toEqual(['api'])
  })

  test('returns null for malformed YAML', () => {
    const manifestPath = writeManifest('invalid.yaml', `
this is not valid yaml: [
`)

    const result = parseManifest(manifestPath, TEMP_DIR)
    expect(result).toBeNull()
  })

  test('returns null for empty manifest', () => {
    const manifestPath = writeManifest('empty.yaml', '')

    const result = parseManifest(manifestPath, TEMP_DIR)
    expect(result).toBeNull()
  })

  test('returns null for manifest without work_units', () => {
    const manifestPath = writeManifest('no-units.yaml', `
version: "1.0"
other_field: value
`)

    const result = parseManifest(manifestPath, TEMP_DIR)
    expect(result).toBeNull()
  })

  test('returns null for non-existent file', () => {
    const result = parseManifest('/nonexistent/path/manifest.yaml', TEMP_DIR)
    expect(result).toBeNull()
  })

  test('handles path traversal attempts', () => {
    // Attempt to read outside base directory
    const result = parseManifest('../../../etc/passwd', TEMP_DIR)
    expect(result).toBeNull()
  })

  test('supports alternative "units" key', () => {
    const manifestPath = writeManifest('units-key.yaml', `
version: "1.0"
units:
  - id: test-unit
    scope: Test scope
    files: [test.ts]
`)

    const result = parseManifest(manifestPath, TEMP_DIR)
    expect(result).not.toBeNull()
    expect(result!.work_units.length).toBe(1)
    expect(result!.work_units[0].id).toBe('test-unit')
  })
})

// ── Cycle Detection Tests ─────────────────────────────────────────────────────

describe('detectWorkUnitCycle', () => {
  test('returns null for acyclic graph', () => {
    const units: WorkUnit[] = [
      makeWorkUnit({ id: 'a', depends_on: [] }),
      makeWorkUnit({ id: 'b', depends_on: ['a'] }),
      makeWorkUnit({ id: 'c', depends_on: ['b'] }),
    ]

    const cycle = detectWorkUnitCycle(units)
    expect(cycle).toBeNull()
  })

  test('returns null for empty graph', () => {
    const cycle = detectWorkUnitCycle([])
    expect(cycle).toBeNull()
  })

  test('returns null for single unit', () => {
    const units: WorkUnit[] = [makeWorkUnit({ id: 'a' })]
    const cycle = detectWorkUnitCycle(units)
    expect(cycle).toBeNull()
  })

  test('detects simple cycle', () => {
    const units: WorkUnit[] = [
      makeWorkUnit({ id: 'a', depends_on: ['b'] }),
      makeWorkUnit({ id: 'b', depends_on: ['a'] }),
    ]

    const cycle = detectWorkUnitCycle(units)
    expect(cycle).not.toBeNull()
    expect(cycle!.length).toBe(2)
    expect(cycle).toContain('a')
    expect(cycle).toContain('b')
  })

  test('detects longer cycle', () => {
    const units: WorkUnit[] = [
      makeWorkUnit({ id: 'a', depends_on: ['c'] }),
      makeWorkUnit({ id: 'b', depends_on: ['a'] }),
      makeWorkUnit({ id: 'c', depends_on: ['b'] }),
    ]

    const cycle = detectWorkUnitCycle(units)
    expect(cycle).not.toBeNull()
    expect(cycle!.length).toBe(3)
  })

  test('handles unknown dependencies gracefully', () => {
    const units: WorkUnit[] = [
      makeWorkUnit({ id: 'a', depends_on: ['nonexistent'] }),
    ]

    // Unknown deps are ignored, no cycle
    const cycle = detectWorkUnitCycle(units)
    expect(cycle).toBeNull()
  })
})

// ── Topological Sort Tests ────────────────────────────────────────────────────

describe('topologicalSort', () => {
  test('preserves order for independent units', () => {
    const units: WorkUnit[] = [
      makeWorkUnit({ id: 'first' }),
      makeWorkUnit({ id: 'second' }),
      makeWorkUnit({ id: 'third' }),
    ]

    const sorted = topologicalSort(units)
    expect(sorted.map(u => u.id)).toEqual(['first', 'second', 'third'])
  })

  test('respects single dependency', () => {
    const units: WorkUnit[] = [
      makeWorkUnit({ id: 'b', depends_on: ['a'] }),
      makeWorkUnit({ id: 'a' }),
    ]

    const sorted = topologicalSort(units)
    const ids = sorted.map(u => u.id)
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'))
  })

  test('respects chain of dependencies', () => {
    const units: WorkUnit[] = [
      makeWorkUnit({ id: 'c', depends_on: ['b'] }),
      makeWorkUnit({ id: 'a' }),
      makeWorkUnit({ id: 'b', depends_on: ['a'] }),
    ]

    const sorted = topologicalSort(units)
    const ids = sorted.map(u => u.id)
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'))
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'))
  })

  test('handles diamond dependency', () => {
    //     a
    //    / \
    //   b   c
    //    \ /
    //     d
    const units: WorkUnit[] = [
      makeWorkUnit({ id: 'd', depends_on: ['b', 'c'] }),
      makeWorkUnit({ id: 'b', depends_on: ['a'] }),
      makeWorkUnit({ id: 'c', depends_on: ['a'] }),
      makeWorkUnit({ id: 'a' }),
    ]

    const sorted = topologicalSort(units)
    const ids = sorted.map(u => u.id)

    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'))
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('c'))
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('d'))
    expect(ids.indexOf('c')).toBeLessThan(ids.indexOf('d'))
  })

  test('handles empty array', () => {
    const sorted = topologicalSort([])
    expect(sorted).toEqual([])
  })
})

// ── Specialist Selection Tests ────────────────────────────────────────────────

describe('selectSpecialist', () => {
  test('returns default agent when specialist selection disabled', () => {
    const wu = makeWorkUnit({ tags: ['rust', 'security'] })
    const result = selectSpecialist(wu, 'workhorse', { enabled: false })
    expect(result).toBe('workhorse')
  })

  test('returns default agent when no tags', () => {
    const wu = makeWorkUnit({ tags: undefined })
    const result = selectSpecialist(wu, 'workhorse', { enabled: true })
    expect(result).toBe('workhorse')
  })

  test('returns default agent when empty tags', () => {
    const wu = makeWorkUnit({ tags: [] })
    const result = selectSpecialist(wu, 'workhorse', { enabled: true })
    expect(result).toBe('workhorse')
  })

  test('selects specialist based on first tag', () => {
    const wu = makeWorkUnit({ tags: ['rust', 'security'] })
    const result = selectSpecialist(wu, 'workhorse', { enabled: true })
    expect(result).toBe('workhorse-rust')
  })

  test('selects specialist without config', () => {
    const wu = makeWorkUnit({ tags: ['frontend'] })
    const result = selectSpecialist(wu, 'workhorse', undefined)
    expect(result).toBe('workhorse')
  })
})

// ── Expansion Tests ────────────────────────────────────────────────────────────

describe('expandPerWorkUnit', () => {
  beforeEach(setupTempDir)
  afterEach(cleanupTempDir)

  function makeExpansionCtx(): ExpansionContext {
    return {
      runId: 'test-run-123',
      outputDir: TEMP_DIR,
      defaultAgent: 'workhorse',
      variables: null,
    }
  }

  test('returns empty array when no per_work_unit config', () => {
    const step: WorkflowStep = {
      name: 'test-step',
      type: 'spawn_session',
      prompt: 'test',
      projectPath: '/tmp/test',
    }

    const result = expandPerWorkUnit(step, makeExpansionCtx())
    expect(result).toEqual([])
  })

  test('returns empty array when manifest not found', () => {
    const step: WorkflowStep = {
      name: 'test-step',
      type: 'spawn_session',
      prompt: 'test',
      projectPath: '/tmp/test',
      per_work_unit: {
        manifest_path: 'nonexistent.yaml',
      },
    }

    const result = expandPerWorkUnit(step, makeExpansionCtx())
    expect(result).toEqual([])
  })

  test('expands sequential mode in manifest order', () => {
    writeManifest('test.yaml', `
version: "1.0"
work_units:
  - id: unit-b
    scope: Unit B
    files: [b.ts]
  - id: unit-a
    scope: Unit A
    files: [a.ts]
  - id: unit-c
    scope: Unit C
    files: [c.ts]
`)

    const step: WorkflowStep = {
      name: 'test-step',
      type: 'spawn_session',
      prompt: 'Process {{ work_unit.id }}: {{ work_unit.scope }}',
      projectPath: '/tmp/test',
      per_work_unit: {
        manifest_path: 'test.yaml',
        execution_mode: 'sequential',
      },
    }

    const result = expandPerWorkUnit(step, makeExpansionCtx())

    expect(result.length).toBe(3)
    expect(result[0].workUnitId).toBe('unit-b')
    expect(result[1].workUnitId).toBe('unit-a')
    expect(result[2].workUnitId).toBe('unit-c')
    expect(result[0].dependsOnExpanded).toBeUndefined()
  })

  test('expands parallel mode with topological sort', () => {
    writeManifest('parallel.yaml', `
version: "1.0"
work_units:
  - id: core
    scope: Core
    files: [core.ts]
  - id: api
    scope: API
    files: [api.ts]
    depends_on:
      - core
  - id: ui
    scope: UI
    files: [ui.ts]
    depends_on:
      - api
`)

    const step: WorkflowStep = {
      name: 'test-step',
      type: 'spawn_session',
      prompt: 'Process {{ work_unit.id }}',
      projectPath: '/tmp/test',
      per_work_unit: {
        manifest_path: 'parallel.yaml',
        execution_mode: 'parallel',
      },
    }

    const result = expandPerWorkUnit(step, makeExpansionCtx())

    expect(result.length).toBe(3)

    // Check order respects dependencies
    const names = result.map(r => r.workUnitId)
    expect(names.indexOf('core')).toBeLessThan(names.indexOf('api'))
    expect(names.indexOf('api')).toBeLessThan(names.indexOf('ui'))

    // Check depends_on resolved to step names
    const uiStep = result.find(r => r.workUnitId === 'ui')
    expect(uiStep?.dependsOnExpanded).toContain('test-step.api')
  })

  test('throws on cycle detection in parallel mode', () => {
    writeManifest('cycle.yaml', `
version: "1.0"
work_units:
  - id: a
    scope: A
    files: [a.ts]
    depends_on:
      - b
  - id: b
    scope: B
    files: [b.ts]
    depends_on:
      - a
`)

    const step: WorkflowStep = {
      name: 'test-step',
      type: 'spawn_session',
      prompt: 'Process {{ work_unit.id }}',
      projectPath: '/tmp/test',
      per_work_unit: {
        manifest_path: 'cycle.yaml',
        execution_mode: 'parallel',
      },
    }

    expect(() => expandPerWorkUnit(step, makeExpansionCtx())).toThrow(/Circular dependency/)
  })

  test('substitutes work unit context in prompt', () => {
    writeManifest('context.yaml', `
version: "1.0"
work_units:
  - id: my-unit
    scope: My Scope
    files:
      - file1.ts
      - file2.ts
    tags:
      - rust
    estimated_complexity: high
`)

    const step: WorkflowStep = {
      name: 'test-step',
      type: 'spawn_session',
      prompt: 'Unit: {{ work_unit.id }}, Scope: {{ work_unit.scope }}, Files: {{ work_unit.files }}',
      projectPath: '/tmp/test',
      per_work_unit: {
        manifest_path: 'context.yaml',
      },
    }

    const result = expandPerWorkUnit(step, makeExpansionCtx())

    expect(result.length).toBe(1)
    expect(result[0].step.prompt).toContain('Unit: my-unit')
    expect(result[0].step.prompt).toContain('Scope: My Scope')
    expect(result[0].step.prompt).toContain('file1.ts')
    expect(result[0].step.prompt).toContain('file2.ts')
  })

  test('applies specialist selection', () => {
    writeManifest('specialist.yaml', `
version: "1.0"
work_units:
  - id: rust-unit
    scope: Rust code
    files: [rust.rs]
    tags:
      - rust
  - id: frontend-unit
    scope: Frontend code
    files: [ui.tsx]
    tags:
      - frontend
`)

    const step: WorkflowStep = {
      name: 'test-step',
      type: 'spawn_session',
      prompt: 'Process',
      projectPath: '/tmp/test',
      agent: 'workhorse',
      per_work_unit: {
        manifest_path: 'specialist.yaml',
        specialist_selection: {
          enabled: true,
        },
      },
    }

    const result = expandPerWorkUnit(step, makeExpansionCtx())

    expect(result.length).toBe(2)
    expect(result[0].step.agent).toBe('workhorse-rust')
    expect(result[1].step.agent).toBe('workhorse-frontend')
  })

  test('generates unique step names', () => {
    writeManifest('names.yaml', `
version: "1.0"
work_units:
  - id: unit-a
    scope: A
    files: [a.ts]
  - id: unit-b
    scope: B
    files: [b.ts]
`)

    const step: WorkflowStep = {
      name: 'my-step',
      type: 'spawn_session',
      prompt: 'Process',
      projectPath: '/tmp/test',
      per_work_unit: {
        manifest_path: 'names.yaml',
      },
    }

    const result = expandPerWorkUnit(step, makeExpansionCtx())

    expect(result[0].name).toBe('my-step.unit-a')
    expect(result[1].name).toBe('my-step.unit-b')
  })

  test('sanitizes work unit IDs in step names', () => {
    writeManifest('sanitize.yaml', `
version: "1.0"
work_units:
  - id: "unit/with/slashes"
    scope: Slash unit
    files: [a.ts]
  - id: "unit with spaces"
    scope: Space unit
    files: [b.ts]
`)

    const step: WorkflowStep = {
      name: 'test-step',
      type: 'spawn_session',
      prompt: 'Process',
      projectPath: '/tmp/test',
      per_work_unit: {
        manifest_path: 'sanitize.yaml',
      },
    }

    const result = expandPerWorkUnit(step, makeExpansionCtx())

    expect(result[0].name).toBe('test-step.unit_with_slashes')
    expect(result[1].name).toBe('test-step.unit_with_spaces')
  })
})
