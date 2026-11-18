import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight, Bell, Bot, Check, CheckCheck, Globe2,
  ChevronDown, ChevronRight, CircleAlert, CircleCheck, Clock3, Command, Cpu, FileCode2,
  FileDiff, FolderGit2, GitBranch, HardDrive, Layers3, Menu,
  MoreHorizontal, PanelRightClose, Plus, Search, Settings2, ShieldCheck, Sparkles,
  TerminalSquare, X,
} from 'lucide-react';
import { Composer } from './components/Composer';
import { ProgressRail } from './components/ProgressRail';
import { MonitorInbox } from './components/MonitorInbox';
import { SessionSwitcher } from './components/SessionSwitcher';
import { LanguageSettingsPanel } from './components/LanguageSettingsPanel';
import { LanguageProvider, useT } from './i18n/context';
import { t, type MessageKey } from './i18n/messages';
import { loadLanguageSettings, saveLanguageSettings, resolveLocale, resolveUiLocale, languageSnapshot, type LanguageSettings } from './i18n/language';
import { demoProjects, demoSessions, nextId } from './demo';
import { decisionCount, deriveMonitorItems, dismissKey, isHidden, type MonitorItem } from './monitor';
import type { AgentName, Project, Session, SessionStatus, TimelineEntry } from './model';
import { useRoving } from './vendor/acpira/roving';

const demoEntryKeys: Record<string, MessageKey> = {
  's1-e1': 'demo.message1', 's1-e2': 'demo.event1',
  's1-e3': 'demo.message2', 's1-e4': 'demo.notice1',
  's2-e1': 'demo.message3', 's2-e2': 'demo.notice2',
  's3-e1': 'demo.notice3',
};
const agentIcon: Record<AgentName, string> = {
  Codex: 'C', 'Claude Code': '✳', Octomind: 'O',
};

