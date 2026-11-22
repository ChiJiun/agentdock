# P3-2: Agent process supervision (Windows Job Object, Unix process group, graceful shutdown, stderr drain)

> **繁中摘要**：建立 crate `agentdock-process`，提供 `AgentProcess`：啟動 ACP agent 子程序，並保證在使用者取消、agent 當掉、AgentDock 被強制結束時，**整棵程序樹**都會結束。Windows 用 `process-wrap` 的 `JobObject` + `KillOnDrop`（缺 `KillOnDrop` 就不會設定 KILL_ON_JOB_CLOSE）；Unix 用 process group + `KillOnDrop`，Linux 上也要能編譯並跑跨平台測試。優雅關閉：關 stdin → 等 1.5 秒 → 結束整棵樹 → 再等 3 秒。stderr 持續排空到 64 KiB 環形緩衝、不寫入事件。環境變數 `env_clear()` 後只放白名單與 adapter 宣告的 auth 變數名稱。執行檔必須是絕對路徑，Windows 拒絕 `.cmd`／`.bat`／`.ps1`。同時完成 spike S2 紀錄。模型等級：強模型實作＋強模型審查。

Issues: #6, #8 | Gate (#51): G2, G8 (no orphan processes after interruption) | Model tier: **strong model implements and reviews**

## 1. Goal and non-goals

Goal: crate `agentdock-process` with `AgentProcess`, which starts an ACP agent child and guarantees its **whole process tree** ends when: the user cancels/closes, the agent crashes, or AgentDock itself is killed (`taskkill /F`, Task Manager, SIGKILL). This also completes route (a) of ADR-0002 spike S2 (`process-wrap`).

