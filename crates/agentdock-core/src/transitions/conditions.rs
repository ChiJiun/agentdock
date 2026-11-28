//! Transition conditions (`docs/contracts/state-machines.md`, "Conditions" table).
//!
//! One `Condition` variant per name in `transitions.json`. Every check is a pure function of the
//! request and the facts; the time comes in through `TaskTransitionRequest::now`.

use super::facts::{ChecksSincePhase, LaunchCapabilities, SessionFacts, TaskFacts};
use super::{SessionTransitionRequest, TaskTransitionRequest};
use crate::{ActorKind, ApprovalReturnState, LaunchMethod, ResumePhase, TaskState, TaskTrigger};

/// A guard named in `transitions.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Condition {
    ResumePhaseEqualsTo,
    RetryRestartsFromRunning,
    NoUnreconciledOperations,
    NoOpenOperations,
    ResumePhaseWithinInterruptedPhase,
    MergeEvidenceIfIntegration,
    ApprovalRequestedBefore,
    ReturnStateMatches,
    ApprovalResolvedBefore,
    ApprovalNotPendingAfter,
    LocalChecksPassed,
    CiChecksPassed,
    PrPublishedThisRound,
    OrchestratorOnlyIfAutoResumeArmedAndDue,
    LaunchMethodAdvertised,
    ReattachCapabilityRequired,
}

/// Why a condition rejected the request: a short fixed text, never user data.
pub(crate) type Failed = &'static str;

impl Condition {
    /// Every variant, in the order of the contract table.
    pub const ALL: [Condition; 16] = [
        Condition::ResumePhaseEqualsTo,
        Condition::RetryRestartsFromRunning,
        Condition::NoUnreconciledOperations,
        Condition::NoOpenOperations,
        Condition::ResumePhaseWithinInterruptedPhase,
        Condition::MergeEvidenceIfIntegration,
        Condition::ApprovalRequestedBefore,
        Condition::ReturnStateMatches,
        Condition::ApprovalResolvedBefore,
        Condition::ApprovalNotPendingAfter,
        Condition::LocalChecksPassed,
        Condition::CiChecksPassed,
        Condition::PrPublishedThisRound,
        Condition::OrchestratorOnlyIfAutoResumeArmedAndDue,
        Condition::LaunchMethodAdvertised,
        Condition::ReattachCapabilityRequired,
    ];

    /// The name used in `transitions.json`.
    pub fn name(self) -> &'static str {
        match self {
            Condition::ResumePhaseEqualsTo => "resume_phase_equals_to",
            Condition::RetryRestartsFromRunning => "retry_restarts_from_running",
            Condition::NoUnreconciledOperations => "no_unreconciled_operations",
            Condition::NoOpenOperations => "no_open_operations",
            Condition::ResumePhaseWithinInterruptedPhase => "resume_phase_within_interrupted_phase",
            Condition::MergeEvidenceIfIntegration => "merge_evidence_if_integration",
            Condition::ApprovalRequestedBefore => "approval_requested_before",
            Condition::ReturnStateMatches => "return_state_matches",
            Condition::ApprovalResolvedBefore => "approval_resolved_before",
            Condition::ApprovalNotPendingAfter => "approval_not_pending_after",
            Condition::LocalChecksPassed => "local_checks_passed",
            Condition::CiChecksPassed => "ci_checks_passed",
            Condition::PrPublishedThisRound => "pr_published_this_round",
            Condition::OrchestratorOnlyIfAutoResumeArmedAndDue => {
                "orchestrator_only_if_auto_resume_armed_and_due"
            }
            Condition::LaunchMethodAdvertised => "launch_method_advertised",
            Condition::ReattachCapabilityRequired => "reattach_capability_required",
        }
    }

    /// The condition with this `transitions.json` name, if any.
    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.name() == name)
    }

    /// Conditions a session rule may carry; every other condition belongs to task rules, except
    /// that `ApprovalResolvedBefore` and `ApprovalNotPendingAfter` are shared.
    pub(crate) fn applies_to_sessions(self) -> bool {
        matches!(
            self,
            Condition::ApprovalResolvedBefore
                | Condition::ApprovalNotPendingAfter
                | Condition::LaunchMethodAdvertised
                | Condition::ReattachCapabilityRequired
        )
    }

    /// Conditions a task rule may carry.
    pub(crate) fn applies_to_tasks(self) -> bool {
        !matches!(
            self,
            Condition::LaunchMethodAdvertised | Condition::ReattachCapabilityRequired
        )
    }
}

