# GitHub repository evidence (read-only developer integration)

Status: **Implemented and locally verified in development runtime**
Date: 2026-11-17
Tracks: [Issue #10 GitHub SDLC](https://github.com/ChiJiun/agentdock/issues/10)

## What works

The **Live ACP → GitHub（唯讀） / GitHub (read only)** tab reads the current repository's open Issues, open Pull Requests and CI Check Runs. The user chooses the tab; there is no unsolicited GitHub API polling, no remote write, and no agent-initiated GitHub mutation.

- The host resolves an explicitly approved local Git directory to its canonical `git rev-parse --show-toplevel` directory.
- It reads `remote.origin.url`, accepting **only** supported `github.com` HTTPS/SSH remote forms, and validates the owner/repository slug.
- It runs the operator's installed and authenticated GitHub CLI as `gh api --method GET --hostname github.com -H 'Accept: application/vnd.github+json' <path>` with only these fixed paths. `GH_HOST`, `GH_REPO` and enterprise tokens are removed from the child environment so the request cannot be redirected to another host or repository:
  - `GET repos/{owner}/{repo}/issues?state=open&per_page=30` (excludes Pull Requests in the Issues response)
  - `GET repos/{owner}/{repo}/pulls?state=open&per_page=30`
  - `GET repos/{owner}/{repo}/commits/{fullSHA}/check-runs?per_page=30`
- It only accepts a **full, 40-character lowercase hex commit SHA** to request Check Runs; an invalid SHA is rejected before any process starts. HTML links are normalized to `https://github.com` (not arbitrary URLs). Titles are rendered as React text.
- Requests run asynchronously (`execFile`, 60 s timeout, 8 MB output cap) so a slow network never blocks the ACP runtime event loop. Real list responses measured about 200 KB for ~12 open PRs, so the earlier 256 KB cap was too small.
- A full page (30 results) is shown as possibly truncated; Check Runs show the PR number, the head SHA at read time, and a truncation note when `total_count` exceeds the page. Only Check Runs are read, not legacy commit statuses. Titles and check names are flattened to one line.
- Data is **not** presented as verified code quality. When there are no check runs, the UI says `No checks loaded or reported. This does not imply success.`
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

- Node tests use a local temporary Git fixture repository and a fake `gh` command boundary to verify remote URL parsing, fixed GET endpoints, issue/PR separation, SHA validation and scope checks.
- React tests verify GitHub data is read **only when the user opens the tab**, no GitHub POST request occurs, and zero CI Check Runs are **not** misrepresented as success.
- A live, read-only integration check using the operator's authenticated GH CLI against the private `ChiJiun/agentdock` repo returned Issues, PRs, and a zero-checks response for one PR head commit (see the PR description for the exact run). No write actions were performed.

## Out of scope

This is not the complete **Issue → Plan → Implementation → Tests → Independent Review → PR → CI** automation requested by #10. Remaining features include:

- GitHub Issue-to-Task association, durable Task state transitions, and re-checking changed files against an approved plan.
- Review evidence collected from test/build/check runs, including correct failure log links and retries.
- Explicit backend-controlled approval for Git push and PR create, with replay-safe idempotency.
- Independent reviewer Agent with scoped read-only access.
- Rust/Tauri signed desktop packaging, production secrets policy and Windows integration tests.
- Hosted CI validation: this repo's current GitHub CLI token has repo scope but not `workflow`; no workflow configuration was committed.

The release gate remains open until users can verify a real task end to end with human approval boundaries.
