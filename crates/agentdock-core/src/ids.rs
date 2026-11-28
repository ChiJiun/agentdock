//! Identifier newtypes (ADR-0003 section 1, `docs/contracts/README.md` "Naming rules").
//!
//! Every validator is hand-written (length + character set). There is no regex crate: the
//! patterns are tiny and fixed, and a hand-written check cannot backtrack. All checks work on
//! bytes and are anchored at both ends, so a trailing newline (which `$` would accept in some
//! regex dialects) is rejected.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A value failed the validation of the identifier type named by `kind`.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("invalid {kind} id: {value:?}")]
pub struct IdError {
    pub kind: &'static str,
    pub value: String,
}

/// Length of the ULID part of a prefixed id.
const ULID_LEN: usize = 26;

/// Crockford base32 as used by the contract: `0-9`, `A-H`, `J`, `K`, `M`, `N`, `P-T`, `V-Z`
/// (no `I`, `L`, `O`, `U`, no lowercase).
fn is_crockford(b: u8) -> bool {
    matches!(b, b'0'..=b'9' | b'A'..=b'H' | b'J' | b'K' | b'M' | b'N' | b'P'..=b'T' | b'V'..=b'Z')
}

/// `^<prefix>_[0-9A-HJKMNP-TV-Z]{26}$`
fn is_prefixed_ulid(s: &str, prefix: &str) -> bool {
    let b = s.as_bytes();
    let head = prefix.len() + 1;
    b.len() == head + ULID_LEN
        && b.starts_with(prefix.as_bytes())
        && b[prefix.len()] == b'_'
        && b[head..].iter().copied().all(is_crockford)
}

fn is_lower_alnum(b: u8) -> bool {
    matches!(b, b'a'..=b'z' | b'0'..=b'9')
}

/// `^(local|remote:[a-z0-9][a-z0-9-]{0,47})$`
fn is_authority_id(s: &str) -> bool {
    if s == "local" {
        return true;
    }
    match s.strip_prefix("remote:") {
        Some(name) => {
            let b = name.as_bytes();
            (1..=48).contains(&b.len())
                && is_lower_alnum(b[0])
                && b[1..].iter().all(|&c| is_lower_alnum(c) || c == b'-')
        }
        None => false,
    }
}

/// `^[a-z0-9][a-z0-9_.-]{0,63}$`
fn is_adapter_id(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=64).contains(&b.len())
        && is_lower_alnum(b[0])
        && b[1..]
            .iter()
            .all(|&c| is_lower_alnum(c) || matches!(c, b'_' | b'.' | b'-'))
}

fn is_lower_hex(b: u8) -> bool {
    matches!(b, b'0'..=b'9' | b'a'..=b'f')
}

/// `^[0-9a-f]{40}([0-9a-f]{24})?$` (SHA-1 or SHA-256 git object id)
fn is_git_sha(s: &str) -> bool {
    matches!(s.len(), 40 | 64) && s.bytes().all(is_lower_hex)
}

/// `^[0-9a-f]{64}$`
fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(is_lower_hex)
}

