# Task packet conventions (read this before any packet)

> **繁中摘要**：所有任務包共用的規則。實作者通常是在擁有者 Linux VM 上操作的模型（能讀 repo、能跑指令），偶爾由 Codex／Claude Code 做 review。本檔規定：repo 佈局與 crate 依賴方向、Rust 慣例、依賴稽核、測試慣例（Linux 優先，Windows-only 測試交給 `windows-latest` CI）、全域安全不變式、Windows 共通陷阱、基本驗收指令、PR 規則，以及每包固定的 12 節格式。任務包與 ADR／契約矛盾時以 ADR／契約為準。

Status: Proposed (reviewed together with `docs/tasks/`). Date: 2026-11-22. Decisions behind these rules: [ADR-0004](../decisions/0004-rust-primary-backend.md).

A packet only states what is specific to it. Every rule here applies even when a packet does not repeat it.

## 0. How to use a packet

1. Read this file, then the whole packet, then the spec sections listed in the packet's §8.
2. Change only the files listed in §3. If you need to touch anything else, **stop and report**; do not widen the scope.
3. Write the §6 tests first (they fail), then implement until every §7 command gives the expected result. Run the tests yourself, repeatedly; do not stop at "should pass".
4. If a packet contradicts an ADR or a contract, **the ADR/contract wins**; write the contradiction in the PR description. Do not edit ADRs or contracts.
5. One packet ≈ one PR ≈ at most ~400 changed lines (excluding `Cargo.lock`, `package-lock.json` and test fixtures). Split larger work into the sub-PRs the packet names.

### Packet format (fixed)

Every packet starts with a short **繁中摘要** (Traditional Chinese summary) and then has these sections, in English:

1. Goal and non-goals
2. Prerequisites and parallel work
3. Files
4. Public types and signatures
5. Implementation steps
6. Tests to write first (security-relevant packets include adversarial tests)
7. Acceptance commands and expected results (Linux first; Windows-only items marked)
8. Spec references and porting sources (PR / branch / file / line / SHA)
9. Dependencies (new crates marked **needs audit**)
10. Model tier (honest)
11. Common mistakes and pitfalls
12. Reviewer checklist (for Codex / Claude Code)

## 1. Implementer environment

- **Primary**: Linux VM (Ubuntu 24.04 assumed) with shell, files and git, driven by a model through an MCP. All Rust crates must compile and their cross-platform tests must pass on Linux.
- **Windows**: behaviour that only exists on Windows (Job Objects, `.cmd` shims, junctions, 8.3 names, case-insensitive paths, WebView2, the Tauri installer) is verified by the `windows-latest` job in GitHub Actions (P1-3) or on the owner's Windows machine. Such tests are `#[cfg(windows)]`; the packet marks them **Windows-only** and says how to read the CI result.
- Platform code is split with `#[cfg(windows)]` / `#[cfg(unix)]`. Pure logic that encodes Windows rules (for example lexical path checks) takes the platform as a parameter so Linux runs those tests too.

### Linux VM prerequisites

**Ask the owner before installing any system package.** Proposed commands:

```bash
# Rust (user-level, no sudo)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
# Node.js 22 LTS: use the distribution the owner prefers (nvm, fnm or NodeSource)
# Tauri 2 build dependencies on Ubuntu/Debian (needs sudo; ask first).
# Source: https://v2.tauri.app/start/prerequisites/ (re-check the list before installing)
sudo apt-get update && sudo apt-get install -y \
  libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev
# Git >= 2.36 and the GitHub CLI (gh) for P5/P7 packets
git --version; gh --version
```

Packets that only touch crates other than `agentdock-desktop` do not need the Tauri packages.

### Reading Windows CI results

```bash
gh pr checks <PR number> --repo ChiJiun/agentdock          # job list and state
gh run view <run id> --repo ChiJiun/agentdock --log-failed  # failed step logs
```

A Windows-only acceptance item is satisfied only when the `windows-latest` job ran the named test and it passed. A skipped or missing job is not a pass.

## 2. Repository layout (fixed after P1)

