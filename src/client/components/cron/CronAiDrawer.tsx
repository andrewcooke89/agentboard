// WU-009/013: CronAi Drawer Shell
// Slide-in overlay drawer from right edge with animation.
// Contains CronAiHeader, terminal area (children), CronAiStatusBar.
// Resizable 360-640px via left-edge drag handle.

import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useCronAiStore, DRAWER_MAX_WIDTH } from '../../stores/cronAiStore'
import { useCronStore } from '../../stores/cronStore'
import { CronAiHeader } from './CronAiHeader'
import { CronAiStatusBar } from './CronAiStatusBar'
import type { SendClientMessage, SubscribeServerMessage } from '@shared/types'

interface CronAiDrawerProps {
  sendMessage: SendClientMessage
  subscribe: SubscribeServerMessage
  children?: ReactNode
}

/**
 * Slide-in overlay drawer for the AI assistant.
 * - Right-edge overlay, does NOT reflow main content
 * - AnimatePresence for enter/exit animation
 * - Resizable via left-edge drag handle (360-640px)
 * - Escape key closes
 * - On mount: sends cron-ai-drawer-open WS message (WU-013)
 * - On New Conversation: sends cron-ai-new-conversation WS message (WU-013)
 */
export function CronAiDrawer({ sendMessage, subscribe: _subscribe, children }: CronAiDrawerProps) {
  const drawerOpen = useCronAiStore((s) => s.drawerOpen)
  const drawerWidth = useCronAiStore((s) => s.drawerWidth)
  const sessionStatus = useCronAiStore((s) => s.sessionStatus)
  const mcpConnected = useCronAiStore((s) => s.mcpConnected)
  const pendingProposalCount = useCronAiStore((s) => s.pendingProposalCount)
  const toggleDrawer = useCronAiStore((s) => s.toggleDrawer)
  const setDrawerWidth = useCronAiStore((s) => s.setDrawerWidth)

  const selectedJobId = useCronStore((s) => s.selectedJobId)
  const jobs = useCronStore((s) => s.jobs)
  const selectedJobName = jobs.find((j) => j.id === selectedJobId)?.name ?? null

  const drawerRef = useRef<HTMLDivElement>(null)
  const resizing = useRef(false)

  // ── Escape to close ────────────────────────────────────────────────────
  useEffect(() => {
    if (!drawerOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        toggleDrawer()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [drawerOpen, toggleDrawer])

  // ── WU-013: Send drawer-open on mount ──────────────────────────────────
  useEffect(() => {
    if (drawerOpen) {
      sendMessage({ type: 'cron-ai-drawer-open' })
    }
  }, [drawerOpen, sendMessage])

  // ── Resize drag handler ────────────────────────────────────────────────
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    resizing.current = true
    const startX = e.clientX
    const startWidth = useCronAiStore.getState().drawerWidth

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizing.current) return
      // Dragging left increases width (drawer is on the right edge)
      const delta = startX - ev.clientX
      setDrawerWidth(startWidth + delta)
    }

    const onMouseUp = () => {
      resizing.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [setDrawerWidth])

  // ── New Conversation handler (WU-013) ──────────────────────────────────
  const handleNewConversation = useCallback(() => {
    if (window.confirm('Start a new conversation? The current conversation will be lost.')) {
      sendMessage({ type: 'cron-ai-new-conversation' })
    }
  }, [sendMessage])

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <AnimatePresence>
      {drawerOpen && (
        <motion.div
          ref={drawerRef}
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="fixed top-0 right-0 h-full z-50 bg-zinc-900 border-l border-zinc-700 flex flex-col"
          style={{ width: drawerWidth, pointerEvents: 'auto' }}
        >
          {/* Resize handle */}
          <div
            className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-500/50 transition-colors"
            onMouseDown={handleResizeStart}
          />

          {/* Header */}
          <CronAiHeader
            sessionStatus={sessionStatus}
            onNewConversation={handleNewConversation}
            onClose={toggleDrawer}
          />

          {/* Terminal area (children slot) */}
          <div className="flex-1 overflow-hidden">
            {children}
          </div>

          {/* Status bar */}
          <CronAiStatusBar
            mcpConnected={mcpConnected}
            selectedJobName={selectedJobName}
            pendingCount={pendingProposalCount}
          />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default CronAiDrawer
