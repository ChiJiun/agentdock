# ADR-0002: Source reuse, ACP SDK choice and licensing guardrails

Date: 2026-11-17
Status: Proposed. Module decisions are ready for owner acceptance in the PR that adds this file. **AgentDock's own license is explicitly left to the owner** (section 5).
Related: [Issue #1](https://github.com/ChiJiun/agentdock/issues/1), [ADR-0001](0001-independent-workbench.md), provenance manifest in [sources.md](../sources.md)

## Context

ADR-0001 chose an independent Rust + Tauri 2 + React workbench that talks to external agents over ACP and only imports upstream code after provenance, dependency, license and test review. Issue #1 asks for that review at module level before any migration starts: exact SHAs, import trees, licenses, a comparison of the official ACP Rust SDK with Acpira's ACP host, and requirements/test cases from the unmerged Acpira fork PRs.

All SHAs, paths and measurements below come from the snapshot in [sources.md](../sources.md). Statements marked **(inferred)** come from reading code, not from running it.

## Decision summary

1. **ACP client: depend on the official `agent-client-protocol` crate** (Apache-2.0, 5.3.0, stable protocol v1), wrapped by AgentDock's own `crates/acp` facade. Do not import Acpira's `acpira-rpc` or `acpira-host` ACP code.
2. **Agent process supervision stays under AgentDock's control.** Spawn agents with Tokio, own the Windows process tree (Job Object), frame stdout lines in the facade, and hand them to the SDK's `Lines` transport. Prefer the published `process-wrap` crate for the process tree if spike S2 passes; Acpira's Windows launcher is a deferred **reuse** fallback.
3. **Acpira UI and desktop shell: reimplement**, using Acpira and Claude Code Desktop only as interaction references.
4. **External runtimes (Claude Code via claude-agent-acp, Codex via codex-acp, Octomind) are protocol adapters**, launched as separate processes and never bundled.
5. **Goose, Octos, Aether, Octomind internals: research only.** Forge (AGPL-3.0-only): **excluded**, with a clean-room rule.
6. **Fork PRs #2, #4, #5, #6 contribute requirements and acceptance scenarios only** (section 4), not code.
7. No code is imported by this ADR. Any later copy, fork or new direct dependency on the modules above goes through the migration PR template in sources.md.

## 1. ACP implementation: official Rust SDK vs Acpira host

Compared: `agentclientprotocol/rust-sdk` crate `agent-client-protocol` (release `v5.3.0`, tip `6a4a95cabed1b5307651a19771c20b91bb6566ea`) and `hotic/acpira` at `0481995e3a55abcd707f6808df9d7f396483c3e1` (`rust/crates/acpira-rpc/src/rpc.rs`, `rust/crates/acpira-host/src/acp/transport/process.rs`, `rust/crates/acpira-host/src/acp/session/lifecycle.rs`, `rust/crates/acpira-host/src/platform/windows_process.rs`).

| Dimension | Official SDK (`agent-client-protocol` 5.3.0) | Acpira host (`acpira-rpc` + `acpira-host`) |
| --- | --- | --- |
| Protocol coverage | Typed v1 schema from `agent-client-protocol-schema =1.18.0`; separate `v1`/`v2` modules; draft v2 and each unstable RFD behind opt-in features (`unstable_protocol_v2`, `unstable_session_fork`, `unstable_auth_status`, ...) | Untyped `serde_json::Value` throughout, so vendor fields and `_meta` pass untouched. Hard-codes `PROTOCOL_VERSION = 1` (`process.rs:23`) |
| Version negotiation | Connection carries a protocol-version guard; v1 and v2 types cannot be mixed by accident; tests in `tests/protocol_negotiation.rs`. Whether a v1 **client** rejects an agent that answers with another version was **not confirmed** (spike item S3) | Logs the agent's `protocolVersion` (`lifecycle.rs:315-316`); no code that rejects a mismatch was found **(inferred)** |
| Error handling | Typed `Error`/`ErrorCode` matching the schema codes. A line that is valid UTF-8 but not JSON is answered as a malformed frame and the connection stays up. **In 5.3.0 a line that is not valid UTF-8 ends the whole connection and every session on it**: `ByteStreams`, `Stdio` and `AcpAgent` read with `BufReader::lines()` (`src/agent-client-protocol/src/jsonrpc.rs:7285` at tag `v5.3.0`) and the incoming transport actor treats that read error as a transport failure. Fixed by `6a4a95ca` "fix(acp): keep the connection open when an incoming line is not valid UTF-8 (#504)", which is **not in any release yet** (crates.io latest is 5.3.0) | `RpcError` with -32601, -32603, -32800 (cancelled), -32099 (connection closed). Reads raw bytes and parses with `serde_json::from_slice`, so non-UTF-8 and non-JSON lines are both logged and skipped (`acpira-rpc/src/rpc.rs:163-172`); 256 MiB per-line cap; spawn failures classified as `ENOENT`/`EACCES`/unopenable folder |
| Capability negotiation | Typed `InitializeRequest`/`Response`; client capabilities built by the caller | Advertises `fs`/`terminal` false, `elicitation.form`, `session.configOptions.boolean`, `session.compaction`, `session.notices`, optional `subagents`, `auth.terminal`, and vendor `_meta` (`terminal_output_delta`, JetBrains `air`, `acpira/sidekick`) (`process.rs:441-472`). The code comments tie two of them to observed agent versions: `compaction` to `claude-agent-acp` 0.81.0 and `notices` to 0.93.0 (`process.rs:452-455`); the others carry no version note |
| Authentication | Typed `authenticate` request and `authMethods` types; browser/terminal login hand-off is left to the client | Parses `authMethods` including `type: "terminal"` with `args`/`env`, sorts API-key methods last, pre-checks Claude credentials, re-authenticates replacement processes; tightly bound to Acpira's `accounts` layer |
| Cancellation and ordering | `$/cancel_request` support with tests (`tests/jsonrpc_request_cancellation.rs`); actor-based dispatch | `$/cancel_request` both directions; drop-guard `request_cancellable`; `request_ordered` + `Handoff` guarantees a response is applied before the next notification (2 s wait) |
| Backpressure and limits | Unbounded internal channels (documented as intended contract); no per-line size limit found by search **(inferred)** | Unbounded writer queue with a `backlog()` counter; 256 MiB line cap |
| Process lifecycle | Optional `process` feature (`AcpAgent`) built on `async-process`/`async-io`, not Tokio. Unix: own process group, stdin EOF, then SIGTERM, then SIGKILL. **Windows: `CREATE_NO_WINDOW` and kill of the direct child only** (`acp_agent.rs:181`, `:311-315`), so `npx`/`.cmd` launcher descendants may survive **(inferred)**. Uses `std::process::Command::new(command)`, so bare `npx` (a `.cmd` shim) is unlikely to resolve **(inferred)** | 30 s initialize timeout; kills the child if initialize fails; 5 s kill grace; global registry to hard-kill on engine exit |
| Windows portability | CI runs on `ubuntu-latest` only (`.github/workflows/ci.yml`, `deny.yml`) | Job Object per agent with kill-on-close, started suspended so nothing escapes before assignment, nested parent job with below-normal priority and CPU cap; `PATHEXT` resolution and `cmd.exe` escaping for `.cmd`/`.bat` (`platform/command.rs`); `windows-latest` CI job (`.github/workflows/windows-compat.yml`) |
| Tests | 651 test functions in the core crate (src + tests + examples) | 3 in `rpc.rs`, 5 across `acp/transport/`, 6 in `platform/command.rs`, 1 in `windows_process.rs`, 8 in `tests/windows_*.rs` |
| Maintenance | Organization repo, 35 contributors, `cargo deny` in CI. Fast-moving API: four major versions in about five months on crates.io (1.0.0 2026-06-24, 2.0.0 2026-07-23, 3.0.0 2026-10-06, 5.0.0 2026-11-02; no 4.x), then 5.1-5.3 within two weeks | Single contributor; repository created 2026-09-05; releases 2.1.1-2.1.3 within three days. Crates are `publish = false`, so use means vendoring/forking |
| Footprint | Direct deps listed in sources.md. `Cargo.lock` closures, all upper bounds: 302 packages including the crate's dev-dependencies (overstated: `agent-client-protocol-test`, `tokio`, `clap` etc.), 140 with every optional feature but no dev-deps, **118 with no optional features** (the configuration AgentDock plans). The real tree is measured in S1 | `acpira-rpc` alone: 38-package upper bound, but the useful process/session code lives in `acpira-host` (116,611 Rust lines, 540-package upper bound incl. dev-deps) |
| License | Apache-2.0, no NOTICE file | MIT |

**Decision: depend on the official SDK for the protocol layer; keep process supervision and line framing under AgentDock's control (a published process-tree crate such as `process-wrap`, or a small own spawner, chosen in spike S2).**

Rationale:

- The SDK is the reference implementation maintained with the spec, already used by Octomind's agent side (`agent-client-protocol = "5.3.0"`), typed, heavily tested, and keeps v2 opt-in, which matches architecture.md ("ACP stable v1 first; negotiate features").
- Acpira's host is valuable but not separable: the ACP pieces import Acpira's registry, vendors, accounts, i18n and built-in agent, and it is not published. Copying it means owning ~33k lines of `src/acp/` or untangling them, with a single upstream maintainer.
- The SDK's real gaps are Windows process-tree handling and, in 5.3.0, connection loss on a non-UTF-8 line. Both are closed by the same design: AgentDock spawns the agent itself and feeds the SDK through the public `Lines::new(outgoing_sink, incoming_stream)` transport (present in 5.3.0, takes decoded `String`s), with AgentDock's own byte-level line framing in front of it.
- The SDK's API churn (four major versions in about five months) is contained by the `crates/acp` facade: domain code depends on AgentDock types, not SDK types.

**Framing decision for 5.3.0 (#504 not released):** pin `=5.3.0` and keep the known issue out of reach in the facade rather than wait or depend on the unreleased git tip. The facade reads agent stdout as bytes, splits on `\n`, enforces a per-line size cap, decodes with lossy UTF-8 (U+FFFD, the same behavior #504 adopts), counts and logs replaced bytes, and hands lines to `Lines`. Reasons: a git dependency on an unreleased commit would break the "published package" rule and complicate updates; a single bad byte from an agent must not kill every session; and the facade framing is needed anyway for the line-size cap and backpressure that the SDK does not provide. When a release containing #504 ships, upgrade to it but keep the facade framing for the cap.

What Acpira contributes instead: its capability list, timeouts, orphan handling, vendor quirks (Claude `sdk_message`, Grok `ask_question`/`exit_plan`, legacy `models` field) and Windows launch rules become **compatibility notes and test cases**, not code.

**M2 spike checklist (must pass before the decision is final):**

- S1. Build a v1 client with `agent-client-protocol = "=5.3.0"` and no `process` feature on Tokio, using `Lines` behind the facade framing; record `cargo tree -e normal` size and licenses (`cargo deny check licenses`).
- S2. Windows process supervision. On Windows 11, launch `claude-agent-acp` and `codex-acp` (via their `.cmd` shims) and run initialize, `session/new`, prompt, cancel, close. Compare three spawners on the same script: (a) the published `process-wrap` crate (Tokio frontend, `job-object` wrapper with resume-after-assignment), optionally with `win32job`; (b) a small AgentDock-written spawner; (c) the Acpira launcher as reference. Check each for:
  - start suspended, assign the Job Object, then resume (or `PROC_THREAD_ATTRIBUTE_JOB_LIST`), so no descendant escapes before assignment;
  - no descendant survives cancel, close, an agent crash, or **AgentDock itself being killed** (Task Manager / `taskkill /F` on the AgentDock process; kill-on-close must reap the tree);
  - orderly shutdown: close stdin, wait a grace period, then terminate the job;
  - stderr is drained continuously so a full pipe cannot stall the agent;
  - `.cmd` argument escaping with paths containing spaces and CJK characters (BatBadBut-class issues).
- S3. Mock agent that answers `initialize` with `protocolVersion: 2`, sends malformed JSON, **a line containing bytes that are not valid UTF-8**, a 64 MiB line, and an unknown notification; confirm the facade framing keeps the connection alive, record SDK behavior, and decide where AgentDock enforces limits. Also confirm SDK channels stay unbounded as documented and that backpressure is applied in AgentDock's event bus.
- S4. Auth hand-off: an agent advertising a terminal auth method; confirm AgentDock can surface it without logging tokens.
- S5. Vendor extensions and session continuity: confirm `_meta`, Claude `sdk_message` notifications and Grok extension methods reach AgentDock unchanged through the SDK (or through an untyped handler), and that `session/load` / resume works only when the agent advertises it.
- **Re-open conditions:** this decision is revisited if S2 shows that neither `process-wrap` nor a small own spawner reaps the process tree reliably (then open a migration PR for the Acpira Windows launcher, section 2), if S3 or S5 show the SDK drops or rewrites messages that AgentDock must see, or if the next SDK major forces facade changes larger than the facade itself.

## 2. Per-module decisions

| Module (path @ SHA in sources.md) | Decision | Rationale |
| --- | --- | --- |
| ACP SDK `agent-client-protocol` 5.3.0 | Dependency | See section 1 |
| ACP SDK `agent-client-protocol-test` | Reimplement (mock agent on SDK `Agent` role) | `publish = false`; a git dependency on an unpublished crate would pin us to an unreleased tip |
| acp-tck | External CI tool, optional | Validates **agents**, so it can check AgentDock's mock agent; experimental and not an official conformance statement |
| Acpira `acpira-rpc` | Not imported; scenarios only | Duplicates the SDK's JSON-RPC layer; its ordering/cancel guarantees become tests (scenario X-5) |
| Acpira `acpira-host` ACP transport and session | Reimplement | Coupled to registry, vendors, accounts, i18n, built-in agent; 116k-line crate; unpublished |
| Windows process supervision: `process-wrap` 10.0.1 (MIT OR Apache-2.0, watchexec) / `win32job` 2.1.0 (MIT OR Apache-2.0) | Dependency candidate, preferred if S2 passes | Published, maintained crates: `process-wrap` has a Tokio frontend, a Job Object wrapper that resumes threads after assignment, Unix process groups/sessions and kill-on-drop. Using them keeps security fixes upstream instead of in our tree. Not yet tested against ACP agents (S2) |
| Acpira Windows launcher (`platform/windows_process.rs`, `platform/command.rs`, `acp/agents/launch.rs` + `tests/windows_*.rs`) | Reuse candidate, deferred (fallback) | Small (468 lines) and almost standalone, and already proven on `windows-latest`. Used only if S2 shows that the published crates and a small own spawner are insufficient. Coupling to remove: the `acpira_shared::settings` CPU-cap constant, `crate::net_proxy::apply` (`launch.rs:71`) and `super::login_path` (`launch.rs:17`, `:68`). Keep the MIT header; re-run its tests; security-review `.cmd` argument escaping |
| Acpira `acpira-agent` | Excluded from MVP | Native agent is out of MVP scope (ADR-0001). If needed later, run it as an external ACP agent (protocol adapter) |
| Acpira `acpira-shared` | Reimplement | Different domain model (Task ≠ Session); mirrors Acpira's TypeScript contracts |
| Acpira `acpira-gateway` | Research only (post-V1) | QUIC/iroh pairing and push are outside the planned SSH remote worker |
| Acpira `packages/ui` | Reimplement | 51k lines tightly bound to `@acpira/shared` (377 imports); visual identity must be original; `effects/` and `styles/beam.css` carry extra third-party notices |
| Acpira `apps/desktop` | Reimplement (reference) | On Windows it links all of `acpira-host`; `"csp": null` is not acceptable for AgentDock; start from the official Tauri 2 template with a strict CSP and minimal capabilities |
| Fork PRs #2, #4, #5, #6 | Requirements and tests only | Unmerged plugins written against Acpira's plugin API. End-to-end status differs per PR (see the note at the start of section 4); none has an end-to-end run against a real agent |
| claude-agent-acp, codex-acp | Protocol adapter | Vendor-owned runtimes and auth; AgentDock launches the user's installed copy and does not redistribute them |
| Octomind `src/acp/` | Protocol adapter (integration-test target) | Already an ACP agent on the same SDK |
| Octomind `src/supervisor/`, `src/session/` | Research only | Large (5 MB of source) and owned by Octomind's runtime |
| Goose `goose-context-management`, `goose-providers` | Research only | Only relevant to a future native agent; pulls Goose's provider types and `rmcp` |
| Octos `octos-workflows`, `octos-store` | Research only | `octos-workflows` depends on `octos-agent`; store uses `redb` while AgentDock chose SQLite |
| Aether `aether-core` | Research only | Embeds Aether's LLM/auth/MCP crates; native agent is out of scope |
| Forge `forge-core`, `forge-provider` | Excluded | AGPL-3.0-only (section 5) |

No row is a **fork**: no candidate justifies maintaining a modified copy of a whole package.

## 3. Upstream tracking, tests and patch strategy

- **ACP SDK:** pin `=5.3.0` in `Cargo.toml` and commit `Cargo.lock`; the known non-UTF-8 disconnect in 5.3.0 is contained by the facade framing (section 1). Move to the first release that contains #504 (`6a4a95ca`) once it is published, keeping the facade framing. Upgrades are explicit PRs (Dependabot/Renovate may open them) that must pass the mock-agent integration suite and the Windows smoke test. Do not enable `unstable_*` features without an ADR. Watch the SDK releases and the ACP v2 draft; v2 work starts behind a feature flag.
- **Supply chain from M1:** `cargo deny check` (licenses, advisories, bans, sources), `cargo audit`, and `pnpm audit` in CI; an aggregated third-party notice file is generated for every release artifact.
- **Tauri:** require `tauri >= 2.11.1` (GHSA-7gmj-67g7-phm9) and keep CSP and capabilities under test.
- **If the Acpira Windows launcher is copied:** record source path + full SHA in a `THIRD_PARTY_NOTICES.md` row; owner is the repository owner; check upstream changes to those three files with `gh api repos/hotic/acpira/compare/<pinned>...main` before each AgentDock release and port security fixes by hand.
- **If `process-wrap` / `win32job` are adopted:** pin exact versions, cover them with the S2 Windows tests in CI, and treat them like the SDK for upgrades.
- **External runtimes:** keep a compatibility matrix (agent name, version, protocol version, capabilities seen, Windows result) updated by the opt-in real-agent E2E job; do not auto-install or bundle them.

## 4. Requirements and acceptance scenarios carried over from the Acpira fork PRs

Source: PR descriptions and their recorded review rounds in `ChiJiun/acpira` (none of the PRs has GitHub review comments; review findings are recorded inside the descriptions as "第二輪 / 第三輪 ..." sections). These are **requirements to re-test in AgentDock**, not proven behavior.

End-to-end status as each PR description reports it (all four PRs are OPEN and unmerged):

| PR | Unit / module tests reported | End-to-end status reported |
| --- | --- | --- |
| #2 `turn-report` (`c4274b85`) | 16 passed, 1 skipped; a process-level test drives the bundled `main.ts` over JSON-RPC | **Not passed.** The sidecar E2E test is skipped by default (`ACPIRA_TURN_REPORT_E2E=1`); when a reviewer re-ran it, the sidecar crashed with stack overflow `0xC00000FD` after the first prompt, with any runtime plugin enabled. Engine-to-plugin event delivery and `send` were not exercised |
| #4 `pr-loop` (`a92cf8af`) | 132 passed, 1 skipped; table tests for `mustStop`; mutation testing | **Passed once (1 test, 158 s)** at head `a92cf8af`, using a debug sidecar built from Acpira PR #9 head `d189b930`, a fake agent and a `gh` stub (no GitHub writes). Only the "one passing round, confirm, merge" path; fix rounds, CI failure, stop conditions, force push, restart and multi-engine paths are unit-tested only |
| #5 `worktree-sessions` (`5d5080fb`) | 13 passed, 1 skipped against real temporary Git repositories | **Never passed.** Node start-up of 12-20 s on the author's machine exceeded the engine's 10 s plugin `initialize` limit, so the plugin could not be enabled; E2E is opt-in (`ACPIRA_WORKTREE_E2E=1`) |
| #6 `approval-rules` (`39514c18`) | 321 passed, 1 skipped | **Passed only in the round-1 reviewer's environment** (sidecar with a 64 MB stack), before the round-2 fixes; not re-run after them. On the author's machine the Windows debug sidecar (1 MB main-thread stack) crashed with `0xC00000FD` on the first prompt |

### Approval policy (from PR #6 `approval-rules`, head `39514c18`)

- APR-1. Policy runs in the Rust backend before any auto-approve or "full access" path. An extension may tighten (ask/deny) but never approve.
- APR-2. **Fail closed.** Evaluator timeout, exception, or input above a size cap (Acpira: 16 KiB) results in "ask", never "allow". (Acpira treated a hook timeout as "no opinion", which made a slow rule an approval.)
- APR-3. Bounded evaluation time on hostile input: e.g. `'echo ' + 'git '.repeat(30000) + '; gh pr merge 6 --squash --auto'` and glob `*a*a*a*a*a*a*a*a*a*ab` against 40 `a` characters must finish within a fixed budget; no backtracking regex in the policy path.
- APR-4. Relative targets resolve against the session cwd plus `cd`/`pushd`/`Set-Location` within the same command line; an unknown directory (`cd $DIR`, `cd -`) on a write/delete gives "ask".
- APR-5. Windows path normalization before matching: `\` vs `/`, `//`, `x/..`, trailing dots and spaces, `::$DATA`; 8.3 short names (`GITHUB~1`) give "ask". Symlinks and junctions are still open and must be handled by AgentDock's workspace path checks.
- APR-6. Command unwrapping: `&&`, `;`, `|`, subshells, `$(...)`, backticks, `bash -c`, `cmd /c`, `powershell -Command`/`-EncodedCommand`, `sudo`/`env`/`xargs`/`find -exec`, `uv run`, heredoc bodies not misread as commands, PowerShell `{ }` blocks.
- APR-7. An execute request whose command cannot be recovered gives "ask".
- APR-8. GitHub writes outside `gh`: `curl`/`wget`/`Invoke-RestMethod` non-GET to `api.github.com`; read-only `gh api graphql` queries pass; repo allow-lists keep the host (GitHub Enterprise is a different repo).
- APR-9. Project-level config (editable by the agent) can only add rules; user-level config is the only place to relax; policy files themselves are protected.
- APR-10. Default "ask" set: delete files, discard changes, push, force push, branch/tag delete, config files, `gh pr merge` (auto, squash, rebase), repo delete, foreign repo.
- APR-11. **Honest scope.** Agent-native bypass modes (Claude Code `bypassPermissions`, Codex full access) never send permission requests; the UI must say AgentDock does not enforce policy in those modes (PRD: no misleading capability claims). Command parsing is defense in depth; the hard guarantee applies only to operations AgentDock itself performs.

### Worktree per task (from PR #5 `worktree-sessions`, head `5d5080fb`)

- WT-1. One task = one branch = one worktree; default location outside the repository (`<repo>.worktrees/<branch-slug>`).
- WT-2. Atomic create: create the branch first (`git branch --no-track`), then `git worktree add`. On failure undo only what this attempt created: remove a worktree only if registered at that path for that branch; delete the branch only if no worktree uses it, via `git update-ref -d refs/heads/<b> <expected-sha>`; never delete directories directly.
- WT-3. Concurrency: three concurrent creations of the same branch; `x/y` and `x-y` competing for the same slug directory.
- WT-4. Paths with spaces and CJK characters; start point from a tag.
- WT-5. Remove refuses when there are uncommitted or untracked changes, or a detached HEAD has commits unreachable from any ref; the confirmation lists ignored files (`.env`, `build/`) that will be deleted; never `--force`; never delete the branch implicitly.
- WT-6. Windows: refuse removal while a live session uses the worktree; if `git worktree remove` fails, re-read state and report it truthfully (registered or not, leftover entries). Observed on Windows: `Permission denied`, unregistered, 0 entries left.
- WT-7. Status shows uncommitted, ignored and unpushed counts, with "no upstream" and "no remote" as distinct states.
- WT-8. Git is called without a shell; branch and start point may not begin with `-`; branch names checked with `git check-ref-format --branch`; minimum Git version declared (Acpira: 2.31).
- WT-9. Windows path comparison is case-insensitive.
- WT-10. If the worktree is created but the agent session fails (error, auth required), keep the worktree and report the failure; do not report success.
- WT-11. Windows and WSL path isolation: a worktree created from Windows must be usable, and its scope enforced, when the agent runs under WSL (`\\wsl$\...` / `/mnt/c/...` forms), and vice versa; a session must not be able to reach a sibling worktree through path translation. (Carried over from the earlier migration matrix; PR #5 did not test it.)
- Not verified upstream, so AgentDock must test: submodules, separate git dir, bare repositories, SSH remotes, macOS/Linux case sensitivity.

### Review/PR/CI loop (from PR #4 `pr-loop`, head `a92cf8af`; four review rounds, five commits)

- PRL-1. Merge only when the latest review round is "mergeable" **and** the reviewed SHA equals the PR head **and** the reviewed base equals the current base; merge with `gh pr merge --merge --match-head-commit <sha>` and then confirm the PR state is `MERGED`. Human approval stays mandatory in AgentDock (PRD: no auto-merge).
- PRL-2. Every round uses a fresh reviewer session (not a fork) whose brief holds only PR URL/branch/head, the original requirement and the reviewer focus notes; the verdict block is nonce-delimited and exactly one block is accepted.
- PRL-3. Mandatory stop conditions come from one pure function over raw facts: max rounds, same issue category in two consecutive rounds, same CI check failing twice, reviewer conflict, history rewrite (compare not `ahead`/`identical`, or compare failure). All true conditions are shown together; consent tokens are narrow (per round, per head, per SHA range); resuming requires explicit confirmation.
- PRL-4. Policy is snapshotted when a loop starts; relaxing settings needs confirmation, tightening applies immediately.
- PRL-5. Durable state with compare-and-swap; a restart never launches a duplicate reviewer or a duplicate merge; a loop in `merging` cannot be cancelled; the merge report is delivered even if the state write fails.
- PRL-6. CI status comes only from `gh pr checks --json` `bucket`; unknown buckets count as pending; "no checks" requires empty stdout, non-zero exit and the specific `no checks reported` message, plus a grace period and an explicit confirmation.
- PRL-7. A reviewer turn that did not end with `end_turn`, or reported an error, does not produce a verdict; "mergeable" with failing tests not explained as a conflict is unparseable.
- PRL-8. Untrusted text (reviewer output, PR title, check names, `gh` errors) is rendered quoted and single-line so it cannot spoof approval cards.
- PRL-9. No-progress timeouts (Acpira defaults: reviewer 60 min, fix 4 h, CI 2 h) stop the loop instead of waiting forever.
- PRL-10. `gh` arguments go through a positive allow-list of shapes; repository allow-list includes the host.
- PRL-11. Known gaps to design for: base branch changing between the last read and `gh pr merge`; merge queues; fork PRs that need workflow approval; code-freeze windows.
- Test practice worth keeping: table tests for the stop function and mutation testing to prove each safety check is covered.

### End-of-turn evidence (from PR #2 `turn-report`, head `c4274b85`)

- TR-1. Build the end-of-turn summary from structured events (files changed, commands run, checks, unverified items), not from regex over the agent's final message.
- TR-2. A turn "needs a report" only if it had a successful edit/delete/move or a non-read-only execute; automatic compaction and goal-continuation turns are not new requests, and evaluation is repeated after compaction.
- TR-3. Read-only classification is heuristic: quote-aware splitting; redirects, `$(...)`, `sed -i`, `find -delete`/`-exec`, `git branch -D`, `git tag <name>`, `git remote add` count as writes.
- TR-4. Follow-ups are bounded (one per request by default, hard cap 3), every engine call has a timeout, and nothing is sent if a new turn has started.
- TR-5. User-supplied patterns are length-limited and scanned text is bounded (Acpira: head and tail 10,000 characters; 50 KB under 2 s).
- TR-6. Any optional model-based check is off by default, can only relax a decision, and discloses that reply text leaves the machine.

### Cross-cutting lessons from those PRs

- X-1. Extension/agent start-up budgets must be measured on slow Windows machines: Node start-up of 12-20 s exceeded Acpira's 10 s plugin `initialize` timeout, so PR #5's end-to-end test never ran (PR #2 records the same risk).
- X-2. Windows debug builds have a 1 MB main-thread stack; Acpira's sidecar crashed with `0xC00000FD` on the first prompt. AgentDock CI must run a Windows debug and release smoke test.
- X-3. A timeout or crash in a safety component must fail closed (see APR-2).
- X-4. Opt-in end-to-end tests made "skipped" look like "green": in PRs #2 and #5 they never passed, and in #6 the last passing run predates the final fixes. AgentDock release gates must list skipped E2E tests and the commit of their last passing run explicitly.
- X-5. ACP transport tests to port: a response is applied before the next notification; dropping a pending request sends `$/cancel_request`; non-JSON stdout lines do not kill the session; initialize failure kills the child; agent exit fails every pending request with a "connection closed" error.

## 5. Licensing

Obligations for MIT and Apache-2.0 material, binary notice bundles and the vulnerability snapshot are listed in [sources.md](../sources.md#license-and-notice-obligations). Decisions here:

- **Forge (AGPL-3.0-only) is excluded.** AGPL code cannot be included in an MIT, Apache-2.0 or proprietary AgentDock; doing so would make the distributed work AGPL, and §13 would require offering source to remote users of a modified version (relevant to the planned remote worker). Clean-room rule: Forge may be read only for high-level ideas recorded in prose (for example "provider fallback with a queue"); whoever implements AgentDock's routing must work from that prose and public documentation, not from Forge source. Prose notes record their author and date. Because implementation is often done by AI agents, the context of an implementation session (prompt, attached files, fetched pages, tool output) must not contain Forge source code, and a session that read Forge source must not write AgentDock code in the same area. Any wish to reuse Forge code requires a licensing ADR and legal review first.
- **Apache-2.0 dependencies** (ACP SDK, schema) are compatible with every AgentDock license option below.
- **MIT material from Acpira** may be copied under any option below, keeping its copyright line and permission notice.
- **External runtimes are not redistributed**, so their licenses do not flow into AgentDock packages.

### AgentDock license: options for the owner (not decided)

| Option | Effect | Fit |
| --- | --- | --- |
| A. Apache-2.0 | Explicit patent grant and termination; same license as the ACP SDK, Goose, Octomind, Octos. MIT files can be included with their notices | Good default for a public developer tool |
| B. MIT OR Apache-2.0 (dual) | Rust ecosystem convention, maximal reuse by others. Files copied from Apache-only sources must stay Apache-2.0 only, so per-file SPDX headers are required | Good if crate publication is planned |
| C. MIT | Simplest; no patent grant from AgentDock contributors. Apache files inside keep Apache terms and notices | Acceptable |
| D. Proprietary / all rights reserved (current private state) | Allowed with MIT/Apache inputs if notices ship; outside contributions need an agreement | Fine while private; revisit before publishing |
| E. AGPL-3.0 | Only option that would admit Forge code; imposes copyleft and network-source obligations on every user and on the remote worker | Not recommended |

Recommendation for the owner's consideration: A or B, chosen **before the first migration PR or any public release**, whichever comes first. This is not legal advice; AGPL-related questions need a lawyer.

## Acceptance rules for future copy PRs

A PR that copies, forks or adds a direct dependency on a module listed in sources.md must:

1. Fill every field of the migration PR template in sources.md (original path, full SHA, author/copyright, license/NOTICE, modifications, verified tests, upstream tracking owner).
2. Explain why the decision in section 2 no longer holds, or reference the spike result that triggers it (for example S2 for the Windows launcher).
3. Add or update the `THIRD_PARTY_NOTICES.md` entry and keep upstream headers in each copied file, with a change notice on modified files.
4. Pass `cargo deny check licenses` once that check exists in CI.

## Alternatives considered

1. **Vendor `acpira-rpc` + parts of `acpira-host`.** Proven against real agents and Windows-hardened, but unpublished, single-maintainer, and coupled to Acpira's registry/accounts/vendors; we would own the protocol layer ourselves.
2. **SDK including its `process` feature.** Least code, but Windows process-tree cleanup is weaker than required and it adds the `async-process`/`async-io` runtime next to Tokio. Kept as a fallback for the mock-agent tests.
3. **Published process-tree crates (`process-wrap`, `win32job`) vs own spawner vs Acpira launcher.** Not mutually exclusive with the SDK decision; evaluated together in S2. Published crates are preferred for upstream security fixes, an own spawner for minimal dependencies, the Acpira launcher only as a proven fallback.
4. **Write our own JSON-RPC/ACP layer.** Full control, but duplicates the spec maintainers' work and drifts from v2.
5. **Fork Acpira wholesale.** Rejected in ADR-0001.

## Consequences

- AgentDock owns process supervision, policy and persistence; the SDK owns wire-level ACP.
- SDK upgrades are frequent and may be breaking; the `crates/acp` facade and the mock-agent suite absorb that cost.
- Valuable Acpira knowledge survives as tests (sections 1 and 4) rather than as code, which keeps provenance simple.
- The license choice blocks the first migration PR and any public release until the owner decides.

## Not verified in this audit

- No candidate was built, run or tested; all runtime behavior statements are from source reading and are marked **(inferred)** where they matter.
- Exact normal-dependency trees (`cargo tree`), `cargo deny`, `cargo audit`, `npm audit` were not run.
- Whether the SDK v1 client rejects a mismatched `protocolVersion`, and whether it bounds line length, were not confirmed (spike S3).
- Windows behavior of the SDK `process` feature with `.cmd` shims and descendant processes was not tested (spike S2).
- `process-wrap` and `win32job` were checked only for license, version and features (Job Object with resume-after-assignment); they were not run (spike S2).
- The non-UTF-8 disconnect in 5.3.0 is taken from the #504 commit message and the 5.3.0 source (`BufReader::lines()`); it was not reproduced (spike S3).
- Pinned SHAs for claude-agent-acp, codex-acp and acp-tck were recorded but their code was not reviewed.
