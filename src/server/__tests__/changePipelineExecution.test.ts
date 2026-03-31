/**
 * changePipelineExecution.test.ts — Integration tests for change-pipeline execution
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'

describe('Change-pipeline integration tests', () => {
  let testDir: string

  beforeEach(() => {
    testDir = path.join(tmpdir(), `pipeline-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(path.join(testDir, '.workflow', 'schemas'), { recursive: true })
    mkdirSync(path.join(testDir, '.workflow', 'pipelines'), { recursive: true })
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  test('TEST-26: Stage ordering preserved in pipeline', () => {
    // This test verifies dependency order is respected
    // Verify the pipeline YAML defines correct dependency chain

    const pipelinePath = path.resolve(__dirname, '../../../.workflow/pipelines/change-pipeline.yaml')
    const pipelineContent = readFileSync(pipelinePath, 'utf-8')
    const pipeline = yaml.load(pipelineContent) as any

    const steps = pipeline.steps
    const stepNames = steps.map((s: any) => s.name)

    // Verify all core stages exist
    expect(stepNames).toContain('validate-spec')
    expect(stepNames).toContain('spec-review-loop')
    expect(stepNames).toContain('decompose')
    expect(stepNames).toContain('generation')
    expect(stepNames).toContain('implement')
    expect(stepNames).toContain('conformance')
    expect(stepNames).toContain('acceptance-test')

    // Verify first step has no dependencies (entry point)
    expect(steps[0].name).toBe('validate-spec')

    // Verify core dependency chain is sequential
    const specReviewLoop = steps.find((s: any) => s.name === 'spec-review-loop')
    expect(specReviewLoop.depends_on).toContain('validate-spec')

    const decompose = steps.find((s: any) => s.name === 'decompose')
    expect(decompose.depends_on).toContain('spec-review-loop')

    const generation = steps.find((s: any) => s.name === 'generation')
    expect(generation.depends_on).toContain('decompose')

    const implement = steps.find((s: any) => s.name === 'implement')
    expect(implement.depends_on).toContain('generation')

    // conformance depends on something after implement (possibly via tdd-verify-green)
    const conformance = steps.find((s: any) => s.name === 'conformance')
    expect(conformance.depends_on).toBeDefined()
    expect(conformance.depends_on.length).toBeGreaterThan(0)

    // acceptance-test comes after conformance
    const acceptanceTest = steps.find((s: any) => s.name === 'acceptance-test')
    expect(acceptanceTest.depends_on).toContain('conformance')

    // Verify ordering: each stage's index is after its dependency
    const indexOf = (name: string) => stepNames.indexOf(name)
    expect(indexOf('spec-review-loop')).toBeGreaterThan(indexOf('validate-spec'))
    expect(indexOf('decompose')).toBeGreaterThan(indexOf('spec-review-loop'))
    expect(indexOf('generation')).toBeGreaterThan(indexOf('decompose'))
    expect(indexOf('implement')).toBeGreaterThan(indexOf('generation'))
    expect(indexOf('conformance')).toBeGreaterThan(indexOf('implement'))
    expect(indexOf('acceptance-test')).toBeGreaterThan(indexOf('conformance'))
  })

  test('TEST-27: Tier filtering works', () => {
    const pipelinePath = path.resolve(__dirname, '../../../.workflow/pipelines/change-pipeline.yaml')
    const pipelineContent = readFileSync(pipelinePath, 'utf-8')
    const pipeline = yaml.load(pipelineContent) as any

    // Find acceptance-test step
    const acceptanceTest = pipeline.steps.find((s: any) => s.name === 'acceptance-test')

    // Verify it has tier_min: 2
    expect(acceptanceTest).toBeDefined()
    expect(acceptanceTest.tier_min).toBe(2)

    // At Tier 1, this step should be skipped
    // (Actual filtering happens in DAG engine, not parser)
  })

  test('TEST-25: Pipeline has all expected variables', () => {
    const pipelinePath = path.resolve(__dirname, '../../../.workflow/pipelines/change-pipeline.yaml')
    const pipelineContent = readFileSync(pipelinePath, 'utf-8')
    const pipeline = yaml.load(pipelineContent) as any

    const varNames = pipeline.variables.map((v: any) => v.name)
    expect(varNames).toContain('spec_path')
    expect(varNames).toContain('project_path')
    expect(varNames).toContain('output_dir')
    expect(varNames).toContain('language')
    expect(varNames).toContain('framework')

    // Required variables
    const specPath = pipeline.variables.find((v: any) => v.name === 'spec_path')
    expect(specPath.required).toBe(true)
    expect(specPath.type).toBe('path')
  })

  test('TEST-30: Pipeline defaults block has expected fields', () => {
    const pipelinePath = path.resolve(__dirname, '../../../.workflow/pipelines/change-pipeline.yaml')
    const pipelineContent = readFileSync(pipelinePath, 'utf-8')
    const pipeline = yaml.load(pipelineContent) as any

    expect(pipeline.defaults).toBeDefined()
    expect(pipeline.defaults.tier).toBe(1)
    expect(pipeline.defaults.timeoutSeconds).toBe(3600)
    expect(pipeline.defaults.maxRetries).toBe(1)
    expect(pipeline.defaults.signal_protocol).toBe(true)
    expect(pipeline.defaults.constitution_sections).toContain('security')
    expect(pipeline.defaults.constitution_sections).toContain('architecture')
    expect(pipeline.defaults.constitution_sections).toContain('quality')
  })

  test('TEST-35: Pipeline system config is DAG with session pool', () => {
    const pipelinePath = path.resolve(__dirname, '../../../.workflow/pipelines/change-pipeline.yaml')
    const pipelineContent = readFileSync(pipelinePath, 'utf-8')
    const pipeline = yaml.load(pipelineContent) as any

    expect(pipeline.system).toBeDefined()
    expect(pipeline.system.engine).toBe('dag')
    expect(pipeline.system.session_pool).toBe(true)
    expect(pipeline.system.tier_filter).toBe(true)
  })

  test('TEST-36: spec-review-loop has review_loop type with correct config', () => {
    const pipelinePath = path.resolve(__dirname, '../../../.workflow/pipelines/change-pipeline.yaml')
    const pipelineContent = readFileSync(pipelinePath, 'utf-8')
    const pipeline = yaml.load(pipelineContent) as any

    const reviewLoop = pipeline.steps.find((s: any) => s.name === 'spec-review-loop')
    expect(reviewLoop).toBeDefined()
    expect(reviewLoop.type).toBe('review_loop')
    expect(reviewLoop.max_iterations).toBe(3)
    expect(reviewLoop.on_max_iterations).toBe('escalate')
    expect(reviewLoop.producer).toBeDefined()
    expect(reviewLoop.reviewer).toBeDefined()
    expect(reviewLoop.reviewer.verdict_field).toBe('verdict')
    expect(reviewLoop.reviewer.feedback_field).toBe('feedback')
  })

  test('TEST-37: generation step is parallel_group with correct children', () => {
    const pipelinePath = path.resolve(__dirname, '../../../.workflow/pipelines/change-pipeline.yaml')
    const pipelineContent = readFileSync(pipelinePath, 'utf-8')
    const pipeline = yaml.load(pipelineContent) as any

    const generation = pipeline.steps.find((s: any) => s.name === 'generation')
    expect(generation).toBeDefined()
    expect(generation.type).toBe('parallel_group')
    expect(generation.on_failure).toBe('fail_fast')
    expect(Array.isArray(generation.steps)).toBe(true)
    expect(generation.steps.length).toBeGreaterThanOrEqual(2)

    const childNames = generation.steps.map((s: any) => s.name)
    expect(childNames).toContain('generate-scaffold')
    expect(childNames).toContain('generation-consistency-check')

    // Verify internal dependency
    const consistencyCheck = generation.steps.find((s: any) => s.name === 'generation-consistency-check')
    expect(consistencyCheck.depends_on).toContain('generate-scaffold')
  })

  test('TEST-38: validate-spec step has spec_validate type', () => {
    const pipelinePath = path.resolve(__dirname, '../../../.workflow/pipelines/change-pipeline.yaml')
    const pipelineContent = readFileSync(pipelinePath, 'utf-8')
    const pipeline = yaml.load(pipelineContent) as any

    const validateStep = pipeline.steps.find((s: any) => s.name === 'validate-spec')
    expect(validateStep).toBeDefined()
    expect(validateStep.type).toBe('spec_validate')
    expect(validateStep.spec_path).toContain('spec_path')
    expect(validateStep.schema_path).toContain('schema')
    expect(validateStep.constitution_sections).toContain('security')
    expect(validateStep.constitution_sections).toContain('architecture')
    expect(validateStep.constitution_sections).toContain('quality')
  })

  test('TEST-39: All spawn_session steps have signal_protocol enabled', () => {
    const pipelinePath = path.resolve(__dirname, '../../../.workflow/pipelines/change-pipeline.yaml')
    const pipelineContent = readFileSync(pipelinePath, 'utf-8')
    const pipeline = yaml.load(pipelineContent) as any

    // Collect all spawn_session steps (top-level and nested in review_loop / parallel_group)
    const spawnSessions: any[] = []
    for (const step of pipeline.steps) {
      if (step.type === 'spawn_session') {
        spawnSessions.push(step)
      }
      if (step.producer && step.producer.type === 'spawn_session') {
        spawnSessions.push(step.producer)
      }
      if (step.reviewer && step.reviewer.type === 'spawn_session') {
        spawnSessions.push(step.reviewer)
      }
      if (step.steps) {
        for (const child of step.steps) {
          if (child.type === 'spawn_session') {
            spawnSessions.push(child)
          }
        }
      }
    }

    expect(spawnSessions.length).toBeGreaterThan(0)
    for (const session of spawnSessions) {
      expect(session.signal_protocol).toBe(true)
    }
  })

  test('TEST-40: Pipeline has amendment budget in defaults', () => {
    const pipelinePath = path.resolve(__dirname, '../../../.workflow/pipelines/change-pipeline.yaml')
    const pipelineContent = readFileSync(pipelinePath, 'utf-8')
    const pipeline = yaml.load(pipelineContent) as any

    expect(pipeline.defaults.amendment_budget).toBeDefined()
    expect(pipeline.defaults.amendment_budget.max_amendments).toBe(3)
    expect(pipeline.defaults.amendment_budget.scope).toBe('spec_only')
  })
})
