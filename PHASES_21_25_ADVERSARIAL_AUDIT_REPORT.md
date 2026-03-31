# ADVERSARIAL AUDIT REPORT: Phases 21-25 Implementation
## Target: /home/andrew-cooke/tools/agentboard

**Audit Date:** 2026-02-20
**Scope:** 12 new source files, modified types/store files, 13 test files
**Lines Reviewed:** ~4,000+ lines of implementation code

---

## EXECUTIVE SUMMARY

**Overall Assessment: MODERATE RISK**

The implementation demonstrates competent engineering with reasonable error handling and test coverage. However, several **critical** issues require immediate attention, particularly around state safety, resource management, and security.

**Finding Summary:**
| Severity | Count |
|----------|-------|
| Critical | 4 |
| High | 8 |
| Medium | 12 |
| Low | 6 |

---

## CRITICAL FINDINGS

### CRIT-001: Race Condition in Global Rate Limit State
**File:** `src/server/geminiClient.ts:76-78`
**Category:** State-Safety / Concurrency

The rate limit state is a module-level object shared across all calls without synchronization. Multiple concurrent `callGemini()` calls can race on `checkRateLimit()`, causing actual usage undercounting.

**Fix:** Use mutex for atomic operations.

### CRIT-002: Race Condition in Draft Swarm State
**File:** `src/server/draftSwarm.ts:40-45`
**Category:** State-Safety / Concurrency

Global state object (`activeRequests`, `minuteRequestCount`) modified without synchronization. Non-atomic increments can lose updates under concurrent load.

**Fix:** Use `Atomics` or mutex for counters.

### CRIT-003: Worktree Cleanup Failure Leaves Orphan Resources
**File:** `src/server/branchIsolation.ts:204-236`
**Category:** Resource Leak

The `cleanupWorktree()` function has multiple failure modes that leave orphan resources. If directory removal succeeds but git worktree removal fails, leaves git worktree reference.

**Fix:** Make cleanup atomic with compensation transactions.

### CRIT-004: Expression Injection in Condition Evaluator
**File:** `src/server/conditionEvaluator.ts:78-82`
**Category:** Security

The `file_exists()` function accepts arbitrary paths without validation. A malicious expression like `file_exists(/etc/passwd)` can probe the filesystem.

**Fix:** Restrict to allowed directories with path validation.

---

## HIGH FINDINGS

| ID | File | Issue |
|----|------|-------|
| HIGH-001 | `telemetryCollector.ts:105` | ActiveSteps Map Never Cleaned on Error Path |
| HIGH-002 | `litellmProxy.ts:86-92` | LiteLLM Proxy Process May Zombie on Startup Failure |
| HIGH-003 | `telemetryCollector.ts:372` | TelemetryCollector Step Lookup Logic is Fragile |
| HIGH-004 | `perWorkUnitEngine.ts:110-113` | Per-Work-Unit Cycle Detection Returns Any Cycle Subset |
| HIGH-005 | `branchIsolation.ts:298-307` | Missing Transaction on Worktree Record Creation |
| HIGH-006 | `reviewRouter.ts:143-153` | Review Router Has Placeholder Implementation |
| HIGH-007 | `outputInvalidation.ts:154-170` | Output Invalidation Hash Comparison Semantic Mismatch |
| HIGH-008 | `aggregatorHandler.ts:68-71` | Aggregator Path Traversal Check Uses startswith |

---

## RECOMMENDATIONS

### Immediate (P0)
1. Add mutex/atomic operations to rate limit state in `geminiClient.ts`
2. Add mutex/atomic operations to draft swarm state in `draftSwarm.ts`
3. Fix worktree cleanup to be atomic with compensation
4. Add path validation to `file_exists()` expression

### Short-term (P1)
1. Fix output invalidation hash semantic mismatch
2. Add runId parameter to telemetry functions instead of inferring
3. Implement or document placeholder review implementations
4. Add concurrency tests

### Medium-term (P2)
1. Add integration tests for full pipeline execution
2. Improve error messages in cycle detection
3. Add staleness cleanup for `activeSteps` map
4. Migrate sync file operations to async in contextLibrarian

---

## CONCLUSION

The Phases 21-25 implementation is **production-ready with reservations**. The core logic is sound and defensive patterns are present. However, the identified race conditions and resource leak vulnerabilities could manifest under load.

**Recommended Action:** Address CRIT-001 through CRIT-004 before production deployment.
