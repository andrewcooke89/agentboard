//! SQLite-backed state persistence for work order and group lifecycle.
//!
//! Single-writer design: only the dispatcher writes. Future HTTP readers
//! open their own read-only connections.

use std::path::Path;

use anyhow::{Context as _, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::executor::ExecutionResult;

// ── Status enums ────────────────────────────────────────────────────────────

/// Work order status in the dispatcher state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WoStatus {
    Pending,
    Ready,
    Running,
    Completed,
    Failed,
    Escalated,
}

impl WoStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Ready => "ready",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Escalated => "escalated",
        }
    }

    fn from_str(s: &str) -> Self {
        match s {
            "ready" => Self::Ready,
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "escalated" => Self::Escalated,
            _ => Self::Pending,
        }
    }
}

// ── Escalation types ─────────────────────────────────────────────────────────

/// A single entry in a work order's error history, recorded on each failure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorHistoryEntry {
    pub tier: u32,
    pub model: String,
    pub attempt: u32,
    pub error: String,
    pub gate_detail: Option<String>,
}

/// Group status in the dispatcher state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GroupStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Aborted,
}

impl GroupStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Aborted => "aborted",
        }
    }

    fn from_str(s: &str) -> Self {
        match s {
            "running" => Self::Running,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "aborted" => Self::Aborted,
            _ => Self::Pending,
        }
    }
}

// ── Row types ───────────────────────────────────────────────────────────────

/// A snapshot of a work order's state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WoState {
    pub wo_id: String,
    pub group_id: String,
    pub status: WoStatus,
    pub attempt: u32,
    pub max_retries: u32,
    pub error_context: Option<String>,
    pub result_json: Option<String>,
    pub error_history: String,
    pub escalation_tier: u32,
}

/// A snapshot of a group's state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupState {
    pub group_id: String,
    pub status: GroupStatus,
    pub total_wos: u32,
    pub completed_wos: u32,
    pub failed_wos: u32,
    pub max_failures: u32,
}

// ── StateStore ──────────────────────────────────────────────────────────────

/// SQLite-backed state store for dispatcher state.
pub struct StateStore {
    conn: Connection,
}

