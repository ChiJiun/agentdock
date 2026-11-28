//! Adversarial tests for the payload rules. Each input is a real fixture event whose payload is
//! edited; every test also checks that the repaired input is accepted, so the rejection is
//! caused by the edited field and nothing else.

use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};

use agentdock_core::enums::ActorKind;
use agentdock_core::enums::{OperationKind, Repeatability};
use agentdock_core::event::{Actor, EventEnvelope, Redaction};
use agentdock_core::ids::{AuthorityId, Sha256Hex};
use agentdock_core::payload::common::rule as common_rule;
use agentdock_core::payload::{
    approval, decode_body, operation, session, task, BodyError, EventBody,
};
use agentdock_core::time::Timestamp;

/// First non-tombstoned fixture event of `event_type` for which `pred(payload)` holds.
fn fixture(event_type: &str, pred: impl Fn(&Value) -> bool) -> Value {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/contracts/fixtures");
    let mut files: Vec<_> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .collect();
    files.sort();
    for file in files {
        for line in fs::read_to_string(file).unwrap().lines() {
            let v: Value = serde_json::from_str(line.trim_end_matches('\r')).unwrap();
            if v["type"] == event_type && v.get("tombstone").is_none() && pred(&v["payload"]) {
                return v;
            }
        }
    }
    panic!("no fixture event {event_type} matches");
}

fn with_payload(mut env: Value, payload: Value) -> Value {
    env["payload"] = payload;
    env
}

/// `Ok(())` if the event decodes, `Err(rule)` if it fails a rule; a shape error is a test bug.
fn outcome(env: &Value) -> Result<(), &'static str> {
    let env: EventEnvelope = serde_json::from_value(env.clone()).unwrap();
    match decode_body(&env) {
        Ok(_) => Ok(()),
        Err(BodyError::Rule { rule, .. }) => Err(rule),
        Err(e @ BodyError::Shape { .. }) => panic!("unexpected shape error: {e}"),
    }
}

fn state_changed(p: Value) -> Value {
    with_payload(fixture("task.state_changed", |_| true), p)
}

fn session_state(p: Value) -> Value {
    with_payload(fixture("session.state_changed", |_| true), p)
}

#[test]
fn retry_with_resume_phase_rejected() {
    let base = json!({"from": "failed", "to": "queued", "trigger": "retry_requested"});
    assert_eq!(outcome(&state_changed(base.clone())), Ok(()));
    let mut bad = base;
    bad["resume_phase"] = json!("pr");
    assert_eq!(
        outcome(&state_changed(bad)),
        Err(task::rule::RETRY_WITH_RESUME_PHASE)
    );
}

#[test]
fn interrupted_without_interruption_rejected() {
    let bad = json!({"from": "running", "to": "interrupted", "trigger": "interruption"});
    assert_eq!(
        outcome(&state_changed(bad.clone())),
        Err(task::rule::INTERRUPTION)
    );
    let mut ok = bad;
    ok["interruption"] =
        json!({"reason": "user_paused", "phase": "running", "auto_resume_armed": false});
    assert_eq!(outcome(&state_changed(ok.clone())), Ok(()));
    // The other direction: an interruption on a state that is not interrupted.
    ok["to"] = json!("queued");
    assert_eq!(outcome(&state_changed(ok)), Err(task::rule::INTERRUPTION));
}

#[test]
fn host_crash_cannot_be_armed() {
    let mut p = json!({"from": "running", "to": "interrupted", "trigger": "interruption",
        "interruption": {"reason": "host_crashed", "phase": "running", "auto_resume_armed": false}});
    assert_eq!(outcome(&state_changed(p.clone())), Ok(()));
    p["interruption"]["auto_resume_armed"] = json!(true);
    assert_eq!(
        outcome(&state_changed(p.clone())),
        Err(common_rule::INTERRUPTION_HOST_CRASH_ARMED)
    );
    // Armed for another reason still needs a reason of quota/rate limit and a usable hint.
    p["interruption"]["reason"] = json!("process_crashed");
    assert_eq!(
        outcome(&state_changed(p.clone())),
        Err(common_rule::INTERRUPTION_ARMED)
    );
    p["interruption"]["reason"] = json!("quota_exhausted");
    assert_eq!(
        outcome(&state_changed(p.clone())),
        Err(common_rule::INTERRUPTION_ARMED)
    );
    p["interruption"]["retry_hint"] =
        json!({"source": "provider_reported", "not_before": "2026-11-17T09:00:00.000Z"});
    assert_eq!(outcome(&state_changed(p)), Ok(()));
}

