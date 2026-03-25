//! Claude Code escalation executor — spawns an Opus CC session via the agentboard task API.
//!
//! Used as the last resort in the escalation chain when GLM and Codex both fail.
//! Sends the original WO description + full error history to Opus Claude Code
//! running with full project permissions.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context as _, Result};
use async_trait::async_trait;
use serde::Deserialize;
use tokio::time::sleep;
use tracing::{debug, info, warn};

use crate::config::Config;
use crate::context::{self, format_context, AssembledContext};
use crate::diff::{DiffAction, StructuredDiff};
use crate::dispatcher::scheduler::Executor;
use crate::executor::{auto_commit_files, ExecutionResult, TokenUsage, ToolCallLog};
use crate::gates;
use crate::mcp_client::McpClient;
use crate::wo::WorkOrder;

// ── Struct ────────────────────────────────────────────────────────────────────

/// Executor that escalates to Opus Claude Code via the agentboard task API.
#[derive(Clone)]
pub struct CcExecutor {
    /// Agentboard API base URL (e.g. "http://localhost:4040").
    agentboard_url: String,
    /// HTTP client for API calls.
    http_client: reqwest::Client,
    /// Polling interval for task status.
    poll_interval: Duration,
}

impl CcExecutor {
    pub fn new(agentboard_url: String) -> Self {
        Self {
            agentboard_url,
            http_client: reqwest::Client::new(),
            poll_interval: Duration::from_secs(10),
        }
    }
}

// ── API response types ────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct TaskCreateResponse {
    id: String,
    #[allow(dead_code)]
    status: String,
}

#[derive(Debug, Deserialize)]
struct TaskStatusResponse {
    #[allow(dead_code)]
    id: String,
    status: String,
    #[serde(rename = "errorMessage")]
    error_message: Option<String>,
}

// ── Executor impl ─────────────────────────────────────────────────────────────

#[async_trait]
impl Executor for CcExecutor {
    async fn execute(
        &self,
        config: &Config,
        work_order: &WorkOrder,
        working_dir: &Path,
    ) -> Result<ExecutionResult> {
        info!(wo_id = %work_order.id, "Starting CC escalation execution");

        // Phase 1: Context assembly — try MCP, fall back to empty on failure.
        let assembled_context = match McpClient::new(config).await {
            Ok(mcp) => {
                let mcp = Arc::new(mcp);
                match context::assemble_context(&mcp, work_order, working_dir).await {
                    Ok(ctx) => ctx,
                    Err(e) => {
                        warn!(wo_id = %work_order.id, error = %e, "Context assembly failed, using WO fields only");
                        AssembledContext {
                            agent_brief: None,
                            file_contents: vec![],
                            dependencies: None,
                        }
                    }
                }
            }
            Err(e) => {
                warn!(wo_id = %work_order.id, error = %e, "MCP client init failed, using WO fields only");
                AssembledContext {
                    agent_brief: None,
                    file_contents: vec![],
                    dependencies: None,
                }
            }
        };

        // Build escalation prompt.
        let prompt =
            build_escalation_prompt(work_order, &assembled_context, &config.gate_commands, None);

        let timeout_minutes = if work_order.execution.timeout_minutes > 0 {
            work_order.execution.timeout_minutes as u64
        } else {
            45 // CC gets a longer timeout than lower tiers
        };
        let timeout_duration = Duration::from_secs(timeout_minutes * 60);

        // Phase 2: Create task via agentboard API.
        let project_path = working_dir.to_string_lossy().to_string();
        let create_body = serde_json::json!({
            "projectPath": project_path,
            "prompt": prompt,
            "timeoutSeconds": timeout_minutes * 60,
            "metadata": {
                "source": "minion-escalation",
                "wo_id": work_order.id,
            }
        });

        info!(wo_id = %work_order.id, url = %self.agentboard_url, "Creating CC task");

        let resp = self
            .http_client
            .post(format!("{}/api/tasks", self.agentboard_url))
            .json(&create_body)
            .send()
            .await
            .context("Failed to create agentboard task")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            bail!("Agentboard task creation failed ({}): {}", status, body);
        }

        let task: TaskCreateResponse = resp
            .json()
            .await
            .context("Failed to parse task creation response")?;

        info!(
            wo_id = %work_order.id,
            task_id = %task.id,
            "CC task created, polling for completion"
        );

