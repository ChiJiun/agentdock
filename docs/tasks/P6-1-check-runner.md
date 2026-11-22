# P6-1: Controlled check runner (user-configured test commands, exit codes, redacted logs, check events)

> **繁中摘要**：分兩個 PR。**P6-1a**（integrations）：只執行使用者寫在 app data `checks.json` 的 check（**不從 repo／worktree 讀設定**），用 P3-2 的程序監督在 task 自己的 worktree 執行（絕對路徑＋argv、環境白名單、整棵程序樹管理、stdin 立刻關閉）；結果只由 exit code 與 runner 觀察決定（0→passed、非 0→failed、無法啟動／逾時／無 exit code／執行期間 HEAD 被改→errored、取消→cancelled）。**P6-1b**（orchestrator）：`check.started` 在 spawn **之前** commit，log 經 redaction 存成 artifact，任何錯誤都要寫 `check.finished`；沒有任何 API 接受外部（前端或 agent）送來的 check 結果。模型等級：P6-1a 一般模型；P6-1b 一般模型實作＋強模型審查。

Issues: #10, #47 (minimal part only) | Gate (#51): G6 (controlled runner runs tests; agents cannot self-report PASS), G8 (fixing failing tests) | Model tier: **P6-1a standard model; P6-1b standard model implements, strong model reviews**

Two PRs:

- **P6-1a**: `checks` module in `agentdock-integrations` (config file, execution, result classification); does not touch the event store.
- **P6-1b**: `checks` module in `agentdock-orchestrator` (writes `check.started` / `check.finished`, stores logs as artifacts, feeds `local_checks_passed`).

## 1. Goal and non-goals

Goals:

- Run only checks **the user wrote in AgentDock's settings** (e.g. `cargo test`, `npm test`). The config lives in the app data directory and is **never read from the repo or worktree**: the agent can change any file in the worktree, so reading config there lets the agent decide what runs and whether it runs (ADR-0002 APR-9: agent-editable config may only add restrictions).
- Run in the task's own worktree via `agentdock-process` (P3-2): absolute path + argv, env allowlist, whole process tree contained (Job Object on Windows, process group on Unix), stdin closed immediately.
- The result is decided only by the exit code and the runner's own observations:
  - exit 0 → `passed`
  - non-zero exit → `failed`
  - cannot start, timeout, terminated by the OS (`code == None`), worktree HEAD changed during the run → `errored`
  - user cancel → `cancelled`
  - unfinished at crash → `outcome_unknown` (written by P2-6 recovery, not this packet)
