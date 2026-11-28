//! Shared payload building blocks (`$defs` of the schema that more than one payload uses).
//!
//! Field order follows the schema so a reviewer can diff the two side by side.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::PayloadRules;
use crate::enums::{InterruptionReason, ResumePhase};
use crate::ids::{OperationId, SessionId, Sha256Hex, SummaryId, TaskId, TurnId, UsageId};
use crate::time::Timestamp;

/// Rule texts. One `&'static str` per rule; tests match on these constants.
pub mod rule {
    pub const QUOTA_KEY: &str =
        "a key names a subscription quota or balance (quota-name deny-list)";
    pub const RETRY_HINT_TIME: &str =
        "retry_hint: not_before must be present unless source is unknown, and absent when it is";
    pub const INTERRUPTION_HOST_CRASH_ARMED: &str =
        "interruption: a host_crashed interruption must not be auto_resume_armed";
    pub const INTERRUPTION_ARMED: &str = "interruption: auto_resume_armed requires reason quota_exhausted or rate_limited and a retry_hint from provider_reported or user_configured";
    pub const FAILURE_CODE: &str = "failure: code must match ^[a-z][a-z0-9_]{0,63}$";
    pub const TEXT_OR_REF: &str = "text_or_ref: exactly one of text and text_ref must be present";
    pub const ACP_OPTIONS_EMPTY: &str = "acp: options must not be empty";
    pub const CAPS_TRACK: &str =
        "capability snapshot: only track v1_stable is covered by this contract revision";
    pub const CAPS_FEATURES: &str =
        "capability snapshot: features do not match acp_agent_capabilities";
    pub const CAPS_META: &str =
        "capability snapshot: acp_agent_capabilities must be stored without _meta keys";
    pub const CAPS_OPT_IN: &str =
        "capability snapshot: unstable_opt_ins entries must match ^[a-z][a-z0-9_]{0,63}$";
    pub const USAGE_UNKNOWN: &str =
        "usage: source unknown requires reporter none and no tokens, context_window or cost";
    pub const USAGE_ESTIMATED: &str = "usage: source locally_estimated requires an estimator, reporter host_estimator and (if present) cost basis estimated";
    pub const USAGE_REPORTED: &str = "usage: source provider_reported forbids an estimator, requires reporter acp_usage_update, provider_api or adapter_output and (if present) cost basis reported";
    pub const COST_AMOUNT: &str = "usage: cost amount must be a non-negative number";
}