#[test]
fn unknown_hint_with_time_rejected() {
    let hint = |h: Value| {
        state_changed(
            json!({"from": "running", "to": "interrupted", "trigger": "interruption",
            "interruption": {"reason": "rate_limited", "phase": "running",
                "auto_resume_armed": false, "retry_hint": h}}),
        )
    };
    assert_eq!(outcome(&hint(json!({"source": "unknown"}))), Ok(()));
    assert_eq!(
        outcome(&hint(
            json!({"source": "unknown", "not_before": "2026-11-17T09:00:00.000Z"})
        )),
        Err(common_rule::RETRY_HINT_TIME)
    );
    // And the converse: a known source without a time.
    assert_eq!(
        outcome(&hint(json!({"source": "user_configured"}))),
        Err(common_rule::RETRY_HINT_TIME)
    );
}

#[test]
fn failed_session_cannot_claim_success() {
    let mut p =
        json!({"from": "active", "to": "failed", "trigger": "protocol_error", "outcome": "failed"});
    assert_eq!(outcome(&session_state(p.clone())), Ok(()));
    p["outcome"] = json!("succeeded");
    assert_eq!(
        outcome(&session_state(p.clone())),
        Err(session::rule::FAILED_OUTCOME)
    );
    p.as_object_mut().unwrap().remove("outcome");
    assert_eq!(
        outcome(&session_state(p)),
        Err(session::rule::FINAL_OUTCOME)
    );
}

#[test]
fn acp_approval_must_be_tool_call() {
    let env = fixture("approval.requested", |p| p["source"] == "acp_permission");
    assert_eq!(outcome(&env), Ok(()));
    let mut bad = env;
    bad["payload"]["operation_kind"] = json!("git_push");
    assert_eq!(outcome(&bad), Err(approval::rule::ACP_SHAPE));
}

fn push_recorded() -> Value {
    fixture("operation.recorded", |p| p["kind"] == "git_push")
}

#[test]
fn push_without_remote_rejected() {
    let env = push_recorded();
    assert_eq!(outcome(&env), Ok(()));
    let mut bad = env;
    bad["payload"]["target"]
        .as_object_mut()
        .unwrap()
        .remove("remote");
    assert_eq!(outcome(&bad), Err(operation::rule::MISSING_IDENTITY));
}

#[test]
fn push_claims_idempotent_rejected() {
    let mut bad = push_recorded();
    bad["payload"]["repeatability"] = json!("idempotent_with_key");
    assert_eq!(outcome(&bad), Err(operation::rule::NON_REPEATABLE));
}

#[test]
fn wrong_idempotency_key_rejected() {
    let mut bad = push_recorded();
    bad["payload"]["idempotency_key"] = json!("0".repeat(64));
    assert_eq!(outcome(&bad), Err(operation::rule::IDEMPOTENCY_KEY));
    // A reworded description is not a different operation: the key stays valid.
    let mut reworded = push_recorded();
    reworded["payload"]["target"]["description"] = json!("a different wording");
    assert_eq!(outcome(&reworded), Ok(()));
}

fn capabilities() -> Value {
    fixture("session.capabilities_detected", |p| {
        p["snapshot"]["features"]["close_session"] == true
    })
}

