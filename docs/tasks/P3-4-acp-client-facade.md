# P3-4: ACP client facade (initialize, session, prompt streaming, cancel, permission forwarding)

> **繁中摘要**：在 `agentdock-acp` 提供 `AcpConnection`，是整個 AgentDock **唯一**接觸 ACP SDK 的地方：把 P3-2 程序、P3-1 framing 與 SDK 的 `Client.v1()` 接起來，對外只暴露自己的型別。`initialize` 只接受 v1、30 秒逾時；`session/new`、`session/prompt`（更新經有界 channel 送出、形成背壓）、`session/cancel`。permission 請求在 SDK callback 內**不等待使用者**：存下 responder 立即返回，之後呼叫端持久化 `approval.resolved` 後才 `respond_permission`；每個 session 一次只轉發一個。取消時把所有 pending permission 以 `cancelled` 回覆。另寫 spike S3／S5 紀錄。模型等級：強模型實作＋強模型審查。

Issue: #6 | Gate (#51): G2 (create sessions, send prompts and cancel through real ACP) | Model tier: **strong model implements and reviews**

## 1. Goal and non-goals

Goal: `AcpConnection` in `agentdock-acp`, the **only** place in AgentDock that touches the ACP SDK (ADR-0002 decision 1 facade). It connects the P3-2 process, P3-1 framing and the SDK's `Client.v1()`, and exposes only AgentDock types.

- `initialize`: send `protocolVersion: 1` and AgentDock's `clientCapabilities` (alpha always `fs.readTextFile=false`, `fs.writeTextFile=false`, `terminal=false`). A response `protocolVersion` other than 1 → end the process, return `UnsupportedProtocolVersion` (contract `acp-capabilities.md` line 108 "Default is v1"). Timeout 30 s (PR #25 `initTimeoutMs`; X-1 notes Windows cold starts can exceed 10 s).
- Return the raw `agentCapabilities` JSON and `authMethods`; P3-5 builds the `CapabilitySnapshot` with P2-2's `derive_features`. The facade does not derive features.
- `session/new`, `session/prompt` (updates streamed through a channel), `session/cancel`.
- `session/request_permission`: **never wait for the user inside the SDK callback**. Store the SDK `Responder`, emit an event, return immediately; `respond_permission` answers later. One forwarded request per session at a time; a second one queues (current proposal for ADR-0003 open questions 8, 14).
- `cancel`: send `session/cancel` and answer every forwarded and queued permission of that session with `cancelled` (ACP v1 rule, contract line 26).
- Protocol errors, process exit and oversized lines become `AcpEvent::Closed { reason }`.
- Record ADR-0002 spikes S3 and S5 (`docs/research/acp-sdk-s3-s5.md`).

Non-goals: writing to the store (P3-5), policy classification (P4-2), `session/load` / `resume` / `close` (not used in alpha; the contract default is "Agent session cannot be reconnected; restart with summary"), `fs/*` and `terminal/*` client methods (alpha does not advertise them; answer JSON-RPC `method_not_found`), ACP v2.

## 2. Prerequisites and parallel work

- Prerequisites: P3-1, P3-2, P3-3.
- Parallel: P4-*, P5-*, store work after P2-4. P3-5 depends on this packet.

## 3. Files

New:

- `crates/agentdock-acp/src/client.rs`
- `crates/agentdock-acp/src/client/permissions.rs` (per-session permission queue)
- `crates/agentdock-acp/src/client/events.rs` (`AcpEvent` and conversions)
- `crates/agentdock-acp/tests/common/mod.rs` (`mock_agent()` path helper, process-exists helper)
- `crates/agentdock-acp/tests/client_mock.rs`
- `docs/research/acp-sdk-s3-s5.md`

