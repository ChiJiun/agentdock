# P4-3: Approval engine (ACP permissions, host-policy operations, `execute_guarded`, adversarial tests)

> **繁中摘要**：分兩個 PR。**P4-3a**：實作 P3-5 的 `PermissionHandler`——ACP permission → P4-2 分類 → policy 決定 → 寫 approval／S10／T12 → 等使用者 → **先持久化 `approval.resolved` 再回覆 agent**；使用者決定 API 只接受仍 pending、未過期、同一 task、指紋相符的決定，actor 固定 `user`；policy 規則檔在 app data（不讀 repo），user-only 類別永遠不自動核准，`git_push` 只能由使用者自建規則自動核准。**P4-3b**：`execute_guarded`——AgentDock 自己的不可重複操作一律「記錄意圖 → host-policy 核准 → started → 執行 → 結果」，effect 只在 started commit 之後執行。附偽造、過期、重放、跨 task、policy 核准 merge、取消、重啟等對抗測試。**§5A 是整個 alpha「回合取消／host 關閉 session／agent 意外結束／protocol error／排隊中的 permission／被中止的 operation」的唯一狀態表**（每個情境由哪一包、以什麼 actor、依什麼順序寫哪些事件，以及 session `outcome`）；P3-4、P3-5、P8-3 只引用它，不再各自定義。`outcome_unknown{killed}` 只由 `execute_guarded` 寫。模型等級：強模型實作＋強模型審查。

Issues: #8, #10 | Gate (#51): G5 (confirmation before PR), G7 (denied operations never run), G8 (no leftover approvals after interruption/restart) | Model tier: **strong model implements and reviews**

Two PRs: **P4-3a** (policy rules, ACP permission handler, user decision API) and **P4-3b** (`execute_guarded` for host-policy operations). They share the §4 types.

## 1. Goal and non-goals

Goals:

- Implement P3-5's `PermissionHandler`: ACP `session/request_permission` → P4-2 classification → policy decision → approval and state events → wait for the user → **persist first, then answer the agent**.
- `execute_guarded`: every non-repeatable operation AgentDock itself performs (`git_push`, `pr_create`, `pr_update`, `pr_comment`, `pr_merge`, `branch_delete`, `worktree_remove`, `destructive_command`, `external_write`) goes through "record intent → host-policy approval → started → effect → result" (`checkpoint-and-replay.md` Rules 1–4, 9–11).
- User decision API: accepts only decisions for approvals that are still pending, unexpired, of the same task, with a matching fingerprint; the actor is always `user`.
- Policy rule file (user-level, app data directory): may auto-approve only non-user-only classes; any class may be denied by policy. `git_push` can be auto-approved only by a rule the user created (current proposal for ADR-0003 open question 7).
- Adversarial tests: forged, expired, replayed, cross-task, policy approving merge, cancel, restart.
- **§5A is the single state table** for turn cancel, host shutdown, agent exit, protocol error, queued permissions and killed operations. P3-4, P3-5 and P8-3 implement their rows and define no ordering of their own.

Non-goals: approval UI (P4-4), real Git/GitHub execution (P5, P7 call `execute_guarded`), executing `terminal/*` / `fs/*` (alpha does not advertise them), detecting agents' native bypass modes (#26).

## 2. Prerequisites and parallel work

- P4-3a prerequisites: P4-2, P3-5b, P2-5 (approval/operation projections and rules), P2-6 (recovery invalidates pending approvals), P3-7 (Tauri commands get the store and services from `AppState::ready()`; add `ApprovalService` to `Ready`).
- P4-3b prerequisites: P4-3a.
- Parallel: P5-*, P6-1. P4-4, P7-2, P8-3, P8-4 use this packet (P5-2 does not: worktree creation is not a guarded operation).

## 3. Files

New:

- `crates/agentdock-policy/src/rules.rs` (policy rule file and pure decision)
- `crates/agentdock-orchestrator/src/approvals.rs` (`ApprovalService`: ACP handler, user decisions, expiry)
- `crates/agentdock-orchestrator/src/guarded.rs` (`execute_guarded`, P4-3b)
- `crates/agentdock-orchestrator/tests/approvals_adversarial.rs`
- `crates/agentdock-orchestrator/tests/guarded_operations.rs` (P4-3b)
- `src-tauri/src/commands/approvals.rs` (`approval_resolve`, `approvals_pending`)

Modified: `crates/agentdock-policy/src/lib.rs`, `crates/agentdock-orchestrator/src/lib.rs`, `src-tauri/src/state.rs` and `bootstrap.rs` (add `approvals: Arc<ApprovalService>` to `Ready`, start the expiry loop), `src-tauri/build.rs` (AppManifest), `src-tauri/capabilities/default.json`.

## 4. Public types and signatures

