---
depends_on:
- task-queue
id: workflow-engine-to-task-queue
related:
- workflow-engine-design-decisions
- phase4-design-decisions
trust: derived
type: integration
---

# Workflow Engine → Task Queue Integration

The workflow engine orchestrates multi-step pipelines by submitting steps one at a time to the existing task queue.

## Communication Method
- Workflow engine creates tasks via `taskStore.createTask()` with a `workflowRunId` linking back
- Task completion detected by workflow engine polling or callback from task worker
- On step completion: engine evaluates next step conditions, submits next task if conditions met
- On step failure: engine retries (reusing task retry logic), then halts workflow

## Key Files (Producer: Workflow Engine)
- `src/server/workflowEngine.ts` (planned) — orchestration loop, step evaluation, task submission
- `src/server/workflowStore.ts` (planned) — workflow definitions + run state persistence

## Key Files (Consumer: Task Queue)
- `src/server/taskStore.ts` — receives tasks from workflow engine
- `src/server/taskWorker.ts` — executes workflow steps as normal tasks

## Data Flow
1. User triggers workflow via UI/API
2. Workflow engine reads YAML definition
3. Engine submits first step as a task to task queue
4. Task worker spawns tmux window, monitors completion
5. On completion, engine evaluates next step conditions
6. Engine submits next step (repeat until done or failure)