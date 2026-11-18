import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// A full 12,000-character prompt must survive in history unshortened.
const MAX_STRING = 16_000;
const MAX_PAYLOAD = 48_000;
const LIVE = "('starting','ready','running','awaiting_approval')";

function protect(value) {
  // Always persist valid JSON. Large tool replies must not break event replay.
  // Redaction is defense-in-depth; do not supply credentials as prompt content.
  const sensitiveKey = /(?:password|secret|authorization|credential|api[_-]?key|access[_-]?token|private[_-]?key)/i;
  const redactText = s => s
    .replace(/(sk-(?:proj-)?)[A-Za-z0-9_-]{12,}/g, '$1[REDACTED]')
    .replace(/gh[opusr]_[A-Za-z0-9_]{16,}/g, '[REDACTED-GH-TOKEN]');
  function scrub(input, depth = 0) {
    if (depth > 8) return '[nested content truncated]';
    // Truncation is always visible in the stored text, never silent.
    if (typeof input === 'string') return redactText(input.length > MAX_STRING
      ? `${input.slice(0, MAX_STRING)}…[truncated ${input.length - MAX_STRING} chars]` : input);
    if (input === null || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.slice(0, 100).map(item => scrub(item, depth + 1));
    return Object.fromEntries(Object.entries(input).slice(0, 100).map(([key, item]) =>
      [key, sensitiveKey.test(key) ? '[REDACTED]' : scrub(item, depth + 1)]));
  }
  const output = JSON.stringify(scrub(value ?? {}));
  return output.length <= MAX_PAYLOAD
    ? output : JSON.stringify({ truncated: true, excerpt: output.slice(0, MAX_PAYLOAD / 2) });
}

/** A durable, append-only history with explicit restart interruption semantics. */
export class SessionStore {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, adapter TEXT NOT NULL, cwd TEXT NOT NULL,
        agent_session TEXT, status TEXT NOT NULL, supports_load INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS events_session_seq ON events(session_id,seq);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
        title TEXT NOT NULL, choices TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        selected_option TEXT, detail TEXT
      );
      CREATE TABLE IF NOT EXISTS attention_views (
        session_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL,
        status TEXT NOT NULL, viewed_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );
    `);
    // Databases written by an earlier revision of this branch lack the column.
    if (!this.db.prepare('PRAGMA table_info(approvals)').all().some(c => c.name === 'detail'))
      this.db.exec('ALTER TABLE approvals ADD COLUMN detail TEXT');
    this.depth = 0;
    this.recovered = this.recover();
  }
  /**
   * Run several writes as one transaction so a state change and its event
   * are stored together or not at all. Nested calls join the outer transaction.
   */
  atomic(fn) {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      throw error;
    } finally { this.depth = 0; }
  }
  /**
   * Nothing is reattached at process restart: every session that was live when
   * the previous host stopped becomes `interrupted`, with an event saying so,
   * and its unanswered approvals are cancelled so they can never be replayed.
   * The caller must own the database (see the host lock in server.mjs).
   */
  recover() {
    return this.atomic(() => {
      const now = new Date().toISOString();
      const lost = this.db.prepare(`SELECT id,status FROM sessions WHERE status IN ${LIVE}`).all();
      for (const session of lost) {
        this.db.prepare(`UPDATE sessions SET status='interrupted',updated_at=? WHERE id=?`).run(now, session.id);
        this.event(session.id, 'host_restarted', { previousStatus: session.status });
      }
      for (const approval of this.db.prepare(`SELECT id,session_id FROM approvals WHERE status='pending'`).all()) {
        this.db.prepare(`UPDATE approvals SET status='cancelled' WHERE id=?`).run(approval.id);
        this.event(approval.session_id, 'approval_resolved', { approvalId: approval.id, decision: 'cancelled', reason: 'host_restarted' });
      }
      return lost.length;
    });
  }
  create(session) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO sessions(id,adapter,cwd,status,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
      .run(session.id, session.adapter, session.cwd, 'starting', now, now);
    return this.get(session.id);
  }
  get(id) {
    return this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) ?? null;
  }
  list() {
    return this.db.prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT 200').all();
  }
  status(id, status, data = {}) {
    const { agentSessionId, supportsLoad } = data;
    const previous = this.get(id);
    if (!previous) throw new Error('session not found');
    this.db.prepare(`UPDATE sessions SET status=?,agent_session=COALESCE(?,agent_session),supports_load=COALESCE(?,supports_load),updated_at=? WHERE id=?`)
      .run(status, agentSessionId ?? null, supportsLoad == null ? null : Number(!!supportsLoad), new Date().toISOString(), id);
  }
  event(id, kind, payload = {}) {
    const now = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO events(session_id,kind,data,created_at) VALUES(?,?,?,?)')
      .run(id, kind, protect(payload), now);
    return { seq: Number(result.lastInsertRowid), sessionId: id, kind, data: JSON.parse(protect(payload)), createdAt: now };
  }
  events(id, after = 0) {
    const rows = this.db.prepare('SELECT * FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT 300').all(id, after);
    return rows.map(r => ({ seq: r.seq, sessionId: r.session_id, kind: r.kind, data: JSON.parse(r.data), createdAt: r.created_at }));
  }
  latestEvent(sessionId) {
    const row = this.db.prepare('SELECT seq,kind,data,created_at FROM events WHERE session_id=? ORDER BY seq DESC LIMIT 1').get(sessionId);
    if (!row) return null;
    // Only the stop reason and the restart's previous status are read back,
    // never prompt/tool/agent text.
    let stopReason = null;
    let previousStatus = null;
    try {
      const data = JSON.parse(row.data);
      if (row.kind === 'turn_finished' && typeof data?.stopReason === 'string') stopReason = data.stopReason.slice(0, 40);
      if (row.kind === 'host_restarted' && typeof data?.previousStatus === 'string') previousStatus = data.previousStatus.slice(0, 40);
    } catch { /* unreadable payload: no extra fields */ }
    // The session's own event before this one, so "nothing happened in
    // between" can be decided without comparing global sequence numbers.
    const prior = this.db.prepare('SELECT seq FROM events WHERE session_id=? AND seq<? ORDER BY seq DESC LIMIT 1').get(sessionId, row.seq);
    return { seq: row.seq, kind: row.kind, stopReason, previousStatus, priorSeq: prior?.seq ?? 0, createdAt: row.created_at };
  }
  /** Newest finished turn and newest prompt: a turn only counts if it ended after the prompt. */
  latestTurn(sessionId) {
    const turn = this.db.prepare("SELECT seq,data FROM events WHERE session_id=? AND kind='turn_finished' ORDER BY seq DESC LIMIT 1").get(sessionId);
    if (!turn) return null;
    const prompt = this.db.prepare("SELECT seq FROM events WHERE session_id=? AND kind='user_message' ORDER BY seq DESC LIMIT 1").get(sessionId);
    let stopReason = null;
    try {
      const value = JSON.parse(turn.data)?.stopReason;
      stopReason = typeof value === 'string' ? value.slice(0, 40) : null;
    } catch { stopReason = null; }
    return { seq: turn.seq, stopReason, afterPrompt: !prompt || turn.seq > prompt.seq };
  }
  attentionView(sessionId) {
    return this.db.prepare('SELECT cursor,status,viewed_at FROM attention_views WHERE session_id=?').get(sessionId) ?? null;
  }
  /**
   * Records that the user saw the session up to `cursor` while it had its
   * current status. Never moves backwards; it changes no session state.
   */
  markViewed(sessionId, cursor) {
    const session = this.get(sessionId);
    if (!session) throw new Error('session not found');
    this.db.prepare(`INSERT INTO attention_views(session_id,cursor,status,viewed_at) VALUES(?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET cursor=excluded.cursor,status=excluded.status,viewed_at=excluded.viewed_at
      WHERE excluded.cursor>=attention_views.cursor`)
      .run(sessionId, cursor, session.status, new Date().toISOString());
  }
  createApproval(approval) {
    this.db.prepare('INSERT INTO approvals(id,session_id,title,choices,status,created_at,expires_at,detail) VALUES(?,?,?,?,?,?,?,?)').run(
      approval.id, approval.sessionId, approval.title, protect(approval.choices),
      'pending', approval.createdAt, approval.expiresAt, protect(approval.detail ?? {}),
    );
  }
  getApproval(id) {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);
    return r ? { ...r, choices: JSON.parse(r.choices), detail: JSON.parse(r.detail ?? '{}') } : null;
  }
  pendingApprovals(sessionId) {
    return this.db.prepare("SELECT id,session_id,title,choices,detail,status,created_at,expires_at FROM approvals WHERE session_id=? AND status='pending' AND expires_at>? ORDER BY created_at LIMIT 40")
      .all(sessionId, new Date().toISOString())
      .map(r => ({ ...r, choices: JSON.parse(r.choices), detail: JSON.parse(r.detail ?? '{}') }));
  }
  /**
   * Move a pending approval to its final state exactly once.
   * A human decision is only accepted before the deadline; `expired` and
   * `cancelled` close the record whenever it is still pending.
   */
  resolveApproval(id, selectedOption, status) {
    const decided = status === 'approved' || status === 'denied';
    const result = this.db.prepare(`UPDATE approvals SET status=?, selected_option=? WHERE id=? AND status='pending' AND (?=0 OR expires_at>?)`)
      .run(status, selectedOption, id, Number(decided), new Date().toISOString());
    return result.changes === 1;
  }
  close() { this.db.close(); }
}
