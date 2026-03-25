//! Three-phase executor: context assembly → agent loop → deterministic gates.
//!
//! Phase 1: Calls MCP intern tools to pre-assemble all code context.
//! Phase 2: Minimal agent loop — model receives context, produces diffs, calls done.
//! Phase 3: Applies diffs, runs compile/lint/test gates deterministically.
//!
//! Phases 2+3 are wrapped in a retry loop. If gates fail, the agent is re-invoked
//! with the error context. After max retries, execution fails with escalation hint.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tracing::{debug, info, warn};

use crate::api_client::{ApiClient, ContentBlock, Message, MessagesRequest, RateLimitError};
use crate::config::Config;
use crate::context::{self, AssembledContext};
use crate::diff::StructuredDiff;
use crate::gates::{self, GateResults};
use crate::mcp_client::McpClient;
use crate::tools::done::DoneTool;
use crate::tools::mcp_proxy::create_mcp_tools;
use crate::tools::write_file::WriteFileTool;
use crate::tools::ToolRegistry;
use crate::wo::{TaskType, WorkOrder};

/// Result of executing a work order.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionResult {
    /// Work order ID that was executed.
    pub work_order_id: String,

    /// Whether execution succeeded (agent completed + all gates passed).
    pub success: bool,

    /// Error message if execution failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,

    /// Structured diffs produced by the agent.
    pub diffs: Vec<StructuredDiff>,

    /// Log of tool calls made during execution.
    pub tool_calls: Vec<ToolCallLog>,

    /// Total token usage across all API calls (all retries).
    pub token_usage: TokenUsage,

    /// Number of agent iterations (API round-trips) across all retries.
    pub iterations: u32,

    /// Number of retry attempts used.
    pub retries_used: u32,

    /// Gate results from the last run (if gates were executed).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gate_results: Option<GateResults>,
}

/// A log entry for a single tool call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallLog {
    /// Tool name.
    pub tool: String,

    /// Input arguments (summarized).
    pub input_summary: String,

    /// Whether the call succeeded.
    pub success: bool,
}

/// Accumulated token usage.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TokenUsage {
    /// Total input tokens.
    pub input_tokens: u32,

    /// Total output tokens.
    pub output_tokens: u32,
}

