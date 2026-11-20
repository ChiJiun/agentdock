import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LiveWorkspace } from './LiveWorkspace';
import { LanguageProvider } from '../i18n/context';
import { DEFAULT_SETTINGS } from '../i18n/language';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const sessionId = '11111111-1111-4111-8111-111111111111';
const approvalId = '22222222-2222-4222-8222-222222222222';
const session = {
  id: sessionId, adapter: 'mock', cwd: '/mock/project', status: 'ready', agent_session: 'session',
  supports_load: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
};
const returnJson = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json' },
});
let root: Root | undefined;
let container: HTMLDivElement | undefined;
let requests: { path: string; method: string; data?: unknown }[] = [];
let approvals: unknown[] = [];
let attentionItems: unknown[] = [];
let availableSessions = [session];
let events: unknown[] = [];

function mockedFetch(path: string | URL | Request, options?: RequestInit): Promise<Response> {
  const uri = typeof path === 'string' ? path : path instanceof URL ? path.toString() : path.url;
  const method = options?.method || 'GET';
  const data = options?.body && typeof options.body === 'string' ? JSON.parse(options.body) : undefined;
  requests.push({ path: uri, method, data });
  if (uri.endsWith('/api/health')) return Promise.resolve(returnJson({ok:true,protocol:'ACP v1',mode:'local-development'}));
  if (uri.endsWith('/api/adapters')) return Promise.resolve(returnJson([{id:'mock',label:'ACP mock'}]));
  if (uri.endsWith('/api/attention')) return Promise.resolve(returnJson(attentionItems));
  if (uri.endsWith('/reviewed') && method === 'POST') {
    // Like the runtime: a reviewed result is no longer derived.
    attentionItems=attentionItems.filter(item=>`/api/attention/${encodeURIComponent((item as {id:string}).id)}/reviewed`!==uri);
    return Promise.resolve(returnJson({ok:true}));
  }
  if (uri.endsWith('/api/workspaces')) return Promise.resolve(returnJson([{path:'/mock/project'}]));
  if (uri.endsWith('/api/worktrees') && method === 'GET') return Promise.resolve(returnJson([]));
  if (uri.endsWith('/api/worktrees') && method === 'POST') return Promise.resolve(returnJson({id:'wt1',source_repo:'/mock/project',path:'/mock/project/.local/worktrees/wt1',branch:'agentdock/task-123456789abc',created_at:new Date().toISOString(),exists:true,state:'ready',available:true},201));
  if (uri === '/api/sessions' && method === 'GET') return Promise.resolve(returnJson(availableSessions));
  if (uri.includes('/events')) return Promise.resolve(returnJson(events));
  if (uri.includes('/approvals') && method === 'GET') return Promise.resolve(returnJson(approvals));
  if (uri.includes('/approvals/') && method === 'POST') return Promise.resolve(returnJson({ok:true}));
  if (uri.includes('/prompt') && method === 'POST') return Promise.resolve(returnJson({accepted:true},202));
  if (uri.includes('/git/status')) return Promise.resolve(returnJson({cwd:session.cwd,status:'## main'}));
  if (uri.includes('/git/diff')) return Promise.resolve(returnJson({cwd:session.cwd,diff:''}));
  return Promise.resolve(returnJson({ok:true}));
}

async function render(settings = structuredClone(DEFAULT_SETTINGS)) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async()=>{root!.render(<LanguageProvider locale="zh-TW"><LiveWorkspace settings={settings} onBack={()=>{}} /></LanguageProvider>);await Promise.resolve();});
  return container;
}
beforeEach(() => {
  requests=[];
  approvals=[];
  attentionItems=[];
  availableSessions=[session];
  events=[];
  vi.stubGlobal('fetch', vi.fn(mockedFetch));
});
afterEach(() => {
  act(()=>root?.unmount());
  root=undefined;
  container?.remove();
  container=undefined;
  vi.unstubAllGlobals();
});

