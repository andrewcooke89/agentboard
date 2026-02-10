# YAML Workflow Engine

**Planning Mode**: FULL

## Objective
- **Problem:** Agentboard currently supports single tasks and lightweight two-step chains (`followUpPrompt`), but users need to orchestrate multi-step AI agent pipelines with conditional logic, retry semantics, and real-time progress monitoring. There is no way to define reusable, version-controllable sequences of Claude/Codex sessions that execute in order with inter-step data passing.
- **Outcome/Success Criteria:**
  - Users can define, store, and execute multi-step YAML workflows through both file-based and UI-based editors
  - Workflow steps execute sequentially via the existing task queue with per-step status tracking
  - Pipeline diagram provides real-time visualization of workflow progress
  - Server restart resumes in-progress workflows from their current step
  - p95 workflow status WebSocket update latency < 200ms
  - Zero data loss on server restart (all workflow/run state persisted in SQLite)

## Summary
The YAML Workflow Engine adds multi-step pipeline orchestration to agentboard. Users define workflows as YAML files (or via a UI form builder) specifying a sequence of steps. Each step is one of four types: `spawn_session` (launch a Claude/Codex task), `check_file` (verify a file exists), `delay` (wait N seconds), or `check_output` (inspect previous step output). Steps can declare conditions that skip them if not met. The workflow engine submits steps one at a time to the existing task queue, monitors completion, and advances to the next step. All state is persisted in SQLite so workflows survive server restarts. A dedicated UI view provides CRUD with a form builder and raw YAML toggle, while a right-panel tab shows a pipeline diagram for monitoring active runs.

## Self-Asked Clarifying Questions (and Answers)

- Q: How does the engine detect when a `spawn_session` step completes?
  A: The existing task queue already detects completion via sentinel files. The workflow engine listens for task completion events (task status changing to `completed`/`failed`) and advances the pipeline. The engine polls or subscribes to task updates.

- Q: Where are YAML workflow files stored on disk?
  A: In a configurable directory, defaulting to `~/.agentboard/workflows/`. Configurable via `WORKFLOW_DIR` env var. *(Assumption -- validate in rollout)*

- Q: Can multiple instances of the same workflow run concurrently?
  A: Yes. Each "run" is a separate `workflow_runs` row with its own step states. The same workflow definition can have multiple active runs.

- Q: What happens to running workflows when the server restarts?
  A: On startup, the engine queries `workflow_runs` for runs with status `running`. For each, it checks the current step's associated task. If the task completed while the server was down, it advances. If the task is still running (orphaned), existing `markOrphanedTasksFailed` logic handles it, and the workflow engine retries or halts per config.

