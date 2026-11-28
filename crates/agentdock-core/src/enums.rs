//! Contract enums (ADR-0003, `docs/contracts/schema/agentdock.schema.json` `$defs`).
//!
//! Variants are transcribed one-to-one from the schema; the `enums_match_schema` test reads the
//! schema file and compares the string set of every enum, so a typo or omission fails the build.
//! Enums used only inside event payloads (`HintSource`, `UsageSource`, ...) arrive with the typed
//! payloads in P2-2.

use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Defines a unit-variant contract enum serialized as `snake_case` strings, plus `ALL`.
macro_rules! contract_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name { $($variant),+ }

        impl $name {
            /// Every variant, in schema order.
            pub const ALL: &'static [$name] = &[$($name::$variant),+];
        }
    };
}

contract_enum!(TaskState {
    Queued,
    Preparing,
    Running,
    AwaitingApproval,
    Verifying,
    Review,
    Pr,
    Ci,
    Completed,
    Interrupted,
    Failed,
    Cancelled,
});
contract_enum!(SessionState {
    Starting,
    Idle,
    Active,
    AwaitingPermission,
    Suspended,
    Disconnected,
    Closed,
    Failed
});
contract_enum!(ActorKind {
    User,
    Orchestrator,
    Policy,
    Adapter,
    Integration,
    Recovery
});
contract_enum!(Provenance {
    Live,
    AcpReplay,
    Recovery
});
contract_enum!(
    /// Ordered by workflow position: running < verifying < review < pr < ci.
    #[derive(PartialOrd, Ord)]
    ResumePhase { Running, Verifying, Review, Pr, Ci }
);
contract_enum!(ApprovalReturnState { Running, Pr, Ci });
contract_enum!(TaskTrigger {
    TaskCreated,
    Scheduled,
    UserCancel,
    SessionReady,
    ResumePhaseRestored,
    Interruption,
    PreparationFailed,
    ApprovalRequested,
    ImplementationDone,
    UnrecoverableError,
    ApprovalResolved,
    ChecksFailed,
    ChecksPassed,
    RepairLimitReached,
    ReviewBlockingFindings,
    ReviewPassed,
    AcceptedWithoutPr,
    PrPublished,
    OperationFailed,
    CiFailed,
    CiPassedAccepted,
    ResumeRequested,
    ScheduledResume,
    Abandoned,
    RetryRequested,
});
contract_enum!(SessionTrigger {
    Launch,
    SessionReady,
    LaunchFailed,
    AttachRejected,
    ProcessExited,
    PromptSubmitted,
    SessionClosed,
    TaskInterrupted,
    TurnEnded,
    PermissionRequested,
    PermissionResolved,
    ProtocolError,
    ContinuePrompt,
    Superseded,
    ReattachAttempt,
    Abandoned,
    HostRecovery,
});
contract_enum!(InterruptionReason {
    QuotaExhausted,
    RateLimited,
    AdapterDisconnected,
    ProcessCrashed,
    HostCrashed,
    AuthRequired,
    UserPaused,
    RemoteUnreachable,
    IntegrationUnavailable,
    SessionUnavailable,
});
contract_enum!(SessionRole {
    Primary,
    Implementation,
    Review,
    Repair,
    Explore,
    Subtask
});
contract_enum!(SessionOutcome {
    Succeeded,
    Failed,
    Cancelled,
    Superseded,
    Abandoned
});
contract_enum!(LaunchMethod { New, Load, Resume });
contract_enum!(ApprovalState {
    Pending,
    Approved,
    Denied,
    Expired,
    Cancelled,
    Invalidated
});
contract_enum!(ApprovalSource {
    AcpPermission,
    HostPolicy
});
contract_enum!(ApprovalScope {
    Once,
    Session,
    Task
});
contract_enum!(PolicyClass {
    ReadOnly,
    WorkspaceEdit,
    Command,
    ConfigWrite,
    GitPush,
    PrWrite,
    ExternalWrite,
    PrMerge,
    ForcePush,
    BranchDelete,
    WorktreeRemove,
    DestructiveCommand,
    Unclassified,
});
contract_enum!(OperationKind {
    GitPush,
    PrCreate,
    PrUpdate,
    PrComment,
    PrMerge,
    BranchDelete,
    WorktreeRemove,
    DestructiveCommand,
    ExternalWrite,
});
contract_enum!(OperationState {
    Recorded,
    Started,
    Succeeded,
    Failed,
    OutcomeUnknown,
    ReconciledApplied,
    ReconciledNotApplied,
    ReconciledUndeterminable,
    Abandoned,
});
contract_enum!(Repeatability {
    IdempotentWithKey,
    NonRepeatable
});
contract_enum!(ReconcileStrategy {
    RemoteRefCompare,
    PrLookupByHead,
    PrStateLookup,
    BranchExistsLookup,
    PathExistsLookup,
    None
});
contract_enum!(CheckState {
    Running,
    Passed,
    Failed,
    Errored,
    Cancelled,
    OutcomeUnknown
});
contract_enum!(CheckOrigin { Local, Ci });

