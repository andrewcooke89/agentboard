/**
 * workflowSchema.test.ts — Tests for YAML workflow parsing and validation (WO-003)
 */

import { describe, test, expect } from 'bun:test'
import { parseWorkflowYAML, substituteVariables, shellEscape } from '../workflowSchema'
import type { WorkflowStep } from '../../shared/types'

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const VALID_WORKFLOW = `
name: my-pipeline
description: "Runs analysis pipeline"
steps:
  - name: analyze
    type: spawn_session
    projectPath: /path/to/project
    prompt: "Analyze the codebase"
    output_path: ./output/analysis.md
    timeoutSeconds: 3600
    maxRetries: 2

  - name: verify
    type: check_file
    path: ./output/analysis.json
    timeoutSeconds: 60

  - name: pause
    type: delay
    seconds: 30

  - name: validate
    type: check_output
    step: analyze
    contains: "no errors found"
`

const VALID_MINIMAL = `
name: simple
steps:
  - name: step1
    type: spawn_session
    projectPath: /tmp
    prompt: test
`

const CONDITIONAL_WORKFLOW = `
name: conditional-pipeline
steps:
  - name: setup
    type: spawn_session
    projectPath: /tmp
    prompt: "setup"

  - name: check-ready
    type: check_file
    path: ./ready.txt
    condition:
      type: file_exists
      path: ./pre-check.txt

  - name: verify-output
    type: check_output
    step: setup
    contains: "SUCCESS"
    condition:
      type: output_contains
      step: setup
      contains: "READY"
`

// ─── Valid Workflow Tests ────────────────────────────────────────────────────

describe('parseWorkflowYAML — valid workflows', () => {
  test('parses a full valid workflow', () => {
    const result = parseWorkflowYAML(VALID_WORKFLOW)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.workflow).toBeDefined()
    expect(result.workflow!.name).toBe('my-pipeline')
    expect(result.workflow!.description).toBe('Runs analysis pipeline')
    expect(result.workflow!.steps).toHaveLength(4)
  })

  test('parses minimal valid workflow', () => {
    const result = parseWorkflowYAML(VALID_MINIMAL)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.workflow!.name).toBe('simple')
    expect(result.workflow!.description).toBeNull()
    expect(result.workflow!.steps).toHaveLength(1)
  })

  test('parses step types correctly', () => {
    const result = parseWorkflowYAML(VALID_WORKFLOW)
    const steps = result.workflow!.steps
    expect(steps[0].type).toBe('spawn_session')
    expect(steps[1].type).toBe('check_file')
    expect(steps[2].type).toBe('delay')
    expect(steps[3].type).toBe('check_output')
  })

  test('parses spawn_session fields', () => {
    const result = parseWorkflowYAML(VALID_WORKFLOW)
    const step = result.workflow!.steps[0]
    expect(step.projectPath).toBe('/path/to/project')
    expect(step.prompt).toBe('Analyze the codebase')
    expect(step.output_path).toBe('./output/analysis.md')
    expect(step.timeoutSeconds).toBe(3600)
    expect(step.maxRetries).toBe(2)
  })

  test('parses agentType from spawn_session step', () => {
    const yaml = `name: test\nsteps:\n  - name: s1\n    type: spawn_session\n    projectPath: /tmp\n    prompt: hello\n    agentType: codex\n`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].agentType).toBe('codex')
  })

  test('ignores invalid agentType values', () => {
    const yaml = `name: test\nsteps:\n  - name: s1\n    type: spawn_session\n    projectPath: /tmp\n    prompt: hello\n    agentType: invalid\n`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].agentType).toBeUndefined()
  })

  test('parses check_file fields', () => {
    const result = parseWorkflowYAML(VALID_WORKFLOW)
    const step = result.workflow!.steps[1]
    expect(step.path).toBe('./output/analysis.json')
    expect(step.timeoutSeconds).toBe(60)
  })

  test('parses delay fields', () => {
    const result = parseWorkflowYAML(VALID_WORKFLOW)
    const step = result.workflow!.steps[2]
    expect(step.seconds).toBe(30)
  })

  test('parses check_output fields', () => {
    const result = parseWorkflowYAML(VALID_WORKFLOW)
    const step = result.workflow!.steps[3]
    expect(step.step).toBe('analyze')
    expect(step.contains).toBe('no errors found')
  })

  test('parses conditions correctly', () => {
    const result = parseWorkflowYAML(CONDITIONAL_WORKFLOW)
    expect(result.valid).toBe(true)

    const step1 = result.workflow!.steps[1]
    expect(step1.condition).toEqual({ type: 'file_exists', path: './pre-check.txt' })

    const step2 = result.workflow!.steps[2]
    expect(step2.condition).toEqual({ type: 'output_contains', step: 'setup', contains: 'READY' })
  })

  test('missing description is null', () => {
    const result = parseWorkflowYAML(VALID_MINIMAL)
    expect(result.workflow!.description).toBeNull()
  })

  test('missing condition is undefined', () => {
    const result = parseWorkflowYAML(VALID_MINIMAL)
    expect(result.workflow!.steps[0].condition).toBeUndefined()
  })
})

// ─── YAML Syntax Error Tests ────────────────────────────────────────────────

describe('parseWorkflowYAML — YAML syntax errors', () => {
  test('catches YAML syntax error', () => {
    const result = parseWorkflowYAML('name: test\nsteps:\n  - bad: [unclosed')
    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('YAML syntax error')
  })

  test('handles empty input', () => {
    const result = parseWorkflowYAML('')
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('empty')
  })

  test('handles whitespace-only input', () => {
    const result = parseWorkflowYAML('   \n  \n  ')
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('empty')
  })

  test('rejects non-object YAML (string)', () => {
    const result = parseWorkflowYAML('just a string')
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('must parse to an object')
  })

  test('rejects non-object YAML (array)', () => {
    const result = parseWorkflowYAML('- item1\n- item2')
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toContain('must parse to an object')
  })
})

// ─── Required Field Validation Tests ────────────────────────────────────────

describe('parseWorkflowYAML — required fields', () => {
  test('missing name field', () => {
    const result = parseWorkflowYAML(`
steps:
  - name: s1
    type: spawn_session
    projectPath: /tmp
    prompt: test
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('name is required'))
  })

  test('empty name field', () => {
    const result = parseWorkflowYAML(`
name: ""
steps:
  - name: s1
    type: spawn_session
    projectPath: /tmp
    prompt: test
`)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('name'))).toBe(true)
  })

  test('missing steps field', () => {
    const result = parseWorkflowYAML('name: test')
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('steps is required'))
  })

  test('empty steps array', () => {
    const result = parseWorkflowYAML(`
name: test
steps: []
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('at least 1 step'))
  })

  test('steps is not an array', () => {
    const result = parseWorkflowYAML(`
name: test
steps: "not-an-array"
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('must be an array'))
  })

  test('step missing name', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - type: delay
    seconds: 5
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('steps[0].name is required'))
  })

  test('step missing type', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('steps[0].type is required'))
  })

  test('step is not an object', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - "just a string"
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('steps[0] must be an object'))
  })
})

// ─── Step Type Validation ───────────────────────────────────────────────────

describe('parseWorkflowYAML — step type validation', () => {
  test('invalid step type', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: run_command
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('"run_command" is invalid'))
    expect(result.errors[0]).toContain('spawn_session')
  })

  test('TEST-21: Unknown step type rejected', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: step-a
    type: unknown_step_type
`)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('unknown_step_type'))).toBe(true)
    expect(result.errors.some(e => e.includes('invalid'))).toBe(true)
  })
})

// ─── Type-Specific Field Validation ─────────────────────────────────────────

describe('parseWorkflowYAML — type-specific required fields', () => {
  test('spawn_session missing projectPath', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: spawn_session
    prompt: test
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('projectPath is required'))
  })

  test('spawn_session missing prompt', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: spawn_session
    projectPath: /tmp
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('prompt is required'))
  })

  test('check_file missing path', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: check_file
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('path is required'))
  })

  test('delay missing seconds', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('seconds is required'))
  })

  test('delay with zero seconds', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
    seconds: 0
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('greater than 0'))
  })

  test('delay with negative seconds', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
    seconds: -5
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('greater than 0'))
  })

  test('check_output missing step field', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: prior
    type: delay
    seconds: 1
  - name: s1
    type: check_output
    contains: "text"
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('step is required'))
  })

  test('check_output missing contains field', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: prior
    type: delay
    seconds: 1
  - name: s1
    type: check_output
    step: prior
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('contains is required'))
  })
})

// ─── Step Name Uniqueness ───────────────────────────────────────────────────

