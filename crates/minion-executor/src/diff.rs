//! Structured diff types and anchor-based application.
//!
//! Diffs use string anchors (unique substrings) to locate edit positions,
//! avoiding fragile line-number based addressing. Phase 1 uses simple string
//! matching; later phases will use TreeSitter-aware anchoring.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tracing::{debug, info, warn};

/// A single structured diff operation on a file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StructuredDiff {
    /// Path to the file being modified, relative to project root.
    pub file: String,

    /// The type of edit operation.
    pub action: DiffAction,

    /// A unique string anchor to locate the edit position.
    /// Required for replace, insert_after, and delete. Not needed for create.
    #[serde(default)]
    pub anchor: Option<String>,

    /// The new content to write.
    /// Required for create, replace, and insert_after. Not needed for delete.
    #[serde(default)]
    pub content: Option<String>,
}

/// The type of diff action.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiffAction {
    /// Create a new file with full content.
    Create,
    /// Replace the anchored region with new content.
    Replace,
    /// Insert content after the anchored line/region.
    InsertAfter,
    /// Delete the anchored region.
    Delete,
}

impl StructuredDiff {
    /// Validate that the diff has the required fields for its action type.
    pub fn validate(&self) -> Result<()> {
        match self.action {
            DiffAction::Create => {
                anyhow::ensure!(
                    self.content.is_some(),
                    "create action requires content for file '{}'",
                    self.file
                );
            }
            DiffAction::Replace => {
                anyhow::ensure!(
                    self.anchor.is_some(),
                    "replace action requires anchor for file '{}'",
                    self.file
                );
                anyhow::ensure!(
                    self.content.is_some(),
                    "replace action requires content for file '{}'",
                    self.file
                );
            }
            DiffAction::InsertAfter => {
                anyhow::ensure!(
                    self.anchor.is_some(),
                    "insert_after action requires anchor for file '{}'",
                    self.file
                );
                anyhow::ensure!(
                    self.content.is_some(),
                    "insert_after action requires content for file '{}'",
                    self.file
                );
            }
            DiffAction::Delete => {
                anyhow::ensure!(
                    self.anchor.is_some(),
                    "delete action requires anchor for file '{}'",
                    self.file
                );
            }
        }
        Ok(())
    }
}

/// Try to find an anchor using exact match first, then fall back to
/// whitespace-normalized matching if the exact anchor isn't found.
///
/// Returns `(start_byte, end_byte)` of the matched region in `file_content`.
fn find_anchor(file_content: &str, anchor: &str, file_name: &str) -> Result<(usize, usize)> {
    // Exact match first
    let count = file_content.matches(anchor).count();
    if count == 1 {
        let start = file_content.find(anchor).unwrap();
        return Ok((start, start + anchor.len()));
    }
    if count > 1 {
        anyhow::bail!(
            "anchor found {} times in file '{}' (must be unique): '{}'",
            count,
            file_name,
            truncate_for_display(anchor, 120),
        );
    }

    // Fallback 1: normalize whitespace in both anchor and content, then match.
    // This handles cases where the model omits/adds blank lines or comment lines
    // between anchor lines.
    let norm_anchor = normalize_whitespace(anchor);
    if norm_anchor.is_empty() {
        anyhow::bail!(
            "anchor not found in file '{}': '{}'",
            file_name,
            truncate_for_display(anchor, 120),
        );
    }

    // Try to find a contiguous region in file_content whose normalized form matches.
    // Strategy: find all lines matching the FIRST non-empty anchor line, then
    // check if the subsequent lines match the rest of the anchor lines.
    let anchor_lines: Vec<&str> = anchor
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();

    if anchor_lines.is_empty() {
        anyhow::bail!(
            "anchor not found in file '{}': '{}'",
            file_name,
            truncate_for_display(anchor, 120),
        );
    }

    let file_lines: Vec<&str> = file_content.lines().collect();
    let first_anchor_line = anchor_lines[0];

    let mut candidates: Vec<(usize, usize)> = Vec::new(); // (start_line_idx, end_line_idx)

    for (i, file_line) in file_lines.iter().enumerate() {
        if file_line.trim() == first_anchor_line {
            // Try to match remaining anchor lines forwards
            let mut anchor_idx = 1;
            let mut file_idx = i + 1;
            while anchor_idx < anchor_lines.len() && file_idx < file_lines.len() {
                let trimmed = file_lines[file_idx].trim();
                if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') {
                    // Skip blank lines and comments in the file
                    file_idx += 1;
                    continue;
                }
                if trimmed == anchor_lines[anchor_idx] {
                    anchor_idx += 1;
                    file_idx += 1;
                } else {
                    break;
                }
            }
            if anchor_idx == anchor_lines.len() {
                candidates.push((i, file_idx));
            }
        }
    }

    if candidates.len() == 1 {
        let (start_line, end_line) = candidates[0];
        // Convert line indices to byte offsets
        let byte_start = file_lines[..start_line]
            .iter()
            .map(|l| l.len() + 1) // +1 for newline
            .sum::<usize>();
        let byte_end = file_lines[..end_line]
            .iter()
            .map(|l| l.len() + 1)
            .sum::<usize>();
        // Clamp to file length (last line might not have trailing newline)
        let byte_end = byte_end.min(file_content.len());
        info!(
            file = %file_name,
            "Anchor matched via whitespace-normalized fallback (lines {}-{})",
            start_line + 1,
            end_line,
        );
        return Ok((byte_start, byte_end));
    }

    if candidates.len() > 1 {
        anyhow::bail!(
            "anchor matched {} locations via fuzzy match in file '{}' (must be unique): '{}'",
            candidates.len(),
            file_name,
            truncate_for_display(anchor, 120),
        );
    }

    anyhow::bail!(
        "anchor not found in file '{}': '{}'",
        file_name,
        truncate_for_display(anchor, 120),
    );
}