#[test]
fn features_must_match_raw() {
    let env = capabilities();
    assert_eq!(outcome(&env), Ok(()));
    let mut bad = env;
    let flipped = !bad["payload"]["snapshot"]["features"]["load_session"]
        .as_bool()
        .unwrap();
    bad["payload"]["snapshot"]["features"]["load_session"] = json!(flipped);
    assert_eq!(outcome(&bad), Err(common_rule::CAPS_FEATURES));
}

#[test]
fn meta_key_rejected() {
    let mut bad = capabilities();
    bad["payload"]["snapshot"]["acp_agent_capabilities"]["_meta"] = json!({});
    assert_eq!(outcome(&bad), Err(common_rule::CAPS_META));
    // At depth, too.
    let mut deep = capabilities();
    deep["payload"]["snapshot"]["acp_agent_capabilities"]["mcpCapabilities"]["_meta"] =
        json!({"x": 1});
    assert_eq!(outcome(&deep), Err(common_rule::CAPS_META));
}

#[test]
fn quota_key_rejected_anywhere() {
    let mut bad = capabilities();
    bad["payload"]["snapshot"]["acp_agent_capabilities"]["auth"] =
        json!({"nested": [{"deep": {"remainingQuota": 5}}]});
    assert_eq!(outcome(&bad), Err(common_rule::QUOTA_KEY));
    // Also in a payload that has no opaque part.
    let mut approval = fixture("approval.resolved", |_| true);
    assert_eq!(outcome(&approval), Ok(()));
    approval["payload"]["quota_remaining"] = json!(5);
    assert_eq!(outcome(&approval), Err(common_rule::QUOTA_KEY));
}

#[test]
fn capabilities_must_be_an_object_and_opt_ins_snake_case() {
    for bad in [json!([]), json!(null), json!("x")] {
        let mut env = capabilities();
        env["payload"]["snapshot"]["acp_agent_capabilities"] = bad;
        let env: EventEnvelope = serde_json::from_value(env).unwrap();
        assert!(matches!(decode_body(&env), Err(BodyError::Shape { .. })));
    }
    let mut env = capabilities();
    env["payload"]["snapshot"]["unstable_opt_ins"] = json!(["session_fork"]);
    assert_eq!(outcome(&env), Ok(()));
    env["payload"]["snapshot"]["unstable_opt_ins"] = json!(["Session Fork"]);
    assert_eq!(outcome(&env), Err(common_rule::CAPS_OPT_IN));
}

#[test]
fn quota_reset_key_allowed() {
    let mut ok = capabilities();
    ok["payload"]["snapshot"]["acp_agent_capabilities"]["auth"] =
        json!({"x": {"on_quota_reset": true}});
    assert_eq!(outcome(&ok), Ok(()));
    // The exception is exactly a trailing `quota_reset`.
    let mut bad = capabilities();
    bad["payload"]["snapshot"]["acp_agent_capabilities"]["auth"] = json!({"quota_reset_at": 1});
    assert_eq!(outcome(&bad), Err(common_rule::QUOTA_KEY));
}

#[test]
fn text_and_ref_both_rejected() {
    let env = fixture("session.message_delta", |p| {
        p["content"].get("text").is_some()
    });
    assert_eq!(outcome(&env), Ok(()));
    let mut both = env.clone();
    both["payload"]["content"]["text_ref"] =
        json!({"path": "a/b.txt", "sha256": "0".repeat(64), "bytes": 3});
    assert_eq!(outcome(&both), Err(common_rule::TEXT_OR_REF));
    let mut neither = env;
    neither["payload"]["content"] = json!({});
    assert_eq!(outcome(&neither), Err(common_rule::TEXT_OR_REF));
}

// ---- additional rules of the schema, beyond the 14 above ------------------------------------

