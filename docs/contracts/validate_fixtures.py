#!/usr/bin/env python3
"""Validate AgentDock contract fixtures (ADR-0003) using only the Python standard library.

What it checks:
  1. schema/agentdock.schema.json only uses the JSON Schema keyword subset this script implements.
  2. Every fixture line is a valid EventEnvelope; every *.expected.json is a valid FixtureExpectation;
     fixtures/models.sample.json is a valid ModelSamples document.
  3. Semantic rules that JSON Schema cannot express: gap-free cursor, legal task/session transitions
     (transitions.json), approval/operation/check lifecycles, crash-recovery invariants, no automatic
     replay of non-repeatable operations, capability-gated reattach, auto-archive and auto-resume rules.
  4. The projection of each fixture (final states + derived attention items) equals its expectation.
  5. Every transition in transitions.json is exercised by at least one fixture.
  6. No property name anywhere suggests a known subscription quota balance.
  7. Negative self-test: a list of deliberate mutations (gap in cursor, re-running a push after a crash,
     recovery approving, early auto-resume, ...) must each be rejected with the expected message.
  8. The "Enforcement boundary" section is the same text in README.md and ADR-0003, names exactly the mutations
     of the self-test, and both files state the current number of mutations.
  9. The transition tables in state-machines.md equal transitions.json.

Passing is a regression result over the committed fixtures. It does not show that an invariant holds for other
streams; see the Enforcement boundary section.

Usage:  python -B -I docs/contracts/validate_fixtures.py   (exit code 0 = all good; -B avoids writing __pycache__)
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SCHEMA_PATH = ROOT / "schema" / "agentdock.schema.json"
TRANSITIONS_PATH = ROOT / "transitions.json"
FIXTURES_DIR = ROOT / "fixtures"
PREDELETE_DIR = FIXTURES_DIR / "predelete"
README_PATH = ROOT / "README.md"
ADR_PATH = ROOT.parent / "decisions" / "0003-task-session-event-contracts.md"

# Any property name (including inside opaque objects such as acp_agent_capabilities) that suggests a
# known subscription balance. 'on_quota_reset' (a user policy flag) is the only quota-named key allowed.
FORBIDDEN_NAME = re.compile(r"(remaining|_left|left_|balance|allowance|percent|pct|quota(?!_reset\Z))", re.I)


def canonical_sha256(obj) -> str:
    """sha256 of the canonical JSON form used for idempotency keys and approval fingerprints:
    keys sorted, no insignificant whitespace, UTF-8, non-ASCII characters unescaped."""
    text = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def ecma_to_python(pattern: str) -> str:
    """JSON Schema patterns are ECMA-262; in Python '$' also matches before a trailing newline.
    Replace every unescaped '$' outside a character class with '\\Z'."""
    out, i, in_class = [], 0, False
    while i < len(pattern):
        ch = pattern[i]
        if ch == "\\":
            out.append(pattern[i:i + 2])
            i += 2
            continue
        if in_class:
            in_class = ch != "]"
        elif ch == "[":
            in_class = True
        elif ch == "$":
            ch = r"\Z"
        out.append(ch)
        i += 1
    return "".join(out)

# --------------------------------------------------------------------------------------------
# Minimal JSON Schema (2020-12 subset) validator
# --------------------------------------------------------------------------------------------
SUBSCHEMA_KEYS = {"items", "not", "if", "then", "else", "additionalProperties"}
SUBSCHEMA_LIST_KEYS = {"oneOf", "anyOf", "allOf"}
SUBSCHEMA_MAP_KEYS = {"properties", "$defs"}
VALUE_KEYS = {
    "$schema", "$id", "$ref", "$comment", "title", "description", "type", "required", "enum", "const",
    "minimum", "maximum", "minLength", "maxLength", "pattern", "format", "minItems", "examples",
}
SUPPORTED = SUBSCHEMA_KEYS | SUBSCHEMA_LIST_KEYS | SUBSCHEMA_MAP_KEYS | VALUE_KEYS


def check_keywords(node, path="#"):
    errors = []
    if isinstance(node, bool):
        return errors
    if not isinstance(node, dict):
        return [f"{path}: schema must be an object or boolean"]
    for key, value in node.items():
        if key not in SUPPORTED:
            errors.append(f"{path}: unsupported keyword '{key}'")
        elif key in SUBSCHEMA_KEYS:
            errors += check_keywords(value, f"{path}/{key}")
        elif key in SUBSCHEMA_LIST_KEYS:
            for i, sub in enumerate(value):
                errors += check_keywords(sub, f"{path}/{key}/{i}")
        elif key in SUBSCHEMA_MAP_KEYS:
            for name, sub in value.items():
                errors += check_keywords(sub, f"{path}/{key}/{name}")
    return errors


def collect_property_names(node, out):
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "properties" and isinstance(value, dict):
                out.update(value.keys())
            collect_property_names(value, out)
    elif isinstance(node, list):
        for item in node:
            collect_property_names(item, out)


class Validator:
    def __init__(self, root):
        self.root = root
        self._regex = {}

    def resolve(self, ref):
        if not ref.startswith("#/"):
            raise ValueError(f"only local refs supported: {ref}")
        node = self.root
        for part in ref[2:].split("/"):
            node = node[part]
        return node

    def errors(self, instance, schema, path="$"):
        if schema is True:
            return []
        if schema is False:
            return [f"{path}: not allowed"]
        errs = []
        if "$ref" in schema:
            errs += self.errors(instance, self.resolve(schema["$ref"]), path)
        t = schema.get("type")
        if t is not None and not type_ok(instance, t):
            return errs + [f"{path}: expected {t}, got {type(instance).__name__}"]
        if "const" in schema and not json_equal(instance, schema["const"]):
            errs.append(f"{path}: expected const {schema['const']!r}, got {instance!r}")
        if "enum" in schema and not any(json_equal(instance, v) for v in schema["enum"]):
            errs.append(f"{path}: {instance!r} not in {schema['enum']}")
        if isinstance(instance, str):
            if "minLength" in schema and len(instance) < schema["minLength"]:
                errs.append(f"{path}: shorter than {schema['minLength']}")
            if "maxLength" in schema and len(instance) > schema["maxLength"]:
                errs.append(f"{path}: longer than {schema['maxLength']}")
            if "pattern" in schema:
                rx = self._regex.get(schema["pattern"])
                if rx is None:
                    rx = self._regex[schema["pattern"]] = re.compile(ecma_to_python(schema["pattern"]))
                if not rx.search(instance):
                    errs.append(f"{path}: {instance!r} does not match {schema['pattern']}")
            if schema.get("format") == "date-time":
                try:
                    datetime.strptime(instance, "%Y-%m-%dT%H:%M:%S.%fZ")
                except ValueError:
                    errs.append(f"{path}: {instance!r} is not a valid date-time")
        if is_number(instance):
            if "minimum" in schema and instance < schema["minimum"]:
                errs.append(f"{path}: {instance} < {schema['minimum']}")
            if "maximum" in schema and instance > schema["maximum"]:
                errs.append(f"{path}: {instance} > {schema['maximum']}")
        if isinstance(instance, list):
            if "minItems" in schema and len(instance) < schema["minItems"]:
                errs.append(f"{path}: fewer than {schema['minItems']} items")
            if "items" in schema:
                for i, item in enumerate(instance):
                    errs += self.errors(item, schema["items"], f"{path}[{i}]")
        if isinstance(instance, dict):
            props = schema.get("properties", {})
            for name in schema.get("required", []):
                if name not in instance:
                    errs.append(f"{path}: missing required '{name}'")
            for name, value in instance.items():
                if name in props:
                    errs += self.errors(value, props[name], f"{path}.{name}")
                elif "additionalProperties" in schema:
                    errs += self.errors(value, schema["additionalProperties"], f"{path}.{name}")
        for sub in schema.get("allOf", []):
            errs += self.errors(instance, sub, path)
        if "anyOf" in schema:
            if not any(not self.errors(instance, sub, path) for sub in schema["anyOf"]):
                errs.append(f"{path}: matches none of anyOf")
        if "oneOf" in schema:
            matches = sum(1 for sub in schema["oneOf"] if not self.errors(instance, sub, path))
            if matches != 1:
                errs.append(f"{path}: matches {matches} of oneOf (expected exactly 1)")
        if "not" in schema and not self.errors(instance, schema["not"], path):
            errs.append(f"{path}: must not match {json.dumps(schema['not'])[:120]}")
        if "if" in schema:
            if not self.errors(instance, schema["if"], path):
                if "then" in schema:
                    errs += self.errors(instance, schema["then"], path)
            elif "else" in schema:
                errs += self.errors(instance, schema["else"], path)
        return errs


def is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def type_ok(v, t):
    if isinstance(t, list):
        return any(type_ok(v, x) for x in t)
    return {
        "object": isinstance(v, dict),
        "array": isinstance(v, list),
        "string": isinstance(v, str),
        "boolean": isinstance(v, bool),
        "integer": isinstance(v, int) and not isinstance(v, bool),
        "number": is_number(v),
        "null": v is None,
    }[t]


def json_equal(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    return a == b


# --------------------------------------------------------------------------------------------
# Semantic replay of a fixture
# --------------------------------------------------------------------------------------------
TERMINAL_TASK = {"completed", "cancelled"}
ENDED_TASK = {"completed", "cancelled", "failed"}
LIVE_SESSION = {"starting", "idle", "active", "awaiting_permission", "suspended"}
IN_FLIGHT_TASK = {"preparing", "running", "awaiting_approval", "verifying", "review", "pr", "ci"}
REPLY_ROLES = {"primary", "implementation", "repair"}
PHASE_ORDER = ["running", "verifying", "review", "pr", "ci"]
BLOCKING_APPROVAL_STATES = {"running", "pr", "ci"}
NON_BLOCKING_APPROVAL_STATES = {"verifying", "review"}
# Task states in which an operation kind may be recorded and started (docs/contracts/checkpoint-and-replay.md).
OP_STATES = {
    "git_push": {"pr"}, "pr_create": {"pr"}, "pr_update": {"pr"}, "pr_comment": {"review", "pr", "ci"},
    "pr_merge": {"ci"}, "destructive_command": {"running"}, "external_write": {"running"},
    "branch_delete": ENDED_TASK, "worktree_remove": ENDED_TASK,
}
CLEANUP_KINDS = {"branch_delete", "worktree_remove"}
# Host-policy approvals that only a human may grant; policy may still deny or let them expire.
HUMAN_ONLY_KINDS = {"pr_merge", "branch_delete", "worktree_remove", "destructive_command"}
# ACP permission requests whose backend classification (PolicyClass) only a human may approve.
HUMAN_ONLY_CLASSES = {"pr_merge", "force_push", "branch_delete", "worktree_remove", "destructive_command", "unclassified"}
# A started operation of these kinds is never killed; cancel/interrupt waits for its result (ADR-0002 PRL-5).
UNINTERRUPTIBLE_KINDS = {"pr_merge"}
SUPERSEDABLE = {"reconciled_not_applied", "reconciled_undeterminable", "abandoned"}
DONE_OP = {"succeeded", "reconciled_applied"}
ATTENTION_STOPS = {"refusal", "max_tokens", "max_turn_requests"}
# UX terminal states (docs/ux/states-and-indicators.md section 2): results the user can view/acknowledge.
ACK_TASK_STATES = {"completed", "cancelled", "failed", "interrupted"}
BULK_TASK_STATES = {"completed", "cancelled"}
BULK_SESSION_OUTCOMES = {"succeeded", "cancelled"}
AUTO_ARCHIVE_OUTCOMES = {"succeeded", "cancelled"}
REVIEW_SESSION_OUTCOMES = {"succeeded", "failed", "cancelled"}
# UX section 5: a finished, failed or interrupted sub-task may be archived by the user.
MANUAL_ARCHIVE_CHILD_STATES = {"closed", "failed", "suspended", "disconnected"}
# The only events the recovery actor may write (checkpoint-and-replay.md, crash recovery). Each predicate sees the
# payload; a tombstoned event (payload {}) is checked by type only.
RECOVERY_WRITES = {
    "approval.resolved": lambda p: p.get("state") == "invalidated",
    "operation.outcome_unknown": lambda p: p.get("cause") == "host_crash",
    "operation.abandoned": lambda p: p.get("reason") == "host_recovery",
    "check.finished": lambda p: p.get("state") == "outcome_unknown",
    "session.state_changed": lambda p: p.get("to") == "disconnected" and p.get("trigger") == "host_recovery",
    "task.state_changed": lambda p: p.get("to") == "interrupted"
    and (p.get("interruption") or {}).get("reason") == "host_crashed",
    # An archived session that a recovery event made wait is unarchived in that same transaction (UX-47).
    "session.unarchived": lambda p: p.get("by") == "system",
    "system.recovery_started": lambda p: True,
    "system.recovery_completed": lambda p: True,
}
# Who may report the result of a started operation or a finished check (never the agent, policy or the user).
RESULT_ACTORS = {"orchestrator", "integration"}


def operation_identity(target):
    """Identity of an operation target: every field except the free-text description."""
    return {k: v for k, v in target.items() if k != "description"}


def idempotency_key(kind, target):
    return canonical_sha256({"kind": kind, "identity": operation_identity(target)})


def derive_features(raw):
    """features as defined by docs/contracts/acp-capabilities.md, derived from ACP v1 agentCapabilities."""
    def obj(x):
        return isinstance(x, dict)
    sc, pc = raw.get("sessionCapabilities") or {}, raw.get("promptCapabilities") or {}
    mc, au = raw.get("mcpCapabilities") or {}, raw.get("auth") or {}
    return {
        "load_session": raw.get("loadSession") is True,
        "resume_session": obj(sc.get("resume")), "close_session": obj(sc.get("close")),
        "list_sessions": obj(sc.get("list")), "delete_session": obj(sc.get("delete")),
        "additional_directories": obj(sc.get("additionalDirectories")), "system_prompt": obj(sc.get("systemPrompt")),
        "prompt_image": pc.get("image") is True, "prompt_audio": pc.get("audio") is True,
        "prompt_embedded_context": pc.get("embeddedContext") is True,
        "mcp_http": mc.get("http") is True, "mcp_sse": mc.get("sse") is True, "logout": obj(au.get("logout")),
    }


def feature_errors(snapshot):
    if snapshot["track"] != "v1_stable":
        # The v2 draft has no agreed derivation of `features` yet, so nothing about such a snapshot could be checked.
        return [f"track {snapshot['track']} is not accepted: only v1_stable capability snapshots are covered by this "
                f"contract revision"]
    raw = snapshot["acp_agent_capabilities"]
    errs = [f"features.{k} does not match acp_agent_capabilities (derived {v})"
            for k, v in derive_features(raw).items() if snapshot["features"].get(k) != v]
    if '"_meta"' in json.dumps(raw):
        errs.append("acp_agent_capabilities must be stored without _meta keys")
    return errs


class Replay:
    def __init__(self, name, transitions):
        self.name = name
        self.errors = []
        self.task_edges = {(t["from"], t["to"]): t for t in transitions["task"]["transitions"]}
        self.session_edges = {(t["from"], t["to"]): t for t in transitions["session"]["transitions"]}
        self.covered = set()
        self.tasks, self.sessions, self.approvals, self.operations, self.checks = {}, {}, {}, {}, {}
        self.turns = {}
        self.event_ids = set()
        self.authority = None
        self.last_seq = 0
        self.last_recorded = ""
        self.recovery = None
        self.consumed_approvals = set()
        self.tombstoned = {}      # task_id -> list of tombstone 'at' values
        self.live_counts = {}     # task_id -> number of non-tombstoned events
        self.deleted = set()
        self.checkpoints = {}     # task_id -> worktree of the latest task.checkpoint_recorded
        self.must_unarchive = set()
        self.deleted_id_claims = []  # (recovery_completed event, key, ids claimed to belong to a deleted task)

    def err(self, ev, msg):
        self.errors.append(f"{self.name} seq={ev.get('seq')} {ev.get('type')}: {msg}")

    # -- envelope ---------------------------------------------------------------------------
    def envelope(self, ev):
        if self.authority is None:
            self.authority = ev["authority_id"]
        elif ev["authority_id"] != self.authority:
            self.err(ev, "authority_id changed within one stream")
        if ev["seq"] != self.last_seq + 1:
            self.err(ev, f"cursor not gap-free: expected {self.last_seq + 1}")
        self.last_seq = ev["seq"]
        if ev["id"] in self.event_ids:
            self.err(ev, "duplicate event id")
        if ev.get("causation_id") and ev["causation_id"] not in self.event_ids:
            self.err(ev, "causation_id does not reference an earlier event")
        self.event_ids.add(ev["id"])
        if ev["recorded_at"] < self.last_recorded:
            self.err(ev, "recorded_at went backwards")
        if ev["occurred_at"] > ev["recorded_at"]:
            self.err(ev, "occurred_at is after recorded_at")
        self.last_recorded = ev["recorded_at"]
        is_recovery_actor = ev["actor"]["kind"] == "recovery"
        if is_recovery_actor != (ev["provenance"] == "recovery"):
            self.err(ev, "actor 'recovery' and provenance 'recovery' must go together")
        if self.recovery is not None and not ev["type"].startswith("system.") and not is_recovery_actor:
            self.err(ev, "only recovery-actor events may be written while recovery is in progress")
        if is_recovery_actor:
            allowed = RECOVERY_WRITES.get(ev["type"])
            if allowed is None or not ("tombstone" in ev or allowed(ev["payload"])):
                self.err(ev, "the recovery actor may only invalidate approvals, mark started operations/running checks "
                             "outcome_unknown{host_crash}, abandon recorded operations (host_recovery), disconnect "
                             "sessions (host_recovery), interrupt tasks (host_crashed) and unarchive (by: system) an "
                             "archived session that these events made wait")
            elif self.recovery is None and ev["type"] != "system.recovery_started":
                self.err(ev, "recovery-actor events are only written between system.recovery_started and "
                             "system.recovery_completed")
        tid = ev.get("task_id")
        if tid in self.deleted:
            return self.err(ev, "event for a deleted task")
        if "tombstone" in ev:
            self.tombstoned.setdefault(tid, []).append(ev["tombstone"]["at"])
            if self.recovery is not None and is_recovery_actor:
                # The task was deleted later: payload ids are gone, routing fields and the type remain.
                self.recovery["tombstoned"].append(ev)
            return
        if tid is not None and ev["type"] != "task.deleted":
            self.live_counts[tid] = self.live_counts.get(tid, 0) + 1
        if ev["provenance"] == "acp_replay":
            s = self.sessions.get(ev.get("session_id"))
            if not s or s["state"] != "starting" or s["launch_method"] != "load":
                self.err(ev, "acp_replay events are only valid while a session/load is in progress")
            elif (s["snapshot"] is None or s["snapshot_seq"] < s["launch_seq"]
                  or not s["snapshot"]["features"]["load_session"]):
                self.err(ev, "acp_replay requires that the current process (capabilities detected after this launch) "
                             "advertised loadSession")
        if tid is not None and ev["type"] not in ("task.created", "task.deleted") and tid not in self.tasks:
            self.err(ev, "unknown task_id")
        if "session_id" in ev and ev["type"] != "session.created":
            s = self.sessions.get(ev["session_id"])
            if s is None:
                self.err(ev, "unknown session_id")
            elif s["task_id"] != ev.get("task_id"):
                self.err(ev, "session belongs to another task")

    # -- task -------------------------------------------------------------------------------
    def task_created(self, ev, p):
        tid = ev["task_id"]
        if tid in self.tasks:
            return self.err(ev, "task already exists")
        self.covered.add("T01")
        if ev["actor"]["kind"] != "user":
            self.err(ev, "T01 actor must be user")
        self.tasks[tid] = {
            "state": "queued", "policy": dict(p["auto_resume_policy"]), "interruption": None, "resume_phase": None,
            "return_state": None, "approval_id": None, "entered_seq": ev["seq"], "ack_seq": 0,
            "state_entered": {"queued": ev["seq"]}, "pr_round_seq": None,
        }

    def task_policy_updated(self, ev, p):
        t = self.tasks.get(ev["task_id"])
        if t is None:
            return
        if ev["actor"]["kind"] != "user":
            self.err(ev, "only the user changes auto_resume_policy")
        t["policy"] = dict(p["auto_resume_policy"])
        intr = t["interruption"]
        if t["state"] == "interrupted" and intr and intr["auto_resume_armed"]:
            flag = {"quota_exhausted": "on_quota_reset", "rate_limited": "on_rate_limit"}[intr["reason"]]
            if not t["policy"][flag]:
                t["interruption"] = dict(intr, auto_resume_armed=False)  # disabling disarms; enabling never arms

    def task_deleted(self, ev, p):
        tid = ev["task_id"]
        if ev["actor"]["kind"] != "user":
            self.err(ev, "only the user deletes a task")
        if self.live_counts.get(tid):
            self.err(ev, f"{self.live_counts[tid]} event(s) of the deleted task were not tombstoned")
        marks = self.tombstoned.get(tid, [])
        if len(marks) != p["events_tombstoned"]:
            self.err(ev, f"events_tombstoned={p['events_tombstoned']} but {len(marks)} tombstones precede it")
        if not marks:
            self.err(ev, "task.deleted without any tombstoned history")
        if any(m != ev["recorded_at"] for m in marks):
            self.err(ev, "tombstone.at must equal the task.deleted recorded_at")
        self.deleted.add(tid)
        self.tasks.pop(tid, None)

    def task_state_changed(self, ev, p):
        t = self.tasks.get(ev["task_id"])
        if t is None:
            return
        tid = ev["task_id"]
        frm, to = p["from"], p["to"]
        if t["state"] != frm:
            return self.err(ev, f"from={frm} but task is {t['state']}")
        edge = self.task_edges.get((frm, to))
        if edge is None:
            return self.err(ev, f"illegal task transition {frm} -> {to}")
        self.covered.add(edge["id"])
        actor = ev["actor"]["kind"]
        if actor not in edge["actors"]:
            self.err(ev, f"{edge['id']}: actor {actor} not in {edge['actors']}")
        if p["trigger"] not in edge["triggers"]:
            self.err(ev, f"{edge['id']}: trigger {p['trigger']} not in {edge['triggers']}")
        for cond in edge.get("conditions", []):
            getattr(self, "cond_" + cond)(ev, p, t, tid)
        self._generic_task_rules(ev, p, t, tid)
        if to == "interrupted":
            intr = p["interruption"]
            if actor == "recovery" and intr["reason"] != "host_crashed":
                self.err(ev, "recovery may only interrupt with reason host_crashed")
            if intr["auto_resume_armed"]:
                flag = {"quota_exhausted": "on_quota_reset", "rate_limited": "on_rate_limit"}.get(intr["reason"])
                if flag is None:
                    self.err(ev, f"auto_resume_armed is only allowed for quota_exhausted/rate_limited")
                elif not t["policy"][flag]:
                    self.err(ev, f"auto_resume_armed but task policy {flag} is false")
            if frm in PHASE_ORDER:
                phase = frm
            elif frm == "awaiting_approval":
                phase = t["return_state"]
            else:  # preparing
                phase = t["resume_phase"] or "running"
            if intr["phase"] != phase:
                self.err(ev, f"interruption.phase must be {phase} (the phase being left), not {intr['phase']}")
            t["interruption"] = intr
        if to == "queued":  # T44 records where to resume; T47 (retry) always restarts from running
            t["resume_phase"] = None if frm == "failed" else p.get("resume_phase")
        if frm == "interrupted":
            t["interruption"] = None
        if to == "awaiting_approval":
            t["return_state"], t["approval_id"] = p["return_state"], p["approval_id"]
            if p["return_state"] != frm:
                self.err(ev, f"return_state {p['return_state']} must equal the state being left ({frm})")
        if frm == "awaiting_approval":
            t["approval_id"] = None
        if frm == "preparing" and to in ("verifying", "review", "pr", "ci") and t["resume_phase"] != to:
            self.err(ev, f"preparing -> {to} requires the task's recorded resume_phase to be {to}")
        if frm == "preparing" and to in IN_FLIGHT_TASK:
            t["resume_phase"] = None
        if frm == "review" and to == "pr":  # T28 starts a new PR round; resume (T07) continues the old one
            t["pr_round_seq"] = ev["seq"]
        t["state"] = to
        if frm != "awaiting_approval":  # an approval detour is not a new phase
            t["state_entered"][to] = ev["seq"]
        t["entered_seq"] = ev["seq"]

    def _generic_task_rules(self, ev, p, t, tid):
        to = p["to"]
        if to != "awaiting_approval":
            for aid, a in self.approvals.items():
                if a["task_id"] == tid and a["state"] == "pending":
                    self.err(ev, f"approval {aid} still pending while the task moves to {to}; resolve it first")
        for oid, op in self.operations.items():
            if op["task_id"] != tid:
                continue
            if op["state"] == "recorded":
                a = self.approvals.get(op["approval"])
                if a and a["state"] in ("denied", "expired", "cancelled", "invalidated"):
                    self.err(ev, f"operation {oid} is still recorded although its approval was {a['state']}; "
                                 f"record operation.abandoned first")
            if op["state"] in ("recorded", "started") and to != "awaiting_approval" and to not in OP_STATES[op["kind"]]:
                self.err(ev, f"operation {oid} ({op['kind']}) is {op['state']} but the task moves to {to}")

    def cond_resume_phase_equals_to(self, ev, p, t, tid):
        if p.get("resume_phase") != p["to"]:
            self.err(ev, "resume_phase must equal 'to'")

    def cond_resume_phase_within_interrupted_phase(self, ev, p, t, tid):
        phase = (t["interruption"] or {}).get("phase", "running")
        if PHASE_ORDER.index(p["resume_phase"]) > PHASE_ORDER.index(phase):
            self.err(ev, f"resume_phase {p['resume_phase']} is beyond the interrupted phase {phase}")

    def cond_retry_restarts_from_running(self, ev, p, t, tid):
        # The schema already forbids the field on failed -> queued; this keeps the rule next to the other conditions.
        if "resume_phase" in p:
            self.err(ev, "a retry (failed -> queued) always restarts from running; it carries no resume_phase")

    def cond_no_unreconciled_operations(self, ev, p, t, tid):
        for oid, op in self.operations.items():
            if op["task_id"] == tid and op["state"] in ("recorded", "started", "outcome_unknown"):
                self.err(ev, f"operation {oid} is {op['state']}; reconcile it before {p['from']} -> {p['to']}")

    def cond_no_open_operations(self, ev, p, t, tid):
        for oid, op in self.operations.items():
            if op["task_id"] == tid and op["state"] in ("recorded", "started"):
                hint = ("wait for its result (a started merge cannot be killed)" if op["state"] == "started"
                        and op["kind"] in UNINTERRUPTIBLE_KINDS else
                        "abandon it (or kill it and record outcome_unknown)")
                self.err(ev, f"operation {oid} is {op['state']}; {hint} before the task leaves {p['from']}")
        for aid, a in self.approvals.items():
            if a["task_id"] == tid and a["state"] == "approved" and a["source"] == "host_policy" \
                    and aid not in self.consumed_approvals:
                self.err(ev, f"approval {aid} is approved but unused; invalidate it before the task leaves {p['from']}")

    def cond_approval_requested_before(self, ev, p, t, tid):
        a = self.approvals.get(p["approval_id"])
        if not a or a["state"] != "pending" or a["task_id"] != tid:
            return self.err(ev, "approval must be recorded as pending before the task waits on it")
        if a["return_state"] != p["from"]:
            self.err(ev, "only a blocking approval whose return_state is the current state can put the task into awaiting_approval")

    def cond_return_state_matches(self, ev, p, t, tid):
        if p["to"] != t["return_state"]:
            self.err(ev, f"must return to {t['return_state']}, not {p['to']}")
        if p.get("approval_id") != t["approval_id"]:
            self.err(ev, "approval_id must be the approval the task was waiting on")

    def cond_approval_resolved_before(self, ev, p, t, tid):
        a = self.approvals.get(p.get("approval_id"))
        if not a or a["state"] == "pending":
            self.err(ev, "approval resolution must be persisted before acting on it")

    def cond_approval_not_pending_after(self, ev, p, t, tid):
        sid = ev.get("session_id") if ev["type"] == "session.state_changed" else None
        for aid, a in self.approvals.items():
            if a["task_id"] == tid and a["state"] == "pending" and (sid is None or a.get("session_id") == sid):
                self.err(ev, f"approval {aid} still pending; resolve (cancel/invalidate) it first")

    def cond_local_checks_passed(self, ev, p, t, tid):
        self._checks_passed(ev, tid, "local", t["state_entered"].get("verifying", 0))

    def cond_ci_checks_passed(self, ev, p, t, tid):
        self._checks_passed(ev, tid, "ci", t["state_entered"].get("ci", 0))

    def _checks_passed(self, ev, tid, origin, since):
        relevant = [c for c in self.checks.values() if c["task_id"] == tid and c["origin"] == origin and c["seq"] > since]
        if not relevant:
            self.err(ev, f"no {origin} checks recorded in this phase")
        for c in relevant:
            if c["state"] != "passed":
                self.err(ev, f"{origin} check {c['name']} is {c['state']}")

    def _op_done(self, tid, kinds, since=0):
        return any(op["task_id"] == tid and op["kind"] in kinds and op["state"] in DONE_OP and op["seq"] > since
                   for op in self.operations.values())

    def cond_pr_published_this_round(self, ev, p, t, tid):
        since = t["pr_round_seq"]
        if since is None:
            return self.err(ev, f"{p['from']} -> ci without a PR round (the task never went review -> pr)")
        if not self._op_done(tid, ("git_push",), since):
            self.err(ev, f"{p['from']} -> ci requires a git_push that succeeded (or was reconciled applied) in this "
                         f"PR round (since seq {since})")
        if not (self._op_done(tid, ("pr_create",)) or self._op_done(tid, ("pr_update",), since)):
            self.err(ev, f"{p['from']} -> ci requires a PR: a succeeded pr_create, or a pr_update in this PR round")

    def cond_merge_evidence_if_integration(self, ev, p, t, tid):
        if ev["actor"]["kind"] == "integration" and not self._op_done(tid, ("pr_merge",)):
            self.err(ev, "integration may complete a task only with merge evidence (a succeeded pr_merge operation)")

    def cond_orchestrator_only_if_auto_resume_armed_and_due(self, ev, p, t, tid):
        actor = ev["actor"]["kind"]
        intr = t["interruption"] or {}
        if actor == "orchestrator":
            if p["trigger"] != "scheduled_resume":
                self.err(ev, "orchestrator may only resume via scheduled_resume")
            if not intr.get("auto_resume_armed"):
                self.err(ev, "automatic resume without an armed auto_resume")
            elif ev["recorded_at"] < intr["retry_hint"]["not_before"]:
                self.err(ev, "automatic resume before retry_hint.not_before")
        elif p["trigger"] != "resume_requested":
            self.err(ev, "user resume must use trigger resume_requested")

    def task_ack(self, ev, p):
        t = self.tasks[ev["task_id"]]
        if ev["actor"]["kind"] != "user":
            self.err(ev, "only the user acknowledges outcomes")
        if p["acknowledged_state"] != t["state"] or t["state"] not in ACK_TASK_STATES:
            self.err(ev, "acknowledged_state must be the current completed/cancelled/failed/interrupted state")
        if p["method"] == "bulk_marked_reviewed" and t["state"] not in BULK_TASK_STATES:
            self.err(ev, f"'Mark completed as reviewed' never applies to a {t['state']} task")
        t["ack_seq"] = ev["seq"]

    def checkpoint(self, ev, p):
        t = self.tasks[ev["task_id"]]
        if p["phase"] != t["state"]:
            self.err(ev, f"checkpoint phase {p['phase']} is not the task state {t['state']}")
        self.checkpoints[ev["task_id"]] = p.get("worktree")  # the latest checkpoint, with or without a worktree

    # -- session ----------------------------------------------------------------------------
    def session_created(self, ev, p):
        sid = ev["session_id"]
        if sid in self.sessions:
            return self.err(ev, "session already exists")
        self.covered.add("S01")
        if ev["actor"]["kind"] != "orchestrator":
            self.err(ev, "S01 actor must be orchestrator")
        parent = p.get("parent_session_id")
        if parent and (parent not in self.sessions or self.sessions[parent]["task_id"] != ev["task_id"]):
            self.err(ev, "parent session must exist in the same task")
        sup = p.get("supersedes_session_id")
        if sup and self.sessions.get(sup, {}).get("state") not in ("closed", "failed"):
            self.err(ev, "a superseded session must already be closed/failed")
        if self.tasks[ev["task_id"]]["state"] in TERMINAL_TASK:
            self.err(ev, "no new sessions for a terminal task")
        self.sessions[sid] = {
            "task_id": ev["task_id"], "role": p["role"], "parent": parent, "state": "starting",
            "launch_method": p["launch_method"], "external_id": p.get("external_session_id"),
            "snapshot": None, "snapshot_seq": 0, "launch_seq": ev["seq"], "last_stop": None,
            "outcome": None, "closed_seq": 0, "ack_seq": 0, "opened_seq": 0, "archived": None, "restored": False,
            "limited_turn": None, "waiting_approval": None,
        }

    def session_caps(self, ev, p):
        s = self.sessions[ev["session_id"]]
        if s["state"] != "starting":
            self.err(ev, "capabilities are detected right after initialize, while starting")
        for e in feature_errors(p["snapshot"]):
            self.err(ev, e)
        s["snapshot"], s["snapshot_seq"] = p["snapshot"], ev["seq"]

    def session_state_changed(self, ev, p):
        s = self.sessions.get(ev["session_id"])
        if s is None:
            return
        frm, to = p["from"], p["to"]
        if s["state"] != frm:
            return self.err(ev, f"from={frm} but session is {s['state']}")
        edge = self.session_edges.get((frm, to))
        if edge is None:
            return self.err(ev, f"illegal session transition {frm} -> {to}")
        self.covered.add(edge["id"])
        if ev["actor"]["kind"] not in edge["actors"]:
            self.err(ev, f"{edge['id']}: actor {ev['actor']['kind']} not in {edge['actors']}")
        if p["trigger"] not in edge["triggers"]:
            self.err(ev, f"{edge['id']}: trigger {p['trigger']} not in {edge['triggers']}")
        for cond in edge.get("conditions", []):
            if cond == "launch_method_advertised":
                self.check_launch(ev, s)
            elif cond == "reattach_capability_required":
                self.check_reattach(ev, s, p)
            else:
                getattr(self, "cond_" + cond)(ev, p, None, s["task_id"])
        if p["trigger"] in ("prompt_submitted", "continue_prompt"):
            if self.turns.get(p["turn_id"]) != ev["session_id"]:
                self.err(ev, "turn must be recorded with session.prompt_submitted first")
        if p["trigger"] == "permission_requested":
            a = self.approvals.get(p["approval_id"])
            if not a or a["state"] != "pending" or a["source"] != "acp_permission":
                self.err(ev, "ACP permission must be recorded as a pending approval first")
            elif a["session_id"] != ev["session_id"]:
                self.err(ev, "permission_requested must name an approval of this session")
            s["waiting_approval"] = p["approval_id"]
        if p["trigger"] == "permission_resolved" and p.get("approval_id") != s["waiting_approval"]:
            self.err(ev, "permission_resolved must name the approval the session is waiting on")
        if edge["id"] in ("S09", "S14"):
            for other_id, other in self.approvals.items():
                if other["session_id"] == ev["session_id"] and other["state"] == "pending":
                    self.err(ev, f"{edge['id']}: approval {other_id} of this session is still pending (the adapter "
                                 f"forwards one permission request of a session at a time)")
        if p["trigger"] == "reattach_attempt":
            s["launch_method"], s["launch_seq"] = p["launch_method"], ev["seq"]
        if to == "idle" and frm == "starting" and p.get("external_session_id"):
            s["external_id"] = p["external_session_id"]
        if p["trigger"] == "turn_ended":
            limited = p["stop_reason"] == "cancelled" and s["limited_turn"] == p["turn_id"]
            s["last_stop"] = "output_limited" if limited else p["stop_reason"]
        elif to in ("active", "awaiting_permission"):
            s["last_stop"] = None
        if to in ("closed", "failed"):
            s["outcome"], s["closed_seq"] = p["outcome"], ev["seq"]
        s["state"] = to

    def check_launch(self, ev, s):
        snap = s["snapshot"]
        if snap is None or s["snapshot_seq"] < s["launch_seq"]:
            return self.err(ev, "capabilities must be detected for this launch before the session is ready")
        need = {"load": "load_session", "resume": "resume_session"}.get(s["launch_method"])
        if need and not snap["features"][need]:
            self.err(ev, f"launch_method {s['launch_method']} used but {need} was not advertised")

    def check_reattach(self, ev, s, p):
        need = {"load": "load_session", "resume": "resume_session"}[p["launch_method"]]
        if not s["snapshot"] or not s["snapshot"]["features"][need]:
            self.err(ev, f"reattach via {p['launch_method']} without advertised {need}")
        if not s["external_id"]:
            self.err(ev, "reattach needs a known external_session_id")

    def prompt(self, ev, p):
        self.turns[p["turn_id"]] = ev["session_id"]

    def output_limited(self, ev, p):
        s = self.sessions[ev["session_id"]]
        if p["action"] == "turn_cancelled":
            if s["state"] not in ("active", "awaiting_permission") or not p.get("turn_id"):
                self.err(ev, "turn_cancelled output limits apply to the session's active turn (turn_id required)")
            s["limited_turn"] = p.get("turn_id")

    def session_ack(self, ev, p):
        s = self.sessions[ev["session_id"]]
        if s["state"] not in ("closed", "failed"):
            self.err(ev, "a session result can only be acknowledged once the session is closed/failed")
        if ev["actor"]["kind"] != "user":
            self.err(ev, "only the user acknowledges a session result")
        if p["method"] == "bulk_marked_reviewed" and (s["state"] != "closed" or s["outcome"] not in BULK_SESSION_OUTCOMES):
            self.err(ev, f"'Mark completed as reviewed' never applies to a {s['state']} session with outcome "
                         f"{s['outcome']}")
        s["ack_seq"] = ev["seq"]
        if p["method"] == "opened":
            s["opened_seq"] = ev["seq"]

    # Archiving follows docs/ux/states-and-indicators.md section 5 (UX-40..UX-47).
    def session_archived(self, ev, p):
        sid = ev["session_id"]
        s = self.sessions[sid]
        if s["archived"]:
            self.err(ev, "session is already archived")
        if p["by"] == "auto":
            if ev["actor"]["kind"] != "orchestrator":
                self.err(ev, "auto-archive is written by the orchestrator")
            if s["parent"] is None:
                self.err(ev, "a main (parent-less) session is never auto-archived")
            if s["state"] != "closed" or s["outcome"] not in AUTO_ARCHIVE_OUTCOMES:
                self.err(ev, f"auto-archive requires a closed child session with outcome succeeded or cancelled; a "
                             f"failed session is never auto-archived (state {s['state']}, outcome {s['outcome']})")
            elif s["opened_seq"] <= s["closed_seq"]:
                self.err(ev, "auto-archive requires the result to have been opened after the session finished "
                             "(marking it reviewed does not count)")
            if s["restored"]:
                self.err(ev, "a session the user restored is never auto-archived again")
        else:
            if ev["actor"]["kind"] != "user":
                self.err(ev, "archived by 'user' must have a user actor")
            if s["parent"] is not None and s["state"] not in MANUAL_ARCHIVE_CHILD_STATES:
                self.err(ev, f"manual archive of a child session is offered only when it is closed, failed, suspended "
                             f"or disconnected (session is {s['state']})")
            if s["parent"] is None:
                t = self.tasks[s["task_id"]]
                paused = t["state"] == "interrupted" and (t["interruption"] or {}).get("reason") == "user_paused"
                if t["state"] not in ACK_TASK_STATES or paused:
                    self.err(ev, f"manual archive of a main session is offered only in a terminal task state, not "
                                 f"while it is running, queued, paused or awaiting (task is "
                                 f"{'paused' if paused else t['state']})")
            if sid in self._waiting_sessions():
                self.err(ev, "a session that is waiting for the user (needs reply) cannot be archived")
        s["archived"] = p["by"]

    def session_unarchived(self, ev, p):
        sid = ev["session_id"]
        s = self.sessions[sid]
        if not s["archived"]:
            self.err(ev, "session is not archived")
        if p["by"] == "user":
            if ev["actor"]["kind"] != "user":
                self.err(ev, "unarchived by 'user' must have a user actor")
            s["restored"] = True
        else:
            writer = "recovery" if self.recovery is not None else "orchestrator"
            if ev["actor"]["kind"] != writer:
                self.err(ev, "a system unarchive is written by the orchestrator, or by the recovery actor while "
                             "recovery is in progress")
            if sid not in self._waiting_sessions():
                self.err(ev, "a system unarchive happens only when the archived session is waiting for the user")
        s["archived"] = None
        self.must_unarchive.discard(sid)

    def _waiting_sessions(self):
        """Sessions that are 'waiting' in the UX sense (awaiting approval or input): those named by a needs_reply
        item, the parent-less sessions of a task with a task-level needs_reply item, and awaiting_permission."""
        waiting = {sid for sid, s in self.sessions.items() if s["state"] == "awaiting_permission"}
        for kind, _reason, tid, sid, _ref in self.attention(filter_archived=False):
            if kind != "needs_reply":
                continue
            if sid:
                waiting.add(sid)
            else:
                waiting |= {x for x, s in self.sessions.items() if s["task_id"] == tid and s["parent"] is None}
        return waiting

    # -- approvals ----------------------------------------------------------------------------
    def approval_requested(self, ev, p):
        aid = p["approval_id"]
        if aid in self.approvals:
            return self.err(ev, "approval already exists")
        tid = ev["task_id"]
        st = self.tasks[tid]["state"]
        rs = p.get("return_state")
        kind = p["operation_kind"]
        if rs is not None:
            for other_id, other in self.approvals.items():
                if other["task_id"] == tid and other["state"] == "pending" and other["return_state"] is not None:
                    self.err(ev, f"approval {other_id} of this task is already pending and blocking; a second blocking "
                                 f"approval is held by the adapter/policy until the first is resolved")
        if p["source"] == "acp_permission":
            if kind != "tool_call":
                self.err(ev, "ACP permission approvals use operation_kind 'tool_call'; what the call does is classified_kind")
            if "session_id" not in ev:
                self.err(ev, "ACP permission approvals are session-scoped")
            elif self.sessions[ev["session_id"]]["state"] != "active":
                self.err(ev, "ACP permission requests arrive during an active turn")
            if ev["actor"]["kind"] != "adapter":
                self.err(ev, "ACP permission approvals are requested by the adapter")
            want = canonical_sha256({"kind": "tool_call", "target": {"tool_call_id": p["acp"]["tool_call_id"],
                                                                       "title": p["title"]}})
            if p["operation_fingerprint"] != want:
                self.err(ev, "ACP operation_fingerprint is not sha256(canonical {kind: tool_call, target: {tool_call_id, title}})")
        else:
            if ev["actor"]["kind"] != "policy":
                self.err(ev, "host_policy approvals are requested by policy")
            op = self.operations.get(p["operation_id"])
            if op is None or op["task_id"] != tid or op["state"] != "recorded" or op["approval"] != aid:
                self.err(ev, "host_policy approval must follow operation.recorded of the same task naming this approval_id")
            elif kind != op["kind"] or p["operation_fingerprint"] != op["key"]:
                self.err(ev, "host_policy operation_kind/operation_fingerprint must equal the operation's kind/idempotency_key")
        if st in BLOCKING_APPROVAL_STATES:
            if rs != st:
                self.err(ev, f"an approval requested while the task is {st} blocks it: return_state must be {st}")
        elif st in NON_BLOCKING_APPROVAL_STATES:
            if rs is not None:
                self.err(ev, f"approval requested while task is {st} is non-blocking and must not carry return_state")
        elif st in ENDED_TASK:
            if p["source"] != "host_policy" or kind not in CLEANUP_KINDS or rs is not None:
                self.err(ev, f"only non-blocking cleanup approvals ({', '.join(sorted(CLEANUP_KINDS))}) exist for a {st} task")
        else:
            self.err(ev, f"approvals cannot be requested while the task is {st}")
        self.approvals[aid] = {"task_id": tid, "session_id": ev.get("session_id"), "state": "pending",
                               "source": p["source"], "fingerprint": p["operation_fingerprint"], "kind": kind,
                               "classified": p.get("classified_kind"), "return_state": rs,
                               "expires_at": p.get("expires_at"),
                               "options": {o["option_id"]: o["kind"] for o in p.get("acp", {}).get("options", [])}}

    def routed(self, ev, entity, what):
        """The envelope's task_id (and session_id, for an approval) must be the ones of the entity the payload names."""
        if ev.get("task_id") != entity["task_id"]:
            self.err(ev, f"task_id of the event is not the task of the {what} it names")
        elif what == "approval" and ev.get("session_id") != entity["session_id"]:
            self.err(ev, "session_id of the event is not the session of the approval it names")

    def approval_resolved(self, ev, p):
        aid = p["approval_id"]
        a = self.approvals.get(aid)
        if a is None:
            return self.err(ev, "unknown approval")
        self.routed(ev, a, "approval")
        state, actor = p["state"], ev["actor"]["kind"]
        unused_grant = (a["state"] == "approved" and a["source"] == "host_policy" and state == "invalidated"
                        and aid not in self.consumed_approvals)
        if a["state"] != "pending" and not unused_grant:
            return self.err(ev, f"approval already {a['state']}")
        allowed = {"approved": {"user", "policy"}, "denied": {"user", "policy"}, "expired": {"policy", "orchestrator"},
                   "cancelled": {"user", "orchestrator"}, "invalidated": {"recovery", "orchestrator"}}[state]
        if actor not in allowed:
            self.err(ev, f"{state} cannot be decided by {actor}")
        if state == "approved" and actor != "user":
            if a["source"] == "host_policy" and a["kind"] in HUMAN_ONLY_KINDS:
                self.err(ev, f"approval for {a['kind']} can only be granted by the user")
            elif a["source"] == "acp_permission" and a["classified"] in HUMAN_ONLY_CLASSES:
                self.err(ev, f"approval classified {a['classified']} can only be granted by the user")
        if actor == "policy" and state in ("approved", "denied") and not p.get("policy_rule_id"):
            self.err(ev, "policy decisions must name policy_rule_id")
        if state == "invalidated" and actor == "orchestrator" and not unused_grant:
            s = self.sessions.get(a["session_id"]) if a["session_id"] else None
            if s is None or s["state"] in LIVE_SESSION:
                self.err(ev, "the orchestrator only invalidates unused grants or requests whose session is gone")
        if a["state"] == "pending" and a["return_state"] is not None:
            t = self.tasks[a["task_id"]]
            if t["state"] != "awaiting_approval" or t["approval_id"] != aid:
                self.err(ev, "a blocking approval is resolved only while the task is awaiting_approval on it")
        out = p.get("acp_outcome")
        if a["source"] == "acp_permission" and state != "invalidated":
            if out is None:
                self.err(ev, "ACP permission resolution must record what was answered to the agent")
            elif state == "cancelled" and out["outcome"] != "cancelled":
                self.err(ev, "cancelled approvals answer the agent with outcome 'cancelled'")
            elif state in ("approved", "denied", "expired"):
                kind = a["options"].get(out.get("option_id"))
                want = "allow_" if state == "approved" else "reject_"
                if out["outcome"] != "selected" or not kind or not kind.startswith(want):
                    self.err(ev, f"{state} must select an {want}* option")
        elif out is not None:
            self.err(ev, "acp_outcome only applies to live ACP permission requests")
        a["state"] = state

    # -- operations ---------------------------------------------------------------------------
    def operation_recorded(self, ev, p):
        oid = p["operation_id"]
        if oid in self.operations:
            return self.err(ev, "operation already recorded")
        tid = ev["task_id"]
        if ev["actor"]["kind"] != "orchestrator":
            self.err(ev, f"operation.recorded is written by the orchestrator, not {ev['actor']['kind']}")
        st = self.tasks[tid]["state"]
        if st not in OP_STATES[p["kind"]]:
            self.err(ev, f"cannot record {p['kind']} while task is {st}")
        if p["idempotency_key"] != idempotency_key(p["kind"], p["target"]):
            self.err(ev, "idempotency_key is not sha256(canonical {kind, identity}) (identity = target without description)")
        if p["approval_id"] in self.approvals:
            self.err(ev, "each operation needs a fresh approval id")
        sup = p.get("supersedes_operation_id")
        if sup:
            other = self.operations.get(sup)
            if other is None:
                self.err(ev, "supersedes an unknown operation")
            elif other["key"] != p["idempotency_key"] or other["task_id"] != tid:
                self.err(ev, "supersedes_operation_id must name an operation of the same task with the same idempotency_key")
        superseded = {o["sup"] for o in self.operations.values() if o["sup"]}
        for other_id, other in self.operations.items():
            if other["key"] != p["idempotency_key"]:
                continue
            if other_id == sup:
                if (other["state"] in SUPERSEDABLE
                        or (other["state"] == "failed" and other["effect"] == "none")
                        or (other["state"] == "outcome_unknown" and other["rep"] == "idempotent_with_key")):
                    continue
                if other["state"] == "failed":
                    self.err(ev, "superseding a failed attempt with unknown effect requires reconciliation first")
                    continue
            elif other_id in superseded and other["state"] not in ("recorded", "started", "succeeded",
                                                                     "reconciled_applied"):
                continue  # an earlier link of the same supersede chain that is still known not to have taken effect
            self.err(ev, f"same idempotency_key as {other_id} ({other['state']}); non-repeatable work must not be redone")
        self.operations[oid] = {"task_id": tid, "kind": p["kind"], "key": p["idempotency_key"],
                                "rep": p["repeatability"], "approval": p["approval_id"], "sup": sup,
                                "state": "recorded", "effect": None, "seq": ev["seq"], "target": p["target"],
                                "strategy": p["reconcile_strategy"]}

    def operation_started(self, ev, p):
        op = self.operations.get(p["operation_id"])
        if op is None:
            return self.err(ev, "operation must be recorded before it starts")
        self.routed(ev, op, "operation")
        if op["state"] != "recorded":
            return self.err(ev, f"operation is {op['state']}; an operation id executes at most once")
        if ev["actor"]["kind"] == "recovery":
            self.err(ev, "crash recovery never (re)starts an operation")
        elif ev["actor"]["kind"] != "orchestrator":
            self.err(ev, f"operations are started by the orchestrator, not {ev['actor']['kind']}")
        tid = op["task_id"]
        if op["kind"] == "git_push":
            wt = self.checkpoints.get(tid)
            if wt is None or wt["head_sha"] != op["target"]["expected_sha"] or wt["dirty"]:
                self.err(ev, "git_push expected_sha must equal the head_sha of the task's latest clean checkpoint "
                             "(the latest task.checkpoint_recorded must carry a worktree)")
        if op["kind"] == "pr_merge":
            pushes = [o for o in self.operations.values()
                      if o["task_id"] == tid and o["kind"] == "git_push" and o["state"] in DONE_OP]
            head = max(pushes, key=lambda o: o["done_seq"])["target"]["expected_sha"] if pushes else None
            if head != op["target"]["expected_sha"]:
                self.err(ev, f"pr_merge expected_sha must equal the PR head AgentDock last pushed ({head})")
        st = self.tasks[op["task_id"]]["state"]
        if st not in OP_STATES[op["kind"]]:
            self.err(ev, f"operation {op['kind']} cannot start while task is {st}")
        if op["approval"] != p["approval_id"]:
            self.err(ev, "started with a different approval than recorded")
        a = self.approvals.get(p["approval_id"])
        if not a or a["state"] != "approved":
            self.err(ev, "operation started without an approved approval")
        elif a["task_id"] != op["task_id"]:
            self.err(ev, "approval belongs to another task")
        elif a["fingerprint"] != op["key"]:
            self.err(ev, "approval fingerprint does not match the operation idempotency_key")
        elif a["expires_at"] and ev["recorded_at"] >= a["expires_at"]:
            self.err(ev, f"approval expired at {a['expires_at']}; an expired grant authorizes nothing")
        if p["approval_id"] in self.consumed_approvals:
            self.err(ev, "approval already consumed by another execution")
        self.consumed_approvals.add(p["approval_id"])
        op["state"] = "started"

    def operation_finished(self, ev, p, new_state):
        op = self.operations.get(p["operation_id"])
        if op is None or op["state"] != "started":
            return self.err(ev, f"operation must be started to become {new_state}")
        self.routed(ev, op, "operation")
        if new_state in ("succeeded", "failed") and ev["actor"]["kind"] not in RESULT_ACTORS:
            self.err(ev, f"operation.{new_state} is reported by the orchestrator or integration that ran it, "
                         f"not {ev['actor']['kind']}")
        if new_state == "outcome_unknown":
            want = {"host_crash": "recovery", "killed": "orchestrator"}[p["cause"]]
            if ev["actor"]["kind"] != want:
                self.err(ev, f"outcome_unknown with cause {p['cause']} is assigned by {want}")
            if p["cause"] == "killed" and op["kind"] in UNINTERRUPTIBLE_KINDS:
                self.err(ev, f"a started {op['kind']} cannot be killed (ADR-0002 PRL-5); cancel/interrupt waits for "
                             f"its result")
        op["state"] = new_state
        if new_state == "succeeded":
            op["done_seq"] = ev["seq"]
        if new_state == "failed":
            op["effect"] = p["effect"]

    def operation_abandoned(self, ev, p):
        op = self.operations.get(p["operation_id"])
        if op is None or op["state"] != "recorded":
            return self.err(ev, "only recorded (never started) operations can be abandoned")
        self.routed(ev, op, "operation")
        actor, reason = ev["actor"]["kind"], p["reason"]
        if actor not in ("orchestrator", "policy", "user", "recovery"):
            self.err(ev, f"operations are not abandoned by {actor}")
        if (actor == "recovery") != (reason == "host_recovery"):
            self.err(ev, "reason host_recovery goes with the recovery actor")
        a = self.approvals.get(op["approval"])
        astate = a["state"] if a else None
        if reason.startswith("approval_") and astate != reason[len("approval_"):]:
            self.err(ev, f"reason {reason} but the approval is {astate}")
        if astate == "pending" or (astate == "approved" and op["approval"] not in self.consumed_approvals):
            self.err(ev, f"approval {op['approval']} is {astate}; resolve or invalidate it before abandoning")
        op["state"] = "abandoned"

    def operation_reconciled(self, ev, p):
        op = self.operations.get(p["operation_id"])
        if op is None or op["state"] != "outcome_unknown":
            return self.err(ev, "only outcome_unknown operations are reconciled")
        self.routed(ev, op, "operation")
        if ev["actor"]["kind"] not in ("orchestrator", "integration", "user"):
            self.err(ev, "reconciliation is a live read-only probe, not part of recovery")
        if op["strategy"] == "none" and p["finding"] != "undeterminable":
            self.err(ev, "reconcile_strategy 'none' has no probe; the only possible finding is undeterminable")
        op["state"] = "reconciled_" + p["finding"]
        if p["finding"] == "applied":
            op["done_seq"] = ev["seq"]

    # -- checks -------------------------------------------------------------------------------
    def check_started(self, ev, p):
        if p["check_id"] in self.checks:
            return self.err(ev, "check already exists")
        self.checks[p["check_id"]] = {"task_id": ev["task_id"], "origin": p["origin"], "name": p["name"],
                                      "state": "running", "seq": ev["seq"]}

    def check_finished(self, ev, p):
        c = self.checks.get(p["check_id"])
        if c is None or c["state"] != "running":
            return self.err(ev, "check must be running")
        self.routed(ev, c, "check")
        if p["state"] == "outcome_unknown" and ev["actor"]["kind"] != "recovery":
            self.err(ev, "outcome_unknown is assigned by crash recovery")
        elif p["state"] != "outcome_unknown" and ev["actor"]["kind"] not in RESULT_ACTORS:
            self.err(ev, f"check results are reported by the orchestrator or integration, not {ev['actor']['kind']}")
        c["state"] = p["state"]

    # -- usage / summary ------------------------------------------------------------------------
    def usage(self, ev, p):
        u = p["usage"]
        if u["task_id"] != ev["task_id"] or u["session_id"] != ev["session_id"]:
            self.err(ev, "usage ids must match the envelope")

    def summary(self, ev, p):
        if p["through_seq"] >= ev["seq"]:
            self.err(ev, "a summary can only cover events before itself")
        if p["source"] == "agent_generated" and ev["actor"]["kind"] != "adapter":
            self.err(ev, "agent_generated summaries come from the adapter")

    # -- recovery -----------------------------------------------------------------------------
    def recovery_started(self, ev, p):
        if self.recovery is not None:
            self.err(ev, "recovery already in progress")
        if ev["actor"]["kind"] != "recovery":
            self.err(ev, "recovery events need the recovery actor")
        self.recovery = {"tasks": set(), "sessions": set(), "approvals": set(), "ops": set(), "abandoned": set(),
                         "checks": set(), "tombstoned": []}

    def recovery_completed(self, ev, p):
        r = self.recovery
        if r is None:
            return self.err(ev, "recovery_completed without recovery_started")
        if ev["actor"]["kind"] != "recovery":
            self.err(ev, "system.recovery_completed is written by the recovery actor")
        for aid, a in self.approvals.items():
            if a["state"] == "pending":
                self.err(ev, f"approval {aid} still pending after recovery")
            elif a["state"] == "approved" and a["source"] == "host_policy" and aid not in self.consumed_approvals:
                self.err(ev, f"approval {aid} is approved but unused after recovery; a grant never survives a crash")
        for oid, op in self.operations.items():
            if op["state"] in ("started", "recorded"):
                self.err(ev, f"operation {oid} still {op['state']} after recovery")
        for cid, c in self.checks.items():
            if c["state"] == "running":
                self.err(ev, f"check {cid} still running after recovery")
        for sid, s in self.sessions.items():
            if s["state"] in LIVE_SESSION:
                self.err(ev, f"session {sid} still {s['state']} after recovery (processes do not survive a host crash)")
        for tid, t in self.tasks.items():
            if t["state"] in IN_FLIGHT_TASK:
                self.err(ev, f"task {tid} still {t['state']} after recovery")
        # Recovery events of a task deleted later are tombstones: their type and routing ids survive, payload ids
        # do not. Task and session ids are checked exactly; approval/operation/check ids by count.
        dead = r["tombstoned"]
        r["tasks"] |= {e["task_id"] for e in dead if e["type"] == "task.state_changed"}
        r["sessions"] |= {e["session_id"] for e in dead if e["type"] == "session.state_changed"}
        hidden = {"approvals_invalidated": sum(e["type"] == "approval.resolved" for e in dead),
                  "operations_marked_unknown": sum(e["type"] == "operation.outcome_unknown" for e in dead),
                  "operations_abandoned": sum(e["type"] == "operation.abandoned" for e in dead),
                  "checks_marked_unknown": sum(e["type"] == "check.finished" for e in dead)}
        expect = {"tasks_interrupted": r["tasks"], "sessions_disconnected": r["sessions"],
                  "approvals_invalidated": r["approvals"], "operations_marked_unknown": r["ops"],
                  "operations_abandoned": r["abandoned"], "checks_marked_unknown": r["checks"]}
        for key, actual in expect.items():
            listed = set(p[key])
            if not actual <= listed or len(listed - actual) != hidden.get(key, 0):
                self.err(ev, f"{key} lists {sorted(p[key])}, recovery changed {sorted(actual)}"
                             + (f" plus {hidden[key]} id(s) of a deleted task" if hidden.get(key) else ""))
            elif listed - actual:
                # Stand-ins for ids of a deleted task: checked at the end of the stream, when every live id is known.
                self.deleted_id_claims.append((ev, key, listed - actual))
        self.recovery = None

    def finish(self):
        """End-of-stream invariants."""
        if self.recovery is not None:
            self.errors.append(f"{self.name}: recovery never completed")
        for oid, op in self.operations.items():
            a = self.approvals.get(op["approval"])
            if op["state"] == "recorded" and a and a["state"] in ("denied", "expired", "cancelled", "invalidated"):
                self.errors.append(f"{self.name}: operation {oid} is still recorded although its approval was {a['state']}")
        for tid in self.tombstoned:
            if tid not in self.deleted:
                self.errors.append(f"{self.name}: tombstoned events of {tid} without task.deleted")
        for sid in sorted(self.must_unarchive):
            self.errors.append(f"{self.name}: archived session {sid} is waiting for the user but was never unarchived")
        live = {"approvals_invalidated": self.approvals, "operations_marked_unknown": self.operations,
                "operations_abandoned": self.operations, "checks_marked_unknown": self.checks}
        for ev, key, ids in self.deleted_id_claims:
            for x in sorted(ids & set(live[key])):
                self.err(ev, f"{key} lists {x} as an id of a deleted task, but it belongs to a live entity")

    # -- dispatcher -----------------------------------------------------------------------------
    def apply(self, ev):
        self.envelope(ev)
        # Checked before anything is skipped: no event at all, tombstoned or not, may sit between the event that
        # made an archived session wait and its system unarchive.
        if self.must_unarchive and not (ev["type"] == "session.unarchived" and "tombstone" not in ev
                                        and ev["payload"].get("by") == "system"
                                        and ev.get("session_id") in self.must_unarchive):
            for sid in sorted(self.must_unarchive):
                self.err(ev, f"archived session {sid} is waiting for the user; session.unarchived{{by: system}} "
                             f"must be written in the same transaction")
            self.must_unarchive = set()
        if "tombstone" in ev or (ev.get("task_id") in self.deleted and ev["type"] != "task.deleted"):
            return
        # Unknown task/session ids were already reported by envelope(); do not replay against missing state.
        if "task_id" in ev and ev["type"] not in ("task.created", "task.deleted") and ev["task_id"] not in self.tasks:
            return
        if "session_id" in ev and ev["type"] != "session.created" and ev["session_id"] not in self.sessions:
            return
        p, t = ev["payload"], ev["type"]
        handler = {
            "task.created": self.task_created, "task.state_changed": self.task_state_changed,
            "task.outcome_acknowledged": self.task_ack, "task.policy_updated": self.task_policy_updated,
            "task.deleted": self.task_deleted, "task.checkpoint_recorded": self.checkpoint,
            "session.created": self.session_created, "session.capabilities_detected": self.session_caps,
            "session.state_changed": self.session_state_changed, "session.prompt_submitted": self.prompt,
            "session.output_limited": self.output_limited,
            "session.result_acknowledged": self.session_ack, "session.archived": self.session_archived,
            "session.unarchived": self.session_unarchived, "session.summary_recorded": self.summary,
            "approval.requested": self.approval_requested, "approval.resolved": self.approval_resolved,
            "operation.recorded": self.operation_recorded, "operation.started": self.operation_started,
            "operation.succeeded": lambda e, q: self.operation_finished(e, q, "succeeded"),
            "operation.failed": lambda e, q: self.operation_finished(e, q, "failed"),
            "operation.outcome_unknown": lambda e, q: self.operation_finished(e, q, "outcome_unknown"),
            "operation.reconciled": self.operation_reconciled, "operation.abandoned": self.operation_abandoned,
            "check.started": self.check_started, "check.finished": self.check_finished,
            "usage.reported": self.usage,
            "system.recovery_started": self.recovery_started, "system.recovery_completed": self.recovery_completed,
        }.get(t)
        if handler:
            handler(ev, p)
        if self.recovery is not None and t != "system.recovery_started":
            self._note_recovery(ev, p)
        if any(s["archived"] for s in self.sessions.values()):
            waiting = self._waiting_sessions()
            self.must_unarchive |= {sid for sid, s in self.sessions.items() if s["archived"] and sid in waiting}

    def _note_recovery(self, ev, p):
        r, t = self.recovery, ev["type"]
        if t == "task.state_changed" and p["to"] == "interrupted":
            r["tasks"].add(ev["task_id"])
        elif t == "session.state_changed" and p["to"] == "disconnected":
            r["sessions"].add(ev["session_id"])
        elif t == "approval.resolved" and p["state"] == "invalidated":
            r["approvals"].add(p["approval_id"])
        elif t == "operation.outcome_unknown":
            r["ops"].add(p["operation_id"])
        elif t == "operation.abandoned":
            r["abandoned"].add(p["operation_id"])
        elif t == "check.finished" and p["state"] == "outcome_unknown":
            r["checks"].add(p["check_id"])

    # -- derived attention (docs/contracts/attention.md) ---------------------------------------
    def attention(self, filter_archived=True):
        items = set()
        pending_tasks = {a["task_id"] for a in self.approvals.values() if a["state"] == "pending"}
        for tid, t in self.tasks.items():
            st = t["state"]
            unviewed = t["ack_seq"] < t["entered_seq"]
            sessions = [s for s in self.sessions.values() if s["task_id"] == tid]
            if st == "queued":
                items.add(("background", "queued", tid, None, None))
            elif st == "preparing":
                items.add(("background", "workflow_step", tid, None, None))
            elif st in ("verifying", "review", "pr", "ci"):
                progressing = (any(s["state"] in ("starting", "active") for s in sessions)
                               or any(c["task_id"] == tid and c["state"] == "running" for c in self.checks.values())
                               or any(o["task_id"] == tid and o["state"] == "started" for o in self.operations.values()))
                if progressing:
                    items.add(("background", "workflow_step", tid, None, None))
                elif tid not in pending_tasks:
                    items.add(("needs_reply", "phase_decision_pending", tid, None, None))
            elif st == "running":
                if not any(s["role"] in REPLY_ROLES and s["state"] in LIVE_SESSION for s in sessions):
                    items.add(("needs_reply", "session_unavailable", tid, None, None))
                elif any(s["role"] in REPLY_ROLES and (s["state"] in ("starting", "suspended") or (
                        s["state"] == "idle" and s["last_stop"] in (None, "cancelled"))) for s in sessions):
                    # A live agent that is neither working nor asking: starting, suspended, no turn yet, or its last
                    # turn was cancelled by the user. The task is still `running` (UX rule 5: running in background).
                    items.add(("background", "workflow_step", tid, None, None))
            elif st == "interrupted":
                intr = t["interruption"] or {}
                if intr.get("reason") == "user_paused":
                    items.add(("background", "paused", tid, None, None))
                elif intr.get("auto_resume_armed"):
                    items.add(("background", "waiting_for_reset", tid, None, None))
                elif unviewed:
                    items.add(("needs_review", "interruption_needs_decision", tid, None, None))
            elif st == "failed" and unviewed:
                items.add(("needs_review", "failure_needs_decision", tid, None, None))
            elif st in ("completed", "cancelled") and unviewed:
                items.add(("needs_review", "task_outcome_unviewed", tid, None, None))
        for aid, a in self.approvals.items():
            if a["state"] == "pending":
                items.add(("needs_reply", "approval_pending", a["task_id"], a["session_id"], aid))
        for oid, op in self.operations.items():
            if op["state"] == "outcome_unknown":
                items.add(("needs_reply", "reconcile_needed", op["task_id"], None, oid))
        for sid, s in self.sessions.items():
            task_state = self.tasks[s["task_id"]]["state"]
            if s["state"] == "active":
                items.add(("background", "agent_working", s["task_id"], sid, None))
            if s["state"] == "idle" and task_state in IN_FLIGHT_TASK:
                if s["last_stop"] == "output_limited":
                    items.add(("needs_reply", "output_limited", s["task_id"], sid, None))
                elif s["last_stop"] in ATTENTION_STOPS or (
                        s["last_stop"] == "end_turn" and task_state == "running" and s["role"] in REPLY_ROLES):
                    items.add(("needs_reply", "agent_turn_ended", s["task_id"], sid, None))
            if (s["parent"] and s["state"] in ("closed", "failed") and s["outcome"] in REVIEW_SESSION_OUTCOMES
                    and s["ack_seq"] <= s["closed_seq"]):
                items.add(("needs_review", "child_result_unviewed", s["task_id"], sid, None))
        if not filter_archived:
            return items
        # UX rule 2: archived -> not listed. needs_reply is never hidden (rule 1 wins; the session is unarchived).
        def hidden(item):
            kind, _reason, tid, sid, _ref = item
            if kind == "needs_reply":
                return False
            if sid:
                return bool(self.sessions[sid]["archived"])
            mains = [s for s in self.sessions.values() if s["task_id"] == tid and s["parent"] is None]
            return bool(mains) and all(s["archived"] for s in mains)
        return {i for i in items if not hidden(i)}


