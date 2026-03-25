# Minion Swarm System — Agentboard v2

> Redesign agentboard workflow execution from long Claude Code sessions to a minion swarm of short-lived, well-scoped agents. One unified work order schema, a Rust executor with minimal tool-use loop, and a dispatcher service managing dependency graphs, gates, and escalation.

**Priority:** High
**Tags:** agentboard, workflow, minion, swarm, rust
**Planner ID:** `a71d2d2e-e0eb-4592-91b3-1595b2a2a157`

---

## Hard Constraints

- **Clean and modular:** Every component independently testable, replaceable, and usable outside the swarm context. The executor is "run a model with tools." The gates are "verify code quality." The dispatcher is "run tasks with deps." If a component can't be explained in one sentence, it's too complex. No monoliths. No 5800-line files. This system must not become another ambitious feature that gets lost because it's too coupled and brittle to maintain.
- **Opus execution:** Must run via Claude Code subscription, not API
- **Models (Phase 1):** GLM + Anthropic only; system designed model-agnostic for future additions (MiniMax, Codex, MiMo, DeepSeek)
- **Build approach:** Fresh build, not refactor of dagEngine/workflowEngine
- **Reuse:** Keep workflowStore (SQLite), shared types, workflowFileWatcher
- **Agent philosophy:** Short-lived scoped agents over long interactive sessions — long CC sessions create more bugs due to context drift and compaction artifacts

## Risks

1. **Minimal loop executor may need more tools than anticipated for complex WUs**
   *Mitigation:* Start with 5 tools (read_file, write_file, find_symbol, find_references, run_command), add intern tools as needed. Always have CC escalation path.

2. **Opus decomposition quality is the bottleneck — bad WOs cascade**
   *Mitigation:* MCP-enforced WO schema with validation. Opus commits interfaces/stubs before WOs fire. Intern pre-flight checks.

3. **Context assembly may miss files the agent needs**
   *Mitigation:* intern_context for deterministic discovery + agent can read_file during execution. Two-retry + escalation catches gaps.

## External Dependencies

- code-intelligence MCP (intern tools for context assembly, symbol lookup, build checking)
- ticket-system MCP (for maintenance/detection workflow)
- planner MCP (optional, for spec creation)
- agentboard task API (for CC escalation — spawning Opus Claude Code sessions)

---

## Architecture Overview

### Execution Tiers

| Tier | When | How |
|------|------|-----|
| **Attended** | Opus planning, architecture, debugging, review | Claude Code (subscription) |
| **Minimal loop** | GLM/Sonnet implementation WUs needing 2-3 file reads | Rust executor, 5-10 tool-use turns, hard cap |
| **One-shot** | Truly mechanical tasks (apply pattern, boilerplate) | Single API call, structured diff response |

### Data Flow

```
You (human) → Opus in Claude Code (plans, writes interfaces, commits)
    → WO MCP (creates validated work orders)
        → Dispatcher (watches for new WOs, resolves dependencies)
            → Context Assembly (intern tools curate payload)
                → Rust Executor (minimal loop, calls model API)
                    → Structured Diffs (applied to working tree)
                        → Deterministic Gates (compile, lint, typecheck, tests)
                            → Pass? Auto-commit, unblock dependents
                            → Fail? Retry → Escalate → Flag human
```

---

## Group 1: Work Order Schema & MCP

### Work Order Schema [STATUS: designing]

Single unified schema for all workflow types (feature, fix, refactor, review). Differences are which fields are populated, not different schemas. MCP-enforced validation at creation time.

**Key sections:**
- **Identity:** id, group_id, title, description
- **Task type:** implement | test | fix | refactor | review
- **Context refs:** interface_files, reference_files, input_files — all pointing to committed code on disk, NEVER descriptions
- **Dependencies:** depends_on (WO IDs)
- **Gates:** compile/lint/typecheck/tests with scope and expectations
- **Execution config:** mode (attended|unattended), model, max_retries, timeout
- **Escalation rules:** after_retries, escalate_to model, include error context
- **Output config:** commit prefix, branch strategy

**Example WO:**

