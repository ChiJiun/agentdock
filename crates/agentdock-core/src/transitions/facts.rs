//! Facts the store computes inside the append transaction (P2-5) and hands to the checks.
//!
//! The checks never read a database. If a condition needs more than is here, extend these
//! structs and say so in the PR.
//!
//! `InterruptionFacts` and `LaunchCapabilities` are the slices of the P2-2 `Interruption` and
//! `CapabilityFeatures` payload types that the conditions read; `From` converts from the payload
//! types, so the store builds facts straight from the persisted events.

use crate::payload::common::{CapabilityFeatures, Interruption};
use crate::{ApprovalId, ApprovalReturnState, ResumePhase, Timestamp};

/// What the guards need from the `Interruption` of the task's current interruption.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InterruptionFacts {
    /// Furthest phase the task had reached (`Interruption.phase`).
    pub phase: ResumePhase,
    /// `Interruption.auto_resume_armed`.
    pub auto_resume_armed: bool,
    /// `Interruption.retry_hint.not_before`, if the hint carries one.
    pub not_before: Option<Timestamp>,
}

impl From<&Interruption> for InterruptionFacts {
    fn from(i: &Interruption) -> Self {
        InterruptionFacts {
            phase: i.phase,
            auto_resume_armed: i.auto_resume_armed,
            not_before: i.retry_hint.as_ref().and_then(|h| h.not_before),
        }
    }
}

/// The two ACP session-restore methods a capability snapshot can advertise
/// (`features.load_session`, `features.resume_session`). Absent means `false`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LaunchCapabilities {
    pub load_session: bool,
    pub resume_session: bool,
}

impl From<&CapabilityFeatures> for LaunchCapabilities {
    fn from(f: &CapabilityFeatures) -> Self {
        LaunchCapabilities {
            load_session: f.load_session,
            resume_session: f.resume_session,
        }
    }
}

/// Local or CI checks since the task last entered the phase (`verifying` or `ci`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ChecksSincePhase {
    pub started: u32,
    pub all_passed: bool,
}

/// Facts about one task.
#[derive(Debug, Clone, Default)]
pub struct TaskFacts {
    /// `resume_phase` recorded by `T44`; consumed by `T04`..`T08`. `None` after a retry.
    pub recorded_resume_phase: Option<ResumePhase>,
    /// The current interruption while the task is `interrupted`.
    pub current_interruption: Option<InterruptionFacts>,
    /// The approval and `return_state` recorded when the task entered `awaiting_approval`.
    pub awaiting: Option<(ApprovalId, ApprovalReturnState)>,
    /// Pending approvals of this task.
    pub approval_pending: Vec<ApprovalId>,
    /// Approvals of this task whose resolution event is persisted.
    pub approval_resolved: Vec<ApprovalId>,
    /// Latest pending blocking approval and its `return_state`.
    pub blocking_requested: Option<(ApprovalId, ApprovalReturnState)>,
    /// Operations of the task in `recorded` or `started`.
    pub ops_recorded_or_started: u32,
    /// Operations of the task in `outcome_unknown`.
    pub ops_outcome_unknown: u32,
    /// Approved host-policy approvals not yet consumed.
    pub unused_grants: u32,
    /// Local checks since the task last entered `verifying` (approval detours do not reset).
    pub local_checks: ChecksSincePhase,
    /// CI checks since the task last entered `ci`.
    pub ci_checks: ChecksSincePhase,
    /// A push of this PR round succeeded or was reconciled applied, and a PR exists.
    pub pr_published_this_round: bool,
    /// A `pr_merge` of the task `succeeded` or was `reconciled_applied`.
    pub merge_applied: bool,
}

/// Facts about one session.
#[derive(Debug, Clone, Default)]
pub struct SessionFacts {
    /// Features of the process started for this launch; `None` if no snapshot was recorded.
    pub snapshot_for_this_launch: Option<LaunchCapabilities>,
    /// Features of the latest snapshot of the session.
    pub latest_snapshot: Option<LaunchCapabilities>,
    pub external_session_id_known: bool,
    /// Pending approvals of this session.
    pub pending_approvals_of_session: Vec<ApprovalId>,
    /// Approvals of this session whose resolution event is persisted.
    pub approval_resolved: Vec<ApprovalId>,
}
