// WU-002 — CronAi Store unit tests
// Tests: cronAiStore-unit
// Covers: AC-002-1 through AC-002-5

import { beforeEach, describe, expect, test } from 'bun:test'

// localStorage mock MUST be imported before the store so that
// globalThis.localStorage exists when Zustand's persist middleware evaluates.
import { storage } from './localStorageMock'

import {
  useCronAiStore,
  DRAWER_MIN_WIDTH,
  DRAWER_MAX_WIDTH,
  DRAWER_DEFAULT_WIDTH,
} from '../cronAiStore'
import type { CronAiProposal } from '../../../shared/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProposal(overrides: Partial<CronAiProposal> = {}): CronAiProposal {
  return {
    id: 'prop-1',
    operation: 'create',
    jobId: null,
    jobName: 'Test Job',
    jobAvatarUrl: null,
    description: 'Create a test cron job',
    diff: '+ * * * * * echo test',
    status: 'pending',
    feedback: null,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    ...overrides,
  }
}

const INITIAL_STATE = {
  drawerOpen: false,
  drawerWidth: DRAWER_DEFAULT_WIDTH,
  sessionStatus: 'offline' as const,
  sessionWindowId: null,
  mcpConnected: false,
  proposals: [] as CronAiProposal[],
  pendingProposalCount: 0,
  autoStartSession: true,
}

beforeEach(() => {
  storage.clear()
  useCronAiStore.setState(INITIAL_STATE)
})


// ─── AC-002-1: Store initializes with correct defaults ──────────────────────

describe('cronAiStore initialization (AC-002-1)', () => {
  test('drawerOpen defaults to false', () => {
    expect(useCronAiStore.getState().drawerOpen).toBe(false)
  })

  test('sessionStatus defaults to offline', () => {
    expect(useCronAiStore.getState().sessionStatus).toBe('offline')
  })

  test('proposals defaults to empty array', () => {
    expect(useCronAiStore.getState().proposals).toEqual([])
  })

  test('drawerWidth defaults to 480', () => {
    expect(useCronAiStore.getState().drawerWidth).toBe(480)
  })

  test('sessionWindowId defaults to null', () => {
    expect(useCronAiStore.getState().sessionWindowId).toBeNull()
  })

  test('mcpConnected defaults to false', () => {
    expect(useCronAiStore.getState().mcpConnected).toBe(false)
  })

  test('pendingProposalCount defaults to 0', () => {
    expect(useCronAiStore.getState().pendingProposalCount).toBe(0)
  })

  test('autoStartSession defaults to true', () => {
    // Verify the store defines autoStartSession as a real field (not just from setState reset)
    const state = useCronAiStore.getState()
    expect('autoStartSession' in state).toBe(true)
    expect(state.autoStartSession).toBe(true)
    // Also verify there's a setter
    expect(typeof (state as any).setAutoStartSession).toBe('function')
  })
})

// ─── AC-002-2: Drawer toggle and width clamping ─────────────────────────────

