import { useEffect, useRef } from 'react';
import { AlertCircle, ArrowUpRight, BellRing, Bot, CheckCircle2, Clock3, X } from 'lucide-react';
import { canDismiss, isHidden, type AttentionLevel, type MonitorItem } from '../monitor';
import { useT } from '../i18n/context';

const sections: AttentionLevel[] = ['decision', 'review', 'background', 'complete', 'idle'];

export function MonitorInbox({ items, dismissed, onDismiss, onSelect, onClose }: {
  items: MonitorItem[];
  dismissed: Set<string>;
  onDismiss: (item: MonitorItem) => void;
  onSelect: (item: MonitorItem) => void;
  onClose: () => void;
}) {
  const tr = useT();
  const panelRef = useRef<HTMLElement>(null);
  const firstRowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    (firstRowRef.current ?? panelRef.current)?.focus();
  }, []);

  const visible = items.filter(item => !isHidden(item, dismissed));
  return (
    <section ref={panelRef} tabIndex={-1} className="monitor-panel" role="dialog" aria-label={tr('monitor.title')} aria-modal="false" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }}>
      <header className="monitor-header">
        <div><div className="monitor-overline"><BellRing size={13} /> SESSION SENTINEL</div><h2>{tr('monitor.heading')}</h2><p>{tr('monitor.subheading')}</p></div>
        <button className="icon-button" onClick={onClose} aria-label={tr('monitor.close')}><X size={17}/></button>
      </header>
      <div className="monitor-explainer">{tr('monitor.explainer')}</div>
      <div className="monitor-scroll">
        {visible.length === 0 && <div className="monitor-empty"><CheckCircle2 size={21}/> {tr('monitor.empty')}</div>}
        {sections.map(section => {
          const list = visible.filter(item => item.level === section);
          if (!list.length) return null;
          return <div key={section} className="monitor-group">
            <div className="monitor-group-title"><span>{tr(`monitor.group.${section}`)}</span><b>{list.length}</b></div>
            {list.map(item => <article className={`monitor-card monitor-${item.level}`} key={item.id}>
              <button ref={item === visible[0] ? firstRowRef : undefined} className="monitor-card-main" onClick={() => onSelect(item)} aria-label={tr('monitor.open', { session: item.sessionTitle, summary: item.summary })}>
                <span className="monitor-card-icon">{item.level === 'decision' ? <AlertCircle size={17}/> : item.level === 'complete' ? <CheckCircle2 size={17}/> : item.level === 'background' ? <Clock3 size={17}/> : <Bot size={17}/>}</span>
                <span className="monitor-card-content">
                  <strong>{item.sessionTitle}</strong><small>{item.projectName} · {item.agent}</small>
                  <span className="monitor-summary">{item.summary}</span>
                  <em>{item.nextAction} <ArrowUpRight size={12}/></em>
                </span>
              </button>
              {canDismiss(item) && <button className="monitor-dismiss" onClick={() => onDismiss(item)} title={tr('monitor.dismissHint')} aria-label={tr('monitor.dismiss', { session: item.sessionTitle })}><X size={14}/></button>}
            </article>)}
          </div>;
        })}
      </div>
      <footer className="monitor-footer"><span>{tr('monitor.footer')}</span><span>{tr('monitor.esc')}</span></footer>
    </section>
  );
}
