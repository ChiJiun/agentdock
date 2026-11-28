//! P3-2 §6 process-tree tests. Run with `-- --test-threads=1` for clean timing.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use agentdock_process::{
    AgentCommand, AgentProcess, ExitKind, ProcessError, ShutdownTimeouts, STDERR_TAIL_CAP,
};
use tokio::io::{AsyncBufReadExt, BufReader, Lines};
use tokio::process::ChildStdout;

const SPAWN_TREE: &str = env!("CARGO_BIN_EXE_agentdock-test-spawn-tree");
#[cfg(windows)]
const SUPERVISOR_HOST: &str = env!("CARGO_BIN_EXE_agentdock-test-supervisor-host");

const FAST: ShutdownTimeouts = ShutdownTimeouts {
    stdin_grace: Duration::from_millis(300),
    term_grace: Duration::from_secs(3),
};

/// For tests that expect a graceful exit: a fresh helper exe can take well over 1.5 s to start
/// on Windows (Defender scans it on first launch), so the grace is generous here.
const PATIENT: ShutdownTimeouts = ShutdownTimeouts {
    stdin_grace: Duration::from_secs(10),
    term_grace: Duration::from_secs(3),
};

fn tree_cmd(args: &[&str]) -> AgentCommand {
    AgentCommand {
        program: PathBuf::from(SPAWN_TREE),
        args: args.iter().map(|s| s.to_string()).collect(),
        cwd: std::env::temp_dir(),
        auth_env_names: vec![],
        extra_env: vec![],
    }
}

