/**
 * workflowSchema.ts — YAML workflow parsing and validation (WO-003)
 *
 * Parses YAML workflow definitions and validates their structure against
 * the workflow schema. Returns structured validation results with
 * accumulated error arrays (never throws on invalid input).
 */

import yaml from 'js-yaml'
import type {
  WorkflowStep,
  WorkflowStepType,
  StepCondition,
  WorkflowVariable,
  WorkflowVariableType,
} from '@shared/types'

// ─── Public Types ───────────────────────────────────────────────────────────

/** Result of parsing and validating a workflow YAML string. */
export interface ValidationResult {
  valid: boolean
  workflow?: ParsedWorkflow
  errors: string[]
}

/** Parsed workflow structure (before DB persistence). */
export interface ParsedWorkflow {
  name: string
  description: string | null
  steps: WorkflowStep[]
  variables: WorkflowVariable[]
}

// ─── Constants ──────────────────────────────────────────────────────────────

const VALID_STEP_TYPES: ReadonlySet<string> = new Set<WorkflowStepType>([
  'spawn_session',
  'check_file',
  'delay',
  'check_output',
])

const VALID_CONDITION_TYPES: ReadonlySet<string> = new Set([
  'file_exists',
  'output_contains',
])

const MAX_VALIDATION_ERRORS = 100

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Parse a YAML string into a validated workflow definition.
 *
 * - YAML syntax errors are caught and returned in errors[]
 * - All validation errors are accumulated (not fail-fast)
 * - !! tags are stripped for security (prototype pollution prevention)
 */
