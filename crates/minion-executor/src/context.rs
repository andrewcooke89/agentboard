//! Context assembly for work order execution.
//!
//! Calls MCP intern tools to pre-assemble all the context an agent needs
//! before the agent loop starts. This replaces the model doing its own
//! exploration — the model receives everything up front and just writes diffs.

use std::path::Path;

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

use crate::mcp_client::McpClient;
use crate::wo::WorkOrder;

/// Pre-assembled context for the agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssembledContext {
    /// Brief from intern_context (structured agent brief).
    pub agent_brief: Option<String>,

    /// File contents keyed by path (from intern_read_file).
    pub file_contents: Vec<FileContext>,

    /// Dependency info for scope files.
    pub dependencies: Option<String>,
}

/// A file's focused content from intern_read_file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileContext {
    pub path: String,
    pub content: String,
    pub source: FileContextSource,
}

/// How the file content was obtained.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FileContextSource {
    /// From intern_read_file with focus extraction.
    InternReadFile,
    /// From intern_context suggested files.
    AgentBrief,
}

/// Assemble context for a work order by calling MCP intern tools.
///
/// Calls:
/// 1. `intern_context` with WO description + work-order-implementor profile
/// 2. `intern_read_file` for each file in input/interface/reference lists
/// 3. `file_dependencies` on scope (if set)
pub async fn assemble_context(
    mcp: &McpClient,
    work_order: &WorkOrder,
    working_dir: &Path,
) -> Result<AssembledContext> {
    info!(wo_id = %work_order.id, "Assembling context");

    // 1. Call intern_context for the agent brief
    let agent_brief = call_intern_context(mcp, work_order).await;

    // 2. Read all referenced files
    //    For refactor tasks, read full file content (the model needs to see everything to rewrite).
    //    For other tasks, use focused extraction via intern_read_file.
    let mut file_contents = Vec::new();
    let all_files = collect_file_paths(work_order);
    let use_full_read = matches!(work_order.task, crate::wo::TaskType::Refactor);

    for file_path in &all_files {
        let abs_path = resolve_path(file_path, working_dir);
        let result = if use_full_read {
            read_full_file(&abs_path).await
        } else {
            call_intern_read_file(mcp, &abs_path, &work_order.description).await
        };
        match result {
            Ok(content) => {
                file_contents.push(FileContext {
                    path: file_path.clone(),
                    content,
                    source: FileContextSource::InternReadFile,
                });
            }
            Err(e) => {
                warn!(path = %file_path, error = %e, "Failed to read file context, skipping");
            }
        }
    }

    // 3. Get forward dependencies for scope
    let dependencies = if let Some(scope) = &work_order.scope {
        let abs_scope = resolve_path(scope, working_dir);
        call_file_dependencies(mcp, &abs_scope, "forward").await.ok()
    } else {
        None
    };

    // 4. For refactor/fix tasks, get reverse dependencies (who imports these files?)
    //    This ensures the model knows about all consumers it might break.
    if matches!(work_order.task, crate::wo::TaskType::Refactor | crate::wo::TaskType::Fix) {
        for file_path in &all_files {
            let abs_path = resolve_path(file_path, working_dir);
            match call_file_dependencies(mcp, &abs_path, "reverse").await {
                Ok(reverse_deps) => {
                    // Parse the reverse deps response to find consumer file paths,
                    // then read each one for context
                    let consumer_paths = extract_file_paths_from_deps(&reverse_deps);
                    for consumer in consumer_paths {
                        // Skip if we already have this file
                        if file_contents.iter().any(|fc| consumer.ends_with(&fc.path) || fc.path.ends_with(&consumer)) {
                            continue;
                        }
                        let abs_consumer = if consumer.starts_with('/') {
                            consumer.clone()
                        } else {
                            resolve_path(&consumer, working_dir)
                        };
                        match call_intern_read_file(mcp, &abs_consumer, &work_order.description).await {
                            Ok(content) => {
                                // Use relative path for display
                                let rel_path = consumer.strip_prefix(&format!("{}/", working_dir.display()))
                                    .unwrap_or(&consumer);
                                info!(path = %rel_path, "Added reverse dependency to context");
                                file_contents.push(FileContext {
                                    path: rel_path.to_string(),
                                    content,
                                    source: FileContextSource::AgentBrief,
                                });
                            }
                            Err(e) => {
                                debug!(path = %consumer, error = %e, "Failed to read reverse dep, skipping");
                            }
                        }
                    }
                }
                Err(e) => {
                    debug!(path = %file_path, error = %e, "Failed to get reverse deps, skipping");
                }
            }
        }
    }

    let ctx = AssembledContext {
        agent_brief,
        file_contents,
        dependencies,
    };

    info!(
        wo_id = %work_order.id,
        files = ctx.file_contents.len(),
        has_brief = ctx.agent_brief.is_some(),
        has_deps = ctx.dependencies.is_some(),
        "Context assembly complete"
    );

    Ok(ctx)
}

