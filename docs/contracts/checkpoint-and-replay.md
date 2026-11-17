# Checkpoint consistency, recovery and replay policy

Status: Proposed with [ADR-0003](../decisions/0003-task-session-event-contracts.md). Enforced in fixtures by [`validate_fixtures.py`](validate_fixtures.py).

## Three different things called "resume"

| Concept | What it does | Needs the agent? | Always available? | Contract |
| --- | --- | --- | --- | --- |
| **History restoration** | Rebuild the UI timeline (messages, tool calls, approvals, checks) from AgentDock's own event log. Read-only. | No | Yes | Projection over events; no event is written. |
| **External session reattach** | Start a new agent process and call ACP `session/load` (agent replays history) or `session/resume` (no replay) with the stored `external_session_id`. Same AgentDock `session_id`. | Yes | Only if the *current* process advertises it | `S20 disconnected → starting (reattach_attempt, launch_method)` then `S02` or `S03 (attach_rejected)`. |
| **Task-level restart** | Re-enter the task's workflow at `resume_phase` with a **new** session (`launch_method: new`, `supersedes_session_id`), seeded with a handoff summary and the current worktree. | A fresh one | Yes | `T44 interrupted → queued (resume_phase)` → `T02` → `T04`/`T05`–`T08`; `session.created{supersedes_session_id, handoff_summary_id}`; `session.prompt_submitted{origin: handoff}`. |

"Replay" has exactly two meanings in AgentDock and they must not be confused:

- **Event replay** — re-reading the event log to rebuild projections or the UI. Always safe, has no side effects.
- **Operation replay** — executing a side effect again. **Forbidden** for non-repeatable operations unless reconciliation proved it did not happen *and* a new approval was granted. There is no code path that re-executes an operation because it appears in the log.

An agent's `session/load` history replay is event *ingestion* tagged `provenance: acp_replay`; it never triggers tool execution, approvals or operations.

## Durability ordering

Every command that changes durable state runs as:

1. Validate the command against policy and the state machine (current projection).
2. `BEGIN IMMEDIATE`.
3. Append the event(s) with `seq = last_seq + 1, …` and update the projections in the same transaction.
4. `COMMIT` (WAL mode, `synchronous=FULL` for the event table — proposal).
5. Only now: publish to subscribers, answer the agent, start the process or operation.

| Durability | Meaning | Examples |
| --- | --- | --- |
| `persist_then_report` | Nobody (UI, subscribers, agent) sees the new state before it is committed. | `verifying → review`, `ci → completed`, `active → idle` |
| `persist_then_act` | The side effect that the event authorizes happens only after commit. If the process crashes between commit and action, recovery sees the intent and treats the action as *not known to have happened*. | `queued → preparing` (before spawning), approval resolution (before answering `session/request_permission`), `operation.recorded`/`operation.started` (before running `git push`), `running → cancelled` (before sending `session/cancel`) |

Streaming chunks are buffered for coalescing (≤ 100 ms proposal) and may be shown before they are durable; losing the last window on a crash is acceptable. Nothing that changes a state, an approval, an operation, a check or usage is ever shown before commit.

## Checkpoints

A checkpoint (`task.checkpoint_recorded`) is a consistent cut of one task at a `seq`:

- `through_seq` — every event of the task up to here is included.
- `phase` — the task state at that point.
- `worktree` — `head_sha`, `branch`, `dirty`, optional `diff_sha256` of `git diff HEAD` (content hash only, not the diff).
- `open_operation_ids`, `pending_approval_ids`.

Rules:

- Recorded on entering `verifying`, `review`, `pr`, `ci`, before starting a non-repeatable operation, and on interruption (proposal; the fixtures include a few checkpoints but `validate_fixtures.py` does not yet enforce when they must appear).
- A checkpoint never replaces events; it is an index for fast resume and for drift detection.
- **Drift check on resume**: before `T04`/`T05`–`T08`, AgentDock compares the worktree with the last checkpoint. If `head_sha` or the branch changed, or the tree is dirty when the checkpoint was clean, it does not continue automatically; it asks the user (the user may have edited the worktree by hand). The decision is recorded as a normal command/event.

## Crash recovery (host restart)

On start, before accepting commands, AgentDock runs recovery inside `system.recovery_started` … `system.recovery_completed`. Only `recovery`-actor events may be written in between, and recovery only ever moves things **towards a safe stop**:

