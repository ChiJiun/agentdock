import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { SessionStore } from './store.mjs';
import { deriveAttention, decisionRequiredCount } from './attention.mjs';
import { createRuntimeServer } from './server.mjs';
import { DEFAULT_MOCK } from './adapters.mjs';

const cwd = process.cwd();
const now = () => new Date().toISOString();
const after = () => new Date(Date.now() + 60_000).toISOString();

describe('event-driven Session Sentinel (no model calls)', () => {
  test('classifies a running session as background and finished turn as completed', () => {
    const store=new SessionStore(':memory:');
    try {
      store.create({id:'one',adapter:'mock',cwd});
      store.status('one','running');
      store.event('one','user_message',{text:'this private user prompt must not appear in summary'});
      let items=deriveAttention(store);
      assert.equal(items.length,1);
      assert.equal(items[0].type,'background');
      assert.equal(items[0].key,'agent_running');
      assert.equal(decisionRequiredCount(items),0);
      assert.ok(!JSON.stringify(items).includes('private user prompt'));
      store.status('one','ready');
      store.event('one','turn_finished',{stopReason:'end_turn'});
      items=deriveAttention(store);
      assert.equal(items[0].type,'completed');
      assert.equal(items[0].evidenceCursor,2);
    } finally {store.close();}
  });

  test('permission request is a decision requiring manual action; dismissing is not approval', () => {
    const store=new SessionStore(':memory:');
    try {
      store.create({id:'two',adapter:'mock',cwd});
      store.status('two','awaiting_approval');
      store.event('two','approval_requested',{title:'Can this tool write a file?'});
      store.createApproval({id:'p1',sessionId:'two',title:'Mock tool',choices:[{id:'allow',kind:'allow_once'}],createdAt:now(),expiresAt:after()});
      let items=deriveAttention(store);
      assert.equal(items[0].type,'decision');
      assert.equal(items[0].key,'approval_pending');
      assert.equal(decisionRequiredCount(items),1);
      store.dismissAttention(items[0].id);
      assert.equal(deriveAttention(store).length,0);
      assert.equal(store.getApproval('p1').status,'pending');
      assert.equal(deriveAttention(store,{includeDismissed:true}).length,1);
    } finally {store.close();}
  });

  test('expired approval does not become an active decision', () => {
    const store=new SessionStore(':memory:');
    try {
      store.create({id:'expired',adapter:'mock',cwd});
      store.status('expired','awaiting_approval');
      store.createApproval({id:'old',sessionId:'expired',title:'Old tool',choices:[],createdAt:now(),expiresAt:new Date(Date.now()-1000).toISOString()});
      const items=deriveAttention(store);
      assert.equal(items.length,0);
    } finally {store.close();}
  });

  test('failed/interrupted session is prioritized over informational state', () => {
    const store=new SessionStore(':memory:');
    try {
      store.create({id:'running',adapter:'mock',cwd});
      store.status('running','running');
      store.event('running','connected');
      store.create({id:'interrupted',adapter:'mock',cwd});
      store.status('interrupted','interrupted');
      store.event('interrupted','process_exit');
      const items=deriveAttention(store);
      assert.equal(items[0].type,'review');
      assert.equal(items[0].key,'agent_interrupted');
      assert.equal(items[1].type,'background');
      assert.equal(decisionRequiredCount(items),1);
    } finally {store.close();}
  });

  test('dismissal and new meaningful-event IDs remain consistent across database restarts', () => {
    mkdirSync(resolve('.local'),{recursive:true});
    const temp=mkdtempSync(resolve('.local','attention-test-'));
    try {
      const path=join(temp,'db.sqlite');
      const first=new SessionStore(path);
      first.create({id:'persist',adapter:'mock',cwd});
      first.status('persist','failed');
      first.event('persist','error',{message:'failed task'});
      const item=deriveAttention(first)[0];
      first.dismissAttention(item.id);
      first.close();
      const next=new SessionStore(path);
      assert.equal(deriveAttention(next).length,0);
      assert.equal(next.wasDismissed(item.id),true);
      next.event('persist','error',{message:'another failed operation'});
      const updated=deriveAttention(next)[0];
      assert.ok(updated);
      assert.notEqual(updated.id,item.id);
      next.close();
    } finally {rmSync(temp,{recursive:true,force:true});}
  });

  test('localhost API can fetch and dismiss only an existing attention item', async () => {
    const runtime=createRuntimeServer({roots:[cwd],dbPath:':memory:',adapters:[DEFAULT_MOCK]});
    const address=await runtime.listen(0);
    const root=`http://127.0.0.1:${address.port}`;
    try {
      runtime.store.create({id:'api',adapter:'mock',cwd});
      runtime.store.status('api','failed');
      runtime.store.event('api','error',{message:'fake error'});
      const items=await (await fetch(root+'/api/attention')).json();
      assert.equal(items.length,1);
      const id=items[0].id;
      const r=await fetch(root+`/api/attention/${encodeURIComponent(id)}/dismiss`,
        {method:'POST',headers:{'content-type':'application/json'},body:'{}'});
      assert.equal(r.status,200);
      assert.equal((await (await fetch(root+'/api/attention')).json()).length,0);
      const again=await fetch(root+`/api/attention/${encodeURIComponent(id+'-unknown')}/dismiss`,
        {method:'POST',headers:{'content-type':'application/json'},body:'{}'});
      assert.equal(again.status,404);
    } finally {await runtime.close();}
  });
});