def item_key(item):
    return (item["kind"], item["reason"], item["task_id"], item.get("session_id"), item.get("ref_id"))


def scan_forbidden_keys(node, where, errors):
    if isinstance(node, dict):
        for k, v in node.items():
            if FORBIDDEN_NAME.search(k):
                errors.append(f"{where}: key '{k}' implies a known quota balance")
            scan_forbidden_keys(v, where, errors)
    elif isinstance(node, list):
        for v in node:
            scan_forbidden_keys(v, where, errors)


def main():
    errors = []
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    transitions = json.loads(TRANSITIONS_PATH.read_text(encoding="utf-8"))
    errors += check_keywords(schema)
    names = set()
    collect_property_names(schema, names)
    errors += [f"schema: property '{n}' implies a known quota balance" for n in sorted(names) if FORBIDDEN_NAME.search(n)]
    v = Validator(schema)
    defs = schema["$defs"]

    samples_path = FIXTURES_DIR / "models.sample.json"
    samples = json.loads(samples_path.read_text(encoding="utf-8"))
    errors += [f"models.sample.json {e}" for e in v.errors(samples, defs["ModelSamples"])]
    scan_forbidden_keys(samples, "models.sample.json", errors)
    for s in samples.get("sessions", []):
        if "capability_snapshot" in s:
            errors += [f"models.sample.json {s['session_id']}: {e}" for e in feature_errors(s["capability_snapshot"])]
    for o in samples.get("operations", []):
        if o["idempotency_key"] != idempotency_key(o["kind"], o["target"]):
            errors.append(f"models.sample.json {o['operation_id']}: idempotency_key is not sha256(canonical {{kind, identity}})")

    covered = set()
    fixtures = sorted(FIXTURES_DIR.glob("*.jsonl"))
    if not fixtures:
        errors.append("no fixtures found")
    total_events = 0
    loaded = {}
    for path in fixtures:
        events, load_errors = load_jsonl(path)
        errors += load_errors
        loaded[path.name] = events
        run_errors, replay = run_stream(path.name, events, transitions, v, defs)
        errors += run_errors
        total_events += len(events)
        covered |= replay.covered
        pre_path = PREDELETE_DIR / path.name
        if any(e.get("type") == "task.deleted" for e in events):
            if not pre_path.exists():
                errors.append(f"{path.name}: deletes a task but predelete/{path.name} is missing")
            else:
                pre, load_errors = load_jsonl(pre_path)
                errors += load_errors
                loaded["predelete/" + path.name] = pre
                errors += check_predelete(path.name, events, pre, transitions, v, defs)

        exp_path = path.with_name(path.stem + ".expected.json")
        if not exp_path.exists():
            errors.append(f"{path.name}: missing {exp_path.name}")
            continue
        exp = json.loads(exp_path.read_text(encoding="utf-8"))
        errors += [f"{exp_path.name} {e}" for e in v.errors(exp, defs["FixtureExpectation"])]
        if exp.get("fixture") != path.name:
            errors.append(f"{exp_path.name}: 'fixture' must be {path.name}")
        tasks = {k: t["state"] for k, t in replay.tasks.items()}
        sessions = {k: s["state"] for k, s in replay.sessions.items()}
        if tasks != exp["final_task_states"]:
            errors.append(f"{path.name}: final task states {tasks} != expected {exp['final_task_states']}")
        if sessions != exp["final_session_states"]:
            errors.append(f"{path.name}: final session states {sessions} != expected {exp['final_session_states']}")
        derived = replay.attention()
        expected = {item_key(i) for i in exp["attention"]}
        if derived != expected:
            errors.append(f"{path.name}: attention mismatch\n    derived only: {sorted(derived - expected, key=str)}\n"
                          f"    expected only: {sorted(expected - derived, key=str)}")

    all_ids = {t["id"] for t in transitions["task"]["transitions"]} | {t["id"] for t in transitions["session"]["transitions"]}
    missing = sorted(all_ids - covered)
    if missing:
        errors.append(f"transitions never exercised by any fixture: {', '.join(missing)}")

    errors += check_enforcement_docs()
    errors += check_state_machine_doc(transitions)
    mutations_run = 0
    if not errors:
        mutation_errors, mutations_run = self_test(loaded, transitions, v, defs)
        errors += mutation_errors

    if errors:
        print(f"FAIL: {len(errors)} problem(s)")
        for e in errors:
            print("  -", e)
        return 1
    print(f"OK: {len(fixtures)} fixtures, {total_events} events, {len(covered)}/{len(all_ids)} transitions covered, "
          f"schema keyword subset respected, models.sample.json valid, {mutations_run} negative mutations rejected, "
          f"Enforcement boundary table consistent, state-machines.md mirrors transitions.json")
    return 0