```yaml
id: WO-001
group_id: feat-health-check
title: "Implement health check handler"
description: |
  Implement the GET /health endpoint handler
  matching the interface in src/server/health.ts

task: implement
scope: src/server/handlers/

interface_files:
  - src/server/health.ts
  - src/shared/types.ts
reference_files: []
input_files:
  - src/server/index.ts
intern_context: true

depends_on: []

gates:
  compile: true
  lint: true
  typecheck: true
  tests:
    run: true
    scope: relevant
    specific: []
    expect: pass

execution:
  mode: unattended
  model: glm
  max_retries: 2
  timeout_minutes: 15

escalation:
  enabled: true
  after_retries: 2
  to: opus
  mode: attended
  include_error_context: true

output:
  commit: true
  commit_prefix: "feat"
  branch: auto
```

### Work Order MCP [STATUS: planned]

MCP server for CRUD on work orders. Validates schema at creation. Opus in CC uses this to create WOs instead of freeform YAML — prevents inconsistencies.

**Operations:** create_wo (validates), list_wos (by group/status), get_wo, update_wo_status, create_group (links WOs for review).

**Validation enforces:** no circular deps, referenced interface_files exist on disk, gate config is valid.

**Open decision:** Extend existing planner MCP or build new? Planner MCP already has plan creation + spec export + validation patterns. Could add WO tools alongside. Or keep separate — planner for architecture plans, WO MCP for execution specs. Could also be built into agentboard itself as API endpoints that Opus calls via MCP adapter.

### Context Reference Design [STATUS: decided]

WOs reference COMMITTED FILES on disk, never descriptions. This is the core drift-prevention mechanism.

- **interface_files:** Opus-committed type stubs, trait defs, function signatures
- **reference_files:** For refactors, the golden example file
- **input_files:** Existing code the agent needs
- **intern_context:** Boolean — if true, dispatcher calls intern tools to discover additional context (file_dependencies, find_references on interface files)

Agent always works against **latest git HEAD** — dispatcher commits each completed WO before firing next batch.

---

## Group 2: Rust Executor (Minimal Loop Agent)

### Minimal Loop Agent [STATUS: planned, LANGUAGE: Rust]

Rust binary. Takes one WO + assembled context payload. Calls model API with tool definitions. Loops until agent emits 'done' signal or hits iteration cap (e.g. 10 turns). Returns structured diffs (anchor-based, not unified diff — models are bad at line numbers). For 'create' actions returns full files. Hard timeout. Stateless — no memory between invocations. One WO in, diffs out.

**Performance note:** Speed advantage over Claude Code: no project indexing, no compaction, no permission negotiation, no interactive tool loop. For well-specified WUs, execution drops from minutes (CC spin-up + thinking) to seconds (API call + tool loop). At 20 parallel WOs this is the difference between 1 hour and 5 minutes for the execution phase.

### Executor Tool Set [STATUS: decided]

Executor is an **MCP client** to code-intelligence. No reimplementation of search/symbols/TreeSitter.

**MCP-proxied tools (code-intelligence):**

| Agent Tool | Proxies To | Purpose |
|-----------|-----------|---------|
| `search` | `intern_search` | Primary catch-all — auto-routes to grep/find_symbol/semantic_search |
| `read_file` | `intern_read_file` | Focused extraction — returns relevant symbols, not whole file |
| `compile_check` | `intern_compile_check` | Check if code compiles, get classified errors |
| `find_symbol` | `find_symbol` | Escalation if intern misses |
| `find_references` | `find_references` | Escalation — all usages of a symbol |
| `file_skeleton` | `get_file_skeleton` | Quick structure overview |

**Local tools (executor-native):**

| Agent Tool | Purpose |
|-----------|---------|
| `write_file` | Produce structured diffs (anchor-based) |
| `run_command` | Shell commands (type-check, lint) with timeout+sandbox |
| `done` | Signal completion |

**New MCP tool needed:** `apply_diffs` on code-intelligence for TreeSitter-aware diff application. Executor collects agent's diffs, sends to code-intelligence to apply.

### Structured Diff Output [STATUS: decided]

