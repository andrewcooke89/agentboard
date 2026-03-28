import React from 'react'

export interface ProjectPathSelectorProps {
  projectPath: string
  onPathChange: (path: string) => void
  onBrowse: () => void
  projectPathRef: React.RefObject<HTMLInputElement | null>
  projectPathPresets?: string[]
  placeholder: string
}

const ProjectPathSelector: React.FC<ProjectPathSelectorProps> = ({
  projectPath,
  onPathChange,
  onBrowse,
  projectPathRef,
  projectPathPresets,
  placeholder,
}) => {
  return (
    <div>
      <label className="mb-1.5 block text-xs text-secondary">Project Path</label>
      {projectPathPresets && projectPathPresets.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {projectPathPresets.map((preset) => {
            const label = preset.replace(/\/+$/, '').split('/').pop() || preset
            const isActive = projectPath === preset
            return (
              <button
                key={preset}
                type="button"
                title={preset}
                onClick={() => onPathChange(preset)}
                className={`btn text-xs focus:outline-none focus:ring-2 focus:ring-primary ${isActive ? 'btn-primary' : ''}`}
              >
                {label}
              </button>
            )
          })}
        </div>
      )}
      <div className="flex gap-2">
        <input
          ref={projectPathRef as React.LegacyRef<HTMLInputElement>}
          value={projectPath}
          onChange={(event) => onPathChange(event.target.value)}
          placeholder={placeholder}
          className="input flex-1 text-sm"
        />
        <button
          type="button"
          className="btn"
          onClick={onBrowse}
        >
          Browse
        </button>
      </div>
    </div>
  )
}

export default ProjectPathSelector
