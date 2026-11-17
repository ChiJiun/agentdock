# Event log: envelope, cursor, backpressure, retention

Status: Proposed with [ADR-0003](../decisions/0003-task-session-event-contracts.md). Schema: [`EventEnvelope`](schema/agentdock.schema.json) and the `*Payload` definitions.

## Commands vs events

The UI never writes events. It calls typed Rust commands (`create_task`, `resolve_approval`, `resume_task`, ...). The backend validates the command against policy and the state machine, then appends one or more **events** — immutable facts — in one SQLite transaction together with the projection update. Events are the only durable record of what happened; projections (`tasks`, `sessions`, `approvals`, ...) can be rebuilt from them.

## Envelope

```json
{
  "schema_version": 1,
  "id": "evt_01JDQ001000000000000000007",
  "authority_id": "local",
  "seq": 7,
  "occurred_at": "2026-11-17T02:00:07.000Z",
  "recorded_at": "2026-11-17T02:00:07.000Z",
  "project_id": "prj_…",
  "task_id": "tsk_…",
  "session_id": "ses_…",
  "type": "session.message_delta",
  "actor": { "kind": "adapter", "id": "claude-code" },
  "provenance": "live",
  "causation_id": "evt_…",
  "correlation_id": "op_… or trn_…",
  "redaction": { "policy_version": 1, "applied_rules": ["api_key"] },
  "payload": { "channel": "agent_message", "content": { "text": "… [REDACTED:api_key] …" } }
}
```

| Field | Rule |
| --- | --- |
| `id` | Prefixed ULID (`evt_` + 26 Crockford base32). Globally unique, stable across sync. |
| `authority_id` | The store that minted `seq`: `local`, or `remote:<name>` for a remote worker journal. |
| `seq` | The cursor. See below. |
| `occurred_at` / `recorded_at` | RFC 3339 UTC, millisecond precision. `occurred_at` ≤ `recorded_at`; `recorded_at` is non-decreasing in `seq` order. Ordering is by `seq`, never by timestamp. |
| `project_id`, `task_id` | Required for every event except `system.*`. `system.*` events carry neither. |
| `session_id` | Required for `session.*` and `usage.*`; optional for `approval.*` (host-policy approvals are task-scoped). |
| `type` | `<entity>.<past_tense_verb>`; closed enum per `schema_version`. |
| `actor` | Who caused it (`user`, `orchestrator`, `policy`, `adapter`, `integration`, `recovery`). `recovery` ⇔ `provenance: recovery`. |
| `provenance` | `live`; `acp_replay` (history re-sent by an agent during `session/load` — only `session.message_delta`, `session.tool_call`, `session.plan_updated`, only while that load is in progress, and only after a `session.capabilities_detected` of the process started for this load advertises `loadSession`); `recovery` (written by crash recovery). |
| `causation_id`, `correlation_id` | Optional links (the event that caused this one; the turn/operation it belongs to). |
| `redaction` | Always present. Payloads are redacted **before** they are written; there is no unredacted copy in the event store. |
| `tombstone` | Only on events of a deleted task, rewritten in place after `task.deleted` (`{reason: task_deleted, at}`); the payload is then `{}`. See Retention. |
| `payload` | Shape fixed by `type` (see catalog). Optional fields are omitted, never `null`. |

## Event catalog

