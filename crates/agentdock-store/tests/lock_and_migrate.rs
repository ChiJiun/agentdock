//! Single-host lock, versioned migrations with backups, too-new and corrupt files.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

use agentdock_core::payload::task::AutoResumePolicy;
use agentdock_core::payload::TaskCreatedPayload;
use agentdock_core::{
    Actor, ActorKind, AuthorityId, EventBody, EventEnvelope, ProjectId, Redaction, TaskId,
    TaskState, Timestamp,
};
use agentdock_store::{Error, Migration, NewEvent, NoopProjector, OpenOptions, Store, MIGRATIONS};
use rusqlite::Connection;
use tempfile::TempDir;

fn temp() -> TempDir {
    tempfile::Builder::new()
        .prefix("agent dock 測試-")
        .tempdir()
        .unwrap()
}

fn db_path(dir: &TempDir) -> PathBuf {
    dir.path().join("事件 store.db")
}

fn opts(path: &Path) -> OpenOptions {
    OpenOptions {
        path: path.to_path_buf(),
        authority: AuthorityId::local(),
    }
}

fn open_with(path: &Path, migrations: &'static [Migration]) -> agentdock_store::Result<Store> {
    Store::open_with(opts(path), Box::new(NoopProjector), migrations)
}

fn event() -> NewEvent {
    let now = Timestamp::now();
    let body = EventBody::TaskCreated(TaskCreatedPayload {
        objective: "x".to_owned(),
        state: TaskState::Queued,
        issue_url: None,
        branch: None,
        worktree_path: None,
        auto_resume_policy: AutoResumePolicy {
            on_quota_reset: false,
            on_rate_limit: false,
        },
    });
    NewEvent {
        envelope: EventEnvelope::new_live(
            AuthorityId::local(),
            Some(ProjectId::generate()),
            Some(TaskId::generate()),
            None,
            Actor {
                kind: ActorKind::User,
                id: None,
            },
            &body,
            Redaction {
                policy_version: 1,
                applied_rules: vec![],
            },
            now,
            now,
        ),
    }
}

fn write_events(store: &Store, n: usize) {
    for _ in 0..n {
        store.transact(|tx| tx.append(event())).unwrap();
    }
}

fn count_events(store: &Store) -> usize {
    store
        .events_after(&AuthorityId::local(), 0, usize::MAX)
        .unwrap()
        .len()
}

fn user_version(path: &Path) -> i64 {
    Connection::open(path)
        .unwrap()
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap()
}

fn raw_count(path: &Path) -> i64 {
    Connection::open(path)
        .unwrap()
        .query_row("SELECT count(*) FROM events", [], |r| r.get(0))
        .unwrap()
}

fn backups(dir: &TempDir, label: &str) -> Vec<PathBuf> {
    let prefix = format!("事件 store.db.{label}-");
    fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            let name = p.file_name().unwrap().to_string_lossy();
            name.starts_with(&prefix) && name.ends_with(".bak")
        })
        .collect()
}

fn v1_v2(v2_sql: &'static str) -> &'static [Migration] {
    Box::leak(Box::new([
        MIGRATIONS[0],
        Migration {
            version: 2,
            sql: v2_sql,
        },
    ]))
}

/// Retries while the OS has not yet released a dead process's lock (Windows may be late).
fn open_retrying(path: &Path) -> Store {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match Store::open(opts(path)) {
            Ok(store) => return store,
            Err(Error::AlreadyOpen) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => panic!("reopen failed: {e:?}"),
        }
    }
}

/// The append-loop child; killed on drop so a failing test leaves no process behind.
struct AppendLoop {
    child: Child,
    out: BufReader<ChildStdout>,
}

impl AppendLoop {
    fn spawn(db: &Path) -> AppendLoop {
        let mut child = Command::new(env!("CARGO_BIN_EXE_agentdock-store-append-loop"))
            .arg(db)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let out = BufReader::new(child.stdout.take().unwrap());
        AppendLoop { child, out }
    }

    fn next_seq(&mut self) -> u64 {
        let mut line = String::new();
        assert!(self.out.read_line(&mut line).unwrap() > 0, "child exited");
        line.trim().parse().unwrap()
    }
}

