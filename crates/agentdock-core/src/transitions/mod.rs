//! Task and session transition checks (ADR-0003 section 2 and 9, P2-3).
//!
//! The table is loaded from `docs/contracts/transitions.json` (the single source of truth) and
//! never copied into Rust. The checks are pure: no I/O, no clock (time is `now`), and every fact
//! comes from the store through [`TaskFacts`] / [`SessionFacts`].
//!
//! Requests carry the typed `task.state_changed` / `session.state_changed` payloads from P2-2.
//! The checks do not re-run the payload's schema rules (`PayloadRules::validate`): that is the
//! decode layer's job. They do require that a transition other than creation carries a payload
//! and that the payload agrees with the request (`from`, `to`, `trigger`, `launch_method`).

pub mod conditions;
pub mod facts;

use std::collections::HashSet;
use std::sync::OnceLock;

use serde::de::DeserializeOwned;
use serde::Deserialize;

pub use conditions::Condition;
pub use facts::{ChecksSincePhase, InterruptionFacts, LaunchCapabilities, SessionFacts, TaskFacts};

use crate::payload::{SessionStateChangedPayload, TaskStateChangedPayload};
use crate::{
    ActorKind, LaunchMethod, SessionState, SessionTrigger, TaskState, TaskTrigger, Timestamp,
};

const TRANSITIONS_JSON: &str = include_str!("../../../../docs/contracts/transitions.json");

/// What must be durable before what (`transitions.json` `durability`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Durability {
    /// Commit the event before any subscriber, UI or agent sees it.
    PersistThenReport,
    /// Commit the event before performing the side effect it authorizes.
    PersistThenAct,
}

/// One row of `transitions.json`.
#[derive(Debug, Clone)]
pub struct TransitionRule {
    /// `"T12"`, `"S20"`.
    pub id: String,
    /// `None` is creation (`T01`, `S01`) and nothing else.
    pub from: Option<String>,
    pub to: String,
    pub actors: Vec<ActorKind>,
    pub triggers: Vec<String>,
    pub durability: Durability,
    pub conditions: Vec<Condition>,
}

#[derive(Debug, Clone)]
pub struct TransitionTable {
    pub task: Vec<TransitionRule>,
    pub session: Vec<TransitionRule>,
}

/// The table could not be loaded. The store must refuse to start (fail closed).
#[derive(Debug, thiserror::Error)]
pub enum TableError {
    #[error("transitions.json: {0}")]
    Parse(String),
    #[error("unknown condition {0:?}")]
    UnknownCondition(String),
}

#[derive(Deserialize)]
struct RawFile {
    task: RawGraph,
    session: RawGraph,
}

#[derive(Deserialize)]
struct RawGraph {
    transitions: Vec<RawRule>,
}

#[derive(Deserialize)]
struct RawRule {
    id: String,
    from: Option<String>,
    to: String,
    actors: Vec<String>,
    triggers: Vec<String>,
    durability: String,
    #[serde(default)]
    conditions: Vec<String>,
}

fn parse_err(msg: impl Into<String>) -> TableError {
    TableError::Parse(msg.into())
}

/// Parses a wire name into a contract enum through its serde representation.
fn wire<T: DeserializeOwned>(kind: &str, rule: &str, name: &str) -> Result<T, TableError> {
    serde_json::from_value(serde_json::Value::String(name.to_owned()))
        .map_err(|_| parse_err(format!("{rule}: unknown {kind} {name:?}")))
}

fn convert_graph<S, Tr>(
    raw: RawGraph,
    domain: &str,
    condition_ok: fn(Condition) -> bool,
) -> Result<Vec<TransitionRule>, TableError>
where
    S: DeserializeOwned,
    Tr: DeserializeOwned,
{
    let mut ids = HashSet::new();
    let mut pairs = HashSet::new();
    let mut rules = Vec::with_capacity(raw.transitions.len());
    for r in raw.transitions {
        if !ids.insert(r.id.clone()) {
            return Err(parse_err(format!("duplicate rule id {}", r.id)));
        }
        if !pairs.insert((r.from.clone(), r.to.clone())) {
            return Err(parse_err(format!(
                "{}: second rule for {:?} -> {}",
                r.id, r.from, r.to
            )));
        }
        if let Some(from) = &r.from {
            wire::<S>("state", &r.id, from)?;
        }
        wire::<S>("state", &r.id, &r.to)?;
        if r.actors.is_empty() || r.triggers.is_empty() {
            return Err(parse_err(format!("{}: no actors or triggers", r.id)));
        }
        let actors = r
            .actors
            .iter()
            .map(|a| wire::<ActorKind>("actor", &r.id, a))
            .collect::<Result<Vec<_>, _>>()?;
        for t in &r.triggers {
            wire::<Tr>("trigger", &r.id, t)?;
        }
        let durability = match r.durability.as_str() {
            "persist_then_report" => Durability::PersistThenReport,
            "persist_then_act" => Durability::PersistThenAct,
            other => return Err(parse_err(format!("{}: unknown durability {other:?}", r.id))),
        };
        let mut conditions = Vec::with_capacity(r.conditions.len());
        for name in &r.conditions {
            let cond = Condition::from_name(name)
                .ok_or_else(|| TableError::UnknownCondition(name.clone()))?;
            if !condition_ok(cond) {
                return Err(parse_err(format!(
                    "{}: condition {name} does not apply to {domain} rules",
                    r.id
                )));
            }
            conditions.push(cond);
        }
        // Creation (`from: null`) is only ever the first state, never a guarded transition.
        if r.from.is_none() && !conditions.is_empty() {
            return Err(parse_err(format!("{}: creation rule has conditions", r.id)));
        }
        rules.push(TransitionRule {
            id: r.id,
            from: r.from,
            to: r.to,
            actors,
            triggers: r.triggers,
            durability,
            conditions,
        });
    }
    Ok(rules)
}

