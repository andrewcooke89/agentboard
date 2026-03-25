//! Work order schema types and deserialization from YAML.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;

/// A work order describing a single unit of work for the executor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkOrder {
    /// Unique identifier (e.g. "WO-001").
    pub id: String,

    /// Group this work order belongs to (e.g. "feat-health-check").
    pub group_id: String,

    /// Short human-readable title.
    pub title: String,

    /// Full description of what to implement/fix/test.
    pub description: String,

    /// Type of task to perform.
    pub task: TaskType,

    /// Directory scope for changes.
    #[serde(default)]
    pub scope: Option<String>,

    /// Committed interface files (type stubs, trait defs, function signatures).
    #[serde(default)]
    pub interface_files: Vec<String>,

    /// Reference files (e.g. golden example for refactors).
    #[serde(default)]
    pub reference_files: Vec<String>,

    /// Existing code the agent needs to read.
    #[serde(default)]
    pub input_files: Vec<String>,

    /// Configuration for intern-based context assembly.
    #[serde(default)]
    pub intern_context: InternContext,

    /// Dynamic context from other work orders.
    #[serde(default)]
    pub dynamic_context: Vec<DynamicContextRef>,

    /// Work order IDs that must complete before this one.
    #[serde(default)]
    pub depends_on: Vec<String>,

    /// Soft ordering preference (not a hard dependency).
    #[serde(default)]
    pub prefer_after: Vec<String>,

    /// Quality gates to run after execution.
    #[serde(default)]
    pub gates: Gates,

    /// Execution parameters.
    #[serde(default)]
    pub execution: Execution,

    /// Escalation rules on failure.
    #[serde(default)]
    pub escalation: Escalation,

    /// Isolation strategy.
    #[serde(default)]
    pub isolation: Isolation,

    /// Output configuration.
    #[serde(default)]
    pub output: Output,
}

impl WorkOrder {
    /// Load a work order from a YAML file on disk.
    pub fn from_file(path: &Path) -> Result<Self> {
        let contents = std::fs::read_to_string(path)?;
        let wo: Self = serde_yaml::from_str(&contents)?;
        Ok(wo)
    }

    /// Load a work order from any reader (e.g. stdin).
    pub fn from_reader<R: Read>(mut reader: R) -> Result<Self> {
        let mut contents = String::new();
        reader.read_to_string(&mut contents)?;
        let wo: Self = serde_yaml::from_str(&contents)?;
        Ok(wo)
    }
}

/// The type of task to perform.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskType {
    Implement,
    Test,
    Fix,
    Refactor,
    Review,
}

/// Configuration for intern-based context assembly.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct InternContext {
    /// Whether to use intern tools for context discovery.
    #[serde(default)]
    pub enabled: bool,

    /// How deep to follow references.
    #[serde(default = "default_search_depth")]
    pub search_depth: u32,

    /// Which intern tools to use for context assembly.
    #[serde(default)]
    pub tools: Vec<String>,
}

fn default_search_depth() -> u32 {
    1
}

/// Reference to dynamic context from another work order's output.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DynamicContextRef {
    /// The work order ID to pull context from.
    pub from_wo: String,

    /// Transform to apply (e.g. "strip_assertions").
    #[serde(default)]
    pub transform: Option<String>,
}

/// Quality gates configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Gates {
    /// Whether to run compile check.
    #[serde(default = "default_true")]
    pub compile: bool,

    /// Whether to run linter.
    #[serde(default = "default_true")]
    pub lint: bool,

    /// Whether to run type checker.
    #[serde(default = "default_true")]
    pub typecheck: bool,

    /// Test configuration.
    #[serde(default)]
    pub tests: TestGate,
}

impl Default for Gates {
    fn default() -> Self {
        Self {
            compile: true,
            lint: true,
            typecheck: true,
            tests: TestGate::default(),
        }
    }
}

/// Test gate configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestGate {
    /// Whether to run tests.
    #[serde(default = "default_true")]
    pub run: bool,

    /// Scope of tests to run: "all", "relevant", "specific".
    #[serde(default = "default_test_scope")]
    pub scope: String,

    /// Specific test files or patterns to run.
    #[serde(default)]
    pub specific: Vec<String>,

    /// Expected outcome: "pass" or "fail".
    #[serde(default = "default_expect")]
    pub expect: String,
}

