//! `usage.reported` and `system.*` payloads.

use serde::{Deserialize, Serialize};

use super::common::Usage;
use super::PayloadRules;
use crate::ids::{ApprovalId, CheckId, OperationId, SessionId, TaskId};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageReportedPayload {
    pub usage: Usage,
}

impl PayloadRules for UsageReportedPayload {
    fn validate(&self) -> Result<(), &'static str> {
        self.usage.validate()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryStartedPayload {
    pub previous_run_id: String,
    pub last_seq_before_crash: u64,
}

impl PayloadRules for RecoveryStartedPayload {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryCompletedPayload {
    pub tasks_interrupted: Vec<TaskId>,
    pub sessions_disconnected: Vec<SessionId>,
    pub approvals_invalidated: Vec<ApprovalId>,
    pub operations_marked_unknown: Vec<OperationId>,
    pub operations_abandoned: Vec<OperationId>,
    pub checks_marked_unknown: Vec<CheckId>,
}

impl PayloadRules for RecoveryCompletedPayload {}
