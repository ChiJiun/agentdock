# P2-1: Core IDs, timestamps, enums, canonical hash and event envelope

> **繁中摘要**：在 `agentdock-core` 實作 ADR-0003 契約的基礎型別：11 種前綴的 ID newtype、剛好 3 位毫秒的 UTC `Timestamp`、所有契約 enum、與 `validate_fixtures.py` 完全一致的 `canonical_sha256`／`idempotency_key`，以及 `EventEnvelope`（payload 先存成 `serde_json::Value`，未知事件類型不讓讀取失敗）。驗收：所有 fixture 每一行都能反序列化、通過信封驗證、再序列化回語意相等的 JSON。模型等級：一般模型可（`canonical_json` 跳脫規則請強模型審查）。

Issues: #7, #3 | Gate (#51): G3 (event log persistence) | Model tier: **standard model**

## 1. Goal and non-goals

Goal: the base types of the ADR-0003 contracts in `agentdock-core`, so every line of every fixture deserializes into `EventEnvelope` and serializes back **semantically equal** (equal JSON values).

- ID newtypes (11 prefixes) and generators.
- `Timestamp` (UTC with exactly 3 millisecond digits).
- Contract enums: `TaskState`, `SessionState`, `ActorKind`, `Provenance`, `ResumePhase`, `ApprovalReturnState`, `TaskTrigger`, `SessionTrigger`, `InterruptionReason`, `SessionRole`, `SessionOutcome`, `LaunchMethod`, `ApprovalState`, `ApprovalSource`, `ApprovalScope`, `PolicyClass`, `OperationKind`, `OperationState`, `Repeatability`, `ReconcileStrategy`, `CheckState`, `CheckOrigin`, `EventType`.
- `canonical_sha256`, `idempotency_key` (byte-identical results to `validate_fixtures.py`).
- `EventEnvelope`: payload kept as `serde_json::Value`; an unknown `type` never fails the read.

Non-goals: typed payloads (P2-2), state machines (P2-3), SQLite (P2-4).

## 2. Prerequisites and parallel work

- Prerequisites: P1-1. The ADR-0003 contracts are on main (squash commit `c9e33cf`, 2026-11-22) under `docs/contracts/`. If your branch lacks that directory, merge the latest main into it; never copy contract files by hand.
- Parallel: P1-2, P1-3, P3-1, P4-1, P5-1.

## 3. Files

New:

- `crates/agentdock-core/src/ids.rs`
- `crates/agentdock-core/src/time.rs`
- `crates/agentdock-core/src/enums.rs`
- `crates/agentdock-core/src/canonical.rs`
- `crates/agentdock-core/src/event.rs`
- `crates/agentdock-core/tests/fixtures_envelope.rs`

Modified:

- `crates/agentdock-core/src/lib.rs` (`pub mod` per module, `pub use` common types)
- `crates/agentdock-core/Cargo.toml` (dependencies)

## 4. Public types and signatures

```rust
// ids.rs
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("invalid {kind} id: {value:?}")]
pub struct IdError { pub kind: &'static str, pub value: String }

/// Generates one newtype per prefix. Each has:
///   pub fn parse(s: &str) -> Result<Self, IdError>   // ^<prefix>_[0-9A-HJKMNP-TV-Z]{26}$
///   pub fn generate() -> Self                         // prefix + Ulid::new().to_string()
///   pub fn as_str(&self) -> &str
///   impl Display, Serialize (as string), Deserialize (via parse, rejects invalid)
macro_rules! define_id { /* ... */ }
define_id!(ProjectId, "prj");  define_id!(TaskId, "tsk");     define_id!(SessionId, "ses");
define_id!(EventId, "evt");    define_id!(ApprovalId, "apr"); define_id!(OperationId, "op");
define_id!(CheckId, "chk");    define_id!(UsageId, "use");    define_id!(SummaryId, "sum");
define_id!(CheckpointId, "cpt"); define_id!(TurnId, "trn");

/// "local" or "remote:<name>", name ^[a-z0-9][a-z0-9-]{0,47}$
pub struct AuthorityId(String);   // parse/as_str/local()/Serialize/Deserialize
/// ^[a-z0-9][a-z0-9_.-]{0,63}$
pub struct AdapterId(String);     // parse/as_str/Serialize/Deserialize
/// ^[0-9a-f]{40}([0-9a-f]{24})?$ (SHA-1 or SHA-256 object id)
pub struct GitSha(String);
/// ^[0-9a-f]{64}$
pub struct Sha256Hex(String);
```

