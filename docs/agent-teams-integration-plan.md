# Agent Teams + Agentboard Integration Plan

**Status**: Discovery / Ideation
**Date**: 2026-02-06
**Source**: Conversation analysis of Claude Code Agent Teams announcement + Agentboard architecture review

---

## 1. Claude Code Agent Teams — Feature Summary

Agent Teams is an experimental Claude Code feature that allows coordinating multiple Claude Code instances as a team within a single session.

### How It Works

- One session acts as **team lead**, spawning and coordinating **teammates**
- Each teammate is a full, independent Claude Code session with its own context window
- Teammates communicate via a **mailbox** (direct messaging) and coordinate via a **shared task list**
- The lead can operate in **delegate mode** (coordination-only, no implementation)
- Teammates can **self-claim** tasks from the shared task list

### Enable

```json
// settings.json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

### Display Modes

- **In-process**: All teammates in one terminal. Shift+Up/Down to select, type to message.
- **Split panes**: Each teammate gets own pane (requires tmux or iTerm2).
- Config: `"teammateMode": "in-process" | "tmux" | "auto"` in settings.json

### Key Capabilities

| Capability | Detail |
|---|---|
| Inter-agent messaging | Teammates message each other directly, not just back to lead |
| Shared task list | Self-claiming with dependency tracking |
| Plan approval | Lead can require teammates to plan before implementing |
| Delegate mode | Lead restricted to coordination-only tools (Shift+Tab to toggle) |
| Direct user interaction | Message individual teammates mid-work |
| Broadcast | Lead can message all teammates simultaneously |

### Limitations (Current)

| Limitation | Impact |
|---|---|
| **No nested teams** | Teammates cannot spawn their own teams |
| **One team per session** | Must clean up before starting a new team |
| **No session resumption** | `/resume` and `/rewind` don't restore in-process teammates |
| **Task status can lag** | Teammates sometimes fail to mark tasks complete |
| **Shutdown can be slow** | Teammates finish current tool call before stopping |
| **Lead is fixed** | Can't promote a teammate or transfer leadership |
| **Permissions set at spawn** | All teammates inherit lead's permissions |
| **Split panes need tmux/iTerm2** | Not supported in VS Code terminal, Windows Terminal, Ghostty |

### Comparison: Agent Teams vs Subagents (Task Tool)

| | Subagents | Agent Teams |
|---|---|---|
| Context | Own window; results return to caller | Own window; fully independent |
| Communication | Report back to parent only | Message each other directly |
| Coordination | Parent manages all work | Shared task list + self-coordination |
| Nesting | Cannot spawn sub-subagents | Cannot spawn sub-teams |
| Best for | Focused tasks where only result matters | Complex work requiring discussion |
| Token cost | Lower (results summarized back) | Higher (each teammate is separate instance) |

### Best Use Cases for Teams

- **Research & review**: Multiple angles explored simultaneously, findings challenged
- **Competing hypotheses debugging**: Investigators argue and converge
- **New independent modules**: Each teammate owns a piece
- **Cross-layer coordination**: Frontend / backend / tests each owned by different teammate
- **Implementation with shared interfaces**: Real-time interface negotiation between implementors

### Documentation Reference

Full docs available at: `https://code.claude.com/docs/llms.txt` (index)
Feature page: Claude Code docs > "Orchestrate teams of Claude Code sessions"

---

## 2. Agentboard — Existing Capabilities

Agentboard is our custom web-based tmux orchestration system for managing multiple AI agent sessions.

### Architecture

- **Tech stack**: Bun + Hono + SQLite (server), React + xterm.js + Zustand (client)
- **Codebase**: ~34,000 lines TypeScript
- **Location**: `/Users/andrewcooke/Ai_workflow/claude-orchestrator/agentboard/`

### Core Systems

#### Session Management
- Spawns Claude/Codex instances in tmux windows
- Tracks sessions in SQLite with status inference from log parsing
- Session resurrection for pinned sessions on restart
- Remote access from any device (mobile-optimized UI)

#### Task Queue (`taskStore.ts` + `taskWorker.ts`)
- SQLite-backed task queue with priority ordering
- Concurrency control: max 5 concurrent (configurable `TASK_MAX_CONCURRENT`)
- Rate limiting: max 30/hour (configurable `TASK_RATE_LIMIT_PER_HOUR`)
- Auto-retry with cooldown (30s between attempts)
- Per-task timeouts (default 1800s)
- Task chaining via `followUpPrompt`
- Reusable task templates with variable substitution
- Output capture via `tee` + `.done` sentinel files

#### Workflow Engine (`workflowEngine.ts`)
- YAML-defined multi-step workflows
- Step types: `spawn_session`, `check_file`, `delay`, `check_output`
- Conditional step execution (`file_exists`, `output_contains`)
- Per-step retry and timeout
- Result collection via `result_file`
- File watching for hot-reload of YAML definitions
- Max 20 concurrent workflow runs

