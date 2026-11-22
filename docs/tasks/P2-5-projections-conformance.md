# P2-5: Projections, write-time invariants and contract fixture conformance

> **繁中摘要**：實作 `ContractProjector`（P2-4 的 `Projector`）：在 append 交易內更新 projects/tasks/sessions/approvals/operations/checks projection，從 projection 算出 facts 呼叫 P2-3 的轉移檢查，並強制 approval／operation／check 的生命週期與 actor 規則（例如 policy 不得核准 merge、push 必須綁定最近 checkpoint 的 head 且 dirty=false、同一個 once 核准不能啟動兩次）。用 13 個契約 fixture 跑一致性測試（fixture 12 改用 predelete 串流），並以 ≥30 個從 fixture 改壞的對抗串流確認被拒絕。超過 400 行時拆成 P2-5a／P2-5b。模型等級：強模型實作＋強模型審查。

Issues: #7, #3, #8 | Gate (#51): G3, G7, G8 | Model tier: **strong model implements and reviews**

## 1. Goal and non-goals

Goal: `ContractProjector` in `agentdock-store` (the P2-4 `Projector`). Inside the append transaction it:

1. Updates the `projects/tasks/sessions/approvals/operations/checks` projections per event.
2. Builds `TaskFacts` / `SessionFacts` from the projections and calls the P2-3 transition checks; anything illegal rolls back the whole transaction.
3. Enforces approval / operation / check lifecycle and actor rules (§4 table).
4. Conformance tests with the 13 contract fixtures: appending every event succeeds and the final task/session states equal `*.expected.json`; streams broken on purpose (mutations) are rejected.

Non-goals: the recovery allow-list and bracket (P2-6), attention derivation (P8-1), task deletion and tombstone preconditions (not covered). Fixtures 06, 07, 11, 12 and 13 contain `system.recovery_started` … `system.recovery_completed` brackets: this packet only applies projections and ordinary transition checks to recovery-actor events (transitions.json already lists `recovery` as a legal actor for T09, T14 etc.); "only allow-listed events inside the bracket" is added by P2-6.

If this exceeds ~400 lines, split into **P2-5a** (projections + transition checks + positive fixture tests) and **P2-5b** (lifecycle rules + mutation tests), one PR each, in that order.

## 2. Prerequisites and parallel work

- Prerequisites: P2-2, P2-3, P2-4.
- Parallel: P3-*, P4-1, P4-2, P5-*.

## 3. Files

New:

- `crates/agentdock-store/src/projector/mod.rs` (`ContractProjector`)
- `crates/agentdock-store/src/projector/apply.rs` (projection update per event)
- `crates/agentdock-store/src/projector/facts.rs` (facts from projection queries)
- `crates/agentdock-store/src/projector/lifecycle.rs` (§4 rules)
- `crates/agentdock-store/src/replay.rs` (`Store::replay_fixture_event`, compiled only under `#[cfg(any(test, feature = "fixture-replay"))]`)
- `crates/agentdock-store/tests/common/mod.rs` (fixture loading, temp dirs)
- `crates/agentdock-store/tests/contract_fixtures.rs`
- `crates/agentdock-store/tests/contract_mutations.rs`

Modified: `crates/agentdock-store/src/lib.rs` (`Store::open` uses `ContractProjector` by default), `crates/agentdock-store/Cargo.toml` (feature `fixture-replay`), `crates/agentdock-store/src/migrations/0001_init.sql` (if projection columns are missing: no database has shipped before this packet, so edit 0001 directly; if P2-4 already shipped user data, add 0002 instead and explain in the PR).

## 4. Public types and signatures

