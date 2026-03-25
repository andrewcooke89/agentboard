//! Work order dispatcher: dependency resolution, parallel execution, state tracking.
//!
//! The dispatcher takes a group of work orders, builds a dependency graph,
//! and fires them through the executor with concurrency limits. State is
//! persisted to SQLite for observability and future resume capability.

pub mod graph;
pub mod scheduler;
pub mod state;

use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use tracing::info;

use crate::config::Config;
use crate::executor::ExecutionResult;
use crate::wo::WorkOrder;

use graph::DependencyGraph;
use scheduler::{Executor, RealExecutor, RoutingExecutor};
use state::{GroupStatus, StateStore, WoStatus};

// ── Configuration ───────────────────────────────────────────────────────────

/// Dispatcher-specific configuration (from CLI args, not YAML).
#[derive(Debug, Clone)]
pub struct DispatcherConfig {
    /// Maximum parallel executor tasks.
    pub max_concurrency: usize,
    /// Path to the SQLite state database.
    pub db_path: PathBuf,
    /// Number of permanently-failed WOs that trigger group abort.
    pub max_group_failures: u32,
}

impl Default for DispatcherConfig {
    fn default() -> Self {
        Self {
            max_concurrency: 4,
            db_path: dirs_next::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".agentboard")
                .join("dispatcher.db"),
            max_group_failures: 3,
        }
    }
}

// ── Result types ────────────────────────────────────────────────────────────

/// Result of dispatching an entire group.
#[derive(Debug, Serialize, Deserialize)]
pub struct GroupResult {
    pub group_id: String,
    pub status: GroupStatus,
    pub wo_results: Vec<WoResult>,
    pub total_duration_seconds: f64,
}

/// Result of a single work order within a group dispatch.
#[derive(Debug, Serialize, Deserialize)]
pub struct WoResult {
    pub wo_id: String,
    pub status: WoStatus,
    pub attempts: u32,
    pub execution_result: Option<ExecutionResult>,
    pub error: Option<String>,
}

// ── Public API ──────────────────────────────────────────────────────────────

/// Dispatch a group of work orders with dependency resolution and parallel execution.
///
/// This is the main entry point for the dispatcher. It:
/// 1. Validates the dependency graph (no cycles, no unknown deps)
/// 2. Initializes state persistence
/// 3. Fires WOs in dependency order with concurrency limits
/// 4. Returns the final group result
pub async fn dispatch_group(
    config: &Config,
    dispatcher_config: &DispatcherConfig,
    work_orders: Vec<WorkOrder>,
    working_dir: &Path,
) -> Result<GroupResult> {
    // Build a routing executor that delegates to API, Codex, or CC based on WO model.
    let codex_executor = config.resolve_codex_binary().map(|binary| {
        crate::codex_executor::CodexExecutor::new(binary, config.codex_max_concurrent)
    });
    let cc_executor = config.agentboard_url.as_ref().map(|url| {
        crate::cc_executor::CcExecutor::new(url.clone())
    });
    let executor = RoutingExecutor::new(RealExecutor, codex_executor, cc_executor);

    dispatch_group_with_executor(
        config,
        dispatcher_config,
        work_orders,
        working_dir,
        executor,
    )
    .await
}

/// Dispatch with a custom executor (for testing).
pub async fn dispatch_group_with_executor<E: Executor + Clone>(
    config: &Config,
    dispatcher_config: &DispatcherConfig,
    work_orders: Vec<WorkOrder>,
    working_dir: &Path,
    executor: E,
) -> Result<GroupResult> {
    if work_orders.is_empty() {
        bail!("No work orders to dispatch");
    }

    let group_id = work_orders[0].group_id.clone();
    info!(
        group_id = %group_id,
        wo_count = work_orders.len(),
        max_concurrency = dispatcher_config.max_concurrency,
        "Starting group dispatch"
    );

    // Build and validate the dependency graph.
    let graph_input: Vec<(String, Vec<String>)> = work_orders
        .iter()
        .map(|wo| (wo.id.clone(), wo.depends_on.clone()))
        .collect();
    let graph = DependencyGraph::build(&graph_input)?;

    if let Some(cycle) = graph.detect_cycle() {
        bail!("Dependency cycle detected: {}", cycle.join(" -> "));
    }

    info!(
        group_id = %group_id,
        topo_order = ?graph.topological_order()?,
        "Dependency graph validated"
    );

    // Initialize state store.
    if let Some(parent) = dispatcher_config.db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let state_store = StateStore::open(&dispatcher_config.db_path)?;

    // Run the scheduler.
    scheduler::run_dispatch_loop(
        config,
        dispatcher_config,
        &work_orders,
        &graph,
        &state_store,
        working_dir,
        executor,
    )
    .await
}
