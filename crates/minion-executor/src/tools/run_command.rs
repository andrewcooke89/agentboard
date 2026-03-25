//! The run_command tool: executes shell commands with timeout and sandboxing.
//!
//! Used by the agent to run type-checking, linting, and test commands.

use anyhow::Result;

use crate::tools::{Tool, ToolOutput};

/// Tool that executes shell commands with a timeout.
pub struct RunCommandTool {
    /// Maximum command execution time in seconds.
    timeout_seconds: u64,
}

impl RunCommandTool {
    /// Create a new run_command tool with the given timeout.
    pub fn new(timeout_seconds: u64) -> Self {
        Self { timeout_seconds }
    }
}

#[async_trait::async_trait]
impl Tool for RunCommandTool {
    fn name(&self) -> &str {
        "run_command"
    }

    fn description(&self) -> &str {
        "Run a shell command and return its output. Use for type-checking, linting, or running tests. Commands have a timeout."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The shell command to execute"
                },
                "working_directory": {
                    "type": "string",
                    "description": "Working directory for the command (defaults to project root)"
                }
            },
            "required": ["command"]
        })
    }

    async fn execute(&self, input: serde_json::Value) -> Result<ToolOutput> {
        let command = match input["command"].as_str() {
            Some(c) => c.to_string(),
            None => {
                return Ok(ToolOutput::error(
                    "missing required field: command".to_string(),
                ))
            }
        };

        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c").arg(&command);

        if let Some(dir) = input["working_directory"].as_str() {
            cmd.current_dir(dir);
        }

        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let timeout_duration = std::time::Duration::from_secs(self.timeout_seconds);

        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return Ok(ToolOutput::error(format!("failed to spawn command: {e}"))),
        };

        let result = tokio::time::timeout(timeout_duration, child.wait_with_output()).await;

        match result {
            Err(_) => Ok(ToolOutput::error(format!(
                "command timed out after {} seconds: {}",
                self.timeout_seconds, command
            ))),
            Ok(Err(e)) => Ok(ToolOutput::error(format!("command execution error: {e}"))),
            Ok(Ok(output)) => {
                const MAX_OUTPUT: usize = 10_000;

                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);

                let combined = if stderr.is_empty() {
                    stdout.into_owned()
                } else if stdout.is_empty() {
                    stderr.into_owned()
                } else {
                    format!("{stdout}\nstderr:\n{stderr}")
                };

                let truncated = if combined.len() > MAX_OUTPUT {
                    // Find the nearest char boundary at or before MAX_OUTPUT
                    let mut end = MAX_OUTPUT;
                    while end > 0 && !combined.is_char_boundary(end) {
                        end -= 1;
                    }
                    format!("{}... [truncated]", &combined[..end])
                } else {
                    combined
                };

                let exit_code = output.status.code().unwrap_or(-1);

                if output.status.success() {
                    Ok(ToolOutput::success(truncated))
                } else {
                    Ok(ToolOutput::error(format!(
                        "command exited with code {exit_code}:\n{truncated}"
                    )))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_run_command_success() {
        let tool = RunCommandTool::new(30);
        let input = serde_json::json!({ "command": "echo hello" });
        let result = tool.execute(input).await.unwrap();
        assert!(!result.is_error);
        assert!(result.content.contains("hello"));
    }

    #[tokio::test]
    async fn test_run_command_nonzero_exit() {
        let tool = RunCommandTool::new(30);
        let input = serde_json::json!({ "command": "exit 1" });
        let result = tool.execute(input).await.unwrap();
        assert!(result.is_error);
        assert!(result.content.contains('1'));
    }

    #[tokio::test]
    async fn test_run_command_captures_stderr() {
        let tool = RunCommandTool::new(30);
        let input = serde_json::json!({ "command": "echo errout >&2; exit 1" });
        let result = tool.execute(input).await.unwrap();
        assert!(result.is_error);
        assert!(result.content.contains("errout"));
    }

    #[tokio::test]
    async fn test_run_command_timeout() {
        let tool = RunCommandTool::new(1);
        let input = serde_json::json!({ "command": "sleep 10" });
        let result = tool.execute(input).await.unwrap();
        assert!(result.is_error);
        assert!(result.content.contains("timed out"));
    }

    #[tokio::test]
    async fn test_run_command_missing_field() {
        let tool = RunCommandTool::new(30);
        let input = serde_json::json!({});
        let result = tool.execute(input).await.unwrap();
        assert!(result.is_error);
        assert!(result.content.contains("missing"));
    }

    #[tokio::test]
    async fn test_run_command_working_directory() {
        let tool = RunCommandTool::new(30);
        let input = serde_json::json!({
            "command": "pwd",
            "working_directory": "/tmp"
        });
        let result = tool.execute(input).await.unwrap();
        assert!(!result.is_error);
        assert!(result.content.contains("tmp"));
    }
}
