//! Every payload in every contract fixture decodes into a typed `EventBody`, passes the payload
//! rules, and encodes back to exactly the payload it came from.

mod common;

use std::collections::BTreeSet;

use agentdock_core::{
    enums::{EventType, KnownEventType},
    event::EventEnvelope,
    payload::{decode_body, encode_body, EventBody},
};

#[test]
fn every_fixture_event_decodes_to_typed_body_and_reencodes() {
    let mut typed_types = BTreeSet::new();
    for (file, line_no, line) in common::all_fixture_lines() {
        let env: EventEnvelope = serde_json::from_str(&line).unwrap();
        let body = decode_body(&env).unwrap_or_else(|e| panic!("{file}:{line_no}: {e}"));
        if env.tombstone.is_some() {
            assert!(matches!(body, EventBody::Opaque { .. }));
            continue;
        }
        assert!(
            !matches!(body, EventBody::Opaque { .. }),
            "{file}:{line_no} decoded as Opaque"
        );
        let (t, payload) = encode_body(&body);
        assert_eq!(t, env.event_type, "{file}:{line_no}");
        assert_eq!(payload, env.payload, "{file}:{line_no}");
        typed_types.insert(env.event_type.as_str().to_owned());
    }
    // The fixtures exercise all 32 known event types, so none of the typed payloads is untested.
    let all: BTreeSet<String> = KnownEventType::ALL
        .iter()
        .map(|k| EventType::Known(*k).as_str().to_owned())
        .collect();
    assert_eq!(typed_types, all);
}

#[test]
fn envelope_body_accessor_matches_decode_body() {
    let (_, _, line) = common::all_fixture_lines().remove(0);
    let env: EventEnvelope = serde_json::from_str(&line).unwrap();
    assert_eq!(env.body().unwrap(), decode_body(&env).unwrap());
}

/// Fixtures leave many optional fields unset, so a misspelled field name would round-trip
/// silently there. These payloads set every optional field; a typo in a Rust field name makes the
/// re-encoded value differ (the unknown input key is dropped on read).
mod all_optional_fields {
    use agentdock_core::payload::{
        approval::*, check::*, operation::*, session::*, system::*, task::*,
    };
    use serde::{de::DeserializeOwned, Serialize};
    use serde_json::{json, Value};

    const U: &str = "01JDQ001000000000000000001";
    fn id(prefix: &str) -> String {
        format!("{prefix}_{U}")
    }
    const TS: &str = "2026-11-17T02:00:07.000Z";

    fn rt<T: DeserializeOwned + Serialize>(v: Value) {
        let typed: T = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(serde_json::to_value(typed).unwrap(), v);
    }

    fn artifact() -> Value {
        json!({"path": "a/b.txt", "sha256": "0".repeat(64), "bytes": 3})
    }

    #[test]
    fn task_payloads() {
        rt::<TaskCreatedPayload>(
            json!({"objective": "o", "state": "queued", "issue_url": "u",
            "branch": "b", "worktree_path": "w",
            "auto_resume_policy": {"on_quota_reset": true, "on_rate_limit": false}}),
        );
        rt::<TaskStateChangedPayload>(json!({"from": "running", "to": "interrupted",
            "trigger": "interruption", "resume_phase": "pr", "return_state": "ci",
            "approval_id": id("apr"), "checkpoint_id": id("cpt"),
            "failure": {"code": "c", "message": "m"},
            "interruption": {"reason": "quota_exhausted", "phase": "running", "detail": "d",
                "retry_hint": {"not_before": TS, "source": "provider_reported", "detail": "d"},
                "auto_resume_armed": true, "summary_id": id("sum"),
                "open_operation_ids": [id("op")]}}));
        rt::<TaskCheckpointRecordedPayload>(json!({"checkpoint_id": id("cpt"), "phase": "pr",
            "through_seq": 5, "open_operation_ids": [id("op")], "pending_approval_ids": [id("apr")],
            "worktree": {"head_sha": "a".repeat(40), "branch": "b", "dirty": true,
                "diff_sha256": "b".repeat(64)}}));
    }

