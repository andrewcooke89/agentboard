import { Switch } from '../Switch'
import type { CommandPreset } from '../../stores/settingsStore'
import { MAX_PRESETS } from '../../stores/settingsStore'

interface CommandPresetsSectionProps {
  draftPresets: CommandPreset[]
  draftDefaultPresetId: string
  setDraftDefaultPresetId: (v: string) => void
  handleUpdatePreset: (presetId: string, updates: Partial<CommandPreset>) => void
  handleDeletePreset: (presetId: string) => void
  handleAddPreset: () => void
  canAddPreset: boolean
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

interface PresetCardProps {
  preset: CommandPreset
  handleUpdatePreset: (presetId: string, updates: Partial<CommandPreset>) => void
  handleDeletePreset: (presetId: string) => void
}

function PresetCard({ preset, handleUpdatePreset, handleDeletePreset }: PresetCardProps) {
  return (
    <div
      key={preset.id}
      className="border border-border p-3 space-y-2"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {preset.isBuiltIn && (
            <span className="text-[10px] text-muted">🔒</span>
          )}
          <input
            value={preset.label}
            onChange={(e) => handleUpdatePreset(preset.id, { label: e.target.value })}
            className="input text-sm py-1 px-2 w-32"
            placeholder="Label"
          />
        </div>
        {!preset.isBuiltIn && (
          <button
            type="button"
            onClick={() => handleDeletePreset(preset.id)}
            className="btn text-xs px-2 py-1 text-error hover:bg-error/10"
          >
            Delete
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[10px] text-muted block mb-1">Base Command</label>
          <input
            value={preset.baseCommand}
            onChange={(e) => handleUpdatePreset(preset.id, { baseCommand: e.target.value })}
            className="input text-xs py-1 px-2 font-mono"
            placeholder="command"
            disabled={preset.isBuiltIn}
          />
        </div>
        <div>
          <label className="text-[10px] text-muted block mb-1">Modifiers</label>
          <input
            value={preset.modifiers}
            onChange={(e) => handleUpdatePreset(preset.id, { modifiers: e.target.value })}
            className="input text-xs py-1 px-2 font-mono"
            placeholder="--flag value"
          />
        </div>
      </div>

      {!preset.isBuiltIn && (
        <div>
          <label className="text-[10px] text-muted block mb-1">Icon</label>
          <select
            value={preset.agentType || ''}
            onChange={(e) => handleUpdatePreset(preset.id, {
              agentType: e.target.value as 'claude' | 'codex' | undefined || undefined
            })}
            className="input text-xs py-1 px-2 w-auto"
          >
            <option value="">Terminal</option>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        </div>
      )}
    </div>
  )
}

interface AddPresetFormProps {
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
  handleAddPreset: () => void
  canAddPreset: boolean
}

function AddPresetForm({
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
  handleAddPreset,
  canAddPreset,
}: AddPresetFormProps) {
  if (showAddForm) {
    return (
      <div className="mt-3 border border-border p-3 space-y-2">
        <div className="text-xs text-secondary mb-2">New Preset</div>
        <div className="grid grid-cols-2 gap-2">
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            className="input text-xs py-1 px-2"
            placeholder="Label"
          />
          <input
            value={newBaseCommand}
            onChange={(e) => setNewBaseCommand(e.target.value)}
            className="input text-xs py-1 px-2 font-mono"
            placeholder="command"
          />
        </div>
        <input
          value={newModifiers}
          onChange={(e) => setNewModifiers(e.target.value)}
          className="input text-xs py-1 px-2 font-mono w-full"
          placeholder="Modifiers (optional)"
        />
        <div className="flex items-center gap-2">
          <select
            value={newAgentType}
            onChange={(e) => setNewAgentType(e.target.value as 'claude' | 'codex' | '')}
            className="input text-xs py-1 px-2 w-auto"
          >
            <option value="">Terminal Icon</option>
            <option value="claude">Claude Icon</option>
            <option value="codex">Codex Icon</option>
          </select>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => setShowAddForm(false)}
            className="btn text-xs px-2 py-1"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleAddPreset}
            disabled={!newLabel.trim() || !newBaseCommand.trim()}
            className="btn btn-primary text-xs px-2 py-1"
          >
            Add
          </button>
        </div>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setShowAddForm(true)}
      disabled={!canAddPreset}
      className="btn text-xs mt-3 w-full"
    >
      {canAddPreset ? '+ Add Preset' : `Max ${MAX_PRESETS} presets`}
    </button>
  )
}

export default function CommandPresetsSection({
  draftPresets,
  draftDefaultPresetId,
  setDraftDefaultPresetId,
  handleUpdatePreset,
  handleDeletePreset,
  handleAddPreset,
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
}: CommandPresetsSectionProps) {
  return (
    <div className="border-t border-border pt-4">
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs text-secondary">
          Command Presets
        </label>
        <select
          value={draftDefaultPresetId}
          onChange={(e) => setDraftDefaultPresetId(e.target.value)}
          className="input text-xs py-1 px-2 w-auto"
        >
          {draftPresets.map(p => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </div>
      <p className="text-[10px] text-muted mb-3">
        Default preset is pre-selected when creating new sessions.
      </p>

      <div className="space-y-3">
        {draftPresets.map(preset => (
          <PresetCard
            key={preset.id}
            preset={preset}
            handleUpdatePreset={handleUpdatePreset}
            handleDeletePreset={handleDeletePreset}
          />
        ))}
      </div>

      <AddPresetForm
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
        handleAddPreset={handleAddPreset}
        canAddPreset={canAddPreset}
      />
    </div>
  )
}
