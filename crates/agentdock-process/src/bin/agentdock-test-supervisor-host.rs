//! Test helper for `tests/process_tree.rs` (never shipped): plays "AgentDock".
//!
//! Starts the spawn-tree helper (absolute path in `argv[1]`) with `AgentProcess::spawn`, copies
//! its stdout to this process's stdout, then sleeps 600 s waiting to be killed.
#![forbid(unsafe_code)]

use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

use agentdock_process::{AgentCommand, AgentProcess};
use tokio::io::{AsyncBufReadExt, BufReader};

fn main() -> std::io::Result<()> {
    let program = PathBuf::from(std::env::args_os().nth(1).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "missing spawn-tree path")
    })?);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async move {
        let cmd = AgentCommand {
            program,
            args: vec![],
            cwd: std::env::current_dir()?,
            auth_env_names: vec![],
            extra_env: vec![],
        };
        let mut agent = AgentProcess::spawn(&cmd).map_err(std::io::Error::other)?;
        let (_stdin, stdout) = agent
            .take_stdio()
            .ok_or_else(|| std::io::Error::other("stdio already taken"))?;
        let mut lines = BufReader::new(stdout).lines();
        let mut seen = 0;
        while seen < 2 {
            let Some(line) = lines.next_line().await? else {
                break;
            };
            let mut out = std::io::stdout().lock();
            writeln!(out, "{line}")?;
            out.flush()?;
            seen += 1;
        }
        tokio::time::sleep(Duration::from_secs(600)).await;
        drop(agent);
        Ok(())
    })
}
