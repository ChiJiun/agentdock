//! Append path: gap-free seq, recorded_at order, rejection, rollback, publish after commit.

use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

use agentdock_core::payload::task::AutoResumePolicy;
use agentdock_core::payload::{RecoveryStartedPayload, TaskCreatedPayload};
use agentdock_core::{
    Actor, ActorKind, AuthorityId, EventBody, EventEnvelope, EventType, ProjectId, Redaction,
    TaskId, TaskState, Timestamp, Tombstone,
};
use agentdock_store::{
    Error, NewEvent, NoopProjector, OpenOptions, Projector, Store, StreamItem, Subscription,
    MIGRATIONS,
};
use rusqlite::params;
use serde_json::json;
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

fn open(dir: &TempDir) -> Store {
    Store::open(opts(&db_path(dir))).unwrap()
}

fn local() -> AuthorityId {
    AuthorityId::local()
}

fn task_created(objective: &str, occurred_at: Timestamp) -> EventEnvelope {
    let body = EventBody::TaskCreated(TaskCreatedPayload {
        objective: objective.to_owned(),
        state: TaskState::Queued,
        issue_url: None,
        branch: None,
        worktree_path: None,
        auto_resume_policy: AutoResumePolicy {
            on_quota_reset: false,
            on_rate_limit: false,
        },
    });
    EventEnvelope::new_live(
        local(),
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
        occurred_at,
        occurred_at,
    )
}

fn ev() -> NewEvent {
    NewEvent {
        envelope: task_created("x", Timestamp::now()),
    }
}

fn append_one(store: &Store, env: EventEnvelope) -> agentdock_store::Result<EventEnvelope> {
    store.transact(|tx| tx.append(NewEvent { envelope: env }))
}

fn all(store: &Store) -> Vec<EventEnvelope> {
    store.events_after(&local(), 0, usize::MAX).unwrap()
}

/// Everything a subscriber can get is sent before `transact` returns, so one poll decides.
fn poll_now(sub: &mut Subscription) -> Poll<Option<StreamItem>> {
    let mut fut = std::pin::pin!(sub.next());
    fut.as_mut().poll(&mut Context::from_waker(Waker::noop()))
}

fn rejected(r: agentdock_store::Result<EventEnvelope>) -> String {
    match r {
        Err(Error::Rejected(msg)) => msg,
        other => panic!("expected Rejected, got {other:?}"),
    }
}

#[test]
fn seq_is_gap_free_under_threads() {
    let dir = temp();
    let store = Arc::new(open(&dir));
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let store = Arc::clone(&store);
            std::thread::spawn(move || {
                for _ in 0..500 {
                    store.transact(|tx| tx.append(ev())).unwrap();
                }
            })
        })
        .collect();
    for t in threads {
        t.join().unwrap();
    }
    let events = all(&store);
    let seqs: Vec<u64> = events.iter().map(|e| e.seq).collect();
    assert_eq!(seqs, (1..=4000).collect::<Vec<u64>>());
    let ids: HashSet<_> = events.iter().map(|e| e.id.clone()).collect();
    assert_eq!(ids.len(), 4000);
    assert_eq!(store.head_seq(&local()).unwrap(), 4000);
}

#[test]
fn recorded_at_non_decreasing() {
    let dir = temp();
    let store = open(&dir);
    // The caller's clock goes back on every event.
    for i in 0..20 {
        let occurred = Timestamp::parse(&format!("2020-01-01T00:00:{:02}.000Z", 59 - i)).unwrap();
        append_one(&store, task_created("x", occurred)).unwrap();
    }
    // The store's own clock going back: the last recorded_at is in the future.
    let future = Timestamp::parse("2999-01-01T00:00:00.000Z").unwrap();
    store
        .transact(|tx| {
            let mut env = task_created("x", future);
            env.seq = 21;
            tx.sql().execute(
                "INSERT INTO events (authority_id, seq, id, type, actor_kind, provenance, \
                 occurred_at, recorded_at, envelope_json) \
                 VALUES ('local', 21, ?1, 'task.created', 'user', 'live', ?2, ?2, ?3)",
                params![
                    env.id.as_str(),
                    future.to_rfc3339_millis(),
                    serde_json::to_string(&env).unwrap()
                ],
            )?;
            Ok(())
        })
        .unwrap();
    let after = append_one(&store, task_created("x", Timestamp::now())).unwrap();
    assert_eq!(after.seq, 22);
    assert_eq!(after.recorded_at, future);

    let events = all(&store);
    assert_eq!(events.len(), 22);
    for pair in events.windows(2) {
        assert!(pair[0].recorded_at <= pair[1].recorded_at, "{pair:?}");
    }
    for e in &events {
        assert!(e.occurred_at <= e.recorded_at);
    }
}

