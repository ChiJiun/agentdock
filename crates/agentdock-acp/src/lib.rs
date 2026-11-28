#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! AgentDock ACP facade.
//!
//! - [`framing`] (P3-1): agent stdout bytes are split into lines with a per-line cap and lossy
//!   UTF-8 decoding, then handed to the SDK's `agent_client_protocol::Lines` transport.
//! - [`client`] (P3-4): [`AcpConnection`], the only place in AgentDock that touches the ACP
//!   SDK. It starts the agent through `agentdock-process` (P3-2) and exposes only AgentDock
//!   types: `initialize`, `session/new`, `session/prompt` with streamed updates,
//!   `session/cancel` and permission forwarding.

pub mod client;
pub mod framing;

pub use client::{
    AcpConnection, AcpError, AcpEvent, AcpSessionId, AcpTimeouts, CloseReason, InitializeInfo,
    PermissionDecision, PermissionKind, PermissionOptionView, PermissionTicket, StopReason,
    EVENT_CHANNEL_CAPACITY,
};
pub use framing::{
    framed_lines, line_sink, FrameError, FramingStats, LineFramer, DEFAULT_MAX_LINE_BYTES,
};