def load_jsonl(path):
    """One JSON value per '\\n'-terminated line. str.splitlines() is not used: it also splits on U+2028/U+2029,
    which json.dumps(ensure_ascii=False) leaves unescaped inside strings."""
    events, errors = [], []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").split("\n"), 1):
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError as exc:
            errors.append(f"{path.name}:{lineno}: invalid JSON: {exc}")
    return events, errors


def check_predelete(name, events, pre, transitions, v, defs):
    """Deletion preconditions. A tombstoned stream cannot show the deleted task's state, so the generator also
    writes fixtures/predelete/<name>: the stream exactly as it was before task.deleted. It must be a valid stream,
    a prefix of the final stream (identical except that events of the deleted task are now tombstones), and the
    deleted task must be ended with nothing open."""
    errors, replay = run_stream("predelete/" + name, pre, transitions, v, defs)
    n = len(pre)
    deletions = sum(e.get("type") == "task.deleted" for e in events)
    if deletions != 1:
        errors.append(f"{name}: {deletions} task.deleted events; a stream with a pre-deletion copy deletes exactly one "
                      f"task (the copy can only show the state before the first deletion)")
    if n >= len(events) or events[n]["type"] != "task.deleted":
        return errors + [f"predelete/{name}: must end right before a task.deleted of {name}"]
    deleted = events[n]
    tid = deleted["task_id"]
    for a, b in zip(pre, events[:n]):
        keep = ("id", "seq", "type", "task_id", "session_id", "actor", "authority_id", "recorded_at")
        same = all(a.get(k) == b.get(k) for k in keep)
        if "tombstone" in b:
            same = same and a.get("task_id") == tid
        else:
            same = same and a == b
        if not same:
            errors.append(f"predelete/{name} seq={a.get('seq')}: differs from {name} beyond tombstoning")
            break
    prefix = f"{name} seq={deleted['seq']} task.deleted precondition:"
    t = replay.tasks.get(tid)
    if t is None:
        return errors + [f"{prefix} task {tid} does not exist before deletion"]
    if t["state"] not in ENDED_TASK or t["state"] != deleted["payload"].get("final_state"):
        errors.append(f"{prefix} task is {t['state']}; only an ended task (final_state) can be deleted")
    for oid, op in replay.operations.items():
        if op["task_id"] == tid and op["state"] in ("recorded", "started", "outcome_unknown"):
            errors.append(f"{prefix} operation {oid} is {op['state']}")
    for aid, a in replay.approvals.items():
        if a["task_id"] == tid and (a["state"] == "pending" or (a["state"] == "approved" and a["source"] == "host_policy"
                                                                 and aid not in replay.consumed_approvals)):
            errors.append(f"{prefix} approval {aid} is {a['state']} and unused")
    for sid, s in replay.sessions.items():
        if s["task_id"] == tid and s["state"] in LIVE_SESSION:
            errors.append(f"{prefix} session {sid} is still {s['state']}")
    return errors


