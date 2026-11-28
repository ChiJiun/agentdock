//! Test helper for the hard-kill tests (P2-4): opens the store at `argv[1]`, appends events in an
//! endless loop and prints each committed `seq` on its own line (flushed), only after `COMMIT`.

#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

use agentdock_core::payload::task::AutoResumePolicy;
use agentdock_core::payload::TaskCreatedPayload;
use agentdock_core::{
    Actor, ActorKind, AuthorityId, EventBody, EventEnvelope, ProjectId, Redaction, TaskId,
    TaskState, Timestamp,
};
use agentdock_store::{NewEvent, OpenOptions, Store};

fn main() -> ExitCode {
    let Some(path) = std::env::args_os().nth(1) else {
        eprintln!("usage: agentdock-store-append-loop <database path>");
        return ExitCode::from(2);
    };
    let store = match Store::open(OpenOptions {
        path: PathBuf::from(path),
        authority: AuthorityId::local(),
    }) {
        Ok(store) => store,
        Err(e) => {
            eprintln!("open failed: {e}");
            return ExitCode::FAILURE;
        }
    };
    let project = ProjectId::generate();
    let task = TaskId::generate();
    let body = EventBody::TaskCreated(TaskCreatedPayload {
        objective: "append loop".to_owned(),
        state: TaskState::Queued,
        issue_url: None,
        branch: None,
        worktree_path: None,
        auto_resume_policy: AutoResumePolicy {
            on_quota_reset: false,
            on_rate_limit: false,
        },
    });
    let mut out = std::io::stdout().lock();
    loop {
        let now = Timestamp::now();
        let envelope = EventEnvelope::new_live(
            AuthorityId::local(),
            Some(project.clone()),
            Some(task.clone()),
            None,
            Actor {
                kind: ActorKind::User,
                id: None,
            },
            &body,
            Redaction {
                policy_version: 1,
                applied_rules: Vec::new(),
            },
            now,
            now,
        );
        match store.transact(|tx| tx.append(NewEvent { envelope })) {
            Ok(committed) => {
                if writeln!(out, "{}", committed.seq)
                    .and_then(|()| out.flush())
                    .is_err()
                {
                    // The reader went away; nothing left to report to.
                    return ExitCode::SUCCESS;
                }
            }
            Err(e) => {
                eprintln!("append failed: {e}");
                return ExitCode::FAILURE;
            }
        }
    }
}
