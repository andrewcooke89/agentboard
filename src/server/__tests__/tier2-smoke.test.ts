/**
 * tier2-smoke.test.ts — End-to-end Tier 2 smoke test for change-pipeline (Phase 9)
 *
 * Tests REQ-31, REQ-32, REQ-33, REQ-72, REQ-73, REQ-74
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { validateSpec } from '../specValidator'
import { loadProjectProfile } from '../projectProfile'

describe('Tier 2 Change-Pipeline Smoke Test', () => {
  let testProjectDir: string
  let workflowDir: string
  let specsDir: string
  let outputDir: string

  beforeAll(() => {
    // Create test project structure
    testProjectDir = path.join(tmpdir(), `smoke-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    workflowDir = path.join(testProjectDir, '.workflow')
    specsDir = path.join(workflowDir, 'specs', 'feature', 'FEAT-SMOKE')
    outputDir = path.join(testProjectDir, 'output')

    // Create directory structure
    mkdirSync(path.join(workflowDir, 'pipelines'), { recursive: true })
    mkdirSync(path.join(workflowDir, 'schemas'), { recursive: true })
    mkdirSync(path.join(workflowDir, 'constitution'), { recursive: true })
    mkdirSync(specsDir, { recursive: true })
    mkdirSync(outputDir, { recursive: true })

    // Create project_profile.yaml (REQ-19, REQ-38)
    const projectProfile = {
      language: 'typescript',
      framework: 'bun',
      test_framework: 'bun-test',
      source_layout: {
        handlers: 'src/handlers/',
        models: 'src/models/',
        tests: 'tests/',
      },
      conventions: {
        error_handling: 'Result<T, Error>',
        async_runtime: 'bun',
      },
      maturity: 'active',
      machine_capacity: {
        session_pool_size: 2,
      },
    }
    writeFileSync(
      path.join(workflowDir, 'project_profile.yaml'),
      yaml.dump(projectProfile),
    )

    // Create feature_spec_v1.yaml schema
    const schema = {
      version: 'feature_spec_v1.0',
      required_fields: {
        title: { type: 'string' },
        acceptance: { type: 'array' },
        scope: { type: 'object' },
      },
      optional_fields: {
        description: { type: 'string' },
        schema_version: { type: 'string' },
        constraints: { type: 'object' },
      },
      valid_acceptance_types: ['contract', 'property', 'benchmark', 'invariant', 'behavioral'],
    }
    writeFileSync(
      path.join(workflowDir, 'schemas', 'feature_spec_v1.yaml'),
      yaml.dump(schema),
    )

    // Create sample feature spec (medium complexity, well-understood)
    // REQ-72: Real feature the developer cares about
    const featureSpec = {
      schema_version: 'feature_spec_v1.0',
      title: 'Add User Authentication Middleware',
      description: 'Implement JWT-based authentication middleware for API endpoints',
      acceptance: [
        {
          type: 'contract',
          criterion: 'Middleware extracts JWT token from Authorization header',
        },
        {
          type: 'contract',
          criterion: 'Valid tokens allow request to proceed with user context attached',
        },
        {
          type: 'contract',
          criterion: 'Invalid tokens return 401 with error code AUTH_001',
        },
        {
          type: 'contract',
          criterion: 'Missing tokens return 401 with error code AUTH_002',
        },
        {
          type: 'property',
          criterion: 'Token validation completes in < 50ms',
        },
      ],
      scope: {
        files: [
          'src/middleware/auth.ts',
          'src/middleware/index.ts',
        ],
      },
      constraints: {
        security: 'Use established JWT library, do not implement crypto manually',
        performance: 'Token validation must not block other requests',
      },
    }
    writeFileSync(
      path.join(specsDir, 'spec.yaml'),
      yaml.dump(featureSpec),
    )

    // Copy change-pipeline.yaml to test project
    const realPipelinePath = path.resolve(__dirname, '../../../.workflow/pipelines/change-pipeline.yaml')
    const pipelineContent = readFileSync(realPipelinePath, 'utf-8')
    writeFileSync(
      path.join(workflowDir, 'pipelines', 'change-pipeline.yaml'),
      pipelineContent,
    )

    // Create minimal constitution files
    const securityConstitution = `
# Security Constitution

## Rules
- No literal secrets in code
- Validate all user inputs
- Use parameterized queries
`
    writeFileSync(
      path.join(workflowDir, 'constitution', 'security.md'),
      securityConstitution,
    )

    const architectureConstitution = `
# Architecture Constitution

## Rules
- Scope must list specific files, not wildcards
- Respect module boundaries
- Follow dependency rules
`
    writeFileSync(
      path.join(workflowDir, 'constitution', 'architecture.md'),
      architectureConstitution,
    )
  })

  afterAll(() => {
    if (existsSync(testProjectDir)) {
      rmSync(testProjectDir, { recursive: true, force: true })
    }
  })

  test('EXEC-01: Test project structure is valid', () => {
    // Verify all required files exist
    expect(existsSync(path.join(workflowDir, 'project_profile.yaml'))).toBe(true)
    expect(existsSync(path.join(workflowDir, 'schemas', 'feature_spec_v1.yaml'))).toBe(true)
    expect(existsSync(path.join(workflowDir, 'pipelines', 'change-pipeline.yaml'))).toBe(true)
    expect(existsSync(path.join(workflowDir, 'constitution', 'security.md'))).toBe(true)
    expect(existsSync(path.join(workflowDir, 'constitution', 'architecture.md'))).toBe(true)
    expect(existsSync(path.join(specsDir, 'spec.yaml'))).toBe(true)
  })

  test('EXEC-02: Feature spec is well-formed YAML', () => {
    const specContent = readFileSync(path.join(specsDir, 'spec.yaml'), 'utf-8')
    const spec = yaml.load(specContent) as any

    expect(spec.title).toBeDefined()
    expect(spec.acceptance).toBeDefined()
    expect(Array.isArray(spec.acceptance)).toBe(true)
    expect(spec.scope).toBeDefined()
    expect(spec.scope.files).toBeDefined()

    // All acceptance criteria have type field (R6)
    for (const criterion of spec.acceptance) {
      expect(criterion.type).toBeDefined()
      expect(['contract', 'property', 'benchmark', 'invariant', 'behavioral']).toContain(criterion.type)
    }
  })

  test('EXEC-04: spec_validate can process the sample spec', () => {
    // This tests that spec_validate execution works
    const specPath = path.join(specsDir, 'spec.yaml')
    const schemaPath = path.join(workflowDir, 'schemas', 'feature_spec_v1.yaml')

    const report = validateSpec(specPath, schemaPath, ['security', 'architecture'], false)

    // REQ-32: Validation should pass for our well-formed spec
    expect(report.valid).toBe(true)
    expect(report.errors).toHaveLength(0)

    // Verify report structure (REQ-10)
    expect(report.spec_path).toBe(specPath)
    expect(report.constitution_checks).toHaveLength(2) // security + architecture
  })

  test('EXEC-07: project_profile.yaml variables are loadable', () => {
    const profileVars = loadProjectProfile(testProjectDir)

    // Verify variables are available for interpolation
    expect(profileVars['language']).toBe('typescript')
    expect(profileVars['framework']).toBe('bun')
    expect(profileVars['source_layout.handlers']).toBe('src/handlers/')
    expect(profileVars['source_layout.models']).toBe('src/models/')
    expect(profileVars['conventions.error_handling']).toBe('Result<T, Error>')
  })

  test('TEST-32: Pipeline stages are correctly ordered', () => {
    const pipelineContent = readFileSync(
      path.join(workflowDir, 'pipelines', 'change-pipeline.yaml'),
      'utf-8',
    )
    const pipeline = yaml.load(pipelineContent) as any

    const stepNames = pipeline.steps.map((s: any) => s.name)

    // Verify stage order (REQ-32)
    const validateIndex = stepNames.indexOf('validate-spec')
    const reviewIndex = stepNames.indexOf('spec-review-loop')
    const decomposeIndex = stepNames.indexOf('decompose')
    const generationIndex = stepNames.indexOf('generation')
    const implementIndex = stepNames.indexOf('implement')
    const conformanceIndex = stepNames.indexOf('conformance')

    expect(validateIndex).toBeLessThan(reviewIndex)
    expect(reviewIndex).toBeLessThan(decomposeIndex)
    expect(decomposeIndex).toBeLessThan(generationIndex)
    expect(generationIndex).toBeLessThan(implementIndex)
    expect(implementIndex).toBeLessThan(conformanceIndex)
  })

  test('TEST-33: Smoke test success criteria documented', () => {
    // REQ-72: One real feature developer cares about
    // REQ-73: Pipeline completes < 60 minutes (tested in full E2E, not unit test)
    // REQ-74: All artifacts produced (tested in full E2E execution)

    // For unit test, just verify the setup is correct
    const spec = yaml.load(readFileSync(path.join(specsDir, 'spec.yaml'), 'utf-8')) as any

    // Feature is real and has clear success criteria
    expect(spec.title).toContain('Authentication')
    expect(spec.acceptance.length).toBeGreaterThanOrEqual(3)

    // Medium complexity (5 acceptance criteria, 2 files)
    expect(spec.acceptance.length).toBeLessThan(10)
    expect(spec.scope.files.length).toBeLessThan(5)
  })

  // Note: Full E2E execution test (running actual pipeline through DAG engine)
  // would require spinning up the full agentboard server, session management, etc.
  // That's beyond scope of unit tests. These tests verify the smoke test SETUP
  // is correct. Actual execution would be manual (EXEC-13).
})
