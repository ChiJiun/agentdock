//! Byte-level line framing for agent stdout (ADR-0002 "Framing decision").
//!
//! Why not `BufReader::lines()`: it returns `Err` on invalid UTF-8, which is exactly how SDK 5.3.0
//! ended the whole connection. Here bytes are split on `\n`, a trailing `\r` is stripped, each
//! line is capped, and invalid UTF-8 is replaced with U+FFFD and counted. JSON is never parsed
//! here: a line that is not JSON is passed through and the SDK decides what to answer.

use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Mutex};

use futures::{Sink, Stream};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Per-line cap: 16 MiB, the same cap PR #25 verified. This is the transport limit; event-level
/// limits (1 MiB per message, 8 MiB per turn) are handled by P3-5.
pub const DEFAULT_MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

/// Read buffer of [`framed_lines`]. The oversized-line bound is `max_line_bytes + READ_BUF_BYTES`.
const READ_BUF_BYTES: usize = 8 * 1024;

/// After emitting a line, give back buffer capacity above this size so one big line does not pin
/// megabytes for the rest of the session.
const RETAINED_BUF_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FramingStats {
    /// Non-empty lines emitted.
    pub lines: u64,
    /// Input bytes that were turned into U+FFFD.
    pub replaced_invalid_utf8_bytes: u64,
    /// Lines that were empty after stripping the line terminator.
    pub empty_lines_skipped: u64,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FrameError {
    #[error("agent sent a line longer than {max} bytes; connection ended")]
    LineTooLong { max: usize },
}

/// Pure, incremental splitter (no I/O). Feed arbitrary chunks; get complete lines.
///
/// The cap counts every byte of a line before its `\n`, including a trailing `\r`. A line of
/// exactly `max` bytes is accepted; `max + 1` fails as soon as that byte is buffered, without
/// waiting for a newline, so a hostile agent cannot grow memory beyond `max`.
pub struct LineFramer {
    buf: Vec<u8>,
    max: usize,
    stats: FramingStats,
    failed: bool,
}

impl LineFramer {
    pub fn new(max_line_bytes: usize) -> Self {
        Self {
            buf: Vec::new(),
            max: max_line_bytes,
            stats: FramingStats::default(),
            failed: false,
        }
    }

    /// Returns complete lines found so far. After `LineTooLong`, every later call returns the
    /// same error. Complete lines that sat in the same chunk before the oversized line are
    /// dropped with it: the connection ends anyway.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, FrameError> {
        self.check_failed()?;
        let mut out = Vec::new();
        let mut rest = chunk;
        while !rest.is_empty() {
            match rest.iter().position(|&b| b == b'\n') {
                Some(i) => {
                    let head = &rest[..i];
                    self.reserve_for(head.len())?;
                    self.buf.extend_from_slice(head);
                    if let Some(line) = self.take_line(true) {
                        out.push(line);
                    }
                    rest = &rest[i + 1..];
                }
                None => {
                    self.reserve_for(rest.len())?;
                    self.buf.extend_from_slice(rest);
                    break;
                }
            }
        }
        Ok(out)
    }

    /// At EOF: returns the trailing partial line if non-empty (agents may omit the final `\n`).
    pub fn finish(&mut self) -> Result<Option<String>, FrameError> {
        self.check_failed()?;
        Ok(self.take_line(false))
    }

    pub fn stats(&self) -> FramingStats {
        self.stats
    }

    fn check_failed(&self) -> Result<(), FrameError> {
        if self.failed {
            Err(FrameError::LineTooLong { max: self.max })
        } else {
            Ok(())
        }
    }

    /// Checks that `extra` more bytes still fit in the current line; marks the framer failed and
    /// frees the buffer if not.
    fn reserve_for(&mut self, extra: usize) -> Result<(), FrameError> {
        if self.buf.len().saturating_add(extra) > self.max {
            self.failed = true;
            self.buf = Vec::new();
            return Err(FrameError::LineTooLong { max: self.max });
        }
        Ok(())
    }

    /// Turns the buffered bytes into a line (or counts an empty one) and clears the buffer.
    /// `terminated` is true when a newline ended the line, false at EOF.
    fn take_line(&mut self, terminated: bool) -> Option<String> {
        let mut bytes = self.buf.as_slice();
        if let Some(stripped) = bytes.strip_suffix(b"\r") {
            bytes = stripped;
        }
        let line = if bytes.is_empty() {
            // At EOF with nothing buffered there is no line at all; a lone `\r` is an empty line.
            if terminated || !self.buf.is_empty() {
                self.stats.empty_lines_skipped += 1;
            }
            None
        } else {
            self.stats.lines += 1;
            Some(decode_lossy(bytes, &mut self.stats))
        };
        self.buf.clear();
        if self.buf.capacity() > RETAINED_BUF_BYTES {
            self.buf.shrink_to(RETAINED_BUF_BYTES);
        }
        line
    }
}

