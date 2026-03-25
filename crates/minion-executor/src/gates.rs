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
use tracing::{info, warn};

use crate::config::GateCommands;
use crate::diff::StructuredDiff;
use crate::wo::WorkOrder;

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
    gate_commands: &GateCommands,
    timeout_secs: u64,
) -> Result<GateResults> {
    info!(
        wo_id = %work_order.id,
        diff_count = diffs.len(),
        "Applying diffs and running gates"
    );

    // Apply diffs to disk
    if !diffs.is_empty() {
        crate::diff::apply_diffs(diffs, working_dir).context("Failed to apply diffs to disk")?;
        info!(count = diffs.len(), "Diffs applied to disk");
    }

    run_gates_in_place(work_order, working_dir, gate_commands, timeout_secs).await
}

/// Run gates on an already-modified working tree (no diff application needed).
/// Used by CodexExecutor where files are edited in-place by the Codex CLI.
pub async fn run_gates_in_place(
    work_order: &WorkOrder,
    working_dir: &Path,
    gate_commands: &GateCommands,
    timeout_secs: u64,
) -> Result<GateResults> {
    info!(wo_id = %work_order.id, "Running gates on working tree");

    let gates = &work_order.gates;
    let timeout = Duration::from_secs(timeout_secs);
    let mut results = Vec::new();

    // Run gates in order: typecheck → lint → tests
    // Each gate only runs if the previous ones passed (fail-fast).
    if gates.compile {
        let r = run_gate("typecheck", &gate_commands.typecheck, working_dir, timeout).await;
        let passed = r.passed;
        results.push(r);
        if !passed {
            return Ok(build_gate_results(results));
        }
    }

    if gates.lint {
        let r = run_gate("lint", &gate_commands.lint, working_dir, timeout).await;
        let passed = r.passed;
        results.push(r);
        if !passed {
            return Ok(build_gate_results(results));
        }
    }

    if gates.tests.run {
        let test_cmd = build_test_command(
            &gate_commands.test,
            &gates.tests.scope,
            &gates.tests.specific,
        );
        let r = run_gate("test", &test_cmd, working_dir, timeout).await;
        results.push(r);
    }

    Ok(build_gate_results(results))
}

/// Revert diffs from disk using git checkout for tracked files
/// and rm for newly created (untracked) files.
pub fn revert_diffs(diffs: &[StructuredDiff], working_dir: &Path) {
    let mut tracked_files: Vec<String> = Vec::new();
    let mut created_files: Vec<std::path::PathBuf> = Vec::new();

    for diff in diffs {
        match &diff.action {
            crate::diff::DiffAction::Create => {
                created_files.push(working_dir.join(&diff.file));
            }
            _ => {
                tracked_files.push(diff.file.clone());
            }
        }
    }

    // Revert tracked files via git checkout
    if !tracked_files.is_empty() {
        let mut cmd = std::process::Command::new("git");
        cmd.arg("checkout").arg("--").current_dir(working_dir);
        for f in &tracked_files {
            cmd.arg(f);
        }
        match cmd.output() {
            Ok(output) if output.status.success() => {
                info!(
                    count = tracked_files.len(),
                    "Reverted tracked files via git checkout"
                );
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                warn!(error = %stderr, "git checkout failed, falling back to best-effort");
            }
            Err(e) => {
                warn!(error = %e, "Failed to run git checkout");
            }
        }
    }

    // Remove newly created (untracked) files
    for path in &created_files {
        if let Err(e) = std::fs::remove_file(path) {
            warn!(path = %path.display(), error = %e, "Failed to remove created file");
        }
    }

    if !created_files.is_empty() {
        info!(count = created_files.len(), "Removed created files");
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

/// Build the test command from the template and WO gates config.
///
/// The template uses `{scope}` as a placeholder, e.g. "bun test {scope}".
fn build_test_command(template: &str, scope: &str, specific: &[String]) -> String {
    if !specific.is_empty() {
        let files = specific.join(" ");
        template.replace("{scope}", &files)
    } else {
        match scope {
            "all" | "relevant" => template.replace("{scope}", "").trim().to_string(),
            other => template.replace("{scope}", other),
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
        let cmd = build_test_command(
            "bun test {scope}",
            "relevant",
            &["src/test1.ts".into(), "src/test2.ts".into()],
        );
        assert_eq!(cmd, "bun test src/test1.ts src/test2.ts");
    }

    #[test]
    fn test_build_test_command_all() {
        let cmd = build_test_command("bun test {scope}", "all", &[]);
        assert_eq!(cmd, "bun test");
    }

    #[test]
    fn test_build_test_command_scope() {
        let cmd = build_test_command("bun test {scope}", "src/shared/", &[]);
        assert_eq!(cmd, "bun test src/shared/");
    }

    #[test]
    fn test_build_gate_results_all_pass() {
        let results = vec![
            GateResult {
                name: "typecheck".into(),
                passed: true,
                output: "ok".into(),
            },
            GateResult {
                name: "lint".into(),
                passed: true,
                output: "ok".into(),
            },
        ];
        let gr = build_gate_results(results);
        assert!(gr.all_passed);
        assert!(gr.error_context.is_none());
    }

    #[test]
    fn test_build_gate_results_one_fails() {
        let results = vec![
            GateResult {
                name: "typecheck".into(),
                passed: true,
                output: "ok".into(),
            },
            GateResult {
                name: "lint".into(),
                passed: false,
                output: "error: unused var".into(),
            },
        ];
        let gr = build_gate_results(results);
        assert!(!gr.all_passed);
        assert!(gr.error_context.as_ref().unwrap().contains("lint FAILED"));
        assert!(gr.error_context.as_ref().unwrap().contains("unused var"));
    }

    #[tokio::test]
    async fn test_run_gate_success() {
        let r = run_gate(
            "test",
            "echo hello",
            Path::new("/tmp"),
            Duration::from_secs(5),
        )
        .await;
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
        let r = run_gate(
            "test",
            "sleep 10",
            Path::new("/tmp"),
            Duration::from_millis(100),
        )
        .await;
        assert!(!r.passed);
        assert!(r.output.contains("timed out"));
    }
}
