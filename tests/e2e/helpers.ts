/**
 * E2E Test Helpers
 * Utilities for Playwright e2e tests including server lifecycle and fixtures
 */

import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface TestContext {
  workflowDir: string
  dataDir: string
  tmuxSession: string
}

/**
 * Create a temporary test workflow directory
 */
export function createTempWorkflowDir(): string {
  const tmpDir = join('/tmp', `agentboard-e2e-${Date.now()}`)
  mkdirSync(tmpDir, { recursive: true })
  return tmpDir
}

/**
 * Clean up test directories
 */
export function cleanupTestDir(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    console.warn(`Failed to cleanup ${dir}:`, err)
  }
}

/**
 * Create a test workflow YAML file
 */
export function createTestWorkflow(
  workflowDir: string,
  name: string,
  steps: Array<{ name: string; type: string; [key: string]: unknown }>
): string {
  const workflowPath = join(workflowDir, `${name}.yaml`)
  const yaml = `
name: ${name}
description: Test workflow for e2e testing
steps:
${steps.map((step) => `  - name: ${step.name}\n    type: ${step.type}\n    ${Object.entries(step).filter(([k]) => k !== 'name' && k !== 'type').map(([k, v]) => `${k}: ${typeof v === 'string' ? `"${v}"` : v}`).join('\n    ')}`).join('\n')}
`.trim()

  writeFileSync(workflowPath, yaml, 'utf-8')
  return workflowPath
}

/**
 * Check if tmux session exists
 */
export function tmuxSessionExists(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t ${sessionName} 2>/dev/null`)
    return true
  } catch {
    return false
  }
}

/**
 * Kill tmux session if it exists
 */
export function killTmuxSession(sessionName: string) {
  if (tmuxSessionExists(sessionName)) {
    try {
      execSync(`tmux kill-session -t ${sessionName}`)
    } catch (err) {
      console.warn(`Failed to kill tmux session ${sessionName}:`, err)
    }
  }
}

/**
 * Wait for a condition with timeout
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 100
): Promise<boolean> {
  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}