Agents return diffs, not full files. Reasons:
- Saves tokens (500-line file, 10-line change = 490 wasted output tokens with full file)
- Prevents hallucinated drift (models subtly reformat, reorder imports)
- Enables parallel agents on same file via sequential patch application

**Format:**
```json
{
  "file": "src/pipeline/ingest.rs",
  "action": "replace",
  "anchor": "fn process_batch",
  "content": "... the new code ..."
}
```

Actions: create | replace | insert_after. Anchoring is AST-aware via TreeSitter where possible. For create actions, full file content. The executor's harness applies diffs deterministically. Same concept as CC's str_replace but we own it.

### Model Integration [STATUS: decided]

**Executor speaks Anthropic messages API only, pointed at existing proxy (`localhost:8090`).** No OpenLLM or OpenAI-compat layer needed.

The proxy (`/home/andrew-cooke/tools/claude_proxy`) already handles:
- **Model-based routing** via `model_prefixes` in config.yaml (e.g. `glm-*` → Z.AI, `claude-*` → Anthropic)
- **ClickHouse logging** — every call logged to `claude_metrics.llm_calls` automatically
- **Auth injection** — per-upstream API keys
- **Context filtering** — dedup, retry breaking, compression

Executor sets the `model` field in the request body. Proxy routes + logs. **Zero logging code in the executor.**

To add future models, just add an upstream entry to proxy config.yaml:
```yaml
minimax:
  forward_to: https://api.minimax.chat/v1
  model_prefixes: ["minimax-"]
deepseek:
  forward_to: https://api.deepseek.com/v1
  model_prefixes: ["deepseek-"]
```

---

## Group 3: Dispatcher Service

### Dispatcher Core [STATUS: planned]

New service in agentboard. Core loop:

1. Watch for new WOs
2. Build dependency graph
3. Fire WOs with no unmet deps in parallel
4. When WO completes → run gates → mark done → commit if gates pass → check what's now unblocked → fire those
5. When WO fails → retries per escalation rules (same model retry → stronger model → attended CC → flag human)
6. When all WOs in a group complete → trigger review WO
7. Broadcast status to agentboard UI + Telegram

State stored in SQLite (reuse workflowStore patterns).

**Open decisions:**
1. Is the dispatcher TS (inside agentboard process) or standalone Rust daemon?
2. How does Opus CC escalation work mechanically — call existing agentboard task API to spawn CC tmux pane?
3. Concurrency limits — max parallel executors, per-model rate limiting

### Dependency Resolution [STATUS: decided]

- `depends_on` field on WOs
- Empty = fire immediately (parallel with other no-dep WOs)
- Dispatcher topologically sorts and tracks completion
- Every completed WO commits to git before dependents fire — dependents always see latest HEAD
- Import graph from intern `file_dependencies` can auto-infer implicit deps that Opus missed
- No circular deps (validated at WO creation by MCP)

### Escalation Engine [STATUS: designing]

Per-WO escalation rules. Flow:

```
attempt with assigned model (e.g. GLM)
  → on failure, retry up to max_retries with same model
    → escalate to stronger model (e.g. Sonnet unattended)
      → escalate to Opus via CC (attended, uses existing agentboard task API)
        → flag for human review
```

- Error context from each failed attempt is passed to the next tier
- Two-attempt cap per tier (Stripe lesson: if it can't fix in 2 tries, a 3rd won't help)
- **Interface contract violation** (agent says interface is insufficient) escalates directly to Opus for interface update + re-fire affected WOs. This is NOT a retry — it's a design feedback loop.

### Context Assembly [STATUS: designing]

Before executor runs, dispatcher assembles context payload using intern tools:

- `intern_read_file(path, focus)` for focused symbol extraction from interface_files
- `intern_search` to discover related code not listed in WO
- `file_dependencies` to find imports
- `intern_compile_check` as pre-flight

This is **DETERMINISTIC context assembly** — the agent gets curated, focused payload, not a bag of raw files. Replaces the "agent explores the codebase" pattern with "system provides exactly what agent needs."

### Runtime State & Observability [STATUS: planned]

