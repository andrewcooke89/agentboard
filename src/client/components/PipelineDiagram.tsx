// PipelineDiagram.tsx - Workflow pipeline visualization with connected step nodes
import { useCallback, useEffect, useRef, useState } from 'react'
import type { StepRunState, WorkflowRun } from '@shared/types'
import StepNode from './StepNode'
import TaskOutputViewer from './TaskOutputViewer'
import { useTaskStore } from '../stores/taskStore'
import ParallelGroupNode from './ParallelGroupNode'
import ReviewLoopNode from './ReviewLoopNode'
import CleanupStatusDisplay from './CleanupStatusDisplay'

/** Format ISO timestamp to locale time string */
function formatTime(iso: string | null): string {
  if (!iso) return 'N/A'
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return 'N/A'
  }
}

function ResultViewer({ resultFile, resultContent }: { resultFile: string; resultContent: string | null }) {
  const [expanded, setExpanded] = useState(false)

  const formatted = (() => {
    if (!resultContent) return null
    try {
      return JSON.stringify(JSON.parse(resultContent), null, 2)
    } catch {
      return resultContent
    }
  })()

  return (
    <div>
      <div className="flex items-center gap-1.5 text-green-400">
        <span>✓</span>
        <span>Result collected: {resultFile}</span>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="ml-2 text-blue-400 hover:text-blue-300 transition-colors"
        >
          {expanded ? 'Hide' : 'View'}
        </button>
      </div>
      {expanded && formatted && (
        <pre className="mt-2 p-3 bg-gray-900 border border-gray-700 rounded text-gray-300 overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap">
          {formatted}
        </pre>
      )}
    </div>
  )
}

/** Step detail panel shown when a node is selected */
function StepDetailPanel({ step, onClose, onNavigateToSession }: { step: StepRunState; onClose: () => void; onNavigateToSession?: (sessionName: string) => void }) {
  const [showOutput, setShowOutput] = useState(false)
  const task = step.taskId ? useTaskStore.getState().getTaskById(step.taskId) : undefined
  const sessionName = task?.sessionName ?? null

  return (
    <div
      className="mt-4 p-4 bg-gray-800 border border-gray-700 rounded-lg text-sm"
      role="region"
      aria-label={`Details for step ${step.name}`}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-white font-medium">{step.name}</h3>
        <button
          type="button"
          className="text-gray-400 hover:text-white text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 transition-colors"
          onClick={onClose}
          aria-label="Close step details"
        >
          Close
        </button>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <dt className="text-gray-400">Type</dt>
        <dd className="text-white">{step.type}</dd>

        <dt className="text-gray-400">Status</dt>
        <dd className="text-white">{step.status}</dd>

        <dt className="text-gray-400">Started</dt>
        <dd className="text-white">{formatTime(step.startedAt)}</dd>

        <dt className="text-gray-400">Completed</dt>
        <dd className="text-white">{formatTime(step.completedAt)}</dd>

        {step.errorMessage && (
          <>
            <dt className="text-gray-400">Error</dt>
            <dd className="text-red-400">{step.errorMessage}</dd>
          </>
        )}

        {step.skippedReason && (
          <>
            <dt className="text-gray-400">Skipped reason</dt>
            <dd className="text-yellow-400">{step.skippedReason}</dd>
          </>
        )}

        {step.taskId && (
          <>
            <dt className="text-gray-400">Task ID</dt>
            <dd className="text-white font-mono text-[10px]">{step.taskId}</dd>
          </>
        )}

        {sessionName && onNavigateToSession && (
          <>
            <dt className="text-gray-400">Session</dt>
            <dd>
              <button
                type="button"
                onClick={() => onNavigateToSession(sessionName)}
                className="text-blue-400 hover:text-blue-300 transition-colors text-xs underline underline-offset-2"
              >
                {sessionName} &rarr;
              </button>
            </dd>
          </>
        )}

        <dt className="text-gray-400">Retries</dt>
        <dd className="text-white">{step.retryCount}</dd>
      </dl>

      {step.resultFile && (
        <div className="mt-3 text-xs">
          {step.resultCollected ? (
            <ResultViewer resultFile={step.resultFile} resultContent={step.resultContent} />
          ) : step.status === 'completed' ? (
            <div className="flex items-center gap-1.5 text-yellow-400">
              <span>⚠</span>
              <span>Result not found: {step.resultFile}</span>
            </div>
          ) : step.status === 'pending' || step.status === 'running' ? (
            <div className="flex items-center gap-1.5 text-gray-400">
              <span>Result file: {step.resultFile}</span>
            </div>
          ) : null}
        </div>
      )}

      {step.taskId && (
        <div className="mt-3">
          {!showOutput ? (
            <button
              type="button"
              onClick={() => setShowOutput(true)}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              View Output
            </button>
          ) : (
            <TaskOutputViewer
              taskId={step.taskId}
              onClose={() => setShowOutput(false)}
            />
          )}
        </div>
      )}

      {/* Cleanup status for failed steps (REQ-26) */}
      {step.status === 'failed' && step.cleanupState && (
        <div className="mt-3">
          <CleanupStatusDisplay cleanupState={step.cleanupState} label="Cleanup" />
        </div>
      )}
    </div>
  )
}

