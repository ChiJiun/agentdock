# Design system: tokens, themes, components, icons

Status: Draft for issue #2. Canonical values live in [`tokens/tokens.css`](tokens/tokens.css); this page explains them. The prototype consumes only these tokens.

## 1. Direction

AgentDock is a **work console**: dense but calm, evidence-first, readable for hours. The identity is deliberately different from Claude Code Desktop — cool neutral greys with a **harbor-teal** accent, squarer corners, system fonts, and shape-coded status glyphs. It must not be mistaken for an Anthropic product (see [README → source statement](README.md#source-and-provenance-statement)).

Principles:
1. **Status before decoration** — colour is reserved for state and the single accent; surfaces stay neutral.
2. **One accent** — teal marks primary actions, selection and focus. Status hues never double as brand colour.
3. **Density with air** — 13 px UI text, 14 px transcript text at 1.6 line height, 4 px spacing grid.
4. **Same vocabulary everywhere** — a glyph means the same thing in sidebar, inbox, switcher, header and (future) phone.

## 2. Typography

System font stacks, so nothing has to be licensed or bundled:

| Token | Value |
| --- | --- |
| `--ad-font-ui` | Segoe UI Variable Text, Segoe UI, system-ui, -apple-system, Noto Sans TC, Microsoft JhengHei UI, PingFang TC, sans-serif |
| `--ad-font-mono` | Cascadia Code, Cascadia Mono, Consolas, JetBrains Mono, ui-monospace, SFMono-Regular, monospace (ligatures disabled in code and diffs so `===` stays three characters) |

| Size token | px | Use |
| --- | --- | --- |
| `--ad-text-2xs` | 11 | badges, kbd hints, tags |
| `--ad-text-xs` | 12 | meta, timestamps, file paths |
| `--ad-text-sm` | 13 | default UI (sidebar, buttons, menus) |
| `--ad-text-md` | 14 | transcript, composer, section headings |
| `--ad-text-lg` | 16 | session title |
| `--ad-text-xl` | 20 | screen titles |
| `--ad-text-2xl` | 24 | empty-state headline |

Line heights: tight 1.25 (headings), UI 1.4, prose 1.6 (transcript; comfortable for CJK). Weights: 400 / 500 / 600 only. The UI text-size setting scales the whole size ramp.

## 3. Spacing, radius, layout

- Spacing (4 px grid): `--ad-space-0…11` = 0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48 px.
- Radius: `xs` 2 (kbd, code), `sm` 4 (inputs, rows, buttons), `md` 6 (cards, tool events), `lg` 10 (popovers, dialogs, drawers), `pill`.
- Layout: top bar 44 px; sidebar 280 px (220–400, resizable); review panel 440 px (360–720); transcript measure 820 px; sidebar row 30 px (compact 26); minimum target 24 px.
- Breakpoints: **wide ≥ 1280** (3 columns), **medium 960–1279** (sidebar + main; review as overlay drawer), **narrow < 960** (main only; both as drawers), **compact < 600** (drawers full width, labels collapse to icons with accessible names).

## 4. Colour and themes

Two themes, **light** (default) and **dark**, plus **system** (follows `prefers-color-scheme`). Set with `<html data-theme="light|dark">`; absent = system.

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| `bg-canvas` | `#F5F6F8` | `#0F1217` | app background, top bar |
| `bg-surface` | `#FFFFFF` | `#161A21` | main column, cards |
| `bg-sunken` | `#ECEEF2` | `#0B0E12` | sidebar, code, user bubbles |
| `bg-raised` | `#FFFFFF` | `#1D222B` | popovers, dialogs (+ shadow, + border in dark) |
| `bg-selected` | `#DCEFEC` | `#12312F` | current row (always with bar + `aria-current`) |
| `text-primary / secondary / tertiary` | `#151A22 / #465061 / #5F6878` | `#E7EAF0 / #AEB6C3 / #959EAD` | |
| `accent` | `#0A6B66` | `#3FC7BB` | primary buttons, selection bar, focus ring, “new” pill |
| `status-running` | `#1D5FC2` | `#6FA6FF` | running |
| `status-attention` | `#8F4E00` | `#F0B44C` | needs reply / approval |
| `status-success` | `#1B7339` | `#5CCB7E` | done, passed |
| `status-danger` | `#B3261E` | `#FF8A80` | failed, quota, auth, blocking |
| `status-neutral` | `#5F6878` | `#959EAD` | queued, interrupted, cancelled, archived |
| `kind-local / background / remote` | `#465061 / #2D6577 / #6B3FC4` | `#AEB6C3 / #7FC3D6 / #B79BFF` | task-kind glyphs |
| `diff-add / del` (fg on bg) | `#1B7339` on `#E3F4E8` / `#B3261E` on `#FBE6E4` | `#5CCB7E` on `#12301C` / `#FF8A80` on `#3B1716` | diff lines |

Every text/UI pair is checked by [`tools/check-contrast.mjs`](tools/check-contrast.mjs); results in [accessibility.md §5](accessibility.md#5-contrast). Change a colour → re-run the script → update the table.

## 5. Elevation and motion

- Shadows: `shadow-1` (rows on hover, optional), `shadow-2` (pills, toasts), `shadow-3` (popovers, dialogs, drawers). Dark theme relies on borders as well, because shadows are weak on dark surfaces.
- Layers: base 0, sticky 10, drawer 30, popover 40, dialog 50, toast 60.
- Durations: fast 80 ms (hover/press), base 140 ms (popover, disclosure), slow 220 ms (drawer, panel resize). Easing: standard `cubic-bezier(0.2,0,0,1)`, exit `cubic-bezier(0.4,0,1,1)`. Spinner period 1.1 s.
- Reduced motion: all durations 0, spinners static; nothing conveys meaning through motion alone.

## 6. Icons

**Decision (proposed):** the application uses **[Lucide](https://lucide.dev/)** (`lucide-react`), pinned to an exact version when issue #4 adds dependencies.

- Licence (checked 2026-11-17 against `lucide-icons/lucide` `main` @ `f8feea7a02ea461c9f2a4b4d851512aae6ec933f`, latest release tag `1.73.0`): the `LICENSE` file is **ISC** (“Lucide Icons and Contributors”), plus an **MIT** notice (Cole Bemis, Feather) for a listed subset of Feather-derived icons. GitHub’s licence detector reports `NOASSERTION` because of this combined file, so the SPDX expression to record is `ISC AND MIT`. Both are permissive; the full `LICENSE` text must ship in the app’s third-party notices. Re-check the file of the exact version pinned in issue #4.
- Why: consistent 24 px/1.5–2 px stroke style that matches the design direction, tree-shakable React components, `currentColor`, large set covering git/terminal/server concepts, no attribution UI required beyond the notice file.
- Alternatives considered: Phosphor (MIT; heavier weight variants), Tabler Icons (MIT; similar), Material Symbols (Apache-2.0; visually tied to Google), drawing our own (most control, most effort).
- **Status glyphs are product vocabulary.** They may stay custom even after adopting Lucide, so that shapes remain distinct at 12–16 px (filled diamond “!”, filled bubble “?”, filled vs outlined check, dashed circle for interrupted). Lucide equivalents can be used where they keep the shape contract in [states-and-indicators.md §2](states-and-indicators.md#2-session-status-vocabulary).
- **Prototype icons** in [`prototype/icons.js`](prototype/icons.js) are original placeholder drawings made for this repository on a 16 px grid; they are not copied from Lucide or any other set.
- **Agent identities** are shown as neutral two-letter monograms (“CC”, “CO”) plus the product name as plain text. No third-party logos are bundled.
- **Brand mark**: the prototype uses a placeholder of two offset bars drawn in CSS. A real mark is out of scope until the product name is cleared (README: name is a working title).

## 7. Component inventory

| Component | Variants / states | Key a11y | Where specified |
| --- | --- | --- | --- |
| App shell | wide / medium / narrow / compact | landmarks, skip link | [wireframes.md](wireframes.md) |
| Top bar | — | header landmark | [IA §3](information-architecture.md#3-regions-of-the-shell) |
| Switcher trigger | — | `aria-keyshortcuts` | IA §4 |
| Inbox button | none / review / reply; background ring | name includes all counts | [states §4](states-and-indicators.md#badge-semantics-top-bar-inbox-button) |
| Inbox popover | empty sections; 3 groups | non-modal dialog, arrow keys | states §4 |
| Usage button + popover | normal / ≥80 % flag; per-source rows | `role="meter"` only for reported values | states §8 |
| Theme toggle | system / light / dark | name states current theme | — |
| Sidebar tree | group row, main session row, sub-task row, archived toggle, “N archived — search” row | APG tree | IA §5, a11y §2 |
| Status glyph | 13 states | `title` + text elsewhere | states §2 |
| Kind glyph / chip | local / background / remote | text label | states §3 |
| Policy enforcement chip, glyph and note | not enforced / unknown (nothing shown when requests are routed) | text label, dashed outline, `role="note"` for the persistent note | [states §9](states-and-indicators.md#9-policy-enforcement-indicator-agent-bypass--full-access-modes) |
| “N new” pill | — | text | states §6 |
| Agent monogram | — | decorative; name as text | §6 |
| Quick switcher | empty-query groups / results / no results / “N more” | modal combobox | a11y §2 |
| Session header | running (Stop) / idle; changes / none | `h1` focus target | IA §4 |
| Attention banner | approval / question | “Show” focuses the card | IA §4 |
| Timeline (log) | — | `role="log"`, `aria-live="off"` | a11y §3 |
| User message, agent message | — | “You said:” prefix | — |
| Tool event card | collapsed / expanded; ok / error | `<details>` | — |
| Plan card | step done / active / todo | status text per step | — |
| Approval card | pending / approved / denied | group with label, no shortcut | [flows F2](flows.md#f2--something-needs-approval-while-i-work-elsewhere) |
| Question card | pending / answered | choices as buttons | — |
| Notice card | interrupted / quota / auth / remote / cancelled / failed | `role="note"` | states §7 |
| Completion card | with / without changes | primary “Review changes” | flows F1 |
| Jump-to-latest pill | count | button | a11y §3 |
| Composer | idle / running (Steer) / with ghost suggestion / draft | Tab rule, IME-safe Enter | a11y §1 |
| Suggestion chips | 0–3 | buttons, labelled “Suggested next” | — |
| Review panel | docked / drawer; tabs Changes · Checks · Findings; empty / loading | APG tabs | IA §4 |
| File row | A / M / D / R | full name with counts | — |
| Diff viewer | unified (MVP); split later | +/− text, SR prefixes | — |
| Check row | passed / failed / not run | text status | — |
| Finding row | blocking / suggestion | text tag | — |
| Toast | with action (Undo) | polite live region, ≥ 8 s | — |
| Dialog | shortcuts, quit confirmation | modal, focus return | — |
| Empty / loading / error states | per surface | text, not only skeleton | [states §7](states-and-indicators.md#7-surface--state-matrix) |
| Settings | sections nav + pages | nav landmark | IA §4 |
