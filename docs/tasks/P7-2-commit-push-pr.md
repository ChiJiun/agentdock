# P7-2: Commit, push and create PR (checkpoint, `execute_guarded`, reconciliation)

> **繁中摘要**：分兩個 PR。**P7-2a**：`commit_all`（暫存區有敏感檔案就拒絕並只還原 index）、commit 後寫 checkpoint；`push` 只推 task 自己的 branch、只 fast-forward，**只能推通過 local checks 的那個 commit**，依契約經 P4-3b `execute_guarded`（先記錄意圖、核准、started、再執行）；push 失敗先用 `ls-remote` 判斷是否已生效；當機後只做唯讀對帳，不自動重推。**P7-2b**：用 P7-3 的 `Gh::request(GhRequest::PrCreate{..})` 建 PR，effect 先依 head branch 查既有 PR（不會重複開），內文用 `--body-file` 傳、不放命令列；標題或內文被 redaction 改變就拒絕送出。模型等級：強模型實作＋強模型審查。

Issues: #10, #9, #8 | Gate (#51): G5 (can create commits; human confirmation before PR), G7 (denied operations never run), G8 (no duplicate push/PR after restart) | Model tier: **strong model implements and reviews**

Two PRs:

- **P7-2a**: commit (with sensitive-file blocking), checkpoint, `git_push` (through P4-3b `execute_guarded`) and push reconciliation.
- **P7-2b**: `pr_create` (through `execute_guarded`, using P7-3's `Gh`) and PR reconciliation.

## 1. Goal and non-goals

Goals:

- `commit_all`: in the task worktree, `git add -A` + `git commit`, with a commit message the user confirmed or edited in the UI. If sensitive files (P7-1 `is_sensitive_path`) are staged, refuse and reset the index (index only; the working tree is untouched). After the commit, write `task.checkpoint_recorded` (with `worktree{head_sha, branch, dirty:false}`).
- `push`: pushes only the task's own branch (`agentdock/task-*`, P5-2), fast-forward only (no `+` in the refspec, no `--force`), in contract order through `execute_guarded`: `operation.recorded` → `approval.requested(host_policy)` → T33 → user approval → T18 → `operation.started` → push → `operation.succeeded` / `failed` (fixture 01 events 38–44).
- **Only the tested commit may be pushed**: HEAD must equal the `head_sha` of the checkpoint recorded when the task last entered `verifying`, and every local check after that must have passed; otherwise refuse with "content changed after checks; go back to running and verify again" (matches PR #29: "reviewed commit, PR head and CI commit must be the tested commit").
- `create_pr`: after a successful push, create a PR through `execute_guarded`. The effect first looks up an open PR for the head branch and returns it if found (a retry after a crash never opens a second PR).
- Reconciliation (read-only): `reconcile_push` (`git ls-remote` vs `expected_sha`) and `reconcile_pr_create` (PR lookup by head) write `operation.reconciled{finding, evidence}`.
- PR title and body go through `Redactor` before sending; **if redaction changes the text, refuse to send** (never silently rewrite text the user approved) and ask the user to edit it.

Non-goals:

- `pr_update`, `pr_comment`, `pr_merge` (P8-4; merge is only ever approved by the user).
- Force push (a `destructive_command`, not offered in alpha), rebase, squash, history rewriting.
- Pushing any ref other than the task branch; pushing to forks (alpha only pushes to `origin`, the same GitHub repo).
- Auto-generating commit messages or PR bodies (the agent may draft them, but they must be shown to the user and confirmed on the approval card).
- State transitions T28/T34 (P8-3; this packet only returns results).

## 2. Prerequisites and parallel work

- P7-2a prerequisites: P4-3b (`execute_guarded`), P5-1, P5-3, P7-1 (`status_counts`, `is_sensitive_path`), P2-5 (Rule 9: `git_push`'s `operation.started` requires the latest checkpoint's `head_sha == expected_sha` and `dirty=false`).
- P7-2b prerequisites: P7-2a, P7-3 (`Gh`, `GhRequest::PrCreate`, `GitHubRepo`, `pr_lookup_by_head`, `default_branch`, `parse_created_pr_url`).
- Parallel: P6-2, P8-1. P8-3 and P8-4 use this packet.

## 3. Files

P7-2a new:

- `crates/agentdock-integrations/src/git/write.rs` (`commit_all`, `push_ref`, `remote_ref_sha`)
- `crates/agentdock-orchestrator/src/publish.rs` (`PublishService::commit`, `push`, `reconcile` for `git_push`)
- `crates/agentdock-integrations/tests/git_write.rs`
- `crates/agentdock-orchestrator/tests/publish_push.rs`

P7-2b new:

- `crates/agentdock-orchestrator/src/publish_pr.rs` (`PublishService::create_pr`, `reconcile` for `pr_create`)
- `crates/agentdock-orchestrator/tests/publish_pr.rs`

Modified: `crates/agentdock-integrations/src/git.rs` (or `git/mod.rs`), `crates/agentdock-orchestrator/src/lib.rs`, `src-tauri/src/commands/` (new `publish.rs`: `task_commit`, `task_push`, `task_create_pr`, `operation_reconcile`; update `build.rs` and `capabilities/default.json`).

## 4. Public types and signatures

```rust
// crates/agentdock-integrations/src/git/write.rs
use agentdock_policy::path_scope::ScopedPath;

pub const MAX_COMMIT_MESSAGE_CHARS: usize = 8_000;   // passed as argv; well below the 32,767-char Windows limit

#[derive(Debug, thiserror::Error)]
pub enum WriteError {
    #[error("nothing to commit")] NothingToCommit,
    #[error("sensitive files would be committed: {0:?}")] SensitiveFiles(Vec<String>),  // index already restored
    #[error("invalid commit message")] BadMessage,
    #[error("branch {0} is not an AgentDock task branch")] NotTaskBranch(String),
    #[error("invalid remote or sha")] BadArgument,
    #[error("push rejected by remote (non-fast-forward or protected)")] Rejected,
    #[error(transparent)] Git(#[from] crate::git::GitError),
}

pub struct Committed { pub head_sha: String, pub branch: String }

/// git add -A; check staged names; git commit -m <message>. Uses the user's own user.name/user.email.
pub async fn commit_all(git: &crate::git::Git, worktree: &ScopedPath, message: &str) -> Result<Committed, WriteError>;

/// git push --porcelain <remote> <sha>:refs/heads/<branch>. Never force, never other refs.
pub async fn push_ref(git: &crate::git::Git, worktree: &ScopedPath, remote: &str, branch: &str, sha: &str)
    -> Result<(), WriteError>;

/// git ls-remote --refs <remote> refs/heads/<branch>. Ok(None) = ref absent on the remote.
pub async fn remote_ref_sha(git: &crate::git::Git, worktree: &ScopedPath, remote: &str, branch: &str)
    -> Result<Option<String>, crate::git::GitError>;
```

```rust
// crates/agentdock-orchestrator/src/publish.rs
pub struct PublishService { /* Arc<Store>, Arc<ApprovalService>, Arc<WorktreeManager>, Arc<Git>, Option<Arc<Gh>>, Redactor, host_env */ }

#[derive(Debug, thiserror::Error)]
pub enum PublishError {
    #[error("task is in {0}, expected {1}")] WrongState(String, &'static str),
    #[error("worktree not ready")] WorktreeNotReady,
    #[error("worktree has uncommitted changes")] Dirty,
    #[error("HEAD differs from the commit that passed local checks")] UntestedCommit,
    #[error("repository has no remote")] NoRemote,
    #[error("remote is not a supported GitHub repository")] UnsupportedRemote,
    #[error("text contains what looks like a secret; edit it before sending")] SecretInText,
    #[error("no successful push in this PR round")] NotPushed,
    #[error("a previous attempt has an unknown outcome; reconcile it first")] NeedsReconcile,
    #[error("already pushed")] AlreadyDone { remote_sha: String },
    #[error("operation is not in a reconcilable state")] NotReconcilable,
    #[error(transparent)] Write(#[from] agentdock_integrations::git::WriteError),
    #[error(transparent)] Gh(#[from] agentdock_integrations::github::GhError),
    #[error(transparent)] Guard(#[from] crate::guarded::GuardError),
    #[error(transparent)] Store(#[from] agentdock_store::Error),
}

pub struct PrRequest { pub title: String /* 1..=256, single line */, pub body: String /* <= 65_536 */, pub base: Option<String>, pub draft: bool }
pub struct PublishedPr { pub number: u64, pub url: String, pub reused_existing: bool }

impl PublishService {
    /// Task state must be running (before verifying) or pr. Writes task.checkpoint_recorded after the commit.
    pub async fn commit(&self, task: &TaskId, message: &str) -> Result<agentdock_integrations::git::Committed, PublishError>;
    /// Task state must be pr. Returns remote_sha.
    pub async fn push(&self, task: &TaskId) -> Result<String, PublishError>;
    pub async fn create_pr(&self, task: &TaskId, req: PrRequest) -> Result<PublishedPr, PublishError>;   // P7-2b
    /// Read-only probe for an operation in outcome_unknown; writes operation.reconciled. (failed{effect: unknown} cannot
    /// be reconciled in the contract; see §5 — it returns NeedsReconcile and is shown to the user.)
    pub async fn reconcile(&self, operation: &OperationId) -> Result<ReconcileFinding, PublishError>;
}
```

## 5. Implementation steps

### P7-2a

1. Write the §6 tests.
2. `commit_all`:
   1. Message: after trimming trailing whitespace, 1..=8,000 chars, no NUL → else `BadMessage`.
   2. `git add -A`; `git diff --cached --name-only -z` for the staged list; empty → `NothingToCommit`.
   3. Any staged `is_sensitive_path` file → `git reset -q` (index only) → `SensitiveFiles(list)`.
   4. `git commit -m <message>` (hooks are already disabled by P5-1; do not change `user.*` or disable the user's commit-signing config).
   5. `rev-parse HEAD` and `symbolic-ref --short HEAD` → `Committed`.
3. `push_ref`:
   - `branch` must match `^agentdock/task-[0-9a-f]{12}$` → else `NotTaskBranch` (blocks `main`, `refs/heads/main`, `+x` and the like).
   - `sha` must be 40/64 lowercase hex; `remote` must be a name from `git remote` (no URLs) → else `BadArgument`.
   - Command: `git push --porcelain <remote> <sha>:refs/heads/<branch>`, timeout 120 s (P5-1).
   - In porcelain output, the ref line starting with `!` → `Rejected`.
4. `PublishService::commit`: task in `running` or `pr`; re-probe `task_scope`; `commit_all`; one transaction writes `task.checkpoint_recorded{phase: <current state>, through_seq, worktree{head_sha, branch, dirty: false}, open_operation_ids, pending_approval_ids}` (actor `orchestrator`).
5. `PublishService::push`:
   1. State must be `pr`.
   2. `task_scope`; `status_counts`: any staged/unstaged/untracked → `Dirty`; `upstream == NoRemote` → `NoRemote`.
   3. **Tested commit**: from the projection, find the `task.checkpoint_recorded` written right after the latest `→ verifying` transition (P8-3 writes it on entering verifying); it must have `worktree.dirty == false` and its `head_sha` must equal the current HEAD, and the `local_checks` fact must be `{started ≥ 1, all_passed}` → else `UntestedCommit`.
   4. Idempotency (Rule 5) by the previous operation with the same `idempotency_key`:
      - `succeeded` or `reconciled_applied` → return `AlreadyDone { remote_sha }` with no new events (documented choice; the Tauri command maps it to success).
      - `outcome_unknown` → `NeedsReconcile`. (`failed{effect: unknown}` is never written by this packet; if one exists it is a dead end in the contract — it can be neither reconciled nor superseded — so return `NeedsReconcile` and surface it to the user; listed in README "Existing document issues".)
      - `abandoned` / `failed{none}` / `reconciled_not_applied` / `reconciled_undeterminable` → set `supersedes_operation_id` to it.
   5. Write a new checkpoint (`phase: pr`, `dirty: false`, `head_sha`) — Rule 9 checks "the latest checkpoint", so write one before every push.
   6. `execute_guarded(OperationRequest { kind: git_push, target: {description: "push <branch> to <remote>", remote, ref: "refs/heads/<branch>", expected_sha: head}, reconcile_strategy: remote_ref_compare, return_state: Some(pr), supersedes_operation_id })`.
   7. effect: `push_ref` →
      - `Ok` → `Succeeded { result: {"remote_sha": head} }`.
      - `Err(Rejected)` (porcelain `!` line: the remote refused the update), or the process could not be spawned → `Failed { effect: None, error }`. These are the **only** cases that may claim "nothing happened" (Rule 5, `checkpoint-and-replay.md` line 104).
      - Any other `Err` (timeout, kill, network error, unparseable output) → `remote_ref_sha`: equals `head` → `Succeeded` (the push landed); anything else (different, absent, or the query fails) → `EffectOutcome::Unknown { error }` → `operation.outcome_unknown{cause: killed}`. Do **not** write `failed` here: a killed push may still land later.
      - Redact `error` and cut it to 240 chars.
6. `reconcile` (kind `git_push`): `remote_ref_sha == expected_sha` → `applied`; readable and different or absent → `not_applied`; read failure → `undeterminable`. Write `operation.reconciled{finding, evidence: "remote ref = <sha or absent>"}`, actor `integration`. Only for operations in `outcome_unknown` (validator line 1063); other states → `NotReconcilable`. **Reconciliation never re-runs the push.**

### P7-2b

1. Write the §6 tests.
2. `create_pr`:
   1. State `pr`; this round (after the latest T28) has a `git_push` that is `succeeded` or `reconciled_applied` → else `NotPushed`.
   2. `GitHubRepo::from_remote_url(<origin URL from git remote get-url origin>)` (P7-3) → `None` → `UnsupportedRemote`.
   3. Title and body: if `Redactor::redact_text` changes either → `SecretInText`; length limits per `PrRequest`. A title with a newline or NUL is rejected by `GhRequest::argv` validation and surfaces as `Gh(BadArgument)`; check it before `execute_guarded` so no operation is recorded.
   4. `base`: if not given, P7-3 `default_branch(gh, cwd, repo, env)`.
   5. Previous operation with the same key: same rules as push step 4 (`succeeded`/`reconciled_applied` → return the recorded PR; unknown → `NeedsReconcile`).
   6. `execute_guarded(kind: pr_create, target: {description: "create PR \"<first 80 chars of title>\" <branch> → <base>", ref: <branch>, base}, reconcile_strategy: pr_lookup_by_head, return_state: Some(pr))`.
   7. effect:
      1. `pr_lookup_by_head(gh, cwd, repo, branch, env)`; an `Open`/`Draft` PR → `Succeeded { result: {pr_number, url, reused_existing: true} }`.
      2. Otherwise write the body to a temp file under app data (`tempfile::NamedTempFile`, deleted after the call; **never on the command line**) and call `gh.request(cwd, &GhRequest::PrCreate { repo, head: branch, base, title, body_file, draft }, env)`.
      3. `Ok(stdout)` → `parse_created_pr_url(stdout, repo)` → `Some((number, url))` → `Succeeded`; `None` → treat as failure and go to 4.
      4. `Err(GhError::Timeout)` → `Unknown` (never `Failed`; a timed-out create may still land). Other `Err` or unparseable output → lookup again: found → `Succeeded`; definitely none (gh exited non-zero and the lookup succeeded with no PR for this head) → `Failed { effect: None }`; lookup fails → `Unknown`.
3. `reconcile` (kind `pr_create`): lookup finds a PR (any state) with that head in this repo → `applied` (evidence = PR URL); definitely none → `not_applied`; gh failure → `undeterminable`.

## 6. Tests to write first

`crates/agentdock-integrations/tests/git_write.rs` (temp repo + local bare repo as `origin`; paths with a space and CJK):

| Test | Expected |
| --- | --- |
| `commit_creates_commit_with_message` | modify a file → the commit at `Committed.head_sha` has the input message |
| `nothing_to_commit` | clean worktree → `NothingToCommit` |
| `sensitive_file_blocks_and_restores_index` | add `.env` and `a.txt` → `SensitiveFiles([".env"])`; afterwards `git diff --cached` is empty and both files remain in the working tree |
| `bad_message_rejected` | empty, whitespace only, contains NUL, 8,001 chars → `BadMessage` |
| `hooks_not_run_on_commit` | `.git/hooks/pre-commit` writes a marker (as in P5-1, executable bit set on Unix) → no marker after commit |
| `push_fast_forward_ok` | commit then `push_ref` → bare repo ref equals sha |
| `push_non_fast_forward_rejected_not_forced` | first point the branch in the bare repo at another commit → `Rejected`; bare repo ref unchanged |
| `push_refuses_non_task_branch` | `main`, `refs/heads/main`, `+agentdock/task-aaaaaaaaaaaa`, `agentdock/task-AAAAAAAAAAAA` → `NotTaskBranch`, git not run |
| `push_refuses_url_remote` | `remote = "https://example.invalid/x.git"` → `BadArgument`, git not run |
| `remote_ref_sha_absent_and_present` | before push `None`; after push `Some(sha)` |

`crates/agentdock-orchestrator/tests/publish_push.rs` (temp store + repo + bare origin; task advanced to `pr` with fixture-01-style events, including one `passed` local check and the checkpoint written on entering verifying; approval simulated with P4-3 `resolve_by_user`):

| Test | Expected |
| --- | --- |
| `push_event_order_matches_fixture_01` | after approval, event types and actors in order: `task.checkpoint_recorded`(orchestrator), `operation.recorded`(orchestrator), `approval.requested`(policy), `task.state_changed pr→awaiting_approval`, `approval.resolved`(user), `task.state_changed awaiting_approval→pr`, `operation.started`(orchestrator), `operation.succeeded`(integration) |
| `denied_push_never_runs` | user denies → `operation.abandoned`; bare repo has no such ref |
| `dirty_worktree_refused` | uncommitted file → `Dirty`, no events |
| `untested_commit_refused` | another commit after checks passed → `UntestedCommit`, no `operation.recorded` |
| `failed_check_refused` | latest local check `failed` → `UntestedCommit` |
| `wrong_state_refused` | task in `running` → `WrongState` |
| `same_push_twice_does_not_duplicate` | second `push` after success (same HEAD) → `AlreadyDone`, no new `operation.recorded` |
| `crash_after_started_then_reconcile_applied` | simulate a crash right after the push lands inside the effect (drop the service, run P2-6 recovery) → `outcome_unknown{host_crash}`; `reconcile` → `applied`; the bare repo was pushed once (its reflog for the ref has one entry; enable `core.logAllRefUpdates=true` on the bare repo in setup) |
| `crash_before_push_reconcile_not_applied` | crash after `operation.started`, before push → `reconcile` → `not_applied`; no automatic re-push |
| `new_push_blocked_while_outcome_unknown` | `push` while a push is `outcome_unknown` → `NeedsReconcile` |
| `superseding_push_after_not_applied` | `push` after `not_applied` → new `operation.recorded` with `supersedes_operation_id`, and a new approval is required |
| `push_timeout_is_outcome_unknown` | push to the local bare origin with a 1 ms push timeout (test-only constructor on `PublishService`) so git is killed → `operation.outcome_unknown{killed}`, never `operation.failed`; a later `reconcile` decides |
| `push_error_text_redacted` | origin URL `https://user:ghp_000…@127.0.0.1:1/x.git`, push fails → `operation.failed.error` has no token |

`crates/agentdock-orchestrator/tests/publish_pr.rs` (P7-3's fake `gh` binary and script, installed with `fake_gh::install`; origin URL set to `https://github.com/o/r.git` via `git remote set-url` — no real push happens in these tests: seed the store with a `git_push` operation that `succeeded` in this round):

| Test | Expected |
| --- | --- |
| `pr_requires_push_this_round` | no successful push → `NotPushed` |
| `pr_create_event_order` | after approval: `operation.recorded(pr_create, target{ref, base})` … `operation.succeeded{result{pr_number, url}}` |
| `existing_pr_reused_not_duplicated` | fake gh `pulls?head=` returns one open PR → `reused_existing`; `fake-gh.log` has no `pr create` call |
| `retry_after_crash_finds_pr` | crash after `pr create` → `reconcile` → `applied`; `pr create` is not called again |
| `body_passed_by_file_not_argv` | `fake-gh.log` argv has no body text and has `--body-file <path>`; the file no longer exists after the call |
| `secret_in_body_refused` | body contains `ghp_` + 36 `0`s → `SecretInText`, no events |
| `unsupported_remote_refused` | origin `https://gitlab.example/x.git` → `UnsupportedRemote` |
| `denied_pr_never_created` | user denies → no `pr create` in `fake-gh.log` |
| `gh_timeout_is_outcome_unknown` | fake gh sleeps past the timeout on `pr create` → `operation.outcome_unknown{killed}` |
| `gh_failure_then_lookup_empty_is_failed_none` | `pr create` exits non-zero, lookup empty → `operation.failed{effect: none}` |

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-integrations --test git_write -- --test-threads=1        # 10 pass
cargo test -p agentdock-orchestrator --test publish_push -- --test-threads=1     # 13 pass
cargo test -p agentdock-orchestrator --test publish_pr -- --test-threads=1       # 10 pass (P7-2b)
```

Windows-only (CI `rust-windows`): the same three suites pass on `windows-latest` (fake gh copied with `.exe`).

Manual (owner, after P7-2b, against a throwaway GitHub test repo — **never** `ChiJiun/agentdock`): approve push and PR in the UI → a PR appears on GitHub; close and reopen AgentDock → no second PR.

## 8. Spec references and porting sources

All line numbers refer to main `c9e33cf`.

- `docs/contracts/checkpoint-and-replay.md` lines 71–83 (Classification: `git_push` identity is `remote`, `ref`, `expected_sha`; `pr_create` is `ref`, `base`; force push is `destructive_command`), lines 98–113 (Rules 1–11: record intent first, one approval one execution, no duplicate keys, read-only reconciliation; line 111 Rule 9: push bound to a checkpoint).
- `docs/contracts/fixtures/01-happy-path-pr.jsonl` events 38–44 (push event order and target example).
- `docs/contracts/state-machines.md` lines 127–128 (T33, T34), line 175 (`pr_published_this_round`).
- `docs/tasks/P2-5-projections-conformance.md` §4 (Rule 9: checkpoint conditions for `git_push`).
- ADR-0002 line 130 APR-10 (push asks by default), line 150 PRL-1 (reviewed SHA must equal PR head), line 159 PRL-10 (`gh` argument allowlist).
- Issue #10 Requirements items 5 and 8 (explicit approval before push/PR; replay after crash creates no duplicate PR).
- Scenario references (do not copy code): PR #29, SHA `c57b824`, `apps/runtime/task-workflow.test.mjs` line 195 (reviewed commit, PR head and CI commit must be the tested commit), line 340 (retried requests are idempotent: no duplicate tasks/evidence/transitions), line 470 (PR URL must belong to the task's repo).

## 9. Dependencies

| crate | Version | Status |
| --- | --- | --- |
| `tempfile` | 3.x (MIT OR Apache-2.0) | already a dev-dependency; promoted to a normal dependency here — **needs audit** (license check only) |

## 10. Model tier

Strong model implements and reviews. This is AgentDock's first feature with irreversible external effects; a mistake in order, idempotency or reconciliation causes duplicate PRs or unapproved pushes.

## 11. Common mistakes and pitfalls

- `git push origin HEAD`: the agent may move HEAD before the push; always push `<expected_sha>:refs/heads/<branch>`.
- Adding `--force-with-lease` "for safety": it still rewrites remote history, a `destructive_command`; not in this packet.
- Marking push failure as `failed{effect: none}`: after a timeout or network drop the push may have landed (or land later). Only a remote rejection or a spawn failure is `none`; everything else is `outcome_unknown` and goes through reconciliation.
- Committing during `pr` (allowed by `commit`) makes the next push fail with `UntestedCommit` by design: new content must go back through verifying.
- "Pushing again to be safe" after a crash: violates Rule 4; only reconcile. A second push needs a new operation and a new approval.
- PR body on the command line: Windows caps the command line at 32,767 chars and the text shows in process listings; use `--body-file`.
- Sending the PR body after redaction changed it: the user approved the original; sending a rewrite means sending unapproved content. Refuse instead.
- `git add .` plus `.gitignore` exceptions missing sensitive files: checking the staged list after `add -A` is the reliable way.
- Skipping the pre-push checkpoint: the projector rejects `operation.started` under Rule 9 and `execute_guarded` returns `Rejected`. That is intended protection; do not loosen the projector to make tests pass.

## 12. Reviewer checklist

- [ ] Is the pushed refspec always `<expected_sha>:refs/heads/agentdock/task-<12 hex>`, never forced, never another ref?
- [ ] Is "only the tested commit" enforced from projection facts, not from the frontend?
- [ ] Does every push/PR go through `execute_guarded`, with the effect only after `operation.started`?
- [ ] Is `failed{effect: none}` written only for a remote rejection (`!`) or a spawn failure, and every timeout/kill written as `outcome_unknown`?
- [ ] Is reconciliation read-only, and are repeat requests idempotent (`AlreadyDone`, `NeedsReconcile`, `supersedes_operation_id`)?
- [ ] Does P7-2b use only `GhRequest::PrCreate` (closed enum), pass the body by file, and refuse redaction-altered text?
