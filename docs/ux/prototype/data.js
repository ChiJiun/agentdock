/*
 * Mock data for the AgentDock UX prototype. Everything here is fictional
 * sample content. Usage numbers are illustrative only and do not describe
 * what any real provider exposes.
 */
(function () {
  'use strict';

  const projects = [
    { id: 'agentdock', name: 'agentdock', path: 'D:\\Code\\agentdock', branch: 'main', dirty: 0, defaultAgent: 'Claude Code' },
    { id: 'acp-adapter', name: 'acp-adapter', path: 'D:\\Code\\acp-adapter', branch: 'main', dirty: 2, defaultAgent: 'Codex' },
    { id: 'thesis-lab', name: 'thesis-lab', path: 'lab-vm:/srv/work/thesis-lab', branch: 'exp/figures', dirty: 0, defaultAgent: 'Claude Code', remote: 'lab-vm' },
  ];

  // state: running | awaiting-approval | awaiting-input | completed | failed | interrupted | queued | cancelled
  // kind:  local | background | remote
  const sessions = [
    { id: 's1', projectId: 'agentdock', parentId: null, title: 'Implement attention inbox popover', agent: 'Claude Code', model: 'reported by adapter', kind: 'local', state: 'running', viewed: true, unread: 0, pinned: true, updated: 1, branch: 'feat/inbox', worktree: 'wt/feat-inbox', transcript: 'inbox', stream: true, changes: 'inbox' },
    { id: 's1a', projectId: 'agentdock', parentId: 's1', title: 'Explore existing session model', agent: 'Claude Code', kind: 'background', state: 'completed', viewed: false, unread: 2, updated: 4, branch: 'feat/inbox', worktree: 'wt/feat-inbox', transcript: 'child-explore' },
    { id: 's1b', projectId: 'agentdock', parentId: 's1', title: 'Write unit tests for attention rules', agent: 'Codex', kind: 'background', state: 'running', viewed: true, unread: 0, updated: 0, branch: 'feat/inbox', worktree: 'wt/feat-inbox-tests', transcript: 'child-tests', finishAfter: 25 },
    { id: 's1c', projectId: 'agentdock', parentId: 's1', title: 'Independent review (fresh context)', agent: 'Codex', kind: 'background', state: 'queued', viewed: true, unread: 0, updated: 2, branch: 'feat/inbox', worktree: 'wt/feat-inbox', transcript: 'child-review' },
    { id: 's1d', projectId: 'agentdock', parentId: 's1', title: 'Lint pass on popover styles', agent: 'Codex', kind: 'background', state: 'completed', viewed: true, unread: 0, updated: 42, archived: true, branch: 'feat/inbox', worktree: 'wt/feat-inbox', transcript: 'child-explore' },
    { id: 's1e', projectId: 'agentdock', parentId: 's1', title: 'Locate keyboard shortcut registry', agent: 'Claude Code', kind: 'background', state: 'completed', viewed: true, unread: 0, updated: 55, archived: true, branch: 'feat/inbox', worktree: 'wt/feat-inbox', transcript: 'child-explore' },

    { id: 's2', projectId: 'agentdock', parentId: null, title: 'Migrate event store to SQLite (long transcript)', agent: 'Codex', model: 'reported by adapter', kind: 'local', state: 'completed', viewed: true, unread: 0, pinned: true, updated: 95, branch: 'feat/sqlite-events', worktree: 'wt/sqlite-events', transcript: 'long', changes: 'sqlite' },
    { id: 's3', projectId: 'agentdock', parentId: null, title: 'Set up CI for docs lint', agent: 'Claude Code', kind: 'local', state: 'interrupted', viewed: false, unread: 1, updated: 180, branch: 'ci/docs-lint', worktree: 'wt/ci-docs', transcript: 'interrupted' },

    { id: 's4', projectId: 'acp-adapter', parentId: null, title: 'Fix flaky worktree cleanup test', agent: 'Codex', model: 'reported by adapter', kind: 'local', state: 'awaiting-approval', viewed: true, unread: 1, pinned: true, updated: 3, branch: 'fix/worktree-flake', worktree: 'wt/fix-flake', transcript: 'approval', changes: 'flake' },
    { id: 's5', projectId: 'acp-adapter', parentId: null, title: 'Draft README for adapter capabilities', agent: 'Claude Code', kind: 'local', state: 'awaiting-input', viewed: true, unread: 1, updated: 12, branch: 'docs/readme', worktree: 'wt/docs-readme', transcript: 'question' },
    { id: 's5a', projectId: 'acp-adapter', parentId: 's5', title: 'Collect capability flags from fixtures', agent: 'Claude Code', kind: 'background', state: 'failed', viewed: false, unread: 1, updated: 15, branch: 'docs/readme', worktree: 'wt/docs-readme', transcript: 'child-failed' },

    { id: 's6', projectId: 'thesis-lab', parentId: null, title: 'Regenerate figures for chapter 4', agent: 'Claude Code', kind: 'remote', host: 'lab-vm', state: 'running', viewed: true, unread: 3, updated: 0, branch: 'exp/figures', worktree: 'wt/figures', transcript: 'remote' },
    { id: 's6a', projectId: 'thesis-lab', parentId: 's6', title: 'Re-run ablation batch 3/5', agent: 'Claude Code', kind: 'remote', host: 'lab-vm', state: 'running', viewed: true, unread: 0, updated: 0, branch: 'exp/figures', worktree: 'wt/figures', transcript: 'remote' },
    { id: 's7', projectId: 'thesis-lab', parentId: null, title: 'Benchmark baseline vs routing', agent: 'Codex', kind: 'local', state: 'failed', failure: 'quota', viewed: false, unread: 1, updated: 30, branch: 'bench/baseline', worktree: 'wt/bench', transcript: 'quota' },
  ];

  // Generate extra archived/old sessions so the switcher has realistic volume.
  const topics = ['Refactor', 'Investigate', 'Document', 'Benchmark', 'Prototype', 'Clean up', 'Profile', 'Port'];
  const objects = ['approval gate', 'event cursor', 'worktree naming', 'adapter registry', 'diff renderer', 'SSH reconnect', 'usage source labels', 'Windows path checks', 'session restore', 'CI cache'];
  let n = 0;
  for (const t of topics) for (const o of objects) {
    n++;
    const p = projects[n % projects.length];
    sessions.push({
      id: 'old' + n, projectId: p.id, parentId: null, title: `${t} ${o}`,
      agent: n % 2 ? 'Claude Code' : 'Codex', kind: p.remote ? 'remote' : 'local', host: p.remote,
      state: n % 9 === 0 ? 'cancelled' : 'completed', viewed: true, unread: 0,
      updated: 300 + n * 37, archived: true, branch: 'old/' + n, worktree: 'wt/old-' + n, transcript: 'generic',
    });
  }

  const accounts = [
    {
      agent: 'Claude Code', account: 'Subscription (signed in via CLI)', source: 'unknown',
      note: 'The adapter does not expose remaining quota. AgentDock does not estimate it.',
      session: { label: 'This session', value: 'Token counts not reported by adapter' },
    },
    {
      agent: 'Codex', account: 'Subscription (signed in via CLI)', source: 'provider',
      meter: { label: 'Rolling window used', pct: 82, resets: 'resets in 1 h 40 m' },
      updated: '2 min ago', note: 'Illustrative sample. Shown only when the adapter reports it.',
      session: { label: 'This session', value: 'in 48.2k / out 9.1k tokens (adapter-reported)' },
    },
    {
      agent: 'Mock agent (CI)', account: 'Local fixture', source: 'none',
      note: 'No usage concept.',
    },
    {
      agent: 'API key (optional native agent)', account: 'Not configured', source: 'auth',
      note: 'Sign in or add a key in Settings → Accounts.',
    },
  ];

  const suggestions = {
    running: ['Focus on the failing test first', 'Explain the plan before editing files', 'Pause after the next file and show me the diff'],
    'awaiting-approval': ['Why do you need --force here?', 'Use a dry run first', 'Skip cleanup and continue'],
    'awaiting-input': ['Target ACP v1 only for now', 'Cover both v1 and the v2 draft', 'Ask me again after the outline'],
    completed: ['Run the full test suite', 'Summarize the changes for a PR description', 'Start an independent review'],
    failed: ['Retry after the quota resets', 'Switch this task to another agent', 'Show me the last tool output'],
    interrupted: ['Start a new session from this history', 'Summarize what was done before the interruption', 'Discard and close'],
    queued: ['Start this now', 'Cancel this task'],
    cancelled: ['Restart with the same objective'],
  };

  const changes = {
    inbox: [
      { path: 'packages/ui/src/inbox/InboxButton.tsx', status: 'A', add: 84, del: 0 },
      { path: 'packages/ui/src/inbox/classify.ts', status: 'A', add: 61, del: 0 },
      { path: 'packages/ui/src/shell/TopBar.tsx', status: 'M', add: 12, del: 3 },
      { path: 'packages/ui/src/inbox/classify.test.ts', status: 'A', add: 97, del: 0 },
    ],
    sqlite: [
      { path: 'crates/store/migrations/0003_events.sql', status: 'A', add: 38, del: 0 },
      { path: 'crates/store/src/events.rs', status: 'M', add: 140, del: 62 },
      { path: 'crates/store/src/legacy_json.rs', status: 'D', add: 0, del: 118 },
      { path: 'crates/store/tests/replay.rs', status: 'A', add: 76, del: 0 },
    ],
    flake: [
      { path: 'crates/integrations/src/worktree.rs', status: 'M', add: 9, del: 4 },
      { path: 'crates/integrations/tests/cleanup.rs', status: 'M', add: 22, del: 7 },
    ],
  };

  const diffSample = [
    { t: 'hunk', s: '@@ -18,9 +18,14 @@ export function classify(session: SessionSummary, ctx: Ctx): Section | null {' },
    { t: 'ctx', s: '  if (session.archived) return null;' },
    { t: 'del', s: '  if (session.state === "waiting") return "reply";' },
    { t: 'add', s: '  if (session.state === "awaiting-approval") return "reply";' },
    { t: 'add', s: '  if (session.state === "awaiting-input") return "reply";' },
    { t: 'ctx', s: '  if (session.id === ctx.currentId) return null;' },
    { t: 'del', s: '  if (session.unread) return "review";' },
    { t: 'add', s: '  if (isTerminal(session.state) && !session.viewed) return "review";' },
    { t: 'add', s: '  if (session.state === "failed" && !session.viewed) return "review";' },
    { t: 'ctx', s: '  if (isActive(session.state)) return "background";' },
    { t: 'ctx', s: '  return null;' },
    { t: 'ctx', s: '}' },
  ];

  const checks = [
    { name: 'cargo test -p store', state: 'completed', detail: '42 passed · 0 failed · 3.8 s' },
    { name: 'pnpm vitest run inbox', state: 'completed', detail: '18 passed · 0 failed · 1.2 s' },
    { name: 'pnpm lint', state: 'failed', detail: '1 error: unused import in TopBar.tsx:3' },
    { name: 'Windows build smoke', state: 'queued', detail: 'Not run in this session' },
  ];

  const findings = [
    { sev: 'blocking', text: 'classify.ts:26 — "failed" is already a terminal state, so the second review check is unreachable; add a test for unviewed failures.' },
    { sev: 'suggestion', text: 'InboxButton.tsx:51 — badge text should not depend on locale plural rules.' },
  ];

  window.AD = window.AD || {};
  Object.assign(window.AD, { projects, sessions, accounts, suggestions, changes, diffSample, checks, findings });
})();
