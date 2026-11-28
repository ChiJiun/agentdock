//! Scenario behavior. Each scenario lists only what differs from `echo`.

use std::process::{exit, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::wire;
use crate::{send, sleep_bounded, write_raw, Ctx, Msg};

const CANCEL_METHOD: &str = "session/cancel";
const PERM_1: &str = "mock-perm-1";
const PERM_2: &str = "mock-perm-2";
/// Written by the `scripted` edit flow so tests can prove an edit did (not) happen.
const EDIT_MARKER: &str = "edited-by-mock";
const FAKE_TOKEN_ZEROS: usize = 36;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scenario {
    Echo,
    Permission,
    Slow,
    HangInit,
    WrongVersion,
    ExitEarly,
    ExitMidTurn,
    EarlyUpdate,
    BadBytes,
    Oversize,
    UnknownNotification,
    PromptError,
    Stubborn,
    OrphanStdio,
    SleepForever,
    Flood,
    SecretEcho,
    AuthRequired,
    PermissionTwo,
    PermissionFault,
    Scripted,
}

impl Scenario {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "echo" => Self::Echo,
            "permission" => Self::Permission,
            "slow" => Self::Slow,
            "hang-init" => Self::HangInit,
            "wrong-version" => Self::WrongVersion,
            "exit-early" => Self::ExitEarly,
            "exit-mid-turn" => Self::ExitMidTurn,
            "early-update" => Self::EarlyUpdate,
            "bad-bytes" => Self::BadBytes,
            "oversize" => Self::Oversize,
            "unknown-notification" => Self::UnknownNotification,
            "prompt-error" => Self::PromptError,
            "stubborn" => Self::Stubborn,
            "orphan-stdio" => Self::OrphanStdio,
            "sleep-forever" => Self::SleepForever,
            "flood" => Self::Flood,
            "secret-echo" => Self::SecretEcho,
            "auth-required" => Self::AuthRequired,
            "permission-two" => Self::PermissionTwo,
            "permission-fault" => Self::PermissionFault,
            "scripted" => Self::Scripted,
            _ => return None,
        })
    }
}

/// Handles one message from the main loop. Requests (`id` + `method`) are always answered
/// unless the scenario says otherwise; notifications and stray responses are ignored.
pub fn dispatch(ctx: &Ctx, msg: &Value) {
    let (Some(method), Some(id)) = (msg.get("method").and_then(Value::as_str), msg.get("id"))
    else {
        return;
    };
    let params = msg.get("params");
    match method {
        "initialize" => match ctx.scenario {
            Scenario::HangInit => {}
            Scenario::WrongVersion => send(&wire::result(id, wire::initialize_result(2))),
            Scenario::AuthRequired => send(&wire::result(id, wire::initialize_result_with_auth())),
            _ => send(&wire::result(id, wire::initialize_result(1))),
        },
        "session/new" => match ctx.scenario {
            Scenario::AuthRequired => {
                send(&wire::error(id, -32000, "Authentication required"));
            }
            Scenario::EarlyUpdate => {
                send(&wire::result(id, wire::new_session_result()));
                // Right after the response: the client may not have stored the session id yet.
                send(&wire::text_chunk("early update"));
            }
            _ => send(&wire::result(id, wire::new_session_result())),
        },
        "session/prompt" => run_prompt(ctx, id, &prompt_text(params)),
        _ => send(&wire::error(id, -32601, "Method not found")),
    }
}

/// Called when stdin reached EOF and the main loop ended.
pub fn after_eof(ctx: &Ctx) {
    if ctx.scenario == Scenario::Stubborn {
        // Ignores stdin EOF on purpose; bounded so a failing test cannot leak it forever.
        sleep_bounded();
    }
}