/// Builds a table from `transitions.json` text. An unknown condition name is
/// [`TableError::UnknownCondition`]; any other mismatch with the code is [`TableError::Parse`].
pub(crate) fn parse_table(json: &str) -> Result<TransitionTable, TableError> {
    let raw: RawFile = serde_json::from_str(json).map_err(|e| parse_err(e.to_string()))?;
    Ok(TransitionTable {
        task: convert_graph::<TaskState, TaskTrigger>(
            raw.task,
            "task",
            Condition::applies_to_tasks,
        )?,
        session: convert_graph::<SessionState, SessionTrigger>(
            raw.session,
            "session",
            Condition::applies_to_sessions,
        )?,
    })
}

/// The table, parsed once from `docs/contracts/transitions.json`. Store init calls this at
/// startup and must not start on `Err`.
pub fn try_table() -> Result<&'static TransitionTable, &'static TableError> {
    static TABLE: OnceLock<Result<TransitionTable, TableError>> = OnceLock::new();
    TABLE.get_or_init(|| parse_table(TRANSITIONS_JSON)).as_ref()
}

pub struct TaskTransitionRequest<'a> {
    /// `None` for `task.created`.
    pub from: Option<TaskState>,
    pub to: TaskState,
    pub actor: ActorKind,
    pub trigger: TaskTrigger,
    /// `None` only for `task.created`; required for every other transition.
    pub payload: Option<&'a TaskStateChangedPayload>,
    pub now: Timestamp,
}

pub struct SessionTransitionRequest<'a> {
    /// `None` for `session.created`.
    pub from: Option<SessionState>,
    pub to: SessionState,
    pub actor: ActorKind,
    pub trigger: SessionTrigger,
    /// `None` only for `session.created`; required for every other transition.
    pub payload: Option<&'a SessionStateChangedPayload>,
    /// From the payload or `session.created`.
    pub launch_method: Option<LaunchMethod>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TransitionError {
    #[error("{0} transition needs a state_changed payload")]
    MissingPayload(&'static str),
    #[error("payload {field} differs from the request")]
    PayloadMismatch { field: &'static str },
    #[error("illegal transition {from:?} -> {to:?}")]
    Illegal { from: Option<String>, to: String },
    #[error("{rule}: actor {actor:?} not allowed")]
    Actor { rule: String, actor: ActorKind },
    #[error("{rule}: trigger {trigger} not allowed")]
    Trigger { rule: String, trigger: String },
    #[error("{rule}: condition {condition:?} failed: {detail}")]
    Condition {
        rule: String,
        condition: Condition,
        detail: &'static str,
    },
}

fn mismatch(field: &'static str) -> TransitionError {
    TransitionError::PayloadMismatch { field }
}

/// Creation carries no `state_changed` payload; every other transition must, and it must say the
/// same `from`, `to` and `trigger` as the request.
fn cross_check_task(req: &TaskTransitionRequest<'_>) -> Result<(), TransitionError> {
    match (req.from, req.payload) {
        (None, None) => Ok(()),
        (None, Some(_)) => Err(mismatch("from")),
        (Some(_), None) => Err(TransitionError::MissingPayload("task")),
        (Some(from), Some(p)) => {
            if p.from != from {
                Err(mismatch("from"))
            } else if p.to != req.to {
                Err(mismatch("to"))
            } else if p.trigger != req.trigger {
                Err(mismatch("trigger"))
            } else {
                Ok(())
            }
        }
    }
}

fn cross_check_session(req: &SessionTransitionRequest<'_>) -> Result<(), TransitionError> {
    match (req.from, req.payload) {
        (None, None) => Ok(()),
        (None, Some(_)) => Err(mismatch("from")),
        (Some(_), None) => Err(TransitionError::MissingPayload("session")),
        (Some(from), Some(p)) => {
            if p.from != from {
                Err(mismatch("from"))
            } else if p.to != req.to {
                Err(mismatch("to"))
            } else if p.trigger != req.trigger {
                Err(mismatch("trigger"))
            } else if p.launch_method.is_some()
                && req.launch_method.is_some()
                && p.launch_method != req.launch_method
            {
                Err(mismatch("launch_method"))
            } else {
                Ok(())
            }
        }
    }
}

fn find_rule<'t>(
    rules: &'t [TransitionRule],
    from: Option<&'static str>,
    to: &'static str,
) -> Result<&'t TransitionRule, TransitionError> {
    rules
        .iter()
        .find(|r| r.from.as_deref() == from && r.to == to)
        .ok_or_else(|| TransitionError::Illegal {
            from: from.map(str::to_owned),
            to: to.to_owned(),
        })
}

