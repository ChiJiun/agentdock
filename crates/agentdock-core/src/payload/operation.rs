//! `operation.*` payloads and the schema's `OperationKindRules`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::common::Failure;
use super::PayloadRules;
use crate::canonical;
use crate::enums::{OperationKind, ReconcileStrategy, Repeatability};
use crate::ids::{ApprovalId, GitSha, OperationId, Sha256Hex};

pub mod rule {
    pub const NON_REPEATABLE: &str =
        "operation: git_push, pr_create, pr_update, pr_merge, branch_delete, worktree_remove and destructive_command must be non_repeatable";
    pub const MISSING_IDENTITY: &str =
        "operation: target lacks an identity field its kind requires";
    pub const EXTRA_IDENTITY: &str = "operation: target carries an identity field its kind forbids";
    pub const PR_NUMBER: &str = "operation: pr_number must be greater than 0";
    pub const IDEMPOTENCY_KEY: &str =
        "operation: idempotency_key must equal sha256 of canonical {kind, identity}";
    pub const RESULT_PR_NUMBER: &str =
        "operation.succeeded: result.pr_number must be greater than 0";
}

/// What an operation acts on. `description` is shown to the user and is NOT part of the identity;
/// every other field is an identity field and [`OperationKind`] fixes which ones are allowed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationTarget {
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_sha: Option<GitSha>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_number: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_sha256: Option<Sha256Hex>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_sha256: Option<Sha256Hex>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
}

/// Identity field names of an [`OperationTarget`] (everything except `description`).
const IDENTITY_FIELDS: [&str; 10] = [
    "remote",
    "ref",
    "base",
    "expected_sha",
    "pr_number",
    "path",
    "content_sha256",
    "command_sha256",
    "cwd",
    "endpoint",
];

/// `(required, optional)` identity fields of a kind: `docs/contracts/checkpoint-and-replay.md`
/// "Non-repeatable operations -> Classification" and schema `OperationKindRules`. A target must
/// carry every required field and no field outside `required + optional`.
fn identity_shape(kind: OperationKind) -> (&'static [&'static str], &'static [&'static str]) {
    match kind {
        OperationKind::GitPush => (&["remote", "ref", "expected_sha"], &[]),
        OperationKind::PrCreate => (&["ref", "base"], &[]),
        OperationKind::PrUpdate | OperationKind::PrComment => {
            (&["pr_number", "content_sha256"], &[])
        }
        OperationKind::PrMerge => (&["pr_number", "expected_sha"], &[]),
        // `remote` present = remote branch, absent = local branch.
        OperationKind::BranchDelete => (&["ref", "expected_sha"], &["remote"]),
        OperationKind::WorktreeRemove => (&["path"], &[]),
        OperationKind::DestructiveCommand => (&["command_sha256", "cwd"], &[]),
        OperationKind::ExternalWrite => (&["endpoint", "content_sha256"], &[]),
    }
}

/// Kinds that are always `non_repeatable` (schema `OperationKindRules`, first clause).
/// `pr_comment` and `external_write` may be `idempotent_with_key`.
fn must_be_non_repeatable(kind: OperationKind) -> bool {
    matches!(
        kind,
        OperationKind::GitPush
            | OperationKind::PrCreate
            | OperationKind::PrUpdate
            | OperationKind::PrMerge
            | OperationKind::BranchDelete
            | OperationKind::WorktreeRemove
            | OperationKind::DestructiveCommand
    )
}

fn kind_name(kind: OperationKind) -> String {
    match serde_json::to_value(kind) {
        Ok(Value::String(name)) => name,
        // Unreachable: a unit enum variant always serializes to a string.
        _ => String::new(),
    }
}

impl OperationTarget {
    /// Every present field except `description`, under its wire name.
    pub fn identity(&self) -> Map<String, Value> {
        match serde_json::to_value(self) {
            Ok(Value::Object(mut map)) => {
                map.remove("description");
                map
            }
            // Unreachable: the struct always serializes to an object.
            _ => Map::new(),
        }
    }

    /// `canonical::idempotency_key(kind, identity)`. The identity holds only strings and
    /// positive integers, so canonicalization cannot fail (no floats, shallow).
    pub fn idempotency_key(&self, kind: OperationKind) -> Sha256Hex {
        canonical::idempotency_key(&kind_name(kind), &self.identity())
            .unwrap_or_else(|_| Sha256Hex::from_digest(&[0; 32]))
    }