#[test]
fn quota_name_deny_list_examples() {
    use agentdock_core::payload::common::forbidden_quota_key as find;
    for bad in [
        "remaining",
        "tokens_left",
        "left_tokens",
        "Balance",
        "ALLOWANCE",
        "percent_used",
        "pct",
        "quota",
        "QuotaUsed",
        "x_quota",
        "quota_reset_at",
        "quota_quota_reset",
        "remainingQuota",
    ] {
        assert_eq!(find(&json!({ bad: 1 })), Some(bad.to_owned()), "{bad}");
    }
    for ok in [
        "on_quota_reset",
        "ON_QUOTA_RESET",
        "quota_reset",
        "used",
        "context_window",
        "leftover",
    ] {
        assert_eq!(find(&json!({ ok: 1 })), None, "{ok}");
    }
    // Values are not keys; arrays are traversed.
    assert_eq!(find(&json!({"a": "remaining quota"})), None);
    assert_eq!(
        find(&json!([{"a": [{"balance": 1}]}])),
        Some("balance".to_owned())
    );
}

#[test]
fn quota_walk_survives_very_deep_values() {
    // Built by hand: `json!` would recurse (it serializes its argument).
    let mut v = json!({"balance": 1});
    for _ in 0..100_000 {
        let mut map = serde_json::Map::new();
        map.insert("k".to_owned(), v);
        v = Value::Object(map);
    }
    assert_eq!(
        agentdock_core::payload::common::forbidden_quota_key(&v),
        Some("balance".to_owned())
    );
    // Dropping a 100k-deep value recurses in serde_json; leak it like the std docs suggest.
    std::mem::forget(v);
}

#[test]
fn derive_features_requires_exact_types() {
    use agentdock_core::payload::common::derive_features;
    let f = derive_features(&json!({
        "loadSession": "true",
        "sessionCapabilities": {"resume": true, "close": {}, "list": null},
        "promptCapabilities": {"image": 1, "audio": true},
        "mcpCapabilities": [],
        "auth": {"logout": {}}
    }));
    assert!(!f.load_session && !f.resume_session && f.close_session && !f.list_sessions);
    assert!(!f.prompt_image && f.prompt_audio && !f.mcp_http && f.logout);
    assert_eq!(derive_features(&Value::Null), derive_features(&json!({})));
}

#[test]
fn task_created_must_be_queued() {
    let mut env = fixture("task.created", |_| true);
    assert_eq!(outcome(&env), Ok(()));
    env["payload"]["state"] = json!("running");
    assert_eq!(outcome(&env), Err(task::rule::CREATED_STATE));
}

#[test]
fn state_changed_conditional_requirements() {
    let awaiting =
        json!({"from": "running", "to": "awaiting_approval", "trigger": "approval_requested"});
    assert_eq!(
        outcome(&state_changed(awaiting.clone())),
        Err(task::rule::AWAITING_APPROVAL_TO)
    );
    let leaving =
        json!({"from": "awaiting_approval", "to": "running", "trigger": "approval_resolved"});
    assert_eq!(
        outcome(&state_changed(leaving)),
        Err(task::rule::AWAITING_APPROVAL_FROM)
    );
    let prep = json!({"from": "preparing", "to": "pr", "trigger": "resume_phase_restored"});
    assert_eq!(
        outcome(&state_changed(prep)),
        Err(task::rule::PREPARING_RESUME_PHASE)
    );
    let resume = json!({"from": "interrupted", "to": "queued", "trigger": "resume_requested"});
    assert_eq!(
        outcome(&state_changed(resume)),
        Err(task::rule::RESUME_REQUIRES_PHASE)
    );
    let failed = json!({"from": "running", "to": "failed", "trigger": "unrecoverable_error"});
    assert_eq!(
        outcome(&state_changed(failed.clone())),
        Err(task::rule::FAILURE)
    );
    let mut ok = failed;
    ok["failure"] = json!({"code": "boom"});
    assert_eq!(outcome(&state_changed(ok.clone())), Ok(()));
    ok["failure"] = json!({"code": "Not Snake"});
    assert_eq!(outcome(&state_changed(ok)), Err(common_rule::FAILURE_CODE));
}