impl Default for TestGate {
    fn default() -> Self {
        Self {
            run: true,
            scope: "relevant".to_string(),
            specific: Vec::new(),
            expect: "pass".to_string(),
        }
    }
}

/// Execution parameters for the work order.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Execution {
    /// Execution mode: "attended" or "unattended".
    #[serde(default = "default_mode")]
    pub mode: String,

    /// Model to use (e.g. "glm", "claude-sonnet-4-20250514").
    #[serde(default = "default_model")]
    pub model: String,

    /// Maximum retries before escalation.
    #[serde(default = "default_retries")]
    pub max_retries: u32,

    /// Hard timeout in minutes.
    #[serde(default = "default_timeout")]
    pub timeout_minutes: u32,
}

impl Default for Execution {
    fn default() -> Self {
        Self {
            mode: "unattended".to_string(),
            model: "glm".to_string(),
            max_retries: 2,
            timeout_minutes: 15,
        }
    }
}

/// Escalation rules when execution fails.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Escalation {
    /// Whether escalation is enabled.
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Number of retries before escalating.
    #[serde(default = "default_retries")]
    pub after_retries: u32,

    /// Model to escalate to.
    #[serde(default = "default_escalation_model")]
    pub to: String,

    /// Escalation mode: "attended" or "unattended".
    #[serde(default = "default_attended")]
    pub mode: String,

    /// Whether to include error context from failed attempts.
    #[serde(default = "default_true")]
    pub include_error_context: bool,
}

impl Default for Escalation {
    fn default() -> Self {
        Self {
            enabled: true,
            after_retries: 2,
            to: "opus".to_string(),
            mode: "attended".to_string(),
            include_error_context: true,
        }
    }
}

/// Isolation strategy for the work order.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Isolation {
    /// Isolation type: "worktree", "branch", "none".
    #[serde(default = "default_isolation_type", rename = "type")]
    pub isolation_type: String,

    /// Base ref for the worktree/branch.
    #[serde(default = "default_base")]
    pub base: String,
}

impl Default for Isolation {
    fn default() -> Self {
        Self {
            isolation_type: "worktree".to_string(),
            base: "HEAD".to_string(),
        }
    }
}

/// Output configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Output {
    /// Whether to auto-commit on success.
    #[serde(default = "default_true")]
    pub commit: bool,

    /// Commit message prefix (e.g. "feat", "fix").
    #[serde(default = "default_commit_prefix")]
    pub commit_prefix: String,
}

impl Default for Output {
    fn default() -> Self {
        Self {
            commit: true,
            commit_prefix: "feat".to_string(),
        }
    }
}

fn default_true() -> bool {
    true
}
fn default_test_scope() -> String {
    "relevant".to_string()
}
fn default_expect() -> String {
    "pass".to_string()
}
fn default_mode() -> String {
    "unattended".to_string()
}
fn default_model() -> String {
    "glm".to_string()
}
fn default_retries() -> u32 {
    2
}
fn default_timeout() -> u32 {
    15
}
fn default_escalation_model() -> String {
    "opus".to_string()
}
fn default_attended() -> String {
    "attended".to_string()
}
fn default_isolation_type() -> String {
    "worktree".to_string()
}
fn default_base() -> String {
    "HEAD".to_string()
}
fn default_commit_prefix() -> String {
    "feat".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deserialize_minimal_wo() {
        let yaml = r#"
id: WO-001
group_id: test-group
title: "Test work order"
description: "A test"
task: implement
"#;
        let wo: WorkOrder = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(wo.id, "WO-001");
        assert_eq!(wo.task, TaskType::Implement);
        assert!(wo.depends_on.is_empty());
        assert!(wo.gates.compile);
    }

    #[test]
    fn test_deserialize_full_wo() {
        let yaml = r#"
id: WO-002
group_id: feat-health
title: "Implement health check"
description: "Implement GET /health"
task: fix
scope: src/server/
interface_files:
  - src/server/health.ts
input_files:
  - src/server/index.ts
depends_on:
  - WO-001
gates:
  compile: true
  tests:
    run: true
    scope: specific
    specific:
      - tests/health.test.ts
    expect: pass
execution:
  model: claude-sonnet-4-20250514
  max_retries: 3
"#;
        let wo: WorkOrder = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(wo.task, TaskType::Fix);
        assert_eq!(wo.depends_on, vec!["WO-001"]);
        assert_eq!(wo.execution.model, "claude-sonnet-4-20250514");
    }
}
