//! Async dispatch loop with concurrency limiting.
//!
//! Spawns executor tasks gated by a semaphore, reacts to completion/failure
//! events via an mpsc channel, and drives the dependency graph forward.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use async_trait::async_trait;

use tokio::sync::{mpsc, Semaphore};
use tracing::{info, warn};

use crate::config::Config;
use crate::event_reporter::{
    ErrorHistoryEntrySummary, EventReporter, GateEntry, GateResultSummary, SwarmEvent,
    TokenUsageSummary,
};
use crate::executor::ExecutionResult;
use crate::wo::WorkOrder;

use super::graph::DependencyGraph;
use super::state::StateStore;
use super::{DispatcherConfig, GroupResult, WoResult};

// -- Executor trait ----------------------------------------------------------

/// Abstraction over the execution function for testability.
#[async_trait]
pub trait Executor: Send + Sync + 'static {
    async fn execute(
        &self,
        config: &Config,
        work_order: &WorkOrder,
        working_dir: &Path,
    ) -> Result<ExecutionResult>;
}

/// Production executor that calls the real execute function.
#[derive(Clone)]
pub struct RealExecutor;

#[async_trait]
impl Executor for RealExecutor {
    async fn execute(
        &self,
        config: &Config,
        work_order: &WorkOrder,
        working_dir: &Path,
    ) -> Result<ExecutionResult> {
        crate::executor::execute(config, work_order, working_dir).await
    }
}

/// Routing executor that delegates to API, Codex, or CC executor based on the WO model.
#[derive(Clone)]
pub struct RoutingExecutor {
    api_executor: RealExecutor,
    codex_executor: Option<crate::codex_executor::CodexExecutor>,
    cc_executor: Option<crate::cc_executor::CcExecutor>,
}

impl RoutingExecutor {
    pub fn new(
        api_executor: RealExecutor,
        codex_executor: Option<crate::codex_executor::CodexExecutor>,
        cc_executor: Option<crate::cc_executor::CcExecutor>,
    ) -> Self {
        Self {
            api_executor,
            codex_executor,
            cc_executor,
        }
    }
}

#[async_trait]
impl Executor for RoutingExecutor {
    async fn execute(
        &self,
        config: &Config,
        work_order: &WorkOrder,
        working_dir: &Path,
    ) -> Result<ExecutionResult> {
        let model = if work_order.execution.model.is_empty() {
            &config.default_model
        } else {
            &work_order.execution.model
        };

        if model.starts_with("codex") {
            match &self.codex_executor {
                Some(ce) => ce.execute(config, work_order, working_dir).await,
                None => anyhow::bail!(
                    "Work order {} requests model '{}' but no Codex binary is configured",
                    work_order.id,
                    model
                ),
            }
        } else if model == "opus-cc" {
            match &self.cc_executor {
                Some(ce) => ce.execute(config, work_order, working_dir).await,
                None => anyhow::bail!(
                    "Work order {} requests model '{}' but no CC executor is configured",
                    work_order.id,
                    model
                ),
            }
        } else {
            self.api_executor
                .execute(config, work_order, working_dir)
                .await
        }
    }
}

// -- Event types -------------------------------------------------------------

/// Events sent from spawned executor tasks back to the main dispatch loop.
#[derive(Debug)]
enum DispatchEvent {
    Completed {
        wo_id: String,
        result: ExecutionResult,
    },
    Failed {
        wo_id: String,
        result: ExecutionResult,
    },
    ExecutorError {
        wo_id: String,
        error: String,
    },
}

// -- Dispatch loop -----------------------------------------------------------

