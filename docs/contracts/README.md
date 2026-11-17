# AgentDock contracts

Status: Proposed with [ADR-0003](../decisions/0003-task-session-event-contracts.md). No Rust crate or npm package exists yet (that is issue #4); this directory is the agreed shape those packages must implement.

| File | Purpose |
| --- | --- |
| [`schema/agentdock.schema.json`](schema/agentdock.schema.json) | JSON Schema (2020-12, restricted keyword subset) for every entity, event payload, stream message and fixture expectation. **Source of truth for wire/storage shapes.** |
| [`transitions.json`](transitions.json) | Machine-readable task and session state graphs: legal transitions, actors, triggers, durability, conditions. **Source of truth for state machines.** |
| [`state-machines.md`](state-machines.md) | Human-readable tables and diagram of the above, plus archive rules. |
| [`events.md`](events.md) | Envelope, event catalog, cursor, subscription/backpressure, retention, redaction. |
| [`acp-capabilities.md`](acp-capabilities.md) | ACP v1 capability detection, gating, ACP→event mapping, v2 draft strategy, verified sources. |
| [`checkpoint-and-replay.md`](checkpoint-and-replay.md) | Durability ordering, checkpoints, crash recovery, non-repeatable operations, the three kinds of "resume". |
| [`attention.md`](attention.md) | Derivation of needs-reply / needs-review / background items. |
| [`fixtures/`](fixtures/) | Mock event streams (`NN-name.jsonl`), their expected projections (`NN-name.expected.json`), sample read models (`models.sample.json`) and, for streams that delete a task, the stream as it was just before deletion (`predelete/NN-name.jsonl`, used to check deletion preconditions). |
| [`validate_fixtures.py`](validate_fixtures.py) | Stdlib-only validator: schema + semantic rules + coverage + negative self-test. |
| [`generate_fixtures.py`](generate_fixtures.py) | Stdlib-only generator for the fixtures (expected results are hand-written in it, not computed). |

## Validate

```sh
python -B docs/contracts/validate_fixtures.py
```

Python ≥ 3.10, standard library only, no install. `-B` (or `PYTHONDONTWRITEBYTECODE=1`) keeps Python from writing a `__pycache__/` next to the scripts. Exit code 0 means:

- the schema uses only the supported keyword subset (so nothing in it is silently ignored);
- every fixture line is a valid `EventEnvelope`, every `*.expected.json` a valid `FixtureExpectation`, `models.sample.json` a valid `ModelSamples`;
- semantic rules hold (gap-free cursor, legal transitions with allowed actors/triggers/conditions, approval/operation/check lifecycles incl. abandon and supersede, one blocking approval per task, user-only approval kinds and ACP classes, approval task/expiry/actor binding, idempotency keys recomputed from per-kind identity fields, operation kinds bound to task states, reconciliation gates and PR rounds, push/merge bound to the published commit, uninterruptible merge, recovery invariants, bounded `resume_phase`, no automatic replay of non-repeatable operations, capability-gated reattach with `features` re-derived from raw ACP capabilities, tombstoned task deletion with preconditions checked against `predelete/`, auto-resume and archive rules);
- each fixture's final task/session states and derived attention items equal its expectation;
- every transition in `transitions.json` is exercised by at least one fixture;
- no key anywhere implies a known subscription-quota balance;
- 63 deliberate rule-breaking mutations are each rejected with the expected message (each asserts a specific error text, so a mutation caught by an unrelated rule fails the self-test).

Regenerate fixtures after changing scenarios: `python -B docs/contracts/generate_fixtures.py` then validate. Fixtures are committed; the generator is a convenience, not a build step.

Passing is a regression result, not a proof; see [Enforcement boundary](#enforcement-boundary).

The validator implements a JSON Schema **subset**. Before relying on the schema in CI (issue #4), also run a full 2020-12 validator (e.g. `check-jsonschema` or the Rust `jsonschema` crate) over the same files.

### Schema keyword subset

Patterns are ECMA-262 as JSON Schema requires. Python's `$` also matches before a trailing newline, so the validator rewrites every unescaped `$` outside a character class to `\Z` before compiling (`ecma_to_python`). Pattern checks are shape checks only: for `RelativePath` the backend must still canonicalize the path (resolve `..`, symlinks and junctions) and verify that it stays inside the task workspace; the regex is not a containment check.

Allowed: `$schema`, `$id`, `$defs`, `$ref` (local only), `$comment`, `title`, `description`, `examples`, `type`, `properties`, `required`, `additionalProperties`, `items`, `minItems`, `enum`, `const`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `format` (`date-time` is asserted: the value must parse as a real date), `allOf`, `anyOf`, `oneOf`, `not`, `if`/`then`/`else`. `validate_fixtures.py` fails if any other keyword appears.

Known over-strict spots (they reject valid data, never accept invalid data): `type: integer` rejects `1.0` although JSON Schema 2020-12 accepts it; JSON Lines are split only on `\n`, so a raw U+2028/U+2029 inside a string is kept as data (a full validator in issue #4 replaces both).

## Enforcement boundary

`validate_fixtures.py` is a **regression check of examples and invariants**: it shows that the committed fixtures obey the rules below and that each listed mutation (a deliberately broken copy of a fixture) is rejected with the expected message. It is not a proof that every possible event stream is checked, and a stream it accepts is not thereby safe. The authoritative enforcement is the Rust backend: the core store checks invariants when an event is written (issue #7), and the approval policy classifies and decides requests (issue #8); the PR loop (issue #10) owns the review/merge checks. The table lists, per invariant, how far the validator goes and what the backend must test.

| Invariant | What this PR's validator checks (mutations) | Not covered here; required backend test |
| --- | --- | --- |
| A non-repeatable operation executes at most once | An operation id goes `recorded → started → final` once; a second operation with the same `idempotency_key` is rejected unless it supersedes an abandoned, failed-without-effect or reconciled-not-applied/undeterminable one with a new approval; the key is recomputed from `{kind, identity}` with the per-kind identity fields required by the schema and `description` excluded (`rerun_push_after_crash`, `e1_start_after_crash`, `e2b_supersede_recorded_op`, `e8a_key_not_canonical`, `b1a`, `b1b`, `b1c`) | The identity values themselves (unwrapped argv, normalized path, content digest) are taken as given. #7: unique key enforced in the append transaction, including concurrent writers. #8: identity computed from the request AgentDock executes, never from agent text |
| Merge and destructive approvals are user-only | `approval.resolved{approved}` must have actor `user` for host-policy kinds `pr_merge`, `branch_delete`, `worktree_remove`, `destructive_command` and for ACP classes `pr_merge`, `force_push`, `branch_delete`, `worktree_remove`, `destructive_command`, `unclassified`; ACP requests must say `operation_kind: tool_call` plus `classified_kind`; a grant authorizes only an operation of its own task, only before `expires_at`, and only the orchestrator starts operations (`e13_policy_approves_merge`, `b3a`, `b3b`, `n6a`, `n6b`, `n6c`) | Whether `classified_kind` is right for a given command cannot be seen in events. #8: classification tests (shell wrappers, aliases, unrecoverable commands → `unclassified`), a test that no policy rule can approve a user-only class, and client-method (`terminal/*`, `fs/*`) execution as Operations. Agent bypass/full-access modes are not enforceable by AgentDock at all (ADR-0002 APR-11, issue #26) |
| No automatic external side effect after a crash | While recovery is in progress only recovery-actor events are written; that actor may invalidate approvals, abandon recorded operations, mark started operations and running checks `outcome_unknown`, disconnect sessions and interrupt tasks with `host_crashed` (auto-resume off), but never start an operation or approve; nothing pending or unused may survive it; `system.recovery_completed` lists exactly what changed (`recovery_starts_op`, `recovery_approves`, `keep_pending_after_crash`, `auto_resume_after_crash`, `e1_recovery_keeps_recorded_op`, `e1_recovery_keeps_unused_grant`, `n1`) | #7: crash tests against the real store, killed at each point between persist and act, then restarted |
| Reconcile before re-entering `pr`/`ci`, completing or retrying | `no_unreconciled_operations` on `T07`, `T08`, `T28`, `T29`, `T34`, `T39`, `T47`; `pr_published_this_round` (a push in this PR round plus a PR) on `T08`/`T34`; `resume_phase` bounded by the interruption phase; an `outcome_unknown` operation shows `reconcile_needed`; strategy `none` can only find `undeterminable` (`b2`, `n3a`, `e14_resume_beyond_phase`, `n6d`) | #7: the same guards in the orchestrator's transition function. The probes themselves (`git ls-remote`, `gh pr view`) are #10 |
| Deletion preconditions | Checked only where a fixture ships a pre-deletion copy (`fixtures/predelete/`, currently fixture 12): the task ended in `final_state`, no operation recorded/started/`outcome_unknown`, no pending or unused approval, no live session; tombstone count; nothing after `task.deleted` (`n2`, `tombstone_count`, `event_after_delete`) | The tombstoned main stream no longer shows the payloads, so a stream without a sidecar is not checked. #7: preconditions checked inside the delete transaction |
| A started `pr_merge` is never killed | `operation.outcome_unknown{cause: killed}` is rejected for `pr_merge` (`b5`) | #7/#10: Pause/Cancel wait for the merge result; the UI disables them |
| Push and merge are bound to the published commit | `git_push` starts only if the latest checkpoint is clean with `head_sha == expected_sha`; `pr_merge.expected_sha` equals the latest succeeded push (`n3b`, `n3c`) | That the latest review covered this SHA and the base did not change (ADR-0002 PRL-1, PRL-11), and the actual `gh pr merge --match-head-commit`, are #10 |
| One blocking approval per task | A second blocking approval while one is pending is rejected; review-phase approvals are non-blocking (`n4`, `e5_review_approval_blocks`) | #7 |
| Persist before report/act; gap-free cursor | `seq` gap-free per authority, `recorded_at` monotonic, an approval resolution precedes the act it authorizes (`gap`, `act_before_approval_persisted`) | Only the order in the log is visible, not the wall-clock order of real effects. #7: transaction tests |
| Archive and attention rules (UX spec section 4/5) | Main sessions never auto-archive; a child auto-archives only when `completed`/`cancelled`, opened, and never restored; a waiting session is unarchived by the system in the same transaction; bulk "mark reviewed" only for completed/cancelled; every fixture's attention items equal its expectation (`archive_primary`, `archive_before_open`, `b4a`–`b4f`) | #7 projections. UX rule 3 (the session on screen is not listed) is UI-only. Deliberate differences: [attention.md](attention.md#divergences-from-the-ux-spec-owner-decision) |
| Capability-gated reattach | `session/load` and replay only when the current process advertised it; `features` re-derived from raw capabilities (`load_without_capability`, `replay_outside_load`, `e12_features_mismatch`) | Adapter implementation: gate calls on the live snapshot |
| No subscription-quota claims | No key implying a quota balance; `unknown` usage has no numbers (`quota_field_schema`, `opaque_quota_key`, `unknown_usage_with_numbers`) | UI shows subscription quota as unknown |

## Naming rules

| Item | Rule | Example |
| --- | --- | --- |
| JSON keys | `snake_case` | `external_session_id` |
| Enum values | `snake_case` strings | `awaiting_approval`, `provider_reported` |
| Event types | `<entity>.<past_tense_verb>` | `task.state_changed`, `operation.outcome_unknown` |
| IDs | `<prefix>_` + 26-char Crockford base32 ULID | `tsk_01JDQ001000000000000000001` |
| ID prefixes | `prj` project, `tsk` task, `ses` session, `evt` event, `apr` approval, `op` operation, `chk` check, `use` usage, `sum` summary, `cpt` checkpoint, `trn` turn | |
| Timestamps | RFC 3339 UTC, exactly millisecond precision, `Z` | `2026-11-17T02:00:07.000Z` |
| Hashes | lowercase hex sha256 of canonical JSON (sorted keys, no whitespace, UTF-8, non-ASCII unescaped) | `idempotency_key` = hash of `{"kind", "identity"}` (identity = `target` without `description`), `operation_fingerprint` |
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
| unknown event types on read | `EventBody` needs a fallback so a newer writer's event does not fail the whole read: e.g. a hand-written `Deserialize` that maps an unrecognized `type` to `Unknown { type_: String, payload: serde_json::Value }` (plain `#[serde(other)]` only works for unit variants and would drop the payload). Writers never emit `Unknown`. |
| tombstoned events | `tombstone: Option<Tombstone>`; when present, deserialize the body as `Unknown`/empty instead of the typed payload (the payload is `{}`) |
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
