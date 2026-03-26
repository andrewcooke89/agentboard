import React, { useEffect, useRef } from 'react'
import { EventLogEntry } from '../../shared/dashboardTypes'

interface EventLogProps {
  events: EventLogEntry[]
  maxHeight?: string  // default '300px'
}

const EventLog: React.FC<EventLogProps> = ({ events, maxHeight = '300px' }) => {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current && events.length > 0) {
      scrollRef.current.scrollTop = 0
    }
  }, [events.length])

  const getSeverityColor = (severity: EventLogEntry['severity']) => {
    switch (severity) {
      case 'info':
        return 'bg-blue-500'
      case 'success':
        return 'bg-green-500'
      case 'warning':
        return 'bg-amber-500'
      case 'error':
        return 'bg-red-500'
      default:
        return 'bg-gray-500'
    }
  }

  const formatTime = (timestamp: string | Date) => {
    const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp
    return date.toLocaleTimeString('en-US', { 
      hour12: false, 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit' 
    })
  }

  return (
    <div className="bg-gray-900/50 rounded-lg" style={{ maxHeight, overflowY: 'auto' }} ref={scrollRef}>
      <div className="sticky top-0 bg-gray-900/90 backdrop-blur-sm px-3 py-2 border-b border-gray-800 flex items-center justify-between">
        <span className="text-gray-300 text-sm font-medium">Event Log</span>
        <span className="bg-gray-700 text-gray-300 text-xs px-2 py-0.5 rounded-full">
          {events.length}
        </span>
      </div>
      
      {events.length === 0 ? (
        <div className="flex items-center justify-center text-gray-500 text-sm py-8">
          Waiting for events...
        </div>
      ) : (
        <div className="divide-y divide-gray-800/50">
          {[...events].reverse().map((event, idx) => (
            <div 
              key={`${event.timestamp}-${idx}`} 
              className="flex items-center gap-2 px-3 h-7 text-sm"
            >
              <span className="text-gray-500 font-mono text-xs flex-shrink-0" style={{ minWidth: '70px' }}>
                {formatTime(event.timestamp)}
              </span>
              
              <div 
                className={`w-2 h-2 rounded-full flex-shrink-0 ${getSeverityColor(event.severity)}`}
                title={event.severity}
              />
              
              <span className="text-gray-200 text-sm flex-1 truncate">
                {event.message}
              </span>
              
              {event.woId && (
                <span className="bg-gray-700 text-gray-400 text-xs px-1.5 py-0.5 rounded flex-shrink-0">
                  {event.woId}
                </span>
              )}
              
              {event.modelName && (
                <span className="text-gray-500 text-xs flex-shrink-0">
                  {event.modelName}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default EventLog