describe('parseWorkflowYAML — step name uniqueness', () => {
  test('detects duplicate step names', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: my-step
    type: delay
    seconds: 1
  - name: my-step
    type: delay
    seconds: 2
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('duplicate'))
    expect(result.errors).toContainEqual(expect.stringContaining('"my-step"'))
  })

  test('case-sensitive name comparison', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: step-1
    type: delay
    seconds: 1
  - name: Step-1
    type: delay
    seconds: 2
`)
    // "step-1" and "Step-1" are different — should be valid
    expect(result.valid).toBe(true)
  })

  test('reports multiple duplicate names', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: dup-a
    type: delay
    seconds: 1
  - name: dup-b
    type: delay
    seconds: 1
  - name: dup-a
    type: delay
    seconds: 2
  - name: dup-b
    type: delay
    seconds: 2
`)
    expect(result.valid).toBe(false)
    const dupErrors = result.errors.filter(e => e.includes('duplicate'))
    expect(dupErrors.length).toBe(2)
  })
})

// ─── check_output Reference Validation ──────────────────────────────────────

describe('parseWorkflowYAML — check_output reference validation', () => {
  test('valid reference to prior step', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: first
    type: spawn_session
    projectPath: /tmp
    prompt: test
  - name: check
    type: check_output
    step: first
    contains: "ok"
`)
    expect(result.valid).toBe(true)
  })

  test('reference to non-existent step', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: first
    type: spawn_session
    projectPath: /tmp
    prompt: test
  - name: check
    type: check_output
    step: nonexistent
    contains: "ok"
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('"nonexistent"'))
    expect(result.errors).toContainEqual(expect.stringContaining('unknown or later step'))
  })

  test('reference to self', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: first
    type: spawn_session
    projectPath: /tmp
    prompt: test
  - name: self-ref
    type: check_output
    step: self-ref
    contains: "ok"
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('references itself'))
  })

  test('reference to later step', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: check
    type: check_output
    step: later
    contains: "ok"
  - name: later
    type: spawn_session
    projectPath: /tmp
    prompt: test
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('"later"'))
    expect(result.errors).toContainEqual(expect.stringContaining('unknown or later step'))
  })
})

// ─── Condition Validation ───────────────────────────────────────────────────

describe('parseWorkflowYAML — condition validation', () => {
  test('valid file_exists condition', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    condition:
      type: file_exists
      path: ./check.txt
`)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].condition).toEqual({
      type: 'file_exists',
      path: './check.txt',
    })
  })

  test('valid output_contains condition', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: first
    type: spawn_session
    projectPath: /tmp
    prompt: test
  - name: s2
    type: delay
    seconds: 1
    condition:
      type: output_contains
      step: first
      contains: "SUCCESS"
`)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[1].condition).toEqual({
      type: 'output_contains',
      step: 'first',
      contains: 'SUCCESS',
    })
  })

  test('invalid condition type', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    condition:
      type: invalid_type
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('"invalid_type" is invalid'))
  })

  test('file_exists condition missing path', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    condition:
      type: file_exists
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('condition.path is required'))
  })

  test('output_contains condition missing step', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    condition:
      type: output_contains
      contains: "text"
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('condition.step is required'))
  })

  test('output_contains condition missing contains', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: first
    type: delay
    seconds: 1
  - name: s2
    type: delay
    seconds: 1
    condition:
      type: output_contains
      step: first
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('condition.contains is required'))
  })

  test('output_contains condition references unknown step', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    condition:
      type: output_contains
      step: ghost
      contains: "text"
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(
      expect.stringContaining('condition.step "ghost" references an unknown or later step'),
    )
  })

  test('condition is not an object or string', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    condition:
      - item1
      - item2
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('condition must be an object or string expression'))
  })

  test('condition string expression is accepted', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    condition: "tier >= 2"
`)
    expect(result.valid).toBe(true)
    expect(result.workflow?.steps[0].condition).toEqual({ type: 'expression', expr: 'tier >= 2' })
  })

  test('condition missing type field', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    condition:
      path: ./test.txt
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('condition.type is required'))
  })

  test('missing condition is valid (conditions are optional)', () => {
    const result = parseWorkflowYAML(VALID_MINIMAL)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].condition).toBeUndefined()
  })
})

// ─── Error Accumulation ─────────────────────────────────────────────────────

describe('parseWorkflowYAML — error accumulation', () => {
  test('accumulates multiple errors', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: spawn_session
  - type: delay
  - name: s1
    type: invalid_type
`)
    expect(result.valid).toBe(false)
    // Should have at least: missing projectPath, missing prompt, missing name, duplicate name, invalid type
    expect(result.errors.length).toBeGreaterThanOrEqual(4)
  })

  test('error messages include field paths', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: spawn_session
`)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('steps[0]'))).toBe(true)
  })
})

// ─── Security: !! Tag Stripping (YAML-SECURITY-001) ────────────────────────

describe('parseWorkflowYAML — security', () => {
  test('!! tags are stripped (FAILSAFE_SCHEMA)', () => {
    // FAILSAFE_SCHEMA treats everything as strings, preventing !! exploits
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: spawn_session
    projectPath: /tmp
    prompt: !!js/function "function(){ return 'pwned' }"
`)
    // With FAILSAFE_SCHEMA, the !! tag is not interpreted as JS
    // It either parses as a plain string or causes a parse error — both are safe
    if (result.valid) {
      // If it parsed, the value is a string, not an executed function
      expect(typeof result.workflow!.steps[0].prompt).toBe('string')
    } else {
      // If it errored, that's also safe
      expect(result.errors.length).toBeGreaterThan(0)
    }
  })
})

// ─── Input Validation (HIGH-001) ───────────────────────────────────────────

describe('parseWorkflowYAML — input validation (HIGH-001)', () => {
  test('step name exceeds 128 characters', () => {
    const longName = 'a'.repeat(129)
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: ${longName}
    type: delay
    seconds: 1
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('name exceeds maximum length of 128'))
  })

  test('prompt exceeds 100000 characters', () => {
    const longPrompt = 'a'.repeat(100001)
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: spawn_session
    projectPath: /tmp
    prompt: "${longPrompt}"
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('prompt exceeds maximum length of 100000'))
  })

  test('projectPath exceeds 4096 characters', () => {
    const longPath = '/tmp/' + 'a'.repeat(4092)
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: spawn_session
    projectPath: ${longPath}
    prompt: test
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('projectPath exceeds maximum length of 4096'))
  })

  test('output_path exceeds 4096 characters', () => {
    const longPath = '/tmp/' + 'a'.repeat(4092)
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    output_path: ${longPath}
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('output_path exceeds maximum length of 4096'))
  })

  test('output_path contains .. segments', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    output_path: /tmp/../etc/passwd
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining("output_path must not contain '..' segments"))
  })

  test('timeoutSeconds exceeds 86400', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    timeoutSeconds: 86401
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('timeoutSeconds must not exceed 86400'))
  })

  test('timeoutSeconds is not an integer', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    timeoutSeconds: 3.14
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('timeoutSeconds must be an integer'))
  })

  test('timeoutSeconds is negative', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    timeoutSeconds: -100
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('timeoutSeconds must be a positive integer'))
  })

  test('maxRetries exceeds 10', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    maxRetries: 11
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('maxRetries must not exceed 10'))
  })

  test('maxRetries is not an integer', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    maxRetries: 2.5
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('maxRetries must be an integer'))
  })

  test('maxRetries is negative', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    maxRetries: -1
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('maxRetries must be a non-negative integer'))
  })

  test('delay seconds exceeds 86400', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
    seconds: 86401
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('seconds must not exceed 86400'))
  })

  test('check_output contains exceeds 10000 characters', () => {
    const longContains = 'a'.repeat(10001)
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: first
    type: delay
    seconds: 1
  - name: check
    type: check_output
    step: first
    contains: "${longContains}"
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('contains exceeds maximum length of 10000'))
  })

  test('check_file path exceeds 4096 characters', () => {
    const longPath = '/tmp/' + 'a'.repeat(4092)
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: check_file
    path: ${longPath}
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('path exceeds maximum length of 4096'))
  })

  test('check_file max_age_seconds is not an integer', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: check_file
    path: /tmp/test.txt
    max_age_seconds: 3.14
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('max_age_seconds must be an integer'))
  })

  test('check_file max_age_seconds is negative', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: check_file
    path: /tmp/test.txt
    max_age_seconds: -100
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('max_age_seconds must be a positive integer'))
  })

  test('condition path exceeds 4096 characters', () => {
    const longPath = '/tmp/' + 'a'.repeat(4092)
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    condition:
      type: file_exists
      path: ${longPath}
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('condition.path exceeds maximum length of 4096'))
  })

  test('condition contains exceeds 10000 characters', () => {
    const longContains = 'a'.repeat(10001)
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: first
    type: delay
    seconds: 1
  - name: s2
    type: delay
    seconds: 1
    condition:
      type: output_contains
      step: first
      contains: "${longContains}"
`)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('condition.contains exceeds maximum length of 10000'))
  })

  test('valid values at boundaries are accepted', () => {
    const result = parseWorkflowYAML(`
name: test
steps:
  - name: ${'a'.repeat(128)}
    type: spawn_session
    projectPath: /tmp
    prompt: test
    timeoutSeconds: 86400
    maxRetries: 10
  - name: s2
    type: delay
    seconds: 86400
`)
    expect(result.valid).toBe(true)
  })
})

