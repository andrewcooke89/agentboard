import { useState } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { DirectoryBrowser } from './DirectoryBrowser'

interface ProjectPathPickerProps {
  value: string
  onChange: (path: string) => void
  label?: string
  className?: string
}

export function ProjectPathPicker({
  value,
  onChange,
  label,
  className,
}: ProjectPathPickerProps) {
  const [showBrowser, setShowBrowser] = useState(false)
  const projectPathPresets = useSettingsStore(
    (state) => state.projectPathPresets
  )

  return (
    <div className={className}>
      {label && (
        <label className="mb-1.5 block text-xs text-secondary">{label}</label>
      )}
      {/* Project path preset quick-select buttons */}
      {projectPathPresets && projectPathPresets.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {projectPathPresets.map((preset) => {
            const presetLabel =
              preset.replace(/\/+$/, '').split('/').pop() || preset
            const isActive = value === preset
            return (
              <button
                key={preset}
                type="button"
                title={preset}
                onClick={() => onChange(preset)}
                className={`btn text-xs focus:outline-none focus:ring-2 focus:ring-primary ${isActive ? 'btn-primary' : ''}`}
              >
                {presetLabel}
              </button>
            )
          })}
        </div>
      )}
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="/path/to/project"
          className="input flex-1 text-sm"
        />
        <button
          type="button"
          className="btn"
          onClick={() => setShowBrowser(true)}
        >
          Browse
        </button>
      </div>
      {showBrowser && (
        <DirectoryBrowser
          initialPath={value.trim() || '~'}
          onSelect={(path) => {
            onChange(path)
            setShowBrowser(false)
          }}
          onCancel={() => setShowBrowser(false)}
        />
      )}
    </div>
  )
}