    #[test]
    fn session_payloads() {
        rt::<SessionCreatedPayload>(json!({"role": "primary", "parent_session_id": id("ses"),
            "adapter_id": "mock", "launch_method": "load", "external_session_id": "x",
            "supersedes_session_id": id("ses"), "handoff_summary_id": id("sum")}));
        rt::<SessionCapabilitiesDetectedPayload>(json!({"snapshot": {"protocol": "acp",
            "protocol_version": 1, "track": "v1_stable", "detected_at": TS,
            "agent_info": {"name": "n", "title": "t", "version": "v"}, "auth_method_ids": ["a"],
            "acp_agent_capabilities": {"loadSession": true},
            "features": {"load_session": true, "resume_session": false, "close_session": false,
                "list_sessions": false, "delete_session": false, "additional_directories": false,
                "system_prompt": false, "prompt_image": false, "prompt_audio": false,
                "prompt_embedded_context": false, "mcp_http": false, "mcp_sse": false,
                "logout": false},
            "client_advertised": {"fs_read_text_file": true, "fs_write_text_file": true,
                "terminal": true, "elicitation": false, "notices": true, "compaction": false},
            "unstable_opt_ins": ["session_fork"]}}));
        rt::<SessionStateChangedPayload>(json!({"from": "active", "to": "failed",
            "trigger": "protocol_error", "turn_id": id("trn"), "stop_reason": "end_turn",
            "external_session_id": "x", "launch_method": "resume", "approval_id": id("apr"),
            "outcome": "failed", "error": {"code": "c", "message": "m"}}));
        rt::<SessionPromptSubmittedPayload>(json!({"turn_id": id("trn"), "origin": "handoff",
            "content": {"text_ref": artifact()}, "handoff_summary_id": id("sum")}));
        rt::<SessionMessageDeltaPayload>(json!({"turn_id": id("trn"), "channel": "agent_thought",
            "content": {"text": "t"}, "coalesced_chunks": 2}));
        rt::<SessionToolCallPayload>(json!({"turn_id": id("trn"), "tool_call_id": "c",
            "title": "t", "kind": "switch_mode", "status": "in_progress", "locations": ["l"],
            "approval_id": id("apr"), "raw_io": artifact()}));
        rt::<SessionSummaryRecordedPayload>(json!({"summary_id": id("sum"),
            "source": "host_generated", "purpose": "handoff", "through_seq": 4,
            "content": {"text": "t"}}));
        rt::<SessionOutputLimitedPayload>(json!({"turn_id": id("trn"), "limit": "max_turn_bytes",
            "action": "truncated", "dropped_bytes": 9}));
    }

    #[test]
    fn approval_operation_check_usage_payloads() {
        rt::<ApprovalRequestedPayload>(
            json!({"approval_id": id("apr"), "source": "acp_permission",
            "operation_kind": "tool_call", "classified_kind": "command",
            "operation_fingerprint": "c".repeat(64), "operation_id": id("op"), "title": "t",
            "scope": "once", "return_state": "pr", "expires_at": TS,
            "acp": {"tool_call_id": "c", "options": [{"option_id": "o", "kind": "allow_once"}]}}),
        );
        rt::<ApprovalResolvedPayload>(json!({"approval_id": id("apr"), "state": "approved",
            "scope": "task", "policy_rule_id": "r",
            "acp_outcome": {"outcome": "selected", "option_id": "o"}}));
        rt::<OperationRecordedPayload>(json!({"operation_id": id("op"), "kind": "git_push",
            "repeatability": "non_repeatable", "idempotency_key": "d".repeat(64),
            "approval_id": id("apr"), "reconcile_strategy": "remote_ref_compare",
            "supersedes_operation_id": id("op"),
            "target": {"description": "d", "remote": "r", "ref": "x", "base": "b",
                "expected_sha": "a".repeat(40), "pr_number": 1, "path": "p",
                "content_sha256": "e".repeat(64), "command_sha256": "f".repeat(64),
                "cwd": ".", "endpoint": "GET x"}}));
        rt::<OperationSucceededPayload>(json!({"operation_id": id("op"),
            "result": {"remote_sha": "a".repeat(40), "pr_number": 2, "url": "u"}}));
        rt::<OperationReconciledPayload>(json!({"operation_id": id("op"), "finding": "applied",
            "evidence": "e"}));
        rt::<CheckStartedPayload>(json!({"check_id": id("chk"), "name": "n", "origin": "ci",
            "command": ["a"], "cwd": ".", "external_url": "u"}));
        rt::<CheckFinishedPayload>(json!({"check_id": id("chk"), "state": "failed",
            "exit_code": -1, "duration_ms": 5, "artifact": artifact()}));
        rt::<UsageReportedPayload>(
            json!({"usage": {"usage_id": id("use"), "task_id": id("tsk"),
            "session_id": id("ses"), "source": "locally_estimated", "reporter": "host_estimator",
            "measured_at": TS, "scope": "increment", "turn_id": id("trn"), "provider": "p",
            "model": "m", "tokens": {"input": 1, "output": 2, "cache_read": 3, "cache_write": 4},
            "context_window": {"used": 1, "size": 2},
            "cost": {"amount": 1.5, "unit": "usd", "basis": "estimated"},
            "estimator": {"id": "e", "version": "1"}}}),
        );
        rt::<RecoveryStartedPayload>(json!({"previous_run_id": "r", "last_seq_before_crash": 0}));
    }
}
