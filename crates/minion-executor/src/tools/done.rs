//! The done tool: signals that the agent has completed its work.
//!
//! When the agent calls this tool, the executor loop terminates and
//! collects all accumulated diffs as the result.

use anyhow::Result;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::tools::{Tool, ToolOutput};

/// Tool that signals agent completion.
pub struct DoneTool {
    /// Shared flag that the executor checks to know when to stop.
    done_flag: Arc<AtomicBool>,
    /// Shared slot for a contract violation reason, if the agent signals one.
    contract_violation: Arc<Mutex<Option<String>>>,
}

impl DoneTool {
    /// Create a new done tool with a shared completion flag and contract violation slot.
    pub fn new(done_flag: Arc<AtomicBool>, contract_violation: Arc<Mutex<Option<String>>>) -> Self {
        Self {
            done_flag,
            contract_violation,
        }
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
                },
                "contract_violation": {
                    "type": "string",
                    "description": "Signal that the interface contract is insufficient. Provide the reason. This skips retries and escalates directly."
                }
            },
            "required": ["summary"]
        })
    }

    async fn execute(&self, input: serde_json::Value) -> Result<ToolOutput> {
        let summary = input["summary"].as_str().unwrap_or("Task completed");

        // If the agent flagged a contract violation, store it before setting done.
        if let Some(reason) = input["contract_violation"].as_str() {
            if !reason.is_empty() {
                if let Ok(mut guard) = self.contract_violation.lock() {
                    *guard = Some(reason.to_string());
                }
            }
        }

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
        let cv = Arc::new(Mutex::new(None));
        let tool = DoneTool::new(flag.clone(), cv.clone());

        let input = serde_json::json!({ "summary": "Implemented health check" });
        let result = tool.execute(input).await.unwrap();

        assert!(!result.is_error);
        assert!(flag.load(Ordering::SeqCst));
        assert!(cv.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn test_done_stores_contract_violation() {
        let flag = Arc::new(AtomicBool::new(false));
        let cv = Arc::new(Mutex::new(None));
        let tool = DoneTool::new(flag.clone(), cv.clone());

        let input = serde_json::json!({
            "summary": "Cannot complete",
            "contract_violation": "Missing return type in interface for getUser"
        });
        let result = tool.execute(input).await.unwrap();

        assert!(!result.is_error);
        assert!(flag.load(Ordering::SeqCst));
        assert_eq!(
            cv.lock().unwrap().as_deref(),
            Some("Missing return type in interface for getUser")
        );
    }
}