/// Adds `as_str`, the wire name (identical to the serde name; a unit test checks that).
macro_rules! wire_names {
    ($($name:ident { $($variant:ident => $wire:literal),+ $(,)? })+) => {$(
        impl $name {
            /// The `snake_case` wire name used in the contracts.
            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $wire),+ }
            }
        }
    )+};
}

wire_names! {
    TaskState {
        Queued => "queued",
        Preparing => "preparing",
        Running => "running",
        AwaitingApproval => "awaiting_approval",
        Verifying => "verifying",
        Review => "review",
        Pr => "pr",
        Ci => "ci",
        Completed => "completed",
        Interrupted => "interrupted",
        Failed => "failed",
        Cancelled => "cancelled",
    }
    SessionState {
        Starting => "starting",
        Idle => "idle",
        Active => "active",
        AwaitingPermission => "awaiting_permission",
        Suspended => "suspended",
        Disconnected => "disconnected",
        Closed => "closed",
        Failed => "failed",
    }
    ActorKind {
        User => "user",
        Orchestrator => "orchestrator",
        Policy => "policy",
        Adapter => "adapter",
        Integration => "integration",
        Recovery => "recovery",
    }
    TaskTrigger {
        TaskCreated => "task_created",
        Scheduled => "scheduled",
        UserCancel => "user_cancel",
        SessionReady => "session_ready",
        ResumePhaseRestored => "resume_phase_restored",
        Interruption => "interruption",
        PreparationFailed => "preparation_failed",
        ApprovalRequested => "approval_requested",
        ImplementationDone => "implementation_done",
        UnrecoverableError => "unrecoverable_error",
        ApprovalResolved => "approval_resolved",
        ChecksFailed => "checks_failed",
        ChecksPassed => "checks_passed",
        RepairLimitReached => "repair_limit_reached",
        ReviewBlockingFindings => "review_blocking_findings",
        ReviewPassed => "review_passed",
        AcceptedWithoutPr => "accepted_without_pr",
        PrPublished => "pr_published",
        OperationFailed => "operation_failed",
        CiFailed => "ci_failed",
        CiPassedAccepted => "ci_passed_accepted",
        ResumeRequested => "resume_requested",
        ScheduledResume => "scheduled_resume",
        Abandoned => "abandoned",
        RetryRequested => "retry_requested",
    }
    SessionTrigger {
        Launch => "launch",
        SessionReady => "session_ready",
        LaunchFailed => "launch_failed",
        AttachRejected => "attach_rejected",
        ProcessExited => "process_exited",
        PromptSubmitted => "prompt_submitted",
        SessionClosed => "session_closed",
        TaskInterrupted => "task_interrupted",
        TurnEnded => "turn_ended",
        PermissionRequested => "permission_requested",
        PermissionResolved => "permission_resolved",
        ProtocolError => "protocol_error",
        ContinuePrompt => "continue_prompt",
        Superseded => "superseded",
        ReattachAttempt => "reattach_attempt",
        Abandoned => "abandoned",
        HostRecovery => "host_recovery",
    }
    ResumePhase {
        Running => "running",
        Verifying => "verifying",
        Review => "review",
        Pr => "pr",
        Ci => "ci",
    }
    ApprovalReturnState {
        Running => "running",
        Pr => "pr",
        Ci => "ci",
    }
    LaunchMethod {
        New => "new",
        Load => "load",
        Resume => "resume",
    }
}

