import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionStore } from './store.mjs';
import { AcpHost } from './acp-host.mjs';
import { DEFAULT_MOCK, ensureInside, childEnvironment, launchProblem, loadAdapters } from './adapters.mjs';
import { createRuntimeServer } from './server.mjs';

const cwd = realpathSync(process.cwd());
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
// Generous: a cold Node start can take more than ten seconds on a loaded Windows machine.
async function until(check, maxMs = 30_000) {
  const deadline = Date.now() + maxMs;
  do {
    const value = await check();
    if (value) return value;
    await pause(30);
  } while (Date.now() < deadline);
  throw new Error('timed out waiting for deterministic ACP event');
}
const LIMITS = { initTimeoutMs: 90_000, stdinGraceMs: 1_000, killGraceMs: 10_000 };
const fixture = fileURLToPath(new URL('./test-fixtures/hostile-agent.mjs', import.meta.url));
const hostile = mode => ({ id: mode, label: mode, bin: process.execPath, args: [fixture, mode], authEnv: [] });
const isGone = pid => {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
};
const texts = (store, id) => store.events(id).filter(e => e.kind === 'agent_update').map(e => e.data.update?.content?.text ?? '');
function tempDir() {
  mkdirSync(resolve('.local'), { recursive: true });
  return mkdtempSync(resolve('.local', 'test-store-'));
}
function newHost(adapters, limits = {}) {
  const store = new SessionStore(':memory:');
  const host = new AcpHost({ store, roots: [cwd], adapters, limits: { ...LIMITS, ...limits } });
  return { store, host, async end() { await host.shutdown(); store.close(); } };
}

