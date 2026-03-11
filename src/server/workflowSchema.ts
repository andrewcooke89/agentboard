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
  CleanupAction,
} from '@shared/types'

// ─── Public Types ───────────────────────────────────────────────────────────

/** Result of parsing and validating a workflow YAML string. */
export interface ValidationResult {
  valid: boolean
  workflow?: ParsedWorkflow
  errors: string[]
}

export interface PipelineDefaults {
  tier?: number
  timeoutSeconds?: number
  maxRetries?: number
  constitution_sections?: string[]
  signal_protocol?: boolean
  signal_dir?: string
  working_dir?: string
  env?: Record<string, string>
  amendment_budget?: Record<string, unknown>
  reviewers?: Record<string, unknown>
  [key: string]: unknown
}

/** Parsed workflow structure (before DB persistence). */
export interface ParsedWorkflow {
  name: string
  description: string | null
  steps: WorkflowStep[]
  variables: WorkflowVariable[]
  default_tier?: number
  system?: {
    engine?: 'legacy' | 'dag'
    autoDetectedEngine?: boolean
    session_pool?: boolean
  }
  defaults?: PipelineDefaults
  // Phase 15: Pipeline-level error hooks (REQ-27)
  on_error?: CleanupAction[]
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
  'spec_validate',
  'amendment_check',
  'reconcile-spec',
  'gemini_offload',
  'aggregator',
  'human_gate',
  'review',
])

const VALID_CONDITION_TYPES: ReadonlySet<string> = new Set([
  'file_exists',
  'output_contains',
])

const MAX_VALIDATION_ERRORS = 100

