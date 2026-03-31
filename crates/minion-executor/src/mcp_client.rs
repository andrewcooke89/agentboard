//! MCP protocol client for communicating with code-intelligence MCP server.
//!
//! The executor is an MCP client — it sends tool calls to the code-intelligence
//! server and receives results. This module handles the MCP protocol framing.
//!
//! Transport: JSON-RPC 2.0 over stdin/stdout (newline-delimited).
//! The client spawns `code-intel serve` as a subprocess, sends the `initialize`
//! handshake on startup, then multiplexes `tools/call` and `tools/list` requests
//! over the same pipe for the lifetime of the client.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;
use tokio::time::timeout;
use tracing::{debug, warn};

use crate::config::Config;

// ── JSON-RPC 2.0 wire types ───────────────────────────────────────────────────

/// A JSON-RPC 2.0 request sent to the server.
#[derive(Debug, Serialize)]
struct JsonRpcRequest {
    jsonrpc: &'static str,
    id: u64,
    method: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    params: Option<serde_json::Value>,
}

/// A JSON-RPC 2.0 response received from the server.
#[derive(Debug, Deserialize)]
struct JsonRpcResponse {
    // jsonrpc field present in wire format but unused in logic
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    pub id: Option<serde_json::Value>,
    pub result: Option<serde_json::Value>,
    pub error: Option<JsonRpcError>,
}

/// A JSON-RPC 2.0 error object.
#[derive(Debug, Deserialize)]
struct JsonRpcError {
    pub code: i32,
    pub message: String,
}

// ── MCP lifecycle types ───────────────────────────────────────────────────────

/// Params for the MCP `initialize` request.
#[derive(Debug, Serialize)]
struct InitializeParams {
    #[serde(rename = "protocolVersion")]
    protocol_version: &'static str,
    capabilities: serde_json::Value,
    #[serde(rename = "clientInfo")]
    client_info: ClientInfo,
}

#[derive(Debug, Serialize)]
struct ClientInfo {
    name: &'static str,
    version: &'static str,
}

// ── Inner state (protected by mutex) ─────────────────────────────────────────

struct McpInner {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}

impl McpInner {
    /// Send a JSON-RPC request (serialised as one line) and read the matching response.
    ///
    /// Responses that don't match `expected_id` are logged and discarded; the loop
    /// continues until a matching one arrives or the timeout fires.
    async fn call(
        &mut self,
        req: JsonRpcRequest,
        read_timeout: Duration,
    ) -> Result<serde_json::Value> {
        let expected_id = req.id;
        let line = serde_json::to_string(&req).context("failed to serialize JSON-RPC request")?;

        debug!(id = expected_id, method = req.method, "→ MCP request");

        self.stdin
            .write_all(line.as_bytes())
            .await
            .context("failed to write to MCP server stdin")?;
        self.stdin
            .write_all(b"\n")
            .await
            .context("failed to write newline to MCP server stdin")?;
        self.stdin
            .flush()
            .await
            .context("failed to flush MCP server stdin")?;

        // Read lines until we get the one matching our request id.
        loop {
            let mut buf = String::new();
            let n = timeout(read_timeout, self.stdout.read_line(&mut buf))
                .await
                .context("timed out waiting for MCP server response")?
                .context("failed to read from MCP server stdout")?;

            if n == 0 {
                bail!("MCP server closed stdout unexpectedly");
            }

            let trimmed = buf.trim();
            if trimmed.is_empty() {
                continue;
            }

            // Skip non-JSON lines (e.g. tracing log output from the MCP server).
            if !trimmed.starts_with('{') {
                debug!(
                    "skipping non-JSON line from MCP server: {}",
                    &trimmed[..trimmed.len().min(120)]
                );
                continue;
            }

            debug!("← MCP raw: {}", trimmed);

            let resp: JsonRpcResponse =
                serde_json::from_str(trimmed).context("failed to parse JSON-RPC response")?;

            // Match on id — numeric responses arrive as JSON numbers.
            // Messages with no id are server notifications (e.g. the spurious response
            // to our `initialized` notification) — skip them silently.
            let resp_id = match resp.id.as_ref().and_then(|v| v.as_u64()) {
                Some(id) => id,
                None => {
                    debug!("skipping MCP server notification (no id)");
                    continue;
                }
            };

            if resp_id != expected_id {
                warn!(
                    got = resp_id,
                    expected = expected_id,
                    "discarding out-of-order MCP response"
                );
                continue;
            }

            if let Some(err) = resp.error {
                bail!(
                    "MCP server returned JSON-RPC error {}: {}",
                    err.code,
                    err.message
                );
            }

            return resp
                .result
                .ok_or_else(|| anyhow!("MCP response had neither result nor error"));
        }
    }
}

// ── Public client ─────────────────────────────────────────────────────────────

