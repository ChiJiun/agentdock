//! Cursor reads: `(authority_id, seq)` is the only read position (events.md "Cursor").

use agentdock_core::{AuthorityId, EventEnvelope, Timestamp};
use rusqlite::types::Type;
use rusqlite::{params, Connection, OptionalExtension};

use crate::error::Result;
use crate::Store;

impl Store {
    /// Events of `authority` with `seq > after_seq`, in `seq` order, at most `limit`.
    pub fn events_after(
        &self,
        authority: &AuthorityId,
        after_seq: u64,
        limit: usize,
    ) -> Result<Vec<EventEnvelope>> {
        let guard = self.lock();
        let mut stmt = guard.conn.prepare(
            "SELECT envelope_json FROM events WHERE authority_id = ?1 AND seq > ?2 \
             ORDER BY seq LIMIT ?3",
        )?;
        let after = i64::try_from(after_seq).unwrap_or(i64::MAX);
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let rows = stmt.query_map(params![authority.as_str(), after, limit], |row| {
            let json: String = row.get(0)?;
            serde_json::from_str::<EventEnvelope>(&json)
                .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, Type::Text, Box::new(e)))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Last committed `seq` of `authority` (0 when it has no events).
    pub fn head_seq(&self, authority: &AuthorityId) -> Result<u64> {
        Ok(head_seq(&self.lock().conn, authority)?)
    }
}

pub(crate) fn head_seq(conn: &Connection, authority: &AuthorityId) -> rusqlite::Result<u64> {
    let head: i64 = conn.query_row(
        "SELECT COALESCE(MAX(seq), 0) FROM events WHERE authority_id = ?1",
        [authority.as_str()],
        |row| row.get(0),
    )?;
    u64::try_from(head)
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, Type::Integer, Box::new(e)))
}

/// `recorded_at` of the authority's last event; non-decreasing by `seq`, so this is the maximum.
pub(crate) fn last_recorded_at(
    conn: &Connection,
    authority: &AuthorityId,
) -> rusqlite::Result<Option<Timestamp>> {
    let text: Option<String> = conn
        .query_row(
            "SELECT recorded_at FROM events WHERE authority_id = ?1 ORDER BY seq DESC LIMIT 1",
            [authority.as_str()],
            |row| row.get(0),
        )
        .optional()?;
    text.map(|t| {
        Timestamp::parse(&t)
            .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, Type::Text, Box::new(e)))
    })
    .transpose()
}
