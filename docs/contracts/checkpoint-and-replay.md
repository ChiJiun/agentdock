# Checkpoint consistency, recovery and replay policy

Status: Proposed with [ADR-0003](../decisions/0003-task-session-event-contracts.md). [`validate_fixtures.py`](validate_fixtures.py) regression-checks the committed fixtures against these rules; what that does and does not show is in the [Enforcement boundary](README.md#enforcement-boundary). The rules themselves are enforced by the Rust backend (issues #7, #8, #10).

## Three different things called "resume"

| Concept | What it does | Needs the agent? | Always available? | Contract |
| --- | --- | --- | --- | --- |
| **History restoration** | Rebuild the UI timeline (messages, tool calls, approvals, checks) from AgentDock's own event log. Read-only. | No | Yes | Projection over events; no event is written. |
| **External session reattach** | Start a new agent process and call ACP `session/load` (agent replays history) or `session/resume` (no replay) with the stored `external_session_id`. Same AgentDock `session_id`. | Yes | Only if the *current* process advertises it | `S20 disconnected → starting (reattach_attempt, launch_method)` then `S02` or `S03 (attach_rejected)`. |
| **Task-level restart** | Re-enter the task's workflow at `resume_phase` with a **new** session (`launch_method: new`, `supersedes_session_id`), seeded with a handoff summary and the current worktree. | A fresh one | Yes | `T44 interrupted → queued (resume_phase)` → `T02` → `T04`/`T05`–`T08` (a retry, `T47 failed → queued`, has no `resume_phase` and always continues with `T04`, i.e. from `running`); `session.created{supersedes_session_id, handoff_summary_id}`; `session.prompt_submitted{origin: handoff}`. |

"Replay" has exactly two meanings in AgentDock and they must not be confused:

- **Event replay** — re-reading the event log to rebuild projections or the UI. Always safe, has no side effects.
- **Operation replay** — executing a side effect again. **Forbidden** for non-repeatable operations unless reconciliation proved it did not happen *and* a new approval was granted. There is no code path that re-executes an operation because it appears in the log.

An agent's `session/load` history replay is event *ingestion* tagged `provenance: acp_replay`; it never triggers tool execution, approvals or operations. It is accepted only as `session.message_delta`, `session.tool_call` or `session.plan_updated`, and only after the process started for this load has advertised `loadSession` in its own capability snapshot.

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

- Recorded on entering `verifying`, `review`, `pr`, `ci`, before starting a non-repeatable operation, and on interruption (proposal). `validate_fixtures.py` enforces only two parts: a checkpoint's `phase` equals the task state, and a `git_push` starts only after a clean checkpoint whose `head_sha` is the pushed commit (rule 9 below); the other placement rules are for issue #7.
- A checkpoint never replaces events; it is an index for fast resume and for drift detection.
- **Drift check on resume**: before `T04`/`T05`–`T08`, AgentDock compares the worktree with the last checkpoint. If `head_sha` or the branch changed, or the tree is dirty when the checkpoint was clean, it does not continue automatically; it asks the user (the user may have edited the worktree by hand). The decision is recorded as a normal command/event.

## Crash recovery (host restart)

On start, before accepting commands, AgentDock runs recovery inside `system.recovery_started` … `system.recovery_completed`. Only `recovery`-actor events may be written in between, the recovery actor writes nothing outside this bracket, and recovery only ever moves things **towards a safe stop**. The complete list of what the recovery actor may write is: `approval.resolved{state: invalidated}`, `operation.outcome_unknown{cause: host_crash}`, `operation.abandoned{reason: host_recovery}`, `check.finished{state: outcome_unknown}`, `session.state_changed` to `disconnected` with trigger `host_recovery`, `task.state_changed` to `interrupted{reason: host_crashed}`, and the two `system.*` events. In particular it never writes a result (`operation.succeeded`, `operation.failed`, a passed or failed check): recovery cannot know one, and a made-up `failed{effect: none}` would let the same push be superseded and run twice. The steps:

1. Verify the event table: `seq` contiguous per authority, projections consistent with the last events (rebuild from events if not).
2. For every session in `starting`, `idle`, `active`, `awaiting_permission`, `suspended`: agent processes do not survive a host crash → `→ disconnected (host_recovery)`.
3. Every `pending` approval → `approval.resolved{state: invalidated}`. **Never** approved, never carried over. The agent (if reattached) has to ask again and the user decides again.
4. Every host-policy approval that is `approved` but not yet consumed by an `operation.started` → `approval.resolved{state: invalidated}` too. A grant never survives a crash: the user saw the situation before the crash, not after it.
5. Every operation in `started` → `operation.outcome_unknown{cause: host_crash}`. Nothing is retried.
6. Every operation still `recorded` (never started) → `operation.abandoned{reason: host_recovery}`. It may be superseded later with a fresh approval.
7. Every check in `running` → `check.finished{state: outcome_unknown}`.
8. Every task in `preparing`, `running`, `awaiting_approval`, `verifying`, `review`, `pr`, `ci` → `interrupted{reason: host_crashed, phase, auto_resume_armed: false, open_operation_ids}`. Tasks in `queued`, `interrupted`, `failed` and terminal states are left alone.
9. `system.recovery_completed` (written by the recovery actor) lists exactly what was changed (`tasks_interrupted`, `sessions_disconnected`, `approvals_invalidated`, `operations_marked_unknown`, `operations_abandoned`, `checks_marked_unknown`). After it, no approval is `pending` or approved-but-unused, no operation is `recorded` or `started`, no check is `running`, no session is live and no task is in flight. In a log where one of those tasks was deleted later, the recovery events of that task are tombstones and no longer show their approval/operation/check ids; `validate_fixtures.py` can then only check that the list holds the right number of extra ids and that none of them is the id of an entity that exists in the stream. The backend writes the list in the recovery transaction, where every id is known.

After a crash nothing resumes automatically. A host-crash interruption is never auto-resumable (`auto_resume_armed` must be false); the user explicitly resumes.

## Non-repeatable operations

### Classification

| `OperationKind` | Identity fields in `target` (schema-enforced, exactly these) | Repeatability (schema-enforced) | Task states where it may be recorded and started | Who may approve | Reconcile strategy (read-only probe) |
| --- | --- | --- | --- | --- | --- |
| `git_push` | `remote`, `ref`, `expected_sha` | non_repeatable | `pr` | user, or policy via a user-level rule (default is ask, ADR-0002 APR-10) | `remote_ref_compare` — `git ls-remote` the target ref and compare with `expected_sha` |
| `pr_create` | `ref` (head), `base` | non_repeatable | `pr` | user or policy | `pr_lookup_by_head` — find an open PR whose head is the branch |
| `pr_update` | `pr_number`, `content_sha256` | non_repeatable | `pr` | user or policy | `pr_lookup_by_head` |
| `pr_comment` | `pr_number`, `content_sha256` | non_repeatable, or `idempotent_with_key` with a provider idempotency key | `review`, `pr`, `ci` | user or policy | `none` |
| `pr_merge` | `pr_number`, `expected_sha` (the PR head; `--match-head-commit`) | non_repeatable | `ci` | **user only** | `pr_state_lookup` — is the PR merged, by which commit |
| `branch_delete` | `ref`, `expected_sha`, optional `remote` (absent = local branch) | non_repeatable | `completed`, `cancelled`, `failed` (cleanup) | **user only** | `branch_exists_lookup` |
| `worktree_remove` | `path` (relative to the project's worktree root) | non_repeatable | `completed`, `cancelled`, `failed` (cleanup) | **user only** | `path_exists_lookup` |
| `destructive_command` (`rm -rf`, `git reset --hard`, `git clean -fdx`, force push, DB writes, ...) | `command_sha256` (canonical unwrapped argv), `cwd` | non_repeatable | `running` | **user only** | `none` → after a crash the finding is always `undeterminable` |
| `external_write` | `endpoint`, `content_sha256` | non_repeatable, or `idempotent_with_key` when the target honors a client key | `running` | user or policy | depends |

`target.description` is the text the user sees; it is never part of the identity, so rewording a request cannot make the same work look new. `content_sha256` / `command_sha256` are digests computed before redaction; the content itself is not part of the target.

There is no `repeatable` operation: repeatable work (tests, lint, build) is a `Check`, re-run as part of the workflow, not "replayed". A force push is classified `destructive_command`, never `git_push`.

"User only" means `approval.resolved{state: approved}` must have actor `user`; policy may still deny or let such an approval expire. Every policy decision (`approved`/`denied` by actor `policy`) names its `policy_rule_id`.

The same holds for ACP permission requests: their `operation_kind` is always `tool_call`, and the backend's `classified_kind` (`PolicyClass`, computed in Rust from the unwrapped command, path or URL, never from agent text) decides. Classes `pr_merge`, `force_push`, `branch_delete`, `worktree_remove`, `destructive_command` and `unclassified` (command not recoverable, APR-7) are user-only.

**Scope of the user-only guarantee** (ADR-0002 APR-11). It covers what AgentDock is asked to approve and what AgentDock itself executes:

- When an agent runs in its own bypass or full-access mode (Claude Code `bypassPermissions`, Codex full access) it sends no permission request and executes its own tools. AgentDock cannot intercept those; the UI must label such a session as not policy-enforced (issue #26). Nothing in this contract claims otherwise.
- When AgentDock itself executes an ACP client request (`terminal/create`, `fs/write_text_file`) whose classification names an operation kind (`git_push`, `pr_write`, `pr_merge`, `force_push`, `branch_delete`, `worktree_remove`, `destructive_command`, `external_write`), it runs it only as an `Operation` with its own host-policy approval (`force_push` as `destructive_command`), never on the strength of the ACP permission alone. Other classes (`read_only`, `workspace_edit`, `command`, `config_write`) run under the ACP permission plus the workspace scope checks. Enforcing this is issue #8; the fixtures do not exercise client-method execution. Approvals requested while the task is `running`, `pr` or `ci` are blocking (`return_state` = that state, followed by `T12`/`T33`/`T40`); approvals in `verifying`/`review` and cleanup approvals in `completed`/`cancelled`/`failed` are non-blocking (no `return_state`, no task transition). Approvals cannot be requested in any other state.

### Rules

1. **Intent before effect.** `operation.recorded` (kind, target, `idempotency_key`, `reconcile_strategy`, `approval_id`) is committed before anything else.
2. **Fingerprint-bound approval.** `idempotency_key` = sha256 (lowercase hex) of the canonical JSON of `{"kind": kind, "identity": identity}`, where `identity` is `target` without `description` (the identity fields per kind are in the table above): object keys sorted, no insignificant whitespace, UTF-8, non-ASCII characters not escaped (Python: `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")`). For the string and integer values used in targets this equals RFC 8785 (JCS). The host-policy approval's `operation_fingerprint` equals the `idempotency_key`; both are recomputed by `validate_fixtures.py`. ACP permission fingerprints use the same form with `{"kind": "tool_call", "target": {"tool_call_id": ..., "title": ...}}`. A grant authorizes only that exact operation; a changed identity is a new operation and a new approval, while a changed description is the same operation.
3. **One approval, one execution.** `operation.recorded` names a fresh `approval_id`; the host-policy `approval.requested` follows it with the same id, kind and fingerprint. An approval with scope `once` is consumed by the first `operation.started`. `operation.started` requires that approval to be `approved`, from the same task, and the task to be in a state where the kind may run (table above). It is never written by `recovery`.
4. **At most once per operation id.** An operation goes `recorded → started → succeeded | failed | outcome_unknown`, or `recorded → abandoned` if it never starts (approval denied/expired/cancelled/invalidated, task left the phase, crash recovery). There is no `started → started`. Before abandoning, the approval must not be `pending` or approved-but-unused (cancel or invalidate it first).
5. **No duplicates by key.** A second operation with the same `idempotency_key` is allowed only if it names the previous one in `supersedes_operation_id` and the previous one is `abandoned`, `failed{effect: none}`, `reconciled_not_applied` or `reconciled_undeterminable` (or `outcome_unknown` when the kind is `idempotent_with_key`, because the target dedupes); it always needs its own new approval. A `recorded` or `started` operation cannot be superseded. If the previous one `succeeded` or was `reconciled_applied`, the work is done and must not be redone. Because `failed{effect: none}` opens the door to a second attempt, it may only be written when the executor knows nothing happened (the command was rejected before any remote effect); a killed or unanswered operation is `outcome_unknown`, never `failed`. The log cannot show whether that was honoured: it is a backend guarantee (issues #7/#10).
6. **Reconciliation is live and read-only.** After a crash, `outcome_unknown` operations are reconciled by the orchestrator/integration/user (never inside recovery) using the strategy; result `applied`, `not_applied` or `undeterminable`; with strategy `none` the only possible finding is `undeterminable`. Resume into `pr`/`ci` (`T07`/`T08`), `review → pr` (`T28`), `pr → ci` (`T34`), completion (`T29`/`T39`) and retry (`T47`) are blocked until no operation of the task is `recorded`, `started` or `outcome_unknown`. An ended task with an `outcome_unknown` operation shows `needs_reply / reconcile_needed`.
7. **Undeterminable means ask.** For `undeterminable` the user is shown the evidence and decides; a retry is a new superseding operation with a new approval.
8. **Leaving a phase closes its operations.** Before a task goes to `interrupted`, `cancelled` or `failed` (`no_open_operations`), recorded operations are abandoned, unused grants are invalidated, and started operations are killed and recorded as `operation.outcome_unknown{cause: killed}` (actor `orchestrator`). The kill is recorded *before* the transition, so a crash in between leaves an `outcome_unknown` operation that recovery and reconciliation already handle.
   - **A started `pr_merge` is uninterruptible** (ADR-0002 PRL-5). It is never killed; Pause/Cancel wait for its result (the UI disables them with an explanation), and only a host crash can make it `outcome_unknown`.
   - The other kinds stay killable because their outcome can be probed or must stay stoppable: `git_push` and `branch_delete` are atomic ref updates (`remote_ref_compare` / `branch_exists_lookup`); PR writes are single API calls found again by lookup; `destructive_command` and `external_write` must stay stoppable by the user (a runaway command), at the price of an `undeterminable` finding.
   - `branch_delete` and `worktree_remove` only run after the task ended, where no cancel/interrupt transition exists, and `T47` (retry) is blocked while they are open.
9. **Push and merge are bound to the published commit.** `operation.started` for `git_push` requires the task's latest checkpoint to be clean with `head_sha == expected_sha` (a checkpoint is recorded before a non-repeatable operation starts). `operation.started` for `pr_merge` requires its `expected_sha` to equal the `expected_sha` of the task's latest succeeded (or reconciled-applied) `git_push`, i.e. the PR head AgentDock published. The merge itself runs `gh pr merge --merge --match-head-commit <expected_sha>` and is confirmed `MERGED` afterwards (ADR-0002 PRL-1). That the latest *review* covered exactly this SHA and that the base did not change (PRL-1, PRL-11) is checked by the PR loop at merge time (issue #10), not by these fixtures.
10. **Expiry and actor.** An approval with `expires_at` authorizes nothing at or after that time; `operation.started` after it is rejected. `operation.started` is written only by the orchestrator.
11. **Results come from the executor.** `operation.succeeded` and `operation.failed` are written only by the `orchestrator` or the `integration` that ran the operation, and a check result likewise; never by `adapter` (an agent saying "pushed" is text), `policy`, `user` or `recovery`.

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