- Windows: `process-wrap`'s `JobObject` + `KillOnDrop`. `JobObject` adds `CREATE_SUSPENDED`, assigns the process to the Job, then resumes it (verified in `process-wrap` 10.0.1 `src/tokio/job_object.rs` lines 73–129 and `src/windows.rs` lines 58–62). **`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is set only when the `KillOnDrop` wrapper is also present** (`job_object.rs` lines 85–88, `windows.rs` lines 118–155). Without `KillOnDrop`, grandchildren survive when AgentDock is killed.
- Unix (the implementer's Linux VM and CI `rust-linux`): `ProcessGroup::leader()` + `KillOnDrop`.
- Graceful shutdown: close stdin → wait 1.5 s → kill the whole Job (Windows) / process group (Unix) → wait 3 s. Timings follow PR #25 `DEFAULT_LIMITS`.
- stderr drained continuously into an in-memory ring buffer (last 64 KiB), **never written to events or files** (may contain credentials). Only on startup failure, the last 2 KiB, after P2-7 redaction, goes into the error message.
- Environment: `env_clear()`, then only an allow-list plus the auth variable names the adapter declares (values never logged).
- Executable: must be absolute; on Windows reject `.cmd` / `.bat` / `.ps1` (PR #25 `adapters.mjs` lines 15–21 decision; P3-6 resolves npm shims into `node.exe <script>`).

Non-goals: the ACP protocol (P3-4), adapter configuration (P3-6), CPU / priority limits (ADR-0002 line 37 nested job and CPU cap are after alpha; listed as not covered in the README).

## 2. Prerequisites and parallel work

- Prerequisites: P1-1. Windows behavior is only proven by CI `rust-windows` (P1-3) or the owner's Windows machine; if P1-3 has not merged, ask the owner to run the Windows tests locally and paste the output into the PR.
- Parallel: P3-1, P3-3, P2-*, P4-*, P5-1.

## 3. Files

New:

- `crates/agentdock-process/Cargo.toml`
- `crates/agentdock-process/src/lib.rs`
- `crates/agentdock-process/src/env.rs`
- `crates/agentdock-process/src/stderr_tail.rs`
- `crates/agentdock-process/tests/process_tree.rs`
- `crates/agentdock-process/src/bin/agentdock-test-spawn-tree.rs` (test helper: starts a grandchild and prints PIDs)
- `crates/agentdock-process/src/bin/agentdock-test-supervisor-host.rs` (test helper: plays "AgentDock", starts spawn-tree, waits to be killed)
- `docs/research/acp-sdk-s2.md` (S2 record)

Both helpers are `[[bin]]` with `test = false`, `doc = false`, so integration tests can use `env!("CARGO_BIN_EXE_agentdock-test-spawn-tree")`. The Tauri bundle only ships `agentdock-desktop`, so they are not installed.

Modified: root `Cargo.toml` (members).

This crate is shared by `agentdock-acp` (P3-4 starts agents) and `agentdock-integrations` (P6-1 runs checks), so it is its own crate.

## 4. Public types and signatures

```rust
// crates/agentdock-process/src/lib.rs
use std::{path::PathBuf, time::Duration};

#[derive(Debug, Clone)]
pub struct AgentCommand {
    pub program: PathBuf,            // absolute; on Windows must not end in .cmd/.bat/.ps1 (case-insensitive)
    pub args: Vec<String>,           // each <= 4096 chars, no NUL
    pub cwd: PathBuf,                // caller passes a path already checked by agentdock-policy (P4-1)
    pub auth_env_names: Vec<String>, // names only, ^[A-Z_][A-Z0-9_]{0,63}$; values copied from host env
    pub extra_env: Vec<(String, String)>, // non-secret, e.g. NO_COLOR=1
}

#[derive(Debug, Clone, Copy)]
pub struct ShutdownTimeouts { pub stdin_grace: Duration, pub term_grace: Duration }
impl Default for ShutdownTimeouts { /* 1500 ms, 3000 ms */ }

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExitKind {
    Exited { code: Option<i32> },     // agent ended on its own
    ClosedGracefully,                 // exited after stdin close within grace
    Terminated,                       // job/group was killed
}

#[derive(Debug, thiserror::Error)]
pub enum ProcessError {
    #[error("agent executable must be an absolute path")]
    RelativeProgram,
    #[error("agent executable is a shell shim ({ext}); configure the real executable instead")]
    ShellShim { ext: String },
    #[error("invalid environment variable name")]
    BadEnvName,
    #[error("invalid argument")]
    BadArgument,
    #[error("could not start agent: {kind:?}")]  // never include the full command line
    Spawn { kind: std::io::ErrorKind },
    #[error("process supervision unavailable: {0}")]
    Supervision(String),
}

pub struct AgentProcess { /* Box<dyn process_wrap::tokio::ChildWrapper>, stderr task, tail */ }

impl AgentProcess {
    /// Validates, then spawns with stdin/stdout/stderr piped, window hidden, inside a kill-on-close Job (Windows)
    /// or a new process group (Unix). Starts the stderr drain task before returning.
    pub fn spawn(cmd: &AgentCommand) -> Result<Self, ProcessError>;
    pub fn pid(&self) -> Option<u32>;
    /// Take the pipes once (for P3-1 framed_lines / line_sink). Second call returns None.
    pub fn take_stdio(&mut self) -> Option<(tokio::process::ChildStdin, tokio::process::ChildStdout)>;
    /// Last <= 64 KiB of stderr, lossy UTF-8. Caller must redact before showing or storing.
    pub fn stderr_tail(&self) -> String;
    /// Resolves when the direct child exits (descendants may live on; use shutdown for the tree).
    pub async fn wait(&mut self) -> std::io::Result<Option<i32>>;
    /// Orderly: drop stdin, wait stdin_grace, kill the whole tree, wait term_grace. Idempotent.
    pub async fn shutdown(&mut self, t: ShutdownTimeouts) -> ExitKind;
}
// Drop: if shutdown() was not awaited, KillOnDrop (+ KILL_ON_JOB_CLOSE on Windows) ends the tree.

// crates/agentdock-process/src/env.rs
pub const ENV_ALLOWLIST: &[&str] = &[
    "PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME", "USER", "USERNAME",
    "APPDATA", "LOCALAPPDATA", "ProgramData", "LANG", "LC_ALL", "TERM",
];
/// Builds the child environment from `host` (pass std::env::vars() in production, a list in tests).
pub fn child_env(host: &[(String, String)], auth_env_names: &[String], extra: &[(String, String)])
    -> Result<Vec<(String, String)>, ProcessError>;
```

Windows environment names are case-insensitive: under `cfg(windows)`, `child_env` matches the allow-list ASCII case-insensitively and keeps the host's original spelling. Under `cfg(unix)` matching is exact.

## 5. Implementation steps

1. Write the §6 tests.
2. Validate `AgentCommand` at the start of `spawn`:
   - `program.is_absolute()`, else `RelativeProgram`; under `cfg(windows)` an extension (ASCII-lowercased) of `cmd`, `bat`, `ps1` → `ShellShim`.
   - An argument with `\0` or longer than 4096 characters → `BadArgument`.
3. Build `tokio::process::Command`: `env_clear()`, `envs(child_env(...))`, `current_dir(cwd)`, three pipes, `kill_on_drop(true)`. Wrap in `process_wrap::tokio::CommandWrap::from(cmd)`.
4. `cfg(windows)`: `.wrap(CreationFlags(CREATE_NO_WINDOW))`, `.wrap(JobObject)`, `.wrap(KillOnDrop)`. `cfg(unix)`: `.wrap(ProcessGroup::leader())`, `.wrap(KillOnDrop)`. On failure return `Spawn { kind }` or `Supervision` (`ErrorKind::Unsupported` means no process handle).
   - `CreationFlags` needs `windows::Win32::System::Threading::{CREATE_NO_WINDOW, PROCESS_CREATION_FLAGS}`; the `windows` crate version must equal the **0.62.2** that `process-wrap` 10.0.1 uses (`cargo tree -d` shows no duplicate).
5. stderr: `tokio::spawn` a task reading 8 KiB at a time into `StderrTail` (`Mutex<VecDeque<u8>>`, cap 65,536 bytes, oldest dropped). Ends on EOF or error. **Start it before `spawn` returns.**
6. `shutdown`:
   1. `take` and drop stdin (if `take_stdio` already took it, the caller must drop it first; document this).
   2. `tokio::time::timeout(stdin_grace, child.wait())`: exited → `ClosedGracefully`, but **still** call `start_kill()` once to collect leftover grandchildren (Windows `JobObjectChild::start_kill` terminates the whole Job; Unix kills the group; both work when the direct child already exited).
   3. Timeout → `start_kill()` (Windows: TerminateJobObject; Unix: SIGKILL to the group. Sending SIGTERM first would need `nix`; alpha kills directly and documents it) → `timeout(term_grace, wait())` → `Terminated`.
   4. An `AtomicBool` makes a second call return the first result immediately.
7. `agentdock-test-spawn-tree`: without arguments, starts itself with `--child` via `std::env::current_exe()` (`std::process::Command`, null stdio), prints `CHILD_PID=<pid>` and `SELF_PID=<pid>` to stdout, flushes, sleeps 600 s. With `--child`, only sleeps 600 s. Extra modes: `--stderr-flood` (write 10 MiB to stderr, then print `DONE` on stdout), `--print-cwd`, `--exit-on-eof` (read stdin to EOF, then exit 0).
8. `agentdock-test-supervisor-host`: starts spawn-tree (path in `argv[1]`) with `AgentProcess::spawn`, copies its stdout to its own stdout, then sleeps 600 s waiting to be killed.
9. `docs/research/acp-sdk-s2.md`: date, OS versions tested (Linux `uname -a`; Windows from the CI log), `process-wrap` version, each §6 test result per platform; mark the **real agent** items (`claude-agent-acp`, `codex-acp`) as "done by P3-6's opt-in E2E".

## 6. Tests to write first

`env.rs` unit tests:

```rust
#[test] fn drops_everything_not_allowlisted() {
    let host = vec![("PATH".into(), "/usr/bin".into()), ("GITHUB_TOKEN".into(), "x".into()), ("AWS_SECRET_ACCESS_KEY".into(), "y".into())];
    let env = child_env(&host, &[], &[]).unwrap();
    assert_eq!(env, vec![("PATH".to_string(), "/usr/bin".to_string())]);
}
#[test] fn auth_env_names_are_passed_through() {
    let host = vec![("ANTHROPIC_API_KEY".into(), "k".into())];
    let env = child_env(&host, &["ANTHROPIC_API_KEY".into()], &[]).unwrap();
    assert_eq!(env.len(), 1);
}
#[test] fn rejects_bad_env_names() {
    assert!(matches!(child_env(&[], &["bad-name".into()], &[]), Err(ProcessError::BadEnvName)));
    assert!(matches!(child_env(&[], &["A=B".into()], &[]), Err(ProcessError::BadEnvName)));
}
#[cfg(windows)] #[test] fn allowlist_is_case_insensitive_on_windows() {
    let host = vec![("Path".into(), "C:\\bin".into())];
    assert_eq!(child_env(&host, &[], &[]).unwrap(), vec![("Path".to_string(), "C:\\bin".to_string())]);
}
```

`tests/process_tree.rs` (tokio). Paths come from `env!("CARGO_BIN_EXE_agentdock-test-spawn-tree")` and `env!("CARGO_BIN_EXE_agentdock-test-supervisor-host")`:

| Test | Platform | How | Expected |
| --- | --- | --- | --- |
| `rejects_relative_program` | all | `program = "node"` | `Err(RelativeProgram)`; nothing started |
| `rejects_cmd_shim_case_insensitive` | Windows-only | `C:\x\claude-agent-acp.CMD` | `Err(ShellShim { ext: "cmd" })` |
| `shutdown_kills_grandchild` | all | spawn spawn-tree, read `CHILD_PID`, `shutdown` | grandchild gone within 5 s |
| `agent_crash_still_reaps_grandchild` | all | spawn spawn-tree; kill **only the direct child**: Windows `%SystemRoot%\System32\taskkill.exe /PID <SELF_PID> /F` (**no** `/T`), Unix `/bin/kill -9 <SELF_PID>`; then `shutdown` | grandchild gone |
| `drop_without_shutdown_reaps_tree` | all | spawn, then drop `AgentProcess` | grandchild gone within 5 s |
| `host_killed_reaps_tree` (**most important**) | Windows-only | start supervisor-host with plain `std::process::Command` (no Job), read `CHILD_PID` and `SELF_PID`, `Child::kill()` the supervisor-host (TerminateProcess, same as `taskkill /F`) | spawn-tree and its grandchild gone within 5 s |
| `stderr_flood_does_not_stall` | all | spawn-tree `--stderr-flood` | `DONE` on stdout within 10 s; `stderr_tail().len() <= 65536` |
| `cwd_with_space_and_cjk` | all | cwd is an `agent dock 測試-xxx` temp dir; `--print-cwd` | printed `current_dir` equals cwd |
| `graceful_close_when_agent_exits_on_stdin_eof` | all | `--exit-on-eof` | `ExitKind::ClosedGracefully` |
| `shutdown_is_idempotent` | all | call twice | second returns the same result immediately |

`host_killed_reaps_tree` is Windows-only because on Linux a SIGKILLed parent does not take its process group down (Linux would need `PR_SET_PDEATHSIG`, out of scope for alpha; list it in the PR as a known Unix gap).

"Process exists" check: Windows `%SystemRoot%\System32\tasklist.exe /FI "PID eq <pid>" /NH /FO CSV` (exists if the output contains `"<pid>"`; build the path from `SystemRoot`, not PATH); Unix `/bin/kill -0 <pid>` exit status (a zombie counts as gone: also check `/proc/<pid>/stat` state is not `Z`). Poll every 100 ms, up to 5 s.

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-process env                                        # 3 pass on Linux
cargo test -p agentdock-process --test process_tree -- --test-threads=1    # 8 pass on Linux
cargo tree -d -p agentdock-process                                         # no duplicate `windows` crate
```

Windows-only (CI `rust-windows`, or the owner's machine): `env` 4 pass, `process_tree` 10 pass, including `host_killed_reaps_tree`. Check:

```bash
gh pr checks <PR> --repo ChiJiun/agentdock
gh run view <run id> --repo ChiJiun/agentdock --log | grep -E "process_tree|test result"
```

## 8. Spec references and porting sources

- ADR-0002 line 16 (decision 2), line 37 (Acpira's Job Object approach, behavior reference only, no copying), lines 59–64 (S2 checklist), lines 79–80, line 103 (pinned versions, Windows CI tests), lines 174–175 (X-1, X-2).
- `docs/architecture.md` line 42 (child process supervision), line 82 (sanitized environment), line 91 (environment allow-list, no secrets logged), line 109 (process cancel/restart integration tests).
- Behavior references (Node draft, scenarios only, do not port code): PR #25, SHA `7d41c9f1`:
  - `apps/runtime/acp-host.mjs` lines 13–23 `DEFAULT_LIMITS` (`stdinGraceMs: 1500`, `killGraceMs: 3000`), lines 147–175 (`shell: false`, stderr drained and not kept), lines 420–447 (shutdown order; force-close pipes held by descendants).
  - `apps/runtime/adapters.mjs` lines 8–21 (absolute path, reject shims), lines 52–56 (environment allow-list).
  - `apps/runtime/runtime.test.mjs` line 254 (failed start leaves no process), line 304 (shutdown stops the whole tree), line 328 (bounded shutdown when an exited agent leaves descendants holding stdio).
- `process-wrap` 10.0.1 (source from crates.io, license `Apache-2.0 OR MIT`, MSRV 1.87): `src/tokio/job_object.rs`, `src/windows.rs`, `src/tokio/kill_on_drop.rs`. Used as a dependency, not copied.

## 9. Dependencies

| Crate | Version | Status |
| --- | --- | --- |
| `process-wrap` (`default-features = false`, features `["tokio1", "job-object", "kill-on-drop", "process-group", "creation-flags"]`) | `=10.0.1` | ADR-0002 candidate; this packet is the S2 validation; attach `cargo tree` and licenses in the PR |
| `windows` (feature `Win32_System_Threading`, `cfg(windows)` only) | 0.62.2 (must equal process-wrap's) | needs audit |
| `tokio` (`process`, `io-util`, `rt`, `time`, `sync`, `macros`) | 1.54.1 | needs audit (reuse if P3-1 added it) |
| `thiserror` | 2.0.21 | needs audit |
| `win32job` | not used | ADR-0002 says "optionally"; process-wrap is enough |

## 10. Model tier

Strong model implements and reviews. A leaked process tree leaves an agent running with the user's credentials, and the Windows behavior is only visible on real Windows.

## 11. Common mistakes and pitfalls

- `JobObject` without `KillOnDrop`: no `KILL_ON_JOB_CLOSE`, the agent tree survives a forced AgentDock exit. `host_killed_reaps_tree` catches it.
- Collecting the tree with `taskkill /T /F`: grandchildren whose middle parent already exited are no longer in the tree and are missed.
- Treating "direct child exited" as done: launchers like `npx` / `cmd` exit while the real agent keeps running. `shutdown` always kills the whole Job/group.
- Not reading stderr: the pipe buffer (≈4–64 KiB) fills and the agent blocks on write, looking like "agent not responding".
- Writing stderr to events or logs: may contain API keys (PR #25 lines 170–174 deliberately keep nothing).
- `Command::new("claude-agent-acp")` without an absolute path: Windows searches the **current directory** first, so a repo could plant a same-named exe (PR #25 `adapters.mjs` lines 9–11).
- `.cmd` shims: since Rust 1.77.2 std escapes `.bat`/`.cmd` arguments and returns `InvalidInput` when it cannot, but user paths in arguments remain fragile (BatBadBut). Reject here; P3-6 resolves shims.
- Simulating an AgentDock kill with `std::process::exit`: not equivalent. Kill from the parent with `Child::kill()`.
- A `windows` crate version different from process-wrap's: `CreationFlags` types mismatch, or two copies of `windows` get compiled.
- `cfg(windows)` tests never run on Linux: the PR must link the `rust-windows` CI run (or owner's local output).

## 12. Reviewer checklist

- [ ] Is `KillOnDrop` wrapped together with `JobObject` on Windows and with `ProcessGroup::leader()` on Unix?
- [ ] Does `host_killed_reaps_tree` kill the host with a real process kill, and did it pass on `windows-latest` (link the run)?
- [ ] Is the stderr drain started before `spawn` returns, bounded at 64 KiB, and never persisted?
- [ ] Does `child_env` start from an empty environment and never log values?
- [ ] Are relative programs and Windows shell shims rejected before anything is spawned?
- [ ] Does the crate compile and its cross-platform tests pass on Linux?