fn run_prompt(ctx: &Ctx, id: &Value, text: &str) {
    match ctx.scenario {
        Scenario::Permission => permission(ctx, id),
        Scenario::Slow => slow(ctx, id),
        Scenario::ExitMidTurn => {
            send(&wire::text_chunk("partial reply"));
            exit(4);
        }
        Scenario::BadBytes => {
            write_raw(&[0xFF, 0xFE, 0xC3, 0x28, b'\n']);
            write_raw(b"this is not json\n");
            send(&wire::text_chunk("still connected after bad bytes"));
            end_turn(id);
        }
        Scenario::Oversize => {
            oversize();
        }
        Scenario::UnknownNotification => {
            send(&wire::vendor_ping());
            send(&wire::text_chunk_with_meta("update with _meta"));
            echo(id, text);
        }
        Scenario::PromptError => send(&wire::error(id, -32603, "boom")),
        Scenario::Stubborn => {
            let pid = spawn_grandchild(false);
            send(&wire::text_chunk(&format!("grandchild pid {pid}")));
            end_turn(id);
        }
        Scenario::OrphanStdio => {
            // The grandchild inherits stdout, so the pipe stays open after this process exits.
            // The pid text is an addition to the spec so tests can clean the grandchild up.
            let pid = spawn_grandchild(true);
            send(&wire::text_chunk(&format!("grandchild pid {pid}")));
            end_turn(id);
            std::thread::sleep(Duration::from_millis(100));
            exit(0);
        }
        Scenario::Flood => {
            for _ in 0..10_000 {
                send(&wire::text_chunk("0123456789"));
            }
            end_turn(id);
        }
        Scenario::SecretEcho => {
            let token = format!("ghp_{}", "0".repeat(FAKE_TOKEN_ZEROS));
            send(&wire::text_chunk(&format!("token {token} end")));
            end_turn(id);
        }
        Scenario::PermissionTwo => permission_two(ctx, id),
        Scenario::PermissionFault => permission_fault(ctx),
        Scenario::Scripted => scripted(ctx, id, text),
        // The remaining scenarios fail earlier (initialize/session/new) or never read stdin.
        Scenario::Echo
        | Scenario::HangInit
        | Scenario::WrongVersion
        | Scenario::ExitEarly
        | Scenario::EarlyUpdate
        | Scenario::SleepForever
        | Scenario::AuthRequired => echo(id, text),
    }
}

fn end_turn(id: &Value) {
    send(&wire::result(id, wire::prompt_result("end_turn")));
}

fn cancelled(id: &Value) {
    send(&wire::result(id, wire::prompt_result("cancelled")));
}