/// Execute a work order through the three-phase pipeline.
///
/// 1. Context assembly (once, via MCP intern tools)
/// 2. Agent loop (minimal: write_file + done + search escape hatch)
/// 3. Deterministic gates (compile, lint, test)
///
/// Phases 2+3 are retried up to `max_retries` times on gate failure.
pub async fn execute(
    config: &Config,
    work_order: &WorkOrder,
    working_dir: &Path,
) -> Result<ExecutionResult> {
    info!(wo_id = %work_order.id, working_dir = %working_dir.display(), "Starting execution");

    // Initialize clients
    let api_client = ApiClient::new(config);
    let mcp_client = Arc::new(McpClient::new(config).await?);

    // ── Phase 1: Context Assembly ───────────────────────────────────────────
    info!(wo_id = %work_order.id, "Phase 1: Context assembly");
    let assembled_context = context::assemble_context(&mcp_client, work_order, working_dir).await?;

    // Determine model and retry config
    let model = if work_order.execution.model.is_empty() {
        config.default_model.clone()
    } else {
        work_order.execution.model.clone()
    };
    let max_retries = work_order.execution.max_retries;

    // Aggregate state across retries
    let mut all_tool_calls: Vec<ToolCallLog> = Vec::new();
    let mut total_token_usage = TokenUsage::default();
    let mut total_iterations: u32 = 0;
    let mut last_gate_results: Option<GateResults> = None;
    let mut last_error: Option<String> = None;
    let mut last_diffs: Vec<StructuredDiff> = Vec::new();

    // ── Retry loop: Phase 2 + Phase 3 ──────────────────────────────────────
    for attempt in 0..=max_retries {
        if attempt > 0 {
            info!(wo_id = %work_order.id, attempt, "Retrying after gate failure");
        }

        // Build error context from previous attempt (if any)
        let retry_context = last_gate_results
            .as_ref()
            .and_then(|gr| gr.error_context.clone());

        // ── Phase 2: Agent Loop ─────────────────────────────────────────────
        info!(wo_id = %work_order.id, attempt, "Phase 2: Agent loop");
        let agent_result = run_agent_loop(
            &api_client,
            &mcp_client,
            config,
            work_order,
            working_dir,
            &model,
            &assembled_context,
            retry_context.as_deref(),
        )
        .await;

        let agent_result = match agent_result {
            Ok(r) => r,
            Err(e) => {
                last_error = Some(e.to_string());
                break;
            }
        };

        // Accumulate stats
        all_tool_calls.extend(agent_result.tool_calls);
        total_token_usage.input_tokens += agent_result.token_usage.input_tokens;
        total_token_usage.output_tokens += agent_result.token_usage.output_tokens;
        total_iterations += agent_result.iterations;
        last_diffs = agent_result.diffs.clone();

        if !agent_result.done_called {
            last_error = Some("Agent did not call the done tool".to_string());
            // Still try gates — the diffs might be fine
        }

        if agent_result.diffs.is_empty() {
            last_error = Some("Agent produced no diffs".to_string());
            break;
        }

        // ── Phase 3: Deterministic Gates ────────────────────────────────────
        info!(wo_id = %work_order.id, attempt, "Phase 3: Running gates");
        let gate_results = gates::run_gates(
            work_order,
            &agent_result.diffs,
            working_dir,
            config.command_timeout_seconds,
        )
        .await?;

        if gate_results.all_passed {
            info!(wo_id = %work_order.id, attempt, "All gates passed");
            last_gate_results = Some(gate_results);
            last_error = None;
            break;
        }

        // Gates failed — revert diffs before retry
        warn!(wo_id = %work_order.id, attempt, "Gates failed, reverting diffs");
        gates::revert_diffs(&agent_result.diffs, working_dir);
        last_gate_results = Some(gate_results);

        if attempt == max_retries {
            last_error = Some(format!(
                "Gates failed after {} retries. Escalation recommended.",
                max_retries
            ));
        }
    }

    let success = last_error.is_none()
        && last_gate_results
            .as_ref()
            .map_or(true, |gr| gr.all_passed);

    Ok(ExecutionResult {
        work_order_id: work_order.id.clone(),
        success,
        error: last_error,
        diffs: last_diffs,
        tool_calls: all_tool_calls,
        token_usage: total_token_usage,
        iterations: total_iterations,
        retries_used: 0, // TODO: track actual retries used
        gate_results: last_gate_results,
    })
}

// ── Agent loop (Phase 2) ────────────────────────────────────────────────────

/// Result of a single agent loop run.
struct AgentLoopResult {
    diffs: Vec<StructuredDiff>,
    tool_calls: Vec<ToolCallLog>,
    token_usage: TokenUsage,
    iterations: u32,
    done_called: bool,
}

