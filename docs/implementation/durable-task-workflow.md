# Durable Task Workflow — first backend slice of Issue #10

This implementation adds a **local-only, human-driven SDLC state machine** to the existing Node ACP development runtime. It is not a complete autonomous Issue → PR product.

## What runs today

- SQLite-backed `coding_tasks`, `task_transitions` and `task_evidence` tables. A task is separate from its ACP sessions.
- A workspace must resolve to an existing directory inside an approved local root; GitHub issue metadata is optional and validated.
- Explicit state transitions, revision-based optimistic concurrency and append-only history.
- Evidence records for plan, local tests, independent review, PR and CI.
- The state machine **never** runs Git/GitHub commands, merges, pushes, executes tests or claims CI passed on its own.
- Transition to `complete` is deliberately disabled until a separate, independently verified merge/reconciliation implementation exists.

## States and transitions

```text
queued → planning → awaiting_plan_approval → preparing → implementing → verifying → reviewing
       → ready_for_pr → awaiting_pr_approval → pr_open → ci → awaiting_merge → (complete: disabled)
```

| From | Allowed targets |
| --- | --- |
| `queued` | `planning`, `cancelled` |
| `planning` | `awaiting_plan_approval`, `failed`, `cancelled` |
| `awaiting_plan_approval` | `preparing`, `planning`, `cancelled` |
| `preparing` | `implementing`, `interrupted`, `failed`, `cancelled` |
| `implementing` | `verifying`, `interrupted`, `failed`, `cancelled` |
| `verifying` | `reviewing`, `implementing`, `interrupted`, `failed`, `cancelled` |
| `reviewing` | `ready_for_pr`, `implementing`, `interrupted`, `failed`, `cancelled` |
| `ready_for_pr` | `awaiting_pr_approval`, `implementing`, `cancelled` |
| `awaiting_pr_approval` | `pr_open`, `ready_for_pr`, `cancelled` |
| `pr_open` | `ci`, `interrupted`, `failed`, `cancelled` |
| `ci` | `awaiting_merge`, `implementing`, `interrupted`, `failed`, `cancelled` |
| `awaiting_merge` | `complete` (always refused), `implementing`, `cancelled` |
| `interrupted` | `planning`, `implementing`, `cancelled` |
| `failed` | `planning`, `cancelled` |
| `cancelled`, `complete` | terminal |

Every non-terminal state can be cancelled. Resuming from `interrupted` or `failed` only goes back to `planning` or `implementing`, so a resumed task passes verification, review and PR approval again.

## Gates

A gate is checked inside the same SQLite write transaction as the state change.

| Entering | Requires |
| --- | --- |
| `preparing` | `humanConfirmed: true`, and passing `plan` evidence recorded since the task last entered `planning` |
| `reviewing` | link 1 of the evidence chain |
| `ready_for_pr` | links 1–2 |
| `pr_open` | `humanConfirmed: true`, and links 1–3 |
| `awaiting_merge` | links 1–4 |
| `complete` | always refused in this preview |

Evidence chain:

| Link | Evidence kind | Must be recorded since the task last entered | Commit rule |
| --- | --- | --- | --- |
| 1 | `local_tests` | `verifying` | — |
| 2 | `independent_review` | `reviewing` | same `commitSha` as link 1 |
| 3 | `pull_request` (with a `https://github.com/<owner>/<repo>/pull/<n>` reference) | `reviewing` | same `commitSha` as link 2 (the PR head is the reviewed commit) |
| 4 | `ci_checks` | `ci` | same `commitSha` as link 3 (CI ran on the PR head) |

For every link the **latest** record of that kind decides: it must be `passed`. A newer `failed` or `pending` record, a record from an earlier round (for example before `ci → implementing`), or a commit mismatch anywhere upstream blocks the gate. Recording a new PR head while CI is running therefore cannot reach `awaiting_merge` without a new review of that commit. `local_tests`, `independent_review`, `pull_request` and `ci_checks` evidence must carry a full 40-character lowercase `commitSha`; `plan` evidence must not.

"Latest" and "since" use insertion order (`task_evidence.rowid`, `task_transitions.seq`), not wall-clock timestamps, so a clock change cannot reorder evidence.

## Durability, restart and retry