/// Reads `CHILD_PID=` and `SELF_PID=` from the helper's stdout.
async fn read_pids(lines: &mut Lines<BufReader<ChildStdout>>) -> (u32, u32) {
    let mut child = None;
    let mut me = None;
    let read = async {
        while child.is_none() || me.is_none() {
            let line = lines
                .next_line()
                .await
                .unwrap()
                .expect("helper stdout closed");
            if let Some(v) = line.strip_prefix("CHILD_PID=") {
                child = Some(v.trim().parse().unwrap());
            } else if let Some(v) = line.strip_prefix("SELF_PID=") {
                me = Some(v.trim().parse().unwrap());
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(10), read)
        .await
        .expect("helper did not print its PIDs");
    (child.unwrap(), me.unwrap())
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    let root = std::env::var_os("SystemRoot").expect("SystemRoot");
    let tasklist = Path::new(&root).join("System32").join("tasklist.exe");
    let out = std::process::Command::new(tasklist)
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .output()
        .expect("run tasklist");
    assert!(out.status.success(), "tasklist failed: {:?}", out.status);
    let text = String::from_utf8_lossy(&out.stdout);
    let want = format!("\"{pid}\"");
    // CSV row: "image","pid",...; check the image too so a reused PID is not mistaken for ours.
    text.lines().any(|l| {
        let mut fields = l.split(',');
        let image = fields.next().unwrap_or_default();
        fields.next() == Some(want.as_str()) && image.contains("agentdock-test-")
    })
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    let status = std::process::Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .expect("run /bin/kill");
    if !status.success() {
        return false;
    }
    let proc_dir = Path::new("/proc").join(pid.to_string());
    if let Ok(stat) = std::fs::read_to_string(proc_dir.join("stat")) {
        // A zombie counts as gone. Field 3 follows the ")" that closes the command name.
        let state = stat.rsplit_once(')').map(|(_, rest)| rest.trim_start());
        if state.is_some_and(|s| s.starts_with('Z')) {
            return false;
        }
        // A reused PID is not ours.
        let cmdline = std::fs::read(proc_dir.join("cmdline")).unwrap_or_default();
        return String::from_utf8_lossy(&cmdline).contains("agentdock-test-");
    }
    true
}

/// Polls every 100 ms for up to 5 s.
async fn gone_within_5s(pid: u32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if !process_alive(pid) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Last-resort cleanup for a failed assertion, so a failing test does not leave orphans.
/// Only ever called with PIDs this test started.
fn force_kill(pid: u32) {
    #[cfg(windows)]
    {
        let root = std::env::var_os("SystemRoot").expect("SystemRoot");
        let taskkill = Path::new(&root).join("System32").join("taskkill.exe");
        let _ = std::process::Command::new(taskkill)
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

async fn assert_gone(pids: &[u32]) {
    let mut alive = vec![];
    for &pid in pids {
        if !gone_within_5s(pid).await {
            alive.push(pid);
        }
    }
    for &pid in &alive {
        force_kill(pid);
    }
    assert!(alive.is_empty(), "still running after 5 s: {alive:?}");
}

#[tokio::test]
async fn rejects_relative_program() {
    let mut cmd = tree_cmd(&[]);
    cmd.program = PathBuf::from("node");
    assert!(matches!(
        AgentProcess::spawn(&cmd),
        Err(ProcessError::RelativeProgram)
    ));
}

#[cfg(windows)]
#[tokio::test]
async fn rejects_cmd_shim_case_insensitive() {
    let mut cmd = tree_cmd(&[]);
    cmd.program = PathBuf::from(r"C:\x\claude-agent-acp.CMD");
    match AgentProcess::spawn(&cmd) {
        Err(ProcessError::ShellShim { ext }) => assert_eq!(ext, "cmd"),
        other => panic!("expected ShellShim, got {other:?}"),
    }
}

#[tokio::test]
async fn shutdown_kills_grandchild() {
    let mut agent = AgentProcess::spawn(&tree_cmd(&[])).unwrap();
    let (stdin, stdout) = agent.take_stdio().unwrap();
    let (child, me) = read_pids(&mut BufReader::new(stdout).lines()).await;
    assert!(process_alive(child), "grandchild should be running");
    drop(stdin);
    assert_eq!(agent.shutdown(FAST).await, ExitKind::Terminated);
    assert_gone(&[child, me]).await;
}

#[tokio::test]
async fn agent_crash_still_reaps_grandchild() {
    let mut agent = AgentProcess::spawn(&tree_cmd(&[])).unwrap();
    let (stdin, stdout) = agent.take_stdio().unwrap();
    let (child, me) = read_pids(&mut BufReader::new(stdout).lines()).await;

    // Kill only the direct child: no /T on Windows, a single PID on Unix.
    #[cfg(windows)]
    let status = {
        let root = std::env::var_os("SystemRoot").unwrap();
        let taskkill = Path::new(&root).join("System32").join("taskkill.exe");
        std::process::Command::new(taskkill)
            .args(["/PID", &me.to_string(), "/F"])
            .output()
            .unwrap()
            .status
    };
    #[cfg(unix)]
    let status = std::process::Command::new("/bin/kill")
        .args(["-9", &me.to_string()])
        .status()
        .unwrap();
    assert!(status.success());

    tokio::time::timeout(Duration::from_secs(5), agent.wait())
        .await
        .expect("direct child did not exit")
        .unwrap();
    assert!(
        process_alive(child),
        "grandchild must outlive its parent here"
    );

    drop(stdin);
    let kind = agent.shutdown(FAST).await;
    assert!(matches!(kind, ExitKind::Exited { .. }), "{kind:?}");
    assert_gone(&[child]).await;
}

#[tokio::test]
async fn drop_without_shutdown_reaps_tree() {
    let mut agent = AgentProcess::spawn(&tree_cmd(&[])).unwrap();
    let (stdin, stdout) = agent.take_stdio().unwrap();
    let (child, me) = read_pids(&mut BufReader::new(stdout).lines()).await;
    drop(stdin);
    drop(agent);
    assert_gone(&[child, me]).await;
}

/// The most important test: AgentDock itself is killed (TerminateProcess, same as `taskkill /F`)
/// and KILL_ON_JOB_CLOSE must take the agent tree down.
#[cfg(windows)]
#[tokio::test]
async fn host_killed_reaps_tree() {
    use std::io::BufRead;
    use std::process::{Child, Command, Stdio};

    /// Kills the supervisor host if an assertion fails before the test kills it, so a failure
    /// does not leave the host (and, through it, the agent tree) running.
    struct HostGuard(Child);
    impl Drop for HostGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    let mut host = HostGuard(
        Command::new(SUPERVISOR_HOST)
            .arg(SPAWN_TREE)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let host_pid = host.0.id();
    let stdout = host.0.stdout.take().unwrap();
    let pids = std::thread::spawn(move || {
        let (mut child, mut me) = (None, None);
        for line in std::io::BufReader::new(stdout).lines() {
            let line = line.unwrap();
            if let Some(v) = line.strip_prefix("CHILD_PID=") {
                child = Some(v.trim().parse::<u32>().unwrap());
            } else if let Some(v) = line.strip_prefix("SELF_PID=") {
                me = Some(v.trim().parse::<u32>().unwrap());
            }
            if child.is_some() && me.is_some() {
                break;
            }
        }
        (child, me)
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while !pids.is_finished() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    if !pids.is_finished() {
        panic!("supervisor host did not print the PIDs");
    }
    let (child, me) = pids.join().unwrap();
    let (child, me) = (child.unwrap(), me.unwrap());
    assert!(process_alive(child) && process_alive(me));

    host.0.kill().unwrap();
    host.0.wait().unwrap();
    assert!(gone_within_5s(host_pid).await);
    assert_gone(&[me, child]).await;
}

#[tokio::test]
async fn stderr_flood_does_not_stall() {
    let mut agent = AgentProcess::spawn(&tree_cmd(&["--stderr-flood"])).unwrap();
    let (stdin, stdout) = agent.take_stdio().unwrap();
    let mut lines = BufReader::new(stdout).lines();
    let line = tokio::time::timeout(Duration::from_secs(10), lines.next_line())
        .await
        .expect("DONE not printed within 10 s: stderr drain stalled the child")
        .unwrap();
    assert_eq!(line.as_deref(), Some("DONE"));
    drop(stdin);
    agent.shutdown(FAST).await;
    let tail = agent.stderr_tail();
    assert!(tail.len() <= STDERR_TAIL_CAP);
    assert!(tail.len() > STDERR_TAIL_CAP / 2, "tail len {}", tail.len());
    assert!(tail.trim_end().ends_with('x'));
}

#[tokio::test]
async fn cwd_with_space_and_cjk() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("agent dock 測試-{}-{nanos}", std::process::id()));
    std::fs::create_dir(&dir).unwrap();

    let mut cmd = tree_cmd(&["--print-cwd"]);
    cmd.cwd = dir.clone();
    let mut agent = AgentProcess::spawn(&cmd).unwrap();
    let (stdin, stdout) = agent.take_stdio().unwrap();
    let line = tokio::time::timeout(
        Duration::from_secs(10),
        BufReader::new(stdout).lines().next_line(),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    drop(stdin);
    agent.shutdown(FAST).await;
    drop(agent);

    let printed = std::fs::canonicalize(PathBuf::from(line.trim_end())).unwrap();
    let expected = std::fs::canonicalize(&dir).unwrap();
    std::fs::remove_dir(&dir).unwrap();
    assert_eq!(printed, expected);
}

#[tokio::test]
async fn graceful_close_when_agent_exits_on_stdin_eof() {
    let mut agent = AgentProcess::spawn(&tree_cmd(&["--exit-on-eof"])).unwrap();
    let kind = agent.shutdown(PATIENT).await;
    assert_eq!(kind, ExitKind::ClosedGracefully);
    assert_eq!(agent.wait().await.unwrap(), Some(0));
}

/// The direct child exits on stdin EOF but leaves a grandchild behind: shutdown must still kill
/// the whole Job / group (PR #25 `runtime.test.mjs` line 328 scenario).
#[tokio::test]
async fn graceful_close_still_reaps_leftover_grandchild() {
    let mut agent = AgentProcess::spawn(&tree_cmd(&["--tree-exit-on-eof"])).unwrap();
    let (stdin, stdout) = agent.take_stdio().unwrap();
    let (child, me) = read_pids(&mut BufReader::new(stdout).lines()).await;
    drop(stdin);
    assert_eq!(agent.shutdown(PATIENT).await, ExitKind::ClosedGracefully);
    assert_gone(&[child, me]).await;
}

#[tokio::test]
async fn shutdown_is_idempotent() {
    let mut agent = AgentProcess::spawn(&tree_cmd(&[])).unwrap();
    let (stdin, stdout) = agent.take_stdio().unwrap();
    let (child, me) = read_pids(&mut BufReader::new(stdout).lines()).await;
    drop(stdin);
    let first = agent.shutdown(FAST).await;
    let started = Instant::now();
    let second = agent.shutdown(FAST).await;
    assert!(started.elapsed() < Duration::from_millis(100));
    assert_eq!(first, second);
    assert_eq!(first, ExitKind::Terminated);
    assert!(agent.take_stdio().is_none());
    assert_gone(&[child, me]).await;
}
