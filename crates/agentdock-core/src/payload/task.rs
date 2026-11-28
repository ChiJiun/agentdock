//! `task.*` payloads.

use serde::{Deserialize, Serialize};

use super::common::{AcknowledgementMethod, Failure, Interruption};
use super::PayloadRules;
use crate::enums::{ApprovalReturnState, ResumePhase, TaskState, TaskTrigger};
use crate::ids::{ApprovalId, CheckpointId, GitSha, OperationId, Sha256Hex};

pub mod rule {
    pub const CREATED_STATE: &str = "task.created: state must be queued";
    pub const INTERRUPTION: &str =
        "task.state_changed: interruption is required exactly when to is interrupted";
    pub const FAILURE: &str = "task.state_changed: failure is required exactly when to is failed";
    pub const AWAITING_APPROVAL_TO: &str =
        "task.state_changed: entering awaiting_approval requires return_state and approval_id";
    pub const AWAITING_APPROVAL_FROM: &str =
        "task.state_changed: leaving awaiting_approval requires approval_id";
    pub const PREPARING_RESUME_PHASE: &str =
        "task.state_changed: preparing to verifying/review/pr/ci requires resume_phase";
    pub const RESUME_REQUIRES_PHASE: &str =
        "task.state_changed: interrupted to queued requires resume_phase";
    pub const RETRY_WITH_RESUME_PHASE: &str =
        "task.state_changed: failed to queued (retry) must not carry resume_phase";
}

/// User opt-in for unattended resume. Crash-related interruptions are never auto-resumed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutoResumePolicy {
    pub on_quota_reset: bool,
    pub on_rate_limit: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskCreatedPayload {
    pub objective: String,
    /// Must be `Queued` (schema `const`), enforced by `validate()`.
    pub state: TaskState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    pub auto_resume_policy: AutoResumePolicy,
}

impl PayloadRules for TaskCreatedPayload {
    fn validate(&self) -> Result<(), &'static str> {
        if self.state != TaskState::Queued {
            return Err(rule::CREATED_STATE);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskStateChangedPayload {
    pub from: TaskState,
    pub to: TaskState,
    pub trigger: TaskTrigger,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_phase: Option<ResumePhase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub return_state: Option<ApprovalReturnState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<ApprovalId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interruption: Option<Interruption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<Failure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_id: Option<CheckpointId>,
}

impl PayloadRules for TaskStateChangedPayload {
    /// Schema `TaskStateChangedPayload.allOf`: 7 clauses (count pinned by `payload_schema_sync::allof_clause_counts_match_the_transcription`).
    fn validate(&self) -> Result<(), &'static str> {
        use TaskState as S;
        // 1. interruption <=> to == interrupted
        if (self.to == S::Interrupted) != self.interruption.is_some() {
            return Err(rule::INTERRUPTION);
        }
        // 2. failure <=> to == failed
        if (self.to == S::Failed) != self.failure.is_some() {
            return Err(rule::FAILURE);
        }
        // 3. to == awaiting_approval => return_state and approval_id
        if self.to == S::AwaitingApproval
            && (self.return_state.is_none() || self.approval_id.is_none())
        {
            return Err(rule::AWAITING_APPROVAL_TO);
        }
        // 4. from == awaiting_approval => approval_id
        if self.from == S::AwaitingApproval && self.approval_id.is_none() {
            return Err(rule::AWAITING_APPROVAL_FROM);
        }
        // 5. preparing -> verifying/review/pr/ci => resume_phase
        if self.from == S::Preparing
            && matches!(self.to, S::Verifying | S::Review | S::Pr | S::Ci)
            && self.resume_phase.is_none()
        {
            return Err(rule::PREPARING_RESUME_PHASE);
        }
        // 6. interrupted -> queued => resume_phase
        if self.from == S::Interrupted && self.to == S::Queued && self.resume_phase.is_none() {
            return Err(rule::RESUME_REQUIRES_PHASE);
        }
        // 7. failed -> queued (retry) => no resume_phase (mutation r4_retry_with_resume_phase)
        if self.from == S::Failed && self.to == S::Queued && self.resume_phase.is_some() {
            return Err(rule::RETRY_WITH_RESUME_PHASE);
        }
        if let Some(interruption) = &self.interruption {
            interruption.validate()?;
        }
        if let Some(failure) = &self.failure {
            failure.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointWorktree {
    pub head_sha: GitSha,
    pub branch: String,
    pub dirty: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_sha256: Option<Sha256Hex>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskCheckpointRecordedPayload {
    pub checkpoint_id: CheckpointId,
    pub phase: TaskState,
    pub through_seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<CheckpointWorktree>,
    pub open_operation_ids: Vec<OperationId>,
    pub pending_approval_ids: Vec<ApprovalId>,
}

impl PayloadRules for TaskCheckpointRecordedPayload {}

/// The user viewed the task's result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskOutcomeAcknowledgedPayload {
    pub acknowledged_state: TaskState,
    pub method: AcknowledgementMethod,
}

impl PayloadRules for TaskOutcomeAcknowledgedPayload {}

/// The user changed the task's `auto_resume_policy`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskPolicyUpdatedPayload {
    pub auto_resume_policy: AutoResumePolicy,
}

impl PayloadRules for TaskPolicyUpdatedPayload {}

string_enum!(TaskDeletedFinalState {
    Completed,
    Cancelled,
    Failed
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskDeletedPayload {
    pub final_state: TaskDeletedFinalState,
    pub events_tombstoned: u64,
}

impl PayloadRules for TaskDeletedPayload {}
