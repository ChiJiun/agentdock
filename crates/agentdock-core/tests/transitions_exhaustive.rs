//! P2-3: exhaustive transition tests against `docs/contracts/transitions.json`, one test per
//! guard condition, and a property test for the "verifying and review before pr/ci/completed"
//! rule of ADR-0003 section 9 ("Retry").
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;

use agentdock_core::enums::*;
use agentdock_core::payload::{SessionStateChangedPayload, TaskStateChangedPayload};
use agentdock_core::transitions::*;
use agentdock_core::{ApprovalId, Timestamp};

fn ts(s: &str) -> Timestamp {
    Timestamp::parse(s).unwrap()
}

fn fixed_now() -> Timestamp {
    ts("2026-11-28T12:00:00.000Z")
}

fn apr(n: u32) -> ApprovalId {
    ApprovalId::parse(&format!("apr_{n:0>26}")).unwrap()
}

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

fn return_state_of(state: TaskState) -> Option<ApprovalReturnState> {
    match state {
        TaskState::Running => Some(ApprovalReturnState::Running),
        TaskState::Pr => Some(ApprovalReturnState::Pr),
        TaskState::Ci => Some(ApprovalReturnState::Ci),
        _ => None,
    }
}

/// A `task.state_changed` payload with only `from`, `to` and `trigger` set.
fn task_payload(from: TaskState, to: TaskState, trigger: TaskTrigger) -> TaskStateChangedPayload {
    TaskStateChangedPayload {
        from,
        to,
        trigger,
        resume_phase: None,
        return_state: None,
        approval_id: None,
        interruption: None,
        failure: None,
        checkpoint_id: None,
    }
}

/// A `session.state_changed` payload with only `from`, `to` and `trigger` set.
fn session_payload(
    from: SessionState,
    to: SessionState,
    trigger: SessionTrigger,
) -> SessionStateChangedPayload {
    SessionStateChangedPayload {
        from,
        to,
        trigger,
        turn_id: None,
        stop_reason: None,
        external_session_id: None,
        launch_method: None,
        approval_id: None,
        outcome: None,
        error: None,
    }
}

/// A payload that agrees with the request and satisfies the schema rules for `(from, to)` and facts that satisfy every
/// condition, so only `(from, to, actor, trigger)` decide the result.
fn permissive_for(
    from: Option<TaskState>,
    to: TaskState,
    trigger: TaskTrigger,
) -> (Option<TaskStateChangedPayload>, TaskFacts) {
    let mut payload = task_payload(from.unwrap_or(TaskState::Queued), to, trigger);
    let mut facts = TaskFacts {
        current_interruption: Some(InterruptionFacts {
            phase: ResumePhase::Ci,
            auto_resume_armed: true,
            not_before: Some(ts("2026-11-28T11:59:00.000Z")),
        }),
        approval_resolved: vec![apr(1)],
        local_checks: ChecksSincePhase {
            started: 1,
            all_passed: true,
        },
        ci_checks: ChecksSincePhase {
            started: 1,
            all_passed: true,
        },
        pr_published_this_round: true,
        merge_applied: true,
        ..TaskFacts::default()
    };
    if from == Some(TaskState::Preparing) {
        if let Some(phase) = phase_of(to) {
            payload.resume_phase = Some(phase);
            facts.recorded_resume_phase = Some(phase);
        }
    }
    if from == Some(TaskState::Interrupted) && to == TaskState::Queued {
        payload.resume_phase = Some(ResumePhase::Ci);
    }
    if to == TaskState::AwaitingApproval {
        if let Some(rs) = from.and_then(return_state_of) {
            payload.return_state = Some(rs);
            facts.blocking_requested = Some((apr(1), rs));
        }
        payload.approval_id = Some(apr(1));
    }
    if from == Some(TaskState::AwaitingApproval) {
        payload.approval_id = Some(apr(1));
        if let Some(rs) = return_state_of(to) {
            facts.awaiting = Some((apr(1), rs));
        }
    }
    (from.map(|_| payload), facts)
}

fn task_req<'a>(
    from: Option<TaskState>,
    to: TaskState,
    actor: ActorKind,
    trigger: TaskTrigger,
    payload: Option<&'a TaskStateChangedPayload>,
) -> TaskTransitionRequest<'a> {
    TaskTransitionRequest {
        from,
        to,
        actor,
        trigger,
        payload,
        now: fixed_now(),
    }
}