def run_stream(name, events, transitions, v, defs):
    """Schema-check and replay one event stream. Returns (errors, replay)."""
    errors = []
    replay = Replay(name, transitions)
    valid = []
    for i, ev in enumerate(events, 1):
        schema_errors = v.errors(ev, defs["EventEnvelope"])
        if schema_errors:
            errors += [f"{name}:{i}: {e}" for e in schema_errors]
            continue
        scan_forbidden_keys(ev, f"{name}:{i}", errors)
        valid.append(ev)
    for ev in valid:
        replay.apply(ev)
    replay.finish()
    return errors + replay.errors, replay


# --------------------------------------------------------------------------------------------
# Negative self-test: each mutation breaks one rule and must be rejected with a matching message.
# --------------------------------------------------------------------------------------------
def _find(events, etype, pred=lambda e: True, nth=0):
    hits = [i for i, e in enumerate(events) if e["type"] == etype and "tombstone" not in e and pred(e)]
    return hits[nth]


def _renumber(events):
    for i, e in enumerate(events, 1):
        e["seq"] = i
    return events


def _m_gap(ev):
    del ev[5]
    return ev


def _m_illegal_transition(ev):
    i = _find(ev, "task.state_changed")
    ev[i]["payload"]["to"] = "running"
    return ev


