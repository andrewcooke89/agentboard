---
id: workflow-engine-design-decisions
related:
- phase4-design-decisions
- task-queue-detection-experiment
source_files:
- src/server/workflowEngine.ts
- src/server/workflowStore.ts
- src/server/workflowSchema.ts
- src/server/workflowFileWatcher.ts
- src/server/handlers/workflowHandlers.ts
trust: canonical
type: decision
---

# Workflow Engine Design Decisions (Phase 5) — IMPLEMENTED

All 11 decisions implemented across 15 work orders.

## DEC-001: Poll-based engine (not event-driven)
setInterval loop in workflowEngine.ts, adaptive polling (slows to 10s when idle).

## DEC-002: Convention-based file paths
Steps reference explicit paths, no variable substitution. Output dir created on run start.

## DEC-003: YAML as source of truth
js-yaml with FAILSAFE_SCHEMA. File watcher syncs disk changes to SQLite.

## DEC-004: SQLite storage
workflows + workflow_runs tables. tasks table extended with workflow_run_id/workflow_step_name.

## DEC-005: Reuse task queue for execution
spawn_session steps create tasks via taskStore.createTask().

## DEC-006: Simple conditions only
file_exists, output_contains — evaluated before step execution, skip if not met.

## DEC-007: Per-step timeouts only
No global workflow timeout. Steps inherit task queue timeout defaults.

## DEC-008: Retry then halt
Reuses task retry logic. Workflow halts if step exhausts retries.

## DEC-009: Manual triggers only
REST POST /api/workflows/:id/run or WebSocket workflow-run message.

## DEC-010: Two-level UI
Dedicated views (WorkflowList, WorkflowDetail, WorkflowEditor) + right panel (WorkflowPanel) for monitoring.

## DEC-011: Pipeline diagram visualization
PipelineDiagram.tsx with StepNode.tsx — horizontal scrollable, keyboard navigable, compact mode for panel.

## Security Hardening (Post-Review)
- Path traversal prevention in resolveOutputPath
- SQL defense-in-depth on validation_errors
- Input size limits (1MB YAML, 10K description, 100 char name)
- File size guards (10MB output, 1MB watcher)
- YAML FAILSAFE_SCHEMA
- Adaptive polling to reduce idle CPU