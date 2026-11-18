import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, Bell, BellRing, Check, CircleDot, FileDiff,
  FolderGit2, Loader2, LockKeyhole, Play, ShieldCheck, Square, Terminal,
  X, XCircle,
} from 'lucide-react';
import {
  cancelRuntimePrompt, closeRuntimeSession, createRuntimeSession, createWorktree, decideRuntimeApproval, getAttention, markAttentionReviewed, markSessionViewed,
  getAdapters, getApprovals, getEvents, getHealth, getSessions, getWorkspaces, getWorktrees, getGithubIssues, getGithubPulls, getGithubChecks,
  gitDiff, gitStatus, sendRuntimePrompt,
  type RuntimeAdapter, type RuntimeApproval, type RuntimeEvent, type RuntimeSession,
  type RuntimeWorkspace, type RuntimeWorktree, type LiveAttentionItem, type GithubIssue, type GithubPull, type GithubChecksEvidence,
} from '../live/api';
import { compileLanguageOverlay, type LanguageSettings } from '../i18n/language';
import { useLocale } from '../i18n/context';
import { LiveAttentionInbox } from './LiveAttentionInbox';

const REFRESH_MS = 1300;
const RUNTIME_STATES: Record<string, { label: string; color: string }> = {
  ready: { label: 'Ready', color: '#a5cf9c' },
  running: { label: 'Running', color: '#a0c7ef' },
  starting: { label: 'Connecting', color: '#c0b2e5' },
  awaiting_approval: { label: 'Decision needed', color: '#edc68f' },
  interrupted: { label: 'Interrupted', color: '#dfb98c' },
  failed: { label: 'Failed', color: '#e3a7a4' },
  closed: { label: 'Closed', color: '#9ba8a0' },
};

function historyText(event: RuntimeEvent, zh: boolean): string {
  switch (event.kind) {
    case 'user_message': return event.data.text || '';
    case 'agent_update': {
      const update = event.data.update;
      if (update?.sessionUpdate === 'agent_message_chunk') {
        return update.content?.type === 'text' ? update.content.text || '' : '[non-text content]';
      }
      if (update?.sessionUpdate === 'tool_call') return `${zh ? '工具' : 'Tool'}: ${update.title || 'tool'} [${update.status || 'pending'}]`;
      if (update?.sessionUpdate === 'tool_call_update') return `${zh ? '工具狀態' : 'Tool updated'}: ${update.status || 'unknown'}`;
      return `${zh ? 'Agent 事件' : 'Agent event'}: ${update?.sessionUpdate || 'unknown'}`;
    }
    case 'approval_requested': return `${zh ? '需要工具權限' : 'Permission required'}: ${event.data.title || 'tool'}`;
    case 'approval_resolved': return `${zh ? '權限決策' : 'Permission'}: ${event.data.decision || 'resolved'}`;
    case 'turn_finished': return `${zh ? '回合結束' : 'Turn completed'}: ${event.data.stopReason || 'unknown'}`;
    case 'connected': return zh ? '已建立 ACP v1 連線' : 'ACP v1 connection established';
    case 'process_exit': return zh ? 'Agent 程序已停止；仍可查看歷史事件。' : 'Agent process stopped. Historical events are still available.';
    case 'error': return `${zh ? '錯誤' : 'Error'}: ${event.data.message || event.data.code || 'unknown'}`;
    default: return event.kind;
  }
}