/// Format assembled context into a string for the agent's initial message.
pub fn format_context(ctx: &AssembledContext) -> String {
    let mut parts = Vec::new();

    if let Some(brief) = &ctx.agent_brief {
        parts.push(format!("## Agent Brief\n\n{brief}"));
    }

    if !ctx.file_contents.is_empty() {
        parts.push("## File Contents\n".to_string());
        for fc in &ctx.file_contents {
            parts.push(format!(
                "### `{}`\n\n```\n{}\n```\n",
                fc.path, fc.content
            ));
        }
    }

    if let Some(deps) = &ctx.dependencies {
        parts.push(format!("## Dependencies\n\n{deps}"));
    }

    parts.join("\n")
}

// ── File reading ────────────────────────────────────────────────────────────

/// Read a file's full content from disk (for refactor tasks where the model needs everything).
async fn read_full_file(path: &str) -> Result<String> {
    tokio::fs::read_to_string(path)
        .await
        .with_context(|| format!("failed to read file '{path}'"))
}

// ── MCP tool calls ──────────────────────────────────────────────────────────

/// Call intern_context to get a structured agent brief.
async fn call_intern_context(mcp: &McpClient, wo: &WorkOrder) -> Option<String> {
    let args = serde_json::json!({
        "task": wo.description,
        "agent_type": "work-order-implementor",
    });

    let call = crate::mcp_client::McpToolCall {
        name: "intern_context".to_string(),
        arguments: args,
    };

    match mcp.call_tool(&call).await {
        Ok(result) if !result.is_error => {
            let text = extract_text(&result);
            debug!(len = text.len(), "intern_context returned brief");
            Some(text)
        }
        Ok(result) => {
            warn!("intern_context returned error: {}", extract_text(&result));
            None
        }
        Err(e) => {
            warn!(error = %e, "intern_context call failed");
            None
        }
    }
}

/// Call intern_read_file with focus derived from the WO description.
async fn call_intern_read_file(mcp: &McpClient, path: &str, description: &str) -> Result<String> {
    // Use first 100 chars of description as focus hint
    let focus = if description.len() > 100 {
        let mut end = 100;
        while end > 0 && !description.is_char_boundary(end) {
            end -= 1;
        }
        &description[..end]
    } else {
        description
    };

    let args = serde_json::json!({
        "path": path,
        "focus": focus,
        "context": description,
    });

    let call = crate::mcp_client::McpToolCall {
        name: "intern_read_file".to_string(),
        arguments: args,
    };

    let result = mcp
        .call_tool(&call)
        .await
        .with_context(|| format!("intern_read_file failed for {path}"))?;

    if result.is_error {
        anyhow::bail!("intern_read_file error: {}", extract_text(&result));
    }

    Ok(extract_text(&result))
}

