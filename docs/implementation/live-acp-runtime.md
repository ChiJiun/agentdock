# Live ACP Runtime — development implementation

Status: **Implemented and locally verified as a Node.js development host**
Date: 2026-11-17
Tracks: [Issue #6](https://github.com/ChiJiun/agentdock/issues/6), [#7](https://github.com/ChiJiun/agentdock/issues/7), [#8](https://github.com/ChiJiun/agentdock/issues/8), [#15](https://github.com/ChiJiun/agentdock/issues/15), [#18](https://github.com/ChiJiun/agentdock/issues/18)

This is an **interim runtime for validating real Agent Client Protocol integration** while the planned Rust/Tauri host is not ready. It is not a production service and is not intended to be exposed to LAN/Internet.

## Verified end-to-end behavior

- Uses the **official Apache-2.0-licensed** `@agentclientprotocol/sdk@2.7.0` (stable ACP v1).
- Spawns a **locally configured** child process with argument arrays, `shell:false`, a bounded environment, and working-directory realpath checks within explicitly approved roots.
- Starts ACP handshake `initialize`, then `session/new`, followed by `session/prompt`; supports `session/cancel`.
- Receives actual `session/update` notifications and writes them to an append-only SQLite event journal with sequence cursors.
- Persists session metadata and events. On restart, any previous live session becomes `interrupted`; **agent context is not silently reattached**.
- Handles ACP `session/request_permission`: stores a pending approval, waits for an explicit human decision, supports only advertised `allow_once` options (never automatically accepts `allow_always`), expires unused requests after 90 seconds, and blocks duplicate approvals.
- Read-only Git status and patch evidence, invoked by the user; no automatic push/merge/deletion.
- Local HTTP development API bound to `127.0.0.1:4319`, with origin checks, JSON-only mutation requests, strict payload limits, no CORS grant, and a fixed set of endpoints. The Vite server proxies `/api` to this host.
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

## Data and restart semantics

- SQLite file: `.local/agentdock.db` (gitignored), including journal metadata, limited/redacted event payloads, and approval records.
- Readonly historical Session listing works after a restart; any old active Session is labelled `interrupted` and prompting it returns an error.
- The host does **not** promise reconnection to external model state. Actual ACP `session/load` capability support and verified replay remain future work.
- A user's Prompt and Agent output can contain private content: the store only performs best-effort redaction; keep the database private, never pass credentials as natural-language prompts, and do not export it by default.
- Node 22's built-in `node:sqlite` remains **experimental**. This is a development-only store; migrate to the planned Rust store before production release.
- Closing the UI does not guarantee that the dev host will continue running. Start/stop with your normal development process. This is **not** a remote 24/7 Worker.

## Security boundaries and unresolved risks

**What is enforced:** exact permitted working-directory realpaths, a configured process allowlist, API Origin/JSON restrictions, explicit handling of ACP permission requests, no automatic replay of push/merge/delete actions, local-only binding, and read-only Git inspector.

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

Runtime integration tests start the SDK mock subprocess; verify streamed output, denial and single-use approval, persisted historical session on restart, directory validation, same-origin API, and event payload/JSON safety.

`npm run dev:full` was smoke-tested: `GET /api/health` through Vite at 127.0.0.1:5173 returned `{"ok":true,"mode":"local-development","protocol":"ACP v1","storage":"sqlite"}`.

GitHub Actions and Windows Tauri compile have **not** been verified due missing workflow token scope and Rust toolchain in this VM.

## Next production work

- Native Tauri command IPC over an official Rust SDK ACP facade (#4, #6).
- Durable canonical task/session state from [PR #22](https://github.com/ChiJiun/agentdock/pull/22) contracts, with event migration and capability-gated reattach (#7).
- OS sandbox + mandatory backend policy for **all host-owned** tool actions (#8).
- Worktree-per-task isolation, Issue→PR/CI with independent verification and human merge approval (#9, #10).
- Remote Worker with restart/checkpoint and no replay of non-idempotent operations (#12).
- Real Session Sentinel event-driven summaries and language overlays on supported ACP capabilities (#15, #18).
