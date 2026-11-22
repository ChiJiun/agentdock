# P9-2: Alpha dogfood log (per-task metrics derived from events, export, gate-8 and self-hosting tracking)

> **繁中摘要**：#51 要求連續完成至少 10 個真實開發任務（含 2 個併發、2 個測試失敗修復、1 個 App 中斷恢復），之後 20–30 個任務要記錄完成時間、人工介入、失敗率與恢復成功率。本包用事件推導每個 task 的指標（純函式，不另存資料、不估算任何額度），提供匯出成 Markdown／CSV 的 command 與按鈕，並在 `docs/dogfood/` 放記錄範本與 gate 8 的勾選表。人工介入的定義寫死在程式與文件中，避免各自解讀。模型等級：一般模型可。

Issues: #51 | Gate (#51): G8 (10 real tasks with the required mix), self-hosting gate (20–30 tasks with metrics) | Model tier: **standard model**

## 1. Goal and non-goals

Goals:

- `task_metrics(events_of_task) -> TaskMetrics`: a pure function in `agentdock-core` over one task's events (already decoded bodies), returning:
  - `outcome` (current task state; `completed` / `cancelled` / `failed` / other),
  - `wall_clock_ms` (first `task.created` → the event that entered the current terminal state; `None` if not terminal),
  - `active_ms` (sum of time in `preparing`…`ci`, excluding `interrupted`, `queued`, `awaiting_approval`),
  - `human_interventions` (exact definition below),
  - `repair_rounds_checks` (T22 count), `repair_rounds_review` (T27), `repair_rounds_ci` (T38),
  - `interruptions` (entries into `interrupted`, by reason) and `resumed_after_interruption` (T44 count) and `recovered_after_host_crash` (an `interrupted{host_crashed}` later followed by `completed`),
  - `concurrent_peak` is computed across tasks (see `run_metrics`),
  - `approvals` (requested / approved by user / denied by user / decided by policy),
  - `adapters` used (adapter ids of the task's sessions),
  - `checks_failed_then_passed` (at least one local `failed` check followed later by an all-passed verifying round).
- **Human intervention** (fixed definition): each of the following counts as 1: a `session.prompt_submitted` with `origin: user` after the first orchestrator prompt; an `approval.resolved` with actor `user`; a user-actor `task.state_changed` other than T01 (create) and T39/T28/T29 (the expected acceptance clicks are counted separately as `acceptances`); a `review_send_back`/`ci_send_back` (T27/T38 written on a user command — record the user command by checking `prompt.origin: user` of the send-back prompt).
- `run_metrics(all tasks) -> RunSummary`: number of tasks, completed/failed/cancelled counts, failure rate, median and p90 `wall_clock_ms`, mean interventions, recovery success rate (`recovered_after_host_crash` / tasks that had a host crash), `concurrent_peak` (max number of tasks simultaneously in `preparing`…`ci`, from transition timestamps), and the **gate-8 checklist** booleans: ≥10 completed real tasks, ≥2 overlapped in time, ≥2 had `checks_failed_then_passed`, ≥1 recovered after an app interruption (`host_crashed` or user-closed app → `interrupted` → `completed`), and no task has an event-store integrity error.
- Tauri command `dogfood_export(format: "markdown" | "csv", path)`: writes the table to a path the user picked in a save dialog (default `Documents\AgentDock-dogfood-<date>.md`), never inside a repository unless the user chose it.
- `docs/dogfood/README.md`: how to run the dogfood period, what counts as a "real development task", the intervention definition, the gate-8 checklist, and a template `docs/dogfood/log-template.md` with columns for the owner's manual notes (task link, what went wrong, unexpected overwrite or data loss yes/no).

Non-goals: telemetry or any network upload; quota or cost estimates (only `usage.reported` values the provider reported may be summed, and only as "reported cost" with its unit; no remaining-quota numbers — CONVENTIONS invariant 7); dashboards; editing events.

## 2. Prerequisites and parallel work

- Prerequisites: P2-2 (decoded bodies), P2-4 (`events_after`), P3-7 (`AppState`), P8-3 (the triggers it counts exist).
- Parallel: P9-1.

## 3. Files

New:

- `crates/agentdock-core/src/metrics.rs`
- `crates/agentdock-core/tests/metrics_fixtures.rs`
- `crates/agentdock-store/src/events_of_task.rs` (`Store::events_of_task`)
- `src-tauri/src/commands/dogfood.rs`
- `docs/dogfood/README.md`
- `docs/dogfood/log-template.md`

Modified: `crates/agentdock-core/src/lib.rs`, `crates/agentdock-store/src/lib.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/default.json` (dialog permission for save path), `src/App.tsx` (an "Export dogfood log" item in the settings/menu area), `src/i18n/messages.ts`.

## 4. Public types and signatures

```rust
// crates/agentdock-core/src/metrics.rs
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize)]
pub struct ApprovalCounts { pub requested: u32, pub user_approved: u32, pub user_denied: u32, pub policy_decided: u32, pub expired_or_invalidated: u32 }

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct TaskMetrics {
    pub task_id: TaskId, pub objective_preview: String /* first 80 chars, single line */,
    pub issue_url: Option<String>, pub outcome: TaskState,
    pub wall_clock_ms: Option<u64>, pub active_ms: u64,
    pub human_interventions: u32, pub acceptances: u32,
    pub repair_rounds_checks: u32, pub repair_rounds_review: u32, pub repair_rounds_ci: u32,
    pub interruptions: std::collections::BTreeMap<String, u32>, pub resumed_after_interruption: u32,
    pub recovered_after_host_crash: bool, pub checks_failed_then_passed: bool,
    pub approvals: ApprovalCounts, pub adapters: Vec<String>,
    /// Sum of provider-reported cost per unit (e.g. {"USD": 0.42}); empty when nothing was reported.
    pub reported_cost: std::collections::BTreeMap<String, f64>,
    pub active_intervals: Vec<(Timestamp, Timestamp)>,   // for run-level concurrency
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Gate8 { pub ten_completed: bool, pub two_concurrent: bool, pub two_test_repairs: bool, pub one_app_recovery: bool }

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct RunSummary {
    pub tasks: u32, pub completed: u32, pub failed: u32, pub cancelled: u32, pub failure_rate: f64,
    pub median_wall_clock_ms: Option<u64>, pub p90_wall_clock_ms: Option<u64>,
    pub mean_interventions: f64, pub recovery_success_rate: Option<f64>, pub concurrent_peak: u32,
    pub gate8: Gate8,
}

pub fn task_metrics(events: &[(EventEnvelope, EventBody)]) -> Option<TaskMetrics>;   // None if no task.created
pub fn run_metrics(tasks: &[TaskMetrics]) -> RunSummary;
pub fn to_markdown(tasks: &[TaskMetrics], summary: &RunSummary) -> String;
pub fn to_csv(tasks: &[TaskMetrics]) -> String;   // RFC 4180 quoting; formula-leading cells (=,+,-,@) prefixed with '
```

```rust
// crates/agentdock-store/src/events_of_task.rs
impl Store { pub fn events_of_task(&self, task: &TaskId) -> Result<Vec<EventEnvelope>>; }   // ordered by seq, tombstones skipped

// src-tauri/src/commands/dogfood.rs
#[tauri::command] pub async fn dogfood_summary(state: tauri::State<'_, AppState>) -> Result<RunSummary, IpcError>;
#[tauri::command] pub async fn dogfood_export(state: tauri::State<'_, AppState>, format: String, path: String) -> Result<(), IpcError>;
```

## 5. Implementation steps

1. Write the §6 tests.
2. `task_metrics`: single pass over events in seq order, tracking current state and the timestamp it was entered (`occurred_at`). Use `occurred_at` for durations; clamp negative intervals to 0. Apply the intervention definition exactly as §1; document each counted event type in the function's doc comment.
3. `run_metrics`: failure rate = failed / (completed + failed + cancelled), `0.0` when the denominator is 0; median/p90 over completed tasks only (nearest-rank); concurrency by sweeping interval start/end points (an end at the same instant as a start does not overlap).
4. Gate 8: `ten_completed` = completed ≥ 10; `two_concurrent` = at least two completed tasks whose active intervals overlap; `two_test_repairs` = ≥2 completed tasks with `checks_failed_then_passed`; `one_app_recovery` = ≥1 completed task with `recovered_after_host_crash` (closing or killing the app while a task is in flight is recorded as `interrupted{host_crashed}` by recovery on the next start; `user_paused` does not count).
5. Export: markdown table with one row per task plus the summary and the gate-8 checklist (`[x]`/`[ ]`); CSV with the per-task columns. Objective preview and issue URL are already user text; still run them through the `Redactor` before writing a file.
6. `dogfood_export`: the path comes from the Tauri save dialog in the frontend; the backend refuses paths inside any registered project repository unless the dialog result is explicitly confirmed (`confirm_inside_repo: true` parameter, default false) — avoids committing the log by accident.
7. `docs/dogfood/README.md` and `log-template.md` per §1.

## 6. Tests to write first

`crates/agentdock-core/src/metrics.rs` unit tests (events built with test helpers):

| Test | Expected |
| --- | --- |
| `wall_clock_and_active_time` | created 00:00, preparing 00:01, running 00:02, awaiting_approval 00:10–00:15, verifying 00:20, completed 00:30 → wall 30 min, active 24 min |
| `interventions_counted_by_definition` | 2 user prompts after the first orchestrator prompt, 1 user approval, 1 user pause, T28 by user → interventions 4, acceptances 1 |
| `orchestrator_prompts_not_counted` | repair prompts with `origin: orchestrator` → 0 interventions |
| `repair_rounds_by_phase` | T22 ×2, T27 ×1, T38 ×1 → 2/1/1 |
| `host_crash_recovery_detected` | `interrupted{host_crashed}` → resume → completed → `recovered_after_host_crash` |
| `checks_failed_then_passed` | local check failed, later round all passed → true; failed and never passed → false |
| `reported_cost_only_from_usage_reported` | two `usage.reported` with `cost{amount, unit: USD, basis: reported}` → summed; no other numbers invented |
| `no_task_created_is_none` | events without `task.created` → `None` |
| `failure_rate_and_percentiles` | 8 completed, 1 failed, 1 cancelled with known durations → rate 0.1, nearest-rank median and p90 |
| `concurrency_peak` | three intervals with two overlapping → peak 2; touching intervals → no overlap |
| `gate8_all_true_and_each_false` | constructed sets flip each boolean independently |
| `csv_quotes_and_neutralizes_formulas` | objective `=HYPERLINK("x")` and a comma → cell starts with `'` and is quoted |
| `markdown_escapes_pipes` | objective containing `|` does not break the table |

`crates/agentdock-core/tests/metrics_fixtures.rs`: run `task_metrics` over each contract fixture (`docs/contracts/fixtures/*.jsonl`, grouped by task) → never panics; fixture 01 → `outcome: completed`, `approvals.user_approved >= 1`; fixture 05 → interruption reason `quota_exhausted` counted.

`src-tauri` (`cargo test -p agentdock-desktop dogfood`): export refuses a path inside a registered repository without `confirm_inside_repo`; writes the file otherwise; the file content contains no `ghp_` fake token placed in an objective.

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-core metrics::                     # 13 pass
cargo test -p agentdock-core --test metrics_fixtures       # passes over all 13 fixtures
cargo test -p agentdock-desktop dogfood                    # export tests pass
npm run typecheck && npm test && npm run build
```

No Windows-only items (the save dialog is exercised manually on Windows by the owner during dogfooding).

## 8. Spec references and porting sources

- Issue #51: Release Gate item 8 (10 real tasks: 2 concurrent, 2 test-failure repairs, 1 app interruption recovery; no data loss or unexpected overwrite) and the Self-hosting gate (20–30 tasks with completion time, human intervention, failure rate, recovery success rate; keep the old tools as fallback).
- `docs/contracts/events.md` (event types counted), `docs/contracts/state-machines.md` lines 92–143 (transition ids used in the definitions).
- `docs/contracts/schema/agentdock.schema.json` `UsageReportedPayload` and `Usage` (`cost.basis: reported`); CONVENTIONS §6 invariant 7 (no quota display).
- No porting source.

## 9. Dependencies

None new (Tauri dialog plugin: if P1-2 did not add `tauri-plugin-dialog`, add it here — **needs audit**).

## 10. Model tier

Standard model.

## 11. Common mistakes and pitfalls

- Storing metrics in new tables: derive them from events so they cannot drift.
- Counting orchestrator repair prompts or policy decisions as human interventions.
- Using `recorded_at` instead of `occurred_at` for durations (recorded time is clamped monotonic by the store).
- Estimating cost or quota: only sum provider-reported cost with its unit.
- Writing the export into the repository by default: it could be committed with task objectives in it.
- CSV formula injection when the owner opens the file in Excel.

## 12. Reviewer checklist

- [ ] Does the intervention count match the written definition exactly, and is it documented in code and in `docs/dogfood/README.md`?
- [ ] Are all durations from `occurred_at`, with interruptions and approvals excluded from `active_ms`?
- [ ] Is the gate-8 checklist computed from data, not entered by hand?
- [ ] Are there no quota/remaining numbers anywhere?
- [ ] Are CSV and Markdown outputs injection-safe and redacted?
- [ ] Is the default export location outside repositories?
