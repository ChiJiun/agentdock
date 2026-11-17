# Safe Git Worktree isolation — implementation slice

Status: **Implemented, locally verified in Node development runtime**
Date: 2026-11-17
Related: [Issue #9](https://github.com/ChiJiun/agentdock/issues/9)

## What works

- In the **Live ACP** sidebar choose an approved local Git repository and click **建立獨立 Git Worktree / Create isolated Git worktree**.
- The backend checks the canonical repository path against operator-approved roots, checks the presence of an initial commit, then explicitly creates a **fresh isolated branch** and worktree from the repository's current `HEAD`:
  - `agentdock/task-<12-character-random-id>`, created first with `git branch --no-track <name> <resolved HEAD commit>`; without `--force`, an existing branch is never moved (HTTP 409, nothing changed)
  - workspace `task-<same id>` under `AGENTDOCK_WORKTREE_ROOT`, or by default **outside the repository** at `<runtime cwd>.worktrees/` (ADR-0002 WT-1). The folder is created lazily on the first explicit creation.
  - The worktree root may not overlap any approved workspace root (neither inside one nor containing one); the runtime refuses to start otherwise. This keeps a session started at the source repository from seeing every task's worktree and keeps one task's worktree from containing another approved root.
- If `git worktree add` fails (checkout error, 120 s timeout), only what this attempt created is undone (ADR-0002 WT-2): the branch is deleted with a compare-and-delete `git update-ref -d refs/heads/<name> <commit>` only when no worktree uses it. A partially registered worktree or leftover folder is **never deleted**; the error names it for manual inspection.
- Creations are serialized inside the runtime and run Git asynchronously, so a slow checkout does not block other API calls.
- The user's original checked-out branch remains untouched. The backend uses Git CLI with argument arrays, no shell, no Git credential prompt, bounded output and timeout. Git runs with an allow-listed environment (inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` are dropped); system Git config stays enabled so Windows `core.autocrlf` / `core.longpaths` match the user's own checkouts. Minimum Git version: 2.36 (`git worktree list --porcelain -z`).
- Worktree records are stored in local SQLite. On runtime restart a registered worktree is reinstated as an allowed workspace only if (1) its folder still exists at the recorded canonical path with no symlink/junction in it, (2) it is a direct child of the current worktree root, (3) its source repository is still inside an approved root, and (4) `git worktree list` of that repository still lists it. **No Agent session is automatically resumed.**
- Check (1)–(2) is repeated before every use of the approved roots (`/api/workspaces`, `/api/sessions`, `/api/git/*`), so a sibling worktree replaced by a link to somewhere else stops being an approved root without a restart. `GET /api/worktrees` reports `exists` and `available` separately.
- Selecting a newly-created Worktree updates the allowed-workspace selector; you can then **deliberately** start an ACP Session in it.
- The backend **does not** automatically delete a Worktree or Branch, `git reset`, `git checkout --`, `git clean`, push, merge or modify protected branches.
- There is no API that lets a browser supply arbitrary Branch Names or output paths. The backend generates them and only permits worktrees under a canonical configured directory.

## APIs

`GET /api/worktrees` — readonly list of registered worktrees and existence state.

`POST /api/worktrees` — JSON body: `{"repoPath": "/path/to/approved/source/repo"}`. Requires local Origin/JSON checks. Only creates a new Worktree; never performs deletion or cleanup. Errors: 400 invalid/outside/not a Git working tree/no commit, 409 branch or folder already exists, 502 Git failure or timeout (message says what was left in place).

`GET /api/workspaces` — lists configured roots plus created Worktrees; `POST /api/sessions` accepts these canonical paths only.

## Verification

```sh
npm run typecheck
npm run test:all
npm run build
```

The Runtime tests create disposable Git repositories in the **system temp folder** (path contains a space and CJK characters, ADR-0002 WT-4) and verify:

1. New branch (no upstream) and isolated Worktree at same initial HEAD; the worktree root is created only on explicit creation.
2. Mutating an isolated file does **not** modify the original checked-out branch or source repo files.
3. Traversal, outside-root, non-string and non-repository paths are rejected with 400 and nothing is created.
4. A worktree root that overlaps an approved root is refused; the default root is outside the repository.
5. An existing branch with the generated name is not moved (409).
6. Three concurrent creations get distinct branches and folders.
7. (Windows only) a failed checkout removes only the branch this attempt created.
8. The localhost API requires an explicit creation request and newly registered paths can host a real ACP Mock Session.
9. Registered Worktrees persist across runtime restarts.
10. A worktree folder replaced by a junction/symlink is dropped from approved roots both while running and after restart; worktrees of a source repository the operator no longer approves are not reinstated.

Frontend test verifies **no automatic Worktree is created on mount**; a deliberate click sends the creation request, with no Prompt executed automatically.

## Not implemented / remaining risk

- Production Rust/Tauri permission-engine and Windows process lifecycle.
- Path-scope/symlink hardening under concurrent adversarial filesystem writes: the link check runs before each use, but a race between that check and the agent spawn remains (TOCTOU). Windows 8.3 short names and WSL path forms (ADR-0002 WT-11) are not handled.
- Git hooks (`post-checkout`) and repository-local config (e.g. `core.fsmonitor`) of the source repository still run during `git worktree add`, as they would for the user's own Git.
- UI for Worktree cleanup and branch deletion: intentionally omitted until a separately approved safe cleanup workflow exists.
- Persistent Task lifecycle integration with Issue → Plan → Worktree → Implementation → Review → PR → CI.
- Cross-agent ownership/locks and automatic detection of worktree conflicts.
- Fully isolated OS sandbox (external ACP agents may still access files outside the worktree using their own tools).
- Real Claude Code/Codex/Octomind executable smoke tests.

## Attribution

This feature is original AgentDock implementation built using the **existing Git CLI** and Node standard library. It does not copy Acpira's experimental Worktree PR source. [ChiJiun/acpira PR #5](https://github.com/ChiJiun/acpira/pull/5) is an architectural/test reference only. No proprietary Claude assets used.
