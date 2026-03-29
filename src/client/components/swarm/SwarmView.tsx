import { useEffect } from 'react'
import { useSwarmStore } from '../../stores/swarmStore'
import DagGraph from './DagGraph'
import GroupProgress from './GroupProgress'
import WoDetail from './WoDetail'
import EventLog from './EventLog'
import type { EventLogEntry, BaseEventLogEntry, EventSeverity } from '../../shared/dashboardTypes'
import type { SwarmEvent } from '../../../shared/swarmTypes'

export function convertToLogEntry(event: SwarmEvent): EventLogEntry {
  const base: Omit<BaseEventLogEntry, 'type' | 'message' | 'severity'> = {
    id: `${event.groupId}-${event.timestamp}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: Number(event.timestamp),
    groupId: event.groupId,
  }

  switch (event.type) {
    case 'group_started':
      return { ...base, type: 'group_started', message: `Group ${event.groupId} started (${event.totalWos} WOs)`, severity: 'info' }
    case 'wo_status_changed':
      return { ...base, type: 'wo_started', woId: event.woId, model: event.model, tier: event.tier, message: `${event.woId} → ${event.newStatus} (${event.model}, tier ${event.tier})`, severity: 'info' }
    case 'wo_completed': {
      const tokens = event.tokenUsage.inputTokens + event.tokenUsage.outputTokens
      const tokenStr = tokens > 1000 ? `${(tokens / 1000).toFixed(1)}K` : `${tokens}`
      return { ...base, type: 'wo_completed', woId: event.woId, message: `${event.woId} completed (${tokenStr} tokens, ${event.durationSeconds.toFixed(0)}s)`, severity: 'success' }
    }
    case 'wo_failed':
      return { ...base, type: 'wo_failed', woId: event.woId, model: event.model, tier: event.tier, message: `${event.woId} failed: ${event.error.slice(0, 80)}`, severity: 'error' }
    case 'wo_escalated':
      return { ...base, type: 'wo_escalated', woId: event.woId, tier: event.toTier, message: `${event.woId} escalated tier ${event.fromTier}→${event.toTier} (${event.toModel})`, severity: 'warning' }
    case 'group_completed': {
      const severity: 'success' | 'error' = event.status === 'completed' ? 'success' : 'error'
      return { ...base, type: 'group_completed', message: `Group ${event.groupId} ${event.status} (${event.completedWos} done, ${event.failedWos} failed, ${event.totalDurationSeconds.toFixed(0)}s)`, severity }
    }
  }
}

export default function SwarmView() {
  const fetchGroups = useSwarmStore((s) => s.fetchGroups)
  useEffect(() => { void fetchGroups() }, [fetchGroups])

  const groups = useSwarmStore((s) => s.groups)
  const selectedGroupId = useSwarmStore((s) => s.selectedGroupId)
  const selectedWoId = useSwarmStore((s) => s.selectedWoId)
  const selectGroup = useSwarmStore((s) => s.selectGroup)
  const selectWo = useSwarmStore((s) => s.selectWo)
  const eventLog = useSwarmStore((s) => s.eventLog)

  const selectedGroup = groups.find(g => g.groupId === selectedGroupId) || groups[0] || null
  const selectedWo = selectedGroup && selectedWoId
    ? selectedGroup.wos[selectedWoId] || null
    : null

  const logEntries = eventLog.map(convertToLogEntry)

  return (
    <div className="flex flex-col h-full bg-[#0a0a1a]">
      {/* Group selector tabs */}
      {groups.length > 1 && (
        <div className="flex gap-1 px-4 pt-2 border-b border-gray-800">
          {groups.map(g => (
            <button
              key={g.groupId}
              onClick={() => selectGroup(g.groupId)}
              className={`px-3 py-1 text-xs rounded-t ${
                g.groupId === (selectedGroupId || groups[0]?.groupId)
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {g.groupId}
            </button>
          ))}
        </div>
      )}

      {/* Progress bar */}
      <div className="px-4 py-2 border-b border-gray-800">
        <GroupProgress group={selectedGroup} />
      </div>

      {/* Main content: DAG + Detail */}
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 overflow-auto">
          {selectedGroup ? (
            <DagGraph
              wos={selectedGroup.wos}
              edges={selectedGroup.edges}
              selectedWoId={selectedWoId}
              onSelectWo={selectWo}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-600">
              No active swarm
            </div>
          )}
        </div>
        <div className="w-80 border-l border-gray-800 overflow-auto">
          <WoDetail wo={selectedWo} />
        </div>
      </div>

      {/* Event log at bottom */}
      <div className="border-t border-gray-800">
        <EventLog events={logEntries} maxHeight="200px" />
      </div>
    </div>
  )
}
