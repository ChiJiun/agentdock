#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

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

pub fn   badly_formatted( ) -> u8 {   1 }