#[test]
fn every_task_triple_matches_transitions_json() {
    let table = try_table().unwrap();
    let states: Vec<Option<TaskState>> = std::iter::once(None)
        .chain(TaskState::ALL.iter().copied().map(Some))
        .collect();
    let mut passed_rules = BTreeSet::new();
    for from in &states {
        for &to in TaskState::ALL {
            for &actor in ActorKind::ALL {
                for &trigger in TaskTrigger::ALL {
                    let mut listed = table.task.iter().any(|r| {
                        r.from.as_deref() == from.map(TaskState::as_str)
                            && r.to == to.as_str()
                            && r.actors.contains(&actor)
                            && r.triggers.iter().any(|t| t == trigger.as_str())
                    });
                    // T44: the condition orchestrator_only_if_auto_resume_armed_and_due pins the
                    // trigger per actor (user: resume_requested, orchestrator: scheduled_resume),
                    // which the table's actor x trigger cross product cannot express.
                    if *from == Some(TaskState::Interrupted) && to == TaskState::Queued {
                        let wanted = match actor {
                            ActorKind::User => Some(TaskTrigger::ResumeRequested),
                            ActorKind::Orchestrator => Some(TaskTrigger::ScheduledResume),
                            _ => None,
                        };
                        if wanted.is_some_and(|w| w != trigger) {
                            listed = false;
                        }
                    }
                    let (payload, facts) = permissive_for(*from, to, trigger);
                    let req = task_req(*from, to, actor, trigger, payload.as_ref());
                    let got = check_task_transition(table, &req, &facts);
                    assert_eq!(
                        got.is_ok(),
                        listed,
                        "{from:?} -> {to:?} by {actor:?} via {trigger:?}: {got:?}"
                    );
                    if let Ok(rule) = got {
                        passed_rules.insert(rule.id.clone());
                    }
                }
            }
        }
    }
    assert_eq!(
        passed_rules.len(),
        47,
        "every task transition must be reachable"
    );
}

fn session_permissive(
    from: Option<SessionState>,
    to: SessionState,
    trigger: SessionTrigger,
) -> (Option<SessionStateChangedPayload>, SessionFacts) {
    let both = LaunchCapabilities {
        load_session: true,
        resume_session: true,
    };
    let payload = from.map(|f| SessionStateChangedPayload {
        approval_id: Some(apr(1)),
        ..session_payload(f, to, trigger)
    });
    let facts = SessionFacts {
        snapshot_for_this_launch: Some(both),
        latest_snapshot: Some(both),
        external_session_id_known: true,
        pending_approvals_of_session: vec![],
        approval_resolved: vec![apr(1)],
    };
    (payload, facts)
}

#[test]
fn every_session_triple_matches_transitions_json() {
    let table = try_table().unwrap();
    let states: Vec<Option<SessionState>> = std::iter::once(None)
        .chain(SessionState::ALL.iter().copied().map(Some))
        .collect();
    let mut passed_rules = BTreeSet::new();
    for from in &states {
        for &to in SessionState::ALL {
            for &actor in ActorKind::ALL {
                for &trigger in SessionTrigger::ALL {
                    let listed = table.session.iter().any(|r| {
                        r.from.as_deref() == from.map(SessionState::as_str)
                            && r.to == to.as_str()
                            && r.actors.contains(&actor)
                            && r.triggers.iter().any(|t| t == trigger.as_str())
                    });
                    let (payload, facts) = session_permissive(*from, to, trigger);
                    let req = SessionTransitionRequest {
                        from: *from,
                        to,
                        actor,
                        trigger,
                        payload: payload.as_ref(),
                        launch_method: Some(LaunchMethod::Load),
                    };
                    let got = check_session_transition(table, &req, &facts);
                    assert_eq!(
                        got.is_ok(),
                        listed,
                        "{from:?} -> {to:?} by {actor:?} via {trigger:?}: {got:?}"
                    );
                    if let Ok(rule) = got {
                        passed_rules.insert(rule.id.clone());
                    }
                }
            }
        }
    }
    assert_eq!(
        passed_rules.len(),
        25,
        "every session transition must be reachable"
    );
}

/// The JSON keys the loader knows. Unknown keys are not rejected (`deny_unknown_fields` would
/// make every additive contract change fail the build, CONVENTIONS section 7), so this test
/// flags a new key until somebody decides whether the loader must act on it.
#[test]
fn transitions_json_shape_is_known() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/contracts/transitions.json");
    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let allowed = [
        "id",
        "from",
        "to",
        "actors",
        "triggers",
        "durability",
        "conditions",
        "event",
    ];
    for graph in ["task", "session"] {
        let g = &json[graph];
        let rules = g["transitions"].as_array().unwrap();
        for r in rules {
            for key in r.as_object().unwrap().keys() {
                assert!(allowed.contains(&key.as_str()), "{graph}: new key {key:?}");
            }
        }
        let creation: Vec<_> = rules.iter().filter(|r| r["from"].is_null()).collect();
        assert_eq!(creation.len(), 1, "{graph}: exactly one creation rule");
        assert_eq!(g["initial"], creation[0]["to"], "{graph}: initial");
        // Terminal states have no outgoing rule.
        for t in g["terminal"].as_array().unwrap() {
            assert!(
                rules.iter().all(|r| r["from"] != *t),
                "{graph}: terminal {t} has an exit"
            );
        }
    }
    let task_terminal: BTreeSet<&str> = json["task"]["terminal"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    let code_terminal: BTreeSet<&str> = TaskState::ALL
        .iter()
        .filter(|s| s.is_terminal())
        .map(|s| s.as_str())
        .collect();
    assert_eq!(task_terminal, code_terminal);
}