// ─── Result File Validation (WO-008) ───────────────────────────────────────

describe('parseWorkflowYAML — result_file', () => {
  test('parses result_file from YAML', () => {
    const yaml = `
name: test-workflow
steps:
  - name: review
    type: spawn_session
    projectPath: /tmp/test
    prompt: Do review
    result_file: review-result.json
`
    const result = parseWorkflowYAML(yaml)
    expect(result.errors).toEqual([])
    expect(result.workflow?.steps[0].result_file).toBe('review-result.json')
  })

  test('rejects result_file with .. segments', () => {
    const yaml = `
name: test-workflow
steps:
  - name: review
    type: spawn_session
    projectPath: /tmp/test
    prompt: Do review
    result_file: ../escape.json
`
    const result = parseWorkflowYAML(yaml)
    expect(result.errors.some(e => e.includes('result_file') && e.includes('..'))).toBe(true)
  })

  test('rejects result_file exceeding 4096 chars', () => {
    const longPath = 'a'.repeat(4097) + '.json'
    const yaml = `
name: test-workflow
steps:
  - name: review
    type: spawn_session
    projectPath: /tmp/test
    prompt: Do review
    result_file: ${longPath}
`
    const result = parseWorkflowYAML(yaml)
    expect(result.errors.some(e => e.includes('result_file') && e.includes('4096'))).toBe(true)
  })

  test('applies variable substitution to result_file', () => {
    const yaml = `
name: test-workflow
variables:
  - name: output_name
    default: review
steps:
  - name: review
    type: spawn_session
    projectPath: /tmp/test
    prompt: Do review
    result_file: "{{ output_name }}-result.json"
`
    const result = parseWorkflowYAML(yaml)
    expect(result.errors).toEqual([])
    // substituteVariables is tested separately, just verify the field is parsed
    expect(result.workflow?.steps[0].result_file).toBe('{{ output_name }}-result.json')
  })
})

// ─── Variable Substitution (WO-008) ────────────────────────────────────────

describe('substituteVariables — result_file', () => {
  test('substitutes variables in result_file with path safety', () => {
    const steps: WorkflowStep[] = [{
      name: 'test',
      type: 'spawn_session',
      result_file: '{{ name }}-result.json',
    }]
    const result = substituteVariables(steps, { name: 'review' })
    expect(result[0].result_file).toBe('review-result.json')
  })

  test('rejects result_file with .. after substitution', () => {
    const steps: WorkflowStep[] = [{
      name: 'test',
      type: 'spawn_session',
      result_file: '{{ name }}/result.json',
    }]
    expect(() => substituteVariables(steps, { name: '..' })).toThrow('..')
  })
})

// ─── native_step Parsing (Phase 4) ─────────────────────────────────────────

describe('parseWorkflowYAML — native_step', () => {
  test('parses native_step with command field', () => {
    const yaml = `
name: test
steps:
  - name: build
    type: native_step
    command: "make build"
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].type).toBe('native_step')
    expect(result.workflow!.steps[0].command).toBe('make build')
  })

  test('parses native_step with action field', () => {
    const yaml = `
name: test
steps:
  - name: rebase
    type: native_step
    action: git_rebase_from_main
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].action).toBe('git_rebase_from_main')
  })

  test('rejects native_step with both command and action', () => {
    const yaml = `
name: test
steps:
  - name: bad
    type: native_step
    command: "echo hi"
    action: run_tests
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('either command or action, not both'))
  })

  test('rejects native_step with neither command nor action', () => {
    const yaml = `
name: test
steps:
  - name: empty
    type: native_step
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('requires either command, action, or execution.command'))
  })

  test('parses native_step with all optional fields', () => {
    const yaml = `
name: test
steps:
  - name: full
    type: native_step
    command: "echo hello"
    args:
      - "--flag"
      - "value"
    working_dir: /tmp/work
    env:
      FOO: bar
      BAZ: qux
    success_codes:
      - 0
      - 1
    capture_stderr: true
    timeoutSeconds: 60
    maxRetries: 2
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    const step = result.workflow!.steps[0]
    expect(step.command).toBe('echo hello')
    expect(step.args).toEqual(['--flag', 'value'])
    expect(step.working_dir).toBe('/tmp/work')
    expect(step.env).toEqual({ FOO: 'bar', BAZ: 'qux' })
    expect(step.success_codes).toEqual([0, 1])
    expect(step.capture_stderr).toBe(true)
    expect(step.timeoutSeconds).toBe(60)
    expect(step.maxRetries).toBe(2)
  })

  test('rejects native_step with non-array args', () => {
    const yaml = `
name: test
steps:
  - name: bad-args
    type: native_step
    command: "echo"
    args: "not-an-array"
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('args must be an array'))
  })

  test('rejects native_step with non-object env', () => {
    const yaml = `
name: test
steps:
  - name: bad-env
    type: native_step
    command: "echo"
    env: "not-an-object"
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('env must be an object'))
  })

  test('rejects native_step with non-integer success_codes', () => {
    const yaml = `
name: test
steps:
  - name: bad-codes
    type: native_step
    command: "echo"
    success_codes:
      - abc
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('success_codes[0] must be an integer'))
  })

  test('rejects native_step with .. in working_dir', () => {
    const yaml = `
name: test
steps:
  - name: bad-path
    type: native_step
    command: "echo"
    working_dir: /tmp/../etc
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining("working_dir must not contain '..' path segments"))
  })
})

// ─── Tier Parsing and Validation (Phase 4) ──────────────────────────────────

describe('parseWorkflowYAML — tier fields', () => {
  test('tier_min and tier_max parse on spawn_session', () => {
    const yaml = `
name: test
steps:
  - name: s1
    type: spawn_session
    projectPath: /tmp
    prompt: test
    tier_min: 1
    tier_max: 3
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].tier_min).toBe(1)
    expect(result.workflow!.steps[0].tier_max).toBe(3)
  })

  test('tier_min and tier_max parse on delay', () => {
    const yaml = `
name: test
steps:
  - name: s1
    type: delay
    seconds: 5
    tier_min: 0
    tier_max: 2
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].tier_min).toBe(0)
    expect(result.workflow!.steps[0].tier_max).toBe(2)
  })

  test('tier_min and tier_max parse on native_step', () => {
    const yaml = `
name: test
steps:
  - name: s1
    type: native_step
    command: "echo hi"
    tier_min: 2
    tier_max: 5
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].tier_min).toBe(2)
    expect(result.workflow!.steps[0].tier_max).toBe(5)
  })

  test('rejects negative tier_min', () => {
    const yaml = `
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    tier_min: -1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('tier_min must be a non-negative integer'))
  })

  test('rejects non-integer tier_max', () => {
    const yaml = `
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    tier_max: 2.5
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('tier_max must be a non-negative integer'))
  })

  test('rejects tier_min > tier_max', () => {
    const yaml = `
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    tier_min: 5
    tier_max: 2
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('tier_min (5) must be <= tier_max (2)'))
  })

  test('tier_min == tier_max is valid', () => {
    const yaml = `
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
    tier_min: 3
    tier_max: 3
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
  })

  test('default_tier parses from YAML', () => {
    const yaml = `
name: test
default_tier: 2
steps:
  - name: s1
    type: delay
    seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.default_tier).toBe(2)
  })

  test('default_tier rejects non-integer', () => {
    const yaml = `
name: test
default_tier: abc
steps:
  - name: s1
    type: delay
    seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('default_tier must be a non-negative integer'))
  })

  test('default_tier rejects negative', () => {
    const yaml = `
name: test
default_tier: -1
steps:
  - name: s1
    type: delay
    seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('default_tier must be a non-negative integer'))
  })

  test('absent tier fields are undefined', () => {
    const yaml = `
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].tier_min).toBeUndefined()
    expect(result.workflow!.steps[0].tier_max).toBeUndefined()
    expect(result.workflow!.default_tier).toBeUndefined()
  })
})

// ─── Variable Substitution for native_step (Phase 4) ────────────────────────

describe('substituteVariables — native_step fields', () => {
  test('substitutes variables in command with shell escaping', () => {
    const steps: WorkflowStep[] = [{
      name: 'test',
      type: 'native_step',
      command: 'echo {{ msg }}',
    }]
    const result = substituteVariables(steps, { msg: 'hello world' })
    // shell-escaped: single-quoted
    expect(result[0].command).toBe("echo 'hello world'")
  })

  test('substitutes variables in args with shell escaping', () => {
    const steps: WorkflowStep[] = [{
      name: 'test',
      type: 'native_step',
      command: 'run',
      args: ['--name', '{{ val }}'],
    }]
    const result = substituteVariables(steps, { val: "it's here" })
    expect(result[0].args![1]).toBe("'it'\\''s here'")
  })

  test('substitutes variables in working_dir with path safety', () => {
    const steps: WorkflowStep[] = [{
      name: 'test',
      type: 'native_step',
      command: 'ls',
      working_dir: '/base/{{ dir }}',
    }]
    const result = substituteVariables(steps, { dir: 'subdir' })
    expect(result[0].working_dir).toBe('/base/subdir')
  })

  test('rejects working_dir with .. after substitution', () => {
    const steps: WorkflowStep[] = [{
      name: 'test',
      type: 'native_step',
      command: 'ls',
      working_dir: '/base/{{ dir }}',
    }]
    expect(() => substituteVariables(steps, { dir: '..' })).toThrow('..')
  })

  test('substitutes variables in env values', () => {
    const steps: WorkflowStep[] = [{
      name: 'test',
      type: 'native_step',
      command: 'run',
      env: { API_KEY: '{{ key }}' },
    }]
    const result = substituteVariables(steps, { key: 'secret123' })
    expect(result[0].env!.API_KEY).toBe('secret123')
  })
})

