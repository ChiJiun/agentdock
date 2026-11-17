# Task and Session state machines

Status: Proposed with [ADR-0003](../decisions/0003-task-session-event-contracts.md).
The machine-readable source of truth is [`transitions.json`](transitions.json); the tables below mirror it. If they disagree, `transitions.json` wins and this file is a bug.

## Rules that apply to every transition

- **Only listed transitions are legal.** Anything else is rejected by the orchestrator (and by `validate_fixtures.py`).
- **The agent never changes task state.** ACP traffic is an *input* (actor `adapter`) that the orchestrator interprets. An agent message that says "approved" or "done" is text, not a transition.
- **Every transition is an event.** `task.state_changed` / `session.state_changed` (or `task.created` / `session.created` for the first state). The projection (`tasks.state`, `sessions.state`) is updated in the same SQLite transaction as the event append.
- **Durability** (see [checkpoint-and-replay.md](checkpoint-and-replay.md#durability-ordering)):
  - `persist_then_report`: commit the event before any subscriber, UI or agent observes the new state. No optimistic UI for durable state.
  - `persist_then_act`: commit the event *before* performing the side effect it authorizes (spawning a process, answering `session/request_permission`, starting an operation, sending `session/cancel`).
- **Actors**: `user` (a human action in AgentDock), `orchestrator` (workflow engine), `policy` (host approval gate), `adapter` (AgentDock's adapter component reporting a protocol fact it observed from an ACP agent process; never the agent itself), `integration` (Git/GitHub/CI), `recovery` (startup crash recovery; may only write the events listed in [checkpoint-and-replay.md](checkpoint-and-replay.md#crash-recovery-host-restart), all of which move things *towards* a safe stop).
- **Why `adapter` appears on task transitions.** `T12` (the agent sent `session/request_permission`) and `T09`/`T14`/`T20`/`T30` (the agent process reported a quota limit, a rate limit or an authentication requirement, exited, or refused a reattach) are written by the adapter component because each is the mechanical consequence of a protocol fact and is committed in the same transaction as the session event it belongs to. They only stop or block a task; no adapter-written transition moves a task forward.

## Task states

| State | Meaning | Terminal? |
| --- | --- | --- |
| `queued` | Accepted, waiting for a concurrency slot. | no |
| `preparing` | Worktree, adapter process and session being set up (or re-established on resume). | no |
| `running` | An agent is implementing or repairing. The session may be idle waiting for the user. | no |
| `awaiting_approval` | Blocked on a *blocking* approval. Returns to `approval.return_state` (`running`, `pr` or `ci`). Approvals requested in `verifying`/`review` (e.g. by a review child session) and cleanup approvals after `completed`/`cancelled`/`failed` are non-blocking: no `return_state`, no task transition. | no |
| `verifying` | Local checks (tests, lint, build) are running or being evaluated. | no |
| `review` | Independent review (usually a child review session). | no |
| `pr` | Push / PR creation or update. All operations here are non-repeatable and approval-gated. | no |
| `ci` | Waiting on remote CI; merge (if any) is a separate approval-gated operation. | no |
| `completed` | Objective accepted. | yes |
| `interrupted` | Stopped by an external or user cause; can be resumed. Carries an `Interruption` record. | no |
| `failed` | The workflow cannot proceed without a human decision; can be retried. Carries a `Failure`. | no |
| `cancelled` | Stopped by the user for good. | yes |

`failed` is deliberately not terminal: "retry" (`T47`) is a user decision, never automatic. **A retry always restarts from `running`**: `T47` carries no `resume_phase` (the schema rejects it), so the only way out of `preparing` afterwards is `T04`, and the task passes verification, review and PR creation again.

**Paused** (mentioned in `architecture.md`) is not a separate state: it is `interrupted` with `reason = user_paused`. This keeps one resume path. See "Open questions" in the ADR.

```mermaid
stateDiagram-v2
    [*] --> queued
    queued --> preparing
    queued --> cancelled
    preparing --> running
    preparing --> verifying: resume_phase
    preparing --> review: resume_phase
    preparing --> pr: resume_phase
    preparing --> ci: resume_phase
    preparing --> interrupted
    preparing --> failed
    preparing --> cancelled
    running --> awaiting_approval
    awaiting_approval --> running: return_state
    pr --> awaiting_approval
    awaiting_approval --> pr: return_state
    ci --> awaiting_approval
    awaiting_approval --> ci: return_state
    awaiting_approval --> interrupted
    awaiting_approval --> cancelled
    running --> verifying
    running --> interrupted
    running --> failed
    running --> cancelled
    verifying --> running: checks failed
    verifying --> review
    verifying --> interrupted
    verifying --> failed
    verifying --> cancelled
    review --> running: blocking findings
    review --> pr
    review --> completed: accepted without PR
    review --> interrupted
    review --> failed
    review --> cancelled
    pr --> ci
    pr --> interrupted
    pr --> failed
    pr --> cancelled
    ci --> running: CI failed
    ci --> completed
    ci --> interrupted
    ci --> failed
    ci --> cancelled
    interrupted --> queued: resume
    interrupted --> failed
    interrupted --> cancelled
    failed --> queued: retry
    completed --> [*]
    cancelled --> [*]
```

### Task transitions

| ID | From | To | Actors | Triggers | Durability | Conditions |
| --- | --- | --- | --- | --- | --- | --- |
| T01 | `(new)` | `queued` | user | `task_created` | persist_then_report | — |
| T02 | `queued` | `preparing` | orchestrator | `scheduled` | persist_then_act | — |
| T03 | `queued` | `cancelled` | user | `user_cancel` | persist_then_report | — |
| T04 | `preparing` | `running` | orchestrator | `session_ready` | persist_then_report | — |
| T05 | `preparing` | `verifying` | orchestrator | `resume_phase_restored` | persist_then_report | `resume_phase_equals_to` |
| T06 | `preparing` | `review` | orchestrator | `resume_phase_restored` | persist_then_report | `resume_phase_equals_to` |
| T07 | `preparing` | `pr` | orchestrator | `resume_phase_restored` | persist_then_report | `resume_phase_equals_to`, `no_unreconciled_operations` |
| T08 | `preparing` | `ci` | orchestrator | `resume_phase_restored` | persist_then_report | `resume_phase_equals_to`, `no_unreconciled_operations`, `pr_published_this_round` |
| T09 | `preparing` | `interrupted` | orchestrator, adapter, recovery | `interruption` | persist_then_report | `no_open_operations` |
| T10 | `preparing` | `failed` | orchestrator | `preparation_failed` | persist_then_report | `no_open_operations` |
| T11 | `preparing` | `cancelled` | user | `user_cancel` | persist_then_act | `no_open_operations` |
| T12 | `running` | `awaiting_approval` | policy, adapter | `approval_requested` | persist_then_act | `approval_requested_before` |
| T13 | `running` | `verifying` | orchestrator, user | `implementation_done` | persist_then_report | — |
| T14 | `running` | `interrupted` | user, orchestrator, adapter, recovery | `interruption` | persist_then_report | `no_open_operations` |
| T15 | `running` | `failed` | orchestrator, policy | `unrecoverable_error` | persist_then_report | `no_open_operations` |
| T16 | `running` | `cancelled` | user | `user_cancel` | persist_then_act | `no_open_operations` |
| T17 | `awaiting_approval` | `running` | user, policy | `approval_resolved` | persist_then_act | `return_state_matches`, `approval_resolved_before` |
| T18 | `awaiting_approval` | `pr` | user, policy | `approval_resolved` | persist_then_act | `return_state_matches`, `approval_resolved_before` |
| T19 | `awaiting_approval` | `ci` | user, policy | `approval_resolved` | persist_then_act | `return_state_matches`, `approval_resolved_before` |
| T20 | `awaiting_approval` | `interrupted` | user, orchestrator, adapter, recovery | `interruption` | persist_then_report | `approval_not_pending_after`, `no_open_operations` |
| T21 | `awaiting_approval` | `cancelled` | user | `user_cancel` | persist_then_act | `approval_not_pending_after`, `no_open_operations` |
| T22 | `verifying` | `running` | orchestrator | `checks_failed` | persist_then_report | — |
| T23 | `verifying` | `review` | orchestrator | `checks_passed` | persist_then_report | `local_checks_passed` |
| T24 | `verifying` | `interrupted` | user, orchestrator, recovery | `interruption` | persist_then_report | `no_open_operations` |
| T25 | `verifying` | `failed` | orchestrator | `repair_limit_reached` | persist_then_report | `no_open_operations` |
| T26 | `verifying` | `cancelled` | user | `user_cancel` | persist_then_act | `no_open_operations` |
| T27 | `review` | `running` | orchestrator | `review_blocking_findings` | persist_then_report | — |
| T28 | `review` | `pr` | user, orchestrator | `review_passed` | persist_then_report | `no_unreconciled_operations` |
| T29 | `review` | `completed` | user | `accepted_without_pr` | persist_then_report | `no_unreconciled_operations` |
| T30 | `review` | `interrupted` | user, orchestrator, adapter, recovery | `interruption` | persist_then_report | `no_open_operations` |
| T31 | `review` | `failed` | orchestrator | `repair_limit_reached` | persist_then_report | `no_open_operations` |
| T32 | `review` | `cancelled` | user | `user_cancel` | persist_then_act | `no_open_operations` |
| T33 | `pr` | `awaiting_approval` | policy | `approval_requested` | persist_then_act | `approval_requested_before` |
| T34 | `pr` | `ci` | integration | `pr_published` | persist_then_report | `no_unreconciled_operations`, `pr_published_this_round` |
| T35 | `pr` | `interrupted` | user, orchestrator, integration, recovery | `interruption` | persist_then_report | `no_open_operations` |
| T36 | `pr` | `failed` | integration, orchestrator | `operation_failed` | persist_then_report | `no_open_operations` |
| T37 | `pr` | `cancelled` | user | `user_cancel` | persist_then_act | `no_open_operations` |
| T38 | `ci` | `running` | orchestrator | `ci_failed` | persist_then_report | — |
| T39 | `ci` | `completed` | user, integration | `ci_passed_accepted` | persist_then_report | `no_unreconciled_operations`, `ci_checks_passed`, `merge_evidence_if_integration` |
| T40 | `ci` | `awaiting_approval` | policy | `approval_requested` | persist_then_act | `approval_requested_before` |
| T41 | `ci` | `interrupted` | user, orchestrator, integration, recovery | `interruption` | persist_then_report | `no_open_operations` |
| T42 | `ci` | `failed` | orchestrator | `repair_limit_reached` | persist_then_report | `no_open_operations` |
| T43 | `ci` | `cancelled` | user | `user_cancel` | persist_then_act | `no_open_operations` |
| T44 | `interrupted` | `queued` | user, orchestrator | `resume_requested`, `scheduled_resume` | persist_then_act | `orchestrator_only_if_auto_resume_armed_and_due`, `resume_phase_within_interrupted_phase` |
| T45 | `interrupted` | `failed` | user, orchestrator | `abandoned` | persist_then_report | — |
| T46 | `interrupted` | `cancelled` | user | `user_cancel` | persist_then_report | — |
| T47 | `failed` | `queued` | user | `retry_requested` | persist_then_act | `no_unreconciled_operations`, `retry_restarts_from_running` |

`T39` with actor `user` is the user accepting a green CI run. With actor `integration` it requires merge evidence: a `pr_merge` operation of the task that `succeeded` (or was `reconciled_applied`). AgentDock's own `pr_merge` is an approval-gated operation inside `ci` (`T40`/`T19`), and only the user can grant that approval (see [checkpoint-and-replay.md](checkpoint-and-replay.md#rules)). A merge done by a human directly on GitHub is observed by the user, who completes the task with actor `user`.

Rules checked on **every** `task.state_changed`, in addition to the per-edge conditions:

- Unless `to` is `awaiting_approval`, no approval of the task may still be `pending`.
- No operation of the task may still be `recorded` once its approval was `denied`, `expired`, `cancelled` or `invalidated`; it must be `operation.abandoned` first.
- An operation that is `recorded` or `started` may stay open only if `to` is a state in which its kind may run (or `awaiting_approval`). The allowed states per kind are listed in [checkpoint-and-replay.md](checkpoint-and-replay.md#classification).

Interruption phase: every `Interruption` records `phase`, the furthest phase the task can be resumed into. It is the state being left if that is a phase (`running`, `verifying`, `review`, `pr`, `ci`); the `return_state` when leaving `awaiting_approval`; and, when leaving `preparing`, the `resume_phase` being restored (or `running`). `T44` may only choose a `resume_phase` at or before it, in the order `running < verifying < review < pr < ci`. Resuming never skips verification, review or PR creation. `resume_phase` exists only on this resume path: a retry (`T47`) has none and restarts from `running`.

Cancelling or interrupting while an operation is `started` (not a crash): the orchestrator kills the operation and records `operation.outcome_unknown{cause: killed}` first, then the transition. The operation is reconciled later by a live read-only probe. A `recorded` operation is `operation.abandoned` instead.

**Exception: a started `pr_merge` is never killed** (ADR-0002 PRL-5: a loop in `merging` cannot be cancelled; a restart never launches a duplicate merge). While a `pr_merge` is `started`, `T41`/`T42`/`T43` are rejected by `no_open_operations`; the UI disables Pause/Cancel with an explanation and the backend waits for `operation.succeeded`/`failed`. Only a host crash can leave it `outcome_unknown` (`cause: host_crash`, reconciled with `pr_state_lookup`). Other kinds stay killable, see [checkpoint-and-replay.md](checkpoint-and-replay.md#rules) rule 8.

Reconciliation gates: `no_unreconciled_operations` guards every way back into, or out of, the PR/CI part of the workflow: resume into `pr`/`ci` (`T07`/`T08`), `review → pr` (`T28`), `pr → ci` (`T34`), completion (`T29`, `T39`) and retry (`T47`). A task can therefore never re-enter `pr`/`ci` or complete while one of its operations is `outcome_unknown`. An ended task (`completed`/`cancelled`/`failed`) that still has one shows `needs_reply / reconcile_needed` ([attention.md](attention.md)).

### Conditions

| Condition | Meaning |
| --- | --- |
| `resume_phase_equals_to` | `payload.resume_phase == to`, and equals the `resume_phase` recorded when the task left `interrupted` (`T44` requires `resume_phase`). After a retry (`T47`) nothing is recorded, so `T05`–`T08` are rejected and only `T04` is possible. |
| `retry_restarts_from_running` | `T47` carries no `resume_phase` (also a schema rule): a retry always restarts from `running`. |
| `no_unreconciled_operations` | No operation of the task is `recorded`, `started` or `outcome_unknown`. Used on `T07`, `T08`, `T28`, `T29`, `T34`, `T39`, `T47`. |
| `no_open_operations` | No operation of the task is `recorded` or `started`, and no host-policy approval of the task is `approved` but unused. Abandon recorded operations, invalidate unused grants, and kill started operations (`outcome_unknown{cause: killed}`) before leaving the phase; a started `pr_merge` cannot be killed, so the transition waits for its result. |
| `resume_phase_within_interrupted_phase` | `resume_phase` is at or before `interruption.phase` (`running < verifying < review < pr < ci`). |
| `merge_evidence_if_integration` | If the actor is `integration`, a `pr_merge` operation of the task is `succeeded` or `reconciled_applied`. |
| `approval_requested_before` | The referenced approval was already persisted as `pending`, and it is a blocking approval whose `return_state` is the state being left. |
| `return_state_matches` | `to` equals the `return_state` recorded when the task entered `awaiting_approval` (which is always the state it left), and `approval_id` is the approval the task waited on. |
| `approval_resolved_before` | The approval's resolution event is already persisted. |
| `approval_not_pending_after` | No approval of this task (for `S15`: of this session) is still `pending`. Resolve them first (`cancelled` on user cancel, `invalidated` by recovery) in the same transaction. |
| `local_checks_passed` | At least one `local` check started since the task last entered `verifying`, and all of them `passed`. An approval detour does not reset the phase. |
| `ci_checks_passed` | Same, for `ci` checks since the task last entered `ci`. |
| `pr_published_this_round` | In the current PR round (since the task last went `review → pr`, `T28`; a resume via `T07` continues the same round), a `git_push` of this task `succeeded` or was `reconciled_applied`, and a PR exists: a `pr_create` that succeeded (in any round) or a `pr_update` in this round. Used on `T34` and `T08`. A second round after `ci → running` therefore needs a new push; an old round's push or PR does not count. |
| `orchestrator_only_if_auto_resume_armed_and_due` | A user may resume any time (`resume_requested`). The orchestrator may resume only with `scheduled_resume`, only if `interruption.auto_resume_armed` is true, and not before `retry_hint.not_before`. |
| `launch_method_advertised` | A capability snapshot was recorded for *this* launch, and it advertises the launch method used (`load` → `load_session`, `resume` → `resume_session`). |
| `reattach_capability_required` | The last snapshot for the session advertises the requested method and an `external_session_id` is known. |

## Session states

A Session is one conversation with one ACP agent process lineage. A Task has many Sessions (implementation, review, repair, explore). Sessions can have a `parent_session_id` (a "main" session with child sessions).

| State | Meaning |
| --- | --- |
| `starting` | Process spawned / `initialize` / `session/new`, `session/load` or `session/resume` in flight. |
| `idle` | Ready, no turn in progress (may be waiting for the user). |
| `active` | A `session/prompt` turn is in progress. |
| `awaiting_permission` | The agent sent `session/request_permission`; AgentDock has not answered. |
| `suspended` | The task was interrupted (quota, pause); the process may still be alive. |
| `disconnected` | The process is gone (exited, crashed, host crashed). The external session may or may not be reattachable. |
| `closed` | Finished; carries `outcome` (`succeeded`, `failed`, `cancelled`, `superseded`, `abandoned`). |
| `failed` | Could not start or broke the protocol; carries `outcome` `failed`, or `cancelled` when the launch failed because the task was being cancelled (schema rule: no other outcome). |

`closed` and `failed` are terminal for that `session_id`. A task-level restart creates a **new** Session with `supersedes_session_id`.

### Session transitions

| ID | From | To | Actors | Triggers | Durability | Conditions |
| --- | --- | --- | --- | --- | --- | --- |
| S01 | `(new)` | `starting` | orchestrator | `launch` | persist_then_act | — |
| S02 | `starting` | `idle` | adapter | `session_ready` | persist_then_report | `launch_method_advertised` |
| S03 | `starting` | `failed` | adapter, orchestrator | `launch_failed`, `attach_rejected` | persist_then_report | — |
| S04 | `starting` | `disconnected` | adapter, recovery | `process_exited`, `host_recovery` | persist_then_report | — |
| S05 | `idle` | `active` | user, orchestrator | `prompt_submitted` | persist_then_act | — |
| S06 | `idle` | `closed` | user, orchestrator | `session_closed` | persist_then_act | — |
| S07 | `idle` | `suspended` | user, orchestrator | `task_interrupted` | persist_then_report | — |
| S08 | `idle` | `disconnected` | adapter, recovery | `process_exited`, `host_recovery` | persist_then_report | — |
| S09 | `active` | `idle` | adapter | `turn_ended` | persist_then_report | — |
| S10 | `active` | `awaiting_permission` | adapter | `permission_requested` | persist_then_act | — |
| S11 | `active` | `suspended` | user, orchestrator, adapter | `task_interrupted` | persist_then_report | — |
| S12 | `active` | `disconnected` | adapter, recovery | `process_exited`, `host_recovery` | persist_then_report | — |
| S13 | `active` | `failed` | adapter, orchestrator | `protocol_error` | persist_then_report | — |
| S14 | `awaiting_permission` | `active` | user, policy | `permission_resolved` | persist_then_act | `approval_resolved_before` |
| S15 | `awaiting_permission` | `idle` | adapter | `turn_ended` | persist_then_report | `approval_not_pending_after` |
| S16 | `awaiting_permission` | `disconnected` | adapter, recovery | `process_exited`, `host_recovery` | persist_then_report | — |
| S17 | `suspended` | `active` | user, orchestrator | `continue_prompt` | persist_then_act | — |
| S18 | `suspended` | `closed` | user, orchestrator | `superseded`, `session_closed` | persist_then_act | — |
| S19 | `suspended` | `disconnected` | adapter, recovery | `process_exited`, `host_recovery` | persist_then_report | — |
| S20 | `disconnected` | `starting` | orchestrator | `reattach_attempt` | persist_then_act | `reattach_capability_required` |
| S21 | `disconnected` | `closed` | user, orchestrator | `abandoned`, `superseded` | persist_then_report | — |
| S22 | `idle` | `failed` | adapter, orchestrator | `protocol_error` | persist_then_report | — |
| S23 | `awaiting_permission` | `failed` | adapter, orchestrator | `protocol_error` | persist_then_report | `approval_not_pending_after` |
| S24 | `suspended` | `failed` | adapter, orchestrator | `protocol_error` | persist_then_report | — |
| S25 | `starting` | `closed` | user, orchestrator | `session_closed`, `superseded` | persist_then_act | — |

Additional session rules:

- `S05`/`S17` require a `session.prompt_submitted` with the same `turn_id` first.
- `S09`/`S15` carry the ACP v1 `stopReason` verbatim (`end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`).
- `S10` requires the ACP permission to be persisted as a pending `Approval` first (`persist_then_act`: AgentDock must be able to show it after a crash).
- When a turn is cancelled, every pending `session/request_permission` is answered `cancelled` (ACP v1 requirement) and recorded as `approval.resolved{state: cancelled}` before the session leaves `awaiting_permission` (also before `S23`).
- `S03` with `attach_rejected`: the agent refused `session/load` / `session/resume`. The task is then interrupted with `reason: session_unavailable` (`T09`), so the user decides whether to restart with a new session.
- History re-sent by the agent during `session/load` (`provenance: acp_replay`) is accepted only while the session is `starting` with launch method `load`, only after a `session.capabilities_detected` recorded for this launch advertises `loadSession` (the snapshot of the previous process, which `S20` looks at, is not enough), and only as `session.message_delta`, `session.tool_call` or `session.plan_updated`.
- `S22`–`S24`: a protocol error can happen while idle, while asking for permission, or while suspended. `S25` closes a session that is still starting (for example when the task is cancelled during `preparing`).
- Late prompt response after `S11`: if the agent answers the cancelled `session/prompt` while the session is `suspended`, the session stays `suspended`; the `stopReason` and `turn_id` are recorded on the next transition out of `suspended` (`stop_reason` is allowed on any `session.state_changed`). It never moves the session back to `idle` on its own.
- `session.output_limited{action: turn_cancelled}` sends `session/cancel`; the turn then ends with `stopReason: cancelled`. Attention shows it as `output_limited`, not as a user cancel.

## Archiving sessions

These rules implement the merged UX spec (`docs/ux/states-and-indicators.md` section 5, acceptance criteria UX-40 to UX-47). "Archived" in the UX is `Session.archived` here; the events are `session.archived{by}` and `session.unarchived{by}`.

- **Viewed vs opened.** `session.result_acknowledged{method}` records that the user viewed a result: `opened` (rendered on screen while the window had focus), `marked_reviewed` (one row) or `bulk_marked_reviewed` ("Mark completed as reviewed", only for a `closed` session with outcome `succeeded`/`cancelled`). Any method clears the needs-review item; only `opened` satisfies the auto-archive rule.
- **Automatic archive** (`by: auto`, actor `orchestrator`) is allowed only when all hold: the session has a `parent_session_id`; it is in state `closed` with outcome `succeeded` or `cancelled` (the UX states `completed`/`cancelled`); its result was `opened` after it finished; and the user never restored it. The UI emits it only after the user navigated away (rows never disappear while focused, hovered or on screen; that part is a UI rule and not checkable from events).
- **Never automatically archived:** a session without a parent (the main session, UX-40), a child in state `failed` whatever its outcome (a protocol error, a failed launch or attach; this is the UX state `failed`, UX-42), a `closed` child with outcome `failed`, `superseded` or `abandoned` (UX-42), and a child the user restored (UX-41, UX-46). Requiring state `closed` is the rule; in addition the schema lets a session enter `failed` only with outcome `failed` or `cancelled`. Forcing the outcome to `failed` was not possible, because a launch that fails while its task is being cancelled is `failed` with outcome `cancelled` (fixture 03).
- **Manual archive** (`by: user`, actor `user`) only in a terminal state: a child that is `closed`/`failed`; a main session when its task is `completed`, `failed`, `cancelled`, or `interrupted` for a reason other than `user_paused` (UX-40 and UX section 5: a running, queued, paused or awaiting session must be stopped first). "Paused" is `interrupted{user_paused}`, so it is excluded although it is an `interrupted` task; `queued`, `preparing`, `running`, `awaiting_approval`, `verifying`, `review`, `pr` and `ci` are excluded as running/queued/awaiting. A session that is waiting for the user (see "Waiting wins over archived") cannot be archived either.
- **Restore.** `session.unarchived{by: user}` (Undo or Unarchive) marks the session restored; it is never auto-archived again but can still be archived manually.
- **Waiting wins over archived** (UX-47). If an archived session starts waiting for the user — a `needs_reply` item names it, a task-level `needs_reply` item exists for its task and it is a main session, or it is `awaiting_permission` — the orchestrator writes `session.unarchived{by: system}` in the same transaction as the event that made it wait. This does not mark it restored.
- Derived attention hides `needs_review` and `background` items of archived sessions (and task-level items when every main session of the task is archived). `needs_reply` items are never hidden.