1. Verify the event table: `seq` contiguous per authority, projections consistent with the last events (rebuild from events if not).
2. For every session in `starting`, `idle`, `active`, `awaiting_permission`, `suspended`: agent processes do not survive a host crash → `→ disconnected (host_recovery)`.
3. Every `pending` approval → `approval.resolved{state: invalidated}`. **Never** approved, never carried over. The agent (if reattached) has to ask again and the user decides again.
4. Every host-policy approval that is `approved` but not yet consumed by an `operation.started` → `approval.resolved{state: invalidated}` too. A grant never survives a crash: the user saw the situation before the crash, not after it.
5. Every operation in `started` → `operation.outcome_unknown{cause: host_crash}`. Nothing is retried.
6. Every operation still `recorded` (never started) → `operation.abandoned{reason: host_recovery}`. It may be superseded later with a fresh approval.
7. Every check in `running` → `check.finished{state: outcome_unknown}`.
8. Every task in `preparing`, `running`, `awaiting_approval`, `verifying`, `review`, `pr`, `ci` → `interrupted{reason: host_crashed, phase, auto_resume_armed: false, open_operation_ids}`. Tasks in `queued`, `interrupted`, `failed` and terminal states are left alone.
9. `system.recovery_completed` lists exactly what was changed (`tasks_interrupted`, `sessions_disconnected`, `approvals_invalidated`, `operations_marked_unknown`, `operations_abandoned`, `checks_marked_unknown`). After it, no approval is `pending` or approved-but-unused, and no operation is `recorded` or `started`.

After a crash nothing resumes automatically. A host-crash interruption is never auto-resumable (`auto_resume_armed` must be false); the user explicitly resumes.

## Non-repeatable operations

### Classification

| `OperationKind` | Repeatability (schema-enforced) | Task states where it may be recorded and started | Who may approve | Reconcile strategy (read-only probe) |
| --- | --- | --- | --- | --- |
| `git_push` | non_repeatable | `pr` | user or policy | `remote_ref_compare` — `git ls-remote` the target ref and compare with `expected_sha` |
| `pr_create`, `pr_update` | non_repeatable | `pr` | user or policy | `pr_lookup_by_head` — find an open PR whose head is the branch |
| `pr_comment` | non_repeatable, or `idempotent_with_key` with a provider idempotency key | `review`, `pr`, `ci` | user or policy | `none` |
| `pr_merge` | non_repeatable | `ci` | **user only** | `pr_state_lookup` — is the PR merged, by which commit |
| `branch_delete` | non_repeatable | `completed`, `cancelled`, `failed` (cleanup) | **user only** | `branch_exists_lookup` |
| `worktree_remove` | non_repeatable | `completed`, `cancelled`, `failed` (cleanup) | **user only** | `path_exists_lookup` |
| `destructive_command` (`rm -rf`, `git reset --hard`, `git clean -fdx`, force push, DB writes, ...) | non_repeatable | `running` | **user only** | `none` → after a crash the finding is always `undeterminable` |
| `external_write` | non_repeatable, or `idempotent_with_key` when the target honors a client key | `running` | user or policy | depends |

There is no `repeatable` operation: repeatable work (tests, lint, build) is a `Check`, re-run as part of the workflow, not "replayed". A force push is classified `destructive_command`, never `git_push`.

"User only" means `approval.resolved{state: approved}` must have actor `user`; policy may still deny or let such an approval expire. Every policy decision (`approved`/`denied` by actor `policy`) names its `policy_rule_id`. Approvals requested while the task is `running`, `pr` or `ci` are blocking (`return_state` = that state, followed by `T12`/`T33`/`T40`); approvals in `verifying`/`review` and cleanup approvals in `completed`/`cancelled`/`failed` are non-blocking (no `return_state`, no task transition). Approvals cannot be requested in any other state.

### Rules