- Q: How does the YAML file watcher work?
  A: The server watches the workflow directory using `fs.watch` (or Bun's equivalent). On file change, it re-parses and upserts the workflow definition in SQLite. Invalid YAML is logged but does not crash. *(Assumption -- validate in rollout)*

- Q: What is the format of convention-based file paths for inter-step communication?
  A: Each workflow run gets a scratch directory: `~/.agentboard/task-outputs/workflow-{runId}/`. Steps write outputs there. The engine prepends the scratch directory path to `spawn_session` step prompts (e.g., "Output directory: /absolute/path/to/scratch/") so the agent knows where to write. Steps reference each other's outputs via convention-based paths defined explicitly in the YAML (e.g., `output_path: ./output/plan.md`), not via template variables. There is no variable substitution or implicit discovery -- paths are explicit conventions.

- Q: How does the `check_output` step type work?
  A: It reads the output file of a referenced prior step and checks if it contains a specified string (`output_contains` condition). It does not spawn a tmux session; it is a lightweight engine-side check.

- Q: What YAML validation is performed?
  A: Schema validation on parse: required fields present, step types are valid enum values, condition types are valid, referenced step names exist (for `check_output`), no duplicate step names. Validation errors are returned to the UI and logged.

## Scope

### Goals
- YAML schema for defining multi-step workflows with 4 step types (`spawn_session`, `check_file`, `delay`, `check_output`)
- SQLite persistence for workflow definitions and workflow runs (step-level state)
- Workflow engine that submits steps to existing task queue and monitors completion
- Simple conditions (`file_exists`, `output_contains`) that skip steps when not met
- Per-step timeout and retry (reusing task queue retry logic for `spawn_session`)
- YAML file directory watching with auto-reload
- REST API endpoints for workflow CRUD and run management
- WebSocket messages for real-time workflow progress updates
- Dedicated full-page view for workflow CRUD (raw YAML editor for MVP; form builder is stretch goal)
- Right-panel tab for pipeline diagram monitoring
- Task queue badge showing which workflow a step belongs to
- Resume from failed step (manual retry via UI or API)
- Server restart recovery (resume in-progress workflows)

### Non-Goals
- `run_command` or `notify` step types (future step types)
- Scheduled or event-based triggers (manual only for MVP)
- Parallel step execution (steps are strictly sequential)
- Full if/else branching (only simple skip conditions)
- Workflow versioning or diff (YAML files are version-controlled externally via git)
- Workflow templates marketplace or sharing
- Global workflow timeout

### Out of Scope
- Visual drag-and-drop workflow editor
- Workflow import/export across agentboard instances
- Step-level resource limits (CPU, memory)
- Workflow-level variable substitution or template variables
- Integration with external CI/CD systems
- Multi-user workflow permissions

### Minimal Viable Scope (<=2 weeks)
- YAML schema definition and validation
- SQLite tables for `workflows` and `workflow_runs` (with step state as JSON)
- Workflow engine core: sequential step execution via task queue integration
- REST endpoints: CRUD workflows, trigger run, get run status, resume failed
- WebSocket messages: `workflow-run-update`, `workflow-list`
- Basic workflow list/detail page (read-only YAML view, run button)
- Pipeline diagram component (status nodes)
- File watcher for YAML directory

### Stretch (later)
- Form builder UI for workflow editing (raw YAML editor first)
- `run_command` and `notify` step types
- Scheduled triggers (cron-based)
- Workflow run history with log aggregation
- Step output preview in UI
- Workflow duplication/clone in UI

## Users & Personas

- **Power User (primary):** Runs complex multi-step AI agent pipelines regularly. Defines workflows in YAML files, version-controls them, triggers runs from the UI. Needs real-time visibility into step progress and the ability to resume failed workflows.
- **Casual User:** Uses the UI form builder to create simple 2-3 step workflows without writing YAML. Monitors progress via the pipeline diagram.
- **API Consumer:** Triggers workflow runs programmatically via REST endpoints. Polls or subscribes to status updates.

## UX / Interaction Flows

### Primary Flow: Create and Run a Workflow
1. User creates a YAML file in `~/.agentboard/workflows/my-pipeline.yaml`
2. File watcher detects the new file, parses and validates YAML
3. Workflow appears in the Workflows list page in the UI
4. User clicks "Run" on the workflow
5. Engine creates a `workflow_run` record, sets step 0 to `pending`
6. Engine evaluates step 0's condition (if any). If condition not met, marks step as `skipped` and advances
7. If step is `spawn_session`, engine creates a task in the task queue with the step's prompt
8. Task queue picks up the task, spawns a tmux session
9. WebSocket broadcasts `workflow-run-update` with step status changes
10. Pipeline diagram updates in real time (step node goes from `pending` -> `running` -> `completed`)
11. On task completion, engine advances to the next step
12. Process repeats until all steps complete or a step fails after retries
13. Final status: `completed` or `failed` (halted at failed step)

### Primary Flow: Create Workflow via UI
1. User navigates to Workflows page, clicks "New Workflow"
2. Form builder shows: name, description, steps list
3. User adds steps via "Add Step" button, selects type from dropdown
4. For `spawn_session`: fills in project path, prompt, timeout, retries
5. For `check_file`: fills in file path
6. For `delay`: fills in seconds
7. For `check_output`: selects referenced step, fills in expected content
8. User can toggle to raw YAML view to see/edit the generated YAML
9. User clicks "Save" -- YAML file written to workflow directory
10. Workflow appears in list, ready to run

### Resume from Failed Step
1. Workflow run shows status `failed` with step N highlighted in red
2. User clicks "Resume" on the failed run
3. Engine retries step N (re-submits to task queue)
4. If step N succeeds, pipeline continues from step N+1

### Empty/Error States
- **No workflows defined:** Empty state with "Create your first workflow" prompt and link to documentation
- **YAML parse error:** Workflow shown in list with error badge; clicking shows validation errors; workflow cannot be run
- **Step fails after max retries:** Run status set to `failed`, pipeline diagram highlights failed step in red, subsequent steps shown as `pending` (not executed)
- **Server restart during run:** On startup, engine re-evaluates all `running` workflow runs and resumes from current step
- **Concurrent runs of same workflow:** Each run is independent, shown as separate entries in the run history

### Accessibility & i18n
- Pipeline diagram nodes are keyboard-navigable with clear focus indicators
- Status colors supplemented with icons (checkmark, X, spinner, skip arrow) for colorblind accessibility
- All interactive elements have ARIA labels

## APIs / Interfaces

### REST Endpoints

| Endpoint | Method | Purpose | Auth | Request (fields) | Response (fields) | Status Codes |
|----------|--------|---------|------|-------------------|-------------------|--------------|
| `/api/workflows` | GET | List all workflow definitions | Bearer token (if AUTH_TOKEN set) | `?status=valid\|invalid` | `{ workflows: WorkflowDefinition[] }` | 200, 401, 500 |
| `/api/workflows/:id` | GET | Get single workflow definition | Bearer token | -- | `{ workflow: WorkflowDefinition }` | 200, 401, 404, 500 |
| `/api/workflows` | POST | Create/update workflow from YAML body | Bearer token | `{ name: string, yaml: string }` | `{ workflow: WorkflowDefinition }` | 201, 400 (validation), 401, 409 (name conflict), 500 |
| `/api/workflows/:id` | PUT | Update workflow definition | Bearer token | `{ yaml: string }` | `{ workflow: WorkflowDefinition }` | 200, 400, 401, 404, 500 |
| `/api/workflows/:id` | DELETE | Delete workflow definition and file | Bearer token | -- | `{ ok: true }` | 200, 401, 404, 500 |
| `/api/workflows/:id/runs` | GET | List runs for a workflow | Bearer token | `?status=running\|completed\|failed&limit=20&offset=0` | `{ runs: WorkflowRun[] }` | 200, 401, 404, 500 |
| `/api/workflows/:id/run` | POST | Trigger a new workflow run | Bearer token | `{}` | `{ run: WorkflowRun }` | 201, 400 (invalid workflow), 401, 404, 500 |
| `/api/workflow-runs/:runId` | GET | Get run with step details | Bearer token | -- | `{ run: WorkflowRun }` | 200, 401, 404, 500 |
| `/api/workflow-runs/:runId/resume` | POST | Resume a failed run from failed step | Bearer token | -- | `{ run: WorkflowRun }` | 200, 400 (not in failed state), 401, 404, 500 |
| `/api/workflow-runs/:runId/cancel` | POST | Cancel a running workflow | Bearer token | -- | `{ run: WorkflowRun }` | 200, 400 (not running), 401, 404, 500 |

**Error Response Format** (consistent with existing Hono patterns):
```json
{ "error": "Human-readable message", "code": "VALIDATION_ERROR" | "NOT_FOUND" | "CONFLICT" | "INVALID_STATE" }
```

### WebSocket Messages

**Server -> Client:**
```typescript
| { type: 'workflow-list'; workflows: WorkflowDefinition[] }
| { type: 'workflow-updated'; workflow: WorkflowDefinition }
| { type: 'workflow-removed'; workflowId: string }
| { type: 'workflow-run-update'; run: WorkflowRun }
| { type: 'workflow-run-list'; runs: WorkflowRun[] }
```

**Client -> Server:**
```typescript
| { type: 'workflow-list-request' }
| { type: 'workflow-run-list-request'; workflowId?: string }
| { type: 'workflow-run'; workflowId: string }
| { type: 'workflow-run-resume'; runId: string }
| { type: 'workflow-run-cancel'; runId: string }
```

## Data Model

### YAML Schema (Workflow Definition File)

```yaml
name: my-pipeline                    # Required, unique identifier (kebab-case)
description: "Runs analysis pipeline" # Optional
steps:
  - name: analyze                    # Required, unique within workflow
    type: spawn_session              # Required: spawn_session | check_file | delay | check_output
    projectPath: /path/to/project    # Required for spawn_session
    prompt: "Analyze the codebase"   # Required for spawn_session
    output_path: ./output/analysis.md # Optional: convention-based path for step output
    # All spawn_session steps wait for completion before advancing
    timeoutSeconds: 3600             # Optional, default from config
    maxRetries: 2                    # Optional, default 0
    condition:                       # Optional
      type: file_exists              # file_exists | output_contains
      path: "./output/ready.txt"     # For file_exists
      # step: prev-step-name         # For output_contains
      # contains: "SUCCESS"          # For output_contains

  - name: verify
    type: check_file
    path: ./output/analysis.json      # Convention-based path relative to scratch dir
    timeoutSeconds: 60               # How long to wait for file to appear
    max_age_seconds: 3600            # Optional: fail if file exists but older than 1 hour

  - name: pause
    type: delay
    seconds: 30

  - name: validate
    type: check_output
    step: analyze                    # References prior step by name
    contains: "no errors found"
```

### SQLite Entities

**`workflows` table:**

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Generated ID (same pattern as tasks: `{timestamp36}-{random}`) |
| `name` | TEXT | NOT NULL, UNIQUE | Workflow name from YAML (kebab-case) |
| `description` | TEXT | | Optional description |
| `yaml_content` | TEXT | NOT NULL | Raw YAML content |
| `file_path` | TEXT | | Absolute path to source YAML file (null if created via UI only) |
| `is_valid` | INTEGER | NOT NULL DEFAULT 1 | 0 if YAML has validation errors |
| `validation_errors` | TEXT | | JSON array of error strings |
| `step_count` | INTEGER | NOT NULL DEFAULT 0 | Number of steps |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | |
| `updated_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | |

**Indexes:** `idx_workflows_name` on `name`, `idx_workflows_valid` on `is_valid`

**`workflow_runs` table:**

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PRIMARY KEY | Generated run ID |
| `workflow_id` | TEXT | NOT NULL, FK -> workflows.id | Parent workflow |
| `workflow_name` | TEXT | NOT NULL | Denormalized for display (workflow may be deleted) |
| `status` | TEXT | NOT NULL DEFAULT 'pending' | `pending` / `running` / `completed` / `failed` / `cancelled` |
| `current_step_index` | INTEGER | NOT NULL DEFAULT 0 | Index of current/next step to execute |
| `steps_state` | TEXT | NOT NULL | JSON array of `StepRunState` objects |
| `output_dir` | TEXT | NOT NULL | Scratch directory for this run |
| `started_at` | TEXT | | |
| `completed_at` | TEXT | | |
| `error_message` | TEXT | | Error for the overall run |
| `created_at` | TEXT | NOT NULL DEFAULT (datetime('now')) | |

**Indexes:** `idx_workflow_runs_workflow` on `workflow_id`, `idx_workflow_runs_status` on `status`

**`StepRunState` (JSON within `steps_state`):**
```typescript
interface StepRunState {
  name: string
  type: 'spawn_session' | 'check_file' | 'delay' | 'check_output'
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  taskId: string | null        // For spawn_session steps, the task queue task ID
  startedAt: string | null
  completedAt: string | null
  errorMessage: string | null
  retryCount: number
  skippedReason: string | null // If skipped due to condition
}
```

**Relationships:**
- `workflow_runs.workflow_id` -> `workflows.id` (many-to-one, ON DELETE SET NULL to preserve run history)
- `StepRunState.taskId` -> `tasks.id` (logical reference, not FK, since tasks table is separate)

**Retention:** Workflow runs older than 30 days auto-deleted by a cleanup routine (configurable via `WORKFLOW_RUN_RETENTION_DAYS`). No PII stored.

### Task Table Additions

A new column on the existing `tasks` table to link tasks back to workflow runs:

| Column | Type | Description |
|--------|------|-------------|
| `workflow_run_id` | TEXT | Nullable. ID of the workflow run that created this task |
| `workflow_step_name` | TEXT | Nullable. Step name within the workflow |

Added via additive migration (same pattern as `parent_task_id`).

## Non-Functional Requirements

### Performance/SLOs
- Workflow engine poll interval: 2 seconds (matching existing task worker)
- p95 WebSocket update latency for step status changes: < 200ms
- YAML parse + validate: < 50ms for files up to 100 steps
- File watcher debounce: 500ms (avoid rapid re-parse on editor saves)
- SQLite query for run status: < 5ms
- Maximum concurrent workflow runs: 20 (configurable via `WORKFLOW_MAX_CONCURRENT_RUNS`)

### Security/Compliance
- All REST endpoints respect existing `AUTH_TOKEN` authentication
- YAML file paths validated to prevent directory traversal (workflow dir only)
- `spawn_session` project paths validated against `ALLOWED_ROOTS` (existing config)
- No user-supplied content executed as shell commands (prompts go through existing task queue sanitization)
- YAML `!!` tags stripped on parse to prevent prototype pollution

### Observability
- Structured log lines for: workflow created/updated/deleted, run started/step-advanced/completed/failed/resumed
- Log format: `[workflow-engine] {action} workflow={name} run={runId} step={stepName} status={status}`
- Config values logged at startup: `WORKFLOW_DIR`, `WORKFLOW_MAX_CONCURRENT_RUNS`, `WORKFLOW_RUN_RETENTION_DAYS`
- WebSocket broadcast count metric for workflow messages
- Error counts: YAML parse failures, step failures, engine errors

### Cost Considerations
- SQLite storage: ~1KB per workflow definition, ~2KB per run. At 100 runs/day, ~60KB/day, ~22MB/year. Negligible.
- File watcher: Single `fs.watch` on one directory. Minimal OS resource usage.
- Engine poll loop: Shared with existing task worker poll interval. No additional timer.

## Acceptance Criteria (testable)

### API
- [ ] `POST /api/workflows` with valid YAML returns 201 with parsed workflow definition *(integration: POST valid YAML -> assert 201, response has id, name, stepCount)*
- [ ] `POST /api/workflows` with invalid YAML returns 400 with `validation_errors` array *(integration: POST malformed YAML -> assert 400, errors array non-empty)*
- [ ] `POST /api/workflows` with duplicate name returns 409 *(integration: POST same name twice -> assert 409)*
- [ ] `GET /api/workflows` returns all valid workflows *(integration: create 3 -> GET -> assert length 3)*
- [ ] `GET /api/workflows/:id` returns 404 for non-existent ID *(integration: GET random id -> assert 404)*
- [ ] `DELETE /api/workflows/:id` removes workflow and returns 200 *(integration: create -> delete -> GET -> assert 404)*
- [ ] `POST /api/workflows/:id/run` creates a new run with status `running` and first step `pending`/`running` *(integration: create workflow -> trigger run -> assert run status running)*
- [ ] `POST /api/workflows/:id/run` returns 400 if workflow has validation errors *(integration: create invalid workflow -> trigger -> assert 400)*
- [ ] `GET /api/workflow-runs/:runId` returns run with all step states *(integration: trigger run -> GET -> assert steps_state array matches step count)*
- [ ] `POST /api/workflow-runs/:runId/resume` on a failed run re-executes the failed step *(integration: trigger run -> force step fail -> resume -> assert step retried)*
- [ ] `POST /api/workflow-runs/:runId/resume` on a non-failed run returns 400 *(integration: trigger run -> resume while running -> assert 400)*
- [ ] `POST /api/workflow-runs/:runId/cancel` cancels the active step's task and sets run to cancelled *(integration: trigger run -> cancel -> assert status cancelled)*
- [ ] All endpoints return 401 when AUTH_TOKEN is set and request has no/wrong token *(integration: set AUTH_TOKEN -> request without token -> assert 401)*

### Engine/Business Logic
- [ ] Engine advances to next step when current `spawn_session` step's task completes *(unit: mock task completion -> assert engine calls next step)*
- [ ] Engine halts workflow when step fails after max retries *(unit: mock step fail 3x with maxRetries=2 -> assert run status failed)*
- [ ] Engine skips step when `file_exists` condition is not met *(unit: condition path does not exist -> assert step status skipped)*
- [ ] Engine skips step when `output_contains` condition is not met *(unit: output file lacks string -> assert step status skipped)*
- [ ] Engine executes step when condition IS met *(unit: condition satisfied -> assert step executes)*
- [ ] `delay` step waits the specified seconds before completing *(unit: delay 2s -> assert ~2s elapsed)*
- [ ] `check_file` step completes when file exists, fails on timeout *(unit: file exists -> complete; file missing after timeout -> fail)*
- [ ] `check_output` step reads referenced step's output and checks content *(unit: output contains string -> complete; missing -> fail)*
- [ ] Engine creates scratch directory at `output_dir` for each run *(unit: trigger run -> assert directory created)*
- [ ] Engine prepends scratch directory path to `spawn_session` step prompts *(unit: trigger run -> assert task prompt starts with "Output directory: /path/to/scratch/")*
- [ ] Steps use convention-based `output_path` fields from YAML without variable substitution *(unit: step with output_path -> assert path available in step state as-is)*
- [ ] On server restart, engine recovers running workflows from SQLite *(integration: insert running run in DB -> start engine -> assert engine picks up run)*

### Data/Store
- [ ] `workflows` table created on first run with correct schema *(unit: init store -> assert table exists with all columns)*
- [ ] `workflow_runs` table created with correct schema *(unit: init store -> assert table exists)*
- [ ] `tasks.workflow_run_id` column added via migration *(unit: init store -> assert column exists)*
- [ ] YAML file watcher detects new files and upserts to SQLite *(integration: write YAML file -> assert workflow appears in DB within 2s)*
- [ ] YAML file watcher detects file changes and updates SQLite *(integration: modify YAML file -> assert updated_at changes)*
- [ ] YAML file watcher detects file deletion and removes from SQLite *(integration: delete YAML file -> assert workflow removed or marked invalid)*
- [ ] Invalid YAML files stored with `is_valid=0` and `validation_errors` populated *(unit: parse invalid YAML -> assert is_valid false, errors array)*
- [ ] Workflow run cleanup deletes runs older than retention period *(unit: insert old run -> run cleanup -> assert deleted)*

### WebSocket
- [ ] `workflow-list-request` message returns all workflows *(e2e: connect WS -> send request -> assert workflow-list received)*
- [ ] `workflow-run` message triggers a run and broadcasts `workflow-run-update` *(e2e: send workflow-run -> assert workflow-run-update received with status running)*
- [ ] Step status changes broadcast `workflow-run-update` to all connected clients *(e2e: trigger run -> assert updates received as steps progress)*
- [ ] `workflow-updated` broadcast when YAML file changes *(e2e: modify file -> assert workflow-updated received)*

### UI
- [ ] Workflows page lists all defined workflows with name, description, step count, validity *(e2e: navigate to /workflows -> assert list rendered)*
- [ ] Clicking "Run" on a valid workflow starts a run and shows pipeline diagram *(e2e: click Run -> assert pipeline diagram appears with step nodes)*
- [ ] Pipeline diagram shows correct status colors/icons for each step *(e2e: trigger run -> assert nodes transition through pending/running/completed)*
- [ ] Failed step shown in red with "Resume" button *(e2e: force step failure -> assert red node, resume button visible)*
- [ ] YAML editor shows raw YAML content for a workflow *(e2e: click workflow -> assert YAML content displayed)*
- [ ] Toggle between form builder and YAML editor preserves content *(e2e: edit in form -> toggle to YAML -> assert content matches)*
- [ ] Task queue shows workflow badge on tasks belonging to a workflow run *(e2e: trigger workflow run -> assert task in queue has workflow badge)*
- [ ] Empty state shown when no workflows exist *(e2e: no workflows -> assert empty state message)*
- [ ] Invalid workflow shows error badge and cannot be run *(e2e: invalid workflow in list -> assert error badge, Run button disabled)*

## Test Strategy

- **Unit:** Core workflow engine logic (step advancement, condition evaluation, convention-based paths, YAML parsing/validation, retry logic, timeout handling). WorkflowStore CRUD operations. Mock task completion callbacks. Target: 95%+ coverage of engine and store modules.
- **Integration:** REST API endpoints with real SQLite database. File watcher with temp directory. WebSocket message flow. Engine-to-task-queue integration (engine creates real tasks, asserts task store state). Engine recovery on simulated restart.
- **E2E:** Full workflow lifecycle via Playwright: create workflow file, see it appear in UI, trigger run, watch pipeline diagram update, verify completion. Failed step resume flow. Form builder to YAML round-trip.
- **Fixtures/Data:**
  - `valid-workflow.yaml`: 3-step pipeline (spawn_session, check_file, spawn_session)
  - `invalid-workflow.yaml`: Missing required fields, bad step types
  - `conditional-workflow.yaml`: Steps with `file_exists` and `output_contains` conditions
  - `retry-workflow.yaml`: Step with `maxRetries: 2` for testing retry behavior
  - SQLite test database: In-memory `:memory:` for unit tests, temp file for integration

## Risks & Edge Cases

### Edge Cases
- **Server restart during active step:** Engine must recover. On startup, query `workflow_runs` where `status='running'`. For each, check the current step's task in task queue. If task completed, advance. If task failed/orphaned, handle per retry/halt logic.
- **Concurrent runs of same workflow:** Each run has independent state. No shared mutable state between runs. Output directories are per-run.
- **YAML file deleted while workflow is running:** Run continues (it uses SQLite state, not the file). Workflow definition may show as deleted in UI, but run completes normally. The `workflow_name` is denormalized on the run record.
- **Rapid YAML file edits (editor save churn):** File watcher debounced at 500ms. Only the final state is parsed.
- **Empty workflow (zero steps):** Validation rejects workflows with no steps. Returns 400 with "Workflow must have at least one step."
- **Step references non-existent step name in `check_output`:** Validation catches at parse time. Workflow marked invalid.
- **Task queue full (rate limit):** `spawn_session` step waits in task queue like any other task. Workflow engine simply waits for task to be picked up.
- **Very long workflows (50+ steps):** No technical limit, but UI pipeline diagram should scroll horizontally. Engine processes sequentially, so 50 steps is fine.
- **Circular step references in `check_output`:** Not possible since steps execute sequentially and can only reference prior steps. Validation enforces `check_output.step` refers to an earlier step.
- **Disk full prevents YAML file write from UI:** Return 500 with clear error message. Workflow state in SQLite is unaffected.

### Mitigations/Guardrails
- YAML validation on all inputs (file watcher and API). Invalid workflows cannot be run.
- Per-step retry with configurable max. Default 0 retries for non-spawn steps, inherits task queue default for spawn steps.
- Workflow run status persisted after every step transition (crash-safe).
- File watcher error handling: log and continue, don't crash server.
- Maximum concurrent runs enforced (default 20) to prevent resource exhaustion.
- Scratch directory cleanup: removed after run completes (or after retention period).

### Rollback Plan
- Feature is additive: new tables, new files, new routes. No existing functionality modified except additive column on `tasks` table.
- Config flag `WORKFLOW_ENGINE_ENABLED` (default `true`). Set to `false` to disable all workflow functionality. Engine does not start, routes not registered, file watcher not created.
- If rollback needed: set `WORKFLOW_ENGINE_ENABLED=false`, restart server. All existing task queue functionality unaffected.
- Database tables remain but are unused. No migration rollback needed.

## Rollout Plan & Telemetry

### Feature Flags
- `WORKFLOW_ENGINE_ENABLED`: Master toggle (default `true`). Controls engine startup, route registration, file watcher.
- `WORKFLOW_DIR`: Path to YAML files directory (default `~/.agentboard/workflows/`).
- `WORKFLOW_MAX_CONCURRENT_RUNS`: Max simultaneous runs (default `20`).
- `WORKFLOW_RUN_RETENTION_DAYS`: Auto-cleanup threshold (default `30`).

### Canary Sequence
1. **Phase A (dev only):** Enable locally, run test workflows, verify engine lifecycle
2. **Phase B (single user):** Deploy with `WORKFLOW_ENGINE_ENABLED=true`, monitor logs for errors
3. **Phase C (full rollout):** Default enabled for all users. Monitor for 48 hours.

### Success Metrics
- Workflows created: > 0 within first week
- Workflow runs completed successfully: > 80% success rate
- p95 step transition latency: < 5s (engine poll + task queue pickup)
- Zero server crashes attributed to workflow engine
- Zero data loss on server restart

### Dashboards/Alerts
- Log grep for `[workflow-engine]` errors
- Monitor `workflow_runs` table for stuck runs (status `running` for > 2x longest step timeout)
- Alert on workflow engine panic/crash (process stays up)

### Kill Switch
- Set `WORKFLOW_ENGINE_ENABLED=false` and restart server. All workflow functionality disabled. Existing tasks unaffected.

## Dependencies

### Internal
- **TaskStore** (`src/server/taskStore.ts`): Workflow engine creates tasks via `createTask()`. Needs additive migration for `workflow_run_id` column.
- **TaskWorker** (`src/server/taskWorker.ts`): Engine monitors task completion. May need to expose a completion callback or event, or engine polls task status.
- **Config** (`src/server/config.ts`): New workflow-specific config values.
- **WebSocket broadcast** (`src/server/index.ts`): Engine calls `broadcast()` for real-time updates.
- **ServerContext**: Engine receives context via existing DI pattern.
- **Shared types** (`src/shared/types.ts`): New types for workflows, runs, steps, messages.

### External
- **js-yaml** (or built-in): YAML parse/stringify. Bun may have built-in support; otherwise add `js-yaml` dependency.
- **fs.watch / chokidar**: File watching. Prefer Bun's built-in `fs.watch` to avoid extra dependencies. *(Assumption -- validate Bun fs.watch stability)*

### Migrations
- Additive column `workflow_run_id TEXT` on `tasks` table (same try/catch pattern as `parent_task_id`)
- Additive column `workflow_step_name TEXT` on `tasks` table
- New tables `workflows` and `workflow_runs` created via `CREATE TABLE IF NOT EXISTS`

## Modular Implementation Phases

### Phase 1: Shared Type Definitions
- Define all TypeScript types in `src/shared/types.ts`: `WorkflowDefinition`, `WorkflowStep`, `WorkflowStepType`, `StepCondition`, `WorkflowRun`, `StepRunState`, `WorkflowStatus`
- Add new `ServerMessage` and `ClientMessage` union members for workflow WebSocket messages
- Compilation check: `bun run typecheck`

### Phase 2: Configuration
- Add workflow config values to `src/server/config.ts`: `workflowEngineEnabled`, `workflowDir`, `workflowMaxConcurrentRuns`, `workflowRunRetentionDays`, `workflowPollIntervalMs`
- Follow existing env var parsing pattern
- Compilation check: `bun run typecheck`

### Phase 3: YAML Schema & Validation
- Create `src/server/workflowSchema.ts`: YAML parse function, validation logic, schema types
- Validate: required fields, valid step types, valid condition types, unique step names, `check_output` references valid prior step, non-empty steps array
- Return structured validation result with error array
- Unit tests for valid/invalid YAML parsing
- Compilation check: `bun run typecheck && bun run test`

### Phase 4: Database Schema & Store
- Create `src/server/workflowStore.ts` following `taskStore.ts` pattern
- `initWorkflowStore(db)`: Creates `workflows` and `workflow_runs` tables
- CRUD for workflows: `createWorkflow`, `getWorkflow`, `getWorkflowByName`, `updateWorkflow`, `deleteWorkflow`, `listWorkflows`
- CRUD for runs: `createRun`, `getRun`, `updateRun`, `listRuns`, `listRunsByWorkflow`, `getRunningRuns`, `deleteOldRuns`
- Additive migration for `tasks` table: `workflow_run_id`, `workflow_step_name` columns
- Unit tests for all store operations
- Compilation check: `bun run typecheck && bun run test`

### Phase 5: Workflow Engine Core
- Create `src/server/workflowEngine.ts` following `taskWorker.ts` pattern
- `createWorkflowEngine(ctx, workflowStore, taskStore)` factory function
- Core loop: poll for running workflows, check current step's task status, advance pipeline
- Step execution logic per type: `spawn_session` (create task), `check_file` (check existence), `delay` (setTimeout), `check_output` (read file + check content)
- Condition evaluation: `file_exists`, `output_contains`
- Convention-based paths: engine prepends scratch directory to `spawn_session` prompts; steps use explicit `output_path` fields
- Retry logic for `spawn_session` steps (reuse task retry count)
- Run lifecycle: pending -> running -> completed/failed/cancelled
- Server restart recovery: `recoverRunningWorkflows()` called on startup
- Unit tests with mocked task store
- Compilation check: `bun run typecheck && bun run test`

### Phase 6: YAML File Watcher
- Create `src/server/workflowFileWatcher.ts`
- Watch `WORKFLOW_DIR` for .yaml/.yml file changes
- On change: parse, validate, upsert to workflow store
- On delete: remove from workflow store (or mark invalid)
- Debounce at 500ms
- Error handling: log parse errors, continue watching
- Create directory if it doesn't exist on startup
- Integration tests with temp directory
- Compilation check: `bun run typecheck && bun run test`

### Phase 7: REST API Endpoints
- Create `src/server/handlers/workflowHandlers.ts` (or add to `httpRoutes.ts`)
- Register all REST endpoints from API table
- Input validation on all endpoints
- Error responses follow standard format
- Integration tests against real SQLite
- Compilation check: `bun run typecheck && bun run test`

### Phase 8: WebSocket Integration
- Add workflow message handlers to WebSocket dispatch in `src/server/index.ts`
- Create `src/server/handlers/workflowWsHandlers.ts`
- Handle: `workflow-list-request`, `workflow-run-list-request`, `workflow-run`, `workflow-run-resume`, `workflow-run-cancel`
- Engine broadcasts `workflow-run-update` on step transitions
- Engine broadcasts `workflow-updated` on file watcher changes
- Integration tests for WebSocket message flow
- Compilation check: `bun run typecheck && bun run test`

### Phase 9: Server Wiring
- Wire workflow engine, store, file watcher, and handlers into `src/server/index.ts`
- Respect `WORKFLOW_ENGINE_ENABLED` flag
- Initialize workflow store alongside task store
- Start file watcher after store init
- Start engine after file watcher
- Cleanup on shutdown
- Integration test: server starts with workflow engine enabled
- Compilation check: `bun run typecheck && bun run test`

### Phase 10: Client Type Definitions & API Client
- Add workflow types to client-side TypeScript
- Create `src/client/stores/workflowStore.ts` (Zustand store for workflow state)
- WebSocket message handlers in `App.tsx` for workflow messages
- HTTP client functions for REST endpoints
- Compilation check: `bun run typecheck`

### Phase 11: Pipeline Diagram Component
- Create `src/client/components/PipelineDiagram.tsx`
- Render step nodes as connected boxes with status indicators
- Status colors: gray (pending), blue (running), green (completed), red (failed), yellow (skipped)
- Icons: clock (pending), spinner (running), checkmark (completed), X (failed), skip-arrow (skipped)
- Keyboard navigation between nodes
- Horizontal scroll for long pipelines
- Unit tests for rendering states
- Compilation check: `bun run typecheck && bun run test`

### Phase 12: Workflow List & Detail Pages
- Create `src/client/components/WorkflowList.tsx`: List all workflows with name, description, step count, status badge
- Create `src/client/components/WorkflowDetail.tsx`: Show YAML content, run history, "Run" button
- Empty state component for no workflows
- Error badge for invalid workflows (run button disabled)
- Route these as views accessible from the main UI (sidebar link or keyboard shortcut)
- Compilation check: `bun run typecheck && bun run test`

### Phase 13: Workflow Editor (Form Builder + YAML Toggle)
- Create `src/client/components/WorkflowEditor.tsx`: Form-based step editor
- Step type dropdown, dynamic fields per type
- Add/remove/reorder steps
- YAML raw editor view (textarea or code editor)
- Toggle between form and YAML preserving content
- Save writes to REST API (which writes YAML file)
- Compilation check: `bun run typecheck && bun run test`

### Phase 14: Monitoring Panel & Task Queue Integration
- Create `src/client/components/WorkflowPanel.tsx`: Right-side panel tab for monitoring active runs
- Show active runs with pipeline diagrams
- Add workflow badge to `TaskItem.tsx` for tasks belonging to workflow runs
- Wire panel toggle into `App.tsx` (keyboard shortcut)
- Compilation check: `bun run typecheck && bun run test`

### Phase 15: End-to-End Testing & Deployment Preparation
- E2E tests via Playwright: full workflow lifecycle (create file, see in UI, run, monitor, complete)
- E2E test: failed step resume flow
- E2E test: form builder round-trip
- Verify server restart recovery
- Verify feature flag disable path
- Final lint + typecheck + full test suite
- `bun run lint && bun run typecheck && bun run test`

## Open Questions

- **Bun `fs.watch` stability:** Is Bun's built-in `fs.watch` stable enough for production use, or should we use `chokidar`? Validate during Phase 6 implementation.
- **YAML library:** Does Bun have built-in YAML support, or do we need `js-yaml`? Check during Phase 3.
- **Task completion callback vs polling:** Should the engine poll for task completion (simpler, matches existing pattern) or hook into task worker's completion path (more responsive)? Recommend starting with polling and optimizing later if latency is an issue.
- **Pipeline diagram library:** Should we use a library (e.g., reactflow) for the pipeline diagram or build a simple custom SVG/CSS component? For MVP, a simple custom component (flex boxes with connecting lines) is sufficient. Consider reactflow for stretch.

## Modular Work-Order Seed (phase-organized titles only)

### Data Foundation Phases:
- Phase 1: Define shared TypeScript types for workflows, runs, steps, and WebSocket messages
- Phase 2: Add workflow configuration values to server config
- Phase 3: Implement YAML parsing and schema validation module
- Phase 4: Create SQLite workflow store with CRUD operations for workflows and runs

### Business Logic Phases:
- Phase 5: Implement workflow engine core (step execution, condition evaluation, convention-based paths, recovery)
- Phase 6: Implement YAML file watcher with debounce and error handling

### API Layer Phases:
- Phase 7: Implement REST API endpoints for workflow and run management
- Phase 8: Implement WebSocket handlers for real-time workflow updates
- Phase 9: Wire workflow engine, store, watcher, and handlers into server startup

### Frontend Foundation Phases:
- Phase 10: Create client-side Zustand store, types, and WebSocket handlers for workflows

### Frontend Integration Phases:
- Phase 11: Build pipeline diagram component with status visualization
- Phase 12: Build workflow list and detail view pages
- Phase 13: Build workflow editor with form builder and YAML toggle
- Phase 14: Build monitoring panel and task queue workflow badge integration

### Testing & Deployment Phases:
- Phase 15: End-to-end testing and deployment preparation
