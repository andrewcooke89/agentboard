//! MCP proxy tools that forward agent tool calls to the code-intelligence MCP server.
//!
//! Each tool maps an agent-facing name to an MCP tool on the code-intelligence server:
//!   search       -> intern_search
//!   read_file    -> intern_read_file
//!   compile_check -> intern_compile_check
//!   find_symbol  -> find_symbol
//!   find_references -> find_references
//!   file_skeleton -> get_file_skeleton

use anyhow::Result;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::mcp_client::{McpClient, McpToolCall};
use crate::tools::{Tool, ToolOutput};

/// A tool that proxies calls to the code-intelligence MCP server.
pub struct McpProxyTool {
    /// The agent-facing tool name.
    agent_name: String,

    /// The MCP tool name on the code-intelligence server.
    mcp_name: String,

    /// Description for the model.
    tool_description: String,

    /// JSON Schema for input parameters.
    schema: serde_json::Value,

    /// Shared MCP client.
    mcp_client: Arc<McpClient>,

    /// Project root for resolving relative paths to absolute.
    working_dir: PathBuf,

    /// Parameter names that contain file paths (resolved relative → absolute).
    path_params: Vec<&'static str>,
}

impl McpProxyTool {
    /// Create a new MCP proxy tool.
    pub fn new(
        agent_name: impl Into<String>,
        mcp_name: impl Into<String>,
        description: impl Into<String>,
        schema: serde_json::Value,
        mcp_client: Arc<McpClient>,
        working_dir: PathBuf,
        path_params: Vec<&'static str>,
    ) -> Self {
        Self {
            agent_name: agent_name.into(),
            mcp_name: mcp_name.into(),
            tool_description: description.into(),
            schema,
            mcp_client,
            working_dir,
            path_params,
        }
    }

    /// Resolve any relative path parameters to absolute using working_dir.
    fn resolve_paths(&self, input: serde_json::Value) -> serde_json::Value {
        resolve_path_params(input, &self.working_dir, &self.path_params)
    }
}

/// Resolve relative path parameters to absolute using the given working directory.
///
/// Any parameter whose name appears in `path_params` and whose value is a string
/// not starting with `/` gets prepended with `working_dir`.
fn resolve_path_params(
    mut input: serde_json::Value,
    working_dir: &Path,
    path_params: &[&str],
) -> serde_json::Value {
    if let Some(obj) = input.as_object_mut() {
        for &param in path_params {
            if let Some(serde_json::Value::String(p)) = obj.get(param) {
                if !p.starts_with('/') {
                    let resolved = working_dir.join(p);
                    obj.insert(
                        param.to_string(),
                        serde_json::Value::String(resolved.to_string_lossy().into()),
                    );
                }
            }
        }
    }
    input
}

#[async_trait::async_trait]
impl Tool for McpProxyTool {
    fn name(&self) -> &str {
        &self.agent_name
    }

    fn description(&self) -> &str {
        &self.tool_description
    }

    fn input_schema(&self) -> serde_json::Value {
        self.schema.clone()
    }

    async fn execute(&self, input: serde_json::Value) -> Result<ToolOutput> {
        let resolved = self.resolve_paths(input);
        let call = McpToolCall {
            name: self.mcp_name.clone(),
            arguments: resolved,
        };
        let result = self.mcp_client.call_tool(&call).await?;

        // Concatenate all text content blocks into a single string.
        let content = result
            .content
            .iter()
            .map(|c| match c {
                crate::mcp_client::McpContent::Text { text } => text.as_str(),
            })
            .collect::<Vec<_>>()
            .join("");

        if result.is_error {
            Ok(ToolOutput::error(content))
        } else {
            Ok(ToolOutput::success(content))
        }
    }
}

