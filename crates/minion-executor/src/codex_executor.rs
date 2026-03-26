//! Codex CLI executor — spawns `codex exec` in headless mode.
//!
//! Unlike the API executor which produces StructuredDiffs via tool calls,
//! Codex edits files directly in the working tree. Changes are captured
//! via `git diff` after the process exits.

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{Context as _, Result};
use async_trait::async_trait;
use tokio::io::AsyncWriteExt;
use tokio::sync::Semaphore;
use tokio::time::{timeout, Duration};
use tracing::{debug, info, warn};

use crate::config::Config;
use crate::context::{self, format_context, AssembledContext};
use crate::diff::{DiffAction, StructuredDiff};
use crate::dispatcher::scheduler::Executor;
use crate::executor::{auto_commit_files, ExecutionResult, TokenUsage, ToolCallLog};
use crate::gates::{self, GateResults};
use crate::mcp_client::McpClient;
use crate::wo::{VerificationSymbol, WorkOrder};

/// Directory prefixes that should never be included in captured changed files.
const IGNORED_PREFIXES: &[&str] = &[
    "target/",
    "node_modules/",
    ".claude/",
    ".workflow/",
    "dist/",
    ".git/",
];
const IGNORED_FILES: &[&str] = &["Cargo.lock"];

/// Executor that spawns the Codex CLI in headless mode.
#[derive(Clone)]
pub struct CodexExecutor {
    /// Path to the codex binary.
    codex_binary: String,
    /// Semaphore limiting concurrent Codex sessions (subscription-based).
    semaphore: Arc<Semaphore>,
}

impl CodexExecutor {
    pub fn new(codex_binary: String, max_concurrent: usize) -> Self {
        Self {
            codex_binary,
            semaphore: Arc::new(Semaphore::new(max_concurrent)),
        }
    }
}