impl StateStore {
    /// Open (or create) the state database at the given path.
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).context("Failed to open state database")?;
        let store = Self { conn };
        store.init_schema()?;
        Ok(store)
    }

    /// Open an in-memory database (for testing).
    pub fn open_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("Failed to open in-memory database")?;
        let store = Self { conn };
        store.init_schema()?;
        Ok(store)
    }

    fn init_schema(&self) -> Result<()> {
        self.conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;

             CREATE TABLE IF NOT EXISTS wo_state (
                 wo_id          TEXT PRIMARY KEY,
                 group_id       TEXT NOT NULL,
                 status         TEXT NOT NULL DEFAULT 'pending',
                 attempt        INTEGER NOT NULL DEFAULT 0,
                 max_retries    INTEGER NOT NULL DEFAULT 2,
                 error_context  TEXT,
                 result_json    TEXT,
                 started_at     TEXT,
                 completed_at   TEXT,
                 updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
             );

             CREATE TABLE IF NOT EXISTS group_state (
                 group_id       TEXT PRIMARY KEY,
                 status         TEXT NOT NULL DEFAULT 'pending',
                 total_wos      INTEGER NOT NULL DEFAULT 0,
                 completed_wos  INTEGER NOT NULL DEFAULT 0,
                 failed_wos     INTEGER NOT NULL DEFAULT 0,
                 max_failures   INTEGER NOT NULL DEFAULT 3,
                 started_at     TEXT,
                 completed_at   TEXT,
                 updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
             );

             CREATE INDEX IF NOT EXISTS idx_wo_state_group ON wo_state(group_id);
             CREATE INDEX IF NOT EXISTS idx_wo_state_status ON wo_state(status);",
        )?;

        // Migrate: add escalation columns if they don't exist.
        let columns: Vec<String> = self
            .conn
            .prepare("PRAGMA table_info(wo_state)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .filter_map(|r| r.ok())
            .collect();

        if !columns.contains(&"error_history".to_string()) {
            self.conn.execute(
                "ALTER TABLE wo_state ADD COLUMN error_history TEXT DEFAULT '[]'",
                [],
            )?;
        }
        if !columns.contains(&"escalation_tier".to_string()) {
            self.conn.execute(
                "ALTER TABLE wo_state ADD COLUMN escalation_tier INTEGER DEFAULT 0",
                [],
            )?;
        }

        Ok(())
    }

    // ── Group operations ────────────────────────────────────────────────

    /// Initialize a group and all its work orders.
    pub fn init_group(
        &self,
        group_id: &str,
        wo_ids: &[(String, u32)], // (wo_id, max_retries)
        max_failures: u32,
    ) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;

        tx.execute(
            "INSERT OR REPLACE INTO group_state (group_id, status, total_wos, completed_wos, failed_wos, max_failures, updated_at)
             VALUES (?1, 'pending', ?2, 0, 0, ?3, datetime('now'))",
            params![group_id, wo_ids.len() as u32, max_failures],
        )?;

        for (wo_id, max_retries) in wo_ids {
            tx.execute(
                "INSERT OR REPLACE INTO wo_state (wo_id, group_id, status, attempt, max_retries, updated_at)
                 VALUES (?1, ?2, 'pending', 0, ?3, datetime('now'))",
                params![wo_id, group_id, max_retries],
            )?;
        }

        tx.commit()?;
        Ok(())
    }

    /// Mark the group as running (first WO started).
    pub fn mark_group_running(&self, group_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE group_state SET status = 'running', started_at = datetime('now'), updated_at = datetime('now')
             WHERE group_id = ?1 AND status = 'pending'",
            params![group_id],
        )?;
        Ok(())
    }

    /// Get the current group state.
    pub fn get_group_state(&self, group_id: &str) -> Result<GroupState> {
        let row = self.conn.query_row(
            "SELECT group_id, status, total_wos, completed_wos, failed_wos, max_failures
             FROM group_state WHERE group_id = ?1",
            params![group_id],
            |row| {
                Ok(GroupState {
                    group_id: row.get(0)?,
                    status: GroupStatus::from_str(&row.get::<_, String>(1)?),
                    total_wos: row.get(2)?,
                    completed_wos: row.get(3)?,
                    failed_wos: row.get(4)?,
                    max_failures: row.get(5)?,
                })
            },
        )?;
        Ok(row)
    }

    /// Finalize the group status based on WO outcomes.
    pub fn finalize_group(&self, group_id: &str) -> Result<GroupState> {
        let state = self.get_group_state(group_id)?;
        let new_status = if state.completed_wos == state.total_wos {
            GroupStatus::Completed
        } else if state.failed_wos >= state.max_failures {
            GroupStatus::Aborted
        } else {
            GroupStatus::Failed
        };
        self.conn.execute(
            "UPDATE group_state SET status = ?1, completed_at = datetime('now'), updated_at = datetime('now')
             WHERE group_id = ?2",
            params![new_status.as_str(), group_id],
        )?;
        self.get_group_state(group_id)
    }

    // ── WO operations ───────────────────────────────────────────────────

    /// Mark a WO as ready (dependencies satisfied).
    pub fn mark_ready(&self, wo_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE wo_state SET status = 'ready', updated_at = datetime('now') WHERE wo_id = ?1",
            params![wo_id],
        )?;
        Ok(())
    }

    /// Mark a WO as running (executor started).
    pub fn mark_running(&self, wo_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE wo_state SET status = 'running', started_at = datetime('now'), updated_at = datetime('now')
             WHERE wo_id = ?1",
            params![wo_id],
        )?;
        Ok(())
    }

    /// Mark a WO as completed with its execution result.
    pub fn mark_completed(&self, wo_id: &str, result: &ExecutionResult) -> Result<()> {
        let result_json = serde_json::to_string(result)?;
        let tx = self.conn.unchecked_transaction()?;

        // Get group_id first.
        let group_id: String = tx.query_row(
            "SELECT group_id FROM wo_state WHERE wo_id = ?1",
            params![wo_id],
            |row| row.get(0),
        )?;

        tx.execute(
            "UPDATE wo_state SET status = 'completed', result_json = ?1, completed_at = datetime('now'), updated_at = datetime('now')
             WHERE wo_id = ?2",
            params![result_json, wo_id],
        )?;

        tx.execute(
            "UPDATE group_state SET completed_wos = completed_wos + 1, updated_at = datetime('now')
             WHERE group_id = ?1",
            params![group_id],
        )?;

        tx.commit()?;
        Ok(())
    }

    /// Mark a WO as failed, incrementing the attempt counter.
    ///
    /// Returns `true` if the WO can be retried, `false` if retries exhausted.
    pub fn mark_failed(&self, wo_id: &str, error: &str) -> Result<bool> {
        let tx = self.conn.unchecked_transaction()?;

        tx.execute(
            "UPDATE wo_state SET status = 'failed', attempt = attempt + 1, error_context = ?1, updated_at = datetime('now')
             WHERE wo_id = ?2",
            params![error, wo_id],
        )?;

        let (attempt, max_retries): (u32, u32) = tx.query_row(
            "SELECT attempt, max_retries FROM wo_state WHERE wo_id = ?1",
            params![wo_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        let can_retry = attempt < max_retries;

        if !can_retry {
            // Increment group failure counter.
            let group_id: String = tx.query_row(
                "SELECT group_id FROM wo_state WHERE wo_id = ?1",
                params![wo_id],
                |row| row.get(0),
            )?;
            tx.execute(
                "UPDATE group_state SET failed_wos = failed_wos + 1, updated_at = datetime('now')
                 WHERE group_id = ?1",
                params![group_id],
            )?;
        }

        tx.commit()?;
        Ok(can_retry)
    }

    /// Check if the group should abort (too many failures).
    pub fn should_abort(&self, group_id: &str) -> Result<bool> {
        let state = self.get_group_state(group_id)?;
        Ok(state.failed_wos >= state.max_failures)
    }

    /// Get the current state of a work order.
    pub fn get_wo_state(&self, wo_id: &str) -> Result<WoState> {
        let row = self.conn.query_row(
            "SELECT wo_id, group_id, status, attempt, max_retries, error_context, result_json,
                    COALESCE(error_history, '[]'), COALESCE(escalation_tier, 0)
             FROM wo_state WHERE wo_id = ?1",
            params![wo_id],
            |row| {
                Ok(WoState {
                    wo_id: row.get(0)?,
                    group_id: row.get(1)?,
                    status: WoStatus::from_str(&row.get::<_, String>(2)?),
                    attempt: row.get(3)?,
                    max_retries: row.get(4)?,
                    error_context: row.get(5)?,
                    result_json: row.get(6)?,
                    error_history: row.get(7)?,
                    escalation_tier: row.get::<_, i64>(8)? as u32,
                })
            },
        )?;
        Ok(row)
    }

    /// Get all WO states for a group.
    pub fn get_all_wo_states(&self, group_id: &str) -> Result<Vec<WoState>> {
        let mut stmt = self.conn.prepare(
            "SELECT wo_id, group_id, status, attempt, max_retries, error_context, result_json,
                    COALESCE(error_history, '[]'), COALESCE(escalation_tier, 0)
             FROM wo_state WHERE group_id = ?1 ORDER BY wo_id",
        )?;

        let rows = stmt.query_map(params![group_id], |row| {
            Ok(WoState {
                wo_id: row.get(0)?,
                group_id: row.get(1)?,
                status: WoStatus::from_str(&row.get::<_, String>(2)?),
                attempt: row.get(3)?,
                max_retries: row.get(4)?,
                error_context: row.get(5)?,
                result_json: row.get(6)?,
                error_history: row.get(7)?,
                escalation_tier: row.get::<_, i64>(8)? as u32,
            })
        })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        Ok(result)
    }

    // ── Escalation operations ────────────────────────────────────────────

    /// Append an error entry to a WO's error history.
    pub fn append_error_history(&self, wo_id: &str, entry: &ErrorHistoryEntry) -> Result<()> {
        let current: String = self.conn.query_row(
            "SELECT COALESCE(error_history, '[]') FROM wo_state WHERE wo_id = ?1",
            [wo_id],
            |row| row.get(0),
        )?;
        let mut history: Vec<ErrorHistoryEntry> =
            serde_json::from_str(&current).unwrap_or_default();
        history.push(entry.clone());
        let json = serde_json::to_string(&history)?;
        self.conn.execute(
            "UPDATE wo_state SET error_history = ?1 WHERE wo_id = ?2",
            rusqlite::params![json, wo_id],
        )?;
        Ok(())
    }

    /// Get the full error history for a WO.
    pub fn get_error_history(&self, wo_id: &str) -> Result<Vec<ErrorHistoryEntry>> {
        let json: String = self.conn.query_row(
            "SELECT COALESCE(error_history, '[]') FROM wo_state WHERE wo_id = ?1",
            [wo_id],
            |row| row.get(0),
        )?;
        Ok(serde_json::from_str(&json).unwrap_or_default())
    }

    /// Set the escalation tier for a WO.
    pub fn set_escalation_tier(&self, wo_id: &str, tier: u32) -> Result<()> {
        self.conn.execute(
            "UPDATE wo_state SET escalation_tier = ?1 WHERE wo_id = ?2",
            rusqlite::params![tier as i64, wo_id],
        )?;
        Ok(())
    }

    /// Get the current escalation tier for a WO.
    pub fn get_escalation_tier(&self, wo_id: &str) -> Result<u32> {
        let tier: i64 = self.conn.query_row(
            "SELECT COALESCE(escalation_tier, 0) FROM wo_state WHERE wo_id = ?1",
            [wo_id],
            |row| row.get(0),
        )?;
        Ok(tier as u32)
    }

    /// Count WOs in a group that have been escalated to the CC tier (tier >= cc_tier_index).
    pub fn count_escalated_to_cc(&self, group_id: &str, cc_tier_index: u32) -> Result<u32> {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM wo_state WHERE group_id = ?1 AND COALESCE(escalation_tier, 0) >= ?2",
            rusqlite::params![group_id, cc_tier_index as i64],
            |row| row.get(0),
        )?;
        Ok(count as u32)
    }

    /// Reset the attempt counter for a WO (used when escalating to a new tier).
    pub fn reset_attempts(&self, wo_id: &str, new_max_retries: u32) -> Result<()> {
        self.conn.execute(
            "UPDATE wo_state SET attempt = 0, max_retries = ?1 WHERE wo_id = ?2",
            rusqlite::params![new_max_retries as i64, wo_id],
        )?;
        Ok(())
    }

    /// Mark a WO as escalated to a new tier.
    pub fn mark_escalated(&self, wo_id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE wo_state SET status = 'escalated' WHERE wo_id = ?1",
            [wo_id],
        )?;
        Ok(())
    }

    /// Check if a group should abort due to too many failures or CC escalations.
    pub fn should_abort_with_escalations(
        &self,
        group_id: &str,
        cc_tier_index: u32,
    ) -> Result<bool> {
        // Check original abort condition (permanent failures >= max_failures).
        let basic = self.should_abort(group_id)?;
        if basic {
            return Ok(true);
        }

        // Also abort if too many WOs escalated to CC.
        let cc_count = self.count_escalated_to_cc(group_id, cc_tier_index)?;
        let state = self.get_group_state(group_id)?;
        // Abort if >50% of WOs escalated to CC (or at least 3).
        let threshold = std::cmp::max(3, state.total_wos / 2);
        Ok(cc_count >= threshold)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock_execution_result(wo_id: &str, success: bool) -> ExecutionResult {
        ExecutionResult {
            work_order_id: wo_id.to_string(),
            success,
            error: if success {
                None
            } else {
                Some("test error".into())
            },
            diffs: vec![],
            tool_calls: vec![],
            token_usage: crate::executor::TokenUsage {
                input_tokens: 0,
                output_tokens: 0,
            },
            iterations: 1,
            retries_used: 0,
            gate_results: None,
            contract_violation: None,
            unified_diff: None,
        }
    }

    #[test]
    fn test_init_and_read() {
        let store = StateStore::open_memory().unwrap();
        store
            .init_group("grp-1", &[("WO-1".into(), 2), ("WO-2".into(), 3)], 3)
            .unwrap();

        let gs = store.get_group_state("grp-1").unwrap();
        assert_eq!(gs.status, GroupStatus::Pending);
        assert_eq!(gs.total_wos, 2);
        assert_eq!(gs.completed_wos, 0);
        assert_eq!(gs.failed_wos, 0);

        let wos = store.get_all_wo_states("grp-1").unwrap();
        assert_eq!(wos.len(), 2);
        assert_eq!(wos[0].status, WoStatus::Pending);
        assert_eq!(wos[0].max_retries, 2);
        assert_eq!(wos[1].max_retries, 3);
    }

    #[test]
    fn test_state_transitions() {
        let store = StateStore::open_memory().unwrap();
        store.init_group("grp-1", &[("WO-1".into(), 2)], 3).unwrap();

        store.mark_ready("WO-1").unwrap();
        assert_eq!(store.get_wo_state("WO-1").unwrap().status, WoStatus::Ready);

        store.mark_running("WO-1").unwrap();
        assert_eq!(
            store.get_wo_state("WO-1").unwrap().status,
            WoStatus::Running
        );

        let result = mock_execution_result("WO-1", true);
        store.mark_completed("WO-1", &result).unwrap();
        assert_eq!(
            store.get_wo_state("WO-1").unwrap().status,
            WoStatus::Completed
        );

        let gs = store.get_group_state("grp-1").unwrap();
        assert_eq!(gs.completed_wos, 1);
    }

    #[test]
    fn test_retry_tracking() {
        let store = StateStore::open_memory().unwrap();
        store.init_group("grp-1", &[("WO-1".into(), 2)], 3).unwrap();

        // First failure — can retry.
        let can_retry = store.mark_failed("WO-1", "error 1").unwrap();
        assert!(can_retry);
        let ws = store.get_wo_state("WO-1").unwrap();
        assert_eq!(ws.attempt, 1);
        assert_eq!(ws.error_context.as_deref(), Some("error 1"));

        // Second failure — retries exhausted.
        let can_retry = store.mark_failed("WO-1", "error 2").unwrap();
        assert!(!can_retry);
        let ws = store.get_wo_state("WO-1").unwrap();
        assert_eq!(ws.attempt, 2);

        // Group failure counter incremented.
        let gs = store.get_group_state("grp-1").unwrap();
        assert_eq!(gs.failed_wos, 1);
    }

    #[test]
    fn test_group_abort_threshold() {
        let store = StateStore::open_memory().unwrap();
        store
            .init_group(
                "grp-1",
                &[
                    ("WO-1".into(), 0), // 0 retries = fail immediately
                    ("WO-2".into(), 0),
                    ("WO-3".into(), 0),
                    ("WO-4".into(), 0),
                ],
                2, // abort after 2 failures
            )
            .unwrap();

        // First failure: no abort yet.
        store.mark_failed("WO-1", "err").unwrap();
        assert!(!store.should_abort("grp-1").unwrap());

        // Second failure: abort threshold reached.
        store.mark_failed("WO-2", "err").unwrap();
        assert!(store.should_abort("grp-1").unwrap());
    }

    #[test]
    fn test_finalize_group_completed() {
        let store = StateStore::open_memory().unwrap();
        store
            .init_group("grp-1", &[("WO-1".into(), 2), ("WO-2".into(), 2)], 3)
            .unwrap();
        store.mark_group_running("grp-1").unwrap();

        let r1 = mock_execution_result("WO-1", true);
        let r2 = mock_execution_result("WO-2", true);
        store.mark_completed("WO-1", &r1).unwrap();
        store.mark_completed("WO-2", &r2).unwrap();

        let gs = store.finalize_group("grp-1").unwrap();
        assert_eq!(gs.status, GroupStatus::Completed);
    }

    #[test]
    fn test_finalize_group_failed() {
        let store = StateStore::open_memory().unwrap();
        store
            .init_group("grp-1", &[("WO-1".into(), 0), ("WO-2".into(), 0)], 5)
            .unwrap();
        store.mark_group_running("grp-1").unwrap();

        let r1 = mock_execution_result("WO-1", true);
        store.mark_completed("WO-1", &r1).unwrap();
        store.mark_failed("WO-2", "err").unwrap(); // exhausted (0 retries)

        let gs = store.finalize_group("grp-1").unwrap();
        assert_eq!(gs.status, GroupStatus::Failed);
    }

    #[test]
    fn test_finalize_group_aborted() {
        let store = StateStore::open_memory().unwrap();
        store
            .init_group(
                "grp-1",
                &[("WO-1".into(), 0), ("WO-2".into(), 0), ("WO-3".into(), 0)],
                2,
            )
            .unwrap();
        store.mark_group_running("grp-1").unwrap();

        store.mark_failed("WO-1", "err").unwrap();
        store.mark_failed("WO-2", "err").unwrap();
        // WO-3 never ran.

        let gs = store.finalize_group("grp-1").unwrap();
        assert_eq!(gs.status, GroupStatus::Aborted);
    }

    #[test]
    fn test_error_history_append_and_get() {
        let store = StateStore::open_memory().unwrap();
        store.init_group("g1", &[("wo1".into(), 2)], 3).unwrap();

        let entry = ErrorHistoryEntry {
            tier: 0,
            model: "glm-5".to_string(),
            attempt: 1,
            error: "typecheck failed".to_string(),
            gate_detail: Some("error TS2345...".to_string()),
        };
        store.append_error_history("wo1", &entry).unwrap();

        let history = store.get_error_history("wo1").unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].model, "glm-5");

        // Append another.
        let entry2 = ErrorHistoryEntry {
            tier: 1,
            model: "codex".to_string(),
            attempt: 0,
            error: "lint failed".to_string(),
            gate_detail: None,
        };
        store.append_error_history("wo1", &entry2).unwrap();
        let history = store.get_error_history("wo1").unwrap();
        assert_eq!(history.len(), 2);
    }

    #[test]
    fn test_escalation_tier_tracking() {
        let store = StateStore::open_memory().unwrap();
        store.init_group("g1", &[("wo1".into(), 2)], 3).unwrap();

        assert_eq!(store.get_escalation_tier("wo1").unwrap(), 0);
        store.set_escalation_tier("wo1", 1).unwrap();
        assert_eq!(store.get_escalation_tier("wo1").unwrap(), 1);
    }

    #[test]
    fn test_count_escalated_to_cc() {
        let store = StateStore::open_memory().unwrap();
        store
            .init_group(
                "g1",
                &[("wo1".into(), 2), ("wo2".into(), 2), ("wo3".into(), 2)],
                3,
            )
            .unwrap();

        // No escalations yet.
        assert_eq!(store.count_escalated_to_cc("g1", 2).unwrap(), 0);

        // Escalate wo1 to tier 2 (CC).
        store.set_escalation_tier("wo1", 2).unwrap();
        assert_eq!(store.count_escalated_to_cc("g1", 2).unwrap(), 1);

        // Escalate wo2 to tier 1 (not CC).
        store.set_escalation_tier("wo2", 1).unwrap();
        assert_eq!(store.count_escalated_to_cc("g1", 2).unwrap(), 1);
    }

    #[test]
    fn test_reset_attempts() {
        let store = StateStore::open_memory().unwrap();
        store.init_group("g1", &[("wo1".into(), 2)], 3).unwrap();

        // Use up some attempts.
        store.mark_ready("wo1").unwrap();
        store.mark_running("wo1").unwrap();
        store.mark_failed("wo1", "err1").unwrap();

        // Reset for new tier.
        store.reset_attempts("wo1", 3).unwrap();
        // Should be able to retry again.
        store.mark_ready("wo1").unwrap();
        store.mark_running("wo1").unwrap();
        let can_retry = store.mark_failed("wo1", "err2").unwrap();
        assert!(can_retry); // attempt 1 < max_retries 3
    }

    #[test]
    fn test_mark_escalated_status() {
        let store = StateStore::open_memory().unwrap();
        store.init_group("g1", &[("wo1".into(), 2)], 3).unwrap();

        store.mark_escalated("wo1").unwrap();
        assert_eq!(
            store.get_wo_state("wo1").unwrap().status,
            WoStatus::Escalated
        );
    }

    #[test]
    fn test_should_abort_with_escalations() {
        let store = StateStore::open_memory().unwrap();
        // 6 WOs; cc threshold = max(3, 6/2) = 3
        store
            .init_group(
                "g1",
                &[
                    ("wo1".into(), 0),
                    ("wo2".into(), 0),
                    ("wo3".into(), 0),
                    ("wo4".into(), 0),
                    ("wo5".into(), 0),
                    ("wo6".into(), 0),
                ],
                10, // high failure limit so basic abort won't fire
            )
            .unwrap();

        // Escalate 2 WOs to CC tier (2) — below threshold.
        store.set_escalation_tier("wo1", 2).unwrap();
        store.set_escalation_tier("wo2", 2).unwrap();
        assert!(!store.should_abort_with_escalations("g1", 2).unwrap());

        // Escalate a 3rd — at threshold, should abort.
        store.set_escalation_tier("wo3", 2).unwrap();
        assert!(store.should_abort_with_escalations("g1", 2).unwrap());
    }
}