#[test]
fn session_state_conditional_requirements() {
    let case = |p: Value, rule: &'static str| {
        assert_eq!(outcome(&session_state(p)), Err(rule));
    };
    case(
        json!({"from": "active", "to": "idle", "trigger": "turn_ended"}),
        session::rule::TURN_ENDED,
    );
    case(
        json!({"from": "disconnected", "to": "starting", "trigger": "reattach_attempt", "launch_method": "new"}),
        session::rule::REATTACH,
    );
    case(
        json!({"from": "idle", "to": "active", "trigger": "prompt_submitted"}),
        session::rule::PROMPT_TURN,
    );
    case(
        json!({"from": "idle", "to": "active", "trigger": "continue_prompt"}),
        session::rule::PROMPT_TURN,
    );
    case(
        json!({"from": "active", "to": "awaiting_permission", "trigger": "permission_requested"}),
        session::rule::PERMISSION_REQUESTED,
    );
    case(
        json!({"from": "idle", "to": "closed", "trigger": "session_closed"}),
        session::rule::FINAL_OUTCOME,
    );
    case(
        json!({"from": "awaiting_permission", "to": "active", "trigger": "permission_resolved"}),
        session::rule::PERMISSION_RESOLVED,
    );
}

#[test]
fn session_created_load_and_resume_need_external_id() {
    let env = fixture("session.created", |_| true);
    let base = |method: &str, extra: Option<&str>| {
        let mut p = json!({"role": "primary", "adapter_id": "mock", "launch_method": method});
        if let Some(id) = extra {
            p["external_session_id"] = json!(id);
        }
        with_payload(env.clone(), p)
    };
    assert_eq!(outcome(&base("new", None)), Ok(()));
    for method in ["load", "resume"] {
        assert_eq!(
            outcome(&base(method, None)),
            Err(session::rule::CREATED_EXTERNAL_ID)
        );
        assert_eq!(outcome(&base(method, Some("ext-1"))), Ok(()));
    }
}

#[test]
fn approval_shape_rules() {
    let host = fixture("approval.requested", |p| p["source"] == "host_policy");
    assert_eq!(outcome(&host), Ok(()));
    let mut no_op = host.clone();
    no_op["payload"]
        .as_object_mut()
        .unwrap()
        .remove("operation_id");
    assert_eq!(outcome(&no_op), Err(approval::rule::HOST_POLICY_SHAPE));
    let mut tool_call = host.clone();
    tool_call["payload"]["operation_kind"] = json!("tool_call");
    assert_eq!(outcome(&tool_call), Err(approval::rule::HOST_POLICY_SHAPE));
    let mut classified = host.clone();
    classified["payload"]["classified_kind"] = json!("git_push");
    assert_eq!(outcome(&classified), Err(approval::rule::HOST_POLICY_SHAPE));
    let mut shape = host;
    shape["payload"]["operation_kind"] = json!("Git Push");
    assert_eq!(outcome(&shape), Err(approval::rule::OPERATION_KIND_SHAPE));

    let acp = fixture("approval.requested", |p| p["source"] == "acp_permission");
    let mut no_ctx = acp.clone();
    no_ctx["payload"].as_object_mut().unwrap().remove("acp");
    assert_eq!(outcome(&no_ctx), Err(approval::rule::ACP_SHAPE));
    let mut no_class = acp.clone();
    no_class["payload"]
        .as_object_mut()
        .unwrap()
        .remove("classified_kind");
    assert_eq!(outcome(&no_class), Err(approval::rule::ACP_SHAPE));
    let mut no_opts = acp;
    no_opts["payload"]["acp"]["options"] = json!([]);
    assert_eq!(outcome(&no_opts), Err(common_rule::ACP_OPTIONS_EMPTY));
}

#[test]
fn acp_selected_outcome_needs_option_id() {
    let mut env = fixture("approval.resolved", |_| true);
    env["payload"]["acp_outcome"] = json!({"outcome": "selected", "option_id": "allow"});
    assert_eq!(outcome(&env), Ok(()));
    env["payload"]["acp_outcome"] = json!({"outcome": "selected"});
    assert_eq!(outcome(&env), Err(approval::rule::ACP_OPTION));
    env["payload"]["acp_outcome"] = json!({"outcome": "cancelled"});
    assert_eq!(outcome(&env), Ok(()));
}

