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
| Windows (CI) | GitHub Actions `windows-latest` (`rust-windows` job); OS version in the job log, see the PR |
| Linux (CI) | GitHub Actions `ubuntu-latest` (`rust-linux` job); `uname` from the runner image, see the PR |

Wrapper stack in `crates/agentdock-process/src/lib.rs` (`build_command`):

- Windows: `CreationFlags(CREATE_NO_WINDOW)` + `JobObject` + `KillOnDrop`. `JobObject` adds `CREATE_SUSPENDED`, assigns the process to a new Job, then resumes its threads, so no descendant starts outside the Job. `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is set only because `KillOnDrop` is present.
- Unix: `ProcessGroup::leader()` + `KillOnDrop`. `KillOnDrop` on Unix only sets Tokio's `kill_on_drop` (direct child), so `AgentProcess`'s `Drop` also calls `start_kill()` (SIGKILL to the group).

## S2 checklist results

| S2 item (ADR-0002) | Test (`tests/process_tree.rs`) | Windows 11 local | `rust-windows` CI | `rust-linux` CI |
| --- | --- | --- | --- | --- |
| Start suspended, assign Job, resume | covered by `process-wrap` (`JobObject`); every Windows tree test relies on the grandchild being in the Job | pass (implied) | pass (implied) | n/a |
| No descendant survives cancel / close | `shutdown_kills_grandchild`, `shutdown_is_idempotent` | pass | see PR | see PR |
| No descendant survives an agent crash | `agent_crash_still_reaps_grandchild` (kills only the direct child: `taskkill /PID /F` without `/T`, `/bin/kill -9`) | pass | see PR | see PR |
| Launcher exits, real agent lives on | `graceful_close_still_reaps_leftover_grandchild` | pass | see PR | see PR |
| Drop without shutdown | `drop_without_shutdown_reaps_tree` | pass | see PR | see PR |
| **AgentDock itself killed** | `host_killed_reaps_tree` (supervisor host killed with `Child::kill()` = TerminateProcess) | pass | see PR | Windows-only (known Unix gap below) |
| Orderly shutdown (stdin close, grace, kill) | `graceful_close_when_agent_exits_on_stdin_eof`, `shutdown_kills_grandchild` | pass | see PR | see PR |
| stderr drained continuously | `stderr_flood_does_not_stall` (10 MiB to stderr, `DONE` within 10 s, tail <= 64 KiB) | pass | see PR | see PR |
| cwd with spaces and CJK | `cwd_with_space_and_cjk` (`agent dock 測試-…`) | pass | see PR | see PR |
| `.cmd` argument escaping (BatBadBut) | not tested: `.cmd` / `.bat` / `.ps1` are rejected (`rejects_cmd_shim_case_insensitive`); P3-6 resolves npm shims to `node.exe <script>` | reject: pass | see PR | n/a |
| Real agents (`claude-agent-acp`, `codex-acp`): initialize, `session/new`, prompt, cancel, close | **not done here: done by P3-6's opt-in E2E** | — | — | — |

Mutation checks run locally on Windows (reverted afterwards):

- Removing `KillOnDrop` from the wrapper stack makes `host_killed_reaps_tree` fail (spawn-tree and its grandchild still running after 5 s), confirming the packet's warning about `KILL_ON_JOB_CLOSE`.
- Removing the `start_kill()` after a graceful exit (and in `Drop`) makes `graceful_close_still_reaps_leftover_grandchild` fail.

## Observations about `process-wrap` 10.0.1

- `JobObjectChild::wait()` waits for the direct child and then reads the Job's completion port; `ProcessGroupChild::wait()` reaps the group with `waitpid(-pgid)`. `AgentProcess` waits on the native Tokio child under the wrapper instead (downcast through `ChildWrapper: Any`), so "direct child exited" does not depend on completion-port messages, and always kills the whole Job / group afterwards.
- `start_kill()` on the Job (`TerminateJobObject`) and on the group (`killpg`) both work after the direct child has exited.
- If `JobObject` cannot get a process handle it kills the child and returns `ErrorKind::Unsupported`; `AgentProcess::spawn` maps that to `ProcessError::Supervision`.

## Known gaps (alpha)

- **Unix: AgentDock killed by SIGKILL leaves the agent group running.** Fixing it needs `PR_SET_PDEATHSIG` (Linux) or a supervisor process; out of scope for alpha (P3-2 §6).
- SIGTERM before SIGKILL on Unix needs `nix` signals in AgentDock code; alpha kills the group directly after `stdin_grace`.
- PID reuse: `Drop` calls `killpg` if `shutdown` never completed. If the whole group had already exited long before and the PGID was reused by a new group leader, that group would be signalled. Linux does not reuse a PID while it is still a live PGID, so the window is only after every group member is gone.
- Nested Job / CPU cap and priority (ADR-0002 line 37) are after alpha.

## Conclusion

Route (a) meets the S2 process-tree items tested here on Windows, including the forced-exit case, without any AgentDock unsafe code. Routes (b) (own spawner) and (c) (Acpira launcher) were not needed. S2 stays open only for the real-agent and `.cmd` items assigned to P3-6.
