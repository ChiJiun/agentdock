# P3-1: `agentdock-acp` crate, byte-level line framing, spike S1 record

> **繁中摘要**：建立 crate `agentdock-acp`，加入官方 `agent-client-protocol`（精確版本、不啟用任何 feature，特別是 `process`）。實作 ADR-0002 要求的 facade framing：從 agent stdout 讀位元組、以 `\n` 切行、去掉行尾 `\r`、每行 16 MiB 上限（還沒遇到換行就超過即報錯）、無效 UTF-8 換成 U+FFFD 並計數，輸出給 SDK 的 `Lines::new`。另把 spike S1（SDK 依賴數量與授權）寫成 `docs/research/acp-sdk-s1.md`。模型等級：一般模型可。

Issue: #6 | Gate (#51): G2 (start agents through real ACP) | Model tier: **standard model**

## 1. Goal and non-goals

Goals:

1. Create crate `agentdock-acp` with the official `agent-client-protocol` (exact version, **no features**, in particular not `process`).
2. The facade framing required by ADR-0002 line 52: read bytes from agent stdout, split on `\n`, strip a trailing `\r`, cap each line, decode **lossy UTF-8** (invalid bytes → U+FFFD) and count replacements, and output `Stream<Item = io::Result<String>>` for the SDK's `Lines::new`.
3. Record spike S1: package count and licenses of `cargo tree -e normal -p agent-client-protocol`, in `docs/research/acp-sdk-s1.md`.

Non-goals: process supervision (P3-2), mock agent (P3-3), initialize / session (P3-4).

## 2. Prerequisites and parallel work

- Prerequisites: P1-1 (after P1-3 merges, attach the `cargo deny` result).
- Parallel: P2-*, P3-2, P3-3, P4-1, P5-1.

## 3. Files

New:

- `crates/agentdock-acp/Cargo.toml`
- `crates/agentdock-acp/src/lib.rs`
- `crates/agentdock-acp/src/framing.rs`
- `crates/agentdock-acp/tests/framing_stream.rs`
- `docs/research/acp-sdk-s1.md`

Modified: root `Cargo.toml` (members).

## 4. Public types and signatures

```rust
// crates/agentdock-acp/src/framing.rs
pub const DEFAULT_MAX_LINE_BYTES: usize = 16 * 1024 * 1024; // 16 MiB, same cap PR #25 verified

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FramingStats {
    pub lines: u64,
    pub replaced_invalid_utf8_bytes: u64, // bytes turned into U+FFFD
    pub empty_lines_skipped: u64,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FrameError {
    #[error("agent sent a line longer than {max} bytes; connection ended")]
    LineTooLong { max: usize },
}

/// Pure, incremental splitter (no I/O). Feed arbitrary chunks; get complete lines.
pub struct LineFramer { /* buf: Vec<u8>, max: usize, stats: FramingStats, failed: bool */ }
impl LineFramer {
    pub fn new(max_line_bytes: usize) -> Self;
    /// Returns complete lines found so far. After LineTooLong, every later call returns the same error.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, FrameError>;
    /// At EOF: returns the trailing partial line if non-empty (agents may omit the final '\n').
    pub fn finish(&mut self) -> Result<Option<String>, FrameError>;
    pub fn stats(&self) -> FramingStats;
}

/// Async adapter: reads `reader` with an 8 KiB buffer and yields lines for agent_client_protocol::Lines.
/// LineTooLong becomes io::Error(kind InvalidData) so the SDK ends the connection explicitly.
pub fn framed_lines<R>(reader: R, max_line_bytes: usize, stats: std::sync::Arc<std::sync::Mutex<FramingStats>>)
    -> impl futures::Stream<Item = std::io::Result<String>> + Send + 'static
where R: tokio::io::AsyncRead + Unpin + Send + 'static;

/// Outgoing side: a Sink<String> that writes each line + '\n' to `writer` and flushes.
pub fn line_sink<W>(writer: W) -> impl futures::Sink<String, Error = std::io::Error> + Send + 'static
where W: tokio::io::AsyncWrite + Unpin + Send + 'static;
```

Verified SDK interface (`agent-client-protocol` v5.5.1, `src/agent-client-protocol/src/jsonrpc.rs` lines 7410–7423):