Per-WO runtime state in SQLite:
- status (pending/running/completed/failed/escalated)
- gate results (compile/lint/typecheck/tests — each pass/fail/pending)
- retry count
- error context from failures
- timestamps, model used, token counts

Replaces blackboard + WorkCard concepts from the old system.

**Group-level derived state:** X/Y WOs complete, Z running, W failed.

API endpoint for agentboard UI to show snapshot view. Telegram notifications on completion/failure/escalation.

---

## Group 4: Preparation Layer (Opus in CC)

### Feature Preparation [STATUS: revised — three-model pipeline]

**Three-model pipeline: Opus thinks, Codex shapes, GLM executes.**

1. **Opus in CC** (attended) — architecture decisions, high-level plan, what modules exist and why
2. **Codex headless** (unattended) — generates the actual interface files, stubs, type defs based on Opus's plan. Codex reads existing codebase patterns first, produces simpler structures, catches over-engineering. Prevents Opus's tendency to over-architect (three generic params where a concrete type would do).
3. **Opus quick review in CC** (attended, fast) — sanity check interfaces, commit
4. **WO creation** via MCP

Opus decides **what** to build. Codex decides **how** the interfaces look. Opus validates. Adds ~5 min but prevents cascading complexity from over-architected interfaces that every downstream WO inherits.

**Critical caveat:** Separate test-writing WOs and implementation WOs (different contexts prevent self-grading). Same context = agent grades its own homework. Test agent reads WO spec and thinks "what should fail." Impl agent reads spec + test file PUBLIC INTERFACE (signatures, types, imports) but NOT assertion logic. Strip assertions mechanically with AST pass before handing to impl agent.

### Fix Preparation [STATUS: decided]

Opus diagnoses root cause (attended, needs full CC for exploration). Writes a regression test that **FAILS** against current code, commits it.

Creates single WO: task=fix, input_files includes buggy file + committed regression test, gates.tests.scope=specific pointing at regression test.

If test doesn't fail → diagnosis is wrong, go back.

For batch fixes (Monday morning, 8 tickets): Opus diagnoses all sequentially, then fix WOs fan out simultaneously.

### Refactor Preparation [STATUS: decided]

Opus implements the reference in **ONE** file, commits it. Then creates manifest of all target files with quirk notes.

WO-001 is the reference impl (already done). WO-002..N each have `reference_files` pointing to committed golden example, `input_files` pointing to their target, `depends_on=[WO-001]`. All fan out in parallel since they only depend on the reference.

Consistency: agents read REAL committed code, not descriptions. Opus consistency review at end catches the agent that did something slightly different.

**Caveat:** Implicit ordering between target files — if file 3 imports from file 7 which imports from file 12, order matters even though they all only depend on the reference WO. `intern file_dependencies` can detect this and the WO MCP should auto-infer dependency edges from the import graph, not rely on Opus getting them right.

### Maintenance/Detection [STATUS: existing]

Detector-driven, no Opus preparation needed. minion-detect runs oxlint/tsc/clippy/bun-test, creates tickets. Tickets become self-contained fix WOs. Can be cron-triggered. Existing system works well for this — adapt to create WOs instead of tickets+CC tasks. Sweep stale tickets still needed.

---

## Group 5: Deterministic Gates & Verification

### Compile Gate
Run compiler (tsc, cargo check, etc). Project-specific command from project config (like current minion-projects.yaml). Pass/fail. Deterministic, no AI.

### Lint Gate
Run linter (oxlint, clippy, etc). Project-specific. Shift-left pattern from existing `shiftLeftLint()` — run between attempts so agent can fix lint errors on retry.

### Test Gate
Run tests. Three modes:
- **scope=relevant** — only tests in affected dirs
- **scope=all** — full test suite
- **scope=specific** — named test files

Expectations:
- **expect=pass** — green phase (normal)
- **expect=new_failures** — red phase for TDD

Baseline comparison from existing verifyRed/verifyGreen patterns.

### Auto-Commit Gate
After all gates pass: auto-commit with conventional commit prefix from WO config. Commit before dependents fire so they see latest HEAD.

Branch strategy: auto (dispatcher manages), current (commit to current branch), or named branch. For features: one commit per WO on a feature branch. For fixes: commit to fix branch or current depending on effort level.