    fn check_pr_number(&self) -> Result<(), &'static str> {
        if self.pr_number == Some(0) {
            return Err(rule::PR_NUMBER);
        }
        Ok(())
    }

    fn check_identity_shape(&self, kind: OperationKind) -> Result<(), &'static str> {
        let (required, optional) = identity_shape(kind);
        let present = self.identity();
        if required.iter().any(|field| !present.contains_key(*field)) {
            return Err(rule::MISSING_IDENTITY);
        }
        debug_assert!(present
            .keys()
            .all(|k| IDENTITY_FIELDS.contains(&k.as_str())));
        if present
            .keys()
            .any(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
        {
            return Err(rule::EXTRA_IDENTITY);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationRecordedPayload {
    pub operation_id: OperationId,
    pub kind: OperationKind,
    pub repeatability: Repeatability,
    pub idempotency_key: Sha256Hex,
    pub target: OperationTarget,
    pub approval_id: ApprovalId,
    pub reconcile_strategy: ReconcileStrategy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes_operation_id: Option<OperationId>,
}

impl PayloadRules for OperationRecordedPayload {
    /// `OperationKindRules` plus the `idempotency_key` derivation.
    fn validate(&self) -> Result<(), &'static str> {
        if must_be_non_repeatable(self.kind) && self.repeatability != Repeatability::NonRepeatable {
            return Err(rule::NON_REPEATABLE);
        }
        self.target.check_identity_shape(self.kind)?;
        self.target.check_pr_number()?;
        if self.idempotency_key != self.target.idempotency_key(self.kind) {
            return Err(rule::IDEMPOTENCY_KEY);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationStartedPayload {
    pub operation_id: OperationId,
    pub approval_id: ApprovalId,
}

impl PayloadRules for OperationStartedPayload {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_sha: Option<GitSha>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_number: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationSucceededPayload {
    pub operation_id: OperationId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<OperationResult>,
}

impl PayloadRules for OperationSucceededPayload {
    fn validate(&self) -> Result<(), &'static str> {
        if self.result.as_ref().and_then(|r| r.pr_number) == Some(0) {
            return Err(rule::RESULT_PR_NUMBER);
        }
        Ok(())
    }
}

string_enum!(
    /// Whether the failed attempt is known to have had no external effect.
    FailureEffect { None, Unknown }
);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationFailedPayload {
    pub operation_id: OperationId,
    pub error: Failure,
    pub effect: FailureEffect,
}

impl PayloadRules for OperationFailedPayload {
    fn validate(&self) -> Result<(), &'static str> {
        self.error.validate()
    }
}

string_enum!(
    /// `host_crash`: written by recovery for an op left started. `killed`: the orchestrator killed
    /// a started op before it reported.
    OutcomeUnknownCause { HostCrash, Killed }
);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationOutcomeUnknownPayload {
    pub operation_id: OperationId,
    pub cause: OutcomeUnknownCause,
}

impl PayloadRules for OperationOutcomeUnknownPayload {}

string_enum!(ReconcileFinding {
    Applied,
    NotApplied,
    Undeterminable
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationReconciledPayload {
    pub operation_id: OperationId,
    pub finding: ReconcileFinding,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
}

impl PayloadRules for OperationReconciledPayload {}

string_enum!(AbandonReason {
    ApprovalDenied,
    ApprovalExpired,
    ApprovalCancelled,
    ApprovalInvalidated,
    TaskCancelled,
    TaskInterrupted,
    TaskFailed,
    HostRecovery,
});

/// A recorded operation that was never started and never will be.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationAbandonedPayload {
    pub operation_id: OperationId,
    pub reason: AbandonReason,
}

impl PayloadRules for OperationAbandonedPayload {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// The `identity_shape` table must agree with every identity clause of the schema's
    /// `OperationKindRules`: same required fields, and every other identity field forbidden
    /// unless the table lists it as optional.
    #[test]
    fn identity_shape_matches_schema_clauses() {
        let schema = super::super::schema_sync::schema();
        let clauses = schema["$defs"]["OperationKindRules"]["allOf"]
            .as_array()
            .unwrap();
        let mut covered = BTreeSet::new();
        for clause in &clauses[1..] {
            let cond = &clause["if"]["properties"]["kind"];
            let kinds: Vec<String> = match cond.get("const") {
                Some(c) => vec![c.as_str().unwrap().to_owned()],
                None => cond["enum"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|k| k.as_str().unwrap().to_owned())
                    .collect(),
            };
            let target = &clause["then"]["properties"]["target"];
            let required: BTreeSet<&str> = target["required"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap())
                .collect();
            let forbidden: BTreeSet<&str> = target["not"]["anyOf"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["required"][0].as_str().unwrap())
                .collect();
            for name in kinds {
                let kind: OperationKind =
                    serde_json::from_value(Value::String(name.clone())).unwrap();
                let (req, opt) = identity_shape(kind);
                assert_eq!(
                    req.iter().copied().collect::<BTreeSet<_>>(),
                    required,
                    "{name}: required"
                );
                let table_forbidden: BTreeSet<&str> = IDENTITY_FIELDS
                    .iter()
                    .copied()
                    .filter(|f| !req.contains(f) && !opt.contains(f))
                    .collect();
                let optional: BTreeSet<&str> = opt.iter().copied().collect();
                let schema_optional: BTreeSet<&str> = IDENTITY_FIELDS
                    .iter()
                    .copied()
                    .filter(|f| !required.contains(f) && !forbidden.contains(f))
                    .collect();
                assert_eq!(table_forbidden, forbidden, "{name}: forbidden");
                assert_eq!(optional, schema_optional, "{name}: optional");
                covered.insert(name);
            }
        }
        // Every OperationKind is covered by exactly one identity clause.
        let all: BTreeSet<String> = OperationKind::ALL.iter().map(|k| kind_name(*k)).collect();
        assert_eq!(covered, all);
        // The first clause: the always-non-repeatable kinds.
        let listed: BTreeSet<String> = clauses[0]["if"]["properties"]["kind"]["enum"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_str().unwrap().to_owned())
            .collect();
        let table: BTreeSet<String> = OperationKind::ALL
            .iter()
            .filter(|k| must_be_non_repeatable(**k))
            .map(|k| kind_name(*k))
            .collect();
        assert_eq!(table, listed);
    }
}
