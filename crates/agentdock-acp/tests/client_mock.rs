//! P3-4 §6: `AcpConnection` against `agentdock-mock-agent` scenarios
//! (`crates/agentdock-mock-agent/README.md`). Run with `-- --test-threads=1` for clean timing;
//! the tests also pass in parallel (each starts its own mock process).

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use agentdock_acp::{
    AcpConnection, AcpError, AcpEvent, AcpSessionId, AcpTimeouts, CloseReason, InitializeInfo,
    PermissionDecision, PermissionKind, StopReason, EVENT_CHANNEL_CAPACITY,
};
use agentdock_process::ExitKind;
use common::*;
use tokio::sync::mpsc::Receiver;
use tokio::task::JoinHandle;

struct Harness {
    conn: Arc<AcpConnection>,
    info: InitializeInfo,
    rx: Receiver<AcpEvent>,
    session: AcpSessionId,
    _dir: TempDir,
}

/// Starts the shared mock binary with `scenario` and opens one session in a temp dir whose
/// name has a space and CJK characters.
async fn start(scenario: &str) -> Harness {
    let dir = TempDir::new(scenario);
    let cmd = command(mock_agent(), scenario, dir.path());
    let (conn, info, rx) = AcpConnection::start(&cmd, AcpTimeouts::default())
        .await
        .expect("start");
    let session = conn.new_session(dir.path()).await.expect("session/new");
    assert_eq!(session, AcpSessionId("mock-session-1".into()));
    Harness {
        conn: Arc::new(conn),
        info,
        rx,
        session,
        _dir: dir,
    }
}

impl Harness {
    fn prompt_in_background(&self, text: &str) -> JoinHandle<Result<StopReason, AcpError>> {
        let conn = Arc::clone(&self.conn);
        let session = self.session.clone();
        let text = text.to_owned();
        tokio::spawn(async move { conn.prompt(&session, &text).await })
    }

