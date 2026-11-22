# P3-5: Session runtime (ACP events into the store: coalescing, output limits, streaming redaction, raw I/O artifacts)

> **繁中摘要**：分兩個 PR。**P3-5a**：`agentdock-core::output` 純函式輸出治理——同一回合同一 channel 的 chunk 在 100 ms 或 16 KiB 內合併、每回合 8 MiB／20,000 筆與每則 1 MiB 上限、保留尾端 256 字元做跨段 redaction（含跨段私鑰）。**P3-5b**：建立 `agentdock-orchestrator` crate，`SessionRuntime` 把 P3-4 的 `AcpEvent` 依契約順序寫成 session 事件（created → capabilities_detected → idle、prompt_submitted 與 idle→active 同交易、turn_ended 等）；raw tool I/O 只存成 app data 目錄下內容定址的 artifact；permission 交給 `PermissionHandler`（P4-3），事件迴圈內不 await。`SessionConfig` 帶 `role` 與 `parent_session_id`（reviewer 子 session 需要）。模型等級：P3-5a 一般模型；P3-5b 強模型實作＋審查。

Issues: #6, #7 | Gate (#51): G2 (output streaming), G3 (complete, redacted event log) | Model tier: **P3-5a standard model; P3-5b strong model implements and reviews**

Two PRs:

- **P3-5a**: `agentdock-core::output`, pure output governance (coalescing, limits, cross-chunk redaction). No I/O; time is a parameter.
- **P3-5b**: new crate `agentdock-orchestrator`; `SessionRuntime` turns P3-4 `AcpEvent`s into store events; plus `agentdock-store::artifacts` (content-addressed artifact files).

## 1. Goal and non-goals

Goals:

- This packet writes every session-level event: `session.created` (S01), `session.capabilities_detected`, `session.state_changed` (S02, S03, S05, S08, S09, S12, S13, S15, S22; on shutdown also S06, S11, S18, S21, S25 and the shutdown-kill S16 — §5 step 9), `session.prompt_submitted`, `session.message_delta`, `session.tool_call`, `session.plan_updated`, `usage.reported`, `session.output_limited`.
- Streaming text is coalesced per contract: chunks of the same turn and channel merge into one `session.message_delta` within 100 ms or 16 KiB (whichever first), recording `coalesced_chunks` (`events.md` line 100).
- Limits: per turn 8 MiB of text or 20,000 events, per message 1 MiB. Exceeding writes `session.output_limited`; default action `truncated` (keep reading, stop storing text); adapter config can choose `turn_cancelled` (send `session/cancel`) (`events.md` line 101).
- Every external text passes the P2-7 `Redactor` before writing; secrets split across chunks are caught too (§5 P3-5a step 3).
- `rawInput` / `rawOutput` are stored only as redacted artifact files (`raw_io`); events hold only an `ArtifactRef` (`events.md` line 121).
- `session/request_permission` goes to the `PermissionHandler` trait (P4-3 implements it); this packet neither classifies nor approves.
- Sessions carry a `role` (schema `SessionRole`: `primary`, `implementation`, `review`, `repair`, `explore`, `subtask`; alpha uses `primary`, `repair` and `review`) and an optional `parent_session_id`; `session.created` requires `role` (schema `SessionCreatedPayload`). P8-3 launches the coding session with `role: primary` (`repair` when relaunched for a repair round) and the reviewer sub-session with `role: review` and the coding session as parent. There is **no** `agent` role.
- Turn cancel and shutdown are defined end to end here (§5 steps 8–9): the pending approval is persisted as cancelled **before** `session/cancel` is sent, and a host-initiated shutdown ends in `closed` without a `disconnected` state and without a task interruption.

Non-goals: approval events, S10 / S14 / S23 and the permission-wait S16 (P4-3), task transitions (P8-3), transcript compaction and retention (not in alpha; README "not covered"), reattach (S20, not in alpha).

## 2. Prerequisites and parallel work

- P3-5a prerequisites: P2-1, P2-7. Parallel with P3-1..P3-4.
- P3-5b prerequisites: P3-5a, P3-4, P2-4, P2-5 (session projection), P2-2 (payload types).

## 3. Files

