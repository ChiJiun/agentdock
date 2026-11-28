//! ACP client facade (P3-4, ADR-0002 decision 1). The only code in AgentDock that touches the
//! ACP SDK; every public item is an AgentDock type.
//!
//! Wiring: [`AgentProcess`] (P3-2) → stdout through [`framed_lines`] / stdin through
//! [`line_sink`] (P3-1) → `agent_client_protocol::Lines` → `Client.v1()`.
//!
//! Tasks (none of them ever holds a `std::sync::Mutex` across `.await`):
//! - the connection task runs the SDK's `connect_with` and emits [`AcpEvent::Closed`] when it
//!   ends for any reason;
//! - the process task owns the [`AgentProcess`]: it reports the direct child's exit and runs
//!   `AgentProcess::shutdown` on request.
//!
//! SDK callbacks run inside the SDK dispatch loop. They never wait for the user and never call
//! `block_task` (SDK `concepts/ordering.rs`): the notification callback awaits only free space
//! in the bounded event channel (deliberate backpressure), and the permission callback stores
//! the responder in the [`permissions`] queue and returns.
//!
//! Client methods this facade does not register (`fs/*`, `terminal/*`, anything else) are
//! answered `-32601` method not found by the SDK's unhandled-request fallback
//! (`jsonrpc/incoming_actor.rs`, `reject_unhandled`); alpha advertises none of them.

mod events;
mod permissions;

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::v1::schema::{
    CancelNotification, ClientCapabilities, ContentBlock, FileSystemCapabilities,
    InitializeRequest, NewSessionRequest, PromptRequest, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome,
    SessionNotification, TextContent,
};
use agent_client_protocol::v1::{ConnectionTo, Responder};
use agent_client_protocol::{is_connection_terminated, is_incoming_transport_closed, Agent};
use agentdock_process::{AgentCommand, AgentProcess, ExitKind, ProcessError, ShutdownTimeouts};
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;

use crate::framing::{framed_lines, line_sink, FrameError, FramingStats, DEFAULT_MAX_LINE_BYTES};
pub use events::{
    AcpEvent, AcpSessionId, CloseReason, PermissionDecision, PermissionKind, PermissionOptionView,
    PermissionTicket, StopReason,
};
use permissions::{Outcome, PermissionRegistry, PermissionResponder};

/// Capacity of the event channel returned by [`AcpConnection::start`]. A full channel stops
/// the SDK from reading agent stdout (ADR-0002 S3: backpressure lives in AgentDock).
pub const EVENT_CHANNEL_CAPACITY: usize = 1024;

/// How long to wait for the missing half of "stdout closed" / "process exited" before deciding
/// the close reason, and how long an exited agent's remaining stdout may still be read.
const EXIT_GRACE: Duration = Duration::from_secs(2);

/// How long `shutdown` lets the connection task flush queued output (the `cancelled` answers)
/// before it is aborted.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone)]
pub struct InitializeInfo {
    /// Always 1 on success.
    pub protocol_version: u16,
    /// Raw `agentCapabilities` object as received on the wire (`{}` when absent). P2-2 strips
    /// `_meta` and derives features; the facade derives nothing.
    pub agent_capabilities: Value,
    /// Raw `authMethods` entries as received.
    pub auth_methods: Vec<Value>,
    /// Raw `agentInfo`, if present and not `null`.
    pub agent_info: Option<Value>,
    /// Exactly the `clientCapabilities` object written to the agent.
    pub client_advertised: Value,
}

#[derive(Debug, Clone, Copy)]
pub struct AcpTimeouts {
    /// Spawn to `initialize` response (PR #25 `initTimeoutMs`; Windows cold starts, X-1).
    pub initialize: Duration,
    pub new_session: Duration,
    /// Not used by the facade (`session/cancel` is a notification). P3-5 waits this long for
    /// the turn to end after `cancel` (P4-3 §5A row H2).
    pub cancel_ack: Duration,
}

