#!/usr/bin/env python3
"""Validate AgentDock contract fixtures (ADR-0003) using only the Python standard library.

What it checks:
  1. schema/agentdock.schema.json only uses the JSON Schema keyword subset this script implements.
  2. Every fixture line is a valid EventEnvelope; every *.expected.json is a valid FixtureExpectation;
     fixtures/models.sample.json is a valid ModelSamples document.
  3. Semantic rules that JSON Schema cannot express: gap-free cursor, legal task/session transitions
     (transitions.json), approval/operation/check lifecycles, crash-recovery invariants, no automatic
     replay of non-repeatable operations, capability-gated reattach, auto-collapse and auto-resume rules.
  4. The projection of each fixture (final states + derived attention items) equals its expectation.
  5. Every transition in transitions.json is exercised by at least one fixture.
  6. No property name anywhere suggests a known subscription quota balance.
  7. Negative self-test: a list of deliberate mutations (gap in cursor, re-running a push after a crash,
     recovery approving, early auto-resume, ...) must each be rejected with the expected message.

Usage:  python docs/contracts/validate_fixtures.py   (exit code 0 = all good)
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SCHEMA_PATH = ROOT / "schema" / "agentdock.schema.json"
TRANSITIONS_PATH = ROOT / "transitions.json"
FIXTURES_DIR = ROOT / "fixtures"

FORBIDDEN_NAME = re.compile(r"(remaining|quota_left|left_quota|balance|percent_left|allowance|quota_reset_at)", re.I)

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
                rx = self._regex.setdefault(schema["pattern"], re.compile(schema["pattern"]))
                if not rx.search(instance):
                    errs.append(f"{path}: {instance!r} does not match {schema['pattern']}")
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
LIVE_SESSION = {"starting", "idle", "active", "awaiting_permission", "suspended"}
IN_FLIGHT_TASK = {"preparing", "running", "awaiting_approval", "verifying", "review", "pr", "ci"}
REPLY_ROLES = {"primary", "implementation", "repair"}


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
        if ev["provenance"] == "acp_replay":
            s = self.sessions.get(ev.get("session_id"))
            if not s or s["state"] != "starting" or s["launch_method"] != "load":
                self.err(ev, "acp_replay events are only valid while a session/load is in progress")
        if "task_id" in ev and ev["type"] != "task.created" and ev["task_id"] not in self.tasks:
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
            "state": "queued", "policy": p["auto_resume_policy"], "interruption": None, "resume_phase": None,
            "return_state": None, "entered_seq": ev["seq"], "ack_seq": 0, "state_entered": {"queued": ev["seq"]},
        }

    def task_state_changed(self, ev, p):
        t = self.tasks.get(ev["task_id"])
        if t is None:
            return
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
            getattr(self, "cond_" + cond)(ev, p, t, ev["task_id"])
        if to == "interrupted":
            intr = p["interruption"]
            if actor == "recovery" and intr["reason"] != "host_crashed":
                self.err(ev, "recovery may only interrupt with reason host_crashed")
            if intr["auto_resume_armed"]:
                flag = {"quota_exhausted": "on_quota_reset", "rate_limited": "on_rate_limit"}[intr["reason"]]
                if not t["policy"][flag]:
                    self.err(ev, f"auto_resume_armed but task policy {flag} is false")
            t["interruption"] = intr
        if frm == "interrupted":
            t["interruption"] = None
        if frm == "interrupted" and to == "queued":
            t["resume_phase"] = p["resume_phase"]
        if to == "awaiting_approval":
            t["return_state"] = p["return_state"]
            if p["return_state"] != frm:
                self.err(ev, f"return_state {p['return_state']} must equal the state being left ({frm})")
        if frm == "preparing" and to in ("verifying", "review", "pr", "ci") and t["resume_phase"] != to:
            self.err(ev, f"preparing -> {to} requires the task's recorded resume_phase to be {to}")
        if frm == "preparing" and to in IN_FLIGHT_TASK:
            t["resume_phase"] = None
        t["state"] = to
        if frm != "awaiting_approval":  # an approval detour is not a new phase
            t["state_entered"][to] = ev["seq"]
        t["entered_seq"] = ev["seq"]

    def cond_resume_phase_equals_to(self, ev, p, t, tid):
        if p.get("resume_phase") != p["to"]:
            self.err(ev, "resume_phase must equal 'to'")

    def cond_no_unreconciled_operations(self, ev, p, t, tid):
        for oid, op in self.operations.items():
            if op["task_id"] == tid and op["state"] in ("recorded", "started", "outcome_unknown"):
                self.err(ev, f"operation {oid} is {op['state']}; reconcile before re-entering {p['to']}")

    def cond_approval_requested_before(self, ev, p, t, tid):
        a = self.approvals.get(p["approval_id"])
        if not a or a["state"] != "pending" or a["task_id"] != tid:
            self.err(ev, "approval must be recorded as pending before the task waits on it")

    def cond_return_state_matches(self, ev, p, t, tid):
        if p["to"] != t["return_state"]:
            self.err(ev, f"must return to {t['return_state']}, not {p['to']}")

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

    def cond_pr_operation_succeeded(self, ev, p, t, tid):
        if not any(op["task_id"] == tid and op["kind"] in ("pr_create", "pr_update") and op["state"] in ("succeeded", "reconciled_applied")
                   for op in self.operations.values()):
            self.err(ev, "pr -> ci requires a succeeded (or reconciled-applied) pr_create/pr_update operation")

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
        if p["acknowledged_state"] != t["state"] or t["state"] not in ("completed", "failed", "cancelled"):
            self.err(ev, "acknowledged_state must be the current completed/failed/cancelled state")
        t["ack_seq"] = ev["seq"]

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
            "outcome": None, "closed_seq": 0, "ack_seq": 0, "collapsed": None,
        }

    def session_caps(self, ev, p):
        s = self.sessions[ev["session_id"]]
        if s["state"] != "starting":
            self.err(ev, "capabilities are detected right after initialize, while starting")
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
            s["last_stop"] = p["stop_reason"]
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

    def session_ack(self, ev, p):
        s = self.sessions[ev["session_id"]]
        if s["state"] not in ("closed", "failed"):
            self.err(ev, "a session result can only be acknowledged once the session is closed/failed")
        if ev["actor"]["kind"] != "user":
            self.err(ev, "only the user acknowledges a session result")
        s["ack_seq"] = ev["seq"]

    def session_collapsed(self, ev, p):
        s = self.sessions[ev["session_id"]]
        if p["by"] == "auto":
            if s["parent"] is None:
                self.err(ev, "a primary (parent-less) session is never auto-collapsed")
            if s["state"] not in ("closed", "failed") or s["ack_seq"] <= s["closed_seq"]:
                self.err(ev, "auto-collapse requires a finished child session whose result the user acknowledged")
        elif ev["actor"]["kind"] != "user":
            self.err(ev, "collapsed by 'user' must have a user actor")
        s["collapsed"] = p["by"]

    def session_expanded(self, ev, p):
        s = self.sessions[ev["session_id"]]
        if s["collapsed"] is None:
            self.err(ev, "session is not collapsed")
        s["collapsed"] = None

    # -- approvals ----------------------------------------------------------------------------
    def approval_requested(self, ev, p):
        aid = p["approval_id"]
        if aid in self.approvals:
            return self.err(ev, "approval already exists")
        if p["source"] == "acp_permission" and "session_id" not in ev:
            self.err(ev, "ACP permission approvals are session-scoped")
        if ev["actor"]["kind"] not in ("policy", "adapter"):
            self.err(ev, "approvals are requested by policy or adapter")
        self.approvals[aid] = {"task_id": ev["task_id"], "session_id": ev.get("session_id"), "state": "pending",
                               "source": p["source"], "fingerprint": p["operation_fingerprint"],
                               "options": {o["option_id"]: o["kind"] for o in p.get("acp", {}).get("options", [])}}

    def approval_resolved(self, ev, p):
        a = self.approvals.get(p["approval_id"])
        if a is None:
            return self.err(ev, "unknown approval")
        if a["state"] != "pending":
            return self.err(ev, f"approval already {a['state']}")
        state, actor = p["state"], ev["actor"]["kind"]
        allowed = {"approved": {"user", "policy"}, "denied": {"user", "policy"}, "expired": {"policy", "orchestrator"},
                   "cancelled": {"user", "orchestrator"}, "invalidated": {"recovery"}}[state]
        if actor not in allowed:
            self.err(ev, f"{state} cannot be decided by {actor}")
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
        sup = p.get("supersedes_operation_id")
        for other_id, other in self.operations.items():
            if other["key"] != p["idempotency_key"]:
                continue
            if other_id == sup and other["state"] in ("failed", "reconciled_not_applied", "reconciled_undeterminable"):
                if other["state"] == "failed" and other["effect"] != "none":
                    self.err(ev, "superseding a failed attempt with unknown effect requires reconciliation first")
                continue
            self.err(ev, f"same idempotency_key as {other_id} ({other['state']}); non-repeatable work must not be redone")
        if sup and sup not in self.operations:
            self.err(ev, "supersedes an unknown operation")
        self.operations[oid] = {"task_id": ev["task_id"], "kind": p["kind"], "key": p["idempotency_key"],
                                "rep": p["repeatability"], "approval": p.get("approval_id"),
                                "state": "recorded", "effect": None, "seq": ev["seq"]}

    def operation_started(self, ev, p):
        op = self.operations.get(p["operation_id"])
        if op is None:
            return self.err(ev, "operation must be recorded before it starts")
        if op["state"] != "recorded":
            return self.err(ev, f"operation is {op['state']}; an operation id executes at most once")
        if ev["actor"]["kind"] == "recovery":
            self.err(ev, "crash recovery never (re)starts an operation")
        a = self.approvals.get(p["approval_id"])
        if op["rep"] != "repeatable":
            if not a or a["state"] != "approved":
                self.err(ev, "non-repeatable operation started without an approved approval")
            elif a["fingerprint"] != op["key"]:
                self.err(ev, "approval fingerprint does not match the operation idempotency_key")
            if p["approval_id"] in self.consumed_approvals:
                self.err(ev, "approval already consumed by another execution")
        if op["approval"] and op["approval"] != p["approval_id"]:
            self.err(ev, "started with a different approval than recorded")
        self.consumed_approvals.add(p["approval_id"])
        if self.tasks[op["task_id"]]["state"] in TERMINAL_TASK:
            self.err(ev, "no operations for a terminal task")
        op["state"] = "started"

    def operation_finished(self, ev, p, new_state):
        op = self.operations.get(p["operation_id"])
        if op is None or op["state"] != "started":
            return self.err(ev, f"operation must be started to become {new_state}")
        if new_state == "outcome_unknown" and ev["actor"]["kind"] != "recovery":
            self.err(ev, "outcome_unknown is assigned by crash recovery")
        op["state"] = new_state
        if new_state == "failed":
            op["effect"] = p["effect"]

    def operation_reconciled(self, ev, p):
        op = self.operations.get(p["operation_id"])
        if op is None or op["state"] != "outcome_unknown":
            return self.err(ev, "only outcome_unknown operations are reconciled")
        if ev["actor"]["kind"] not in ("orchestrator", "integration", "user"):
            self.err(ev, "reconciliation is a live read-only probe, not part of recovery")
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
        self.recovery = {"tasks": set(), "sessions": set(), "approvals": set(), "ops": set(), "checks": set()}

    def recovery_completed(self, ev, p):
        r = self.recovery
        if r is None:
            return self.err(ev, "recovery_completed without recovery_started")
        for aid, a in self.approvals.items():
            if a["state"] == "pending":
                self.err(ev, f"approval {aid} still pending after recovery")
        for oid, op in self.operations.items():
            if op["state"] == "started":
                self.err(ev, f"operation {oid} still 'started' after recovery")
        for cid, c in self.checks.items():
            if c["state"] == "running":
                self.err(ev, f"check {cid} still running after recovery")
        for sid, s in self.sessions.items():
            if s["state"] in LIVE_SESSION:
                self.err(ev, f"session {sid} still {s['state']} after recovery (processes do not survive a host crash)")
        for tid, t in self.tasks.items():
            if t["state"] in IN_FLIGHT_TASK:
                self.err(ev, f"task {tid} still {t['state']} after recovery")
        expect = {"tasks_interrupted": r["tasks"], "sessions_disconnected": r["sessions"],
                  "approvals_invalidated": r["approvals"], "operations_marked_unknown": r["ops"],
                  "checks_marked_unknown": r["checks"]}
        for key, actual in expect.items():
            if set(p[key]) != actual:
                self.err(ev, f"{key} lists {sorted(p[key])}, recovery changed {sorted(actual)}")
        self.recovery = None

    # -- dispatcher -----------------------------------------------------------------------------
    def apply(self, ev):
        self.envelope(ev)
        p, t = ev["payload"], ev["type"]
        handler = {
            "task.created": self.task_created, "task.state_changed": self.task_state_changed,
            "task.outcome_acknowledged": self.task_ack,
            "session.created": self.session_created, "session.capabilities_detected": self.session_caps,
            "session.state_changed": self.session_state_changed, "session.prompt_submitted": self.prompt,
            "session.result_acknowledged": self.session_ack, "session.collapsed": self.session_collapsed,
            "session.expanded": self.session_expanded, "session.summary_recorded": self.summary,
            "approval.requested": self.approval_requested, "approval.resolved": self.approval_resolved,
            "operation.recorded": self.operation_recorded, "operation.started": self.operation_started,
            "operation.succeeded": lambda e, q: self.operation_finished(e, q, "succeeded"),
            "operation.failed": lambda e, q: self.operation_finished(e, q, "failed"),
            "operation.outcome_unknown": lambda e, q: self.operation_finished(e, q, "outcome_unknown"),
            "operation.reconciled": self.operation_reconciled,
            "check.started": self.check_started, "check.finished": self.check_finished,
            "usage.reported": self.usage,
            "system.recovery_started": self.recovery_started, "system.recovery_completed": self.recovery_completed,
        }.get(t)
        if handler:
            handler(ev, p)
        if self.recovery is not None and t != "system.recovery_started":
            self._note_recovery(ev, p)

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
        elif t == "check.finished" and p["state"] == "outcome_unknown":
            r["checks"].add(p["check_id"])

    # -- derived attention (docs/contracts/attention.md) ---------------------------------------
    def attention(self):
        items = set()
        for tid, t in self.tasks.items():
            st = t["state"]
            if st == "queued":
                items.add(("background", "queued", tid, None, None))
            elif st in ("preparing", "verifying", "review", "pr", "ci"):
                items.add(("background", "workflow_step", tid, None, None))
            elif st == "interrupted":
                if (t["interruption"] or {}).get("auto_resume_armed"):
                    items.add(("background", "waiting_for_reset", tid, None, None))
                else:
                    items.add(("needs_reply", "interruption_needs_decision", tid, None, None))
            elif st == "failed" and t["ack_seq"] < t["entered_seq"]:
                items.add(("needs_reply", "failure_needs_decision", tid, None, None))
            elif st == "completed" and t["ack_seq"] < t["entered_seq"]:
                items.add(("needs_review", "task_outcome_unviewed", tid, None, None))
        for aid, a in self.approvals.items():
            if a["state"] == "pending":
                items.add(("needs_reply", "approval_pending", a["task_id"], a["session_id"], aid))
        for sid, s in self.sessions.items():
            task_state = self.tasks[s["task_id"]]["state"]
            if s["state"] == "active":
                items.add(("background", "agent_working", s["task_id"], sid, None))
            if (s["state"] == "idle" and s["last_stop"] not in (None, "cancelled") and task_state == "running"
                    and s["role"] in REPLY_ROLES):
                items.add(("needs_reply", "agent_turn_ended", s["task_id"], sid, None))
            if (s["parent"] and s["state"] in ("closed", "failed") and s["outcome"] in ("succeeded", "failed")
                    and s["ack_seq"] <= s["closed_seq"]):
                items.add(("needs_review", "child_result_unviewed", s["task_id"], sid, None))
        return items


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

    covered = set()
    fixtures = sorted(FIXTURES_DIR.glob("*.jsonl"))
    if not fixtures:
        errors.append("no fixtures found")
    total_events = 0
    loaded = {}
    for path in fixtures:
        events = []
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError as exc:
                errors.append(f"{path.name}:{lineno}: invalid JSON: {exc}")
        loaded[path.name] = events
        run_errors, replay = run_stream(path.name, events, transitions, v, defs)
        errors += run_errors
        total_events += len(events)
        covered |= replay.covered

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
    if replay.recovery is not None:
        replay.errors.append(f"{name}: recovery never completed")
    return errors + replay.errors, replay


# --------------------------------------------------------------------------------------------
# Negative self-test: each mutation breaks one rule and must be rejected with a matching message.
# --------------------------------------------------------------------------------------------
def _find(events, etype, pred=lambda e: True, nth=0):
    hits = [i for i, e in enumerate(events) if e["type"] == etype and pred(e)]
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
    del ev[_find(ev, "approval.resolved", lambda e: e["payload"]["state"] == "invalidated")]
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


def _m_collapse_primary(ev):
    i = _find(ev, "session.collapsed")
    primary = next(e["session_id"] for e in ev if e["type"] == "session.created" and e["payload"]["role"] == "primary")
    ev[i]["session_id"] = primary
    return ev


def _m_collapse_before_ack(ev):
    i = _find(ev, "session.collapsed")
    j = _find(ev, "session.result_acknowledged")
    ev[i], ev[j] = ev[j], ev[i]
    return _renumber(ev)


def _m_quota_field(ev):
    i = _find(ev, "usage.reported")
    ev[i]["payload"]["usage"]["quota_remaining"] = 0.3
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


def _m_raw_secret_field(ev):
    i = _find(ev, "session.tool_call")
    ev[i]["payload"]["rawInput"] = {"cmd": "echo $TOKEN"}
    return ev


MUTATIONS = [
    ("01-happy-path-pr.jsonl", _m_gap, "cursor not gap-free"),
    ("01-happy-path-pr.jsonl", _m_illegal_transition, "illegal task transition"),
    ("01-happy-path-pr.jsonl", _m_collapse_primary, "never auto-collapsed"),
    ("01-happy-path-pr.jsonl", _m_collapse_before_ack, "auto-collapse requires"),
    ("01-happy-path-pr.jsonl", _m_quota_field, "quota_remaining"),
    ("01-happy-path-pr.jsonl", _m_unknown_usage_with_numbers, "must not match"),
    ("01-happy-path-pr.jsonl", _m_act_before_approval_persisted, "must be persisted before"),
    ("01-happy-path-pr.jsonl", _m_verify_with_failed_check, "local check cargo test is failed"),
    ("01-happy-path-pr.jsonl", _m_raw_secret_field, "rawInput"),
    ("04-disconnect-resume-reattach.jsonl", _m_load_without_capability, "without advertised load_session"),
    ("04-disconnect-resume-reattach.jsonl", _m_replay_outside_load, "acp_replay events are only valid"),
    ("05-quota-interrupt-auto-resume.jsonl", _m_early_auto_resume, "before retry_hint.not_before"),
    ("06-crash-unknown-push.jsonl", _m_rerun_push_after_crash, "executes at most once"),
    ("06-crash-unknown-push.jsonl", _m_recovery_starts_op, "never (re)starts"),
    ("06-crash-unknown-push.jsonl", _m_auto_resume_after_crash, "automatic resume without an armed auto_resume"),
    ("07-crash-pending-approval-load.jsonl", _m_recovery_approves, "approved cannot be decided by recovery"),
    ("07-crash-pending-approval-load.jsonl", _m_keep_pending_after_crash, "still pending"),
]


def self_test(loaded, transitions, v, defs):
    errors = []
    for fixture, mutate, expected in MUTATIONS:
        events = mutate(json.loads(json.dumps(loaded[fixture])))
        run_errors, _ = run_stream(fixture, events, transitions, v, defs)
        if not any(expected in e for e in run_errors):
            errors.append(f"self-test {mutate.__name__} on {fixture}: expected an error containing {expected!r}, "
                          f"got {run_errors[:3]}")
    return errors, len(MUTATIONS)


if __name__ == "__main__":
    sys.exit(main())
