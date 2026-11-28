use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use agentdock_acp::{framed_lines, line_sink, FramingStats, DEFAULT_MAX_LINE_BYTES};
use futures::{SinkExt, StreamExt};
use tokio::io::{duplex, AsyncRead, AsyncReadExt, AsyncWriteExt, ReadBuf};

fn new_stats() -> Arc<Mutex<FramingStats>> {
    Arc::new(Mutex::new(FramingStats::default()))
}

/// Counts every byte handed to the consumer, to prove reading stops near the cap.
struct CountingReader<R> {
    inner: R,
    read: Arc<AtomicU64>,
}

impl<R: AsyncRead + Unpin> AsyncRead for CountingReader<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let res = Pin::new(&mut self.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &res {
            self.read
                .fetch_add((buf.filled().len() - before) as u64, Ordering::Relaxed);
        }
        res
    }
}

#[tokio::test]
async fn stream_yields_lines_from_duplex() {
    let (mut tx, rx) = duplex(64);
    let stats = new_stats();
    let stream = framed_lines(rx, 1024, stats.clone());
    tokio::spawn(async move {
        tx.write_all(b"{\"a\":1}\n\n{\"b\":2}\r\n").await.unwrap();
        tx.write_all(b"not json\n").await.unwrap();
        // closing `tx` ends the stream
    });
    let items: Vec<String> = stream.map(|r| r.unwrap()).collect().await;
    assert_eq!(items, vec!["{\"a\":1}", "{\"b\":2}", "not json"]);
    let s = *stats.lock().unwrap();
    assert_eq!(s.lines, 3);
    assert_eq!(s.empty_lines_skipped, 1);
}

#[tokio::test]
async fn stream_flushes_trailing_line_without_newline_at_eof() {
    let (mut tx, rx) = duplex(64);
    let stream = framed_lines(rx, 1024, new_stats());
    tokio::spawn(async move {
        tx.write_all(b"{\"a\":1}\n{\"b\":2}").await.unwrap();
    });
    let items: Vec<String> = stream.map(|r| r.unwrap()).collect().await;
    assert_eq!(items, vec!["{\"a\":1}", "{\"b\":2}"]);
}

#[tokio::test]
async fn stream_turns_too_long_into_invalid_data() {
    let max = 100;
    let (mut tx, rx) = duplex(1024);
    let stream = framed_lines(rx, max, new_stats());
    // Fits in the duplex buffer. `tx` stays open until the end of the test: the error must come
    // without waiting for a newline or EOF.
    tx.write_all(&vec![b'x'; max + 1]).await.unwrap();
    let mut stream = Box::pin(stream);
    let first = stream.next().await.expect("stream ended without an item");
    let err = first.expect_err("expected an error item");
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(
        stream.next().await.is_none(),
        "stream must end after the error"
    );
}

#[tokio::test]
async fn stream_handles_64_mib_line_with_cap_16_mib() {
    const TOTAL: usize = 64 * 1024 * 1024;
    let (mut tx, rx) = duplex(64 * 1024);
    let read = Arc::new(AtomicU64::new(0));
    let reader = CountingReader {
        inner: rx,
        read: read.clone(),
    };
    let stats = new_stats();
    let writer = tokio::spawn(async move {
        let batch = vec![b'x'; 1024 * 1024];
        let mut written = 0usize;
        while written < TOTAL {
            if tx.write_all(&batch).await.is_err() {
                return written; // reader went away after the error: expected
            }
            written += batch.len();
        }
        written
    });
    let mut stream = Box::pin(framed_lines(reader, DEFAULT_MAX_LINE_BYTES, stats));
    let err = stream
        .next()
        .await
        .expect("stream ended without an item")
        .expect_err("expected an error item");
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    assert!(stream.next().await.is_none());
    drop(stream); // drops the reader, which unblocks and ends the writer

    let consumed = read.load(Ordering::Relaxed);
    assert!(
        consumed <= (DEFAULT_MAX_LINE_BYTES + 8 * 1024) as u64,
        "read {consumed} bytes before failing"
    );
    assert!(consumed > DEFAULT_MAX_LINE_BYTES as u64);
    let written = writer.await.unwrap();
    assert!(written < TOTAL, "writer should have been cut off early");
}

#[tokio::test]
async fn stream_exactly_at_cap_is_accepted() {
    let max = 64 * 1024;
    let (mut tx, rx) = duplex(4096);
    let stream = framed_lines(rx, max, new_stats());
    tokio::spawn(async move {
        let mut line = vec![b'y'; max];
        line.push(b'\n');
        tx.write_all(&line).await.unwrap();
    });
    let items: Vec<String> = stream.map(|r| r.unwrap()).collect().await;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].len(), max);
}

#[tokio::test]
async fn stream_invalid_utf8_does_not_end_the_stream() {
    let (mut tx, rx) = duplex(64);
    let stats = new_stats();
    let stream = framed_lines(rx, 1024, stats.clone());
    tokio::spawn(async move {
        tx.write_all(b"{\"t\":\"\xff\"}\n{\"ok\":true}\n")
            .await
            .unwrap();
    });
    let items: Vec<String> = stream.map(|r| r.unwrap()).collect().await;
    assert_eq!(items, vec!["{\"t\":\"\u{FFFD}\"}", "{\"ok\":true}"]);
    assert_eq!(stats.lock().unwrap().replaced_invalid_utf8_bytes, 1);
}

#[tokio::test]
async fn sink_appends_newline_and_flushes() {
    let (tx, mut rx) = duplex(64);
    let mut sink = Box::pin(line_sink(tx));
    sink.send("a".to_string()).await.unwrap();
    sink.send("b".to_string()).await.unwrap();
    // No `close()` and no drop of the sink: the data must already be readable.
    let mut got = [0u8; 4];
    rx.read_exact(&mut got).await.unwrap();
    assert_eq!(&got, b"a\nb\n");
}

#[tokio::test]
async fn sink_reports_write_error_when_peer_is_gone() {
    let (tx, rx) = duplex(64);
    drop(rx);
    let mut sink = Box::pin(line_sink(tx));
    assert!(sink.send("a".to_string()).await.is_err());
}

/// Compile-time check that the facade plugs into the SDK's `Lines` transport.
#[tokio::test]
async fn framing_plugs_into_sdk_lines_transport() {
    let (tx, _peer_rx) = duplex(64);
    let (_peer_tx, rx) = duplex(64);
    let _lines = agent_client_protocol::Lines::new(
        line_sink(tx),
        framed_lines(rx, DEFAULT_MAX_LINE_BYTES, new_stats()),
    );
}