#[async_trait]
impl Executor for CodexExecutor {
    async fn execute(
        &self,
        config: &Config,
        work_order: &WorkOrder,
        working_dir: &Path,
    ) -> Result<ExecutionResult> {
        info!(wo_id = %work_order.id, "Starting Codex execution");

        // ── Phase 1: Context Assembly ───────────────────────────────────
        let (assembled_context, mcp_client) = match McpClient::new(config).await {
            Ok(mcp) => {
                let mcp = Arc::new(mcp);
                let ctx = match context::assemble_context(&mcp, work_order, working_dir).await {
                    Ok(ctx) => ctx,
                    Err(e) => {
                        warn!(wo_id = %work_order.id, error = %e, "Context assembly failed, using WO fields only");
                        AssembledContext {
                            agent_brief: None,
                            file_contents: vec![],
                            dependencies: None,
                        }
                    }
                };
                (ctx, Some(mcp))
            }
            Err(e) => {
                warn!(wo_id = %work_order.id, error = %e, "MCP client init failed, using WO fields only");
                (
                    AssembledContext {
                        agent_brief: None,
                        file_contents: vec![],
                        dependencies: None,
                    },
                    None,
                )
            }
        };

        // Build known_files list for scope filtering
        let known_files: Vec<String> = work_order
            .interface_files
            .iter()
            .chain(work_order.reference_files.iter())
            .chain(work_order.input_files.iter())
            .chain(work_order.full_context_files.iter())
            .cloned()
            .collect();

        let max_retries = work_order.execution.max_retries;
        let timeout_duration =
            Duration::from_secs(work_order.execution.timeout_minutes as u64 * 60);

        let mut all_tool_calls: Vec<ToolCallLog> = Vec::new();
        let mut last_gate_results: Option<GateResults> = None;
        let mut last_error: Option<String> = None;
        let mut last_diffs: Vec<StructuredDiff> = Vec::new();
        let mut last_unified_diff: Option<String> = None;
        let mut retries_used: u32 = 0;

        // ── Retry loop: Phase 2 + Phase 3 ──────────────────────────────
        for attempt in 0..=max_retries {
            if attempt > 0 {
                info!(wo_id = %work_order.id, attempt, "Retrying Codex execution");
                retries_used = attempt;
            }

            // Build error context from previous gate failure
            let retry_context = last_gate_results
                .as_ref()
                .and_then(|gr| gr.error_context.clone());

            // Build prompt
            let prompt = build_codex_prompt(
                work_order,
                &assembled_context,
                &config.gate_commands,
                retry_context.as_deref(),
            );

            // ── Phase 2: Spawn Codex ────────────────────────────────────
            info!(wo_id = %work_order.id, attempt, "Phase 2: Spawning Codex CLI");

            // Acquire concurrency permit
            let _permit = self
                .semaphore
                .acquire()
                .await
                .map_err(|e| anyhow::anyhow!("Codex semaphore closed: {}", e))?;

            let codex_result = timeout(timeout_duration, async {
                let mut child = tokio::process::Command::new(&self.codex_binary)
                    .args([
                        "exec",
                        "--dangerously-bypass-approvals-and-sandbox",
                        "--json",
                        "--ephemeral",
                        "-C",
                        &working_dir.to_string_lossy(),
                        "-", // read prompt from stdin
                    ])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .context("Failed to spawn codex process")?;

                // Write prompt to stdin
                if let Some(mut stdin) = child.stdin.take() {
                    stdin
                        .write_all(prompt.as_bytes())
                        .await
                        .context("Failed to write prompt to codex stdin")?;
                    // Drop stdin to signal EOF
                }

                let output = child
                    .wait_with_output()
                    .await
                    .context("Failed to wait for codex process")?;

                Ok::<_, anyhow::Error>((
                    output.status,
                    String::from_utf8_lossy(&output.stdout).to_string(),
                    String::from_utf8_lossy(&output.stderr).to_string(),
                ))
            })
            .await;

            let (exit_status, stdout, stderr) = match codex_result {
                Ok(Ok((status, stdout, stderr))) => (status, stdout, stderr),
                Ok(Err(e)) => {
                    last_error = Some(format!("Codex process error: {e}"));
                    continue;
                }
                Err(_) => {
                    last_error = Some(format!(
                        "Codex timed out after {}m",
                        work_order.execution.timeout_minutes
                    ));
                    // Try to revert any partial changes
                    let _ = revert_working_tree(working_dir);
                    continue;
                }
            };

            // Parse JSONL events for tool call logs
            let tool_calls = parse_codex_events(&stdout);
            all_tool_calls.extend(tool_calls);

            if !exit_status.success() {
                let code = exit_status.code().unwrap_or(-1);
                warn!(wo_id = %work_order.id, code, "Codex exited with non-zero status");
                debug!(wo_id = %work_order.id, stderr = %stderr, "Codex stderr");
                last_error = Some(format!("Codex exited with code {code}"));
                let _ = revert_working_tree(working_dir);
                continue;
            }

            // Capture what Codex changed
            let mut changed_files =
                capture_changed_files(working_dir, work_order.scope.as_deref(), &known_files)?;
            if changed_files.is_empty() {
                warn!(wo_id = %work_order.id, "Codex produced no file changes");
                last_error = Some("Codex produced no changes".to_string());
                continue; // No need to revert — nothing changed
            }

            info!(wo_id = %work_order.id, files = ?changed_files, "Codex modified files");

            // ── Verification sub-loop ─────────────────────────────────
            // Check required symbols exist, re-invoke Codex if missing.
            if !work_order.verification.is_empty() {
                if let Some(ref mcp) = mcp_client {
                    let max_verification_retries = 2u32;
                    for v_attempt in 0..=max_verification_retries {
                        let missing =
                            gates::run_verification_gate(mcp, &work_order.verification, working_dir).await;
                        if missing.is_empty() {
                            info!(wo_id = %work_order.id, "Verification passed: all required symbols present");
                            break;
                        }
                        if v_attempt == max_verification_retries {
                            warn!(
                                wo_id = %work_order.id,
                                missing_count = missing.iter().map(|(_, s)| s.len()).sum::<usize>(),
                                "Verification failed after {} fix attempts, proceeding to gates",
                                max_verification_retries
                            );
                            break;
                        }
                        info!(
                            wo_id = %work_order.id,
                            v_attempt,
                            missing_count = missing.iter().map(|(_, s)| s.len()).sum::<usize>(),
                            "Verification found missing symbols, re-invoking Codex"
                        );
                        // Re-invoke Codex with targeted fix prompt — NO revert
                        let fix_prompt = build_verification_fix_prompt(&missing, work_order);
                        let _permit = self
                            .semaphore
                            .acquire()
                            .await
                            .expect("semaphore closed");
                        let fix_output = tokio::process::Command::new(&self.codex_binary)
                            .args([
                                "exec",
                                "--dangerously-bypass-approvals-and-sandbox",
                                "--json",
                                "--ephemeral",
                                "-C",
                            ])
                            .arg(working_dir)
                            .arg("-")
                            .stdin(std::process::Stdio::piped())
                            .stdout(std::process::Stdio::piped())
                            .stderr(std::process::Stdio::piped())
                            .spawn();
                        match fix_output {
                            Ok(mut child) => {
                                if let Some(mut stdin) = child.stdin.take() {
                                    use tokio::io::AsyncWriteExt;
                                    let _ = stdin.write_all(fix_prompt.as_bytes()).await;
                                    drop(stdin);
                                }
                                let timeout_dur = Duration::from_secs(180); // 3 min for fix
                                match tokio::time::timeout(timeout_dur, child.wait()).await {
                                    Ok(Ok(status)) if status.success() => {
                                        info!(wo_id = %work_order.id, v_attempt, "Verification fix Codex completed");
                                    }
                                    Ok(Ok(status)) => {
                                        warn!(wo_id = %work_order.id, code = ?status.code(), "Verification fix Codex exited non-zero");
                                    }
                                    Ok(Err(e)) => {
                                        warn!(wo_id = %work_order.id, error = %e, "Verification fix Codex error");
                                    }
                                    Err(_) => {
                                        warn!(wo_id = %work_order.id, "Verification fix Codex timed out");
                                        let _ = child.kill().await;
                                    }
                                }
                            }
                            Err(e) => {
                                warn!(wo_id = %work_order.id, error = %e, "Failed to spawn verification fix Codex");
                                break;
                            }
                        }
                        drop(_permit);
                    }
                    // Re-capture changed files after verification fixes
                    changed_files = capture_changed_files(
                        working_dir,
                        work_order.scope.as_deref(),
                        &known_files,
                    )?;
                }
            }

            last_diffs = synthesize_diffs(&changed_files, working_dir);

            // ── Phase 3: Deterministic Gates ────────────────────────────
            info!(wo_id = %work_order.id, attempt, "Phase 3: Running gates");
            let gate_results = gates::run_gates_in_place(
                work_order,
                working_dir,
                &config.gate_commands,
                config.command_timeout_seconds,
                mcp_client.as_deref(),
                None,
            )
            .await?;

            if gate_results.all_passed {
                info!(wo_id = %work_order.id, attempt, "All gates passed");

                // Auto-commit if configured
                if work_order.output.commit {
                    if let Err(e) = auto_commit_files(work_order, &changed_files, working_dir) {
                        warn!(wo_id = %work_order.id, error = %e, "Auto-commit failed");
                        last_error = Some(format!("Gates passed but commit failed: {e}"));
                        last_gate_results = Some(gate_results);
                        break;
                    }
                    
                    // Capture unified diff of the commit
                    let unified_diff = match tokio::process::Command::new("git")
                        .args(["diff", "HEAD~1..HEAD"])
                        .current_dir(working_dir)
                        .output()
                        .await
                    {
                        Ok(output) if output.status.success() => {
                            let diff = String::from_utf8_lossy(&output.stdout).to_string();
                            if diff.is_empty() { None } else { Some(diff) }
                        }
                        _ => None,
                    };
                    last_unified_diff = unified_diff;
                }

                last_gate_results = Some(gate_results);
                last_error = None;
                break;
            }

            // Gates failed — revert before retry
            warn!(wo_id = %work_order.id, attempt, "Gates failed, reverting changes");
            revert_working_tree(working_dir)?;
            last_gate_results = Some(gate_results);

            if attempt == max_retries {
                last_error = Some(format!(
                    "Gates failed after {} retries. Escalation recommended.",
                    max_retries
                ));
            }
        }

        let success =
            last_error.is_none() && last_gate_results.as_ref().map_or(true, |gr| gr.all_passed);

        Ok(ExecutionResult {
            work_order_id: work_order.id.clone(),
            success,
            error: last_error,
            diffs: last_diffs,
            unified_diff: last_unified_diff,
            tool_calls: all_tool_calls,
            token_usage: TokenUsage::default(), // Codex doesn't report token usage
            iterations: retries_used + 1,
            retries_used,
            gate_results: last_gate_results,
            contract_violation: None, // Codex doesn't use our tool registry
        })
    }
}

