//! Black-box tests: start the real binary, speak raw NDJSON, read it back.
//! No dependency on `agentdock-acp` (no cycle) and no ACP SDK.
//!
//! Every read is time-limited: a reader thread forwards raw byte chunks through a bounded
//! channel, so a failing test times out instead of hanging.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

const READ_TIMEOUT: Duration = Duration::from_secs(10);
const INIT: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}"#;
const NEW: &str =
    r#"{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}}"#;
const ALLOW: &str = r#"{"outcome":{"outcome":"selected","optionId":"allow-once"}}"#;
const REJECT: &str = r#"{"outcome":{"outcome":"selected","optionId":"reject-once"}}"#;
const CANCELLED: &str = r#"{"outcome":{"outcome":"cancelled"}}"#;

struct Conn {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: Receiver<Vec<u8>>,
    buf: Vec<u8>,
    eof: bool,
}

impl Drop for Conn {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start_with(args: &[&str]) -> Conn {
    let mut child = Command::new(env!("CARGO_BIN_EXE_agentdock-mock-agent"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn mock agent");
    let stdin = child.stdin.take();
    let mut stdout = child.stdout.take().expect("piped stdout");
    // Bounded: if the test stops reading, the pipe fills and the mock blocks instead of the
    // test process buffering 64 MiB.
    let (tx, rx) = sync_channel::<Vec<u8>>(8);
    thread::spawn(move || {
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(chunk[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    Conn {
        child,
        stdin,
        rx,
        buf: Vec::new(),
        eof: false,
    }
}

fn start(scenario: &str) -> Conn {
    start_with(&["--scenario", scenario])
}

fn send(c: &mut Conn, v: Value) {
    send_raw(c, &v.to_string());
}

fn send_raw(c: &mut Conn, line: &str) {
    let stdin = c.stdin.as_mut().expect("stdin open");
    stdin.write_all(line.as_bytes()).expect("write");
    stdin.write_all(b"\n").expect("write");
    stdin.flush().expect("flush");
}

fn prompt(id: u64, text: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":"session/prompt",
           "params":{"sessionId":"mock-session-1","prompt":[{"type":"text","text":text}]}})
}

fn cancel() -> Value {
    json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"mock-session-1"}})
}

fn permission_reply(id: &str, outcome: &str) -> Value {
    let outcome: Value = serde_json::from_str(outcome).expect("outcome json");
    json!({"jsonrpc":"2.0","id":id,"result":outcome})
}

impl Conn {
    /// Pull one more chunk into `buf`. False on timeout or EOF.
    fn pump(&mut self, deadline: Instant) -> bool {
        if self.eof {
            return false;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        match self.rx.recv_timeout(left) {
            Ok(bytes) => {
                self.buf.extend_from_slice(&bytes);
                true
            }
            Err(RecvTimeoutError::Timeout) => false,
            Err(RecvTimeoutError::Disconnected) => {
                self.eof = true;
                false
            }
        }
    }

    /// One newline-terminated line (without the newline), or None on timeout/EOF.
    fn read_line(&mut self, timeout: Duration) -> Option<Vec<u8>> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(pos) = self.buf.iter().position(|b| *b == b'\n') {
                let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
                line.pop();
                return Some(line);
            }
            if !self.pump(deadline) {
                return None;
            }
        }
    }

    fn read_json(&mut self) -> Value {
        let line = self.read_line(READ_TIMEOUT).expect("a line within timeout");
        serde_json::from_slice(&line).expect("valid json line")
    }

    /// Read JSON messages until `done` accepts one; returns every message read, last one included.
    fn read_until(&mut self, done: impl Fn(&Value) -> bool) -> Vec<Value> {
        let mut out = Vec::new();
        loop {
            let v = self.read_json();
            let finished = done(&v);
            out.push(v);
            if finished {
                return out;
            }
        }
    }

    /// Bytes buffered or received until at least `n` are available (unterminated data).
    fn read_at_least(&mut self, n: usize, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while self.buf.len() < n {
            if !self.pump(deadline) {
                return false;
            }
        }
        true
    }