```rust
pub struct ContractProjector { table: &'static TransitionTable }
impl ContractProjector { pub fn new() -> Result<Self, String>; } // fails closed if transitions.json can't load
impl Projector for ContractProjector { fn apply(&self, tx, event, body) -> Result<(), String>; }

/// Read models (also used by Tauri commands later).
pub struct TaskRow { pub id: TaskId, pub project_id: ProjectId, pub state: TaskState, pub objective: String,
    pub branch: Option<String>, pub worktree_path: Option<String>, pub interruption: Option<Interruption>,
    pub awaiting: Option<(ApprovalId, ApprovalReturnState)>, pub last_seq: u64 }
pub struct SessionRow { pub id: SessionId, pub task_id: TaskId, pub state: SessionState, pub role: SessionRole,
    pub adapter_id: AdapterId, pub parent_session_id: Option<SessionId>, pub archived: bool, pub last_seq: u64 }
pub struct ApprovalRow { pub id: ApprovalId, pub task_id: TaskId, pub session_id: Option<SessionId>,
    pub source: ApprovalSource, pub operation_kind: String, pub classified_kind: Option<PolicyClass>,
    pub fingerprint: Sha256Hex, pub state: ApprovalState, pub scope: ApprovalScope,
    pub return_state: Option<ApprovalReturnState>, pub expires_at: Option<Timestamp>, pub consumed: bool }
pub struct OperationRow { pub id: OperationId, pub task_id: TaskId, pub kind: OperationKind,
    pub idempotency_key: Sha256Hex, pub state: OperationState, pub approval_id: ApprovalId,
    pub target: OperationTarget, pub supersedes: Option<OperationId> }
pub struct CheckRow { pub id: CheckId, pub task_id: TaskId, pub name: String, pub origin: CheckOrigin,
    pub state: CheckState, pub exit_code: Option<i64>, pub started_seq: u64 }

impl Store {
    pub fn task(&self, id: &TaskId) -> Result<Option<TaskRow>>;
    pub fn tasks(&self) -> Result<Vec<TaskRow>>;
    pub fn sessions_of(&self, task: &TaskId) -> Result<Vec<SessionRow>>;
    pub fn approvals_of(&self, task: &TaskId) -> Result<Vec<ApprovalRow>>;
    pub fn operations_of(&self, task: &TaskId) -> Result<Vec<OperationRow>>;
    pub fn checks_of(&self, task: &TaskId) -> Result<Vec<CheckRow>>;
    #[cfg(any(test, feature = "fixture-replay"))]
    /// Appends a fixture event keeping its seq/recorded_at; still requires seq == head+1 and runs all checks.
    pub fn replay_fixture_event(&self, env: EventEnvelope) -> Result<()>;
}
```

Write-time rules (each failure returns `Rejected(<fixed message>)`; tests match the message):

| Rule | Source |
| --- | --- |
| `task.state_changed` / `session.state_changed` pass the P2-3 check; `payload.from` equals the current projected state | transitions.json; state-machines.md lines 8–10 |
| `approval.resolved{approved}` actor is `user` or `policy` only; when kind ∈ {pr_merge, branch_delete, worktree_remove, destructive_command} or class ∈ {pr_merge, force_push, branch_delete, worktree_remove, destructive_command, unclassified}, only `user` | ADR-0003 §6; mutations `e13_policy_approves_merge`, `b3a_policy_approves_acp_merge` |
| `approval.resolved`'s `task_id` (and `session_id`) equal those of the approval | mutation `r6_approval_resolved_routed_to_other_task` |
| A host_policy `approval.requested` immediately follows an `operation.recorded` of the same task and id, and its fingerprint equals the `idempotency_key` | mutation `n6a_approval_of_other_task`; checkpoint-and-replay Rules 2–3 |
| At most one blocking (with `return_state`) pending approval per task; approvals during `verifying` / `review` carry no `return_state` | mutations `n4_second_blocking_approval`, `e5_review_approval_blocks` |
| `operation.recorded` only by orchestrator; an existing op with the same `idempotency_key` in `recorded/started/succeeded/reconciled_applied` → reject; `supersedes_operation_id` must point to `abandoned`, `failed{effect:none}`, `reconciled_not_applied`, `reconciled_undeterminable` (or `outcome_unknown` of an `idempotent_with_key` op) | Rule 5; mutations `r6_adapter_records_operation`, `e2b_supersede_recorded_op`, `b1a_*`, `b1b_*` |
| `operation.recorded` / `started` only in the task states the kind allows (Classification table) | mutations `e9_push_during_review`, `e1_start_after_crash` |
| `operation.started`: actor orchestrator; operation `recorded`; approval `approved`, same task, not consumed, not expired (`occurred_at < expires_at`); for `git_push` the latest checkpoint has a `worktree` with `dirty=false` and `head_sha == expected_sha`; for `pr_merge` `expected_sha` equals the `expected_sha` of the latest succeeded (or reconciled_applied) `git_push`; on success mark a `once` approval consumed in the same transaction | Rules 3, 4, 9, 10; mutations `rerun_push_after_crash`, `n6b_start_after_expiry`, `n6c_policy_starts_operation`, `r5_push_after_checkpoint_without_worktree`, `n3b_*`, `n3c_*`, `r5_merge_bound_to_earlier_success` |
| `operation.succeeded` / `failed` and `check.finished` (`passed/failed/errored/cancelled`) only by orchestrator or integration | Rule 11; mutations `r4_adapter_reports_operation_result`, `r4_adapter_reports_check_result` |
| `operation.outcome_unknown{cause: killed}` is not allowed for `pr_merge` | mutation `b5_kill_started_merge` |
| `operation.abandoned` requires its approval not `pending` | mutation `abandon_while_approval_pending` |
| `operation.reconciled` with strategy `none` allows only finding `undeterminable` | mutation `n6d_probe_less_reconcile_finding` |
| `session.state_changed` S10's approval belongs to the same session; on S09 / S14 the session has no other pending approval | mutations `r6_permission_of_other_session`, `r6_session_leaves_with_second_pending_approval` |
| `acp_replay` events are only message_delta / tool_call / plan_updated, while the session is `starting`, launch method `load`, and this launch's snapshot advertises `loadSession` | events.md line 42; mutations `replay_outside_load`, `r4_replay_without_current_load_capability` |