/// Client for the code-intelligence MCP server.
///
/// Communicates over JSON-RPC 2.0 on the child process's stdin/stdout.
/// The subprocess is spawned once in [`McpClient::new`] and kept alive for the
/// lifetime of the client.  [`Drop`] kills the child process via `kill_on_drop`.
pub struct McpClient {
    inner: Arc<Mutex<McpInner>>,
    next_id: Arc<AtomicU64>,
    /// Per-request read timeout.
    read_timeout: Duration,
}

impl std::fmt::Debug for McpClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpClient").finish_non_exhaustive()
    }
}

impl McpClient {
    /// Spawn the MCP server process and perform the `initialize` handshake.
    pub async fn new(config: &Config) -> Result<Self> {
        let binary = &config.mcp_server_binary;
        let read_timeout = Duration::from_secs(config.timeout_seconds);

        debug!(%binary, "spawning MCP server subprocess");

        let mut child = Command::new(binary)
            .arg("serve")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            // Redirect stderr to /dev/null so server log noise doesn't pollute our pipe.
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("failed to spawn MCP server '{binary}'"))?;

        let stdin = BufWriter::new(
            child
                .stdin
                .take()
                .ok_or_else(|| anyhow!("MCP child process has no stdin"))?,
        );
        let stdout = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| anyhow!("MCP child process has no stdout"))?,
        );

        let next_id = Arc::new(AtomicU64::new(1));
        let mut inner = McpInner {
            child,
            stdin,
            stdout,
        };

        // ── initialize handshake ──────────────────────────────────────────────
        let init_id = next_id.fetch_add(1, Ordering::Relaxed);
        let init_req = JsonRpcRequest {
            jsonrpc: "2.0",
            id: init_id,
            method: "initialize",
            params: Some(
                serde_json::to_value(InitializeParams {
                    protocol_version: "2024-11-05",
                    capabilities: serde_json::json!({}),
                    client_info: ClientInfo {
                        name: "minion-executor",
                        version: env!("CARGO_PKG_VERSION"),
                    },
                })
                .context("failed to serialize initialize params")?,
            ),
        };

        inner
            .call(init_req, read_timeout)
            .await
            .context("MCP initialize handshake failed")?;

        // Send the `initialized` notification (no id, no response expected).
        let notif = r#"{"jsonrpc":"2.0","method":"initialized","params":{}}"#;
        inner.stdin.write_all(notif.as_bytes()).await?;
        inner.stdin.write_all(b"\n").await?;
        inner.stdin.flush().await?;

        debug!("MCP initialize handshake complete");

        Ok(Self {
            inner: Arc::new(Mutex::new(inner)),
            next_id,
            read_timeout,
        })
    }

    /// Call a tool on the MCP server and return the result.
    pub async fn call_tool(&self, request: &McpToolCall) -> Result<McpToolResult> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);

        let params = serde_json::json!({
            "name": request.name,
            "arguments": request.arguments,
        });

        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: Some(params),
        };

        let result = self
            .inner
            .lock()
            .await
            .call(req, self.read_timeout)
            .await
            .with_context(|| format!("tools/call '{}' failed", request.name))?;

        // The result is a `CallToolResult` object:
        // { "content": [{"type": "text", "text": "..."}], "isError": false }
        let raw: RawCallToolResult =
            serde_json::from_value(result).context("failed to deserialize CallToolResult")?;

        Ok(McpToolResult {
            content: raw
                .content
                .into_iter()
                .map(|c| McpContent::Text { text: c.text })
                .collect(),
            is_error: raw.is_error.unwrap_or(false),
        })
    }

    /// Call `get_file_symbols` MCP tool and parse the markdown response into structured symbols.
    ///
    /// The tool returns markdown like:
    /// ```text
    /// - **WorkOrder** (struct) [rust] - line 10
    /// - **TaskType** (enum) [rust] - line 99
    /// - **from_file** (method) [rust] - line 81
    /// ```
    ///
    /// We parse each line matching `- **Name** (kind)` pattern.
    pub async fn get_file_symbols(&self, path: &str) -> Result<Vec<FileSymbol>> {
        let call = McpToolCall {
            name: "get_file_symbols".to_string(),
            arguments: serde_json::json!({ "path": path }),
        };
        let result = self.call_tool(&call).await?;
        if result.is_error {
            bail!("get_file_symbols error for {}", path);
        }

        // Extract text content from MCP result
        let text = result
            .content
            .iter()
            .map(|c| {
                let McpContent::Text { text } = c;
                text.as_str()
            })
            .collect::<Vec<_>>()
            .join("\n");

        Ok(parse_file_symbols(&text))
    }

    /// List available tools on the MCP server.
    pub async fn list_tools(&self) -> Result<Vec<McpToolInfo>> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);

        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id,
            method: "tools/list",
            params: None,
        };

        let result = self
            .inner
            .lock()
            .await
            .call(req, self.read_timeout)
            .await
            .context("tools/list failed")?;

        // result: { "tools": [ { "name": "...", "description": "...", "inputSchema": {...} } ] }
        let raw: RawListToolsResult =
            serde_json::from_value(result).context("failed to deserialize ListToolsResult")?;

        Ok(raw
            .tools
            .into_iter()
            .map(|t| McpToolInfo {
                name: t.name,
                description: t.description,
                input_schema: t.input_schema,
            })
            .collect())
    }
}

