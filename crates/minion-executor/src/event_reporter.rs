//! Dispatch event reporting for agentboard swarm execution.

use std::time::Duration;

use serde::Serialize;
use tracing::{debug, warn};

/// Reports dispatch events to the agentboard swarm API.
#[derive(Clone)]
pub struct EventReporter {
    http_client: Option<reqwest::Client>,
    base_url: String,
    enabled: bool,
}

/// Swarm event types matching the TypeScript SwarmEvent union.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SwarmEvent {
    GroupStarted {
        #[serde(rename = "groupId")]
        group_id: String,
        timestamp: String,
        #[serde(rename = "totalWos")]
        total_wos: usize,
        #[serde(rename = "woIds")]
        wo_ids: Vec<String>,
        edges: Vec<DependencyEdge>,
    },
    WoStatusChanged {
        #[serde(rename = "groupId")]
        group_id: String,
        timestamp: String,
        #[serde(rename = "woId")]
        wo_id: String,
        #[serde(rename = "oldStatus")]
        old_status: String,
        #[serde(rename = "newStatus")]
        new_status: String,
        model: String,
        attempt: u32,
        tier: u32,
    },
    WoCompleted {
        #[serde(rename = "groupId")]
        group_id: String,
        timestamp: String,
        #[serde(rename = "woId")]
        wo_id: String,
        #[serde(rename = "tokenUsage")]
        token_usage: TokenUsageSummary,
        #[serde(rename = "gateResults")]
        gate_results: Option<GateResultSummary>,
        #[serde(rename = "filesChanged")]
        files_changed: Vec<String>,
        #[serde(rename = "durationSeconds")]
        duration_seconds: f64,
    },
    WoFailed {
        #[serde(rename = "groupId")]
        group_id: String,
        timestamp: String,
        #[serde(rename = "woId")]
        wo_id: String,
        error: String,
        #[serde(rename = "gateDetail")]
        gate_detail: Option<String>,
        model: String,
        attempt: u32,
        tier: u32,
    },
    WoEscalated {
        #[serde(rename = "groupId")]
        group_id: String,
        timestamp: String,
        #[serde(rename = "woId")]
        wo_id: String,
        #[serde(rename = "fromTier")]
        from_tier: u32,
        #[serde(rename = "toTier")]
        to_tier: u32,
        #[serde(rename = "toModel")]
        to_model: String,
        #[serde(rename = "errorHistory")]
        error_history: Vec<ErrorHistoryEntrySummary>,
    },
    GroupCompleted {
        #[serde(rename = "groupId")]
        group_id: String,
        timestamp: String,
        status: String,
        #[serde(rename = "totalDurationSeconds")]
        total_duration_seconds: f64,
        #[serde(rename = "completedWos")]
        completed_wos: u32,
        #[serde(rename = "failedWos")]
        failed_wos: u32,
        #[serde(rename = "totalTokens")]
        total_tokens: TokenUsageSummary,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct DependencyEdge {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TokenUsageSummary {
    #[serde(rename = "inputTokens")]
    pub input_tokens: u32,
    #[serde(rename = "outputTokens")]
    pub output_tokens: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct GateResultSummary {
    #[serde(rename = "allPassed")]
    pub all_passed: bool,
    pub gates: Vec<GateEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GateEntry {
    pub name: String,
    pub passed: bool,
    pub output: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorHistoryEntrySummary {
    pub tier: u32,
    pub model: String,
    pub attempt: u32,
    pub error: String,
    #[serde(rename = "gateDetail")]
    pub gate_detail: Option<String>,
}

impl EventReporter {
    /// Create a new reporter. If base_url is None, reporting is disabled (no-op).
    pub fn new(base_url: Option<&str>) -> Self {
        let normalized = base_url
            .unwrap_or_default()
            .trim_end_matches('/')
            .to_string();
        let enabled = !normalized.is_empty();
        let http_client = enabled.then(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .expect("failed to build event reporter HTTP client")
        });

        Self {
            http_client,
            base_url: normalized,
            enabled,
        }
    }

    /// Create a disabled reporter (no-op for all calls).
    pub fn disabled() -> Self {
        Self::new(None)
    }

    /// Report an event. Fire-and-forget: errors are logged but never propagated.
    /// This must never block or fail the dispatch loop.
    pub async fn report(&self, event: SwarmEvent) {
        if !self.enabled {
            return;
        }

        let Some(http_client) = &self.http_client else {
            return;
        };
        let url = format!("{}/api/swarm/events", self.base_url);
        match http_client.post(&url).json(&event).send().await {
            Ok(resp) if resp.status().is_success() => {
                debug!("Swarm event reported successfully");
            }
            Ok(resp) => {
                warn!(status = %resp.status(), "Swarm event report got non-2xx");
            }
            Err(e) => {
                warn!(error = %e, "Failed to report swarm event (non-fatal)");
            }
        }
    }

    /// Helper: get current ISO timestamp.
    pub fn now_iso() -> String {
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_disabled_reporter_is_noop() {
        let reporter = EventReporter::disabled();
        reporter
            .report(SwarmEvent::GroupStarted {
                group_id: "group-1".to_string(),
                timestamp: EventReporter::now_iso(),
                total_wos: 1,
                wo_ids: vec!["wo-1".to_string()],
                edges: vec![],
            })
            .await;
    }

    #[test]
    fn test_event_serialization() {
        let event = SwarmEvent::WoCompleted {
            group_id: "group-1".to_string(),
            timestamp: "2026-03-25T10:11:12.345Z".to_string(),
            wo_id: "wo-7".to_string(),
            token_usage: TokenUsageSummary {
                input_tokens: 12,
                output_tokens: 34,
            },
            gate_results: Some(GateResultSummary {
                all_passed: true,
                gates: vec![GateEntry {
                    name: "test".to_string(),
                    passed: true,
                    output: Some("ok".to_string()),
                }],
            }),
            files_changed: vec!["src/lib.rs".to_string()],
            duration_seconds: 9.5,
        };

        let serialized = serde_json::to_value(event).expect("event should serialize");
        assert_eq!(
            serialized,
            json!({
                "type": "wo_completed",
                "groupId": "group-1",
                "timestamp": "2026-03-25T10:11:12.345Z",
                "woId": "wo-7",
                "tokenUsage": {
                    "inputTokens": 12,
                    "outputTokens": 34,
                },
                "gateResults": {
                    "allPassed": true,
                    "gates": [
                        {
                            "name": "test",
                            "passed": true,
                            "output": "ok",
                        }
                    ],
                },
                "filesChanged": ["src/lib.rs"],
                "durationSeconds": 9.5,
            })
        );
    }

    #[test]
    fn test_now_iso_format() {
        let timestamp = EventReporter::now_iso();
        let parsed = chrono::DateTime::parse_from_rfc3339(&timestamp)
            .expect("timestamp should be valid RFC3339");

        assert_eq!(
            parsed.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            timestamp
        );
        assert!(timestamp.ends_with('Z'));
    }
}
