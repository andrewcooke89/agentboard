import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ServerMessage, PendingReviewItem, PendingReviewType } from '@shared/types'
import Header from './components/Header'
import SessionList from './components/SessionList'
import Terminal from './components/Terminal'
import NewSessionModal from './components/NewSessionModal'
import SettingsModal from './components/SettingsModal'
import TaskQueue from './components/TaskQueue'
import WorkflowList from './components/WorkflowList'
import WorkflowDetail from './components/WorkflowDetail'
import WorkflowEditor from './components/WorkflowEditor'
import WorkflowPanel from './components/WorkflowPanel'
import ErrorBoundary from './components/ErrorBoundary'
import { ToastViewport, toastManager } from './components/Toast'
import { CronManager } from './components/cron/CronManager'
import { useSessionStore } from './stores/sessionStore'
import { useTaskStore } from './stores/taskStore'
import { useWorkflowStore } from './stores/workflowStore'
import {
  useSettingsStore,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from './stores/settingsStore'
import { useThemeStore } from './stores/themeStore'
import { useWebSocket } from './hooks/useWebSocket'
import { useVisualViewport } from './hooks/useVisualViewport'
import { sortSessions } from './utils/sessions'
import { getEffectiveModifier, matchesModifier } from './utils/device'
import { playPermissionSound, playIdleSound, primeAudio } from './utils/sound'
import { authFetch } from './utils/api'
import { showNotification, getNotificationPermission, requestNotificationPermission } from './utils/notification'
import HistorySection from './components/HistorySection'
import { useHistoryStore } from './stores/historyStore'
import type { Task } from '@shared/types'
import PoolStatusIndicator from './components/PoolStatusIndicator'
import PendingReviewDashboard from './components/PendingReviewDashboard'
import { usePoolStore } from './stores/poolStore'
import { useCronStore } from './stores/cronStore'

interface ServerInfo {
  port: number
  tailscaleIp: string | null
  protocol: string
}

export default function App() {
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null)
  const [activeView, setActiveView] = useState<'sessions' | 'workflow-list' | 'workflow-detail' | 'workflow-editor' | 'pending-reviews' | 'cron-manager'>('sessions')
  const [activeWorkflowId, setActiveWorkflowId] = useState<string | null>(null)
  const [workflowPanelOpen, setWorkflowPanelOpen] = useState(false)
  const [dismissedPermissionBanners, setDismissedPermissionBanners] = useState<Set<string>>(new Set())

  const sessions = useSessionStore((state) => state.sessions)
  const agentSessions = useSessionStore((state) => state.agentSessions)
  const selectedSessionId = useSessionStore(
    (state) => state.selectedSessionId
  )
  const setSessions = useSessionStore((state) => state.setSessions)
  const setAgentSessions = useSessionStore((state) => state.setAgentSessions)
  const updateSession = useSessionStore((state) => state.updateSession)
  const setSelectedSessionId = useSessionStore(
    (state) => state.setSelectedSessionId
  )
  const hasLoaded = useSessionStore((state) => state.hasLoaded)
  const connectionStatus = useSessionStore(
    (state) => state.connectionStatus
  )
  const connectionError = useSessionStore((state) => state.connectionError)
  const clearExitingSession = useSessionStore((state) => state.clearExitingSession)
  const markSessionExiting = useSessionStore((state) => state.markSessionExiting)

  const theme = useThemeStore((state) => state.theme)
  const defaultProjectDir = useSettingsStore(
    (state) => state.defaultProjectDir
  )
  const commandPresets = useSettingsStore((state) => state.commandPresets)
  const defaultPresetId = useSettingsStore((state) => state.defaultPresetId)
  const updatePresetModifiers = useSettingsStore(
    (state) => state.updatePresetModifiers
  )
  const lastProjectPath = useSettingsStore((state) => state.lastProjectPath)
  const setLastProjectPath = useSettingsStore(
    (state) => state.setLastProjectPath
  )
  const addRecentPath = useSettingsStore((state) => state.addRecentPath)
  const shortcutModifier = useSettingsStore((state) => state.shortcutModifier)
  const sidebarWidth = useSettingsStore((state) => state.sidebarWidth)
  const setSidebarWidth = useSettingsStore((state) => state.setSidebarWidth)
  const projectFilters = useSettingsStore((state) => state.projectFilters)
  const projectPathPresets = useSettingsStore((state) => state.projectPathPresets)
  const soundOnPermission = useSettingsStore((state) => state.soundOnPermission)
  const soundOnIdle = useSettingsStore((state) => state.soundOnIdle)
  const notifyOnPermission = useSettingsStore((state) => state.notifyOnPermission)

  const showHistory = useHistoryStore((state) => state.showHistory)
  const setShowHistory = useHistoryStore((state) => state.setShowHistory)
  const loadRecentHistory = useHistoryStore((state) => state.loadRecent)

  const showTaskQueue = useTaskStore((state) => state.showTaskQueue)
  const setShowTaskQueue = useTaskStore((state) => state.setShowTaskQueue)
  const taskStats = useTaskStore((state) => state.stats)
  const setTasks = useTaskStore((state) => state.setTasks)
  const setTaskStats = useTaskStore((state) => state.setStats)
  const addTask = useTaskStore((state) => state.addTask)
  const updateTask = useTaskStore((state) => state.updateTask)
  const setTemplates = useTaskStore((state) => state.setTemplates)

  const poolStatus = usePoolStore((state) => state.poolStatus)
  const fetchPoolStatus = usePoolStore((state) => state.fetchPoolStatus)
  const handlePoolStatusUpdate = usePoolStore((state) => state.handlePoolStatusUpdate)

  const handleWorkflowList = useWorkflowStore((state) => state.handleWorkflowList)
  const handleWorkflowUpdated = useWorkflowStore((state) => state.handleWorkflowUpdated)
  const handleWorkflowRemoved = useWorkflowStore((state) => state.handleWorkflowRemoved)
  const handleWorkflowRunUpdate = useWorkflowStore((state) => state.handleWorkflowRunUpdate)
  const handleWorkflowRunList = useWorkflowStore((state) => state.handleWorkflowRunList)
  const workflowRuns = useWorkflowStore((state) => state.workflowRuns)

  const { sendMessage, subscribe } = useWebSocket()

  // Handle mobile keyboard viewport adjustments
  useVisualViewport()

  // Prime audio on first user interaction (required for Safari/iOS autoplay policy)
  useEffect(() => {
    if (typeof document === 'undefined') return
    if (!soundOnPermission && !soundOnIdle) return

    const unlockAudio = () => {
      void primeAudio()
      document.removeEventListener('click', unlockAudio)
      document.removeEventListener('keydown', unlockAudio)
      document.removeEventListener('touchstart', unlockAudio)
    }

    document.addEventListener('click', unlockAudio, { once: true, passive: true })
    document.addEventListener('keydown', unlockAudio, { once: true, passive: true })
    document.addEventListener('touchstart', unlockAudio, { once: true, passive: true })

    return () => {
      document.removeEventListener('click', unlockAudio)
      document.removeEventListener('keydown', unlockAudio)
      document.removeEventListener('touchstart', unlockAudio)
    }
  }, [soundOnPermission, soundOnIdle])

  // Auto-request notification permission on first load when notifyOnPermission is enabled
  useEffect(() => {
    if (typeof window === 'undefined' || !notifyOnPermission) return
    const permission = getNotificationPermission()
    if (permission === 'default') {
      void requestNotificationPermission()
    }
  }, [notifyOnPermission])

  // Sidebar resize handling
  const isResizing = useRef(false)
  const lastNotifyTimeRef = useRef(0)
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    // Guard for SSR/test environments where document.addEventListener may not exist
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
      return
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return
      const newWidth = e.clientX
      setSidebarWidth(
        Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, newWidth))
      )
    }

    const handleMouseUp = () => {
      if (isResizing.current) {
        isResizing.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [setSidebarWidth])

  useEffect(() => {
    const unsubscribe = subscribe((message: ServerMessage) => {
      if (message.type === 'sessions') {
        // Detect status transitions for sound notifications before updating
        const currentSessions = useSessionStore.getState().sessions
        const { soundOnPermission, soundOnIdle, notifyOnPermission, notifyOnIdle } = useSettingsStore.getState()

        if (soundOnPermission || soundOnIdle || notifyOnPermission || notifyOnIdle) {
          const now = Date.now()
          const canNotify = getNotificationPermission() === 'granted' && (now - lastNotifyTimeRef.current > 2000)
          for (const nextSession of message.sessions) {
            const prevSession = currentSessions.find((s) => s.id === nextSession.id)
            if (prevSession && prevSession.status !== nextSession.status) {
              if (prevSession.status !== 'permission' && nextSession.status === 'permission') {
                if (soundOnPermission) void playPermissionSound()
                if (notifyOnPermission && canNotify) {
                  showNotification('Permission Required', { body: `Session "${nextSession.name}" needs input` })
                  lastNotifyTimeRef.current = Date.now()
                }
              }
              if (prevSession.status === 'working' && nextSession.status === 'waiting') {
                if (soundOnIdle) void playIdleSound()
                if (notifyOnIdle && canNotify) {
                  showNotification('Session Idle', { body: `Session "${nextSession.name}" finished working` })
                  lastNotifyTimeRef.current = Date.now()
                }
              }
            }
          }
        }

        setSessions(message.sessions)
      }
      if (message.type === 'session-update') {
        // Detect status transitions for sound notifications
        // Capture previous status BEFORE updating to ensure we have the old value
        const currentSessions = useSessionStore.getState().sessions
        const prevSession = currentSessions.find((s) => s.id === message.session.id)
        const prevStatus = prevSession?.status
        const nextStatus = message.session.status

        updateSession(message.session)

        // Only play sounds for known sessions (skip new/unknown sessions)
        if (prevStatus) {
          const { soundOnPermission, soundOnIdle, notifyOnPermission, notifyOnIdle } = useSettingsStore.getState()
          const now = Date.now()
          const canNotify = getNotificationPermission() === 'granted' && (now - lastNotifyTimeRef.current > 2000)

          if (prevStatus !== 'permission' && nextStatus === 'permission') {
            if (soundOnPermission) void playPermissionSound()
            if (notifyOnPermission && canNotify) {
              showNotification('Permission Required', { body: `Session "${message.session.name}" needs input` })
              lastNotifyTimeRef.current = Date.now()
            }
          }
          if (prevStatus === 'working' && nextStatus === 'waiting') {
            if (soundOnIdle) void playIdleSound()
            if (notifyOnIdle && canNotify) {
              showNotification('Session Idle', { body: `Session "${message.session.name}" finished working` })
              lastNotifyTimeRef.current = Date.now()
            }
          }
        }
      }
      if (message.type === 'session-created') {
        // Add session to list immediately (don't wait for async refresh)
        const currentSessions = useSessionStore.getState().sessions
        if (!currentSessions.some((s) => s.id === message.session.id)) {
          setSessions([message.session, ...currentSessions])
        }
        setSelectedSessionId(message.session.id)
        addRecentPath(message.session.projectPath)
      }
      if (message.type === 'session-removed') {
        // setSessions handles marking removed sessions as exiting for animation
        const currentSessions = useSessionStore.getState().sessions
        const nextSessions = currentSessions.filter(
          (session) => session.id !== message.sessionId
        )
        if (nextSessions.length !== currentSessions.length) {
          setSessions(nextSessions)
        }
      }
      if (message.type === 'agent-sessions') {
        setAgentSessions(message.active, message.inactive)
      }
      if (message.type === 'session-orphaned') {
        const currentSessions = useSessionStore.getState().sessions
        const nextSessions = currentSessions.filter(
          (session) => session.agentSessionId?.trim() !== message.session.sessionId
        )
        if (nextSessions.length !== currentSessions.length) {
          setSessions(nextSessions)
        }
      }
      if (message.type === 'session-resume-result') {
        if (message.ok && message.session) {
          // Add resumed session to list immediately
          const currentSessions = useSessionStore.getState().sessions
          if (!currentSessions.some((s) => s.id === message.session!.id)) {
            setSessions([message.session, ...currentSessions])
          }
          setSelectedSessionId(message.session.id)
        } else if (!message.ok) {
          setServerError(`${message.error?.code}: ${message.error?.message}`)
          window.setTimeout(() => setServerError(null), 6000)
        }
      }
      if (message.type === 'terminal-error') {
        if (!message.sessionId || message.sessionId === selectedSessionId) {
          setServerError(`${message.code}: ${message.message}`)
          window.setTimeout(() => setServerError(null), 6000)
        }
      }
      if (message.type === 'terminal-ready') {
        if (message.sessionId === selectedSessionId) {
          setServerError(null)
        }
      }
      if (message.type === 'error') {
        setServerError(message.message)
        window.setTimeout(() => setServerError(null), 6000)
      }
      if (message.type === 'kill-failed') {
        // Clear from exiting state since kill failed - session remains active
        clearExitingSession(message.sessionId)
        setServerError(message.message)
        window.setTimeout(() => setServerError(null), 6000)
      }
      if (message.type === 'session-pin-result') {
        if (!message.ok && message.error) {
          setServerError(message.error)
          window.setTimeout(() => setServerError(null), 6000)
        }
      }
      if (message.type === 'session-resurrection-failed') {
        toastManager.add({
          title: 'Session resurrection failed',
          description: `"${message.displayName}" could not be resumed: ${message.error}`,
          type: 'error',
          timeout: 8000,
        })
      }
      // Task queue messages
      if (message.type === 'task-created') {
        addTask(message.task)
      }
      if (message.type === 'task-updated') {
        updateTask(message.task)
      }
      if (message.type === 'task-list') {
        setTasks(message.tasks)
        setTaskStats(message.stats)
      }
      if (message.type === 'template-list') {
        setTemplates(message.templates)
      }
      // Workflow engine messages
      if (message.type === 'workflow-list') {
        handleWorkflowList(message.workflows)
      }
      if (message.type === 'workflow-updated') {
        handleWorkflowUpdated(message.workflow)
      }
      if (message.type === 'workflow-removed') {
        handleWorkflowRemoved(message.workflowId)
      }
      if (message.type === 'workflow-run-update') {
        handleWorkflowRunUpdate(message.run)
      }
      if (message.type === 'workflow-run-list') {
        handleWorkflowRunList(message.runs)
      }
      // Phase 15: Pool status messages (REQ-13)
      if (message.type === 'pool_status_update') {
        handlePoolStatusUpdate({
          maxSlots: message.max,
          activeSlots: [],
          queue: [],
        })
      }
      // Phase 15: Review iteration updates (REQ-08)
      if (message.type === 'review_iteration') {
        handleWorkflowRunUpdate(message.run)
      }
      // Phase 15: Pool slot granted (REQ-13)
      if (message.type === 'pool_slot_granted' && message.poolStatus) {
        handlePoolStatusUpdate(message.poolStatus)
      }
      // Phase 15: Step queued (REQ-13)
      if (message.type === 'step_queued' && message.poolStatus) {
        handlePoolStatusUpdate(message.poolStatus)
      }
      // Phase 15: Signal detected (REQ-30)
      if (message.type === 'signal_detected') {
        // Update workflow run state with new signal
        const currentRuns = useWorkflowStore.getState().workflowRuns
        const run = currentRuns.find((r) => r.id === message.runId)
        if (run && run.steps_state) {
          const updatedSteps = run.steps_state.map((step) => {
            if (step.name === message.stepName) {
              const signals = step.detectedSignals || []
              return {
                ...step,
                detectedSignals: [
                  ...signals,
                  {
                    id: `${message.runId}-${message.stepName}-${Date.now()}`,
                    type: message.signalType,
                    timestamp: new Date().toISOString(),
                    resolutionStatus: 'pending' as const,
                    content: JSON.stringify(message.details),
                    checkpointData: null
                  }
                ]
              }
            }
            return step
          })
          handleWorkflowRunUpdate({ ...run, steps_state: updatedSteps })
        }
      }
      // Phase 15: Amendment filed (REQ-19)
      if (message.type === 'amendment_filed') {
        // Update workflow run state with new amendment
        const currentRuns = useWorkflowStore.getState().workflowRuns
        const run = currentRuns.find((r) => r.id === message.runId)
        if (run) {
          handleWorkflowRunUpdate({
            ...run,
            pendingAmendment: {
              id: message.amendmentId,
              specSection: 'unknown',
              issue: 'Amendment filed',
              proposedChange: null,
              category: message.amendmentType,
              autoApproved: false,
              autoApprovedBy: null
            }
          })
        }
      }
      // Phase 15: Amendment resolved (REQ-19)
      if (message.type === 'amendment_resolved') {
        // Clear pending amendment from workflow run
        const currentRuns = useWorkflowStore.getState().workflowRuns
        const run = currentRuns.find((r) => r.id === message.runId)
        if (run) {
          handleWorkflowRunUpdate({
            ...run,
            pendingAmendment: null
          })
        }
      }
      // Cron manager messages — delegate all cron-* to cronStore
      if (message.type.startsWith('cron-')) {
        useCronStore.getState().handleServerMessage(message)
      }
      // Phase 15: Step paused (REQ-32)
      if (message.type === 'step_paused') {
        // Update step status to paused
        const currentRuns = useWorkflowStore.getState().workflowRuns
        const run = currentRuns.find((r) => r.id === message.runId)
        if (run && run.steps_state) {
          const updatedSteps = run.steps_state.map((step) => {
            if (step.name === message.stepName) {
              return {
                ...step,
                status: 'paused_human' as const,
                errorMessage: message.reason
              }
            }
            return step
          })
          handleWorkflowRunUpdate({ ...run, steps_state: updatedSteps })
        }
      }
    })

    return () => { unsubscribe() }
  }, [
    selectedSessionId,
    addRecentPath,
    clearExitingSession,
    sendMessage,
    setSelectedSessionId,
    setSessions,
    setAgentSessions,
    subscribe,
    updateSession,
    addTask,
    updateTask,
    setTasks,
    setTaskStats,
    setTemplates,
    handleWorkflowList,
    handleWorkflowUpdated,
    handleWorkflowRemoved,
    handleWorkflowRunUpdate,
    handleWorkflowRunList,
    handlePoolStatusUpdate,
    fetchPoolStatus,
  ])

  const selectedSession = useMemo(() => {
    return (
      sessions.find((session) => session.id === selectedSessionId) || null
    )
  }, [selectedSessionId, sessions])

  // Track last viewed project path
  useEffect(() => {
    if (selectedSession?.projectPath) {
      setLastProjectPath(selectedSession.projectPath)
    }
  }, [selectedSession?.projectPath, setLastProjectPath])

  const sessionSortMode = useSettingsStore((state) => state.sessionSortMode)
  const sessionSortDirection = useSettingsStore(
    (state) => state.sessionSortDirection
  )
  const manualSessionOrder = useSettingsStore(
    (state) => state.manualSessionOrder
  )

  const sortedSessions = useMemo(
    () =>
      sortSessions(sessions, {
        mode: sessionSortMode,
        direction: sessionSortDirection,
        manualOrder: manualSessionOrder,
      }),
    [sessions, sessionSortMode, sessionSortDirection, manualSessionOrder]
  )

  // Apply project filters to sorted sessions for keyboard navigation
  const filteredSortedSessions = useMemo(() => {
    if (projectFilters.length === 0) return sortedSessions
    return sortedSessions.filter((session) =>
      projectFilters.includes(session.projectPath)
    )
  }, [sortedSessions, projectFilters])

  // Auto-select first visible session when current selection is filtered out
  useEffect(() => {
    if (
      selectedSessionId &&
      filteredSortedSessions.length > 0 &&
      !filteredSortedSessions.some((s) => s.id === selectedSessionId)
    ) {
      setSelectedSessionId(filteredSortedSessions[0].id)
    }
  }, [selectedSessionId, filteredSortedSessions, setSelectedSessionId])

  // Auto-select first session on mobile when sessions load
  useEffect(() => {
    const isMobile = window.matchMedia('(max-width: 767px)').matches
    if (isMobile && hasLoaded && selectedSessionId === null && sortedSessions.length > 0) {
      setSelectedSessionId(sortedSessions[0].id)
    }
  }, [hasLoaded, selectedSessionId, sortedSessions, setSelectedSessionId])

  const handleKillSession = useCallback((sessionId: string) => {
    // Mark as exiting before sending kill to preserve session data for exit animation
    markSessionExiting(sessionId)
    sendMessage({ type: 'session-kill', sessionId })
  }, [markSessionExiting, sendMessage])

  useEffect(() => {
    const effectiveModifier = getEffectiveModifier(shortcutModifier)

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return

      // Use event.code for consistent detection across browsers
      // (event.key fails in Chrome/Arc on macOS due to Option dead keys)
      const code = event.code
      const isShortcut = matchesModifier(event, effectiveModifier)

      // Bracket navigation: [mod]+[ / ]
      if (isShortcut && (code === 'BracketLeft' || code === 'BracketRight')) {
        event.preventDefault()
        // Use filtered sessions so navigation respects project filter
        const navSessions = filteredSortedSessions
        if (navSessions.length === 0) return
        const currentIndex = navSessions.findIndex(s => s.id === selectedSessionId)
        if (currentIndex === -1) {
          setSelectedSessionId(navSessions[0].id)
          return
        }
        const delta = code === 'BracketLeft' ? -1 : 1
        const newIndex = (currentIndex + delta + navSessions.length) % navSessions.length
        setSelectedSessionId(navSessions[newIndex].id)
        return
      }

      // New session: [mod]+N
      if (isShortcut && code === 'KeyN') {
        event.preventDefault()
        if (!isModalOpen) {
          setIsModalOpen(true)
        }
        return
      }

      // Kill session: [mod]+X
      if (isShortcut && code === 'KeyX') {
        event.preventDefault()
        if (selectedSessionId && !isModalOpen) {
          handleKillSession(selectedSessionId)
        }
        return
      }

      // Toggle task queue: [mod]+Shift+T
      if (isShortcut && event.shiftKey && code === 'KeyT') {
        event.preventDefault()
        setShowTaskQueue(!useTaskStore.getState().showTaskQueue)
        return
      }

      // Toggle history: [mod]+H
      if (isShortcut && code === 'KeyH') {
        event.preventDefault()
        setShowHistory(!useHistoryStore.getState().showHistory)
        return
      }

      // Toggle workflow list view: [mod]+Shift+W
      if (isShortcut && event.shiftKey && code === 'KeyW') {
        event.preventDefault()
        setActiveView((prev) => (prev === 'workflow-list' ? 'sessions' : 'workflow-list'))
        return
      }

      // Toggle workflow monitoring panel: [mod]+Shift+M
      if (isShortcut && event.shiftKey && code === 'KeyM') {
        event.preventDefault()
        setWorkflowPanelOpen((prev) => !prev)
        return
      }

      // Toggle cron manager: [mod]+Shift+C
      if (isShortcut && event.shiftKey && code === 'KeyC') {
        event.preventDefault()
        setActiveView((prev) => (prev === 'cron-manager' ? 'sessions' : 'cron-manager'))
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isModalOpen, selectedSessionId, setSelectedSessionId, filteredSortedSessions, handleKillSession, shortcutModifier, setShowTaskQueue, setShowHistory])

  const handleNewSession = () => setIsModalOpen(true)
  const handleOpenSettings = () => setIsSettingsOpen(true)

  const handleCreateSession = (
    projectPath: string,
    name?: string,
    command?: string,
    prompt?: string
  ) => {
    sendMessage({ type: 'session-create', projectPath, name, command, prompt })
    setLastProjectPath(projectPath)
  }

  const handleResumeSession = (sessionId: string) => {
    sendMessage({ type: 'session-resume', sessionId })
  }

  const handleRenameSession = (sessionId: string, newName: string) => {
    sendMessage({ type: 'session-rename', sessionId, newName })
  }

  const handleDuplicateSession = useCallback((sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId)
    if (session) {
      sendMessage({ type: 'session-create', projectPath: session.projectPath, command: session.command })
    }
  }, [sessions, sendMessage])

  const handleSetPinned = useCallback((sessionId: string, isPinned: boolean) => {
    sendMessage({ type: 'session-pin', sessionId, isPinned })
  }, [sendMessage])

  const handleWatchTask = useCallback((task: Task) => {
    if (task.tmuxWindow) {
      const session = sessions.find(s => s.tmuxWindow === task.tmuxWindow)
      if (session) {
        setSelectedSessionId(session.id)
      }
    }
  }, [sessions, setSelectedSessionId])

  // Cross-navigation helpers: workflow <-> session <-> task
  const navigateToSession = useCallback((sessionName: string) => {
    const session = sessions.find(s => s.name === sessionName)
    if (session) {
      setActiveView('sessions')
      setSelectedSessionId(session.id)
    }
  }, [sessions, setSelectedSessionId])

  const navigateToWorkflowRun = useCallback((workflowId: string) => {
    setActiveWorkflowId(workflowId)
    setActiveView('workflow-detail')
  }, [])

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Tab title attention badge for permission sessions
  useEffect(() => {
    const permissionCount = sessions.filter(s => s.status === 'permission').length
    document.title = permissionCount > 0 ? `(${permissionCount}) Agentboard` : 'Agentboard'
  }, [sessions])

  // Load recent history on mount
  useEffect(() => {
    void loadRecentHistory()
  }, [loadRecentHistory])

  // Fetch server info (including Tailscale IP) on mount
  useEffect(() => {
    authFetch('/api/server-info')
      .then((res) => res.json())
      .then((info: ServerInfo) => setServerInfo(info))
      .catch((err) => { console.warn('Failed to fetch server info:', err) })
  }, [])

  // Fetch pool status on mount
  useEffect(() => {
    void fetchPoolStatus()
  }, [fetchPoolStatus])

  // Calculate permission sessions for banner
  const permissionSessions = useMemo(() => {
    return sessions.filter(s => s.status === 'permission' && !dismissedPermissionBanners.has(s.id))
  }, [sessions, dismissedPermissionBanners])

  const handleDismissBanner = useCallback((sessionId: string) => {
    setDismissedPermissionBanners(prev => new Set(prev).add(sessionId))
  }, [])

  // Clear dismissed banners when session status changes away from permission
  useEffect(() => {
    const permissionIds = new Set(sessions.filter(s => s.status === 'permission').map(s => s.id))
    setDismissedPermissionBanners(prev => {
      const next = new Set<string>()
      for (const id of prev) {
        if (permissionIds.has(id)) next.add(id)
      }
      return next
    })
  }, [sessions])

  const pendingReviewItems = useMemo(() => {
    const items: PendingReviewItem[] = []
    for (const run of workflowRuns) {
      if (!run.steps_state) continue
      for (const step of run.steps_state) {
        if (step.status === 'paused_amendment' || step.status === 'paused_human' || step.status === 'paused_escalated') {
          const itemType: PendingReviewType =
            step.status === 'paused_amendment' ? 'amendment_approval' :
            step.status === 'paused_escalated' ? 'escalated_review_loop' :
            'concern_verdict'

          items.push({
            id: `${run.id}-${step.name}`,
            runId: run.id,
            pipelineName: run.workflow_name,
            itemType,
            stepName: step.name,
            tier: step.tier_min || run.tier || 1,
            waitingSince: step.startedAt || run.started_at || new Date().toISOString(),
            details: {
              status: step.status,
              errorMessage: step.errorMessage,
              amendmentType: step.amendmentType,
              reviewIteration: step.reviewIteration
            },
            severity: step.status === 'paused_escalated' ? 'high' :
                     step.status === 'paused_amendment' ? 'medium' : 'low'
          })
        }
      }
    }
    return items
  }, [workflowRuns])

  const handleResolveReview = useCallback((itemId: string, action: string) => {
    const [runId, ...stepParts] = itemId.split('-')
    const stepName = stepParts.join('-')
    sendMessage({ type: 'workflow-step-action', runId, stepName, action })
  }, [sendMessage])

  return (
    <ErrorBoundary>
      <div className="flex h-full overflow-hidden flex-col">
      {/* Permission attention banner - shown when any session needs permission */}
      {permissionSessions.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 bg-[var(--warning)] text-black border-b border-black/10 shrink-0">
          <span className="font-medium">⚠ Permission Required:</span>
          <div className="flex gap-2 flex-wrap flex-1">
            {permissionSessions.map(session => (
              <button
                key={session.id}
                onClick={() => setSelectedSessionId(session.id)}
                className="px-2 py-1 bg-black/10 hover:bg-black/20 rounded text-sm font-medium transition-colors"
              >
                {session.name}
              </button>
            ))}
          </div>
          <button
            onClick={() => handleDismissBanner(permissionSessions[0].id)}
            className="px-2 py-1 hover:bg-black/10 rounded text-sm transition-colors"
            aria-label="Dismiss banner"
          >
            ✕
          </button>
        </div>
      )}

      {/* Main content wrapper */}
      <div className="flex h-full overflow-hidden flex-1">
      {/* Left column: header + sidebar - always hidden on mobile (drawer handles it) */}
      <div
        className="hidden h-full flex-col md:flex md:shrink-0"
        style={{ width: sidebarWidth }}
      >
        <Header
          connectionStatus={connectionStatus}
          onNewSession={handleNewSession}
          onOpenSettings={handleOpenSettings}
          onToggleTaskQueue={() => setShowTaskQueue(!showTaskQueue)}
          taskQueueActive={showTaskQueue}
          taskQueueCount={taskStats.queued + taskStats.running}
          tailscaleIp={serverInfo?.tailscaleIp ?? null}
          onToggleHistory={() => setShowHistory(!showHistory)}
          historyActive={showHistory}
          onToggleWorkflows={() => setActiveView((prev) => (prev === 'workflow-list' ? 'sessions' : 'workflow-list'))}
          workflowsActive={activeView !== 'sessions'}
          onToggleWorkflowPanel={() => setWorkflowPanelOpen((prev) => !prev)}
          workflowPanelActive={workflowPanelOpen}
          onToggleCronManager={() => setActiveView((prev) => (prev === 'cron-manager' ? 'sessions' : 'cron-manager'))}
          cronManagerActive={activeView === 'cron-manager'}
        />
        <PoolStatusIndicator poolStatus={poolStatus} />
        <SessionList
          sessions={sessions}
          inactiveSessions={agentSessions.inactive}
          selectedSessionId={selectedSessionId}
          onSelect={setSelectedSessionId}
          onRename={handleRenameSession}
          onResume={handleResumeSession}
          onKill={handleKillSession}
          onDuplicate={handleDuplicateSession}
          onSetPinned={handleSetPinned}
          loading={!hasLoaded}
          error={connectionError || serverError}
          onNavigateToWorkflow={navigateToWorkflowRun}
        />
        {showHistory && (
          <div className="border-t border-border shrink-0" style={{ maxHeight: '40%', overflow: 'auto' }}>
            <HistorySection onResumed={() => sendMessage({ type: 'session-refresh' })} />
          </div>
        )}
      </div>

      {/* Sidebar resize handle */}
      <div
        className="hidden md:block w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-white/10 active:bg-white/20"
        onMouseDown={handleResizeStart}
      />

      {/* Main content area - view routing */}
      {activeView === 'sessions' && (
        <Terminal
          session={selectedSession}
          sessions={filteredSortedSessions}
          connectionStatus={connectionStatus}
          sendMessage={sendMessage}
          subscribe={subscribe}
          onClose={() => setSelectedSessionId(null)}
          onSelectSession={setSelectedSessionId}
          onNewSession={handleNewSession}
          onKillSession={handleKillSession}
          onRenameSession={handleRenameSession}
          onOpenSettings={handleOpenSettings}
          onResumeSession={handleResumeSession}
          onSetPinned={handleSetPinned}
          inactiveSessions={agentSessions.inactive}
          loading={!hasLoaded}
          error={connectionError || serverError}
        />
      )}
      {activeView === 'workflow-list' && (
        <div className="flex-1 overflow-y-auto p-6 bg-[var(--bg-primary)]">
          <ErrorBoundary>
            <WorkflowList
              onSelectWorkflow={(id) => { setActiveWorkflowId(id); setActiveView('workflow-detail') }}
              onCreateNew={() => { setActiveWorkflowId(null); setActiveView('workflow-editor') }}
            />
          </ErrorBoundary>
        </div>
      )}
      {activeView === 'workflow-detail' && activeWorkflowId && (
        <div className="flex-1 overflow-y-auto p-6 bg-[var(--bg-primary)]">
          <ErrorBoundary>
            <WorkflowDetail
              workflowId={activeWorkflowId}
              onBack={() => setActiveView('workflow-list')}
              onEdit={(id) => { setActiveWorkflowId(id); setActiveView('workflow-editor') }}
              onNavigateToSession={navigateToSession}
            />
          </ErrorBoundary>
        </div>
      )}
      {activeView === 'workflow-editor' && (
        <div className="flex-1 overflow-y-auto p-6 bg-[var(--bg-primary)]">
          <ErrorBoundary>
            <WorkflowEditor
              workflowId={activeWorkflowId ?? undefined}
              onSave={() => setActiveView('workflow-list')}
              onCancel={() => setActiveView(activeWorkflowId ? 'workflow-detail' : 'workflow-list')}
            />
          </ErrorBoundary>
        </div>
      )}
      {activeView === 'pending-reviews' && (
        <div className="flex-1 overflow-y-auto p-6 bg-[var(--bg-primary)]">
          <ErrorBoundary>
            <PendingReviewDashboard items={pendingReviewItems} onResolve={handleResolveReview} />
          </ErrorBoundary>
        </div>
      )}
      {activeView === 'cron-manager' && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <ErrorBoundary>
            <CronManager sendMessage={sendMessage} onNavigateToSession={navigateToSession} />
          </ErrorBoundary>
        </div>
      )}

      {/* Task queue panel - toggleable right sidebar */}
      {showTaskQueue && (
        <div className="hidden md:flex md:flex-col md:shrink-0 w-80 border-l border-white/10 bg-[var(--bg-primary)]">
          <TaskQueue
            sendMessage={sendMessage}
            defaultProjectPath={lastProjectPath || defaultProjectDir}
            onWatchTask={handleWatchTask}
            onNavigateToWorkflow={navigateToWorkflowRun}
          />
        </div>
      )}
      </div>

      {/* Workflow monitoring panel - fixed overlay */}
      <ErrorBoundary>
        <WorkflowPanel
          isOpen={workflowPanelOpen}
          onClose={() => setWorkflowPanelOpen(false)}
        />
      </ErrorBoundary>

      <NewSessionModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onCreate={handleCreateSession}
        defaultProjectDir={defaultProjectDir}
        commandPresets={commandPresets}
        defaultPresetId={defaultPresetId}
        onUpdateModifiers={updatePresetModifiers}
        lastProjectPath={lastProjectPath}
        activeProjectPath={selectedSession?.projectPath}
        projectPathPresets={projectPathPresets}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />

      <ToastViewport />
      </div>
    </ErrorBoundary>
  )
}