describe('drawer actions (AC-002-2)', () => {
  test('toggleDrawer flips drawerOpen from false to true', () => {
    expect(useCronAiStore.getState().drawerOpen).toBe(false)
    useCronAiStore.getState().toggleDrawer()
    expect(useCronAiStore.getState().drawerOpen).toBe(true)
  })

  test('toggleDrawer flips drawerOpen from true to false', () => {
    useCronAiStore.setState({ drawerOpen: true })
    useCronAiStore.getState().toggleDrawer()
    expect(useCronAiStore.getState().drawerOpen).toBe(false)
  })

  test('toggleDrawer called twice returns to original state', () => {
    useCronAiStore.getState().toggleDrawer()
    useCronAiStore.getState().toggleDrawer()
    expect(useCronAiStore.getState().drawerOpen).toBe(false)
  })

  test('setDrawerWidth sets width within valid range', () => {
    useCronAiStore.getState().setDrawerWidth(500)
    expect(useCronAiStore.getState().drawerWidth).toBe(500)
  })

  test('setDrawerWidth clamps below minimum (360)', () => {
    useCronAiStore.getState().setDrawerWidth(100)
    expect(useCronAiStore.getState().drawerWidth).toBe(DRAWER_MIN_WIDTH)
  })

  test('setDrawerWidth clamps above maximum (640)', () => {
    useCronAiStore.getState().setDrawerWidth(1000)
    expect(useCronAiStore.getState().drawerWidth).toBe(DRAWER_MAX_WIDTH)
  })

  test('setDrawerWidth clamps exact boundary values', () => {
    useCronAiStore.getState().setDrawerWidth(360)
    expect(useCronAiStore.getState().drawerWidth).toBe(360)

    useCronAiStore.getState().setDrawerWidth(640)
    expect(useCronAiStore.getState().drawerWidth).toBe(640)
  })

  test('setDrawerWidth clamps negative values to minimum', () => {
    useCronAiStore.getState().setDrawerWidth(-50)
    expect(useCronAiStore.getState().drawerWidth).toBe(DRAWER_MIN_WIDTH)
  })

  test('setDrawerWidth clamps zero to minimum', () => {
    useCronAiStore.getState().setDrawerWidth(0)
    expect(useCronAiStore.getState().drawerWidth).toBe(DRAWER_MIN_WIDTH)
  })
})

// ─── Exported constants ─────────────────────────────────────────────────────

describe('exported constants', () => {
  test('DRAWER_MIN_WIDTH is 360', () => {
    expect(DRAWER_MIN_WIDTH).toBe(360)
  })

  test('DRAWER_MAX_WIDTH is 640', () => {
    expect(DRAWER_MAX_WIDTH).toBe(640)
  })

  test('DRAWER_DEFAULT_WIDTH is 480', () => {
    expect(DRAWER_DEFAULT_WIDTH).toBe(480)
  })
})

// ─── AC-002-3: Proposal lifecycle ───────────────────────────────────────────

