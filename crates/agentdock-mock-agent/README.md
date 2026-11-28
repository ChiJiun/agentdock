# agentdock-mock-agent

> **繁中摘要**：測試用 ACP agent，直接讀寫 NDJSON（每行一則 JSON-RPC 2.0），**不使用 ACP SDK**，因為惡意情境要故意違反協定。以 `--scenario <名稱>` 選擇行為，讓 P3-4、P3-5、P4-3、P8 的測試不需要真實 agent 或網路。只供測試，不隨產品發行。

Test-only ACP v1 agent (packet P3-3, issue #6). It speaks raw NDJSON on stdin/stdout, with no ACP SDK, because the hostile scenarios must break the protocol on purpose (wrong version, invalid UTF-8, oversized lines). Dependencies: `serde_json` only; no other AgentDock crate.

```text
agentdock-mock-agent [--scenario <name>] [--arg <text>] [--nonce <hex>]
```

- Default scenario: `echo`. An unknown scenario prints `unknown scenario` to stderr and exits with code 2 (so do unknown arguments).
- `--arg` is read only by `permission-fault` and `scripted`; `--nonce` only by `scripted`. Every other scenario ignores them.
- Wire format: field names are camelCase (`sessionId`, `stopReason`, `toolCallId`, `sessionUpdate`), enum values are snake_case (`agent_message_chunk`, `allow_once`, `end_turn`). Names were checked against `agent-client-protocol-schema` 1.21.2.
- Every sleep is bounded (600 s). A write to a closed stdout pipe ends the process with exit code 0.
- Requests the scenario does not handle are answered with JSON-RPC error `-32601`. Lines that do not parse as JSON are ignored. EOF on stdin ends the process (exit 0), except `stubborn`.
- The `scripted` edit flow writes `edited-by-mock` to the path named in the prompt. This is a test tool: never point it at real files.

## Scenarios

Each row lists only what differs from `echo`.

| Scenario | Behavior | Used by |
| --- | --- | --- |
| `echo` | `initialize` answers v1; `session/new` answers `mock-session-1`; `session/prompt` splits the first text block into 3 `agent_message_chunk`s, then answers `end_turn` | P3-4, P3-5 |
| `permission` | on prompt: `tool_call("call_1","Run tests","cargo test")` → `request_permission("mock-perm-1","call_1",…)`, then wait: `selected allow-once` → `tool_call_update` `completed` + text `approved` + `end_turn`; `selected reject-once` → `failed` + text `denied` + `end_turn`; `cancelled` (or `session/cancel`) → `cancelled` | P3-4, P4-3 |
| `slow` | on prompt: one text chunk every 200 ms, 50 total; on `session/cancel` stop at once and answer `cancelled` | cancel tests |
| `hang-init` | never answers `initialize` | init timeout |
| `wrong-version` | `initialize` answers `protocolVersion: 2` | protocol version refusal (ADR-0002 S3) |
| `exit-early` | `exit(3)` immediately | startup failure |
| `exit-mid-turn` | on prompt: one text chunk, then `exit(4)` without answering | X-5: pending requests get connection closed |
| `early-update` | sends a text chunk right after answering `session/new` | P3-5 |
| `bad-bytes` | on prompt: a line of invalid UTF-8 (`FF FE C3 28 0A`), a line `this is not json`, text `still connected after bad bytes`, `end_turn` | P3-1 / P3-4 |
| `oversize` | on prompt: 64 MiB of `A` (1 MiB per write) without newline, then sleep | oversized line (ADR-0002 S3) |
| `unknown-notification` | on prompt: `_vendor/ping` notification, a text update carrying `_meta`, then a normal `echo` reply | ADR-0002 S5 |
| `prompt-error` | prompt answers JSON-RPC error `-32603 boom` | error handling |
| `stubborn` | ignores stdin EOF (sleeps 600 s after the main loop ends); on prompt starts itself with `--scenario sleep-forever` as a grandchild (stdio null) and sends text `grandchild pid <pid>`, then `end_turn` | P3-2 / P3-4 process tree |
| `orphan-stdio` | on prompt: starts a grandchild that **inherits stdout**, sends text `grandchild pid <pid>`, answers `end_turn`, exits 0 after 100 ms | bounded shutdown |
| `sleep-forever` | never reads stdin, sleeps 600 s | grandchild of `stubborn` / `orphan-stdio` |
| `flood` | on prompt: 10,000 text chunks of 10 characters, then `end_turn` | P3-5 coalescing and backpressure |
| `secret-echo` | on prompt: text `token ghp_` + 36 × `0` + ` end` (fake token) | P3-5 redaction |
| `auth-required` | `initialize` answers `authMethods: [{"id":"mock-login","name":"Mock login"}]`; `session/new` answers error `-32000 Authentication required` | ADR-0002 S4, P3-6 |
| `permission-two` | on prompt: `tool_call` `call_1` and `call_2`, then **immediately** `request_permission` `mock-perm-1` and `mock-perm-2`, then waits for both answers (any order). Text `perm1=<optionId or cancelled> perm2=<optionId or cancelled>`; if either is `cancelled` the result is `cancelled`, else `end_turn`. `session/cancel` first → `cancelled` | P3-4 queue, P4-3 §5A C2, C5 |
| `permission-fault` | `--arg exit` (default) or `--arg oversize`. On prompt: `tool_call`, `request_permission("mock-perm-1",…)`, then after 300 ms: `exit(5)` without answering, or the `oversize` behavior | P4-3 §5A A2, A4 |
| `scripted` | prompt-driven (optional `--arg <verdict JSON text>` and `--nonce <16 hex>`); applies the first matching directive below, none → `echo` | P4-3 §5A C3, C4, H3; P8-3 |

### `scripted` directives

Checked in this order; each directive is a whole line `NAME: value` of the first text block of the prompt (matched at the start of the line, case-sensitively).

| Directive | Behavior |
| --- | --- |
| `REVIEWER-EDIT-PATH: <path>` together with a line `Verdict nonce: <hex>` | reviewer-side edit: behaves as `EDIT-PATH` (prints no verdict) |
| `Verdict nonce: <hex>` and `--arg` given | one text chunk `<<<AGENTDOCK-VERDICT {n}>>>` + newline + the `--arg` text (forwarded verbatim, never parsed) + newline + `<<<END-AGENTDOCK-VERDICT {n}>>>`, then `end_turn`; `{n}` is `--nonce` when given, else the nonce from the prompt line |
| `EDIT-PATH: <path>` | `tool_call("call_1","Edit file",…)`, then `request_permission_edit("mock-perm-1","call_1","Edit file",<path>)`. `selected allow-once` → writes `edited-by-mock` to `<path>`, `completed`, text `approved`, `end_turn`; `selected reject-once` → `failed`, text `denied`, `end_turn`; `cancelled` → `cancelled`. Optional line `ON-CANCEL: exit\|oversize\|ignore\|end`: the permission answer is then **ignored** and the mock waits for `session/cancel`; then `exit` → `exit(6)` without answering; `oversize` → the `oversize` behavior; `ignore` → never answers (sleeps at most 600 s); `end` → answers `cancelled` |
| `SAY: <text>` | text chunk `<text>`, then `end_turn` |

## Tests

```bash
cargo test -p agentdock-mock-agent
cargo run -q -p agentdock-mock-agent -- --scenario nope; echo "exit=$?"   # exit=2
```

`tests/scenarios.rs` starts the binary with `CARGO_BIN_EXE_agentdock-mock-agent` and bounds every read.