/// Call file_dependencies for a path in the given direction.
async fn call_file_dependencies(mcp: &McpClient, path: &str, direction: &str) -> Result<String> {
    let args = serde_json::json!({
        "path": path,
        "depth": 1,
        "direction": direction,
    });

    let call = crate::mcp_client::McpToolCall {
        name: "file_dependencies".to_string(),
        arguments: args,
    };

    let result = mcp
        .call_tool(&call)
        .await
        .with_context(|| format!("file_dependencies failed for {path}"))?;

    if result.is_error {
        anyhow::bail!("file_dependencies error: {}", extract_text(&result));
    }

    Ok(extract_text(&result))
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/// Extract file paths from a file_dependencies response.
///
/// The MCP tool returns markdown like:
/// ```text
/// **Depth 1** (3 file(s)):
/// - /home/user/project/src/file.ts
/// - /home/user/project/src/other.ts
/// ```
///
/// We scan each line for path-like strings.
fn extract_file_paths_from_deps(deps_text: &str) -> Vec<String> {
    let mut paths = Vec::new();

    for line in deps_text.lines() {
        let trimmed = line.trim().trim_start_matches('-').trim();
        if looks_like_path(trimmed) {
            paths.push(trimmed.to_string());
        }
    }

    paths
}

/// Check if a string looks like a file path.
fn looks_like_path(s: &str) -> bool {
    s.contains('/')
        && !s.contains(' ')
        && (s.ends_with(".ts")
            || s.ends_with(".tsx")
            || s.ends_with(".js")
            || s.ends_with(".jsx")
            || s.ends_with(".rs")
            || s.ends_with(".py"))
}

/// Collect all file paths from the work order (input + interface + reference).
fn collect_file_paths(wo: &WorkOrder) -> Vec<String> {
    let mut paths = Vec::new();
    // Interface files first (contracts to implement against)
    paths.extend(wo.interface_files.iter().cloned());
    // Then reference files (patterns to follow)
    paths.extend(wo.reference_files.iter().cloned());
    // Then input files (files to read/modify)
    paths.extend(wo.input_files.iter().cloned());
    // Deduplicate while preserving order
    let mut seen = std::collections::HashSet::new();
    paths.retain(|p| seen.insert(p.clone()));
    paths
}

/// Resolve a potentially relative path to absolute using working_dir.
fn resolve_path(path: &str, working_dir: &Path) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else {
        working_dir.join(path).to_string_lossy().into_owned()
    }
}

/// Extract text from an MCP tool result.
fn extract_text(result: &crate::mcp_client::McpToolResult) -> String {
    result
        .content
        .iter()
        .map(|c| match c {
            crate::mcp_client::McpContent::Text { text } => text.as_str(),
        })
        .collect::<Vec<_>>()
        .join("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_collect_file_paths_deduplicates() {
        let wo = crate::wo::WorkOrder {
            interface_files: vec!["src/types.ts".into()],
            reference_files: vec!["src/utils.ts".into()],
            input_files: vec!["src/types.ts".into(), "src/main.ts".into()],
            ..default_wo()
        };
        let paths = collect_file_paths(&wo);
        assert_eq!(paths, vec!["src/types.ts", "src/utils.ts", "src/main.ts"]);
    }

    #[test]
    fn test_collect_file_paths_empty() {
        let wo = default_wo();
        let paths = collect_file_paths(&wo);
        assert!(paths.is_empty());
    }

    #[test]
    fn test_resolve_path_absolute() {
        let result = resolve_path("/abs/path.ts", Path::new("/project"));
        assert_eq!(result, "/abs/path.ts");
    }

    #[test]
    fn test_resolve_path_relative() {
        let result = resolve_path("src/main.ts", Path::new("/project"));
        assert_eq!(result, "/project/src/main.ts");
    }

    #[test]
    fn test_format_context_empty() {
        let ctx = AssembledContext {
            agent_brief: None,
            file_contents: vec![],
            dependencies: None,
        };
        let formatted = format_context(&ctx);
        assert!(formatted.is_empty());
    }

    #[test]
    fn test_format_context_with_brief_and_files() {
        let ctx = AssembledContext {
            agent_brief: Some("Do the thing".into()),
            file_contents: vec![FileContext {
                path: "src/main.ts".into(),
                content: "const x = 1;".into(),
                source: FileContextSource::InternReadFile,
            }],
            dependencies: None,
        };
        let formatted = format_context(&ctx);
        assert!(formatted.contains("Agent Brief"));
        assert!(formatted.contains("Do the thing"));
        assert!(formatted.contains("src/main.ts"));
        assert!(formatted.contains("const x = 1;"));
    }

    fn default_wo() -> crate::wo::WorkOrder {
        serde_yaml::from_str(
            r#"
id: TEST-001
group_id: test-group
title: test
description: test
task: implement
interface_files: []
reference_files: []
input_files: []
depends_on: []
"#,
        )
        .unwrap()
    }
}
