// WU-004: Server Lifecycle Tests
// Verifies startup config/skill generation (AC-004-4) and
// graceful shutdown cleanup (AC-004-5).
//
// These tests verify that index.ts source code contains the expected
// CronAiService wiring. They read the actual source file to check for
// integration points, failing until WU-004 adds the wiring.

import { describe, it, expect, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ─── Source code analysis tests ──────────────────────────────────────────────
// These read the REAL index.ts and verify CronAiService is wired in.
// They fail until WU-004 implementation adds the wiring.

const INDEX_SOURCE = readFileSync(
  join(import.meta.dir, '..', 'index.ts'),
  'utf-8'
)

describe('WU-004: CronAiService wired into index.ts', () => {
  it('imports CronAiService', () => {
    expect(INDEX_SOURCE).toMatch(/import.*CronAiService.*from/)
  })

  it('instantiates CronAiService', () => {
    // Should contain something like: new CronAiService(deps, config)
    expect(INDEX_SOURCE).toMatch(/new CronAiService/)
  })
})

describe('WU-004: Server startup lifecycle (AC-004-4)', () => {
  it('calls generateMcpConfig at startup', () => {
    // index.ts should call cronAiService.generateMcpConfig(config.port) or similar
    expect(INDEX_SOURCE).toMatch(/generateMcpConfig/)
  })

  it('calls generateSkillFile at startup', () => {
    // index.ts should call cronAiService.generateSkillFile()
    expect(INDEX_SOURCE).toMatch(/generateSkillFile/)
  })

  it('passes server port to generateMcpConfig', () => {
    // The config generation should include the port for MCP server connection
    expect(INDEX_SOURCE).toMatch(/generateMcpConfig\s*\(\s*(config\.)?port/)
  })
})

describe('WU-004: Server shutdown lifecycle (AC-004-5)', () => {
  it('calls killAiSession in cleanup function', () => {
    // cleanupAllTerminals (or similar) should call cronAiService.killAiSession()
    expect(INDEX_SOURCE).toMatch(/killAiSession/)
  })

  it('killAiSession is called before process.exit in SIGTERM handler', () => {
    // The cleanup function is called from SIGTERM/SIGINT handlers
    // killAiSession should appear in the cleanup function that runs before exit
    const cleanupStart = INDEX_SOURCE.indexOf('function cleanupAllTerminals')
    const processExit = INDEX_SOURCE.indexOf("process.on('SIGTERM'")
    expect(cleanupStart).toBeGreaterThan(-1)
    expect(processExit).toBeGreaterThan(-1)
    // killAiSession should be between cleanupAllTerminals definition and its end
    const cleanupBody = INDEX_SOURCE.slice(cleanupStart, processExit)
    expect(cleanupBody).toMatch(/killAiSession/)
  })
})

describe('WU-004: WS handler wiring in index.ts', () => {
  it('wires onCronAiContextUpdate into wsHandlers', () => {
    expect(INDEX_SOURCE).toMatch(/onCronAiContextUpdate/)
  })

  it('wires onCronAiProposalResponse into wsHandlers', () => {
    expect(INDEX_SOURCE).toMatch(/onCronAiProposalResponse/)
  })

  it('wires onCronAiDrawerOpen into wsHandlers', () => {
    expect(INDEX_SOURCE).toMatch(/onCronAiDrawerOpen/)
  })

  it('wires onCronAiDrawerClose into wsHandlers', () => {
    expect(INDEX_SOURCE).toMatch(/onCronAiDrawerClose/)
  })

  it('wires onCronAiNewConversation into wsHandlers', () => {
    expect(INDEX_SOURCE).toMatch(/onCronAiNewConversation/)
  })

  it('wires onCronAiMcpRegister into wsHandlers', () => {
    expect(INDEX_SOURCE).toMatch(/onCronAiMcpRegister/)
  })

  it('wires onCronAiNavigate into wsHandlers', () => {
    expect(INDEX_SOURCE).toMatch(/onCronAiNavigate/)
  })
})

// ─── Source code analysis for wsRouter.ts ────────────────────────────────────

const WSROUTER_SOURCE = readFileSync(
  join(import.meta.dir, '..', 'wsRouter.ts'),
  'utf-8'
)

describe('WU-004: wsRouter.ts WsHandlers interface has cron-ai entries', () => {
  it('declares onCronAiContextUpdate in WsHandlers', () => {
    expect(WSROUTER_SOURCE).toMatch(/onCronAiContextUpdate\??:/)
  })

  it('declares onCronAiProposalResponse in WsHandlers', () => {
    expect(WSROUTER_SOURCE).toMatch(/onCronAiProposalResponse\??:/)
  })

  it('declares onCronAiDrawerOpen in WsHandlers', () => {
    expect(WSROUTER_SOURCE).toMatch(/onCronAiDrawerOpen\??:/)
  })

  it('declares onCronAiDrawerClose in WsHandlers', () => {
    expect(WSROUTER_SOURCE).toMatch(/onCronAiDrawerClose\??:/)
  })

  it('declares onCronAiNewConversation in WsHandlers', () => {
    expect(WSROUTER_SOURCE).toMatch(/onCronAiNewConversation\??:/)
  })

  it('declares onCronAiMcpRegister in WsHandlers', () => {
    expect(WSROUTER_SOURCE).toMatch(/onCronAiMcpRegister\??:/)
  })

  it('declares onCronAiNavigate in WsHandlers', () => {
    expect(WSROUTER_SOURCE).toMatch(/onCronAiNavigate\??:/)
  })
})

describe('WU-004: wsRouter.ts switch cases for cron-ai-* messages', () => {
  // Extract the handleMessage function body for targeted checks
  const handleMsgStart = WSROUTER_SOURCE.indexOf('export function handleMessage')
  const handleMsgBody = WSROUTER_SOURCE.slice(handleMsgStart)

  const cronAiCases = [
    'cron-ai-context-update',
    'cron-ai-proposal-response',
    'cron-ai-drawer-open',
    'cron-ai-drawer-close',
    'cron-ai-new-conversation',
    'cron-ai-mcp-register',
    'cron-ai-navigate',
  ]

  for (const msgType of cronAiCases) {
    it(`has switch case for '${msgType}'`, () => {
      expect(handleMsgBody).toContain(`'${msgType}'`)
    })
  }
})

// ─── WS lifecycle hooks ──────────────────────────────────────────────────────
// These verify that index.ts wires WS connect/disconnect to CronAiService.

describe('WU-004: WS lifecycle hooks in index.ts', () => {
  it('registers MCP client on WS connect (cron-ai-mcp-register)', () => {
    // index.ts should call registerMcpClient when a cron-ai-mcp-register message arrives
    expect(INDEX_SOURCE).toMatch(/registerMcpClient/)
  })

  it('unregisters MCP client on WS disconnect', () => {
    // index.ts should call unregisterMcpClient when a WS client disconnects
    expect(INDEX_SOURCE).toMatch(/unregisterMcpClient/)
  })

  it('exposes cronAiService on server context', () => {
    // index.ts should make cronAiService accessible (e.g., on ctx or as a module-level var)
    expect(INDEX_SOURCE).toMatch(/cronAiService/)
  })
})

describe('WU-004: CronAiService constructor wiring in index.ts', () => {
  it('passes cronManager as dependency', () => {
    expect(INDEX_SOURCE).toMatch(/cronManager/)
  })

  it('passes historyService as dependency', () => {
    expect(INDEX_SOURCE).toMatch(/historyService|cronHistoryService/)
  })

  it('passes logService as dependency', () => {
    expect(INDEX_SOURCE).toMatch(/logService|cronLogService/)
  })

  it('passes sessionManager as dependency', () => {
    expect(INDEX_SOURCE).toMatch(/sessionManager/)
  })

  it('passes port in config', () => {
    // Constructor config should include port for MCP config generation
    expect(INDEX_SOURCE).toMatch(/port.*:.*config\.port|port:\s*config\.port/)
  })
})

// ─── Contract tests for CronAiService interface ─────────────────────────────
// These verify the methods that index.ts must call exist on CronAiService.

describe('WU-004: CronAiService has required lifecycle methods', () => {
  it('CronAiService class exports generateMcpConfig', async () => {
    const { CronAiService } = await import('../cronAiService')
    expect(CronAiService.prototype.generateMcpConfig).toBeDefined()
    expect(typeof CronAiService.prototype.generateMcpConfig).toBe('function')
  })

  it('CronAiService class exports generateSkillFile', async () => {
    const { CronAiService } = await import('../cronAiService')
    expect(CronAiService.prototype.generateSkillFile).toBeDefined()
    expect(typeof CronAiService.prototype.generateSkillFile).toBe('function')
  })

  it('CronAiService class exports killAiSession', async () => {
    const { CronAiService } = await import('../cronAiService')
    expect(CronAiService.prototype.killAiSession).toBeDefined()
    expect(typeof CronAiService.prototype.killAiSession).toBe('function')
  })

  it('CronAiService class exports validateAuth', async () => {
    const { CronAiService } = await import('../cronAiService')
    expect(CronAiService.prototype.validateAuth).toBeDefined()
    expect(typeof CronAiService.prototype.validateAuth).toBe('function')
  })

  it('CronAiService class exports registerMcpClient', async () => {
    const { CronAiService } = await import('../cronAiService')
    expect(CronAiService.prototype.registerMcpClient).toBeDefined()
    expect(typeof CronAiService.prototype.registerMcpClient).toBe('function')
  })

  it('CronAiService class exports unregisterMcpClient', async () => {
    const { CronAiService } = await import('../cronAiService')
    expect(CronAiService.prototype.unregisterMcpClient).toBeDefined()
    expect(typeof CronAiService.prototype.unregisterMcpClient).toBe('function')
  })

  it('CronAiService class exports updateContext', async () => {
    const { CronAiService } = await import('../cronAiService')
    expect(CronAiService.prototype.updateContext).toBeDefined()
    expect(typeof CronAiService.prototype.updateContext).toBe('function')
  })

  it('CronAiService class exports resolveProposal', async () => {
    const { CronAiService } = await import('../cronAiService')
    expect(CronAiService.prototype.resolveProposal).toBeDefined()
    expect(typeof CronAiService.prototype.resolveProposal).toBe('function')
  })

  it('CronAiService class exports forwardToMcp', async () => {
    const { CronAiService } = await import('../cronAiService')
    expect(CronAiService.prototype.forwardToMcp).toBeDefined()
    expect(typeof CronAiService.prototype.forwardToMcp).toBe('function')
  })
})

// ─── Config wiring details ──────────────────────────────────────────────────

describe('WU-004: CronAiService config wiring in index.ts', () => {
  it('passes authToken in config', () => {
    // CronAiService needs authToken for validateAuth
    expect(INDEX_SOURCE).toMatch(/authToken.*:.*config\.authToken|authToken:\s*config\.authToken/)
  })

  it('startup config generation has error handling (.catch)', () => {
    // generateMcpConfig and generateSkillFile should have .catch to prevent unhandled rejection
    expect(INDEX_SOURCE).toMatch(/generateMcpConfig.*\.catch/)
    expect(INDEX_SOURCE).toMatch(/generateSkillFile.*\.catch/)
  })

  it('killAiSession in cleanup has error handling (.catch)', () => {
    // killAiSession should have .catch so cleanup doesn't throw
    expect(INDEX_SOURCE).toMatch(/killAiSession.*\.catch/)
  })
})

// ─── WS close handler integration ──────────────────────────────────────────

describe('WU-004: WS close handler calls unregisterMcpClient', () => {
  it('unregisterMcpClient is called in the WS close handler', () => {
    // Find the close(ws) handler and verify unregisterMcpClient is inside it
    const closeMatch = INDEX_SOURCE.match(/close\s*\(\s*ws\s*\)\s*\{([\s\S]*?)\n\s*\}/)
    expect(closeMatch).not.toBeNull()
    if (closeMatch) {
      expect(closeMatch[1]).toMatch(/unregisterMcpClient/)
    }
  })
})

// ─── Proposal response handler wiring ───────────────────────────────────────

describe('WU-004: onCronAiProposalResponse wiring in index.ts', () => {
  it('calls resolveProposal on the service', () => {
    expect(INDEX_SOURCE).toMatch(/resolveProposal/)
  })

  it('broadcasts proposal-resolved after resolving', () => {
    expect(INDEX_SOURCE).toMatch(/cron-ai-proposal-resolved/)
  })

  it('forwards resolved proposal to MCP client', () => {
    expect(INDEX_SOURCE).toMatch(/forwardToMcp/)
  })
})
