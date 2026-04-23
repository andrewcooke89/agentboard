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

export default function CronSettingsSection({
  draftCronPollInterval,
  setDraftCronPollInterval,
  draftCronAvatarStyle,
  setDraftCronAvatarStyle,
  draftCronSudoGracePeriod,
  setDraftCronSudoGracePeriod,
  draftCronShowSystemJobs,
  setDraftCronShowSystemJobs,
  draftCronShowUserJobs,
  setDraftCronShowUserJobs,
  draftCronDefaultTimelineVisible,
  setDraftCronDefaultTimelineVisible,
  draftCronDefaultTimelineRange,
  setDraftCronDefaultTimelineRange,
  draftCronNotifyFailure,
  setDraftCronNotifyFailure,
  draftCronNotifyMissedRun,
  setDraftCronNotifyMissedRun,
  draftCronNotifyManualRun,
  setDraftCronNotifyManualRun,
  draftCronDesktopNotifications,
  setDraftCronDesktopNotifications,
  draftCronAutoTagSuggestions,
  setDraftCronAutoTagSuggestions,
  draftCronMaxHistoryDays,
  setDraftCronMaxHistoryDays,
  draftCronMaxHistoryPerJob,
  setDraftCronMaxHistoryPerJob,
}: CronSettingsSectionProps) {
  return (
    <div className="border-t border-border pt-4 space-y-3">
      <label className="mb-1 block text-xs text-secondary">Cron Manager</label>

      {/* Poll Interval */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Poll Interval</div>
          <div className="text-[10px] text-muted">
            How often to refresh cron job status (seconds).
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={300}
            value={draftCronPollInterval}
            onChange={(e) => setDraftCronPollInterval(e.target.valueAsNumber || 5)}
            className="input text-xs w-16 text-center"
          />
          <span className="text-[10px] text-muted">sec</span>
        </div>
      </div>

      {/* Avatar Style */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Avatar Style</div>
          <div className="text-[10px] text-muted">
            Visual style for job avatars.
          </div>
        </div>
        <select
          value={draftCronAvatarStyle}
          onChange={(e) => setDraftCronAvatarStyle(e.target.value)}
          className="input text-xs py-1 px-2 w-auto"
        >
          {['bottts', 'identicon', 'thumbs', 'avataaars', 'micah', 'pixel-art'].map((style) => (
            <option key={style} value={style}>
              {style}
            </option>
          ))}
        </select>
      </div>

      {/* Sudo Grace Period */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Sudo Grace Period</div>
          <div className="text-[10px] text-muted">
            Seconds before a sudo-privileged job requires re-auth.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            max={3600}
            value={draftCronSudoGracePeriod}
            onChange={(e) => setDraftCronSudoGracePeriod(e.target.valueAsNumber || 300)}
            className="input text-xs w-20 text-center"
          />
          <span className="text-[10px] text-muted">sec</span>
        </div>
      </div>

      {/* Show System Jobs */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Show System Jobs</div>
          <div className="text-[10px] text-muted">
            Display system-level cron jobs (/etc/crontab).
          </div>
        </div>
        <Switch
          checked={draftCronShowSystemJobs}
          onCheckedChange={setDraftCronShowSystemJobs}
        />
      </div>

      {/* Show User Jobs */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Show User Jobs</div>
          <div className="text-[10px] text-muted">
            Display user-level crontab entries.
          </div>
        </div>
        <Switch
          checked={draftCronShowUserJobs}
          onCheckedChange={setDraftCronShowUserJobs}
        />
      </div>

      {/* Default Timeline Visible */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Timeline Visible</div>
          <div className="text-[10px] text-muted">
            Show the execution timeline by default.
          </div>
        </div>
        <Switch
          checked={draftCronDefaultTimelineVisible}
          onCheckedChange={setDraftCronDefaultTimelineVisible}
        />
      </div>

      {/* Default Timeline Range */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Timeline Range</div>
          <div className="text-[10px] text-muted">
            Default time window shown in the timeline.
          </div>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            className={`btn text-xs px-2 ${draftCronDefaultTimelineRange === '24h' ? 'btn-primary' : ''}`}
            onClick={() => setDraftCronDefaultTimelineRange('24h')}
          >
            24h
          </button>
          <button
            type="button"
            className={`btn text-xs px-2 ${draftCronDefaultTimelineRange === '7d' ? 'btn-primary' : ''}`}
            onClick={() => setDraftCronDefaultTimelineRange('7d')}
          >
            7d
          </button>
        </div>
      </div>

      {/* Notify on Failure */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Notify on Failure</div>
          <div className="text-[10px] text-muted">
            Alert when a cron job exits with a non-zero code.
          </div>
        </div>
        <Switch
          checked={draftCronNotifyFailure}
          onCheckedChange={setDraftCronNotifyFailure}
        />
      </div>

      {/* Notify on Missed Run */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Notify on Missed Run</div>
          <div className="text-[10px] text-muted">
            Alert when a scheduled execution is skipped.
          </div>
        </div>
        <Switch
          checked={draftCronNotifyMissedRun}
          onCheckedChange={setDraftCronNotifyMissedRun}
        />
      </div>

      {/* Notify on Manual Run */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Notify on Manual Run</div>
          <div className="text-[10px] text-muted">
            Alert when a job is manually triggered.
          </div>
        </div>
        <Switch
          checked={draftCronNotifyManualRun}
          onCheckedChange={setDraftCronNotifyManualRun}
        />
      </div>

      {/* Desktop Notifications */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Desktop Notifications</div>
          <div className="text-[10px] text-muted">
            Show OS-level notifications for cron events.
          </div>
        </div>
        <Switch
          checked={draftCronDesktopNotifications}
          onCheckedChange={async (checked) => {
            if (checked) {
              const perm = await requestNotificationPermission()
              if (perm !== 'granted') return
            }
            setDraftCronDesktopNotifications(checked)
          }}
        />
      </div>

      {/* Auto Tag Suggestions */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Auto Tag Suggestions</div>
          <div className="text-[10px] text-muted">
            Automatically suggest tags for new cron jobs.
          </div>
        </div>
        <Switch
          checked={draftCronAutoTagSuggestions}
          onCheckedChange={setDraftCronAutoTagSuggestions}
        />
      </div>

      {/* Max History Days */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Max History Days</div>
          <div className="text-[10px] text-muted">
            Retain execution history for this many days.
          </div>
        </div>
        <input
          type="number"
          min={1}
          max={365}
          value={draftCronMaxHistoryDays}
          onChange={(e) => setDraftCronMaxHistoryDays(e.target.valueAsNumber || 90)}
          className="input text-xs w-16 text-center"
        />
      </div>

      {/* Max History Per Job */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">Max History Per Job</div>
          <div className="text-[10px] text-muted">
            Maximum execution records kept per job.
          </div>
        </div>
        <input
          type="number"
          min={10}
          max={10000}
          value={draftCronMaxHistoryPerJob}
          onChange={(e) => setDraftCronMaxHistoryPerJob(e.target.valueAsNumber || 500)}
          className="input text-xs w-20 text-center"
        />
      </div>
    </div>
  )
}
