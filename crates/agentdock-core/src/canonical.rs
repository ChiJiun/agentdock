//! Canonical JSON and the hashes built on it (idempotency keys, approval fingerprints).
//!
//! The output must be byte-identical to Python
//! `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)` as used by
//! `docs/contracts/validate_fixtures.py` (`canonical_sha256`). `serde_json::to_string` is
//! deliberately not used: its key order depends on the `preserve_order` feature of whichever
//! crate in the build enabled it, so a hash must never depend on it.

use std::collections::BTreeMap;

use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

use crate::ids::Sha256Hex;

/// Nesting limit of the recursive writer. Equal to `serde_json`'s own parse limit, so every
/// value that was read from text fits; it protects the 1 MiB debug-build main-thread stack
/// (CONVENTIONS section 7) against programmatically built, absurdly deep values.
pub const MAX_DEPTH: usize = 128;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CanonicalError {
    #[error("floating point numbers are not allowed in canonical JSON")]
    Float,
    #[error("JSON nesting deeper than 128 levels is not allowed in canonical JSON")]
    TooDeep,
}

/// Canonical JSON text: object keys sorted by code point (equal to UTF-8 byte order), no
/// insignificant whitespace, UTF-8, non-ASCII not escaped, integers as-is. Floats are rejected.
pub fn canonical_json(value: &Value) -> Result<String, CanonicalError> {
    let mut out = String::new();
    write_value(&mut out, value, 0)?;
    Ok(out)
}

/// Lowercase hex sha256 of [`canonical_json`] (UTF-8 bytes).
pub fn canonical_sha256(value: &Value) -> Result<Sha256Hex, CanonicalError> {
    Ok(sha256_of(canonical_json(value)?.as_bytes()))
}

/// `canonical_sha256({"kind": kind, "identity": target minus "description"})`.
/// Only a top-level `description` is dropped, exactly like `operation_identity` in the validator.
pub fn idempotency_key(
    kind: &str,
    target: &Map<String, Value>,
) -> Result<Sha256Hex, CanonicalError> {
    let identity: Map<String, Value> = target
        .iter()
        .filter(|(key, _)| key.as_str() != "description")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let mut doc = Map::new();
    doc.insert("kind".to_owned(), Value::String(kind.to_owned()));
    doc.insert("identity".to_owned(), Value::Object(identity));
    canonical_sha256(&Value::Object(doc))
}

