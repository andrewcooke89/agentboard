---
affects:
- task-queue-detection-experiment
id: phase4-design-decisions
source_files:
- src/server/taskStore.ts
- src/server/taskWorker.ts
- src/server/taskHandlers.ts
trust: canonical
type: decision
---

# Phase 4 — Task Queue Design Decisions (2026-01-28)

## 1. Prompt Templates
- **Server-defined default list** stored in SQLite, served to UI
- **User-editable from UI** — add, edit, delete templates
- **Variables are template-specific** — each template defines its own variables (e.g. `{{project_path}}`, `{{phase_number}}`, `{{work_order}}`)
- Variable substitution happens server-side before spawning

## 2. Prompt Delivery
- **Always write prompt to temp file** for consistency and safety
- Command: `sh -c 'claude -p "$(cat /tmp/agentboard-task-{id}.txt)" --dangerously-skip-permissions 2>&1; echo "===TASK_EXIT_CODE=$?==="; exec sh'`
- Temp file cleaned up after task output is captured
- Handles: multi-line prompts, special characters, long prompts, variable-injected templates

## 3. Task-to-Session Association
- **By tmux window name** — deterministic, set at creation time
- Worker names windows `task-{short_id}` when spawning
- Match Task record to tmux window by this name
- No timing-based heuristics

## 4. Queue Persistence Across Restart
- On startup, check all tasks with `status=running`
- Verify their tmux windows still exist via `tmux list-windows`
- If window gone → mark task as `failed` with error `server_restart`
- If window exists → resume monitoring

## 5. Task Output Capture
- **Full output**: captured via `tmux capture-pane -p -S -` on completion, written to `~/.agentboard/task-outputs/{task-id}.txt`
- **Storage path** stored in task DB record
- **Frontend**: shows last N lines summary, with "View Full Output" option
- **API endpoint**: `GET /api/tasks/:id/output` serves the full file

## 6. Permissions Flag
- **All queued tasks** run with `--dangerously-skip-permissions`
- No per-task toggle for MVP — all automated tasks are trusted

## 7. Follow-up Prompts
- **Deferred** to Phase 5 (workflows)
- Phase 4 tasks are single-prompt, fire-and-forget
- Acknowledged as future need but not MVP scope
