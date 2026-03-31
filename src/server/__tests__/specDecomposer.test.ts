/**
 * specDecomposer.test.ts — Tests for spec-decomposer agent and work unit schema
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'

describe('spec-decomposer agent', () => {
  test('TEST-23: spec-decomposer agent definition exists', () => {
    const agentPath = '/home/andrew-cooke/.claude/agent-sources/spec-decomposer.md'

    expect(existsSync(agentPath)).toBe(true)

    const content = readFileSync(agentPath, 'utf-8')

    // Verify key requirements
    expect(content).toContain('cooperative-agent')
    expect(content).toContain('< 5 files')  // Scope bounding
    expect(content).toContain('depends_on')  // Dependency ordering
    expect(content).toContain('interface_dependencies')  // Cross-specialist interfaces
    expect(content).toContain('cycle')  // Cycle detection
    expect(content).toContain('topological sort')  // Or Kahn's algorithm
  })

  test('TEST-24: Cycle detection logic documented', () => {
    const agentPath = '/home/andrew-cooke/.claude/agent-sources/spec-decomposer.md'
    const content = readFileSync(agentPath, 'utf-8')

    // Verify cycle detection requirements are documented
    expect(content.toLowerCase()).toContain('cycle')
    expect(content).toMatch(/WU-\d+ -> WU-\d+ -> WU-\d+/)  // Example cycle path

    // Should mention topological sort or Kahn's algorithm
    expect(content.toLowerCase()).toMatch(/topological|kahn/)
  })

  test('TEST-31: Work unit schema has required fields documented', () => {
    const agentPath = '/home/andrew-cooke/.claude/agent-sources/spec-decomposer.md'
    const content = readFileSync(agentPath, 'utf-8')

    // Verify work unit schema documents required fields
    expect(content).toContain('id:')
    expect(content).toContain('title:')
    expect(content).toContain('scope:')
    expect(content).toContain('acceptance_criteria:')
    expect(content).toContain('depends_on:')
    expect(content).toContain('specialization:')
    expect(content).toContain('estimated_complexity:')
  })

  test('TEST-32: Specialization types documented', () => {
    const agentPath = '/home/andrew-cooke/.claude/agent-sources/spec-decomposer.md'
    const content = readFileSync(agentPath, 'utf-8')

    // Verify specialization types
    expect(content).toContain('api')
    expect(content).toContain('data')
    expect(content).toContain('logic')
    expect(content).toContain('infrastructure')
  })

  test('TEST-34: Interface dependency types documented', () => {
    const agentPath = '/home/andrew-cooke/.claude/agent-sources/spec-decomposer.md'
    const content = readFileSync(agentPath, 'utf-8')

    // Verify interface dependency types
    expect(content).toContain('interface:')
    expect(content).toContain('from_work_unit:')
    expect(content).toContain('type: trait')  // trait | interface | protocol
  })

  test('TEST-36: Error handling for oversized specs documented', () => {
    const agentPath = '/home/andrew-cooke/.claude/agent-sources/spec-decomposer.md'
    const content = readFileSync(agentPath, 'utf-8')

    // Verify error handling guidance
    expect(content).toContain('20 work units')
    expect(content.toLowerCase()).toContain('amendment')
    expect(content.toLowerCase()).toContain('unclear scope')
  })
})
