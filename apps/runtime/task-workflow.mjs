import { randomUUID } from 'node:crypto';
import { ensureInside } from './adapters.mjs';

/**
 * Durable, human-driven SDLC task state machine.
 *
 * This is intentionally not an autonomous GitHub writer. No transition here
 * runs git/gh, and "ready_for_pr" is NOT evidence of a created PR.
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
  pr_open: ['ci', 'interrupted', 'failed'],
  ci: ['awaiting_merge', 'implementing', 'interrupted', 'failed'],
  awaiting_merge: ['complete', 'implementing', 'cancelled'],
  interrupted: ['planning', 'implementing', 'cancelled'],
  failed: ['planning', 'cancelled'],
  cancelled: [],
  complete: [],
});
const HUMAN_GATES = new Set(['preparing', 'pr_open', 'complete']);
const EVIDENCE_REQUIRED = Object.freeze({
  reviewing: 'local_tests',
  ready_for_pr: 'independent_review',
  awaiting_merge: 'ci_checks',
});
const EVIDENCE_KINDS = new Set(['local_tests', 'independent_review', 'ci_checks', 'plan', 'pull_request']);
const MAX_NOTE = 4000;
function nonEmpty(value, limit, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    throw new Error(`invalid ${name}`);
  return value.trim();
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
        FOREIGN KEY(task_id) REFERENCES coding_tasks(id)
      );
      CREATE INDEX IF NOT EXISTS task_evidence_idx ON task_evidence(task_id,kind,created_at);
      CREATE INDEX IF NOT EXISTS task_transitions_idx ON task_transitions(task_id,seq);
    `);
  }
  list() {
    return this.db.prepare('SELECT * FROM coding_tasks ORDER BY created_at DESC LIMIT 100').all().map(parse);
  }
  get(id) {
    return parse(this.db.prepare('SELECT * FROM coding_tasks WHERE id=?').get(id));
  }
  create({ workspace, objective, issueNumber = null, issueUrl = null }) {
    const cwd = ensureInside(nonEmpty(workspace, 1000, 'workspace'), this.roots);
    const goal = nonEmpty(objective, 5000, 'objective');
    if (issueNumber !== null && (!Number.isSafeInteger(issueNumber) || issueNumber <= 0))
      throw new Error('invalid issue number');
    if (issueUrl !== null) {
      if (typeof issueUrl !== 'string' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*$/.test(issueUrl))
        throw new Error('invalid GitHub issue URL');
      if (Number(issueUrl.split('/').at(-1)) !== issueNumber) throw new Error('issue number mismatch');
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO coding_tasks VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, cwd, goal, issueNumber, issueUrl, 'queued', 0, now, now);
      this.db.prepare('INSERT INTO task_transitions(task_id,previous_state,state,actor,reason,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, null, 'queued', 'human', 'created', now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.get(id);
  }
  evidence(id) {
    if (!this.get(id)) throw new Error('task not found');
    return this.db.prepare('SELECT * FROM task_evidence WHERE task_id=? ORDER BY created_at,id').all(id);
  }
  history(id) {
    if (!this.get(id)) throw new Error('task not found');
    return this.db.prepare('SELECT * FROM task_transitions WHERE task_id=? ORDER BY seq').all(id);
  }
  addEvidence(id, { kind, result, summary, reference = null }) {
    const task = this.get(id);
    if (!task) throw new Error('task not found');
    if (task.state === 'cancelled' || task.state === 'complete') throw new Error('task is terminal');
    if (!EVIDENCE_KINDS.has(kind)) throw new Error('invalid evidence kind');
    if (!['passed', 'failed', 'pending'].includes(result)) throw new Error('invalid evidence result');
    const note = nonEmpty(summary, MAX_NOTE, 'evidence summary');
    if (reference !== null && (typeof reference !== 'string' || reference.length > 1000))
      throw new Error('invalid evidence reference');
    const item = { id: randomUUID(), taskId: id, kind, result, summary: note, reference, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO task_evidence VALUES(?,?,?,?,?,?,?)')
      .run(item.id, id, kind, result, note, reference, item.createdAt);
    return item;
  }
  /**
   * Actor must be explicit and trusted by the caller; the local HTTP endpoint
   * always supplies actor='human' and never accepts caller-supplied actor.
   * Revision CAS makes accidental double-click / stale UI transitions fail.
   */
  advance(id, { to, expectedRevision, reason, humanConfirmed = false }, actor = 'human') {
    const task = this.get(id);
    if (!task) throw new Error('task not found');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('invalid revision');
    if (task.revision !== expectedRevision) throw new Error('stale task revision');
    if (!Object.hasOwn(TRANSITIONS, to) || !TRANSITIONS[task.state].includes(to))
      throw new Error('illegal task transition');
    if (actor !== 'human' && actor !== 'system') throw new Error('invalid actor');
    if (HUMAN_GATES.has(to) && (actor !== 'human' || humanConfirmed !== true))
      throw new Error('human confirmation required');
    if (to === 'complete') throw new Error('merge must be verified outside the preview runtime');
    const note = nonEmpty(reason, MAX_NOTE, 'transition reason');
    const required = EVIDENCE_REQUIRED[to];
    if (required) {
      const last = this.db.prepare('SELECT result FROM task_evidence WHERE task_id=? AND kind=? ORDER BY created_at DESC,rowid DESC LIMIT 1')
        .get(id, required);
      if (!last || last.result !== 'passed') throw new Error(`passing ${required} evidence required`);
    }
    // A PR link must be recorded before the user can assert it was opened.
    if (to === 'pr_open') {
      const last = this.db.prepare("SELECT result,reference FROM task_evidence WHERE task_id=? AND kind='pull_request' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(id);
      if (!last || last.result !== 'passed' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(last.reference || ''))
        throw new Error('verified pull request URL evidence required');
    }
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('UPDATE coding_tasks SET state=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND state=?')
        .run(to, now, id, expectedRevision, task.state);
      if (result.changes !== 1) throw new Error('stale task revision');
      this.db.prepare('INSERT INTO task_transitions(task_id,previous_state,state,actor,reason,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, task.state, to, actor, note, now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.get(id);
  }
}
