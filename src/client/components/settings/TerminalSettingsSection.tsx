import { Switch } from '../Switch'
import { FONT_OPTIONS, type FontOption } from '../../stores/settingsStore'
import type { Theme } from '../../stores/themeStore'

interface TerminalSettingsSectionProps {
  draftUseWebGL: boolean
  setDraftUseWebGL: (v: boolean) => void
  useWebGL: boolean
  draftFontSize: number
  setDraftFontSize: (v: number) => void
  draftLineHeight: number
  setDraftLineHeight: (v: number) => void
  draftLetterSpacing: number
  setDraftLetterSpacing: (v: number) => void
  draftFontOption: FontOption
  setDraftFontOption: (v: FontOption) => void
  draftCustomFontFamily: string
  setDraftCustomFontFamily: (v: string) => void
  draftTheme: Theme
  setDraftTheme: (v: Theme) => void
}

function FontSizeControl({ draftFontSize, setDraftFontSize }: { draftFontSize: number; setDraftFontSize: (v: number) => void }) {
  return (
    <div className="mt-4 flex items-center justify-between">
      <div>
        <div className="text-sm text-primary">Font Size</div>
        <div className="text-[10px] text-muted">
          Terminal text size in pixels (6-24)
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setDraftFontSize(Math.max(6, draftFontSize - 1))}
          className="flex h-7 w-7 items-center justify-center rounded bg-surface border border-border text-secondary hover:bg-hover"
        >
          <span className="text-sm font-bold">−</span>
        </button>
        <span className="text-sm text-secondary w-6 text-center">{draftFontSize}</span>
        <button
          type="button"
          onClick={() => setDraftFontSize(Math.min(24, draftFontSize + 1))}
          className="flex h-7 w-7 items-center justify-center rounded bg-surface border border-border text-secondary hover:bg-hover"
        >
          <span className="text-sm font-bold">+</span>
        </button>
      </div>
    </div>
  )
}

export default function TerminalSettingsSection({
  draftUseWebGL,
  setDraftUseWebGL,
  useWebGL,
  draftFontSize,
  setDraftFontSize,
  draftLineHeight,
  setDraftLineHeight,
  draftLetterSpacing,
  setDraftLetterSpacing,
  draftFontOption,
  setDraftFontOption,
  draftCustomFontFamily,
  setDraftCustomFontFamily,
  draftTheme,
  setDraftTheme,
}: TerminalSettingsSectionProps) {
  return (
    <div className="border-t border-border pt-4">
      <label className="mb-2 block text-xs text-secondary">
        Terminal Rendering
      </label>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">WebGL Acceleration</div>
          <div className="text-[10px] text-muted">
            GPU rendering for better performance. Disable if you see flickering.
          </div>
        </div>
        <Switch
          checked={draftUseWebGL}
          onCheckedChange={setDraftUseWebGL}
        />
      </div>
      {draftUseWebGL !== useWebGL && (
        <p className="mt-2 text-[10px] text-approval">
          Terminal will reload when saved
        </p>
      )}

      <FontSizeControl draftFontSize={draftFontSize} setDraftFontSize={setDraftFontSize} />

      <div className="mt-4 flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Line Height</div>
          <div className="text-[10px] text-muted">
            Vertical spacing (1.0 = compact, 2.0 = spacious)
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min="1.0"
            max="2.0"
            step="0.1"
            value={draftLineHeight}
            onChange={(e) => setDraftLineHeight(parseFloat(e.target.value))}
            className="w-20 h-1 bg-border rounded-lg appearance-none cursor-pointer accent-accent"
          />
          <span className="text-xs text-secondary w-8 text-right">{draftLineHeight.toFixed(1)}</span>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Letter Spacing</div>
          <div className="text-[10px] text-muted">
            Horizontal spacing between characters in pixels
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min="-3"
            max="3"
            step="1"
            value={draftLetterSpacing}
            onChange={(e) => setDraftLetterSpacing(parseInt(e.target.value, 10))}
            className="w-20 h-1 bg-border rounded-lg appearance-none cursor-pointer accent-accent"
          />
          <span className="text-xs text-secondary w-8 text-right">{draftLetterSpacing}px</span>
        </div>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">Font Family</div>
            <div className="text-[10px] text-muted">
              Terminal typeface
            </div>
          </div>
          <select
            value={draftFontOption}
            onChange={(e) => setDraftFontOption(e.target.value as FontOption)}
            className="input text-xs py-1 px-2 w-auto"
          >
            {FONT_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        {draftFontOption === 'custom' && (
          <input
            value={draftCustomFontFamily}
            onChange={(e) => setDraftCustomFontFamily(e.target.value)}
            placeholder='"Fira Code", monospace'
            className="input text-xs mt-2 font-mono"
          />
        )}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Dark Mode</div>
          <div className="text-[10px] text-muted">
            Switch between dark and light themes.
          </div>
        </div>
        <Switch
          checked={draftTheme === 'dark'}
          onCheckedChange={(checked) => setDraftTheme(checked ? 'dark' : 'light')}
        />
      </div>
    </div>
  )
}
