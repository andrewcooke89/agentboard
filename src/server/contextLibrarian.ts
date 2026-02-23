/**
 * contextLibrarian.ts - Native step that prepares context briefings
 *
 * Ingests 6 sources in parallel:
 * 1. codebase - File structure, key modules
 * 2. project_facts - Stored facts about the project
 * 3. memory - Architectural decisions, patterns
 * 4. blackboard - Current run state, decisions
 * 5. session - Session history, previous outputs
 * 6. related_wos - Related work orders
 *
 * Compresses to token budget based on consumer profile.
 */

import fs from 'node:fs'
import path from 'node:path'
import { logger } from './logger'
import { loadProjectProfile } from './projectProfile'

export type ConsumerProfile = 'planner' | 'reviewer' | 'implementor'

export interface ContextBriefingConfig {
  consumer_profile: ConsumerProfile
  token_budget: number
  sources: string[]
  include_related_wos?: boolean
  max_files_per_source?: number
}

export interface ContextSource {
  name: string
  content: string
  tokens: number
  priority: number
}

export interface ContextBriefing {
  content: string
  sources_included: string[]
  total_tokens: number
  compressed: boolean
  generated_at: string
}

// Default token budgets by consumer profile
const DEFAULT_TOKEN_BUDGETS: Record<ConsumerProfile, number> = {
  planner: 30000,
  reviewer: 15000,
  implementor: 25000,
}

// Source priorities by consumer profile
const SOURCE_PRIORITIES: Record<ConsumerProfile, Record<string, number>> = {
  planner: {
    blackboard: 10,
    memory: 9,
    project_facts: 8,
    related_wos: 7,
    codebase: 6,
    session: 5,
  },
  reviewer: {
    blackboard: 10,
    codebase: 9,
    project_facts: 8,
    memory: 7,
    session: 6,
    related_wos: 5,
  },
  implementor: {
    codebase: 10,
    blackboard: 9,
    session: 8,
    project_facts: 7,
    memory: 6,
    related_wos: 5,
  },
}

/**
 * Prepare context briefing by ingesting and compressing multiple sources.
 */
export async function prepareContextBriefing(
  config: ContextBriefingConfig,
  runDir: string,
  projectPath: string
): Promise<string> {
  const budget = config.token_budget ?? DEFAULT_TOKEN_BUDGETS[config.consumer_profile]
  const priorities = SOURCE_PRIORITIES[config.consumer_profile]

  logger.info('context_briefing_preparing', {
    profile: config.consumer_profile,
    budget,
    sources: config.sources,
  })

  // Gather all sources in parallel
  const sources = await gatherSources(config, runDir, projectPath)

  // Sort by priority for this consumer
  sources.sort((a, b) => {
    const pa = priorities[a.name] ?? 0
    const pb = priorities[b.name] ?? 0
    return pb - pa
  })

  // Compress to fit budget
  const briefing = compressToBudget(sources, budget)

  // Write briefing file
  const briefingPath = path.join(runDir, 'context-briefing.md')
  await writeBriefingFile(briefingPath, briefing, config)

  logger.info('context_briefing_created', {
    path: briefingPath,
    tokens: briefing.total_tokens,
    sources: briefing.sources_included,
  })

  return briefingPath
}

/**
 * Gather content from all configured sources.
 */
async function gatherSources(
  config: ContextBriefingConfig,
  runDir: string,
  projectPath: string
): Promise<ContextSource[]> {
  const maxFiles = config.max_files_per_source ?? 10

  // Gather each source in parallel
  const gatherPromises = config.sources.map(async (sourceName) => {
    let content: string

    switch (sourceName) {
      case 'codebase':
        content = await gatherCodebaseSource(projectPath, maxFiles)
        break
      case 'project_facts':
        content = await gatherProjectFactsSource(projectPath)
        break
      case 'memory':
        content = await gatherMemorySource(projectPath)
        break
      case 'blackboard':
        content = await gatherBlackboardSource(runDir)
        break
      case 'session':
        content = await gatherSessionSource(runDir)
        break
      case 'related_wos':
        content = await gatherRelatedWOsSource(projectPath)
        break
      default:
        content = ''
    }

    return {
      name: sourceName,
      content,
      tokens: estimateTokens(content),
      priority: 0,  // Will be set by caller
    }
  })

  const results = await Promise.all(gatherPromises)
  return results.filter(s => s.content.length > 0)
}

