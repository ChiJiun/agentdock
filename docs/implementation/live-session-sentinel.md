# Session Sentinel — real ACP event inbox (development implementation)

Status: **Implemented and locally verified for the Node ACP development runtime**
Date: 2026-11-17
Issue: [#15 Session Sentinel](https://github.com/ChiJiun/agentdock/issues/15)
Prerequisite: [Live ACP runtime](live-acp-runtime.md)

## User-visible behavior

The **Live ACP / 即時 ACP** sidebar includes a Session Sentinel bell. It follows the attention model in [`docs/ux/states-and-indicators.md` section 4](../ux/states-and-indicators.md#4-attention-model-inbox-badge-switcher-ordering): three sections in fixed order, first match wins.

| Section | Trigger (from the event store) | Counted in badge | Cleared by |
| --- | --- | --- | --- |
| **Needs your reply** | A pending, unexpired ACP `session/request_permission` of a live session (`awaiting_approval` or `running`, so a second request is not hidden after the first is answered) | Yes — bell turns into a ringing bell and the badge becomes a square `!N` | Approving/denying it in the session, or the request expiring. **Never by "mark reviewed" or by viewing.** Listed even for the session on screen. |
| **New results to review** | `failed`, `interrupted`, or `ready` whose newest finished turn ended after the newest prompt (completed, or **cancelled** — UX section 2 lists cancelled as needs-review-until-viewed), not yet viewed at that event cursor | Yes (round outlined pill) | Viewing the session (on screen while the window has focus) or **Mark reviewed** on that row. A new event makes it reappear. |
| **Running in background** | `starting`, `running`, or `awaiting_approval` without a live request | Never | The state changing |

- Badge count = needs reply + new results; `99+` above 99. The accessible name always states all three numbers ("1 need reply, 2 to review, 3 running in background").
- The session on screen is not listed (UX rule 3), except for needs-reply rows.
- Opening the inbox focuses the first row (or the popover when empty); ↑/↓/Home/End move between rows; Tab/Shift+Tab wrap among inbox controls. When a focused result is marked reviewed and disappears, focus moves to a surviving row or the close button. Esc closes and returns focus to the bell; clicking outside closes without moving focus.
- Activating a row opens that session; a needs-reply row opens its **Approvals** tab. The inbox never offers approve/deny — the full request is only shown in the session.
- Rows show adapter, short session ID, a status label, the project folder name and a fixed localized template (zh-TW / en-US). Prompts, tool titles, commands, agent output and error text are never copied into attention items, so a row cannot leak a credential and its length does not depend on agent output.

### "Viewed" and restarts

"Viewed" is persisted per session in SQLite (`attention_views`: cursor and the session status at that moment). It never moves backwards and never changes session state.

At an ungraceful stop, the next host marks every session that was live as `interrupted` and writes a `host_restarted` event with the `previousStatus` (Live ACP runtime). That event advances the cursor, so the Sentinel decides whether the interruption is new to the user:

- the session was idle (`previousStatus: ready`), the view was **recorded while ready** before the restart, and nothing else happened after that view → the interruption stays quiet; a stale pre-restart cursor submitted *after* restart cannot dismiss a newly interrupted session;
- it was running or waiting (`previousStatus: running`, `awaiting_approval`, `starting`), or anything happened after the view → the interruption is listed under New results to review (work may have been lost).

### Main sessions and sub-tasks

The Live ACP runtime has no parent/child (sub-task) sessions yet, so nothing is archived automatically and no session is ever hidden because it finished. When sub-tasks arrive, they must follow UX section 5: a sub-task collapses only after it completed **and** its result was actually opened; main sessions never auto-archive. "Mark reviewed" does not count as opened for that rule.

## Implementation

- `apps/runtime/attention.mjs`: pure classifier over sessions, latest event and pending approvals; no model calls or external requests.
- `apps/runtime/store.mjs`: `attention_views` table, `latestEvent` (reads back only the stop reason), `attentionView`, `markViewed`.
- `apps/runtime/server.mjs`: `GET /api/attention`; `POST /api/attention/:id/reviewed` (only `review` items, 409 for approvals); `POST /api/sessions/:id/viewed` with `{ cursor }` (0 ≤ cursor ≤ latest event). Same local-API Origin and JSON content-type enforcement as the other mutations.
- `src/live/api.ts`: typed attention API.
- `src/components/LiveAttentionInbox.tsx`: three sections, templates, keyboard behavior, per-row Mark reviewed for results.
- `src/components/LiveWorkspace.tsx`: polls the **local structured event store** together with sessions (not an LLM provider), applies UX rule 3, records "viewed" for the focused on-screen session, and discards a poll that started before a Mark reviewed landed so the row does not flash back.

## Verification

```sh
npm run typecheck
npm run test:all
npm run build
```

Backend tests verify: the three sections and their order, cancelled turns as results to review, a finished turn that stays listed after a trailing `cancel_requested`, approvals that cannot be hidden by Mark reviewed or by viewing, a second pending approval after the first is answered, expired approvals and approvals of a lost connection, no prompt/tool title/credential in items, viewed persistence across restart and new-event identity, restart interruption (idle vs running), monotonic view marks, and local API validation (unknown/oversized/malformed ids, cursor range and type, Origin, content type). Frontend tests verify: badge count and accessible name, `!N` reply badge, section order, first-row focus, no approve/deny or Mark reviewed on reply rows, cross-session jump to the Approvals tab, Mark reviewed never sends an ACP approval action, the on-screen session rule, and that "viewed" is recorded only while the window has focus. All tests use the actual local event store and protocol mock or controlled HTTP contracts.

## Not yet implemented

- Real production Rust/Tauri event storage, OS-level task notifications, remote worker events, 24/7 monitoring, live GitHub CI/PR events and persistent Task lifecycle.
- Optional low-cost LLM summaries, user-configurable quiet hours, snooze, dedup across distributed workers, notification replay reconciliation and advanced decision explanation.
- A full ACP adapter session-resume audit for Claude Code/Codex/Octomind.
- This design does not assert every external Agent tool call is visible or interceptable through ACP.

The classification works only on **verified host-observed events**. No idle polling invokes a paid model request. An external harness's internal computation may be opaque; completed ACP turns are never represented as completed builds or passing tests without independent evidence.
