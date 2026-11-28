//! `agentdock-mock-agent`: a test-only ACP agent that speaks raw NDJSON on stdin/stdout.
//!
//! It deliberately does **not** use the ACP SDK: the hostile scenarios must break the protocol
//! on purpose (wrong version, invalid UTF-8, oversized lines). Never shipped with the app.

#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod scenarios;
mod wire;

use std::io::{BufRead, BufReader, Write};
use std::process::exit;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

use scenarios::Scenario;
use serde_json::Value;

/// Upper bound for every sleep, so a failing test never leaves a permanent process.
pub const MAX_SLEEP: Duration = Duration::from_secs(600);

/// What the reader thread forwards to the scenario logic.
pub enum Msg {
    Json(Value),
    Eof,
}

/// Parsed command line plus the channel fed by the stdin reader thread.
pub struct Ctx {
    pub scenario: Scenario,
    /// `--arg`, read only by `permission-fault` and `scripted`.
    pub arg: Option<String>,
    /// `--nonce`, read only by `scripted`.
    pub nonce: Option<String>,
    rx: Receiver<Msg>,
}

impl Ctx {
    /// Blocks until the next message. A closed channel counts as EOF.
    pub fn recv(&self) -> Msg {
        self.rx.recv().unwrap_or(Msg::Eof)
    }

    /// `None` means the timeout elapsed.
    pub fn recv_timeout(&self, timeout: Duration) -> Option<Msg> {
        match self.rx.recv_timeout(timeout) {
            Ok(msg) => Some(msg),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => Some(Msg::Eof),
        }
    }
}

/// Writes raw bytes to stdout and flushes. A failed write (the client closed the pipe) ends the
/// process cleanly.
pub fn write_raw(bytes: &[u8]) {
    let mut out = std::io::stdout().lock();
    if out.write_all(bytes).and_then(|()| out.flush()).is_err() {
        exit(0);
    }
}

/// Writes one JSON-RPC message as one line.
pub fn send(v: &Value) {
    if let Ok(mut bytes) = serde_json::to_vec(v) {
        bytes.push(b'\n');
        write_raw(&bytes);
    }
}

/// Sleeps for at most [`MAX_SLEEP`].
pub fn sleep_bounded() {
    std::thread::sleep(MAX_SLEEP);
}

struct Config {
    scenario: Scenario,
    arg: Option<String>,
    nonce: Option<String>,
}

fn usage_exit(message: &str) -> ! {
    eprintln!("{message}");
    eprintln!("usage: agentdock-mock-agent [--scenario <name>] [--arg <text>] [--nonce <hex>]");
    exit(2);
}

fn parse_args() -> Config {
    let mut scenario_name = String::from("echo");
    let mut arg = None;
    let mut nonce = None;
    let mut args = std::env::args_os().skip(1);
    while let Some(flag) = args.next() {
        let flag = flag.to_string_lossy().into_owned();
        let mut value = |name: &str| match args.next() {
            Some(v) => v.to_string_lossy().into_owned(),
            None => usage_exit(&format!("missing value for {name}")),
        };
        match flag.as_str() {
            "--scenario" => scenario_name = value("--scenario"),
            "--arg" => arg = Some(value("--arg")),
            "--nonce" => nonce = Some(value("--nonce")),
            other => usage_exit(&format!("unknown argument {other}")),
        }
    }
    match Scenario::parse(&scenario_name) {
        Some(scenario) => Config {
            scenario,
            arg,
            nonce,
        },
        None => {
            eprintln!("unknown scenario");
            exit(2);
        }
    }
}

/// One thread reads stdin: each `\n`-separated segment that parses as JSON is forwarded, the
/// rest is ignored (the mock does not test its own parser). EOF is forwarded once.
fn spawn_reader() -> Receiver<Msg> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for segment in BufReader::new(stdin.lock()).split(b'\n') {
            let Ok(bytes) = segment else { break };
            if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                if tx.send(Msg::Json(v)).is_err() {
                    return;
                }
            }
        }
        let _ = tx.send(Msg::Eof);
    });
    rx
}

fn main() {
    let cfg = parse_args();
    match cfg.scenario {
        Scenario::ExitEarly => exit(3),
        // Never reads stdin: it must survive the client closing it.
        Scenario::SleepForever => {
            sleep_bounded();
            exit(0);
        }
        _ => {}
    }
    let ctx = Ctx {
        scenario: cfg.scenario,
        arg: cfg.arg,
        nonce: cfg.nonce,
        rx: spawn_reader(),
    };
    while let Msg::Json(msg) = ctx.recv() {
        scenarios::dispatch(&ctx, &msg);
    }
    scenarios::after_eof(&ctx);
}
