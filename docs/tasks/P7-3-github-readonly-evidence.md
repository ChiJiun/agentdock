# P7-3: GitHub CLI wrapper and read-only evidence (issues, PR lookup, PR head, CI checks)

> **繁中摘要**：在 `agentdock-integrations` 建立 `Gh` 包裝：只用使用者已登入的 `gh`，參數只能是白名單中的固定形狀（PRL-10），環境變數白名單擋掉 `GH_HOST`／`GH_REPO`，錯誤訊息不帶 stderr。提供唯讀查詢：開啟的 issue、依 head branch 找 PR、PR 目前的 head SHA、某個 PR head 的 CI 狀態（PRL-6 的 `bucket` 規則；分頁不完整或 head 中途改變時不得回報成功）。另外提供 P7-2b 唯一的寫入形狀 `pr create`。附一個假的 `gh` 測試執行檔，讓 Linux 上能完整測試。模型等級：一般模型實作＋強模型審查。

Issues: #10, #15 | Gate (#51): G5 (PR flow), G6 (real CI evidence, not agent claims) | Model tier: **standard model implements, strong model reviews**

## 1. Goal and non-goals

Goals:

- `Gh`: discover the user's `gh` executable (absolute path), run it without a shell, with an allow-listed environment, timeouts, output caps, and **only argument shapes from a closed enum** (ADR-0002 PRL-10). Repository is always passed explicitly (`--repo owner/name` or a fixed `repos/{owner}/{name}/...` path) and must be `github.com`.
- `GitHubRepo::from_remote_url`: parse `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)`, `ssh://git@github.com/o/r(.git)`; anything else is unsupported.
- Read-only queries:
  - `open_issues(repo)` for the issue picker (issue #10 "GitHub Issue picker"): excludes pull requests, bounded pages, `truncated` flag.
  - `pr_lookup_by_head(repo, branch)` (used by P7-2 for idempotent PR creation and reconciliation).
  - `pr_head(repo, number)`: state, draft, head SHA, head ref, base ref, URL, author login.
  - `ci_for_pr(repo, number, expected_head)`: CI checks via `gh pr checks <n> --json name,state,bucket,link,workflow`, mapped to a verdict with PRL-6 rules, and **re-reads the PR head before and after** so CI of an older commit is never attributed to a newer one.
  - `default_branch(repo)`.
- The only write shape: `pr_create` (used only by P7-2b through `execute_guarded`).
- A fake `gh` test binary so every behaviour is testable on Linux without network.

Non-goals: writing CI results into events (P8-4), merge (`gh pr merge`, alpha does not implement it), PR comments/reviews, GitHub Enterprise hosts, OAuth flows (the user runs `gh auth login` themselves), GitHub Apps, webhooks.

## 2. Prerequisites and parallel work

- Prerequisites: P3-2 (`agentdock_process::child_env`), P4-1 (`ScopedPath`), P5-1 (process-running pattern and `Git` for reading `remote.origin.url`).
- Parallel: P6-*, P7-1, P8-1. Used by P7-2b, P8-4, and the issue picker in P8-3.

## 3. Files

New:

- `crates/agentdock-integrations/src/github/mod.rs` (`Gh`, `GhError`, `GitHubRepo`)
- `crates/agentdock-integrations/src/github/shapes.rs` (`GhRequest` closed enum → argv)
- `crates/agentdock-integrations/src/github/read.rs` (queries and verdict mapping)
- `crates/agentdock-integrations/src/bin/agentdock-test-fake-gh.rs` (`[[bin]]`, `test = false`, not shipped)
- `crates/agentdock-integrations/tests/github_read.rs`
- `crates/agentdock-integrations/tests/support/fake_gh.rs` (helper: copy the fake binary into a temp dir with a script)

Modified: `crates/agentdock-integrations/src/lib.rs`, `crates/agentdock-integrations/Cargo.toml`.

## 4. Public types and signatures

```rust
// crates/agentdock-integrations/src/github/mod.rs
use std::{path::{Path, PathBuf}, time::Duration};

pub const GH_TIMEOUT: Duration = Duration::from_secs(60);
pub const MAX_STDOUT: usize = 8 * 1024 * 1024;
pub const MAX_PAGES: u32 = 5;

/// Passed to gh in addition to agentdock_process::ENV_ALLOWLIST (ASCII case-insensitive).
/// GH_HOST, GH_REPO, GH_ENTERPRISE_TOKEN, GITHUB_ENTERPRISE_TOKEN are never passed.
pub const GH_EXTRA_ENV: &[&str] = &[
    "GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "XDG_CONFIG_HOME",
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR",
];
// Always set: GH_PROMPT_DISABLED=1, GH_NO_UPDATE_NOTIFIER=1, NO_COLOR=1, GH_PAGER="" (empty), GIT_TERMINAL_PROMPT=0.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHubRepo { pub owner: String, pub name: String }   // each ^[A-Za-z0-9_.-]{1,100}$, not "." or ".."
impl GitHubRepo {
    pub fn from_remote_url(url: &str) -> Option<Self>;   // max 600 chars
    pub fn slug(&self) -> String;                        // "owner/name"
    pub fn eq_ignore_case(&self, other: &Self) -> bool;
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum GhError {
    #[error("GitHub CLI (gh) not found")] NotFound,
    #[error("GitHub CLI request failed (check `gh auth status`, network and repository permissions)")] Failed,   // never includes stderr
    #[error("GitHub CLI timed out")] Timeout,
    #[error("GitHub CLI returned an unexpected response")] BadResponse,
    #[error("GitHub evidence is incomplete")] Incomplete,
    #[error("pull request head changed during the read")] HeadChanged,
    #[error("invalid argument")] BadArgument,
}

pub struct Gh { exe: PathBuf }
impl Gh {
    pub async fn discover(explicit: Option<&Path>, path_dirs: &[PathBuf]) -> Result<Self, GhError>;
    /// Runs one allowed request. `cwd` is any scoped directory (gh needs a cwd; it never reads the repo
    /// from it because --repo / fixed paths are always given).
    pub async fn request(&self, cwd: &agentdock_policy::path_scope::ScopedPath, req: &shapes::GhRequest,
        host_env: &[(String, String)]) -> Result<Vec<u8>, GhError>;
}

// crates/agentdock-integrations/src/github/shapes.rs
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GhRequest {
    /// gh api --method GET --hostname github.com -H "Accept: application/vnd.github+json" repos/{o}/{r}/{tail}
    ApiGet { repo: GitHubRepo, tail: ApiPath },
    /// gh pr checks <n> --repo o/r --json name,state,bucket,link,workflow
    PrChecks { repo: GitHubRepo, number: u64 },
    /// gh pr create --repo o/r --head <branch> --base <base> --title <t> --body-file <path> [--draft]
    PrCreate { repo: GitHubRepo, head: String, base: String, title: String, body_file: PathBuf, draft: bool },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiPath {
    Repo,                                        // ""
    OpenIssues { page: u32 },                    // issues?state=open&per_page=100&page=N
    PullsByHead { head_branch: String },         // pulls?state=all&head={o}:{branch}&per_page=10
    Pull { number: u64 },                        // pulls/{n}
}
impl GhRequest { pub fn argv(&self) -> Result<Vec<String>, crate::github::GhError>; }
```

```rust
// crates/agentdock-integrations/src/github/read.rs
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct IssueRow { pub number: u64, pub title: String /* single line, <= 200 chars */, pub url: String }
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct IssueList { pub items: Vec<IssueRow> /* <= 30 */, pub truncated: bool }

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PrState { Open, Draft, Closed, Merged }

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PrRef {
    pub number: u64, pub url: String /* https://github.com/... only */, pub state: PrState,
    pub head_sha: String /* 40 hex */, pub head_ref: String, pub base_ref: String, pub author: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CiBucket { Pass, Fail, Pending, Skipping, Cancel }   // unknown bucket → Pending (PRL-6)

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CiCheck { pub name: String, pub workflow: Option<String>, pub bucket: CiBucket, pub link: Option<String> }

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CiVerdict { Success, Failure, Pending, NoChecks }

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CiSnapshot { pub head_sha: String, pub checks: Vec<CiCheck>, pub verdict: CiVerdict }

pub async fn open_issues(gh: &Gh, cwd: &ScopedPath, repo: &GitHubRepo, env: &[(String, String)]) -> Result<IssueList, GhError>;
pub async fn pr_lookup_by_head(gh: &Gh, cwd: &ScopedPath, repo: &GitHubRepo, branch: &str, env: &[(String, String)])
    -> Result<Option<PrRef>, GhError>;   // newest open PR first; if none open, newest closed/merged
pub async fn pr_head(gh: &Gh, cwd: &ScopedPath, repo: &GitHubRepo, number: u64, env: &[(String, String)]) -> Result<PrRef, GhError>;
/// Reads head (must equal expected_head), then checks, then head again (must still equal). Otherwise HeadChanged.
pub async fn ci_for_pr(gh: &Gh, cwd: &ScopedPath, repo: &GitHubRepo, number: u64, expected_head: &str,
    env: &[(String, String)]) -> Result<CiSnapshot, GhError>;
pub async fn default_branch(gh: &Gh, cwd: &ScopedPath, repo: &GitHubRepo, env: &[(String, String)]) -> Result<String, GhError>;
/// Parses the PR URL printed by `gh pr create`; checks it belongs to `repo`.
pub fn parse_created_pr_url(stdout: &str, repo: &GitHubRepo) -> Option<(u64, String)>;
```

## 5. Implementation steps

1. Write the §6 tests and the fake `gh` binary.
2. `GitHubRepo::from_remote_url`: exact prefixes only (`https://github.com/`, `git@github.com:`, `ssh://git@github.com/`); strip one trailing `/` and one `.git`; exactly two segments; reject `.`/`..`, other hosts, `http://`, user-info (`https://user:token@github.com/...` → unsupported, and never echo it).
3. `GhRequest::argv`: validate every field (branch names `^[A-Za-z0-9._/-]{1,200}$`, not starting with `-`; `title` 1..=256 chars without NUL or newlines; `body_file` absolute; `number >= 1`). Build argv exactly as the enum doc comments say. No other argv can be produced.
4. `Gh::request`: `tokio::process::Command` with `env_clear()`, `child_env(host_env, …)` from P3-2 plus `GH_EXTRA_ENV` and the fixed variables, `stdin(null)`, `kill_on_drop(true)`, `CREATE_NO_WINDOW` on Windows (`#[cfg(windows)]`). Read stdout up to `MAX_STDOUT` (over → kill, `BadResponse`), discard stderr except for a redacted debug `tracing` event (never returned). Timeout → kill → `Timeout`. Non-zero exit → `Failed`, except `PrChecks` (step 7).
5. `open_issues`: up to `MAX_PAGES` pages of 100; drop rows with a `pull_request` key; keep going after filtering so 100 open PRs do not look like zero issues; stop at 30 issues; `truncated` when more exist or `MAX_PAGES` was hit. Title: collapse `\r\n\t` to spaces, cut at 200 chars. URL kept only if it parses as `https://github.com/...`.
6. `pr_lookup_by_head`: `ApiPath::PullsByHead`; filter rows whose `head.ref == branch` and `head.repo.full_name` equals the repo (fork PRs with the same branch name do not count); map `merged_at != null` → `Merged`, `draft` → `Draft`.
7. `ci_for_pr`:
   1. `pr_head` → `head_sha != expected_head` → `HeadChanged`.
   2. `PrChecks`. PRL-6: exit 0 with a JSON array → map `bucket` (`pass`, `fail`, `pending`, `skipping`, `cancel`; anything else → `Pending`). Exit non-zero is `NoChecks` **only if** stdout is empty and the output matched the "no checks reported" case; the fake gh models this as exit 1 with empty stdout and the marker `no checks reported` on stderr, which is the one place stderr is inspected (matched, never returned). Any other non-zero → `Failed`. Note: `gh pr checks` exits 8 while checks are pending; treat exit 8 with a valid JSON array as success.
   3. Verdict: any `Fail` or `Cancel` → `Failure`; else any `Pending` → `Pending`; else at least one `Pass` → `Success`; empty or only `Skipping` → `NoChecks`. `NoChecks` is never success (absence of evidence); P8-4 decides what the user sees.
   4. `pr_head` again → changed → `HeadChanged`.
8. `parse_created_pr_url`: last line matching `^https://github\.com/{owner}/{name}/pull/([1-9][0-9]*)$` (case-insensitive owner/name).

### Fake gh (`agentdock-test-fake-gh`)

- Reads `fake-gh.json` next to its own executable (`std::env::current_exe()`), appends one JSON line per call to `fake-gh.log` in the same directory: `{"argv": [...], "env": {"GH_HOST": "...or null", "GH_TOKEN": "...or null", "GH_PROMPT_DISABLED": "..."}}`.
- Script format: `{"rules": [{"argv_prefix": ["api", "--method", "GET"], "contains": "issues?state=open&per_page=100&page=1", "exit": 0, "stdout": "...", "stderr": "...", "sleep_ms": 0}]}`; the first matching rule wins; no match → exit 99.
- Test helper `fake_gh::install(dir, script) -> PathBuf` copies `env!("CARGO_BIN_EXE_agentdock-test-fake-gh")` into `dir` (adds `.exe` on Windows) and writes the script.

## 6. Tests to write first

Unit tests (`github/mod.rs`, `github/shapes.rs`):

| Test | Expected |
| --- | --- |
| `remote_url_formats` | the three accepted forms (with and without `.git`, trailing `/`) parse; `https://gitlab.com/o/r`, `http://github.com/o/r`, `https://github.com/o`, `https://github.com/o/r/x`, `https://github.com/../r`, `https://user:ghp_000…@github.com/o/r`, 601-char input → `None` |
| `argv_shapes_exact` | each `GhRequest` variant produces exactly the documented argv |
| `argv_rejects_option_injection` | branch `--repo=evil/x`, `-x`; title with `\n`; relative `body_file`; `number: 0` → `BadArgument` |
| `api_paths_fixed` | `ApiPath` variants render to the exact paths; no way to produce `--method POST` |

`crates/agentdock-integrations/tests/github_read.rs` (fake gh; temp dirs with spaces and CJK):

| Test | Expected |
| --- | --- |
| `issues_exclude_prs_and_page_past_them` | page 1: 100 PR rows; page 2: 3 issues → 3 issues, `truncated: false` (port of PR #29 test line 148) |
| `issues_full_pages_report_truncated` | 5 full pages of issues → 30 items, `truncated: true` (port of line 95) |
| `issue_titles_single_line_and_bounded` | title with newlines and 500 chars → one line, 200 chars |
| `non_github_issue_url_dropped` | `html_url: "javascript:alert(1)"` → row kept with empty URL or dropped (choose one, document it) |
| `lookup_by_head_ignores_fork_with_same_branch` | two rows, one from `fork/r` → only the repo's PR returned |
| `lookup_by_head_none` | empty array → `None` |
| `ci_success_pending_failure_nochecks` | four scripts → `Success`, `Pending` (exit 8 + JSON), `Failure`, `NoChecks` |
| `unknown_bucket_is_pending` | bucket `"weird"` → `Pending`, verdict not `Success` |
| `only_skipping_is_nochecks` | all `skipping` → `NoChecks` |
| `ci_head_changed_before` | first `pulls/{n}` returns another SHA → `HeadChanged`, `pr checks` never called (check the log) |
| `ci_head_changed_after` | head changes between the two reads → `HeadChanged` (port of line 203 "changed PR head") |
| `ci_nonzero_without_marker_is_failed` | exit 1, empty stdout, other stderr → `Failed`, not `NoChecks` |
| `env_cannot_redirect_host_or_repo` | host env has `GH_HOST=evil.example`, `GH_REPO=someone/else`, `GH_TOKEN=test-token-not-real`, `GIT_WORK_TREE=/elsewhere` → log shows `GH_HOST`/`GH_REPO` null, `GH_TOKEN` passed, `GH_PROMPT_DISABLED=1` (port of line 232) |
| `failure_never_surfaces_stderr` | exit 1 with stderr `HTTP 401: Bad credentials ghp_SECRETSECRET` → `GhError::Failed` whose `Display` contains neither `ghp_` nor `401` (port of line 264) |
| `timeout_kills` | `sleep_ms: 5000` with a 1 s timeout (test-only constructor) → `Timeout` within 3 s |
| `oversized_stdout_rejected` | 9 MiB stdout → `BadResponse` |
| `created_pr_url_parsed_and_repo_checked` | `https://github.com/o/r/pull/12` → `(12, url)`; `https://github.com/x/y/pull/12` → `None` |
| `read_queries_never_write` | after running every read function, the log contains no argv with `create`, `merge`, `edit`, `comment`, `POST`, `PATCH`, `PUT`, `DELETE` (port of line 108) |

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-integrations github::                          # 4 unit tests pass
cargo test -p agentdock-integrations --test github_read                # 18 pass on Linux
```

Windows-only (CI): the same `github_read` suite runs in the `windows-latest` job (the fake binary is copied with `.exe`); confirm with `gh pr checks <PR> --repo ChiJiun/agentdock` that the Windows job passed.

Manual, optional (owner's machine with `gh auth login` done): a `#[ignore = "needs network and gh auth; set AGENTDOCK_GH_E2E=1"]` test `real_gh_lists_issues_of_this_repo` reads open issues of `ChiJiun/agentdock` and checks `items` is non-empty.

## 8. Spec references and porting sources

- ADR-0002 line 155 PRL-6 (CI only from `gh pr checks --json` `bucket`; unknown buckets pending; "no checks" rule), line 159 PRL-10 (`gh` argument allow-list; repository allow-list includes the host), line 150 PRL-1 (reviewed SHA must equal PR head).
- Issue #10 Requirements item 1 (issue picker) and item 6 (poll CI checks, link failed jobs).
- Porting sources (behaviour and test scenarios only; no code copied):
  - PR #29, branch `feat/durable-task-workflow`, SHA `c57b824ddcdc2355fbc10bded265db4b99cf9e80`: `apps/runtime/github-reader.mjs` (`parseGithubRemote`, `run` env allow-list and stderr suppression, `issues` paging past PRs, `verifyTaskPull` read-head-twice, `checks` "no checks is not green"); `apps/runtime/github-reader.test.mjs` lines 60, 95, 108, 148, 160, 203, 232, 264.
  - PR #33, branch `feat/github-readonly-evidence`, SHA `8703a60ca750304fc34a51bc64c82138c4dc5e67`: `docs/implementation/github-readonly-evidence.md` (read-only scope statement).
  - Difference from PR #29: CI comes from `gh pr checks --json bucket` (ADR-0002 PRL-6) instead of the REST check-runs + statuses pair, because the ADR is binding (CONVENTIONS §0 item 4). Recorded as a deliberate deviation.

## 9. Dependencies

No new crates (`serde_json`, `tokio`, `thiserror`, `tracing` already present).

## 10. Model tier

Standard model implements; strong model reviews (argument injection, environment redirection and stderr leakage are easy to get subtly wrong).

## 11. Common mistakes and pitfalls

- Building argv from strings (`format!("--repo {}", x)` split on spaces): use the enum; every element is one argv entry.
- Letting `gh` infer the repository from the cwd: always pass the repository; `GH_REPO` is stripped anyway.
- Returning `gh` stderr to the UI: it can contain tokens and local paths.
- Treating "no checks" as green: absence of evidence is `NoChecks`.
- Reading CI once without re-reading the head: a push during the read attaches old CI to a new commit.
- `gh pr checks` exit code 8 means "pending", not failure; parse stdout.
- `PullsByHead` also returns fork PRs whose branch has the same name; filter by `head.repo.full_name`.
- On Windows `gh` is `gh.exe` (not a shim) when installed by the official MSI or winget; a Scoop shim (`gh.cmd`) must be rejected like other shims.

## 12. Reviewer checklist

- [ ] Can any public function produce a `gh` argv outside the `GhRequest` shapes? (Search for `Command::new` and `args(` in `github/`.)
- [ ] Is `GH_HOST` / `GH_REPO` / enterprise token impossible to pass through?
- [ ] Is stderr ever included in an error, event or return value?
- [ ] Does `ci_for_pr` read the head before and after, and fail on mismatch?
- [ ] Are `NoChecks`, unknown buckets and incomplete pages never `Success`?
- [ ] Do fork PRs with the same branch name get excluded in `pr_lookup_by_head`?
- [ ] Does the fake gh cover every branch used by P7-2b (`pr create` success/failure, lookup)?
