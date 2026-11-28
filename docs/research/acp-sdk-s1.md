# Spike S1: `agent-client-protocol` dependency size, licenses and features

Status: record of measurements for packet [P3-1](../tasks/P3-1-acp-line-framing.md) / [Issue #6](https://github.com/ChiJiun/agentdock/issues/6) / [ADR-0002](../decisions/0002-source-reuse.md) spike S1.

| Item | Value |
| --- | --- |
| Date measured | 2026-11-28 (first measurement, 61 packages); re-measured 2026-11-29 (62 packages) |
| SDK version pinned | `agent-client-protocol =5.6.1`, `default-features = false`, no features |
| Rust toolchain | `rustc 1.91.1 (ed61e7d7e 2025-11-07)`, `cargo 1.91.1`, host `x86_64-pc-windows-msvc` (Windows 11) |
| Commit measured | Numbers in this document are from `e0f4d89a0ad5514a7030cdf5c263d4abcde01c49` (merge of `main` `389ce78` into the P3-1 branch; the first measurement was on `89db1bec929073cdbf07b924e2b23a0f54e0402e`, on top of `main` `5bb4342`). See "Why 61 became 62" below |

## 1. Version choice and sources

| Fact | Source (checked 2026-11-28) |
| --- | --- |
| Latest published version is `5.6.1` (2026-11-25), Apache-2.0, MSRV 1.88.0, not yanked. Earlier: `5.6.0` 2026-11-24, `5.5.1` 2026-11-21, `5.5.0` 2026-11-21, `5.4.0` 2026-11-18, `5.3.0` 2026-11-14 | `cargo search agent-client-protocol`, `cargo info agent-client-protocol`, and `https://crates.io/api/v1/crates/agent-client-protocol` (versions list) |
| `v5.6.1` contains the #504 fix (`6a4a95ca`, non-UTF-8 line no longer ends the connection): `gh api repos/agentclientprotocol/rust-sdk/compare/6a4a95ca...v5.6.1 --jq .status` returned `ahead` | https://github.com/agentclientprotocol/rust-sdk (tag `v5.6.1`, commit `4656755a625c6747ecde84b3358a0a9e8af9f9b0`) |
| `Lines::new` signature is unchanged from the one the packet cites for 5.5.1: `OutgoingSink: Sink<String, Error = io::Error> + Send + 'static`, `IncomingStream: Stream<Item = io::Result<String>> + Send + 'static` | published crate source `src/jsonrpc.rs` lines 7414–7422 in `agent-client-protocol-5.6.1` (read from the local cargo registry copy); also verified by the test `framing_plugs_into_sdk_lines_transport` |
| Docs | https://docs.rs/agent-client-protocol/5.6.1 |

The packet text says `5.5.1` "or the newest version containing #504 at implementation time" (packet §9, CONVENTIONS §4). `5.6.1` is the newest, so it is pinned. Upgrade rule: ADR-0002 §3 (explicit PR, mock-agent tests, Windows smoke test; no `unstable_*` features without an ADR). ADR-0004 "ACP crate version facts" records that every version since `5.4.0` contains #504; the facade framing stays regardless (line cap, backpressure).

## 2. Commands and results

All run from the repository root after adding the crate.

```bash
cargo tree -e normal -p agent-client-protocol --prefix none | sed 's/ (\*)//; s/ (proc-macro)//' | sort -u | wc -l
# => 62 distinct name+version entries (the SDK itself included; was 61 on 89db1bec, see below; `syn` appears in two versions: 2.0.119 and 3.0.10)

cargo tree -e features -p agent-client-protocol | grep -E 'process|stdio|async-process|async-io|blocking'
# => no output (grep exit status 1): neither the `process` nor the `stdio` feature is enabled,
#    and `async-process`, `async-io`, `blocking` are not in the tree

cargo tree -e features -p agent-client-protocol | grep -E 'agent-client-protocol(-schema)? feature' | sort -u
# => agent-client-protocol-schema feature "unstable_proxy_chains"
#    (the SDK itself turns this schema feature on; AgentDock enables no SDK feature)

cargo tree -e normal -p agentdock-acp --depth 1
# => agent-client-protocol v5.6.1, futures v0.3.34, thiserror v2.0.21, tokio v1.54.1
```

Direct dependencies of the SDK in this build: `agent-client-protocol-derive`, `agent-client-protocol-schema 1.22.0`, `futures`, `futures-concurrency`, `rustc-hash`, `serde`, `serde_json`, `tracing`, `uuid`, `anyhow` (plus their transitive crates). sources.md gives an upper bound of 118 packages, computed from the 5.3.0 `Cargo.lock` without optional features and covering every platform; the 62 here is the normal-dependency tree of the Windows host for 5.6.1, so the two numbers are not directly comparable.

Packages that `agentdock-acp` adds beyond the SDK's tree (all MIT or MIT OR Apache-2.0): `tokio 1.54.1` (MIT), `bytes 1.12.2` (MIT, pulled by tokio `io-util`), `thiserror 2.0.21` and `thiserror-impl 2.0.21` (MIT OR Apache-2.0). `tokio` is built with `default-features = false`, `io-util` only (`macros` and `rt` for tests only, as dev-dependencies); `futures` with `default-features = false, features = ["std"]`.

### Licenses of the 62 SDK packages (`cargo tree -f "{p}|{l}"`)

| Count | License expression |
| --- | --- |
| 31 | MIT OR Apache-2.0 |
| 14 | MIT |
| 10 | Apache-2.0 OR MIT |
| 3 | Apache-2.0 |
| 1 | Zlib |
| 1 | Unlicense OR MIT |
| 1 | MIT/Apache-2.0 |
| 1 | (MIT OR Apache-2.0) AND Unicode-3.0 |

No GPL, AGPL, LGPL or MPL expression appears in the normal-dependency tree on this host. Every expression has an alternative in the `deny.toml` allow-list (`MIT`, `Apache-2.0`, `Unicode-3.0`, `Zlib`, …), so no new license exception is needed or added.

### Why 61 became 62

Merging `main` (P2-1, PR #88: `agentdock-core` now depends on `ulid 3.0.0` → `rand 0.10.4`) added exactly one package to the SDK's normal tree: `rand_core 0.10.1` (`MIT OR Apache-2.0`, which is why that license row went from 30 to 31). The SDK's own dependencies did not change. The cause is Cargo feature unification in the workspace: `rand`'s `sys_rng` feature turns on `getrandom 0.4.3`'s `sys_rng` feature, and that feature adds the dependency `getrandom → rand_core` (the path is `agent-client-protocol → uuid → getrandom → rand_core`). Checked by diffing the package lists of the two measurements (`comm`) and with `cargo tree -e features -i getrandom@0.4.3`. The package list is otherwise identical, the license table changed only in that one row, and `cargo tree -e features -p agent-client-protocol | grep -E 'process|stdio|async-process|async-io|blocking'` is still empty. The measurement depends on which other workspace members are built; a later workspace member may change it again.

### `cargo deny check`

**Not run locally**: `cargo-deny` is not installed on the measuring machine (`cargo deny` is not a known cargo subcommand there), so `cargo deny check` was not executed locally. The result comes from the CI `cargo-deny` job (`EmbarkStudios/cargo-deny-action`, `--all-features`) on PR #87 at head `89db1bec929073cdbf07b924e2b23a0f54e0402e` (run 46144793100, job 140978335842): `advisories ok, bans ok, licenses ok, sources ok`. Only `multiple-versions` warnings (duplicate crate versions, e.g. `toml`, `windows-sys`, `winnow`; `bans.multiple-versions = "warn"` in `deny.toml`) were printed. The metadata-based license table above is not a substitute for that job.

## 3. Conclusion for ADR-0002 S1

- The SDK without optional features is runtime-agnostic (it uses `futures`, not Tokio) and has a normal-dependency tree of 62 packages on the Windows host, below the 118 upper bound in sources.md.
- No `process` / `stdio` feature and no `async-process` / `async-io` runtime is pulled in; AgentDock keeps process supervision (P3-2).
- Not covered by S1 and left to later packets: SDK behavior against a real agent (S3 mock agent, P3-3/P3-4), Windows process supervision (S2, P3-2), vendor `_meta` passthrough (S5).
