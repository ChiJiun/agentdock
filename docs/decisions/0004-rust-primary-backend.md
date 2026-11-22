# ADR-0004: Rust is the primary backend language; Node/TS PRs are behaviour references only

Date: 2026-11-22
Status: Proposed (becomes Accepted when the owner approves the PR that adds it)
Related: [ADR-0001](0001-independent-workbench.md), [ADR-0002](0002-source-reuse.md), [ADR-0003](0003-task-session-event-contracts.md); issues #4, #6, #7, #8, #9, #10, #15, #51; PRs #25, #27, #28, #29, #33

> **繁中摘要**：後端（Tauri host 與 `crates/*`）全部用 Rust，React/TS 只做前端。Node PR #25、#27、#28、#29、#33 保留為 draft 參考、不合併，任務包以「PR 編號＋分支＋檔案路徑＋SHA」引用其行為與測試情境，用 Rust 重新實作。實作通常在擁有者的 Linux VM 上進行；只能在 Windows 驗證的項目交給 GitHub Actions `windows-latest` 或擁有者的 Windows 本機。需要其他語言的地方列入待擁有者討論。

## Context

ADR-0001 and `docs/architecture.md` already chose Rust + Tauri 2 for the backend. From 2026-11-17 a stack of PRs built an interim Node.js development runtime (`apps/runtime/*.mjs`, loopback HTTP, `node:sqlite`, `@agentclientprotocol/sdk@2.7.0`) to validate real ACP behaviour first:

| PR | Branch | Head at inventory | Content |
| --- | --- | --- | --- |
| #25 | `feat/acp-live-runtime` | `7d41c9f1b34be8d979c89945ed61c6208a15a76d` | ACP v1 child process, SQLite sessions/events, approvals, process-tree shutdown |
| #27 | `feat/live-session-sentinel` | `6dd3ac82f0c006c99643f6d5fa582d53b2350a7d` | event-driven Session Sentinel (attention classes, viewed cursor) |
| #28 | `feat/isolated-git-worktrees` | `489ba3dfe1a189c892cf224018ef41d02bf5b577` | worktree per task, durable creation intent, restart reconciliation |
| #33 | `feat/github-readonly-evidence` | `8703a60ca750304fc34a51bc64c82138c4dc5e67` | read-only Issues/PR/Checks evidence via `gh api` |
| #29 | `feat/durable-task-workflow` | `c57b824ddcdc2355fbc10bded265db4b99cf9e80` | 16-state task workflow, evidence-chain gates |