Archive / unarchive rules (state-machines.md "Archiving sessions") are implemented here too; alpha needs no UI for them, only fixture conformance.

## 5. Implementation steps

1. `apply.rs`: one function per `EventBody` variant updating its table; for `task.state_changed` build facts and check before updating.
2. `facts.rs`: SQL queries that build the P2-3 facts (e.g. `local_checks` = checks with origin `local` after the seq of the latest entry into `verifying`). Store "seq of the latest entry into state X" as columns on `tasks` (`entered_verifying_seq`, `entered_ci_seq`, `pr_round_start_seq`), updated while applying transitions.
3. `lifecycle.rs`: one small function per §4 row, fixed error strings.
4. `replay.rs`: shares every check with `Tx::append`; the only difference is keeping the fixture's `seq` / `recorded_at`.
5. Write tests, run the fixtures. If a fixture fails, **first assume your implementation is wrong**. Only when the contract and a fixture truly contradict each other, stop and report; never edit fixtures.

## 6. Tests to write first

```rust
// crates/agentdock-store/tests/contract_fixtures.rs
mod common;
use agentdock_store::Store;

#[test]
fn all_13_fixtures_replay_and_match_expected_states() {
    for (name, events, expected) in common::load_fixtures() {          // reads NN-*.jsonl + NN-*.expected.json
        let dir = common::temp_dir();                                  // "agent dock 測試-..."
        let store = Store::open(common::opts(&dir)).unwrap();
        for env in events {
            let seq = env.seq;
            store.replay_fixture_event(env).unwrap_or_else(|e| panic!("{name} seq {seq}: {e}"));
        }
        for (task, state) in expected.final_task_states {
            assert_eq!(store.task(&task).unwrap().unwrap().state, state, "{name} {task}");
        }
        for (session, state) in expected.final_session_states {
            assert_eq!(common::session_state(&store, &session), state, "{name} {session}");
        }
    }
}

#[test]
fn every_transition_in_table_is_exercised_by_some_fixture() {
    // Collect (from,to) pairs seen across all fixtures; must equal the 47 + 25 pairs in transitions.json.
}
```

Only fixture 12 contains a task deletion (checked 2026-11-22: seq 164 is `task.deleted`; seq 1–20 and others are rewritten as tombstones with empty payloads, which cannot be applied). This packet does not implement deletion, so for fixture 12 replay `fixtures/predelete/12-session-edge-cases.jsonl` (163 events, the stream before deletion) and compare only the entities in `12-session-edge-cases.expected.json` that do **not** belong to the deleted task `tsk_01JDQ012000000000000000001`. Leave `task.deleted` and tombstone checks to the deletion packet (mark with `// TODO(task-deletion packet)` and list it in the PR). The other 12 fixtures run in full.

