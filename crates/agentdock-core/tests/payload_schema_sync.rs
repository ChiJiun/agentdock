//! Keeps the hand-written payload enums and rule counts in step with the schema file: a new or
//! renamed schema value, or an extra `allOf` clause, fails here until somebody transcribes it.

use std::collections::BTreeSet;
use std::fmt::Debug;
use std::path::PathBuf;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use agentdock_core::payload::approval::{AcpOutcomeKind, ResolvedState};
use agentdock_core::payload::check::CheckFinishState;
use agentdock_core::payload::common::*;
use agentdock_core::payload::operation::{
    AbandonReason, FailureEffect, OutcomeUnknownCause, ReconcileFinding,
};
use agentdock_core::payload::session::*;
use agentdock_core::payload::task::TaskDeletedFinalState;

fn schema() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../docs/contracts/schema/agentdock.schema.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn schema_values(schema: &Value, pointer: &str) -> BTreeSet<String> {
    schema
        .pointer(pointer)
        .unwrap_or_else(|| panic!("schema has nothing at {pointer}"))
        .as_array()
        .unwrap_or_else(|| panic!("{pointer} is not an array"))
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect()
}

fn check<T>(schema: &Value, pointer: &str, all: &[T])
where
    T: Serialize + DeserializeOwned + PartialEq + Debug,
{
    let mut rust = BTreeSet::new();
    for variant in all {
        let value = serde_json::to_value(variant).unwrap();
        let back: T = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(&back, variant, "{pointer}: does not round-trip");
        assert!(
            rust.insert(value.as_str().unwrap().to_owned()),
            "{pointer}: duplicate"
        );
    }
    assert_eq!(
        rust,
        schema_values(schema, pointer),
        "enum at {pointer} differs from schema"
    );
}

#[test]
fn payload_enums_match_schema() {
    let s = schema();
    let d = "/$defs";
    check(&s, &format!("{d}/HintSource/enum"), HintSource::ALL);
    check(&s, &format!("{d}/AcpStopReason/enum"), AcpStopReason::ALL);
    check(
        &s,
        &format!("{d}/AcpPermissionOptionKind/enum"),
        AcpPermissionOptionKind::ALL,
    );
    check(&s, &format!("{d}/UsageSource/enum"), UsageSource::ALL);
    check(&s, &format!("{d}/UsageReporter/enum"), UsageReporter::ALL);
    check(
        &s,
        &format!("{d}/Usage/properties/scope/enum"),
        UsageScope::ALL,
    );
    check(
        &s,
        &format!("{d}/Cost/properties/basis/enum"),
        CostBasis::ALL,
    );
    check(&s, &format!("{d}/SummarySource/enum"), SummarySource::ALL);
    check(&s, &format!("{d}/SummaryPurpose/enum"), SummaryPurpose::ALL);
    check(
        &s,
        &format!("{d}/AcknowledgementMethod/enum"),
        AcknowledgementMethod::ALL,
    );
    check(
        &s,
        &format!("{d}/CapabilitySnapshot/properties/track/enum"),
        CapabilityTrack::ALL,
    );
    assert_eq!(
        s.pointer(&format!("{d}/CapabilitySnapshot/properties/protocol/const")),
        Some(&Value::String("acp".into()))
    );
    assert_eq!(CapabilityProtocol::ALL.len(), 1);
    check(
        &s,
        &format!("{d}/TaskDeletedPayload/properties/final_state/enum"),
        TaskDeletedFinalState::ALL,
    );
    check(
        &s,
        &format!("{d}/SessionPromptSubmittedPayload/properties/origin/enum"),
        PromptOrigin::ALL,
    );
    check(
        &s,
        &format!("{d}/SessionMessageDeltaPayload/properties/channel/enum"),
        MessageChannel::ALL,
    );
    check(
        &s,
        &format!("{d}/SessionToolCallPayload/properties/kind/enum"),
        ToolKind::ALL,
    );
    check(
        &s,
        &format!("{d}/SessionToolCallPayload/properties/status/enum"),
        ToolStatus::ALL,
    );
    let entry = format!("{d}/SessionPlanUpdatedPayload/properties/entries/items/properties");
    check(&s, &format!("{entry}/priority/enum"), PlanPriority::ALL);
    check(&s, &format!("{entry}/status/enum"), PlanStatus::ALL);
    check(
        &s,
        &format!("{d}/SessionOutputLimitedPayload/properties/limit/enum"),
        OutputLimit::ALL,
    );
    check(
        &s,
        &format!("{d}/SessionOutputLimitedPayload/properties/action/enum"),
        OutputLimitAction::ALL,
    );
    check(
        &s,
        &format!("{d}/SessionArchivedPayload/properties/by/enum"),
        ArchivedBy::ALL,
    );
    check(
        &s,
        &format!("{d}/SessionUnarchivedPayload/properties/by/enum"),
        UnarchivedBy::ALL,
    );
    check(
        &s,
        &format!("{d}/ApprovalResolvedPayload/properties/state/enum"),
        ResolvedState::ALL,
    );
    check(
        &s,
        &format!("{d}/ApprovalResolvedPayload/properties/acp_outcome/properties/outcome/enum"),
        AcpOutcomeKind::ALL,
    );
    check(
        &s,
        &format!("{d}/OperationFailedPayload/properties/effect/enum"),
        FailureEffect::ALL,
    );
    check(
        &s,
        &format!("{d}/OperationOutcomeUnknownPayload/properties/cause/enum"),
        OutcomeUnknownCause::ALL,
    );
    check(
        &s,
        &format!("{d}/OperationReconciledPayload/properties/finding/enum"),
        ReconcileFinding::ALL,
    );
    check(
        &s,
        &format!("{d}/OperationAbandonedPayload/properties/reason/enum"),
        AbandonReason::ALL,
    );
    check(
        &s,
        &format!("{d}/CheckFinishedPayload/properties/state/enum"),
        CheckFinishState::ALL,
    );
}

/// Number of `allOf` clauses per schema definition that `validate()` transcribes. If a clause is
/// added to the schema, this fails and the rule table has to be extended.
#[test]
fn allof_clause_counts_match_the_transcription() {
    let s = schema();
    for (name, clauses) in [
        ("TaskStateChangedPayload", 7),
        ("SessionStateChangedPayload", 7),
        ("SessionCreatedPayload", 1),
        ("ApprovalRequestedPayload", 1),
        ("Interruption", 1),
        ("RetryHint", 1),
        ("Usage", 3),
        ("OperationKindRules", 9),
    ] {
        let got = s
            .pointer(&format!("/$defs/{name}/allOf"))
            .and_then(Value::as_array)
            .map_or(0, Vec::len);
        assert_eq!(got, clauses, "{name}.allOf clause count");
    }
    // Rules on nested objects that are not an `allOf` of a payload.
    assert!(s
        .pointer("/$defs/ApprovalResolvedPayload/properties/acp_outcome/allOf")
        .is_some());
    assert!(s.pointer("/$defs/TextOrRef/oneOf").is_some());
}
