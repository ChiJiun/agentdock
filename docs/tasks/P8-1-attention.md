# P8-1: Attention items (needs reply / needs review / background), derived from the event log

> **繁中摘要**：依 `docs/contracts/attention.md` 實作「需要你回覆／新的結果待檢視／背景執行中」三類待辦。它是事件的純函式、不儲存：`agentdock-core` 放純函式，`agentdock-store` 的 projection 補上需要的欄位（`entered_seq`、`ack_seq`、`last_stop`、`outcome`、`closed_seq`），再加一個 Tauri command。以 13 個契約 fixture 的 `expected.json` 做一致性測試，Python 參考實作是 `validate_fixtures.py` 的 `Replay.attention`。注意：PR #29 的 attention 測試把「turn 結束」當成待檢視，但契約定為「需要回覆」，以契約為準。模型等級：一般模型可（有參考實作與 fixture）。

Issues: #7, #36 (sentinel), #15 | Gate (#51): G3 (real state after restart), G8 (no lost work) | Model tier: **standard model**

Two PRs:

- **P8-1a**: pure function in `agentdock-core` + unit tests.
- **P8-1b**: projection columns in `agentdock-store`, `Store::attention_input`, fixture conformance, Tauri command `attention_list`.

## 1. Goal and non-goals

Goals:

