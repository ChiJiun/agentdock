# P7-1: Git status and diff (WT-7 counts, changed-file list, per-file diff, Changes tab)

> **繁中摘要**：分兩個 PR。**P7-1a**：對 task worktree（每次先經 P5-3 `task_scope` 重新確認）唯讀讀出 HEAD／branch／upstream（`NoRemote`、`NoUpstream`、`Tracking`、`Gone` 分開，WT-7）、未 commit／未追蹤／ignored 數量、相對 task 起點的變更檔案清單與 `+a −d`；單檔 diff 只接受變更清單中的路徑（加 `:(literal)`），上限 512 KiB；敏感檔案只顯示統計不回傳內容；所有指令加 `--no-optional-locks`、`-z`，diff 加 `--no-ext-diff --no-textconv`。**P7-1b**：前端 Changes 分頁（狀態字母有文字標籤、diff 符號欄、全部用文字節點）。模型等級：一般模型可。

Issues: #9, #2 (UX) | Gate (#51): G5 (show Git status/diff) | Model tier: **standard model is enough**

Two PRs:

- **P7-1a**: `git::status` and `git::diff` in `agentdock-integrations`, plus Tauri commands.
- **P7-1b**: frontend Changes tab (file list, `+a −d`, diff with a +/− sign column).

## 1. Goal and non-goals

Goals:

- For the task's worktree (re-confirmed each time through P5-3 `task_scope`), read:
  - HEAD, branch and upstream state: `NoRemote`, `NoUpstream`, `Tracking { ahead, behind }` kept separate (WT-7), plus `Gone`.
  - Counts of uncommitted, untracked and ignored entries (WT-7).
  - Changed files relative to the task's starting point (base): kind letter A/M/D/R/?, `+added −removed`, binary or not.
