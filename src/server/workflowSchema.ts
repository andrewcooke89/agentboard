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
  default_tier?: number
  system?: {
    engine?: 'sequential' | 'dag'
    session_pool?: boolean
  }
}

// ─── Constants ──────────────────────────────────────────────────────────────

const VALID_STEP_TYPES: ReadonlySet<string> = new Set<WorkflowStepType>([
  'spawn_session',
  'check_file',
  'delay',
  'check_output',
  'native_step',
  'parallel_group',
  'review_loop',
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

  // ── default_tier (optional) ─────────────────────────────────────────
  let defaultTier: number | undefined
  if ('default_tier' in doc && doc.default_tier !== undefined && doc.default_tier !== null) {
    const tierVal = Number(doc.default_tier)
    if (isNaN(tierVal) || !Number.isInteger(tierVal) || tierVal < 0) {
      errors.push('default_tier must be a non-negative integer')
    } else {
      defaultTier = tierVal
    }
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

    // depends_on on top-level steps is an error (only valid within parallel_group children)
    if ('depends_on' in step && step.depends_on !== undefined && step.depends_on !== null) {
      if (stepType !== 'parallel_group') {
        errors.push(`${prefix}.depends_on is only valid within parallel_group children, not on top-level steps`)
      }
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
        ['command', step.command],
        ['working_dir', step.working_dir],
      ]
      // Also check args array entries
      if (step.args) {
        for (let ai = 0; ai < step.args.length; ai++) {
          fieldsToCheck.push([`args[${ai}]`, step.args[ai]])
        }
      }
      // Also check env values
      if (step.env) {
        for (const [envKey, envVal] of Object.entries(step.env)) {
          fieldsToCheck.push([`env.${envKey}`, envVal])
        }
      }
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

  // ── System section parsing (Phase 5) ─────────────────────────────────────
  let systemConfig: ParsedWorkflow['system'] = undefined
  if ('system' in doc && doc.system && typeof doc.system === 'object' && !Array.isArray(doc.system)) {
    const sys = doc.system as Record<string, unknown>
    systemConfig = {}
    if (hasStringField(sys, 'engine')) {
      const eng = sys.engine as string
      if (eng !== 'sequential' && eng !== 'dag') {
        errors.push('system.engine must be "sequential" or "dag"')
      } else {
        systemConfig.engine = eng
      }
    }
    if ('session_pool' in sys) {
      systemConfig.session_pool = String(sys.session_pool) === 'true'
    }
  }

  // ── Auto-detection (REQ-04): infer DAG engine when parallel_group is used ──
  const hasParallelGroup = parsedSteps.some(s => s.type === 'parallel_group')
  const hasDependsOn = parsedSteps.some(s => s.depends_on && s.depends_on.length > 0)
  if (hasParallelGroup || hasDependsOn) {
    if (!systemConfig) systemConfig = {}
    if (!systemConfig.engine) {
      systemConfig.engine = 'dag'
      if (systemConfig.session_pool === undefined) {
        systemConfig.session_pool = true
      }
    }
  }

  // ── REQ-05: session_pool:false + engine:dag is invalid ────────────────────
  if (systemConfig?.session_pool === false && systemConfig?.engine === 'dag') {
    errors.push('system.session_pool cannot be false when engine is "dag"')
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
    default_tier: defaultTier,
    system: systemConfig,
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

    case 'native_step': {
      const hasCommand = hasStringField(step, 'command')
      const hasAction = hasStringField(step, 'action')
      if (hasCommand && hasAction) {
        errors.push(`${prefix} must specify either command or action, not both`)
      } else if (!hasCommand && !hasAction) {
        errors.push(`${prefix} requires either command or action`)
      }
      // Validate optional field types
      if ('args' in step && step.args !== undefined && step.args !== null) {
        if (!Array.isArray(step.args)) {
          errors.push(`${prefix}.args must be an array of strings`)
        } else {
          for (let j = 0; j < (step.args as unknown[]).length; j++) {
            if (typeof (step.args as unknown[])[j] !== 'string') {
              errors.push(`${prefix}.args[${j}] must be a string`)
            }
          }
        }
      }
      if ('working_dir' in step && step.working_dir !== undefined && step.working_dir !== null) {
        if (typeof step.working_dir !== 'string') {
          errors.push(`${prefix}.working_dir must be a string`)
        } else if (step.working_dir.includes('..')) {
          errors.push(`${prefix}.working_dir must not contain '..' path segments`)
        }
      }
      if ('env' in step && step.env !== undefined && step.env !== null) {
        if (typeof step.env !== 'object' || Array.isArray(step.env)) {
          errors.push(`${prefix}.env must be an object (Record<string, string>)`)
        } else {
          const envObj = step.env as Record<string, unknown>
          for (const [k, v] of Object.entries(envObj)) {
            if (typeof v !== 'string') {
              errors.push(`${prefix}.env.${k} must be a string`)
            }
          }
        }
      }
      if ('success_codes' in step && step.success_codes !== undefined && step.success_codes !== null) {
        if (!Array.isArray(step.success_codes)) {
          errors.push(`${prefix}.success_codes must be an array of integers`)
        } else {
          for (let j = 0; j < (step.success_codes as unknown[]).length; j++) {
            const code = Number((step.success_codes as unknown[])[j])
            if (isNaN(code) || !Number.isInteger(code)) {
              errors.push(`${prefix}.success_codes[${j}] must be an integer`)
            }
          }
        }
      }
      if ('capture_stderr' in step && step.capture_stderr !== undefined && step.capture_stderr !== null) {
        const val = String(step.capture_stderr)
        if (val !== 'true' && val !== 'false') {
          errors.push(`${prefix}.capture_stderr must be a boolean`)
        }
      }
      break
    }

    case 'parallel_group': {
      // children — required, non-empty array
      if (!('children' in step) || !Array.isArray(step.children)) {
        errors.push(`${prefix}.children is required (non-empty array) for parallel_group steps`)
        break
      }
      const children = step.children as unknown[]
      if (children.length === 0) {
        errors.push(`${prefix}.children must contain at least 1 child step`)
        break
      }

      // on_failure — optional, must be valid enum
      if (hasStringField(step, 'on_failure')) {
        const onFailure = step.on_failure as string
        if (onFailure !== 'fail_fast' && onFailure !== 'cancel_all' && onFailure !== 'continue_others') {
          errors.push(`${prefix}.on_failure must be one of: fail_fast, cancel_all, continue_others`)
        }
      }

      // Validate each child
      const childNames = new Set<string>()
      const childList: { name: string; depends_on?: string[] }[] = []
      for (let ci = 0; ci < children.length; ci++) {
        const childRaw = children[ci]
        const cPrefix = `${prefix}.children[${ci}]`
        if (childRaw === null || childRaw === undefined || typeof childRaw !== 'object' || Array.isArray(childRaw)) {
          errors.push(`${cPrefix} must be an object`)
          continue
        }
        const child = childRaw as Record<string, unknown>

        // child.name — required, unique within group
        if (!hasStringField(child, 'name')) {
          errors.push(`${cPrefix}.name is required (non-empty string)`)
          continue
        }
        const cName = (child.name as string).trim()
        if (cName.length === 0) {
          errors.push(`${cPrefix}.name must be a non-empty string`)
          continue
        }
        if (cName.length > 128) {
          errors.push(`${cPrefix}.name exceeds maximum length of 128 characters`)
        }
        if (childNames.has(cName)) {
          errors.push(`${cPrefix}.name "${cName}" is a duplicate (child names must be unique within parallel_group)`)
        }
        childNames.add(cName)

        // child.type — required, valid step type (but not parallel_group — no nesting)
        if (!hasStringField(child, 'type')) {
          errors.push(`${cPrefix}.type is required`)
        } else {
          const cType = child.type as string
          if (!VALID_STEP_TYPES.has(cType)) {
            errors.push(`${cPrefix}.type "${cType}" is invalid (must be one of: ${[...VALID_STEP_TYPES].join(', ')})`)
          } else if (cType === 'parallel_group') {
            errors.push(`${cPrefix}.type "parallel_group" cannot be nested inside another parallel_group`)
          } else {
            // Validate type-specific fields for child
            validateTypeSpecificFields(child, cType as WorkflowStepType, cPrefix, errors)
          }
        }

        // child.depends_on — optional, array of strings referencing sibling names
        let childDeps: string[] | undefined
        if ('depends_on' in child && child.depends_on !== undefined && child.depends_on !== null) {
          if (!Array.isArray(child.depends_on)) {
            errors.push(`${cPrefix}.depends_on must be an array of strings`)
          } else {
            childDeps = []
            for (let di = 0; di < (child.depends_on as unknown[]).length; di++) {
              const dep = (child.depends_on as unknown[])[di]
              if (typeof dep !== 'string') {
                errors.push(`${cPrefix}.depends_on[${di}] must be a string`)
              } else {
                const depName = dep.trim()
                if (depName === cName) {
                  errors.push(`${cPrefix}.depends_on contains self-reference "${cName}"`)
                } else if (depName.length > 0) {
                  childDeps.push(depName)
                }
              }
            }
          }
        }

        childList.push({ name: cName, depends_on: childDeps })
      }

      // Validate depends_on references point to sibling names
      for (let ci = 0; ci < childList.length; ci++) {
        const child = childList[ci]
        for (const dep of child.depends_on ?? []) {
          if (!childNames.has(dep)) {
            errors.push(`${prefix}.children[${ci}].depends_on references unknown sibling "${dep}"`)
          }
        }
      }

      // Cycle detection using Kahn's topological sort
      if (childList.length > 0) {
        const cycleNodes = detectCycle(childList)
        if (cycleNodes) {
          errors.push(`${prefix}.children contain a dependency cycle: ${cycleNodes.join(' -> ')} -> ${cycleNodes[0]}`)
        }
      }
      break
    }

    case 'review_loop': {
      // producer — required, must be a spawn_session step object
      if (!('producer' in step) || step.producer === null || step.producer === undefined || typeof step.producer !== 'object' || Array.isArray(step.producer)) {
        errors.push(`${prefix}.producer is required (spawn_session step object) for review_loop steps`)
      } else {
        const prod = step.producer as Record<string, unknown>
        if (!hasStringField(prod, 'name')) {
          errors.push(`${prefix}.producer.name is required (non-empty string)`)
        }
        if (!hasStringField(prod, 'type') || prod.type !== 'spawn_session') {
          errors.push(`${prefix}.producer.type must be "spawn_session"`)
        } else {
          validateTypeSpecificFields(prod, 'spawn_session', `${prefix}.producer`, errors)
        }
      }
      // reviewer — required, must be a spawn_session step object
      if (!('reviewer' in step) || step.reviewer === null || step.reviewer === undefined || typeof step.reviewer !== 'object' || Array.isArray(step.reviewer)) {
        errors.push(`${prefix}.reviewer is required (spawn_session step object) for review_loop steps`)
      } else {
        const rev = step.reviewer as Record<string, unknown>
        if (!hasStringField(rev, 'name')) {
          errors.push(`${prefix}.reviewer.name is required (non-empty string)`)
        }
        if (!hasStringField(rev, 'type') || rev.type !== 'spawn_session') {
          errors.push(`${prefix}.reviewer.type must be "spawn_session"`)
        } else {
          validateTypeSpecificFields(rev, 'spawn_session', `${prefix}.reviewer`, errors)
        }
      }
      // max_iterations — optional, positive integer, defaults to 3
      if ('max_iterations' in step && step.max_iterations !== undefined && step.max_iterations !== null) {
        const maxIter = Number(step.max_iterations)
        if (isNaN(maxIter) || !Number.isInteger(maxIter) || maxIter < 1) {
          errors.push(`${prefix}.max_iterations must be a positive integer`)
        } else if (maxIter > 20) {
          errors.push(`${prefix}.max_iterations must not exceed 20`)
        }
      }
      break
    }
  }

  // Tier validation (common to all step types)
  if ('tier_min' in step && step.tier_min !== undefined && step.tier_min !== null) {
    const tierMin = Number(step.tier_min)
    if (isNaN(tierMin) || !Number.isInteger(tierMin) || tierMin < 0) {
      errors.push(`${prefix}.tier_min must be a non-negative integer`)
    }
  }
  if ('tier_max' in step && step.tier_max !== undefined && step.tier_max !== null) {
    const tierMax = Number(step.tier_max)
    if (isNaN(tierMax) || !Number.isInteger(tierMax) || tierMax < 0) {
      errors.push(`${prefix}.tier_max must be a non-negative integer`)
    }
  }
  if ('tier_min' in step && 'tier_max' in step &&
      step.tier_min !== undefined && step.tier_min !== null &&
      step.tier_max !== undefined && step.tier_max !== null) {
    const tierMin = Number(step.tier_min)
    const tierMax = Number(step.tier_max)
    if (!isNaN(tierMin) && !isNaN(tierMax) && tierMin > tierMax) {
      errors.push(`${prefix}.tier_min (${tierMin}) must be <= tier_max (${tierMax})`)
    }
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

  // native_step fields
  if (hasStringField(step, 'command')) result.command = step.command as string
  if (hasStringField(step, 'action')) result.action = step.action as string
  if (Array.isArray(step.args)) result.args = (step.args as unknown[]).map(a => String(a))
  if (hasStringField(step, 'working_dir')) result.working_dir = step.working_dir as string
  if ('env' in step && step.env && typeof step.env === 'object' && !Array.isArray(step.env)) {
    const envObj: Record<string, string> = {}
    for (const [k, v] of Object.entries(step.env as Record<string, unknown>)) {
      envObj[k] = String(v)
    }
    result.env = envObj
  }
  if (Array.isArray(step.success_codes)) {
    result.success_codes = (step.success_codes as unknown[]).map(c => Number(c))
  }
  if ('capture_stderr' in step && step.capture_stderr !== undefined && step.capture_stderr !== null) {
    result.capture_stderr = String(step.capture_stderr) === 'true'
  }

  // Tier fields (common to all step types)
  if ('tier_min' in step && step.tier_min !== undefined && step.tier_min !== null) {
    result.tier_min = Number(step.tier_min)
  }
  if ('tier_max' in step && step.tier_max !== undefined && step.tier_max !== null) {
    result.tier_max = Number(step.tier_max)
  }

  // Condition
  if (step.condition && typeof step.condition === 'object' && !Array.isArray(step.condition)) {
    const cond = step.condition as Record<string, unknown>
    if (hasStringField(cond, 'type')) {
      result.condition = buildCondition(cond)
    }
  }

  // parallel_group fields (Phase 5)
  if (Array.isArray(step.depends_on)) {
    result.depends_on = (step.depends_on as unknown[]).map(d => String(d).trim()).filter(d => d.length > 0)
  }
  if (hasStringField(step, 'on_failure')) {
    const of = step.on_failure as string
    if (of === 'fail_fast' || of === 'cancel_all' || of === 'continue_others') {
      result.on_failure = of
    }
  }
  if (Array.isArray(step.children)) {
    result.children = (step.children as unknown[])
      .filter(c => c !== null && c !== undefined && typeof c === 'object' && !Array.isArray(c))
      .map(c => {
        const child = c as Record<string, unknown>
        const childType = hasStringField(child, 'type') && VALID_STEP_TYPES.has(child.type as string)
          ? (child.type as WorkflowStepType)
          : null
        return buildWorkflowStep(child, childType)
      })
  }

  // review_loop fields (REQ-40)
  if (step.producer && typeof step.producer === 'object' && !Array.isArray(step.producer)) {
    const prod = step.producer as Record<string, unknown>
    const prodType = hasStringField(prod, 'type') && VALID_STEP_TYPES.has(prod.type as string)
      ? (prod.type as WorkflowStepType)
      : null
    result.producer = buildWorkflowStep(prod, prodType)
  }
  if (step.reviewer && typeof step.reviewer === 'object' && !Array.isArray(step.reviewer)) {
    const rev = step.reviewer as Record<string, unknown>
    const revType = hasStringField(rev, 'type') && VALID_STEP_TYPES.has(rev.type as string)
      ? (rev.type as WorkflowStepType)
      : null
    result.reviewer = buildWorkflowStep(rev, revType)
  }
  if ('max_iterations' in step && step.max_iterations !== undefined && step.max_iterations !== null) {
    result.max_iterations = Number(step.max_iterations)
  }

  return result
}

/** Kahn's algorithm for cycle detection in depends_on graph within parallel_group children. */
function detectCycle(children: { name: string; depends_on?: string[] }[]): string[] | null {
  const nameSet = new Set(children.map(c => c.name))
  const adj = new Map<string, string[]>()
  const inDegree = new Map<string, number>()
  for (const c of children) {
    adj.set(c.name, [])
    inDegree.set(c.name, 0)
  }
  for (const c of children) {
    for (const dep of c.depends_on ?? []) {
      if (!nameSet.has(dep)) continue // validated separately
      adj.get(dep)!.push(c.name)
      inDegree.set(c.name, (inDegree.get(c.name) ?? 0) + 1)
    }
  }
  const queue: string[] = []
  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name)
  }
  const sorted: string[] = []
  while (queue.length > 0) {
    const node = queue.shift()!
    sorted.push(node)
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, newDeg)
      if (newDeg === 0) queue.push(neighbor)
    }
  }
  if (sorted.length < children.length) {
    const cycleNodes = children.filter(c => !sorted.includes(c.name)).map(c => c.name)
    return cycleNodes
  }
  return null
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

  function subShellSafe(value: string): string {
    return value.replace(regex, (full, name) => {
      return name in variables ? shellEscape(variables[name]) : full
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
    // native_step fields: shell-safe substitution for command and args
    if (result.command) result.command = subShellSafe(result.command)
    if (result.args) result.args = result.args.map(a => subShellSafe(a))
    if (result.working_dir) result.working_dir = subPath(result.working_dir)
    if (result.env) {
      const newEnv: Record<string, string> = {}
      for (const [k, v] of Object.entries(result.env)) {
        newEnv[k] = sub(v)
      }
      result.env = newEnv
    }
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

// ─── Shell Safety ───────────────────────────────────────────────────────────

/** Shell-escape a string by wrapping in single quotes (REQ-15). */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
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
