import React from 'react'
import { EventLogEntry } from '../../shared/dashboardTypes'

interface EventLogProps {
  events: EventLogEntry[]
  maxHeight?: string
}

const EventLog: React.FC<EventLogProps> = ({ events, maxHeight = '200px' }) => {
  const getSeverityColor = (severity: EventLogEntry['severity']) => {
    switch (severity) {
      case 'success':
        return 'text-green-400'
      case 'warning':
        return 'text-yellow-400'
      case 'error':
        return 'text-red-400'
      default:
        return 'text-gray-300'
    }
  }

  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp)
    return date.toLocaleTimeString()
  }

  return (
    <div 
      className="overflow-y-auto bg-gray-900 p-2"
      style={{ maxHeight }}
    >
      {events.length === 0 ? (
        <div className="text-gray-500 text-sm text-center py-2">
          No events yet
        </div>
      ) : (
        <div className="space-y-1">
          {events.map((event) => (
            <div
              key={event.id}
              className="flex items-start gap-2 text-xs font-mono"
            >
              <span className="text-gray-500 shrink-0">
                {formatTimestamp(event.timestamp)}
              </span>
              <span className={`${getSeverityColor(event.severity)} shrink-0`}>
                [{event.severity.toUpperCase()}]
              </span>
              <span className="text-gray-300">
                {event.message}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default EventLog