// ── Wire-format helpers (private) ─────────────────────────────────────────────

/// Wire format of a `tools/call` result from the server.
#[derive(Deserialize)]
struct RawCallToolResult {
    content: Vec<RawToolContent>,
    #[serde(rename = "isError")]
    is_error: Option<bool>,
}

#[derive(Deserialize)]
struct RawToolContent {
    // type field present on wire but we only handle "text" for now
    #[allow(dead_code)]
    #[serde(rename = "type")]
    content_type: String,
    text: String,
}

/// Wire format of a `tools/list` result from the server.
#[derive(Deserialize)]
struct RawListToolsResult {
    tools: Vec<RawToolInfo>,
}

#[derive(Deserialize)]
struct RawToolInfo {
    name: String,
    description: String,
    #[serde(rename = "inputSchema")]
    input_schema: serde_json::Value,
}

// ── Public domain types ───────────────────────────────────────────────────────

/// A tool call to send to the MCP server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolCall {
    /// Name of the tool to call.
    pub name: String,

    /// Arguments as a JSON object.
    pub arguments: serde_json::Value,
}

/// Result from an MCP tool call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolResult {
    /// The result content (typically text or JSON).
    pub content: Vec<McpContent>,

    /// Whether the tool call resulted in an error.
    #[serde(default)]
    pub is_error: bool,
}

/// A content item in an MCP tool result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum McpContent {
    /// Text content.
    #[serde(rename = "text")]
    Text { text: String },
}

/// Information about an available MCP tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolInfo {
    /// Tool name.
    pub name: String,

    /// Tool description.
    pub description: String,

    /// JSON Schema for the tool's input.
    pub input_schema: serde_json::Value,
}

/// Symbol returned by the `get_file_symbols` MCP tool (tree-sitter parsed).
#[derive(Debug, Clone)]
pub struct FileSymbol {
    pub name: String,
    pub kind: String, // "struct", "enum", "function", "method", "interface", "type_alias", etc.
}

// ── Symbol parsing ────────────────────────────────────────────────────────────

