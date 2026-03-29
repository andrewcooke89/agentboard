import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { AgentSession } from '@shared/types'

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
}

const originalWindow = globalAny.window
let SessionPreviewModal: typeof import('../components/SessionPreviewModal').default

let keyHandlers = new Map<string, EventListener>()
let authFetchMock: ReturnType<typeof mock>
let originalAuthFetch: typeof import('../utils/api').authFetch

function setupWindow() {
  keyHandlers = new Map()
  globalAny.window = {
    addEventListener: (event: string, handler: EventListener) => {
      keyHandlers.set(event, handler)
    },
    removeEventListener: (event: string) => {
      keyHandlers.delete(event)
    },
  } as unknown as Window & typeof globalThis
}

function createJsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function flushUpdates() {
  await flushPromises()
  await flushPromises()
}

async function createModal(element: JSX.Element) {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(element)
    await flushUpdates()
  })
  return renderer
}

async function resolveAndFlush(controller: { resolveNext: () => void }) {
  await act(async () => {
    controller.resolveNext()
    await flushUpdates()
  })
}

async function cleanup(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    renderer.unmount()
    await flushUpdates()
  })
}

function createFetchController(responses: Response[], calls: string[] = []) {
  const pending: Array<(value: Response) => void> = []
  
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string
    if (typeof input === 'string') {
      url = input
    } else if (input instanceof URL) {
      url = input.toString()
    } else {
      url = input.url
    }
    if (url.startsWith('/api/session-preview/')) {
      calls.push(url)
      return new Promise<Response>((resolve) => {
        pending.push(resolve)
      })
    }
    return Promise.reject(new Error('Unexpected fetch'))
  }
  
  authFetchMock.mockImplementation(fetchImpl)

  const resolveNext = () => {
    const resolve = pending.shift()
    const response = responses.shift()
    if (!resolve || !response) {
      throw new Error('Unexpected fetch resolution')
    }
    resolve(response)
  }

  return { calls, resolveNext }
}

const baseSession: AgentSession = {
  sessionId: 'session-12345678',
  logFilePath: '/tmp/session.jsonl',
  projectPath: '/projects/alpha',
  agentType: 'claude',
  displayName: '',
  createdAt: '2024-01-01T00:00:00.000Z',
  lastActivityAt: new Date(Date.now() - 120000).toISOString(),
  isActive: false,
}

beforeEach(async () => {
  setupWindow()
  
  // Store original authFetch
  const apiModule = await import('../utils/api')
  originalAuthFetch = apiModule.authFetch
  
  // Create mock
  authFetchMock = mock(() => Promise.reject(new Error('authFetch not mocked')))
  
  // Replace authFetch in module cache
  const module = await import('../utils/api')
  ;(module as unknown as Record<string, unknown>).authFetch = authFetchMock
  
  // Always re-import to pick up the mocked authFetch
  SessionPreviewModal = (await import('../components/SessionPreviewModal')).default
})

afterEach(() => {
  globalAny.window = originalWindow
  keyHandlers.clear()
  
  // Restore original authFetch
  import('../utils/api').then((module) => {
    ;(module as unknown as Record<string, unknown>).authFetch = originalAuthFetch
  })
})

describe('SessionPreviewModal', () => {
  test('loads preview, shows parsed entries, toggles raw, and resumes', async () => {
    const previewData = {
      sessionId: baseSession.sessionId,
      displayName: 'Alpha',
      projectPath: baseSession.projectPath,
      agentType: 'claude',
      lastActivityAt: baseSession.lastActivityAt,
      lines: [
        JSON.stringify({ type: 'user', message: { content: 'Hello' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'World' }] } }),
        JSON.stringify({ type: 'tool_use', name: 'search' }),
        JSON.stringify({ type: 'result', result: 'Done' }),
        'plain text line',
      ],
    }

    const controller = createFetchController([createJsonResponse(previewData)])
    let resumed: string[] = []

    const renderer = await createModal(
      <SessionPreviewModal
        session={baseSession}
        onClose={() => {}}
        onResume={(sessionId) => {
          resumed.push(sessionId)
        }}
      />
    )

    let html = JSON.stringify(renderer.toJSON())
    expect(html).toContain('Loading preview...')

    await resolveAndFlush(controller)

    html = JSON.stringify(renderer.toJSON())
    expect(html).toContain('Hello')
    expect(html).toContain('World')
    expect(html).toContain('[Tool: search]')
    expect(html).toContain('Done')
    expect(html).toContain('plain text line')

    const toggleButton = renderer.root
      .findAllByType('button')
      .find((button) => button.props.children === 'Raw')

    if (!toggleButton) {
      throw new Error('Expected toggle button')
    }

    act(() => {
      toggleButton.props.onClick()
    })

    html = JSON.stringify(renderer.toJSON())
    expect(html).toContain('\\\"type\\\":\\\"user\\\"')

    const resumeButton = renderer.root
      .findAllByType('button')
      .find((button) => button.props.children === 'Resume')

    if (!resumeButton) {
      throw new Error('Expected resume button')
    }

    act(() => {
      resumeButton.props.onClick()
    })

    expect(resumed).toEqual([baseSession.sessionId])

    const handler = keyHandlers.get('keydown')
    if (!handler) {
      throw new Error('Expected keydown handler')
    }

    const enterEvent = { key: 'Enter', preventDefault: () => {} } as KeyboardEvent
    act(() => {
      handler(enterEvent)
    })

    expect(resumed).toEqual([baseSession.sessionId, baseSession.sessionId])

    await cleanup(renderer)
  })

  test('handles errors, closes on escape and backdrop, and disables resume', async () => {
    const controller = createFetchController([
      createJsonResponse({ error: 'No preview available' }, { status: 500 }),
    ])

    let closed = 0
    let resumed = 0

    const renderer = await createModal(
      <SessionPreviewModal
        session={baseSession}
        onClose={() => {
          closed += 1
        }}
        onResume={() => {
          resumed += 1
        }}
      />
    )

    await resolveAndFlush(controller)

    const html = JSON.stringify(renderer.toJSON())
    expect(html).toContain('No preview available')

    const resumeButton = renderer.root
      .findAllByType('button')
      .find((button) => button.props.children === 'Resume')

    if (!resumeButton) {
      throw new Error('Expected resume button')
    }

    expect(resumeButton.props.disabled).toBe(true)

    const handler = keyHandlers.get('keydown')
    if (!handler) {
      throw new Error('Expected keydown handler')
    }

    let stopped = 0
    const escapeEvent = {
      key: 'Escape',
      stopPropagation: () => {
        stopped += 1
      },
    } as KeyboardEvent

    act(() => {
      handler(escapeEvent)
    })

    expect(closed).toBe(1)
    expect(stopped).toBe(1)

    const enterEvent = { key: 'Enter', preventDefault: () => {} } as KeyboardEvent
    act(() => {
      handler(enterEvent)
    })

    expect(resumed).toBe(0)

    const overlay = renderer.root.findByProps({ role: 'dialog' })
    act(() => {
      overlay.props.onClick({ target: overlay, currentTarget: overlay })
    })

    expect(closed).toBe(2)

    await cleanup(renderer)
  })
})