Retention class: **D** = durable (kept for the task's lifetime, never compacted), **T** = transcript (payload may be compacted to an artifact), **E** = ephemeral (not stored; live stream only — none defined in v1).

| Type | Class | Notes |
| --- | --- | --- |
| `task.created` | D | First state `queued` (T01). |
| `task.state_changed` | D | `from`, `to`, `trigger`; `interruption` iff `to=interrupted`; `failure` iff `to=failed`; `return_state` + `approval_id` when entering `awaiting_approval`; `resume_phase` on resume paths (`T44` and `T05`–`T08`); never on a retry (`T47`), which restarts from `running`. |
| `task.checkpoint_recorded` | D | See [checkpoint-and-replay.md](checkpoint-and-replay.md#checkpoints). |
| `task.outcome_acknowledged` | D | User viewed a `completed`/`cancelled`/`failed`/`interrupted` result; `method` = `opened`, `marked_reviewed` or `bulk_marked_reviewed` (bulk only for `completed`/`cancelled`, UX section 4). Drives attention. |
| `task.policy_updated` | D | User changed `auto_resume_policy`. Turning a flag off disarms an armed interruption; turning it on never arms one retroactively. |
| `task.deleted` | D | User deleted a `completed`/`cancelled`/`failed` task: `final_state`, `events_tombstoned`. See Retention. |
| `session.created` | D | `role`, `parent_session_id?`, `adapter_id`, `launch_method`, `supersedes_session_id?`, `handoff_summary_id?`. |
| `session.capabilities_detected` | D | `CapabilitySnapshot` for this process (after every `initialize`). |
| `session.state_changed` | D | See state machine. Carries ACP `stop_reason` on `turn_ended`; `outcome` when entering `closed`/`failed` (`failed` only with outcome `failed` or `cancelled`). |
| `session.prompt_submitted` | T | Turn start; `origin` = `user`, `orchestrator` or `handoff` (summary-seeded restart). |
| `session.message_delta` | T | Coalesced ACP `agent_message_chunk` / `agent_thought_chunk` / `user_message_chunk`. |
| `session.tool_call` | T | ACP `tool_call` / `tool_call_update` (status, kind, title, locations). `rawInput`/`rawOutput` never inline; only a redacted `raw_io` artifact. |
| `session.plan_updated` | T | ACP `plan` entries. |
| `session.summary_recorded` | D | Interruption / handoff / completion summary; `source` = `agent_generated`, `host_generated`, `user_written`. |
| `session.output_limited` | D | A per-turn output cap was hit; content truncated or turn cancelled (`turn_cancelled` requires `turn_id`; attention shows `output_limited`). |
| `session.result_acknowledged` | D | User viewed a finished session's result; `method` as above (bulk only for a `closed` session with outcome `succeeded`/`cancelled`). Only `opened` counts as seen for auto-archive. |
| `session.archived` / `session.unarchived` | D | UX archive (`docs/ux/states-and-indicators.md` section 5). `archived{by: auto}` and `unarchived{by: system}` only under the rules in [state-machines.md](state-machines.md#archiving-sessions); `unarchived{by: user}` marks the session restored. |
| `approval.requested` / `approval.resolved` | D | See ADR "Approvals". `return_state` only on blocking approvals; at most one blocking approval per task is pending. ACP permissions carry `operation_kind: tool_call` and the backend's `classified_kind`. An approved but unused host-policy grant may later be `invalidated`. |
| `operation.recorded` / `.started` / `.succeeded` / `.failed` / `.outcome_unknown` / `.reconciled` / `.abandoned` | D | Non-repeatable side effects. `succeeded`/`failed` are written only by the `orchestrator` or `integration` that ran the operation (never by `adapter`, `policy`, `user` or `recovery`). `outcome_unknown` carries `cause` (`host_crash` by recovery, `killed` by the orchestrator; a started `pr_merge` is never killed). `abandoned` ends a never-started operation. See [checkpoint-and-replay.md](checkpoint-and-replay.md#non-repeatable-operations). |
| `check.started` / `check.finished` | D | Local or CI checks; logs go to an artifact. A result is written by `orchestrator` or `integration`; `outcome_unknown` only by `recovery`. |
| `usage.reported` | D | One `Usage` observation with its `source`. |
| `system.recovery_started` / `system.recovery_completed` | D | Bracket crash recovery; both are written by the `recovery` actor, which writes nothing outside the bracket. |

Mapping from ACP v1 (`session/update` variants and methods) is in [acp-capabilities.md](acp-capabilities.md#acp-v1-to-agentdock-event-mapping).

## Cursor

- `seq` is assigned inside the same transaction that appends the event: `seq = last_seq + 1` under SQLite's single writer. It is **strictly increasing and gap-free per `authority_id`**. A gap therefore always means data loss or a bug, and a subscriber can detect it.
- `seq` fits in 53 bits (`≤ 2^53 − 1`) so TypeScript `number` stays exact. Rust uses `u64`.
- The cursor a client holds is the pair `(authority_id, seq)`; "give me everything after `seq`" is the only read-position API.
- Retention never removes a row from the sequence (see Retention), so `seq` stays gap-free even after compaction or task deletion (tombstones).
- Remote work: the remote worker is the authority and mints its own `seq`. The desktop stores a mirror keyed by `(authority_id, seq)` and never mints `seq` for a remote authority. Reconnect = request `after_seq` = last mirrored `seq`. User actions on remote tasks are commands sent to the worker, not locally appended events.

## Subscriptions and backpressure

Subscribers (UI windows, a future remote client) receive `StreamMessage`s (schema `StreamMessage`, not stored):

| `kind` | Meaning |
| --- | --- |
| `events` | A batch of envelopes in `seq` order plus `next_after_seq`. Batches are capped (proposal: 256 events or 512 KiB). |
| `heartbeat` | `head_seq` of the authority (proposal: every 15 s when idle) so a client can notice it is behind. |
| `lagged` | The subscriber's bounded buffer overflowed (proposal: 2,048 events). The live stream for it was dropped; it must page from the store from `resume_after_seq` and then resubscribe. Never silently skips events. |
| `retention_gap` | The requested cursor is older than what the store can serve in full (compacted transcript beyond `oldest_available_seq`). Durable events are still served; the client shows "earlier transcript archived". |

Producer side (ACP → store), in order of preference:

1. **Coalesce** streaming chunks: `agent_message_chunk` / `agent_thought_chunk` for the same turn and channel are merged into one `session.message_delta` per flush window (proposal: 100 ms or 16 KiB, whichever first). `coalesced_chunks` records how many were merged. State-changing events (`*.state_changed`, approvals, operations, checks, usage) are **never** coalesced or dropped.
2. **Cap** runaway output: per turn (proposal: 8 MiB of text or 20,000 events) and per message (1 MiB). On hitting a cap AgentDock records `session.output_limited` and either truncates (keeps reading, stores a marker) or sends `session/cancel` (configurable per adapter).
3. **Pipe backpressure**: if the writer queue is still full, AgentDock stops reading the agent's stdout. ACP has no flow control, so the OS pipe blocks the agent. This is acceptable because nothing is lost; `session/request_permission` answers are delayed, never auto-answered.

The UI never blocks the writer: slow UI subscribers get `lagged`, the store keeps going.

## Retention

| Class | Policy (proposal; configurable) |
| --- | --- |
| Durable | Kept as long as the task exists. |
| Task deletion | An explicit, confirmed user action on a `completed`/`cancelled`/`failed` task with nothing open: no operation `recorded`, `started` or `outcome_unknown` (reconcile first), no `pending` or approved-but-unused approval, and no live session. AgentDock appends `task.deleted{final_state, events_tombstoned}` and, in the same transaction, rewrites every earlier event of that task (including its sessions' events) into a **tombstone**: `id`, `seq`, `type`, `authority_id`, timestamps, `actor`, `provenance`, routing ids and `redaction` stay; the payload becomes `{}` and `tombstone: {reason: task_deleted, at}` is added (`at` = the `task.deleted` `recorded_at`). Artifacts of the task are deleted. Rows are never removed, so `seq` stays gap-free and a subscriber holding an old cursor still sees a contiguous sequence; projections skip tombstones. No event may reference the task after `task.deleted`. Tombstoning is the only in-place rewrite of an event, and it only ever removes content. `system.*` events are never tombstoned and keep listing the ids of a deleted task's entities (for example `system.recovery_completed.tasks_interrupted`); those ids are opaque references to deleted entities, carry no content, and a reader must not expect to resolve them. Because a tombstoned stream cannot show the deleted task's state, every fixture that deletes a task also has `fixtures/predelete/<name>.jsonl` (the stream as it was right before `task.deleted`), against which `validate_fixtures.py` checks the preconditions above. |
| Transcript | Inline until the task's transcript exceeds 64 MiB or the task has been terminal for 30 days; then payload `content.text` is moved to a content-addressed artifact and replaced by `content.text_ref` (`ArtifactRef` with `sha256`, `bytes`). The row, `seq`, `type` and metadata stay. If the artifact is later pruned, the store reports `retention_gap`. |
| Artifacts | Check logs, raw tool I/O (redacted), compacted transcript. Relative paths under the app data directory; never inside the user's repository. |

## Redaction

Redaction happens in the Rust ingestion path before persistence and before any event reaches a subscriber.

- Never stored: process environment values, MCP server `env` values and `headers` values (ACP `McpServerStdio.env`, `McpServerHttp.headers`), `Authorization`/cookie headers, values matching configured secret patterns (API keys, GitHub tokens, private keys), ACP `_meta` contents (dropped, not interpreted).
- Replaced inline by `[REDACTED:<rule>]`; `redaction.applied_rules` lists the rules that fired so a reviewer knows something was removed.
- `rawInput`/`rawOutput` of tool calls are stored only as a redacted artifact (`raw_io`), never inline.
- Paths outside the task's workspace may be generalized (`home_path` rule) in titles/locations.
- `redaction.policy_version` lets a later stricter policy be applied by re-compacting, never by "un-redacting".
- Fixtures contain no real secrets (roadmap CI rule).
