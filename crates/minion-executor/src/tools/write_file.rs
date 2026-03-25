//! The write_file tool: produces structured diffs for file modifications.
//!
//! The agent calls this tool to declare changes. Changes are collected as
//! structured diffs and applied after the agent loop completes.

use anyhow::Result;
use std::sync::{Arc, Mutex};

use crate::diff::{DiffAction, StructuredDiff};
use crate::tools::{Tool, ToolOutput};

/// Tool that collects structured diffs from the agent.
pub struct WriteFileTool {
    /// Collected diffs (shared with executor for retrieval).
    diffs: Arc<Mutex<Vec<StructuredDiff>>>,
}

impl WriteFileTool {
    /// Create a new write_file tool with a shared diff collector.
    pub fn new(diffs: Arc<Mutex<Vec<StructuredDiff>>>) -> Self {
        Self { diffs }
    }

    /// Get a clone of the shared diff collector for the executor to read.
    pub fn diff_collector(&self) -> Arc<Mutex<Vec<StructuredDiff>>> {
        self.diffs.clone()
    }
}

#[async_trait::async_trait]
impl Tool for WriteFileTool {
    fn name(&self) -> &str {
        "write_file"
    }

    fn description(&self) -> &str {
        "Write or modify a file using structured diffs. For new files use action 'create' with full content. For modifications use 'replace', 'insert_after', or 'delete' with an anchor string."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "file": {
                    "type": "string",
                    "description": "Path to the file (relative to project root)"
                },
                "action": {
                    "type": "string",
                    "enum": ["create", "replace", "insert_after", "delete"],
                    "description": "The type of edit operation"
                },
                "anchor": {
                    "type": "string",
                    "description": "Unique string to locate the edit position (not needed for create)"
                },
                "content": {
                    "type": "string",
                    "description": "The new content (not needed for delete)"
                }
            },
            "required": ["file", "action"]
        })
    }

    async fn execute(&self, input: serde_json::Value) -> Result<ToolOutput> {
        // TODO: Implement write_file tool execution.
        //   1. Deserialize input into StructuredDiff
        //   2. Validate the diff
        //   3. Append to the shared diff collector
        //   4. Return confirmation message

        let file = input["file"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing 'file' field"))?;
        let action_str = input["action"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("missing 'action' field"))?;

        let action: DiffAction = serde_json::from_value(serde_json::json!(action_str))?;
        let anchor = input["anchor"].as_str().map(|s| s.to_string());
        let content = input["content"].as_str().map(|s| s.to_string());

        let diff = StructuredDiff {
            file: file.to_string(),
            action,
            anchor,
            content,
        };

        diff.validate()?;

        self.diffs
            .lock()
            .map_err(|e| anyhow::anyhow!("lock poisoned: {e}"))?
            .push(diff);

        Ok(ToolOutput::success(format!(
            "Recorded {action_str} for {file}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_write_file_create() {
        let diffs = Arc::new(Mutex::new(Vec::new()));
        let tool = WriteFileTool::new(diffs.clone());

        let input = serde_json::json!({
            "file": "src/new.rs",
            "action": "create",
            "content": "fn main() {}"
        });

        let result = tool.execute(input).await.unwrap();
        assert!(!result.is_error);
        assert_eq!(diffs.lock().unwrap().len(), 1);
    }
}