```rust
// ===== crates/agentdock-policy/src/rules.rs =====
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PolicyRule {
    pub id: String,                       // ^[a-z0-9_.-]{1,64}$ ; "builtin." prefix reserved
    pub class: crate::classify::PolicyClass,
    pub decision: RuleDecision,
    /// Set by the settings UI. NOTE: in alpha the file is hand-written in app data, so this flag is self-declared and
    /// only records intent; the real protection is that the file lives outside every repo/worktree (agents cannot edit it).
    #[serde(default)] pub created_by_user: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleDecision { Allow, Deny }
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PolicyFile { pub version: u32, pub rules: Vec<PolicyRule> } // version 1; <= 64 rules

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyDecision { Approve { rule_id: String }, Deny { rule_id: String }, AskUser }

/// Pure. Order: built-in denies (path scope Deny) → user Deny rules → user Allow rules (never for user_only
/// classes; GitPush only if created_by_user) → AskUser. Invalid file content was already rejected at load.
pub fn decide(class: crate::classify::PolicyClass, paths_denied: bool, file: &PolicyFile) -> PolicyDecision;
pub fn load_policy_file(path: &std::path::Path) -> Result<PolicyFile, PolicyFileError>; // missing → empty rules

// ===== crates/agentdock-orchestrator/src/approvals.rs =====
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserDecision { Approve, Deny }

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ApprovalError {
    #[error("approval not found")] NotFound,
    #[error("approval is not pending")] NotPending,       // replay / already resolved / invalidated by recovery
    #[error("approval expired")] Expired,
    #[error("approval belongs to another task")] WrongTask,
    #[error("approval content changed; reload")] FingerprintMismatch,
    #[error("store rejected the event: {0}")] Rejected(String),
}

pub trait Clock: Send + Sync { fn now(&self) -> Timestamp; } // tests use a manual clock

pub struct ApprovalService { /* Arc<Store>, policy file path, Clock, live ACP tickets: HashMap<ApprovalId, (Arc<AcpConnection>, PermissionTicket, Vec<PermissionOptionView>)>,
   in-flight started operations (P4-3b): HashMap<OperationId, InFlight { task_id, kind, abort: AbortHandle, settled: Arc<AtomicBool>, done: watch::Receiver<bool> }> */ }

impl ApprovalService {
    pub fn new(store: Arc<Store>, policy_path: PathBuf, clock: Arc<dyn Clock>, acp_ttl: Duration) -> Self;
    /// Called from the Tauri command. `shown_fingerprint` is the operation_fingerprint the UI displayed.
    pub async fn resolve_by_user(&self, task_id: &TaskId, approval_id: &ApprovalId,
        decision: UserDecision, shown_fingerprint: &Sha256Hex) -> Result<(), ApprovalError>;
    /// Background loop: every 1 s, expire pending approvals whose expires_at <= now (approval.resolved{expired}, actor policy).
    pub async fn run_expiry_loop(self: Arc<Self>);
    /// User cancelled the current turn (called through PermissionHandler::on_turn_cancel BEFORE SessionRuntime::cancel
    /// sends session/cancel, P3-5). §5A row C2: if the session has a pending approval, persist
    /// `approval.resolved{cancelled}` (+ T-back when blocking) in one transaction, then answer the ticket `cancelled`.
    /// The facade (P3-4) answers the session's waiting requests `cancelled` and promotes none; this service keeps no
    /// queue. No pending approval → Ok(()) and nothing written.
    pub async fn cancel_for_session(&self, session_id: &SessionId) -> Result<(), ApprovalError>;
    /// Phase-exit step 2 (§5A row H0; P8-3 calls it after abort_started_operations_for_task and before the task transition): every pending approval of the task →
    /// cancelled (actor user) and the agent answered `cancelled` (facade drops the queue); host-policy operations of
    /// those approvals → abandoned, approved-but-unused host-policy grants → invalidated (actor orchestrator).
    /// Writes NO task transition and NO session event; the caller writes T21 / T20 / other phase exit next.
    pub async fn cancel_open_for_task(&self, task_id: &TaskId) -> Result<Vec<ApprovalId>, ApprovalError>;
}
impl agentdock_orchestrator::session_runtime::PermissionHandler for ApprovalService {
    /* on_permission(ctx), on_turn_cancel(session_id) = cancel_for_session,
       on_session_closed(session_id, agentdock_acp::CloseReason) — P3-5 trait; see §5 step 6 and §5A rows C3, C4, A2, A4, H3.
       Called for EVERY close of a session that is awaiting_permission, whether or not an approval is still pending,
       and with CloseReason::ShutDown on the shutdown-timeout path. It writes S16 / S23 and the approval events. */
}

// ===== crates/agentdock-orchestrator/src/guarded.rs (P4-3b) =====
pub struct OperationRequest {
    pub task_id: TaskId,
    pub kind: OperationKind,                   // P2-1 enum
    pub target: serde_json::Value,             // identity fields per kind + description (checkpoint-and-replay.md table)
    pub reconcile_strategy: ReconcileStrategy, // P2-1 enum
    /// Some(running|pr|ci) = blocking (task is in that state; T12/T33/T40 then T17/T18/T19).
    /// None = non-blocking (task in verifying/review, or cleanup in completed/cancelled/failed): no task transition.
    /// Any other task state → GuardError::Rejected before anything is written (checkpoint-and-replay.md line 96).
    pub return_state: Option<ApprovalReturnState>,
    pub supersedes_operation_id: Option<OperationId>,
}
pub enum EffectOutcome {
    Succeeded { result: serde_json::Value },
    /// Only when the executor KNOWS the remote state: `effect: None` means "rejected before any remote effect"
    /// (Rule 5, checkpoint-and-replay.md line 104). Never use Failed for a killed / timed-out / unanswered effect.
    Failed { effect: FailureEffect, error: String },
    /// Killed, timed out, or no answer: written as operation.outcome_unknown{cause: killed}; reconcile later.
    Unknown { error: String },
}
#[derive(Debug, thiserror::Error)]
pub enum GuardError {
    #[error("approval denied")] Denied, #[error("approval expired")] Expired, #[error("approval cancelled")] Cancelled,
    #[error("store rejected: {0}")] Rejected(String), #[error("effect outcome unknown")] OutcomeUnknown,
    #[error("operation failed: {0}")] Failed(String),
    #[error("a started pr_merge cannot be aborted")] Uninterruptible,
}
impl ApprovalService {
    /// 1 tx: operation.recorded (orchestrator) + approval.requested(host_policy, same id/kind/fingerprint,
    ///      return_state when blocking; actor policy) + if blocking T12/T33/T40 (actor policy, return_state).
    /// Then the resolution follows the §5 step 4 table (host_policy rows); denied/expired/cancelled → Err.
    /// Then 1 tx: operation.started (actor orchestrator; projector checks rules 3, 9, 10). Only after commit: run `effect`.
    /// Then 1 tx: operation.succeeded / operation.failed (actor integration) or operation.outcome_unknown{killed}
    /// (actor **orchestrator** — validate_fixtures.py lines 1030–1033, checkpoint-and-replay.md line 107). This call
    /// is the ONLY writer of outcome_unknown{killed}: normal Unknown/panic, abort by abort_started_operations_for_task,
    /// and the Drop guard all end here, once per operation (§5 P4-3b step 5).
    pub async fn execute_guarded<F, Fut>(&self, req: OperationRequest, effect: F) -> Result<serde_json::Value, GuardError>
    where F: FnOnce() -> Fut + Send + 'static, Fut: std::future::Future<Output = EffectOutcome> + Send + 'static;
    /// Phase-exit step 1 (§5A rows H0, O1; P8-3 calls it first, before `cancel_open_for_task` and the task transition).
    /// For every operation of the task that `execute_guarded` has `started` and not finished: if one is a `pr_merge` →
    /// `Err(Uninterruptible)` and nothing is aborted or written; otherwise abort each effect (its process dies:
    /// `kill_on_drop`), and wait (at most 15 s, else `Err(Rejected)`) until the owning `execute_guarded` has committed
    /// its single `operation.outcome_unknown{cause: killed}` (actor orchestrator). Returns the operation ids.
    /// **This function writes no event itself**: `execute_guarded` is the only writer of `outcome_unknown{killed}`.
    pub async fn abort_started_operations_for_task(&self, task_id: &TaskId) -> Result<Vec<OperationId>, GuardError>;
}
```

## 5. Implementation steps

### P4-3a

