# Live ACP Runtime — development implementation

Status: **Implemented and locally verified as a Node.js development host**
Date: 2026-11-17
Tracks: [Issue #6](https://github.com/ChiJiun/agentdock/issues/6), [#7](https://github.com/ChiJiun/agentdock/issues/7), [#8](https://github.com/ChiJiun/agentdock/issues/8), [#15](https://github.com/ChiJiun/agentdock/issues/15), [#18](https://github.com/ChiJiun/agentdock/issues/18)

This is an **interim runtime for validating real Agent Client Protocol integration** while the planned Rust/Tauri host is not ready. It is not a production service and is not intended to be exposed to LAN/Internet.

## Verified end-to-end behavior

- Uses the **official Apache-2.0-licensed** `@agentclientprotocol/sdk@2.7.0` (stable ACP v1).
- Spawns a **locally configured** child process with argument arrays, `shell:false`, a bounded environment, and working-directory realpath checks within explicitly approved roots. The executable must be an absolute path and cannot be a `.cmd`/`.bat`/`.ps1` shim (see [Windows notes](#windows-notes)).
- Starts ACP handshake `initialize`, then `session/new`, followed by `session/prompt`; supports `session/cancel`. An agent that answers `initialize` with a protocol version other than 1 is refused.
- Start failures (executable missing, exit before the handshake, wrong protocol version, no answer within the initialization timeout) end the session as `failed` with an `error` or `process_exit` event that says why, and the process is stopped. `failed` is final: a prompt that fails also stops the agent.
- Receives actual `session/update` notifications and writes them to an append-only SQLite event journal with sequence cursors. A state change and its event are written in one transaction.
- Agent output that is not valid UTF-8 or not JSON does not end the connection (the SDK decodes lossily and answers a parse error). A single line larger than 16 MiB ends that connection explicitly and the session becomes `failed`.
- Persists session metadata and events. On restart, any previous live session becomes `interrupted` with a `host_restarted` event, and its unanswered approvals are cancelled; **agent context is not silently reattached**.
- Handles ACP `session/request_permission`: stores a pending approval together with what was asked (tool kind, paths and redacted input), waits for an explicit human decision, and answers only with an option the agent advertised for one use (`allow_once` to allow, `reject_once` to deny; never `allow_always`). Unused requests expire after 90 seconds as a refusal. Cancelling the turn, closing the session, an agent exit and a host restart all end pending requests as `cancelled`, so none can be answered later.
- Closing a session cancels a running turn, closes the agent's stdin, waits briefly, then stops the whole process tree.
- Read-only Git status and patch evidence, invoked by the user; no automatic push/merge/deletion. Repository-configured fsmonitor hooks, external diff drivers and textconv filters are disabled for these calls.
- Local HTTP development API bound to `127.0.0.1:4319`, with Host and Origin checks (a request addressed to any name other than loopback is refused, which blocks DNS rebinding), JSON-only mutation requests, strict payload limits, no CORS grant, and a fixed set of endpoints. The Vite server proxies `/api` to this host.
- One host process per database: a second host that points at the same SQLite file refuses to start instead of marking the first host's live sessions as interrupted.
- Real ACP-backed `Live ACP` view in the React UI: choose a permitted root and locally configured Agent; start a session, prompt, see event history, cancel, close, inspect Git and explicitly approve/deny permission requests.
- `zh-TW` and `en-US` in the real-session UI. Language overlay is a **visible best-effort user-turn instruction**, not an unadvertised override of Claude Code/Codex hidden System Prompts or Skills.

## Run

Requirements: **Node.js 22.13+** and npm, Git if using the Git inspector.

```sh
npm ci
npm run dev:full
```

Open **http://127.0.0.1:5173/**, click **Live ACP / 即時 ACP**, choose the `mock` adapter, and start a session. The mock is an **independent, actual ACP v1 process using the official SDK**, but simulates its model/tool response; no paid model, filesystem modification or external account is required.

Send `Hello`: the event timeline shows the live ACP `connected`, `agent_update`, and `turn_finished` events. Send a prompt containing `approval`: the mock deliberately raises `session/request_permission`. Choose **Deny** or **Allow once** in the Approvals tab; both paths are covered by a real transport test.

Note: the `mock` is a protocol fixture, not evidence that Claude Code or Codex is installed or authenticated.

## Opt in to real installed agents

Default approved workspaces: **only the directory in which the runtime starts**. To allow other local repositories, explicitly set `AGENTDOCK_WORKSPACE_ROOTS` to an approved comma-separated list of absolute root paths. Restrict them to test repositories or disposable Git worktrees; the current development host does **not** sandbox the internal tools of a third-party agent.

Install an ACP-compatible coding-agent executable using its **official instructions**, authenticate it in its normal environment, and create a JSON file on your own machine:

```json
[
  {
    "id": "my-installed-agent",
    "label": "My existing ACP agent",
    "bin": "/absolute/path/to/your-acp-executable",
    "args": [],
    "authEnv": []
  }
]
```

Set `AGENTDOCK_ADAPTER_CONFIG` to its absolute path and run `npm run dev:full` again. For Windows PowerShell use `$env:AGENTDOCK_ADAPTER_CONFIG = "C:\\path\\to\\adapters.json"` (Windows path for the JSON `bin` field can be escaped as normal JSON).

No executable name or API-key environment variable is accepted from browser request bodies. The optional `authEnv` array names **explicitly approved** variables to inherit when you own the adapter configuration. Never commit credentials or adapter config with embedded secrets.

If the adapter does not implement ACP v1, the host fails visibly rather than guessing protocol compatibility.

Agents get 30 seconds to finish `initialize` and `session/new`. A Node-based agent can need longer on a busy machine; set `AGENTDOCK_INIT_TIMEOUT_MS` (milliseconds, at least 1000) to change it. At most 8 agent processes run at once.

### Windows notes

- `bin` must be an absolute path. A bare name such as `codex-acp` is refused: Windows looks for it in the session's working directory first, so a repository could supply its own executable with that name.
- `bin` cannot be a `.cmd`, `.bat` or `.ps1` file. Node refuses to start those without a shell, and passing arguments through `cmd.exe` is not safe to automate here. npm-installed agents are `.cmd` shims, so configure Node and the agent's script instead:

  ```json
  [
    {
      "id": "claude-agent-acp",
      "label": "Claude Code (ACP)",
      "bin": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\<agent package>\\<entry script>.js"],
      "authEnv": []
    }
  ]
  ```

  The entry script is the file named by the `bin` field of the agent package's `package.json`.
- Stopping an agent ends its whole process tree with `taskkill /T /F` once it has ignored a closed stdin. This is weaker than the Job Object that [ADR-0002](https://github.com/ChiJiun/agentdock/blob/main/docs/decisions/0002-source-reuse.md) requires of the Rust host: descendants that an agent leaves behind after exiting on its own are not found, and nothing is reaped if the host process itself is killed with `taskkill /F` or Task Manager (a host that stops on Ctrl+C, a signal or an unexpected error does stop its agents).

## Data and restart semantics

- SQLite file: `.local/agentdock.db` (gitignored), including journal metadata, limited/redacted event payloads, and approval records.
- Readonly historical Session listing works after a restart; any old active Session is labelled `interrupted` and prompting it returns an error.
- The host does **not** promise reconnection to external model state. Actual ACP `session/load` capability support and verified replay remain future work.
- A user's Prompt and Agent output can contain private content: the store only performs best-effort redaction; keep the database private, never pass credentials as natural-language prompts, and do not export it by default.
- Stored text is bounded (16,000 characters per string, 48,000 per event). Anything cut is marked in place with `…[truncated N chars]` or `"truncated": true`; a maximum-length prompt (12,000 characters) is stored whole.
- `.local/agentdock.db.lock` holds the process id of the host that owns the database. A lock left by a process that no longer exists is replaced on the next start.
- Node 22's built-in `node:sqlite` remains **experimental**. This is a development-only store; migrate to the planned Rust store before production release.
- Closing the UI does not guarantee that the dev host will continue running. Start/stop with your normal development process. This is **not** a remote 24/7 Worker.

## Security boundaries and unresolved risks

**What is enforced:** exact permitted working-directory realpaths, a configured process allowlist with absolute executable paths, API Host/Origin/JSON restrictions, explicit handling of ACP permission requests in the host process (the page can only send `deny` or `allow_once` for a request that is still pending; everything else is refused by the host), no automatic replay of push/merge/delete actions, local-only binding, and read-only Git inspector. The host advertises no `fs` or `terminal` client capability, so an agent cannot ask it to read or write files or run commands.

**What is not enforced:** tools invoked internally by Claude Code/Codex/Octomind outside host-visible ACP permission requests; OS-level sandbox boundaries; safe execution of arbitrary configured third-party binaries; full credential isolation from the selected process; perfect secret detection in natural-language logs; Vite dev HTTP authentication. **Never expose the development port to an untrusted network**, treat adapter configs as privileged local operator configuration, and use disposable repositories when evaluating unknown Agents.

**Production release requires:** a Rust/Tauri IPC host, capability-based backend permissions, OS-level isolation, robust test/timeout/restart handling, the official Rust ACP client, and Windows build verification.

## Verification

```sh
npm run typecheck
npm test
npm run test:runtime
npm run build
npm run dev:full
```

Runtime integration tests start the SDK mock subprocess and a deliberately misbehaving agent (`apps/runtime/test-fixtures/hostile-agent.mjs`); they verify streamed output, denial and single-use approval, approval expiry, cancellation and close while an approval is pending, start failures, invalid UTF-8 and oversized lines, process-tree termination, persisted historical session on restart, directory and adapter validation, Host/Origin checks, multi-byte request bodies, the single-host lock, and event payload/JSON safety.

These tests were also run on Windows 11 (Node 24.21): 14/14 passed, including the process-tree test. No real Claude Code or Codex agent was started on Windows or anywhere else, so the adapter recipe in [Windows notes](#windows-notes) is untested against a real agent.

`npm run dev:full` was smoke-tested: `GET /api/health` through Vite at 127.0.0.1:5173 returned `{"ok":true,"mode":"local-development","protocol":"ACP v1","storage":"sqlite"}`.

GitHub Actions and Windows Tauri compile have **not** been verified due missing workflow token scope and Rust toolchain in this VM.

## Differences from the PR #22 contracts

[PR #22](https://github.com/ChiJiun/agentdock/pull/22) (`docs/contracts/`, branch `design/contracts`) defines the Task/Session/Event contract for the product. This development runtime predates it and does **not** implement it. The contract is not changed here; the differences are recorded so that nothing downstream treats this store as the canonical format.

| Area | Contract | This runtime |
| --- | --- | --- |
| Session states | `starting`, `idle`, `active`, `awaiting_permission`, `suspended`, `disconnected`, `closed`, `failed`; `closed`/`failed` carry an `outcome`; only listed transitions are legal | `starting`, `ready`, `running`, `awaiting_approval`, `interrupted`, `failed`, `closed`; no `suspended`, no `outcome`, no transition table. `interrupted` covers both a process exit and a host restart (the event tells them apart) |
| Event envelope | `schema_version`, `id`, `authority_id`, gap-free `seq`, `occurred_at`/`recorded_at`, `type`, `actor`, `provenance`, `redaction`, `project_id`, `task_id`; `snake_case` keys; prefixed ULIDs | `seq`, `session_id`, `kind`, `data`, `created_at`; camelCase keys in the API and payloads; UUIDs; one global `seq`, so one session's sequence has gaps |
| Event types | Closed `<entity>.<verb>` set; `session/update` split into message, tool call, plan and usage events; chunk coalescing | Own names (`connected`, `user_message`, `agent_update`, `turn_finished`, `approval_requested`, `approval_resolved`, `approval_rejected`, `cancel_requested`, `process_exit`, `host_restarted`, `error`, `closed`); every `session/update` stored as-is in `agent_update`, one row per notification |
| State changes | Every transition is an event in the same transaction as the projection | State and event share a transaction, but `ready -> running` and the return from `awaiting_approval` are implied by other events rather than recorded as their own; session creation writes no event |
| Raw tool input/output | Never inline; redacted artifact only; `[REDACTED:<rule>]` with the rule recorded | Stored inline inside `agent_update` and the approval `detail`, with `[REDACTED]` markers and truncation, no rule record |
| Approval | `task_id`, `source`, `operation_kind`, `classified_kind`, `operation_fingerprint`, `scope`, `decided_by`, `decided_at`; states include `cancelled` and `invalidated`; backend classification decides who may approve | `id`, `session_id`, `title`, `choices`, `detail`, `status`, `created_at`, `expires_at`, `selected_option`; states `pending`, `approved`, `denied`, `expired`, `cancelled` (a host restart uses `cancelled`, not `invalidated`); no fingerprint, no classification, several requests may be pending at once |
| Recovery | `system.recovery_started` ... `system.recovery_completed` written by a `recovery` actor; sequence and projection verified; live sessions become `disconnected (host_recovery)` | One `host_restarted` event per affected session and `approval_resolved` per cancelled approval; no verification or rebuild |
| Capabilities | `session.capabilities_detected` snapshot with 13 features, agent info and auth methods; optional methods gated on it | Only `loadSession` is stored (`supports_load`) and it is not used; no optional method is called |
| Entities | Project, Task, Operation, Check, Usage, Attention, Summary, Checkpoint | None; a session belongs to no task |

## Decisions waiting for the owner

These are direction questions that this PR does not settle:

1. **Node.js runtime versus the Rust backend.** AGENTS.md requires privileged operations and scope restrictions to live in the Rust backend, and ADR-0002 chose the official `agent-client-protocol` Rust crate with AgentDock's own process supervision (Job Object on Windows). `apps/runtime` is a Node.js process using the TypeScript SDK. It is labelled a development host throughout, but it does spawn agents, decide approvals and store history. Whether it may stay in the repository as a development and test fixture, has to be replaced before anything builds on it, or should become the base of the product needs an owner decision. Nothing here was rewritten in Rust.
2. **New dependencies.** `@agentclientprotocol/sdk@2.7.0` (Apache-2.0, runtime dependency) and `concurrently@9.2.1` (MIT, dev dependency) are added without a row in `docs/sources.md`. No third-party source file was copied. Whether ADR-0002's migration PR template applies to npm dependencies of a development host is for the owner (or the stack-level review) to decide.
3. **Contract alignment.** Either this store is migrated to the PR #22 contract once that is accepted, or it is discarded with the Node host. PRs stacked on this one inherit the format above until then.

## Verification in CI

The GitHub Actions `Frontend` workflow now runs `npm run typecheck`, the React/Vitest suite, `npm run test:runtime` and `npm run build` on every PR. The runtime integration suite launches actual local mock/hostile ACP subprocesses on Ubuntu; it checks denial, approval expiry, cancellation (including transport failure), host recovery and process cleanup. This is not evidence of Windows Job Object support, real paid agents, or Tauri packaging.

## Next production work

- Native Tauri command IPC over an official Rust SDK ACP facade (#4, #6).
- Durable canonical task/session state from [PR #22](https://github.com/ChiJiun/agentdock/pull/22) contracts, with event migration and capability-gated reattach (#7).
- OS sandbox + mandatory backend policy for **all host-owned** tool actions (#8).
- Worktree-per-task isolation, Issue→PR/CI with independent verification and human merge approval (#9, #10).
- Remote Worker with restart/checkpoint and no replay of non-idempotent operations (#12).
- Real Session Sentinel event-driven summaries and language overlays on supported ACP capabilities (#15, #18).