- Each mutation is one `BEGIN IMMEDIATE` transaction: the `coding_tasks` projection and its `task_transitions` row commit together or not at all. Gate reads happen inside that transaction.
- `task_transitions` and `task_evidence` reject `UPDATE`, `DELETE` and `INSERT OR REPLACE` of an existing key through SQLite triggers. This protects against accidental writes through the same connection; anyone with direct write access to the database file can still edit `coding_tasks` (which has no trigger) or drop the triggers. Each transition row written by this version stores the task `revision` it produced, so the projection (`state`, `revision`) can be rebuilt from the log; rows written by the first preview schema have `revision` NULL.
- `evidence.pull_request` must name a pull request in the same repository as the task's `issue_url` (compared case-insensitively) when the task has one.
- A busy database file returns `503` after `busy_timeout` (3 s); the wait is synchronous and blocks the runtime's event loop meanwhile.
- A task has no in-flight process of its own. A runtime restart changes no task state; ACP sessions are marked `interrupted` by the session store as before, and moving a task to `interrupted` is an explicit operator transition.
- `POST /advance` is compare-and-set on `expectedRevision`. A retried or double-submitted request gets `409 stale task revision`; the client re-reads the task instead of applying the transition twice.
- `POST /api/tasks` and `POST /evidence` accept an optional caller-chosen UUID `id`. Repeating the request with the same `id` and the same content returns the existing row; the same `id` with different content is `409`. Without an `id`, a retry creates a second row.
- Databases created by the first preview commit are upgraded in place (`ALTER TABLE ... ADD COLUMN`). Their old evidence has no round marker and never satisfies a gate.