// ── Helper functions ─────────────────────────────────────────────────────────

/// Build the prompt for Codex from WO + assembled context + retry errors.
fn build_codex_prompt(
    work_order: &WorkOrder,
    assembled_context: &AssembledContext,
    gate_commands: &crate::config::GateCommands,
    retry_error: Option<&str>,
) -> String {
    let mut prompt = String::new();

    prompt.push_str(&format!("## Task\n{}\n\n", work_order.title));
    prompt.push_str(&format!("## Description\n{}\n\n", work_order.description));

    // Add assembled context
    let ctx = format_context(assembled_context);
    if !ctx.is_empty() {
        prompt.push_str(&format!("## Context\n{}\n\n", ctx));
    }

    // Add gate info so Codex knows what will be checked
    prompt.push_str("## Quality Gates\n");
    prompt.push_str("After your changes, the following gates will run:\n");
    if work_order.gates.typecheck {
        prompt.push_str(&format!("- Typecheck: `{}`\n", gate_commands.typecheck));
    }
    if work_order.gates.lint {
        prompt.push_str(&format!("- Lint: `{}`\n", gate_commands.lint));
    }
    if work_order.gates.tests.run {
        prompt.push_str(&format!("- Tests: `{}`\n", gate_commands.test));
    }
    prompt.push_str("\nMake sure your changes pass all gates.\n\n");

    // Add scope constraint
    if let Some(ref scope) = work_order.scope {
        prompt.push_str(&format!(
            "## Scope\nOnly modify files within `{}`.\n\n",
            scope
        ));
    }

    // Add retry context
    if let Some(errors) = retry_error {
        prompt.push_str(&format!(
            "## Previous Attempt Failed\nThe previous attempt failed gate checks. Fix the following errors:\n\n{}\n\n",
            errors
        ));
    }

    prompt
}

