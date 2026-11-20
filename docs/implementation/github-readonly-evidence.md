# GitHub repository evidence (read-only developer integration)

Status: **Implemented and locally verified in development runtime**
Date: 2026-11-17
Tracks: [Issue #10 GitHub SDLC](https://github.com/ChiJiun/agentdock/issues/10)

## What works

The **Live ACP → GitHub（唯讀） / GitHub (read only)** tab reads the current repository's open Issues, open Pull Requests and CI Check Runs. The user chooses the tab; there is no unsolicited GitHub API polling, no remote write, and no agent-initiated GitHub mutation.

- The host resolves an explicitly approved local Git directory to its canonical `git rev-parse --show-toplevel` directory.
- It reads `remote.origin.url`, accepting **only** supported `github.com` HTTPS/SSH remote forms, and validates the owner/repository slug.
- It runs the operator's installed and authenticated GitHub CLI as `gh api --method GET --hostname github.com -H 'Accept: application/vnd.github+json' <path>` with only these fixed paths. The subprocess uses an allow-listed environment: `GH_HOST` / `GH_REPO` and enterprise token variables are never forwarded, while `GH_TOKEN` / `GITHUB_TOKEN` and supported proxy settings are available to `gh` (but not to Git):
  - `GET repos/{owner}/{repo}/issues?state=open&per_page=100&page=N` (bounded pagination; filters Pull Requests while continuing to seek up to 30 actual Issues)
  - `GET repos/{owner}/{repo}/pulls?state=open&per_page=30`
  - `GET repos/{owner}/{repo}/commits/{fullSHA}/check-runs?per_page=100&page=N` (up to 5 pages / 500 Check Runs)
  - `GET repos/{owner}/{repo}/commits/{fullSHA}/status?per_page=100` (combined legacy Commit Status and contexts)
- It only accepts a **full, 40-character lowercase hex commit SHA** to request Check Runs; an invalid SHA is rejected before any process starts. HTML links are normalized to `https://github.com` (not arbitrary URLs). Titles are rendered as React text.
- Requests run asynchronously (`execFile`, 60 s timeout, 8 MB output cap) so a slow network never blocks the ACP runtime event loop. Real list responses measured about 200 KB for ~12 open PRs, so the earlier 256 KB cap was too small.
- Issues are filtered after each page; a page of only PRs does not imply the Issues list is empty. The UI labels a capped list as **possibly incomplete** without claiming the number of actual Issues is 30.
- Check Runs are fetched in bounded pages and cross-checked against `total_count`; legacy Commit Status contexts are read separately. A failed later page or failed legacy request returns HTTP 502 rather than a falsely green partial result. At the configured cap (>500 Check Runs or >=100 legacy contexts), the result is `complete:false`, `truncated:true`, `verdict:unknown`. A changed Check Run `total_count` during pagination is an error that requires refresh.
- Verdict is `failure` on a failing Check Run or legacy context; `pending` on ongoing checks; `success` only when both sources were retrieved completely, no failures/pending statuses exist, and at least one item was reported. Otherwise it is `unknown`. The UI states source and completeness explicitly, shows the PR number and the head SHA as read, and never infers passing tests or independent Code Review from CI alone. Titles and check names are flattened to one line.
- The development API has no endpoint to create PRs, push, merge, delete branches, submit reviews, or modify GitHub account data.
- No GitHub credentials are returned to the browser; the backend wraps `gh` and does not leak raw CLI stderr. CLI failures return HTTP 502 with a fixed message.

## Configuration

Requires an existing **GitHub CLI** binary with sufficient **read-only** repository access, authenticated by the operator using GitHub's standard login.

If `gh` is in PATH, no extra variable is needed. Otherwise set an absolute path to the executable:

```sh
AGENTDOCK_GH_BINARY=/absolute/path/to/gh npm run dev:full
```

The process also needs an approved local repository with `github.com` origin. A Worktree created from that Repo remains associated with the same origin.

### Security scope

Only allow trusted local users to access the development runtime, which currently uses loopback HTTP and Vite's `/api` proxy without production-grade authentication. Never expose its ports to the Internet/LAN or tunnel it to untrusted clients. The host executes no arbitrary CLI strings supplied by the browser, but relies on the user's own `gh` auth.

## Verification

```sh
npm run typecheck
npm run test:all
npm run build
```

- Node tests use a local temporary Git fixture repository and a fake `gh` command boundary to verify remote URL parsing, fixed GET endpoints, issue/PR separation, SHA validation and scope checks. Additional fixtures cover 135 Check Runs over two pages, a failing legacy Commit Status, 100 PRs hiding an Issue on page 2, a failed second Check Runs page, and an over-cap case (>500 Check Runs) forced to `unknown`.
- React tests verify GitHub data is read **only when the user opens the tab**, no GitHub POST request occurs, and zero CI Check Runs are **not** misrepresented as success.
- A live, read-only integration check using the operator's authenticated GH CLI against the private `ChiJiun/agentdock` repo returned Issues, PRs, and a zero-checks response for one PR head commit (see the PR description for the exact run). No write actions were performed.

## Out of scope

This is not the complete **Issue → Plan → Implementation → Tests → Independent Review → PR → CI** automation requested by #10. Remaining features include:

- GitHub Issue-to-Task association, durable Task state transitions, and re-checking changed files against an approved plan.
- Review evidence collected from test/build/check runs, including correct failure log links and retries.
- Explicit backend-controlled approval for Git push and PR create, with replay-safe idempotency.
- Independent reviewer Agent with scoped read-only access.
- Rust/Tauri signed desktop packaging, production secrets policy and Windows integration tests.
- Production signed Rust/Tauri host and Windows end-to-end validation remain future work. This development branch inherits a GitHub Actions frontend/runtime verification workflow from the upstream stacked PR; any GitHub credential scope restrictions remain enforced.

The release gate remains open until users can verify a real task end to end with human approval boundaries.
