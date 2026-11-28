//! Versioned migrations on `PRAGMA user_version`, with an online backup before every upgrade.

use std::path::{Path, PathBuf};

use agentdock_core::Timestamp;
use rusqlite::backup::NO_PROGRESS;
use rusqlite::{Connection, TransactionBehavior, MAIN_DB};

use crate::error::{busy_or, Error, Result};
use crate::open::sibling;
use crate::Migration;

/// The newest version of `migrations`, which must be exactly `1..=n` in order.
pub(crate) fn supported_version(migrations: &[Migration]) -> Result<i64> {
    let contiguous = migrations
        .iter()
        .zip(1_i64..)
        .all(|(m, expected)| m.version == expected);
    match migrations.last() {
        Some(last) if contiguous => Ok(last.version),
        _ => Err(Error::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "migration list must be versions 1..=n in order",
        ))),
    }
}

pub(crate) fn user_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
}

/// `<db>.<label>-<UTC time>.bak`, made unique if a file of that name already exists. The time
/// has no `:` so the name is valid on Windows.
pub(crate) fn backup_path(db: &Path, label: &str) -> PathBuf {
    let stamp: String = Timestamp::now()
        .to_rfc3339_millis()
        .chars()
        .filter(|c| !matches!(c, '-' | ':'))
        .collect();
    let first = sibling(db, &format!(".{label}-{stamp}.bak"));
    if !first.exists() {
        return first;
    }
    (1_u32..)
        .map(|n| sibling(db, &format!(".{label}-{stamp}-{n}.bak")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

/// SQLite online backup API: a consistent copy that includes committed WAL content (a raw file
/// copy in WAL mode can miss it).
pub(crate) fn backup_to(conn: &Connection, dst: &Path) -> rusqlite::Result<()> {
    conn.backup(MAIN_DB, dst, NO_PROGRESS)
}

/// Brings the database from `found` to the newest version in one transaction. A non-empty
/// database is backed up first; on failure the transaction is rolled back and, if the version
/// did not come back to `found`, the database is restored from the backup.
pub(crate) fn run(
    conn: &mut Connection,
    db: &Path,
    found: i64,
    migrations: &[Migration],
) -> Result<()> {
    let target = supported_version(migrations)?;
    if found >= target {
        return Ok(());
    }
    let backup = backup_path(db, &format!("pre-v{target}"));
    let has_content = found > 0
        || conn.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
            row.get::<_, i64>(0)
        })? > 0;
    if has_content {
        backup_to(conn, &backup)?;
    }

    let schema_before = schema_version(conn)?;
    let Err(failed) = apply(conn, found, migrations)? else {
        return Ok(());
    };
    // A rollback is enough unless the migration escaped the transaction (its own COMMIT) or the
    // rollback did not bring the schema back.
    let rolled_back = !failed.escaped
        && user_version(conn).ok() == Some(found)
        && schema_version(conn).ok() == Some(schema_before);
    if !rolled_back {
        if has_content {
            conn.restore(MAIN_DB, &backup, NO_PROGRESS)?;
        }
    } else if !has_content {
        // Nothing to restore from an empty file, but the error names a backup: keep a copy of
        // the (rolled back, still empty) database so the path exists.
        backup_to(conn, &backup)?;
    }
    Err(Error::Migration {
        version: failed.version,
        backup,
    })
}

fn schema_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.pragma_query_value(None, "schema_version", |row| row.get(0))
}

struct Failed {
    version: i64,
    /// The migration ended the transaction itself, so a rollback cannot undo it.
    escaped: bool,
}

/// `Ok(Err(_))`: a migration failed; the transaction was rolled back unless it escaped.
fn apply(
    conn: &mut Connection,
    found: i64,
    migrations: &[Migration],
) -> Result<std::result::Result<(), Failed>> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(busy_or)?;
    let mut last = found;
    for m in migrations.iter().filter(|m| m.version > found) {
        last = m.version;
        let step = tx.execute_batch(m.sql);
        let escaped = tx.is_autocommit();
        let step = step.and_then(|()| tx.pragma_update(None, "user_version", m.version));
        if step.is_err() || escaped {
            // Dropping `tx` rolls back (a no-op if the migration escaped).
            drop(tx);
            return Ok(Err(Failed {
                version: m.version,
                escaped,
            }));
        }
    }
    if tx.commit().is_err() {
        return Ok(Err(Failed {
            version: last,
            escaped: false,
        }));
    }
    Ok(Ok(()))
}