/**
 * Gather codebase source - file structure and key modules.
 */
async function gatherCodebaseSource(projectPath: string, maxFiles: number): Promise<string> {
  const sections: string[] = []

  // Get directory structure
  try {
    const structure = await getDirectoryStructure(projectPath, 3)
    sections.push(`## Directory Structure\n\n\`\`\`\n${structure}\n\`\`\`\n`)
  } catch {
    // Directory access failed
  }

  // MED-004: Use async fs.promises for file operations
  const fsPromises = fs.promises

  // Get key files (README, package.json, Cargo.toml, etc.)
  const keyFiles = [
    'README.md', 'package.json', 'Cargo.toml', 'pyproject.toml',
    'go.mod', 'tsconfig.json', 'deno.json',
  ]

  for (const file of keyFiles.slice(0, maxFiles)) {
    const filePath = path.join(projectPath, file)
    try {
      await fsPromises.access(filePath)
      const content = (await fsPromises.readFile(filePath, 'utf-8')).slice(0, 5000)
      sections.push(`## ${file}\n\n\`\`\`\n${content}\n\`\`\`\n`)
    } catch {
      // File read failed
    }
  }

  return sections.join('\n')
}

/**
 * Gather project facts source.
 */
async function gatherProjectFactsSource(projectPath: string): Promise<string> {
  const profile = loadProjectProfile(projectPath)

  if (Object.keys(profile).length === 0) {
    return ''
  }

  const sections: string[] = ['## Project Profile\n']

  for (const [key, value] of Object.entries(profile)) {
    sections.push(`- **${key}**: ${value}`)
  }

  return sections.join('\n')
}

/**
 * Gather memory source - architectural decisions and patterns.
 */
async function gatherMemorySource(projectPath: string): Promise<string> {
  const memoryDir = path.join(projectPath, '.claude', 'memory', 'content')

  if (!fs.existsSync(memoryDir)) {
    return ''
  }

  const sections: string[] = ['## Memory\n']

  // Gather decisions
  const decisionsDir = path.join(memoryDir, 'decisions')
  if (fs.existsSync(decisionsDir)) {
    const files = fs.readdirSync(decisionsDir).filter(f => f.endsWith('.md')).slice(0, 5)
    for (const file of files) {
      const content = fs.readFileSync(path.join(decisionsDir, file), 'utf-8').slice(0, 2000)
      sections.push(`### Decision: ${file}\n\n${content}\n`)
    }
  }

  // Gather patterns
  const patternsDir = path.join(memoryDir, 'patterns')
  if (fs.existsSync(patternsDir)) {
    const files = fs.readdirSync(patternsDir).filter(f => f.endsWith('.md')).slice(0, 3)
    for (const file of files) {
      const content = fs.readFileSync(path.join(patternsDir, file), 'utf-8').slice(0, 1500)
      sections.push(`### Pattern: ${file}\n\n${content}\n`)
    }
  }

  return sections.join('\n')
}

/**
 * Gather blackboard source - current run state.
 */
async function gatherBlackboardSource(runDir: string): Promise<string> {
  const blackboardPath = path.join(runDir, 'blackboard.yaml')

  if (!fs.existsSync(blackboardPath)) {
    return ''
  }

  const content = fs.readFileSync(blackboardPath, 'utf-8')
  return `## Blackboard\n\n\`\`\`yaml\n${content}\n\`\`\`\n`
}

/**
 * Gather session source - previous outputs.
 */
async function gatherSessionSource(runDir: string): Promise<string> {
  const sections: string[] = ['## Session History\n']

  // Look for step outputs
  const stepsDir = path.join(runDir, 'steps')
  if (fs.existsSync(stepsDir)) {
    const stepDirs = fs.readdirSync(stepsDir).slice(0, 10)
    for (const stepDir of stepDirs) {
      const resultPath = path.join(stepsDir, stepDir, 'result.md')
      if (fs.existsSync(resultPath)) {
        const content = fs.readFileSync(resultPath, 'utf-8').slice(0, 2000)
        sections.push(`### ${stepDir}\n\n${content}\n`)
      }
    }
  }

  return sections.join('\n')
}

