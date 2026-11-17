import { useEffect, useRef } from 'react';
import { AlertTriangle, ArrowUpRight, Bell, CheckCircle2, Clock3, ShieldAlert, X } from 'lucide-react';
import { useLocale } from '../i18n/context';
import type { LiveAttentionItem } from '../live/api';

const order = ['decision','review','background','completed'] as const;
const titles = {
  'zh-TW': { decision:'需要你決策', review:'需要查看', background:'背景進度', completed:'最近完成' },
  'en-US': { decision:'Needs your decision', review:'Needs review', background:'Background', completed:'Recently completed' },
};
const summaries = {
  'zh-TW': {
    approval_pending: ['Agent 正在等待你批准一項 ACP 工具操作。', '開啟工作階段查看權限內容，批准或拒絕。'],
    agent_failed: ['Agent 執行失敗，工作階段保留了錯誤紀錄。', '查看錯誤與 Git 差異，再決定是否重試。'],
    agent_interrupted: ['Agent 程序中斷；歷史紀錄仍可查看，但沒有自動重新接上模型。', '查看工作階段，決定要不要建立新 Session。'],
    agent_running: ['Agent 正在處理 Prompt，目前不需要額外決策。', '需要時開啟工作階段查看進度。'],
    turn_finished: ['Agent 已完成上一個回合；尚未代表程式碼通過驗證。', '查看實際回覆、Git 差異與測試證據。'],
  },
  'en-US': {
    approval_pending: ['The Agent is waiting for an ACP tool permission decision.', 'Open the session to approve or deny the request.'],
    agent_failed: ['The Agent failed; the session still contains error evidence.', 'Inspect the error and Git diff before deciding whether to retry.'],
    agent_interrupted: ['The Agent process was interrupted. History is saved, but model context was not reattached.', 'Inspect the session before starting a new one.'],
    agent_running: ['The Agent is processing a prompt; no action is required now.', 'Open the session to check progress when needed.'],
    turn_finished: ['The Agent finished its last turn. This does not certify the code.', 'Review output, Git changes and test evidence.'],
  },
};

export function LiveAttentionInbox({ items, onSelect, onDismiss, onClose }: {
  items: LiveAttentionItem[];
  onSelect: (item: LiveAttentionItem) => void;
  onDismiss: (item: LiveAttentionItem) => void;
  onClose: () => void;
}) {
  const locale = useLocale();
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const zh = locale === 'zh-TW';
  return <section className="live-attention-inbox" role="dialog" aria-label={zh ? '跨 Session 決策收件匣' : 'Cross-session decision inbox'} aria-modal="false">
    <header>
      <div><strong><Bell size={16}/> {zh ? 'Session Sentinel' : 'Session Sentinel'}</strong><small>{zh ? '由實際 ACP 事件產生 · 不呼叫 LLM' : 'Based on real ACP events · no LLM calls'}</small></div>
      <button ref={closeButton} onClick={onClose} aria-label={zh?'關閉通知':'Close notifications'}><X size={17}/></button>
    </header>
    <div className="live-attention-groups">
      {items.length===0 && <div className="live-attention-empty"><CheckCircle2 size={20}/>{zh ? '目前沒有待處理事件' : 'No pending session updates'}</div>}
      {order.map(type => {
        const matched=items.filter(item=>item.type===type);
        if (!matched.length) return null;
        return <section key={type}>
          <div className="live-attention-section-title">{titles[locale][type]} <span>{matched.length}</span></div>
          {matched.map(item => {
            const [summary,action]=summaries[locale][item.key];
            return <article className={`live-attention-card live-attention-${item.type}`} key={item.id}>
              <button className="live-attention-main" onClick={()=>onSelect(item)} aria-label={`${item.adapter}: ${summary}`}>
                <span className="live-attention-icon">{item.type==='decision'? <ShieldAlert size={16}/> : item.type==='review'? <AlertTriangle size={16}/> :item.type==='completed'?<CheckCircle2 size={16}/>:<Clock3 size={16}/>}</span>
                <span className="live-attention-copy">
                  <strong>{item.adapter} · {item.sessionId.slice(0,8)}</strong>
                  <small>{item.cwd.split(/[\\/]/).at(-1)} · {item.status}</small>
                  <span>{summary}</span>
                  <em>{action} <ArrowUpRight size={12}/></em>
                </span>
              </button>
              <button className="live-attention-dismiss" onClick={()=>onDismiss(item)} aria-label={zh?'忽略此提醒（不代表批准）':'Dismiss alert (not an approval)'} title={zh?'僅忽略通知，不會批准任何操作':'Dismiss notice, not approval'}><X size={13}/></button>
            </article>;
          })}
        </section>;
      })}
    </div>
    <footer>{zh ? '開啟工作階段以查看原始證據 · Esc 關閉' : 'Open session for original evidence · Esc to close'}</footer>
  </section>;
}
