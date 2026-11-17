# AgentDock contracts

Status: Proposed with [ADR-0003](../decisions/0003-task-session-event-contracts.md). No Rust crate or npm package exists yet (that is issue #4); this directory is the agreed shape those packages must implement.

| File | Purpose |
| --- | --- |
| [`schema/agentdock.schema.json`](schema/agentdock.schema.json) | JSON Schema (2020-12, restricted keyword subset) for every entity, event payload, stream message and fixture expectation. **Source of truth for wire/storage shapes.** |
| [`transitions.json`](transitions.json) | Machine-readable task and session state graphs: legal transitions, actors, triggers, durability, conditions. **Source of truth for state machines.** |
| [`state-machines.md`](state-machines.md) | Human-readable tables and diagram of the above, plus collapse rules. |
| [`events.md`](events.md) | Envelope, event catalog, cursor, subscription/backpressure, retention, redaction. |
| [`acp-capabilities.md`](acp-capabilities.md) | ACP v1 capability detection, gating, ACP→event mapping, v2 draft strategy, verified sources. |
| [`checkpoint-and-replay.md`](checkpoint-and-replay.md) | Durability ordering, checkpoints, crash recovery, non-repeatable operations, the three kinds of "resume". |
| [`attention.md`](attention.md) | Derivation of needs-reply / needs-review / background items. |
| [`fixtures/`](fixtures/) | Mock event streams (`NN-name.jsonl`), their expected projections (`NN-name.expected.json`) and sample read models (`models.sample.json`). |
| [`validate_fixtures.py`](validate_fixtures.py) | Stdlib-only validator: schema + semantic rules + coverage + negative self-test. |
| [`generate_fixtures.py`](generate_fixtures.py) | Stdlib-only generator for the fixtures (expected results are hand-written in it, not computed). |

## Validate

```sh
python docs/contracts/validate_fixtures.py
```

Python ≥ 3.10, standard library only, no install. Exit code 0 means:

- the schema uses only the supported keyword subset (so nothing in it is silently ignored);
- every fixture line is a valid `EventEnvelope`, every `*.expected.json` a valid `FixtureExpectation`, `models.sample.json` a valid `ModelSamples`;
- semantic rules hold (gap-free cursor, legal transitions with allowed actors/triggers/conditions, approval/operation/check lifecycles, recovery invariants, no automatic replay of non-repeatable operations, capability-gated reattach, auto-resume and auto-collapse rules);
- each fixture's final task/session states and derived attention items equal its expectation;
- every transition in `transitions.json` is exercised by at least one fixture;
- no key anywhere implies a known subscription-quota balance;
- 17 deliberate rule-breaking mutations are each rejected with the expected message.

Regenerate fixtures after changing scenarios: `python docs/contracts/generate_fixtures.py` then validate. Fixtures are committed; the generator is a convenience, not a build step.

The validator implements a JSON Schema **subset**. Before relying on the schema in CI (issue #4), also run a full 2020-12 validator (e.g. `check-jsonschema` or the Rust `jsonschema` crate) over the same files.

### Schema keyword subset

Allowed: `$schema`, `$id`, `$defs`, `$ref` (local only), `$comment`, `title`, `description`, `examples`, `type`, `properties`, `required`, `additionalProperties`, `items`, `minItems`, `enum`, `const`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `format` (annotation only), `allOf`, `anyOf`, `oneOf`, `not`, `if`/`then`/`else`. `validate_fixtures.py` fails if any other keyword appears.

## Naming rules

| Item | Rule | Example |
| --- | --- | --- |
| JSON keys | `snake_case` | `external_session_id` |
| Enum values | `snake_case` strings | `awaiting_approval`, `provider_reported` |
| Event types | `<entity>.<past_tense_verb>` | `task.state_changed`, `operation.outcome_unknown` |
| IDs | `<prefix>_` + 26-char Crockford base32 ULID | `tsk_01JDQ001000000000000000001` |
| ID prefixes | `prj` project, `tsk` task, `ses` session, `evt` event, `apr` approval, `op` operation, `chk` check, `use` usage, `sum` summary, `cpt` checkpoint, `trn` turn | |
| Timestamps | RFC 3339 UTC, exactly millisecond precision, `Z` | `2026-11-17T02:00:07.000Z` |
| Absent values | Omit the key. `null` is not used. | |
| ACP values copied verbatim | Keep ACP's own spelling in values (`end_turn`, `allow_once`); ACP *keys* (camelCase) appear only inside the opaque `acp_agent_capabilities` object. | |

AgentDock keys stay `snake_case` end to end (Rust, SQLite, IPC, TypeScript). There is no camelCase conversion layer; this avoids a whole class of mapping bugs between the backend and the UI.

## Rust mapping (for issue #4)

| Schema | Rust |
| --- | --- |
| object definition | `#[derive(Serialize, Deserialize)] #[serde(rename_all = "snake_case")] struct` |
| optional field | `Option<T>` with `#[serde(default, skip_serializing_if = "Option::is_none")]` |
| string enum | `#[serde(rename_all = "snake_case")] enum` (unit variants) |
| ID (`TaskId`, ...) | newtype `struct TaskId(String)` with validated constructor; no raw `String` IDs in APIs |
| `Seq` | `u64`, with a debug assertion ≤ 2^53 − 1 |
| `Timestamp` | `time::OffsetDateTime` / `chrono::DateTime<Utc>` serialized with exactly 3 fractional digits |
| `EventEnvelope` + payload by `type` | envelope struct with `#[serde(flatten)] body: EventBody`, where `enum EventBody` is `#[serde(tag = "type", content = "payload")]` and each variant is `#[serde(rename = "task.state_changed")] TaskStateChanged(TaskStateChangedPayload)` |
| `if/then` constraints | constructor/validation functions + unit tests (serde alone does not enforce them) |
| readers | do **not** use `deny_unknown_fields` on read paths, so additive fields from a newer writer are tolerated |

## TypeScript mapping (for issue #4)

| Schema | TypeScript |
| --- | --- |
| object definition | `interface` / `type` with the same `snake_case` keys |
| optional field | `field?: T` (never `T \| null`) |
| string enum | string literal union (`type TaskState = "queued" \| ...`) |
| ID | branded string (`type TaskId = string & { readonly __brand: "TaskId" }`) |
| `Seq` | `number` (safe by the 2^53 − 1 cap) |
| `Timestamp` | `string` (parse at the edge) |
| `EventEnvelope` | discriminated union on `type`: `type AgentDockEvent = Envelope<"task.created", TaskCreatedPayload> \| ...` |
| validation at IPC boundary | the UI trusts typed Tauri commands from Rust; optional runtime validation in dev builds |

### Generation plan (decision deferred to #4)

The schema is hand-written today. Two options were considered for keeping Rust, TypeScript and the schema in sync:

1. **Rust-first**: Rust types are the source; generate JSON Schema with `schemars` and TS with `ts-rs`/`specta`; CI diffs the generated schema against this file and runs these fixtures through Rust deserialization.
2. **Schema-first**: this file is the source; generate Rust with `typify` and TS with `json-schema-to-typescript`.

Either way, the fixtures in `fixtures/` become a conformance test for both languages. Recommendation: option 1 (Rust owns the domain logic and the `if/then` rules are easier to express as Rust validation), but it is not decided here.

## Compatibility and versioning

- `EventEnvelope.schema_version` = 1. It changes only for a **breaking** change (removing/renaming a field or enum value, changing a meaning). Stored events are never rewritten; readers must handle every `schema_version` they have ever stored (upcasting on read).
- **Additive** changes (new optional field, new event type, new enum value) keep `schema_version` and bump the schema file's documented revision. Readers must ignore unknown optional fields and treat unknown event types as opaque (still advance the cursor).
- The JSON Schema uses `additionalProperties: false` to describe exactly what a writer of this revision emits; it is a writer contract and a fixture check, not a reason for readers to reject newer data.
