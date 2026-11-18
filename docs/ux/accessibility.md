# Keyboard, focus and accessibility specification

Status: Draft for issue #2. Target: **WCAG 2.2 AA** on Windows (Narrator, NVDA) first; patterns follow the WAI-ARIA Authoring Practices (tree, combobox/listbox, tabs, dialog, disclosure).

## 1. Keyboard map

| Action | Shortcut | Notes |
| --- | --- | --- |
| Quick switcher (switch session / search) | **Ctrl+K** | Pressing again closes it and restores focus. Not opened while another modal is open. |
| Inbox | **Ctrl+Shift+J** | Toggles; focus goes to the first row (never to a header action such as “Mark completed as reviewed”); with no rows, to the popover. |
| Next item that needs you | **Ctrl+J** | First “Needs reply” (excluding the one on screen), else first “New result”. Announces “Nothing needs you right now” otherwise. |
| Pinned session 1–9 | **Alt+1 … Alt+9** | Focus lands in the composer. |
| Next / previous region | **F6 / Shift+F6** | Top bar → sidebar → conversation → composer → review panel (skips hidden regions). |
| Toggle sidebar | **Ctrl+B** | Drawer below 960 px. |
| Toggle review panel | **Ctrl+Shift+G** | Drawer below 1280 px. |
| New task | **Ctrl+N** (app) / Alt+N (prototype; browsers reserve Ctrl+N) | Opens Home with the repository cards. |
| Keyboard shortcuts | **Ctrl+/** | Dialog listing everything here. |
| Close topmost overlay | **Esc** | Order: dialog → popover → drawer → review overlay. Esc never cancels an agent. |
| Send / steer | **Enter** in composer | Shift+Enter = newline. Ignored during IME composition. |
| Insert suggested prompt | **Tab** in composer (secondary: **→**) | Only while the composer is empty **and** the ghost suggestion is visible; otherwise Tab moves focus normally (no trap) and → moves the caret. Esc hides the ghost for this session. Tab is kept because the owner asked for it; Ctrl+Space is **not** used because it toggles the input method on Windows Chinese IMEs. |
| Stop agent | Stop button | Deliberately no global shortcut in MVP (destructive to work in progress). In the composer, Stop comes **after** Send/Steer in focus order, so Tab from the composer reaches Steer first and Tab+Enter never cancels the run. |
| Approve / deny | **No shortcut** | Requires focusing the button in the approval card. Prevents approving by accident or by a keystroke meant for another window. |

Shortcuts are listed in `aria-keyshortcuts` on their controls and in tooltips. All are remappable later (Settings → Keyboard); none use AltGr-prone Ctrl+Alt combinations.

## 2. Component patterns

### Sidebar tree (`role="tree"`)
- Roving tabindex: exactly one row has `tabindex="0"`; the sidebar is one Tab stop.
- ↑/↓ move, Home/End first/last, → expands (or moves into children), ← collapses (or moves to parent), Enter/Space activates (open session, toggle group, toggle archived list).
- Rows expose `aria-level`, `aria-expanded` (if they have children), `aria-current="page"` for the open session, and an accessible name with title + status + kind + “N new” + updated time.
- Live updates re-render rows **without losing focus**: the focused row is restored by id. A row is never removed (archived) while focused.

### Quick switcher (modal `dialog` with `combobox` + `listbox`)
- On open: remember the previously focused element, focus the input.
- ↑/↓ move the active option (`aria-activedescendant`), PageUp/PageDown jump 10, Home/End stay with the text caret (APG combobox), Enter opens.
- **Cancel** (Esc, click on the backdrop, Ctrl+K again) restores focus to the remembered element. **Pick** moves focus to the chosen session’s composer and announces “*title*. *status*. *kind*.”
- Enter during IME composition (`isComposing` / keyCode 229) is ignored.
- Result computation is synchronous for the typed value so Enter never opens a stale result; render at most 100 options.
- Does not open while another modal dialog is open; other modal shortcuts do nothing while it is open.

### Inbox and usage popovers (non-modal `dialog`)
- Open: focus the first row (inbox) — never a section action such as “Mark completed as reviewed”, which comes after the rows — or the popover itself (usage, or an inbox with no rows). ↑/↓/Home/End move between inbox rows; Tab cycles inside (and stays on the popover when it has no controls); Esc closes and returns focus to the trigger button; clicking outside closes without stealing focus.
- `aria-expanded` on the trigger reflects state.

### Review panel
- Tabs follow APG (←/→ switch, one Tab stop). File list items expose “*path*, modified, 12 additions, 3 deletions”. The diff region is focusable for keyboard scrolling; each line carries “+”/“−” text and a visually hidden “added:”/“removed:” prefix.
- Opening moves focus to the panel heading; closing returns focus to the control that opened it (or the header “Changes” button).

### Drawers (narrow layouts)
- Sidebar and review drawers are modal: everything behind them — **including the top bar** — is `inert` and covered by a scrim; F6 stays inside the open drawer; Esc, Ctrl+B / Ctrl+Shift+G or scrim click closes and restores focus. Choosing a session in the sidebar drawer closes it and focuses the session heading.

### Overlays — one at a time
Opening the switcher closes popovers; dialogs block global shortcuts except Esc; the inbox cannot open over the switcher.

## 3. Long transcripts

- The timeline is `role="log"` with **`aria-live="off"`**. Streaming text is never read token by token. Instead, a separate polite live region announces turn-level events: “*Agent* finished responding”, “Background agent finished: …”, “Approval needed in …” (assertive — the only assertive announcement).
- **Auto-follow** only when the user is at the bottom (within 48 px). If scrolled up, the view does not move; a pill “N new below · Jump to latest” appears; activating it scrolls to the end and focuses the log.
- Tool events are collapsed by default (`<details>`), showing tool, argument and a one-line result; outputs are monospace and scroll horizontally inside their card only.
- Production: the timeline must be **virtualised** (windowed rendering) with stable item keys, keep scroll anchoring when items above change height, and bound in-memory retention (older events paged from SQLite). Target: 10,000 events without input lag > 100 ms (to be measured in issue #4+). The prototype uses `content-visibility: auto` on ~410 events as a stand-in.
- Ctrl+Home / Ctrl+End in the focused log jump to start / end; transcript search (Ctrl+F) is a later feature.

## 4. Non-colour cues

| Information | Non-colour cue |
| --- | --- |
| Session status | Distinct glyph shapes + text label / accessible name ([table](states-and-indicators.md#2-session-status-vocabulary)) |
| Needs reply vs only review | Bell with “!” vs plain bell; square badge with “!” prefix vs round outlined badge; count text |
| Background running | Separate spinner ring next to the badge + text in the accessible name |
| Unread | “N new” text pill + semibold title |
| Current session | Left bar + `aria-current` (+ background tint) |
| Task kind | Glyph + text chip in header; grouped headings in inbox |
| Diff additions/removals | “+” / “−” sign column and screen-reader prefixes |
| Usage source | Text tag (“Provider-reported”, “Unknown”…); unknown has dashed outline and no bar |
| High usage | “≥80%” text flag and “high” word |
| Approval / error cards | Uppercase label (“APPROVAL REQUIRED”, “COMPLETED”) + thick left border + glyph |
| Review findings | “Blocking” / “Suggestion” text tags |

## 5. Contrast

Generated by `node docs/ux/tools/check-contrast.mjs` from [`tokens/tokens.css`](tokens/tokens.css) (48 pairs, 0 failing at the time of writing). Text pairs need 4.5:1; UI boundaries (`border-strong`) and the focus ring need 3:1.

| Pair (selection) | Light | Dark |
| --- | --- | --- |
| `text-primary` on `bg-surface` | 17.46 | 14.47 |
| `text-tertiary` on `bg-hover` (worst text case) | 4.53 | 5.40 |
| `text-tertiary` on `bg-sunken` (sidebar meta) | 4.84 | 7.16 |
| `status-attention` on `status-attention-soft` | 5.51 | 7.47 |
| `text-on-accent` on `status-attention` (“!” badge) | 6.45 | 10.13 |
| `diff-add-fg` on `diff-add-bg` | 5.16 | 7.03 |
| `focus-ring` on `bg-selected` | 5.32 | 6.70 |
| `border-strong` on `bg-surface` (3:1) | 3.82 | 3.01 |

Not covered by the script: colours composited over the semi-transparent scrim, syntax highlighting (not designed yet), and the icon knock-outs inside filled glyphs.

## 6. Other requirements

- **Focus indicator**: 2 px solid `--ad-focus-ring`, 2 px offset; inset inside scroll containers so it is never clipped. Visible on every interactive element via `:focus-visible`.
- **Target size**: ≥ 24×24 px for every pointer target (WCAG 2.5.8); icon buttons are 32×32.
- **Reduced motion**: `prefers-reduced-motion: reduce` sets all durations to 0 and stops spinners (static arc glyph keeps the meaning).
- **Forced colours** (Windows High Contrast): selection uses `Highlight` outlines; badges/chips/tags use `CanvasText` borders; glyphs use `currentColor`.
- **Zoom / reflow**: at 200 % zoom on a 1280 px window the layout switches to the narrow breakpoint; no horizontal page scrolling (only inside code/diff blocks).
- **Text size**: UI text size setting scales all `--ad-text-*` tokens together (badge included).
- **Language**: `lang` set on the document; CJK text uses the prose line-height token (1.6). UI copy in English first; strings externalised for zh-TW (later issue).
- **Screen-reader names** for icon-only buttons; decorative SVGs are `aria-hidden`.
- **Timeouts**: toasts with actions stay ≥ 8 s and are also reachable via the session/inbox; nothing important exists only in a toast (archive → **Unarchive** in the session header; “Mark completed as reviewed” → the sessions stay in the sidebar and Ctrl+K). A toast that disappears while focused, or whose action removes it, moves focus to a meaningful target (restored row or session heading), never to the page body.

## 7. Shortcut conflicts in the WebView2 host (hand-off to issue #4)

The prototype runs in a browser, where several of these keys belong to the browser. In the Tauri app on Windows the page runs in WebView2, which by default also handles some browser accelerator keys. Keys at risk:

| Key | Chromium / Edge default | AgentDock use |
| --- | --- | --- |
| Ctrl+J | Downloads | Next item that needs you |
| Ctrl+Shift+J | DevTools console (when DevTools are enabled) | Inbox |
| Ctrl+Shift+G | Find previous | Toggle review panel |
| F6 | Focus address bar / cycle browser panes | Next region |
| Ctrl+K | Search (address bar) | Quick switcher |
| Ctrl+N | New window | New task |
| Ctrl+F, Ctrl+P, F5, Ctrl+R | Find, print, reload | Not used (reload must be blocked in the app) |

Requirements for issue #4:

1. Disable browser accelerator keys for the main window (WebView2 `CoreWebView2Settings.AreBrowserAcceleratorKeysEnabled = false`, through whatever Tauri/wry option exposes it for the pinned version) and disable DevTools in release builds.
2. Register application shortcuts in one place (later remappable in Settings → Keyboard), not ad hoc per component.
3. Add a **shortcut smoke test** in the real WebView2 window: each key in [§1](#1-keyboard-map) performs the AgentDock action and does not trigger the browser default; Esc, Tab, Enter and the IME keys behave as specified; Ctrl+Space and Shift (IME toggles) are left to the OS.
4. If a key cannot be reclaimed reliably, change the AgentDock binding and update §1 rather than shipping a conflict. Tab-to-accept stays (owner requirement); → remains the secondary accept key.