/// First `text` block of `session/prompt`.
fn prompt_text(params: Option<&Value>) -> String {
    params
        .and_then(|p| p.get("prompt"))
        .and_then(Value::as_array)
        .and_then(|blocks| {
            blocks
                .iter()
                .find(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        })
        .and_then(|b| b.get("text"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// Splits the text into 3 chunks on char boundaries; the chunks concatenate to the input.
fn echo(id: &Value, text: &str) {
    let chars: Vec<char> = text.chars().collect();
    let size = chars.len().div_ceil(3).max(1);
    let mut chunks: Vec<String> = chars.chunks(size).map(|c| c.iter().collect()).collect();
    chunks.resize(3, String::new());
    for chunk in &chunks {
        send(&wire::text_chunk(chunk));
    }
    end_turn(id);
}

fn is_cancel(msg: &Value) -> bool {
    msg.get("method").and_then(Value::as_str) == Some(CANCEL_METHOD)
}

/// Requests that arrive while a scenario waits are still answered.
fn answer_stray(msg: &Value) {
    if let (Some(_), Some(id)) = (msg.get("method"), msg.get("id")) {
        send(&wire::error(id, -32601, "Method not found"));
    }
}

/// Waits up to `dur`; true when `session/cancel` arrived. EOF ends the process.
fn wait_or_cancel(ctx: &Ctx, dur: Duration) -> bool {
    let deadline = Instant::now() + dur;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match ctx.recv_timeout(left) {
            None => return false,
            Some(Msg::Eof) => exit(0),
            Some(Msg::Json(m)) if is_cancel(&m) => return true,
            Some(Msg::Json(m)) => answer_stray(&m),
        }
    }
}

/// Blocks until `session/cancel` arrives, ignoring everything else. EOF ends the process.
fn wait_for_cancel(ctx: &Ctx) {
    loop {
        match ctx.recv() {
            Msg::Eof => exit(0),
            Msg::Json(m) if is_cancel(&m) => return,
            Msg::Json(m) => answer_stray(&m),
        }
    }
}

fn slow(ctx: &Ctx, id: &Value) {
    for i in 0..50 {
        send(&wire::text_chunk(&format!("chunk {i} ")));
        if wait_or_cancel(ctx, Duration::from_millis(200)) {
            cancelled(id);
            return;
        }
    }
    end_turn(id);
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Answer {
    Selected(String),
    Cancelled,
}

impl Answer {
    /// Parses a client response to `session/request_permission`. An error response or an
    /// unrecognizable shape counts as cancelled.
    fn from_response(msg: &Value) -> Self {
        let outcome = msg.get("result").and_then(|r| r.get("outcome"));
        let kind = outcome
            .and_then(|o| o.get("outcome"))
            .and_then(Value::as_str);
        match (kind, outcome.and_then(|o| o.get("optionId"))) {
            (Some("selected"), Some(Value::String(option))) => Self::Selected(option.clone()),
            _ => Self::Cancelled,
        }
    }

    /// `<optionId or cancelled>`, as used by the `permission-two` text.
    fn label(&self) -> &str {
        match self {
            Self::Selected(option) => option,
            Self::Cancelled => "cancelled",
        }
    }
}

/// Waits for the responses to the given request ids (any order). `None` when
/// `session/cancel` arrives first. EOF ends the process.
fn wait_answers(ctx: &Ctx, ids: &[&str]) -> Option<Vec<Answer>> {
    let mut answers: Vec<Option<Answer>> = vec![None; ids.len()];
    loop {
        match ctx.recv() {
            Msg::Eof => exit(0),
            Msg::Json(m) if is_cancel(&m) => return None,
            Msg::Json(m) => {
                let slot = m
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|_| m.get("method").is_none())
                    .and_then(|got| ids.iter().position(|want| *want == got));
                match slot {
                    Some(i) => answers[i] = Some(Answer::from_response(&m)),
                    None => answer_stray(&m),
                }
            }
        }
        if answers.iter().all(Option::is_some) {
            return Some(answers.into_iter().flatten().collect());
        }
    }
}

fn permission(ctx: &Ctx, id: &Value) {
    send(&wire::tool_call("call_1", "Run tests", "cargo test"));
    send(&wire::request_permission(PERM_1, "call_1", "Run tests"));
    let answer = wait_answers(ctx, &[PERM_1]).and_then(|a| a.into_iter().next());
    finish_single_permission(id, answer, || Ok(()));
}

/// Shared tail of `permission` and the scripted edit flow. `on_allow` performs the side effect
/// of an allowed tool call; an `Err` marks the tool call failed.
fn finish_single_permission(
    id: &Value,
    answer: Option<Answer>,
    on_allow: impl FnOnce() -> Result<(), String>,
) {
    match answer {
        None | Some(Answer::Cancelled) => cancelled(id),
        Some(Answer::Selected(option)) if option == "allow-once" => match on_allow() {
            Ok(()) => {
                send(&wire::tool_call_done("call_1", "completed"));
                send(&wire::text_chunk("approved"));
                end_turn(id);
            }
            Err(_) => {
                send(&wire::tool_call_done("call_1", "failed"));
                send(&wire::text_chunk("edit failed"));
                end_turn(id);
            }
        },
        // `reject-once` and any option id the mock did not offer.
        Some(Answer::Selected(_)) => {
            send(&wire::tool_call_done("call_1", "failed"));
            send(&wire::text_chunk("denied"));
            end_turn(id);
        }
    }
}

fn permission_two(ctx: &Ctx, id: &Value) {
    send(&wire::tool_call("call_1", "Run tests", "cargo test"));
    send(&wire::tool_call("call_2", "Run lint", "cargo clippy"));
    // Back to back, before any answer: a parallel-permission agent.
    send(&wire::request_permission(PERM_1, "call_1", "Run tests"));
    send(&wire::request_permission(PERM_2, "call_2", "Run lint"));
    let Some(answers) = wait_answers(ctx, &[PERM_1, PERM_2]) else {
        cancelled(id);
        return;
    };
    let label = |i: usize| answers.get(i).map_or("cancelled", Answer::label);
    send(&wire::text_chunk(&format!(
        "perm1={} perm2={}",
        label(0),
        label(1)
    )));
    if answers.contains(&Answer::Cancelled) {
        cancelled(id);
    } else {
        end_turn(id);
    }
}

fn permission_fault(ctx: &Ctx) {
    send(&wire::tool_call("call_1", "Run tests", "cargo test"));
    send(&wire::request_permission(PERM_1, "call_1", "Run tests"));
    std::thread::sleep(Duration::from_millis(300));
    match ctx.arg.as_deref() {
        Some("oversize") => oversize(),
        // `exit` and the default.
        _ => exit(5),
    }
}

/// 64 MiB of `A` (1 MiB per write) without a newline, then sleep.
fn oversize() {
    let block = vec![b'A'; 1024 * 1024];
    for _ in 0..64 {
        write_raw(&block);
    }
    sleep_bounded();
    exit(0);
}

/// Starts this binary as `--scenario sleep-forever` and returns its pid (0 if it did not start).
/// stdin and stderr are always null; stdout is inherited only for `orphan-stdio`.
// The grandchild is meant to outlive the mock, so the "zombie process" lint does not apply.
#[allow(clippy::zombie_processes)]
fn spawn_grandchild(inherit_stdout: bool) -> u32 {
    let Ok(exe) = std::env::current_exe() else {
        return 0;
    };
    let stdout = if inherit_stdout {
        Stdio::inherit()
    } else {
        Stdio::null()
    };
    Command::new(exe)
        .args(["--scenario", "sleep-forever"])
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(Stdio::null())
        .spawn()
        .map_or(0, |child| child.id())
}

// ---- scripted ----------------------------------------------------------------------------

/// Value of the first line that is exactly `NAME: value` (matched at the start of the line,
/// case-sensitively; a trailing `\r` is ignored).
fn directive<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    text.lines().find_map(|line| {
        line.strip_prefix(name)
            .and_then(|rest| rest.strip_prefix(':'))
            .map(str::trim)
    })
}

#[derive(Clone, Copy)]
enum OnCancel {
    Exit,
    Oversize,
    Ignore,
    End,
}

impl OnCancel {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "exit" => Some(Self::Exit),
            "oversize" => Some(Self::Oversize),
            "ignore" => Some(Self::Ignore),
            "end" => Some(Self::End),
            _ => None,
        }
    }
}

