/**
 * Regression test for BUG-1: WebSocket send() silent failure
 *
 * WebSocketManager.send() (useWebSocket.ts:97-101) currently returns void.
 * When the socket is disconnected (readyState !== OPEN), the message is silently
 * dropped with no indication to the caller. This causes the CronCreateModal to
 * close unconditionally even when the message was never sent.
 *
 * Fix: send() should return a boolean:
 *   - true if the message was sent (readyState === OPEN)
 *   - false if the socket was not open (message dropped)
 *
 * This test MUST FAIL until the fix is applied.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ClientMessage } from '@shared/types'
import { WebSocketManager } from '../hooks/useWebSocket'

class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.OPEN
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }

  triggerOpen() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  triggerMessage(payload: string) {
    this.onmessage?.({ data: payload })
  }

  triggerError() {
    this.onerror?.()
  }
}

const globalAny = globalThis as typeof globalThis & {
  window?: unknown
  WebSocket?: unknown
}
const originalWindow = globalAny.window
const originalWebSocket = globalAny.WebSocket

let nextTimerId = 1
const timers: { id: number; callback: () => void; delay: number }[] = []

beforeEach(() => {
  nextTimerId = 1
  timers.length = 0
  FakeWebSocket.instances = []

  globalAny.window = {
    location: { protocol: 'http:', host: 'localhost:1234' },
    setTimeout: (callback: () => void, delay: number) => {
      const id = nextTimerId++
      timers.push({ id, callback, delay })
      return id
    },
    clearTimeout: (id: number) => {
      const idx = timers.findIndex((t) => t.id === id)
      if (idx !== -1) timers.splice(idx, 1)
    },
  } as typeof window

  globalAny.WebSocket = FakeWebSocket as unknown as typeof WebSocket
})

afterEach(() => {
  globalAny.window = originalWindow
  globalAny.WebSocket = originalWebSocket
})

describe('BUG-1: WebSocketManager.send() return value', () => {
  test('send() returns true when socket is open and message is sent', () => {
    const manager = new WebSocketManager()
    manager.connect()
    const ws = FakeWebSocket.instances[0]
    ws?.triggerOpen()

    const message: ClientMessage = { type: 'session-refresh' }
    const result = manager.send(message)

    // After fix: send() returns true when message was delivered
    // BUG (current code): send() returns void (undefined)
    expect(result).toBe(true)
    expect(ws?.sent).toHaveLength(1)
  })

  test('send() returns false when socket is closed and message is dropped', () => {
    const manager = new WebSocketManager()
    manager.connect()
    const ws = FakeWebSocket.instances[0]
    ws?.triggerOpen()

    // Simulate disconnected state
    if (ws) {
      ws.readyState = FakeWebSocket.CLOSED
    }

    const message: ClientMessage = { type: 'session-refresh' }
    const result = manager.send(message)

    // After fix: send() returns false when message was dropped
    // BUG (current code): send() returns void (undefined)
    expect(result).toBe(false)
    // Message should NOT have been sent
    expect(ws?.sent).toHaveLength(0)
  })

  test('send() returns false before connection is established', () => {
    const manager = new WebSocketManager()
    manager.connect()
    // Do NOT trigger open - socket is connecting

    const message: ClientMessage = { type: 'session-refresh' }
    const result = manager.send(message)

    // After fix: send() returns false while connecting
    // BUG (current code): send() returns void (undefined)
    expect(result).toBe(false)
  })

  test('send() returns false when manager has no WebSocket instance', () => {
    const manager = new WebSocketManager()
    // Do NOT call connect() - no WebSocket instance created

    const message: ClientMessage = { type: 'session-refresh' }
    const result = manager.send(message)

    // After fix: send() returns false when no socket exists
    // BUG (current code): send() returns void (undefined)
    expect(result).toBe(false)
  })
})
