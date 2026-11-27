import type { Project, Session } from './model';

export const demoProjects: Project[] = [
  { id: 'workbench', name: 'Sample Workbench', description: 'A sample React workspace', branch: 'feature/preview' },
  { id: 'service', name: 'API Service', description: 'Backend service example', branch: 'main' },
];

export const demoSessions: Session[] = [
  {
    id: 's1',
    projectId: 'workbench',
    title: 'Review CI workflow',
    agent: 'Codex',
    status: 'waiting',
    worktree: 'feature/ci-review',
    progress: 0.72,
    entries: [
      { id: 's1-e1', kind: 'message', author: 'user', text: 'Review the CI workflow and propose improvements. Do not modify the default branch.', time: '09:42' },
      { id: 's1-e2', kind: 'event', author: 'system', text: 'Demo event · GitHub Actions workflow scan', time: '09:43' },
      { id: 's1-e3', kind: 'message', author: 'agent', text: 'The proposed change separates documentation-only checks from code tests. Review the sample diff before proceeding.', time: '09:44' },
      { id: 's1-e4', kind: 'notice', author: 'system', text: 'Demo approval gate · Awaiting your review. No command has been executed.', time: '09:45' },
    ],
  },
  {
    id: 's2',
    projectId: 'workbench',
    title: 'Refactor event types',
    agent: 'Claude Code',
    status: 'complete',
    worktree: 'feature/events',
    progress: 1,
    entries: [
      { id: 's2-e1', kind: 'message', author: 'user', text: 'Standardize typed event names.', time: '08:32' },
      { id: 's2-e2', kind: 'notice', author: 'system', text: 'Demo only · A finished session is shown for layout evaluation.', time: '08:43' },
    ],
  },
  {
    id: 's3',
    projectId: 'service',
    title: 'Inspect API tests',
    agent: 'Octomind',
    status: 'idle',
    worktree: 'main',
    progress: 0.2,
    entries: [
      { id: 's3-e1', kind: 'notice', author: 'system', text: 'Preview session · No runtime or remote worker is connected.', time: 'Yesterday' },
    ],
  },
];

export function nextId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}
