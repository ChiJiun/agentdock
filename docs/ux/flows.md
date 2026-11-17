# Key user flows

Status: Draft for issue #2. Each flow lists the deliberate actions, the screen states it passes through and what the prototype demonstrates.

## Counting rules for “deliberate actions”

- A deliberate action is one user decision: a click, a key chord that triggers a command, or submitting text. Typing the content of a message is part of its submit action, not separate actions.
- **Initial setup is excluded**: adding the repository once, installing/signing in to an agent adapter once, choosing a default agent per project.
- **Policy-required approvals are counted separately** and shown in the flow. They are not hidden to make the count look smaller: if the agent requests a push or a destructive command, that approval is an extra, intended action.
- Reading the diff is not an action; opening it is.

## F1 — Repository picker → reviewed code changes (≤ 3 actions)

Precondition: repository already added; project has a default agent; agent is signed in.

| # | Action | Result |
| --- | --- | --- |
| 1 | **Home → click the repository card** (or Ctrl+N, then pick) | Task box opens with defaults shown: agent, *new worktree from base branch*, local/remote. Focus is in the task box. |
| 2 | **Type the objective, press Enter** (or paste an Issue URL) | Task created; worktree prepared; session opens with streaming timeline. The user can leave — the inbox and sidebar track it. |
| — | *(only if policy requires)* approve/deny in the approval card | Agent continues or adapts. |
| 3 | **Click “Review changes · N files +a −d”** on the completion card (or the header “Changes” button, or Ctrl+Shift+G) | Review panel opens on the first changed file with diff, checks and findings; focus moves to the panel heading. |

Then: read the diff, optionally comment to the agent (feeds the same session) or start an independent review session (V1.0). No push or PR happens without a separate human decision.

Prototype: Home → card “agentdock” → type → Enter → wait ~5 s → “Review changes”. Verified with real key presses (see PR description). Screenshot: [`08-home-dark.png`](screenshots/08-home-dark.png), [`01-desktop-3col-light.png`](screenshots/01-desktop-3col-light.png).

## F2 — Something needs approval while I work elsewhere

1. The agent in “Fix flaky worktree cleanup test” requests `git worktree remove --force …`. Session status → **Needs approval**; sidebar row shows the diamond “!”; inbox badge becomes square `!n` with the alert bell; screen reader hears an assertive announcement *only for approvals* (“Approval needed in Fix flaky worktree cleanup test”).
2. User presses **Ctrl+J** (or opens the inbox and picks the row). The session opens with focus on its heading; the approval card is in view or the sticky banner offers “Show”.
3. User Tabs to **Approve once** or **Deny** and confirms. Card collapses into a resolved line (“Denied by you — the command was not run”), status returns to Running, badge decrements.

Rules: no shortcut approves; inbox rows cannot approve; after restart a pending approval is restored as pending, never auto-resolved; denial is enforced by the Rust policy layer.

## F3 — Switching among the sessions I use most

- **Toggle between two sessions**: Ctrl+K → the previous session is in **Recent** (top of the list when nothing needs a reply) → Enter.
- **Pinned**: Alt+1…9 opens the n-th pinned session and focuses its composer.
- **By name**: Ctrl+K, type 2–4 letters (`evt sql`), Enter. Esc returns focus to exactly where it was.
- **By project**: sidebar tree, arrow keys, Enter.

## F4 — Parallel sub-tasks finish, are reviewed, then get out of the way

1. Main session “Implement attention inbox popover” spawns three background agents (explore, write tests, independent review). They appear nested under it with the layers glyph.
2. “Write unit tests…” finishes → status **Done · new**, badge +1, polite announcement “Background agent finished: …”. Collapsed parent shows “1 new”.
3. User opens it (from inbox, switcher or tree) and reads the result → it is now *viewed*.
4. User navigates anywhere else → the sub-task is archived, toast “Archived sub-task … · Undo”. Parent shows “Show 3 archived sub-tasks”.
5. A **failed** sub-task (“Collect capability flags…”) stays visible until the user retries or archives it.
6. The main session is never archived automatically, even when all sub-tasks are done.

Prototype: open “Explore existing session model”, then any other session → archived with Undo. The tests sub-task finishes by itself ~25 s after load.

## F5 — App restarted while sessions were running

1. On launch, the sidebar renders from local SQLite immediately.
2. Sessions that were running and whose adapter did **not** advertise session reattach become **Interrupted**, with the notice “History restored; agent not reattached; nothing was re-run.” Actions: “New session from this history”, “Close”.
3. Sessions whose adapter advertises reattach show “Reattaching…” then either resume or fall back to (2).
4. Pending approvals are restored as pending.
5. Remote tasks reconnect and fetch events since the last cursor; until then they show *disconnected · last known state*.

## F6 — Quota error

1. Provider rejects a request. Card quotes the provider error, its source, and the reset time **or “Unknown — not provided”**; tasks that did not run are listed.
2. Actions: Retry now, Switch this task to another agent (opens a new session in the same worktree with a summary), View raw error.
3. The usage popover shows the provider-reported meter if any; other accounts keep their own source labels — nothing is inferred.

## F7 — Remote worker disconnects (V1.0)

1. Banner: “lab-vm is unreachable. Reconnecting in 8 s. Last event 2 min ago. Current state unknown until we reconnect.”
2. Sidebar rows switch to the disconnected glyph with “last known: Running” in the accessible name.
3. On reconnect: events since the cursor are replayed into the timeline; non-idempotent operations are never replayed by the client.
