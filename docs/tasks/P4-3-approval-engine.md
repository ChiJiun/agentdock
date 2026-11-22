# P4-3: Approval engine (ACP permissions, host-policy operations, `execute_guarded`, adversarial tests)

> **繁中摘要**：分兩個 PR。**P4-3a**：實作 P3-5 的 `PermissionHandler`——ACP permission → P4-2 分類 → policy 決定 → 寫 approval／S10／T12 → 等使用者 → **先持久化 `approval.resolved` 再回覆 agent**；使用者決定 API 只接受仍 pending、未過期、同一 task、指紋相符的決定，actor 固定 `user`；policy 規則檔在 app data（不讀 repo），user-only 類別永遠不自動核准，`git_push` 只能由使用者自建規則自動核准。**P4-3b**：`execute_guarded`——AgentDock 自己的不可重複操作一律「記錄意圖 → host-policy 核准 → started → 執行 → 結果」，effect 只在 started commit 之後執行。附偽造、過期、重放、跨 task、policy 核准 merge、取消、重啟等對抗測試。模型等級：強模型實作＋強模型審查。

Issues: #8, #10 | Gate (#51): G5 (confirmation before PR), G7 (denied operations never run), G8 (no leftover approvals after interruption/restart) | Model tier: **strong model implements and reviews**

Two PRs: **P4-3a** (policy rules, ACP permission handler, user decision API) and **P4-3b** (`execute_guarded` for host-policy operations). They share the §4 types.

## 1. Goal and non-goals

Goals:

- Implement P3-5's `PermissionHandler`: ACP `session/request_permission` → P4-2 classification → policy decision → approval and state events → wait for the user → **persist first, then answer the agent**.
- `execute_guarded`: every non-repeatable operation AgentDock itself performs (`git_push`, `pr_create`, `pr_update`, `pr_comment`, `pr_merge`, `branch_delete`, `worktree_remove`, `destructive_command`, `external_write`) goes through "record intent → host-policy approval → started → effect → result" (`checkpoint-and-replay.md` Rules 1–4, 9–11).
- User decision API: accepts only decisions for approvals that are still pending, unexpired, of the same task, with a matching fingerprint; the actor is always `user`.
- Policy rule file (user-level, app data directory): may auto-approve only non-user-only classes; any class may be denied by policy. `git_push` can be auto-approved only by a rule the user created (current proposal for ADR-0003 open question 7).
- Adversarial tests: forged, expired, replayed, cross-task, policy approving merge, cancel, restart.

Non-goals: approval UI (P4-4), real Git/GitHub execution (P5, P7 call `execute_guarded`), executing `terminal/*` / `fs/*` (alpha does not advertise them), detecting agents' native bypass modes (#26).

## 2. Prerequisites and parallel work

- P4-3a prerequisites: P4-2, P3-5b, P2-5 (approval/operation projections and rules), P2-6 (recovery invalidates pending approvals), P3-7 (Tauri commands get the store and services from `AppState::ready()`; add `ApprovalService` to `Ready`).
- P4-3b prerequisites: P4-3a.
- Parallel: P5-*, P6-1. P4-4, P5-2, P7-2, P8-4 use this packet.

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

pub struct ApprovalService { /* Arc<Store>, policy file path, Clock, live ACP tickets: HashMap<ApprovalId, (Arc<AcpConnection>, PermissionTicket, Vec<PermissionOptionView>)> */ }