export interface PipelineDiagramProps {
  run: WorkflowRun | null
  compact?: boolean
  onNavigateToSession?: (sessionName: string) => void
}

export default function PipelineDiagram({ run, compact = false, onNavigateToSession }: PipelineDiagramProps) {
  const [selectedStepIndex, setSelectedStepIndex] = useState<number | null>(null)
  const [focusedIndex, setFocusedIndex] = useState<number>(-1)
  const containerRef = useRef<HTMLDivElement>(null)

  const steps = run?.steps_state ?? []

  // Reset selection when run changes
  useEffect(() => {
    setSelectedStepIndex(null)
    setFocusedIndex(-1)
  }, [run?.id])

  // Focus the node element when focusedIndex changes
  useEffect(() => {
    if (focusedIndex < 0 || !containerRef.current) return
    const node = containerRef.current.querySelector(`[data-step-index="${focusedIndex}"]`) as HTMLElement | null
    node?.focus()
  }, [focusedIndex])

  /** Keyboard navigation handler */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (steps.length === 0) return

      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault()
          setFocusedIndex((prev) => Math.min(prev + 1, steps.length - 1))
          break
        case 'ArrowLeft':
          e.preventDefault()
          setFocusedIndex((prev) => Math.max(prev - 1, 0))
          break
        case 'Home':
          e.preventDefault()
          setFocusedIndex(0)
          break
        case 'End':
          e.preventDefault()
          setFocusedIndex(steps.length - 1)
          break
        case 'Enter':
        case ' ':
          e.preventDefault()
          if (focusedIndex >= 0 && focusedIndex < steps.length) {
            setSelectedStepIndex(focusedIndex === selectedStepIndex ? null : focusedIndex)
          }
          break
      }
    },
    [steps.length, focusedIndex, selectedStepIndex]
  )

  const handleNodeClick = useCallback(
    (index: number) => {
      setSelectedStepIndex(index === selectedStepIndex ? null : index)
      setFocusedIndex(index)
    },
    [selectedStepIndex]
  )

  // Empty state: no run selected
  if (!run) {
    return (
      <div className="flex items-center justify-center p-8 text-gray-500 text-sm" role="status">
        No workflow run selected
      </div>
    )
  }

  // Empty state: no steps
  if (steps.length === 0) {
    return (
      <div className="flex items-center justify-center p-8 text-gray-500 text-sm" role="status">
        No steps defined
      </div>
    )
  }

  const selectedStep = selectedStepIndex !== null ? steps[selectedStepIndex] : null

  return (
    <div className="flex flex-col" aria-label="Pipeline diagram">
      {/* Horizontal scrollable pipeline */}
      <div
        ref={containerRef}
        data-testid="pipeline-scroll"
        className={compact ? "overflow-x-auto py-2 px-1" : "overflow-x-auto py-4 px-2"}
        role="toolbar"
        aria-label="Pipeline steps"
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center gap-0 min-w-max">
          {steps.map((step, i) => (
            <div key={`${step.name}-${i}`} className="flex items-center">
              {/* Connection line before node (except first) */}
              {i > 0 && (
                <div
                  className={`w-8 h-0.5 transition-colors duration-200 ${
                    step.status === 'completed' || step.status === 'running' || step.status === 'failed'
                      ? 'bg-gray-400'
                      : 'bg-gray-700'
                  }`}
                  aria-hidden="true"
                />
              )}
              {step.type === 'parallel_group' ? (
                <ParallelGroupNode
                  step={step}
                  isSelected={selectedStepIndex === i}
                  onSelect={() => handleNodeClick(i)}
                />
              ) : step.type === 'review_loop' ? (
                <ReviewLoopNode
                  step={step}
                  maxIterations={(step.reviewIterations?.length ?? 0) + (step.status === 'completed' || step.status === 'failed' ? 0 : 1) || 3}
                  isSelected={selectedStepIndex === i}
                  onSelect={() => handleNodeClick(i)}
                />
              ) : (
                <StepNode
                  step={step}
                  index={i}
                  isSelected={selectedStepIndex === i}
                  isFocused={focusedIndex === i}
                  onClick={handleNodeClick}
                  compact={compact}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Step detail panel */}
      {selectedStep && (
        <StepDetailPanel
          step={selectedStep}
          onClose={() => setSelectedStepIndex(null)}
          onNavigateToSession={onNavigateToSession}
        />
      )}

      {/* Pipeline-level cleanup status (REQ-27) */}
      {run?.pipelineCleanupState && (
        <div className="mt-2 px-2">
          <CleanupStatusDisplay cleanupState={run.pipelineCleanupState} label="Pipeline Cleanup" />
        </div>
      )}
    </div>
  )
}
