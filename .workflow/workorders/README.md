# YAML Workflow Engine - Work Orders Summary

**Feature:** FEAT-005 - YAML Workflow Engine
**Total Work Orders:** 15
**Total Estimated Hours:** 90 hours (~11-12 working days)
**Planning Date:** 2026-01-29

## Overview

This document provides a comprehensive summary of all work orders for implementing the YAML Workflow Engine feature in agentboard. The work orders follow the 15-phase modular implementation structure defined in the feature brief.

## Work Order Dependency Graph

```
Phase 1: WO-001 (Shared Types)
         └── Phase 2: WO-002 (Configuration)
                     └── Phase 3: WO-003 (YAML Schema)
                                 └── Phase 4: WO-004 (Workflow Store)
                                             ├── Phase 5: WO-005 (Workflow Engine)
                                             │            └── Phase 6: WO-006 (File Watcher)
                                             │                        ├── Phase 7: WO-007 (REST API)
                                             │                        └── Phase 8: WO-008 (WebSocket)
                                             │                                    └── Phase 9: WO-009 (Server Wiring)
                                             └── Phase 10: WO-010 (Client Store)
                                                          └── Phase 11: WO-011 (Pipeline Diagram)
                                                                      └── Phase 12: WO-012 (Workflow List/Detail)
                                                                                  ├── Phase 13: WO-013 (Workflow Editor)
                                                                                  └── Phase 14: WO-014 (Monitoring Panel)
                                                                                              └── Phase 15: WO-015 (E2E Testing)
```

## Phase Breakdown

### Data Foundation Phases (1-4): 19 hours
**Critical priority** - Must complete first

- **WO-001: Shared Type Definitions** (3h)
  - Define all TypeScript types for workflows, runs, steps, WebSocket messages
  - Establishes type foundation for server and client
  - Dependencies: None
  - Output: Updated src/shared/types.ts

- **WO-002: Configuration** (2h)
  - Add workflow config values to server config
  - WORKFLOW_ENGINE_ENABLED, WORKFLOW_DIR, limits, poll interval
  - Dependencies: WO-001
  - Output: Updated src/server/config.ts

- **WO-003: YAML Schema & Validation** (6h)
  - Implement YAML parsing and validation module
  - Validates structure, step types, conditions, references
  - Dependencies: WO-001
  - Output: New src/server/workflowSchema.ts + tests

- **WO-004: Workflow Store** (8h)
  - Create SQLite store with CRUD operations
  - workflows and workflow_runs tables
  - Additive migration for tasks table columns
  - Dependencies: WO-001, WO-003
  - Output: New src/server/workflowStore.ts + tests

### Business Logic Phases (5-6): 17 hours
**Critical priority** - Core engine implementation

- **WO-005: Workflow Engine Core** (12h)
  - Implement step execution, condition evaluation, advancement
  - All 4 step types, retry logic, server restart recovery
  - Dependencies: WO-002, WO-004
  - Output: New src/server/workflowEngine.ts + tests

- **WO-006: YAML File Watcher** (5h)
  - Watch workflow directory, auto-parse and upsert
  - Debounce, error handling, initial scan
  - Dependencies: WO-003, WO-004
  - Output: New src/server/workflowFileWatcher.ts + tests

### API Layer Phases (7-9): 15 hours
**High priority** - Server integration

- **WO-007: REST API Endpoints** (7h)
  - 11 endpoints for workflow and run management
  - CRUD, trigger, resume, cancel operations
  - Dependencies: WO-004, WO-005
  - Output: New src/server/handlers/workflowHandlers.ts + tests

- **WO-008: WebSocket Integration** (4h)
  - 5 client message handlers, 5 server message types
  - Real-time updates for workflow progress
  - Dependencies: WO-001, WO-004, WO-005
  - Output: New src/server/handlers/workflowWsHandlers.ts + tests

- **WO-009: Server Wiring** (4h)
  - Integrate all components into server startup
  - Initialization, recovery, cleanup, config logging
  - Dependencies: WO-004, WO-005, WO-006, WO-007, WO-008
  - Output: Updated src/server/index.ts + integration tests

### Frontend Foundation (10): 5 hours
**High priority** - Client state management

- **WO-010: Client Store & Handlers** (5h)
  - Zustand store for workflow state
  - HTTP client functions, WebSocket handlers
  - Dependencies: WO-001, WO-008
  - Output: New src/client/stores/workflowStore.ts + tests

### Frontend Integration Phases (11-14): 28 hours
**High priority** - User interface

- **WO-011: Pipeline Diagram Component** (6h)
  - Visualize workflow step progress
  - Status colors, icons, keyboard navigation, accessibility
  - Dependencies: WO-001, WO-010
  - Output: New src/client/components/PipelineDiagram.tsx + tests

- **WO-012: Workflow List & Detail Pages** (7h)
  - Full-page views for workflow CRUD
  - List, detail, run history, triggers
  - Dependencies: WO-010, WO-011
  - Output: New src/client/components/WorkflowList.tsx, WorkflowDetail.tsx + tests

- **WO-013: Workflow Editor** (10h)
  - Dual-mode editor: form builder + YAML
  - Create/update workflows, validation
  - Dependencies: WO-003, WO-010
  - Output: New src/client/components/WorkflowEditor.tsx, StepForm.tsx + tests
  - **Note:** Raw YAML editor is MVP priority, form builder stretch goal

- **WO-014: Monitoring Panel & Task Queue Integration** (5h)
  - Right-side panel for active run monitoring
  - Workflow badge on task queue items
  - Dependencies: WO-010, WO-011
  - Output: New src/client/components/WorkflowPanel.tsx + TaskItem.tsx updates + tests