- `derive_attention(input) -> Vec<AttentionItem>`: a pure, deterministic function implementing every rule in `docs/contracts/attention.md` ("Rules", archived filtering, "Clearing"), including the documented divergences from the UX spec.
- Output sorted for the inbox: `needs_reply` first, then `needs_review`, then `background` (UX `states-and-indicators.md` §4 "three sections in fixed order"); inside a kind by the referenced entity's last event seq, newest first; ties by `(task_id, session_id, ref_id)`.
- `InboxCounts { needs_reply, needs_review, background }` and the badge count rule (count = reply + review; background never counts; display `99+` is the UI's job).
- Projection support so the input can be built from SQLite after a restart, giving the same list as before the restart.

Non-goals: UI (P8-2); the "session on screen" rule 3 (UI only, never stored); bulk "Mark completed as reviewed" (blocked: the contract has no revoke event yet, attention.md Divergence 3); notifications; remote sessions (UX rule 1a).

## 2. Prerequisites and parallel work

- P8-1a: P2-1, P2-2 (enums `TaskState`, `SessionState`, `SessionRole`, `StopReason`, `AttentionKind`, `AttentionReason`).
- P8-1b: P8-1a, P2-5 (projector and rows), P2-6 (recovery events change attention), P3-7 (`AppState`, for the command).
- Parallel: P6-*, P7-*. Used by P8-2 and P8-3.

## 3. Files

P8-1a new: `crates/agentdock-core/src/attention.rs`. Modified: `crates/agentdock-core/src/lib.rs`.

P8-1b new:

- `crates/agentdock-store/migrations/000N_attention_columns.sql` (next free number)
- `crates/agentdock-store/src/attention_input.rs`
- `crates/agentdock-store/tests/attention_fixtures.rs`
- `src-tauri/src/commands/attention.rs`

P8-1b modified: `crates/agentdock-store/src/projector/*.rs` (maintain the new columns), `crates/agentdock-store/src/lib.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/default.json`.

## 4. Public types and signatures

```rust
// crates/agentdock-core/src/attention.rs
use crate::{ids::*, payload::*};

pub const LIVE_SESSION: &[SessionState] = &[Starting, Idle, Active, AwaitingPermission, Suspended];
pub const IN_FLIGHT_TASK: &[TaskState] = &[Preparing, Running, AwaitingApproval, Verifying, Review, Pr, Ci];
pub const REPLY_ROLES: &[SessionRole] = &[Primary, Implementation, Repair];
pub const ATTENTION_STOPS: &[StopReason] = &[Refusal, MaxTokens, MaxTurnRequests];

/// `LastStop::OutputLimited` = the turn ended with stop reason `cancelled` and that turn was the one named by
/// `session.output_limited{action: turn_cancelled}` (validate_fixtures.py lines 718–720).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LastStop { Reason(StopReason), OutputLimited }

#[derive(Debug, Clone)]
pub struct TaskFact {
    pub id: TaskId, pub state: TaskState, pub interruption: Option<Interruption>,
    pub entered_seq: u64,      // seq of the event that put the task in its current state
    pub ack_seq: u64,          // seq of the latest task.outcome_acknowledged (0 = never)
    pub last_seq: u64,
}
#[derive(Debug, Clone)]
pub struct SessionFact {
    pub id: SessionId, pub task_id: TaskId, pub state: SessionState, pub role: SessionRole,
    pub parent: Option<SessionId>, pub archived: bool,
    pub last_stop: Option<LastStop>,      // None after the session goes active/awaiting_permission
    pub outcome: Option<SessionOutcome>, pub closed_seq: u64, pub ack_seq: u64, pub last_seq: u64,
}
#[derive(Debug, Clone)] pub struct ApprovalFact { pub id: ApprovalId, pub task_id: TaskId, pub session_id: Option<SessionId>, pub pending: bool, pub seq: u64 }
#[derive(Debug, Clone)] pub struct OperationFact { pub id: OperationId, pub task_id: TaskId, pub state: OperationState, pub seq: u64 }
#[derive(Debug, Clone)] pub struct CheckFact { pub task_id: TaskId, pub running: bool }

#[derive(Debug, Clone, Default)]
pub struct AttentionInput {
    pub tasks: Vec<TaskFact>, pub sessions: Vec<SessionFact>, pub approvals: Vec<ApprovalFact>,
    pub operations: Vec<OperationFact>, pub checks: Vec<CheckFact>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct AttentionItem {
    pub kind: AttentionKind, pub reason: AttentionReason, pub task_id: TaskId,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub session_id: Option<SessionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub ref_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
pub struct InboxCounts { pub needs_reply: u32, pub needs_review: u32, pub background: u32 }
impl InboxCounts { pub fn badge(&self) -> u32 { self.needs_reply + self.needs_review } }

/// `filter_archived = true` for the UI; the conformance test uses true as well (expected.json is filtered).
pub fn derive_attention(input: &AttentionInput, filter_archived: bool) -> Vec<AttentionItem>;
pub fn counts(items: &[AttentionItem]) -> InboxCounts;
```

```rust
// crates/agentdock-store/src/attention_input.rs
impl Store { pub fn attention_input(&self) -> Result<agentdock_core::attention::AttentionInput>; }

// src-tauri/src/commands/attention.rs
#[derive(serde::Serialize)]
pub struct AttentionView { pub items: Vec<AttentionItem>, pub counts: InboxCounts, pub head_seq: u64 }
#[tauri::command] pub async fn attention_list(state: tauri::State<'_, AppState>) -> Result<AttentionView, IpcError>;
```

## 5. Implementation steps

### P8-1a

1. Port `Replay.attention` (`docs/contracts/validate_fixtures.py` lines 1240–1306) rule by rule, using the constant sets of lines 232–259. Keep the same order of checks; the Python is the reference for edge cases not spelled out in attention.md. Where attention.md and the Python disagree, stop and report (do not pick one).
2. Collect into a `HashSet` (duplicates collapse, as in Python), then sort as described in §1.
3. Archived filter: drop non-`needs_reply` items that name an archived session, or task-level items when the task has at least one main (parent-less) session and all of them are archived. `needs_reply` is never dropped.

### P8-1b

1. Migration adds columns: `tasks.entered_seq`, `tasks.ack_seq`, `sessions.last_stop` (text: stop reason or `output_limited`), `sessions.limited_turn_id`, `sessions.outcome`, `sessions.closed_seq`, `sessions.ack_seq`. Existing rows: fill by replaying events (the projector already supports rebuilding from events, P2-5/P2-6 step 1).
2. Projector updates (mirror validate_fixtures.py): `task.state_changed` → `entered_seq = seq`; `task.outcome_acknowledged` → `ack_seq = seq`; `session.output_limited{action: turn_cancelled}` → `limited_turn_id`; `session.state_changed` with trigger `turn_ended` → `last_stop` per lines 718–720; to `active`/`awaiting_permission` → `last_stop = NULL`; to `closed`/`failed` → `outcome`, `closed_seq`; `session.result_acknowledged` → `ack_seq`.
3. `attention_input`: one read transaction over all projection tables (so the snapshot is consistent).
4. `attention_list`: `ready()?` → `attention_input` → `derive_attention(.., true)` → `counts`; `head_seq` lets P8-2 know whether to refresh.

## 6. Tests to write first

`crates/agentdock-core/src/attention.rs` unit tests (build `AttentionInput` by hand):

| Test | Expected |
| --- | --- |
| `queued_and_preparing_are_background` | `queued` → `background/queued`; `preparing` → `background/workflow_step` |
| `phase_waiting_without_progress_needs_reply` | task `review`, no live session, no running check, no started op, no pending approval → `needs_reply/phase_decision_pending` |
| `phase_with_running_check_is_background` | task `verifying` with a running check → `background/workflow_step` only |
| `phase_with_pending_approval_has_no_phase_item` | task `review`, no progress, one pending approval of the task (approvals requested in `verifying`/`review` do not move the task, state-machines.md line 24) → only `needs_reply/approval_pending` |
| `running_without_live_reply_session` | task `running`, only a `review` role session live → `needs_reply/session_unavailable` |
| `end_turn_primary_needs_reply` | `running`, primary `idle` with `end_turn` → `needs_reply/agent_turn_ended` (contract, not PR #29's "to review") |
| `user_cancelled_turn_is_background` | primary `idle` with `cancelled` → `background/workflow_step`, no session item |
| `output_limited_needs_reply` | `last_stop = OutputLimited`, task in flight → `needs_reply/output_limited` |
| `refusal_in_review_child_needs_reply` | child `review` session `idle` with `refusal`, task `review` → `needs_reply/agent_turn_ended` |
| `interrupted_variants` | `user_paused` → `background/paused`; armed → `background/waiting_for_reset`; unarmed unviewed → `needs_review/interruption_needs_decision`; unarmed viewed (`ack_seq >= entered_seq`) → nothing |
| `terminal_unviewed_and_viewed` | `failed` unviewed → `failure_needs_decision`; `completed` unviewed → `task_outcome_unviewed`; viewed → nothing |
| `ack_before_reentering_does_not_count` | `completed` with `ack_seq < entered_seq` (acknowledged an earlier outcome) → listed |
| `outcome_unknown_after_task_ended` | task `completed`, viewed, one op `outcome_unknown` → `needs_reply/reconcile_needed` with `ref_id` = op id |
| `child_result_unviewed` | child `closed` with `succeeded`, `ack_seq <= closed_seq` → `needs_review/child_result_unviewed` |
| `archived_hides_review_and_background_not_reply` | archived session with `agent_working` and a pending approval → only `approval_pending` remains |
| `task_items_hidden_only_when_all_main_sessions_archived` | two main sessions, one archived → task item stays; both → hidden |
| `sort_order` | mixed items → all `needs_reply`, then `needs_review`, then `background`; newest first inside a kind |
| `badge_excludes_background` | 1 reply, 2 review, 5 background → `badge() == 3` |
| `deterministic_under_input_order` | proptest: shuffling every input vector gives an identical output |

`crates/agentdock-store/tests/attention_fixtures.rs`:

| Test | Expected |
| --- | --- |
| `all_13_fixtures_match_expected_attention` | for each `docs/contracts/fixtures/NN-*.jsonl`: replay with `replay_fixture_event` (P2-5) → `derive_attention(attention_input(), true)` as a set equals `expected.json["attention"]` (compare `(kind, reason, task_id, session_id, ref_id)`) |
| `same_items_after_reopen` | after each fixture, drop and reopen the store → identical list |
| `migration_backfills_columns` | open a database created with the previous migration set and containing fixture 04 events → columns filled and attention equals expected |
| `adapter_bookkeeping_does_not_resurrect_viewed_turn` | port of PR #29 attention.test line 66: after `session.result_acknowledged`, a `session.cancel_requested`-style bookkeeping event (any event that is not a state change) → item stays cleared |

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-core attention::                          # 19 pass (including the proptest)
cargo test -p agentdock-store --test attention_fixtures           # 4 pass
python3 docs/contracts/validate_fixtures.py                        # still exits 0 (fixtures untouched)
```

No Windows-only items.

## 8. Spec references and porting sources

- `docs/contracts/attention.md` (whole file; rules, archived filter, clearing, divergences 1–6).
- `docs/contracts/validate_fixtures.py` lines 232–259 (constant sets), 718–724 (`last_stop`, `outcome`, `closed_seq`), 1240–1306 (`Replay.attention`, the reference implementation), 1387–1390 (comparison with `expected.json`).
- `docs/contracts/schema/agentdock.schema.json` line 672 (`AttentionItem`).
- `docs/ux/states-and-indicators.md` §4 lines 58–110 (classification order, badge semantics, inbox section order).
- Porting sources (scenarios only): PR #27, branch `feat/live-session-sentinel`, SHA `6dd3ac82f0c006c99643f6d5fa582d53b2350a7d` (`docs/implementation/live-session-sentinel.md`); PR #29, branch `feat/durable-task-workflow`, SHA `c57b824ddcdc2355fbc10bded265db4b99cf9e80`, `apps/runtime/attention.test.mjs` lines 66 (bookkeeping does not resurrect a viewed item), 87 (pending permission cannot be hidden by "mark reviewed"), 114 (second pending approval stays visible), 139 (reply, then review, then background), 154 (viewed state survives restart). **Deviation**: PR #29 line 22 treats a finished turn as "to review"; the contract classifies `end_turn` of a reply role as `needs_reply/agent_turn_ended`. The contract wins.

## 9. Dependencies

`proptest` (1.x, MIT OR Apache-2.0) as a dev-dependency of `agentdock-core`; already introduced by P2-3, otherwise **needs audit**.

## 10. Model tier

Standard model. The reference implementation and 13 fixtures pin the behaviour.

## 11. Common mistakes and pitfalls

- Storing attention items in a table: they must be derived, or the inbox drifts from the facts after a crash.
- Using wall-clock time for "viewed": compare event seqs (`ack_seq` vs `entered_seq` / `closed_seq`).
- Hiding a pending approval because its session is archived: `needs_reply` is never hidden.
- Treating `idle` + `cancelled` as "needs reply": a user-cancelled turn is background while the task runs; only an output-limit cancel needs a reply.
- Building the input from several read transactions: a concurrent write can produce a list that never existed.
- Implementing the bulk "Mark completed as reviewed": blocked until a revoke event exists.

## 12. Reviewer checklist

- [ ] Rule by rule, does `derive_attention` match `Replay.attention` lines 1240–1306 (including the order of the `running` branch)?
- [ ] Is the archived filter exactly "non-reply items of archived sessions, task items only when all main sessions are archived"?
- [ ] Does the fixture test compare sets against all 13 `expected.json` files, not a subset?
- [ ] Do the new projection columns get backfilled for existing databases?
- [ ] Is `attention_input` a single read transaction?
- [ ] Is anything stored that should be derived?