fn scripted(ctx: &Ctx, id: &Value, text: &str) {
    let prompt_nonce = directive(text, "Verdict nonce");
    let on_cancel = directive(text, "ON-CANCEL").and_then(OnCancel::parse);
    if let (Some(path), Some(_)) = (directive(text, "REVIEWER-EDIT-PATH"), prompt_nonce) {
        scripted_edit(ctx, id, path, on_cancel);
    } else if let (Some(nonce), Some(verdict)) = (prompt_nonce, ctx.arg.as_deref()) {
        // `--nonce` overrides the nonce found in the prompt.
        let n = ctx.nonce.as_deref().unwrap_or(nonce);
        send(&wire::text_chunk(&format!(
            "<<<AGENTDOCK-VERDICT {n}>>>\n{verdict}\n<<<END-AGENTDOCK-VERDICT {n}>>>"
        )));
        end_turn(id);
    } else if let Some(path) = directive(text, "EDIT-PATH") {
        scripted_edit(ctx, id, path, on_cancel);
    } else if let Some(say) = directive(text, "SAY") {
        send(&wire::text_chunk(say));
        end_turn(id);
    } else {
        echo(id, text);
    }
}

fn scripted_edit(ctx: &Ctx, id: &Value, path: &str, on_cancel: Option<OnCancel>) {
    send(&wire::tool_call(
        "call_1",
        "Edit file",
        &format!("edit {path}"),
    ));
    send(&wire::request_permission_edit(
        PERM_1,
        "call_1",
        "Edit file",
        path,
    ));
    if let Some(mode) = on_cancel {
        // The permission answer is ignored; only `session/cancel` moves the mock on.
        wait_for_cancel(ctx);
        match mode {
            OnCancel::Exit => exit(6),
            OnCancel::Oversize => oversize(),
            OnCancel::Ignore => {
                sleep_bounded();
                exit(0);
            }
            OnCancel::End => cancelled(id),
        }
        return;
    }
    let answer = wait_answers(ctx, &[PERM_1]).and_then(|a| a.into_iter().next());
    finish_single_permission(id, answer, || {
        std::fs::write(path, EDIT_MARKER).map_err(|e| e.to_string())
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::SESSION_ID;
    use serde_json::json;

    #[test]
    fn directive_matches_whole_line_prefix_case_sensitively() {
        let text = "intro\nSAY: hello world \r\nsay: lower\n  SAY: indented";
        assert_eq!(directive(text, "SAY"), Some("hello world"));
        assert_eq!(directive("say: x", "SAY"), None);
        assert_eq!(directive("SAYING: x", "SAY"), None);
        assert_eq!(directive("no directive", "SAY"), None);
    }

    #[test]
    fn prompt_text_takes_first_text_block() {
        let params = json!({"sessionId": SESSION_ID, "prompt": [
            {"type": "image", "data": "x"},
            {"type": "text", "text": "first"},
            {"type": "text", "text": "second"}]});
        assert_eq!(prompt_text(Some(&params)), "first");
        assert_eq!(prompt_text(None), "");
    }

    #[test]
    fn answer_parses_outcome_shapes() {
        let selected =
            json!({"result": {"outcome": {"outcome": "selected", "optionId": "allow-once"}}});
        let cancelled = json!({"result": {"outcome": {"outcome": "cancelled"}}});
        let error = json!({"error": {"code": -1, "message": "x"}});
        assert_eq!(
            Answer::from_response(&selected),
            Answer::Selected("allow-once".into())
        );
        assert_eq!(Answer::from_response(&cancelled), Answer::Cancelled);
        assert_eq!(Answer::from_response(&error), Answer::Cancelled);
    }

    #[test]
    fn every_listed_scenario_parses() {
        for name in [
            "echo",
            "permission",
            "slow",
            "hang-init",
            "wrong-version",
            "exit-early",
            "exit-mid-turn",
            "early-update",
            "bad-bytes",
            "oversize",
            "unknown-notification",
            "prompt-error",
            "stubborn",
            "orphan-stdio",
            "sleep-forever",
            "flood",
            "secret-echo",
            "auth-required",
            "permission-two",
            "permission-fault",
            "scripted",
        ] {
            assert!(Scenario::parse(name).is_some(), "{name}");
        }
        assert!(Scenario::parse("nope").is_none());
    }
}
