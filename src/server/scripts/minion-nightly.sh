#!/usr/bin/env bash
# minion-nightly.sh — Run detect + fix pipeline for agentboard
# Intended to be called by cron at midnight daily.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="/home/andrew-cooke/tools/agentboard"
API_URL="http://localhost:4040"
LOG_DIR="$HOME/.agentboard/logs"
LOG_FILE="$LOG_DIR/minion-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"

echo "=== minion-nightly $(date -Iseconds) ===" >> "$LOG_FILE"

# Phase 1: Detect — find issues, create tickets
echo "[detect] Starting..." >> "$LOG_FILE"
bun run "$SCRIPT_DIR/minion-detect.ts" --project "$PROJECT" >> "$LOG_FILE" 2>&1 || {
  echo "[detect] FAILED with exit code $?" >> "$LOG_FILE"
}

# Phase 2: Fix — pick up tickets, fix via agentboard tasks
echo "[fix] Starting..." >> "$LOG_FILE"
bun run "$SCRIPT_DIR/minion-fix.ts" --api-url "$API_URL" --project "$PROJECT" >> "$LOG_FILE" 2>&1 || {
  echo "[fix] FAILED with exit code $?" >> "$LOG_FILE"
}

echo "=== minion-nightly done $(date -Iseconds) ===" >> "$LOG_FILE"