        // Phase 3: Poll for completion.
        let start = std::time::Instant::now();
        let task_status = loop {
            if start.elapsed() > timeout_duration {
                // Best-effort cancel before bailing.
                let _ = self
                    .http_client
                    .post(format!(
                        "{}/api/tasks/{}/cancel",
                        self.agentboard_url, task.id
                    ))
                    .send()
                    .await;
                bail!("CC task timed out after {}m", timeout_minutes);
            }

            sleep(self.poll_interval).await;

            let resp = self
                .http_client
                .get(format!("{}/api/tasks/{}", self.agentboard_url, task.id))
                .send()
                .await
                .context("Failed to poll task status")?;

            let status: TaskStatusResponse = resp
                .json()
                .await
                .context("Failed to parse task status response")?;

            debug!(
                wo_id = %work_order.id,
                task_id = %task.id,
                status = %status.status,
                "Polling CC task"
            );

            match status.status.as_str() {
                "completed" => break status,
                "failed" | "cancelled" => {
                    let err = status
                        .error_message
                        .unwrap_or_else(|| "CC task failed".to_string());
                    return Ok(ExecutionResult {
                        work_order_id: work_order.id.clone(),
                        success: false,
                        error: Some(format!("CC escalation failed: {}", err)),
                        diffs: vec![],
                        tool_calls: vec![],
                        token_usage: TokenUsage::default(),
                        iterations: 1,
                        retries_used: 0,
                        gate_results: None,
                        contract_violation: None,
                    });
                }
                _ => continue, // queued, running — keep polling
            }
        };

        info!(
            wo_id = %work_order.id,
            task_id = %task.id,
            "CC task completed, capturing changes"
        );

        // Phase 4: Capture what CC changed.
        let changed_files = capture_changed_files(working_dir)?;

        if changed_files.is_empty() {
            return Ok(ExecutionResult {
                work_order_id: work_order.id.clone(),
                success: false,
                error: Some("CC task completed but no file changes detected".to_string()),
                diffs: vec![],
                tool_calls: vec![],
                token_usage: TokenUsage::default(),
                iterations: 1,
                retries_used: 0,
                gate_results: None,
                contract_violation: None,
            });
        }

        info!(wo_id = %work_order.id, files = ?changed_files, "CC modified files");
        let diffs = synthesize_diffs(&changed_files, working_dir);

        // Phase 5: Run gates on the modified tree.
        let gate_results = gates::run_gates_in_place(
            work_order,
            working_dir,
            &config.gate_commands,
            config.command_timeout_seconds,
        )
        .await?;

        // Phase 6: Auto-commit if gates passed and WO requests it.
        if gate_results.all_passed && work_order.output.commit {
            auto_commit_files(work_order, &changed_files, working_dir)?;
        }

        let success = gate_results.all_passed;
        let error = if success {
            None
        } else {
            gate_results
                .error_context
                .clone()
                .map(|e| format!("CC gates failed: {}", e))
        };

        // Suppress unused-variable warning — task_status is consumed for its
        // error_message field in the failed/cancelled arm above; we break out of
        // the loop only on "completed", so no further fields are needed here.
        let _ = task_status;

        Ok(ExecutionResult {
            work_order_id: work_order.id.clone(),
            success,
            error,
            diffs,
            tool_calls: vec![ToolCallLog {
                tool: "agentboard_task".to_string(),
                input_summary: format!("task_id={}", task.id),
                success,
            }],
            token_usage: TokenUsage::default(),
            iterations: 1,
            retries_used: 0,
            gate_results: Some(gate_results),
            contract_violation: None,
        })
    }
}

// ── Helper functions ──────────────────────────────────────────────────────────

/// Build the escalation prompt for Opus CC.
pub fn build_escalation_prompt(
    work_order: &WorkOrder,
    assembled_context: &AssembledContext,
    gate_commands: &crate::config::GateCommands,
    escalation_context: Option<&str>,
) -> String {
    let mut prompt = String::new();

    prompt.push_str("# Escalation: Previous Agents Failed\n\n");
    prompt.push_str("You are being called because automated agents (GLM and/or Codex) failed to complete this task. ");
    prompt.push_str("You have full Claude Code permissions. Diagnose the issue and fix it.\n\n");

    prompt.push_str(&format!("## Task\n{}\n\n", work_order.title));
    prompt.push_str(&format!("## Description\n{}\n\n", work_order.description));

    // Assembled context from MCP.
    let ctx = format_context(assembled_context);
    if !ctx.is_empty() {
        prompt.push_str(&format!("## Context\n{}\n\n", ctx));
    }

    // Scope restriction.
    if let Some(ref scope) = work_order.scope {
        prompt.push_str(&format!(
            "## Scope\nOnly modify files within `{}`.\n\n",
            scope
        ));
    }

    // Gate info so CC knows what will be checked.
    prompt.push_str("## Quality Gates\n");
    prompt.push_str("After your changes, these gates must pass:\n");
    if work_order.gates.typecheck {
        prompt.push_str(&format!("- Typecheck: `{}`\n", gate_commands.typecheck));
    }
    if work_order.gates.lint {
        prompt.push_str(&format!("- Lint: `{}`\n", gate_commands.lint));
    }
    if work_order.gates.tests.run {
        prompt.push_str(&format!("- Tests: `{}`\n", gate_commands.test));
    }
    prompt.push('\n');

    // Error history from previous tiers.
    if let Some(history) = escalation_context {
        prompt.push_str("## Error History From Previous Agents\n\n");
        prompt.push_str(history);
        prompt.push_str("\n\n");
        prompt.push_str("Use this error history to understand what was tried and why it failed. ");
        prompt.push_str(
            "The issue may be in the code, the interface definitions, or the task description itself.\n\n",
        );
    }

    prompt
}