1. Write the §6 tests.
2. `rules.rs`: `decide` follows the order in the §4 comment; `load_policy_file` validates version, rule count, id format, unique ids, reserved `builtin.` prefix. File location: `<app data>/policy.json`; **never read any policy file from a repo**. This is deliberately stricter than ADR-0002 APR-9 (which allows project-level rules that only add restrictions): alpha reads no project-level rules at all.
3. `on_permission(ctx)`:
   1. From projections, get the session's state, its task and the task's state, and the session cwd's `ScopedPath`.
   2. **Session guard** (§5A row C5): the session must be `active`. In any other state (`awaiting_permission` after a cancelled turn, `idle`, `suspended`, ...) write nothing, answer the ticket `cancelled` (`respond_permission(ticket, Cancelled)`; the facade also drops its queue) and log a `tracing` warning. S10 is legal only from `active`.
   3. `classify_permission(ctx.tool_call, scope, base)`; `paths_denied` = any path `Deny`.
   4. Blocking or not, by task state (`checkpoint-and-replay.md` line 96):
      - `running` → **blocking**: `return_state: running`.
      - `verifying` / `review` → **non-blocking**: no `return_state`, no task transition (e.g. the reviewer session).
      - any other state (including `awaiting_approval`) → write nothing, answer the agent `cancelled`, log a `tracing` warning (the contract forbids approvals there; T33/T40 allow only actor `policy`, so ACP requests cannot block `pr`/`ci`).
   5. New `approval_id`; one transaction writes (fixture 01 events 12–14 / fixture 03 events 10–12): `approval.requested{source: acp_permission, operation_kind: "tool_call", classified_kind, operation_fingerprint, title (redacted + bounded), scope: once, acp: {tool_call_id, options}, expires_at: now + acp_ttl, return_state (blocking only)}` (actor `adapter`) → `S10 active → awaiting_permission (permission_requested, approval_id)` (actor `adapter`) → if blocking, `T12 running → awaiting_approval (approval_requested, approval_id, return_state: running)` (actor `adapter`).
   6. Remember `(approval_id → connection, ticket, options)`.
   7. `decide(...)`: `Approve` → resolve per step 4 (actor `policy`, `policy_rule_id`); `Deny` → same with `denied`; `AskUser` → nothing; wait for the user or expiry.
   - **No queue here.** The only permission queue is the per-session FIFO of P3-4: it forwards one request per session at a time and promotes the next only after a `Selected` answer (a `Cancelled` answer drops the queue, §5A row C2). Alpha has one session per task that can raise a blocking permission, so a second blocking approval of one task cannot come from ACP; `execute_guarded` refuses a blocking request while the task already has a pending blocking approval (P4-3b step 2) instead of queueing it.
4. Resolution table for decisions (approved, denied, expired, host-policy). Cancel, shutdown, agent exit and protocol error are **not** in this table: they are §5A. Every row is **one transaction** in the listed order; the agent is answered **only after commit** (`acp-capabilities.md` line 94); if answering fails (connection gone), do not change the store; log a `tracing` warning. "T-back" = T17/T18/T19 chosen by `return_state` (blocking only; non-blocking rows simply omit task events). Actors are fixed by `validate_fixtures.py` lines 903–931 and transitions.json.

   | Case | Events (actor) | Answer to agent |
   | --- | --- | --- |
   | ACP approved / denied by user or policy | `approval.resolved{approved\|denied, acp_outcome}` (user\|policy) → `S14` (same actor) → T-back (same actor) | selected option |
   | ACP expired | `approval.resolved{expired, acp_outcome}` (**policy**) → `S14` (policy) → T-back (policy) | reject option |
   | ACP: turn cancel, task cancel or pause, agent exit, protocol error | **§5A rows C2–C4, H0, A2, A4** (single definition; not repeated here) | per §5A |
   | host_policy approved by user or policy | `approval.resolved{approved, policy_rule_id?}` (user\|policy) → T-back (same actor). **Never S14** (no session) | — |
   | host_policy denied (user\|policy) / expired (**policy**) | `approval.resolved{denied\|expired}` → `operation.abandoned{approval_denied\|approval_expired}` (orchestrator) → T-back (same actor as the resolution) — fixture 11 events 21–23 and 65–67 | — |
   | host_policy, task cancel / pause (`cancel_open_for_task`) | `approval.resolved{cancelled}` (user) → `operation.abandoned{approval_cancelled}` (orchestrator); the caller (P8-3) then writes T21 / T20 (§5A row O2) | — |
   | host_policy grant approved but not yet started, task leaves the phase | `approval.resolved{invalidated}` (orchestrator) → `operation.abandoned{reason: approval_invalidated}` (orchestrator) | — |

   Option choice for `acp_outcome`: `approved` → first `allow_once`; if only `allow_always` exists use it but record `scope: once` (`acp-capabilities.md` line 102); no allow-type option → treat as `denied`. `denied` / `expired` → first `reject_once`, else `reject_always`; if the agent offered no reject option, write the decision as `cancelled` with `acp_outcome: cancelled` instead (the validator requires `expired`/`denied` to select a `reject_*` option). Restart (pending at crash) is handled by P2-6 recovery, not here.
5. `resolve_by_user`: check order `NotFound` → `WrongTask` (approval's task ≠ parameter) → `NotPending` → `Expired` (`now >= expires_at`) → `FingerprintMismatch` → resolve per the table (actor user). The projector also rejects illegal events (second line of defense); map store errors to `Rejected`.
6. `on_session_closed(session_id, reason)`: P3-5 calls it for **every** close of a session that was `awaiting_permission`, whether or not an approval is still pending, and with `CloseReason::ShutDown` on the shutdown-timeout path (§5A row H3). It re-reads the session state and the session's approvals inside its transaction and applies rows C3, C4, A2, A4 or H3 of §5A, which differ only by "approval pending or already resolved" and by the reason: `S16` for `ProcessExited` and `ShutDown`, `S23` for `ProtocolError` / `LineTooLong`; the approval event before or after it exactly as the row says; T20 only when a blocking approval was pending. If the session turns out not to be `awaiting_permission` any more (the user's `S14` committed first), it writes nothing and returns; P3-5 then re-reads and writes S12 / S13 (§5A ownership rule 7). When the session was not awaiting permission, P3-5 writes S08/S12/S13/S22 itself and P8-3 handles the task.
7. `cancel_open_for_task`: applies the "task cancel / pause" and "grant not yet started" rows of the step 4 table for every open approval of the task, answers each live ACP ticket `cancelled` through the facade, and returns the ids. It writes no task transition (P8-3 does, §5A row H0) and no session event. Its effect on `approval_not_pending_after` and `no_open_operations` is what lets T21 / T20 commit next.
8. Tauri commands: `approvals_pending(task_id) -> Vec<ApprovalView>` (`approval_id`, `classified_kind`, `title`, `operation_fingerprint`, `expires_at`, `user_only`, `policy_hint`) and `approval_resolve(task_id, approval_id, decision, fingerprint)`. The frontend sends only ids, the decision and the fingerprint it showed; the backend fixes the actor to `user`.