/// Run the minimal agent loop: model receives context, writes diffs, calls done.
///
/// Toolset: write_file, done, search (escape hatch).
#[allow(clippy::too_many_arguments)]
async fn run_agent_loop(
    api_client: &ApiClient,
    mcp_client: &Arc<McpClient>,
    config: &Config,
    work_order: &WorkOrder,
    working_dir: &Path,
    model: &str,
    assembled_context: &AssembledContext,
    retry_error_context: Option<&str>,
) -> Result<AgentLoopResult> {
    // Set up shared state
    let diff_collector: Arc<Mutex<Vec<StructuredDiff>>> = Arc::new(Mutex::new(Vec::new()));
    let done_flag = Arc::new(AtomicBool::new(false));

    // Build minimal tool registry: write_file + done + search (escape hatch)
    let mut registry = ToolRegistry::new();

    // Search as escape hatch (only tool that uses MCP)
    let search_tools = create_mcp_tools(mcp_client.clone(), working_dir.to_path_buf());
    for tool in search_tools {
        if tool.name() == "search" {
            registry.register(tool);
            break;
        }
    }

    registry.register(Box::new(WriteFileTool::new(diff_collector.clone())));
    registry.register(Box::new(DoneTool::new(done_flag.clone())));

    // Build messages
    let system_prompt = build_system_prompt(work_order);
    let initial_message = build_initial_message(work_order, assembled_context, retry_error_context);

    let mut messages: Vec<Message> = vec![initial_message];
    let mut tool_call_log: Vec<ToolCallLog> = Vec::new();
    let mut token_usage = TokenUsage::default();
    let mut iterations: u32 = 0;

    let timeout_duration = std::time::Duration::from_secs(config.timeout_seconds);

    let loop_result = tokio::time::timeout(timeout_duration, async {
        for _ in 0..config.max_iterations {
            info!(iteration = iterations, wo_id = %work_order.id, "Agent loop iteration");

            let request = MessagesRequest {
                model: model.to_string(),
                max_tokens: 4096,
                system: Some(system_prompt.clone()),
                messages: messages.clone(),
                tools: registry.tool_definitions(),
            };

            // Call API with rate-limit retry
            let response = loop {
                match api_client.send_message(&request).await {
                    Ok(resp) => break resp,
                    Err(e) if e.downcast_ref::<RateLimitError>().is_some() => {
                        warn!("Rate limited; sleeping 30s before retry");
                        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                        continue;
                    }
                    Err(e) => return Err(e),
                }
            };

            token_usage.input_tokens += response.usage.input_tokens;
            token_usage.output_tokens += response.usage.output_tokens;

            let assistant_message = Message {
                role: "assistant".to_string(),
                content: response.content.clone(),
            };
            messages.push(assistant_message);

            // Process tool use blocks
            let mut tool_results: Vec<ContentBlock> = Vec::new();
            for block in &response.content {
                if let ContentBlock::ToolUse { id, name, input } = block {
                    debug!(tool = %name, "Executing tool call");
                    let output = registry.execute(name, input.clone()).await;
                    let (content, is_error) = match &output {
                        Ok(out) => (out.content.clone(), out.is_error),
                        Err(e) => (format!("Tool error: {e}"), true),
                    };

                    let input_summary = serde_json::to_string(input)
                        .unwrap_or_else(|_| input.to_string());
                    let summary = if input_summary.len() > 200 {
                        let mut end = 200;
                        while end > 0 && !input_summary.is_char_boundary(end) {
                            end -= 1;
                        }
                        format!("{}...", &input_summary[..end])
                    } else {
                        input_summary
                    };
                    tool_call_log.push(ToolCallLog {
                        tool: name.clone(),
                        input_summary: summary,
                        success: !is_error,
                    });

                    tool_results.push(ContentBlock::ToolResult {
                        tool_use_id: id.clone(),
                        content,
                        is_error: if is_error { Some(true) } else { None },
                    });
                }
            }

            if !tool_results.is_empty() {
                messages.push(Message {
                    role: "user".to_string(),
                    content: tool_results,
                });
            }

            iterations += 1;

            if done_flag.load(Ordering::SeqCst) {
                info!(iterations, wo_id = %work_order.id, "Done flag set; exiting loop");
                break;
            }

            if response.stop_reason.as_deref() == Some("end_turn") {
                info!(iterations, wo_id = %work_order.id, "Model returned end_turn; exiting loop");
                break;
            }
        }

        Ok(())
    })
    .await;

    if let Err(e) = loop_result {
        warn!("Agent loop timed out: {e}");
    } else if let Ok(Err(e)) = loop_result {
        return Err(e);
    }

    let diffs = diff_collector
        .lock()
        .map_err(|e| anyhow::anyhow!("lock poisoned: {e}"))?
        .clone();

    Ok(AgentLoopResult {
        diffs,
        tool_calls: tool_call_log,
        token_usage,
        iterations,
        done_called: done_flag.load(Ordering::SeqCst),
    })
}

// ── Prompt builders ─────────────────────────────────────────────────────────

