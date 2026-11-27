# P2-3: Task and session state machines with transition conditions (pure functions)

> **繁中摘要**：把 `docs/contracts/transitions.json`（47 個 task、25 個 session 轉移）載入成 Rust 轉移檢查函式：輸入目前狀態、目標狀態、actor、trigger、payload 與由 store 算好的 facts，輸出允許的規則或拒絕原因。純函式，無 I/O，時間由參數傳入。轉移表一律從 JSON 載入、不手抄；未知條件名稱讓啟動失敗（fail closed）。附窮舉測試、19 個條件測試與一個 proptest（到達 pr/ci/completed 前必經 verifying 與 review）。模型等級：一般模型實作＋強模型審查。

Issues: #7, #3 | Gate (#51): G3, G8 (no data loss) | Model tier: **standard model implements, strong model reviews**

## 1. Goal and non-goals

Goal: turn `docs/contracts/transitions.json` into Rust transition checks. Input: current state, target state, actor, trigger, payload, and facts computed by the store. Output: the matching rule or the reason for rejection. No I/O, no clock reads (time is a parameter).

Non-goals: computing facts (P2-5 projections provide them), writing to the database (P2-4), recovery (P2-6).

## 2. Prerequisites and parallel work

- Prerequisites: P2-1 (enums). P2-2's `TaskStateChangedPayload` is also needed; you can write the table loading first and wire payloads once P2-2 merges.
- Parallel: P2-2, P2-4 schema work, P3-1, P4-1, P5-1.

## 3. Files

New:

- `crates/agentdock-core/src/transitions/mod.rs` (table loading, `check_task_transition`, `check_session_transition`)
- `crates/agentdock-core/src/transitions/conditions.rs` (`Condition` enum and each check)
- `crates/agentdock-core/src/transitions/facts.rs` (`TaskFacts`, `SessionFacts`)
- `crates/agentdock-core/tests/transitions_exhaustive.rs`

Modified: `crates/agentdock-core/src/lib.rs`; `crates/agentdock-core/src/enums.rs` (add `pub const ALL: [Self; N]` to `TaskState`, `SessionState`, `ActorKind`, `TaskTrigger`, `SessionTrigger` if P2-1 did not).

## 4. Public types and signatures

```rust
// transitions/mod.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Durability { PersistThenReport, PersistThenAct }

#[derive(Debug, Clone)]
pub struct TransitionRule {
    pub id: String,                  // "T12", "S20"
    pub from: Option<String>,        // None = creation (T01, S01)
    pub to: String,
    pub actors: Vec<ActorKind>,
    pub triggers: Vec<String>,
    pub durability: Durability,
    pub conditions: Vec<Condition>,
}

pub struct TransitionTable { pub task: Vec<TransitionRule>, pub session: Vec<TransitionRule> }

#[derive(Debug, thiserror::Error)]
pub enum TableError { #[error("transitions.json: {0}")] Parse(String), #[error("unknown condition {0:?}")] UnknownCondition(String) }

/// Parsed once from include_str!("../../../../docs/contracts/transitions.json") via OnceLock.
/// No panics: store init calls try_table() at startup and fails closed on Err.
pub fn try_table() -> Result<&'static TransitionTable, &'static TableError>;
/// Internal entry point used by try_table() and by the unknown-condition test.
pub(crate) fn parse_table(json: &str) -> Result<TransitionTable, TableError>;

pub struct TaskTransitionRequest<'a> {
    pub from: Option<TaskState>,     // None for task.created
    pub to: TaskState,
    pub actor: ActorKind,
    pub trigger: TaskTrigger,
    pub payload: Option<&'a TaskStateChangedPayload>, // None only for task.created
    pub now: Timestamp,
}
pub struct SessionTransitionRequest<'a> {
    pub from: Option<SessionState>,
    pub to: SessionState,
    pub actor: ActorKind,
    pub trigger: SessionTrigger,
    pub payload: Option<&'a SessionStateChangedPayload>,
    pub launch_method: Option<LaunchMethod>, // from the payload or session.created
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TransitionError {
    #[error("illegal transition {from:?} -> {to:?}")] Illegal { from: Option<String>, to: String },
    #[error("{rule}: actor {actor:?} not allowed")] Actor { rule: String, actor: ActorKind },
    #[error("{rule}: trigger {trigger} not allowed")] Trigger { rule: String, trigger: String },
    #[error("{rule}: condition {condition:?} failed: {detail}")]
    Condition { rule: String, condition: Condition, detail: &'static str },
}

pub fn check_task_transition<'t>(table: &'t TransitionTable, req: &TaskTransitionRequest<'_>, facts: &TaskFacts)
    -> Result<&'t TransitionRule, TransitionError>;
pub fn check_session_transition<'t>(table: &'t TransitionTable, req: &SessionTransitionRequest<'_>, facts: &SessionFacts)
    -> Result<&'t TransitionRule, TransitionError>;
```