/// Run the main dispatch loop.
///
/// Manages the lifecycle of all WOs in the group: fires ready WOs through
/// the executor with concurrency limits, handles completions and failures,
/// retries, escalation, and group abort.
pub async fn run_dispatch_loop<E: Executor + Clone>(
    config: &Config,
    dispatcher_config: &DispatcherConfig,
    work_orders: &[WorkOrder],
    graph: &DependencyGraph,
    state_store: &StateStore,
    working_dir: &Path,
    executor: E,
    event_reporter: EventReporter,
) -> Result<GroupResult> {
    let start = Instant::now();
    let group_id = work_orders[0].group_id.clone();

    // Index WOs by ID for quick lookup.
    let wo_map: HashMap<String, WorkOrder> = work_orders
        .iter()
        .map(|wo| (wo.id.clone(), wo.clone()))
        .collect();

    // Initialize state.
    let wo_init: Vec<(String, u32)> = work_orders
        .iter()
        .map(|wo| (wo.id.clone(), wo.execution.max_retries))
        .collect();
    state_store.init_group(&group_id, &wo_init, dispatcher_config.max_group_failures)?;

    // Track completed and permanently-failed WOs for graph queries.
    let mut completed: HashSet<String> = HashSet::new();
    let mut failed_permanent: HashSet<String> = HashSet::new();
    let mut running: HashSet<String> = HashSet::new();
    let mut run_started_at: HashMap<String, Instant> = HashMap::new();
    let mut aborted = false;

    // Model overrides for escalated WOs.
    let mut model_overrides: HashMap<String, String> = HashMap::new();

    // Concurrency limiter.
    let semaphore = Arc::new(Semaphore::new(dispatcher_config.max_concurrency));

    // Event channel.
    let (tx, mut rx) = mpsc::channel::<DispatchEvent>(64);

    // Find initial ready set and fire them.
    let ready = graph.ready_ids(&completed);
    if !ready.is_empty() {
        state_store.mark_group_running(&group_id)?;
    }

    for wo_id in &ready {
        state_store.mark_ready(wo_id)?;
        spawn_executor(
            wo_id,
            &group_id,
            &wo_map,
            config,
            working_dir,
            &executor,
            &semaphore,
            &tx,
            state_store,
            &mut running,
            &mut run_started_at,
            &model_overrides,
            &event_reporter,
        )
        .await?;
    }

    // Main event loop: react to completions/failures until done.
    while !running.is_empty() {
        let event = rx.recv().await;
        let event = match event {
            Some(e) => e,
            None => break, // All senders dropped.
        };

        match event {
            DispatchEvent::Completed { wo_id, result } => {
                running.remove(&wo_id);
                let duration_seconds = run_started_at
                    .remove(&wo_id)
                    .map(|started_at| started_at.elapsed().as_secs_f64())
                    .unwrap_or(0.0);
                state_store.mark_completed(&wo_id, &result)?;
                completed.insert(wo_id.clone());

                event_reporter
                    .report(SwarmEvent::WoCompleted {
                        group_id: group_id.clone(),
                        timestamp: EventReporter::now_iso(),
                        wo_id: wo_id.clone(),
                        token_usage: TokenUsageSummary {
                            input_tokens: result.token_usage.input_tokens,
                            output_tokens: result.token_usage.output_tokens,
                        },
                        gate_results: summarize_gate_results(&result),
                        files_changed: result.diffs.iter().map(|d| d.file.clone()).collect(),
                        unified_diff: result.unified_diff.clone(),
                        duration_seconds,
                    })
                    .await;

                info!(wo_id = %wo_id, "WO completed successfully");

                if aborted {
                    continue; // Don't fire new WOs after abort.
                }

                // Find newly unblocked WOs.
                let all_done: HashSet<String> =
                    completed.union(&failed_permanent).cloned().collect();
                let newly_ready: Vec<String> = graph
                    .ready_ids(&all_done)
                    .into_iter()
                    .filter(|id| {
                        !running.contains(id)
                            && !completed.contains(id)
                            && !failed_permanent.contains(id)
                    })
                    .collect();

                for wo_id in &newly_ready {
                    state_store.mark_ready(wo_id)?;
                    spawn_executor(
                        wo_id,
                        &group_id,
                        &wo_map,
                        config,
                        working_dir,
                        &executor,
                        &semaphore,
                        &tx,
                        state_store,
                        &mut running,
                        &mut run_started_at,
                        &model_overrides,
                        &event_reporter,
                    )
                    .await?;
                }
            }

            DispatchEvent::Failed { wo_id, result } => {
                running.remove(&wo_id);
                run_started_at.remove(&wo_id);

                let error_msg = result
                    .error
                    .clone()
                    .unwrap_or_else(|| "Execution failed".to_string());
                let gate_detail = result
                    .gate_results
                    .as_ref()
                    .and_then(|gr| gr.error_context.clone());

                // Record error history entry.
                let current_tier = state_store.get_escalation_tier(&wo_id).unwrap_or(0);
                let current_model = model_overrides
                    .get(&wo_id)
                    .cloned()
                    .unwrap_or_else(|| effective_model(config, &wo_map[&wo_id]));
                let current_attempt = state_store
                    .get_wo_state(&wo_id)
                    .map(|s| s.attempt)
                    .unwrap_or(0);

                event_reporter
                    .report(SwarmEvent::WoFailed {
                        group_id: group_id.clone(),
                        timestamp: EventReporter::now_iso(),
                        wo_id: wo_id.clone(),
                        error: error_msg.clone(),
                        gate_detail: gate_detail.clone(),
                        model: current_model.clone(),
                        attempt: current_attempt,
                        tier: current_tier,
                    })
                    .await;

                let history_entry = super::state::ErrorHistoryEntry {
                    tier: current_tier,
                    model: current_model.clone(),
                    attempt: current_attempt,
                    error: error_msg.clone(),
                    gate_detail,
                };
                let _ = state_store.append_error_history(&wo_id, &history_entry);

                // Check for contract violation -- skip directly to CC tier.
                if let Some(ref violation) = result.contract_violation {
                    let wo = &wo_map[&wo_id];
                    if wo.escalation.enabled {
                        let chain = wo.escalation.effective_chain();
                        // Find CC tier (model == "opus-cc").
                        // Chain index is 0-based, escalation_tier = chain_index + 1.
                        // NOTE: opus-cc is an Anthropic model — skip it if found, since
                        // the Anthropic API is unavailable and will always 401.
                        let cc_candidate = chain
                            .iter()
                            .enumerate()
                            .find(|(_, t)| t.model == "opus-cc");
                        let cc_candidate = cc_candidate.and_then(|(idx, tier)| {
                            if tier.model.starts_with("opus") || tier.model.starts_with("claude") {
                                warn!(
                                    wo_id = %wo_id,
                                    model = %tier.model,
                                    "Contract violation: skipping CC tier — Anthropic API model not available"
                                );
                                None
                            } else {
                                Some((idx, tier))
                            }
                        });
                        if let Some((cc_chain_idx, cc_tier)) = cc_candidate {
                            info!(
                                wo_id = %wo_id,
                                violation = %violation,
                                "Contract violation, escalating directly to CC"
                            );
                            state_store.set_escalation_tier(&wo_id, (cc_chain_idx + 1) as u32)?;
                            state_store.reset_attempts(&wo_id, cc_tier.max_retries)?;
                            model_overrides.insert(wo_id.clone(), cc_tier.model.clone());
                            event_reporter
                                .report(SwarmEvent::WoEscalated {
                                    group_id: group_id.clone(),
                                    timestamp: EventReporter::now_iso(),
                                    wo_id: wo_id.clone(),
                                    from_tier: current_tier,
                                    to_tier: (cc_chain_idx + 1) as u32,
                                    to_model: cc_tier.model.clone(),
                                    error_history: state_store
                                        .get_error_history(&wo_id)?
                                        .into_iter()
                                        .map(|e| ErrorHistoryEntrySummary {
                                            tier: e.tier,
                                            model: e.model,
                                            attempt: e.attempt,
                                            error: e.error,
                                            gate_detail: e.gate_detail,
                                        })
                                        .collect(),
                                })
                                .await;
                            state_store.mark_ready(&wo_id)?;
                            spawn_executor(
                                &wo_id,
                                &group_id,
                                &wo_map,
                                config,
                                working_dir,
                                &executor,
                                &semaphore,
                                &tx,
                                state_store,
                                &mut running,
                                &mut run_started_at,
                                &model_overrides,
                                &event_reporter,
                            )
                            .await?;
                            continue;
                        }
                    }
                    // No CC tier configured -- fall through to normal failure handling.
                }

                // Normal retry/escalation logic.
                let can_retry = state_store.mark_failed(&wo_id, &error_msg)?;

                if can_retry && !aborted {
                    info!(wo_id = %wo_id, "WO failed, retrying at same tier");
                    state_store.mark_ready(&wo_id)?;
                    spawn_executor(
                        &wo_id,
                        &group_id,
                        &wo_map,
                        config,
                        working_dir,
                        &executor,
                        &semaphore,
                        &tx,
                        state_store,
                        &mut running,
                        &mut run_started_at,
                        &model_overrides,
                        &event_reporter,
                    )
                    .await?;
                } else if !aborted {
                    // Retries exhausted at current tier -- try escalation.
                    if try_escalate(
                        &wo_id,
                        &group_id,
                        &wo_map,
                        config,
                        working_dir,
                        &executor,
                        &semaphore,
                        &tx,
                        state_store,
                        &mut running,
                        &mut run_started_at,
                        &mut model_overrides,
                        current_tier,
                        &event_reporter,
                    )
                    .await?
                    {
                        // Escalation succeeded, WO re-spawned at next tier.
                    } else {
                        // All tiers exhausted or escalation disabled -- permanent failure.
                        warn!(wo_id = %wo_id, "WO permanently failed");
                        failed_permanent.insert(wo_id.clone());
                        check_abort(&group_id, state_store, &mut aborted)?;
                    }
                } else {
                    // Already aborted.
                    failed_permanent.insert(wo_id.clone());
                }
            }

            DispatchEvent::ExecutorError { wo_id, error } => {
                running.remove(&wo_id);
                run_started_at.remove(&wo_id);

                // Record error history entry.
                let current_tier = state_store.get_escalation_tier(&wo_id).unwrap_or(0);
                let current_model = model_overrides
                    .get(&wo_id)
                    .cloned()
                    .unwrap_or_else(|| effective_model(config, &wo_map[&wo_id]));
                let current_attempt = state_store
                    .get_wo_state(&wo_id)
                    .map(|s| s.attempt)
                    .unwrap_or(0);

                event_reporter
                    .report(SwarmEvent::WoFailed {
                        group_id: group_id.clone(),
                        timestamp: EventReporter::now_iso(),
                        wo_id: wo_id.clone(),
                        error: error.clone(),
                        gate_detail: None,
                        model: current_model.clone(),
                        attempt: current_attempt,
                        tier: current_tier,
                    })
                    .await;

                let history_entry = super::state::ErrorHistoryEntry {
                    tier: current_tier,
                    model: current_model.clone(),
                    attempt: current_attempt,
                    error: error.clone(),
                    gate_detail: None,
                };
                let _ = state_store.append_error_history(&wo_id, &history_entry);

                let can_retry = state_store.mark_failed(&wo_id, &error)?;

                if can_retry && !aborted {
                    info!(wo_id = %wo_id, "WO executor error, retrying");
                    state_store.mark_ready(&wo_id)?;
                    spawn_executor(
                        &wo_id,
                        &group_id,
                        &wo_map,
                        config,
                        working_dir,
                        &executor,
                        &semaphore,
                        &tx,
                        state_store,
                        &mut running,
                        &mut run_started_at,
                        &model_overrides,
                        &event_reporter,
                    )
                    .await?;
                } else if !aborted {
                    if try_escalate(
                        &wo_id,
                        &group_id,
                        &wo_map,
                        config,
                        working_dir,
                        &executor,
                        &semaphore,
                        &tx,
                        state_store,
                        &mut running,
                        &mut run_started_at,
                        &mut model_overrides,
                        current_tier,
                        &event_reporter,
                    )
                    .await?
                    {
                        // Escalated.
                    } else {
                        warn!(wo_id = %wo_id, "WO permanently failed (executor error)");
                        failed_permanent.insert(wo_id.clone());
                        check_abort(&group_id, state_store, &mut aborted)?;
                    }
                } else {
                    failed_permanent.insert(wo_id.clone());
                }
            }
        }
    }

    // Finalize group state.
    let group_state = state_store.finalize_group(&group_id)?;
    let elapsed = start.elapsed().as_secs_f64();

    // Build per-WO results.
    let wo_states = state_store.get_all_wo_states(&group_id)?;
    let wo_results: Vec<WoResult> = wo_states
        .into_iter()
        .map(|ws| {
            let execution_result = ws
                .result_json
                .as_deref()
                .and_then(|json| serde_json::from_str::<ExecutionResult>(json).ok());
            WoResult {
                wo_id: ws.wo_id,
                status: ws.status,
                attempts: ws.attempt,
                execution_result,
                error: ws.error_context,
            }
        })
        .collect();

    info!(
        group_id = %group_id,
        status = ?group_state.status,
        completed = group_state.completed_wos,
        failed = group_state.failed_wos,
        elapsed_secs = elapsed,
        "Group dispatch complete"
    );

    Ok(GroupResult {
        group_id,
        status: group_state.status,
        wo_results,
        total_duration_seconds: elapsed,
    })
}

