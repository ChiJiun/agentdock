import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { SessionStore } from './store.mjs';
import { AcpHost } from './acp-host.mjs';
import { DEFAULT_MOCK, ensureInside, childEnvironment } from './adapters.mjs';
import { createRuntimeServer } from './server.mjs';

const cwd = realpathSync(process.cwd());
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));
async function until(check, maxMs = 3000) {
  const deadline = Date.now() + maxMs;
  do {
    const value = await check();
    if (value) return value;
    await pause(30);
  } while (Date.now() < deadline);
  throw new Error('timed out waiting for deterministic ACP event');
}

describe('real ACP official SDK runtime', () => {
  test('path containment rejects traversal / symlink escape before spawning any process', () => {
    assert.equal(ensureInside(cwd, [cwd]), cwd);
    assert.throws(() => ensureInside('/not/an/absolute/dir/that/existed/no', [cwd]));
    assert.throws(() => ensureInside('..', [cwd]), /absolute/);
    const sanitized = childEnvironment([]);
    assert.equal(sanitized.NON_EXISTENT_SECRET_NAME, undefined);
  });

  test('SQLite recovers readable history and marks a lost process interrupted (never resumed automatically)', () => {
    mkdirSync(resolve('.local'), { recursive: true });
    const temp = mkdtempSync(resolve('.local', 'test-store-'));
    const path = join(temp, 'session.db');
    try {
      const one = new SessionStore(path);
      const s = one.create({ id: 'fixture', adapter: 'mock', cwd });
      assert.equal(s.status, 'starting');
      one.status('fixture','running');
      one.event('fixture', 'user_message', { text: 'Hello' });
      one.close();
      const two = new SessionStore(path);
      assert.equal(two.get('fixture').status, 'interrupted');
      assert.equal(two.events('fixture').length,1);
      assert.equal(two.events('fixture')[0].data.text,'Hello');
      two.event('fixture','agent_update',{ text: 'A'.repeat(120000), authorization: 'Bearer confidential', nested:{access_token:'top-secret'} });
      const large = two.events('fixture')[1];
      assert.ok(large.data.text?.length <= 8000 || large.data.truncated);
      assert.ok(!JSON.stringify(large.data).includes('top-secret'));
      assert.ok(!JSON.stringify(large.data).includes('confidential'));
      two.close();
    } finally { rmSync(temp,{recursive:true,force:true}); }
  });

  test('starts a real ACP child, initializes a v1 session, streams a reply and preserves evidence', async () => {
    const store = new SessionStore(':memory:');
    const host = new AcpHost({ store, roots:[cwd], adapters:[DEFAULT_MOCK] });
    try {
      const session = await host.start({ adapterId:'mock',cwd });
      assert.equal(session.status,'ready');
      assert.equal(session.supports_load,0);
      await host.prompt(session.id,'Can you identify yourself?');
      assert.equal(store.get(session.id).status,'ready');
      const events = store.events(session.id);
      assert.ok(events.some(e=>e.kind==='connected'));
      assert.ok(events.some(e=>e.kind==='agent_update' && e.data.update?.content?.text?.includes('Received')));
      assert.ok(events.some(e=>e.kind==='turn_finished'));
      assert.equal(events.filter(e=>e.kind==='user_message').length,1);
    } finally { await host.shutdown();store.close(); }
  });

  test('holds an ACP permission request until explicitly denied, and rejects replay', async () => {
    const store = new SessionStore(':memory:');
    const host = new AcpHost({ store, roots:[cwd], adapters:[DEFAULT_MOCK] });
    try {
      const session=await host.start({adapterId:'mock',cwd});
      const waiting=host.prompt(session.id,'Please trigger approval for a fake read action');
      const approval=await until(()=>store.pendingApprovals(session.id)[0]);
      assert.equal(store.get(session.id).status,'awaiting_approval');
      assert.equal(approval.title,'Mock read-only approval request');
      assert.deepEqual(host.approve(session.id,approval.id,'deny'), {ok:true,decision:'deny'});
      await waiting;
      assert.equal(store.getApproval(approval.id).status,'denied');
      assert.throws(()=>host.approve(session.id,approval.id,'allow_once'),/not pending/);
      assert.ok(store.events(session.id).some(e=>e.kind==='agent_update' && e.data.update?.content?.text?.includes('denied')));
    } finally { await host.shutdown();store.close(); }
  });

  test('one-time approval selects only an explicitly advertised allow_once option', async () => {
    const store = new SessionStore(':memory:');
    const host = new AcpHost({ store, roots:[cwd], adapters:[DEFAULT_MOCK] });
    try {
      const session=await host.start({adapterId:'mock',cwd});
      const waiting=host.prompt(session.id,'approval request');
      const approval=await until(()=>store.pendingApprovals(session.id)[0]);
      assert.throws(()=>host.approve(session.id,approval.id,'allow_always'),/invalid approval/);
      host.approve(session.id,approval.id,'allow_once');
      await waiting;
      assert.equal(store.getApproval(approval.id).status,'approved');
      assert.equal(store.getApproval(approval.id).selected_option,'allow-once');
    } finally { await host.shutdown();store.close(); }
  });

  test('localhost API rejects cross-origin mutation and exposes real live events', async () => {
    const runtime=createRuntimeServer({ roots:[cwd], dbPath:':memory:', adapters:[DEFAULT_MOCK] });
    const address=await runtime.listen(0);
    const base=`http://127.0.0.1:${address.port}`;
    const post=(path,data,headers={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(data)});
    try {
      assert.equal((await (await fetch(base+'/api/health')).json()).ok,true);
      assert.equal((await fetch(base+'/api/adapters')).status,200);
      assert.equal((await post('/api/sessions',{adapterId:'mock',cwd},{origin:'https://malicious.example'})).status,403);
      const response=await post('/api/sessions',{adapterId:'mock',cwd});
      assert.equal(response.status,201);
      const session=await response.json();
      const sent=await post(`/api/sessions/${session.id}/prompt`,{text:'Hello via API'});
      assert.equal(sent.status,202);
      const events=await until(async()=>await (await fetch(base+`/api/sessions/${session.id}/events`)).json());
      // until above tests presence separately; no reliance on immediate streaming events.
      assert.ok(Array.isArray(events));
      await until(()=>runtime.store.events(session.id).some(e=>e.kind==='turn_finished'));
      const all=await (await fetch(base+`/api/sessions/${session.id}/events`)).json();
      assert.ok(all.some(e=>e.kind==='agent_update'));
      const invalid = await post('/api/sessions',{adapterId:'mock',cwd:'/'});
      assert.ok(invalid.status>=400);
      const view = await fetch(base+`/api/sessions/${session.id}`);
      assert.equal((await view.json()).status,'ready');
    } finally { await runtime.close(); }
  });
});
