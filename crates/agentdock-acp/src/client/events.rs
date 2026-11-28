//! AgentDock-owned types the facade emits and accepts (P3-4 §4). No SDK type is public.

use agent_client_protocol::v1::schema::{
    PermissionOption, PermissionOptionKind, StopReason as SdkStopReason,
};

/// The agent's `sessionId` (contract: `external_session_id`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct AcpSessionId(pub String);

/// Facade-local permission handle: monotonically increasing per connection, never reused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PermissionTicket(pub u64);

#[derive(Debug, Clone, PartialEq)]
pub struct PermissionOptionView {
    /// The agent's `optionId`; the only value `respond_permission` accepts.
    pub option_id: String,
    /// Agent-chosen label; untrusted, never used to decide anything.
    pub name: String,
    pub kind: PermissionKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
    /// A kind this SDK version does not know (the schema enum is `#[non_exhaustive]`).
    Unknown,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AcpEvent {
    /// Raw `params.update` object of a `session/update` notification, re-serialized from the
    /// SDK type. Untrusted agent data.
    SessionUpdate {
        session: AcpSessionId,
        update: serde_json::Value,
    },
    /// The session's one forwarded permission request. Answer it with
    /// `AcpConnection::respond_permission` only after `approval.resolved` is persisted.
    PermissionRequested {
        ticket: PermissionTicket,
        session: AcpSessionId,
        /// Raw `toolCall`, re-serialized from the SDK type; untrusted agent data.
        tool_call: serde_json::Value,
        options: Vec<PermissionOptionView>,
    },
    /// Emitted exactly once per connection, as the last event.
    Closed { reason: CloseReason },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseReason {
    /// The agent process exited (`code` is `None` when it was ended by a signal).
    ProcessExited { code: Option<i32> },
    /// The connection ended for another reason: a transport or protocol failure, or the agent
    /// closed stdout without exiting. Holds the SDK error code and message, never agent data.
    ProtocolError(String),
    /// The agent wrote a line above the framing cap (P3-1).
    LineTooLong,
    /// `AcpConnection::shutdown` (or dropping the connection) ended it.
    ShutDown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    MaxTurnRequests,
    Refusal,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionDecision {
    /// Must be one of the request's `optionId`s.
    Selected {
        option_id: String,
    },
    Cancelled,
}

pub(crate) fn stop_reason_from_sdk(reason: SdkStopReason) -> Option<StopReason> {
    match reason {
        SdkStopReason::EndTurn => Some(StopReason::EndTurn),
        SdkStopReason::MaxTokens => Some(StopReason::MaxTokens),
        SdkStopReason::MaxTurnRequests => Some(StopReason::MaxTurnRequests),
        SdkStopReason::Refusal => Some(StopReason::Refusal),
        SdkStopReason::Cancelled => Some(StopReason::Cancelled),
        _ => None,
    }
}

pub(crate) fn option_view(option: &PermissionOption) -> PermissionOptionView {
    let kind = match option.kind {
        PermissionOptionKind::AllowOnce => PermissionKind::AllowOnce,
        PermissionOptionKind::AllowAlways => PermissionKind::AllowAlways,
        PermissionOptionKind::RejectOnce => PermissionKind::RejectOnce,
        PermissionOptionKind::RejectAlways => PermissionKind::RejectAlways,
        _ => PermissionKind::Unknown,
    };
    PermissionOptionView {
        option_id: option.option_id.0.to_string(),
        name: option.name.clone(),
        kind,
    }
}