- Per-file diff: accepts only paths in the current change set; output capped at 512 KiB, marked truncated beyond that.
- Sensitive files (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*.pfx`, `*.p12`) show stats only; content is never returned.
- Read-only: no Git command here writes the index, refs or working tree (`git status` refreshes the index stat cache; `--no-optional-locks` prevents that).

Non-goals: commit (P7-2), stage/unstage, editing diffs (IA: the review panel is read-only), inline comments (UX-66, after P8), cross-task comparison.

## 2. Prerequisites and parallel work

- P7-1a prerequisites: P5-1 (`Git`), P5-3 (`task_scope`), P3-7 (`AppState`, for commands).
- P7-1b prerequisites: P7-1a, P1-2.
- Parallel: P6-*, P7-3. P7-2 (show changes before commit) and P8-3 use this packet.

## 3. Files

P7-1a new:

- `crates/agentdock-integrations/src/git/status.rs`
- `crates/agentdock-integrations/src/git/diff.rs`
- `crates/agentdock-integrations/tests/git_status_diff.rs`
- `src-tauri/src/commands/changes.rs` (`changes_summary`, `changes_file_diff`)
- `src-tauri/tests/fixtures/ipc/changes_summary.json`

P7-1a modified: `crates/agentdock-integrations/src/git.rs` (exports; if `git.rs` becomes `git/mod.rs`, move it in this PR), `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/default.json`.

P7-1b new: `src/ipc/changes.ts`, `src/components/ChangesPanel.tsx`, `src/components/ChangesPanel.test.tsx`.

P7-1b modified: `src/App.tsx` (Inspector changes tab uses real data when `isTauri()`), `src/i18n/messages.ts`, `src/styles.css`.

## 4. Public types and signatures

```rust
// crates/agentdock-integrations/src/git/status.rs
use agentdock_policy::path_scope::ScopedPath;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpstreamState {
    NoRemote,                              // `git remote` is empty
    NoUpstream,                            // remote exists, branch has no upstream
    Tracking { upstream: String, ahead: u32, behind: u32 },
    Gone { upstream: String },             // configured upstream ref no longer exists
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct WorktreeStatusCounts {
    pub head_sha: Option<String>,          // None for an unborn branch
    pub branch: Option<String>,            // None when detached
    pub upstream: UpstreamState,
    pub staged: u32, pub unstaged: u32, pub untracked: u32, pub conflicted: u32,
    pub ignored: u32, pub ignored_capped: bool,   // stop counting at 10_000
}

pub async fn status_counts(git: &crate::git::Git, worktree: &ScopedPath)
    -> Result<WorktreeStatusCounts, crate::git::GitError>;

// crates/agentdock-integrations/src/git/diff.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind { Added, Modified, Deleted, Renamed, Untracked, TypeChanged, Conflicted }

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ChangedFile {
    pub path: String,                      // relative, '/' separators, as Git reports it (-z, no quoting)
    #[serde(skip_serializing_if = "Option::is_none")] pub old_path: Option<String>,
    pub kind: ChangeKind,
    #[serde(skip_serializing_if = "Option::is_none")] pub added: Option<u32>,    // None for binary
    #[serde(skip_serializing_if = "Option::is_none")] pub removed: Option<u32>,
    pub binary: bool,
    pub sensitive: bool,                   // content is never returned
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ChangeSet {
    /// Some(sha) = changes since the task's base commit (committed + uncommitted);
    /// None = base unknown, only uncommitted changes against HEAD are listed.
    pub base_sha: Option<String>,
    pub files: Vec<ChangedFile>,           // sorted by path; max 2_000, then `files_capped`
    pub files_capped: bool,
    pub added: u64, pub removed: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FileDiff {
    pub path: String,
    pub hunks_text: String,                // unified diff body starting at the first "@@"; lossy UTF-8
    pub truncated: bool,                   // over 512 KiB
}

#[derive(Debug, thiserror::Error)]
pub enum DiffError {
    #[error("path is not in the current change set")] NotChanged,
    #[error("content of sensitive files is not shown")] Sensitive,
    #[error("binary file")] Binary,
    #[error(transparent)] Git(#[from] crate::git::GitError),
}

pub fn is_sensitive_path(path: &str) -> bool;
pub async fn change_set(git: &crate::git::Git, worktree: &ScopedPath, base_sha: Option<&str>)
    -> Result<ChangeSet, crate::git::GitError>;
pub async fn file_diff(git: &crate::git::Git, worktree: &ScopedPath, base_sha: Option<&str>, path: &str)
    -> Result<FileDiff, DiffError>;
```

```rust
// src-tauri/src/commands/changes.rs
#[derive(serde::Serialize)]
pub struct ChangesSummary { pub status: WorktreeStatusCounts, pub changes: ChangeSet }
#[tauri::command] pub async fn changes_summary(state: tauri::State<'_, AppState>, task_id: String)
    -> Result<ChangesSummary, IpcError>;
#[tauri::command] pub async fn changes_file_diff(state: tauri::State<'_, AppState>, task_id: String, path: String)
    -> Result<FileDiff, IpcError>;
```

## 5. Implementation steps

### P7-1a

1. Write the §6 tests.
2. Every command uses `--no-optional-locks` (a global option: put it at the start of the args passed to P5-1 `run`, which places args after `-C`; Git accepts global options there) and `-z`; diff commands also use `--no-ext-diff --no-textconv --no-color` (repo config can name external diff and textconv programs; these flags stop them from running).
3. `status_counts`:
   - `git status --porcelain=v2 -z --branch --untracked-files=all`: parse `# branch.oid` (`(initial)` → `None`), `# branch.head` (`(detached)` → `None`), `# branch.upstream`, `# branch.ab +A -B`; for item lines `1`/`2`, XY first char not `.` → staged, second char not `.` → unstaged; `u` → conflicted; `?` → untracked. Note: with `-z`, type `2` (rename) entries have an extra NUL-separated original path field.
   - upstream: no `branch.upstream` → `git remote` empty → `NoRemote`, else `NoUpstream`; `branch.upstream` present but no `branch.ab` → `Gone`.
   - ignored: separately run `git status --porcelain=v2 -z --ignored=traditional --untracked-files=no`, count only `!` lines, stop at 10,000 and set `ignored_capped` (an ignored directory such as `node_modules/` counts as one).
4. `change_set`:
   - If `base_sha` is given: it must be 40/64 lowercase hex and `git cat-file -e <sha>^{commit}` must succeed; otherwise treat as `None`.
   - Tracked: `git diff --numstat -z -M <base or HEAD>` (working tree vs base, staged and unstaged); numstat `-\t-` → binary. Also run `git diff --name-status -z -M <base or HEAD>` for kind letters.
   - Untracked: from status `?` lines; files ≤ 1 MiB are read to count lines (a NUL in the first 8 KiB → binary); over 1 MiB → `added: None`. Before reading, check with the task scope's `WorkspaceScope::check(path, Some(worktree), Read)` (an untracked symlink/junction could point outside the worktree).
   - Unborn branch (no commits): everything is untracked/added; do not call `git diff <HEAD>`.
   - `sensitive = is_sensitive_path(path)`: compare the file name (case-insensitive) with `.env`, `.env.*`, `*.pem`, `*.key`, `*.pfx`, `*.p12`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`.
5. `file_diff`:
   - Recompute `change_set`; `path` must exactly equal some entry's `path` or `old_path` → else `NotChanged` (no arbitrary paths, no `..`).
   - `sensitive` → `Sensitive`; `binary` → `Binary`.
   - Tracked: `git diff -M --no-ext-diff --no-textconv --no-color <base or HEAD> -- :(literal)<path>` (path only after `--`, with the `:(literal)` prefix so pathspec magic is not interpreted).
   - Untracked: synthesize `@@ -0,0 +1,N @@` plus each line prefixed with `+` (max 512 KiB).
   - Return only the content from the first `@@` (header lines like `index` and mode are not needed).
6. Tauri commands: `ready()` → get the task's `WorktreePlan` → `task_scope` (not `Ready` → `IpcError { code: "worktree_not_ready" }`) → `base_sha` is the `head_sha` of **the task's first `task.checkpoint_recorded` that has a `worktree`** in the projection (P8-3 writes it after creating the worktree); none → `None`.

### P7-1b

1. `ChangesPanel`:
   - Header: with `base_sha`, "Since task start: N files +a −d"; with `None`, "Start point unknown; showing only uncommitted changes".
   - Status line (WT-7): uncommitted / untracked / ignored counts; upstream text per state: "No remote", "No upstream", "Ahead a, behind b", "Upstream no longer exists".
   - File list: kind letter (A/M/D/R/?/T/U) + path (`old_path → path`) + `+a −d` ("binary" for binary); each letter also has a text label (`aria-label` and tooltip), not color alone.
   - Click a file → `changes_file_diff`; diff shows two columns: sign (`+` / `−` / blank) and content; all text nodes. `Sensitive` → "This file may contain secrets; AgentDock does not show its content"; `Binary` → "Binary file".
2. `App.tsx`: poll `changes_summary` every 3 s while the Inspector is on the changes tab; demo mode unchanged.

## 6. Tests to write first

`crates/agentdock-integrations/tests/git_status_diff.rs` (temp repo, path with a space and CJK; `Git` from P5-1 discovery):

| Test | Expected |
| --- | --- |
| `clean_repo_counts_zero` | one commit → all counts 0, `NoRemote` |
| `staged_unstaged_untracked_counted` | one of each → `staged 1`, `unstaged 1`, `untracked 1` |
| `conflict_counted` | create a merge conflict → `conflicted 1` |
| `ignored_counted_and_capped` | `.gitignore` has `build/`, create `build/a` → `ignored ≥ 1`; create 10,001 ignored top-level files → `ignored_capped` |
| `no_remote_vs_no_upstream_vs_tracking` | no remote → `NoRemote`; add a local bare repo as remote without upstream → `NoUpstream`; `push -u` then one more commit → `Tracking { ahead: 1, behind: 0 }` |
| `upstream_gone` | set upstream, delete the branch on the remote, `fetch --prune` → `Gone` |
| `detached_and_unborn` | `checkout --detach` → `branch: None`; `git init` without commits → `head_sha: None`, `change_set` lists the untracked files |
| `change_set_since_base_includes_commits` | after base, commit one file and modify another uncommitted → both listed |
| `change_set_without_base_is_uncommitted_only` | same, `base_sha: None` → only the uncommitted one |
| `invalid_base_falls_back_to_none` | `base_sha: Some("zzz")` → `ChangeSet.base_sha == None` |
| `rename_detected` | `git mv a b` → `Renamed`, `old_path == "a"` |
| `binary_detected` | add a file containing NUL → `binary: true`, `added: None` |
| `path_with_spaces_cjk_and_newline_ok` | file `空白 檔案.txt`, and under `cfg(unix)` a name containing a newline → paths appear verbatim (`-z` parsed correctly) |
| `sensitive_file_content_refused` | add `.env` and `config/server.PEM` → `sensitive: true`; `file_diff` → `Sensitive` |
| `diff_rejects_unlisted_path` | `file_diff(.., "../outside.txt")` and an unchanged `README.md` → `NotChanged` |
| `pathspec_magic_not_interpreted` | change set contains a file named `:(glob)*` (`cfg(unix)`) or `[a].txt` (`cfg(windows)`), plus another changed file → the diff contains only that file |
| `untracked_diff_synthesized` | new file with three lines → `hunks_text` starts with `@@ -0,0 +1,3 @@`, three `+` lines |
| `diff_truncated_over_limit` | modify a 1 MiB text file → `truncated: true`, length ≤ 512 KiB |
| `external_diff_and_textconv_not_run` | repo `.git/config` sets `diff.external` and `diff.x.textconv` to P5-1's `agentdock-test-marker`, `.gitattributes` has `*.txt diff=x` → after `change_set` and `file_diff`, the marker does not exist |
| `status_does_not_take_index_lock` | while another thread holds `.git/index.lock` → `status_counts` still succeeds (`--no-optional-locks`) |
| `untracked_link_outside_not_read` | inside the worktree create a symlink (`cfg(unix)`) / junction (`cfg(windows)`) to an outside folder → its content is not read (`added: None` or not listed) |

`src/components/ChangesPanel.test.tsx`:

| Test | Expected |
| --- | --- |
| `header_with_and_without_base` | both header texts |
| `upstream_four_states_text` | text for each of the four upstream states |
| `status_letters_have_text_labels` | every letter element has a readable `aria-label` |
| `diff_sign_column_rendered` | lines `+x`, `-y`, ` z` → sign column `+`, `−`, blank |
| `diff_rendered_as_text` | content containing `<script>` → no `script` element in the DOM |
| `sensitive_and_binary_messages` | both errors show their texts |
| `ipc_fixture_matches_type_guard` | `changes_summary.json` → type guard true |

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-integrations --test git_status_diff -- --test-threads=1   # 21 pass (cfg variants pick the OS-specific scenario)
npm run typecheck && npm test && npm run build                                    # 7 new tests pass
```

Windows-only (CI `rust-windows`): the `[a].txt` and junction variants run on `windows-latest`; confirm `pathspec_magic_not_interpreted` and `untracked_link_outside_not_read` are `ok` in the job log.

## 8. Spec references and porting sources

All line numbers refer to main `c9e33cf`.

- ADR-0002 line 141 WT-7 (uncommitted, ignored, unpushed counts; no upstream vs no remote kept separate), line 142 WT-8 (no shell; minimum Git version).
- `docs/ux/acceptance-criteria.md` line 95 UX-64 (status letters, +/− counts, diff sign column).
- `docs/ux/information-architecture.md` line 78 (Changes tab), line 119 (review panel read-only).
- `docs/ux/flows.md` line 21 ("Review changes · N files +a −d").
- `git status` porcelain v2 format: official Git docs `git-status`, "Porcelain Format Version 2" (verify against the local `git help status` when implementing).
- Field reference only (do not copy code): PR #28, SHA `489ba3d`, status fields in `apps/runtime/worktrees.mjs`.

## 9. Dependencies

No new crates.

## 10. Model tier

Standard model is enough.

## 11. Common mistakes and pitfalls

- Omitting `-z`: paths with spaces, CJK or quotes get quoted and escaped by Git and parse wrong.
- `git diff` without `--no-ext-diff --no-textconv`: repo config could make AgentDock run arbitrary programs.
- Passing the IPC `path` straight to `git diff -- <path>`: pathspec syntax like `:(top)` or `*` widens the scope; accept only listed paths and add `:(literal)`.
- Comparing only with HEAD: after the agent commits, the Changes tab goes empty. Compare with the task start.
- Merging `NoRemote` and `NoUpstream` into "not pushed": WT-7 requires them separate; they are handled differently (P7-2 offers no push for `NoRemote`).
- Writing diff content into events or logs: diffs may contain secrets; show live in the UI only, never persist.
- `git status` without `--no-optional-locks`: races the agent for `index.lock` and makes the agent's git commands fail.

## 12. Reviewer checklist

- [ ] Do all commands use `-z` and `--no-optional-locks`, and do all diff commands use `--no-ext-diff --no-textconv`?
- [ ] Does `file_diff` accept only paths from a freshly computed change set, with `:(literal)` after `--`?
- [ ] Is sensitive-file content never returned, and are untracked links outside the worktree never read?
- [ ] Are the four upstream states distinct end to end (Rust enum, JSON, UI text)?
- [ ] Is diff content kept out of events, logs and artifacts?