/// The phase a task state stands for, if it is one of the five resumable phases.
fn phase_of(state: TaskState) -> Option<ResumePhase> {
    match state {
        TaskState::Running => Some(ResumePhase::Running),
        TaskState::Verifying => Some(ResumePhase::Verifying),
        TaskState::Review => Some(ResumePhase::Review),
        TaskState::Pr => Some(ResumePhase::Pr),
        TaskState::Ci => Some(ResumePhase::Ci),
        _ => None,
    }
}

/// The approval return state a task state stands for (`running`, `pr` or `ci` only).
fn return_state_of(state: TaskState) -> Option<ApprovalReturnState> {
    match state {
        TaskState::Running => Some(ApprovalReturnState::Running),
        TaskState::Pr => Some(ApprovalReturnState::Pr),
        TaskState::Ci => Some(ApprovalReturnState::Ci),
        _ => None,
    }
}

fn ensure(ok: bool, detail: Failed) -> Result<(), Failed> {
    if ok {
        Ok(())
    } else {
        Err(detail)
    }
}

fn checks_ok(c: &ChecksSincePhase) -> bool {
    c.started >= 1 && c.all_passed
}

/// Evaluates one condition of a task rule.
pub(crate) fn check_task_condition(
    cond: Condition,
    req: &TaskTransitionRequest<'_>,
    facts: &TaskFacts,
) -> Result<(), Failed> {
    let payload = req.payload;
    match cond {
        Condition::ResumePhaseEqualsTo => {
            let to_phase = phase_of(req.to).ok_or("target state is not a resumable phase")?;
            let resume = payload
                .and_then(|p| p.resume_phase)
                .ok_or("payload has no resume_phase")?;
            ensure(
                resume == to_phase,
                "resume_phase differs from the target state",
            )?;
            let recorded = facts
                .recorded_resume_phase
                .ok_or("no resume_phase was recorded (a retry restarts from running)")?;
            ensure(
                resume == recorded,
                "resume_phase differs from the recorded one",
            )
        }
        Condition::RetryRestartsFromRunning => ensure(
            payload.is_some_and(|p| p.resume_phase.is_none()),
            "a retry carries no resume_phase",
        ),
        Condition::NoUnreconciledOperations => ensure(
            facts.ops_recorded_or_started == 0 && facts.ops_outcome_unknown == 0,
            "an operation is recorded, started or outcome_unknown",
        ),
        Condition::NoOpenOperations => ensure(
            facts.ops_recorded_or_started == 0 && facts.unused_grants == 0,
            "an operation is recorded or started, or a grant is unused",
        ),
        Condition::ResumePhaseWithinInterruptedPhase => {
            let resume = payload
                .and_then(|p| p.resume_phase)
                .ok_or("payload has no resume_phase")?;
            let interruption = facts
                .current_interruption
                .ok_or("task has no current interruption")?;
            ensure(
                resume <= interruption.phase,
                "resume_phase is after the interrupted phase",
            )
        }
        Condition::MergeEvidenceIfIntegration => ensure(
            req.actor != ActorKind::Integration || facts.merge_applied,
            "no succeeded or reconciled pr_merge",
        ),
        Condition::ApprovalRequestedBefore => {
            let payload = payload.ok_or("payload is missing")?;
            let id = payload
                .approval_id
                .as_ref()
                .ok_or("payload has no approval_id")?;
            let return_state = payload.return_state.ok_or("payload has no return_state")?;
            let left = req
                .from
                .and_then(return_state_of)
                .ok_or("approval can only block running, pr or ci")?;
            ensure(
                return_state == left,
                "return_state is not the state being left",
            )?;
            ensure(
                facts.blocking_requested.as_ref() == Some(&(id.clone(), return_state)),
                "approval was not persisted as a pending blocking approval",
            )
        }
        Condition::ReturnStateMatches => {
            let id = payload
                .and_then(|p| p.approval_id.as_ref())
                .ok_or("payload has no approval_id")?;
            let to = return_state_of(req.to).ok_or("target is not running, pr or ci")?;
            ensure(
                facts.awaiting.as_ref() == Some(&(id.clone(), to)),
                "target or approval differs from the recorded return_state",
            )
        }
        Condition::ApprovalResolvedBefore => {
            let id = payload
                .and_then(|p| p.approval_id.as_ref())
                .ok_or("payload has no approval_id")?;
            ensure(
                facts.approval_resolved.contains(id),
                "approval resolution is not persisted",
            )
        }
        Condition::ApprovalNotPendingAfter => ensure(
            facts.approval_pending.is_empty(),
            "an approval of the task is still pending",
        ),
        Condition::LocalChecksPassed => ensure(
            checks_ok(&facts.local_checks),
            "no local check started, or one did not pass",
        ),
        Condition::CiChecksPassed => ensure(
            checks_ok(&facts.ci_checks),
            "no CI check started, or one did not pass",
        ),
        Condition::PrPublishedThisRound => ensure(
            facts.pr_published_this_round,
            "no push and PR in this round",
        ),
        Condition::OrchestratorOnlyIfAutoResumeArmedAndDue => match req.actor {
            ActorKind::User => ensure(
                req.trigger == TaskTrigger::ResumeRequested,
                "user resume must use resume_requested",
            ),
            ActorKind::Orchestrator => {
                ensure(
                    req.trigger == TaskTrigger::ScheduledResume,
                    "orchestrator may only resume with scheduled_resume",
                )?;
                let interruption = facts
                    .current_interruption
                    .ok_or("task has no current interruption")?;
                ensure(interruption.auto_resume_armed, "auto resume is not armed")?;
                let not_before = interruption
                    .not_before
                    .ok_or("retry_hint has no not_before")?;
                ensure(
                    req.now >= not_before,
                    "retry_hint.not_before is not reached",
                )
            }
            _ => Err("only user or orchestrator may resume"),
        },
        Condition::LaunchMethodAdvertised | Condition::ReattachCapabilityRequired => {
            Err("session condition on a task rule")
        }
    }
}

