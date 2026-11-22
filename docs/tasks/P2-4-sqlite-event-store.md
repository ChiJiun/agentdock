# P2-4: SQLite event store (migrations, gap-free seq, single-host lock, backups)

> **繁中摘要**：新 crate `agentdock-store`：以 WAL、`synchronous=FULL` 開啟 SQLite，`quick_check` 失敗時保留備份並拒絕開啟；版本化 migration，升級前用 SQLite backup API 備份、失敗即還原；以 OS 檔案鎖確保同一資料庫只有一個 AgentDock 行程（行程死亡自動釋放）；`events` 表 append-only，每個 authority 的 `seq` 在 `BEGIN IMMEDIATE` 交易內指派、嚴格遞增且無空洞，commit 之後才通知訂閱者；訂閱端有界，溢位時送 `Lagged`。提供 `Projector` hook 讓 P2-5 在同一交易內更新 projection。硬性終止子程序的測試要證明已 commit 的事件不遺失、seq 無空洞。模型等級：強模型實作＋強模型審查。

Issue: #7 | Gate (#51): G3, G8 | Model tier: **strong model implements and reviews**

## 1. Goal and non-goals

Goal: new crate `agentdock-store` that provides:

- Opening: WAL, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=3000`; `PRAGMA quick_check`; versioned migrations; automatic backup before upgrades.
- Single-host lock: only one AgentDock process may open a database (OS file lock, released automatically when the process dies).
- `events` table and append: per-authority `seq` assigned inside the transaction, strictly increasing, **gap-free**; `recorded_at` non-decreasing; subscribers notified only after commit.
- Reads: `events_after(authority, after_seq, limit)`, `head_seq`. Subscriptions: bounded buffer, overflow sends `Lagged`.
- `Projector` hook: called by append in the same transaction so P2-5 can update projections and enforce invariants.

Non-goals: projection contents and transition checks (P2-5), recovery (P2-6), redaction (P2-7), task deletion and tombstones, transcript compaction (listed as not covered in the README).

## 2. Prerequisites and parallel work

- Prerequisites: P2-1, P2-2.
- Parallel: P2-3, P3-*, P4-1, P5-1.

## 3. Files

New:

- `crates/agentdock-store/Cargo.toml`
- `crates/agentdock-store/src/lib.rs`
- `crates/agentdock-store/src/error.rs`
- `crates/agentdock-store/src/open.rs` (open, pragmas, quick_check, lock)
- `crates/agentdock-store/src/migrate.rs`
- `crates/agentdock-store/src/migrations/0001_init.sql`
- `crates/agentdock-store/src/append.rs` (`Store::transact`, `Tx::append`)
- `crates/agentdock-store/src/read.rs`
- `crates/agentdock-store/src/subscribe.rs`
- `crates/agentdock-store/tests/append_seq.rs`
- `crates/agentdock-store/tests/lock_and_migrate.rs`
- `crates/agentdock-store/tests/kill_during_append.rs`
- `crates/agentdock-store/src/bin/agentdock-store-append-loop.rs` (child process for the kill tests; `[[bin]]` with `test = false`, so tests can use `env!("CARGO_BIN_EXE_agentdock-store-append-loop")`)

Modified: root `Cargo.toml` (add `crates/agentdock-store` to members).

## 4. Public types and signatures

```rust
// lib.rs
pub struct Store { /* Mutex<rusqlite::Connection>, lock file handle, hub, path */ }
pub struct OpenOptions { pub path: PathBuf, pub authority: AuthorityId /* local */ }

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("database is locked by another AgentDock process")] AlreadyOpen,
    #[error("database failed integrity check; a copy was kept at {backup}")] Corrupt { backup: PathBuf },
    #[error("database schema version {found} is newer than this build supports ({supported})")] TooNew { found: i64, supported: i64 },
    #[error("migration {version} failed; database restored from {backup}")] Migration { version: i64, backup: PathBuf },
    #[error("event rejected: {0}")] Rejected(String),          // envelope/body/projector refusal
    #[error("busy: another writer held the lock too long")] Busy,
    #[error(transparent)] Sqlite(#[from] rusqlite::Error),
    #[error(transparent)] Io(#[from] std::io::Error),
}
pub type Result<T> = std::result::Result<T, Error>;

