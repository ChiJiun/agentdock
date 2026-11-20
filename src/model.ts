export type SessionStatus = 'idle' | 'active' | 'waiting' | 'complete';
export type AgentName = 'Codex' | 'Claude Code' | 'Octomind';
export type TimelineEntry = {
  id: string;
  kind: 'message' | 'event' | 'notice';
  author: 'user' | 'agent' | 'system';
  text: string;
  time: string;
};
export type Project = { id: string; name: string; description: string; branch: string };
export type Session = {
  id: string;
  projectId: string;
  title: string;
  agent: AgentName;
  status: SessionStatus;
  worktree: string;
  progress: number;
  entries: TimelineEntry[];
};