def _m_rerun_push_after_crash(ev):
    i = _find(ev, "operation.reconciled")
    op = ev[i]["payload"]["operation_id"]
    started = next(e for e in ev if e["type"] == "operation.started" and e["payload"]["operation_id"] == op)
    clone = json.loads(json.dumps(started))
    clone["id"] = "evt_ZZZZZZZZZZZZZZZZZZZZZZZZZZ"
    clone["occurred_at"] = clone["recorded_at"] = ev[i]["recorded_at"]
    ev.insert(i + 1, clone)
    return _renumber(ev)


def _m_recovery_starts_op(ev):
    i = _find(ev, "operation.started")
    ev[i]["actor"] = {"kind": "recovery"}
    ev[i]["provenance"] = "recovery"
    return ev


def _m_recovery_approves(ev):
    i = _find(ev, "approval.resolved", lambda e: e["payload"]["state"] == "invalidated")
    ev[i]["payload"]["state"] = "approved"
    return ev


def _m_keep_pending_after_crash(ev):
    # Drop both the invalidation and the interruption (which would otherwise hit T20's own pending check first).
    i = _find(ev, "approval.resolved", lambda e: e["payload"]["state"] == "invalidated")
    aid = ev[i]["payload"]["approval_id"]
    del ev[i]
    del ev[_find(ev, "task.state_changed", lambda e: e["payload"]["to"] == "interrupted"
                 and e["payload"].get("approval_id") == aid)]
    return _renumber(ev)


def _m_early_auto_resume(ev):
    i = _find(ev, "task.state_changed", lambda e: e["payload"]["trigger"] == "scheduled_resume")
    ev[i]["occurred_at"] = ev[i]["recorded_at"] = ev[i - 1]["recorded_at"]
    return ev


def _m_auto_resume_after_crash(ev):
    i = _find(ev, "task.state_changed", lambda e: e["payload"]["trigger"] == "resume_requested")
    ev[i]["actor"] = {"kind": "orchestrator"}
    ev[i]["payload"]["trigger"] = "scheduled_resume"
    return ev


def _m_archive_primary(ev):
    i = _find(ev, "session.archived")
    primary = next(e["session_id"] for e in ev if e["type"] == "session.created" and e["payload"]["role"] == "primary")
    ev[i]["session_id"] = primary
    return ev


def _m_archive_before_open(ev):
    i = _find(ev, "session.archived")
    j = _find(ev, "session.result_acknowledged")
    ev[i], ev[j] = ev[j], ev[i]
    return _renumber(ev)


def _m_quota_field_schema(ev):
    i = _find(ev, "usage.reported")
    ev[i]["payload"]["usage"]["quota_remaining"] = 0.3
    return ev


def _m_opaque_quota_key(ev):
    # acp_agent_capabilities is opaque to the schema, so only the forbidden-name scan can catch this.
    i = _find(ev, "session.capabilities_detected")
    ev[i]["payload"]["snapshot"]["acp_agent_capabilities"]["remainingQuota"] = 5
    return ev


def _m_unknown_usage_with_numbers(ev):
    i = _find(ev, "usage.reported", lambda e: e["payload"]["usage"]["source"] == "unknown")
    ev[i]["payload"]["usage"]["tokens"] = {"input": 10}
    return ev


def _m_load_without_capability(ev):
    i = _find(ev, "session.state_changed", lambda e: e["payload"]["trigger"] == "reattach_attempt")
    ev[i]["payload"]["launch_method"] = "load"
    return ev


def _m_replay_outside_load(ev):
    i = _find(ev, "session.message_delta")
    ev[i]["provenance"] = "acp_replay"
    return ev


def _m_act_before_approval_persisted(ev):
    i = _find(ev, "approval.resolved", lambda e: e["payload"]["state"] == "approved")
    ev.insert(i + 2, ev.pop(i))  # move the resolution after the session/task transitions it authorizes
    return _renumber(ev)


def _m_verify_with_failed_check(ev):
    i = _find(ev, "check.finished")
    ev[i]["payload"]["state"] = "failed"
    return ev


def _m_raw_io_inline(ev):
    i = _find(ev, "session.tool_call")
    ev[i]["payload"]["rawInput"] = {"cmd": "echo $TOKEN"}
    return ev


def _m_acp_fingerprint(ev):
    i = _find(ev, "approval.requested", lambda e: e["payload"]["source"] == "acp_permission")
    ev[i]["payload"]["operation_fingerprint"] = "0" * 64
    return ev


# -- operations / approvals (review round 1: B1-B4, E1-E14) ------------------------------------
def _new_event(ev, ref, etype, actor, payload, n):
    e = {k: v for k, v in ev[ref].items() if k in ("schema_version", "authority_id", "occurred_at", "recorded_at",
                                                    "project_id", "task_id", "redaction")}
    e.update({"id": f"evt_ZZZZZZZZZZZZZZZZZZZZZZZZ{n:02d}", "seq": 0, "type": etype, "actor": actor,
              "provenance": "recovery" if actor["kind"] == "recovery" else "live", "payload": payload})
    return e


def _drop(ev, pred):
    return _renumber([e for e in ev if not pred(e)])


def _next(ev, etype, start):
    return next(k for k in range(start, len(ev)) if ev[k]["type"] == etype)


def _m_e1_recovery_keeps_recorded_op(ev):
    i = _find(ev, "operation.abandoned", lambda e: e["payload"]["reason"] == "host_recovery")
    del ev[i]
    ev[_next(ev, "system.recovery_completed", i)]["payload"]["operations_abandoned"] = []
    return _renumber(ev)


def _m_e1_recovery_keeps_unused_grant(ev):
    i = _find(ev, "approval.resolved", lambda e: e["actor"]["kind"] == "recovery")
    del ev[i]
    ev[_next(ev, "system.recovery_completed", i)]["payload"]["approvals_invalidated"] = []
    return _renumber(ev)


def _m_e1_start_after_crash(ev):
    i = _find(ev, "operation.abandoned", lambda e: e["payload"]["reason"] == "host_recovery")
    oid = ev[i]["payload"]["operation_id"]
    aid = next(e["payload"]["approval_id"] for e in ev if e["type"] == "operation.recorded"
               and e["payload"]["operation_id"] == oid)
    ev = [e for e in ev if not (e["actor"]["kind"] == "recovery" and e["type"] in ("operation.abandoned", "approval.resolved"))]
    j = _find(ev, "system.recovery_completed", nth=-1)
    ev[j]["payload"]["operations_abandoned"] = ev[j]["payload"]["approvals_invalidated"] = []
    ev.insert(j + 1, _new_event(ev, j - 1, "operation.started", {"kind": "orchestrator"},
                                {"operation_id": oid, "approval_id": aid}, 1))
    return _renumber(ev)


def _m_e2a_denied_op_left_recorded(ev):
    return _drop(ev, lambda e: e["type"] == "operation.abandoned" and e["payload"]["reason"] == "approval_denied")


def _m_e2b_supersede_recorded_op(ev):
    i = _find(ev, "operation.recorded")
    clone = json.loads(json.dumps(ev[i]))
    clone["id"] = "evt_ZZZZZZZZZZZZZZZZZZZZZZZZ01"
    clone["payload"].update(operation_id="op_ZZZZZZZZZZZZZZZZZZZZZZZZ01", approval_id="apr_ZZZZZZZZZZZZZZZZZZZZZZZZ01",
                            supersedes_operation_id=ev[i]["payload"]["operation_id"])
    ev.insert(i + 1, clone)
    return _renumber(ev)


def _m_e4_cancel_with_started_op(ev):
    return _drop(ev, lambda e: e["type"] == "operation.outcome_unknown" and e["payload"]["cause"] == "killed")


def _m_e5_review_approval_blocks(ev):
    i = _find(ev, "approval.requested", lambda e: e["payload"]["source"] == "acp_permission"
              and "return_state" not in e["payload"])
    ev[i]["payload"]["return_state"] = "running"
    return ev


def _m_e6_integration_completes_without_merge(ev):
    i = _find(ev, "operation.recorded", lambda e: e["payload"]["kind"] == "pr_merge")
    oid, aid = ev[i]["payload"]["operation_id"], ev[i]["payload"]["approval_id"]
    return _drop(ev, lambda e: e["payload"].get("operation_id") == oid or e["payload"].get("approval_id") == aid)


def _m_e7_trailing_newline_id(ev):
    tid = ev[0]["task_id"]
    for e in ev:
        if e.get("task_id") == tid:
            e["task_id"] = tid + "\n"
    return ev


def _m_e7_impossible_date(ev):
    ev[0]["occurred_at"] = "2026-02-30T00:00:00.000Z"
    return ev


def _m_e8a_key_not_canonical(ev):
    i = _find(ev, "operation.recorded")
    ev[i]["payload"]["idempotency_key"] = "f" * 64
    ev[_find(ev, "approval.requested", lambda e: e["payload"].get("operation_id") == ev[i]["payload"]["operation_id"])][
        "payload"]["operation_fingerprint"] = "f" * 64
    return ev


def _m_e8b_push_claims_idempotent(ev):
    ev[_find(ev, "operation.recorded")]["payload"]["repeatability"] = "idempotent_with_key"
    return ev


def _m_e8b_push_without_approval_id(ev):
    ev[_find(ev, "operation.recorded")]["payload"].pop("approval_id")
    return ev


