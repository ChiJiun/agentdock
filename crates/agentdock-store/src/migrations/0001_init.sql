-- AgentDock store schema v1 (P2-4). Runs inside the migration transaction; user_version is set
-- by migrate.rs. Event rows follow ADR-0003 section 4 / docs/contracts/events.md "Envelope".

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE events (
  authority_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1 AND seq <= 9007199254740991),
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  project_id TEXT,
  task_id TEXT,
  session_id TEXT,
  actor_kind TEXT NOT NULL,
  provenance TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  PRIMARY KEY (authority_id, seq)
) STRICT, WITHOUT ROWID;

CREATE INDEX events_task ON events(task_id, seq);
CREATE INDEX events_session ON events(session_id, seq);

-- Append-only: no UPDATE/DELETE except future tombstoning (not in this schema version).
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

-- Backstop for the cursor contract (events.md "Cursor"): every row is head + 1 of its authority,
-- also for rows written through Tx::sql() instead of Tx::append.
CREATE TRIGGER events_seq_gap_free BEFORE INSERT ON events
WHEN NEW.seq <> (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE authority_id = NEW.authority_id)
BEGIN
  SELECT RAISE(ABORT, 'events.seq must be head + 1 of its authority (gap-free)');
END;

-- Projection tables: created empty here, filled by the P2-5 projector inside the append
-- transaction. Columns follow the schema definitions Project, Task, Session, Approval,
-- Operation and Check; nested objects are stored as JSON text (*_json).

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  local_path TEXT NOT NULL,
  remote_origin TEXT,
  environment_id TEXT NOT NULL,
  default_branch TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  state TEXT NOT NULL,
  issue_url TEXT,
  branch TEXT,
  worktree_path TEXT,
  primary_session_id TEXT,
  resume_phase TEXT,
  interruption_json TEXT,
  failure_json TEXT,
  auto_resume_policy_json TEXT NOT NULL,
  outcome_acknowledged_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seq INTEGER NOT NULL
) STRICT;

CREATE INDEX tasks_project ON tasks(project_id);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  parent_session_id TEXT,
  role TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  state TEXT NOT NULL,
  external_session_id TEXT,
  launch_method TEXT NOT NULL,
  supersedes_session_id TEXT,
  handoff_summary_id TEXT,
  capability_snapshot_json TEXT,
  outcome TEXT,
  result_acknowledged_at TEXT,
  result_opened_at TEXT,
  archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
  archived_by TEXT CHECK (archived_by IN ('user', 'auto')),
  restored_by_user INTEGER CHECK (restored_by_user IN (0, 1)),
  created_at TEXT NOT NULL,
  closed_at TEXT
) STRICT;

CREATE INDEX sessions_task ON sessions(task_id);

CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  session_id TEXT,
  source TEXT NOT NULL,
  state TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  classified_kind TEXT,
  operation_fingerprint TEXT NOT NULL,
  operation_id TEXT,
  title TEXT NOT NULL,
  scope TEXT NOT NULL,
  return_state TEXT,
  acp_json TEXT,
  selected_option_id TEXT,
  requested_at TEXT NOT NULL,
  expires_at TEXT,
  decided_at TEXT,
  decided_by_json TEXT
) STRICT;

CREATE INDEX approvals_task ON approvals(task_id);

CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  repeatability TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  target_json TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  reconcile_strategy TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'recorded', 'started', 'succeeded', 'failed', 'outcome_unknown',
    'reconciled_applied', 'reconciled_not_applied', 'reconciled_undeterminable', 'abandoned'
  )),
  attempt_count INTEGER NOT NULL CHECK (attempt_count IN (0, 1)),
  supersedes_operation_id TEXT
) STRICT;

CREATE INDEX operations_task ON operations(task_id);

-- ADR-0003 section 9: unique key enforced in the append transaction, including concurrent
-- writers. Only a backstop for states where a second attempt is never allowed; the full Rule 5
-- check (outcome_unknown, legal supersede) is the P2-5 projector's job.
CREATE UNIQUE INDEX operations_live_key ON operations(idempotency_key)
  WHERE state IN ('recorded', 'started', 'succeeded', 'reconciled_applied');

CREATE TABLE checks (
  check_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  session_id TEXT,
  name TEXT NOT NULL,
  origin TEXT NOT NULL,
  state TEXT NOT NULL,
  command_json TEXT,
  cwd TEXT,
  exit_code INTEGER,
  artifact_json TEXT,
  external_url TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;

CREATE INDEX checks_task ON checks(task_id);
