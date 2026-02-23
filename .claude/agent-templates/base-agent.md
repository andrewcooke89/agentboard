# Signal-Checkpoint Protocol for Agents

## Overview

When working on a workflow step with `signal_protocol: true`, you MUST write signal files to communicate your status to agentboard. This replaces tmux-based completion inference with explicit, verified signals.

## Signal Directory

Your signal directory is provided via the workflow step configuration. All signal files MUST be written to this directory.

## Write-Then-Rename Protocol

**CRITICAL**: Never write signal files directly to the signal directory. Always use the atomic write-then-rename pattern:

1. Write the complete YAML content to `{signal_dir}/.tmp/{unique_name}.yaml`
2. Rename (move) the file to `{signal_dir}/{final_name}.yaml`

This prevents partial reads by the monitoring system. Example:

```bash
# Write to temp location first
cat > "${SIGNAL_DIR}/.tmp/signal_draft.yaml" << 'EOF'
version: 1
signal_type: completed
...
EOF
# Atomic rename to final location
mv "${SIGNAL_DIR}/.tmp/signal_draft.yaml" "${SIGNAL_DIR}/${STEP_NAME}_completed.yaml"
```

## Signal File Schema

Every signal file MUST be valid YAML with these required fields:

```yaml
version: 1                          # Schema version (always 1)
signal_type: completed              # See Signal Types below
timestamp: "2025-01-15T10:30:00Z"  # ISO 8601 timestamp
agent: "claude"                     # Your agent identifier
step_name: "my-step"               # The workflow step name you were assigned
run_id: "run-abc123"               # The workflow run ID

# Optional checkpoint (recommended)
checkpoint:
  last_completed_subtask: "wrote tests"
  completed_subtasks:
    - "analyzed requirements"
    - "implemented feature"
    - "wrote tests"
  files_modified:
    - "src/foo.ts"
    - "src/foo.test.ts"
  last_build_status: pass           # pass | fail | unknown
  extensions: {}                    # Custom key-value data
```

## Signal Types

| Type | When to Write | Effect |
|------|---------------|--------|
| `completed` | Task finished successfully | Step marked completed |
| `error` | Unrecoverable error occurred | Step marked failed (may retry) |
| `amendment_required` | Output needs revision based on review | Step paused for amendment |
| `human_required` | Human intervention needed | Step paused for human input |
| `blocked` | Cannot proceed due to external dependency | Step paused until resolved |
| `progress` | Periodic progress update | Checkpoint updated, step continues |

## File Naming Convention

Signal files MUST be named: `{step_name}_{signal_type}.yaml`

Examples:
- `build-feature_completed.yaml`
- `run-tests_error.yaml`
- `review-code_amendment_required.yaml`

## Checkpoint Discipline

1. **Update checkpoint after each subtask** — If your work involves multiple subtasks, write a `progress` signal after completing each one
2. **Include build status** — After any build/test operation, report the result in `last_build_status`
3. **List modified files** — Track all files you create or modify in `files_modified`
4. **Final signal** — Always end with either `completed` or `error` signal

## Version Field

The `version` field is **required** and must be set to `1`. This enables future schema evolution without breaking compatibility.

## Resolution Files

When your step is paused (amendment_required, human_required, blocked), the orchestrator will write a `{step_name}_{signal_type}_resolved.yaml` file to the signal directory. Monitor for this file to know when to resume work.
