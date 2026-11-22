# P3-3: Mock ACP agent for tests (normal and hostile scenarios)

> **繁中摘要**：新增測試用執行檔 `agentdock-mock-agent`，以 `--scenario <名稱>` 選擇行為（echo、permission、slow、hang-init、wrong-version、bad-bytes、oversize、stubborn、orphan-stdio、flood、secret-echo、auth-required 等），讓 P3-4、P3-5、P4-3、P8 的測試不需要真實 agent 或網路。直接讀寫 NDJSON、**不使用 ACP SDK**（惡意情境要故意違反協定），只用 std 執行緒與 `serde_json`。模型等級：一般模型可。

Issue: #6 | Gate (#51): G2 (reproducible ACP tests in CI), G8 (interruption, cancel, error cases) | Model tier: **standard model**

## 1. Goal and non-goals

Goal: a binary `agentdock-mock-agent` whose behavior is chosen with `--scenario <name>`, so P3-4, P3-5, P4-3 and P8 tests need **no real agent and no network**.

- Reads and writes NDJSON directly (one JSON-RPC 2.0 message per line), **without the ACP SDK**: hostile scenarios must break the protocol on purpose (wrong version, bad bytes, oversized lines), which the SDK would prevent (PR #25 `hostile-agent.mjs` lines 1–4 give the same reason).
- Only std threads and `serde_json`: one thread reads stdin and sends messages through `std::sync::mpsc`; the main thread runs the scenario.

Non-goals: real agent compatibility (P3-6); any model calls.

## 2. Prerequisites and parallel work

- Prerequisites: P1-1.
- Parallel: P3-1, P3-2, P2-*.

## 3. Files

New:

- `crates/agentdock-mock-agent/Cargo.toml` (`publish = false`, `[[bin]] name = "agentdock-mock-agent"`)
- `crates/agentdock-mock-agent/src/main.rs` (argument parsing, main loop)
- `crates/agentdock-mock-agent/src/wire.rs` (message builders)
- `crates/agentdock-mock-agent/src/scenarios.rs`
- `crates/agentdock-mock-agent/tests/scenarios.rs`
- `crates/agentdock-mock-agent/README.md` (scenario table, same as §4)

Modified: root `Cargo.toml` (members).

## 4. Interface

Command line: `agentdock-mock-agent [--scenario <name>]`, default `echo`. Unknown scenario: print `unknown scenario` to stderr and `exit(2)`.

ACP v1 wire format (method names checked against `agent-client-protocol-schema` 1.21.2 `src/v1/agent.rs` lines 6846–6869 and `src/v1/client.rs` lines 4849–4851; permission outcome shape against `src/v1/client.rs` lines 3029–3045):

```rust
// crates/agentdock-mock-agent/src/wire.rs
use serde_json::{json, Value};
pub const SESSION_ID: &str = "mock-session-1";

pub fn result(id: &Value, result: Value) -> Value { json!({"jsonrpc":"2.0","id":id,"result":result}) }
pub fn error(id: &Value, code: i64, message: &str) -> Value { json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}) }
pub fn initialize_result(protocol_version: u64) -> Value {
    json!({"protocolVersion": protocol_version, "agentCapabilities": {"loadSession": false}, "authMethods": []})
}
pub fn new_session_result() -> Value { json!({"sessionId": SESSION_ID}) }
pub fn prompt_result(stop_reason: &str) -> Value { json!({"stopReason": stop_reason}) } // "end_turn" | "cancelled"
pub fn text_chunk(text: &str) -> Value {
    json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":SESSION_ID,
        "update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}}})
}
pub fn tool_call(id: &str, title: &str, command: &str) -> Value {
    json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":SESSION_ID,
        "update":{"sessionUpdate":"tool_call","toolCallId":id,"title":title,"kind":"execute","status":"pending",
                  "rawInput":{"command":command}}}})
}
pub fn tool_call_done(id: &str, status: &str) -> Value { // "completed" | "failed"
    json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":SESSION_ID,
        "update":{"sessionUpdate":"tool_call_update","toolCallId":id,"status":status}}})
}
/// Agent -> client request. `req_id` must not collide with client ids; use strings "mock-perm-<n>".
pub fn request_permission(req_id: &str, tool_call_id: &str, title: &str) -> Value {
    json!({"jsonrpc":"2.0","id":req_id,"method":"session/request_permission","params":{"sessionId":SESSION_ID,
        "toolCall":{"toolCallId":tool_call_id,"title":title},
        "options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},
                   {"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}})
}
```

Scenarios (each lists only what differs from `echo`):

| Scenario | Behavior | Used by |
| --- | --- | --- |
| `echo` | `initialize` answers v1; `session/new` answers `SESSION_ID`; `session/prompt` splits the first text block into 3 `agent_message_chunk`s, then answers `end_turn` | P3-4, P3-5 |
| `permission` | on prompt: `tool_call("call_1","Run tests","cargo test")` → `request_permission("mock-perm-1","call_1",...)`, then wait: `selected allow-once` → `tool_call_done("completed")` + text `approved` + `end_turn`; `selected reject-once` → `tool_call_done("failed")` + text `denied` + `end_turn`; `cancelled` → `cancelled` | P3-4, P4-3 |
| `slow` | on prompt: one text chunk every 200 ms, 50 total; on `session/cancel` stop at once and answer `cancelled` | cancel tests |
| `hang-init` | never answers `initialize` | init timeout |
| `wrong-version` | `initialize` answers `protocolVersion: 2` | protocol version refusal (ADR-0002 S3) |
| `exit-early` | `exit(3)` immediately | startup failure |
| `exit-mid-turn` | on prompt: one text chunk, then `exit(4)` without answering | X-5: pending requests get connection closed |
| `early-update` | sends a text chunk **right after** answering `session/new` (the client may not have stored the session id yet) | P3-5 |
| `bad-bytes` | on prompt: a line of invalid UTF-8 (`FF FE C3 28 0A`), a line `this is not json`, normal text `still connected after bad bytes`, `end_turn` | P3-1 / P3-4 |
| `oversize` | on prompt: 64 MiB of `A` (1 MiB per write) without newline, then sleep | oversized line (ADR-0002 S3) |
| `unknown-notification` | on prompt: first `{"jsonrpc":"2.0","method":"_vendor/ping","params":{"x":1}}` and a text update carrying `_meta`, then a normal reply | ADR-0002 S5 (unknown notifications must not break the connection) |
| `prompt-error` | prompt answers JSON-RPC error `-32603 boom` | error handling |
| `stubborn` | ignores stdin EOF (sleeps 600 s after the main loop ends); on prompt starts itself with `--scenario sleep-forever` as a grandchild and sends text `grandchild pid <pid>` | P3-2 / P3-4 process tree |
| `orphan-stdio` | on prompt: starts a grandchild that **inherits stdout**, answers `end_turn`, exits 0 after 100 ms | bounded shutdown (PR #25 line 328) |
| `sleep-forever` | never reads stdin, sleeps 600 s | grandchild of `stubborn` / `orphan-stdio` |
| `flood` | on prompt: 10,000 text chunks of 10 characters, then `end_turn` | P3-5 coalescing and backpressure |
| `secret-echo` | on prompt: text `token ghp_000000000000000000000000000000000000 end` | P3-5 redaction |
| `auth-required` | `initialize` answers `authMethods: [{"id":"mock-login","name":"Mock login"}]`; `session/new` answers error `-32000 Authentication required` | ADR-0002 S4, P3-6 |

## 5. Implementation steps

1. Write the §6 tests.
2. `main.rs`:
   - Parse `--scenario` with `std::env::args` only (no clap).
   - Reader thread: `BufReader::new(stdin).split(b'\n')`, each segment `serde_json::from_slice`; ignore lines that fail to parse (the mock does not test its own parser); on EOF send `Msg::Eof`.
   - Writer: `fn send(v: &Value)` locks `stdout`, writes `serde_json::to_vec(v)` + `b"\n"`, then `flush()`. A failed write (client closed the pipe) → `exit(0)`.
3. Main loop: dispatch on `method`; requests (with `id` and `method`) are always answered unless the scenario says otherwise; a message with `id` and no `method` is a client response to a mock request and goes to the waiting scenario logic.
4. `slow` and `permission` must handle `session/cancel` while streaming: check `mpsc::Receiver::recv_timeout(200ms)` between chunks.
5. Grandchildren: `std::process::Command::new(std::env::current_exe()?)` with `--scenario sleep-forever`; `stubborn` uses `Stdio::null()`, `orphan-stdio` passes `Stdio::inherit()` for stdout.
6. Every sleep is bounded (600 s) so a failing test never leaves a permanent process.

## 6. Tests to write first

`tests/scenarios.rs` starts the binary with `std::process::Command::new(env!("CARGO_BIN_EXE_agentdock-mock-agent"))`, writes NDJSON and reads it back, and does **not** depend on `agentdock-acp` (no dependency cycle). Helpers:

```rust
fn start(scenario: &str) -> (std::process::Child, std::io::BufReader<std::process::ChildStdout>) { /* piped stdin/stdout, stderr null */ }
fn send(child: &mut std::process::Child, v: serde_json::Value) { /* write line + flush */ }
fn read_json(r: &mut impl std::io::BufRead) -> serde_json::Value { /* read_until(b'\n'), parse; fail after 5 s via a helper thread */ }
const INIT: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}"#;
const NEW: &str = r#"{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}}"#;
fn prompt(id: u64, text: &str) -> serde_json::Value { /* session/prompt with sessionId mock-session-1 */ }
```

| Test | Expected |
| --- | --- |
| `echo_streams_three_chunks_then_end_turn` | 3 `agent_message_chunk`s concatenate to the prompt text; last `result.stopReason == "end_turn"` |
| `permission_allow_once_completes_tool_call` | receives `session/request_permission` (`id == "mock-perm-1"`, options include `allow_once` and `reject_once`); after replying `{"outcome":{"outcome":"selected","optionId":"allow-once"}}` sees `tool_call_update` `completed` and text `approved` |
| `permission_reject_marks_failed` | reply `reject-once` → `failed` and `denied` |
| `permission_cancelled_returns_cancelled` | reply `{"outcome":{"outcome":"cancelled"}}` → prompt result `cancelled` |
| `slow_stops_on_cancel` | after the 2nd chunk send `session/cancel`; `stopReason: "cancelled"` within 1 s; fewer than 50 chunks total |
| `wrong_version_reports_v2` | `initialize` result `protocolVersion == 2` |
| `exit_early_exits_with_3` | `wait()` exit code 3 |
| `exit_mid_turn_never_answers_prompt` | one text chunk, then EOF; exit code 4 |
| `bad_bytes_emits_invalid_utf8_line` | first raw line bytes are `FF FE C3 28`; later `still connected after bad bytes` |
| `unknown_notification_is_sent_before_reply` | `_vendor/ping` then the normal reply, in order |
| `auth_required_errors_on_new_session` | `initialize` has `authMethods[0].id == "mock-login"`; `session/new` is error `-32000` |
| `unknown_scenario_exits_2` | exit code 2 |
| `remaining_scenarios_start` | `oversize`, `stubborn`, `orphan-stdio`, `flood`, `secret-echo` each start and produce output after a prompt (deeper tests live in P3-1, P3-2/P3-4, P3-5); kill each child at the end |

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-mock-agent                           # 13 pass
cargo run -q -p agentdock-mock-agent -- --scenario nope; echo "exit=$?"   # exit=2
```

No Windows-only items (the binary is cross-platform; CI `rust-windows` runs the same tests).

## 8. Spec references and porting sources

- ADR-0002 line 65 (S3 mock scenarios), line 66 (S4), line 67 (S5), line 178 (X-5 transport tests to port).
- Behavior references (Node draft, scenarios only, do not port code): PR #25, SHA `7d41c9f1`, `apps/runtime/test-fixtures/hostile-agent.mjs` (whole file: `exit-early`, `hang-init`, `wrong-version`, `early-update`, `bad-bytes`, `oversize`, `stubborn`, `orphan-stdio`, `prompt-error`), `apps/runtime/mock-agent.mjs` lines 14–52 (`permission` and cancel behavior).
- ACP v1 schema: `agent-client-protocol-schema` 1.21.2 (the exact version SDK 5.5.1 depends on).

## 9. Dependencies

| Crate | Version | Status |
| --- | --- | --- |
| `serde_json` | 1.0.154 | needs audit (reuse if P2-1 added it) |

## 10. Model tier

Standard model.

## 11. Common mistakes and pitfalls

- Forgetting `flush()`: piped stdout is buffered; the client never sees the message and it looks like a timeout.
- Implementing the mock with the SDK: cannot send `protocolVersion: 2`, bad bytes or oversized lines; deliberately not used.
- snake_case JSON field names: the ACP wire format is camelCase (`sessionId`, `stopReason`, `toolCallId`, `sessionUpdate`); only enum values are snake_case (`agent_message_chunk`, `allow_once`, `end_turn`). AgentDock's own event JSON is all snake_case; do not mix them.
- Numeric ids for mock→client requests: can collide with client ids. Use strings `mock-perm-<n>`.
- Reading stdout in tests without a timeout: a failure hangs forever. Bound every read.
- Unbounded sleeps in grandchildren: a failed test leaves them running.

## 12. Reviewer checklist

- [ ] Does the crate avoid depending on the ACP SDK and on `agentdock-acp`?
- [ ] Is every write flushed, and does a broken pipe exit cleanly?
- [ ] Are wire field names camelCase and enum values snake_case as in the schema?
- [ ] Are all sleeps bounded and all test reads time-limited?
- [ ] Does each scenario in the table exist and match its description?
