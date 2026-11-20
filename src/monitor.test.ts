import { describe, expect, it } from 'vitest';
import { canDismiss, decisionCount, deriveMonitorItems, dismissKey, isHidden } from './monitor';
import { demoProjects, demoSessions } from './demo';

describe('session monitor (simulated data)', () => {
  it('puts action-required sessions ahead of completed or idle sessions', () => {
    const items = deriveMonitorItems(demoSessions, demoProjects);
    expect(items[0].level).toBe('decision');
    expect(items[0].sessionId).toBe('s1');
    expect(items.some(item => item.level === 'complete')).toBe(true);
    expect(decisionCount(items)).toBe(1);
  });

  it('does not show items belonging to an unknown project', () => {
    const items = deriveMonitorItems(demoSessions, demoProjects.slice(0, 1));
    expect(items.some(item => item.projectId === 'service')).toBe(false);
  });

  it('does not count background or completed activity as an action-required decision', () => {
    const items = deriveMonitorItems(demoSessions.map(session => ({ ...session, status: 'complete' })), demoProjects);
    expect(decisionCount(items)).toBe(0);
  });

  it('generates bounded templates rather than replaying long raw tool text', () => {
    const session = { ...demoSessions[0], entries: [{
      id: 'long', author: 'system' as const, kind: 'notice' as const,
      text: 'read '.repeat(200), time: 'Now',
    }] };
    const summary = deriveMonitorItems([session], demoProjects)[0].summary;
    expect(summary.length).toBeLessThanOrEqual(125);
    expect(summary).toBe('A demo approval is waiting in this session. No action has been executed.');
    expect(summary).not.toContain('read read');
  });

  it('never lets a decision item be dismissed or hidden', () => {
    const [decision] = deriveMonitorItems(demoSessions, demoProjects);
    expect(decision.level).toBe('decision');
    expect(canDismiss(decision)).toBe(false);
    expect(isHidden(decision, new Set([dismissKey(decision)]))).toBe(false);
  });

  it('shows a dismissed informational item again after a new event', () => {
    const complete = demoSessions.find(session => session.status === 'complete')!;
    const [before] = deriveMonitorItems([complete], demoProjects);
    const dismissed = new Set([dismissKey(before)]);
    expect(canDismiss(before)).toBe(true);
    expect(isHidden(before, dismissed)).toBe(true);
    const entries = [...complete.entries, { id: 'new', author: 'system' as const, kind: 'notice' as const, text: 'new', time: 'Now' }];
    const [after] = deriveMonitorItems([{ ...complete, entries }], demoProjects);
    expect(isHidden(after, dismissed)).toBe(false);
  });

  it('does not count active or idle sessions as decisions', () => {
    const items = deriveMonitorItems(demoSessions.map((session, i) => ({ ...session, status: i % 2 ? 'active' as const : 'idle' as const })), demoProjects);
    expect(decisionCount(items)).toBe(0);
  });
});
