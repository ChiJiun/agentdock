# P8-4: PR and CI phases (pr → ci, CI checks as `origin: ci` events, CI-failure repair, user acceptance, no merge)

> **繁中摘要**：接在 P8-3 之後。task 在 `pr` 時，UI 提供「推送」與「建立 PR」（都走 P7-2 與核准）；兩者都成功、且 GitHub 上 PR 的 head 等於 AgentDock 推送且測過的 commit 時，才以 integration 身分寫 T34 進入 `ci`。在 `ci` 期間定時用 P7-3 讀 CI，每個 CI check 寫成 `check.started/finished{origin: ci}`；CI 失敗就送回 agent 修（同一套次數上限），CI 全部通過時只顯示，由使用者按「接受」寫 T39 完成。PR head 在外部被改動時停止並請使用者決定。alpha 不做 merge。沒有任何 CI check 的 repo 依契約無法走完 PR 流程，列為待擁有者討論。模型等級：強模型實作＋強模型審查。

Issues: #10, #15 | Gate (#51): G5 (PR after human confirmation; merge stays authorized-only), G6 (real CI evidence, not agent claims), G8 | Model tier: **strong model implements, strong model reviews**

## 1. Goal and non-goals

Goals:

- **`pr` phase UI flow**: "Push" (P7-2a `push`) then "Create PR" (P7-2b `create_pr`, title/body edited by the user; the body may be prefilled from the objective and the review summary, never sent without the approval card).
- **T34 `pr_published`** (actor `integration`): only when, in this PR round, a `git_push` succeeded (or reconciled applied), a PR exists (`pr_create` succeeded in any round), no operation is unreconciled, **and** a live read of the PR (P7-3 `pr_head`) shows `state = open`, not draft, `head_sha == expected_sha` of that push, and the PR belongs to the task repository (PRL-1; PR #29 test line 470). Otherwise stay in `pr` and show why.
- **CI polling in `ci`**: every 30 s (backoff to 5 min after consecutive `GhError`s), `ci_for_pr(repo, number, expected_head)`.
  - Each CI check (keyed by `workflow + name`) gets `check.started{origin: ci, name, external_url}` when first seen and `check.finished{state}` when its bucket becomes terminal: `pass` → `passed`, `fail` → `failed`, `cancel` → `cancelled`. `skipping` checks are not recorded (they are neither evidence nor failure). Actor `integration`. A re-run on GitHub after a finished result starts a new `check_id`.
  - `HeadChanged` → stop polling, record nothing, show "The PR head changed outside AgentDock (expected X, found Y)"; the user may send the task back (T38) or cancel.
  - Verdict `Failure` → repair round (`Round{phase: Ci, failing: failed check names}` with P8-3's `stop_reason`) → T38 `ci_failed` (orchestrator) → `running` with a repair prompt containing failed check names and links; or T42 `repair_limit_reached` → `failed`.
  - Verdict `Success` → no transition; attention shows `phase_decision_pending`; the user clicks "Accept" → T39 `ci_passed_accepted` (actor `user`; guard `ci_checks_passed`, `no_unreconciled_operations`).
  - Verdict `NoChecks` → no transition; show "No CI checks were reported for this PR. The contract needs CI evidence to complete through the PR path" (owner decision pending, README).
- After T38 the next round needs a new push (and the existing PR is reused by P7-2b's lookup), per `pr_published_this_round`.
- On restart: `check.finished{outcome_unknown}` for running CI checks is written by recovery (P2-6); after resume into `ci` (T08) polling starts again and records fresh checks.

Non-goals: merge (`pr_merge`) — not in alpha; the UI shows "Merge on GitHub yourself" with the PR link; branch deletion and worktree removal after completion (#37); PR comments; required-check configuration of the repository (GitHub ruleset #55 is the remote protection); CI log download.

## 2. Prerequisites and parallel work

- Prerequisites: P8-3a (task phases, `stop_reason`), P7-2a/b, P7-3, P6-1b (check event writing helpers), P6-2 (Checks tab shows `origin: ci` rows).
- Parallel: P8-2, P9-1.

## 3. Files

New:

- `crates/agentdock-orchestrator/src/tasks/pr_phase.rs` (`publish_gate`, T34)
- `crates/agentdock-orchestrator/src/tasks/ci_phase.rs` (`CiWatcher`, mapping, T38/T42, user acceptance T39)
- `crates/agentdock-orchestrator/tests/pr_ci_flow.rs`
- `src-tauri/src/commands/ci.rs` (`task_accept_ci`, `task_ci_send_back`, `task_pr_status`)
- `src/components/PrPhasePanel.tsx`, `src/components/PrPhasePanel.test.tsx`

Modified: `crates/agentdock-orchestrator/src/tasks/mod.rs` (start/stop the watcher on entering/leaving `ci`), `crates/agentdock-orchestrator/src/checks.rs` (shared `append_check_started/finished` helpers accepting `origin` and actor), `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/default.json`, `src/App.tsx`, `src/i18n/messages.ts`.

## 4. Public types and signatures

```rust
// crates/agentdock-orchestrator/src/tasks/pr_phase.rs
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PublishBlocker {
    NotPushedThisRound, NoPr, UnreconciledOperation { operation_id: String },
    PrNotOpen, PrIsDraft, PrHeadMismatch { expected: String, found: String }, PrOtherRepository,
    GitHubUnavailable,
}
impl TaskService {
    /// Called after create_pr succeeds and by the "Check again" button. Writes T34 or returns the blockers.
    pub async fn publish_gate(&self, task: &TaskId) -> Result<Result<(), Vec<PublishBlocker>>, TaskError>;
}

// crates/agentdock-orchestrator/src/tasks/ci_phase.rs
pub const CI_POLL: std::time::Duration = std::time::Duration::from_secs(30);
pub const CI_POLL_MAX: std::time::Duration = std::time::Duration::from_secs(300);

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CiStatus {
    Pending, Success, Failure { failed: Vec<String> }, NoChecks,
    HeadChanged { expected: String, found: String }, Unavailable { consecutive_failures: u32 },
}

pub struct CiWatcher { /* task id, repo, pr number, expected head, known check ids by key, cancel token */ }
impl CiWatcher {
    /// One poll: read CI, write check events, return the status. Pure decisions live in `decide`.
    pub async fn poll_once(&mut self) -> Result<CiStatus, TaskError>;
}
/// Pure: given previous known checks and a snapshot, which check events to write.
pub fn diff_ci_checks(known: &std::collections::BTreeMap<String, KnownCheck>,
    snapshot: &agentdock_integrations::github::read::CiSnapshot) -> Vec<CiEventPlan>;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownCheck { pub check_id: CheckId, pub finished: bool }
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CiEventPlan { Start { key: String, name: String, url: Option<String> }, Finish { key: String, state: CheckState } }

impl TaskService {
    pub async fn accept_ci(&self, task: &TaskId) -> Result<(), TaskError>;            // T39 user
    pub async fn ci_send_back(&self, task: &TaskId, note: &str) -> Result<(), TaskError>; // T38 orchestrator on user command
}
```

## 5. Implementation steps

1. Write the §6 tests (fake `gh` from P7-3 with scripted `pulls/{n}` and `pr checks` responses; bare local origin for pushes).
2. `publish_gate`:
   1. From projections: latest T28 seq = round start; a `git_push` after it that `succeeded`/`reconciled_applied` (take the last one's `expected_sha`); a `pr_create` `succeeded` in any round (take `pr_number`, `url`); no `recorded`/`started`/`outcome_unknown` operation.
   2. `GitHubRepo` of `origin`; the PR URL's owner/name must equal it (case-insensitive) → else `PrOtherRepository`.
   3. `pr_head(number)` → state, draft, head SHA checks.
   4. All good → T34 (actor `integration`, trigger `pr_published`) via the P8-3 transition helper → start `CiWatcher`.
3. `CiWatcher` runs in a task owned by `TaskService`; cancelled on leaving `ci` (pause/cancel/T38/T39). `poll_once`:
   1. `ci_for_pr(.., expected_head)`; `HeadChanged` → stop and expose the status; `GhError` → increment failures, back off (×2 up to `CI_POLL_MAX`), status `Unavailable`.
   2. `diff_ci_checks` → append events in one transaction (actor `integration`); a check whose bucket went back to pending after finishing (GitHub re-run) → `Start` with a new id.
   3. Verdict → status as in §1. On `Failure`, compute the round, then T42 or T38 + repair prompt (P8-3 prompt helper) — only once per head (remember the head for which a repair was triggered).
4. `accept_ci`: T39 by `user` (projector checks `ci_checks_passed`); stop the watcher; task `completed`. The UI then shows the PR link and "Merge on GitHub yourself; AgentDock alpha does not merge".
5. `PrPhasePanel`: push button (disabled with reasons from P7-2 errors), create-PR form (title/body, base, draft), blockers list from `publish_gate`, CI status (pending/success/failure/no checks/head changed/unavailable), "Accept" (enabled only on `Success`), "Send back". All text as text nodes.

## 6. Tests to write first

`ci_phase.rs` unit tests (`diff_ci_checks`, pure):

| Test | Expected |
| --- | --- |
| `new_pending_check_starts` | unknown key, bucket pending → `Start` only |
| `new_finished_check_starts_and_finishes` | unknown key, bucket pass → `Start` then `Finish{passed}` |
| `known_running_check_finishes` | known unfinished, bucket fail → `Finish{failed}` |
| `skipping_not_recorded` | bucket skipping → no plan |
| `rerun_after_finish_starts_new` | known finished, bucket pending → `Start` (new id later) |
| `cancel_maps_to_cancelled` | bucket cancel → `Finish{cancelled}` |
| `same_name_different_workflow_distinct` | two checks named `build` in different workflows → two keys |

`crates/agentdock-orchestrator/tests/pr_ci_flow.rs` (task driven to `pr` via P8-3 helpers, approvals resolved by a simulated user):

| Test | Expected |
| --- | --- |
| `gate_blocks_without_push` | `publish_gate` → `[NotPushedThisRound, NoPr]`, no T34 |
| `gate_blocks_head_mismatch` | fake PR head ≠ pushed SHA → `PrHeadMismatch`, no T34 |
| `gate_blocks_draft_and_closed` | draft → `PrIsDraft`; closed → `PrNotOpen` |
| `gate_blocks_other_repository` | PR URL of another repo → `PrOtherRepository` |
| `gate_passes_writes_t34_as_integration` | all good → `task.state_changed pr→ci`, actor `integration`, trigger `pr_published` |
| `ci_checks_recorded_as_ci_origin` | snapshot pending → `check.started{origin: ci, external_url}`; next poll pass → `check.finished{passed}`; actor `integration` |
| `ci_success_waits_for_user` | all pass → state stays `ci`; `accept_ci` → T39 by `user` → `completed` |
| `agent_cannot_accept_ci` | the mock agent (P3-3 `scripted`, directive `SAY: CI is green` in the objective) writes it → state stays `ci` (no T39 without the user) |
| `ci_failure_sends_back_once_per_head` | fail → T38, repair prompt contains failed check names and links; another poll with the same head does not send back twice |
| `ci_repair_limit` | failures repeated → T42 `failed` |
| `new_round_needs_new_push` | after T38 → … → back in `pr`: `publish_gate` without a new push → `NotPushedThisRound` |
| `head_changed_outside_stops_polling` | fake PR head changes mid-read → status `HeadChanged`, no check events for that poll, watcher stopped |
| `no_checks_cannot_complete` | `NoChecks` → `accept_ci` returns the projector rejection (`ci_checks_passed`) and the UI message |
| `gh_outage_backs_off` | three consecutive `GhError`s → `Unavailable{3}`, next delay 240 s (fake clock) |
| `restart_in_ci_marks_unknown_then_repolls` | crash with a running CI check → recovery `outcome_unknown`; resume (T44 → T08) → new `check.started` for the same key with a new id |
| `stale_ci_from_previous_round_ignored` | checks finished before the latest entry into `ci` do not count for `ci_checks_passed` (port of PR #29 line 164) |

`src/components/PrPhasePanel.test.tsx`: blockers rendered as text; "Accept" disabled unless status is `success`; CI link rendered only for `https://github.com/` URLs; body textarea content never rendered as HTML.

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-orchestrator ci_phase::                             # 7 unit tests pass
cargo test -p agentdock-orchestrator --test pr_ci_flow -- --test-threads=1  # 16 pass
npm test                                                                    # PrPhasePanel tests pass
```

Windows-only (CI): `pr_ci_flow` runs in the `windows-latest` job as well.

Manual (owner, with a test GitHub repository that has a CI workflow): run a task through review → push → PR → CI; make CI fail once and confirm the task returns to `running`; then green → Accept → `completed`; confirm on GitHub that the PR is still open and unmerged.

## 8. Spec references and porting sources

- `docs/contracts/state-machines.md` lines 127–138 (T33–T43), 175 (`pr_published_this_round`), `ci_checks_passed` and `merge_evidence_if_integration` rows (lines 160–180).
- `docs/contracts/events.md` line 73 (check events; results by orchestrator/integration).
- `docs/contracts/schema/agentdock.schema.json` lines 412–416, 631–650, 1093–1116 (check states, `origin: ci`, `external_url`).
- ADR-0002 lines 150 (PRL-1 reviewed SHA = PR head), 152 (PRL-3 stop conditions: same CI check failing twice), 155 (PRL-6 CI only from `gh pr checks` buckets), 160 (PRL-11 known gaps: base changes, merge queues, fork PRs).
- Issue #10 Requirements items 6–8; Issue #51 gate 5; Issue #55 (remote ruleset is the final protection).
- Porting sources (scenarios only): PR #29, branch `feat/durable-task-workflow`, SHA `c57b824ddcdc2355fbc10bded265db4b99cf9e80`, `apps/runtime/task-workflow.test.mjs` lines 132 (no implicit merge), 164 (earlier-round evidence does not count), 195 (reviewed commit, PR head and CI commit must be the tested commit), 327 (cancel with open PR or running CI), 470 (PR URL must belong to the task repository), 530 (final gate uses only server-owned GitHub proof).

## 9. Dependencies

None new.

## 10. Model tier

Strong model implements and reviews: this is the evidence gate that #51 says must not accept agent-reported PASS.

## 11. Common mistakes and pitfalls

- Treating the agent's "CI passed" message or a local check as CI evidence: only `ci_for_pr` results become `origin: ci` checks.
- Writing T34 right after `create_pr` without reading the PR head: a force push by someone else would attach the wrong commit.
- Counting `skipping` checks as passed, or `NoChecks` as success.
- Sending back on every poll while CI stays red: one repair per head.
- Keeping the watcher alive after leaving `ci`: it would write check events for a task in `running`.
- Offering a merge button: alpha has none; the user merges on GitHub.

## 12. Reviewer checklist

- [ ] Does T34 require a live PR read with head = pushed SHA, open, non-draft, same repository?
- [ ] Are CI checks recorded only from `ci_for_pr` with actor `integration`, and never from agent text?
- [ ] Is T39 only reachable by the user, and does `NoChecks` stay blocked?
- [ ] Is a repair triggered at most once per head, with PRL-3 limits?
- [ ] Is the watcher cancelled on every exit from `ci`?
- [ ] Is there any code path that runs `gh pr merge`? There must not be.