/// Build the system prompt for the minimal agent.
fn build_system_prompt(work_order: &WorkOrder) -> String {
    let task_guidance = match work_order.task {
        TaskType::Implement => {
            "Your task is to IMPLEMENT code. Write correct, idiomatic code that satisfies all requirements."
        }
        TaskType::Test => {
            "Your task is to WRITE TESTS. Focus on coverage, edge cases, and meaningful assertions."
        }
        TaskType::Fix => {
            "Your task is to FIX a bug. Make the minimal change that fixes the problem."
        }
        TaskType::Refactor => {
            "Your task is to REFACTOR code following the provided reference pattern. Preserve all existing behavior."
        }
        TaskType::Review => {
            "Your task is to REVIEW the code and report findings using write_file."
        }
    };

    format!(
        r#"You are a code implementation agent. You receive a work order with all relevant code context pre-assembled. Your job is to produce file changes using write_file, then call done.

{task_guidance}

## Tools

- **write_file** — Produce file changes (see format below). This is your primary tool.
- **done** — Signal completion. Call this when all changes are written.
- **search** — Search the codebase if you need additional context not provided. Use sparingly.

## write_file format

Parameters:
- `file`: path relative to project root
- `action`: one of `create`, `replace`, `insert_after`, `delete`
- `anchor`: unique string to locate the edit position (required for replace/insert_after/delete)
- `content`: the new code (not needed for delete)

For **new files**: `action: "create"` with full file content. No anchor needed.
For **modifications**: `action: "replace"` with an anchor that uniquely identifies the code to replace.

## Workflow

1. Study the work order and provided code context carefully.
2. Produce all changes using write_file.
3. Call done with a brief summary.

You do NOT need to verify compilation or run tests — that happens automatically after you finish.

## Constraints

- Stay within the stated scope.
- Make focused, minimal changes.
- Do not explore the codebase unless the provided context is insufficient.
- Call done promptly after writing all changes.
"#
    )
}

