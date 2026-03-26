import React, { useState } from 'react'
import EventLog from './EventLog'
import { EventLogEntry } from '../../shared/dashboardTypes'
import type { SwarmEvent } from '../../shared/swarmTypes'
import { swarmStore } from '../../stores/swarmStore'

function convertToLogEntry(event: SwarmEvent): EventLogEntry {
  const base = {
    id: `${event.groupId}-${event.timestamp}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: event.timestamp,
    groupId: event.groupId,
  }
  
  switch (event.type) {
    case 'group_started':
      return {
        ...base,
        type: 'group_started',
        message: `Group ${event.groupId} started (${event.totalWos} WOs)`,
        severity: 'info'
      }
    case 'wo_status_changed':
      return {
        ...base,
        type: 'wo_started',
        woId: event.woId,
        model: event.model,
        tier: event.tier,
        message: `${event.woId} → ${event.newStatus} (${event.model}, tier ${event.tier})`,
        severity: 'info'
      }
    case 'wo_completed':
      const tokens = event.tokenUsage.inputTokens + event.tokenUsage.outputTokens
      const tokenStr = tokens > 1000 ? `${(tokens / 1000).toFixed(1)}K` : `${tokens}`
      return {
        ...base,
        type: 'wo_completed',
        woId: event.woId,
        message: `${event.woId} completed (${tokenStr} tokens, ${event.durationSeconds.toFixed(0)}s)`,
        severity: 'success'
      }
    case 'wo_failed':
      return {
        ...base,
        type: 'wo_failed',
        woId: event.woId,
        model: event.model,
        tier: event.tier,
        message: `${event.woId} failed: ${event.error.slice(0, 80)}`,
        severity: 'error'
      }
    case 'wo_escalated':
      return {
        ...base,
        type: 'wo_escalated',
        woId: event.woId,
        tier: event.toTier,
        message: `${event.woId} escalated tier ${event.fromTier}→${event.toTier} (${event.toModel})`,
        severity: 'warning'
      }
    case 'group_completed':
      return {
        ...base,
        type: 'group_completed',
        message: `Group ${event.groupId} ${event.status} (${event.completedWos} done, ${event.failedWos} failed, ${event.totalDurationSeconds.toFixed(0)}s)`,
        severity: event.status === 'completed' ? 'success' : 'error'
      }
  }
}

const SwarmView: React.FC = () => {
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  
  // Convert swarm events to log entries
  const logEntries = swarmStore.eventLog.map(convertToLogEntry)

  return (
    <div className="flex flex-col h-full">
      {/* Group tabs if multiple */}
      <div className="border-b border-gray-800 p-2">
        <div className="flex gap-2">
          <button
            className={`px-3 py-1 rounded text-sm ${
              selectedGroupId === null
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
            onClick={() => setSelectedGroupId(null)}
          >
            All Groups
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="border-b border-gray-800 p-2">
        <div className="w-full bg-gray-700 rounded h-2">
          <div
            className="bg-blue-500 h-2 rounded"
            style={{ width: '0%' }}
          />
        </div>
      </div>

      {/* Main content: DAG + Detail - flex-1 */}
      <div className="flex flex-1 min-h-0">
        <div className="w-1/2 border-r border-gray-800 p-4">
          <h3 className="text-sm font-semibold text-gray-400 mb-2">DAG Graph</h3>
          <div className="bg-gray-800 rounded p-4 h-full">
            <p className="text-gray-500 text-sm">DAG visualization placeholder</p>
          </div>
        </div>
        <div className="w-1/2 p-4">
          <h3 className="text-sm font-semibold text-gray-400 mb-2">Work Order Detail</h3>
          <div className="bg-gray-800 rounded p-4 h-full">
            <p className="text-gray-500 text-sm">Select a work order to view details</p>
          </div>
        </div>
      </div>

      {/* Event log at bottom */}
      <div className="border-t border-gray-800">
        <EventLog events={logEntries} maxHeight="200px" />
      </div>
    </div>
  )
}

export default SwarmView