// P2-17: Known native_step action values (mirrors PREDEFINED_ACTIONS in dagEngine.ts)
const VALID_NATIVE_STEP_ACTIONS: ReadonlySet<string> = new Set([
  'git_rebase_from_main',
  'run_tests',
  'prepare-context',
])

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

  let doc = raw as Record<string, unknown>

  // ── Phase 21: Pipeline wrapper unwrap ─────────────────────────────────
  // If the YAML has a `pipeline:` key containing an object with `name`+`steps`,
  // unwrap it to the inner document (spec-dev pipeline YAML compatibility).
  if ('pipeline' in doc && doc.pipeline !== null && doc.pipeline !== undefined
      && typeof doc.pipeline === 'object' && !Array.isArray(doc.pipeline)) {
    const inner = doc.pipeline as Record<string, unknown>
    if (('name' in inner || 'steps' in inner)) {
      // Preserve any extra top-level keys from the outer doc alongside the unwrapped inner
      const { pipeline: _discarded, ...outerExtras } = doc
      doc = { ...outerExtras, ...inner }
    }
  }

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

    // depends_on validation:
    // - allowed in parallel_group children
    // - allowed on top-level steps when engine is (or will be) DAG
    // Note: We can't fully validate this here because engine detection happens later,
    // but we'll check for obvious errors (depends_on when not parallel_group and no explicit DAG engine)
    // The auto-detection later will set engine=dag if depends_on is present, so this is permissive.

    // Track seen names (after validation so references only see prior steps)
    if (stepName) {
      seenNames.add(stepName)
    }

    // Build parsed step (best-effort even if some fields invalid)
    parsedSteps.push(buildWorkflowStep(step, stepType))
  }

  // ── P0-1: Validate depends_on references at top-level ────────────────────
  // Collect all top-level step names so we can validate cross-references.
  const allTopLevelNames = new Set<string>()
  for (const s of parsedSteps) {
    if (s.name) allTopLevelNames.add(s.name)
  }
  for (let i = 0; i < parsedSteps.length; i++) {
    const step = parsedSteps[i]
    const prefix = `steps[${i}]`
    if (!step.depends_on || step.depends_on.length === 0) continue
    for (const dep of step.depends_on) {
      if (dep === step.name) {
        errors.push(`${prefix}: self-dependency detected (step '${step.name}' depends on itself)`)
      } else if (!allTopLevelNames.has(dep)) {
        errors.push(`${prefix}.depends_on references unknown step '${dep}'`)
      }
    }
  }

  // ── Validate {{ var }} references in step fields ─────────────────────────
  // Always check, even when no variables: section exists (P0-3).
  // Any {{ ref }} is an error unless it's a built-in variable.
  {
    const definedVarNames = new Set([
      ...parsedVariables.map(v => v.name),
      // Built-in variables auto-populated by dagEngine.ensureStandardVariables
      'run_dir',
      'run_id',
    ])
    const templateRegex = /\{\{\s*([\w.]+)\s*\}\}/g

    function checkStepTemplateRefs(step: WorkflowStep, prefix: string): void {
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
        ['signal_dir', step.signal_dir],
        ['spec_path', step.spec_path],
        ['schema_path', step.schema_path],
        ['prompt_template', step.prompt_template],
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
      // P0-2: Recurse into review_loop producer and reviewer
      if (step.producer) checkStepTemplateRefs(step.producer, `${prefix}.producer`)
      if (step.reviewer) checkStepTemplateRefs(step.reviewer, `${prefix}.reviewer`)
      // Also recurse into parallel_group children
      if (step.steps) {
        for (let ci = 0; ci < step.steps.length; ci++) {
          checkStepTemplateRefs(step.steps[ci], `${prefix}.steps[${ci}]`)
        }
      }
    }

    for (let i = 0; i < parsedSteps.length; i++) {
      if (errors.length >= MAX_VALIDATION_ERRORS) break
      checkStepTemplateRefs(parsedSteps[i], `steps[${i}]`)
    }
  }

  // ── Defaults block parsing (Phase 9) ───────────────────────────────────
  let pipelineDefaults: PipelineDefaults | undefined
  if ('defaults' in doc && doc.defaults !== undefined && doc.defaults !== null) {
    if (typeof doc.defaults !== 'object' || Array.isArray(doc.defaults)) {
      errors.push('defaults must be an object')
    } else {
      const defs = doc.defaults as Record<string, unknown>
      pipelineDefaults = {}

      // tier — optional, non-negative integer
      if ('tier' in defs && defs.tier !== undefined && defs.tier !== null) {
        const tierVal = Number(defs.tier)
        if (isNaN(tierVal) || !Number.isInteger(tierVal) || tierVal < 0) {
          errors.push('defaults.tier must be a non-negative integer')
        } else {
          pipelineDefaults.tier = tierVal
        }
      }

      // timeoutSeconds — optional, positive integer
      if ('timeoutSeconds' in defs && defs.timeoutSeconds !== undefined && defs.timeoutSeconds !== null) {
        const timeout = Number(defs.timeoutSeconds)
        if (isNaN(timeout) || timeout <= 0) {
          errors.push('defaults.timeoutSeconds must be a positive integer')
        } else if (timeout > 86400) {
          errors.push('defaults.timeoutSeconds must not exceed 86400 (24 hours)')
        } else if (!Number.isInteger(timeout)) {
          errors.push('defaults.timeoutSeconds must be an integer')
        } else {
          pipelineDefaults.timeoutSeconds = timeout
        }
      }

      // maxRetries — optional, non-negative integer
      if ('maxRetries' in defs && defs.maxRetries !== undefined && defs.maxRetries !== null) {
        const retries = Number(defs.maxRetries)
        if (isNaN(retries) || retries < 0) {
          errors.push('defaults.maxRetries must be a non-negative integer')
        } else if (retries > 10) {
          errors.push('defaults.maxRetries must not exceed 10')
        } else if (!Number.isInteger(retries)) {
          errors.push('defaults.maxRetries must be an integer')
        } else {
          pipelineDefaults.maxRetries = retries
        }
      }

      // constitution_sections — optional, array of strings
      if ('constitution_sections' in defs && defs.constitution_sections !== undefined && defs.constitution_sections !== null) {
        if (!Array.isArray(defs.constitution_sections)) {
          errors.push('defaults.constitution_sections must be an array of strings')
        } else {
          pipelineDefaults.constitution_sections = (defs.constitution_sections as unknown[]).map(s => String(s))
        }
      }

      // signal_protocol — optional boolean
      if ('signal_protocol' in defs && defs.signal_protocol !== undefined && defs.signal_protocol !== null) {
        const val = String(defs.signal_protocol)
        if (val !== 'true' && val !== 'false') {
          errors.push('defaults.signal_protocol must be a boolean')
        } else {
          pipelineDefaults.signal_protocol = val === 'true'
        }
      }

      // signal_dir — optional string
      if (hasStringField(defs, 'signal_dir')) {
        const sd = defs.signal_dir as string
        if (sd.includes('..')) {
          errors.push('defaults.signal_dir must not contain ".." segments')
        } else {
          pipelineDefaults.signal_dir = sd
        }
      }

      // working_dir — optional string
      if (hasStringField(defs, 'working_dir')) {
        const wd = defs.working_dir as string
        if (wd.includes('..')) {
          errors.push('defaults.working_dir must not contain ".." segments')
        } else {
          pipelineDefaults.working_dir = wd
        }
      }

      // env — optional Record<string, string>
      if ('env' in defs && defs.env !== undefined && defs.env !== null) {
        if (typeof defs.env !== 'object' || Array.isArray(defs.env)) {
          errors.push('defaults.env must be an object')
        } else {
          const envObj: Record<string, string> = {}
          for (const [k, v] of Object.entries(defs.env as Record<string, unknown>)) {
            envObj[k] = String(v)
          }
          pipelineDefaults.env = envObj
        }
      }

      // Pass through unknown fields for forward-compat (amendment_budget, reviewers, etc.)
      for (const [key, value] of Object.entries(defs)) {
        if (!(key in pipelineDefaults) && pipelineDefaults[key] === undefined) {
          pipelineDefaults[key] = value
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
      if (eng !== 'legacy' && eng !== 'dag') {
        errors.push('system.engine must be "legacy" or "dag"')
      } else {
        systemConfig.engine = eng
      }
    }
    if ('session_pool' in sys) {
      systemConfig.session_pool = String(sys.session_pool) === 'true'
    }
  }

  // ── Auto-detection (REQ-04): infer DAG engine when DAG-only features are used ──
  // Overrides explicit system.engine value regardless of what was specified.
  const hasParallelGroup = parsedSteps.some(s => s.type === 'parallel_group')
  const hasDependsOn = parsedSteps.some(s => s.depends_on && s.depends_on.length > 0)
  const hasDagStepTypes = parsedSteps.some(s =>
    s.type === 'gemini_offload' ||
    s.type === 'aggregator' ||
    s.type === 'human_gate' ||
    s.type === 'review_loop' ||
    s.type === 'spec_validate' ||
    s.type === 'amendment_check' ||
    s.type === 'reconcile-spec'
  )
  const hasPerWorkUnit = parsedSteps.some(s => !!s.per_work_unit)
  const hasExpressionCondition = parsedSteps.some(s => s.condition?.type === 'expression')
  if (hasParallelGroup || hasDependsOn || hasDagStepTypes || hasPerWorkUnit || hasExpressionCondition) {
    if (!systemConfig) systemConfig = {}
    systemConfig.engine = 'dag'
    systemConfig.autoDetectedEngine = true
    if (systemConfig.session_pool === undefined) {
      systemConfig.session_pool = true
    }
  }

  // ── REQ-60/REQ-61: AGENTBOARD_FORCE_LEGACY_ENGINE env var override ────────
  // When set to 'true', forces sequential (legacy) engine regardless of YAML config
  // or auto-detection. This provides a safety valve for backward compatibility.
  if (process.env.AGENTBOARD_FORCE_LEGACY_ENGINE === 'true') {
    if (!systemConfig) systemConfig = {}
    const declaredEngine = systemConfig.engine
    systemConfig.engine = 'legacy'
    systemConfig.autoDetectedEngine = false
    // Warn when pipeline declares or auto-detects DAG but env var forces sequential
    if (declaredEngine === 'dag') {
      console.warn(
        `[workflowSchema] WARNING: Pipeline "${(doc.name as string)?.trim() ?? 'unknown'}" declares engine: dag, ` +
        'but AGENTBOARD_FORCE_LEGACY_ENGINE=true is forcing sequential (legacy) engine.'
      )
    }
    console.warn(
      `[workflowSchema] Engine override active: using legacy (sequential) engine ` +
      `for pipeline "${(doc.name as string)?.trim() ?? 'unknown'}" (AGENTBOARD_FORCE_LEGACY_ENGINE=true).`
    )
  }

  // ── REQ-05: session_pool:false + engine:dag is invalid ────────────────────
  if (systemConfig?.session_pool === false && systemConfig?.engine === 'dag') {
    errors.push('session_pool: false is incompatible with engine: dag')
  }

  // ── Phase 15: Pipeline-level on_error parsing (REQ-27) ──────────────────
  let pipelineOnError: CleanupAction[] | undefined
  if ('on_error' in doc && doc.on_error !== undefined && doc.on_error !== null) {
    validateOnErrorField(doc.on_error, 'pipeline', errors)
    if (Array.isArray(doc.on_error)) {
      pipelineOnError = (doc.on_error as unknown[])
        .filter(a => a !== null && a !== undefined && typeof a === 'object' && !Array.isArray(a))
        .map(a => {
          const action = a as Record<string, unknown>
          return {
            type: 'native_step' as const,
            command: String(action.command ?? ''),
            working_dir: hasStringField(action, 'working_dir') ? (action.working_dir as string) : undefined,
            timeoutSeconds: ('timeoutSeconds' in action && action.timeoutSeconds !== undefined)
              ? Number(action.timeoutSeconds) : undefined,
          }
        })
    }
  }

  // ── Build result ────────────────────────────────────────────────────────

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  // Apply pipeline defaults to all steps (CF-8, REQ-13-16)
  const stepsWithDefaults = pipelineDefaults ? applyDefaults(parsedSteps, pipelineDefaults) : parsedSteps

  const workflow: ParsedWorkflow = {
    name: (doc.name as string).trim(),
    description: hasStringField(doc, 'description') ? (doc.description as string).trim() : null,
    steps: stepsWithDefaults,
    variables: parsedVariables,
    default_tier: defaultTier,
    system: systemConfig,
    defaults: pipelineDefaults,
    on_error: pipelineOnError,
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

  // P1-39: also validate snake_case alias used by pipeline YAMLs
  if ('timeout_seconds' in step && !('timeoutSeconds' in step)) {
    const timeout = Number(step.timeout_seconds)
    if (isNaN(timeout) || timeout <= 0) {
      errors.push(`${prefix}.timeout_seconds must be a positive integer`)
    } else if (timeout > 86400) {
      errors.push(`${prefix}.timeout_seconds must not exceed 86400 (24 hours)`)
    } else if (!Number.isInteger(timeout)) {
      errors.push(`${prefix}.timeout_seconds must be an integer`)
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

  // REQ-04: signal_protocol is only valid on spawn_session steps
  if (type !== 'spawn_session' && 'signal_protocol' in step && step.signal_protocol !== undefined && step.signal_protocol !== null) {
    const spVal = String(step.signal_protocol)
    if (spVal === 'true') {
      errors.push(`${prefix}.signal_protocol is only supported on spawn_session steps`)
    }
  }

  // Type-specific field validation
  switch (type) {
    case 'spawn_session':
      // Phase 21: When 'agent' or 'model' field is present (pipeline YAML format),
      // projectPath and prompt are injected at runtime — not required in YAML.
      // The 'model' field determines the default agent when 'agent' is not specified.
      const hasAgentOrModel = hasStringField(step, 'agent') || hasStringField(step, 'model')
      if (!hasAgentOrModel) {
        if (!hasStringField(step, 'projectPath')) {
          errors.push(`${prefix}.projectPath is required for spawn_session steps (or provide 'agent' or 'model')`)
        } else {
          const projectPath = step.projectPath as string
          if (projectPath.length > 4096) {
            errors.push(`${prefix}.projectPath exceeds maximum length of 4096 characters`)
          }
        }
        if (!hasStringField(step, 'prompt')) {
          errors.push(`${prefix}.prompt is required for spawn_session steps (or provide 'agent' or 'model')`)
        }
      }
      if (hasStringField(step, 'prompt')) {
        const prompt = step.prompt as string
        if (prompt.length > 100000) {
          errors.push(`${prefix}.prompt exceeds maximum length of 100000 characters`)
        }
      }
      // Phase 7: Signal protocol validation (REQ-01 through REQ-04)
      if ('signal_protocol' in step && step.signal_protocol !== undefined && step.signal_protocol !== null) {
        const spVal = String(step.signal_protocol)
        if (spVal !== 'true' && spVal !== 'false') {
          errors.push(`${prefix}.signal_protocol must be a boolean`)
        }
        if (spVal === 'true') {
          // REQ-02: signal_dir is required when signal_protocol is true
          if (!hasStringField(step, 'signal_dir')) {
            errors.push(`${prefix}.signal_dir is required when signal_protocol is true`)
          } else {
            const signalDir = step.signal_dir as string
            if (signalDir.length === 0) {
              errors.push(`${prefix}.signal_dir must be a non-empty string`)
            } else if (signalDir.length > 4096) {
              errors.push(`${prefix}.signal_dir exceeds maximum length of 4096 characters`)
            } else if (signalDir.includes('..')) {
              errors.push(`${prefix}.signal_dir must not contain '..' segments`)
            }
          }
        }
      }
      // REQ-03: signal_timeout_seconds must be positive integer if present
      if ('signal_timeout_seconds' in step && step.signal_timeout_seconds !== undefined && step.signal_timeout_seconds !== null) {
        const sts = Number(step.signal_timeout_seconds)
        if (isNaN(sts) || sts <= 0) {
          errors.push(`${prefix}.signal_timeout_seconds must be a positive integer`)
        } else if (!Number.isInteger(sts)) {
          errors.push(`${prefix}.signal_timeout_seconds must be an integer`)
        } else if (sts > 86400) {
          errors.push(`${prefix}.signal_timeout_seconds must not exceed 86400 (24 hours)`)
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
      // Phase 21+: Check for nested execution.command (Phase 18+ pattern)
      const hasExecutionCommand = 'execution' in step
        && step.execution !== null
        && typeof step.execution === 'object'
        && !Array.isArray(step.execution)
        && hasStringField(step.execution as Record<string, unknown>, 'command')
      if (hasCommand && hasAction) {
        errors.push(`${prefix} must specify either command or action, not both`)
      } else if (hasAction && !VALID_NATIVE_STEP_ACTIONS.has(step.action as string)) {
        // P2-17: reject unknown action values at parse time
        errors.push(
          `${prefix}.action "${step.action}" is not a known native action (must be one of: ${[...VALID_NATIVE_STEP_ACTIONS].join(', ')})`,
        )
      } else if (!hasCommand && !hasAction && !hasExecutionCommand) {
        // Phase 21: Pipeline YAMLs may have native_step with actions/checks defined
        // as structured data — these get their command at runtime
        const hasActions = 'actions' in step || 'checks' in step
        if (!hasActions) {
          errors.push(`${prefix} requires either command, action, or execution.command`)
        }
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
      const pgName = (typeof step.name === 'string' ? step.name.trim() : '') || prefix
      // steps or children — required, non-empty array
      // Phase 21: Pipeline YAMLs use 'children' instead of 'steps'
      const pgStepsKey = ('steps' in step && Array.isArray(step.steps)) ? 'steps'
        : ('children' in step && Array.isArray(step.children)) ? 'children'
        : null
      if (!pgStepsKey) {
        errors.push(`parallel_group '${pgName}' must have at least one child step`)
        break
      }
      const children = step[pgStepsKey] as unknown[]
      if (children.length === 0) {
        errors.push(`parallel_group '${pgName}' must have at least one child step`)
        break
      }

      // on_failure — optional, must be valid enum
      if (hasStringField(step, 'on_failure')) {
        const onFailure = step.on_failure as string
        // Phase 21: Allow additional on_failure values (continue, pause_and_notify, etc.)
        const validOnFailure = ['fail_fast', 'cancel_all', 'continue_others', 'continue', 'pause_and_notify', 'fail', 'skip']
        if (!validOnFailure.includes(onFailure)) {
          errors.push(`${prefix}.on_failure must be one of: ${validOnFailure.join(', ')}`)
        }
      }

      // max_parallel — optional, positive integer or variable expression (Phase 21)
      if ('max_parallel' in step && step.max_parallel !== undefined && step.max_parallel !== null) {
        const mp = step.max_parallel
        // Phase 21: Allow variable interpolation like {{ project_profile.machine_capacity.session_pool_size }}
        if (typeof mp === 'string' && mp.match(/^\{\{.+\}\}$/)) {
          // Variable expression - skip validation, will be resolved at runtime
        } else {
          const mpNum = Number(mp)
          if (!Number.isInteger(mpNum) || mpNum < 1) {
            errors.push(`${prefix}.max_parallel must be a positive integer (got ${JSON.stringify(mp)})`)
          }
        }
      }

      // Validate each child
      const childNames = new Set<string>()
      const childList: { name: string; depends_on?: string[] }[] = []
      for (let ci = 0; ci < children.length; ci++) {
        const childRaw = children[ci]
        const cPrefix = `${prefix}.steps[${ci}]`
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
          if (cType === 'amendment_check') {
            errors.push(`${cPrefix}.type "amendment_check" cannot be a parallel_group child`)
          } else if (cType === 'reconcile-spec') {
            errors.push(`${cPrefix}.type "reconcile-spec" cannot be a parallel_group child`)
          } else if (!VALID_STEP_TYPES.has(cType)) {
            errors.push(`${cPrefix}.type "${cType}" is invalid (must be one of: ${[...VALID_STEP_TYPES].join(', ')})`)
          } else if (cType === 'parallel_group') {
            errors.push(`parallel_group cannot be nested: '${cName}' inside '${pgName}'`)
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
                  errors.push(`Self-dependency detected: step '${cName}' depends on itself`)
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
            errors.push(`depends_on target '${dep}' is not a sibling within this parallel_group`)
          }
        }
      }

      // Cycle detection using Kahn's topological sort
      if (childList.length > 0) {
        const cycleNodes = detectCycle(childList)
        if (cycleNodes) {
          errors.push(`Circular dependency detected in parallel_group '${pgName}': ${cycleNodes.join(' -> ')} -> ${cycleNodes[0]}`)
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
        // verdict_field on reviewer — has default (verdict), so not required
        // Phase 21: Remove required check, verdict_field has a default value
        if ('feedback_field' in rev && rev.feedback_field !== undefined && rev.feedback_field !== null) {
          if (typeof rev.feedback_field !== 'string' || (rev.feedback_field as string).trim().length === 0) {
            errors.push(`${prefix}.reviewer.feedback_field must be a non-empty string if present`)
          }
        }

        // SECURITY-1 (REQ-34): Pattern validation to prevent path traversal via field names
        const fieldPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/

        if (rev.verdict_field && typeof rev.verdict_field === 'string') {
          if (!fieldPattern.test(rev.verdict_field)) {
            errors.push(`${prefix}.reviewer.verdict_field must be a valid identifier (alphanumeric and underscore only, must start with letter or underscore)`)
          }
        }

        if (rev.feedback_field && typeof rev.feedback_field === 'string') {
          if (!fieldPattern.test(rev.feedback_field)) {
            errors.push(`${prefix}.reviewer.feedback_field must be a valid identifier (alphanumeric and underscore only, must start with letter or underscore)`)
          }
        }
      }
      // max_iterations — optional, positive integer >= 2, defaults to 3
      // P2-19: value of 1 means no review can actually happen (producer runs, reviewer never runs)
      if ('max_iterations' in step && step.max_iterations !== undefined && step.max_iterations !== null) {
        const maxIter = Number(step.max_iterations)
        if (isNaN(maxIter) || !Number.isInteger(maxIter) || maxIter < 1) {
          errors.push(`${prefix}.max_iterations must be a positive integer`)
        } else if (maxIter === 1) {
          errors.push(`${prefix}.max_iterations of 1 is invalid: reviewer would never run (minimum is 2)`)
        } else {
          const envMax = parseInt(process.env.AGENTBOARD_MAX_REVIEW_ITERATIONS ?? '10', 10)
          const ceiling = (Number.isInteger(envMax) && envMax > 0) ? envMax : 10
          if (maxIter > ceiling) {
            errors.push(`${prefix}.max_iterations must not exceed ${ceiling} (AGENTBOARD_MAX_REVIEW_ITERATIONS)`)
          }
        }
      }
      // on_max_iterations validation
      if ('on_max_iterations' in step && step.on_max_iterations !== undefined && step.on_max_iterations !== null) {
        const val = String(step.on_max_iterations)
        if (val !== 'escalate' && val !== 'accept_last' && val !== 'fail') {
          errors.push(`${prefix}.on_max_iterations must be one of: escalate, accept_last, fail`)
        }
      }
      // on_concern validation
      if ('on_concern' in step && step.on_concern !== undefined && step.on_concern !== null) {
        if (typeof step.on_concern !== 'object' || Array.isArray(step.on_concern)) {
          errors.push(`${prefix}.on_concern must be an object`)
        } else {
          const oc = step.on_concern as Record<string, unknown>
          if ('timeout_minutes' in oc && oc.timeout_minutes !== undefined && oc.timeout_minutes !== null) {
            const tm = Number(oc.timeout_minutes)
            if (isNaN(tm) || !Number.isInteger(tm) || tm < 1) {
              errors.push(`${prefix}.on_concern.timeout_minutes must be a positive integer`)
            }
          }
          if ('default_action' in oc && oc.default_action !== undefined && oc.default_action !== null) {
            const da = String(oc.default_action)
            if (da !== 'accept' && da !== 'reject') {
              errors.push(`${prefix}.on_concern.default_action must be 'accept' or 'reject'`)
            }
          }
        }
      }
      // verdict_field on reviewer — has default (verdict), so not required
      // Phase 21: Remove required check, verdict_field has a default value
      // Nested review_loop rejection
      if (step.producer && typeof step.producer === 'object' && !Array.isArray(step.producer)) {
        const prod = step.producer as Record<string, unknown>
        if (prod.type === 'review_loop') {
          errors.push(`${prefix}.producer cannot be a review_loop (nested review_loops not allowed)`)
        }
      }
      if (step.reviewer && typeof step.reviewer === 'object' && !Array.isArray(step.reviewer)) {
        const rev = step.reviewer as Record<string, unknown>
        if (rev.type === 'review_loop') {
          errors.push(`${prefix}.reviewer cannot be a review_loop (nested review_loops not allowed)`)
        }
      }
      break
    }

    case 'spec_validate': {
      if (!hasStringField(step, 'spec_path')) {
        errors.push(`${prefix}.spec_path is required for spec_validate steps`)
      } else {
        const sp = step.spec_path as string
        if (sp.length > 4096) {
          errors.push(`${prefix}.spec_path exceeds maximum length of 4096 characters`)
        }
        if (sp.includes('..')) {
          errors.push(`${prefix}.spec_path must not contain '..' segments`)
        }
      }
      if (!hasStringField(step, 'schema_path')) {
        errors.push(`${prefix}.schema_path is required for spec_validate steps`)
      } else {
        const schp = step.schema_path as string
        if (schp.length > 4096) {
          errors.push(`${prefix}.schema_path exceeds maximum length of 4096 characters`)
        }
        if (schp.includes('..')) {
          errors.push(`${prefix}.schema_path must not contain '..' segments`)
        }
      }
      // constitution_sections — optional, array of strings (reuses review_loop field)
      if ('constitution_sections' in step && step.constitution_sections !== undefined && step.constitution_sections !== null) {
        if (!Array.isArray(step.constitution_sections)) {
          errors.push(`${prefix}.constitution_sections must be an array of strings`)
        } else {
          for (let j = 0; j < (step.constitution_sections as unknown[]).length; j++) {
            if (typeof (step.constitution_sections as unknown[])[j] !== 'string') {
              errors.push(`${prefix}.constitution_sections[${j}] must be a string`)
            }
          }
        }
      }
      // strict — optional boolean
      if ('strict' in step && step.strict !== undefined && step.strict !== null) {
        const val = String(step.strict)
        if (val !== 'true' && val !== 'false') {
          errors.push(`${prefix}.strict must be a boolean`)
        }
      }
      break
    }

    case 'amendment_check': {
      if (!hasStringField(step, 'signal_dir')) {
        errors.push(`${prefix}: amendment_check step requires 'signal_dir' (non-empty string)`)
      }
      if ('signal_types' in step && step.signal_types !== undefined) {
        if (!Array.isArray(step.signal_types)) {
          errors.push(`${prefix}: 'signal_types' must be an array of strings`)
        } else if (step.signal_types.some((t: unknown) => typeof t !== 'string')) {
          errors.push(`${prefix}: 'signal_types' entries must be strings`)
        }
      }
      if ('on_amendment' in step && step.on_amendment !== undefined) {
        if (typeof step.on_amendment !== 'object' || step.on_amendment === null) {
          errors.push(`${prefix}: 'on_amendment' must be an object`)
        }
      }
      if ('on_human_required' in step && step.on_human_required !== undefined) {
        if (typeof step.on_human_required !== 'object' || step.on_human_required === null) {
          errors.push(`${prefix}: 'on_human_required' must be an object`)
        }
      }
      if ('on_exploration_required' in step && step.on_exploration_required !== undefined) {
        if (typeof step.on_exploration_required !== 'object' || step.on_exploration_required === null) {
          errors.push(`${prefix}: 'on_exploration_required' must be an object`)
        }
      }
      if ('budget' in step && step.budget !== undefined) {
        if (typeof step.budget !== 'object' || step.budget === null) {
          errors.push(`${prefix}: 'budget' must be an object`)
        }
      }
      // timeoutSeconds is validated in common fields section (lines 579-588)
      // No need for duplicate validation here
      break
    }

    case 'reconcile-spec': {
      // P-8 (REQ-36): reconcile-spec requires batch_threshold and signal_dir
      if (!hasStringField(step, 'signal_dir')) {
        errors.push(`Step "${String(step.name ?? prefix)}": reconcile-spec requires signal_dir`)
      } else {
        const sd = step.signal_dir as string
        if (sd.includes('..')) {
          errors.push(`${prefix}.signal_dir must not contain '..' segments`)
        }
      }
      if ('batch_threshold' in step && step.batch_threshold !== undefined && step.batch_threshold !== null) {
        const bt = Number(step.batch_threshold)
        if (isNaN(bt) || !Number.isInteger(bt) || bt < 1) {
          errors.push(`Step "${String(step.name ?? prefix)}": reconcile-spec batch_threshold must be a positive integer`)
        }
      }
      if ('signal_types' in step && step.signal_types !== undefined) {
        if (!Array.isArray(step.signal_types)) {
          errors.push(`${prefix}: 'signal_types' must be an array of strings`)
        } else if (step.signal_types.some((t: unknown) => typeof t !== 'string')) {
          errors.push(`${prefix}: 'signal_types' entries must be strings`)
        }
      }
      // reconcile-spec is standalone (like amendment_check) — no nested steps
      if (('steps' in step && Array.isArray(step.steps)) || ('children' in step && step.children !== undefined)) {
        errors.push(`Step "${String(step.name ?? prefix)}": reconcile-spec cannot contain nested steps`)
      }
      break
    }

    // Phase 21: gemini_offload step validation
    case 'gemini_offload': {
      // prompt_template — required
      if (!hasStringField(step, 'prompt_template')) {
        errors.push(`${prefix}.prompt_template is required for gemini_offload steps`)
      } else {
        const pt = step.prompt_template as string
        if (pt.length > 100000) {
          errors.push(`${prefix}.prompt_template exceeds maximum length of 100000 characters`)
        }
      }
      // model — optional string (e.g., 'gemini-2.5-flash')
      if ('model' in step && step.model !== undefined && step.model !== null) {
        if (typeof step.model !== 'string') {
          errors.push(`${prefix}.model must be a string`)
        }
      }
      // max_tokens — optional positive integer
      if ('max_tokens' in step && step.max_tokens !== undefined && step.max_tokens !== null) {
        const mt = Number(step.max_tokens)
        if (isNaN(mt) || !Number.isInteger(mt) || mt < 1) {
          errors.push(`${prefix}.max_tokens must be a positive integer`)
        } else if (mt > 1000000) {
          errors.push(`${prefix}.max_tokens must not exceed 1000000`)
        }
      }
      // temperature — optional number 0-2
      if ('temperature' in step && step.temperature !== undefined && step.temperature !== null) {
        const temp = Number(step.temperature)
        if (isNaN(temp) || temp < 0 || temp > 2) {
          errors.push(`${prefix}.temperature must be a number between 0 and 2`)
        }
      }
      break
    }

    // Phase 21: aggregator step validation
    case 'aggregator': {
      // input_steps — required, non-empty array of strings
      if (!('input_steps' in step) || !Array.isArray(step.input_steps)) {
        errors.push(`${prefix}.input_steps is required (non-empty array of strings) for aggregator steps`)
      } else {
        const inputSteps = step.input_steps as unknown[]
        if (inputSteps.length === 0) {
          errors.push(`${prefix}.input_steps must contain at least 1 step reference`)
        }
        for (let j = 0; j < inputSteps.length; j++) {
          if (typeof inputSteps[j] !== 'string') {
            errors.push(`${prefix}.input_steps[${j}] must be a string`)
          }
        }
      }
      // output_file — optional path
      if (hasStringField(step, 'output_file')) {
        const of = step.output_file as string
        if (of.includes('..')) {
          errors.push(`${prefix}.output_file must not contain '..' segments`)
        }
      }
      break
    }

    // Phase 21: human_gate step validation
    case 'human_gate': {
      // No required fields beyond name — human_gate is a pause point
      break
    }
  }

  // Phase 21: expect field validation (for native_step TDD red verification)
  if ('expect' in step && step.expect !== undefined && step.expect !== null) {
    const expectVal = String(step.expect)
    if (expectVal !== 'pass' && expectVal !== 'fail') {
      errors.push(`${prefix}.expect must be 'pass' or 'fail' (got "${expectVal}")`)
    }
    if (type !== 'native_step') {
      errors.push(`${prefix}.expect is only supported on native_step steps`)
    }
  }

  // Phase 15: on_error validation (REQ-23, REQ-25) - common to all step types
  if ('on_error' in step && step.on_error !== undefined && step.on_error !== null) {
    validateOnErrorField(step.on_error, prefix, errors)
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

  // P2-18: Validate amendment_budget numeric values (0 is ambiguous/useless)
  if ('amendment_budget' in step && step.amendment_budget !== undefined && step.amendment_budget !== null) {
    if (typeof step.amendment_budget !== 'object' || Array.isArray(step.amendment_budget)) {
      errors.push(`${prefix}.amendment_budget must be an object`)
    } else {
      const budget = step.amendment_budget as Record<string, unknown>
      for (const [categoryKey, categoryVal] of Object.entries(budget)) {
        if (categoryVal !== null && categoryVal !== undefined && typeof categoryVal === 'object' && !Array.isArray(categoryVal)) {
          const cat = categoryVal as Record<string, unknown>
          for (const [limitKey, limitVal] of Object.entries(cat)) {
            if (limitVal !== undefined && limitVal !== null) {
              const n = Number(limitVal)
              if (isNaN(n) || !Number.isInteger(n) || n < 0) {
                errors.push(`${prefix}.amendment_budget.${categoryKey}.${limitKey} must be a non-negative integer`)
              } else if (n === 0) {
                errors.push(`${prefix}.amendment_budget.${categoryKey}.${limitKey} is 0, which disables amendments entirely — use a positive integer or remove this field`)
              }
            }
          }
        }
      }
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
  // Phase 21: Support string condition expressions (e.g., "tier >= 2", "classification.type == dependency_update")
  if (typeof conditionRaw === 'string') {
    const expr = conditionRaw.trim()
    if (expr.length === 0) {
      errors.push(`${prefix}.condition string expression must be non-empty`)
    } else if (expr.length > 1024) {
      errors.push(`${prefix}.condition string expression exceeds maximum length of 1024 characters`)
    }
    // String expressions are validated at runtime by conditionEvaluator
    return
  }

  if (typeof conditionRaw !== 'object' || conditionRaw === null || Array.isArray(conditionRaw)) {
    errors.push(`${prefix}.condition must be an object or string expression`)
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

// ─── Phase 15: on_error Validation (REQ-23, REQ-25) ─────────────────────────

function validateOnErrorField(
  onError: unknown,
  prefix: string,
  errors: string[],
): void {
  if (!Array.isArray(onError)) {
    errors.push(`${prefix}.on_error must be an array of cleanup actions`)
    return
  }
  for (let i = 0; i < onError.length; i++) {
    const actionRaw = onError[i]
    const aPrefix = `${prefix}.on_error[${i}]`
    if (actionRaw === null || actionRaw === undefined || typeof actionRaw !== 'object' || Array.isArray(actionRaw)) {
      errors.push(`${aPrefix} must be an object`)
      continue
    }
    const action = actionRaw as Record<string, unknown>
    // type — required, must be 'native_step' (REQ-25)
    if (!hasStringField(action, 'type')) {
      errors.push(`${aPrefix}.type is required`)
    } else if (action.type !== 'native_step') {
      errors.push(`${aPrefix}.type must be "native_step" (got "${action.type}")`)
    }
    // command — required
    if (!hasStringField(action, 'command')) {
      errors.push(`${aPrefix}.command is required for cleanup actions`)
    }
    // working_dir — optional, no path traversal
    if (hasStringField(action, 'working_dir')) {
      if ((action.working_dir as string).includes('..')) {
        errors.push(`${aPrefix}.working_dir must not contain '..' segments`)
      }
    }
    // timeoutSeconds — optional, positive integer
    if ('timeoutSeconds' in action && action.timeoutSeconds !== undefined && action.timeoutSeconds !== null) {
      const timeout = Number(action.timeoutSeconds)
      if (isNaN(timeout) || timeout <= 0 || !Number.isInteger(timeout)) {
        errors.push(`${aPrefix}.timeoutSeconds must be a positive integer`)
      }
    }
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
  if (step.enforce_verdict && typeof step.enforce_verdict === 'object' && !Array.isArray(step.enforce_verdict)) {
    const ev = step.enforce_verdict as Record<string, unknown>
    result.enforce_verdict = {
      field: hasStringField(ev, 'field') ? ev.field as string : 'overall_verdict',
      allowed: Array.isArray(ev.allowed) ? (ev.allowed as unknown[]).map(a => String(a)) : ['pass'],
      fail_message: hasStringField(ev, 'fail_message') ? ev.fail_message as string : undefined,
    }
  }
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
  if (hasStringField(step, 'model')) {
    result.model = step.model as string
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

  // Phase 25: checks array for multi-command verification steps
  if (Array.isArray(step.checks)) {
    result.checks = (step.checks as unknown[])
      .filter(c => c !== null && c !== undefined && typeof c === 'object' && !Array.isArray(c))
      .map(c => {
        const raw = c as Record<string, unknown>
        const check: import('../shared/types').Check = {
          name: hasStringField(raw, 'name') ? raw.name as string : 'unnamed',
        }
        if (hasStringField(raw, 'description')) check.description = raw.description as string
        if (hasStringField(raw, 'command')) check.command = raw.command as string
        if (hasStringField(raw, 'check')) check.check = raw.check as string
        if (hasStringField(raw, 'condition')) check.condition = raw.condition as string
        if (raw.on_failure && typeof raw.on_failure === 'object' && !Array.isArray(raw.on_failure)) {
          const of = raw.on_failure as Record<string, unknown>
          check.on_failure = {
            action: (hasStringField(of, 'action') && (of.action === 'pause' || of.action === 'fail'))
              ? of.action as 'pause' | 'fail'
              : 'fail',
            message: hasStringField(of, 'message') ? of.message as string : '',
          }
        } else if (hasStringField(raw, 'on_failure')) {
          // Shorthand: on_failure: pause
          check.on_failure = {
            action: raw.on_failure === 'pause' ? 'pause' : 'fail',
            message: hasStringField(raw, 'message') ? raw.message as string : '',
          }
        }
        return check
      })
  }

  // Phase 25: review_routing_validation section
  if (step.review_routing_validation && typeof step.review_routing_validation === 'object' && !Array.isArray(step.review_routing_validation)) {
    const rrv = step.review_routing_validation as Record<string, unknown>
    result.review_routing_validation = {}
    if (hasStringField(rrv, 'when')) result.review_routing_validation.when = rrv.when as string
    if (Array.isArray(rrv.checks)) {
      result.review_routing_validation.checks = (rrv.checks as unknown[])
        .filter(c => c !== null && c !== undefined && typeof c === 'object' && !Array.isArray(c))
        .map(c => {
          const raw = c as Record<string, unknown>
          const check: import('../shared/types').Check = {
            name: hasStringField(raw, 'name') ? raw.name as string : 'unnamed',
          }
          if (hasStringField(raw, 'check')) check.check = raw.check as string
          if (raw.on_failure && typeof raw.on_failure === 'object' && !Array.isArray(raw.on_failure)) {
            const of = raw.on_failure as Record<string, unknown>
            check.on_failure = {
              action: (hasStringField(of, 'action') && (of.action === 'pause' || of.action === 'fail'))
                ? of.action as 'pause' | 'fail' : 'fail',
              message: hasStringField(of, 'message') ? of.message as string : '',
            }
          } else if (hasStringField(raw, 'on_failure')) {
            check.on_failure = {
              action: raw.on_failure === 'pause' ? 'pause' : 'fail',
              message: hasStringField(raw, 'message') ? raw.message as string : '',
            }
          }
          return check
        })
    }
  }

  // Phase 26: review step fields
  if (hasStringField(step, 'target_path')) result.target_path = step.target_path as string
  if (step.work_order && typeof step.work_order === 'object' && !Array.isArray(step.work_order)) {
    result.work_order = step.work_order as Record<string, unknown>
  }
  if (step.review_config && typeof step.review_config === 'object' && !Array.isArray(step.review_config)) {
    result.review_config = step.review_config as Record<string, unknown>
  }

  // Tier fields (common to all step types)
  if ('tier_min' in step && step.tier_min !== undefined && step.tier_min !== null) {
    result.tier_min = Number(step.tier_min)
  }
  if ('tier_max' in step && step.tier_max !== undefined && step.tier_max !== null) {
    result.tier_max = Number(step.tier_max)
  }

  // Condition
  if (typeof step.condition === 'string') {
    // Phase 21: String condition expression
    result.condition = { type: 'expression', expr: (step.condition as string).trim() }
  } else if (step.condition && typeof step.condition === 'object' && !Array.isArray(step.condition)) {
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
    // Phase 25: Step-level failure policy (native_step, spawn_session)
    if (of === 'completed_with_warnings' || of === 'skip') {
      result.on_step_failure = of
    }
  }
  if ('max_parallel' in step && step.max_parallel !== undefined && step.max_parallel !== null) {
    const mp = Number(step.max_parallel)
    if (Number.isInteger(mp) && mp >= 1) {
      result.max_parallel = mp
    }
  }
  // Phase 21: Support 'children' as alias for 'steps' (pipeline YAML compat)
  const childArray = Array.isArray(step.steps) ? step.steps : Array.isArray(step.children) ? step.children : null
  if (childArray) {
    result.steps = (childArray as unknown[])
      .filter(c => c !== null && c !== undefined && typeof c === 'object' && !Array.isArray(c))
      .map(c => {
        const child = c as Record<string, unknown>
        const childType = hasStringField(child, 'type') && VALID_STEP_TYPES.has(child.type as string)
          ? (child.type as WorkflowStepType)
          : null
        return buildWorkflowStep(child, childType)
      })
  }

  // Phase 7: Signal protocol fields
  if ('signal_protocol' in step && step.signal_protocol !== undefined && step.signal_protocol !== null) {
    result.signal_protocol = String(step.signal_protocol) === 'true'
  }
  if (hasStringField(step, 'signal_dir')) result.signal_dir = step.signal_dir as string
  if ('signal_timeout_seconds' in step && step.signal_timeout_seconds !== undefined && step.signal_timeout_seconds !== null) {
    result.signal_timeout_seconds = Number(step.signal_timeout_seconds)
  }

  // Phase 9: spec_validate fields
  if (hasStringField(step, 'spec_path')) result.spec_path = step.spec_path as string
  if (hasStringField(step, 'schema_path')) result.schema_path = step.schema_path as string
  if ('strict' in step && step.strict !== undefined && step.strict !== null) {
    result.strict = String(step.strict) === 'true'
  }
  if (Array.isArray(step.constitution_sections)) {
    result.constitution_sections = (step.constitution_sections as unknown[]).map(s => String(s))
  }

  // P-8: reconcile-spec fields
  if ('batch_threshold' in step && step.batch_threshold !== undefined && step.batch_threshold !== null) {
    const bt = Number(step.batch_threshold)
    if (Number.isInteger(bt) && bt >= 1) {
      result.batch_threshold = bt
    }
  }

  // Phase 10: amendment_check fields
  if (Array.isArray(step.signal_types)) {
    result.signal_types = (step.signal_types as unknown[]).map(s => String(s))
  }
  if (step.on_amendment !== undefined && typeof step.on_amendment === 'object' && step.on_amendment !== null) {
    result.on_amendment = step.on_amendment as WorkflowStep['on_amendment']
  }
  if (step.on_human_required !== undefined && typeof step.on_human_required === 'object' && step.on_human_required !== null) {
    result.on_human_required = step.on_human_required as WorkflowStep['on_human_required']
  }
  if (step.on_exploration_required !== undefined && typeof step.on_exploration_required === 'object' && step.on_exploration_required !== null) {
    result.on_exploration_required = step.on_exploration_required as WorkflowStep['on_exploration_required']
  }
  // Phase 10: amendment fields on spawn_session steps
  if ('can_request_amendment' in step && step.can_request_amendment !== undefined) {
    result.can_request_amendment = String(step.can_request_amendment) === 'true'
  }
  if (step.amendment_config !== undefined && typeof step.amendment_config === 'object' && step.amendment_config !== null) {
    result.amendment_config = step.amendment_config as WorkflowStep['amendment_config']
  }
  if (step.amendment_budget !== undefined && typeof step.amendment_budget === 'object' && step.amendment_budget !== null) {
    result.amendment_budget = step.amendment_budget as WorkflowStep['amendment_budget']
  }

  // Phase 21: expect field (native_step TDD red verification)
  if (hasStringField(step, 'expect')) {
    const ev = step.expect as string
    if (ev === 'pass' || ev === 'fail') {
      result.expect = ev
    }
  }

  // Phase 21: gemini_offload fields
  if (hasStringField(step, 'prompt_template')) result.prompt_template = step.prompt_template as string
  if (Array.isArray(step.input_files)) {
    result.input_files = (step.input_files as unknown[]).map(f => String(f))
  }
  // Also support 'inputs' as array of objects/strings (pipeline YAML format)
  if (Array.isArray(step.inputs)) {
    result.inputs = step.inputs as unknown[]
    // If no input_files set, extract paths from inputs array
    if (!result.input_files) {
      result.input_files = (step.inputs as unknown[])
        .map(inp => {
          if (typeof inp === 'string') return inp
          if (inp && typeof inp === 'object' && 'path' in (inp as Record<string, unknown>)) {
            return String((inp as Record<string, unknown>).path)
          }
          return null
        })
        .filter((p): p is string => p !== null)
    }
  }
  if (hasStringField(step, 'output_file')) result.output_file = step.output_file as string
  if (hasStringField(step, 'output_path')) {
    // Pipeline YAMLs use output_path, map to output_file for gemini_offload
    if (!result.output_file) result.output_file = step.output_path as string
  }
  if ('max_tokens' in step && step.max_tokens !== undefined && step.max_tokens !== null) {
    result.max_tokens = Number(step.max_tokens)
  }
  if ('temperature' in step && step.temperature !== undefined && step.temperature !== null) {
    result.temperature = Number(step.temperature)
  }

  // Phase 21: aggregator fields
  if (Array.isArray(step.input_steps)) {
    result.input_steps = (step.input_steps as unknown[]).map(s => String(s))
  }
  if (hasStringField(step, 'dedup_key')) result.dedup_key = step.dedup_key as string
  if ('evidence_required' in step && step.evidence_required !== undefined && step.evidence_required !== null) {
    result.evidence_required = String(step.evidence_required) === 'true'
  }
  if (step.verdict_rules && Array.isArray(step.verdict_rules)) {
    result.verdict_rules = (step.verdict_rules as unknown[]).map(rule => {
      const r = rule as Record<string, unknown>
      return {
        condition: String(r.condition ?? ''),
        verdict: (r.verdict === 'PASS' || r.verdict === 'WARN' || r.verdict === 'FAIL')
          ? r.verdict as 'PASS' | 'WARN' | 'FAIL'
          : 'PASS',
      }
    })
  }

  // Phase 21: per_work_unit fields (on spawn_session)
  if (step.per_work_unit && typeof step.per_work_unit === 'object' && !Array.isArray(step.per_work_unit)) {
    const pwu = step.per_work_unit as Record<string, unknown>
    result.per_work_unit = {
      manifest_path: hasStringField(pwu, 'manifest_path') ? (pwu.manifest_path as string) : undefined,
      execution_mode: hasStringField(pwu, 'execution_mode')
        ? ((pwu.execution_mode as string) === 'parallel' ? 'parallel' : 'sequential')
        : undefined,
      substeps: Array.isArray(pwu.substeps)
        ? (pwu.substeps as unknown[])
            .filter(s => s !== null && s !== undefined && typeof s === 'object' && !Array.isArray(s))
            .map(s => {
              const sub = s as Record<string, unknown>
              const subType = hasStringField(sub, 'type') && VALID_STEP_TYPES.has(sub.type as string)
                ? (sub.type as WorkflowStepType)
                : null
              return buildWorkflowStep(sub, subType)
            })
        : undefined,
    }
  }

  // Phase 21: Pipeline passthrough fields (preserved but not actively executed)
  if (hasStringField(step, 'agent')) result.agent = step.agent as string
  if (hasStringField(step, 'posture')) result.posture = step.posture as string
  if (hasStringField(step, 'description')) result.description = step.description as string
  if (Array.isArray(step.outputs)) result.outputs = step.outputs as unknown[]
  if (Array.isArray(step.soft_depends_on)) {
    result.soft_depends_on = (step.soft_depends_on as unknown[]).map(d => String(d).trim()).filter(d => d.length > 0)
  }
  if ('optional' in step && step.optional !== undefined && step.optional !== null) {
    result.optional = String(step.optional) === 'true'
  }
  if (hasStringField(step, 'dependency_mode')) result.dependency_mode = step.dependency_mode as string
  if (hasStringField(step, 'fallback_agent')) result.fallback_agent = step.fallback_agent as string
  if (hasStringField(step, 'agent_prompt_override')) result.agent_prompt_override = step.agent_prompt_override as string
  if ('timeout_seconds' in step && step.timeout_seconds !== undefined && step.timeout_seconds !== null) {
    result.timeout_seconds = Number(step.timeout_seconds)
    // Also map to timeoutSeconds if not already set
    if (!result.timeoutSeconds) result.timeoutSeconds = result.timeout_seconds
  }

  // Phase 15: on_error field (REQ-23)
  if (Array.isArray(step.on_error)) {
    result.on_error = (step.on_error as unknown[])
      .filter(a => a !== null && a !== undefined && typeof a === 'object' && !Array.isArray(a))
      .map(a => {
        const action = a as Record<string, unknown>
        return {
          type: 'native_step' as const,
          command: String(action.command ?? ''),
          working_dir: hasStringField(action, 'working_dir') ? (action.working_dir as string) : undefined,
          timeoutSeconds: ('timeoutSeconds' in action && action.timeoutSeconds !== undefined)
            ? Number(action.timeoutSeconds) : undefined,
        }
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
  // Phase 8: review_loop enhanced fields
  if (hasStringField(step, 'on_max_iterations')) {
    const val = step.on_max_iterations as string
    if (val === 'escalate' || val === 'accept_last' || val === 'fail') {
      result.on_max_iterations = val
    }
  }
  if (step.on_concern && typeof step.on_concern === 'object' && !Array.isArray(step.on_concern)) {
    const oc = step.on_concern as Record<string, unknown>
    result.on_concern = {
      timeout_minutes: ('timeout_minutes' in oc && oc.timeout_minutes !== undefined && oc.timeout_minutes !== null)
        ? Number(oc.timeout_minutes) : undefined,
      default_action: (hasStringField(oc, 'default_action') && (oc.default_action === 'accept' || oc.default_action === 'reject'))
        ? oc.default_action as 'accept' | 'reject' : undefined,
    }
  }
  if (hasStringField(step, 'verdict_field')) result.verdict_field = step.verdict_field as string
  if (hasStringField(step, 'feedback_field')) result.feedback_field = step.feedback_field as string
  if (step.tier_override && typeof step.tier_override === 'object' && !Array.isArray(step.tier_override)) {
    result.tier_override = step.tier_override as Record<string, Record<string, unknown>>
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
  const regex = /\{\{\s*([\w.]+)\s*\}\}/g

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

  function subStep(step: WorkflowStep): WorkflowStep {
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
    if (result.signal_dir) result.signal_dir = subPath(result.signal_dir)
    if (result.spec_path) result.spec_path = subPath(result.spec_path)
    if (result.schema_path) result.schema_path = subPath(result.schema_path)
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
    // Recurse into nested step definitions (review_loop producer/reviewer, parallel_group children)
    if (result.producer) result.producer = subStep(result.producer)
    if (result.reviewer) result.reviewer = subStep(result.reviewer)
    if (result.steps) result.steps = result.steps.map(subStep)
    return result
  }

  return steps.map(subStep)
}

/**
 * Apply pipeline defaults to steps. Step-level values always win.
 * Defaults may contain {{ }} placeholders — they will be resolved
 * by substituteVariables in the subsequent pass.
 */
export function applyDefaults(steps: WorkflowStep[], defaults: PipelineDefaults): WorkflowStep[] {
  return steps.map(step => {
    const result: WorkflowStep = { ...step }

    // timeoutSeconds — fallback (step wins)
    if (result.timeoutSeconds === undefined && defaults.timeoutSeconds !== undefined) {
      result.timeoutSeconds = defaults.timeoutSeconds
    }

    // maxRetries — fallback (step wins)
    if (result.maxRetries === undefined && defaults.maxRetries !== undefined) {
      result.maxRetries = defaults.maxRetries
    }

    // env — merge (default + step, step keys win on conflict)
    if (defaults.env) {
      result.env = { ...defaults.env, ...result.env }
    }

    // signal_protocol — only applies to spawn_session and review_loop
    if (defaults.signal_protocol !== undefined && result.signal_protocol === undefined) {
      if (result.type === 'spawn_session' || result.type === 'review_loop') {
        result.signal_protocol = defaults.signal_protocol
      }
    }

    // signal_dir — only applies to spawn_session, review_loop, amendment_check, reconcile-spec
    if (defaults.signal_dir && !result.signal_dir) {
      if (result.type === 'spawn_session' || result.type === 'review_loop' || result.type === 'amendment_check' || result.type === 'reconcile-spec') {
        result.signal_dir = defaults.signal_dir
      }
    }

    // working_dir — only applies to native_step and spawn_session
    if (defaults.working_dir && !result.working_dir) {
      if (result.type === 'native_step' || result.type === 'spawn_session') {
        result.working_dir = defaults.working_dir
      }
    }

    // constitution_sections — fallback for spec_validate
    if (defaults.constitution_sections && !result.constitution_sections) {
      if (result.type === 'spec_validate') {
        result.constitution_sections = [...defaults.constitution_sections]
      }
    }

    // Apply defaults to parallel_group children recursively
    if (result.type === 'parallel_group' && result.steps) {
      result.steps = applyDefaults(result.steps, defaults)
    }

    // Apply defaults to review_loop producer and reviewer
    if (result.type === 'review_loop') {
      if (result.producer) {
        result.producer = applyDefaults([result.producer], defaults)[0]
      }
      if (result.reviewer) {
        result.reviewer = applyDefaults([result.reviewer], defaults)[0]
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