def _m_e9_push_during_review(ev):
    j = len(ev) - 1
    task = ev[j]["task_id"]  # fixture 10 ends with task E entering review
    target = {"description": "push from review", "remote": "origin", "ref": "refs/heads/agentdock/e",
              "expected_sha": "1" * 40}
    ev.append(_new_event(ev, j, "operation.recorded", {"kind": "orchestrator"}, {
        "operation_id": "op_ZZZZZZZZZZZZZZZZZZZZZZZZ01", "kind": "git_push", "repeatability": "non_repeatable",
        "idempotency_key": idempotency_key("git_push", target), "target": target,
        "approval_id": "apr_ZZZZZZZZZZZZZZZZZZZZZZZZ01", "reconcile_strategy": "remote_ref_compare"}, 1))
    ev[-1]["task_id"] = task
    return _renumber(ev)


def _m_e12_features_mismatch(ev):
    for e in ev:
        if e["type"] == "session.capabilities_detected":
            e["payload"]["snapshot"]["acp_agent_capabilities"]["sessionCapabilities"].pop("resume", None)
    return ev


def _m_e13_policy_approves_merge(ev):
    i = _find(ev, "operation.recorded", lambda e: e["payload"]["kind"] == "pr_merge")
    aid = ev[i]["payload"]["approval_id"]
    j = _find(ev, "approval.resolved", lambda e: e["payload"]["approval_id"] == aid)
    ev[j]["actor"] = {"kind": "policy", "id": "auto-merge-rule"}
    ev[j]["payload"]["policy_rule_id"] = "auto_merge_when_green"
    ev[j + 1]["actor"] = {"kind": "policy", "id": "auto-merge-rule"}
    return ev


def _m_e14_resume_beyond_phase(ev):
    i = _find(ev, "task.state_changed", lambda e: e["payload"]["trigger"] == "resume_requested")
    ev[i]["payload"]["resume_phase"] = "ci"
    return ev


def _m_wrong_interruption_phase(ev):
    i = _find(ev, "task.state_changed", lambda e: e["payload"]["to"] == "interrupted")
    ev[i]["payload"]["interruption"]["phase"] = "pr"
    return ev


def _m_abandon_while_approval_pending(ev):
    i = _find(ev, "operation.abandoned", lambda e: e["payload"]["reason"] == "approval_denied")
    ev[i - 1], ev[i] = ev[i], ev[i - 1]
    return _renumber(ev)


def _m_tombstone_count(ev):
    ev[_find(ev, "task.deleted")]["payload"]["events_tombstoned"] += 1
    return ev


def _m_event_after_delete(ev):
    i = _find(ev, "task.deleted")
    clone = json.loads(json.dumps(ev[i]))
    clone["id"] = "evt_ZZZZZZZZZZZZZZZZZZZZZZZZ01"
    ev.append(clone)
    return _renumber(ev)


# -- review round 2 (B1-B5, N1-N7): the reviewer's reproductions as formal mutations ------------------
def _clone(e, n, at=None):
    c = json.loads(json.dumps(e))
    c["id"] = f"evt_ZZZZZZZZZZZZZZZZZZZZZZZZ{n:02d}"
    if at:
        c["occurred_at"] = c["recorded_at"] = at
    return c


def _op_event(ev, oid, etype):
    return _find(ev, etype, lambda e: e["payload"].get("operation_id") == oid)


def _insert_same_identity(ev, kind, after, supersede):
    """A new operation of `kind` whose target differs from the first one only in its description."""
    i = _find(ev, "operation.recorded", lambda e: e["payload"]["kind"] == kind)
    rec = _clone(ev[i], 1, ev[after]["recorded_at"])
    p = rec["payload"]
    old = p["operation_id"]
    p.update(operation_id="op_ZZZZZZZZZZZZZZZZZZZZZZZZ01", approval_id="apr_ZZZZZZZZZZZZZZZZZZZZZZZZ01")
    p["target"]["description"] += " (re-requested with new wording)"
    p["idempotency_key"] = idempotency_key(kind, p["target"])
    if supersede:
        p["supersedes_operation_id"] = old
    ev.insert(after + 1, rec)
    return _renumber(ev)


def _m_b1a_duplicate_pr_create_new_description(ev):
    oid = ev[_find(ev, "operation.recorded", lambda e: e["payload"]["kind"] == "pr_create")]["payload"]["operation_id"]
    return _insert_same_identity(ev, "pr_create", _op_event(ev, oid, "operation.succeeded"), supersede=False)


def _m_b1b_repush_after_applied_new_description(ev):
    after = _find(ev, "task.state_changed", lambda e: e["payload"]["trigger"] == "resume_phase_restored")
    return _insert_same_identity(ev, "git_push", after, supersede=True)


def _m_b1c_push_target_without_identity(ev):
    i = _find(ev, "operation.recorded", lambda e: e["payload"]["kind"] == "git_push")
    p = ev[i]["payload"]
    p["target"] = {"description": p["target"]["description"]}
    p["idempotency_key"] = idempotency_key("git_push", p["target"])
    ev[i + 1]["payload"]["operation_fingerprint"] = p["idempotency_key"]
    return ev


def _m_b2_retry_without_reconcile(ev):
    j = _find(ev, "system.recovery_completed")
    ev = ev[:j + 1]
    base = j - 1
    ev.append(_new_event(ev, base, "task.state_changed", {"kind": "user", "id": "local-user"},
                         {"from": "interrupted", "to": "failed", "trigger": "abandoned",
                          "failure": {"code": "abandoned_by_user"}}, 1))
    ev.append(_new_event(ev, base, "task.state_changed", {"kind": "user", "id": "local-user"},
                         {"from": "failed", "to": "queued", "trigger": "retry_requested"}, 2))
    for e in ev[-2:]:
        e["occurred_at"] = e["recorded_at"] = ev[j]["recorded_at"]
    return _renumber(ev)


def _m_b3a_policy_approves_acp_merge(ev):
    i = _find(ev, "approval.requested", lambda e: e["payload"]["source"] == "acp_permission")
    ev[i]["payload"]["classified_kind"] = "pr_merge"
    aid = ev[i]["payload"]["approval_id"]
    j = _find(ev, "approval.resolved", lambda e: e["payload"]["approval_id"] == aid)
    for k in (j, j + 1, j + 2):  # approval.resolved, S14, T17
        ev[k]["actor"] = {"kind": "policy", "id": "auto-approve"}
    ev[j]["payload"]["policy_rule_id"] = "allow_all_tools"
    return ev


def _m_b3b_acp_claims_operation_kind(ev):
    i = _find(ev, "approval.requested", lambda e: e["payload"]["source"] == "acp_permission")
    ev[i]["payload"]["operation_kind"] = "destructive_command"
    return ev


def _m_b4a_auto_archive_failed_child(ev):
    sid = ev[_find(ev, "session.archived")]["session_id"]
    i = _find(ev, "session.state_changed", lambda e: e["session_id"] == sid and e["payload"]["to"] == "closed")
    ev[i]["payload"]["outcome"] = "failed"
    return ev


def _append_auto_archive(ev, sid, opened):
    j = len(ev) - 1
    task = next(e["task_id"] for e in ev if e.get("session_id") == sid)
    if opened:
        ack = _new_event(ev, j, "session.result_acknowledged", {"kind": "user", "id": "local-user"}, {"method": "opened"}, 1)
        ack.update(task_id=task, session_id=sid)
        ev.append(ack)
    arc = _new_event(ev, j, "session.archived", {"kind": "orchestrator"}, {"by": "auto"}, 2)
    arc.update(task_id=task, session_id=sid)
    ev.append(arc)
    return _renumber(ev)


def _m_b4b_auto_archive_protocol_error_child(ev):
    sid = next(e["session_id"] for e in ev if e["type"] == "session.state_changed" and e.get("session_id")
               and e["payload"].get("to") == "failed" and e["payload"].get("trigger") == "protocol_error"
               and any(c["type"] == "session.created" and c["session_id"] == e["session_id"]
                       and c["payload"].get("parent_session_id") for c in ev))
    return _append_auto_archive(ev, sid, opened=True)


def _m_b4c_auto_archive_after_restore(ev):
    sid = ev[_find(ev, "session.unarchived", lambda e: e["payload"]["by"] == "user")]["session_id"]
    return _append_auto_archive(ev, sid, opened=False)


def _m_b4d_archive_after_mark_reviewed_only(ev):
    ev[_find(ev, "session.result_acknowledged")]["payload"]["method"] = "marked_reviewed"
    return ev


def _m_b4e_waiting_session_left_archived(ev):
    return _drop(ev, lambda e: e["type"] == "session.unarchived" and e["payload"]["by"] == "system")


def _m_b4f_bulk_mark_failed_task(ev):
    i = _find(ev, "task.outcome_acknowledged", lambda e: e["payload"]["acknowledged_state"] == "failed")
    ev[i]["payload"]["method"] = "bulk_marked_reviewed"
    return ev


def _m_b5_kill_started_merge(ev):
    oid = ev[_find(ev, "operation.recorded", lambda e: e["payload"]["kind"] == "pr_merge")]["payload"]["operation_id"]
    k = _op_event(ev, oid, "operation.succeeded")
    ev[k].update(type="operation.outcome_unknown", actor={"kind": "orchestrator"},
                 payload={"operation_id": oid, "cause": "killed"})
    ev[k + 1]["actor"] = {"kind": "user", "id": "local-user"}
    ev[k + 1]["payload"] = {"from": "ci", "to": "cancelled", "trigger": "user_cancel"}
    return ev


def _m_n1_recovery_list_hides_deleted_ids(ev):
    ev[_find(ev, "system.recovery_completed")]["payload"]["approvals_invalidated"] = []
    return ev


def _m_n2_delete_unended_task(ev):
    # Replace the cancellation in place (same seq), so the deleted task is still interrupted when it is deleted.
    i = _find(ev, "task.state_changed", lambda e: e["payload"]["from"] == "interrupted" and e["payload"]["to"] == "cancelled")
    ev[i]["type"] = "task.policy_updated"
    ev[i]["payload"] = {"auto_resume_policy": {"on_quota_reset": False, "on_rate_limit": False}}
    return ev


def _m_n3a_second_round_without_push(ev):
    j = len(ev) - 1
    user, orch, integ = {"kind": "user", "id": "local-user"}, {"kind": "orchestrator"}, {"kind": "integration", "id": "github"}
    steps = [("task.state_changed", orch, {"from": "running", "to": "verifying", "trigger": "implementation_done"}),
             ("check.started", orch, {"check_id": "chk_ZZZZZZZZZZZZZZZZZZZZZZZZ01", "name": "cargo test", "origin": "local"}),
             ("check.finished", orch, {"check_id": "chk_ZZZZZZZZZZZZZZZZZZZZZZZZ01", "state": "passed"}),
             ("task.state_changed", orch, {"from": "verifying", "to": "review", "trigger": "checks_passed"}),
             ("task.state_changed", user, {"from": "review", "to": "pr", "trigger": "review_passed"}),
             ("task.state_changed", integ, {"from": "pr", "to": "ci", "trigger": "pr_published"})]
    for n, (etype, actor, payload) in enumerate(steps, 1):
        ev.append(_new_event(ev, j, etype, actor, payload, n))
    return _renumber(ev)


def _m_n3b_push_other_than_checkpoint_head(ev):
    oid = ev[_find(ev, "operation.recorded", lambda e: e["payload"]["kind"] == "git_push")]["payload"]["operation_id"]
    k = _op_event(ev, oid, "operation.started")
    c = max(i for i in range(k) if ev[i]["type"] == "task.checkpoint_recorded")
    ev[c]["payload"]["worktree"]["head_sha"] = "9" * 40
    return ev


def _m_n3c_merge_other_than_pushed_head(ev):
    i = _find(ev, "operation.recorded", lambda e: e["payload"]["kind"] == "pr_merge")
    p = ev[i]["payload"]
    p["target"]["expected_sha"] = "8" * 40
    p["idempotency_key"] = idempotency_key("pr_merge", p["target"])
    ev[i + 1]["payload"]["operation_fingerprint"] = p["idempotency_key"]
    return ev


def _m_n4_second_blocking_approval(ev):
    i = _find(ev, "approval.requested", lambda e: e["payload"]["source"] == "acp_permission")
    c = _clone(ev[i], 1)
    p = c["payload"]
    p["approval_id"] = "apr_ZZZZZZZZZZZZZZZZZZZZZZZZ01"
    p["acp"]["tool_call_id"] = "call-zz"
    p["operation_fingerprint"] = canonical_sha256({"kind": "tool_call", "target": {"tool_call_id": "call-zz",
                                                                                   "title": p["title"]}})
    ev.insert(i + 1, c)
    return _renumber(ev)


def _m_n6a_approval_of_other_task(ev):
    i = _find(ev, "operation.recorded", lambda e: e["payload"]["kind"] == "pr_merge")
    ev[i + 1]["task_id"] = ev[0]["task_id"]  # task A of fixture 09
    return ev


def _m_n6b_start_after_expiry(ev):
    i = _find(ev, "approval.requested", lambda e: e["payload"]["source"] == "host_policy")
    ev[i]["payload"]["expires_at"] = ev[i]["recorded_at"]
    return ev


def _m_n6c_policy_starts_operation(ev):
    ev[_find(ev, "operation.started")]["actor"] = {"kind": "policy", "id": "policy.default"}
    return ev


def _m_n6d_probe_less_reconcile_finding(ev):
    i = _find(ev, "operation.reconciled")
    oid = ev[i]["payload"]["operation_id"]
    ev[_op_event(ev, oid, "operation.recorded")]["payload"]["reconcile_strategy"] = "none"
    return ev


# -- review round 3: the reviewer's reproductions (E1-E13) as formal mutations ---------------------------
_USER, _ORCH, _REC = {"kind": "user", "id": "local-user"}, {"kind": "orchestrator"}, {"kind": "recovery"}


def _recovery_writes_result(ev, etype, payload):
    """Fixture 06: crash recovery writes a result for the started push instead of outcome_unknown."""
    i = _find(ev, "operation.outcome_unknown", lambda e: e["actor"]["kind"] == "recovery")
    oid = ev[i]["payload"]["operation_id"]
    ev[i]["type"], ev[i]["payload"] = etype, dict(payload, operation_id=oid)
    j = _next(ev, "system.recovery_completed", i)
    ev[j]["payload"]["operations_marked_unknown"] = []
    ev[j - 1]["payload"]["interruption"].pop("open_operation_ids", None)
    return _renumber([e for e in ev if e["type"] != "operation.reconciled"]), oid


def _m_r4_recovery_writes_succeeded(ev):  # E1a
    return _recovery_writes_result(ev, "operation.succeeded", {})[0]


def _m_r4_recovery_fails_then_repush(ev):  # E1c
    ev, oid = _recovery_writes_result(ev, "operation.failed", {"error": {"code": "push_interrupted"}, "effect": "none"})
    rec = ev[_op_event(ev, oid, "operation.recorded")]["payload"]
    k = _find(ev, "task.state_changed", lambda e: e["payload"]["trigger"] == "resume_phase_restored")
    new_op, new_apr = "op_ZZZZZZZZZZZZZZZZZZZZZZZZ01", "apr_ZZZZZZZZZZZZZZZZZZZZZZZZ01"
    pr = json.loads(json.dumps(rec))
    pr.update(operation_id=new_op, approval_id=new_apr, supersedes_operation_id=oid)
    steps = [("operation.recorded", _ORCH, pr),
             ("approval.requested", {"kind": "policy", "id": "policy.default"},
              {"approval_id": new_apr, "source": "host_policy", "operation_kind": "git_push",
               "operation_fingerprint": pr["idempotency_key"], "operation_id": new_op, "title": "Push again",
               "scope": "once", "return_state": "pr"}),
             ("task.state_changed", {"kind": "policy", "id": "policy.default"},
              {"from": "pr", "to": "awaiting_approval", "trigger": "approval_requested", "approval_id": new_apr,
               "return_state": "pr"}),
             ("approval.resolved", _USER, {"approval_id": new_apr, "state": "approved", "scope": "once"}),
             ("task.state_changed", _USER, {"from": "awaiting_approval", "to": "pr", "trigger": "approval_resolved",
                                            "approval_id": new_apr}),
             ("operation.started", _ORCH, {"operation_id": new_op, "approval_id": new_apr}),
             ("operation.succeeded", {"kind": "integration", "id": "github"}, {"operation_id": new_op})]
    for n, (etype, actor, payload) in enumerate(steps, 1):
        ev.insert(k + n, _new_event(ev, k, etype, actor, payload, 10 + n))
    return _renumber(ev)


def _m_r4_recovery_passes_check(ev):  # E1d
    i = _find(ev, "system.recovery_started")
    started = _new_event(ev, i - 1, "check.started", _ORCH,
                         {"check_id": "chk_ZZZZZZZZZZZZZZZZZZZZZZZZ01", "name": "cargo test", "origin": "local"}, 1)
    finished = _new_event(ev, i - 1, "check.finished", _REC,
                          {"check_id": "chk_ZZZZZZZZZZZZZZZZZZZZZZZZ01", "state": "passed"}, 2)
    finished["occurred_at"] = finished["recorded_at"] = ev[i]["recorded_at"]
    ev.insert(i, started)
    ev.insert(i + 2, finished)
    return _renumber(ev)


def _m_r4_recovery_actor_outside_window(ev):
    i = _find(ev, "system.recovery_started")
    j = _find(ev, "session.state_changed", lambda e: e["actor"]["kind"] == "recovery")
    moved = ev.pop(j)
    moved["occurred_at"] = moved["recorded_at"] = ev[i]["recorded_at"]
    ev.insert(i, moved)
    return _renumber(ev)


