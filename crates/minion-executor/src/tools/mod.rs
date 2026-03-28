//! Tool trait, registry, and tool implementations.
//!
//! Each tool implements the `Tool` trait and is registered in the `ToolRegistry`.
//! The executor calls tools by name via the registry.

pub mod done;
pub mod mcp_proxy;
pub mod read_file;
pub mod run_command;
pub mod write_file;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::api_client::ToolDefinition;

/// Trait that all executor tools must implement.
#[async_trait::async_trait]
pub trait Tool: Send + Sync {
    /// The tool's name as exposed to the model.
    fn name(&self) -> &str;

    /// A description of what this tool does, for the model's tool definition.
    fn description(&self) -> &str;

    /// JSON Schema for the tool's input parameters.
    fn input_schema(&self) -> serde_json::Value;

    /// Execute the tool with the given input and return the result.
    async fn execute(&self, input: serde_json::Value) -> Result<ToolOutput>;
}

/// Output from a tool execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolOutput {
    /// The result content as a string.
    pub content: String,

    /// Whether the execution was an error.
    pub is_error: bool,
}

impl ToolOutput {
    /// Create a successful tool output.
    pub fn success(content: String) -> Self {
        Self {
            content,
            is_error: false,
        }
    }

    /// Create an error tool output.
    pub fn error(message: String) -> Self {
        Self {
            content: message,
            is_error: true,
        }
    }
}

/// Registry of available tools, keyed by name.
pub struct ToolRegistry {
    tools: HashMap<String, Box<dyn Tool>>,
}

impl ToolRegistry {
    /// Create an empty tool registry.
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    /// Register a tool in the registry.
    pub fn register(&mut self, tool: Box<dyn Tool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    /// Look up a tool by name.
    pub fn get(&self, name: &str) -> Option<&dyn Tool> {
        self.tools.get(name).map(|t| t.as_ref())
    }

    /// Get tool definitions for the API (all registered tools).
    pub fn tool_definitions(&self) -> Vec<ToolDefinition> {
        self.tools
            .values()
            .map(|t| ToolDefinition {
                name: t.name().to_string(),
                description: t.description().to_string(),
                input_schema: t.input_schema(),
            })
            .collect()
    }

    /// Execute a tool by name with the given input.
    pub async fn execute(&self, name: &str, input: serde_json::Value) -> Result<ToolOutput> {
        let tool = self
            .tools
            .get(name)
            .ok_or_else(|| anyhow::anyhow!("unknown tool: {name}"))?;
        tool.execute(input).await
    }
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tool_output_success() {
        let output = ToolOutput::success("result".to_string());
        assert!(!output.is_error);
    }

    #[test]
    fn test_tool_output_error() {
        let output = ToolOutput::error("failed".to_string());
        assert!(output.is_error);
    }

    #[test]
    fn test_empty_registry() {
        let registry = ToolRegistry::new();
        assert!(registry.get("nonexistent").is_none());
        assert!(registry.tool_definitions().is_empty());
    }

    // A minimal stub tool for registry tests.
    struct StubTool {
        name: &'static str,
    }

    #[async_trait::async_trait]
    impl Tool for StubTool {
        fn name(&self) -> &str {
            self.name
        }
        fn description(&self) -> &str {
            "stub"
        }
        fn input_schema(&self) -> serde_json::Value {
            serde_json::json!({ "type": "object", "properties": {}, "required": [] })
        }
        async fn execute(&self, _input: serde_json::Value) -> anyhow::Result<ToolOutput> {
            Ok(ToolOutput::success("ok".to_string()))
        }
    }

    #[test]
    fn test_registry_register_and_get() {
        let mut registry = ToolRegistry::new();
        registry.register(Box::new(StubTool { name: "my_tool" }));
        assert!(registry.get("my_tool").is_some());
        assert!(registry.get("other").is_none());
    }

    #[test]
    fn test_registry_tool_definitions() {
        let mut registry = ToolRegistry::new();
        registry.register(Box::new(StubTool { name: "tool_a" }));
        registry.register(Box::new(StubTool { name: "tool_b" }));
        let defs = registry.tool_definitions();
        assert_eq!(defs.len(), 2);
        let names: std::collections::HashSet<&str> = defs.iter().map(|d| d.name.as_str()).collect();
        assert!(names.contains("tool_a"));
        assert!(names.contains("tool_b"));
        for def in &defs {
            assert_eq!(def.input_schema["type"], "object");
        }
    }

    #[tokio::test]
    async fn test_registry_execute_known_tool() {
        let mut registry = ToolRegistry::new();
        registry.register(Box::new(StubTool { name: "stub" }));
        let out = registry
            .execute("stub", serde_json::json!({}))
            .await
            .unwrap();
        assert!(!out.is_error);
        assert_eq!(out.content, "ok");
    }

    #[tokio::test]
    async fn test_registry_execute_unknown_tool_errors() {
        let registry = ToolRegistry::new();
        let err = registry.execute("nope", serde_json::json!({})).await;
        assert!(err.is_err());
        assert!(err.unwrap_err().to_string().contains("unknown tool"));
    }
}
