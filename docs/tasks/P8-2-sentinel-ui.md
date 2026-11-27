# P8-2: Session Sentinel UI (inbox from real attention items, badge, "opened" acknowledgement, store change events)

> **繁中摘要**：在 Tauri 模式下，把頂列的通知鈴與 `MonitorInbox` 改成讀 P8-1 的真實 attention 資料：三個區段固定順序、徽章只算「需要回覆＋待檢視」、需要回覆時顯示「!」。結果畫面在視窗有焦點且內容已顯示時，寫入 `opened` 確認事件（使用者 actor），這是清除「待檢視」的唯一方式（MVP 沒有單列「標為已檢視」，也不做批次）。後端把 store 的變更以 Tauri 事件推給前端，取代 P4-4／P6-2／P7-1 的輪詢。demo 模式保持不變。模型等級：一般模型可。

Issues: #7, #36, #2 (UX) | Gate (#51): G3 (real state after restart), G8 | Model tier: **standard model**

## 1. Goal and non-goals

Goals:

- **Store change events**: a backend task subscribes to `Store::subscribe()` (P2-4) and emits the Tauri event `store-changed { head_seq }`, coalesced to at most one per 100 ms. On `StreamItem::Lagged` it emits the event too (the frontend always refetches, so lag is harmless).
- **`useStoreChanges()`** hook: subscribes once, exposes `headSeq`; components refetch when it changes. Replace the 1 s polling added by P4-4 (approvals), P6-2 (checks) and P7-1 (changes) with this hook, keeping a 10 s fallback poll in case an event is missed.
- **Inbox (Tauri mode)**: `MonitorInbox` shows `attention_list` items in three fixed sections — "Needs your reply", "New results to review", "Running in background" — each with heading, glyph and count (UX §4). The session currently on screen is not listed unless the item is `needs_reply` (UX rules 1 and 3; applied in the UI only).
- **Badge**: count = needs_reply + needs_review; `!` prefix and filled square badge when needs_reply ≥ 1; outlined pill otherwise; hidden when 0; `99+` above 99; background shows a small ring, never counted. Accessible name per the UX badge table.
- **No dismiss in Tauri mode**: the existing local "dismiss" (`canDismiss`) stays for demo mode only. In Tauri mode review items clear only by opening the result; reply items clear when the condition stops holding.
- **"Opened" acknowledgement**: when a task or child session is in a terminal state, its result is rendered, and the window has focus, call `acknowledge_opened`. The backend writes `task.outcome_acknowledged{acknowledged_state, method: opened}` or `session.result_acknowledged{method: opened}` (actor `user`) only if the entity is still in that terminal state and was not already acknowledged since entering it.