def _m_r4_orchestrator_completes_recovery(ev):  # E7
    i = _find(ev, "system.recovery_completed")
    ev[i]["actor"], ev[i]["provenance"] = dict(_ORCH), "live"
    return ev


def _m_r4_adapter_reports_operation_result(ev):  # E8
    ev[_find(ev, "operation.succeeded")]["actor"] = {"kind": "adapter", "id": "claude-code"}
    return ev


def _m_r4_adapter_reports_check_result(ev):
    ev[_find(ev, "check.finished")]["actor"] = {"kind": "adapter", "id": "claude-code"}
    return ev


def _retry_after_failure(ev, steps):
    """Append a retry of the task that most recently failed (it is still failed at the end of the fixture)."""
    tid = ev[max(i for i, e in enumerate(ev) if e["type"] == "task.state_changed"
                 and "tombstone" not in e and e["payload"]["to"] == "failed")]["task_id"]
    ref = len(ev) - 1
    for n, (etype, actor, payload) in enumerate(steps, 1):
        e = _new_event(ev, ref, etype, actor, payload, n)
        e["task_id"] = tid
        ev.append(e)
    return _renumber(ev)


def _m_r4_retry_with_resume_phase(ev):  # E3a
    return _retry_after_failure(ev, [
        ("task.state_changed", _USER, {"from": "failed", "to": "queued", "trigger": "retry_requested",
                                       "resume_phase": "review"}),
        ("task.state_changed", _ORCH, {"from": "queued", "to": "preparing", "trigger": "scheduled"}),
        ("task.state_changed", _ORCH, {"from": "preparing", "to": "review", "trigger": "resume_phase_restored",
                                       "resume_phase": "review"})])


def _m_r4_retry_skips_to_pr(ev):  # E3b without the forbidden field
    return _retry_after_failure(ev, [
        ("task.state_changed", _USER, {"from": "failed", "to": "queued", "trigger": "retry_requested"}),
        ("task.state_changed", _ORCH, {"from": "queued", "to": "preparing", "trigger": "scheduled"}),
        ("task.state_changed", _ORCH, {"from": "preparing", "to": "pr", "trigger": "resume_phase_restored",
                                       "resume_phase": "pr"})])


def _m_r4_replay_without_current_load_capability(ev):  # E13
    first = _find(ev, "session.message_delta", lambda e: e["provenance"] == "acp_replay")
    c = max(i for i in range(first) if ev[i]["type"] == "session.capabilities_detected")
    snap = ev[c]["payload"]["snapshot"]
    snap["acp_agent_capabilities"].pop("loadSession", None)
    snap["features"]["load_session"] = False
    return ev


def _m_r4_replay_of_other_event_type(ev):
    first = _find(ev, "session.message_delta", lambda e: e["provenance"] == "acp_replay")
    c = max(i for i in range(first) if ev[i]["type"] == "session.capabilities_detected")
    ev[c]["provenance"] = "acp_replay"
    return ev


def _failed_child(ev):
    return _find(ev, "session.state_changed", lambda e: e["payload"]["to"] == "failed"
                 and e["payload"]["trigger"] == "protocol_error"
                 and any(c["type"] == "session.created" and c["session_id"] == e["session_id"]
                         and c["payload"].get("parent_session_id") for c in ev))


def _m_r4_auto_archive_failed_state_child(ev):  # E4, with the one non-failed outcome a failed session may carry
    k = _failed_child(ev)
    ev[k]["payload"]["outcome"] = "cancelled"
    return _append_auto_archive(ev, ev[k]["session_id"], opened=True)


def _m_r4_failed_session_claims_success(ev):  # E4 as the reviewer wrote it: now a schema error
    ev[_failed_child(ev)]["payload"]["outcome"] = "succeeded"
    return ev


def _m_r4_bulk_mark_failed_state_session(ev):
    k = _failed_child(ev)
    ev[k]["payload"]["outcome"] = "cancelled"
    ack = _new_event(ev, len(ev) - 1, "session.result_acknowledged", _USER, {"method": "bulk_marked_reviewed"}, 1)
    ack.update(task_id=ev[k]["task_id"], session_id=ev[k]["session_id"])
    ev.append(ack)
    return _renumber(ev)


def _m_r4_archive_waiting_main_session(ev):
    """Fixture 06: after the crash the push is outcome_unknown (reconcile_needed), so the main session is waiting."""
    i = _find(ev, "system.recovery_completed")
    tid = ev[i - 1]["task_id"]
    sid = next(e["session_id"] for e in ev if e["type"] == "session.created" and e["task_id"] == tid
               and not e["payload"].get("parent_session_id"))
    a = _new_event(ev, i - 1, "session.archived", _USER, {"by": "user"}, 1)
    a["session_id"] = sid
    a["occurred_at"] = a["recorded_at"] = ev[i]["recorded_at"]
    ev.insert(i + 1, a)
    return _renumber(ev)


def _m_r4_recovery_disconnects_with_other_trigger(ev):
    i = _find(ev, "session.state_changed", lambda e: e["actor"]["kind"] == "recovery")
    ev[i]["payload"]["trigger"] = "process_exited"
    return ev


def _m_r4_archive_paused_main_session(ev):  # E5
    i = _find(ev, "task.state_changed", lambda e: e["payload"]["to"] == "interrupted"
              and e["payload"]["interruption"]["reason"] == "user_paused")
    tid = ev[i]["task_id"]
    sid = next(e["session_id"] for e in ev if e["type"] == "session.created" and e["task_id"] == tid
               and not e["payload"].get("parent_session_id"))
    a = _new_event(ev, i, "session.archived", _USER, {"by": "user"}, 1)
    a["session_id"] = sid
    ev.insert(i + 1, a)
    return _renumber(ev)


def _m_r4_recovery_list_names_live_approval(ev):  # E6
    i = _find(ev, "system.recovery_completed")
    live = next(e["payload"]["approval_id"] for e in ev[i:] if e["type"] == "approval.requested" and "tombstone" not in e)
    ev[i]["payload"]["approvals_invalidated"] = [live]
    return ev


def _m_r4_live_event_during_recovery(ev):
    i = _find(ev, "session.state_changed", lambda e: e["actor"]["kind"] == "recovery")
    ev[i]["actor"], ev[i]["provenance"] = {"kind": "adapter", "id": "claude-code"}, "live"
    ev[i]["payload"]["trigger"] = "process_exited"
    return ev


def _m_r4_recovery_leaves_session_live(ev):
    del ev[_find(ev, "session.state_changed", lambda e: e["actor"]["kind"] == "recovery")]
    return _renumber(ev)


def _m_r4_recovery_leaves_check_running(ev):
    i = _find(ev, "system.recovery_started")
    ev.insert(i, _new_event(ev, i - 1, "check.started", _ORCH,
                            {"check_id": "chk_ZZZZZZZZZZZZZZZZZZZZZZZZ01", "name": "cargo test", "origin": "local"}, 1))
    return _renumber(ev)


def _m_r4_recovery_leaves_task_in_flight(ev):
    del ev[_find(ev, "task.state_changed", lambda e: e["actor"]["kind"] == "recovery")]
    return _renumber(ev)


def _m_r4_recovery_list_omits_session(ev):
    ev[_find(ev, "system.recovery_completed")]["payload"]["sessions_disconnected"] = []
    return ev


def _m_r4_archive_running_main_session(ev):
    i = _find(ev, "session.prompt_submitted")
    a = _new_event(ev, i, "session.archived", _USER, {"by": "user"}, 1)
    a["session_id"] = ev[i]["session_id"]
    ev.insert(i + 1, a)
    return _renumber(ev)


# -- review round 4 ------------------------------------------------------------------------------------
def _m_r5_v2_draft_snapshot(ev):  # X1a: under v2_draft nothing ties `features` to the raw capabilities
    for e in ev:
        if e["type"] == "session.capabilities_detected":
            snap = e["payload"]["snapshot"]
            snap["track"] = "v2_draft"
            snap["acp_agent_capabilities"].pop("loadSession", None)
    return ev


def _m_r5_push_after_checkpoint_without_worktree(ev):  # X2a
    i = _find(ev, "operation.started", lambda e: any(
        r["type"] == "operation.recorded" and r["payload"]["operation_id"] == e["payload"]["operation_id"]
        and r["payload"]["kind"] == "git_push" for r in ev))
    ev.insert(i, _new_event(ev, i - 1, "task.checkpoint_recorded", _ORCH,
                            {"checkpoint_id": "cpt_ZZZZZZZZZZZZZZZZZZZZZZZZ01", "phase": "pr",
                             "through_seq": ev[i - 1]["seq"], "open_operation_ids": [], "pending_approval_ids": []}, 1))
    return _renumber(ev)


def _m_r5_second_deletion_with_one_sidecar(ev):  # X13: a second task, deleted while running
    tid, ts = "tsk_ZZZZZZZZZZZZZZZZZZZZZZZZ09", ev[-1]["recorded_at"]
    steps = [("task.created", _USER), ("task.state_changed", _ORCH), ("task.state_changed", _ORCH)]
    for n, (etype, actor) in enumerate(steps, 1):
        e = _new_event(ev, len(ev) - 1, etype, actor, {}, n)
        e.update(task_id=tid, tombstone={"reason": "task_deleted", "at": ts})
        ev.append(e)
    d = _new_event(ev, len(ev) - 1, "task.deleted", _USER, {"final_state": "completed", "events_tombstoned": 3}, 4)
    d["task_id"] = tid
    ev.append(d)
    return _renumber(ev)


def _m_r5_tombstone_between_wait_and_unarchive(ev):  # Y1b
    u = _find(ev, "session.unarchived", lambda e: e["payload"]["by"] == "system")
    last = max(i for i, e in enumerate(ev) if "tombstone" in e)
    clone = json.loads(json.dumps(ev[last]))
    clone["id"] = "evt_ZZZZZZZZZZZZZZZZZZZZZZZZ01"
    clone["occurred_at"] = clone["recorded_at"] = ev[u - 1]["recorded_at"]
    ev.insert(u, clone)
    ev[_find(ev, "task.deleted")]["payload"]["events_tombstoned"] += 1
    return _renumber(ev)


def _m_r5_session_resumes_on_other_approval(ev):  # adversarial H1: S14 names an approval it is not waiting on
    # Fixture 13, task A: the same session asks twice. The second S14 names the first, already resolved, approval.
    first = _find(ev, "session.state_changed", lambda e: e["payload"]["trigger"] == "permission_resolved")
    sid = ev[first]["session_id"]
    second = _find(ev, "session.state_changed", lambda e: e["payload"]["trigger"] == "permission_resolved"
                   and e["session_id"] == sid, nth=1)
    ev[second]["payload"]["approval_id"] = ev[first]["payload"]["approval_id"]
    return ev


def _recovery_unarchives(ev):
    return [i for i, e in enumerate(ev) if e["type"] == "session.unarchived" and e["actor"]["kind"] == "recovery"]


def _m_r6_orchestrator_unarchives_during_recovery(ev):  # inside the bracket only the recovery actor writes
    i = _recovery_unarchives(ev)[0]
    ev[i]["actor"], ev[i]["provenance"] = {"kind": "orchestrator"}, "live"
    return ev


def _m_r6_recovery_leaves_waiting_session_archived(ev):  # reviewer exp1 "none" and exp3
    drop = set(_recovery_unarchives(ev))
    return _renumber([e for i, e in enumerate(ev) if i not in drop])


def _m_r6_unarchive_deferred_until_after_recovery(ev):  # reviewer exp1 "orchestrator_after"
    i = _recovery_unarchives(ev)[0]
    done = _next(ev, "system.recovery_completed", i)
    e = ev.pop(i)
    e["actor"], e["provenance"] = {"kind": "orchestrator"}, "live"
    e["occurred_at"] = e["recorded_at"] = ev[done - 1]["recorded_at"]
    ev.insert(done, e)
    return _renumber(ev)


def _m_r6_recovery_unarchives_as_user(ev):  # the whitelist admits only by: system
    ev[_recovery_unarchives(ev)[0]]["payload"]["by"] = "user"
    return ev


def _m_r6_recovery_actor_unarchives_live(ev):  # outside recovery the orchestrator writes the system unarchive
    i = _find(ev, "session.unarchived", lambda e: e["payload"]["by"] == "system" and e["actor"]["kind"] == "orchestrator")
    ev[i]["actor"], ev[i]["provenance"] = {"kind": "recovery"}, "recovery"
    return ev


def _m_r6_permission_of_other_session(ev):  # S10 names an approval that belongs to another session of the task
    i = _find(ev, "session.state_changed", lambda e: e["payload"]["trigger"] == "permission_requested")
    aid, sid, tid = ev[i]["payload"]["approval_id"], ev[i]["session_id"], ev[i]["task_id"]
    other = next(e["session_id"] for e in ev[:i] if e["type"] == "session.created" and e["task_id"] == tid
                 and e["session_id"] != sid)
    for e in ev:
        if e["type"] in ("approval.requested", "approval.resolved") and e["payload"].get("approval_id") == aid:
            e["session_id"] = other
    return ev


def _m_r6_session_leaves_with_second_pending_approval(ev):  # reviewer X1: two pending requests, one answer
    # Fixture 13, task A: the second request is recorded before the first is answered (non-blocking, so the task-level
    # "one blocking approval" rule is not what fires).
    first = _find(ev, "session.state_changed", lambda e: e["payload"]["trigger"] == "permission_resolved")
    sid = ev[first]["session_id"]
    req = _find(ev, "approval.requested", lambda e: e.get("session_id") == sid, nth=1)
    e = ev.pop(req)
    e["payload"].pop("return_state", None)
    e["occurred_at"] = e["recorded_at"] = ev[first - 2]["recorded_at"]
    ev.insert(first - 1, e)
    return _renumber(ev)


def _m_r6_approval_resolved_routed_to_other_task(ev):  # reviewer X4
    i = [k for k, e in enumerate(ev) if e["type"] == "approval.resolved" and "session_id" not in e][-1]
    other = next(e for e in ev[:i] if e["type"] == "task.created" and e["task_id"] != ev[i]["task_id"])
    ev[i]["task_id"], ev[i]["project_id"] = other["task_id"], other["project_id"]
    return ev


def _m_r6_adapter_records_operation(ev):
    i = _find(ev, "operation.recorded")
    ev[i]["actor"] = next(e["actor"] for e in ev if e["actor"]["kind"] == "adapter")
    return ev


def _m_r5_merge_bound_to_earlier_success(ev):  # adversarial H2: push B succeeds before push A; merge names B
    r = _find(ev, "operation.recorded", lambda e: e["payload"]["kind"] == "git_push")
    oid, aid = ev[r]["payload"]["operation_id"], ev[r]["payload"]["approval_id"]
    start, done = _op_event(ev, oid, "operation.started"), _op_event(ev, oid, "operation.succeeded")
    cp = max(k for k in range(start) if ev[k]["type"] == "task.checkpoint_recorded")
    at, new_op, new_apr, sha_b = ev[start]["recorded_at"], "op_ZZZZZZZZZZZZZZZZZZZZZZZZ01", "apr_ZZZZZZZZZZZZZZZZZZZZZZZZ01", "b" * 40
    extra = []
    for n, k in enumerate([r] + [k for k in range(r + 1, start) if ev[k]["payload"].get("approval_id") == aid]
                          + [cp, start, done], 1):
        c = _clone(ev[k], n, at)
        q = c["payload"]
        for field, old, new in (("operation_id", oid, new_op), ("approval_id", aid, new_apr)):
            if q.get(field) == old:
                q[field] = new
        if c["type"] == "operation.recorded":
            q["target"]["expected_sha"] = sha_b
            q["idempotency_key"] = idempotency_key("git_push", q["target"])
            key = q["idempotency_key"]
        elif c["type"] == "approval.requested":
            q["operation_fingerprint"] = key
        elif c["type"] == "task.checkpoint_recorded":
            q["checkpoint_id"] = "cpt_ZZZZZZZZZZZZZZZZZZZZZZZZ01"
            q["worktree"]["head_sha"] = sha_b
        extra.append(c)
    m = _find(ev, "operation.recorded", lambda e: e["payload"]["kind"] == "pr_merge")
    ev[m]["payload"]["target"]["expected_sha"] = sha_b
    ev[m]["payload"]["idempotency_key"] = idempotency_key("pr_merge", ev[m]["payload"]["target"])
    ev[_next(ev, "approval.requested", m)]["payload"]["operation_fingerprint"] = ev[m]["payload"]["idempotency_key"]
    return _renumber(ev[:start + 1] + extra + ev[start + 1:])


def _m_r5_archive_idle_child(ev):  # a child that is still live (idle) cannot be archived by hand
    i = _find(ev, "session.state_changed", lambda e: e["payload"]["to"] == "idle" and any(
        c["type"] == "session.created" and c["session_id"] == e["session_id"]
        and c["payload"].get("parent_session_id") for c in ev))
    a = _new_event(ev, i, "session.archived", _USER, {"by": "user"}, 1)
    a["session_id"] = ev[i]["session_id"]
    ev.insert(i + 1, a)
    return _renumber(ev)


