import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  ArrowUpRight, Bell, Bot, Check, CheckCheck,
  ChevronDown, ChevronRight, CircleAlert, CircleCheck, Clock3, Command, Cpu, FileCode2,
  FileDiff, FolderGit2, GitBranch, HardDrive, Layers3, Menu,
  MoreHorizontal, PanelRightClose, Plus, Search, Settings2, ShieldCheck, Sparkles,
  TerminalSquare, X,
} from 'lucide-react';
import { Composer } from './components/Composer';
import { ProgressRail } from './components/ProgressRail';
import { MonitorInbox } from './components/MonitorInbox';
import { SessionSwitcher } from './components/SessionSwitcher';
import { demoProjects, demoSessions, nextId } from './demo';
import { decisionCount, deriveMonitorItems, dismissKey, isHidden, type MonitorItem } from './monitor';
import type { AgentName, Project, Session, SessionStatus, TimelineEntry } from './model';

const statusLabel: Record<SessionStatus, string> = {
  idle: 'Idle', active: 'In progress', waiting: 'Needs review', complete: 'Completed',
};
const agentIcon: Record<AgentName, string> = {
  Codex: 'C', 'Claude Code': '✳', Octomind: 'O',
};

function Status({ status }: { status: SessionStatus }) {
  return <span className={`status status-${status}`}>
    {status === 'complete' ? <CircleCheck size={12} /> : status === 'waiting' ? <CircleAlert size={12} /> : <span className="status-dot" />}
    {statusLabel[status]}
  </span>;
}

function AgentMark({ agent }: { agent: AgentName }) {
  return <span className={`agent-mark agent-${agent === 'Codex' ? 'codex' : agent === 'Claude Code' ? 'claude' : 'octomind'}`}>{agentIcon[agent]}</span>;
}

