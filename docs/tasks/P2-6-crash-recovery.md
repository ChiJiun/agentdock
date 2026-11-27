# P2-6: Startup crash recovery (allow-list, bracket, hard-kill tests)

> **繁中摘要**：`Store::recover(now)` 在每次啟動、接受任何命令前執行，依契約「Crash recovery」第 1–9 步把未完成的東西推到安全停止：session → disconnected、pending 與已核准未用的 approval → invalidated、started operation → outcome_unknown、recorded operation → abandoned、running check → outcome_unknown、進行中 task → interrupted（不自動恢復），前後加 `system.recovery_started`／`completed` 括號。Projector 加上括號規則（括號內只允許 recovery actor 的白名單事件）。用子程序在「先持久化再行動」的每個縫隙硬性終止，證明不可重放操作不會執行兩次。模型等級：強模型實作＋強模型審查。

Issues: #7, #8 | Gate (#51): G3 (true state after interruption/reopen), G8 (app recovery, no data loss) | Model tier: **strong model implements and reviews**

## 1. Goal and non-goals

Goals:

- `Store::recover(now)`: runs on every start before any command is accepted, and follows steps 1–9 of `checkpoint-and-replay.md` "Crash recovery" to push everything unfinished to a safe stop: sessions → `disconnected(host_recovery)`; pending approvals and approved-but-unused grants → `invalidated`; `started` operations → `outcome_unknown{host_crash}`; `recorded` operations → `abandoned{host_recovery}`; `running` checks → `outcome_unknown`; in-flight tasks → `interrupted{host_crashed, auto_resume_armed:false}`; `session.unarchived{by: system}` where needed; wrapped in `system.recovery_started` / `system.recovery_completed`.
- Projector bracket rules: inside the bracket only allow-listed recovery-actor events; the recovery actor cannot write outside the bracket; the lists in `recovery_completed` equal exactly the entities changed inside the bracket; at the end nothing is left pending / unused-grant / recorded / started / running / live / in-flight.
- Hard-kill tests: kill the process at every gap of "persist then act", reopen, and prove no non-repeatable operation ran twice.

Non-goals: live reconciliation (P7-2 / P8-4 probes); automatic resume (never, ADR-0003 §6).

## 2. Prerequisites and parallel work

- Prerequisites: P2-5.
- Parallel: P3-1..P3-4, P3-5a, P4-1, P4-2, P5-*. (P3-7 and P4-3a depend on this packet.)

## 3. Files

New:

- `crates/agentdock-store/src/recovery.rs`
- `crates/agentdock-store/src/projector/recovery_rules.rs`
- `crates/agentdock-store/tests/recovery_fixtures.rs`
- `crates/agentdock-store/tests/recovery_kill.rs`
- `crates/agentdock-store/tests/recovery_property.rs`
- `crates/agentdock-store/src/bin/agentdock-store-crash-harness.rs` (child process for the kill tests; `[[bin]]`, `test = false`, `required-features = ["fixture-replay"]` if it needs replay helpers)

Modified: `crates/agentdock-store/src/lib.rs`, `crates/agentdock-store/src/projector/mod.rs`, `crates/agentdock-store/Cargo.toml`.

## 4. Public types and signatures

```rust
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecoveryReport {
    pub tasks_interrupted: Vec<TaskId>,
    pub sessions_disconnected: Vec<SessionId>,
    pub approvals_invalidated: Vec<ApprovalId>,
    pub operations_marked_unknown: Vec<OperationId>,
    pub operations_abandoned: Vec<OperationId>,
    pub checks_marked_unknown: Vec<CheckId>,
    pub sessions_unarchived: Vec<SessionId>,   // report only: NOT a field of RecoveryCompletedPayload (additionalProperties: false); never serialize it into the event
}
impl RecoveryReport { pub fn is_empty(&self) -> bool; }

impl Store {
    /// Runs recovery. If nothing needs changing, writes NO events (no empty bracket) and returns an empty report.
    /// Otherwise: recovery_started, one transaction per entity in the order of steps 2..8 (+8a), then recovery_completed
    /// (checkpoint-and-replay.md line 54: "in the order of the list, one transaction per entity").
    /// No command may be processed before this returns.
    pub fn recover(&self, now: Timestamp) -> Result<RecoveryReport>;
}
```

Steps (**follow `docs/contracts/checkpoint-and-replay.md` lines 52–67**; summary only):

