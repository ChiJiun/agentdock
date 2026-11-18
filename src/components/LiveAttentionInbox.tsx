import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AlertTriangle, ArrowUpRight, Bell, Check, CheckCircle2, Clock3, ShieldAlert, X } from 'lucide-react';
import { useLocale } from '../i18n/context';
import type { LiveAttentionItem } from '../live/api';

// Fixed section order from docs/ux/states-and-indicators.md section 4.
const order = ['reply','review','background'] as const;
const titles = {
  'zh-TW': { reply:'需要你回覆', review:'新結果待查看', background:'背景執行中' },
  'en-US': { reply:'Needs your reply', review:'New results to review', background:'Running in background' },
};
// Deterministic templates only. Agent output, prompts and tool titles are
// never shown here, so a row cannot leak a credential or grow unbounded.
const summaries = {
  'zh-TW': {
    approval_pending: ['Agent 已暫停，正在等你批准一項 ACP 工具操作。', '開啟工作階段查看完整內容，再批准或拒絕。'],
    agent_failed: ['Agent 執行失敗，工作階段保留了錯誤紀錄。', '查看錯誤與 Git 差異，再決定是否重試。'],
    agent_interrupted: ['Agent 程序中斷；歷史紀錄仍可查看，但沒有自動重新接上模型。', '查看工作階段，決定要不要建立新 Session。'],
    agent_running: ['Agent 正在處理 Prompt，目前不需要額外決策。', '需要時開啟工作階段查看進度。'],
    turn_finished: ['Agent 已完成上一個回合；尚未代表程式碼通過驗證。', '查看實際回覆、Git 差異與測試證據。'],
    turn_cancelled: ['上一個回合已被取消，Agent 沒有完成它。', '查看已產生的部分輸出，決定要不要重新送出。'],
  },
  'en-US': {
    approval_pending: ['The Agent is paused, waiting for you to decide on an ACP tool permission.', 'Open the session to see the full request, then approve or deny.'],
    agent_failed: ['The Agent failed; the session still contains error evidence.', 'Inspect the error and Git diff before deciding whether to retry.'],
    agent_interrupted: ['The Agent process was interrupted; history is saved but not reattached.', 'Inspect the session before starting a new one.'],
    agent_running: ['The Agent is processing a prompt; no action is required now.', 'Open the session to check progress when needed.'],
    turn_finished: ['The Agent finished its last turn; the code is not certified.', 'Review output, Git changes and test evidence.'],
    turn_cancelled: ['The last turn was cancelled; the Agent did not finish it.', 'Check the partial output and decide whether to resend.'],
  },
};
const statusText = {
  'zh-TW': { approval_pending:'需要批准', agent_failed:'失敗', agent_interrupted:'已中斷', agent_running:'執行中', turn_finished:'完成 · 新', turn_cancelled:'已取消' },
  'en-US': { approval_pending:'Needs approval', agent_failed:'Failed', agent_interrupted:'Interrupted', agent_running:'Running', turn_finished:'Done · new', turn_cancelled:'Cancelled' },
};

function Glyph({ item }: { item: LiveAttentionItem }) {
  if (item.type === 'reply') return <ShieldAlert size={16}/>;
  if (item.key === 'turn_finished') return <CheckCircle2 size={16}/>;
  if (item.key === 'turn_cancelled') return <Clock3 size={16}/>;
  if (item.type === 'review') return <AlertTriangle size={16}/>;
  return <Clock3 size={16}/>;
}

export function LiveAttentionInbox({ items, onSelect, onMarkReviewed, onClose }: {
  items: LiveAttentionItem[];
  onSelect: (item: LiveAttentionItem) => void;
  onMarkReviewed: (item: LiveAttentionItem) => void;
  /** `restoreFocus` is false when the user clicked outside the popover. */
  onClose: (restoreFocus: boolean) => void;
}) {
  const locale = useLocale();
  const panel = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    // Open: focus the first row, or the popover itself when it has no rows.
    const first = panel.current?.querySelector<HTMLButtonElement>('.live-attention-main');
    (first ?? panel.current)?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current(true);
    };
    const pointer = (event: MouseEvent) => {
      const anchor = panel.current?.parentElement;
      if (anchor && event.target instanceof Node && !anchor.contains(event.target)) onCloseRef.current(false);
    };
    window.addEventListener('keydown', key);
    document.addEventListener('mousedown', pointer);
    return () => {
      window.removeEventListener('keydown', key);
      document.removeEventListener('mousedown', pointer);
    };
  }, []);
  function moveFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
    const rows = [...(panel.current?.querySelectorAll<HTMLButtonElement>('.live-attention-main') ?? [])];
    if (!rows.length) return;
    event.preventDefault();
    const current = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
      : event.key === 'ArrowDown' ? Math.min(rows.length - 1, current + 1) : Math.max(0, current - 1);
    rows[next]?.focus();
  }
  const zh = locale === 'zh-TW';
  return <section ref={panel} tabIndex={-1} onKeyDown={moveFocus} className="live-attention-inbox" role="dialog" aria-label={zh ? '跨 Session 決策收件匣' : 'Cross-session decision inbox'} aria-modal="false">
    <header>
      <div><strong><Bell size={16}/> Session Sentinel</strong><small>{zh ? '由實際 ACP 事件產生 · 不呼叫 LLM' : 'Based on real ACP events · no LLM calls'}</small></div>
      <button onClick={()=>onClose(true)} aria-label={zh?'關閉通知':'Close notifications'}><X size={17}/></button>
    </header>
    <div className="live-attention-groups">
      {items.length===0 && <div className="live-attention-empty"><CheckCircle2 size={20}/>{zh ? '目前沒有需要你處理的事' : 'Nothing needs you right now'}</div>}
      {order.map(type => {
        const matched=items.filter(item=>item.type===type);
        if (!matched.length) return null;
        return <section key={type} aria-label={`${titles[locale][type]}：${matched.length}`}>
          <div className={`live-attention-section-title live-attention-section-${type}`}>{type==='reply' && <ShieldAlert size={13}/>}{titles[locale][type]} <span>{matched.length}</span></div>
          {matched.map(item => {
            const [summary,action]=summaries[locale][item.key];
            const label=statusText[locale][item.key];
            const project=item.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? item.cwd;
            return <article className={`live-attention-card live-attention-${item.type}`} key={item.id}>
              <button className="live-attention-main" onClick={()=>onSelect(item)} aria-label={`${label}: ${item.adapter} · ${project}. ${summary}`}>
                <span className="live-attention-icon"><Glyph item={item}/></span>
                <span className="live-attention-copy">
                  <strong>{item.adapter} · {item.sessionId.slice(0,8)}</strong>
                  <small><b>{label}</b> · {project}</small>
                  <span>{summary}</span>
                  <em>{action} <ArrowUpRight size={12}/></em>
                </span>
              </button>
              {item.type==='review' && <button className="live-attention-reviewed" onClick={()=>onMarkReviewed(item)} aria-label={zh?`標記為已查看：${item.adapter} · ${project}`:`Mark reviewed: ${item.adapter} · ${project}`} title={zh?'標記為已查看；有新事件時會再出現':'Mark reviewed; it returns on new events'}><Check size={13}/></button>}
            </article>;
          })}
        </section>;
      })}
    </div>
    <footer>{zh ? '批准或拒絕只能在工作階段內進行 · Esc 關閉' : 'Approve or deny only inside the session · Esc to close'}</footer>
  </section>;
}
