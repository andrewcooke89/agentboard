// TaskOutputViewer.tsx — Displays task output from workflow step (polling while running)
import { useState, useEffect, useRef, useCallback } from 'react'
import { authFetch } from '../utils/api'

export interface TaskOutputViewerProps {
  taskId: string
  onClose: () => void
}

const POLLING_INTERVAL_MS = 5000

export default function TaskOutputViewer({ taskId, onClose }: TaskOutputViewerProps) {
  const [output, setOutput] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(true)
  const preRef = useRef<HTMLPreElement>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const clearPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const fetchOutput = async () => {
      try {
        const res = await authFetch(`/api/tasks/${taskId}/output`)
        if (cancelled) return
        if (!res.ok) {
          setError(`Failed to fetch output: HTTP ${res.status}`)
          setLoading(false)
          setIsRunning(false)
          clearPolling()
          return
        }
        const data = await res.json()
        setOutput(data.output ?? '')
        setLoading(false)
        // Stop polling if task is done
        if (data.status && data.status !== 'running' && data.status !== 'queued') {
          setIsRunning(false)
          clearPolling()
        }
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Network error')
        setLoading(false)
        setIsRunning(false)
        clearPolling()
      }
    }

    fetchOutput()
    intervalRef.current = setInterval(fetchOutput, POLLING_INTERVAL_MS)

    return () => {
      cancelled = true
      clearPolling()
    }
  }, [taskId, clearPolling])

  // Auto-scroll to bottom only if user is near bottom
  useEffect(() => {
    if (preRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = preRef.current
      const isNearBottom = scrollTop + clientHeight >= scrollHeight - 50
      if (isNearBottom) {
        preRef.current.scrollTop = scrollHeight
      }
    }
  }, [output])

  return (
    <div className="mt-3 border border-gray-700 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400 font-medium">Task Output</span>
          {isRunning && (
            <span className="text-xs text-blue-400 animate-pulse">Live</span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 transition-colors"
          aria-label="Close output viewer"
        >
          Close
        </button>
      </div>
      <pre
        ref={preRef}
        className="p-3 text-xs text-gray-300 font-mono overflow-auto max-h-64 bg-gray-900"
        role="log"
        aria-live="polite"
        aria-label="Task output console"
      >
        {loading && 'Loading...'}
        {error && <span className="text-red-400">{error}</span>}
        {!loading && !error && (output || <span className="text-gray-500">No output yet</span>)}
      </pre>
    </div>
  )
}
