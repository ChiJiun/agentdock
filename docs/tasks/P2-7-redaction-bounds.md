# P2-7: Redaction before write, and text length bounds

> **繁中摘要**：在 `agentdock-core` 提供純函式 redaction，所有外部來源文字寫入事件前都要經過：API key／GitHub token 形狀、`Authorization`／`Cookie` header、私鑰區塊、呼叫端給的已知秘密值（長度 ≥ 8），以及家目錄路徑泛化為 `~`。被遮蔽片段換成 `[REDACTED:<rule>]` 並回傳規則清單；單一文字欄位上限 65,536 字元（以字元計）；用保證線性時間的 `regex` crate，惡意輸入要在 2 秒內完成。模型等級：一般模型可（規則表請強模型審查）。

Issues: #7, #8 | Gate (#51): G3, G2 (test logs do not leak secrets) | Model tier: **standard model** (strong-model review of the rule table)

## 1. Goal and non-goals

Goal: pure-function redaction in `agentdock-core`, applied to every externally sourced text before it is written to the store and sent to subscribers:

- Rules: API key / token shapes, `Authorization` / `Cookie` headers, private key blocks, caller-provided known secret values (e.g. auth environment variable values passed to an adapter), home directory generalization (`home_path`).
- Redacted fragments become `[REDACTED:<rule>]`; the list of triggered rules is returned (goes into the envelope's `redaction.applied_rules`).
- Length bound: one text field ≤ 65,536 characters (schema `RedactedText.maxLength`); longer text is truncated with a marker.
- Linear time: 1 MiB of input finishes within a fixed budget (spirit of ADR-0002 APR-3: no backtracking regexes on policy/ingestion paths).

Non-goals: per-turn output limits and coalescing (P3-5), writing raw tool I/O as artifacts (P3-5), stripping ACP `_meta` (P2-2 snapshot rules and P3-4).

## 2. Prerequisites and parallel work

- Prerequisites: P2-1.
- Parallel: everything after P2-2. P3-5 calls this packet.

## 3. Files

New:

- `crates/agentdock-core/src/redact.rs`
- `crates/agentdock-core/tests/redact_adversarial.rs`

Modified: `crates/agentdock-core/src/lib.rs`, `crates/agentdock-core/Cargo.toml`.

## 4. Public types and signatures

```rust
pub const REDACTION_POLICY_VERSION: u32 = 1;
pub const MAX_TEXT_CHARS: usize = 65_536;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum RedactionRule { ApiKey, GithubToken, AuthHeader, PrivateKey, KnownSecret, HomePath, Truncated }
impl RedactionRule { pub fn as_str(self) -> &'static str; } // "api_key", "github_token", "auth_header", "private_key", "known_secret", "home_path", "truncated"

pub struct Redactor { /* compiled patterns, known secrets (>= 8 chars only), home dir variants */ }

impl Redactor {
    /// known_secrets: values to scrub verbatim (values shorter than 8 chars are ignored to avoid
    /// redacting common words). home_dirs: e.g. ["C:\\Users\\alice", "/home/alice"]; Windows-form paths match case-insensitively.
    pub fn new(known_secrets: &[String], home_dirs: &[PathBuf]) -> Self;
    pub fn redact_text(&self, input: &str) -> Redacted<String>;
    /// Walks every string value in a JSON tree (keys are left as-is) and redacts it.
    pub fn redact_json(&self, value: &serde_json::Value) -> Redacted<serde_json::Value>;
}

#[derive(Debug, Clone, PartialEq)]
pub struct Redacted<T> { pub value: T, pub applied: std::collections::BTreeSet<RedactionRule> }

/// Truncate to max_chars (by char, not byte) and append "…[truncated N chars]".
pub fn bound_text(input: &str, max_chars: usize) -> (String, bool);
```

Rules (version 1; later versions may only get stricter, bumping `REDACTION_POLICY_VERSION`):

| Rule | Match | Notes |
| --- | --- | --- |
| `api_key` | `sk-[A-Za-z0-9_-]{20,}`, `sk-ant-[A-Za-z0-9_-]{20,}`, `AKIA[0-9A-Z]{16}`, `xox[abprs]-[A-Za-z0-9-]{10,}`, `AIza[0-9A-Za-z_-]{35}` | redact the token only |
| `github_token` | `gh[pousr]_[A-Za-z0-9]{36,}`, `github_pat_[A-Za-z0-9_]{22,}` | |
| `auth_header` | case-insensitive `authorization:`, `proxy-authorization:`, `cookie:`, `set-cookie:` up to end of line; `Bearer <token>` | keep the header name, redact the value |
| `private_key` | `-----BEGIN [A-Z ]*PRIVATE KEY-----` through the matching `END` line (multi-line); without `END`, to end of string | |
| `known_secret` | caller values, verbatim (length ≥ 8) | Aho-Corasick or a `regex` alternation (both linear) |
| `home_path` | home prefix becomes `~` (e.g. `C:\Users\alice\repo` → `~\repo`) | generalization only, no `[REDACTED]` |

## 5. Implementation steps

1. Write the §6 tests.
2. Use the `regex` crate (guaranteed linear time, no backtracking); compile once in `Redactor::new`.
3. Handle `private_key` (multi-line) first, then the others; replace from the end backwards to avoid offset errors.
4. `redact_json` recursion depth limit 128; deeper subtrees become the string `"[REDACTED:truncated]"` and record `Truncated` (avoids debug-build stack overflow on 1 MB inputs, ADR-0002 X-2).
5. Export from `lib.rs`. P2-4's `Tx::append` does **not** call it automatically (redaction needs the caller's known secrets); P3-5 and P8 write paths call it. Document on `Redactor`: "every externally sourced text must pass through this before it is written to an event".

