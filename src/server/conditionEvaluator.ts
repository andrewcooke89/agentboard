/**
 * Phase 21: Condition expression evaluator for pipeline step conditions.
 *
 * Supports:
 *   - String expressions: "tier >= 2", "classification.type == dependency_update"
 *   - Structured conditions: { type: 'file_exists', path: '...' }
 *   - Boolean combinators: AND, OR (case-insensitive)
 *   - Comparisons: ==, !=, >=, <=, >, <
 *   - Literals: quoted strings, numbers, unquoted identifiers
 *
 * Context is a flat Record<string, string|number|boolean> resolved from
 * step outputs, tier level, and pipeline variables at evaluation time.
 */

import type { StepCondition } from '../shared/types'
import { existsSync } from 'fs'
import path from 'node:path'
import os from 'node:os'

// CRIT-004: Allowed directories for file_exists check
function getAllowedDirectories(ctx: ConditionContext): string[] {
  const dirs: string[] = []

  // Add output directory if available from context
  if (ctx.variables && 'output_dir' in ctx.variables) {
    dirs.push(path.resolve(String(ctx.variables.output_dir)))
  }

  // Add project path if available
  if (ctx.variables && 'project_path' in ctx.variables) {
    dirs.push(path.resolve(String(ctx.variables.project_path)))
  }

  // Add system temp directories
  dirs.push(fs.realpathSync(os.tmpdir()))

  return dirs.filter(d => d && d.length > 0)
}

// Need to import fs for realpathSync
import fs from 'node:fs'

/**
 * CRIT-004: Validate that a path is within allowed directories.
 * Prevents path traversal attacks.
 */
function isPathAllowed(filePath: string, allowedDirs: string[]): boolean {
  try {
    const resolved = path.resolve(filePath)
    const normalized = path.normalize(resolved)

    for (const allowedDir of allowedDirs) {
      const normalizedAllowed = path.normalize(allowedDir)
      // Check if path is within allowed directory
      if (normalized === normalizedAllowed ||
          normalized.startsWith(normalizedAllowed + path.sep)) {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

export interface ConditionContext {
  tier: number
  stepOutputs: Record<string, Record<string, unknown>>  // stepName -> parsed output fields
  variables: Record<string, string>
  projectProfile?: Record<string, unknown>  // Phase 25: project profile for model_routing, compiler_ir conditions
}

/**
 * Evaluate a StepCondition against the current run context.
 * Returns true if the step should execute, false to skip.
 * CRIT-004: file_exists now validates paths against allowed directories.
 */
export function evaluateCondition(
  condition: StepCondition,
  ctx: ConditionContext,
): boolean {
  switch (condition.type) {
    case 'file_exists': {
      // CRIT-004: Validate path before checking existence
      const allowedDirs = getAllowedDirectories(ctx)
      if (!isPathAllowed(condition.path, allowedDirs)) {
        // Log warning for rejected path (use console since logger may not be available)
        console.warn(`[conditionEvaluator] Path traversal blocked: ${condition.path} not in allowed directories`)
        return false
      }
      return existsSync(condition.path)
    }

    case 'output_contains': {
      const stepOutput = ctx.stepOutputs[condition.step]
      if (!stepOutput) return false
      const content = String(stepOutput._raw ?? '')
      return content.includes(condition.contains)
    }

    case 'expression':
      return evaluateExpression(condition.expr, ctx)

    default:
      // Unknown condition type — default to true (permissive)
      return true
  }
}

/**
 * Phase 25: Evaluate a string condition expression.
 * Exported for use in DAG engine check evaluation.
 */
export { evaluateExpression }

/**
 * Evaluate a string condition expression.
 *
 * Supports:
 *   "tier >= 2"
 *   "classification.type == dependency_update"
 *   "service-management.status == 'service_available'"
 *   "tier >= 2 AND file_exists(path)"
 *   "classification.type == dependency_update && classification.tier >= 2"
 */
function evaluateExpression(expr: string, ctx: ConditionContext): boolean {
  const trimmed = expr.trim()

  // Handle AND/OR combinators (split on ' AND ', ' OR ', ' && ', ' || ')
  // OR has lower precedence than AND
  const orParts = splitOnOperator(trimmed, [' OR ', ' || '])
  if (orParts.length > 1) {
    return orParts.some(part => evaluateExpression(part, ctx))
  }

  const andParts = splitOnOperator(trimmed, [' AND ', ' && '])
  if (andParts.length > 1) {
    return andParts.every(part => evaluateExpression(part, ctx))
  }

  // Handle file_exists(path) function
  const fileExistsMatch = trimmed.match(/^file_exists\(\s*(.+?)\s*\)$/)
  if (fileExistsMatch) {
    const filePath = unquote(fileExistsMatch[1])
    // CRIT-004: Validate path before checking existence
    const allowedDirs = getAllowedDirectories(ctx)
    if (!isPathAllowed(filePath, allowedDirs)) {
      console.warn(`[conditionEvaluator] Path traversal blocked in expression: ${filePath} not in allowed directories`)
      return false
    }
    return existsSync(filePath)
  }

  // Handle 'in' operator for set membership: "value in set"
  const inMatch = trimmed.match(/^(.+?)\s+in\s+(.+)$/)
  if (inMatch) {
    const [, lhsRaw, rhsRaw] = inMatch
    const lhs = resolveValue(lhsRaw.trim(), ctx)
    const rhs = resolveValue(rhsRaw.trim(), ctx)
    return checkIn(lhs, rhs)
  }

  // Handle comparison expressions: lhs op rhs
  const compMatch = trimmed.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/)
  if (compMatch) {
    const [, lhsRaw, op, rhsRaw] = compMatch
    const lhs = resolveValue(lhsRaw.trim(), ctx)
    const rhs = resolveValue(rhsRaw.trim(), ctx)
    return compare(lhs, op, rhs)
  }

  // Bare truthy check: resolve and check if truthy
  const val = resolveValue(trimmed, ctx)
  return isTruthy(val)
}

/**
 * Split a string on any of the given operators, respecting parentheses depth.
 */
function splitOnOperator(expr: string, operators: string[]): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''

  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === '(') depth++
    else if (expr[i] === ')') depth--

    if (depth === 0) {
      let matched = false
      for (const op of operators) {
        if (expr.substring(i, i + op.length) === op) {
          parts.push(current.trim())
          current = ''
          i += op.length - 1
          matched = true
          break
        }
      }
      if (!matched) {
        current += expr[i]
      }
    } else {
      current += expr[i]
    }
  }
  if (current.trim().length > 0) {
    parts.push(current.trim())
  }
  return parts
}

