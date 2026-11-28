# Spike S2 record: agent process supervision with `process-wrap` (route a)

> **繁中摘要**：ADR-0002 spike S2 路線 (a)（`process-wrap` 10.0.1）的實測紀錄，對應任務包 P3-2。Windows 11 本機與 CI（`rust-windows`、`rust-linux`）都跑了 `agentdock-process` 的程序樹測試；最重要的 `host_killed_reaps_tree`（AgentDock 本身被強制結束後，Job Object 的 KILL_ON_JOB_CLOSE 收掉整棵程序樹）在 Windows 通過。真實 agent（`claude-agent-acp`、`codex-acp`）與 `.cmd` 引數跳脫兩項不在本包範圍，交給 P3-6 的 opt-in E2E。Unix 上 AgentDock 被 SIGKILL 時 process group 不會跟著結束，是 alpha 的已知缺口。

Status: route (a) passes for the items covered here. Date: 2026-11-28. Packet: [P3-2](../tasks/P3-2-process-supervisor-windows.md). Decision: [ADR-0002](../decisions/0002-source-reuse.md) section 1, S2.

## Setup

| Item | Value |
| --- | --- |
| `process-wrap` | `=10.0.1` (`default-features = false`, features `tokio1`, `job-object`, `kill-on-drop`, `process-group`, `creation-flags`); license `Apache-2.0 OR MIT`; used as a dependency, no source copied |
| `windows` | 0.62.2 (same as `process-wrap`; `cargo tree -d -p agentdock-process` shows one copy) |
| Toolchain | Rust 1.91.1 (`rust-toolchain.toml`) |
| Windows (local) | Windows 11 Pro, `ver` = `Microsoft Windows [Version 10.0.26300.9974]` |
| Windows (CI) | GitHub Actions `windows-latest`: Microsoft Windows Server 2025, image `windows-2025-vs2026` version 20261123.321.1 (`rust-windows` job of run [46160726621](https://github.com/ChiJiun/agentdock/actions/runs/46160726621), commit `4e93206`) |
| Linux (CI) | GitHub Actions `ubuntu-latest`: Ubuntu, image `ubuntu-26.04` version 20261122.9.1, OS `Ubuntu 26.04.1 LTS` on Azure (`rust-linux` job of the same run, "Set up job" log). **`uname -a` is not available**: the `rust-linux` workflow does not print it, the job log has no kernel line, and no local Linux VM was used. Adding a `uname -a` step means changing `.github/workflows/rust.yml`, which is outside this packet's files |

Wrapper stack in `crates/agentdock-process/src/lib.rs` (`build_command`):

- Windows: `CreationFlags(CREATE_NO_WINDOW)` + `JobObject` + `KillOnDrop`. `JobObject` adds `CREATE_SUSPENDED`, assigns the process to a new Job, then resumes its threads, so no descendant starts outside the Job. `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is set only because `KillOnDrop` is present.
- Unix: `ProcessGroup::leader()` + `KillOnDrop`. `KillOnDrop` on Unix only sets Tokio's `kill_on_drop` (direct child), so `AgentProcess`'s `Drop` also calls `start_kill()` (SIGKILL to the group).

## S2 checklist results

| S2 item (ADR-0002) | Test (`tests/process_tree.rs`) | Windows 11 local | `rust-windows` CI | `rust-linux` CI |
| --- | --- | --- | --- | --- |
| Start suspended, assign Job, resume | covered by `process-wrap` (`JobObject`); every Windows tree test relies on the grandchild being in the Job | pass (implied) | pass (implied) | n/a |
| No descendant survives cancel / close | `shutdown_kills_grandchild`, `shutdown_is_idempotent` | pass | pass | pass |
| No descendant survives an agent crash | `agent_crash_still_reaps_grandchild` (kills only the direct child: `taskkill /PID /F` without `/T`, `/bin/kill -9`) | pass | pass | pass |
| Launcher exits, real agent lives on | `graceful_close_still_reaps_leftover_grandchild` | pass | pass | pass |
| Drop without shutdown | `drop_without_shutdown_reaps_tree` | pass | pass | pass |
| **AgentDock itself killed** | `host_killed_reaps_tree` (supervisor host killed with `Child::kill()` = TerminateProcess) | pass | pass | Windows-only (known Unix gap below) |
| Orderly shutdown (stdin close, grace, kill) | `graceful_close_when_agent_exits_on_stdin_eof`, `shutdown_kills_grandchild` | pass | pass | pass |
| stderr drained continuously | `stderr_flood_does_not_stall` (10 MiB to stderr, `DONE` within 10 s, tail <= 64 KiB) | pass | pass | pass |
| cwd with spaces and CJK | `cwd_with_space_and_cjk` (`agent dock 測試-…`) | pass | pass | pass |
| `.cmd` argument escaping (BatBadBut) | not tested: `.cmd` / `.bat` / `.ps1` are rejected (`rejects_cmd_shim_case_insensitive`); P3-6 resolves npm shims to `node.exe <script>` | reject: pass | pass | n/a |
| Real agents (`claude-agent-acp`, `codex-acp`): initialize, `session/new`, prompt, cancel, close | **not done here: done by P3-6's opt-in E2E** | — | — | — |

Mutation checks run locally on Windows (reverted afterwards):

- Removing `KillOnDrop` from the wrapper stack makes `host_killed_reaps_tree` fail (spawn-tree and its grandchild still running after 5 s), confirming the packet's warning about `KILL_ON_JOB_CLOSE`.
- Removing the `start_kill()` after a graceful exit (and in `Drop`) makes `graceful_close_still_reaps_leftover_grandchild` fail.

Totals: Windows 11 local and `rust-windows` CI 11/11 `process_tree` tests passed; `rust-linux` CI 9/9 (the two Windows-only tests are not compiled there). CI ran the tests in parallel (default test threads), local runs used `--test-threads=1` and were repeated three more times without failure. After every local run `tasklist` showed no `agentdock-test-*` process left.

## Observations about `process-wrap` 10.0.1

- `JobObjectChild::wait()` waits for the direct child and then reads the Job's completion port; `ProcessGroupChild::wait()` reaps the group with `waitpid(-pgid)`. `AgentProcess` waits on the native Tokio child under the wrapper instead (downcast through `ChildWrapper: Any`), so "direct child exited" does not depend on completion-port messages, and always kills the whole Job / group afterwards.
- `start_kill()` on the Job (`TerminateJobObject`) and on the group (`killpg`) both work after the direct child has exited.
- If `JobObject` cannot get a process handle it kills the child and returns `ErrorKind::Unsupported`; `AgentProcess::spawn` maps that to `ProcessError::Supervision`.

## Known gaps (alpha)

- **Unix: any AgentDock exit that does not run `Drop` leaves the agent group running.** Besides SIGKILL this includes `std::process::exit`, Tauri `app.exit()` / `AppHandle::exit` and other paths that end the process without unwinding. On Unix the group is only killed by `shutdown` or by `AgentProcess`'s `Drop`; the kernel does not do it. **Rule for P3-4 / P3-5: before the app exits, explicitly `await` `shutdown` on every `AgentProcess`** (for example from the Tauri exit / window-close handler) instead of relying on `Drop`. Making the forced cases safe needs `PR_SET_PDEATHSIG` (Linux) or a supervisor process; out of scope for alpha (P3-2 §6). On Windows the kernel closes the Job handle on any process exit, so KILL_ON_JOB_CLOSE still applies.
- SIGTERM before SIGKILL on Unix needs `nix` signals in AgentDock code; alpha kills the group directly after `stdin_grace`.
- PID reuse: `Drop` calls `killpg` if `shutdown` never completed. If the whole group had already exited long before and the PGID was reused by a new group leader, that group would be signalled. Linux does not reuse a PID while it is still a live PGID, so the window is only after every group member is gone.
- Nested Job / CPU cap and priority (ADR-0002 line 37) are after alpha.

## Conclusion

Route (a) meets the S2 process-tree items tested here on Windows, including the forced-exit case, without any AgentDock unsafe code. Routes (b) (own spawner) and (c) (Acpira launcher) were not needed. S2 stays open only for the real-agent and `.cmd` items assigned to P3-6.
