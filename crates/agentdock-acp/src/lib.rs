#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! AgentDock ACP facade.
//!
//! P3-1 only provides byte-level line framing (ADR-0002): agent stdout bytes are split into lines
//! here, with a per-line cap and lossy UTF-8 decoding, and then handed to the SDK's
//! `agent_client_protocol::Lines` transport. Process supervision, the mock agent and the
//! initialize/session facade belong to later packets.

pub mod framing;

pub use framing::{
    framed_lines, line_sink, FrameError, FramingStats, LineFramer, DEFAULT_MAX_LINE_BYTES,
};
