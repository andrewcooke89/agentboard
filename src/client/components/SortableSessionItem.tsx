import { useCallback, forwardRef } from 'react'
import { motion } from 'motion/react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Session } from '@shared/types'
import SessionRow from './SessionRow'

export interface SortableSessionItemProps {
  session: Session
  isNew: boolean
  exitDuration: number
  prefersReducedMotion: boolean | null
  layoutAnimationsDisabled: boolean
  isSelected: boolean
  isEditing: boolean
  showSessionIdPrefix: boolean
  showProjectName: boolean
  showLastUserMessage: boolean
  dropIndicator: 'above' | 'below' | null
  onSelect: () => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onRename: (newName: string) => void
  onKill?: () => void
  onDuplicate?: () => void
  onSetPinned?: (isPinned: boolean) => void
  onNavigateToWorkflow?: (workflowId: string) => void
  onNavigateToCronManager?: (sessionId: string) => void
}

const SortableSessionItem = forwardRef<HTMLDivElement, SortableSessionItemProps>(function SortableSessionItem({
  session,
  isNew,
  exitDuration,
  prefersReducedMotion,
  layoutAnimationsDisabled,
  isSelected,
  isEditing,
  showSessionIdPrefix,
  showProjectName,
  showLastUserMessage,
  dropIndicator,
  onSelect,
  onStartEdit,
  onCancelEdit,
  onRename,
  onKill,
  onDuplicate,
  onSetPinned,
  onNavigateToWorkflow,
  onNavigateToCronManager,
}, ref) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: session.id,
    animateLayoutChanges: ({ isSorting, wasDragging }) => isSorting || wasDragging,
  })

  const dndTransform = CSS.Transform.toString(transform)
  const shouldApplyStyleTransform = Boolean(prefersReducedMotion && dndTransform)
  const style = {
    ...(shouldApplyStyleTransform ? { transform: dndTransform, transition } : {}),
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.9 : undefined,
  }

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node)
      if (typeof ref === 'function') {
        ref(node)
      } else if (ref) {
        ref.current = node
      }
    },
    [setNodeRef, ref],
  )

  return (
    <motion.div
      ref={setRefs}
      style={{ ...style, overflow: 'hidden' }}
      className="relative"
      layout={!prefersReducedMotion && !isDragging && !layoutAnimationsDisabled && !isNew}
      transformTemplate={(_, generatedTransform) => {
        if (!dndTransform) return generatedTransform
        if (!generatedTransform || generatedTransform === 'none') return dndTransform
        return `${dndTransform} ${generatedTransform}`
      }}
      initial={prefersReducedMotion || !isNew ? false : { opacity: 0, scale: 0.97 }}
      animate={
        prefersReducedMotion
          ? { opacity: 1 }
          : isNew
            ? { opacity: 1, scale: [1.02, 0.99, 1] }
            : { opacity: 1, scale: 1 }
      }
      exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0, scale: 0.97 }}
      transition={prefersReducedMotion ? { duration: 0 } : {
        layout: { type: 'spring', stiffness: 500, damping: 35 },
        opacity: { duration: exitDuration / 1000 },
        scale: { duration: exitDuration / 1000, ease: [0.34, 1.56, 0.64, 1] },
        height: { duration: exitDuration / 1000, ease: 'easeOut' },
      }}
      {...attributes}
      {...listeners}
    >
      {/* Drop indicator line */}
      {dropIndicator === 'above' && (
        <div className="absolute -top-px left-3 right-3 h-0.5 border-t-2 border-dashed border-accent" />
      )}
      <SessionRow
        session={session}
        isSelected={isSelected}
        isEditing={isEditing}
        showSessionIdPrefix={showSessionIdPrefix}
        showProjectName={showProjectName}
        showLastUserMessage={showLastUserMessage}
        isDragging={isDragging}
        onSelect={onSelect}
        onStartEdit={onStartEdit}
        onCancelEdit={onCancelEdit}
        onRename={onRename}
        onKill={onKill}
        onDuplicate={onDuplicate}
        onSetPinned={onSetPinned}
        onNavigateToWorkflow={onNavigateToWorkflow}
        onNavigateToCronManager={onNavigateToCronManager}
      />
      {dropIndicator === 'below' && (
        <div className="absolute -bottom-px left-3 right-3 h-0.5 border-t-2 border-dashed border-accent" />
      )}
    </motion.div>
  )
})

SortableSessionItem.displayName = 'SortableSessionItem'

export default SortableSessionItem
