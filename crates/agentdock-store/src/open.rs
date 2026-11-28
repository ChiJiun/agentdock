//! Opening: single-host lock, integrity check, version check, pragmas, migrations.

use std::ffi::OsString;
use std::fs::{self, File, TryLockError};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::config::DbConfig;
use rusqlite::{Connection, ErrorCode, OpenFlags};

use crate::error::{busy_or, Error, Result};
use crate::migrate;
use crate::Migration;

const BUSY_TIMEOUT: Duration = Duration::from_millis(3000);

pub(crate) struct Opened {
    pub conn: Connection,
    pub lock: File,
}

/// `path` with `suffix` appended to its file name (`x.db` -> `x.db.lock`).
pub(crate) fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = OsString::from(path.as_os_str());
    name.push(suffix);
    PathBuf::from(name)
}

pub(crate) fn open(path: &Path, migrations: &[Migration]) -> Result<Opened> {
    let supported = migrate::supported_version(migrations)?;
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }
    let lock = take_lock(path)?;

    // No SQLITE_OPEN_URI: the path is always a file name, never a `file:` URI.
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_CREATE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let mut conn = Connection::open_with_flags(path, flags)?;
    conn.busy_timeout(BUSY_TIMEOUT)?;

    // Nothing below writes until the file passed the integrity and version checks.
    if let Some(backup) = check_integrity(&conn, path)? {
        refuse(conn);
        return Err(Error::Corrupt { backup });
    }
    let found = migrate::user_version(&conn).map_err(busy_or)?;
    if found > supported {
        refuse(conn);
        return Err(Error::TooNew { found, supported });
    }

    set_pragmas(&conn)?;
    migrate::run(&mut conn, path, found, migrations)?;
    Ok(Opened { conn, lock })
}

/// Exclusive OS lock on `<db>.lock`, released by the OS when the process dies. The process id
/// written into the file is for humans only; nothing ever reads it to decide anything.
fn take_lock(db: &Path) -> Result<File> {
    // Never truncate before holding the lock: that would wipe the owner's diagnostics.
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(sibling(db, ".lock"))?;
    match file.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => return Err(Error::AlreadyOpen),
        Err(TryLockError::Error(e)) => return Err(Error::Io(e)),
    }
    // Best effort: the lock is what matters, not the diagnostic text.
    if file.set_len(0).is_ok() {
        let _ = writeln!(file, "{}", std::process::id());
    }
    Ok(file)
}

/// `Some(backup)` when the file is not a healthy database; the original is never modified.
fn check_integrity(conn: &Connection, db: &Path) -> Result<Option<PathBuf>> {
    let verdict = conn.prepare("PRAGMA quick_check").and_then(|mut stmt| {
        stmt.query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<String>>>()
    });
    let healthy = match verdict {
        Ok(rows) => rows.len() == 1 && rows[0] == "ok",
        Err(e)
            if matches!(
                e.sqlite_error_code(),
                Some(ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt)
            ) =>
        {
            false
        }
        Err(e) => return Err(busy_or(e)),
    };
    if healthy {
        return Ok(None);
    }
    let backup = migrate::backup_path(db, "corrupt");
    if migrate::backup_to(conn, &backup).is_err() {
        // The backup API cannot read every damaged file; keep the raw bytes instead (and the
        // WAL next to the copy, where SQLite looks for it).
        fs::copy(db, &backup)?;
        let wal = sibling(db, "-wal");
        if wal.exists() {
            fs::copy(&wal, sibling(&backup, "-wal"))?;
        }
    }
    Ok(Some(backup))
}

/// Closes a connection that must not change the file (no checkpoint on close).
fn refuse(conn: Connection) {
    let _ = conn.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true);
    drop(conn);
}

fn set_pragmas(conn: &Connection) -> Result<()> {
    let mode: String =
        conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(Error::Io(std::io::Error::other(format!(
            "could not enable WAL (journal_mode is {mode})"
        ))));
    }
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}
