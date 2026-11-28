//! Helpers for the P3-4 facade tests: the mock agent binary, temporary directories, process
//! checks and event waits. Every process these helpers kill is one the test started.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use agentdock_acp::{AcpEvent, PermissionOptionView, PermissionTicket};
use agentdock_process::AgentCommand;
use serde_json::Value;
use tokio::sync::mpsc::Receiver;

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

/// Path of the `agentdock-mock-agent` debug binary. This crate cannot use another crate's
/// `CARGO_BIN_EXE_*`, so it is built once per test process with `cargo build`.
pub fn mock_agent() -> PathBuf {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    PATH.get_or_init(|| {
        let root = workspace_root();
        let status = std::process::Command::new(env!("CARGO"))
            .args(["build", "-q", "-p", "agentdock-mock-agent"])
            .current_dir(&root)
            .status()
            .expect("run cargo build -p agentdock-mock-agent");
        assert!(
            status.success(),
            "building the mock agent failed: {status:?}"
        );
        let target = match std::env::var_os("CARGO_TARGET_DIR").map(PathBuf::from) {
            Some(dir) if dir.is_absolute() => dir,
            Some(dir) => root.join(dir),
            None => root.join("target"),
        };
        let mut path = target.join("debug").join("agentdock-mock-agent");
        if cfg!(windows) {
            path.set_extension("exe");
        }
        assert!(path.is_file(), "mock agent not found at {}", path.display());
        path
    })
    .clone()
}

/// A directory whose name contains a space and CJK characters (CONVENTIONS §5); removed on
/// drop.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(tag: &str) -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!(
            "agent dock 測試-{tag}-{}-{n}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn command(program: PathBuf, scenario: &str, cwd: &Path) -> AgentCommand {
    AgentCommand {
        program,
        args: vec!["--scenario".into(), scenario.into()],
        cwd: cwd.to_path_buf(),
        auth_env_names: vec![],
        extra_env: vec![],
    }
}

/// A copy of the mock agent with a unique file name inside `dir`, for tests that must prove
/// "no process of this run is left" without knowing a pid (`start` failed, so there is no
/// connection to ask).
pub fn unique_mock_copy(dir: &TempDir, tag: &str) -> PathBuf {
    let mut name = format!("agentdock-mock-agent-{tag}-{}", std::process::id());
    if cfg!(windows) {
        name.push_str(".exe");
    }
    let path = dir.path().join(name);
    std::fs::copy(mock_agent(), &path).expect("copy mock agent");
    path
}

#[cfg(windows)]
fn system32(exe: &str) -> PathBuf {
    let root = std::env::var_os("SystemRoot").expect("SystemRoot");
    Path::new(&root).join("System32").join(exe)
}

#[cfg(windows)]
fn tasklist_rows(filter: &str) -> Vec<String> {
    let out = std::process::Command::new(system32("tasklist.exe"))
        .args(["/FI", filter, "/NH", "/FO", "CSV"])
        .output()
        .expect("run tasklist");
    assert!(out.status.success(), "tasklist failed: {:?}", out.status);
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| l.starts_with('"'))
        .map(str::to_owned)
        .collect()
}

/// True when `pid` is a live mock-agent process (a reused pid of another program is not ours).
#[cfg(windows)]
pub fn process_alive(pid: u32) -> bool {
    let want = format!("\"{pid}\"");
    tasklist_rows(&format!("PID eq {pid}")).iter().any(|row| {
        let mut fields = row.split(',');
        let image = fields.next().unwrap_or_default();
        fields.next() == Some(want.as_str()) && image.contains("agentdock-mock-agent")
    })
}

#[cfg(unix)]
fn proc_entries() -> Vec<(u32, String, bool)> {
    let mut out = vec![];
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return out;
    };
    for entry in dir.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        let path = entry.path();
        let cmdline = std::fs::read(path.join("cmdline")).unwrap_or_default();
        let stat = std::fs::read_to_string(path.join("stat")).unwrap_or_default();
        // A zombie counts as gone. Field 3 follows the ")" that closes the command name.
        let zombie = stat
            .rsplit_once(')')
            .is_some_and(|(_, rest)| rest.trim_start().starts_with('Z'));
        out.push((pid, String::from_utf8_lossy(&cmdline).into_owned(), zombie));
    }
    out
}