/// Capture the list of files changed in the working tree relative to HEAD.
///
/// Filters out ignored directories/files and optionally restricts to scope.
/// Files listed in `known_files` (interface, reference, input, full_context)
/// are always included even if outside scope.
fn capture_changed_files(
    working_dir: &Path,
    scope: Option<&str>,
    known_files: &[String],
) -> Result<Vec<String>> {
    use std::process::Command;

    // Get both modified tracked files and new untracked files
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

    // Also capture untracked files (new files created by Codex)
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

    // Filter out ignored directories, files, and enforce scope
    files.retain(|f| {
        if IGNORED_PREFIXES.iter().any(|prefix| f.starts_with(prefix)) {
            return false;
        }
        if IGNORED_FILES.iter().any(|name| f == *name) {
            return false;
        }
        if let Some(scope) = scope {
            return f.starts_with(scope) || known_files.iter().any(|kf| kf == f);
        }
        true
    });

    Ok(files)
}

/// Revert all changes in the working tree (for retry).
fn revert_working_tree(working_dir: &Path) -> Result<()> {
    use std::process::Command;

    // Revert tracked file changes
    let checkout = Command::new("git")
        .args(["checkout", "--", "."])
        .current_dir(working_dir)
        .output()
        .context("Failed to run git checkout")?;

    if !checkout.status.success() {
        let stderr = String::from_utf8_lossy(&checkout.stderr);
        warn!("git checkout failed: {}", stderr);
    }

    // Remove untracked files
    let clean = Command::new("git")
        .args(["clean", "-fd"])
        .current_dir(working_dir)
        .output()
        .context("Failed to run git clean")?;

    if !clean.status.success() {
        let stderr = String::from_utf8_lossy(&clean.stderr);
        warn!("git clean failed: {}", stderr);
    }

    Ok(())
}

/// Synthesize StructuredDiff entries for reporting (from changed file list).
/// For new files, reads full content. For modified files, reads current content as Replace.
fn synthesize_diffs(changed_files: &[String], working_dir: &Path) -> Vec<StructuredDiff> {
    changed_files
        .iter()
        .filter_map(|file| {
            let full_path = working_dir.join(file);
            let content = std::fs::read_to_string(&full_path).ok()?;
            Some(StructuredDiff {
                file: file.clone(),
                action: DiffAction::Create, // Simplified — all are full-file for reporting
                anchor: None,
                content: Some(content),
            })
        })
        .collect()
}

/// Parse Codex JSONL event stream for tool call logs.
/// Extracts function_call events as ToolCallLog entries.
fn parse_codex_events(stdout: &str) -> Vec<ToolCallLog> {
    let mut logs = Vec::new();

    for line in stdout.lines() {
        if line.is_empty() {
            continue;
        }

        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };

        let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match event_type {
            "function_call" => {
                let tool = value
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string();
                let args = value
                    .get("arguments")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                // Truncate args for summary
                let summary = if args.len() > 200 {
                    format!("{}...", &args[..200])
                } else {
                    args
                };
                logs.push(ToolCallLog {
                    tool,
                    input_summary: summary,
                    success: true, // we don't know until function_call_output
                });
            }
            _ => {} // Skip message, function_call_output, etc.
        }
    }

    logs
}

