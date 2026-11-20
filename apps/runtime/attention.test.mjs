import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { SessionStore } from './store.mjs';
import { deriveAttention, attentionCounts } from './attention.mjs';
import { createRuntimeServer } from './server.mjs';
import { DEFAULT_MOCK } from './adapters.mjs';

const cwd = process.cwd();
const now = () => new Date().toISOString();
const after = () => new Date(Date.now() + 60_000).toISOString();
const SID = '11111111-1111-4111-8111-111111111111';
const post = (url, data = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

function withStore(fn) {
  const store = new SessionStore(':memory:');
  try { return fn(store); } finally { store.close(); }
}

describe('event-driven Session Sentinel (no model calls)', () => {
  test('running is background; a finished turn is a new result to review, counted', () => withStore(store => {
    store.create({ id: 'one', adapter: 'mock', cwd });
    store.status('one', 'running');
    store.event('one', 'user_message', { text: 'this private user prompt must not appear in summary' });
    let items = deriveAttention(store);
    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'background');
    assert.deepEqual(attentionCounts(items), { reply: 0, review: 0, background: 1 });
    assert.ok(!JSON.stringify(items).includes('private user prompt'));
    store.status('one', 'ready');
    store.event('one', 'turn_finished', { stopReason: 'end_turn' });
    items = deriveAttention(store);
    assert.equal(items[0].type, 'review');
    assert.equal(items[0].key, 'turn_finished');
    assert.equal(items[0].evidenceCursor, 2);
    assert.deepEqual(attentionCounts(items), { reply: 0, review: 1, background: 0 });
  }));

  test('a cancelled turn is a result to review (UX section 2); an idle session with no turn produces none', () => withStore(store => {
    store.create({ id: 'c', adapter: 'mock', cwd });
    store.status('c', 'ready');
    store.event('c', 'connected');
    assert.equal(deriveAttention(store).length, 0);
    store.event('c', 'user_message', { text: 'x' });
    store.event('c', 'turn_finished', { stopReason: 'cancelled' });
    const items = deriveAttention(store);
    assert.deepEqual(items.map(i => [i.type, i.key]), [['review', 'turn_cancelled']]);
    store.markViewed('c', items[0].evidenceCursor);
    assert.equal(deriveAttention(store).length, 0);
  }));

  test('a finished turn stays listed when a later bookkeeping event (cancel_requested) is written', () => withStore(store => {
    store.create({ id: 'late', adapter: 'mock', cwd });
    store.status('late', 'ready');
    store.event('late', 'user_message', { text: 'x' });
    store.event('late', 'turn_finished', { stopReason: 'end_turn' });
    store.event('late', 'cancel_requested', { by: 'user' });
    assert.deepEqual(deriveAttention(store).map(i => i.key), ['turn_finished']);
    // A new prompt without a finished turn is no result.
    store.status('late', 'running');
    store.event('late', 'user_message', { text: 'again' });
    assert.deepEqual(deriveAttention(store).map(i => i.type), ['background']);
  }));

  test('pending permission needs a reply and cannot be hidden by "mark reviewed"', async () => {
    const runtime = createRuntimeServer({ roots: [cwd], dbPath: ':memory:', adapters: [DEFAULT_MOCK] });
    const { port } = await runtime.listen(0);
    const root = `http://127.0.0.1:${port}`;
    try {
      const store = runtime.store;
      store.create({ id: SID, adapter: 'mock', cwd });
      store.status(SID, 'awaiting_approval');
      store.event(SID, 'approval_requested', { title: 'write ghp_abcdefghijklmnopqrstuvwxyz0123 to .env' });
      store.createApproval({ id: 'p1', sessionId: SID, title: 'cat ~/.ssh/id_rsa sk-proj-SECRETSECRETSECRET', choices: [{ id: 'allow', kind: 'allow_once' }], createdAt: now(), expiresAt: after() });
      const items = await (await fetch(root + '/api/attention')).json();
      assert.equal(items.length, 1);
      assert.equal(items[0].type, 'reply');
      assert.equal(items[0].key, 'approval_pending');
      // Summaries never carry tool titles, commands or credentials.
      const text = JSON.stringify(items);
      for (const secret of ['ghp_', 'sk-proj', 'id_rsa', '.env', 'cat ~']) assert.ok(!text.includes(secret), secret);
      const r = await post(`${root}/api/attention/${encodeURIComponent(items[0].id)}/reviewed`);
      assert.equal(r.status, 409);
      assert.equal(deriveAttention(store).length, 1, 'still listed');
      assert.equal(store.getApproval('p1').status, 'pending', 'not approved or denied');
      // Viewing the session also never clears a pending reply.
      assert.equal((await post(`${root}/api/sessions/${SID}/viewed`, { cursor: 1 })).status, 200);
      assert.equal(deriveAttention(store)[0].type, 'reply');
    } finally { await runtime.close(); }
  });

  test('a second pending approval stays visible after the first is answered (status back to running)', () => withStore(store => {
    store.create({ id: 'multi', adapter: 'mock', cwd });
    store.status('multi', 'awaiting_approval');
    store.createApproval({ id: 'a1', sessionId: 'multi', title: 't', choices: [], createdAt: now(), expiresAt: after() });
    store.createApproval({ id: 'a2', sessionId: 'multi', title: 't', choices: [], createdAt: now(), expiresAt: after() });
    store.resolveApproval('a1', 'allow', 'approved');
    store.status('multi', 'running');
    const items = deriveAttention(store);
    assert.deepEqual(items.map(i => i.id), ['approval:a2']);
  }));

  test('expired approvals and approvals of a lost connection are not current decisions', () => withStore(store => {
    store.create({ id: 'expired', adapter: 'mock', cwd });
    store.status('expired', 'awaiting_approval');
    store.createApproval({ id: 'old', sessionId: 'expired', title: 'Old tool', choices: [], createdAt: now(), expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.ok(!deriveAttention(store).some(i => i.type === 'reply'));
    store.create({ id: 'lost', adapter: 'mock', cwd });
    store.createApproval({ id: 'gone', sessionId: 'lost', title: 't', choices: [], createdAt: now(), expiresAt: after() });
    store.status('lost', 'interrupted');
    store.event('lost', 'process_exit');
    const items = deriveAttention(store);
    assert.ok(!items.some(i => i.type === 'reply'));
    assert.equal(items.find(i => i.sessionId === 'lost').key, 'agent_interrupted');
  }));

  test('reply first, then review, then background', () => withStore(store => {
    store.create({ id: 'running', adapter: 'mock', cwd });
    store.status('running', 'running');
    store.event('running', 'connected');
    store.create({ id: 'interrupted', adapter: 'mock', cwd });
    store.status('interrupted', 'interrupted');
    store.event('interrupted', 'process_exit');
    store.create({ id: 'wait', adapter: 'mock', cwd });
    store.status('wait', 'awaiting_approval');
    store.createApproval({ id: 'w', sessionId: 'wait', title: 't', choices: [], createdAt: now(), expiresAt: after() });
    const items = deriveAttention(store);
    assert.deepEqual(items.map(i => i.type), ['reply', 'review', 'background']);
    assert.deepEqual(attentionCounts(items), { reply: 1, review: 1, background: 1 });
  }));

  test('viewed state survives restart; a new event brings the item back', () => {
    mkdirSync(resolve('.local'), { recursive: true });
    const temp = mkdtempSync(resolve('.local', 'attention-test-'));
    try {
      const path = join(temp, 'db.sqlite');
      const first = new SessionStore(path);
      first.create({ id: 'persist', adapter: 'mock', cwd });
      first.status('persist', 'failed');
      first.event('persist', 'error', { message: 'failed task' });
      const item = deriveAttention(first)[0];
      first.markViewed(item.sessionId, item.evidenceCursor);
      first.close();
      const next = new SessionStore(path);
      assert.equal(deriveAttention(next).length, 0);
      assert.equal(deriveAttention(next, { includeViewed: true }).length, 1);
      next.event('persist', 'error', { message: 'another failed operation' });
      const updated = deriveAttention(next)[0];
      assert.ok(updated);
      assert.notEqual(updated.id, item.id);
      next.close();
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  test('restart interruption: idle-and-viewed stays quiet; running-when-viewed or changed-after-view is surfaced', () => {
    mkdirSync(resolve('.local'), { recursive: true });
    const temp = mkdtempSync(resolve('.local', 'attention-test-'));
    try {
      const path = join(temp, 'db.sqlite');
      const first = new SessionStore(path);
      first.create({ id: 'idle', adapter: 'mock', cwd });
      first.status('idle', 'ready');
      first.event('idle', 'turn_finished', { stopReason: 'end_turn' });
      first.markViewed('idle', 1);
      first.create({ id: 'late', adapter: 'mock', cwd });
      first.status('late', 'ready');
      const turn = first.event('late', 'turn_finished', { stopReason: 'end_turn' }).seq;
      first.markViewed('late', turn);
      first.event('late', 'cancel_requested', { by: 'user' }); // something new after the view
      first.create({ id: 'busy', adapter: 'mock', cwd });
      first.status('busy', 'running');
      const seq = first.event('busy', 'user_message', { text: 'x' }).seq;
      first.markViewed('busy', seq);
      first.close();
      // Ungraceful stop: the next host marks live sessions interrupted and
      // records `host_restarted` with the previous status.
      const next = new SessionStore(path);
      const items = deriveAttention(next);
      assert.deepEqual(items.map(i => [i.sessionId, i.key]).sort(),
        [['busy', 'agent_interrupted'], ['late', 'agent_interrupted']]);
      next.close();
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  test('an old cursor marked after restart cannot erase an unseen interruption', () => {
    mkdirSync(resolve('.local'), { recursive: true });
    const temp = mkdtempSync(resolve('.local', 'attention-test-'));
    try {
      const path = join(temp, 'db.sqlite');
      const first = new SessionStore(path);
      first.create({ id: 'lost', adapter: 'mock', cwd });
      first.status('lost', 'ready');
      const cursor = first.event('lost', 'connected').seq;
      first.close();
      const next = new SessionStore(path);
      assert.equal(next.get('lost').status, 'interrupted');
      // A delayed UI POST uses a pre-restart event cursor.
      next.markViewed('lost', cursor);
      assert.deepEqual(deriveAttention(next).map(item => item.key), ['agent_interrupted']);
      // Explicitly opening the latest interruption evidence does acknowledge it.
      const latest = next.latestEvent('lost').seq;
      next.markViewed('lost', latest);
      assert.deepEqual(deriveAttention(next), []);
      next.close();
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  test('view marks never move backwards', () => withStore(store => {
    store.create({ id: 'v', adapter: 'mock', cwd });
    store.status('v', 'failed');
    store.event('v', 'error');
    store.event('v', 'error');
    store.markViewed('v', 2);
    store.markViewed('v', 1);
    assert.equal(store.attentionView('v').cursor, 2);
    assert.equal(deriveAttention(store).length, 0);
  }));

  test('localhost API: mark one result reviewed, validate ids and cursors', async () => {
    const runtime = createRuntimeServer({ roots: [cwd], dbPath: ':memory:', adapters: [DEFAULT_MOCK] });
    const { port } = await runtime.listen(0);
    const root = `http://127.0.0.1:${port}`;
    try {
      runtime.store.create({ id: SID, adapter: 'mock', cwd });
      runtime.store.status(SID, 'failed');
      runtime.store.event(SID, 'error', { message: 'fake error' });
      const items = await (await fetch(root + '/api/attention')).json();
      assert.equal(items.length, 1);
      const id = items[0].id;
      assert.equal((await post(`${root}/api/attention/${encodeURIComponent(id)}/reviewed`)).status, 200);
      assert.equal((await (await fetch(root + '/api/attention')).json()).length, 0);
      assert.equal((await post(`${root}/api/attention/${encodeURIComponent(id + '-unknown')}/reviewed`)).status, 404);
      assert.equal((await post(`${root}/api/attention/%E0%A4%A/reviewed`)).status, 400);
      assert.equal((await post(`${root}/api/attention/${'a'.repeat(200)}/reviewed`)).status, 404);
      assert.equal((await post(`${root}/api/sessions/${SID}/viewed`, { cursor: 99 })).status, 400);
      assert.equal((await post(`${root}/api/sessions/${SID}/viewed`, { cursor: -1 })).status, 400);
      assert.equal((await post(`${root}/api/sessions/${SID}/viewed`, { cursor: '1' })).status, 400);
      const nullBody = await fetch(`${root}/api/sessions/${SID}/viewed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' });
      assert.equal(nullBody.status, 400);
      const foreign = await fetch(`${root}/api/sessions/${SID}/viewed`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{"cursor":1}' });
      assert.equal(foreign.status, 403);
      const noJson = await fetch(`${root}/api/sessions/${SID}/viewed`, { method: 'POST', body: '{"cursor":1}' });
      assert.equal(noJson.status, 415);
    } finally { await runtime.close(); }
  });
});