describe('proposal lifecycle (AC-002-3)', () => {
  test('addProposal appends to proposals array', () => {
    const proposal = makeProposal()
    useCronAiStore.getState().addProposal(proposal)

    const { proposals } = useCronAiStore.getState()
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toEqual(proposal)
  })

  test('addProposal appends multiple proposals in order', () => {
    const p1 = makeProposal({ id: 'prop-1' })
    const p2 = makeProposal({ id: 'prop-2' })
    const p3 = makeProposal({ id: 'prop-3' })

    useCronAiStore.getState().addProposal(p1)
    useCronAiStore.getState().addProposal(p2)
    useCronAiStore.getState().addProposal(p3)

    const { proposals } = useCronAiStore.getState()
    expect(proposals).toHaveLength(3)
    expect(proposals.map((p) => p.id)).toEqual(['prop-1', 'prop-2', 'prop-3'])
  })

  test('resolveProposal updates matching proposal status', () => {
    const proposal = makeProposal({ id: 'prop-1', status: 'pending' })
    useCronAiStore.getState().addProposal(proposal)

    useCronAiStore.getState().resolveProposal('prop-1', 'accepted')

    const resolved = useCronAiStore.getState().proposals[0]
    expect(resolved?.status).toBe('accepted')
  })

  test('resolveProposal sets feedback when provided', () => {
    const proposal = makeProposal({ id: 'prop-1' })
    useCronAiStore.getState().addProposal(proposal)

    useCronAiStore.getState().resolveProposal('prop-1', 'rejected', 'Not needed')

    const resolved = useCronAiStore.getState().proposals[0]
    expect(resolved?.status).toBe('rejected')
    expect(resolved?.feedback).toBe('Not needed')
  })

  test('resolveProposal without feedback does not set feedback', () => {
    const proposal = makeProposal({ id: 'prop-1', feedback: null })
    useCronAiStore.getState().addProposal(proposal)

    useCronAiStore.getState().resolveProposal('prop-1', 'accepted')

    const resolved = useCronAiStore.getState().proposals[0]
    expect(resolved?.feedback).toBeNull()
  })

  test('resolveProposal does not affect other proposals', () => {
    useCronAiStore.getState().addProposal(makeProposal({ id: 'prop-1' }))
    useCronAiStore.getState().addProposal(makeProposal({ id: 'prop-2' }))

    useCronAiStore.getState().resolveProposal('prop-1', 'accepted')

    const { proposals } = useCronAiStore.getState()
    expect(proposals[0]?.status).toBe('accepted')
    expect(proposals[1]?.status).toBe('pending')
  })

  test('resolveProposal with non-existent id does not crash', () => {
    useCronAiStore.getState().addProposal(makeProposal({ id: 'prop-1' }))

    // Should not throw
    useCronAiStore.getState().resolveProposal('non-existent', 'accepted')

    expect(useCronAiStore.getState().proposals).toHaveLength(1)
    expect(useCronAiStore.getState().proposals[0]?.status).toBe('pending')
  })

  test('expireProposal sets status to expired', () => {
    useCronAiStore.getState().addProposal(makeProposal({ id: 'prop-1', status: 'pending' }))

    useCronAiStore.getState().expireProposal('prop-1')

    expect(useCronAiStore.getState().proposals[0]?.status).toBe('expired')
  })

  test('expireProposal does not affect other proposals', () => {
    useCronAiStore.getState().addProposal(makeProposal({ id: 'prop-1' }))
    useCronAiStore.getState().addProposal(makeProposal({ id: 'prop-2' }))

    useCronAiStore.getState().expireProposal('prop-1')

    expect(useCronAiStore.getState().proposals[0]?.status).toBe('expired')
    expect(useCronAiStore.getState().proposals[1]?.status).toBe('pending')
  })

  test('clearProposals empties the array and resets count', () => {
    useCronAiStore.getState().addProposal(makeProposal({ id: 'prop-1' }))
    useCronAiStore.getState().addProposal(makeProposal({ id: 'prop-2' }))

    useCronAiStore.getState().clearProposals()

    expect(useCronAiStore.getState().proposals).toEqual([])
    expect(useCronAiStore.getState().pendingProposalCount).toBe(0)
  })

  test('clearProposals on empty store is a no-op', () => {
    useCronAiStore.getState().clearProposals()
    expect(useCronAiStore.getState().proposals).toEqual([])
  })

  test('resolveProposal sets resolvedAt timestamp', () => {
    const proposal = makeProposal({ id: 'prop-1', resolvedAt: null })
    useCronAiStore.getState().addProposal(proposal)

    const before = new Date().toISOString()
    useCronAiStore.getState().resolveProposal('prop-1', 'accepted')
    const after = new Date().toISOString()

    const resolved = useCronAiStore.getState().proposals[0]
    expect(resolved?.resolvedAt).not.toBeNull()
    expect(resolved!.resolvedAt! >= before).toBe(true)
    expect(resolved!.resolvedAt! <= after).toBe(true)
  })

  test('expireProposal sets resolvedAt timestamp', () => {
    useCronAiStore.getState().addProposal(makeProposal({ id: 'prop-1', resolvedAt: null }))

    useCronAiStore.getState().expireProposal('prop-1')

    const expired = useCronAiStore.getState().proposals[0]
    expect(expired?.resolvedAt).not.toBeNull()
  })

  test('addProposal with duplicate id appends (does not deduplicate)', () => {
    useCronAiStore.getState().addProposal(makeProposal({ id: 'dup-1' }))
    useCronAiStore.getState().addProposal(makeProposal({ id: 'dup-1', description: 'second' }))

    // Store should have both entries (dedup is a server concern)
    expect(useCronAiStore.getState().proposals).toHaveLength(2)
  })
})

// ─── AC-002-4: pendingProposalCount derived ─────────────────────────────────

