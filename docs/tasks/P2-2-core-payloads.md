# P2-2: Typed event payloads and the schema's if/then rules

> **繁中摘要**：為 32 種事件定義 typed payload，提供 `EventEnvelope` ↔ `EventBody` 的解碼與編碼，並把 schema 中 serde 表達不了的 `if/then`／`oneOf` 規則寫成 `validate()`（例如 interrupted 必須帶 interruption、git_push 必須 non_repeatable、idempotency_key 必須等於 canonical 計算值、capability features 必須由原始 capabilities 推導、任何深度不得出現配額欄位名）。跨事件規則不在本包。驗收：所有 fixture 解碼成 typed body 再編碼回相同 payload，加上 14 個對抗測試。模型等級：一般模型可（規則表請強模型逐條審查）。

Issues: #7, #3 | Gate (#51): G3 | Model tier: **standard model** (large but mechanical; strong-model review of the rule table)

## 1. Goal and non-goals

Goal: typed payloads for the 32 event types, decoding `EventEnvelope` → `EventBody` and encoding back, plus `validate()` for the schema's `if/then` / `oneOf` rules that serde cannot express.

Non-goals: cross-event rules (state transitions, approval lifecycle, recovery allow-list) — those are P2-3 / P2-5 / P2-6.

## 2. Prerequisites and parallel work

- Prerequisites: P2-1.
- Parallel: P2-3 (its types need only P2-1 enums), P3-1, P4-1, P5-1.

## 3. Files

New:

- `crates/agentdock-core/src/payload/mod.rs` (`EventBody`, `decode_body`, `encode_body`, `BodyError`, `PayloadRules`)
- `crates/agentdock-core/src/payload/task.rs`
- `crates/agentdock-core/src/payload/session.rs`
- `crates/agentdock-core/src/payload/approval.rs`
- `crates/agentdock-core/src/payload/operation.rs`
- `crates/agentdock-core/src/payload/check.rs`
- `crates/agentdock-core/src/payload/system.rs` (includes `usage.reported`)
- `crates/agentdock-core/src/payload/common.rs` (`Interruption`, `RetryHint`, `Failure`, `TextOrRef`, `ArtifactRef`, `CapabilitySnapshot`, `derive_features`, `forbidden_quota_key`, `AcpPermissionContext`, `Usage` subtypes)
- `crates/agentdock-core/tests/common/mod.rs` (move `all_fixture_lines()` from P2-1 here and reuse it)
- `crates/agentdock-core/tests/fixtures_payload.rs`

Modified: `crates/agentdock-core/src/lib.rs`, `crates/agentdock-core/src/event.rs` (add `body()` and `EventEnvelope::new_live(...)`), `crates/agentdock-core/tests/fixtures_envelope.rs` (use the shared helper).

## 4. Public types and signatures

Each payload struct maps to the schema's `<Name>Payload`, field names and types one-to-one; optional fields are `Option<T>` with `skip_serializing_if = "Option::is_none"`. Key ones:

```rust
// payload/task.rs
pub struct TaskCreatedPayload { pub objective: String, pub state: TaskState /* must be Queued */,
    pub issue_url: Option<String>, pub branch: Option<String>, pub worktree_path: Option<String>,
    pub auto_resume_policy: AutoResumePolicy }
pub struct TaskStateChangedPayload { pub from: TaskState, pub to: TaskState, pub trigger: TaskTrigger,
    pub resume_phase: Option<ResumePhase>, pub return_state: Option<ApprovalReturnState>,
    pub approval_id: Option<ApprovalId>, pub interruption: Option<Interruption>,
    pub failure: Option<Failure>, pub checkpoint_id: Option<CheckpointId> }
pub struct TaskCheckpointRecordedPayload { pub checkpoint_id: CheckpointId, pub phase: TaskState,
    pub through_seq: u64, pub worktree: Option<CheckpointWorktree>,
    pub open_operation_ids: Vec<OperationId>, pub pending_approval_ids: Vec<ApprovalId> }
pub struct CheckpointWorktree { pub head_sha: GitSha, pub branch: String, pub dirty: bool, pub diff_sha256: Option<Sha256Hex> }
// + TaskOutcomeAcknowledgedPayload, TaskPolicyUpdatedPayload, TaskDeletedPayload

// payload/operation.rs
pub struct OperationTarget { pub description: String, pub remote: Option<String>,
    #[serde(rename = "ref")] pub r#ref: Option<String>,
    pub base: Option<String>, pub expected_sha: Option<GitSha>, pub pr_number: Option<u64>,
    pub path: Option<String>, pub content_sha256: Option<Sha256Hex>, pub command_sha256: Option<Sha256Hex>,
    pub cwd: Option<String>, pub endpoint: Option<String> }
impl OperationTarget {
    pub fn identity(&self) -> serde_json::Map<String, serde_json::Value>; // all present fields except description
    pub fn idempotency_key(&self, kind: OperationKind) -> Sha256Hex;    // canonical::idempotency_key (no floats possible)
}
pub struct OperationRecordedPayload { pub operation_id: OperationId, pub kind: OperationKind,
    pub repeatability: Repeatability, pub idempotency_key: Sha256Hex, pub target: OperationTarget,
    pub approval_id: ApprovalId, pub reconcile_strategy: ReconcileStrategy,
    pub supersedes_operation_id: Option<OperationId> }
// + Started / Succeeded / Failed{error, effect: FailureEffect{None,Unknown}} / OutcomeUnknown{cause} / Reconciled{finding} / Abandoned{reason}

// payload/mod.rs
#[derive(Debug, Clone, PartialEq)]
pub enum EventBody {
    TaskCreated(TaskCreatedPayload), TaskStateChanged(TaskStateChangedPayload),
    /* ... one variant per KnownEventType ... */
    SystemRecoveryCompleted(RecoveryCompletedPayload),
    /// Unknown type from a newer writer, or a tombstoned event (payload {}). Read path only.
    Opaque { event_type: String, payload: serde_json::Value },
}
#[derive(Debug, thiserror::Error)]
pub enum BodyError {
    #[error("payload of {event_type} does not match its schema: {source}")]
    Shape { event_type: &'static str, #[source] source: serde_json::Error },
    #[error("{event_type}: {rule}")]
    Rule { event_type: &'static str, rule: &'static str },
}
/// Tombstoned or unknown → Opaque. Known → typed, then payload.validate().
pub fn decode_body(env: &EventEnvelope) -> Result<EventBody, BodyError>;
pub fn encode_body(body: &EventBody) -> (EventType, serde_json::Value);

pub trait PayloadRules { fn validate(&self) -> Result<(), &'static str>; }

// payload/common.rs
pub fn derive_features(raw_agent_capabilities: &serde_json::Value) -> CapabilityFeatures; // reused by P3-4
/// Returns the first key (any depth) that matches the quota-name deny-list.
pub fn forbidden_quota_key(value: &serde_json::Value) -> Option<String>;
```

Rules `validate()` must cover (one `&'static str` error per rule; tests match the string):