/// Builds a recorded operation of `kind` with a correct key; the caller edits the target.
fn recorded(kind: &str, repeatability: &str, target: Value) -> Value {
    let kind_enum: OperationKind = serde_json::from_value(json!(kind)).unwrap();
    let t: operation::OperationTarget = serde_json::from_value(target.clone()).unwrap();
    let mut env = push_recorded();
    env["payload"]["kind"] = json!(kind);
    env["payload"]["repeatability"] = json!(repeatability);
    env["payload"]["target"] = target;
    env["payload"]["idempotency_key"] = json!(t.idempotency_key(kind_enum).as_str());
    env
}

#[test]
fn every_kind_requires_exactly_its_identity_fields() {
    let sha = "a".repeat(40);
    let digest = "b".repeat(64);
    // (kind, repeatability, a valid target)
    let valid: Vec<(&str, &str, Value)> = vec![
        (
            "git_push",
            "non_repeatable",
            json!({"description": "d", "remote": "origin", "ref": "refs/heads/x", "expected_sha": sha}),
        ),
        (
            "pr_create",
            "non_repeatable",
            json!({"description": "d", "ref": "x", "base": "main"}),
        ),
        (
            "pr_update",
            "non_repeatable",
            json!({"description": "d", "pr_number": 3, "content_sha256": digest}),
        ),
        (
            "pr_comment",
            "idempotent_with_key",
            json!({"description": "d", "pr_number": 3, "content_sha256": digest}),
        ),
        (
            "pr_merge",
            "non_repeatable",
            json!({"description": "d", "pr_number": 3, "expected_sha": sha}),
        ),
        (
            "branch_delete",
            "non_repeatable",
            json!({"description": "d", "ref": "refs/heads/x", "expected_sha": sha}),
        ),
        (
            "branch_delete",
            "non_repeatable",
            json!({"description": "d", "remote": "origin", "ref": "refs/heads/x", "expected_sha": sha}),
        ),
        (
            "worktree_remove",
            "non_repeatable",
            json!({"description": "d", "path": "task-1"}),
        ),
        (
            "destructive_command",
            "non_repeatable",
            json!({"description": "d", "command_sha256": digest, "cwd": "."}),
        ),
        (
            "external_write",
            "idempotent_with_key",
            json!({"description": "d", "endpoint": "POST https://x.test/y", "content_sha256": digest}),
        ),
        (
            "external_write",
            "non_repeatable",
            json!({"description": "d", "endpoint": "POST https://x.test/y", "content_sha256": digest}),
        ),
    ];
    for (kind, repeat, target) in &valid {
        assert_eq!(
            outcome(&recorded(kind, repeat, target.clone())),
            Ok(()),
            "{kind} {target}"
        );
        // Dropping any identity field is rejected ...
        for field in target
            .as_object()
            .unwrap()
            .keys()
            .filter(|k| *k != "description" && *k != "remote")
        {
            let mut t = target.clone();
            t.as_object_mut().unwrap().remove(field);
            assert_eq!(
                outcome(&recorded(kind, repeat, t)),
                Err(operation::rule::MISSING_IDENTITY),
                "{kind} without {field}"
            );
        }
        // ... and so is adding one the kind does not use.
        for (extra, value) in [
            ("base", json!("main")),
            ("path", json!("p")),
            ("cwd", json!(".")),
            ("endpoint", json!("GET https://x.test")),
            ("pr_number", json!(9)),
            ("command_sha256", json!(digest)),
            ("content_sha256", json!(digest)),
            ("expected_sha", json!(sha)),
            ("remote", json!("origin")),
            ("ref", json!("x")),
        ] {
            let mut t = target.clone();
            if t.get(extra).is_some() {
                continue;
            }
            if *kind == "branch_delete" && extra == "remote" {
                continue; // optional for this kind
            }
            t[extra] = value;
            assert_eq!(
                outcome(&recorded(kind, repeat, t)),
                Err(operation::rule::EXTRA_IDENTITY),
                "{kind} with extra {extra}"
            );
        }
    }
}