impl TaskState {
    /// Terminal in the state-machine sense (ADR-0003 section 2): nothing leaves these states.
    /// `Failed` and `Interrupted` can still be retried or resumed, so they are not terminal.
    pub fn is_terminal(self) -> bool {
        matches!(self, TaskState::Completed | TaskState::Cancelled)
    }

    /// The task is being worked on: `preparing` through `ci`.
    pub fn is_in_flight(self) -> bool {
        matches!(
            self,
            TaskState::Preparing
                | TaskState::Running
                | TaskState::AwaitingApproval
                | TaskState::Verifying
                | TaskState::Review
                | TaskState::Pr
                | TaskState::Ci
        )
    }
}

impl SessionState {
    /// The agent process/session still exists (possibly suspended).
    pub fn is_live(self) -> bool {
        matches!(
            self,
            SessionState::Starting
                | SessionState::Idle
                | SessionState::Active
                | SessionState::AwaitingPermission
                | SessionState::Suspended
        )
    }
}

macro_rules! known_event_types {
    ($($variant:ident => $name:literal),+ $(,)?) => {
        /// An event type this build knows (`schema_version` 1).
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum KnownEventType { $($variant),+ }

        impl KnownEventType {
            /// Every known type, in schema order.
            pub const ALL: [KnownEventType; known_event_types!(@count $($variant)+)] =
                [$(KnownEventType::$variant),+];

            /// The dotted wire name, for example `task.state_changed`.
            pub fn as_str(self) -> &'static str {
                match self { $(KnownEventType::$variant => $name),+ }
            }

            /// The known type with this wire name, if any.
            #[allow(clippy::should_implement_trait)]
            pub fn from_str(s: &str) -> Option<Self> {
                match s { $($name => Some(KnownEventType::$variant),)+ _ => None }
            }
        }
    };
    (@count) => { 0usize };
    (@count $head:ident $($tail:ident)*) => { 1usize + known_event_types!(@count $($tail)*) };
}

known_event_types! {
    TaskCreated => "task.created",
    TaskStateChanged => "task.state_changed",
    TaskCheckpointRecorded => "task.checkpoint_recorded",
    TaskOutcomeAcknowledged => "task.outcome_acknowledged",
    TaskPolicyUpdated => "task.policy_updated",
    TaskDeleted => "task.deleted",
    SessionCreated => "session.created",
    SessionCapabilitiesDetected => "session.capabilities_detected",
    SessionStateChanged => "session.state_changed",
    SessionPromptSubmitted => "session.prompt_submitted",
    SessionMessageDelta => "session.message_delta",
    SessionToolCall => "session.tool_call",
    SessionPlanUpdated => "session.plan_updated",
    SessionSummaryRecorded => "session.summary_recorded",
    SessionOutputLimited => "session.output_limited",
    SessionResultAcknowledged => "session.result_acknowledged",
    SessionArchived => "session.archived",
    SessionUnarchived => "session.unarchived",
    ApprovalRequested => "approval.requested",
    ApprovalResolved => "approval.resolved",
    OperationRecorded => "operation.recorded",
    OperationStarted => "operation.started",
    OperationSucceeded => "operation.succeeded",
    OperationFailed => "operation.failed",
    OperationOutcomeUnknown => "operation.outcome_unknown",
    OperationReconciled => "operation.reconciled",
    OperationAbandoned => "operation.abandoned",
    CheckStarted => "check.started",
    CheckFinished => "check.finished",
    UsageReported => "usage.reported",
    SystemRecoveryStarted => "system.recovery_started",
    SystemRecoveryCompleted => "system.recovery_completed",
}

