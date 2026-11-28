//! Redaction before write, and text length bounds (P2-7).
//!
//! Every externally sourced text must pass through [`Redactor`] before it is written to an event
//! or sent to a subscriber (`docs/contracts/events.md`, "Redaction"). All matching uses the
//! `regex` crate, which guarantees linear-time matching (no backtracking; ADR-0002 APR-3).
//!
//! Limits, to be repeated in any UI or doc that mentions this module:
//!
//! - Redaction is best-effort pattern matching, not perfect secret detection. Never claim that
//!   "all secrets were removed".
//! - [`Redactor::redact_text`] and [`Redactor::redact_json`] are single-chunk functions. A secret
//!   that straddles two streamed chunks is not seen by either call. Callers that coalesce a
//!   stream (P3-5) must keep at least 256 characters of the previous chunk's tail in the scanned
//!   window.
//! - Redacting already redacted text is stable, except that text which was truncated once and is
//!   still longer than [`MAX_TEXT_CHARS`] (marker included) is truncated again.

use std::borrow::Cow;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::LazyLock;

use regex::{Regex, RegexBuilder};

/// Version of the rule table below. Later versions may only get stricter.
pub const REDACTION_POLICY_VERSION: u32 = 1;
/// Maximum number of characters (not bytes) of one text field (`RedactedText.maxLength`).
pub const MAX_TEXT_CHARS: usize = 65_536;
/// Maximum JSON nesting depth that is walked; deeper subtrees are replaced (ADR-0002 X-2).
pub const MAX_JSON_DEPTH: usize = 128;
/// Known secrets shorter than this are ignored so common words are not redacted.
pub const MIN_KNOWN_SECRET_LEN: usize = 8;

const TRUNCATED_MARKER: &str = "[REDACTED:truncated]";

/// A redaction rule that can appear in `redaction.applied_rules`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum RedactionRule {
    ApiKey,
    GithubToken,
    AuthHeader,
    PrivateKey,
    KnownSecret,
    HomePath,
    Truncated,
}

impl RedactionRule {
    /// Stable rule name used in `[REDACTED:<rule>]` and `applied_rules`.
    pub fn as_str(self) -> &'static str {
        match self {
            RedactionRule::ApiKey => "api_key",
            RedactionRule::GithubToken => "github_token",
            RedactionRule::AuthHeader => "auth_header",
            RedactionRule::PrivateKey => "private_key",
            RedactionRule::KnownSecret => "known_secret",
            RedactionRule::HomePath => "home_path",
            RedactionRule::Truncated => "truncated",
        }
    }
}

/// A redacted value plus the set of rules that fired.
#[derive(Debug, Clone, PartialEq)]
pub struct Redacted<T> {
    pub value: T,
    pub applied: BTreeSet<RedactionRule>,
}

/// Rule table version 1. Review this table first: it is the security-relevant part.
struct Patterns {
    /// `-----BEGIN ... PRIVATE KEY-----` through the matching END line, or to end of string.
    private_key: Regex,
    /// Header name is kept (group 1), the rest of the line is redacted.
    auth_header: Regex,
    /// `Bearer <token>`; the word is kept (group 1).
    bearer: Regex,
    github_token: Regex,
    api_key: Regex,
}

// The patterns are compile-time constants and are exercised by the unit tests below, so a failure
// to compile them is a programming error caught in CI, not a runtime condition.
#[allow(clippy::expect_used)]
fn compile(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static redaction pattern must compile")
}

static PATTERNS: LazyLock<Patterns> = LazyLock::new(|| Patterns {
    private_key: compile(
        r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|\z)",
    ),
    auth_header: compile(
        r"(?im)(\b(?:proxy-authorization|authorization|set-cookie|cookie)[ \t]*:[ \t]*)[^\r\n]+",
    ),
    bearer: compile(r"(?i)(\bBearer[ \t]+)[A-Za-z0-9._~+/=-]{8,}"),
    github_token: compile(r"gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}"),
    // `sk-ant-...` is covered by the `sk-` alternative because `-` is in its character class.
    api_key: compile(
        r"sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}",
    ),
});

