//! Per-session permission FIFO (P3-4 §5 step 3). This is the only permission queue in AgentDock
//! (P4-3 §5A rule 4): P4-3 and P8-3 keep none.
//!
//! Rules:
//! - One forwarded (active) request per session; later ones wait without an event.
//! - `Selected` answers the active request and promotes the next waiting one.
//! - `Cancelled` (and `cancel_session` / `close`) answers the active request and every waiting
//!   one `cancelled`, drops them and promotes nothing, so no `PermissionRequested` is ever
//!   emitted for a request of a cancelled turn (P4-3 §5A rows C2, C5).
//!
//! The registry never awaits and never emits: it returns the event to emit and the caller
//! sends it after the lock is released. Agent responders are also called after the lock is
//! released.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, MutexGuard, PoisonError};

use super::events::{AcpEvent, AcpSessionId, PermissionOptionView, PermissionTicket};
use super::AcpError;

/// The answer sent back to the agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Outcome {
    Selected(String),
    Cancelled,
}

/// Answers one agent request. The SDK `Responder` in production, a fake in unit tests.
/// Implementations must not block: they only queue the JSON-RPC response.
pub(crate) trait PermissionResponder: Send {
    fn respond(self: Box<Self>, outcome: Outcome);
}

struct Pending {
    ticket: PermissionTicket,
    session: AcpSessionId,
    tool_call: serde_json::Value,
    options: Vec<PermissionOptionView>,
    responder: Box<dyn PermissionResponder>,
}

impl Pending {
    fn event(&self) -> AcpEvent {
        AcpEvent::PermissionRequested {
            ticket: self.ticket,
            session: self.session.clone(),
            tool_call: self.tool_call.clone(),
            options: self.options.clone(),
        }
    }
}

#[derive(Default)]
struct SessionQueue {
    active: Option<Pending>,
    waiting: VecDeque<Pending>,
}

#[derive(Default)]
struct Inner {
    /// Last ticket handed out; tickets start at 1.
    last_ticket: u64,
    sessions: HashMap<AcpSessionId, SessionQueue>,
    /// Set when the connection ended or is shutting down; nothing is queued afterwards.
    closed: bool,
}

#[derive(Default)]
pub(crate) struct PermissionRegistry {
    inner: Mutex<Inner>,
}

impl PermissionRegistry {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        // The lock only guards plain data; a panic elsewhere must not stop answering the agent.
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Queues a request. Returns the `PermissionRequested` event to emit when it became the
    /// session's active request, `None` when it waits behind another one. After `close` the
    /// request is answered `cancelled` at once.
    pub(crate) fn enqueue(
        &self,
        session: AcpSessionId,
        tool_call: serde_json::Value,
        options: Vec<PermissionOptionView>,
        responder: Box<dyn PermissionResponder>,
    ) -> Option<AcpEvent> {
        let mut inner = self.lock();
        if inner.closed {
            drop(inner);
            responder.respond(Outcome::Cancelled);
            return None;
        }
        inner.last_ticket += 1;
        let pending = Pending {
            ticket: PermissionTicket(inner.last_ticket),
            session: session.clone(),
            tool_call,
            options,
            responder,
        };
        let queue = inner.sessions.entry(session).or_default();
        if queue.active.is_none() {
            let event = pending.event();
            queue.active = Some(pending);
            Some(event)
        } else {
            queue.waiting.push_back(pending);
            None
        }
    }

