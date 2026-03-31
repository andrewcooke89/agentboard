import { useSettingsStore, type CommandPreset } from '../stores/settingsStore'

interface AgentTypePickerProps {
  value?: 'claude' | 'codex'
  onChange: (value: 'claude' | 'codex' | undefined) => void
  label?: string
  allowNone?: boolean
}

export function AgentTypePicker({
  value,
  onChange,
  label,
  allowNone,
}: AgentTypePickerProps) {
  const commandPresets = useSettingsStore((state) => state.commandPresets)
  const agentPresets = commandPresets.filter(
    (p: CommandPreset) => p.agentType != null
  )

  return (
    <div>
      {label && (
        <label className="mb-1.5 block text-xs text-secondary">{label}</label>
      )}
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label || 'Agent type'}>
        {allowNone && (
          <button
            type="button"
            role="radio"
            aria-checked={value === undefined}
            onClick={() => onChange(undefined)}
            className={`btn text-xs focus:outline-none focus:ring-2 focus:ring-primary ${value === undefined ? 'btn-primary' : ''}`}
          >
            Default
          </button>
        )}
        {agentPresets.map((preset) => {
          const isActive = value === preset.agentType
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={isActive}
              onClick={() => onChange(preset.agentType!)}
              className={`btn text-xs focus:outline-none focus:ring-2 focus:ring-primary ${isActive ? 'btn-primary' : ''}`}
            >
              {preset.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
