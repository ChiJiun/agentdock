//! `session.*` payloads.

use serde::{Deserialize, Serialize};

use super::common::{
    AcknowledgementMethod, AcpStopReason, ArtifactRef, CapabilitySnapshot, Failure, SummaryPurpose,
    SummarySource, TextOrRef,
};
use super::PayloadRules;
use crate::enums::{LaunchMethod, SessionOutcome, SessionRole, SessionState, SessionTrigger};
use crate::ids::{AdapterId, ApprovalId, SessionId, SummaryId, TurnId};

pub mod rule {
    pub const CREATED_EXTERNAL_ID: &str =
        "session.created: launch_method load/resume requires external_session_id";
    pub const TURN_ENDED: &str =
        "session.state_changed: trigger turn_ended requires stop_reason and turn_id";
    pub const REATTACH: &str =
        "session.state_changed: trigger reattach_attempt requires launch_method load or resume";
    pub const PROMPT_TURN: &str =
        "session.state_changed: trigger prompt_submitted/continue_prompt requires turn_id";
    pub const PERMISSION_REQUESTED: &str =
        "session.state_changed: trigger permission_requested requires approval_id";
    pub const FINAL_OUTCOME: &str = "session.state_changed: to closed/failed requires outcome";
    pub const FAILED_OUTCOME: &str =
        "session.state_changed: to failed requires outcome failed or cancelled";
    pub const PERMISSION_RESOLVED: &str =
        "session.state_changed: awaiting_permission to active requires approval_id";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionCreatedPayload {
    pub role: SessionRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<SessionId>,
    pub adapter_id: AdapterId,
    pub launch_method: LaunchMethod,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes_session_id: Option<SessionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff_summary_id: Option<SummaryId>,
}

impl PayloadRules for SessionCreatedPayload {
    fn validate(&self) -> Result<(), &'static str> {
        if matches!(
            self.launch_method,
            LaunchMethod::Load | LaunchMethod::Resume
        ) && self.external_session_id.is_none()
        {
            return Err(rule::CREATED_EXTERNAL_ID);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionCapabilitiesDetectedPayload {
    pub snapshot: CapabilitySnapshot,
}

impl PayloadRules for SessionCapabilitiesDetectedPayload {
    fn validate(&self) -> Result<(), &'static str> {
        self.snapshot.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionStateChangedPayload {
    pub from: SessionState,
    pub to: SessionState,
    pub trigger: SessionTrigger,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<AcpStopReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_method: Option<LaunchMethod>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<ApprovalId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<SessionOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<Failure>,
}

impl PayloadRules for SessionStateChangedPayload {
    /// Schema `SessionStateChangedPayload.allOf`: 7 clauses, in schema order.
    fn validate(&self) -> Result<(), &'static str> {
        use SessionState as S;
        use SessionTrigger as T;
        // 1. turn_ended => stop_reason and turn_id
        if self.trigger == T::TurnEnded && (self.stop_reason.is_none() || self.turn_id.is_none()) {
            return Err(rule::TURN_ENDED);
        }
        // 2. reattach_attempt => launch_method in {load, resume}
        if self.trigger == T::ReattachAttempt
            && !matches!(
                self.launch_method,
                Some(LaunchMethod::Load | LaunchMethod::Resume)
            )
        {
            return Err(rule::REATTACH);
        }
        // 3. prompt_submitted / continue_prompt => turn_id
        if matches!(self.trigger, T::PromptSubmitted | T::ContinuePrompt) && self.turn_id.is_none()
        {
            return Err(rule::PROMPT_TURN);
        }
        // 4. permission_requested => approval_id
        if self.trigger == T::PermissionRequested && self.approval_id.is_none() {
            return Err(rule::PERMISSION_REQUESTED);
        }
        // 5. to closed / failed => outcome
        if matches!(self.to, S::Closed | S::Failed) && self.outcome.is_none() {
            return Err(rule::FINAL_OUTCOME);
        }
        // 6. to failed => outcome in {failed, cancelled} (mutation r4_failed_session_claims_success)
        if self.to == S::Failed
            && !matches!(
                self.outcome,
                Some(SessionOutcome::Failed | SessionOutcome::Cancelled)
            )
        {
            return Err(rule::FAILED_OUTCOME);
        }
        // 7. awaiting_permission -> active => approval_id
        if self.from == S::AwaitingPermission && self.to == S::Active && self.approval_id.is_none()
        {
            return Err(rule::PERMISSION_RESOLVED);
        }
        if let Some(error) = &self.error {
            error.validate()?;
        }
        Ok(())
    }
}

string_enum!(PromptOrigin {
    User,
    Orchestrator,
    Handoff
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionPromptSubmittedPayload {
    pub turn_id: TurnId,
    pub origin: PromptOrigin,
    pub content: TextOrRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff_summary_id: Option<SummaryId>,
}

impl PayloadRules for SessionPromptSubmittedPayload {
    fn validate(&self) -> Result<(), &'static str> {
        self.content.validate()
    }
}

string_enum!(MessageChannel {
    AgentMessage,
    AgentThought,
    UserMessage
});

/// Coalesced ACP `agent_message_chunk` / `agent_thought_chunk` / `user_message_chunk` text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionMessageDeltaPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    pub channel: MessageChannel,
    pub content: TextOrRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coalesced_chunks: Option<u64>,
}

impl PayloadRules for SessionMessageDeltaPayload {
    fn validate(&self) -> Result<(), &'static str> {
        self.content.validate()
    }
}

string_enum!(ToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Think,
    Fetch,
    SwitchMode,
    Other
});
string_enum!(ToolStatus {
    Pending,
    InProgress,
    Completed,
    Failed
});

/// Maps ACP `tool_call` and `tool_call_update`. rawInput/rawOutput go through redaction into an
/// artifact (`raw_io`), never inline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionToolCallPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    pub tool_call_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ToolKind>,
    pub status: ToolStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locations: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<ApprovalId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_io: Option<ArtifactRef>,
}