## Development API (loopback only)

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/tasks` | List the 100 most recent local tasks |
| POST | `/api/tasks` | Create a task: `{workspace,objective,issueNumber?,issueUrl?,id?}` |
| GET | `/api/tasks/:id` | Read a task |
| GET | `/api/tasks/:id/history?after=<seq>` | Append-only transition history, oldest first, 500 per page |
| GET | `/api/tasks/:id/evidence?after=<seq>` | Evidence, oldest first, 500 per page |
| POST | `/api/tasks/:id/evidence` | Append `{kind,result,summary,reference?,commitSha?,id?}` |
| POST | `/api/tasks/:id/advance` | Transition with `{to,expectedRevision,reason,humanConfirmed?}` |

Rows use the stored column names (`issue_number`, `task_id`, `commit_sha`, `created_at`, …).

| Status | Meaning |
| --- | --- |
| 400 | Malformed body or field |
| 403 | Cross-origin request, or a human gate without `humanConfirmed: true` |
| 404 | Unknown task |
| 409 | Stale revision, illegal transition, terminal task, unmet evidence gate, or an `id` reused with different content |
| 413 | Body larger than 20,000 characters |
| 415 | Body is not `application/json` |
| 503 | Another connection holds the SQLite write lock past `busy_timeout`; nothing was applied, retry |

Example, after `npm run dev:full`:

```sh
curl -sS http://127.0.0.1:4319/api/tasks
```

**Important trust boundary:** `humanConfirmed` is a development API UI hint, **not** authenticated user presence. This local API has no authentication beyond binding to loopback and browser Origin checks; any local process, including an agent the runtime started, can call it. Do not expose it publicly or treat it as an authorization boundary. A future Tauri/Rust Host must verify human approval and bind it to a fingerprint and single-use operation ID. Likewise, evidence is operator-submitted: the gates check that it is current and names one commit, **not** that the tests ran, that the reviewer was independent, or that GitHub agrees with the recorded PR head and CI result. `summary`, `reference`, `reason` and `objective` are stored as untrusted text without secret redaction; a UI must not render them as links or markup without validation.

## Differences from the proposed ADR-0003 contract

ADR-0003 (`docs/contracts/` on the `design/contracts` branch, PR #22) is still a proposal. This preview was written independently and does **not** implement it. Reconciling the two is an owner decision; until then the differences are:

| Topic | This preview | ADR-0003 proposal |
| --- | --- | --- |
| Task states | 16: `queued`, `planning`, `awaiting_plan_approval`, `preparing`, `implementing`, `verifying`, `reviewing`, `ready_for_pr`, `awaiting_pr_approval`, `pr_open`, `ci`, `awaiting_merge`, `interrupted`, `failed`, `cancelled`, `complete` | 12: `queued`, `preparing`, `running`, `awaiting_approval`, `verifying`, `review`, `pr`, `ci`, `completed`, `interrupted`, `failed`, `cancelled` |
| Naming | `implementing`, `reviewing`, `complete` | `running`, `review`, `completed` |
| Approvals | One state per approval (`awaiting_plan_approval`, `awaiting_pr_approval`, `awaiting_merge`) plus a `humanConfirmed` flag | One `awaiting_approval` state with a persisted `Approval` and `return_state`; no planning phase |
| PR phase | `ready_for_pr` / `awaiting_pr_approval` / `pr_open`, fed by operator-submitted `pull_request` evidence | One `pr` state driven by recorded `git_push` / `pr_create` operations (`pr_published_this_round`) |
| Completion | `complete` is unreachable; no "accepted without PR" edge | `review → completed` (T29) and `ci → completed` (T39) with merge evidence |
| Actors | `human`, `system` | `user`, `orchestrator`, `policy`, `adapter`, `integration`, `recovery` |
| Resume | `interrupted → planning \| implementing`, `failed → planning`; no interruption record | `interrupted → queued → preparing → resume_phase` (T44, T05–T08) with an `Interruption` record; `failed → queued` restarts from `running` (T47) |
| Recovery | No recovery actor; a restart changes no task state | `recovery` actor moves tasks towards a safe stop at startup |
| Operations | Not modelled, so `no_open_operations` and `no_unreconciled_operations` have no equivalent | Recorded, approval-gated, reconciled operations |
| Checks | Latest evidence record per kind since entering the phase must be `passed`, chained by commit SHA | All `local` / `ci` checks started since entering the phase passed (`local_checks_passed`, `ci_checks_passed`) |
| Event log | Separate `task_transitions` / `task_evidence` tables with a `revision` compare-and-set | Unified event envelope (`task.created`, `task.state_changed`) with triggers and durability classes (`persist_then_report`, `persist_then_act`) |
| Transition metadata | `reason` free text | Transition IDs, triggers and named conditions from `transitions.json` |

More differences:

- ADR-0003 has `interrupted → failed` (T45); this preview does not. Here `planning`, the `awaiting_*` states, `ready_for_pr` and `awaiting_merge` cannot move to `interrupted` or `failed`, whereas ADR-0003's `awaiting_approval` can.
- ADR-0003 bounds retries (`repair_limit_reached`, T25/T31/T42); this preview has no limit on how often an operator loops back to `implementing`.
- This preview allows `ready_for_pr → implementing` and `awaiting_merge → implementing`; ADR-0003's `pr` cannot return directly to `running`.
- ADR-0003 operations carry an `idempotency_key`; `advance` here relies on the `expectedRevision` compare-and-set instead, so a client that gets `409 stale task revision` cannot tell "my request was already applied" from "someone else got there first" without reading `history`.
- **Approval timing:** `pr_open` requires the PR to already exist (its URL and head commit are recorded `pull_request` evidence). The human confirmation is therefore a confirmation *after* the PR was opened, not a permission *before* push or PR creation as Issue #10 asks. A real pre-push / pre-PR gate belongs to the later slice that performs those writes, and the state order will need to change then.

Both agree that `failed` is not terminal, that only `cancelled` and the completed state are terminal, and that the projection is updated in the same transaction as the log append. ADR-0003 says the agent never changes task state; this preview has no agent-facing transition path, but it does **not enforce** that (any local process can call the API, see the trust boundary above). Both agree that a resumed task never skips verification or review.

## Test

```sh
npm run test:runtime
npm run test:all
npm run typecheck
npm run build
```

## Remaining work to satisfy Issue #10

- Task UI, GitHub Issue picker, plan review and worktree binding.
- Task/ACP session relationship and independently verified build/test evidence (recorded exit status instead of an operator summary).
- Independent reviewer ACP session with diff/test context.
- Evidence verified against GitHub (PR head SHA, check runs) through the read-only reader instead of operator input.
- Backend-enforced one-time approval for GitHub writes and idempotent PR creation.
- CI status and job log reconciliation; bounded repair loops and retries (nothing here limits how often an operator loops back to `implementing`).
- Rust/Tauri Host port, schema versioning, Windows E2E and OS sandbox.
- Alignment with the ADR-0003 contract once it is decided, including event snapshots and negative replay tests.

The development endpoint must never be interpreted as a production-grade security approval system.