impl Default for AcpTimeouts {
    /// 30 s, 30 s, 10 s.
    fn default() -> Self {
        Self {
            initialize: Duration::from_secs(30),
            new_session: Duration::from_secs(30),
            cancel_ack: Duration::from_secs(10),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AcpError {
    #[error("agent answered unsupported protocol version {0}")]
    UnsupportedProtocolVersion(u64),
    #[error("timed out waiting for {0}")]
    Timeout(&'static str),
    /// `message` is agent text (untrusted); callers redact before storing or showing it.
    #[error("agent returned error {code}: {message}")]
    Agent { code: i64, message: String },
    #[error("connection closed")]
    Closed,
    #[error("unknown permission ticket")]
    UnknownTicket,
    #[error("option {0} was not offered")]
    OptionNotOffered(String),
    #[error(transparent)]
    Process(#[from] ProcessError),
}

/// A live ACP v1 connection to one supervised agent process.
///
/// Caller obligations:
/// - Drain the event receiver concurrently with [`prompt`](Self::prompt). While the channel is
///   full the SDK reads nothing from the agent, so a `prompt` awaited by the only task that
///   also reads the receiver can stall.
/// - Call [`respond_permission`](Self::respond_permission) only after `approval.resolved` is
///   persisted (contract `acp-capabilities.md` line 94).
/// - **Await [`shutdown`](Self::shutdown) before the app exits.** Dropping the connection kills
///   the process tree from `Drop`, but on Unix any exit that skips `Drop` (`std::process::exit`,
///   Tauri `app.exit()`, a signal) leaves the agent's process group running (spike S2
///   "Known gaps"). On Windows the Job Object is closed by the kernel in every case.
pub struct AcpConnection {
    cx: ConnectionTo<Agent>,
    events: mpsc::Sender<AcpEvent>,
    runtime: tokio::runtime::Handle,
    timeouts: AcpTimeouts,
    stats: Arc<Mutex<FramingStats>>,
    life: Lifecycle,
}

impl std::fmt::Debug for AcpConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcpConnection")
            .field("closed", &self.life.shared.closed.load(Ordering::SeqCst))
            .finish_non_exhaustive()
    }
}

impl AcpConnection {
    /// Spawns the agent (P3-2), wires framing (P3-1) into `agent_client_protocol::Lines`, runs
    /// `initialize` with `protocolVersion: 1` and AgentDock's client capabilities (no `fs`, no
    /// `terminal`). Any answer other than version 1 ends the process and returns
    /// `UnsupportedProtocolVersion`; every other failure also ends the process tree before
    /// returning. Returns the connection and the bounded event receiver
    /// ([`EVENT_CHANNEL_CAPACITY`]). Must be called inside a Tokio runtime.
    pub async fn start(
        cmd: &AgentCommand,
        t: AcpTimeouts,
    ) -> Result<(Self, InitializeInfo, mpsc::Receiver<AcpEvent>), AcpError> {
        let mut process = AgentProcess::spawn(cmd)?;
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| ProcessError::Supervision("a Tokio runtime is required".into()))?;
        let Some((stdin, stdout)) = process.take_stdio() else {
            process.shutdown(ShutdownTimeouts::default()).await;
            return Err(ProcessError::Supervision("agent stdio unavailable".into()).into());
        };

        let shared = Arc::new(Shared::default());
        let registry = Arc::new(PermissionRegistry::default());
        let tap = Arc::new(InitTap::default());
        let (events_tx, events_rx) = mpsc::channel(EVENT_CHANNEL_CAPACITY);

        let (exit_tx, exit_rx) = watch::channel(None);
        let (proc_ctl_tx, proc_ctl_rx) = oneshot::channel();
        runtime.spawn(supervise(process, exit_tx, proc_ctl_rx));

        let stats = Arc::new(Mutex::new(FramingStats::default()));
        let incoming = framed_lines(stdout, DEFAULT_MAX_LINE_BYTES, Arc::clone(&stats));
        // Backpressure gate (spike S3): the SDK reads every line into an unbounded queue
        // (`transport_incoming_lines_actor`), so a blocked callback alone does not stop reading
        // stdout. Before each line, wait until the event channel has room again.
        let incoming = futures::stream::unfold(
            (Box::pin(incoming), events_tx.clone()),
            |(mut lines, gate)| async move {
                // The permit is released at once; only "room exists" matters. An error means
                // the receiver is gone, and then nothing is gated any more.
                drop(gate.reserve().await);
                let item = lines.next().await?;
                Some((item, (lines, gate)))
            },
        );
        let incoming = incoming.inspect({
            let tap = Arc::clone(&tap);
            let shared = Arc::clone(&shared);
            move |item| match item {
                Ok(line) => tap.incoming(line),
                Err(e) => {
                    if e.get_ref()
                        .is_some_and(|inner| inner.downcast_ref::<FrameError>().is_some())
                    {
                        shared.line_too_long.store(true, Ordering::SeqCst);
                    }
                }
            }
        });
        let outgoing = line_sink(stdin).with({
            let tap = Arc::clone(&tap);
            move |line: String| {
                tap.outgoing(&line);
                futures::future::ready(Ok::<_, std::io::Error>(line))
            }
        });
        let transport = agent_client_protocol::Lines::new(outgoing, incoming);

        let (cx_tx, cx_rx) = oneshot::channel::<ConnectionTo<Agent>>();
        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let conn_task = runtime.spawn(run_connection(
            transport,
            events_tx.clone(),
            Arc::clone(&registry),
            Arc::clone(&shared),
            cx_tx,
            stop_rx,
            exit_rx,
        ));

        let life = Lifecycle {
            shared,
            registry,
            stop: Mutex::new(Some(stop_tx)),
            conn_task: Mutex::new(Some(conn_task)),
            proc_ctl: Mutex::new(Some(proc_ctl_tx)),
            outcome: tokio::sync::Mutex::new(None),
        };

        let handshake = async {
            let cx = cx_rx.await.map_err(|_| AcpError::Closed)?;
            let info = initialize(&cx, &tap, &life.shared).await?;
            Ok::<_, AcpError>((cx, info))
        };
        let result = match tokio::time::timeout(t.initialize, handshake).await {
            Ok(result) => result,
            Err(_) => Err(AcpError::Timeout("initialize")),
        };
        match result {
            Ok((cx, info)) => Ok((
                Self {
                    cx,
                    events: events_tx,
                    runtime,
                    timeouts: t,
                    stats,
                    life,
                },
                info,
                events_rx,
            )),
            Err(e) => {
                life.shutdown().await;
                Err(e)
            }
        }
    }

    pub async fn new_session(&self, cwd: &Path) -> Result<AcpSessionId, AcpError> {
        self.ensure_open()?;
        let request = self
            .cx
            .send_request(NewSessionRequest::new(cwd.to_path_buf()))
            .block_task();
        match tokio::time::timeout(self.timeouts.new_session, request).await {
            Err(_) => Err(AcpError::Timeout("session/new")),
            Ok(Ok(response)) => Ok(AcpSessionId(response.session_id.0.to_string())),
            Ok(Err(e)) => Err(self.life.shared.map_error(e)),
        }
    }

    /// Sends one text prompt and resolves at the end of the turn. Updates arrive on the event
    /// channel meanwhile; every update the agent sent before its response is already in the
    /// channel when this returns. No timeout: turns can be long; use [`cancel`](Self::cancel).
    pub async fn prompt(&self, session: &AcpSessionId, text: &str) -> Result<StopReason, AcpError> {
        self.ensure_open()?;
        let request = PromptRequest::new(
            session.0.clone(),
            vec![ContentBlock::Text(TextContent::new(text))],
        );
        let response = self
            .cx
            .send_request(request)
            .block_task()
            .await
            .map_err(|e| self.life.shared.map_error(e))?;
        events::stop_reason_from_sdk(response.stop_reason).ok_or_else(|| AcpError::Agent {
            code: 0,
            message: "unknown stop reason".into(),
        })
    }

    /// Sends `session/cancel` and answers every forwarded or queued permission of this session
    /// with `cancelled` (ACP v1, contract line 26). The permissions are answered even when the
    /// notification could not be sent (`Err(Closed)`).
    ///
    /// A `session/request_permission` the agent sends after this call is forwarded as usual;
    /// the caller refuses it (P4-3 §5A row C5).
    pub async fn cancel(&self, session: &AcpSessionId) -> Result<(), AcpError> {
        let sent = self.ensure_open().and_then(|()| {
            self.cx
                .send_notification(CancelNotification::new(session.0.clone()))
                .map_err(|e| self.life.shared.map_error(e))
        });
        self.life.registry.cancel_session(session);
        sent
    }

    /// Must be called only AFTER the caller has persisted `approval.resolved` (contract
    /// `acp-capabilities.md` line 94).
    ///
    /// `Selected` answers the ticket and promotes the session's next waiting request (emits its
    /// `PermissionRequested`). `Cancelled` answers the ticket, then answers every waiting request
    /// of the same session `cancelled` and drops them: nothing is promoted and no event is
    /// emitted. Errors (`UnknownTicket`, `OptionNotOffered`, `Closed`) send nothing to the agent.
    pub fn respond_permission(
        &self,
        ticket: PermissionTicket,
        decision: PermissionDecision,
    ) -> Result<(), AcpError> {
        if let Some(event) = self.life.registry.respond(ticket, decision)? {
            self.emit_detached(event);
        }
        Ok(())
    }

    /// Answers every open permission `cancelled`, ends the connection, then
    /// `AgentProcess::shutdown` (stdin close, grace, kill the whole tree). Idempotent: later
    /// calls return the first result. Emits `Closed { ShutDown }` unless the connection had
    /// already closed.
    ///
    /// NOTE: this answers `cancelled` without persisting anything; P3-5 calls it only after
    /// every recorded approval of the session is resolved (P3-5 §5 step 9), so the only tickets
    /// answered here are ones that were never recorded.
    pub async fn shutdown(&self) -> ExitKind {
        self.life.shutdown().await
    }

    /// Line counters of the agent's stdout (P3-1), for diagnostics. Counts lines read from
    /// the pipe, which can be ahead of the events delivered so far.
    pub fn framing_stats(&self) -> FramingStats {
        *lock(&self.stats)
    }

    fn ensure_open(&self) -> Result<(), AcpError> {
        if self.life.shared.closed.load(Ordering::SeqCst) {
            Err(AcpError::Closed)
        } else {
            Ok(())
        }
    }

    /// Emits from synchronous code without waiting: `try_send`, and only if the channel is full
    /// a task that waits for space.
    fn emit_detached(&self, event: AcpEvent) {
        match self.events.try_send(event) {
            Ok(()) | Err(mpsc::error::TrySendError::Closed(_)) => {}
            Err(mpsc::error::TrySendError::Full(event)) => {
                let tx = self.events.clone();
                self.runtime.spawn(async move {
                    let _ = tx.send(event).await;
                });
            }
        }
    }
}

#[derive(Default)]
struct Shared {
    /// The connection task finished; nothing can be sent any more.
    closed: AtomicBool,
    shutting_down: AtomicBool,
    /// Set by the stdout inspector when framing reported `LineTooLong`.
    line_too_long: AtomicBool,
}

impl Shared {
    fn map_error(&self, e: agent_client_protocol::Error) -> AcpError {
        if self.closed.load(Ordering::SeqCst)
            || is_incoming_transport_closed(&e)
            || is_connection_terminated(&e)
        {
            AcpError::Closed
        } else {
            AcpError::Agent {
                code: i64::from(e.code.value()),
                message: e.message,
            }
        }
    }
}

/// Shutdown state shared by `start` failures and `AcpConnection::shutdown`.
struct Lifecycle {
    shared: Arc<Shared>,
    registry: Arc<PermissionRegistry>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    conn_task: Mutex<Option<JoinHandle<()>>>,
    proc_ctl: Mutex<Option<oneshot::Sender<oneshot::Sender<ExitKind>>>>,
    /// Result of the first completed shutdown. A Tokio mutex: concurrent callers wait for it.
    outcome: tokio::sync::Mutex<Option<ExitKind>>,
}

impl Lifecycle {
    async fn shutdown(&self) -> ExitKind {
        let mut outcome = self.outcome.lock().await;
        if let Some(kind) = outcome.as_ref() {
            return kind.clone();
        }
        self.shared.shutting_down.store(true, Ordering::SeqCst);
        // Queue the `cancelled` answers before the connection stops, so they are flushed.
        self.registry.close();
        if let Some(stop) = take(&self.stop) {
            let _ = stop.send(());
        }
        if let Some(mut task) = take(&self.conn_task) {
            if tokio::time::timeout(DRAIN_GRACE, &mut task).await.is_err() {
                // The agent stopped reading stdin, or nobody drains the event channel.
                task.abort();
            }
        }
        let kind = match take(&self.proc_ctl) {
            Some(ctl) => {
                let (reply_tx, reply_rx) = oneshot::channel();
                if ctl.send(reply_tx).is_ok() {
                    reply_rx.await.unwrap_or(ExitKind::Terminated)
                } else {
                    ExitKind::Terminated
                }
            }
            None => ExitKind::Terminated,
        };
        *outcome = Some(kind.clone());
        kind
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn take<T>(m: &Mutex<Option<T>>) -> Option<T> {
    lock(m).take()
}

/// Owns the agent process: reports the direct child's exit on `exit_tx` and runs the orderly
/// shutdown when asked. If the request side is dropped without asking (the connection was
/// dropped), dropping the `AgentProcess` kills the tree.
async fn supervise(
    mut process: AgentProcess,
    exit_tx: watch::Sender<Option<Option<i32>>>,
    mut ctl: oneshot::Receiver<oneshot::Sender<ExitKind>>,
) {
    let mut exited = false;
    loop {
        tokio::select! {
            request = &mut ctl => {
                if let Ok(reply) = request {
                    let kind = process.shutdown(ShutdownTimeouts::default()).await;
                    let _ = reply.send(kind);
                }
                return;
            }
            code = process.wait(), if !exited => {
                exited = true;
                if let Ok(code) = code {
                    let _ = exit_tx.send(Some(code));
                }
            }
        }
    }
}

/// Resolves with the exit code once the process task has seen the direct child exit; never
/// resolves if it never will.
async fn exit_code(rx: &mut watch::Receiver<Option<Option<i32>>>) -> Option<i32> {
    let code = rx
        .wait_for(Option::is_some)
        .await
        .map(|code| code.flatten());
    match code {
        Ok(code) => code,
        Err(_) => std::future::pending().await,
    }
}

enum End {
    Stop,
    IncomingClosed,
    ProcessExited(Option<i32>),
}

async fn run_connection<T>(
    transport: T,
    events: mpsc::Sender<AcpEvent>,
    registry: Arc<PermissionRegistry>,
    shared: Arc<Shared>,
    cx_tx: oneshot::Sender<ConnectionTo<Agent>>,
    mut stop: oneshot::Receiver<()>,
    exit_rx: watch::Receiver<Option<Option<i32>>>,
) where
    T: agent_client_protocol::ConnectTo<agent_client_protocol::Client> + 'static,
{
    let notification_tx = events.clone();
    let permission_tx = events.clone();
    let permission_registry = Arc::clone(&registry);
    let mut exit_main = exit_rx.clone();
    let result = agent_client_protocol::Client
        .v1()
        .on_receive_notification(
            async move |n: SessionNotification, _cx| {
                if let Ok(update) = serde_json::to_value(&n.update) {
                    let session = AcpSessionId(n.session_id.0.to_string());
                    // Deliberate backpressure: while the channel is full the dispatch loop
                    // waits here, and the read gate in `start` stops reading agent stdout.
                    let _ = notification_tx
                        .send(AcpEvent::SessionUpdate { session, update })
                        .await;
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest,
                        responder: Responder<RequestPermissionResponse>,
                        _cx| {
                let session = AcpSessionId(request.session_id.0.to_string());
                let tool_call = serde_json::to_value(&request.tool_call).unwrap_or(Value::Null);
                let options = request.options.iter().map(events::option_view).collect();
                // Never waits for the user: the responder is stored and answered later by
                // `respond_permission`. Only free channel space is awaited, as for updates,
                // which keeps this event behind the updates the agent sent before it.
                let event = permission_registry.enqueue(
                    session,
                    tool_call,
                    options,
                    Box::new(SdkResponder(responder)),
                );
                if let Some(event) = event {
                    let _ = permission_tx.send(event).await;
                }
                Ok(())
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(transport, async move |cx: ConnectionTo<Agent>| {
            let _ = cx_tx.send(cx.clone());
            let end = tokio::select! {
                _ = &mut stop => End::Stop,
                () = cx.incoming_closed() => End::IncomingClosed,
                code = exit_code(&mut exit_main) => {
                    // Lines the agent wrote before exiting are still read, unless a grandchild
                    // keeps stdout open: then stop waiting after EXIT_GRACE.
                    tokio::select! {
                        _ = &mut stop => End::Stop,
                        () = cx.incoming_closed() => End::ProcessExited(code),
                        () = tokio::time::sleep(EXIT_GRACE) => End::ProcessExited(code),
                    }
                }
            };
            Ok(end)
        })
        .await;

    let reason = close_reason(result, &shared, exit_rx).await;
    shared.closed.store(true, Ordering::SeqCst);
    registry.close();
    let _ = events.send(AcpEvent::Closed { reason }).await;
}

async fn close_reason(
    result: Result<End, agent_client_protocol::Error>,
    shared: &Shared,
    mut exit_rx: watch::Receiver<Option<Option<i32>>>,
) -> CloseReason {
    if shared.shutting_down.load(Ordering::SeqCst) {
        return CloseReason::ShutDown;
    }
    match result {
        Ok(End::Stop) => CloseReason::ShutDown,
        Ok(End::ProcessExited(code)) => CloseReason::ProcessExited { code },
        Ok(End::IncomingClosed) => {
            match tokio::time::timeout(EXIT_GRACE, exit_code(&mut exit_rx)).await {
                Ok(code) => CloseReason::ProcessExited { code },
                Err(_) => CloseReason::ProtocolError("agent closed stdout without exiting".into()),
            }
        }
        Err(e) => {
            if shared.line_too_long.load(Ordering::SeqCst) {
                return CloseReason::LineTooLong;
            }
            // A write to an exited agent fails too; the exit is the real cause then.
            match tokio::time::timeout(EXIT_GRACE, exit_code(&mut exit_rx)).await {
                Ok(code) => CloseReason::ProcessExited { code },
                // SDK code and message only: `data` may echo agent bytes.
                Err(_) => CloseReason::ProtocolError(format!("{} ({})", e.message, e.code.value())),
            }
        }
    }
}

/// Sends `initialize` from `start`'s own task (not an SDK callback, so `block_task` is safe)
/// and checks the version. The SDK v1 client already rejects a non-1 answer with an error; the
/// version number for `UnsupportedProtocolVersion` comes from the raw response.
async fn initialize(
    cx: &ConnectionTo<Agent>,
    tap: &InitTap,
    shared: &Shared,
) -> Result<InitializeInfo, AcpError> {
    let capabilities = ClientCapabilities::new()
        .fs(FileSystemCapabilities::new()
            .read_text_file(false)
            .write_text_file(false))
        .terminal(false);
    let request =
        InitializeRequest::new(ProtocolVersion::V1).client_capabilities(capabilities.clone());
    let result = cx.send_request(request).block_task().await;
    let captured = tap.finish();
    let raw = captured
        .response
        .as_ref()
        .and_then(|r| r.get("result"))
        .filter(|r| r.is_object());
    let raw_version = raw
        .and_then(|r| r.get("protocolVersion"))
        .and_then(Value::as_u64);
    if let Some(version) = raw_version.filter(|v| *v != 1) {
        return Err(AcpError::UnsupportedProtocolVersion(version));
    }
    let response = result.map_err(|e| shared.map_error(e))?;
    let version = response.protocol_version.as_u16();
    if version != 1 {
        return Err(AcpError::UnsupportedProtocolVersion(u64::from(version)));
    }
    let agent_capabilities = match raw {
        Some(r) => r
            .get("agentCapabilities")
            .cloned()
            .unwrap_or_else(|| Value::Object(serde_json::Map::new())),
        // Not captured (should not happen): fall back to the SDK type.
        None => serde_json::to_value(&response.agent_capabilities)
            .unwrap_or_else(|_| Value::Object(serde_json::Map::new())),
    };
    let auth_methods = raw
        .and_then(|r| r.get("authMethods"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let agent_info = raw
        .and_then(|r| r.get("agentInfo"))
        .filter(|v| !v.is_null())
        .cloned();
    let client_advertised = match captured.client_capabilities {
        Some(sent) => sent,
        None => serde_json::to_value(&capabilities)
            .unwrap_or_else(|_| Value::Object(serde_json::Map::new())),
    };
    Ok(InitializeInfo {
        protocol_version: version,
        agent_capabilities,
        auth_methods,
        agent_info,
        client_advertised,
    })
}

/// Copies the `initialize` request and response from the wire, so `InitializeInfo` is the raw
/// JSON (not re-serialized SDK types) and the refused version number is known. Lines are only
/// parsed until `initialize` completes.
#[derive(Default)]
struct InitTap {
    state: Mutex<TapState>,
}

#[derive(Default)]
struct TapState {
    done: bool,
    request_id: Option<Value>,
    client_capabilities: Option<Value>,
    response: Option<Value>,
}

impl InitTap {
    fn outgoing(&self, line: &str) {
        let mut state = lock(&self.state);
        if state.done || state.request_id.is_some() {
            return;
        }
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if message.get("method").and_then(Value::as_str) == Some("initialize") {
            state.request_id = message.get("id").cloned();
            state.client_capabilities = message
                .get("params")
                .and_then(|p| p.get("clientCapabilities"))
                .cloned();
        }
    }

    fn incoming(&self, line: &str) {
        let id = {
            let state = lock(&self.state);
            if state.done || state.response.is_some() {
                return;
            }
            match &state.request_id {
                Some(id) => id.clone(),
                None => return,
            }
        };
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if message.get("method").is_none() && message.get("id") == Some(&id) {
            let mut state = lock(&self.state);
            if !state.done {
                state.response = Some(message);
            }
        }
    }

    /// Stops inspecting and returns what was captured.
    fn finish(&self) -> TapState {
        let mut state = lock(&self.state);
        state.done = true;
        TapState {
            done: true,
            request_id: state.request_id.take(),
            client_capabilities: state.client_capabilities.take(),
            response: state.response.take(),
        }
    }
}

struct SdkResponder(Responder<RequestPermissionResponse>);

impl PermissionResponder for SdkResponder {
    fn respond(self: Box<Self>, outcome: Outcome) {
        let outcome = match outcome {
            Outcome::Selected(option_id) => {
                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id))
            }
            Outcome::Cancelled => RequestPermissionOutcome::Cancelled,
        };
        // Fails only when the connection is gone; there is nobody left to answer then.
        let _ = self.0.respond(RequestPermissionResponse::new(outcome));
    }
}