Each PR calls itself interim/development-only and says the product uses Rust/Tauri (for example `docs/implementation/live-acp-runtime.md` lines 7, 104, 144 on the PR #25 branch).

The owner's decision on 2026-11-22 (verbatim):

> 我希望有良好的記憶體管理，應以Rust作為主要開發，若有你覺得需要用其他語言的可以提出討論。若是因為參考來源程式碼使用其它語言那可以改以Rust重構

Follow-up decisions relayed the same day: implementation is usually done by a model working on the owner's Linux VM; the Node PRs stay as draft references; task packets live in `docs/tasks/` with an English body and a Traditional Chinese summary.

## Decision

1. **All backend code that ships with AgentDock is Rust** (Tauri 2 host and `crates/*`): ACP host, process supervision, storage, policy, worktrees, controlled check runner, Git/GitHub, Session Sentinel classification, durable workflow.
2. **React/TypeScript is the frontend only** (the existing Vite project at the repo root). The frontend does not spawn processes or touch the user's repositories; it calls typed Tauri commands (`docs/architecture.md` line 28).
3. **Node/TS PRs #25, #27, #28, #29, #33 are not merged; they stay open as draft references.** Their `docs/implementation/*.md`, test names and scenarios are behaviour and test specifications. Task packets cite them as "PR number + branch + file path + SHA" (the heads in the table above) and port the behaviour into Rust tests. No Node code moves into `main`.
4. **When a reference is in another language, it is rewritten in Rust** (owner's words). This does not relax ADR-0002: a rewrite reimplements behaviour and tests; it is not a line-by-line translation of third-party code. Porting third-party code still follows ADR-0002 "Acceptance rules for future copy PRs".
5. **Any need for a non-Rust language goes to "Open questions for the owner"**; implementers do not decide it themselves.
6. **Verification is split by platform.** Every crate builds and runs its cross-platform tests on Linux (`cfg(unix)`/`cfg(windows)` split). Windows-only behaviour (Job Objects, `.cmd` shims, junctions, WebView2, the installer) is verified by the `windows-latest` GitHub Actions job (task packet P1-3) or on the owner's Windows machine, and packets mark those items **Windows-only**. A skipped Windows job is not a pass.

### Language use outside this decision

Not shipped backend code, therefore not forbidden here, but listed so the owner sees it:

- **External agent runtimes**: `claude-agent-acp` (npm; needs Node.js on the user's machine) and `codex-acp` are installed by the user and started as separate processes; AgentDock neither bundles nor distributes them (ADR-0002 decision 4).
- **Development and CI tooling**: npm (frontend build), GitHub Actions YAML, `docs/contracts/validate_fixtures.py` (ADR-0003; Python standard library; validates contract fixtures in development/CI only).

## Consequences for ADR-0002

- **No ADR-0002 decision is overturned.** The official `agent-client-protocol` crate, own process supervision with Windows Job Objects, `process-wrap`/`win32job` as candidates, spikes S1–S5 and the copy-PR rules all stand. This ADR makes the backend language explicit and settles the Node PRs.
- **ACP crate version facts (checked 2026-11-22)**: ADR-0002 lines 52 and 99 say "pin `=5.3.0`, upgrade once a release contains #504 (`6a4a95ca`)". On crates.io the latest `agent-client-protocol` is `5.5.1` (2026-11-21), after `5.5.0`, `5.4.0` (2026-11-18) and `5.3.0` (2026-11-14); MSRV 1.88.0, Apache-2.0. `gh api repos/agentclientprotocol/rust-sdk/compare/6a4a95ca...v5.4.0` returns `ahead`, so `v5.4.0` and later contain #504. The upgrade condition is met; the exact pin is chosen in the PR for packet P3-1 under ADR-0002 §3 ("an upgrade is an explicit PR that passes the mock-agent tests"). Byte-level line framing in the facade stays (ADR-0002 line 52) for line-length limits and backpressure.
- ADR-0002 §3 mentions `pnpm audit`; the repo uses npm (`package-lock.json`). Packets use `npm audit`. Listed under "Existing document issues" in `docs/tasks/README.md`; ADR-0002 is not edited here.

## Consequences for ADR-0003

- From P2 on, packets take Rust types, state machines and fixture-conformance tests from the ADR-0003 contracts (`docs/contracts/`), merged to `main` by PR #22 as `c9e33cf` (2026-11-22). Line numbers cited by packets refer to that commit.
- PR #29's 16-state workflow differs from ADR-0003's 12 states (the PR #29 branch `docs/implementation/durable-task-workflow.md` lines 120–147 has the diff table). Issue #51 says not to rewrite the existing task state machine. Packets follow ADR-0003 and port only PR #29's evidence gates and test scenarios; this needs the owner's confirmation (open question 2).

## Alternatives considered

1. **Ship the Node runtime as a sidecar.** Fastest to a working build, but contradicts the owner's decision, AGENTS.md ("Rust/Tauri process safety") and ADR-0002 decisions 1–2; Node 22 `node:sqlite` is still experimental. Rejected.
2. **Merge the Node PRs as dev tools and delete them later.** `main` would carry two event formats and two state machines (PR #25 doc lines 124–138 list the gaps to the contracts) and invite misuse. Rejected; packets cite the SHAs instead.
3. **Translate the Node code line by line.** Would import its known limits (`taskkill /T /F` instead of Job Objects, several pending approvals, non-contract event names). Rejected; redesign from the contracts and port behaviour and tests only.

## Consequences

- The critical path restarts from the Rust workspace (issue #4). What the Node PRs proved is not lost, but has to be proved again by Rust tests.
- More task packets (see `docs/tasks/README.md`); process supervision, ACP streaming and cancellation, policy and crash recovery need a strong model for implementation and review.

## Open questions for the owner

1. Keep `docs/contracts/validate_fixtures.py` (Python) in CI as a contract regression check, or keep only the Rust conformance tests once packet P2-5 lands?
2. PR #29's 16-state workflow vs ADR-0003's 12 states: confirm that packets follow ADR-0003 and port only the evidence gates.
3. Frontend/backend type sync (ADR-0003 open question 4: Rust-first `schemars` + `ts-rs`/`specta` or schema-first `typify`) is still open; packet P1-2 uses "Rust writes a JSON fixture, TS tests read the same fixture" and adds no code generator.
