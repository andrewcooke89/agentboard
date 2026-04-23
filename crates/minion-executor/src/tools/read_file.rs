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
                },
                "offset": {
                    "type": "integer",
                    "description": "Start reading from this line number (1-based). Omit to read from the beginning."
                },
                "limit": {
                    "type": "integer",
                    "description": "Maximum number of lines to return. Omit to read to the end of the file."
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

        let offset = input.get("offset").and_then(|v| v.as_u64()).map(|n| n as usize);
        let limit = input.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize);

        match std::fs::read_to_string(&canonical) {
            Ok(content) => {
                let lines: Vec<&str> = content.lines().collect();
                let total_lines = lines.len();

                // Apply offset (1-based) and limit
                let start = offset.map(|o| o.saturating_sub(1)).unwrap_or(0).min(total_lines);
                let end = match limit {
                    Some(l) => (start + l).min(total_lines),
                    None => total_lines,
                };
                let selected = &lines[start..end];

                // Format with line numbers (1-based)
                let numbered: String = selected
                    .iter()
                    .enumerate()
                    .map(|(i, line)| format!("{:>6}\t{}", start + i + 1, line))
                    .collect::<Vec<_>>()
                    .join("\n");

                let line_count = end - start;
                info!(file = %file, total_lines, returned_lines = line_count, "Agent read file");

                // Truncate if the numbered output exceeds 100KB
                if numbered.len() > 100_000 {
                    let mut truncate_at = 100_000;
                    while truncate_at > 0 && !numbered.is_char_boundary(truncate_at) {
                        truncate_at -= 1;
                    }
                    Ok(ToolOutput::success(format!(
                        "{}\n\n... (truncated, showing lines {}-{} of {})",
                        &numbered[..truncate_at],
                        start + 1,
                        end,
                        total_lines
                    )))
                } else {
                    let suffix = if start > 0 || end < total_lines {
                        format!("\n\n(showing lines {}-{} of {})", start + 1, end, total_lines)
                    } else {
                        format!("\n\n({} lines)", total_lines)
                    };
                    Ok(ToolOutput::success(format!("{numbered}{suffix}")))
                }
            }
            Err(e) => Ok(ToolOutput::error(format!(
                "Failed to read '{}': {}",
                file, e
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn create_test_file(content: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let wd = dir.path().to_path_buf();
        let file_path = wd.join("test.txt");
        let mut f = std::fs::File::create(&file_path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        (dir, wd)
    }

    #[tokio::test]
    async fn test_read_full_file_with_line_numbers() {
        let (dir, wd) = create_test_file("alpha\nbeta\ngamma\n");
        let tool = ReadFileTool::new(wd);
        let result = tool
            .execute(serde_json::json!({ "file": "test.txt" }))
            .await
            .unwrap();
        assert!(!result.is_error);
        assert!(result.content.contains("     1\talpha"));
        assert!(result.content.contains("     2\tbeta"));
        assert!(result.content.contains("     3\tgamma"));
        assert!(result.content.contains("(3 lines)"));
        drop(dir);
    }

    #[tokio::test]
    async fn test_read_with_offset() {
        let (dir, wd) = create_test_file("line1\nline2\nline3\nline4\nline5\n");
        let tool = ReadFileTool::new(wd);
        let result = tool
            .execute(serde_json::json!({ "file": "test.txt", "offset": 3 }))
            .await
            .unwrap();
        assert!(!result.is_error);
        assert!(!result.content.contains("     1\t"));
        assert!(result.content.contains("     3\tline3"));
        assert!(result.content.contains("     5\tline5"));
        assert!(result.content.contains("showing lines 3-5 of 5"));
        drop(dir);
    }

    #[tokio::test]
    async fn test_read_with_limit() {
        let (dir, wd) = create_test_file("a\nb\nc\nd\ne\n");
        let tool = ReadFileTool::new(wd);
        let result = tool
            .execute(serde_json::json!({ "file": "test.txt", "limit": 2 }))
            .await
            .unwrap();
        assert!(!result.is_error);
        assert!(result.content.contains("     1\ta"));
        assert!(result.content.contains("     2\tb"));
        assert!(!result.content.contains("     3\t"));
        assert!(result.content.contains("showing lines 1-2 of 5"));
        drop(dir);
    }

    #[tokio::test]
    async fn test_read_with_offset_and_limit() {
        let (dir, wd) = create_test_file("a\nb\nc\nd\ne\nf\ng\n");
        let tool = ReadFileTool::new(wd);
        let result = tool
            .execute(serde_json::json!({ "file": "test.txt", "offset": 3, "limit": 2 }))
            .await
            .unwrap();
        assert!(!result.is_error);
        assert!(result.content.contains("     3\tc"));
        assert!(result.content.contains("     4\td"));
        assert!(!result.content.contains("     5\t"));
        assert!(result.content.contains("showing lines 3-4 of 7"));
        drop(dir);
    }

    #[tokio::test]
    async fn test_read_nonexistent_file() {
        let dir = tempfile::tempdir().unwrap();
        let tool = ReadFileTool::new(dir.path().to_path_buf());
        let result = tool
            .execute(serde_json::json!({ "file": "nope.txt" }))
            .await
            .unwrap();
        assert!(result.is_error);
        assert!(result.content.contains("Cannot read file"));
        drop(dir);
    }

    #[tokio::test]
    async fn test_read_outside_working_dir() {
        let dir = tempfile::tempdir().unwrap();
        let tool = ReadFileTool::new(dir.path().to_path_buf());
        let result = tool
            .execute(serde_json::json!({ "file": "/etc/passwd" }))
            .await
            .unwrap();
        assert!(result.is_error);
        assert!(result.content.contains("outside the project directory"));
        drop(dir);
    }
}