---

## Group 6: Workflow Patterns

All workflows use the SAME dispatcher, executor, and gates. They differ only in how work orders are created and linked.

### Feature Workflow (Three-Model Pipeline)
```
You → Opus CC (plan architecture)
  → Codex headless (generate interfaces/stubs)
    → Opus CC (review + commit interfaces)
      → WO MCP (create test + impl + review WOs)
        → GLM test WOs (fan out parallel)
          → GLM impl WOs (fan out per dependency chain)
            → Codex headless group review (mechanical)
              → Opus CC attended review (architectural)
```

Opus thinks. Codex shapes and reviews. GLM executes. ~45-60 min for what used to take a day.

### Fix Workflow
Single WO, no fan-out. Diagnose (Opus CC) → regression test (committed) → fix WO (minion) → gates → done. For batches: multiple independent fix WOs fire in parallel. Inherently sequential per bug but parallel across bugs.

### Refactor Workflow
Reference pattern + fan-out. Opus does reference impl in one file (committed). WOs for each target file depend on reference WO. Fan out in parallel. Consistency review WO at end (Opus attended). Key nuance: intern `file_dependencies` auto-discovers implicit ordering needs between target files.

### Maintenance Workflow
Cron-triggered. Detector creates tickets → tickets become WOs → minions fix → gates verify → commit. No Opus needed unless escalation. Adapt existing minion-detect to create WOs instead of tickets+CC tasks.

---

## Resolved Design Questions

1. **`intern_context` → STRUCTURED**, not boolean. Format: `{ enabled: true, search_depth: 1, tools: ["file_dependencies", "find_references"] }`. Different task types need different discovery — fix WO needs deep call-chain tracing, refactor WO only needs to confirm target imports. Boolean can't be tuned per WO type.

2. **Assertion stripping → CONTEXT ASSEMBLY**, not gate level. Dispatcher runs TreeSitter pass on committed test files, extracts public interface (function names, param types, imports) into `test_interface.md` for impl agent payload. Add `dynamic_context` field to WO schema: `{ from_wo: "WO-test-001", transform: "strip_assertions" }`. Context assembly reads completed test WO output at runtime (after dep resolution marks it done+committed), not at WO creation time.

3. **Soft deps → YES, add `prefer_after`**. Semantics: if this WO is ready and its `prefer_after` target is still running, wait up to N seconds then fire anyway. Use case: refactor files with import relationships — they don't strictly block each other but correct ordering avoids unnecessary retry cycles.

4. **Dispatcher → RUST**, same binary as executor. No IPC overhead. Rust async (tokio) handles concurrent task scheduling + dependency resolution cleanly. Agentboard UI talks to it via HTTP API. Node's concurrency model is wrong for managing 20 parallel subprocess invocations.

5. **CC escalation → existing agentboard task API** to spawn tmux pane. Error context ACCUMULATES across escalation tiers: original WO spec + GLM's failed diffs + gate errors + Sonnet's failed diffs (if it got that far). Opus needs full failure history to diagnose WO spec problem (redesign) vs implementation problem (fix and re-fire).

6. **Concurrency → per-model token bucket rate limiting + cap at ~20 total parallel executors**. GLM free tier has limits. ClickHouse logging provides tuning data after a week of real usage. Start conservative, loosen based on observed throughput.

7. **WO Isolation field → explicit per WO**. `isolation: { type: "worktree" | "branch" | "none", base: "HEAD" | "branch-name" }`. Features get worktrees, fixes get branches, maintenance commits to current. Replaces vague `branch: auto`.

## Remaining Open Questions

All resolved. See "Resolved Design Questions" above.

**WO MCP → build into agentboard as HTTP API endpoints.** Dispatcher is same Rust binary. WO store is SQLite alongside workflowStore. Only consumer is Opus in CC (calls HTTP via MCP adapter). Keeping the full WO lifecycle (create, validate, dispatch, execute, gate, commit) in one process = no network hops. Planner MCP stays separate — it's architecture thinking, not execution scheduling.

---

## Build Order

### Group Abort Trigger