export function parseWorkflowYAML(yamlContent: string): ValidationResult {
  const errors: string[] = []

  // Handle empty / whitespace-only input
  if (!yamlContent || yamlContent.trim().length === 0) {
    return { valid: false, errors: ['YAML content is empty'] }
  }

  // Parse YAML (safe schema strips !! tags — YAML-SECURITY-001)
  let raw: unknown
  try {
    raw = yaml.load(yamlContent, { schema: yaml.FAILSAFE_SCHEMA })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { valid: false, errors: [`YAML syntax error: ${msg}`] }
  }

  // Must parse to an object
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['YAML must parse to an object (got ' + typeLabel(raw) + ')'] }
  }

  const doc = raw as Record<string, unknown>

  // ── Top-level field validation ──────────────────────────────────────────

  // name — required, non-empty string
  if (!hasStringField(doc, 'name')) {
    errors.push('name is required (non-empty string)')
  } else if ((doc.name as string).trim().length === 0) {
    errors.push('name must be a non-empty string')
  }

  // steps — required, non-empty array
  if (!('steps' in doc)) {
    errors.push('steps is required (non-empty array)')
  } else if (!Array.isArray(doc.steps)) {
    errors.push('steps must be an array')
  } else if (doc.steps.length === 0) {
    errors.push('steps must contain at least 1 step')
  }

  // If we can't proceed with steps validation, return early
  if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
    return { valid: false, errors }
  }

  // ── Variables section (optional) ─────────────────────────────────────
  const parsedVariables: WorkflowVariable[] = []
  if ('variables' in doc && doc.variables !== undefined && doc.variables !== null) {
    if (!Array.isArray(doc.variables)) {
      errors.push('variables must be an array')
    } else if (doc.variables.length > 50) {
      errors.push('Too many variables (max: 50)')
    } else {
      const seenVarNames = new Set<string>()
      for (let i = 0; i < doc.variables.length; i++) {
        const varRaw = doc.variables[i]
        const vPrefix = `variables[${i}]`
        if (varRaw === null || varRaw === undefined || typeof varRaw !== 'object' || Array.isArray(varRaw)) {
          errors.push(`${vPrefix} must be an object`)
          continue
        }
        const v = varRaw as Record<string, unknown>
        // name — required, non-empty, valid identifier format
        if (!hasStringField(v, 'name')) {
          errors.push(`${vPrefix}.name is required (non-empty string)`)
          continue
        }
        const varName = (v.name as string).trim()
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(varName)) {
          errors.push(`${vPrefix}.name "${varName}" must be a valid identifier (letters, digits, underscores)`)
        }
        const RESERVED_VAR_NAMES = new Set(['__proto__', 'constructor', 'prototype'])
        if (RESERVED_VAR_NAMES.has(varName)) {
          errors.push(`${vPrefix}.name "${varName}" is a reserved name`)
        }
        if (seenVarNames.has(varName)) {
          errors.push(`${vPrefix}.name "${varName}" is a duplicate`)
        }
        seenVarNames.add(varName)
        // type — optional, defaults to 'string'
        const validVarTypes = new Set(['string', 'path'])
        let varType: WorkflowVariableType = 'string'
        if (hasStringField(v, 'type')) {
          if (!validVarTypes.has(v.type as string)) {
            errors.push(`${vPrefix}.type "${v.type}" is invalid (must be one of: string, path)`)
          } else {
            varType = v.type as WorkflowVariableType
          }
        }
        // description — optional
        const varDesc = hasStringField(v, 'description') ? (v.description as string).trim() : ''
        // required — optional, defaults to true
        const varRequired = v.required !== undefined ? String(v.required) === 'true' : true
        // default — optional
        const varDefault = hasStringField(v, 'default') ? (v.default as string) : undefined

        if (varDefault !== undefined && varType === 'path') {
          if (varDefault.includes('..')) {
            errors.push(`${vPrefix}.default contains path traversal (..)`)
          }
        }

        parsedVariables.push({
          name: varName,
          type: varType,
          description: varDesc,
          required: varRequired,
          default: varDefault,
        })
      }
    }
  }

  // ── Step-level validation ───────────────────────────────────────────────

  const steps = doc.steps as unknown[]
  const seenNames = new Set<string>()
  const parsedSteps: WorkflowStep[] = []

  for (let i = 0; i < steps.length; i++) {
    const stepRaw = steps[i]
    const prefix = `steps[${i}]`

    if (stepRaw === null || stepRaw === undefined || typeof stepRaw !== 'object' || Array.isArray(stepRaw)) {
      errors.push(`${prefix} must be an object`)
      continue
    }

    const step = stepRaw as Record<string, unknown>

    // step.name — required, non-empty string, unique
    const stepName = validateStepName(step, prefix, i, seenNames, errors)

    // step.type — required, valid enum
    const stepType = validateStepType(step, prefix, errors)

    // Type-specific required fields
    if (stepType) {
      validateTypeSpecificFields(step, stepType, prefix, errors)
    }

    // check_output step reference validation (must reference prior step)
    if (stepType === 'check_output') {
      validateCheckOutputReference(step, prefix, seenNames, errors)
    }

    // Condition validation (optional)
    if ('condition' in step && step.condition !== undefined && step.condition !== null) {
      validateCondition(step.condition, prefix, seenNames, errors)
    }

    // Track seen names (after validation so references only see prior steps)
    if (stepName) {
      seenNames.add(stepName)
    }

    // Build parsed step (best-effort even if some fields invalid)
    parsedSteps.push(buildWorkflowStep(step, stepType))
  }

  // ── Validate {{ var }} references in step fields ─────────────────────────
  if (parsedVariables.length > 0) {
    const definedVarNames = new Set(parsedVariables.map(v => v.name))
    const templateRegex = /\{\{\s*(\w+)\s*\}\}/g
    for (let i = 0; i < parsedSteps.length; i++) {
      const step = parsedSteps[i]
      const prefix = `steps[${i}]`
      const fieldsToCheck: [string, string | undefined][] = [
        ['projectPath', step.projectPath],
        ['prompt', step.prompt],
        ['path', step.path],
        ['output_path', step.output_path],
        ['result_file', step.result_file],
        ['step', step.step],
        ['contains', step.contains],
      ]
      for (const [fieldName, fieldValue] of fieldsToCheck) {
        if (!fieldValue || errors.length >= MAX_VALIDATION_ERRORS) continue
        let match: RegExpExecArray | null
        templateRegex.lastIndex = 0
        while ((match = templateRegex.exec(fieldValue)) !== null) {
          if (!definedVarNames.has(match[1])) {
            errors.push(`${prefix}.${fieldName} references undefined variable "{{ ${match[1]} }}"`)
          }
        }
      }
    }
  }

  // ── Build result ────────────────────────────────────────────────────────

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  const workflow: ParsedWorkflow = {
    name: (doc.name as string).trim(),
    description: hasStringField(doc, 'description') ? (doc.description as string).trim() : null,
    steps: parsedSteps,
    variables: parsedVariables,
  }

  return { valid: true, workflow, errors: [] }
}

// ─── Validation Helpers ─────────────────────────────────────────────────────

function validateStepName(
  step: Record<string, unknown>,
  prefix: string,
  index: number,
  seenNames: Set<string>,
  errors: string[],
): string | null {
  if (!hasStringField(step, 'name')) {
    errors.push(`${prefix}.name is required (non-empty string)`)
    return null
  }

  const name = (step.name as string).trim()
  if (name.length === 0) {
    errors.push(`${prefix}.name must be a non-empty string`)
    return null
  }

  if (name.length > 128) {
    errors.push(`${prefix}.name exceeds maximum length of 128 characters`)
  }

  if (seenNames.has(name)) {
    errors.push(`${prefix}.name "${name}" is a duplicate (step names must be unique)`)
    // Still return the name so we can track it
  }

  return name
}

