use std::path::PathBuf;

/// Errors of the event store. Messages never contain event payloads.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("database is locked by another AgentDock process")]
    AlreadyOpen,
    #[error("database failed integrity check; a copy was kept at {backup}")]
    Corrupt { backup: PathBuf },
    #[error("database schema version {found} is newer than this build supports ({supported})")]
    TooNew { found: i64, supported: i64 },
    #[error("migration {version} failed; database restored from {backup}")]
    Migration { version: i64, backup: PathBuf },
    /// Envelope, body or projector refusal. Nothing of the refused event was committed.
    #[error("event rejected: {0}")]
    Rejected(String),
    #[error("busy: another writer held the lock too long")]
    Busy,
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// `SQLITE_BUSY` / `SQLITE_LOCKED` after `busy_timeout` ran out.
pub(crate) fn is_busy(e: &rusqlite::Error) -> bool {
    matches!(
        e.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
    )
}

/// Maps busy errors to [`Error::Busy`] (no retry loop: `busy_timeout` already waited).
pub(crate) fn busy_or(e: rusqlite::Error) -> Error {
    if is_busy(&e) {
        Error::Busy
    } else {
        Error::Sqlite(e)
    }
}
