import type { CommandPreset } from '../../stores/settingsStore'

interface CommandPresetsSectionProps {
  draftPresets: CommandPreset[]
  draftDefaultPresetId: string
  setDraftDefaultPresetId: (v: string) => void
  handleUpdatePreset: (presetId: string, field: string, value: string) => void
  handleDeletePreset: (presetId: string) => void
  handleAddPreset: () => void
  canAddPreset: boolean
  maxPresets: number
  showAddForm: boolean
  setShowAddForm: (v: boolean) => void
  newLabel: string
  setNewLabel: (v: string) => void
  newBaseCommand: string
  setNewBaseCommand: (v: string) => void
  newModifiers: string
  setNewModifiers: (v: string) => void
  newAgentType: 'claude' | 'codex' | ''
  setNewAgentType: (v: 'claude' | 'codex' | '') => void
}

export default function CommandPresetsSection({
  draftPresets,
  draftDefaultPresetId,
  setDraftDefaultPresetId,
  handleUpdatePreset,
  handleDeletePreset,
  handleAddPreset,
  canAddPreset,
  maxPresets,
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
}: CommandPresetsSectionProps) {
  return (
    <div className="border-t border-border pt-4">
      <div className="flex items-center justify-between mb-2">
        <label className="block text-xs text-secondary">Command Presets</label>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted">Default:</span>
          <select
            value={draftDefaultPresetId}
            onChange={(e) => setDraftDefaultPresetId(e.target.value)}
            className="input text-xs py-0.5 px-1.5"
          >
            {draftPresets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="text-[10px] text-muted mb-3">
        Customize command presets for quick session creation ({draftPresets.length}/{maxPresets})
      </p>

      {/* Preset list */}
      <div className="space-y-2 mb-3">
        {draftPresets.map((preset) => (
          <div
            key={preset.id}
            className="border border-border p-2.5 space-y-2"
          >
            {/* Label row */}
            <div className="flex items-center gap-2">
              <input
                value={preset.label}
                onChange={(e) => handleUpdatePreset(preset.id, 'label', e.target.value)}
                className="input text-xs flex-1"
                placeholder="Label"
                disabled={preset.isBuiltIn}
              />
              {/* Agent type icon selector */}
              <div className="flex gap-0.5">
                <button
                  type="button"
                  title="Claude"
                  className={`p-1 rounded ${
                    preset.agentType === 'claude' || !preset.agentType
                      ? 'bg-accent text-accent'
                      : 'bg-surface hover:bg-surface-secondary text-muted'
                  }`}
                  onClick={() => handleUpdatePreset(preset.id, 'agentType', 'claude')}
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
                  </svg>
                </button>
                <button
                  type="button"
                  title="Codex"
                  className={`p-1 rounded ${
                    preset.agentType === 'codex'
                      ? 'bg-accent text-accent'
                      : 'bg-surface hover:bg-surface-secondary text-muted'
                  }`}
                  onClick={() => handleUpdatePreset(preset.id, 'agentType', 'codex')}
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>
                  </svg>
                </button>
              </div>
              {/* Delete button */}
              {!preset.isBuiltIn && (
                <button
                  type="button"
                  className="text-muted hover:text-primary text-xs px-1.5"
                  onClick={() => handleDeletePreset(preset.id)}
                >
                  ✕
                </button>
              )}
            </div>
            {/* Base command */}
            <div className="text-[10px] text-muted font-mono bg-surface-secondary px-2 py-1 rounded truncate">
              {preset.baseCommand}
            </div>
            {/* Modifiers */}
            <input
              value={preset.modifiers}
              onChange={(e) => handleUpdatePreset(preset.id, 'modifiers', e.target.value)}
              className="input text-xs font-mono w-full"
              placeholder="Additional flags..."
            />
          </div>
        ))}
      </div>

      {/* Add preset form */}
      {showAddForm ? (
        <div className="border border-dashed border-border p-3 space-y-2">
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            className="input text-xs w-full"
            placeholder="Label (e.g., My Custom Agent)"
            autoFocus
          />
          <input
            value={newBaseCommand}
            onChange={(e) => setNewBaseCommand(e.target.value)}
            className="input text-xs w-full font-mono"
            placeholder="Base command (e.g., claude)"
          />
          <input
            value={newModifiers}
            onChange={(e) => setNewModifiers(e.target.value)}
            className="input text-xs w-full font-mono"
            placeholder="Additional flags..."
          />
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted">Agent type:</span>
            <div className="flex gap-0.5">
              <button
                type="button"
                title="Claude"
                className={`p-1 rounded ${
                  newAgentType === 'claude'
                    ? 'bg-accent text-accent'
                    : 'bg-surface hover:bg-surface-secondary text-muted'
                }`}
                onClick={() => setNewAgentType('claude')}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
                </svg>
              </button>
              <button
                type="button"
                title="Codex"
                className={`p-1 rounded ${
                  newAgentType === 'codex'
                    ? 'bg-accent text-accent'
                    : 'bg-surface hover:bg-surface-secondary text-muted'
                }`}
                onClick={() => setNewAgentType('codex')}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>
                </svg>
              </button>
            </div>
            <div className="flex-1" />
            <button
              type="button"
              className="btn text-xs"
              onClick={() => setShowAddForm(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary text-xs"
              onClick={handleAddPreset}
              disabled={!newLabel.trim() || !newBaseCommand.trim()}
            >
              Add
            </button>
          </div>
        </div>
      ) : (
        canAddPreset && (
          <button
            type="button"
            className="btn text-xs w-full"
            onClick={() => setShowAddForm(true)}
          >
            + Add Preset
          </button>
        )
      )}
    </div>
  )
}