/// Event type as stored. Unknown names are preserved and never rejected on read, so a newer
/// writer's event does not fail a whole read (contracts README "Compatibility and versioning").
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum EventType {
    Known(KnownEventType),
    Unknown(String),
}

impl EventType {
    /// Known name becomes `Known`, anything else is kept verbatim as `Unknown`.
    pub fn from_name(s: &str) -> Self {
        match KnownEventType::from_str(s) {
            Some(known) => EventType::Known(known),
            None => EventType::Unknown(s.to_owned()),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            EventType::Known(known) => known.as_str(),
            EventType::Unknown(name) => name,
        }
    }
}

impl fmt::Display for EventType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl From<KnownEventType> for EventType {
    fn from(known: KnownEventType) -> Self {
        EventType::Known(known)
    }
}

impl Serialize for EventType {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for EventType {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Ok(EventType::from_name(&s))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::de::DeserializeOwned;
    use std::collections::BTreeSet;
    use std::fs;
    use std::path::PathBuf;

    fn schema_enums() -> serde_json::Map<String, serde_json::Value> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/contracts/schema/agentdock.schema.json");
        let schema: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        schema["$defs"]
            .as_object()
            .unwrap()
            .iter()
            .filter(|(_, def)| def.get("enum").is_some())
            .map(|(name, def)| (name.clone(), def["enum"].clone()))
            .collect()
    }

    fn schema_set(
        enums: &serde_json::Map<String, serde_json::Value>,
        name: &str,
    ) -> BTreeSet<String> {
        enums[name]
            .as_array()
            .unwrap_or_else(|| panic!("schema has no enum {name}"))
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect()
    }

    /// Serialized strings of `all`; also checks that every variant round-trips and is unique.
    fn rust_set<T>(name: &str, all: &[T]) -> BTreeSet<String>
    where
        T: Serialize + DeserializeOwned + PartialEq + fmt::Debug,
    {
        let mut set = BTreeSet::new();
        for variant in all {
            let value = serde_json::to_value(variant).unwrap();
            let back: T = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(&back, variant, "{name} does not round-trip");
            assert!(
                set.insert(value.as_str().unwrap().to_owned()),
                "{name}: duplicate"
            );
        }
        set
    }

