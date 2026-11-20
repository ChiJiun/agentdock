import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function renderApp() {
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

describe('preview accessibility', () => {
  it('opens the attention inbox on its first actionable row and restores focus on Escape', () => {
    const page = renderApp();
    const bell = page.querySelector<HTMLButtonElement>('button[aria-label^="Session monitor"]')!;
    act(() => bell.click());
    const first = page.querySelector<HTMLButtonElement>('.monitor-card-main')!;
    expect(document.activeElement).toBe(first);
    act(() => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(page.querySelector('[role="dialog"][aria-label="Session monitor"]')).toBeNull();
    expect(document.activeElement).toBe(bell);
  });

  it('keeps exactly one inspector tab in the keyboard tab order', () => {
    const page = renderApp();
    const tabs = [...page.querySelectorAll<HTMLButtonElement>('.inspector-tabs [role="tab"]')];
    expect(tabs.map(tab => tab.tabIndex)).toEqual([0, -1, -1]);
    act(() => tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    expect(tabs[2]!.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[2]);
    expect(tabs.map(tab => tab.tabIndex)).toEqual([-1, -1, 0]);
    act(() => tabs[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(page.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe('inspector-tab-changes');
  });
});