function SessionSidebar({
  projects, sessions, activeProjectId, activeSessionId, onProject, onSession, onNew, collapsed, onCollapse,
}: {
  projects: Project[];
  sessions: Session[];
  activeProjectId: string;
  activeSessionId: string;
  onProject: (id: string) => void;
  onSession: (id: string) => void;
  onNew: () => void;
  collapsed: boolean;
  onCollapse: () => void;
}) {
  return (
    <aside className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <div className="side-heading">
        <div className="product-logo"><Layers3 size={19}/></div>
        {!collapsed && <span className="product-wordmark">agentdock<span className="logo-period">.</span></span>}
        <button className="icon-button side-toggle" onClick={onCollapse} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}><Menu size={18}/></button>
      </div>
      {!collapsed && <>
        <button type="button" className="workspace-selector" title="Local preview workspace" onClick={() => onProject(projects[0]!.id)}>
          <span className="workspace-icon"><HardDrive size={16}/></span>
          <span className="workspace-name"><strong>My workspace</strong><small>Local · Preview</small></span>
          <ChevronDown size={14}/>
        </button>
        <div className="side-section">
          <div className="section-label">PROJECTS <button disabled title="Git repository picker coming in Issue #5" aria-label="Add project unavailable"><Plus size={14}/></button></div>
          {projects.map(project => (
            <button
              key={project.id}
              className={`project-item ${project.id === activeProjectId ? 'project-active' : ''}`}
              onClick={() => onProject(project.id)}
              aria-current={project.id === activeProjectId ? 'page' : undefined}
            >
              <FolderGit2 size={16}/>
              <span>{project.name}</span>
              <ChevronRight size={14} className="project-chevron"/>
            </button>
          ))}
        </div>
        <div className="side-section session-section">
          <div className="section-label">SESSIONS <button onClick={onNew} aria-label="Create preview session" title="Create preview session"><Plus size={15}/></button></div>
          {sessions.length === 0 && <div className="empty-sidebar">No sessions in this project</div>}
          {sessions.map(s => (
            <button
              key={s.id}
              className={`session-item ${s.id === activeSessionId ? 'session-selected' : ''}`}
              onClick={() => onSession(s.id)}
              aria-current={s.id === activeSessionId ? 'page' : undefined}
            >
              <span className={`session-icon session-icon-${s.status}`}>{s.status === 'complete' ? <Check size={14}/> : s.status === 'waiting' ? <CircleAlert size={13}/> : <Bot size={14}/>}</span>
              <span className="session-text"><strong>{s.title}</strong><small>{s.agent} · {statusLabel[s.status]}</small></span>
              {s.status === 'waiting' && <span className="waiting-indicator" />}
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <div className="preview-caption"><span className="preview-dot"/> Local prototype <span className="preview-version">v0.1</span></div>
          <button className="settings-link" type="button" disabled title="Settings are coming in a future issue"><Settings2 size={16}/> Settings</button>
        </div>
      </>}
    </aside>
  );
}

function Timeline({ entries }: { entries: TimelineEntry[] }) {
  return <div className="timeline" aria-label="Session timeline">
    <div className="timeline-date"><span>SIMULATED SESSION</span></div>
    {entries.map(entry => entry.kind === 'message' ? (
      <div key={entry.id} className={`timeline-message timeline-${entry.author}`}>
        {entry.author === 'agent' && <div className="timeline-agent-avatar"><Sparkles size={15}/></div>}
        <div className="message-body"><div className="message-meta"><strong>{entry.author === 'user' ? 'You' : 'Agent · demo'}</strong><time>{entry.time}</time></div><p>{entry.text}</p></div>
      </div>
    ) : (
      <div key={entry.id} className={`timeline-event timeline-${entry.kind}`}>
        <span className="event-icon">{entry.kind === 'notice' ? <ShieldCheck size={16}/> : <TerminalSquare size={15}/>}</span>
        <span>{entry.text}</span><time>{entry.time}</time>
      </div>
    ))}
  </div>;
}

type InspectorTab = 'changes' | 'checks' | 'context';

function Inspector({ session, project, onClose }: { session: Session; project: Project; onClose: () => void }) {
  const [tab, setTab] = useState<InspectorTab>('changes');
  const tabOrder: InspectorTab[] = ['changes', 'checks', 'context'];
  function handleTabKeys(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
    const current = tabOrder.indexOf(tab);
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % tabOrder.length;
    else if (event.key === 'ArrowLeft') next = (current + tabOrder.length - 1) % tabOrder.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabOrder.length - 1;
    else return;
    event.preventDefault();
    setTab(tabOrder[next]!);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }
  return <aside className="inspector">
    <div className="inspector-header"><strong>Workspace</strong><button className="icon-button" onClick={onClose} aria-label="Close details"><PanelRightClose size={17}/></button></div>
    <div className="inspector-tabs" role="tablist" aria-label="Workspace details" onKeyDown={handleTabKeys}>
      {([['changes', 'Changes'], ['checks', 'Checks'], ['context', 'Details']] as const).map(([id, label]) => (
        <button key={id} id={`inspector-tab-${id}`} role="tab" tabIndex={tab === id ? 0 : -1} aria-selected={tab === id} aria-controls="inspector-pane" onClick={() => setTab(id)}>{label}</button>
      ))}
    </div>
    <div className="inspector-body" id="inspector-pane" role="tabpanel" aria-labelledby={`inspector-tab-${tab}`}>
      {tab === 'changes' && <>
        <div className="evidence-callout"><FileDiff size={15}/> Simulated file changes · not from Git</div>
        <div className="diff-summary"><span>2 files changed</span><span><b className="added">+18</b> <b className="removed">−4</b></span></div>
        <div className="changed-file"><FileCode2 size={15}/><span>.github/workflows/ci.yml</span><span className="file-delta">+12 −3</span></div>
        <div className="diff-code"><div className="diff-line context">@@ -8,3 +8,5 @@</div><div className="diff-line removed">- on: [push]</div><div className="diff-line added">+ on:</div><div className="diff-line added">+   pull_request:</div><div className="diff-line added">+   push:</div><div className="diff-line context">    branches: [main]</div></div>
        <div className="changed-file"><FileCode2 size={15}/><span>tests/workflow.test.ts</span><span className="file-delta">+6 −1</span></div>
      </>}
      {tab === 'checks' && <>
        <div className="evidence-callout"><CircleAlert size={15}/> Demo results only · no commands run</div>
        {['TypeScript · Typecheck', 'Unit tests', 'Build'].map((label, i) => <div className="check-item" key={label}><span>{i === 2 ? <Clock3 size={15}/> : <CircleCheck size={15}/>}</span><span>{label}</span><small>{i === 2 ? 'Not started' : 'Sample pass'}</small></div>)}
      </>}
      {tab === 'context' && <>
        <div className="detail-row"><small>PROJECT</small><strong>{project.name}</strong></div>
        <div className="detail-row"><small>AGENT</small><strong>{session.agent}</strong></div>
        <div className="detail-row"><small>BRANCH (DEMO)</small><strong>{session.worktree}</strong></div>
        <div className="detail-row"><small>SESSION STATUS</small><Status status={session.status}/></div>
        <div className="detail-row"><small>PROTOCOL</small><strong>Not connected</strong></div>
      </>}
    </div>
    <div className="inspector-footer"><ShieldCheck size={15}/><span>Execution permissions will be managed by the Rust host.</span></div>
  </aside>;
}

export default function App() {
  const [projects] = useState<Project[]>(demoProjects);
  const [sessions, setSessions] = useState<Session[]>(demoSessions);
  const [activeProjectId, setActiveProjectId] = useState(demoProjects[0]!.id);
  const [activeSessionId, setActiveSessionId] = useState(demoSessions[0]!.id);
  const [showInspector, setShowInspector] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [notice, setNotice] = useState('');
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const bellRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const monitorItems = useMemo(() => deriveMonitorItems(sessions, projects), [sessions, projects]);
  const visibleMonitorItems = useMemo(() => monitorItems.filter(item => !isHidden(item, dismissed)), [monitorItems, dismissed]);
  const blockingCount = decisionCount(visibleMonitorItems);

  useEffect(() => {
    const keyHandler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setMonitorOpen(false);
        setSwitcherOpen(open => !open);
      }
    };
    window.addEventListener('keydown', keyHandler);
    return () => window.removeEventListener('keydown', keyHandler);
  }, []);

  function jumpToMonitorItem(item: MonitorItem) {
    setActiveProjectId(item.projectId);
    setActiveSessionId(item.sessionId);
    setMonitorOpen(false);
    bellRef.current?.focus();
  }
  function closeMonitor() {
    setMonitorOpen(false);
    bellRef.current?.focus();
  }

  const project = projects.find(p => p.id === activeProjectId) ?? projects[0]!;
  const filteredSessions = sessions.filter(s => s.projectId === activeProjectId);
  const active = useMemo(() => sessions.find(s => s.id === activeSessionId) ?? filteredSessions[0], [sessions, activeSessionId, filteredSessions]);

  function chooseProject(id: string) {
    setActiveProjectId(id);
    const chosen = sessions.find(s => s.projectId === id);
    if (chosen) setActiveSessionId(chosen.id);
  }
  function createSession() {
    const id = nextId('session');
    const newSession: Session = {
      id, projectId: activeProjectId, title: 'New preview session', agent: 'Codex',
      status: 'idle', worktree: project.branch, progress: 0,
      entries: [{ id: nextId('event'), author: 'system', kind: 'notice', text: 'Preview session created. Connect a real ACP adapter to enable execution.', time: 'Just now' }],
    };
    setSessions(old => [newSession, ...old]);
    setActiveSessionId(id);
    setNotice('New in-memory preview session created');
    requestAnimationFrame(() => composerRef.current?.focus());
  }
  function submitMessage(text: string) {
    if (!active) return;
    const entry: TimelineEntry = { id: nextId('event'), author: 'user', kind: 'message', text, time: 'Just now' };
    const acknowledgement: TimelineEntry = {
      id: nextId('event'), author: 'system', kind: 'notice',
      text: 'Stored in this in-memory preview only. No message was sent to an AI provider.', time: 'Just now',
    };
    setSessions(old => old.map(s => s.id === active.id ? { ...s, entries: [...s.entries, entry, acknowledgement] } : s));
    setNotice('Message stored locally in preview');
  }

  return <div className="app-shell">
    <SessionSidebar projects={projects} sessions={filteredSessions} activeProjectId={activeProjectId} activeSessionId={active?.id ?? ''} onProject={chooseProject} onSession={setActiveSessionId} onNew={createSession} collapsed={sidebarCollapsed} onCollapse={() => setSidebarCollapsed(v => !v)}/>
    <main className="main">
      <header className="topbar">
        <div className="breadcrumbs"><FolderGit2 size={15}/><span>{project.name}</span><ChevronRight size={13}/><strong>{active?.title ?? 'No session selected'}</strong></div>
        <div className="topbar-actions"><span className="mode-pill"><span/> Demo mode</span><button className="icon-button" aria-label="Switch sessions" title="Switch sessions (Ctrl/Cmd+K)" onClick={() => { setMonitorOpen(false); setSwitcherOpen(true); }}><Search size={16}/></button><div className="monitor-anchor"><button ref={bellRef} className={`icon-button monitor-bell ${monitorOpen ? 'monitor-bell-active' : ''}`} aria-label={`Session monitor, ${blockingCount} decisions needing attention`} title="Session Sentinel · Decision Inbox" aria-expanded={monitorOpen} onClick={() => { setSwitcherOpen(false); setMonitorOpen(v => !v); }}><Bell size={17}/>{blockingCount > 0 && <span className="bell-count">{blockingCount > 99 ? '99+' : blockingCount}</span>}</button>{monitorOpen && <MonitorInbox items={monitorItems} dismissed={dismissed} onDismiss={item => setDismissed(old => new Set([...old, dismissKey(item)]))} onSelect={jumpToMonitorItem} onClose={closeMonitor}/>}</div><button className="icon-button" onClick={() => setShowInspector(v => !v)} title="Toggle details" aria-label="Toggle details"><FileDiff size={17}/></button></div>
      </header>
      <div className="preview-banner"><CircleAlert size={15}/><span>Interactive UI prototype — sample data only. No Git commands, API requests, or coding agents are running.</span><a href="https://github.com/ChiJiun/agentdock/issues/6" target="_blank" rel="noreferrer">ACP integration <ArrowUpRight size={12}/></a></div>
      {active ? <>
        <section className="session-content">
          <div className="session-title-row"><div><div className="eyebrow"><span className="eyebrow-marker"/>{project.description}</div><h1>{active.title}</h1><div className="session-summary"><Status status={active.status}/><span className="summary-divider"/><AgentMark agent={active.agent}/><span>{active.agent}</span><span className="summary-divider"/><GitBranch size={14}/><span>{active.worktree}</span></div></div><button className="icon-button more-button" disabled title="Session menu coming later" aria-label="More session actions unavailable"><MoreHorizontal size={21}/></button></div>
          <div className="session-progress"><div className="progress-heading"><span>Workflow overview <span className="progress-sub">(demo)</span></span><span>{Math.round(active.progress * 100)}%</span></div><ProgressRail value={active.progress}/><div className="workflow-steps"><span className="step-complete"><CheckCheck size={14}/> Plan</span><span className="step-complete"><Check size={14}/> Inspect</span><span className={active.status === 'complete' ? 'step-complete' : 'step-current'}><span className="step-ring"/> Review</span><span className="step-muted">PR / CI</span></div></div>
          <Timeline entries={active.entries}/>
        </section>
        <div className="composer-dock"><Composer inputRef={composerRef} onSubmit={submitMessage}/><div className="compose-footnote"><span><ShieldCheck size={13}/> Host approvals and live ACP sessions planned</span><span>Shift+Enter for a new line</span></div></div>
      </> : <section className="empty-main"><Bot size={32}/><h1>No sessions</h1><p>Create a preview session to explore the interface.</p><button className="primary-button" onClick={createSession}><Plus size={16}/> New preview session</button></section>}
      <div className="bottom-bar"><span><span className="connection-dot"/> Preview UI · In-memory state</span><span><Cpu size={13}/> Runtime disconnected <span className="bottom-divider"/> <Command size={13}/> AgentDock 0.1</span></div>
    </main>
    {showInspector && active && <Inspector session={active} project={project} onClose={() => setShowInspector(false)}/>}
    {switcherOpen && <SessionSwitcher sessions={sessions} projects={projects} onSelect={session => { setActiveProjectId(session.projectId); setActiveSessionId(session.id); setSwitcherOpen(false); }} onClose={() => setSwitcherOpen(false)}/>}
    {notice && <div className="toast" role="status"><CircleCheck size={16}/>{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notification"><X size={14}/></button></div>}
    <div className="visually-hidden" aria-live="polite">{active?.status ? statusLabel[active.status] : 'No session'}</div>
  </div>;
}