#[test]
fn creation_is_only_the_creation_rule() {
    let table = try_table().unwrap();
    // `from: None` to anything but `queued` / `starting` is illegal, and so is `queued` with
    // another actor or trigger.
    let (payload, facts) = permissive_for(None, TaskState::Running, TaskTrigger::TaskCreated);
    let req = task_req(
        None,
        TaskState::Running,
        ActorKind::User,
        TaskTrigger::TaskCreated,
        payload.as_ref(),
    );
    assert!(matches!(
        check_task_transition(table, &req, &facts),
        Err(TransitionError::Illegal { from: None, .. })
    ));
}

/// Terminal states have no outgoing rule for any actor or trigger.
#[test]
fn terminal_states_have_no_exit() {
    let table = try_table().unwrap();
    for from in TaskState::ALL.iter().filter(|s| s.is_terminal()) {
        for &to in TaskState::ALL {
            for &actor in ActorKind::ALL {
                for &trigger in TaskTrigger::ALL {
                    let (payload, facts) = permissive_for(Some(*from), to, trigger);
                    let req = task_req(Some(*from), to, actor, trigger, payload.as_ref());
                    assert!(
                        matches!(
                            check_task_transition(table, &req, &facts),
                            Err(TransitionError::Illegal { .. })
                        ),
                        "{from:?} -> {to:?}"
                    );
                }
            }
        }
    }
}

mod transitions_conditions {
    use super::*;

    type TaskResult = Result<String, TransitionError>;

    /// Builds the permissive request for `(from, to, actor, trigger)`, lets `tweak` change the
    /// payload and facts, and runs the check. Returns the rule id on success.
    fn run(
        from: TaskState,
        to: TaskState,
        actor: ActorKind,
        trigger: TaskTrigger,
        tweak: impl FnOnce(&mut TaskStateChangedPayload, &mut TaskFacts),
    ) -> TaskResult {
        let (payload, mut facts) = permissive_for(Some(from), to, trigger);
        let mut payload = payload.unwrap();
        tweak(&mut payload, &mut facts);
        let req = task_req(Some(from), to, actor, trigger, Some(&payload));
        check_task_transition(try_table().unwrap(), &req, &facts).map(|r| r.id.clone())
    }

    fn failed(rule: &str, condition: Condition, result: TaskResult) {
        match result {
            Err(TransitionError::Condition {
                rule: got_rule,
                condition: got,
                ..
            }) => {
                assert_eq!((got_rule.as_str(), got), (rule, condition));
            }
            other => panic!("expected {rule} {condition:?} failure, got {other:?}"),
        }
    }

    use ActorKind as A;
    use TaskState as S;
    use TaskTrigger as T;

    #[test]
    fn retry_skips_to_pr() {
        let r = run(
            S::Preparing,
            S::Pr,
            A::Orchestrator,
            T::ResumePhaseRestored,
            |_, f| {
                f.recorded_resume_phase = None;
            },
        );
        failed("T07", Condition::ResumePhaseEqualsTo, r);
    }

    #[test]
    fn resume_beyond_phase() {
        let r = run(
            S::Interrupted,
            S::Queued,
            A::User,
            T::ResumeRequested,
            |p, f| {
                p.resume_phase = Some(ResumePhase::Ci);
                f.current_interruption = Some(InterruptionFacts {
                    phase: ResumePhase::Review,
                    auto_resume_armed: false,
                    not_before: None,
                });
            },
        );
        failed("T44", Condition::ResumePhaseWithinInterruptedPhase, r);
    }

    #[test]
    fn early_auto_resume() {
        let r = run(
            S::Interrupted,
            S::Queued,
            A::Orchestrator,
            T::ScheduledResume,
            |_, f| {
                f.current_interruption = Some(InterruptionFacts {
                    phase: ResumePhase::Ci,
                    auto_resume_armed: true,
                    not_before: Some(ts("2026-11-28T12:01:00.000Z")),
                });
            },
        );
        failed("T44", Condition::OrchestratorOnlyIfAutoResumeArmedAndDue, r);
    }

    #[test]
    fn user_cannot_use_scheduled_resume() {
        let r = run(
            S::Interrupted,
            S::Queued,
            A::User,
            T::ScheduledResume,
            |_, _| {},
        );
        failed("T44", Condition::OrchestratorOnlyIfAutoResumeArmedAndDue, r);
    }

    #[test]
    fn auto_resume_due_exactly_now_is_allowed() {
        let r = run(
            S::Interrupted,
            S::Queued,
            A::Orchestrator,
            T::ScheduledResume,
            |_, f| {
                f.current_interruption = Some(InterruptionFacts {
                    phase: ResumePhase::Ci,
                    auto_resume_armed: true,
                    not_before: Some(fixed_now()),
                });
            },
        );
        assert_eq!(r.unwrap(), "T44");
    }

    #[test]
    fn auto_resume_after_crash() {
        let r = run(
            S::Interrupted,
            S::Queued,
            A::Orchestrator,
            T::ScheduledResume,
            |_, f| {
                // Interruption written by crash recovery (host_crashed): never armed.
                f.current_interruption = Some(InterruptionFacts {
                    phase: ResumePhase::Ci,
                    auto_resume_armed: false,
                    not_before: None,
                });
            },
        );
        failed("T44", Condition::OrchestratorOnlyIfAutoResumeArmedAndDue, r);
    }