```rust
impl<OutgoingSink, IncomingStream> Lines<OutgoingSink, IncomingStream>
where
    OutgoingSink: futures::Sink<String, Error = std::io::Error> + Send + 'static,
    IncomingStream: futures::Stream<Item = std::io::Result<String>> + Send + 'static,
{ pub fn new(outgoing: OutgoingSink, incoming: IncomingStream) -> Self }
```

Its docs say an `Err` from the incoming stream ends the connection, and a stream that decodes bytes itself should use replacement characters for invalid UTF-8 — matching this design.

## 5. Implementation steps

1. Pick the SDK version: check crates.io (`cargo search agent-client-protocol`). On 2026-11-22 it was `5.5.1`; every version since `5.4.0` contains #504 (`6a4a95ca`, confirmed `ahead` with `gh api repos/agentclientprotocol/rust-sdk/compare/6a4a95ca...v5.4.0`). Write `agent-client-protocol = { version = "=<version>", default-features = false }` and cite ADR-0002 line 99 and ADR-0004 "ACP crate version facts" in the PR.
2. Write the §6 tests.
3. Implement `LineFramer`:
   - Find `\n`; strip one trailing `\r`; empty lines count toward `empty_lines_skipped` and are not emitted.
   - When the buffered length (no `\n` yet) exceeds `max`, return `LineTooLong` immediately (not when `\n` arrives; otherwise a hostile agent grows memory without bound).
   - Decode with `String::from_utf8_lossy`; count replaced bytes by walking with `std::str::from_utf8`'s `Utf8Error::valid_up_to()` / `error_len()`.
4. `framed_lines` uses `futures::stream::unfold`; `line_sink` uses `futures::sink::unfold`.
5. S1: run and record in `docs/research/acp-sdk-s1.md`:
   - package count of `cargo tree -e normal -p agent-client-protocol --prefix none | sort -u`;
   - `cargo deny check licenses` (if P1-3 has merged and cargo-deny is available); otherwise write "not run" and why;
   - confirm neither `process` nor `stdio` feature is enabled (`cargo tree -e features -p agent-client-protocol`);
   - header with date, SDK version, Rust version, commands run.

## 6. Tests to write first

```rust
// #[cfg(test)] inside framing.rs
#[test] fn splits_across_chunks() {
    let mut f = LineFramer::new(1024);
    assert_eq!(f.push(b"{\"a\"").unwrap(), Vec::<String>::new());
    assert_eq!(f.push(b":1}\n{\"b\":2}\r\n").unwrap(), vec!["{\"a\":1}", "{\"b\":2}"]);
}
#[test] fn invalid_utf8_is_replaced_and_counted_not_fatal() {
    let mut f = LineFramer::new(1024);
    let out = f.push(b"{\"t\":\"\xff\xfe ok\"}\n").unwrap();
    assert_eq!(out, vec!["{\"t\":\"\u{FFFD}\u{FFFD} ok\"}"]);
    assert_eq!(f.stats().replaced_invalid_utf8_bytes, 2);
}
#[test] fn multibyte_char_split_between_chunks_is_not_corrupted() {
    let s = "測試\n".as_bytes();
    let mut f = LineFramer::new(1024);
    assert!(f.push(&s[..2]).unwrap().is_empty());
    assert_eq!(f.push(&s[2..]).unwrap(), vec!["測試"]);
    assert_eq!(f.stats().replaced_invalid_utf8_bytes, 0);
}
#[test] fn oversized_line_fails_before_newline_arrives() {
    let mut f = LineFramer::new(10);
    assert_eq!(f.push(&[b'x'; 11]), Err(FrameError::LineTooLong { max: 10 }));
    assert_eq!(f.push(b"\n"), Err(FrameError::LineTooLong { max: 10 })); // stays failed
}
#[test] fn exactly_max_is_allowed() {
    let mut f = LineFramer::new(10);
    assert_eq!(f.push(b"0123456789\n").unwrap(), vec!["0123456789"]);
}
#[test] fn empty_lines_skipped() {
    let mut f = LineFramer::new(10);
    assert_eq!(f.push(b"\n\r\n{}\n").unwrap(), vec!["{}"]);
    assert_eq!(f.stats().empty_lines_skipped, 2);
}
#[test] fn finish_returns_trailing_partial_line() {
    let mut f = LineFramer::new(10);
    f.push(b"{}").unwrap();
    assert_eq!(f.finish().unwrap(), Some("{}".to_string()));
}
#[test] fn non_json_line_is_passed_through() {
    // Framing does not parse JSON; the SDK answers a parse error and keeps the connection (ADR-0002 S3).
    let mut f = LineFramer::new(100);
    assert_eq!(f.push(b"not json at all\n").unwrap(), vec!["not json at all"]);
}
```