```rust
// transitions/conditions.rs — one variant per condition name in transitions.json (serde snake_case).
pub enum Condition {
    ResumePhaseEqualsTo, RetryRestartsFromRunning, NoUnreconciledOperations, NoOpenOperations,
    ResumePhaseWithinInterruptedPhase, MergeEvidenceIfIntegration, ApprovalRequestedBefore,
    ReturnStateMatches, ApprovalResolvedBefore, ApprovalNotPendingAfter, LocalChecksPassed,
    CiChecksPassed, PrPublishedThisRound, OrchestratorOnlyIfAutoResumeArmedAndDue,
    LaunchMethodAdvertised, ReattachCapabilityRequired,
}
```

```rust
// transitions/facts.rs — computed by the store inside the append transaction (P2-5).
#[derive(Debug, Clone, Default)]
pub struct ChecksSincePhase { pub started: u32, pub all_passed: bool }

#[derive(Debug, Clone, Default)]
pub struct TaskFacts {
    pub recorded_resume_phase: Option<ResumePhase>,     // set by T44, consumed by T04..T08
    pub current_interruption: Option<Interruption>,     // when task is interrupted
    pub awaiting: Option<(ApprovalId, ApprovalReturnState)>, // when task is awaiting_approval
    pub approval_pending: Vec<ApprovalId>,              // pending approvals of this task
    pub approval_resolved: Vec<ApprovalId>,             // resolved approvals of this task
    pub blocking_requested: Option<(ApprovalId, ApprovalReturnState)>, // latest pending blocking approval
    pub ops_recorded_or_started: u32,
    pub ops_outcome_unknown: u32,
    pub unused_grants: u32,                             // approved host_policy approvals not consumed
    pub local_checks: ChecksSincePhase,                 // since last entering verifying (approval detours do not reset)
    pub ci_checks: ChecksSincePhase,                    // since last entering ci
    pub pr_published_this_round: bool,
    pub merge_applied: bool,                            // pr_merge succeeded or reconciled_applied
}

#[derive(Debug, Clone, Default)]
pub struct SessionFacts {
    pub snapshot_for_this_launch: Option<CapabilityFeatures>, // features of the process started for this launch
    pub latest_snapshot: Option<CapabilityFeatures>,
    pub external_session_id_known: bool,
    pub pending_approvals_of_session: Vec<ApprovalId>,
    pub approval_resolved: Vec<ApprovalId>,
}
```

Condition semantics follow **exactly** the "Conditions" table of `docs/contracts/state-machines.md` (main `c9e33cf` lines 159–179). Summary:

| Condition | Check (from facts / payload) |
| --- | --- |
| `resume_phase_equals_to` | `payload.resume_phase == Some(to as phase)` and `== facts.recorded_resume_phase`; reject when `recorded_resume_phase` is `None` (after a retry only T04 is possible) |
| `retry_restarts_from_running` | `payload.resume_phase.is_none()` |
| `no_unreconciled_operations` | `ops_recorded_or_started == 0 && ops_outcome_unknown == 0` |
| `no_open_operations` | `ops_recorded_or_started == 0 && unused_grants == 0` |
| `resume_phase_within_interrupted_phase` | `payload.resume_phase <= current_interruption.phase` |
| `merge_evidence_if_integration` | actor is not integration, or `merge_applied` |
| `approval_requested_before` | `blocking_requested == Some((payload.approval_id, return_state))` and return_state equals the state being left |
| `return_state_matches` | `facts.awaiting == Some((payload.approval_id?, to as return_state))` |
| `approval_resolved_before` | the awaited approval is in `approval_resolved` |
| `approval_not_pending_after` | `approval_pending.is_empty()` (session variant: `pending_approvals_of_session`) |
| `local_checks_passed` / `ci_checks_passed` | `started >= 1 && all_passed` |
| `pr_published_this_round` | `facts.pr_published_this_round` (store computes it per line 175: a push of this round succeeded or reconciled applied, and a PR exists) |
| `orchestrator_only_if_auto_resume_armed_and_due` | actor user → pass; actor orchestrator → trigger must be `scheduled_resume`, `auto_resume_armed`, and `now >= retry_hint.not_before` |
| `launch_method_advertised` | `new` → pass; `load` → `snapshot_for_this_launch.load_session`; `resume` → `.resume_session` |
| `reattach_capability_required` | `latest_snapshot` advertises the needed method and `external_session_id_known` |