/// Build a targeted fix prompt for Codex to add missing symbols.
fn build_verification_fix_prompt(
    missing: &[(String, Vec<VerificationSymbol>)],
    work_order: &WorkOrder,
) -> String {
    let mut prompt = format!(
        "The following required symbols are MISSING from files you created for work order '{}'.\n\
         Add them to the EXISTING files WITHOUT removing or changing any existing code.\n\n",
        work_order.title
    );
    for (file, symbols) in missing {
        prompt.push_str(&format!("File `{file}` is missing:\n"));
        for sym in symbols {
            prompt.push_str(&format!("  - `{}` ({})\n", sym.name, sym.kind));
        }
        prompt.push('\n');
    }
    prompt.push_str(
        "Refer to the original work order description for the full specification of these symbols.\n",
    );
    prompt
}

// ── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::{FileContext, FileContextSource};

    fn make_test_wo() -> WorkOrder {
        make_test_wo_with("WO-TEST-001", "Test WO")
    }

    fn make_test_wo_with(id: &str, title: &str) -> WorkOrder {
        serde_yaml::from_str(&format!(
            r#"
id: "{id}"
group_id: test-group
title: "{title}"
description: "A test work order"
task: implement
scope: src/
gates:
  compile: true
  lint: true
  typecheck: true
  tests:
    run: false
    scope: relevant
    specific: []
    expect: pass
execution:
  mode: unattended
  model: codex
  max_retries: 2
  timeout_minutes: 5
output:
  commit: true
  commit_prefix: "feat"
"#
        ))
        .unwrap()
    }

    fn empty_context() -> AssembledContext {
        AssembledContext {
            agent_brief: None,
            file_contents: vec![],
            dependencies: None,
        }
    }

    fn sample_context() -> AssembledContext {
        AssembledContext {
            agent_brief: Some("Implement health check endpoint".into()),
            file_contents: vec![FileContext {
                path: "src/server/index.ts".into(),
                content: "export const app = new Hono();".into(),
                source: FileContextSource::InternReadFile,
            }],
            dependencies: Some("index.ts -> health.ts".into()),
        }
    }

    fn default_gate_commands() -> crate::config::GateCommands {
        crate::config::GateCommands::default()
    }

    // ── build_codex_prompt ────────────────────────────────────────────────────

    #[test]
    fn test_build_codex_prompt_basic() {
        let wo = make_test_wo();
        let ctx = empty_context();
        let prompt = build_codex_prompt(&wo, &ctx, &default_gate_commands(), None);

        assert!(prompt.contains("Test WO"), "prompt should contain title");
        assert!(
            prompt.contains("A test work order"),
            "prompt should contain description"
        );
    }

    #[test]
    fn test_build_codex_prompt_with_context() {
        let wo = make_test_wo();
        let ctx = sample_context();
        let prompt = build_codex_prompt(&wo, &ctx, &default_gate_commands(), None);

        assert!(
            prompt.contains("health check endpoint"),
            "prompt should contain agent brief"
        );
        assert!(
            prompt.contains("src/server/index.ts"),
            "prompt should contain file path"
        );
        assert!(
            prompt.contains("export const app"),
            "prompt should contain file content"
        );
    }

    #[test]
    fn test_build_codex_prompt_with_retry_error() {
        let wo = make_test_wo();
        let ctx = empty_context();
        let error = "TypeScript error: Type 'string' is not assignable to type 'number'";
        let prompt = build_codex_prompt(&wo, &ctx, &default_gate_commands(), Some(error));

        assert!(
            prompt.contains("Previous Attempt Failed"),
            "prompt should contain retry header"
        );
        assert!(
            prompt.contains("Type 'string' is not assignable"),
            "prompt should contain error text"
        );
    }

    #[test]
    fn test_build_codex_prompt_with_gates() {
        let wo = make_test_wo();
        let ctx = empty_context();
        let gate_commands = crate::config::GateCommands {
            typecheck: "bun run typecheck".to_string(),
            lint: "bun run lint".to_string(),
            test: "bun test {scope}".to_string(),
        };
        let prompt = build_codex_prompt(&wo, &ctx, &gate_commands, None);

        assert!(
            prompt.contains("Quality Gates"),
            "prompt should list quality gates"
        );
        assert!(
            prompt.contains("bun run typecheck"),
            "prompt should contain typecheck command"
        );
        assert!(
            prompt.contains("bun run lint"),
            "prompt should contain lint command"
        );
        // tests.run is false in make_test_wo, so test command should NOT appear
        assert!(
            !prompt.contains("bun test"),
            "prompt should not contain test command when tests.run = false"
        );
    }

    // ── parse_codex_events ────────────────────────────────────────────────────

    #[test]
    fn test_parse_codex_events_empty() {
        let logs = parse_codex_events("");
        assert!(logs.is_empty());
    }

    #[test]
    fn test_parse_codex_events_function_calls() {
        let jsonl = r#"{"type":"message","content":"Starting..."}
{"type":"function_call","name":"write_file","arguments":"{\"path\":\"src/foo.rs\"}"}
{"type":"function_call_output","output":"ok"}
{"type":"function_call","name":"read_file","arguments":"{\"path\":\"src/bar.rs\"}"}
"#;
        let logs = parse_codex_events(jsonl);
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0].tool, "write_file");
        assert!(logs[0].input_summary.contains("src/foo.rs"));
        assert!(logs[0].success);
        assert_eq!(logs[1].tool, "read_file");
        assert!(logs[1].input_summary.contains("src/bar.rs"));
    }

    #[test]
    fn test_parse_codex_events_invalid_json() {
        let jsonl = r#"not json at all
{"type":"function_call","name":"write_file","arguments":"{}"}
{broken json}
{"type":"function_call","name":"done","arguments":"{}"}
"#;
        // Should not panic, bad lines are silently skipped
        let logs = parse_codex_events(jsonl);
        assert_eq!(logs.len(), 2, "should parse 2 valid function_call events");
        assert_eq!(logs[0].tool, "write_file");
        assert_eq!(logs[1].tool, "done");
    }

    // ── synthesize_diffs ──────────────────────────────────────────────────────

    #[test]
    fn test_synthesize_diffs() {
        use std::io::Write;

        let dir = tempfile::tempdir().expect("tempdir");
        let file_path = dir.path().join("hello.ts");
        let mut f = std::fs::File::create(&file_path).unwrap();
        write!(f, "export const greeting = 'hello';").unwrap();

        let changed = vec!["hello.ts".to_string()];
        let diffs = synthesize_diffs(&changed, dir.path());

        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].file, "hello.ts");
        assert_eq!(diffs[0].action, DiffAction::Create);
        assert!(diffs[0].anchor.is_none());
        assert_eq!(
            diffs[0].content.as_deref(),
            Some("export const greeting = 'hello';")
        );
    }

    #[test]
    fn test_synthesize_diffs_missing_file() {
        // A file that doesn't exist should be silently skipped (read_to_string fails)
        let dir = tempfile::tempdir().expect("tempdir");
        let changed = vec!["nonexistent.ts".to_string()];
        let diffs = synthesize_diffs(&changed, dir.path());
        assert!(
            diffs.is_empty(),
            "missing file should produce no diff entry"
        );
    }

    // ── verification helpers ─────────────────────────────────────────────────

    #[test]
    fn test_build_verification_fix_prompt() {
        let missing = vec![(
            "src/types.ts".to_string(),
            vec![
                VerificationSymbol {
                    name: "Foo".into(),
                    kind: "interface".into(),
                },
                VerificationSymbol {
                    name: "Bar".into(),
                    kind: "type_alias".into(),
                },
            ],
        )];
        let wo = make_test_wo_with("WO-TEST", "Test WO");
        let prompt = build_verification_fix_prompt(&missing, &wo);
        assert!(prompt.contains("Foo"));
        assert!(prompt.contains("interface"));
        assert!(prompt.contains("Bar"));
        assert!(prompt.contains("type_alias"));
        assert!(prompt.contains("src/types.ts"));
    }

    #[test]
    fn test_capture_filter_ignores_target() {
        // This tests the filtering logic conceptually
        let files = vec![
            "src/types.ts".to_string(),
            "target/debug/something".to_string(),
            ".claude/tickets/TKT-001.yaml".to_string(),
            "src/main.ts".to_string(),
            "Cargo.lock".to_string(),
        ];
        let filtered: Vec<String> = files
            .into_iter()
            .filter(|f| {
                if IGNORED_PREFIXES.iter().any(|p| f.starts_with(p)) {
                    return false;
                }
                if IGNORED_FILES.iter().any(|name| f == *name) {
                    return false;
                }
                true
            })
            .collect();
        assert_eq!(filtered, vec!["src/types.ts", "src/main.ts"]);
    }
}
