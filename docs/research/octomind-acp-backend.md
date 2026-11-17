# Octomind as an ACP backend: source study and go/no-go

Status: research for [Issue #11](https://github.com/ChiJiun/agentdock/issues/11) · 2026-11-17 · **source reading only, nothing was executed** (see [Live test](#live-test-prepared-not-run)).
Related: [ADR-0001](../decisions/0001-independent-workbench.md), [ADR-0002](../decisions/0002-source-reuse.md), [sources.md](../sources.md), [PRD](../PRD.md), [architecture.md](../architecture.md).

No third-party code is copied by this document. Octomind file paths and line numbers refer to the pinned commit in section 1.

How to read the evidence labels:

- **[src]** read in Octomind source at the pinned commit.
- **[doc]** stated by Octomind's own documentation at the pinned commit (not checked against behavior).
- **[upstream CI]** result of Octomind's own GitHub Actions run, read through the GitHub API.
- **(inferred)** my conclusion from reading code. Nothing in this document was observed on a running process.

## Summary

| Question | Answer |
| --- | --- |
| Can Octomind be driven as an external ACP agent? | **Yes, by design.** `octomind acp [TAG]` serves ACP v1 over stdio on the same SDK AgentDock chose (`agent-client-protocol` 5.3.0) **[src]** |
| Import Octomind source (`src/acp`, `src/supervisor`, `src/session`) into AgentDock? | **No-go.** See section 6 |
| Use it as an external ACP backend? | **Go, as an opt-in adapter with the launch rules in section 5**, after the live checks in section 8 pass |
| Largest gap | **Octomind never sends `session/request_permission`.** Its tools run without a client approval round-trip, so AgentDock's approval gate cannot cover Octomind's own tool calls **[src]** |
| Does this close Issue #11? | **No.** The benchmark half of the PoC (3-5 tasks on Claude Code, Codex and Octomind; time, memory, CPU, success rate, cost) was not run. See section 7 |

## 1. Pinned source and license

| Item | Value | How checked |
| --- | --- | --- |
| Repository | [Muvon/octomind](https://github.com/Muvon/octomind), default branch `master` | `gh api repos/Muvon/octomind` |
| Pinned commit | `7d729126ade5ada08ef89fad33637c46e729739c` (2026-11-16T14:05:23Z), same pin as [sources.md](../sources.md) | `gh api repos/Muvon/octomind/commits/master` |
| Latest release | `0.72.0` (2026-11-15), tag commit `ff9d8b59fe1bddbee8747f1e04a4af0a508aacef` | `git ls-remote --tags` |
| Release to pin distance | 18 commits, **none touching `src/acp/`**; one touches the ACP *client* side (`src/mcp/agent/functions.rs`) | `gh api .../compare/ff9d8b59...7d729126` file list |
| License | Apache-2.0 (`LICENSE`, `Cargo.toml` `license = "Apache-2.0"`); no root `NOTICE` file | read at pinned commit |
| File headers | All six files in `src/acp/` carry "Copyright 2026 Muvon Un Limited" + Apache-2.0 header | `grep` at pinned commit |
| Crate metadata | `octomind` 0.72.0, edition 2021, `rust-version = "1.95"` | `Cargo.toml` |
| ACP dependency | `agent-client-protocol = "5.3.0"` with default features; lock file has `agent-client-protocol-schema 1.18.0` | `Cargo.toml:122`, `Cargo.lock` |
| Windows binary | `octomind-0.72.0-x86_64-pc-windows-msvc.zip`, 19,652,209 bytes, SHA-256 `7dd108f0fb40ab1014967734b857d764b7f9cc6abb4dc632831ba60d978c2698` (published `.sha256` file and GitHub asset digest agree); contains one file `octomind.exe` (50,898,944 bytes). An ARM64 Windows build is also published | downloaded and hashed; **not executed** |
| Upstream CI at `0.72.0` | `Test Suite (windows-latest, 1.99.1)` **success**; ubuntu success; macOS failed in "Run tests" | run `43707078808` **[upstream CI]** |
| Upstream CI at the pinned commit | Overall **failure**: ubuntu `Run tests` failed, the Windows and macOS test jobs were **cancelled** | run `43890261705` **[upstream CI]** |

Size, for the cost comparison in section 6 (measured on the pinned checkout): 592 Rust files under `src/`; about 124k lines outside `*_tests.rs` and about 127k lines in `*_tests.rs`; `src/acp` 5,799 lines, of which 3,219 are tests; disk usage (`du`) `src/acp` 220 KB, `src/supervisor` 1.9 MB, `src/session` 3.8 MB; `Cargo.lock` lists 590 packages (upper bound: includes dev-dependencies and all platforms).

## 2. Launching Octomind as an ACP agent

**[src]** `src/main.rs:70-71`, `src/commands/acp.rs`, `src/acp/mod.rs`; **[doc]** `doc/integration/02-acp-protocol.md`, `doc/usage/12-editor-integration.md`.

```text
octomind acp [TAG] [--name NAME] [--resume SESSION] [--resume-recent] [--model PROVIDER:MODEL] [--sandbox]
```

- Transport: newline-delimited JSON-RPC on stdin/stdout. stdout is reserved for the protocol; diagnostics go to `<data dir>/logs/acp-debug.log`, `acp-errors.jsonl` and `acp-init-errors.log`. Bootstrap failures can still reach stderr before logging starts, so stderr must be drained.
- `TAG` is a local role name from the config (for example `assistant`), a tap agent (`developer:general`) or a bare domain. **Omitting it uses the config default `assistant:chief`, which is a tap agent, not the local `assistant` role** (`config-templates/default.toml:27`).
- `--model` applies to every session of that process; `--name` / `--resume` / `--resume-recent` are consumed by the first `session/new` only.
- A role that cannot start (unknown tag, missing input) does not close the pipe: the agent still answers `initialize` and fails every session request with the reason (`AcpRunOptions::startup_error`, `src/commands/acp.rs`).
- State location: `OCTOMIND_DATA_DIR` overrides config, sessions, logs and cache. On Windows the default is `%LOCALAPPDATA%\octomind`, and the source comment says redirecting `HOME` isolates nothing there (`src/directories.rs`). Two things stay outside that directory: run sockets/pipes (system temp) and "dependency-owned model caches" (**[doc]**; upstream `ci.yml` caches the octolib Hugging Face directory at `~/AppData/Local/octolib/huggingface` on Windows).
- The ACP event loop runs on a dedicated thread with an 8 MiB stack because "the default main thread stack is 1 MiB on Windows, and a full tool round there overflows it" (`src/acp/mod.rs:34-36`). This is the same failure class ADR-0002 recorded for Acpira's sidecar (X-2).

## 3. Protocol behavior

All rows **[src]** `src/acp/agent.rs` unless marked.

| Area | What Octomind does | Reference |
| --- | --- | --- |
| Protocol version | Always answers `ProtocolVersion::LATEST`, which is `1` in schema 1.18.0 without `unstable_protocol_v2`. It does not look at the version the client asked for. No v2 | `agent.rs:1112`; schema `src/version.rs` |
| `agentInfo` | `{ name: "octomind", version: <crate version> }` | `agent.rs:1122` |
| `agentCapabilities` | `loadSession: true`; `mcpCapabilities.http: true` (SSE not supported, such servers are skipped); `promptCapabilities.image: true`, `embeddedContext: true`; `_meta["octomind.dev"] = { commands: true }`. **No `sessionCapabilities` are set**, so no list/fork/resume/close is advertised **(inferred from `AgentCapabilities::default()` plus the three setters)** | `agent.rs:1113-1121` |
| Handlers registered | `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/cancel` (notification), and extension requests (`_octomind/command`). Any other client request gets `method_not_found`. There is no handler for `session/set_mode`, session config options or model selection | `agent.rs:2127-2230` |
| Authentication | One method, `octomind-login` (agent-side device flow). `authenticate` **opens the system browser from the agent process** (`open::that`) and polls until confirmed. Only needed when the session model is `octohub:*` without `OCTOHUB_API_KEY`; then `session/prompt` fails with `auth_required`. Other providers read keys from the agent's environment or `.env` files | `agent.rs:1131-1154`, `:1477-1485` |
| `session/new` | Sets the session working directory from `cwd`; merges client MCP servers (stdio and HTTP; injected `env` and `headers` are ignored **[doc]**); starts MCP servers; returns the session name as `sessionId`; sends `available_commands_update`; starts a background "inbox monitor" for that session | `agent.rs:1156-1247` |
| `session/load` | Resumes a saved session by id from disk. **It does not replay history as `session/update`**: the handler sends only `available_commands_update` and creates no channel that could forward stored messages **(inferred)**, and upstream's own end-to-end test says "This agent does not replay history on load" (a comment a few lines earlier in the same test, `:453-454`, says the opposite; the handler code agrees with the later one) | `agent.rs:1895-1965`; `tests/acp_e2e_test.rs:462-464` |
| Prompt content | Text, images, embedded text resources, `file://` resource links only inside the session cwd (canonicalized, so symlink escapes are rejected), video blobs; audio ignored | `agent.rs:91-179` |
| Streaming updates | `agent_message_chunk`, `agent_thought_chunk`, `tool_call` (with `kind`, `locations`, `rawInput`, and diffs taken from edit *inputs*), `tool_call_update` (`completed` / `failed`, `rawOutput`), `available_commands_update`, `session_info_update` | `agent.rs:548-610`, `:1693-1759` |
| **Permission requests** | **None.** The string `request_permission` / `RequestPermission` does not occur anywhere in `src/`, `tests/` or `doc/`. Tool calls are announced with status `in_progress` and then executed. The agent also never calls the client's `fs/*` or `terminal/*` methods | `grep` over the pinned tree |
| Agent → client requests | Only `elicitation/create`, and only when the client advertised `clientCapabilities.elicitation` (form and/or URL); otherwise MCP elicitations are declined | `agent.rs:637-741` |
| Cancellation | `session/cancel` flips the session's cancellation flag inline, even while a prompt is running. The prompt then returns `stopReason: "cancelled"` if the model call ended without error; an API failure during cancellation can still surface as a JSON-RPC error **[doc]**. Whether child tool processes are killed on cancel was not traced | `agent.rs:1883-1893`, `:1854-1878` |
| Errors | Unknown session → `invalid_params` with `session not found: <id>`; model/API failure → `internal_error` with the error chain in `data`; unknown auth method → `invalid_params`; missing sign-in → `auth_required`. A prompt with no supported content returns `end_turn` immediately | `agent.rs:1252-1265`, `:1286-1288`, `:1874-1877` |
| Usage and cost | Not the standard ACP usage update. Sent as `session_info_update` with `_meta["octomind.usage"]` (`session_tokens`, `session_cost`, input/output/cache/reasoning tokens). Also `_meta["octomind.verified"]`, `octomind.pending_work`, `octomind.spending_stop` | `agent.rs:417-438`, `:1796-1829` |
| Agent-initiated turns | The inbox monitor can start a model turn **without a client prompt** (schedules, background agents, detached jobs) and streams it as `user_message_chunk` (prefixed with its source) followed by normal agent updates | `agent.rs:823-1087` |
| Slash commands | Sent as ordinary prompt text and intercepted before the model; also callable through `_octomind/command`. The advertised list includes commands that act on the **agent host** (`copy`, `clear`), `login`, and `share`, which uploads the session log to `OCTOMIND_SHARE_URL` (default `https://octomind.run`) **[doc]** | `agent.rs:750-804`, `:1385-1458` |
| Shutdown | No shutdown request. The client closes stdin; the agent finishes in-flight replies and **waits for pending background work** before exiting | `agent.rs:2231-2256` |
| Several sessions in one process | Supported (map keyed by session id, one lock per session). But slash commands write config changes (`/model`, `/role`) back to the process-wide config, MCP processes and tool registration are shared, and telemetry tool counters are process-wide | `agent.rs:1406-1418`, `:243-266`; **[doc]** |

Tool approval inside Octomind **[doc]** `doc/usage/14-supervisor.md`: optional `[supervisor.authorizer]` (off by default) is a model-based, "allow-first" check of tool calls against role and user intent; "native pre-call guards" and user-defined guardrails run first. None of this involves the ACP client.

## 4. Windows

| Topic | Finding |
| --- | --- |
| Binaries | x86_64 and ARM64 MSVC builds on every release; `install.ps1` and a Scoop bucket; needs the Visual C++ Redistributable **[doc]** |
| Upstream test coverage | `ci.yml` runs `cargo test` on `windows-latest`. `tests/acp_e2e_test.rs` (initialize → `session/new` → prompt → `session/load` against a local stub provider) has no platform gate, so it is part of that job **(inferred)**. Two ACP unit tests are Unix-only (read-only data directory, symlink escape). The job passed at `0.72.0` and was cancelled at the pinned commit **[upstream CI]** |
| `--sandbox` | **No-op on Windows.** `src/sandbox/mod.rs` implements Linux (Landlock) and macOS (Seatbelt); every other platform logs "Sandbox requested but not supported on this platform" and continues without write restrictions **[src]**. It is also applied to the process launch directory, not to each session's `cwd` (`src/main.rs:319-328`) |
| Main-thread stack | Handled upstream with the 8 MiB ACP thread (section 2) **[src]** |
| Tap dependency scripts | Tap agents may declare `[deps]`; Octomind runs `<tap>/deps/<org>/<tool>.sh` with **Git Bash** (`%ProgramFiles%\Git\bin\bash.exe`, falling back to `bash` on `PATH`) before MCP start (`src/agent/deps.rs:75-123`) **[src]** |
| Past Windows ACP defects | Changelog entries "stop ACP prompt hang on Windows stdin pipes" (`2e57c00d`), "terminate Windows MCP process trees" (`9c869287`), "skip e2e tests on windows" (`d3aac046`, earlier) **[doc]** show the path is exercised and has needed fixes |
| Not known | Start-up time, memory, CPU, behavior with CJK or space-containing paths, process-tree cleanup when AgentDock kills the agent. None were measured |

## 5. What AgentDock must do to launch it safely

These follow from sections 2-4 and from AgentDock's own rules (AGENTS.md, architecture.md "sanitized environment", PRD "no hidden tool execution or secret exfiltration"). They are **requirements for the adapter, not verified behavior**.

1. **Always pass an explicit local role or tag chosen by the user.** With no tag, the shipped default `assistant:chief` resolves through the built-in tap, which is a `git clone` / `git fetch` from GitHub into the data directory (`src/agent/taps.rs`), and tap agents can run dependency install scripts (section 4). AgentDock must not trigger that silently.
2. **Environment allow-list.** Octomind reads provider keys from the process environment, then `<config dir>/.env`, then **`./.env` in its working directory, which overrides both** **[doc]** `doc/reference/04-environment-variables.md`. Launching it inside a task worktree therefore loads that worktree's `.env` into the agent. AgentDock should pass only the variables the user selected for this adapter and tell the user about the `.env` behavior.
3. **Telemetry is on by default** (`telemetry = true`; events go to `OCTOMIND_API_URL`, default `https://api.octomind.run`; identifiers and counters, not content, per `src/telemetry.rs`). `DO_NOT_TRACK=1` or `OCTOMIND_TELEMETRY=0` turns it off. Whether AgentDock sets that by default is an owner decision (section 9); either way the adapter settings must show it.
4. **Data directory.** Either leave the user's normal Octomind state alone, or set `OCTOMIND_DATA_DIR` for an AgentDock-owned profile. This also decides which sessions `session/load` can see.
5. **One agent process per AgentDock session (or per worktree).** It avoids the shared config, shared MCP processes and process-wide counters listed in section 3, and makes "kill this session" a process-tree operation.
6. **Shutdown with a deadline.** Close stdin, wait a grace period, then end the Job Object. The agent waits for its own background work on EOF, so a missing deadline can hang AgentDock (ADR-0002 spike S2 already covers the spawner).
7. **Honest approval scope in the UI.** For an Octomind session AgentDock can show tool calls but cannot approve or deny them, and `--sandbox` gives no protection on Windows. The session must be labeled like the agent-native bypass modes in ADR-0002 APR-11: AgentDock policy applies only to operations AgentDock performs itself (worktree, push, PR, merge).
8. **Capability-driven UI.** Show resume only because `loadSession` is advertised; do not show session list/fork/close, mode or model pickers, because nothing advertises them. Model choice is a launch argument (`--model`) or the `/model` command.

## 6. External ACP backend vs merging the runtime

"Merging" means taking Octomind's agent loop (`src/session`, `src/supervisor`, `src/mcp`, providers) into AgentDock's Rust workspace, as a vendored copy or a linked library.

| Dimension | External ACP backend | Merge the runtime |
| --- | --- | --- |
| Code AgentDock owns | An adapter entry (command, args, env allow-list, capability notes) and mapping for `_meta` fields | About 124k non-test Rust lines today, plus tests, config templates and tap/capability formats |
| Dependencies | None added to AgentDock | Up to 590 lock-file packages; build needs `rustc` ≥ 1.95, `protoc`, ONNX Runtime (static on Linux, prebuilt `/MD` on Windows with a forced dynamic CRT, per upstream `ci.yml`); the Windows executable alone is about 51 MB |
| Upstream pace | Absorbed by upgrading a binary; the ACP surface is the contract | Five releases within 12 days (0.69.0 on 2026-11-03 to 0.72.0 on 2026-11-15) and 18 more commits in the roughly 26 hours after 0.72.0; every one would be a merge or a drift decision |
| Architecture fit | Matches ADR-0001/0002 and architecture.md ("external agents remain owners of their prompt loops, model usage, context, tools and authentication") | Conflicts with ADR-0001 (no native agent in the MVP) and PRD §8 ("Reimplementing Claude Code, Codex, or Octomind internals" is excluded). The session machinery is `!Send`, single-threaded on a `LocalSet` with thread-local session context and process-global state (`agent.rs:1982-1992`), so it cannot simply be called from Tauri command handlers |
| Approvals | Not available (no permission requests) | Possible in principle, by adding AgentDock's policy gate inside the tool executor, but that is a fork of the most security-sensitive code path |
| Security updates | Upstream ships them; AgentDock documents a minimum version | AgentDock must track and port them |
| License | Nothing redistributed, so no obligations flow into AgentDock packages | Apache-2.0: keep headers, mark changed files, ship the license; AgentDock's own license is still undecided (ADR-0002 §5), which blocks any copy |
| Failure isolation | Agent crash, stack overflow or hang is contained in a child process tree | Same failures take down the desktop app or its worker |
| Windows | Upstream builds and tests Windows; AgentDock tests only the launch path | AgentDock inherits the full Windows build and test matrix |
| What is lost | Fine-grained control: per-tool approval, cost routing, supervisor signals beyond what `_meta` exposes | Nothing, at the cost above |

Integration gaps, sorted by what it takes to close them:

| Gap | Close with |
| --- | --- |
| Usage/cost only in `_meta["octomind.usage"]` | Small adapter mapping; record the source as "agent-reported" (PRD: separate provider-reported, estimated, unknown) |
| `session/load` without history replay | Already AgentDock's plan: the timeline is restored from AgentDock's own event store; "reattach" stays a separate, capability-gated action |
| Agent-initiated turns outside a prompt | Timeline and state machine must accept `session/update` while no prompt is pending, and use `octomind.pending_work` to show "background work running" |
| Model selection, no modes/config options | Adapter setting mapped to `--model` |
| Auth: agent opens the browser itself; provider keys via env | Adapter documentation + env allow-list (section 5) |
| No shutdown request, EOF waits for background work | Spawner deadline (ADR-0002 S2) |
| Default tag fetches a tap and may run install scripts; telemetry; `./.env` | Launch rules and disclosure (section 5) |
| Slash commands that act on the agent host or upload the session (`/share`) | Treat as agent-owned commands; optional confirmation for `share` |
| **No per-tool approval through ACP** | **Not closable by an adapter.** Needs an upstream feature (Octomind sending `session/request_permission`, or delegating writes/commands to the client's `fs`/`terminal`), or acceptance of "observe-only" with honest labeling |
| **No write confinement on Windows** | **Not closable by an adapter.** Worktree-per-task limits accidents between tasks but is not a security boundary |

None of the gaps requires rewriting or importing the runtime. The two that an adapter cannot close would not be closed by a vendored copy either without forking Octomind's tool executor.

## 7. Recommendation

1. **No-go on importing Octomind source.** `src/acp/` is agent-side glue to Octomind's own session types and has no use in an ACP *client*; `src/supervisor/` and `src/session/` are the runtime that ADR-0001 and the PRD exclude. This confirms the ADR-0002 rows "Octomind `src/acp/`: protocol adapter" and "`src/supervisor/`, `src/session/`: research only". No new ADR is needed; if the owner wants the decision recorded as accepted, a one-line status change in ADR-0002 is enough.
2. **Go on Octomind as an external ACP backend, opt-in, under the section 5 launch rules**, once the live checks in section 8 pass on Windows.
3. **Do not count Octomind as one of the two MVP adapters that prove the approval flow.** The PRD success gate "Denied tool action does not execute" cannot be demonstrated with an agent that never asks. Use it instead as the integration-test target for: `_meta` pass-through, updates outside a prompt, `loadSession` without replay, and EOF shutdown.
4. **Ideas worth keeping as prose only** (no code): reporting a "verified" signal and "pending background work" next to `end_turn`; surfacing a role start-up failure through the protocol instead of closing the pipe; running the protocol loop off the main thread on Windows.
5. Goose, Aether and Octos (listed as research inputs in the issue) were **not re-examined here**; their ADR-0002 classification ("research only") stands unchanged.

### Issue #11 PoC checklist

| PoC item | Status |
| --- | --- |
| Verify exact ACP command and protocol versions from pinned source | **Done from source** (sections 1-3); not confirmed on a running process |
| Adapter config, model selection, tool approval semantics, cancellation and recovery | **Described from source** (sections 3 and 5); no adapter was configured or run |
| Run 3-5 safe coding tasks with Claude Code, Codex and Octomind in isolated worktrees | **Not done** (needs the owner's agent accounts and a model for Octomind) |
| Record capabilities, runtime/memory/CPU, start-up time, error/resume behavior, success rate, cost | **Capabilities from source only; no measurements** |
| Identify integration gaps: small adapters vs runtime rewrite | **Done** (section 6) |
| ADR recommending retain-Acpira-module / ACP-backend / native-runtime | **Recommendation given here; no new ADR.** ADR-0002 already records ACP-backend for external runtimes and "reimplement" for the Acpira host |

Acceptance ("reproducible comparison, no false universal capability claims, concrete go/no-go for importing Octomind source"): the go/no-go is given and capability claims are limited to what the source shows; **the reproducible comparison is missing**, so the issue should stay open.

## 8. Live test: prepared, not run

A minimal local test was planned: the published `0.72.0` Windows binary, a throwaway `OCTOMIND_DATA_DIR`, telemetry off, no credentials, and a local stub that speaks the OpenAI Chat Completions format (the `local:` provider reads `LOCAL_API_URL`, the `ollama:` provider `OLLAMA_API_URL` **[doc]**). The binary was downloaded and its checksum verified (section 1). **Executing it was blocked by the tool-permission policy of the session that did this research, so nothing was run and no result is reported.**

When a run is permitted, upstream's own end-to-end test is the recipe to follow (`tests/acp_e2e_test.rs:134-152`, `:172-177`, `:329-365`):

1. Config in a temporary data directory: default template with `model = "ollama:fake-model"` (or `local:<name>`), `default = "assistant"`, `supervisor.enabled = false`, `telemetry = false`, `auto_capabilities = false`, skill auto-activation and auto-validation off.
2. Environment: `OCTOMIND_DATA_DIR=<temp>`, `DO_NOT_TRACK=1`, `OLLAMA_API_URL` (or `LOCAL_API_URL`) pointing at the stub's full `/v1/chat/completions` URL; nothing else inherited.
3. `octomind acp assistant` with piped stdio; send `initialize` (`protocolVersion: 1`, empty `clientCapabilities`), `session/new` (`cwd`, `mcpServers: []`), `session/prompt`.

Checks to add on top of upstream's test, because they decide the adapter design:

- L1. The exact `initialize` result on Windows (compare with section 3), and the answer when the client sends `protocolVersion: 2`.
- L2. A stub reply containing a tool call: confirm that no `session/request_permission` arrives and the tool runs (expected from section 3).
- L3. `session/cancel` during a slow stub reply: stop reason, time to return, and whether child processes remain.
- L4. `session/load` in a second process: no replayed history; the session continues.
- L5. Stub returning HTTP 500, an unknown `sessionId`, a malformed line, an unknown method: error codes and whether the connection survives.
- L6. Close stdin: exit code and time; then kill the process tree instead and look for survivors.
- L7. Time from spawn to `initialize` result, and peak working set, on a cold and a warm start.
- L8. Network: confirm no outbound connection other than the stub when an explicit local role is used and telemetry is off.
- L9. Run [acp-tck](https://github.com/agentclientprotocol/acp-tck) against `octomind acp` (it tests agents; see ADR-0002).

## 9. Open questions for the owner

1. Should AgentDock set `DO_NOT_TRACK=1` for agents it launches by default, or pass the user's own setting through unchanged? (AGENTS.md says to respect the external runtime's ownership; the PRD says no hidden exfiltration. Both are satisfiable by disclosure; the default is a product choice.)
2. Is an "observe-only" agent (no approval round-trip) acceptable in the MVP adapter list at all, or only behind an explicit "this agent does not ask for permission" acknowledgement?
3. Should the missing permission request be raised upstream with Octomind? Nothing was filed.

## 10. Not verified

- **Nothing was executed.** Every behavior in sections 2-4 is from source, upstream documentation or upstream CI, as labeled.
- The benchmark part of Issue #11 (tasks on three agents; time, memory, CPU, success rate, cost) was not started.
- `[doc]` statements were not cross-checked against code unless a source reference is given next to them; in particular the `.env` precedence, the telemetry field list, the `/share` upload and the injected MCP `env`/`headers` being ignored.
- Whether cancellation kills running tool child processes; whether `session_cost` is provider-reported or estimated; how `octomind config` creates a first config for a non-interactive `acp` start.
- Which tools a given role exposes on Windows and where they come from (filesystem and shell tools come from external MCP servers such as `octofs`, per upstream docs); no tool was inspected.
- The upstream Windows test job result is known for `0.72.0` only; at the pinned commit it was cancelled.
- The tap repository (`muvon/octomind-tap`) and its dependency scripts were not read.
- No `cargo tree`, `cargo deny`, `cargo audit` or build of Octomind was run; the 590-package figure is a lock-file count.
- Octomind's hosted services (OctoHub gateway, account, share viewer) and their terms were not reviewed.

## Sources

Kept here instead of [sources.md](../sources.md) to avoid conflicts with open PRs that edit that file; the Octomind row there already carries the same pin.

| Source | Pin | Used for |
| --- | --- | --- |
| [Muvon/octomind](https://github.com/Muvon/octomind) | `7d729126ade5ada08ef89fad33637c46e729739c`; release `0.72.0` = `ff9d8b59fe1bddbee8747f1e04a4af0a508aacef` | Everything in sections 1-6. Files read: `src/acp/mod.rs`, `src/acp/agent.rs`, `src/commands/acp.rs`, `src/main.rs`, `src/directories.rs`, `src/sandbox/mod.rs`, `src/session/cancellation.rs`, `src/telemetry.rs` (header), `src/agent/deps.rs`, `src/agent/taps.rs` (grep), `tests/acp_e2e_test.rs`, `config-templates/default.toml`, `.github/workflows/ci.yml`, `Cargo.toml`, `Cargo.lock`, `LICENSE`, `CHANGELOG.md` (grep), `doc/integration/02-acp-protocol.md`, `doc/usage/01-installation.md`, `04-providers.md`, `12-editor-integration.md`, `14-supervisor.md`, `doc/reference/04-environment-variables.md`, `doc/reference/02-session-commands.md` (grep), `doc/use-cases/18-private-code-with-local-models.md` |
| Octomind GitHub Actions | runs `43707078808` (tag `0.72.0`), `43890261705` (pinned commit) | Upstream CI results |
| [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol) | `4aab69b4e6bcb53965ff5b1141d2f04a62a25c6c` (`agent-client-protocol-schema` 1.18.0) | `ProtocolVersion::LATEST` = 1 (`agent-client-protocol-schema/src/version.rs`); `v1` elicitation types are not behind an `unstable_*` feature. SDK `v5.3.0` `Cargo.toml` has `default = []` features |
| AgentDock | `main` at `8a21ce9` | ADR-0001, ADR-0002, PRD, architecture.md, sources.md |

Method: `gh api` for repository metadata, tags, compare and workflow runs; a read-only shallow fetch of the pinned commit into a temporary directory (no build, no scripts, hooks disabled); `grep`/`wc` on that checkout.