`contract_mutations.rs`: one test per mutation named in the §4 table. Load the named fixture, change one event with a small function (the same change as `_m_<name>` in `validate_fixtures.py` — read that Python function first and do exactly that), replay; the changed event must return `Rejected` with the expected message fragment. At least:

`e13_policy_approves_merge`, `b3a_policy_approves_acp_merge`, `r6_approval_resolved_routed_to_other_task`, `n6a_approval_of_other_task`, `n4_second_blocking_approval`, `e5_review_approval_blocks`, `r6_adapter_records_operation`, `e2b_supersede_recorded_op`, `b1a_duplicate_pr_create_new_description`, `b1b_repush_after_applied_new_description`, `e9_push_during_review`, `e1_start_after_crash`, `rerun_push_after_crash`, `n6b_start_after_expiry`, `n6c_policy_starts_operation`, `r5_push_after_checkpoint_without_worktree`, `n3b_push_other_than_checkpoint_head`, `n3c_merge_other_than_pushed_head`, `r4_adapter_reports_operation_result`, `r4_adapter_reports_check_result`, `b5_kill_started_merge`, `abandon_while_approval_pending`, `n6d_probe_less_reconcile_finding`, `r6_permission_of_other_session`, `r6_session_leaves_with_second_pending_approval`, `replay_outside_load`, `illegal_transition`, `act_before_approval_persisted`, `verify_with_failed_check`, `n3a_second_round_without_push`.

Plus the concurrency test `two_writers_same_idempotency_key`: two threads `transact` an `operation.recorded` with the same key at the same time; exactly one succeeds (ADR-0003 §9: "including concurrent writers").

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-store --features fixture-replay   # contract_fixtures 2, contract_mutations ≥ 30, concurrency 1 pass
cargo clippy -p agentdock-store --all-targets --all-features -- -D warnings
python3 -B -I docs/contracts/validate_fixtures.py         # still exit 0
```

No Windows-only items (CI `rust-windows` runs the same tests).

## 8. Spec references and porting sources

All line numbers refer to main `c9e33cf`.

- ADR-0003 §6 (approvals and operations), the right column of the whole §9 table (backend tests #7 must add per area).
- `docs/contracts/checkpoint-and-replay.md` lines 37–51 (checkpoints), lines 71–83 (Classification), lines 98–113 (Rules 1–11).
- `docs/contracts/state-machines.md` lines 159–179 (Conditions), "Archiving sessions" from line 241.
- `docs/contracts/events.md` line 42 (acp_replay limits).
- `docs/contracts/validate_fixtures.py` `MUTATIONS` and each `_m_<name>` (the only reference for how each mutation edits the stream).
- Behavior references (Node draft, test ideas only, do not port code): PR #29, SHA `c57b824d`, `apps/runtime/task-workflow.test.mjs` line 340 (a repeated request creates no duplicate rows), line 370 (gates still hold after restart).

## 9. Dependencies

None new.

## 10. Model tier

Strong model implements and reviews. This packet carries most of the backend guarantees in ADR-0003's "Enforcement boundary"; one missing rule can run a non-repeatable operation twice or let policy approve a merge.

## 11. Common mistakes and pitfalls

- Checking only in Rust memory without reading projections inside the same transaction: concurrent writers break it. Every check queries through `tx` inside `Projector::apply`.
- Ordering by `recorded_at`: always use `seq` (events.md line 37).
- "Approval consumed" must be marked in the same transaction as `operation.started`, or one `once` approval can start two operations.
- Editing fixtures to make tests pass: forbidden. Fixtures are part of the contract.
- Misspelled mutation names break traceability; copy them from ADR-0003 §9.

## 12. Reviewer checklist

- [ ] Does each §4 row have a check in `lifecycle.rs` and a mutation test that fails without it?
- [ ] Are all checks executed through the transaction handle (no in-memory caches)?
- [ ] Is the `once` approval marked consumed in the same transaction as `operation.started`?
- [ ] Does fixture 12 use the predelete stream and skip only the deleted task's entities?
- [ ] Were any fixtures or contract files modified? (They must not be.)
- [ ] Does `two_writers_same_idempotency_key` really run two concurrent writers?
