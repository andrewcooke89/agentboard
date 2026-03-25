//! Deterministic gate runner for post-agent validation.
//!
//! After the agent produces diffs, gates run compile/lint/typecheck/test
//! checks against the actual codebase. Results determine whether to accept,
//! retry, or escalate.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context as _, Result};
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tracing::{debug, info, warn};

use crate::diff::StructuredDiff;
use crate::wo::{Gates, WorkOrder};

/// Result of running all gates.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GateResults {
    /// Whether all enabled gates passed.
    pub all_passed: bool,

    /// Individual gate results.
    pub gates: Vec<GateResult>,

    /// Combined error output for retry context.
    pub error_context: Option<String>,
}

/// Result of a single gate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GateResult {
    /// Gate name (compile, lint, typecheck, test).
    pub name: String,

    /// Whether this gate passed.
    pub passed: bool,

    /// Gate output (stdout + stderr), truncated.
    pub output: String,
}

/// Apply diffs to disk and run all enabled gates from the work order.
///
/// Returns gate results. If any gate fails, `error_context` contains
/// the combined error output suitable for feeding back to the agent.
pub async fn run_gates(
    work_order: &WorkOrder,
    diffs: &[StructuredDiff],
    working_dir: &Path,
    timeout_secs: u64,
) -> Result<GateResults> {
    info!(
        wo_id = %work_order.id,
        diff_count = diffs.len(),
        "Applying diffs and running gates"
    );

    // Apply diffs to disk
    if !diffs.is_empty() {
        crate::diff::apply_diffs(diffs, working_dir)
            .context("Failed to apply diffs to disk")?;
        info!(count = diffs.len(), "Diffs applied to disk");
    }

    let gates = &work_order.gates;
    let timeout = Duration::from_secs(timeout_secs);
    let mut results = Vec::new();

    // Run gates in order: typecheck → lint → tests
    // Each gate only runs if the previous ones passed (fail-fast).
    if gates.compile {
        let r = run_gate("typecheck", "bun run typecheck", working_dir, timeout).await;
        let passed = r.passed;
        results.push(r);
        if !passed {
            return Ok(build_gate_results(results));
        }
    }

    if gates.lint {
        let r = run_gate("lint", "bun run lint", working_dir, timeout).await;
        let passed = r.passed;
        results.push(r);
        if !passed {
            return Ok(build_gate_results(results));
        }
    }

    if gates.tests.run {
        let test_cmd = build_test_command(&gates.tests.scope, &gates.tests.specific);
        let r = run_gate("test", &test_cmd, working_dir, timeout).await;
        results.push(r);
    }

    Ok(build_gate_results(results))
}

/// Revert diffs from disk (best-effort, for retry cleanup).
pub fn revert_diffs(diffs: &[StructuredDiff], working_dir: &Path) {
    for diff in diffs {
        let file_path = working_dir.join(&diff.file);
        match &diff.action {
            crate::diff::DiffAction::Create => {
                // Remove created files
                if let Err(e) = std::fs::remove_file(&file_path) {
                    warn!(path = %file_path.display(), error = %e, "Failed to revert created file");
                }
            }
            _ => {
                // For replace/insert_after/delete, we'd need the original content.
                // For now, log a warning — full git-based revert comes in Phase 2.
                debug!(path = %file_path.display(), "Cannot revert non-create diff without original content");
            }
        }
    }
}

// ── Internals ───────────────────────────────────────────────────────────────

