# Adversarial Audit Brief: Phases 21-25 Implementation

## Scope

Phases 21-25 of the Agentboard Gap Closure Plan implemented ~7,700 lines of new TypeScript code adding:

### Phase 21: Schema Compatibility & Pipeline Adaptation
- Pipeline YAML wrapper unwrap (`pipeline:` top-level key)
- New step types: `gemini_offload`, `aggregator`, `human_gate`
- Condition expression evaluator for tier-gated execution
- `expect: fail` for TDD red-phase verification
- Files:
  - `src/server/conditionEvaluator.ts` (NEW)
  - `src/shared/types.ts` (MODIFIED - step types)
  - `src/server/workflowSchema.ts` (MODIFIED)
  - `src/server/dagEngine.ts` (MODIFIED)

### Phase 22: Gemini Integration & Offload
- Gemini API client with exponential backoff
- Graceful degradation when API key missing
- Files:
  - `src/server/geminiClient.ts` (NEW, 312 lines)

### Phase 23: Per-Work-Unit Engine & Aggregator
- Work unit expansion (manifest → N sub-steps)
- TDD substep cycles (write-tests → verify-red → implement → verify-green)
- Finding aggregation with deduplication
- Files:
  - `src/server/perWorkUnitEngine.ts` (NEW, 477 lines)
  - `src/server/aggregatorHandler.ts` (NEW, 392 lines)

### Phase 24: Branch Isolation, Output Invalidation & Telemetry
- Git worktree management for concurrent runs
- Transitive output invalidation cascade
- Telemetry collection (5 new DB tables)
- Files:
  - `src/server/branchIsolation.ts` (NEW, 314 lines)
  - `src/server/outputInvalidation.ts` (NEW, 310 lines)
  - `src/server/telemetryCollector.ts` (NEW, 603 lines)
  - `src/server/workflowStore.ts` (MODIFIED - 5 new tables)

### Phase 25: Model Routing & Review Integration
- Complexity-based classification
- L1/L2 reviewer routing
- LiteLLM proxy lifecycle
- Draft swarms (speculative parallel execution)
- Context librarian (Gemini-based context compression)
- Files:
  - `src/server/complexityClassifier.ts` (NEW, 270 lines)
  - `src/server/litellmProxy.ts` (NEW, 276 lines)
  - `src/server/reviewRouter.ts` (NEW, 333 lines)
  - `src/server/draftSwarm.ts` (NEW, 317 lines)
  - `src/server/contextLibrarian.ts` (NEW, 452 lines)

## Known Concerns

### Critical Areas
1. **Git worktree operations** (`branchIsolation.ts`) - File system manipulation, cleanup failures
2. **Concurrent run isolation** - Scope conflict detection may have race conditions
3. **Output invalidation cascade** - Graph traversal could have infinite loops
4. **Gemini API calls** - Backoff logic, error handling, missing API key paths
5. **SQLite schema changes** - Migration handling for 5 new tables
6. **Condition evaluator** - Expression parser security (injection risks)

### Integration Points
- `dagEngine.ts` orchestrates all new modules - tight coupling
- `workflowStore.ts` schema changes need migration path
- `projectProfile.ts` reads new sections (model_routing, review_routing)

### Test Coverage
- 217 new tests were written
- Integration tests may not cover concurrent scenarios
- Error paths (API failures, worktree failures) may be undertested

## Compliance Requirements

- **Type Safety**: Strict TypeScript, no `any` except test mocks
- **Error Handling**: No silent failures, all errors propagated
- **Resource Cleanup**: Worktrees, connections, processes must be cleaned up
- **SQL Injection**: All queries must use parameterized statements
- **Security**: Condition evaluator must not allow code execution

## Audit Focus Areas

1. **State Safety**: Race conditions in branch isolation, concurrent DB writes
2. **Resource Leaks**: Worktree cleanup, connection handling
3. **Error Handling**: Missing error propagation, silent failures
4. **Type Safety**: Unsafe casts, missing null checks
5. **Security**: Expression injection in condition evaluator
6. **Performance**: N+1 queries, inefficient graph traversals
7. **Test Quality**: Meaningless assertions, missing edge cases

## Exclusions

- Existing code outside Phases 21-25 scope (unless directly integrated)
- UI components (client-side React code)
- Third-party library bugs