If >N% of WOs in a group escalate (e.g. 5/8), halt the entire group. This signals a **design problem** (Opus's interfaces don't work in practice), not an implementation problem. Bring Opus back to revise interfaces and re-fire. Without this, you burn retries and escalations on something that needs redesign.

### Cross-Model Review (Feature Workflow)

Split the final review into two WOs:
1. **Mechanical review** (unattended, Codex headless) — consistency, patterns, edge cases, over-engineering detection. Reads git diff of entire group's commits. Outputs structured JSON review (issues with file, line, severity, description). If findings exist, they become targeted fix WOs through the normal pipeline.
2. **Architectural review** (attended, Opus in CC) — design coherence, codebase fit. Shorter and higher-signal because Codex already caught the mechanical issues.

Codex review is **group-level only, not per-WO** — avoids adding 5min serial latency after every implementation. Different models have different failure modes. Cross-review catches both.

### Codex Executor Variant

Thin wrapper in the Rust binary. Instead of API calls with tool use, spawns Codex CLI in headless mode, passes context, reads JSON output from file/stdout. Dispatcher routes `model: codex` to this path. Rate limiting is different — Codex is subscription-based, needs concurrent sessions limiter, not token bucket.

### Three-Model Pipeline Summary

| Role | Model | Mode | What it does |
|------|-------|------|-------------|
| **Thinks** | Opus | CC attended | Architecture, planning, WO creation, final review |
| **Shapes + Reviews** | Codex/GPT-5.4 | Headless | Interface generation, mechanical group review |
| **Executes** | GLM | API via executor | Test writing, implementation, fixes |

### Realistic Daily Expectations

- **Attended Opus phases** are the real time sink. Budget 30-60 min per feature, not the theoretical 15-20 min.
- **Parallel execution** best case is refactors (truly independent WOs). Features will see sequential deps reducing parallelism — expect 3-4 WOs at a time, not 20.
- **Exploratory days** (~20-30% of days) don't fit the WO model. Use CC/Codex interactively. The swarm sits idle. That's normal.
- **Weeks 1-2 will be rough.** WOs too coupled, context assembly misses files, escalations frequent. ClickHouse data from these failures is the tuning signal. Smooth by week 3-4.

**Typical day:**
- Morning: check overnight maintenance results (10 min)
- Main feature: Opus plans + creates WOs (30-60 min attended) → swarm executes (15-30 min, you do other work) → review + fix-ups (20-30 min)
- Second task: fix or refactor, no architecture phase (20 min)
- Optional: exploratory session, no swarm

---

**Phase 1: Rust Executor** (first, most unknowns)
- Workspace crate at `crates/minion-executor/`
- MCP client to code-intelligence (9 tools: 6 proxied + 3 local)
- Anthropic messages API calls via proxy (localhost:8090)
- Anchor-based diff format, applied via new `apply_diffs` MCP tool on code-intelligence (TreeSitter-aware, no TS dep in executor)
- Minimal agent loop: context payload in → tool-use turns → diffs out → done signal or iteration cap
- Test against one handwritten WO on agentboard codebase
- **Post-impl note:** If MCP hop latency matters at scale, extract shared `crates/tree-sitter-anchors/` crate

**Phase 2: Deterministic Gates**
- Compile, lint, typecheck, test gates as Rust functions
- Project config (commands per language/project)
- Auto-commit on all-pass

**Phase 3: Dispatcher**
- Dependency graph + topological sort
- Parallel dispatch with concurrency limits
- Token bucket rate limiting per model
- WO state persistence (SQLite)
- Context assembly with intern tool integration
- dynamic_context + TreeSitter assertion stripping

**Phase 4: WO API + MCP Adapter**
- HTTP endpoints: create_wo, list_wos, get_wo, update_wo_status, create_group
- Schema validation at creation
- MCP adapter so Opus in CC can call the endpoints

**Phase 5: Codex Integration**
- Codex executor variant (spawn headless CLI, read JSON output)
- Concurrent sessions limiter (subscription-based, not token bucket)
- Interface generation flow: Opus plan → Codex generates stubs → Opus reviews
- Group review flow: Codex reads group diffs, outputs structured findings