/**
 * Resolve a value reference against the context.
 * Handles: dotted paths (stepName.field), 'quoted strings', numbers, tier
 * Phase 25: Also handles project_profile lookups (model_routing.*, compiler_ir.*, etc.)
 */
function resolveValue(raw: string, ctx: ConditionContext): string | number | boolean {
  // Quoted string literal
  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    return raw.slice(1, -1)
  }

  // Numeric literal
  const num = Number(raw)
  if (!isNaN(num) && raw.length > 0) {
    return num
  }

  // Boolean literals
  if (raw === 'true') return true
  if (raw === 'false') return false

  // Special: 'tier' resolves to current tier level
  if (raw === 'tier') return ctx.tier

  // Dotted path: stepName.field OR project_profile.field
  const dotIdx = raw.indexOf('.')
  if (dotIdx > 0) {
    const firstPart = raw.substring(0, dotIdx)
    const rest = raw.substring(dotIdx + 1)

    // Check step outputs first
    const stepOutput = ctx.stepOutputs[firstPart]
    if (stepOutput && rest in stepOutput) {
      const val = stepOutput[rest]
      if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
        return val
      }
      return String(val)
    }

    // Phase 25: Check project_profile for dotted lookups (model_routing.*, compiler_ir.*, etc.)
    if (ctx.projectProfile) {
      const profileVal = getNestedValue(ctx.projectProfile, raw)
      if (profileVal !== undefined) {
        if (typeof profileVal === 'string' || typeof profileVal === 'number' || typeof profileVal === 'boolean') {
          return profileVal
        }
        // Handle 'true'/'true' string values from YAML
        if (typeof profileVal === 'string' && (profileVal === 'true' || profileVal === 'false')) {
          return profileVal === 'true'
        }
        return String(profileVal)
      }
    }

    // Check variables with full dot notation
    if (raw in ctx.variables) {
      return ctx.variables[raw]
    }
  }

  // Plain variable reference
  if (raw in ctx.variables) {
    return ctx.variables[raw]
  }

  // Phase 25: Check project_profile top-level keys
  if (ctx.projectProfile && raw in ctx.projectProfile) {
    const val = ctx.projectProfile[raw]
    if (typeof val === 'boolean') return val
    if (typeof val === 'number') return val
    if (typeof val === 'string') {
      if (val === 'true') return true
      if (val === 'false') return false
      return val
    }
    return String(val)
  }

  // Unresolved — return as string for comparison
  return raw
}

/**
 * Get nested value from object using dotted path.
 * e.g., getNestedValue({a: {b: {c: 1}}}, 'a.b.c') => 1
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return current
}

function unquote(s: string): string {
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1)
  }
  return s
}

function compare(lhs: string | number | boolean, op: string, rhs: string | number | boolean): boolean {
  // If both are numeric, compare as numbers
  const lNum = typeof lhs === 'number' ? lhs : Number(lhs)
  const rNum = typeof rhs === 'number' ? rhs : Number(rhs)
  const bothNumeric = typeof lhs === 'number' && typeof rhs === 'number'
    || (!isNaN(lNum) && !isNaN(rNum) && String(lhs).length > 0 && String(rhs).length > 0)

  switch (op) {
    case '==': return String(lhs) === String(rhs)
    case '!=': return String(lhs) !== String(rhs)
    case '>=': return bothNumeric ? lNum >= rNum : String(lhs) >= String(rhs)
    case '<=': return bothNumeric ? lNum <= rNum : String(lhs) <= String(rhs)
    case '>': return bothNumeric ? lNum > rNum : String(lhs) > String(rhs)
    case '<': return bothNumeric ? lNum < rNum : String(lhs) < String(rhs)
    default: return false
  }
}

/**
 * Check if lhs is contained in rhs (for 'in' operator).
 * Supports: "value in [a, b, c]", "value in string", "value in model_routing.models"
 */
function checkIn(lhs: string | number | boolean, rhs: string | number | boolean): boolean {
  const lhsStr = String(lhs)
  const rhsStr = String(rhs)

  // Handle array-like syntax: "[a, b, c]" or "[a,b,c]"
  if (rhsStr.startsWith('[') && rhsStr.endsWith(']')) {
    const items = rhsStr.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    return items.some(item => item === lhsStr || item === lhs)
  }

  // Handle "any model has invocation: proxy" style condition
  // This becomes: "proxy in model_routing.models"
  if (rhsStr.includes('.')) {
    // For now, return true for complex conditions - they're evaluated at runtime
    return true
  }

  // Simple string contains
  return rhsStr.includes(lhsStr)
}

function isTruthy(val: string | number | boolean): boolean {
  if (typeof val === 'boolean') return val
  if (typeof val === 'number') return val !== 0
  return val !== '' && val !== 'false' && val !== '0' && val !== 'null' && val !== 'undefined'
}