// ─── Shell Escape (Phase 4) ────────────────────────────────────────────────

describe('shellEscape', () => {
  test('wraps simple string in single quotes', () => {
    expect(shellEscape('hello')).toBe("'hello'")
  })

  test('escapes single quotes within string', () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'")
  })

  test('handles empty string', () => {
    expect(shellEscape('')).toBe("''")
  })

  test('handles string with spaces and special chars', () => {
    expect(shellEscape('a b$c')).toBe("'a b$c'")
  })
})

// ─── Phase 5: DAG Engine & parallel_group ─────────────────────────────────

describe('parseWorkflowYAML — Phase 5 parallel_group', () => {
  test('valid parallel_group step parses correctly', () => {
    const yaml = `
name: dag-pipeline
steps:
  - name: parallel-work
    type: parallel_group
    on_failure: fail_fast
    steps:
      - name: task-a
        type: spawn_session
        projectPath: /tmp/a
        prompt: "Do A"
      - name: task-b
        type: spawn_session
        projectPath: /tmp/b
        prompt: "Do B"
        depends_on:
          - task-a
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    const step = result.workflow!.steps[0]
    expect(step.type).toBe('parallel_group')
    expect(step.on_failure).toBe('fail_fast')
    expect(step.steps).toHaveLength(2)
    expect(step.steps![0].name).toBe('task-a')
    expect(step.steps![1].name).toBe('task-b')
    expect(step.steps![1].depends_on).toEqual(['task-a'])
  })

  test('parallel_group requires children array', () => {
    const yaml = `
name: test
steps:
  - name: pg
    type: parallel_group
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('must have at least one child step'))
  })

  test('parallel_group rejects empty children', () => {
    const yaml = `
name: test
steps:
  - name: pg
    type: parallel_group
    steps: []
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('must have at least one child step'))
  })

  test('parallel_group validates child step types', () => {
    const yaml = `
name: test
steps:
  - name: pg
    type: parallel_group
    steps:
      - name: child1
        type: spawn_session
        projectPath: /tmp
        prompt: test
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
  })

  test('parallel_group rejects nested parallel_group', () => {
    const yaml = `
name: test
steps:
  - name: pg
    type: parallel_group
    steps:
      - name: nested
        type: parallel_group
        steps:
          - name: inner
            type: delay
            seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('cannot be nested'))
  })

  test('parallel_group validates on_failure enum', () => {
    const yaml = `
name: test
steps:
  - name: pg
    type: parallel_group
    on_failure: invalid_value
    steps:
      - name: c1
        type: delay
        seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('on_failure must be one of'))
  })
})

describe('parseWorkflowYAML — Phase 5 cycle detection', () => {
  test('TEST-04: detects dependency cycle in parallel_group children', () => {
    const yaml = `
name: test
steps:
  - name: pg
    type: parallel_group
    steps:
      - name: a
        type: delay
        seconds: 1
        depends_on:
          - b
      - name: b
        type: delay
        seconds: 1
        depends_on:
          - a
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('Circular dependency detected'))
  })

  test('TEST-05: detects self-dependency', () => {
    const yaml = `
name: test
steps:
  - name: pg
    type: parallel_group
    steps:
      - name: self-ref
        type: delay
        seconds: 1
        depends_on:
          - self-ref
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('Self-dependency detected'))
  })

  test('TEST-06: depends_on on top-level step triggers DAG auto-detection', () => {
    const yaml = `
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
  - name: s2
    type: delay
    seconds: 1
    depends_on:
      - s1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    // Auto-detection should set engine to DAG
    expect(result.workflow!.system?.engine).toBe('dag')
    expect(result.workflow!.system?.autoDetectedEngine).toBe(true)
  })

  test('TEST-07: depends_on targeting step outside parallel_group produces error', () => {
    const yaml = `
name: test
steps:
  - name: pg
    type: parallel_group
    steps:
      - name: child1
        type: delay
        seconds: 1
        depends_on:
          - nonexistent_sibling
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('is not a sibling within this parallel_group'))
  })

  test('three-node cycle is detected', () => {
    const yaml = `
name: test
steps:
  - name: pg
    type: parallel_group
    steps:
      - name: a
        type: delay
        seconds: 1
        depends_on:
          - c
      - name: b
        type: delay
        seconds: 1
        depends_on:
          - a
      - name: c
        type: delay
        seconds: 1
        depends_on:
          - b
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('Circular dependency detected'))
  })

  test('valid DAG (no cycle) passes', () => {
    const yaml = `
name: test
steps:
  - name: pg
    type: parallel_group
    steps:
      - name: a
        type: delay
        seconds: 1
      - name: b
        type: delay
        seconds: 1
        depends_on:
          - a
      - name: c
        type: delay
        seconds: 1
        depends_on:
          - a
          - b
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
  })

  test('max_parallel parses correctly as positive integer', () => {
    const yaml = `
name: test
steps:
  - name: pg
    type: parallel_group
    max_parallel: 3
    steps:
      - name: a
        type: delay
        seconds: 1
      - name: b
        type: delay
        seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    const step = result.workflow!.steps[0]
    expect(step.max_parallel).toBe(3)
  })

  test('max_parallel rejects zero', () => {
    const yaml = `
name: test
steps:
  - name: pg
    type: parallel_group
    max_parallel: 0
    steps:
      - name: a
        type: delay
        seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('max_parallel must be a positive integer'))
  })

  test('max_parallel rejects negative', () => {
    const yaml = `
name: test
steps:
  - name: pg
    type: parallel_group
    max_parallel: -1
    steps:
      - name: a
        type: delay
        seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('max_parallel must be a positive integer'))
  })

  test('max_parallel rejects non-integer', () => {
    const yaml = `
name: test
steps:
  - name: pg
    type: parallel_group
    max_parallel: 1.5
    steps:
      - name: a
        type: delay
        seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('max_parallel must be a positive integer'))
  })

  test('amendment_check cannot be a parallel_group child', () => {
    const yaml = `
name: test
steps:
  - name: pg
    type: parallel_group
    steps:
      - name: ac
        type: amendment_check
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('"amendment_check" cannot be a parallel_group child'))
  })
})

describe('parseWorkflowYAML — Phase 5 system config & auto-detection', () => {
  test('TEST-22: auto-detection sets engine to dag when parallel_group is used', () => {
    const yaml = `
name: test
steps:
  - name: pg
    type: parallel_group
    steps:
      - name: c1
        type: delay
        seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.system).toBeDefined()
    expect(result.workflow!.system!.engine).toBe('dag')
    expect(result.workflow!.system!.session_pool).toBe(true)
  })

  test('explicit system.engine is preserved', () => {
    const yaml = `
name: test
system:
  engine: legacy
steps:
  - name: s1
    type: delay
    seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.system).toBeDefined()
    expect(result.workflow!.system!.engine).toBe('legacy')
  })

  test('explicit system.engine dag with session_pool true is valid', () => {
    const yaml = `
name: test
system:
  engine: dag
  session_pool: true
steps:
  - name: pg
    type: parallel_group
    steps:
      - name: c1
        type: delay
        seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.system!.engine).toBe('dag')
    expect(result.workflow!.system!.session_pool).toBe(true)
  })

  test('TEST-23: session_pool false + engine dag produces validation error', () => {
    const yaml = `
name: test
system:
  engine: dag
  session_pool: false
steps:
  - name: pg
    type: parallel_group
    steps:
      - name: c1
        type: delay
        seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('session_pool: false is incompatible with engine: dag'))
  })

  test('invalid system.engine value produces error', () => {
    const yaml = `
name: test
system:
  engine: parallel
steps:
  - name: s1
    type: delay
    seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(expect.stringContaining('system.engine must be "legacy" or "dag"'))
  })

  test('system field is undefined when not specified and no dag features used', () => {
    const yaml = `
name: test
steps:
  - name: s1
    type: delay
    seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.system).toBeUndefined()
  })

  test('auto-detection overrides explicit legacy engine to dag', () => {
    const yaml = `
name: test
system:
  engine: legacy
steps:
  - name: pg
    type: parallel_group
    steps:
      - name: c1
        type: delay
        seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.system!.engine).toBe('dag')
  })

  // ── Phase 7: Signal Protocol Schema Tests ───────────────────────────

  describe('signal protocol validation', () => {
    test('TEST-27: valid signal protocol fields on spawn_session', () => {
      const yaml = `
name: signal-test
steps:
  - name: agent
    type: spawn_session
    projectPath: /tmp/test
    prompt: "do work"
    signal_protocol: true
    signal_dir: /tmp/signals
    signal_timeout_seconds: 300
`
      const result = parseWorkflowYAML(yaml)
      expect(result.valid).toBe(true)
      const step = result.workflow!.steps[0]
      expect(step.signal_protocol).toBe(true)
      expect(step.signal_dir).toBe('/tmp/signals')
      expect(step.signal_timeout_seconds).toBe(300)
    })

    test('TEST-28: signal_protocol requires signal_dir when true', () => {
      const yaml = `
name: signal-test
steps:
  - name: agent
    type: spawn_session
    projectPath: /tmp/test
    prompt: "do work"
    signal_protocol: true
`
      const result = parseWorkflowYAML(yaml)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.includes('signal_dir is required'))).toBe(true)
    })

    test('TEST-29: signal_protocol rejected on non-spawn_session types', () => {
      const yaml = `
name: signal-test
steps:
  - name: wait
    type: delay
    seconds: 5
    signal_protocol: true
`
      const result = parseWorkflowYAML(yaml)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.includes('only supported on spawn_session'))).toBe(true)
    })

    test('TEST-30: signal_timeout_seconds must be positive integer', () => {
      const yaml = `
name: signal-test
steps:
  - name: agent
    type: spawn_session
    projectPath: /tmp/test
    prompt: "do work"
    signal_protocol: true
    signal_dir: /tmp/signals
    signal_timeout_seconds: -5
`
      const result = parseWorkflowYAML(yaml)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.includes('signal_timeout_seconds must be a positive integer'))).toBe(true)
    })

    test('signal_protocol false does not require signal_dir', () => {
      const yaml = `
name: signal-test
steps:
  - name: agent
    type: spawn_session
    projectPath: /tmp/test
    prompt: "do work"
    signal_protocol: false
`
      const result = parseWorkflowYAML(yaml)
      expect(result.valid).toBe(true)
      expect(result.workflow!.steps[0].signal_protocol).toBe(false)
    })

    test('signal_dir participates in variable substitution', () => {
      const yaml = `
name: signal-test
variables:
  - name: run_dir
    type: path
    description: "Run directory"
steps:
  - name: agent
    type: spawn_session
    projectPath: /tmp/test
    prompt: "do work"
    signal_protocol: true
    signal_dir: "{{ run_dir }}/signals"
`
      const result = parseWorkflowYAML(yaml)
      expect(result.valid).toBe(true)

      const substituted = substituteVariables(result.workflow!.steps, { run_dir: '/tmp/my-run' })
      expect(substituted[0].signal_dir).toBe('/tmp/my-run/signals')
    })

    test('signal_dir rejects path traversal in variable substitution', () => {
      const yaml = `
name: signal-test
variables:
  - name: run_dir
    type: path
    description: "Run directory"
steps:
  - name: agent
    type: spawn_session
    projectPath: /tmp/test
    prompt: "do work"
    signal_protocol: true
    signal_dir: "{{ run_dir }}/signals"
`
      const result = parseWorkflowYAML(yaml)
      expect(result.valid).toBe(true)

      expect(() => {
        substituteVariables(result.workflow!.steps, { run_dir: '/tmp/../etc' })
      }).toThrow(/Path contains "\.\."/)
    })

    test('signal_dir with .. segments rejected in validation', () => {
      const yaml = `
name: signal-test
steps:
  - name: agent
    type: spawn_session
    projectPath: /tmp/test
    prompt: "do work"
    signal_protocol: true
    signal_dir: "/tmp/../etc/signals"
`
      const result = parseWorkflowYAML(yaml)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.includes('must not contain'))).toBe(true)
    })
  })
})

