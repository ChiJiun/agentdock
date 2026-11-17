# Attention items: "needs reply", "needs review", "running in background"

Status: Proposed with [ADR-0003](../decisions/0003-task-session-event-contracts.md). Schema: `AttentionItem`.

Attention items are **derived, never stored**. They are a pure function of the event log (via the projections), so the sidebar and notifications cannot drift from the facts, and a restart produces the same list. The function below is also implemented in [`validate_fixtures.py`](validate_fixtures.py) (`Replay.attention`) and every fixture's `*.expected.json` lists the items it must produce.

The three kinds are the three inbox sections of the merged UX spec ([`docs/ux/states-and-indicators.md`](../ux/states-and-indicators.md) section 4). Where this file and the UX spec disagree, the UX spec wins unless the difference is listed under "Divergences" below.

## Kinds and mapping to the UX inbox

| Kind | UX inbox section | UX classification rule | Reasons |
| --- | --- | --- | --- |
| `needs_reply` | **Needs your reply** | rule 1: `awaiting-approval` or `awaiting-input` | `approval_pending` (= `awaiting-approval`); `agent_turn_ended`, `output_limited`, `session_unavailable`, `phase_decision_pending`, `reconcile_needed` (= `awaiting-input`: the work is blocked until the user answers or decides) |
| `needs_review` | **New results to review** | rule 4: terminal state (`completed`, `failed`, `interrupted`, `cancelled`) and not viewed | `task_outcome_unviewed` (completed, cancelled), `failure_needs_decision` (failed), `interruption_needs_decision` (interrupted), `child_result_unviewed` (a finished sub-task) |
| `background` | **Running in background** | rule 5: `running`, `queued` or `paused` | `queued`, `workflow_step`, `agent_working`, `paused` (`interrupted{user_paused}`, labelled "Paused"), `waiting_for_reset` (see Divergences) |

UX rules 2 (archived → not listed, unless waiting) and 3 (the session on screen → not listed) are applied as follows: rule 2 is part of the derivation below; rule 3 depends on what is on screen and is applied by the UI, never stored.