P3-5a new: `crates/agentdock-core/src/output.rs`, `crates/agentdock-core/tests/output_governor.rs`; modified `crates/agentdock-core/src/lib.rs`.

P3-5b new:

- `crates/agentdock-orchestrator/Cargo.toml`, `src/lib.rs`, `src/error.rs` (`OrchestratorError`)
- `crates/agentdock-orchestrator/src/session_runtime.rs`
- `crates/agentdock-orchestrator/src/acp_map.rs` (ACP JSON → payload, pure functions)
- `crates/agentdock-orchestrator/tests/session_runtime_mock.rs`
- `crates/agentdock-store/src/artifacts.rs`

Modified: root `Cargo.toml` (members), `crates/agentdock-store/src/lib.rs`.

## 4. Public types and signatures

```rust
// ===== P3-5a: crates/agentdock-core/src/output.rs =====
use crate::redact::{Redactor, RedactionRule};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy)]
pub struct OutputLimits {
    pub flush_interval_ms: u64,   // 100
    pub flush_bytes: usize,       // 16 * 1024
    pub max_turn_bytes: usize,    // 8 * 1024 * 1024
    pub max_turn_events: u32,     // 20_000
    pub max_message_bytes: usize, // 1024 * 1024
    pub carry_chars: usize,       // 256: tail kept back for cross-chunk redaction
}
impl Default for OutputLimits { /* values above */ }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Channel { AgentMessage, AgentThought, UserMessage }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitKind { MaxTurnBytes, MaxTurnEvents, MaxMessageBytes }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitAction { Truncated, TurnCancelled }

#[derive(Debug, Clone, PartialEq)]
pub enum GovernorOutput {
    Delta { channel: Channel, text: String, coalesced_chunks: u32, applied: BTreeSet<RedactionRule> },
    Limited { limit: LimitKind, action: LimitAction, dropped_bytes: u64 },
}

pub struct OutputGovernor { /* per-channel buffers, counters, in_private_key flags, limit state */ }
impl OutputGovernor {
    pub fn new(limits: OutputLimits, on_limit: LimitAction) -> Self;
    /// Feed one ACP text chunk. `now_ms` is a monotonic clock from the caller.
    pub fn push_chunk(&mut self, channel: Channel, text: &str, now_ms: u64, redactor: &Redactor) -> Vec<GovernorOutput>;
    /// A non-text event (tool call, plan, usage) is about to be written: flush everything first so order is kept,
    /// and count it toward max_turn_events.
    pub fn before_other_event(&mut self, now_ms: u64, redactor: &Redactor) -> Vec<GovernorOutput>;
    /// Timer tick; flushes buffers older than flush_interval_ms.
    pub fn tick(&mut self, now_ms: u64, redactor: &Redactor) -> Vec<GovernorOutput>;
    /// End of turn: flush everything including the carried tail; resets per-turn counters.
    pub fn end_turn(&mut self, redactor: &Redactor) -> Vec<GovernorOutput>;
    /// True once a TurnCancelled limit fired; caller must send session/cancel exactly once.
    pub fn cancel_requested(&self) -> bool;
}

// ===== P3-5b: crates/agentdock-store/src/artifacts.rs =====
pub struct ArtifactStore { /* root: <app data>/artifacts */ }
impl ArtifactStore {
    pub fn open(root: &std::path::Path) -> crate::Result<Self>;
    /// Writes bytes to sha256/<first 2 hex>/<full hex>.<ext> atomically (temp file + rename); returns the
    /// schema ArtifactRef { path (relative to root, '/' separators), sha256, bytes }. Same content → same path.
    pub fn put(&self, bytes: &[u8], ext: &str) -> crate::Result<agentdock_core::payload::ArtifactRef>;
}

// ===== P3-5b: crates/agentdock-orchestrator/src/session_runtime.rs =====
pub type BoxFut<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>>;
/// Object-safe on purpose (native `async fn` in traits is not usable as `dyn`); no async-trait crate.
pub trait PermissionHandler: Send + Sync {
    /// Called for each forwarded permission. Implementation (P4-3) persists approval.requested + S10,
    /// later persists approval.resolved (+ S14 when approved/denied/expired), and only then calls
    /// AcpConnection::respond_permission. S15 is NOT written by P4-3: this packet writes it when the turn ends.
    fn on_permission(&self, ctx: PermissionContext) -> BoxFut<'_>;
    /// Called by SessionRuntime::cancel BEFORE session/cancel is sent. P4-3 (cancel_for_session) persists
    /// approval.resolved{cancelled} + T-back for a pending approval of this session, then answers the agent
    /// `cancelled`, and answers never-recorded queued requests `cancelled`. Resolves when that is done.
    fn on_turn_cancel(&self, session_id: SessionId) -> BoxFut<'_>;
    /// Called once when the connection closed while the session may hold a pending approval.
    /// Called only when the session is awaiting_permission. P4-3 writes S16 → invalidated → T20 (process exit)
    /// or cancelled → S23 → T20 (protocol error / line too long), per the P4-3 §5 step 4 table.
    fn on_session_closed(&self, session_id: SessionId, reason: agentdock_acp::CloseReason) -> BoxFut<'_>;
}
pub struct PermissionContext {
    pub task_id: TaskId, pub session_id: SessionId, pub turn_id: TurnId,
    pub ticket: agentdock_acp::PermissionTicket,
    pub tool_call: serde_json::Value,       // raw, untrusted
    pub options: Vec<agentdock_acp::PermissionOptionView>,
    pub connection: std::sync::Arc<agentdock_acp::AcpConnection>,
}

pub struct SessionConfig {
    pub task_id: TaskId, pub session_id: SessionId, pub adapter_id: AdapterId,
    pub role: SessionRole,                   // P2-2 enum of the schema SessionRole; Primary/Repair coding, Review reviewer
    pub parent_session_id: Option<SessionId>, // Some(coding session) for reviewer sessions
    pub command: agentdock_process::AgentCommand, pub cwd: std::path::PathBuf, // cwd already checked by P4-1
    pub limits: OutputLimits, pub on_limit: LimitAction,
    pub known_secrets: Vec<String>,          // auth env values for this adapter (never logged)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptOrigin { User, Orchestrator } // maps to the actor of session.prompt_submitted

pub struct SessionRuntime { /* Arc<Store>, Arc<ArtifactStore>, Arc<AcpConnection>, Redactor, handler */ }
impl SessionRuntime {
    /// S01 session.created (persist_then_act; role and parent from cfg) → spawn+initialize → capabilities_detected
    /// → session/new → S02 idle. On spawn/initialize/new failure: S03 starting → failed (launch_failed) with a redacted Failure.
    pub async fn launch(store: Arc<Store>, artifacts: Arc<ArtifactStore>, cfg: SessionConfig,
                        handler: Arc<dyn PermissionHandler>) -> Result<Self, OrchestratorError>;
    /// S05 idle → active + session.prompt_submitted (one transaction, persist_then_act), then ACP prompt.
    /// Resolves after S09 active → idle (turn_ended, stop_reason) is committed. Returns the turn id too.
    pub async fn prompt(&self, text: &str, origin: PromptOrigin) -> Result<(TurnId, agentdock_acp::StopReason), OrchestratorError>;
    /// User cancel of the current turn: `handler.on_turn_cancel` first (persist), then AcpConnection::cancel. §5 step 8.
    pub async fn cancel(&self) -> Result<(), OrchestratorError>;
    /// Host-initiated close (P8-3 phase_exit, reviewer done, app exit). Ends in `closed`; never writes S08/S12 and
    /// never reports a closed session to P8-3. Err(OrchestratorError::ApprovalPending) if an approval of this session
    /// is still pending (the caller must call ApprovalService::cancel_open_for_task first). Idempotent. §5 step 9.
    pub async fn shutdown(&self) -> Result<(), OrchestratorError>;
    /// Becomes Some(reason) exactly when the event loop wrote S08/S12/S13/S22 for an unexpected close.
    /// Stays None after a host-initiated shutdown and when the close was handed to handler.on_session_closed.
    /// P8-3 watches it to write T14/T30/T09 (P8-3 §5 step 8).
    pub fn unexpected_close(&self) -> tokio::sync::watch::Receiver<Option<agentdock_acp::CloseReason>>;
    pub fn session_id(&self) -> &SessionId;
}
```

