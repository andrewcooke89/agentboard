---
affects:
- task-queue
id: task-output-capture
source_files:
- src/server/taskWorker.ts
trust: derived
type: failure
---

# Failure: tmux capture-pane unreliable for task output

## Problem
`tmux capture-pane` was unreliable for capturing task output — timing issues, incomplete captures, scrollback limits.

## Fix
Use `tee` to pipe output to a file instead. Sentinel file pattern for completion detection.

## Status
This failure informed Phase 5 workflow engine design. The workflow engine uses sentinel files and convention-based output paths rather than tmux capture for inter-step communication.