"Viewed" means `task.outcome_acknowledged` / `session.result_acknowledged` with any `method` (`opened`, `marked_reviewed`, `bulk_marked_reviewed`). The bulk method ("Mark completed as reviewed") is only accepted for `completed`/`cancelled` tasks and for sessions with outcome `succeeded`/`cancelled`; `failed` and `interrupted` results stay listed until viewed individually. Only `opened` counts as "seen" for the sub-task archive rule ([state-machines.md](state-machines.md#archiving-sessions)).

## Rules

Per task (by task state):

| Condition | Item |
| --- | --- |
| `queued` | `background / queued` |
| `preparing` | `background / workflow_step` |
| `verifying`, `review`, `pr`, `ci` and progressing: a session of the task is `starting`/`active`, a check is `running`, or an operation is `started` | `background / workflow_step` |
| `verifying`, `review`, `pr`, `ci`, not progressing, and no pending approval of the task | `needs_reply / phase_decision_pending` (e.g. review finished and waits for `T28`/`T29`, CI is green and waits for `T39`, or the phase stalled) |
| `running` and no session with role `primary`/`implementation`/`repair` is live (`starting`, `idle`, `active`, `awaiting_permission`, `suspended`) | `needs_reply / session_unavailable` (the agent crashed or failed; restart or pause) |
| `interrupted{reason: user_paused}` | `background / paused` |
| `interrupted`, other reason, `auto_resume_armed` | `background / waiting_for_reset` (show `retry_hint.not_before` and its source) |
| `interrupted`, other reason, not armed, not viewed since it entered `interrupted` | `needs_review / interruption_needs_decision` |
| `failed` and not viewed since it entered `failed` | `needs_review / failure_needs_decision` (retry, abandon, inspect) |
| `completed` or `cancelled` and not viewed since it entered that state | `needs_review / task_outcome_unviewed` |

Per approval:

| Condition | Item |
| --- | --- |
| `pending` | `needs_reply / approval_pending` (`ref_id` = approval id, `session_id` if ACP) |

Per operation:

| Condition | Item |
| --- | --- |
| `outcome_unknown` (any task state, including ended tasks) | `needs_reply / reconcile_needed` (`ref_id` = operation id). Nothing may redo or build on the operation until a live read-only probe or the user reconciles it. |

Per session:

| Condition | Item |
| --- | --- |
| `active` | `background / agent_working` |
| `idle`, the turn was cancelled by `session.output_limited{action: turn_cancelled}`, task in flight | `needs_reply / output_limited` (not shown as an ordinary cancel) |
| `idle`, last stop reason `refusal`, `max_tokens` or `max_turn_requests`, any role (including `review`/`explore` children), task in flight | `needs_reply / agent_turn_ended` |
| `idle`, last stop reason `end_turn`, the task is `running`, and role ∈ `primary`, `implementation`, `repair` | `needs_reply / agent_turn_ended` (the agent finished a turn and is waiting for you) |
| has a parent, is `closed`/`failed` with outcome `succeeded`, `failed` or `cancelled`, and not viewed after it finished | `needs_review / child_result_unviewed` |

Archived (UX rule 2): items of kind `needs_review` and `background` are dropped when they name an archived session, or, for task-level items, when every main (parent-less) session of the task is archived. `needs_reply` items are never dropped; an archived session that starts waiting is unarchived by the system in the same transaction ([state-machines.md](state-machines.md#archiving-sessions)).

"Task in flight" means `preparing`, `running`, `awaiting_approval`, `verifying`, `review`, `pr` or `ci`. A disconnected or failed session produces no item of its own; the task-level rules (`session_unavailable`, `interruption_needs_decision` after `S03 attach_rejected` + `T09`) surface it.

Clearing: an item disappears when its condition stops holding — a prompt is sent, the approval is resolved, the operation is reconciled, the user views the result (`task.outcome_acknowledged`, `session.result_acknowledged`), or the task moves on. Viewing never changes task state.

## Divergences from the UX spec (owner decision)

Each is a deliberate difference; the default would be to follow the UX spec.

1. **Armed auto-resume is background, not "to review".** UX section 2 lists `interrupted` as "Needs review until viewed". An `interrupted` task with `auto_resume_armed` (quota/rate limit with a known reset time and the user's opt-in) will continue without the user, so it is shown as `background / waiting_for_reset` and never as a result to review. Reason: listing it as a result would ask the user to look at something that needs nothing from them. Alternative: treat it like any other interruption (`needs_review` until viewed) and show the reset time in the row.
2. **`phase_decision_pending`, `session_unavailable` and `reconcile_needed` count as `awaiting-input`.** The UX spec defines `awaiting-input` as "agent asked a question"; these three are AgentDock asking the user (review finished and needs a go/no-go, the agent process is gone while the task is `running`, an operation's outcome is unknown). The UX state table maps `Verifying`/`Review`/`PR`/`CI` to `running`, which would put a stalled phase under "Running in background". Reason: work that cannot continue without the user must not look like progress. Alternative: a fourth UX state ("needs decision") or keep them in background with a label.
3. **Undo of a bulk "Mark completed as reviewed" is not yet an event.** UX section 4 says Undo restores the rows to "to review". The contract has no event that revokes an acknowledgement; issue #7 must add one (for example `*.acknowledgement_revoked{event_id}`) before the bulk action ships. Listed as an open question in the ADR.

## Requested harness scenarios and how the contract expresses them

| Scenario | Contract | Fixture |
| --- | --- | --- |
| A session stopped by quota exhaustion continues when the quota resets | `interrupted{reason: quota_exhausted, retry_hint{not_before, source}, auto_resume_armed}` + task `auto_resume_policy`; `T44` by orchestrator with `scheduled_resume` only when armed and due; then `S17` (alive), `S20` (reattach) or a superseding session with a handoff summary | `05-quota-interrupt-auto-resume` |
| Leave a summary when interrupted | `session.summary_recorded{purpose: interruption, source}`; `Interruption.summary_id`; restart prompt `origin: handoff` + `handoff_summary_id` | `04`, `05` |
| A main session with several child sessions; a child is archived only after it finished **and** the user actually opened its result; the main session never auto-archives | `Session.parent_session_id`, `outcome`; `session.result_acknowledged{method: opened}`; `session.archived{by: auto}` legal only for opened children with outcome `succeeded`/`cancelled` that were never restored; `session.unarchived{by: user}` / `{by: system}`; `child_result_unviewed` until viewed | `01`, `08`, `12` |
| Three kinds of to-dos — needs reply / needs review / background — derivable from events | `AttentionItem` derived by the rules above | every fixture's `.expected.json` |
| Agent crashed, reattach rejected, output limit, review refusal, review waiting for a decision, unknown operation outcome after the task ended | `session_unavailable`, `interruption_needs_decision` (`reason: session_unavailable`), `output_limited`, `agent_turn_ended` for any role, `phase_decision_pending`, `reconcile_needed` | `10`, `11`, `12` |