## 5. Implementation steps

### P3-5a

1. Write the §6 P3-5a tests.
2. One buffer per channel `{ text: String, chunks: u32, first_at_ms: u64 }`. `push_chunk`:
   - Check turn limits first: a fired `Truncated` or `TurnCancelled` → only add to `dropped_bytes`, output nothing.
   - Add to `turn_bytes` and `message_bytes` (reset `message_bytes` on channel change or `before_other_event`). Exceeding any limit → emit one `Limited` (at most once per limit kind per turn), then follow the action.
   - Append to the buffer; flush when buffer bytes ≥ `flush_bytes` or `now_ms - first_at_ms >= flush_interval_ms`.
3. Flush (cross-chunk redaction):
   - Except at end of turn, keep the last `carry_chars` characters back (cut with `char_indices`, never mid-UTF-8) and pass the rest to `Redactor::redact_text`.
   - Private key across chunks: if emitted text contains `-----BEGIN ` + `PRIVATE KEY-----` without a matching `END`, set `in_private_key = true`; until `-----END ` + `PRIVATE KEY-----` appears, that channel's text becomes empty (the first part is already `[REDACTED:private_key]`), and `PrivateKey` is added to `applied`.
   - One `Delta.text` never exceeds 65,536 characters (schema `RedactedText`); split into several `Delta`s (`coalesced_chunks` on the first, 1 on the rest).