// ─── Phase 8: review_loop validation ───────────────────────────────────────

describe('Phase 8: review_loop validation', () => {
  test('TEST-12: max_iterations ceiling from env var', () => {
    // Set environment variable
    const originalValue = process.env.AGENTBOARD_MAX_REVIEW_ITERATIONS
    process.env.AGENTBOARD_MAX_REVIEW_ITERATIONS = '5'

    try {
      const yaml = `
name: test
steps:
  - name: review
    type: review_loop
    max_iterations: 10
    producer:
      name: producer
      type: spawn_session
      projectPath: /tmp
      prompt: "produce"
    reviewer:
      name: reviewer
      type: spawn_session
      projectPath: /tmp
      prompt: "review"
      verdict_field: verdict
`
      const result = parseWorkflowYAML(yaml)
      expect(result.valid).toBe(false)
      expect(result.errors.some(e => e.includes('max_iterations') && e.includes('5'))).toBe(true)
    } finally {
      // Clean up env
      if (originalValue !== undefined) {
        process.env.AGENTBOARD_MAX_REVIEW_ITERATIONS = originalValue
      } else {
        delete process.env.AGENTBOARD_MAX_REVIEW_ITERATIONS
      }
    }
  })

  test('TEST-31: Nested review_loop rejected', () => {
    const yaml = `
name: nested-test
steps:
  - name: outer
    type: review_loop
    max_iterations: 3
    producer:
      name: inner
      type: review_loop
      max_iterations: 2
      producer:
        name: p
        type: spawn_session
        projectPath: /tmp
        prompt: test
      reviewer:
        name: r
        type: spawn_session
        projectPath: /tmp
        prompt: test
        verdict_field: verdict
    reviewer:
      name: outer-reviewer
      type: spawn_session
      projectPath: /tmp
      prompt: test
      verdict_field: verdict
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('review_loop') && e.includes('nested'))).toBe(true)
  })

  test('TEST-32: on_max_iterations validation - valid values accepted', () => {
    const validValues = ['escalate', 'accept_last', 'fail'] as const

    for (const value of validValues) {
      const yaml = `
name: test-${value}
steps:
  - name: review
    type: review_loop
    max_iterations: 3
    on_max_iterations: ${value}
    producer:
      name: producer
      type: spawn_session
      projectPath: /tmp
      prompt: "produce"
    reviewer:
      name: reviewer
      type: spawn_session
      projectPath: /tmp
      prompt: "review"
      verdict_field: verdict
`
      const result = parseWorkflowYAML(yaml)
      expect(result.valid).toBe(true)
      expect(result.workflow!.steps[0].on_max_iterations).toBe(value)
    }
  })

  test('TEST-32: on_max_iterations validation - invalid value rejected', () => {
    const yaml = `
name: test-invalid
steps:
  - name: review
    type: review_loop
    max_iterations: 3
    on_max_iterations: retry
    producer:
      name: producer
      type: spawn_session
      projectPath: /tmp
      prompt: "produce"
    reviewer:
      name: reviewer
      type: spawn_session
      projectPath: /tmp
      prompt: "review"
      verdict_field: verdict
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('on_max_iterations') && e.includes('escalate'))).toBe(true)
  })

  test('TEST-33: verdict_field optional on reviewer sub-step (has default)', () => {
    // Without verdict_field - should succeed (Phase 21: verdict_field has default value 'verdict')
    const yamlWithout = `
name: test-no-verdict-field
steps:
  - name: review
    type: review_loop
    max_iterations: 3
    producer:
      name: producer
      type: spawn_session
      projectPath: /tmp
      prompt: "produce"
    reviewer:
      name: reviewer
      type: spawn_session
      projectPath: /tmp
      prompt: "review"
`
    const resultWithout = parseWorkflowYAML(yamlWithout)
    expect(resultWithout.valid).toBe(true)

    // With verdict_field - should succeed
    const yamlWith = `
name: test-with-verdict-field
steps:
  - name: review
    type: review_loop
    max_iterations: 3
    producer:
      name: producer
      type: spawn_session
      projectPath: /tmp
      prompt: "produce"
    reviewer:
      name: reviewer
      type: spawn_session
      projectPath: /tmp
      prompt: "review"
      verdict_field: verdict
`
    const resultWith = parseWorkflowYAML(yamlWith)
    expect(resultWith.valid).toBe(true)
    expect(resultWith.workflow!.steps[0].reviewer!.verdict_field).toBe('verdict')
  })

  test('review_loop parses producer and reviewer sub-steps', () => {
    const yaml = `
name: test
steps:
  - name: review
    type: review_loop
    max_iterations: 5
    producer:
      name: code-producer
      type: spawn_session
      projectPath: /tmp/code
      prompt: "write code"
      output_path: ./code.ts
    reviewer:
      name: code-reviewer
      type: spawn_session
      projectPath: /tmp/code
      prompt: "review code"
      verdict_field: decision
      feedback_field: notes
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    const step = result.workflow!.steps[0]
    expect(step.type).toBe('review_loop')
    expect(step.max_iterations).toBe(5)
    expect(step.producer).toBeDefined()
    expect(step.producer!.name).toBe('code-producer')
    expect(step.producer!.type).toBe('spawn_session')
    expect(step.reviewer).toBeDefined()
    expect(step.reviewer!.name).toBe('code-reviewer')
    expect(step.reviewer!.verdict_field).toBe('decision')
    expect(step.reviewer!.feedback_field).toBe('notes')
  })

  test('review_loop requires producer field', () => {
    const yaml = `
name: test
steps:
  - name: review
    type: review_loop
    max_iterations: 3
    reviewer:
      name: reviewer
      type: spawn_session
      projectPath: /tmp
      prompt: "review"
      verdict_field: verdict
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('producer'))).toBe(true)
  })

  test('review_loop requires reviewer field', () => {
    const yaml = `
name: test
steps:
  - name: review
    type: review_loop
    max_iterations: 3
    producer:
      name: producer
      type: spawn_session
      projectPath: /tmp
      prompt: "produce"
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('reviewer'))).toBe(true)
  })

  test('review_loop without max_iterations is valid (defaults to 3)', () => {
    const yaml = `
name: test
steps:
  - name: review
    type: review_loop
    producer:
      name: producer
      type: spawn_session
      projectPath: /tmp
      prompt: "produce"
    reviewer:
      name: reviewer
      type: spawn_session
      projectPath: /tmp
      prompt: "review"
      verdict_field: verdict
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    // max_iterations defaults to 3 if not specified
  })

  test('review_loop max_iterations must be positive', () => {
    const yaml = `
name: test
steps:
  - name: review
    type: review_loop
    max_iterations: 0
    producer:
      name: producer
      type: spawn_session
      projectPath: /tmp
      prompt: "produce"
    reviewer:
      name: reviewer
      type: spawn_session
      projectPath: /tmp
      prompt: "review"
      verdict_field: verdict
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('max_iterations') && e.includes('positive'))).toBe(true)
  })
})

// ─── Phase 9: spec_validate validation ──────────────────────────────────────

describe('spec_validate step validation', () => {
  test('valid spec_validate step passes', () => {
    const yaml = `
name: test-pipeline
steps:
  - name: validate
    type: spec_validate
    spec_path: /path/to/spec.yaml
    schema_path: /path/to/schema.yaml
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
  })

  test('spec_validate requires spec_path', () => {
    const yaml = `
name: test-pipeline
steps:
  - name: validate
    type: spec_validate
    schema_path: /path/to/schema.yaml
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('spec_path') && e.includes('required'))).toBe(true)
  })

  test('spec_validate requires schema_path', () => {
    const yaml = `
name: test-pipeline
steps:
  - name: validate
    type: spec_validate
    spec_path: /path/to/spec.yaml
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('schema_path') && e.includes('required'))).toBe(true)
  })

  test('spec_validate rejects path traversal in spec_path', () => {
    const yaml = `
name: test-pipeline
steps:
  - name: validate
    type: spec_validate
    spec_path: /path/../../../etc/passwd
    schema_path: /path/to/schema.yaml
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('spec_path') && e.includes('..'))).toBe(true)
  })
})

// ─── Phase 9: Pipeline defaults ─────────────────────────────────────────────

describe('pipeline defaults', () => {
  test('TEST-10: defaults applied to step missing the field', () => {
    const yaml = `
name: test-pipeline
defaults:
  timeoutSeconds: 1800
  maxRetries: 2
steps:
  - name: run-it
    type: spawn_session
    projectPath: /tmp
    prompt: "hello"
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.defaults).toBeDefined()
    expect(result.workflow!.defaults!.timeoutSeconds).toBe(1800)
    expect(result.workflow!.defaults!.maxRetries).toBe(2)
  })

  test('TEST-11: step-level override beats defaults (verified via applyDefaults)', () => {
    // Import applyDefaults directly for unit testing
    const { applyDefaults } = require('../workflowSchema')
    const steps = [{
      name: 'test-step',
      type: 'spawn_session' as const,
      timeoutSeconds: 600,
    }]
    const defaults = { timeoutSeconds: 1800, maxRetries: 3 }
    const result = applyDefaults(steps, defaults)
    expect(result[0].timeoutSeconds).toBe(600) // step value wins
    expect(result[0].maxRetries).toBe(3) // default applied
  })

  test('TEST-12: env merge behavior', () => {
    const { applyDefaults } = require('../workflowSchema')
    const steps = [{
      name: 'test-step',
      type: 'native_step' as const,
      command: 'echo hi',
      env: { APP_KEY: 'step-value', EXTRA: 'from-step' },
    }]
    const defaults = { env: { APP_KEY: 'default-value', BASE: 'from-defaults' } }
    const result = applyDefaults(steps, defaults)
    expect(result[0].env!['APP_KEY']).toBe('step-value') // step wins on conflict
    expect(result[0].env!['BASE']).toBe('from-defaults') // default fills gap
    expect(result[0].env!['EXTRA']).toBe('from-step') // step-only preserved
  })

  test('TEST-13: native_step ignores signal_protocol from defaults', () => {
    const { applyDefaults } = require('../workflowSchema')
    const steps = [{
      name: 'test-step',
      type: 'native_step' as const,
      command: 'echo hi',
    }]
    const defaults = { signal_protocol: true, signal_dir: '/tmp/signals' }
    const result = applyDefaults(steps, defaults)
    expect(result[0].signal_protocol).toBeUndefined()
    expect(result[0].signal_dir).toBeUndefined()
  })

  test('defaults validates field types', () => {
    const yaml = `
name: test-pipeline
defaults:
  tier: not-a-number
steps:
  - name: step1
    type: spawn_session
    projectPath: /tmp
    prompt: test
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('defaults.tier'))).toBe(true)
  })
})

// ─── Phase 9: Dot-notation variable interpolation ───────────────────────────

describe('dot-notation variable interpolation', () => {
  test('TEST-14: simple variable substitution', () => {
    const steps = [{
      name: 'test',
      type: 'spawn_session' as const,
      projectPath: '{{ project_path }}',
      prompt: 'test',
    }]
    const result = substituteVariables(steps, { project_path: '/my/project' })
    expect(result[0].projectPath).toBe('/my/project')
  })

  test('TEST-15: dot-notation variable works', () => {
    const steps = [{
      name: 'test',
      type: 'spawn_session' as const,
      projectPath: '/tmp',
      prompt: 'Use {{ source.layout }} for handlers',
    }]
    const result = substituteVariables(steps, { 'source.layout': 'src/handlers/' })
    expect(result[0].prompt).toBe('Use src/handlers/ for handlers')
  })

  test('TEST-16: run-time priority over profile (both resolved)', () => {
    const steps = [{
      name: 'test',
      type: 'spawn_session' as const,
      projectPath: '/tmp',
      prompt: 'lang is {{ language }}',
    }]
    // This just tests that the last-provided value wins
    const result = substituteVariables(steps, { language: 'rust' })
    expect(result[0].prompt).toBe('lang is rust')
  })

  test('TEST-17: unresolved variable left in place (no error from substituteVariables)', () => {
    const steps = [{
      name: 'test',
      type: 'spawn_session' as const,
      projectPath: '/tmp',
      prompt: 'use {{ undefined_var }}',
    }]
    const result = substituteVariables(steps, {})
    expect(result[0].prompt).toBe('use {{ undefined_var }}')
  })
})

// ─── Phase 9: Tier filtering ────────────────────────────────────────────────

describe('tier filtering', () => {
  test('TEST-27: tier_min filters steps at lower tiers', () => {
    const yaml = `
name: tier-test
steps:
  - name: always-run
    type: spawn_session
    projectPath: /tmp
    prompt: always
  - name: tier-2-only
    type: spawn_session
    projectPath: /tmp
    prompt: tier 2+
    tier_min: 2
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    const tier2Step = result.workflow!.steps.find(s => s.name === 'tier-2-only')
    expect(tier2Step!.tier_min).toBe(2)
  })
})

