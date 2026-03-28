#!/usr/bin/env bash
# minion-nightly.sh — Run detect + fix pipeline for agentboard
# Intended to be called by cron at midnight daily.

set -euo pipefail

# Cron doesn't inherit user PATH — add bun and local bin
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="/home/andrew-cooke/tools/agentboard"
API_URL="http://localhost:4040"
LOG_DIR="$HOME/.agentboard/logs"
LOG_FILE="$LOG_DIR/minion-$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"

echo "=== minion-nightly $(date -Iseconds) ===" >> "$LOG_FILE"

# Phase 0: Ensure agentboard server is running
health_check() {
  curl -sf "$API_URL/api/health" > /dev/null 2>&1
}

if ! health_check; then
  echo "[server] Not running, starting..." >> "$LOG_FILE"
  cd "$PROJECT"
  nohup bun run start >> "$LOG_DIR/agentboard-server.log" 2>&1 &
  SERVER_PID=$!
  echo "[server] Started (PID $SERVER_PID), waiting for health..." >> "$LOG_FILE"

  # Wait up to 30s for server to be ready
  for i in $(seq 1 30); do
    if health_check; then
      echo "[server] Healthy after ${i}s" >> "$LOG_FILE"
      break
    fi
    sleep 1
  done

  if ! health_check; then
    echo "[server] FAILED to start after 30s, aborting run" >> "$LOG_FILE"
    exit 1
  fi
else
  echo "[server] Already running" >> "$LOG_FILE"
fi

# Phase 1: Detect — find issues, create tickets
echo "[detect] Starting..." >> "$LOG_FILE"
bun run "$SCRIPT_DIR/minion-detect.ts" --project "$PROJECT" >> "$LOG_FILE" 2>&1 || {
  echo "[detect] FAILED with exit code $?" >> "$LOG_FILE"
}

# Phase 2: Fix — pick up tickets, fix via agentboard tasks
# 7-hour hard timeout catches hangs (deadline flag is the soft stop at 08:30)
echo "[fix] Starting..." >> "$LOG_FILE"
timeout 7h bun run "$SCRIPT_DIR/minion-fix.ts" --api-url "$API_URL" --project "$PROJECT" >> "$LOG_FILE" 2>&1
FIX_EXIT=$?
if [ $FIX_EXIT -eq 124 ]; then
  echo "[fix] KILLED by 7h hard timeout" >> "$LOG_FILE"
elif [ $FIX_EXIT -ne 0 ]; then
  echo "[fix] FAILED with exit code $FIX_EXIT" >> "$LOG_FILE"
fi

echo "=== minion-nightly done $(date -Iseconds) ===" >> "$LOG_FILE"
