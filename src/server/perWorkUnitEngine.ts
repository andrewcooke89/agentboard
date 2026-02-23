/**
 * perWorkUnitEngine.ts -- Per-Work-Unit Expansion Engine (Phase 23)
 *
 * Expands spawn_session steps with per_work_unit configuration into N sub-steps,
 * each targeting one work unit from a manifest file.
 *
 * Supports:
 * - Sequential execution (order preserved, depends_on ignored)
 * - Parallel execution (topological sort using depends_on, cycle detection)
 * - Substep TDD cycles (write-tests -> verify-red -> implement -> verify-green)
 * - Specialist selection (tag matching against agent definitions)
 * - Per-WU amendment budget tracking
 */

import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import type { WorkflowStep } from '../shared/types'

// ─── Public Types ───────────────────────────────────────────────────────────

export interface WorkUnit {
  id: string
  scope: string
  files: string[]
  tags?: string[]
  estimated_complexity?: string
  depends_on?: string[]
  interface_dependencies?: string[]
}

export interface WorkUnitManifest {
  version: string
  work_units: WorkUnit[]
}

export interface ExpandedStep {
  /** Unique step name (e.g., "step-1.unit-auth") */
  name: string
  /** Step definition with substituted variables */
  step: WorkflowStep
  /** Parent step name (the original per_work_unit step) */
  parentStep: string
  /** Work unit ID */
  workUnitId: string
  /** For parallel: depends_on resolved to expanded step names */
  dependsOnExpanded?: string[]
  /** Output directory for this work unit */
  outputDir: string
}

export interface PerWorkUnitConfig {
  manifest_path: string
  execution_mode?: 'sequential' | 'parallel'
  substeps?: WorkflowStep[]
  specialist_selection?: {
    enabled: boolean
    tag_field?: string
    applies_to?: string
  }
}

export interface ExpansionContext {
  runId: string
  outputDir: string
  defaultAgent?: string
  variables?: Record<string, string> | null
}

// ─── Cycle Detection ────────────────────────────────────────────────────────

/**
 * HIGH-004: Detect cycles in work unit dependency graph using DFS with recursion stack.
 * Returns null if no cycle, or array of work unit IDs forming the actual cycle path.
 */
export function detectWorkUnitCycle(workUnits: WorkUnit[]): string[] | null {
  const idSet = new Set(workUnits.map(wu => wu.id))
  const adj = new Map<string, string[]>()

  // Build adjacency list
  for (const wu of workUnits) {
    adj.set(wu.id, [])
  }
  for (const wu of workUnits) {
    for (const dep of wu.depends_on ?? []) {
      if (idSet.has(dep)) {
        adj.get(dep)!.push(wu.id)
      }
    }
  }

  // HIGH-004: DFS with recursion stack to find actual cycle
  const WHITE = 0 // Not visited
  const GRAY = 1  // In current path (recursion stack)
  const BLACK = 2 // Fully processed

  const color = new Map<string, number>()
  const parent = new Map<string, string | null>()

  for (const wu of workUnits) {
    color.set(wu.id, WHITE)
    parent.set(wu.id, null)
  }

  // DFS to find cycle
  function dfs(node: string): string[] | null {
    color.set(node, GRAY)

    for (const neighbor of adj.get(node) ?? []) {
      const neighborColor = color.get(neighbor)

      if (neighborColor === GRAY) {
        // Found cycle - reconstruct path from neighbor back to itself
        // Start with neighbor (cycle start), add path back to neighbor
        const cycle: string[] = []
        let current: string | null = node
        while (current !== null && current !== neighbor) {
          cycle.unshift(current)
          current = parent.get(current) ?? null
        }
        cycle.unshift(neighbor) // Add cycle start node
        return cycle
      }

      if (neighborColor === WHITE) {
        parent.set(neighbor, node)
        const cycle = dfs(neighbor)
        if (cycle) return cycle
      }
    }

    color.set(node, BLACK)
    return null
  }

  // Try DFS from each unvisited node
  for (const wu of workUnits) {
    if (color.get(wu.id) === WHITE) {
      const cycle = dfs(wu.id)
      if (cycle) return cycle
    }
  }

  return null
}

