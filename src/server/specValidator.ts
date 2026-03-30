/**
 * specValidator.ts — Spec validation utility for spec_validate step type (Phase 9)
 *
 * Pure utility module with NO engine dependencies. Validates feature specs
 * against YAML-based schemas and runs constitution checks.
 */

import { readFileSync, existsSync } from 'node:fs'
import yaml from 'js-yaml'

// ─── Public Types ───────────────────────────────────────────────────────────

export interface SpecValidationError {
  field: string
  message: string
  type: 'missing_required' | 'wrong_type' | 'constraint' | 'untyped_criterion' | 'schema_version_mismatch'
}

export interface ConstitutionCheckResult {
  section: string
  result: 'pass' | 'fail'
  findings: string[]
}

export interface SpecValidationReport {
  spec_path: string
  schema: string
  valid: boolean
  errors: SpecValidationError[]
  warnings: SpecValidationError[]
  constitution_checks: ConstitutionCheckResult[]
}

// ─── Constitution Check Patterns (default fallback) ────────────────────────

const CONSTITUTION_CHECKS: Record<string, { patterns: RegExp[]; description: string; severity?: string; special?: string }> = {
  security: {
    patterns: [
      /AKIA[0-9A-Z]{16}/,                    // AWS access key
      /(?:password|passwd|secret)\s*[:=]\s*\S+/i,  // Password patterns
      /(?:mysql|postgres|mongodb):\/\/[^@\s]+@/i,  // Connection strings with credentials
    ],
    description: 'Secrets or credentials detected in spec',
    severity: 'fail',
  },
  architecture: {
    patterns: [
      /\*\*\/\*/,                             // Wildcard scope **/*
      /\*\.\*/,                               // Wildcard scope *.*
    ],
    description: 'Wildcard scope detected (overly broad)',
    severity: 'fail',
  },
  quality: {
    // This is handled specially - checks for untyped acceptance criteria
    patterns: [],
    description: 'Untyped acceptance criteria',
    severity: 'warn',
    special: 'acceptance_typing',
  },
}

// ─── Constitution File Loading ─────────────────────────────────────────────

interface ConstitutionPatternDef {
  regex: string
  flags?: string
  description?: string
}

interface ConstitutionSectionDef {
  description?: string
  severity?: string
  special?: string
  patterns?: ConstitutionPatternDef[]
}

interface ConstitutionFile {
  version?: number
  sections?: Record<string, ConstitutionSectionDef>
}

/**
 * Load constitution rules from a YAML file. Returns null if file doesn't exist
 * or can't be parsed, allowing fallback to hardcoded defaults.
 */
