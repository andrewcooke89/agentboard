/**
 * changePipeline.test.ts — Integration tests for the change-pipeline (Phase 9)
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseWorkflowYAML } from '../workflowSchema'

// Path to the actual pipeline YAML
const PIPELINE_PATH = path.resolve(__dirname, '../../../.workflow/pipelines/change-pipeline.yaml')

describe('change-pipeline integration', () => {
  test('TEST-19: Load and parse change-pipeline.yaml successfully', () => {
    const yamlContent = readFileSync(PIPELINE_PATH, 'utf-8')
    const result = parseWorkflowYAML(yamlContent)

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.workflow).toBeDefined()
    expect(result.workflow!.name).toBe('change-pipeline')
  })

  test('TEST-20: Pipeline has expected step count and names', () => {
    const yamlContent = readFileSync(PIPELINE_PATH, 'utf-8')
    const result = parseWorkflowYAML(yamlContent)

    expect(result.workflow).toBeDefined()
    const stepNames = result.workflow!.steps.map(s => s.name)
    expect(stepNames).toContain('validate-spec')
    expect(stepNames).toContain('spec-review-loop')
    expect(stepNames).toContain('decompose')
    expect(stepNames).toContain('generation')
    expect(stepNames).toContain('implement')
    expect(stepNames).toContain('conformance')
    expect(stepNames).toContain('acceptance-test')
  })

  test('TEST-20b: Duplicate step names rejected', () => {
    const yaml = `
name: duplicate-test
steps:
  - name: step-a
    type: spec_validate
    spec_path: /tmp/spec.yaml
    schema_path: /tmp/schema.yaml
  - name: step-a
    type: spec_validate
    spec_path: /tmp/spec2.yaml
    schema_path: /tmp/schema2.yaml
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('duplicate'))).toBe(true)
  })

  test('TEST-22: DAG auto-detection with parallel_group', () => {
    const yamlContent = readFileSync(PIPELINE_PATH, 'utf-8')
    const result = parseWorkflowYAML(yamlContent)

    expect(result.workflow).toBeDefined()
    expect(result.workflow!.system?.engine).toBe('dag')
  })

  test('Pipeline has defaults block parsed', () => {
    const yamlContent = readFileSync(PIPELINE_PATH, 'utf-8')
    const result = parseWorkflowYAML(yamlContent)

    expect(result.workflow).toBeDefined()
    expect(result.workflow!.defaults).toBeDefined()
    expect(result.workflow!.defaults!.tier).toBe(1)
    expect(result.workflow!.defaults!.timeoutSeconds).toBe(3600)
    expect(result.workflow!.defaults!.signal_protocol).toBe(true)
  })

  test('Pipeline has correct variables defined', () => {
    const yamlContent = readFileSync(PIPELINE_PATH, 'utf-8')
    const result = parseWorkflowYAML(yamlContent)

    expect(result.workflow).toBeDefined()
    const varNames = result.workflow!.variables.map(v => v.name)
    expect(varNames).toContain('spec_path')
    expect(varNames).toContain('project_path')
    expect(varNames).toContain('output_dir')

    const specPathVar = result.workflow!.variables.find(v => v.name === 'spec_path')
    expect(specPathVar!.type).toBe('path')
    expect(specPathVar!.required).toBe(true)
  })

  test('acceptance-test step has tier_min: 2', () => {
    const yamlContent = readFileSync(PIPELINE_PATH, 'utf-8')
    const result = parseWorkflowYAML(yamlContent)

    const acceptStep = result.workflow!.steps.find(s => s.name === 'acceptance-test')
    expect(acceptStep).toBeDefined()
    expect(acceptStep!.tier_min).toBe(2)
  })

  test('validate-spec step has correct type and fields', () => {
    const yamlContent = readFileSync(PIPELINE_PATH, 'utf-8')
    const result = parseWorkflowYAML(yamlContent)

    const validateStep = result.workflow!.steps.find(s => s.name === 'validate-spec')
    expect(validateStep).toBeDefined()
    expect(validateStep!.type).toBe('spec_validate')
    expect(validateStep!.spec_path).toBeDefined()
    expect(validateStep!.schema_path).toBeDefined()
    expect(validateStep!.constitution_sections).toBeDefined()
  })
})