    /// Answers the active request `ticket`. Returns the event of the promoted request, if any.
    ///
    /// Errors leave the queue untouched and do not answer the agent: `UnknownTicket` (never
    /// forwarded, already answered, or cancelled), `OptionNotOffered`, `Closed`.
    pub(crate) fn respond(
        &self,
        ticket: PermissionTicket,
        decision: super::events::PermissionDecision,
    ) -> Result<Option<AcpEvent>, AcpError> {
        use super::events::PermissionDecision;

        let (answered, outcome, dropped, promoted) = {
            let mut inner = self.lock();
            if inner.closed {
                return Err(AcpError::Closed);
            }
            let session = inner
                .sessions
                .iter()
                .find(|(_, q)| q.active.as_ref().is_some_and(|p| p.ticket == ticket))
                .map(|(s, _)| s.clone())
                .ok_or(AcpError::UnknownTicket)?;
            match decision {
                PermissionDecision::Selected { option_id } => {
                    let queue = inner
                        .sessions
                        .get_mut(&session)
                        .ok_or(AcpError::UnknownTicket)?;
                    let offered = queue
                        .active
                        .as_ref()
                        .is_some_and(|p| p.options.iter().any(|o| o.option_id == option_id));
                    if !offered {
                        return Err(AcpError::OptionNotOffered(option_id));
                    }
                    let answered = queue.active.take().ok_or(AcpError::UnknownTicket)?;
                    queue.active = queue.waiting.pop_front();
                    let promoted = queue.active.as_ref().map(Pending::event);
                    if queue.active.is_none() {
                        inner.sessions.remove(&session);
                    }
                    (answered, Outcome::Selected(option_id), Vec::new(), promoted)
                }
                PermissionDecision::Cancelled => {
                    let queue = inner
                        .sessions
                        .remove(&session)
                        .ok_or(AcpError::UnknownTicket)?;
                    let answered = queue.active.ok_or(AcpError::UnknownTicket)?;
                    let dropped: Vec<Pending> = queue.waiting.into_iter().collect();
                    (answered, Outcome::Cancelled, dropped, None)
                }
            }
        };
        answered.responder.respond(outcome);
        for pending in dropped {
            pending.responder.respond(Outcome::Cancelled);
        }
        Ok(promoted)
    }

    /// Answers the session's active and waiting requests `cancelled` and removes them.
    pub(crate) fn cancel_session(&self, session: &AcpSessionId) {
        let queue = self.lock().sessions.remove(session);
        if let Some(queue) = queue {
            answer_cancelled(queue);
        }
    }

    /// Marks the registry closed and answers every open request `cancelled`. Idempotent.
    pub(crate) fn close(&self) {
        let sessions = {
            let mut inner = self.lock();
            inner.closed = true;
            std::mem::take(&mut inner.sessions)
        };
        for queue in sessions.into_values() {
            answer_cancelled(queue);
        }
    }
}

