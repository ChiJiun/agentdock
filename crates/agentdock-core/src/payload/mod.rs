//! Typed event payloads (ADR-0003, schema `*Payload` definitions) and the schema's `if/then` /
//! `oneOf` rules that serde cannot express.
//!
//! * [`decode_body`] turns an [`EventEnvelope`] into an [`EventBody`]: shape (serde), then the
//!   payload's own [`PayloadRules::validate`], then the quota-name deny-list.
//! * [`encode_body`] is the inverse. A fixture round-trips to an identical JSON value.
//! * Cross-event rules (state transitions, approval lifecycle, recovery allow-list) are not here.
//!
//! Reads tolerate unknown fields (no `deny_unknown_fields`); the writer contract
//! (`additionalProperties: false`) is kept by the round-trip test: this crate never adds fields.

/// Declares a unit-only enum that serializes as its `snake_case` name, with an `ALL` list for
/// the schema-sync test.
macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name { $($variant),+ }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];
        }
    };
}

pub mod approval;
pub mod check;
pub mod common;
pub mod operation;
pub mod session;
pub mod system;
pub mod task;

#[cfg(test)]
mod adversarial;
#[cfg(test)]
mod schema_sync;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::enums::{EventType, KnownEventType};
use crate::event::EventEnvelope;

pub use approval::{ApprovalRequestedPayload, ApprovalResolvedPayload};
pub use check::{CheckFinishedPayload, CheckStartedPayload};
pub use common::{derive_features, forbidden_quota_key};
pub use operation::{
    OperationAbandonedPayload, OperationFailedPayload, OperationOutcomeUnknownPayload,
    OperationReconciledPayload, OperationRecordedPayload, OperationStartedPayload,
    OperationSucceededPayload,
};
pub use session::{
    SessionArchivedPayload, SessionCapabilitiesDetectedPayload, SessionCreatedPayload,
    SessionMessageDeltaPayload, SessionOutputLimitedPayload, SessionPlanUpdatedPayload,
    SessionPromptSubmittedPayload, SessionResultAcknowledgedPayload, SessionStateChangedPayload,
    SessionSummaryRecordedPayload, SessionToolCallPayload, SessionUnarchivedPayload,
};
pub use system::{RecoveryCompletedPayload, RecoveryStartedPayload, UsageReportedPayload};
pub use task::{
    TaskCheckpointRecordedPayload, TaskCreatedPayload, TaskDeletedPayload,
    TaskOutcomeAcknowledgedPayload, TaskPolicyUpdatedPayload, TaskStateChangedPayload,
};

