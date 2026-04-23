import { Switch } from '../Switch'
import type { SessionSortMode, SessionSortDirection } from '../../stores/settingsStore'

type SessionGroupMode = 'none' | 'project'

interface SessionSettingsSectionProps {
  draftSortMode: SessionSortMode
  setDraftSortMode: (v: SessionSortMode) => void
  draftSortDirection: SessionSortDirection
  setDraftSortDirection: (v: SessionSortDirection) => void
  draftSessionGroupMode: SessionGroupMode
  setDraftSessionGroupMode: (v: SessionGroupMode) => void
  draftShowProjectName: boolean
  setDraftShowProjectName: (v: boolean) => void
  draftShowLastUserMessage: boolean
  setDraftShowLastUserMessage: (v: boolean) => void
  draftShowSessionIdPrefix: boolean
  setDraftShowSessionIdPrefix: (v: boolean) => void
}

export default function SessionSettingsSection(props: SessionSettingsSectionProps) {
  const {
    draftSortMode,
    setDraftSortMode,
    draftSortDirection,
    setDraftSortDirection,
    draftSessionGroupMode,
    setDraftSessionGroupMode,
    draftShowProjectName,
    setDraftShowProjectName,
    draftShowLastUserMessage,
    setDraftShowLastUserMessage,
    draftShowSessionIdPrefix,
    setDraftShowSessionIdPrefix,
  } = props

  return (
    <>
      <div className="border-t border-border pt-4">
        <label className="mb-2 block text-xs text-secondary">
          Session List Order
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            className={`btn flex-1 ${draftSortMode === 'created' ? 'btn-primary' : ''}`}
            onClick={() => setDraftSortMode('created')}
          >
            Created
          </button>
          <button
            type="button"
            className={`btn flex-1 ${draftSortMode === 'status' ? 'btn-primary' : ''}`}
            onClick={() => setDraftSortMode('status')}
          >
            Status
          </button>
          <button
            type="button"
            className={`btn flex-1 ${draftSortMode === 'manual' ? 'btn-primary' : ''}`}
            onClick={() => setDraftSortMode('manual')}
          >
            Manual
          </button>
        </div>
        <p className="mt-1.5 text-[10px] text-muted">
          {draftSortMode === 'status'
            ? 'Sessions auto-resort by status (waiting, working, unknown)'
            : draftSortMode === 'manual'
              ? 'Drag sessions to reorder manually'
              : 'Sessions stay in creation order'}
        </p>
        {draftSortMode === 'created' && (
          <div className="mt-3">
            <label className="mb-2 block text-xs text-secondary">
              Sort Direction
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                className={`btn flex-1 ${draftSortDirection === 'desc' ? 'btn-primary' : ''}`}
                onClick={() => setDraftSortDirection('desc')}
              >
                Newest First
              </button>
              <button
                type="button"
                className={`btn flex-1 ${draftSortDirection === 'asc' ? 'btn-primary' : ''}`}
                onClick={() => setDraftSortDirection('asc')}
              >
                Oldest First
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-border pt-4">
        <label className="mb-2 block text-xs text-secondary">
          Group Sessions By
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            className={`btn flex-1 ${draftSessionGroupMode === 'none' ? 'btn-primary' : ''}`}
            onClick={() => setDraftSessionGroupMode('none')}
          >
            None
          </button>
          <button
            type="button"
            className={`btn flex-1 ${draftSessionGroupMode === 'project' ? 'btn-primary' : ''}`}
            onClick={() => setDraftSessionGroupMode('project')}
          >
            Project
          </button>
        </div>
        <p className="mt-1.5 text-[10px] text-muted">
          {draftSessionGroupMode === 'project'
            ? 'Sessions grouped by project folder with collapsible headers'
            : 'Sessions shown as a flat list'}
        </p>
      </div>

      <div className="border-t border-border pt-4 space-y-3">
        <label className="mb-1 block text-xs text-secondary">
          Session List Details
        </label>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">Project Name</div>
            <div className="text-[10px] text-muted">
              Show the project folder name under each session.
            </div>
          </div>
          <Switch
            checked={draftShowProjectName}
            onCheckedChange={setDraftShowProjectName}
          />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">Last User Message</div>
            <div className="text-[10px] text-muted">
              Show the most recent user input next to the project name.
            </div>
          </div>
          <Switch
            checked={draftShowLastUserMessage}
            onCheckedChange={setDraftShowLastUserMessage}
          />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">Session ID Prefix</div>
            <div className="text-[10px] text-muted">
              Show first 5 characters of agent session IDs in the list.
            </div>
          </div>
          <Switch
            checked={draftShowSessionIdPrefix}
            onCheckedChange={setDraftShowSessionIdPrefix}
          />
        </div>
      </div>
    </>
  )
}