/// Capture the list of files changed in the working tree relative to HEAD.
fn capture_changed_files(working_dir: &Path) -> Result<Vec<String>> {
    use std::process::Command;

    let diff_output = Command::new("git")
        .args(["diff", "--name-only", "HEAD"])
        .current_dir(working_dir)
        .output()
        .context("Failed to run git diff --name-only")?;

    let mut files: Vec<String> = String::from_utf8_lossy(&diff_output.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();

    // Also capture untracked files that CC may have created.
    let status_output = Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(working_dir)
        .output()
        .context("Failed to run git ls-files")?;

    let untracked: Vec<String> = String::from_utf8_lossy(&status_output.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();

    files.extend(untracked);
    files.sort();
    files.dedup();
    Ok(files)
}

/// Synthesize StructuredDiff entries for reporting purposes.
///
/// We use `DiffAction::Create` as a conservative sentinel — the downstream
/// consumer treats it as "file was written by CC"; exact patch semantics are
/// not needed for the escalation path.
fn synthesize_diffs(changed_files: &[String], working_dir: &Path) -> Vec<StructuredDiff> {
    changed_files
        .iter()
        .filter_map(|file| {
            let full_path = working_dir.join(file);
            let content = std::fs::read_to_string(&full_path).ok()?;
            Some(StructuredDiff {
                file: file.clone(),
                action: DiffAction::Create,
                anchor: None,
                content: Some(content),
            })
        })
        .collect()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_wo() -> WorkOrder {
        serde_yaml::from_str(
            r#"
id: WO-ESC-001
group_id: test-group
title: "Fix broken handler"
description: "The handler at src/server/handler.ts has a type error."
task: fix
scope: src/server/
gates:
  compile: false
  lint: false
  typecheck: true
  tests:
    run: false
    scope: relevant
    specific: []
    expect: pass
execution:
  mode: attended
  model: opus-cc
  max_retries: 0
  timeout_minutes: 30
output:
  commit: true
  commit_prefix: "fix"
"#,
        )
        .unwrap()
    }

    fn empty_context() -> AssembledContext {
        AssembledContext {
            agent_brief: None,
            file_contents: vec![],
            dependencies: None,
        }
    }

    fn default_gates() -> crate::config::GateCommands {
        crate::config::GateCommands::default()
    }

    #[test]
    fn test_build_escalation_prompt_basic() {
        let wo = make_test_wo();
        let prompt = build_escalation_prompt(&wo, &empty_context(), &default_gates(), None);
        assert!(prompt.contains("Escalation: Previous Agents Failed"));
        assert!(prompt.contains("Fix broken handler"));
        assert!(prompt.contains("type error"));
        assert!(prompt.contains("Typecheck"));
    }

    #[test]
    fn test_build_escalation_prompt_with_error_history() {
        let wo = make_test_wo();
        let history = "## Tier 0 (glm-5) — Attempt 1\nTypecheck failed: TS2345\n\n## Tier 1 (codex) — Attempt 1\nLint failed: no-unused-vars";
        let prompt =
            build_escalation_prompt(&wo, &empty_context(), &default_gates(), Some(history));
        assert!(prompt.contains("Error History From Previous Agents"));
        assert!(prompt.contains("TS2345"));
        assert!(prompt.contains("no-unused-vars"));
    }

    #[test]
    fn test_build_escalation_prompt_with_context() {
        let wo = make_test_wo();
        let ctx = AssembledContext {
            agent_brief: Some("The handler module exports...".to_string()),
            file_contents: vec![],
            dependencies: None,
        };
        let prompt = build_escalation_prompt(&wo, &ctx, &default_gates(), None);
        assert!(prompt.contains("handler module exports"));
    }

    #[test]
    fn test_build_escalation_prompt_no_gates_when_disabled() {
        let wo = make_test_wo();
        let prompt = build_escalation_prompt(&wo, &empty_context(), &default_gates(), None);
        // lint and tests are disabled in make_test_wo, only typecheck is on
        assert!(!prompt.contains("- Lint:"));
        assert!(!prompt.contains("- Tests:"));
        assert!(prompt.contains("- Typecheck:"));
    }

    #[test]
    fn test_cc_executor_new() {
        let ce = CcExecutor::new("http://localhost:4040".to_string());
        assert_eq!(ce.agentboard_url, "http://localhost:4040");
        assert_eq!(ce.poll_interval, Duration::from_secs(10));
    }
}