/// Per-payload rules of the schema that serde cannot express. One `&'static str` per rule; the
/// default (no rule) accepts everything the shape accepts.
pub trait PayloadRules {
    fn validate(&self) -> Result<(), &'static str> {
        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BodyError {
    #[error("payload of {event_type} does not match its schema: {source}")]
    Shape {
        event_type: &'static str,
        #[source]
        source: serde_json::Error,
    },
    #[error("{event_type}: {rule}")]
    Rule {
        event_type: &'static str,
        rule: &'static str,
    },
}

macro_rules! event_bodies {
    ($($variant:ident => $payload:ty),+ $(,)?) => {
        /// The typed view of an event's payload: one variant per [`KnownEventType`].
        #[derive(Debug, Clone, PartialEq)]
        pub enum EventBody {
            $($variant($payload),)+
            /// Unknown type from a newer writer, or a tombstoned event (payload `{}`).
            /// Read path only: the write path (P2-4 append) must reject it, see [`EventBody::is_opaque`].
            Opaque { event_type: String, payload: Value },
        }

        impl EventBody {
            /// The event type this body is written under.
            pub fn event_type(&self) -> EventType {
                match self {
                    $(EventBody::$variant(_) => EventType::Known(KnownEventType::$variant),)+
                    EventBody::Opaque { event_type, .. } => EventType::from_name(event_type),
                }
            }
        }

        fn decode_known(kind: KnownEventType, payload: &Value) -> Result<EventBody, BodyError> {
            let name = kind.as_str();
            Ok(match kind {
                $(KnownEventType::$variant => EventBody::$variant(load::<$payload>(name, payload)?),)+
            })
        }

        /// The typed payload as a JSON value (`Opaque` returns what it carries).
        fn payload_value(body: &EventBody) -> Value {
            match body {
                $(EventBody::$variant(p) => to_json(p),)+
                EventBody::Opaque { payload, .. } => payload.clone(),
            }
        }
    };
}

event_bodies! {
    TaskCreated => TaskCreatedPayload,
    TaskStateChanged => TaskStateChangedPayload,
    TaskCheckpointRecorded => TaskCheckpointRecordedPayload,
    TaskOutcomeAcknowledged => TaskOutcomeAcknowledgedPayload,
    TaskPolicyUpdated => TaskPolicyUpdatedPayload,
    TaskDeleted => TaskDeletedPayload,
    SessionCreated => SessionCreatedPayload,
    SessionCapabilitiesDetected => SessionCapabilitiesDetectedPayload,
    SessionStateChanged => SessionStateChangedPayload,
    SessionPromptSubmitted => SessionPromptSubmittedPayload,
    SessionMessageDelta => SessionMessageDeltaPayload,
    SessionToolCall => SessionToolCallPayload,
    SessionPlanUpdated => SessionPlanUpdatedPayload,
    SessionSummaryRecorded => SessionSummaryRecordedPayload,
    SessionOutputLimited => SessionOutputLimitedPayload,
    SessionResultAcknowledged => SessionResultAcknowledgedPayload,
    SessionArchived => SessionArchivedPayload,
    SessionUnarchived => SessionUnarchivedPayload,
    ApprovalRequested => ApprovalRequestedPayload,
    ApprovalResolved => ApprovalResolvedPayload,
    OperationRecorded => OperationRecordedPayload,
    OperationStarted => OperationStartedPayload,
    OperationSucceeded => OperationSucceededPayload,
    OperationFailed => OperationFailedPayload,
    OperationOutcomeUnknown => OperationOutcomeUnknownPayload,
    OperationReconciled => OperationReconciledPayload,
    OperationAbandoned => OperationAbandonedPayload,
    CheckStarted => CheckStartedPayload,
    CheckFinished => CheckFinishedPayload,
    UsageReported => UsageReportedPayload,
    SystemRecoveryStarted => RecoveryStartedPayload,
    SystemRecoveryCompleted => RecoveryCompletedPayload,
}

impl EventBody {
    /// True for [`EventBody::Opaque`]. Such a body must never be appended to our own store.
    pub fn is_opaque(&self) -> bool {
        matches!(self, EventBody::Opaque { .. })
    }
}

/// Shape (serde) first, then the payload's own rules.
fn load<T: DeserializeOwned + PayloadRules>(
    event_type: &'static str,
    payload: &Value,
) -> Result<T, BodyError> {
    let typed: T = serde_json::from_value(payload.clone())
        .map_err(|source| BodyError::Shape { event_type, source })?;
    typed
        .validate()
        .map_err(|rule| BodyError::Rule { event_type, rule })?;
    Ok(typed)
}

fn to_json<T: Serialize>(payload: &T) -> Value {
    // Payload structs hold only strings, numbers, bools, options and maps with string keys, so
    // serialization cannot fail; an empty object keeps this total without `unwrap`.
    serde_json::to_value(payload).unwrap_or_else(|_| Value::Object(Map::new()))
}

/// Tombstoned or unknown type -> `Opaque`. Known -> typed, then `payload.validate()`, then the
/// quota-name deny-list over the raw payload (every depth).
pub fn decode_body(env: &EventEnvelope) -> Result<EventBody, BodyError> {
    let EventType::Known(kind) = &env.event_type else {
        return Ok(opaque(env));
    };
    if env.tombstone.is_some() {
        return Ok(opaque(env));
    }
    let body = decode_known(*kind, &env.payload)?;
    if forbidden_quota_key(&env.payload).is_some() {
        return Err(BodyError::Rule {
            event_type: kind.as_str(),
            rule: common::rule::QUOTA_KEY,
        });
    }
    Ok(body)
}

fn opaque(env: &EventEnvelope) -> EventBody {
    EventBody::Opaque {
        event_type: env.event_type.as_str().to_owned(),
        payload: env.payload.clone(),
    }
}

/// The event type and payload to store for `body`. Does not validate; callers that build a body
/// by hand should round it through [`decode_body`] (the store does, P2-4).
pub fn encode_body(body: &EventBody) -> (EventType, Value) {
    (body.event_type(), payload_value(body))
}