describe('real ACP frontend integration (API contract mocked)', () => {
  it('loads real session metadata rather than any demo messages', async () => {
    const ui=await render();
    expect(ui.textContent).toContain('即時 ACP');
    expect(ui.textContent).toContain('mock');
    expect(ui.textContent).not.toContain('Simulated file changes');
    expect(requests.some(r=>r.path==='/api/sessions')).toBe(true);
  });

  it('sends a best-effort language hint without claiming system prompt replacement', async () => {
    const ui=await render();
    const input = ui.querySelector<HTMLTextAreaElement>('textarea[aria-label="傳給真實 ACP Agent 的 Prompt"]')!;
    expect(input).not.toBeNull();
    await act(async()=>{
      const nativeSetter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!;
      nativeSetter.call(input,'Explain the code');
      input.dispatchEvent(new Event('input',{bubbles:true}));
    });
    expect(input.value).toBe('Explain the code');
    const button=[...ui.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()==='傳送 Prompt')!;
    await act(async()=>button.click());
    const sent=requests.find(r=>r.path.endsWith('/prompt')&&r.method==='POST');
    expect(sent).toBeDefined();
    expect((sent?.data as {text:string}).text).toContain('繁體中文');
    expect((sent?.data as {text:string}).text).toContain('Explain the code');
    expect(ui.textContent).toContain('盡力遵循');
  });

  const other = {...session, id:'33333333-3333-4333-8333-333333333333', adapter:'octomind', cwd:'/mock/other'};
  const replyItem = (sessionRef = other) => ({id:'approval:44444444-4444-4444-8444-444444444444',sessionId:sessionRef.id,
    adapter:sessionRef.adapter,cwd:sessionRef.cwd,status:'awaiting_approval',type:'reply',key:'approval_pending',
    updatedAt:sessionRef.updated_at,evidenceCursor:2,approvalId:'44444444-4444-4444-8444-444444444444'});
  const reviewItem = (sessionRef = other) => ({id:`attention:${sessionRef.id}:review:7`,sessionId:sessionRef.id,
    adapter:sessionRef.adapter,cwd:sessionRef.cwd,status:'failed',type:'review',key:'agent_failed',
    updatedAt:sessionRef.updated_at,evidenceCursor:7});
  const backgroundItem = (sessionRef = other) => ({id:`attention:${sessionRef.id}:background`,sessionId:sessionRef.id,
    adapter:sessionRef.adapter,cwd:sessionRef.cwd,status:'running',type:'background',key:'agent_running',
    updatedAt:sessionRef.updated_at,evidenceCursor:3});
  const bell = (ui: HTMLElement) => ui.querySelector<HTMLButtonElement>('button.live-attention-bell');

  it('shows needs-reply prominently, counts reply + review only, and routes to the approvals of that session', async () => {
    availableSessions=[session,other];
    const third = {...other, id:'55555555-5555-4555-8555-555555555555', adapter:'claude'};
    attentionItems=[replyItem(), reviewItem(third), backgroundItem(third)];
    const ui=await render();
    expect(bell(ui)?.getAttribute('aria-label')).toBe('Session Sentinel：1 項需要回覆、1 項待查看、1 項背景執行');
    expect(bell(ui)?.classList.contains('needs-reply')).toBe(true);
    expect(ui.querySelector('.live-attention-count.reply')?.textContent).toBe('!2');
    act(()=>bell(ui)?.click());
    const dialog = ui.querySelector<HTMLElement>('[role="dialog"][aria-label="跨 Session 決策收件匣"]');
    const titles=[...ui.querySelectorAll('.live-attention-section-title')].map(node=>node.textContent);
    expect(titles).toEqual(['需要你回覆 1','新結果待查看 1','背景執行中 1']);
    // Opening focuses the first row (the needs-reply one), never a section action.
    expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^需要批准: octomind · other\./);
    // Approve/deny is not offered in the inbox, and a reply row cannot be marked reviewed.
    expect(dialog?.querySelectorAll('.live-attention-reply .live-attention-reviewed').length).toBe(0);
    expect(dialog?.textContent).not.toMatch(/批准一次|Allow/);
    await act(async()=>(document.activeElement as HTMLButtonElement).click());
    expect(ui.querySelector('[role="dialog"][aria-label="跨 Session 決策收件匣"]')).toBeNull();
    expect(ui.textContent).toContain('octomind · 33333333');
  });

  it('only results can be marked reviewed; marking never sends an ACP approval action', async () => {
    availableSessions=[session,other];
    attentionItems=[reviewItem()];
    const ui=await render();
    expect(bell(ui)?.getAttribute('aria-label')).toBe('Session Sentinel：0 項需要回覆、1 項待查看、0 項背景執行');
    expect(ui.querySelector('.live-attention-count')?.textContent).toBe('1');
    expect(ui.querySelector('.live-attention-count.reply')).toBeNull();
    act(()=>bell(ui)?.click());
    const mark=ui.querySelector<HTMLButtonElement>('button[aria-label="標記為已查看：octomind · other"]');
    expect(mark).not.toBeNull();
    await act(async()=>mark?.click());
    expect(requests.some(r=>r.path===`/api/attention/${encodeURIComponent(reviewItem().id)}/reviewed`&&r.method==='POST')).toBe(true);
    expect(requests.some(r=>r.path.includes('/approvals/')&&r.method==='POST')).toBe(false);
    expect(ui.textContent).toContain('目前沒有需要你處理的事');
  });

  it('creates a worktree only after explicit user click, then permits starting ACP in that path', async () => {
    const ui=await render();
    expect(requests.some(r=>r.path==='/api/worktrees' && r.method==='POST')).toBe(false);
    const button=[...ui.querySelectorAll<HTMLButtonElement>('button')]
      .find(b=>b.textContent?.includes('建立獨立 Git Worktree'));
    expect(button).not.toBeNull();
    await act(async()=>button?.click());
    const creation=requests.find(r=>r.path==='/api/worktrees' && r.method==='POST');
    expect(creation).toBeDefined();
    expect(creation?.data).toEqual({repoPath:'/mock/project', idempotencyKey: expect.stringMatching(/^[a-f0-9-]{36}$/)});
    expect(ui.textContent).toContain('已建立獨立 Worktree');
    // Creating a worktree must not automatically execute an agent prompt.
    expect(requests.some(r=>r.path.includes('/prompt')&&r.method==='POST')).toBe(false);
  });

  it('keeps keyboard focus inside the inbox after acknowledging a row and wraps Tab', async () => {
    availableSessions = [session, other];
    attentionItems = [reviewItem()];
    const ui = await render();
    act(() => bell(ui)?.click());
    const dialog = ui.querySelector<HTMLElement>('.live-attention-inbox')!;
    const close = dialog.querySelector<HTMLButtonElement>('header button')!;
    const mark = dialog.querySelector<HTMLButtonElement>('.live-attention-reviewed')!;
    const row = dialog.querySelector<HTMLButtonElement>('.live-attention-main')!;
    act(() => {
      mark.focus();
      mark.dispatchEvent(new KeyboardEvent('keydown', { key:'Tab', bubbles:true }));
    });
    expect(document.activeElement).toBe(close);
    act(() => {
      close.dispatchEvent(new KeyboardEvent('keydown', { key:'Tab', shiftKey:true, bubbles:true }));
    });
    expect(document.activeElement).toBe(mark);
    expect(row).toBeTruthy();
    act(() => mark.focus());
    await act(async () => { mark.click(); await Promise.resolve(); });
    expect(ui.querySelector('.live-attention-reviewed')).toBeNull();
    expect(document.activeElement).toBe(close);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('the session on screen is not listed unless it needs a reply', async () => {
    attentionItems=[reviewItem(session), backgroundItem(session), replyItem(session)];
    const ui=await render();
    expect(bell(ui)?.getAttribute('aria-label')).toBe('Session Sentinel：1 項需要回覆、0 項待查看、0 項背景執行');
    act(()=>bell(ui)?.click());
    const titles=[...ui.querySelectorAll('.live-attention-section-title')].map(node=>node.textContent);
    expect(titles).toEqual(['需要你回覆 1']);
  });

  it('records "viewed" for the on-screen session only while the window has focus', async () => {
    events=[{seq:5,sessionId,kind:'turn_finished',data:{stopReason:'end_turn'},createdAt:new Date().toISOString()}];
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    try {
      await render();
      await act(async()=>{ await new Promise(r=>setTimeout(r,20)); });
      expect(requests.some(r=>r.path.endsWith('/viewed'))).toBe(false);
      focus.mockReturnValue(true);
      await act(async()=>{ await new Promise(r=>setTimeout(r,1500)); });
      const marks=requests.filter(r=>r.path===`/api/sessions/${sessionId}/viewed`&&r.method==='POST');
      expect(marks.length).toBe(1);
      expect(marks[0].data).toEqual({cursor:5});
    } finally { focus.mockRestore(); }
  }, 20_000);

  it('requires deliberate one-time approval and never auto-accepts tools', async () => {
    approvals=[{id:approvalId,session_id:sessionId,title:'Mock read-only access',status:'pending',
      choices:[{id:'allow-once',kind:'allow_once',name:'Allow Once'}],expires_at:new Date(Date.now()+60000).toISOString()}];
    const ui=await render();
    const button=[...ui.querySelectorAll<HTMLButtonElement>('.live-tabs button')].find(b=>b.textContent?.includes('Approvals'));
    await act(async()=>button?.click());
    // Pending list will be fetched via polling: switch selected session to re-sync quickly.
    expect(requests.some(r=>r.path.includes('/approvals'))).toBe(true);
    // Rendered approvals may arrive after the first sync, but no approval API call may happen without a click.
    expect(requests.some(r=>r.method==='POST'&&r.path.includes('/approvals/'))).toBe(false);
  });

  it('shows what is being approved and sends only the decision the user clicked', async () => {
    approvals=[{id:approvalId,session_id:sessionId,title:'Run a command',status:'pending',
      detail:{kind:'execute',input:{command:'git push origin main',api_key:'[REDACTED]'},locations:['/mock/project']},
      choices:[{id:'allow-once',kind:'allow_once',name:'Allow Once'},{id:'always',kind:'allow_always',name:'Always'}],
      expires_at:new Date(Date.now()+60000).toISOString()}];
    const ui=await render();
    const tab=[...ui.querySelectorAll<HTMLButtonElement>('.live-tabs button')].find(b=>b.textContent?.includes('待批准事項'))!;
    expect(tab).toBeDefined();
    await act(async()=>{tab.click();await Promise.resolve();});
    const card=ui.querySelector('.live-approval')!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('Run a command');
    expect(card.textContent).toContain('execute');
    expect(card.textContent).toContain('git push origin main');
    expect(card.textContent).toContain('/mock/project');
    // Only deny and allow-once exist: the page offers no way to pick allow_always.
    const labels=[...card.querySelectorAll('button')].map(b=>b.textContent?.trim());
    expect(labels).toEqual(['拒絕','僅允許一次']);
    expect(requests.some(r=>r.method==='POST'&&r.path.includes('/approvals/'))).toBe(false);
    const deny=[...card.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.includes('拒絕'))!;
    await act(async()=>{deny.click();await Promise.resolve();});
    const sent=requests.filter(r=>r.method==='POST'&&r.path.includes('/approvals/'));
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toContain(`/sessions/${sessionId}/approvals/${approvalId}`);
    expect(sent[0].data).toEqual({decision:'deny'});
  });
});
