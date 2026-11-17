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

function mockedFetch(path: string | URL | Request, options?: RequestInit): Promise<Response> {
  const uri = typeof path === 'string' ? path : path instanceof URL ? path.toString() : path.url;
  const method = options?.method || 'GET';
  const data = options?.body && typeof options.body === 'string' ? JSON.parse(options.body) : undefined;
  requests.push({ path: uri, method, data });
  if (uri.endsWith('/api/health')) return Promise.resolve(returnJson({ok:true,protocol:'ACP v1',mode:'local-development'}));
  if (uri.endsWith('/api/adapters')) return Promise.resolve(returnJson([{id:'mock',label:'ACP mock'}]));
  if (uri.endsWith('/api/attention')) return Promise.resolve(returnJson(attentionItems));
  if (uri.endsWith('/api/workspaces')) return Promise.resolve(returnJson([{path:'/mock/project'}]));
  if (uri === '/api/sessions' && method === 'GET') return Promise.resolve(returnJson(availableSessions));
  if (uri.includes('/events')) return Promise.resolve(returnJson([]));
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

  it('renders real event-based attention and routes a decision to the matching session', async () => {
    const other = {...session, id:'33333333-3333-4333-8333-333333333333', adapter:'octomind'};
    availableSessions=[session,other];
    attentionItems=[{id:'approval:44444444-4444-4444-8444-444444444444',sessionId:other.id,
      adapter:'octomind',cwd:other.cwd,status:'awaiting_approval',type:'decision',key:'approval_pending',
      updatedAt:other.updated_at,evidenceCursor:2,approvalId:'44444444-4444-4444-8444-444444444444'}];
    const ui=await render();
    const bell=ui.querySelector<HTMLButtonElement>('button[aria-label^="Session Sentinel：1 項待處理"]');
    expect(bell).not.toBeNull();
    act(()=>bell?.click());
    expect(ui.textContent).toContain('Agent 正在等待你批准一項 ACP 工具操作');
    const jump=ui.querySelector<HTMLButtonElement>('button[aria-label^="octomind: Agent 正在等待"]');
    await act(async()=>jump?.click());
    expect(ui.querySelector('[role="dialog"][aria-label="跨 Session 決策收件匣"]')).toBeNull();
    expect(ui.textContent).toContain('octomind · 33333333');
  });

  it('dismissing a notification does not approve or deny the underlying ACP tool request', async () => {
    attentionItems=[{id:'approval:44444444-4444-4444-8444-444444444444',sessionId:sessionId,
      adapter:'mock',cwd:session.cwd,status:'awaiting_approval',type:'decision',key:'approval_pending',
      updatedAt:session.updated_at,evidenceCursor:2,approvalId:'44444444-4444-4444-8444-444444444444'}];
    const ui=await render();
    act(()=>ui.querySelector<HTMLButtonElement>('button[aria-label^="Session Sentinel：1 項待處理"]')?.click());
    const dismiss=ui.querySelector<HTMLButtonElement>('button[aria-label="忽略此提醒（不代表批准）"]');
    expect(dismiss).not.toBeNull();
    await act(async()=>dismiss?.click());
    expect(requests.some(r=>r.path.includes('/attention/')&&r.path.endsWith('/dismiss')&&r.method==='POST')).toBe(true);
    expect(requests.some(r=>r.path.includes('/approvals/')&&r.method==='POST')).toBe(false);
    expect(ui.textContent).toContain('目前沒有待處理事件');
  });

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
});
