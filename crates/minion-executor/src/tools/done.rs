//! The done tool: signals that the agent has completed its work.
//!
//! When the agent calls this tool, the executor loop terminates and
//! collects all accumulated diffs as the result.

use anyhow::Result;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::tools::{Tool, ToolOutput};

/// Tool that signals agent completion.
pub struct DoneTool {
    /// Shared flag that the executor checks to know when to stop.
    done_flag: Arc<AtomicBool>,
}

impl DoneTool {
    /// Create a new done tool with a shared completion flag.
    pub fn new(done_flag: Arc<AtomicBool>) -> Self {
        Self { done_flag }
    }

    /// Get a clone of the shared done flag for the executor to check.
    pub fn done_flag(&self) -> Arc<AtomicBool> {
        self.done_flag.clone()
    }
}

#[async_trait::async_trait]
impl Tool for DoneTool {
    fn name(&self) -> &str {
        "done"
    }

    fn description(&self) -> &str {
        "Signal that you have completed the task. Call this when all changes have been written."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "summary": {
                    "type": "string",
                    "description": "Brief summary of what was accomplished"
                }
            },
            "required": ["summary"]
        })
    }

    async fn execute(&self, input: serde_json::Value) -> Result<ToolOutput> {
        let summary = input["summary"]
            .as_str()
            .unwrap_or("Task completed");

        self.done_flag.store(true, Ordering::SeqCst);

        Ok(ToolOutput::success(format!(
            "Execution complete: {summary}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_done_sets_flag() {
        let flag = Arc::new(AtomicBool::new(false));
        let tool = DoneTool::new(flag.clone());

        let input = serde_json::json!({ "summary": "Implemented health check" });
        let result = tool.execute(input).await.unwrap();

        assert!(!result.is_error);
        assert!(flag.load(Ordering::SeqCst));
    }
}