    fn wait_exit(&mut self, timeout: Duration) -> Option<i32> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait().expect("try_wait") {
                return status.code();
            }
            if Instant::now() >= deadline {
                return None;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn close_stdin(&mut self) {
        self.stdin = None;
    }

    /// initialize + session/new; returns both responses.
    fn handshake(&mut self) -> (Value, Value) {
        send_raw(self, INIT);
        let init = self.read_json();
        send_raw(self, NEW);
        let new = self.read_json();
        (init, new)
    }
}

fn is_response_to(v: &Value, id: u64) -> bool {
    v.get("id") == Some(&json!(id)) && v.get("method").is_none()
}

fn chunk_text(v: &Value) -> Option<&str> {
    let update = v.get("params")?.get("update")?;
    if update.get("sessionUpdate")? != "agent_message_chunk" {
        return None;
    }
    update.get("content")?.get("text")?.as_str()
}

fn chunk_texts(msgs: &[Value]) -> Vec<&str> {
    msgs.iter().filter_map(chunk_text).collect()
}

fn update_kind<'a>(v: &'a Value, kind: &str) -> Option<&'a Value> {
    let update = v.get("params")?.get("update")?;
    (update.get("sessionUpdate")? == kind).then_some(update)
}

fn stop_reason(v: &Value) -> &str {
    v["result"]["stopReason"].as_str().expect("stopReason")
}

fn is_permission_request(v: &Value) -> bool {
    v.get("method") == Some(&json!("session/request_permission"))
}

/// Initialize + new session + prompt on `c`, returning nothing; callers read afterwards.
fn open_turn(c: &mut Conn, text: &str) {
    c.handshake();
    send(c, prompt(3, text));
}