    #[test]
    fn orchestrator_cannot_resume_with_resume_requested() {
        let r = run(
            S::Interrupted,
            S::Queued,
            A::Orchestrator,
            T::ResumeRequested,
            |_, _| {},
        );
        failed("T44", Condition::OrchestratorOnlyIfAutoResumeArmedAndDue, r);
    }

    #[test]
    fn user_can_resume_anytime() {
        let r = run(
            S::Interrupted,
            S::Queued,
            A::User,
            T::ResumeRequested,
            |_, f| {
                f.current_interruption = Some(InterruptionFacts {
                    phase: ResumePhase::Ci,
                    auto_resume_armed: false,
                    not_before: None,
                });
            },
        );
        assert_eq!(r.unwrap(), "T44");
    }

    #[test]
    fn retry_without_reconcile() {
        let r = run(S::Failed, S::Queued, A::User, T::RetryRequested, |_, f| {
            f.ops_outcome_unknown = 1;
        });
        failed("T47", Condition::NoUnreconciledOperations, r);
    }

    #[test]
    fn retry_with_resume_phase_is_rejected() {
        let r = run(S::Failed, S::Queued, A::User, T::RetryRequested, |p, _| {
            p.resume_phase = Some(ResumePhase::Pr);
        });
        failed("T47", Condition::RetryRestartsFromRunning, r);
    }

    #[test]
    fn cancel_with_started_op() {
        let r = run(S::Running, S::Cancelled, A::User, T::UserCancel, |_, f| {
            f.ops_recorded_or_started = 1;
        });
        failed("T16", Condition::NoOpenOperations, r);
    }

    #[test]
    fn cancel_with_unused_grant() {
        let r = run(S::Running, S::Cancelled, A::User, T::UserCancel, |_, f| {
            f.unused_grants = 1;
        });
        failed("T16", Condition::NoOpenOperations, r);
    }

    #[test]
    fn verify_with_failed_check() {
        let r = run(
            S::Verifying,
            S::Review,
            A::Orchestrator,
            T::ChecksPassed,
            |_, f| {
                f.local_checks = ChecksSincePhase {
                    started: 2,
                    all_passed: false,
                };
            },
        );
        failed("T23", Condition::LocalChecksPassed, r);
    }

    #[test]
    fn verify_with_no_check() {
        let r = run(
            S::Verifying,
            S::Review,
            A::Orchestrator,
            T::ChecksPassed,
            |_, f| {
                f.local_checks = ChecksSincePhase {
                    started: 0,
                    all_passed: true,
                };
            },
        );
        failed("T23", Condition::LocalChecksPassed, r);
    }

    #[test]
    fn second_round_without_push() {
        let r = run(S::Pr, S::Ci, A::Integration, T::PrPublished, |_, f| {
            f.pr_published_this_round = false;
        });
        failed("T34", Condition::PrPublishedThisRound, r);
    }

    #[test]
    fn integration_completes_without_merge() {
        let r = run(
            S::Ci,
            S::Completed,
            A::Integration,
            T::CiPassedAccepted,
            |_, f| {
                f.merge_applied = false;
            },
        );
        failed("T39", Condition::MergeEvidenceIfIntegration, r);
    }

    #[test]
    fn user_completes_ci_without_merge_evidence() {
        let r = run(S::Ci, S::Completed, A::User, T::CiPassedAccepted, |_, f| {
            f.merge_applied = false;
        });
        assert_eq!(r.unwrap(), "T39");
    }

    #[test]
    fn ci_completion_needs_ci_checks() {
        let r = run(S::Ci, S::Completed, A::User, T::CiPassedAccepted, |_, f| {
            f.ci_checks = ChecksSincePhase {
                started: 1,
                all_passed: false,
            };
        });
        failed("T39", Condition::CiChecksPassed, r);
    }

    #[test]
    fn act_before_approval_persisted() {
        let r = run(
            S::AwaitingApproval,
            S::Running,
            A::User,
            T::ApprovalResolved,
            |_, f| {
                f.approval_resolved.clear();
            },
        );
        failed("T17", Condition::ApprovalResolvedBefore, r);
    }

    #[test]
    fn return_to_wrong_state() {
        let r = run(
            S::AwaitingApproval,
            S::Pr,
            A::User,
            T::ApprovalResolved,
            |_, f| {
                f.awaiting = Some((apr(1), ApprovalReturnState::Running));
            },
        );
        failed("T18", Condition::ReturnStateMatches, r);
    }

    #[test]
    fn return_with_other_approval_id() {
        let r = run(
            S::AwaitingApproval,
            S::Running,
            A::User,
            T::ApprovalResolved,
            |p, _| {
                p.approval_id = Some(apr(2));
            },
        );
        failed("T17", Condition::ReturnStateMatches, r);
    }

