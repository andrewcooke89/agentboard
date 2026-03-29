import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_PROJECT_DIR,
  MAX_PRESETS,
  useSettingsStore,
  type CommandPreset,
  type FontOption,
  type SessionSortDirection,
  type SessionSortMode,
  type ShortcutModifier,
} from '../stores/settingsStore'
import { useThemeStore, type Theme } from '../stores/themeStore'
import { getEffectiveModifier, getModifierDisplay } from '../utils/device'
import CronSettingsSection from './settings/CronSettingsSection'
import NotificationSettingsSection from './settings/NotificationSettingsSection'
import TerminalSettingsSection from './settings/TerminalSettingsSection'
import CommandPresetsSection from './settings/CommandPresetsSection'
import SessionListSettingsSection from './settings/SessionListSettingsSection'
import GeneralSettingsSection from './settings/GeneralSettingsSection'

interface SettingsChangeFlags {
  webglChanged: boolean
}

interface SettingsModalProps {
  isOpen: boolean
  onClose: (flags?: SettingsChangeFlags) => void
}

export default function SettingsModal({
  isOpen,
  onClose,
}: SettingsModalProps) {
  const defaultProjectDir = useSettingsStore((state) => state.defaultProjectDir)
  const setDefaultProjectDir = useSettingsStore(
    (state) => state.setDefaultProjectDir
  )
  const commandPresets = useSettingsStore((state) => state.commandPresets)
  const setCommandPresets = useSettingsStore((state) => state.setCommandPresets)
  const defaultPresetId = useSettingsStore((state) => state.defaultPresetId)
  const setDefaultPresetId = useSettingsStore((state) => state.setDefaultPresetId)
  const sessionSortMode = useSettingsStore((state) => state.sessionSortMode)
  const setSessionSortMode = useSettingsStore(
    (state) => state.setSessionSortMode
  )
  const sessionSortDirection = useSettingsStore(
    (state) => state.sessionSortDirection
  )
  const setSessionSortDirection = useSettingsStore(
    (state) => state.setSessionSortDirection
  )
  const useWebGL = useSettingsStore((state) => state.useWebGL)
  const setUseWebGL = useSettingsStore((state) => state.setUseWebGL)
  const fontSize = useSettingsStore((state) => state.fontSize)
  const setFontSize = useSettingsStore((state) => state.setFontSize)
  const lineHeight = useSettingsStore((state) => state.lineHeight)
  const setLineHeight = useSettingsStore((state) => state.setLineHeight)
  const letterSpacing = useSettingsStore((state) => state.letterSpacing)
  const setLetterSpacing = useSettingsStore((state) => state.setLetterSpacing)
  const fontOption = useSettingsStore((state) => state.fontOption)
  const setFontOption = useSettingsStore((state) => state.setFontOption)
  const customFontFamily = useSettingsStore((state) => state.customFontFamily)
  const setCustomFontFamily = useSettingsStore((state) => state.setCustomFontFamily)
  const shortcutModifier = useSettingsStore((state) => state.shortcutModifier)
  const setShortcutModifier = useSettingsStore(
    (state) => state.setShortcutModifier
  )
  const showProjectName = useSettingsStore((state) => state.showProjectName)
  const setShowProjectName = useSettingsStore(
    (state) => state.setShowProjectName
  )
  const showLastUserMessage = useSettingsStore(
    (state) => state.showLastUserMessage
  )
  const setShowLastUserMessage = useSettingsStore(
    (state) => state.setShowLastUserMessage
  )
  const showSessionIdPrefix = useSettingsStore(
    (state) => state.showSessionIdPrefix
  )
  const setShowSessionIdPrefix = useSettingsStore(
    (state) => state.setShowSessionIdPrefix
  )
  const theme = useThemeStore((state) => state.theme)
  const setTheme = useThemeStore((state) => state.setTheme)
  const soundOnPermission = useSettingsStore((state) => state.soundOnPermission)
  const setSoundOnPermission = useSettingsStore((state) => state.setSoundOnPermission)
  const soundOnIdle = useSettingsStore((state) => state.soundOnIdle)
  const setSoundOnIdle = useSettingsStore((state) => state.setSoundOnIdle)
  const projectPathPresets = useSettingsStore((state) => state.projectPathPresets)
  const addProjectPathPreset = useSettingsStore((state) => state.addProjectPathPreset)
  const removeProjectPathPreset = useSettingsStore((state) => state.removeProjectPathPreset)
  const notifyOnPermission = useSettingsStore((state) => state.notifyOnPermission)
  const setNotifyOnPermission = useSettingsStore((state) => state.setNotifyOnPermission)
  const notifyOnIdle = useSettingsStore((state) => state.notifyOnIdle)
  const setNotifyOnIdle = useSettingsStore((state) => state.setNotifyOnIdle)
  const sessionGroupMode = useSettingsStore((state) => state.sessionGroupMode)
  const setSessionGroupMode = useSettingsStore((state) => state.setSessionGroupMode)
  // Cron Manager settings
  const cronPollInterval = useSettingsStore((state) => state.cronPollInterval)
  const setCronPollInterval = useSettingsStore((state) => state.setCronPollInterval)
  const cronAvatarStyle = useSettingsStore((state) => state.cronAvatarStyle)
  const setCronAvatarStyle = useSettingsStore((state) => state.setCronAvatarStyle)
  const cronSudoGracePeriod = useSettingsStore((state) => state.cronSudoGracePeriod)
  const setCronSudoGracePeriod = useSettingsStore((state) => state.setCronSudoGracePeriod)
  const cronShowSystemJobs = useSettingsStore((state) => state.cronShowSystemJobs)
  const setCronShowSystemJobs = useSettingsStore((state) => state.setCronShowSystemJobs)
  const cronShowUserJobs = useSettingsStore((state) => state.cronShowUserJobs)
  const setCronShowUserJobs = useSettingsStore((state) => state.setCronShowUserJobs)
  const cronDefaultTimelineVisible = useSettingsStore((state) => state.cronDefaultTimelineVisible)
  const setCronDefaultTimelineVisible = useSettingsStore((state) => state.setCronDefaultTimelineVisible)
  const cronDefaultTimelineRange = useSettingsStore((state) => state.cronDefaultTimelineRange)
  const setCronDefaultTimelineRange = useSettingsStore((state) => state.setCronDefaultTimelineRange)
  const cronNotifyFailure = useSettingsStore((state) => state.cronNotifyFailure)
  const setCronNotifyFailure = useSettingsStore((state) => state.setCronNotifyFailure)
  const cronNotifyMissedRun = useSettingsStore((state) => state.cronNotifyMissedRun)
  const setCronNotifyMissedRun = useSettingsStore((state) => state.setCronNotifyMissedRun)
  const cronNotifyManualRun = useSettingsStore((state) => state.cronNotifyManualRun)
  const setCronNotifyManualRun = useSettingsStore((state) => state.setCronNotifyManualRun)
  const cronDesktopNotifications = useSettingsStore((state) => state.cronDesktopNotifications)
  const setCronDesktopNotifications = useSettingsStore((state) => state.setCronDesktopNotifications)
  const cronAutoTagSuggestions = useSettingsStore((state) => state.cronAutoTagSuggestions)
  const setCronAutoTagSuggestions = useSettingsStore((state) => state.setCronAutoTagSuggestions)
  const cronMaxHistoryDays = useSettingsStore((state) => state.cronMaxHistoryDays)
  const setCronMaxHistoryDays = useSettingsStore((state) => state.setCronMaxHistoryDays)
  const cronMaxHistoryPerJob = useSettingsStore((state) => state.cronMaxHistoryPerJob)
  const setCronMaxHistoryPerJob = useSettingsStore((state) => state.setCronMaxHistoryPerJob)

  const [draftDir, setDraftDir] = useState(defaultProjectDir)
  const [newPresetPath, setNewPresetPath] = useState('')
  const [draftPresets, setDraftPresets] = useState<CommandPreset[]>(commandPresets)
  const [draftDefaultPresetId, setDraftDefaultPresetId] = useState(defaultPresetId)
  const [draftSortMode, setDraftSortMode] =
    useState<SessionSortMode>(sessionSortMode)
  const [draftSortDirection, setDraftSortDirection] =
    useState<SessionSortDirection>(sessionSortDirection)
  const [draftUseWebGL, setDraftUseWebGL] = useState(useWebGL)
  const [draftFontSize, setDraftFontSize] = useState(fontSize)
  const [draftLineHeight, setDraftLineHeight] = useState(lineHeight)
  const [draftLetterSpacing, setDraftLetterSpacing] = useState(letterSpacing)
  const [draftFontOption, setDraftFontOption] = useState<FontOption>(fontOption)
  const [draftCustomFontFamily, setDraftCustomFontFamily] = useState(customFontFamily)
  const [draftShortcutModifier, setDraftShortcutModifier] = useState<
    ShortcutModifier | 'auto'
  >(shortcutModifier)
  const [draftShowProjectName, setDraftShowProjectName] =
    useState(showProjectName)
  const [draftShowLastUserMessage, setDraftShowLastUserMessage] = useState(
    showLastUserMessage
  )
  const [draftShowSessionIdPrefix, setDraftShowSessionIdPrefix] = useState(
    showSessionIdPrefix
  )
  const [draftTheme, setDraftTheme] = useState<Theme>(theme)
  const [draftSoundOnPermission, setDraftSoundOnPermission] = useState(soundOnPermission)
  const [draftSoundOnIdle, setDraftSoundOnIdle] = useState(soundOnIdle)
  const [draftNotifyOnPermission, setDraftNotifyOnPermission] = useState(notifyOnPermission)
  const [draftNotifyOnIdle, setDraftNotifyOnIdle] = useState(notifyOnIdle)
  const [draftSessionGroupMode, setDraftSessionGroupMode] = useState(sessionGroupMode)
  // Cron Manager draft state
  const [draftCronPollInterval, setDraftCronPollInterval] = useState(cronPollInterval)
  const [draftCronAvatarStyle, setDraftCronAvatarStyle] = useState(cronAvatarStyle)
  const [draftCronSudoGracePeriod, setDraftCronSudoGracePeriod] = useState(cronSudoGracePeriod)
  const [draftCronShowSystemJobs, setDraftCronShowSystemJobs] = useState(cronShowSystemJobs)
  const [draftCronShowUserJobs, setDraftCronShowUserJobs] = useState(cronShowUserJobs)
  const [draftCronDefaultTimelineVisible, setDraftCronDefaultTimelineVisible] = useState(cronDefaultTimelineVisible)
  const [draftCronDefaultTimelineRange, setDraftCronDefaultTimelineRange] = useState(cronDefaultTimelineRange)
  const [draftCronNotifyFailure, setDraftCronNotifyFailure] = useState(cronNotifyFailure)
  const [draftCronNotifyMissedRun, setDraftCronNotifyMissedRun] = useState(cronNotifyMissedRun)
  const [draftCronNotifyManualRun, setDraftCronNotifyManualRun] = useState(cronNotifyManualRun)
  const [draftCronDesktopNotifications, setDraftCronDesktopNotifications] = useState(cronDesktopNotifications)
  const [draftCronAutoTagSuggestions, setDraftCronAutoTagSuggestions] = useState(cronAutoTagSuggestions)
  const [draftCronMaxHistoryDays, setDraftCronMaxHistoryDays] = useState(cronMaxHistoryDays)
  const [draftCronMaxHistoryPerJob, setDraftCronMaxHistoryPerJob] = useState(cronMaxHistoryPerJob)

  // New preset form state
  const [showAddForm, setShowAddForm] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newBaseCommand, setNewBaseCommand] = useState('')
  const [newModifiers, setNewModifiers] = useState('')
  const [newAgentType, setNewAgentType] = useState<'claude' | 'codex' | ''>('')
  const reenableTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (reenableTimeoutRef.current) {
      clearTimeout(reenableTimeoutRef.current)
      reenableTimeoutRef.current = null
    }

    if (isOpen) {
      setDraftDir(defaultProjectDir)
      setDraftPresets(commandPresets)
      setDraftDefaultPresetId(defaultPresetId)
      setDraftSortMode(sessionSortMode)
      setDraftSortDirection(sessionSortDirection)
      setDraftUseWebGL(useWebGL)
      setDraftFontSize(fontSize)
      setDraftLineHeight(lineHeight)
      setDraftLetterSpacing(letterSpacing)
      setDraftFontOption(fontOption)
      setDraftCustomFontFamily(customFontFamily)
      setDraftShortcutModifier(shortcutModifier)
      setDraftShowProjectName(showProjectName)
      setDraftShowLastUserMessage(showLastUserMessage)
      setDraftShowSessionIdPrefix(showSessionIdPrefix)
      setDraftTheme(theme)
      setDraftSoundOnPermission(soundOnPermission)
      setDraftSoundOnIdle(soundOnIdle)
      setDraftNotifyOnPermission(notifyOnPermission)
      setDraftNotifyOnIdle(notifyOnIdle)
      setDraftSessionGroupMode(sessionGroupMode)
      setDraftCronPollInterval(cronPollInterval)
      setDraftCronAvatarStyle(cronAvatarStyle)
      setDraftCronSudoGracePeriod(cronSudoGracePeriod)
      setDraftCronShowSystemJobs(cronShowSystemJobs)
      setDraftCronShowUserJobs(cronShowUserJobs)
      setDraftCronDefaultTimelineVisible(cronDefaultTimelineVisible)
      setDraftCronDefaultTimelineRange(cronDefaultTimelineRange)
      setDraftCronNotifyFailure(cronNotifyFailure)
      setDraftCronNotifyMissedRun(cronNotifyMissedRun)
      setDraftCronNotifyManualRun(cronNotifyManualRun)
      setDraftCronDesktopNotifications(cronDesktopNotifications)
      setDraftCronAutoTagSuggestions(cronAutoTagSuggestions)
      setDraftCronMaxHistoryDays(cronMaxHistoryDays)
      setDraftCronMaxHistoryPerJob(cronMaxHistoryPerJob)
      setShowAddForm(false)
      setNewLabel('')
      setNewBaseCommand('')
      setNewModifiers('')
      setNewAgentType('')
      // Disable terminal textarea when modal opens to prevent keyboard capture
      if (typeof document !== 'undefined') {
        const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
        if (textarea && typeof textarea.setAttribute === 'function') {
          if (typeof textarea.blur === 'function') textarea.blur()
          textarea.setAttribute('disabled', 'true')
        }
      }
    } else {
      // Re-enable terminal textarea when modal closes
      if (typeof document !== 'undefined') {
        reenableTimeoutRef.current = setTimeout(() => {
          if (typeof document === 'undefined') {
            return
          }
          const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
          if (textarea) {
            textarea.removeAttribute('disabled')
            textarea.focus()
          }
        }, 300)
      }
    }
    return () => {
      if (reenableTimeoutRef.current) {
        clearTimeout(reenableTimeoutRef.current)
        reenableTimeoutRef.current = null
      }
    }
  }, [
    commandPresets,
    defaultPresetId,
    defaultProjectDir,
    sessionSortMode,
    sessionSortDirection,
    useWebGL,
    fontSize,
    lineHeight,
    letterSpacing,
    fontOption,
    customFontFamily,
    shortcutModifier,
    showProjectName,
    showLastUserMessage,
    showSessionIdPrefix,
    theme,
    soundOnPermission,
    soundOnIdle,
    notifyOnPermission,
    notifyOnIdle,
    sessionGroupMode,
    cronPollInterval,
    cronAvatarStyle,
    cronSudoGracePeriod,
    cronShowSystemJobs,
    cronShowUserJobs,
    cronDefaultTimelineVisible,
    cronDefaultTimelineRange,
    cronNotifyFailure,
    cronNotifyMissedRun,
    cronNotifyManualRun,
    cronDesktopNotifications,
    cronAutoTagSuggestions,
    cronMaxHistoryDays,
    cronMaxHistoryPerJob,
    isOpen,
  ])

  // Handle Escape key to close modal
  useEffect(() => {
    if (!isOpen) return
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) {
    return null
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const trimmedDir = draftDir.trim()
    const webglChanged = draftUseWebGL !== useWebGL
    setDefaultProjectDir(trimmedDir || DEFAULT_PROJECT_DIR)
    setCommandPresets(draftPresets)
    setDefaultPresetId(draftDefaultPresetId)
    setSessionSortMode(draftSortMode)
    setSessionSortDirection(draftSortDirection)
    setUseWebGL(draftUseWebGL)
    setFontSize(draftFontSize)
    setLineHeight(draftLineHeight)
    setLetterSpacing(draftLetterSpacing)
    setFontOption(draftFontOption)
    setCustomFontFamily(draftCustomFontFamily)
    setShortcutModifier(draftShortcutModifier)
    setShowProjectName(draftShowProjectName)
    setShowLastUserMessage(draftShowLastUserMessage)
    setShowSessionIdPrefix(draftShowSessionIdPrefix)
    setTheme(draftTheme)
    setSoundOnPermission(draftSoundOnPermission)
    setSoundOnIdle(draftSoundOnIdle)
    setNotifyOnPermission(draftNotifyOnPermission)
    setNotifyOnIdle(draftNotifyOnIdle)
    setSessionGroupMode(draftSessionGroupMode)
    setCronPollInterval(draftCronPollInterval)
    setCronAvatarStyle(draftCronAvatarStyle)
    setCronSudoGracePeriod(draftCronSudoGracePeriod)
    setCronShowSystemJobs(draftCronShowSystemJobs)
    setCronShowUserJobs(draftCronShowUserJobs)
    setCronDefaultTimelineVisible(draftCronDefaultTimelineVisible)
    setCronDefaultTimelineRange(draftCronDefaultTimelineRange)
    setCronNotifyFailure(draftCronNotifyFailure)
    setCronNotifyMissedRun(draftCronNotifyMissedRun)
    setCronNotifyManualRun(draftCronNotifyManualRun)
    setCronDesktopNotifications(draftCronDesktopNotifications)
    setCronAutoTagSuggestions(draftCronAutoTagSuggestions)
    setCronMaxHistoryDays(draftCronMaxHistoryDays)
    setCronMaxHistoryPerJob(draftCronMaxHistoryPerJob)
    onClose({ webglChanged })
  }

  const handleUpdatePreset = (presetId: string, updates: Partial<CommandPreset>) => {
    setDraftPresets(presets =>
      presets.map(p => p.id === presetId ? { ...p, ...updates } : p)
    )
  }

  const handleDeletePreset = (presetId: string) => {
    const preset = draftPresets.find(p => p.id === presetId)
    if (!preset || preset.isBuiltIn) return

    const filtered = draftPresets.filter(p => p.id !== presetId)
    setDraftPresets(filtered)

    // Update default if deleted preset was default
    if (presetId === draftDefaultPresetId) {
      setDraftDefaultPresetId(filtered[0]?.id || 'claude')
    }
  }

  const handleAddPreset = () => {
    if (!newLabel.trim() || !newBaseCommand.trim()) return
    if (draftPresets.length >= MAX_PRESETS) return

    const newPreset: CommandPreset = {
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      label: newLabel.trim(),
      baseCommand: newBaseCommand.trim(),
      modifiers: newModifiers.trim(),
      isBuiltIn: false,
      agentType: newAgentType || undefined,
    }

    setDraftPresets([...draftPresets, newPreset])
    setShowAddForm(false)
    setNewLabel('')
    setNewBaseCommand('')
    setNewModifiers('')
    setNewAgentType('')
  }

  const canAddPreset = draftPresets.length < MAX_PRESETS

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto border border-border bg-elevated p-6"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wider text-primary text-balance">
          Settings
        </h2>
        <p className="mt-2 text-xs text-muted text-pretty">
          Configure default directory, command presets, and display options.
        </p>

        <div className="mt-5 space-y-4">
          <GeneralSettingsSection
            draftDir={draftDir}
            setDraftDir={setDraftDir}
            projectPathPresets={projectPathPresets}
            newPresetPath={newPresetPath}
            setNewPresetPath={setNewPresetPath}
            addProjectPathPreset={addProjectPathPreset}
            removeProjectPathPreset={removeProjectPathPreset}
            draftShortcutModifier={draftShortcutModifier}
            setDraftShortcutModifier={setDraftShortcutModifier}
          />

          <CommandPresetsSection
            draftPresets={draftPresets}
            draftDefaultPresetId={draftDefaultPresetId}
            setDraftDefaultPresetId={setDraftDefaultPresetId}
            handleUpdatePreset={handleUpdatePreset}
            handleDeletePreset={handleDeletePreset}
            handleAddPreset={handleAddPreset}
            canAddPreset={canAddPreset}
            showAddForm={showAddForm}
            setShowAddForm={setShowAddForm}
            newLabel={newLabel}
            setNewLabel={setNewLabel}
            newBaseCommand={newBaseCommand}
            setNewBaseCommand={setNewBaseCommand}
            newModifiers={newModifiers}
            setNewModifiers={setNewModifiers}
            newAgentType={newAgentType}
            setNewAgentType={setNewAgentType}
          />

          <SessionListSettingsSection
            draftSortMode={draftSortMode}
            setDraftSortMode={setDraftSortMode}
            draftSortDirection={draftSortDirection}
            setDraftSortDirection={setDraftSortDirection}
            draftSessionGroupMode={draftSessionGroupMode}
            setDraftSessionGroupMode={setDraftSessionGroupMode}
            draftShowProjectName={draftShowProjectName}
            setDraftShowProjectName={setDraftShowProjectName}
            draftShowLastUserMessage={draftShowLastUserMessage}
            setDraftShowLastUserMessage={setDraftShowLastUserMessage}
            draftShowSessionIdPrefix={draftShowSessionIdPrefix}
            setDraftShowSessionIdPrefix={setDraftShowSessionIdPrefix}
          />

          <NotificationSettingsSection
            draftSoundOnPermission={draftSoundOnPermission}
            setDraftSoundOnPermission={setDraftSoundOnPermission}
            draftSoundOnIdle={draftSoundOnIdle}
            setDraftSoundOnIdle={setDraftSoundOnIdle}
            draftNotifyOnPermission={draftNotifyOnPermission}
            setDraftNotifyOnPermission={setDraftNotifyOnPermission}
            draftNotifyOnIdle={draftNotifyOnIdle}
            setDraftNotifyOnIdle={setDraftNotifyOnIdle}
          />

          <TerminalSettingsSection
            draftUseWebGL={draftUseWebGL}
            setDraftUseWebGL={setDraftUseWebGL}
            useWebGL={useWebGL}
            draftFontSize={draftFontSize}
            setDraftFontSize={setDraftFontSize}
            draftLineHeight={draftLineHeight}
            setDraftLineHeight={setDraftLineHeight}
            draftLetterSpacing={draftLetterSpacing}
            setDraftLetterSpacing={setDraftLetterSpacing}
            draftFontOption={draftFontOption}
            setDraftFontOption={setDraftFontOption}
            draftCustomFontFamily={draftCustomFontFamily}
            setDraftCustomFontFamily={setDraftCustomFontFamily}
            draftTheme={draftTheme}
            setDraftTheme={setDraftTheme}
          />

          <CronSettingsSection
            draftCronPollInterval={draftCronPollInterval}
            setDraftCronPollInterval={setDraftCronPollInterval}
            draftCronAvatarStyle={draftCronAvatarStyle}
            setDraftCronAvatarStyle={setDraftCronAvatarStyle}
            draftCronSudoGracePeriod={draftCronSudoGracePeriod}
            setDraftCronSudoGracePeriod={setDraftCronSudoGracePeriod}
            draftCronShowSystemJobs={draftCronShowSystemJobs}
            setDraftCronShowSystemJobs={setDraftCronShowSystemJobs}
            draftCronShowUserJobs={draftCronShowUserJobs}
            setDraftCronShowUserJobs={setDraftCronShowUserJobs}
            draftCronDefaultTimelineVisible={draftCronDefaultTimelineVisible}
            setDraftCronDefaultTimelineVisible={setDraftCronDefaultTimelineVisible}
            draftCronDefaultTimelineRange={draftCronDefaultTimelineRange}
            setDraftCronDefaultTimelineRange={setDraftCronDefaultTimelineRange}
            draftCronNotifyFailure={draftCronNotifyFailure}
            setDraftCronNotifyFailure={setDraftCronNotifyFailure}
            draftCronNotifyMissedRun={draftCronNotifyMissedRun}
            setDraftCronNotifyMissedRun={setDraftCronNotifyMissedRun}
            draftCronNotifyManualRun={draftCronNotifyManualRun}
            setDraftCronNotifyManualRun={setDraftCronNotifyManualRun}
            draftCronDesktopNotifications={draftCronDesktopNotifications}
            setDraftCronDesktopNotifications={setDraftCronDesktopNotifications}
            draftCronAutoTagSuggestions={draftCronAutoTagSuggestions}
            setDraftCronAutoTagSuggestions={setDraftCronAutoTagSuggestions}
            draftCronMaxHistoryDays={draftCronMaxHistoryDays}
            setDraftCronMaxHistoryDays={setDraftCronMaxHistoryDays}
            draftCronMaxHistoryPerJob={draftCronMaxHistoryPerJob}
            setDraftCronMaxHistoryPerJob={setDraftCronMaxHistoryPerJob}
          />
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={() => onClose()} className="btn">
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
