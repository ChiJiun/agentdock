#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

pub mod canonical;
pub mod enums;
pub mod event;
pub mod ids;
pub mod time;

pub use crate::time::{Timestamp, TimestampError};
pub use canonical::{
    acp_permission_fingerprint, canonical_json, canonical_sha256, idempotency_key, CanonicalError,
};
pub use enums::*;
pub use event::{Actor, EnvelopeError, EventEnvelope, Redaction, Tombstone};
pub use ids::{
    AdapterId, ApprovalId, AuthorityId, CheckId, CheckpointId, EventId, GitSha, IdError,
    OperationId, ProjectId, SessionId, Sha256Hex, SummaryId, TaskId, TurnId, UsageId,
};

/// AgentDock contract schema version this build writes (ADR-0003: EventEnvelope.schema_version).
pub const SCHEMA_VERSION: u32 = 1;

/// Crate version, used by `app_info` in P1-2.
pub fn crate_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_version_is_one() {
        assert_eq!(SCHEMA_VERSION, 1);
    }

    #[test]
    fn crate_version_matches_workspace() {
        assert_eq!(crate_version(), "0.1.0");
    }
}