/// Try to escalate a WO to the next tier in its escalation chain.
///
/// Returns `true` if escalation succeeded and the WO was re-spawned,
/// `false` if escalation is disabled or all tiers are exhausted.
#[allow(clippy::too_many_arguments)]
async fn try_escalate<E: Executor + Clone>(
    wo_id: &str,
    group_id: &str,
    wo_map: &HashMap<String, WorkOrder>,
    config: &Config,
    working_dir: &Path,
    executor: &E,
    semaphore: &Arc<Semaphore>,
    tx: &mpsc::Sender<DispatchEvent>,
    state_store: &StateStore,
    running: &mut HashSet<String>,
    run_started_at: &mut HashMap<String, Instant>,
    model_overrides: &mut HashMap<String, String>,
    current_tier: u32,
    event_reporter: &EventReporter,
) -> Result<bool> {
    let wo = &wo_map[wo_id];
    if !wo.escalation.enabled {
        return Ok(false);
    }

    let chain = wo.escalation.effective_chain();
    // escalation_tier 0 = base model (pre-chain), so chain index = escalation_tier - 1.
    // First escalation: current_tier=0 -> chain_index=0, escalation_tier becomes 1.
    let chain_index = current_tier as usize; // current_tier 0 -> chain[0], etc.

    if chain_index >= chain.len() {
        return Ok(false);
    }

    // Find the next tier that is not an Anthropic API model (opus/claude).
    // Those always 401 — skip them rather than wasting retries.
    let mut actual_chain_index = chain_index;
    loop {
        if actual_chain_index >= chain.len() {
            return Ok(false);
        }
        let m = &chain[actual_chain_index].model;
        if m.starts_with("opus") || m.starts_with("claude") {
            warn!(
                wo_id = %wo_id,
                model = %m,
                "Skipping escalation tier: Anthropic API model not available"
            );
            actual_chain_index += 1;
        } else {
            break;
        }
    }

    let tier = &chain[actual_chain_index];
    let new_escalation_tier = (actual_chain_index + 1) as u32;
    info!(
        wo_id = %wo_id,
        from_tier = current_tier,
        to_tier = new_escalation_tier,
        to_model = %tier.model,
        "Escalating to next tier"
    );
    state_store.set_escalation_tier(wo_id, new_escalation_tier)?;
    state_store.reset_attempts(wo_id, tier.max_retries)?;
    model_overrides.insert(wo_id.to_string(), tier.model.clone());
    event_reporter
        .report(SwarmEvent::WoEscalated {
            group_id: group_id.to_string(),
            timestamp: EventReporter::now_iso(),
            wo_id: wo_id.to_string(),
            from_tier: current_tier,
            to_tier: new_escalation_tier,
            to_model: tier.model.clone(),
            error_history: state_store
                .get_error_history(wo_id)?
                .into_iter()
                .map(|e| ErrorHistoryEntrySummary {
                    tier: e.tier,
                    model: e.model,
                    attempt: e.attempt,
                    error: e.error,
                    gate_detail: e.gate_detail,
                })
                .collect(),
        })
        .await;
    state_store.mark_ready(wo_id)?;
    spawn_executor(
        wo_id,
        group_id,
        wo_map,
        config,
        working_dir,
        executor,
        semaphore,
        tx,
        state_store,
        running,
        run_started_at,
        model_overrides,
        event_reporter,
    )
    .await?;
    Ok(true)
}

