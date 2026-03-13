/**
 * CronAiTerminal.tsx — xterm.js terminal for the AI drawer (WU-010)
 *
 * Connects to the agentboard-cron-ai tmux window via the useTerminal hook.
 * Attaches on mount (drawer open), detaches on unmount (drawer close).
 */
import { useTerminal } from '../hooks/useTerminal'
import { useThemeStore, terminalThemes } from '../../stores/themeStore'
import { useSettingsStore, getFontFamily } from '../../stores/settingsStore'
import type { SendClientMessage, SubscribeServerMessage } from '../../../shared/types'

interface CronAiTerminalProps {
  sessionId: string | null
  tmuxTarget: string | null
  sendMessage: SendClientMessage
  subscribe: SubscribeServerMessage
}

export function CronAiTerminal({ sessionId, tmuxTarget, sendMessage, subscribe }: CronAiTerminalProps) {
  const theme = useThemeStore((s) => s.theme)
  const terminalTheme = terminalThemes[theme]
  const fontSize = useSettingsStore((s) => s.fontSize)
  const lineHeight = useSettingsStore((s) => s.lineHeight)
  const letterSpacing = useSettingsStore((s) => s.letterSpacing)
  const fontOption = useSettingsStore((s) => s.fontOption)
  const customFontFamily = useSettingsStore((s) => s.customFontFamily)
  const useWebGL = useSettingsStore((s) => s.useWebGL)
  const fontFamily = getFontFamily(fontOption, customFontFamily)

  const { containerRef } = useTerminal({
    sessionId,
    tmuxTarget,
    sendMessage,
    subscribe,
    theme: terminalTheme,
    fontSize,
    lineHeight,
    letterSpacing,
    fontFamily,
    useWebGL,
  })

  return (
    <div className="relative h-full w-full overflow-hidden" data-testid="cron-ai-terminal">
      {!sessionId && (
        <div className="absolute inset-0 flex items-center justify-center text-zinc-500 z-10">
          Waiting for AI session to start...
        </div>
      )}
      <div ref={containerRef} className={`absolute inset-0 ${sessionId ? '' : 'invisible'}`} />
    </div>
  )
}

export default CronAiTerminal