### Testing & Deployment (15): 8 hours
**Critical priority** - Quality assurance

- **WO-015: End-to-End Testing & Deployment Preparation** (8h)
  - Playwright e2e test suite
  - Full workflow lifecycle, recovery, feature flag tests
  - Linting, type checking, deployment checklist
  - Dependencies: All phases (WO-001 through WO-014)
  - Output: New e2e/*.spec.ts, DEPLOYMENT.md

## Effort Summary by Priority

| Priority | Phases | Work Orders | Total Hours |
|----------|--------|-------------|-------------|
| Critical | 1-4, 5, 15 | WO-001 to WO-005, WO-015 | 42 hours |
| High     | 6-12, 14 | WO-006 to WO-012, WO-014 | 38 hours |
| Medium   | 13 | WO-013 | 10 hours |
| **Total** | **15** | **15** | **90 hours** |

## Execution Strategy

### Recommended Sequence (Critical Path)

1. **Foundation Sprint** (19h)
   - WO-001, WO-002, WO-003, WO-004
   - Establishes all data structures and storage
   - Completion gate: Database tables created, YAML validation working

2. **Engine Sprint** (17h)
   - WO-005, WO-006
   - Implements core execution logic
   - Completion gate: Workflows can execute end-to-end

3. **API Sprint** (15h)
   - WO-007, WO-008, WO-009
   - Exposes functionality via REST and WebSocket
   - Completion gate: Server fully integrated, APIs functional

4. **Frontend Sprint** (33h)
   - WO-010, WO-011, WO-012, WO-013 (MVP: YAML editor only), WO-014
   - Builds user interface
   - Completion gate: Users can create and monitor workflows

5. **Quality Sprint** (8h)
   - WO-015
   - Comprehensive testing and deployment prep
   - Completion gate: All tests pass, ready for production

### Parallel Execution Opportunities

- **After WO-004 completes:**
  - WO-005 (Engine) and WO-010 (Client Store) can run in parallel

- **After WO-009 completes:**
  - WO-011, WO-012, WO-013, WO-014 can be worked in parallel by separate developers

- **During development:**
  - Unit tests can be written concurrently with implementation
  - Documentation can be written alongside code

## Key Technical Decisions

1. **Convention-based file paths** (DEC-001): Steps write to explicit paths, no variable substitution
2. **Retry then halt** (DEC-002): Auto-retry failed steps, halt if still failing
3. **Per-step timeouts only** (DEC-003): No global workflow timeout
4. **YAML source of truth** (DEC-004): UI writes back to YAML files
5. **Simple skip conditions** (DEC-005): file_exists, output_contains only
6. **4 step types for MVP** (DEC-006): spawn_session, check_file, delay, check_output
7. **Manual triggers only** (DEC-007): No scheduled/event-based triggers
8. **Two-level UI** (DEC-008): Dedicated view for CRUD, right panel for monitoring
9. **Pipeline diagram** (DEC-009): Connected nodes with status visualization
10. **Engine submits to task queue** (DEC-010): Maximum reuse of existing infrastructure
11. **Polling for completion** (DEC-011): Consistent with existing task worker pattern

## Quality Gates

Each work order must meet these criteria before completion:

- ✅ All subtasks completed
- ✅ `bun run typecheck` passes
- ✅ `bun run test` passes (unit/integration tests)
- ✅ All acceptance criteria met
- ✅ Test coverage >90% for new code
- ✅ No breaking changes to existing functionality
- ✅ Rollback procedures documented

## Rollback Plan

All changes are additive and reversible:

- **Kill switch:** Set `WORKFLOW_ENGINE_ENABLED=false` to disable all workflow functionality
- **No destructive migrations:** All database changes use `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ADD COLUMN` (try/catch)
- **File-based rollback:** `git revert` or `git checkout` to remove code changes
- **Database cleanup:** DROP TABLE workflows; DROP TABLE workflow_runs; (if needed, but harmless to keep)
- **Tasks table columns:** workflow_run_id and workflow_step_name are nullable, don't affect existing queries

## Risk Mitigation

- **RISK-001 (Server restart):** Addressed in WO-005 (recovery logic) and tested in WO-015
- **RISK-002 (Bun fs.watch stability):** Investigated in WO-006, fallback to chokidar if needed
- **RISK-003 (YAML parse errors):** All parsing in try/catch, invalid YAML stored with is_valid=0
- **RISK-004 (Concurrent run limit):** WORKFLOW_MAX_CONCURRENT_RUNS cap enforced
- **RISK-005 (Tasks table migration):** Additive nullable columns, no breaking changes

## Success Metrics

From feature brief:

- **Workflows created:** > 0 within first week
- **Workflow run success rate:** > 80%
- **p95 step transition latency:** < 5s (engine poll + task queue pickup)
- **p95 WebSocket update latency:** < 200ms
- **Server crashes from workflow engine:** Zero
- **Data loss on server restart:** Zero (all state in SQLite)

## Next Steps

1. **Review this work order package** with team/stakeholder
2. **Assign work orders** to developers based on expertise
3. **Set up project tracking** (GitHub issues, Jira, etc.)
4. **Begin Foundation Sprint** (WO-001 to WO-004)
5. **Daily standups** to track progress and blockers
6. **Weekly demos** of completed phases

## Contact & Questions

For questions about these work orders:
- Refer to feature_brief.md for detailed specifications
- Check .workflow/blackboard.yaml for design decisions
- Review .workflow/discovery.yaml for technical context
- Consult .project/state/requirements_clarification.yaml for requirement details

---

**Generated by:** work-order-planning-orchestrator
**Date:** 2026-01-29
**Feature ID:** FEAT-005
**Status:** Ready for implementation