MUTATIONS = [
    ("01-happy-path-pr.jsonl", _m_gap, "cursor not gap-free"),
    ("01-happy-path-pr.jsonl", _m_illegal_transition, "illegal task transition"),
    ("01-happy-path-pr.jsonl", _m_archive_primary, "never auto-archived"),
    ("01-happy-path-pr.jsonl", _m_archive_before_open, "auto-archive requires the result to have been opened"),
    ("01-happy-path-pr.jsonl", _m_quota_field_schema, "quota_remaining: not allowed"),
    ("01-happy-path-pr.jsonl", _m_opaque_quota_key, "'remainingQuota' implies a known quota balance"),
    ("01-happy-path-pr.jsonl", _m_unknown_usage_with_numbers, "must not match"),
    ("01-happy-path-pr.jsonl", _m_act_before_approval_persisted, "must be persisted before"),
    ("01-happy-path-pr.jsonl", _m_verify_with_failed_check, "local check cargo test is failed"),
    ("01-happy-path-pr.jsonl", _m_raw_io_inline, "payload.rawInput: not allowed"),
    ("01-happy-path-pr.jsonl", _m_acp_fingerprint, "ACP operation_fingerprint is not sha256"),
    ("01-happy-path-pr.jsonl", _m_e2b_supersede_recorded_op, "(recorded); non-repeatable work must not be redone"),
    ("01-happy-path-pr.jsonl", _m_e7_trailing_newline_id, "\\n' does not match ^tsk_"),
    ("01-happy-path-pr.jsonl", _m_e7_impossible_date, "is not a valid date-time"),
    ("01-happy-path-pr.jsonl", _m_e8a_key_not_canonical, "idempotency_key is not sha256(canonical {kind, identity})"),
    ("01-happy-path-pr.jsonl", _m_e8b_push_claims_idempotent, "expected const 'non_repeatable'"),
    ("01-happy-path-pr.jsonl", _m_e8b_push_without_approval_id, "missing required 'approval_id'"),
    ("04-disconnect-resume-reattach.jsonl", _m_load_without_capability, "without advertised load_session"),
    ("04-disconnect-resume-reattach.jsonl", _m_replay_outside_load, "acp_replay events are only valid"),
    ("04-disconnect-resume-reattach.jsonl", _m_e12_features_mismatch, "features.resume_session does not match"),
    ("04-disconnect-resume-reattach.jsonl", _m_e14_resume_beyond_phase, "resume_phase ci is beyond the interrupted phase running"),
    ("05-quota-interrupt-auto-resume.jsonl", _m_early_auto_resume, "before retry_hint.not_before"),
    ("06-crash-unknown-push.jsonl", _m_rerun_push_after_crash, "executes at most once"),
    ("06-crash-unknown-push.jsonl", _m_recovery_starts_op, "never (re)starts"),
    ("06-crash-unknown-push.jsonl", _m_auto_resume_after_crash, "automatic resume without an armed auto_resume"),
    ("07-crash-pending-approval-load.jsonl", _m_recovery_approves, "approved cannot be decided by recovery"),
    ("07-crash-pending-approval-load.jsonl", _m_keep_pending_after_crash, "still pending after recovery"),
    ("08-review-loop-pause-children.jsonl", _m_wrong_interruption_phase, "interruption.phase must be review"),
    ("09-pr-ci-edges.jsonl", _m_e6_integration_completes_without_merge, "only with merge evidence"),
    ("09-pr-ci-edges.jsonl", _m_e13_policy_approves_merge, "approval for pr_merge can only be granted by the user"),
    ("10-prepare-pause-abandon.jsonl", _m_e9_push_during_review, "cannot record git_push while task is review"),
    ("11-push-denied-abandon-supersede.jsonl", _m_e1_recovery_keeps_recorded_op, "still recorded after recovery"),
    ("11-push-denied-abandon-supersede.jsonl", _m_e1_recovery_keeps_unused_grant, "approved but unused after recovery"),
    ("11-push-denied-abandon-supersede.jsonl", _m_e1_start_after_crash, "cannot start while task is interrupted"),
    ("11-push-denied-abandon-supersede.jsonl", _m_e2a_denied_op_left_recorded, "still recorded although its approval was denied"),
    ("11-push-denied-abandon-supersede.jsonl", _m_e4_cancel_with_started_op, "is started; abandon it"),
    ("11-push-denied-abandon-supersede.jsonl", _m_abandon_while_approval_pending, "is pending; resolve or invalidate it"),
    ("12-session-edge-cases.jsonl", _m_e5_review_approval_blocks, "is non-blocking and must not carry return_state"),
    ("12-session-edge-cases.jsonl", _m_tombstone_count, "tombstones precede it"),
    ("12-session-edge-cases.jsonl", _m_event_after_delete, "event for a deleted task"),
    # review round 2
    ("01-happy-path-pr.jsonl", _m_b1a_duplicate_pr_create_new_description, "(succeeded); non-repeatable work must not be redone"),
    ("06-crash-unknown-push.jsonl", _m_b1b_repush_after_applied_new_description, "(reconciled_applied); non-repeatable work must not be redone"),
    ("01-happy-path-pr.jsonl", _m_b1c_push_target_without_identity, "target: missing required 'remote'"),
    ("06-crash-unknown-push.jsonl", _m_b2_retry_without_reconcile, "is outcome_unknown; reconcile it before failed -> queued"),
    ("01-happy-path-pr.jsonl", _m_b3a_policy_approves_acp_merge, "approval classified pr_merge can only be granted by the user"),
    ("01-happy-path-pr.jsonl", _m_b3b_acp_claims_operation_kind, "expected const 'tool_call'"),
    ("01-happy-path-pr.jsonl", _m_b4a_auto_archive_failed_child, "auto-archive requires a closed child session with outcome succeeded or cancelled"),
    ("12-session-edge-cases.jsonl", _m_b4b_auto_archive_protocol_error_child, "auto-archive requires a closed child session with outcome succeeded or cancelled"),
    ("08-review-loop-pause-children.jsonl", _m_b4c_auto_archive_after_restore, "never auto-archived again"),
    ("01-happy-path-pr.jsonl", _m_b4d_archive_after_mark_reviewed_only, "auto-archive requires the result to have been opened"),
    ("12-session-edge-cases.jsonl", _m_b4e_waiting_session_left_archived, "must be written in the same transaction"),
    ("10-prepare-pause-abandon.jsonl", _m_b4f_bulk_mark_failed_task, "never applies to a failed task"),
    ("09-pr-ci-edges.jsonl", _m_b5_kill_started_merge, "a started pr_merge cannot be killed"),
    ("12-session-edge-cases.jsonl", _m_n1_recovery_list_hides_deleted_ids, "plus 1 id(s) of a deleted task"),
    ("predelete/12-session-edge-cases.jsonl", _m_n2_delete_unended_task, "task.deleted precondition: task is interrupted"),
    ("06-crash-unknown-push.jsonl", _m_n3a_second_round_without_push, "requires a git_push that succeeded (or was reconciled applied) in this PR round"),
    ("01-happy-path-pr.jsonl", _m_n3b_push_other_than_checkpoint_head, "git_push expected_sha must equal the head_sha"),
    ("09-pr-ci-edges.jsonl", _m_n3c_merge_other_than_pushed_head, "pr_merge expected_sha must equal the PR head"),
    ("01-happy-path-pr.jsonl", _m_n4_second_blocking_approval, "already pending and blocking"),
    ("09-pr-ci-edges.jsonl", _m_n6a_approval_of_other_task, "must follow operation.recorded of the same task"),
    ("01-happy-path-pr.jsonl", _m_n6b_start_after_expiry, "an expired grant authorizes nothing"),
    ("01-happy-path-pr.jsonl", _m_n6c_policy_starts_operation, "operations are started by the orchestrator, not policy"),
    ("11-push-denied-abandon-supersede.jsonl", _m_n6d_probe_less_reconcile_finding, "the only possible finding is undeterminable"),
    # review round 3
    ("06-crash-unknown-push.jsonl", _m_r4_recovery_writes_succeeded, "the recovery actor may only invalidate approvals"),
    ("06-crash-unknown-push.jsonl", _m_r4_recovery_fails_then_repush, "the recovery actor may only invalidate approvals"),
    ("06-crash-unknown-push.jsonl", _m_r4_recovery_passes_check, "the recovery actor may only invalidate approvals"),
    ("06-crash-unknown-push.jsonl", _m_r4_recovery_actor_outside_window, "only written between system.recovery_started and system.recovery_completed"),
    ("06-crash-unknown-push.jsonl", _m_r4_orchestrator_completes_recovery, "system.recovery_completed is written by the recovery actor"),
    ("06-crash-unknown-push.jsonl", _m_r4_adapter_reports_operation_result, "operation.succeeded is reported by the orchestrator or integration"),
    ("01-happy-path-pr.jsonl", _m_r4_adapter_reports_check_result, "check results are reported by the orchestrator or integration, not adapter"),
    ("04-disconnect-resume-reattach.jsonl", _m_r4_retry_with_resume_phase, 'must not match {"required": ["resume_phase"]}'),
    ("10-prepare-pause-abandon.jsonl", _m_r4_retry_skips_to_pr, "preparing -> pr requires the task's recorded resume_phase to be pr"),
    ("07-crash-pending-approval-load.jsonl", _m_r4_replay_without_current_load_capability, "acp_replay requires that the current process"),
    ("07-crash-pending-approval-load.jsonl", _m_r4_replay_of_other_event_type, "not in ['session.message_delta', 'session.tool_call', 'session.plan_updated']"),
    ("12-session-edge-cases.jsonl", _m_r4_auto_archive_failed_state_child, "a failed session is never auto-archived (state failed, outcome cancelled)"),
    ("12-session-edge-cases.jsonl", _m_r4_failed_session_claims_success, "'succeeded' not in ['failed', 'cancelled']"),
    ("12-session-edge-cases.jsonl", _m_r4_bulk_mark_failed_state_session, "never applies to a failed session with outcome cancelled"),
    ("06-crash-unknown-push.jsonl", _m_r4_archive_waiting_main_session, "a session that is waiting for the user (needs reply) cannot be archived"),
    ("06-crash-unknown-push.jsonl", _m_r4_recovery_disconnects_with_other_trigger, "the recovery actor may only invalidate approvals"),
    ("10-prepare-pause-abandon.jsonl", _m_r4_archive_paused_main_session, "(task is paused)"),
    ("12-session-edge-cases.jsonl", _m_r4_recovery_list_names_live_approval, "but it belongs to a live entity"),
    ("06-crash-unknown-push.jsonl", _m_r4_live_event_during_recovery, "only recovery-actor events may be written while recovery is in progress"),
    ("06-crash-unknown-push.jsonl", _m_r4_recovery_leaves_session_live, "after recovery (processes do not survive a host crash)"),
    ("06-crash-unknown-push.jsonl", _m_r4_recovery_leaves_check_running, "check chk_ZZZZZZZZZZZZZZZZZZZZZZZZ01 still running after recovery"),
    ("06-crash-unknown-push.jsonl", _m_r4_recovery_leaves_task_in_flight, "still pr after recovery"),
    ("06-crash-unknown-push.jsonl", _m_r4_recovery_list_omits_session, "sessions_disconnected lists [], recovery changed"),
    ("01-happy-path-pr.jsonl", _m_r4_archive_running_main_session, "(task is running)"),
    # review round 4
    ("07-crash-pending-approval-load.jsonl", _m_r5_v2_draft_snapshot, "track v2_draft is not accepted"),
    ("01-happy-path-pr.jsonl", _m_r5_push_after_checkpoint_without_worktree, "the latest task.checkpoint_recorded must carry a worktree"),
    ("deleting/12-session-edge-cases.jsonl", _m_r5_second_deletion_with_one_sidecar, "2 task.deleted events; a stream with a pre-deletion copy deletes exactly one task"),
    ("12-session-edge-cases.jsonl", _m_r5_tombstone_between_wait_and_unarchive, "must be written in the same transaction"),
    ("13-crash-archived-sessions.jsonl", _m_r5_session_resumes_on_other_approval, "permission_resolved must name the approval the session is waiting on"),
    ("13-crash-archived-sessions.jsonl", _m_r6_orchestrator_unarchives_during_recovery,
     "only recovery-actor events may be written while recovery is in progress"),
    ("13-crash-archived-sessions.jsonl", _m_r6_recovery_leaves_waiting_session_archived, "must be written in the same transaction"),
    ("13-crash-archived-sessions.jsonl", _m_r6_unarchive_deferred_until_after_recovery, "must be written in the same transaction"),
    ("13-crash-archived-sessions.jsonl", _m_r6_recovery_unarchives_as_user, "the recovery actor may only invalidate approvals"),
    ("12-session-edge-cases.jsonl", _m_r6_recovery_actor_unarchives_live,
     "recovery-actor events are only written between system.recovery_started and system.recovery_completed"),
    ("13-crash-archived-sessions.jsonl", _m_r6_permission_of_other_session, "permission_requested must name an approval of this session"),
    ("13-crash-archived-sessions.jsonl", _m_r6_session_leaves_with_second_pending_approval, "of this session is still pending"),
    ("09-pr-ci-edges.jsonl", _m_r6_approval_resolved_routed_to_other_task, "task_id of the event is not the task of the approval it names"),
    ("01-happy-path-pr.jsonl", _m_r6_adapter_records_operation, "operation.recorded is written by the orchestrator"),
    ("09-pr-ci-edges.jsonl", _m_r5_merge_bound_to_earlier_success, "pr_merge expected_sha must equal the PR head AgentDock last pushed"),
    ("08-review-loop-pause-children.jsonl", _m_r5_archive_idle_child, "manual archive of a child session is offered only when it is closed, failed, suspended or disconnected (session is idle)"),
]


def check_enforcement_docs():
    """The Enforcement boundary section is one text kept in two files. What it claims must be what the self-test
    runs: every mutation name written in [`...`] exists, and every mutation is named."""
    errors, sections = [], {}
    for path, heading in ((README_PATH, "## Enforcement boundary"), (ADR_PATH, "### 9. Enforcement boundary")):
        text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
        m = re.search(r"(?ms)^" + re.escape(heading) + r"\n(.*?)(?=^## )", text)
        if not m:
            errors.append(f"{path.name}: section '{heading}' not found")
            continue
        sections[path.name] = m.group(1).strip().replace("](../contracts/", "](")
        if f"{len(MUTATIONS)} negative mutations" not in text:
            errors.append(f"{path.name}: must state the current count as '{len(MUTATIONS)} negative mutations'")
    if len(sections) == 2:
        readme, adr = sections.values()
        if readme != adr:
            errors.append("the Enforcement boundary section differs between README.md and ADR-0003")
        named = set()
        for group in re.findall(r"\[((?:`[a-z0-9_]+`(?:, )?)+)\]", readme):
            named |= set(re.findall(r"`([a-z0-9_]+)`", group))
        actual = {m.__name__[len("_m_"):] for _f, m, _e in MUTATIONS}
        errors += [f"Enforcement boundary names mutation '{n}', which does not exist" for n in sorted(named - actual)]
        errors += [f"mutation '{n}' is not named in the Enforcement boundary table" for n in sorted(actual - named)]
    return errors


def check_state_machine_doc(transitions):
    """state-machines.md mirrors transitions.json: one table row per transition, identical in every column."""
    def cells(text):
        return [] if text.strip() == "—" else [x.strip().strip("`") for x in text.split(",")]
    rows = {}
    for line in (ROOT / "state-machines.md").read_text(encoding="utf-8").replace("\r\n", "\n").split("\n"):
        m = re.match(r"\| ([TS]\d\d) \| (.*?) \| (.*?) \| (.*?) \| (.*?) \| (.*?) \| (.*?) \|$", line)
        if m:
            rows[m.group(1)] = (m.group(2).strip("`"), m.group(3).strip("`"), cells(m.group(4)), cells(m.group(5)),
                                m.group(6), cells(m.group(7)))
    errors, ids = [], set()
    for kind in ("task", "session"):
        for t in transitions[kind]["transitions"]:
            ids.add(t["id"])
            want = (t["from"] or "(new)", t["to"], t["actors"], t["triggers"], t["durability"], t.get("conditions", []))
            if rows.get(t["id"]) != want:
                errors.append(f"state-machines.md row {t['id']} is {rows.get(t['id'])}, transitions.json says {want}")
    errors += [f"state-machines.md row {i} is not in transitions.json" for i in sorted(set(rows) - ids)]
    return errors


def self_test(loaded, transitions, v, defs):
    errors = []
    for fixture, mutate, expected in MUTATIONS:
        source = fixture[len("deleting/"):] if fixture.startswith("deleting/") else fixture
        events = mutate(json.loads(json.dumps(loaded[source])))
        if fixture.startswith("predelete/"):  # mutate the pre-deletion copy
            main_name = fixture[len("predelete/"):]
            run_errors = check_predelete(main_name, loaded[main_name], events, transitions, v, defs)
        elif fixture.startswith("deleting/"):  # mutate the final stream, keep the pre-deletion copy
            main_name = fixture[len("deleting/"):]
            run_errors, _ = run_stream(main_name, events, transitions, v, defs)
            run_errors += check_predelete(main_name, events, loaded["predelete/" + main_name], transitions, v, defs)
        else:
            run_errors, _ = run_stream(fixture, events, transitions, v, defs)
        if not any(expected in e for e in run_errors):
            errors.append(f"self-test {mutate.__name__} on {fixture}: expected an error containing {expected!r}, "
                          f"got {run_errors[:3]}")
    return errors, len(MUTATIONS)


if __name__ == "__main__":
    sys.exit(main())