#[test]
fn rejects_opaque_and_bad_envelope() {
    let dir = temp();
    let store = open(&dir);
    append_one(&store, task_created("x", Timestamp::now())).unwrap();

    let mut unknown = task_created("x", Timestamp::now());
    unknown.event_type = EventType::from_name("future.thing_happened");
    unknown.payload = json!({});
    assert!(rejected(append_one(&store, unknown)).contains("unknown event type"));

    let mut with_seq = task_created("x", Timestamp::now());
    with_seq.seq = 5;
    assert!(rejected(append_one(&store, with_seq)).contains("seq must be 0"));

    let now = Timestamp::now();
    let mut system = EventEnvelope::new_live(
        local(),
        None,
        None,
        None,
        Actor {
            kind: ActorKind::Recovery,
            id: None,
        },
        &EventBody::SystemRecoveryStarted(RecoveryStartedPayload {
            previous_run_id: "run-1".to_owned(),
            last_seq_before_crash: 1,
        }),
        Redaction {
            policy_version: 1,
            applied_rules: vec![],
        },
        now,
        now,
    );
    system.task_id = Some(TaskId::generate());
    assert!(rejected(append_one(&store, system)).contains("system.*"));

    assert_eq!(store.head_seq(&local()).unwrap(), 1);
    assert_eq!(all(&store).len(), 1);
}

#[test]
fn rejects_non_canonical_payload_tombstone_and_foreign_authority() {
    let dir = temp();
    let store = open(&dir);
    let base = || task_created("x", Timestamp::now());

    // Reads accept these; the writer contract does not.
    let mut extra = base();
    extra.payload["added_by_hand"] = json!(1);
    let mut null_optional = base();
    null_optional.payload["issue_url"] = serde_json::Value::Null;
    let mut struct_as_array = base();
    struct_as_array.payload["auto_resume_policy"] = json!([false, false]);
    for env in [extra, null_optional, struct_as_array] {
        let payload = env.payload.clone();
        assert!(env.body().is_ok(), "the lenient reader accepts {payload}");
        assert!(
            rejected(append_one(&store, env)).contains("canonical form"),
            "{payload}"
        );
    }

    // No tombstone is ever appended, on any type (task.deleted and system.* included).
    let tombstone = Tombstone {
        reason: "task_deleted".to_owned(),
        at: Timestamp::now(),
    };
    for ty in ["task.created", "task.deleted", "system.recovery_completed"] {
        let mut env = base();
        env.event_type = EventType::from_name(ty);
        env.payload = json!({});
        env.tombstone = Some(tombstone.clone());
        if ty.starts_with("system.") {
            env.project_id = None;
            env.task_id = None;
        }
        assert!(
            rejected(append_one(&store, env)).contains("tombstone"),
            "{ty}"
        );
    }

    let mut foreign = base();
    foreign.authority_id = AuthorityId::parse("remote:worker-1").unwrap();
    assert!(rejected(append_one(&store, foreign)).contains("authority"));

    assert_eq!(store.head_seq(&local()).unwrap(), 0);
}

/// Writes every event into `meta` (a projection stand-in) and refuses objective "refuse".
struct RefusingProjector;