#[cfg(unix)]
pub fn process_alive(pid: u32) -> bool {
    proc_entries().iter().any(|(p, cmdline, zombie)| {
        *p == pid && !zombie && cmdline.contains("agentdock-mock-agent")
    })
}

/// True while any process runs the executable at `path` (a [`unique_mock_copy`]).
pub fn image_running(path: &Path) -> bool {
    #[cfg(windows)]
    {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let want = format!("\"{name}\"");
        tasklist_rows(&format!("IMAGENAME eq {name}"))
            .iter()
            .any(|row| row.split(',').next() == Some(want.as_str()))
    }
    #[cfg(unix)]
    {
        let needle = path.to_string_lossy().into_owned();
        proc_entries()
            .iter()
            .any(|(_, cmdline, zombie)| !zombie && cmdline.contains(&needle))
    }
}

/// Polls every 100 ms until `alive` turns false or `limit` elapses.
pub async fn gone_within(limit: Duration, mut alive: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + limit;
    loop {
        if !alive() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Last-resort cleanup after a failed assertion, so a failing test leaves no orphan. Only ever
/// called with pids this test started.
pub fn force_kill(pid: u32) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new(system32("taskkill.exe"))
            .args(["/PID", &pid.to_string(), "/F"])
            .output();
    }
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("/bin/kill")
            .args(["-9", &pid.to_string()])
            .output();
    }
}

/// Last-resort cleanup for a [`unique_mock_copy`]: kills processes of that image only.
pub fn force_kill_image(path: &Path) {
    #[cfg(windows)]
    {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let _ = std::process::Command::new(system32("taskkill.exe"))
            .args(["/IM", &name, "/F"])
            .output();
    }
    #[cfg(unix)]
    {
        let needle = path.to_string_lossy().into_owned();
        for (pid, cmdline, _) in proc_entries() {
            if cmdline.contains(&needle) {
                force_kill(pid);
            }
        }
    }
}

pub async fn next_event(rx: &mut Receiver<AcpEvent>, limit: Duration) -> Option<AcpEvent> {
    tokio::time::timeout(limit, rx.recv()).await.ok().flatten()
}

/// Text of an `agent_message_chunk` update.
pub fn chunk_text(update: &Value) -> Option<&str> {
    (update["sessionUpdate"] == "agent_message_chunk")
        .then(|| update["content"]["text"].as_str())
        .flatten()
}

pub struct Permission {
    pub ticket: PermissionTicket,
    pub tool_call: Value,
    pub options: Vec<PermissionOptionView>,
}

/// Waits for the next `PermissionRequested`, appending the text of skipped updates to `text`.
pub async fn wait_permission(rx: &mut Receiver<AcpEvent>, text: &mut String) -> Permission {
    loop {
        match next_event(rx, Duration::from_secs(20)).await {
            Some(AcpEvent::PermissionRequested {
                ticket,
                tool_call,
                options,
                ..
            }) => {
                return Permission {
                    ticket,
                    tool_call,
                    options,
                }
            }
            Some(AcpEvent::SessionUpdate { update, .. }) => {
                text.push_str(chunk_text(&update).unwrap_or_default());
            }
            other => panic!("expected a permission request, got {other:?}"),
        }
    }
}

/// Reads events for `window`; returns the update text and every non-update event.
pub async fn drain_for(rx: &mut Receiver<AcpEvent>, window: Duration) -> (String, Vec<AcpEvent>) {
    let deadline = Instant::now() + window;
    let mut text = String::new();
    let mut others = vec![];
    while let Ok(Some(event)) =
        tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), rx.recv()).await
    {
        match event {
            AcpEvent::SessionUpdate { update, .. } => {
                text.push_str(chunk_text(&update).unwrap_or_default());
            }
            other => others.push(other),
        }
    }
    (text, others)
}

/// Everything already in the channel, without waiting.
pub fn drain_now(rx: &mut Receiver<AcpEvent>) -> (String, Vec<AcpEvent>) {
    let mut text = String::new();
    let mut others = vec![];
    while let Ok(event) = rx.try_recv() {
        match event {
            AcpEvent::SessionUpdate { update, .. } => {
                text.push_str(chunk_text(&update).unwrap_or_default());
            }
            other => others.push(other),
        }
    }
    (text, others)
}
