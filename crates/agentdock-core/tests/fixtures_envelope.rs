//! Every line of every contract fixture must deserialize into `EventEnvelope`, pass the
//! envelope-level validation and serialize back to a semantically equal JSON value.
//! The idempotency-key tests pin the hashes `validate_fixtures.py` produces.

use agentdock_core::{canonical::*, event::EventEnvelope};
use std::{fs, path::PathBuf};

fn contracts() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/contracts")
}

fn all_fixture_lines() -> Vec<(String, usize, String)> {
    let mut out = vec![];
    for dir in [
        contracts().join("fixtures"),
        contracts().join("fixtures/predelete"),
    ] {
        for entry in fs::read_dir(&dir).unwrap() {
            let p = entry.unwrap().path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            // JSON Lines are separated by `\n` only (contracts README); strip one trailing `\r`
            // so a CRLF checkout (core.autocrlf=true) still works.
            for (i, line) in fs::read_to_string(&p).unwrap().split('\n').enumerate() {
                let line = line.strip_suffix('\r').unwrap_or(line);
                if !line.is_empty() {
                    out.push((p.display().to_string(), i + 1, line.to_string()));
                }
            }
        }
    }
    assert!(
        out.len() > 500,
        "expected the 13 fixtures (+ predelete) to have >500 lines"
    );
    out
}

#[test]
fn fixtures_directory_layout_is_as_expected() {
    // Guards the premise of the test below: both directories exist and are non-empty.
    for dir in [
        contracts().join("fixtures"),
        contracts().join("fixtures/predelete"),
    ] {
        let n = fs::read_dir(&dir)
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .and_then(|x| x.to_str())
                    == Some("jsonl")
            })
            .count();
        assert!(n > 0, "no .jsonl in {}", dir.display());
    }
}

#[test]
fn every_fixture_line_roundtrips_semantically() {
    for (file, line_no, line) in all_fixture_lines() {
        let original: serde_json::Value = serde_json::from_str(&line).unwrap();
        let env: EventEnvelope =
            serde_json::from_str(&line).unwrap_or_else(|e| panic!("{file}:{line_no}: {e}"));
        env.validate()
            .unwrap_or_else(|e| panic!("{file}:{line_no}: {e}"));
        assert_eq!(
            serde_json::to_value(&env).unwrap(),
            original,
            "{file}:{line_no}"
        );
    }
}

#[test]
fn idempotency_keys_match_fixture_and_python() {
    // From fixtures/01-happy-path-pr.jsonl seq 38 / 45 / 59 (verified with Python on 2026-11-22).
    let push = serde_json::json!({"remote":"origin","ref":"refs/heads/agentdock/0001",
        "expected_sha":"2222222222222222222222222222222222222222","description":"ignored"});
    assert_eq!(
        idempotency_key("git_push", push.as_object().unwrap())
            .unwrap()
            .as_str(),
        "d2f573fe870a9f53106ecce01d5f0f9e26d7a590ef1eb6dbfcd539628752d4fd"
    );
    let pr = serde_json::json!({"ref":"agentdock/0001","base":"main","description":"x"});
    assert_eq!(
        idempotency_key("pr_create", pr.as_object().unwrap())
            .unwrap()
            .as_str(),
        "9c98798450d136f5574cb13275e535ec6119075d1fb6f0aa449b7cf78eca7be7"
    );
    // Non-ASCII identity must not be escaped.
    let wt = serde_json::json!({"path":"工作樹/task-01","description":"移除"});
    assert_eq!(
        idempotency_key("worktree_remove", wt.as_object().unwrap())
            .unwrap()
            .as_str(),
        "5f4fcb979630f8d4c62faca754b24d8f53b47495bcc3ed4c21bfc63f5c0f9b6d"
    );
    assert_eq!(
        acp_permission_fingerprint("call_1", "Run tests").as_str(),
        "c2a86338b0447873db2221422402798cefd32e28229893f946f28efcb3a81477"
    );
}

#[test]
fn description_change_keeps_key_identity_change_does_not() {
    let a = serde_json::json!({"remote":"origin","ref":"refs/heads/x","expected_sha":"a".repeat(40),"description":"one"});
    let b = serde_json::json!({"remote":"origin","ref":"refs/heads/x","expected_sha":"a".repeat(40),"description":"two"});
    let c = serde_json::json!({"remote":"origin","ref":"refs/heads/y","expected_sha":"a".repeat(40),"description":"one"});
    let k = |v: &serde_json::Value| idempotency_key("git_push", v.as_object().unwrap()).unwrap();
    assert_eq!(k(&a), k(&b));
    assert_ne!(k(&a), k(&c));
}

/// Every operation target recorded in the fixtures hashes to the `idempotency_key` stored next
/// to it, so the Rust implementation agrees with the validator on all real data, not only on
/// the three hand-picked vectors above.
#[test]
fn every_recorded_idempotency_key_matches_rust() {
    let mut checked = 0;
    for (file, line_no, line) in all_fixture_lines() {
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        if v["type"] != "operation.recorded" {
            continue;
        }
        let p = &v["payload"];
        let (Some(kind), Some(target), Some(key)) = (
            p["kind"].as_str(),
            p["target"].as_object(),
            p["idempotency_key"].as_str(),
        ) else {
            continue;
        };
        let got = idempotency_key(kind, target).unwrap();
        assert_eq!(got.as_str(), key, "{file}:{line_no}");
        checked += 1;
    }
    assert!(
        checked > 0,
        "no operation.recorded with an idempotency_key found in the fixtures"
    );
}
