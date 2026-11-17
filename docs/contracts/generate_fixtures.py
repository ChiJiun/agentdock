#!/usr/bin/env python3
"""Regenerate docs/contracts/fixtures/*.jsonl, *.expected.json and models.sample.json.

The event streams are written with small helpers so that cursors, ids and timestamps stay
consistent. Expected final states and attention items are written by hand in each scenario
below (they are NOT computed from the events), so validate_fixtures.py is an independent check.

Usage:  python -B docs/contracts/generate_fixtures.py && python -B docs/contracts/validate_fixtures.py
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
    """Canonical JSON (sorted keys, no whitespace, UTF-8, non-ASCII unescaped) -> sha256 hex."""
    text = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def op_key(kind, target) -> str:
    """idempotency_key: sha256 of canonical {kind, identity}; identity = target without the free-text description."""
    return sha({"kind": kind, "identity": {k: v for k, v in target.items() if k != "description"}})


PHASES = ("running", "verifying", "review", "pr", "ci")


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
        self.return_state, self.resume_phase = {}, {}
        self.predelete = None

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
        if to == "queued":
            self.resume_phase[tid] = extra.get("resume_phase")
        self.emit("task.state_changed", actor, payload, task=tid)
        self.task_state[tid] = to

    def phase_of(self, tid):
        st = self.task_state[tid]
        if st in PHASES:
            return st
        if st == "awaiting_approval":
            return self.return_state[tid]
        return self.resume_phase.get(tid) or "running"  # preparing

    def interrupt(self, tid, reason, actor, armed=False, hint=None, summary=None, ops=None, approval=None):
        intr = {"reason": reason, "phase": self.phase_of(tid), "auto_resume_armed": armed}
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

    def ack_task(self, tid, method="opened"):
        self.emit("task.outcome_acknowledged", USER, {"acknowledged_state": self.task_state[tid], "method": method},
                  task=tid)

    def ack_session(self, sid, method="opened"):
        self.emit("session.result_acknowledged", USER, {"method": method}, task=self.session_task[sid], session=sid)

    def delete_task(self, tid):
        """task.deleted, then rewrite every earlier event of the task into a tombstone (seq stays gap-free)."""
        self.predelete = json.loads(json.dumps(self.events))
        history = [e for e in self.events if e.get("task_id") == tid]
        self.emit("task.deleted", USER, {"final_state": self.task_state[tid], "events_tombstoned": len(history)},
                  task=tid)
        at = self.events[-1]["recorded_at"]
        for e in history:
            e["payload"] = {}
            e["tombstone"] = {"reason": "task_deleted", "at": at}

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
    def acp_permission(self, sid, turn, title, call_id, blocking=True, classified="command", unarchive=False):
        """blocking: the task is running and waits in awaiting_approval; otherwise (verifying/review sessions)
        the approval carries no return_state and the task state does not change."""
        tid = self.session_task[sid]
        ad = adapter(self.adapters[sid])
        self.emit("session.tool_call", ad, {"turn_id": turn, "tool_call_id": call_id, "title": title,
                                            "kind": "execute", "status": "pending"}, task=tid, session=sid)
        aid = self.id("apr")
        p = {"approval_id": aid, "source": "acp_permission", "operation_kind": "tool_call", "classified_kind": classified,
             "operation_fingerprint": sha({"kind": "tool_call", "target": {"tool_call_id": call_id, "title": title}}),
             "title": title, "scope": "once",
             "acp": {"tool_call_id": call_id, "options": [
                 {"option_id": "allow", "kind": "allow_once"}, {"option_id": "always", "kind": "allow_always"},
                 {"option_id": "reject", "kind": "reject_once"}]}}
        if blocking:
            p["return_state"] = self.task_state[tid]
        self.emit("approval.requested", ad, p, task=tid, session=sid)
        if unarchive:  # an archived session that starts waiting is unarchived in the same transaction
            self.emit("session.unarchived", ORCH, {"by": "system"}, task=tid, session=sid)
        self.sst(sid, "awaiting_permission", "permission_requested", approval_id=aid)
        if blocking:
            self.tr(tid, "awaiting_approval", "approval_requested", ad, approval_id=aid)
        return aid

    def resolve_acp(self, sid, aid, approve=True, blocking=True):
        tid = self.session_task[sid]
        self.emit("approval.resolved", USER, {"approval_id": aid, "state": "approved" if approve else "denied",
                                              "scope": "once", "acp_outcome": {"outcome": "selected",
                                                                                "option_id": "allow" if approve else "reject"}},
                  task=tid, session=sid)
        self.sst(sid, "active", "permission_resolved", USER, approval_id=aid)
        if blocking:
            self.tr(tid, "running", "approval_resolved", USER, approval_id=aid)

    def host_op(self, tid, kind, target, strategy, supersedes=None, blocking=True):
        oid, aid = self.id("op"), self.id("apr")
        key = op_key(kind, target)
        p = {"operation_id": oid, "kind": kind, "repeatability": "non_repeatable", "idempotency_key": key,
             "target": target, "approval_id": aid, "reconcile_strategy": strategy}
        if supersedes:
            p["supersedes_operation_id"] = supersedes
        self.emit("operation.recorded", ORCH, p, task=tid)
        req = {"approval_id": aid, "source": "host_policy", "operation_kind": kind, "operation_fingerprint": key,
               "operation_id": oid, "title": target["description"], "scope": "once"}
        if blocking:
            req["return_state"] = self.task_state[tid]
        self.emit("approval.requested", POLICY, req, task=tid)
        if blocking:
            self.tr(tid, "awaiting_approval", "approval_requested", POLICY, approval_id=aid)
        return oid, aid

    def approve_op(self, tid, aid, blocking=True):
        self.emit("approval.resolved", USER, {"approval_id": aid, "state": "approved", "scope": "once"}, task=tid)
        if blocking:
            self.tr(tid, self.return_state[tid], "approval_resolved", USER, approval_id=aid)

    def reject_op(self, tid, aid, oid, state="denied", actor=USER, rule=None):
        """Denied/expired host approval: the recorded operation is abandoned before the task moves on."""
        p = {"approval_id": aid, "state": state}
        if rule:
            p["policy_rule_id"] = rule
        self.emit("approval.resolved", actor, p, task=tid)
        self.emit("operation.abandoned", ORCH, {"operation_id": oid, "reason": "approval_" + state}, task=tid)
        self.tr(tid, self.return_state[tid], "approval_resolved", actor, approval_id=aid)

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

    def push_target(self, tid, head, description=None):
        branch = f"agentdock/{tid[-4:]}"
        return {"description": description or f"push {branch} to origin", "remote": "origin",
                "ref": f"refs/heads/{branch}", "expected_sha": head}

    def pr_target(self, tid):
        branch = f"agentdock/{tid[-4:]}"
        return {"description": f"open PR from {branch} into main", "ref": branch, "base": "main"}

    def push_and_pr(self, tid, head="2" * 40, pr_number=42):
        self.checkpoint(tid, head=head)  # the commit to push: clean checkpoint whose head is expected_sha
        oid, aid = self.host_op(tid, "git_push", self.push_target(tid, head), "remote_ref_compare")
        self.approve_op(tid, aid)
        self.run_op(tid, oid, aid, {"remote_sha": head})
        oid, aid = self.host_op(tid, "pr_create", self.pr_target(tid), "pr_lookup_by_head")
        self.approve_op(tid, aid)
        self.run_op(tid, oid, aid, {"pr_number": pr_number, "url": f"https://github.com/example/repo/pull/{pr_number}"})

    # -- output ------------------------------------------------------------------------------
    def write(self, final_tasks, final_sessions, attention):
        name = f"{self.num:02d}-{self.slug}"
        if self.predelete is not None:
            (OUT / "predelete").mkdir(exist_ok=True)
            (OUT / "predelete" / f"{name}.jsonl").write_text(
                "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in self.predelete), encoding="utf-8", newline="\n")
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
            "a review child session whose result is opened and which is then auto-archived, a worktree cleanup after "
            "completion, and three usage sources.")
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
    fx.ack_session(r, "opened")
    fx.emit("session.archived", ORCH, {"by": "auto"}, task=t, session=r)
    # Cleanup after completion: a non-blocking host-policy approval (no return_state, no task transition).
    branch = f"agentdock/{t[-4:]}"
    oid, aid = fx.host_op(t, "worktree_remove", {"description": f"remove the worktree of {branch}",
                                                 "path": branch.replace("/", "-")},
                          "path_exists_lookup", blocking=False)
    fx.approve_op(t, aid, blocking=False)
    fx.run_op(t, oid, aid, {})
    fx.write({t: "completed"}, {p: "closed", r: "closed"},
             [att("needs_review", "task_outcome_unviewed", t)])


def f02():
    fx = Fx(2, "approval-denied", "ACP permission denied: the tool call never runs, the agent continues, "
            "then the user cancels the running task; a second task is cancelled while still queued. Cancelled results "
            "stay in 'to review' until viewed (UX section 4).")
    t = fx.task("Clean up build artifacts")
    p = fx.drive_to(t, "running")
    turn = fx.prompt(p, "Remove stale build output.")
    a = fx.acp_permission(p, turn, "rm -rf ../shared-cache", "call-9", classified="destructive_command")
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
    fx.write({t: "cancelled", q: "cancelled"}, {p: "closed"},
             [att("needs_review", "task_outcome_unviewed", t), att("needs_review", "task_outcome_unviewed", q)])


def f03():
    fx = Fx(3, "cancel-during-approval", "User cancels while an ACP permission is pending: the pending request is "
            "answered 'cancelled' before the task is cancelled; a second task is cancelled while preparing.")
    t = fx.task("Rewrite the release script")
    p = fx.drive_to(t, "running")
    turn = fx.prompt(p, "Rewrite scripts/release.sh.")
    a = fx.acp_permission(p, turn, "Edit scripts/release.sh", "call-3", classified="workspace_edit")
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
    fx.write({t: "cancelled", u: "cancelled"}, {p: "closed", s: "failed"},
             [att("needs_review", "task_outcome_unviewed", t), att("needs_review", "task_outcome_unviewed", u)])


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
    fx.write({t: "failed"}, {p: "closed"}, [att("needs_review", "failure_needs_decision", t)])


def f05():
    fx = Fx(5, "quota-interrupt-auto-resume", "Quota exhausted mid-turn: host-written summary, auto-resume armed from a "
            "provider-reported reset time; the agent process dies while waiting and has no load/resume, so the task "
            "restarts with a new session seeded by the summary. Plus one task waiting for reset and one interrupted "
            "task whose result has not been viewed.")
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
              att("needs_review", "interruption_needs_decision", b),
              att("background", "waiting_for_reset", c)])


def f06():
    fx = Fx(6, "crash-unknown-push", "Host crashes after git push started: recovery marks the push outcome_unknown and "
            "interrupts the task; on resume the push is reconciled (found applied) instead of re-run; CI fails and a "
            "new repair session starts because the adapter cannot reattach.")
    t = fx.task("Bump dependency versions")
    p = fx.drive_to(t, "pr")
    target = fx.push_target(t, "3" * 40)
    oid, aid = fx.host_op(t, "git_push", target, "remote_ref_compare")
    fx.approve_op(t, aid)
    fx.checkpoint(t, head="3" * 40, ops=[oid])
    fx.run_op(t, oid, aid)
    fx.emit("system.recovery_started", RECOV, {"previous_run_id": "run-7", "last_seq_before_crash": len(fx.events)})
    fx.sst(p, "disconnected", "host_recovery", RECOV)
    fx.emit("operation.outcome_unknown", RECOV, {"operation_id": oid, "cause": "host_crash"}, task=t)
    fx.interrupt(t, "host_crashed", RECOV, ops=[oid])
    fx.emit("system.recovery_completed", RECOV, {"tasks_interrupted": [t], "sessions_disconnected": [p],
                                                 "approvals_invalidated": [], "operations_marked_unknown": [oid],
                                                 "operations_abandoned": [], "checks_marked_unknown": []})
    fx.tr(t, "queued", "resume_requested", USER, resume_phase="pr")
    fx.tr(t, "preparing", "scheduled")
    fx.emit("operation.reconciled", INTEG, {"operation_id": oid, "finding": "applied",
                                            "evidence": "origin " + target["ref"] + " == expected_sha"}, task=t)
    fx.tr(t, "pr", "resume_phase_restored", resume_phase="pr")
    oid2, aid2 = fx.host_op(t, "pr_create", fx.pr_target(t), "pr_lookup_by_head")
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
                                                 "operations_abandoned": [], "checks_marked_unknown": []})
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
    fx.write({t: "cancelled"}, {p: "closed"}, [att("needs_review", "task_outcome_unviewed", t)])


def f08():
    fx = Fx(8, "review-loop-pause-children", "Primary session with explore and review child sessions: blocking review "
            "sends the task back to running; the child whose result was opened is auto-archived and later restored by "
            "the user (Undo), while unviewed children stay visible; the user pauses and resumes into review; the "
            "reviewer crashes, the task fails, the user retries and the suspended primary session continues.")
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
    fx.ack_session(r1, "opened")
    fx.emit("session.archived", ORCH, {"by": "auto"}, task=t, session=r1)
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
    fx.emit("session.unarchived", USER, {"by": "user"}, task=t, session=r1)  # Undo: never auto-archived again
    fx.prompt(p, "Resume where you left off.")
    fx.write({t: "running"}, {p: "active", e: "closed", r1: "closed", r2: "failed"},
             [att("background", "agent_working", t, p),
              att("needs_review", "child_result_unviewed", t, e),
              att("needs_review", "child_result_unviewed", t, r2)])


def f09():
    fx = Fx(9, "pr-ci-edges", "PR and CI phase edges: PR creation rejected, merge approval from CI, integration outage "
            "and resume straight into CI, CI repair limit, cancellation in PR/CI/review (one cancelled result bulk-marked "
            "as reviewed), and completion without a PR.")
    a = fx.task("A: PR creation rejected")
    pa = fx.drive_to(a, "pr")
    oid, aid = fx.host_op(a, "pr_create", fx.pr_target(a), "pr_lookup_by_head")
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
    oid, aid = fx.host_op(b, "pr_merge", {"description": "merge PR #42 with a merge commit", "pr_number": 42,
                                          "expected_sha": "2" * 40}, "pr_state_lookup")
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
    fx.ack_task(d, "bulk_marked_reviewed")

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
             [att("needs_review", "task_outcome_unviewed", e),
              att("needs_review", "task_outcome_unviewed", f),
              att("needs_review", "task_outcome_unviewed", g)])


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
             [att("needs_review", "failure_needs_decision", a),
              att("needs_review", "failure_needs_decision", b),
              att("needs_review", "task_outcome_unviewed", d),
              att("needs_reply", "phase_decision_pending", e)])


def f11():
    fx = Fx(11, "push-denied-abandon-supersede", "Host-policy operation edges: a denied push is abandoned, the task is "
            "paused and resumed into pr, and a superseding push with a fresh approval runs; merge (at the pushed head) "
            "is user-approved and gives the integration its completion evidence; an expired destructive-command "
            "approval; a push killed by cancellation (outcome_unknown, cause killed) and reconciled afterwards; a "
            "cleanup operation left outcome_unknown by a crash after the task ended (needs reconcile); a crash between "
            "approval and start (recovery invalidates the unused grant and abandons the recorded operation).")
    a = fx.task("A: push denied, re-requested later")
    pa = fx.drive_to(a, "pr")
    fx.checkpoint(a, head="2" * 40)
    target = fx.push_target(a, "2" * 40)
    oid, aid = fx.host_op(a, "git_push", target, "remote_ref_compare")
    fx.reject_op(a, aid, oid, "denied")
    fx.interrupt(a, "user_paused", USER)
    fx.tr(a, "queued", "resume_requested", USER, resume_phase="pr")
    fx.tr(a, "preparing", "scheduled")
    fx.tr(a, "pr", "resume_phase_restored", resume_phase="pr")
    oid2, aid2 = fx.host_op(a, "git_push", target, "remote_ref_compare", supersedes=oid)
    fx.approve_op(a, aid2)
    fx.run_op(a, oid2, aid2, {"remote_sha": "2" * 40})
    oid3, aid3 = fx.host_op(a, "pr_create", fx.pr_target(a), "pr_lookup_by_head")
    fx.approve_op(a, aid3)
    fx.run_op(a, oid3, aid3, {"pr_number": 51})
    fx.tr(a, "ci", "pr_published", INTEG)
    fx.check(a, "ci / build", origin="ci")
    oid4, aid4 = fx.host_op(a, "pr_merge", {"description": "merge PR #51 with a merge commit", "pr_number": 51,
                                            "expected_sha": "2" * 40}, "pr_state_lookup")
    fx.approve_op(a, aid4)
    fx.run_op(a, oid4, aid4, {"pr_number": 51})
    fx.tr(a, "completed", "ci_passed_accepted", INTEG)
    fx.close(pa, "succeeded")

    b = fx.task("B: destructive command approval expires")
    pb = fx.drive_to(b, "running")
    turn = fx.prompt(pb, "Reset the local test database.")
    oid, aid = fx.host_op(b, "destructive_command", {"description": "drop and recreate the local test database",
                                                     "command_sha256": sha(["sqlx", "database", "reset", "-y"]),
                                                     "cwd": "target/test-db"}, "none")
    fx.reject_op(b, aid, oid, "expired", actor=POLICY)
    fx.tr(b, "cancelled", "user_cancel", USER)
    fx.end_turn(pb, turn, stop="cancelled")
    fx.close(pb, "cancelled")

    c = fx.task("C: cancelled while a push is running")
    pc = fx.drive_to(c, "pr")
    fx.checkpoint(c, head="4" * 40)
    target = fx.push_target(c, "4" * 40)
    oid, aid = fx.host_op(c, "git_push", target, "remote_ref_compare")
    fx.approve_op(c, aid)
    fx.run_op(c, oid, aid)
    fx.emit("operation.outcome_unknown", ORCH, {"operation_id": oid, "cause": "killed"}, task=c)
    fx.tr(c, "cancelled", "user_cancel", USER)
    fx.emit("operation.reconciled", INTEG, {"operation_id": oid, "finding": "not_applied",
                                            "evidence": "origin " + target["ref"] + " does not exist"}, task=c)
    fx.close(pc, "cancelled")

    e = fx.task("E: cleanup interrupted by a host crash")
    fx.tr(e, "cancelled", "user_cancel", USER)
    fx.ack_task(e)
    oid, aid = fx.host_op(e, "worktree_remove", {"description": "remove the worktree of the cancelled task",
                                                 "path": f"agentdock-{e[-4:]}"}, "path_exists_lookup", blocking=False)
    fx.approve_op(e, aid, blocking=False)
    fx.run_op(e, oid, aid)
    fx.emit("system.recovery_started", RECOV, {"previous_run_id": "run-10", "last_seq_before_crash": len(fx.events)})
    fx.emit("operation.outcome_unknown", RECOV, {"operation_id": oid, "cause": "host_crash"}, task=e)
    fx.emit("system.recovery_completed", RECOV, {"tasks_interrupted": [], "sessions_disconnected": [],
                                                 "approvals_invalidated": [], "operations_marked_unknown": [oid],
                                                 "operations_abandoned": [], "checks_marked_unknown": []})
    cleanup = oid

    d = fx.task("D: crash after approval, before start")
    pd = fx.drive_to(d, "pr")
    fx.checkpoint(d, head="5" * 40)
    target = fx.push_target(d, "5" * 40)
    oid, aid = fx.host_op(d, "git_push", target, "remote_ref_compare")
    fx.approve_op(d, aid)
    fx.emit("system.recovery_started", RECOV, {"previous_run_id": "run-11", "last_seq_before_crash": len(fx.events)})
    fx.emit("approval.resolved", RECOV, {"approval_id": aid, "state": "invalidated"}, task=d)
    fx.emit("operation.abandoned", RECOV, {"operation_id": oid, "reason": "host_recovery"}, task=d)
    fx.sst(pd, "disconnected", "host_recovery", RECOV)
    fx.interrupt(d, "host_crashed", RECOV)
    fx.emit("system.recovery_completed", RECOV, {"tasks_interrupted": [d], "sessions_disconnected": [pd],
                                                 "approvals_invalidated": [aid], "operations_marked_unknown": [],
                                                 "operations_abandoned": [oid], "checks_marked_unknown": []})
    fx.tr(d, "queued", "resume_requested", USER, resume_phase="pr")
    fx.tr(d, "preparing", "scheduled")
    fx.tr(d, "pr", "resume_phase_restored", resume_phase="pr")
    oid2, aid2 = fx.host_op(d, "git_push", target, "remote_ref_compare", supersedes=oid)
    fx.approve_op(d, aid2)
    fx.run_op(d, oid2, aid2, {"remote_sha": "5" * 40})
    oid3, aid3 = fx.host_op(d, "pr_create", fx.pr_target(d), "pr_lookup_by_head")
    fx.approve_op(d, aid3)
    fx.run_op(d, oid3, aid3, {"pr_number": 52})
    fx.tr(d, "ci", "pr_published", INTEG)
    fx.check(d, "ci / build", origin="ci", finish=False)
    fx.write({a: "completed", b: "cancelled", c: "cancelled", e: "cancelled", d: "ci"},
             {pa: "closed", pb: "closed", pc: "closed", pd: "disconnected"},
             [att("needs_review", "task_outcome_unviewed", a),
              att("needs_review", "task_outcome_unviewed", b),
              att("needs_review", "task_outcome_unviewed", c),
              att("needs_reply", "reconcile_needed", e, ref=cleanup),
              att("background", "workflow_step", d)])


def f12():
    fx = Fx(12, "session-edge-cases", "Session and attention edges: a rejected reattach interrupts the task with "
            "session_unavailable; disabling auto-resume disarms a waiting task whose suspended agent then fails; a "
            "running task whose idle agent crashed; a turn cancelled by the output limit; a review session with a "
            "non-blocking ACP approval that fails while asking, followed by a refusal; a session closed while starting; "
            "a main session archived while paused and unarchived by the system when it asks for permission; and a task "
            "that went through crash recovery and was then deleted (its history, including the recovery events, is "
            "tombstoned; fixtures/predelete/ keeps the stream as it was before deletion).")
    g = fx.task("G: crashed, cancelled, then deleted")
    pg = fx.drive_to(g, "running")
    turn = fx.prompt(pg, "Remove the legacy importer.")
    ag = fx.acp_permission(pg, turn, "Run cargo build", "call-g1")
    fx.emit("system.recovery_started", RECOV, {"previous_run_id": "run-12", "last_seq_before_crash": len(fx.events)})
    fx.emit("approval.resolved", RECOV, {"approval_id": ag, "state": "invalidated"}, task=g, session=pg)
    fx.sst(pg, "disconnected", "host_recovery", RECOV)
    fx.interrupt(g, "host_crashed", RECOV, approval=ag)
    fx.emit("system.recovery_completed", RECOV, {"tasks_interrupted": [g], "sessions_disconnected": [pg],
                                                 "approvals_invalidated": [ag], "operations_marked_unknown": [],
                                                 "operations_abandoned": [], "checks_marked_unknown": []})
    fx.tr(g, "cancelled", "user_cancel", USER)
    fx.close(pg, "abandoned", trigger="abandoned", actor=USER)
    fx.ack_task(g)

    a = fx.task("A: reattach rejected")
    fx.tr(a, "preparing", "scheduled")
    pa = fx.session(a, resume=True)
    fx.ready(pa)
    fx.tr(a, "running", "session_ready")
    turn = fx.prompt(pa, "Refactor the CLI parser.")
    fx.say(pa, turn, "Working on it.")
    fx.sst(pa, "disconnected", "process_exited")
    fx.interrupt(a, "adapter_disconnected", adapter("claude-code"))
    fx.tr(a, "queued", "resume_requested", USER, resume_phase="running")
    fx.tr(a, "preparing", "scheduled")
    fx.sst(pa, "starting", "reattach_attempt", ORCH, launch_method="resume")
    fx.caps(pa, resume=True)
    fx.sst(pa, "failed", "attach_rejected", outcome="failed", error={"code": "session_not_found"})
    fx.interrupt(a, "session_unavailable", ORCH)

    b = fx.task("B: auto-resume disabled while waiting", quota=True)
    pb = fx.drive_to(b, "running")
    turn = fx.prompt(pb, "Generate the API client.")
    s1 = fx.summary(pb, "interruption", "Host summary: client half generated; no open operations.")
    fx.sst(pb, "suspended", "task_interrupted")
    fx.interrupt(b, "quota_exhausted", adapter("claude-code"), armed=True, summary=s1,
                 hint={"not_before": fx.at(hours=5), "source": "provider_reported"})
    fx.emit("task.policy_updated", USER, {"auto_resume_policy": {"on_quota_reset": False, "on_rate_limit": False}},
            task=b)
    fx.sst(pb, "failed", "protocol_error", outcome="failed", error={"code": "invalid_json_rpc"})

    c = fx.task("C: agent crashed between turns")
    pc = fx.drive_to(c, "running")
    turn = fx.prompt(pc, "Add input validation.")
    fx.end_turn(pc, turn)
    fx.sst(pc, "failed", "protocol_error", outcome="failed", error={"code": "agent_crashed"})

    d = fx.task("D: runaway output")
    pd = fx.drive_to(d, "running")
    turn = fx.prompt(pd, "Print the dependency graph.")
    fx.emit("session.output_limited", ORCH, {"turn_id": turn, "limit": "max_turn_bytes", "action": "turn_cancelled",
                                             "dropped_bytes": 1048576}, task=d, session=pd)
    fx.end_turn(pd, turn, stop="cancelled")

    e = fx.task("E: review session edges")
    pe = fx.drive_to(e, "review")
    r = fx.session(e, role="review", adapter_id="codex", parent=pe)
    fx.ready(r)
    rt = fx.prompt(r, "Review independently.", origin="orchestrator")
    a1 = fx.acp_permission(r, rt, "Run cargo clippy", "call-r1", blocking=False)
    fx.resolve_acp(r, a1, approve=True, blocking=False)
    a2 = fx.acp_permission(r, rt, "Run cargo audit", "call-r2", blocking=False)
    fx.emit("approval.resolved", ORCH, {"approval_id": a2, "state": "cancelled", "acp_outcome": {"outcome": "cancelled"}},
            task=e, session=r)
    fx.sst(r, "failed", "protocol_error", outcome="failed", error={"code": "agent_crashed"})
    r2 = fx.session(e, role="review", adapter_id="codex", parent=pe)
    fx.ready(r2)
    rt2 = fx.prompt(r2, "Review again.", origin="orchestrator")
    fx.say(r2, rt2, "I cannot review this change.")
    fx.end_turn(r2, rt2, stop="refusal")

    f = fx.task("F: cancelled while the agent starts")
    fx.tr(f, "preparing", "scheduled")
    sf = fx.session(f)
    fx.tr(f, "cancelled", "user_cancel", USER)
    fx.sst(sf, "closed", "session_closed", ORCH, outcome="cancelled")

    h = fx.task("H: archived while paused, unarchived when it asks")
    ph = fx.drive_to(h, "running")
    turn = fx.prompt(ph, "Split the config module.")
    fx.end_turn(ph, turn)
    fx.interrupt(h, "user_paused", USER)
    fx.sst(ph, "suspended", "task_interrupted", USER)
    fx.emit("session.archived", USER, {"by": "user"}, task=h, session=ph)
    fx.tr(h, "queued", "resume_requested", USER, resume_phase="running")
    fx.tr(h, "preparing", "scheduled")
    fx.tr(h, "running", "session_ready")
    turn = fx.prompt(ph, "Continue the split.")
    ah = fx.acp_permission(ph, turn, "Edit src/config/mod.rs", "call-h1", classified="workspace_edit", unarchive=True)

    fx.delete_task(g)
    fx.write({a: "interrupted", b: "interrupted", c: "running", d: "running", e: "review", f: "cancelled",
              h: "awaiting_approval"},
             {pa: "failed", pb: "failed", pc: "failed", pd: "idle", pe: "idle", r: "failed", r2: "idle", sf: "closed",
              ph: "awaiting_permission"},
             [att("needs_review", "interruption_needs_decision", a),
              att("needs_review", "interruption_needs_decision", b),
              att("needs_reply", "session_unavailable", c),
              att("needs_reply", "output_limited", d, pd),
              att("needs_reply", "phase_decision_pending", e),
              att("needs_reply", "agent_turn_ended", e, r2),
              att("needs_review", "child_result_unviewed", e, r),
              att("needs_review", "task_outcome_unviewed", f),
              att("needs_reply", "approval_pending", h, ph, ah)])


def samples():
    fx = Fx(99, "samples", "")
    prj, tsk, ses, child = fx.project, fx.id("tsk"), fx.id("ses"), fx.id("ses")
    apr, op, chk, use, sumid = fx.id("apr"), fx.id("op"), fx.id("chk"), fx.id("use"), fx.id("sum")
    op_target = {"description": "push agentdock/x", "remote": "origin", "ref": "refs/heads/agentdock/x",
                 "expected_sha": "2" * 40}
    key = op_key("git_push", op_target)
    ts = "2026-11-17T10:00:00.000Z"
    doc = {
        "projects": [{"project_id": prj, "name": "agentdock", "local_path": "D:/Code/agentdock", "environment_id": "local",
                      "remote_origin": "https://github.com/example/agentdock.git", "default_branch": "main", "created_at": ts}],
        "tasks": [{"task_id": tsk, "project_id": prj, "objective": "Example", "state": "interrupted",
                   "branch": "agentdock/x", "primary_session_id": ses,
                   "interruption": {"reason": "quota_exhausted", "phase": "running", "auto_resume_armed": True,
                                    "summary_id": sumid,
                                    "retry_hint": {"not_before": "2026-11-17T15:00:00.000Z", "source": "provider_reported"}},
                   "auto_resume_policy": {"on_quota_reset": True, "on_rate_limit": False},
                   "created_at": ts, "updated_at": ts, "last_seq": 42}],
        "sessions": [
            {"session_id": ses, "task_id": tsk, "role": "primary", "adapter_id": "claude-code", "state": "suspended",
             "external_session_id": "acp-abc", "launch_method": "new", "capability_snapshot": caps(ts),
             "archived": False, "created_at": ts},
            {"session_id": child, "task_id": tsk, "parent_session_id": ses, "role": "review", "adapter_id": "codex",
             "state": "closed", "launch_method": "new", "outcome": "succeeded", "result_acknowledged_at": ts,
             "result_opened_at": ts, "archived": True, "archived_by": "auto", "restored_by_user": False,
             "created_at": ts, "closed_at": ts}],
        "approvals": [{"approval_id": apr, "task_id": tsk, "source": "host_policy", "state": "approved",
                       "operation_kind": "git_push", "operation_fingerprint": key, "operation_id": op,
                       "title": "push agentdock/x", "scope": "once", "return_state": "pr", "requested_at": ts,
                       "decided_at": ts, "decided_by": USER},
                      {"approval_id": fx.id("apr"), "task_id": tsk, "session_id": ses, "source": "acp_permission",
                       "state": "denied", "operation_kind": "tool_call", "classified_kind": "force_push",
                       "operation_fingerprint": sha({"kind": "tool_call", "target": {"tool_call_id": "call-1",
                                                                                     "title": "git push --force"}}),
                       "title": "git push --force", "scope": "once", "return_state": "running",
                       "acp": {"tool_call_id": "call-1", "options": [{"option_id": "allow", "kind": "allow_once"},
                                                                     {"option_id": "reject", "kind": "reject_once"}]},
                       "selected_option_id": "reject", "requested_at": ts, "decided_at": ts, "decided_by": USER}],
        "operations": [{"operation_id": op, "task_id": tsk, "kind": "git_push", "repeatability": "non_repeatable",
                        "idempotency_key": key, "target": op_target,
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
    for fn in (f01, f02, f03, f04, f05, f06, f07, f08, f09, f10, f11, f12, samples):
        fn()
    print(f"wrote fixtures to {OUT}")