fn normalize_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_for_display(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.replace('\n', "\\n")
    } else {
        format!("{}...", s[..max].replace('\n', "\\n"))
    }
}

/// Apply a structured diff to file contents using string-anchor matching.
///
/// Uses exact string matching first, then falls back to whitespace-normalized
/// line matching (skips comments/blank lines between anchor lines).
/// Returns the modified file content as a String.
pub fn apply_diff_to_content(file_content: &str, diff: &StructuredDiff) -> Result<String> {
    diff.validate()?;

    match diff.action {
        DiffAction::Create => Ok(diff
            .content
            .clone()
            .context("create action missing content")?),
        DiffAction::Replace => {
            let anchor = diff.anchor.as_ref().unwrap();
            let content = diff.content.as_ref().unwrap();

            let (start, end) = find_anchor(file_content, anchor, &diff.file)?;

            let mut result = String::with_capacity(file_content.len() + content.len());
            result.push_str(&file_content[..start]);
            result.push_str(content);
            result.push_str(&file_content[end..]);
            Ok(result)
        }
        DiffAction::InsertAfter => {
            let anchor = diff.anchor.as_ref().unwrap();
            let content = diff.content.as_ref().unwrap();

            let (_start, end) = find_anchor(file_content, anchor, &diff.file)?;

            // Advance to end of the line (just past the newline, or EOF)
            let line_end = file_content[end..]
                .find('\n')
                .map(|pos| end + pos + 1)
                .unwrap_or(file_content.len());

            let mut result = String::with_capacity(file_content.len() + content.len() + 1);
            result.push_str(&file_content[..line_end]);
            result.push_str(content);
            if !content.ends_with('\n') {
                result.push('\n');
            }
            result.push_str(&file_content[line_end..]);
            Ok(result)
        }
        DiffAction::Delete => {
            let anchor = diff.anchor.as_ref().unwrap();

            let (start, end) = find_anchor(file_content, anchor, &diff.file)?;

            // Expand to full lines
            let line_start = file_content[..start]
                .rfind('\n')
                .map(|pos| pos + 1)
                .unwrap_or(0);

            let line_end = file_content[end..]
                .find('\n')
                .map(|pos| end + pos + 1)
                .unwrap_or(file_content.len());

            let mut result = String::with_capacity(file_content.len());
            result.push_str(&file_content[..line_start]);
            result.push_str(&file_content[line_end..]);
            Ok(result)
        }
    }
}

/// Result of applying a single diff to the filesystem.
#[derive(Debug, Clone)]
pub struct ApplyResult {
    /// The diff that was applied (or attempted).
    pub diff: StructuredDiff,
    /// Whether the application succeeded.
    pub success: bool,
    /// Error message if it failed.
    pub error: Option<String>,
}

