import { Switch } from '../Switch'
import { FONT_OPTIONS } from '../../stores/settingsStore'
import type { FontOption, ShortcutModifier } from '../../stores/settingsStore'
import type { Theme } from '../../stores/themeStore'
import { getEffectiveModifier, getModifierDisplay } from '../../utils/device'
import { cn } from '../../utils/cn'

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
  draftShortcutModifier: ShortcutModifier | 'auto'
  setDraftShortcutModifier: (v: ShortcutModifier | 'auto') => void
}

const SHORTCUT_MODIFIERS: (ShortcutModifier | 'auto')[] = [
  'auto',
  'ctrl-option',
  'ctrl-shift',
  'cmd-option',
  'cmd-shift',
]

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
  draftShortcutModifier,
  setDraftShortcutModifier,
}: TerminalSettingsSectionProps) {
  return (
    <>
      {/* Terminal Rendering */}
      <div className="border-t border-border pt-4 space-y-3">
        <label className="mb-1 block text-xs text-secondary">Terminal Rendering</label>

        {/* WebGL Acceleration */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">WebGL Acceleration</div>
            <div className="text-[10px] text-muted">
              Use WebGL for terminal rendering.
            </div>
            {draftUseWebGL !== useWebGL && (
              <div className="text-[10px] text-yellow-500 mt-0.5">
                Terminal will reload when saved
              </div>
            )}
          </div>
          <Switch
            checked={draftUseWebGL}
            onCheckedChange={setDraftUseWebGL}
          />
        </div>

        {/* Font Size */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">Font Size</div>
            <div className="text-[10px] text-muted">
              Terminal font size (6–24).
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn text-xs px-2"
              onClick={() => setDraftFontSize(Math.max(6, draftFontSize - 1))}
            >
              −
            </button>
            <span className="text-xs text-primary w-6 text-center">{draftFontSize}</span>
            <button
              type="button"
              className="btn text-xs px-2"
              onClick={() => setDraftFontSize(Math.min(24, draftFontSize + 1))}
            >
              +
            </button>
          </div>
        </div>

        {/* Line Height */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">Line Height</div>
            <div className="text-[10px] text-muted">
              Terminal line height.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={1.0}
              max={2.0}
              step={0.1}
              value={draftLineHeight}
              onChange={(e) => setDraftLineHeight(Number(e.target.value))}
              className="w-24"
            />
            <span className="text-xs text-primary w-8 text-right">{draftLineHeight.toFixed(1)}</span>
          </div>
        </div>

        {/* Letter Spacing */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">Letter Spacing</div>
            <div className="text-[10px] text-muted">
              Terminal letter spacing.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={-3}
              max={3}
              step={1}
              value={draftLetterSpacing}
              onChange={(e) => setDraftLetterSpacing(Number(e.target.value))}
              className="w-24"
            />
            <span className="text-xs text-primary w-8 text-right">{draftLetterSpacing}px</span>
          </div>
        </div>

        {/* Font Family */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">Font Family</div>
            <div className="text-[10px] text-muted">
              Terminal font family.
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

        {/* Custom Font Input */}
        {draftFontOption === 'custom' && (
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-primary">Custom Font</div>
              <div className="text-[10px] text-muted">
                CSS font-family string for custom font.
              </div>
            </div>
            <input
              type="text"
              value={draftCustomFontFamily}
              onChange={(e) => setDraftCustomFontFamily(e.target.value)}
              placeholder="'My Font', monospace"
              className="input text-xs py-1 px-2 w-40"
            />
          </div>
        )}

        {/* Dark Mode */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">Dark Mode</div>
            <div className="text-[10px] text-muted">
              Use dark terminal theme.
            </div>
          </div>
          <Switch
            checked={draftTheme === 'dark'}
            onCheckedChange={(checked) => setDraftTheme(checked ? 'dark' : 'light')}
          />
        </div>
      </div>

      {/* Keyboard Shortcut Modifier */}
      <div className="border-t border-border pt-4 space-y-3">
        <label className="mb-1 block text-xs text-secondary">Keyboard Shortcut Modifier</label>

        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">Navigation Modifier</div>
            <div className="text-[10px] text-muted">
              Modifier combo for session navigation shortcuts.
            </div>
          </div>
          <div className="grid grid-cols-5 gap-2">
            {SHORTCUT_MODIFIERS.map((mod) => (
              <button
                key={mod}
                type="button"
                className={cn('btn text-xs px-2', draftShortcutModifier === mod && 'btn-primary')}
                onClick={() => setDraftShortcutModifier(mod)}
              >
                {mod === 'auto' ? 'Auto' : getModifierDisplay(mod)}
              </button>
            ))}
          </div>
        </div>

        <div className="text-[10px] text-muted">
          {draftShortcutModifier === 'auto'
            ? `Platform default: ${getModifierDisplay(getEffectiveModifier('auto'))}`
            : `Current: ${getModifierDisplay(draftShortcutModifier)} (${getEffectiveModifier(draftShortcutModifier)})`
          }
        </div>
      </div>
    </>
  )
}
