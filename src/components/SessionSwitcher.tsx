import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Command, Search, X } from 'lucide-react';
import type { Project, Session } from '../model';
import { useT } from '../i18n/context';

export function SessionSwitcher({ sessions, projects, onSelect, onClose }: {
  sessions: Session[];
  projects: Project[];
  onSelect: (session: Session) => void;
  onClose: () => void;
}) {
  const tr = useT();
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const before = useRef<HTMLElement | null>(null);
  const options = useMemo(() => {
    const q = query.normalize('NFC').toLocaleLowerCase().trim();
    const projectNames = new Map(projects.map(project => [project.id, project.name]));
    return [...sessions].filter(session => projectNames.has(session.projectId) &&
      (`${session.title} ${projectNames.get(session.projectId)} ${session.agent}`.normalize('NFC').toLocaleLowerCase().includes(q)))
      .sort((a, b) => (a.status === 'waiting' ? 0 : 1) - (b.status === 'waiting' ? 0 : 1));
  }, [sessions, projects, query]);
  // Only rows that are rendered can be focused or selected, so Enter never picks an invisible row.
  const shown = useMemo(() => options.slice(0, 50), [options]);
  useEffect(() => {
    before.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    return () => before.current?.focus();
  }, []);

  const select = (session: Session) => {
    onSelect(session);
  };
  function trapFocus(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== 'Tab') return;
    const dialog = e.currentTarget;
    const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) { e.preventDefault(); return; }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      e.preventDefault(); first.focus();
    }
  }
  function keys(e: KeyboardEvent<HTMLInputElement>) {
    // Keys that drive an IME composition (candidate Enter, Esc, arrows) must not act on the list.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocused(v => Math.min(shown.length - 1, v + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setFocused(v => Math.max(0, v - 1)); }
    if (e.key === 'Enter' && shown[Math.min(focused, shown.length - 1)]) {
      e.preventDefault(); select(shown[Math.min(focused, shown.length - 1)]!);
    }
  }
  return <div className="switcher-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section onKeyDown={trapFocus} role="dialog" aria-modal="true" aria-label={tr('switcher.title')} className="switcher">
      <div className="switcher-input"><Search size={18}/><input ref={input} placeholder={tr('switcher.placeholder')} value={query} onChange={e => { setQuery(e.target.value); setFocused(0); }} onKeyDown={keys} aria-label={tr('switcher.search')}/><button className="icon-button" onClick={onClose} aria-label={tr('switcher.close')}><X size={17}/></button></div>
      <div className="switcher-results">{options.length ? options.slice(0, 50).map((session, index) =>
        <button className={`switcher-result ${focused === index ? 'switcher-focused' : ''}`} key={session.id} onClick={() => select(session)} onMouseEnter={() => setFocused(index)}>
          <span>{session.title}</span><small>{projects.find(p => p.id === session.projectId)?.name} · {session.agent} · {tr(`status.${session.status}`)}</small>
        </button>
      ) : <div className="switcher-empty">{tr('switcher.empty')}</div>}</div>
      <div className="switcher-bottom"><Command size={14}/> {tr('switcher.bottom')} <span>{tr('switcher.navigation')}</span></div>
    </section>
  </div>;
}