## 6. Tests to write first

```rust
// crates/agentdock-core/tests/redact_adversarial.rs
use agentdock_core::redact::*;
use std::time::{Duration, Instant};

fn r() -> Redactor {
    Redactor::new(&["s3cr3t-value-123".into()], &[r"C:\Users\alice".into(), "/home/alice".into()])
}

#[test]
fn github_token_is_removed_and_rule_recorded() {
    let tok = format!("ghp_{}", "0".repeat(36));
    let out = r().redact_text(&format!("push with {tok} now"));
    assert_eq!(out.value, "push with [REDACTED:github_token] now");
    assert!(out.applied.contains(&RedactionRule::GithubToken));
}

#[test]
fn authorization_header_value_removed_case_insensitive() {
    let out = r().redact_text("AUTHORIZATION: Bearer abc.def.ghi\nnext line");
    assert_eq!(out.value, "AUTHORIZATION: [REDACTED:auth_header]\nnext line");
}

#[test]
fn private_key_block_removed_even_without_end() {
    let out = r().redact_text("x\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB");
    assert_eq!(out.value, "x\n[REDACTED:private_key]");
}

#[test]
fn known_secret_removed_inside_json_values_not_keys() {
    let v = serde_json::json!({"s3cr3t-value-123": "token=s3cr3t-value-123;"});
    let out = r().redact_json(&v);
    assert_eq!(out.value, serde_json::json!({"s3cr3t-value-123": "token=[REDACTED:known_secret];"}));
}

#[test]
fn short_known_secret_is_ignored() {
    let red = Redactor::new(&["abc".into()], &[]);
    assert_eq!(red.redact_text("abc abc").value, "abc abc");
}

#[test]
fn home_path_generalized_case_insensitive_on_windows_form() {
    let out = r().redact_text(r"opened c:\users\ALICE\repo\a.rs");
    assert_eq!(out.value, r"opened ~\repo\a.rs");
    assert!(out.applied.contains(&RedactionRule::HomePath));
}

#[test]
fn home_path_generalized_unix_form() {
    let out = r().redact_text("opened /home/alice/repo/a.rs");
    assert_eq!(out.value, "opened ~/repo/a.rs");
}

#[test]
fn hostile_input_finishes_within_budget() {
    // APR-3 style: long near-matches must not cause super-linear time.
    let s = format!("{}{}", "ghp_".repeat(200_000), "sk-".repeat(100_000));
    let t = Instant::now();
    let _ = r().redact_text(&s);
    assert!(t.elapsed() < Duration::from_secs(2), "took {:?}", t.elapsed());
}

#[test]
fn deep_json_does_not_overflow_stack() {
    let mut v = serde_json::json!("leaf");
    for _ in 0..10_000 { v = serde_json::json!([v]); }
    let out = r().redact_json(&v);
    assert!(out.applied.contains(&RedactionRule::Truncated));
}

#[test]
fn bound_text_counts_chars_not_bytes() {
    let (s, cut) = bound_text(&"測".repeat(70_000), MAX_TEXT_CHARS);
    assert!(cut);
    assert!(s.starts_with(&"測".repeat(MAX_TEXT_CHARS)));
    assert!(s.ends_with("…[truncated 4464 chars]"));
}

#[test]
fn already_redacted_marker_is_stable() {
    let once = r().redact_text(&format!("ghp_{}", "1".repeat(40))).value;
    let twice = r().redact_text(&once).value;
    assert_eq!(once, twice);
}
```