describe('real ACP official SDK runtime', () => {
  test('path containment rejects traversal / symlink escape before spawning any process', () => {
    assert.equal(ensureInside(cwd, [cwd]), cwd);
    assert.throws(() => ensureInside('/not/an/absolute/dir/that/existed/no', [cwd]), /does not exist/);
    assert.throws(() => ensureInside('..', [cwd]), /absolute/);
    assert.throws(() => ensureInside(undefined, [cwd]), /absolute/);
    assert.throws(() => ensureInside(resolve(cwd, '..'), [cwd]), /outside approved roots/);
    const sanitized = childEnvironment([]);
    assert.equal(sanitized.NON_EXISTENT_SECRET_NAME, undefined);
  });

  test('adapter configuration refuses relative executables and Windows shell shims', () => {
    assert.match(launchProblem('codex-acp', 'win32'), /absolute/);
    assert.match(launchProblem('./agent', 'linux'), /absolute/);
    assert.match(launchProblem('C:\\Users\\me\\AppData\\Roaming\\npm\\claude-agent-acp.cmd', 'win32'), /shim/);
    assert.match(launchProblem('C:/tools/agent.BAT', 'win32'), /shim/);
    assert.equal(launchProblem('C:\\Program Files\\nodejs\\node.exe', 'win32'), null);
    assert.equal(launchProblem('/usr/local/bin/agent', 'linux'), null);
    const temp = tempDir();
    try {
      const file = join(temp, 'adapters.json');
      writeFileSync(file, JSON.stringify([{ id: 'planted', bin: 'agent.exe', args: [] }]));
      assert.throws(() => loadAdapters(file), /absolute path/);
      writeFileSync(file, JSON.stringify([{ id: 'ok', bin: process.execPath, args: ['x.mjs'] }]));
      assert.deepEqual(loadAdapters(file).map(a => a.id), ['mock', 'ok']);
      writeFileSync(file, JSON.stringify([{ id: 'ok', bin: process.execPath, args: [] }, { id: 'ok', bin: process.execPath, args: [] }]));
      assert.throws(() => loadAdapters(file), /duplicate/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  test('SQLite recovers readable history and marks a lost process interrupted (never resumed automatically)', () => {
    const temp = tempDir();
    const path = join(temp, 'session.db');
    try {
      const one = new SessionStore(path);
      const s = one.create({ id: 'fixture', adapter: 'mock', cwd });
      assert.equal(s.status, 'starting');
      one.status('fixture', 'running');
      one.event('fixture', 'user_message', { text: 'Hello' });
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      one.createApproval({ id: 'a1', sessionId: 'fixture', title: 't', choices: [], detail: {}, createdAt: new Date().toISOString(), expiresAt });
      one.close();
      const two = new SessionStore(path);
      assert.equal(two.recovered, 1);
      assert.equal(two.get('fixture').status, 'interrupted');
      const kinds = two.events('fixture').map(e => e.kind);
      assert.deepEqual(kinds, ['user_message', 'host_restarted', 'approval_resolved']);
      assert.equal(two.events('fixture')[0].data.text, 'Hello');
      // An approval left pending by the dead host can never be answered later.
      assert.equal(two.getApproval('a1').status, 'cancelled');
      assert.equal(two.pendingApprovals('fixture').length, 0);
      assert.equal(two.resolveApproval('a1', 'allow', 'approved'), false);
      two.event('fixture', 'agent_update', { text: 'A'.repeat(120000), authorization: 'Bearer confidential', nested: { access_token: 'top-secret' } });
      const large = two.events('fixture').at(-1);
      assert.ok(large.data.truncated || /\[truncated \d+ chars\]$/.test(large.data.text));
      assert.ok(!JSON.stringify(large.data).includes('top-secret'));
      assert.ok(!JSON.stringify(large.data).includes('confidential'));
      // A maximum-length prompt is kept whole, including non-ASCII text.
      const prompt = '測'.repeat(12_000);
      two.event('fixture', 'user_message', { text: prompt });
      assert.equal(two.events('fixture').at(-1).data.text, prompt);
      // A state change and its event are stored together or not at all.
      assert.throws(() => two.atomic(() => { two.status('fixture', 'ready'); two.event('fixture', 'x', {}); throw new Error('boom'); }), /boom/);
      assert.equal(two.get('fixture').status, 'interrupted');
      assert.ok(!two.events('fixture').some(e => e.kind === 'x'));
      two.close();
      // A third start has nothing left to recover and adds no duplicate events.
      const three = new SessionStore(path);
      assert.equal(three.recovered, 0);
      assert.equal(three.events('fixture').filter(e => e.kind === 'host_restarted').length, 1);
      three.close();
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  test('starts a real ACP child, initializes a v1 session, streams a reply and preserves evidence', async () => {
    const { store, host, end } = newHost([DEFAULT_MOCK]);
    try {
      const session = await host.start({ adapterId: 'mock', cwd });
      assert.equal(session.status, 'ready');
      assert.equal(session.supports_load, 0);
      await host.prompt(session.id, 'Can you identify yourself?');
      assert.equal(store.get(session.id).status, 'ready');
      const events = store.events(session.id);
      assert.ok(events.some(e => e.kind === 'connected'));
      assert.ok(events.some(e => e.kind === 'agent_update' && e.data.update?.content?.text?.includes('Received')));
      assert.ok(events.some(e => e.kind === 'turn_finished'));
      assert.equal(events.filter(e => e.kind === 'user_message').length, 1);
      // Orderly close: the mock leaves on stdin EOF, and the session ends as closed.
      const proc = host.connections.get(session.id).proc;
      await host.close(session.id);
      assert.ok(proc.exitCode !== null || proc.signalCode !== null);
      assert.equal(store.get(session.id).status, 'closed');
      assert.equal(host.connections.size, 0);
      await assert.rejects(host.prompt(session.id, 'again'), /not connected/);
    } finally { await end(); }
  });

  test('holds an ACP permission request until explicitly denied, and rejects replay', async () => {
    const { store, host, end } = newHost([DEFAULT_MOCK]);
    try {
      const session = await host.start({ adapterId: 'mock', cwd });
      const waiting = host.prompt(session.id, 'Please trigger approval for a fake read action');
      const approval = await until(() => store.pendingApprovals(session.id)[0]);
      assert.equal(store.get(session.id).status, 'awaiting_approval');
      assert.equal(approval.title, 'Mock read-only approval request');
      // The human sees what is being asked, with secrets removed.
      assert.equal(approval.detail.kind, 'read');
      assert.equal(approval.detail.input.path, 'README.md');
      assert.equal(approval.detail.input.api_key, '[REDACTED]');
      assert.deepEqual(approval.detail.locations, ['README.md']);
      // Nothing is granted while the request is waiting.
      await pause(300);
      assert.ok(!texts(store, session.id).some(t => t.includes('Approved')));
      assert.deepEqual(host.approve(session.id, approval.id, 'deny'), { ok: true, decision: 'deny' });
      await waiting;
      assert.equal(store.getApproval(approval.id).status, 'denied');
      // A denial answers with the agent's own reject option, never an allow option.
      assert.equal(store.getApproval(approval.id).selected_option, 'reject');
      assert.throws(() => host.approve(session.id, approval.id, 'allow_once'), /not pending/);
      assert.ok(texts(store, session.id).some(t => t.includes('denied')));
      assert.ok(!texts(store, session.id).some(t => t.includes('Approved')));
      assert.equal(store.get(session.id).status, 'ready');
    } finally { await end(); }
  });

  test('one-time approval selects only an explicitly advertised allow_once option', async () => {
    const { store, host, end } = newHost([DEFAULT_MOCK]);
    try {
      const session = await host.start({ adapterId: 'mock', cwd });
      const waiting = host.prompt(session.id, 'approval request');
      const approval = await until(() => store.pendingApprovals(session.id)[0]);
      assert.throws(() => host.approve(session.id, approval.id, 'allow_always'), /invalid approval/);
      assert.throws(() => host.approve('00000000-0000-0000-0000-000000000000', approval.id, 'allow_once'), /not pending/);
      host.approve(session.id, approval.id, 'allow_once');
      await waiting;
      assert.equal(store.getApproval(approval.id).status, 'approved');
      assert.equal(store.getApproval(approval.id).selected_option, 'allow-once');
      assert.ok(texts(store, session.id).some(t => t.includes('Approved')));
    } finally { await end(); }
  });

  test('an unanswered approval expires as a refusal and cannot be approved afterwards', async () => {
    const { store, host, end } = newHost([DEFAULT_MOCK], { approvalTtlMs: 400 });
    try {
      const session = await host.start({ adapterId: 'mock', cwd });
      const waiting = host.prompt(session.id, 'approval request');
      const approval = await until(() => store.getApproval(store.events(session.id).find(e => e.kind === 'approval_requested')?.data.approvalId ?? ''));
      await waiting;
      assert.equal(store.getApproval(approval.id).status, 'expired');
      assert.equal(store.getApproval(approval.id).selected_option, null);
      assert.throws(() => host.approve(session.id, approval.id, 'allow_once'), /not pending/);
      assert.ok(store.events(session.id).some(e => e.kind === 'approval_resolved' && e.data.decision === 'expired'));
      assert.ok(!texts(store, session.id).some(t => t.includes('Approved')));
      assert.equal(store.get(session.id).status, 'ready');
    } finally { await end(); }
  });

  test('cancelling a turn releases its pending approval as cancelled', async () => {
    const { store, host, end } = newHost([DEFAULT_MOCK]);
    try {
      const session = await host.start({ adapterId: 'mock', cwd });
      const waiting = host.prompt(session.id, 'approval request');
      const approval = await until(() => store.pendingApprovals(session.id)[0]);
      assert.deepEqual(await host.cancel(session.id), { ok: true, active: true });
      const result = await waiting;
      assert.equal(result.stopReason, 'cancelled');
      assert.equal(store.getApproval(approval.id).status, 'cancelled');
      assert.throws(() => host.approve(session.id, approval.id, 'allow_once'), /not pending/);
      assert.ok(!texts(store, session.id).some(t => t.includes('Approved')));
      assert.equal(store.get(session.id).status, 'ready');
      // The cancel request is recorded before the approval is released.
      const kinds = store.events(session.id).map(e => e.kind);
      assert.ok(kinds.indexOf('cancel_requested') < kinds.lastIndexOf('approval_resolved'));
      assert.deepEqual(await host.cancel(session.id), { ok: true, active: false });
    } finally { await end(); }
  });

  test('failed cancellation transport invalidates approvals and terminates the agent', async () => {
    const { store, host, end } = newHost([DEFAULT_MOCK]);
    try {
      const session = await host.start({ adapterId: 'mock', cwd });
      const waiting = host.prompt(session.id, 'approval request').catch(() => undefined);
      const approval = await until(() => store.pendingApprovals(session.id)[0]);
      const conn = host.connections.get(session.id);
      const originalNotify = conn.ctx.notify;
      conn.ctx.notify = async () => { throw new Error('simulated broken cancellation pipe'); };
      await assert.rejects(host.cancel(session.id), /cancellation failed/);
      assert.equal(store.getApproval(approval.id).status, 'cancelled');
      assert.equal(store.pendingApprovals(session.id).length, 0);
      assert.throws(() => host.approve(session.id, approval.id, 'allow_once'), /not pending/);
      await until(() => store.get(session.id).status === 'failed');
      await until(() => !host.connections.has(session.id));
      await waiting;
      conn.ctx.notify = originalNotify;
    } finally { await end(); }
  });

  test('closing a session with a pending approval never leaves it approvable', async () => {
    const { store, host, end } = newHost([DEFAULT_MOCK]);
    try {
      const session = await host.start({ adapterId: 'mock', cwd });
      const waiting = host.prompt(session.id, 'approval request').catch(() => 'rejected');
      const approval = await until(() => store.pendingApprovals(session.id)[0]);
      await host.close(session.id);
      await waiting;
      assert.equal(store.getApproval(approval.id).status, 'cancelled');
      assert.equal(store.pendingApprovals(session.id).length, 0);
      assert.equal(store.get(session.id).status, 'closed');
      assert.throws(() => host.approve(session.id, approval.id, 'allow_once'), /not pending/);
    } finally { await end(); }
  });

  test('start failures end as failed with a reason, and no process is left behind', async () => {
    const { store, host, end } = newHost([
      { id: 'missing', label: 'missing', bin: resolve(cwd, 'no-such-agent-binary'), args: [], authEnv: [] },
      hostile('exit-early'), hostile('hang-init'), hostile('wrong-version'),
    ], { initTimeoutMs: 20_000 });
    const failed = async (adapterId, pattern, code) => {
      const before = new Set(store.list().map(s => s.id));
      const starting = host.start({ adapterId, cwd });
      const conn = [...host.connections.values()].at(-1);
      await assert.rejects(starting, pattern);
      const session = store.list().find(s => !before.has(s.id));
      assert.equal(session.status, 'failed', adapterId);
      const events = store.events(session.id);
      assert.ok(events.some(e => (e.kind === 'error' && (!code || e.data.code === code)) || e.kind === 'process_exit'), adapterId);
      assert.ok(!events.some(e => e.kind === 'closed'), adapterId);
      if (conn?.proc.pid) await until(() => conn.proc.exitCode !== null || conn.proc.signalCode !== null);
      assert.equal(host.connections.has(session.id), false, adapterId);
    };
    try {
      await assert.rejects(host.start({ adapterId: 'nope', cwd }), /unknown adapter/);
      await assert.rejects(host.start({ adapterId: 'missing', cwd: resolve(cwd, 'package.json') }), /directory/);
      await failed('missing', /Could not launch|ACP connection failed/);
      await failed('exit-early', /exited before initialization|ACP connection failed/);
      await failed('wrong-version', /unsupported ACP protocol version/, 'unsupported_protocol');
      host.limits.initTimeoutMs = 3_000;
      await failed('hang-init', /initialization timeout/, 'init_timeout');
    } finally { await end(); }
  });

  test('invalid UTF-8 and non-JSON lines do not end the connection; an oversized line ends it explicitly', async () => {
    const { store, host, end } = newHost([hostile('bad-bytes'), hostile('oversize'), hostile('early-update')], { maxMessageBytes: 64 * 1024 });
    try {
      const ok = await host.start({ adapterId: 'bad-bytes', cwd });
      const result = await host.prompt(ok.id, 'send bad bytes');
      assert.equal(result.stopReason, 'end_turn');
      assert.ok(texts(store, ok.id).includes('still connected after bad bytes'));
      assert.equal(store.get(ok.id).status, 'ready');

      const big = await host.start({ adapterId: 'oversize', cwd });
      await assert.rejects(host.prompt(big.id, 'send a huge line'));
      await until(() => store.get(big.id).status === 'failed');
      assert.ok(store.events(big.id).some(e => e.kind === 'error'));
      await until(() => !host.connections.has(big.id));

      // Updates sent right behind the session/new reply are not lost.
      const early = await host.start({ adapterId: 'early-update', cwd });
      await until(() => texts(store, early.id).includes('early update'));
    } finally { await end(); }
  });

  test('closing stops the whole process tree, and a failed prompt ends the session', async () => {
    const { store, host, end } = newHost([hostile('stubborn'), hostile('prompt-error')]);
    try {
      const session = await host.start({ adapterId: 'stubborn', cwd });
      const agentPid = host.connections.get(session.id).proc.pid;
      await host.prompt(session.id, 'spawn a grandchild');
      const grandchild = Number(/grandchild pid (\d+)/.exec(texts(store, session.id).join('\n'))[1]);
      assert.equal(isGone(grandchild), false);
      // This agent ignores stdin EOF, so the host has to stop it and its descendant.
      await host.close(session.id);
      await until(() => isGone(agentPid) && isGone(grandchild));
      assert.equal(store.get(session.id).status, 'closed');

      const broken = await host.start({ adapterId: 'prompt-error', cwd });
      const proc = host.connections.get(broken.id).proc;
      await assert.rejects(host.prompt(broken.id, 'fail please'));
      assert.equal(store.get(broken.id).status, 'failed');
      await until(() => proc.exitCode !== null || proc.signalCode !== null);
      await until(() => !host.connections.has(broken.id));
      await assert.rejects(host.prompt(broken.id, 'again'), /not connected/);
      assert.equal(store.get(broken.id).status, 'failed');
    } finally { await end(); }
  });

  test('shutdown is bounded when an exited agent leaves a descendant holding stdio', async () => {
    if (process.platform === 'win32') return; // Windows requires Job Object descendant tracking.
    const { store, host, end } = newHost([hostile('orphan-stdio')], { transportGraceMs: 250 });
    try {
      const session = await host.start({ adapterId: 'orphan-stdio', cwd });
      await host.prompt(session.id, 'spawn orphan');
      const grandchild = Number(/grandchild pid (\\d+)/.exec(texts(store, session.id).join('\\n'))[1]);
      const conn = host.connections.get(session.id);
      await until(() => conn.proc.exitCode !== null || conn.proc.signalCode !== null);
      await Promise.race([
        host.shutdown(),
        pause(4_000).then(() => { throw new Error('shutdown hung on inherited stdio'); }),
      ]);
      await until(() => isGone(grandchild), 4_000);
      assert.equal(host.connections.has(session.id), false);
    } finally { await end(); }
  });

  test('localhost API rejects cross-origin mutation and exposes real live events', async () => {
    const runtime = createRuntimeServer({ roots: [cwd], dbPath: ':memory:', adapters: [DEFAULT_MOCK], limits: LIMITS });
    const address = await runtime.listen(0);
    const base = `http://127.0.0.1:${address.port}`;
    const post = (path, data, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });
    // Raw request: lets the test choose the Host header and split the body mid-character.
    const raw = (method, path, headers = {}, parts = []) => new Promise((resolveRaw, rejectRaw) => {
      const req = httpRequest({ host: '127.0.0.1', port: address.port, method, path, headers }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolveRaw({ status: res.statusCode, body }));
      });
      req.on('error', rejectRaw);
      (async () => { for (const part of parts) { req.write(part); await pause(40); } req.end(); })();
    });
    try {
      assert.equal((await (await fetch(base + '/api/health')).json()).ok, true);
      assert.equal((await fetch(base + '/api/adapters')).status, 200);
      assert.equal((await post('/api/sessions', { adapterId: 'mock', cwd }, { origin: 'https://malicious.example' })).status, 403);
      // DNS rebinding: same socket, but addressed by a name that is not loopback.
      assert.equal((await raw('GET', '/api/sessions', { host: `attacker.example:${address.port}` })).status, 403);
      assert.equal((await raw('GET', '/api/sessions', { host: `localhost:${address.port}` })).status, 200);
      assert.equal((await post('/api/sessions', { adapterId: 'mock', cwd: '/' })).status, 400);
      assert.equal((await post('/api/sessions', { adapterId: 'mock' })).status, 400);
      assert.equal((await post('/api/sessions', { adapterId: 'nope', cwd })).status, 400);
      assert.equal((await fetch(base + '/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1]' })).status, 400);
      assert.equal((await fetch(base + '/api/sessions', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
      assert.equal((await post('/api/sessions', { adapterId: 'mock', cwd, pad: 'x'.repeat(200_000) })).status, 413);
      const response = await post('/api/sessions', { adapterId: 'mock', cwd });
      assert.equal(response.status, 201);
      const session = await response.json();
      // A multi-byte character split across two TCP chunks must arrive intact.
      const text = '請用繁體中文回答 Hello via API';
      const bytes = Buffer.from(JSON.stringify({ text }), 'utf8');
      const cut = bytes.indexOf(Buffer.from('繁')) + 1;
      const sent = await raw('POST', `/api/sessions/${session.id}/prompt`, { 'content-type': 'application/json', 'content-length': bytes.length }, [bytes.subarray(0, cut), bytes.subarray(cut)]);
      assert.equal(sent.status, 202);
      await until(() => runtime.store.events(session.id).some(e => e.kind === 'turn_finished'));
      const all = await (await fetch(base + `/api/sessions/${session.id}/events`)).json();
      assert.ok(all.some(e => e.kind === 'agent_update'));
      assert.equal(all.find(e => e.kind === 'user_message').data.text, text);
      const view = await fetch(base + `/api/sessions/${session.id}`);
      assert.equal((await view.json()).status, 'ready');
      // Approval decisions are validated by the host, not by the page.
      const none = await post(`/api/sessions/${session.id}/approvals/00000000-0000-0000-0000-000000000000`, { decision: 'allow_once' });
      assert.equal(none.status, 409);
      const status = await (await fetch(base + `/api/git/status?cwd=${encodeURIComponent(cwd)}`)).json();
      assert.match(status.status, /^##/);
      assert.equal((await fetch(base + `/api/git/status?cwd=${encodeURIComponent(resolve(cwd, '..'))}`)).status, 400);
      assert.equal((await post(`/api/sessions/${session.id}/close`, {})).status, 200);
      assert.equal((await post(`/api/sessions/${session.id}/prompt`, { text: 'after close' })).status, 409);
    } finally { await runtime.close(); }
  });

  test('a second host cannot take over a database that a live host owns', async () => {
    const temp = tempDir();
    const dbPath = join(temp, 'agentdock.db');
    try {
      const first = createRuntimeServer({ roots: [cwd], dbPath, adapters: [DEFAULT_MOCK] });
      first.store.create({ id: 'live', adapter: 'mock', cwd });
      first.store.status('live', 'ready');
      assert.throws(() => createRuntimeServer({ roots: [cwd], dbPath, adapters: [DEFAULT_MOCK] }), /already using/);
      assert.equal(first.store.get('live').status, 'ready');
      await first.close();
      // A lock left by a dead process does not block the next start.
      writeFileSync(`${dbPath}.lock`, '2147483646');
      const next = createRuntimeServer({ roots: [cwd], dbPath, adapters: [DEFAULT_MOCK] });
      assert.equal(next.store.get('live').status, 'interrupted');
      await next.close();
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
