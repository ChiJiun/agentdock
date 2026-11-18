import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { ensureInside } from './adapters.mjs';

/**
 * Durable, human-driven SDLC task state machine.
 *
 * This is intentionally not an autonomous GitHub writer. No transition here
 * runs git/gh, and "ready_for_pr" is NOT evidence of a created PR.
 *
 * The state set is a preview and deliberately differs from the proposed
 * ADR-0003 contract; see docs/implementation/durable-task-workflow.md.
 */
const TRANSITIONS = Object.freeze({
  queued: ['planning', 'cancelled'],
  planning: ['awaiting_plan_approval', 'cancelled', 'failed'],
  awaiting_plan_approval: ['preparing', 'planning', 'cancelled'],
  preparing: ['implementing', 'interrupted', 'failed', 'cancelled'],
  implementing: ['verifying', 'interrupted', 'failed', 'cancelled'],
  verifying: ['reviewing', 'implementing', 'interrupted', 'failed', 'cancelled'],
  reviewing: ['ready_for_pr', 'implementing', 'interrupted', 'failed', 'cancelled'],
  ready_for_pr: ['awaiting_pr_approval', 'implementing', 'cancelled'],
  awaiting_pr_approval: ['pr_open', 'ready_for_pr', 'cancelled'],
  pr_open: ['ci', 'interrupted', 'failed', 'cancelled'],
  ci: ['awaiting_merge', 'implementing', 'interrupted', 'failed', 'cancelled'],
  awaiting_merge: ['complete', 'implementing', 'cancelled'],
  interrupted: ['planning', 'implementing', 'cancelled'],
  failed: ['planning', 'cancelled'],
  cancelled: [],
  complete: [],
});
const TERMINAL = new Set(['cancelled', 'complete']);
const HUMAN_GATES = new Set(['preparing', 'pr_open', 'complete']);

/**
 * Evidence chain. Every link must be the LATEST record of its kind, must have
 * result 'passed', must have been recorded after the task last entered `since`
 * (so a previous round's evidence never satisfies a later round), and must name
 * the same commit as the previous link: tested commit == reviewed commit ==
 * PR head == commit CI ran on.
 */
const CHAIN = Object.freeze([
  { kind: 'local_tests', since: 'verifying' },
  { kind: 'independent_review', since: 'reviewing' },
  { kind: 'pull_request', since: 'reviewing' },
  { kind: 'ci_checks', since: 'ci' },
]);
/** Number of chain links that must hold before a task may enter the state. */
const CHAIN_DEPTH = Object.freeze({ reviewing: 1, ready_for_pr: 2, pr_open: 3, awaiting_merge: 4 });
const COMMIT_KINDS = new Set(CHAIN.map(link => link.kind));
const EVIDENCE_KINDS = new Set([...COMMIT_KINDS, 'plan']);
const EVIDENCE_RESULTS = new Set(['passed', 'failed', 'pending']);
const MAX_NOTE = 4000;
const PAGE = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const ISSUE_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*$/;
const PULL_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/;

/** A rejected request. `status` is the HTTP status the dev API reports. */
export class TaskError extends Error {
  constructor(status, message) { super(message); this.name = 'TaskError'; this.status = status; }
}
const invalid = message => new TaskError(400, message);
const conflict = message => new TaskError(409, message);

function body(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('invalid request body');
  return value;
}
function nonEmpty(value, limit, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw invalid(`invalid ${name}`);
  return value.trim();
}
function optionalId(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid(`invalid ${name}`);
  return value;
}
function cursor(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid('invalid cursor');
  return value;
}
function parse(row) {
  if (!row) return null;
  return { ...row, issue_number: row.issue_number == null ? null : Number(row.issue_number) };
}