```rust
// time.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(time::OffsetDateTime); // always UTC, truncated to milliseconds
impl Timestamp {
    pub fn now() -> Self;                                  // truncates sub-millisecond part
    pub fn parse(s: &str) -> Result<Self, TimestampError>; // exactly YYYY-MM-DDTHH:MM:SS.mmmZ, real date
    pub fn to_rfc3339_millis(&self) -> String;             // same format
    pub fn unix_millis(&self) -> i128;
}
// Serialize/Deserialize as the string form.
```

```rust
// enums.rs — every enum: #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
// #[serde(rename_all = "snake_case")], variants exactly as the schema $defs (see §8 for the list source).
pub enum TaskState { Queued, Preparing, Running, AwaitingApproval, Verifying, Review, Pr, Ci,
                     Completed, Interrupted, Failed, Cancelled }
impl TaskState {
    pub fn is_terminal(self) -> bool;   // Completed | Cancelled (state-machine sense, ADR-0003 §2)
    pub fn is_in_flight(self) -> bool;  // Preparing|Running|AwaitingApproval|Verifying|Review|Pr|Ci
}
pub enum ResumePhase { Running, Verifying, Review, Pr, Ci } // derive PartialOrd, Ord in this order
pub enum SessionState { Starting, Idle, Active, AwaitingPermission, Suspended, Disconnected, Closed, Failed }
impl SessionState { pub fn is_live(self) -> bool; } // Starting|Idle|Active|AwaitingPermission|Suspended
pub enum ActorKind { User, Orchestrator, Policy, Adapter, Integration, Recovery }
pub enum Provenance { Live, AcpReplay, Recovery }
// ... and the others listed in §1, one-to-one with the schema enums.

/// Event type as stored. Unknown names are preserved, never rejected on read.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum EventType { Known(KnownEventType), Unknown(String) }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum KnownEventType { TaskCreated, TaskStateChanged, /* ... all 32 from schema EventType ... */ SystemRecoveryCompleted }
impl KnownEventType { pub fn as_str(self) -> &'static str; pub fn from_str(s: &str) -> Option<Self>; pub const ALL: [KnownEventType; 32]; }
// EventType serializes to/from the dotted string ("task.state_changed").
```

```rust
// canonical.rs
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CanonicalError { #[error("floating point numbers are not allowed in canonical JSON")] Float }

/// Canonical JSON: object keys sorted, no insignificant whitespace, UTF-8, non-ASCII NOT escaped,
/// integers as-is. Must equal Python json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).
pub fn canonical_json(value: &serde_json::Value) -> Result<String, CanonicalError>;
pub fn canonical_sha256(value: &serde_json::Value) -> Result<Sha256Hex, CanonicalError>;
/// idempotency_key = canonical_sha256({"kind": kind, "identity": target minus "description"})
pub fn idempotency_key(kind: &str, target: &serde_json::Map<String, serde_json::Value>) -> Result<Sha256Hex, CanonicalError>;
/// ACP permission fingerprint: canonical_sha256({"kind":"tool_call","target":{"tool_call_id":..,"title":..}})
pub fn acp_permission_fingerprint(tool_call_id: &str, title: &str) -> Sha256Hex; // strings only, cannot fail
```

