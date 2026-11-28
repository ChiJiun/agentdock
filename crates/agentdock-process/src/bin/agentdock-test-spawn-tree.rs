//! Test helper for `tests/process_tree.rs` (never shipped).
//!
//! - no arguments: start a grandchild (`--child`), print `CHILD_PID=<pid>` and `SELF_PID=<pid>`,
//!   then sleep 600 s;
//! - `--child`: sleep 600 s;
//! - `--stderr-flood`: write 10 MiB to stderr, then print `DONE` on stdout and exit;
//! - `--print-cwd`: print the current directory and exit;
//! - `--exit-on-eof`: read stdin to EOF, then exit 0;
//! - `--tree-exit-on-eof`: like no arguments, but exit 0 at stdin EOF and leave the grandchild
//!   running (a launcher such as `npx` that exits while the real agent lives on).
#![forbid(unsafe_code)]

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

const SLEEP: Duration = Duration::from_secs(600);

fn main() -> std::io::Result<()> {
    let mode = std::env::args().nth(1);
    let mut out = std::io::stdout().lock();
    match mode.as_deref() {
        None | Some("--tree-exit-on-eof") => {
            let child = Command::new(std::env::current_exe()?)
                .arg("--child")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?;
            writeln!(out, "CHILD_PID={}", child.id())?;
            writeln!(out, "SELF_PID={}", std::process::id())?;
            out.flush()?;
            if mode.is_some() {
                let mut sink = Vec::new();
                std::io::stdin().read_to_end(&mut sink)?;
            } else {
                std::thread::sleep(SLEEP);
            }
        }
        Some("--child") => std::thread::sleep(SLEEP),
        Some("--stderr-flood") => {
            let line = [b'x'; 1023];
            let mut err = std::io::stderr().lock();
            for _ in 0..(10 * 1024) {
                err.write_all(&line)?;
                err.write_all(b"\n")?;
            }
            err.flush()?;
            writeln!(out, "DONE")?;
            out.flush()?;
        }
        Some("--print-cwd") => {
            writeln!(out, "{}", std::env::current_dir()?.display())?;
            out.flush()?;
        }
        Some("--exit-on-eof") => {
            let mut sink = Vec::new();
            std::io::stdin().read_to_end(&mut sink)?;
        }
        Some(_) => std::process::exit(2),
    }
    Ok(())
}
