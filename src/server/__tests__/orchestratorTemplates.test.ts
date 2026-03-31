/**
 * orchestratorTemplates.test.ts — Tests for orchestrator templates
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'

describe('Orchestrator templates', () => {
  const templatesDir = '/home/andrew-cooke/.claude/orchestrator-templates'

  test('TEST-28: All four templates exist with required variables', () => {
    const templates = [
      'spec-planning.md',
      'decomposition.md',
      'implementation.md',
      'verification.md',
    ]

    for (const template of templates) {
      const templatePath = `${templatesDir}/${template}`
      expect(existsSync(templatePath)).toBe(true)

      const content = readFileSync(templatePath, 'utf-8')

      // Verify common variables exist
      expect(content).toContain('{{ spec_path }}')
      expect(content).toContain('{{ output_dir }}')
      expect(content).toContain('{{ constitution_sections }}')
    }
  })

  test('TEST-29: Implementation template includes R6 constraints', () => {
    const implementationPath = `${templatesDir}/implementation.md`
    const content = readFileSync(implementationPath, 'utf-8')

    // Verify R6 constitutional constraints
    expect(content).toContain('Implementor NEVER writes tests')
    expect(content).toContain('file:line evidence')
    expect(content).toContain('claim-manifest')
  })

  test('TEST-33: Spec-planning template includes clarifying questions', () => {
    const planningPath = `${templatesDir}/spec-planning.md`
    const content = readFileSync(planningPath, 'utf-8')

    // Verify 7 question categories (REQ-54, REQ-55)
    expect(content).toContain('gaps')
    expect(content).toContain('ambiguity')
    expect(content).toContain('edge_cases')
    expect(content).toContain('performance')
    expect(content).toContain('security')
    expect(content).toContain('integration')
    expect(content).toContain('testing')

    expect(content).toContain('clarifying-questions.yaml')
  })

  test('TEST-37: Decomposition template references code-intel tools', () => {
    const decompositionPath = `${templatesDir}/decomposition.md`
    const content = readFileSync(decompositionPath, 'utf-8')

    // Verify code-intel tool references
    expect(content).toContain('find_symbol')
    expect(content).toContain('find_references')
    expect(content).toContain('call_graph')
    expect(content).toContain('file_dependencies')
  })

  test('TEST-38: Decomposition template includes cycle detection requirements', () => {
    const decompositionPath = `${templatesDir}/decomposition.md`
    const content = readFileSync(decompositionPath, 'utf-8')

    // Verify cycle detection is mentioned
    expect(content.toLowerCase()).toContain('cycle')
    expect(content.toLowerCase()).toContain('topological')
    expect(content).toContain('depends_on')
  })

  test('TEST-39: Verification template includes conformance report schema', () => {
    const verificationPath = `${templatesDir}/verification.md`
    const content = readFileSync(verificationPath, 'utf-8')

    // Verify conformance report structure
    expect(content).toContain('overall_status')
    expect(content).toContain('acceptance_criteria')
    expect(content).toContain('constitution_checks')
    expect(content).toContain('verified')
    expect(content).toContain('unverified')
  })

  test('TEST-40: Implementation template includes amendment handling', () => {
    const implementationPath = `${templatesDir}/implementation.md`
    const content = readFileSync(implementationPath, 'utf-8')

    // Verify amendment handling
    expect(content).toContain('amendment')
    expect(content).toContain('amendment_budget')
    expect(content).toContain('gap')
    expect(content).toContain('blocking')
  })

  test('TEST-28b: Templates that reference project_path use it correctly', () => {
    // spec-planning and decomposition use project_path directly
    const templatesWithProjectPath = [
      'spec-planning.md',
      'decomposition.md',
    ]

    for (const template of templatesWithProjectPath) {
      const templatePath = `${templatesDir}/${template}`
      const content = readFileSync(templatePath, 'utf-8')
      expect(content).toContain('{{ project_path }}')
    }

    // implementation template uses scope and work_unit_path instead
    const implContent = readFileSync(`${templatesDir}/implementation.md`, 'utf-8')
    expect(implContent).toContain('{{ scope }}')
    expect(implContent).toContain('{{ work_unit_path }}')
  })
})
