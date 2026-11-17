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

Usage:  python -B docs/contracts/validate_fixtures.py   (exit code 0 = all good; -B avoids writing __pycache__)
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

# Any property name (including inside opaque objects such as acp_agent_capabilities) that suggests a
# known subscription balance. 'on_quota_reset' (a user policy flag) is the only quota-named key allowed.
FORBIDDEN_NAME = re.compile(r"(remaining|_left|left_|balance|allowance|percent|pct|quota(?!_reset$))", re.I)


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
        return []
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
        if to == "queued":  # T44 records where to resume; T47 (retry) restarts from running
            t["resume_phase"] = p.get("resume_phase")
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
        if "worktree" in p:
            self.checkpoints[ev["task_id"]] = p["worktree"]

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
            "limited_turn": None,
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
        if p["method"] == "bulk_marked_reviewed" and s["outcome"] not in BULK_SESSION_OUTCOMES:
            self.err(ev, f"'Mark completed as reviewed' never applies to a session with outcome {s['outcome']}")
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
            if s["state"] not in ("closed", "failed") or s["outcome"] not in AUTO_ARCHIVE_OUTCOMES:
                self.err(ev, f"auto-archive requires a finished child session with outcome succeeded or cancelled "
                             f"(state {s['state']}, outcome {s['outcome']})")
            elif s["opened_seq"] <= s["closed_seq"]:
                self.err(ev, "auto-archive requires the result to have been opened after the session finished "
                             "(marking it reviewed does not count)")
            if s["restored"]:
                self.err(ev, "a session the user restored is never auto-archived again")
        else:
            if ev["actor"]["kind"] != "user":
                self.err(ev, "archived by 'user' must have a user actor")
            if s["parent"] is not None and s["state"] not in ("closed", "failed"):
                self.err(ev, f"manual archive is offered only in a terminal state (session is {s['state']})")
            if s["parent"] is None and self.tasks[s["task_id"]]["state"] not in ACK_TASK_STATES:
                self.err(ev, f"manual archive of a main session is offered only in a terminal task state "
                             f"(task is {self.tasks[s['task_id']]['state']})")
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
            if ev["actor"]["kind"] != "orchestrator":
                self.err(ev, "a system unarchive is written by the orchestrator")
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

    def approval_resolved(self, ev, p):
        aid = p["approval_id"]
        a = self.approvals.get(aid)
        if a is None:
            return self.err(ev, "unknown approval")
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
            elif other_id in superseded:
                continue  # an earlier link of the same supersede chain
            self.err(ev, f"same idempotency_key as {other_id} ({other['state']}); non-repeatable work must not be redone")
        self.operations[oid] = {"task_id": tid, "kind": p["kind"], "key": p["idempotency_key"],
                                "rep": p["repeatability"], "approval": p["approval_id"], "sup": sup,
                                "state": "recorded", "effect": None, "seq": ev["seq"], "target": p["target"],
                                "strategy": p["reconcile_strategy"]}

    def operation_started(self, ev, p):
        op = self.operations.get(p["operation_id"])
        if op is None:
            return self.err(ev, "operation must be recorded before it starts")
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
                self.err(ev, "git_push expected_sha must equal the head_sha of the task's latest clean checkpoint")
        if op["kind"] == "pr_merge":
            pushes = [o for o in self.operations.values()
                      if o["task_id"] == tid and o["kind"] == "git_push" and o["state"] in DONE_OP]
            head = max(pushes, key=lambda o: o["seq"])["target"]["expected_sha"] if pushes else None
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
        if new_state == "outcome_unknown":
            want = {"host_crash": "recovery", "killed": "orchestrator"}[p["cause"]]
            if ev["actor"]["kind"] != want:
                self.err(ev, f"outcome_unknown with cause {p['cause']} is assigned by {want}")
            if p["cause"] == "killed" and op["kind"] in UNINTERRUPTIBLE_KINDS:
                self.err(ev, f"a started {op['kind']} cannot be killed (ADR-0002 PRL-5); cancel/interrupt waits for "
                             f"its result")
        op["state"] = new_state
        if new_state == "failed":
            op["effect"] = p["effect"]

    def operation_abandoned(self, ev, p):
        op = self.operations.get(p["operation_id"])
        if op is None or op["state"] != "recorded":
            return self.err(ev, "only recorded (never started) operations can be abandoned")
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
        if ev["actor"]["kind"] not in ("orchestrator", "integration", "user"):
            self.err(ev, "reconciliation is a live read-only probe, not part of recovery")
        if op["strategy"] == "none" and p["finding"] != "undeterminable":
            self.err(ev, "reconcile_strategy 'none' has no probe; the only possible finding is undeterminable")
        op["state"] = "reconciled_" + p["finding"]

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
        if p["state"] == "outcome_unknown" and ev["actor"]["kind"] != "recovery":
            self.err(ev, "outcome_unknown is assigned by crash recovery")
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

    # -- dispatcher -----------------------------------------------------------------------------
    def apply(self, ev):
        self.envelope(ev)
        if "tombstone" in ev or (ev.get("task_id") in self.deleted and ev["type"] != "task.deleted"):
            return
        # Unknown task/session ids were already reported by envelope(); do not replay against missing state.
        if "task_id" in ev and ev["type"] not in ("task.created", "task.deleted") and ev["task_id"] not in self.tasks:
            return
        if "session_id" in ev and ev["type"] != "session.created" and ev["session_id"] not in self.sessions:
            return
        p, t = ev["payload"], ev["type"]
        if self.must_unarchive and not (t == "session.unarchived" and p.get("by") == "system"
                                        and ev.get("session_id") in self.must_unarchive):
            for sid in sorted(self.must_unarchive):
                self.err(ev, f"archived session {sid} is waiting for the user; session.unarchived{{by: system}} "
                             f"must be written in the same transaction")
            self.must_unarchive = set()
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
          f"schema keyword subset respected, models.sample.json valid, {mutations_run} negative mutations rejected")
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
    ("01-happy-path-pr.jsonl", _m_b4a_auto_archive_failed_child, "auto-archive requires a finished child session with outcome succeeded or cancelled"),
    ("12-session-edge-cases.jsonl", _m_b4b_auto_archive_protocol_error_child, "auto-archive requires a finished child session with outcome succeeded or cancelled"),
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
]


def self_test(loaded, transitions, v, defs):
    errors = []
    for fixture, mutate, expected in MUTATIONS:
        events = mutate(json.loads(json.dumps(loaded[fixture])))
        if fixture.startswith("predelete/"):
            main_name = fixture[len("predelete/"):]
            run_errors = check_predelete(main_name, loaded[main_name], events, transitions, v, defs)
        else:
            run_errors, _ = run_stream(fixture, events, transitions, v, defs)
        if not any(expected in e for e in run_errors):
            errors.append(f"self-test {mutate.__name__} on {fixture}: expected an error containing {expected!r}, "
                          f"got {run_errors[:3]}")
    return errors, len(MUTATIONS)


if __name__ == "__main__":
    sys.exit(main())