/**
 * Gather related work orders source.
 */
async function gatherRelatedWOsSource(projectPath: string): Promise<string> {
  const manifestPath = path.join(projectPath, '.workflow', 'work-units.yaml')

  if (!fs.existsSync(manifestPath)) {
    return ''
  }

  const content = fs.readFileSync(manifestPath, 'utf-8')
  return `## Related Work Orders\n\n\`\`\`yaml\n${content.slice(0, 5000)}\n\`\`\`\n`
}

/**
 * Get directory structure as tree string.
 */
async function getDirectoryStructure(rootPath: string, maxDepth: number): Promise<string> {
  const lines: string[] = []

  function walk(dir: string, depth: number, prefix: string): void {
    if (depth > maxDepth) return

    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      return
    }

    // Filter out hidden directories and common ignores
    entries = entries.filter(e =>
      !e.startsWith('.') &&
      !['node_modules', 'target', 'dist', 'build', '__pycache__'].includes(e)
    ).slice(0, 50)

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const isLast = i === entries.length - 1
      const fullPath = path.join(dir, entry)
      const isDir = fs.statSync(fullPath).isDirectory()

      lines.push(`${prefix}${isLast ? '└── ' : '├── '}${entry}`)

      if (isDir && depth < maxDepth) {
        walk(fullPath, depth + 1, prefix + (isLast ? '    ' : '│   '))
      }
    }
  }

  lines.push(path.basename(rootPath) + '/')
  walk(rootPath, 1, '')

  return lines.join('\n')
}

/**
 * Compress sources to fit within token budget.
 */
function compressToBudget(sources: ContextSource[], budget: number): ContextBriefing {
  let totalTokens = 0
  const included: string[] = []
  const contentParts: string[] = []

  // Add header
  contentParts.push('# Context Briefing\n\n')
  contentParts.push(`Generated: ${new Date().toISOString()}\n\n`)
  contentParts.push('---\n\n')

  // Add sources in priority order until budget exhausted
  for (const source of sources) {
    if (totalTokens + source.tokens > budget) {
      // Truncate this source to fit
      const remainingBudget = budget - totalTokens
      if (remainingBudget > 100) {
        const truncatedContent = truncateToTokens(source.content, remainingBudget)
        contentParts.push(truncatedContent)
        included.push(`${source.name} (truncated)`)
        totalTokens += remainingBudget
      }
      break
    }

    contentParts.push(source.content)
    included.push(source.name)
    totalTokens += source.tokens
  }

  return {
    content: contentParts.join('\n'),
    sources_included: included,
    total_tokens: totalTokens,
    compressed: totalTokens >= budget * 0.9,
    generated_at: new Date().toISOString(),
  }
}

/**
 * Write briefing to file.
 */
async function writeBriefingFile(
  briefingPath: string,
  briefing: ContextBriefing,
  config: ContextBriefingConfig
): Promise<void> {
  const header = `# Context Briefing

Profile: ${config.consumer_profile}
Token Budget: ${config.token_budget}
Tokens Used: ${briefing.total_tokens}
Compressed: ${briefing.compressed}
Sources: ${briefing.sources_included.join(', ')}

---

`

  await fs.promises.writeFile(briefingPath, header + briefing.content, 'utf-8')
}

/**
 * Estimate token count from string.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Truncate text to approximately target tokens.
 */
function truncateToTokens(text: string, targetTokens: number): string {
  const targetChars = targetTokens * 4
  if (text.length <= targetChars) return text

  // Try to truncate at paragraph boundary
  const truncated = text.slice(0, targetChars)
  const lastParagraph = truncated.lastIndexOf('\n\n')

  if (lastParagraph > targetChars * 0.7) {
    return truncated.slice(0, lastParagraph) + '\n\n[...truncated...]'
  }

  return truncated + '\n\n[...truncated...]'
}

/**
 * Create default config for consumer profile.
 */
export function createDefaultBriefingConfig(profile: ConsumerProfile): ContextBriefingConfig {
  return {
    consumer_profile: profile,
    token_budget: DEFAULT_TOKEN_BUDGETS[profile],
    sources: ['codebase', 'project_facts', 'memory', 'blackboard', 'session', 'related_wos'],
    max_files_per_source: 10,
  }
}