/// Check if the group should abort due to too many permanent failures.
fn check_abort(group_id: &str, state_store: &StateStore, aborted: &mut bool) -> Result<()> {
    if state_store.should_abort(group_id)? {
        warn!(group_id = %group_id, "Group abort threshold reached");
        *aborted = true;
    }
    Ok(())
}

/// Spawn a single executor task, gated by the semaphore.
#[allow(clippy::too_many_arguments)]
async fn spawn_executor<E: Executor + Clone>(
    wo_id: &str,
    group_id: &str,
    wo_map: &HashMap<String, WorkOrder>,
    config: &Config,
    working_dir: &Path,
    executor: &E,
    semaphore: &Arc<Semaphore>,
    tx: &mpsc::Sender<DispatchEvent>,
    state_store: &StateStore,
    running: &mut HashSet<String>,
    run_started_at: &mut HashMap<String, Instant>,
    model_overrides: &HashMap<String, String>,
    event_reporter: &EventReporter,
) -> Result<()> {
    let mut wo = wo_map[wo_id].clone();

    // Apply model override if this WO has been escalated.
    if let Some(override_model) = model_overrides.get(wo_id) {
        wo.execution.model = override_model.clone();
    }

    let config = config.clone();
    let working_dir = working_dir.to_path_buf();
    let executor = executor.clone();
    let semaphore = Arc::clone(semaphore);
    let tx = tx.clone();
    let wo_id_owned = wo_id.to_string();
    let group_id_owned = group_id.to_string();
    let effective_model = effective_model(&config, &wo);
    let current_tier = state_store.get_escalation_tier(wo_id).unwrap_or(0);
    let current_attempt = state_store
        .get_wo_state(wo_id)
        .map(|s| s.attempt)
        .unwrap_or(0);
    let reporter = event_reporter.clone();

    state_store.mark_running(wo_id)?;
    running.insert(wo_id.to_string());
    run_started_at.insert(wo_id.to_string(), Instant::now());

    info!(wo_id = %wo_id, model = %wo.execution.model, "Spawning executor task");

    reporter
        .report(SwarmEvent::WoStatusChanged {
            group_id: group_id_owned.clone(),
            timestamp: EventReporter::now_iso(),
            wo_id: wo_id_owned.clone(),
            old_status: "ready".to_string(),
            new_status: "running".to_string(),
            model: effective_model,
            attempt: current_attempt,
            tier: current_tier,
        })
        .await;

    tokio::spawn(async move {
        // Acquire concurrency slot.
        let _permit = semaphore.acquire().await;

        let event = match executor.execute(&config, &wo, &working_dir).await {
            Ok(result) if result.success => DispatchEvent::Completed {
                wo_id: wo_id_owned,
                result,
            },
            Ok(result) => DispatchEvent::Failed {
                wo_id: wo_id_owned,
                result,
            },
            Err(e) => DispatchEvent::ExecutorError {
                wo_id: wo_id_owned,
                error: format!("Executor error: {e}"),
            },
        };

        let _ = tx.send(event).await;
    });

    Ok(())
}