    #[test]
    fn block_on_unpersisted_or_mismatched_approval() {
        let r = run(
            S::Running,
            S::AwaitingApproval,
            A::Policy,
            T::ApprovalRequested,
            |_, f| {
                f.blocking_requested = None;
            },
        );
        failed("T12", Condition::ApprovalRequestedBefore, r);
        // return_state must be the state being left: running cannot wait to return to ci.
        let r = run(
            S::Running,
            S::AwaitingApproval,
            A::Policy,
            T::ApprovalRequested,
            |p, f| {
                p.return_state = Some(ApprovalReturnState::Ci);
                f.blocking_requested = Some((apr(1), ApprovalReturnState::Ci));
            },
        );
        failed("T12", Condition::ApprovalRequestedBefore, r);
    }

    #[test]
    fn interrupt_or_cancel_with_pending_approval() {
        for (to, trigger, actor) in [
            (S::Interrupted, T::Interruption, A::Recovery),
            (S::Cancelled, T::UserCancel, A::User),
        ] {
            let r = run(S::AwaitingApproval, to, actor, trigger, |_, f| {
                f.approval_pending = vec![apr(1)];
            });
            assert!(
                matches!(
                    r,
                    Err(TransitionError::Condition {
                        condition: Condition::ApprovalNotPendingAfter,
                        ..
                    })
                ),
                "{to:?}: {r:?}"
            );
        }
    }

    #[test]
    fn agent_text_cannot_move_task() {
        let r = run(
            S::Running,
            S::Verifying,
            A::Adapter,
            T::ImplementationDone,
            |_, _| {},
        );
        assert_eq!(
            r,
            Err(TransitionError::Actor {
                rule: "T13".to_owned(),
                actor: A::Adapter
            })
        );
    }

    #[test]
    fn wrong_trigger_is_rejected() {
        let r = run(S::Running, S::Verifying, A::User, T::UserCancel, |_, _| {});
        assert_eq!(
            r,
            Err(TransitionError::Trigger {
                rule: "T13".to_owned(),
                trigger: "user_cancel".to_owned()
            })
        );
    }

    #[test]
    fn merge_is_not_reachable_from_review_without_reconcile() {
        let r = run(
            S::Review,
            S::Pr,
            A::Orchestrator,
            T::ReviewPassed,
            |_, f| {
                f.ops_outcome_unknown = 1;
            },
        );
        failed("T28", Condition::NoUnreconciledOperations, r);
    }

    fn session_run(
        from: SessionState,
        to: SessionState,
        trigger: SessionTrigger,
        actor: ActorKind,
        launch_method: Option<LaunchMethod>,
        tweak: impl FnOnce(&mut SessionFacts),
    ) -> Result<String, TransitionError> {
        let (payload, mut facts) = session_permissive(Some(from), to, trigger);
        tweak(&mut facts);
        let req = SessionTransitionRequest {
            from: Some(from),
            to,
            actor,
            trigger,
            payload: payload.as_ref(),
            launch_method,
        };
        check_session_transition(try_table().unwrap(), &req, &facts).map(|r| r.id.clone())
    }

    #[test]
    fn load_without_capability() {
        let r = session_run(
            SessionState::Disconnected,
            SessionState::Starting,
            SessionTrigger::ReattachAttempt,
            ActorKind::Orchestrator,
            Some(LaunchMethod::Load),
            |f| {
                f.latest_snapshot = Some(LaunchCapabilities {
                    load_session: false,
                    resume_session: true,
                });
            },
        );
        assert!(matches!(
            r,
            Err(TransitionError::Condition {
                condition: Condition::ReattachCapabilityRequired,
                ..
            })
        ));
    }

    #[test]
    fn reattach_needs_external_session_id_and_a_real_method() {
        for (method, known) in [
            (Some(LaunchMethod::Resume), false),
            (Some(LaunchMethod::New), true),
            (None, true),
        ] {
            let r = session_run(
                SessionState::Disconnected,
                SessionState::Starting,
                SessionTrigger::ReattachAttempt,
                ActorKind::Orchestrator,
                method,
                |f| f.external_session_id_known = known,
            );
            assert!(
                matches!(
                    r,
                    Err(TransitionError::Condition {
                        condition: Condition::ReattachCapabilityRequired,
                        ..
                    })
                ),
                "{method:?} {known}: {r:?}"
            );
        }
    }

    #[test]
    fn idle_without_snapshot_for_load() {
        let r = session_run(
            SessionState::Starting,
            SessionState::Idle,
            SessionTrigger::SessionReady,
            ActorKind::Adapter,
            Some(LaunchMethod::Load),
            |f| f.snapshot_for_this_launch = None,
        );
        assert!(matches!(
            r,
            Err(TransitionError::Condition {
                condition: Condition::LaunchMethodAdvertised,
                ..
            })
        ));
    }

    #[test]
    fn every_launch_method_needs_a_snapshot_for_this_launch() {
        for method in [LaunchMethod::New, LaunchMethod::Load, LaunchMethod::Resume] {
            let r = session_run(
                SessionState::Starting,
                SessionState::Idle,
                SessionTrigger::SessionReady,
                ActorKind::Adapter,
                Some(method),
                |f| f.snapshot_for_this_launch = None,
            );
            assert!(
                matches!(
                    r,
                    Err(TransitionError::Condition {
                        condition: Condition::LaunchMethodAdvertised,
                        ..
                    })
                ),
                "{method:?}: {r:?}"
            );
        }
    }