/**
 * Topological sort for parallel execution.
 * Returns work units in dependency-resolved order.
 *
 * MED-010: This function returns a PARTIAL result if there's a cycle - work units
 * with unresolvable dependencies will be excluded from the output. The caller
 * (expandPerWorkUnit) checks for cycles using detectWorkUnitCycle BEFORE calling
 * this function, so partial results should never occur in normal operation.
 * If called directly with a cyclic graph, some work units may be silently dropped.
 *
 * @param workUnits - Array of work units with optional depends_on references
 * @returns Work units in topologically sorted order (partial if cycle exists)
 */
export function topologicalSort(workUnits: WorkUnit[]): WorkUnit[] {
  const idSet = new Set(workUnits.map(wu => wu.id))
  const adj = new Map<string, string[]>()
  const inDegree = new Map<string, number>()

  for (const wu of workUnits) {
    adj.set(wu.id, [])
    inDegree.set(wu.id, 0)
  }

  for (const wu of workUnits) {
    for (const dep of wu.depends_on ?? []) {
      if (!idSet.has(dep)) continue
      adj.get(dep)!.push(wu.id)
      inDegree.set(wu.id, (inDegree.get(wu.id) ?? 0) + 1)
    }
  }

  // Break ties by original order for determinism
  const queue: { id: string; index: number }[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      const idx = workUnits.findIndex(wu => wu.id === id)
      queue.push({ id, index: idx })
    }
  }
  queue.sort((a, b) => a.index - b.index)

  const sorted: WorkUnit[] = []
  while (queue.length > 0) {
    const { id } = queue.shift()!
    const wu = workUnits.find(w => w.id === id)
    if (wu) sorted.push(wu)

    const nextItems: { id: string; index: number }[] = []
    for (const neighbor of adj.get(id) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, newDeg)
      if (newDeg === 0) {
        const idx = workUnits.findIndex(wu => wu.id === neighbor)
        nextItems.push({ id: neighbor, index: idx })
      }
    }
    nextItems.sort((a, b) => a.index - b.index)
    queue.push(...nextItems)
  }

  return sorted
}

// ─── Manifest Parsing ────────────────────────────────────────────────────────

/**
 * Parse work unit manifest from YAML file.
 * Returns null on error.
 */
export function parseManifest(manifestPath: string, baseDir: string): WorkUnitManifest | null {
  try {
    const fullPath = path.resolve(baseDir, manifestPath)

    // P1-5: Path traversal protection - must check with separator to prevent
    // baseDir/subdir from matching baseDirOther/file
    if (fullPath !== baseDir && !fullPath.startsWith(baseDir + path.sep)) {
      throw new Error(`Path traversal detected: ${manifestPath}`)
    }

    if (!fs.existsSync(fullPath)) {
      return null
    }

    const content = fs.readFileSync(fullPath, 'utf-8')
    const raw = yaml.load(content, { schema: yaml.FAILSAFE_SCHEMA })

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return null
    }

    const doc = raw as Record<string, unknown>
    const workUnits: WorkUnit[] = []

    // Support both 'work_units' and 'units' keys
    const unitsArray = (doc.work_units ?? doc.units) as unknown[] | undefined
    if (!Array.isArray(unitsArray)) {
      return null
    }

    for (const unitRaw of unitsArray) {
      if (!unitRaw || typeof unitRaw !== 'object' || Array.isArray(unitRaw)) {
        continue
      }
      const u = unitRaw as Record<string, unknown>

      const workUnit: WorkUnit = {
        id: String(u.id ?? ''),
        scope: String(u.scope ?? ''),
        files: Array.isArray(u.files)
          ? (u.files as unknown[]).map(f => String(f))
          : [],
        tags: Array.isArray(u.tags)
          ? (u.tags as unknown[]).map(t => String(t))
          : undefined,
        estimated_complexity: u.estimated_complexity
          ? String(u.estimated_complexity)
          : undefined,
        depends_on: Array.isArray(u.depends_on)
          ? (u.depends_on as unknown[]).map(d => String(d)).filter(d => d.length > 0)
          : undefined,
        interface_dependencies: Array.isArray(u.interface_dependencies)
          ? (u.interface_dependencies as unknown[]).map(d => String(d))
          : undefined,
      }

      if (workUnit.id && workUnit.scope) {
        workUnits.push(workUnit)
      }
    }

    return {
      version: String(doc.version ?? '1.0'),
      work_units: workUnits,
    }
  } catch {
    return null
  }
}