```rust
// event.rs
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Actor { pub kind: ActorKind, #[serde(default, skip_serializing_if = "Option::is_none")] pub id: Option<String> }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Redaction { pub policy_version: u32, pub applied_rules: Vec<String> }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tombstone { pub reason: String /* "task_deleted" */, pub at: Timestamp }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub schema_version: u32,
    pub id: EventId,
    pub authority_id: AuthorityId,
    pub seq: u64,                              // 1..=2^53-1, checked by validate()
    pub occurred_at: Timestamp,
    pub recorded_at: Timestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub project_id: Option<ProjectId>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub task_id: Option<TaskId>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub session_id: Option<SessionId>,
    #[serde(rename = "type")] pub event_type: EventType,
    pub actor: Actor,
    pub provenance: Provenance,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub causation_id: Option<EventId>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub correlation_id: Option<String>,
    pub redaction: Redaction,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub tombstone: Option<Tombstone>,
    pub payload: serde_json::Value,            // object; typed view in P2-2
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum EnvelopeError {
    #[error("schema_version {0} is not supported")] SchemaVersion(u32),
    #[error("seq {0} out of range 1..=2^53-1")] SeqRange(u64),
    #[error("occurred_at is after recorded_at")] ClockOrder,
    #[error("system.* events must not carry project/task/session ids")] SystemRouting,
    #[error("non-system events require project_id and task_id")] MissingRouting,
    #[error("session_id required for {0}")] MissingSession(&'static str),
    #[error("actor recovery requires provenance recovery and vice versa")] RecoveryProvenance,
    #[error("payload must be a JSON object")] PayloadNotObject,
    #[error("tombstoned events must have an empty payload")] TombstonePayload,
}
impl EventEnvelope {
    /// Envelope-level rules from docs/contracts/events.md "Envelope" table only (not payload rules).
    pub fn validate(&self) -> Result<(), EnvelopeError>;
}
```

## 5. Implementation steps

1. Add dependencies (§9); declare modules in `lib.rs`.
2. Write the §6 tests first.
3. `ids.rs`: generate newtypes with the macro; `parse` uses hand-written checks (length + character set), **no regex crate** (no extra dependency, no ReDoS class of bugs). Crockford alphabet: `0-9`, `A-H`, `J`, `K`, `M`, `N`, `P-T`, `V-Z` (no I, L, O, U, no lowercase).
4. `time.rs`: `time::macros::format_description!("[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z")`; `parse` first checks length exactly 24 and a trailing `Z`, then lets `time` parse (it rejects February 30).
5. `enums.rs`: transcribe each enum from `docs/contracts/schema/agentdock.schema.json` `$defs`. The `enums_match_schema` test (§6) reads the schema and **compares the string set of every enum**, catching typos and omissions.
6. `canonical.rs`: recursive writer; sort object keys with `BTreeMap<&str, _>` (Rust `str` ordering is UTF-8 byte order; Python `sort_keys` is code point order; UTF-8 preserves code point order, so they agree). String escaping must match Python `ensure_ascii=False`: escape only `"`, `\`, and control characters U+0000–U+001F (`\n`, `\r`, `\t`, `\b`, `\f` short forms; others `\u00XX` with lowercase hex). Floats return `CanonicalError::Float` (contract targets contain no floats).
7. `event.rs`: implement `validate()` per the error list in §4.
8. Run §7.

## 6. Tests to write first

```rust
// crates/agentdock-core/tests/fixtures_envelope.rs
use agentdock_core::{canonical::*, event::EventEnvelope};
use std::{fs, path::PathBuf};