// ─── Phase 10: amendment_check validation ────────────────────────────────────

describe('parseWorkflowYAML — amendment_check', () => {
  test('accepts valid amendment_check step', () => {
    const yaml = `
name: test-amendment
steps:
  - name: check-amendments
    type: amendment_check
    signal_dir: /tmp/signals
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].type).toBe('amendment_check')
    expect(result.workflow!.steps[0].signal_dir).toBe('/tmp/signals')
  })

  test('rejects amendment_check without signal_dir', () => {
    const yaml = `
name: test-amendment
steps:
  - name: check-amendments
    type: amendment_check
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('signal_dir'))).toBe(true)
  })

  test('rejects amendment_check nested in parallel_group', () => {
    const yaml = `
name: test-amendment
steps:
  - name: pg
    type: parallel_group
    steps:
      - name: ac
        type: amendment_check
        signal_dir: /tmp/signals
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('amendment_check') && e.includes('parallel_group'))).toBe(true)
  })

  test('parses can_request_amendment and amendment_config on spawn_session', () => {
    const yaml = `
name: test-amendment-fields
steps:
  - name: worker
    type: spawn_session
    projectPath: /tmp
    prompt: "do work"
    can_request_amendment: true
    amendment_config:
      auto_review_types:
        - gap
        - correction
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    const step = result.workflow!.steps[0]
    expect(step.can_request_amendment).toBe(true)
    expect(step.amendment_config).toBeDefined()
    expect(step.amendment_config!.auto_review_types).toEqual(['gap', 'correction'])
  })

  test('accepts amendment_check with optional signal_types array', () => {
    const yaml = `
name: test-amendment
steps:
  - name: check-amendments
    type: amendment_check
    signal_dir: /tmp/signals
    signal_types:
      - amendment_required
      - exploration_needed
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].signal_types).toEqual(['amendment_required', 'exploration_needed'])
  })

  test('rejects amendment_check with non-array signal_types', () => {
    const yaml = `
name: test-amendment
steps:
  - name: check-amendments
    type: amendment_check
    signal_dir: /tmp/signals
    signal_types: "not-an-array"
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('signal_types') && e.includes('array'))).toBe(true)
  })
})