| Payload | Rules |
| --- | --- |
| `TaskCreated` | `state == Queued` |
| `TaskStateChanged` | `interruption` ⇔ `to == Interrupted`; `failure` ⇔ `to == Failed`; `to == AwaitingApproval` ⇒ `return_state` and `approval_id` present; `from == Failed && to == Queued` ⇒ no `resume_phase` (mutation `r4_retry_with_resume_phase`) |
| `Interruption` | `auto_resume_armed` ⇒ reason ∈ {quota_exhausted, rate_limited} and `retry_hint` present with `source` ∈ {provider_reported, user_configured}; `reason == HostCrashed` ⇒ `auto_resume_armed == false` |
| `RetryHint` | `source == Unknown` ⇔ no `not_before` |
| `TextOrRef` | exactly one of `text`, `text_ref` |
| `SessionCreated` | `launch_method ∈ {load, resume}` ⇒ `external_session_id` present |
| `SessionStateChanged` | `trigger == turn_ended` ⇒ `stop_reason` and `turn_id` present; `trigger == reattach_attempt` ⇒ `launch_method ∈ {load, resume}`; `to ∈ {closed, failed}` ⇒ `outcome` present; `to == Failed` ⇒ `outcome ∈ {failed, cancelled}` (mutation `r4_failed_session_claims_success`); transcribe every remaining clause of schema `SessionStateChangedPayload.allOf` |
| `ApprovalRequested` | `source == acp_permission` ⇒ `operation_kind == "tool_call"`, `acp` and `classified_kind` present; otherwise `operation_id` present, no `acp` / `classified_kind`, and `operation_kind` is an `OperationKind` |
| `ApprovalResolved` | `acp_outcome.outcome == selected` ⇒ `option_id` present |
| `OperationRecorded` | `OperationKindRules`: kind ∈ {git_push, pr_create, pr_update, pr_merge, branch_delete, worktree_remove, destructive_command} ⇒ `repeatability == non_repeatable`; each kind's target has exactly its identity fields (`checkpoint-and-replay.md` Classification table) and no other identity fields; `pr_number`, when present, is > 0; `idempotency_key == target.idempotency_key(kind)` (mutation `e8a_key_not_canonical`) |
| `CapabilitySnapshot` | `features == derive_features(acp_agent_capabilities)`; no `_meta` key at any depth of `acp_agent_capabilities` |
| every payload | no key at any depth matches the quota-name deny-list, case-insensitive: contains `remaining`, `_left`, `left_`, `balance`, `allowance`, `percent`, `pct`, or `quota` (except keys ending in `quota_reset`) |

## 5. Implementation steps

1. Read each `*Payload` and shared definition in schema `$defs` and transcribe it (keep schema field order to ease review).
2. `decode_body`: tombstone present → `Opaque`; `EventType::Unknown` → `Opaque`; known → `serde_json::from_value::<XPayload>(payload.clone())`, then `validate()`, then `forbidden_quota_key`.
3. `derive_features`: follow `validate_fixtures.py` lines 290–305 exactly.
4. Quota deny-list: lowercase then `contains`; no regex.
5. `EventEnvelope::new_live(authority, project, task, session, actor, body, redaction, occurred_at, recorded_at) -> EventEnvelope`: `seq` is 0 until the store assigns it on append (P2-4); `id` from `EventId::generate()`; timestamps are parameters (testability).

## 6. Tests to write first

```rust
// crates/agentdock-core/tests/fixtures_payload.rs
mod common;
use agentdock_core::{event::EventEnvelope, payload::{decode_body, encode_body, EventBody}};

#[test]
fn every_fixture_event_decodes_to_typed_body_and_reencodes() {
    for (file, line_no, line) in common::all_fixture_lines() {
        let env: EventEnvelope = serde_json::from_str(&line).unwrap();
        let body = decode_body(&env).unwrap_or_else(|e| panic!("{file}:{line_no}: {e}"));
        if env.tombstone.is_some() { assert!(matches!(body, EventBody::Opaque { .. })); continue; }
        assert!(!matches!(body, EventBody::Opaque { .. }), "{file}:{line_no} decoded as Opaque");
        let (t, payload) = encode_body(&body);
        assert_eq!(t, env.event_type, "{file}:{line_no}");
        assert_eq!(payload, env.payload, "{file}:{line_no}");
    }
}
```

Adversarial tests (inside modules, one `#[test]` each, asserting the error string). Build each input by copying a real fixture line and editing it:

| Test | Edited input | Expected error |
| --- | --- | --- |
| `retry_with_resume_phase_rejected` | `failed → queued` plus `resume_phase: "pr"` | TaskStateChanged rule |
| `interrupted_without_interruption_rejected` | `to: interrupted` without `interruption` | same |
| `host_crash_cannot_be_armed` | `reason: host_crashed, auto_resume_armed: true` | Interruption rule |
| `unknown_hint_with_time_rejected` | `retry_hint {source: unknown, not_before: ...}` | RetryHint rule |
| `failed_session_cannot_claim_success` | `to: failed, outcome: succeeded` | SessionStateChanged rule |
| `acp_approval_must_be_tool_call` | `source: acp_permission, operation_kind: git_push` | ApprovalRequested rule (mutation `b3b_acp_claims_operation_kind`) |
| `push_without_remote_rejected` | `git_push` target without `remote` | OperationRecorded rule (mutation `b1c_push_target_without_identity`) |
| `push_claims_idempotent_rejected` | `git_push` with `repeatability: idempotent_with_key` | same (mutation `e8b_push_claims_idempotent`) |
| `wrong_idempotency_key_rejected` | key replaced by 64 `0`s | same |
| `features_must_match_raw` | snapshot `features.load_session` disagrees with raw | CapabilitySnapshot rule (mutation `e12_features_mismatch`) |
| `meta_key_rejected` | raw capabilities gain `{"_meta": {}}` | same |
| `quota_key_rejected_anywhere` | deep in raw capabilities add `"remainingQuota": 5` | deny-list (mutation `opaque_quota_key`) |
| `quota_reset_key_allowed` | key `on_quota_reset` | no error |
| `text_and_ref_both_rejected` | `content` has both `text` and `text_ref` | TextOrRef rule |

## 7. Acceptance commands and expected results

```bash
cargo test -p agentdock-core           # fixtures_payload passes; all 14 adversarial tests pass
cargo clippy -p agentdock-core --all-targets -- -D warnings
```

No Windows-only items.

## 8. Spec references and porting sources

All line numbers refer to main `c9e33cf`.

- `docs/contracts/schema/agentdock.schema.json`: every `*Payload`, `Interruption`, `RetryHint`, `TextOrRef`, `CapabilitySnapshot`, `OperationTarget`, `OperationKindRules`, `ApprovalRequestedPayload.allOf`, `SessionStateChangedPayload.allOf`.
- `docs/contracts/checkpoint-and-replay.md` lines 71–83 "Non-repeatable operations → Classification" (identity fields per kind).
- `docs/contracts/acp-capabilities.md` "Detection algorithm" table (feature derivation); `validate_fixtures.py` lines 290–305 `derive_features`, line 44 `FORBIDDEN_NAME`.
- ADR-0003 §9 table (mutation names).
- No porting source.

## 9. Dependencies

None new (P2-1 set).

## 10. Model tier

Standard model. The §4 rule table is security-relevant; a strong model should review it clause by clause against the schema.

## 11. Common mistakes and pitfalls

- `ref` is a Rust keyword: use `r#ref` with `#[serde(rename = "ref")]`.
- The schema's `additionalProperties: false` is a **writer** contract: no `deny_unknown_fields` on read, but payloads produced by this crate must not add fields (the roundtrip test guarantees it).
- `pr_number` is a positive integer: `u64`, and `validate()` rejects 0.
- `Opaque` is read-only: the write path (P2-4 append) must reject it so unknown events never enter our own store.
- Do not translate schema `pattern`s into regexes; IDs and timestamps are already checked by P2-1 newtypes. `RelativePath`'s pattern is only a shape check; real path safety is P4-1.

## 12. Reviewer checklist

- [ ] Does every rule in the §4 table have a matching clause in `validate()` and, where listed, an adversarial test?
- [ ] Is `SessionStateChangedPayload.allOf` transcribed completely (compare clause count with the schema)?
- [ ] Does `derive_features` match `validate_fixtures.py` lines 290–305 exactly?
- [ ] Is the quota deny-list applied at every depth of every payload, with the `quota_reset` exception only?
- [ ] Can `Opaque` reach the write path? (It must not.)
