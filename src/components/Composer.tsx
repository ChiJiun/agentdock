import { useRef, useState, type Ref, type FormEvent } from 'react';
import { ArrowUp, Paperclip, Zap } from 'lucide-react';
import { useMergedRefs } from '../vendor/acpira/mergeRefs';
import { useT } from '../i18n/context';

export function Composer({ onSubmit, inputRef }: {
  onSubmit: (message: string) => void;
  inputRef?: Ref<HTMLTextAreaElement>;
}) {
  const tr = useT();
  const [draft, setDraft] = useState('');
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const ref = useMergedRefs(internalRef, inputRef);

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setDraft('');
    internalRef.current?.focus();
  }

  return (
    <form className="composer" onSubmit={send}>
      <label className="visually-hidden" htmlFor="message-input">{tr('composer.label')}</label>
      <textarea
        id="message-input"
        ref={ref}
        placeholder={tr('composer.placeholder')}
        rows={2}
        value={draft}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <div className="composer-actions">
        <div className="composer-hint"><Zap size={13} /> {tr('composer.preview')} <span>·</span> {tr('composer.disconnected')}</div>
        <div className="composer-buttons">
          <button type="button" className="icon-button muted" aria-label={tr('composer.attachments')} disabled title={tr('composer.attachmentsInfo')}><Paperclip size={16} /></button>
          <button type="submit" className="send-button" disabled={!draft.trim()} aria-label={tr('composer.send')}><ArrowUp size={17} /></button>
        </div>
      </div>
    </form>
  );
}