`tests/framing_stream.rs` (tokio):

| Test | How | Expected |
| --- | --- | --- |
| `stream_yields_lines_from_duplex` | `tokio::io::duplex`, write 3 lines, close | stream yields the 3 lines in order, then ends |
| `stream_turns_too_long_into_invalid_data` | write `max+1` bytes without newline | first item is `Err(kind == InvalidData)` |
| `stream_handles_64_mib_line_with_cap_16_mib` | write 64 MiB without newline (in batches) | `Err(InvalidData)`; bytes read before the error ≤ 16 MiB + 8 KiB (assert with a counting reader wrapper) |
| `sink_appends_newline_and_flushes` | send two strings into `line_sink` | peer reads `"a\nb\n"` |

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-acp                        # 12 tests pass
cargo tree -e features -p agent-client-protocol    # no `process` or `stdio` feature appears
```

No Windows-only items.

## 8. Spec references and porting sources

- ADR-0002 lines 15–16 (decisions 1, 2), line 31 (5.3.0 disconnects on non-UTF-8), lines 49–52 (facade framing decision), line 58 S1, line 65 S3, line 99 (pinning and upgrade rule).
- ADR-0004 "Effect on ADR-0002" (#504 is in every version since 5.4.0).
- `docs/contracts/events.md` line 101 (1 MiB per message and 8 MiB per turn are event-level limits; this packet's 16 MiB is the transport limit; P3-5 handles the event level).
- Behavior reference (Node draft, ideas only, do not port code): PR #25, SHA `7d41c9f1`, `apps/runtime/runtime.test.mjs` line 283 ("invalid UTF-8 and non-JSON lines do not end the connection; an oversized line ends it explicitly"); `docs/implementation/live-acp-runtime.md` line 16 (16 MiB cap).
- SDK `Lines` signature: rust-sdk tag `v5.5.1` (`34aea54f7314b42563b09112fe40b0cd5eb29b8a`) `src/agent-client-protocol/src/jsonrpc.rs` lines 7380–7423.

## 9. Dependencies

| Crate | Version | Status |
| --- | --- | --- |
| `agent-client-protocol` (`default-features = false`) | `=5.5.1` (or the newest version containing #504 at implementation time) | decided by ADR-0002; upgrades follow ADR-0002 §3 |
| `tokio` (`io-util`, `rt`; `macros` for tests) | 1.54.1 | needs audit |
| `futures` | latest 0.3.x | needs audit (the SDK already depends on it) |
| `thiserror` | 2.0.21 | needs audit |

## 10. Model tier

Standard model (pure function plus a small async wrapper).

## 11. Common mistakes and pitfalls

- `BufReader::lines()`: exactly why 5.3.0 disconnected (returns Err on non-UTF-8). Forbidden.
- Checking length only after finding `\n`: 1 GB without newline exhausts memory.
- Deriving the replacement count from `from_utf8_lossy` output length: wrong (U+FFFD is 3 bytes). Count as in §5.
- Enabling the SDK `process` feature "for convenience": ADR-0002 line 36 notes it only kills the direct child on Windows and pulls in the `async-process` / `async-io` runtime. Forbidden.
- Parsing JSON or dropping non-JSON lines in framing: the SDK answers a parse error and keeps the connection; framing must not decide that.

## 12. Reviewer checklist

- [ ] Is the SDK pinned with `=` and `default-features = false`, with no `process`/`stdio` feature in `cargo tree -e features`?
- [ ] Does the length check fire before a newline arrives, and does the framer stay failed afterwards?
- [ ] Is the replacement count computed from `Utf8Error`, not from output length?
- [ ] Does the 64 MiB test assert bounded reading?
- [ ] Does `docs/research/acp-sdk-s1.md` state date, versions and commands, and mark anything not run?
