# P4-4: Approval UI (approval card, sticky banner, no shortcuts, post-restart display)

> **繁中摘要**：前端顯示 P4-3 的 pending approval：`ApprovalCard` 顯示操作類別、**完整指令**（換行不截斷）、範圍與規則、是否只限使用者核准；只有「核准一次」與「拒絕」兩個按鈕；**沒有任何鍵盤快捷鍵**能核准或拒絕，inbox 列也不能核准；卡片捲出畫面時顯示 sticky banner，「顯示」把焦點移到卡片標題而非按鈕；agent 文字一律用文字節點呈現（不用 `dangerouslySetInnerHTML`）。送出時帶 fingerprint，後端回錯誤時顯示訊息並重新載入。重啟後依契約沒有 pending 卡片（與 UX-62 衝突，已列待擁有者決定）。模型等級：一般模型可。

Issues: #8, #9 | Gate (#51): G5 (user confirmation before PR), G7 | Model tier: **standard model is enough**

## 1. Goal and non-goals

Goal: the frontend shows P4-3's pending approvals and lets the user approve or deny them.

- `ApprovalCard`: shows the operation class, the **full command** (wrapped, never truncated), the effect, the scope (`once`) and the rule (policy rule id or "needs your decision"), and whether only the user may approve. The only buttons are "Approve once" and "Deny" (UX-60).
- No keyboard shortcut approves or denies (UX-61); inbox rows cannot approve (F2 Rules). Buttons may be focused with Tab and triggered with Enter/Space (normal button behavior, not a shortcut).
- When the card scrolls off screen, show a sticky banner; "Show" moves focus to the card **heading**, not the approve button (UX-54).
- A new approval is announced with `aria-live="assertive"`; only approvals use assertive (UX-52).
- After a decision, the card collapses to a one-line result: "You denied — the command did not run" / "You approved once" / "Expired — treated as denied" / "Withdrawn because of cancel" / "Invalidated because AgentDock restarted".
- Send `operation_fingerprint` with the decision; on backend `FingerprintMismatch` / `NotPending` / `Expired`, show the matching message and reload the list.