/// Lossy UTF-8 decode that counts the input bytes replaced by U+FFFD. Counting walks
/// `Utf8Error` (not the output length: U+FFFD is 3 bytes). Same replacement behavior as
/// `String::from_utf8_lossy`: one U+FFFD per maximal invalid sequence, and one for a sequence
/// truncated at the end of the line.
fn decode_lossy(bytes: &[u8], stats: &mut FramingStats) -> String {
    let mut out = String::with_capacity(bytes.len());
    let mut rest = bytes;
    loop {
        match std::str::from_utf8(rest) {
            Ok(valid) => {
                out.push_str(valid);
                return out;
            }
            Err(e) => {
                let (valid, after) = rest.split_at(e.valid_up_to());
                // `valid_up_to()` bytes are valid UTF-8 by contract.
                out.push_str(&String::from_utf8_lossy(valid));
                out.push(char::REPLACEMENT_CHARACTER);
                let bad = e.error_len().unwrap_or(after.len());
                stats.replaced_invalid_utf8_bytes += bad as u64;
                rest = &after[bad..];
            }
        }
    }
}

fn frame_error_to_io(e: FrameError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e)
}

fn publish_stats(shared: &Mutex<FramingStats>, stats: FramingStats) {
    // A poisoned lock only loses diagnostics; framing must keep working.
    if let Ok(mut guard) = shared.lock() {
        *guard = stats;
    }
}

struct ReadState<R> {
    reader: R,
    framer: LineFramer,
    stats: Arc<Mutex<FramingStats>>,
    buf: Box<[u8; READ_BUF_BYTES]>,
    pending: VecDeque<String>,
    done: bool,
}

/// Async adapter: reads `reader` with an 8 KiB buffer and yields lines for
/// `agent_client_protocol::Lines`. `LineTooLong` becomes `io::Error(kind InvalidData)` so the SDK
/// ends the connection explicitly; the stream ends after yielding any error. `stats` is updated
/// after every read.
pub fn framed_lines<R>(
    reader: R,
    max_line_bytes: usize,
    stats: Arc<Mutex<FramingStats>>,
) -> impl Stream<Item = io::Result<String>> + Send + 'static
where
    R: AsyncRead + Unpin + Send + 'static,
{
    let state = ReadState {
        reader,
        framer: LineFramer::new(max_line_bytes),
        stats,
        buf: Box::new([0u8; READ_BUF_BYTES]),
        pending: VecDeque::new(),
        done: false,
    };
    futures::stream::unfold(state, |mut st| async move {
        loop {
            if let Some(line) = st.pending.pop_front() {
                return Some((Ok(line), st));
            }
            if st.done {
                return None;
            }
            match st.reader.read(&mut st.buf[..]).await {
                Err(e) => {
                    st.done = true;
                    return Some((Err(e), st));
                }
                Ok(0) => {
                    st.done = true;
                    let tail = st.framer.finish();
                    publish_stats(&st.stats, st.framer.stats());
                    match tail {
                        Ok(Some(line)) => st.pending.push_back(line),
                        Ok(None) => {}
                        Err(e) => return Some((Err(frame_error_to_io(e)), st)),
                    }
                }
                Ok(n) => {
                    let pushed = st.framer.push(&st.buf[..n]);
                    publish_stats(&st.stats, st.framer.stats());
                    match pushed {
                        Ok(lines) => st.pending.extend(lines),
                        Err(e) => {
                            st.done = true;
                            return Some((Err(frame_error_to_io(e)), st));
                        }
                    }
                }
            }
        }
    })
}