/// ACP permission fingerprint:
/// `canonical_sha256({"kind":"tool_call","target":{"tool_call_id":..,"title":..}})`.
/// Both inputs are strings, so this cannot fail; the text is assembled directly (keys already in
/// sorted order: `kind` < `target`, `title` < `tool_call_id`) with the same string escaper.
pub fn acp_permission_fingerprint(tool_call_id: &str, title: &str) -> Sha256Hex {
    let mut text = String::from(r#"{"kind":"tool_call","target":{"title":"#);
    write_string(&mut text, title);
    text.push_str(r#","tool_call_id":"#);
    write_string(&mut text, tool_call_id);
    text.push_str("}}");
    sha256_of(text.as_bytes())
}

fn sha256_of(bytes: &[u8]) -> Sha256Hex {
    Sha256Hex::from_digest(Sha256::digest(bytes).as_slice())
}

fn write_value(out: &mut String, value: &Value, depth: usize) -> Result<(), CanonicalError> {
    if depth > MAX_DEPTH {
        return Err(CanonicalError::TooDeep);
    }
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => write_integer(out, n)?,
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item, depth + 1)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            // `str` ordering is UTF-8 byte order, which equals code point order, which is what
            // Python's `sort_keys` uses for `str` keys.
            let sorted: BTreeMap<&str, &Value> = map.iter().map(|(k, v)| (k.as_str(), v)).collect();
            out.push('{');
            for (i, (key, item)) in sorted.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_value(out, item, depth + 1)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// Integers only. A number that `serde_json` holds as `f64` (a fraction, an exponent, or an
/// integer outside `i64`/`u64`) is rejected: Python would print it differently from any Rust
/// float formatter, and the contract targets never contain one.
fn write_integer(out: &mut String, n: &Number) -> Result<(), CanonicalError> {
    if let Some(i) = n.as_i64() {
        out.push_str(&i.to_string());
        Ok(())
    } else if let Some(u) = n.as_u64() {
        out.push_str(&u.to_string());
        Ok(())
    } else {
        Err(CanonicalError::Float)
    }
}

/// JSON string as Python `ensure_ascii=False` writes it: escape only `"`, `\` and U+0000..U+001F
/// (`\n`, `\r`, `\t`, `\b`, `\f` in short form, the others as `\u00xx` with lowercase hex).
/// Everything else, including U+007F, U+2028, U+2029 and all non-ASCII, is written raw.
fn write_string(out: &mut String, s: &str) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if c < '\u{20}' => {
                let b = c as u8;
                out.push_str("\\u00");
                out.push(char::from(HEX[usize::from(b >> 4)]));
                out.push(char::from(HEX[usize::from(b & 0x0f)]));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_escapes_like_python() {
        let v = json!({"b": "\u{1}\"\\\n", "a": "é"});
        assert_eq!(
            canonical_json(&v).unwrap(),
            "{\"a\":\"é\",\"b\":\"\\u0001\\\"\\\\\\n\"}"
        );
    }

    #[test]
    fn canonical_control_characters_and_raw_characters() {
        // Every control character, plus characters that must NOT be escaped.
        let all_controls: String = (0u8..0x20).map(char::from).collect();
        let text = canonical_json(&json!(all_controls)).unwrap();
        assert_eq!(
            text,
            "\"\\u0000\\u0001\\u0002\\u0003\\u0004\\u0005\\u0006\\u0007\\b\\t\\n\\u000b\\f\\r\
             \\u000e\\u000f\\u0010\\u0011\\u0012\\u0013\\u0014\\u0015\\u0016\\u0017\
             \\u0018\\u0019\\u001a\\u001b\\u001c\\u001d\\u001e\\u001f\""
        );
        let raw = "\u{7f}\u{2028}\u{2029}/😀工作樹";
        assert_eq!(canonical_json(&json!(raw)).unwrap(), format!("\"{raw}\""));
    }

    #[test]
    fn canonical_sorts_keys_by_code_point_recursively() {
        // 'é' (U+00E9) sorts after 'z'; U+FF21 and U+1F600 are order-sensitive between UTF-8
        // byte order and UTF-16 code unit order; code point order must win.
        let v = json!({"z": 1, "é": 2, "\u{ff21}": 3, "\u{1f600}": 4, "B": 5, "a": {"y": [{"d": 1, "c": 2}], "x": null}});
        assert_eq!(
            canonical_json(&v).unwrap(),
            "{\"B\":5,\"a\":{\"x\":null,\"y\":[{\"c\":2,\"d\":1}]},\"z\":1,\"é\":2,\"\u{ff21}\":3,\"\u{1f600}\":4}"
        );
    }

    #[test]
    fn canonical_scalars_and_integers() {
        let v = json!({"t": true, "f": false, "n": null, "neg": -7, "big": u64::MAX, "min": i64::MIN, "e": [], "o": {}});
        assert_eq!(
            canonical_json(&v).unwrap(),
            "{\"big\":18446744073709551615,\"e\":[],\"f\":false,\"min\":-9223372036854775808,\"n\":null,\"neg\":-7,\"o\":{},\"t\":true}"
        );
    }

    #[test]
    fn canonical_rejects_float() {
        assert_eq!(
            canonical_json(&json!({"x": 1.5})),
            Err(CanonicalError::Float)
        );
        assert_eq!(canonical_json(&json!([1.0])), Err(CanonicalError::Float));
        // Parsed from text: an exponent or an integer beyond u64 is held as f64 too.
        let exp: Value = serde_json::from_str("1e3").unwrap();
        assert_eq!(canonical_json(&exp), Err(CanonicalError::Float));
        let huge: Value = serde_json::from_str("18446744073709551616").unwrap();
        assert_eq!(canonical_json(&huge), Err(CanonicalError::Float));
    }

    #[test]
    fn canonical_depth_limit() {
        let mut v = json!(1);
        for _ in 0..MAX_DEPTH {
            v = Value::Array(vec![v]);
        }
        assert!(canonical_json(&v).is_ok());
        let deeper = Value::Array(vec![v]);
        assert_eq!(canonical_json(&deeper), Err(CanonicalError::TooDeep));
        // Do not let the recursive Drop of a very deep value matter: it is only MAX_DEPTH + 1.
    }

    #[test]
    fn canonical_sha256_known_vectors() {
        // sha256("{}") and sha256 of a non-ASCII document, computed with Python hashlib.
        assert_eq!(
            canonical_sha256(&json!({})).unwrap().as_str(),
            "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
        );
    }

    #[test]
    fn permission_fingerprint_equals_generic_path() {
        for (id, title) in [("call_1", "Run tests"), ("c\"1\\", "標題\n\u{1}"), ("", "")] {
            let generic = canonical_sha256(
                &json!({"kind": "tool_call", "target": {"tool_call_id": id, "title": title}}),
            )
            .unwrap();
            assert_eq!(
                acp_permission_fingerprint(id, title),
                generic,
                "{id:?} {title:?}"
            );
        }
    }

    #[test]
    fn idempotency_key_drops_only_top_level_description() {
        let with = json!({"path": "x", "description": "a", "nested": {"description": "keep"}});
        let without = json!({"path": "x", "nested": {"description": "keep"}});
        let other_nested = json!({"path": "x", "nested": {"description": "changed"}});
        let k = |v: &Value| idempotency_key("external_write", v.as_object().unwrap()).unwrap();
        assert_eq!(k(&with), k(&without));
        assert_ne!(k(&with), k(&other_nested));
        // The kind is part of the identity.
        let a = idempotency_key("git_push", with.as_object().unwrap()).unwrap();
        let b = idempotency_key("pr_create", with.as_object().unwrap()).unwrap();
        assert_ne!(a, b);
    }
}