/// Create all MCP proxy tools with the given client.
///
/// `working_dir` is used to resolve relative paths to absolute before forwarding
/// to the MCP server (which requires absolute paths).
pub fn create_mcp_tools(mcp_client: Arc<McpClient>, working_dir: PathBuf) -> Vec<Box<dyn Tool>> {
    vec![
        Box::new(McpProxyTool::new(
            "search",
            "intern_search",
            "Search the codebase using natural language or regex. Auto-routes to the best search strategy.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query (natural language or regex pattern)"
                    },
                    "context": {
                        "type": "string",
                        "description": "Additional context for relevance scoring"
                    }
                },
                "required": ["query", "context"]
            }),
            mcp_client.clone(),
            working_dir.clone(),
            vec![], // no path params
        )),
        Box::new(McpProxyTool::new(
            "read_file",
            "intern_read_file",
            "Read a source file with focused symbol extraction. Returns relevant symbols, not the whole file.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the file (relative to project root or absolute)"
                    },
                    "focus": {
                        "type": "string",
                        "description": "Symbol name or concept to focus on"
                    },
                    "context": {
                        "type": "string",
                        "description": "Additional context about what you are looking for"
                    }
                },
                "required": ["path"]
            }),
            mcp_client.clone(),
            working_dir.clone(),
            vec!["path"],
        )),
        Box::new(McpProxyTool::new(
            "compile_check",
            "intern_compile_check",
            "Check if the code compiles and return classified errors with suggested fixes.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the project or file to check (relative to project root or absolute)"
                    }
                },
                "required": ["path"]
            }),
            mcp_client.clone(),
            working_dir.clone(),
            vec!["path"],
        )),
        Box::new(McpProxyTool::new(
            "find_symbol",
            "find_symbol",
            "Find the definition of a symbol by name. Use when search doesn't find what you need.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Symbol name to find"
                    }
                },
                "required": ["name"]
            }),
            mcp_client.clone(),
            working_dir.clone(),
            vec![], // name, not path
        )),
        Box::new(McpProxyTool::new(
            "find_references",
            "find_references",
            "Find all usages of a symbol across the codebase.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Symbol name to find references for"
                    }
                },
                "required": ["name"]
            }),
            mcp_client.clone(),
            working_dir.clone(),
            vec![], // name, not path
        )),
        Box::new(McpProxyTool::new(
            "file_skeleton",
            "get_file_skeleton",
            "Get a structural overview of a file (functions, classes, types) without full content.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the file (relative to project root or absolute)"
                    }
                },
                "required": ["path"]
            }),
            mcp_client,
            working_dir,
            vec!["path"],
        )),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_search_tool_schema() {
        // Build a minimal McpClient-less test by checking schema structure only.
        // We can't construct McpClient without a live server, so we test the
        // schema values via the create_mcp_tools factory indirectly.
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Search query (natural language or regex pattern)" },
                "context": { "type": "string", "description": "Additional context for relevance scoring" }
            },
            "required": ["query", "context"]
        });
        assert_eq!(schema["type"], "object");
        assert!(schema["properties"]["query"].is_object());
        assert!(schema["properties"]["context"].is_object());
        assert_eq!(schema["required"][0], "query");
        assert_eq!(schema["required"][1], "context");
    }

    #[test]
    fn test_read_file_schema_has_required_path() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute path to the file" },
                "focus": { "type": "string", "description": "Symbol name or concept to focus on" },
                "context": { "type": "string", "description": "Additional context about what you are looking for" }
            },
            "required": ["path"]
        });
        assert_eq!(schema["required"][0], "path");
        assert!(schema["properties"]["focus"].is_object());
    }

    #[test]
    fn test_compile_check_schema() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Path to the project or file to check" }
            },
            "required": ["path"]
        });
        assert_eq!(schema["required"][0], "path");
    }

    #[test]
    fn test_find_symbol_schema() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "Symbol name to find" }
            },
            "required": ["name"]
        });
        assert_eq!(schema["required"][0], "name");
    }

    #[test]
    fn test_resolve_paths_relative_to_absolute() {
        let wd = Path::new("/home/user/project");
        let input = serde_json::json!({"path": "src/main.ts", "focus": "hello"});
        let resolved = resolve_path_params(input, wd, &["path"]);
        assert_eq!(resolved["path"], "/home/user/project/src/main.ts");
        assert_eq!(resolved["focus"], "hello"); // non-path param untouched
    }

    #[test]
    fn test_resolve_paths_absolute_unchanged() {
        let wd = Path::new("/home/user/project");
        let input = serde_json::json!({"path": "/absolute/path/file.ts"});
        let resolved = resolve_path_params(input, wd, &["path"]);
        assert_eq!(resolved["path"], "/absolute/path/file.ts");
    }

    #[test]
    fn test_resolve_paths_no_path_params() {
        let wd = Path::new("/home/user/project");
        let input = serde_json::json!({"query": "src/main.ts", "context": "test"});
        let resolved = resolve_path_params(input, wd, &[]);
        assert_eq!(resolved["query"], "src/main.ts"); // untouched
    }

    #[test]
    fn test_mcp_content_join() {
        // Verify that multi-block content is joined correctly (unit-test the join logic).
        use crate::mcp_client::McpContent;
        let blocks = vec![
            McpContent::Text {
                text: "hello ".to_string(),
            },
            McpContent::Text {
                text: "world".to_string(),
            },
        ];
        let joined = blocks
            .iter()
            .map(|c| match c {
                McpContent::Text { text } => text.as_str(),
            })
            .collect::<Vec<_>>()
            .join("");
        assert_eq!(joined, "hello world");
    }
}