export function loadConstitution(
  constitutionPath: string,
): Record<string, { patterns: RegExp[]; description: string; severity?: string; special?: string }> | null {
  if (!existsSync(constitutionPath)) {
    return null
  }

  try {
    const content = readFileSync(constitutionPath, 'utf-8')
    const parsed = yaml.load(content) as ConstitutionFile
    if (!parsed || typeof parsed !== 'object' || !parsed.sections) {
      return null
    }

    const result: Record<string, { patterns: RegExp[]; description: string; severity?: string; special?: string }> = {}

    for (const [sectionName, sectionDef] of Object.entries(parsed.sections)) {
      const patterns: RegExp[] = []
      if (sectionDef.patterns && Array.isArray(sectionDef.patterns)) {
        for (const pat of sectionDef.patterns) {
          if (pat.regex) {
            patterns.push(new RegExp(pat.regex, pat.flags || ''))
          }
        }
      }
      result[sectionName] = {
        patterns,
        description: sectionDef.description || sectionName,
        severity: sectionDef.severity,
        special: sectionDef.special,
      }
    }

    return result
  } catch {
    return null
  }
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Validate a spec file against a schema and optional constitution sections.
 *
 * @param specPath - Path to the YAML spec file
 * @param schemaPath - Path to the YAML schema file
 * @param constitutionSections - Optional array of constitution section names to check
 * @param strict - If true, warnings are promoted to errors (causes failure)
 * @param constitutionPath - Optional path to a constitution YAML file (falls back to hardcoded defaults)
 */
export function validateSpec(
  specPath: string,
  schemaPath: string,
  constitutionSections: string[] = [],
  strict: boolean = false,
  constitutionPath?: string,
): SpecValidationReport {
  const report: SpecValidationReport = {
    spec_path: specPath,
    schema: schemaPath,
    valid: true,
    errors: [],
    warnings: [],
    constitution_checks: [],
  }

  // Load and parse spec
  let spec: Record<string, unknown>
  try {
    const specContent = readFileSync(specPath, 'utf-8')
    const parsed = yaml.load(specContent, { schema: yaml.FAILSAFE_SCHEMA })
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      report.errors.push({ field: '', message: 'Spec must parse to an object', type: 'constraint' })
      report.valid = false
      return report
    }
    spec = parsed as Record<string, unknown>
  } catch (err) {
    report.errors.push({ field: '', message: `Failed to read/parse spec: ${String(err)}`, type: 'constraint' })
    report.valid = false
    return report
  }

  // Load and parse schema
  let schema: Record<string, unknown>
  try {
    const schemaContent = readFileSync(schemaPath, 'utf-8')
    const parsed = yaml.load(schemaContent, { schema: yaml.FAILSAFE_SCHEMA })
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      report.errors.push({ field: '', message: 'Schema must parse to an object', type: 'constraint' })
      report.valid = false
      return report
    }
    schema = parsed as Record<string, unknown>
  } catch (err) {
    report.errors.push({ field: '', message: `Failed to read/parse schema: ${String(err)}`, type: 'constraint' })
    report.valid = false
    return report
  }

  // Schema version check
  if (schema.version && spec.schema_version) {
    if (String(spec.schema_version) !== String(schema.version)) {
      report.errors.push({
        field: 'schema_version',
        message: `Schema version mismatch: spec has "${spec.schema_version}", schema requires "${schema.version}"`,
        type: 'schema_version_mismatch',
      })
    }
  }

  // Validate required fields
  if (schema.required_fields && typeof schema.required_fields === 'object' && !Array.isArray(schema.required_fields)) {
    const requiredFields = schema.required_fields as Record<string, unknown>
    for (const [fieldName, fieldDef] of Object.entries(requiredFields)) {
      if (!(fieldName in spec) || spec[fieldName] === null || spec[fieldName] === undefined) {
        report.errors.push({
          field: fieldName,
          message: `Required field "${fieldName}" is missing`,
          type: 'missing_required',
        })
        continue
      }

      const typeError = validateFieldType(fieldName, fieldDef, spec[fieldName])
      if (typeError) {
        report.errors.push(typeError)
      }
    }
  }

  // Validate optional fields types (if present in spec)
  if (schema.optional_fields && typeof schema.optional_fields === 'object' && !Array.isArray(schema.optional_fields)) {
    const optionalFields = schema.optional_fields as Record<string, unknown>
    for (const [fieldName, fieldDef] of Object.entries(optionalFields)) {
      if (!(fieldName in spec) || spec[fieldName] === null || spec[fieldName] === undefined) {
        continue // Optional field not present, that's fine
      }
      const typeWarning = validateOptionalFieldType(fieldName, fieldDef, spec[fieldName])
      if (typeWarning) {
        report.warnings.push(typeWarning)
      }
    }
  }

  // Check acceptance criteria typing (quality check)
  const validAcceptanceTypes = schema.valid_acceptance_types
    ? (Array.isArray(schema.valid_acceptance_types)
        ? (schema.valid_acceptance_types as unknown[]).map(String)
        : [])
    : []

  if (!spec.acceptance || !Array.isArray(spec.acceptance)) {
    // No acceptance criteria to validate
  } else {
    for (let i = 0; i < (spec.acceptance as unknown[]).length; i++) {
      const criterion = (spec.acceptance as unknown[])[i]
      if (!criterion || typeof criterion !== 'object' || Array.isArray(criterion)) continue
      
      const crit = criterion as Record<string, unknown>
      if (!('type' in crit) || !crit.type) {
        report.warnings.push({
          field: `acceptance[${i}]`,
          message: `Acceptance criterion at index ${i} is missing a "type" field`,
          type: 'untyped_criterion',
        })
      } else if (validAcceptanceTypes.length > 0 && !validAcceptanceTypes.includes(String(crit.type))) {
        report.warnings.push({
          field: `acceptance[${i}].type`,
          message: `Acceptance criterion type "${crit.type}" not in valid types: ${validAcceptanceTypes.join(', ')}`,
          type: 'constraint',
        })
      }
    }
  }

  // Constitution checks — load from file if provided, else use hardcoded defaults
  const constitutionRules = constitutionPath
    ? loadConstitution(constitutionPath) ?? CONSTITUTION_CHECKS
    : CONSTITUTION_CHECKS
  for (const section of constitutionSections) {
    const check = runConstitutionCheck(section, spec, constitutionRules)
    report.constitution_checks.push(check)
  }

  // Strict mode: warnings become errors
  if (strict) {
    for (const warning of report.warnings) {
      report.errors.push(warning)
    }
    report.warnings = []
  }

  // Set valid based on errors
  report.valid = report.errors.length === 0

  return report
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function checkFieldType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case 'string':
      return typeof value === 'string'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'number':
      // FAILSAFE_SCHEMA returns strings, so check if it's a numeric string
      return typeof value === 'string' ? !isNaN(Number(value)) : typeof value === 'number'
    case 'boolean':
      return typeof value === 'string' ? (value === 'true' || value === 'false') : typeof value === 'boolean'
    default:
      return true // Unknown type, pass
  }
}

