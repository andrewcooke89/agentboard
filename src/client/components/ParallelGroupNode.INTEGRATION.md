# ParallelGroupNode Integration Guide

## Overview
The `ParallelGroupNode` component is ready for integration into the PipelineDiagram to handle `parallel_group` step types.

## Component Location
`/home/andrew-cooke/tools/agentboard/src/client/components/ParallelGroupNode.tsx`

## Integration Steps

### 1. Import ParallelGroupNode in PipelineDiagram.tsx

```typescript
import ParallelGroupNode from './ParallelGroupNode'
```

### 2. Update Step Rendering Logic

Replace the current step mapping (lines 267-289) with conditional rendering:

```typescript
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

      {/* Render ParallelGroupNode for parallel_group steps, StepNode for others */}
      {step.type === 'parallel_group' ? (
        <ParallelGroupNode
          step={step}
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
```

### 3. Update Step Detail Panel (Optional Enhancement)

To show enhanced details for parallel groups in the detail panel, you can add special handling:

```typescript
function StepDetailPanel({ step, onClose, onNavigateToSession }: { step: StepRunState; onClose: () => void; onNavigateToSession?: (sessionName: string) => void }) {
  // ... existing code ...

  // Add parallel group specific details
  {step.type === 'parallel_group' && step.childSteps && (
    <>
      <dt className="text-gray-400">Child Steps</dt>
      <dd className="text-white">{step.childSteps.length}</dd>
      <dt className="text-gray-400">Completed</dt>
      <dd className="text-white">
        {step.childSteps.filter(c => c.status === 'completed').length} / {step.childSteps.length}
      </dd>
    </>
  )}

  // ... rest of existing code ...
}
```

## Testing

The component has comprehensive tests in:
`/home/andrew-cooke/tools/agentboard/src/client/__tests__/ParallelGroupNode.test.tsx`

Run tests with:
```bash
bun test src/client/__tests__/ParallelGroupNode.test.tsx
```

All 16 tests pass:
- REQ-01: Group name and progress summary
- REQ-02: Chevron icon and expand/collapse
- REQ-03: Individual child status with colors
- REQ-04: Auto-expand for <=3 children, collapsed for >3
- REQ-05: Dependency info display
- Keyboard navigation (Enter/Space)
- Accessibility (ARIA attributes)
- Edge cases (empty/undefined children)

## Requirements Satisfied

- **REQ-01**: Single expandable row showing group name and progress summary (e.g., "2/3 complete")
- **REQ-02**: Click to expand/collapse child steps as indented sub-list
- **REQ-03**: Each child shows individual status with correct status color
- **REQ-04**: Groups with >3 children show collapsed by default
- **REQ-05**: Child steps with `depends_on` show dependency status
- **Real-time updates**: Progress updates automatically when parent component receives WebSocket updates (childSteps array updates trigger re-render)

## Browser Compatibility

- React 18+
- Tailwind CSS (dark theme)
- Keyboard accessible (Enter/Space to toggle, Tab navigation)
- Screen reader compatible (ARIA labels, roles)

## Notes

- Component uses same status color scheme as StepNode.tsx (STATUS_CLASSES)
- Real-time updates work automatically via React props changes
- No CSS modules required (pure Tailwind)
- TypeScript strict mode compatible
