# Deployment Guide

## YAML Workflow Engine - Deployment Checklist

This document outlines the deployment procedure for the YAML Workflow Engine feature (FEAT-005).

## Environment Variables

### Required
None - all workflow engine configuration is optional.

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKFLOW_ENGINE_ENABLED` | `true` | Enable/disable the workflow engine feature |
| `WORKFLOW_DIR` | `~/.agentboard/workflows/` | Directory for YAML workflow files |
| `WORKFLOW_MAX_CONCURRENT_RUNS` | `20` | Maximum number of concurrent workflow runs |
| `WORKFLOW_RUN_RETENTION_DAYS` | `30` | Days to retain completed workflow run history |

## Pre-Deployment Steps

### 1. Verify Code Quality

```bash
# Run all quality gates
bun run lint
bun run typecheck
bun run test
```

All commands must pass with zero errors.

### 2. Review Database Migrations

The workflow engine adds these tables to the SQLite database:

- `workflows` - Workflow definitions parsed from YAML files
- `workflow_runs` - Workflow execution state and history

Migrations are **additive only**:
- Uses `CREATE TABLE IF NOT EXISTS`
- Adds columns to `tasks` table: `workflow_run_id`, `workflow_step_name`
- No data loss on upgrade
- No manual migration required

### 3. Backup Database (Recommended)

```bash
# Backup the agentboard database before deployment
cp ~/.agentboard/agentboard.db ~/.agentboard/agentboard.db.backup-$(date +%Y%m%d)
```

## Deployment Procedure

### Standard Deployment

```bash
# 1. Pull latest code
git pull origin main

# 2. Install dependencies
bun install

# 3. Build production assets
bun run build

# 4. Restart server
# (Method depends on your process manager)
# Example with systemd:
sudo systemctl restart agentboard

# Or manual:
pkill -f "bun.*agentboard"
bun run start
```

### Feature Flag Rollout (Safe Deployment)

For a phased rollout, start with the feature disabled:

```bash
# 1. Deploy with feature disabled
export WORKFLOW_ENGINE_ENABLED=false
bun run start

# 2. Verify existing functionality works
curl http://localhost:3000/api/sessions

# 3. Enable feature flag
export WORKFLOW_ENGINE_ENABLED=true
# Restart server

# 4. Verify workflow endpoints
curl http://localhost:3000/api/workflows
```

## Verification Steps

### 1. Health Check

Verify server starts successfully:

```bash
# Check server logs for startup
tail -f ~/.agentboard/agentboard.log

# Look for:
# - "workflow_engine_started" event
# - "workflow_file_watcher_started" event
# - No errors during initialization
```

### 2. Workflow Engine Status

Verify workflow engine is running:

```bash
# Check workflows directory exists
ls -la ~/.agentboard/workflows/

# Verify workflow routes respond
curl http://localhost:3000/api/workflows
# Expected: [] or list of workflows
```

### 3. Database Schema

Verify tables were created:

```bash
# Using sqlite3 CLI
sqlite3 ~/.agentboard/agentboard.db "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'workflow%';"

# Expected output:
# workflows
# workflow_runs
```

### 4. File Watcher

Verify YAML file watching works:

```bash
# Create a test workflow
cat > ~/.agentboard/workflows/test.yaml << 'EOF'
name: test-workflow
description: Test workflow for verification
steps:
  - name: step-1
    type: delay
    duration_ms: 1000
EOF

# Check server logs for file watcher event
tail -f ~/.agentboard/agentboard.log | grep workflow_file_change

# Verify workflow appears in API
curl http://localhost:3000/api/workflows
# Should include test-workflow

# Clean up
rm ~/.agentboard/workflows/test.yaml
```

### 5. End-to-End Test

```bash
# Run e2e test suite (if applicable)
bun run test:e2e
```

## Rollback Procedures

### Option 1: Feature Flag Disable (Immediate)

```bash
# Set feature flag to disable workflow engine
export WORKFLOW_ENGINE_ENABLED=false

# Restart server
# Existing task queue and session management continues working
# Workflow routes will return 404 or not be registered
```

### Option 2: Code Rollback (Full Revert)

```bash
# 1. Rollback to previous version
git checkout <previous-commit>

# 2. Rebuild
bun install
bun run build

# 3. Restart server
sudo systemctl restart agentboard
```

### Option 3: Database Rollback (Data Recovery)

```bash
# Restore from backup
cp ~/.agentboard/agentboard.db.backup-YYYYMMDD ~/.agentboard/agentboard.db