impl Projector for RefusingProjector {
    fn apply(
        &self,
        tx: &rusqlite::Transaction<'_>,
        event: &EventEnvelope,
        body: &EventBody,
    ) -> Result<(), String> {
        tx.execute(
            "INSERT INTO meta (key, value) VALUES (?1, 'projected')",
            [event.id.as_str()],
        )
        .map_err(|e| e.to_string())?;
        match body {
            EventBody::TaskCreated(p) if p.objective == "refuse" => Err("refused".to_owned()),
            _ => Ok(()),
        }
    }
}

#[test]
fn projector_error_rolls_back_whole_batch() {
    let dir = temp();
    let store = Store::open_with(
        opts(&db_path(&dir)),
        Box::new(RefusingProjector),
        MIGRATIONS,
    )
    .unwrap();
    let mut sub = store.subscribe();
    let objective = |i: usize| if i == 2 { "refuse" } else { "ok" };

    let err = store
        .transact(|tx| {
            for i in 0..5 {
                tx.append(NewEvent {
                    envelope: task_created(objective(i), Timestamp::now()),
                })?;
            }
            Ok(())
        })
        .unwrap_err();
    assert!(
        matches!(&err, Error::Rejected(m) if m.contains("refused")),
        "{err:?}"
    );

    // A closure that swallows the refusal still cannot commit.
    let err = store
        .transact(|tx| {
            for i in 0..5 {
                let _ = tx.append(NewEvent {
                    envelope: task_created(objective(i), Timestamp::now()),
                });
            }
            Ok(())
        })
        .unwrap_err();
    assert!(
        matches!(&err, Error::Rejected(m) if m.contains("refused")),
        "{err:?}"
    );

    assert_eq!(store.head_seq(&local()).unwrap(), 0);
    assert!(all(&store).is_empty());
    let projected: i64 = store
        .transact(|tx| {
            Ok(tx
                .sql()
                .query_row("SELECT count(*) FROM meta", [], |r| r.get(0))?)
        })
        .unwrap();
    assert_eq!(projected, 0);
    assert!(poll_now(&mut sub).is_pending());
}