4. `before_other_event`: flush everything (including carry), `turn_events += 1`, check `max_turn_events`.
5. `end_turn`: flush everything, reset turn counters and `in_private_key`.

### P3-5b

1. Write the §6 P3-5b tests.
2. `ArtifactStore::put`: sha256 → target path; already present → return it (content-addressed); otherwise write `*.tmp-<random>` in the same directory and `std::fs::rename`. The root is `artifacts/` under the app data directory, **never inside a user repo** (`events.md` line 113).
3. `acp_map.rs` (pure, easy to test):
   - `sessionUpdate` values: `agent_message_chunk` / `agent_thought_chunk` / `user_message_chunk` → `Channel` + `content.text` (when `content.type != "text"` store the text `[non-text content: <type>]`); `tool_call` / `tool_call_update` → `ToolCallMapped { tool_call_id, title, kind, status, locations, raw_input, raw_output }`; `plan` → entries; `usage_update` → `Usage` (`source: provider_reported`, `reporter: acp_usage_update`, `scope: cumulative`, `used/size → context_window`, `cost → cost{amount, unit, basis: reported}`, contract `acp-capabilities.md` line 92); anything else (`available_commands_update`, `current_mode_update`, `notice`, ...) → `Ignored` (contract line 95: not part of the v1 contract).
   - Drop every `_meta` key without interpreting it (`events.md` line 119).
   - `kind` / `status` outside the schema enums → `other` / `pending` (agents cannot invent values in the store).
4. `SessionRuntime::launch`:
   1. Any process exit, initialize failure or timeout after S01 and before S02 writes `S03 starting → failed (launch_failed)`; never S04 (reserved for recovery and reattach).
   2. One transaction writes `session.created` (S01, actor orchestrator, `launch_method: new`, `role`, `parent_session_id`). Spawn only after commit.
   3. `AcpConnection::start`; failure → one transaction writes S03 with `error` = redacted message + the last 2 KiB of `AgentProcess::stderr_tail()` (also redacted).
   4. Success → `session.capabilities_detected` (`CapabilitySnapshot` via P2-2 `derive_features`; strip every `_meta` from `acp_agent_capabilities`).
   5. `new_session(cwd)` → `S02 starting → idle (session_ready)`, `external_session_id` = the agent's sessionId, `launch_method: new`.
   6. Start the event loop task: `while let Some(ev) = rx.recv().await`, plus `tokio::time::interval(50ms)` calling `governor.tick`.