function validateStepType(
  step: Record<string, unknown>,
  prefix: string,
  errors: string[],
): WorkflowStepType | null {
  if (!hasStringField(step, 'type')) {
    errors.push(`${prefix}.type is required`)
    return null
  }

  const type = step.type as string
  if (!VALID_STEP_TYPES.has(type)) {
    errors.push(
      `${prefix}.type "${type}" is invalid (must be one of: ${[...VALID_STEP_TYPES].join(', ')})`,
    )
    return null
  }

  return type as WorkflowStepType
}

function validateTypeSpecificFields(
  step: Record<string, unknown>,
  type: WorkflowStepType,
  prefix: string,
  errors: string[],
): void {
  // Validate optional common fields (present in any step type)
  if (hasStringField(step, 'output_path')) {
    const outputPath = step.output_path as string
    if (outputPath.length > 4096) {
      errors.push(`${prefix}.output_path exceeds maximum length of 4096 characters`)
    }
    if (outputPath.includes('..')) {
      errors.push(`${prefix}.output_path must not contain '..' segments`)
    }
  }

  if (hasStringField(step, 'result_file')) {
    const resultFile = step.result_file as string
    if (resultFile.length > 4096) {
      errors.push(`${prefix}.result_file exceeds maximum length of 4096 characters`)
    }
    if (resultFile.includes('..')) {
      errors.push(`${prefix}.result_file must not contain '..' segments`)
    }
  }

  if ('timeoutSeconds' in step) {
    const timeout = Number(step.timeoutSeconds)
    if (isNaN(timeout) || timeout <= 0) {
      errors.push(`${prefix}.timeoutSeconds must be a positive integer`)
    } else if (timeout > 86400) {
      errors.push(`${prefix}.timeoutSeconds must not exceed 86400 (24 hours)`)
    } else if (!Number.isInteger(timeout)) {
      errors.push(`${prefix}.timeoutSeconds must be an integer`)
    }
  }

  if ('maxRetries' in step) {
    const retries = Number(step.maxRetries)
    if (isNaN(retries) || retries < 0) {
      errors.push(`${prefix}.maxRetries must be a non-negative integer`)
    } else if (retries > 10) {
      errors.push(`${prefix}.maxRetries must not exceed 10`)
    } else if (!Number.isInteger(retries)) {
      errors.push(`${prefix}.maxRetries must be an integer`)
    }
  }

  // Type-specific field validation
  switch (type) {
    case 'spawn_session':
      if (!hasStringField(step, 'projectPath')) {
        errors.push(`${prefix}.projectPath is required for spawn_session steps`)
      } else {
        const projectPath = step.projectPath as string
        if (projectPath.length > 4096) {
          errors.push(`${prefix}.projectPath exceeds maximum length of 4096 characters`)
        }
      }
      if (!hasStringField(step, 'prompt')) {
        errors.push(`${prefix}.prompt is required for spawn_session steps`)
      } else {
        const prompt = step.prompt as string
        if (prompt.length > 100000) {
          errors.push(`${prefix}.prompt exceeds maximum length of 100000 characters`)
        }
      }
      break

    case 'check_file':
      if (!hasStringField(step, 'path')) {
        errors.push(`${prefix}.path is required for check_file steps`)
      } else {
        const path = step.path as string
        if (path.length > 4096) {
          errors.push(`${prefix}.path exceeds maximum length of 4096 characters`)
        }
      }
      if ('max_age_seconds' in step) {
        const maxAge = Number(step.max_age_seconds)
        if (isNaN(maxAge) || maxAge <= 0) {
          errors.push(`${prefix}.max_age_seconds must be a positive integer`)
        } else if (!Number.isInteger(maxAge)) {
          errors.push(`${prefix}.max_age_seconds must be an integer`)
        }
      }
      break

    case 'delay':
      if (!('seconds' in step)) {
        errors.push(`${prefix}.seconds is required for delay steps`)
      } else {
        const seconds = Number(step.seconds)
        if (isNaN(seconds) || seconds <= 0) {
          errors.push(`${prefix}.seconds must be a number greater than 0`)
        } else if (seconds > 86400) {
          errors.push(`${prefix}.seconds must not exceed 86400 (24 hours)`)
        }
      }
      break

    case 'check_output':
      if (!hasStringField(step, 'step')) {
        errors.push(`${prefix}.step is required for check_output steps`)
      }
      if (!hasStringField(step, 'contains')) {
        errors.push(`${prefix}.contains is required for check_output steps`)
      } else {
        const contains = step.contains as string
        if (contains.length > 10000) {
          errors.push(`${prefix}.contains exceeds maximum length of 10000 characters`)
        }
      }
      break
  }
}