#### Inter-Agent Communication (Current)
- File-based: Steps write output/result files, subsequent steps read them
- Task chaining: `followUpPrompt` creates child tasks
- Session memory: MCP `session_start()` for shared memory across workflow steps
- WebSocket broadcasts for UI updates
- **No real-time inter-agent messaging** (this is what Agent Teams adds)

### Key Files

| File | Purpose |
|---|---|
| `src/server/index.ts` | Server entry point |
| `src/server/SessionManager.ts` | tmux window management |
| `src/server/taskStore.ts` | Task queue SQLite CRUD |
| `src/server/taskWorker.ts` | Background task dequeue/spawn/monitor |
| `src/server/workflowEngine.ts` | YAML workflow execution |
| `src/server/workflowSchema.ts` | Workflow YAML validation |
| `src/server/config.ts` | 50+ env vars configuration |
| `~/.agentboard/workflows/` | YAML workflow definitions |
| `~/.agentboard/agentboard.db` | SQLite persistence |

---

## 3. The Combined Architecture Vision

### Core Insight

Agentboard solves the exact limitations Agent Teams has. Together they enable **hierarchical multi-team orchestration** — the "engineering manager" pattern that neither system can do alone.

| Agent Teams Limitation | How Agentboard Solves It |
|---|---|
| No nested teams | Agentboard is the outer orchestration layer |
| One team per session | Agentboard manages N sessions, each can be a team lead |
| No session resumption | Agentboard has session resurrection + retry |
| No cross-team coordination | Workflow engine + file-based handoffs |
| No monitoring across teams | Web UI with real-time status |

### Target Architecture

```
Agentboard (meta-orchestrator, web UI, SQLite persistence)
│
├── Workflow Step 1: "Planning Team"
│   └── Agent Team Lead (tmux window)
│       ├── Teammate: feature-planner
│       ├── Teammate: devil's-advocate / critic
│       └── Teammate: technical-feasibility
│       → Output: feature_brief.md, work_orders/
│
├── Workflow Step 2a: "Implementation Team A" ──┐ (parallel)
│   └── Agent Team Lead (tmux window)           │
│       ├── Teammate: WO-1 implementor          │
│       ├── Teammate: WO-2 implementor          │
│       └── Teammate: integration-watcher       │
│                                               │
├── Workflow Step 2b: "Implementation Team B" ──┘
│   └── Agent Team Lead (tmux window)
│       ├── Teammate: WO-3 implementor
│       └── Teammate: WO-4 implementor
│       → Output: code changes, test results
│
├── Workflow Step 3: "Review Team"
│   └── Agent Team Lead (tmux window)
│       ├── Teammate: security-reviewer
│       ├── Teammate: performance-reviewer
│       └── Teammate: correctness-reviewer
│       → Output: review findings, PASS/FAIL verdict
│
└── Workflow Step 4: "Integration + Commit"
    └── Single Claude instance
        → Merge, final build check, commit
```

### How It Works

1. **Agentboard workflow** defines the phase sequence in YAML
2. Each phase **spawns an Agent Team lead** as a tmux window via the task queue
3. The lead's prompt instructs it to **create a team** with specific roles
4. Teammates **communicate with each other** in real-time (Agent Teams mailbox)
5. The lead writes **output artifacts** to conventional file paths
6. Agentboard's `check_file` step **detects completion** and advances to next phase
7. Next phase's team lead is spawned with **previous phase artifacts as context**
8. **If a team fails**, Agentboard's retry logic re-spawns it

### Phase Handoff Mechanism

```
Planning Team writes:
  .workflow/artifacts/feature_brief.md
  .workflow/artifacts/work_orders/*.yaml

Agentboard check_file detects → spawns Implementation Teams

Implementation Teams write:
  .workflow/artifacts/impl_done.json (status + changed files)

Agentboard check_file detects → spawns Review Team

Review Team writes:
  .workflow/artifacts/review_verdict.json (PASS/FAIL + findings)

Agentboard condition checks verdict → spawns Integration step (or loops back)
```

### Example Workflow YAML

