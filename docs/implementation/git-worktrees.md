# Safe Git Worktree isolation — implementation slice

Status: **Implemented, locally verified in Node development runtime**
Date: 2026-11-17
Related: [Issue #9](https://github.com/ChiJiun/agentdock/issues/9)

## What works

- In the **Live ACP** sidebar choose an approved local Git repository and click **建立獨立 Git Worktree / Create isolated Git worktree**.
- The backend checks the canonical repository path against operator-approved roots, checks the presence of an initial commit, then explicitly creates a **fresh isolated branch** and worktree from the repository's current `HEAD`:
  - `agentdock/task-<12-character-random-id>`
  - workspace under `AGENTDOCK_WORKTREE_ROOT` or default `.local/worktrees/<uuid>`
- The user's original checked-out branch remains untouched. The backend uses Git CLI with argument arrays, no shell, no Git credential prompt, bounded output and timeout.
- Worktree records are stored in local SQLite. On runtime restart registered existing worktrees are reinstated as allowed workspaces; **no Agent session is automatically resumed**.
- Selecting a newly-created Worktree updates the allowed-workspace selector; you can then **deliberately** start an ACP Session in it.
- The backend **does not** automatically delete a Worktree or Branch, `git reset`, `git checkout --`, `git clean`, push, merge or modify protected branches.
- There is no API that lets a browser supply arbitrary Branch Names or output paths. The backend generates them and only permits worktrees under a canonical configured directory.

## APIs

`GET /api/worktrees` — readonly list of registered worktrees and existence state.

`POST /api/worktrees` — JSON body: `{"repoPath": "/path/to/approved/source/repo"}`. Requires local Origin/JSON checks. Only creates a new Worktree; never performs deletion or cleanup.

`GET /api/workspaces` — lists configured roots plus created Worktrees; `POST /api/sessions` accepts these canonical paths only.

## Verification

```sh
npm run typecheck
npm run test:all
npm run build
```

The 4 new Runtime tests create temporary Git fixture repos under the project's `.local/` directory and verify:

1. New branch and isolated Worktree at same initial HEAD.
2. Mutating an isolated file does **not** modify the original checked-out branch or source repo files.
3. Traversal and outside-root paths are rejected.
4. The localhost API requires an explicit creation request and newly registered paths can host a real ACP Mock Session.
5. Registered Worktrees persist across runtime restarts.

Frontend test verifies **no automatic Worktree is created on mount**; a deliberate click sends the creation request, with no Prompt executed automatically.

## Not implemented / remaining risk

- Production Rust/Tauri permission-engine and Windows process lifecycle.
- Path-scope/symlink hardening under concurrent adversarial filesystem writes (TOCTOU), nested paths on Windows and WSL.
- UI for Worktree cleanup and branch deletion: intentionally omitted until a separately approved safe cleanup workflow exists.
- Persistent Task lifecycle integration with Issue → Plan → Worktree → Implementation → Review → PR → CI.
- Cross-agent ownership/locks and automatic detection of worktree conflicts.
- Fully isolated OS sandbox (external ACP agents may still access files outside the worktree using their own tools).
- Real Claude Code/Codex/Octomind executable smoke tests.

## Attribution

This feature is original AgentDock implementation built using the **existing Git CLI** and Node standard library. It does not copy Acpira's experimental Worktree PR source. [ChiJiun/acpira PR #5](https://github.com/ChiJiun/acpira/pull/5) is an architectural/test reference only. No proprietary Claude assets used.
