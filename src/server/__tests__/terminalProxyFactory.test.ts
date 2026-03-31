import { afterAll, describe, expect, test, mock } from 'bun:test'
import type { TerminalProxyOptions } from '../terminal/types'

const constructed: Array<{ mode: string; options: TerminalProxyOptions }> = []

class PtyTerminalProxyMock {
  constructor(options: TerminalProxyOptions) {
    constructed.push({ mode: 'pty', options })
  }
}

class PipePaneTerminalProxyMock {
  constructor(options: TerminalProxyOptions) {
    constructed.push({ mode: 'pipe-pane', options })
  }
}

const configMock = {
  port: 4040,
  hostname: '0.0.0.0',
  tmuxSession: 'agentboard',
  refreshIntervalMs: 2000,
  discoverPrefixes: [] as string[],
  pruneWsSessions: true,
  terminalMode: 'auto' as 'auto' | 'pty' | 'pipe-pane',
  terminalMonitorTargets: true,
  allowKillExternal: false,
  tlsCert: '',
  tlsKey: '',
  logPollIntervalMs: 5000,
  logPollMax: 25,
  rgThreads: 1,
  logMatchWorker: false,
  logMatchProfile: false,
  claudeConfigDir: '/tmp/claude',
  codexHomeDir: '/tmp/codex',
  claudeResumeCmd: 'claude --resume {sessionId}',
  codexResumeCmd: 'codex resume {sessionId}',
  enterRefreshDelayMs: 50,
  workingGracePeriodMs: 4000,
  inactiveSessionMaxAgeHours: 24,
  excludeProjects: [] as string[],
  skipMatchingPatterns: [] as string[],
  logLevel: 'info' as const,
  logFile: '/tmp/agentboard-test.log',
  authToken: '',
  allowedRoots: [] as string[],
  taskMaxConcurrent: 5,
  taskPollIntervalMs: 5000,
  taskDefaultTimeoutSeconds: 1800,
  taskRateLimitPerHour: 30,
  taskOutputDir: '/tmp/agentboard-task-outputs',
  historyEnabled: false,
  historyMaxFiles: 20000,
  historyMaxResults: 200,
  historyReadMaxBytes: 65536,
  historyReadMaxLines: 200,
  historyCountsTtlMs: 60000,
  historyResumeTimeoutMs: 2000,
  workflowEngineEnabled: false,
  workflowDir: '/tmp/agentboard-workflows',
  workflowMaxConcurrentRuns: 20,
  workflowPollIntervalMs: 2000,
  workflowRunRetentionDays: 30,
  sessionRetentionDays: 30,
}

mock.module('../config', () => ({
  config: configMock,
}))

mock.module('../terminal/PtyTerminalProxy', () => ({
  PtyTerminalProxy: PtyTerminalProxyMock,
}))

mock.module('../terminal/PipePaneTerminalProxy', () => ({
  PipePaneTerminalProxy: PipePaneTerminalProxyMock,
}))

const originalIsTTY = process.stdin.isTTY

let createTerminalProxy: typeof import('../terminal/TerminalProxyFactory').createTerminalProxy
let resolveTerminalMode: typeof import('../terminal/TerminalProxyFactory').resolveTerminalMode

async function loadFactory() {
  if (!createTerminalProxy || !resolveTerminalMode) {
    const module = await import('../terminal/TerminalProxyFactory')
    createTerminalProxy = module.createTerminalProxy
    resolveTerminalMode = module.resolveTerminalMode
  }
}

afterAll(() => {
  Object.defineProperty(process.stdin, 'isTTY', {
    value: originalIsTTY,
    configurable: true,
  })
  mock.restore()
})

describe('TerminalProxyFactory', () => {
  test('resolveTerminalMode respects config overrides', async () => {
    await loadFactory()

    configMock.terminalMode = 'pipe-pane'
    expect(resolveTerminalMode()).toBe('pipe-pane')

    configMock.terminalMode = 'pty'
    expect(resolveTerminalMode()).toBe('pty')
  })

  test('resolveTerminalMode falls back to stdin tty', async () => {
    await loadFactory()

    configMock.terminalMode = 'auto'
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    })
    expect(resolveTerminalMode()).toBe('pty')

    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    })
    expect(resolveTerminalMode()).toBe('pipe-pane')
  })

  test('createTerminalProxy instantiates correct proxy', async () => {
    await loadFactory()

    const options: TerminalProxyOptions = {
      connectionId: 'conn-1',
      sessionName: 'agentboard-ws-conn-1',
      baseSession: 'agentboard',
      onData: () => {},
    }

    constructed.length = 0
    configMock.terminalMode = 'pty'
    createTerminalProxy(options)
    expect(constructed[0]?.mode).toBe('pty')

    constructed.length = 0
    configMock.terminalMode = 'pipe-pane'
    createTerminalProxy(options)
    expect(constructed[0]?.mode).toBe('pipe-pane')
  })
})
