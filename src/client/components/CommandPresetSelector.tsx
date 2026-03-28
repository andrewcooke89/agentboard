import React from 'react'
import { type CommandPreset } from '../stores/settingsStore'

export interface CommandPresetSelectorProps {
  commandPresets: CommandPreset[]
  selectedPresetId: string | null
  isCustomMode: boolean
  modifiers: string
  customCommand: string
  previewCommand: string
  defaultButtonRef: React.RefObject<HTMLButtonElement | null>
  onPresetSelect: (presetId: string) => void
  onCustomSelect: () => void
  onModifiersChange: (value: string) => void
  onCustomCommandChange: (value: string) => void
  selectedPreset: CommandPreset | null | undefined
}

const allOptions = (
  commandPresets: CommandPreset[]
): Array<{ id: string; label: string; isCustom: boolean }> => [
  ...commandPresets.map((p) => ({ id: p.id, label: p.label, isCustom: false })),
  { id: 'custom', label: 'Custom', isCustom: true },
]

const CommandPresetSelector: React.FC<CommandPresetSelectorProps> = ({
  commandPresets,
  selectedPresetId,
  isCustomMode,
  modifiers,
  customCommand,
  previewCommand,
  defaultButtonRef,
  onPresetSelect,
  onCustomSelect,
  onModifiersChange,
  onCustomCommandChange,
  selectedPreset,
}) => {
  const options = allOptions(commandPresets)

  const isActive = (option: (typeof options)[number]) => {
    if (option.isCustom) return isCustomMode
    return option.id === selectedPresetId
  }

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    let nextIndex: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      nextIndex = (index + 1) % options.length
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      nextIndex = (index - 1 + options.length) % options.length
    }
    if (nextIndex !== null) {
      e.preventDefault()
      const container = e.currentTarget.parentElement
      if (container) {
        const buttons = container.querySelectorAll<HTMLButtonElement>(
          '[role="radio"]'
        )
        buttons[nextIndex]?.focus()
      }
    }
  }

  return (
    <div>
      <label className="mb-1.5 block text-xs text-secondary">Command</label>
      <div
        className="flex flex-wrap gap-1.5"
        role="radiogroup"
        aria-label="Command preset"
      >
        {options.map((option, index) => {
          const active = isActive(option)
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={active}
              ref={active ? (defaultButtonRef as React.LegacyRef<HTMLButtonElement>) : undefined}
              tabIndex={active ? 0 : -1}
              onClick={() => {
                if (option.isCustom) {
                  onCustomSelect()
                } else {
                  onPresetSelect(option.id)
                }
              }}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={`btn text-xs focus:outline-none focus:ring-2 focus:ring-primary ${active ? 'btn-primary' : ''}`}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      {!isCustomMode && selectedPreset && (
        <div className="mt-2">
          <input
            value={modifiers}
            onChange={(event) => onModifiersChange(event.target.value)}
            placeholder="Modifiers (e.g., --model opus)"
            className="input font-mono text-xs"
          />
        </div>
      )}
      {isCustomMode && (
        <input
          value={customCommand}
          onChange={(event) => onCustomCommandChange(event.target.value)}
          placeholder="Enter custom command..."
          className="input mt-2 font-mono text-xs"
        />
      )}
      {previewCommand && (
        <p className="mt-2 text-xs text-muted font-mono truncate">
          Will run: {previewCommand}
        </p>
      )}
    </div>
  )
}

export default CommandPresetSelector
