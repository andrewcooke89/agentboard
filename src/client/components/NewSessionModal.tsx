import { DirectoryBrowser } from './DirectoryBrowser'
import { type CommandPreset } from '../stores/settingsStore'
import useNewSessionForm from './hooks/useNewSessionForm'
import CommandPresetSelector from './CommandPresetSelector'
import ProjectPathSelector from './ProjectPathSelector'

interface NewSessionModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (projectPath: string, name?: string, command?: string, prompt?: string) => void
  defaultProjectDir: string
  commandPresets: CommandPreset[]
  defaultPresetId: string
  onUpdateModifiers: (presetId: string, modifiers: string) => void
  lastProjectPath?: string | null
  activeProjectPath?: string
  projectPathPresets?: string[]
}

export default function NewSessionModal({
  isOpen,
  onClose,
  onCreate,
  defaultProjectDir,
  commandPresets,
  defaultPresetId,
  onUpdateModifiers,
  lastProjectPath,
  activeProjectPath,
  projectPathPresets,
}: NewSessionModalProps) {
  const {
    projectPath, setProjectPath,
    name, setName,
    prompt, setPrompt,
    selectedPresetId,
    modifiers, setModifiers,
    customCommand, setCustomCommand,
    isCustomMode,
    showBrowser, setShowBrowser,
    formRef, projectPathRef, defaultButtonRef,
    selectedPreset, previewCommand,
    handlePresetSelect, handleCustomSelect, handleSubmit,
  } = useNewSessionForm({
    isOpen,
    onClose,
    onCreate,
    defaultProjectDir,
    commandPresets,
    defaultPresetId,
    onUpdateModifiers,
    lastProjectPath,
    activeProjectPath,
  })

  if (!isOpen) {
    return null
  }

  const browserInitialPath = projectPath.trim() || '~'
  const pathPlaceholder = activeProjectPath || lastProjectPath || defaultProjectDir || '/Users/you/code/my-project'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-session-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <form
        ref={formRef}
        onSubmit={handleSubmit}
        className="w-full max-w-md border border-border bg-elevated p-6"
      >
        <h2 id="new-session-title" className="text-sm font-semibold uppercase tracking-wider text-primary text-balance">
          New Session
        </h2>

        <div className="mt-4 space-y-4">
          <CommandPresetSelector
            commandPresets={commandPresets}
            selectedPresetId={selectedPresetId}
            isCustomMode={isCustomMode}
            modifiers={modifiers}
            customCommand={customCommand}
            previewCommand={previewCommand}
            defaultButtonRef={defaultButtonRef}
            onPresetSelect={handlePresetSelect}
            onCustomSelect={handleCustomSelect}
            onModifiersChange={setModifiers}
            onCustomCommandChange={setCustomCommand}
            selectedPreset={selectedPreset}
          />
          <ProjectPathSelector
            projectPath={projectPath}
            onPathChange={setProjectPath}
            onBrowse={() => setShowBrowser(true)}
            projectPathRef={projectPathRef}
            projectPathPresets={projectPathPresets}
            placeholder={pathPlaceholder}
          />
          <div>
            <label className="mb-1.5 block text-xs text-secondary">
              Initial Prompt <span className="text-muted">(optional)</span>
            </label>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="e.g., Review the codebase and suggest improvements"
              rows={2}
              className="input text-sm resize-y"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-secondary">
              Display Name
            </label>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="auto-generated from project path"
              className="input text-sm placeholder:italic"
            />
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn">
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Create
          </button>
        </div>
      </form>
      {showBrowser && (
        <DirectoryBrowser
          initialPath={browserInitialPath}
          onSelect={(path) => {
            setProjectPath(path)
            setShowBrowser(false)
          }}
          onCancel={() => setShowBrowser(false)}
        />
      )}
    </div>
  )
}

