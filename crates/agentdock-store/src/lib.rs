//! SQLite event store (P2-4, issue #7).
//!
//! * [`Store::open`]: WAL, `synchronous=FULL`, `PRAGMA quick_check`, versioned migrations with a
//!   backup before every upgrade, and a single-host OS file lock on `<db>.lock`.
//! * [`Store::transact`] / [`Tx::append`]: one `BEGIN IMMEDIATE` transaction; `seq` is
//!   `head + 1` per authority (gap-free), `recorded_at` never decreases, and subscribers see the
//!   events only after `COMMIT` (`docs/contracts/checkpoint-and-replay.md` "Durability ordering").
//! * [`Store::subscribe`]: bounded live stream; a subscriber that falls behind gets
//!   [`StreamItem::Lagged`] and pages from [`Store::events_after`].
//!
//! The lock is not reliable on network drives (SMB/NFS); such database paths are unsupported.
//! Every method blocks (SQLite I/O, `busy_timeout`): call it from a dedicated thread or
//! `spawn_blocking`, never on a tokio worker thread.

#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod append;
mod error;
mod migrate;
mod open;
mod read;
mod subscribe;

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use agentdock_core::{AuthorityId, EventBody, EventEnvelope};
use rusqlite::Connection;

pub use append::{NewEvent, Tx};
pub use error::{Error, Result};
pub use subscribe::{StreamItem, Subscription, SUBSCRIBER_BUFFER};

/// Where the database lives and which authority this host writes for.
#[derive(Debug, Clone)]
pub struct OpenOptions {
    pub path: PathBuf,
    /// The authority this store mints `seq` for (`local` on the desktop).
    pub authority: AuthorityId,
}

/// Updates projections inside the append transaction (filled in by P2-5).
pub trait Projector: Send + Sync {
    /// Called inside the transaction after the event row is inserted. Returning Err rolls back
    /// the whole transaction.
    fn apply(
        &self,
        tx: &rusqlite::Transaction<'_>,
        event: &EventEnvelope,
        body: &EventBody,
    ) -> std::result::Result<(), String>;
}

/// A projector that accepts every event and writes nothing.
pub struct NoopProjector;

impl Projector for NoopProjector {
    fn apply(
        &self,
        _tx: &rusqlite::Transaction<'_>,
        _event: &EventEnvelope,
        _body: &EventBody,
    ) -> std::result::Result<(), String> {
        Ok(())
    }
}

/// One schema step: after it runs, `PRAGMA user_version` is `version`.
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub version: i64,
    pub sql: &'static str,
}

/// The schema of this build, oldest first; versions are `1..=n` without gaps.
pub static MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    sql: include_str!("migrations/0001_init.sql"),
}];

/// Fields drop in declaration order: the connection is closed before the file lock is released.
pub struct Store {
    inner: Mutex<Inner>,
    hub: subscribe::Hub,
    projector: Box<dyn Projector>,
    authority: AuthorityId,
    path: PathBuf,
    _lock: File,
}

struct Inner {
    conn: Connection,
    /// Last committed `seq` of `authority`; only changed after a successful `COMMIT`.
    head: u64,
}

impl Store {
    pub fn open(opts: OpenOptions) -> Result<Store> {
        Store::open_with(opts, Box::new(NoopProjector), MIGRATIONS)
    }

    /// Like [`Store::open`] with an explicit projector and migration list (tests inject both).
    pub fn open_with(
        opts: OpenOptions,
        projector: Box<dyn Projector>,
        migrations: &'static [Migration],
    ) -> Result<Store> {
        let opened = open::open(&opts.path, migrations)?;
        let head = read::head_seq(&opened.conn, &opts.authority)?;
        Ok(Store {
            inner: Mutex::new(Inner {
                conn: opened.conn,
                head,
            }),
            hub: subscribe::Hub::new(),
            projector,
            authority: opts.authority,
            path: opts.path,
            _lock: opened.lock,
        })
    }

    /// The database file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A poisoned mutex only means a closure panicked; the transaction was rolled back when it
    /// was dropped during unwinding, so the connection is still consistent.
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