| Step | Target | Event written (actor `recovery`, provenance `recovery`) |
| --- | --- | --- |
| 1 | events table | verify per-authority seq contiguity; if projections disagree with events, rebuild from events (replay through the P2-5 projector) |
| 2 | sessions in starting/idle/active/awaiting_permission/suspended | `session.state_changed → disconnected`, trigger `host_recovery` |
| 3 | `pending` approvals | `approval.resolved{state: invalidated}` |
| 4 | host_policy approvals `approved` but not consumed by `operation.started` | `approval.resolved{state: invalidated}` |
| 5 | operations `started` | `operation.outcome_unknown{cause: host_crash}` |
| 6 | operations `recorded` | `operation.abandoned{reason: host_recovery}` |
| 7 | checks `running` | `check.finished{state: outcome_unknown}` |
| 8 | tasks in preparing/running/awaiting_approval/verifying/review/pr/ci | `task.state_changed → interrupted`, `interruption{reason: host_crashed, phase, auto_resume_armed: false, open_operation_ids}` |
| 8a | an event made an archived session "wait for the user" | immediately after it, `session.unarchived{by: system}` |
| 9 | — | `system.recovery_completed` with the lists of §4 |

`interruption.phase` follows the schema's `Interruption.phase` description: if the state being left is a phase, use it; leaving `awaiting_approval` uses `return_state`; leaving `preparing` uses the `resume_phase` being restored, otherwise `running`.

## 5. Implementation steps

1. Write the §6 tests first.
2. `recovery_rules.rs`: add "inside bracket" state to the projector (stored in table `meta`, key `recovery_open`) and implement every rejection in the ADR-0003 §9 "Crash recovery" row.
3. `recovery.rs`: follow the step order, one `transact` per entity (`checkpoint-and-replay.md` line 54; line 65 says "the recovery transaction" in the singular — a wording conflict listed in the README; this packet follows line 54, and the `recovery_completed` lists come from the entities changed in this run plus any already inside an open bracket). Step 8a must not depend on P8-1 attention (it does not exist yet). Use the minimal check: the event put the session's task into `reconcile_needed` (an `outcome_unknown` operation exists) or the task is still `running` with no live session — the two cases of fixture 13. P8-1 later replaces this with the attention function and keeps the tests.
4. The caller (P3-7 app bootstrap) calls `recover` right after `Store::open`; document on `Store` that no command may be processed before `recover` returns.
5. `agentdock-store-crash-harness`: arguments `<db> <kill-point>`; runs a fixed script that the projector accepts: create task → T02 preparing → T04 running → `operation.recorded{kind: external_write, target: {endpoint: "https://example.invalid/hook", content_sha256: <64 hex>, description}, reconcile_strategy: none}` + host_policy `approval.requested{return_state: running}` + T12 → `approval.resolved{approved, actor user}` + T17 → `operation.started` → effect → `operation.succeeded` → T13 verifying → `check.started{origin: local}`. (`external_write` is the one host-policy kind allowed in `running`, `validate_fixtures.py` `OP_STATES`; do **not** use `git_push`, which is only legal in `pr` after a clean checkpoint, and never loosen the projector to make the script pass.) At the kill point it prints `READY-TO-DIE`, flushes and sleeps until killed. The "external side effect" is simulated by writing a marker file `<db>.effect-<operation_id>`, **only after the `operation.started` commit**.

## 6. Tests to write first

`recovery_fixtures.rs`:

| Test | How | Expected |
| --- | --- | --- |
| `fixture_06_recovery_matches` | replay fixture 06 up to just before `system.recovery_started`, then `recover(now)` | the generated recovery events have the same set of (type, target entity) as the fixture's bracket (order follows the step table; the contract checks sets and end states, not exact order) |
| `fixture_07_pending_approval_invalidated` | same with fixture 07 | approval becomes `invalidated`, **not** still pending (UX F5 step 4 says "Pending approvals are restored as pending", which contradicts the contract; the contract wins; listed in the README) |
| `fixture_13_archived_session_unarchived_by_recovery` | fixture 13 | `session.unarchived{by: system}` written by the recovery actor as the event right after the one that made the session wait |
| `nothing_to_recover_writes_nothing` | fresh database → `recover` | 0 events, empty report |
| `recover_twice_is_idempotent` | `recover`, then `recover` again | second run writes 0 events |
| `crash_inside_recovery_bracket_resumes` | write `system.recovery_started` and part of the steps, drop the store (simulated crash), reopen and `recover` | recovery continues inside the open bracket (no second `system.recovery_started`), finishes the remaining steps and writes one `system.recovery_completed` whose lists cover both runs. The contract does not define this case; this is the packet's choice (README open question) |

Adversarial (projector rules; each maps to a mutation in the ADR-0003 §9 "Crash recovery" row; edit the stream exactly as `_m_<name>` in `validate_fixtures.py` does): `r4_live_event_during_recovery`, `r4_recovery_writes_succeeded`, `r4_recovery_fails_then_repush`, `r4_recovery_passes_check`, `r4_recovery_disconnects_with_other_trigger`, `recovery_starts_op`, `recovery_approves`, `r6_orchestrator_unarchives_during_recovery`, `r6_recovery_leaves_waiting_session_archived`, `r6_unarchive_deferred_until_after_recovery`, `r6_recovery_unarchives_as_user`, `r6_recovery_actor_unarchives_live`, `r4_recovery_actor_outside_window`, `r4_orchestrator_completes_recovery`, `keep_pending_after_crash`, `e1_recovery_keeps_unused_grant`, `e1_recovery_keeps_recorded_op`, `r4_recovery_leaves_check_running`, `r4_recovery_leaves_session_live`, `r4_recovery_leaves_task_in_flight`, `r4_recovery_list_omits_session`, `auto_resume_after_crash`.

