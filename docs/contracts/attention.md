# Attention items: "needs reply", "needs review", "running in background"

Status: Proposed with [ADR-0003](../decisions/0003-task-session-event-contracts.md). Schema: `AttentionItem`.

Attention items are **derived, never stored**. They are a pure function of the event log (via the projections), so the sidebar and notifications cannot drift from the facts, and a restart produces the same list. The function below is also implemented in [`validate_fixtures.py`](validate_fixtures.py) (`Replay.attention`) and every fixture's `*.expected.json` lists the items it must produce.

## Kinds

| Kind | Meaning for the user |
| --- | --- |
| `needs_reply` | Work is blocked on you: answer, approve, or decide. |
| `needs_review` | Something finished that you have not looked at yet. |
| `background` | Work is progressing without you. |

## Rules

Per task (by task state):

| Condition | Item |
| --- | --- |
| `queued` | `background / queued` |
| `preparing`, `verifying`, `review`, `pr`, `ci` | `background / workflow_step` |
| `interrupted` and `auto_resume_armed` | `background / waiting_for_reset` (show `retry_hint.not_before` and its source) |
| `interrupted` and not armed | `needs_reply / interruption_needs_decision` |
| `failed` and not acknowledged since it entered `failed` | `needs_reply / failure_needs_decision` (retry, abandon, inspect) |
| `completed` and not acknowledged since it entered `completed` | `needs_review / task_outcome_unviewed` |
| `cancelled` | nothing (the user did it) |

Per approval:

| Condition | Item |
| --- | --- |
| `pending` | `needs_reply / approval_pending` (`ref_id` = approval id, `session_id` if ACP) |

Per session:

| Condition | Item |
| --- | --- |
| `active` | `background / agent_working` |
| `idle`, last transition was `turn_ended` with a stop reason other than `cancelled`, the task is `running`, and role ∈ `primary`, `implementation`, `repair` | `needs_reply / agent_turn_ended` (the agent finished a turn and is waiting for you; `refusal`, `max_tokens`, `max_turn_requests` also land here so the user sees them) |
| has a parent, is `closed`/`failed` with outcome `succeeded` or `failed`, and no `session.result_acknowledged` after it closed | `needs_review / child_result_unviewed` |

Clearing: an item disappears when its condition stops holding — a prompt is sent, the approval is resolved, the user acknowledges (`task.outcome_acknowledged`, `session.result_acknowledged`), or the task moves on. Acknowledging never changes task state.

## Requested harness scenarios and how the contract expresses them

| Scenario | Contract | Fixture |
| --- | --- | --- |
| A session stopped by quota exhaustion continues when the quota resets | `interrupted{reason: quota_exhausted, retry_hint{not_before, source}, auto_resume_armed}` + task `auto_resume_policy`; `T44` by orchestrator with `scheduled_resume` only when armed and due; then `S17` (alive), `S20` (reattach) or a superseding session with a handoff summary | `05-quota-interrupt-auto-resume` |
| Leave a summary when interrupted | `session.summary_recorded{purpose: interruption, source}`; `Interruption.summary_id`; restart prompt `origin: handoff` + `handoff_summary_id` | `04`, `05` |
| A main session with several child sessions; a child collapses only after it finished **and** the user saw its result; the main session never auto-collapses | `Session.parent_session_id`, `outcome`; `session.result_acknowledged`; `session.collapsed{by: auto}` legal only for finished, acknowledged children; `child_result_unviewed` until then | `01`, `08` |
| Three kinds of to-dos — needs reply / needs review / background — derivable from events | `AttentionItem` derived by the rules above | every fixture's `.expected.json` |