function Status({ status }: { status: SessionStatus }) {
  const tr = useT();
  return <span className={`status status-${status}`}>
    {status === 'complete' ? <CircleCheck size={12} /> : status === 'waiting' ? <CircleAlert size={12} /> : <span className="status-dot" />}
    {tr(`status.${status}`)}
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
  const tr = useT();
  return (
    <aside className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <div className="side-heading">
        <div className="product-logo"><Layers3 size={19}/></div>
        {!collapsed && <span className="product-wordmark">agentdock<span className="logo-period">.</span></span>}
        <button className="icon-button side-toggle" onClick={onCollapse} aria-label={tr(collapsed ? 'nav.expand' : 'nav.collapse')}><Menu size={18}/></button>
      </div>
      {!collapsed && <>
        <button type="button" className="workspace-selector" title={tr('nav.localPreview')} onClick={() => onProject(projects[0]!.id)}>
          <span className="workspace-icon"><HardDrive size={16}/></span>
          <span className="workspace-name"><strong>{tr('nav.workspace')}</strong><small>{tr('nav.localPreview')}</small></span>
          <ChevronDown size={14}/>
        </button>
        <div className="side-section">
          <div className="section-label">{tr('nav.projects')} <button disabled title={tr('nav.addProject')} aria-label={tr('nav.addProject')}><Plus size={14}/></button></div>
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
          <div className="section-label">{tr('nav.sessions')} <button onClick={onNew} aria-label={tr('nav.newSession')} title={tr('nav.newSession')}><Plus size={15}/></button></div>
          {sessions.length === 0 && <div className="empty-sidebar">{tr('nav.noSessions')}</div>}
          {sessions.map(s => (
            <button
              key={s.id}
              className={`session-item ${s.id === activeSessionId ? 'session-selected' : ''}`}
              onClick={() => onSession(s.id)}
              aria-current={s.id === activeSessionId ? 'page' : undefined}
            >
              <span className={`session-icon session-icon-${s.status}`}>{s.status === 'complete' ? <Check size={14}/> : s.status === 'waiting' ? <CircleAlert size={13}/> : <Bot size={14}/>}</span>
              <span className="session-text"><strong>{s.title}</strong><small>{s.agent} · {tr(`status.${s.status}`)}</small></span>
              {s.status === 'waiting' && <span className="waiting-indicator" />}
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <div className="preview-caption"><span className="preview-dot"/> {tr('nav.localPrototype')} <span className="preview-version">v0.1</span></div>
          <button className="settings-link" type="button" disabled title={tr('nav.settings')}><Settings2 size={16}/> {tr('nav.settings')}</button>
        </div>
      </>}
    </aside>
  );
}

function Timeline({ entries }: { entries: TimelineEntry[] }) {
  const tr = useT();
  return <div className="timeline" aria-label={tr('timeline.label')}>
    <div className="timeline-date"><span>{tr('timeline.simulated')}</span></div>
    {entries.map(entry => entry.kind === 'message' ? (
      <div key={entry.id} className={`timeline-message timeline-${entry.author}`}>
        {entry.author === 'agent' && <div className="timeline-agent-avatar"><Sparkles size={15}/></div>}
        <div className="message-body"><div className="message-meta"><strong>{tr(entry.author === 'user' ? 'timeline.you' : 'timeline.agent')}</strong><time>{entry.time}</time></div><p>{demoEntryKeys[entry.id] ? tr(demoEntryKeys[entry.id]) : entry.text}</p></div>
      </div>
    ) : (
      <div key={entry.id} className={`timeline-event timeline-${entry.kind}`}>
        <span className="event-icon">{entry.kind === 'notice' ? <ShieldCheck size={16}/> : <TerminalSquare size={15}/>}</span>
        <span>{demoEntryKeys[entry.id] ? tr(demoEntryKeys[entry.id]) : entry.text}</span><time>{entry.time}</time>
      </div>
    ))}
  </div>;
}

type InspectorTab = 'changes' | 'checks' | 'context';

function Inspector({ session, project, settings, onClose }: { session: Session; project: Project; settings: LanguageSettings; onClose: () => void }) {
  const tr = useT();
  const snapshot = languageSnapshot(settings, { projectId: project.id, sessionId: session.id });
  const [tab, setTab] = useState<InspectorTab>('changes');
  const tabs = useRoving<HTMLDivElement>({ select: true });
  return <aside className="inspector">
    <div className="inspector-header"><strong>{tr('inspector.workspace')}</strong><button className="icon-button" onClick={onClose} aria-label={tr('inspector.close')}><PanelRightClose size={17}/></button></div>
    <div className="inspector-tabs" role="tablist" aria-label={tr('inspector.tabs')} ref={tabs.ref} onKeyDown={tabs.onKeyDown}>
      {([['changes', tr('inspector.changes')], ['checks', tr('inspector.checks')], ['context', tr('inspector.details')]] as const).map(([id, label]) => (
        <button key={id} role="tab" aria-selected={tab === id} aria-controls="inspector-pane" onClick={() => setTab(id)}>{label}</button>
      ))}
    </div>
    <div className="inspector-body" id="inspector-pane" role="tabpanel">
      {tab === 'changes' && <>
        <div className="evidence-callout"><FileDiff size={15}/> {tr('inspector.simulatedChanges')}</div>
        <div className="diff-summary"><span>{tr('inspector.fileCount')}</span><span><b className="added">+18</b> <b className="removed">−4</b></span></div>
        <div className="changed-file"><FileCode2 size={15}/><span>.github/workflows/ci.yml</span><span className="file-delta">+12 −3</span></div>
        <div className="diff-code"><div className="diff-line context">@@ -8,3 +8,5 @@</div><div className="diff-line removed">- on: [push]</div><div className="diff-line added">+ on:</div><div className="diff-line added">+   pull_request:</div><div className="diff-line added">+   push:</div><div className="diff-line context">    branches: [main]</div></div>
        <div className="changed-file"><FileCode2 size={15}/><span>tests/workflow.test.ts</span><span className="file-delta">+6 −1</span></div>
      </>}
      {tab === 'checks' && <>
        <div className="evidence-callout"><CircleAlert size={15}/> {tr('inspector.simulatedResults')}</div>
        {['TypeScript · Typecheck', 'Unit tests', 'Build'].map((label, i) => <div className="check-item" key={label}><span>{i === 2 ? <Clock3 size={15}/> : <CircleCheck size={15}/>}</span><span>{label}</span><small>{tr(i === 2 ? 'inspector.notStarted' : 'inspector.samplePass')}</small></div>)}
      </>}
      {tab === 'context' && <>
        <div className="detail-row"><small>{tr('inspector.project')}</small><strong>{project.name}</strong></div>
        <div className="detail-row"><small>{tr('inspector.agent')}</small><strong>{session.agent}</strong></div>
        <div className="detail-row"><small>{tr('inspector.branch')}</small><strong>{session.worktree}</strong></div>
        <div className="detail-row"><small>{tr('inspector.status')}</small><Status status={session.status}/></div>
        <div className="detail-row"><small>{tr('inspector.protocol')}</small><strong>{tr('inspector.notConnected')}</strong></div>
        <div className="detail-row"><small>{tr('inspector.contextLocale')}</small><strong>{snapshot.workflowLocale}</strong></div>
        <div className="detail-row"><small>{tr('inspector.contextCapability')}</small><strong>{tr('inspector.unsupported')}</strong></div>
      </>}
    </div>
    <div className="inspector-footer"><ShieldCheck size={15}/><span>{tr('inspector.permissions')}</span></div>
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
  const [settings, setSettings] = useState<LanguageSettings>(loadLanguageSettings);
  const uiLocale = resolveUiLocale(settings);
  const tr = (key: MessageKey, vars?: Record<string, string | number>) => t(uiLocale, key, vars);
  const [languageOpen, setLanguageOpen] = useState(false);
  const langButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => saveLanguageSettings(settings), [settings]);
  // Keep <html lang> in sync so screen readers pronounce the UI in the selected language.
  useEffect(() => { document.documentElement.lang = uiLocale; }, [uiLocale]);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const bellRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const monitorItems = useMemo(() => deriveMonitorItems(sessions, projects, session => {
    const result = resolveLocale(settings, 'sessionSummary', { projectId: session.projectId, sessionId: session.id });
    return result === 'preserve-original' ? uiLocale : result;
  }), [sessions, projects, settings, uiLocale]);
  const visibleMonitorItems = useMemo(() => monitorItems.filter(item => !isHidden(item, dismissed)), [monitorItems, dismissed]);
  const blockingCount = decisionCount(visibleMonitorItems);

  useEffect(() => {
    const keyHandler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setMonitorOpen(false);
        setLanguageOpen(false);
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
  const closeMonitor = useCallback(() => {
    setMonitorOpen(false);
    bellRef.current?.focus();
  }, []);
  const closeLanguage = useCallback(() => {
    setLanguageOpen(false);
    langButtonRef.current?.focus();
  }, []);

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
      id, projectId: activeProjectId, title: tr('demo.newSession'), agent: 'Codex',
      status: 'idle', worktree: project.branch, progress: 0,
      entries: [{ id: nextId('event'), author: 'system', kind: 'notice', text: tr('demo.sessionCreated'), time: tr('timeline.now') }],
    };
    setSessions(old => [newSession, ...old]);
    setActiveSessionId(id);
    setNotice(tr('demo.sessionNotice'));
    requestAnimationFrame(() => composerRef.current?.focus());
  }
  function submitMessage(text: string) {
    if (!active) return;
    const entry: TimelineEntry = { id: nextId('event'), author: 'user', kind: 'message', text, time: tr('timeline.now') };
    const acknowledgement: TimelineEntry = {
      id: nextId('event'), author: 'system', kind: 'notice',
      text: tr('demo.notSent'), time: tr('timeline.now'),
    };
    setSessions(old => old.map(s => s.id === active.id ? { ...s, entries: [...s.entries, entry, acknowledgement] } : s));
    setNotice(tr('demo.stored'));
  }

  return <LanguageProvider locale={uiLocale}><div className="app-shell">
    <SessionSidebar projects={projects} sessions={filteredSessions} activeProjectId={activeProjectId} activeSessionId={active?.id ?? ''} onProject={chooseProject} onSession={setActiveSessionId} onNew={createSession} collapsed={sidebarCollapsed} onCollapse={() => setSidebarCollapsed(v => !v)}/>
    <main className="main">
      <header className="topbar">
        <div className="breadcrumbs"><FolderGit2 size={15}/><span>{project.name}</span><ChevronRight size={13}/><strong>{active?.title ?? tr('session.noSelected')}</strong></div>
        <div className="topbar-actions"><span className="mode-pill"><span/> {tr('header.demo')}</span><button className="icon-button" aria-label={tr('header.switchSessions')} title={tr('header.switchSessions')} onClick={() => { setMonitorOpen(false); setLanguageOpen(false); setSwitcherOpen(true); }}><Search size={16}/></button><div className="language-anchor"><button ref={langButtonRef} className="language-toggle" onClick={() => { setMonitorOpen(false); setSwitcherOpen(false); setLanguageOpen(v => !v); }} aria-label={tr('header.language')} title={tr('header.language')} aria-expanded={languageOpen}><Globe2 size={14}/><span>{uiLocale === 'zh-TW' ? '繁中' : 'EN'}</span></button>{languageOpen && <LanguageSettingsPanel settings={settings} onChange={setSettings} projectId={project.id} sessionId={active?.id} onClose={closeLanguage}/>}</div><div className="monitor-anchor"><button ref={bellRef} className={`icon-button monitor-bell ${monitorOpen ? 'monitor-bell-active' : ''}`} aria-label={tr('header.notifications', { count: blockingCount })} title={tr('header.monitorTitle')} aria-expanded={monitorOpen} onClick={() => { setSwitcherOpen(false); setLanguageOpen(false); setMonitorOpen(v => !v); }}><Bell size={17}/>{blockingCount > 0 && <span className="bell-count">{blockingCount > 99 ? '99+' : blockingCount}</span>}</button>{monitorOpen && <MonitorInbox items={monitorItems} dismissed={dismissed} onDismiss={item => setDismissed(old => new Set([...old, dismissKey(item)]))} onSelect={jumpToMonitorItem} onClose={closeMonitor}/>}</div><button className="icon-button" onClick={() => setShowInspector(v => !v)} title={tr('header.details')} aria-label={tr('header.details')}><FileDiff size={17}/></button></div>
      </header>
      <div className="preview-banner"><CircleAlert size={15}/><span>{tr('preview.banner')}</span><a href="https://github.com/ChiJiun/agentdock/issues/6" target="_blank" rel="noreferrer">{tr('preview.acp')} <ArrowUpRight size={12}/></a></div>
      {active ? <>
        <section className="session-content">
          <div className="session-title-row"><div><div className="eyebrow"><span className="eyebrow-marker"/>{project.description}</div><h1>{active.title}</h1><div className="session-summary"><Status status={active.status}/><span className="summary-divider"/><AgentMark agent={active.agent}/><span>{active.agent}</span><span className="summary-divider"/><GitBranch size={14}/><span>{active.worktree}</span></div></div><button className="icon-button more-button" disabled title={tr('session.more')} aria-label={tr('session.more')}><MoreHorizontal size={21}/></button></div>
          <div className="session-progress"><div className="progress-heading"><span>{tr('session.workflow')} <span className="progress-sub">{tr('session.demo')}</span></span><span>{Math.round(active.progress * 100)}%</span></div><ProgressRail value={active.progress}/><div className="workflow-steps"><span className="step-complete"><CheckCheck size={14}/> {tr('session.plan')}</span><span className="step-complete"><Check size={14}/> {tr('session.inspect')}</span><span className={active.status === 'complete' ? 'step-complete' : 'step-current'}><span className="step-ring"/> {tr('session.review')}</span><span className="step-muted">PR / CI</span></div></div>
          <Timeline entries={active.entries}/>
        </section>
        <div className="composer-dock"><Composer inputRef={composerRef} onSubmit={submitMessage}/><div className="compose-footnote"><span><ShieldCheck size={13}/> {tr('composer.permissions')}</span><span>{tr('composer.shiftEnter')}</span></div></div>
      </> : <section className="empty-main"><Bot size={32}/><h1>{tr('main.noSessions')}</h1><p>{tr('main.createHelp')}</p><button className="primary-button" onClick={createSession}><Plus size={16}/> {tr('main.create')}</button></section>}
      <div className="bottom-bar"><span><span className="connection-dot"/> {tr('footer.preview')}</span><span><Cpu size={13}/> {tr('footer.disconnected')} <span className="bottom-divider"/> <Command size={13}/> AgentDock 0.1</span></div>
    </main>
    {showInspector && active && <Inspector session={active} project={project} settings={settings} onClose={() => setShowInspector(false)}/>}
    {switcherOpen && <SessionSwitcher sessions={sessions} projects={projects} onSelect={session => { setActiveProjectId(session.projectId); setActiveSessionId(session.id); setSwitcherOpen(false); }} onClose={() => setSwitcherOpen(false)}/>}
    {notice && <div className="toast" role="status"><CircleCheck size={16}/>{notice}<button onClick={() => setNotice('')} aria-label={tr('toast.dismiss')}><X size={14}/></button></div>}
    <div className="visually-hidden" aria-live="polite">{active?.status ? tr(`status.${active.status}`) : tr('main.noSessions')}</div>
  </div></LanguageProvider>;
}
