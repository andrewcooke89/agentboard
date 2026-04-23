import { Switch } from '../Switch'
import { playPermissionSound, playIdleSound, primeAudio } from '../../utils/sound'
import { requestNotificationPermission, getNotificationPermission, showNotification } from '../../utils/notification'

interface NotificationsSectionProps {
  draftSoundOnPermission: boolean
  setDraftSoundOnPermission: (v: boolean) => void
  draftSoundOnIdle: boolean
  setDraftSoundOnIdle: (v: boolean) => void
  draftNotifyOnPermission: boolean
  setDraftNotifyOnPermission: (v: boolean) => void
  draftNotifyOnIdle: boolean
  setDraftNotifyOnIdle: (v: boolean) => void
}

export default function NotificationsSection({
  draftSoundOnPermission,
  setDraftSoundOnPermission,
  draftSoundOnIdle,
  setDraftSoundOnIdle,
  draftNotifyOnPermission,
  setDraftNotifyOnPermission,
  draftNotifyOnIdle,
  setDraftNotifyOnIdle,
}: NotificationsSectionProps) {
  return (
    <div className="border-t border-border pt-4 space-y-3">
      <label className="mb-1 block text-xs text-secondary">
        Notifications
      </label>
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <div className="text-sm text-primary">Permission Sound</div>
          <div className="text-[10px] text-muted">
            Play a ping when any session needs permission.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void playPermissionSound()}
            className="btn text-xs px-2 py-1"
          >
            Test
          </button>
          <Switch
            checked={draftSoundOnPermission}
            onCheckedChange={(checked) => {
              setDraftSoundOnPermission(checked)
              if (checked) void primeAudio() // Unlock audio on user gesture
            }}
          />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <div className="text-sm text-primary">Idle Sound</div>
          <div className="text-[10px] text-muted">
            Play a chime when a session finishes working.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void playIdleSound()}
            className="btn text-xs px-2 py-1"
          >
            Test
          </button>
          <Switch
            checked={draftSoundOnIdle}
            onCheckedChange={(checked) => {
              setDraftSoundOnIdle(checked)
              if (checked) void primeAudio() // Unlock audio on user gesture
            }}
          />
        </div>
      </div>
      {/* Browser Notifications */}
      <div className="flex items-center justify-between mt-3">
        <div className="flex-1">
          <div className="text-sm text-primary">Permission Notification</div>
          <div className="text-[10px] text-muted">
            Show OS notification when a session needs permission.
            {getNotificationPermission() === 'denied' && (
              <span className="text-danger ml-1">(Blocked in browser settings)</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => showNotification('Agentboard', { body: 'Test notification' })}
            className="btn text-xs px-2 py-1"
          >
            Test
          </button>
          <Switch
            checked={draftNotifyOnPermission}
            onCheckedChange={async (checked) => {
              if (checked) {
                const perm = await requestNotificationPermission()
                if (perm !== 'granted') return
              }
              setDraftNotifyOnPermission(checked)
            }}
          />
        </div>
      </div>
      <div className="flex items-center justify-between mt-3">
        <div className="flex-1">
          <div className="text-sm text-primary">Idle Notification</div>
          <div className="text-[10px] text-muted">
            Show OS notification when a session finishes working.
            {getNotificationPermission() === 'denied' && (
              <span className="text-danger ml-1">(Blocked in browser settings)</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => showNotification('Agentboard', { body: 'Test notification' })}
            className="btn text-xs px-2 py-1"
          >
            Test
          </button>
          <Switch
            checked={draftNotifyOnIdle}
            onCheckedChange={async (checked) => {
              if (checked) {
                const perm = await requestNotificationPermission()
                if (perm !== 'granted') return
              }
              setDraftNotifyOnIdle(checked)
            }}
          />
        </div>
      </div>
    </div>
  )
}