Note: building a 10,000-level `serde_json::Value` may itself recurse on drop. If the test overflows during drop, use 2,000 levels and say so in the PR.

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-core redact             # 11 pass
cargo test -p agentdock-core redact --release   # the time-budget test also passes in release
```

No Windows-only items.

## 8. Spec references and porting sources

All line numbers refer to main `c9e33cf`.

- `docs/contracts/events.md` lines 115–124 "Redaction" (never-stored items, `[REDACTED:<rule>]`, `applied_rules`, `home_path`, `policy_version` only stricter).
- ADR-0003 §4 last bullet.
- ADR-0002 line 123 APR-3 (no backtracking regexes, fixed time budget), line 175 X-2 (debug stack).
- Issue #7 Requirement 5; Issue #6 Acceptance "test logs redact secrets"; Issue #8 "Account/SSH/API tokens are not logged".
- Behavior reference (Node draft, ideas only, do not port code): PR #25, SHA `7d41c9f1`, `apps/runtime/store.mjs` line 10 `protect()` (string cap 16,000, event cap 48,000, `[REDACTED]` marker; this packet uses the contract's 65,536 cap and rule names instead).

## 9. Dependencies

| Crate | Version | Status |
| --- | --- | --- |
| `regex` | latest 1.x | needs audit (chosen because it guarantees linear time) |
| `aho-corasick` (optional, if `regex` is not used for known secrets) | latest 1.x | needs audit |

## 10. Model tier

Standard model. The rule table and "nothing slips through" are security items; a strong model should review rules and tests.

## 11. Common mistakes and pitfalls

- Redacting only fields whose key looks secret (e.g. `"token": ...`): not enough; values appear in arbitrary text. Scan everything.
- Redacting serialized JSON and deserializing again: escapes (`\"`) break matching. Always work string by string on the `Value` tree.
- Truncating UTF-8 by bytes: breaks characters. Use `char_indices`.
- Streaming chunks: a secret can straddle two chunks. P3-5's coalescing must keep the tail of the previous chunk (at least 256 characters) in the scan; these functions are single-chunk; document that limit.
- Redaction is not perfect secret detection (PR #25's own docs, line 92, admit it); UI and docs must never claim "all secrets removed".

## 12. Reviewer checklist

- [ ] Does every rule in the table have a positive test, and do header names survive while values are redacted?
- [ ] Is the `regex` crate used (no `fancy-regex` or backtracking engine)?
- [ ] Does `bound_text` count characters and produce the exact marker?
- [ ] Are JSON keys left untouched and every string value scanned?
- [ ] Is the chunk-boundary limitation documented for P3-5?