impl Drop for AppendLoop {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn second_open_is_refused() {
    let dir = temp();
    let path = db_path(&dir);
    let first = Store::open(opts(&path)).unwrap();
    assert!(matches!(Store::open(opts(&path)), Err(Error::AlreadyOpen)));
    write_events(&first, 1);
    drop(first);
    let again = Store::open(opts(&path)).unwrap();
    assert_eq!(count_events(&again), 1);
}

#[test]
fn lock_released_when_process_dies() {
    let dir = temp();
    let path = db_path(&dir);
    let mut child = AppendLoop::spawn(&path);
    let printed = child.next_seq();
    assert!(matches!(Store::open(opts(&path)), Err(Error::AlreadyOpen)));
    child.child.kill().unwrap();
    child.child.wait().unwrap();
    let store = open_retrying(&path);
    assert!(store.head_seq(&AuthorityId::local()).unwrap() >= printed);
}

#[test]
fn upgrade_backs_up_and_keeps_data() {
    let dir = temp();
    let path = db_path(&dir);
    {
        let store = open_with(&path, MIGRATIONS).unwrap();
        write_events(&store, 10);
    }
    assert!(
        backups(&dir, "pre-v1").is_empty(),
        "a new database needs no backup"
    );
    {
        let store = open_with(&path, v1_v2("ALTER TABLE meta ADD COLUMN x TEXT;")).unwrap();
        assert_eq!(count_events(&store), 10);
    }
    let found = backups(&dir, "pre-v2");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(user_version(&found[0]), 1);
    assert_eq!(raw_count(&found[0]), 10);

    assert_eq!(user_version(&path), 2);
    assert_eq!(raw_count(&path), 10);
    Connection::open(&path)
        .unwrap()
        .prepare("SELECT x FROM meta")
        .unwrap();
}

fn assert_restored_v1(path: &Path) {
    assert_eq!(user_version(path), 1);
    assert_eq!(raw_count(path), 10);
    let raw = Connection::open(path).unwrap();
    assert!(
        raw.prepare("SELECT x FROM meta").is_err(),
        "column x rolled back"
    );
    let tables: i64 = raw
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'escaped'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(tables, 0);
    drop(raw);
    let store = open_with(path, MIGRATIONS).unwrap();
    assert_eq!(count_events(&store), 10);
}

#[test]
fn failed_migration_restores() {
    let dir = temp();
    let path = db_path(&dir);
    write_events(&open_with(&path, MIGRATIONS).unwrap(), 10);
    let broken = v1_v2("ALTER TABLE meta ADD COLUMN x TEXT; CREATE TABLE broken (;");
    match open_with(&path, broken) {
        Err(Error::Migration { version, backup }) => {
            assert_eq!(version, 2);
            assert!(backup.exists());
        }
        other => panic!("{:?}", other.err()),
    }
    assert_restored_v1(&path);
}

#[test]
fn migration_that_escapes_its_transaction_is_restored_from_backup() {
    let dir = temp();
    let path = db_path(&dir);
    write_events(&open_with(&path, MIGRATIONS).unwrap(), 10);
    let escaping = v1_v2("COMMIT; CREATE TABLE escaped (a INTEGER) STRICT;");
    match open_with(&path, escaping) {
        Err(Error::Migration { version, backup }) => {
            assert_eq!(version, 2);
            assert!(backup.exists());
        }
        other => panic!("{:?}", other.err()),
    }
    assert_restored_v1(&path);
}

#[test]
fn too_new_is_refused() {
    let dir = temp();
    let path = db_path(&dir);
    write_events(&Store::open(opts(&path)).unwrap(), 1);
    Connection::open(&path)
        .unwrap()
        .pragma_update(None, "user_version", 99)
        .unwrap();
    let bytes = fs::read(&path).unwrap();
    let modified = fs::metadata(&path).unwrap().modified().unwrap();

    match Store::open(opts(&path)) {
        Err(Error::TooNew { found, supported }) => {
            assert_eq!(found, 99);
            assert_eq!(supported, 1);
        }
        other => panic!("{:?}", other.err()),
    }
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(fs::metadata(&path).unwrap().len(), bytes.len() as u64);
    assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
    assert!(backups(&dir, "pre-v1").is_empty());
}

#[test]
fn corrupt_file_is_kept() {
    let dir = temp();
    let path = db_path(&dir);
    let mut bytes = b"SQLite format 3\0".to_vec();
    bytes.resize(100, 0xA5);
    bytes.resize(8192, 0x5A);
    fs::write(&path, &bytes).unwrap();

    let backup = match Store::open(opts(&path)) {
        Err(Error::Corrupt { backup }) => backup,
        other => panic!("{:?}", other.err()),
    };
    assert_eq!(fs::read(&path).unwrap(), bytes, "original untouched");
    assert!(fs::metadata(&backup).unwrap().len() > 0);
    // Never repaired: a second open refuses again.
    assert!(matches!(
        Store::open(opts(&path)),
        Err(Error::Corrupt { .. })
    ));
}

#[test]
fn corrupt_page_is_detected_and_kept() {
    let dir = temp();
    let path = db_path(&dir);
    write_events(&Store::open(opts(&path)).unwrap(), 200);
    let mut bytes = fs::read(&path).unwrap();
    assert!(bytes.len() > 6 * 4096);
    for b in &mut bytes[4096..6 * 4096] {
        *b = 0x5A;
    }
    fs::write(&path, &bytes).unwrap();

    let backup = match Store::open(opts(&path)) {
        Err(Error::Corrupt { backup }) => backup,
        other => panic!("{:?}", other.err()),
    };
    assert_eq!(fs::read(&path).unwrap(), bytes, "original untouched");
    assert!(backup.exists());
}
