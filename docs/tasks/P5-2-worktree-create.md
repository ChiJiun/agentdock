# P5-2: Create a task worktree (branch first, then worktree; on failure undo only what this attempt created)

> **繁中摘要**：提供 `WorktreeManager::create`，為每個 task 建立獨立 branch 與 worktree。名稱由 task id 雜湊決定（可冪等重算），先 `git branch --no-track` 再 `git worktree add`；失敗時只用 compare-and-delete 刪掉「這次建立的」branch，**永遠不刪資料夾**。worktree root 預設在 repo 外、不得與核准的 source root 重疊、不得是 symlink／junction；同一 repo 的建立序列化。本包不寫事件（意圖由 `task.created` 承載，失敗由 P8-3 寫 T10）。行為移植自 PR #28（只移植行為與測試情境）。模型等級：強模型實作＋強模型審查。

Issue: #9 | Gate (#51): G4 (two tasks each work in their own worktree) | Model tier: **strong model implements and reviews**

## 1. Goal and non-goals

Goal: in `agentdock-integrations`, provide `WorktreeManager::create`, which builds an isolated branch and worktree for one task. Behavior is ported from PR #28 (Node), reimplemented in Rust on ADR-0003's event model.

- Names derive from the task id (recomputable, idempotent): branch `agentdock/task-<12 hex>`, folder `<worktree_root>/task-<same 12 hex>`; `<12 hex>` = first 12 lowercase hex chars of `sha256(task_id)`.
- First `git branch --no-track <branch> <base_sha>`, then `git worktree add <path> <branch>` (WT-2). No `--force`; existing branches are never moved.
- On failure, undo only what this attempt created: if no worktree uses the branch, delete it with compare-and-delete `git update-ref -d refs/heads/<branch> <base_sha>`; **never delete folders** (WT-2, PR #28 `undoFailedCreate`).
- Worktree root defaults to outside the repo: `<repo parent>/<repo name>.worktrees` (WT-1); it must not contain or be contained by any approved source root; it must not be a symlink/junction.
- Creates for the same repo are serialized (one async mutex per repo).
- Idempotent: repeated calls for the same task (e.g. resume after crash) return the existing, correctly registered worktree; a branch without a worktree is reused and the worktree added.

Event model: the contract has no worktree-specific events. Intent is carried by `task.created{branch, worktree_path}` (P8-3 calls this packet's `plan` when creating the task to get both values); the actual create happens after `queued → preparing` (T02, `persist_then_act`); on failure P8-3 writes `T10 preparing → failed (preparation_failed)`. This packet **writes no events**.

Non-goals: state probe and workspace scope (P5-3), worktree removal (#37, not in alpha), status/diff (P7-1).

## 2. Prerequisites and parallel work

- Prerequisites: P5-1, P4-1.
- Parallel: P6-1, P7-1, P3-*. P5-3 and P8-3 use this packet.

## 3. Files

New:

- `crates/agentdock-integrations/src/worktree.rs`
- `crates/agentdock-integrations/src/worktree/porcelain.rs` (pure parser for `git worktree list --porcelain -z`)
- `crates/agentdock-integrations/tests/worktree_create.rs`

Modified: `crates/agentdock-integrations/src/lib.rs`.

## 4. Public types and signatures

```rust
// crates/agentdock-integrations/src/worktree.rs
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreePlan {
    pub repo: agentdock_policy::path_scope::ScopedPath, // canonical repository top level (inside an approved source root)
    pub branch: String,      // "agentdock/task-<12 hex>"
    pub path: PathBuf,       // <root>/task-<12 hex> (does not need to exist yet)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedWorktree { pub plan: WorktreePlan, pub base_sha: String, pub reused_existing_branch: bool, pub already_existed: bool }

#[derive(Debug, thiserror::Error)]
pub enum WorktreeError {
    #[error("repository path is not allowed: {0:?}")] Scope(agentdock_policy::path_scope::DenyReason),
    #[error("not a Git working tree")] NotARepository,
    #[error("repository has no initial commit")] NoCommits,
    #[error("worktree root overlaps an approved workspace root")] RootOverlap,
    #[error("worktree root is a symlink or junction")] RootIsLink,
    #[error("target folder exists but is not this task's registered worktree; inspect it manually")] Orphan { path: PathBuf },
    #[error("branch is checked out in another worktree")] BranchInUse,
    #[error("git failed: {detail}; {undo}")] GitFailed { detail: String, undo: String }, // undo = what was rolled back / left
    #[error(transparent)] Git(#[from] crate::git::GitError),
}

pub struct WorktreeManager { /* Git, source roots (WorkspaceScope), worktree_root: PathBuf, per-repo mutexes */ }

impl WorktreeManager {
    /// Validates root: not overlapping any source root (either direction), not a link. Root is created lazily on first create.
    pub fn new(git: crate::git::Git, sources: agentdock_policy::path_scope::WorkspaceScope, worktree_root: PathBuf)
        -> Result<Self, WorktreeError>;
    /// Default root for a repository: <parent>/<name>.worktrees (WT-1).
    pub fn default_root(repo_top: &Path) -> PathBuf;
    /// Pure naming + repository resolution (`git rev-parse --show-toplevel`). No Git writes.
    pub async fn plan(&self, repo_input: &str, task_id: &agentdock_core::ids::TaskId) -> Result<WorktreePlan, WorktreeError>;
    /// Idempotent create. Serialized per repository.
    pub async fn create(&self, plan: &WorktreePlan) -> Result<CreatedWorktree, WorktreeError>;
}

pub fn slug_for_task(task_id: &agentdock_core::ids::TaskId) -> String; // 12 lowercase hex of sha256(task_id)

// crates/agentdock-integrations/src/worktree/porcelain.rs
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registered { pub path: PathBuf, pub head: Option<String>, pub branch: Option<String> /* "refs/heads/..." */, pub bare: bool, pub detached: bool, pub locked: bool, pub prunable: bool }
pub fn parse_porcelain_z(stdout: &[u8]) -> Vec<Registered>;
```

## 5. Implementation steps

1. Write the §6 tests.
2. `new`: if `worktree_root` exists and `symlink_metadata` says symlink, or `dunce::canonicalize` differs from the input (case-insensitive on Windows) → `RootIsLink`. Compare with every source root: root inside source, or source inside root → `RootOverlap` (PR #28 `assertNoOverlap`).
3. `plan`:
   1. `sources.check(repo_input, None, PathIntent::Read)` must be `Allow`.
   2. `git rev-parse --show-toplevel` → `dunce::canonicalize` → `sources.check` again (the top level may lie outside the approved scope). Failure → `NotARepository`.
   3. Build branch and path; `check_ref_arg(branch)` and run `git check-ref-format --branch <branch>` (WT-8).
4. `create` (after taking the repo's mutex):
   1. `git rev-parse --verify --quiet HEAD^{commit}` → `base_sha` (must be 40 or 64 lowercase hex); failure → `NoCommits`.
   2. Read and parse `git worktree list --porcelain -z`:
      - A record with `path == plan.path` (case-insensitive on Windows) and `branch == refs/heads/<branch>` → confirm the folder is still in place (canonical path equals plan path, parent equals root) → return `already_existed: true`.
      - A record with `branch == refs/heads/<branch>` at another path → `BranchInUse`.
      - `plan.path` exists (`symlink_metadata` succeeds) but is not registered → `Orphan` (do not delete).
   3. Create root (`create_dir_all`), then re-check root is not a link.
   4. `git show-ref --verify --quiet refs/heads/<branch>`:
      - Missing → `git branch --no-track <branch> <base_sha>`; failure → `GitFailed { undo: "nothing was changed" }`.
      - Present (crash after branch creation) → do not create; `reused_existing_branch = true`; `base_sha` becomes the branch tip (`git rev-parse refs/heads/<branch>`).
   5. `git worktree add <path> <branch>` (timeout `TIMEOUT_CHECKOUT`). Failure → `undo_failed_create` (next step), return `GitFailed { detail, undo }`.
   6. Verify: canonical(path) == path, parent == root, porcelain has a `path + refs/heads/<branch>` record; any mismatch → `GitFailed { undo: "worktree left in place for inspection" }` (no deletion).
5. `undo_failed_create(repo, branch, base_sha, path, created_branch_this_attempt)`:
   - Re-read porcelain; if that fails → report "could not re-read state; branch and folder kept for manual inspection".
   - Any worktree using the branch or located at the path → report "partially created worktree kept at <path>".
   - Only if `created_branch_this_attempt` → `git update-ref -d refs/heads/<branch> <base_sha>` (compare-and-delete; if the branch moved, it fails and is kept).
   - If the folder exists → report "branch deleted; unregistered folder <path> kept for manual inspection".
   - **Never call** `remove_dir_all`, `git worktree remove`, `git worktree prune`, or `git branch -D`.
6. `parse_porcelain_z`: fields separated by `\0`, records separated by an empty field; fields `worktree <path>`, `HEAD <sha>`, `branch <ref>`, `bare`, `detached`, `locked[ <reason>]`, `prunable[ <reason>]`. Keep paths verbatim (Git for Windows prints forward slashes; normalize with `dunce::canonicalize` or `/` → `\` before comparing under `cfg(windows)`).

## 6. Tests to write first

`porcelain.rs` unit tests:

```rust
#[test] fn parses_two_records_with_branch_and_detached() {
    let raw = b"worktree /r\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0worktree /r.worktrees/task-0123456789ab\0HEAD 2222222222222222222222222222222222222222\0detached\0\0";
    let v = parse_porcelain_z(raw);
    assert_eq!(v.len(), 2);
    assert_eq!(v[0].branch.as_deref(), Some("refs/heads/main"));
    assert!(v[1].detached && v[1].branch.is_none());
}
#[test] fn parses_locked_and_prunable_with_reason() { /* "locked reason text\0" and "prunable gitdir file points to non-existent location\0" */ }
#[test] fn empty_input_is_empty() { assert!(parse_porcelain_z(b"").is_empty()); }
#[test] fn slug_is_stable_12_hex() { /* same TaskId → same slug; len 12; all [0-9a-f] */ }
```

`tests/worktree_create.rs` (each test creates a temp dir `agent dock 測試-*` containing `src repo/` (`git init` + one commit) and worktree root `src repo.worktrees/`; source scope = the `src repo` directory):

| Test | Expected |
| --- | --- |
| `creates_isolated_branch_and_worktree` | branch and worktree exist; worktree HEAD == source HEAD; source's current branch and files unchanged; new branch has no upstream (`git rev-parse --abbrev-ref <b>@{u}` fails) |
| `editing_worktree_does_not_touch_source` | edit and commit in the worktree → source working tree and HEAD unchanged |
| `create_is_idempotent` | same plan twice → second returns `already_existed: true`; no new branch or folder |
| `branch_only_partial_is_completed_by_reuse` | manually `git branch --no-track <b> HEAD` first (simulated crash) → `create` returns `reused_existing_branch: true`, worktree created |
| `existing_unregistered_folder_is_orphan_and_kept` | create `plan.path` with a file first → `Err(Orphan)`; folder and file still exist; no branch created |
| `branch_checked_out_elsewhere_is_rejected` | `git worktree add <other path> <b>` first → `Err(BranchInUse)` |
| `outside_scope_repo_rejected_without_git_writes` | repo outside source scope → `Err(Scope(..))`; no new branch in that repo |
| `traversal_input_rejected` | `repo_input = "<tmp>/src repo/../other"` → `Err(Scope(..))` |
| `non_repository_rejected` | plain folder → `Err(NotARepository)` |
| `empty_repository_rejected` | `git init` without commits → `Err(NoCommits)` |
| `root_overlap_rejected` | worktree root inside the source root, or source root inside the worktree root → `new` returns `RootOverlap` |
| `root_link_rejected` | root is a symlink (`cfg(unix)`) / junction (`cfg(windows)`) → `RootIsLink` |
| `concurrent_creations_get_distinct_folders` | three tasks `create` concurrently (`tokio::join!`) → three distinct branches and folders, all succeed |
| `concurrent_same_task_creates_once` | same plan twice concurrently → one `already_existed: false`, one `true`; exactly one branch |
| `failed_checkout_removes_only_new_branch` | make `worktree add` fail after the branch exists. Cross-platform: pre-create a **file** (not folder) at `<root>/task-<slug>`'s parent path component so checkout cannot create the directory — e.g. make `worktree_root` writable-protected (`cfg(unix)`: `chmod 0o555` on root after `create_dir_all`; skip when running as root). `cfg(windows)` variant: commit a reserved filename via `git update-index --add --cacheinfo 100644,<blob>,aux.txt` then commit. Expected: `GitFailed`; branch deleted; `undo` text explains; any leftover folder still exists |

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-integrations worktree    # 4 unit + 15 integration tests pass
```

On Linux, `failed_checkout_removes_only_new_branch` uses the permission variant; if the test process runs as root (common in containers), the test must detect it and print `skipped: running as root` instead of passing silently — report that in the PR.

Windows-only (CI `rust-windows`): the junction and `aux.txt` variants run on `windows-latest`; confirm in the job log that `root_link_rejected` and `failed_checkout_removes_only_new_branch` ran (not skipped).

## 8. Spec references and porting sources

- ADR-0002 lines 135–145 WT-1 to WT-11 (this packet covers WT-1, WT-2, WT-3, WT-4, WT-8, WT-9; WT-5/WT-6 are removal, not alpha; WT-7 is P7-1; WT-10 is P8-3; WT-11 unsupported).
- `docs/contracts/state-machines.md` line 22 (`preparing` = create worktree, adapter process and session); schema `TaskCreatedPayload.branch` / `worktree_path`.
- Behavior and test-scenario references (do not copy code): PR #28, SHA `489ba3d`:
  - `apps/runtime/worktrees.mjs` lines 10–11 (`SAFE_REF`, `SAFE_SHA`), 26–30 (default root outside repo), 74–84 (porcelain parsing), 86–113 (repo top level vs approved scope, no commits), 115–124 (target folder safety), 143–148 (roots must not overlap), 150–155 (root must not be a link), 228–290 `createNow` (branch first, then worktree, verify registration), 297–316 `undoFailedCreate` (compare-and-delete, never delete folders).
  - `apps/runtime/worktrees.test.mjs` test scenarios at lines 31, 58, 76, 87, 105, 117, 193, 245.
  - `docs/implementation/git-worktrees.md` (verification checklist items 1–7, 11, 13).
- Difference from PR #28: PR #28 kept a SQLite `worktrees` table with `creating/ready/partial/orphan/failed`; AgentDock records intent in `task.created` and derives state from a Git probe (P5-3), adding no event types outside the contract.

## 9. Dependencies

| crate | Version | Status |
| --- | --- | --- |
| `sha2` | added by P2-1 | — |
| `dunce` | 1.0.5 | added by P4-1 |
| `junction` (dev, `cfg(windows)`) | added by P4-1 | — |

## 10. Model tier

Strong model implements and reviews. Wrong undo logic can delete the user's branch or folder.

## 11. Common mistakes and pitfalls

- `git worktree add -b <branch> <path>` in one step: on failure you cannot tell whether this attempt created the branch. Follow WT-2's two steps.
- `remove_dir_all(path)` on failure: the folder may hold user files (e.g. an earlier partial checkout). Never delete.
- Cleaning up with `git branch -D`: deletes without checking the tip, possibly destroying someone else's commits. Use `update-ref -d <ref> <expected>`.
- Random branch names: not recomputable after a crash; use the task id hash.
- Case-sensitive comparison (Windows) or string `starts_with`: WT-9; use P4-1's comparison.
- Long paths: the folder name is deliberately just `task-<12 hex>` to keep deep repos under Windows MAX_PATH (PR #28 line 250 comment). Git for Windows' `core.longpaths` comes from the user's system config (P5-1 does not disable system config).
- Concurrent creates in one repo: Git's `.git/worktrees` metadata races; this packet uses one mutex per repo.
- Antivirus scanning `.git` slows checkout on Windows: keep the 120 s checkout timeout.

## 12. Reviewer checklist

- [ ] Is the branch created before the worktree, and is undo limited to compare-and-delete of a branch created in this attempt?
- [ ] Is there any code path that deletes a folder, prunes worktrees, or force-deletes a branch?
- [ ] Are names derived only from the task id, and is `create` idempotent across a simulated crash?
- [ ] Are root overlap and link checks done both in `new` and right before creating?
- [ ] Is the repo top level re-checked against the source scope after `rev-parse`?
- [ ] Does the failure test actually run on Linux (not silently skipped) and on Windows CI?