fn contracts() -> PathBuf { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/contracts") }

fn all_fixture_lines() -> Vec<(String, usize, String)> {
    let mut out = vec![];
    for dir in [contracts().join("fixtures"), contracts().join("fixtures/predelete")] {
        for entry in fs::read_dir(&dir).unwrap() {
            let p = entry.unwrap().path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
            for (i, line) in fs::read_to_string(&p).unwrap().split('\n').enumerate() {
                let line = line.strip_suffix('\r').unwrap_or(line); // tolerate CRLF checkouts
                if !line.is_empty() { out.push((p.display().to_string(), i + 1, line.to_string())); }
            }
        }
    }
    assert!(out.len() > 500, "expected the 13 fixtures (+ predelete) to have >500 lines");
    out
}

#[test]
fn every_fixture_line_roundtrips_semantically() {
    for (file, line_no, line) in all_fixture_lines() {
        let original: serde_json::Value = serde_json::from_str(&line).unwrap();
        let env: EventEnvelope = serde_json::from_str(&line)
            .unwrap_or_else(|e| panic!("{file}:{line_no}: {e}"));
        env.validate().unwrap_or_else(|e| panic!("{file}:{line_no}: {e}"));
        assert_eq!(serde_json::to_value(&env).unwrap(), original, "{file}:{line_no}");
    }
}

#[test]
fn idempotency_keys_match_fixture_and_python() {
    // From fixtures/01-happy-path-pr.jsonl seq 38 / 45 / 59 (verified with Python on 2026-11-22).
    let push = serde_json::json!({"remote":"origin","ref":"refs/heads/agentdock/0001",
        "expected_sha":"2222222222222222222222222222222222222222","description":"ignored"});
    assert_eq!(idempotency_key("git_push", push.as_object().unwrap()).unwrap().as_str(),
        "d2f573fe870a9f53106ecce01d5f0f9e26d7a590ef1eb6dbfcd539628752d4fd");
    let pr = serde_json::json!({"ref":"agentdock/0001","base":"main","description":"x"});
    assert_eq!(idempotency_key("pr_create", pr.as_object().unwrap()).unwrap().as_str(),
        "9c98798450d136f5574cb13275e535ec6119075d1fb6f0aa449b7cf78eca7be7");
    // Non-ASCII identity must not be escaped.
    let wt = serde_json::json!({"path":"工作樹/task-01","description":"移除"});
    assert_eq!(idempotency_key("worktree_remove", wt.as_object().unwrap()).unwrap().as_str(),
        "5f4fcb979630f8d4c62faca754b24d8f53b47495bcc3ed4c21bfc63f5c0f9b6d");
    assert_eq!(acp_permission_fingerprint("call_1", "Run tests").as_str(),
        "c2a86338b0447873db2221422402798cefd32e28229893f946f28efcb3a81477");
}

#[test]
fn description_change_keeps_key_identity_change_does_not() {
    let a = serde_json::json!({"remote":"origin","ref":"refs/heads/x","expected_sha":"a".repeat(40),"description":"one"});
    let b = serde_json::json!({"remote":"origin","ref":"refs/heads/x","expected_sha":"a".repeat(40),"description":"two"});
    let c = serde_json::json!({"remote":"origin","ref":"refs/heads/y","expected_sha":"a".repeat(40),"description":"one"});
    let k = |v: &serde_json::Value| idempotency_key("git_push", v.as_object().unwrap()).unwrap();
    assert_eq!(k(&a), k(&b));
    assert_ne!(k(&a), k(&c));
}
```

Unit tests inside each module (`#[cfg(test)]`), at least:

| Test | Input | Expected |
| --- | --- | --- |
| `id_rejects_trailing_newline` | `"tsk_01JDQ001000000000000000001\n"` | `Err` (contract mutation `e7_trailing_newline_id`) |
| `id_rejects_forbidden_letters` | contains `I`, `L`, `O`, `U` or lowercase | `Err` |
| `id_rejects_wrong_prefix` | `TaskId::parse("ses_01JDQ...")` | `Err` |
| `generated_ids_parse` | `TaskId::generate()` 1000 times | each parses; all distinct |
| `timestamp_rejects_impossible_date` | `"2026-02-30T00:00:00.000Z"` | `Err` (mutation `e7_impossible_date`) |
| `timestamp_rejects_wrong_precision` | `"2026-11-17T02:00:07Z"`, `"...07.0000Z"`, `"...07.000+00:00"` | all `Err` |
| `timestamp_now_has_millis_only` | `Timestamp::now()` | serialized length 24; parses back equal |
| `enums_match_schema` | every enum in schema `$defs` | string set of Rust `serde_json::to_value` equals schema `enum` exactly |
| `unknown_event_type_is_preserved` | a fixture line with `type` = `"future.thing_happened"` | deserializes to `EventType::Unknown("future.thing_happened")`, serializes back to the same string |
| `validate_rejects_system_event_with_task_id` | `system.recovery_started` with `task_id` | `Err(SystemRouting)` |
| `validate_rejects_recovery_actor_with_live_provenance` | actor `recovery`, provenance `live` | `Err(RecoveryProvenance)` |
| `canonical_escapes_like_python` | `{"b":"\u0001\"\\\n","a":"é"}` | `{"a":"é","b":"\u0001\"\\\n"}` (`\u0001` lowercase hex) |
| `canonical_rejects_float` | `{"x":1.5}` | `Err(CanonicalError::Float)` |

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-core          # all pass; the 3 fixtures_envelope integration tests pass
cargo clippy -p agentdock-core --all-targets -- -D warnings
python3 -B -I docs/contracts/validate_fixtures.py   # still exit 0 (this packet does not touch contracts)
```

No Windows-only items.

## 8. Spec references and porting sources

All line numbers refer to main `c9e33cf`.

- ADR-0003 §1 (naming), §4 (envelope, cursor limit 2^53−1).
- `docs/contracts/README.md` "Naming rules", "Rust mapping (for issue #4)", "Compatibility and versioning" (tolerate unknown fields and unknown event types on read).
- `docs/contracts/events.md` "Envelope" table (source of the `validate()` rules).
- `docs/contracts/schema/agentdock.schema.json` `$defs`: each ID `pattern`, `Timestamp`, each enum, `EventEnvelope.allOf`.
- `docs/contracts/checkpoint-and-replay.md` "Non-repeatable operations → Rules" rule 2 (canonical JSON and fingerprint formula).
- `docs/contracts/validate_fixtures.py` lines 47–51 `canonical_sha256`, lines 281–287 `operation_identity` / `idempotency_key`.
- No porting source.

## 9. Dependencies

| Crate | Version | Status |
| --- | --- | --- |
| `serde` (derive) | 1.0.229 | needs audit |
| `serde_json` | 1.0.154 | needs audit |
| `thiserror` | 2.0.21 | needs audit |
| `time` (features `formatting`, `parsing`, `macros`) | 0.3.55 | needs audit |
| `ulid` | 3.0.0 | needs audit |
| `sha2` | 0.11.1 | needs audit |
| hex encoding | — | hand-written, no dependency |

Versions were the latest on crates.io on 2026-11-22; if `cargo` resolves a newer patch, keep it and note it in the PR.

## 10. Model tier

Standard model (mechanical transcription plus table tests). Ask a strong model to review the `canonical_json` escaping once.

## 11. Common mistakes and pitfalls

- `serde_json::to_string` on a `Map` orders keys depending on the `preserve_order` feature; **never** use it as canonical JSON. Write the recursive writer.
- `serde_json` and Python `ensure_ascii=False` both emit `é`, U+2028 and U+2029 raw; do not add extra escaping.
- No `deny_unknown_fields` on `EventEnvelope` (the read path tolerates new fields).
- `seq` is `u64`, but values above 2^53−1 must be rejected by `validate()`.
- Split fixtures with `split('\n')` (the contract README says JSON Lines are separated by `\n` only) and strip one trailing `\r` per line.
- The repo has no `.gitattributes` (main `c9e33cf`, checked 2026-11-22); on Windows with `core.autocrlf=true` fixtures become CRLF. Never compare fixture bytes or hash fixture files. Adding `.gitattributes` is out of scope (listed in the README under existing documentation issues).

## 12. Reviewer checklist

- [ ] Does `every_fixture_line_roundtrips_semantically` cover both `fixtures/` and `fixtures/predelete/`?
- [ ] Do the hard-coded hashes in `idempotency_keys_match_fixture_and_python` pass without editing the expected values?
- [ ] Does `canonical_json` escape exactly like Python `ensure_ascii=False` (control characters lowercase `\u00XX`, non-ASCII raw) and reject floats?
- [ ] Does `enums_match_schema` read the schema file rather than a hand-copied list?
- [ ] Is an unknown event type preserved on read and write?
- [ ] No regex crate, no `deny_unknown_fields`, no `unwrap` outside tests?
