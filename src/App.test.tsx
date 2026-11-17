import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';

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

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  vi.unstubAllGlobals();
});

describe('interactive preview shell', () => {
  it('opens the session monitor and navigates to a session without executing a real approval', () => {
    const page = render();
    expect(page.textContent).toContain('sample data only');
    const bell = page.querySelector<HTMLButtonElement>('button[aria-label^="Session monitor"]');
    expect(bell?.getAttribute('aria-label')).toContain('1 decisions');
    act(() => bell?.click());
    expect(page.textContent).toContain('Decision inbox');
    expect(page.textContent).toContain('Demo approval gate');
    const view = page.querySelector<HTMLButtonElement>('button[aria-label^="Open Review CI workflow"]');
    act(() => view?.click());
    expect(page.querySelector('[role="dialog"][aria-label="Session monitor"]')).toBeNull();
    expect(page.textContent).toContain('No command has been executed');
  });

  it('opens the quick session switcher from Ctrl+K', () => {
    const page = render();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })));
    expect(page.querySelector('[role="dialog"][aria-label="Quick switch sessions"]')).not.toBeNull();
    const results = [...page.querySelectorAll<HTMLButtonElement>('.switcher-result')];
    expect(results[0].textContent).toContain('Review CI workflow');
    const other = results.find(row => row.textContent?.includes('Inspect API tests'));
    act(() => other?.click());
    expect(page.querySelector('[role="dialog"][aria-label="Quick switch sessions"]')).toBeNull();
    expect(page.textContent).toContain('Inspect API tests');
  });
});
