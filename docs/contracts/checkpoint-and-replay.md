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
4. Every operation in `started` → `operation.outcome_unknown`. Nothing is retried.
5. Every check in `running` → `check.finished{state: outcome_unknown}`.
6. Every task in `preparing`, `running`, `awaiting_approval`, `verifying`, `review`, `pr`, `ci` → `interrupted{reason: host_crashed, auto_resume_armed: false, open_operation_ids}`. Tasks in `queued`, `interrupted`, `failed` and terminal states are left alone.
7. `system.recovery_completed` lists exactly what was changed.

After a crash nothing resumes automatically. A host-crash interruption is never auto-resumable (`auto_resume_armed` must be false); the user explicitly resumes.

## Non-repeatable operations

### Classification

| `OperationKind` | Repeatability | Reconcile strategy (read-only probe) |
| --- | --- | --- |
| `git_push` | non_repeatable | `remote_ref_compare` — `git ls-remote` the target ref and compare with `expected_sha` |
| `pr_create` | non_repeatable | `pr_lookup_by_head` — find an open PR whose head is the branch |
| `pr_comment` | non_repeatable | `none` (or provider idempotency key if available → `idempotent_with_key`) |
| `pr_merge` | non_repeatable | `pr_state_lookup` — is the PR merged, by which commit |
| `branch_delete` | non_repeatable | `branch_exists_lookup` |
| `worktree_remove` | non_repeatable | `path_exists_lookup` |
| `destructive_command` (`rm -rf`, `git reset --hard`, `git clean -fdx`, DB writes, ...) | non_repeatable | `none` → after a crash the finding is always `undeterminable` |
| `external_write` | non_repeatable, or `idempotent_with_key` when the target honors a client key | depends |

Checks (`cargo test`, lint) are not operations; they are repeatable by definition and re-run as part of the workflow, not "replayed".

### Rules

1. **Intent before effect.** `operation.recorded` (kind, target, `idempotency_key`, `reconcile_strategy`, `approval_id`) is committed before anything else.
2. **Fingerprint-bound approval.** `idempotency_key` = sha256 over the canonical JSON of `{kind, target}` and equals the approval's `operation_fingerprint`. A grant authorizes only that exact operation; a changed target is a new operation and a new approval.
3. **One approval, one execution.** An approval with scope `once` is consumed by the first `operation.started`. `operation.started` requires an `approved` approval (for non-repeatable kinds) and is never written by `recovery`.
4. **At most once per operation id.** An operation goes `recorded → started → succeeded | failed | outcome_unknown`. There is no `started → started`.
5. **No duplicates by key.** A second operation with the same `idempotency_key` is allowed only if it names the previous one in `supersedes_operation_id` and the previous one is `failed{effect: none}`, `reconciled_not_applied`, or `reconciled_undeterminable`; it always needs its own new approval. If the previous one `succeeded` or was `reconciled_applied`, the work is done and must not be redone.
6. **Reconciliation is live and read-only.** After a crash, `outcome_unknown` operations are reconciled by the orchestrator/integration (never inside recovery) using the strategy; result `applied`, `not_applied` or `undeterminable`. `T07`/`T08` (resume into `pr`/`ci`) are blocked until every operation of the task is in a final state.
7. **Undeterminable means ask.** For `undeterminable` the user is shown the evidence and decides; a retry is a new superseding operation with a new approval.

## Interruptions, summaries and auto-resume

- Every `interrupted` state carries an `Interruption { reason, detail?, retry_hint?, auto_resume_armed, summary_id?, open_operation_ids? }`.
- `retry_hint.source`:
  - `provider_reported` — the agent/provider said when the limit resets (e.g. a rate-limit header or an error message with a reset time). `not_before` is that time.
  - `user_configured` — the user told AgentDock when to try again (e.g. "my plan resets at 15:00").
  - `unknown` — no time is known; `not_before` must be absent. The UI says "unknown", never a guessed countdown.
- `auto_resume_armed` may be true only if the reason is `quota_exhausted` or `rate_limited`, the task's `auto_resume_policy` opts in for that reason, and `retry_hint` has a `not_before` from `provider_reported` or `user_configured`. At or after `not_before` the orchestrator may perform `T44` with `trigger: scheduled_resume`. Everything else needs the user.
- **Summary on interruption.** Before or with the interruption, AgentDock records `session.summary_recorded{purpose: interruption}`. When the cause is quota, the agent usually cannot write one (no quota left), so the default is `source: host_generated`: a deterministic digest from the event log (last plan, files touched, last checks, open operations, last agent message excerpt). `agent_generated` is used only when the agent produced one before stopping; `user_written` when the user adds notes.
- **Continuing after reset.** If the old session is still `suspended` and alive, `S17 suspended → active (continue_prompt)`. If the process died and the adapter can reattach, `S20`. Otherwise a task-level restart: the old session goes `superseded`, a new session is created with `handoff_summary_id`, and its first prompt has `origin: handoff`.

## Remote authority (later milestone)

- The remote worker is the authority for its tasks and runs the same recovery and operation rules locally.
- The desktop mirrors events by `(authority_id, seq)`; on reconnect it requests `after_seq` and reconciles projections from events. It never writes events for a remote authority; user actions travel as commands.
- If the requested cursor is older than the worker's retention, the worker answers `retention_gap`; durable events remain available.
