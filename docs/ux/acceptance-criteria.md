# UI acceptance criteria

Status: Draft for issue #2, updated for issue #26. These criteria apply to the real application (issue #4 onward). The **Prototype** column records what the static prototype demonstrates:

- **V** — demonstrated and verified in a browser, with real key presses, in the PR that added or last changed the row (PR #23 or the issue #26 follow-up; see the PR descriptions for method).
- **D** — demonstrated in the prototype, not separately verified.
- **S** — specification only; not in the prototype.

Several scenarios are adapted from review rounds of an earlier experiment (ChiJiun/acpira PR #7: attention inbox and quick switcher). Only requirements and scenarios were reused, not code.

## Layout and navigation

| ID | Criterion | Prototype |
| --- | --- | --- |
| UX-01 | At ≥ 1280 px the shell shows top bar, sidebar, main column and a docked review panel at the same time. | V |
| UX-02 | Between 960 and 1279 px the review panel opens as an overlay drawer with a scrim; everything behind it, including the top bar, is inert and F6 stays inside the drawer. | V |
| UX-03 | Below 960 px the sidebar is a modal drawer (Ctrl+B / ≡); the top bar and main column are inert while it is open (Tab and F6 stay in the drawer); choosing a session closes it and focuses the session heading; Esc restores the previous focus. | V |
| UX-04 | At 375 px width there is no horizontal page scrolling (code/diff blocks may scroll internally). | V |
| UX-05 | There is no row of per-session tab buttons; switching uses sidebar tree, pinned shortcuts, inbox and quick switcher. | V |
| UX-06 | Pinned sessions are reachable with Alt+1…9 and appear once (Pinned group only). | V (Alt+1, also from an open drawer); D (the rest) |
| UX-07 | Sidebar and review panel widths are resizable within token limits and persist per window. | S |
| UX-08 | At most one popover or modal drawer is open at a time: opening the inbox, the usage popover, the sidebar drawer or the review drawer closes whichever of them is open (replace, not stack). The quick switcher and the shortcuts dialog may open above a modal drawer and return focus into it on cancel; they replace an open popover. Navigation (Ctrl+J, Alt+1…9, Ctrl+N, choosing a row, picking a switcher result) closes any popover or modal drawer. Esc closes one layer per press. No reachable state leaves every region inert. | V (820 px and 1024 px: every pair of Ctrl+B, Ctrl+Shift+G, Ctrl+Shift+J; usage popover replaced by the inbox; Ctrl+K and Ctrl+/ above each drawer; Ctrl+J, Alt+1, Alt+N, switcher pick; shortcuts ignored while a dialog is open) |
| UX-09 | Closing an overlay returns focus to the element that had it before; if that element is gone, hidden or inert, focus goes to a defined fallback (the drawer still open → the session heading → the main region) and never to the page body. | V (inbox opened from a drawer → Esc → bell; review drawer opened from the sidebar drawer → Esc → composer; sidebar collapsed with focus inside → session heading) |

## Attention, inbox and badge

| ID | Criterion | Prototype |
| --- | --- | --- |
| UX-10 | Inbox lists exactly three sections — Needs your reply, New results to review, Running in background — each with heading, glyph and count. | V |
| UX-11 | Badge count = needs reply + new results; background work never increases it; hidden at 0; `99+` above 99. | V (count, hidden at 0 with background still running); D (99+ not exercised) |
| UX-12 | When anything needs a reply, the bell glyph changes and the badge becomes square with a “!” prefix (distinguishable in greyscale). | V |
| UX-13 | Approval/question sessions count as “needs reply” even when they are the session on screen; other states of the on-screen session are not listed. | D |
| UX-14 | Failed/interrupted/cancelled/completed sessions stay in “to review” until viewed — opened after they entered that terminal state, or cleared with the bulk action (completed/cancelled only); a session watched while it was running still appears when it finishes off screen. “Viewed” is persisted across restarts. | V (bulk-marked rows leave the list; a result opened before it finished still appears); D (the rest); S (persistence) |
| UX-15 | Archived sessions and sessions of removed projects are never listed — except an archived session that is awaiting the user, which is listed under Needs reply (and unarchived by the app); sidebar collapse or filters do not hide inbox items. | D (rule order in `classify`; no prototype data path makes an archived session wait); S (auto-unarchive, removed projects) |
| UX-16 | Inbox opens with focus on the first row — also when “Needs your reply” is empty, and never on a section action; with no rows at all, on the popover; ↑/↓/Home/End move; Enter opens the session and closes the inbox; Esc closes and returns focus to the bell. | V (incl. empty Needs-reply after deny + answer); D (no-rows case) |
| UX-21 | “Mark completed as reviewed (N)” comes after the review rows, affects only completed/cancelled results (failed, quota, auth and interrupted stay), archives nothing (the rows become viewed, not opened), keeps focus in the inbox on the first remaining row, and offers Undo in a toast. Undo restores only the results that have not been opened since, says how many it restored, and moves focus to the inbox button. There is no single-row “Mark reviewed”. | V |
| UX-22 | A remote session that is disconnected with a last known awaiting state stays in Needs reply, labelled “disconnected — last known”, with Approve/Deny disabled until the worker confirms on reconnect. | S |
| UX-17 | Inbox rows cannot approve or deny; they only open the session. | V |
| UX-18 | Ctrl+J opens the next item that needs the user (reply first, then review), closing any popover or modal drawer first. | V (from an open sidebar drawer and review drawer); D (ordering) |
| UX-19 | The inbox’s accessible name states all three counts; count labels avoid locale plural forms. | D |
| UX-20 | Live updates (new results, background completion) update badge and open inbox without moving keyboard focus. | V (tree focus kept across live re-render); D (open inbox) |

## Quick switcher

| ID | Criterion | Prototype |
| --- | --- | --- |
| UX-30 | Ctrl+K opens a modal switcher with focus in the input; with an empty query it groups Needs your reply → Recent → New results → Pinned → Running, each session once, the current one omitted. | V |
| UX-31 | Typing filters by fuzzy match over title and project; every whitespace-separated token must match; contiguous and word-start matches rank first; title matches outrank project matches. | V |
| UX-32 | Matching is grapheme-aware and NFC-normalised (NFD “é” matches NFC “é”; ZWJ emoji are not split); accents are not folded. | D (logic present; cases not exercised) |
| UX-33 | At most 100 rows render; beyond that a “N more not shown” row appears. | D (needs > 100 matches) |
| UX-34 | Esc, backdrop click and pressing Ctrl+K again all close it and restore focus to the element focused before opening. | V |
| UX-35 | Enter opens the active result computed from the current input (never a stale list) and moves focus to that session’s composer. Typed text never leaks into the composer. | V |
| UX-36 | Enter during IME composition does not pick a result. | S (no IME test performed) |
| UX-37 | The switcher does not open while the shortcuts dialog is open; nothing opens over the switcher (Ctrl+Shift+J, Ctrl+B, Ctrl+Shift+G, Ctrl+J and Ctrl+/ are ignored while it is open). It may open above a modal drawer (UX-08); Esc in the switcher closes only the switcher. | V |
| UX-38 | Archived sessions are found by search, tagged “archived” and ranked below live ones. | V |
| UX-39 | Sessions deleted or archived while the switcher is open are skipped safely. | S |

## Sessions, sub-tasks and archiving

| ID | Criterion | Prototype |
| --- | --- | --- |
| UX-40 | Main sessions are never archived automatically; manual archive is offered only in a terminal state. | V (auto); S (manual archive) |
| UX-41 | A completed/cancelled sub-task is archived only after its result was opened — shown as the current session after it entered that terminal state — and the user navigated away; a sub-task that was on screen only while it ran, or that was only bulk-marked as reviewed, is not archived. A toast offers Undo for ≥ 8 s; Undo moves focus to the restored row (or the session heading), never to the page body; a restored sub-task is not auto-archived again. | V |
| UX-42 | Failed and interrupted sub-tasks are never auto-archived. | D |
| UX-43 | A collapsed main session summarises its sub-tasks (“n need you · n new · n running”) and shows the attention glyph if any child needs a reply. | V |
| UX-44 | Archived sub-tasks are listed behind “Show N archived sub-tasks” under the parent. | V |
| UX-45 | Rows never disappear while focused, hovered or on screen. | D |
| UX-46 | Every archived session shows an “Archived” chip and an **Unarchive** button in its header; Unarchive moves focus to the session heading and the session is not auto-archived again. | V |
| UX-47 | An archived session that enters an awaiting state is unarchived automatically. That system restore does not set “restored by user”, so the sub-task can be auto-archived again after its next result has been opened. | S |
| UX-48 | While a toast with an action (Undo) is visible it is an F6 region, and its timer pauses while it contains focus or the pointer, so the action is reachable from the keyboard within its lifetime. | S (in the prototype the toast is the last Tab stop and keeps its 8 s timer; Undo is in practice pointer-only there) |

## Session view and long transcripts

| ID | Criterion | Prototype |
| --- | --- | --- |
| UX-50 | Opening a session scrolls to the latest event. | V |
| UX-51 | While the user is at the bottom, new events auto-follow; when scrolled up, the view stays put and a “N new below · Jump to latest” pill appears. | D (auto-follow V; pill logic present) |
| UX-52 | Streaming text is not announced token by token (`role="log"`, `aria-live="off"`); turn completions and background completions are announced politely; approvals assertively. | D (approval announcement S) |
| UX-53 | Tool events are collapsed by default and expandable by keyboard. | D |
| UX-54 | A pending approval/question that is scrolled out of view shows a sticky banner; “Show” scrolls to and focuses the card, not its Approve button. The banner may truncate (full text as tooltip); the full command appears only in the card. | V |
| UX-55 | ≥ 400 events render without layout breakage in the prototype; the app virtualises and stays responsive at 10,000 events (input lag < 100 ms). | V (≈410 events) / S (10k) |
| UX-56 | Composer: Enter sends/steers, Shift+Enter newline; Tab (or →) inserts the ghost suggestion only when the composer is empty and the ghost is shown, otherwise Tab moves focus and → moves the caret; Esc hides the ghost. | V |
| UX-59 | While running, the next Tab stop after the composer is Steer, then Stop; no key combination from the composer reaches Stop first. | V |
| UX-57 | Up to three “Suggested next” prompts appear per session state and never cost model tokens unless the adapter supplies them. | D |
| UX-58 | Drafts are kept per session when switching. | D |

## Approvals, evidence and review

| ID | Criterion | Prototype |
| --- | --- | --- |
| UX-60 | Approval card shows operation, full command (wrapped, never truncated), effect, scope and rule, with Approve once / Deny. | V |
| UX-61 | No keyboard shortcut approves or denies. | V |
| UX-62 | After restart, pending approvals are shown as pending and are not auto-resolved. | S |
| UX-63 | Repository → reviewed change set takes ≤ 3 deliberate actions after setup (pick repo, submit objective, open review). | V |
| UX-64 | Review panel shows changed files with status letter and +/− counts, a diff with “+”/“−” sign column, checks with text status and findings tagged Blocking/Suggestion. | V |
| UX-65 | Review panel opens with focus on its heading and returns focus on close (Esc or ×). | V |
| UX-66 | Comment to agent posts into the same session. | D |
| UX-67 | Checks list only commands the workbench ran; agent claims are not rendered as checks. | S |

## States, kinds and usage

| ID | Criterion | Prototype |
| --- | --- | --- |
| UX-70 | Empty, loading, offline, auth-required, quota-error and approval-required states exist for each surface in [states-and-indicators.md §7](states-and-indicators.md#7-surface--state-matrix). | D (`states.html`) |
| UX-71 | Local task, background agent and remote task are distinguished by glyph and text in header, inbox grouping, sidebar (non-local) and quit dialog. | D (quit dialog S) |
| UX-72 | A remote task never shows a confident “Running” without a recent event; disconnected shows last known state. | S |
| UX-73 | Usage shows every connected account with a text source label; unknown quota has no bar and says “unknown”; ≥ 80 % shows a text flag. | V |
| UX-74 | Quota error quotes the provider error and shows “Unknown — not provided” when no reset time is given. | D |
| UX-75 | Interrupted sessions distinguish history restore, agent reattach (only if advertised) and task resume. | D |
| UX-76 | A session whose agent runs in its own bypass / full-access mode says so wherever the session is shown: a “Policy not enforced” chip and a persistent, non-dismissible note in the session header (stating that the agent acts without asking AgentDock, that approval rules do not apply to what the agent does, and that AgentDock still asks before the operations it performs itself), a glyph plus “policy not enforced” in the sidebar row’s accessible name, the same words in inbox, Home, project and switcher rows, and a timeline notice where the mode started. Text and shape carry it; colour is secondary. | V (`s8`: chip, note, sidebar glyph and accessible name, inbox / Home / project / switcher rows, timeline notice; light and dark); S (collapsed-parent glyph for a sub-task, end-of-mode notice) |
| UX-77 | No surface shows a “protected”/“enforced” badge for a session, and tool events of a bypass-mode session carry no “approved” marker. The mode is taken from what AgentDock set or the adapter reported, never inferred from behaviour; an adapter that does not report it yields “Policy coverage unknown”. | D (`s8` has no approval cards or approved markers; “unknown” chip in `states.html` only); S (source rule, per-adapter mode mapping) |
| UX-78 | AgentDock never selects a bypass mode by default; turning it on through AgentDock requires a confirmation that states the consequence, with Cancel as the default button. A mode change reported by the agent is announced politely and recorded in the timeline. Host-policy operations (push, PR, merge, worktree removal) still require approval in every mode. | S |

## Accessibility and theming

| ID | Criterion | Prototype |
| --- | --- | --- |
| UX-80 | Every status is distinguishable by glyph shape and text, without colour. | V (greyscale CSS filter check of the sidebar) |
| UX-81 | All token text pairs ≥ 4.5:1 and UI/focus pairs ≥ 3:1 in both themes (`node docs/ux/tools/check-contrast.mjs` exits 0). | V (49 pairs) |
| UX-82 | F6/Shift+F6 cycle top bar → sidebar → conversation → composer → review panel. | V |
| UX-83 | Sidebar tree follows the APG tree pattern with roving tabindex; live updates keep focus. | V |
| UX-84 | Visible focus indicator on every interactive element; never clipped in scroll containers. | D |
| UX-85 | `prefers-reduced-motion` stops spinners and transitions without losing meaning. | D (not toggled in OS) |
| UX-86 | Windows High Contrast (forced colours) keeps selection, badges and tags visible. | S (CSS present; not tested) |
| UX-87 | Light, dark and system themes; choice persists; system follows OS changes live. | V (light/dark), D (system) |
| UX-88 | Pointer targets ≥ 24×24 px. | D |
| UX-89 | Narrator/NVDA announce row names, inbox counts and switcher results correctly. | S (no screen reader run) |

## Source and provenance

| ID | Criterion | Prototype |
| --- | --- | --- |
| UX-90 | No Claude/Anthropic logos, icons, illustrations, fonts, colour palette, copywriting or source code are used; product names appear only as plain-text adapter labels with neutral monograms. | D (author’s self-check; to be confirmed by an independent reviewer) |
| UX-91 | Third-party icon/library licences are recorded before adoption (Lucide: ISC AND MIT). | V |

## Desktop host (hand-off to issue #4)

| ID | Criterion | Prototype |
| --- | --- | --- |
| UX-95 | In the Tauri/WebView2 window, every shortcut in [accessibility.md §1](accessibility.md#1-keyboard-map) performs the AgentDock action and not the browser default, and the browser-only keys listed in §7 (DevTools, history navigation, find, zoom, caret browsing, save, view source, print, reload) do nothing in a release build unless the app defines them (browser accelerator keys disabled; see [§7](accessibility.md#7-shortcut-conflicts-in-the-webview2-host-hand-off-to-issue-4)); a shortcut smoke test covers it. | S |