impl Store {
    pub fn open(opts: OpenOptions) -> Result<Store>;
    pub fn open_with(opts: OpenOptions, projector: Box<dyn Projector>, migrations: &'static [Migration]) -> Result<Store>; // tests inject
    /// One BEGIN IMMEDIATE transaction. Events appended inside become visible to subscribers only after COMMIT.
    /// Blocking: call from a dedicated thread or spawn_blocking, never on a tokio worker thread.
    pub fn transact<T>(&self, f: impl FnOnce(&mut Tx<'_>) -> Result<T>) -> Result<T>;
    pub fn events_after(&self, authority: &AuthorityId, after_seq: u64, limit: usize) -> Result<Vec<EventEnvelope>>;
    pub fn head_seq(&self, authority: &AuthorityId) -> Result<u64>;
    pub fn subscribe(&self) -> Subscription;   // bounded (2048); overflow -> StreamItem::Lagged{resume_after_seq}
    pub fn path(&self) -> &Path;
}

/// What callers append. id and occurred_at come from the caller; seq and recorded_at are set by the store.
pub struct NewEvent {
    pub envelope: EventEnvelope, // seq must be 0
}

pub struct Tx<'c> { /* &rusqlite::Transaction, authority, pending published events */ }
impl Tx<'_> {
    /// Validates envelope (P2-1) and body (P2-2, rejects Opaque), assigns seq = head+1,
    /// sets recorded_at = max(now, last recorded_at), inserts, calls projector.apply(...).
    pub fn append(&mut self, ev: NewEvent) -> Result<EventEnvelope>;
    pub fn sql(&self) -> &rusqlite::Transaction<'_>;  // for the projector / queries in the same tx
}

pub trait Projector: Send + Sync {
    /// Called inside the transaction after the event row is inserted. Returning Err rolls back the whole transaction.
    fn apply(&self, tx: &rusqlite::Transaction<'_>, event: &EventEnvelope, body: &EventBody) -> std::result::Result<(), String>;
}
pub struct NoopProjector;

pub struct Migration { pub version: i64, pub sql: &'static str }
pub static MIGRATIONS: &[Migration]; // [Migration { version: 1, sql: include_str!("migrations/0001_init.sql") }]

pub enum StreamItem { Events(Vec<EventEnvelope>), Lagged { resume_after_seq: u64 } }
pub struct Subscription { /* tokio::sync::broadcast::Receiver */ }
impl Subscription { pub async fn next(&mut self) -> Option<StreamItem>; }
```

`0001_init.sql` (minimum):

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE events (
  authority_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1 AND seq <= 9007199254740991),
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  project_id TEXT, task_id TEXT, session_id TEXT,
  actor_kind TEXT NOT NULL, provenance TEXT NOT NULL,
  occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  PRIMARY KEY (authority_id, seq)
) STRICT, WITHOUT ROWID;
CREATE INDEX events_task ON events(task_id, seq);
CREATE INDEX events_session ON events(session_id, seq);
-- append-only: no UPDATE/DELETE except future tombstoning (not in this packet)
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
-- projection tables are created empty here and filled by P2-5:
CREATE TABLE projects (...); CREATE TABLE tasks (...); CREATE TABLE sessions (...);
CREATE TABLE approvals (...); CREATE TABLE operations (...); CREATE TABLE checks (...);
```

Projection columns follow `docs/architecture.md` lines 51–61 and the schema definitions `Project`, `Task`, `Session`, `Approval`, `Operation`, `Check`. `operations` gets a partial unique index:
`CREATE UNIQUE INDEX operations_live_key ON operations(idempotency_key) WHERE state IN ('recorded','started','succeeded','reconciled_applied');`
(ADR-0003 §9: "unique key enforced in the append transaction, including concurrent writers".)

## 5. Implementation steps

1. Write the §6 tests first.
2. `open.rs`:
   1. Create the parent directory.
   2. Take an exclusive lock on `<db>.lock` with `std::fs::File::try_lock()` (stable since Rust 1.89); failure → `AlreadyOpen`. Write the process id into the lock file for diagnostics only; **never decide based on it**.
   3. Open the connection, set pragmas. If `PRAGMA quick_check` is not `ok`, copy the file with the SQLite backup API to `<db>.corrupt-<UTC time>.bak` and return `Corrupt`. **Never delete the original or auto-repair.**
3. `migrate.rs`: read `PRAGMA user_version`. Greater than the newest → `TooNew`. Smaller and the database is non-empty → back up with the backup API to `<db>.pre-v<target>-<UTC time>.bak`, then run migrations in order inside one transaction and update `user_version`; on failure roll back and return `Migration{backup}`.
4. `append.rs`: `transact` uses `TransactionBehavior::Immediate`; `SQLITE_BUSY` beyond busy_timeout → `Busy` (no unbounded retries). `Tx::append` follows the order in §4; only after a successful commit are the accumulated events sent to the hub.
5. `subscribe.rs`: `tokio::sync::broadcast::channel(2048)`; the receiver maps `RecvError::Lagged` to `StreamItem::Lagged{resume_after_seq: last delivered seq}`. A failed `send` (no subscribers) is ignored.
6. `agentdock-store-append-loop`: open the store at the path in `argv[1]`, append test events in an endless loop, and print the last committed seq to stdout (one line per event, flushed).

## 6. Tests to write first

| File / name | How | Expected |
| --- | --- | --- |
| `append_seq::seq_is_gap_free_under_threads` | 8 threads share `Arc<Store>`, 500 appends each | `events_after(local,0,∞)` seqs are exactly 1..=4000, no duplicates, no gaps |
| `append_seq::recorded_at_non_decreasing` | append in order while the caller passes earlier `occurred_at` values (simulated clock going back) | `recorded_at` non-decreasing by seq; `occurred_at <= recorded_at` |
| `append_seq::rejects_opaque_and_bad_envelope` | append an unknown `type`; an event with `seq != 0`; a `system.*` with `task_id` | all `Rejected`; head_seq unchanged |
| `append_seq::projector_error_rolls_back_whole_batch` | projector returns Err on the 3rd of 5 appends in one `transact` | 0 rows written; subscribers see nothing |
| `append_seq::subscribers_see_only_committed` | append inside `transact`, then return Err from the closure | subscriber receives nothing |
| `append_seq::slow_subscriber_gets_lagged` | subscribe, do not read, append 3000 | first `next()` is `Lagged{resume_after_seq}`; `events_after(resume_after_seq)` fills the gap |
| `append_seq::events_table_is_append_only` | via `tx.sql()` try `UPDATE events ...` and `DELETE FROM events` | SQLite error containing `append-only` |
| `append_seq::duplicate_live_idempotency_key_rejected` | insert two `operations` rows directly, same key, state `recorded` | second violates the unique index |
| `lock_and_migrate::second_open_is_refused` | open the same path twice | second is `AlreadyOpen`; after dropping the first, opening works |
| `lock_and_migrate::lock_released_when_process_dies` | child (`append-loop`) opens, then is killed | parent `open` then succeeds |
| `lock_and_migrate::upgrade_backs_up_and_keeps_data` | `open_with` v1 only, write 10; reopen with `[v1, v2 (test-only: ALTER TABLE meta ADD COLUMN x)]` | backup exists, opens, has 10 events; new db `user_version=2` with 10 events |
| `lock_and_migrate::failed_migration_restores` | v2 SQL deliberately broken | `Migration{backup}`; `user_version` still 1; data intact |
| `lock_and_migrate::too_new_is_refused` | set `PRAGMA user_version=99` manually | `TooNew{found:99}`; file unchanged (compare mtime and size) |
| `lock_and_migrate::corrupt_file_is_kept` | file whose first 100 bytes are a SQLite header followed by garbage | `Corrupt{backup}`; original still present |
| `kill_during_append::no_gap_after_hard_kill` | start `append-loop`, once it prints seq ≥ 200 call `Child::kill()` (SIGKILL on Linux, TerminateProcess on Windows); reopen | every row parses; seqs are 1..=N contiguous; N ≥ the last seq the child printed (committed data not lost) |

Every test uses a temp directory whose path contains a space and CJK characters (CONVENTIONS §5).

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-store            # 15 tests pass
cargo clippy -p agentdock-store --all-targets -- -D warnings
cargo run -p agentdock-store --bin agentdock-store-append-loop -- "/tmp/agent dock 測試/x.db"
# manual: prints increasing seqs; stop with Ctrl+C; rerun continues from the next seq
```

Windows-only (CI `rust-windows`): the same 15 tests must pass on `windows-latest` (TerminateProcess path, file lock semantics, antivirus on `-wal`/`-shm`). Check with `gh pr checks <PR> --repo ChiJiun/agentdock`.

## 8. Spec references and porting sources

All line numbers refer to main `c9e33cf` unless noted.

- `docs/contracts/checkpoint-and-replay.md` "Durability ordering" (lines 20–35: BEGIN IMMEDIATE, projections updated in the same transaction, publish after commit).
- `docs/contracts/events.md` "Cursor" (lines 79–85), "Subscriptions and backpressure" (lines 87–104: `lagged`, batch limit 256 events or 512 KiB).
- ADR-0003 §4; §9 table rows "Non-repeatable operations" (unique key including concurrent writers) and "Log shape and order" (transaction tests).
- Issue #7 Requirements 1, 2, 7 (versioned migrations, ordered events and cursors, backup and graceful errors on corruption/upgrade).
- Behavior references (Node drafts, read for test ideas only; do not port code): PR #25, branch per ADR-0004 table, SHA `7d41c9f1`, `apps/runtime/runtime.test.mjs` line 383 ("a second host cannot take over a database that a live host owns"), `docs/implementation/live-acp-runtime.md` lines 22, 94 (single-host lock); PR #29, SHA `c57b824d`, `apps/runtime/task-workflow.test.mjs` line 394 (append-only triggers, failed writes roll back), line 482 (write-lock timeout returns a retryable error with no partial changes), line 497 (old schema upgrade, old evidence not trusted).

## 9. Dependencies

| Crate | Version | Status |
| --- | --- | --- |
| `rusqlite` (features `bundled`, `backup`) | 0.43.0 (MSRV 1.89) | needs audit (`bundled` compiles SQLite C sources: needs `build-essential` on Linux, MSVC on Windows) |
| `tokio` (features `sync`) | 1.54.1 | needs audit |
| `thiserror` | 2.0.21 | needs audit |
| `tempfile` (dev) | 3.27.0 | needs audit |

No `rusqlite_migration` (hand-written `user_version` migrations are enough; one dependency fewer).

## 10. Model tier

Strong model implements and reviews: transaction boundaries, publish-after-commit, locks and hard-kill tests are easy to get "passes normally, corrupts on crash".

## 11. Common mistakes and pitfalls

- `SELECT MAX(seq)+1` outside `BEGIN IMMEDIATE`: two writers get the same seq. Always IMMEDIATE.
- `broadcast::send` before commit: violates persist_then_report.
- `busy_timeout` waits synchronously; never call `transact` on a tokio worker thread. Document it on the API.
- On Windows, antivirus may lock `-wal`/`-shm`; back up with the SQLite backup API, never by copying the `.db` file (in WAL mode a raw copy can miss data).
- `File::try_lock` is unreliable on network drives; document that network drives are unsupported (the app data path is chosen by P3-7).
- Never set `journal_mode=OFF` or `synchronous=OFF` to speed up tests.

## 12. Reviewer checklist

- [ ] Is every append inside `BEGIN IMMEDIATE`, and is broadcasting strictly after commit?
- [ ] Does a projector error or closure error roll back every event of the transaction?
- [ ] Does the hard-kill test actually kill (not ask to exit), and check contiguity and N ≥ last printed seq?
- [ ] Are backups made with the backup API, and is a corrupt or too-new file never modified?
- [ ] Is the lock an OS lock released on process death, not a PID check?
- [ ] Is the partial unique index on live idempotency keys present?
