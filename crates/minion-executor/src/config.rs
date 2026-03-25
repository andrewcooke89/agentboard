//! Configuration for the minion executor.

use serde::{Deserialize, Serialize};

/// All configuration needed to run the executor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// URL of the Anthropic-compatible proxy.
    pub proxy_url: String,

    /// MCP server address for code-intelligence (kept for HTTP transport fallback).
    pub mcp_server_address: String,

    /// Path to the code-intel binary used for stdio MCP transport.
    /// Defaults to `code-intel` (must be on PATH) or the compiled binary.
    #[serde(default = "Config::default_mcp_server_binary")]
    pub mcp_server_binary: String,

    /// Default model to use if not specified in the work order.
    pub default_model: String,

    /// Maximum number of tool-use loop iterations before hard stop.
    pub max_iterations: u32,

    /// Hard timeout for the entire execution in seconds.
    pub timeout_seconds: u64,

    /// Timeout for individual shell commands in seconds.
    pub command_timeout_seconds: u64,
}

impl Config {
    fn default_mcp_server_binary() -> String {
        // Prefer the compiled binary at its known location; fall back to PATH.
        let known = "/home/andrew-cooke/tools/mcp-servers/code-intelligence/target/release/code-intel";
        if std::path::Path::new(known).exists() {
            known.to_string()
        } else {
            "code-intel".to_string()
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            proxy_url: "http://localhost:8090".to_string(),
            mcp_server_address: "http://localhost:3100".to_string(),
            mcp_server_binary: Config::default_mcp_server_binary(),
            default_model: "glm-4".to_string(),
            max_iterations: 20,
            timeout_seconds: 900, // 15 minutes
            command_timeout_seconds: 60,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = Config::default();
        assert_eq!(config.max_iterations, 20);
        assert_eq!(config.proxy_url, "http://localhost:8090");
    }
}
