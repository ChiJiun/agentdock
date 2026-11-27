# P5-3: Worktree state probe, restart reconciliation and per-task workspace scope

> **繁中摘要**：`probe(plan)` 唯讀判斷 task worktree 的現況（Ready／BranchOnly／Orphan／Relocated／Missing／RepositoryUnavailable），不寫 Git、不刪檔；`task_scope(plan)` 只在 `Ready` 時回傳**只含該 worktree** 的 `WorkspaceScope`，session cwd、check runner、ACP 路徑檢查都用它，source repo 與其他 task 的 worktree 都在範圍外。每次使用前重新 probe，資料夾被換成 junction 或註冊被改時立即失去授權。啟動時對未結束的 task 做一次 probe 供 P8 顯示（不寫事件、不自動修復）。模型等級：強模型實作＋強模型審查。

Issues: #9, #8 | Gate (#51): G4 (two worktrees do not interfere), G7 (a session cannot reach another task's worktree through paths), G3 (real state shown after reopen) | Model tier: **strong model implements and reviews**

## 1. Goal and non-goals

Goals:

- `probe(plan)`: read-only determination of a task worktree's current state (no Git writes, no deletes).
- `task_scope(plan)`: only when the state is `Ready`, return a `WorkspaceScope` (P4-1) containing **only that worktree**. Session cwd, check runner cwd and ACP permission path checks all use this scope; the source repo and other tasks' worktrees are outside it.
- Re-probe before every use (PR #28: "Registered worktrees are trusted only after Git confirms them again"), so replacing the folder with a junction, or re-registering it to another branch, revokes authorization without a restart.
- At startup, probe every non-terminal task once and hand the result to P8 for display (no events; the contract has no worktree state events).

Non-goals: create (P5-2), remove (#37), automatic repair (`Partial`/`Orphan` are only displayed; the user handles them), WSL path interop (WT-11).

## 2. Prerequisites and parallel work

- Prerequisites: P5-2, P4-1.
- Parallel: P6-1, P7-1. P3-5b's `SessionConfig.cwd`, P6-1 and P8-3 use this packet.

## 3. Files

New:

- `crates/agentdock-integrations/src/worktree/probe.rs`
- `crates/agentdock-integrations/tests/worktree_probe.rs`

Modified: `crates/agentdock-integrations/src/worktree.rs` (exports).

## 4. Public types and signatures

```rust
// crates/agentdock-integrations/src/worktree/probe.rs
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorktreeStatus {
    /// Registered at plan.path with refs/heads/<plan.branch>, folder canonical and a direct child of the root.
    Ready { head_sha: String },
    /// Branch exists, nothing registered at the path, folder absent (crash between branch and worktree add).
    BranchOnly,
    /// Folder exists but is not registered for this branch (or registered with another branch / detached).
    Orphan { registered_branch: Option<String> },
    /// Registered, but the folder was replaced by a link or moved (canonical path differs).
    Relocated,
    /// Neither branch nor folder exists (not created yet, or removed by the user).
    Missing,
    /// The repository itself is no longer inside an approved source root, or Git could not read it.
    RepositoryUnavailable { reason: String },
}

impl crate::worktree::WorktreeManager {
    /// Read-only. Runs `git worktree list --porcelain -z` and `git show-ref --verify` only.
    pub async fn probe(&self, plan: &WorktreePlan) -> WorktreeStatus;
    /// Ready → Ok(scope with exactly one root = plan.path). Anything else → Err(status).
    pub async fn task_scope(&self, plan: &WorktreePlan)
        -> Result<agentdock_policy::path_scope::WorkspaceScope, WorktreeStatus>;
    /// Startup: probe every plan; never mutates anything.
    pub async fn probe_all(&self, plans: &[WorktreePlan]) -> Vec<(WorktreePlan, WorktreeStatus)>;
}
```

## 5. Implementation steps

1. Write the §6 tests.
2. `probe`:
   1. The repo must still be inside the source scope (`sources.check(repo, None, Read)` is `Allow`), else `RepositoryUnavailable` (after the user revokes approval it must not recover automatically; PR #28 lines 181–185).
   2. Look in porcelain for `path == plan.path` (case-insensitive under `cfg(windows)`; convert Git's forward slashes first):
      - Found with `branch == refs/heads/<plan.branch>`: check `dunce::canonicalize(plan.path) == plan.path` and parent == worktree root; true → `Ready { head_sha }`, else `Relocated`.
      - Found with another branch or detached → `Orphan { registered_branch }`.
   3. Not found: folder exists → `Orphan { registered_branch: None }`; else branch exists (`show-ref --verify --quiet`) → `BranchOnly`; neither → `Missing`.
   4. Any Git failure (e.g. repo deleted) → `RepositoryUnavailable { reason }` (redacted, ≤ 240 chars); never panic.
3. `task_scope`: `probe` is `Ready` → `WorkspaceScope::new(&[plan.path])`.
4. Caller rule (document it in the module docs; P3-5b / P6-1 / P8-3 follow it): call `task_scope` again before every session start, check run and path approval; never cache it beyond one operation.

## 6. Tests to write first

`tests/worktree_probe.rs` (same temp layout as P5-2; create worktrees A and B for two tasks with P5-2's `create`):

| Test | Expected |
| --- | --- |
| `ready_after_create` | A is `Ready`; `head_sha` equals A's HEAD |
| `ready_after_manager_restart` | drop the manager and `new` again → A still `Ready` (PR #28 line 292 scenario) |
| `branch_only_detected` | create the branch manually, no worktree → `BranchOnly` |
| `orphan_folder_detected_and_kept` | create the plan folder manually → `Orphan { registered_branch: None }`; folder still exists |
| `registration_changed_to_other_branch_revokes` | the test itself runs `git worktree remove` on A then `git worktree add <A path> other` → `Orphan { registered_branch: Some("refs/heads/other") }`; `task_scope` is `Err` (PR #28 line 271 scenario) |
| `folder_replaced_by_link_is_relocated` | rename A's folder and create a symlink (`cfg(unix)`) / junction (`cfg(windows)`) at the old location pointing elsewhere → `Relocated`; `task_scope` is `Err` (PR #28 line 304 scenario) |
| `revoked_source_root_is_unavailable` | manager built with a source scope that does not contain the repo → `RepositoryUnavailable` |
| `missing_when_nothing_exists` | never-created plan → `Missing` |
| `scope_contains_only_own_worktree` | `task_scope(A)`: file in A `Allow`; file in B `Deny(OutsideRoots)`; file in source repo `Deny(OutsideRoots)` |
| `sibling_reached_via_dotdot_is_denied` | with A as base, check `../task-<B slug>/file` → `Deny` |
| `sibling_reached_via_link_inside_worktree_is_denied` | create a symlink/junction inside A pointing to B; check `<A>/link/file` → `Deny(ResolvesOutsideRoots)` |
| `probe_never_writes` | for every state, `git for-each-ref`, `git worktree list --porcelain` output and folder listings are identical before and after `probe` |

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-integrations --test worktree_probe -- --test-threads=1   # 12 pass
```

Windows-only (CI `rust-windows`): the junction variants of `folder_replaced_by_link_is_relocated` and `sibling_reached_via_link_inside_worktree_is_denied` run on `windows-latest`; confirm they appear as `ok` in the job log.

## 8. Spec references and porting sources

- ADR-0002 WT-1, WT-3, WT-9 (lines 135–143); WT-11 (line 145, unsupported; listed in README "Not yet covered").
- Issue #9 (one worktree per task), Issue #8 Requirements item 2 (scoped paths) and item 5 (child agents inherit only fewer permissions).
- Behavior and test-scenario references (do not copy code): PR #28, SHA `489ba3d`, `apps/runtime/worktrees.mjs` lines 167–175 `stillInPlace`, 177–208 `verifyRegistered` (restart reconciliation, no Git writes, no deletes), 210–219 `list` (re-confirm before every use), 318–320 `permittedWorkspacePaths`; `worktrees.test.mjs` lines 245, 271, 292, 304.

## 9. Dependencies

No new crates.

## 10. Model tier

Strong model implements and reviews. A scope mistake lets one task's agent read or write another task's worktree or the user's source repo.

## 11. Common mistakes and pitfalls

- Probing once at startup and caching: a later junction swap goes unnoticed. Re-probe before every use.
- Adding the source repo to the task scope "for convenient reads": the agent could then modify the user's own working tree. The scope is the worktree only.
- Auto-repairing or deleting on `BranchOnly` / `Orphan`: only display; the user decides (PR #28 only marks them too).
- Git for Windows porcelain paths are `C:/...`: plain string comparison fails.
- `git worktree list` fails if the repo was deleted: return `RepositoryUnavailable`, never panic.

## 12. Reviewer checklist

- [ ] Does `probe` run only read-only Git commands, proven by `probe_never_writes` for every state?
- [ ] Does `task_scope` return exactly one root, and only for `Ready`?
- [ ] Are link replacement and registration changes detected without restart?
- [ ] Is the source-scope re-check done on every probe (revocation works)?
- [ ] Do callers' docs state "re-call `task_scope` before every operation"?
