//! Hard kill (SIGKILL / TerminateProcess) of a writer: committed events survive, seq stays
//! contiguous, every row still parses.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

use agentdock_core::AuthorityId;
use agentdock_store::{Error, OpenOptions, Store};

/// The append-loop child; killed on drop so a failing test leaves no process behind.
struct AppendLoop {
    child: Child,
    out: BufReader<ChildStdout>,
    last_printed: u64,
}

impl AppendLoop {
    fn spawn(db: &Path) -> AppendLoop {
        let mut child = Command::new(env!("CARGO_BIN_EXE_agentdock-store-append-loop"))
            .arg(db)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let out = BufReader::new(child.stdout.take().unwrap());
        AppendLoop {
            child,
            out,
            last_printed: 0,
        }
    }

    /// Reads one complete line; `None` at end of output. A torn last line (no newline) does not
    /// count as printed.
    fn read_seq(&mut self) -> Option<u64> {
        let mut line = String::new();
        if self.out.read_line(&mut line).unwrap() == 0 || !line.ends_with('\n') {
            return None;
        }
        let seq = line.trim().parse().unwrap();
        assert!(seq > self.last_printed, "printed seqs increase");
        self.last_printed = seq;
        Some(seq)
    }

    fn run_until(&mut self, min: u64) {
        while self.last_printed < min {
            assert!(self.read_seq().is_some(), "child exited early");
        }
    }

    /// Hard kill (not a request to exit), then everything the child printed before dying.
    fn kill(mut self) -> u64 {
        self.child.kill().unwrap();
        self.child.wait().unwrap();
        while self.read_seq().is_some() {}
        self.last_printed
    }
}

impl Drop for AppendLoop {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Retries while the OS has not yet released the dead child's lock (Windows may be late).
fn open_retrying(path: &Path) -> Store {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match Store::open(OpenOptions {
            path: path.to_path_buf(),
            authority: AuthorityId::local(),
        }) {
            Ok(store) => return store,
            Err(Error::AlreadyOpen) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => panic!("reopen failed: {e:?}"),
        }
    }
}

#[test]
fn no_gap_after_hard_kill() {
    let dir = tempfile::Builder::new()
        .prefix("agent dock 測試-")
        .tempdir()
        .unwrap();
    let path = dir.path().join("事件 store.db");
    let local = AuthorityId::local();
    let mut committed = 0;
    // Three kill/reopen rounds: each restarted child continues from the next seq.
    for round in 0..3 {
        let mut child = AppendLoop::spawn(&path);
        child.run_until(committed + 200);
        let printed = child.kill();

        let store = open_retrying(&path);
        let events = store.events_after(&local, 0, usize::MAX).unwrap();
        let n = events.len() as u64;
        let seqs: Vec<u64> = events.iter().map(|e| e.seq).collect();
        assert_eq!(
            seqs,
            (1..=n).collect::<Vec<u64>>(),
            "round {round}: contiguous"
        );
        assert!(
            n >= printed,
            "round {round}: {n} rows, child printed {printed}"
        );
        // At most the one commit whose seq the child had not printed yet.
        assert!(
            n <= printed + 1,
            "round {round}: {n} rows, child printed {printed}"
        );
        for e in &events {
            e.validate().unwrap();
            assert!(!e.body().unwrap().is_opaque());
        }
        assert_eq!(store.head_seq(&local).unwrap(), n);
        committed = n;
    }
}
