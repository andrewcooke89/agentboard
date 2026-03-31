# Verification — Orchestrator Template

## Variables

- `{{ spec_path }}` — Path to the approved feature specification
- `{{ output_dir }}` — Output directory for verification artifacts
- `{{ signals_dir }}` — Signal directory for protocol communication

## Verification Posture

Adopt an **adversarial verification posture**: assume the implementation may have
gaps, shortcuts, or deviations from the spec until proven otherwise.

## Process

### Step 1: Claim Manifest Checking

For each acceptance criterion in the spec:
1. Locate the corresponding implementation evidence
2. Verify the claim with file:line references
3. Run any automated verification (tests, type checks, linting)
4. Record: `criterion_id`, `status` (verified/failed/unverifiable), `evidence`

### Step 2: Completeness Audit

Check that:
- All files in scope were actually modified/created
- No files outside scope were modified (scope leak detection)
- All interface dependencies between work units are satisfied
- All acceptance criteria have at least one verification

### Step 3: Constitution Compliance

Re-run constitution checks against the implementation:
- **Security**: No new credential patterns, no auth bypass
- **Architecture**: Changes respect module boundaries
- **Quality**: All new code has typed interfaces

### Step 4: Regression Analysis

- Identify existing tests that cover modified code paths
- Flag any modified code paths without test coverage
- Check for breaking changes to public APIs

## Output

Write to `{{ output_dir }}/conformance/`:
- `verification-report.yaml` — Full verification results
  ```yaml
  criteria_results:
    - criterion_id: string
      status: verified | failed | unverifiable
      evidence: string
      file_line: string
  scope_compliance:
    files_in_scope: number
    files_modified: number
    scope_leaks: [string]
  constitution_compliance:
    security: pass | fail
    architecture: pass | fail
    quality: pass | fail
  overall_verdict: pass | fail | partial
  ```

## Signal Protocol

- `completed` — Verification finished successfully
- `error` — Verification encountered an unrecoverable error
- `concern` — Verification found issues requiring human review