## 5. Implementation steps

1. Write the §6 exhaustive and condition tests first.
2. Deserialize `transitions.json` with serde into intermediate structs, then convert to `TransitionRule`. An unknown condition name → `TableError::UnknownCondition` (fail closed: table and code out of sync means startup fails).
3. `check_*`: find the rule whose `from`/`to` match (each pair has at most one rule); check actor, trigger, then conditions in order; return the first failure.
4. Never hand-copy the table into Rust constants; always load the JSON so code and contract stay in sync.

## 6. Tests to write first

```rust
// crates/agentdock-core/tests/transitions_exhaustive.rs
use agentdock_core::{enums::*, transitions::*};

#[test]
fn every_task_triple_matches_transitions_json() {
    let table = try_table().unwrap();
    let states: Vec<Option<TaskState>> = std::iter::once(None).chain(TaskState::ALL.iter().copied().map(Some)).collect();
    for from in &states { for to in TaskState::ALL { for actor in ActorKind::ALL { for trigger in TaskTrigger::ALL {
        let listed = table.task.iter().any(|r|
            r.from.as_deref() == from.map(|s| s.as_str()) && r.to == to.as_str()
            && r.actors.contains(&actor) && r.triggers.iter().any(|t| t == trigger.as_str()));
        // permissive_for builds a payload that passes the schema rules and facts that satisfy every condition,
        // so only (from, to, actor, trigger) decide. Write it for real; it is the core of this test.
        let (payload, facts) = permissive_for(*from, to, actor, trigger);
        let req = TaskTransitionRequest { from: *from, to, actor, trigger, payload: payload.as_ref(), now: fixed_now() };
        let got = check_task_transition(table, &req, &facts).is_ok();
        assert_eq!(got, listed, "{from:?} -> {to:?} by {actor:?} via {trigger:?}");
    }}}}
}
// Same for sessions: every_session_triple_matches_transitions_json.
```

Condition tests (one `#[test]` each, named after the contract mutation where one exists):