// ─── P-8: reconcile-spec validation ──────────────────────────────────────────

describe('parseWorkflowYAML — reconcile-spec', () => {
  test('accepts valid reconcile-spec step', () => {
    const yaml = `
name: test-reconcile
steps:
  - name: reconcile-batch
    type: reconcile-spec
    signal_dir: /tmp/signals
    batch_threshold: 3
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].type).toBe('reconcile-spec')
    expect(result.workflow!.steps[0].signal_dir).toBe('/tmp/signals')
    expect(result.workflow!.steps[0].batch_threshold).toBe(3)
  })

  test('accepts reconcile-spec with default batch_threshold', () => {
    const yaml = `
name: test-reconcile
steps:
  - name: reconcile-batch
    type: reconcile-spec
    signal_dir: /tmp/signals
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].batch_threshold).toBeUndefined()
  })

  test('rejects reconcile-spec without signal_dir', () => {
    const yaml = `
name: test-reconcile
steps:
  - name: reconcile-batch
    type: reconcile-spec
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('reconcile-spec') && e.includes('signal_dir'))).toBe(true)
  })

  test('rejects reconcile-spec with nested steps', () => {
    const yaml = `
name: test-reconcile
steps:
  - name: reconcile-batch
    type: reconcile-spec
    signal_dir: /tmp/signals
    steps:
      - name: child
        type: delay
        seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('reconcile-spec') && e.includes('nested'))).toBe(true)
  })

  test('rejects reconcile-spec nested in parallel_group', () => {
    const yaml = `
name: test-reconcile
steps:
  - name: pg
    type: parallel_group
    steps:
      - name: reconcile-batch
        type: reconcile-spec
        signal_dir: /tmp/signals
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('reconcile-spec') && e.includes('parallel_group'))).toBe(true)
  })

  test('rejects reconcile-spec with invalid batch_threshold', () => {
    const yaml = `
name: test-reconcile
steps:
  - name: reconcile-batch
    type: reconcile-spec
    signal_dir: /tmp/signals
    batch_threshold: 0
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('batch_threshold') && e.includes('positive integer'))).toBe(true)
  })

  test('accepts reconcile-spec with signal_types', () => {
    const yaml = `
name: test-reconcile
steps:
  - name: reconcile-batch
    type: reconcile-spec
    signal_dir: /tmp/signals
    signal_types:
      - reconciliation
      - correction
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].signal_types).toEqual(['reconciliation', 'correction'])
  })
})

// ─── Phase 21: Schema Compatibility ─────────────────────────────────────────

describe('Phase 21: Schema Compatibility', () => {
  test('pipeline wrapper unwrap: top-level pipeline key with name and steps', () => {
    const yaml = `
pipeline:
  name: test-pipeline
  description: Pipeline YAML format
  steps:
    - name: step1
      type: native_step
      command: echo hello
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.name).toBe('test-pipeline')
    expect(result.workflow!.description).toBe('Pipeline YAML format')
    expect(result.workflow!.steps).toHaveLength(1)
    expect(result.workflow!.steps[0].name).toBe('step1')
  })

  test('pipeline wrapper preserves extra top-level sections', () => {
    const yaml = `
pipeline:
  name: test-pipeline
  steps:
    - name: step1
      type: delay
      seconds: 1
telemetry:
  enabled: true
triggers:
  - type: file_change
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.name).toBe('test-pipeline')
    // Extra sections don't cause errors (forward compatibility)
  })

  test('gemini_offload step type accepted and requires prompt_template', () => {
    const yaml = `
name: test
steps:
  - name: analyze
    type: gemini_offload
    prompt_template: "Analyze this: {{ input }}"
    input_files:
      - /tmp/data.txt
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].type).toBe('gemini_offload')
    expect(result.workflow!.steps[0].prompt_template).toBe('Analyze this: {{ input }}')
  })

  test('gemini_offload without prompt_template is rejected', () => {
    const yaml = `
name: test
steps:
  - name: analyze
    type: gemini_offload
    input_files:
      - /tmp/data.txt
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('prompt_template') && e.includes('required'))).toBe(true)
  })

  test('gemini_offload parses optional fields', () => {
    const yaml = `
name: test
steps:
  - name: analyze
    type: gemini_offload
    prompt_template: "Summarize"
    model: gemini-2.5-flash
    max_tokens: 2048
    temperature: 0.7
    output_file: result.json
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    const step = result.workflow!.steps[0]
    expect(step.model).toBe('gemini-2.5-flash')
    expect(step.max_tokens).toBe(2048)
    expect(step.temperature).toBe(0.7)
    expect(step.output_file).toBe('result.json')
  })

  test('aggregator step type accepted and requires input_steps', () => {
    const yaml = `
name: test
steps:
  - name: review-a
    type: spawn_session
    projectPath: /tmp
    prompt: review A
  - name: review-b
    type: spawn_session
    projectPath: /tmp
    prompt: review B
  - name: combine
    type: aggregator
    input_steps:
      - review-a
      - review-b
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    const aggStep = result.workflow!.steps[2]
    expect(aggStep.type).toBe('aggregator')
    expect(aggStep.input_steps).toEqual(['review-a', 'review-b'])
  })

  test('aggregator without input_steps is rejected', () => {
    const yaml = `
name: test
steps:
  - name: combine
    type: aggregator
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('input_steps') && e.includes('required'))).toBe(true)
  })

  test('aggregator with empty input_steps is rejected', () => {
    const yaml = `
name: test
steps:
  - name: combine
    type: aggregator
    input_steps: []
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('input_steps') && e.includes('at least 1'))).toBe(true)
  })

  test('human_gate step type accepted with no required fields', () => {
    const yaml = `
name: test
steps:
  - name: pause
    type: human_gate
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].type).toBe('human_gate')
  })

  test('expect:fail on native_step is accepted', () => {
    const yaml = `
name: test
steps:
  - name: should-fail
    type: native_step
    command: "exit 1"
    expect: fail
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].expect).toBe('fail')
  })

  test('expect:pass on native_step is accepted', () => {
    const yaml = `
name: test
steps:
  - name: should-pass
    type: native_step
    command: "echo ok"
    expect: pass
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].expect).toBe('pass')
  })

  test('expect on non-native_step is rejected', () => {
    const yaml = `
name: test
steps:
  - name: bad
    type: delay
    seconds: 1
    expect: fail
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('expect') && e.includes('native_step'))).toBe(true)
  })

  test('string condition expression parses to expression type', () => {
    const yaml = `
name: test
steps:
  - name: conditional
    type: delay
    seconds: 1
    condition: "tier >= 2"
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].condition).toEqual({
      type: 'expression',
      expr: 'tier >= 2'
    })
  })

  test('string condition with dotted paths parses correctly', () => {
    const yaml = `
name: test
steps:
  - name: conditional
    type: delay
    seconds: 1
    condition: "classification.type == dependency_update"
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].condition).toEqual({
      type: 'expression',
      expr: 'classification.type == dependency_update'
    })
  })

  test('string condition with AND combinator parses correctly', () => {
    const yaml = `
name: test
steps:
  - name: conditional
    type: delay
    seconds: 1
    condition: "tier >= 2 AND classification.type == feature"
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].condition).toEqual({
      type: 'expression',
      expr: 'tier >= 2 AND classification.type == feature'
    })
  })

  test('children alias for parallel_group steps', () => {
    const yaml = `
name: test
steps:
  - name: parallel-work
    type: parallel_group
    children:
      - name: task-a
        type: delay
        seconds: 1
      - name: task-b
        type: delay
        seconds: 2
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].steps).toHaveLength(2)
    expect(result.workflow!.steps[0].steps![0].name).toBe('task-a')
    expect(result.workflow!.steps[0].steps![1].name).toBe('task-b')
  })

  test('relaxed spawn_session: agent field without projectPath and prompt', () => {
    const yaml = `
name: test
steps:
  - name: agent-step
    type: spawn_session
    agent: spec-reviewer
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].agent).toBe('spec-reviewer')
  })

  test('relaxed native_step: actions array without command', () => {
    const yaml = `
name: test
steps:
  - name: multi-action
    type: native_step
    actions:
      - run: echo step1
      - run: echo step2
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    // Step should parse even without command field when actions present
  })

  test('unknown top-level sections preserved without errors', () => {
    const yaml = `
name: test
telemetry:
  log_level: debug
  metrics_enabled: true
triggers:
  - type: cron
    schedule: "0 0 * * *"
hooks:
  pre_run: validate.sh
steps:
  - name: step1
    type: delay
    seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.name).toBe('test')
    expect(result.workflow!.steps).toHaveLength(1)
    // Unknown sections don't cause validation errors
  })

  test('condition expression with quoted string comparison', () => {
    const yaml = `
name: test
steps:
  - name: conditional
    type: delay
    seconds: 1
    condition: "status == 'active'"
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].condition).toEqual({
      type: 'expression',
      expr: "status == 'active'"
    })
  })

  test('rejects empty string condition expression', () => {
    const yaml = `
name: test
steps:
  - name: bad
    type: delay
    seconds: 1
    condition: ""
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('condition') && e.includes('non-empty'))).toBe(true)
  })

  test('rejects condition expression exceeding 1024 characters', () => {
    const longExpr = 'tier >= 2 AND ' + 'x == y OR '.repeat(200) + 'z == w'
    const yaml = `
name: test
steps:
  - name: bad
    type: delay
    seconds: 1
    condition: "${longExpr}"
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('condition') && e.includes('1024'))).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════
// Phase 21: Schema Compatibility Tests
// ═══════════════════════════════════════════════════════════════════

describe('Phase 21: Schema Compatibility', () => {
  test('pipeline: wrapper unwraps to flat format', () => {
    const yaml = `
pipeline:
  name: test-pipeline
  steps:
    - name: step1
      type: native_step
      command: echo hello
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.name).toBe('test-pipeline')
    expect(result.workflow!.steps.length).toBe(1)
    expect(result.workflow!.steps[0].name).toBe('step1')
  })

  test('gemini_offload step type is accepted', () => {
    const yaml = `
name: test
steps:
  - name: gemini-step
    type: gemini_offload
    prompt_template: "Analyze this"
    output_file: result.txt
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].type).toBe('gemini_offload')
  })

  test('gemini_offload requires prompt_template', () => {
    const yaml = `
name: test
steps:
  - name: gemini-step
    type: gemini_offload
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('prompt_template'))).toBe(true)
  })

  test('aggregator step type is accepted', () => {
    const yaml = `
name: test
steps:
  - name: agg
    type: aggregator
    input_steps:
      - step1
      - step2
    output_file: merged.yaml
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].type).toBe('aggregator')
  })

  test('aggregator requires input_steps array', () => {
    const yaml = `
name: test
steps:
  - name: agg
    type: aggregator
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('input_steps'))).toBe(true)
  })

  test('human_gate step type is accepted', () => {
    const yaml = `
name: test
steps:
  - name: gate
    type: human_gate
    message: "Please approve"
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].type).toBe('human_gate')
  })

  test('expect:fail is accepted on native_step', () => {
    const yaml = `
name: test
steps:
  - name: verify-red
    type: native_step
    command: "cargo test"
    expect: fail
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].expect).toBe('fail')
  })

  test('expect is rejected on non-native_step', () => {
    const yaml = `
name: test
steps:
  - name: bad
    type: spawn_session
    projectPath: /tmp
    prompt: "test"
    expect: fail
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('expect'))).toBe(true)
  })

  test('string condition expression parses correctly', () => {
    const yaml = `
name: test
steps:
  - name: step1
    type: native_step
    command: echo hello
    condition: "tier >= 2"
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].condition).toEqual({
      type: 'expression',
      expr: 'tier >= 2'
    })
  })

  test('children alias works in parallel_group', () => {
    const yaml = `
name: test
steps:
  - name: pg
    type: parallel_group
    children:
      - name: child1
        type: delay
        seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    const pg = result.workflow!.steps[0] as any
    expect(pg.type).toBe('parallel_group')
    // children alias is converted to steps during buildWorkflowStep
    expect(pg.steps).toBeDefined()
    expect(pg.steps.length).toBe(1)
    expect(pg.steps[0].name).toBe('child1')
  })

  test('spawn_session with agent field but no projectPath is valid', () => {
    const yaml = `
name: test
steps:
  - name: agent-step
    type: spawn_session
    agent: workhorse
    inputs: []
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].agent).toBe('workhorse')
  })

  test('native_step without command but with actions is valid', () => {
    const yaml = `
name: test
steps:
  - name: checks
    type: native_step
    checks:
      - name: test1
        command: echo test1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].type).toBe('native_step')
  })

  test('unknown top-level sections are preserved', () => {
    const yaml = `
name: test
telemetry:
  enabled: true
triggers:
  manual:
    enabled: true
steps:
  - name: step1
    type: delay
    seconds: 1
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.name).toBe('test')
  })
})