/// Outgoing side: a `Sink<String>` that writes each line plus `\n` to `writer` and flushes.
pub fn line_sink<W>(writer: W) -> impl Sink<String, Error = io::Error> + Send + 'static
where
    W: AsyncWrite + Unpin + Send + 'static,
{
    futures::sink::unfold(writer, |mut writer, line: String| async move {
        let mut bytes = line.into_bytes();
        bytes.push(b'\n');
        writer.write_all(&bytes).await?;
        writer.flush().await?;
        Ok::<_, io::Error>(writer)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_across_chunks() {
        let mut f = LineFramer::new(1024);
        assert_eq!(f.push(b"{\"a\"").unwrap(), Vec::<String>::new());
        assert_eq!(
            f.push(b":1}\n{\"b\":2}\r\n").unwrap(),
            vec!["{\"a\":1}", "{\"b\":2}"]
        );
    }

    #[test]
    fn invalid_utf8_is_replaced_and_counted_not_fatal() {
        let mut f = LineFramer::new(1024);
        let out = f.push(b"{\"t\":\"\xff\xfe ok\"}\n").unwrap();
        assert_eq!(out, vec!["{\"t\":\"\u{FFFD}\u{FFFD} ok\"}"]);
        assert_eq!(f.stats().replaced_invalid_utf8_bytes, 2);
    }

    #[test]
    fn multibyte_char_split_between_chunks_is_not_corrupted() {
        let s = "測試\n".as_bytes();
        let mut f = LineFramer::new(1024);
        assert!(f.push(&s[..2]).unwrap().is_empty());
        assert_eq!(f.push(&s[2..]).unwrap(), vec!["測試"]);
        assert_eq!(f.stats().replaced_invalid_utf8_bytes, 0);
    }

    #[test]
    fn oversized_line_fails_before_newline_arrives() {
        let mut f = LineFramer::new(10);
        assert_eq!(
            f.push(&[b'x'; 11]),
            Err(FrameError::LineTooLong { max: 10 })
        );
        assert_eq!(f.push(b"\n"), Err(FrameError::LineTooLong { max: 10 })); // stays failed
    }

    #[test]
    fn exactly_max_is_allowed() {
        let mut f = LineFramer::new(10);
        assert_eq!(f.push(b"0123456789\n").unwrap(), vec!["0123456789"]);
    }

    #[test]
    fn empty_lines_skipped() {
        let mut f = LineFramer::new(10);
        assert_eq!(f.push(b"\n\r\n{}\n").unwrap(), vec!["{}"]);
        assert_eq!(f.stats().empty_lines_skipped, 2);
    }

    #[test]
    fn finish_returns_trailing_partial_line() {
        let mut f = LineFramer::new(10);
        f.push(b"{}").unwrap();
        assert_eq!(f.finish().unwrap(), Some("{}".to_string()));
    }

    #[test]
    fn non_json_line_is_passed_through() {
        // Framing does not parse JSON; the SDK answers a parse error and keeps the connection (ADR-0002 S3).
        let mut f = LineFramer::new(100);
        assert_eq!(
            f.push(b"not json at all\n").unwrap(),
            vec!["not json at all"]
        );
    }

    // --- extra edge cases beyond the packet's minimum ---

    #[test]
    fn crlf_split_between_chunks_is_stripped() {
        let mut f = LineFramer::new(1024);
        assert!(f.push(b"{}\r").unwrap().is_empty());
        assert_eq!(f.push(b"\n{\"b\":1}\r").unwrap(), vec!["{}"]);
        assert_eq!(f.push(b"\n").unwrap(), vec!["{\"b\":1}"]);
    }

    #[test]
    fn only_one_trailing_cr_is_stripped() {
        let mut f = LineFramer::new(1024);
        assert_eq!(f.push(b"a\r\r\n").unwrap(), vec!["a\r"]);
    }

    #[test]
    fn cap_counts_trailing_cr() {
        // Documented rule: every byte before `\n`, including `\r`, counts toward the cap.
        let mut f = LineFramer::new(10);
        assert_eq!(f.push(b"012345678\r\n").unwrap(), vec!["012345678"]);
        let mut f = LineFramer::new(10);
        assert_eq!(
            f.push(b"0123456789\r\n"),
            Err(FrameError::LineTooLong { max: 10 })
        );
    }

    #[test]
    fn oversized_line_found_in_a_later_chunk() {
        let mut f = LineFramer::new(10);
        assert!(f.push(b"abcde").unwrap().is_empty());
        assert_eq!(f.push(b"fghijk"), Err(FrameError::LineTooLong { max: 10 }));
        assert_eq!(f.finish(), Err(FrameError::LineTooLong { max: 10 }));
    }

    #[test]
    fn oversized_line_with_newline_in_same_chunk_fails() {
        let mut f = LineFramer::new(10);
        assert_eq!(
            f.push(b"01234567890\n"),
            Err(FrameError::LineTooLong { max: 10 })
        );
    }

    #[test]
    fn cap_applies_per_line_not_per_stream() {
        let mut f = LineFramer::new(4);
        let out = f.push(b"abcd\nefgh\nijkl\n").unwrap();
        assert_eq!(out, vec!["abcd", "efgh", "ijkl"]);
    }

    #[test]
    fn eof_without_newline_and_with_cr_or_nothing() {
        let mut f = LineFramer::new(10);
        f.push(b"{}\r").unwrap();
        assert_eq!(f.finish().unwrap(), Some("{}".to_string()));
        assert_eq!(f.finish().unwrap(), None);

        let mut f = LineFramer::new(10);
        assert_eq!(f.finish().unwrap(), None);
        assert_eq!(f.stats(), FramingStats::default());

        // A lone `\r` at EOF is an empty line.
        let mut f = LineFramer::new(10);
        f.push(b"\r").unwrap();
        assert_eq!(f.finish().unwrap(), None);
        assert_eq!(f.stats().empty_lines_skipped, 1);
    }

    #[test]
    fn truncated_multibyte_at_eof_is_replaced_and_counted() {
        let mut f = LineFramer::new(10);
        f.push(&"測".as_bytes()[..2]).unwrap();
        assert_eq!(f.finish().unwrap(), Some("\u{FFFD}".to_string()));
        assert_eq!(f.stats().replaced_invalid_utf8_bytes, 2);
    }

    #[test]
    fn stats_count_lines() {
        let mut f = LineFramer::new(100);
        f.push(b"a\n\nb\n").unwrap();
        assert_eq!(
            f.stats(),
            FramingStats {
                lines: 2,
                replaced_invalid_utf8_bytes: 0,
                empty_lines_skipped: 1
            }
        );
    }

    #[test]
    fn decode_matches_std_lossy_and_counts_input_bytes() {
        // Every 1-, 2- and 3-byte sequence over a byte set that covers ASCII, continuation bytes,
        // every lead-byte class, and invalid bytes.
        const SET: [u8; 14] = [
            0x00, b'a', 0x7f, 0x80, 0xbf, 0xc0, 0xc2, 0xe0, 0xe2, 0xed, 0xf0, 0xf4, 0xf5, 0xff,
        ];
        let mut seqs: Vec<Vec<u8>> = Vec::new();
        for &a in &SET {
            seqs.push(vec![a]);
            for &b in &SET {
                seqs.push(vec![a, b]);
                for &c in &SET {
                    seqs.push(vec![a, b, c]);
                }
            }
        }
        seqs.push(vec![0xf0, 0x9f, 0x98]); // truncated 4-byte sequence
        seqs.push(vec![0xf0, 0x9f, 0x98, 0x80]); // valid U+1F600
        for seq in seqs {
            let mut stats = FramingStats::default();
            let ours = decode_lossy(&seq, &mut stats);
            let std_out = String::from_utf8_lossy(&seq).into_owned();
            assert_eq!(ours, std_out, "input {seq:02x?}");
            // The inputs never contain a literal U+FFFD, so every U+FFFD in the output is a
            // replacement that consumed at least one input byte.
            let replacements = ours.matches('\u{FFFD}').count() as u64;
            assert!(
                stats.replaced_invalid_utf8_bytes >= replacements,
                "input {seq:02x?}"
            );
            assert!(stats.replaced_invalid_utf8_bytes <= seq.len() as u64);
            if std::str::from_utf8(&seq).is_ok() {
                assert_eq!(stats.replaced_invalid_utf8_bytes, 0, "input {seq:02x?}");
            }
        }
    }
}