`recovery_kill.rs` (one test per kill point; start `agentdock-store-crash-harness` via `env!("CARGO_BIN_EXE_agentdock-store-crash-harness")`, wait for `READY-TO-DIE`, `Child::kill()`, then `Store::open` + `recover` in the parent):

| Kill point | Expected after reopen |
| --- | --- |
| `after_operation_recorded` | operation `abandoned{host_recovery}`; approval `invalidated`; **no** effect marker |
| `after_approval_granted_before_start` | approval `invalidated` (grants do not survive a crash); operation `abandoned`; no marker |
| `after_operation_started_before_effect` | operation `outcome_unknown{host_crash}`; task `interrupted{host_crashed}`; no marker; a second `recover` produces no `operation.started` |
| `after_effect_before_result` | operation `outcome_unknown`; marker present; **no** `operation.succeeded` (recovery never writes results) |
| `during_check_running` (right after the `check.started` commit) | check `outcome_unknown`; task `interrupted{host_crashed}` with `phase: verifying` |

Shared final assertion for every scenario: after recovery, an orchestrator `operation.started` for the same operation is rejected (`rerun_push_after_crash` rule, applied to this operation).

`recovery_property.rs` (`proptest`, 256 cases): generate legal event prefixes with a small generator (1–3 tasks, random legal transitions, record/approve/start operations, start checks, open sessions), truncate anywhere, `recover`, and assert:

1. The bracket contains only allow-listed events.
2. Afterwards there are no pending approvals, unused grants, `recorded`/`started` operations, `running` checks, live sessions, or in-flight tasks.
3. The `recovery_completed` lists (as sets) equal exactly the entities changed inside the bracket.

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-store --features fixture-replay recovery              # all pass
cargo test -p agentdock-store --features fixture-replay --test recovery_kill -- --test-threads=1   # 5 pass
```

Windows-only (CI `rust-windows`): `recovery_kill` must also pass on `windows-latest` (`Child::kill()` is TerminateProcess there). Read failures with `gh run view <run id> --repo ChiJiun/agentdock --log-failed`.

## 8. Spec references and porting sources

All line numbers refer to main `c9e33cf`.

- `docs/contracts/checkpoint-and-replay.md` lines 52–67 "Crash recovery (host restart)".
- ADR-0003 §6 last paragraph (no automatic replay after a crash), §9 "Crash recovery" row (mutations on the left, required crash and property tests on the right), open question 12 (an auto-resume armed before the crash is not disarmed by recovery; this packet leaves it as the contract says).
- `docs/architecture.md` lines 73–76.
- `docs/ux/flows.md` lines 55–61 F5 (UI copy; step 4 conflicts with the contract, see README).
- Behavior references (Node drafts, ideas only, do not port code): PR #25, SHA `7d41c9f1`, `apps/runtime/runtime.test.mjs` line 72 ("SQLite recovers readable history and marks a lost process interrupted (never resumed automatically)"); PR #28, SHA `489ba3df`, `worktrees.test.mjs` line 208 (a failed final commit leaves a durable intent and restart reconciliation does not run Git again) — same idea: intent persisted, effect unknown, never redo.

## 9. Dependencies

`proptest` (dev, 1.12.0, needs audit; reuse if P2-3 added it).

## 10. Model tier

Strong model implements and reviews. Mistakes here mean a repeated push, an unknown result treated as success, or an old approval still valid after a crash.

## 11. Common mistakes and pitfalls

- Writing `operation.failed{effect: none}` in recovery "to allow a retry later": the contract forbids it (mutation `r4_recovery_fails_then_repush`).
- Wrapping all of recovery in one transaction: `checkpoint-and-replay.md` line 54 says one transaction per entity, in list order (the order decides which transient `session_unavailable` states appear). Line 65's "the recovery transaction" is a wording conflict (README); follow line 54.
- Simulating a crash with `std::process::exit`: not realistic (runs part of Rust's cleanup). Kill from the parent with `Child::kill()`.
- Writing the marker before the commit: then the test cannot prove "persist then act".
- UI or adapter writing events during `recover`: the P3-7 bootstrap must finish recovery first; the projector's bracket rule rejects non-recovery events inside the bracket as a second line of defense.

## 12. Reviewer checklist

- [ ] Do the step order and event shapes match checkpoint-and-replay.md lines 52–67?
- [ ] Does an empty recovery write zero events, and is a second recovery a no-op?
- [ ] Are kill tests real process kills, with the marker written strictly after the `operation.started` commit?
- [ ] Does recovery ever write `succeeded`, `failed{effect:none}`, `operation.started`, an approval, or a check pass? (It must not.)
- [ ] Is `auto_resume_armed` always false for host crashes?
