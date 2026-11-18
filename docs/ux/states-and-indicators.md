# States, indicators and attention model

Status: Draft for issue #2. Applies to every surface that shows a session, task or account.

## 1. Rule zero: never colour alone

Every status is expressed by **three independent cues**:

1. **Glyph shape** (outline vs filled, circle vs diamond vs triangle vs bubble).
2. **Text** — a visible label where space allows (session header chip, inbox row subtitle, review checks) and always in the accessible name (`aria-label` or visually hidden text) where it does not (sidebar rows).
3. **Colour** — secondary reinforcement only, from the status tokens in [`tokens/tokens.css`](tokens/tokens.css).

A user with no colour perception, in Windows High Contrast, or reading a greyscale screenshot must be able to tell every state apart. See [accessibility.md](accessibility.md#4-non-colour-cues).

## 2. Session status vocabulary

| State (domain) | Glyph (shape) | Visible label | Tone token | Counts in inbox as |
| --- | --- | --- | --- | --- |
| `running` | open circle with a rotating arc (static three-quarter arc when reduced motion) | Running | `status-running` | Background (if not on screen) |
| `queued` | outlined clock | Queued | `status-neutral` | Background |
| `paused` (architecture `Paused`) | outlined clock | Paused | `status-neutral` | Background (labelled “Paused”; not counted) |
| `awaiting-approval` | **filled diamond with “!”** | Needs approval | `status-attention` | **Needs reply** |
| `awaiting-input` (agent asked a question) | **filled speech bubble with “?”** | Needs reply | `status-attention` | **Needs reply** |
| `completed`, not yet viewed | **filled circle with check** | Done · new | `status-success` | Needs review |
| `completed`, viewed | outlined circle with check | Done | `status-success` | — |
| `failed` (generic) | outlined triangle with “!” | Failed | `status-danger` | Needs review until viewed |
| `failed` + quota | gauge with “×” | Quota limit | `status-danger` | Needs review until viewed |
| `failed` + auth | key | Sign-in needed | `status-danger` | Needs review until viewed |
| `interrupted` | dashed circle with pause bars | Interrupted | `status-neutral` | Needs review until viewed |
| `cancelled` | circle with slash | Cancelled | `status-neutral` | Needs review until viewed |
| disconnected (remote, overlay) | signal arcs with slash | Disconnected · last known: *state* | `status-neutral` | Classified by the last known state (see §4, rule 1a) |
| archived | archive box | Archived | `status-neutral` | — |

Mapping to the architecture state machine (`docs/architecture.md`): `Queued`/`Preparing` → queued; `Running`/`Verifying`/`Review`/`PR`/`CI` → running with a phase sub-label (e.g. “Running · CI”); `AwaitingApproval` → awaiting-approval; `Complete` → completed; `Interrupted`/`Failed`/`Cancelled` → same names; `Paused` → `paused` (queued glyph with label “Paused”). `awaiting-input` is a UI-level split of “agent is blocked on the human” that the session/event model must expose separately from approvals (open question for issue #4 / contracts).

Glyphs live in [`prototype/icons.js`](prototype/icons.js) as original placeholders; production icons follow [design-system.md → Icons](design-system.md#6-icons).

## 3. Task-kind indicators: local task vs background agent vs remote task

Kinds describe **where the work runs and what happens if you close AgentDock**. They are orthogonal to status.

| Kind | Meaning | Glyph | Text label | Lifecycle shown to the user |
| --- | --- | --- | --- | --- |
| **Local task** | A session you drive directly; the agent process runs on this computer. | monitor | “Local task” | Stops when AgentDock quits (quit dialog lists them). |
| **Background agent** | A delegate session spawned by a main session or by “run in background” (explorer, test writer, reviewer). Runs on this computer, has no foreground conversation, reports back to its parent. | stacked layers | “Background agent” + parent link (“Sub-task of …”) | Stops when AgentDock quits. Auto-archives after its result is viewed (see §5). |
| **Remote task** | Runs on a remote worker (SSH, V1.0). The worker is the authority for its state. | two stacked server units | “Remote task · *host*” + connection state | Keeps running when AgentDock quits **only if the worker confirmed it is persistent**; otherwise shown as “will stop”. |

Where they appear:

- **Sidebar row** — kind glyph at the right edge for background and remote (local is the default and shows no glyph, to reduce noise); full kind in the accessible name.
- **Session header** — always a chip with glyph + text label.
- **Inbox → Running in background** — grouped under sub-headings “Local tasks”, “Background agents”, “Remote tasks”, each with its glyph.
- **Quit dialog** — “2 local tasks and 1 background agent will stop. 1 remote task keeps running on lab-vm.” with per-item list. Never says “keeps running” for a remote task the worker has not confirmed.
- **Project group header** — remote projects show the remote glyph next to the name.

Remote connection sub-states (overlay on any status): `connected · last event Ns ago`, `reconnecting in Ns`, `disconnected · last event 2 min ago — current state unknown`. A remote task whose last event is older than the staleness threshold shows the disconnected glyph and “last known: Running”, never a confident “Running”.

## 4. Attention model (inbox, badge, switcher ordering)

Classification is a pure function of session data plus “which session is on screen”. Evaluated in order; first match wins:

1. `awaiting-approval` or `awaiting-input` → **Needs reply** — *including the session currently on screen* (the card may be scrolled away and the agent is blocked) and *including an archived session*. Entering an awaiting state also unarchives the session (§5), so in practice an archived session never waits silently; this rule is the safety net if the two events race.
   - 1a. **Remote and disconnected** with last known state `awaiting-*` → still **Needs reply** and counted, with the subtitle “Approval · disconnected — last known”. Opening it shows the card with Approve/Deny **disabled** and the text “Reconnect to respond. The worker decides what is still pending.” On reconnect the card refreshes from the worker before any button is enabled; an approval that the worker no longer reports is shown as “No longer pending”, never as approved.
2. Archived → not listed.
3. The session on screen → not listed (you are looking at it).
4. Terminal state (`completed`, `failed`, `interrupted`, `cancelled`) and **not viewed** → **New results to review**.
5. `running`, `queued` or `paused` → **Running in background** (paused rows carry the “Paused” label; a disconnected remote row says “last known: Running”).
6. Otherwise → not listed.

Scope: sessions of projects that are registered in AgentDock (removed projects excluded), all projects regardless of sidebar collapse or filter state, sub-tasks included (row subtitle names the parent).

“Viewed” means: the session was opened while the window had focus and its latest output was rendered, or the user chose **Mark reviewed** (one row) / **Mark completed as reviewed** (bulk). It is persisted (SQLite), so errors stay in “to review” until seen, not “until the next success”.

**Bulk “Mark completed as reviewed”** (in the inbox, replaces the earlier “Mark all reviewed”):

- applies only to `completed` and `cancelled` results; `failed` (including quota and auth) and `interrupted` results stay listed until opened, because they need a decision (retry, switch agent, start from history);
- **never archives** anything — a sub-task is archived only after its result was actually opened (§5), so marked sub-tasks stay visible under their parent as “Done”;
- is never the initial focus of the inbox (the first row is; see [accessibility.md](accessibility.md#inbox-and-usage-popovers-non-modal-dialog));
- confirms with a toast “Marked as reviewed: N” with **Undo** (8 s), and announces politely. Undo restores the rows to “to review”. The toast is not the only way back: the same sessions remain reachable in the sidebar and through Ctrl+K.

### Badge semantics (top-bar inbox button)

| Situation | Bell glyph | Badge | Accessible name |
| --- | --- | --- | --- |
| Nothing to reply or review | plain bell | hidden | “Inbox: nothing needs you, 3 running in background” |
| Only results to review | plain bell | **round outlined pill** with count | “Inbox: 2 to review, …” |
| At least one needs reply | **bell with “!”** | **square filled badge, “!” prefix**, e.g. `!3` | “Inbox: 1 needs reply, 2 to review, …” |
| Background work exists | + small spinning ring after the badge (static when reduced motion) | not counted | “…, N running in background” |

- Count = Needs reply + New results. Background never inflates the number, so the number always means “things waiting for you”.
- `99+` above 99. Badge text size follows the UI text-size setting (`--ad-text-2xs` scales with it).
- Count wording avoids locale plural rules in short labels (“To review: 2”) so translations do not need plural forms in the badge.

### Inbox popover contents

Three sections in fixed order, each with a heading, glyph and count: **Needs your reply**, **New results to review** (followed by “Mark completed as reviewed (N)” when N ≥ 1), **Running in background** (grouped by kind). Opening the inbox focuses the first row; with no rows at all, the popover itself. Rows: status glyph, title, relative time, subtitle “*reason* · *project* › *parent*”. Activating a row opens the session and closes the popover. Approve/deny is **not** offered in the inbox: approvals need the full command, scope and rule, which only the session card shows.

## 5. Main sessions, sub-tasks and archiving

- **Main sessions never auto-archive.** They can receive new tasks at any time. Archive is a manual action with confirmation, **offered only in a terminal state** (`completed`, `failed`, `interrupted`, `cancelled`); a running, queued, paused or awaiting session must be stopped first. An archived main session is still searchable (Ctrl+K, ranked lower, tagged “archived”).
- **Waiting always wins over archived.** If an archived session (main or sub-task) enters `awaiting-approval` or `awaiting-input` — for example a remote worker resumes it — AgentDock unarchives it, shows it in **Needs reply**, and announces it like any other approval. The inbox rule order (§4, rule 1 before rule 2) is the safety net.
- **Sub-tasks (background agents) auto-archive** only when all hold:
  1. state is `completed` or `cancelled`;
  2. the result has been **opened** (rendered on screen). “Mark reviewed” / “Mark completed as reviewed” clear the inbox entry but do **not** satisfy this condition — “collapse only after the result has been seen” means actually seen;
  3. the user navigates away from it (a row never disappears while focused, hovered or on screen);
  4. the user has not restored it before (Undo or Unarchive). An explicitly restored sub-task is never auto-archived again; it can still be archived manually.
  A toast confirms with **Undo** (8 s) and announces politely. After Undo, focus moves to the restored row in the sidebar (or to the session heading if the sidebar is hidden), never to the page body.
- **Undo is not the only way back.** Every archived session has an **Unarchive** button in its session header (reach it through “Show N archived sub-tasks” or Ctrl+K). A toast that disappears while focused moves focus to the session heading.
- `failed` and `interrupted` sub-tasks **never auto-archive**; they stay under the parent until the user retries or archives them.
- Under each expanded main session: live sub-tasks, then a “Show N archived sub-tasks” toggle row. A collapsed main session summarises its children inline: “1 need you · 2 new · 3 running”, plus the attention glyph if any child needs a reply.

## 6. Unread / new-activity markers

- `N new` pill (outlined, accent) on a sidebar row = agent events arrived since you last viewed it. Title becomes semibold. Both cleared on open.
- Inside the open session: if you have scrolled up, new events do not move the view; a **“N new below · Jump to latest”** pill appears (see [accessibility.md → long transcripts](accessibility.md#3-long-transcripts)).
- Activity on the session on screen while you are at the bottom does not create “new” markers.

## 7. Surface × state matrix

The six required states, per surface. Visual examples: [`prototype/states.html`](prototype/states.html) and [`screenshots/11-state-gallery-light.png`](screenshots/11-state-gallery-light.png).

| State | Home | Sidebar | Session | Review panel | Inbox / usage |
| --- | --- | --- | --- | --- | --- |
| **Empty** | First run: “Add your first repository” + next step (connect an agent). Later: “Nothing is waiting for you.” | Project with no tasks: “No tasks yet. Start a task” | New session: composer focused, suggestions from the project’s recent tasks | “No changes yet — this worktree matches its base branch.” | “No agent is waiting for you…”; no badge |
| **Loading** | Section skeleton + label | Rows render from local cache first; never blank | “Loading history from local store… (n of ~N events)”; composer stays editable | “Computing diff…”; after 10 s offer “file list only” | Opens instantly from cached model |
| **Offline / disconnected** | Banner: what is unreachable, what still works | Remote rows switch to disconnected glyph | Banner with last event time, retry; remote state stated as *unknown* | Local diff still works; PR/CI rows show “unknown — offline” | Usage values greyed with “as of *time*” |
| **Auth required** | Adapter card: “Sign in with the agent’s own flow” | Glyph: key on affected sessions | Card: hand-off to the agent’s sign-in; draft kept; “Use another agent” | GitHub actions show “Sign-in needed to open a PR. Nothing was pushed.” | Account row: “Sign-in needed”; no numbers |
| **Quota error** | Listed under Needs you → review | Glyph: gauge × | Card quoting the provider error, source, reset time or **“Unknown — not provided”**, actions Retry / Switch agent | — | Provider-reported meter at 100 % with source label; unknown accounts stay “unknown” |
| **Approval required** | Listed under Needs you → reply | Diamond “!” on row; on collapsed parent if a child needs it | Inline card + sticky banner when scrolled away; restored after restart, never auto-approved | Push/PR actions show the pending approval | Square “!” badge; row “Approval · project” |

## 8. Usage display rules (connected accounts)

From the PRD: *indicate subscription quota as unknown when the provider does not expose it.*

- Top bar **Usage** button opens a popover listing every connected account: agent name, account description (no email shown by default), **source tag**, value, freshness.
- Source tags (always visible, text not just style): **Provider-reported**, **Estimated locally** (API-key cost from token counts × published price; labelled “est.”), **Unknown** (dashed outline, “?”), **Not applicable** (mock), **Sign-in needed**.
- **Unknown never renders a bar.** It renders an empty dashed outline and the sentence “Remaining quota: unknown. The adapter does not expose it.”
- A meter appears only for provider-reported values, with `role="meter"` and the number as text. ≥ 80 % adds the text “high” and an outlined “≥80%” flag on the top-bar button (text, not only colour).
- Per-session token counts appear in the usage popover and session details only when the adapter reports them; otherwise “Token counts not reported by adapter”.
- No polling that costs model tokens. Values refresh on adapter events or explicit refresh.