5. Event loop:
   - `SessionUpdate` → `acp_map`; text goes through `governor.push_chunk`; other updates call `governor.before_other_event` first, then write their own event. Tool call raw I/O: `redactor.redact_json` → `serde_json::to_vec` → `artifacts.put(.., "json")` → `raw_io: ArtifactRef`. `title` passes `redact_text` and `bound_text`.
   - `PermissionRequested` → `before_other_event`, then `tokio::spawn(handler.on_permission(ctx))` (never await it in the loop, or the session's later updates stall).
   - If the in-memory `closing` flag is set (§5 step 9), a `Closed` event writes nothing and is not reported to P8-3; `shutdown` owns the final state. Otherwise:
   - `Closed{ProcessExited}` → write `S08` (from idle) or `S12` (from active); if the session is `awaiting_permission`, write no state here and call `handler.on_session_closed` (P4-3 writes `S16` first, then invalidates the approval, then moves the task to `interrupted`). `Closed{ProtocolError|LineTooLong}` → `S13` / `S22` (from active / idle); from `awaiting_permission`, call `handler.on_session_closed` (P4-3 cancels the approval, then writes `S23`). After writing S08/S12/S13/S22, send `Some(reason)` on the `unexpected_close` watch channel. Task transitions for these cases (T14 `interrupted{adapter_disconnected}` or `{session_unavailable}`, fixture 12 events 30–31) belong to P8-3.
   - Turn ended (`StopReason` returned) while the session is `awaiting_permission` (the user cancelled the turn and P4-3 already cancelled the approval): write `S15 awaiting_permission → idle (turn_ended)` (actor adapter) instead of S09.
   - Governor outputs: `Delta` → `session.message_delta` with `redaction.applied_rules` = `applied`; `Limited` → `session.output_limited`; the first time `cancel_requested()` is true → `connection.cancel()`.
6. `prompt`: one transaction writes `session.prompt_submitted` (new `turn_id`, redacted `content.text`) and `S05 idle → active`; after commit call `connection.prompt` on another task (the event loop keeps consuming); when `StopReason` returns, `governor.end_turn`, write remaining deltas, then `S09 active → idle (turn_ended, stop_reason, turn_id)`.
7. All writes use P2-4 `Store::transact` on a blocking thread (`spawn_blocking`); the store assigns `seq`.
8. `cancel()` (user cancels the turn):
   1. Session not `active` / `awaiting_permission` → `Ok(())`, nothing sent.
   2. `handler.on_turn_cancel(session_id).await` — P4-3 commits `approval.resolved{cancelled}` (user) + T-back and only then answers the agent `cancelled` (`acp-capabilities.md` line 94: persist the resolution before answering).
   3. Then `connection.cancel(acp_session)` (P3-4 sends `session/cancel` and answers any still-open ticket `cancelled`; the ticket P4-3 already answered is gone, so it is not answered twice).
   4. When the turn ends: S15 (if still `awaiting_permission`) or S09 with `stop_reason: cancelled`, as in steps 5 and 6.
9. `shutdown()` (host-initiated close). Order matters; transitions and actors are from `transitions.json`:
   1. Read the session state from projections. If the session has a pending approval → `Err(OrchestratorError::ApprovalPending)` (add this variant), write nothing.
   2. `active`, or `awaiting_permission` whose approval is already resolved (P8-3 called `cancel_open_for_task`): `connection.cancel(..)`, then wait up to `AcpTimeouts::cancel_ack` (10 s) for the turn to end; the event loop writes S09 (`stop_reason: cancelled`) or S15 (adapter) as usual.
   3. Set `closing = true` (in memory, before any of the writes below and before stopping anything).
   4. Final state, one transaction each, actor `orchestrator`, written **before** the process is stopped (`persist_then_act`), except the last two bullets:
      - `idle` → `S06 idle → closed (session_closed)` — fixture 03 event 16.
      - `starting` → `S25 starting → closed (session_closed)`.
      - `suspended` → `S18 suspended → closed (session_closed)`.
      - still `active` after the timeout → `S11 active → suspended (task_interrupted)`, then `S18 suspended → closed (session_closed)`.
      - still `awaiting_permission` after the timeout (the agent never ended the turn): stop the process first (step 5), then `S16 awaiting_permission → disconnected (process_exited)` (actor adapter, the only allowed actor besides recovery), then `S21 disconnected → closed (abandoned)` (orchestrator).
      - already `disconnected` (the process exited earlier) → `S21 disconnected → closed (abandoned)`.
      - `closed` / `failed` → nothing (idempotent).
   5. `connection.shutdown().await` (P3-4: answers open tickets `cancelled`, ends the connection, reaps the process tree). The resulting `Closed` event is ignored because `closing` is set (step 5, first bullet), so no S08/S12/S13/S22 and no T14.

## 6. Tests to write first

### P3-5a: `crates/agentdock-core/tests/output_governor.rs`

```rust
use agentdock_core::{output::*, redact::Redactor};
fn red() -> Redactor { Redactor::new(&[], &[]) }
fn texts(out: &[GovernorOutput]) -> String {
    out.iter().filter_map(|o| match o { GovernorOutput::Delta { text, .. } => Some(text.as_str()), _ => None }).collect()
}

#[test] fn coalesces_within_window() {
    let mut g = OutputGovernor::new(OutputLimits::default(), LimitAction::Truncated);
    let mut out = vec![];
    for i in 0..10 { out.extend(g.push_chunk(Channel::AgentMessage, "ab", i * 5, &red())); }
    out.extend(g.end_turn(&red()));
    assert_eq!(texts(&out), "ab".repeat(10));
    let deltas: Vec<_> = out.iter().filter(|o| matches!(o, GovernorOutput::Delta { .. })).collect();
    assert_eq!(deltas.len(), 1);
    assert!(matches!(deltas[0], GovernorOutput::Delta { coalesced_chunks: 10, .. }));
}
#[test] fn flushes_after_interval_but_keeps_carry() {
    let mut g = OutputGovernor::new(OutputLimits::default(), LimitAction::Truncated);
    g.push_chunk(Channel::AgentMessage, &"x".repeat(1000), 0, &red());
    let out = g.tick(150, &red());
    assert_eq!(texts(&out).chars().count(), 1000 - 256);
    assert_eq!(texts(&g.end_turn(&red())).chars().count(), 256);
}
#[test] fn secret_split_across_chunks_is_redacted() {
    let tok = format!("ghp_{}", "0".repeat(36));
    let (a, b) = tok.split_at(10);
    let mut g = OutputGovernor::new(OutputLimits::default(), LimitAction::Truncated);
    let mut out = g.push_chunk(Channel::AgentMessage, &format!("{}{}", "y".repeat(16 * 1024), a), 0, &red());
    out.extend(g.push_chunk(Channel::AgentMessage, &format!("{b} end"), 10, &red()));
    out.extend(g.end_turn(&red()));
    let all = texts(&out);
    assert!(!all.contains("ghp_0"), "token leaked");
    assert!(all.contains("[REDACTED:github_token] end"));
}
#[test] fn private_key_body_in_later_chunks_is_dropped() {
    let mut g = OutputGovernor::new(OutputLimits { flush_bytes: 64, ..Default::default() }, LimitAction::Truncated);
    let mut out = g.push_chunk(Channel::AgentMessage, &format!("-----BEGIN RSA PRIVATE KEY-----\n{}", "A".repeat(400)), 0, &red());
    out.extend(g.push_chunk(Channel::AgentMessage, &format!("{}\n-----END RSA PRIVATE KEY-----\nafter", "B".repeat(400)), 10, &red()));
    out.extend(g.end_turn(&red()));
    let all = texts(&out);
    assert!(!all.contains("AAAA") && !all.contains("BBBB"));
    assert!(all.contains("after"));
}
#[test] fn turn_byte_cap_emits_limited_once_and_drops_rest() { /* max_turn_bytes = 1000; push 3000 bytes; exactly one Limited{MaxTurnBytes, Truncated}; text output <= 1000 bytes; dropped_bytes reported */ }
#[test] fn turn_event_cap_counts_other_events() { /* max_turn_events = 3; four before_other_event calls → Limited{MaxTurnEvents} */ }
#[test] fn cancel_action_sets_cancel_requested_once() { /* on_limit = TurnCancelled; exceed; cancel_requested() == true; further pushes output nothing */ }
#[test] fn delta_never_exceeds_schema_max() { /* flush_bytes = 1 MiB; push 200_000 '測' chars; every Delta text <= 65_536 chars */ }
#[test] fn channel_change_flushes_previous_channel_first() { /* push AgentThought then AgentMessage; first Delta is AgentThought */ }
#[test] fn end_turn_resets_counters() { /* hit cap in turn 1; end_turn; turn 2 text flows again */ }
```

The bodies written as comments are specifications; implement them fully.

### P3-5b: `crates/agentdock-orchestrator/tests/session_runtime_mock.rs`

Use the P3-3 mock (find the binary as in P3-4 §6), a store in a temp directory, and a fake `PermissionHandler` that records calls. Each test ends by checking the session state through P2-5 projections and the event order through `events_after(0)`.

| Test | Scenario | Expected |
| --- | --- | --- |
| `launch_writes_created_capabilities_ready_in_order` | `echo` | event types in order: `session.created` (with `role: primary`), `session.capabilities_detected`, `session.state_changed(starting→idle, session_ready)`; snapshot has no `_meta`; projection `idle` |
| `review_session_records_role_and_parent` | `echo`, `role: Review`, `parent_session_id: Some(..)` | `session.created` payload has `role: review` and the parent id; `SessionRow.role == Review` |
| `prompt_turn_events_in_order` | `echo` | `prompt_submitted` and `idle→active` in one transaction (adjacent seqs); then ≥1 `message_delta`; finally `active→idle (turn_ended, end_turn)`; delta texts concatenate to the prompt |
| `launch_failure_is_recorded_as_failed` | `exit-early` | `starting→failed (launch_failed)`; `error` contains no environment variable values |
| `protocol_v2_agent_fails_launch` | `wrong-version` | `starting→failed (launch_failed)` |
| `process_exit_mid_turn_disconnects` | `exit-mid-turn` | `active→disconnected (process_exited)`; `prompt()` returns an error; `unexpected_close()` is `Some(ProcessExited)` |
| `oversize_line_is_protocol_error` | `oversize` | `active→failed (protocol_error)` |
| `flood_is_coalesced` | `flood` | fewer than 1,000 `message_delta`s (10,000 chunks merged); total text length 100,000 |
| `secret_echo_is_redacted_in_store` | `secret-echo` | no event JSON in the store contains `ghp_0`; a delta's `redaction.applied_rules` contains `github_token` |
| `tool_call_raw_io_goes_to_artifact` | `permission` + fake handler that allows | `session.tool_call` has `raw_io`; event JSON lacks `cargo test` (rawInput); the artifact exists with redacted JSON; its path is outside the repo |
| `permission_is_delegated_not_answered` | `permission` + fake handler that does nothing | handler called once; **no** `approval.*` events (not written here); after `cancel` the turn ends `cancelled` |
| `unknown_updates_are_ignored_not_fatal` | `unknown-notification` | turn ends normally; no event written for the unknown update |
| `cancel_persists_before_session_cancel` | `slow` + fake handler whose `on_turn_cancel` records a timestamp, sleeps 300 ms, records again | `prompt` in the background; after 2 deltas `cancel()`; the handler call finishes before the turn ends; at least one delta is written between the two handler timestamps (proves `session/cancel` was not sent yet); turn ends `active→idle (turn_ended, cancelled)` |
| `shutdown_idle_writes_s06_not_disconnected` | `echo`, launch, `shutdown()` | last state event `idle→closed (session_closed)` with actor `orchestrator`; no `disconnected` state anywhere; the fake handler's `on_session_closed` is never called; no process left; a second `shutdown()` → `Ok`, no new event |
| `shutdown_mid_turn_cancels_then_closes` | `slow`, prompt in the background, `shutdown()` | `active→idle (turn_ended, cancelled)` (adapter) then `idle→closed (session_closed)` (orchestrator); no `active→disconnected` |
| `artifact_put_is_content_addressed` (`agentdock-store` unit test) | write the same content twice | same path, one file; `/` separators |

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-core output            # P3-5a: 10 pass
cargo test -p agentdock-store artifacts        # P3-5b: 1 passes
cargo test -p agentdock-orchestrator --test session_runtime_mock -- --test-threads=1   # P3-5b: 15 pass
```

Windows-only (CI `rust-windows`): `session_runtime_mock` must also pass on `windows-latest`.

## 8. Spec references and porting sources

All line numbers refer to main `c9e33cf`.

- `docs/contracts/events.md` lines 87–104 (subscriptions and backpressure; line 100 coalescing, line 101 limits, line 102 pipe backpressure), line 113 (artifact location), lines 115–124 (redaction; line 119 drop `_meta`, line 121 raw I/O only as artifacts).
- `docs/contracts/acp-capabilities.md` lines 80–98 (ACP → AgentDock mapping; line 92 usage, line 95 updates outside the contract).
- `docs/contracts/transitions.json` session transitions S01–S25 (this packet writes S01, S02, S03, S05, S08, S09, S12, S13, S15, S22 and, on shutdown, S06, S11, S18, S21, S25 and the shutdown-kill S16; P4-3 writes S10, S14, S23 and the permission-wait S16).
- Schema `$defs`: `SessionMessageDeltaPayload`, `SessionToolCallPayload`, `SessionOutputLimitedPayload`, `SessionStateChangedPayload`, `SessionCreatedPayload` (lines 821–837; `role` required), `SessionPlanUpdatedPayload`, `Usage`, `TextOrRef`, `RedactedText` (maxLength 65,536), `ArtifactRef`.
- ADR-0003 open question 6 (8 MiB / 20,000 event defaults await owner confirmation).
- Behavior references (Node draft, ideas only, do not port code): PR #25, SHA `7d41c9f1`, `apps/runtime/store.mjs` line 10 `protect()` (truncation markers), `runtime.test.mjs` line 72 (large output truncated and marked), line 116 (streamed replies stored as evidence).

## 9. Dependencies

| Crate | Version | Status |
| --- | --- | --- |
| `sha2` | added by P2-1 | — |
| `tempfile` | 3.27.0 | needs audit (only if used for artifact temp files; `std::fs` + random name also works) |
| `async-trait` | not added | object safety via methods returning `Pin<Box<dyn Future<Output = ()> + Send + '_>>` |

## 10. Model tier

P3-5a standard model (pure functions, full tests). P3-5b strong model implements and reviews: event order, transaction boundaries and "never await the handler in the event loop" affect recovery and approval correctness.

## 11. Common mistakes and pitfalls

- One event per ACP chunk: the 20,000 limit arrives quickly and the UI lags. Always coalesce.
- Buffering or delaying state events (tool call, usage) with text: the contract says they are never merged or dropped; flush text first, then write them, so order holds.
- A secret split across two chunks: per-chunk redaction misses it. Use carry and private-key state.
- Putting `rawInput` directly into `session.tool_call`: violates the contract (artifact only) and is the most common secret source (command arguments, file contents).
- Writing artifacts inside a worktree or repo: the agent can read them and they can be committed. App data directory only.
- `await handler.on_permission(...)` inside the event loop: until the user decides, later updates of that session (including the agent's cancel acknowledgement) stall.
- Sending the ACP prompt before writing `prompt_submitted`: violates `persist_then_act` (S05); after a crash the store has no record of the turn.
- Using the agent's sessionId as AgentDock's `session_id`: they differ; the agent's goes into `external_session_id`.
- Hard-coding `Instant::now()` in the governor: untestable. The caller passes `now_ms`.
- Omitting `role` from `session.created`: the schema requires it; P2-2 rejects the payload. Inventing a role such as `agent`: not in the schema enum.
- Sending `session/cancel` before P4-3 has persisted the cancelled approval: the agent may act on the cancel before the store knows the approval ended (`acp-capabilities.md` line 94).
- Letting the `Closed` event of a host-initiated shutdown write S08/S12 and reach P8-3: the task would be marked `interrupted{adapter_disconnected}` after the user cancelled it. Set `closing` first.
- Stopping the process before writing S06/S25/S18: these are `persist_then_act`.

## 12. Reviewer checklist

- [ ] Is S01 committed before spawning, and are `prompt_submitted` + S05 one transaction committed before the ACP prompt?
- [ ] Are tool/usage/plan events preceded by a text flush, and is the handler spawned rather than awaited?
- [ ] Is cross-chunk redaction (carry + private key state) tested and correct?
- [ ] Is raw I/O stored only as artifacts outside any repo, and are `_meta` keys dropped?
- [ ] Does `session.created` carry `role` and `parent_session_id` from `SessionConfig`?
- [ ] Are the transitions written here exactly the ones listed (no S10/S14/S23; S16 only on the shutdown-kill path)?
- [ ] Does `cancel` await `on_turn_cancel` before `connection.cancel`, and does `shutdown` set `closing`, write the final state with actor `orchestrator` before stopping the process, and refuse while an approval is pending?
