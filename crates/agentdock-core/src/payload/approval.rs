//! `approval.*` payloads.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::common::{is_snake_name, AcpPermissionContext};
use super::PayloadRules;
use crate::enums::{
    ApprovalReturnState, ApprovalScope, ApprovalSource, OperationKind, PolicyClass,
};
use crate::ids::{ApprovalId, OperationId, Sha256Hex};
use crate::time::Timestamp;

pub mod rule {
    pub const OPERATION_KIND_SHAPE: &str =
        "approval.requested: operation_kind must match ^[a-z][a-z0-9_]{0,63}$";
    pub const ACP_SHAPE: &str =
        "approval.requested: source acp_permission requires operation_kind tool_call, acp and classified_kind";
    pub const HOST_POLICY_SHAPE: &str =
        "approval.requested: source host_policy requires operation_id and an OperationKind operation_kind, and forbids acp and classified_kind";
    pub const ACP_OPTION: &str = "approval.resolved: acp_outcome selected requires option_id";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalRequestedPayload {
    pub approval_id: ApprovalId,
    pub source: ApprovalSource,
    /// `tool_call` for ACP permissions, an `OperationKind` for host-policy approvals.
    pub operation_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub classified_kind: Option<PolicyClass>,
    pub operation_fingerprint: Sha256Hex,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<OperationId>,
    pub title: String,
    pub scope: ApprovalScope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub return_state: Option<ApprovalReturnState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp: Option<AcpPermissionContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<Timestamp>,
}

impl PayloadRules for ApprovalRequestedPayload {
    /// Schema `ApprovalRequestedPayload.allOf` (one if/then/else) plus the `operation_kind`
    /// pattern.
    fn validate(&self) -> Result<(), &'static str> {
        if !is_snake_name(&self.operation_kind) {
            return Err(rule::OPERATION_KIND_SHAPE);
        }
        match self.source {
            ApprovalSource::AcpPermission => {
                if self.operation_kind != "tool_call"
                    || self.acp.is_none()
                    || self.classified_kind.is_none()
                {
                    return Err(rule::ACP_SHAPE);
                }
            }
            ApprovalSource::HostPolicy => {
                let kind_ok = serde_json::from_value::<OperationKind>(Value::String(
                    self.operation_kind.clone(),
                ))
                .is_ok();
                if self.operation_id.is_none()
                    || self.acp.is_some()
                    || self.classified_kind.is_some()
                    || !kind_ok
                {
                    return Err(rule::HOST_POLICY_SHAPE);
                }
            }
        }
        if let Some(acp) = &self.acp {
            acp.validate()?;
        }
        Ok(())
    }
}

string_enum!(ResolvedState {
    Approved,
    Denied,
    Expired,
    Cancelled,
    Invalidated
});
string_enum!(AcpOutcomeKind {
    Selected,
    Cancelled
});

/// What AgentDock answered to `session/request_permission`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpOutcome {
    pub outcome: AcpOutcomeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalResolvedPayload {
    pub approval_id: ApprovalId,
    pub state: ResolvedState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<ApprovalScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_rule_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_outcome: Option<AcpOutcome>,
}

impl PayloadRules for ApprovalResolvedPayload {
    fn validate(&self) -> Result<(), &'static str> {
        if let Some(outcome) = &self.acp_outcome {
            if outcome.outcome == AcpOutcomeKind::Selected && outcome.option_id.is_none() {
                return Err(rule::ACP_OPTION);
            }
        }
        Ok(())
    }
}