    #[test]
    fn enums_match_schema() {
        let schema = schema_enums();
        let mut checked = BTreeSet::new();
        macro_rules! check {
            ($($name:ident),+ $(,)?) => {$(
                assert_eq!(
                    rust_set(stringify!($name), $name::ALL),
                    schema_set(&schema, stringify!($name)),
                    "enum {} differs from schema",
                    stringify!($name)
                );
                checked.insert(stringify!($name).to_owned());
            )+};
        }
        check!(
            TaskState,
            SessionState,
            ActorKind,
            Provenance,
            ResumePhase,
            ApprovalReturnState,
            TaskTrigger,
            SessionTrigger,
            InterruptionReason,
            SessionRole,
            SessionOutcome,
            LaunchMethod,
            ApprovalState,
            ApprovalSource,
            ApprovalScope,
            PolicyClass,
            OperationKind,
            OperationState,
            Repeatability,
            ReconcileStrategy,
            CheckState,
            CheckOrigin,
        );

        // EventType: known names vs schema, and exactly 32 of them.
        let known: BTreeSet<String> = KnownEventType::ALL
            .iter()
            .map(|k| k.as_str().to_owned())
            .collect();
        assert_eq!(known, schema_set(&schema, "EventType"));
        assert_eq!(KnownEventType::ALL.len(), 32);
        checked.insert("EventType".to_owned());

        // Schema enums that belong to payloads are P2-2. They are listed so that a newly added
        // schema enum fails here until somebody decides where it goes.
        let deferred_to_p2_2: BTreeSet<String> = [
            "HintSource",
            "AcpStopReason",
            "AcpPermissionOptionKind",
            "UsageSource",
            "UsageReporter",
            "SummarySource",
            "SummaryPurpose",
            "AttentionKind",
            "AttentionReason",
            "AcknowledgementMethod",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
        let uncovered: BTreeSet<String> = schema
            .keys()
            .filter(|k| !checked.contains(*k))
            .cloned()
            .collect();
        assert_eq!(uncovered, deferred_to_p2_2);
    }

    #[test]
    fn known_event_type_names_roundtrip() {
        for known in KnownEventType::ALL {
            assert_eq!(KnownEventType::from_str(known.as_str()), Some(known));
            assert_eq!(
                EventType::from_name(known.as_str()),
                EventType::Known(known)
            );
        }
        assert_eq!(KnownEventType::from_str("task.nope"), None);
        assert_eq!(KnownEventType::from_str("Task.Created"), None);
        assert_eq!(KnownEventType::from_str("task.created "), None);
    }

    #[test]
    fn event_type_serde_keeps_unknown_names() {
        let t: EventType = serde_json::from_str("\"future.thing_happened\"").unwrap();
        assert_eq!(t, EventType::Unknown("future.thing_happened".to_owned()));
        assert_eq!(
            serde_json::to_string(&t).unwrap(),
            "\"future.thing_happened\""
        );
        let t: EventType = serde_json::from_str("\"task.state_changed\"").unwrap();
        assert_eq!(t, EventType::Known(KnownEventType::TaskStateChanged));
        assert_eq!(t.to_string(), "task.state_changed");
        assert!(serde_json::from_str::<EventType>("1").is_err());
    }

    #[test]
    fn task_state_predicates() {
        let terminal: Vec<_> = TaskState::ALL.iter().filter(|s| s.is_terminal()).collect();
        assert_eq!(terminal, [&TaskState::Completed, &TaskState::Cancelled]);
        let in_flight: Vec<_> = TaskState::ALL.iter().filter(|s| s.is_in_flight()).collect();
        assert_eq!(in_flight.len(), 7);
        assert!(!TaskState::Queued.is_in_flight());
        assert!(!TaskState::Interrupted.is_in_flight());
        assert!(!TaskState::Failed.is_in_flight());
        assert!(!TaskState::Failed.is_terminal());
        assert!(TaskState::AwaitingApproval.is_in_flight());
    }

    #[test]
    fn session_state_is_live() {
        let live: Vec<_> = SessionState::ALL.iter().filter(|s| s.is_live()).collect();
        assert_eq!(live.len(), 5);
        assert!(!SessionState::Disconnected.is_live());
        assert!(!SessionState::Closed.is_live());
        assert!(!SessionState::Failed.is_live());
    }

    #[test]
    fn resume_phase_is_ordered_by_workflow_position() {
        assert!(ResumePhase::Running < ResumePhase::Verifying);
        assert!(ResumePhase::Verifying < ResumePhase::Review);
        assert!(ResumePhase::Review < ResumePhase::Pr);
        assert!(ResumePhase::Pr < ResumePhase::Ci);
        let mut sorted = ResumePhase::ALL.to_vec();
        sorted.sort();
        assert_eq!(sorted, ResumePhase::ALL);
    }

    #[test]
    fn as_str_matches_serde_name() {
        fn check<T: Serialize + Copy>(all: &[T], name: impl Fn(T) -> &'static str) {
            for v in all {
                assert_eq!(serde_json::to_value(v).unwrap(), name(*v));
            }
        }
        check(TaskState::ALL, TaskState::as_str);
        check(SessionState::ALL, SessionState::as_str);
        check(ActorKind::ALL, ActorKind::as_str);
        check(TaskTrigger::ALL, TaskTrigger::as_str);
        check(SessionTrigger::ALL, SessionTrigger::as_str);
        check(ResumePhase::ALL, ResumePhase::as_str);
        check(ApprovalReturnState::ALL, ApprovalReturnState::as_str);
        check(LaunchMethod::ALL, LaunchMethod::as_str);
    }

    #[test]
    fn unknown_enum_values_are_rejected() {
        assert!(serde_json::from_str::<TaskState>("\"Queued\"").is_err());
        assert!(serde_json::from_str::<TaskState>("\"paused\"").is_err());
    }
}
