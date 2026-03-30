import { Switch } from '../Switch'
import { requestNotificationPermission } from '../../utils/notification'

interface CronSettingsSectionProps {
  draftCronPollInterval: number
  setDraftCronPollInterval: (v: number) => void
  draftCronAvatarStyle: string
  setDraftCronAvatarStyle: (v: string) => void
  draftCronSudoGracePeriod: number
  setDraftCronSudoGracePeriod: (v: number) => void
  draftCronShowSystemJobs: boolean
  setDraftCronShowSystemJobs: (v: boolean) => void
  draftCronShowUserJobs: boolean
  setDraftCronShowUserJobs: (v: boolean) => void
  draftCronDefaultTimelineVisible: boolean
  setDraftCronDefaultTimelineVisible: (v: boolean) => void
  draftCronDefaultTimelineRange: '24h' | '7d'
  setDraftCronDefaultTimelineRange: (v: '24h' | '7d') => void
  draftCronNotifyFailure: boolean
  setDraftCronNotifyFailure: (v: boolean) => void
  draftCronNotifyMissedRun: boolean
  setDraftCronNotifyMissedRun: (v: boolean) => void
  draftCronNotifyManualRun: boolean
  setDraftCronNotifyManualRun: (v: boolean) => void
  draftCronDesktopNotifications: boolean
  setDraftCronDesktopNotifications: (v: boolean) => void
  draftCronAutoTagSuggestions: boolean
  setDraftCronAutoTagSuggestions: (v: boolean) => void
  draftCronMaxHistoryDays: number
  setDraftCronMaxHistoryDays: (v: number) => void
  draftCronMaxHistoryPerJob: number
  setDraftCronMaxHistoryPerJob: (v: number) => void
}

function SliderRow({ label, hint, value, min, max, step, unit, w, onChange }: {
  label: string; hint: string; value: number; min: number; max: number; step: number; unit: string; w: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <div className="text-sm text-primary">{label}</div>
        <div className="text-[10px] text-muted">{hint}</div>
      </div>
      <div className="flex items-center gap-2">
        <input type="range" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
          className="w-20 h-1 bg-border rounded-lg appearance-none cursor-pointer accent-accent" />
        <span className={`text-xs text-secondary ${w} text-right`}>{value}{unit}</span>
      </div>
    </div>
  )
}