string_enum!(
    /// Where a time hint came from. `Unknown` means no reliable source; the hint then carries no time.
    HintSource { ProviderReported, UserConfigured, Unknown }
);
string_enum!(
    /// ACP v1 `StopReason`, copied verbatim.
    AcpStopReason { EndTurn, MaxTokens, MaxTurnRequests, Refusal, Cancelled }
);
string_enum!(
    /// ACP v1 `PermissionOptionKind`, copied verbatim.
    AcpPermissionOptionKind { AllowOnce, AllowAlways, RejectOnce, RejectAlways }
);
string_enum!(UsageSource {
    ProviderReported,
    LocallyEstimated,
    Unknown
});
string_enum!(UsageReporter {
    AcpUsageUpdate,
    ProviderApi,
    AdapterOutput,
    HostEstimator,
    None
});
string_enum!(
    /// `snapshot`: point in time; `cumulative`: running total; `increment`: delta for one turn.
    UsageScope { Snapshot, Cumulative, Increment }
);
string_enum!(CostBasis {
    Reported,
    Estimated
});
string_enum!(SummarySource {
    AgentGenerated,
    HostGenerated,
    UserWritten
});
string_enum!(SummaryPurpose {
    Interruption,
    Handoff,
    Completion
});
string_enum!(AcknowledgementMethod {
    Opened,
    MarkedReviewed,
    BulkMarkedReviewed
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetryHint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_before: Option<Timestamp>,
    pub source: HintSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl PayloadRules for RetryHint {
    fn validate(&self) -> Result<(), &'static str> {
        // Schema: `source == unknown` => no not_before, else not_before required.
        if (self.source == HintSource::Unknown) == self.not_before.is_some() {
            return Err(rule::RETRY_HINT_TIME);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Interruption {
    pub reason: InterruptionReason,
    pub phase: ResumePhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_hint: Option<RetryHint>,
    pub auto_resume_armed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_id: Option<SummaryId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_operation_ids: Option<Vec<OperationId>>,
}

impl PayloadRules for Interruption {
    fn validate(&self) -> Result<(), &'static str> {
        // Crash recovery never arms an auto-resume (checkpoint-and-replay.md, recovery step 8).
        if self.reason == InterruptionReason::HostCrashed && self.auto_resume_armed {
            return Err(rule::INTERRUPTION_HOST_CRASH_ARMED);
        }
        if self.auto_resume_armed {
            let reason_ok = matches!(
                self.reason,
                InterruptionReason::QuotaExhausted | InterruptionReason::RateLimited
            );
            let hint_ok = self.retry_hint.as_ref().is_some_and(|h| {
                matches!(
                    h.source,
                    HintSource::ProviderReported | HintSource::UserConfigured
                )
            });
            if !reason_ok || !hint_ok {
                return Err(rule::INTERRUPTION_ARMED);
            }
        }
        if let Some(hint) = &self.retry_hint {
            hint.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Failure {
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// `^[a-z][a-z0-9_]{0,63}$`, checked by hand (no regex dependency).
pub(crate) fn is_snake_name(s: &str) -> bool {
    let bytes = s.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_')
}

impl PayloadRules for Failure {
    fn validate(&self) -> Result<(), &'static str> {
        if !is_snake_name(&self.code) {
            return Err(rule::FAILURE_CODE);
        }
        Ok(())
    }
}

/// Pointer to content moved out of the event row. `path` is a `RelativePath`; only its shape is
/// a schema concern, real path safety is P4-1.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactRef {
    pub path: String,
    pub sha256: Sha256Hex,
    pub bytes: u64,
}

/// Inline redacted text, or a reference to it after retention compaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextOrRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_ref: Option<ArtifactRef>,
}

impl PayloadRules for TextOrRef {
    fn validate(&self) -> Result<(), &'static str> {
        if self.text.is_some() == self.text_ref.is_some() {
            return Err(rule::TEXT_OR_REF);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpPermissionOption {
    pub option_id: String,
    pub kind: AcpPermissionOptionKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpPermissionContext {
    pub tool_call_id: String,
    pub options: Vec<AcpPermissionOption>,
}

impl PayloadRules for AcpPermissionContext {
    fn validate(&self) -> Result<(), &'static str> {
        if self.options.is_empty() {
            return Err(rule::ACP_OPTIONS_EMPTY);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// Capability snapshot
// ---------------------------------------------------------------------------------------------

string_enum!(CapabilityProtocol { Acp });
string_enum!(
    /// `V2Draft` is accepted by the schema but not by this contract revision (`CapabilitySnapshot.track`).
    CapabilityTrack { V1Stable, V2Draft }
);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityFeatures {
    pub load_session: bool,
    pub resume_session: bool,
    pub close_session: bool,
    pub list_sessions: bool,
    pub delete_session: bool,
    pub additional_directories: bool,
    pub system_prompt: bool,
    pub prompt_image: bool,
    pub prompt_audio: bool,
    pub prompt_embedded_context: bool,
    pub mcp_http: bool,
    pub mcp_sse: bool,
    pub logout: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientAdvertised {
    pub fs_read_text_file: bool,
    pub fs_write_text_file: bool,
    pub terminal: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elicitation: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notices: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction: Option<bool>,
}

/// What the adapter advertised in the ACP `initialize` response for one agent process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilitySnapshot {
    pub protocol: CapabilityProtocol,
    pub protocol_version: u16,
    pub track: CapabilityTrack,
    pub detected_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_info: Option<AgentInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_method_ids: Option<Vec<String>>,
    /// The `agentCapabilities` object as received, with every `_meta` key removed. Opaque.
    pub acp_agent_capabilities: Map<String, Value>,
    pub features: CapabilityFeatures,
    pub client_advertised: ClientAdvertised,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unstable_opt_ins: Option<Vec<String>>,
}

impl PayloadRules for CapabilitySnapshot {
    fn validate(&self) -> Result<(), &'static str> {
        if self.track != CapabilityTrack::V1Stable {
            return Err(rule::CAPS_TRACK);
        }
        if self.features != derive_from_map(&self.acp_agent_capabilities) {
            return Err(rule::CAPS_FEATURES);
        }
        if self
            .acp_agent_capabilities
            .iter()
            .any(|(k, v)| k == "_meta" || contains_key(v, "_meta"))
        {
            return Err(rule::CAPS_META);
        }
        if let Some(opt_ins) = &self.unstable_opt_ins {
            if !opt_ins.iter().all(|name| is_snake_name(name)) {
                return Err(rule::CAPS_OPT_IN);
            }
        }
        Ok(())
    }
}

fn derive_from_map(raw: &Map<String, Value>) -> CapabilityFeatures {
    derive_features(&Value::Object(raw.clone()))
}

/// Derives `features` from ACP v1 `agentCapabilities`
/// (`docs/contracts/acp-capabilities.md`, `validate_fixtures.py` `derive_features`).
/// Absent or malformed means false: `loadSession` and the prompt/mcp flags must be the boolean
/// `true`; the `sessionCapabilities.*` and `auth.logout` entries must be JSON objects.
pub fn derive_features(raw_agent_capabilities: &Value) -> CapabilityFeatures {
    fn child<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
        v.as_object().and_then(|o| o.get(key))
    }
    fn is_true(v: &Value, key: &str) -> bool {
        child(v, key) == Some(&Value::Bool(true))
    }
    fn is_obj(v: &Value, key: &str) -> bool {
        child(v, key).is_some_and(Value::is_object)
    }
    let null = Value::Null;
    let sc = child(raw_agent_capabilities, "sessionCapabilities").unwrap_or(&null);
    let pc = child(raw_agent_capabilities, "promptCapabilities").unwrap_or(&null);
    let mc = child(raw_agent_capabilities, "mcpCapabilities").unwrap_or(&null);
    let au = child(raw_agent_capabilities, "auth").unwrap_or(&null);
    CapabilityFeatures {
        load_session: is_true(raw_agent_capabilities, "loadSession"),
        resume_session: is_obj(sc, "resume"),
        close_session: is_obj(sc, "close"),
        list_sessions: is_obj(sc, "list"),
        delete_session: is_obj(sc, "delete"),
        additional_directories: is_obj(sc, "additionalDirectories"),
        system_prompt: is_obj(sc, "systemPrompt"),
        prompt_image: is_true(pc, "image"),
        prompt_audio: is_true(pc, "audio"),
        prompt_embedded_context: is_true(pc, "embeddedContext"),
        mcp_http: is_true(mc, "http"),
        mcp_sse: is_true(mc, "sse"),
        logout: is_obj(au, "logout"),
    }
}

// ---------------------------------------------------------------------------------------------
// Walks over opaque JSON (iterative: a programmatically built value may be deeper than the
// 1 MiB debug-build stack tolerates for recursion, CONVENTIONS section 7)
// ---------------------------------------------------------------------------------------------

/// Calls `f` for every object key at any depth (arrays are traversed); stops at the first `Some`.
fn find_key<T>(value: &Value, mut f: impl FnMut(&str) -> Option<T>) -> Option<T> {
    let mut stack = vec![value];
    while let Some(v) = stack.pop() {
        match v {
            Value::Object(map) => {
                for (key, child) in map {
                    if let Some(found) = f(key) {
                        return Some(found);
                    }
                    stack.push(child);
                }
            }
            Value::Array(items) => stack.extend(items.iter()),
            _ => {}
        }
    }
    None
}

fn contains_key(value: &Value, name: &str) -> bool {
    find_key(value, |k| (k == name).then_some(())).is_some()
}

/// Quota-name deny-list (`validate_fixtures.py` `FORBIDDEN_NAME`), applied to a single key,
/// case-insensitively: it contains `remaining`, `_left`, `left_`, `balance`, `allowance`,
/// `percent`, `pct`, or `quota` unless that `quota` is the start of a final `quota_reset`.
fn is_forbidden_quota_name(key: &str) -> bool {
    let lower = key.to_lowercase();
    const PLAIN: [&str; 7] = [
        "remaining",
        "_left",
        "left_",
        "balance",
        "allowance",
        "percent",
        "pct",
    ];
    if PLAIN.iter().any(|needle| lower.contains(needle)) {
        return true;
    }
    lower
        .match_indices("quota")
        .any(|(at, needle)| &lower[at + needle.len()..] != "_reset")
}

/// Returns the first key (any depth, arrays included) that matches the quota-name deny-list.
/// AgentDock cannot know a subscription balance, so no payload may carry a field that names one;
/// a key ending in `quota_reset` (the `on_quota_reset` policy flag) is the only exception.
pub fn forbidden_quota_key(value: &Value) -> Option<String> {
    find_key(value, |k| is_forbidden_quota_name(k).then(|| k.to_owned()))
}

// ---------------------------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenCounts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<u64>,
}

/// Maps ACP v1 `UsageUpdate.used` / `.size`. Describes the model context, not any subscription.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextWindow {
    pub used: u64,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cost {
    /// A JSON number kept as written (`37` stays `37`, not `37.0`), so a stored event
    /// re-encodes to the same value. Never used for money arithmetic (`unit` may be `credits`).
    pub amount: serde_json::Number,
    pub unit: String,
    pub basis: CostBasis,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Estimator {
    pub id: String,
    pub version: String,
}

/// One usage observation. There is deliberately no field for remaining subscription quota.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    pub usage_id: UsageId,
    pub task_id: TaskId,
    pub session_id: SessionId,
    pub source: UsageSource,
    pub reporter: UsageReporter,
    pub measured_at: Timestamp,
    pub scope: UsageScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokenCounts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<ContextWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<Cost>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimator: Option<Estimator>,
}

impl PayloadRules for Usage {
    /// The three `allOf` clauses of schema `Usage`, one per `source`.
    fn validate(&self) -> Result<(), &'static str> {
        if let Some(cost) = &self.cost {
            if !cost
                .amount
                .as_f64()
                .is_some_and(|a| a.is_finite() && a >= 0.0)
            {
                return Err(rule::COST_AMOUNT);
            }
        }
        let basis = self.cost.as_ref().map(|c| c.basis);
        match self.source {
            UsageSource::Unknown => {
                if self.reporter != UsageReporter::None
                    || self.tokens.is_some()
                    || self.context_window.is_some()
                    || self.cost.is_some()
                {
                    return Err(rule::USAGE_UNKNOWN);
                }
            }
            UsageSource::LocallyEstimated => {
                if self.estimator.is_none()
                    || self.reporter != UsageReporter::HostEstimator
                    || basis.is_some_and(|b| b != CostBasis::Estimated)
                {
                    return Err(rule::USAGE_ESTIMATED);
                }
            }
            UsageSource::ProviderReported => {
                let reporter_ok = matches!(
                    self.reporter,
                    UsageReporter::AcpUsageUpdate
                        | UsageReporter::ProviderApi
                        | UsageReporter::AdapterOutput
                );
                if self.estimator.is_some()
                    || !reporter_ok
                    || basis.is_some_and(|b| b != CostBasis::Reported)
                {
                    return Err(rule::USAGE_REPORTED);
                }
            }
        }
        Ok(())
    }
}