1. **Intent before effect.** `operation.recorded` (kind, target, `idempotency_key`, `reconcile_strategy`, `approval_id`) is committed before anything else.
2. **Fingerprint-bound approval.** `idempotency_key` = sha256 (lowercase hex) of the canonical JSON of `{"kind": kind, "target": target}`: object keys sorted, no insignificant whitespace, UTF-8, non-ASCII characters not escaped (Python: `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")`). For the string and integer values used in targets this equals RFC 8785 (JCS). The host-policy approval's `operation_fingerprint` equals the `idempotency_key`; both are recomputed by `validate_fixtures.py`. ACP permission fingerprints use the same form with `{"kind": "tool_call", "target": {"tool_call_id": ..., "title": ...}}`. A grant authorizes only that exact operation; a changed target is a new operation and a new approval.
3. **One approval, one execution.** `operation.recorded` names a fresh `approval_id`; the host-policy `approval.requested` follows it with the same id, kind and fingerprint. An approval with scope `once` is consumed by the first `operation.started`. `operation.started` requires that approval to be `approved`, from the same task, and the task to be in a state where the kind may run (table above). It is never written by `recovery`.
4. **At most once per operation id.** An operation goes `recorded → started → succeeded | failed | outcome_unknown`, or `recorded → abandoned` if it never starts (approval denied/expired/cancelled/invalidated, task left the phase, crash recovery). There is no `started → started`. Before abandoning, the approval must not be `pending` or approved-but-unused (cancel or invalidate it first).
5. **No duplicates by key.** A second operation with the same `idempotency_key` is allowed only if it names the previous one in `supersedes_operation_id` and the previous one is `abandoned`, `failed{effect: none}`, `reconciled_not_applied` or `reconciled_undeterminable` (or `outcome_unknown` when the kind is `idempotent_with_key`, because the target dedupes); it always needs its own new approval. A `recorded` or `started` operation cannot be superseded. If the previous one `succeeded` or was `reconciled_applied`, the work is done and must not be redone.
6. **Reconciliation is live and read-only.** After a crash, `outcome_unknown` operations are reconciled by the orchestrator/integration (never inside recovery) using the strategy; result `applied`, `not_applied` or `undeterminable`. `T07`/`T08` (resume into `pr`/`ci`) are blocked until every operation of the task is in a final state.
7. **Undeterminable means ask.** For `undeterminable` the user is shown the evidence and decides; a retry is a new superseding operation with a new approval.
8. **Leaving a phase closes its operations.** Before a task goes to `interrupted`, `cancelled` or `failed` (`no_open_operations`), recorded operations are abandoned, unused grants are invalidated, and started operations are killed and recorded as `operation.outcome_unknown{cause: killed}` (actor `orchestrator`). The kill is recorded *before* the transition, so a crash in between leaves an `outcome_unknown` operation that recovery and reconciliation already handle.

## Interruptions, summaries and auto-resume

- Every `interrupted` state carries an `Interruption { reason, phase, detail?, retry_hint?, auto_resume_armed, summary_id?, open_operation_ids? }`. `phase` bounds `T44`: `resume_phase` must be at or before it (`running < verifying < review < pr < ci`), so a resume can never skip verification, review or PR creation. `reason: session_unavailable` is used when reattach was rejected (`S03 attach_rejected`).
- `retry_hint.source`:
  - `provider_reported` — the agent/provider said when the limit resets (e.g. a rate-limit header or an error message with a reset time). `not_before` is that time.
  - `user_configured` — the user told AgentDock when to try again (e.g. "my plan resets at 15:00").
  - `unknown` — no time is known; `not_before` must be absent. The UI says "unknown", never a guessed countdown.
- `auto_resume_armed` may be true only if the reason is `quota_exhausted` or `rate_limited`, the task's `auto_resume_policy` opts in for that reason, and `retry_hint` has a `not_before` from `provider_reported` or `user_configured`. At or after `not_before` the orchestrator may perform `T44` with `trigger: scheduled_resume`. Everything else needs the user.
- The user changes the policy with `task.policy_updated{auto_resume_policy}`. Turning the relevant flag off disarms an armed interruption immediately; turning it on never arms an interruption that already exists (the user resumes it or it is armed by the next interruption).
- **Summary on interruption.** Before or with the interruption, AgentDock records `session.summary_recorded{purpose: interruption}`. When the cause is quota, the agent usually cannot write one (no quota left), so the default is `source: host_generated`: a deterministic digest from the event log (last plan, files touched, last checks, open operations, last agent message excerpt). `agent_generated` is used only when the agent produced one before stopping; `user_written` when the user adds notes.
- **Continuing after reset.** If the old session is still `suspended` and alive, `S17 suspended → active (continue_prompt)`. If the process died and the adapter can reattach, `S20`. Otherwise a task-level restart: the old session goes `superseded`, a new session is created with `handoff_summary_id`, and its first prompt has `origin: handoff`.

## Remote authority (later milestone)

- The remote worker is the authority for its tasks and runs the same recovery and operation rules locally.
- The desktop mirrors events by `(authority_id, seq)`; on reconnect it requests `after_seq` and reconciles projections from events. It never writes events for a remote authority; user actions travel as commands.
- If the requested cursor is older than the worker's retention, the worker answers `retention_gap`; durable events remain available.
