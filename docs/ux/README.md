# AgentDock UX specification

Status: Draft for [issue #2](https://github.com/ChiJiun/agentdock/issues/2) · 2026-11-17. Original design for an independent product; see the [source statement](#source-and-provenance-statement).

This folder defines how AgentDock looks and behaves before any application code exists (scaffold: issue #4). It is the reference for UI implementation and for UI acceptance tests.

## Contents

| Document | What it answers |
| --- | --- |
| [information-architecture.md](information-architecture.md) | Objects, screen map, shell regions, each screen, navigation model (why no tab strip), future phone mapping |
| [wireframes.md](wireframes.md) | 3-column desktop and narrow-window drawer wireframes (SVG + ASCII), breakpoints |
| [states-and-indicators.md](states-and-indicators.md) | Status vocabulary, local / background / remote indicators, inbox & badge rules, sub-task archiving, surface × state matrix, usage display |
| [flows.md](flows.md) | Repository → reviewed change in ≤ 3 actions, approvals, switching, sub-task lifecycle, restart, quota, disconnect |
| [accessibility.md](accessibility.md) | Keyboard map, focus rules, ARIA patterns, long transcripts, non-colour cues, contrast results |
| [design-system.md](design-system.md) | Typography, spacing, colour, themes, motion, icons (licence), component inventory |
| [acceptance-criteria.md](acceptance-criteria.md) | Numbered UI acceptance criteria with what the prototype verified |
| [tokens/tokens.css](tokens/tokens.css) | Canonical design tokens (light, dark, system) |
| [tools/check-contrast.mjs](tools/check-contrast.mjs) | `node docs/ux/tools/check-contrast.mjs` — contrast check of the tokens |
| [prototype/](prototype/) | Static interactive prototype (`index.html`) and state gallery (`states.html`) |
| [screenshots/](screenshots/) | Headless-Chrome captures of the prototype |
| [wireframes/](wireframes/) | SVG wireframes |

## Opening the prototype

No build, no dependencies, no network. Either:

- double-click `docs/ux/prototype/index.html` (works from `file://`), or
- serve the `docs/ux` folder, e.g. `python -m http.server 8765 --bind 127.0.0.1 --directory docs/ux`, and open `http://localhost:8765/prototype/index.html`.

Things to try: Ctrl+K (switch), Ctrl+Shift+J (inbox), Ctrl+J (next item that needs you), F6 (regions), arrow keys in the sidebar, Ctrl+Shift+G (review), Ctrl+B (sidebar), Ctrl+/ (all shortcuts); open “Explore existing session model” then leave it (auto-archive with Undo); Home → pick a repository → type → Enter → “Review changes” (≤ 3 actions); approve or deny in “Fix flaky worktree cleanup test”; resize the window below 1280 and 960 px.

URL parameters (for screenshots/reviews): `theme=light|dark`, `session=<id>` (`s1` running, `s2` long transcript, `s4` approval, `s5` question, `s3` interrupted, `s7` quota), `view=home|settings`, `open=inbox|usage|switcher|help|sidebar`, `q=<query>` (with `open=switcher`), `review=1`, `static=1` (freeze simulated activity), `scroll=mid`.

All data is fictional. Usage numbers are illustrative and do not describe what any provider actually reports.

## Requirement traceability

Requests from the project owner, and where each is answered:

| # | Request (original wording, translated) | Screen / component | Spec |
| --- | --- | --- | --- |
| R1 | Switch easily among frequently used sessions; show conversations that have new activity; make anything that needs confirmation very clear; support parallel multi-project work. | Pinned group + Alt+1…9; quick switcher (Recent group); sidebar “N new” pill + semibold title; Needs-reply glyph, badge, sticky banner, approval card; project groups | [IA §5](information-architecture.md#5-navigation-model--why-there-is-no-tab-strip), [states §2, §4, §6](states-and-indicators.md) |
| R2 | Main sessions spawn many sub-sessions; finished sub-sessions should stop being shown (archive), but main sessions must not archive themselves. | Sidebar nested sub-tasks, “Show N archived sub-tasks”, collapsed-parent summary; toast with Undo | [states §5](states-and-indicators.md#5-main-sessions-sub-tasks-and-archiving), [flows F4](flows.md#f4--parallel-sub-tasks-finish-are-reviewed-then-get-out-of-the-way) |
| R3 | Only collapse after the result has been seen. A top-bar icon that opens a list of what needs a reply, what needs reviewing, and background tasks. | “Viewed” rule; top-bar **Inbox** with three sections; Ctrl+J | [states §4](states-and-indicators.md#4-attention-model-inbox-badge-switcher-ordering) |
| R4 | See Git changes like Claude Desktop does. | **Review panel/drawer**: Changes (file list + diff), Checks, Findings, comment to agent; header “Changes +a −d” | [IA §4](information-architecture.md#review-panel--drawer), [wireframes](wireframes.md) |
| R5 | Show the usage of connected accounts (PRD: unknown must be shown as unknown). | Top-bar **Usage** popover with source labels; per-session counts only when reported | [states §8](states-and-indicators.md#8-usage-display-rules-connected-accounts) |
| R6 | The input box: Tab suggests the next prompt. | Composer ghost suggestion + “Suggested next” chips; Tab rule without focus trap | [a11y §1](accessibility.md#1-keyboard-map), [IA §4](information-architecture.md#session) |
| R7 | Avoid the crowded session tab-button row of the previous attempt; focus on fast switching (switcher, grouping, pinning). | No tab strip; switcher, pinned, project grouping, inbox | [IA §5](information-architecture.md#5-navigation-model--why-there-is-no-tab-strip) |
| R8 | Android client later; MVP excludes mobile, but status indicators and IA must map to narrow screens. | Shared glyph/label vocabulary; narrow and compact breakpoints; phone mapping table | [IA §6](information-architecture.md#6-future-narrowmobile-mapping-not-mvp) |
| Issue #2 | Screens (Home, Project, Session, Review, Settings), six states, wireframes, tokens/themes/icons, a11y, ≤ 3-action flow, task-kind distinction, prototype + screenshots | All of the above | [acceptance-criteria.md](acceptance-criteria.md) |

## Decisions for the owner

Proposed defaults are implemented in the prototype; each can be changed without restructuring.

1. **Pinned sessions appear only in the Pinned group** (not duplicated under their project). Alternative: show in both places (familiar, but arrow-key navigation visits them twice).
2. **A session on screen that needs approval still counts in the badge.** Alternative: exclude the on-screen session entirely (smaller number, but an approval scrolled off-screen could be missed).
3. **Switcher order with an empty query**: Needs reply → Recent → New results → Pinned → Running. Alternative: Recent first (faster A↔B toggling, but approvals sink below).
4. **Sub-task auto-archive** only for completed/cancelled + viewed + navigated away; failed/interrupted never auto-archive. Alternatives: time-based archiving; archive failed ones too.
5. **Tab accepts the suggested prompt** only when the composer is empty and the ghost is visible. Alternative: a dedicated key (→ at end of empty input, or Ctrl+Space) so Tab always moves focus.
6. **Suggested prompts are rule-based templates in MVP** (no model tokens). Alternative: ask the agent for suggestions (better, but costs tokens and needs adapter support).
7. **Approvals cannot be decided from the inbox.** Alternative: inline approve for low-risk rules only.
8. **Usage lives in the top bar**, not the sidebar footer, so it stays visible when the sidebar is collapsed.
9. **Visual identity**: harbor-teal accent, system fonts, placeholder brand mark. The name “AgentDock” is still a working title.
10. **UI copy in English first**, strings externalised; zh-TW localisation as a follow-up.
11. **Icon library: Lucide (ISC AND MIT)**, with custom status glyphs kept as product vocabulary.

## Out of scope here

Application scaffold, `package.json`/`Cargo.toml` (issue #4); data contracts (`docs/contracts/`, other work); ADRs 0002–0003; mobile client; IDE features; drag-and-drop layout editing.

## Source and provenance statement

**Interaction references (patterns only, no assets or text copied):**

- Claude Code Desktop as publicly described in [Anthropic: Redesigning Claude Code on desktop](https://claude.com/resources/articles/claude-code-desktop-redesign), referenced by the issue: a sidebar of projects and concurrent sessions, a primary conversation column with visible tool activity, an integrated diff/review side panel, inline permission prompts and keyboard-first navigation. This spec adopts those *interaction patterns* at the level of “there is a sidebar, a conversation and a side panel”. No screenshots, measurements, wording, illustrations, icons, colours, fonts or code from that article or from the product were used. The article was not consulted while drawing the wireframes or choosing tokens.
- General, widely used patterns: command palette / quick switcher (common in code editors), notification inbox with badge, WAI-ARIA Authoring Practices patterns (tree, combobox, tabs, dialog, disclosure), unified diff presentation.
- ChiJiun/acpira PR #7 (attention inbox and Ctrl/Cmd+K switcher, three review rounds): only **requirements and acceptance scenarios** were reused (classification and scope rules, badge semantics, focus restore paths, modal exclusivity, grapheme/NFC matching, 100-row cap, IME handling, plural-free count labels). **No code** from that repository was copied; the prototype here is written from scratch. That repository’s licensing and source policy are handled in issue #1.

**Confirmed absent:** no Claude/Anthropic logos, wordmarks, icons, illustrations, typefaces, colour palette, UI copy or source code; no screenshots of Claude products. Third-party product names (Claude Code, Codex, GitHub) appear only as plain-text labels identifying adapters/integrations, with neutral two-letter monograms instead of logos.

**Original work in this folder:** all wireframes, tokens, colours, copy, prototype HTML/CSS/JS and the placeholder icons in `prototype/icons.js` were created for this repository. The prototype loads no external scripts, fonts or CDN resources.

**Planned third-party asset:** Lucide icons (ISC AND MIT), not yet added; licence details in [design-system.md → Icons](design-system.md#6-icons).
