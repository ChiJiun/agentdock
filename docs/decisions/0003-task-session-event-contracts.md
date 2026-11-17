# ADR-0003: Task, Session and Event contracts and ACP capability boundaries

Date: 2026-11-17
Status: Proposed (issue #3). Becomes Accepted when the owner approves the PR; implementation details remain provisional until issue #4 builds the first types.

## Context

AgentDock will orchestrate external ACP agents (Claude Code, Codex, Octomind) on a user's repositories. Before writing UI or backend code we need one canonical model of what a task is, what a session is, what is recorded, and what may be claimed after a disconnect or crash. Specifically:

- A Task can involve several Sessions (implementation, review, repair, exploration), and agent context is **not** automatically recoverable.
- External agents own their prompt loop, context and authentication. AgentDock can only rely on what ACP lets them advertise.
- Side effects such as `git push`, PR creation, merges and destructive commands must never happen twice because of a crash or a retry.
- Usage and quota: providers rarely expose subscription allowances. The PRD forbids pretending otherwise.
- The owner's recurring harness needs: resume a quota-stopped session when the quota resets; leave a summary on interruption; a main session with child sessions that collapse only after the user has seen their results (the main session never auto-collapses); and three to-do lists — needs reply, needs review, running in background — derived from events.

`docs/architecture.md` sketched entities and a state machine; this ADR makes them precise and machine-checkable.

## Decision

### 1. Contracts live in `docs/contracts/` as JSON Schema plus a transition table

- [`schema/agentdock.schema.json`](../contracts/schema/agentdock.schema.json) defines `Project`, `Task`, `Session`, `Approval`, `Operation`, `Check`, `Usage`, `CapabilitySnapshot`, `EventEnvelope` with one payload per event type, `StreamMessage`, and `AttentionItem`.
- [`transitions.json`](../contracts/transitions.json) lists every legal task and session transition with allowed actors, triggers, durability and conditions.
- Mock fixtures under [`fixtures/`](../contracts/fixtures/) cover all 47 task and 25 session transitions, including disconnect, cancellation, denied approval, quota interruption and host crash. [`validate_fixtures.py`](../contracts/validate_fixtures.py) checks them with the Python standard library only.
- Naming: `snake_case` keys and enum values everywhere (Rust, SQLite, IPC, TypeScript); event types `<entity>.<past_tense_verb>`; prefixed ULID IDs; RFC 3339 UTC millisecond timestamps; omit absent fields, no `null`. Rust/TypeScript mapping rules: [contracts README](../contracts/README.md#rust-mapping-for-issue-4).

### 2. Task state graph

States: `queued`, `preparing`, `running`, `awaiting_approval`, `verifying`, `review`, `pr`, `ci`, `completed`, `interrupted`, `failed`, `cancelled`. Full graph and conditions: [state-machines.md](../contracts/state-machines.md).

- Terminal: `completed`, `cancelled`. `failed` is resumable only by an explicit user retry.
- `awaiting_approval` is entered from `running`, `pr` or `ci` and returns to exactly the state it came from (`return_state`). Approvals raised in `verifying`/`review` (review child sessions) and cleanup approvals after the task ended are non-blocking: no `return_state`, no task transition.
- `interrupted` is the single "stopped but resumable" state and always carries an `Interruption` (reason, `phase`, optional retry hint, auto-resume flag, summary, open operations). "Paused" is `interrupted{reason: user_paused}`.
- Resume always goes `interrupted → queued → preparing →` the recorded `resume_phase` (`running`, `verifying`, `review`, `pr`, `ci`), which must be at or before `Interruption.phase` so a resume never skips verification, review or PR creation. Re-entering `pr`/`ci` requires every operation of the task to be reconciled; entering `ci` additionally requires a succeeded PR operation.
- Leaving a phase for `interrupted`, `cancelled` or `failed` first closes its operations: recorded ones are abandoned, unused grants invalidated, started ones killed and recorded as `outcome_unknown{cause: killed}`.
- The agent never changes task state; ACP traffic is input (actor `adapter`) interpreted by the orchestrator.
- Every transition is persisted before it is reported (`persist_then_report`). Transitions that authorize a side effect are persisted before the effect (`persist_then_act`): scheduling, cancellation, approval resolution, entering `awaiting_approval`, resume and retry.

Sessions have their own small graph (including protocol errors while idle, asking for permission or suspended, and closing a session that is still starting) — `starting`, `idle`, `active`, `awaiting_permission`, `suspended`, `disconnected`, `closed`, `failed` — with `parent_session_id`, `role`, `outcome`, `supersedes_session_id` and `handoff_summary_id`.

### 3. Three separate notions of "resume"

| | History restoration | External session reattach | Task-level restart |
| --- | --- | --- | --- |
| What | Rebuild the timeline from AgentDock's event log | New process + ACP `session/load` (replays) or `session/resume` (no replay) | Re-enter the workflow with a **new** session seeded by a summary |
| Requires | nothing | the current process advertises `loadSession` / `sessionCapabilities.resume` and an external session id is stored | nothing |
| Session id | n/a | same AgentDock `session_id` | new `session_id`, `supersedes_session_id` |

The UI may only claim an agent session is reconnectable when the capability is advertised by the current process; a failed reattach is recorded as `attach_rejected` and falls back to restart. "Event replay" (re-projecting events) is always safe; "operation replay" is forbidden. Details: [checkpoint-and-replay.md](../contracts/checkpoint-and-replay.md).

### 4. Event envelope, cursor, backpressure, retention

- Envelope: `id`, `authority_id`, `seq`, `occurred_at`, `recorded_at`, `project_id`/`task_id` (absent only for `system.*`), `session_id?`, `type`, `actor`, `provenance` (`live`, `acp_replay`, `recovery`), `causation_id?`, `correlation_id?`, `redaction`, `payload` (already redacted).
- Cursor: `seq` is assigned in the append transaction, strictly increasing and **gap-free per authority**, capped at 2^53 − 1. Readers use `(authority_id, seq)`; a remote worker is its own authority.
- Backpressure: streaming chunks are coalesced; state-changing events are never coalesced or dropped; per-turn output caps produce `session.output_limited`; a slow subscriber gets `lagged` and re-reads from the store; as a last resort AgentDock stops reading the agent's stdout. Nothing is auto-answered under pressure.
- Retention: durable events stay for the task's lifetime; transcript payloads may be compacted into content-addressed artifacts without removing rows (the cursor stays gap-free); `retention_gap` tells a client what is archived. Deleting a task appends `task.deleted` and rewrites the task's earlier events into tombstones (empty payload, same `seq`), so deletion removes content but never creates a gap.
- Redaction before persistence: environment values, MCP `env`/`headers`, auth headers, secret patterns and ACP `_meta` never reach the store; `rawInput`/`rawOutput` only as redacted artifacts.

Details: [events.md](../contracts/events.md).

### 5. Adapter capability detection: ACP v1 stable first

- After every `initialize`, record a `CapabilitySnapshot`: negotiated `protocol_version`, the raw `agentCapabilities` minus `_meta`, and closed boolean `features` derived only from advertised fields (absent = false). Field names were verified against the official ACP schema and Rust schema crate (commits in [acp-capabilities.md](../contracts/acp-capabilities.md#verified-sources)).
- All optional ACP calls (`session/load`, `session/resume`, `session/close`, `additionalDirectories`, `systemPrompt`, prompt media) are gated on the snapshot of the current process.
- ACP v2 (draft) is opt-in per adapter behind a flag and version negotiation; v1 stays the default and is kept side by side. The AgentDock contract is protocol-neutral so v2 maps into the same events; one known gap (v2's optional `stopReason`) is listed below.

### 6. Approvals and non-repeatable operations

- Approvals come from ACP `session/request_permission` (`acp_permission`) or from host policy (`host_policy` for push, PR, merge, destructive commands). An approval is persisted as `pending` before the user sees it and its resolution is persisted before the agent is answered or the operation runs. Only `user` or `policy` actors can approve or deny; agent text never can. Approvals for `pr_merge`, `branch_delete`, `worktree_remove` and `destructive_command` can be granted **only by the user**; policy may deny them or let them expire, and every policy decision names its rule.
- Every side effect AgentDock controls is an `Operation` with `repeatability` (bound to its kind by the schema: git/PR/merge/branch/worktree/destructive kinds are always `non_repeatable`; repeatable work is a `Check`), an `idempotency_key` = sha256 of canonical `{kind, target}` that equals the approval's `operation_fingerprint`, and a read-only `reconcile_strategy`. Each kind may only be recorded and started in specific task states (push/PR in `pr`, merge in `ci`, destructive commands in `running`, cleanup after the task ended). An operation id executes at most once (`recorded → started → …`, or `recorded → abandoned` when it never starts); an approval with scope `once` is consumed by one execution; a duplicate key is allowed only as an explicit `supersedes_operation_id` of an abandoned, failed-without-effect or reconciled-not-applied/undeterminable operation, with a new approval.
- **After a crash nothing is replayed automatically**: pending approvals and approved-but-unused grants become `invalidated`, recorded operations become `abandoned`, started operations become `outcome_unknown`, running checks become `outcome_unknown`, live sessions become `disconnected`, in-flight tasks become `interrupted{host_crashed}` with auto-resume disabled. Reconciliation happens later, live and read-only, and resuming into `pr`/`ci` waits for it.

### 7. Usage and quota

- `Usage.source` is exactly one of `provider_reported`, `locally_estimated` (requires an `estimator`), or `unknown` (no numbers allowed). ACP v1 `usage_update` maps to `context_window {used, size}` and `cost {amount, unit}`; credits are never converted to money.
- There is **no field for remaining subscription quota** anywhere in the contract; the validator rejects keys that suggest one. The UI shows subscription quota as unknown.
- Limits appear only as interruptions: `quota_exhausted` / `rate_limited` with a `retry_hint` whose `source` is `provider_reported`, `user_configured` or `unknown` (unknown carries no time).

### 8. Harness scenarios

- **Resume at quota reset**: `auto_resume_armed` only for quota/rate limits, only with the task's opt-in and a provider-reported or user-configured `not_before`; the orchestrator resumes with `scheduled_resume` no earlier than that time. `task.policy_updated` lets the user turn this off later, which disarms a waiting task.
- **Summary on interruption**: `session.summary_recorded{purpose: interruption}`; host-generated by default because a quota-stopped agent cannot write one; used as the handoff for a restarted session.
- **Main and child sessions**: `parent_session_id`; a child auto-collapses only after it finished and the user acknowledged its result; parent-less sessions are never auto-collapsed.
- **Three to-do lists**: `AttentionItem` (`needs_reply`, `needs_review`, `background`) is derived purely from events by the rules in [attention.md](../contracts/attention.md); every fixture asserts its expected items. A phase that is not progressing (`phase_decision_pending`), a running task without a live agent (`session_unavailable`), output-limit cancellations (`output_limited`) and refusals of any session role are surfaced as needs-reply items, not hidden as background work.

## Alternatives considered

1. **Prose-only contracts in `architecture.md`.** Fast, but drift is guaranteed and nothing checks the fixtures. Rejected.
2. **Rust types as the only source now.** Issue #4 owns the Rust workspace; creating crates here would pre-empt it. The schema is the interim source; #4 decides Rust-first or schema-first generation (README).
3. **A separate `paused` state.** Two resumable states with nearly identical rules; folded into `interrupted{user_paused}`.
4. **Allow `failed` to be terminal.** Users regularly retry after fixing an environment problem; making retry an explicit, recorded user transition keeps history intact.
5. **Optimistic UI for state changes.** Simpler perceived latency, but it breaks "denied action does not execute after reload" and crash recovery. Only streaming text may appear before commit.
6. **Per-session cursors.** Easier sharding, but cross-entity ordering (approval vs. operation vs. state change) matters more. One cursor per authority.
7. **Auto-retry non-repeatable operations with provider idempotency.** Not available for `git push`/merge/destructive commands; reconciliation + human decision is the only safe general rule.
8. **Model quota as "remaining %" with a disclaimer.** Contradicts PRD and AGENTS.md; rejected.

## Consequences

- Implementation (#4, M2) gets a precise target and a ready conformance suite (fixtures + expectations).
- Every optional agent feature must go through capability snapshots; adapters cannot "just know" an agent supports resume.
- More events and more explicit user decisions after failures (reconcile, resume, retry). This is intentional friction.
- The JSON Schema subset validator is not a full JSON Schema implementation; CI in #4 should add a full validator.
- Proposed numbers (buffer sizes, retention, caps) are placeholders to be measured, not commitments.

## Open questions (owner decision needed)

1. Is folding "Paused" into `interrupted{user_paused}` acceptable, or should `paused` be a first-class state?
2. Should `failed → queued` (retry) stay, or should a retry create a new task linked to the failed one?
3. Default `auto_resume_policy`: both off (current proposal) or `on_quota_reset` on by default?
4. Rust-first (`schemars` + `ts-rs`) vs schema-first (`typify` + `json-schema-to-typescript`) generation for #4.
5. When v2 support starts: allow `turn_ended` without `stop_reason` (v2 makes it optional), or add an explicit `unreported` value?
6. Retention defaults (64 MiB transcript per task, 30 days after terminal) and output caps (8 MiB / 20,000 events per turn) — acceptable starting points?
7. Which host-policy approvals may a policy rule grant without a human? Current proposal: `git_push` (never force), `pr_create`, `pr_update`, `pr_comment`, `external_write` may be policy-approved; `pr_merge`, `branch_delete`, `worktree_remove`, `destructive_command` are user-only. Making `git_push` user-only as well is a one-line change in the validator and the classification table.
8. A task has at most one blocking approval at a time (`awaiting_approval` holds one `approval_id`). If two sessions of a running task ask for permission at once, the second request is held by the adapter until the first is resolved. Acceptable, or should `awaiting_approval` track a set?

## Acceptance mapping (issue #3)

| Acceptance item | Where |
| --- | --- |
| ADR and typed schema with Rust/TypeScript mapping plan | this ADR; `docs/contracts/schema/agentdock.schema.json`; `docs/contracts/README.md` |
| Mock event fixtures for all transitions incl. disconnect, cancellation, denied approval | `docs/contracts/fixtures/` (12 streams, 72/72 transitions, 40 negative mutations; validated) |
| Checkpoint consistency and replay policy documented | `docs/contracts/checkpoint-and-replay.md` |
| No unsupported resume or quota claims in contract | capability-gated `LaunchMethod`/`features`; no quota-balance fields (validator-enforced); `Usage.source`; `retry_hint.source` |