describe('pendingProposalCount (AC-002-4)', () => {
  test('increments when pending proposal is added', () => {
    useCronAiStore.getState().addProposal(makeProposal({ id: 'p1', status: 'pending' }))
    expect(useCronAiStore.getState().pendingProposalCount).toBe(1)

    useCronAiStore.getState().addProposal(makeProposal({ id: 'p2', status: 'pending' }))
    expect(useCronAiStore.getState().pendingProposalCount).toBe(2)
  })

  test('does not count non-pending proposals', () => {
    useCronAiStore.getState().addProposal(makeProposal({ id: 'p1', status: 'pending' }))
    useCronAiStore.getState().addProposal(makeProposal({ id: 'p2', status: 'accepted' }))
    useCronAiStore.getState().addProposal(makeProposal({ id: 'p3', status: 'rejected' }))
    useCronAiStore.getState().addProposal(makeProposal({ id: 'p4', status: 'expired' }))

    expect(useCronAiStore.getState().pendingProposalCount).toBe(1)
  })

  test('decrements when pending proposal is resolved', () => {
    useCronAiStore.getState().addProposal(makeProposal({ id: 'p1', status: 'pending' }))
    useCronAiStore.getState().addProposal(makeProposal({ id: 'p2', status: 'pending' }))
    expect(useCronAiStore.getState().pendingProposalCount).toBe(2)

    useCronAiStore.getState().resolveProposal('p1', 'accepted')
    expect(useCronAiStore.getState().pendingProposalCount).toBe(1)
  })

  test('decrements when pending proposal is expired', () => {
    useCronAiStore.getState().addProposal(makeProposal({ id: 'p1', status: 'pending' }))
    expect(useCronAiStore.getState().pendingProposalCount).toBe(1)

    useCronAiStore.getState().expireProposal('p1')
    expect(useCronAiStore.getState().pendingProposalCount).toBe(0)
  })

  test('is zero after clearProposals', () => {
    useCronAiStore.getState().addProposal(makeProposal({ id: 'p1', status: 'pending' }))
    useCronAiStore.getState().addProposal(makeProposal({ id: 'p2', status: 'pending' }))

    useCronAiStore.getState().clearProposals()
    expect(useCronAiStore.getState().pendingProposalCount).toBe(0)
  })
})

// ─── Session and MCP actions ────────────────────────────────────────────────

describe('session and MCP actions', () => {
  test('setSessionStatus updates status', () => {
    useCronAiStore.getState().setSessionStatus('starting')
    expect(useCronAiStore.getState().sessionStatus).toBe('starting')

    useCronAiStore.getState().setSessionStatus('working')
    expect(useCronAiStore.getState().sessionStatus).toBe('working')

    useCronAiStore.getState().setSessionStatus('waiting')
    expect(useCronAiStore.getState().sessionStatus).toBe('waiting')

    useCronAiStore.getState().setSessionStatus('offline')
    expect(useCronAiStore.getState().sessionStatus).toBe('offline')
  })

  test('setSessionWindowId sets and clears window id', () => {
    useCronAiStore.getState().setSessionWindowId('window-123')
    expect(useCronAiStore.getState().sessionWindowId).toBe('window-123')

    useCronAiStore.getState().setSessionWindowId(null)
    expect(useCronAiStore.getState().sessionWindowId).toBeNull()
  })

  test('setMcpConnected updates connection state', () => {
    useCronAiStore.getState().setMcpConnected(true)
    expect(useCronAiStore.getState().mcpConnected).toBe(true)

    useCronAiStore.getState().setMcpConnected(false)
    expect(useCronAiStore.getState().mcpConnected).toBe(false)
  })

  test('setAutoStartSession updates autoStartSession', () => {
    useCronAiStore.getState().setAutoStartSession(false)
    expect(useCronAiStore.getState().autoStartSession).toBe(false)

    useCronAiStore.getState().setAutoStartSession(true)
    expect(useCronAiStore.getState().autoStartSession).toBe(true)
  })
})

// ─── WS message handlers ────────────────────────────────────────────────────