function ToggleRow({ label, hint, checked, onCheckedChange }: {
  label: string; hint: string; checked: boolean; onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <div className="text-sm text-primary">{label}</div>
        <div className="text-[10px] text-muted">{hint}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

export default function CronSettingsSection({
  draftCronPollInterval, setDraftCronPollInterval,
  draftCronAvatarStyle, setDraftCronAvatarStyle,
  draftCronSudoGracePeriod, setDraftCronSudoGracePeriod,
  draftCronShowSystemJobs, setDraftCronShowSystemJobs,
  draftCronShowUserJobs, setDraftCronShowUserJobs,
  draftCronDefaultTimelineVisible, setDraftCronDefaultTimelineVisible,
  draftCronDefaultTimelineRange, setDraftCronDefaultTimelineRange,
  draftCronNotifyFailure, setDraftCronNotifyFailure,
  draftCronNotifyMissedRun, setDraftCronNotifyMissedRun,
  draftCronNotifyManualRun, setDraftCronNotifyManualRun,
  draftCronDesktopNotifications, setDraftCronDesktopNotifications,
  draftCronAutoTagSuggestions, setDraftCronAutoTagSuggestions,
  draftCronMaxHistoryDays, setDraftCronMaxHistoryDays,
  draftCronMaxHistoryPerJob, setDraftCronMaxHistoryPerJob,
}: CronSettingsSectionProps) {
  return (
    <div className="border-t border-border pt-4 space-y-3">
      <label className="mb-1 block text-xs text-secondary">Cron Manager</label>

      <SliderRow label="Poll Interval" hint="How often to refresh job status (2–30s)"
        value={draftCronPollInterval} min={2} max={30} step={1} unit="s" w="w-8"
        onChange={setDraftCronPollInterval} />

      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Avatar Style</div>
          <div className="text-[10px] text-muted">Dicebear style for job avatars</div>
        </div>
        <select value={draftCronAvatarStyle} onChange={(e) => setDraftCronAvatarStyle(e.target.value)}
          className="input text-xs py-1 px-2 w-auto">
          {['bottts', 'identicon', 'thumbs', 'avataaars', 'micah', 'pixel-art'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      <SliderRow label="Sudo Grace Period" hint="How long sudo credentials are cached (seconds)"
        value={draftCronSudoGracePeriod} min={60} max={3600} step={60} unit="s" w="w-12"
        onChange={setDraftCronSudoGracePeriod} />

      <ToggleRow label="Show System Jobs" hint="Include system-level cron jobs"
        checked={draftCronShowSystemJobs} onCheckedChange={setDraftCronShowSystemJobs} />
      <ToggleRow label="Show User Jobs" hint="Include user-level cron jobs"
        checked={draftCronShowUserJobs} onCheckedChange={setDraftCronShowUserJobs} />
      <ToggleRow label="Timeline Visible by Default" hint="Show schedule timeline on open"
        checked={draftCronDefaultTimelineVisible} onCheckedChange={setDraftCronDefaultTimelineVisible} />

      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Default Timeline Range</div>
          <div className="text-[10px] text-muted">24h view or 7-day view</div>
        </div>
        <div className="flex gap-1">
          {(['24h', '7d'] as const).map((r) => (
            <button key={r} type="button" onClick={() => setDraftCronDefaultTimelineRange(r)}
              className={`btn text-xs px-2 py-0.5 ${draftCronDefaultTimelineRange === r ? 'btn-primary' : ''}`}>
              {r}
            </button>
          ))}
        </div>
      </div>

      <ToggleRow label="Notify on Failure" hint="Alert when a cron job fails"
        checked={draftCronNotifyFailure} onCheckedChange={setDraftCronNotifyFailure} />
      <ToggleRow label="Notify on Missed Run" hint="Alert when a scheduled run is missed"
        checked={draftCronNotifyMissedRun} onCheckedChange={setDraftCronNotifyMissedRun} />
      <ToggleRow label="Notify on Manual Run" hint="Alert when a manually triggered run completes"
        checked={draftCronNotifyManualRun} onCheckedChange={setDraftCronNotifyManualRun} />

      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Desktop Notifications</div>
          <div className="text-[10px] text-muted">
            Show OS notifications for cron events (max 1 per job per 5 min)
            {typeof Notification !== 'undefined' && Notification.permission === 'denied' && (
              <span className="text-danger ml-1">(Blocked in browser settings)</span>
            )}
          </div>
        </div>
        <Switch checked={draftCronDesktopNotifications}
          onCheckedChange={async (checked) => {
            if (checked && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
              const perm = await requestNotificationPermission()
              if (perm !== 'granted') return
            }
            setDraftCronDesktopNotifications(checked)
          }} />
      </div>

      <ToggleRow label="Auto-tag Suggestions" hint="Suggest tags based on command patterns"
        checked={draftCronAutoTagSuggestions} onCheckedChange={setDraftCronAutoTagSuggestions} />

      <SliderRow label="Max History Days" hint="How many days of run history to retain"
        value={draftCronMaxHistoryDays} min={7} max={365} step={7} unit="d" w="w-10"
        onChange={setDraftCronMaxHistoryDays} />
      <SliderRow label="Max History Per Job" hint="Maximum run history entries per job"
        value={draftCronMaxHistoryPerJob} min={50} max={2000} step={50} unit="" w="w-12"
        onChange={setDraftCronMaxHistoryPerJob} />
    </div>
  )
}
