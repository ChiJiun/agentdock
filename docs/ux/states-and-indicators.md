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
| **Background agent** | A delegate session spawned by a main session or by “run in background” (explorer, test writer, reviewer). Runs on this computer, has no foreground conversation, reports back to its parent. | stacked layers | “Background agent” + parent link (“Sub-task of …”) | Stops when AgentDock quits. Auto-archives only after its result has been **opened** and the user has moved on (see §5); marking it reviewed is not enough. |
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

**Viewed and opened are two facts. Do not merge them.**

| Term | Becomes true when | What it does |
| --- | --- | --- |
| **viewed** | the result was acknowledged: the session was **opened** (below), or the user chose **Mark completed as reviewed** (bulk; completed and cancelled results only) | Removes the session from “New results to review” (rule 4) and turns “Done · new” into “Done”. Persisted, so errors stay in “to review” until seen, not “until the next success”. |
| **opened** | the session was on screen while the window had focus and its latest output was rendered, **after the session entered its current terminal state** | The only thing that satisfies the sub-task archive rule (§5, condition 2). |

- opened ⇒ viewed. viewed ⇏ opened: a bulk-marked result is viewed but not opened.
- Both are reset when the session leaves the terminal state (it runs again); the next result has to be opened again.
- There is **no single-row “Mark reviewed” in the MVP**. Opening the row is the one-row path: it costs the same single action and actually shows the result. A per-row action that dismisses a result without showing it would be a second way to mark a failure as dealt with unseen. If it is added later it needs its own place (a row menu, not a button inside the row, so the row keeps one Tab stop), must follow the same “never archives” rule as the bulk action, and must be decided for failed and interrupted results explicitly.
- Contract names (ADR-0003, PR #22, **not merged yet — to be aligned once it is**): `session.result_acknowledged` / `task.outcome_acknowledged` with `method: opened | marked_reviewed | bulk_marked_reviewed`. `opened` here is `method: opened`; “Mark completed as reviewed” is `bulk_marked_reviewed`; `marked_reviewed` has no UI in the MVP. This spec does not define the schema.

**Bulk “Mark completed as reviewed”** (in the inbox, replaces the earlier “Mark all reviewed”):

- applies only to `completed` and `cancelled` results; `failed` (including quota and auth) and `interrupted` results stay listed until opened, because they need a decision (retry, switch agent, start from history);
- **never archives** anything — a sub-task is archived only after its result was actually opened (§5), so marked sub-tasks stay visible under their parent as “Done”;
- is never the initial focus of the inbox (the first row is; see [accessibility.md](accessibility.md#inbox-and-usage-popovers-non-modal-dialog));
- confirms with a toast “Marked as reviewed: N” with **Undo** (8 s), and announces politely. Undo restores the rows to “to review”.
  - Undo **only revokes that acknowledgement** (viewed → not viewed, unread count back). It does not touch opened, archived or the restored flag, and it **skips any result the user has opened since the bulk action** (it stays viewed — the user has seen it) and any session that is no longer in a terminal state. The announcement gives the number actually restored.
  - The sessions remain reachable in the sidebar and through Ctrl+K, but that is not a way back to “to review”, and a keyboard user can rarely reach the toast in 8 s — see the known limit in [accessibility.md §6](accessibility.md#6-other-requirements).
  - Contract: PR #22 has no event that revokes an acknowledgement yet (its “Divergences”, item 3); the bulk action must not ship in the app before one exists.

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
- **Waiting always wins over archived.** If an archived session (main or sub-task) enters `awaiting-approval` or `awaiting-input` — for example a remote worker resumes it — AgentDock unarchives it, shows it in **Needs reply**, and announces it like any other approval. The inbox rule order (§4, rule 1 before rule 2) is the safety net. This is a **system restore and does not set the “restored by user” flag** (condition 4 below): the user did not ask to keep the sub-task. After the user answers and the sub-task finishes again, it can auto-archive again once the *new* result has been opened (condition 2 is evaluated against the new terminal state). Contract names, to be aligned after PR #22 merges: `session.unarchived{by: system}` versus `{by: user}`.
- **Sub-tasks (background agents) auto-archive** only when all hold:
  1. state is `completed` or `cancelled`;
  2. **after it entered that terminal state**, its latest output has been **opened** (rendered on screen while the window had focus; §4). Timing matters:
     - an opening that happened *before* the state was entered does not count — watching a sub-task run and leaving before it finishes is not seeing its result;
     - a result that arrives while the sub-task is on screen counts at that moment (if the window is not focused, when it regains focus with the sub-task still on screen — the prototype does not model window focus and treats “on screen” as enough);
     - “Mark completed as reviewed” clears the inbox entry but does **not** satisfy this condition — “collapse only after the result has been seen” means actually seen;
  3. the user navigates away from it (a row never disappears while focused, hovered or on screen);
  4. the user has not restored it before with **Undo** or **Unarchive** (the “restored by user” flag). An explicitly restored sub-task is never auto-archived again; it can still be archived manually. The automatic unarchive of a waiting session (above) does not set this flag.
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

## 9. Policy enforcement indicator (agent bypass / full-access modes)

From ADR-0002, APR-11 (“honest scope”): *agent-native bypass modes (Claude Code `bypassPermissions`, Codex full access) never send permission requests; the UI must say AgentDock does not enforce policy in those modes.* AgentDock’s approval rules act on two things only: permission requests that an agent sends, and operations AgentDock performs itself. An agent that runs its own tools without asking is outside both.

This is a **session-level mode**, orthogonal to status (§2) and kind (§3). It is not an error and not an attention item: nothing is waiting for the user, so it never counts in the inbox badge.

| Enforcement | When | Label | Cues |
| --- | --- | --- | --- |
| **Requests routed** (default) | The agent is in a mode in which it sends permission requests, as set by AgentDock at launch or reported by the adapter. | *No chip.* Session details say “The agent is in a mode in which it sends permission requests; AgentDock rules decide each request it receives.” (Not “the agent always asks”: AgentDock cannot guarantee that.) | — |
| **Not enforced** | The agent runs in its own bypass / full-access mode — set by the user through AgentDock, or reported by the adapter. | **Policy not enforced** | Shield-with-slash glyph + text + dashed outline; `status-danger` colour as the secondary cue |
| **Unknown** | The adapter does not report its permission mode and AgentDock did not set it. | **Policy coverage unknown** | “?” prefix + text + dashed outline, neutral colour (same treatment as an unknown usage source, §8) |

Rules:

1. **Never claim more than is true.** No surface shows a “protected”, “enforced” or shield-with-check badge for a session. The line “Enforced by AgentDock, not by the agent prompt” stays on approval cards only, because a card *is* a request that reached AgentDock.
2. **Source, not inference.** The mode comes from what AgentDock set when it launched or configured the session, or from what the adapter reports (which adapter mode ids count as bypass is declared per adapter; an unrecognised mode id is **Unknown**). AgentDock never infers the mode from behaviour — “no permission request for a while” proves nothing.
3. **Where “Not enforced” shows** (all of them, for as long as the mode is active):
   - **Session header** — chip “Policy not enforced”.
   - **Persistent note under the header**, not dismissible while the mode is active: “AgentDock policy is not enforced in this session. *Agent* is running in its own *mode name* mode (*source*): it runs commands and edits files without asking AgentDock, so approval rules do not apply to what the agent does. AgentDock still asks before the operations it performs itself (push, pull request, merge, worktree removal).”
   - **Sidebar row** — the glyph at the right edge, and “policy not enforced” in the accessible name.
   - **Inbox, Home, project and switcher rows** — the words “policy not enforced” in the row subtitle / tag.
   - **Timeline** — a notice at the point where the mode started (“Permission mode: full access — reported by the adapter”), and again when it ends. Tool events in between are shown as the agent reported them and never carry an “approved” or “allowed by rule” marker.
   - **Settings → Agents & adapters** — per adapter, whether it reports its permission mode.
4. **“Unknown” is quieter**: header chip and session details only (no sidebar glyph, no note), with the text “This adapter does not report its permission mode. AgentDock applies its rules to the requests it receives and cannot tell whether the agent asks for everything.”
5. **Entering the mode.** AgentDock never selects a bypass mode by default or on its own. If the user turns it on through AgentDock, a confirmation dialog states the consequence in the words of the note above; the default button is Cancel. If the agent reports that it switched by itself, the note appears, the timeline records it, and a polite announcement says “Policy is no longer enforced in *title*”. Approvals remain the only assertive announcement.
6. **Operations AgentDock performs itself** (push, PR, merge, worktree removal and the other host-policy operations) still require their approvals in every mode; the note says so, so that “not enforced” is not read as “nothing is checked”.
7. **Sub-tasks** carry their own value. A collapsed parent shows the glyph if any live child is “Not enforced”.

Data needed (requirement only; schema belongs to the contracts): a per-session enforcement value (`requests routed` / `not enforced` / `unknown`), the agent’s own mode name as reported, the source (set by AgentDock / reported by adapter), and events when it changes. PR #22 (ADR-0003) currently states the labelling requirement in its ACP-capability and replay documents but defines no field for it; to be aligned after PR #22 merges.

Prototype: session `s8` (“Rename fixture files to kebab-case”, `?session=s8`) shows the chip, the note, the sidebar glyph and the timeline notice; the state gallery (`states.html`) shows “Not enforced” and “Unknown” side by side and the wording of the confirmation as a static card. The confirmation dialog’s behaviour, the mode-change announcement and the end-of-mode notice are not prototyped. Screenshot: [`14-policy-not-enforced-light.png`](screenshots/14-policy-not-enforced-light.png).