/// Defines a validated string newtype: `parse`, `as_str`, `Display`, `Serialize` (as a string) and
/// `Deserialize` (through `parse`, so invalid values are rejected on read).
macro_rules! define_validated {
    ($(#[$meta:meta])* $name:ident, $kind:expr, $check:expr) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(String);

        impl $name {
            /// Validates `s` and wraps it. The whole string must match; there is no trimming.
            pub fn parse(s: &str) -> Result<Self, IdError> {
                let check: fn(&str) -> bool = $check;
                if check(s) {
                    Ok(Self(s.to_owned()))
                } else {
                    Err(IdError { kind: $kind, value: s.to_owned() })
                }
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let s = String::deserialize(deserializer)?;
                Self::parse(&s).map_err(serde::de::Error::custom)
            }
        }
    };
}

/// Defines a prefixed-ULID id newtype with `generate()` on top of [`define_validated!`].
macro_rules! define_id {
    ($name:ident, $prefix:literal) => {
        define_validated!(
            #[doc = concat!("`", $prefix, "_` + 26 Crockford base32 characters.")]
            $name,
            $prefix,
            |s| is_prefixed_ulid(s, $prefix)
        );

        impl $name {
            /// A fresh id: the prefix followed by a new ULID.
            pub fn generate() -> Self {
                Self(format!("{}_{}", $prefix, ulid::Ulid::generate()))
            }
        }
    };
}

define_id!(ProjectId, "prj");
define_id!(TaskId, "tsk");
define_id!(SessionId, "ses");
define_id!(EventId, "evt");
define_id!(ApprovalId, "apr");
define_id!(OperationId, "op");
define_id!(CheckId, "chk");
define_id!(UsageId, "use");
define_id!(SummaryId, "sum");
define_id!(CheckpointId, "cpt");
define_id!(TurnId, "trn");

define_validated!(
    /// `local`, or `remote:<name>` with `<name>` matching `^[a-z0-9][a-z0-9-]{0,47}$`.
    AuthorityId,
    "authority",
    is_authority_id
);

impl AuthorityId {
    /// The local authority.
    pub fn local() -> Self {
        Self("local".to_owned())
    }
}

define_validated!(
    /// Adapter identifier, `^[a-z0-9][a-z0-9_.-]{0,63}$`.
    AdapterId,
    "adapter",
    is_adapter_id
);

define_validated!(
    /// Git object id: 40 (SHA-1) or 64 (SHA-256) lowercase hex characters.
    GitSha,
    "git sha",
    is_git_sha
);

define_validated!(
    /// Lowercase hex sha256 digest (64 characters).
    Sha256Hex,
    "sha256",
    is_sha256_hex
);

impl Sha256Hex {
    /// Hex-encodes a raw digest. Always valid by construction.
    pub(crate) fn from_digest(digest: &[u8]) -> Self {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let mut out = String::with_capacity(digest.len() * 2);
        for &byte in digest {
            out.push(char::from(HEX[usize::from(byte >> 4)]));
            out.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
        Self(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    const TASK: &str = "tsk_01JDQ001000000000000000001";

    #[test]
    fn id_accepts_contract_example() {
        let id = TaskId::parse(TASK).unwrap();
        assert_eq!(id.as_str(), TASK);
        assert_eq!(id.to_string(), TASK);
    }

    #[test]
    fn id_rejects_trailing_newline() {
        // contract mutation e7_trailing_newline_id
        let err = TaskId::parse("tsk_01JDQ001000000000000000001\n").unwrap_err();
        assert_eq!(err.kind, "tsk");
    }

    #[test]
    fn id_rejects_forbidden_letters() {
        for bad in ['I', 'L', 'O', 'U', 'a', 'z'] {
            let s = format!("tsk_01JDQ00100000000000000000{bad}");
            assert_eq!(s.len(), 30);
            assert!(TaskId::parse(&s).is_err(), "{s} must be rejected");
        }
    }

    #[test]
    fn id_rejects_wrong_prefix_length_and_whitespace() {
        assert!(TaskId::parse("ses_01JDQ001000000000000000001").is_err());
        assert!(TaskId::parse("TSK_01JDQ001000000000000000001").is_err());
        assert!(TaskId::parse("tsk-01JDQ001000000000000000001").is_err());
        assert!(TaskId::parse("tsk_01JDQ00100000000000000000").is_err());
        assert!(TaskId::parse("tsk_01JDQ0010000000000000000012").is_err());
        assert!(TaskId::parse(" tsk_01JDQ001000000000000000001").is_err());
        assert!(TaskId::parse("").is_err());
        // Multi-byte characters must not slip through a length check made on chars.
        assert!(TaskId::parse("tsk_01JDQ00100000000000000000é").is_err());
    }

    #[test]
    fn op_prefix_is_two_letters() {
        assert!(OperationId::parse("op_01JDQ001000000000000000001").is_ok());
        assert!(OperationId::parse("opx_01JDQ00100000000000000000").is_err());
    }

    #[test]
    fn generated_ids_parse() {
        let mut seen = HashSet::new();
        for _ in 0..1000 {
            let id = TaskId::generate();
            assert_eq!(TaskId::parse(id.as_str()).unwrap(), id);
            assert!(seen.insert(id));
        }
    }

    #[test]
    fn every_generator_uses_its_prefix() {
        assert!(ProjectId::generate().as_str().starts_with("prj_"));
        assert!(SessionId::generate().as_str().starts_with("ses_"));
        assert!(EventId::generate().as_str().starts_with("evt_"));
        assert!(ApprovalId::generate().as_str().starts_with("apr_"));
        assert!(OperationId::generate().as_str().starts_with("op_"));
        assert!(CheckId::generate().as_str().starts_with("chk_"));
        assert!(UsageId::generate().as_str().starts_with("use_"));
        assert!(SummaryId::generate().as_str().starts_with("sum_"));
        assert!(CheckpointId::generate().as_str().starts_with("cpt_"));
        assert!(TurnId::generate().as_str().starts_with("trn_"));
    }

    #[test]
    fn serde_roundtrip_and_rejection() {
        let id = TaskId::parse(TASK).unwrap();
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, format!("\"{TASK}\""));
        assert_eq!(serde_json::from_str::<TaskId>(&json).unwrap(), id);
        assert!(serde_json::from_str::<TaskId>("\"tsk_bad\"").is_err());
        assert!(serde_json::from_str::<TaskId>("42").is_err());
    }

    #[test]
    fn authority_id_rules() {
        assert_eq!(AuthorityId::local().as_str(), "local");
        assert!(AuthorityId::parse("local").is_ok());
        assert!(AuthorityId::parse("remote:build-box-1").is_ok());
        assert!(AuthorityId::parse(&format!("remote:{}", "a".repeat(48))).is_ok());
        assert!(AuthorityId::parse(&format!("remote:{}", "a".repeat(49))).is_err());
        for bad in [
            "",
            "remote:",
            "remote:-x",
            "remote:Box",
            "remote:a_b",
            "Local",
            "local\n",
            "remote:a\n",
            "remote",
        ] {
            assert!(AuthorityId::parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn adapter_id_rules() {
        assert!(AdapterId::parse("claude-code").is_ok());
        assert!(AdapterId::parse("a").is_ok());
        assert!(AdapterId::parse("codex_acp.v1").is_ok());
        assert!(AdapterId::parse(&"a".repeat(64)).is_ok());
        assert!(AdapterId::parse(&"a".repeat(65)).is_err());
        for bad in ["", "-a", "_a", ".a", "A", "a b", "a\n", "é"] {
            assert!(AdapterId::parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn git_sha_and_sha256_rules() {
        assert!(GitSha::parse(&"a".repeat(40)).is_ok());
        assert!(GitSha::parse(&"a".repeat(64)).is_ok());
        assert!(GitSha::parse(&"a".repeat(41)).is_err());
        assert!(GitSha::parse(&"A".repeat(40)).is_err());
        assert!(GitSha::parse(&format!("{}\n", "a".repeat(40))).is_err());
        assert!(Sha256Hex::parse(&"0".repeat(64)).is_ok());
        assert!(Sha256Hex::parse(&"0".repeat(40)).is_err());
        assert!(Sha256Hex::parse(&"g".repeat(64)).is_err());
    }

    #[test]
    fn from_digest_is_lowercase_hex() {
        let hex = Sha256Hex::from_digest(&[0x00, 0x0f, 0xa0, 0xff].repeat(8));
        assert_eq!(hex.as_str(), "000fa0ff".repeat(8));
        assert!(Sha256Hex::parse(hex.as_str()).is_ok());
    }
}
