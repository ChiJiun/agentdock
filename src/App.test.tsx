import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';
import { STORAGE_KEY } from './i18n/language';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function render() {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<App />));
  return container;
}

function select(selector: string, value: string, parent: HTMLElement) {
  const element = parent.querySelector<HTMLSelectElement>(selector);
  expect(element, `missing select: ${selector}`).not.toBeNull();
  act(() => {
    element!.value = value;
    element!.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  vi.unstubAllGlobals();
});

describe('interactive AgentDock preview with zh-TW/English language preferences', () => {
  it('opens a localized monitor and navigates without executing a real approval', () => {
    const page = render();
    expect(page.textContent).toContain('模擬資料');
    const bell = page.querySelector<HTMLButtonElement>('button[aria-label^="Session 監控"]');
    expect(bell?.getAttribute('aria-label')).toContain('1 項待決策');
    act(() => bell?.click());
    expect(page.textContent).toContain('決策收件匣');
    expect(page.textContent).toContain('模擬審批');
    const view = page.querySelector<HTMLButtonElement>('button[aria-label^="開啟 Review CI workflow"]');
    expect(view).not.toBeNull();
    act(() => view?.click());
    expect(page.querySelector('[role="dialog"][aria-label="Session 監控"]')).toBeNull();
    expect(page.textContent).toContain('目前沒有執行任何指令');
  });

  it('opens the keyboard-driven quick session switcher from Ctrl+K', () => {
    const page = render();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })));
    expect(page.querySelector('[role="dialog"][aria-label="快速切換工作階段"]')).not.toBeNull();
    const results = [...page.querySelectorAll<HTMLButtonElement>('.switcher-result')];
    expect(results[0].textContent).toContain('Review CI workflow');
    const other = results.find(row => row.textContent?.includes('Inspect API tests'));
    act(() => other?.click());
    expect(page.querySelector('[role="dialog"][aria-label="快速切換工作階段"]')).toBeNull();
    expect(page.textContent).toContain('Inspect API tests');
  });

  it('switches the UI to English and persists a validated language profile', () => {
    const page = render();
    act(() => page.querySelector<HTMLButtonElement>('button[aria-label="語言設定"]')?.click());
    expect(page.querySelector('[role="dialog"][aria-label="語言與輸出設定"]')).not.toBeNull();
    select('#ui-locale', 'en-US', page);
    expect(page.textContent).toContain('Interactive UI prototype');
    expect(page.querySelector<HTMLButtonElement>('button[aria-label="Language settings"]')).not.toBeNull();
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(stored.global.uiLocale).toBe('en-US');
    expect(stored.global.workflowLocale).toBe('zh-TW');
  });

  it('supports per-project workflow language without forcing UI language or rewriting evidence', () => {
    const page = render();
    act(() => page.querySelector<HTMLButtonElement>('button[aria-label="語言設定"]')?.click());
    select('#ui-locale', 'en-US', page);
    select('#language-scope', 'project', page);
    select('#workflow-locale', 'en-US', page);

    // Interface stays English, the selected project's summaries use English.
    act(() => page.querySelector<HTMLButtonElement>('button[aria-label^="Session monitor"]')?.click());
    expect(page.textContent).toContain('A demo approval is waiting');
    expect(page.textContent).toContain('Decision inbox');
    expect(page.textContent).toContain('.github/workflows/ci.yml');
    expect(page.textContent).toContain('branches: [main]');
  });

  it('reports the real language capability honestly when no ACP runtime is connected', () => {
    const page = render();
    const details = [...page.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find(tab => tab.textContent?.includes('詳細資訊'));
    act(() => details?.click());
    expect(page.textContent).toContain('語言控制支援程度');
    expect(page.textContent).toContain('不支援（尚未連接 ACP Adapter）');
  });

  it('restores UI language preference after the preview is remounted', () => {
    let page = render();
    act(() => page.querySelector<HTMLButtonElement>('button[aria-label="語言設定"]')?.click());
    select('#ui-locale', 'en-US', page);
    act(() => root?.unmount());
    root = undefined;
    page.remove();
    page = render();
    expect(page.textContent).toContain('Interactive UI prototype');
    expect(page.querySelector<HTMLButtonElement>('button[aria-label="Language settings"]')).not.toBeNull();
  });

  it('changing the locale and reading Session Sentinel does not make model or network calls', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const page = render();
    act(() => page.querySelector<HTMLButtonElement>('button[aria-label="語言設定"]')?.click());
    select('#ui-locale', 'en-US', page);
    act(() => page.querySelector<HTMLButtonElement>('button[aria-label^="Session monitor"]')?.click());
    expect(page.textContent).toContain('Decision inbox');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('keeps <html lang> in sync with the UI language', () => {
    const page = render();
    expect(document.documentElement.lang).toBe('zh-TW');
    act(() => page.querySelector<HTMLButtonElement>('button[aria-label="語言設定"]')?.click());
    select('#ui-locale', 'en-US', page);
    expect(document.documentElement.lang).toBe('en-US');
  });

  it('opens only one overlay at a time (language panel, inbox, switcher)', () => {
    const page = render();
    const dialogs = () => page.querySelectorAll('[role="dialog"]').length;
    act(() => page.querySelector<HTMLButtonElement>('button[aria-label="語言設定"]')?.click());
    expect(page.querySelector('[role="dialog"][aria-label="語言與輸出設定"]')).not.toBeNull();
    act(() => page.querySelector<HTMLButtonElement>('button[aria-label^="Session 監控"]')?.click());
    expect(page.querySelector('[role="dialog"][aria-label="語言與輸出設定"]')).toBeNull();
    expect(dialogs()).toBe(1);
    act(() => page.querySelector<HTMLButtonElement>('button[aria-label="語言設定"]')?.click());
    expect(dialogs()).toBe(1);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })));
    expect(page.querySelector('[role="dialog"][aria-label="語言與輸出設定"]')).toBeNull();
    expect(page.querySelector('[role="dialog"][aria-label="快速切換工作階段"]')).not.toBeNull();
    expect(dialogs()).toBe(1);
  });

  it('offers no dismiss control for a pending decision, so the bell count cannot drop silently', () => {
    const page = render();
    const bell = () => page.querySelector<HTMLButtonElement>('button[aria-label^="Session 監控"]');
    act(() => bell()?.click());
    expect(page.querySelector('button[aria-label^="忽略 Review CI workflow"]')).toBeNull();
    expect(page.querySelector('button[aria-label^="忽略 Refactor event types"]')).not.toBeNull();
    expect(bell()?.getAttribute('aria-label')).toContain('1 項待決策');
  });

  it('ignores Enter that confirms an IME candidate in the quick switcher', () => {
    const page = render();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })));
    const input = page.querySelector<HTMLInputElement>('input[aria-label="搜尋工作階段"]')!;
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })));
    expect(page.querySelector('[role="dialog"][aria-label="快速切換工作階段"]')).not.toBeNull();
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(page.querySelector('[role="dialog"][aria-label="快速切換工作階段"]')).toBeNull();
  });
});