fn answer_cancelled(queue: SessionQueue) {
    for pending in queue.active.into_iter().chain(queue.waiting) {
        pending.responder.respond(Outcome::Cancelled);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::super::events::{PermissionDecision, PermissionKind};
    use super::*;

    type Log = Arc<Mutex<Vec<(u32, Outcome)>>>;

    struct Fake {
        id: u32,
        log: Log,
    }

    impl PermissionResponder for Fake {
        fn respond(self: Box<Self>, outcome: Outcome) {
            self.log.lock().unwrap().push((self.id, outcome));
        }
    }

    fn session() -> AcpSessionId {
        AcpSessionId("s1".into())
    }

    fn options() -> Vec<PermissionOptionView> {
        vec![
            PermissionOptionView {
                option_id: "allow-once".into(),
                name: "Allow once".into(),
                kind: PermissionKind::AllowOnce,
            },
            PermissionOptionView {
                option_id: "reject-once".into(),
                name: "Reject".into(),
                kind: PermissionKind::RejectOnce,
            },
        ]
    }

    fn enqueue(reg: &PermissionRegistry, s: AcpSessionId, id: u32, log: &Log) -> Option<AcpEvent> {
        reg.enqueue(
            s,
            serde_json::json!({ "toolCallId": format!("call_{id}") }),
            options(),
            Box::new(Fake {
                id,
                log: log.clone(),
            }),
        )
    }

    fn ticket_of(ev: &AcpEvent) -> PermissionTicket {
        match ev {
            AcpEvent::PermissionRequested { ticket, .. } => *ticket,
            other => panic!("unexpected event {other:?}"),
        }
    }

    fn selected(option: &str) -> PermissionDecision {
        PermissionDecision::Selected {
            option_id: option.into(),
        }
    }

    #[test]
    fn second_permission_waits_for_first() {
        let reg = PermissionRegistry::default();
        let log = Log::default();
        let first = enqueue(&reg, session(), 1, &log).expect("first is forwarded");
        assert!(
            enqueue(&reg, session(), 2, &log).is_none(),
            "second must wait"
        );
        let promoted = reg
            .respond(ticket_of(&first), selected("allow-once"))
            .unwrap()
            .expect("second is promoted after the first is answered");
        match &promoted {
            AcpEvent::PermissionRequested { tool_call, .. } => {
                assert_eq!(tool_call["toolCallId"], "call_2");
            }
            other => panic!("unexpected event {other:?}"),
        }
        assert!(ticket_of(&promoted) > ticket_of(&first));
        assert_eq!(
            *log.lock().unwrap(),
            vec![(1, Outcome::Selected("allow-once".into()))]
        );
        assert!(reg
            .respond(ticket_of(&promoted), selected("reject-once"))
            .unwrap()
            .is_none());
        assert!(reg.lock().sessions.is_empty());
    }

    #[test]
    fn cancelled_response_drops_waiting() {
        let reg = PermissionRegistry::default();
        let log = Log::default();
        let first = enqueue(&reg, session(), 1, &log).unwrap();
        assert!(enqueue(&reg, session(), 2, &log).is_none());
        let promoted = reg
            .respond(ticket_of(&first), PermissionDecision::Cancelled)
            .unwrap();
        assert!(promoted.is_none(), "a cancelled answer promotes nothing");
        assert_eq!(
            *log.lock().unwrap(),
            vec![(1, Outcome::Cancelled), (2, Outcome::Cancelled)]
        );
        assert!(reg.lock().sessions.is_empty(), "the session queue is empty");
        // A later request of the same session is forwarded again.
        let again = enqueue(&reg, session(), 3, &log).expect("new request becomes active");
        assert!(ticket_of(&again) > ticket_of(&first));
    }

    // --- extra edge cases beyond the packet's minimum ---

    #[test]
    fn errors_do_not_answer_the_agent_or_change_the_queue() {
        let reg = PermissionRegistry::default();
        let log = Log::default();
        let first = enqueue(&reg, session(), 1, &log).unwrap();
        assert!(enqueue(&reg, session(), 2, &log).is_none());
        let t = ticket_of(&first);
        assert!(matches!(
            reg.respond(t, selected("allow-always")),
            Err(AcpError::OptionNotOffered(o)) if o == "allow-always"
        ));
        // The waiting request's ticket was never forwarded.
        assert!(matches!(
            reg.respond(PermissionTicket(t.0 + 1), selected("allow-once")),
            Err(AcpError::UnknownTicket)
        ));
        assert!(log.lock().unwrap().is_empty());
        assert!(reg.respond(t, selected("allow-once")).unwrap().is_some());
        assert!(matches!(
            reg.respond(t, selected("allow-once")),
            Err(AcpError::UnknownTicket)
        ));
    }

    #[test]
    fn cancel_session_only_touches_that_session_and_close_answers_everything() {
        let reg = PermissionRegistry::default();
        let log = Log::default();
        let other = AcpSessionId("s2".into());
        enqueue(&reg, session(), 1, &log).unwrap();
        enqueue(&reg, session(), 2, &log);
        enqueue(&reg, other.clone(), 3, &log).unwrap();
        reg.cancel_session(&session());
        assert_eq!(
            *log.lock().unwrap(),
            vec![(1, Outcome::Cancelled), (2, Outcome::Cancelled)]
        );
        reg.close();
        reg.close();
        assert_eq!(log.lock().unwrap().len(), 3);
        // After close: answered `cancelled` at once, never forwarded.
        assert!(enqueue(&reg, other, 4, &log).is_none());
        assert_eq!(log.lock().unwrap()[3], (4, Outcome::Cancelled));
        assert!(matches!(
            reg.respond(PermissionTicket(3), selected("allow-once")),
            Err(AcpError::Closed)
        ));
    }
}