impl ApprovalService {
    pub fn new(store: Arc<Store>, policy_path: PathBuf, clock: Arc<dyn Clock>, acp_ttl: Duration) -> Self;
    /// Called from the Tauri command. `shown_fingerprint` is the operation_fingerprint the UI displayed.
    pub async fn resolve_by_user(&self, task_id: &TaskId, approval_id: &ApprovalId,
        decision: UserDecision, shown_fingerprint: &Sha256Hex) -> Result<(), ApprovalError>;
    /// Background loop: every 1 s, expire pending approvals whose expires_at <= now (approval.resolved{expired}, actor policy).
    pub async fn run_expiry_loop(self: Arc<Self>);
    /// User cancelled the current turn while a permission is pending (called by SessionRuntime::cancel, P3-5).
    pub async fn cancel_for_session(&self, session_id: &SessionId) -> Result<(), ApprovalError>;
    /// Before the user cancels or pauses a task (P8-3): pending → cancelled (actor user), host-policy operations of
    /// those approvals → abandoned, approved-but-unused host-policy grants → invalidated (actor orchestrator).
    /// Writes NO task transition; the caller writes T21 / T20 / other phase exit in the very next transaction.
    pub async fn cancel_open_for_task(&self, task_id: &TaskId) -> Result<Vec<ApprovalId>, ApprovalError>;
}
impl agentdock_orchestrator::session_runtime::PermissionHandler for ApprovalService {
    /* on_permission(ctx), on_session_closed(session_id, agentdock_acp::CloseReason) — P3-5 trait; see §5 step 6.
       CloseReason::ProcessExited → "agent process exited" row; ProtocolError / LineTooLong → "protocol error" row. */
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
}
impl ApprovalService {
    /// 1 tx: operation.recorded (orchestrator) + approval.requested(host_policy, same id/kind/fingerprint,
    ///      return_state when blocking; actor policy) + if blocking T12/T33/T40 (actor policy, return_state).
    /// Then the resolution follows the §5 step 4 table (host_policy rows); denied/expired/cancelled → Err.
    /// Then 1 tx: operation.started (actor orchestrator; projector checks rules 3, 9, 10). Only after commit: run `effect`.
    /// Then 1 tx: operation.succeeded / operation.failed / operation.outcome_unknown{killed} (actor integration).
    pub async fn execute_guarded<F, Fut>(&self, req: OperationRequest, effect: F) -> Result<serde_json::Value, GuardError>
    where F: FnOnce() -> Fut + Send + 'static, Fut: std::future::Future<Output = EffectOutcome> + Send + 'static;
}
```

## 5. Implementation steps

### P4-3a

1. Write the §6 tests.
2. `rules.rs`: `decide` follows the order in the §4 comment; `load_policy_file` validates version, rule count, id format, unique ids, reserved `builtin.` prefix. File location: `<app data>/policy.json`; **never read any policy file from a repo**. This is deliberately stricter than ADR-0002 APR-9 (which allows project-level rules that only add restrictions): alpha reads no project-level rules at all.
3. `on_permission(ctx)`:
   1. From projections, get the session's task and its state, and the session cwd's `ScopedPath`.
   2. `classify_permission(ctx.tool_call, scope, base)`; `paths_denied` = any path `Deny`.
   3. Blocking or not, by task state (`checkpoint-and-replay.md` line 96):
      - `running` → **blocking**: `return_state: running`.
      - `verifying` / `review` → **non-blocking**: no `return_state`, no task transition (e.g. the reviewer session).
      - any other state → write nothing, answer the agent `cancelled`, log a `tracing` warning (the contract forbids approvals there; T33/T40 allow only actor `policy`, so ACP requests cannot block `pr`/`ci`).
   - One at a time (ADR-0003 open questions 8 and 14): if the task already has a pending blocking approval, or this session already has a pending approval, hold the new request in a per-task FIFO and start step 4 for it only after the earlier one is resolved. Never write two pending blocking approvals for one task.
   4. New `approval_id`; one transaction writes (fixture 01 events 12–14 / fixture 03 events 10–12): `approval.requested{source: acp_permission, operation_kind: "tool_call", classified_kind, operation_fingerprint, title (redacted + bounded), scope: once, acp: {tool_call_id, options}, expires_at: now + acp_ttl, return_state (blocking only)}` (actor `adapter`) → `S10 active → awaiting_permission (permission_requested, approval_id)` (actor `adapter`) → if blocking, `T12 running → awaiting_approval (approval_requested, approval_id, return_state: running)` (actor `adapter`).
   5. Remember `(approval_id → connection, ticket, options)`.
   6. `decide(...)`: `Approve` → resolve per step 4 (actor `policy`, `policy_rule_id`); `Deny` → same with `denied`; `AskUser` → nothing; wait for the user or expiry.
4. Resolution table. Every row is **one transaction** in the listed order; the agent is answered **only after commit** (`acp-capabilities.md` line 94); if answering fails (connection gone), do not change the store; log a `tracing` warning. "T-back" = T17/T18/T19 chosen by `return_state` (blocking only; non-blocking rows simply omit task events). Actors are fixed by `validate_fixtures.py` lines 903–931 and transitions.json.

   | Case | Events (actor) | Answer to agent |
   | --- | --- | --- |
   | ACP approved / denied by user or policy | `approval.resolved{approved\|denied, acp_outcome}` (user\|policy) → `S14` (same actor) → T-back (same actor) | selected option |
   | ACP expired | `approval.resolved{expired, acp_outcome}` (**policy**) → `S14` (policy) → T-back (policy) | reject option |
   | ACP, user cancels the turn (`cancel_for_session`) | `approval.resolved{cancelled, acp_outcome: {outcome: cancelled}}` (user) → T-back (user). No S14: the adapter writes `S15 awaiting_permission → idle` when the turn ends (P3-5) | `cancelled` |
   | ACP, user cancels / pauses the task (`cancel_open_for_task`) | `approval.resolved{cancelled, acp_outcome: cancelled}` (user); caller then writes `T21` (cancel) or `T20 interrupted{user_paused}` (pause) — fixture 03 events 13–15 | `cancelled` |
   | ACP, agent process exited (`on_session_closed(ProcessExited)`) | `S16 awaiting_permission → disconnected (process_exited)` (adapter) → `approval.resolved{invalidated}` (orchestrator; legal only after S16 because `awaiting_permission` is a live session state, validator line 913) → if blocking `T20 awaiting_approval → interrupted{reason: adapter_disconnected, phase: running}` (adapter) | none (connection gone) |
   | ACP, protocol error (`on_session_closed(ProtocolError \| LineTooLong)`) | `approval.resolved{cancelled, acp_outcome: cancelled}` (orchestrator) → `S23 awaiting_permission → failed (protocol_error)` (orchestrator) → if blocking `T20 interrupted{reason: session_unavailable, phase: running}` (orchestrator) — fixture 12 events 99–100 | best effort `cancelled` |
   | host_policy approved by user or policy | `approval.resolved{approved, policy_rule_id?}` (user\|policy) → T-back (same actor). **Never S14** (no session) | — |
   | host_policy denied (user\|policy) / expired (**policy**) | `approval.resolved{denied\|expired}` → `operation.abandoned{approval_denied\|approval_expired}` (orchestrator) → T-back (same actor as the resolution) — fixture 11 events 21–23 and 65–67 | — |
   | host_policy, task cancel / pause | `approval.resolved{cancelled}` (user) → `operation.abandoned{approval_cancelled}` (orchestrator); caller then writes T21 / T20 | — |
   | host_policy grant approved but not yet started, task leaves the phase | `approval.resolved{invalidated}` (orchestrator) → `operation.abandoned` (orchestrator) | — |

   Option choice for `acp_outcome`: `approved` → first `allow_once`; if only `allow_always` exists use it but record `scope: once` (`acp-capabilities.md` line 102); no allow-type option → treat as `denied`. `denied` / `expired` → first `reject_once`, else `reject_always`; if the agent offered no reject option, write the decision as `cancelled` with `acp_outcome: cancelled` instead (the validator requires `expired`/`denied` to select a `reject_*` option). Restart (pending at crash) is handled by P2-6 recovery, not here.
5. `resolve_by_user`: check order `NotFound` → `WrongTask` (approval's task ≠ parameter) → `NotPending` → `Expired` (`now >= expires_at`) → `FingerprintMismatch` → resolve per the table (actor user). The projector also rejects illegal events (second line of defense); map store errors to `Rejected`.
6. `on_session_closed(session_id, reason)`: only acts when the session is `awaiting_permission` with a pending approval; applies the matching table row. P3-5 calls it instead of writing S16/S23 itself. When the session was not awaiting permission, P3-5 writes S08/S12/S13/S22 and P8-3 handles the task (T14 `interrupted{adapter_disconnected}`, fixture 12 events 30–31).
7. `cancel_open_for_task`: applies the "task cancel / pause" and "grant not yet started" rows for every open approval of the task; returns the ids. P8-3 writes the task transition in the next transaction (its conditions `approval_not_pending_after` and `no_open_operations` now hold).
8. Tauri commands: `approvals_pending(task_id) -> Vec<ApprovalView>` (`approval_id`, `classified_kind`, `title`, `operation_fingerprint`, `expires_at`, `user_only`, `policy_hint`) and `approval_resolve(task_id, approval_id, decision, fingerprint)`. The frontend sends only ids, the decision and the fingerprint it showed; the backend fixes the actor to `user`.

### P4-3b

1. Write the §6 P4-3b tests.
2. `execute_guarded` follows the §4 comment. `idempotency_key` = P2-1 `idempotency_key(kind, target)`; `operation_fingerprint` = the same value (Rule 2).
3. User-only kinds (`pr_merge`, `branch_delete`, `worktree_remove`, `destructive_command`): `decide` always returns `AskUser` or `Deny`, even if the file says `Allow` (covered by `decide` unit tests).
4. Before `git_push`, the caller (P7-2) must write a checkpoint; this function does not, but if the projector rejects `operation.started` under Rule 9, return `Rejected` and write `operation.abandoned`.
5. Run the effect with `tokio::spawn` and await the `JoinHandle`: `EffectOutcome::Unknown` or panic → `operation.outcome_unknown{cause: killed}`. Caller cancellation (future dropped) → a `Drop` guard first calls `JoinHandle::abort()` (effects that spawn processes must use `kill_on_drop(true)` so aborting kills them), then writes `outcome_unknown{killed}` via a background `spawn_blocking` (Drop cannot await). Never write `outcome_unknown{killed}` for `pr_merge` (mutation `b5_kill_started_merge`; merge is not executed in alpha).
6. `OperationKind → PolicyClass` for `decide` (from `checkpoint-and-replay.md` line 96, inverted): `git_push` → `GitPush`; `pr_create` / `pr_update` / `pr_comment` → `PrWrite`; `pr_merge` → `PrMerge`; `branch_delete` → `BranchDelete`; `worktree_remove` → `WorktreeRemove`; `destructive_command` → `DestructiveCommand`; `external_write` → `ExternalWrite`. Put it in one `match` with no wildcard arm.

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
| `cancel_turn_cancels_approval` | `SessionRuntime::cancel` while waiting | `approval.resolved{cancelled}` (user), `acp_outcome.outcome == "cancelled"`, then `T17` (user) in the same transaction; **no** `S14`; after the mock ends the turn, `S15` (adapter); later `resolve_by_user` → `NotPending` |
| `task_cancel_during_approval_matches_fixture_03` | `cancel_open_for_task`, then the test writes `T21` (user) | event order equals fixture 03 events 13–15; projector accepts every event |
| `restart_invalidates_pending` | simulate restart while waiting: drop everything, `Store::open` + `recover` | approval `invalidated`; a new `ApprovalService`'s `resolve_by_user` → `NotPending`; **no** `approved` anywhere |
| `agent_exit_invalidates_pending` | kill the mock while waiting | event order `S16` (adapter) → `approval.resolved{invalidated}` (orchestrator) → `T20` (adapter, `interruption.reason == adapter_disconnected`); task ends `interrupted`; session `disconnected` |
| `protocol_error_cancels_then_fails_session` | mock scenario `bad-json` while waiting | `approval.resolved{cancelled}` (orchestrator) → `S23` → `T20 interrupted{session_unavailable}`; task `interrupted` |
| `review_phase_permission_is_non_blocking` | task in `review`, reviewer session requests a read | `approval.requested` without `return_state`; no `T12`; task stays `review` after resolution |
| `permission_in_pr_state_is_refused_unrecorded` | task in `pr`, agent requests a permission | no `approval.requested`; agent answered `cancelled` |
| `path_outside_scope_auto_denied` | `kind: "edit"`, location outside the workspace | `approval.resolved{denied, actor policy, policy_rule_id: "builtin.path_scope"}`; mock gets a reject |

`tests/guarded_operations.rs` (P4-3b; the effect writes a marker file):

| Test | Expected |
| --- | --- |
| `approved_operation_runs_once` | marker written once; event order recorded → requested → awaiting_approval → resolved → back → started → succeeded (as fixture 01 events 38–44) |
| `denied_operation_never_runs` | no marker; `operation.abandoned`; `Err(Denied)` |
| `expired_operation_never_runs` | same, `Err(Expired)`; order `approval.resolved{expired}` (policy) → `operation.abandoned{approval_expired}` → `T18` (policy), as fixture 11 events 65–67 |
| `denied_returns_task_to_phase` | user denies a blocking `git_push` in `pr` | order `approval.resolved{denied}` (user) → `operation.abandoned` → `T18` (user) (fixture 11 events 21–23); task back in `pr`; no S14 anywhere |
| `non_blocking_cleanup_has_no_task_transition` | `worktree_remove` with `return_state: None` on a `completed` task | no task events at all; approval and operation events only |
| `unknown_effect_is_outcome_unknown` | effect returns `EffectOutcome::Unknown` | `operation.outcome_unknown{cause: killed}`, never `operation.failed`; `Err(OutcomeUnknown)` |
| `merge_requires_user_even_with_allow_rule` | rule file Allows `pr_merge` → still waits for the user |
| `policy_rule_id_recorded_when_policy_approves` | Allow rule for `pr_create` → `approval.resolved` actor `policy` with `policy_rule_id` |
| `effect_panic_is_outcome_unknown` | effect panics → `operation.outcome_unknown{cause: killed}`; `Err(OutcomeUnknown)` |
| `same_key_twice_without_supersede_rejected` | second identical target → `Rejected` (Rule 5) |
| `push_without_clean_checkpoint_rejected` | `git_push` without a checkpoint → `Rejected`; no marker |
| `crash_after_started_is_not_rerun` | kill the process after the started commit and before the effect (P2-6 crash-harness pattern) → after reopen `outcome_unknown{host_crash}`; no marker; `execute_guarded` with the same target and no supersede → `Rejected` |

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-policy rules                                                     # 6 pass
cargo test -p agentdock-orchestrator --test approvals_adversarial -- --test-threads=1    # P4-3a: 17 pass
cargo test -p agentdock-orchestrator --test guarded_operations -- --test-threads=1       # P4-3b: 12 pass
```

