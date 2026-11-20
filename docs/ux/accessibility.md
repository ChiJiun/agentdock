# Keyboard, focus and accessibility specification

Status: Draft for issue #2. Target: **WCAG 2.2 AA** on Windows (Narrator, NVDA) first; patterns follow the WAI-ARIA Authoring Practices (tree, combobox/listbox, tabs, dialog, disclosure).

## 1. Keyboard map

| Action | Shortcut | Notes |
| --- | --- | --- |
| Quick switcher (switch session / search) | **Ctrl+K** | Pressing again closes it and restores focus. Replaces an open popover; opens **above** a modal drawer (the one exception in [§2](#overlays--one-at-a-time)); not opened while the shortcuts dialog is open. |
| Inbox | **Ctrl+Shift+J** | Toggles; focus goes to the first row (never to a header action such as “Mark completed as reviewed”); with no rows, to the popover. Closes an open modal drawer first. |
| Next item that needs you | **Ctrl+J** | First “Needs reply” (excluding the one on screen), else first “New result”. Announces “Nothing needs you right now” otherwise. Closes any open popover or modal drawer before navigating. |
| Pinned session 1–9 | **Alt+1 … Alt+9** | Focus lands in the composer. Closes any open popover or modal drawer first. |
| Next / previous region | **F6 / Shift+F6** | Top bar → sidebar → conversation → composer → review panel (skips hidden regions). |
| Toggle sidebar | **Ctrl+B** | Drawer below 960 px. Closes an open review drawer first. |
| Toggle review panel | **Ctrl+Shift+G** | Drawer below 1280 px. Closes an open sidebar drawer first. |
| New task | **Ctrl+N** (app) / Alt+N (prototype; browsers reserve Ctrl+N) | Opens Home with the repository cards. |
| Keyboard shortcuts | **Ctrl+/** | Dialog listing everything here. |
| Close topmost overlay | **Esc** | One layer per press, in the order dialog → popover → drawer (sidebar or review; never both). Esc never cancels an agent. |
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
- Does not open while another modal dialog is open; other modal shortcuts do nothing while it is open. It may open above a modal drawer: Esc then closes only the switcher and focus returns into the drawer; picking a session closes the drawer (see [Overlays](#overlays--one-at-a-time)).

### Inbox and usage popovers (non-modal `dialog`)
- Open: focus the first row (inbox) — never a section action such as “Mark completed as reviewed”, which comes after the rows — or the popover itself (usage, or an inbox with no rows). ↑/↓/Home/End move between inbox rows; Tab cycles inside (and stays on the popover when it has no controls); Esc closes and returns focus to the trigger button; clicking outside closes without stealing focus.
- `aria-expanded` on the trigger reflects state.

### Review panel
- Tabs follow APG (←/→ switch, one Tab stop). File list items expose “*path*, modified, 12 additions, 3 deletions”. The diff region is focusable for keyboard scrolling; each line carries “+”/“−” text and a visually hidden “added:”/“removed:” prefix.
- Opening moves focus to the panel heading; closing returns focus to the control that opened it (or the header “Changes” button).

### Drawers (narrow layouts)
- Sidebar and review drawers are modal: everything behind them — **including the top bar** — is `inert` and covered by a scrim (the scrim covers the top bar too); F6 stays inside the open drawer; Esc, Ctrl+B / Ctrl+Shift+G or a click anywhere on the scrim closes and restores focus. Choosing a session in the sidebar drawer closes it and focuses the session heading.
- The two drawers are **never open together**, and a drawer is never open together with a popover (next section). Because the top bar is inert under a drawer, shortcuts are the only way to reach the inbox, the other drawer or another session from inside one — so those shortcuts must work, not be swallowed.

### Overlays — one at a time

Three classes: **modal dialogs** (quick switcher, shortcuts dialog; later the quit confirmation), **popovers** (inbox, usage) and **modal drawers** (sidebar drawer below 960 px, review drawer below 1280 px). At most one popover *or* drawer is open, with at most one dialog above it. A docked panel (review at ≥ 1280 px, sidebar at ≥ 960 px) is not an overlay.

1. **Replace, do not stack.** Opening a popover or a drawer first closes whatever popover or drawer is open, without restoring its focus, then opens the new one. This covers Ctrl+Shift+J, the Usage button, Ctrl+B and Ctrl+Shift+G. (Ignoring the shortcut was the alternative; it would leave the inbox unreachable from a drawer exactly when an approval is announced.)
2. **Navigation closes overlays.** Ctrl+J, Alt+1…9, Ctrl+N, choosing a row and picking a switcher result close any popover or modal drawer, then move focus to the destination (session heading or composer).
3. **Exception — a dialog may open above a modal drawer.** Ctrl+K and Ctrl+/ open above it, because cancelling a search must not cost the user their place in a diff. Closing the dialog returns focus into the drawer; picking a session closes the drawer (rule 2). A dialog *replaces* an open popover: the popover closes first and its trigger becomes the dialog’s return target.
4. **Dialogs block.** While a dialog is open, only its own keys and Esc work (Ctrl+K again closes the switcher). Nothing opens above the switcher; the switcher does not open above the shortcuts dialog.
5. **Esc closes exactly one layer per press**: dialog → popover → drawer. Esc in the switcher must not also close the drawer underneath.
6. **Never**: two drawers open, a drawer plus a popover, or any state in which every region is inert.

| Pressed while → | Nothing open | Popover open | Sidebar drawer open | Review drawer open | Dialog open |
| --- | --- | --- | --- | --- | --- |
| Ctrl+K | opens switcher | closes popover, opens | opens above | opens above | closes the switcher / ignored in the shortcuts dialog |
| Ctrl+/ | opens dialog | closes popover, opens | opens above | opens above | ignored |
| Ctrl+Shift+J | opens inbox | closes it (inbox) or replaces it (usage) | closes drawer, opens inbox | closes drawer, opens inbox | ignored |
| Ctrl+B | toggles sidebar | closes popover, toggles | closes the drawer | closes drawer, then toggles the sidebar | ignored |
| Ctrl+Shift+G (session view only; does nothing on Home, Project and Settings, where there is no review panel) | toggles review | closes popover, opens | closes drawer, opens review | closes the drawer | ignored |
| Ctrl+J, Alt+1…9, Ctrl+N | navigates | closes popover, navigates | closes drawer, navigates | closes drawer, navigates | ignored |
| F6 | cycles regions | closes popover, cycles | stays in the drawer | stays in the drawer | ignored |
| Esc | — | closes popover | closes drawer | closes drawer | closes dialog |

### Focus return

- Every overlay remembers a return target when it opens: a popover its trigger button, a drawer or dialog the element that had focus.
- A **drawer** that replaces a popover or the other drawer inherits the replaced overlay’s return target. The element that was focused *inside* the replaced overlay is not a valid target: it is hidden as soon as that overlay closes. A popover that replaces something still returns to its own trigger button (previous point).
- On close, if the return target cannot take focus — removed from the page, hidden, inside an `inert` region, or inside a closed drawer — focus goes to the **fallback**: into the modal drawer that is still open (current tree row, or the review heading), otherwise to the session heading (the view’s `h1` on Home, Project and Settings). Focus restore never ends on `body`.
- The same fallback applies when focus would be stranded by a layout change: collapsing the docked sidebar while focus is inside it; widening past 960 px while the sidebar drawer is open (the drawer closes; focus stays in the tree if the sidebar is docked open, otherwise it goes to the fallback); or narrowing below 1280 px so that an open review panel becomes a modal drawer (an open popover is closed first — rule 6 — then focus moves into the drawer).

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
| Policy not enforced (agent bypass / full-access mode) | Shield-with-slash glyph + the words “Policy not enforced” + dashed outline; in the accessible name of sidebar rows ([states §9](states-and-indicators.md#9-policy-enforcement-indicator-agent-bypass--full-access-modes)) |

## 5. Contrast

Generated by `node docs/ux/tools/check-contrast.mjs` from [`tokens/tokens.css`](tokens/tokens.css) (49 pairs, 0 failing at the time of writing). Text pairs need 4.5:1; UI boundaries (`border-strong`) and the focus ring need 3:1.

| Pair (selection) | Light | Dark |
| --- | --- | --- |
| `text-primary` on `bg-surface` | 17.46 | 14.47 |
| `text-tertiary` on `bg-hover` (worst text case) | 4.53 | 5.40 |
| `text-tertiary` on `bg-sunken` (sidebar meta) | 4.84 | 7.16 |
| `status-attention` on `status-attention-soft` | 5.51 | 7.47 |
| `text-on-accent` on `status-attention` (“!” badge) | 6.45 | 10.13 |
| `text-primary` on `status-danger-soft` (“policy not enforced” note) | 14.28 | 12.82 |
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
- **Timeouts**: toasts with actions stay ≥ 8 s. A toast that disappears while focused, or whose action removes it, moves focus to a meaningful target (restored row or session heading), never to the page body.
  - **Known limit — a toast’s Undo is hard to reach from the keyboard in time.** The toast is the last Tab stop of the document; no shortcut or F6 region leads to it, and its announcement does not say how to get there. Measured in the prototype with real key presses (1400 px, short session `s1`):
    - *Archive toast.* It appears after the user navigates away. When that navigation puts focus in the composer (Alt+1…9, a switcher pick), Undo is **4 Tab presses** away and Enter restores the sub-task — reachable. When focus lands on the session heading instead (Ctrl+J, choosing a row), it is 13 Tab presses in `s1` (counted from the DOM order, not pressed), plus one for every tool event in the transcript — hundreds in a long one.
    - *“Marked as reviewed” toast.* Focus stays inside the inbox popover, whose Tab order wraps, so Undo cannot be reached without leaving it: Esc, then **19 Tab presses** — or Esc, F6 three times (to the composer), then 4 Tab presses. Both routes finished inside 8 s when the keys were sent by a script. A person who has not memorised the route, or who uses a screen reader or switch input, should not be expected to manage it.
  - What that means per action: **archive** has a full keyboard equivalent — **Unarchive** in the archived session’s header (reach it through “Show N archived sub-tasks” or Ctrl+K), which also sets the restored flag. **“Mark completed as reviewed” has no keyboard equivalent for the marker itself**: the sessions stay in the sidebar and in Ctrl+K and can still be opened, but only Undo puts them back under “to review”. For keyboard users the bulk action is therefore not reliably reversible in the prototype.
  - Requirement for the app (issue #4 onward, not in the prototype): while a toast with an action is visible it is an **F6 region**, its timer **pauses while it contains focus or the pointer**, and its announcement names the way to reach it (“Marked as reviewed: 3. Press F6 for Undo”). Acceptance: [UX-48](acceptance-criteria.md). Until that ships, do not add further toast-only Undo actions.

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
| F12, Ctrl+Shift+I, Ctrl+Shift+C | DevTools | Not used. Must do nothing in release builds |
| Alt+← / Alt+→ (and mouse/keyboard Back, Forward keys) | History back / forward | Not used. The app is a single page: a history step would unload the UI. Alt+1…9 are AgentDock’s; Alt+arrow must stay free for text editing |
| Ctrl+G, F3, Shift+F3 | Find next / previous | Not used (transcript search, later, is Ctrl+F inside the log) |
| F7 | Caret browsing prompt | Not used. The prompt must not appear |
| Ctrl+S | Save page | Not used. Must do nothing (no “Save as” dialog for the app shell) |
| Ctrl+U | View source | Not used. Must do nothing |
| Ctrl+Plus, Ctrl+Minus, Ctrl+0, Ctrl+mouse wheel | Page zoom | Not used directly: text size is the UI text-size setting ([§6](#6-other-requirements)). Either disable host zoom or route these keys to that setting — decide in issue #4, do not ship both |

What the host settings are documented to cover (checked 2026-11-17):

- **WebView2 `AreBrowserAcceleratorKeysEnabled = false`** — Microsoft’s reference for `CoreWebView2Settings.AreBrowserAcceleratorKeysEnabled` says it disables “all accelerator keys that access features specific to a web browser, including but not limited to” Ctrl+F and F3 (find), Ctrl+P (print), Ctrl+R and F5 (reload), Ctrl+Plus and Ctrl+Minus (zoom), Ctrl+Shift+C and F12 (DevTools) and the special Back / Forward / Search keys; it leaves movement and editing keys (Home, End, Page Up/Down, Ctrl+X/C/V, Ctrl+A, Ctrl+Z) enabled; default `true`. **Not named in that list, so not confirmed by documentation**: Ctrl+Shift+I, Alt+← / Alt+→, Ctrl+G, F7, Ctrl+S, Ctrl+U, Ctrl+0, and the AgentDock keys Ctrl+J, Ctrl+Shift+J, Ctrl+Shift+G, F6, Ctrl+K, Ctrl+N. The smoke test below is the only evidence for those.
- **wry** — `WebViewBuilderExtWindows::with_browser_accelerator_keys(enabled: bool)`, default `true`, sets WebView2 `AreBrowserAcceleratorKeysEnabled`; ignored on WebView2 Runtime older than 92.0.902.0 (wry API reference, `dev` branch).
- **Tauri 2** — `WebviewWindowBuilder::zoom_hotkeys_enabled(bool)` (docs.rs `tauri`: “Windows: Controls WebView2’s `IsZoomControlEnabled` setting”; the Tauri 2.0 release notes also list a `zoomHotkeys` window option, whose exact `tauri.conf.json` key was not checked), and `WebviewWindowBuilder::devtools(bool)` / the `app > windows > devtools` config option (Tauri 2.1.0 changelog).
- **Not found:** a Tauri-level builder method or `tauri.conf.json` key for browser accelerator keys. It does not appear in the docs.rs `tauri` `WebviewBuilder` / `WebviewWindowBuilder` pages that were searched (through a documentation index, which can lag behind the latest release). If the Tauri version pinned in issue #4 does not expose it, the setting has to be applied to the WebView2 settings object through `WebviewWindow::with_webview` (platform handle) — an approach that still needs to be written and verified there. Whether zoom is fully covered by `zoom_hotkeys_enabled(false)` alone, or also needs the accelerator-key setting, is likewise unverified.

Requirements for issue #4:

1. Disable browser accelerator keys for the main window (WebView2 `AreBrowserAcceleratorKeysEnabled = false`; wry: `with_browser_accelerator_keys(false)`; Tauri: see the list above for what is and is not confirmed for the pinned version), set `zoom_hotkeys_enabled` according to the zoom decision, and disable DevTools in release builds.
2. Register application shortcuts in one place (later remappable in Settings → Keyboard), not ad hoc per component.
3. Add a **shortcut smoke test** in the real WebView2 window: each key in [§1](#1-keyboard-map) performs the AgentDock action and does not trigger the browser default; **every “Not used” key in the table above does nothing visible** (no DevTools, no navigation, no find bar, no caret-browsing prompt, no save dialog, no source view, no unexpected zoom); Esc, Tab, Enter and the IME keys behave as specified; Ctrl+Space and Shift (IME toggles) are left to the OS.
4. If a key cannot be reclaimed reliably, change the AgentDock binding and update §1 rather than shipping a conflict. Tab-to-accept stays (owner requirement); → remains the secondary accept key.
