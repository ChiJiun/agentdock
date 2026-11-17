#!/usr/bin/env python3
"""Regenerate docs/contracts/fixtures/*.jsonl, *.expected.json and models.sample.json.

The event streams are written with small helpers so that cursors, ids and timestamps stay
consistent. Expected final states and attention items are written by hand in each scenario
below (they are NOT computed from the events), so validate_fixtures.py is an independent check.

Usage:  python docs/contracts/generate_fixtures.py && python docs/contracts/validate_fixtures.py
Standard library only.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent / "fixtures"

USER = {"kind": "user", "id": "local-user"}
ORCH = {"kind": "orchestrator"}
POLICY = {"kind": "policy", "id": "policy.default"}
INTEG = {"kind": "integration", "id": "github"}
RECOV = {"kind": "recovery"}


def adapter(aid):
    return {"kind": "adapter", "id": aid}


def sha(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def caps(at, load=False, resume=False, close=True, list_=False):
    raw = {
        "loadSession": load,
        "promptCapabilities": {"image": True, "audio": False, "embeddedContext": True},
        "mcpCapabilities": {"http": True, "sse": False},
        "sessionCapabilities": {},
        "auth": {},
    }
    if resume:
        raw["sessionCapabilities"]["resume"] = {}
    if close:
        raw["sessionCapabilities"]["close"] = {}
    if list_:
        raw["sessionCapabilities"]["list"] = {}
    return {
        "protocol": "acp",
        "protocol_version": 1,
        "track": "v1_stable",
        "detected_at": at,
        "agent_info": {"name": "mock-acp-agent", "version": "0.1.0"},
        "auth_method_ids": [],
        "acp_agent_capabilities": raw,
        "features": {
            "load_session": load, "resume_session": resume, "close_session": close, "list_sessions": list_,
            "delete_session": False, "additional_directories": False, "system_prompt": False,
            "prompt_image": True, "prompt_audio": False, "prompt_embedded_context": True,
            "mcp_http": True, "mcp_sse": False, "logout": False,
        },
        "client_advertised": {"fs_read_text_file": True, "fs_write_text_file": True, "terminal": True},
        "unstable_opt_ins": [],
    }


class Fx:
    def __init__(self, num, slug, description):
        self.num, self.slug, self.description = num, slug, description
        self.events = []
        self.t = datetime(2026, 11, 17, 1, 0, 0, tzinfo=timezone.utc) + timedelta(hours=num)
        self.counters = {}
        self.project = self.id("prj")
        self.task_state, self.session_state, self.session_task = {}, {}, {}
        self.return_state = {}

    # -- primitives --------------------------------------------------------------------------
    def id(self, prefix):
        n = self.counters.get(prefix, 0) + 1
        self.counters[prefix] = n
        return f"{prefix}_01JDQ0{self.num:02d}{n:018d}"

    def now(self):
        return self.t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{self.t.microsecond // 1000:03d}Z"

    def at(self, hours=0.0, minutes=0.0):
        return (self.t + timedelta(hours=hours, minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    def emit(self, etype, actor, payload, task=None, session=None, provenance=None, rules=(), advance=1.0, jump_to=None):
        if jump_to:
            self.t = datetime.strptime(jump_to, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
        else:
            self.t += timedelta(seconds=advance)
        ev = {"schema_version": 1, "id": self.id("evt"), "authority_id": "local", "seq": len(self.events) + 1,
              "occurred_at": self.now(), "recorded_at": self.now()}
        if task:
            ev["project_id"] = self.project
            ev["task_id"] = task
        if session:
            ev["session_id"] = session
        ev.update({"type": etype, "actor": actor,
                   "provenance": provenance or ("recovery" if actor["kind"] == "recovery" else "live"),
                   "redaction": {"policy_version": 1, "applied_rules": list(rules)}, "payload": payload})
        self.events.append(ev)
        return ev["id"]

    # -- tasks -------------------------------------------------------------------------------
    def task(self, objective, quota=False, rate=False):
        tid = self.id("tsk")
        self.emit("task.created", USER, {"objective": objective, "state": "queued",
                                         "branch": f"agentdock/{tid[-4:]}",
                                         "auto_resume_policy": {"on_quota_reset": quota, "on_rate_limit": rate}}, task=tid)
        self.task_state[tid] = "queued"
        return tid

    def tr(self, tid, to, trigger, actor=ORCH, **extra):
        frm = self.task_state[tid]
        payload = {"from": frm, "to": to, "trigger": trigger, **extra}
        if to == "awaiting_approval":
            self.return_state[tid] = frm
            payload["return_state"] = frm
        self.emit("task.state_changed", actor, payload, task=tid)
        self.task_state[tid] = to

    def interrupt(self, tid, reason, actor, armed=False, hint=None, summary=None, ops=None, approval=None):
        intr = {"reason": reason, "auto_resume_armed": armed}
        if hint:
            intr["retry_hint"] = hint
        if summary:
            intr["summary_id"] = summary
        if ops:
            intr["open_operation_ids"] = ops
        extra = {"approval_id": approval} if approval else {}
        self.tr(tid, "interrupted", "interruption", actor, interruption=intr, **extra)

    def checkpoint(self, tid, head="1" * 40, dirty=False, ops=(), approvals=()):
        self.emit("task.checkpoint_recorded", ORCH, {
            "checkpoint_id": self.id("cpt"), "phase": self.task_state[tid], "through_seq": len(self.events),
            "worktree": {"head_sha": head, "branch": f"agentdock/{tid[-4:]}", "dirty": dirty},
            "open_operation_ids": list(ops), "pending_approval_ids": list(approvals)}, task=tid)

    def ack_task(self, tid):
        self.emit("task.outcome_acknowledged", USER, {"acknowledged_state": self.task_state[tid]}, task=tid)

    # -- sessions ----------------------------------------------------------------------------
    def session(self, tid, role="primary", adapter_id="claude-code", method="new", parent=None, external=None,
                supersedes=None, handoff=None, load=False, resume=False):
        sid = self.id("ses")
        p = {"role": role, "adapter_id": adapter_id, "launch_method": method}
        for k, v in (("parent_session_id", parent), ("external_session_id", external),
                     ("supersedes_session_id", supersedes), ("handoff_summary_id", handoff)):
            if v:
                p[k] = v
        self.emit("session.created", ORCH, p, task=tid, session=sid)
        self.session_state[sid], self.session_task[sid] = "starting", tid
        self.adapters = getattr(self, "adapters", {})
        self.adapters[sid] = adapter_id
        self.caps(sid, load=load, resume=resume)
        return sid

    def caps(self, sid, load=False, resume=False):
        self.emit("session.capabilities_detected", adapter(self.adapters[sid]),
                  {"snapshot": caps(self.at(), load=load, resume=resume)}, task=self.session_task[sid], session=sid)

    def sst(self, sid, to, trigger, actor=None, **extra):
        frm = self.session_state[sid]
        actor = actor or adapter(self.adapters[sid])
        self.emit("session.state_changed", actor, {"from": frm, "to": to, "trigger": trigger, **extra},
                  task=self.session_task[sid], session=sid)
        self.session_state[sid] = to

    def ready(self, sid):
        self.sst(sid, "idle", "session_ready", external_session_id=f"acp-{sid[-6:]}")

    def prompt(self, sid, text, origin="user", handoff=None):
        turn = self.id("trn")
        p = {"turn_id": turn, "origin": origin, "content": {"text": text}}
        if handoff:
            p["handoff_summary_id"] = handoff
        actor = USER if origin == "user" else ORCH
        self.emit("session.prompt_submitted", actor, p, task=self.session_task[sid], session=sid)
        if self.session_state[sid] == "suspended":
            self.sst(sid, "active", "continue_prompt", actor, turn_id=turn)
        else:
            self.sst(sid, "active", "prompt_submitted", actor, turn_id=turn)
        return turn

    def say(self, sid, turn, text, channel="agent_message", rules=(), provenance=None):
        p = {"channel": channel, "content": {"text": text}, "coalesced_chunks": 3}
        if turn:
            p["turn_id"] = turn
        self.emit("session.message_delta", adapter(self.adapters[sid]), p,
                  task=self.session_task[sid], session=sid, rules=rules, provenance=provenance)

    def end_turn(self, sid, turn, stop="end_turn"):
        self.sst(sid, "idle", "turn_ended", turn_id=turn, stop_reason=stop)

    def close(self, sid, outcome, trigger="session_closed", actor=ORCH):
        self.sst(sid, "closed", trigger, actor, outcome=outcome)

    def usage(self, sid, source, **fields):
        u = {"usage_id": self.id("use"), "task_id": self.session_task[sid], "session_id": sid,
             "source": source, "measured_at": self.at(), **fields}
        self.emit("usage.reported", adapter(self.adapters[sid]) if source == "provider_reported" else ORCH,
                  {"usage": u}, task=self.session_task[sid], session=sid)

    def summary(self, sid, purpose, text, source="host_generated"):
        sumid = self.id("sum")
        actor = adapter(self.adapters[sid]) if source == "agent_generated" else ORCH
        self.emit("session.summary_recorded", actor, {"summary_id": sumid, "source": source, "purpose": purpose,
                                                       "through_seq": len(self.events), "content": {"text": text}},
                  task=self.session_task[sid], session=sid)
        return sumid

    # -- approvals ---------------------------------------------------------------------------
    def acp_permission(self, sid, turn, title, call_id):
        tid = self.session_task[sid]
        ad = adapter(self.adapters[sid])
        self.emit("session.tool_call", ad, {"turn_id": turn, "tool_call_id": call_id, "title": title,
                                            "kind": "execute", "status": "pending"}, task=tid, session=sid)
        aid = self.id("apr")
        self.emit("approval.requested", ad, {
            "approval_id": aid, "source": "acp_permission", "operation_kind": "tool_call",
            "operation_fingerprint": sha({"kind": "tool_call", "tool_call_id": call_id, "title": title}),
            "title": title, "scope": "once", "return_state": "running",
            "acp": {"tool_call_id": call_id, "options": [
                {"option_id": "allow", "kind": "allow_once"}, {"option_id": "always", "kind": "allow_always"},
                {"option_id": "reject", "kind": "reject_once"}]}}, task=tid, session=sid)
        self.sst(sid, "awaiting_permission", "permission_requested", approval_id=aid)
        self.tr(tid, "awaiting_approval", "approval_requested", ad, approval_id=aid)
        return aid

    def resolve_acp(self, sid, aid, approve=True):
        tid = self.session_task[sid]
        self.emit("approval.resolved", USER, {"approval_id": aid, "state": "approved" if approve else "denied",
                                              "scope": "once", "acp_outcome": {"outcome": "selected",
                                                                                "option_id": "allow" if approve else "reject"}},
                  task=tid, session=sid)
        self.sst(sid, "active", "permission_resolved", USER, approval_id=aid)
        self.tr(tid, "running", "approval_resolved", USER, approval_id=aid)

    def host_op(self, tid, kind, target, strategy, supersedes=None):
        oid, aid = self.id("op"), self.id("apr")
        key = sha({"kind": kind, "target": target})
        p = {"operation_id": oid, "kind": kind, "repeatability": "non_repeatable", "idempotency_key": key,
             "target": target, "approval_id": aid, "reconcile_strategy": strategy}
        if supersedes:
            p["supersedes_operation_id"] = supersedes
        self.emit("operation.recorded", ORCH, p, task=tid)
        self.emit("approval.requested", POLICY, {
            "approval_id": aid, "source": "host_policy", "operation_kind": kind, "operation_fingerprint": key,
            "operation_id": oid, "title": target["description"], "scope": "once",
            "return_state": self.task_state[tid]}, task=tid)
        self.tr(tid, "awaiting_approval", "approval_requested", POLICY, approval_id=aid)
        return oid, aid

    def approve_op(self, tid, aid):
        self.emit("approval.resolved", USER, {"approval_id": aid, "state": "approved", "scope": "once"}, task=tid)
        self.tr(tid, self.return_state[tid], "approval_resolved", USER, approval_id=aid)

    def run_op(self, tid, oid, aid, result=None):
        self.emit("operation.started", ORCH, {"operation_id": oid, "approval_id": aid}, task=tid)
        if result is not None:
            self.emit("operation.succeeded", INTEG, {"operation_id": oid, "result": result}, task=tid)

    # -- checks ------------------------------------------------------------------------------
    def check(self, tid, name, origin="local", state="passed", finish=True):
        cid = self.id("chk")
        p = {"check_id": cid, "name": name, "origin": origin}
        if origin == "local":
            p.update({"command": ["cargo", "test", "--workspace"], "cwd": "."})
        else:
            p["external_url"] = "https://github.com/example/repo/actions/runs/1"
        self.emit("check.started", ORCH if origin == "local" else INTEG, p, task=tid)
        if finish:
            self.finish_check(tid, cid, state, INTEG if origin == "ci" else ORCH)
        return cid

    def finish_check(self, tid, cid, state, actor=ORCH):
        p = {"check_id": cid, "state": state}
        if state in ("passed", "failed"):
            p.update({"exit_code": 0 if state == "passed" else 1, "duration_ms": 41000})
        self.emit("check.finished", actor, p, task=tid)

    # -- composite ---------------------------------------------------------------------------
    def drive_to(self, tid, phase, adapter_id="claude-code"):
        """queued -> ... -> phase on the happy path. Returns the primary session id."""
        self.tr(tid, "preparing", "scheduled")
        sid = self.session(tid, adapter_id=adapter_id)
        self.ready(sid)
        self.tr(tid, "running", "session_ready")
        if phase == "running":
            return sid
        turn = self.prompt(sid, "Implement the objective.")
        self.say(sid, turn, "Implemented the change and added tests.")
        self.end_turn(sid, turn)
        self.tr(tid, "verifying", "implementation_done")
        self.checkpoint(tid, dirty=True)
        if phase == "verifying":
            return sid
        self.check(tid, "cargo test")
        self.tr(tid, "review", "checks_passed")
        if phase == "review":
            return sid
        self.tr(tid, "pr", "review_passed", USER)
        if phase == "pr":
            return sid
        self.push_and_pr(tid)
        self.tr(tid, "ci", "pr_published", INTEG)
        return sid

    def push_and_pr(self, tid, head="2" * 40):
        branch = f"agentdock/{tid[-4:]}"
        oid, aid = self.host_op(tid, "git_push", {"description": f"push {branch} to origin", "remote": "origin",
                                                   "ref": f"refs/heads/{branch}", "expected_sha": head}, "remote_ref_compare")
        self.approve_op(tid, aid)
        self.run_op(tid, oid, aid, {"remote_sha": head})
        oid, aid = self.host_op(tid, "pr_create", {"description": f"open PR from {branch} into main", "ref": branch},
                                "pr_lookup_by_head")
        self.approve_op(tid, aid)
        self.run_op(tid, oid, aid, {"pr_number": 42, "url": "https://github.com/example/repo/pull/42"})

    # -- output ------------------------------------------------------------------------------
    def write(self, final_tasks, final_sessions, attention):
        name = f"{self.num:02d}-{self.slug}"
        (OUT / f"{name}.jsonl").write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in self.events),
                                          encoding="utf-8", newline="\n")
        exp = {"fixture": f"{name}.jsonl", "description": self.description,
               "final_task_states": final_tasks, "final_session_states": final_sessions, "attention": attention}
        (OUT / f"{name}.expected.json").write_text(json.dumps(exp, indent=2, ensure_ascii=False) + "\n",
                                                   encoding="utf-8", newline="\n")


def att(kind, reason, task, session=None, ref=None):
    item = {"kind": kind, "reason": reason, "task_id": task}
    if session:
        item["session_id"] = session
    if ref:
        item["ref_id"] = ref
    return item


# ============================================================================================
# Scenarios
# ============================================================================================
def f01():
    fx = Fx(1, "happy-path-pr", "Full Issue -> PR -> CI flow with an ACP permission, a host-policy push/PR approval, "
            "a review child session that is acknowledged then auto-collapsed, and three usage sources.")
    t = fx.task("Add retry to the HTTP client (issue #12)")
    fx.tr(t, "preparing", "scheduled")
    p = fx.session(t)
    fx.ready(p)
    fx.tr(t, "running", "session_ready")
    turn = fx.prompt(p, "Implement issue #12.")
    fx.emit("session.plan_updated", adapter("claude-code"), {"entries": [
        {"content": "Add retry policy", "priority": "high", "status": "in_progress"},
        {"content": "Add tests", "priority": "medium", "status": "pending"}]}, task=t, session=p)
    fx.say(p, turn, "Config uses token [REDACTED:api_key] from env; not logged.", rules=["api_key"])
    a = fx.acp_permission(p, turn, "Run cargo test", "call-1")
    fx.resolve_acp(p, a, approve=True)
    fx.emit("session.tool_call", adapter("claude-code"), {"turn_id": turn, "tool_call_id": "call-1", "status": "completed",
                                                         "approval_id": a}, task=t, session=p)
    fx.usage(p, "provider_reported", reporter="acp_usage_update", scope="cumulative",
             context_window={"used": 48210, "size": 200000}, cost={"amount": 0.42, "unit": "USD", "basis": "reported"})
    fx.usage(p, "locally_estimated", reporter="host_estimator", scope="increment", turn_id=turn,
             tokens={"input": 12000, "output": 3100}, estimator={"id": "tiktoken-approx", "version": "1"})
    fx.end_turn(p, turn)
    fx.tr(t, "verifying", "implementation_done")
    fx.checkpoint(t, dirty=True)
    fx.check(t, "cargo test")
    fx.tr(t, "review", "checks_passed")
    r = fx.session(t, role="review", adapter_id="codex", parent=p)
    fx.ready(r)
    rt = fx.prompt(r, "Review the diff independently.", origin="orchestrator")
    fx.say(r, rt, "No blocking findings.")
    fx.usage(r, "unknown", reporter="none", scope="snapshot")
    fx.end_turn(r, rt)
    fx.close(r, "succeeded")
    fx.tr(t, "pr", "review_passed")
    fx.push_and_pr(t)
    fx.tr(t, "ci", "pr_published", INTEG)
    fx.check(t, "ci / build", origin="ci")
    fx.tr(t, "completed", "ci_passed_accepted", USER)
    fx.close(p, "succeeded")
    fx.emit("session.result_acknowledged", USER, {}, task=t, session=r)
    fx.emit("session.collapsed", ORCH, {"by": "auto"}, task=t, session=r)
    fx.write({t: "completed"}, {p: "closed", r: "closed"},
             [att("needs_review", "task_outcome_unviewed", t)])


def f02():
    fx = Fx(2, "approval-denied", "ACP permission denied: the tool call never runs, the agent continues, "
            "then the user cancels the running task; a second task is cancelled while still queued.")
    t = fx.task("Clean up build artifacts")
    p = fx.drive_to(t, "running")
    turn = fx.prompt(p, "Remove stale build output.")
    a = fx.acp_permission(p, turn, "rm -rf ../shared-cache", "call-9")
    fx.resolve_acp(p, a, approve=False)
    fx.emit("session.tool_call", adapter("claude-code"), {"turn_id": turn, "tool_call_id": "call-9", "status": "failed",
                                                         "approval_id": a}, task=t, session=p)
    fx.say(p, turn, "Permission denied; I will only clean inside the workspace. Should I proceed?")
    fx.end_turn(p, turn)
    turn2 = fx.prompt(p, "No, stop here.")
    fx.tr(t, "cancelled", "user_cancel", USER)
    fx.end_turn(p, turn2, stop="cancelled")
    fx.close(p, "cancelled")
    q = fx.task("Unstarted follow-up")
    fx.tr(q, "cancelled", "user_cancel", USER)
    fx.write({t: "cancelled", q: "cancelled"}, {p: "closed"}, [])


def f03():
    fx = Fx(3, "cancel-during-approval", "User cancels while an ACP permission is pending: the pending request is "
            "answered 'cancelled' before the task is cancelled; a second task is cancelled while preparing.")
    t = fx.task("Rewrite the release script")
    p = fx.drive_to(t, "running")
    turn = fx.prompt(p, "Rewrite scripts/release.sh.")
    a = fx.acp_permission(p, turn, "Edit scripts/release.sh", "call-3")
    fx.emit("approval.resolved", USER, {"approval_id": a, "state": "cancelled", "acp_outcome": {"outcome": "cancelled"}},
            task=t, session=p)
    fx.tr(t, "cancelled", "user_cancel", USER, approval_id=a)
    fx.end_turn(p, turn, stop="cancelled")
    fx.close(p, "cancelled")
    u = fx.task("Second task")
    fx.tr(u, "preparing", "scheduled")
    s = fx.session(u)
    fx.tr(u, "cancelled", "user_cancel", USER)
    fx.sst(s, "failed", "launch_failed", ORCH, outcome="cancelled")
    fx.write({t: "cancelled", u: "cancelled"}, {p: "closed", s: "failed"}, [])


def f04():
    fx = Fx(4, "disconnect-resume-reattach", "Agent process exits mid-turn; the user resumes; the adapter advertised "
            "sessionCapabilities.resume so the same session is reattached; checks fail twice and the task fails.")
    t = fx.task("Fix flaky parser test")
    fx.tr(t, "preparing", "scheduled")
    p = fx.session(t, resume=True)
    fx.ready(p)
    fx.tr(t, "running", "session_ready")
    turn = fx.prompt(p, "Fix the flaky test.")
    fx.say(p, turn, "Investigating...")
    fx.sst(p, "disconnected", "process_exited")
    s1 = fx.summary(p, "interruption", "Host summary: parser.rs edited, no tests run, no open operations.")
    fx.interrupt(t, "adapter_disconnected", adapter("claude-code"), summary=s1)
    fx.tr(t, "queued", "resume_requested", USER, resume_phase="running")
    fx.tr(t, "preparing", "scheduled")
    fx.sst(p, "starting", "reattach_attempt", ORCH, launch_method="resume")
    fx.caps(p, resume=True)
    fx.ready(p)
    fx.tr(t, "running", "session_ready")
    turn = fx.prompt(p, "Continue fixing the flaky test.")
    fx.end_turn(p, turn)
    fx.tr(t, "verifying", "implementation_done")
    fx.check(t, "cargo test", state="failed")
    fx.tr(t, "running", "checks_failed")
    turn = fx.prompt(p, "Tests still fail; fix them.", origin="orchestrator")
    fx.end_turn(p, turn)
    fx.tr(t, "verifying", "implementation_done")
    fx.check(t, "cargo test", state="failed")
    fx.tr(t, "failed", "repair_limit_reached", failure={"code": "repair_limit_reached", "message": "2 repair rounds"})
    fx.close(p, "failed")
    fx.write({t: "failed"}, {p: "closed"}, [att("needs_reply", "failure_needs_decision", t)])


def f05():
    fx = Fx(5, "quota-interrupt-auto-resume", "Quota exhausted mid-turn: host-written summary, auto-resume armed from a "
            "provider-reported reset time; the agent process dies while waiting and has no load/resume, so the task "
            "restarts with a new session seeded by the summary. Plus one task waiting for reset and one needing a decision.")
    t = fx.task("Port config loader to TOML", quota=True)
    p = fx.drive_to(t, "running")
    turn = fx.prompt(p, "Port the config loader.")
    fx.say(p, turn, "Started porting loader.rs")
    fx.usage(p, "provider_reported", reporter="acp_usage_update", scope="cumulative",
             context_window={"used": 150000, "size": 200000}, cost={"amount": 37, "unit": "credits", "basis": "reported"})
    s1 = fx.summary(p, "interruption", "Host summary: loader.rs half-ported; tests not run; no open operations.")
    fx.sst(p, "suspended", "task_interrupted")
    reset = fx.at(hours=5)
    fx.interrupt(t, "quota_exhausted", adapter("claude-code"), armed=True, summary=s1,
                 hint={"not_before": reset, "source": "provider_reported", "detail": "Usage limit reached; resets at 15:00 UTC"})
    fx.usage(p, "unknown", reporter="none", scope="snapshot")
    fx.sst(p, "disconnected", "process_exited")
    fx.emit("task.state_changed", ORCH, {"from": "interrupted", "to": "queued", "trigger": "scheduled_resume",
                                         "resume_phase": "running"}, task=t, jump_to=reset)
    fx.task_state[t] = "queued"
    fx.tr(t, "preparing", "scheduled")
    fx.close(p, "superseded", trigger="superseded")
    p2 = fx.session(t, supersedes=p, handoff=s1)
    fx.ready(p2)
    fx.tr(t, "running", "session_ready")
    fx.prompt(p2, "Continue from the summary.", origin="handoff", handoff=s1)
    b = fx.task("Needs login")
    fx.tr(b, "preparing", "scheduled")
    fx.interrupt(b, "auth_required", adapter("codex"), hint={"source": "unknown"})
    c = fx.task("Queued behind quota", quota=True)
    fx.tr(c, "preparing", "scheduled")
    fx.interrupt(c, "quota_exhausted", adapter("claude-code"), armed=True,
                 hint={"not_before": fx.at(hours=4), "source": "user_configured"})
    fx.write({t: "running", b: "interrupted", c: "interrupted"}, {p: "closed", p2: "active"},
             [att("background", "agent_working", t, p2),
              att("needs_reply", "interruption_needs_decision", b),
              att("background", "waiting_for_reset", c)])


def f06():
    fx = Fx(6, "crash-unknown-push", "Host crashes after git push started: recovery marks the push outcome_unknown and "
            "interrupts the task; on resume the push is reconciled (found applied) instead of re-run; CI fails and a "
            "new repair session starts because the adapter cannot reattach.")
    t = fx.task("Bump dependency versions")
    p = fx.drive_to(t, "pr")
    branch = f"agentdock/{t[-4:]}"
    target = {"description": f"push {branch} to origin", "remote": "origin", "ref": f"refs/heads/{branch}",
              "expected_sha": "3" * 40}
    oid, aid = fx.host_op(t, "git_push", target, "remote_ref_compare")
    fx.approve_op(t, aid)
    fx.checkpoint(t, ops=[oid])
    fx.run_op(t, oid, aid)
    fx.emit("system.recovery_started", RECOV, {"previous_run_id": "run-7", "last_seq_before_crash": len(fx.events)})
    fx.sst(p, "disconnected", "host_recovery", RECOV)
    fx.emit("operation.outcome_unknown", RECOV, {"operation_id": oid}, task=t)
    fx.interrupt(t, "host_crashed", RECOV, ops=[oid])
    fx.emit("system.recovery_completed", RECOV, {"tasks_interrupted": [t], "sessions_disconnected": [p],
                                                 "approvals_invalidated": [], "operations_marked_unknown": [oid],
                                                 "checks_marked_unknown": []})
    fx.tr(t, "queued", "resume_requested", USER, resume_phase="pr")
    fx.tr(t, "preparing", "scheduled")
    fx.emit("operation.reconciled", INTEG, {"operation_id": oid, "finding": "applied",
                                            "evidence": "origin " + target["ref"] + " == expected_sha"}, task=t)
    fx.tr(t, "pr", "resume_phase_restored", resume_phase="pr")
    oid2, aid2 = fx.host_op(t, "pr_create", {"description": f"open PR from {branch} into main", "ref": branch},
                            "pr_lookup_by_head")
    fx.approve_op(t, aid2)
    fx.run_op(t, oid2, aid2, {"pr_number": 43})
    fx.tr(t, "ci", "pr_published", INTEG)
    fx.check(t, "ci / test", origin="ci", state="failed")
    fx.tr(t, "running", "ci_failed")
    fx.close(p, "abandoned", trigger="abandoned")
    r = fx.session(t, role="repair", supersedes=p)
    fx.ready(r)
    turn = fx.prompt(r, "CI failed on test_x; fix it.", origin="orchestrator")
    fx.say(r, turn, "Fixed. Do you want me to also update the changelog?")
    fx.end_turn(r, turn)
    fx.write({t: "running"}, {p: "closed", r: "idle"}, [att("needs_reply", "agent_turn_ended", t, r)])


def f07():
    fx = Fx(7, "crash-pending-approval-load", "Host crashes while an ACP permission is pending: recovery invalidates it "
            "(never auto-approves). On resume the adapter advertised loadSession, so the session is reattached with "
            "session/load and replayed history is tagged acp_replay. The agent must ask again; later the user cancels "
            "during verification.")
    t = fx.task("Migrate logging to tracing")
    fx.tr(t, "preparing", "scheduled")
    p = fx.session(t, load=True)
    fx.ready(p)
    fx.tr(t, "running", "session_ready")
    turn = fx.prompt(p, "Migrate logging.")
    a = fx.acp_permission(p, turn, "Run cargo fmt", "call-2")
    fx.emit("system.recovery_started", RECOV, {"previous_run_id": "run-3", "last_seq_before_crash": len(fx.events)})
    fx.emit("approval.resolved", RECOV, {"approval_id": a, "state": "invalidated"}, task=t, session=p)
    fx.sst(p, "disconnected", "host_recovery", RECOV)
    fx.interrupt(t, "host_crashed", RECOV, approval=a)
    fx.emit("system.recovery_completed", RECOV, {"tasks_interrupted": [t], "sessions_disconnected": [p],
                                                 "approvals_invalidated": [a], "operations_marked_unknown": [],
                                                 "checks_marked_unknown": []})
    fx.tr(t, "queued", "resume_requested", USER, resume_phase="running")
    fx.tr(t, "preparing", "scheduled")
    fx.sst(p, "starting", "reattach_attempt", ORCH, launch_method="load")
    fx.caps(p, load=True)
    fx.say(p, turn, "Migrate logging.", channel="user_message", provenance="acp_replay")
    fx.say(p, turn, "Migrating log macros...", provenance="acp_replay")
    fx.ready(p)
    fx.tr(t, "running", "session_ready")
    turn = fx.prompt(p, "Continue; ask again for anything you need.")
    a2 = fx.acp_permission(p, turn, "Run cargo fmt", "call-7")
    fx.resolve_acp(p, a2, approve=True)
    fx.end_turn(p, turn)
    fx.tr(t, "verifying", "implementation_done")
    c = fx.check(t, "cargo test", finish=False)
    fx.tr(t, "cancelled", "user_cancel", USER)
    fx.finish_check(t, c, "cancelled")
    fx.close(p, "cancelled")
    fx.write({t: "cancelled"}, {p: "closed"}, [])


def f08():
    fx = Fx(8, "review-loop-pause-children", "Primary session with explore and review child sessions: blocking review "
            "sends the task back to running; the acknowledged child is auto-collapsed while unacknowledged children "
            "stay visible; the user pauses and resumes into review; the reviewer crashes, the task fails, the user "
            "retries and the suspended primary session continues.")
    t = fx.task("Introduce plugin registry")
    fx.tr(t, "preparing", "scheduled")
    p = fx.session(t)
    fx.ready(p)
    fx.tr(t, "running", "session_ready")
    e = fx.session(t, role="explore", adapter_id="codex", parent=p)
    fx.ready(e)
    et = fx.prompt(e, "Map existing extension points.", origin="orchestrator")
    fx.end_turn(e, et)
    fx.close(e, "succeeded")
    turn = fx.prompt(p, "Implement the registry.")
    fx.end_turn(p, turn)
    fx.tr(t, "verifying", "implementation_done")
    fx.check(t, "cargo test")
    fx.tr(t, "review", "checks_passed")
    r1 = fx.session(t, role="review", adapter_id="codex", parent=p)
    fx.ready(r1)
    rt = fx.prompt(r1, "Review independently.", origin="orchestrator")
    fx.say(r1, rt, "Blocking: registry is not thread-safe.")
    fx.end_turn(r1, rt)
    fx.close(r1, "succeeded")
    fx.tr(t, "running", "review_blocking_findings")
    fx.emit("session.result_acknowledged", USER, {}, task=t, session=r1)
    fx.emit("session.collapsed", ORCH, {"by": "auto"}, task=t, session=r1)
    turn = fx.prompt(p, "Address the blocking finding.", origin="orchestrator")
    fx.end_turn(p, turn)
    fx.tr(t, "verifying", "implementation_done")
    fx.check(t, "cargo test")
    fx.tr(t, "review", "checks_passed")
    fx.interrupt(t, "user_paused", USER)
    fx.sst(p, "suspended", "task_interrupted", USER)
    fx.tr(t, "queued", "resume_requested", USER, resume_phase="review")
    fx.tr(t, "preparing", "scheduled")
    fx.tr(t, "review", "resume_phase_restored", resume_phase="review")
    r2 = fx.session(t, role="review", adapter_id="codex", parent=p)
    fx.ready(r2)
    rt2 = fx.prompt(r2, "Review again.", origin="orchestrator")
    fx.sst(r2, "failed", "protocol_error", outcome="failed", error={"code": "invalid_json_rpc"})
    fx.tr(t, "failed", "repair_limit_reached", failure={"code": "reviewer_unavailable"})
    fx.tr(t, "queued", "retry_requested", USER)
    fx.tr(t, "preparing", "scheduled")
    fx.tr(t, "running", "session_ready")
    fx.prompt(p, "Resume where you left off.")
    fx.write({t: "running"}, {p: "active", e: "closed", r1: "closed", r2: "failed"},
             [att("background", "agent_working", t, p),
              att("needs_review", "child_result_unviewed", t, e),
              att("needs_review", "child_result_unviewed", t, r2)])


def f09():
    fx = Fx(9, "pr-ci-edges", "PR and CI phase edges: PR creation rejected, merge approval from CI, integration outage "
            "and resume straight into CI, CI repair limit, cancellation in PR/CI/review, and completion without a PR.")
    a = fx.task("A: PR creation rejected")
    pa = fx.drive_to(a, "pr")
    branch = f"agentdock/{a[-4:]}"
    oid, aid = fx.host_op(a, "pr_create", {"description": f"open PR from {branch}", "ref": branch}, "pr_lookup_by_head")
    fx.approve_op(a, aid)
    fx.run_op(a, oid, aid)
    fx.emit("operation.failed", INTEG, {"operation_id": oid, "error": {"code": "http_403", "message": "Resource not accessible"},
                                        "effect": "none"}, task=a)
    fx.tr(a, "failed", "operation_failed", INTEG, failure={"code": "pr_create_forbidden"})
    fx.ack_task(a)

    b = fx.task("B: merge after CI with outage")
    pb = fx.drive_to(b, "ci")
    c1 = fx.check(b, "ci / build", origin="ci", finish=False)
    fx.finish_check(b, c1, "errored", INTEG)
    fx.interrupt(b, "integration_unavailable", INTEG, hint={"source": "unknown"})
    fx.tr(b, "queued", "resume_requested", USER, resume_phase="ci")
    fx.tr(b, "preparing", "scheduled")
    fx.tr(b, "ci", "resume_phase_restored", resume_phase="ci")
    fx.check(b, "ci / build", origin="ci")
    oid, aid = fx.host_op(b, "pr_merge", {"description": "merge PR #42 with a merge commit", "pr_number": 42},
                          "pr_state_lookup")
    fx.approve_op(b, aid)
    fx.run_op(b, oid, aid, {"pr_number": 42})
    fx.tr(b, "completed", "ci_passed_accepted", INTEG)
    fx.ack_task(b)

    c = fx.task("C: CI keeps failing")
    pc = fx.drive_to(c, "ci")
    fx.check(c, "ci / test", origin="ci", state="failed")
    fx.tr(c, "failed", "repair_limit_reached", failure={"code": "repair_limit_reached"})
    fx.ack_task(c)

    d = fx.task("D: cancelled in CI")
    pd = fx.drive_to(d, "ci")
    fx.tr(d, "cancelled", "user_cancel", USER)

    e = fx.task("E: cancelled in PR")
    pe = fx.drive_to(e, "pr")
    fx.tr(e, "cancelled", "user_cancel", USER)

    f = fx.task("F: cancelled in review")
    pf = fx.drive_to(f, "review")
    fx.tr(f, "cancelled", "user_cancel", USER)

    g = fx.task("G: local-only change accepted without PR")
    pg = fx.drive_to(g, "review")
    fx.tr(g, "completed", "accepted_without_pr", USER)
    for s in (pa, pb, pc, pd, pe, pf, pg):
        fx.close(s, "succeeded")
    fx.write({a: "failed", b: "completed", c: "failed", d: "cancelled", e: "cancelled", f: "cancelled", g: "completed"},
             {s: "closed" for s in (pa, pb, pc, pd, pe, pf, pg)},
             [att("needs_review", "task_outcome_unviewed", g)])


def f10():
    fx = Fx(10, "prepare-pause-abandon", "Preparation and interruption edges: agent exits during startup, a policy stop "
            "while running, pause during verification then abandon, pause then cancel, and resume straight into verifying.")
    a = fx.task("A: agent exits on startup")
    fx.tr(a, "preparing", "scheduled")
    sa = fx.session(a)
    fx.sst(sa, "disconnected", "process_exited")
    fx.tr(a, "failed", "preparation_failed", failure={"code": "agent_exited_on_start"})
    fx.close(sa, "abandoned", trigger="abandoned")

    b = fx.task("B: policy stop")
    sb = fx.drive_to(b, "running")
    turn = fx.prompt(sb, "Tidy the repo.")
    fx.emit("session.tool_call", adapter("claude-code"), {"turn_id": turn, "tool_call_id": "call-4", "kind": "delete",
                                                         "status": "pending", "locations": ["[REDACTED:home_path]/.ssh"]},
            task=b, session=sb, rules=["home_path"])
    fx.tr(b, "failed", "unrecoverable_error", POLICY, failure={"code": "workspace_escape_attempt"})
    fx.end_turn(sb, turn, stop="cancelled")
    fx.close(sb, "failed")

    c = fx.task("C: paused in verifying then abandoned")
    sc = fx.drive_to(c, "verifying")
    fx.interrupt(c, "user_paused", USER)
    fx.sst(sc, "suspended", "task_interrupted", USER)
    fx.tr(c, "failed", "abandoned", USER, failure={"code": "abandoned_by_user"})
    fx.close(sc, "abandoned")
    fx.ack_task(c)

    d = fx.task("D: paused then cancelled")
    sd = fx.drive_to(d, "running")
    fx.interrupt(d, "user_paused", USER)
    fx.sst(sd, "suspended", "task_interrupted", USER)
    fx.tr(d, "cancelled", "user_cancel", USER)
    fx.close(sd, "cancelled", actor=USER)

    e = fx.task("E: resume directly into verifying")
    se = fx.drive_to(e, "verifying")
    fx.interrupt(e, "user_paused", USER)
    fx.sst(se, "suspended", "task_interrupted", USER)
    fx.tr(e, "queued", "resume_requested", USER, resume_phase="verifying")
    fx.tr(e, "preparing", "scheduled")
    fx.tr(e, "verifying", "resume_phase_restored", resume_phase="verifying")
    fx.check(e, "cargo test")
    fx.tr(e, "review", "checks_passed")
    fx.write({a: "failed", b: "failed", c: "failed", d: "cancelled", e: "review"},
             {sa: "closed", sb: "closed", sc: "closed", sd: "closed", se: "suspended"},
             [att("needs_reply", "failure_needs_decision", a),
              att("needs_reply", "failure_needs_decision", b),
              att("background", "workflow_step", e)])


def samples():
    fx = Fx(99, "samples", "")
    prj, tsk, ses, child = fx.project, fx.id("tsk"), fx.id("ses"), fx.id("ses")
    apr, op, chk, use, sumid = fx.id("apr"), fx.id("op"), fx.id("chk"), fx.id("use"), fx.id("sum")
    key = sha({"kind": "git_push", "target": "origin refs/heads/agentdock/x"})
    ts = "2026-11-17T10:00:00.000Z"
    doc = {
        "projects": [{"project_id": prj, "name": "agentdock", "local_path": "D:/Code/agentdock", "environment_id": "local",
                      "remote_origin": "https://github.com/example/agentdock.git", "default_branch": "main", "created_at": ts}],
        "tasks": [{"task_id": tsk, "project_id": prj, "objective": "Example", "state": "interrupted",
                   "branch": "agentdock/x", "primary_session_id": ses,
                   "interruption": {"reason": "quota_exhausted", "auto_resume_armed": True, "summary_id": sumid,
                                    "retry_hint": {"not_before": "2026-11-17T15:00:00.000Z", "source": "provider_reported"}},
                   "auto_resume_policy": {"on_quota_reset": True, "on_rate_limit": False},
                   "created_at": ts, "updated_at": ts, "last_seq": 42}],
        "sessions": [
            {"session_id": ses, "task_id": tsk, "role": "primary", "adapter_id": "claude-code", "state": "suspended",
             "external_session_id": "acp-abc", "launch_method": "new", "capability_snapshot": caps(ts),
             "collapsed": False, "created_at": ts},
            {"session_id": child, "task_id": tsk, "parent_session_id": ses, "role": "review", "adapter_id": "codex",
             "state": "closed", "launch_method": "new", "outcome": "succeeded", "result_acknowledged_at": ts,
             "collapsed": True, "collapsed_by": "auto", "created_at": ts, "closed_at": ts}],
        "approvals": [{"approval_id": apr, "task_id": tsk, "source": "host_policy", "state": "approved",
                       "operation_kind": "git_push", "operation_fingerprint": key, "operation_id": op,
                       "title": "push agentdock/x", "scope": "once", "return_state": "pr", "requested_at": ts,
                       "decided_at": ts, "decided_by": USER}],
        "operations": [{"operation_id": op, "task_id": tsk, "kind": "git_push", "repeatability": "non_repeatable",
                        "idempotency_key": key, "target": {"description": "push agentdock/x", "remote": "origin",
                                                           "ref": "refs/heads/agentdock/x"},
                        "approval_id": apr, "reconcile_strategy": "remote_ref_compare", "state": "reconciled_applied",
                        "attempt_count": 1}],
        "checks": [{"check_id": chk, "task_id": tsk, "name": "cargo test", "origin": "local", "state": "passed",
                    "command": ["cargo", "test"], "cwd": ".", "exit_code": 0, "started_at": ts, "finished_at": ts,
                    "artifact": {"path": "checks/" + chk + ".log", "sha256": sha("log"), "bytes": 2048}}],
        "usage": [
            {"usage_id": use, "task_id": tsk, "session_id": ses, "source": "provider_reported",
             "reporter": "acp_usage_update", "measured_at": ts, "scope": "cumulative",
             "context_window": {"used": 1000, "size": 200000}, "cost": {"amount": 0.12, "unit": "USD", "basis": "reported"}},
            {"usage_id": fx.id("use"), "task_id": tsk, "session_id": ses, "source": "unknown", "reporter": "none",
             "measured_at": ts, "scope": "snapshot"}],
        "stream_messages": [
            {"kind": "heartbeat", "authority_id": "local", "head_seq": 42},
            {"kind": "lagged", "authority_id": "local", "resume_after_seq": 17},
            {"kind": "retention_gap", "authority_id": "remote:vm1", "requested_after_seq": 3, "oldest_available_seq": 120},
            {"kind": "events", "authority_id": "local", "events": [], "next_after_seq": 42}],
    }
    (OUT / "models.sample.json").write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for fn in (f01, f02, f03, f04, f05, f06, f07, f08, f09, f10, samples):
        fn()
    print(f"wrote fixtures to {OUT}")
