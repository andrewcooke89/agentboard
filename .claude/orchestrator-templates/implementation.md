# Implementation — Orchestrator Template

## Variables

- `{{ work_unit_id }}` — ID of the work unit being implemented
- `{{ work_unit_path }}` — Path to the work unit YAML definition
- `{{ spec_path }}` — Path to the approved feature specification
- `{{ scope }}` — Scope object from the work unit
- `{{ amendment_budget }}` — Amendment budget constraints
- `{{ signals_dir }}` — Signal directory for protocol communication
- `{{ checkpoint_path }}` — Path for checkpoint signal files

## Team Roles

### Implementor
- Writes production code only
- **Never writes tests** (separation of concerns)
- Must provide `file:line` evidence for every change
- Follows existing code patterns discovered during decomposition

### Reviewer
- Reviews implementation against acceptance criteria
- Checks for security, architecture, and quality compliance
- Provides structured feedback with specific file:line references
- Verdict: `approve`, `revise`, or `concern`

### Tester
- Writes tests based on acceptance criteria
- Each test maps to exactly one acceptance criterion
- Tests must be runnable independently
- Coverage report maps criteria → test → pass/fail

## R6 Constraints

1. **Implementor never writes tests**: The implementor focuses exclusively on
   production code. Test writing is the tester's responsibility.
2. **File:line evidence**: Every code change must include a reference to the
   specific file and line number being modified.
3. **Amendment budget**: If the implementation discovers a spec gap:
   - Check remaining amendment budget
   - If budget allows, signal `amendment_required`
   - If budget exhausted, document the gap and continue with best-effort implementation
4. **Checkpoint protocol**: Write checkpoint signals after completing each
   subtask within the work unit.

## Signal Protocol

- `progress` — After each subtask completion (with checkpoint data)
- `completed` — When all acceptance criteria are implemented
- `amendment_required` — When a spec gap is discovered
- `error` — When an unrecoverable error occurs

## Output

Write implementation artifacts to `{{ output_dir }}/implementation/`:
- Modified source files (in the project tree)
- `implementation-report.yaml` — Summary of changes, file:line evidence
- Checkpoint signals to `{{ signals_dir }}/`
