# P6-2: Checks tab (only checks AgentDock ran, PASS/FAIL/BLOCKED, log viewer)

> **繁中摘要**：Inspector 的「Checks」分頁在 `isTauri()` 時改用真實資料（demo 模式不變）。每列用圖示＋**文字**顯示狀態（不靠顏色）、名稱、argv 指令、exit code、耗時；`errored`／`cancelled`／`outcome_unknown` 一律顯示 BLOCKED 加原因。可展開 redaction 後的 log（最後 256 KiB，純文字）；只有 task 在 `verifying` 時能按「重新執行」。Tauri 端 `check_log` 要確認 check 屬於該 task、artifact 路徑在 artifacts 根目錄內；**刻意沒有**任何接受 check 結果的 command。agent 在對話中說的測試結果不顯示。模型等級：一般模型可。

Issues: #10, #2 (UX) | Gate (#51): G6 (show stdout/stderr, exit code, PASS/FAIL/BLOCKED) | Model tier: **standard model is enough**

## 1. Goal and non-goals

Goals:

- Replace the Inspector "Checks" tab in `src/App.tsx` with real data when `isTauri()`; demo mode keeps the current simulated content and its "simulated results" notice.
- Each row shows: status icon + **text** (UX-80: not color alone), check name, command (argv, display only), exit code, duration.
- Status text mapping (#51 terms):

  | Contract `state` | Display (en / zh) |
  | --- | --- |
  | `running` | Running / 執行中 |
  | `passed` | PASS / 通過 |
  | `failed` | FAIL / 失敗 |
  | `errored` | BLOCKED — could not run / BLOCKED — 無法執行 |
  | `cancelled` | BLOCKED — cancelled / BLOCKED — 已取消 |
  | `outcome_unknown` | BLOCKED — result unknown after restart / BLOCKED — 重新啟動後結果不明 |

- "View log" expands the redacted log (the artifact stored by P6-1b, last 256 KiB) as plain text in `<pre>`.
- "Run checks again" button: enabled only when the task is `verifying`; otherwise disabled with the reason shown.
- "Cancel" button: shown only while a check is `running`.
- Tab title shows failures: "Checks (1 failed)" (wireframes line 25).

Non-goals: CI check display (P8-4 adds `origin: ci` rows; this component must display the `origin` field but does not fetch CI data), check settings screen, "tests passed" inferred from agent messages (UX-67: **never shown**), event subscription (P8-2; this packet polls every second).

## 2. Prerequisites and parallel work

- Prerequisites: P6-1b (`CheckService`), P1-2 (IPC pattern, `isTauri()`), P2-5 (`checks_of` projection query), P3-7 (`AppState`: the Tauri side holds the store and services).
- Parallel: P7-1, P4-4 (all touch `App.tsx` and `messages.ts`; whoever merges later resolves adjacent-line conflicts only).

## 3. Files

New:

- `src-tauri/src/commands/checks.rs` (four commands)
- `src-tauri/tests/check_view_fixture.rs`
- `src-tauri/tests/fixtures/ipc/check_view.json`
- `src/ipc/checks.ts`
- `src/components/ChecksPanel.tsx`
- `src/components/ChecksPanel.test.tsx`

Modified: `src-tauri/src/commands/mod.rs` (register), `src-tauri/src/lib.rs` (`invoke_handler`), `src-tauri/build.rs` (add four commands to the AppManifest, as in P4-3a), `src-tauri/capabilities/default.json`, `src/App.tsx` (Inspector checks tab), `src/i18n/messages.ts` (both `en` and `zh`), `src/styles.css`.

## 4. Public types and signatures

```rust
// src-tauri/src/commands/checks.rs
#[derive(serde::Serialize)]
pub struct CheckView {
    pub check_id: String,
    pub name: String,
    pub origin: String,              // "local" | "ci"
    pub state: String,               // CheckState snake_case, includes "running"
    pub command: Vec<String>,        // already redacted (from check.started)
    #[serde(skip_serializing_if = "Option::is_none")] pub exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub duration_ms: Option<u64>,
    pub started_at: String,          // RFC 3339
    pub has_log: bool,
}

#[tauri::command] pub async fn checks_list(state: tauri::State<'_, AppState>, task_id: String)
    -> Result<Vec<CheckView>, IpcError>;                      // newest first, max 50
#[tauri::command] pub async fn checks_run(state: tauri::State<'_, AppState>, task_id: String)
    -> Result<(), IpcError>;                                  // spawns CheckService::run_all in background
#[tauri::command] pub async fn checks_cancel(state: tauri::State<'_, AppState>, task_id: String)
    -> Result<(), IpcError>;
#[tauri::command] pub async fn check_log(state: tauri::State<'_, AppState>, task_id: String, check_id: String)
    -> Result<CheckLog, IpcError>;

#[derive(serde::Serialize)]
pub struct CheckLog { pub text: String, pub truncated: bool }   // last 256 KiB, lossy UTF-8
```

There is **deliberately no** command that accepts a check result (state / exit_code). `IpcError` is P3-7's `{ code, message }` struct; each command first calls `AppState::ready()`.

```ts
// src/ipc/checks.ts
export type CheckState = 'running' | 'passed' | 'failed' | 'errored' | 'cancelled' | 'outcome_unknown';
export type CheckBadge = 'running' | 'pass' | 'fail' | 'blocked';
export interface CheckView {
  check_id: string; name: string; origin: 'local' | 'ci'; state: CheckState;
  command: string[]; exit_code?: number; duration_ms?: number; started_at: string; has_log: boolean;
}
export function isCheckView(v: unknown): v is CheckView;
export function badgeOf(state: CheckState): CheckBadge;
/** For display only: joins argv, quoting elements that contain spaces or quotes. Never executed. */
export function displayCommand(argv: string[]): string;
export async function checksList(taskId: string): Promise<CheckView[]>;
export async function checksRun(taskId: string): Promise<void>;
export async function checksCancel(taskId: string): Promise<void>;
export async function checkLog(taskId: string, checkId: string): Promise<{ text: string; truncated: boolean }>;
```

```tsx
// src/components/ChecksPanel.tsx
export interface ChecksPanelProps {
  checks: CheckView[];
  taskState: string;                         // TaskState snake_case
  onRun: () => Promise<void>;
  onCancel: () => Promise<void>;
  loadLog: (checkId: string) => Promise<{ text: string; truncated: boolean }>;
}
export function ChecksPanel(props: ChecksPanelProps): JSX.Element;
export function failedCount(checks: CheckView[]): number;   // state === 'failed' only
```

## 5. Implementation steps

1. Write the §6 tests.
2. Rust `checks_list`: read `checks_of(task)` from the projection, take `command` from the `check.started` event (or from the projection if P2-5 stores it); `has_log` = the finished event has an `artifact`.
3. `check_log`: confirm `check_id` belongs to `task_id` (else `IpcError { code: "not_found", .. }`, never leaking another task's log); read via `ArtifactRef.path` from `ArtifactStore`; **the path must be inside the artifacts root** (check with P4-1 `WorkspaceScope::new(&[artifacts_root])` so a tampered path cannot read arbitrary files); read only the last 256 KiB.
4. `checks_run`: call `CheckService::run_all(task, true, token)`, storing the token in `AppState`'s `HashMap<TaskId, CancellationToken>`; `WrongState` → `IpcError { code: "conflict", message: "task is not verifying" }`. `checks_cancel` takes the token and calls `cancel()`.
5. `ChecksPanel`:
   - Icon + text per `badgeOf` (existing lucide icons: pass `CircleCheck`, fail `CircleX`, blocked `CircleSlash`, running `LoaderCircle`); the text is always visible, not only in `aria-label`.
   - Command: `<code>` with a text node of `displayCommand(command)`, untruncated, CSS `overflow-wrap: anywhere`.
   - Log expand: button with `aria-expanded`; content in `<pre>` as a text node; when `truncated`, first show "Showing only the last 256 KiB".
   - No checks: "AgentDock has not run any checks yet. Test results the agent mentions in chat are not listed here."
   - When `taskState !== 'verifying'`, "Run again" is disabled with "Checks run after the agent finishes" next to it.
6. `App.tsx`: when `isTauri()`, poll `checksList` every second (only while the Inspector is open on the checks tab); tab title uses `failedCount`. Demo mode unchanged.

## 6. Tests to write first

`src/components/ChecksPanel.test.tsx` (vitest + jsdom; IPC functions injected as `vi.fn()` props):

| Test | Expected |
| --- | --- |
| `badge_mapping_covers_all_states` | all six states map through `badgeOf` to the table values |
| `status_text_visible_without_color` | each badge's text appears in `textContent` (not only `aria-label`) |
| `errored_cancelled_unknown_show_blocked_with_reason` | all three show `BLOCKED` with their own reason text |
| `empty_state_says_agent_claims_not_listed` | `checks=[]` → "Test results the agent mentions in chat are not listed here" |
| `command_rendered_as_text` | `command = ["<img src=x onerror=alert(1)>"]` → no `img` in the DOM |
| `display_command_quotes_spaces` | `displayCommand(["/opt/node bin/node","a b",'x"y'])` → `"/opt/node bin/node" "a b" "x\"y"` |
| `run_disabled_unless_verifying` | `taskState: 'running'` → button `disabled`; `'verifying'` → enabled, click calls `onRun` once |
| `cancel_only_when_running` | "Cancel" appears only when a `running` row exists |
| `log_loads_on_expand_and_marks_truncated` | click "View log" → `loadLog` called once; `truncated: true` shows the notice |
| `failed_count_only_counts_failed` | `[failed, errored, passed, failed]` → 2 |
| `ipc_module_exposes_no_result_writer` | sorted `Object.keys(await import('../ipc/checks'))` equals `['badgeOf','checkLog','checksCancel','checksList','checksRun','displayCommand','isCheckView']` |
| `ipc_fixture_matches_type_guard` | reading `src-tauri/tests/fixtures/ipc/check_view.json` → `isCheckView` true |
| `zh_and_en_strings_present` | after switching language, all 12 table strings appear (missing `zh` keys already fail typecheck; this verifies actual rendering) |

Rust (`src-tauri/tests/check_view_fixture.rs`):

- `check_view_matches_fixture`: a Rust-built `CheckView` serializes to the fixture; with `exit_code: None` the key is absent (not `null`).
- `check_log_rejects_other_task`: temp store with two tasks, one check each; reading task B's `check_id` with task A's id → `code == "not_found"`.
- `check_log_rejects_path_outside_artifacts`: artifact path in the projection changed to `../../secret.txt` → error, no file read.

## 7. Acceptance commands and expected results

```bash
npm run typecheck      # passes
npm test               # 13 new tests pass; existing tests still pass
npm run build          # passes
cargo test -p agentdock-desktop --test check_view_fixture   # 3 pass
```

`agentdock-desktop` needs the Tauri Linux system libraries; see CONVENTIONS.md §1 "Linux VM prerequisites" (**ask the owner before installing system packages**).

Manual (owner's machine, optional; `npm run tauri dev`; before P8-3 exists, use a test command to push a task to verifying): configure a check that exits 1 → FAIL, exit code 1, log expands.

## 8. Spec references and porting sources

All line numbers refer to main `c9e33cf`.

- `docs/ux/acceptance-criteria.md` line 95 UX-64 (checks shown with text states), line 98 UX-67, line 118 UX-80.
- `docs/ux/information-architecture.md` line 14 (a Check is evidence of a command the workbench ran; agent text is not evidence), line 78 (Checks tab).
- `docs/ux/design-system.md` line 119 (Check row: passed / failed / not run, text states).
- `docs/ux/wireframes.md` line 25 (tab title "Checks (n failed)").
- Issue #51 gate 6 (PASS/FAIL/BLOCKED terms).
- `docs/contracts/schema/agentdock.schema.json` lines 412–416, 631–650.
- No porting source.

## 9. Dependencies

No new packages. Icons reuse the existing `lucide-react`.

## 10. Model tier

Standard model is enough.

## 11. Common mistakes and pitfalls

- Turning "All tests passed" in an agent message into a check row: violates UX-67 and is #51's explicitly forbidden "agent self-reported PASS".
- Color alone (green/red): UX-80 requires icon shape + text.
- Showing `errored` as FAIL: the user would think the code is broken; it means "did not run".
- `check_log` doing `fs::read(artifacts_root.join(path))` directly: a tampered projection could read any file; scope-check first.
- Calling `checksList` in demo mode: no Tauri in the browser; it throws.
- Polling every second outside the checks tab: wasteful; poll only while visible.
- Do not break the Inspector tabs' existing keyboard behavior (arrow keys, Home/End): that is APG tabs behavior, not an approval shortcut.

## 12. Reviewer checklist

- [ ] Is there any Tauri command or exported TS function that writes a check result?
- [ ] Does `check_log` verify task ownership and artifact path scope before reading?
- [ ] Are all three BLOCKED states visibly distinct from FAIL, with text not only color?
- [ ] Is agent text (command, log) rendered only as text nodes?
- [ ] Does demo mode avoid IPC, and is polling limited to the visible tab?