```yaml
name: Full Feature Pipeline
description: Multi-team feature development with planning, implementation, and review phases
variables:
  - name: project
    type: path
    required: true
  - name: feature_spec
    type: string
    required: true

steps:
  - name: planning-team
    type: spawn_session
    projectPath: "{{ project }}"
    timeoutSeconds: 3600
    prompt: |
      Create an agent team of 3 to plan this feature:

      Feature spec: {{ feature_spec }}

      Teammates:
      - "planner": Write a detailed feature brief with acceptance criteria
      - "critic": Challenge every assumption, find edge cases and risks
      - "architect": Validate technical feasibility against the codebase

      Require plan approval before any teammate finalizes.
      Have them debate until consensus.

      Write final output to .workflow/artifacts/feature_brief.md
      Write work orders to .workflow/artifacts/work_orders/

      When done, clean up the team and exit.

  - name: wait-for-brief
    type: check_file
    path: "{{ project }}/.workflow/artifacts/feature_brief.md"
    max_age_seconds: 120

  - name: implementation-team
    type: spawn_session
    projectPath: "{{ project }}"
    timeoutSeconds: 7200
    prompt: |
      Read the feature brief at .workflow/artifacts/feature_brief.md
      Read work orders from .workflow/artifacts/work_orders/

      Create an agent team. Assign one teammate per work order.
      Add one "integration-watcher" teammate who:
        - Monitors interface compatibility across implementors
        - Flags conflicts early
        - Runs build checks periodically

      Use delegate mode - only orchestrate, don't implement yourself.

      Teammates should coordinate on shared interfaces via messaging.

      When all work orders are complete and building:
        Write status to .workflow/artifacts/impl_done.json
        Clean up team and exit.

  - name: wait-for-implementation
    type: check_file
    path: "{{ project }}/.workflow/artifacts/impl_done.json"
    max_age_seconds: 120

  - name: review-team
    type: spawn_session
    projectPath: "{{ project }}"
    timeoutSeconds: 3600
    prompt: |
      Read .workflow/artifacts/feature_brief.md for requirements.
      Read .workflow/artifacts/impl_done.json for what was implemented.

      Create a review team of 3 specialists:
      - "security": Focus on auth, injection, data exposure
      - "performance": Focus on N+1 queries, allocations, concurrency
      - "correctness": Focus on spec alignment, edge cases, test coverage

      Have them debate findings and challenge each other.

      Write final verdict to .workflow/artifacts/review_verdict.json:
        { "verdict": "PASS" | "FAIL", "findings": [...] }

      Clean up team and exit.

  - name: wait-for-review
    type: check_file
    path: "{{ project }}/.workflow/artifacts/review_verdict.json"
    max_age_seconds: 120

  - name: integration-commit
    type: spawn_session
    projectPath: "{{ project }}"
    timeoutSeconds: 1800
    condition:
      type: output_contains
      step: review-team
      contains: "PASS"
    prompt: |
      Read .workflow/artifacts/review_verdict.json

      If verdict is PASS:
        - Run final build check
        - Run full test suite
        - Commit all changes with comprehensive commit message
        - Write summary to .workflow/artifacts/pipeline_complete.json

      If verdict is FAIL:
        - Write failure report to .workflow/artifacts/pipeline_failed.json
        - Include review findings and suggested fixes
```

---

## 4. Considerations and Open Questions

### Token Cost

- Each Agent Team teammate is a separate Claude instance with full context
- A 3-teammate planning team + 5-teammate implementation team + 3-teammate review team = 11+ concurrent Claude sessions at peak
- Plus the team leads themselves
- Agentboard's rate limiting (30/hour) provides some guard rails
- **Open question**: What's the realistic token budget for a full pipeline run?

### Reliability

- Agent Teams is experimental with known issues (task status lag, slow shutdown, no resumption)
- Team leads may fail to clean up properly, leaving orphaned teammates
- **Mitigation**: Agentboard's timeout detection + retry logic handles team-level failures
- **Open question**: How reliably do team leads create teams from prompt instructions?

### File Conflict Management

- Implementation teammates working in the same worktree can overwrite each other
- Work order boundaries must ensure clean file ownership per teammate
- **Option A**: Git worktrees per implementation team (isolation but merge complexity)
- **Option B**: Strict file-ownership rules in team lead prompts (simpler but relies on prompt adherence)
- **Open question**: Does Agent Teams have any built-in conflict detection?

### Agentboard Changes Needed

- **Workflow step type**: May need a dedicated `spawn_agent_team` step type (vs generic `spawn_session`)
  - Could auto-inject the `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var
  - Could add team-aware completion detection (all teammates shut down, not just lead idle)
- **Team monitoring**: Extend session tracking to understand team structure (lead + N teammates)
- **Artifact management**: Standardize the `.workflow/artifacts/` directory per workflow run
- **Parallel steps**: The workflow engine may need explicit support for parallel step groups (2a + 2b)

### Prompt Engineering

- Team lead prompts need to be very precise about:
  - How many teammates to spawn and their roles
  - Whether to use delegate mode
  - What output artifacts to produce and where
  - When and how to clean up
- **Open question**: Should we build prompt templates for common team patterns?

### Comparison to Current Subagent Orchestration

The existing setup (orchestrator agents dispatching subagents via Task tool) already handles much of this. The key value-add of the combined system is:

1. **Intra-team real-time communication** — subagents are blind to each other
2. **Self-claiming task lists** — vs explicit dispatch by orchestrator
3. **Debate and convergence** — particularly valuable for planning and review
4. **Reduced prompt engineering** — team leads coordinate autonomously vs needing precise dispatch logic

For pure implementation with well-specified work orders and clean boundaries, the existing subagent approach may be more cost-effective.

---

## 5. Suggested Next Steps

1. **Enable Agent Teams** and manually test team creation/coordination reliability
2. **Prototype a simple two-phase workflow**: Planning team → single implementor
3. **Measure token cost** for a real team-based workflow vs equivalent subagent approach
4. **Evaluate if Agentboard needs a `spawn_agent_team` step type** or if `spawn_session` with prompt engineering suffices
5. **Design artifact directory conventions** for inter-team handoffs
6. **Stress-test team cleanup** — what happens when leads don't clean up? Can Agentboard detect and recover?
