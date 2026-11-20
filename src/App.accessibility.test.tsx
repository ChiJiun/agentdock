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
    const bell = page.querySelector<HTMLButtonElement>('button.monitor-bell')!;
    act(() => bell.click());
    const first = page.querySelector<HTMLButtonElement>('.monitor-card-main')!;
    expect(document.activeElement).toBe(first);
    act(() => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(page.querySelector('[role="dialog"].monitor-panel')).toBeNull();
    expect(document.activeElement).toBe(bell);
  });

  it('traps Tab and Shift+Tab inside the session switcher', () => {
    const page = renderApp();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })));
    const dialog = page.querySelector<HTMLElement>('.switcher[role="dialog"]')!;
    const input = dialog.querySelector<HTMLInputElement>('input')!;
    const close = dialog.querySelector<HTMLButtonElement>('button.icon-button')!;
    expect(document.activeElement).toBe(input);
    act(() => close.focus());
    act(() => close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(input);
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(close);
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