# Restart server
sudo systemctl restart agentboard
```

**Note**: Database tables are **additive only**. Rolling back code does not require database changes. The `workflows` and `workflow_runs` tables remain but are unused when the feature is disabled.

## Monitoring & Observability

### Log Events to Monitor

Key structured log events:

```json
{"event": "workflow_engine_started", "pollIntervalMs": 2000}
{"event": "workflow_file_watcher_started", "dir": "/path/to/workflows"}
{"event": "workflow_file_change", "filename": "workflow.yaml", "changeType": "add"}
{"event": "workflow_run_started", "runId": "...", "workflowId": "..."}
{"event": "workflow_run_completed", "runId": "...", "status": "completed"}
{"event": "workflow_step_started", "runId": "...", "stepName": "..."}
{"event": "workflow_step_completed", "runId": "...", "stepName": "...", "status": "completed"}
```

### Error Events to Alert On

```json
{"event": "workflow_engine_error", "error": "..."}
{"event": "workflow_parse_error", "filename": "...", "error": "..."}
{"event": "workflow_run_failed", "runId": "...", "error": "..."}
```

### Metrics to Track

- Active workflow runs: `SELECT COUNT(*) FROM workflow_runs WHERE status='running'`
- Failed workflow runs (last 24h): `SELECT COUNT(*) FROM workflow_runs WHERE status='failed' AND created_at > datetime('now', '-1 day')`
- Average workflow completion time: `SELECT AVG(julianday(updated_at) - julianday(created_at)) * 86400 FROM workflow_runs WHERE status='completed'`

## Performance Considerations

### Expected Resource Usage

- **Memory**: +10-20MB for workflow engine polling loop
- **Disk I/O**: File watcher monitors `~/.agentboard/workflows/` directory
- **Database**: 2 new tables, minimal overhead on `tasks` table
- **CPU**: Polling every 2 seconds (configurable)

### Scaling Limits

- **Max concurrent workflow runs**: 20 (configurable via `WORKFLOW_MAX_CONCURRENT_RUNS`)
- **Max workflow file size**: No hard limit, recommended <1MB YAML
- **Max steps per workflow**: No hard limit, recommended <100 steps
- **WebSocket update latency**: Target p95 <200ms

## Troubleshooting

### Issue: Workflow engine not starting

**Symptoms**: No "workflow_engine_started" log event

**Solutions**:
1. Check `WORKFLOW_ENGINE_ENABLED` environment variable
2. Verify `WORKFLOW_DIR` exists and is writable
3. Check for database errors in logs
4. Verify SQLite database is not locked

### Issue: YAML files not detected

**Symptoms**: Workflows don't appear after creating .yaml files

**Solutions**:
1. Check file watcher logs: `grep workflow_file_watcher ~/.agentboard/agentboard.log`
2. Verify file is in correct directory: `echo $WORKFLOW_DIR`
3. Verify YAML is valid: `bun run validate-workflow <file.yaml>`
4. Check file permissions (must be readable)

### Issue: Workflows not executing

**Symptoms**: Workflow run stuck in "running" status

**Solutions**:
1. Check task queue: `SELECT * FROM tasks WHERE workflow_run_id IS NOT NULL`
2. Verify tmux is available: `which tmux`
3. Check task worker logs for errors
4. Verify step configuration (correct agent types, valid prompts)

### Issue: WebSocket updates not received

**Symptoms**: UI doesn't update when workflow status changes

**Solutions**:
1. Check browser console for WebSocket connection errors
2. Verify WebSocket endpoint: `ws://localhost:3000`
3. Check server logs for WebSocket connection events
4. Verify workflow store is subscribed to updates

## Security Considerations

- **YAML Parsing**: All YAML parsing is wrapped in try/catch to prevent malicious payloads from crashing the server
- **File Access**: Workflow engine only reads from `WORKFLOW_DIR`, cannot access arbitrary files
- **Command Execution**: `spawn_session` steps use existing task queue which already sandboxes tmux sessions
- **Authentication**: Workflow API endpoints use existing `AUTH_TOKEN` authentication (if configured)

## Post-Deployment Validation

### Checklist

- [ ] Server started successfully
- [ ] "workflow_engine_started" event in logs
- [ ] "workflow_file_watcher_started" event in logs
- [ ] Database tables created (workflows, workflow_runs)
- [ ] `/api/workflows` endpoint responds
- [ ] Test workflow file detected and parsed
- [ ] Existing task queue functionality works
- [ ] No errors in server logs
- [ ] WebSocket connections stable
- [ ] UI loads without errors

## Support & Escalation

For issues during deployment:

1. Check server logs: `~/.agentboard/agentboard.log`
2. Review this deployment guide troubleshooting section
3. Use feature flag to disable if critical issue found
4. Report issue with logs and reproduction steps

## Appendix: Configuration Examples

### systemd Service File

```ini
[Unit]
Description=Agentboard Server
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/agentboard
Environment="NODE_ENV=production"
Environment="WORKFLOW_ENGINE_ENABLED=true"
Environment="WORKFLOW_DIR=/home/your-user/.agentboard/workflows"
ExecStart=/usr/bin/bun run start
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

### Docker Compose

```yaml
version: '3.8'
services:
  agentboard:
    build: .
    ports:
      - "3000:3000"
    environment:
      - WORKFLOW_ENGINE_ENABLED=true
      - WORKFLOW_DIR=/app/workflows
      - WORKFLOW_MAX_CONCURRENT_RUNS=20
    volumes:
      - ./workflows:/app/workflows
      - ./data:/root/.agentboard
    restart: unless-stopped
```
