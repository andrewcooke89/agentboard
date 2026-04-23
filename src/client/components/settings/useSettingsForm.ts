import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_PROJECT_DIR,
  MAX_PRESETS,
  FONT_OPTIONS,
  useSettingsStore,
  type CommandPreset,
  type FontOption,
  type SessionSortDirection,
  type SessionSortMode,
  type ShortcutModifier,
} from '../../stores/settingsStore'
import { useThemeStore, type Theme } from '../../stores/themeStore'
import { primeAudio } from '../../utils/sound'
import { requestNotificationPermission } from '../../utils/notification'

export function useSettingsForm(isOpen: boolean, onClose: (flags?: { webglChanged: boolean }) => void) {
  // ── Store values ────────────────────────────────────────────────────
  const {
    defaultProjectDir,
    setDefaultProjectDir,
    sessionSortMode,
    setSessionSortMode,
    sessionSortDirection,
    setSessionSortDirection,
    useWebGL,
    setUseWebGL,
    fontSize,
    setFontSize,
    lineHeight,
    setLineHeight,
    letterSpacing,
    setLetterSpacing,
    fontOption,
    setFontOption,
    customFontFamily,
    setCustomFontFamily,
    shortcutModifier,
    setShortcutModifier,
    showProjectName,
    setShowProjectName,
    showLastUserMessage,
    setShowLastUserMessage,
    showSessionIdPrefix,
    setShowSessionIdPrefix,
    soundOnPermission,
    setSoundOnPermission,
    soundOnIdle,
    setSoundOnIdle,
    commandPresets,
    setCommandPresets,
    defaultPresetId,
    setDefaultPresetId,
    updatePresetModifiers,
    addPreset,
    removePreset,
    projectPathPresets,
    addProjectPathPreset,
    removeProjectPathPreset,
    notifyOnPermission,
    setNotifyOnPermission,
    notifyOnIdle,
    setNotifyOnIdle,
    sessionGroupMode,
    setSessionGroupMode,
    cronPollInterval,
    setCronPollInterval,
    cronAvatarStyle,
    setCronAvatarStyle,
    cronSudoGracePeriod,
    setCronSudoGracePeriod,
    cronShowSystemJobs,
    setCronShowSystemJobs,
    cronShowUserJobs,
    setCronShowUserJobs,
    cronDefaultTimelineVisible,
    setCronDefaultTimelineVisible,
    cronDefaultTimelineRange,
    setCronDefaultTimelineRange,
    cronNotifyFailure,
    setCronNotifyFailure,
    cronNotifyMissedRun,
    setCronNotifyMissedRun,
    cronNotifyManualRun,
    setCronNotifyManualRun,
    cronDesktopNotifications,
    setCronDesktopNotifications,
    cronAutoTagSuggestions,
    setCronAutoTagSuggestions,
    cronMaxHistoryDays,
    setCronMaxHistoryDays,
    cronMaxHistoryPerJob,
    setCronMaxHistoryPerJob,
  } = useSettingsStore()

  const { theme, setTheme } = useThemeStore()

  // ── Draft state ─────────────────────────────────────────────────────
  const [draftDir, setDraftDir] = useState(defaultProjectDir)
  const [draftPresets, setDraftPresets] = useState<CommandPreset[]>(commandPresets)
  const [draftDefaultPresetId, setDraftDefaultPresetId] = useState(defaultPresetId)
  const [draftSortMode, setDraftSortMode] = useState<SessionSortMode>(sessionSortMode)
  const [draftSortDirection, setDraftSortDirection] = useState<SessionSortDirection>(sessionSortDirection)
  const [draftUseWebGL, setDraftUseWebGL] = useState(useWebGL)
  const [draftFontSize, setDraftFontSize] = useState(fontSize)
  const [draftLineHeight, setDraftLineHeight] = useState(lineHeight)
  const [draftLetterSpacing, setDraftLetterSpacing] = useState(letterSpacing)
  const [draftFontOption, setDraftFontOption] = useState<FontOption>(fontOption)
  const [draftCustomFontFamily, setDraftCustomFontFamily] = useState(customFontFamily)
  const [draftShortcutModifier, setDraftShortcutModifier] = useState<ShortcutModifier | 'auto'>(shortcutModifier)
  const [draftShowProjectName, setDraftShowProjectName] = useState(showProjectName)
  const [draftShowLastUserMessage, setDraftShowLastUserMessage] = useState(showLastUserMessage)
  const [draftShowSessionIdPrefix, setDraftShowSessionIdPrefix] = useState(showSessionIdPrefix)
  const [draftTheme, setDraftTheme] = useState<Theme>(theme)
  const [draftSoundOnPermission, setDraftSoundOnPermission] = useState(soundOnPermission)
  const [draftSoundOnIdle, setDraftSoundOnIdle] = useState(soundOnIdle)
  const [draftNotifyOnPermission, setDraftNotifyOnPermission] = useState(notifyOnPermission)
  const [draftNotifyOnIdle, setDraftNotifyOnIdle] = useState(notifyOnIdle)
  const [draftSessionGroupMode, setDraftSessionGroupMode] = useState<'none' | 'project'>(sessionGroupMode)

  // Cron draft values
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
  const [newAgentType, setNewAgentType] = useState<'claude' | 'codex'>('claude')
  const [newPresetPath, setNewPresetPath] = useState('')

  const canAddPreset = draftPresets.length < MAX_PRESETS

  // ── Sync draft state when modal opens/closes ────────────────────────
  useEffect(() => {
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
      // Cron
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
      // Reset new preset form
      setShowAddForm(false)
      setNewLabel('')
      setNewBaseCommand('')
      setNewModifiers('')
      setNewAgentType('claude')
      setNewPresetPath('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  // ── Escape key handler ──────────────────────────────────────────────
  const modalRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [isOpen, onClose])

  // ── Handlers ────────────────────────────────────────────────────────
  const handleSubmit = () => {
    const webglChanged = draftUseWebGL !== useWebGL

    setDefaultProjectDir(draftDir)
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
    // Cron
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

    // Prime audio and request notification permission if needed
    if (draftSoundOnPermission || draftSoundOnIdle) {
      void primeAudio()
    }
    if (draftNotifyOnPermission || draftNotifyOnIdle) {
      void requestNotificationPermission()
    }

    onClose({ webglChanged })
  }

  const handleUpdatePreset = (id: string, field: string, value: string) => {
    setDraftPresets(prev =>
      prev.map(p => (p.id === id ? { ...p, [field]: value } : p))
    )
  }

  const handleDeletePreset = (id: string) => {
    setDraftPresets(prev => prev.filter(p => p.id !== id))
    if (draftDefaultPresetId === id) {
      const remaining = draftPresets.filter(p => p.id !== id)
      setDraftDefaultPresetId(remaining[0]?.id || 'claude')
    }
  }

  const handleAddPreset = () => {
    if (!canAddPreset) return
    const trimmedLabel = newLabel.trim()
    const trimmedCommand = newBaseCommand.trim()
    if (!trimmedLabel || !trimmedCommand) return

    const existingIds = new Set(draftPresets.map(p => p.id))
    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    // Ensure unique id
    let finalId = id
    let attempts = 0
    while (existingIds.has(finalId) && attempts < 100) {
      finalId = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      attempts++
    }

    const newPreset: CommandPreset = {
      id: finalId,
      label: trimmedLabel.slice(0, 64),
      baseCommand: trimmedCommand.slice(0, 256),
      modifiers: newModifiers.trim().slice(0, 1024),
      isBuiltIn: false,
      agentType: newAgentType,
    }

    setDraftPresets(prev => [...prev, newPreset])
    setNewLabel('')
    setNewBaseCommand('')
    setNewModifiers('')
    setNewAgentType('claude')
    setShowAddForm(false)
  }

  return {
    // Draft values
    draftDir,
    draftPresets,
    draftDefaultPresetId,
    draftSortMode,
    draftSortDirection,
    draftUseWebGL,
    draftFontSize,
    draftLineHeight,
    draftLetterSpacing,
    draftFontOption,
    draftCustomFontFamily,
    draftShortcutModifier,
    draftShowProjectName,
    draftShowLastUserMessage,
    draftShowSessionIdPrefix,
    draftTheme,
    draftSoundOnPermission,
    draftSoundOnIdle,
    draftNotifyOnPermission,
    draftNotifyOnIdle,
    draftSessionGroupMode,
    // Cron draft values
    draftCronPollInterval,
    draftCronAvatarStyle,
    draftCronSudoGracePeriod,
    draftCronShowSystemJobs,
    draftCronShowUserJobs,
    draftCronDefaultTimelineVisible,
    draftCronDefaultTimelineRange,
    draftCronNotifyFailure,
    draftCronNotifyMissedRun,
    draftCronNotifyManualRun,
    draftCronDesktopNotifications,
    draftCronAutoTagSuggestions,
    draftCronMaxHistoryDays,
    draftCronMaxHistoryPerJob,
    // Draft setters
    setDraftDir,
    setDraftPresets,
    setDraftDefaultPresetId,
    setDraftSortMode,
    setDraftSortDirection,
    setDraftUseWebGL,
    setDraftFontSize,
    setDraftLineHeight,
    setDraftLetterSpacing,
    setDraftFontOption,
    setDraftCustomFontFamily,
    setDraftShortcutModifier,
    setDraftShowProjectName,
    setDraftShowLastUserMessage,
    setDraftShowSessionIdPrefix,
    setDraftTheme,
    setDraftSoundOnPermission,
    setDraftSoundOnIdle,
    setDraftNotifyOnPermission,
    setDraftNotifyOnIdle,
    setDraftSessionGroupMode,
    // Cron draft setters
    setDraftCronPollInterval,
    setDraftCronAvatarStyle,
    setDraftCronSudoGracePeriod,
    setDraftCronShowSystemJobs,
    setDraftCronShowUserJobs,
    setDraftCronDefaultTimelineVisible,
    setDraftCronDefaultTimelineRange,
    setDraftCronNotifyFailure,
    setDraftCronNotifyMissedRun,
    setDraftCronNotifyManualRun,
    setDraftCronDesktopNotifications,
    setDraftCronAutoTagSuggestions,
    setDraftCronMaxHistoryDays,
    setDraftCronMaxHistoryPerJob,
    // Store values needed by section components
    projectPathPresets,
    addProjectPathPreset,
    removeProjectPathPreset,
    useWebGL, // needed for "terminal will reload" check
    // Handlers
    handleSubmit,
    handleUpdatePreset,
    handleDeletePreset,
    handleAddPreset,
    // New preset form state
    canAddPreset,
    showAddForm,
    setShowAddForm,
    newLabel,
    setNewLabel,
    newBaseCommand,
    setNewBaseCommand,
    newModifiers,
    setNewModifiers,
    newAgentType,
    setNewAgentType,
    newPresetPath,
    setNewPresetPath,
    // Ref
    modalRef,
  }
}

export { DEFAULT_PROJECT_DIR, MAX_PRESETS, FONT_OPTIONS } from '../../stores/settingsStore'
export type { CommandPreset, FontOption, SessionSortDirection, SessionSortMode, ShortcutModifier } from '../../stores/settingsStore'
export type { Theme } from '../../stores/themeStore'