function validateCheckOutputReference(
  step: Record<string, unknown>,
  prefix: string,
  seenNames: Set<string>,
  errors: string[],
): void {
  if (!hasStringField(step, 'step')) return // Already reported as missing

  const ref = step.step as string
  const stepName = hasStringField(step, 'name') ? (step.name as string) : null

  // Cannot reference itself
  if (stepName && ref === stepName) {
    errors.push(`${prefix}.step "${ref}" references itself (must reference a prior step)`)
    return
  }

  // Must reference a prior step
  if (!seenNames.has(ref)) {
    errors.push(
      `${prefix}.step "${ref}" references an unknown or later step (must reference a prior step)`,
    )
  }
}

function validateCondition(
  conditionRaw: unknown,
  prefix: string,
  seenNames: Set<string>,
  errors: string[],
): void {
  if (typeof conditionRaw !== 'object' || conditionRaw === null || Array.isArray(conditionRaw)) {
    errors.push(`${prefix}.condition must be an object`)
    return
  }

  const condition = conditionRaw as Record<string, unknown>

  if (!hasStringField(condition, 'type')) {
    errors.push(`${prefix}.condition.type is required`)
    return
  }

  const condType = condition.type as string

  if (!VALID_CONDITION_TYPES.has(condType)) {
    errors.push(
      `${prefix}.condition.type "${condType}" is invalid (must be one of: ${[...VALID_CONDITION_TYPES].join(', ')})`,
    )
    return
  }

  switch (condType) {
    case 'file_exists':
      if (!hasStringField(condition, 'path')) {
        errors.push(`${prefix}.condition.path is required for file_exists conditions`)
      } else {
        const path = condition.path as string
        if (path.length > 4096) {
          errors.push(`${prefix}.condition.path exceeds maximum length of 4096 characters`)
        }
      }
      break

    case 'output_contains':
      if (!hasStringField(condition, 'step')) {
        errors.push(`${prefix}.condition.step is required for output_contains conditions`)
      } else {
        const ref = condition.step as string
        if (!seenNames.has(ref)) {
          errors.push(
            `${prefix}.condition.step "${ref}" references an unknown or later step`,
          )
        }
      }
      if (!hasStringField(condition, 'contains')) {
        errors.push(`${prefix}.condition.contains is required for output_contains conditions`)
      } else {
        const contains = condition.contains as string
        if (contains.length > 10000) {
          errors.push(`${prefix}.condition.contains exceeds maximum length of 10000 characters`)
        }
      }
      break
  }
}

// ─── Builder Helpers ────────────────────────────────────────────────────────

function buildWorkflowStep(
  step: Record<string, unknown>,
  type: WorkflowStepType | null,
): WorkflowStep {
  const result: WorkflowStep = {
    name: String(step.name ?? ''),
    type: (type ?? 'spawn_session') as WorkflowStepType,
  }

  // Optional common fields
  if (hasStringField(step, 'output_path')) result.output_path = step.output_path as string
  if (hasStringField(step, 'result_file')) result.result_file = step.result_file as string
  if ('timeoutSeconds' in step) result.timeoutSeconds = Number(step.timeoutSeconds)
  if ('maxRetries' in step) result.maxRetries = Number(step.maxRetries)

  // Type-specific fields
  if (hasStringField(step, 'projectPath')) result.projectPath = step.projectPath as string
  if (hasStringField(step, 'prompt')) result.prompt = step.prompt as string
  if (hasStringField(step, 'agentType')) {
    const at = step.agentType as string
    if (at === 'claude' || at === 'codex') {
      result.agentType = at
    }
  }
  if (hasStringField(step, 'path')) result.path = step.path as string
  if ('max_age_seconds' in step) result.max_age_seconds = Number(step.max_age_seconds)
  if ('seconds' in step) result.seconds = Number(step.seconds)
  if (hasStringField(step, 'step')) result.step = step.step as string
  if (hasStringField(step, 'contains')) result.contains = step.contains as string

  // Condition
  if (step.condition && typeof step.condition === 'object' && !Array.isArray(step.condition)) {
    const cond = step.condition as Record<string, unknown>
    if (hasStringField(cond, 'type')) {
      result.condition = buildCondition(cond)
    }
  }

  return result
}