Non-goals: policy rule settings screen (after alpha), bypass-mode indicator (#26, UX F8 / §9), inbox and sentinel integration (P8-2), generic event-stream subscription (P8-2; this packet polls).

## 2. Prerequisites and parallel work

- Prerequisites: P4-3a (`approvals_pending`, `approval_resolve` commands), P1-2 (the `src/ipc/commands.ts` pattern).
- Parallel: P5-*, P6-*.

## 3. Files

New:

- `src/ipc/approvals.ts` (types, type guard, invoke wrappers)
- `src/components/ApprovalCard.tsx`
- `src/components/ApprovalBanner.tsx`
- `src/components/ApprovalCard.test.tsx`
- `src-tauri/tests/fixtures/ipc/approval_view.json` (IPC fixture shared by Rust and TS, same pattern as P1-2)
- `src-tauri/tests/approval_view_fixture.rs`

Modified: `src/i18n/messages.ts` (add the same keys to both `en` and `zh`; `zh` is typed `Record<MessageKey, string>`, so a missing key fails to compile), `src/App.tsx` (real data only when `isTauri()`; demo mode unchanged), `src/styles.css`.

## 4. Public types and signatures

```ts
// src/ipc/approvals.ts
export type PolicyClass =
  | 'read_only' | 'workspace_edit' | 'command' | 'config_write' | 'git_push' | 'pr_write' | 'external_write'
  | 'pr_merge' | 'force_push' | 'branch_delete' | 'worktree_remove' | 'destructive_command' | 'unclassified';

export interface ApprovalView {
  approval_id: string;          // apr_ + 26 Crockford chars
  task_id: string;
  source: 'acp_permission' | 'host_policy';
  classified_kind?: PolicyClass;     // acp_permission only
  operation_kind: string;            // "tool_call" or an OperationKind
  title: string;                     // already redacted by the backend; render as text, never as HTML
  command?: string;                  // full command (redacted) when known
  locations: string[];
  operation_fingerprint: string;     // 64 lowercase hex
  expires_at?: string;               // RFC 3339
  user_only: boolean;
  policy_hint: 'ask_user' | 'policy_denied' | 'policy_approved';
}
export type ResolveError = 'not_found' | 'not_pending' | 'expired' | 'wrong_task' | 'fingerprint_mismatch' | 'rejected';

export function isApprovalView(v: unknown): v is ApprovalView;
export async function approvalsPending(taskId: string): Promise<ApprovalView[]>;
export async function approvalResolve(taskId: string, approvalId: string, decision: 'approve' | 'deny',
  fingerprint: string): Promise<{ ok: true } | { ok: false; error: ResolveError }>;
```

```tsx
// src/components/ApprovalCard.tsx
export interface ApprovalCardProps {
  approval: ApprovalView;
  onResolve: (decision: 'approve' | 'deny') => Promise<void>;
  resolved?: { outcome: 'approved' | 'denied' | 'expired' | 'cancelled' | 'invalidated' };
}
export function ApprovalCard(props: ApprovalCardProps): JSX.Element;

// src/components/ApprovalBanner.tsx
export function ApprovalBanner(props: { count: number; summary: string; onShow: () => void }): JSX.Element;
```

The Rust side (`src-tauri/src/commands/approvals.rs`, created by P4-3a) must return JSON with the same shape as the `approval_view.json` fixture; this packet adds a Rust test that serializes an `ApprovalView` and compares it with the fixture.

## 5. Implementation steps

1. Write the §6 tests.
2. `isApprovalView`: check every field's type and format (`approval_id` prefix, fingerprint 64 lowercase hex, `classified_kind` within the enum). Drop invalid items and `console.warn` (never render bad data).
3. `ApprovalCard`:
   - Heading: localized name of `classified_kind` (e.g. `force_push` → "Force push" / 「強制推送」).
   - Command block: `<pre>` with CSS `white-space: pre-wrap; overflow-wrap: anywhere;` (UX-60: full, wrapped, untruncated). **Use React text nodes, never `dangerouslySetInnerHTML`** (`title` and `command` come from the agent and are untrusted even after redaction; ADR-0002 PRL-8).
   - When `user_only` is true, show "Only you can approve this operation".
   - If `expires_at` is set, show the remaining time (updated every second); after expiry, disable the buttons and show "Expired".
   - Buttons: `<button type="button">`; while submitting, both are `disabled` to prevent double clicks.
   - **Do not** register any `keydown` handler (card, global or any component) that triggers a decision, and do not give buttons `accessKey`.
4. `ApprovalBanner`: besides `role="status"`, a visually hidden `aria-live="assertive"` region that is written only when a new approval appears ("Approval needed: <task name>"). "Show" calls `onShow`; App scrolls to the card and calls `focus()` on its heading element (`tabIndex={-1}`).
5. `App.tsx`: when `isTauri()` is true, poll `approvalsPending` for the selected task every 1 s (P8-2 replaces this with event subscription); diff against the previous result; new ids trigger the assertive announcement. Demo mode calls no IPC.
6. Error messages: `fingerprint_mismatch` → "Content changed; reloaded"; `not_pending` → "This approval was already handled or is no longer valid"; `expired` → "Expired; treated as denied".
7. Post-restart display follows the **contract**: recovery sets pending approvals to `invalidated`, so after restart there are no pending cards; the timeline shows "Invalidated because AgentDock restarted; the agent must ask again". This differs from UX-62 and F2 Rules ("after restart a pending approval is restored as pending"); it is listed in the README for owner decision. **This packet follows the contract.**

## 6. Tests to write first

`src/components/ApprovalCard.test.tsx` (vitest + jsdom, same `createRoot` + `act` style as `App.accessibility.test.tsx`; inject `approvalResolve` with `vi.fn()`, no real IPC):

| Test | Expected |
| --- | --- |
| `shows_full_command_without_truncation` | a 1,000-character command appears fully in DOM text (`textContent` equal) |
| `renders_agent_text_as_text_not_html` | `title = "<img src=x onerror=alert(1)>"` → no `img` element in the DOM; the text appears verbatim |
| `no_keyboard_shortcut_resolves` | dispatch `keydown` for `y`, `n`, `Enter`, `a`, `Ctrl+Enter` on `document` and on the card (focus not on a button) → `onResolve` not called |
| `button_click_resolves_once` | double click "Approve once" → `onResolve` called exactly once |
| `user_only_notice_shown` | `user_only: true` → "Only you can approve" shown |
| `expired_disables_buttons` | `expires_at` in the past → both buttons `disabled` |
| `banner_show_focuses_card_heading_not_button` | click "Show" → `document.activeElement` is the card heading, not a button |
| `assertive_announcement_only_for_new_approval` | second poll with the same result → assertive region unchanged; one new item → updated |
| `invalid_ipc_item_is_dropped` | `isApprovalView` returns false for an object missing `operation_fingerprint` |
| `resolved_line_texts` | each of the five `resolved.outcome` values shows the right text (once in `en`, once in `zh`) |
| `ipc_fixture_matches_type_guard` | reading `src-tauri/tests/fixtures/ipc/approval_view.json` → `isApprovalView` is true |

Rust: `src-tauri/tests/approval_view_fixture.rs` → an `ApprovalView` built in Rust serializes to exactly the fixture.

## 7. Acceptance commands and expected results

```bash
npm run typecheck                                    # passes
npm test                                             # 11 new tests pass; existing tests still pass
npm run build                                        # passes
cargo test -p agentdock-desktop --test approval_view_fixture   # 1 pass
```

`agentdock-desktop` needs the Tauri Linux system libraries; see CONVENTIONS.md §1 "Linux VM prerequisites" (**ask the owner before installing system packages**).

Windows-only: none. Manual check on the owner's machine (optional): with a screen reader, a new approval is announced once.

## 8. Spec references and porting sources

- `docs/ux/acceptance-criteria.md` line 78 (UX-52), line 80 (UX-54), lines 91–93 (UX-60, UX-61, UX-62).
- `docs/ux/flows.md` lines 27–33 (F2), lines 75–83 (F8: AgentDock's own push/PR/merge/worktree remove still need approval).
- `docs/ux/states-and-indicators.md` §9 from line 158 (policy indicators; not implemented here, but use the same vocabulary for the card's "rule" field).
- `docs/contracts/checkpoint-and-replay.md` Crash recovery step 3 (pending → invalidated; conflicts with UX-62; contract wins).
- ADR-0002 line 157 PRL-8 (untrusted text is shown quoted, single-line or plain, and cannot forge an approval card).
- Behavior reference (scenario only, do not copy code): PR #27, branch per PR, SHA `6dd3ac8`, test scenario "hiding a notification is not approval" (Issue #8 comment).

## 9. Dependencies

No new npm packages (React, vitest, jsdom exist). `@tauri-apps/api` is introduced by P1-2.

## 10. Model tier

Standard model is enough.

## 11. Common mistakes and pitfalls

- Adding "press Y to approve" for convenience: violates UX-61 and lets prompt injection trick the user.
- Truncating the command to 80 characters: the dangerous part is often at the end (`ls; rm -rf ~`).
- Using `dangerouslySetInnerHTML` for agent text (e.g. to keep line breaks): CSS `pre-wrap` is enough.
- Deciding "this can be auto-approved" in the frontend: all decisions are in the backend; the frontend only shows `policy_hint`.
- Adding approve buttons to inbox rows: F2 Rules forbid it.
- Adding message keys only to `en`: `zh` is `Record<MessageKey, string>`, so `npm run typecheck` fails; add both.
- Calling IPC in demo mode: there is no Tauri in the browser and it throws; guard with `isTauri()`.

## 12. Reviewer checklist

- [ ] Is there any `keydown` / `accessKey` path that resolves an approval?
- [ ] Is agent text rendered only as text nodes, with the full command visible?
- [ ] Is a double click guarded, and is the fingerprint sent with every decision?
- [ ] Does "Show" focus the heading, not a button?
- [ ] Are `en` and `zh` keys complete, and does demo mode avoid IPC?
- [ ] Does the Rust fixture test actually compare against the same JSON file the TS test reads?