/// Build the initial user message with work order + assembled context.
fn build_initial_message(
    work_order: &WorkOrder,
    assembled_context: &AssembledContext,
    retry_error_context: Option<&str>,
) -> Message {
    let mut parts: Vec<String> = Vec::new();

    // Header
    parts.push(format!(
        "# Work Order: {}\n\n**ID:** {}\n**Type:** {:?}",
        work_order.title, work_order.id, work_order.task
    ));

    // Description
    parts.push(format!("## Description\n\n{}", work_order.description));

    // Scope
    if let Some(scope) = &work_order.scope {
        parts.push(format!("## Scope\n\nLimit your changes to: `{scope}`"));
    }

    // Pre-assembled context (the key difference from the old executor)
    let formatted_context = context::format_context(assembled_context);
    if !formatted_context.is_empty() {
        parts.push(format!("## Code Context\n\n{formatted_context}"));
    }

    // Retry error context (from previous gate failure)
    if let Some(errors) = retry_error_context {
        parts.push(format!(
            "## Previous Attempt Failed\n\n\
            Your previous changes failed the following checks. Fix these issues:\n\n{errors}"
        ));
    }

    // Dependencies
    if !work_order.depends_on.is_empty() {
        let deps = work_order.depends_on.join(", ");
        parts.push(format!(
            "## Dependencies\n\nDepends on: {deps} (already completed)"
        ));
    }

    // Expected output
    let output_desc = match work_order.task {
        TaskType::Implement => "Working implementation that passes compilation and tests.",
        TaskType::Test => "Test file(s) with comprehensive coverage.",
        TaskType::Fix => "Minimal bug fix that resolves the issue.",
        TaskType::Refactor => "Refactored code matching the reference pattern.",
        TaskType::Review => "Review report written to a file.",
    };
    parts.push(format!("## Expected Output\n\n{output_desc}"));

    parts.push(
        "---\n\nStudy the code context above, then produce your changes with write_file and call done."
            .to_string(),
    );

    let content = parts.join("\n\n");

    Message {
        role: "user".to_string(),
        content: vec![ContentBlock::Text { text: content }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_wo(task: &str) -> WorkOrder {
        serde_yaml::from_str(&format!(
            r#"
id: WO-TEST-001
group_id: test
title: "Test WO"
description: "A test work order"
task: {task}
"#
        ))
        .unwrap()
    }

    fn make_wo_full() -> WorkOrder {
        serde_yaml::from_str(
            r#"
id: WO-TEST-002
group_id: test
title: "Full Test WO"
description: "A full work order with all fields"
task: implement
scope: src/server/
interface_files:
  - src/server/health.ts
  - src/server/types.ts
reference_files:
  - src/server/existing.ts
input_files:
  - src/server/index.ts
depends_on:
  - WO-001
  - WO-002
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

    fn sample_context() -> AssembledContext {
        AssembledContext {
            agent_brief: Some("Implement formatDuration utility".into()),
            file_contents: vec![context::FileContext {
                path: "src/shared/types.ts".into(),
                content: "export type Duration = number;".into(),
                source: context::FileContextSource::InternReadFile,
            }],
            dependencies: Some("types.ts -> utils.ts".into()),
        }
    }

    // ── build_system_prompt ───────────────────────────────────────────────────

    #[test]
    fn test_system_prompt_contains_minimal_tools() {
        let wo = make_wo("implement");
        let prompt = build_system_prompt(&wo);
        assert!(prompt.contains("write_file"));
        assert!(prompt.contains("done"));
        assert!(prompt.contains("search"));
        // Should NOT contain exploration tools
        assert!(!prompt.contains("read_file"));
        assert!(!prompt.contains("find_symbol"));
        assert!(!prompt.contains("find_references"));
        assert!(!prompt.contains("file_skeleton"));
        assert!(!prompt.contains("compile_check"));
        assert!(!prompt.contains("run_command"));
    }

    #[test]
    fn test_system_prompt_says_no_verify() {
        let wo = make_wo("implement");
        let prompt = build_system_prompt(&wo);
        assert!(prompt.contains("do NOT need to verify"));
    }

    #[test]
    fn test_system_prompt_task_guidance() {
        for (task, keyword) in &[
            ("implement", "implement"),
            ("fix", "fix"),
            ("test", "test"),
            ("refactor", "refactor"),
            ("review", "review"),
        ] {
            let wo = make_wo(task);
            let prompt = build_system_prompt(&wo);
            assert!(
                prompt.to_lowercase().contains(keyword),
                "prompt for {task} should contain {keyword}"
            );
        }
    }

    #[test]
    fn test_system_prompt_not_empty() {
        for task in &["implement", "test", "fix", "refactor", "review"] {
            let wo = make_wo(task);
            let prompt = build_system_prompt(&wo);
            assert!(!prompt.is_empty(), "empty prompt for task: {task}");
        }
    }

    // ── build_initial_message ─────────────────────────────────────────────────

    #[test]
    fn test_initial_message_role_is_user() {
        let wo = make_wo("implement");
        let msg = build_initial_message(&wo, &empty_context(), None);
        assert_eq!(msg.role, "user");
    }

    #[test]
    fn test_initial_message_contains_wo_fields() {
        let wo = make_wo_full();
        let msg = build_initial_message(&wo, &empty_context(), None);
        let text = extract_text(&msg);
        assert!(text.contains("WO-TEST-002"));
        assert!(text.contains("Full Test WO"));
        assert!(text.contains("A full work order"));
        assert!(text.contains("src/server/"));
        assert!(text.contains("WO-001"));
    }

    #[test]
    fn test_initial_message_contains_assembled_context() {
        let wo = make_wo("implement");
        let msg = build_initial_message(&wo, &sample_context(), None);
        let text = extract_text(&msg);
        assert!(text.contains("formatDuration"));
        assert!(text.contains("src/shared/types.ts"));
        assert!(text.contains("export type Duration"));
        assert!(text.contains("types.ts -> utils.ts"));
    }

    #[test]
    fn test_initial_message_contains_retry_errors() {
        let wo = make_wo("implement");
        let msg = build_initial_message(
            &wo,
            &empty_context(),
            Some("## typecheck FAILED\n\nerror TS2322: Type mismatch"),
        );
        let text = extract_text(&msg);
        assert!(text.contains("Previous Attempt Failed"));
        assert!(text.contains("TS2322"));
    }

    #[test]
    fn test_initial_message_no_retry_section_on_first_attempt() {
        let wo = make_wo("implement");
        let msg = build_initial_message(&wo, &empty_context(), None);
        let text = extract_text(&msg);
        assert!(!text.contains("Previous Attempt"));
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    fn extract_text(msg: &Message) -> String {
        msg.content
            .iter()
            .filter_map(|b| {
                if let ContentBlock::Text { text } = b {
                    Some(text.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}
