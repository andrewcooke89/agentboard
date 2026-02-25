import { useState } from 'react'
import type { ConnectionStatus } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useAuthStore } from '../stores/authStore'
import { PlusIcon } from '@untitledui-icons/react/line'
import Copy01Icon from '@untitledui-icons/react/line/esm/Copy01Icon'
import Settings02Icon from '@untitledui-icons/react/line/esm/Settings02Icon'
import LogOut01Icon from '@untitledui-icons/react/line/esm/LogOut01Icon'
import LayersThree01Icon from '@untitledui-icons/react/line/esm/LayersThree01Icon'
import { getEffectiveModifier, getModifierDisplay } from '../utils/device'

interface HeaderProps {
  connectionStatus: ConnectionStatus
  onNewSession: () => void
  onOpenSettings: () => void
  onToggleTaskQueue: () => void
  taskQueueActive: boolean
  taskQueueCount: number
  tailscaleIp: string | null
  onToggleHistory?: () => void
  historyActive?: boolean
  onToggleWorkflows?: () => void
  workflowsActive?: boolean
  onToggleWorkflowPanel?: () => void
  workflowPanelActive?: boolean
  onToggleCronManager?: () => void
  cronManagerActive?: boolean
}

const statusDot: Record<ConnectionStatus, string> = {
  connected: 'bg-working',
  connecting: 'bg-approval',
  reconnecting: 'bg-approval',
  disconnected: 'bg-danger',
  error: 'bg-danger',
}

export default function Header({
  connectionStatus,
  onNewSession,
  onOpenSettings,
  onToggleTaskQueue,
  taskQueueActive,
  taskQueueCount,
  tailscaleIp,
  onToggleHistory,
  historyActive,
  onToggleWorkflows,
  workflowsActive,
  onToggleWorkflowPanel,
  workflowPanelActive,
  onToggleCronManager,
  cronManagerActive,
}: HeaderProps) {
  const [copied, setCopied] = useState(false)
  const shortcutModifier = useSettingsStore((state) => state.shortcutModifier)
  const modDisplay = getModifierDisplay(getEffectiveModifier(shortcutModifier))
  const authRequired = useAuthStore((state) => state.authRequired)
  const logout = useAuthStore((state) => state.logout)

  const handleCopyTailscaleUrl = () => {
    if (!tailscaleIp) return
    const url = `http://${tailscaleIp}:${window.location.port || '4040'}`
    navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <header className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-elevated px-3">
      <div className="flex items-center gap-2">
        <h1 className="text-sm font-semibold tracking-tight text-primary text-balance">
          AGENTBOARD
        </h1>
        <div className="flex items-center gap-1.5 text-xs text-muted">
          <span className={`h-2 w-2 rounded-full ${statusDot[connectionStatus]}`} />
          {tailscaleIp && (
            <button
              onClick={handleCopyTailscaleUrl}
              className="ml-3 inline-flex items-center gap-1 text-muted/70 hover:text-muted transition-colors cursor-pointer"
              title="Tailscale IP - click to copy remote access URL"
            >
              <span className="leading-none translate-y-[1px]">{copied ? 'Copied!' : tailscaleIp}</span>
              {!copied && <Copy01Icon width={12} height={12} className="shrink-0" />}
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        {onToggleHistory && (
          <button
            onClick={onToggleHistory}
            className={`flex h-7 w-7 items-center justify-center rounded border transition-all active:scale-95 ${
              historyActive
                ? 'border-accent/50 bg-accent/10 text-accent'
                : 'border-border text-secondary hover:bg-hover hover:text-primary'
            }`}
            title="Chat History"
            aria-label="Toggle chat history"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12,6 12,12 16,14" />
            </svg>
          </button>
        )}
        {onToggleWorkflows && (
          <button
            onClick={onToggleWorkflows}
            className={`flex h-7 items-center gap-1 px-1.5 rounded border transition-all active:scale-95 ${
              workflowsActive
                ? 'border-accent/50 bg-accent/10 text-accent'
                : 'border-border text-secondary hover:bg-hover hover:text-primary'
            }`}
            title={`Workflows (${modDisplay}${'\u21E7'}W)`}
            aria-label="Toggle workflows view"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 17.5a3.5 3.5 0 1 0 7 0 3.5 3.5 0 0 0-7 0" />
            </svg>
          </button>
        )}
        {onToggleCronManager && (
          <button
            onClick={onToggleCronManager}
            className={`flex h-7 items-center gap-1 px-1.5 rounded border transition-all active:scale-95 ${
              cronManagerActive
                ? 'border-accent/50 bg-accent/10 text-accent'
                : 'border-border text-secondary hover:bg-hover hover:text-primary'
            }`}
            title={`Cron Manager (${modDisplay}\u21E7C)`}
            aria-label="Toggle cron manager view"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12,6 12,12 16,14" />
            </svg>
          </button>
        )}
        {onToggleWorkflowPanel && (
          <button
            onClick={onToggleWorkflowPanel}
            className={`flex h-7 w-7 items-center justify-center rounded border transition-all active:scale-95 ${
              workflowPanelActive
                ? 'border-accent/50 bg-accent/10 text-accent'
                : 'border-border text-secondary hover:bg-hover hover:text-primary'
            }`}
            title={`Workflow Monitor (${modDisplay}${'\u21E7'}M)`}
            aria-label="Toggle workflow monitoring panel"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
            </svg>
          </button>
        )}
        <button
          onClick={onToggleTaskQueue}
          className={`relative flex h-7 items-center gap-1 px-1.5 rounded border transition-all active:scale-95 ${
            taskQueueActive
              ? 'border-accent/50 bg-accent/10 text-accent'
              : 'border-border text-secondary hover:bg-hover hover:text-primary'
          }`}
          title={`Task Queue (${modDisplay}${'\u21E7'}T)`}
          aria-label="Toggle task queue"
        >
          <LayersThree01Icon width={14} height={14} />
          {taskQueueCount > 0 && (
            <span className="text-[10px] font-medium leading-none">{taskQueueCount}</span>
          )}
        </button>
        <button
          onClick={onNewSession}
          className="flex h-7 w-7 items-center justify-center rounded bg-accent text-white hover:bg-accent/90 active:scale-95 transition-all"
          title={`New session (${modDisplay}N)`}
          aria-label="New session"
        >
          <PlusIcon width={16} height={16} />
        </button>
        <button
          onClick={onOpenSettings}
          className="flex h-7 w-7 items-center justify-center rounded border border-border text-secondary hover:bg-hover hover:text-primary active:scale-95 transition-all"
          title="Settings"
          aria-label="Settings"
        >
          <Settings02Icon width={14} height={14} />
        </button>
        {authRequired && (
          <button
            onClick={logout}
            className="flex h-7 w-7 items-center justify-center rounded border border-border text-secondary hover:bg-hover hover:text-danger active:scale-95 transition-all"
            title="Logout"
            aria-label="Logout"
          >
            <LogOut01Icon width={14} height={14} />
          </button>
        )}
      </div>
    </header>
  )
}
