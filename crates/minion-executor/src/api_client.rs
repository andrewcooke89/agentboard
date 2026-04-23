//! Anthropic Messages API client that talks to the proxy at localhost:8090.
//!
//! The proxy handles model routing, auth injection, and ClickHouse logging.
//! The executor only needs to send well-formed Messages API requests.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

use crate::config::Config;

/// Client for the Anthropic Messages API (via proxy).
#[derive(Debug, Clone)]
pub struct ApiClient {
    /// HTTP client for making requests.
    http: reqwest::Client,
    /// Base URL of the proxy (trailing slash stripped).
    base_url: String,
    /// API key sent as `x-api-key` header (may be empty for proxy-managed auth).
    api_key: String,
}

impl ApiClient {
    /// Create a new API client pointing at the configured proxy URL.
    ///
    /// The HTTP client is configured with a timeout derived from `config.timeout_seconds`.
    pub fn new(config: &Config) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(config.timeout_seconds))
            .build()
            .expect("failed to build reqwest client");

        Self {
            http,
            base_url: config.proxy_url.trim_end_matches('/').to_string(),
            api_key: String::new(),
        }
    }

    /// Send a messages API request and return the response.
    ///
    /// The proxy handles model routing based on the `model` field.
    ///
    /// # Errors
    ///
    /// Returns a [`RateLimitError`] (wrapped in `anyhow`) when the proxy responds with HTTP 429,
    /// so callers can apply back-off and retry.  All other non-2xx responses are returned as
    /// plain `anyhow` errors that include the status code and response body.
    pub async fn send_message(&self, request: &MessagesRequest) -> Result<MessagesResponse> {
        let url = format!("{}/v1/messages", self.base_url);

        debug!(
            model = %request.model,
            messages = request.messages.len(),
            tools = request.tools.len(),
            "sending messages API request"
        );

        let response = self
            .http
            .post(&url)
            .header("Content-Type", "application/json")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(request)
            .send()
            .await
            .with_context(|| format!("failed to POST {url}"))?;

        let status = response.status();

        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "<unreadable body>".to_string());
            warn!(%status, "rate limited by proxy");
            return Err(anyhow!(RateLimitError(body)));
        }

        if !status.is_success() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "<unreadable body>".to_string());
            warn!(%status, %body, "proxy returned error");
            return Err(anyhow!("proxy returned HTTP {status}: {body}"));
        }

        let resp: MessagesResponse = response
            .json()
            .await
            .context("failed to deserialize MessagesResponse")?;

        debug!(
            stop_reason = ?resp.stop_reason,
            input_tokens = resp.usage.input_tokens,
            output_tokens = resp.usage.output_tokens,
            cache_read = resp.usage.cache_read_input_tokens,
            cache_creation = resp.usage.cache_creation_input_tokens,
            "received messages API response"
        );

        Ok(resp)
    }
}

/// Error returned when the proxy responds with HTTP 429 (rate limit).
///
/// The inner string is the raw response body from the proxy.  Callers that
/// want to inspect this specifically should downcast the `anyhow::Error`:
///
/// ```rust,ignore
/// if let Some(rle) = err.downcast_ref::<RateLimitError>() { … }
/// ```
#[derive(Debug)]
pub struct RateLimitError(pub String);

impl std::fmt::Display for RateLimitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "rate limited: {}", self.0)
    }
}

impl std::error::Error for RateLimitError {}

/// A request to the Anthropic Messages API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessagesRequest {
    /// The model to use (proxy routes based on this).
    pub model: String,

    /// Maximum tokens to generate.
    pub max_tokens: u32,

    /// System prompt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,

    /// Conversation messages.
    pub messages: Vec<Message>,

    /// Tool definitions available to the model.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolDefinition>,
}

/// A single message in the conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    /// Role: "user" or "assistant".
    pub role: String,

    /// Message content blocks.
    pub content: Vec<ContentBlock>,
}

/// A content block within a message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    /// Plain text content.
    #[serde(rename = "text")]
    Text { text: String },

    /// A tool use request from the assistant.
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },

    /// A tool result from the user.
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        is_error: Option<bool>,
    },
}

/// A tool definition for the API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    /// Tool name.
    pub name: String,

    /// Human-readable description.
    pub description: String,

    /// JSON Schema for the tool's input parameters.
    pub input_schema: serde_json::Value,
}

/// Response from the Messages API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessagesResponse {
    /// Unique response ID.
    pub id: String,

    /// Response content blocks.
    pub content: Vec<ContentBlock>,

    /// Stop reason: "end_turn", "tool_use", "max_tokens".
    pub stop_reason: Option<String>,

    /// Token usage for this response.
    pub usage: Usage,
}

