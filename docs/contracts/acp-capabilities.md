# ACP adapter capability detection and compatibility

Status: Proposed with [ADR-0003](../decisions/0003-task-session-event-contracts.md). Schema: `CapabilitySnapshot`, `LaunchMethod`, `Provenance`.

## Verified sources

Field and method names below were checked against the official artifacts, not written from memory:

| Source | Revision checked (2026-11-17) | What was read |
| --- | --- | --- |
| [agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol) | `4aab69b4e6bcb53965ff5b1141d2f04a62a25c6c` (2026-11-16) | `schema/v1/schema.json` and `schema/v1/meta.json` (`meta.json` only says `"version": 1`; the v1 schema release `1.32.0` comes from `schema/v1/Cargo.toml` and `CHANGELOG.md`), `schema/v2/schema.json` + `meta.json` (`2.0.0-alpha.16`), `agent-client-protocol-schema/src/v1/agent.rs` (Rust crate `agent-client-protocol-schema` `1.18.0`), `docs/announcements/acp-v2-draft.mdx` |
| [ACP v1 Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup) | page as served on 2026-11-17 | semantics of `session/load`, `session/resume`, `session/close` |
| [ACP Rust SDK](https://github.com/agentclientprotocol/rust-sdk) | `6a4a95cabed1b5307651a19771c20b91bb6566ea` (same commit as `docs/sources.md`) | workspace `Cargo.toml` (crate `agent-client-protocol` `5.3.0`, pins `agent-client-protocol-schema = "=1.18.0"`), `README.md` (`Client.v1()` / `.v2()`, `agent_client_protocol::v1` / `::v2`, `unstable_protocol_v2` feature) |

Re-verify these before implementing #4/#M2; ACP v1 keeps adding optional capabilities (it is at schema 1.32 with many `unstable_*` features).

## ACP v1 facts the contract depends on

- `initialize` request: `protocolVersion` (uint16), `clientCapabilities`, `clientInfo?`. Response: `protocolVersion`, `agentCapabilities`, `authMethods`, `agentInfo?`. If the agent answers a version the client does not support, the client should disconnect.
- `agentCapabilities` (v1): `loadSession` (bool, default false), `promptCapabilities {image, audio, embeddedContext}`, `mcpCapabilities {http, sse}`, `sessionCapabilities {list, delete, additionalDirectories, systemPrompt, resume, close}` (each optional object; omitted or `null` = not supported, `{}` = supported), `auth {logout}`.
- Baseline every v1 agent must support: `session/new`, `session/prompt`, `session/cancel`, `session/update`.
- `session/load` (only if `loadSession: true`): the agent **replays the whole conversation** as `session/update` notifications and responds only after the replay. Live-only `notice` updates are not replayed.
- `session/resume` (only if `sessionCapabilities.resume`): restores context **without** replaying history.
- `session/close` (only if `sessionCapabilities.close`): cancels ongoing work and frees resources; idempotent — clients should treat error `-32002` as a successful close.
- Clients MUST NOT call `session/load`, `session/resume`, `session/close` (or send `additionalDirectories` / `systemPrompt`) unless advertised.
- `session/prompt` response: `stopReason` ∈ `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`. After `session/cancel` the agent MUST return `cancelled`, and the client MUST answer every pending `session/request_permission` with outcome `cancelled`.
- `session/request_permission`: `sessionId`, `toolCall`, `options[] {optionId, name, kind}`; `kind` ∈ `allow_once`, `allow_always`, `reject_once`, `reject_always`; outcome `selected {optionId}` or `cancelled`.
- `usage_update` session update: `used`, `size` (context window tokens), optional `cost {amount, currency}` where `currency` may be an ISO 4217 code or another unit such as `credits`. There is no quota or remaining-allowance field in ACP v1.
- `McpServerStdio.env` and `McpServerHttp.headers` carry secrets; ToolCall `rawInput` / `rawOutput` are arbitrary agent data.

## Detection algorithm

For every agent **process** (initial launch and every reattach):

1. Spawn with a sanitized environment (allowlist) in the task worktree.
2. Send `initialize` with `protocolVersion: 1` (or `2` only when the adapter's `acp_v2_draft` flag is on — see below) and AgentDock's `clientCapabilities`.
3. Record `session.capabilities_detected` with a `CapabilitySnapshot` **before** using any optional method:
   - `acp_agent_capabilities`: the raw object minus every `_meta` key (diagnostics only; logic never reads it).
   - `features`: booleans derived *only* from advertised fields (table below). Missing, `null`, malformed → `false`. Never inferred from `agentInfo.name`, adapter id, version strings or documentation.
   - `client_advertised`: what AgentDock offered (`fs`, `terminal`, ...).
   - `unstable_opt_ins`: unstable ACP features explicitly enabled for this adapter in settings (empty by default; no unstable feature is required by this contract).
4. Gate every optional call on the snapshot of the **current** process. A snapshot from a previous process only decides whether a reattach is worth *attempting*; the new process's snapshot decides whether it is allowed.

| `features.*` | ACP v1 source |
| --- | --- |
| `load_session` | `agentCapabilities.loadSession == true` |
| `resume_session` | `agentCapabilities.sessionCapabilities.resume` is an object |
| `close_session` | `sessionCapabilities.close` is an object |
| `list_sessions` | `sessionCapabilities.list` is an object |
| `delete_session` | `sessionCapabilities.delete` is an object |
| `additional_directories` | `sessionCapabilities.additionalDirectories` is an object |
| `system_prompt` | `sessionCapabilities.systemPrompt` is an object |
| `prompt_image` / `prompt_audio` / `prompt_embedded_context` | `promptCapabilities.image` / `.audio` / `.embeddedContext` |
| `mcp_http` / `mcp_sse` | `mcpCapabilities.http` / `.sse` |
| `logout` | `agentCapabilities.auth.logout` is an object |

For `track: v1_stable`, `validate_fixtures.py` re-derives every `features.*` value from `acp_agent_capabilities` with exactly this table and rejects a snapshot that disagrees or that still contains a `_meta` key. A snapshot can therefore not claim `resume_session` (and unlock `S20` with `launch_method: resume`) unless the raw capabilities advertise it.

## What the UI may claim

| UI claim | Allowed only if |
| --- | --- |
| "History available" (timeline) | Always — this is local history restoration from AgentDock's own event log, not the agent's memory. |
| "Reconnect to agent session (with history replay)" | `features.load_session` and an `external_session_id` is stored. |
| "Reconnect to agent session" | `features.resume_session` and an `external_session_id` is stored. |
| "Agent session cannot be reconnected; restart with summary" | Neither of the above. This is the default. |
| Close agent session | `features.close_session`; otherwise AgentDock cancels the turn and terminates the process. |
| Attach images / audio / embedded resources | Corresponding `prompt_*` feature. |

A reattach can still fail (the agent's own storage may be gone). That is `S03 starting → failed (attach_rejected)`; AgentDock then offers task-level restart. It never pretends the reattach worked.

## Launch methods

| `LaunchMethod` | ACP call | Notes |
| --- | --- | --- |
| `new` | `session/new` | Always available. Used for first launch and for task-level restart (new `session_id`, `supersedes_session_id`, optional `handoff_summary_id`). |
| `load` | `session/load` | Same AgentDock `session_id`, new process. Notifications received before the response are written with `provenance: acp_replay`. If AgentDock already has that history locally, it may store only a count; it never re-executes or re-approves anything seen in a replay. |
| `resume` | `session/resume` | Same AgentDock `session_id`, new process, no replay. |

## ACP v1 to AgentDock event mapping

| ACP v1 | AgentDock |
| --- | --- |
| `initialize` response | `session.capabilities_detected` |
| `session/new` / `load` / `resume` success | `session.state_changed starting → idle (session_ready)` with `external_session_id` |
| `session/prompt` request | `session.prompt_submitted` then `idle → active` |
| `session/prompt` response `stopReason` | `active → idle (turn_ended, stop_reason)` |
| `session/cancel` | Caused by a user/orchestrator command; result arrives as `stop_reason: cancelled` |
| `session/update` `agent_message_chunk` / `agent_thought_chunk` / `user_message_chunk` | `session.message_delta` (coalesced; channel `agent_message` / `agent_thought` / `user_message`) |
| `tool_call` / `tool_call_update` | `session.tool_call` (`rawInput`/`rawOutput` → redacted artifact only) |
| `plan` | `session.plan_updated` |
| `usage_update` | `usage.reported` with `source: provider_reported`, `reporter: acp_usage_update`; `used/size` → `context_window`, `cost` → `cost{amount, unit, basis: reported}`; scope `cumulative` |
| `session/request_permission` | `approval.requested{source: acp_permission}` → `active → awaiting_permission` → task `running → awaiting_approval` |
| permission answer | `approval.resolved` (with `acp_outcome`) persisted **before** the JSON-RPC response is sent |
| `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `notice`, `compaction_*` | Not part of the v1 contract. May be stored later as new event types (additive). `notice` is live-only and never part of history. |
| `fs/*`, `terminal/*` client methods | Executed by AgentDock under host policy (path checks, approvals); recorded as `session.tool_call` / `operation.*` as appropriate, never silently. |
| JSON-RPC protocol error / malformed message | `active → failed (protocol_error)` or `starting → failed` |
| process exit | `* → disconnected (process_exited)` |

`allow_always` / `reject_always`: AgentDock records the selected option, but its own scope (`ApprovalScope`) is decided by host policy; selecting `allow_always` never creates a persistent AgentDock rule without a separate, explicit settings change.

## v2 draft compatibility strategy

ACP v2 was published as a **draft** (2026-07-20; schema `2.0.0-alpha.16` at the checked commit). The announcement asks implementers to gate v2 behind version negotiation **and** feature flags, and to keep supporting v1 side by side. AgentDock follows that:

1. **Default is v1.** Every adapter starts with `protocolVersion: 1`. If the agent answers anything other than 1, AgentDock disconnects and reports "unsupported protocol version" (no guessing).
2. **Opt-in per adapter** (`acp_v2_draft` setting, off by default, not available in release builds until v2 is stable). With it on, AgentDock proposes `2`; if the agent answers `1`, the v1 path is used. `CapabilitySnapshot.track` records which one was used.
3. **The AgentDock contract is protocol-neutral.** Task/session states, `LaunchMethod`, `features.*`, `provenance` and approvals do not mention v1-only wire shapes. The v2 adapter maps into the same events:
   - v2 has no `session/load`; `agentCapabilities.session` (`{}`) makes `session/new`, `list`, `resume`, `close` baseline. Mapping: `features.load_session = false`, `resume_session = list_sessions = close_session = true` when `session` is advertised.
   - v2 `session/resume` with `replayFrom` replays history and ends with a `replay_complete` update. Updates before it are written with `provenance: acp_replay`; a resume without `replay_complete` is a truncated replay and must be flagged.
   - v2 `session/prompt` returns a `messageId`, not the end of the turn; completion comes from `state_update` (`idle` / `running` / `requires_action`). Mapping: `running` → `active`, `idle` → `idle (turn_ended)`, `requires_action` → attention `needs_reply`.
   - v2 permission requests carry their own `title`/`description` and a `subject`; they still map to `approval.requested{source: acp_permission}`.
4. **Known gap (not designed yet):** v2 `IdleStateUpdate.stopReason` is optional, but `session.state_changed` currently *requires* `stop_reason` on `turn_ended` (v1 always has one). Supporting v2 will need an additive schema change (e.g. allow omission or an explicit "not reported" value). Tracked as an open question in the ADR; nothing in v1 depends on it.
5. Enum values with a leading `_` (v2 extension convention) are not accepted by the v1 contract. A v2 adapter maps unknown values to the closest documented value or drops them, and logs a diagnostic.