/// Scrubs secrets, home directories and over-long text from externally sourced text.
///
/// Every externally sourced text must pass through this before it is written to an event.
/// See the module documentation for the single-chunk limit and the "best effort" caveat.
pub struct Redactor {
    known_re: Option<Regex>,
    /// Used only if the combined known-secret regex could not be built (fail closed).
    known_secrets: Vec<String>,
    home_re: Option<Regex>,
}

impl std::fmt::Debug for Redactor {
    // Never print the secrets this value holds.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Redactor")
            .field("known_secrets", &self.known_secrets.len())
            .field("home_dirs", &self.home_re.is_some())
            .finish()
    }
}

impl Redactor {
    /// `known_secrets`: values to scrub verbatim (values shorter than 8 characters are ignored to
    /// avoid redacting common words). `home_dirs`: e.g. `["C:\\Users\\alice", "/home/alice"]`;
    /// Windows-form paths match case-insensitively and accept `\` or `/` as separator.
    pub fn new(known_secrets: &[String], home_dirs: &[PathBuf]) -> Self {
        let mut secrets: Vec<String> = known_secrets
            .iter()
            .filter(|s| s.chars().count() >= MIN_KNOWN_SECRET_LEN)
            .cloned()
            .collect();
        // Longest first so the leftmost-first alternation prefers the longest secret.
        secrets.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        secrets.dedup();

        let known_re = if secrets.is_empty() {
            None
        } else {
            let alt = secrets
                .iter()
                .map(|s| regex::escape(s))
                .collect::<Vec<_>>()
                .join("|");
            RegexBuilder::new(&alt).size_limit(64 << 20).build().ok()
        };

        Self {
            known_re,
            known_secrets: secrets,
            home_re: build_home_regex(home_dirs),
        }
    }

    /// Redacts one text field, then bounds it to [`MAX_TEXT_CHARS`] characters.
    ///
    /// Redaction runs on the full text before truncation, so a secret that crosses the cut point
    /// is removed instead of being left half visible.
    pub fn redact_text(&self, input: &str) -> Redacted<String> {
        let mut applied = BTreeSet::new();
        let mut text = input.to_owned();
        let p = &*PATTERNS;

        // Multi-line private keys first so later rules do not see their body.
        apply(
            &p.private_key,
            &mut text,
            "[REDACTED:private_key]",
            RedactionRule::PrivateKey,
            &mut applied,
        );
        apply(
            &p.auth_header,
            &mut text,
            "${1}[REDACTED:auth_header]",
            RedactionRule::AuthHeader,
            &mut applied,
        );
        apply(
            &p.bearer,
            &mut text,
            "${1}[REDACTED:auth_header]",
            RedactionRule::AuthHeader,
            &mut applied,
        );
        self.apply_known(&mut text, &mut applied);
        apply(
            &p.github_token,
            &mut text,
            "[REDACTED:github_token]",
            RedactionRule::GithubToken,
            &mut applied,
        );
        apply(
            &p.api_key,
            &mut text,
            "[REDACTED:api_key]",
            RedactionRule::ApiKey,
            &mut applied,
        );
        if let Some(home) = &self.home_re {
            apply(
                home,
                &mut text,
                "~${tail}",
                RedactionRule::HomePath,
                &mut applied,
            );
        }

        let (value, cut) = bound_text(&text, MAX_TEXT_CHARS);
        if cut {
            applied.insert(RedactionRule::Truncated);
        }
        Redacted { value, applied }
    }

    /// Walks every string value in a JSON tree (keys are left as-is) and redacts it. Subtrees
    /// nested deeper than [`MAX_JSON_DEPTH`] become the string `"[REDACTED:truncated]"`.
    pub fn redact_json(&self, value: &serde_json::Value) -> Redacted<serde_json::Value> {
        let mut applied = BTreeSet::new();
        let value = self.walk(value, 0, &mut applied);
        Redacted { value, applied }
    }

