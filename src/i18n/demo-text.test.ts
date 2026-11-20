import { describe, expect, it } from 'vitest';
import { demoText, displayDemoText } from './demo-text';

 describe('generated preview localization', () => {
  it('resolves the same stored message in the current UI locale', () => {
    const stored = demoText('sessionCreated');
    const chinese = displayDemoText(stored, 'zh-TW');
    const english = displayDemoText(stored, 'en-US');
    expect(chinese).not.toBe(english);
    expect(chinese).not.toContain('__agentdock_demo:');
  });
  it('leaves ordinary text and unknown markers untouched', () => {
    expect(displayDemoText('User input', 'zh-TW')).toBe('User input');
    expect(displayDemoText('__agentdock_demo:unknown', 'en-US')).toBe('__agentdock_demo:unknown');
  });
});