fn effective_model(config: &Config, work_order: &WorkOrder) -> String {
    if work_order.execution.model.is_empty() {
        config.default_model.clone()
    } else {
        work_order.execution.model.clone()
    }
}

fn summarize_gate_results(result: &ExecutionResult) -> Option<GateResultSummary> {
    result.gate_results.as_ref().map(|gr| GateResultSummary {
        all_passed: gr.all_passed,
        gates: gr
            .gates
            .iter()
            .map(|g| GateEntry {
                name: g.name.clone(),
                passed: g.passed,
                output: Some(g.output.clone()),
            })
            .collect(),
    })
}

// -- Tests -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executor::TokenUsage;
    use std::path::PathBuf;
    use std::time::Duration;

    /// Mock executor with configurable per-WO behavior.
    #[derive(Clone)]
    struct MockExecutor {
        /// WO ID -> (delay_ms, success).
        behaviors: Arc<HashMap<String, (u64, bool)>>,
    }

    impl MockExecutor {
        fn new(behaviors: Vec<(&str, u64, bool)>) -> Self {
            let map: HashMap<String, (u64, bool)> = behaviors
                .into_iter()
                .map(|(id, delay, success)| (id.to_string(), (delay, success)))
                .collect();
            Self {
                behaviors: Arc::new(map),
            }
        }
    }

    #[async_trait]
    impl Executor for MockExecutor {
        async fn execute(
            &self,
            _config: &Config,
            work_order: &WorkOrder,
            _working_dir: &Path,
        ) -> Result<ExecutionResult> {
            let (delay, success) = self
                .behaviors
                .get(&work_order.id)
                .copied()
                .unwrap_or((10, true));
            tokio::time::sleep(Duration::from_millis(delay)).await;
            Ok(ExecutionResult {
                work_order_id: work_order.id.clone(),
                success,
                error: if success {
                    None
                } else {
                    Some("mock failure".into())
                },
                diffs: vec![],
                tool_calls: vec![],
                token_usage: TokenUsage {
                    input_tokens: 100,
                    output_tokens: 50,
                },
                iterations: 1,
                retries_used: 0,
                gate_results: None,
                contract_violation: None,
                unified_diff: None,
            })
        }
    }

    /// Mock executor that succeeds or fails based on the WO's model field.
    #[derive(Clone)]
    struct ModelAwareMockExecutor {
        /// model -> success
        model_behaviors: Arc<HashMap<String, bool>>,
    }

    impl ModelAwareMockExecutor {
        fn new(behaviors: Vec<(&str, bool)>) -> Self {
            let map: HashMap<String, bool> = behaviors
                .into_iter()
                .map(|(m, s)| (m.to_string(), s))
                .collect();
            Self {
                model_behaviors: Arc::new(map),
            }
        }
    }

    #[async_trait]
    impl Executor for ModelAwareMockExecutor {
        async fn execute(
            &self,
            config: &Config,
            work_order: &WorkOrder,
            _working_dir: &Path,
        ) -> Result<ExecutionResult> {
            let model = if work_order.execution.model.is_empty() {
                &config.default_model
            } else {
                &work_order.execution.model
            };

            let success = self.model_behaviors.get(model).copied().unwrap_or(false);

            tokio::time::sleep(Duration::from_millis(10)).await;
            Ok(ExecutionResult {
                work_order_id: work_order.id.clone(),
                success,
                error: if success {
                    None
                } else {
                    Some(format!("Failed with model {}", model))
                },
                diffs: vec![],
                tool_calls: vec![],
                token_usage: TokenUsage {
                    input_tokens: 100,
                    output_tokens: 50,
                },
                iterations: 1,
                retries_used: 0,
                gate_results: None,
                contract_violation: None,
                unified_diff: None,
            })
        }
    }

    /// Mock executor that returns a contract violation for non-CC models,
    /// and succeeds for opus-cc.
    #[derive(Clone)]
    struct ContractViolationMockExecutor;

    #[async_trait]
    impl Executor for ContractViolationMockExecutor {
        async fn execute(
            &self,
            _config: &Config,
            work_order: &WorkOrder,
            _working_dir: &Path,
        ) -> Result<ExecutionResult> {
            let model = &work_order.execution.model;
            tokio::time::sleep(Duration::from_millis(10)).await;

            if model == "opus-cc" {
                Ok(ExecutionResult {
                    work_order_id: work_order.id.clone(),
                    success: true,
                    error: None,
                    diffs: vec![],
                    tool_calls: vec![],
                    token_usage: TokenUsage::default(),
                    iterations: 1,
                    retries_used: 0,
                    gate_results: None,
                    contract_violation: None,
                    unified_diff: None,
                })
            } else {
                Ok(ExecutionResult {
                    work_order_id: work_order.id.clone(),
                    success: false,
                    error: Some("Interface missing method X".to_string()),
                    diffs: vec![],
                    tool_calls: vec![],
                    token_usage: TokenUsage::default(),
                    iterations: 1,
                    retries_used: 0,
                    gate_results: None,
                    contract_violation: Some("Interface X is missing method doFoo()".to_string()),
                    unified_diff: None,
                })
            }
        }
    }

    fn make_wo(id: &str, group: &str, deps: Vec<&str>) -> WorkOrder {
        let yaml = format!(
            r#"
id: "{id}"
group_id: "{group}"
title: "Test WO {id}"
description: "Test"
task: implement
depends_on: [{deps}]
execution:
  max_retries: 2
"#,
            id = id,
            group = group,
            deps = deps
                .iter()
                .map(|d| format!("\"{d}\""))
                .collect::<Vec<_>>()
                .join(", ")
        );
        serde_yaml::from_str(&yaml).unwrap()
    }

    fn test_config() -> Config {
        Config::default()
    }

    fn test_dispatcher_config() -> DispatcherConfig {
        DispatcherConfig {
            max_concurrency: 4,
            db_path: PathBuf::from(":memory:"),
            max_group_failures: 3,
        }
    }

    #[tokio::test]
    async fn test_single_wo_success() {
        let wos = vec![make_wo("WO-1", "grp", vec![])];
        let executor = MockExecutor::new(vec![("WO-1", 10, true)]);

        let graph_input: Vec<(String, Vec<String>)> = wos
            .iter()
            .map(|wo| (wo.id.clone(), wo.depends_on.clone()))
            .collect();
        let graph = DependencyGraph::build(&graph_input).unwrap();
        let state = StateStore::open_memory().unwrap();
        let config = test_config();

        let result = run_dispatch_loop(
            &config,
            &test_dispatcher_config(),
            &wos,
            &graph,
            &state,
            Path::new("/tmp"),
            executor,
            EventReporter::disabled(),
        )
        .await
        .unwrap();

        assert_eq!(result.status, super::super::state::GroupStatus::Completed);
        assert_eq!(result.wo_results.len(), 1);
        assert_eq!(
            result.wo_results[0].status,
            super::super::state::WoStatus::Completed
        );
    }

    #[tokio::test]
    async fn test_parallel_independent_wos() {
        let wos = vec![
            make_wo("WO-1", "grp", vec![]),
            make_wo("WO-2", "grp", vec![]),
            make_wo("WO-3", "grp", vec![]),
        ];
        let executor = MockExecutor::new(vec![
            ("WO-1", 50, true),
            ("WO-2", 50, true),
            ("WO-3", 50, true),
        ]);

        let graph_input: Vec<(String, Vec<String>)> = wos
            .iter()
            .map(|wo| (wo.id.clone(), wo.depends_on.clone()))
            .collect();
        let graph = DependencyGraph::build(&graph_input).unwrap();
        let state = StateStore::open_memory().unwrap();
        let config = test_config();

        let start = Instant::now();
        let result = run_dispatch_loop(
            &config,
            &test_dispatcher_config(),
            &wos,
            &graph,
            &state,
            Path::new("/tmp"),
            executor,
            EventReporter::disabled(),
        )
        .await
        .unwrap();
        let elapsed = start.elapsed();

        assert_eq!(result.status, super::super::state::GroupStatus::Completed);
        assert_eq!(result.wo_results.len(), 3);
        // Should run in parallel, so ~50ms not ~150ms.
        assert!(
            elapsed < Duration::from_millis(200),
            "Expected parallel execution, took {:?}",
            elapsed
        );
    }

    #[tokio::test]
    async fn test_dependency_ordering() {
        // B depends on A.
        let wos = vec![
            make_wo("WO-A", "grp", vec![]),
            make_wo("WO-B", "grp", vec!["WO-A"]),
        ];
        let executor = MockExecutor::new(vec![("WO-A", 20, true), ("WO-B", 20, true)]);

        let graph_input: Vec<(String, Vec<String>)> = wos
            .iter()
            .map(|wo| (wo.id.clone(), wo.depends_on.clone()))
            .collect();
        let graph = DependencyGraph::build(&graph_input).unwrap();
        let state = StateStore::open_memory().unwrap();
        let config = test_config();

        let result = run_dispatch_loop(
            &config,
            &test_dispatcher_config(),
            &wos,
            &graph,
            &state,
            Path::new("/tmp"),
            executor,
            EventReporter::disabled(),
        )
        .await
        .unwrap();

        assert_eq!(result.status, super::super::state::GroupStatus::Completed);
        // Both should be completed.
        for wr in &result.wo_results {
            assert_eq!(wr.status, super::super::state::WoStatus::Completed);
        }
    }

    #[tokio::test]
    async fn test_retry_then_permanent_fail() {
        // WO always fails, has max_retries=2.
        let wos = vec![make_wo("WO-1", "grp", vec![])];
        let executor = MockExecutor::new(vec![("WO-1", 10, false)]);

        let graph_input: Vec<(String, Vec<String>)> = wos
            .iter()
            .map(|wo| (wo.id.clone(), wo.depends_on.clone()))
            .collect();
        let graph = DependencyGraph::build(&graph_input).unwrap();
        let state = StateStore::open_memory().unwrap();
        let config = test_config();

        let result = run_dispatch_loop(
            &config,
            &test_dispatcher_config(),
            &wos,
            &graph,
            &state,
            Path::new("/tmp"),
            executor,
            EventReporter::disabled(),
        )
        .await
        .unwrap();

        // With escalation enabled (default), tier 0 exhausts retries (2),
        // then escalates to tier 1 (legacy "opus" tier with 2 retries),
        // which also fails. Final status is Failed.
        assert_eq!(result.status, super::super::state::GroupStatus::Failed);
        assert_eq!(
            result.wo_results[0].status,
            super::super::state::WoStatus::Failed
        );
    }

    #[tokio::test]
    async fn test_group_abort() {
        // 4 WOs all fail, max_failures=2.
        let wos = vec![
            make_wo("WO-1", "grp", vec![]),
            make_wo("WO-2", "grp", vec![]),
            make_wo("WO-3", "grp", vec!["WO-1"]),
            make_wo("WO-4", "grp", vec!["WO-2"]),
        ];
        // Override max_retries to 0 and disable escalation so they fail permanently on first try.
        let mut wos = wos;
        for wo in &mut wos {
            wo.execution.max_retries = 0;
            wo.escalation.enabled = false;
        }

        let executor = MockExecutor::new(vec![
            ("WO-1", 10, false),
            ("WO-2", 10, false),
            ("WO-3", 10, true),
            ("WO-4", 10, true),
        ]);

        let graph_input: Vec<(String, Vec<String>)> = wos
            .iter()
            .map(|wo| (wo.id.clone(), wo.depends_on.clone()))
            .collect();
        let graph = DependencyGraph::build(&graph_input).unwrap();
        let state = StateStore::open_memory().unwrap();
        let config = test_config();

        let mut dc = test_dispatcher_config();
        dc.max_group_failures = 2;

        let result = run_dispatch_loop(
            &config,
            &dc,
            &wos,
            &graph,
            &state,
            Path::new("/tmp"),
            executor,
            EventReporter::disabled(),
        )
        .await
        .unwrap();

        assert_eq!(result.status, super::super::state::GroupStatus::Aborted);
        // WO-3 and WO-4 should never have run (their deps failed + abort triggered).
    }

    #[tokio::test]
    async fn test_escalation_tier_progression() {
        // WO starts with model "glm-5" (fails), escalation chain has codex (succeeds).
        let yaml = r#"
id: "WO-1"
group_id: "grp"
title: "Test"
description: "Test"
task: implement
execution:
  model: "glm-5"
  max_retries: 0
escalation:
  enabled: true
  chain:
    - model: codex
      max_retries: 0
"#;
        let wos = vec![serde_yaml::from_str::<WorkOrder>(yaml).unwrap()];
        let executor = ModelAwareMockExecutor::new(vec![("glm-5", false), ("codex", true)]);

        let graph_input: Vec<(String, Vec<String>)> = wos
            .iter()
            .map(|wo| (wo.id.clone(), wo.depends_on.clone()))
            .collect();
        let graph = DependencyGraph::build(&graph_input).unwrap();
        let state = StateStore::open_memory().unwrap();

        let result = run_dispatch_loop(
            &test_config(),
            &test_dispatcher_config(),
            &wos,
            &graph,
            &state,
            Path::new("/tmp"),
            executor,
            EventReporter::disabled(),
        )
        .await
        .unwrap();

        assert_eq!(result.status, super::super::state::GroupStatus::Completed);
        assert_eq!(
            result.wo_results[0].status,
            super::super::state::WoStatus::Completed
        );

        // Verify escalation tier was recorded.
        let wo_state = state.get_wo_state("WO-1").unwrap();
        assert_eq!(wo_state.escalation_tier, 1);
    }

    #[tokio::test]
    async fn test_escalation_all_tiers_exhausted() {
        // WO fails on all tiers: glm-5 -> codex -> all exhausted.
        let yaml = r#"
id: "WO-1"
group_id: "grp"
title: "Test"
description: "Test"
task: implement
execution:
  model: "glm-5"
  max_retries: 0
escalation:
  enabled: true
  chain:
    - model: codex
      max_retries: 0
"#;
        let wos = vec![serde_yaml::from_str::<WorkOrder>(yaml).unwrap()];
        let executor = ModelAwareMockExecutor::new(vec![("glm-5", false), ("codex", false)]);

        let graph_input: Vec<(String, Vec<String>)> = wos
            .iter()
            .map(|wo| (wo.id.clone(), wo.depends_on.clone()))
            .collect();
        let graph = DependencyGraph::build(&graph_input).unwrap();
        let state = StateStore::open_memory().unwrap();

        let result = run_dispatch_loop(
            &test_config(),
            &test_dispatcher_config(),
            &wos,
            &graph,
            &state,
            Path::new("/tmp"),
            executor,
            EventReporter::disabled(),
        )
        .await
        .unwrap();

        assert_eq!(result.status, super::super::state::GroupStatus::Failed);
        assert_eq!(
            result.wo_results[0].status,
            super::super::state::WoStatus::Failed
        );

        // Verify error history was recorded for both tiers.
        let history = state.get_error_history("WO-1").unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0].model, "glm-5");
        assert_eq!(history[1].model, "codex");
    }

    #[tokio::test]
    async fn test_contract_violation_cc_tier_skipped_when_opus() {
        // Anthropic API (opus-cc) is unavailable. A contract violation should NOT
        // escalate to opus-cc — it should be skipped and the WO should fail permanently.
        let yaml = r#"
id: "WO-1"
group_id: "grp"
title: "Test"
description: "Test"
task: implement
execution:
  model: "glm-5"
  max_retries: 0
escalation:
  enabled: true
  chain:
    - model: codex
      max_retries: 0
    - model: opus-cc
      max_retries: 0
"#;
        let wos = vec![serde_yaml::from_str::<WorkOrder>(yaml).unwrap()];
        let executor = ContractViolationMockExecutor;

        let graph_input: Vec<(String, Vec<String>)> = wos
            .iter()
            .map(|wo| (wo.id.clone(), wo.depends_on.clone()))
            .collect();
        let graph = DependencyGraph::build(&graph_input).unwrap();
        let state = StateStore::open_memory().unwrap();

        let result = run_dispatch_loop(
            &test_config(),
            &test_dispatcher_config(),
            &wos,
            &graph,
            &state,
            Path::new("/tmp"),
            executor,
            EventReporter::disabled(),
        )
        .await
        .unwrap();

        // opus-cc is skipped, so the contract violation falls through to permanent failure.
        assert_eq!(result.status, super::super::state::GroupStatus::Failed);
        assert_eq!(
            result.wo_results[0].status,
            super::super::state::WoStatus::Failed
        );

        // Error history should show glm-5 and codex failures (no opus-cc attempt).
        let history = state.get_error_history("WO-1").unwrap();
        assert!(history.iter().all(|e| e.model != "opus-cc"), "opus-cc must never be attempted");
        assert_eq!(history[0].model, "glm-5");
    }

    #[tokio::test]
    async fn test_escalation_disabled() {
        // WO with escalation disabled should fail permanently after retries.
        let yaml = r#"
id: "WO-1"
group_id: "grp"
title: "Test"
description: "Test"
task: implement
execution:
  model: "glm-5"
  max_retries: 0
escalation:
  enabled: false
"#;
        let wos = vec![serde_yaml::from_str::<WorkOrder>(yaml).unwrap()];
        let executor = ModelAwareMockExecutor::new(vec![("glm-5", false)]);

        let graph_input: Vec<(String, Vec<String>)> = wos
            .iter()
            .map(|wo| (wo.id.clone(), wo.depends_on.clone()))
            .collect();
        let graph = DependencyGraph::build(&graph_input).unwrap();
        let state = StateStore::open_memory().unwrap();

        let result = run_dispatch_loop(
            &test_config(),
            &test_dispatcher_config(),
            &wos,
            &graph,
            &state,
            Path::new("/tmp"),
            executor,
            EventReporter::disabled(),
        )
        .await
        .unwrap();

        assert_eq!(result.status, super::super::state::GroupStatus::Failed);
        assert_eq!(
            result.wo_results[0].status,
            super::super::state::WoStatus::Failed
        );

        // No escalation should have happened.
        let wo_state = state.get_wo_state("WO-1").unwrap();
        assert_eq!(wo_state.escalation_tier, 0);
    }
}