Modified: `crates/agentdock-acp/src/lib.rs`, `crates/agentdock-acp/Cargo.toml` (add `agentdock-process`). See §6 for how tests find the mock binary (a dev-dependency cannot provide another crate's binary path).

## 4. Public types and signatures

```rust
// crates/agentdock-acp/src/client/events.rs
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct AcpSessionId(pub String);          // agent's sessionId (contract: external_session_id)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PermissionTicket(pub u64);         // facade-local, monotonically increasing, never reused

#[derive(Debug, Clone, PartialEq)]
pub struct PermissionOptionView { pub option_id: String, pub name: String, pub kind: PermissionKind }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionKind { AllowOnce, AllowAlways, RejectOnce, RejectAlways, Unknown }

#[derive(Debug, Clone, PartialEq)]
pub enum AcpEvent {
    /// Raw `params.update` object of a session/update notification, re-serialized from the SDK type.
    SessionUpdate { session: AcpSessionId, update: serde_json::Value },
    PermissionRequested {
        ticket: PermissionTicket,
        session: AcpSessionId,
        tool_call: serde_json::Value,           // raw `toolCall`; untrusted agent data
        options: Vec<PermissionOptionView>,
    },
    Closed { reason: CloseReason },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseReason { ProcessExited { code: Option<i32> }, ProtocolError(String), LineTooLong, ShutDown }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason { EndTurn, MaxTokens, MaxTurnRequests, Refusal, Cancelled }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionDecision { Selected { option_id: String }, Cancelled }

// crates/agentdock-acp/src/client.rs
#[derive(Debug, Clone)]
pub struct InitializeInfo {
    pub protocol_version: u16,                   // always 1 on success
    pub agent_capabilities: serde_json::Value,   // raw; P2-2 strips _meta and derives features
    pub auth_methods: Vec<serde_json::Value>,
    pub agent_info: Option<serde_json::Value>,
    pub client_advertised: serde_json::Value,    // exactly what we sent as clientCapabilities
}

#[derive(Debug, Clone, Copy)]
pub struct AcpTimeouts { pub initialize: Duration, pub new_session: Duration, pub cancel_ack: Duration }
impl Default for AcpTimeouts { /* 30 s, 30 s, 10 s */ }

#[derive(Debug, thiserror::Error)]
pub enum AcpError {
    #[error("agent answered unsupported protocol version {0}")] UnsupportedProtocolVersion(u64),
    #[error("timed out waiting for {0}")] Timeout(&'static str),
    #[error("agent returned error {code}: {message}")] Agent { code: i64, message: String },
    #[error("connection closed")] Closed,
    #[error("unknown permission ticket")] UnknownTicket,
    #[error("option {0} was not offered")] OptionNotOffered(String),
    #[error(transparent)] Process(#[from] agentdock_process::ProcessError),
}

pub struct AcpConnection { /* SDK ConnectionTo<Agent>, AgentProcess, permission registry, closed flag */ }

impl AcpConnection {
    /// Spawns the agent (P3-2), wires framing (P3-1) into agent_client_protocol::Lines, runs initialize.
    /// Returns the connection and a bounded event receiver (capacity 1024; a full channel back-pressures the agent).
    pub async fn start(cmd: &agentdock_process::AgentCommand, t: AcpTimeouts)
        -> Result<(Self, InitializeInfo, tokio::sync::mpsc::Receiver<AcpEvent>), AcpError>;
    pub async fn new_session(&self, cwd: &std::path::Path) -> Result<AcpSessionId, AcpError>;
    /// Sends one text prompt and resolves at the end of the turn. Updates arrive on the event channel meanwhile.
    pub async fn prompt(&self, session: &AcpSessionId, text: &str) -> Result<StopReason, AcpError>;
    /// Sends session/cancel and answers every forwarded or queued permission of this session with `cancelled`.
    pub async fn cancel(&self, session: &AcpSessionId) -> Result<(), AcpError>;
    /// Must be called only AFTER the caller has persisted approval.resolved (contract acp-capabilities.md line 94).
    pub fn respond_permission(&self, ticket: PermissionTicket, decision: PermissionDecision) -> Result<(), AcpError>;
    /// Cancels open permissions, then AgentProcess::shutdown. Idempotent. NOTE: this answers `cancelled` without
    /// persisting anything; P3-5 calls it only after every recorded approval of the session is resolved (P3-5 §5 step 9),
    /// so the only tickets answered here are ones that were never recorded.
    pub async fn shutdown(&self) -> agentdock_process::ExitKind;
}
```

## 5. Implementation steps

1. Write the §6 tests.
2. `start`:
   1. `AgentProcess::spawn(cmd)`, `take_stdio()`.
   2. `framed_lines(stdout, DEFAULT_MAX_LINE_BYTES, stats)` and `line_sink(stdin)` → `agent_client_protocol::Lines::new(sink, stream)` (`Lines` implements `ConnectTo<R>`, SDK 5.5.1 `jsonrpc.rs` lines 7493–7496).
   3. Build `agent_client_protocol::Client.v1()` and register handlers:
      - `on_receive_notification(SessionNotification)`: `serde_json::to_value(&n.update)`, then `tx.send(AcpEvent::SessionUpdate{..}).await` (awaiting in this callback is deliberate backpressure: a full channel stops reading agent stdout).
      - `on_receive_request(RequestPermissionRequest)`: hand to `PermissionRegistry::enqueue(session, request, responder)` in `permissions.rs` and return `Ok(())` **immediately**; await nothing.
      - Other client methods (`fs/*`, `terminal/*`): answer `Error::method_not_found()`.
   4. `connect_with(lines, |cx| async move { ... })`: send `cx` (`ConnectionTo<Agent>`) back to `start`'s caller, then `std::future::pending::<()>()` to keep the connection until shutdown (a `tokio::sync::oneshot` ends it). Run the whole `connect_with` inside `tokio::spawn`; when it ends for any reason, emit `AcpEvent::Closed`.
   5. `cx.send_request(InitializeRequest::new(ProtocolVersion::V1).client_capabilities(...)).block_task()` wrapped in `tokio::time::timeout(t.initialize)`. **This runs on `start`'s own task, not inside an SDK callback**, so `block_task` is safe.
   6. Check the response version: not V1 → `shutdown()` and return `UnsupportedProtocolVersion`. Whether the SDK's v1 client rejects higher versions itself is unverified; the facade always checks.
3. `permissions.rs`:
   - `HashMap<AcpSessionId, SessionQueue { active: Option<(PermissionTicket, Responder, Vec<String>)>, waiting: VecDeque<...> }>` under a `std::sync::Mutex` (never held across await). Put the SDK `Responder` behind a small trait so tests can use a fake.
   - `enqueue`: no active request for that session → make it active and emit `PermissionRequested`; otherwise push to waiting without an event.
   - `respond(ticket, decision)`: unknown ticket → `UnknownTicket`; `Selected{option_id}` not among that request's options → `OptionNotOffered` (**do not answer the agent**; let the caller fix it); otherwise `responder.respond(RequestPermissionResponse::new(outcome))`, promote the first waiting request to active and emit its event.
   - `cancel_session(session)`: answer active and waiting with `RequestPermissionOutcome::Cancelled` and remove them.
   - Emit events outside the lock: decide what to send inside, release, then `try_send`; if the channel is full, `tokio::spawn(async move { tx.send(ev).await })` so nothing waits under a sync lock.
4. `prompt`: `cx.send_request(PromptRequest::new(session, vec![ContentBlock::Text(TextContent::new(text))])).block_task().await`; map `stop_reason` to `StopReason`. Unknown values → `AcpError::Agent{code: 0, message: "unknown stop reason"}`.
5. `cancel`: `cx.send_notification(CancelNotification::new(session))`, then `permissions.cancel_session(session)`.
6. `shutdown`: `cancel_session` for every session, end `connect_with`, then `AgentProcess::shutdown(ShutdownTimeouts::default())`.
7. S3/S5 record `docs/research/acp-sdk-s3-s5.md`: for the mock scenarios `bad-bytes`, `oversize`, `wrong-version`, `unknown-notification`, record the observed SDK behavior (connection kept or not, error type), and whether `_meta` survives re-serialization of an update through the SDK types. **If the SDK ends the connection because of an unknown notification**, that triggers ADR-0002 line 68's re-evaluation condition: stop and report; do not work around it.

## 6. Tests to write first

`tests/client_mock.rs`. Finding the mock binary: this crate cannot use another crate's `CARGO_BIN_EXE_*`, so `common::mock_agent()` runs `std::process::Command::new(env!("CARGO")).args(["build", "-p", "agentdock-mock-agent"])` once (guarded by `std::sync::OnceLock`), then builds the path from `CARGO_TARGET_DIR` (default: the workspace `target/`) + profile `debug` + `agentdock-mock-agent` (+ `.exe` under `cfg(windows)`).

| Test | Scenario | Expected |
| --- | --- | --- |
| `initialize_returns_raw_capabilities` | `echo` | `protocol_version == 1`; `agent_capabilities["loadSession"] == false`; `client_advertised["terminal"] == false` |
| `rejects_protocol_v2_and_kills_process` | `wrong-version` | `Err(UnsupportedProtocolVersion(2))`; process gone (P3-2 process-exists helper) |
| `initialize_timeout_is_reported` | `hang-init`, `AcpTimeouts{initialize: 2s,..}` | `Err(Timeout("initialize"))`; process gone |
| `exit_before_initialize_is_an_error` | `exit-early` | a clear error (`Closed` or similar), never a panic or a hang |
| `prompt_streams_updates_then_end_turn` | `echo` | 3 `SessionUpdate`s (`update["sessionUpdate"] == "agent_message_chunk"`) arrive before `prompt` returns `EndTurn` |
| `permission_is_forwarded_and_answered` | `permission` | `PermissionRequested` with an `AllowOnce` option; after `respond_permission(Selected{"allow-once"})`, text `approved`, `EndTurn` |
| `permission_option_must_be_offered` | `permission` | `respond_permission(Selected{"allow-always"})` → `Err(OptionNotOffered)`; a later correct `respond` still works |
| `ticket_cannot_be_replayed` | `permission` | second `respond_permission` with the same ticket → `Err(UnknownTicket)` |
| `cancel_answers_pending_permission_as_cancelled` | `permission` | after `PermissionRequested`, `cancel` → `prompt` returns `Cancelled`; `respond_permission` with that ticket → `UnknownTicket` |
| `cancel_stops_slow_stream` | `slow` | after 2 updates, `cancel`; `prompt` returns `Cancelled` within 2 s |
| `invalid_utf8_and_non_json_keep_connection` | `bad-bytes` | text `still connected after bad bytes`, `EndTurn`; a second prompt still succeeds |
| `oversized_line_closes_explicitly` | `oversize` | `prompt` returns `Err(Closed)`; channel gets `Closed{LineTooLong}` or `Closed{ProtocolError(_)}` (record which in the S3 doc) |
| `agent_exit_fails_pending_prompt` | `exit-mid-turn` | `prompt` returns `Err(Closed)` (X-5); channel gets `Closed{ProcessExited{code: Some(4)}}` |
| `unknown_notification_does_not_close` | `unknown-notification` | `prompt` returns `EndTurn` |
| `prompt_error_is_agent_error` | `prompt-error` | `Err(Agent{code: -32603, ..})` |
| `shutdown_reaps_stubborn_tree` | `stubborn` | read the grandchild pid after a prompt; it is gone within 5 s of `shutdown` |
| `shutdown_is_bounded_with_orphan_stdio` | `orphan-stdio` | `shutdown` finishes within 10 s |
| `second_permission_waits_for_first` (unit test in `permissions.rs`) | two `enqueue`s for one session with fake responders | only one event; the second is emitted after the first is answered |

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-acp --test client_mock -- --test-threads=1   # 17 pass
cargo test -p agentdock-acp client::permissions                      # queue unit test passes
```

Windows-only (CI `rust-windows`): the same suite must pass on `windows-latest` (process tree and pipe behavior differ). Link the run in the PR.

## 8. Spec references and porting sources

All contract line numbers refer to main `c9e33cf`.

- `docs/contracts/acp-capabilities.md` lines 17–30 (ACP v1 facts), lines 31–57 (detection algorithm), lines 80–98 (ACP → AgentDock event mapping; line 94: persist before answering a permission), lines 104–110 (v1 only, disconnect on mismatch).
- ADR-0003 open questions 8, 14 (one forwarded permission at a time).
- ADR-0002 line 15 (decision 1), lines 65–67 (S3, S5), line 68 (re-evaluation condition), line 174 (X-1 startup time), line 178 (X-5 tests to port).
- SDK 5.5.1: `src/concepts/ordering.rs` lines 47–60 (`block_task()` inside a callback deadlocks), `examples/yolo_one_shot_client.rs` (client builder, `connect_with`, permission responder usage), `src/jsonrpc.rs` line 7493 (`Lines: ConnectTo`).
- Behavior references (Node draft, scenarios only, do not port code): PR #25, SHA `7d41c9f1`, `apps/runtime/runtime.test.mjs` line 116 (v1 session and streaming), line 139 (permission held until explicit rejection; replay refused), line 167 (one-time approval selects only an explicitly offered `allow_once`), line 199 (cancel releases pending approvals as cancelled), line 219 (cancel transport failure invalidates approvals and ends the agent), lines 254, 279 (init timeout), 283, 304, 328; `acp-host.mjs` lines 13–23 (timeouts and limits).

## 9. Dependencies

| Crate | Version | Status |
| --- | --- | --- |
| `agent-client-protocol` | as pinned by P3-1 | decided by ADR-0002 |
| `agentdock-process` | workspace | P3-2 |
| `serde_json` | 1.0.154 | needs audit (reuse if P2-1 added it) |
| `tokio` (`sync`, `time`) | 1.54.1 | added by P3-1 |

## 10. Model tier

Strong model implements and reviews. The SDK dispatch loop has deadlock traps, and answering a permission at the wrong time lets the agent run a tool before AgentDock records the approval.

## 11. Common mistakes and pitfalls

- **Waiting for the user inside the permission callback**: the SDK dispatch loop stalls and stops processing other agent messages; a cancel can be sent but the agent's reply is never read. The callback only stores the responder and returns.
- `send_request(...).block_task().await` inside an `on_receive_*` callback: the SDK docs say it deadlocks (`concepts/ordering.rs`).
- Answering the agent before recording the approval: violates "persist approval.resolved first". `respond_permission`'s docs and the P3-5 / P4-3 call order must respect it.
- Choosing "allow" by option position or name: only use `kind` and the agent's `optionId` (the SDK example does the same; PR #25 line 167).
- Forgetting to answer pending permissions on cancel: ACP v1 requires `cancelled`, or the agent may wait forever.
- Classifying operations from `toolCall.title` or agent text: only P4-2 classifies, from parsed commands/paths (contract line 93).
- An unbounded event channel: flood output exhausts memory. Use the bounded channel so backpressure reaches the agent (ADR-0002 S3 "backpressure is applied in AgentDock's event bus").
- Awaiting while holding a `std::sync::Mutex`: may compile (inside `tokio::spawn`) but deadlocks. Only synchronous work under the lock.
- Assuming the SDK rejects `protocolVersion: 2`: unverified; the facade must check.

## 12. Reviewer checklist

- [ ] Is the SDK used only inside `agentdock-acp`, with only AgentDock types in the public API?
- [ ] Does the permission callback return without awaiting user input, and is `block_task` never called inside callbacks?
- [ ] Does `respond_permission` refuse options that were not offered and tickets already used?
- [ ] Does `cancel` answer active and queued permissions with `cancelled`?
- [ ] Is the event channel bounded, and is no lock held across `.await`?
- [ ] Does the S3/S5 doc record observed behavior, including whether `_meta` survives?