/// Run a single gate command and return the result.
async fn run_gate(name: &str, command: &str, working_dir: &Path, timeout: Duration) -> GateResult {
    info!(gate = name, command = command, "Running gate");

    let result = tokio::time::timeout(timeout, async {
        Command::new("sh")
            .arg("-c")
            .arg(command)
            .current_dir(working_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .await
    })
    .await;

    match result {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let combined = if stderr.is_empty() {
                stdout.into_owned()
            } else {
                format!("{stdout}\n{stderr}")
            };

            // Truncate at char boundary
            const MAX_OUTPUT: usize = 8000;
            let truncated = if combined.len() > MAX_OUTPUT {
                let mut end = MAX_OUTPUT;
                while end > 0 && !combined.is_char_boundary(end) {
                    end -= 1;
                }
                format!("{}... [truncated]", &combined[..end])
            } else {
                combined
            };

            let passed = output.status.success();
            info!(gate = name, passed = passed, "Gate complete");

            GateResult {
                name: name.to_string(),
                passed,
                output: truncated,
            }
        }
        Ok(Err(e)) => {
            warn!(gate = name, error = %e, "Gate command failed to execute");
            GateResult {
                name: name.to_string(),
                passed: false,
                output: format!("Failed to execute: {e}"),
            }
        }
        Err(_) => {
            warn!(gate = name, "Gate timed out");
            GateResult {
                name: name.to_string(),
                passed: false,
                output: format!("Gate timed out after {}s", timeout.as_secs()),
            }
        }
    }
}

/// Build the test command from WO gates config.
fn build_test_command(scope: &str, specific: &[String]) -> String {
    if !specific.is_empty() {
        // Run specific test files
        let files = specific.join(" ");
        format!("bun test {files}")
    } else {
        match scope {
            "all" => "bun test".to_string(),
            "relevant" => "bun test".to_string(), // TODO: scope to changed files
            other => format!("bun test {other}"),
        }
    }
}

/// Build GateResults from individual results.
fn build_gate_results(results: Vec<GateResult>) -> GateResults {
    let all_passed = results.iter().all(|r| r.passed);

    let error_context = if all_passed {
        None
    } else {
        let errors: Vec<String> = results
            .iter()
            .filter(|r| !r.passed)
            .map(|r| format!("## {} FAILED\n\n{}", r.name, r.output))
            .collect();
        Some(errors.join("\n\n"))
    };

    GateResults {
        all_passed,
        gates: results,
        error_context,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_test_command_specific() {
        let cmd = build_test_command("relevant", &["src/test1.ts".into(), "src/test2.ts".into()]);
        assert_eq!(cmd, "bun test src/test1.ts src/test2.ts");
    }

    #[test]
    fn test_build_test_command_all() {
        let cmd = build_test_command("all", &[]);
        assert_eq!(cmd, "bun test");
    }

    #[test]
    fn test_build_test_command_scope() {
        let cmd = build_test_command("src/shared/", &[]);
        assert_eq!(cmd, "bun test src/shared/");
    }

    #[test]
    fn test_build_gate_results_all_pass() {
        let results = vec![
            GateResult { name: "typecheck".into(), passed: true, output: "ok".into() },
            GateResult { name: "lint".into(), passed: true, output: "ok".into() },
        ];
        let gr = build_gate_results(results);
        assert!(gr.all_passed);
        assert!(gr.error_context.is_none());
    }

    #[test]
    fn test_build_gate_results_one_fails() {
        let results = vec![
            GateResult { name: "typecheck".into(), passed: true, output: "ok".into() },
            GateResult { name: "lint".into(), passed: false, output: "error: unused var".into() },
        ];
        let gr = build_gate_results(results);
        assert!(!gr.all_passed);
        assert!(gr.error_context.as_ref().unwrap().contains("lint FAILED"));
        assert!(gr.error_context.as_ref().unwrap().contains("unused var"));
    }

    #[tokio::test]
    async fn test_run_gate_success() {
        let r = run_gate("test", "echo hello", Path::new("/tmp"), Duration::from_secs(5)).await;
        assert!(r.passed);
        assert!(r.output.contains("hello"));
    }

    #[tokio::test]
    async fn test_run_gate_failure() {
        let r = run_gate("test", "exit 1", Path::new("/tmp"), Duration::from_secs(5)).await;
        assert!(!r.passed);
    }

    #[tokio::test]
    async fn test_run_gate_timeout() {
        let r = run_gate("test", "sleep 10", Path::new("/tmp"), Duration::from_millis(100)).await;
        assert!(!r.passed);
        assert!(r.output.contains("timed out"));
    }
}