// ─── Specialist Selection ────────────────────────────────────────────────────

/**
 * Match work unit tags against agent definitions.
 * Pattern: {default_agent}-{tag} (e.g., "workhorse-rust", "workhorse-frontend")
 */
export function selectSpecialist(
  workUnit: WorkUnit,
  defaultAgent: string,
  config?: PerWorkUnitConfig['specialist_selection'],
): string {
  if (!config?.enabled || !workUnit.tags || workUnit.tags.length === 0) {
    return defaultAgent
  }

  // Try to match tags to specialist agents
  for (const tag of workUnit.tags) {
    // Pattern: defaultAgent-tag (e.g., "workhorse-rust")
    const specialistAgent = `${defaultAgent}-${tag}`
    // In a real implementation, we'd check if this agent exists
    // For now, return the first matched specialist
    return specialistAgent
  }

  return defaultAgent
}

// ─── Main Expansion Function ─────────────────────────────────────────────────

/**
 * Expand a per_work_unit step into multiple expanded steps.
 *
 * For sequential mode: work units are processed in manifest order
 * For parallel mode: work units are topologically sorted, depends_on resolved
 */
export function expandPerWorkUnit(
  step: WorkflowStep,
  ctx: ExpansionContext,
): ExpandedStep[] {
  const config: PerWorkUnitConfig = step.per_work_unit as PerWorkUnitConfig
  if (!config?.manifest_path) {
    return []
  }

  // Phase 25: Resolve {{ variable }} template syntax in manifest_path
  const vars = ctx.variables ?? {}
  const resolvedManifestPath = config.manifest_path.replace(
    /\{\{\s*([\w./-]+)\s*\}\}/g,
    (_m, key: string) => vars[key] ?? '',
  )

  const manifest = parseManifest(resolvedManifestPath, ctx.outputDir)
  if (!manifest || manifest.work_units.length === 0) {
    return []
  }

  const workUnits = manifest.work_units
  const mode = config.execution_mode ?? 'sequential'
  const defaultAgent = step.agent ?? 'workhorse'
  const substeps = config.substeps ?? []

  // For parallel mode, check for cycles
  if (mode === 'parallel') {
    const cycle = detectWorkUnitCycle(workUnits)
    if (cycle) {
      throw new Error(`Circular dependency detected in work units: ${cycle.join(' -> ')} -> ${cycle[0]}`)
    }
  }

  // Determine execution order
  const orderedUnits = mode === 'parallel'
    ? topologicalSort(workUnits)
    : workUnits // Sequential: use manifest order

  // Build expanded steps
  const expanded: ExpandedStep[] = []
  const workUnitIdToStepName = new Map<string, string>()

  for (const wu of orderedUnits) {
    // Generate step name: {parent_step}.{work_unit_id}
    // Sanitize work unit ID for use in step name
    const sanitizedWuId = wu.id.replace(/[^a-zA-Z0-9_-]/g, '_')
    const stepName = `${step.name}.${sanitizedWuId}`
    workUnitIdToStepName.set(wu.id, stepName)

    // Output directory for this work unit
    const unitOutputDir = path.join(ctx.outputDir, step.name, sanitizedWuId)

    // Select specialist agent based on tags
    const selectedAgent = selectSpecialist(wu, defaultAgent, config.specialist_selection)

    // Build the expanded step definition
    // If substeps are defined, use them; otherwise use the parent step's template
    let expandedStepDef: WorkflowStep

    if (substeps.length > 0) {
      // Clone substeps with work unit context injected
      // For now, just use the parent step as template - substep handling is done at runtime
      expandedStepDef = {
        ...step,
        name: stepName,
        agent: selectedAgent,
        output_path: path.join(step.name, sanitizedWuId, 'output.yaml'),
        prompt: substituteWorkUnitContext(step.prompt ?? '', wu, unitOutputDir),
        // Remove per_work_unit config from expanded step
        per_work_unit: undefined,
      }
    } else {
      expandedStepDef = {
        ...step,
        name: stepName,
        agent: selectedAgent,
        output_path: path.join(step.name, sanitizedWuId, 'output.yaml'),
        prompt: substituteWorkUnitContext(step.prompt ?? '', wu, unitOutputDir),
        per_work_unit: undefined,
      }
    }

    // Resolve depends_on to expanded step names (for parallel mode)
    let dependsOnExpanded: string[] | undefined
    if (mode === 'parallel' && wu.depends_on && wu.depends_on.length > 0) {
      dependsOnExpanded = wu.depends_on
        .map(depId => workUnitIdToStepName.get(depId))
        .filter((name): name is string => name !== undefined)
    }

    expanded.push({
      name: stepName,
      step: expandedStepDef,
      parentStep: step.name,
      workUnitId: wu.id,
      dependsOnExpanded,
      outputDir: unitOutputDir,
    })
  }

  return expanded
}