- stdout/stderr pass through the P2-7 `Redactor` and are stored as an artifact; events hold only an `ArtifactRef`.
- Write `check.started` (committed **before** spawn) and `check.finished`; actor always `orchestrator`.
- UI mapping (#51's PASS/FAIL/BLOCKED): `passed` → PASS, `failed` → FAIL, `errored`/`cancelled`/`outcome_unknown` → BLOCKED. The mapping lives in P6-2; this packet only produces contract state values.

Non-goals:

- CI checks (`origin: ci`, P8-4).
- Parsing "tests passed" from agent output: **never**. Agent self-reports are not checks (UX-67).
- Check settings screen (alpha uses hand-written JSON plus docs; the screen comes after alpha).
- Caching, parallel checks, remote execution (#47/#48).
- Auto-generating checks from the repo's `package.json` / `Cargo.toml` (could later become a "suggestion" the user must confirm before it is written to app data).

## 2. Prerequisites and parallel work

- P6-1a prerequisites: P3-2 (`agentdock-process`), P4-1 (`WorkspaceScope`), P5-1 (`Git`).
- P6-1b prerequisites: P6-1a, P2-4 (store), P2-6 (recovery ends running checks as `outcome_unknown`), P2-7 (`Redactor`), P3-5b (`ArtifactStore`), P5-3 (`task_scope`).
- Parallel: P7-1, P7-3, P4-4. P6-2 and P8-3 use this packet.

## 3. Files

P6-1a new:

- `crates/agentdock-integrations/src/checks/mod.rs` (exports)
- `crates/agentdock-integrations/src/checks/config.rs` (`CheckFile`, `CheckDef`, validation)
- `crates/agentdock-integrations/src/checks/runner.rs` (`run_check`, `CheckRun`)
- `crates/agentdock-integrations/src/bin/agentdock-test-check.rs` (test helper, see §6; `[[bin]]` with `test = false`, not shipped)
- `crates/agentdock-integrations/tests/check_runner.rs`
- `docs/dev/checks.md` (config location, examples, how to run `npm` on Windows)

P6-1a modified: `crates/agentdock-integrations/src/lib.rs`, `crates/agentdock-integrations/Cargo.toml` (`tokio-util` for `CancellationToken`).

P6-1b new:

- `crates/agentdock-orchestrator/src/checks.rs` (`CheckService`)
- `crates/agentdock-orchestrator/tests/check_events.rs`

P6-1b modified: `crates/agentdock-orchestrator/src/lib.rs`.

## 4. Public types and signatures

```rust
// crates/agentdock-integrations/src/checks/config.rs
use std::path::PathBuf;

pub const MAX_CHECKS_PER_PROJECT: usize = 16;
pub const MAX_TIMEOUT_SECS: u64 = 3600;
pub const DEFAULT_TIMEOUT_SECS: u64 = 900;

/// <app data>/checks.json. Never read from a repository or worktree.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct CheckFile {
    pub version: u32,                                   // must be 1
    /// Key: ProjectId string ("prj_" + 26 Crockford chars).
    pub projects: std::collections::BTreeMap<String, Vec<CheckDef>>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct CheckDef {
    pub name: String,                 // 1..=256 chars, unique within the project, no control chars
    pub program: PathBuf,             // absolute; on Windows must not end in .cmd/.bat/.ps1 (case-insensitive)
    pub args: Vec<String>,            // <= 64 items, each <= 4096 chars, no NUL
    /// Relative to the task worktree root, '/' separators, no "..", default ".".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,    // 1..=3600, default 900
    /// Non-secret variables only, e.g. ("CI","1"). See FORBIDDEN_ENV for rejected names.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_env: Vec<(String, String)>,
}

/// Rejected in extra_env (ASCII case-insensitive). Anything that changes Git/GitHub targets,
/// carries credentials, or overrides the executable search path.
pub const FORBIDDEN_ENV: &[&str] = &[
    "PATH", "PATHEXT", "COMSPEC", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
    "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GH_HOST", "GH_REPO", "GH_TOKEN", "GITHUB_TOKEN",
];
/// Also rejected: any name containing TOKEN, SECRET, PASSWORD, API_KEY, or starting with GIT_CONFIG_.

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CheckConfigError {
    #[error("unsupported checks.json version {0}")] Version(u32),
    #[error("check #{index}: {reason}")] Invalid { index: usize, reason: &'static str },
    #[error("project {0}: more than 16 checks")] TooMany(String),
    #[error("project {0}: duplicate check name")] DuplicateName(String),
    #[error("checks.json is not valid JSON")] Json,
}

impl CheckFile {
    /// Missing file → Ok(empty). Invalid file → Err (never partially loaded).
    pub fn load(path: &std::path::Path) -> Result<CheckFile, CheckConfigError>;
    pub fn for_project(&self, project_id: &str) -> &[CheckDef];
}
impl CheckDef {
    pub fn validate(&self) -> Result<(), &'static str>;
    pub fn timeout(&self) -> std::time::Duration;
}
```

```rust
// crates/agentdock-integrations/src/checks/runner.rs
use std::time::Duration;

pub const STDOUT_LIMIT: usize = 1024 * 1024;     // keep the LAST 1 MiB of stdout
// stderr: AgentProcess::stderr_tail() already keeps the last 64 KiB.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunState { Passed, Failed, Errored, Cancelled }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorReason {
    Spawn(String),          // ProcessError Display (never the command line)
    Timeout,
    KilledWithoutCode,      // wait() returned Ok(None)
    WorktreeChanged,        // HEAD differs before/after the run
    ScopeDenied,            // cwd failed WorkspaceScope::check
    GitUnavailable,         // could not read HEAD before the run
}

#[derive(Debug, Clone)]
pub struct CheckRun {
    pub state: RunState,
    pub exit_code: Option<i32>,
    pub duration: Duration,
    pub error: Option<ErrorReason>,
    pub head_before: Option<String>,   // 40-hex
    pub head_after: Option<String>,
    /// NOT redacted. The caller must redact before storing or showing (P6-1b).
    pub stdout: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_tail: String,
}

pub struct CheckContext<'a> {
    pub worktree_root: &'a std::path::Path,                         // from task_scope (P5-3), already probed
    pub scope: &'a agentdock_policy::path_scope::WorkspaceScope,   // exactly that worktree
    pub git: &'a crate::git::Git,                                   // P5-1; HEAD is read with cwd = worktree root
    pub host_env: &'a [(String, String)],                           // std::env::vars() in production
    pub cancel: tokio_util::sync::CancellationToken,
}

/// Never panics; every failure becomes a CheckRun with state Errored.
pub async fn run_check(def: &CheckDef, ctx: CheckContext<'_>) -> CheckRun;
```

```rust
// crates/agentdock-orchestrator/src/checks.rs
pub struct CheckService { /* Arc<Store>, Arc<ArtifactStore>, Redactor, Arc<WorktreeManager>, Arc<Semaphore(2)> */ }

#[derive(Debug, thiserror::Error)]
pub enum CheckServiceError {
    #[error("task is not in verifying")] WrongState,
    #[error("unknown check name")] UnknownCheck,
    #[error("a check is already running for this task")] Busy,
    #[error("worktree not ready: {0:?}")] WorktreeNotReady(agentdock_integrations::worktree::WorktreeStatus),
    #[error(transparent)] Store(#[from] agentdock_store::Error),
}

impl CheckService {
    /// Writes check.started, runs, writes check.finished. Returns the finished payload.
    /// Only orchestrator code and the user-facing "Run checks" command call this; there is
    /// no API that accepts a check result from the frontend or an agent.
    pub async fn run(&self, task_id: &TaskId, check_name: &str,
        cancel: tokio_util::sync::CancellationToken)
        -> Result<agentdock_core::payload::CheckFinishedPayload, CheckServiceError>;
    /// Runs every configured check of the task's project in order; stops at the first non-passed
    /// one only if `stop_on_failure` (default true).
    pub async fn run_all(&self, task_id: &TaskId, stop_on_failure: bool,
        cancel: tokio_util::sync::CancellationToken)
        -> Result<Vec<agentdock_core::payload::CheckFinishedPayload>, CheckServiceError>;
}
```

## 5. Implementation steps

### P6-1a

1. Write the §6 config unit tests and `check_runner.rs`.
2. `CheckDef::validate`: check every rule in the §4 comments. For `cwd`, use P4-1's `lexical_check(cwd, cfg!(windows))`, and additionally reject absolute paths and `..`. For the shell-shim check on `program`, call P3-2's existing function (do not write a second copy).
3. `CheckFile::load`: missing file → empty config; `serde_json` failure → `Json` (do not return serde's message, which could carry file content into logs); any invalid entry rejects the whole file.
4. `run_check`:
   1. `root = ctx.scope.check(&worktree_root.to_string_lossy(), None, PathIntent::Cwd)` and `cwd = ctx.scope.check(&worktree_root.join(def.cwd or ".").to_string_lossy(), None, PathIntent::Cwd)` (P4-1); if either is not `Allow(ScopedPath)` → `Errored(ScopeDenied)`, **no spawn**.
   2. `head_before = git.run_ok(&root_scoped, &["rev-parse", "HEAD"], 30s)` (P5-1 `run_ok` takes only `ScopedPath`); failure → `Errored(GitUnavailable)`.
   3. Build `AgentCommand { program, args, cwd: cwd_scoped.as_path().to_path_buf(), auth_env_names: vec![], extra_env: def.extra_env + [("NO_COLOR","1")] }`. Checks forward **no credential env vars**.
   4. `AgentProcess::spawn`; failure → `Errored(Spawn(e.to_string()))`.
   5. `take_stdio()`: drop stdin **immediately** (so a test waiting for input cannot hang); read stdout in a task into a ring buffer keeping the last `STDOUT_LIMIT` bytes; set `stdout_truncated` when exceeded.
   6. `tokio::select!` over `wait()`, `sleep(def.timeout())`, `cancel.cancelled()`:
      - timeout → `shutdown(ShutdownTimeouts { stdin_grace: 0, term_grace: 3s })` → `Errored(Timeout)`.
      - cancel → same shutdown → `Cancelled`.
      - `wait` finished → **still call `shutdown`** to kill leftover descendants (test runners often leave watchers).
   7. Wait for the stdout task (max 2 s; past that, drop remaining output and mark truncated).
   8. `head_after != head_before` → `Errored(WorktreeChanged)` (someone committed during the run, so the result maps to no single commit).
   9. exit 0 → `Passed`; `Some(n)` → `Failed`; `None` → `Errored(KilledWithoutCode)`.
5. `docs/dev/checks.md`: `checks.json` examples. Linux: `"program": "/usr/bin/npm"` is fine if it is a real executable or script with a shebang (resolve with `command -v npm` and use the absolute path). Windows: `npm` is `npm.cmd` and is rejected; write `"program": "C:\\Program Files\\nodejs\\node.exe", "args": ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", "test"]`. `cargo` is an executable; write the expanded absolute path of `~/.cargo/bin/cargo` (the config file does not expand env vars).

### P6-1b

1. Write `check_events.rs`.
2. `CheckService::run`:
   1. Read the task projection: state must be `verifying`, else `WrongState` (the contract's `local_checks_passed` counts only checks after entering verifying).
   2. One check per task at a time (`HashMap<TaskId, ()>` + mutex) → else `Busy`; global `Semaphore(2)`.
   3. `worktrees.task_scope(plan)` (P5-3, **re-probe every time**); not `Ready` → `WorktreeNotReady`.
   4. New `CheckId`; one store transaction appends `check.started { check_id, name, origin: local, command: [redact(program), redact(args)...], cwd }`, actor `orchestrator`. **Spawn only after commit** (global invariant 2).
   5. `run_check`.
   6. Log layout: header `# head_before / head_after / exit_code / error / stdout_truncated`, then `## stdout`, then `## stderr`; run the whole text through `Redactor::redact_text`; `artifacts.put(bytes, "log")`.
   7. Append `check.finished { check_id, state, exit_code, duration_ms, artifact }`, actor `orchestrator`.
   8. Any error after step 4 (including artifact write failure) must still write `check.finished{state: errored}`; never leave a check unfinished. If the store write itself fails, recovery handles it (next start ends it as `outcome_unknown`).
3. State transitions are not here: P8-3 reads the projection's `local_checks` facts and decides T22/T23.

## 6. Tests to write first

`agentdock-test-check` helper (std only) behaves by its first argument:

| Argument | Behavior |
| --- | --- |
| `exit <n>` | exit immediately with `n` |
| `print <bytes>` | print that many `x` bytes, exit 0 |
| `bad-utf8` | print `0xff 0xfe` plus normal text, exit 0 |
| `sleep <secs>` | sleep, then exit 0 |
| `spawn-child <pidfile>` | start itself with `sleep 600` via `std::process::Command`, write the child pid to pidfile, sleep 600 |
| `spawn-child-exit <pidfile>` | same, but the parent exits 0 immediately (leaving a descendant) |
| `read-stdin` | read stdin to EOF, exit 0 |
| `print-env <NAME>` | print that variable's value (or `<unset>`) |
| `print-secret` | print `token=ghp_` + 36 `0`s |
| `exec <program> <args...>` | run the program via `std::process::Command` and wait (used to `git commit` during a run) |

Process liveness in tests: `cfg(unix)` `libc::kill(pid, 0)` (or `/proc/<pid>` existence on Linux); `cfg(windows)` `OpenProcess` + `GetExitCodeProcess` (reuse P3-2's test helper).

`config.rs` unit tests:

| Test | Expected |
| --- | --- |
| `missing_file_is_empty` | nonexistent path → `Ok`; every project has an empty list |
| `valid_file_loads` | two projects, two checks each → loaded correctly |
| `rejects_relative_program` | `program: "cargo"` → `Invalid` |
| `rejects_shell_shim` (`cfg(windows)`) | `C:\x\npm.cmd`, `C:\x\A.BAT`, `C:\x\a.ps1` → `Invalid` |
| `rejects_bad_cwd` | `../x`, `/x`, `a/../../b` (all OSes); plus `C:\x`, `\\server\share` under `cfg(windows)` → `Invalid` |
| `rejects_timeout_out_of_range` | `0`, `3601` → `Invalid` |
| `rejects_forbidden_env` | `PATH`, `path`, `GIT_DIR`, `MY_API_KEY`, `GIT_CONFIG_COUNT`, `NODE_OPTIONS`, `LD_PRELOAD` → `Invalid` |
| `rejects_too_many_and_duplicates` | 17 entries → `TooMany`; two with the same name → `DuplicateName` |
| `one_bad_entry_rejects_whole_file` | third entry invalid → `Err`, first two not returned |
| `json_error_hides_content` | broken JSON containing `ghp_000…` → error message does not contain it |

`tests/check_runner.rs` (temp repo via P5-1's `git init` helper; path contains a space and CJK):

| Test | Expected |
| --- | --- |
| `exit_zero_is_passed` | `exit 0` → `Passed`, `exit_code == Some(0)` |
| `nonzero_exit_is_failed` | `exit 3` → `Failed`, `Some(3)` |
| `missing_program_is_errored_not_failed` | nonexistent absolute path → `Errored(Spawn(_))`, `exit_code == None` |
| `timeout_is_errored_and_tree_killed` | `spawn-child`, timeout 2 s → `Errored(Timeout)`; the pidfile child is gone within 5 s |
| `cancel_is_cancelled_and_tree_killed` | `cancel.cancel()` after 1 s → `Cancelled`; child gone |
| `leftover_descendants_killed_after_exit` | `spawn-child-exit` → `Passed`; child gone within 5 s |
| `stdin_closed_immediately` | `read-stdin`, timeout 10 s → `Passed` (no hang) |
| `stdout_keeps_last_mib` | `print 3145728` → `stdout.len() == STDOUT_LIMIT`, `stdout_truncated` |
| `non_utf8_output_does_not_fail` | `bad-utf8` → `Passed` |
| `cwd_outside_scope_not_spawned` | scope contains only another folder → `Errored(ScopeDenied)`; `duration < 1s`; no process started (an `exec` marker file does not exist) |
| `env_not_inherited` | test process sets `AGENTDOCK_TEST_LEAK=leak-value-123` → `print-env AGENTDOCK_TEST_LEAK` prints `<unset>` |
| `extra_env_passed` | `extra_env: [("CI","1")]` → `print-env CI` prints `1` |
| `head_change_during_run_is_errored` | `exec <git> commit --allow-empty -m x` (absolute git path from P5-1 discovery) → `Errored(WorktreeChanged)` |

`crates/agentdock-orchestrator/tests/check_events.rs` (temp store + temp repo + P5-2 worktree; task advanced to `verifying` first):

| Test | Expected |
| --- | --- |
| `started_committed_before_spawn` | the check uses `exec` to run a tiny reader that writes the store head seq into a marker file → the marker's seq already includes `check.started` |
| `events_in_order_with_orchestrator_actor` | one `run` → `check.started`, `check.finished`, both actor `orchestrator`, same `check_id` |
| `command_is_argv_and_redacted` | args containing `ghp_000…` → that element masked in `command`; `cwd` is relative |
| `log_artifact_is_redacted` | `print-secret` → artifact file and event JSON contain no `ghp_000…` |
| `failed_check_blocks_local_checks_passed` | run `exit 1` → projection fact `local_checks == {started: 1, all_passed: false}`; `check_task_transition(T23)` rejected |
| `passed_check_allows_t23` | run `exit 0` → `{1, true}`; T23 allowed |
| `checks_before_verifying_do_not_count` | `run` while the task is `running` → `WrongState`, no events |
| `adapter_cannot_write_check_result` | append `check.finished` directly with actor `adapter` → store rejects (P2-5 projector actor rule; mutation `r4_adapter_reports_check_result`) |
| `spawn_failure_still_finishes` | nonexistent program → `check.started` + `check.finished{errored}`, no exit_code |
| `crash_mid_check_becomes_outcome_unknown` | after `check.started`, drop the service (simulated crash) → reopen store, run P2-6 recovery → `check.finished{outcome_unknown}`, actor `recovery` |
| `busy_task_rejects_second_run` | second `run` while `sleep 5` is running → `Busy` |
| `relocated_worktree_rejected` | worktree folder replaced by a symlink/junction (as in P5-3) → `WorktreeNotReady`, no events |

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-integrations checks                                     # 10 config unit tests pass (9 on Linux; shell-shim test is cfg(windows))
cargo test -p agentdock-integrations --test check_runner -- --test-threads=1    # 13 pass
cargo test -p agentdock-orchestrator --test check_events -- --test-threads=1    # 12 pass
cargo clippy -p agentdock-integrations -p agentdock-orchestrator --all-targets -- -D warnings
```

Windows-only (CI `rust-windows`): `rejects_shell_shim` and the Job Object tree-kill paths of `timeout_is_errored_and_tree_killed` / `leftover_descendants_killed_after_exit` run on `windows-latest`; check the job log for them.

## 8. Spec references and porting sources

All line numbers refer to main `c9e33cf`.

- `docs/contracts/schema/agentdock.schema.json` lines 412–416 (`CheckState`, `CheckOrigin`), lines 631–650 (`Check`: `command` is redacted argv, not a shell string), lines 1093–1116 (`CheckStartedPayload`, `CheckFinishedPayload`).
- `docs/contracts/events.md` line 73 (check events; results written only by orchestrator/integration; `outcome_unknown` only by recovery).
- `docs/contracts/state-machines.md` lines 116–117 (T22, T23), line 173 (`local_checks_passed`).
- `docs/contracts/checkpoint-and-replay.md` line 62 (recovery: running check → `outcome_unknown`).
- ADR-0002 line 129 APR-9 (agent-editable config may only add restrictions).
- `docs/ux/acceptance-criteria.md` line 98 UX-67 (list only commands the workbench actually ran; agent claims are not checks).
- Issue #10 Requirements item 3 (record exit status); Issue #51 gate 6.
- Behavior and test-scenario references (do not copy code): PR #29, SHA `c57b824`, `apps/runtime/task-workflow.test.mjs` line 51 (operator evidence cannot be impersonated), line 132 (gate requires passing test evidence), line 164 (previous-round evidence cannot satisfy the next round → "only checks after entering verifying count"), line 230 (manually marking passed is still unverified). This packet's answer: there is no API that accepts a check result at all.

## 9. Dependencies

| crate | Version | Status |
| --- | --- | --- |
| `tokio-util` | 0.7.x (MIT) | needs audit (official tokio crate; skip if P3-5 already added it) |
| `libc` (dev, `cfg(unix)`) | reuse P3-2's | — |

Everything else reused: `agentdock-process`, `agentdock-policy`, `serde`, `serde_json`, `thiserror`, `tokio`.

## 10. Model tier

- P6-1a: standard model (all rules are in tables).
- P6-1b: standard model implements; **strong model reviews** event order (commit before spawn), "every error still finishes the check", and the absence of any entry point that accepts external results. Any one mistake lets an agent forge PASS.

## 11. Common mistakes and pitfalls

- Reading `.agentdock/checks.json` or `package.json` scripts from the worktree: the agent can change `test` to `exit 0`. Read app data only.
- `cmd /C npm test` or `sh -c "npm test"`: violates the no-shell rule and makes quotes and `&`/`;` injection points. Use an absolute executable with argv.
- Returning as soon as `wait()` returns: leftover watchers/dev servers keep ports and file locks, and later worktree operations fail. Always `shutdown`.
- No stdout cap: hundreds of MB of test output exhausts memory. Keep the last 1 MiB (failures are usually at the end).
- Interleaving stdout and stderr: ordering across two pipes is not guaranteed; store separately with a clear header.
- Mixing `failed` and `errored`: `errored` (did not run, timed out) does not mean the code is wrong; P8-3 must not treat it as a "fix it, agent" loop; UI shows BLOCKED.
- Agent still editing files during the run: P8-3 enters verifying only after the agent's turn ends. This packet checks only HEAD; working-tree content changes are not detected (listed in README "Not yet covered").
- Full command lines in errors or events: redact `command` element by element; `Spawn` errors carry only the error kind.
- Missing `check.finished`: every return path (including `?`) must go through the "write finished" epilogue. Recommended: an inner function returns `CheckRun`; the outer function writes events in one place.

## 12. Reviewer checklist

- [ ] Is `checks.json` read only from app data, and is the whole file rejected on any invalid entry?
- [ ] Is `check.started` committed before spawn, and does every path after it write `check.finished`?
- [ ] Is there any API (Tauri command, ACP handler, orchestrator method) that accepts a check result from outside?
- [ ] Are descendants killed after normal exit, timeout and cancel?
- [ ] Are command, log and errors redacted before being stored or shown?
- [ ] Do `failed` and `errored` stay distinct all the way to the event?