    async fn finish(self) {
        let started = Instant::now();
        self.conn.shutdown().await;
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}

async fn join<T>(handle: JoinHandle<T>, limit: Duration) -> T {
    tokio::time::timeout(limit, handle)
        .await
        .expect("timed out")
        .expect("task panicked")
}

fn selected(option: &str) -> PermissionDecision {
    PermissionDecision::Selected {
        option_id: option.into(),
    }
}

fn grandchild_pid(text: &str) -> u32 {
    text.split("grandchild pid ")
        .nth(1)
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|pid| pid.parse().ok())
        .filter(|pid| *pid != 0)
        .unwrap_or_else(|| panic!("no grandchild pid in {text:?}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn initialize_returns_raw_capabilities() {
    let h = start("echo").await;
    assert_eq!(h.info.protocol_version, 1);
    assert_eq!(h.info.agent_capabilities["loadSession"], false);
    assert!(h.info.auth_methods.is_empty());
    assert_eq!(h.info.client_advertised["terminal"], false);
    assert_eq!(h.info.client_advertised["fs"]["readTextFile"], false);
    assert_eq!(h.info.client_advertised["fs"]["writeTextFile"], false);
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejects_protocol_v2_and_kills_process() {
    let dir = TempDir::new("wrong-version");
    let exe = unique_mock_copy(&dir, "v2");
    let cmd = command(exe.clone(), "wrong-version", dir.path());
    let err = AcpConnection::start(&cmd, AcpTimeouts::default())
        .await
        .expect_err("v2 must be refused");
    assert!(
        matches!(err, AcpError::UnsupportedProtocolVersion(2)),
        "{err:?}"
    );
    let gone = gone_within(Duration::from_secs(5), || image_running(&exe)).await;
    if !gone {
        force_kill_image(&exe);
    }
    assert!(gone, "mock still running after the refusal");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn initialize_timeout_is_reported() {
    let dir = TempDir::new("hang-init");
    let exe = unique_mock_copy(&dir, "hang");
    let cmd = command(exe.clone(), "hang-init", dir.path());
    let t = AcpTimeouts {
        initialize: Duration::from_secs(2),
        ..AcpTimeouts::default()
    };
    let started = Instant::now();
    let err = AcpConnection::start(&cmd, t)
        .await
        .expect_err("hang-init must time out");
    assert!(matches!(err, AcpError::Timeout("initialize")), "{err:?}");
    assert!(started.elapsed() < Duration::from_secs(12));
    let gone = gone_within(Duration::from_secs(5), || image_running(&exe)).await;
    if !gone {
        force_kill_image(&exe);
    }
    assert!(gone, "mock still running after the timeout");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exit_before_initialize_is_an_error() {
    let dir = TempDir::new("exit-early");
    let cmd = command(mock_agent(), "exit-early", dir.path());
    let result = tokio::time::timeout(
        Duration::from_secs(20),
        AcpConnection::start(&cmd, AcpTimeouts::default()),
    )
    .await
    .expect("start must not hang");
    let err = result.expect_err("exit-early must fail");
    assert!(matches!(err, AcpError::Closed), "{err:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prompt_streams_updates_then_end_turn() {
    let mut h = start("echo").await;
    let stop = h.conn.prompt(&h.session, "hello world").await.unwrap();
    assert_eq!(stop, StopReason::EndTurn);
    // Every update was delivered before `prompt` returned.
    let mut chunks = vec![];
    while let Ok(event) = h.rx.try_recv() {
        match event {
            AcpEvent::SessionUpdate { session, update } => {
                assert_eq!(session, h.session);
                assert_eq!(update["sessionUpdate"], "agent_message_chunk");
                chunks.push(chunk_text(&update).unwrap().to_owned());
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    assert_eq!(chunks.len(), 3, "{chunks:?}");
    assert_eq!(chunks.concat(), "hello world");

    let conn = Arc::clone(&h.conn);
    conn.shutdown().await;
    match next_event(&mut h.rx, Duration::from_secs(5)).await {
        Some(AcpEvent::Closed { reason }) => assert_eq!(reason, CloseReason::ShutDown),
        other => panic!("expected Closed, got {other:?}"),
    }
    // Idempotent, and nothing works after shutdown.
    assert_eq!(conn.shutdown().await, conn.shutdown().await);
    assert!(matches!(
        conn.prompt(&AcpSessionId("mock-session-1".into()), "x")
            .await,
        Err(AcpError::Closed)
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permission_is_forwarded_and_answered() {
    let mut h = start("permission").await;
    let prompt = h.prompt_in_background("run");
    let mut text = String::new();
    let p = wait_permission(&mut h.rx, &mut text).await;
    assert_eq!(p.tool_call["toolCallId"], "call_1");
    let allow = p
        .options
        .iter()
        .find(|o| o.kind == PermissionKind::AllowOnce)
        .expect("an allow_once option");
    assert_eq!(allow.option_id, "allow-once");
    h.conn
        .respond_permission(p.ticket, selected(&allow.option_id))
        .unwrap();
    assert_eq!(
        join(prompt, Duration::from_secs(10)).await.unwrap(),
        StopReason::EndTurn
    );
    let (rest, others) = drain_now(&mut h.rx);
    assert!(others.is_empty(), "{others:?}");
    assert!(format!("{text}{rest}").contains("approved"));
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permission_option_must_be_offered() {
    let mut h = start("permission").await;
    let prompt = h.prompt_in_background("run");
    let p = wait_permission(&mut h.rx, &mut String::new()).await;
    let err = h
        .conn
        .respond_permission(p.ticket, selected("allow-always"))
        .unwrap_err();
    assert!(
        matches!(&err, AcpError::OptionNotOffered(o) if o == "allow-always"),
        "{err:?}"
    );
    // Nothing was sent to the agent: the turn is still waiting, and a correct answer works.
    h.conn
        .respond_permission(p.ticket, selected("allow-once"))
        .unwrap();
    assert_eq!(
        join(prompt, Duration::from_secs(10)).await.unwrap(),
        StopReason::EndTurn
    );
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ticket_cannot_be_replayed() {
    let mut h = start("permission").await;
    let prompt = h.prompt_in_background("run");
    let p = wait_permission(&mut h.rx, &mut String::new()).await;
    h.conn
        .respond_permission(p.ticket, selected("allow-once"))
        .unwrap();
    let err = h
        .conn
        .respond_permission(p.ticket, selected("allow-once"))
        .unwrap_err();
    assert!(matches!(err, AcpError::UnknownTicket), "{err:?}");
    assert_eq!(
        join(prompt, Duration::from_secs(10)).await.unwrap(),
        StopReason::EndTurn
    );
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_answers_pending_permission_as_cancelled() {
    let mut h = start("permission").await;
    let prompt = h.prompt_in_background("run");
    let p = wait_permission(&mut h.rx, &mut String::new()).await;
    h.conn.cancel(&h.session).await.unwrap();
    assert_eq!(
        join(prompt, Duration::from_secs(10)).await.unwrap(),
        StopReason::Cancelled
    );
    let err = h
        .conn
        .respond_permission(p.ticket, selected("allow-once"))
        .unwrap_err();
    assert!(matches!(err, AcpError::UnknownTicket), "{err:?}");
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn second_permission_is_forwarded_after_first_is_selected() {
    let mut h = start("permission-two").await;
    let prompt = h.prompt_in_background("run");
    let mut text = String::new();
    let first = wait_permission(&mut h.rx, &mut text).await;
    assert_eq!(first.tool_call["toolCallId"], "call_1");
    // The mock already sent `mock-perm-2`; it must wait in the facade queue without an event.
    let (more, others) = drain_for(&mut h.rx, Duration::from_millis(500)).await;
    text.push_str(&more);
    assert!(
        others.is_empty(),
        "second request forwarded early: {others:?}"
    );

    h.conn
        .respond_permission(first.ticket, selected("allow-once"))
        .unwrap();
    let second = wait_permission(&mut h.rx, &mut text).await;
    assert_eq!(second.tool_call["toolCallId"], "call_2");
    assert!(second.ticket > first.ticket);
    h.conn
        .respond_permission(second.ticket, selected("reject-once"))
        .unwrap();
    assert_eq!(
        join(prompt, Duration::from_secs(10)).await.unwrap(),
        StopReason::EndTurn
    );
    let (rest, others) = drain_now(&mut h.rx);
    assert!(others.is_empty(), "{others:?}");
    text.push_str(&rest);
    assert!(
        text.contains("perm1=allow-once perm2=reject-once"),
        "{text:?}"
    );
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelled_answer_drops_queue_without_promoting() {
    let mut h = start("permission-two").await;
    let prompt = h.prompt_in_background("run");
    let mut text = String::new();
    let first = wait_permission(&mut h.rx, &mut text).await;
    // The mock sends both requests back to back; give the second one time to reach the queue
    // so this test checks "cancel drops the queue", not "cancel before the second arrived".
    let (more, others) = drain_for(&mut h.rx, Duration::from_millis(300)).await;
    text.push_str(&more);
    assert!(others.is_empty(), "{others:?}");

    h.conn
        .respond_permission(first.ticket, PermissionDecision::Cancelled)
        .unwrap();
    let (more, others) = drain_for(&mut h.rx, Duration::from_secs(1)).await;
    text.push_str(&more);
    assert!(
        others.is_empty(),
        "no PermissionRequested may follow a cancelled answer: {others:?}"
    );
    assert_eq!(
        join(prompt, Duration::from_secs(10)).await.unwrap(),
        StopReason::Cancelled
    );
    let (rest, others) = drain_now(&mut h.rx);
    assert!(others.is_empty(), "{others:?}");
    text.push_str(&rest);
    assert!(text.contains("perm1=cancelled perm2=cancelled"), "{text:?}");
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_stops_slow_stream() {
    let mut h = start("slow").await;
    let prompt = h.prompt_in_background("go");
    let mut updates = 0;
    while updates < 2 {
        match next_event(&mut h.rx, Duration::from_secs(10)).await {
            Some(AcpEvent::SessionUpdate { .. }) => updates += 1,
            other => panic!("unexpected {other:?}"),
        }
    }
    h.conn.cancel(&h.session).await.unwrap();
    assert_eq!(
        join(prompt, Duration::from_secs(2)).await.unwrap(),
        StopReason::Cancelled
    );
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_utf8_and_non_json_keep_connection() {
    let mut h = start("bad-bytes").await;
    assert_eq!(
        h.conn.prompt(&h.session, "x").await.unwrap(),
        StopReason::EndTurn
    );
    let (text, others) = drain_now(&mut h.rx);
    assert!(others.is_empty(), "{others:?}");
    assert!(text.contains("still connected after bad bytes"), "{text:?}");
    assert_eq!(
        h.conn.prompt(&h.session, "again").await.unwrap(),
        StopReason::EndTurn
    );
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oversized_line_closes_explicitly() {
    let mut h = start("oversize").await;
    let err = tokio::time::timeout(Duration::from_secs(60), h.conn.prompt(&h.session, "x"))
        .await
        .expect("prompt must not hang")
        .unwrap_err();
    assert!(matches!(err, AcpError::Closed), "{err:?}");
    let (_, others) = drain_for(&mut h.rx, Duration::from_secs(5)).await;
    // Observed (S3 record): the framing error is reported as `LineTooLong`.
    assert_eq!(
        others,
        vec![AcpEvent::Closed {
            reason: CloseReason::LineTooLong
        }]
    );
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_exit_fails_pending_prompt() {
    let mut h = start("exit-mid-turn").await;
    let err = tokio::time::timeout(Duration::from_secs(20), h.conn.prompt(&h.session, "x"))
        .await
        .expect("prompt must not hang")
        .unwrap_err();
    assert!(matches!(err, AcpError::Closed), "{err:?}");
    let (text, others) = drain_for(&mut h.rx, Duration::from_secs(5)).await;
    assert!(text.contains("partial reply"), "{text:?}");
    assert_eq!(
        others,
        vec![AcpEvent::Closed {
            reason: CloseReason::ProcessExited { code: Some(4) }
        }]
    );
    // Shutting down after the agent is gone reports the earlier exit.
    assert_eq!(h.conn.shutdown().await, ExitKind::Exited { code: Some(4) });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_notification_does_not_close() {
    let mut h = start("unknown-notification").await;
    assert_eq!(
        h.conn.prompt(&h.session, "abc").await.unwrap(),
        StopReason::EndTurn
    );
    let mut meta_update = None;
    while let Ok(event) = h.rx.try_recv() {
        match event {
            AcpEvent::SessionUpdate { update, .. } => {
                if chunk_text(&update) == Some("update with _meta") {
                    meta_update = Some(update);
                }
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    // S5: `_meta` on the update survives re-serialization through the SDK type.
    let update = meta_update.expect("the update carrying _meta was delivered");
    assert_eq!(update["_meta"]["vendor"], "agentdock-mock", "{update}");
    assert_eq!(
        h.conn.prompt(&h.session, "still open").await.unwrap(),
        StopReason::EndTurn
    );
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prompt_error_is_agent_error() {
    let h = start("prompt-error").await;
    let err = h.conn.prompt(&h.session, "x").await.unwrap_err();
    assert!(
        matches!(&err, AcpError::Agent { code: -32603, message } if message == "boom"),
        "{err:?}"
    );
    h.finish().await;
}

// --- beyond the packet's minimum ---

/// S3 backpressure: while nobody drains the event channel, agent stdout stops being read
/// (the SDK's own queues are unbounded, so blocking the callback alone would not do it).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_event_channel_stops_reading_agent_stdout() {
    const CHUNKS: u64 = 10_000;
    let mut h = start("flood").await;
    let prompt = h.prompt_in_background("go");
    tokio::time::sleep(Duration::from_secs(3)).await;
    let read_while_full = h.conn.framing_stats().lines;
    // Observed on Windows: 1072 (1024 queued events plus lines already framed from the last
    // 8 KiB read). Without the gate all 10,003 lines were read.
    assert!(
        read_while_full < 2 * EVENT_CHANNEL_CAPACITY as u64,
        "{read_while_full} lines read while the channel was full"
    );
    let mut updates = 0u64;
    while updates < CHUNKS {
        match next_event(&mut h.rx, Duration::from_secs(20)).await {
            Some(AcpEvent::SessionUpdate { .. }) => updates += 1,
            other => panic!("unexpected {other:?} after {updates} updates"),
        }
    }
    assert_eq!(
        join(prompt, Duration::from_secs(20)).await.unwrap(),
        StopReason::EndTurn
    );
    eprintln!("lines read while the channel was full: {read_while_full}");
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_reaps_stubborn_tree() {
    let mut h = start("stubborn").await;
    assert_eq!(
        h.conn.prompt(&h.session, "x").await.unwrap(),
        StopReason::EndTurn
    );
    let (text, _) = drain_now(&mut h.rx);
    let pid = grandchild_pid(&text);
    assert!(process_alive(pid), "grandchild {pid} should be running");
    // `stubborn` ignores stdin EOF, so the tree is killed after the grace period.
    assert_eq!(h.conn.shutdown().await, ExitKind::Terminated);
    let gone = gone_within(Duration::from_secs(5), || process_alive(pid)).await;
    if !gone {
        force_kill(pid);
    }
    assert!(gone, "grandchild {pid} still running 5 s after shutdown");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_is_bounded_with_orphan_stdio() {
    let mut h = start("orphan-stdio").await;
    assert_eq!(
        h.conn.prompt(&h.session, "x").await.unwrap(),
        StopReason::EndTurn
    );
    let (text, _) = drain_now(&mut h.rx);
    let pid = grandchild_pid(&text);
    let started = Instant::now();
    h.conn.shutdown().await;
    let took = started.elapsed();
    // The grandchild is in the Job / process group too; clean it up either way.
    let gone = gone_within(Duration::from_secs(5), || process_alive(pid)).await;
    if !gone {
        force_kill(pid);
    }
    assert!(took < Duration::from_secs(10), "shutdown took {took:?}");
    assert!(gone, "grandchild {pid} still running after shutdown");
}
