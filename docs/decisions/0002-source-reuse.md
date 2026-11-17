# ADR-0002: Source reuse, ACP SDK choice and licensing guardrails

Date: 2026-11-17
Status: Proposed. Module decisions are ready for owner acceptance in the PR that adds this file. **AgentDock's own license is explicitly left to the owner** (section 5).
Related: [Issue #1](https://github.com/ChiJiun/agentdock/issues/1), [ADR-0001](0001-independent-workbench.md), provenance manifest in [sources.md](../sources.md)

## Context

ADR-0001 chose an independent Rust + Tauri 2 + React workbench that talks to external agents over ACP and only imports upstream code after provenance, dependency, license and test review. Issue #1 asks for that review at module level before any migration starts: exact SHAs, import trees, licenses, a comparison of the official ACP Rust SDK with Acpira's ACP host, and requirements/test cases from the unmerged Acpira fork PRs.

All SHAs, paths and measurements below come from the snapshot in [sources.md](../sources.md). Statements marked **(inferred)** come from reading code, not from running it.

## Decision summary

1. **ACP client: depend on the official `agent-client-protocol` crate** (Apache-2.0, 5.3.0, stable protocol v1), wrapped by AgentDock's own `crates/acp` facade. Do not import Acpira's `acpira-rpc` or `acpira-host` ACP code.
2. **Agent process supervision stays AgentDock code.** Spawn agents with Tokio, own the Windows process tree (Job Object), and hand the child's stdio to the SDK as a byte-stream transport. Acpira's Windows launcher is the only **reuse candidate**, deferred until the M2 spike proves it is needed.
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
| Error handling | Typed `Error`/`ErrorCode` matching the schema codes; parse errors reported per line. The tip commit `6a4a95ca` "keeps the connection open when an incoming line is not valid" and is **not yet in a release** | `RpcError` with -32601, -32603, -32800 (cancelled), -32099 (connection closed); non-JSON stdout lines are logged and skipped; 256 MiB per-line cap; spawn failures classified as `ENOENT`/`EACCES`/unopenable folder |
| Capability negotiation | Typed `InitializeRequest`/`Response`; client capabilities built by the caller | Advertises `fs`/`terminal` false, `elicitation.form`, `session.configOptions.boolean`, `session.compaction`, `session.notices`, optional `subagents`, `auth.terminal`, and vendor `_meta` (`terminal_output_delta`, JetBrains `air`, `acpira/sidekick`) (`process.rs:441-472`). Each entry is tied to an observed behavior of `claude-agent-acp` 0.81/0.93 |
| Authentication | Typed `authenticate` request and `authMethods` types; browser/terminal login hand-off is left to the client | Parses `authMethods` including `type: "terminal"` with `args`/`env`, sorts API-key methods last, pre-checks Claude credentials, re-authenticates replacement processes; tightly bound to Acpira's `accounts` layer |
| Cancellation and ordering | `$/cancel_request` support with tests (`tests/jsonrpc_request_cancellation.rs`); actor-based dispatch | `$/cancel_request` both directions; drop-guard `request_cancellable`; `request_ordered` + `Handoff` guarantees a response is applied before the next notification (2 s wait) |
| Backpressure and limits | Unbounded internal channels (documented as intended contract); no per-line size limit found by search **(inferred)** | Unbounded writer queue with a `backlog()` counter; 256 MiB line cap |
| Process lifecycle | Optional `process` feature (`AcpAgent`) built on `async-process`/`async-io`, not Tokio. Unix: own process group, stdin EOF, then SIGTERM, then SIGKILL. **Windows: `CREATE_NO_WINDOW` and kill of the direct child only** (`acp_agent.rs:181`, `:311-315`), so `npx`/`.cmd` launcher descendants may survive **(inferred)**. Uses `std::process::Command::new(command)`, so bare `npx` (a `.cmd` shim) is unlikely to resolve **(inferred)** | 30 s initialize timeout; kills the child if initialize fails; 5 s kill grace; global registry to hard-kill on engine exit |
| Windows portability | CI runs on `ubuntu-latest` only (`.github/workflows/ci.yml`, `deny.yml`) | Job Object per agent with kill-on-close, started suspended so nothing escapes before assignment, nested parent job with below-normal priority and CPU cap; `PATHEXT` resolution and `cmd.exe` escaping for `.cmd`/`.bat` (`platform/command.rs`); `windows-latest` CI job (`.github/workflows/windows-compat.yml`) |
| Tests | 651 test functions in the core crate (src + tests + examples) | 3 in `rpc.rs`, 5 across `acp/transport/`, 6 in `platform/command.rs`, 1 in `windows_process.rs`, 8 in `tests/windows_*.rs` |
| Maintenance | Organization repo, 35 contributors, `cargo deny` in CI. Fast-moving API: majors 3.0.0 (2026-10-06) and 5.0.0 (2026-11-02), then 5.1-5.3 within two weeks | Single contributor; repository created 2026-09-05; releases 2.1.1-2.1.3 within three days. Crates are `publish = false`, so use means vendoring/forking |
| Footprint | Direct deps listed in sources.md; `Cargo.lock` closure upper bound 302 packages (includes dev-deps; real normal-dep tree to be measured in S1) | `acpira-rpc` alone: 38-package upper bound, but the useful process/session code lives in `acpira-host` (116,611 lines, 540-package upper bound) |
| License | Apache-2.0, no NOTICE file | MIT |

**Decision: depend on the official SDK for the protocol layer; write AgentDock's own process supervisor.**

Rationale:

- The SDK is the reference implementation maintained with the spec, already used by Octomind's agent side (`agent-client-protocol = "5.3.0"`), typed, heavily tested, and keeps v2 opt-in, which matches architecture.md ("ACP stable v1 first; negotiate features").
- Acpira's host is valuable but not separable: the ACP pieces import Acpira's registry, vendors, accounts, i18n and built-in agent, and it is not published. Copying it means owning ~33k lines of `src/acp/` or untangling them, with a single upstream maintainer.
- The SDK's real gap is Windows process-tree handling. It accepts any byte stream (`ByteStreams::new(outgoing, incoming)` with `tokio_util::compat`), so AgentDock can spawn the agent itself and keep the protocol layer official.
- The SDK's API churn (two major versions in six weeks) is contained by the `crates/acp` facade: domain code depends on AgentDock types, not SDK types.

What Acpira contributes instead: its capability list, timeouts, orphan handling, vendor quirks (Claude `sdk_message`, Grok `ask_question`/`exit_plan`, legacy `models` field) and Windows launch rules become **compatibility notes and test cases**, not code.

**M2 spike checklist (must pass before the decision is final):**

- S1. Build a v1 client with `agent-client-protocol = "=5.3.0"` and no `process` feature on Tokio; record `cargo tree -e normal` size and licenses (`cargo deny check licenses`).
- S2. On Windows 11, launch `claude-agent-acp` and `codex-acp` (via their `.cmd` shims) through an AgentDock Job-Object spawner and `ByteStreams`; run initialize, `session/new`, prompt, cancel, close. Verify no descendant process survives cancel/close/crash.
- S3. Mock agent that answers `initialize` with `protocolVersion: 2`, malformed JSON, a 64 MiB line, and an unknown notification; record SDK behavior and decide where AgentDock enforces limits.
- S4. Auth hand-off: an agent advertising a terminal auth method; confirm AgentDock can surface it without logging tokens.
- If S2 fails because of launcher or process-tree issues, open a migration PR for the Acpira Windows launcher (section 2, row "Acpira Windows launcher").

## 2. Per-module decisions

| Module (path @ SHA in sources.md) | Decision | Rationale |
| --- | --- | --- |
| ACP SDK `agent-client-protocol` 5.3.0 | Dependency | See section 1 |
| ACP SDK `agent-client-protocol-test` | Reimplement (mock agent on SDK `Agent` role) | `publish = false`; a git dependency on an unpublished crate would pin us to an unreleased tip |
| acp-tck | External CI tool, optional | Validates **agents**, so it can check AgentDock's mock agent; experimental and not an official conformance statement |
| Acpira `acpira-rpc` | Not imported; scenarios only | Duplicates the SDK's JSON-RPC layer; its ordering/cancel guarantees become tests (scenario X-5) |
| Acpira `acpira-host` ACP transport and session | Reimplement | Coupled to registry, vendors, accounts, i18n, built-in agent; 116k-line crate; unpublished |
| Acpira Windows launcher (`platform/windows_process.rs`, `platform/command.rs`, `acp/agents/launch.rs` + `tests/windows_*.rs`) | Reuse candidate, deferred | Only Acpira code that is small (468 lines), almost standalone and solves a gap the SDK has. Copy only after spike S2 shows need; remove the `acpira_shared` CPU-cap and `net_proxy` coupling; keep the MIT header; re-run its tests on `windows-latest`; security-review `.cmd` argument escaping |
| Acpira `acpira-agent` | Excluded from MVP | Native agent is out of MVP scope (ADR-0001). If needed later, run it as an external ACP agent (protocol adapter) |
| Acpira `acpira-shared` | Reimplement | Different domain model (Task ≠ Session); mirrors Acpira's TypeScript contracts |
| Acpira `acpira-gateway` | Research only (post-V1) | QUIC/iroh pairing and push are outside the planned SSH remote worker |
| Acpira `packages/ui` | Reimplement | 51k lines tightly bound to `@acpira/shared` (377 imports); visual identity must be original; `effects/` carries extra third-party notices |
| Acpira `apps/desktop` | Reimplement (reference) | On Windows it links all of `acpira-host`; `"csp": null` is not acceptable for AgentDock; start from the official Tauri 2 template with a strict CSP and minimal capabilities |
| Fork PRs #2, #4, #5, #6 | Requirements and tests only | Unmerged plugins written against Acpira's plugin API; end-to-end paths never verified on the author's machine |
| claude-agent-acp, codex-acp | Protocol adapter | Vendor-owned runtimes and auth; AgentDock launches the user's installed copy and does not redistribute them |
| Octomind `src/acp/` | Protocol adapter (integration-test target) | Already an ACP agent on the same SDK |
| Octomind `src/supervisor/`, `src/session/` | Research only | Large (5 MB of source) and owned by Octomind's runtime |
| Goose `goose-context-management`, `goose-providers` | Research only | Only relevant to a future native agent; pulls Goose's provider types and `rmcp` |
| Octos `octos-workflows`, `octos-store` | Research only | `octos-workflows` depends on `octos-agent`; store uses `redb` while AgentDock chose SQLite |
| Aether `aether-core` | Research only | Embeds Aether's LLM/auth/MCP crates; native agent is out of scope |
| Forge `forge-core`, `forge-provider` | Excluded | AGPL-3.0-only (section 5) |

No row is a **fork**: no candidate justifies maintaining a modified copy of a whole package.

## 3. Upstream tracking, tests and patch strategy

- **ACP SDK:** pin `=5.3.0` in `Cargo.toml` and commit `Cargo.lock`. Upgrades are explicit PRs (Dependabot/Renovate may open them) that must pass the mock-agent integration suite and the Windows smoke test. Do not enable `unstable_*` features without an ADR. Watch the SDK releases and the ACP v2 draft; v2 work starts behind a feature flag.
- **Supply chain from M1:** `cargo deny check` (licenses, advisories, bans, sources), `cargo audit`, and `pnpm audit` in CI; an aggregated third-party notice file is generated for every release artifact.
- **Tauri:** require `tauri >= 2.11.1` (GHSA-7gmj-67g7-phm9) and keep CSP and capabilities under test.
- **If the Acpira Windows launcher is copied:** record source path + full SHA in a `THIRD_PARTY_NOTICES.md` row; owner is the repository owner; check upstream changes to those three files with `gh api repos/hotic/acpira/compare/<pinned>...main` before each AgentDock release and port security fixes by hand.
- **External runtimes:** keep a compatibility matrix (agent name, version, protocol version, capabilities seen, Windows result) updated by the opt-in real-agent E2E job; do not auto-install or bundle them.

## 4. Requirements and acceptance scenarios carried over from the Acpira fork PRs

Source: PR descriptions and their recorded review rounds in `ChiJiun/acpira` (none of the PRs has GitHub review comments; review findings are recorded inside the descriptions as "第二輪 / 第三輪 ..." sections). These are **requirements to re-test in AgentDock**, not proven behavior.

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
- Not verified upstream, so AgentDock must test: submodules, separate git dir, bare repositories, SSH remotes, macOS/Linux case sensitivity.

### Review/PR/CI loop (from PR #4 `pr-loop`, head `a92cf8af`, five review rounds)

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

- X-1. Extension/agent start-up budgets must be measured on slow Windows machines: Node start-up of 12-20 s exceeded Acpira's 10 s plugin `initialize` timeout, so end-to-end tests never ran.
- X-2. Windows debug builds have a 1 MB main-thread stack; Acpira's sidecar crashed with `0xC00000FD` on the first prompt. AgentDock CI must run a Windows debug and release smoke test.
- X-3. A timeout or crash in a safety component must fail closed (see APR-2).
- X-4. Opt-in end-to-end tests hid the fact that they never passed. AgentDock release gates must list skipped E2E tests explicitly.
- X-5. ACP transport tests to port: a response is applied before the next notification; dropping a pending request sends `$/cancel_request`; non-JSON stdout lines do not kill the session; initialize failure kills the child; agent exit fails every pending request with a "connection closed" error.

## 5. Licensing

Obligations for MIT and Apache-2.0 material, binary notice bundles and the vulnerability snapshot are listed in [sources.md](../sources.md#license-and-notice-obligations). Decisions here:

- **Forge (AGPL-3.0-only) is excluded.** AGPL code cannot be included in an MIT, Apache-2.0 or proprietary AgentDock; doing so would make the distributed work AGPL, and §13 would require offering source to remote users of a modified version (relevant to the planned remote worker). Clean-room rule: Forge may be read only for high-level ideas recorded in prose (for example "provider fallback with a queue"); whoever implements AgentDock's routing must work from that prose and public documentation, not from Forge source. Any wish to reuse Forge code requires a licensing ADR and legal review first.
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
3. **Write our own JSON-RPC/ACP layer.** Full control, but duplicates the spec maintainers' work and drifts from v2.
4. **Fork Acpira wholesale.** Rejected in ADR-0001.

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
- Pinned SHAs for claude-agent-acp, codex-acp and acp-tck were recorded but their code was not reviewed.
