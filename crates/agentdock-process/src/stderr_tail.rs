//! Bounded in-memory tail of a child's stderr.
//!
//! The bytes are kept only in memory and never written to events, logs or files: agent
//! stderr may contain credentials. Callers must redact (P2-7) before showing or storing.

use std::collections::VecDeque;
use std::sync::Mutex;

/// Maximum number of stderr bytes kept (the newest ones win).
pub const STDERR_TAIL_CAP: usize = 64 * 1024;

#[derive(Debug, Default)]
pub(crate) struct StderrTail {
    buf: Mutex<VecDeque<u8>>,
}

impl StderrTail {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Appends `bytes`, dropping the oldest bytes beyond [`STDERR_TAIL_CAP`].
    pub(crate) fn push(&self, bytes: &[u8]) {
        let mut buf = self.buf.lock().unwrap_or_else(|e| e.into_inner());
        if bytes.len() >= STDERR_TAIL_CAP {
            buf.clear();
            buf.extend(&bytes[bytes.len() - STDERR_TAIL_CAP..]);
            return;
        }
        buf.extend(bytes);
        let excess = buf.len().saturating_sub(STDERR_TAIL_CAP);
        if excess > 0 {
            buf.drain(..excess);
        }
    }

    /// Lossy UTF-8 view of the kept bytes, never longer than [`STDERR_TAIL_CAP`] bytes.
    pub(crate) fn snapshot(&self) -> String {
        let bytes: Vec<u8> = {
            let buf = self.buf.lock().unwrap_or_else(|e| e.into_inner());
            buf.iter().copied().collect()
        };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if text.len() <= STDERR_TAIL_CAP {
            return text;
        }
        // U+FFFD replacements can grow the text; keep the newest part on a char boundary.
        let mut start = text.len() - STDERR_TAIL_CAP;
        while !text.is_char_boundary(start) {
            start += 1;
        }
        text[start..].to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_the_newest_bytes() {
        let tail = StderrTail::new();
        tail.push(&vec![b'a'; STDERR_TAIL_CAP]);
        tail.push(b"xyz");
        let s = tail.snapshot();
        assert_eq!(s.len(), STDERR_TAIL_CAP);
        assert!(s.ends_with("axyz"));
    }

    #[test]
    fn oversized_chunk_keeps_its_end() {
        let tail = StderrTail::new();
        tail.push(b"old");
        let mut big = vec![b'b'; STDERR_TAIL_CAP + 10];
        big.extend_from_slice(b"END");
        tail.push(&big);
        let s = tail.snapshot();
        assert_eq!(s.len(), STDERR_TAIL_CAP);
        assert!(s.ends_with("bEND"));
        assert!(!s.contains("old"));
    }

    #[test]
    fn invalid_utf8_is_replaced_and_still_bounded() {
        let tail = StderrTail::new();
        tail.push(&vec![0xFF; STDERR_TAIL_CAP]);
        let s = tail.snapshot();
        assert!(s.len() <= STDERR_TAIL_CAP);
        assert!(s.chars().all(|c| c == '\u{FFFD}'));
    }

    #[test]
    fn empty_tail_is_empty_string() {
        assert_eq!(StderrTail::new().snapshot(), "");
    }
}