function validateFieldType(
  fieldName: string,
  fieldDef: unknown,
  actualValue: unknown,
): SpecValidationError | null {
  if (!fieldDef || typeof fieldDef !== 'object' || Array.isArray(fieldDef)) {
    return null
  }
  const def = fieldDef as Record<string, unknown>
  if (!def.type) {
    return null
  }
  const expectedType = String(def.type)
  if (!checkFieldType(actualValue, expectedType)) {
    return {
      field: fieldName,
      message: `Field "${fieldName}" expected type "${expectedType}", got "${typeof actualValue}"`,
      type: 'wrong_type',
    }
  }
  return null
}

function validateOptionalFieldType(
  fieldName: string,
  fieldDef: unknown,
  actualValue: unknown,
): SpecValidationError | null {
  if (!fieldDef || typeof fieldDef !== 'object' || Array.isArray(fieldDef)) {
    return null
  }
  const def = fieldDef as Record<string, unknown>
  if (!def.type) {
    return null
  }
  const expectedType = String(def.type)
  if (!checkFieldType(actualValue, expectedType)) {
    return {
      field: fieldName,
      message: `Optional field "${fieldName}" expected type "${expectedType}", got "${typeof actualValue}"`,
      type: 'wrong_type',
    }
  }
  return null
}

function runConstitutionCheck(
  section: string,
  spec: Record<string, unknown>,
  rules: Record<string, { patterns: RegExp[]; description: string; severity?: string; special?: string }> = CONSTITUTION_CHECKS,
): ConstitutionCheckResult {
  const result: ConstitutionCheckResult = {
    section,
    result: 'pass',
    findings: [],
  }

  const checkDef = rules[section]
  if (!checkDef) {
    // Unknown section - pass by default
    return result
  }

  // Special handling for acceptance_typing (quality section or any section with special flag)
  if (checkDef.special === 'acceptance_typing' || (section === 'quality' && !checkDef.special)) {
    if (spec.acceptance && Array.isArray(spec.acceptance)) {
      for (let i = 0; i < (spec.acceptance as unknown[]).length; i++) {
        const criterion = (spec.acceptance as unknown[])[i]
        if (criterion && typeof criterion === 'object' && !Array.isArray(criterion)) {
          const crit = criterion as Record<string, unknown>
          if (!('type' in crit) || !crit.type) {
            result.findings.push(`acceptance[${i}]: missing type field`)
            result.result = 'fail'
          }
        }
      }
    }
    return result
  }

  // Pattern-based checks: scan all string values in the spec
  const stringValues = extractStringValues(spec)
  for (const pattern of checkDef.patterns) {
    for (const { path: fieldPath, value } of stringValues) {
      if (pattern.test(value)) {
        result.findings.push(`${fieldPath}: ${checkDef.description} (matched ${pattern.source})`)
        result.result = 'fail'
      }
    }
  }

  return result
}

function extractStringValues(
  obj: unknown,
  prefix: string = '',
): { path: string; value: string }[] {
  const results: { path: string; value: string }[] = []
  if (typeof obj === 'string') {
    results.push({ path: prefix || 'root', value: obj })
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      results.push(...extractStringValues(obj[i], `${prefix}[${i}]`))
    }
  } else if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const newPrefix = prefix ? `${prefix}.${key}` : key
      results.push(...extractStringValues(value, newPrefix))
    }
  }
  return results
}