    #[test]
    fn launch_with_snapshot_checks_the_matching_feature() {
        let run_with = |method, caps| {
            session_run(
                SessionState::Starting,
                SessionState::Idle,
                SessionTrigger::SessionReady,
                ActorKind::Adapter,
                Some(method),
                |f| f.snapshot_for_this_launch = Some(caps),
            )
        };
        let none = LaunchCapabilities::default();
        let load_only = LaunchCapabilities {
            load_session: true,
            resume_session: false,
        };
        assert_eq!(run_with(LaunchMethod::New, none).unwrap(), "S02");
        assert_eq!(run_with(LaunchMethod::Load, load_only).unwrap(), "S02");
        assert!(run_with(LaunchMethod::Resume, load_only).is_err());
        assert!(run_with(LaunchMethod::Load, none).is_err());
    }

    #[test]
    fn session_permission_conditions() {
        let r = session_run(
            SessionState::AwaitingPermission,
            SessionState::Active,
            SessionTrigger::PermissionResolved,
            ActorKind::User,
            None,
            |f| f.approval_resolved.clear(),
        );
        assert!(matches!(
            r,
            Err(TransitionError::Condition {
                condition: Condition::ApprovalResolvedBefore,
                ..
            })
        ));
        for to in [SessionState::Idle, SessionState::Failed] {
            let trigger = if to == SessionState::Idle {
                SessionTrigger::TurnEnded
            } else {
                SessionTrigger::ProtocolError
            };
            let r = session_run(
                SessionState::AwaitingPermission,
                to,
                trigger,
                ActorKind::Adapter,
                None,
                |f| f.pending_approvals_of_session = vec![apr(1)],
            );
            assert!(
                matches!(
                    r,
                    Err(TransitionError::Condition {
                        condition: Condition::ApprovalNotPendingAfter,
                        ..
                    })
                ),
                "{to:?}: {r:?}"
            );
        }
    }
}

mod transitions_payload {
    use super::*;
    use agentdock_core::payload::common::{CapabilityFeatures, Interruption};

    fn task_check(
        req: &TaskTransitionRequest<'_>,
        facts: &TaskFacts,
    ) -> Result<String, TransitionError> {
        check_task_transition(try_table().unwrap(), req, facts).map(|r| r.id.clone())
    }

    /// T13 (`running -> verifying`) has no condition, so only the payload layer can stop it.
    #[test]
    fn non_creation_transition_without_payload_is_rejected() {
        let req = task_req(
            Some(TaskState::Running),
            TaskState::Verifying,
            ActorKind::Orchestrator,
            TaskTrigger::ImplementationDone,
            None,
        );
        assert_eq!(
            task_check(&req, &TaskFacts::default()),
            Err(TransitionError::MissingPayload("task"))
        );
        let req = SessionTransitionRequest {
            from: Some(SessionState::Active),
            to: SessionState::Idle,
            actor: ActorKind::Adapter,
            trigger: SessionTrigger::TurnEnded,
            payload: None,
            launch_method: None,
        };
        assert_eq!(
            check_session_transition(try_table().unwrap(), &req, &SessionFacts::default())
                .map(|r| r.id.clone()),
            Err(TransitionError::MissingPayload("session"))
        );
    }

    #[test]
    fn creation_must_not_carry_a_state_changed_payload() {
        let p = task_payload(
            TaskState::Queued,
            TaskState::Queued,
            TaskTrigger::TaskCreated,
        );
        let req = task_req(
            None,
            TaskState::Queued,
            ActorKind::User,
            TaskTrigger::TaskCreated,
            Some(&p),
        );
        assert_eq!(
            task_check(&req, &TaskFacts::default()),
            Err(TransitionError::PayloadMismatch { field: "from" })
        );
        let ok = task_req(
            None,
            TaskState::Queued,
            ActorKind::User,
            TaskTrigger::TaskCreated,
            None,
        );
        assert_eq!(task_check(&ok, &TaskFacts::default()).unwrap(), "T01");
    }

    #[test]
    fn payload_from_to_trigger_must_match_the_request() {
        let (from, to, trigger) = (
            TaskState::Running,
            TaskState::Verifying,
            TaskTrigger::ImplementationDone,
        );
        let check = |p: &TaskStateChangedPayload| {
            let req = task_req(Some(from), to, ActorKind::Orchestrator, trigger, Some(p));
            task_check(&req, &TaskFacts::default())
        };
        assert_eq!(check(&task_payload(from, to, trigger)).unwrap(), "T13");
        for (p, field) in [
            (task_payload(TaskState::Review, to, trigger), "from"),
            (task_payload(from, TaskState::Review, trigger), "to"),
            (task_payload(from, to, TaskTrigger::UserCancel), "trigger"),
        ] {
            assert_eq!(check(&p), Err(TransitionError::PayloadMismatch { field }));
        }
    }