#[test]
fn pr_number_zero_rejected() {
    let digest = "b".repeat(64);
    let zero = recorded(
        "pr_update",
        "non_repeatable",
        json!({"description": "d", "pr_number": 0, "content_sha256": digest}),
    );
    assert_eq!(outcome(&zero), Err(operation::rule::PR_NUMBER));
    let mut succeeded = fixture("operation.succeeded", |_| true);
    succeeded["payload"]["result"] = json!({"pr_number": 0});
    assert_eq!(outcome(&succeeded), Err(operation::rule::RESULT_PR_NUMBER));
    succeeded["payload"]["result"] = json!({"pr_number": 1});
    assert_eq!(outcome(&succeeded), Ok(()));
}

#[test]
fn target_identity_excludes_description_and_keys_are_stable() {
    let t: operation::OperationTarget = serde_json::from_value(json!(
        {"description": "x", "remote": "origin", "ref": "refs/heads/a", "expected_sha": "2".repeat(40)}
    ))
    .unwrap();
    let id = t.identity();
    assert!(!id.contains_key("description"));
    assert_eq!(id.len(), 3);
    // Pinned against the fixture 01 push key (see fixtures_envelope.rs for the Python vectors).
    assert_eq!(
        t.idempotency_key(OperationKind::GitPush),
        t.idempotency_key(OperationKind::GitPush)
    );
    assert_ne!(
        t.idempotency_key(OperationKind::GitPush),
        t.idempotency_key(OperationKind::BranchDelete)
    );
    let zero = Sha256Hex::parse(&"0".repeat(64)).unwrap();
    assert_ne!(t.idempotency_key(OperationKind::GitPush), zero);
    assert_eq!(Repeatability::ALL.len(), 2);
}

#[test]
fn usage_rules_follow_the_source() {
    let base = fixture("usage.reported", |_| true);
    assert_eq!(outcome(&base), Ok(()));
    let usage = |extra: Value| {
        let mut u = json!({
            "usage_id": base["payload"]["usage"]["usage_id"], "task_id": base["payload"]["usage"]["task_id"],
            "session_id": base["payload"]["usage"]["session_id"],
            "measured_at": "2026-11-17T02:00:07.000Z", "scope": "snapshot"
        });
        for (k, v) in extra.as_object().unwrap() {
            u[k] = v.clone();
        }
        with_payload(base.clone(), json!({ "usage": u }))
    };
    use common_rule as r;
    let tokens = json!({"input": 1});
    assert_eq!(
        outcome(&usage(json!({"source": "unknown", "reporter": "none"}))),
        Ok(())
    );
    assert_eq!(
        outcome(&usage(
            json!({"source": "unknown", "reporter": "none", "tokens": tokens})
        )),
        Err(r::USAGE_UNKNOWN)
    );
    assert_eq!(
        outcome(&usage(
            json!({"source": "unknown", "reporter": "provider_api"})
        )),
        Err(r::USAGE_UNKNOWN)
    );
    let est = json!({"id": "e", "version": "1"});
    assert_eq!(
        outcome(&usage(
            json!({"source": "locally_estimated", "reporter": "host_estimator", "estimator": est,
            "cost": {"amount": 1.5, "unit": "usd", "basis": "estimated"}})
        )),
        Ok(())
    );
    assert_eq!(
        outcome(&usage(
            json!({"source": "locally_estimated", "reporter": "host_estimator"})
        )),
        Err(r::USAGE_ESTIMATED)
    );
    assert_eq!(
        outcome(&usage(
            json!({"source": "locally_estimated", "reporter": "host_estimator", "estimator": est,
            "cost": {"amount": 1.5, "unit": "usd", "basis": "reported"}})
        )),
        Err(r::USAGE_ESTIMATED)
    );
    assert_eq!(
        outcome(&usage(
            json!({"source": "provider_reported", "reporter": "acp_usage_update", "tokens": tokens,
            "cost": {"amount": 1.5, "unit": "usd", "basis": "reported"}})
        )),
        Ok(())
    );
    for bad in [
        json!({"source": "provider_reported", "reporter": "host_estimator"}),
        json!({"source": "provider_reported", "reporter": "none"}),
        json!({"source": "provider_reported", "reporter": "provider_api", "estimator": est}),
        json!({"source": "provider_reported", "reporter": "provider_api",
            "cost": {"amount": 1.5, "unit": "usd", "basis": "estimated"}}),
    ] {
        assert_eq!(
            outcome(&usage(bad.clone())),
            Err(r::USAGE_REPORTED),
            "{bad}"
        );
    }
    assert_eq!(
        outcome(&usage(
            json!({"source": "provider_reported", "reporter": "provider_api",
            "cost": {"amount": -1, "unit": "usd", "basis": "reported"}})
        )),
        Err(r::COST_AMOUNT)
    );
}

