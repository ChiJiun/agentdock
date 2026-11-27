# P3-5: Session runtime (ACP events into the store: coalescing, output limits, streaming redaction, raw I/O artifacts)

> **繁中摘要**：分兩個 PR。**P3-5a**：`agentdock-core::output` 純函式輸出治理——同一回合同一 channel 的 chunk 在 100 ms 或 16 KiB 內合併、每回合 8 MiB／20,000 筆與每則 1 MiB 上限、保留尾端 256 字元做跨段 redaction（含跨段私鑰）。**P3-5b**：建立 `agentdock-orchestrator` crate，`SessionRuntime` 把 P3-4 的 `AcpEvent` 依契約順序寫成 session 事件（created → capabilities_detected → idle、prompt_submitted 與 idle→active 同交易、turn_ended 等）；raw tool I/O 只存成 app data 目錄下內容定址的 artifact；permission 交給 `PermissionHandler`（P4-3），事件迴圈內不 await。回合取消、`shutdown(outcome)`、agent 意外結束與 protocol error 的事件順序、actor 與 session `outcome` **全部以 P4-3 §5A 的單一狀態表為準**，本包只實作其中屬於 `SessionRuntime` 的列。`SessionConfig` 帶 `role` 與 `parent_session_id`（reviewer 子 session 需要）。模型等級：P3-5a 一般模型；P3-5b 強模型實作＋審查。

Issues: #6, #7 | Gate (#51): G2 (output streaming), G3 (complete, redacted event log) | Model tier: **P3-5a standard model; P3-5b strong model implements and reviews**

Two PRs:

- **P3-5a**: `agentdock-core::output`, pure output governance (coalescing, limits, cross-chunk redaction). No I/O; time is a parameter.
- **P3-5b**: new crate `agentdock-orchestrator`; `SessionRuntime` turns P3-4 `AcpEvent`s into store events; plus `agentdock-store::artifacts` (content-addressed artifact files).

## 1. Goal and non-goals

Goals:

- This packet writes every session-level event: `session.created` (S01), `session.capabilities_detected`, `session.state_changed` (S02, S03, S05, S06, S08, S09, S11, S12, S13, S15, S18, S19, S21, S22, S24 — which of them when is P4-3 §5A), `session.prompt_submitted`, `session.message_delta`, `session.tool_call`, `session.plan_updated`, `usage.reported`, `session.output_limited`.
- Streaming text is coalesced per contract: chunks of the same turn and channel merge into one `session.message_delta` within 100 ms or 16 KiB (whichever first), recording `coalesced_chunks` (`events.md` line 100).
- Limits: per turn 8 MiB of text or 20,000 events, per message 1 MiB. Exceeding writes `session.output_limited`; default action `truncated` (keep reading, stop storing text); adapter config can choose `turn_cancelled` (send `session/cancel`) (`events.md` line 101).
- Every external text passes the P2-7 `Redactor` before writing; secrets split across chunks are caught too (§5 P3-5a step 3).
- `rawInput` / `rawOutput` are stored only as redacted artifact files (`raw_io`); events hold only an `ArtifactRef` (`events.md` line 121).
- `session/request_permission` goes to the `PermissionHandler` trait (P4-3 implements it); this packet neither classifies nor approves.
- Sessions carry a `role` (schema `SessionRole`: `primary`, `implementation`, `review`, `repair`, `explore`, `subtask`; alpha uses `primary`, `repair` and `review`) and an optional `parent_session_id`; `session.created` requires `role` (schema `SessionCreatedPayload`). P8-3 launches the coding session with `role: primary` (`repair` when relaunched for a repair round) and the reviewer sub-session with `role: review` and the coding session as parent. There is **no** `agent` role.
- Turn cancel, host shutdown, agent exit and protocol error are defined end to end in **P4-3 §5A** (the single state table: events, order, actors, session `outcome`). This packet implements the rows owned by `SessionRuntime` (§5 steps 5, 8, 9) and defines nothing of its own: the pending approval is persisted as cancelled **before** `session/cancel` is sent, and a host-initiated shutdown ends in `closed` (outcome = the `shutdown` argument) without a task interruption.

