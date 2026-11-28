//! Bounded live stream of committed events (events.md "Subscriptions and backpressure").

use std::sync::Arc;

use agentdock_core::EventEnvelope;
use tokio::sync::broadcast::{self, error::RecvError, error::TryRecvError};

use crate::Store;

/// Events a subscriber may fall behind by before it gets [`StreamItem::Lagged`].
pub const SUBSCRIBER_BUFFER: usize = 2048;
/// Batch caps of one [`StreamItem::Events`] (events.md: 256 events or 512 KiB of envelope JSON).
const MAX_BATCH_EVENTS: usize = 256;
const MAX_BATCH_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum StreamItem {
    /// Committed events of the store's authority, in `seq` order, without gaps.
    Events(Vec<EventEnvelope>),
    /// The buffer overflowed and this live stream ended: page with
    /// [`Store::events_after`] from `resume_after_seq`, then subscribe again.
    Lagged { resume_after_seq: u64 },
}

/// One committed event; `bytes` is the length of its stored JSON.
pub(crate) struct Published {
    pub env: EventEnvelope,
    pub bytes: usize,
}

pub(crate) struct Hub {
    tx: broadcast::Sender<Arc<Published>>,
}

impl Hub {
    pub fn new() -> Hub {
        Hub {
            tx: broadcast::channel(SUBSCRIBER_BUFFER).0,
        }
    }

    /// Called only after `COMMIT`. A failed send only means nobody is subscribed.
    pub fn publish(&self, events: Vec<Published>) {
        for p in events {
            let _ = self.tx.send(Arc::new(p));
        }
    }
}

impl Store {
    /// A live stream of events committed after this call. Bounded ([`SUBSCRIBER_BUFFER`]);
    /// overflow ends it with [`StreamItem::Lagged`].
    pub fn subscribe(&self) -> Subscription {
        // Under the connection mutex no commit is in flight, so `head` and the receiver's
        // starting point agree: every event with `seq > head` will be delivered.
        let guard = self.lock();
        Subscription {
            rx: self.hub.tx.subscribe(),
            last_seq: guard.head,
            carry: None,
            lagged: false,
            done: false,
        }
    }
}

pub struct Subscription {
    rx: broadcast::Receiver<Arc<Published>>,
    /// Last `seq` delivered (or the head when subscribing).
    last_seq: u64,
    /// Received but not yet delivered because the previous batch was full.
    carry: Option<Arc<Published>>,
    /// Overflow noticed while filling a batch; reported by the next call.
    lagged: bool,
    done: bool,
}

impl Subscription {
    /// The next batch, `Lagged` once if this subscriber fell behind, then `None` (also `None`
    /// once the store is dropped).
    pub async fn next(&mut self) -> Option<StreamItem> {
        if self.done {
            return None;
        }
        if self.lagged {
            return Some(self.lag());
        }
        let first = match self.carry.take() {
            Some(p) => p,
            None => match self.rx.recv().await {
                Ok(p) => p,
                Err(RecvError::Lagged(_)) => return Some(self.lag()),
                Err(RecvError::Closed) => {
                    self.done = true;
                    return None;
                }
            },
        };
        let mut bytes = first.bytes;
        let mut batch = vec![first.env.clone()];
        while batch.len() < MAX_BATCH_EVENTS {
            match self.rx.try_recv() {
                Ok(p) if bytes + p.bytes > MAX_BATCH_BYTES => {
                    self.carry = Some(p);
                    break;
                }
                Ok(p) => {
                    bytes += p.bytes;
                    batch.push(p.env.clone());
                }
                Err(TryRecvError::Lagged(_)) => {
                    self.lagged = true;
                    break;
                }
                Err(TryRecvError::Empty | TryRecvError::Closed) => break,
            }
        }
        if let Some(last) = batch.last() {
            self.last_seq = last.seq;
        }
        Some(StreamItem::Events(batch))
    }

    fn lag(&mut self) -> StreamItem {
        self.done = true;
        self.carry = None;
        StreamItem::Lagged {
            resume_after_seq: self.last_seq,
        }
    }
}
