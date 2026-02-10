---
depends_on:
- task-queue
id: workflow-engine
source_files:
- src/server/workflowEngine.ts
- src/server/workflowStore.ts
- src/server/workflowSchema.ts
- src/server/workflowFileWatcher.ts
- src/server/handlers/workflowHandlers.ts
- src/server/handlers/workflowWsHandlers.ts
- src/client/stores/workflowStore.ts
- src/client/components/PipelineDiagram.tsx
- src/client/components/WorkflowList.tsx
- src/client/components/WorkflowEditor.tsx
- src/client/components/WorkflowPanel.tsx
trust: canonical
type: area
---

# Workflow Engine (Phase 5)

YAML-defined multi-step pipeline orchestration for Claude/Codex sessions. Steps execute sequentially via the task queue with conditional branching and retry.

## Server Components
- `workflowSchema.ts` — YAML parsing/validation (js-yaml FAILSAFE_SCHEMA, 4 step types)
- `workflowStore.ts` — SQLite CRUD (workflows + workflow_runs tables)
- `workflowEngine.ts` — Poll-based engine, adaptive polling, step execution, condition evaluation
- `workflowFileWatcher.ts` — fs.watch with debounce, syncs YAML files to SQLite
- `handlers/workflowHandlers.ts` — 10 REST endpoints for CRUD + run management
- `handlers/workflowWsHandlers.ts` — 5 WebSocket handlers for real-time updates

## Client Components
- `stores/workflowStore.ts` — Zustand store with REST actions + WS handlers
- `WorkflowList.tsx` — Table with filter (All/Valid/Invalid)
- `WorkflowDetail.tsx` — YAML display, run history, embedded pipeline diagram
- `WorkflowEditor.tsx` — YAML textarea with client-side validation
- `WorkflowPanel.tsx` — Right-side monitoring panel with compact pipeline diagrams
- `PipelineDiagram.tsx` + `StepNode.tsx` — Horizontal pipeline visualization
- `ErrorBoundary.tsx` — Wraps all workflow views

## Step Types
- `spawn_session` — Creates a task in the task queue
- `check_file` — Checks if a file exists at a path
- `check_output` — Reads file and checks content with output_contains
- `delay` — Waits N seconds

## Config
- `WORKFLOW_ENGINE_ENABLED` (default: true)
- `WORKFLOW_DIR` (default: ~/.agentboard/workflows)
- `WORKFLOW_MAX_CONCURRENT_RUNS` (default: 5)
- `WORKFLOW_POLL_INTERVAL_MS` (default: 2000)
- `WORKFLOW_RUN_RETENTION_DAYS` (default: 30)

## Test Coverage
636 tests passing (170+ workflow-specific). Integration tests in workflowIntegration.test.ts.