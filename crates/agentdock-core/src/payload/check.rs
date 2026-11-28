//! `check.*` payloads.

use serde::{Deserialize, Serialize};

use super::common::ArtifactRef;
use super::PayloadRules;
use crate::enums::CheckOrigin;
use crate::ids::CheckId;

string_enum!(CheckFinishState {
    Passed,
    Failed,
    Errored,
    Cancelled,
    OutcomeUnknown
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckStartedPayload {
    pub check_id: CheckId,
    pub name: String,
    pub origin: CheckOrigin,
    /// argv after redaction; never a shell string.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_url: Option<String>,
}

impl PayloadRules for CheckStartedPayload {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckFinishedPayload {
    pub check_id: CheckId,
    pub state: CheckFinishState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<ArtifactRef>,
}

impl PayloadRules for CheckFinishedPayload {}