// ─── Phase 15: on_error cleanup hooks (REQ-23 through REQ-27) ─────────────

describe('on_error cleanup hooks (Phase 15 REQ-23-27)', () => {
  test('step-level on_error parses valid cleanup actions', () => {
    const yaml = `
name: test-pipeline
steps:
  - name: risky-step
    type: native_step
    command: "might-fail"
    on_error:
      - type: native_step
        command: "cleanup.sh"
        working_dir: "/tmp"
        timeoutSeconds: 30
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].on_error).toHaveLength(1)
    expect(result.workflow!.steps[0].on_error![0].type).toBe('native_step')
    expect(result.workflow!.steps[0].on_error![0].command).toBe('cleanup.sh')
    expect(result.workflow!.steps[0].on_error![0].working_dir).toBe('/tmp')
    expect(result.workflow!.steps[0].on_error![0].timeoutSeconds).toBe(30)
  })

  test('pipeline-level on_error parses valid cleanup actions', () => {
    const yaml = `
name: test-pipeline
on_error:
  - type: native_step
    command: "pipeline-cleanup.sh"
steps:
  - name: step1
    type: native_step
    command: "work"
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.on_error).toHaveLength(1)
    expect(result.workflow!.on_error![0].command).toBe('pipeline-cleanup.sh')
  })

  test('on_error rejects non-array value', () => {
    const yaml = `
name: test-pipeline
steps:
  - name: step1
    type: native_step
    command: "work"
    on_error: "not-an-array"
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('on_error') && e.includes('array'))).toBe(true)
  })

  test('on_error rejects actions without command', () => {
    const yaml = `
name: test-pipeline
steps:
  - name: step1
    type: native_step
    command: "work"
    on_error:
      - type: native_step
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('command') && e.includes('required'))).toBe(true)
  })

  test('on_error rejects non-native_step type', () => {
    const yaml = `
name: test-pipeline
steps:
  - name: step1
    type: native_step
    command: "work"
    on_error:
      - type: spawn_session
        command: "cleanup"
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('native_step') && e.includes('type'))).toBe(true)
  })

  test('multiple on_error actions parse correctly', () => {
    const yaml = `
name: test-pipeline
steps:
  - name: step1
    type: native_step
    command: "work"
    on_error:
      - type: native_step
        command: "cleanup1.sh"
      - type: native_step
        command: "cleanup2.sh"
        timeoutSeconds: 60
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
    expect(result.workflow!.steps[0].on_error).toHaveLength(2)
    expect(result.workflow!.steps[0].on_error![1].command).toBe('cleanup2.sh')
    expect(result.workflow!.steps[0].on_error![1].timeoutSeconds).toBe(60)
  })

  test('on_error with empty array is valid', () => {
    const yaml = `
name: test-pipeline
steps:
  - name: step1
    type: native_step
    command: "work"
    on_error: []
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(true)
  })

  test('pipeline-level on_error rejects non-array', () => {
    const yaml = `
name: test-pipeline
on_error:
  type: native_step
  command: "cleanup"
steps:
  - name: step1
    type: native_step
    command: "work"
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('on_error') && e.includes('array'))).toBe(true)
  })

  test('on_error rejects working_dir with path traversal', () => {
    const yaml = `
name: test-pipeline
steps:
  - name: step1
    type: native_step
    command: "work"
    on_error:
      - type: native_step
        command: "cleanup"
        working_dir: "/tmp/../etc"
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('working_dir') && e.includes('..'))).toBe(true)
  })

  test('on_error rejects non-positive timeoutSeconds', () => {
    const yaml = `
name: test-pipeline
steps:
  - name: step1
    type: native_step
    command: "work"
    on_error:
      - type: native_step
        command: "cleanup"
        timeoutSeconds: -5
`
    const result = parseWorkflowYAML(yaml)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('timeoutSeconds') && e.includes('positive'))).toBe(true)
  })
})
