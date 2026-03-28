import { useEffect, useRef, useState } from 'react'
import { type CommandPreset, getFullCommand } from '../../stores/settingsStore'

export interface UseNewSessionFormOptions {
  isOpen: boolean
  onClose: () => void
  onCreate: (projectPath: string, name?: string, command?: string, prompt?: string) => void
  defaultProjectDir: string
  commandPresets: CommandPreset[]
  defaultPresetId: string
  onUpdateModifiers: (presetId: string, modifiers: string) => void
  lastProjectPath?: string | null
  activeProjectPath?: string
}

export default function useNewSessionForm({
  isOpen,
  onClose,
  onCreate,
  defaultProjectDir,
  commandPresets,
  defaultPresetId,
  onUpdateModifiers,
  lastProjectPath,
  activeProjectPath,
}: UseNewSessionFormOptions) {
  const [projectPath, setProjectPath] = useState('')
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null)
  const [modifiers, setModifiers] = useState('')
  const [customCommand, setCustomCommand] = useState('')
  const [isCustomMode, setIsCustomMode] = useState(false)
  const [showBrowser, setShowBrowser] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const projectPathRef = useRef<HTMLInputElement>(null)
  const defaultButtonRef = useRef<HTMLButtonElement>(null)

  // Get current preset
  const selectedPreset = selectedPresetId
    ? commandPresets.find(p => p.id === selectedPresetId)
    : null

  // Compute preview command
  const previewCommand = isCustomMode
    ? customCommand.trim()
    : selectedPreset
      ? getFullCommand({ ...selectedPreset, modifiers })
      : ''

  // Build button list: presets + Custom
  const allOptions = [
    ...commandPresets.map(p => ({ id: p.id, label: p.label, isCustom: false })),
    { id: 'custom', label: 'Custom', isCustom: true },
  ]

  // Reset/init effect
  useEffect(() => {
    let closeTimeoutId: ReturnType<typeof setTimeout> | null = null
    
    if (!isOpen) {
      setProjectPath('')
      setName('')
      setPrompt('')
      setSelectedPresetId(null)
      setModifiers('')
      setCustomCommand('')
      setIsCustomMode(false)
      setShowBrowser(false)
      // Re-enable terminal textarea after delay to allow fade-out
      closeTimeoutId = setTimeout(() => {
        if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return
        const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
        if (textarea) {
          textarea.removeAttribute('disabled')
          textarea.focus()
        }
      }, 300)
      return () => {
        if (closeTimeoutId) clearTimeout(closeTimeoutId)
      }
    }
    // Disable terminal textarea when modal opens to prevent keyboard capture
    if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
      const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
      if (textarea && typeof textarea.setAttribute === 'function') {
        if (typeof textarea.blur === 'function') textarea.blur()
        textarea.setAttribute('disabled', 'true')
      }
    }
    // Initialize state when opening
    const basePath =
      activeProjectPath?.trim() || lastProjectPath || defaultProjectDir
    setProjectPath(basePath)
    setName('')
    // Select default preset
    const defaultPreset = commandPresets.find(p => p.id === defaultPresetId)
    if (defaultPreset) {
      setSelectedPresetId(defaultPresetId)
      setModifiers(defaultPreset.modifiers)
      setIsCustomMode(false)
    } else if (commandPresets.length > 0) {
      setSelectedPresetId(commandPresets[0].id)
      setModifiers(commandPresets[0].modifiers)
      setIsCustomMode(false)
    } else {
      setIsCustomMode(true)
    }
    setCustomCommand('')
    // Focus default button and scroll project path after DOM update
    setTimeout(() => {
      defaultButtonRef.current?.focus()
      if (projectPathRef.current) {
        projectPathRef.current.scrollIntoView({ block: 'center' })
      }
    }, 50)
  }, [activeProjectPath, commandPresets, defaultPresetId, defaultProjectDir, isOpen, lastProjectPath])

  // Keyboard trap effect
  useEffect(() => {
    if (!isOpen) return
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return

    const getFocusableElements = () => {
      if (!formRef.current) return []
      const selector =
        'input:not([disabled]), button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]'
      return Array.from(formRef.current.querySelectorAll<HTMLElement>(selector))
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (showBrowser) return

      if (e.key === 'Escape') {
        if (typeof e.stopPropagation === 'function') e.stopPropagation()
        onClose()
        return
      }

      if (e.key === 'Enter' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault()
        if (typeof e.stopPropagation === 'function') e.stopPropagation()
        formRef.current?.requestSubmit()
        return
      }

      if (e.key === 'Tab') {
        e.preventDefault()
        if (typeof e.stopPropagation === 'function') e.stopPropagation()
        const focusableElements = getFocusableElements()
        if (focusableElements.length === 0) return

        const activeEl = document.activeElement as HTMLElement
        const currentIndex = focusableElements.indexOf(activeEl)

        let nextIndex: number
        if (currentIndex === -1) {
          // If current element not in list, start from beginning or end
          nextIndex = e.shiftKey ? focusableElements.length - 1 : 0
        } else if (e.shiftKey) {
          nextIndex = currentIndex <= 0 ? focusableElements.length - 1 : currentIndex - 1
        } else {
          nextIndex = currentIndex >= focusableElements.length - 1 ? 0 : currentIndex + 1
        }

        focusableElements[nextIndex]?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose, showBrowser])

  const handlePresetSelect = (presetId: string) => {
    const preset = commandPresets.find(p => p.id === presetId)
    if (preset) {
      setSelectedPresetId(presetId)
      setModifiers(preset.modifiers)
      setIsCustomMode(false)
    }
  }

  const handleCustomSelect = () => {
    setIsCustomMode(true)
    setSelectedPresetId(null)
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const trimmedPath = projectPath.trim()
    if (!trimmedPath) {
      return
    }

    let finalCommand: string
    if (isCustomMode) {
      finalCommand = customCommand.trim()
    } else if (selectedPreset) {
      // Auto-save modifier if changed
      const trimmedModifiers = modifiers.trim()
      if (trimmedModifiers !== selectedPreset.modifiers.trim()) {
        onUpdateModifiers(selectedPreset.id, trimmedModifiers)
      }
      finalCommand = getFullCommand({ ...selectedPreset, modifiers: trimmedModifiers })
    } else {
      finalCommand = ''
    }

    onCreate(
      trimmedPath,
      name.trim() || undefined,
      finalCommand || undefined,
      prompt.trim() || undefined
    )
    onClose()
  }

  return {
    projectPath, setProjectPath,
    name, setName,
    prompt, setPrompt,
    selectedPresetId,
    modifiers, setModifiers,
    customCommand, setCustomCommand,
    isCustomMode,
    showBrowser, setShowBrowser,
    formRef, projectPathRef, defaultButtonRef,
    selectedPreset, previewCommand, allOptions,
    handlePresetSelect, handleCustomSelect, handleSubmit,
  }
}
