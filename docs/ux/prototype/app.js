/*
 * AgentDock UX prototype behaviour. Plain browser JavaScript, no build step,
 * no dependencies. Demonstrates the interaction rules in docs/ux/*.md; it is
 * not production code and intentionally keeps everything in one file.
 */
(function () {
  'use strict';
  const AD = window.AD;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = AD.icon;

  /* ------------------------------------------------------------------ */
  /* Vocabulary: statuses and task kinds (see states-and-indicators.md) */
  /* ------------------------------------------------------------------ */
  const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
  function statusOf(s) {
    switch (s.state) {
      case 'running': return { label: 'Running', icon: 'stRunning', tone: 'running', spin: true };
      case 'awaiting-approval': return { label: 'Needs approval', icon: 'stApproval', tone: 'attention' };
      case 'awaiting-input': return { label: 'Needs reply', icon: 'stQuestion', tone: 'attention' };
      case 'completed': return s.viewed ? { label: 'Done', icon: 'stDone', tone: 'success' } : { label: 'Done · new', icon: 'stDoneNew', tone: 'success' };
      case 'failed':
        if (s.failure === 'quota') return { label: 'Quota limit', icon: 'stQuota', tone: 'danger' };
        if (s.failure === 'auth') return { label: 'Sign-in needed', icon: 'stAuth', tone: 'danger' };
        return { label: 'Failed', icon: 'stFailed', tone: 'danger' };
      case 'interrupted': return { label: 'Interrupted', icon: 'stInterrupted', tone: 'neutral' };
      case 'queued': return { label: 'Queued', icon: 'stQueued', tone: 'neutral' };
      case 'cancelled': return { label: 'Cancelled', icon: 'stCancelled', tone: 'neutral' };
      default: return { label: s.state, icon: 'stQueued', tone: 'neutral' };
    }
  }
  function kindOf(s) {
    if (s.kind === 'background') return { label: 'Background agent', short: 'Background', icon: 'kindBackground' };
    if (s.kind === 'remote') return { label: 'Remote task · ' + (s.host || 'worker'), short: 'Remote', icon: 'kindRemote' };
    return { label: 'Local task', short: 'Local', icon: 'kindLocal' };
  }
  const stIcon = (s, extra) => {
    const st = statusOf(s);
    return `<span class="st${st.spin ? ' st-spin' : ''}${extra ? ' ' + extra : ''}" data-tone="${st.tone}" title="${esc(st.label)}">${icon(st.icon)}</span>`;
  };
  const kindIcon = s => { const k = kindOf(s); return `<span class="kind" data-kind="${s.kind}" title="${esc(k.label)}">${icon(k.icon)}</span>`; };
  // Policy enforcement (states-and-indicators.md §9). Orthogonal to status and
  // kind. AgentDock only knows this from the adapter or from its own launch
  // settings; it is never inferred from behaviour.
  const notEnforced = s => s.enforcement === 'not-enforced';
  const enfIcon = s => notEnforced(s) ? `<span class="enf" title="Policy not enforced — the agent runs in its own ${esc(s.agentMode || 'bypass')} mode">${icon('enfOff')}</span>` : '';
  const ago = m => m <= 0 ? 'now' : m < 60 ? m + 'm' : m < 1440 ? Math.round(m / 60) + 'h' : Math.round(m / 1440) + 'd';
  const agoLong = m => m <= 0 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
  const monogram = agent => `<span class="monogram" aria-hidden="true">${esc(agent.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase())}</span>`;

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */
  const sessions = AD.sessions;
  const byId = id => sessions.find(s => s.id === id);
  const projectOf = s => AD.projects.find(p => p.id === s.projectId);
  const childrenOf = id => sessions.filter(s => s.parentId === id);
  const params = new URLSearchParams(location.search);

  const state = {
    view: 'session',
    currentId: 's1',
    projectId: null,
    settingsTab: 'agents',
    mru: ['s1', 's4', 's2', 's6'],
    expanded: new Set(['s1', 's5']),
    collapsedGroups: new Set(),
    showArchived: new Set(),
    reviewOpen: false,
    reviewTab: 'changes',
    reviewFile: 0,
    drawer: null,            // 'sidebar' | 'review' | null  (narrow layouts)
    ghostOff: {},            // session id -> true when suggestion dismissed
    drafts: {},
    transcripts: {},
    newBelow: 0,
    focusRow: null,          // roving tabindex target in the sidebar tree
    homeRepo: null,
    tick: 0,
  };

  /* ------------------------------------------------------------------ */
  /* Attention classification (inbox + switcher ordering)               */
  /* ------------------------------------------------------------------ */
  function classify(s) {
    // Blocking states always count, even for the session on screen (the
    // approval card may be scrolled away) and even if the session is archived
    // (the app unarchives it; this order is the safety net).
    if (s.state === 'awaiting-approval' || s.state === 'awaiting-input') return 'reply';
    if (s.archived) return null;
    if (s.id === state.currentId && state.view === 'session') return null;
    if (TERMINAL.has(s.state) && !s.viewed) return 'review';
    if (s.state === 'running' || s.state === 'queued') return 'background';
    return null;
  }
  function inboxModel() {
    const m = { reply: [], review: [], background: [] };
    for (const s of sessions) { const c = classify(s); if (c) m[c].push(s); }
    const byTime = (a, b) => a.updated - b.updated;
    m.reply.sort(byTime); m.review.sort(byTime); m.background.sort(byTime);
    return m;
  }

  /* ------------------------------------------------------------------ */
  /* Transcripts                                                         */
  /* ------------------------------------------------------------------ */
  const T = {
    user: text => ({ t: 'user', text }),
    agent: text => ({ t: 'agent', text }),
    tool: (name, arg, meta, out, status) => ({ t: 'tool', name, arg, meta, out, status: status || 'ok' }),
    plan: steps => ({ t: 'plan', steps }),
  };
  function buildTranscript(s) {
    const k = s.transcript;
    if (k === 'inbox') return [
      T.user('Add an attention inbox to the top bar. It should list sessions that need a reply, sessions with unseen results, and background work. Follow docs/ux/states-and-indicators.md.'),
      T.agent('I will read the UX spec and the current shell first, then add a pure classification function with tests before touching the UI.'),
      T.plan([['Read UX spec and shell layout', 'done'], ['Write classify() with unit tests', 'done'], ['Build InboxButton + popover', 'active'], ['Wire keyboard shortcut and focus return', 'todo'], ['Run tests and lint', 'todo']]),
      T.tool('read_file', 'docs/ux/states-and-indicators.md', '212 lines', '## Attention model\n- Needs reply: awaiting-approval, awaiting-input\n- Needs review: terminal and not viewed\n- Background: running or queued, not on screen'),
      T.tool('edit_file', 'packages/ui/src/inbox/classify.ts', '+61', 'export function classify(session, ctx) {\n  if (session.archived) return null;\n  ...\n}'),
      T.tool('run', 'pnpm vitest run inbox', '18 passed', ' ✓ classify › approval counts even when on screen\n ✓ classify › unviewed failure is review\n ✓ badge › caps at 99+\n\n Test Files  1 passed (1)\n      Tests  18 passed (18)'),
      T.agent('Classification is in place and tested. I delegated the exhaustive test matrix to a background agent and I am now building the popover.'),
    ];
    if (k === 'long') {
      const out = [T.user('Migrate the JSON event log to SQLite with a migration and a replay test. Keep the old reader until the replay test passes.')];
      const files = ['events.rs', 'migrations/0003_events.sql', 'legacy_json.rs', 'replay.rs', 'cursor.rs', 'lib.rs'];
      for (let i = 1; i <= 200; i++) {
        const f = files[i % files.length];
        out.push(T.agent(`Step ${i}: ${['Inspecting', 'Updating', 'Testing', 'Re-checking'][i % 4]} \`${f}\`. ${i % 5 === 0 ? 'The cursor must stay monotonic across restarts, so I am adding an assertion before the insert. ' : ''}${i % 7 === 0 ? 'This is a long line on purpose to check wrapping and reading comfort at the transcript measure; it should never cause horizontal scrolling of the whole column.' : ''}`));
        out.push(T.tool(i % 3 === 0 ? 'run' : i % 3 === 1 ? 'read_file' : 'edit_file', i % 3 === 0 ? 'cargo test -p store' : 'crates/store/src/' + f, i % 3 === 0 ? `${30 + (i % 12)} passed` : `${40 + i} lines`, `output for step ${i}\n` + 'line\n'.repeat(1 + (i % 6))));
        if (i % 22 === 0) out.push(T.user(`Checkpoint ${i / 22}: looks good, continue.`));
      }
      out.push({ t: 'done', summary: 'Event log now lives in SQLite (migration 0003). Replay test covers restart with a persisted cursor. Legacy JSON reader removed after the replay test passed.', changes: 'sqlite' });
      return out;
    }
    if (k === 'approval') return [
      T.user('The worktree cleanup test is flaky on Windows. Find out why and fix it.'),
      T.tool('run', 'cargo test -p integrations cleanup -- --nocapture', '1 failed', 'thread \'cleanup_removes_stale\' panicked: Access is denied. (os error 5)'),
      T.agent('The stale worktree from a previous run still holds a file handle. I would like to remove it before re-running the test.'),
      { t: 'approval', op: 'Run command', cmd: 'git worktree remove --force ../wt/fix-flake-old', why: 'Deletes a worktree directory and discards any uncommitted changes in it.', scope: 'acp-adapter · ../wt/fix-flake-old', policy: 'Destructive Git operation — always requires approval' },
    ];
    if (k === 'question') return [
      T.user('Draft a README section describing which ACP capabilities the adapter supports.'),
      T.agent('Before I write it: the fixtures include both stable v1 and the v2 draft messages.'),
      { t: 'question', text: 'Should the README describe ACP v1 only, or also the v2 draft?', choices: ['v1 only', 'v1 and v2 draft (marked experimental)'] },
    ];
    if (k === 'interrupted') return [
      T.user('Add a docs lint job to CI.'),
      T.tool('edit_file', '.github/workflows/docs.yml', '+28', 'name: docs\non: [pull_request]\n...'),
      T.agent('Workflow file added. Running the linter locally next.'),
      { t: 'notice', tone: 'neutral', icon: 'stInterrupted', title: 'Interrupted — AgentDock restarted while this session was running', body: 'The timeline above is restored from local history. This agent did not advertise session reattach (session/load), so the previous agent process cannot be resumed. Nothing was re-run automatically.', actions: ['Start a new session from this history', 'Close session'] },
    ];
    if (k === 'quota') return [
      T.user('Run the baseline benchmark on the 12 fixture tasks.'),
      T.tool('run', 'bench run --suite fixtures --config baseline', 'task 7/12', 'task 1 ok\n...\ntask 7 ok'),
      { t: 'notice', tone: 'danger', icon: 'stQuota', title: 'Quota limit — the provider rejected the request', body: 'Codex reported a usage-limit error. Reset time was not provided by the provider, so AgentDock shows it as unknown. Tasks 8–12 did not run.', actions: ['Retry now', 'Switch this task to another agent', 'View raw error'] },
    ];
    if (k === 'remote') return [
      { t: 'notice', tone: 'neutral', icon: 'kindRemote', title: 'Remote task on lab-vm', body: 'This task runs on the remote worker and keeps running if you close AgentDock. Connection: connected · last event 4 s ago.' },
      T.user('Regenerate all chapter 4 figures with the corrected normalisation.'),
      T.plan([['Re-run ablation batches 1–5', 'active'], ['Regenerate figures', 'todo'], ['Diff figure checksums', 'todo']]),
      T.tool('run', 'python run_ablation.py --batch 3', 'running', 'epoch 4/10 loss=0.412'),
    ];
    if (k === 'child-explore') return [
      T.user('(Delegated by parent) Map how sessions and their states are modelled today.'),
      T.tool('search', '"SessionState" in crates/', '14 matches', 'crates/core/src/session.rs:12 pub enum SessionState {'),
      { t: 'done', summary: 'Sessions have 8 states; "waiting" covers both approval and question. Recommend splitting into awaiting-approval and awaiting-input so the inbox can label them.', changes: null },
    ];
    if (k === 'child-tests') return [
      T.user('(Delegated by parent) Write the exhaustive test matrix for classify().'),
      T.tool('edit_file', 'packages/ui/src/inbox/classify.test.ts', '+97', 'describe("classify", () => { ... })'),
      T.tool('run', 'pnpm vitest run inbox', 'running', '…'),
    ];
    if (k === 'child-review') return [
      { t: 'notice', tone: 'neutral', icon: 'stQueued', title: 'Queued', body: 'Starts when the implementation session reports completion. Uses a fresh context and read-only permissions.' },
    ];
    if (k === 'child-failed') return [
      T.user('(Delegated by parent) Collect capability flags from all fixtures.'),
      T.tool('run', 'node scripts/collect-caps.mjs fixtures/', 'exit 1', 'Error: ENOENT fixtures/v2/initialize.json', 'error'),
      { t: 'notice', tone: 'danger', icon: 'stFailed', title: 'Failed — command exited with code 1', body: 'Failed sub-tasks are never archived automatically. Open the parent to decide whether to retry.', actions: ['Retry', 'Archive'] },
    ];
    if (k === 'bypass') return [
      { t: 'notice', tone: 'neutral', icon: 'enfOff', title: 'Permission mode: full access — reported by the adapter', body: 'From here on the agent runs its own tools without sending permission requests to AgentDock. The events below are shown as the agent reported them; none of them was checked against AgentDock approval rules.' },
      T.user('Rename the fixture files to kebab-case and update every import.'),
      T.tool('run', 'git mv fixtures/initV1.json fixtures/init-v1.json', 'exit 0', 'renamed fixtures/initV1.json -> fixtures/init-v1.json'),
      T.tool('edit_file', 'crates/adapter/tests/handshake.rs', '+6 −6', 'include_str!("../../fixtures/init-v1.json")'),
      T.tool('run', 'cargo test -p adapter handshake', '12 passed', 'test result: ok. 12 passed; 0 failed'),
      T.agent('Renamed 9 of 14 fixtures so far. Continuing with the v2 draft fixtures.'),
    ];
    if (k === 'new') return [T.user(s.objective || 'New task')];
    return [T.user('Archived example task.'), T.agent('Done. This session is archived and only reachable through search.')];
  }
  const transcriptOf = s => state.transcripts[s.id] || (state.transcripts[s.id] = buildTranscript(s));

  function renderEvent(e, s) {
    switch (e.t) {
      case 'user': return `<div class="ev ev-user"><span class="sr-only">You said: </span>${esc(e.text)}</div>`;
      case 'agent': return `<div class="ev ev-agent"><div class="ev-label">${monogram(s.agent)}<span>${esc(s.agent)}</span></div><p>${esc(e.text).replace(/`([^`]+)`/g, '<code>$1</code>')}</p></div>`;
      case 'tool': {
        const err = e.status === 'error';
        return `<details class="ev card tool"><summary><span class="caret">${icon('chevronRight')}</span>${icon('tool')}<span class="tool-name">${esc(e.name)}</span><span class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.arg)}</span><span class="tool-meta">${err ? '<span class="st" data-tone="danger">' + icon('stFailed') + '</span> ' : ''}${esc(e.meta)}</span></summary><pre>${esc(e.out)}</pre></details>`;
      }
      case 'plan': return `<div class="ev card"><div class="card-head">${icon('plan')}<span class="card-title">Plan</span><span class="muted">${e.steps.filter(x => x[1] === 'done').length}/${e.steps.length} done</span></div><div class="card-body"><ol class="plan-list">${e.steps.map(([txt, st]) => `<li>${st === 'done' ? '<span class="st" data-tone="success">' + icon('stDone') + '</span>' : st === 'active' ? '<span class="st st-spin" data-tone="running">' + icon('stRunning') + '</span>' : '<span class="st" data-tone="neutral">' + icon('stQueued') + '</span>'}<span>${esc(txt)}</span><span class="sr-only">(${st === 'done' ? 'done' : st === 'active' ? 'in progress' : 'not started'})</span></li>`).join('')}</ol></div></div>`;
      case 'approval': {
        const resolved = e.result ? `<p class="resolved">${e.result === 'approved' ? '<span class="st" data-tone="success">' + icon('stDone') + '</span> Approved once by you' : '<span class="st" data-tone="danger">' + icon('stCancelled') + '</span> Denied by you — the command was not run'}</p>` : '';
        return `<div class="ev card" data-tone="${e.result ? 'neutral' : 'attention'}" id="approval-card" role="group" aria-labelledby="approval-title"><div class="card-head"><span class="st" data-tone="attention">${icon('stApproval')}</span><span class="tone-label">${e.result ? 'Resolved' : 'Approval required'}</span></div><div class="card-body"><p class="card-title" id="approval-title">${esc(e.op)}</p><code class="cmd">${esc(e.cmd)}</code><div class="kv"><span>Effect</span><span>${esc(e.why)}</span><span>Scope</span><span>${esc(e.scope)}</span><span>Rule</span><span>${esc(e.policy)}</span></div>${e.result ? resolved : `<div class="card-actions"><button class="btn btn-primary" type="button" data-approve="yes">Approve once</button><button class="btn" type="button" data-approve="no">Deny</button><span class="muted" style="align-self:center;font-size:var(--ad-text-xs)">Enforced by AgentDock, not by the agent prompt.</span></div>`}</div></div>`;
      }
      case 'question': return `<div class="ev card" data-tone="${e.answered ? 'neutral' : 'attention'}" role="group" aria-labelledby="q-title"><div class="card-head"><span class="st" data-tone="attention">${icon('stQuestion')}</span><span class="tone-label">${e.answered ? 'Answered' : 'Question for you'}</span></div><div class="card-body"><p class="card-title" id="q-title">${esc(e.text)}</p>${e.answered ? `<p class="resolved">You answered: ${esc(e.answered)}</p>` : `<div class="card-actions">${e.choices.map(c => `<button class="btn" type="button" data-answer="${esc(c)}">${esc(c)}</button>`).join('')}<span class="muted" style="align-self:center;font-size:var(--ad-text-xs)">or type a reply below</span></div>`}</div></div>`;
      case 'notice': return `<div class="ev card" data-tone="${e.tone}" role="note"><div class="card-head"><span class="st" data-tone="${e.tone}">${icon(e.icon)}</span><span class="card-title">${esc(e.title)}</span></div><div class="card-body"><p>${esc(e.body)}</p>${e.actions ? `<div class="card-actions">${e.actions.map((a, i) => `<button class="btn${i === 0 ? ' btn-primary' : ''}" type="button" data-notice-action="${esc(a)}">${esc(a)}</button>`).join('')}</div>` : ''}</div></div>`;
      case 'done': {
        const files = e.changes ? AD.changes[e.changes] : null;
        const add = files ? files.reduce((a, f) => a + f.add, 0) : 0, del = files ? files.reduce((a, f) => a + f.del, 0) : 0;
        return `<div class="ev card" data-tone="success" role="note"><div class="card-head"><span class="st" data-tone="success">${icon('stDone')}</span><span class="tone-label">Completed</span></div><div class="card-body"><p>${esc(e.summary)}</p>${files ? `<div class="card-actions"><button class="btn btn-primary" type="button" data-open-review>Review changes · ${files.length} files <span class="diffstat-add">+${add}</span> <span class="diffstat-del">−${del}</span></button><span class="muted" style="align-self:center;font-size:var(--ad-text-xs)">Checks: 2 passed · 1 failed · 1 not run</span></div>` : ''}</div></div>`;
      }
    }
    return '';
  }

  /* ------------------------------------------------------------------ */
  /* Sidebar tree                                                        */
  /* ------------------------------------------------------------------ */
  function rowHtml(s, level, opts) {
    const st = statusOf(s), k = kindOf(s), p = projectOf(s);
    const kids = level === 2 ? childrenOf(s.id) : [];
    const liveKids = kids.filter(c => !c.archived);
    const hasKids = kids.length > 0;
    const expanded = hasKids && state.expanded.has(s.id);
    const current = state.view === 'session' && state.currentId === s.id;
    const unread = !current && s.unread > 0;
    const kidNeeds = liveKids.filter(c => classify(c) === 'reply').length;
    const kidNew = liveKids.filter(c => classify(c) === 'review').length;
    const kidRun = liveKids.filter(c => c.state === 'running').length;
    let sub = '';
    if (hasKids && !expanded) {
      const parts = [];
      if (kidNeeds) parts.push(kidNeeds + ' need you');
      if (kidNew) parts.push(kidNew + ' new');
      if (kidRun) parts.push(kidRun + ' running');
      if (parts.length) sub = `<span class="tree-sub">${parts.join(' · ')}</span>`;
    }
    const srBits = [st.label, k.label, notEnforced(s) ? 'policy not enforced' : '', unread ? s.unread + ' new' : '', opts && opts.showProject ? 'project ' + p.name : '', hasKids ? liveKids.length + ' sub-tasks' : '', 'updated ' + agoLong(s.updated)].filter(Boolean).join(', ');
    return `<div class="tree-row" role="treeitem" id="row-${s.id}" data-id="${s.id}" data-level="${level}" aria-level="${level}" tabindex="-1"
      ${hasKids ? `aria-expanded="${expanded}"` : ''} ${current ? 'aria-current="page"' : ''} aria-selected="${current}" data-unread="${unread}" data-archived="${!!s.archived}"
      aria-label="${esc(s.title)}. ${esc(srBits)}">
      <span class="tree-caret" data-caret>${hasKids ? icon(expanded ? 'chevronDown' : 'chevronRight') : ''}</span>
      ${s.archived ? `<span class="st" data-tone="neutral" title="Archived">${icon('stArchived')}</span>` : stIcon(s)}
      <span class="tree-title">${esc(s.title)}${opts && opts.showProject ? ` <span class="tree-sub">· ${esc(p.name)}</span>` : ''}</span>
      ${sub}
      <span class="tree-meta">${unread ? `<span class="new-pill">${s.unread} new</span>` : ''}${enfIcon(s)}${s.kind !== 'local' ? kindIcon(s) : ''}${kidNeeds && !expanded ? `<span class="st" data-tone="attention" title="A sub-task needs you">${icon('stApproval')}</span>` : ''}<span>${ago(s.updated)}</span></span>
    </div>`;
  }
  function childRows(s) {
    if (!state.expanded.has(s.id)) return '';
    const kids = childrenOf(s.id);
    let html = kids.filter(c => !c.archived).sort((a, b) => a.updated - b.updated).map(c => rowHtml(c, 3)).join('');
    const arch = kids.filter(c => c.archived);
    if (arch.length) {
      const open = state.showArchived.has(s.id);
      html += `<div class="tree-row tree-more" role="treeitem" aria-level="3" data-level="3" tabindex="-1" id="arch-${s.id}" data-archived-toggle="${s.id}" aria-expanded="${open}">
        <span class="tree-caret">${icon(open ? 'chevronDown' : 'chevronRight')}</span>${icon('archive')}<span class="tree-title">${open ? 'Hide' : 'Show'} ${arch.length} archived sub-task${arch.length > 1 ? 's' : ''}</span></div>`;
      if (open) html += arch.map(c => rowHtml(c, 3)).join('');
    }
    return html;
  }
  function groupRow(id, label, count, extra) {
    const collapsed = state.collapsedGroups.has(id);
    return `<div class="tree-row" role="treeitem" aria-level="1" data-level="1" tabindex="-1" id="grp-${id}" data-group="${id}" aria-expanded="${!collapsed}">
      <span class="tree-caret">${icon(collapsed ? 'chevronRight' : 'chevronDown')}</span><span class="tree-title">${esc(label)}</span>${extra || ''}<span class="tree-meta">${count}</span></div>`;
  }
  function renderTree() {
    const tree = $('#tree');
    // Live updates re-render the tree; keep keyboard focus on the same row.
    const hadFocus = tree.contains(document.activeElement) ? document.activeElement.id : null;
    const pinned = sessions.filter(s => s.pinned && !s.parentId && !s.archived);
    let html = groupRow('pinned', 'Pinned', pinned.length, `<span class="tree-sub">Alt+1…${Math.min(9, pinned.length)}</span>`);
    if (!state.collapsedGroups.has('pinned')) for (const s of pinned) html += rowHtml(s, 2, { showProject: true }) + childRows(s);
    for (const p of AD.projects) {
      const mains = sessions.filter(s => s.projectId === p.id && !s.parentId && !s.pinned && !s.archived);
      const needs = sessions.filter(s => s.projectId === p.id && classify(s) === 'reply').length;
      html += groupRow(p.id, p.name, mains.length, `${p.remote ? `<span class="kind" data-kind="remote" title="Remote project on ${esc(p.remote)}">${icon('kindRemote')}</span>` : ''}${needs ? `<span class="st" data-tone="attention" title="${needs} need you">${icon('stApproval')}</span>` : ''}`);
      if (!state.collapsedGroups.has(p.id)) {
        for (const s of mains.sort((a, b) => a.updated - b.updated)) html += rowHtml(s, 2) + childRows(s);
        const archivedMains = sessions.filter(s => s.projectId === p.id && !s.parentId && s.archived).length;
        if (archivedMains) html += `<div class="tree-row tree-more" role="treeitem" aria-level="2" data-level="2" tabindex="-1" id="parch-${p.id}" data-project-archive="${p.id}"><span class="tree-caret"></span>${icon('search')}<span class="tree-title">${archivedMains} archived — search with Ctrl+K</span></div>`;
      }
    }
    tree.innerHTML = html;
    // roving tabindex
    const rows = visibleRows();
    let target = rows.find(r => r.id === state.focusRow) || rows.find(r => r.getAttribute('aria-current') === 'page') || rows[0];
    if (target) target.tabIndex = 0;
    if (hadFocus) { const r = document.getElementById(hadFocus) || target; if (r) { rows.forEach(x => x.tabIndex = -1); r.tabIndex = 0; r.focus(); } }
  }
  const visibleRows = () => $$('#tree [role="treeitem"]');

  /* ------------------------------------------------------------------ */
  /* Top bar: inbox badge, usage flag, theme                            */
  /* ------------------------------------------------------------------ */
  function renderTopbar() {
    const m = inboxModel();
    const reply = m.reply.length, review = m.review.length, bg = m.background.length;
    const count = reply + review;
    const badge = $('#inbox-badge');
    const btn = $('#btn-inbox');
    $('#inbox-icon').innerHTML = icon(reply ? 'bellAlert' : 'bell');
    if (count) {
      badge.hidden = false;
      badge.textContent = (reply ? '!' : '') + (count > 99 ? '99+' : count);
      badge.dataset.level = reply ? 'reply' : 'review';
    } else badge.hidden = true;
    btn.dataset.level = reply ? 'reply' : count ? 'review' : 'none';
    $('#inbox-bg').hidden = bg === 0;
    $('#inbox-bg').innerHTML = icon('stRunning');
    $('#inbox-label').textContent = `Inbox: ${reply} need reply, ${review} to review, ${bg} running in background`;
    btn.title = `Inbox (Ctrl+Shift+J) — ${reply} need reply · ${review} to review · ${bg} background`;
    const high = AD.accounts.some(a => a.meter && a.meter.pct >= 80);
    const flag = $('#usage-flag');
    flag.hidden = !high; flag.textContent = high ? '≥80%' : '';
    $('#btn-usage').setAttribute('aria-label', 'Usage' + (high ? ', one account above 80 percent of a reported limit' : ''));
  }
  const THEMES = ['system', 'light', 'dark'];
  function applyTheme(t) {
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    $('#theme-icon').innerHTML = icon(t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'contrast');
    $('#theme-label').textContent = 'Theme: ' + t + '. Activate to change.';
    $('#btn-theme').title = 'Theme: ' + t;
    try { localStorage.setItem('agentdock-proto-theme', t); } catch (_) { /* storage unavailable */ }
    state.theme = t;
  }

  /* ------------------------------------------------------------------ */
  /* Main views                                                          */
  /* ------------------------------------------------------------------ */
  function renderMain(opts) {
    if (state.view === 'home') return renderHome();
    if (state.view === 'project') return renderProject();
    if (state.view === 'settings') return renderSettings();
    renderSession(opts);
  }

  function diffTotals(key) {
    const f = AD.changes[key] || [];
    return { n: f.length, add: f.reduce((a, x) => a + x.add, 0), del: f.reduce((a, x) => a + x.del, 0) };
  }

  function renderSession(opts) {
    const s = byId(state.currentId);
    const p = projectOf(s), st = statusOf(s), k = kindOf(s);
    const parent = s.parentId ? byId(s.parentId) : null;
    const d = s.changes ? diffTotals(s.changes) : null;
    const running = s.state === 'running';
    $('#main').setAttribute('aria-label', 'Session: ' + s.title);
    $('#main').innerHTML = `
      <section class="session" aria-labelledby="session-title">
        <header class="session-head">
          <div class="session-head-text">
            <div class="crumbs">
              <span>${icon('folder')} ${esc(p.name)}</span><span class="sep">/</span>
              <span>${icon('branch')} ${esc(s.branch)}</span><span class="sep">·</span><span class="mono">${esc(s.worktree)}</span>
              ${parent ? `<span class="sep">·</span><button class="btn btn-quiet btn-sm" type="button" data-open="${parent.id}">Sub-task of “${esc(parent.title)}”</button>` : ''}
            </div>
            <h1 class="session-title" id="session-title" tabindex="-1">${esc(s.title)}</h1>
            <div class="chips">
              <span class="chip" data-tone="${st.tone}">${stIcon(s)}${esc(st.label)}</span>
              <span class="chip">${kindIcon(s)}${esc(k.label)}</span>
              <span class="chip">${monogram(s.agent)}${esc(s.agent)}${s.model ? ' · model ' + esc(s.model) : ''}</span>
              ${notEnforced(s) ? `<span class="chip" data-enf="off">${icon('enfOff')}Policy not enforced</span>` : ''}
              ${s.archived ? `<span class="chip"><span class="st" data-tone="neutral">${icon('stArchived')}</span>Archived</span>` : ''}
            </div>
          </div>
          <div class="head-actions">
            ${s.archived ? `<button class="btn" type="button" data-unarchive="${s.id}">${icon('archive')} Unarchive</button>` : ''}
            ${running ?`<button class="btn" type="button" data-stop>${icon('stop')} Stop</button>` : ''}
            ${d ? `<button class="btn" type="button" data-toggle-review aria-expanded="${state.reviewOpen}" aria-controls="review" aria-keyshortcuts="Control+Shift+G">${icon('sidebarRight')} Changes <span class="diffstat-add">+${d.add}</span><span class="diffstat-del">−${d.del}</span></button>` : `<button class="btn" type="button" data-toggle-review aria-expanded="${state.reviewOpen}" aria-controls="review">${icon('sidebarRight')} Changes · none</button>`}
          </div>
        </header>
        ${notEnforced(s) ? `<div class="enforce-note" id="enforce-note" role="note" aria-labelledby="enforce-title">${icon('enfOff')}<p><strong id="enforce-title">AgentDock policy is not enforced in this session.</strong> ${esc(s.agent)} is running in its own <span class="mono">${esc(s.agentMode || 'bypass')}</span> mode (${esc(s.modeSource || 'reported by the adapter')}): it runs commands and edits files without asking AgentDock, so approval rules do not apply to what the agent does. AgentDock still asks before the operations it performs itself (push, pull request, merge, worktree removal).</p></div>` : ''}
        <div class="attention-banner" id="attention-banner" hidden></div>
        <div class="timeline-wrap">
          <div class="timeline" id="timeline" role="log" aria-live="off" aria-label="Conversation with ${esc(s.agent)}" tabindex="0">
            <div class="timeline-inner" id="timeline-inner">${transcriptOf(s).map(e => renderEvent(e, s)).join('')}</div>
          </div>
          <button class="jump-pill" id="jump-pill" type="button" hidden>${icon('arrowDown')} <span id="jump-text">Jump to latest</span></button>
        </div>
        <form class="composer" id="composer" autocomplete="off">
          <div class="composer-inner">
            <div class="suggest-row" id="suggest-row"></div>
            <div class="composer-box">
              <div class="ghost" id="ghost" aria-hidden="true"></div>
              <textarea id="composer-input" rows="2" aria-label="Message to ${esc(s.agent)}" aria-describedby="composer-hint"
                placeholder="">${esc(state.drafts[s.id] || '')}</textarea>
              <div class="composer-foot">
                <span id="composer-hint">Enter to send · Shift+Enter for a new line · Tab or → inserts the suggestion</span>
                <span class="spacer"></span>
                <button class="btn btn-primary btn-sm" type="submit">${icon('send')} ${running ? 'Steer' : 'Send'}</button>
                ${running ? `<button class="btn btn-sm" type="button" data-stop>${icon('stop')} Stop</button>` : ''}
              </div>
            </div>
          </div>
        </form>
      </section>`;
    const tl = $('#timeline');
    if (opts && opts.keepScroll != null) tl.scrollTop = opts.keepScroll;
    else {
      // content-visibility estimates heights; settle at the real bottom.
      tl.scrollTop = tl.scrollHeight;
      requestAnimationFrame(() => { tl.scrollTop = tl.scrollHeight; requestAnimationFrame(() => { tl.scrollTop = tl.scrollHeight; }); });
    }
    state.newBelow = 0;
    tl.addEventListener('scroll', onTimelineScroll, { passive: true });
    renderSuggestions();
    updateBanner();
    if (state.reviewOpen) renderReview();
  }

  function renderSuggestions() {
    const s = byId(state.currentId);
    const list = (AD.suggestions[s.state] || []).slice(0, 3);
    const row = $('#suggest-row');
    if (!row) return;
    row.innerHTML = list.length ? `<span class="suggest-label" id="suggest-label">Suggested next:</span>` + list.map(t => `<button class="suggest-chip" type="button" data-suggest="${esc(t)}" aria-describedby="suggest-label">${esc(t)}</button>`).join('') : '';
    updateGhost();
  }
  function updateGhost() {
    const s = byId(state.currentId), ta = $('#composer-input'), ghost = $('#ghost');
    if (!ta || !ghost) return;
    const list = AD.suggestions[s.state] || [];
    const show = ta.value === '' && list.length && !state.ghostOff[s.id];
    ghost.innerHTML = show ? `${esc(list[0])}<kbd>Tab</kbd>` : '';
    ta.placeholder = show ? '' : s.state === 'running' ? 'Steer the agent… (it keeps working while you type)' : 'Message the agent…';
    ta.dataset.ghost = show ? list[0] : '';
  }

  function onTimelineScroll() {
    const tl = $('#timeline');
    if (atBottom(tl)) { state.newBelow = 0; $('#jump-pill').hidden = true; }
    updateBanner();
  }
  const atBottom = tl => tl.scrollHeight - tl.scrollTop - tl.clientHeight < 48;
  function updateBanner() {
    const s = byId(state.currentId), banner = $('#attention-banner'), card = $('#approval-card'), tl = $('#timeline');
    if (!banner) return;
    const pending = transcriptOf(s).find(e => (e.t === 'approval' || e.t === 'question') && !e.result && !e.answered);
    if (!pending || !tl) { banner.hidden = true; return; }
    const target = card || $('[aria-labelledby="q-title"]');
    let visible = false;
    if (target) { const r = target.getBoundingClientRect(), v = tl.getBoundingClientRect(); visible = r.bottom > v.top && r.top < v.bottom; }
    banner.hidden = visible;
    // The banner is only a pointer and may truncate; the full command is shown
    // only in the approval card ("Show" jumps there).
    banner.innerHTML = `<span class="st">${icon(pending.t === 'approval' ? 'stApproval' : 'stQuestion')}</span><p title="${esc(pending.t === 'approval' ? pending.cmd : pending.text)}"><strong>${pending.t === 'approval' ? 'Approval required' : 'Question for you'}:</strong> ${esc(pending.t === 'approval' ? pending.cmd : pending.text)}</p><button class="btn btn-sm" type="button" data-jump-pending>Show</button>`;
  }

  function appendEvent(s, e) {
    transcriptOf(s).push(e);
    if (state.view !== 'session' || state.currentId !== s.id) {
      if (e.t !== 'user') { s.unread = (s.unread || 0) + 1; }
      return;
    }
    const tl = $('#timeline'), inner = $('#timeline-inner');
    const follow = atBottom(tl);
    inner.insertAdjacentHTML('beforeend', renderEvent(e, s));
    if (follow) tl.scrollTop = tl.scrollHeight;
    else if (e.t !== 'user') {
      state.newBelow++;
      $('#jump-pill').hidden = false;
      $('#jump-text').textContent = `${state.newBelow} new below · Jump to latest`;
    }
    updateBanner();
  }

  function renderHome() {
    const m = inboxModel();
    $('#main').setAttribute('aria-label', 'Home');
    const listOf = (arr, empty) => arr.length ? `<ul class="list">${arr.map(s => `<li><button class="list-btn" type="button" data-open="${s.id}">${stIcon(s)}<span class="grow"><span>${esc(s.title)}</span><br><span class="muted" style="font-size:var(--ad-text-xs)">${esc(statusOf(s).label)} · ${esc(projectOf(s).name)}${s.parentId ? ' · sub-task' : ''}${notEnforced(s) ? ' · policy not enforced' : ''}</span></span>${enfIcon(s)}${kindIcon(s)}<span class="muted">${ago(s.updated)}</span></button></li>`).join('')}</ul>` : `<p class="list-empty list">${empty}</p>`;
    const repo = state.homeRepo ? AD.projects.find(p => p.id === state.homeRepo) : null;
    $('#main').innerHTML = `<div class="page"><div class="page-inner">
      <div><h1 id="home-title" tabindex="-1">Home</h1><p class="muted">Pick a repository and describe the task. AgentDock creates a worktree per task.</p></div>
      <section aria-labelledby="h-new">
        <h2 id="h-new">${icon('plus')} Start a task</h2>
        <div class="repo-grid" role="group" aria-label="Recent repositories">
          ${AD.projects.map(p => `<button class="repo-card" type="button" data-pick-repo="${p.id}" aria-pressed="${state.homeRepo === p.id}"><strong>${p.remote ? icon('kindRemote') : icon('folder')} ${esc(p.name)}</strong><span class="muted mono" style="font-size:var(--ad-text-xs)">${esc(p.path)}</span><span class="muted" style="font-size:var(--ad-text-xs)">${icon('branch')} ${esc(p.branch)}${p.dirty ? ` · ${p.dirty} uncommitted` : ' · clean'} · default agent ${esc(p.defaultAgent)}</span></button>`).join('')}
        </div>
        <form class="newtask" id="newtask" ${repo ? '' : 'hidden'}>
          <label for="newtask-input"><strong>Task for ${repo ? esc(repo.name) : ''}</strong></label>
          <textarea id="newtask-input" placeholder="Describe the task, or paste a GitHub Issue URL"></textarea>
          <div class="newtask-row"><span>${monogram(repo ? repo.defaultAgent : 'A')} ${repo ? esc(repo.defaultAgent) : ''}</span><span>${icon('branch')} new worktree from ${repo ? esc(repo.branch) : ''}</span><span>${icon('kindLocal')} Local task</span><span style="flex:1"></span><button class="btn btn-primary" type="submit">Start task <kbd class="kbd-inline">Enter</kbd></button></div>
        </form>
      </section>
      <section aria-labelledby="h-needs"><h2 id="h-needs"><span class="st" data-tone="attention">${icon('stApproval')}</span> Needs you <span class="muted">${m.reply.length + m.review.length}</span></h2>${listOf(m.reply.concat(m.review), 'Nothing is waiting for you.')}</section>
      <section aria-labelledby="h-run"><h2 id="h-run"><span class="st st-spin" data-tone="running">${icon('stRunning')}</span> Running <span class="muted">${m.background.length}</span></h2>${listOf(m.background, 'No background work.')}</section>
    </div></div>`;
  }

  function renderProject() {
    const p = AD.projects.find(x => x.id === state.projectId);
    const list = sessions.filter(s => s.projectId === p.id && !s.archived);
    $('#main').setAttribute('aria-label', 'Project ' + p.name);
    $('#main').innerHTML = `<div class="page"><div class="page-inner">
      <div><p class="muted">${icon('folder')} Project</p><h1 id="project-title" tabindex="-1">${esc(p.name)}</h1><p class="muted mono">${esc(p.path)} · ${icon('branch')} ${esc(p.branch)} · ${p.dirty ? p.dirty + ' uncommitted files' : 'clean'}</p></div>
      <section aria-labelledby="h-rt"><h2 id="h-rt">Runtime</h2><div class="newtask-row"><label>Default agent <select><option>${esc(p.defaultAgent)}</option><option>Codex</option><option>Mock agent (CI)</option></select></label><span>${p.remote ? icon('kindRemote') + ' Runs on ' + esc(p.remote) : icon('kindLocal') + ' Runs on this computer'}</span></div></section>
      <section aria-labelledby="h-wt"><h2 id="h-wt">Worktrees</h2><table class="tbl"><thead><tr><th>Worktree</th><th>Branch</th><th>Sessions</th><th>State</th></tr></thead><tbody>
        ${[...new Set(list.map(s => s.worktree))].map(w => { const ss = list.filter(s => s.worktree === w); return `<tr><td class="mono">${esc(w)}</td><td class="mono">${esc(ss[0].branch)}</td><td>${ss.length}</td><td>${ss.map(s => stIcon(s)).join(' ')} ${esc(statusOf(ss[0]).label)}</td></tr>`; }).join('')}
      </tbody></table></section>
      <section aria-labelledby="h-ss"><h2 id="h-ss">Sessions</h2><ul class="list">${list.map(s => `<li><button class="list-btn" type="button" data-open="${s.id}">${stIcon(s)}<span class="grow">${esc(s.title)}${s.parentId ? ' <span class="muted">(sub-task)</span>' : ''}${notEnforced(s) ? ' <span class="muted">· policy not enforced</span>' : ''}</span>${enfIcon(s)}${kindIcon(s)}<span class="muted">${ago(s.updated)}</span></button></li>`).join('')}</ul></section>
    </div></div>`;
  }

  function renderSettings() {
    const tabs = [['agents', 'Agents & adapters'], ['accounts', 'Accounts & usage'], ['env', 'Environments'], ['perm', 'Permissions'], ['appearance', 'Appearance'], ['keys', 'Keyboard']];
    $('#main').setAttribute('aria-label', 'Settings');
    let body = '';
    if (state.settingsTab === 'agents') body = `<table class="tbl"><thead><tr><th>Adapter</th><th>Status</th><th>Session reattach</th><th>Cancel</th><th>Permission mode</th></tr></thead><tbody>
      <tr><td>${monogram('Claude Code')} Claude Code (ACP)</td><td><span class="st" data-tone="success">${icon('stDone')}</span> Detected</td><td>Not advertised</td><td>Supported</td><td>Reported</td></tr>
      <tr><td>${monogram('Codex')} Codex (ACP)</td><td><span class="st" data-tone="danger">${icon('stAuth')}</span> Sign-in needed</td><td>Advertised</td><td>Supported</td><td>Reported</td></tr>
      <tr><td>${monogram('Mock agent')} Mock agent (CI)</td><td><span class="st" data-tone="success">${icon('stDone')}</span> Built in</td><td>Advertised</td><td>Supported</td><td>Not applicable</td></tr></tbody></table>
      <p class="muted" style="margin-top:var(--ad-space-5)">Capabilities come from the adapter handshake. Features the adapter does not advertise are hidden or shown as unavailable, never simulated.</p>
      <p class="muted" style="margin-top:var(--ad-space-4)">Permission mode: when an agent reports its own bypass or full-access mode, the session is labelled “Policy not enforced”. When an adapter does not report its mode, the session is labelled “Policy coverage unknown” — AgentDock never assumes it is being asked.</p>`;
    else body = `<p class="muted">Not prototyped. See docs/ux/information-architecture.md → Settings.</p>`;
    $('#main').innerHTML = `<div class="page"><div class="page-inner"><h1 id="settings-title" tabindex="-1">Settings</h1>
      <div class="settings-grid"><div class="settings-nav" role="navigation" aria-label="Settings sections">${tabs.map(([id, l]) => `<button type="button" data-settings="${id}" ${state.settingsTab === id ? 'aria-current="page"' : ''}>${esc(l)}</button>`).join('')}</div><div>${body}</div></div></div></div>`;
  }

  /* ------------------------------------------------------------------ */
  /* Review panel                                                        */
  /* ------------------------------------------------------------------ */
  function renderReview() {
    const el = $('#review');
    const s = state.view === 'session' ? byId(state.currentId) : null;
    if (!state.reviewOpen || !s) { el.hidden = true; syncScrim(); return; }
    el.hidden = false;
    const files = s.changes ? AD.changes[s.changes] : [];
    const d = s.changes ? diffTotals(s.changes) : { n: 0, add: 0, del: 0 };
    const failedChecks = AD.checks.filter(c => c.state === 'failed').length;
    const blocking = AD.findings.filter(f => f.sev === 'blocking').length;
    const tab = state.reviewTab;
    let panel = '';
    if (!files.length) panel = `<div class="pop-empty" style="padding:var(--ad-space-8)"><p><strong>No changes yet</strong></p><p>This worktree matches its base branch. Changes appear here as the agent edits files.</p></div>`;
    else if (tab === 'changes') {
      const f = files[Math.min(state.reviewFile, files.length - 1)];
      panel = `<ul class="file-list" role="list" aria-label="Changed files">${files.map((x, i) => `<li><button class="file-row" type="button" data-file="${i}" ${i === state.reviewFile ? 'aria-current="true"' : ''} aria-label="${esc(x.path)}, ${{ A: 'added', M: 'modified', D: 'deleted', R: 'renamed' }[x.status]}, ${x.add} additions, ${x.del} deletions"><span class="file-status" aria-hidden="true">${x.status}</span><span class="file-path"><bdi>${esc(x.path)}</bdi></span><span class="diffstat-add" aria-hidden="true">+${x.add}</span><span class="diffstat-del" aria-hidden="true">−${x.del}</span></button></li>`).join('')}</ul>
        <div class="diff" role="region" aria-label="Diff of ${esc(f.path)}" tabindex="0"><div class="diff-file">${esc(f.path)}</div>${AD.diffSample.map(l => `<div class="dl" data-t="${l.t}"><span class="sign" aria-hidden="true">${l.t === 'add' ? '+' : l.t === 'del' ? '−' : l.t === 'hunk' ? '' : ' '}</span><span>${l.t === 'add' ? '<span class="sr-only">added: </span>' : l.t === 'del' ? '<span class="sr-only">removed: </span>' : ''}${esc(l.s)}</span></div>`).join('')}</div>`;
    } else if (tab === 'checks') {
      panel = AD.checks.map(c => `<div class="check-row">${stIcon({ state: c.state, viewed: true })}<div><strong class="mono">${esc(c.name)}</strong><br><span class="muted">${esc(statusOf({ state: c.state, viewed: true }).label === 'Done' ? 'Passed' : statusOf({ state: c.state, viewed: true }).label)} · ${esc(c.detail)}</span></div></div>`).join('') + `<p class="pop-empty" style="padding:var(--ad-space-5) var(--ad-space-6)">Evidence is captured from commands the workbench ran. Results reported only in agent prose are not shown as checks.</p>`;
    } else {
      panel = AD.findings.map(f => `<div class="finding"><span class="sev" data-sev="${f.sev}">${f.sev === 'blocking' ? 'Blocking' : 'Suggestion'}</span><span>${esc(f.text)}</span></div>`).join('') + `<p class="pop-empty" style="padding:var(--ad-space-5) var(--ad-space-6)">From “Independent review (fresh context)” · Codex · read-only.</p>`;
    }
    el.innerHTML = `
      <div class="review-head"><div class="grow"><h2 id="review-title" tabindex="-1">Review changes</h2><p class="muted" style="font-size:var(--ad-text-xs)"><span class="mono">${esc(s.worktree)}</span> vs <span class="mono">main</span> · ${d.n} files <span class="diffstat-add">+${d.add}</span> <span class="diffstat-del">−${d.del}</span></p></div>
        <button class="icon-btn" type="button" data-close-review title="Close (Ctrl+Shift+G)"><span>${icon('x')}</span><span class="sr-only">Close review panel</span></button></div>
      <div class="tabs" role="tablist" aria-label="Review sections">
        ${[['changes', 'Changes', d.n], ['checks', 'Checks', failedChecks ? failedChecks + ' failed' : ''], ['findings', 'Findings', blocking ? blocking + ' blocking' : '']].map(([id, l, c]) => `<button class="tab" role="tab" type="button" id="tab-${id}" aria-selected="${tab === id}" aria-controls="tabpanel" tabindex="${tab === id ? 0 : -1}" data-tab="${id}">${l}${c !== '' && c !== 0 ? ` <span class="tab-count">${c}</span>` : ''}</button>`).join('')}
      </div>
      <div class="tabpanel" id="tabpanel" role="tabpanel" aria-labelledby="tab-${tab}">${panel}</div>
      <form class="review-foot" id="review-feedback"><label for="feedback-input" style="font-size:var(--ad-text-xs)" class="muted">Comment to the agent (sent into this session)</label><textarea id="feedback-input" placeholder="e.g. Rename classify() to sectionFor() and keep the tests"></textarea><div><button class="btn btn-sm" type="submit">${icon('comment')} Send to session</button></div></form>`;
    syncScrim();
  }

  /* ------------------------------------------------------------------ */
  /* Navigation                                                          */
  /* ------------------------------------------------------------------ */
  function announce(msg, assertive) {
    const el = $(assertive ? '#live-assertive' : '#live-polite');
    el.textContent = '';
    setTimeout(() => { el.textContent = msg; }, 30);
  }
  function toast(msg, action) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="btn btn-sm" type="button">${esc(action.label)}</button>` : ''}`;
    // A toast never takes focus with it when it disappears.
    const remove = () => { const had = t.contains(document.activeElement); t.remove(); if (had) focusFallback(); };
    if (action) t.querySelector('button').addEventListener('click', () => { action.run(); remove(); });
    $('#toasts').appendChild(t);
    setTimeout(() => { if (t.isConnected) remove(); }, 8000);
  }
  const treeVisible = () => mqNarrow.matches ? state.drawer === 'sidebar' : $('#app').dataset.sidebar !== 'closed';
  // Where focus goes when the element that should get it back cannot take it:
  // inside the open modal drawer if there is one, else the page heading.
  function focusFallback() {
    if (state.drawer === 'sidebar') return focusTree();
    if (reviewIsOverlay()) return $('#review-title').focus();
    const h = $('#session-title') || $('#main h1');
    (h || $('#main')).focus();
  }
  // Can this element take focus right now? Not when it is gone, hidden, inside
  // an inert region, or inside a sidebar drawer that is closed (or closing).
  function canFocus(el) {
    if (!el || el === document.body || !el.isConnected) return false;
    if (el.closest('[inert], [hidden]')) return false;
    if (el.closest('#sidebar') && !treeVisible()) return false;
    return true;
  }
  // Focus restore never ends on <body>: if the remembered element cannot take
  // focus (accessibility.md §2, "Focus return"), use the fallback target.
  function restoreFocus(el) {
    if (canFocus(el)) { el.focus(); if (document.activeElement === el) return; }
    focusFallback();
  }
  function focusRowOf(id) {
    const r = $('#row-' + id);
    if (!r || !treeVisible()) return false;
    visibleRows().forEach(x => { x.tabIndex = -1; });
    r.tabIndex = 0; state.focusRow = r.id; r.focus();
    return true;
  }
  // by 'user' (Undo, Unarchive): sets the "restored by user" flag, so the
  // sub-task is never auto-archived again. by 'system' (an archived session
  // starts waiting for the user; not reachable with the prototype data): the
  // flag is NOT set, so the sub-task can auto-archive again once its new result
  // has been opened (states-and-indicators.md §5).
  function unarchive(s, by) {
    s.archived = false;
    if (by !== 'system') s.restoredByUser = true;
    if (s.parentId) state.expanded.add(s.parentId);
  }
  const onScreen = s => state.view === 'session' && state.currentId === s.id;
  // "viewed" clears the inbox entry (opening, or Mark completed as reviewed).
  // "opened" is narrower: the result was rendered on screen after the session
  // entered its current terminal state. Only "opened" allows auto-archive.
  function markOpened(s) { if (TERMINAL.has(s.state)) { s.viewed = true; s.opened = true; } s.unread = 0; }
  function enterTerminal(s, st) { s.state = st; s.viewed = s.opened = onScreen(s); }
  // A new run invalidates an earlier "opened": the next result must be opened again.
  function enterRunning(s) { s.state = 'running'; s.opened = false; s.viewed = true; }

  function leaveSession(prev) {
    // Sub-task archive rule: completed/cancelled sub-tasks are archived only
    // after their result has been opened, and only when the user navigates
    // away (rows never disappear under the user's focus). "Mark reviewed"
    // alone never archives, and a sub-task the user restored stays restored.
    if (!prev || !prev.parentId || prev.archived || prev.restoredByUser) return;
    if ((prev.state === 'completed' || prev.state === 'cancelled') && prev.opened) {
      prev.archived = true;
      toast(`Archived sub-task “${prev.title}”`, {
        label: 'Undo',
        run: () => { unarchive(prev, 'user'); refresh(); if (!focusRowOf(prev.id)) focusFallback(); announce('Sub-task restored: ' + prev.title); },
      });
    }
  }

  function openSession(id, opts) {
    const s = byId(id);
    if (!s) return;
    const prev = state.view === 'session' ? byId(state.currentId) : null;
    if (prev && prev.id !== id) leaveSession(prev);
    if (prev && state.drafts && $('#composer-input')) state.drafts[prev.id] = $('#composer-input').value;
    state.view = 'session';
    state.currentId = id;
    state.mru = [id].concat(state.mru.filter(x => x !== id)).slice(0, 50);
    if (s.parentId) state.expanded.add(s.parentId);
    if (s.archived && s.parentId) state.showArchived.add(s.parentId);
    // Opening a session renders its latest output: viewed, and "opened".
    markOpened(s);
    state.focusRow = 'row-' + id;
    // Navigating closes every overlay: popovers and modal drawers. (A docked
    // review panel, >= 1280 px, is not an overlay and stays open.)
    dismissOverlays();
    refresh();
    announce(`${s.title}. ${statusOf(s).label}. ${kindOf(s).label}.`);
    const focusTarget = opts && opts.focus;
    if (focusTarget === 'composer') $('#composer-input').focus();
    else if (focusTarget === 'title') $('#session-title').focus();
  }
  function openView(view, extra) {
    const prev = state.view === 'session' ? byId(state.currentId) : null;
    if (prev) leaveSession(prev);
    state.view = view;
    if (view === 'project') state.projectId = extra;
    dismissOverlays();
    state.reviewOpen = false;
    refresh();
    const h = $('#main h1'); if (h) h.focus();
  }
  function refresh(opts) {
    renderTree();
    renderTopbar();
    renderMain(opts);
    renderReview();
    if (!$('#inbox-pop').hidden) renderInbox();
  }

  /* ------------------------------------------------------------------ */
  /* Drawers & panels (narrow layouts)                                   */
  /* ------------------------------------------------------------------ */
  const mqNarrow = window.matchMedia('(max-width: 959px)');
  const mqMedium = window.matchMedia('(max-width: 1279px)');
  let drawerReturn = null;
  const reviewIsOverlay = () => state.reviewOpen && mqMedium.matches && !$('#review').hidden;
  // Overlays are mutually exclusive (accessibility.md §2, "Overlays — one at a
  // time"). Before another overlay opens, or the user navigates, this closes
  // open popovers and modal drawers without moving focus, and returns the
  // closed overlay's own return target so the next overlay can inherit it (the
  // element focused inside the closed overlay is no longer a valid target).
  function dismissOverlays() {
    let carry = null;
    if (closePopovers(false)) carry = popReturn;
    if (state.drawer) { carry = drawerReturn; closeDrawer(false); }
    if (reviewIsOverlay()) { carry = reviewReturn; closeReview(); }
    return carry;
  }
  function toggleSidebar() {
    if (mqNarrow.matches) {
      if (state.drawer === 'sidebar') closeDrawer(true);
      else openDrawer('sidebar');
    } else {
      // The docked sidebar sits behind a review drawer (960-1279 px): close
      // that drawer first instead of toggling something inert.
      dismissOverlays();
      const app = $('#app');
      const closed = app.dataset.sidebar === 'closed';
      const hadFocus = $('#sidebar').contains(document.activeElement);
      app.dataset.sidebar = closed ? 'open' : 'closed';
      $('#btn-sidebar').setAttribute('aria-expanded', String(closed));
      if (closed) focusTree();
      else if (hadFocus || !canFocus(document.activeElement)) focusFallback(); // never leave focus in the hidden tree
    }
  }
  function openDrawer(which) {
    const carry = dismissOverlays();
    drawerReturn = carry || document.activeElement;
    state.drawer = which;
    $('#app').dataset.drawer = which;
    if (which === 'sidebar') { $('#btn-sidebar').setAttribute('aria-expanded', 'true'); setTimeout(focusTree, 20); }
    syncScrim();
  }
  function closeDrawer(restore) {
    const was = state.drawer;
    state.drawer = null;
    $('#app').dataset.drawer = '';
    if (was === 'sidebar') $('#btn-sidebar').setAttribute('aria-expanded', 'false');
    syncScrim();
    if (restore) restoreFocus(drawerReturn);
  }
  function syncScrim() {
    const reviewOverlay = reviewIsOverlay();
    const sidebarDrawer = state.drawer === 'sidebar';
    $('#scrim').hidden = !(sidebarDrawer || reviewOverlay);
    // Overlay drawers are modal: content underneath is inert (not focusable, not read).
    $('#topbar').inert = sidebarDrawer || reviewOverlay;
    $('.skip-link').inert = sidebarDrawer || reviewOverlay;
    $('#main').inert = sidebarDrawer || reviewOverlay;
    // The two drawers are never open together (dismissOverlays). If that ever
    // breaks, the sidebar drawer stays usable instead of everything going inert.
    $('#sidebar').inert = reviewOverlay && !sidebarDrawer;
    $('#review').inert = sidebarDrawer;
  }
  let reviewReturn = null;
  function closeReview() { // no focus handling; callers decide where focus goes
    state.reviewOpen = false;
    renderReview();
    $$('[data-toggle-review]').forEach(b => b.setAttribute('aria-expanded', 'false'));
  }
  function toggleReview(force) {
    if (state.view !== 'session') return;
    const open = force != null ? force : !state.reviewOpen;
    if (open === state.reviewOpen) { if (open) $('#review-title') && $('#review-title').focus(); return; }
    if (open) {
      const carry = dismissOverlays(); // popover or sidebar drawer
      reviewReturn = carry || document.activeElement;
      state.reviewOpen = true;
      renderReview();
      $$('[data-toggle-review]').forEach(b => b.setAttribute('aria-expanded', 'true'));
      $('#review-title').focus(); announce('Review panel opened');
    } else {
      closeReview();
      restoreFocus(canFocus(reviewReturn) ? reviewReturn : $('[data-toggle-review]'));
    }
  }
  mqNarrow.addEventListener('change', () => { if (!mqNarrow.matches && state.drawer) closeDrawer(false); $('#btn-sidebar').setAttribute('aria-expanded', String(!mqNarrow.matches && $('#app').dataset.sidebar !== 'closed')); });
  // Crossing 1280 px turns a docked review panel into a modal drawer (or back):
  // whatever had focus behind it is now inert, so move focus into the drawer.
  mqMedium.addEventListener('change', () => { syncScrim(); if (reviewIsOverlay() && !$('#review').contains(document.activeElement) && $('#switcher-overlay').hidden && $('#help-overlay').hidden) $('#review-title').focus(); });

  /* ------------------------------------------------------------------ */
  /* Inbox popover                                                       */
  /* ------------------------------------------------------------------ */
  let popReturn = null;
  function renderInbox() {
    const m = inboxModel();
    const row = (s, sub) => `<button class="inbox-row" type="button" data-open="${s.id}">${stIcon(s)}<span class="grow"><span class="t">${esc(s.title)}</span><span class="s">${esc(sub)}</span></span><span class="time">${ago(s.updated)}</span></button>`;
    const proj = s => projectOf(s).name + (s.parentId ? ' › ' + byId(s.parentId).title : '') + (notEnforced(s) ? ' · policy not enforced' : '');
    const replySub = s => (s.state === 'awaiting-approval' ? 'Approval' : 'Question') + (s.id === state.currentId && state.view === 'session' ? ' · on screen' : '') + ' · ' + proj(s);
    const kinds = ['local', 'background', 'remote'];
    const bgGroups = kinds.map(k => ({ k, items: m.background.filter(s => s.kind === k) })).filter(g => g.items.length);
    const pop = $('#inbox-pop');
    const hadFocus = pop.contains(document.activeElement);
    const focusedOpen = hadFocus ? document.activeElement.dataset.open : null;
    // "Mark reviewed" applies to completed/cancelled results only: failures and
    // interruptions need a decision, so they stay until opened.
    const markable = m.review.filter(s => s.state === 'completed' || s.state === 'cancelled').length;
    pop.innerHTML = `
      <div class="pop-head"><h2 id="inbox-title">Inbox</h2><span class="muted">${m.reply.length + m.review.length} need attention</span></div>
      <div class="pop-section" role="group" aria-labelledby="ib-reply"><h3 id="ib-reply"><span class="st" data-tone="attention">${icon('stApproval')}</span>Needs your reply <span class="count">(${m.reply.length})</span></h3>
        ${m.reply.length ? m.reply.map(s => row(s, replySub(s))).join('') : '<p class="pop-empty">No agent is waiting for you.</p>'}</div>
      <div class="pop-section" role="group" aria-labelledby="ib-review"><h3 id="ib-review"><span class="st" data-tone="success">${icon('stDoneNew')}</span>New results to review <span class="count">(${m.review.length})</span></h3>
        ${m.review.length ? m.review.map(s => row(s, statusOf(s).label + ' · ' + proj(s))).join('') : '<p class="pop-empty">You have seen every result.</p>'}
        ${markable ? `<div class="pop-actions"><button class="btn btn-quiet btn-sm" type="button" data-mark-all>Mark completed as reviewed (${markable})</button><span class="muted">Failed and interrupted stay until opened</span></div>` : ''}</div>
      <div class="pop-section" role="group" aria-labelledby="ib-bg"><h3 id="ib-bg"><span class="st st-spin" data-tone="running">${icon('stRunning')}</span>Running in background <span class="count">(${m.background.length})</span></h3>
        ${bgGroups.length ? bgGroups.map(g => `<div class="pop-sub">${icon({ local: 'kindLocal', background: 'kindBackground', remote: 'kindRemote' }[g.k])} ${{ local: 'Local tasks', background: 'Background agents', remote: 'Remote tasks' }[g.k]}</div>` + g.items.map(s => row(s, statusOf(s).label + ' · ' + kindOf(s).label + ' · ' + proj(s))).join('')).join('') : '<p class="pop-empty">Nothing is running.</p>'}</div>
      <div class="pop-foot"><kbd>Ctrl</kbd>+<kbd>J</kbd> opens the next item that needs you · <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Esc</kbd> close</div>`;
    if (hadFocus) {
      const again = (focusedOpen && pop.querySelector(`[data-open="${focusedOpen}"]`)) || pop.querySelector('.inbox-row') || pop;
      again.focus();
    }
  }
  function openPopover(id, btnId) {
    dismissOverlays(); // the top bar is inert under a modal drawer: replace the drawer
    popReturn = $('#' + btnId);
    if (id === 'inbox-pop') renderInbox(); else renderUsage();
    $('#' + id).hidden = false;
    $('#' + btnId).setAttribute('aria-expanded', 'true');
    focusPopover(id);
  }
  // Inbox: first row, never a header action. No rows (or usage): the popover itself.
  function focusPopover(id) {
    const pop = $('#' + id);
    const first = id === 'inbox-pop' ? pop.querySelector('.inbox-row') : null;
    (first || pop).focus();
  }
  function closePopovers(restore) {
    let closed = false;
    for (const [id, btn] of [['inbox-pop', 'btn-inbox'], ['usage-pop', 'btn-usage']]) {
      if (!$('#' + id).hidden) { $('#' + id).hidden = true; $('#' + btn).setAttribute('aria-expanded', 'false'); closed = true; }
    }
    if (closed && restore) restoreFocus(popReturn);
    return closed;
  }
  function renderUsage() {
    const srcLabel = { provider: 'Provider-reported', estimate: 'Estimated locally', unknown: 'Unknown', none: 'Not applicable', auth: 'Sign-in needed' };
    $('#usage-pop').innerHTML = `<div class="pop-head"><h2 id="usage-title">Connected accounts</h2></div>` + AD.accounts.map(a => `
      <div class="acct"><div class="acct-head">${monogram(a.agent)}<strong>${esc(a.agent)}</strong><span class="src" data-src="${a.source}">${a.source === 'unknown' ? '? ' : ''}${srcLabel[a.source]}</span></div>
      <small>${esc(a.account)}</small>
      ${a.meter ? `<div><div style="display:flex;justify-content:space-between;font-size:var(--ad-text-xs)"><span>${esc(a.meter.label)}</span><strong>${a.meter.pct}%${a.meter.pct >= 80 ? ' · high' : ''}</strong></div><div class="meter" data-high="${a.meter.pct >= 80}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${a.meter.pct}" aria-label="${esc(a.agent + ' ' + a.meter.label)}"><span style="width:${a.meter.pct}%"></span></div><small>${esc(a.meter.resets)} · updated ${esc(a.updated)}</small></div>` : a.source === 'unknown' ? `<div class="meter-unknown" aria-hidden="true"></div><small>Remaining quota: unknown</small>` : ''}
      ${a.session ? `<small>${esc(a.session.label)}: ${esc(a.session.value)}</small>` : ''}
      <small>${esc(a.note)}</small></div>`).join('') + `<div class="pop-foot">AgentDock never infers subscription quota. Numbers appear only when an adapter or provider reports them, labelled with their source.</div>`;
  }

  /* ------------------------------------------------------------------ */
  /* Quick switcher                                                      */
  /* ------------------------------------------------------------------ */
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  const graphemes = str => seg ? Array.from(seg.segment(str.normalize('NFC')), x => x.segment) : Array.from(str.normalize('NFC'));
  const fold = g => g.toLocaleLowerCase();
  function fuzzy(text, token) {
    const tg = graphemes(text), hay = tg.map(fold), q = graphemes(token).map(fold);
    if (!q.length) return { score: 0, pos: [] };
    // 1) contiguous substring, prefer word starts
    let best = -1;
    for (let i = 0; i + q.length <= hay.length; i++) {
      let ok = true;
      for (let j = 0; j < q.length; j++) if (hay[i + j] !== q[j]) { ok = false; break; }
      if (ok) { const ws = i === 0 || /[\s\-_/.]/.test(hay[i - 1]); if (best < 0 || ws) { best = i; if (ws) break; } }
    }
    if (best >= 0) {
      const ws = best === 0 || /[\s\-_/.]/.test(hay[best - 1]);
      return { score: 10 + q.length * 3 + (ws ? 8 : 0), pos: q.map((_, j) => best + j) };
    }
    // 2) ordered subsequence
    const pos = []; let i = 0, run = 0, score = 0;
    for (const c of q) {
      while (i < hay.length && hay[i] !== c) { i++; run = 0; }
      if (i >= hay.length) return null;
      pos.push(i); run++; score += 1 + run; i++;
    }
    return { score, pos };
  }
  function matchSession(s, tokens) {
    const p = projectOf(s).name;
    let total = 0; const tpos = new Set();
    for (const t of tokens) {
      const a = fuzzy(s.title, t), b = fuzzy(p, t);
      const as = a ? a.score * 1.5 : -1, bs = b ? b.score : -1;
      if (as < 0 && bs < 0) return null;
      if (as >= bs) { total += as; a.pos.forEach(x => tpos.add(x)); } else total += bs;
    }
    if (s.archived) total *= 0.6;
    return { score: total, pos: tpos };
  }
  const highlight = (text, pos) => graphemes(text).map((g, i) => pos.has(i) ? `<mark>${esc(g)}</mark>` : esc(g)).join('');

  let swReturn = null, swItems = [], swActive = 0;
  const SW_LIMIT = 100;
  function openSwitcher() {
    // Replaces a popover (focus goes back to its trigger first, so Cancel has
    // a valid return target). May open above a modal drawer: Cancel returns
    // into the drawer, Pick closes the drawer (openSession).
    closePopovers(true);
    swReturn = document.activeElement;
    $('#switcher-overlay').hidden = false;
    const inp = $('#switcher-input');
    inp.value = params.get('q') && !openSwitcher.used ? params.get('q') : '';
    openSwitcher.used = true;
    renderSwitcher();
    inp.focus();
  }
  function closeSwitcher(restore) {
    $('#switcher-overlay').hidden = true;
    if (restore) restoreFocus(swReturn);
  }
  function renderSwitcher() {
    const q = $('#switcher-input').value.trim();
    const list = $('#switcher-list');
    let groups = [];
    let more = 0;
    if (!q) {
      const used = new Set([state.currentId]);
      const take = arr => arr.filter(s => !used.has(s.id) && (used.add(s.id), true));
      const m = inboxModel();
      groups.push(['Needs your reply', take(m.reply)]);
      groups.push(['Recent', take(state.mru.map(byId).filter(s => s && !s.archived)).slice(0, 6)]);
      groups.push(['New results', take(m.review)]);
      groups.push(['Pinned', take(sessions.filter(s => s.pinned && !s.archived))]);
      groups.push(['Running', take(m.background)]);
      groups = groups.filter(g => g[1].length).map(([l, items]) => [l, items.map(s => ({ s, pos: new Set() }))]);
    } else {
      const tokens = q.split(/\s+/).filter(Boolean);
      const res = [];
      for (const s of sessions) { const r = matchSession(s, tokens); if (r) res.push({ s, pos: r.pos, score: r.score }); }
      res.sort((a, b) => b.score - a.score || a.s.updated - b.s.updated);
      more = Math.max(0, res.length - SW_LIMIT);
      groups = [['Results', res.slice(0, SW_LIMIT)]];
    }
    swItems = groups.flatMap(g => g[1]);
    swActive = Math.min(swActive, Math.max(0, swItems.length - 1));
    if (q !== renderSwitcher.lastQ) swActive = 0;
    renderSwitcher.lastQ = q;
    let idx = 0;
    list.innerHTML = swItems.length ? groups.map(([label, items]) => `<div role="group" aria-label="${esc(label)}"><div class="sw-group" aria-hidden="true">${esc(label)}</div>${items.map(({ s, pos }) => {
      const i = idx++; const st = statusOf(s);
      return `<div class="sw-opt" role="option" id="sw-${i}" data-i="${i}" aria-selected="${i === swActive}">${stIcon(s)}<span class="grow">${highlight(s.title, pos)} <span class="proj">· ${esc(projectOf(s).name)}${s.parentId ? ' › sub-task' : ''}</span></span>${s.pinned ? `<span class="sw-tag">${icon('pin')}<span class="sr-only">pinned</span></span>` : ''}${s.archived ? '<span class="sw-tag">archived</span>' : ''}${notEnforced(s) ? '<span class="sw-tag">policy not enforced</span>' : ''}<span class="sr-only">, ${esc(st.label)}, ${esc(kindOf(s).label)}</span>${s.kind !== 'local' ? kindIcon(s) : ''}<span class="tree-meta">${ago(s.updated)}</span></div>`;
    }).join('')}</div>`).join('') + (more ? `<div class="sw-more" role="note">${more} more not shown — refine the query</div>` : '')
      : `<div class="sw-more">No session matches “${esc(q)}”. Try fewer letters, or search inside transcripts (not prototyped).</div>`;
    syncSwitcherActive();
  }
  function syncSwitcherActive() {
    const inp = $('#switcher-input');
    $$('.sw-opt').forEach(o => o.setAttribute('aria-selected', String(+o.dataset.i === swActive)));
    const el = $('#sw-' + swActive);
    if (el) { inp.setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }); }
    else inp.removeAttribute('aria-activedescendant');
  }
  function pickSwitcher(i) {
    const it = swItems[i];
    if (!it) return;
    closeSwitcher(false);
    openSession(it.s.id, { focus: 'composer' });
  }

  /* ------------------------------------------------------------------ */
  /* Help dialog                                                         */
  /* ------------------------------------------------------------------ */
  const SHORTCUTS = [
    ['Navigation', [['Switch session / search', 'Ctrl+K'], ['Open inbox', 'Ctrl+Shift+J'], ['Next item that needs you', 'Ctrl+J'], ['Pinned session 1–9', 'Alt+1 … Alt+9'], ['Next / previous region', 'F6 / Shift+F6'], ['Toggle sidebar', 'Ctrl+B'], ['Toggle review panel', 'Ctrl+Shift+G'], ['New task (Home)', 'Alt+N  (app: Ctrl+N)'], ['Close popover, dialog or drawer', 'Esc']]],
    ['Sidebar tree', [['Move', '↑ ↓ Home End'], ['Expand / collapse', '→ ←'], ['Open session', 'Enter']]],
    ['Composer', [['Send (or steer while running)', 'Enter'], ['New line', 'Shift+Enter'], ['Insert suggested prompt', 'Tab or → (only while the suggestion is shown)'], ['Hide suggestion', 'Esc']]],
    ['This dialog', [['Show shortcuts', 'Ctrl+/']]],
  ];
  let helpReturn = null;
  function openHelp() {
    closePopovers(true);
    helpReturn = document.activeElement;
    $('#help-body').innerHTML = `<table>${SHORTCUTS.map(([g, rows]) => `<tr><th colspan="2">${esc(g)}</th></tr>` + rows.map(([a, k]) => `<tr><td>${esc(a)}</td><td><kbd>${esc(k)}</kbd></td></tr>`).join('')).join('')}</table><p class="muted" style="margin-top:var(--ad-space-5);font-size:var(--ad-text-xs)">There is deliberately no shortcut that approves an operation. Approvals need focus on the approval card's button.</p>`;
    $('#help-overlay').hidden = false;
    $('#help [data-close]').focus();
  }
  function closeHelp() { $('#help-overlay').hidden = true; restoreFocus(helpReturn); }

  /* ------------------------------------------------------------------ */
  /* Focus helpers                                                       */
  /* ------------------------------------------------------------------ */
  function focusTree() {
    const r = visibleRows().find(x => x.tabIndex === 0) || visibleRows()[0];
    if (r) r.focus();
  }
  // F6 regions: top bar → sidebar → conversation → composer → review panel.
  function regions() {
    // A modal drawer is the only region while it is open.
    if (state.drawer === 'sidebar') return [{ el: $('#sidebar'), focus: focusTree }];
    if (reviewIsOverlay()) return [{ el: $('#review'), focus: () => $('#review-title').focus() }];
    const out = [{ el: $('#topbar'), focus: () => $('#btn-sidebar').focus() }];
    if (treeVisible()) out.push({ el: $('#sidebar'), focus: focusTree });
    if (state.view === 'session') {
      out.push({ el: $('#main'), excl: $('#composer'), focus: () => $('#timeline').focus() });
      out.push({ el: $('#composer'), focus: () => $('#composer-input').focus() });
    } else out.push({ el: $('#main'), focus: () => { const h = $('#main h1'); if (h) h.focus(); } });
    if (state.reviewOpen && !$('#review').hidden) out.push({ el: $('#review'), focus: () => $('#review-title').focus() });
    return out;
  }
  function cycleRegion(back) {
    const rs = regions();
    const a = document.activeElement;
    const cur = rs.findIndex(r => r.el && r.el.contains(a) && !(r.excl && r.excl.contains(a)));
    const next = rs[((cur < 0 ? (back ? 0 : -1) : cur) + (back ? -1 : 1) + rs.length) % rs.length];
    next.focus();
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */
  document.addEventListener('click', e => {
    const t = e.target.closest('button, [role="treeitem"], .sw-opt, #scrim');
    // close popovers on outside click
    if (!e.target.closest('.popover, #btn-inbox, #btn-usage')) closePopovers(false);
    if (!t) return;
    if (t.id === 'scrim') { if (state.drawer) closeDrawer(true); else if (state.reviewOpen) toggleReview(false); return; }
    if (t.classList.contains('sw-opt')) return pickSwitcher(+t.dataset.i);
    if (t.matches('[role="treeitem"]')) return activateRow(t, e);
    const d = t.dataset;
    if (t.id === 'btn-sidebar') return toggleSidebar();
    if (t.id === 'btn-home' || t.id === 'btn-new') return openView('home');
    if (t.id === 'btn-settings') return openView('settings');
    if (t.id === 'btn-switcher') return openSwitcher();
    if (t.id === 'btn-help') return openHelp();
    if (t.id === 'btn-theme') return applyTheme(THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length]);
    if (t.id === 'btn-inbox') return $('#inbox-pop').hidden ? openPopover('inbox-pop', 'btn-inbox') : closePopovers(true);
    if (t.id === 'btn-usage') return $('#usage-pop').hidden ? openPopover('usage-pop', 'btn-usage') : closePopovers(true);
    if (d.close === 'help') return closeHelp();
    if (d.open) return openSession(d.open, { focus: 'title' });
    if (d.markAll !== undefined) {
      // Marks completed/cancelled results as reviewed. It never archives:
      // archiving needs the result to have been opened (states §5).
      const done = inboxModel().review.filter(s => s.state === 'completed' || s.state === 'cancelled').map(s => ({ s, unread: s.unread }));
      done.forEach(({ s }) => { s.viewed = true; s.unread = 0; });
      refresh();
      focusPopover('inbox-pop');
      announce(`Marked as reviewed: ${done.length}. Failed and interrupted results stay in the list.`);
      // Undo only revokes this acknowledgement. A result the user has opened
      // since (or a session that started running again) is left alone.
      toast(`Marked as reviewed: ${done.length}`, { label: 'Undo', run: () => { let back = 0; done.forEach(({ s, unread }) => { if (s.opened || !TERMINAL.has(s.state)) return; s.viewed = false; s.unread = unread; back++; }); refresh(); restoreFocus($('#btn-inbox')); announce(back ? `Restored to the review list: ${back}` : 'Nothing to restore: these results have been opened since'); } });
      return;
    }
    if (d.unarchive) { const s = byId(d.unarchive); unarchive(s, 'user'); refresh(); $('#session-title').focus(); announce('Unarchived: ' + s.title); return; }
    if (d.toggleReview !== undefined) return toggleReview();
    if (d.closeReview !== undefined) return toggleReview(false);
    if (d.openReview !== undefined) return toggleReview(true);
    if (d.tab) { state.reviewTab = d.tab; renderReview(); $('#tab-' + d.tab).focus(); return; }
    if (d.file) { state.reviewFile = +d.file; renderReview(); $(`[data-file="${d.file}"]`).focus(); return; }
    if (d.suggest) { const ta = $('#composer-input'); ta.value = d.suggest; ta.focus(); updateGhost(); return; }
    if (d.settings) { state.settingsTab = d.settings; renderSettings(); $(`[data-settings="${d.settings}"]`).focus(); return; }
    if (d.pickRepo) { state.homeRepo = d.pickRepo; renderHome(); $('#newtask-input').focus(); return; }
    if (d.jumpPending !== undefined) { const c = $('#approval-card') || $('[aria-labelledby="q-title"]'); c.scrollIntoView({ block: 'center' }); c.tabIndex = -1; c.focus(); return; } // focus the card, never the Approve button
    if (d.approve) return resolveApproval(d.approve === 'yes');
    if (d.answer) return answerQuestion(d.answer);
    if (d.stop !== undefined) { const s = byId(state.currentId); enterTerminal(s, 'cancelled'); appendEvent(s, { t: 'notice', tone: 'neutral', icon: 'stCancelled', title: 'Cancelled by you', body: 'The agent received a cancel request. Files already changed in the worktree are kept for review.' }); refresh({ keepScroll: $('#timeline').scrollTop }); announce('Session cancelled'); return; }
    if (d.noticeAction) { toast(`“${d.noticeAction}” is not prototyped.`); return; }
  });
  document.addEventListener('click', e => {
    if (e.target.closest('#jump-pill')) { const tl = $('#timeline'); tl.scrollTop = tl.scrollHeight; state.newBelow = 0; $('#jump-pill').hidden = true; tl.focus(); }
  });

  function activateRow(row, e) {
    state.focusRow = row.id;
    if (row.dataset.group) {
      const g = row.dataset.group;
      if (e && e.target.closest('[data-caret]') || g === 'pinned') { state.collapsedGroups.has(g) ? state.collapsedGroups.delete(g) : state.collapsedGroups.add(g); renderTree(); $('#' + row.id).focus(); return; }
      return openView('project', g);
    }
    if (row.dataset.archivedToggle) { const id = row.dataset.archivedToggle; state.showArchived.has(id) ? state.showArchived.delete(id) : state.showArchived.add(id); renderTree(); $('#' + row.id).focus(); return; }
    if (row.dataset.projectArchive) return openSwitcher();
    if (e && e.target.closest('[data-caret]') && row.hasAttribute('aria-expanded')) { toggleExpand(row); return; }
    // In the narrow drawer, choosing a session closes the drawer and moves
    // focus to the session heading; otherwise focus stays on the tree row.
    const fromDrawer = state.drawer === 'sidebar';
    openSession(row.dataset.id, fromDrawer ? { focus: 'title' } : undefined);
    if (!fromDrawer) { const r = $('#row-' + row.dataset.id); if (r) r.focus(); }
  }
  function toggleExpand(row, force) {
    const id = row.dataset.id || row.dataset.group;
    if (row.dataset.group) { const open = force != null ? force : state.collapsedGroups.has(id); open ? state.collapsedGroups.delete(id) : state.collapsedGroups.add(id); }
    else { const open = force != null ? force : !state.expanded.has(id); open ? state.expanded.add(id) : state.expanded.delete(id); }
    state.focusRow = row.id;
    renderTree();
    $('#' + row.id).focus();
  }

  $('#tree').addEventListener('keydown', e => {
    const rows = visibleRows();
    const i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    const row = rows[i];
    const move = j => { const r = rows[Math.max(0, Math.min(rows.length - 1, j))]; rows.forEach(x => x.tabIndex = -1); r.tabIndex = 0; state.focusRow = r.id; r.focus(); };
    const level = +row.getAttribute('aria-level');
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(i + 1); break;
      case 'ArrowUp': e.preventDefault(); move(i - 1); break;
      case 'Home': e.preventDefault(); move(0); break;
      case 'End': e.preventDefault(); move(rows.length - 1); break;
      case 'ArrowRight':
        e.preventDefault();
        if (row.getAttribute('aria-expanded') === 'false') { if (row.dataset.archivedToggle) activateRow(row); else toggleExpand(row, true); }
        else if (row.getAttribute('aria-expanded') === 'true') move(i + 1);
        break;
      case 'ArrowLeft': {
        e.preventDefault();
        if (row.getAttribute('aria-expanded') === 'true' && row.dataset.archivedToggle) activateRow(row);
        else if (row.getAttribute('aria-expanded') === 'true') toggleExpand(row, false);
        else { for (let j = i - 1; j >= 0; j--) if (+rows[j].getAttribute('aria-level') < level) { move(j); break; } }
        break;
      }
      case 'Enter': case ' ': e.preventDefault(); activateRow(row); break;
    }
  });

  // Inbox list keyboard: arrows move between rows, Tab cycles within.
  $('#inbox-pop').addEventListener('keydown', e => {
    const items = $$('#inbox-pop button');
    const rows = $$('#inbox-pop .inbox-row');
    const i = rows.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      const j = i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      rows[j].focus();
    } else if (e.key === 'Home' && rows.length) { e.preventDefault(); rows[0].focus(); }
    else if (e.key === 'End' && rows.length) { e.preventDefault(); rows[rows.length - 1].focus(); }
    else if (e.key === 'Tab') trapTab(e, items);
  });
  $('#usage-pop').addEventListener('keydown', e => { if (e.key === 'Tab') { e.preventDefault(); } });
  function trapTab(e, items) {
    if (!items.length) { e.preventDefault(); return; }
    const i = items.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); items[items.length - 1].focus(); }
    else if (!e.shiftKey && i === items.length - 1) { e.preventDefault(); items[0].focus(); }
  }

  $('#switcher-input').addEventListener('input', renderSwitcher);
  $('#switcher-input').addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return; // IME composition
    const n = swItems.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (n) { swActive = (swActive + 1) % n; syncSwitcherActive(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) { swActive = (swActive - 1 + n) % n; syncSwitcherActive(); } }
    else if (e.key === 'PageDown') { e.preventDefault(); swActive = Math.min(n - 1, swActive + 10); syncSwitcherActive(); }
    else if (e.key === 'PageUp') { e.preventDefault(); swActive = Math.max(0, swActive - 10); syncSwitcherActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); pickSwitcher(swActive); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSwitcher(true); } // Esc closes one layer, not the drawer underneath
    else if (e.key === 'Tab') { e.preventDefault(); } // modal: focus stays in the input
  });
  $('#switcher-overlay').addEventListener('mousedown', e => { if (e.target.id === 'switcher-overlay') { e.preventDefault(); closeSwitcher(true); } });
  $('#switcher-list').addEventListener('mousemove', e => { const o = e.target.closest('.sw-opt'); if (o && +o.dataset.i !== swActive) { swActive = +o.dataset.i; syncSwitcherActive(); } });
  $('#help-overlay').addEventListener('mousedown', e => { if (e.target.id === 'help-overlay') closeHelp(); });
  $('#help').addEventListener('keydown', e => { if (e.key === 'Tab') e.preventDefault(); });

  // Review tabs: arrow keys (APG tabs pattern)
  document.addEventListener('keydown', e => {
    if (!e.target.matches || !e.target.matches('.tab')) return;
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = $$('.tab'); const i = tabs.indexOf(e.target);
    const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    state.reviewTab = n.dataset.tab; renderReview(); $('#tab-' + n.dataset.tab).focus(); e.preventDefault();
  });

  // Composer: Enter sends, Tab accepts the visible suggestion only.
  document.addEventListener('keydown', e => {
    if (e.target.id !== 'composer-input') return;
    const ta = e.target;
    if (e.isComposing || e.keyCode === 229) return;
    // → is a secondary way to accept (empty input, so it never moves a caret).
    if ((e.key === 'Tab' && !e.shiftKey || e.key === 'ArrowRight' && !e.shiftKey && !e.ctrlKey && !e.altKey) && ta.dataset.ghost && ta.value === '') { e.preventDefault(); ta.value = ta.dataset.ghost; updateGhost(); announce('Suggestion inserted. Edit it or press Enter to send.'); return; }
    if (e.key === 'Escape' && ta.dataset.ghost) { e.preventDefault(); e.stopPropagation(); state.ghostOff[state.currentId] = true; updateGhost(); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  document.addEventListener('input', e => { if (e.target.id === 'composer-input') updateGhost(); });
  document.addEventListener('submit', e => {
    e.preventDefault();
    if (e.target.id === 'composer') {
      const ta = $('#composer-input'); const text = ta.value.trim(); if (!text) return;
      const s = byId(state.currentId); ta.value = ''; state.drafts[s.id] = '';
      appendEvent(s, T.user(text)); $('#timeline').scrollTop = $('#timeline').scrollHeight;
      const pending = transcriptOf(s).find(x => x.t === 'question' && !x.answered);
      if (pending) return answerQuestion(text);
      if (s.state !== 'running') { enterRunning(s); refresh(); $('#composer-input').focus(); }
      setTimeout(() => appendEvent(s, T.agent('(Prototype) Message received. A real adapter would stream its response here.')), 500);
      updateGhost();
    } else if (e.target.id === 'review-feedback') {
      const ta = $('#feedback-input'); const text = ta.value.trim(); if (!text) return;
      const s = byId(state.currentId); ta.value = '';
      appendEvent(s, T.user('Review comment: ' + text)); toast('Comment sent to the session');
    } else if (e.target.id === 'newtask') {
      startNewTask();
    }
  });
  document.addEventListener('keydown', e => {
    if (e.target.id === 'newtask-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); startNewTask(); }
  });

  function startNewTask() {
    const ta = $('#newtask-input'); const text = ta.value.trim();
    if (!text) { ta.focus(); announce('Describe the task first', true); return; }
    const p = AD.projects.find(x => x.id === state.homeRepo);
    const id = 'n' + Date.now();
    const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'task';
    const s = { id, projectId: p.id, parentId: null, title: text.length > 60 ? text.slice(0, 57) + '…' : text, objective: text, agent: p.defaultAgent, kind: p.remote ? 'remote' : 'local', host: p.remote, state: 'running', viewed: true, unread: 0, updated: 0, branch: 'task/' + slug, worktree: 'wt/' + slug, transcript: 'new', changes: null };
    sessions.push(s);
    openSession(id, { focus: 'title' });
    const steps = [
      () => appendEvent(s, T.tool('git', 'worktree add wt/' + slug + ' -b task/' + slug, 'created', 'Preparing worktree (new branch)')),
      () => appendEvent(s, T.agent('Reading the relevant files and making the change.')),
      () => appendEvent(s, T.tool('edit_file', 'packages/ui/src/inbox/classify.ts', '+61', '…')),
      () => appendEvent(s, T.tool('run', 'pnpm vitest run inbox', '18 passed', '…')),
      () => { enterTerminal(s, 'completed'); s.changes = 'inbox'; appendEvent(s, { t: 'done', summary: 'Done. 4 files changed in the new worktree; tests pass, lint reports 1 issue.', changes: 'inbox' }); const keep = $('#timeline') ? $('#timeline').scrollTop : null; if (state.currentId === s.id) { refresh({ keepScroll: keep }); const tl = $('#timeline'); tl.scrollTop = tl.scrollHeight; } else refresh(); announce('Task finished: changes ready to review'); },
    ];
    steps.forEach((f, i) => setTimeout(f, 900 * (i + 1)));
  }

  function resolveApproval(yes) {
    const s = byId(state.currentId);
    const e = transcriptOf(s).find(x => x.t === 'approval' && !x.result);
    if (!e) return;
    e.result = yes ? 'approved' : 'denied';
    s.state = 'running';
    refresh({ keepScroll: $('#timeline').scrollTop });
    announce(yes ? 'Approved once. The agent continues.' : 'Denied. The command was not run.');
    $('#composer-input').focus();
    setTimeout(() => appendEvent(s, yes ? T.tool('run', e.cmd, 'exit 0', 'Removed worktree ../wt/fix-flake-old') : T.agent('Understood — I will not remove the worktree. I will close the stale handle in the test fixture instead.')), 700);
  }
  function answerQuestion(ans) {
    const s = byId(state.currentId);
    const q = transcriptOf(s).find(x => x.t === 'question' && !x.answered);
    if (!q) return;
    q.answered = ans; s.state = 'running';
    refresh({ keepScroll: $('#timeline').scrollTop });
    $('#composer-input').focus();
    announce('Answer sent. The agent continues.');
    setTimeout(() => appendEvent(s, T.agent(`Thanks — going with “${ans}”.`)), 600);
  }

  // Global shortcuts
  document.addEventListener('keydown', e => {
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    const switcherOpen = !$('#switcher-overlay').hidden, helpOpen = !$('#help-overlay').hidden;
    if (ctrl && !e.shiftKey && (k === 'k' || k === 'K')) { e.preventDefault(); if (switcherOpen) closeSwitcher(true); else if (!helpOpen) openSwitcher(); return; }
    if (switcherOpen) return; // the switcher handles its own keys
    if (k === 'Escape') {
      if (helpOpen) { e.preventDefault(); return closeHelp(); }
      if (closePopovers(true)) { e.preventDefault(); return; }
      if (state.drawer) { e.preventDefault(); return closeDrawer(true); }
      if (state.reviewOpen && ($('#review').contains(document.activeElement) || mqMedium.matches)) { e.preventDefault(); return toggleReview(false); }
      return;
    }
    if (helpOpen) return;
    if (ctrl && (k === '/' || k === '?')) { e.preventDefault(); return openHelp(); }
    // Overlay exclusivity: the handlers below either replace an open popover or
    // modal drawer (openPopover, openDrawer, toggleReview, openSession and
    // openView call dismissOverlays) or stay inside it (F6).
    if (ctrl && e.shiftKey && (k === 'J' || k === 'j')) { e.preventDefault(); return $('#inbox-pop').hidden ? openPopover('inbox-pop', 'btn-inbox') : closePopovers(true); }
    if (ctrl && !e.shiftKey && (k === 'j' || k === 'J')) { e.preventDefault(); const m = inboxModel(); const next = m.reply.find(s => s.id !== state.currentId) || m.review[0]; if (next) openSession(next.id, { focus: 'title' }); else announce('Nothing needs you right now'); return; }
    if (ctrl && e.shiftKey && (k === 'G' || k === 'g')) { e.preventDefault(); return toggleReview(); }
    if (ctrl && !e.shiftKey && (k === 'b' || k === 'B')) { e.preventDefault(); return toggleSidebar(); }
    if (e.altKey && !ctrl && (k === 'n' || k === 'N' || e.code === 'KeyN')) { e.preventDefault(); return openView('home'); }
    if (e.altKey && !ctrl && /^Digit[1-9]$/.test(e.code)) {
      const pinned = sessions.filter(s => s.pinned && !s.parentId && !s.archived);
      const s = pinned[+e.code.slice(5) - 1]; if (s) { e.preventDefault(); openSession(s.id, { focus: 'composer' }); } return;
    }
    if (k === 'F6') { e.preventDefault(); closePopovers(true); return cycleRegion(e.shiftKey); }
  });

  /* ------------------------------------------------------------------ */
  /* Simulated live activity                                             */
  /* ------------------------------------------------------------------ */
  const streamLines = [
    () => T.tool('edit_file', 'packages/ui/src/inbox/InboxButton.tsx', '+84', 'export const InboxButton = memo(function InboxButton(props) { … })'),
    () => T.agent('Badge shows reply + review count. Background work is a separate ring and is not counted, so the number only means “things waiting for you”.'),
    () => T.tool('run', 'pnpm vitest run inbox', '18 passed', ' Tests  18 passed (18)'),
    () => T.agent('Next: focus returns to the bell button when the popover closes with Esc.'),
    () => T.tool('edit_file', 'packages/ui/src/shell/TopBar.tsx', '+12 −3', '…'),
  ];
  let seconds = 0;
  const frozen = params.get('static') === '1'; // freeze simulated activity for screenshots
  setInterval(() => {
    if (document.hidden || frozen) return;
    seconds += 1;
    const s1 = byId('s1');
    if (s1.state === 'running' && seconds % 6 === 0 && state.tick < 40) { appendEvent(s1, streamLines[state.tick % streamLines.length]()); state.tick++; s1.updated = 0; renderTree(); }
    const s1b = byId('s1b');
    if (s1b.state === 'running' && seconds >= (s1b.finishAfter || 25)) {
      enterTerminal(s1b, 'completed'); s1b.unread = s1b.viewed ? 0 : 1;
      if (state.currentId === 's1b' && state.view === 'session') appendEvent(s1b, { t: 'done', summary: '18 tests written; all pass.', changes: null });
      else transcriptOf(s1b).push({ t: 'done', summary: '18 tests written; all pass.', changes: null });
      renderTree(); renderTopbar(); if (!$('#inbox-pop').hidden) renderInbox();
      announce('Background agent finished: Write unit tests for attention rules');
    }
    const s6 = byId('s6');
    if (seconds % 9 === 0) { appendEvent(s6, T.tool('run', 'python run_ablation.py --batch 3', 'epoch ' + (4 + seconds / 9) + '/10', 'loss=' + (0.41 - seconds / 900).toFixed(3))); if (!(state.currentId === 's6' && state.view === 'session')) renderTree(); }
  }, 1000);

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */
  $$('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
  let saved = null;
  try { saved = localStorage.getItem('agentdock-proto-theme'); } catch (_) { saved = null; }
  applyTheme(params.get('theme') || saved || 'system');
  if (params.get('session') && byId(params.get('session'))) state.currentId = params.get('session');
  state.mru = [state.currentId].concat(state.mru.filter(x => x !== state.currentId));
  if (params.get('view') === 'home') state.view = 'home';
  if (params.get('view') === 'settings') state.view = 'settings';
  if (params.get('review') === '1') state.reviewOpen = true;
  if (params.get('expand')) params.get('expand').split(',').forEach(id => state.expanded.add(id));
  if (mqNarrow.matches) $('#btn-sidebar').setAttribute('aria-expanded', 'false');
  if (state.view === 'session') markOpened(byId(state.currentId));
  refresh();
  const open = params.get('open');
  if (open === 'inbox') openPopover('inbox-pop', 'btn-inbox');
  if (open === 'usage') openPopover('usage-pop', 'btn-usage');
  if (open === 'switcher') openSwitcher();
  if (open === 'help') openHelp();
  if (open === 'sidebar' && mqNarrow.matches) openDrawer('sidebar');
  if (params.get('scroll') === 'mid') { const tl = $('#timeline'); if (tl) tl.scrollTop = tl.scrollHeight / 2; }
})();
