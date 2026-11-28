# Spikes S3 and S5: SDK behavior with a hostile agent, backpressure, and vendor extensions

> **繁中摘要**：ADR-0002 spike S3、S5 的實測紀錄，對應任務包 P3-4。用 `agentdock-mock-agent` 的 `bad-bytes`、`oversize`、`wrong-version`、`unknown-notification`（另加 `flood`）情境，透過 `AcpConnection` 觀察 SDK `agent-client-protocol =5.6.1` 的行為。結論：無效 UTF-8 與非 JSON 行不會斷線；超長行明確斷線並回報 `LineTooLong`；SDK 的 v1 client 自己就會拒絕 `protocolVersion: 2`，facade 仍另外檢查並從原始回應取版本號；未知通知不會斷線（SDK 直接忽略）；update 上的 `_meta` 經 SDK 型別重新序列化後仍保留。**重要發現**：SDK 內部的佇列是無界的，只在 callback 裡 await 有界 channel **不會**讓 SDK 停止讀 agent stdout（實測 10,003 行全被讀進記憶體），所以 facade 在 stdout 串流加了「channel 有空位才讀下一行」的閘門，實測降到 1,072 行。沒有觸發 ADR-0002 line 68 的重新評估條件。

Status: record of observations for packet [P3-4](../tasks/P3-4-acp-client-facade.md) / [Issue #6](https://github.com/ChiJiun/agentdock/issues/6) / [ADR-0002](../decisions/0002-source-reuse.md) spikes S3 and S5. Date: 2026-11-29.

| Item | Value |
| --- | --- |
| SDK | `agent-client-protocol =5.6.1` (`default-features = false`), schema crate `agent-client-protocol-schema 1.22.0` |
| Client | `agentdock_acp::AcpConnection` (`crates/agentdock-acp/src/client.rs`): `Client.v1()` over `Lines`, framing from P3-1 (`DEFAULT_MAX_LINE_BYTES` = 16 MiB) |
| Agent | `agentdock-mock-agent` (P3-3), scenarios from its README |
| Machine | Windows 11 Pro 10.0.26300, Rust 1.91.1, debug build. Linux and the Windows CI runner run the same tests (`rust-linux`, `rust-windows`); the PR links the run |
| Tests | `crates/agentdock-acp/tests/client_mock.rs` |

"Observed" below means seen in a test run on this machine (the SDK error values were printed by a temporary `eprintln!` that is not committed). "Source" means read from the published crate source in the local cargo registry and not exercised by a test.

## S3: hostile agent

| Scenario | Connection | What the SDK / facade did | Test |
| --- | --- | --- | --- |
| `bad-bytes`: line `FF FE C3 28`, then `this is not json`, then a text update and `end_turn` | **kept** (observed) | Framing replaces the invalid bytes with U+FFFD (P3-1), so the SDK gets two non-JSON lines. Source (`jsonrpc/transport_actor.rs` lines 9–45, `incoming_actor.rs` line 406): each becomes `TransportFrame::Malformed` and is answered with a JSON-RPC `-32700` parse error whose `data.line` echoes the line back to the agent; the connection continues. The text update and `end_turn` arrive, and a second prompt succeeds (observed) | `invalid_utf8_and_non_json_keep_connection` |
| `oversize`: 64 MiB of `A` without a newline | **closed** (observed) | Framing fails at 16 MiB + at most 8 KiB read and yields `io::Error(InvalidData)`. The SDK ends the connection with a transport error: `Error { code: -32603, message: "Internal error", data: "agent sent a line longer than 16777216 bytes; connection ended" }` (observed). The pending `session/prompt` fails as connection-terminated → `AcpError::Closed`; the facade reports `Closed { reason: LineTooLong }` (it recognizes the `FrameError` inside the stream error, so it never reports `ProtocolError` for this case). Known P3-1 behavior: complete lines in the same 8 KiB read as the start of the oversized line are dropped with it although `FramingStats.lines` already counted them, so `framing_stats()` can be ahead of what the SDK received; the facade does not use the counters to decide anything | `oversized_line_closes_explicitly` |
| `wrong-version`: `initialize` answers `protocolVersion: 2` | closed by the facade | **The SDK v1 client rejects it itself** (the packet left this unverified): `block_task` returns `Error { code: -32600, message: "Invalid request", data: "required ACP protocol version 1 but peer negotiated 2; use a matching implementation for the negotiated protocol version" }` (observed; source `jsonrpc/protocol_compat.rs` lines 866–928, 1276–1285). The version number is not a field of that error, so the facade copies the raw `initialize` response from the wire and returns `UnsupportedProtocolVersion(2)`; it also checks the version on the success path. Then the process tree is shut down; the unique mock image is gone within 5 s (observed) | `rejects_protocol_v2_and_kills_process` |
| `unknown-notification`: `_vendor/ping` notification before a normal reply | **kept** (observed) | No handler claims it; the SDK ignores unhandled notifications without an answer (source `incoming_actor.rs` `reject_unhandled`, lines 623–648). The prompt ends `end_turn`, a second prompt succeeds (observed). ADR-0002 line 68's condition ("the SDK ends the connection because of an unknown notification") is **not** met | `unknown_notification_does_not_close` |
| `exit-early` before `initialize` | closed | `block_task` fails with `Error { code: -32603, message: "Incoming transport closed", data: {reason: "incoming_transport_closed", method: "initialize"} }` (observed) → `AcpError::Closed` | `exit_before_initialize_is_an_error` |
| `exit-mid-turn` | closed | The `partial reply` update is still delivered, then the pending prompt fails → `AcpError::Closed`, event `Closed { ProcessExited { code: Some(4) } }` (observed) | `agent_exit_fails_pending_prompt` |

### Where AgentDock enforces limits

- Transport: one line ≤ 16 MiB (P3-1 framing). Larger → connection ends, `CloseReason::LineTooLong`.
- Events: `AcpConnection::start` returns a bounded channel of `EVENT_CHANNEL_CAPACITY` = 1024 events. Per-message and per-turn limits (1 MiB, 8 MiB, 20,000 items) are P3-5's.
- Startup: `initialize` ≤ 30 s by default (`AcpTimeouts`).

### SDK channels are unbounded; backpressure needed a read gate

Source: `Builder::into_connection_and_future` creates its outgoing, task and dynamic-handler queues with `futures::channel::mpsc::unbounded()` (`jsonrpc.rs` lines 1761–1763); the `Lines` transport is a `Channel::duplex()` of two unbounded queues (`jsonrpc.rs` lines 7692–7730); and `transport_incoming_lines_actor` pushes **every** line it reads into that queue with `unbounded_send` (`transport_actor.rs` lines 268–282), independently of the dispatch loop.

Consequence: the packet's plan (await the bounded channel inside the notification callback, P3-4 §5 step 2.3) only blocks the dispatch loop; the transport task keeps reading agent stdout into the unbounded queue. Observed with the `flood` scenario (10,000 updates) and nobody draining the event channel for 3 s: `framing_stats().lines` was **10,003** (every line read into memory).

Fix in the facade (`client.rs`, `start`): the stdout stream passed to `Lines` waits for free room in the event channel (`Sender::reserve`, permit released at once) before it yields each line. Same run with the gate: **1,072** lines read (1,024 queued events plus lines already framed from the last 8 KiB read); after draining, all 10,000 updates and `end_turn` arrived. Test: `full_event_channel_stops_reading_agent_stdout` (asserts fewer than 2,048).

Residual: the gate checks room before each line, so the SDK queue can still hold the lines read while the channel had room but before the dispatch loop delivered them, plus responses and unknown notifications that never become events. It stops growing once the channel is full, but it is not a hard bound in bytes. Callers must drain the receiver while they await `prompt` (documented on `AcpConnection`).

## S5: vendor extensions

| Question | Result |
| --- | --- |
| Does `_meta` on a `session/update` survive re-serialization through the SDK type? | **Yes** (observed). `unknown-notification` sends `update: {sessionUpdate: "agent_message_chunk", content: {...}, _meta: {vendor: "agentdock-mock"}}`; `AcpEvent::SessionUpdate.update["_meta"]["vendor"] == "agentdock-mock"` |
| Do unknown notifications (`_vendor/ping`, Claude `sdk_message`, Grok extension methods) reach AgentDock? | **No, not with this facade.** The SDK ignores notifications no handler claims (above). The facade registers typed handlers only and `AcpEvent` (P3-4 §4) has no variant for them, so they are dropped. ADR-0002 S5 allows "or through an untyped handler": the SDK has `Builder::on_receive_dispatch` (`jsonrpc.rs` line 1270), which could forward them. **Not verified by a test**; the v1 contract does not need these messages (`acp-capabilities.md` mapping table). Whether alpha needs them is a follow-up decision, not a reason to work around the SDK |
| `sessionUpdate` kinds the schema does not know | Source only: `SessionUpdate` (schema 1.22.0, `v1/client.rs`) is a tagged enum without a fallback variant, so such a notification fails to parse as `SessionNotification` and no event is emitted. For a message with a `sessionId` the client role's default handler asks the SDK to park it for a later dynamic handler (`role/acp.rs` lines 287–317, at most 1024 parked messages), which this facade never installs. Every kind in the v1 contract parses today; a future kind would be silently missing. **Not verified by a test** (the mock has no such scenario) |
| Raw `agentCapabilities` | The facade returns the object exactly as received (copied from the wire, not re-serialized), so unknown capability fields and `_meta` reach P2-2, which strips `_meta` |
| `session/load` / `resume` only when advertised | Not exercised: P3-4 implements neither (alpha non-goal). P3-5 / P3-6 own it |

## Conclusion

- S3: the facade framing keeps the connection alive for invalid UTF-8 and non-JSON lines, ends it explicitly for an oversized line, and refuses protocol v2. The SDK's internal queues are unbounded as documented; AgentDock's event channel is bounded, and backpressure reaches the agent only because of the facade's read gate.
- S5: `_meta` survives; unknown notifications and unknown update kinds do not reach AgentDock through this facade (they do not end the connection either).
- ADR-0002 line 68 re-evaluation is not triggered: the SDK ends no connection because of an unknown notification and rewrites none of the messages AgentDock uses. The dropped vendor notifications are reachable through the SDK's untyped handler if a later packet needs them.
- Not covered here: real Claude Code / Codex adapters (P3-6), `session/load` / resume.