#[test]
fn subscribers_see_only_committed() {
    let dir = temp();
    let store = open(&dir);
    let mut sub = store.subscribe();
    let err = store
        .transact(|tx| {
            tx.append(ev())?;
            tx.append(ev())?;
            Err::<(), _>(Error::Rejected("caller aborted".to_owned()))
        })
        .unwrap_err();
    assert!(matches!(err, Error::Rejected(_)));
    assert!(poll_now(&mut sub).is_pending());
    assert_eq!(store.head_seq(&local()).unwrap(), 0);

    // Positive control: a committed event arrives, with the seq the rollback did not consume.
    append_one(&store, task_created("x", Timestamp::now())).unwrap();
    match poll_now(&mut sub) {
        Poll::Ready(Some(StreamItem::Events(batch))) => {
            assert_eq!(batch.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![1]);
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn slow_subscriber_gets_lagged() {
    let dir = temp();
    let store = open(&dir);
    let mut never_reads = store.subscribe();
    let mut reads_some = store.subscribe();
    let append_n = |n: usize| {
        for _ in 0..n / 100 {
            store
                .transact(|tx| {
                    for _ in 0..100 {
                        tx.append(ev())?;
                    }
                    Ok(())
                })
                .unwrap();
        }
    };

    append_n(100);
    match poll_now(&mut reads_some) {
        Poll::Ready(Some(StreamItem::Events(batch))) => {
            assert_eq!(batch.len(), 100);
            assert_eq!(batch.last().unwrap().seq, 100);
        }
        other => panic!("{other:?}"),
    }
    append_n(3000);

    let Poll::Ready(Some(StreamItem::Lagged { resume_after_seq })) = poll_now(&mut never_reads)
    else {
        panic!("expected Lagged");
    };
    assert_eq!(resume_after_seq, 0);
    let refill = store
        .events_after(&local(), resume_after_seq, usize::MAX)
        .unwrap();
    assert_eq!(
        refill.iter().map(|e| e.seq).collect::<Vec<_>>(),
        (1..=3100).collect::<Vec<u64>>()
    );
    // The live stream of a lagged subscriber has ended.
    assert!(matches!(poll_now(&mut never_reads), Poll::Ready(None)));

    assert!(matches!(
        poll_now(&mut reads_some),
        Poll::Ready(Some(StreamItem::Lagged {
            resume_after_seq: 100
        }))
    ));

    // A fresh subscriber receives batches capped at 256 events, in order.
    let mut fresh = store.subscribe();
    append_n(300);
    let mut seen = Vec::new();
    while let Poll::Ready(Some(StreamItem::Events(batch))) = poll_now(&mut fresh) {
        assert!(batch.len() <= 256);
        seen.extend(batch.iter().map(|e| e.seq));
    }
    assert_eq!(seen, (3101..=3400).collect::<Vec<u64>>());
}

#[test]
fn events_table_is_append_only() {
    let dir = temp();
    let store = open(&dir);
    append_one(&store, task_created("x", Timestamp::now())).unwrap();
    store
        .transact(|tx| {
            for stmt in ["UPDATE events SET type = 'x'", "DELETE FROM events"] {
                let err = tx.sql().execute(stmt, []).unwrap_err();
                assert!(err.to_string().contains("append-only"), "{stmt}: {err}");
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(all(&store).len(), 1);
}

#[test]
fn direct_insert_with_gap_is_refused() {
    let dir = temp();
    let store = open(&dir);
    let err = store
        .transact(|tx| {
            tx.sql().execute(
                "INSERT INTO events (authority_id, seq, id, type, actor_kind, provenance, \
                 occurred_at, recorded_at, envelope_json) \
                 VALUES ('local', 2, 'evt_x', 'task.created', 'user', 'live', 't', 't', '{}')",
                [],
            )?;
            Ok(())
        })
        .unwrap_err();
    assert!(err.to_string().contains("gap-free"), "{err}");
    assert_eq!(store.head_seq(&local()).unwrap(), 0);
}

#[test]
fn duplicate_live_idempotency_key_rejected() {
    let dir = temp();
    let store = open(&dir);
    const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";
    store
        .transact(|tx| {
            let insert = |id: &str, state: &str| {
                tx.sql().execute(
                    "INSERT INTO operations (operation_id, task_id, kind, repeatability, \
                     idempotency_key, target_json, approval_id, reconcile_strategy, state, \
                     attempt_count) VALUES (?1, 'tsk_x', 'git_push', 'non_repeatable', ?2, '{}', \
                     'apr_x', 'probe_remote', ?3, 0)",
                    params![id, KEY, state],
                )
            };
            insert("op_1", "recorded").unwrap();
            let err = insert("op_2", "recorded").unwrap_err();
            assert!(err.to_string().contains("UNIQUE"), "{err}");
            // The index covers only states where a second attempt is never allowed.
            insert("op_3", "failed").unwrap();
            insert("op_4", "outcome_unknown").unwrap();
            Ok(())
        })
        .unwrap();
}

#[test]
fn writer_lock_held_elsewhere_gives_busy() {
    let dir = temp();
    let path = db_path(&dir);
    let store = Store::open_with(opts(&path), Box::new(NoopProjector), MIGRATIONS).unwrap();
    // A non-AgentDock connection (for example a DB browser) holds the write lock.
    let other = rusqlite::Connection::open(&path).unwrap();
    other.execute_batch("BEGIN IMMEDIATE").unwrap();
    let started = Instant::now();
    let err = store.transact(|tx| tx.append(ev())).unwrap_err();
    let waited = started.elapsed();
    assert!(matches!(err, Error::Busy), "{err:?}");
    assert!(waited >= Duration::from_millis(2500), "{waited:?}");
    assert!(waited < Duration::from_secs(20), "{waited:?}");
    other.execute_batch("ROLLBACK").unwrap();
    assert_eq!(store.transact(|tx| tx.append(ev())).unwrap().seq, 1);
}
