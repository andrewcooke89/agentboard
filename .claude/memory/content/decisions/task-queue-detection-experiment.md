---
affects:
- task-queue-detection-experiment
id: task-queue-detection-experiment
trust: derived
type: decision
---

# Task Queue Completion Detection — Experiment Results (2026-01-27)

## Experiment Summary

Tested Claude CLI behavior for automated task queue spawning.

## Key Findings

### 1. Interactive vs Print Mode
- `claude "prompt"` (interactive): Processes prompt but **stays in interactive mode**. Also shows trust prompt blocking non-interactive use.
- `claude -p "prompt" --dangerously-skip-permissions` (print mode): Runs non-interactively, **auto-exits on completion**. No trust prompt. This is the correct mode for queued tasks.

### 2. Process Exit Detection (RELIABLE)
- `pane_current_command` = `2.1.20` (Claude's version string as process title) while Claude runs
- Changes to `bash`/`sh`/`zsh` after Claude exits
- **Reliable detection signal** — poll this value to detect completion

### 3. Exit Code (NOT USEFUL)
- Claude exits 0 even for "failed" tasks (e.g., file not found) — it handles errors gracefully
- Exit code cannot distinguish success from failure
- Need **output analysis** heuristics instead

### 4. Stop Hooks (DO NOT FIRE in -p mode)
- Stop hooks fire in interactive mode but **NOT in print (-p) mode**
- Cannot rely on Stop hook for task completion signaling
- Process exit polling is the primary (and only reliable) mechanism

### 5. Window Lifecycle
- Without shell wrapper: window **destroyed on exit** (default tmux behavior)
- With shell wrapper (`exec sh`): window stays alive for output capture
- **Shell wrapper required** for output capture

### 6. Recommended Command Format
```
sh -c 'claude -p "PROMPT" --dangerously-skip-permissions 2>&1; echo "===TASK_EXIT_CODE=$?==="; exec sh'
```

## Design Implications
- **Primary detection**: Poll `pane_current_command` every N seconds
- **Output capture**: `tmux capture-pane -p -S -` after detecting exit
- **Success/failure**: Heuristic analysis of output (error patterns, exit code marker)
- **Stop hook mechanism**: Skip for MVP — not available in -p mode
- **Trust prompt**: Use `--dangerously-skip-permissions` for all queued tasks