/// Apply a single structured diff to the filesystem.
///
/// The `file` field in the diff is resolved relative to `working_dir`.
/// Returns Ok(()) on success or a descriptive error.
pub fn apply_diff(diff: &StructuredDiff, working_dir: &Path) -> Result<()> {
    diff.validate()?;

    let file_path = working_dir.join(&diff.file);

    match diff.action {
        DiffAction::Create => {
            let content = diff.content.as_ref().unwrap();
            if file_path.exists() {
                info!(file = %diff.file, "Overwriting existing file (create action)");
            }
            if let Some(parent) = file_path.parent() {
                std::fs::create_dir_all(parent).with_context(|| {
                    format!("failed to create parent directories for '{}'", diff.file)
                })?;
            }
            info!(file = %diff.file, "Creating new file");
            std::fs::write(&file_path, content)
                .with_context(|| format!("failed to write file '{}'", diff.file))?;
        }
        DiffAction::Replace | DiffAction::InsertAfter | DiffAction::Delete => {
            info!(file = %diff.file, action = ?diff.action, anchor = ?diff.anchor, "Applying diff to existing file");
            let file_content = std::fs::read_to_string(&file_path)
                .with_context(|| format!("failed to read file '{}'", diff.file))?;
            info!(file = %diff.file, file_len = file_content.len(), "Read file for diff");
            let new_content = match apply_diff_to_content(&file_content, diff) {
                Ok(c) => c,
                Err(e) => {
                    warn!(file = %diff.file, anchor = ?diff.anchor, error = %e, "Diff apply FAILED — anchor not found or not unique");
                    let content_preview = if diff.content.as_ref().map_or(0, |c| c.len()) > 500 {
                        format!("{}...", &diff.content.as_ref().unwrap()[..500])
                    } else {
                        diff.content.clone().unwrap_or_default()
                    };
                    warn!(file = %diff.file, content_preview = %content_preview, "Diff content that failed");
                    return Err(e);
                }
            };
            std::fs::write(&file_path, new_content)
                .with_context(|| format!("failed to write file '{}'", diff.file))?;
        }
    }

    Ok(())
}

