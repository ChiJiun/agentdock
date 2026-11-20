import { useCallback, useRef, useState, type Ref, type FormEvent } from 'react';
import { ArrowUp, Paperclip, Zap } from 'lucide-react';

export function Composer({ onSubmit, inputRef }: {
  onSubmit: (message: string) => void;
  inputRef?: Ref<HTMLTextAreaElement>;
}) {
  const [draft, setDraft] = useState('');
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const setInputRef = useCallback((node: HTMLTextAreaElement | null) => {
    internalRef.current = node;
    if (typeof inputRef === 'function') inputRef(node);
    else if (inputRef) inputRef.current = node;
  }, [inputRef]);

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
      <label className="visually-hidden" htmlFor="message-input">Message to agent</label>
      <textarea
        id="message-input"
        ref={setInputRef}
        placeholder="Ask an agent to work on your code…"
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
        <div className="composer-hint"><Zap size={13} /> Preview mode <span>·</span> No agent connected</div>
        <div className="composer-buttons">
          <button type="button" className="icon-button muted" aria-label="Attachments are not available in preview" disabled title="Attachments available after ACP integration"><Paperclip size={16} /></button>
          <button type="submit" className="send-button" disabled={!draft.trim()} aria-label="Add preview message"><ArrowUp size={17} /></button>
        </div>
      </div>
    </form>
  );
}