/** Real ACP v1 session console. No pretend SDK/inference results are generated client-side. */
export function LiveWorkspace({ settings, onBack }: {
  settings: LanguageSettings;
  onBack: () => void;
}) {
  const zh = useLocale() === 'zh-TW';
  const ui = (chinese: string, english: string) => zh ? chinese : english;
  const [health, setHealth] = useState<'loading' | 'online' | 'offline'>('loading');
  const [sessions, setSessions] = useState<RuntimeSession[]>([]);
  const [adapters, setAdapters] = useState<RuntimeAdapter[]>([]);
  const [roots, setRoots] = useState<RuntimeWorkspace[]>([]);
  const [worktrees, setWorktrees] = useState<RuntimeWorktree[]>([]);
  const [worktreeNotice, setWorktreeNotice] = useState('');
  const [adapter, setAdapter] = useState('mock');
  const [cwd, setCwd] = useState('');
  const [activeId, setActiveId] = useState('');
  const [history, setHistory] = useState<RuntimeEvent[]>([]);
  const [approvals, setApprovals] = useState<RuntimeApproval[]>([]);
  const [attention, setAttention] = useState<LiveAttentionItem[]>([]);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const attentionRef = useRef<HTMLButtonElement>(null);
  // "Mark reviewed" bumps this after the runtime confirmed it, so a poll that
  // started before the write landed cannot put the old row back on screen.
  const attentionEpoch = useRef(0);
  const viewedMark = useRef('');
  const closeAttention = useCallback((restoreFocus = true) => {
    setAttentionOpen(false);
    if (restoreFocus) attentionRef.current?.focus();
  }, []);
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [gitEvidence, setGitEvidence] = useState<{ status?: string; diff?: string }>({});
  const [inspectorTab, setInspectorTab] = useState<'activity' | 'git' | 'approvals' | 'github'>('activity');
  const [githubRepo, setGithubRepo] = useState('');
  const [issues, setIssues] = useState<GithubIssue[]>([]);
  const [pulls, setPulls] = useState<GithubPull[]>([]);
  const [githubTruncated, setGithubTruncated] = useState(false);
  const [checks, setChecks] = useState<(GithubChecksEvidence & { pr: number }) | null>(null);
  const [githubLoading, setGithubLoading] = useState(false);
  // Bumped on session switch so a slow GitHub response cannot land in another session's panel.
  const githubRequest = useRef(0);
  const latest = useRef(0);
  const active = sessions.find(item => item.id === activeId);
  // UX rule 3: the session on screen is not listed, except when it needs a reply
  // (the approval card may be scrolled away and the agent is blocked).
  const visibleAttention = attention.filter(item => item.type === 'reply' || item.sessionId !== activeId);
  const replyCount = visibleAttention.filter(item => item.type === 'reply').length;
  const reviewCount = visibleAttention.filter(item => item.type === 'review').length;
  const backgroundCount = visibleAttention.filter(item => item.type === 'background').length;
  const attentionCount = replyCount + reviewCount;
  const badgeText = attentionCount > 99 ? '99+' : String(attentionCount);
  const effective = active
    ? compileLanguageOverlay(settings, 'conversation', { projectId: active.cwd, sessionId: active.id })
    : compileLanguageOverlay(settings, 'conversation');

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      try {
        await getHealth();
        const [available, paths, existing, isolated] = await Promise.all([getAdapters(), getWorkspaces(), getSessions(), getWorktrees()]);
        if (cancelled) return;
        setHealth('online');
        setAdapters(available);
        setRoots(paths);
        setWorktrees(isolated);
        if (paths.length) setCwd(paths[0].path);
        setSessions(existing);
        if (existing.length) setActiveId(existing[0].id);
      } catch {
        if (!cancelled) setHealth('offline');
      }
    };
    void initialize();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (health !== 'online') return;
    let cancelled = false;
    let running = false;
    const sync = async () => {
      if (running || cancelled) return;
      running = true;
      try {
        const epoch = attentionEpoch.current;
        const [current, alerts] = await Promise.all([getSessions(), getAttention()]);
        if (!cancelled) {
          setSessions(current);
          if (epoch === attentionEpoch.current) setAttention(alerts);
        }
        if (!activeId) return;
        const [events, pending] = await Promise.all([getEvents(activeId, latest.current), getApprovals(activeId)]);
        if (!cancelled) {
          if (events.length) {
            latest.current = Math.max(latest.current, ...events.map(event => event.seq));
            setHistory(old => [...old, ...events].slice(-600));
          }
          setApprovals(pending);
          // "Viewed" (UX section 4): on screen while the window has focus, up
          // to the newest event rendered. Persisted by the runtime; it never
          // answers an approval or changes the session.
          const status = current.find(item => item.id === activeId)?.status ?? '';
          const mark = `${activeId}:${latest.current}:${status}`;
          if (latest.current > 0 && mark !== viewedMark.current
              && document.visibilityState === 'visible' && document.hasFocus()) {
            viewedMark.current = mark;
            try { await markSessionViewed(activeId, latest.current); }
            catch { viewedMark.current = ''; } // retried on the next poll
          }
        }
      } catch {
        if (!cancelled) setError('Lost connection to the local ACP runtime.');
      } finally { running = false; }
    };
    void sync();
    const interval = window.setInterval(() => { void sync(); }, REFRESH_MS);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [health, activeId]);

  function openAttentionSession(item: LiveAttentionItem) {
    selectSession(item.sessionId);
    setInspectorTab(item.type === 'reply' ? 'approvals' : 'activity');
    closeAttention();
  }
  async function markReviewed(item: LiveAttentionItem) {
    try {
      await markAttentionReviewed(item.id);
      attentionEpoch.current += 1;
      setAttention(old=>old.filter(alert=>alert.id!==item.id));
    } catch(e) { setError(String((e as Error).message)); }
  }

  function selectSession(id: string) {
    setActiveId(id);
    latest.current = 0;
    setHistory([]);
    setApprovals([]);
    setGitEvidence({});
    githubRequest.current += 1;
    setGithubRepo('');
    setIssues([]);
    setPulls([]);
    setGithubTruncated(false);
    setChecks(null);
    setGithubLoading(false);
    setError('');
  }

  async function newWorktree() {
    // Only an explicit click creates a Git branch/worktree. No cleanup or push.
    if (!cwd || submitting || worktrees.some(w => w.path === cwd)) return;
    setSubmitting(true);
    setError('');
    setWorktreeNotice('');
    try {
      const item = await createWorktree(cwd);
      const [paths, isolated] = await Promise.all([getWorkspaces(), getWorktrees()]);
      setRoots(paths);
      setWorktrees(isolated);
      setCwd(item.path);
      setWorktreeNotice(ui(`已建立獨立 Worktree：${item.branch}，原始分支未修改。`,`New isolated worktree: ${item.branch}. Source branch unchanged.`));
    } catch (e) { setError(String((e as Error).message)); }
    finally { setSubmitting(false); }
  }

  async function startSession() {
    if (!cwd || !adapter || submitting) return;
    setSubmitting(true);setError('');
    try {
      const created = await createRuntimeSession(adapter, cwd);
      setSessions(current => [created, ...current]);
      selectSession(created.id);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setSubmitting(false); }
  }

  async function submit() {
    if (!active || !prompt.trim() || submitting || ['closed', 'interrupted', 'failed', 'awaiting_approval', 'running'].includes(active.status)) return;
    setSubmitting(true);setError('');
    try {
      // This is a best-effort user-turn instruction, not an unadvertised system prompt override.
      const text = effective.instruction
        ? `[Output language preference (best effort; preserve safety and Skill instructions)]\n${effective.instruction}\n\n${prompt.trim()}`
        : prompt.trim();
      await sendRuntimePrompt(active.id, text);
      setPrompt('');
    } catch(e) { setError(String((e as Error).message)); }
    finally { setSubmitting(false); }
  }

  async function approve(approval: RuntimeApproval, decision: 'allow_once' | 'deny') {
    if (!active) return;
    setError('');
    try {
      await decideRuntimeApproval(active.id, approval.id, decision);
      setApprovals(old => old.filter(item => item.id !== approval.id));
    } catch(e) { setError(String((e as Error).message)); }
  }

  async function inspectGit() {
    if (!active) return;
    setError('');
    try {
      const [status, diff] = await Promise.all([gitStatus(active.cwd), gitDiff(active.cwd)]);
      setGitEvidence({ status: status.status, diff: diff.diff });
      setInspectorTab('git');
    } catch(e) { setError(String((e as Error).message)); }
  }

  async function inspectGithub() {
    setInspectorTab('github');
    if (!active || githubLoading) return;
    const request = ++githubRequest.current;
    setGithubLoading(true);
    setError('');
    try {
      const [foundIssues, foundPulls] = await Promise.all([getGithubIssues(active.cwd), getGithubPulls(active.cwd)]);
      if (request !== githubRequest.current) return;
      setGithubRepo(foundIssues.repo);
      setIssues(foundIssues.items);
      setPulls(foundPulls.items);
      setGithubTruncated(foundIssues.truncated || foundPulls.truncated);
      setChecks(null);
    } catch(e) { if (request === githubRequest.current) setError(String((e as Error).message)); }
    finally { if (request === githubRequest.current) setGithubLoading(false); }
  }
  async function inspectChecks(pr: GithubPull) {
    if (!active || githubLoading) return;
    const request = ++githubRequest.current;
    setGithubLoading(true);
    setError('');
    try {
      const evidence = await getGithubChecks(active.cwd, pr.headSha);
      if (request !== githubRequest.current) return;
      setChecks({ ...evidence, pr: pr.number });
    } catch(e) { if (request === githubRequest.current) setError(String((e as Error).message)); }
    finally { if (request === githubRequest.current) setGithubLoading(false); }
  }

  async function cancel() {
    if (!active) return;
    try { await cancelRuntimePrompt(active.id); }
    catch(e) { setError(String((e as Error).message)); }
  }

  async function closeSession() {
    if (!active || active.status === 'closed' || active.status === 'interrupted') return;
    // A deliberate user action; never close another session automatically.
    try { await closeRuntimeSession(active.id); }
    catch(e) { setError(String((e as Error).message)); }
  }

  const timeline = useMemo(() => history.map(event => ({
    ...event, label: historyText(event, zh),
  })), [history, zh]);
  const badge = active ? RUNTIME_STATES[active.status] ?? RUNTIME_STATES.failed : undefined;

  return <div className="live-workspace">
    <aside className="live-sidebar">
      <header><button type="button" onClick={onBack} className="live-back">← {ui("返回展示工作區", "Demo workspace")}</button><strong><Activity size={17}/> {ui("即時 ACP", "Live ACP")}</strong><span className="live-connection"><CircleDot size={12}/> {health === "online" ? ui("已連線","Online") : health === "offline" ? ui("未連線","Offline") : ui("連線中","Connecting")}</span>{health === "online" && <div className="live-attention-anchor"><button ref={attentionRef} className={`live-attention-bell${replyCount>0?" needs-reply":""}`} aria-label={ui(
          `Session Sentinel：${replyCount} 項需要回覆、${reviewCount} 項待查看、${backgroundCount} 項背景執行`,
          `Session Sentinel: ${replyCount} need reply, ${reviewCount} to review, ${backgroundCount} running in background`)} aria-expanded={attentionOpen} onClick={()=>setAttentionOpen(v=>!v)}>{replyCount>0 ? <BellRing size={17}/> : <Bell size={17}/>}{ui("決策通知","Decision inbox")}{replyCount>0
          ? <span className="live-attention-count reply" aria-hidden="true">!{badgeText}</span>
          : attentionCount>0 && <span className="live-attention-count" aria-hidden="true">{badgeText}</span>}</button>{attentionOpen && <LiveAttentionInbox items={visibleAttention} onSelect={openAttentionSession} onMarkReviewed={item=>void markReviewed(item)} onClose={closeAttention}/>}</div>}</header>
      {health === 'online' && <>
        <div className="live-setup">
          <div className="live-side-heading">{ui("建立工作階段","START A SESSION")}</div>
          <label htmlFor="live-root">{ui("已核准的工作目錄","Approved workspace")}</label>
          <select id="live-root" value={cwd} onChange={e=>{setCwd(e.target.value);setWorktreeNotice("");}}>{roots.map(item=><option key={item.path} value={item.path}>{worktrees.some(w=>w.path===item.path) ? `[Worktree] ${item.path}` : item.path}</option>)}</select>
          <button className="live-worktree-create" type="button" onClick={()=>void newWorktree()} disabled={!cwd || submitting || worktrees.some(w => w.path === cwd)}><FolderGit2 size={14}/>{ui("建立獨立 Git Worktree（新分支）","Create isolated Git worktree (new branch)")}</button>
          {worktreeNotice && <div className="live-worktree-notice" role="status">{worktreeNotice}</div>}
          <label htmlFor="live-adapter">{ui("已設定的 ACP Agent","Configured ACP agent")}</label>
          <select id="live-adapter" value={adapter} onChange={e=>setAdapter(e.target.value)}>{adapters.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}</select>
          <button onClick={()=>void startSession()} disabled={!cwd || submitting} className="live-primary"><Play size={14}/> {ui("啟動 ACP 工作階段","Start ACP session")}</button>
        </div>
        <div className="live-side-heading live-session-heading">{ui("工作階段 · 真實程序／歷史紀錄","SESSIONS · REAL PROCESS / SAVED HISTORY")}</div>
        <div className="live-session-list">{sessions.map(s=><button key={s.id} className={`live-session ${s.id===activeId?'selected':''}`} onClick={()=>selectSession(s.id)}>
          <span>{s.adapter} · {s.id.slice(0,8)}</span><small>{s.status} · {s.cwd.split(/[\\/]/).at(-1)}</small>
        </button>)}</div>
      </>}
      <footer>ACP SDK v1 · {ui("本機執行環境","local-only runtime")}</footer>
    </aside>
    <div className="live-main">
      {health === 'loading' && <div className="live-empty"><Loader2 size={26}/><h2>{ui("正在連接本機 Runtime…","Connecting to local runtime…")}</h2></div>}
      {health === 'offline' && <div className="live-empty"><AlertTriangle size={29}/><h2>{ui("本機 ACP Runtime 尚未連接","Local ACP runtime not connected")}</h2><p>{ui("請在專案目錄執行","Start it with")} <code>npm run dev:full</code>{ui("，再重新開啟此頁面。"," in the project folder, then reopen this view.")}</p><p>{ui("不會自動啟動公開伺服器或外部付費模型。","No public server or external model is started automatically.")}</p><button onClick={onBack}>{ui("返回展示介面","Return to demo")}</button></div>}
      {health === 'online' && !active && <div className="live-empty"><Terminal size={30}/><h2>{ui("啟動真正的 ACP 工作階段","Start a real ACP session")}</h2><p>{ui("選擇已核准的工作目錄與已安裝的 Adapter。內建 Mock 使用官方 ACP 協定，不消耗模型額度。","Choose an approved workspace and an installed adapter. The built-in mock uses the official ACP protocol without a paid model.")}</p></div>}
      {health === 'online' && active && <>
        <div className="live-main-header"><div><h2><Terminal size={20}/> {active.adapter} · {active.id.slice(0,8)}</h2><span className="live-agent-badge" style={{ color: badge?.color }}>{badge?.label}</span><span className="live-cwd">{active.cwd}</span></div><div className="live-actions"><button title={ui("重新讀取 Git 狀態與差異","Refresh Git status and diff")} onClick={()=>void inspectGit()}><FileDiff size={16}/> Git</button><button onClick={()=>void cancel()} disabled={active.status !== 'running' && active.status !== 'awaiting_approval'}><Square size={14}/> {ui("取消","Cancel")}</button><button onClick={()=>void closeSession()} disabled={active.status==='closed'||active.status==='interrupted'}><X size={15}/> {ui("關閉工作階段","Close")}</button></div></div>
        <div className="live-notice"><ShieldCheck size={15}/> {ui("真實 ACP 工作階段 · 語言偏好","Real ACP session · Language")}: {effective.locale} ({ui("盡力遵循","best effort")}). {ui("此 Host 只能控制 ACP 傳回的審批請求，不能攔截外部 Harness 內部的隱藏工具。","This host only approves ACP permission requests, not hidden tool execution inside an external harness.")}</div>
        <div className="live-tabs"><button className={inspectorTab==='activity'?'active':''} onClick={()=>setInspectorTab('activity')}>{ui("工作階段事件","Session events")}</button><button className={inspectorTab==='approvals'?'active':''} onClick={()=>setInspectorTab('approvals')}>{ui("待批准事項","Approvals")} {approvals.length ? `(${approvals.length})` : ''}</button><button className={inspectorTab==='git'?'active':''} onClick={()=>{setInspectorTab('git');void inspectGit();}}>{ui("Git 證據","Git evidence")}</button><button className={inspectorTab==='github'?'active':''} onClick={()=>void inspectGithub()}>{ui("GitHub（唯讀）","GitHub (read only)")}</button></div>
        {inspectorTab==='activity' && <div className="live-history" aria-label="Real ACP events">{timeline.map(e=><div key={e.seq} className={`live-event live-event-${e.kind}`}><small>#{e.seq} · {e.kind} · {new Date(e.createdAt).toLocaleTimeString()}</small><p>{e.label}</p></div>)}{timeline.length===0 && <p className="live-no-events">{ui("已連線，等待你傳送第一段 Prompt。","Connected. Waiting for your first prompt.")}</p>}</div>}
        {inspectorTab==='approvals' && <div className="live-history">{approvals.length===0 && <p className="live-no-events">{ui("目前沒有待處理的 ACP 權限請求。","No pending ACP permission requests.")}</p>}{approvals.map(p=><section key={p.id} className="live-approval"><h3><LockKeyhole size={18}/> {ui("需要權限批准","Approval requested")}</h3><p>{p.title}</p><small>{ui("到期時間","Expires")}: {new Date(p.expires_at).toLocaleString()}</small><div><button onClick={()=>void approve(p,'deny')}><XCircle size={15}/> {ui("拒絕","Deny")}</button><button className="live-allow" onClick={()=>void approve(p,'allow_once')} disabled={!p.choices.some(o=>o.kind==='allow_once')}><Check size={15}/> {ui("僅允許一次","Allow once")}</button></div></section>)}</div>}
        {inspectorTab==='git' && <div className="live-history"><div className="live-code-title"><FolderGit2 size={15}/> {ui("Git 狀態（唯讀）","Git status (read-only)")}</div><pre>{gitEvidence.status ?? ui("尚未讀取 Git 狀態。","No Git status loaded.")}</pre><div className="live-code-title"><FileDiff size={15}/> {ui("工作目錄差異（唯讀）","Working tree diff (read-only)")}</div><pre>{gitEvidence.diff ?? ui("尚未讀取 Git 差異。","No Git diff loaded.")}</pre></div>}
        {inspectorTab==='github' && <div className="live-history live-github-evidence">
          <div className="live-github-header"><strong>{githubRepo || ui('GitHub Repo','GitHub repo')}</strong><button className="live-github-refresh" disabled={githubLoading} onClick={()=>void inspectGithub()}>{githubLoading?ui('讀取中…','Loading…'):ui('重新讀取','Refresh')}</button></div>
          <p className="live-github-warning">{ui('資料來自已登入的 GitHub CLI。此介面只讀取資訊，不會建立 PR、推送或合併。','Data comes from your authenticated GitHub CLI. This panel is read-only and cannot create, push or merge PRs.')}{githubTruncated && <> {ui('只顯示前 30 筆，可能還有更多。','Only the first 30 results are shown; more may exist.')}</>}</p>
          <div className="live-github-section"><h3>{ui('開啟中的 Issues','Open Issues')} ({issues.length})</h3>{issues.length===0 && <p>{ui('沒有資料或尚未讀取。','No results or not loaded.')}</p>}{issues.map(item=><a key={item.number} href={item.url || undefined} target="_blank" rel="noreferrer noopener">#{item.number} · {item.title}</a>)}</div>
          <div className="live-github-section"><h3>{ui('開啟中的 PR','Open Pull Requests')} ({pulls.length})</h3>{pulls.length===0 && <p>{ui('沒有資料或尚未讀取。','No results or not loaded.')}</p>}{pulls.map(item=><div className="live-github-pull" key={item.number}><a href={item.url || undefined} target="_blank" rel="noreferrer noopener">#{item.number} · {item.title} ({item.state})</a><button disabled={githubLoading || !/^[a-f0-9]{40}$/.test(item.headSha)} onClick={()=>void inspectChecks(item)}>{ui('查看 CI Checks','View CI checks')}</button></div>)}</div>
          <div className="live-github-section"><h3>{ui('CI Checks','CI Checks')} ({checks ? checks.total : 0})</h3>{checks && <p className="live-github-sha">{ui('PR','PR')} #{checks.pr} · {ui('清單讀取時的 head','head when the list was read')} <code>{checks.sha.slice(0,12)}</code>{checks.truncated && <> · {ui('只顯示前 30 筆','first 30 shown')}</>}</p>}<p className="live-github-note">{ui('只含 GitHub Check Runs，不含舊式 Commit Status；重新推送後需重新讀取。','Check Runs only (legacy commit statuses are not included); re-read after new pushes.')}</p>{(!checks || checks.items.length===0) && <p>{ui('尚未讀取，或此 Commit 沒有 Checks；不代表通過。','No checks loaded or reported. This does not imply success.')}</p>}{checks?.items.map(c=><div key={c.id} className="live-github-check"><span>{c.name}: {c.status} / {c.conclusion??'unknown'}</span>{c.url && <a href={c.url} target="_blank" rel="noreferrer noopener">{ui('查看執行紀錄','View run')}</a>}</div>)}</div>
        </div>}
        <div className="live-composer"><textarea aria-label={ui("傳給真實 ACP Agent 的 Prompt","Prompt to real ACP agent")} placeholder={ui("輸入要交給 ACP Agent 的任務…","Prompt the selected ACP agent…")} rows={3} value={prompt} onChange={e=>setPrompt(e.target.value)} disabled={active.status!=='ready'}/><div className="live-compose-footer"><small>{active.supports_load ? ui('Agent 宣告支援載入 Session','Agent advertises session load') : ui('重啟後僅能讀取歷史；不能宣稱 Agent 已重新接上','Historical session only after restart; no claimed reattach')}</small><button onClick={()=>void submit()} disabled={!prompt.trim() || submitting || active.status!=='ready'}>{ui("傳送 Prompt","Send prompt")}</button></div></div>
      </>}
      {error && <div role="alert" className="live-error"><AlertTriangle size={14}/>{error}<button onClick={()=>setError('')} aria-label="Dismiss error"><X size={15}/></button></div>}
    </div>
  </div>;
}
