//! Every payload in every contract fixture decodes into a typed `EventBody`, passes the payload
//! rules, and encodes back to exactly the payload it came from.

mod common;

use std::collections::BTreeSet;

use agentdock_core::{
    enums::{EventType, KnownEventType},
    event::EventEnvelope,
    payload::{decode_body, encode_body, EventBody},
};

#[test]
fn every_fixture_event_decodes_to_typed_body_and_reencodes() {
    let mut typed_types = BTreeSet::new();
    for (file, line_no, line) in common::all_fixture_lines() {
        let env: EventEnvelope = serde_json::from_str(&line).unwrap();
        let body = decode_body(&env).unwrap_or_else(|e| panic!("{file}:{line_no}: {e}"));
        if env.tombstone.is_some() {
            assert!(matches!(body, EventBody::Opaque { .. }));
            continue;
        }
        assert!(
            !matches!(body, EventBody::Opaque { .. }),
            "{file}:{line_no} decoded as Opaque"
        );
        let (t, payload) = encode_body(&body);
        assert_eq!(t, env.event_type, "{file}:{line_no}");
        assert_eq!(payload, env.payload, "{file}:{line_no}");
        typed_types.insert(env.event_type.as_str().to_owned());
    }
    // The fixtures exercise all 32 known event types, so none of the typed payloads is untested.
    let all: BTreeSet<String> = KnownEventType::ALL
        .iter()
        .map(|k| EventType::Known(*k).as_str().to_owned())
        .collect();
    assert_eq!(typed_types, all);
}

#[test]
fn envelope_body_accessor_matches_decode_body() {
    let (_, _, line) = common::all_fixture_lines().remove(0);
    let env: EventEnvelope = serde_json::from_str(&line).unwrap();
    assert_eq!(env.body().unwrap(), decode_body(&env).unwrap());
}