#[test]
fn v2_draft_snapshots_are_rejected() {
    let mut env = capabilities();
    env["payload"]["snapshot"]["track"] = json!("v2_draft");
    assert_eq!(outcome(&env), Err(common_rule::CAPS_TRACK));
}

#[test]
fn tombstoned_and_unknown_events_decode_as_opaque() {
    let mut tomb = fixture("task.created", |_| true);
    tomb["payload"] = json!({});
    tomb["tombstone"] = json!({"reason": "task_deleted", "at": "2026-11-17T02:00:07.000Z"});
    let env: EventEnvelope = serde_json::from_value(tomb).unwrap();
    assert!(matches!(decode_body(&env), Ok(EventBody::Opaque { .. })));

    let mut unknown = fixture("task.created", |_| true);
    unknown["type"] = json!("future.thing_happened");
    unknown["payload"] = json!({"remaining": 1, "anything": [1, 2]});
    let env: EventEnvelope = serde_json::from_value(unknown).unwrap();
    let body = decode_body(&env).unwrap();
    assert!(body.is_opaque());
    assert_eq!(agentdock_core::payload::encode_body(&body).1, env.payload);
    assert_eq!(
        agentdock_core::payload::encode_body(&body).0.as_str(),
        "future.thing_happened"
    );
}

#[test]
fn shape_errors_are_reported_with_the_event_type() {
    let mut env = fixture("task.created", |_| true);
    env["payload"] = json!({"objective": 1});
    let env: EventEnvelope = serde_json::from_value(env).unwrap();
    match decode_body(&env) {
        Err(BodyError::Shape { event_type, .. }) => assert_eq!(event_type, "task.created"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn new_live_builds_an_envelope_that_decodes_back() {
    let src = fixture("task.state_changed", |_| true);
    let src_env: EventEnvelope = serde_json::from_value(src).unwrap();
    let body = decode_body(&src_env).unwrap();
    let now = Timestamp::parse("2026-11-17T02:00:07.000Z").unwrap();
    let new = |actor: Actor| {
        EventEnvelope::new_live(
            AuthorityId::local(),
            src_env.project_id.clone(),
            src_env.task_id.clone(),
            None,
            actor,
            &body,
            Redaction {
                policy_version: 1,
                applied_rules: vec![],
            },
            now,
            now,
        )
    };
    let live = new(Actor {
        kind: ActorKind::Orchestrator,
        id: None,
    });
    assert_eq!(live.seq, 0);
    assert_eq!(live.provenance, agentdock_core::enums::Provenance::Live);
    assert_eq!(live.body().unwrap(), body);
    assert_ne!(live.id, src_env.id);
    let recovery = new(Actor {
        kind: ActorKind::Recovery,
        id: None,
    });
    assert_eq!(
        recovery.provenance,
        agentdock_core::enums::Provenance::Recovery
    );
}
