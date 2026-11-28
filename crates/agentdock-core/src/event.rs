//! `EventEnvelope` (ADR-0003 section 4, `docs/contracts/events.md` "Envelope").
//!
//! The payload stays a `serde_json::Value`; typed payloads and per-type payload rules are P2-2.
//! Reads tolerate unknown fields and unknown event types. `validate()` checks only the
//! envelope-level rules of the "Envelope" table, and is a separate step from deserialization so a
//! reader can still load (and report on) an event that violates a rule.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::enums::{ActorKind, EventType, Provenance};
use crate::ids::{AuthorityId, EventId, ProjectId, SessionId, TaskId};
use crate::time::Timestamp;
use crate::SCHEMA_VERSION;

/// Highest `seq`: 2^53 - 1, so a TypeScript `number` stays exact.
pub const MAX_SEQ: u64 = (1 << 53) - 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Actor {
    pub kind: ActorKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Redaction {
    pub policy_version: u32,
    pub applied_rules: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tombstone {
    /// Always `task_deleted` in schema version 1.
    pub reason: String,
    pub at: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub schema_version: u32,
    pub id: EventId,
    pub authority_id: AuthorityId,
    /// `1..=2^53-1`; checked by [`EventEnvelope::validate`].
    pub seq: u64,
    pub occurred_at: Timestamp,
    pub recorded_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<ProjectId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<TaskId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    #[serde(rename = "type")]
    pub event_type: EventType,
    pub actor: Actor,
    pub provenance: Provenance,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub causation_id: Option<EventId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
    pub redaction: Redaction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tombstone: Option<Tombstone>,
    /// A JSON object; the typed view is added in P2-2.
    pub payload: Value,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum EnvelopeError {
    #[error("schema_version {0} is not supported")]
    SchemaVersion(u32),
    #[error("seq {0} out of range 1..=2^53-1")]
    SeqRange(u64),
    #[error("occurred_at is after recorded_at")]
    ClockOrder,
    #[error("system.* events must not carry project/task/session ids")]
    SystemRouting,
    #[error("non-system events require project_id and task_id")]
    MissingRouting,
    #[error("session_id required for {0}")]
    MissingSession(&'static str),
    #[error("actor recovery requires provenance recovery and vice versa")]
    RecoveryProvenance,
    #[error("payload must be a JSON object")]
    PayloadNotObject,
    #[error("tombstoned events must have an empty payload")]
    TombstonePayload,
}

impl EventEnvelope {
    /// Envelope-level rules from `docs/contracts/events.md` "Envelope" table only. Per-type
    /// payload rules, the `acp_replay` type restriction and the state machines are checked by
    /// later packets. Rules are checked in the order of [`EnvelopeError`]'s variants.
    pub fn validate(&self) -> Result<(), EnvelopeError> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(EnvelopeError::SchemaVersion(self.schema_version));
        }
        if !(1..=MAX_SEQ).contains(&self.seq) {
            return Err(EnvelopeError::SeqRange(self.seq));
        }
        if self.occurred_at > self.recorded_at {
            return Err(EnvelopeError::ClockOrder);
        }

        let name = self.event_type.as_str();
        if name.starts_with("system.") {
            if self.project_id.is_some() || self.task_id.is_some() || self.session_id.is_some() {
                return Err(EnvelopeError::SystemRouting);
            }
        } else {
            if self.project_id.is_none() || self.task_id.is_none() {
                return Err(EnvelopeError::MissingRouting);
            }
            // `approval.*` may be task-scoped (host-policy approvals), so it is not listed.
            for (prefix, label) in [("session.", "session.*"), ("usage.", "usage.*")] {
                if name.starts_with(prefix) && self.session_id.is_none() {
                    return Err(EnvelopeError::MissingSession(label));
                }
            }
        }

        let recovery_actor = self.actor.kind == ActorKind::Recovery;
        let recovery_provenance = self.provenance == Provenance::Recovery;
        if recovery_actor != recovery_provenance {
            return Err(EnvelopeError::RecoveryProvenance);
        }

        let Some(payload) = self.payload.as_object() else {
            return Err(EnvelopeError::PayloadNotObject);
        };
        if self.tombstone.is_some() && !payload.is_empty() {
            return Err(EnvelopeError::TombstonePayload);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base() -> Value {
        json!({
            "schema_version": 1,
            "id": "evt_01JDQ001000000000000000007",
            "authority_id": "local",
            "seq": 7,
            "occurred_at": "2026-11-17T02:00:07.000Z",
            "recorded_at": "2026-11-17T02:00:07.000Z",
            "project_id": "prj_01JDQ001000000000000000001",
            "task_id": "tsk_01JDQ001000000000000000001",
            "type": "task.created",
            "actor": {"kind": "user", "id": "owner"},
            "provenance": "live",
            "redaction": {"policy_version": 1, "applied_rules": []},
            "payload": {}
        })
    }

    fn with(changes: Value) -> Value {
        let mut v = base();
        for (k, val) in changes.as_object().unwrap() {
            if val.is_null() {
                v.as_object_mut().unwrap().remove(k);
            } else {
                v[k] = val.clone();
            }
        }
        v
    }

    fn parse(v: &Value) -> EventEnvelope {
        serde_json::from_value(v.clone()).unwrap()
    }

    fn check(changes: Value) -> Result<(), EnvelopeError> {
        parse(&with(changes)).validate()
    }

    const SES: &str = "ses_01JDQ001000000000000000001";

    #[test]
    fn base_envelope_is_valid_and_roundtrips() {
        let env = parse(&base());
        assert_eq!(env.validate(), Ok(()));
        assert_eq!(serde_json::to_value(&env).unwrap(), base());
    }

    #[test]
    fn unknown_event_type_is_preserved() {
        let v = with(json!({"type": "future.thing_happened"}));
        let env = parse(&v);
        assert_eq!(
            env.event_type,
            EventType::Unknown("future.thing_happened".to_owned())
        );
        assert_eq!(serde_json::to_value(&env).unwrap(), v);
        assert_eq!(env.validate(), Ok(()));
    }

    #[test]
    fn unknown_fields_are_tolerated_on_read() {
        let v = with(json!({"added_by_newer_writer": {"x": 1}}));
        assert_eq!(parse(&v).validate(), Ok(()));
    }

    #[test]
    fn bad_values_fail_to_deserialize() {
        // In `with`, a null value removes the key, so `redaction`/`payload` test "missing".
        for changes in [
            json!({"id": "evt_bad"}),
            json!({"occurred_at": "2026-02-30T00:00:00.000Z"}),
            json!({"authority_id": "Local"}),
            json!({"provenance": "replayed"}),
            json!({"actor": {"kind": "agent"}}),
            json!({"seq": -1}),
            json!({"project_id": "tsk_01JDQ001000000000000000001"}),
            json!({"redaction": null}),
            json!({"payload": null}),
        ] {
            assert!(
                serde_json::from_value::<EventEnvelope>(with(changes.clone())).is_err(),
                "{changes}"
            );
        }
    }

    #[test]
    fn validate_rejects_unsupported_schema_version() {
        assert_eq!(
            check(json!({"schema_version": 2})),
            Err(EnvelopeError::SchemaVersion(2))
        );
        assert_eq!(
            check(json!({"schema_version": 0})),
            Err(EnvelopeError::SchemaVersion(0))
        );
    }

    #[test]
    fn validate_seq_range() {
        assert_eq!(check(json!({"seq": 0})), Err(EnvelopeError::SeqRange(0)));
        assert_eq!(check(json!({"seq": 1})), Ok(()));
        assert_eq!(check(json!({"seq": MAX_SEQ})), Ok(()));
        assert_eq!(
            check(json!({"seq": MAX_SEQ + 1})),
            Err(EnvelopeError::SeqRange(MAX_SEQ + 1))
        );
        assert_eq!(
            check(json!({"seq": u64::MAX})),
            Err(EnvelopeError::SeqRange(u64::MAX))
        );
    }

    #[test]
    fn validate_clock_order() {
        assert_eq!(
            check(json!({"occurred_at": "2026-11-17T02:00:07.001Z"})),
            Err(EnvelopeError::ClockOrder)
        );
        assert_eq!(
            check(json!({"occurred_at": "2026-11-17T02:00:06.999Z"})),
            Ok(())
        );
    }

    #[test]
    fn validate_rejects_system_event_with_task_id() {
        let system = json!({
            "type": "system.recovery_started",
            "project_id": null,
            "actor": {"kind": "recovery"},
            "provenance": "recovery"
        });
        assert_eq!(
            check(system.clone()).unwrap_err(),
            EnvelopeError::SystemRouting
        );
        let mut no_ids = system.clone();
        no_ids["task_id"] = Value::Null;
        assert_eq!(check(no_ids.clone()), Ok(()));
        for (key, id) in [
            ("project_id", "prj_01JDQ001000000000000000001"),
            ("session_id", SES),
        ] {
            let mut v = no_ids.clone();
            v[key] = json!(id);
            assert_eq!(check(v), Err(EnvelopeError::SystemRouting), "{key}");
        }
    }

    #[test]
    fn validate_requires_routing_for_non_system_events() {
        assert_eq!(
            check(json!({"project_id": null})),
            Err(EnvelopeError::MissingRouting)
        );
        assert_eq!(
            check(json!({"task_id": null})),
            Err(EnvelopeError::MissingRouting)
        );
        assert_eq!(
            check(json!({"type": "future.thing", "task_id": null})),
            Err(EnvelopeError::MissingRouting)
        );
    }

    #[test]
    fn validate_requires_session_for_session_and_usage_events() {
        for (ty, label) in [
            ("session.message_delta", "session.*"),
            ("session.created", "session.*"),
            ("usage.reported", "usage.*"),
        ] {
            assert_eq!(
                check(json!({"type": ty})),
                Err(EnvelopeError::MissingSession(label)),
                "{ty}"
            );
            assert_eq!(
                check(json!({"type": ty, "session_id": SES})),
                Ok(()),
                "{ty}"
            );
        }
        // approval.* may be task-scoped.
        assert_eq!(check(json!({"type": "approval.requested"})), Ok(()));
    }

    #[test]
    fn validate_rejects_recovery_actor_with_live_provenance() {
        assert_eq!(
            check(json!({"actor": {"kind": "recovery"}, "provenance": "live"})),
            Err(EnvelopeError::RecoveryProvenance)
        );
        assert_eq!(
            check(json!({"actor": {"kind": "orchestrator"}, "provenance": "recovery"})),
            Err(EnvelopeError::RecoveryProvenance)
        );
        assert_eq!(
            check(json!({"actor": {"kind": "recovery"}, "provenance": "recovery"})),
            Ok(())
        );
    }

    #[test]
    fn validate_payload_must_be_object() {
        for bad in [json!([]), json!("x"), json!(1), json!(true)] {
            assert_eq!(
                check(json!({"payload": bad})),
                Err(EnvelopeError::PayloadNotObject)
            );
        }
        // `null` is "remove the key" in `with`, so build this one by hand.
        let mut v = base();
        v["payload"] = Value::Null;
        assert_eq!(parse(&v).validate(), Err(EnvelopeError::PayloadNotObject));
    }

    #[test]
    fn validate_tombstone_requires_empty_payload() {
        let tomb = json!({"reason": "task_deleted", "at": "2026-11-17T03:00:00.000Z"});
        assert_eq!(check(json!({"tombstone": tomb})), Ok(()));
        assert_eq!(
            check(json!({"tombstone": tomb, "payload": {"a": 1}})),
            Err(EnvelopeError::TombstonePayload)
        );
        // Without a tombstone a payload is not constrained at this layer.
        assert_eq!(check(json!({"payload": {"a": 1}})), Ok(()));
    }

    #[test]
    fn optional_fields_are_omitted_not_null() {
        let v = with(
            json!({"correlation_id": "op_x", "causation_id": "evt_01JDQ001000000000000000001"}),
        );
        let out = serde_json::to_value(parse(&v)).unwrap();
        assert_eq!(out, v);
        let out = serde_json::to_value(parse(&base())).unwrap();
        for key in ["session_id", "causation_id", "correlation_id", "tombstone"] {
            assert!(out.get(key).is_none(), "{key}");
        }
        assert!(out["actor"].get("id").is_some());
        let anon = serde_json::to_value(parse(&with(json!({"actor": {"kind": "user"}})))).unwrap();
        assert!(anon["actor"].get("id").is_none());
    }
}