    fn walk(
        &self,
        value: &serde_json::Value,
        depth: usize,
        applied: &mut BTreeSet<RedactionRule>,
    ) -> serde_json::Value {
        use serde_json::Value;
        if depth > MAX_JSON_DEPTH {
            applied.insert(RedactionRule::Truncated);
            return Value::String(TRUNCATED_MARKER.to_owned());
        }
        match value {
            Value::String(s) => {
                let out = self.redact_text(s);
                applied.extend(out.applied);
                Value::String(out.value)
            }
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .map(|v| self.walk(v, depth + 1, applied))
                    .collect(),
            ),
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(k, v)| (k.clone(), self.walk(v, depth + 1, applied)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    fn apply_known(&self, text: &mut String, applied: &mut BTreeSet<RedactionRule>) {
        const MARKER: &str = "[REDACTED:known_secret]";
        if let Some(re) = &self.known_re {
            apply(re, text, MARKER, RedactionRule::KnownSecret, applied);
        } else {
            // Fail closed: plain substring replacement if the combined regex was not built.
            for secret in &self.known_secrets {
                if text.contains(secret.as_str()) {
                    *text = text.replace(secret.as_str(), MARKER);
                    applied.insert(RedactionRule::KnownSecret);
                }
            }
        }
    }
}

fn apply(
    re: &Regex,
    text: &mut String,
    replacement: &str,
    rule: RedactionRule,
    applied: &mut BTreeSet<RedactionRule>,
) {
    let replaced = match re.replace_all(text.as_str(), replacement) {
        Cow::Owned(s) => Some(s),
        Cow::Borrowed(_) => None,
    };
    if let Some(s) = replaced {
        *text = s;
        applied.insert(rule);
    }
}

/// One alternative per home directory. A match must end at a path separator, end of text or any
/// other non-name character, so `/home/alice2` is not treated as `/home/alice`.
fn build_home_regex(home_dirs: &[PathBuf]) -> Option<Regex> {
    let mut alts: Vec<String> = Vec::new();
    for dir in home_dirs {
        let raw = dir.to_string_lossy();
        let trimmed = raw.trim_end_matches(['\\', '/']);
        if trimmed.is_empty() {
            continue;
        }
        let windows_form = trimmed.contains('\\') || trimmed.chars().nth(1) == Some(':');
        if windows_form {
            let body = trimmed
                .split(['\\', '/'])
                .map(regex::escape)
                .collect::<Vec<_>>()
                .join(r"[\\/]");
            alts.push(format!("(?i:{body})"));
        } else {
            alts.push(regex::escape(trimmed));
        }
    }
    if alts.is_empty() {
        return None;
    }
    alts.sort();
    alts.dedup();
    let pattern = format!("(?:{})(?P<tail>$|[^A-Za-z0-9_-])", alts.join("|"));
    RegexBuilder::new(&pattern)
        .size_limit(64 << 20)
        .build()
        .ok()
}

/// Truncates to `max_chars` characters (not bytes) and appends `…[truncated N chars]`, where N is
/// the number of characters removed. Returns the text and whether it was cut.
pub fn bound_text(input: &str, max_chars: usize) -> (String, bool) {
    match input.char_indices().nth(max_chars) {
        None => (input.to_owned(), false),
        Some((byte, _)) => {
            let kept = input.get(..byte).unwrap_or_default();
            let removed = input.get(byte..).unwrap_or_default().chars().count();
            (format!("{kept}…[truncated {removed} chars]"), true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_patterns_compile() {
        let _ = Redactor::new(&[], &[]).redact_text("");
    }

    #[test]
    fn rule_names_are_stable() {
        assert_eq!(RedactionRule::ApiKey.as_str(), "api_key");
        assert_eq!(RedactionRule::GithubToken.as_str(), "github_token");
        assert_eq!(RedactionRule::AuthHeader.as_str(), "auth_header");
        assert_eq!(RedactionRule::PrivateKey.as_str(), "private_key");
        assert_eq!(RedactionRule::KnownSecret.as_str(), "known_secret");
        assert_eq!(RedactionRule::HomePath.as_str(), "home_path");
        assert_eq!(RedactionRule::Truncated.as_str(), "truncated");
    }

    #[test]
    fn bound_text_keeps_short_text_and_splits_on_char_boundary() {
        assert_eq!(bound_text("abc", 3), ("abc".to_owned(), false));
        let (s, cut) = bound_text("測試abc", 1);
        assert!(cut);
        assert_eq!(s, "測…[truncated 4 chars]");
    }

    #[test]
    fn debug_does_not_leak_secrets() {
        let r = Redactor::new(&["sk-test-FAKE-0123456789".into()], &[]);
        assert!(!format!("{r:?}").contains("FAKE"));
    }
}