fn check_actor_and_trigger(
    rule: &TransitionRule,
    actor: ActorKind,
    trigger: &'static str,
) -> Result<(), TransitionError> {
    if !rule.actors.contains(&actor) {
        return Err(TransitionError::Actor {
            rule: rule.id.clone(),
            actor,
        });
    }
    if !rule.triggers.iter().any(|t| t == trigger) {
        return Err(TransitionError::Trigger {
            rule: rule.id.clone(),
            trigger: trigger.to_owned(),
        });
    }
    Ok(())
}

/// Finds the rule for `from -> to`, then checks actor, trigger and each condition in order.
/// Returns the rule, or the first reason for rejection.
pub fn check_task_transition<'t>(
    table: &'t TransitionTable,
    req: &TaskTransitionRequest<'_>,
    facts: &TaskFacts,
) -> Result<&'t TransitionRule, TransitionError> {
    cross_check_task(req)?;
    let rule = find_rule(
        &table.task,
        req.from.map(TaskState::as_str),
        req.to.as_str(),
    )?;
    check_actor_and_trigger(rule, req.actor, req.trigger.as_str())?;
    for &condition in &rule.conditions {
        conditions::check_task_condition(condition, req, facts).map_err(|detail| {
            TransitionError::Condition {
                rule: rule.id.clone(),
                condition,
                detail,
            }
        })?;
    }
    Ok(rule)
}

/// Session counterpart of [`check_task_transition`].
pub fn check_session_transition<'t>(
    table: &'t TransitionTable,
    req: &SessionTransitionRequest<'_>,
    facts: &SessionFacts,
) -> Result<&'t TransitionRule, TransitionError> {
    cross_check_session(req)?;
    let rule = find_rule(
        &table.session,
        req.from.map(SessionState::as_str),
        req.to.as_str(),
    )?;
    check_actor_and_trigger(rule, req.actor, req.trigger.as_str())?;
    for &condition in &rule.conditions {
        conditions::check_session_condition(condition, req, facts).map_err(|detail| {
            TransitionError::Condition {
                rule: rule.id.clone(),
                condition,
                detail,
            }
        })?;
    }
    Ok(rule)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_loads_with_expected_counts() {
        let table = try_table().unwrap();
        assert_eq!(table.task.len(), 47);
        assert_eq!(table.session.len(), 25);
        assert!(table.task.iter().all(|r| r.from.is_some() || r.id == "T01"));
        assert!(table
            .session
            .iter()
            .all(|r| r.from.is_some() || r.id == "S01"));
    }

    #[test]
    fn unknown_enum_names_fail_closed() {
        let bad_state = r#"{"task":{"transitions":[{"id":"T1","from":null,"to":"paused","actors":["user"],"triggers":["task_created"],"durability":"persist_then_report"}]},"session":{"transitions":[]}}"#;
        assert!(matches!(parse_table(bad_state), Err(TableError::Parse(_))));
        let bad_actor = bad_state
            .replace("paused", "queued")
            .replace("\"user\"", "\"root\"");
        assert!(matches!(parse_table(&bad_actor), Err(TableError::Parse(_))));
        assert!(matches!(parse_table("{"), Err(TableError::Parse(_))));
    }

    #[test]
    fn duplicate_pair_and_misplaced_condition_fail_closed() {
        let rule = |id: &str, cond: &str| {
            format!(
                r#"{{"id":"{id}","from":"queued","to":"cancelled","actors":["user"],"triggers":["user_cancel"],"durability":"persist_then_report","conditions":[{cond}]}}"#
            )
        };
        let wrap = |rules: String| {
            format!(r#"{{"task":{{"transitions":[{rules}]}},"session":{{"transitions":[]}}}}"#)
        };
        let dup = wrap(format!("{},{}", rule("T1", ""), rule("T2", "")));
        assert!(matches!(parse_table(&dup), Err(TableError::Parse(_))));
        let misplaced = wrap(rule("T1", "\"launch_method_advertised\""));
        assert!(matches!(parse_table(&misplaced), Err(TableError::Parse(_))));
    }

    #[test]
    fn unknown_condition_fails_closed() {
        let json = r#"{"task":{"transitions":[{"id":"T3","from":"queued","to":"cancelled","actors":["user"],"triggers":["user_cancel"],"durability":"persist_then_report","conditions":["made_up"]}]},"session":{"transitions":[]}}"#;
        match parse_table(json) {
            Err(TableError::UnknownCondition(name)) => assert_eq!(name, "made_up"),
            other => panic!("expected UnknownCondition, got {other:?}"),
        }
    }

    #[test]
    fn condition_names_roundtrip() {
        for c in Condition::ALL {
            assert_eq!(Condition::from_name(c.name()), Some(c));
        }
    }
}