/// Apply a batch of diffs to the filesystem in order.
///
/// Stops on the first error. Returns an `ApplyResult` per diff applied
/// (including the failing one).
pub fn apply_diffs(diffs: &[StructuredDiff], working_dir: &Path) -> Result<Vec<ApplyResult>> {
    let mut results = Vec::with_capacity(diffs.len());

    for diff in diffs {
        match apply_diff(diff, working_dir) {
            Ok(()) => {
                results.push(ApplyResult {
                    diff: diff.clone(),
                    success: true,
                    error: None,
                });
            }
            Err(e) => {
                let error_msg = e.to_string();
                results.push(ApplyResult {
                    diff: diff.clone(),
                    success: false,
                    error: Some(error_msg.clone()),
                });
                anyhow::bail!("diff application failed for '{}': {}", diff.file, error_msg);
            }
        }
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // ── validate ──────────────────────────────────────────────────────────────

    #[test]
    fn test_validate_create() {
        let diff = StructuredDiff {
            file: "test.rs".to_string(),
            action: DiffAction::Create,
            anchor: None,
            content: Some("fn main() {}".to_string()),
        };
        assert!(diff.validate().is_ok());
    }

    #[test]
    fn test_validate_replace_missing_anchor() {
        let diff = StructuredDiff {
            file: "test.rs".to_string(),
            action: DiffAction::Replace,
            anchor: None,
            content: Some("new content".to_string()),
        };
        assert!(diff.validate().is_err());
    }

    // ── apply_diff_to_content: create ─────────────────────────────────────────

    #[test]
    fn test_apply_create() {
        let diff = StructuredDiff {
            file: "new.rs".to_string(),
            action: DiffAction::Create,
            anchor: None,
            content: Some("fn hello() {}".to_string()),
        };
        let result = apply_diff_to_content("", &diff).unwrap();
        assert_eq!(result, "fn hello() {}");
    }

    // ── apply_diff_to_content: replace ───────────────────────────────────────

    #[test]
    fn test_replace_unique_anchor() {
        let diff = StructuredDiff {
            file: "test.rs".to_string(),
            action: DiffAction::Replace,
            anchor: Some("fn old_name()".to_string()),
            content: Some("fn new_name()".to_string()),
        };
        let content = "line1\nfn old_name() {\n    todo!()\n}\n";
        let result = apply_diff_to_content(content, &diff).unwrap();
        assert!(result.contains("fn new_name()"));
        assert!(!result.contains("fn old_name()"));
    }

    #[test]
    fn test_replace_missing_anchor_errors() {
        let diff = StructuredDiff {
            file: "test.rs".to_string(),
            action: DiffAction::Replace,
            anchor: Some("fn nonexistent()".to_string()),
            content: Some("fn replacement()".to_string()),
        };
        let err = apply_diff_to_content("fn existing() {}", &diff).unwrap_err();
        assert!(err.to_string().contains("not found"));
    }

    #[test]
    fn test_replace_duplicate_anchor_errors() {
        let diff = StructuredDiff {
            file: "test.rs".to_string(),
            action: DiffAction::Replace,
            anchor: Some("fn foo()".to_string()),
            content: Some("fn bar()".to_string()),
        };
        let err = apply_diff_to_content("fn foo() {}\nfn foo() {}", &diff).unwrap_err();
        assert!(err.to_string().contains("found 2 times"));
    }

    // ── apply_diff_to_content: insert_after ──────────────────────────────────

    #[test]
    fn test_insert_after_places_content_after_anchor_line() {
        let diff = StructuredDiff {
            file: "test.rs".to_string(),
            action: DiffAction::InsertAfter,
            anchor: Some("// insert here".to_string()),
            content: Some("let x = 42;".to_string()),
        };
        let content = "fn main() {\n    // insert here\n    println!(\"hello\");\n}\n";
        let result = apply_diff_to_content(content, &diff).unwrap();
        let anchor_pos = result.find("// insert here").unwrap();
        let insert_pos = result.find("let x = 42;").unwrap();
        assert!(
            insert_pos > anchor_pos,
            "inserted content should be after anchor"
        );
        assert!(
            result.contains("println!(\"hello\")"),
            "existing content preserved"
        );
    }

    #[test]
    fn test_insert_after_missing_anchor_errors() {
        let diff = StructuredDiff {
            file: "test.rs".to_string(),
            action: DiffAction::InsertAfter,
            anchor: Some("// missing".to_string()),
            content: Some("let x = 1;".to_string()),
        };
        let err = apply_diff_to_content("fn main() {}", &diff).unwrap_err();
        assert!(err.to_string().contains("not found"));
    }

    // ── apply_diff_to_content: delete ────────────────────────────────────────

    #[test]
    fn test_delete_removes_anchor_line() {
        let diff = StructuredDiff {
            file: "test.rs".to_string(),
            action: DiffAction::Delete,
            anchor: Some("// TODO: remove this line".to_string()),
            content: None,
        };
        let content = "line1\n// TODO: remove this line\nline3\n";
        let result = apply_diff_to_content(content, &diff).unwrap();
        assert!(!result.contains("// TODO: remove this line"));
        assert!(result.contains("line1"));
        assert!(result.contains("line3"));
    }

    #[test]
    fn test_delete_missing_anchor_errors() {
        let diff = StructuredDiff {
            file: "test.rs".to_string(),
            action: DiffAction::Delete,
            anchor: Some("// gone".to_string()),
            content: None,
        };
        let err = apply_diff_to_content("fn main() {}", &diff).unwrap_err();
        assert!(err.to_string().contains("not found"));
    }

    // ── filesystem apply_diff ─────────────────────────────────────────────────

    #[test]
    fn test_fs_create_writes_file() {
        let dir = TempDir::new().unwrap();
        let diff = StructuredDiff {
            file: "hello.rs".to_string(),
            action: DiffAction::Create,
            anchor: None,
            content: Some("fn hello() {}".to_string()),
        };
        apply_diff(&diff, dir.path()).unwrap();
        let written = std::fs::read_to_string(dir.path().join("hello.rs")).unwrap();
        assert_eq!(written, "fn hello() {}");
    }

    #[test]
    fn test_fs_create_creates_parent_dirs() {
        let dir = TempDir::new().unwrap();
        let diff = StructuredDiff {
            file: "src/deep/nested/file.rs".to_string(),
            action: DiffAction::Create,
            anchor: None,
            content: Some("// content".to_string()),
        };
        apply_diff(&diff, dir.path()).unwrap();
        assert!(dir.path().join("src/deep/nested/file.rs").exists());
    }

    #[test]
    fn test_fs_create_overwrites_existing_file() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("existing.rs"), "original").unwrap();
        let diff = StructuredDiff {
            file: "existing.rs".to_string(),
            action: DiffAction::Create,
            anchor: None,
            content: Some("new content".to_string()),
        };
        apply_diff(&diff, dir.path()).unwrap();
        let result = std::fs::read_to_string(dir.path().join("existing.rs")).unwrap();
        assert_eq!(result, "new content");
    }

    #[test]
    fn test_fs_replace_unique_anchor() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("test.rs"), "fn old_name() {}\n").unwrap();
        let diff = StructuredDiff {
            file: "test.rs".to_string(),
            action: DiffAction::Replace,
            anchor: Some("fn old_name()".to_string()),
            content: Some("fn new_name()".to_string()),
        };
        apply_diff(&diff, dir.path()).unwrap();
        let result = std::fs::read_to_string(dir.path().join("test.rs")).unwrap();
        assert!(result.contains("fn new_name()"));
        assert!(!result.contains("fn old_name()"));
    }

    #[test]
    fn test_fs_replace_missing_anchor_errors() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("test.rs"), "fn existing() {}").unwrap();
        let diff = StructuredDiff {
            file: "test.rs".to_string(),
            action: DiffAction::Replace,
            anchor: Some("fn nonexistent()".to_string()),
            content: Some("fn replacement()".to_string()),
        };
        assert!(apply_diff(&diff, dir.path()).is_err());
    }

    #[test]
    fn test_fs_replace_duplicate_anchor_errors() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("test.rs"), "fn foo() {}\nfn foo() {}").unwrap();
        let diff = StructuredDiff {
            file: "test.rs".to_string(),
            action: DiffAction::Replace,
            anchor: Some("fn foo()".to_string()),
            content: Some("fn bar()".to_string()),
        };
        assert!(apply_diff(&diff, dir.path()).is_err());
    }

    #[test]
    fn test_fs_insert_after() {
        let dir = TempDir::new().unwrap();
        std::fs::write(
            dir.path().join("test.rs"),
            "fn main() {\n    // marker\n    println!(\"hi\");\n}\n",
        )
        .unwrap();
        let diff = StructuredDiff {
            file: "test.rs".to_string(),
            action: DiffAction::InsertAfter,
            anchor: Some("// marker".to_string()),
            content: Some("    let x = 1;".to_string()),
        };
        apply_diff(&diff, dir.path()).unwrap();
        let result = std::fs::read_to_string(dir.path().join("test.rs")).unwrap();
        let marker_pos = result.find("// marker").unwrap();
        let insert_pos = result.find("let x = 1;").unwrap();
        assert!(insert_pos > marker_pos);
    }

    #[test]
    fn test_fs_delete() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("test.rs"), "line1\n// remove me\nline3\n").unwrap();
        let diff = StructuredDiff {
            file: "test.rs".to_string(),
            action: DiffAction::Delete,
            anchor: Some("// remove me".to_string()),
            content: None,
        };
        apply_diff(&diff, dir.path()).unwrap();
        let result = std::fs::read_to_string(dir.path().join("test.rs")).unwrap();
        assert!(!result.contains("// remove me"));
        assert!(result.contains("line1"));
        assert!(result.contains("line3"));
    }

    // ── apply_diffs batch ─────────────────────────────────────────────────────

    #[test]
    fn test_apply_diffs_batch_applies_in_order() {
        let dir = TempDir::new().unwrap();

        let diffs = vec![
            StructuredDiff {
                file: "a.rs".to_string(),
                action: DiffAction::Create,
                anchor: None,
                content: Some("fn a() {}".to_string()),
            },
            StructuredDiff {
                file: "b.rs".to_string(),
                action: DiffAction::Create,
                anchor: None,
                content: Some("fn b() {}".to_string()),
            },
        ];

        let results = apply_diffs(&diffs, dir.path()).unwrap();
        assert_eq!(results.len(), 2);
        assert!(results[0].success);
        assert!(results[1].success);
        assert!(dir.path().join("a.rs").exists());
        assert!(dir.path().join("b.rs").exists());
    }

    #[test]
    fn test_apply_diffs_stops_on_error() {
        let dir = TempDir::new().unwrap();
        // First diff will succeed; second references a non-existent file for replace
        let diffs = vec![
            StructuredDiff {
                file: "a.rs".to_string(),
                action: DiffAction::Create,
                anchor: None,
                content: Some("fn a() {}".to_string()),
            },
            StructuredDiff {
                file: "nonexistent.rs".to_string(),
                action: DiffAction::Replace,
                anchor: Some("fn foo()".to_string()),
                content: Some("fn bar()".to_string()),
            },
        ];
        assert!(apply_diffs(&diffs, dir.path()).is_err());
    }
}