```text
Cargo.toml                 # [workspace]; members below
rust-toolchain.toml        # pinned toolchain (P1-1)
deny.toml                  # cargo-deny config (P1-3)
src/                       # existing React/TS frontend (not moved)
src/ipc/                   # typed wrappers for Tauri commands (from P1-2)
src-tauri/                 # Tauri 2 desktop host, package name agentdock-desktop (P1-2)
crates/agentdock-core/     # pure data types, state machine, canonical hash, attention, redaction (no I/O)
crates/agentdock-store/    # SQLite event store, migrations, projections, recovery, artifacts
crates/agentdock-process/  # child process supervision (Windows Job Object, env allow-list, stderr drain); used by agents and checks (P3-2)
crates/agentdock-acp/      # ACP facade, line framing, adapter config
crates/agentdock-mock-agent/  # mock ACP agent binary (tests only, never shipped)
crates/agentdock-policy/   # path scope, operation classification, approval rules
crates/agentdock-integrations/ # git, worktrees, read-only GitHub, controlled check runner
crates/agentdock-orchestrator/ # application layer wiring store/acp/policy/integrations
docs/contracts/            # ADR-0003 contracts (merged to main as c9e33cf)
```

Crate dependency direction (downwards only, no cycles):

```text
agentdock-desktop → agentdock-orchestrator → { agentdock-store, agentdock-acp, agentdock-policy, agentdock-integrations } → agentdock-core
agentdock-acp, agentdock-integrations → agentdock-process (depends only on process-wrap, windows, tokio, thiserror; callers redact stderr)
agentdock-integrations → agentdock-policy (ScopedPath)
agentdock-mock-agent → serde_json only (raw NDJSON; no SDK, no other agentdock crate; see P3-3)
```

`docs/architecture.md` lines 40–47 name modules `apps/desktop`, `crates/core` etc. The packets use Tauri's default `src-tauri/` and an `agentdock-*` prefix (avoids clashing with `std`/`core`, frontend stays in place). This deliberate deviation is listed under "Existing document issues" in `README.md`.

## 3. Rust conventions

- Edition 2021. Every crate root starts with `#![forbid(unsafe_code)]`. P3-2 uses `process-wrap` (unsafe stays inside that crate), so AgentDock code needs no unsafe. The only exception is if spike S2 rejects `process-wrap` and a custom spawner is written: that module then uses `#![deny(unsafe_code)]` with per-site `#[allow(unsafe_code)]` and `// SAFETY:` comments, and you must stop and report first.
- No `unwrap()` / `expect()` / `panic!()` in non-test code (`#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]` at non-test crate roots). Tests may use them.
- Errors: one `pub enum Error` per crate (`thiserror`), `pub type Result<T> = std::result::Result<T, Error>;`. Error messages never contain environment values, tokens or secrets from command lines.
- Serialization: JSON keys and enum values are `snake_case` (contracts README "Naming rules"). Optional fields are `Option<T>` + `#[serde(default, skip_serializing_if = "Option::is_none")]`; **never emit `null`**. Do not use `deny_unknown_fields` on read paths.
- IDs are newtypes (`TaskId(String)` …) validated as `<prefix>_` + 26 Crockford base32 chars; APIs never take a bare `String` id.
- Time: RFC 3339 UTC with exactly 3 fractional digits and `Z` (e.g. `2026-11-17T02:00:07.000Z`), via `agentdock_core::time::Timestamp` (P2-1).
- Async: `tokio`. Blocking SQLite calls run on a dedicated thread or `spawn_blocking`; never hold a `rusqlite::Connection` across long async work.
- Never run anything through a shell (`cmd /C`, `sh -c`, `powershell -Command`). Every external program is "absolute path + argument vector".

## 4. Dependency rules

- Only crates listed in a packet's §9 may be added. **needs audit** means: you may add it to finish the task, but the PR must include a `cargo tree -e normal -p <crate>` summary, the license, and the `cargo deny check` result (after P1-3) for the owner to approve. Do not substitute other crates; stop and report instead.
- Exact versions (`=x.y.z`) only for crates ADR-0002 requires pinning (`agent-client-protocol`, `process-wrap`, `win32job`); others use normal semver locked by `Cargo.lock`. Always commit `Cargo.lock`.
- §9 versions are the latest stable on crates.io as of 2026-11-22. If a newer patch/minor exists when you implement, use it and say so in the PR.
- Never copy third-party source (AGENTS.md). If needed, follow ADR-0002 "Acceptance rules for future copy PRs" and stop and report first. No AGPL (Forge) code.

## 5. Test conventions