/**
 * Substitute work unit context into prompt template.
 * Replaces placeholders like {{ work_unit.id }}, {{ work_unit.scope }}, etc.
 */
function substituteWorkUnitContext(
  prompt: string,
  workUnit: WorkUnit,
  outputDir: string,
): string {
  let result = prompt

  // Basic work unit fields
  result = result.replace(/\{\{\s*work_unit\.id\s*\}\}/g, workUnit.id)
  result = result.replace(/\{\{\s*work_unit\.scope\s*\}\}/g, workUnit.scope)
  result = result.replace(/\{\{\s*work_unit\.files\s*\}\}/g, workUnit.files.join('\n'))
  result = result.replace(/\{\{\s*work_unit\.tags\s*\}\}/g, (workUnit.tags ?? []).join(', '))
  result = result.replace(/\{\{\s*work_unit\.complexity\s*\}\}/g, workUnit.estimated_complexity ?? 'unknown')

  // Output directory
  result = result.replace(/\{\{\s*output_dir\s*\}\}/g, outputDir)

  return result
}

// ─── Substep Execution Helper ────────────────────────────────────────────────

/**
 * Generate substep definitions for a work unit.
 * Each substep is a step in a TDD cycle.
 */
export function generateSubsteps(
  parentStepName: string,
  workUnitId: string,
  substepConfig: WorkflowStep[],
  outputDir: string,
  workUnit: WorkUnit,
): WorkflowStep[] {
  const sanitizedWuId = workUnitId.replace(/[^a-zA-Z0-9_-]/g, '_')

  return substepConfig.map((substep, _idx) => {
    const substepName = `${parentStepName}.${sanitizedWuId}.${substep.name}`
    const substepOutputDir = path.join(outputDir, parentStepName, sanitizedWuId, substep.name)

    return {
      ...substep,
      name: substepName,
      output_path: path.join(parentStepName, sanitizedWuId, substep.name, 'output.yaml'),
      prompt: substep.prompt
        ? substituteWorkUnitContext(substep.prompt, workUnit, substepOutputDir)
        : undefined,
      // For native_step substeps, set working_dir
      working_dir: substep.type === 'native_step' ? substepOutputDir : substep.working_dir,
      // Store reference to parent for result aggregation
      parentGroup: parentStepName,
    } as WorkflowStep
  })
}

// ─── Amendment Budget Helpers ─────────────────────────────────────────────────

/**
 * Initialize amendment budgets for all work units.
 * Called by dagEngine when per_work_unit expansion occurs.
 */
export function initWorkUnitBudgets(
  workflowStore: {
    initWorkUnitBudgets: (
      runId: string,
      workUnit: string,
      budgetConfig: { quality?: { per_work_unit?: number }; reconciliation?: { per_work_unit?: number } }
    ) => void
  },
  runId: string,
  workUnits: WorkUnit[],
  budgetConfig?: { quality?: { per_work_unit?: number }; reconciliation?: { per_work_unit?: number } },
): void {
  if (!budgetConfig) return

  for (const wu of workUnits) {
    workflowStore.initWorkUnitBudgets(runId, wu.id, budgetConfig)
  }
}

/**
 * Check if amendment budget allows an amendment for a work unit.
 */
export function checkWorkUnitBudget(
  workflowStore: {
    checkAndIncrementBudget: (
      runId: string,
      workUnit: string | null,
      category: string
    ) => { allowed: boolean; used: number; max: number }
  },
  runId: string,
  workUnitId: string,
  category: string,
): { allowed: boolean; used: number; max: number } {
  return workflowStore.checkAndIncrementBudget(runId, workUnitId, category)
}
