# P8-3: Orchestrator for the local phases (task creation → preparing → running → verifying → review → pr), pause/cancel/resume

> **繁中摘要**：把前面各包串成可用的 task 流程。P8-3a：建立 task（可選 GitHub issue）、排程、準備（建立 worktree、記錄起點 checkpoint、啟動 implementation session）、running、使用者按「完成實作」後 commit 並進入 verifying、自動跑 checks、失敗時送回 agent 修（有次數上限），以及暫停、取消、重啟後恢復。P8-3b：review 階段，啟動全新的唯讀 reviewer 子 session，解析帶 nonce 的判定區塊；有 blocking 時自動送回修正，判定「可合併」時只顯示，**由使用者**按下才進入 pr（agent 文字不能推進到對外操作）。重複同類問題或超過輪數就停在 failed。所有狀態轉移依 ADR-0003 的轉移表。離開階段（pause／cancel／fail）的順序、session 關閉的 `outcome`、agent 意外結束對 task 的影響，全部照 P4-3 §5A 的單一狀態表，本包不另外定義。模型等級：強模型實作＋強模型審查。

Issues: #10, #9, #6, #15 | Gate (#51): G2 (a real task end to end), G3, G4 (two tasks in parallel), G6, G8 (interrupt and resume, repair after failing tests) | Model tier: **strong model implements, strong model reviews**

Two PRs:

- **P8-3a**: `TaskService` — create, schedule, prepare, run, implementation done → commit → verifying → checks → repair loop; pause, cancel, resume, retry; desktop commands.
- **P8-3b**: review phase — fresh read-only reviewer child session, verdict parsing, findings, stop conditions, user-confirmed move to `pr`.

## 1. Goal and non-goals

Goals:

