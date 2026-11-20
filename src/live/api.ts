export interface RuntimeHealth {
  ok: boolean; mode: string; protocol: string; storage: string;
}
export interface RuntimeAdapter { id: string; label: string; }
export interface RuntimeWorkspace { path: string; }
export interface GithubIssue { number: number; title: string; url: string | null; state: string; }
export interface GithubPull { number: number; title: string; url: string | null; state: string; headSha: string; }
export interface GithubCheck { id: number; name: string; status: string; conclusion: string | null; url: string | null; }
export interface GithubEvidence<T> { repo: string; items: T[]; truncated: boolean; }
export interface GithubCommitStatus { context: string; state: string; url: string | null; }
export interface GithubChecksEvidence extends GithubEvidence<GithubCheck> {
  sha: string; total: number; complete: boolean;
  sources: ('check_runs' | 'commit_status')[];
  verdict: 'success' | 'failure' | 'pending' | 'unknown';
  statusState: string;
  statuses: GithubCommitStatus[];
}
export interface RuntimeWorktree {
  id: string; source_repo: string; path: string; branch: string; created_at: string;
  state: 'creating' | 'ready' | 'partial' | 'orphan' | 'failed';
  exists: boolean; available: boolean;
}

export type RuntimeSessionStatus =
  | 'starting' | 'ready' | 'running' | 'awaiting_approval'
  | 'interrupted' | 'failed' | 'closed';

export interface RuntimeSession {
  id: string;
  adapter: string;
  cwd: string;
  agent_session: string | null;
  status: RuntimeSessionStatus;
  supports_load: 0 | 1;
  created_at: string;
  updated_at: string;
}
export interface RuntimeEvent {
  seq: number;
  sessionId: string;
  kind: string;
  data: {
    text?: string;
    code?: string;
    stopReason?: string;
    update?: { sessionUpdate?: string; content?: { type: string; text?: string }; title?: string; status?: string };
    approvalId?: string;
    title?: string;
    decision?: string;
    reason?: string;
    message?: string;
  };
  createdAt: string;
}
export interface LiveAttentionItem {
  id: string;
  sessionId: string;
  adapter: string;
  cwd: string;
  status: RuntimeSessionStatus;
  evidenceCursor: number;
  updatedAt: string;
  /** The three inbox sections of docs/ux/states-and-indicators.md section 4. */
  type: 'reply' | 'review' | 'background';
  key: 'approval_pending' | 'agent_failed' | 'agent_interrupted' | 'agent_running' | 'turn_finished' | 'turn_cancelled';
  approvalId?: string;
}
export interface RuntimeApproval {
  id: string;
  session_id: string;
  title: string;
  choices: { id: string; kind: string; name: string }[];
  /** What the agent asked to do, redacted and bounded by the host. */
  detail?: { kind?: string | null; input?: unknown; locations?: string[] };
  status: string;
  created_at: string;
  expires_at: string;
}

export class ApiFailure extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function runtimeApi<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; data?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch('/api/' + path.replace(/^\//, ''), {
    method: options.method ?? 'GET',
    headers: options.data !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: options.data !== undefined ? JSON.stringify(options.data) : undefined,
    signal: options.signal,
  });
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new ApiFailure(response.status, 'Runtime returned an invalid response'); }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      ? String(payload.error)
      : `Runtime error ${response.status}`;
    throw new ApiFailure(response.status, message);
  }
  return payload as T;
}
export const getHealth = (signal?: AbortSignal) => runtimeApi<RuntimeHealth>('health', { signal });
export const getAdapters = () => runtimeApi<RuntimeAdapter[]>('adapters');
export const getWorkspaces = () => runtimeApi<RuntimeWorkspace[]>('workspaces');
export const getWorktrees = () => runtimeApi<RuntimeWorktree[]>('worktrees');
export const createWorktree = (repoPath: string, idempotencyKey?: string) =>
  runtimeApi<RuntimeWorktree>('worktrees', { method: 'POST', data: { repoPath, idempotencyKey } });
export const getSessions = () => runtimeApi<RuntimeSession[]>('sessions');
export const getAttention = () => runtimeApi<LiveAttentionItem[]>('attention');
/** Marks one result row reviewed. The runtime refuses it for approvals (409). */
export const markAttentionReviewed = (id: string) => runtimeApi<{ ok: boolean }>(`attention/${encodeURIComponent(id)}/reviewed`, { method: 'POST', data: {} });
/** Records that the session was on screen, up to the newest rendered event. */
export const markSessionViewed = (id: string, cursor: number) => runtimeApi<{ ok: boolean }>(`sessions/${encodeURIComponent(id)}/viewed`, { method: 'POST', data: { cursor } });
export const getEvents = (id: string, after = 0) => runtimeApi<RuntimeEvent[]>(`sessions/${encodeURIComponent(id)}/events?after=${after}`);
export const getApprovals = (id: string) => runtimeApi<RuntimeApproval[]>(`sessions/${encodeURIComponent(id)}/approvals`);
export const createRuntimeSession = (adapterId: string, cwd: string) =>
  runtimeApi<RuntimeSession>('sessions', { method: 'POST', data: { adapterId, cwd } });
export const sendRuntimePrompt = (id: string, text: string) =>
  runtimeApi<{ accepted: boolean }>(`sessions/${encodeURIComponent(id)}/prompt`, { method: 'POST', data: { text } });
export const cancelRuntimePrompt = (id: string) =>
  runtimeApi<{ ok: boolean }>(`sessions/${encodeURIComponent(id)}/cancel`, { method: 'POST', data: {} });
export const decideRuntimeApproval = (sessionId: string, approvalId: string, decision: 'allow_once' | 'deny') =>
  runtimeApi<{ ok: boolean }>(`sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}`,
    { method: 'POST', data: { decision } });
export const closeRuntimeSession = (id: string) =>
  runtimeApi<{ ok: boolean }>(`sessions/${encodeURIComponent(id)}/close`, { method: 'POST', data: {} });
export const gitStatus = (cwd: string) =>
  runtimeApi<{ cwd: string; status: string }>(`git/status?cwd=${encodeURIComponent(cwd)}`);
export const gitDiff = (cwd: string) =>
  runtimeApi<{ cwd: string; diff: string; truncated: boolean }>(`git/diff?cwd=${encodeURIComponent(cwd)}`);
export const getGithubIssues = (cwd: string) => runtimeApi<GithubEvidence<GithubIssue>>(`github/issues?cwd=${encodeURIComponent(cwd)}`);
export const getGithubPulls = (cwd: string) => runtimeApi<GithubEvidence<GithubPull>>(`github/pulls?cwd=${encodeURIComponent(cwd)}`);
export const getGithubChecks = (cwd: string, sha: string) => runtimeApi<GithubChecksEvidence>(`github/checks?cwd=${encodeURIComponent(cwd)}&sha=${encodeURIComponent(sha)}`);
