import { useState, useRef, useCallback, useEffect } from 'react'
import {
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import type { Session } from '@shared/types'
import { getSessionOrderKey } from '../utils/sessions'

export function useSessionListDnD(
  filteredSessions: Session[],
  sortedSessions: Session[],
  sessionSortMode: string,
  setSessionSortMode: (mode: string) => void,
  setManualSessionOrder: (order: string[]) => void,
) {
  // Drag-and-drop setup
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Require 8px movement to start drag (prevents accidental drags)
      },
    })
  )

  // Track active drag state for drop indicator
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  // Disable layout animations briefly after drag to prevent conflicts
  const [layoutAnimationsDisabled, setLayoutAnimationsDisabled] = useState(false)
  const layoutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reenableLayoutAnimations = useCallback(() => {
    if (layoutTimeoutRef.current) clearTimeout(layoutTimeoutRef.current)
    layoutTimeoutRef.current = setTimeout(() => setLayoutAnimationsDisabled(false), 100)
  }, [])

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string)
    setLayoutAnimationsDisabled(true)
  }, [])

  const handleDragOver = useCallback((event: DragOverEvent) => {
    setOverId(event.over?.id as string | null)
  }, [])

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      setActiveId(null)
      setOverId(null)

      if (!over || active.id === over.id) {
        // Re-enable layout animations after a brief delay
        reenableLayoutAnimations()
        return
      }

      const oldIndex = filteredSessions.findIndex((s) => s.id === active.id)
      const newIndex = filteredSessions.findIndex((s) => s.id === over.id)
      if (oldIndex === -1 || newIndex === -1) {
        reenableLayoutAnimations()
        return
      }

      const reorderedVisible = filteredSessions.map((s) => getSessionOrderKey(s))
      const [removed] = reorderedVisible.splice(oldIndex, 1)
      reorderedVisible.splice(newIndex, 0, removed)

      const fullOrder = sortedSessions.map((s) => getSessionOrderKey(s))
      const visibleSet = new Set(reorderedVisible)
      let visibleIndex = 0
      const newOrder = fullOrder.map((id) => {
        if (!visibleSet.has(id)) return id
        const nextId = reorderedVisible[visibleIndex]
        visibleIndex += 1
        return nextId
      })

      // Switch to manual mode and update order
      if (sessionSortMode !== 'manual') {
        setSessionSortMode('manual')
      }
      setManualSessionOrder(newOrder)
      // Re-enable layout animations after state settles
      reenableLayoutAnimations()
    },
    [
      filteredSessions,
      sortedSessions,
      sessionSortMode,
      setSessionSortMode,
      setManualSessionOrder,
    ]
  )

  const handleDragCancel = useCallback(() => {
    setActiveId(null)
    setOverId(null)
    reenableLayoutAnimations()
  }, [])

  useEffect(() => {
    if (!activeId && !overId) return
    const currentIds = new Set(filteredSessions.map((s) => s.id))
    let shouldReset = false
    if (activeId && !currentIds.has(activeId)) {
      setActiveId(null)
      shouldReset = true
    }
    if (overId && !currentIds.has(overId)) {
      setOverId(null)
      shouldReset = true
    }
    if (shouldReset) {
      setLayoutAnimationsDisabled(false)
    }
  }, [filteredSessions, activeId, overId])

  return {
    sensors,
    activeId,
    overId,
    layoutAnimationsDisabled,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
  }
}
