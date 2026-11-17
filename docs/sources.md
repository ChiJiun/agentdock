# Upstream reference and source migration inventory

Snapshot: 2026-11-17 (source audit for [Issue #1](https://github.com/ChiJiun/agentdock/issues/1)). Module-level decisions are recorded in [ADR-0002](decisions/0002-source-reuse.md).

**No third-party code has been imported.** This file is the provenance manifest that any future copy or dependency PR must cite. A directory existing does not prove independent embeddability or security; every row below states what was actually checked.

## Source strategy

1. **Use through ACP before copying code.** Claude Code, Codex and Octomind remain independent runtimes; no vendor-source bundling by default.
2. **Depend on published, maintained packages before copying.** A pinned crate with upstream security fixes beats a vendored copy we must patch ourselves.
3. **Adapt only modules with proven boundaries.** For candidate modules, verify exact dependencies, platform support, tests, license and security obligations. A module's internal imports can make migration more expensive than reimplementation.
4. **Clean-room design for protected UI.** Claude Code Desktop is the UX inspiration for layout/interaction *only*; do not copy Anthropic assets, copywriting, or proprietary implementation.
5. **Track provenance.** Every transplanted file requires source repository, immutable commit, path, license, derivative changes, upstream update policy and test coverage.
6. **Prefer one owner for each concern.** Do not combine different agent loops into a massive core.

## How this snapshot was verified

- Full commit SHAs, default branches and SPDX license IDs were read from the GitHub REST API (`gh api repos/<owner>/<repo>` and `.../commits/<branch>`) on 2026-11-17.
- `LICENSE` / `NOTICE` / `THIRD_PARTY_NOTICES` files were listed from each repository root at the pinned SHA, and the license text or `license` field in `Cargo.toml` was read.
- Candidate paths were confirmed to exist with `gh api repos/<owner>/<repo>/git/trees/<sha>?recursive=1`; sizes below are from that tree listing.
- `hotic/acpira` and `agentclientprotocol/rust-sdk` were fetched read-only (`git fetch --depth 1 <sha>`, no build, no scripts) to read source, `Cargo.toml` and `Cargo.lock`. Dependency closures were computed by parsing `Cargo.lock` only (no `cargo` invocation), so they are **upper bounds** that include dev-dependencies and every enabled feature in that workspace.
- Advisories: GitHub Advisory Database (`gh api advisories?ecosystem=rust&affects=<crate>`) and each repository's published security advisories. `cargo audit`, `cargo deny` and `npm audit` were **not** run.

## Exact repository inventory

| Repository | Pinned full SHA (commit date, UTC) | License (SPDX) | License files at root | Intended role |
| --- | --- | --- | --- | --- |
| [hotic/acpira](https://github.com/hotic/acpira) | `0481995e3a55abcd707f6808df9d7f396483c3e1` (2026-11-16) | MIT, "Copyright (c) 2026 hotic" | `LICENSE`, `THIRD_PARTY_NOTICES.md` | UX and Windows process reference; see ADR-0002 |
| [ChiJiun/acpira](https://github.com/ChiJiun/acpira) (fork of hotic/acpira) | `c03be9e725dcb2b8ad6782c5404676f90f6c892e` (2026-11-16) | MIT | `LICENSE`, `THIRD_PARTY_NOTICES.md` | Requirements and test scenarios from unmerged PRs only |
| [agentclientprotocol/rust-sdk](https://github.com/agentclientprotocol/rust-sdk) | `6a4a95cabed1b5307651a19771c20b91bb6566ea` (2026-11-16); release tag `v5.3.0` = `05fd3893cca2f1be2eb3a262b0f7da2c52abaa58` | Apache-2.0, "Copyright 2025 Zed Industries, Inc. and contributors" | `LICENSE` (no `NOTICE`) | **Chosen ACP dependency** (crate `agent-client-protocol` 5.3.0) |
| [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol) | `4aab69b4e6bcb53965ff5b1141d2f04a62a25c6c` (2026-11-16) | Apache-2.0 | `LICENSE` | Spec and `agent-client-protocol-schema` crate (transitive dependency `=1.18.0`) |
| [agentclientprotocol/acp-tck](https://github.com/agentclientprotocol/acp-tck) | `f050441441ca4faafd1d4e58761125304d06743d` | Apache-2.0 | `LICENSE` | Experimental agent conformance kit; external CI tool for the mock agent |
| [agentclientprotocol/claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) | `0073280b977a69934fb56670943d1ef42e7b687e` | Apache-2.0 | `LICENSE` | External ACP runtime (not bundled) |
| [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp) | `7c98a1608022cbb2b7e425ae7a1df5fde86c6ff2` | Apache-2.0 text, "Copyright 2025 JetBrains s.r.o." (GitHub reports `NOASSERTION`) | `LICENSE` | External ACP runtime (not bundled) |
| [Muvon/octomind](https://github.com/Muvon/octomind) (default branch `master`) | `7d729126ade5ada08ef89fad33637c46e729739c` (2026-11-16) | Apache-2.0 | `LICENSE` | External ACP runtime; supervisor/session research |
| [aaif-goose/goose](https://github.com/aaif-goose/goose) | `58fa06b183568a901b9e62ba2202b392d6545a54` (2026-11-17) | Apache-2.0, authors "AAIF" | `LICENSE` | Research only (provider/context design) |
| [octos-org/octos](https://github.com/octos-org/octos) | `d1863004f8c09c4a330117db9fc32f017ff4fd56` (2026-11-16) | Apache-2.0 | `LICENSE` | Research only (remote/durable workflow) |
| [contextbridge/aether](https://github.com/contextbridge/aether) | `b847dc863beddf3145a2e0bd8617bbb834e1bc31` (2026-11-14) | MIT, "Copyright (c) 2026 Joshua Carver" | `LICENSE` | Research only (native agent architecture) |
| [Adulari/forge](https://github.com/Adulari/forge) | `45e984c927d029729c476e1efa4d09d070dfeb28` (2026-11-13) | **AGPL-3.0-only** (`Cargo.toml`) | `LICENSE` (GNU AGPL v3) | **Excluded** from implementation input; see licensing section |

Notes:

- The Goose default branch moved to `75ef30fbab5d0e627d09a870df2f962c5691ee2f` during the audit; this inventory keeps the earlier `58fa06b1…` snapshot that the original planning document recorded. Re-pin before any Goose-derived work.
- The SDK snapshot `6a4a95ca…` is 3 commits ahead of the `v5.3.0` release. A dependency must use the **published crate** (`agent-client-protocol 5.3.0`, crates.io checksum `956559bd2dfddb5c8bc86792b1669bd2611fb4bd2c31865e4b8165ab6ea63109`, MSRV 1.88.0), not the unreleased tip. One of those 3 commits is `6a4a95ca` "fix(acp): keep the connection open when an incoming line is not valid UTF-8 (#504)": **5.3.0 ends the whole connection on a line that is not valid UTF-8**. AgentDock pins 5.3.0 with this known issue and contains it in its own line framing (lossy UTF-8 decoding before the SDK's `Lines` transport), then moves to the first release that includes #504; see ADR-0002 section 1.
- `agent-client-protocol-schema 1.18.0` crates.io checksum (from the SDK `Cargo.lock`): `5128cd57704892e3978c85bfce0d532ef3162f585739f44726fa80d464c1782f`.

## Module-level inventory and decisions

Decision vocabulary (from Issue #1): **dependency** (consume a published package), **protocol adapter** (run as an external process over ACP), **reuse** (copy specific files with attribution, through a migration PR), **fork** (maintain a modified copy of a whole package), **reimplement** (write AgentDock code; upstream is reference or test material only), **excluded**. Rationale for each row is in [ADR-0002](decisions/0002-source-reuse.md).

| Source path @ pinned SHA | License | Size and import tree (measured) | Decision |
| --- | --- | --- | --- |
| rust-sdk `src/agent-client-protocol/` (crate 5.3.0) | Apache-2.0 | ~33.7k Rust lines, 651 test functions. Direct deps: `agent-client-protocol-schema =1.18.0`, `agent-client-protocol-derive =5.3.0`, `futures`, `futures-concurrency`, `rustc-hash`, `serde`, `serde_json`, `tracing`, `uuid`, `anyhow`; optional `process` feature adds `async-process`, `async-io`, `shell-words`, `rustix` (unix), `windows-sys` (windows). `Cargo.lock` closure upper bounds: 302 packages including dev-dependencies (overstated), 140 with all optional features, 118 with no optional features | **Dependency** (pinned, behind AgentDock's `crates/acp` facade; prefer not enabling `process`) |
| rust-sdk `src/agent-client-protocol-test/` | Apache-2.0 | `publish = false` (not on crates.io) | **Reimplement** our mock agent on the SDK `Agent` role; read for test ideas |
| acp-tck | Apache-2.0 | Python tool run via `uvx`; tests **agents**, not clients | **External CI tool** (optional) for the AgentDock mock agent |
| Acpira `rust/crates/acpira-rpc/` | MIT | 3 Rust files (4 in total), 531 Rust lines; deps `parking_lot`, `serde_json`, `tokio`; closure upper bound 38 | **Reimplement / not imported** (SDK covers JSON-RPC). Ordering and cancel semantics become test scenarios |
| Acpira `rust/crates/acpira-host/src/acp/transport/process.rs` and `src/acp/session/**` | MIT | Part of `acpira-host`: 329 Rust files (343 files in total), 116,611 Rust lines; `src/acp/` alone 32,757 lines. `process.rs` imports `acp::agents::{launch,registry}`, `acp::vendors::{grok,claude_auth,claude_workflow}`, `accounts::antigravity`, `i18n`, `platform::windows_process`, `acpira_agent::plugin_hooks`. Crate closure upper bound 540 packages including dev-dependencies (includes `oxc_*`, `iroh` via gateway, `rusqlite`, `portable-pty`) | **Reimplement**; capability list, timeouts and vendor quirks recorded as compatibility notes |
| Acpira `rust/crates/acpira-host/src/platform/windows_process.rs` (211 lines), `src/platform/command.rs` (184 lines), `src/acp/agents/launch.rs` (73 lines); tests `rust/crates/acpira-host/tests/windows_launch.rs`, `tests/windows_compat.rs` | MIT | Near-standalone: `windows-sys`, `tokio`; one constant from `acpira_shared::settings`; `launch.rs` also calls `crate::net_proxy::apply` (line 71) and `super::login_path` (lines 17, 68). Last touched upstream in `eeea22dce797ed02861060987493aeb98ccc513e` (windows_process.rs) | **Reuse candidate, deferred (fallback)**: only if spike S2 shows that the published process-tree crates and a small own spawner are insufficient; requires its own migration PR |
| crates.io `process-wrap` 10.0.1 ([watchexec/process-wrap](https://github.com/watchexec/process-wrap) `2f4bc393d8bd03b4b1c81fee2e13ce82dd42906e`) and `win32job` 2.1.0 ([ohadravid/win32job-rs](https://github.com/ohadravid/win32job-rs) `9c980106cf7ac69cd471539300c21aca67c2e066`) | MIT OR Apache-2.0 (crates.io metadata) | `process-wrap`: Tokio frontend (`tokio1` feature), `job-object` wrapper that resumes threads after assignment, process group/session, kill-on-drop; depends on `windows`, `nix`. Not run | **Dependency candidate**, preferred for Windows process trees if spike S2 passes |
| Acpira `rust/crates/acpira-agent/` | MIT | 86 Rust files (128 in total), 27,977 Rust lines; deps include `pdf-extract`, `image`, `gif`, `portable-pty`, `ureq`; closure upper bound 180 | **Excluded from MVP**; if ever needed, run `acpira agent` as an external ACP process (protocol adapter) rather than copying |
| Acpira `rust/crates/acpira-shared/` | MIT | 41 Rust files (52 in total), 10,601 Rust lines; mirrors `packages/shared` | **Reimplement** (AgentDock domain types differ: Task ≠ Session) |
| Acpira `rust/crates/acpira-gateway/` | MIT | 17 Rust files (18 in total), 4,659 Rust lines; `iroh`/QUIC, `rustls`, APNs push, Windows Firewall COM, mDNS | **Research only**, post-V1 |
| Acpira `packages/ui/` | MIT; `packages/ui/effects/` files and `packages/ui/styles/beam.css` have separate MIT notices (Jakub Antalik) | 340 TS/TSX files, 51,410 lines; 377 imports of `@acpira/shared`; e.g. `chat/SessionList.tsx` 1,786 lines with 36 imports | **Reimplement** (interaction patterns only). Never copy `effects/`, `styles/beam.css`, `media/`, icons or brand assets |
| Acpira `apps/desktop/` | MIT | Tauri 2.12 shell, `src/` 23 Rust files (5,273 lines, including `src/app/`) plus `init.js`; on Windows links all of `acpira-host`; `tauri.conf.json` sets `"csp": null`; capability `core:default` only | **Reimplement** from the official Tauri 2 template; reference only |
| ChiJiun/acpira PR [#2](https://github.com/ChiJiun/acpira/pull/2) head `c4274b85cd575b99e09f751ca84b5c04c630aa5e`, [#4](https://github.com/ChiJiun/acpira/pull/4) head `a92cf8afdadc616b3d34897a1e8bd18c0c4a7044`, [#5](https://github.com/ChiJiun/acpira/pull/5) head `5d5080fb8e8e6c028f8aa87ab1bb67b36740a104`, [#6](https://github.com/ChiJiun/acpira/pull/6) head `39514c185a852346b31f37dd6b4f6b06b3d1bf06` | MIT | TypeScript plugins against Acpira's plugin API; all **unmerged** (OPEN). End-to-end status differs per PR: #2 and #5 never passed; #4 passed once (fake agent + `gh` stub, single happy path); #6 passed only in a reviewer environment before its final fixes (details in ADR-0002 section 4) | **Requirements and test scenarios only** (catalogued in ADR-0002) |
| Octomind `src/acp/` | Apache-2.0 | 6 files (~209 KB incl. tests); agent side built on `agent-client-protocol = "5.3.0"` | **Protocol adapter** (integration-test target) |
| Octomind `src/supervisor/`, `src/session/` | Apache-2.0 | 69 files (~1.75 MB) and 255 files (~3.31 MB) | **Research only** |
| Goose `crates/goose-context-management/` | Apache-2.0 | 7 Rust files (~42 KB); deps `goose-provider-types`, `rmcp`, `include_dir` | **Research only** (future native agent) |
| Goose `crates/goose-providers/` | Apache-2.0 | 34 Rust files (~648 KB); deps `goose-provider-types`, optional `goose-local-inference`, `rmcp`, `reqwest` | **Research only** |
| Octos `crates/octos-workflows/` | Apache-2.0 | 13 Rust files (~34 KB); depends on `octos-core` **and `octos-agent`** | **Research only** (remote worker design) |
| Octos `crates/octos-store/` | Apache-2.0 | 9 Rust files (~100 KB); `redb` storage | **Research only** (AgentDock uses SQLite) |
| Aether `crates/aether-core/` (crate `aether-agent-core`) | MIT | 75 Rust files (~414 KB); internal deps `aether-auth`, `aether-llm`, `aether-mcp-utils`, `aether-utils`; `rmcp` | **Research only** |
| Forge `crates/forge-core/`, `crates/forge-provider/` | AGPL-3.0-only | 345 + 65 Rust files (~5.39 MB + ~1.42 MB); `forge-core` depends on 12 internal `forge-*` crates | **Excluded** (no code, no line-by-line adaptation) |

## License and notice obligations

- **MIT** (Acpira, Aether): copied material must keep the copyright line and permission notice "in all copies or substantial portions", which includes **binary distributions**. Keep the upstream copyright line verbatim as it appears in the upstream `LICENSE` (Acpira's line includes the author's e-mail address); do not paraphrase it. Material from `packages/ui/effects/` and `packages/ui/styles/beam.css` carries a second MIT notice (Jakub Antalik) listed in Acpira's `THIRD_PARTY_NOTICES.md`.
- **Apache-2.0** (ACP SDK and schema, acp-tck, claude-agent-acp, codex-acp, Octomind, Goose, Octos): redistribute with a copy of the license (§4a); mark modified files with a prominent change notice (§4b); keep source copyright/patent/attribution notices (§4c); if the upstream ships a `NOTICE` file, include its attribution notices (§4d). None of the pinned repositories has a root `NOTICE` file, but transitive crates may, so the shipped notice bundle must be generated from the actual dependency graph. The patent license terminates for anyone who files a patent claim over the work (§3).
- **Dependencies count too.** The desktop binary statically links every Rust crate and bundles npm packages, so release artifacts need an aggregated third-party notice file (for example generated by `cargo about` / `cargo deny` license checks and an npm license report). This applies even if no upstream source file is ever copied.
- **Decide the license allow-list before M1.** The Tauri/wry tree brings in licenses beyond MIT/Apache, for example `MPL-2.0` (`cssparser`, `selectors`) and `Unicode-3.0` (`icu_*`, `unicode-ident`); all four crates appear in Acpira's desktop `Cargo.lock`. The `cargo deny` allow-list must name the accepted ones up front (MPL-2.0 is file-level copyleft: modified MPL files must stay available as source). Any GPL or AGPL transitive dependency is rejected.
- **AGPL-3.0-only** (Forge): copying or adapting it makes the combined work AGPL when distributed; §13 additionally requires offering source to users who interact with a modified version over a network, which would reach AgentDock's planned remote worker. AGPL code cannot be relicensed into an MIT/Apache/proprietary AgentDock. Treat Forge as excluded; see ADR-0002 for the clean-room rule.
- Screenshots, icons, product names (Claude, Codex, Acpira) and marketing artwork are not covered by the code licenses.
- AgentDock's own license is an **owner decision that is still open**; ADR-0002 lists the options and their consequences.

## Required source migration PR template

Any PR that copies third-party source, adds a direct dependency on one of the modules above, or forks one must state:

- Purpose and alternatives considered (dependency, protocol adapter, reimplementation, direct reuse) and why protocol integration is insufficient
- Origin URL + **full immutable commit SHA** + exact source paths (one row per file)
- Original author/copyright line, license, NOTICE impact; retained headers
- Dependency graph and vendored footprint (`cargo tree -e normal` / `pnpm why`), including new transitive licenses
- Modifications and rationale; modified files carry a change notice
- OS support (Windows first) and security review notes
- Tests (unit/integration/e2e) with results and what was **not** verified
- Upstream tracking: owner, update cadence, how security fixes are pulled (see ADR-0002)

## Vulnerability snapshot (2026-11-17)

- GitHub Advisory Database: no advisories for `agent-client-protocol` or `agent-client-protocol-schema`; no published repository advisories for `agentclientprotocol/rust-sdk` or `hotic/acpira`.
- Tauri: GHSA-7gmj-67g7-phm9 (origin confusion lets remote pages call local-only IPC, affects `tauri` 2.0.0–2.11.0, fixed in 2.11.1). AgentDock must require `tauri >= 2.11.1`; Acpira's desktop lock has `tauri 2.12.5`.
- Not performed: `cargo audit`, `cargo deny check`, `npm audit` against any candidate. These belong in AgentDock CI from M1.

## UX and protocol references

- [Anthropic: Redesigning Claude Code on desktop](https://claude.com/resources/articles/claude-code-desktop-redesign) (interaction reference; not an implementation source)
- [ACP Overview](https://agentclientprotocol.com/)
- [ACP stable v1 docs](https://agentclientprotocol.com/protocol/v1/overview)
- [ACP v2 draft announcement](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/announcements/acp-v2-draft.mdx)
- [ACP Rust SDK docs (5.3.0)](https://docs.rs/agent-client-protocol/5.3.0)
- [ACP TCK](https://github.com/agentclientprotocol/acp-tck)
- [Tauri 2 Capabilities](https://v2.tauri.app/security/capabilities/)
- [Tauri 2 Permissions](https://v2.tauri.app/security/permissions/)
- [Acpira Harness research issue](https://github.com/ChiJiun/acpira/issues/10)