fn advertises(caps: &LaunchCapabilities, method: LaunchMethod) -> bool {
    match method {
        LaunchMethod::New => true,
        LaunchMethod::Load => caps.load_session,
        LaunchMethod::Resume => caps.resume_session,
    }
}

/// Evaluates one condition of a session rule.
pub(crate) fn check_session_condition(
    cond: Condition,
    req: &SessionTransitionRequest<'_>,
    facts: &SessionFacts,
) -> Result<(), Failed> {
    match cond {
        Condition::ApprovalResolvedBefore => {
            let id = req
                .payload
                .and_then(|p| p.approval_id.as_ref())
                .ok_or("payload has no approval_id")?;
            ensure(
                facts.approval_resolved.contains(id),
                "approval resolution is not persisted",
            )
        }
        Condition::ApprovalNotPendingAfter => ensure(
            facts.pending_approvals_of_session.is_empty(),
            "an approval of the session is still pending",
        ),
        Condition::LaunchMethodAdvertised => {
            let method = req.launch_method.ok_or("launch_method is missing")?;
            // A snapshot for this launch is required for every method, `new` included.
            let caps = facts
                .snapshot_for_this_launch
                .as_ref()
                .ok_or("no capability snapshot for this launch")?;
            ensure(advertises(caps, method), "launch method is not advertised")
        }
        Condition::ReattachCapabilityRequired => {
            let method = req.launch_method.ok_or("launch_method is missing")?;
            ensure(method != LaunchMethod::New, "reattach needs load or resume")?;
            let caps = facts
                .latest_snapshot
                .as_ref()
                .ok_or("no capability snapshot for the session")?;
            ensure(
                advertises(caps, method),
                "reattach method is not advertised",
            )?;
            ensure(
                facts.external_session_id_known,
                "external_session_id is not known",
            )
        }
        _ => Err("task condition on a session rule"),
    }
}