describe('WS message handlers', () => {
  test('handleCronAiProposal adds proposal to store', () => {
    const proposal = makeProposal({ id: 'ws-prop-1' })
    useCronAiStore.getState().handleCronAiProposal(proposal)

    expect(useCronAiStore.getState().proposals).toHaveLength(1)
    expect(useCronAiStore.getState().proposals[0]?.id).toBe('ws-prop-1')
  })

  test('handleCronAiProposalResolved resolves a proposal', () => {
    useCronAiStore.getState().addProposal(makeProposal({ id: 'ws-prop-1' }))

    useCronAiStore.getState().handleCronAiProposalResolved('ws-prop-1', 'accepted', 'Looks good')

    const resolved = useCronAiStore.getState().proposals[0]
    expect(resolved?.status).toBe('accepted')
    expect(resolved?.feedback).toBe('Looks good')
  })

  test('handleCronAiSessionStatus updates session status', () => {
    useCronAiStore.getState().handleCronAiSessionStatus('working')
    expect(useCronAiStore.getState().sessionStatus).toBe('working')
  })

  test('handleCronAiMcpStatus updates MCP connection state', () => {
    useCronAiStore.getState().handleCronAiMcpStatus(true)
    expect(useCronAiStore.getState().mcpConnected).toBe(true)

    useCronAiStore.getState().handleCronAiMcpStatus(false)
    expect(useCronAiStore.getState().mcpConnected).toBe(false)
  })

  test('handleCronAiProposalResolved without feedback does not set feedback', () => {
    useCronAiStore.getState().addProposal(makeProposal({ id: 'ws-prop-2', feedback: null }))

    useCronAiStore.getState().handleCronAiProposalResolved('ws-prop-2', 'rejected')

    const resolved = useCronAiStore.getState().proposals[0]
    expect(resolved?.status).toBe('rejected')
    expect(resolved?.feedback).toBeNull()
  })

  test('handleCronAiProposalResolved with non-existent id does not crash', () => {
    useCronAiStore.getState().addProposal(makeProposal({ id: 'ws-prop-3' }))

    useCronAiStore.getState().handleCronAiProposalResolved('non-existent', 'accepted')

    expect(useCronAiStore.getState().proposals).toHaveLength(1)
    expect(useCronAiStore.getState().proposals[0]?.status).toBe('pending')
  })
})

// ─── AC-002-5: Persistence ──────────────────────────────────────────────────

describe('persistence (AC-002-5)', () => {
  test('drawerWidth is persisted to localStorage', () => {
    useCronAiStore.getState().setDrawerWidth(550)

    const persisted = storage.getItem('agentboard-cron-ai')
    expect(persisted).not.toBeNull()

    const parsed = JSON.parse(persisted!)
    expect(parsed.state.drawerWidth).toBe(550)
  })

  test('autoStartSession is persisted to localStorage', () => {
    useCronAiStore.getState().setAutoStartSession(false)

    const persisted = storage.getItem('agentboard-cron-ai')
    expect(persisted).not.toBeNull()

    const parsed = JSON.parse(persisted!)
    expect(parsed.state.autoStartSession).toBe(false)
  })

  test('runtime state (drawerOpen, sessionStatus, proposals) is NOT persisted', () => {
    useCronAiStore.setState({
      drawerOpen: true,
      sessionStatus: 'working',
      proposals: [makeProposal()],
    })

    // Force a persist write by changing a persisted key
    useCronAiStore.getState().setDrawerWidth(400)

    const persisted = storage.getItem('agentboard-cron-ai')
    expect(persisted).not.toBeNull()

    const parsed = JSON.parse(persisted!)
    expect(parsed.state.drawerOpen).toBeUndefined()
    expect(parsed.state.sessionStatus).toBeUndefined()
    expect(parsed.state.proposals).toBeUndefined()
    expect(parsed.state.mcpConnected).toBeUndefined()
    expect(parsed.state.sessionWindowId).toBeUndefined()
    expect(parsed.state.pendingProposalCount).toBeUndefined()
  })

  test('persist storage key is agentboard-cron-ai', () => {
    useCronAiStore.getState().setDrawerWidth(500)

    expect(storage.getItem('agentboard-cron-ai')).not.toBeNull()
  })
})
