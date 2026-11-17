# Durable Task Workflow — first backend slice of Issue #10

This implementation adds a **local-only, human-driven SDLC state machine** to the existing Node ACP development runtime. It is not a complete autonomous Issue → PR product.

## What runs today

- SQLite-backed `coding_tasks`, `task_transitions` and `task_evidence` tables. A task is separate from its ACP sessions.
- A workspace must resolve inside an approved local root; GitHub issue metadata is optional and validated.
- Explicit state transitions, revision-based optimistic concurrency and append-only history.
- Evidence records for plan, local tests, independent review, PR and CI.
- Review requires passing local-test evidence; PR readiness requires passing independent-review evidence; merge readiness requires passing CI evidence.
- The state machine **never** runs Git/GitHub commands, merges, pushes, executes tests or claims CI passed on its own.
- Transition to `complete` is deliberately disabled until a separate, independently verified merge/reconciliation implementation exists.

## Development API (loopback only)

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/tasks` | List local tasks |
| POST | `/api/tasks` | Create a task: `{workspace,objective,issueNumber?,issueUrl?}` |
| GET | `/api/tasks/:id` | Read a task |
| GET | `/api/tasks/:id/history` | Append-only transition history |
| GET | `/api/tasks/:id/evidence` | Read supporting evidence |
| POST | `/api/tasks/:id/evidence` | Append `{kind,result,summary,reference?}` |
| POST | `/api/tasks/:id/advance` | Transition with `{to,expectedRevision,reason,humanConfirmed?}` |

Example, after `npm run dev:full`:

```sh
curl -sS http://127.0.0.1:4319/api/tasks
```

**Important trust boundary:** `humanConfirmed` is a development API UI hint, **not** authenticated user presence. This local API has no authentication beyond binding to loopback and browser Origin checks. Do not expose it publicly or treat it as an authorization boundary. A future Tauri/Rust Host must verify human approval and bind it to a fingerprint and single-use operation ID. Likewise, evidence is user-provided; its contents have not yet been independently verified by a runner or GitHub API.

## Test

```sh
npm run test:runtime
npm run test:all
npm run typecheck
npm run build
```

## Remaining work to satisfy Issue #10

- Task UI, GitHub Issue picker, plan review and worktree binding.
- Task/ACP session relationship and independently verified build/test evidence.
- Independent reviewer ACP session with diff/test context.
- Backend-enforced one-time approval for GitHub writes and idempotent PR creation.
- CI status and job log reconciliation; bounded repair loops and retries.
- Rust/Tauri Host port, schema migration/versioning, Windows E2E and OS sandbox.
- Event snapshots and negative replay tests per the ADR-0003 contract.

The development endpoint must never be interpreted as a production-grade security approval system.
