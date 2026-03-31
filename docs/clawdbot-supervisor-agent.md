# Clawdbot/Moltbot Supervisory Agent

## Status: Future — Revisit after orchestration layer is complete

## Concept

Use Clawdbot (now Moltbot) as a **human-in-the-loop replacement** — not replacing
the agentboard orchestration system, but replacing the human who currently sits
between workflow runs making decisions and triggering next steps.

The deterministic workflow engine, task queue, tmux session management, and all
existing infrastructure remain unchanged. Clawdbot acts as a supervisory layer
that reads workflow outputs, makes decisions per predefined rules, triggers the
next workflow via agentboard's API, and escalates to the human (via Telegram)
when something falls outside its decision authority.

## Problem Statement

The current feature development loop looks like:

1. Human designs feature spec
2. Human triggers planning workflow
3. Human reads planning output, triggers implementation workflow
4. Human reads review output — if issues found, triggers workhorse fix
5. Human reads audit output — if issues found, iterates back
6. Human confirms completion

Steps 2-6 are largely mechanical: read structured output, apply simple rules,
trigger the next action. The human is acting as a slow, expensive router.

## Architecture

```
 Human (Telegram)
   |
   | escalations only
   v
 Clawdbot/Moltbot (daemon, always-on)
   |
   | reads: feature spec + decision rules
   | calls: agentboard REST API (custom skill)
   | monitors: workflow run status + outputs
   |
   v
 Agentboard API
   |
   | unchanged: workflow engine, task queue, tmux sessions
   v
 Claude Code sessions (workers)
```

Clawdbot does NOT touch tmux, does NOT run Claude Code directly, does NOT
modify the orchestration logic. It only interacts through the agentboard API.

## What Clawdbot Needs

### 1. Agentboard API as a Custom Skill

Expose these existing endpoints to Clawdbot:

- `POST /api/workflows/:id/run` — trigger a workflow (with variables)
- `GET /api/workflow-runs/:runId` — check run status
- `GET /api/workflows/:id/runs` — list runs for a workflow
- `GET /api/tasks/:id/output` — read task output (review findings, audit results)
- `GET /api/tasks` — list tasks and their status

May need additional endpoints:
- Summary/structured output from completed workflow runs
- Review score / audit findings in machine-readable format

### 2. Feature Spec Format

Structured input that Clawdbot receives to begin a feature lifecycle:

```yaml
feature: user-authentication
description: "Add JWT auth with login, registration, password reset"
project_path: /Users/andrewcooke/projects/my-app

workflows:
  - phase: plan
    workflow: feature-planning
    variables:
      feature_desc: "{{ description }}"
      project_path: "{{ project_path }}"

  - phase: implement
    workflow: work-order-implementation
    depends_on: plan
    variables:
      plan_output: "{{ plan.output_dir }}"

  - phase: review
    workflow: code-review
    depends_on: implement

  - phase: audit
    workflow: security-audit
    depends_on: review

decision_rules:
  review_issues_found: fix_then_re_review
  audit_issues_found: fix_then_re_audit
  max_review_iterations: 3
  max_audit_iterations: 2

escalation:
  channel: telegram
  escalate_on:
    - architectural_drift
    - max_iterations_exceeded
    - ambiguous_review_finding
    - workflow_failure_after_retry
```

### 3. Decision Tree (Rules, Not Reasoning)

| Signal | Action |
|---|---|
| Workflow run completes successfully | Trigger next phase |
| Review finds fixable issues | Dispatch workhorse via API, then re-review |
| Review finds architectural concern | Escalate to human via Telegram |
| Audit finds security issues | Block + dispatch fix, then re-audit |
| Audit finds style/minor issues | Log and continue |
| Workflow fails (error) | Retry once, then escalate |
| Review iterations > max | Escalate |
| All phases complete + passing | Report completion to human |

The key principle: **rules, not reasoning**. Clawdbot follows the decision tree
mechanically. It does not reinterpret the feature spec or make architectural
choices. Anything ambiguous goes to the human.

### 4. Escalation Protocol

When Clawdbot escalates via Telegram:
- Include: what phase, what the issue is, relevant output snippet
- Wait for human response (async — could be minutes or hours)
- Human replies with instruction (e.g., "accept the review finding" or "iterate with this guidance: ...")
- Clawdbot resumes the loop with the human's decision

## Prerequisites Before Implementation

1. **Stable orchestration layer** — workflows for plan/implement/review/audit
   must be reliable and well-tested before adding a supervisor
2. **Structured workflow outputs** — review and audit workflows must produce
   machine-readable results (not just prose). Needs clear pass/fail signals,
   issue categorization, severity levels
3. **Agentboard API completeness** — all needed endpoints exposed and stable
4. **Workflow variable system** — done (WO-007, variables feature)
5. **Decision rules validated** — run the full loop manually several times,
   document every decision point, confirm rules cover >80% of cases

## Implementation Plan (When Ready)

### Phase 1: Proof of Concept
- Install Moltbot on VPS or local machine
- Write agentboard API skill (Node.js tool wrapping REST calls)
- Test with one simple workflow: plan only
- Set escalation threshold very low (ping on everything)

### Phase 2: Single Feature Loop
- Wire up full plan -> implement -> review -> fix cycle
- Hardcode decision rules for one feature type
- Run 3-5 features through it, measure:
  - How many escalations per feature?
  - How many were genuinely necessary?
  - Did it make any wrong autonomous decisions?

### Phase 3: Tighten and Scale
- Reduce escalation threshold based on Phase 2 data
- Add audit phase to the loop
- Support multiple concurrent features (separate Moltbot sessions)
- Add reporting: feature completion rate, average iterations, escalation rate

## Risks

| Risk | Mitigation |
|---|---|
| LLM makes wrong decision at boundary | Strict rules + low escalation threshold initially |
| Clawdbot loses context on long-running features | File-based memory (MEMORY.md), structured state |
| API cost if using Opus for supervisor | Supervisor needs reasoning, not coding — could use cheaper model |
| Daemon stability (crashes, restarts) | Moltbot has launchd/systemd service management |
| Feature spec drift during execution | Immutable spec — Clawdbot cannot modify the original brief |

## References

- [Moltbot GitHub](https://github.com/clawdbot/clawdbot)
- [Claude Code integration request](https://github.com/moltbot/moltbot/issues/2555)
- [claude-code-wingman (tmux orchestration)](https://github.com/yossiovadia/claude-code-wingman/)
- [Daemon TTY issue](https://github.com/moltbot/moltbot/issues/956)
- [DataCamp tutorial](https://www.datacamp.com/tutorial/moltbot-clawdbot-tutorial)
