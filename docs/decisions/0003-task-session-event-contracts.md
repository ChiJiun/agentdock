# ADR-0003: Task, Session and Event contracts and ACP capability boundaries

Date: 2026-11-17
Status: Proposed (issue #3). Becomes Accepted when the owner approves the PR; implementation details remain provisional until issue #4 builds the first types.

## Context

AgentDock will orchestrate external ACP agents (Claude Code, Codex, Octomind) on a user's repositories. Before writing UI or backend code we need one canonical model of what a task is, what a session is, what is recorded, and what may be claimed after a disconnect or crash. Specifically:

- A Task can involve several Sessions (implementation, review, repair, exploration), and agent context is **not** automatically recoverable.
- External agents own their prompt loop, context and authentication. AgentDock can only rely on what ACP lets them advertise.
- Side effects such as `git push`, PR creation, merges and destructive commands must never happen twice because of a crash or a retry.
- Usage and quota: providers rarely expose subscription allowances. The PRD forbids pretending otherwise.
- The owner's recurring harness needs: resume a quota-stopped session when the quota resets; leave a summary on interruption; a main session with child sessions that are archived only after the user has seen their results (the main session never auto-archives); and three to-do lists — needs reply, needs review, running in background — derived from events.

`docs/architecture.md` sketched entities and a state machine; this ADR makes them precise and machine-checkable.

## Decision

### 1. Contracts live in `docs/contracts/` as JSON Schema plus a transition table

- [`schema/agentdock.schema.json`](../contracts/schema/agentdock.schema.json) defines `Project`, `Task`, `Session`, `Approval`, `Operation`, `Check`, `Usage`, `CapabilitySnapshot`, `EventEnvelope` with one payload per event type, `StreamMessage`, and `AttentionItem`.
- [`transitions.json`](../contracts/transitions.json) lists every legal task and session transition with allowed actors, triggers, durability and conditions.
- Mock fixtures under [`fixtures/`](../contracts/fixtures/) cover all 47 task and 25 session transitions, including disconnect, cancellation, denied approval, quota interruption and host crash. [`validate_fixtures.py`](../contracts/validate_fixtures.py) checks them with the Python standard library only and rejects 63 deliberately broken variants. It is a regression check, not the enforcement; see [Enforcement boundary](#9-enforcement-boundary).
- Naming: `snake_case` keys and enum values everywhere (Rust, SQLite, IPC, TypeScript); event types `<entity>.<past_tense_verb>`; prefixed ULID IDs; RFC 3339 UTC millisecond timestamps; omit absent fields, no `null`. Rust/TypeScript mapping rules: [contracts README](../contracts/README.md#rust-mapping-for-issue-4).

### 2. Task state graph

States: `queued`, `preparing`, `running`, `awaiting_approval`, `verifying`, `review`, `pr`, `ci`, `completed`, `interrupted`, `failed`, `cancelled`. Full graph and conditions: [state-machines.md](../contracts/state-machines.md).

- Terminal: `completed`, `cancelled`. `failed` is resumable only by an explicit user retry.
- `awaiting_approval` is entered from `running`, `pr` or `ci` and returns to exactly the state it came from (`return_state`). Approvals raised in `verifying`/`review` (review child sessions) and cleanup approvals after the task ended are non-blocking: no `return_state`, no task transition.
- `interrupted` is the single "stopped but resumable" state and always carries an `Interruption` (reason, `phase`, optional retry hint, auto-resume flag, summary, open operations). "Paused" is `interrupted{reason: user_paused}`.
- Resume always goes `interrupted → queued → preparing →` the recorded `resume_phase` (`running`, `verifying`, `review`, `pr`, `ci`), which must be at or before `Interruption.phase` so a resume never skips verification, review or PR creation. Re-entering `pr`/`ci`, `review → pr`, `pr → ci`, completion and retry all require that no operation of the task is `recorded`, `started` or `outcome_unknown` (reconcile first); entering `ci` additionally requires a push in the current PR round (which starts at `review → pr`) plus a PR.
- Leaving a phase for `interrupted`, `cancelled` or `failed` first closes its operations: recorded ones are abandoned, unused grants invalidated, started ones killed and recorded as `outcome_unknown{cause: killed}`. Exception: a started `pr_merge` is never killed (ADR-0002 PRL-5); Pause/Cancel wait for its result.
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

- Approvals come from ACP `session/request_permission` (`acp_permission`) or from host policy (`host_policy` for push, PR, merge, destructive commands). An approval is persisted as `pending` before the user sees it and its resolution is persisted before the agent is answered or the operation runs. Only `user` or `policy` actors can approve or deny; agent text never can. Approvals for `pr_merge`, `branch_delete`, `worktree_remove` and `destructive_command` can be granted **only by the user**; policy may deny them or let them expire, and every policy decision names its rule. ACP requests carry `operation_kind: tool_call` and a backend-computed `classified_kind`; classes `pr_merge`, `force_push`, `branch_delete`, `worktree_remove`, `destructive_command` and `unclassified` are user-only. A task has at most one blocking approval. This covers what reaches AgentDock: an agent in its own bypass/full-access mode is not intercepted (ADR-0002 APR-11, issue #26), and client-method execution as Operations is issue #8.
- Every side effect AgentDock controls is an `Operation` with `repeatability` (bound to its kind by the schema: git/PR/merge/branch/worktree/destructive kinds are always `non_repeatable`; repeatable work is a `Check`), an `idempotency_key` = sha256 of canonical `{kind, identity}` (identity = the kind's required target fields; the human-readable `description` is excluded) that equals the approval's `operation_fingerprint`, and a read-only `reconcile_strategy`. Each kind may only be recorded and started in specific task states (push/PR in `pr`, merge in `ci`, destructive commands in `running`, cleanup after the task ended). An operation id executes at most once (`recorded → started → …`, or `recorded → abandoned` when it never starts); an approval with scope `once` is consumed by one execution, only for an operation of its own task and before its `expires_at`; `git_push` starts only from a clean checkpoint at `expected_sha`, and `pr_merge` only at the SHA AgentDock pushed; a duplicate key is allowed only as an explicit `supersedes_operation_id` of an abandoned, failed-without-effect or reconciled-not-applied/undeterminable operation, with a new approval.
- **After a crash nothing is replayed automatically**: pending approvals and approved-but-unused grants become `invalidated`, recorded operations become `abandoned`, started operations become `outcome_unknown`, running checks become `outcome_unknown`, live sessions become `disconnected`, in-flight tasks become `interrupted{host_crashed}` with auto-resume disabled. Reconciliation happens later, live and read-only, and resuming into `pr`/`ci` waits for it.

### 7. Usage and quota

- `Usage.source` is exactly one of `provider_reported`, `locally_estimated` (requires an `estimator`), or `unknown` (no numbers allowed). ACP v1 `usage_update` maps to `context_window {used, size}` and `cost {amount, unit}`; credits are never converted to money.
- There is **no field for remaining subscription quota** anywhere in the contract; the validator rejects keys that suggest one. The UI shows subscription quota as unknown.
- Limits appear only as interruptions: `quota_exhausted` / `rate_limited` with a `retry_hint` whose `source` is `provider_reported`, `user_configured` or `unknown` (unknown carries no time).

### 8. Harness scenarios

- **Resume at quota reset**: `auto_resume_armed` only for quota/rate limits, only with the task's opt-in and a provider-reported or user-configured `not_before`; the orchestrator resumes with `scheduled_resume` no earlier than that time. `task.policy_updated` lets the user turn this off later, which disarms a waiting task.
- **Summary on interruption**: `session.summary_recorded{purpose: interruption}`; host-generated by default because a quota-stopped agent cannot write one; used as the handoff for a restarted session.
- **Main and child sessions**: `parent_session_id`; archiving follows the UX spec (`docs/ux/states-and-indicators.md` section 5): a child is auto-archived only when its outcome is `succeeded`/`cancelled`, the user opened its result and never restored it; parent-less sessions and failed/interrupted ones are never auto-archived; a waiting session is unarchived by the system in the same transaction.
- **Three to-do lists**: `AttentionItem` (`needs_reply`, `needs_review`, `background`) is derived purely from events by the rules in [attention.md](../contracts/attention.md); every fixture asserts its expected items. A phase that is not progressing (`phase_decision_pending`), a running task without a live agent (`session_unavailable`), output-limit cancellations (`output_limited`) refusals of any session role and operations with unknown outcome (`reconcile_needed`) are surfaced as needs-reply items, not hidden as background work. The three kinds map to the UX inbox sections; deliberate differences are listed in attention.md and below.

### 9. Enforcement boundary

`validate_fixtures.py` is a **regression check of examples and invariants**: it shows that the committed fixtures obey the rules below and that each listed mutation (a deliberately broken copy of a fixture) is rejected with the expected message. It is not a proof that every possible event stream is checked, and a stream it accepts is not thereby safe. The authoritative enforcement is the Rust backend: the core store checks invariants when an event is written (issue #7), and the approval policy classifies and decides requests (issue #8); the PR loop (issue #10) owns the review/merge checks. The table lists, per invariant, how far the validator goes and what the backend must test.

| Invariant | What this PR's validator checks (mutations) | Not covered here; required backend test |
| --- | --- | --- |
| A non-repeatable operation executes at most once | An operation id goes `recorded → started → final` once; a second operation with the same `idempotency_key` is rejected unless it supersedes an abandoned, failed-without-effect or reconciled-not-applied/undeterminable one with a new approval; the key is recomputed from `{kind, identity}` with the per-kind identity fields required by the schema and `description` excluded (`rerun_push_after_crash`, `e1_start_after_crash`, `e2b_supersede_recorded_op`, `e8a_key_not_canonical`, `b1a`, `b1b`, `b1c`) | The identity values themselves (unwrapped argv, normalized path, content digest) are taken as given. #7: unique key enforced in the append transaction, including concurrent writers. #8: identity computed from the request AgentDock executes, never from agent text |
| Merge and destructive approvals are user-only | `approval.resolved{approved}` must have actor `user` for host-policy kinds `pr_merge`, `branch_delete`, `worktree_remove`, `destructive_command` and for ACP classes `pr_merge`, `force_push`, `branch_delete`, `worktree_remove`, `destructive_command`, `unclassified`; ACP requests must say `operation_kind: tool_call` plus `classified_kind`; a grant authorizes only an operation of its own task, only before `expires_at`, and only the orchestrator starts operations (`e13_policy_approves_merge`, `b3a`, `b3b`, `n6a`, `n6b`, `n6c`) | Whether `classified_kind` is right for a given command cannot be seen in events. #8: classification tests (shell wrappers, aliases, unrecoverable commands → `unclassified`), a test that no policy rule can approve a user-only class, and client-method (`terminal/*`, `fs/*`) execution as Operations. Agent bypass/full-access modes are not enforceable by AgentDock at all (ADR-0002 APR-11, issue #26) |
| No automatic external side effect after a crash | While recovery is in progress only recovery-actor events are written; that actor may invalidate approvals, abandon recorded operations, mark started operations and running checks `outcome_unknown`, disconnect sessions and interrupt tasks with `host_crashed` (auto-resume off), but never start an operation or approve; nothing pending or unused may survive it; `system.recovery_completed` lists exactly what changed (`recovery_starts_op`, `recovery_approves`, `keep_pending_after_crash`, `auto_resume_after_crash`, `e1_recovery_keeps_recorded_op`, `e1_recovery_keeps_unused_grant`, `n1`) | #7: crash tests against the real store, killed at each point between persist and act, then restarted |
| Reconcile before re-entering `pr`/`ci`, completing or retrying | `no_unreconciled_operations` on `T07`, `T08`, `T28`, `T29`, `T34`, `T39`, `T47`; `pr_published_this_round` (a push in this PR round plus a PR) on `T08`/`T34`; `resume_phase` bounded by the interruption phase; an `outcome_unknown` operation shows `reconcile_needed`; strategy `none` can only find `undeterminable` (`b2`, `n3a`, `e14_resume_beyond_phase`, `n6d`) | #7: the same guards in the orchestrator's transition function. The probes themselves (`git ls-remote`, `gh pr view`) are #10 |
| Deletion preconditions | Checked only where a fixture ships a pre-deletion copy (`fixtures/predelete/`, currently fixture 12): the task ended in `final_state`, no operation recorded/started/`outcome_unknown`, no pending or unused approval, no live session; tombstone count; nothing after `task.deleted` (`n2`, `tombstone_count`, `event_after_delete`) | The tombstoned main stream no longer shows the payloads, so a stream without a sidecar is not checked. #7: preconditions checked inside the delete transaction |
| A started `pr_merge` is never killed | `operation.outcome_unknown{cause: killed}` is rejected for `pr_merge` (`b5`) | #7/#10: Pause/Cancel wait for the merge result; the UI disables them |
| Push and merge are bound to the published commit | `git_push` starts only if the latest checkpoint is clean with `head_sha == expected_sha`; `pr_merge.expected_sha` equals the latest succeeded push (`n3b`, `n3c`) | That the latest review covered this SHA and the base did not change (ADR-0002 PRL-1, PRL-11), and the actual `gh pr merge --match-head-commit`, are #10 |
| One blocking approval per task | A second blocking approval while one is pending is rejected; review-phase approvals are non-blocking (`n4`, `e5_review_approval_blocks`) | #7 |
| Persist before report/act; gap-free cursor | `seq` gap-free per authority, `recorded_at` monotonic, an approval resolution precedes the act it authorizes (`gap`, `act_before_approval_persisted`) | Only the order in the log is visible, not the wall-clock order of real effects. #7: transaction tests |
| Archive and attention rules (UX spec section 4/5) | Main sessions never auto-archive; a child auto-archives only when `completed`/`cancelled`, opened, and never restored; a waiting session is unarchived by the system in the same transaction; bulk "mark reviewed" only for completed/cancelled; every fixture's attention items equal its expectation (`archive_primary`, `archive_before_open`, `b4a`–`b4f`) | #7 projections. UX rule 3 (the session on screen is not listed) is UI-only. Deliberate differences: [attention.md](../contracts/attention.md#divergences-from-the-ux-spec-owner-decision) |
| Capability-gated reattach | `session/load` and replay only when the current process advertised it; `features` re-derived from raw capabilities (`load_without_capability`, `replay_outside_load`, `e12_features_mismatch`) | Adapter implementation: gate calls on the live snapshot |
| No subscription-quota claims | No key implying a quota balance; `unknown` usage has no numbers (`quota_field_schema`, `opaque_quota_key`, `unknown_usage_with_numbers`) | UI shows subscription quota as unknown |

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
7. Which host-policy approvals may a policy rule grant without a human? Current proposal: `pr_create`, `pr_update`, `pr_comment`, `external_write` may be policy-approved; `git_push` (never force) only through a rule the user created, because ADR-0002 APR-10 puts push in the default ask set; `pr_merge`, `branch_delete`, `worktree_remove`, `destructive_command` are user-only. Making `git_push` user-only as well is a one-line change in the validator and the classification table.
8. A task has at most one blocking approval at a time (`awaiting_approval` holds one `approval_id`; the validator rejects a second one). If two sessions of a running task ask for permission at once, the second request is held by the adapter until the first is resolved. Acceptable, or should `awaiting_approval` track a set?
9. Attention items that differ from the UX spec ([attention.md](../contracts/attention.md#divergences-from-the-ux-spec-owner-decision)): an armed auto-resume is shown as background, not as a result to review; `phase_decision_pending`, `session_unavailable` and `reconcile_needed` are treated as awaiting-input (the UX state table maps Review/CI to running). Keep, or follow the UX spec?
10. Undo of the bulk "Mark completed as reviewed" (UX section 4) has no event yet. Issue #7 needs one (for example an acknowledgement-revoked event) before the bulk action ships.

## Acceptance mapping (issue #3)

| Acceptance item | Where |
| --- | --- |
| ADR and typed schema with Rust/TypeScript mapping plan | this ADR; `docs/contracts/schema/agentdock.schema.json`; `docs/contracts/README.md` |
| Mock event fixtures for all transitions incl. disconnect, cancellation, denied approval | `docs/contracts/fixtures/` (12 streams, 72/72 transitions, 63 negative mutations; validated; regression scope per [Enforcement boundary](#9-enforcement-boundary)) |
| Checkpoint consistency and replay policy documented | `docs/contracts/checkpoint-and-replay.md` |
| No unsupported resume or quota claims in contract | capability-gated `LaunchMethod`/`features`; no quota-balance fields (validator-enforced); `Usage.source`; `retry_hint.source` |