Non-goals: bulk "Mark completed as reviewed" (blocked by attention.md Divergence 3), single-row "mark reviewed" (no UI in the MVP, UX §4), OS notifications, the policy-not-enforced indicator (#26, listed as not covered), remote sessions (UX rule 1a), auto-archive of child sessions.

## 2. Prerequisites and parallel work

- Prerequisites: P8-1b (`attention_list`), P3-7 (`AppState`), P1-2 (`isTauri()`), P4-4, P6-2, P7-1 (polling to replace; if one of them is not merged yet, skip its replacement and say so in the PR).
- Parallel: P8-3, P8-4 (backend only).

## 3. Files

New:

- `src-tauri/src/events.rs` (store subscription → `store-changed`)
- `src-tauri/src/commands/acknowledge.rs` (`acknowledge_opened`)
- `src-tauri/tests/acknowledge.rs`
- `src/ipc/attention.ts`
- `src/hooks/useStoreChanges.ts`
- `src/components/InboxBadge.tsx`
- `src/components/InboxBadge.test.tsx`
- `src/components/MonitorInbox.attention.test.tsx`
- `src-tauri/tests/fixtures/ipc/attention_view.json`

Modified: `src/components/MonitorInbox.tsx` (accept either demo `MonitorItem[]` or real `AttentionView`), `src/App.tsx`, `src/components/ApprovalCard.tsx` usage site, `src/components/ChecksPanel.tsx` usage site, `src/components/ChangesPanel.tsx` usage site (polling → hook), `src/i18n/messages.ts`, `src/styles.css`, `src-tauri/src/lib.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/default.json` (allow the `store-changed` event listener).

## 4. Public types and signatures

```rust
// src-tauri/src/events.rs
#[derive(Clone, serde::Serialize)]
pub struct StoreChanged { pub head_seq: u64 }
/// Spawned after bootstrap reaches Ready. Coalesces to <= 1 emit per 100 ms.
pub fn spawn_store_change_emitter(app: tauri::AppHandle, store: std::sync::Arc<agentdock_store::Store>);

// src-tauri/src/commands/acknowledge.rs
#[derive(serde::Deserialize)]
#[serde(tag = "target", rename_all = "snake_case")]
pub enum AckTarget { Task { task_id: String }, Session { session_id: String } }
#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AckResult { Written, AlreadyAcknowledged, NotTerminal }
#[tauri::command] pub async fn acknowledge_opened(state: tauri::State<'_, AppState>, target: AckTarget)
    -> Result<AckResult, IpcError>;
```

```ts
// src/ipc/attention.ts
export type AttentionKind = 'needs_reply' | 'needs_review' | 'background';
export interface AttentionItem { kind: AttentionKind; reason: string; task_id: string; session_id?: string; ref_id?: string }
export interface InboxCounts { needs_reply: number; needs_review: number; background: number }
export interface AttentionView { items: AttentionItem[]; counts: InboxCounts; head_seq: number }
export function isAttentionView(v: unknown): v is AttentionView;
export async function attentionList(): Promise<AttentionView>;
export async function acknowledgeOpened(target: { target: 'task'; task_id: string } | { target: 'session'; session_id: string })
  : Promise<'written' | 'already_acknowledged' | 'not_terminal'>;
/** UX rule 3: drop non-reply items of the session on screen. */
export function visibleItems(items: AttentionItem[], onScreenSessionId?: string): AttentionItem[];

// src/hooks/useStoreChanges.ts
export function useStoreChanges(): { headSeq: number };   // isTauri() false → constant 0, no listener

// src/components/InboxBadge.tsx
export function InboxBadge(props: { counts: InboxCounts }): JSX.Element;
export function badgeLabel(counts: InboxCounts, locale: 'en-US' | 'zh-TW'): string;  // accessible name
```

## 5. Implementation steps

1. Write the §6 tests.
2. `spawn_store_change_emitter`: `tauri::async_runtime::spawn`; loop on `subscription.next()`; keep the latest `head_seq`; emit at most every 100 ms (`tokio::time::interval` + dirty flag); stop when the subscription ends.
3. `acknowledge_opened`:
   - Task: projection state must be `completed`, `cancelled`, `failed` or `interrupted`, else `NotTerminal`; if `ack_seq >= entered_seq` (P8-1b columns) → `AlreadyAcknowledged`; else append `task.outcome_acknowledged{acknowledged_state: <state>, method: opened}`, actor `user`.
   - Session: state `closed` or `failed` with an outcome, else `NotTerminal`; `ack_seq > closed_seq` → `AlreadyAcknowledged`; else `session.result_acknowledged{method: opened}`, actor `user`.
   - The projector (P2-5) remains the authority; a rejection becomes `IpcError { code: "rejected" }`.
4. Frontend "opened" trigger: in the session view, when the selected task/session is terminal, the last output has rendered (`useEffect` after the timeline commit) and `document.hasFocus()` is true (also listen to `focus`), call `acknowledgeOpened` once per (entity, entered state). Never call it from the inbox row itself (opening the inbox is not opening the result).
5. `MonitorInbox` in Tauri mode: sections in fixed order; row text from the reason (localized labels for every `AttentionReason`); clicking a row selects the task/session (which then may trigger step 4); the first row gets initial focus; no dismiss buttons. Demo mode keeps the current behaviour and tests.
6. `InboxBadge` per the UX badge table; replace the inline `bell-count` span in `App.tsx`.
7. Replace polling in P4-4/P6-2/P7-1 usage sites with `useStoreChanges().headSeq` as an effect dependency plus a 10 s fallback interval.

## 6. Tests to write first

`src-tauri/tests/acknowledge.rs` (temporary store; drive the task with the store API):

| Test | Expected |
| --- | --- |
| `task_ack_written_once` | completed task → `Written`; second call → `AlreadyAcknowledged`; exactly one `task.outcome_acknowledged`, actor `user`, `method: opened` |
| `running_task_not_terminal` | running → `NotTerminal`, no event |
| `ack_after_reentering_terminal_state` | completed → acked → retry to running → completed again → `Written` again |
| `session_ack_requires_closed_with_outcome` | active child → `NotTerminal`; closed child with `succeeded` → `Written` |
| `ack_clears_attention_item` | `attention_list` before has `task_outcome_unviewed`; after `Written` it is gone |
| `failed_task_cleared_only_by_opened` | failed task → item present until `acknowledge_opened` (there is no other command that writes an acknowledgement; assert the registered command list has no `mark_reviewed`/`bulk`) |

Frontend (vitest + jsdom):

| Test | Expected |
| --- | --- |
| `badge_hidden_when_nothing_waits` | `{0,0,5}` → no badge element; label mentions 5 running in background |
| `badge_review_only_outlined` | `{0,2,0}` → text `2`, class for outlined pill, no `!` |
| `badge_reply_has_bang` | `{1,2,0}` → text `!3` |
| `badge_caps_at_99_plus` | `{100,0,0}` → `!99+` |
| `badge_labels_en_and_zh` | accessible names match the UX table wording in both locales |
| `sections_in_fixed_order` | mixed items → headings in order reply, review, background with counts |
| `on_screen_session_hidden_unless_reply` | `visibleItems` drops `agent_working` of the on-screen session but keeps its `approval_pending` |
| `no_dismiss_in_tauri_mode` | real view → no dismiss button rendered |
| `demo_mode_unchanged` | existing `monitor.test.ts` still passes untouched |
| `first_row_focused_on_open` | opening the inbox focuses the first row |
| `ack_called_once_when_focused_and_rendered` | terminal task selected, `document.hasFocus()` mocked true → `acknowledgeOpened` once; re-render → still once; window blurred → not called |
| `inbox_click_does_not_ack` | clicking an inbox row only selects; `acknowledgeOpened` is called by the session view effect, not by the row |
| `store_changed_triggers_refetch` | emit a mocked `store-changed` → `attentionList` called again; no event for 10 s → fallback refetch (fake timers) |
| `ipc_fixture_matches_type_guard` | `attention_view.json` → `isAttentionView` true |

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-desktop --test acknowledge          # 6 pass (needs Tauri Linux packages, CONVENTIONS §1)
npm run typecheck && npm test && npm run build              # 14 new tests pass, existing tests still pass
```

Windows-only (manual, owner's machine): `npm run tauri dev`, run a mock-agent task to completion, switch to another window and back → the "to review" badge clears only after the result is on screen with focus.

## 8. Spec references and porting sources

- `docs/ux/states-and-indicators.md` §4 lines 58–110 (classification order, viewed vs opened, no single-row mark reviewed in the MVP, badge semantics, inbox sections).
- `docs/contracts/attention.md` (clearing rules; Divergence 3 blocks the bulk action).
- `docs/contracts/events.md` lines 57 and 69 (`task.outcome_acknowledged`, `session.result_acknowledged`, only `opened` counts for auto-archive); `docs/contracts/state-machines.md` line 245 (viewed vs opened).
- `docs/contracts/schema/agentdock.schema.json` lines 804–820 (acknowledgement payloads).
- `docs/ux/acceptance-criteria.md` UX-52 (only approvals are announced assertively).
- Porting sources (scenarios only): PR #27, branch `feat/live-session-sentinel`, SHA `6dd3ac82f0c006c99643f6d5fa582d53b2350a7d`, `docs/implementation/live-session-sentinel.md` (event-driven refresh, viewed cursor); PR #29, SHA `c57b824ddcdc2355fbc10bded265db4b99cf9e80`, `apps/runtime/attention.test.mjs` lines 87 ("mark reviewed" cannot hide a pending permission), 230 (view marks never move backwards — here: acknowledgement is an event keyed to `entered_seq`).

## 9. Dependencies

None new (`@tauri-apps/api` event module from P1-2).

## 10. Model tier

Standard model.

## 11. Common mistakes and pitfalls

- Acknowledging from the inbox row or on mere selection while the window is in the background: "opened" requires the result rendered with focus.
- Keeping the demo dismiss button in Tauri mode: it would hide real failures without an event.
- Counting background work in the badge: the number must mean "things waiting for you".
- Emitting one Tauri event per store event: a busy agent produces hundreds per second; coalesce.
- Relying only on events: a missed event leaves the UI stale forever; keep the slow fallback poll.
- Hiding an on-screen session's pending approval: reply items stay listed even for the session on screen (the card may be scrolled away).

## 12. Reviewer checklist

- [ ] Is `acknowledge_opened` the only command that writes an acknowledgement, and does it check the terminal state and the `entered_seq`/`closed_seq` rule?
- [ ] Is the "opened" trigger gated on focus and rendered output, and fired once per entered state?
- [ ] Are dismiss controls absent in Tauri mode?
- [ ] Does the badge follow the UX table in both locales, including `99+` and the `!` prefix?
- [ ] Are emits coalesced and is there a fallback poll?
- [ ] Were the P4-4/P6-2/P7-1 polling sites actually replaced (or listed as skipped in the PR)?