Windows-only (CI `rust-windows`): both orchestrator suites pass on `windows-latest` (process kill semantics).

## 8. Spec references and porting sources

All line numbers refer to main `c9e33cf`.

- `docs/contracts/checkpoint-and-replay.md` lines 71–96 (OperationKind, who may approve, APR-11 scope), lines 98–113 Rules 1–11 (especially 2 fingerprint, 3 one approval one execution, 4, 5, 8, 9, 10 expiry, 11 only the executor writes results).
- `docs/contracts/acp-capabilities.md` lines 93–94 (permission mapping, persist first), line 102 (`allow_always` does not widen AgentDock scope).
- `docs/contracts/transitions.json`: T12, T17–T21, T33, T40, S10, S14–S16, S23.
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

## 12. Reviewer checklist

- [ ] Is `respond_permission` called strictly after the `approval.resolved` commit?
- [ ] Does each resolution path match its §5 step 4 row exactly (events, order, actors), checked against the cited fixtures?
- [ ] On agent exit, is S16 written before `invalidated`, and does the task end `interrupted`?
- [ ] Do user decisions check existence, task, pending, expiry and fingerprint, with the actor fixed by the backend?
- [ ] Can any rule auto-approve a user-only class, or `git_push` without `created_by_user`?
- [ ] In `execute_guarded`, does the effect run only after the `operation.started` commit, and does a panic or drop become `outcome_unknown`?
- [ ] Are policy files read only from app data?
- [ ] Do restart and agent-exit tests prove no stale approval can be used?
