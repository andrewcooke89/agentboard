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

    /// Gate commands (per-project configuration).
    /// If not set, defaults are used.
    #[serde(default)]
    pub gate_commands: GateCommands,

    /// Path to the Codex CLI binary. Falls back to CODEX_BINARY env var or known path.
    #[serde(default)]
    pub codex_binary: Option<String>,

    /// Max concurrent Codex sessions (subscription-limited). Default: 1.
    #[serde(default = "Config::default_codex_max_concurrent")]
    pub codex_max_concurrent: usize,

    /// Agentboard API URL for CC escalation executor.
    /// If set, enables the opus-cc escalation tier.
    #[serde(default)]
    pub agentboard_url: Option<String>,
}

/// Shell commands for each gate. Projects override these in config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GateCommands {
    /// Typecheck command (e.g. "bun run typecheck", "cargo check", "tsc --noEmit").
    pub typecheck: String,

    /// Lint command (e.g. "bun run lint", "cargo clippy", "eslint .").
    pub lint: String,

    /// Test command template. `{scope}` is replaced with the test scope from WO.
    /// e.g. "bun test {scope}", "cargo test {scope}".
    pub test: String,
}

impl Default for GateCommands {
    fn default() -> Self {
        Self {
            typecheck: "bun run typecheck".to_string(),
            lint: "bun run lint".to_string(),
            test: "bun test {scope}".to_string(),
        }
    }
}

impl Config {
    /// Resolve the Codex binary path. Checks: config field → CODEX_BINARY env → known NVM path → None.
    pub fn resolve_codex_binary(&self) -> Option<String> {
        if let Some(ref bin) = self.codex_binary {
            if !bin.is_empty() {
                return Some(bin.clone());
            }
        }
        if let Ok(bin) = std::env::var("CODEX_BINARY") {
            if !bin.is_empty() {
                return Some(bin);
            }
        }
        // Check known installation path
        let known =
            std::path::Path::new("/home/andrew-cooke/.nvm/versions/node/v24.13.0/bin/codex");
        if known.exists() {
            return Some(known.to_string_lossy().to_string());
        }
        None
    }

    fn default_codex_max_concurrent() -> usize {
        1
    }

    fn default_mcp_server_binary() -> String {
        // Prefer the compiled binary at its known location; fall back to PATH.
        let known =
            "/home/andrew-cooke/tools/mcp-servers/code-intelligence/target/release/code-intel";
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
            gate_commands: GateCommands::default(),
            codex_binary: None,
            codex_max_concurrent: 1,
            agentboard_url: None,
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

    #[test]
    fn test_resolve_codex_binary_from_config() {
        let mut config = Config::default();
        config.codex_binary = Some("/usr/bin/codex".to_string());
        assert_eq!(
            config.resolve_codex_binary(),
            Some("/usr/bin/codex".to_string())
        );
    }

    #[test]
    fn test_resolve_codex_binary_none_when_empty() {
        let config = Config::default();
        // Will be None unless CODEX_BINARY env is set or known path exists
        // Just verify it doesn't panic
        let _ = config.resolve_codex_binary();
    }
}
