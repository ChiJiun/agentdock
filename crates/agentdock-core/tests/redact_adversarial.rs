use agentdock_core::redact::*;
use std::time::{Duration, Instant};

fn r() -> Redactor {
    Redactor::new(
        &["s3cr3t-value-123".into()],
        &[r"C:\Users\alice".into(), "/home/alice".into()],
    )
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
    assert_eq!(
        out.value,
        "AUTHORIZATION: [REDACTED:auth_header]\nnext line"
    );
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
    assert_eq!(
        out.value,
        serde_json::json!({"s3cr3t-value-123": "token=[REDACTED:known_secret];"})
    );
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
    assert!(
        t.elapsed() < Duration::from_secs(2),
        "took {:?}",
        t.elapsed()
    );
}

#[test]
fn deep_json_does_not_overflow_stack() {
    // Dropping a 10,000-level serde_json::Value recurses inside serde_json itself and overflows the
    // default 2 MiB test-thread stack in debug builds (also at 2,000 levels with json! nesting).
    // So the tree is built on a big-stack thread, redact_json runs on this normal test thread
    // (proving the walker itself is depth-bounded), and the deep tree is leaked, not dropped here.
    let handle = std::thread::Builder::new()
        .stack_size(256 * 1024 * 1024)
        .spawn(|| {
            let mut v = serde_json::json!("leaf");
            for _ in 0..10_000 {
                v = serde_json::Value::Array(vec![v]);
            }
            v
        })
        .expect("spawn");
    let v = handle.join().expect("join");
    let out = r().redact_json(&v);
    assert!(out.applied.contains(&RedactionRule::Truncated));
    std::mem::forget(v);
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

// ---- Additional cases beyond the task packet (all secrets below are obvious fakes). ----

#[test]
fn every_api_key_shape_is_removed() {
    let samples = [
        format!("sk-test-FAKE{}", "a".repeat(20)),
        format!("sk-ant-test-FAKE{}", "b".repeat(20)),
        format!("AKIA{}", "0".repeat(16)),
        "xoxb-FAKE-0123456789".to_string(),
        format!("AIza{}", "c".repeat(35)),
    ];
    for s in samples {
        let out = r().redact_text(&format!("k={s} end"));
        assert_eq!(out.value, "k=[REDACTED:api_key] end", "sample {s}");
        assert!(out.applied.contains(&RedactionRule::ApiKey));
    }
    let pat = format!("github_pat_{}", "d".repeat(22));
    assert_eq!(r().redact_text(&pat).value, "[REDACTED:github_token]");
}

#[test]
fn cookie_headers_keep_name_and_lose_value() {
    let out = r().redact_text(
        "Cookie: a=1; b=2\r\nSet-Cookie: sid=FAKE; Path=/\nProxy-Authorization: Basic ZmFrZQ==",
    );
    assert_eq!(
        out.value,
        "Cookie: [REDACTED:auth_header]\r\nSet-Cookie: [REDACTED:auth_header]\nProxy-Authorization: [REDACTED:auth_header]"
    );
}

#[test]
fn bearer_token_in_prose_is_removed_and_word_kept() {
    let out = r().redact_text("curl -H 'x: Bearer FAKE.token.value-123'");
    assert_eq!(out.value, "curl -H 'x: Bearer [REDACTED:auth_header]'");
}

#[test]
fn complete_private_key_block_keeps_text_after_end() {
    let text = "a\n-----BEGIN RSA PRIVATE KEY-----\nFAKE\n-----END RSA PRIVATE KEY-----\nafter";
    let out = r().redact_text(text);
    assert_eq!(out.value, "a\n[REDACTED:private_key]\nafter");
}

#[test]
fn home_path_does_not_match_longer_user_name() {
    let out = r().redact_text("/home/alice2/x and C:\\Users\\alicebob\\x");
    assert_eq!(out.value, "/home/alice2/x and C:\\Users\\alicebob\\x");
    assert!(out.applied.is_empty());
}

#[test]
fn windows_home_accepts_forward_slashes() {
    let out = r().redact_text("see C:/Users/Alice/repo");
    assert_eq!(out.value, "see ~/repo");
}

#[test]
fn secret_crossing_the_truncation_point_is_not_left_half_visible() {
    let secret = "s3cr3t-value-123";
    let text = format!(
        "{}{}{}",
        "x".repeat(MAX_TEXT_CHARS - 5),
        secret,
        "y".repeat(100)
    );
    let out = r().redact_text(&text);
    assert!(out.applied.contains(&RedactionRule::KnownSecret));
    assert!(out.applied.contains(&RedactionRule::Truncated));
    assert!(!out.value.contains("s3cr3"));
}

#[test]
fn multibyte_text_is_truncated_on_char_boundary() {
    let out = r().redact_text(&"😀測".repeat(40_000));
    assert!(out.applied.contains(&RedactionRule::Truncated));
    assert!(out.value.starts_with("😀測"));
    assert!(out.value.ends_with("chars]"));
}

#[test]
fn nested_json_strings_are_redacted_and_non_strings_kept() {
    let v = serde_json::json!({"a": [{"b": "x s3cr3t-value-123 y"}, 1, true, null, 2.5]});
    let out = r().redact_json(&v);
    assert_eq!(
        out.value,
        serde_json::json!({"a": [{"b": "x [REDACTED:known_secret] y"}, 1, true, null, 2.5]})
    );
}

#[test]
fn json_depth_limit_replaces_only_the_deep_part() {
    let mut v = serde_json::json!("s3cr3t-value-123");
    for _ in 0..(MAX_JSON_DEPTH + 5) {
        v = serde_json::Value::Array(vec![v]);
    }
    let out = r().redact_json(&v);
    assert!(out.applied.contains(&RedactionRule::Truncated));
    assert!(!out.value.to_string().contains("s3cr3t"));
}

#[test]
fn very_long_json_key_is_untouched_and_value_is_redacted() {
    let key = "k".repeat(200_000);
    let mut map = serde_json::Map::new();
    map.insert(key.clone(), serde_json::json!("s3cr3t-value-123"));
    let out = r().redact_json(&serde_json::Value::Object(map));
    assert_eq!(
        out.value.get(&key),
        Some(&serde_json::json!("[REDACTED:known_secret]"))
    );
}

#[test]
fn longest_known_secret_wins_over_its_prefix() {
    let red = Redactor::new(&["abcdefgh".into(), "abcdefgh-long".into()], &[]);
    assert_eq!(
        red.redact_text("abcdefgh-long").value,
        "[REDACTED:known_secret]"
    );
}

#[test]
fn known_secret_with_regex_metacharacters_is_matched_literally() {
    let red = Redactor::new(&["a.b*c+d(e)[f]".into()], &[]);
    assert_eq!(
        red.redact_text("x a.b*c+d(e)[f] y aXbbbcd").value,
        "x [REDACTED:known_secret] y aXbbbcd"
    );
}

#[test]
fn hostile_private_key_and_header_inputs_finish_within_budget() {
    let s = format!(
        "{}{}",
        "-----BEGIN PRIVATE KEY-----".repeat(40_000),
        "authorization:".repeat(40_000)
    );
    let t = Instant::now();
    let _ = r().redact_text(&s);
    assert!(
        t.elapsed() < Duration::from_secs(2),
        "took {:?}",
        t.elapsed()
    );
}

#[test]
fn redacting_twice_is_stable_for_all_rules() {
    let text = "Authorization: Bearer FAKEFAKEFAKE\nsk-test-FAKEFAKEFAKEFAKEFAKE s3cr3t-value-123 /home/alice/x\n-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----";
    let once = r().redact_text(text).value;
    assert_eq!(r().redact_text(&once).value, once);
}
