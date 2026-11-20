import type { Project, Session } from './model';

export type AttentionLevel = 'decision' | 'review' | 'background' | 'complete' | 'idle';

export type MonitorItem = {
  id: string;
  sessionId: string;
  projectId: string;
  projectName: string;
  sessionTitle: string;
  agent: string;
  level: AttentionLevel;
  summary: string;
  nextAction: string;
  sourceEventId?: string;
};

const order: Record<AttentionLevel, number> = {
  decision: 0, review: 1, background: 2, complete: 3, idle: 4,
};

/**
 * A deterministic, provider-free preview of the future event-based monitor.
 * It contains only data from in-memory simulated sessions; it does not query any agent.
 */
export function deriveMonitorItems(sessions: Session[], projects: Project[]): MonitorItem[] {
  const projectNames = new Map(projects.map(project => [project.id, project.name]));
  return sessions.flatMap(session => {
    const projectName = projectNames.get(session.projectId);
    if (!projectName) return []; // Never surface sessions outside the known project scope.
    const lastEvent = session.entries.at(-1);
    const lastText = lastEvent?.text || 'No activity recorded.';
    const action = session.status === 'waiting'
      ? { level: 'decision' as const, summary: summarize(lastText), nextAction: 'Open the session to review the simulated approval.' }
      : session.status === 'complete'
        ? { level: 'complete' as const, summary: 'This demo session is marked complete.', nextAction: 'Review the sample timeline.' }
        : session.status === 'active'
          ? { level: 'background' as const, summary: summarize(lastText), nextAction: 'Check progress when needed.' }
          : { level: 'idle' as const, summary: 'This preview session is idle; no agent is connected.', nextAction: 'Open the session to compose a preview message.' };
    return [{
      id: `monitor-${session.id}`,
      sessionId: session.id, projectId: session.projectId, projectName,
      sessionTitle: session.title, agent: session.agent,
      level: action.level, summary: action.summary,
      nextAction: action.nextAction, sourceEventId: lastEvent?.id,
    }];
  }).sort((a, b) => order[a.level] - order[b.level] || a.projectName.localeCompare(b.projectName) || a.sessionTitle.localeCompare(b.sessionTitle));
}

function summarize(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return 'No new status details.';
  return flat.length <= 125 ? flat : `${flat.slice(0, 122).trimEnd()}…`;
}

/**
 * A dismissal is bound to the event it was made for, so a new event in the same session shows the item again.
 * Items that need a decision can never be dismissed: dismissing is not an approval and must not hide pending work.
 */
export function dismissKey(item: MonitorItem): string {
  return `${item.id}:${item.sourceEventId ?? ''}`;
}

export function canDismiss(item: MonitorItem): boolean {
  return item.level !== 'decision';
}

export function isHidden(item: MonitorItem, dismissed: Set<string>): boolean {
  return canDismiss(item) && dismissed.has(dismissKey(item));
}

export function decisionCount(items: MonitorItem[]): number {
  return items.filter(item => item.level === 'decision').length;
}
