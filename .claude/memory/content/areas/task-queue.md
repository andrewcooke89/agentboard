---
id: task-queue
related:
- phase4-design-decisions
- task-queue-detection-experiment
- workflow-engine-design-decisions
source_files:
- src/server/taskStore.ts
- src/server/taskWorker.ts
- src/server/handlers/taskHandlers.ts
trust: derived
type: area
---

# Task Queue (Phase 4)

SQLite-backed task queue with tmux-based execution. Tasks are created via WebSocket or REST, queued in SQLite, and executed by spawning tmux windows with Claude/Codex sessions.

## Key Components
- `taskStore.ts` — SQLite CRUD with prepared statements
- `taskWorker.ts` — Poll loop, tmux spawning, completion detection via sentinel files
- `taskHandlers.ts` — WebSocket handlers for task CRUD
- `httpRoutes.ts` — REST endpoints

## Schema Extensions (Phase 5)
- `tasks.workflow_run_id` — links task to a workflow run
- `tasks.workflow_step_name` — identifies which workflow step spawned this task
- `tasks.parent_task_id` — for task chaining (follow-up prompts)
- `tasks.follow_up_prompt` — auto-queued prompt on completion
- `tasks.metadata` — JSON blob for tags/metadata

## Integration with Workflow Engine
The workflow engine submits steps as tasks to the existing task queue. `workflowEngine.ts` creates tasks with `workflow_run_id` and `workflow_step_name` set, then polls for task completion to advance the pipeline.