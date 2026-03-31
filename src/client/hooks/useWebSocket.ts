import { useEffect, useMemo, useState } from 'react'
import type { ClientMessage, ServerMessage } from '@shared/types'
import type { ConnectionStatus } from '../stores/sessionStore'
import { useSessionStore } from '../stores/sessionStore'
import { useAuthStore } from '../stores/authStore'
import { useWorkflowStore } from '../stores/workflowStore'

type MessageListener = (message: ServerMessage) => void

type StatusListener = (status: ConnectionStatus, error: string | null) => void

export class WebSocketManager {
  private ws: WebSocket | null = null
  private wsOpen = false
  private listeners = new Set<MessageListener>()
  private statusListeners = new Set<StatusListener>()
  private status: ConnectionStatus = 'connecting'
  private error: string | null = null
  private reconnectAttempts = 0
  private reconnectTimer: number | null = null
  private manualClose = false

  connect() {
    if (this.ws) {
      return
    }

    this.manualClose = false
    this.wsOpen = false
    this.setStatus('connecting')
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const wsUrl = `${scheme}://${window.location.host}/ws`

    const ws = new WebSocket(wsUrl)
    this.ws = ws

    ws.onopen = () => {
      const isReconnect = this.reconnectAttempts > 0
      this.reconnectAttempts = 0
      this.wsOpen = true
      this.setStatus('connected')

      // Send auth message on open if token is available
      const token = useAuthStore.getState().token
      if (token) {
        ws.send(JSON.stringify({ type: 'auth', token }))
      }

      // On reconnect, refresh workflow state to avoid staleness
      if (isReconnect) {
        const workflowStore = useWorkflowStore.getState()
        if (workflowStore.hasLoaded) {
          workflowStore.fetchWorkflows()
        }
      }
    }

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data as string) as ServerMessage

        // Handle auth-failed: clear token and flag auth required
        if (parsed.type === 'auth-failed') {
          const authStore = useAuthStore.getState()
          authStore.setToken(null)
          authStore.setAuthRequired(true)
          return
        }

        this.listeners.forEach((listener) => listener(parsed))
      } catch (e) {
        console.error(e)
      }
    }

    ws.onerror = () => {
      this.setStatus('error', 'WebSocket error')
    }

    ws.onclose = () => {
      this.ws = null
      this.wsOpen = false
      if (!this.manualClose) {
        this.scheduleReconnect()
      } else {
        this.setStatus('disconnected')
      }
    }
  }

  disconnect() {
    this.manualClose = true
    this.wsOpen = false
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
  }

  send(message: ClientMessage): boolean {
    if (this.ws && this.wsOpen && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
      return true
    }
    return false
  }

  subscribe(listener: MessageListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeStatus(listener: StatusListener) {
    this.statusListeners.add(listener)
    listener(this.status, this.error)
    return () => this.statusListeners.delete(listener)
  }

  getStatus() {
    return this.status
  }

  private setStatus(status: ConnectionStatus, error: string | null = null) {
    this.status = status
    this.error = error
    this.statusListeners.forEach((listener) => listener(status, error))
  }

  private scheduleReconnect() {
    this.reconnectAttempts += 1
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 30000)
    this.setStatus('reconnecting')
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer)
    }

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }
}

const manager = new WebSocketManager()

export function useWebSocket() {
  const setConnectionStatus = useSessionStore(
    (state) => state.setConnectionStatus
  )
  const setConnectionError = useSessionStore(
    (state) => state.setConnectionError
  )
  const [status, setStatus] = useState<ConnectionStatus>(
    manager.getStatus()
  )

  useEffect(() => {
    manager.connect()
    const unsubscribe = manager.subscribeStatus((nextStatus, error) => {
      setStatus(nextStatus)
      setConnectionStatus(nextStatus)
      setConnectionError(error)
    })

    return () => {
      unsubscribe()
    }
  }, [setConnectionError, setConnectionStatus])

  const sendMessage = useMemo(() => manager.send.bind(manager), [])
  const subscribe = useMemo(() => manager.subscribe.bind(manager), [])

  return {
    status,
    sendMessage,
    subscribe,
  }
}
