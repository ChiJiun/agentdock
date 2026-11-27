import type { Project, Session } from './model';
import { t } from './i18n/messages';
import type { Locale } from './i18n/language';

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
 * Deterministic monitor derived from simulated status only. UI refresh and
 * locale changes do not call an LLM, translate raw evidence, or invent tool results.
 */
export function deriveMonitorItems(
  sessions: Session[],
  projects: Project[],
  localeForSession: Locale | ((session: Session) => Locale) = 'en-US',
): MonitorItem[] {
  const projectNames = new Map(projects.map(project => [project.id, project.name]));
  return sessions.flatMap(session => {
    const projectName = projectNames.get(session.projectId);
    if (!projectName) return []; // Never surface sessions outside the known project scope.
    const lastEvent = session.entries.at(-1);
    const locale = typeof localeForSession === 'function' ? localeForSession(session) : localeForSession;
    const level: AttentionLevel = session.status === 'waiting' ? 'decision'
      : session.status === 'complete' ? 'complete'
        : session.status === 'active' ? 'background' : 'idle';
    const summaryKey = session.status === 'waiting' ? 'monitor.summary.waiting'
      : session.status === 'complete' ? 'monitor.summary.complete'
        : session.status === 'active' ? 'monitor.summary.active' : 'monitor.summary.idle';
    const actionKey = session.status === 'waiting' ? 'monitor.action.waiting'
      : session.status === 'complete' ? 'monitor.action.complete'
        : session.status === 'active' ? 'monitor.action.active' : 'monitor.action.idle';

    return [{
      id: `monitor-${session.id}`,
      sessionId: session.id, projectId: session.projectId, projectName,
      sessionTitle: session.title, agent: session.agent,
      level, summary: t(locale, summaryKey), nextAction: t(locale, actionKey),
      sourceEventId: lastEvent?.id,
    }];
  }).sort((a, b) => order[a.level] - order[b.level] || a.projectName.localeCompare(b.projectName) || a.sessionTitle.localeCompare(b.sessionTitle));
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