export class TaskWorkflow {
  constructor({ store, roots }) {
    this.db = store.db;
    this.roots = roots;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS coding_tasks (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        objective TEXT NOT NULL,
        issue_number INTEGER,
        issue_url TEXT,
        state TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_evidence (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        result TEXT NOT NULL,
        summary TEXT NOT NULL,
        reference TEXT,
        created_at TEXT NOT NULL,
        commit_sha TEXT,
        transition_seq INTEGER,
        FOREIGN KEY(task_id) REFERENCES coding_tasks(id)
      );
      CREATE TABLE IF NOT EXISTS task_transitions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        previous_state TEXT,
        state TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revision INTEGER,
        FOREIGN KEY(task_id) REFERENCES coding_tasks(id)
      );
    `);
    // Databases written by the first preview commit lack these columns. Their
    // old evidence rows keep transition_seq NULL and therefore never satisfy a gate.
    this.#addColumn('task_evidence', 'commit_sha', 'TEXT');
    this.#addColumn('task_evidence', 'transition_seq', 'INTEGER');
    this.#addColumn('task_transitions', 'revision', 'INTEGER');
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS task_evidence_idx ON task_evidence(task_id,kind,created_at);
      CREATE INDEX IF NOT EXISTS task_transitions_idx ON task_transitions(task_id,seq);
      CREATE TRIGGER IF NOT EXISTS task_evidence_no_update BEFORE UPDATE ON task_evidence
        BEGIN SELECT RAISE(ABORT, 'task_evidence is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS task_evidence_no_delete BEFORE DELETE ON task_evidence
        BEGIN SELECT RAISE(ABORT, 'task_evidence is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS task_transitions_no_update BEFORE UPDATE ON task_transitions
        BEGIN SELECT RAISE(ABORT, 'task_transitions is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS task_transitions_no_delete BEFORE DELETE ON task_transitions
        BEGIN SELECT RAISE(ABORT, 'task_transitions is append-only'); END;
      -- INSERT OR REPLACE deletes the old row without firing DELETE triggers
      -- (recursive_triggers is off by default), so refuse a reused key up front.
      CREATE TRIGGER IF NOT EXISTS task_evidence_no_replace BEFORE INSERT ON task_evidence
        WHEN EXISTS (SELECT 1 FROM task_evidence WHERE id = NEW.id)
        BEGIN SELECT RAISE(ABORT, 'task_evidence is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS task_transitions_no_replace BEFORE INSERT ON task_transitions
        WHEN NEW.seq IS NOT NULL AND EXISTS (SELECT 1 FROM task_transitions WHERE seq = NEW.seq)
        BEGIN SELECT RAISE(ABORT, 'task_transitions is append-only'); END;
    `);
  }
  #addColumn(table, column, type) {
    const present = this.db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
    if (present) return;
    try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`); }
    catch (error) {
      // Another runtime process on the same file may have added it in between.
      if (!/duplicate column/i.test(error.message)) throw error;
    }
  }
  /**
   * Every read that decides a write happens inside the same write transaction,
   * so a second runtime process on the same database cannot slip a record in
   * between a gate check and the state change.
   */
  #transaction(work) {
    try { this.db.exec('BEGIN IMMEDIATE'); }
    catch (error) {
      // Another connection holds the write lock past busy_timeout: retryable, not a server bug.
      if (/database is locked|SQLITE_BUSY/i.test(error.message)) throw new TaskError(503, 'database busy, retry');
      throw error;
    }
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* keep the original error */ }
      throw error;
    }
  }
  #require(id) {
    const task = this.get(id);
    if (!task) throw new TaskError(404, 'task not found');
    return task;
  }
  #workspace(value) {
    const candidate = nonEmpty(value, 1000, 'workspace');
    let cwd;
    try { cwd = ensureInside(candidate, this.roots); }
    catch (error) {
      throw invalid(/^workspace /.test(error.message) ? error.message : 'workspace path does not exist');
    }
    // Canonical on-disk spelling (drive letter and folder case on Windows), so the
    // same folder always compares equal when a request is replayed.
    cwd = realpathSync.native(cwd);
    if (!statSync(cwd).isDirectory()) throw invalid('workspace path is not a directory');
    return cwd;
  }
  list() {
    return this.db.prepare('SELECT * FROM coding_tasks ORDER BY created_at DESC, rowid DESC LIMIT 100').all().map(parse);
  }
  get(id) {
    return parse(this.db.prepare('SELECT * FROM coding_tasks WHERE id=?').get(id));
  }
  /**
   * `id` is an optional caller-chosen UUID. Repeating a create with the same id
   * and the same content returns the existing task instead of a duplicate.
   */
  create(input) {
    const { id: requestedId, workspace, objective, issueNumber = null, issueUrl = null } = body(input);
    const id = optionalId(requestedId, 'task id') ?? randomUUID();
    const cwd = this.#workspace(workspace);
    const goal = nonEmpty(objective, 5000, 'objective');
    if (issueNumber !== null && (!Number.isSafeInteger(issueNumber) || issueNumber <= 0))
      throw invalid('invalid issue number');
    if (issueUrl !== null) {
      if (typeof issueUrl !== 'string' || issueUrl.length > 300 || !ISSUE_URL.test(issueUrl))
        throw invalid('invalid GitHub issue URL');
      if (Number(issueUrl.split('/').at(-1)) !== issueNumber) throw invalid('issue number mismatch');
    }
    return this.#transaction(() => {
      const existing = this.get(id);
      if (existing) {
        const same = existing.workspace === cwd && existing.objective === goal
          && existing.issue_number === issueNumber && existing.issue_url === issueUrl;
        if (!same) throw conflict('task id already used');
        return existing;
      }
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO coding_tasks(id,workspace,objective,issue_number,issue_url,state,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, cwd, goal, issueNumber, issueUrl, 'queued', 0, now, now);
      this.db.prepare('INSERT INTO task_transitions(task_id,previous_state,state,actor,reason,created_at,revision) VALUES(?,?,?,?,?,?,?)')
        .run(id, null, 'queued', 'human', 'created', now, 0);
      return this.get(id);
    });
  }
  /** Oldest first; pass the last `seq` seen as `after` to read the next page. */
  evidence(id, after = 0) {
    this.#require(id);
    return this.db.prepare('SELECT rowid AS seq,* FROM task_evidence WHERE task_id=? AND rowid>? ORDER BY rowid LIMIT ?')
      .all(id, cursor(after), PAGE);
  }
  history(id, after = 0) {
    this.#require(id);
    return this.db.prepare('SELECT * FROM task_transitions WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(id, cursor(after), PAGE);
  }
  /**
   * Evidence is an operator-submitted record; nothing here runs tests or asks
   * GitHub. `id` is an optional caller-chosen UUID that makes a retried request
   * return the existing record instead of appending a duplicate.
   */
  addEvidence(id, input) {
    const { id: requestedId, kind, result, summary, reference = null, commitSha = null } = body(input);
    const evidenceId = optionalId(requestedId, 'evidence id') ?? randomUUID();
    if (!EVIDENCE_KINDS.has(kind)) throw invalid('invalid evidence kind');
    if (!EVIDENCE_RESULTS.has(result)) throw invalid('invalid evidence result');
    const note = nonEmpty(summary, MAX_NOTE, 'evidence summary');
    if (reference !== null && (typeof reference !== 'string' || reference.length > 1000))
      throw invalid('invalid evidence reference');
    if (COMMIT_KINDS.has(kind)) {
      if (typeof commitSha !== 'string' || !COMMIT_SHA.test(commitSha))
        throw invalid(`invalid commit SHA: ${kind} evidence needs the full 40-character commit`);
    } else if (commitSha !== null) throw invalid('invalid commit SHA: not accepted for this evidence kind');
    if (kind === 'pull_request' && !PULL_URL.test(reference ?? ''))
      throw invalid('invalid evidence reference: pull_request evidence needs a GitHub pull request URL');
    const read = this.db.prepare('SELECT rowid AS seq,* FROM task_evidence WHERE id=?');
    return this.#transaction(() => {
      const task = this.#require(id);
      const existing = read.get(evidenceId);
      if (existing) {
        const same = existing.task_id === id && existing.kind === kind && existing.result === result
          && existing.summary === note && existing.reference === reference && existing.commit_sha === commitSha;
        if (!same) throw conflict('evidence id already used');
        return existing;
      }
      if (TERMINAL.has(task.state)) throw conflict('task is terminal');
      if (kind === 'pull_request' && task.issue_url
        && reference.split('/').slice(3, 5).join('/').toLowerCase() !== task.issue_url.split('/').slice(3, 5).join('/').toLowerCase())
        throw invalid('invalid evidence reference: pull request is not in the repository of the task issue');
      const { seq } = this.db.prepare('SELECT MAX(seq) AS seq FROM task_transitions WHERE task_id=?').get(id);
      this.db.prepare('INSERT INTO task_evidence(id,task_id,kind,result,summary,reference,created_at,commit_sha,transition_seq) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(evidenceId, id, kind, result, note, reference, new Date().toISOString(), commitSha, seq);
      return read.get(evidenceId);
    });
  }
  /** Latest record of `kind`, only if it passed after the task last entered `since`. */
  #current(id, kind, since) {
    const entered = this.db.prepare('SELECT MAX(seq) AS seq FROM task_transitions WHERE task_id=? AND state=?').get(id, since).seq;
    const last = this.db.prepare('SELECT * FROM task_evidence WHERE task_id=? AND kind=? ORDER BY rowid DESC LIMIT 1').get(id, kind);
    const ok = entered != null && last && last.result === 'passed'
      && last.transition_seq != null && last.transition_seq >= entered;
    if (!ok) throw conflict(`passing ${kind} evidence required (latest record, from the current round)`);
    return last;
  }
  #checkGates(id, to) {
    if (to === 'preparing') this.#current(id, 'plan', 'planning');
    let previous = null;
    for (const link of CHAIN.slice(0, CHAIN_DEPTH[to] ?? 0)) {
      const item = this.#current(id, link.kind, link.since);
      if (previous && item.commit_sha !== previous.commit_sha)
        throw conflict(`${link.kind} evidence must name the same commit as ${previous.kind} evidence`);
      previous = item;
    }
  }
  /**
   * Actor must be explicit and trusted by the caller; the local HTTP endpoint
   * always supplies actor='human' and never accepts caller-supplied actor.
   * Revision CAS makes accidental double-click / stale UI / retried requests fail
   * instead of applying twice.
   */
  advance(id, input, actor = 'human') {
    const { to, expectedRevision, reason, humanConfirmed = false } = body(input);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw invalid('invalid revision');
    if (typeof to !== 'string' || !Object.hasOwn(TRANSITIONS, to)) throw invalid('invalid target state');
    if (actor !== 'human' && actor !== 'system') throw invalid('invalid actor');
    const note = nonEmpty(reason, MAX_NOTE, 'transition reason');
    return this.#transaction(() => {
      const task = this.#require(id);
      if (task.revision !== expectedRevision) throw conflict('stale task revision');
      if (!TRANSITIONS[task.state]?.includes(to)) throw conflict('illegal task transition');
      if (HUMAN_GATES.has(to) && (actor !== 'human' || humanConfirmed !== true))
        throw new TaskError(403, 'human confirmation required');
      if (to === 'complete') throw conflict('merge must be verified outside the preview runtime');
      this.#checkGates(id, to);
      const now = new Date().toISOString();
      const result = this.db.prepare('UPDATE coding_tasks SET state=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND state=?')
        .run(to, now, id, expectedRevision, task.state);
      if (result.changes !== 1) throw conflict('stale task revision');
      this.db.prepare('INSERT INTO task_transitions(task_id,previous_state,state,actor,reason,created_at,revision) VALUES(?,?,?,?,?,?,?)')
        .run(id, task.state, to, actor, note, now, expectedRevision + 1);
      return this.get(id);
    });
  }
}