impl PayloadRules for SessionToolCallPayload {}

string_enum!(PlanPriority { High, Medium, Low });
string_enum!(PlanStatus {
    Pending,
    InProgress,
    Completed
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanEntry {
    pub content: String,
    pub priority: PlanPriority,
    pub status: PlanStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionPlanUpdatedPayload {
    pub entries: Vec<PlanEntry>,
}

impl PayloadRules for SessionPlanUpdatedPayload {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionSummaryRecordedPayload {
    pub summary_id: SummaryId,
    pub source: SummarySource,
    pub purpose: SummaryPurpose,
    pub through_seq: u64,
    pub content: TextOrRef,
}

impl PayloadRules for SessionSummaryRecordedPayload {
    fn validate(&self) -> Result<(), &'static str> {
        self.content.validate()
    }
}

string_enum!(OutputLimit {
    MaxTurnBytes,
    MaxTurnEvents,
    MaxMessageBytes
});
string_enum!(OutputLimitAction {
    Truncated,
    TurnCancelled
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionOutputLimitedPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    pub limit: OutputLimit,
    pub action: OutputLimitAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dropped_bytes: Option<u64>,
}

impl PayloadRules for SessionOutputLimitedPayload {}

/// The user viewed a finished session's result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionResultAcknowledgedPayload {
    pub method: AcknowledgementMethod,
}

impl PayloadRules for SessionResultAcknowledgedPayload {}

string_enum!(ArchivedBy { User, Auto });
string_enum!(UnarchivedBy { User, System });

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionArchivedPayload {
    pub by: ArchivedBy,
}

impl PayloadRules for SessionArchivedPayload {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionUnarchivedPayload {
    pub by: UnarchivedBy,
}

impl PayloadRules for SessionUnarchivedPayload {}