/// Parse the markdown output of get_file_symbols into FileSymbol structs.
/// Lines look like: `- **Name** (kind) [lang] - line N`
fn parse_file_symbols(text: &str) -> Vec<FileSymbol> {
    let mut symbols = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        // Match pattern: - **Name** (kind)
        if let Some(rest) = line.strip_prefix("- **") {
            if let Some(name_end) = rest.find("**") {
                let name = rest[..name_end].to_string();
                let after_name = &rest[name_end + 2..];
                // Extract (kind)
                if let Some(kind_start) = after_name.find('(') {
                    if let Some(kind_end) = after_name[kind_start..].find(')') {
                        let kind =
                            after_name[kind_start + 1..kind_start + kind_end].to_string();
                        symbols.push(FileSymbol { name, kind });
                    }
                }
            }
        }
    }
    symbols
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── serialization ─────────────────────────────────────────────────────────

    #[test]
    fn test_mcp_tool_call_serialization() {
        let call = McpToolCall {
            name: "intern_search".to_string(),
            arguments: serde_json::json!({
                "query": "health check",
                "context": "finding health endpoint"
            }),
        };
        let json = serde_json::to_string(&call).unwrap();
        assert!(json.contains("intern_search"));
        assert!(json.contains("health check"));
    }

    #[test]
    fn test_jsonrpc_request_serialization() {
        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id: 42,
            method: "tools/call",
            params: Some(serde_json::json!({"name": "find_symbol", "arguments": {"query": "foo"}})),
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["id"], 42);
        assert_eq!(v["method"], "tools/call");
        assert_eq!(v["params"]["name"], "find_symbol");
    }

    #[test]
    fn test_jsonrpc_request_no_params_omitted() {
        let req = JsonRpcRequest {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: None,
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        // params must be absent, not null
        assert!(v.get("params").is_none());
    }

    // ── deserialization ────────────────────────────────────────────────────────

    #[test]
    fn test_jsonrpc_response_success_deserialization() {
        let json = r#"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hello"}],"isError":false}}"#;
        let resp: JsonRpcResponse = serde_json::from_str(json).unwrap();
        assert!(resp.result.is_some());
        assert!(resp.error.is_none());
        assert_eq!(resp.id.as_ref().and_then(|v| v.as_u64()), Some(1));
    }

    #[test]
    fn test_jsonrpc_response_error_deserialization() {
        let json =
            r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"Method not found"}}"#;
        let resp: JsonRpcResponse = serde_json::from_str(json).unwrap();
        assert!(resp.result.is_none());
        let err = resp.error.unwrap();
        assert_eq!(err.code, -32601);
        assert_eq!(err.message, "Method not found");
    }

    #[test]
    fn test_raw_call_tool_result_deserialization() {
        let json = r#"{"content":[{"type":"text","text":"found 3 results"}],"isError":false}"#;
        let raw: RawCallToolResult = serde_json::from_str(json).unwrap();
        assert_eq!(raw.content.len(), 1);
        assert_eq!(raw.content[0].text, "found 3 results");
        assert_eq!(raw.is_error, Some(false));
    }

    #[test]
    fn test_raw_call_tool_result_is_error_missing_defaults_none() {
        // isError may be absent on success responses
        let json = r#"{"content":[{"type":"text","text":"ok"}]}"#;
        let raw: RawCallToolResult = serde_json::from_str(json).unwrap();
        assert_eq!(raw.is_error, None);
    }

    #[test]
    fn test_raw_list_tools_result_deserialization() {
        let json = r#"{"tools":[{"name":"find_symbol","description":"Find a symbol","inputSchema":{"type":"object"}}]}"#;
        let raw: RawListToolsResult = serde_json::from_str(json).unwrap();
        assert_eq!(raw.tools.len(), 1);
        assert_eq!(raw.tools[0].name, "find_symbol");
        assert_eq!(raw.tools[0].description, "Find a symbol");
    }

    #[test]
    fn test_mcp_content_text_roundtrip() {
        let content = McpContent::Text {
            text: "search results here".to_string(),
        };
        let v: serde_json::Value = serde_json::to_value(&content).unwrap();
        assert_eq!(v["type"], "text");
        assert_eq!(v["text"], "search results here");

        let back: McpContent = serde_json::from_value(v).unwrap();
        match back {
            McpContent::Text { text } => assert_eq!(text, "search results here"),
        }
    }

    #[test]
    fn test_mcp_tool_result_is_error_default_false() {
        let json = r#"{"content":[]}"#;
        let result: McpToolResult = serde_json::from_str(json).unwrap();
        assert!(!result.is_error);
    }

    #[test]
    fn test_mcp_tool_info_roundtrip() {
        let info = McpToolInfo {
            name: "semantic_search".to_string(),
            description: "Search by meaning".to_string(),
            input_schema: serde_json::json!({"type": "object", "properties": {"query": {"type": "string"}}}),
        };
        let json = serde_json::to_string(&info).unwrap();
        let back: McpToolInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(back.name, "semantic_search");
        assert_eq!(back.input_schema["type"], "object");
    }

    // ── parse_file_symbols ────────────────────────────────────────────────────

    #[test]
    fn test_parse_file_symbols_basic() {
        let text = r#"Symbols in /path/to/file.rs:

- **WorkOrder** (struct) [rust] - line 10
- **TaskType** (enum) [rust] - line 99
- **from_file** (method) [rust] - line 81
  `pub fn from_file(path: &Path) -> Result<Self>`
  Parent: WorkOrder
- **Gates** (struct) [rust] - line 140"#;

        let symbols = parse_file_symbols(text);
        assert_eq!(symbols.len(), 4);
        assert_eq!(symbols[0].name, "WorkOrder");
        assert_eq!(symbols[0].kind, "struct");
        assert_eq!(symbols[1].name, "TaskType");
        assert_eq!(symbols[1].kind, "enum");
        assert_eq!(symbols[2].name, "from_file");
        assert_eq!(symbols[2].kind, "method");
        assert_eq!(symbols[3].name, "Gates");
        assert_eq!(symbols[3].kind, "struct");
    }

    #[test]
    fn test_parse_file_symbols_empty() {
        let text = "No symbols found in file: /path/to/file.ts";
        let symbols = parse_file_symbols(text);
        assert!(symbols.is_empty());
    }

    #[test]
    fn test_parse_file_symbols_typescript() {
        let text = r#"Symbols in src/types.ts:

- **SwarmGroupState** (interface) [typescript] - line 45
- **WoStatus** (type_alias) [typescript] - line 10
- **convertToLogEntry** (function) [typescript] - line 20"#;

        let symbols = parse_file_symbols(text);
        assert_eq!(symbols.len(), 3);
        assert_eq!(symbols[0].name, "SwarmGroupState");
        assert_eq!(symbols[0].kind, "interface");
        assert_eq!(symbols[1].kind, "type_alias");
        assert_eq!(symbols[2].name, "convertToLogEntry");
        assert_eq!(symbols[2].kind, "function");
    }
}