fn test_dir(label: &str) -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    // Space and CJK characters on purpose (CONVENTIONS section 5, WT-4).
    let dir = std::env::temp_dir().join(format!(
        "agent dock 測試-{label}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).expect("create test dir");
    dir
}

fn kill_pid(pid: u32) {
    let _ = if cfg!(windows) {
        Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    } else {
        Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    };
}

fn grandchild_pid(msgs: &[Value]) -> u32 {
    chunk_texts(msgs)
        .iter()
        .find_map(|t| t.strip_prefix("grandchild pid "))
        .expect("grandchild pid text")
        .trim()
        .parse()
        .expect("numeric pid")
}

#[test]
fn echo_streams_three_chunks_then_end_turn() {
    let mut c = start("echo");
    let (init, new) = c.handshake();
    assert_eq!(init["result"]["protocolVersion"], 1);
    assert_eq!(new["result"]["sessionId"], "mock-session-1");
    send(&mut c, prompt(3, "hello from the client 你好"));
    let msgs = c.read_until(|v| is_response_to(v, 3));
    let chunks = chunk_texts(&msgs);
    assert_eq!(chunks.len(), 3);
    assert_eq!(chunks.concat(), "hello from the client 你好");
    assert_eq!(stop_reason(msgs.last().unwrap()), "end_turn");
}

#[test]
fn permission_allow_once_completes_tool_call() {
    let mut c = start("permission");
    open_turn(&mut c, "go");
    let msgs = c.read_until(is_permission_request);
    let req = msgs.last().unwrap();
    assert_eq!(req["id"], "mock-perm-1");
    assert_eq!(req["params"]["sessionId"], "mock-session-1");
    let kinds: Vec<&str> = req["params"]["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["kind"].as_str().unwrap())
        .collect();
    assert!(kinds.contains(&"allow_once") && kinds.contains(&"reject_once"));
    assert!(msgs.iter().any(|m| update_kind(m, "tool_call").is_some()));

    send(&mut c, permission_reply("mock-perm-1", ALLOW));
    let rest = c.read_until(|v| is_response_to(v, 3));
    let done = rest
        .iter()
        .find_map(|m| update_kind(m, "tool_call_update"))
        .expect("tool_call_update");
    assert_eq!(done["status"], "completed");
    assert_eq!(done["toolCallId"], "call_1");
    assert!(chunk_texts(&rest).contains(&"approved"));
    assert_eq!(stop_reason(rest.last().unwrap()), "end_turn");
}

#[test]
fn permission_reject_marks_failed() {
    let mut c = start("permission");
    open_turn(&mut c, "go");
    c.read_until(is_permission_request);
    send(&mut c, permission_reply("mock-perm-1", REJECT));
    let rest = c.read_until(|v| is_response_to(v, 3));
    let done = rest
        .iter()
        .find_map(|m| update_kind(m, "tool_call_update"))
        .expect("tool_call_update");
    assert_eq!(done["status"], "failed");
    assert!(chunk_texts(&rest).contains(&"denied"));
    assert_eq!(stop_reason(rest.last().unwrap()), "end_turn");
}

#[test]
fn permission_cancelled_returns_cancelled() {
    let mut c = start("permission");
    open_turn(&mut c, "go");
    c.read_until(is_permission_request);
    send(&mut c, permission_reply("mock-perm-1", CANCELLED));
    let rest = c.read_until(|v| is_response_to(v, 3));
    assert_eq!(stop_reason(rest.last().unwrap()), "cancelled");
}

#[test]
fn slow_stops_on_cancel() {
    let mut c = start("slow");
    open_turn(&mut c, "go");
    let mut chunks = 0;
    while chunks < 2 {
        if chunk_text(&c.read_json()).is_some() {
            chunks += 1;
        }
    }
    let sent_at = Instant::now();
    send(&mut c, cancel());
    let msgs = c.read_until(|v| is_response_to(v, 3));
    assert!(
        sent_at.elapsed() < Duration::from_secs(1),
        "cancel took {:?}",
        sent_at.elapsed()
    );
    assert_eq!(stop_reason(msgs.last().unwrap()), "cancelled");
    chunks += chunk_texts(&msgs).len();
    assert!(chunks < 50, "got {chunks} chunks");
}

#[test]
fn wrong_version_reports_v2() {
    let mut c = start("wrong-version");
    let (init, _) = c.handshake();
    assert_eq!(init["result"]["protocolVersion"], 2);
}

#[test]
fn exit_early_exits_with_3() {
    let mut c = start("exit-early");
    assert_eq!(c.wait_exit(READ_TIMEOUT), Some(3));
}

#[test]
fn exit_mid_turn_never_answers_prompt() {
    let mut c = start("exit-mid-turn");
    open_turn(&mut c, "go");
    let msgs = c.read_until(|v| chunk_text(v).is_some());
    assert_eq!(msgs.len(), 1);
    assert_eq!(c.wait_exit(READ_TIMEOUT), Some(4));
    // EOF follows; nothing answers the prompt.
    while let Some(line) = c.read_line(Duration::from_secs(1)) {
        let v: Value = serde_json::from_slice(&line).unwrap();
        assert!(!is_response_to(&v, 3));
    }
}

#[test]
fn bad_bytes_emits_invalid_utf8_line() {
    let mut c = start("bad-bytes");
    open_turn(&mut c, "go");
    let first = c.read_line(READ_TIMEOUT).expect("first raw line");
    assert_eq!(first, vec![0xFF, 0xFE, 0xC3, 0x28]);
    assert!(std::str::from_utf8(&first).is_err());
    assert_eq!(c.read_line(READ_TIMEOUT).unwrap(), b"this is not json");
    let msgs = c.read_until(|v| is_response_to(v, 3));
    assert!(chunk_texts(&msgs).contains(&"still connected after bad bytes"));
    assert_eq!(stop_reason(msgs.last().unwrap()), "end_turn");
}

#[test]
fn unknown_notification_is_sent_before_reply() {
    let mut c = start("unknown-notification");
    open_turn(&mut c, "ordinary reply");
    let msgs = c.read_until(|v| is_response_to(v, 3));
    assert_eq!(msgs[0]["method"], "_vendor/ping");
    assert_eq!(msgs[0]["params"]["x"], 1);
    assert!(msgs[0].get("id").is_none(), "must be a notification");
    assert!(
        msgs.iter()
            .any(|m| m["params"]["update"].get("_meta").is_some()),
        "a text update carries _meta"
    );
    assert!(chunk_texts(&msgs).concat().ends_with("ordinary reply"));
    assert_eq!(stop_reason(msgs.last().unwrap()), "end_turn");
}

#[test]
fn auth_required_errors_on_new_session() {
    let mut c = start("auth-required");
    let (init, new) = c.handshake();
    assert_eq!(init["result"]["authMethods"][0]["id"], "mock-login");
    assert_eq!(new["error"]["code"], -32000);
    assert!(new.get("result").is_none());
}

#[test]
fn unknown_scenario_exits_2() {
    let mut c = start("nope");
    assert_eq!(c.wait_exit(READ_TIMEOUT), Some(2));
}

#[test]
fn remaining_scenarios_start() {
    // oversize: unterminated data after the prompt.
    let mut c = start("oversize");
    open_turn(&mut c, "go");
    assert!(c.read_at_least(1024 * 1024, READ_TIMEOUT));
    assert!(!c.buf.contains(&b'\n'));
    drop(c);

    // stubborn: reports a grandchild pid; kill it ourselves at the end.
    let mut c = start("stubborn");
    open_turn(&mut c, "go");
    let msgs = c.read_until(|v| is_response_to(v, 3));
    kill_pid(grandchild_pid(&msgs));
    drop(c);

    // orphan-stdio: the grandchild keeps stdout open after the mock exits.
    let mut c = start("orphan-stdio");
    open_turn(&mut c, "go");
    let msgs = c.read_until(|v| is_response_to(v, 3));
    assert_eq!(stop_reason(msgs.last().unwrap()), "end_turn");
    assert_eq!(c.wait_exit(READ_TIMEOUT), Some(0));
    kill_pid(grandchild_pid(&msgs));
    drop(c);

    // flood: 10,000 chunks of 10 characters.
    let mut c = start("flood");
    open_turn(&mut c, "go");
    let msgs = c.read_until(|v| is_response_to(v, 3));
    let chunks = chunk_texts(&msgs);
    assert_eq!(chunks.len(), 10_000);
    assert!(chunks.iter().all(|t| t.chars().count() == 10));
    drop(c);

    // secret-echo: a fake token, ghp_ + 36 zeros.
    let mut c = start("secret-echo");
    open_turn(&mut c, "go");
    let msgs = c.read_until(|v| is_response_to(v, 3));
    let expected = format!("token ghp_{} end", "0".repeat(36));
    assert!(chunk_texts(&msgs).concat().contains(&expected));
}

#[test]
fn permission_two_sends_two_requests_back_to_back() {
    let mut c = start("permission-two");
    open_turn(&mut c, "go");
    // Both requests arrive before any answer is sent.
    let mut reqs = Vec::new();
    let mut calls = 0;
    while reqs.len() < 2 {
        let v = c.read_json();
        if update_kind(&v, "tool_call").is_some() {
            calls += 1;
        }
        if is_permission_request(&v) {
            reqs.push(v);
        }
    }
    assert_eq!(calls, 2);
    assert_eq!(reqs[0]["id"], "mock-perm-1");
    assert_eq!(reqs[0]["params"]["toolCall"]["toolCallId"], "call_1");
    assert_eq!(reqs[1]["id"], "mock-perm-2");
    assert_eq!(reqs[1]["params"]["toolCall"]["toolCallId"], "call_2");

    // Answer in the opposite order: any order is accepted.
    send(&mut c, permission_reply("mock-perm-2", REJECT));
    send(&mut c, permission_reply("mock-perm-1", ALLOW));
    let rest = c.read_until(|v| is_response_to(v, 3));
    assert!(chunk_texts(&rest).contains(&"perm1=allow-once perm2=reject-once"));
    assert_eq!(stop_reason(rest.last().unwrap()), "end_turn");
}

#[test]
fn permission_two_cancel_before_answers_returns_cancelled() {
    let mut c = start("permission-two");
    open_turn(&mut c, "go");
    let mut seen = 0;
    while seen < 2 {
        if is_permission_request(&c.read_json()) {
            seen += 1;
        }
    }
    send(&mut c, cancel());
    let rest = c.read_until(|v| is_response_to(v, 3));
    assert_eq!(stop_reason(rest.last().unwrap()), "cancelled");
}

#[test]
fn permission_two_cancelled_answer_makes_turn_cancelled() {
    let mut c = start("permission-two");
    open_turn(&mut c, "go");
    let mut seen = 0;
    while seen < 2 {
        if is_permission_request(&c.read_json()) {
            seen += 1;
        }
    }
    send(&mut c, permission_reply("mock-perm-1", ALLOW));
    send(&mut c, permission_reply("mock-perm-2", CANCELLED));
    let rest = c.read_until(|v| is_response_to(v, 3));
    assert!(chunk_texts(&rest).contains(&"perm1=allow-once perm2=cancelled"));
    assert_eq!(stop_reason(rest.last().unwrap()), "cancelled");
}

#[test]
fn permission_fault_exit_exits_5() {
    let mut c = start_with(&["--scenario", "permission-fault", "--arg", "exit"]);
    open_turn(&mut c, "go");
    let msgs = c.read_until(is_permission_request);
    assert_eq!(msgs.last().unwrap()["id"], "mock-perm-1");
    assert_eq!(c.wait_exit(Duration::from_secs(2)), Some(5));
    while let Some(line) = c.read_line(Duration::from_secs(1)) {
        let v: Value = serde_json::from_slice(&line).unwrap();
        assert!(!is_response_to(&v, 3), "the prompt must never be answered");
    }
}

#[test]
fn permission_fault_oversize_writes_unterminated_line() {
    let mut c = start_with(&["--scenario", "permission-fault", "--arg", "oversize"]);
    open_turn(&mut c, "go");
    c.read_until(is_permission_request);
    assert!(c.read_at_least(1024 * 1024, READ_TIMEOUT));
    assert!(!c.buf.contains(&b'\n'));
}

fn scripted_edit(path: &Path, extra: &str) -> String {
    format!("EDIT-PATH: {}\n{extra}", path.display())
}

#[test]
fn scripted_edit_permission_writes_file_only_when_allowed() {
    let dir = test_dir("edit");
    let allowed = dir.join("allowed.txt");
    let rejected = dir.join("rejected.txt");
    std::fs::write(&allowed, "original").unwrap();
    std::fs::write(&rejected, "original").unwrap();

    let mut c = start("scripted");
    open_turn(&mut c, &scripted_edit(&allowed, ""));
    let msgs = c.read_until(is_permission_request);
    let req = msgs.last().unwrap();
    assert_eq!(req["id"], "mock-perm-1");
    assert_eq!(req["params"]["toolCall"]["kind"], "edit");
    assert_eq!(
        req["params"]["toolCall"]["locations"][0]["path"],
        allowed.display().to_string()
    );
    assert_eq!(std::fs::read_to_string(&allowed).unwrap(), "original");
    send(&mut c, permission_reply("mock-perm-1", ALLOW));
    let rest = c.read_until(|v| is_response_to(v, 3));
    assert!(chunk_texts(&rest).contains(&"approved"));
    assert_eq!(stop_reason(rest.last().unwrap()), "end_turn");
    assert_eq!(std::fs::read_to_string(&allowed).unwrap(), "edited-by-mock");
    drop(c);

    let mut c = start("scripted");
    open_turn(&mut c, &scripted_edit(&rejected, ""));
    c.read_until(is_permission_request);
    send(&mut c, permission_reply("mock-perm-1", REJECT));
    let rest = c.read_until(|v| is_response_to(v, 3));
    let done = rest
        .iter()
        .find_map(|m| update_kind(m, "tool_call_update"))
        .unwrap();
    assert_eq!(done["status"], "failed");
    assert!(chunk_texts(&rest).contains(&"denied"));
    assert_eq!(std::fs::read_to_string(&rejected).unwrap(), "original");
    drop(c);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Start `scripted` with `EDIT-PATH` + `ON-CANCEL: <mode>`, answer the permission as
/// cancelled and check the turn is NOT ended; leaves the mock waiting for `session/cancel`.
fn on_cancel_setup(mode: &str, dir: &Path) -> Conn {
    let file = dir.join("never-written.txt");
    let mut c = start("scripted");
    open_turn(&mut c, &scripted_edit(&file, &format!("ON-CANCEL: {mode}")));
    c.read_until(is_permission_request);
    send(&mut c, permission_reply("mock-perm-1", CANCELLED));
    assert!(
        c.read_line(Duration::from_millis(500)).is_none(),
        "the permission answer must be ignored"
    );
    assert!(!file.exists());
    c
}

#[test]
fn scripted_on_cancel_exit_exits_6() {
    let dir = test_dir("on-cancel-exit");
    let mut c = on_cancel_setup("exit", &dir);
    send(&mut c, cancel());
    assert_eq!(c.wait_exit(READ_TIMEOUT), Some(6));
    while let Some(line) = c.read_line(Duration::from_secs(1)) {
        let v: Value = serde_json::from_slice(&line).unwrap();
        assert!(!is_response_to(&v, 3));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn scripted_on_cancel_ignore_stays_silent() {
    let dir = test_dir("on-cancel-ignore");
    let mut c = on_cancel_setup("ignore", &dir);
    send(&mut c, cancel());
    assert!(c.read_line(Duration::from_secs(2)).is_none());
    assert!(c.child.try_wait().unwrap().is_none(), "still alive");
    drop(c);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn scripted_on_cancel_oversize_writes_unterminated_line() {
    let dir = test_dir("on-cancel-oversize");
    let mut c = on_cancel_setup("oversize", &dir);
    send(&mut c, cancel());
    assert!(c.read_at_least(1024 * 1024, READ_TIMEOUT));
    assert!(!c.buf.contains(&b'\n'));
    drop(c);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn scripted_on_cancel_end_answers_cancelled() {
    let dir = test_dir("on-cancel-end");
    let mut c = on_cancel_setup("end", &dir);
    send(&mut c, cancel());
    let rest = c.read_until(|v| is_response_to(v, 3));
    assert_eq!(stop_reason(rest.last().unwrap()), "cancelled");
    drop(c);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn scripted_say_replies_text() {
    let mut c = start("scripted");
    open_turn(&mut c, "ignored first line\nSAY: CI is green\nmore");
    let msgs = c.read_until(|v| is_response_to(v, 3));
    assert_eq!(chunk_texts(&msgs), vec!["CI is green"]);
    assert_eq!(stop_reason(msgs.last().unwrap()), "end_turn");
}

#[test]
fn scripted_without_directive_behaves_as_echo() {
    let mut c = start("scripted");
    open_turn(&mut c, "no directive here");
    let msgs = c.read_until(|v| is_response_to(v, 3));
    assert_eq!(chunk_texts(&msgs).concat(), "no directive here");
    assert_eq!(stop_reason(msgs.last().unwrap()), "end_turn");
}

const VERDICT: &str = r#"{"verdict":"mergeable","blocking":[],"suggestions":[]}"#;

#[test]
fn scripted_verdict_block_uses_prompt_nonce() {
    let mut c = start_with(&["--scenario", "scripted", "--arg", VERDICT]);
    open_turn(&mut c, "Review it.\nVerdict nonce: 0123456789abcdef\n");
    let msgs = c.read_until(|v| is_response_to(v, 3));
    let text = chunk_texts(&msgs).concat();
    assert_eq!(
        text,
        format!(
            "<<<AGENTDOCK-VERDICT 0123456789abcdef>>>\n{VERDICT}\n<<<END-AGENTDOCK-VERDICT 0123456789abcdef>>>"
        )
    );
    assert_eq!(text.matches("<<<AGENTDOCK-VERDICT ").count(), 1);
    assert_eq!(stop_reason(msgs.last().unwrap()), "end_turn");
}

#[test]
fn scripted_verdict_nonce_override() {
    let mut c = start_with(&[
        "--scenario",
        "scripted",
        "--arg",
        VERDICT,
        "--nonce",
        "fedcba9876543210",
    ]);
    open_turn(&mut c, "Review it.\nVerdict nonce: 0123456789abcdef\n");
    let msgs = c.read_until(|v| is_response_to(v, 3));
    let text = chunk_texts(&msgs).concat();
    assert!(text.starts_with("<<<AGENTDOCK-VERDICT fedcba9876543210>>>\n"));
    assert!(text.ends_with("\n<<<END-AGENTDOCK-VERDICT fedcba9876543210>>>"));
    assert!(!text.contains("0123456789abcdef"));
}

#[test]
fn scripted_verdict_forwards_malformed_arg_verbatim() {
    let mut c = start_with(&["--scenario", "scripted", "--arg", "{not json"]);
    open_turn(&mut c, "Verdict nonce: 0123456789abcdef");
    let msgs = c.read_until(|v| is_response_to(v, 3));
    assert!(chunk_texts(&msgs).concat().contains("\n{not json\n"));
}

#[test]
fn scripted_reviewer_edit_path_edits_and_prints_no_verdict() {
    let dir = test_dir("reviewer-edit");
    let file = dir.join("reviewer.txt");
    std::fs::write(&file, "original").unwrap();
    let mut c = start_with(&["--scenario", "scripted", "--arg", VERDICT]);
    open_turn(
        &mut c,
        &format!(
            "REVIEWER-EDIT-PATH: {}\nVerdict nonce: 0123456789abcdef\n",
            file.display()
        ),
    );
    c.read_until(is_permission_request);
    send(&mut c, permission_reply("mock-perm-1", ALLOW));
    let rest = c.read_until(|v| is_response_to(v, 3));
    assert!(!chunk_texts(&rest).concat().contains("AGENTDOCK-VERDICT"));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "edited-by-mock");
    drop(c);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn unanswered_requests_get_method_not_found() {
    let mut c = start("echo");
    c.handshake();
    send(
        &mut c,
        json!({"jsonrpc":"2.0","id":9,"method":"no/such","params":{}}),
    );
    let v = c.read_json();
    assert_eq!(v["id"], 9);
    assert_eq!(v["error"]["code"], -32601);
}

#[test]
fn echo_ignores_unparseable_lines_and_exits_on_eof() {
    let mut c = start("echo");
    send_raw(&mut c, "this is not json");
    c.handshake();
    c.close_stdin();
    assert_eq!(c.wait_exit(READ_TIMEOUT), Some(0));
}

#[test]
fn prompt_error_answers_internal_error() {
    let mut c = start("prompt-error");
    open_turn(&mut c, "go");
    let v = c.read_until(|v| is_response_to(v, 3)).pop().unwrap();
    assert_eq!(v["error"]["code"], -32603);
    assert_eq!(v["error"]["message"], "boom");
}

#[test]
fn early_update_follows_session_new_response() {
    let mut c = start("early-update");
    send_raw(&mut c, INIT);
    c.read_json();
    send_raw(&mut c, NEW);
    let new = c.read_json();
    assert!(is_response_to(&new, 2));
    let next = c.read_json();
    assert!(
        chunk_text(&next).is_some(),
        "update right after session/new"
    );
}

#[test]
fn hang_init_never_answers_initialize() {
    let mut c = start("hang-init");
    send_raw(&mut c, INIT);
    assert!(c.read_line(Duration::from_secs(1)).is_none());
    assert!(c.child.try_wait().unwrap().is_none());
}
