//! Read file tool — allows the agent to read files from the working directory.
//!
//! This is a backup tool for when the pre-assembled context doesn't include
//! a file the agent needs. The agent's primary context should already contain
//! the target file(s), but this handles edge cases.

use std::path::PathBuf;

use tracing::info;

use super::{Tool, ToolOutput};

pub struct ReadFileTool {
    working_dir: PathBuf,
}

impl ReadFileTool {
    pub fn new(working_dir: PathBuf) -> Self {
        Self { working_dir }
    }
}

#[async_trait::async_trait]
impl Tool for ReadFileTool {
    fn name(&self) -> &str {
        "read_file"
    }

    fn description(&self) -> &str {
        "Read the contents of a file. Use this if you need to see file content not provided in the initial context. The path should be relative to the project root."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "file": {
                    "type": "string",
                    "description": "Path to the file, relative to project root"
                }
            },
            "required": ["file"]
        })
    }

    async fn execute(&self, input: serde_json::Value) -> anyhow::Result<ToolOutput> {
        let file = input
            .get("file")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow::anyhow!("missing 'file' parameter"))?;

        // Resolve relative to working dir
        let path = self.working_dir.join(file);

        // Security: ensure the resolved path is under working_dir
        let canonical = match path.canonicalize() {
            Ok(p) => p,
            Err(e) => {
                return Ok(ToolOutput::error(format!(
                    "Cannot read file '{}': {}",
                    file, e
                )));
            }
        };
        let canonical_wd = self.working_dir.canonicalize().unwrap_or(self.working_dir.clone());
        if !canonical.starts_with(&canonical_wd) {
            return Ok(ToolOutput::error(format!(
                "File '{}' is outside the project directory",
                file
            )));
        }

        match std::fs::read_to_string(&canonical) {
            Ok(content) => {
                info!(file = %file, len = content.len(), "Agent read file");
                // Truncate very large files to avoid blowing up the context
                if content.len() > 100_000 {
                    let truncated = &content[..100_000];
                    Ok(ToolOutput::success(format!(
                        "{}\n\n... (truncated, file is {} bytes total)",
                        truncated,
                        content.len()
                    )))
                } else {
                    Ok(ToolOutput::success(content))
                }
            }
            Err(e) => Ok(ToolOutput::error(format!(
                "Failed to read '{}': {}",
                file, e
            ))),
        }
    }
}
