// WU-009: App Integration & CronManager Shell

import { useState, useCallback, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useCronStore } from '../../stores/cronStore'
import { useWebSocket } from '../../hooks/useWebSocket'
import { CronJobList } from './CronJobList'
import { CronJobDetail } from './CronJobDetail'
import { CronEmptyState } from './CronEmptyState'
import { CronTimeline } from './CronTimeline'
import { CronSudoPrompt } from './CronSudoPrompt'
import { CronCreateModal } from './CronCreateModal'
import type { CronCreateConfig, SystemdCreateConfig } from '@shared/types'

export function CronManager() {
  const selectedJobId = useCronStore((s) => s.selectedJobId)
  const timelineVisible = useCronStore((s) => s.timelineVisible)
  const toggleTimeline = useCronStore((s) => s.toggleTimeline)
  const sudoPromptVisible = useCronStore((s) => s.sudoPromptVisible)
  const sudoPromptOperation = useCronStore((s) => s.sudoPromptOperation)
  const hideSudoPrompt = useCronStore((s) => s.hideSudoPrompt)
  const [listWidth, setListWidth] = useState(320)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const dragging = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const { sendMessage } = useWebSocket()

  // Expose sendMessage on window so child components (CronJobControls,
  // CronJobDetail, CronTagInput, CronSessionLink, CronHistoryTab) can send
  // WS messages without prop drilling.
  useEffect(() => {
    ;(window as unknown as Record<string, unknown>).__cronWsSend = sendMessage
    return () => {
      delete (window as unknown as Record<string, unknown>).__cronWsSend
    }
  }, [sendMessage])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
  }, [])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const newWidth = Math.min(Math.max(e.clientX - rect.left, 180), 500)
      setListWidth(newWidth)
    }
    const onMouseUp = () => {
      dragging.current = false
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  const handleSudoSubmit = useCallback((credential: string) => {
    sendMessage({ type: 'cron-sudo-auth', sudoCredential: credential })
    hideSudoPrompt()
  }, [sendMessage, hideSudoPrompt])

  const handleCreateJob = useCallback((mode: 'cron' | 'systemd', config: CronCreateConfig | SystemdCreateConfig) => {
    sendMessage({ type: 'cron-job-create', mode, config })
  }, [sendMessage])

  const handleOpenCreateModal = useCallback(() => {
    setShowCreateModal(true)
  }, [])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header bar with Timeline toggle and Create button */}
      <div className="flex items-center justify-end px-3 py-1.5 border-b border-[var(--border)] bg-[var(--bg-elevated)] shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={handleOpenCreateModal}
            className="text-xs px-2 py-0.5 rounded bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            + Create
          </button>
          <button
            onClick={toggleTimeline}
            className={`text-xs px-2 py-0.5 rounded ${
              timelineVisible
                ? 'bg-blue-600 text-white'
                : 'bg-[var(--bg-surface)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
            }`}
          >
            Timeline
          </button>
        </div>
      </div>

      {/* Timeline (collapsible) */}
      {timelineVisible && <CronTimeline />}

      {/* Split pane */}
      <div ref={containerRef} className="flex flex-1 overflow-hidden">
        <div
          style={{ width: listWidth, minWidth: 180, maxWidth: 500 }}
          className="flex-shrink-0 border-r border-[var(--border)] overflow-hidden"
        >
          <CronJobList />
        </div>
        <div
          onMouseDown={onMouseDown}
          className="w-1 cursor-col-resize bg-[var(--border)] hover:bg-blue-500 flex-shrink-0"
        />
        <div className="flex-1 overflow-hidden">
          <AnimatePresence mode="wait">
            {selectedJobId ? (
              <motion.div
                key="detail"
                className="h-full"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                <CronJobDetail />
              </motion.div>
            ) : (
              <motion.div
                key="empty"
                className="h-full"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                <CronEmptyState onCreateJob={handleOpenCreateModal} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Sudo prompt modal */}
      <CronSudoPrompt
        isOpen={sudoPromptVisible}
        operation={sudoPromptOperation ?? undefined}
        onSubmit={handleSudoSubmit}
        onCancel={hideSudoPrompt}
      />

      {/* Create job modal */}
      <CronCreateModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onCreate={handleCreateJob}
      />
    </div>
  )
}

export default CronManager