- Unit tests in `#[cfg(test)] mod tests`; tests needing the filesystem or child processes in `crates/<crate>/tests/*.rs`.
- Temporary directories must contain a space and CJK characters (ADR-0002 WT-4): `tempfile::Builder::new().prefix("agent dock 測試-")`.
- Windows-only tests: `#[cfg(windows)]` on the test function, listed in the packet's §7 under **Windows-only (CI)**.
- Tests that need a real Claude Code / Codex or the network: `#[ignore = "needs real agent; set AGENTDOCK_REAL_AGENT_E2E=1"]` and re-check the variable inside. **List every ignored test in the PR description with the commit where it last passed** (ADR-0002 X-4: skipped is not green).
- Security packets include adversarial tests (path escape, approval bypass, replay, crash recovery); §6 lists the minimum.
- Never put real secrets in tests or fixtures; use obvious fakes such as `ghp_` + 36 × `0` or `sk-ant-` + a fixed fake string.

## 6. Global safety invariants (no packet may break them)

1. **Agent text never authorizes anything.** Only `user` or `policy` actors approve/deny; only orchestrator/integration write operation or check results (ADR-0003 §6; `docs/contracts/checkpoint-and-replay.md` Rule 11).
2. **Persist before acting.** Events that authorize a side effect are committed before the effect (`persist_then_act`); state changes are committed before the UI is told (`persist_then_report`).
3. **No automatic replay of non-repeatable operations after a crash** (push, PR, merge, delete, destructive command).
4. **Every path goes through the `agentdock-policy` scope check** (P4-1) before it is read, written or used as a child cwd; no hand-written `starts_with` comparisons.
5. **Child process environments use an allow-list**; never inherit the whole environment. Variables that retarget Git/GitHub (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GH_HOST`, `GH_REPO` …) are removed.
6. **Never read, log or return** `.env`, credentials, SSH private keys or tokens. Redact before writing events (P2-7).
7. **Never claim what is not true**: no subscription quota display; when an agent runs in its own bypass/full-access mode the UI says "Policy not enforced" (`docs/ux/states-and-indicators.md` §9); an external session is called reattachable only when its capability says so.
8. No automatic merge, force push, branch or worktree deletion; these are single operations a user explicitly approves, and alpha implements no merge.

## 7. Windows pitfalls (check in every packet)

- Paths are case-insensitive: canonicalize, then compare case-insensitively (ADR-0002 WT-9). `std::fs::canonicalize` returns verbatim `\\?\C:\...`; use `dunce` for display and for external programs, but **compare** in one consistent form.
- `.cmd` / `.bat` shims (every npm-installed agent) cannot be started without `cmd.exe`, and going through `cmd.exe` brings argument-escaping bugs (BatBadBut class). Only P3-2/P3-6 decide how agents start; no other packet starts a `.cmd`.
- GUI processes must start children with `CREATE_NO_WINDOW` or a console window flashes.
- Open files cannot be deleted or renamed (antivirus, indexer, a running agent); on failure re-read the state and report it truthfully (ADR-0002 WT-6).
- Long paths: worktree paths may exceed 260 chars; cover it in tests.
- Line endings: Git may have `core.autocrlf`; tests that compare file contents pin `.gitattributes` or pass `-c core.autocrlf=false`.
- Junctions and symlinks are potential escapes. Creating symlinks on Windows needs Developer Mode or admin; tests fall back to junctions rather than silently skipping.
- Debug builds have a 1 MB main-thread stack (ADR-0002 X-2): recursive parsers and deep JSON need depth limits.
- `taskkill /T /F` misses grandchildren that left the tree; use Job Objects (P3-2).

## 8. Baseline acceptance commands (every packet; packets may add more)

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run typecheck
npm test
npm run build
```

`cargo` commands apply from P1-1 on. Rust-only packets still run the three frontend commands to show nothing broke. Then push and confirm the required CI check `check` and the `windows-latest` job pass (§1).

## 9. PR rules

- Branch: `feat/<packet id in lower case>-<short name>`, e.g. `feat/p2-4-sqlite-store`. PRs target `main` only; never push to another PR's branch.
- `main` is protected ("Protect main"): squash merge only, linear history, required check `check`. If the branch falls behind `main`, sync with a normal merge (no force push).
- Commit messages, PR title and description in Traditional Chinese (Taiwan); code identifiers and comments in English.
- PR description sections:
  1. What changed and why (cite the packet id).
  2. Files and highlights.
  3. How it was verified, with real command output summaries (write "not run" and why when applicable), including the Windows CI job result.
  4. What is not verified (including `#[ignore]` tests and the commit where they last passed).
  5. New dependencies and audit data (§4).
  6. Reviewer focus notes (self-contained, ready to paste to another model: files and lines to inspect, uncertain decisions, edge cases, questions for the reviewer). Include the packet's §12 checklist.
- No auto-merge, no force push; merging follows the owner's review process.