/// Token usage information.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Usage {
    /// Input tokens consumed.
    pub input_tokens: u32,

    /// Output tokens generated.
    pub output_tokens: u32,

    /// Input tokens read from cache (provider prefix caching).
    #[serde(default)]
    pub cache_read_input_tokens: u32,

    /// Input tokens written to cache (first request establishing the cache).
    #[serde(default)]
    pub cache_creation_input_tokens: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── serialization ────────────────────────────────────────────────────────

    #[test]
    fn test_content_block_serialization() {
        let block = ContentBlock::Text {
            text: "hello".to_string(),
        };
        let json = serde_json::to_string(&block).unwrap();
        assert!(json.contains("\"type\":\"text\""));
        assert!(json.contains("\"text\":\"hello\""));
    }

    #[test]
    fn test_tool_use_serialization() {
        let block = ContentBlock::ToolUse {
            id: "tu_1".to_string(),
            name: "search".to_string(),
            input: serde_json::json!({"query": "test"}),
        };
        let json = serde_json::to_string(&block).unwrap();
        assert!(json.contains("\"type\":\"tool_use\""));
        assert!(json.contains("\"name\":\"search\""));
        assert!(json.contains("\"id\":\"tu_1\""));
    }

    #[test]
    fn test_tool_result_serialization() {
        let block = ContentBlock::ToolResult {
            tool_use_id: "tu_1".to_string(),
            content: "42 results".to_string(),
            is_error: None,
        };
        let v: serde_json::Value = serde_json::to_value(&block).unwrap();
        assert_eq!(v["type"], "tool_result");
        assert_eq!(v["tool_use_id"], "tu_1");
        assert_eq!(v["content"], "42 results");
        // is_error omitted when None
        assert!(v.get("is_error").is_none());
    }

    #[test]
    fn test_tool_result_is_error_serialized_when_set() {
        let block = ContentBlock::ToolResult {
            tool_use_id: "tu_2".to_string(),
            content: "boom".to_string(),
            is_error: Some(true),
        };
        let v: serde_json::Value = serde_json::to_value(&block).unwrap();
        assert_eq!(v["is_error"], true);
    }

    #[test]
    fn test_request_serialization_matches_anthropic_format() {
        let req = MessagesRequest {
            model: "glm-4-plus".to_string(),
            max_tokens: 1024,
            system: Some("You are helpful.".to_string()),
            messages: vec![Message {
                role: "user".to_string(),
                content: vec![ContentBlock::Text {
                    text: "Hi".to_string(),
                }],
            }],
            tools: vec![ToolDefinition {
                name: "search".to_string(),
                description: "Search the codebase".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": { "query": { "type": "string" } },
                    "required": ["query"]
                }),
            }],
        };

        let v: serde_json::Value = serde_json::to_value(&req).unwrap();

        assert_eq!(v["model"], "glm-4-plus");
        assert_eq!(v["max_tokens"], 1024);
        assert_eq!(v["system"], "You are helpful.");
        assert_eq!(v["messages"][0]["role"], "user");
        assert_eq!(v["messages"][0]["content"][0]["type"], "text");
        assert_eq!(v["tools"][0]["name"], "search");
        assert_eq!(v["tools"][0]["input_schema"]["type"], "object");
    }

    #[test]
    fn test_request_omits_system_when_none() {
        let req = MessagesRequest {
            model: "glm-4-plus".to_string(),
            max_tokens: 512,
            system: None,
            messages: vec![],
            tools: vec![],
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        // system should be absent, not null
        assert!(v.get("system").is_none());
        // tools should be absent when empty
        assert!(v.get("tools").is_none());
    }

    // ── deserialization ───────────────────────────────────────────────────────

    #[test]
    fn test_response_deserialization_text_only() {
        let json = r#"{
            "id": "msg_abc",
            "type": "message",
            "role": "assistant",
            "content": [{"type": "text", "text": "Hello!"}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 10, "output_tokens": 5}
        }"#;

        let resp: MessagesResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.id, "msg_abc");
        assert_eq!(resp.stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(resp.usage.input_tokens, 10);
        assert_eq!(resp.usage.output_tokens, 5);
        assert_eq!(resp.content.len(), 1);
        match &resp.content[0] {
            ContentBlock::Text { text } => assert_eq!(text, "Hello!"),
            other => panic!("expected Text, got {other:?}"),
        }
    }

    #[test]
    fn test_response_deserialization_tool_use() {
        let json = r#"{
            "id": "msg_xyz",
            "type": "message",
            "role": "assistant",
            "content": [
                {"type": "text", "text": "Let me search for that."},
                {
                    "type": "tool_use",
                    "id": "toolu_001",
                    "name": "search",
                    "input": {"query": "anyhow crate"}
                }
            ],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 20, "output_tokens": 15}
        }"#;

        let resp: MessagesResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.stop_reason.as_deref(), Some("tool_use"));
        assert_eq!(resp.content.len(), 2);
        match &resp.content[1] {
            ContentBlock::ToolUse { id, name, input } => {
                assert_eq!(id, "toolu_001");
                assert_eq!(name, "search");
                assert_eq!(input["query"], "anyhow crate");
            }
            other => panic!("expected ToolUse, got {other:?}"),
        }
    }

    #[test]
    fn test_response_deserialization_missing_stop_reason() {
        // stop_reason is optional; API may omit it in some cases.
        let json = r#"{
            "id": "msg_nsr",
            "type": "message",
            "role": "assistant",
            "content": [],
            "usage": {"input_tokens": 1, "output_tokens": 0}
        }"#;

        let resp: MessagesResponse = serde_json::from_str(json).unwrap();
        assert!(resp.stop_reason.is_none());
    }

    // ── error handling ────────────────────────────────────────────────────────

    #[test]
    fn test_rate_limit_error_display() {
        let err = RateLimitError("retry after 60s".to_string());
        assert!(err.to_string().contains("rate limited"));
        assert!(err.to_string().contains("retry after 60s"));
    }

    #[test]
    fn test_rate_limit_error_is_std_error() {
        let err: Box<dyn std::error::Error> = Box::new(RateLimitError("x".to_string()));
        assert!(err.to_string().contains("rate limited"));
    }

    #[test]
    fn test_rate_limit_error_downcast_from_anyhow() {
        let anyhow_err = anyhow!(RateLimitError("quota exceeded".to_string()));
        assert!(anyhow_err.downcast_ref::<RateLimitError>().is_some());
    }
}