### P4-3b

1. Write the §6 P4-3b tests.
2. `execute_guarded` follows the §4 comment. `idempotency_key` = P2-1 `idempotency_key(kind, target)`; `operation_fingerprint` = the same value (Rule 2). A blocking request (`return_state: Some(..)`) while the task already has a pending blocking approval is `GuardError::Rejected("task has a pending blocking approval")` before anything is written: it is rejected, never queued (the only queue is P3-4's).
3. User-only kinds (`pr_merge`, `branch_delete`, `worktree_remove`, `destructive_command`): `decide` always returns `AskUser` or `Deny`, even if the file says `Allow` (covered by `decide` unit tests).
4. Before `git_push`, the caller (P7-2) must write a checkpoint; this function does not, but if the projector rejects `operation.started` under Rule 9, return `Rejected` and write `operation.abandoned`.
5. Run the effect with `tokio::spawn`; right after the `operation.started` commit put `{task_id, kind, AbortHandle, settled, done}` into the in-flight registry (§4 struct comment) and await the `JoinHandle`. **Exactly one writer per operation**: `settled` is a per-operation `AtomicBool`; the first path that flips it writes the terminal event and then sets `done`; every other path sees it set and writes nothing. Paths: `EffectOutcome::Succeeded` → `operation.succeeded` and `Failed` → `operation.failed` (actor integration); `EffectOutcome::Unknown`, a panic, or the `JoinHandle` reporting cancellation because `abort_started_operations_for_task` aborted it → `operation.outcome_unknown{cause: killed}` (actor **orchestrator**) and `Err(OutcomeUnknown)`; caller cancellation (the `execute_guarded` future is dropped) → a `Drop` guard first calls `AbortHandle::abort()` (effects that spawn processes must use `kill_on_drop(true)` so aborting kills them), then, only if `settled` was not yet flipped, writes the same `outcome_unknown{killed}` via a background `spawn_blocking` (Drop cannot await). P8-3 never writes `outcome_unknown{killed}`; it calls `abort_started_operations_for_task` (§5A row O1). Never write `outcome_unknown{killed}` for `pr_merge` (mutation `b5_kill_started_merge`; merge is not executed in alpha): `abort_started_operations_for_task` refuses with `Uninterruptible` first.
6. `OperationKind → PolicyClass` for `decide` (from `checkpoint-and-replay.md` line 96, inverted): `git_push` → `GitPush`; `pr_create` / `pr_update` / `pr_comment` → `PrWrite`; `pr_merge` → `PrMerge`; `branch_delete` → `BranchDelete`; `worktree_remove` → `WorktreeRemove`; `destructive_command` → `DestructiveCommand`; `external_write` → `ExternalWrite`. Put it in one `match` with no wildcard arm.

## 5A. Cancel, shutdown and close: the single state table

This section is the **only** definition of what is written when a turn is cancelled, the host closes a session, an agent exits or breaks the protocol, a permission request is queued or arrives late, or a started operation is aborted. P3-4, P3-5 and P8-3 implement their rows and define no events, order or actors of their own; where their text differs, this table wins and that text is a bug. Every event below is legal under `docs/contracts/transitions.json` (ADR-0003); transition ids (S.., T..) are the ids in that file.

**Writers.** `A` = `ApprovalService` (this packet). `G` = `execute_guarded` (P4-3b). `S` = `SessionRuntime` (P3-5). `K` = the `AcpConnection` facade (P3-4); it writes nothing to the store and only answers the agent. `T` = `TaskService` (P8-3).

**Ownership rules.**

1. Session state events are written by `S`, **except** `S10` and `S14` (`A`) and every transition out of `awaiting_permission` other than `S15`: `S16` and `S23` are `A`'s, written inside `on_session_closed` (§5 step 6). A close of a session that is `awaiting_permission` is therefore always handed to `A`, whether or not an approval is still pending. `S15` (turn ended) is `S`'s.
2. Approval events, and the task transitions that belong to an approval (T12, T-back = T17/T18/T19, and T20 in rows A2 and A4), are `A`'s. Every other task transition is `T`'s.
3. `operation.outcome_unknown{cause: killed}` is written by `G` only (actor orchestrator), once per operation. `operation.abandoned` for an operation whose approval ended is written by `A`. `T` writes neither.
4. The only permission queue is `K`'s per-session FIFO (P3-4). A `Cancelled` answer through `K` empties it: the waiting requests are answered `cancelled`, nothing is recorded for them and none is promoted. `A` and `T` have no queue.
5. Every transition into `closed` or `failed` carries `outcome` (schema `SessionStateChangedPayload`, required; `failed` allows only `failed` or `cancelled`). The column "outcome" below fixes it; `SessionRuntime::shutdown(outcome)` takes it as an argument and row H8 says which value `T` passes.
6. `T` holds a per-task async mutex around `phase_exit` and around handling `unexpected_close`, so a close reported by the session and a cancel or pause of the task never write task transitions at the same time. `unexpected_close` handling re-reads the task state under the lock and acts only as the "Task effect" of rows A1–A4 says.
7. Re-read and retry: every writer in this table reads the session (and task) state inside the same `Store::transact` that writes. If the projector still rejects the event because the state changed concurrently (for example the user's `S14` committed first), the writer re-reads and retries once; a second rejection is logged and the next event decides.

### Group C — the user cancels the current turn (`SessionRuntime::cancel`)

Order inside `cancel()` (P3-5): `handler.on_turn_cancel` (row C2 steps 1–2) first, then `session/cancel` (step 3). The task stays where it is, except T-back.

| Row | Situation | Events in this order (writer, actor) | Session outcome |
| --- | --- | --- | --- |
| C1 | session `active`, no pending approval | `S` sends `session/cancel`. When the agent ends the turn: `S09 active → idle (turn_ended, stop_reason: cancelled)` (S, adapter). | — |
| C2 | session `awaiting_permission`, one pending approval; more requests may wait in `K`'s queue | 1. One transaction: `approval.resolved{cancelled, acp_outcome: {outcome: cancelled}}` (A, user) and, if the approval is blocking, `T17 awaiting_approval → running (approval_resolved, return_state)` (A, user); non-blocking approval (task in `verifying`/`review`): no task event. 2. `A` answers the ticket `cancelled` through `K`: `K` also answers every waiting request `cancelled` and drops it; **no** `approval.requested`, **no** `S10`, no event at all for those. 3. `S` sends `session/cancel`. 4. When the agent ends the turn: `S15 awaiting_permission → idle (turn_ended, stop_reason: cancelled)` (S, adapter; condition `approval_not_pending_after` holds from step 1). Never an `S14`. | — |
| C3 | C2, and the agent process exits before it ends the turn (the session is still `awaiting_permission`, its approval already resolved) | `Closed{ProcessExited}` → `S16 awaiting_permission → disconnected (process_exited)` (A, adapter); no approval event, none is pending. Then `unexpected_close(ProcessExited)` fires and `T` applies the Task effect of group A (task `running`: `T14 running → interrupted{adapter_disconnected, phase: running}` (T, adapter); task `review` and the closed session has role `review`: T30). The session stays `disconnected` until row H5. | — |
| C4 | C2, and the connection fails (protocol error or line too long) before the turn ends | `S23 awaiting_permission → failed (protocol_error)` (A, orchestrator); no approval event. Then `unexpected_close` and the Task effect of group A (task `running`: `T14 running → interrupted{session_unavailable, phase: running}` (T, orchestrator); task `review` and the closed session has role `review`: T30). | `failed` |
| C5 | a `session/request_permission` reaches `A` while the session is **not** `active` (a late request of a cancelled turn, or one promoted just before the cancel) | Nothing is written. `A` answers the ticket `cancelled` (`K` drops its queue too) and logs a warning. S10 is legal only from `active`. | — |

### Group H — the host closes the session (`SessionRuntime::shutdown(outcome)`)

**H0, order of a phase exit** (`T`, for cancel, pause, fail, complete and abandon; fixture 03 is the cancel case). Each step finishes before the next starts:

1. `A.abort_started_operations_for_task(task)` (row O1) first: a started `pr_merge` makes it return `Err(Uninterruptible)` before anything has been written, and `T` stops. Then cancel running checks (P6-1 cancellation token; wait for them to end).
2. `A.cancel_open_for_task(task)`: pending ACP approvals → `approval.resolved{cancelled, acp_outcome: cancelled}` (A, user), the live tickets answered `cancelled` through `K` (queues dropped); pending host-policy approvals → `cancelled` and their operations `abandoned`; unused grants `invalidated` (§5 step 4 rows; row O2).
3. `T` writes the task transition (T21 / T16 / T11 / T26 / T32 / T37 / T43 for cancel, actor user; T20 / T14 / T09 / T24 / T30 / T35 / T41 `interrupted{user_paused}` for pause; T10 / T15 / T25 / T31 / T36 / T42 for fail; T29 / T39 for complete, actor user; T45 for abandon and T46 for cancel of an `interrupted` task, actor user). Its conditions `approval_not_pending_after` and `no_open_operations` hold after steps 1–2.
4. `T` calls `SessionRuntime::shutdown(outcome)` for each live session of the task (H1–H6), and `SessionRuntime::close_disconnected` for each session that has no runtime object (H5).

`shutdown` reads the session state, acts per the row, and **re-reads the state after any wait**. It sets the in-memory `closing` flag before its first final-state write; while it is set, a `Closed` event of the connection writes nothing and is not reported through `unexpected_close`. A close that happens during the wait (before `closing` is set) is an unexpected close and goes through rows A1–A4 or C3/C4; `shutdown` then continues with H5.

| Row | Session state when `shutdown` reads it | Events in this order (writer, actor) | Session outcome |
| --- | --- | --- | --- |
| H1 | `idle` | `S06 idle → closed (session_closed)` (S, orchestrator), then the process is stopped (`persist_then_act`). Fixture 03 event 16. | the argument |
| H2 | `active` | `session/cancel`, then wait up to `AcpTimeouts::cancel_ack` (10 s) for the turn to end or the connection to close. Turn ended: `S09 (turn_ended, stop_reason: cancelled)` (S, adapter), then H1. Timeout (the agent never ends the turn): `S11 active → suspended (task_interrupted)` (S, orchestrator) → `S18 suspended → closed (session_closed)` (S, orchestrator), then the process is stopped. Connection closed during the wait: row A1 (S12), then H5. | the argument |
| H3 | `awaiting_permission` with its approval already resolved (H0 step 2; fixture 03) | `session/cancel`, then wait as in H2. Turn ended: `S15 awaiting_permission → idle (turn_ended, stop_reason: cancelled)` (S, adapter), then H1's `S06` (fixture 03 events 15–16). Agent exited during the wait: row C3 (`S16` by A), then H5. Timeout (the agent never ends the turn): set `closing`, stop the process, `A.on_session_closed(ShutDown)` writes `S16 awaiting_permission → disconnected (process_exited)` (A, adapter), then H5. If an approval of the session is still pending: `Err(OrchestratorError::ApprovalPending)`, nothing written (the caller skipped H0 step 2). | the argument |
| H4 | `suspended` | `S18 suspended → closed` (S, orchestrator; trigger `session_closed`, or `superseded` when the outcome is `superseded`), then the process is stopped. | the argument |
| H5 | `disconnected` | `S21 disconnected → closed` (S, orchestrator; trigger `abandoned`, or `superseded` when the outcome is `superseded`). There is no process to stop. When the host restarted, no `SessionRuntime` object exists for the session (recovery left it `disconnected`): `T` calls the associated function `SessionRuntime::close_disconnected(store, session_id, outcome)` (P3-5), which writes the same S21. | the argument |
| H6 | `closed` or `failed` | Nothing (`shutdown` is idempotent). | unchanged |
| H7 | `starting` (launch in progress: S01 committed, no S02 yet) | No `SessionRuntime` exists yet, so `T` aborts the launch through `launch`'s `abort` receiver. `launch` stops the process and writes `S03 starting → failed (launch_failed)` (S, orchestrator). Fixture 03 events 21–22. Before S01 nothing is written. `S25` is in `transitions.json` but alpha never reaches it. | `cancelled` when the abort comes from a task cancel or pause, otherwise `failed` |
| H8 | which outcome `T` passes | Task cancelled by the user → `cancelled`. Task paused (`interrupted{user_paused}`) → `abandoned`. Task `failed` (preparation, repair limit, an operation that failed) → `failed`. Task `completed` (T29, T39) → `succeeded`. Task abandoned from `interrupted` (T45) → `abandoned`; task cancelled from `interrupted` (T46) → `cancelled`. A review child session after a parsed verdict (`blocking` or `mergeable`) → `succeeded`; after a missing or unparseable verdict → `failed`. | see left |
| H9 | resume after a host crash or an agent exit: sessions left `disconnected` | During `prepare`, before the replacement session is launched, `T` calls `shutdown(Superseded)` for each `disconnected` session of the task: H5 with trigger `superseded`. The replacement `session.created` carries `supersedes_session_id` (the validator requires the old session to be `closed` or `failed` first). Sessions closed at a pause are already `closed` (outcome `abandoned`). | `superseded` |

### Group A — the agent exits or breaks the protocol by itself (`closing` not set; `S` observes `Closed{reason}`)

After the events of a row, `S` publishes `Some(reason)` on `unexpected_close()`. **Task effect** (the same for A1–A4, written by `T` under the per-task lock, after re-reading the task state): task `running` → `T14 running → interrupted{reason, phase: running}`; `review` → `T30 review → interrupted{reason, phase: review}` **only when the session that closed has role `review`** (a reviewer; an implementation or repair session that closes during `review` writes nothing here: the review goes on, and a send-back relaunches a repair session, P8-3 step 7); `preparing` → `T09 preparing → interrupted{reason, phase}`; every other task state (already `interrupted` by A2/A4 or by a pause, `awaiting_approval`, `verifying`, `pr`, `ci`, ended) → nothing. `reason` and actor: `ProcessExited` → `adapter_disconnected`, actor adapter (fixture 12 events 30–31); `ProtocolError` / `LineTooLong` → `session_unavailable`, actor orchestrator (`acp-capabilities.md` line 97). A user pause from `preparing` is the exception: T09 does not allow actor `user`, so that one is written by orchestrator (P8-3 §1).

| Row | Situation | Events in this order (writer, actor) | Session outcome |
| --- | --- | --- | --- |
| A1 | process exit, session `idle` / `active` / `suspended` | `S08` / `S12` / `S19 → disconnected (process_exited)` (S, adapter). | — |
| A2 | process exit, session `awaiting_permission`, approval **pending** | 1. `S16 awaiting_permission → disconnected (process_exited)` (A, adapter). 2. `approval.resolved{invalidated}` (A, orchestrator; legal only after `S16`, validator line 913). 3. Blocking approval: `T20 awaiting_approval → interrupted{adapter_disconnected, phase: running}` (A, adapter); non-blocking: no task event. | — |
| A3 | protocol error or line too long, session `idle` / `active` / `suspended` | `S22` / `S13` / `S24 → failed (protocol_error)` (S, adapter). | `failed` |
| A4 | protocol error or line too long, session `awaiting_permission`, approval **pending** | 1. `approval.resolved{cancelled, acp_outcome: cancelled}` (A, orchestrator; the answer is best effort, the connection is broken). 2. `S23 awaiting_permission → failed (protocol_error)` (A, orchestrator). 3. Blocking approval: `T20 → interrupted{session_unavailable, phase: running}` (A, orchestrator); non-blocking: no task event. Fixture 12 events 99–100. | `failed` |
| A5 | the session fails while `starting` (spawn, initialize, session/new, timeout, early exit) | `S03 starting → failed (launch_failed)` (S, orchestrator); never `S04`. The task: `prepare` writes `T10 preparation_failed`. | `failed` |

A close while `awaiting_permission` with the approval already resolved is row C3 or C4, not A2 or A4.

### Group O — operations

| Row | Situation | Events (writer, actor) |
| --- | --- | --- |
| O1 | a `started` operation (not `pr_merge`) when the task is cancelled, paused or failed (H0 step 1) | `A.abort_started_operations_for_task` aborts the effect (the process dies) and `G` — the `execute_guarded` call that owns the operation — writes `operation.outcome_unknown{cause: killed}` (G, orchestrator) exactly once and returns `Err(OutcomeUnknown)`. `T` writes nothing for it. A started `pr_merge`: `Err(Uninterruptible)` before anything is aborted or written; `T` stops without writing. |
| O2 | a `recorded` operation waiting for its approval | `approval.resolved{cancelled}` (A, user) → `operation.abandoned{approval_cancelled}` (A, orchestrator) (§5 step 4, host-policy rows). |
| O3 | the caller of `execute_guarded` drops its future | The `Drop` guard aborts the effect and writes the same single `outcome_unknown{killed}` unless row O1 already wrote it (per-operation `settled` flag, §5 P4-3b step 5). |

### What a test may assert (partial order)

- Fixture 03 shape: `approval.resolved{cancelled}` precedes both `T21` and `S15`; `S15` precedes `S06`; `T21` precedes `S06`. **`S15` and `T21` are not ordered**: once the agent has been answered `cancelled` it may end the turn before `T21` commits, and both orders satisfy `approval_not_pending_after`. A test must accept either and reject anything else.
- Never: an `S14` after a cancel; a second `T14` for one close; `S08`/`S12`/`S13`/`S22` or `unexpected_close` after a host-initiated `shutdown`; more than one `outcome_unknown{killed}` per operation; an `S10` for a request of a cancelled turn; a session left `awaiting_permission` after the connection closed.

## 6. Tests to write first

`crates/agentdock-policy` unit tests (`rules.rs`):

| Test | Expected |
| --- | --- |
| `user_only_classes_never_auto_approved` | an `Allow` rule for each of `PrMerge`, `ForcePush`, `BranchDelete`, `WorktreeRemove`, `DestructiveCommand`, `Unclassified` → all `AskUser` |
| `git_push_allow_requires_created_by_user` | `created_by_user: false` → `AskUser`; `true` → `Approve` |
| `deny_rule_wins_over_allow` | Allow and Deny for the same class → `Deny` |
| `path_denied_is_builtin_deny` | `paths_denied = true` → `Deny { rule_id: "builtin.path_scope" }` |
| `default_is_ask` | empty rules → `AskUser` for every class |
| `builtin_prefix_rejected_in_file` | rule id `builtin.x` → load error |

`tests/approvals_adversarial.rs` (mock agent `permission` scenario + temp store + manual clock; each test double-checks projections and whether the mock printed `approved`):

| Test | How | Expected |
| --- | --- | --- |
| `approve_flow_persists_before_answer` | user approves | `approval.resolved` is committed before the mock receives the answer (verify with a store subscription plus mock output order); mock prints `approved` |
| `deny_never_executes` | user denies | mock prints `denied`; `tool_call_update` `failed`; no `approved` in the store |
| `expired_is_refusal` | advance the clock past the TTL | `approval.resolved{expired}` with actor `policy`, then `S14` and `T17` with actor `policy`; mock gets `reject-once`; later `resolve_by_user(Approve)` → `Err(NotPending)` |
| `replay_is_rejected` | approve, then send the same decision again | `Err(NotPending)`; exactly one `approval.resolved` |
| `forged_id_is_rejected` | random `approval_id` | `Err(NotFound)` |
| `cross_task_is_rejected` | decide task A's approval using task B's id | `Err(WrongTask)` |
| `fingerprint_mismatch_is_rejected` | send another fingerprint | `Err(FingerprintMismatch)` |
| `policy_cannot_approve_merge_class` | rule file Allows `pr_merge`; agent requests `gh pr merge 1` | approval stays `pending` until the user decides (contract mutation `b3a_policy_approves_acp_merge`) |
| `title_spoofing_does_not_change_class` | `title: "Read README"`, `rawInput.command: "git push --force"` | `classified_kind == force_push`; an Allow rule for `read_only` has no effect |
| `cancel_turn_cancels_approval` | `SessionRuntime::cancel` while waiting (§5A row C2; scenario `permission`) | `approval.resolved{cancelled}` (user), `acp_outcome.outcome == "cancelled"`, then `T17` (user) in the same transaction, committed **before** the mock receives `session/cancel` and before it gets the `cancelled` answer; **no** `S14`; after the mock ends the turn, `S15` (adapter); later `resolve_by_user` → `NotPending` |
| `cancel_turn_with_queued_second_permission` | scenario `permission-two`; the first request is pending, the second waits in the facade queue; `SessionRuntime::cancel` | exactly one `approval.requested` in the store; `approval.resolved{cancelled}` + `T17` (user); the mock reports `perm1=cancelled perm2=cancelled`; **no** `S10` after `T17`, no event for the second request; then `S15`; the projector accepts every event (§5A rows C2, C5) |
| `cancel_turn_then_agent_exits_does_not_stick` | scenario `scripted`, prompt `EDIT-PATH: <file>` + `ON-CANCEL: exit`; `cancel()` | after `approval.resolved{cancelled}` + `T17`, the mock exits (code 6): `S16` (adapter) is written, the session projection is `disconnected` (not `awaiting_permission`), no further `approval.*` event, `unexpected_close()` is `Some(ProcessExited)` (§5A row C3) |
| `cancel_turn_then_protocol_error_fails_session` | same with `ON-CANCEL: oversize` | `S23` (orchestrator) with `outcome: failed`; no further `approval.*` event; `unexpected_close()` is `Some(LineTooLong)` or `Some(ProtocolError(_))` (§5A row C4) |
| `permission_when_session_not_active_is_refused_unrecorded` | scenario `permission`; while the first request is pending (session `awaiting_permission`), the test calls `on_permission` again with a synthetic context for the same session | no `approval.requested`, no S10, no T12; the call returns after trying to answer `cancelled` (the synthetic ticket yields `UnknownTicket`, logged) (§5A row C5) |
| `task_cancel_during_approval_has_fixture_03_partial_order` | `cancel_open_for_task`, then the test writes `T21` (user), then calls `SessionRuntime::shutdown(Cancelled)`; repeat the whole scenario 10 times | each run has exactly one `approval.resolved{cancelled}`, one `T21`, one `S15`, one `S06` (outcome `cancelled`); `approval.resolved` precedes `T21` and `S15`; `S15` and `T21` appear in either order; `S15` precedes `S06`; `T21` precedes `S06`; the projector accepts every event; no `disconnected` |
| `shutdown_when_agent_never_ends_turn` | scenario `scripted`, `EDIT-PATH` + `ON-CANCEL: ignore`; `SessionConfig.timeouts.cancel_ack = 1 s`; `cancel_open_for_task`, then `shutdown(Cancelled)` | `approval.resolved{cancelled}`; after the timeout the process is stopped, then `S16 awaiting_permission→disconnected (process_exited)` (adapter, written by `on_session_closed(ShutDown)`), then `S21 disconnected→closed (trigger abandoned, outcome: cancelled)` (orchestrator); no `S15`; no `unexpected_close`; session `closed`; no process left (§5A row H3) |
| `restart_invalidates_pending` | simulate restart while waiting: drop everything, `Store::open` + `recover` | approval `invalidated`; a new `ApprovalService`'s `resolve_by_user` → `NotPending`; **no** `approved` anywhere |
| `agent_exit_invalidates_pending` | scenario `permission-fault --arg exit` (agent exits 300 ms after its request) | event order `S16` (adapter) → `approval.resolved{invalidated}` (orchestrator) → `T20` (adapter, `interruption.reason == adapter_disconnected`); task ends `interrupted`; session `disconnected` (§5A row A2) |
| `protocol_error_cancels_then_fails_session` | scenario `permission-fault --arg oversize` | `approval.resolved{cancelled}` (orchestrator) → `S23` (`outcome: failed`) → `T20 interrupted{session_unavailable}`; task `interrupted` (§5A row A4) |
| `review_phase_permission_is_non_blocking` | task in `review`, reviewer session requests a read | `approval.requested` without `return_state`; no `T12`; task stays `review` after resolution |
| `permission_in_pr_state_is_refused_unrecorded` | task in `pr`, agent requests a permission | no `approval.requested`; agent answered `cancelled` |
| `path_outside_scope_auto_denied` | `kind: "edit"`, location outside the workspace | `approval.resolved{denied, actor policy, policy_rule_id: "builtin.path_scope"}`; mock gets a reject |

`tests/guarded_operations.rs` (P4-3b; the effect writes a marker file):

| Test | Expected |
| --- | --- |
| `approved_operation_runs_once` | marker written once; event order recorded → requested → awaiting_approval → resolved → back → started (orchestrator) → succeeded (integration) (as fixture 01 events 38–44) |
| `denied_operation_never_runs` | no marker; `operation.abandoned`; `Err(Denied)` |
| `expired_operation_never_runs` | same, `Err(Expired)`; order `approval.resolved{expired}` (policy) → `operation.abandoned{approval_expired}` → `T18` (policy), as fixture 11 events 65–67 |
| `denied_returns_task_to_phase` | user denies a blocking `git_push` in `pr`; expected: order `approval.resolved{denied}` (user) → `operation.abandoned` → `T18` (user) (fixture 11 events 21–23); task back in `pr`; no S14 anywhere |
| `non_blocking_cleanup_has_no_task_transition` | `worktree_remove` with `return_state: None` on a `completed` task; expected: no task events at all; approval and operation events only |
| `unknown_effect_is_outcome_unknown` | effect returns `EffectOutcome::Unknown`; expected: `operation.outcome_unknown{cause: killed}` with actor `orchestrator`, never `operation.failed`; `Err(OutcomeUnknown)` |
| `merge_requires_user_even_with_allow_rule` | rule file Allows `pr_merge` → still waits for the user |
| `policy_rule_id_recorded_when_policy_approves` | Allow rule for `pr_create` → `approval.resolved` actor `policy` with `policy_rule_id` |
| `effect_panic_is_outcome_unknown` | effect panics → `operation.outcome_unknown{cause: killed}` with actor `orchestrator`; `Err(OutcomeUnknown)` |
| `same_key_twice_without_supersede_rejected` | second identical target → `Rejected` (Rule 5) |
| `push_without_clean_checkpoint_rejected` | `git_push` without a checkpoint → `Rejected`; no marker |
| `crash_after_started_is_not_rerun` | kill the process after the started commit and before the effect (P2-6 crash-harness pattern) → after reopen `outcome_unknown{host_crash}`; no marker; `execute_guarded` with the same target and no supersede → `Rejected` |
| `abort_for_task_writes_killed_once` | the effect spawns a child and waits; call `abort_started_operations_for_task` (§5A row O1); expected: returns the operation id; exactly one `operation.outcome_unknown{cause: killed}` (actor orchestrator) in the store, written by the `execute_guarded` call; the child process is gone within 5 s; `execute_guarded` returned `Err(OutcomeUnknown)`; a second call returns an empty list |
| `dropped_caller_writes_killed_once` | drop the `execute_guarded` future after `operation.started`; then call `abort_started_operations_for_task`; expected: exactly one `outcome_unknown{killed}` in total (§5A row O3); the effect's child is gone |
| `abort_refuses_started_pr_merge` | an in-flight `pr_merge` (test-only effect that waits); expected: `abort_started_operations_for_task` → `Err(Uninterruptible)`; nothing written; the effect is still running and later `succeeded` is accepted |

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-policy rules                                                     # 6 pass
cargo test -p agentdock-orchestrator --test approvals_adversarial -- --test-threads=1    # P4-3a: 22 pass
cargo test -p agentdock-orchestrator --test guarded_operations -- --test-threads=1       # P4-3b: 15 pass
```

Windows-only (CI `rust-windows`): both orchestrator suites pass on `windows-latest` (process kill semantics).

## 8. Spec references and porting sources

All line numbers refer to main `c9e33cf`.

- `docs/contracts/checkpoint-and-replay.md` lines 71–96 (OperationKind, who may approve, APR-11 scope), lines 98–113 Rules 1–11 (especially 2 fingerprint, 3 one approval one execution, 4, 5, 8, 9, 10 expiry, 11 only the executor writes results).
- `docs/contracts/acp-capabilities.md` lines 93–94 (permission mapping, persist first), line 102 (`allow_always` does not widen AgentDock scope).
- `docs/contracts/transitions.json`: T12, T14, T17–T21, T30, T33, T40, S03, S06, S09, S10–S16, S18, S21–S24; schema `SessionStateChangedPayload` (`outcome` required on `closed`/`failed`).
- Fixture 01 (events 12–17 ACP permission, 38–44 git_push, 59–63 worktree_remove after the task ended), fixture 02 (denial), fixture 03 (cancel during approval), fixture 07 (pending at crash).
- `docs/contracts/README.md` line 61 (mutation names for policy approving merges).
- ADR-0003 open questions 7 (which classes policy may approve), 8 and 14 (one permission at a time).
- ADR-0002 lines 121–131 (APR-1, APR-2, APR-9, APR-10, APR-11).
- Issue #8 Requirements 3 (request → pending → approve/deny/expire bound to the operation fingerprint), 6 (prompt injection, stale/forged approvals, restart, cancellation tests), Acceptance.
- Behavior references (Node draft, scenarios only, do not port code): PR #25, SHA `7d41c9f1`, `apps/runtime/runtime.test.mjs` line 139 (held until explicit refusal; replay refused), line 167 (only an explicit `allow_once`), line 183 (unanswered approvals expire as refusals and cannot be approved later), lines 199, 219, 239 (closing a session leaves no approvable pending); `acp-host.mjs` lines 13–23 (`approvalTtlMs: 90_000`, `maxPendingApprovals: 16`).

## 9. Dependencies

No new crates (existing serde, tokio, thiserror).

## 10. Model tier

Strong model implements and reviews. This is the core of AgentDock's safety guarantee; any ordering mistake (answering before recording, a successful replay, policy approving a user-only class) directly violates #51 G7.

## 11. Common mistakes and pitfalls

- `respond_permission` before writing `approval.resolved`: after a crash the agent has acted but the store has no approval.
- Letting the frontend send `actor` or `state`: it sends only ids, the decision and the fingerprint it showed.
- Treating `allow_always` as a permanent rule: the contract forbids it; permanent rules are created only by the user in settings.
- ACP TTL: PR #25 used 90 s, which expires when a person steps away. This packet defaults to **10 minutes** (`acp_ttl` parameter); the value is listed in the README for owner confirmation.
- Preventing approval of user-only classes only by hiding UI buttons: the backend `decide` and the projector must refuse (PR #27 also showed "hiding a notification is not approval").
- Reusing in-memory tickets after restart: recovery has invalidated every pending approval and the map is empty; never "restore" old tickets.
- Running the effect before writing `operation.started` in `execute_guarded`: violates `persist_then_act`; P2-6 kill tests catch it.
- A permission while the task is not `running`: `verifying`/`review` are non-blocking (no `return_state`, no task transition; `checkpoint-and-replay.md` line 96); every other state is refused without recording (§5 step 3.3). Do not invent a task transition.
- Using one generic "resolve" that always writes `S14 → T17`: wrong for expired (actor must be `policy`), cancelled (no S14), host_policy (no session) and agent exit (S16 first). Follow the §5 step 4 table row by row.
- Writing `operation.failed{effect: none}` for a timeout or kill: that opens the door to a second execution (Rule 5). Use `EffectOutcome::Unknown`.
- Writing `outcome_unknown{killed}` from anywhere but `execute_guarded` (for example from P8-3 `phase_exit`): two writers race and the second is rejected by the projector. P8-3 calls `abort_started_operations_for_task` and waits.
- Answering a ticket `cancelled` and letting the facade promote the next waiting request: that request would be recorded with an S10 from `awaiting_permission`. `Cancelled` empties the queue (P3-4), and `on_permission` refuses anything that is not `active` (row C5).
- Handling `on_session_closed` only when an approval is pending: after a turn cancel the approval is already resolved, the session is still `awaiting_permission` and would stay there for ever (row C3). Always write `S16`/`S23`.

## 12. Reviewer checklist

- [ ] Is `respond_permission` called strictly after the `approval.resolved` commit?
- [ ] Does each resolution path match its §5 step 4 row exactly (events, order, actors), checked against the cited fixtures?
- [ ] Is §5A the only place that defines cancel, shutdown, exit, protocol-error and queue behaviour, and do P3-4, P3-5 and P8-3 only refer to it?
- [ ] On agent exit, is S16 written before `invalidated`, and does the task end `interrupted`? Does a close after a cancelled turn (approval already resolved) still leave `awaiting_permission` (C3, C4)?
- [ ] Is `outcome_unknown{killed}` written only by `execute_guarded`, and can P8-3 abort a started operation through `abort_started_operations_for_task`?
- [ ] Do the cancel tests assert the partial order of §5A (not a fixed order of `S15` and `T21`)?
- [ ] Do user decisions check existence, task, pending, expiry and fingerprint, with the actor fixed by the backend?
- [ ] Can any rule auto-approve a user-only class, or `git_push` without `created_by_user`?
- [ ] In `execute_guarded`, does the effect run only after the `operation.started` commit, and does a panic or drop become `outcome_unknown`?
- [ ] Are policy files read only from app data?
- [ ] Do restart and agent-exit tests prove no stale approval can be used?
