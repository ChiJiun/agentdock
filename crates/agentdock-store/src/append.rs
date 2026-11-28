//! `Store::transact` and `Tx::append`: the only write path for events.

use agentdock_core::{decode_body, encode_body, AuthorityId, EventBody, EventEnvelope, Timestamp};
use rusqlite::{params, TransactionBehavior};
use serde::Serialize;

use crate::error::{busy_or, Error, Result};
use crate::subscribe::Published;
use crate::{read, Inner, Projector, Store};

/// What callers append. `id` and `occurred_at` come from the caller; `seq` and `recorded_at`
/// are set by the store.
pub struct NewEvent {
    /// `seq` must be 0.
    pub envelope: EventEnvelope,
}

/// One open `BEGIN IMMEDIATE` transaction (see [`Store::transact`]).
pub struct Tx<'c> {
    sql: rusqlite::Transaction<'c>,
    authority: &'c AuthorityId,
    projector: &'c dyn Projector,
    head: u64,
    last_recorded: Option<Timestamp>,
    pending: Vec<Published>,
    /// Set when an append failed after its row was inserted; the transaction can then only roll
    /// back, whatever the closure returns.
    failed: Option<String>,
}

impl Store {
    /// One `BEGIN IMMEDIATE` transaction. Events appended inside become visible to subscribers
    /// only after `COMMIT`. If `f` returns `Err`, or any append inside failed after inserting its
    /// row (for example a projector refusal), every event of the transaction is rolled back.
    ///
    /// Blocking: call from a dedicated thread or `spawn_blocking`, never on a tokio worker
    /// thread. `f` must not call other `Store` methods (the connection is held); use `tx`.
    pub fn transact<T>(&self, f: impl FnOnce(&mut Tx<'_>) -> Result<T>) -> Result<T> {
        let mut guard = self.lock();
        let Inner { conn, head } = &mut *guard;
        let sql = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(busy_or)?;
        let db_head = read::head_seq(&sql, &self.authority)?;
        let last_recorded = read::last_recorded_at(&sql, &self.authority)?;
        let mut tx = Tx {
            sql,
            authority: &self.authority,
            projector: self.projector.as_ref(),
            head: db_head,
            last_recorded,
            pending: Vec::new(),
            failed: None,
        };
        let out = f(&mut tx);
        let Tx {
            sql,
            head: new_head,
            pending,
            failed,
            ..
        } = tx;
        // Returning early drops `sql`, which rolls the transaction back.
        let value = out?;
        if let Some(reason) = failed {
            return Err(Error::Rejected(reason));
        }
        sql.commit().map_err(busy_or)?;
        *head = new_head;
        // Still under the connection mutex, so subscribers receive commits in `seq` order.
        self.hub.publish(pending);
        Ok(value)
    }
}

impl Tx<'_> {
    /// Validates envelope (P2-1) and body (P2-2, rejects `Opaque` and non-canonical payloads),
    /// assigns `seq = head + 1`, sets `recorded_at = max(now, last recorded_at)`, inserts, calls
    /// the projector.
    pub fn append(&mut self, ev: NewEvent) -> Result<EventEnvelope> {
        if let Some(reason) = &self.failed {
            return Err(Error::Rejected(format!(
                "an earlier append in this transaction failed: {reason}"
            )));
        }
        let mut env = ev.envelope;
        let body = self.check(&env)?;

        let now = Timestamp::now();
        let recorded_at = match self.last_recorded {
            Some(last) if last > now => last,
            _ => now,
        };
        env.seq = self.head + 1;
        env.recorded_at = recorded_at;
        env.validate().map_err(|e| Error::Rejected(e.to_string()))?;
        let json = serde_json::to_string(&env).map_err(|e| Error::Rejected(e.to_string()))?;

        if let Err(e) = self.insert_and_project(&env, &body, &json) {
            self.failed = Some(e.to_string());
            return Err(e);
        }
        self.head = env.seq;
        self.last_recorded = Some(recorded_at);
        self.pending.push(Published {
            env: env.clone(),
            bytes: json.len(),
        });
        Ok(env)
    }

    /// For the projector and for queries in the same transaction.
    pub fn sql(&self) -> &rusqlite::Transaction<'_> {
        &self.sql
    }

    /// Checks that need no database access. Returns the typed body.
    fn check(&self, env: &EventEnvelope) -> Result<EventBody> {
        let reject = |msg: String| Err(Error::Rejected(msg));
        if env.seq != 0 {
            return reject(format!(
                "seq must be 0 (the store assigns it), got {}",
                env.seq
            ));
        }
        if env.authority_id != *self.authority {
            return reject(format!(
                "authority_id {} is not this store's authority {}",
                env.authority_id.as_str(),
                self.authority.as_str()
            ));
        }
        // Tombstoning rewrites existing rows when a task is deleted (not in this schema
        // version); a tombstone is never appended.
        if env.tombstone.is_some() {
            return reject(format!(
                "{}: tombstoned events cannot be appended",
                env.event_type
            ));
        }
        let body = decode_body(env).map_err(|e| Error::Rejected(e.to_string()))?;
        if body.is_opaque() {
            return reject(format!(
                "unknown event type {} cannot be appended",
                env.event_type
            ));
        }
        // Reads are lenient (unknown fields, `null` optionals, structs as arrays). The writer
        // contract (`additionalProperties: false`, never `null`) holds only if the stored payload
        // is exactly what the typed body encodes to.
        let (event_type, payload) = encode_body(&body);
        if event_type != env.event_type || payload != env.payload {
            return reject(format!(
                "{}: payload is not in canonical form (unknown field, null or non-object value)",
                env.event_type
            ));
        }
        Ok(body)
    }

    fn insert_and_project(&self, env: &EventEnvelope, body: &EventBody, json: &str) -> Result<()> {
        let seq = i64::try_from(env.seq).map_err(|e| Error::Rejected(e.to_string()))?;
        self.sql.execute(
            "INSERT INTO events (authority_id, seq, id, type, project_id, task_id, session_id, \
             actor_kind, provenance, occurred_at, recorded_at, envelope_json) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                env.authority_id.as_str(),
                seq,
                env.id.as_str(),
                env.event_type.as_str(),
                env.project_id.as_ref().map(|id| id.as_str()),
                env.task_id.as_ref().map(|id| id.as_str()),
                env.session_id.as_ref().map(|id| id.as_str()),
                enum_name(&env.actor.kind)?,
                enum_name(&env.provenance)?,
                env.occurred_at.to_rfc3339_millis(),
                env.recorded_at.to_rfc3339_millis(),
                json,
            ],
        )?;
        self.projector
            .apply(&self.sql, env, body)
            .map_err(|reason| Error::Rejected(format!("projector: {reason}")))
    }
}

/// The `snake_case` name a contract enum serializes to.
fn enum_name<T: Serialize>(value: &T) -> Result<String> {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(s)) => Ok(s),
        Ok(other) => Err(Error::Rejected(format!(
            "expected an enum name, got {other}"
        ))),
        Err(e) => Err(Error::Rejected(e.to_string())),
    }
}