**Phase 6: Escalation + CC Integration**
- Retry logic with error accumulation across tiers
- Agentboard task API integration for Opus CC sessions
- Interface contract violation detection + feedback loop
- Group abort trigger (>N% escalations → halt + redesign)

**Phase 7: Ship on a small feature, measure, iterate**
- Run end-to-end on a real feature
- Collect ClickHouse data on escalations, context gaps, gate failures
- Tune context assembly, iteration caps, WO decomposition patterns

---

## Background: Why This Redesign

### Problems with current system
- Every agent invocation goes through Claude Code (full project indexing, compaction, permission negotiation) even for simple one-shot tasks
- Long CC sessions create context drift, compaction artifacts, the model forgetting constraints from 50 turns ago
- The change-pipeline.yaml (688 lines, 8 stages) rarely completes without breaking
- dagEngine.ts (5800 lines) was designed around the assumption every agent is a CC instance

### Key insight from Stripe Minions architecture
- Interleave creative LLM steps with hardcoded deterministic gates
- One-shot context payloads, not iterative sessions
- Two-attempt cap per tier — if it can't fix in 2 tries, a 3rd won't help
- The agent scaffold determines more of coding performance than the model weights (22-point swing on SWE-bench Pro)
- "The AI agent itself is almost a commodity. The real magic is the infrastructure around the model."

### What we keep from the old system
- workflowStore.ts (SQLite persistence for runs/steps/state)
- Shared types (WorkflowStep, WorkflowRun, StepRunState, WorkUnit, etc.)
- workflowFileWatcher.ts (hot-reload of workflow definitions)
- Gate logic patterns (shiftLeftLint, verifyRed, verifyGreen)
- Model routing concepts (ComplexityLevel, ModelRoutingConfig, escalation)
- minion-detect.ts detector patterns

---

## Implementation Philosophy

**Ship minimum viable, run on a small feature, iterate.**

The first real end-to-end run: Opus will produce WOs that are too coupled, agents will need files not in context, 3/8 WOs will escalate. That's expected and fine. The ClickHouse data from those failures is how you tune context assembly and WO decomposition patterns.

Don't perfect the WO decomposition or context assembly before running real workloads. A week of real data is worth more than a month of speculative design.

**What to measure from ClickHouse logs:**
- Which WOs escalated? (WO spec quality signal)
- What files did agents request via read_file that weren't in the payload? (context assembly gap signal)
- Which gates failed most? (gate tuning signal)
- Token counts per WO by model tier (cost optimization signal)
- Time from WO creation to commit (throughput signal)

---

## Updated WO Schema (Post-Review)

```yaml
id: WO-001
group_id: feat-health-check
title: "Implement health check handler"
description: |
  Implement the GET /health endpoint handler
  matching the interface in src/server/health.ts

task: implement
scope: src/server/handlers/

# Context: committed files on disk (never descriptions)
interface_files:
  - src/server/health.ts
  - src/shared/types.ts
reference_files: []
input_files:
  - src/server/index.ts

# Structured context discovery (not boolean)
intern_context:
  enabled: true
  search_depth: 1
  tools:
    - file_dependencies
    - find_references

# Dynamic context from completed WOs (e.g. assertion-stripped test interface)
dynamic_context:
  - from_wo: WO-test-001
    transform: strip_assertions

# Dependencies
depends_on: [WO-test-001]
prefer_after: []             # soft deps: wait briefly, then fire anyway

# Deterministic gates
gates:
  compile: true
  lint: true
  typecheck: true
  tests:
    run: true
    scope: relevant
    specific: []
    expect: pass

# Execution
execution:
  mode: unattended
  model: glm
  max_retries: 2
  timeout_minutes: 15

# Escalation (error context accumulates across tiers)
escalation:
  enabled: true
  after_retries: 2
  to: opus
  mode: attended
  include_error_context: true  # accumulates: GLM errors + Sonnet errors + gate output

# Git isolation
isolation:
  type: worktree            # worktree | branch | none
  base: HEAD

# Output
output:
  commit: true
  commit_prefix: "feat"
```