function buildCondition(cond: Record<string, unknown>): StepCondition | undefined {
  const condType = cond.type as string

  switch (condType) {
    case 'file_exists':
      if (hasStringField(cond, 'path')) {
        return { type: 'file_exists', path: cond.path as string }
      }
      break
    case 'output_contains':
      if (hasStringField(cond, 'step') && hasStringField(cond, 'contains')) {
        return {
          type: 'output_contains',
          step: cond.step as string,
          contains: cond.contains as string,
        }
      }
      break
  }
  return undefined
}

// ─── Variable Substitution ───────────────────────────────────────────────────

/**
 * Single-pass regex substitution of {{ var }} placeholders in step string fields.
 * Returns a new array of steps with substituted values (does not mutate input).
 */
export function substituteVariables(
  steps: WorkflowStep[],
  variables: Record<string, string>,
): WorkflowStep[] {
  const regex = /\{\{\s*(\w+)\s*\}\}/g

  // Guard against recursive expansion: reject variable values containing {{ }}
  for (const [key, value] of Object.entries(variables)) {
    if (/\{\{/.test(value)) {
      throw new Error(`Variable "${key}" contains template syntax (recursive expansion not allowed)`)
    }
  }

  function sub(value: string): string {
    return value.replace(regex, (full, name) => {
      return name in variables ? variables[name] : full
    })
  }

  function subPath(value: string): string {
    const result = sub(value)
    // Validate path safety after substitution
    if (result.includes('..')) {
      throw new Error(`Path contains ".." after variable substitution: ${result.slice(0, 200)}`)
    }
    if (result.includes('\0')) {
      throw new Error('Path contains null byte after variable substitution')
    }
    return result
  }

  return steps.map(step => {
    const result: WorkflowStep = { ...step }
    if (result.projectPath) result.projectPath = subPath(result.projectPath)
    if (result.prompt) result.prompt = sub(result.prompt)
    if (result.path) result.path = subPath(result.path)
    if (result.output_path) result.output_path = subPath(result.output_path)
    if (result.result_file) result.result_file = subPath(result.result_file)
    if (result.step) result.step = sub(result.step)
    if (result.contains) result.contains = sub(result.contains)
    // Substitute inside condition fields too
    if (result.condition) {
      if (result.condition.type === 'file_exists') {
        result.condition = { ...result.condition, path: subPath(result.condition.path) }
      } else if (result.condition.type === 'output_contains') {
        result.condition = {
          ...result.condition,
          step: sub(result.condition.step),
          contains: sub(result.condition.contains),
        }
      }
    }
    return result
  })
}

/**
 * Validate provided variables against definitions.
 * Returns an array of error strings (empty if valid).
 * Also applies defaults for missing optional variables and returns the merged result.
 */
export function validateVariables(
  definitions: WorkflowVariable[],
  provided: Record<string, string>,
): { errors: string[]; merged: Record<string, string> } {
  const errors: string[] = []
  const merged: Record<string, string> = { ...provided }
  const definedNames = new Set(definitions.map(d => d.name))

  // Check for unknown variables
  for (const key of Object.keys(provided)) {
    if (!definedNames.has(key)) {
      errors.push(`Unknown variable: "${key}"`)
    }
  }

  // Check required variables and apply defaults
  for (const def of definitions) {
    if (!(def.name in merged)) {
      if (def.default !== undefined) {
        merged[def.name] = def.default
      } else if (def.required) {
        errors.push(`Required variable "${def.name}" is missing`)
      }
    }
  }

  // Enforce type constraints on provided values
  for (const def of definitions) {
    const value = merged[def.name]
    if (value === undefined) continue

    // Length validation
    if (value.length > 50000) {
      errors.push(`Variable "${def.name}" exceeds maximum length (50000 chars)`)
    }

    if (def.type === 'path') {
      if (value.includes('..')) {
        errors.push(`Variable "${def.name}" (type: path) must not contain ".." segments`)
      }
      if (value.includes('\0')) {
        errors.push(`Variable "${def.name}" (type: path) must not contain null bytes`)
      }
    }
  }

  return { errors, merged }
}

// ─── Utility ────────────────────────────────────────────────────────────────

function hasStringField(obj: Record<string, unknown>, field: string): boolean {
  return field in obj && typeof obj[field] === 'string' && (obj[field] as string).length > 0
}

function typeLabel(val: unknown): string {
  if (val === null) return 'null'
  if (val === undefined) return 'undefined'
  if (Array.isArray(val)) return 'array'
  return typeof val
}