- Every task state change goes through `check_task_transition` (P2-3) and is written by the actor the transition table allows. The orchestrator never writes a transition the table does not list.
- **Create** (T01, user): objective text (1..=20,000 chars) and optional GitHub issue (from P7-3 `open_issues`; stored as `issue_url`), adapter choice, the project's repository. Writes `task.created{state: queued, branch, worktree_path, auto_resume_policy, issue_url}` with the P5-2 plan's branch and path.
- **Schedule** (T02): at most `max_parallel_tasks` (default 2, user setting 1..=4) tasks in `preparing`…`ci` at once; FIFO by creation.
- **Prepare** (T04 / T05–T08 on resume): P5-2 `create` → **base checkpoint** `task.checkpoint_recorded{phase: preparing, worktree{head_sha: base_sha, branch, dirty: false}}` (P7-1 uses the first checkpoint with a worktree as the diff base) → `task_scope` → launch the implementation session (P3-5b, role `primary` for the first session, `repair` for later ones) with `cwd` = worktree → T04 `session_ready`. Failure before the session is ready → T10 `preparation_failed` with a `Failure`.
- **Run**: send the first prompt (`origin: orchestrator`): the objective, the issue title and URL, and a fixed instruction block (work only inside the current directory; do not push, merge or open PRs; say when done). Further prompts come from the user (`origin: user`).
- **Implementation done** (T13, user): the user clicks "Done — run checks". If the worktree is dirty, P7-2a `commit` with a user-confirmed message first. Then T13 → `verifying` and a checkpoint `{phase: verifying, worktree{head_sha, dirty: false}}` (P7-2's "tested commit" binding).
- **Verify**: `CheckService::run_all` (P6-1b). All passed → T23 `checks_passed` → `review`. Any `failed` → repair (below). Only `errored`/`cancelled` (no `failed`) → stay in `verifying` (attention shows `phase_decision_pending`); the user can re-run or send back.
- **Repair loop** (T22 `checks_failed` → `running`): send a repair prompt with the failed check names, exit codes and the last 8 KiB of each redacted log; count rounds. Stop conditions (ADR-0002 PRL-3, pure function `stop_reason(&RoundHistory)`): more than `max_repair_rounds` (default 3) in this task, or the same failing check set twice in a row → T25 / T31 `repair_limit_reached` → `failed`.
- **Pause** (T09/T14/T20/T24/T30/T35/T41 `interruption`, `interrupted{reason: user_paused}`; T20 covers a task waiting in `awaiting_approval`, T09 a task still `preparing`; the actor is `user` except T09, whose actors are only orchestrator/adapter/recovery, so a user pause from `preparing` is written by `orchestrator`), **cancel** (T03/T11/T16/T21/T26/T32/T37/T43), **resume** (T44 → `queued`, then T05–T08 by `resume_phase`), **retry** (T47 → `queued`, restarts from `running`). A phase exit (pause, cancel, fail, accept without PR) follows **P4-3 §5A row H0 exactly** and defines nothing of its own: abort started operations (`execute_guarded` writes their `outcome_unknown{killed}`; this packet never does), cancel pending approvals, write the task transition, then `SessionRuntime::shutdown(outcome)` with the outcome of §5A row H8 (cancel → `cancelled`, pause → `abandoned`, fail → `failed`, accepted without PR → `succeeded`). See §5 step 8.
- **Restart**: after P2-6 recovery, tasks are `interrupted{host_crashed}`; nothing resumes automatically unless `auto_resume_armed` (not used in alpha). The user resumes.
- **Review (P8-3b)**: on entering `review`, start a fresh child session (role `review`, `parent_session_id` = implementation session, new ACP session, never `load`/`resume`) whose brief holds only: branch and head SHA, the original objective/issue, the diff summary (P7-1), the check results, and reviewer focus notes (ADR-0002 PRL-2). The reviewer is read-only: its permission requests with any class other than `read_only` are denied by policy rule `builtin.reviewer_read_only`.
- **Verdict**: exactly one block delimited by a per-round nonce; the turn must end with `end_turn` (PRL-7). Parsed verdict stored as `session.summary_recorded{purpose: completion, source: agent_generated, content}` on the review session. `blocking` → T27 `review_blocking_findings` → `running` with the findings as the repair prompt. `mergeable` → stay in `review` (`phase_decision_pending`); **only the user** moves on with T28 `review_passed` (or T29 `accepted_without_pr`). Unparseable or missing verdict → stay in `review`; the user can rerun the review (a new fresh reviewer) or send back.

Non-goals: `pr` → `ci` and CI (P8-4); push/PR execution (P7-2, triggered from the UI in `pr`); merge; auto-resume on quota reset (fixture 05 behaviour; alpha keeps it manual and lists it as not covered); reattach (S20); multiple implementation agents per task; review by a different adapter than the user picks.

## 2. Prerequisites and parallel work

- P8-3a: P2-3, P2-5, P2-6, P3-5b, P3-6, P3-7, P4-3a, P5-2, P5-3, P6-1b, P7-1a, P7-2a, P7-3 (issue picker).
- P8-3b: P8-3a.
- Parallel: P8-2. P8-4 needs P8-3a (it starts where P8-3 leaves the task in `pr`); it can run in parallel with P8-3b.

## 3. Files

P8-3a new:

- `crates/agentdock-orchestrator/src/tasks/mod.rs` (`TaskService`)
- `crates/agentdock-orchestrator/src/tasks/scheduler.rs`
- `crates/agentdock-orchestrator/src/tasks/phase_exit.rs` (close operations/approvals/sessions before leaving a phase)
- `crates/agentdock-orchestrator/src/tasks/prompts.rs` (first prompt and repair prompt templates)
- `crates/agentdock-orchestrator/src/tasks/stop.rs` (`stop_reason`, pure)
- `crates/agentdock-orchestrator/tests/task_flow.rs`
- `src-tauri/src/commands/tasks.rs` (`task_create`, `task_prompt`, `task_done`, `task_pause`, `task_cancel`, `task_resume`, `task_retry`, `tasks_list`)

P8-3b new:

- `crates/agentdock-orchestrator/src/tasks/review.rs`
- `crates/agentdock-orchestrator/src/tasks/verdict.rs` (pure parser)
- `crates/agentdock-orchestrator/tests/review_flow.rs`
- `src-tauri/src/commands/review.rs` (`review_findings`, `review_proceed_to_pr`, `review_accept_without_pr`, `review_send_back`, `review_rerun`)
- `src/components/FindingsPanel.tsx`, `src/components/FindingsPanel.test.tsx` (Inspector "Findings" content, UX-64 Blocking/Suggestion tags)

Modified: `crates/agentdock-orchestrator/src/lib.rs`, `src-tauri/src/state.rs` (`Ready` gets `tasks: Arc<TaskService>`), `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/default.json`, `src/App.tsx`, `src/i18n/messages.ts`.

## 4. Public types and signatures

```rust
// crates/agentdock-orchestrator/src/tasks/mod.rs
pub struct TaskSettings { pub max_parallel_tasks: u8 /* 1..=4, default 2 */, pub max_repair_rounds: u8 /* 1..=10, default 3 */ }

pub struct NewTask {
    pub project_id: ProjectId, pub objective: String, pub adapter_id: AdapterId,
    pub issue: Option<agentdock_integrations::github::read::IssueRow>,
}

#[derive(Debug, thiserror::Error)]
pub enum TaskError {
    #[error("transition not allowed: {0}")] Transition(String),       // from check_task_transition
    #[error("task not found")] NotFound,
    #[error("objective must be 1..=20000 characters")] BadObjective,
    #[error("a started operation cannot be interrupted")] Uninterruptible,
    #[error(transparent)] Worktree(#[from] agentdock_integrations::worktree::WorktreeError),
    #[error(transparent)] Session(#[from] crate::OrchestratorError),
    #[error(transparent)] Checks(#[from] crate::checks::CheckServiceError),
    #[error(transparent)] Publish(#[from] crate::publish::PublishError),
    #[error(transparent)] Store(#[from] agentdock_store::Error),
    #[error(transparent)] Guard(#[from] crate::guarded::GuardError),     // GuardError::Uninterruptible maps to `Uninterruptible`
}

pub struct TaskService { /* Arc<Store>, Arc<WorktreeManager>, Arc<AdapterRegistry>, Arc<ApprovalService>,
                            Arc<CheckService>, Arc<PublishService>, sessions: Mutex<HashMap<SessionId, Arc<SessionRuntime>>>, settings,
                            task_locks: Mutex<HashMap<TaskId, Arc<tokio::sync::Mutex<()>>>>  /* §5A rule 6 */,
                            launch_aborts: Mutex<HashMap<TaskId, tokio::sync::watch::Sender<bool>>>  /* §5A row H7 */ */ }

impl TaskService {
    pub async fn create(&self, t: NewTask) -> Result<TaskId, TaskError>;            // T01, user
    pub async fn tick(&self) -> Result<(), TaskError>;                               // scheduler step: T02 + prepare for free slots
    pub async fn prompt(&self, task: &TaskId, text: &str) -> Result<(), TaskError>; // user prompt to the live implementation session
    pub async fn implementation_done(&self, task: &TaskId, commit_message: Option<&str>) -> Result<(), TaskError>; // T13 user
    pub async fn rerun_checks(&self, task: &TaskId) -> Result<(), TaskError>;
    pub async fn pause(&self, task: &TaskId) -> Result<(), TaskError>;               // interruption{user_paused}
    pub async fn cancel(&self, task: &TaskId) -> Result<(), TaskError>;
    pub async fn resume(&self, task: &TaskId) -> Result<(), TaskError>;              // T44 user, resume_phase = interruption.phase
    pub async fn retry(&self, task: &TaskId) -> Result<(), TaskError>;               // T47 user
}

// crates/agentdock-orchestrator/src/tasks/stop.rs
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Round { pub phase: TaskState /* Verifying | Review */, pub failing: std::collections::BTreeSet<String> /* check names or finding categories */ }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason { MaxRounds, SameFailureTwice }
pub fn stop_reason(history: &[Round], max_rounds: u8) -> Option<StopReason>;
```

```rust
// crates/agentdock-orchestrator/src/tasks/verdict.rs
pub const VERDICT_MAX_BYTES: usize = 64 * 1024;
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerdictKind { Mergeable, Blocking }
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Finding { pub title: String /* <= 300 */, pub category: String /* ^[a-z_]{1,40}$ */,
    #[serde(default)] pub file: Option<String>, #[serde(default)] pub line: Option<u32>, #[serde(default)] pub detail: String /* <= 4000 */ }
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Verdict { pub verdict: VerdictKind, pub blocking: Vec<Finding> /* <= 50 */, pub suggestions: Vec<Finding> /* <= 50 */ }
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerdictError { NoBlock, MultipleBlocks, WrongNonce, BadJson, Inconsistent /* mergeable with blocking items, or blocking with none */, TooLarge, TurnNotEnded }
/// Block lines: `<<<AGENTDOCK-VERDICT {nonce}>>>` … `<<<END-AGENTDOCK-VERDICT {nonce}>>>` (nonce = 16 lowercase hex, per round).
pub fn parse_verdict(agent_text: &str, nonce: &str, stop: agentdock_acp::StopReason) -> Result<Verdict, VerdictError>;
```

## 5. Implementation steps

### P8-3a

1. Write the §6 tests (mock agent from P3-3, temp store, temp repo with a bare origin).
2. Every transition goes through one helper `transition(tx, task, to, trigger, actor, extra)` that loads `TaskFacts` from projections, calls `check_task_transition`, and appends `task.state_changed` in the same transaction as any events it depends on.
3. `create`: validate; P5-2 `plan(task_id)`; append `task.created` (actor `user`). Nothing touches Git yet.
4. `tick` (called by a 1 s background loop and after every state change): count tasks in `preparing..=ci`; for each free slot take the oldest `queued` task → T02 (orchestrator, `persist_then_act`) → spawn `prepare`.
5. `prepare(task)`:
   1. `WorktreeManager::create(plan)`; error → T10 `preparation_failed` with `Failure{code: "worktree", message}`.
   2. If no checkpoint with a worktree exists yet → base checkpoint (see §1).
   3. For each session of the task that is `disconnected` (host crash or agent exit): `SessionRuntime::shutdown(Superseded)` (§5A row H9, S21 with trigger `superseded`). Then `task_scope` → `SessionConfig { role: Primary or Repair, parent_session_id: None, supersedes_session_id: the task's previous coding session if any, timeouts: Default, cwd: scope root, command: adapter launch (P3-6) }` → `SessionRuntime::launch(.., abort_rx)` with the receiver of this task's `launch_aborts` sender (writes session events S01…). `Err(Aborted)` (the user cancelled or paused during launch, §5A row H7) → no T10: the cancel or pause transition is `phase_exit`'s. Any other error → T10.
   4. Resume path: `resume_phase` recorded on T44 → T05–T08 instead of T04 (`resume_phase_restored`); `running` → T04.
   5. T04 → first prompt for a new task, or a handoff prompt (`origin: handoff`, last summary if any) for a resumed one.
6. `implementation_done`: state `running`, implementation session idle; dirty → `commit` (message from the user; empty → `BadObjective`-style validation error, never an agent-written default); T13 (user) → checkpoint `{phase: verifying}` → spawn `verify`.
7. `verify`: `run_all(stop_on_failure = false)`. Results decide per §1. For repair: compute `Round{phase: Verifying, failing}`; `stop_reason` → T25 `repair_limit_reached` with `Failure{code: "repair_limit", message: reason}`; else T22 (orchestrator) → repair prompt to the implementation session (relaunch a `repair` session if it is gone).
8. `phase_exit(task, exit)` (used by pause / cancel / fail / accept without PR) implements **P4-3 §5A row H0** and defines no events, order or outcome of its own; this step only names the calls. It runs under the task's lock (§5A rule 6), in this order:
   1. If a launch is in flight (task `preparing`, session `starting`), flip the task's `launch_aborts` sender to `true` (row H7: `launch` writes `S03 … (launch_failed)` with outcome `cancelled` itself). Then `ApprovalService::abort_started_operations_for_task(task)` (row O1): `GuardError::Uninterruptible` (a started `pr_merge`, never in alpha) → return `TaskError::Uninterruptible` before anything is written. Cancel running checks (cancellation token) and wait for them to finish. **This packet never writes `operation.outcome_unknown{killed}`**: the `execute_guarded` call that owns the operation does.
   2. `ApprovalService::cancel_open_for_task(task)` (pending approvals → `cancelled` and the agent answered `cancelled`; host-policy operations of those approvals → `abandoned`; unused grants → `invalidated`). A `recorded` operation that is still left (defensive; none should exist) → `operation.abandoned` (orchestrator).
   3. The task transition: cancel T03/T11/T16/T21/T26/T32/T37/T43 (actor user); pause `interrupted{user_paused}` T09/T14/T20/T24/T30/T35/T41 (actor user, T09 orchestrator); fail T10/T25/T31/… . Its conditions `no_open_operations` and `approval_not_pending_after` now hold.
   4. `SessionRuntime::shutdown(outcome)` for every live session of the task (implementation and reviewer), with the outcome of row H8. Errors are logged (`tracing`) and do not undo the transition. `shutdown` sets `closing` first, so no S08/S12 and no T14 follows.
   - **A session that closes by itself** (`SessionRuntime::unexpected_close()` becomes `Some(reason)`; it never fires after a host-initiated `shutdown`): one watcher task per live session awaits it, takes the task's lock, re-reads the task state and writes **only** what §5A group A "Task effect" says: `running` → T14, `review` → T30, `preparing` → T09, every other state → nothing. Reason and actor: `ProcessExited` → `adapter_disconnected` (actor adapter; fixture 12 events 30–31); `ProtocolError` / `LineTooLong` → `session_unavailable` (actor orchestrator). The `awaiting_permission` cases (rows A2, A4, C3, C4) already have their S16 / S23 and approval events from P4-3; the watcher only adds the T14/T30/T09 that P4-3 did not write (for a blocking pending approval P4-3 wrote T20, the watcher then finds the task `interrupted` and does nothing).
9. `resume`: T44 (user) with `resume_phase` = `interruption.phase` (must satisfy `resume_phase_within_interrupted_phase`) → `queued` → normal scheduling. `prepare` (step 5.3) closes sessions of the previous run that are still `disconnected` with `shutdown(Superseded)` before it launches the replacement.
10. Desktop commands map 1:1 to the methods; `tasks_list` returns projection rows + attention reasons for the sidebar.

### P8-3b

1. On entering `review` (after T23 or T06): nonce = 16 random hex; build the brief (§1; no prior reviewer output, no implementer self-assessment) and append the fixed verdict instructions: the block format and the line `Verdict nonce: <nonce>`; launch a child session role `review` with a `PermissionHandler` wrapper that denies every non-`read_only` class with `policy_rule_id: "builtin.reviewer_read_only"` (the decision is still recorded through `ApprovalService`, actor `policy`).
2. Prompt the reviewer; when the turn ends, take the agent text of that turn from the session's message deltas, `parse_verdict(text, nonce, stop_reason)`.
3. `Ok(verdict)` → append `session.summary_recorded{purpose: completion, source: agent_generated, content: canonical JSON of the verdict (redacted, bounded)}` → `shutdown(Succeeded)` the reviewer session (§5A row H8).
   - `Blocking` → `Round{phase: Review, failing: categories}` → `stop_reason` → T31 or T27 (orchestrator) with the findings as the repair prompt.
   - `Mergeable` → no transition. The UI shows "Reviewer found no blocking issues — Proceed to PR / Accept without PR / Send back".
4. `Err(_)` → no transition; record the error kind in a host-generated summary (`source: host_generated`, content "verdict unparseable: <kind>"), `shutdown(Failed)` the reviewer session (§5A row H8); UI offers "Rerun review" (new nonce, new fresh session) and "Send back".
5. User commands: `review_proceed_to_pr` → T28 (user, needs `no_unreconciled_operations`); `review_accept_without_pr` → T29 (user); `review_send_back(note)` → T27 (orchestrator acting on the user's command) with the user's note; `review_rerun`.
6. `FindingsPanel`: reads the latest completion summary of the latest review session; lists Blocking and Suggestion findings with text tags (UX-64); all text rendered as text nodes.

## 6. Tests to write first

`crates/agentdock-orchestrator/src/tasks/stop.rs` unit tests:

| Test | Expected |
| --- | --- |
| `under_limit_continues` | 2 rounds with different failures, max 3 → `None` |
| `max_rounds_stops` | 4 rounds → `MaxRounds` |
| `same_failure_twice_stops` | last two rounds both `{"unit"}` → `SameFailureTwice` |
| `same_set_in_different_phase_is_not_repeat` | Verifying `{"x"}` then Review `{"x"}` → `None` |

`crates/agentdock-orchestrator/src/tasks/verdict.rs` unit tests:

| Test | Expected |
| --- | --- |
| `parses_valid_block` | text with prose + one block → `Ok` |
| `missing_block` | `NoBlock` |
| `two_blocks` | `MultipleBlocks` |
| `wrong_nonce_rejected` | block with another nonce (e.g. copied from a file the agent read) → `WrongNonce` |
| `turn_not_ended` | stop reason `max_tokens`, `refusal` or `cancelled` → `TurnNotEnded` |
| `inconsistent_verdict` | mergeable with a blocking finding; blocking with none → `Inconsistent` |
| `oversized_and_bad_json` | 65 KiB block → `TooLarge`; invalid JSON → `BadJson` |
| `bad_category_rejected` | category `"../x"` → `BadJson` |

Each row is one `#[test]`: `stop::` has 4 and `verdict::` has 8 (`oversized_and_bad_json` is one test with two assertions), 12 in total.

`crates/agentdock-orchestrator/tests/task_flow.rs` (mock agent from P3-3 through a test adapter whose command is `--scenario scripted`, so one adapter serves every role: without directives it behaves as `echo`, and a test puts directives such as `EDIT-PATH:` / `SAY:` into the task objective, which the first prompt contains; checks via `agentdock-test-check` from P6-1):

| Test | Expected |
| --- | --- |
| `happy_path_to_review` | create → T01, T02, base checkpoint, session events, T04 → mock replies → `implementation_done("msg")` → commit, T13, verifying checkpoint, check passed, T23; final state `review` |
| `every_transition_passes_table_check` | for every `task.state_changed` written in all tests, `check_task_transition` with the recorded facts is `Ok` (assert inside a store hook) |
| `failing_check_sends_back_then_passes` | first check `exit 1` → T22, repair prompt contains the check name and exit code; second run passes → T23 (G8 "test failure repair") |
| `repair_limit_fails_task` | check always fails, max 3 → after round 4 or repeated failure → `failed` with `repair_limit` |
| `errored_check_waits_for_user` | program missing → task stays `verifying`, attention `phase_decision_pending` |
| `two_tasks_in_parallel_isolated` | two tasks, `max_parallel_tasks = 2`: both run; each session cwd is its own worktree; task A's objective carries `EDIT-PATH: <a file in task B's worktree>` so the mock requests an edit there → denied by the P5-3 scope (`approval.resolved{denied, policy_rule_id: builtin.path_scope}`) and the file is untouched (G4) |
| `third_task_waits_for_slot` | three tasks, max 2 → third stays `queued` until one leaves the active states |
| `agent_exit_interrupts_task` | the test adapter runs `exit-mid-turn` (exits 4 during the first turn) while the task is `running` → `S12` then `T14 interrupted{adapter_disconnected}` (adapter) (§5A rows A1 + Task effect); no orphan process |
| `protocol_error_interrupts_with_session_unavailable` | mock `oversize` while `running` → `S13 active→failed (protocol_error, outcome: failed)` then `T14 interrupted{session_unavailable}` (orchestrator); never `adapter_disconnected` (§5A row A3) |
| `pause_while_awaiting_approval` | objective with `EDIT-PATH:`; pause with the permission pending → `approval.resolved{cancelled}` then `T20 interrupted{user_paused}` (partial order of §5A, `S15` may come before or after `T20`), then `S06 idle→closed (outcome: abandoned)`; projector accepts every event |
| `pause_and_resume_running` | pause → `T14 interrupted{user_paused}` (user), then the session ends `idle→closed (session_closed, outcome: abandoned)` (orchestrator); no `disconnected` state and no second T14; no orphan process; resume → T44, T02, a new session whose `session.created` carries `supersedes_session_id` = the paused one, T04, handoff prompt sent |
| `cancel_with_pending_approval` | objective with `EDIT-PATH:`, permission pending → cancel → the partial order of §5A (fixture 03 events 13–16): `approval.resolved{cancelled}` (user) precedes both `T21` (user) and `S15 awaiting_permission→idle` (adapter); `S15` precedes `S06 idle→closed (outcome: cancelled)` (orchestrator); `T21` precedes `S06`; `S15` and `T21` in either order (repeat 10 times); no `disconnected`, no T14 |
| `cancel_abandons_recorded_operation` | a recorded `git_push` waiting for approval (task `awaiting_approval`, return_state `pr`) → cancel → `approval.resolved{cancelled}`, `operation.abandoned`, then T21 |
| `restart_leaves_tasks_interrupted` | crash mid-run (drop service), reopen + recovery → `interrupted{host_crashed}`; nothing resumes until `resume` |
| `retry_restarts_from_running` | failed → `retry` → T47 → … → T04 → `running` (never T05–T08) |
| `agent_cannot_finish_implementation` | objective with `SAY: done, tests pass` → the mock says it; task stays `running` (only the user triggers T13) |
| `first_prompt_contains_boundaries` | prompt text contains the objective, the issue URL and the "do not push / merge / open PRs" instruction |
| `cancel_during_launch_writes_launch_failed_cancelled` | the test adapter runs `hang-init`; cancel while the task is `preparing` and the session `starting` → `T11 preparing→cancelled` (user) and `S03 starting→failed (launch_failed, outcome: cancelled)` (orchestrator), in either order (fixture 03 events 21–22 show T11 first; §5A row H7); no T10, process gone |
| `cancel_then_agent_exits_before_turn_end` | objective with `EDIT-PATH:` and `ON-CANCEL: exit`; permission pending → cancel → `approval.resolved{cancelled}` precedes `T21`; the agent exits when `shutdown` sends `session/cancel`: `S16` (adapter, by P4-3) then `S21 disconnected→closed (outcome: cancelled)`; the session ends `closed` (not stuck in `awaiting_permission`), no T14, task `cancelled` (§5A rows C3, H3) |
| `session_outcome_follows_task_end` | three tasks ending by cancel, by pause, and by repair limit (`failed`); a fourth accepted without PR (T29): the implementation session's closing transition carries `cancelled`, `abandoned`, `failed` and `succeeded` respectively (§5A row H8); every event passes the projector |
| `cancel_kills_started_operation_once` | a task in `pr` with a started `git_push` whose effect blocks (test-only hook as in P7-2 `push_timeout_is_outcome_unknown`); cancel; expected: exactly one `operation.outcome_unknown{killed}` (actor orchestrator) written by `execute_guarded`, none by `phase_exit`; then `T37 pr→cancelled` (user), accepted because `no_open_operations` holds; the push process is gone (§5A row O1) |

`crates/agentdock-orchestrator/tests/review_flow.rs` (same test adapter with `--scenario scripted`; a test passes `--arg <verdict JSON>` and optionally `--nonce <hex>` to the adapter command; the reviewer brief contains the line `Verdict nonce: <nonce>`, which the mock uses):

| Test | Expected |
| --- | --- |
| `reviewer_is_fresh_child_review_role` | `session.created{role: review, parent_session_id: <impl>, launch_method: new}` |
| `brief_has_only_allowed_parts` | brief contains branch, head SHA, objective, diff summary, check results and the fixed verdict instructions (block format and the `Verdict nonce:` line); does not contain the implementer's transcript text |
| `reviewer_write_permission_denied_by_policy` | objective with `REVIEWER-EDIT-PATH: <file>` → the mock reviewer requests an edit → `approval.resolved{denied, actor policy, policy_rule_id: builtin.reviewer_read_only}`; the file does not contain `edited-by-mock` |
| `blocking_verdict_sends_back` | verdict blocking → summary recorded, T27, repair prompt lists the findings |
| `mergeable_waits_for_user` | verdict mergeable → no transition; `review_proceed_to_pr` → T28 by `user` |
| `agent_mergeable_never_moves_to_pr_alone` | after a mergeable verdict and 5 s, state is still `review` |
| `unparseable_verdict_offers_rerun` | no block → host summary "verdict unparseable: no_block"; `review_rerun` starts a new reviewer with a new nonce |
| `nonce_from_previous_round_rejected` | the adapter passes `--nonce 0123456789abcdef` (not this round's nonce, as a block copied from an earlier round would carry) → `WrongNonce` |
| `repeated_category_fails_task` | two blocking rounds with the same category set → T31 `failed` |

Reviewer sessions end `closed` with `outcome: succeeded` after a parsed verdict and `failed` after an unparseable one (asserted in `blocking_verdict_sends_back` and `unparseable_verdict_offers_rerun`).

`src/components/FindingsPanel.test.tsx`: Blocking/Suggestion tags as text; finding text with `<img onerror>` rendered as text; empty state "No review yet".

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-orchestrator --lib -- tasks::stop:: tasks::verdict::   # 12 unit tests pass (4 stop + 8 verdict; libtest takes several filters only after `--`, cargo takes one)
cargo test -p agentdock-orchestrator --test task_flow -- --test-threads=1  # 21 pass
cargo test -p agentdock-orchestrator --test review_flow -- --test-threads=1   # 9 pass (P8-3b)
npm test                                                                   # FindingsPanel tests pass
```

Windows-only (CI): `task_flow` and `review_flow` also run in the `windows-latest` job (mock agent and check binaries are `.exe`; orphan-process assertions use the P3-2 helpers).

Real-agent E2E (ignored by default, owner's machine; ADR-0002 X-4): `#[ignore = "needs real agent; set AGENTDOCK_REAL_AGENT_E2E=1"]` `real_claude_code_small_task` and `real_codex_small_task` from P3-6's harness, run through `TaskService` up to `review`. List them and their last passing commit in the PR.

## 8. Spec references and porting sources

- **P4-3 §5A** (single state table for cancel, shutdown, agent exit, protocol error, queued permissions and killed operations) — this packet only calls it.
- `docs/contracts/state-machines.md` lines 14–33 (actors, task states), 92–143 (T01–T47), 153–157 (cancel/interrupt with started operations; `pr_merge` exception), 160–180 (conditions).
- `docs/contracts/checkpoint-and-replay.md` lines 52–67 (recovery leaves tasks interrupted), Rules 8 (leaving a phase closes its operations).
- `docs/contracts/attention.md` (what the user sees in each wait state).
- `docs/contracts/schema/agentdock.schema.json` lines 104–120 (`TaskTrigger`, `InterruptionReason`), 200–203 (`SessionRole`), 516–517 (`SummarySource`, `SummaryPurpose`), 821–837 (`SessionCreatedPayload`).
- ADR-0002 lines 150–156: PRL-2 (fresh reviewer, brief contents, nonce-delimited single verdict block), PRL-3 (stop conditions as a pure function), PRL-7 (no verdict without `end_turn`).
- Issue #10 Workflow and Requirements; Issue #51 gates 2, 4, 6, 8.
- Porting sources (scenarios only): PR #29, branch `feat/durable-task-workflow`, SHA `c57b824ddcdc2355fbc10bded265db4b99cf9e80`, `apps/runtime/task-workflow.test.mjs` lines 132 (gates need passing evidence; no implicit merge), 164 (evidence from an earlier round never satisfies a later one), 285 (illegal transitions and forged actor confirmation rejected), 327 (task with open PR or running CI can still be cancelled), 370 (state and gates survive restart), 431 (interrupted/failed tasks resume only into an earlier phase and redo evidence), 454 (sending back from PR approval keeps the chain, a new review round replaces it). PR #25, branch `feat/acp-live-runtime`, SHA `7d41c9f1b34be8d979c89945ed61c6208a15a76d`, `docs/implementation/live-acp-runtime.md` (session lifecycle observed with real agents).
- **Deviation**: PR #29's 16-state machine is not ported; ADR-0003's 12 states are binding (ADR-0004, open question 2).

## 9. Dependencies

`rand` (0.8.x/0.9.x, MIT OR Apache-2.0) for the nonce, **needs audit** unless already in the tree (`getrandom` directly is an acceptable alternative).

## 10. Model tier

Strong model implements and reviews. This packet decides when agent output may change workflow state; a mistake lets agent text skip checks or review.

## 11. Common mistakes and pitfalls

- Letting the agent's "done" or "mergeable" text move the task: T13 and T28 come from the user; only the safe direction (T27 send back) is automatic.
- Reusing the implementation session (or `session/load`) for review: the reviewer must be fresh.
- Putting the implementer's transcript in the reviewer brief: it carries the implementer's assumptions (PRL-2).
- Treating `errored` checks as failures to repair: the agent cannot fix a missing toolchain.
- Leaving a phase without closing operations/approvals: the projector rejects the transition (`no_open_operations`); fix the order, do not weaken the projector.
- Shutting the session down before the task transition, or killing the agent directly: the close then looks like an agent crash (S08/S12 → T14 `adapter_disconnected`) after the user cancelled. Always transition first, then `SessionRuntime::shutdown()`.
- Writing `adapter_disconnected` for every session close: a protocol error or oversized line is `session_unavailable` (`acp-capabilities.md` line 97).
- Writing `outcome_unknown{killed}` from `phase_exit`: `execute_guarded` is the only writer; `phase_exit` calls `abort_started_operations_for_task` and waits (a second writer is rejected by the projector and hides the real failure).
- Passing the wrong `outcome` to `shutdown`: the schema requires one on every `closed`/`failed` transition and §5A row H8 fixes it per task end (pause is `abandoned`, not `cancelled`).
- Asserting a fixed order of `S15` and `T21` in tests: they race (§5A); assert the partial order.
- Ignoring a session that closes while `awaiting_permission` after a cancelled turn: P4-3 writes S16/S23, the watcher still has to write T14 if the task is `running`.
- Resuming automatically after restart: recovery's `interrupted{host_crashed}` waits for the user in alpha.
- Forgetting the verifying checkpoint: P7-2 refuses to push ("untested commit").
- Using one global nonce: a reviewer could replay an old block it found on disk.

## 12. Reviewer checklist

- [ ] Is every `task.state_changed` produced through the single helper that calls `check_task_transition`?
- [ ] Can any agent output (text, tool call, permission request) cause T13, T28, T29 or anything in `pr`? It must not.
- [ ] Does `phase_exit` follow P4-3 §5A row H0 (abort started operations → cancel approvals → task transition → `shutdown(outcome)`), never write `outcome_unknown{killed}` itself, and pass the outcome of row H8?
- [ ] Is the interruption reason `adapter_disconnected` only for `ProcessExited` and `session_unavailable` for protocol errors, and is a user pause from `preparing` (T09) written by `orchestrator`?
- [ ] Is the reviewer fresh, role `review`, read-only by policy, and given only the allowed brief?
- [ ] Does `parse_verdict` require exactly one block with the current nonce and `end_turn`?
- [ ] Are `stop_reason` limits applied to both check failures and review rounds?
- [ ] Do the base and verifying checkpoints get written (P7-1 diff base, P7-2 tested commit)?
- [ ] Are the real-agent E2E tests listed with their last passing commit?