    #[test]
    fn session_payload_must_match_the_request() {
        let (from, to, trigger) = (
            SessionState::Active,
            SessionState::Idle,
            SessionTrigger::TurnEnded,
        );
        let check = |p: &SessionStateChangedPayload, lm: Option<LaunchMethod>| {
            let req = SessionTransitionRequest {
                from: Some(from),
                to,
                actor: ActorKind::Adapter,
                trigger,
                payload: Some(p),
                launch_method: lm,
            };
            check_session_transition(try_table().unwrap(), &req, &SessionFacts::default())
                .map(|r| r.id.clone())
        };
        assert_eq!(
            check(&session_payload(from, to, trigger), None).unwrap(),
            "S09"
        );
        for (p, field) in [
            (session_payload(SessionState::Idle, to, trigger), "from"),
            (session_payload(from, SessionState::Closed, trigger), "to"),
            (session_payload(from, to, SessionTrigger::Launch), "trigger"),
        ] {
            assert_eq!(
                check(&p, None),
                Err(TransitionError::PayloadMismatch { field })
            );
        }
        let mut p = session_payload(from, to, trigger);
        p.launch_method = Some(LaunchMethod::Load);
        assert_eq!(
            check(&p, Some(LaunchMethod::Resume)),
            Err(TransitionError::PayloadMismatch {
                field: "launch_method"
            })
        );
        assert!(check(&p, Some(LaunchMethod::Load)).is_ok());
    }

    #[test]
    fn facts_convert_from_payload_types() {
        let interruption: Interruption = serde_json::from_value(serde_json::json!({
            "reason": "quota_exhausted",
            "phase": "review",
            "auto_resume_armed": true,
            "retry_hint": {"source": "provider_reported", "not_before": "2026-11-28T13:00:00.000Z"}
        }))
        .unwrap();
        assert_eq!(
            InterruptionFacts::from(&interruption),
            InterruptionFacts {
                phase: ResumePhase::Review,
                auto_resume_armed: true,
                not_before: Some(ts("2026-11-28T13:00:00.000Z")),
            }
        );
        let no_hint: Interruption = serde_json::from_value(serde_json::json!({
            "reason": "host_crashed", "phase": "pr", "auto_resume_armed": false
        }))
        .unwrap();
        assert_eq!(InterruptionFacts::from(&no_hint).not_before, None);

        let mut features = serde_json::json!({});
        for k in [
            "load_session",
            "resume_session",
            "close_session",
            "list_sessions",
            "delete_session",
            "additional_directories",
            "system_prompt",
            "prompt_image",
            "prompt_audio",
            "prompt_embedded_context",
            "mcp_http",
            "mcp_sse",
            "logout",
        ] {
            features[k] = serde_json::json!(k == "resume_session");
        }
        let features: CapabilityFeatures = serde_json::from_value(features).unwrap();
        assert_eq!(
            LaunchCapabilities::from(&features),
            LaunchCapabilities {
                load_session: false,
                resume_session: true
            }
        );
    }
}

mod transitions_property {
    use super::*;
    use proptest::prelude::*;

    #[derive(Debug, Clone)]
    struct Step {
        pick: usize,
        actor: usize,
        trigger: usize,
        resume_phase: usize,
        local: (u32, bool),
        ci: (u32, bool),
        pushed: bool,
        merged: bool,
        unknown_op: bool,
        armed: bool,
        due: bool,
        resolved: bool,
    }

    fn step() -> impl Strategy<Value = Step> {
        (
            (0usize..64, 0usize..8, 0usize..8, 0usize..6),
            ((0u32..3, any::<bool>()), (0u32..3, any::<bool>())),
            (
                any::<bool>(),
                any::<bool>(),
                any::<bool>(),
                any::<bool>(),
                any::<bool>(),
                any::<bool>(),
            ),
        )
            .prop_map(
                |(
                    (pick, actor, trigger, resume_phase),
                    (local, ci),
                    (pushed, merged, unknown_op, armed, due, resolved),
                )| Step {
                    pick,
                    actor,
                    trigger,
                    resume_phase,
                    local,
                    ci,
                    pushed,
                    merged,
                    unknown_op,
                    armed,
                    due,
                    resolved,
                },
            )
    }

    /// A minimal task simulator: the table decides which transitions happen; the facts are
    /// random environment. It tracks verifying/review progress since the last entry into
    /// `running` independently of the table.
    struct Sim {
        state: TaskState,
        facts: TaskFacts,
        verified: bool,
        reviewed: bool,
    }

    fn parse_wire<T: serde::de::DeserializeOwned>(s: &str) -> T {
        serde_json::from_value(serde_json::Value::String(s.to_owned())).unwrap()
    }

    impl Sim {
        fn new() -> Self {
            Sim {
                state: TaskState::Queued,
                facts: TaskFacts::default(),
                verified: false,
                reviewed: false,
            }
        }

