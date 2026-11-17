import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function protect(value) {
  // Always persist valid JSON. Large tool replies must not break event replay.
  // Redaction is defense-in-depth; do not supply credentials as prompt content.
  const sensitiveKey = /(?:password|secret|authorization|credential|api[_-]?key|access[_-]?token|private[_-]?key)/i;
  const redactText = s => s
    .replace(/(sk-(?:proj-)?)[A-Za-z0-9_-]{12,}/g, '$1[REDACTED]')
    .replace(/gh[opusr]_[A-Za-z0-9_]{16,}/g, '[REDACTED-GH-TOKEN]');
  function scrub(input, depth = 0) {
    if (depth > 8) return '[nested content truncated]';
    if (typeof input === 'string') return redactText(input.slice(0, 8000));
    if (input === null || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.slice(0, 100).map(item => scrub(item, depth + 1));
    return Object.fromEntries(Object.entries(input).slice(0, 100).map(([key, item]) =>
      [key, sensitiveKey.test(key) ? '[REDACTED]' : scrub(item, depth + 1)]));
  }
  const output = JSON.stringify(scrub(value ?? {}));
  return output.length <= 24_000
    ? output : JSON.stringify({ truncated: true, excerpt: output.slice(0, 12_000) });
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
        selected_option TEXT
      );
      CREATE TABLE IF NOT EXISTS attention_dismissals (
        id TEXT PRIMARY KEY, dismissed_at TEXT NOT NULL
      );
    `);
    // There are no automatically resumed agent connections at process restart.
    this.db.prepare(`UPDATE sessions SET status='interrupted',updated_at=? WHERE status IN ('starting','ready','running','awaiting_approval')`)
      .run(new Date().toISOString());
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
    const row = this.db.prepare('SELECT seq,kind,created_at FROM events WHERE session_id=? ORDER BY seq DESC LIMIT 1').get(sessionId);
    return row ?? null;
  }
  wasDismissed(id) {
    return !!this.db.prepare('SELECT id FROM attention_dismissals WHERE id=?').get(id);
  }
  dismissAttention(id) {
    this.db.prepare('INSERT OR IGNORE INTO attention_dismissals(id,dismissed_at) VALUES(?,?)').run(id, new Date().toISOString());
  }
  createApproval(approval) {
    this.db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?,?,?,NULL)').run(
      approval.id, approval.sessionId, approval.title, protect(approval.choices),
      'pending', approval.createdAt, approval.expiresAt,
    );
  }
  getApproval(id) {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id);
    return r ? { ...r, choices: JSON.parse(r.choices) } : null;
  }
  pendingApprovals(sessionId) {
    return this.db.prepare("SELECT id,session_id,title,choices,status,created_at,expires_at FROM approvals WHERE session_id=? AND status='pending' AND expires_at>? ORDER BY created_at LIMIT 40")
      .all(sessionId, new Date().toISOString())
      .map(r => ({ ...r, choices: JSON.parse(r.choices) }));
  }
  resolveApproval(id, selectedOption, status) {
    const result = this.db.prepare(`UPDATE approvals SET status=?, selected_option=? WHERE id=? AND status='pending' AND expires_at>?`)
      .run(status, selectedOption, id, new Date().toISOString());
    return result.changes === 1;
  }
  close() { this.db.close(); }
}