| Test | Request | Facts change | Expected |
| --- | --- | --- | --- |
| `retry_skips_to_pr` | `preparing → pr` (T07), actor orchestrator | `recorded_resume_phase = None` | `Condition{ResumePhaseEqualsTo}` |
| `resume_beyond_phase` | `interrupted → queued` (T44), `resume_phase = ci` | `current_interruption.phase = review` | `Condition{ResumePhaseWithinInterruptedPhase}` |
| `early_auto_resume` | T44 by orchestrator, trigger `scheduled_resume` | armed, `not_before` = now + 1 min | `Condition{OrchestratorOnly...}` |
| `auto_resume_after_crash` | T44 by orchestrator | interruption `host_crashed`, `auto_resume_armed=false` | same |
| `user_can_resume_anytime` | T44 by user, `resume_requested` | not armed | `Ok` |
| `retry_without_reconcile` | `failed → queued` (T47) | `ops_outcome_unknown = 1` | `Condition{NoUnreconciledOperations}` |
| `cancel_with_started_op` | `running → cancelled` (T16) | `ops_recorded_or_started = 1` | `Condition{NoOpenOperations}` |
| `cancel_with_unused_grant` | same | `unused_grants = 1` | `Condition{NoOpenOperations}` |
| `verify_with_failed_check` | `verifying → review` (T23) | `local_checks = {started: 2, all_passed: false}` | `Condition{LocalChecksPassed}` |
| `verify_with_no_check` | same | `started = 0` | same |
| `second_round_without_push` | `pr → ci` (T34) | `pr_published_this_round = false` | `Condition{PrPublishedThisRound}` |
| `integration_completes_without_merge` | `ci → completed` (T39) by integration | `merge_applied = false` | `Condition{MergeEvidenceIfIntegration}` |
| `user_completes_ci_without_merge_evidence` | T39 by user | `merge_applied = false`, ci checks passed | `Ok` |
| `act_before_approval_persisted` | `awaiting_approval → running` (T17) | awaited approval not in `approval_resolved` | `Condition{ApprovalResolvedBefore}` |
| `return_to_wrong_state` | `awaiting_approval → pr` | `awaiting.return_state = running` | `Condition{ReturnStateMatches}` |
| `agent_text_cannot_move_task` | `running → verifying` by `adapter` | permissive | `Actor` error |
| `load_without_capability` | session `disconnected → starting` (S20), `launch_method=load` | `latest_snapshot.load_session=false` | `Condition{ReattachCapabilityRequired}` |
| `idle_without_snapshot_for_load` | session `starting → idle` (S02), `launch_method=load` | `snapshot_for_this_launch=None` | `Condition{LaunchMethodAdvertised}` |
| `unknown_condition_fails_closed` | `parse_table` on JSON containing `"conditions":["made_up"]` | — | `Err(TableError::UnknownCondition)` |

Plus one **proptest** (`proptest` crate): random sequences of up to 50 steps (pause / resume / retry / crash / check results / approvals) applied to a minimal simulator that uses `check_task_transition` to decide whether to advance. Assert: every path that reaches `pr`, `ci` or `completed` passed through `verifying` and `review` after the last entry into `running` (the property test required by the ADR-0003 §9 "Retry" row).

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-core transitions     # 2 exhaustive + 19 condition + 1 proptest pass
cargo clippy -p agentdock-core --all-targets -- -D warnings
```

No Windows-only items.

## 8. Spec references and porting sources

All line numbers refer to main `c9e33cf`.

- `docs/contracts/transitions.json` (47 task and 25 session transitions; the **single source of truth**, `state-machines.md` line 4).
- `docs/contracts/state-machines.md` lines 6–16 (rules for every transition), lines 92–143 (task transition table), lines 159–179 (Conditions).
- ADR-0003 §2 (terminal states, retry, resume, approvals return to the prior state), §9 table rows "Retry, resume and reconciliation gates" and "Capability-gated reattach" (required backend tests).
- No porting source.

## 9. Dependencies

| Crate | Version | Status |
| --- | --- | --- |
| `proptest` (dev-dependency) | 1.12.0 | needs audit |

## 10. Model tier

A standard model can implement it (pure functions plus tables), but a wrong condition lets a non-repeatable operation run twice or skip verification. **A strong model must review** each condition against the state-machines.md Conditions table.

## 11. Common mistakes and pitfalls

- Treating `from: null` (creation) as "any state": it means only `task.created` / `session.created`.
- `awaiting_approval`'s `return_state` is only `running`, `pr` or `ci`; approvals during `verifying` / `review` neither block nor transition (ADR-0003 §2). Do not generate T12 for them.
- `failed` is not terminal (it can be retried); `completed` and `cancelled` are. UX documents also call `failed` and `interrupted` "terminal" (ADR-0003 line 31 explains both usages). `is_terminal()` uses the state-machine meaning.
- Compare `not_before` with the `now` parameter; never call `Timestamp::now()` inside the function (flaky tests).
- Never read the database inside a condition; if facts are insufficient, extend `TaskFacts` and explain in the PR.

## 12. Reviewer checklist

- [ ] Is the table loaded from `transitions.json` (not hand-copied), and does an unknown condition fail startup?
- [ ] Does each condition match its row in state-machines.md lines 159–179, word for word?
- [ ] Does the exhaustive test cover the `None` (creation) source and all actors and triggers?
- [ ] Is `now` always a parameter?
- [ ] Does the proptest's property match ADR-0003 §9 (verifying and review after the last entry into running)?