        /// Returns `Err` with a description if the ADR-0003 property is violated.
        fn apply(&mut self, s: &Step) -> Result<(), String> {
            let table = try_table().unwrap();
            let candidates: Vec<&TransitionRule> = table
                .task
                .iter()
                .filter(|r| r.from.as_deref() == Some(self.state.as_str()))
                .collect();
            if self.state.is_terminal() {
                if !candidates.is_empty() {
                    return Err(format!("terminal {:?} has exits", self.state));
                }
                return Ok(());
            }
            let rule = candidates[s.pick % candidates.len()];
            let to: TaskState = parse_wire(&rule.to);
            let actor = rule.actors[s.actor % rule.actors.len()];
            let trigger: TaskTrigger = parse_wire(&rule.triggers[s.trigger % rule.triggers.len()]);

            // Environment for this step.
            let now = fixed_now();
            self.facts.ops_outcome_unknown = u32::from(s.unknown_op);
            self.facts.pr_published_this_round = s.pushed;
            self.facts.merge_applied = s.merged;
            self.facts.local_checks = ChecksSincePhase {
                started: s.local.0,
                all_passed: s.local.1,
            };
            self.facts.ci_checks = ChecksSincePhase {
                started: s.ci.0,
                all_passed: s.ci.1,
            };
            self.facts.blocking_requested = return_state_of(self.state).map(|rs| (apr(1), rs));
            self.facts.approval_resolved = if s.resolved { vec![apr(1)] } else { vec![] };
            self.facts.approval_pending =
                if self.state == TaskState::AwaitingApproval && !s.resolved {
                    vec![apr(1)]
                } else {
                    vec![]
                };
            if let Some(i) = self.facts.current_interruption.as_mut() {
                i.auto_resume_armed = s.armed;
                i.not_before = Some(if s.due {
                    ts("2026-11-28T11:00:00.000Z")
                } else {
                    ts("2026-11-28T13:00:00.000Z")
                });
            }

            let mut payload = task_payload(self.state, to, trigger);
            if self.state == TaskState::Preparing {
                payload.resume_phase = phase_of(to);
            }
            if self.state == TaskState::Interrupted && to == TaskState::Queued {
                payload.resume_phase = ResumePhase::ALL.get(s.resume_phase).copied();
            }
            if to == TaskState::AwaitingApproval {
                payload.return_state = return_state_of(self.state);
                payload.approval_id = Some(apr(1));
            }
            if self.state == TaskState::AwaitingApproval {
                payload.approval_id = Some(apr(1));
            }

            let req = TaskTransitionRequest {
                from: Some(self.state),
                to,
                actor,
                trigger,
                payload: Some(&payload),
                now,
            };
            if check_task_transition(table, &req, &self.facts).is_err() {
                return Ok(());
            }

            // The transition happened: update facts and progress.
            let from = self.state;
            let interrupted_phase = match from {
                TaskState::AwaitingApproval => self
                    .facts
                    .awaiting
                    .as_ref()
                    .map(|(_, rs)| match rs {
                        ApprovalReturnState::Running => ResumePhase::Running,
                        ApprovalReturnState::Pr => ResumePhase::Pr,
                        ApprovalReturnState::Ci => ResumePhase::Ci,
                    })
                    .unwrap_or(ResumePhase::Running),
                TaskState::Preparing => self
                    .facts
                    .recorded_resume_phase
                    .unwrap_or(ResumePhase::Running),
                other => phase_of(other).unwrap_or(ResumePhase::Running),
            };
            if to == TaskState::Interrupted {
                self.facts.current_interruption = Some(InterruptionFacts {
                    phase: interrupted_phase,
                    auto_resume_armed: s.armed,
                    not_before: Some(ts("2026-11-28T11:00:00.000Z")),
                });
            }
            if from == TaskState::Interrupted && to == TaskState::Queued {
                self.facts.recorded_resume_phase = payload.resume_phase;
                self.facts.current_interruption = None;
            }
            if from == TaskState::Failed && to == TaskState::Queued {
                // Retry restarts from running (ADR-0003 section 2).
                self.verified = false;
                self.reviewed = false;
                self.facts.recorded_resume_phase = None;
            }
            if from == TaskState::Preparing {
                self.facts.recorded_resume_phase = None;
            }
            self.facts.awaiting = if to == TaskState::AwaitingApproval {
                return_state_of(from).map(|rs| (apr(1), rs))
            } else {
                None
            };
            // Entering `running` from anywhere but an approval detour restarts the workflow.
            if to == TaskState::Running && from != TaskState::AwaitingApproval {
                self.verified = false;
                self.reviewed = false;
            }
            if from == TaskState::Verifying && to == TaskState::Review {
                self.verified = true;
            }
            if from == TaskState::Review && matches!(to, TaskState::Pr | TaskState::Completed) {
                self.reviewed = true;
            }
            self.state = to;
            if matches!(to, TaskState::Pr | TaskState::Ci | TaskState::Completed)
                && !(self.verified && self.reviewed)
            {
                return Err(format!(
                    "{} reached {to:?} without verifying and review (verified={}, reviewed={})",
                    rule.id, self.verified, self.reviewed
                ));
            }
            Ok(())
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig {
            cases: 512,
            failure_persistence: None,
            ..ProptestConfig::default()
        })]

        /// ADR-0003 section 9 "Retry": every path that reaches pr, ci or completed passed
        /// through verifying and review after the last entry into running.
        #[test]
        fn pr_ci_completed_follow_verifying_and_review(steps in prop::collection::vec(step(), 0..=50)) {
            let mut sim = Sim::new();
            for s in &steps {
                if let Err(e) = sim.apply(s) {
                    prop_assert!(false, "{}", e);
                }
            }
        }
    }
}