Non-goals: approval events, S10 / S14 and every session transition out of `awaiting_permission` except S15 (S16, S23: P4-3, §5A rule 1), task transitions (P8-3), the permission queue (P3-4 only), transcript compaction and retention (not in alpha; README "not covered"), reattach (S20, not in alpha).

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
    /// Called for each forwarded permission. Implementation (P4-3) persists approval.requested + S10 (only when the
    /// session is `active`, else it refuses, §5A row C5), later persists approval.resolved (+ S14 when
    /// approved/denied/expired), and only then calls AcpConnection::respond_permission. S15 is NOT written by P4-3:
    /// this packet writes it when the turn ends.
    fn on_permission(&self, ctx: PermissionContext) -> BoxFut<'_>;
    /// Called by SessionRuntime::cancel BEFORE session/cancel is sent: P4-3 `cancel_for_session` = §5A row C2 steps 1–2
    /// (persist approval.resolved{cancelled} + T-back, then answer the ticket `cancelled`; the facade drops its queue).
    /// Resolves when that is done.
    fn on_turn_cancel(&self, session_id: SessionId) -> BoxFut<'_>;
    /// Called for EVERY close of the connection while the session is awaiting_permission (an approval pending or
    /// already resolved by a turn cancel), and with CloseReason::ShutDown on the shutdown-timeout path. P4-3 writes
    /// S16 / S23 and the approval events per §5A rows C3, C4, A2, A4, H3. If it finds the session no longer
    /// awaiting_permission (the user's S14 landed first) it writes nothing and this packet re-reads and writes S12/S13.
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
    pub timeouts: agentdock_acp::AcpTimeouts, // Default (30 s, 30 s, 10 s); tests shorten `cancel_ack`
    pub supersedes_session_id: Option<SessionId>, // the replacement session of a pause / crash / agent exit (§5A row H9)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptOrigin { User, Orchestrator } // maps to the actor of session.prompt_submitted

pub struct SessionRuntime { /* Arc<Store>, Arc<ArtifactStore>, Arc<AcpConnection>, Redactor, handler, closing flag */ }

