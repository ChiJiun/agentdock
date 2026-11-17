# Session Sentinel — real ACP event inbox (development implementation)

Status: **Implemented and locally verified for the Node ACP development runtime**
Date: 2026-11-17
Issue: [#15 Session Sentinel](https://github.com/ChiJiun/agentdock/issues/15)
Prerequisite: [Live ACP runtime](live-acp-runtime.md)

## User-visible behavior

The **Live ACP / 即時 ACP** sidebar now includes a Session Sentinel bell showing the **count of actionable decisions or interrupted/failed sessions**, not every active Agent. Open the bell to see a multilingual cross-session inbox and one-sentence event-derived summaries, grouped by:

| Priority | Event trigger | User action |
| --- | --- | --- |
| Decision | Pending ACP `session/request_permission` (not expired) | Open the session's Approvals tab; approve once or deny there |
| Review | `failed` or `interrupted` session | Inspect error/history and decide on a new session |
| Background | `running` session | Inspect current session if desired |
| Completed | `ready` plus latest `turn_finished` event | Review actual answer, Git diff and test evidence |

Every item includes adapter, session, permitted working directory, status, evidence cursor, summary key and next-action text. Summaries are **deterministic localized templates**; the agent's own output and raw logs are not translated or treated as verified facts.

Click an item to navigate to its actual ACP Session. Decision items open the existing **Approvals** tab; they do not directly authorize any tool.

Dismiss an item to remove it from the inbox. The dismissal key is saved in SQLite and survives runtime restart. If a new meaningful event arrives, its distinct sequence number produces a new alert. **Dismissing a notification does not resolve an underlying permission request.**

## Implementation

- `apps/runtime/attention.mjs`: pure event/state classifier with no model calls or external requests.
- `apps/runtime/store.mjs`: `attention_dismissals` table; latest-event lookup and durable visibility acknowledgments.
- `apps/runtime/server.mjs`: GET `/api/attention`, POST `/api/attention/:id/dismiss` with same local-API Origin/JSON enforcement and server-side current-item validation.
- `src/live/api.ts`: typed attention API.
- `src/components/LiveAttentionInbox.tsx`: zh-TW/en-US summaries, grouped attention categories, keyboard/Escape close, click-through and dismiss.
- `src/components/LiveWorkspace.tsx`: polls the **local structured event store** together with sessions, not an LLM provider.

## Verification

```sh
npm run typecheck
npm run test:all
npm run build
```

Backend tests verify: classification and priority, completed-turn evidence, no private user prompt in summary, expired approvals, dismissal persistence and new-event identity, and local API validation. Frontend tests verify: actionable notification badge, cross-session jump to the correct session, and that Dismiss **never** sends an ACP approval action. All tests use the actual local event store and protocol mock or controlled HTTP contracts.

## Not yet implemented

- Real production Rust/Tauri event storage, OS-level task notifications, remote worker events, 24/7 monitoring, live GitHub CI/PR events and persistent Task lifecycle.
- Optional low-cost LLM summaries, user-configurable quiet hours, snooze, dedup across distributed workers, notification replay reconciliation and advanced decision explanation.
- A full ACP adapter session-resume audit for Claude Code/Codex/Octomind.
- This design does not assert every external Agent tool call is visible or interceptable through ACP.

The classification works only on **verified host-observed events**. No idle polling invokes a paid model request. An external harness's internal computation may be opaque; completed ACP turns are never represented as completed builds or passing tests without independent evidence.
