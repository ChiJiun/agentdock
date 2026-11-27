# P5-1: Git CLI wrapper (no shell, env allowlist, timeouts, output caps, repo-controlled executables disabled)

> **繁中摘要**：建立 `agentdock-integrations` crate 與 `Git` 型別，AgentDock 自己執行的所有 Git 指令都經過它：啟動時解析一次 git 的絕對路徑、參數陣列不經 shell、最低 Git 2.36、`env_clear()` 加白名單（不繼承 `GIT_DIR` 等）、每次呼叫固定加上安全 `-c` 設定（停用 `core.fsmonitor`、hooks 指向空目錄、禁止 `ext::`），逾時與輸出上限、錯誤訊息只帶經 redaction 的 stderr 前 240 字元。附「repo 設定的 fsmonitor／hooks 不會被執行」等對抗測試（含對照組）。模型等級：一般模型可。

Issue: #9 | Gate (#51): G4, G5 (foundation for every Git operation) | Model tier: **standard model is enough**

## 1. Goal and non-goals

Goal: create the `agentdock-integrations` crate and the `Git` type; every Git command AgentDock itself runs goes through it.

- Absolute path to git (resolved once at startup), argument arrays, **never a shell** (CONVENTIONS §2).
- Minimum Git 2.36 (needed for `git worktree list --porcelain -z`; PR #28 `worktrees.mjs` lines 7–8); clear error if older.
- Environment: `env_clear()` + allowlist (P3-2's `ENV_ALLOWLIST`, plus `ProgramData`, `XDG_CONFIG_HOME`) + `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`. Inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` etc. are **never passed** (PR #28 lines 38–44).
- Every call prepends fixed safety settings (`-c` pairs, §4 `safe_config`): disable `core.fsmonitor`, point `core.hooksPath` at AgentDock's own empty directory, forbid dangerous transports such as `ext::`. Reason: the agent can edit the repo's `.git/config` and hooks; AgentDock's `git status` / `git commit` must never run programs the agent planted.
- Timeouts: 30 s default, 120 s for checkout-like operations (PR #28 lines 13–15). Output caps: 1 MB stdout / 64 KiB stderr; exceeding either kills the process and returns an error.
- Error messages carry only the first 240 characters of stderr (after P2-7 redaction), never URL credentials from the command line.

Non-goals: worktree logic (P5-2, P5-3), status/diff parsing (P7-1), commit/push (P7-2).

## 2. Prerequisites and parallel work

- Prerequisites: P1-1, P2-7 (redaction), P4-1 (`ScopedPath`).
- Parallel: P2-*, P3-*, other P4-*.

## 3. Files

New:

- `crates/agentdock-integrations/Cargo.toml`, `src/lib.rs`
- `crates/agentdock-integrations/src/git.rs`
- `crates/agentdock-integrations/tests/git_wrapper.rs`
- `crates/agentdock-integrations/src/bin/agentdock-test-marker.rs` (test helper: creates an empty file at the path given as its first argument; `[[bin]]` with `test = false`, `doc = false`; integration tests get its path from `env!("CARGO_BIN_EXE_agentdock-test-marker")`)

Modified: root `Cargo.toml` (members).

## 4. Public types and signatures

```rust
// crates/agentdock-integrations/src/git.rs
use std::{path::{Path, PathBuf}, time::Duration};

pub const MIN_GIT: (u32, u32) = (2, 36);
pub const TIMEOUT_DEFAULT: Duration = Duration::from_secs(30);
pub const TIMEOUT_CHECKOUT: Duration = Duration::from_secs(120);
pub const MAX_STDOUT: usize = 1_000_000;
pub const MAX_STDERR: usize = 64 * 1024;

/// Always prepended as `-c key=value` pairs, before the subcommand.
pub fn safe_config(empty_hooks_dir: &Path) -> Vec<String>; // see table below

#[derive(Debug, Clone)]
pub struct GitOutput { pub status: i32, pub stdout: Vec<u8>, pub stderr: String /* lossy, truncated */ }

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("git executable not found")] NotFound,
    #[error("git {found} is older than the required 2.36")] TooOld { found: String },
    #[error("git timed out after {0:?}")] Timeout(Duration),
    #[error("git output exceeded the limit")] OutputTooLarge,
    #[error("git failed (exit {status}): {stderr}")] Failed { status: i32, stderr: String }, // stderr redacted, <= 240 chars
    #[error("invalid git argument")] BadArgument,
    #[error("io error: {0:?}")] Io(std::io::ErrorKind),
}

#[derive(Debug, Clone)]
pub struct Git { exe: PathBuf, version: (u32, u32, u32), hooks_dir: PathBuf, redactor: std::sync::Arc<agentdock_core::redact::Redactor> }

impl Git {
    /// Resolves git: explicit path from settings, else the first absolute PATH entry containing git.exe (Windows) / git (Unix).
    /// Runs `git --version`, enforces MIN_GIT, creates `hooks_dir` (empty) under the app data dir.
    pub async fn discover(explicit: Option<&Path>, path_dirs: &[PathBuf], hooks_dir: PathBuf,
                          redactor: std::sync::Arc<agentdock_core::redact::Redactor>) -> Result<Self, GitError>;
    pub fn version(&self) -> (u32, u32, u32);
    /// Runs `git <safe -c ...> -C <cwd> <args...>`. Non-zero exit is returned as Ok(GitOutput) — callers decide.
    /// `cwd` must be a P4-1 ScopedPath (the type makes unchecked paths impossible).
    pub async fn run(&self, cwd: &agentdock_policy::path_scope::ScopedPath, args: &[&str], timeout: Duration)
        -> Result<GitOutput, GitError>;
    /// Same as run, but non-zero exit → GitError::Failed.
    pub async fn run_ok(&self, cwd: &agentdock_policy::path_scope::ScopedPath, args: &[&str], timeout: Duration)
        -> Result<GitOutput, GitError>;
}

/// Parses "git version 2.45.0.windows.1" → (2, 45, 0). Pure.
pub fn parse_version(s: &str) -> Option<(u32, u32, u32)>;
/// Rejects values git would read as options or that are not safe ref names (WT-8). Pure.
pub fn check_ref_arg(s: &str) -> Result<(), GitError>; // non-empty, must not start with '-', no whitespace/control, no "..", no '\\'
```

For the output-cap test, expose a crate-private `run_with_limits(&self, cwd, args, timeout, max_stdout, max_stderr)` used by `run`; tests reach it via a `#[doc(hidden)] pub fn` or a `cfg(any(test, feature = "test-util"))` hook.

`safe_config` contents (fixed order; each entry is `-c` followed by one string):

| Setting | Value | Reason |
| --- | --- | --- |
| `core.fsmonitor` | `false` | repo config can name any program to run during `git status` |
| `core.hooksPath` | `<app data>/git-empty-hooks` (`hooks_dir`, forward slashes) | the agent can write `.git/hooks/*`; AgentDock's commits must not run them (the trade-off of disabling hooks is listed in the README for discussion) |
| `protocol.ext.allow` | `never` | the `ext::` transport runs arbitrary commands |
| `protocol.file.allow` | `user` | default since Git 2.38.1; stated explicitly |
| `core.askPass` | empty string | no password dialog |
| `credential.interactive` | `never` | GCM does not prompt |
| `core.sshCommand` | **not overridden** | the user's own SSH setup must keep working (push) |

## 5. Implementation steps

1. Write the §6 tests.
2. `discover`: try `explicit`, then each **absolute** directory in `path_dirs` (skip relative and empty entries so the current directory is never used). Look for `git.exe` under `cfg(windows)` and `git` under `cfg(unix)`. Run `--version` with `tokio::process::Command` (also `env_clear` + allowlist), `parse_version`, compare with `MIN_GIT`.
3. `run`:
   - Any `args` element containing `\0` → `BadArgument`.
   - Command line: `[safe_config..., "-C", cwd, args...]`, `cwd` from `ScopedPath::as_path()`.
   - `Command`: `env_clear()`, allowlist, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `stdin(Stdio::null())`, `kill_on_drop(true)`; under `cfg(windows)` add `CREATE_NO_WINDOW` (`std::os::windows::process::CommandExt::creation_flags(0x0800_0000)`).
   - Read stdout and stderr concurrently (two tasks); if either exceeds its cap → `start_kill()`, return `OutputTooLarge`.
   - `tokio::time::timeout(timeout, child.wait())`; on timeout → `start_kill()` then `wait()`, return `Timeout`.
   - stderr: lossy UTF-8 → redaction → collapse newlines and repeated whitespace → first 240 characters.
4. `check_ref_arg`: pure string rules; callers additionally run `git check-ref-format --branch <name>` for full validation (WT-8, used by P5-2).

## 6. Tests to write first

Unit tests (`git.rs`):

```rust
#[test] fn parses_windows_version() { assert_eq!(parse_version("git version 2.45.0.windows.1"), Some((2, 45, 0))); }
#[test] fn parses_plain_version() { assert_eq!(parse_version("git version 2.36.6"), Some((2, 36, 6))); }
#[test] fn rejects_garbage_version() { assert_eq!(parse_version("hello"), None); }
#[test] fn ref_arg_rules() {
    assert!(check_ref_arg("agentdock/task-0123456789ab").is_ok());
    for bad in ["-x", "--upload-pack=evil", "a b", "a..b", "a\\b", "a\nb", ""] { assert!(check_ref_arg(bad).is_err(), "{bad:?}"); }
}
#[test] fn safe_config_contains_required_pairs() {
    let c = safe_config(std::path::Path::new("/x/hooks"));
    for needle in ["core.fsmonitor=false", "core.hooksPath=/x/hooks", "protocol.ext.allow=never"] {
        assert!(c.windows(2).any(|w| w[0] == "-c" && w[1] == needle), "{needle}");
    }
}
```

`tests/git_wrapper.rs` (a temp directory whose name contains a space and CJK characters, e.g. `agent dock 測試-*`; `Git` itself runs `init` and `commit`; author via `-c user.name=t -c user.email=t@example.invalid`):

| Test | Expected |
| --- | --- |
| `discover_finds_git_and_checks_version` | `version() >= (2, 36, 0)` |
| `discover_skips_relative_path_dirs` | `path_dirs = ["."]` with a fake `git` / `git.exe` (empty file) in the current directory → `NotFound` (the fake is never run) |
| `inherited_git_dir_is_ignored` | set `GIT_DIR=<another repo>/.git` in the test process, call `run(["rev-parse","--show-toplevel"])` → returns `cwd`'s repo |
| `fsmonitor_in_repo_config_is_not_executed` | set repo `.git/config` `core.fsmonitor = "<abs path of agentdock-test-marker>" "<marker path>"` → after `run(["status"])` the marker does not exist |
| `repo_hooks_are_not_executed` | `.git/hooks/pre-commit` containing `#!/bin/sh`, newline, `"<agentdock-test-marker path>" "<marker path>"`; under `cfg(unix)` `chmod 0o755` (Git for Windows runs hooks with its bundled sh) → after `run(["commit","--allow-empty","-m","x"])` the marker does not exist. **Control:** the same command run without `safe_config` (plain `std::process::Command`) creates the marker, proving the test is effective |
| `ext_protocol_is_blocked` | `run(["ls-remote","ext::sh -c true"])` (Windows: `ext::cmd /c echo x`) → non-zero status; do not assert on localized message text |
| `timeout_kills_git` | `TIMEOUT = 1ms` running `log` → `Timeout` |
| `output_cap_enforced` | create 2,000 commits, run `log --format=%H%n%B` via `run_with_limits` with a small cap → `OutputTooLarge` |
| `nonzero_exit_returned_by_run_and_error_by_run_ok` | `rev-parse --verify nope` → `run` is Ok with status ≠ 0; `run_ok` is `Failed` |
| `stderr_is_redacted_and_bounded` | make git print a URL containing `ghp_` + 36 `0`s to stderr (`ls-remote https://ghp_000...@127.0.0.1:1/x`) → `Failed.stderr` contains no `ghp_0` and is ≤ 240 chars |
| `nul_in_argument_rejected` | `BadArgument` |

## 7. Acceptance commands and expected results

```bash
git --version                                   # must be >= 2.36
cargo test -p agentdock-integrations git        # 5 unit + 11 integration tests pass
```

If the VM's Git is older than 2.36, stop and ask the owner before installing anything (`sudo apt-get install git` needs approval).

Windows-only (CI `rust-windows`): the same suite passes on `windows-latest`, including the `git.exe` discovery and `CREATE_NO_WINDOW` code paths. Check the job log for `test result: ok` on the `agentdock-integrations` test binaries.

## 8. Spec references and porting sources

- ADR-0002 line 142 WT-8 (no shell, branch/start point must not start with `-`, `check-ref-format`, declared minimum version), line 138 WT-4 (spaces and CJK paths).
- Behavior references (do not copy code): PR #28, SHA `489ba3d`, `apps/runtime/worktrees.mjs` lines 7–15 (minimum version, output caps, timeouts), lines 38–44 (Git env allowlist, no inherited `GIT_DIR` etc., `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`), lines 48–53 (error message uses only the first 240 chars of stderr); PR #25, SHA `7d41c9f`, `apps/runtime/server.mjs` lines 98–101 (timeouts and output caps for `git` calls).
- Local check (2026-11-22, owner's Windows machine): `git version 2.45.0.windows.1`.

## 9. Dependencies

| crate | Version | Status |
| --- | --- | --- |
| `tokio` (`process`, `io-util`, `time`) | 1.54.1 | needs audit (reuse if already added by another packet) |
| `thiserror` | workspace | — |
| `agentdock-policy`, `agentdock-core` | workspace | — |

## 10. Model tier

Standard model is enough.

## 11. Common mistakes and pitfalls

- `Command::new("git")`: on Windows the current directory is searched first, and a repo can contain a fake `git.exe`. Use the absolute path from `discover`.
- Inheriting the environment: a `GIT_DIR` set by the user or agent makes Git operate on another repo.
- Forgetting `core.fsmonitor` / hooks: editing `.git/config` or hooks would let the agent make AgentDock run arbitrary programs.
- Reading only stdout: when the stderr pipe fills, git blocks and it looks like a timeout.
- Passing a branch name as an argument without checks: `--upload-pack=...` is read as an option. Block it with `check_ref_arg` first (a `--` separator does not work for every subcommand).
- Tokens from remote URLs in error messages: always redact.
- stderr locale: Git translates messages based on `LANG`; tests compare exit codes or stable keywords, not full English messages.
- Hook control test on Linux: without the executable bit Git silently skips the hook, so the control group would falsely "pass"; set `0o755`.

## 12. Reviewer checklist

- [ ] Is git always run by absolute path with `env_clear()` and the allowlist, never through a shell?
- [ ] Are `safe_config` pairs prepended to **every** call, including `--version`-independent paths like `run_ok`?
- [ ] Do the fsmonitor and hook tests include a control proving they would fail without the safety config?
- [ ] Are both stdout and stderr drained concurrently, with caps and timeouts that kill the process?
- [ ] Is stderr redacted and truncated before reaching `GitError`?
- [ ] Do `cfg(windows)` / `cfg(unix)` branches both compile (CI on both OSes)?