/// Pure, table-driven (unit test `close_transition_table`): what the event loop does for `Closed{reason}` when the
/// session is in `state` and `closing` is false. §5A rows A1, A3, C3, C4.
pub(crate) enum CloseAction { Write(SessionTransitionId /* S08 S12 S19 | S13 S22 S24 */), CallHandler, Nothing }
pub(crate) fn close_transition(state: SessionState, reason: &agentdock_acp::CloseReason) -> CloseAction;
impl SessionRuntime {
    /// S01 session.created (persist_then_act; role and parent from cfg) → spawn+initialize → capabilities_detected
    /// → session/new → S02 idle. On spawn/initialize/new failure: S03 starting → failed (launch_failed) with a redacted Failure.
    /// `abort` flips to `true` when P8-3 cancels or pauses the task during launch (§5A row H7): the process is stopped
    /// and S03 starting → failed (launch_failed) is written with outcome `cancelled`.
    pub async fn launch(store: Arc<Store>, artifacts: Arc<ArtifactStore>, cfg: SessionConfig,
                        handler: Arc<dyn PermissionHandler>,
                        abort: tokio::sync::watch::Receiver<bool>) -> Result<Self, OrchestratorError>;
    /// S05 idle → active + session.prompt_submitted (one transaction, persist_then_act), then ACP prompt.
    /// Resolves after S09 active → idle (turn_ended, stop_reason) is committed. Returns the turn id too.
    pub async fn prompt(&self, text: &str, origin: PromptOrigin) -> Result<(TurnId, agentdock_acp::StopReason), OrchestratorError>;
    /// User cancel of the current turn: `handler.on_turn_cancel` first (persist), then AcpConnection::cancel
    /// (§5A rows C1, C2; §5 step 8).
    pub async fn cancel(&self) -> Result<(), OrchestratorError>;
    /// Host-initiated close (P8-3 phase exit step 4, reviewer done, app exit): §5A rows H1–H6. `outcome` is the
    /// session `outcome` carried by the closing transition (schema-required; §5A row H8 lists what P8-3 passes).
    /// Ends in `closed`; never writes S08/S12 and never reports through `unexpected_close`.
    /// Err(OrchestratorError::ApprovalPending) if an approval of this session is still pending (the caller must call
    /// ApprovalService::cancel_open_for_task first). Idempotent. §5 step 9.
    pub async fn shutdown(&self, outcome: agentdock_core::payload::SessionOutcome) -> Result<(), OrchestratorError>;
    /// Becomes Some(reason) after every close the event loop handled while `closing` was false: after it wrote
    /// S08/S12/S19 or S13/S22/S24, and after `handler.on_session_closed` returned for an awaiting_permission session
    /// (S16/S23). Stays None after a host-initiated shutdown. P8-3 applies the "Task effect" of §5A group A.
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
   1. Any process exit, initialize failure or timeout after S01 and before S02 writes `S03 starting → failed (launch_failed)` with `outcome: failed` (§5A row A5); never S04 (reserved for recovery and reattach). If `abort` flips to `true` meanwhile (task cancel or pause): stop the process, write the same S03 with `outcome: cancelled` (row H7) and return `Err(OrchestratorError::Aborted)`; if S01 was not committed yet write nothing.
   2. One transaction writes `session.created` (S01, actor orchestrator, `launch_method: new`, `role`, `parent_session_id`). Spawn only after commit.
   3. `AcpConnection::start(&cfg.command, cfg.timeouts)`; failure → one transaction writes S03 with `error` = redacted message + the last 2 KiB of `AgentProcess::stderr_tail()` (also redacted).
   4. Success → `session.capabilities_detected` (`CapabilitySnapshot` via P2-2 `derive_features`; strip every `_meta` from `acp_agent_capabilities`).
   5. `new_session(cwd)` → `S02 starting → idle (session_ready)`, `external_session_id` = the agent's sessionId, `launch_method: new`.
   6. Start the event loop task: `while let Some(ev) = rx.recv().await`, plus `tokio::time::interval(50ms)` calling `governor.tick`.
5. Event loop:
   - `SessionUpdate` → `acp_map`; text goes through `governor.push_chunk`; other updates call `governor.before_other_event` first, then write their own event. Tool call raw I/O: `redactor.redact_json` → `serde_json::to_vec` → `artifacts.put(.., "json")` → `raw_io: ArtifactRef`. `title` passes `redact_text` and `bound_text`.
   - `PermissionRequested` → `before_other_event`, then `tokio::spawn(handler.on_permission(ctx))` (never await it in the loop, or the session's later updates stall).
   - A `Closed` event: if the in-memory `closing` flag is set (§5 step 9) write nothing and do not report it (`shutdown` owns the final state). Otherwise apply `close_transition(state, reason)`, reading the state in the same transaction (§5A rule 7):
     - `ProcessExited`: `idle` → S08, `active` → S12, `suspended` → S19 (actor adapter; rows A1).
     - `ProtocolError` / `LineTooLong`: `idle` → S22, `active` → S13, `suspended` → S24 (actor adapter, `outcome: failed`; row A3).
     - `awaiting_permission` (an approval pending **or already resolved by a turn cancel**): write no state here; call `handler.on_session_closed(session_id, reason)` and wait for it (rows A2, A4, C3, C4: P4-3 writes S16 / S23 and the approval events). If the handler wrote nothing because the session left `awaiting_permission` meanwhile, re-read and write S12 / S13.
     - `disconnected`, `closed`, `failed`: nothing.
     After the writes (or after the handler returned) send `Some(reason)` on `unexpected_close`. The task transitions for these closes belong to P8-3 (§5A group A "Task effect").
   - Turn ended (`StopReason` returned) while the session is `awaiting_permission` (the user cancelled the turn and P4-3 already cancelled the approval): write `S15 awaiting_permission → idle (turn_ended)` (actor adapter) instead of S09.
   - Governor outputs: `Delta` → `session.message_delta` with `redaction.applied_rules` = `applied`; `Limited` → `session.output_limited`; the first time `cancel_requested()` is true → `connection.cancel()`.
6. `prompt`: one transaction writes `session.prompt_submitted` (new `turn_id`, redacted `content.text`) and `S05 idle → active`; after commit call `connection.prompt` on another task (the event loop keeps consuming); when `StopReason` returns, `governor.end_turn`, write remaining deltas, then `S09 active → idle (turn_ended, stop_reason, turn_id)`.
7. All writes use P2-4 `Store::transact` on a blocking thread (`spawn_blocking`); the store assigns `seq`.
8. `cancel()` (user cancels the turn) implements §5A rows C1 and C2, in this order:
   1. Session not `active` / `awaiting_permission` → `Ok(())`, nothing sent.
   2. `handler.on_turn_cancel(session_id).await` (row C2 steps 1–2; `acp-capabilities.md` line 94: persist the resolution before answering).
   3. Then `connection.cancel(acp_session)` (P3-4 sends `session/cancel` and answers any ticket still open `cancelled`; the one P4-3 already answered is gone).
   4. When the turn ends: S15 (if the session is still `awaiting_permission`) or S09, with `stop_reason: cancelled`, as in steps 5 and 6.
9. `shutdown(outcome)` (host-initiated close) implements §5A rows H1–H6; this list only adds the mechanics. Actor of every event written here: orchestrator, except S09 / S15 (adapter).
   1. Read the session state from projections. A pending approval of this session → `Err(OrchestratorError::ApprovalPending)` (add this variant), write nothing.
   2. `active`, or `awaiting_permission` whose approval is already resolved: `connection.cancel(..)`, then wait until the turn ended (the event loop wrote S09 / S15), the connection closed, or `cfg.timeouts.cancel_ack` elapsed. Then **re-read the state**.
   3. Set `closing = true` (in memory, before any final-state write and before stopping anything).
   4. Final state, one transaction each, written **before** the process is stopped (`persist_then_act`) except where the row says otherwise: `idle` → S06; `suspended` → S18; `active` after the timeout → S11 then S18; `awaiting_permission` after the timeout → stop the process, `handler.on_session_closed(session_id, CloseReason::ShutDown)` (P4-3 writes S16), then S21; `disconnected` → S21; `closed` / `failed` → nothing. The closing transition carries `outcome` = the argument. Triggers: S06 `session_closed`; S18 `session_closed`, or `superseded` when `outcome == Superseded`; S21 `abandoned`, or `superseded` when `outcome == Superseded`.
   5. `connection.shutdown().await` (P3-4: answers open tickets `cancelled`, ends the connection, reaps the process tree). The resulting `Closed` event is ignored because `closing` is set, so no S08/S12/S13/S22, no `unexpected_close`, and no T14.

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

Use the P3-3 mock (find the binary as in P3-4 §6), a store in a temp directory, and a fake `PermissionHandler` in `tests/common.rs` with two modes: `Passive` (records calls, writes nothing) and `Recording` (writes `approval.requested` + S10 like P4-3 in `on_permission`, `approval.resolved{cancelled}` in `on_turn_cancel`, and S16 / S23 in `on_session_closed`, so that a real session can sit in `awaiting_permission`). Each test ends by checking the session state through P2-5 projections and the event order through `events_after(0)`.

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
| `shutdown_idle_writes_s06_not_disconnected` | `echo`, launch, `shutdown(Cancelled)` | last state event `idle→closed (session_closed)` with actor `orchestrator` and `outcome: cancelled`; no `disconnected` state anywhere; the fake handler's `on_session_closed` is never called; no process left; a second `shutdown(Cancelled)` → `Ok`, no new event; `unexpected_close()` stays `None` |
| `shutdown_mid_turn_cancels_then_closes` | `slow`, prompt in the background, `shutdown(Abandoned)` | `active→idle (turn_ended, cancelled)` (adapter) then `idle→closed (session_closed, outcome: abandoned)` (orchestrator); no `active→disconnected` |
| `shutdown_outcome_is_the_argument` | `echo`; five launches, `shutdown` with each of `Succeeded`, `Failed`, `Cancelled`, `Abandoned`, `Superseded`; plus one session left `disconnected` (`exit-mid-turn`) closed with `Superseded` | each closing payload's `outcome` equals the argument; the idle ones use trigger `session_closed`; the disconnected one is `disconnected→closed` with trigger `superseded` (S21); every event passes the projector |
| `closed_while_awaiting_permission_calls_handler_once` | `permission-fault --arg exit`, fake handler `Recording` | `on_session_closed` called once with `ProcessExited`; this packet writes **no** S08/S12/S16; `unexpected_close()` becomes `Some(ProcessExited)` only after the handler returned (the fake delays 200 ms and the test compares timestamps) |
| `closed_after_turn_cancel_still_calls_handler` | `scripted` with prompt `EDIT-PATH: <file>` and `ON-CANCEL: exit`, fake handler `Recording`; `cancel()` | the approval is already resolved when the agent exits; `on_session_closed` is still called once with `ProcessExited` (the session is `awaiting_permission`) and the session ends `disconnected`, not stuck (§5A row C3) |
| `launch_abort_writes_failed_cancelled` | `hang-init`; flip `abort` after 500 ms | `session.created` then `starting→failed (launch_failed)` with `outcome: cancelled` (actor orchestrator); `launch` returns `Err(Aborted)`; the process is gone (§5A row H7) |
| `artifact_put_is_content_addressed` (`agentdock-store` unit test) | write the same content twice | same path, one file; `/` separators |

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-core output            # P3-5a: 10 pass
cargo test -p agentdock-store artifacts        # P3-5b: 1 passes
cargo test -p agentdock-orchestrator --test session_runtime_mock -- --test-threads=1   # P3-5b: 19 pass
cargo test -p agentdock-orchestrator --lib session_runtime                              # P3-5b: 1 passes (`close_transition_table`: every state × reason of §5A rows A1, A3, C3, C4)
```

Windows-only (CI `rust-windows`): `session_runtime_mock` must also pass on `windows-latest`.

## 8. Spec references and porting sources

All line numbers refer to main `c9e33cf`.

- `docs/contracts/events.md` lines 87–104 (subscriptions and backpressure; line 100 coalescing, line 101 limits, line 102 pipe backpressure), line 113 (artifact location), lines 115–124 (redaction; line 119 drop `_meta`, line 121 raw I/O only as artifacts).
- `docs/contracts/acp-capabilities.md` lines 80–98 (ACP → AgentDock mapping; line 92 usage, line 95 updates outside the contract).
- `docs/contracts/transitions.json` session transitions S01–S25 (this packet writes S01, S02, S03, S05, S06, S08, S09, S11, S12, S13, S15, S18, S19, S21, S22, S24; P4-3 writes S10, S14, S16, S23; S04, S07, S17, S20, S25 are not written in alpha). **P4-3 §5A is the table that says which, when and in what order.**
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
- Calling `handler.on_session_closed` only when an approval is pending: after a turn cancel the approval is resolved but the session is still `awaiting_permission`; skipping the handler leaves it there for ever (§5A row C3).
- Writing `closed` without `outcome` (schema-required): `shutdown` takes the outcome as an argument.
- Stopping the process before writing S06/S18 (and S11 on the timeout path): these are `persist_then_act`.

## 12. Reviewer checklist

- [ ] Is S01 committed before spawning, and are `prompt_submitted` + S05 one transaction committed before the ACP prompt?
- [ ] Are tool/usage/plan events preceded by a text flush, and is the handler spawned rather than awaited?
- [ ] Is cross-chunk redaction (carry + private key state) tested and correct?
- [ ] Is raw I/O stored only as artifacts outside any repo, and are `_meta` keys dropped?
- [ ] Does `session.created` carry `role` and `parent_session_id` from `SessionConfig`?
- [ ] Are the transitions written here exactly the ones listed (no S10/S14/S16/S23: those are P4-3's, §5A rule 1)? Is every `closed`/`failed` transition written with the `outcome` of §5A?
- [ ] Does `cancel` await `on_turn_cancel` before `connection.cancel`, and does `shutdown(outcome)` set `closing`, write the final state with actor `orchestrator` before stopping the process (rows H1–H6), and refuse while an approval is pending?
- [ ] Is a close of an `awaiting_permission` session always handed to the handler, and does `unexpected_close` fire after it returned?
